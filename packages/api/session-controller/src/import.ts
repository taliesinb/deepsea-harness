/**
 * Store Session logs that came from elsewhere as stored Sessions of this Host
 * under one Workspace. `importSessionArchive` is the receiving half of a
 * cross-host move or copy: the entries of one archive as `session.export`
 * produces it (root log, `subagents/<id>/session[.vN].jsonl` descendants,
 * `media/` and `files/` attachments). `storeSessionLogs` is its storing half
 * for logs that are already parsed, shared with the same-host `session.copy`.
 * The `session-log-export` package exposes both to Fetch routes and to
 * out-of-tree importers.
 *
 * Two modes. `move` (default): the Sessions continue here, so exported ids
 * are kept when free. `copy`: the originals live on, so every log gets a
 * fresh id, a turn in progress at the source is dropped whole or closed as
 * interrupted ({@link shapeCopiedLog}), descendants born in a dropped turn
 * are left out, an optional title is recorded, and the notice says the
 * original continues separately.
 *
 * Attachments are content-addressed (`sha256:` ids), so saving the bytes here
 * reproduces the ids the logs reference. Each log's header gets the
 * destination cwd. An id that already exists here (or every id, with
 * `keepIds: false` or in `copy` mode) is replaced by a fresh one, and the
 * logs are re-identified to match: descendants are re-parented, a parent's
 * `subagent/catalog` facts name the new child ids, and an active
 * `session-log-deepseek/delivery-accepted` watermark naming the old id is
 * replaced, at the same seq, by an ignorable
 * {@link FOREIGN_DELIVERY_EVENT_TYPE} record, because the delivery endpoint
 * accepted that range for the old id only. The root receives one
 * `agent/inbox/spliced` next-step notice naming the origin, so its Agent
 * knows earlier file references may not resolve. Each stored log is first
 * re-validated as the current format reads it back. Every stored log is
 * folded into the projection cache and announced with
 * `session-persistence/stored`, so list owners show it with its title.
 * @module @deepseek-ai/dsh-api-session-controller/import
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import {
  createSessionFormatCatalogWithChildren, historicalSessionFormatCatalog, sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
import { historicalChildCatalogSource } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { shapeCopiedLog, type CopiedLogShape } from './shape.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Next-step notice an imported Session's Agent reads on this Host. */
    'session-import': { readonly kind: 'session-import' } & ContextFormed
    /** Next-step notice a copied Session's Agent reads: the original continues separately. */
    'session-copy': { readonly kind: 'session-copy'; readonly sourceSessionId: string } & ContextFormed
  }
}

/** Message source kind recorded on the import notice. */
export const SESSION_IMPORT_NOTICE_SOURCE = 'session-import'

/** Message source kind recorded on the copy notice. */
export const SESSION_COPY_NOTICE_SOURCE = 'session-copy'

/**
 * Ignorable event type that replaces, at the same seq, a delivery watermark
 * recorded for a Session id that the stored copy no longer carries. Readers
 * that do not know the type skip it; its data is the original watermark.
 */
export const FOREIGN_DELIVERY_EVENT_TYPE = 'session-transfer/foreign-delivery-accepted'

const DELIVERY_EVENT_TYPE = 'session-log-deepseek/delivery-accepted'

/** Where and how logs are stored. */
export interface SessionImportTarget {
  /** Destination Workspace; every stored log gets its path as cwd. */
  readonly workspace: Workspace
  /** Where the logs came from, as the Agent's notice names it (a host, a workspace, a backup file). */
  readonly origin: string
  /**
   * `move` (default): the Sessions continue here; ids are kept when free.
   * `copy`: the originals live on; every id is fresh, a turn in progress is
   * shaped by `truncate`, and `title` may name the copy.
   */
  readonly mode?: 'move' | 'copy'
  /** `move` mode: keep the exported ids when they are free here (default true). */
  readonly keepIds?: boolean
  /** `copy` mode: drop a turn in progress instead of closing it as interrupted (default false). */
  readonly truncate?: boolean
  /** `copy` mode: title recorded on the copied root as a user rename; omitted keeps the source's. */
  readonly title?: string
  /**
   * Whether the logs come from another host (default true): the notice then
   * warns that files referenced earlier lived on the original host.
   */
  readonly crossHost?: boolean
  /** Append the notice to the root (default true). */
  readonly notify?: boolean
  /** Cancellation observed between storage steps. */
  readonly signal?: AbortSignal
}

/** One stored Session. */
export interface ImportedSession {
  /** The id stored here. */
  readonly sessionId: SessionId
  /** The id the log carried. */
  readonly exportedId: SessionId
  /** The stored parent, for a descendant. */
  readonly parentSessionId?: SessionId
}

/** Outcome of one import. */
export interface SessionImportResult {
  /** The stored root Session. */
  readonly sessionId: SessionId
  /** Every stored Session, root first. */
  readonly imported: readonly ImportedSession[]
  /** How many attachment objects were saved. */
  readonly attachments: number
  /** `copy` mode: whether the root's turn in progress was dropped. */
  readonly truncated: boolean
}

/** One Session log ready to be stored: header, events, and the fork-inherited cut. */
export interface ParsedSessionLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: SessionLogOffset
}

/** A root log and its subagent descendants, in any order. */
export interface SessionLogFamily {
  readonly root: ParsedSessionLog
  readonly children: readonly ParsedSessionLog[]
}

/** Root and descendant logs under any generation name (`session.jsonl`, `session.v4.jsonl`). */
const ROOT_LOG = /^session(?:\.v\d+)?\.jsonl$/u
const SUBAGENT_LOG = /^subagents\/[^/]+\/session(?:\.v\d+)?\.jsonl$/u
const MEDIA_ENTRY = /^media\/([^/]+)\.(png|jpg|webp|gif)$/u
const FILE_ENTRY = /^files\/[0-9a-f]{2}\/[0-9a-f]{64}\/([^/]+)$/u
const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}

/** One exported log split into its JSON header record and event rows. */
interface ExportedLog {
  readonly label: string
  readonly header: SessionFormatJsonObject
  readonly rows: readonly unknown[]
}

function parseJsonLine(line: string, label: string, what: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`${label}: ${what} is not JSON`)
  }
}

/** Split one exported JSONL text into its header record and event rows. */
function splitLog(text: string, label: string): ExportedLog {
  const lines = text.split('\n').filter(line => line !== '')
  const first = lines[0]
  if (first === undefined) throw new Error(`${label}: empty log`)
  const header = parseJsonLine(first, label, 'header line')
  if (typeof header !== 'object' || header === null || Array.isArray(header) || (header as { type?: unknown }).type !== 'session') {
    throw new Error(`${label}: first line is not a session header`)
  }
  return {
    label,
    header: header as SessionFormatJsonObject,
    rows: lines.slice(1).map(line => parseJsonLine(line, label, 'event line')),
  }
}

/**
 * Decode one exported log through a catalog's strict restore with installed
 * current validation (event vocabulary, envelopes, messages, surface, cut).
 */
function restoreLog(log: ExportedLog, catalog: SessionFormatCatalog): ParsedSessionLog {
  const restore = catalog.createRestore(log.header, { recovery: 'strict', validation: 'current' })
  for (const row of log.rows) restore.decodeRow(row)
  const artifact = restore.finish()
  const meta = artifact.header
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(meta.id),
    createdAt: meta.createdAt,
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(meta.parentSession === undefined ? {} : { parentSession: SessionId(meta.parentSession) }),
    isSeeded: meta.isSeeded,
    ...(meta.origin === undefined ? {} : { origin: meta.origin }),
    ...(meta.delegationDepth > 0 ? { delegationDepth: meta.delegationDepth } : {}),
    ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
  }
  return { header, events: artifact.events as SessionEvent[], inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount) }
}

function storedVersion(log: ExportedLog): number {
  const version = log.header['version']
  if (typeof version !== 'number') throw new Error(`${log.label}: header carries no format version`)
  return version
}

/**
 * Decode an exported family. A current-generation log is restored directly;
 * a historical one first needs its direct children's catalog evidence, which
 * the archive carries beside it.
 */
function restoreFamily(root: ExportedLog, children: readonly ExportedLog[]): SessionLogFamily {
  const factsFor = (parent: ExportedLog): SessionFormatJsonObject[] => children
    .filter(child => child.header['parentSession'] === parent.header['id'] && child.header['origin'] === 'subagent')
    .map((child) => {
      const catalog = storedVersion(child) < SESSION_FORMAT_VERSION ? historicalSessionFormatCatalog : sessionFormatCatalog
      try {
        const restore = catalog.createRestore(child.header, { recovery: 'strict', validation: 'current' })
        for (const row of child.rows) restore.decodeRow(row)
        return historicalChildCatalogSource(restore.finish())
      } catch {
        // A child whose descriptor cannot be read keeps unknown-mode membership, as JSONL migration does.
        const { id, createdAt } = child.header
        return {
          childId: typeof id === 'string' ? id : '',
          childCreatedAt: typeof createdAt === 'number' ? createdAt : 0,
          descriptorCount: 0,
          descriptor: null,
        }
      }
    })
  const restore = (log: ExportedLog): ParsedSessionLog => restoreLog(
    log,
    storedVersion(log) < SESSION_FORMAT_VERSION ? createSessionFormatCatalogWithChildren(factsFor(log)) : sessionFormatCatalog,
  )
  return { root: restore(root), children: children.map(restore) }
}

function filesClause(target: SessionImportTarget): string {
  return target.crossHost === false
    ? ' Earlier file references may need to be re-read from the new location.'
    : ' Files referenced earlier in the conversation lived on the original host and may not exist here; '
      + 're-read anything you need from the new workspace before relying on it.'
}

function importNoticeText(target: SessionImportTarget, exportedId: SessionId, sessionId: SessionId): string {
  const { workspace } = target
  const renamed = exportedId === sessionId ? '' : ` Its id changed from \`${exportedId}\` to \`${sessionId}\`.`
  const where = target.crossHost === false ? '' : ' on this host'
  return `<system-reminder>NOTE: this session was imported from ${target.origin} into the workspace \`${workspace.title}\` (${workspace.path})`
    + `${where}.${renamed}${filesClause(target)}</system-reminder>`
}

/**
 * The notice text an Agent reads on its next step after a copy.
 * @param target - destination, origin, and host relation of the copy.
 * @param sourceId - the id of the original Session.
 * @param shape - what the copy did to a turn in progress.
 * @returns the complete model-facing text.
 */
export function sessionCopyNoticeText(
  target: Pick<SessionImportTarget, 'workspace' | 'origin' | 'crossHost'>,
  sourceId: SessionId,
  shape: Pick<CopiedLogShape, 'openTurn' | 'truncated'>,
): string {
  const { workspace } = target
  const where = target.crossHost === false ? '' : ' on this host'
  const turn = !shape.openTurn
    ? ''
    : shape.truncated
      ? ' A turn was in progress when the copy was made; that turn, and the prompt that started it, are not part of this copy.'
      : ' A turn was in progress when the copy was made; it is recorded here as interrupted, and the outcome of any tool call it had pending is unknown.'
  return `<system-reminder>NOTE: this session is a copy of session \`${sourceId}\` from ${target.origin}, made on ${new Date().toISOString()} `
    + `into the workspace \`${workspace.title}\` (${workspace.path})${where}. The original continues separately; nothing done here affects it.`
    + `${turn}${filesClause(target)}</system-reminder>`
}

/**
 * Re-validate one log exactly as the current format reads it back: encode
 * the header and every event, then restore them strictly with installed
 * current validation.
 */
function assertStorable(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): void {
  const restore = sessionFormatCatalog.createRestore(
    sessionFormatCatalog.encodeCurrentHeader({ ...header, delegationDepth: header.delegationDepth ?? 0 }, inheritedEventCount),
    { recovery: 'strict', validation: 'current' },
  )
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(formatEvent(event)))
  restore.finish()
}

/** One logical event as the format catalog's JSON vocabulary (events are lossless JSON by contract). */
function formatEvent(event: SessionEvent): SessionFormatEvent {
  const value: unknown = JSON.parse(JSON.stringify(event))
  if (!isSessionFormatJsonObject(value)) throw new Error(`session import: event ${String(event.seq)} is not a JSON object`)
  return value as SessionFormatEvent
}

/** An event read through the fields every event type shares. */
interface WideEvent {
  readonly type: string
  readonly data: unknown
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Re-identify one log's events for its stored id: parent catalog facts name
 * the stored child ids, and an active delivery watermark recorded for the old
 * id becomes an ignorable foreign record at the same seq. Both event types are
 * declared by packages this one does not depend on, so they are read through
 * their shared envelope fields.
 * @param events - the log's events.
 * @param exportedId - the id the log carried.
 * @param ids - exported id to stored id, for every stored log of the family.
 * @returns the events to store.
 */
function reidentify(
  events: readonly SessionEvent[],
  exportedId: SessionId,
  ids: ReadonlyMap<SessionId, SessionId>,
): SessionEvent[] {
  const storedId = ids.get(exportedId) ?? exportedId
  return events.map((event) => {
    const wide: WideEvent = event
    if (wide.type === 'subagent/catalog' && isRecord(wide.data) && typeof wide.data['childId'] === 'string') {
      const childId = ids.get(SessionId(wide.data['childId']))
      if (childId === undefined || childId === wide.data['childId']) return event
      const copy = structuredClone(event)
      Reflect.set(copy.data, 'childId', childId)
      return copy
    }
    if (wide.type === DELIVERY_EVENT_TYPE && storedId !== exportedId && isRecord(wide.data)
      && wide.data['sessionId'] === exportedId && wide.data['sessionFormatVersion'] === SESSION_FORMAT_VERSION) {
      const foreign: Omit<SessionEvent, 'type'> & { readonly type: string } = { ...event, type: FOREIGN_DELIVERY_EVENT_TYPE, ignorable: true }
      return foreign as SessionEvent
    }
    return event
  })
}

/**
 * Store parsed Session logs, one root and its subagent descendants, as
 * Sessions of this Host under a Workspace, then attach the root to it.
 * Attachments must already be stored here.
 * @param ctx - Host context carrying Session persistence.
 * @param logs - the root log and every descendant log, in any order.
 * @param target - destination Workspace, origin label, and id and notice policy.
 * @param attachmentCount - how many attachment objects the caller saved, echoed in the result.
 * @returns the stored root id and every stored Session.
 */
export async function storeSessionLogs(
  ctx: Context,
  logs: SessionLogFamily,
  target: SessionImportTarget,
  attachmentCount = 0,
): Promise<SessionImportResult> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('session import is unavailable: missing session-persistence service')
  const { signal } = target
  const copy = target.mode === 'copy'
  signal?.throwIfAborted()

  // A copy of a source mid-turn drops or closes that turn; descendants born
  // inside a dropped turn are left out.
  const shapeOf = (log: ParsedSessionLog): CopiedLogShape | undefined =>
    copy ? shapeCopiedLog(log.events, { truncate: target.truncate === true }) : undefined
  const rootShape = shapeOf(logs.root)
  const children = logs.children.filter(child => rootShape?.cutTime === undefined || child.header.createdAt < rootShape.cutTime)

  // Ids: a copy always mints; an import keeps them when free here. Children
  // follow their parent's mapping.
  const ids = new Map<SessionId, SessionId>()
  for (const log of [logs.root, ...children]) {
    const exported = log.header.id
    if (ids.has(exported)) throw new Error(`session import: the archive holds two logs for "${exported}"`)
    const taken = copy || target.keepIds === false
      || await persistence.stat(exported, signal === undefined ? {} : { signal }) !== undefined
    ids.set(exported, taken ? SessionId(`session-${randomUUID()}`) : exported)
  }
  const rootId = ids.get(logs.root.header.id) as SessionId

  const store = async (log: ParsedSessionLog, isRoot: boolean): Promise<ImportedSession> => {
    signal?.throwIfAborted()
    const exportedId = log.header.id
    const sessionId = ids.get(exportedId) as SessionId
    const exportedParent = log.header.parentSession
    const parent = exportedParent === undefined ? undefined : ids.get(exportedParent) ?? exportedParent
    const header: SessionHeader = {
      ...log.header,
      id: sessionId,
      cwd: target.workspace.path,
      ...(parent === undefined ? {} : { parentSession: parent }),
    }
    const shape = isRoot ? rootShape : shapeOf(log)
    const events = reidentify(shape?.events ?? log.events, exportedId, ids)
    const nextSeq = (): SessionSeq => SessionSeq((events.at(-1)?.seq ?? -1) + 1)
    const title = target.title?.trim()
    if (isRoot && copy && title !== undefined && title !== '') {
      events.push({
        type: 'session/title', seq: nextSeq(), time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } },
      })
    }
    if (isRoot && target.notify !== false) {
      const inserted = copy
        ? createUserMessage({
          content: [{ type: 'text', text: sessionCopyNoticeText(target, exportedId, shape ?? { openTurn: false, truncated: false }) }],
          source: {
            kind: SESSION_COPY_NOTICE_SOURCE,
            sourceSessionId: exportedId,
            form: 'notice',
            summary: boundContextSummary(`Copied from ${target.origin}`),
          },
        })
        : createUserMessage({
          content: [{ type: 'text', text: importNoticeText(target, exportedId, sessionId) }],
          source: {
            kind: SESSION_IMPORT_NOTICE_SOURCE,
            form: 'notice',
            summary: boundContextSummary(`Imported from ${target.origin}`),
          },
        })
      events.push({
        type: 'agent/inbox/spliced',
        seq: nextSeq(),
        time: Date.now(),
        data: { target: 'next-step', start: 0, inserted: [inserted] },
      })
    }
    assertStorable(header, log.inheritedEventCount, events)
    const handle = await persistence.create(header, {
      ...(signal === undefined ? {} : { signal }),
      ...(header.isSeeded ? { inheritedEventCount: log.inheritedEventCount } : {}),
    })
    try {
      if (events.length > 0) await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    // Fold every projection over the stored log so the row lists with its
    // title and statistics before the Session is first opened here.
    try {
      ctx.get('sessionProjectionCache')?.coldSnapshot(header, log.inheritedEventCount, events)
    } catch (error: unknown) {
      ctx.logger.warn(`session import: projection cache seed for "${sessionId}" failed: ${String(error)}`)
    }
    stored.push(header)
    return { sessionId, exportedId, ...(parent === undefined ? {} : { parentSessionId: parent }) }
  }

  const stored: SessionHeader[] = []
  const imported: ImportedSession[] = [await store(logs.root, true)]
  for (const child of children) imported.push(await store(child, false))
  await target.workspace.attachSession(rootId)
  for (const header of stored) ctx.emit('session-persistence/stored', header)
  return { sessionId: rootId, imported, attachments: attachmentCount, truncated: rootShape?.truncated === true }
}

/**
 * Import the entries of one export archive into a Workspace of this Host:
 * decode every log (historical generations are migrated with the archive's
 * own child evidence), save its attachments, and store the logs through
 * {@link storeSessionLogs}.
 * @param ctx - Host context carrying persistence and attachments.
 * @param entries - archive path to entry bytes.
 * @param target - destination Workspace, origin label, and id and notice policy.
 * @returns the stored root id and every stored Session.
 * @throws when the archive holds no root log or a log fails validation.
 */
export async function importSessionArchive(
  ctx: Context,
  entries: Readonly<Record<string, Uint8Array>>,
  target: SessionImportTarget,
): Promise<SessionImportResult> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('session import is unavailable: missing attachments service')
  const { signal } = target
  signal?.throwIfAborted()
  const decoder = new TextDecoder()
  const rootName = Object.keys(entries).find(path => ROOT_LOG.test(path))
  if (rootName === undefined) throw new Error('session import: archive has no root session log (session.jsonl)')
  const root = splitLog(decoder.decode(entries[rootName]), rootName)
  const children = Object.entries(entries)
    .filter(([path]) => SUBAGENT_LOG.test(path))
    .map(([path, data]) => splitLog(decoder.decode(data), path))
  const family = restoreFamily(root, children)
  signal?.throwIfAborted()

  let saved = 0
  for (const [path, data] of Object.entries(entries)) {
    signal?.throwIfAborted()
    const media = MEDIA_ENTRY.exec(path)
    const mediaType = media === null ? undefined : MEDIA_TYPES[media[2] as string]
    if (media !== null && mediaType !== undefined) {
      const ref = await attachments.saveImage({ data, mediaType })
      if (String(ref.attachmentId) !== media[1]) {
        ctx.logger.warn(`session import: image ${path} was stored as ${String(ref.attachmentId)}; references to it will not resolve`)
      }
      saved += 1
      continue
    }
    const file = FILE_ENTRY.exec(path)
    if (file !== null) {
      await attachments.saveFile({ data, name: file[1] as string })
      saved += 1
    }
  }
  return storeSessionLogs(ctx, family, target, saved)
}
