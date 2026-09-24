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
 *
 * The session dialogs also list destinations contributed through
 * `ctx.uiWorkspace.contributeDestinations` (a remote host's Workspaces, for
 * instance) as further headed groups after this machine's, and hand a pick of
 * one of those to the contributor's `run`, which answers in the Host's own
 * refusal vocabulary, so a refusal reads the same for every destination.
 * Rehome stays local.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconFolderCloseRegular, IconGlobeOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionActivity, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionRelocationRequest, WorkspaceBrowserProps } from '../contract/slots.ts'
import type {
  DestinationContribution, DestinationEntry, DestinationGroup, DestinationRunRequest,
} from '../navigation.ts'
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

/** One contributed group with the contribution it came from. */
interface ContributedGroup {
  readonly contributionId: string
  readonly group: DestinationGroup
}

/** The live, non-empty groups of every destination contribution, in contribution order. */
function useContributedGroups(contributions: readonly DestinationContribution[]): readonly ContributedGroup[] {
  const read = useCallback((): readonly ContributedGroup[] => contributions.flatMap(contribution =>
    contribution.groups.getSnapshot()
      .filter(group => group.entries.length > 0)
      .map(group => ({ contributionId: contribution.id, group }))), [contributions])
  const [groups, setGroups] = useState<readonly ContributedGroup[]>(read)
  useEffect(() => {
    setGroups(read())
    const unsubscribes = contributions.map(contribution => contribution.groups.subscribe(() => { setGroups(read()) }))
    return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
  }, [contributions, read])
  return groups
}

/** A chosen destination: a Workspace of this machine, or one entry of a contributed group. */
type DestinationChoice =
  | { readonly kind: 'local'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'external'; readonly groupId: string; readonly key: string }

/** A choice resolved against the current lists; undefined once it is no longer offered. */
type ResolvedDestination =
  | { readonly kind: 'local'; readonly workspace: WorkspaceView }
  | {
    readonly kind: 'external'
    readonly contributionId: string
    readonly group: DestinationGroup
    readonly entry: DestinationEntry
  }

function resolveDestination(
  choice: DestinationChoice | undefined,
  workspaces: readonly WorkspaceView[],
  groups: readonly ContributedGroup[],
): ResolvedDestination | undefined {
  if (choice === undefined) return undefined
  if (choice.kind === 'local') {
    const workspace = workspaces.find(candidate => candidate.workspaceId === choice.workspaceId)
    return workspace === undefined ? undefined : { kind: 'local', workspace }
  }
  const contributed = groups.find(candidate => candidate.group.id === choice.groupId)
  const entry = contributed?.group.entries.find(candidate => candidate.key === choice.key)
  return contributed === undefined || entry === undefined
    ? undefined
    : { kind: 'external', contributionId: contributed.contributionId, group: contributed.group, entry }
}

/**
 * The destination field: a select-like button over the pick flow, showing the
 * choice and its directory. With contributed groups the list is a tree: this
 * machine's Workspaces under their heading, then each group under its own.
 */
function DestinationPicker({ t, value, current, flow, groups, onPick, disabled }: {
  t: Translate
  /** The chosen destination. */
  value: ResolvedDestination | undefined
  /** Workspace the item belongs to: checked while nothing is chosen, still pickable. */
  current: WorkspaceId | undefined
  flow: DestinationFlowProps
  /** Contributed groups listed after this machine's Workspaces. */
  groups: readonly ContributedGroup[]
  onPick: (choice: DestinationChoice) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const formatPath = (path: string): string => abbreviateHomePath(path, flow.home)
  const label = value === undefined
    ? t('move.destination.pick')
    : value.kind === 'local'
      ? workspaceDisplayTitle(value.workspace.title, t('workspace.defaultName'))
      : `${value.entry.title} · ${value.group.label}`
  const path = value === undefined ? undefined : value.kind === 'local' ? formatPath(value.workspace.path) : value.entry.path
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
        {value?.kind === 'external' ? <IconGlobeOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />}
        <span className={css.relocateDestinationText}>{label}</span>
        {path !== undefined && <span className={css.relocateDestinationPath} title={path}>{path}</span>}
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
        selectedId={value?.kind === 'local' ? value.workspace.workspaceId : value === undefined ? current : undefined}
        showPaths
        formatPath={formatPath}
        matchAnchorWidth
        externalGroups={groups.map(({ group }) => group)}
        localLabel={t('move.destination.local')}
        selectedExternal={value?.kind === 'external' ? { groupId: value.group.id, key: value.entry.key } : undefined}
        onPick={(workspaceId) => {
          setOpen(false)
          onPick({ kind: 'local', workspaceId })
        }}
        onPickExternal={(pick) => {
          setOpen(false)
          onPick({ kind: 'external', ...pick })
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

/** One answer from the Host or from a contributor, in the shape the dialog reacts to. */
type RelocationAnswer =
  | { readonly ok: true; readonly outcome?: RelocationOutcome; readonly summary?: string }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly blockers?: readonly SessionActivity[] }

/** The activity a contributor's refusal names; a refusal without any reads as a running turn. */
function blockersFrom(details: unknown): readonly SessionActivity[] {
  if (typeof details !== 'object' || details === null || !('blockers' in details) || !Array.isArray(details.blockers)) {
    return [{ kind: 'turn' }]
  }
  return details.blockers.filter((entry: unknown): entry is SessionActivity =>
    typeof entry === 'object' && entry !== null && 'kind' in entry && typeof entry.kind === 'string')
}

/** Hand a contributed destination to its contributor; a throw or a withdrawn contribution becomes a refusal. */
async function runContributed(
  contributions: readonly DestinationContribution[],
  destination: Extract<ResolvedDestination, { kind: 'external' }>,
  request: Omit<DestinationRunRequest, 'groupId' | 'destinationKey'>,
): Promise<RelocationAnswer> {
  const contribution = contributions.find(candidate => candidate.id === destination.contributionId)
  if (contribution === undefined) {
    return { ok: false, code: 'ui-workspace/destination-gone', message: 'that destination is no longer offered' }
  }
  try {
    const result = await contribution.run({ ...request, groupId: destination.group.id, destinationKey: destination.entry.key })
    if (result.ok) return result.summary === undefined ? { ok: true } : { ok: true, summary: result.summary }
    const live = result.code === 'session/move-live' || result.code === 'session/copy-live'
    return { ok: false, code: result.code, message: result.message, ...(live ? { blockers: blockersFrom(result.details) } : {}) }
  } catch (failure: unknown) {
    return { ok: false, code: 'ui-workspace/destination-failed', message: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * Move to… or Copy to… for one Session: one dialog per request (keyed by the
 * caller), so a new request starts from a fresh state. A move may not target
 * the Session's own Workspace; a copy may (a duplicate) and starts there. A
 * running source refuses either until the operator decides: interrupt its
 * work and move, or copy only up to the last completed turn (ticked by
 * default) or as recorded so far. Contributed destinations follow this
 * machine's Workspaces; their contributor carries the operation out and may
 * answer with a summary the dialog shows before it is closed.
 * @param props - the request, the Host hops, the contributions, the destination flow, the Workspace list, and settlement.
 * @returns the dialog.
 */
export function SessionRelocateDialog({
  request, workspaces, contributions, moveSession, copySession, flow, t, onClose, onDone,
}: {
  request: SessionRelocationRequest
  workspaces: readonly WorkspaceView[]
  /** Destinations other plugins add after this machine's Workspaces. */
  contributions: readonly DestinationContribution[]
  moveSession: WorkspaceBrowserProps['moveSession']
  copySession: WorkspaceBrowserProps['copySession']
  flow: DestinationFlowProps
  t: Translate
  onClose: () => void
  /** The Session moved or was copied here; nothing when a contributor carried it elsewhere. */
  onDone: (outcome?: RelocationOutcome) => void
}) {
  const copy = request.action === 'copy'
  const source = owningWorkspace(workspaces, request.sessionId)
  const groups = useContributedGroups(contributions)
  const preselected = request.destinationId ?? (copy ? source?.workspaceId : undefined)
  const [choice, setChoice] = useState<DestinationChoice | undefined>(
    preselected === undefined ? undefined : { kind: 'local', workspaceId: preselected },
  )
  const destination = resolveDestination(choice, workspaces, groups)
  const [title, setTitle] = useState(request.displayTitle === '' ? '' : `${request.displayTitle}${t('copy.title.suffix')}`)
  const [blockers, setBlockers] = useState<readonly SessionActivity[] | null>(null)
  const [stopLive, setStopLive] = useState(false)
  const [truncate, setTruncate] = useState(true)
  const [notify, setNotify] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const sameWorkspace = !copy && destination?.kind === 'local' && destination.workspace.workspaceId === source?.workspaceId
  const blocked = pending || destination === undefined || sameWorkspace || summary !== null
    || (!copy && blockers !== null && !stopLive)
  const close = (): void => {
    if (!pending) onClose()
  }
  const settle = (answer: RelocationAnswer): void => {
    setPending(false)
    if (answer.ok) {
      if (answer.summary !== undefined) setSummary(answer.summary)
      else onDone(answer.outcome)
      return
    }
    if (answer.blockers !== undefined) {
      setBlockers(answer.blockers)
      return
    }
    setError(`${answer.code}: ${answer.message}`)
  }
  const fromHost = (result: Awaited<ReturnType<WorkspaceBrowserProps['moveSession']>>
    | Awaited<ReturnType<WorkspaceBrowserProps['copySession']>>): RelocationAnswer => {
    if (result.ok) return { ok: true, outcome: { sessionId: result.value.sessionId, workspaceId: result.value.workspaceId } }
    const { error: failure } = result
    return failure.code === 'session/move-live' || failure.code === 'session/copy-live'
      ? { ok: false, code: failure.code, message: failure.message, blockers: failure.details.blockers }
      : { ok: false, code: failure.code, message: failure.message }
  }
  const confirm = (): void => {
    if (blocked) return
    setPending(true)
    setError(null)
    const named = title.trim()
    const copyOptions = {
      // Undecided until the source reports a running turn; then the checkbox decides.
      ...(blockers === null ? {} : { truncate }),
      ...(named === '' || named === request.displayTitle ? {} : { title: named }),
    }
    if (destination.kind === 'external') {
      void runContributed(contributions, destination, {
        action: request.action,
        sessionId: request.sessionId,
        sourceTitle: request.displayTitle,
        ...(source === undefined ? {} : { sourceWorkspaceId: source.workspaceId }),
        notify,
        ...(copy ? copyOptions : { stopLive }),
      }).then(settle)
      return
    }
    const target = { sessionId: request.sessionId, destination: { workspaceId: destination.workspace.workspaceId }, notify }
    const answer = copy ? copySession({ ...target, ...copyOptions }) : moveSession({ ...target, stopLive })
    void answer.then(fromHost).then(settle)
  }
  const done = summary !== null
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
          <Button variant="outline" disabled={pending} onClick={close}>{done ? t('close') : t('cancel')}</Button>
          {!done && (
            <Button variant="primary" disabled={blocked} onClick={confirm}>
              {copy ? (pending ? t('copy.pending') : t('copy.confirm')) : (pending ? t('move.pending') : t('move.confirm'))}
            </Button>
          )}
        </>
      )}
    >
      <div className={css.relocateBody}>
        <DestinationPicker
          t={t} value={destination} current={source?.workspaceId} flow={flow} groups={groups} disabled={pending || done}
          onPick={(next) => {
            setChoice(next)
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
              disabled={pending || done}
              onChange={(event) => { setTitle(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                confirm()
              }}
            />
          </label>
        )}
        {blockers !== null && !done && (
          <>
            <BlockerList blockers={blockers} t={t} label={t(copy ? 'copy.live.blockers' : 'move.live.blockers')} />
            {copy
              ? <Checkbox checked={truncate} onChange={setTruncate} disabled={pending} label={t('copy.truncate')} />
              : <Checkbox checked={stopLive} onChange={setStopLive} disabled={pending} label={t('move.stopLive')} />}
          </>
        )}
        <Checkbox
          checked={notify} onChange={setNotify} disabled={pending || done} label={t(copy ? 'copy.notify' : 'move.notify')}
        />
        {summary !== null && <div className={css.deleteStatus} role="status">{summary}</div>}
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
          t={t} value={destination === undefined ? undefined : { kind: 'local', workspace: destination }}
          current={target.workspaceId} flow={flow} groups={[]} disabled={pending || summary !== null}
          onPick={(choice) => {
            if (choice.kind !== 'local') return
            setDestinationId(choice.workspaceId)
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
