/**
 * Copying Sessions between Workspaces of this Host. Unlike a move, a copy
 * never touches its source: the durable log (flushed first when live) and
 * those of its subagent descendants are read and stored again under the
 * destination cwd as new Sessions with fresh ids, through the same storing
 * half that receives a cross-host import. The destination may be the source's
 * own Workspace, which makes a copy a duplicate. The only decision a live
 * source forces is what to do with a turn in progress: drop it whole
 * (`truncate`) or keep what was recorded and close it as interrupted. Without
 * that decision a running source is refused (`session/copy-live`).
 * @module @deepseek-ai/dsh-api-session-controller/copy
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { basename } from 'node:path'
import { storeSessionLogs, type ParsedSessionLog, type SessionImportResult } from './import.ts'
import { describeBlockers, resolveMoveDestination, sessionMoveBlockers } from './move.ts'
import type { SessionCopyRequest, SessionCopyValue } from './types.ts'

/** Host-side copy orchestration behind `session.copy`. */
export class SessionCopyController {
  /**
   * @param ctx - Host context carrying persistence, the Workspace registry, Agents, and Sessions.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Copy one Session and its subagent descendants into a Workspace.
   * @param request - source, destination, mid-turn policy, title, and notice policy.
   * @returns the new root id, every stored id, and whether a turn was dropped.
   * @throws RemoteError `session/copy-*` when the Session is not copied.
   */
  async copy(request: SessionCopyRequest): Promise<SessionCopyValue> {
    const destination = await resolveMoveDestination(this.ctx, request.destination)
    const { sessionId } = request
    const persistence = this.persistence()
    const header = (await persistence.stat(sessionId))?.header ?? this.ctx.sessions.get(sessionId)?.header
    if (header === undefined) {
      throw new RemoteError('session/copy-missing', `session "${sessionId}" not found`, { sessionId })
    }
    // A turn in progress is the one thing the caller must decide about; jobs
    // and subagents keep running at the source and are only listed.
    if (request.truncate === undefined && this.ctx.agents.get(sessionId)?.status === 'running') {
      const blockers = await sessionMoveBlockers(this.ctx, sessionId)
      throw new RemoteError(
        'session/copy-live',
        `session "${sessionId}": ${describeBlockers(blockers)}; choose whether to drop the turn in progress (truncate)`,
        { sessionId, blockers },
      )
    }
    const from = header.cwd === undefined
      ? undefined
      : await this.ctx.workspaceRegistry.resolveByPath(header.cwd).catch(() => undefined)
    const origin = `the workspace \`${from?.title ?? (header.cwd === undefined ? '(none)' : basename(header.cwd))}\``
      + ` (${header.cwd ?? 'no directory'})`
    let result: SessionImportResult
    try {
      const root = await this.readStoredLog(sessionId)
      if (root === undefined) throw new RemoteError('session/copy-missing', `session "${sessionId}" has no stored log`, { sessionId })
      const children: ParsedSessionLog[] = []
      for (const descendant of await this.subagentDescendants(sessionId)) {
        const log = await this.readStoredLog(descendant.id)
        if (log !== undefined) children.push(log)
      }
      result = await storeSessionLogs(this.ctx, { root, children }, {
        workspace: destination,
        origin,
        mode: 'copy',
        crossHost: false,
        ...(request.truncate === undefined ? {} : { truncate: request.truncate }),
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.notify === undefined ? {} : { notify: request.notify }),
      })
    } catch (error: unknown) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError('session/copy-error', `failed to copy session "${sessionId}": ${error instanceof Error ? error.message : String(error)}`, {
        sessionId,
      })
    }
    return {
      sessionId: result.sessionId,
      sourceSessionId: sessionId,
      workspaceId: destination.id,
      copied: result.imported.map(entry => entry.sessionId),
      truncated: result.truncated,
    }
  }

  private persistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new RemoteError('gateway/internal', 'session copy is unavailable: missing session-persistence service', {})
    }
    return persistence
  }

  /** Read one stored log, after the live store's durability barrier when the Session is live. */
  private async readStoredLog(id: SessionId): Promise<ParsedSessionLog | undefined> {
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) await this.ctx.sessions.flush(live)
    let handle
    try {
      handle = await this.persistence().open(id, 'read')
    } catch (error: unknown) {
      // Persistence is an optional peer: its refusals are recognized by name.
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return undefined
      throw error
    }
    try {
      const { events } = await handle.read()
      return { header: handle.header, events, inheritedEventCount: handle.inheritedEventCount }
    } finally {
      await handle.close()
    }
  }

  /** Stored subagent descendants of one Session at any depth, nearest first. */
  private async subagentDescendants(root: SessionId): Promise<SessionHeader[]> {
    const headers = (await this.persistence().list()).map(snapshot => snapshot.header)
    const found: SessionHeader[] = []
    const pending = [root]
    const visited = new Set<SessionId>()
    while (pending.length > 0) {
      const parent = pending.shift() as SessionId
      if (visited.has(parent)) continue
      visited.add(parent)
      for (const header of headers) {
        if (header.origin !== 'subagent' || header.parentSession !== parent) continue
        found.push(header)
        pending.push(header.id)
      }
    }
    return found
  }
}
