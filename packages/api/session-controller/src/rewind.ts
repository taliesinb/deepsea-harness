/**
 * Destructive same-identity rewind of a Session to just before one
 * human-authored prompt. The stored log keeps its prefix, loses the prompt
 * and everything after it, and stays a self-consistent log an Agent can
 * resume:
 *
 * - A prompt that opened its turn (no assistant output or tool result
 *   precedes it in that turn) removes the whole turn from its `turn/start`.
 * - A prompt admitted mid-turn as steering keeps the earlier part of the turn
 *   and closes it with the crash-repair closers.
 * - Input still pending in either inbox list at the cut is cancelled, so the
 *   removed prompt is not claimed again on resume.
 *
 * Only a suffix is cut and only events are appended, so seqs stay contiguous.
 * The operation refuses a Session with a turn, queued input, background job,
 * or running subagent, retires its idle Agent, and replaces the stored log
 * through the persistence backend's explicit destructive `replace`. Files
 * written and other external effects of the removed turns are not undone.
 * @module @deepseek-ai/dsh-api-session-controller/rewind
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type { FileUploadReceiptId, StagedAttachment } from '@deepseek-ai/dsh-client-file-upload/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'
import { describeBlockers, sessionMoveBlockers } from './move.ts'
import type { SessionRewindAttachment, SessionRewindRequest, SessionRewindValue } from './types.ts'

/** A rewound log and the prompt it removed. */
export interface RewoundLog {
  /** Kept prefix followed by synthetic closers and inbox cancellations. */
  readonly events: SessionEvent[]
  /** The removed human prompt, exactly as stored. */
  readonly message: UserMessage
}

/** Pending count of one inbox list after folding every splice in `events`. */
function pendingCount(events: readonly SessionEvent[], target: 'next-turn' | 'next-step'): number {
  let pending = 0
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== target) continue
    const start = Math.min(Math.max(0, event.data.start), pending)
    const removed = Math.min(event.data.removedCount ?? 0, pending - start)
    pending = pending - removed + event.data.inserted.length
  }
  return pending
}

/**
 * Cut one stored log just before a human prompt.
 * @param events - the stored log, contiguous from seq 0.
 * @param seq - seq of the `user/message` event to remove with everything after it.
 * @param inheritedEventCount - fork-inherited prefix length, which a cut may not enter.
 * @returns the replacement log and the removed prompt, or undefined when `seq` names no removable human prompt.
 */
export function shapeRewoundLog(
  events: readonly SessionEvent[],
  seq: number,
  inheritedEventCount: number,
): RewoundLog | undefined {
  const target = events[seq]
  if (target?.seq !== seq || target.type !== 'user/message' || target.data.source.kind !== 'user') return undefined
  let turnStart = -1
  for (let index = seq - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') break
    if (event.type === 'turn/start') {
      turnStart = index
      break
    }
  }
  const answered = turnStart !== -1 && events.slice(turnStart + 1, seq)
    .some(event => event.type === 'assistant/message' || event.type === 'tool/result')
  const cut = turnStart !== -1 && !answered ? turnStart : seq
  if (cut < inheritedEventCount) return undefined
  const kept = events.slice(0, cut)
  if (cut === seq) kept.push(...interruptedTurnClosers(kept))
  for (const list of ['next-step', 'next-turn'] as const) {
    const pending = pendingCount(kept, list)
    if (pending === 0) continue
    // The kept prefix is contiguous from seq 0; the removed prompt's time is no earlier than any kept event.
    kept.push({
      type: 'agent/inbox/spliced',
      seq: SessionSeq(kept.length),
      time: target.time,
      data: { target: list, start: 0, removedCount: pending, inserted: [], outcome: 'canceled' },
    })
  }
  return { events: kept, message: target.data }
}

type ReplacingPersistence = SessionPersistence & Required<Pick<SessionPersistence, 'replace'>>

function replacingPersistence(ctx: Context): ReplacingPersistence {
  const persistence = ctx.get('sessionPersistence')
  if (persistence?.replace === undefined) {
    throw new RemoteError('session/rewind-unsupported', 'This deployment\'s session storage cannot rewind sessions.', {})
  }
  return persistence as ReplacingPersistence
}

function busy(reason: string): RemoteError {
  return new RemoteError('session/agent-busy', `Session is busy: ${reason}`, { reason })
}

/** Stored attachments of a prompt, in content order. */
function storedAttachments(content: readonly ContentBlock[]): StagedAttachment[] {
  return content.flatMap((block): StagedAttachment[] => {
    if (block.type === 'image') return [{ type: 'image', attachment: block.attachment, encodedBytes: block.attachment.bytes }]
    if (block.type === 'file') return [{ type: 'file', attachment: block.attachment }]
    return []
  })
}

/** Hooks the Session Controller supplies to a rewind. */
export interface RewindHooks {
  /**
   * Announce the replaced history while the reservation still excludes new events. A failure is
   * reported and leaves clients to reload; the rewind stays committed.
   * @param cursor - last seq kept from the previous history; -1 when none was kept.
   * @param tail - events of the replaced log after `cursor`.
   */
  readonly trimmed: (cursor: number, tail: readonly SessionEvent[]) => Promise<void>
}

/**
 * Rewind one idle Session to just before a human prompt.
 * Refusals happen before any mutation. A resolved `edit` returns the prompt
 * and its attachments staged again on the resumed Session; a resolved
 * `replay` reports whether the prompt was queued again, since history is
 * already rewound when resending fails.
 * @param ctx - Host context carrying Agents, Sessions, uploads, and persistence.
 * @param agents - Agent controller that retires and resumes ordinary Sessions.
 * @param request - Session, exact prompt seq, and action.
 * @param source - source recorded on a replayed prompt, built from the current invocation.
 * @param hooks - announcement of the committed replacement.
 * @returns the removed prompt content, edit attachments, and replay outcome.
 */
export async function rewindSession(
  ctx: Context,
  agents: ApiSessionAgentController,
  request: SessionRewindRequest,
  source: MessageSource,
  hooks: RewindHooks,
): Promise<SessionRewindValue> {
  const { sessionId, userEventSeq } = request
  const persistence = replacingPersistence(ctx)
  const blockers = await sessionMoveBlockers(ctx, sessionId)
  if (blockers.length > 0) throw busy(describeBlockers(blockers))
  let release: () => void
  try {
    release = ctx.agents.reserveHistory(sessionId)
  } catch (error: unknown) {
    /* v8 ignore next -- reserveHistory throws only Error; String keeps any other value reportable. */
    throw busy(error instanceof Error ? error.message : String(error))
  }
  let shaped: RewoundLog
  let cursor: number
  try {
    if (!await agents.retire(sessionId)) throw busy('the session is owned by another component')
    const snapshot = await persistence.stat(sessionId)
    if (snapshot === undefined) throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
    const handle = await persistence.open(sessionId, 'read')
    let events: readonly SessionEvent[]
    let inherited: number
    try {
      events = (await handle.read()).events
      inherited = handle.inheritedEventCount
    } finally {
      await handle.close()
    }
    const result = shapeRewoundLog(events, userEventSeq, inherited)
    if (result === undefined) {
      throw new RemoteError(
        'session/rewind-invalid-target',
        'That message cannot be rewound.',
        { sessionId, userEventSeq: SessionSeq(userEventSeq) },
      )
    }
    shaped = result
    cursor = sharedPrefix(events, shaped.events) - 1
    await persistence.replace({ id: sessionId, expectedRevision: snapshot.revision, events: shaped.events })
  } catch (error: unknown) {
    release()
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof Error && error.name === 'SessionRevisionConflictError') {
      throw new RemoteError('session/rewind-conflict', 'The session changed during the rewind; nothing was removed.', { sessionId })
    }
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new RemoteError('session/writer-held', error.message, { sessionId })
    }
    throw new RemoteError('session/rewind-error', `Rewind failed: ${String(error)}`, { sessionId }, { cause: error })
  }
  try {
    await hooks.trimmed(cursor, shaped.events.slice(cursor + 1))
  } catch (error: unknown) {
    ctx.logger.warn(`session rewind: announcing the replaced history of "${sessionId}" failed: ${String(error)}`)
  } finally {
    release()
  }
  const content = shaped.message.content
  switch (request.action) {
    case 'delete':
      return { sessionId, action: 'delete', content, attachments: [] }
    case 'edit':
      return { sessionId, action: 'edit', content, attachments: await restage(ctx, agents, sessionId, content) }
    case 'replay':
      return { sessionId, action: 'replay', content, attachments: [], replayed: await replay(ctx, agents, sessionId, content, source) }
  }
}

/** Number of leading events two logs share by seq and type; the rest of `before` was removed. */
function sharedPrefix(before: readonly SessionEvent[], after: readonly SessionEvent[]): number {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index++
  return index
}

/**
 * Stage the edited prompt's stored attachments again on the resumed Session; an attachment that cannot be
 * staged is left out and reported, and the composer gets the rest.
 */
async function restage(
  ctx: Context,
  agents: ApiSessionAgentController,
  sessionId: SessionId,
  content: readonly ContentBlock[],
): Promise<SessionRewindAttachment[]> {
  const stored = storedAttachments(content)
  if (stored.length === 0) return []
  const found = await agents.resolveAgent(sessionId)
  if ('error' in found) {
    ctx.logger.warn(`session rewind: attachments of "${sessionId}" could not be staged again: ${found.error.message}`)
    return []
  }
  let receipts: FileUploadReceiptId[]
  try {
    receipts = ctx.fileUploads.restage(found.agent, stored)
  } catch (error: unknown) {
    ctx.logger.warn(`session rewind: attachments of "${sessionId}" could not be staged again: ${String(error)}`)
    return []
  }
  return stored.map((attachment, index): SessionRewindAttachment => {
    const receiptId = receipts[index] as FileUploadReceiptId
    return attachment.type === 'image'
      ? { type: 'image', receiptId, image: attachment.attachment }
      : { type: 'file', receiptId, file: attachment.attachment }
  })
}

/** Queue the removed prompt again on a freshly resumed Agent; false when the Session refuses it. */
async function replay(
  ctx: Context,
  agents: ApiSessionAgentController,
  sessionId: SessionId,
  content: readonly ContentBlock[],
  source: MessageSource,
): Promise<boolean> {
  const found = await agents.resolveAgent(sessionId)
  if ('error' in found) {
    ctx.logger.warn(`session rewind: replay of "${sessionId}" could not resume: ${found.error.message}`)
    return false
  }
  try {
    found.agent.followup(createUserMessage({ content, source }))
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`session rewind: replay of "${sessionId}" was refused: ${String(error)}`)
    return false
  }
}
