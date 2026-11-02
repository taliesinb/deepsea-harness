/**
 * Moving Sessions between Workspaces. A Session's Workspace membership is its
 * stored header `cwd`: the on-disk project directory, the sandbox root, the
 * shell cwd, the prompt's working-directory line, and registry attach
 * validation all read it. A move is therefore a storage relocation
 * (`sessionPersistence.relocate`) followed by registry detach/attach, a
 * projection-cache re-bind, and a list refresh. A resident Agent owns the
 * storage write handle, so it is retired first; it resumes cold in the new
 * Workspace on the next open. Retiring an Agent with nothing in flight
 * interrupts nothing; a running turn, running background jobs, or running
 * subagents make the caller decide (`stopLive`), and the refusal names them.
 *
 * Every moved Session receives one `agent/inbox/spliced` next-step notice so
 * its Agent learns where it now lives and what its permissions cover.
 * Subagent descendants stored in the same cwd move with their root.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type { SessionPersistence, SessionRelocateAppend } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionActivity, Workspace } from '@deepseek-ai/dsh-workspace'
import { basename } from 'node:path'
import type { ApiSessionAgentController } from './agent.ts'
import type {
  SessionMoveDestination, SessionMoveManyRequest, SessionMoveManyValue, SessionMoveRequest, SessionMoveSkip,
  SessionMoveValue,
} from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Next-step notice a Session move leaves for the moved Session's Agent;
     * `from` names the Workspace the Agent last ran in.
     */
    'session-move': { readonly kind: 'session-move'; readonly from: SessionMoveLabel } & ContextFormed
  }
}

/** Message source kind recorded on the relocation notice. */
export const SESSION_MOVE_NOTICE_SOURCE = 'session-move'

/** One Workspace as the notice names it. */
export interface SessionMoveLabel {
  readonly title: string
  readonly path: string
}

/** The source kind a V3 log's plugin-attributed move notice carries after migration. */
const MIGRATED_MOVE_NOTICE_SOURCE = `plugin:${SESSION_MOVE_NOTICE_SOURCE}`

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'workspace-write': 'Workspace Write',
  'read-only': 'Read Only',
}

/**
 * The notice text an Agent reads on its next step after a move.
 * @param from - previous Workspace.
 * @param to - new Workspace.
 * @param sandboxMode - the Session's last recorded `sandbox/mode`, when the log has one.
 * @returns the complete model-facing text.
 */
export function sessionMoveNoticeText(from: SessionMoveLabel, to: SessionMoveLabel, sandboxMode: string | undefined): string {
  const permission = sandboxMode === undefined ? undefined : PERMISSION_LABELS[sandboxMode]
  const clause = permission === undefined
    ? ''
    : ` Your current permissions of \`${permission}\` now grant access to this new directory instead of the old one.`
  return `<system-reminder>NOTE: this session's workspace was changed from \`${from.title}\` (${from.path}) to `
    + `\`${to.title}\` (${to.path}).${clause} Earlier file references may need to be re-read from the new location.</system-reminder>`
}

/**
 * Activity families a move interrupts by retiring the Session's Agent. A
 * schedule is not among them: its reminders address the Session id, which a
 * move keeps, and wake the Session in its new Workspace.
 */
const INTERRUPTED_BY_RETIRE: ReadonlySet<string> = new Set(['turn', 'job', 'subagent'])

/**
 * What retiring a Session's resident Agent would interrupt: the composed
 * providers' answer to `workspace/session-activity` (the same question an
 * archive asks), without the families a move leaves running.
 * @param ctx - Host context whose providers answer the activity waterfall.
 * @param sessionId - the Session about to move.
 * @returns the interrupted work; empty when the Agent can be retired unnoticed.
 */
export async function sessionMoveBlockers(ctx: Context, sessionId: SessionId): Promise<SessionActivity[]> {
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  return activity.filter(entry => INTERRUPTED_BY_RETIRE.has(entry.kind))
}

/**
 * One line naming what a move would interrupt, for messages and logs.
 * @param blockers - activity families from {@link sessionMoveBlockers}.
 * @returns the description.
 */
export function describeBlockers(blockers: readonly SessionActivity[]): string {
  return blockers.map((blocker) => {
    const kind: string = blocker.kind
    const items = blocker.items ?? []
    const labels = items.map(item => item.label ?? item.id)
    const named = labels.length === 0 ? '' : ` (${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ', …' : ''})`
    switch (kind) {
      case 'turn': return 'a turn is running'
      case 'job': return `${String(items.length)} background job${items.length === 1 ? '' : 's'} running${named}`
      case 'subagent': return `${String(items.length)} subagent${items.length === 1 ? '' : 's'} running${named}`
      default: return `${kind} activity${named}`
    }
  }).join('; ')
}

/**
 * Resolve a move or copy destination: an existing Workspace by id, or a
 * directory registered as one on the way.
 * @param ctx - Host context carrying the Workspace registry.
 * @param destination - the requested destination.
 * @returns the Workspace.
 * @throws RemoteError `workspace/not-found` or `workspace/create-failed`.
 */
export async function resolveMoveDestination(ctx: Context, destination: SessionMoveDestination): Promise<Workspace> {
  if ('workspaceId' in destination) {
    const workspace = ctx.workspaceRegistry.get(destination.workspaceId)
    if (workspace === undefined) {
      throw new RemoteError('workspace/not-found', `workspace "${destination.workspaceId}" not found`, {
        workspaceId: destination.workspaceId,
      })
    }
    return workspace
  }
  try {
    return await ctx.workspaceRegistry.create(destination.path, destination.title)
  } catch (error: unknown) {
    throw new RemoteError('workspace/create-failed', `cannot use "${destination.path}" as a workspace: ${String(error)}`, {
      path: destination.path,
    })
  }
}

/** Live-Session and notice policy shared by `move` and `moveMany`. */
interface MovePolicy {
  readonly stopLive?: boolean
  readonly notify?: boolean
}

/** Host-side move orchestration behind `session.move` / `session.moveMany`. */
export class SessionMoveController {
  /**
   * @param ctx - Host context carrying persistence, the Workspace registry, Agents, and Sessions.
   * @param agents - Agent controller that retires a resident Agent before a move.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
  ) {}

  /**
   * Move one Session and its same-cwd subagent descendants to a Workspace.
   * @param request - Session, destination, and live-Session policy.
   * @returns the moved ids and the destination Workspace.
   * @throws RemoteError `session/move-*` when the Session does not move.
   */
  async move(request: SessionMoveRequest): Promise<SessionMoveValue> {
    const destination = await resolveMoveDestination(this.ctx, request.destination)
    const outcome = await this.moveOne(request.sessionId, destination, request)
    const skipped = outcome.skipped
    if (skipped?.reason === 'live') {
      throw new RemoteError('session/move-live', skipped.message, { sessionId: request.sessionId, blockers: skipped.blockers ?? [] })
    }
    if (skipped !== undefined) {
      throw new RemoteError(`session/move-${skipped.reason}`, skipped.message, { sessionId: request.sessionId })
    }
    return { sessionId: request.sessionId, workspaceId: destination.id, moved: outcome.moved }
  }

  /**
   * Move several Sessions to one Workspace, reporting per-Session skips
   * instead of failing the batch.
   * @param request - Sessions, destination, and live-Session policy.
   * @returns moved ids and skipped Sessions with reasons.
   */
  async moveMany(request: SessionMoveManyRequest): Promise<SessionMoveManyValue> {
    const destination = await resolveMoveDestination(this.ctx, request.destination)
    const moved: SessionId[] = []
    const skipped: SessionMoveSkip[] = []
    const done = new Set<SessionId>()
    for (const sessionId of request.sessionIds) {
      if (done.has(sessionId)) continue
      const outcome = await this.moveOne(sessionId, destination, request)
      for (const id of outcome.moved) done.add(id)
      moved.push(...outcome.moved)
      if (outcome.skipped !== undefined) skipped.push(outcome.skipped)
    }
    return { workspaceId: destination.id, moved, skipped }
  }

  private persistence(): SessionPersistence & Required<Pick<SessionPersistence, 'relocate'>> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence?.relocate === undefined) {
      throw new RemoteError('session/move-unsupported', 'this deployment\'s session storage cannot relocate sessions', {})
    }
    return persistence as SessionPersistence & Required<Pick<SessionPersistence, 'relocate'>>
  }

  private async moveOne(
    sessionId: SessionId,
    destination: Workspace,
    policy: MovePolicy,
  ): Promise<{ moved: SessionId[]; skipped?: SessionMoveSkip }> {
    const persistence = this.persistence()
    const header = (await persistence.stat(sessionId))?.header ?? this.ctx.sessions.get(sessionId)?.header
    if (header === undefined) {
      return { moved: [], skipped: { sessionId, reason: 'missing', message: `session "${sessionId}" not found` } }
    }
    const from = this.accountOf(sessionId)
    const sameWorkspace: SessionMoveSkip = {
      sessionId, reason: 'same-workspace', message: `session "${sessionId}" is already in that workspace`,
    }
    if (from?.id === destination.id) return { moved: [], skipped: sameWorkspace }
    if (from === undefined && (await this.ownerOfPath(header.cwd))?.id === destination.id) {
      if (header.origin === 'subagent') return { moved: [], skipped: sameWorkspace }
      // Stored under the destination's directory without an account (a
      // session created outside the registry, or an interrupted earlier move).
      await destination.attachSession(sessionId)
      return { moved: [sessionId] }
    }
    const resident = await this.retireResident(sessionId, policy)
    if (resident !== undefined) return { moved: [], skipped: resident }
    const fromLabel: SessionMoveLabel = {
      title: from?.title ?? (header.cwd === undefined ? '(no workspace)' : basename(header.cwd)),
      path: header.cwd ?? '(none)',
    }
    const toLabel: SessionMoveLabel = { title: destination.title, path: destination.path }
    const moved: SessionId[] = []
    // Descendants first: they share the root's cwd and hold no registry account.
    for (const descendant of await this.descendantsOf(sessionId, header.cwd)) {
      if (this.ctx.agents.get(descendant.id) !== undefined || this.ctx.sessions.get(descendant.id) !== undefined) {
        if (!await this.agents.retire(descendant.id)) continue
      }
      const outcome = await this.relocateOne(descendant, destination, fromLabel, toLabel, policy)
      if (outcome === undefined) moved.push(descendant.id)
    }
    const skipped = await this.relocateOne(header, destination, fromLabel, toLabel, policy)
    if (skipped !== undefined) return { moved, skipped }
    moved.push(sessionId)
    return { moved }
  }

  /**
   * Retire the Session's resident Agent when the policy allows it.
   * @returns a skip when the Session must stay where it is.
   */
  private async retireResident(sessionId: SessionId, policy: MovePolicy): Promise<SessionMoveSkip | undefined> {
    if (this.ctx.agents.get(sessionId) === undefined && this.ctx.sessions.get(sessionId) === undefined) return undefined
    if (policy.stopLive !== true) {
      const blockers = await sessionMoveBlockers(this.ctx, sessionId)
      if (blockers.length > 0) {
        return {
          sessionId,
          reason: 'live',
          message: `session "${sessionId}": ${describeBlockers(blockers)}; stop it first or move with stopLive`,
          blockers,
        }
      }
    }
    if (await this.agents.retire(sessionId)) return undefined
    return { sessionId, reason: 'live', message: `session "${sessionId}" is owned by another component and cannot be stopped here`, blockers: [] }
  }

  /**
   * Relocate one stored Session and re-account it.
   * @returns a skip when the Session did not move.
   */
  private async relocateOne(
    header: SessionHeader,
    destination: Workspace,
    fromLabel: SessionMoveLabel,
    toLabel: SessionMoveLabel,
    policy: MovePolicy,
  ): Promise<SessionMoveSkip | undefined> {
    const sessionId = header.id
    const persistence = this.persistence()
    const from = this.accountOf(sessionId)
    const append: SessionRelocateAppend[] = policy.notify === false
      ? []
      : [this.notice(fromLabel, toLabel, await this.readCold(sessionId))]
    let relocated
    try {
      relocated = await persistence.relocate({ id: sessionId, cwd: destination.path, append })
    } catch (error: unknown) {
      // Persistence is an optional peer: its refusals are recognized by name.
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { sessionId, reason: 'live', message: `session "${sessionId}" is open in another process`, blockers: [] }
      }
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') {
        return { sessionId, reason: 'missing', message: `session "${sessionId}" has no stored log` }
      }
      return { sessionId, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    // The indexed header names the old cwd: forget it, leave the old account,
    // and join the new one (subagent descendants hold no account).
    this.ctx.workspaceRegistry.forgetSessionHeader(sessionId)
    if (from !== undefined && from.id !== destination.id) await from.detachSession(sessionId)
    if (header.origin !== 'subagent') {
      try {
        await destination.attachSession(sessionId)
      } catch (error: unknown) {
        return {
          sessionId,
          reason: 'error',
          message: `moved on disk but could not attach to "${destination.title}": ${String(error)}`,
        }
      }
    }
    try {
      await this.ctx.get('sessionProjectionCache')?.rebind(header, relocated.header, relocated.inheritedEventCount)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session move: projection cache rebind for "${sessionId}" failed: ${String(error)}`)
    }
    // List owners refresh the row: clients merge summaries by id, so the new cwd lands as an upsert.
    this.ctx.emit('session-persistence/stored', relocated.header)
    return undefined
  }

  /**
   * The next-step notice for one move. Successive moves before the Agent runs
   * again replace the pending notices instead of stacking one per hop: the
   * Agent needs where it last ran and where it is now, so the replaced
   * notice's origin carries forward as `from`.
   */
  private notice(from: SessionMoveLabel, to: SessionMoveLabel, cold: ColdMoveFacts): SessionRelocateAppend {
    const origin = cold.pending?.from ?? from
    return {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-step',
        start: cold.pending?.index ?? 0,
        ...(cold.pending === undefined ? {} : { removedCount: cold.pending.count }),
        inserted: [createUserMessage({
          content: [{ type: 'text', text: sessionMoveNoticeText(origin, to, cold.sandboxMode) }],
          source: {
            kind: SESSION_MOVE_NOTICE_SOURCE,
            from: origin,
            form: 'notice',
            summary: boundContextSummary(`Moved from ${origin.title} to ${to.title}`),
          },
        })],
      },
    }
  }

  /** The Workspace whose account lists the Session, read before its header is forgotten. */
  private accountOf(sessionId: SessionId): Workspace | undefined {
    return this.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(sessionId))
  }

  /** The Workspace registered for a directory; absent when none is, or the directory no longer resolves. */
  private async ownerOfPath(path: string | undefined): Promise<Workspace | undefined> {
    if (path === undefined) return undefined
    try {
      return await this.ctx.workspaceRegistry.resolveByPath(path)
    } catch (error: unknown) {
      // A vanished directory belongs to no Workspace; the move proceeds from it.
      this.ctx.logger.debug(`session move: "${path}" does not resolve: ${String(error)}`)
      return undefined
    }
  }

  /** Subagent descendants stored in the root's cwd, from stored headers, nearest first. */
  private async descendantsOf(root: SessionId, cwd: string | undefined): Promise<SessionHeader[]> {
    if (cwd === undefined) return []
    const headers = (await this.persistence().list()).map(snapshot => snapshot.header)
    const found: SessionHeader[] = []
    const pending = [root]
    const visited = new Set<SessionId>()
    while (pending.length > 0) {
      const parent = pending.shift() as SessionId
      if (visited.has(parent)) continue
      visited.add(parent)
      for (const header of headers) {
        if (header.origin !== 'subagent' || header.parentSession !== parent || header.cwd !== cwd) continue
        found.push(header)
        pending.push(header.id)
      }
    }
    return found
  }

  /**
   * Cold facts a move notice needs from the stored log: the last recorded
   * `sandbox/mode` and the run of move notices still pending in the
   * next-step inbox. A log that cannot be read yields neither; the relocation
   * reports the read failure itself.
   */
  private async readCold(sessionId: SessionId): Promise<ColdMoveFacts> {
    let events: readonly SessionEvent[]
    try {
      const handle = await this.persistence().open(sessionId, 'read')
      try {
        events = (await handle.read()).events
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      this.ctx.logger.debug(`session move: cold facts of "${sessionId}" unavailable: ${String(error)}`)
      return {}
    }
    let sandboxMode: string | undefined
    let pending: readonly UserMessage[] = []
    for (const event of events) {
      // `sandbox/mode` is declared by the sandbox policy package, which this one does not depend on.
      const wide: { readonly type: string; readonly data: unknown } = event
      if (wide.type === 'sandbox/mode' && typeof wide.data === 'object' && wide.data !== null) {
        const mode = (wide.data as { readonly mode?: unknown }).mode
        if (typeof mode === 'string') sandboxMode = mode
      }
      if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-step') continue
      pending = pending.toSpliced(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
    }
    const index = pending.findIndex(isMoveNotice)
    if (index === -1) return sandboxMode === undefined ? {} : { sandboxMode }
    let count = 0
    while (index + count < pending.length && isMoveNotice(pending[index + count] as UserMessage)) count += 1
    const source = (pending[index] as UserMessage).source
    const from = 'from' in source && isMoveLabel(source.from) ? source.from : undefined
    return {
      ...(sandboxMode === undefined ? {} : { sandboxMode }),
      pending: { index, count, ...(from === undefined ? {} : { from }) },
    }
  }
}

/** What a move notice needs from the stored log. */
interface ColdMoveFacts {
  /** The last recorded `sandbox/mode`. */
  readonly sandboxMode?: string
  /** The run of move notices pending in the next-step inbox, and the origin the first one names. */
  readonly pending?: { readonly index: number; readonly count: number; readonly from?: SessionMoveLabel }
}

function isMoveNotice(message: UserMessage): boolean {
  const kind: string = message.source.kind
  return kind === SESSION_MOVE_NOTICE_SOURCE || kind === MIGRATED_MOVE_NOTICE_SOURCE
}

function isMoveLabel(value: unknown): value is SessionMoveLabel {
  return typeof value === 'object' && value !== null
    && typeof (value as { readonly title?: unknown }).title === 'string'
    && typeof (value as { readonly path?: unknown }).path === 'string'
}
