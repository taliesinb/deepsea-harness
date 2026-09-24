/** Session-log download command, Host-owned streaming export route, and the archive import route. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { importSessionZip } from './import.ts'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'
import { SESSION_LOG_EXPORT_PATH, SESSION_LOG_IMPORT_PATH } from './routes.ts'

export { importSessionZip, storeSessionLogs } from './import.ts'
export type {
  ImportedSession, ParsedSessionLog, SessionImportResult, SessionImportTarget, SessionLogFamily,
} from '@deepseek-ai/dsh-api-session-controller'
export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

export { SESSION_LOG_EXPORT_PATH, SESSION_LOG_IMPORT_PATH } from './routes.ts'

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** Largest import archive accepted (logs plus attachments), in bytes. */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the Web-only `/export` command, the authenticated ZIP download
 * route, and the authenticated import route receiving such an archive.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-session-log-export'),
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  ctx.effect(() => connectionOf(ctx).fetch.register({
    path: SESSION_LOG_IMPORT_PATH,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: request => sessionLogImportResponse(ctx, request),
  }), 'session-log-download: import route')
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection')
}

/** Read a streamed request body, refusing it once it exceeds `limit` bytes. */
async function readBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | undefined> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * `POST /api/session.import?workspaceId=<id>|cwd=<dir>[&origin=][&keepIds=false][&notify=false]`
 * `[&mode=copy[&truncate=true][&title=]]` with an export ZIP as the body:
 * store its Sessions under the Workspace and answer
 * `{ sessionId, imported, attachments, truncated }`.
 */
async function sessionLogImportResponse(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const workspaceIdValue = url.searchParams.get('workspaceId')
  const cwdValue = url.searchParams.get('cwd')
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return new Response('session import is unavailable: missing workspace registry', { status: 500 })
  if ((workspaceIdValue === null) === (cwdValue === null)) {
    return new Response('exactly one of workspaceId or cwd is required', { status: 400 })
  }
  let workspace: Workspace | undefined
  try {
    workspace = cwdValue === null
      ? registry.get(brandString<WorkspaceId>(workspaceIdValue ?? ''))
      : await registry.create(cwdValue)
  } catch (error: unknown) {
    return new Response(`destination is not usable as a workspace: ${error instanceof Error ? error.message : String(error)}`, { status: 400 })
  }
  if (workspace === undefined) return new Response('workspace not found', { status: 404 })
  if (request.body === null) return new Response('missing archive body', { status: 400 })
  const zip = await readBody(request.body, MAX_IMPORT_BYTES)
  if (zip === undefined) return new Response('archive too large', { status: 413 })
  try {
    const title = url.searchParams.get('title')
    const result = await importSessionZip(ctx, zip, {
      workspace,
      origin: url.searchParams.get('origin') ?? 'another DSH host',
      mode: url.searchParams.get('mode') === 'copy' ? 'copy' : 'move',
      keepIds: url.searchParams.get('keepIds') !== 'false',
      truncate: url.searchParams.get('truncate') === 'true',
      ...(title === null ? {} : { title }),
      notify: url.searchParams.get('notify') !== 'false',
      signal: request.signal,
    })
    return Response.json(result)
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response(`session import failed: ${error instanceof Error ? error.message : String(error)}`, { status: 422 })
  }
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      request.signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}
