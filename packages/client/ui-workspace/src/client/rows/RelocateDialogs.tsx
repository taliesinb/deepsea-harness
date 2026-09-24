/**
 * Browser-owned dialogs behind Move to… and Copy to… (Session row actions;
 * a drop on another Workspace group the Host refused opens Move to…) and
 * Rehome… (a Workspace row action). All pick their destination through the
 * same WorkspacePickFlow popover the sidebar's "Add workspace" uses, so an
 * existing Workspace or a freshly registered directory can be the target,
 * and hand the decision to the Host's `session.move` / `session.copy` /
 * `session.moveMany`.
 *
 * A Session whose Agent has work in flight refuses to move
 * (`session/move-live`); the dialog answers by listing that work and revealing
 * the stop-and-move option, so the operator chooses explicitly. A copy never
 * disturbs its source, so a running one is refused (`session/copy-live`)
 * only until the operator decides what the copy does with the turn in
 * progress. Rehome moves every member of the source Workspace, reports skips,
 * and can delete the emptied source.
 */
import { useRef, useState } from 'react'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconFolderCloseRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionActivity, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionRelocationRequest, WorkspaceBrowserProps } from '../contract/slots.ts'
import { activityLine } from '../session-actions/ArchiveSession.tsx'
import { WorkspacePickFlow, type WorkspacePickFlowProps } from '../WorkspacePicker.tsx'
import css from './WorkspaceBrowser.module.css'

type Translate = WorkspaceBrowserProps['t']

/** Destination-picker inputs the dialogs forward to WorkspacePickFlow. */
export type DestinationFlowProps = Pick<
  WorkspacePickFlowProps, 'useWorkspaces' | 'createWorkspace' | 'useDirectoryFlow' | 'renderDirectoryFlow'
> & {
  /** Host account home; home-rooted paths display as `~`. */
  home?: string | undefined
}

/** The destination field: a select-like button over the pick flow, showing the choice and its directory. */
function DestinationPicker({ t, value, current, flow, onPick, disabled }: {
  t: Translate
  /** The chosen Workspace. */
  value: WorkspaceView | undefined
  /** Workspace the item belongs to: checked while nothing is chosen, still pickable. */
  current: WorkspaceId | undefined
  flow: DestinationFlowProps
  onPick: (workspaceId: WorkspaceId) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const formatPath = (path: string): string => abbreviateHomePath(path, flow.home)
  return (
    <div className={css.relocateField}>
      <span className={css.relocateLabel}>{t('move.destination')}</span>
      <button
        ref={anchor}
        type="button"
        className={css.relocateDestination}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(state => !state) }}
      >
        <IconFolderCloseRegular size={16} />
        <span className={css.relocateDestinationText}>
          {value === undefined ? t('move.destination.pick') : workspaceDisplayTitle(value.title, t('workspace.defaultName'))}
        </span>
        {value !== undefined && <span className={css.relocateDestinationPath} title={value.path}>{formatPath(value.path)}</span>}
        <IconChevronDownOutlineRegular size={14} />
      </button>
      <WorkspacePickFlow
        t={t}
        open={open}
        anchorRef={anchor}
        useWorkspaces={flow.useWorkspaces}
        createWorkspace={flow.createWorkspace}
        useDirectoryFlow={flow.useDirectoryFlow}
        renderDirectoryFlow={flow.renderDirectoryFlow}
        selectedId={value?.workspaceId ?? current}
        showPaths
        formatPath={formatPath}
        matchAnchorWidth
        onPick={(workspaceId) => {
          setOpen(false)
          onPick(workspaceId)
        }}
        onClose={() => { setOpen(false) }}
      />
    </div>
  )
}

/** The work a refused move or copy named, one line per activity family. */
function BlockerList({ blockers, label, t }: { blockers: readonly SessionActivity[]; label: string; t: Translate }) {
  return (
    <ul className={css.archiveActivity} aria-label={label}>
      {blockers.map((entry, index) => <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry, t)}</li>)}
    </ul>
  )
}

/** The Workspace that lists a Session, if any. */
function owningWorkspace(workspaces: readonly WorkspaceView[], sessionId: SessionId): WorkspaceView | undefined {
  return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
}

/** What a relocation dialog reports on success. */
export interface RelocationOutcome {
  /** The moved Session, or the new copy. */
  sessionId: SessionId
  /** The Workspace it now belongs to. */
  workspaceId: WorkspaceId
}

/**
 * Move to… or Copy to… for one Session: one dialog per request (keyed by the
 * caller), so a new request starts from a fresh state. A move may not target
 * the Session's own Workspace; a copy may (a duplicate) and starts there. A
 * running source refuses either until the operator decides: interrupt its
 * work and move, or copy only up to the last completed turn (ticked by
 * default) or as recorded so far.
 * @param props - the request, the Host hops, the destination flow, the Workspace list, and settlement.
 * @returns the dialog.
 */
export function SessionRelocateDialog({ request, workspaces, moveSession, copySession, flow, t, onClose, onDone }: {
  request: SessionRelocationRequest
  workspaces: readonly WorkspaceView[]
  moveSession: WorkspaceBrowserProps['moveSession']
  copySession: WorkspaceBrowserProps['copySession']
  flow: DestinationFlowProps
  t: Translate
  onClose: () => void
  /** The Session moved, or its copy was stored. */
  onDone: (outcome: RelocationOutcome) => void
}) {
  const copy = request.action === 'copy'
  const source = owningWorkspace(workspaces, request.sessionId)
  const [destinationId, setDestinationId] = useState<WorkspaceId | undefined>(
    request.destinationId ?? (copy ? source?.workspaceId : undefined),
  )
  const destination = workspaces.find(workspace => workspace.workspaceId === destinationId)
  const [title, setTitle] = useState(request.displayTitle === '' ? '' : `${request.displayTitle}${t('copy.title.suffix')}`)
  const [blockers, setBlockers] = useState<readonly SessionActivity[] | null>(null)
  const [stopLive, setStopLive] = useState(false)
  const [truncate, setTruncate] = useState(true)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sameWorkspace = !copy && destination !== undefined && destination.workspaceId === source?.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || (!copy && blockers !== null && !stopLive)
  const close = (): void => {
    if (!pending) onClose()
  }
  const settle = (result: Awaited<ReturnType<WorkspaceBrowserProps['moveSession']>>
    | Awaited<ReturnType<WorkspaceBrowserProps['copySession']>>): void => {
    setPending(false)
    if (result.ok) {
      onDone({ sessionId: result.value.sessionId, workspaceId: result.value.workspaceId })
      return
    }
    if (result.error.code === 'session/move-live' || result.error.code === 'session/copy-live') {
      setBlockers(result.error.details.blockers)
      return
    }
    setError(`${result.error.code}: ${result.error.message}`)
  }
  const confirm = (): void => {
    if (blocked) return
    setPending(true)
    setError(null)
    const target = { sessionId: request.sessionId, destination: { workspaceId: destination.workspaceId }, notify }
    if (!copy) {
      void moveSession({ ...target, stopLive }).then(settle)
      return
    }
    const named = title.trim()
    void copySession({
      ...target,
      // Undecided until the Host reports a running turn; then the checkbox decides.
      ...(blockers === null ? {} : { truncate }),
      ...(named === '' || named === request.displayTitle ? {} : { title: named }),
    }).then(settle)
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t(copy ? 'copy.session.title' : 'move.session.title')}
      {...request.displayTitle === '' ? {} : { description: request.displayTitle }}
      className={css.relocateDialog as string}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={confirm}>
            {copy ? (pending ? t('copy.pending') : t('copy.confirm')) : (pending ? t('move.pending') : t('move.confirm'))}
          </Button>
        </>
      )}
    >
      <div className={css.relocateBody}>
        <DestinationPicker
          t={t} value={destination} current={source?.workspaceId} flow={flow} disabled={pending}
          onPick={(workspaceId) => {
            setDestinationId(workspaceId)
            setError(null)
          }}
        />
        {sameWorkspace && <div className={css.deleteStatus} role="status">{t('move.destination.same')}</div>}
        {copy && (
          <label className={css.relocateField}>
            <span className={css.relocateLabel}>{t('copy.title')}</span>
            <input
              className={css.renameInput}
              value={title}
              disabled={pending}
              onChange={(event) => { setTitle(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                confirm()
              }}
            />
          </label>
        )}
        {blockers !== null && (
          <>
            <BlockerList blockers={blockers} t={t} label={t(copy ? 'copy.live.blockers' : 'move.live.blockers')} />
            {copy
              ? <Checkbox checked={truncate} onChange={setTruncate} disabled={pending} label={t('copy.truncate')} />
              : <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending} label={t('move.stopLive')} />}
          </>
        )}
        <Checkbox checked={notify} onChange={setNotify} disabled={pending} label={t(copy ? 'copy.notify' : 'move.notify')} />
        {error !== null && <div className={css.renameError} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

/** The Workspace a Rehome… acts on. */
export interface RehomeTarget {
  workspaceId: WorkspaceId
  title: string
  sessionIds: readonly SessionId[]
}

/**
 * Rehome… for one Workspace: move every member Session elsewhere, report what
 * was skipped, and optionally delete the emptied source.
 * @param props - the target, the Host hops, the destination flow, the Workspace list, and settlement.
 * @returns the dialog.
 */
export function RehomeWorkspaceDialog({ target, workspaces, moveSessions, deleteWorkspace, flow, t, onClose, onDone }: {
  target: RehomeTarget
  workspaces: readonly WorkspaceView[]
  moveSessions: WorkspaceBrowserProps['moveSessions']
  deleteWorkspace: WorkspaceBrowserProps['deleteWorkspace']
  flow: DestinationFlowProps
  t: Translate
  onClose: () => void
  /** Sessions moved into this Workspace. */
  onDone: (workspaceId: WorkspaceId) => void
}) {
  const [destinationId, setDestinationId] = useState<WorkspaceId | undefined>(undefined)
  const destination = workspaces.find(workspace => workspace.workspaceId === destinationId)
  const [stopLive, setStopLive] = useState(false)
  const [deleteSource, setDeleteSource] = useState(false)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const sameWorkspace = destination?.workspaceId === target.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || summary !== null
  const close = (): void => {
    if (!pending) onClose()
  }
  const confirm = async (): Promise<void> => {
    if (blocked) return
    setPending(true)
    setError(null)
    const result = await moveSessions({
      sessionIds: target.sessionIds, destination: { workspaceId: destination.workspaceId }, stopLive, notify,
    })
    if (!result.ok) {
      setPending(false)
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    const { moved, skipped } = result.value
    const live = skipped.filter(skip => skip.reason === 'live').length
    if (deleteSource && skipped.length === 0) {
      try {
        await deleteWorkspace(target.workspaceId)
      } catch (failure: unknown) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    setPending(false)
    setSummary(live === 0
      ? t('rehome.result', { moved: moved.length, skipped: skipped.length })
      : t('rehome.result.live', { moved: moved.length, skipped: skipped.length, live }))
    onDone(result.value.workspaceId)
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('rehome.title', { name: target.title })}
      className={css.relocateDialog as string}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{summary === null ? t('cancel') : t('close')}</Button>
          {summary === null && (
            <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>
              {pending ? t('rehome.pending') : t('rehome.confirm')}
            </Button>
          )}
        </>
      )}
    >
      <div className={css.relocateBody}>
        <DestinationPicker
          t={t} value={destination} current={target.workspaceId} flow={flow} disabled={pending || summary !== null}
          onPick={(workspaceId) => {
            setDestinationId(workspaceId)
            setError(null)
          }}
        />
        {sameWorkspace && <div className={css.deleteStatus} role="status">{t('rehome.destination.same')}</div>}
        <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending || summary !== null} label={t('rehome.stopLive')} />
        <Checkbox checked={deleteSource} onChange={setDeleteSource} disabled={pending || summary !== null} label={t('rehome.deleteSource')} />
        <Checkbox checked={notify} onChange={setNotify} disabled={pending || summary !== null} label={t('move.notify')} />
        {summary !== null && <div className={css.deleteStatus} role="status">{summary}</div>}
        {error !== null && <div className={css.renameError} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
