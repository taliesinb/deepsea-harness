/**
 * The receiving half of a cross-host Session move as callable functions: the
 * import route unzips an archive here and hands its entries to the Session
 * Controller, whose storing half decodes, re-identifies, and stores the logs.
 * Out-of-tree importers that already hold parsed logs call
 * {@link storeSessionLogs} with their own Context.
 * @module
 */
import { unzipSync } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionController, SessionImportResult, SessionImportTarget, SessionLogFamily,
} from '@deepseek-ai/dsh-api-session-controller'

/** The mounted Session Controller, which owns Session storage across Workspaces. */
function sessionController(ctx: Context): SessionController {
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('session import is unavailable: the Session Controller is not mounted')
  return controller
}

/**
 * Store parsed Session logs, one root and its subagent descendants, as
 * Sessions of this Host under a Workspace, and attach the root to it.
 * Attachments the logs reference must already be stored here.
 * @param ctx - any Host context of a composition that mounts the Session Controller.
 * @param logs - the root log and every descendant log, in any order.
 * @param target - destination Workspace, origin label, and id and notice policy.
 * @returns the stored root id and every stored Session.
 * @throws when the Session Controller is not mounted or a log cannot be stored.
 */
export function storeSessionLogs(
  ctx: Context,
  logs: SessionLogFamily,
  target: SessionImportTarget,
): Promise<SessionImportResult> {
  return sessionController(ctx).storeSessionLogs(logs, target)
}

/**
 * Import one export archive into a Workspace of this Host.
 * @param ctx - any Host context of a composition that mounts the Session Controller.
 * @param zip - the complete archive bytes.
 * @param target - destination Workspace, origin label, and id and notice policy.
 * @returns the stored root id and every stored Session.
 * @throws when the archive is unreadable, holds no root log, or a log fails validation.
 */
export async function importSessionZip(
  ctx: Context,
  zip: Uint8Array,
  target: SessionImportTarget,
): Promise<SessionImportResult> {
  target.signal?.throwIfAborted()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch (error: unknown) {
    throw new Error(`session import: not a readable ZIP archive: ${error instanceof Error ? error.message : String(error)}`)
  }
  return sessionController(ctx).importSessionArchive(entries, target)
}
