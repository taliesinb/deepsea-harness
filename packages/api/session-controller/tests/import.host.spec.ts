/**
 * `importSessionArchive` / `storeSessionLogs`: the storing half of a
 * cross-host move. Archive entries shaped like `session.export`'s (root log,
 * `subagents/<id>/session[.vN].jsonl`, `media/`, `files/`) become stored
 * Sessions of the destination Workspace through a real JSONL backend.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import {
  FOREIGN_DELIVERY_EVENT_TYPE, importSessionArchive, SESSION_IMPORT_NOTICE_SOURCE, storeSessionLogs,
} from '../src/import.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false, cwd: '/remote/proj', ...extra }
}

/** One exported log as `session.export` writes it: the physical header line, then one line per event. */
function serializeSessionLog(meta: SessionHeader, events: readonly SessionEvent[]): string {
  const line = { type: 'session', ...meta, delegationDepth: meta.delegationDepth ?? 0 }
  return `${[JSON.stringify(line), ...events.map(event => JSON.stringify(event))].join('\n')}\n`
}

function oneTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2000, data: createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'turn/end', seq: SessionSeq(2), time: 2001, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** An event declared by a package this one does not depend on, built through its envelope fields. */
function foreignTypedEvent(type: string, seq: number, data: Record<string, unknown>): SessionEvent {
  const event: Omit<SessionEvent, 'type' | 'data'> & { readonly type: string; readonly data: unknown } = {
    type, seq: SessionSeq(seq), time: 2002, data,
  }
  return event as SessionEvent
}

interface Harness {
  ctx: Context
  root: string
  saved: { images: number; files: string[] }
  workspace: Workspace
  attached: SessionId[]
  stored: SessionHeader[]
}

async function mount(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  dirs.push(home)
  const root = join(home, 'sessions')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const saved = { images: 0, files: [] as string[] }
  ctx.provide('attachments', {
    saveImage: vi.fn(async () => {
      saved.images += 1
      return { attachmentId: 'sha256-abc' }
    }),
    saveFile: vi.fn(async (input: { name?: string }) => {
      saved.files.push(input.name ?? '?')
      return {}
    }),
  } as never)
  const attached: SessionId[] = []
  const stored: SessionHeader[] = []
  ctx.on('session-persistence/stored', (meta) => { stored.push(meta) })
  const partial: Partial<Workspace> = {
    id: WorkspaceId('ws-1'), path: '/local/dest', title: 'dest',
    attachSession: vi.fn(async (id: SessionId) => { attached.push(id) }),
  }
  const workspace = partial as Workspace
  return { ctx, root, saved, workspace, attached, stored }
}

function bundle(entries: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(entries)) files[path] = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return files
}

async function read(root: string, id: SessionId): Promise<{ header: SessionHeader; events: readonly SessionEvent[] }> {
  const fresh = new Context()
  contexts.push(fresh)
  await fresh.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const handle = await fresh.sessionPersistence.open(id, 'read')
  try {
    return { header: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

describe('importSessionArchive', () => {
  it('stores root and subagent logs under the destination cwd, saves attachments, notifies, attaches the root', async () => {
    const { ctx, root, saved, workspace, attached, stored: announced } = await mount()
    const rootId = SessionId('session-root')
    const childId = SessionId('session-child')
    const zip = bundle({
      'session.v4.jsonl': serializeSessionLog(header('session-root'), oneTurn()),
      'subagents/session-child/session.v4.jsonl': serializeSessionLog(
        header('session-child', { parentSession: rootId, origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
      'media/sha256-abc.png': new Uint8Array([1, 2, 3, 4]),
      'files/ab/abababababababababababababababababababababababababababababababab/notes.txt': new TextEncoder().encode('hello'),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'alpha/dsh' })
    expect(result).toEqual({
      sessionId: rootId,
      attachments: 2,
      truncated: false,
      imported: [
        { sessionId: rootId, exportedId: rootId },
        { sessionId: childId, exportedId: childId, parentSessionId: rootId },
      ],
    })
    expect(saved).toEqual({ images: 1, files: ['notes.txt'] })
    expect(attached).toEqual([rootId])
    expect(announced.map(meta => [meta.id, meta.cwd])).toEqual([[rootId, '/local/dest'], [childId, '/local/dest']])

    const stored = await read(root, rootId)
    expect(stored.header.cwd).toBe('/local/dest')
    expect(stored.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end', 'agent/inbox/spliced'])
    const notice = stored.events[3]
    if (notice?.type !== 'agent/inbox/spliced') throw new Error('missing notice')
    expect(notice.data.target).toBe('next-step')
    expect(notice.data.inserted[0]?.source).toMatchObject({ kind: SESSION_IMPORT_NOTICE_SOURCE, form: 'notice' })
    const text = notice.data.inserted[0]?.content[0]
    expect(text?.type === 'text' ? text.text : '').toContain('imported from alpha/dsh into the workspace `dest` (/local/dest)')
    expect((await read(root, childId)).header).toMatchObject({ cwd: '/local/dest', parentSession: rootId })
  })

  it('mints new ids on collision, re-identifies the family, and appends nothing with notify=false', async () => {
    const { ctx, root, workspace } = await mount()
    const existing = await ctx.sessionPersistence.create(header('session-root', { cwd: '/elsewhere' }))
    await existing.append(oneTurn())
    await existing.close()
    const exportedRoot = SessionId('session-root')
    const exportedChild = SessionId('session-child')
    const zip = bundle({
      'session.jsonl': serializeSessionLog(header('session-root'), [
        ...oneTurn(),
        foreignTypedEvent('subagent/catalog', 3, { version: 0, childId: exportedChild, childCreatedAt: 1000, mode: 'one-shot' }),
        foreignTypedEvent('session-log-deepseek/delivery-accepted', 4, {
          sessionId: exportedRoot, sessionFormatVersion: SESSION_FORMAT_VERSION, throughSeq: 2,
        }),
      ]),
      'subagents/session-child/session.jsonl': serializeSessionLog(
        header('session-child', { parentSession: exportedRoot, origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'beta', notify: false })
    expect(result.sessionId).not.toBe(exportedRoot)
    const child = result.imported[1]
    expect(child).toMatchObject({ exportedId: exportedChild, parentSessionId: result.sessionId })
    // The child id was free here, so it is kept.
    expect(child?.sessionId).toBe(exportedChild)

    const stored = await read(root, result.sessionId)
    expect(stored.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'subagent/catalog', FOREIGN_DELIVERY_EVENT_TYPE,
    ])
    expect(stored.events[4]).toMatchObject({ ignorable: true, data: { sessionId: exportedRoot, throughSeq: 2 } })
  })

  it('remaps a parent catalog to its re-identified children with keepIds=false', async () => {
    const { ctx, root, workspace } = await mount()
    const exportedChild = SessionId('session-child')
    const zip = bundle({
      'session.jsonl': serializeSessionLog(header('session-root'), [
        ...oneTurn(),
        foreignTypedEvent('subagent/catalog', 3, { version: 0, childId: exportedChild, childCreatedAt: 1000, mode: 'one-shot' }),
      ]),
      'subagents/session-child/session.jsonl': serializeSessionLog(
        header('session-child', { parentSession: SessionId('session-root'), origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'beta', keepIds: false, notify: false })
    const newChild = result.imported[1]?.sessionId
    expect(newChild).not.toBe(exportedChild)
    const stored = await read(root, result.sessionId)
    expect(stored.events[3]).toMatchObject({ type: 'subagent/catalog', data: { childId: newChild } })
  })

  it('migrates a historical generation with the archive\'s own child evidence', async () => {
    const { ctx, root, workspace } = await mount()
    const v3 = (id: string, extra: Record<string, unknown> = {}): string => [
      JSON.stringify({ type: 'session', version: 3, id, createdAt: 1000, cwd: '/remote/proj', isSeeded: false, delegationDepth: 0, ...extra }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2001, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n')
    const zip = bundle({
      'session.v3.jsonl': v3('legacy-root'),
      'subagents/legacy-child/session.v3.jsonl': v3('legacy-child', { parentSession: 'legacy-root', origin: 'subagent', delegationDepth: 1 }),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'old host', notify: false })
    const stored = await read(root, result.sessionId)
    expect(stored.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(stored.events.map(event => event.type)).toEqual(['turn/start', 'turn/end', 'subagent/catalog'])
    expect(stored.events[2]?.data).toMatchObject({ childId: 'legacy-child' })
  })

  it('refuses archives without a root log and logs that are not JSONL sessions', async () => {
    const { ctx, workspace } = await mount()
    await expect(importSessionArchive(ctx, bundle({ 'media/x.png': new Uint8Array([1]) }), { workspace, origin: 'x' }))
      .rejects.toThrow('no root session log')
    await expect(importSessionArchive(ctx, bundle({ 'session.jsonl': 'not json\n' }), { workspace, origin: 'x' }))
      .rejects.toThrow('header line is not JSON')
  })
})

describe('storeSessionLogs', () => {
  it('stores already parsed logs with the caller\'s options', async () => {
    const { ctx, root, workspace, attached } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('parsed'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) },
      children: [],
    }, { workspace, origin: '/backups/home', keepIds: true, notify: false })
    expect(result).toEqual({
      sessionId: 'parsed', imported: [{ sessionId: 'parsed', exportedId: 'parsed' }], attachments: 0, truncated: false,
    })
    expect(attached).toEqual(['parsed'])
    expect((await read(root, SessionId('parsed'))).events).toHaveLength(3)
  })

  it('copies with fresh ids, a title, and the copy notice in copy mode, and words a same-host notice', async () => {
    const { ctx, root, workspace } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('original'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) },
      children: [],
    }, { workspace, origin: 'the workspace `src`', mode: 'copy', title: '  Original (copy) ', crossHost: false })
    expect(result.sessionId).not.toBe('original')
    const stored = await read(root, result.sessionId)
    expect(stored.events.slice(3).map(event => event.type)).toEqual(['session/title', 'agent/inbox/spliced'])
    expect(stored.events[3]).toMatchObject({ data: { title: 'Original (copy)' } })
    const notice = stored.events[4]
    if (notice?.type !== 'agent/inbox/spliced') throw new Error('missing notice')
    const text = notice.data.inserted[0]?.content[0]
    expect(text?.type === 'text' ? text.text : '').toContain('Earlier file references may need to be re-read from the new location.')
  })

  it('refuses a log the current format would not read back', async () => {
    const { ctx, workspace } = await mount()
    const broken: SessionEvent = { type: 'turn/end', seq: SessionSeq(0), time: 1, data: { turn: 9, reason: { kind: 'completed' } } }
    await expect(storeSessionLogs(ctx, {
      root: { header: header('broken'), events: [broken], inheritedEventCount: SessionLogOffset(0) },
      children: [],
    }, { workspace, origin: 'x', notify: false })).rejects.toThrow()
    expect(await ctx.sessionPersistence.stat(SessionId('broken'))).toBeUndefined()
  })
})
