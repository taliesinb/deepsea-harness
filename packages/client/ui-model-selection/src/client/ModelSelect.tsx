/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Smaller model
 * catalogs, root panes, and effort panes move focus between rows. Escape and Shift+Tab leave a drilled pane first and otherwise close
 * back to the trigger. A drilled pane focuses the current effort or model
 * search field. Provider headings paint their background only while pinned
 * by scrolling. Clearing a query restores the full list and search focus.
 * Selecting restores trigger focus without a ring until the trigger loses focus
 * or the menu reopens. Model names match a case-insensitive ordered subsequence
 * within each provider group, ranked by
 * prefix, alignment score, then catalog order. Returning to the root pane
 * hands focus back to the cell that opened it. Data and submission ride the
 * same per-session ModelDirectory as the /model popup; exact-model reasoning
 * metadata and the selected effort come from the Host rather than a
 * client-owned vocabulary. A rejected selection announces through the shared
 * transient Toast anchored to the composer card; the in-menu strip with
 * Retry remains the catalog-load surface. While the directory's pending
 * selection is unsettled, the trigger shows a spinner in place of its
 * chevron, and each row whose value that selection carries shows one in place
 * of its check mark.
 *
 * The model list has one section per provider and access kind (a plan
 * sign-in, a first-party API key, each upstream vendor of an OpenRouter
 * route, a server on this machine), each headed by its kind's glyph and the
 * provider's name; the same glyph marks the current route on the trigger and
 * the Model cell. Under search, a filter bar offers the access kinds the
 * catalog has as radio toggles (none pressed shows every kind), the
 * capability filters that split the catalog, and a toggle for older models:
 * a model a newer version of its line supersedes is hidden until the toggle
 * is on, unless it is the current model. Each filter names itself in an
 * immediate tooltip.
 *
 * Below a divider under the Model and Effort rows, the root pane lists up to
 * four recently chosen model/effort pairs (the directory's shared recent list,
 * skipping the pair in use and models the catalog no longer lists), each
 * selectable in one click; a row names its effort only when it is not the
 * model's default.
 */
import { MenuGroup, MenuSurface, observeStickyMenuGroups } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconClockOutlineRegular,
  IconCloseFillRegular, IconDataOutlineRegular, IconThinkOutlineRegular, IconWarningOutlineRegular, Input, rankByName,
  StateDot, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'
import type { ModelKey } from './locales.ts'
import { sameSelection } from './recent.ts'
import {
  hasCapability, MODEL_ROUTES, modelSections, routeTitle, splittingFilters, supersededModels,
  type ModelFilter, type ModelRoute, type ModelSection,
} from './route-sections.ts'

/** Recent selections listed under the root pane's cells. */
const RECENT_SHOWN = 4

/** One recent-selection row of the root pane. */
interface RecentChoice {
  key: string
  route: ModelRoute
  label: string
  selection: ModelSelection
}

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Label of each access-kind filter. */
const ROUTE_LABEL: Readonly<Record<ModelRoute, ModelKey>> = {
  plan: 'kind.plan', api: 'kind.api', openrouter: 'kind.openrouter', local: 'kind.local',
}

/** Label of each capability filter. */
const FILTER_LABEL: Readonly<Record<ModelFilter, ModelKey>> = {
  images: 'filter.images', reasoning: 'filter.reasoning', tools: 'filter.tools', free: 'filter.free',
}

/**
 * One filter toggle, named by an immediate tooltip (the native title waits
 * about a second) and by its accessible label.
 * @param props - label, pressed state, the toggle action and the glyph.
 * @returns the anchored toggle.
 */
function FilterToggle({ label, pressed, disabled, className, onToggle, children }: {
  label: string
  pressed: boolean
  disabled: boolean
  className?: string | undefined
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <Tooltip portal label={label} side="top" gap={6}>
      <button
        type="button"
        className={clsx(css.filter, className)}
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * The glyph of a route kind: a laptop for a local server, a shield for a plan,
 * a fork for OpenRouter, a code frame for an API key. The billing plugin draws
 * the same plan, OpenRouter and API glyphs, and its tests compare them with
 * these lines, so keep each glyph on the one line of its branch.
 * @param props - the route kind and the glyph's class.
 * @returns the decorative glyph.
 */
function RouteIcon({ route, className }: { route: ModelRoute; className?: string | undefined }) {
  if (route === 'local') return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M1.8 16h16.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
  if (route === 'plan') return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8 17 4.4v4.7c0 4.2-2.7 7.3-7 9.1-4.3-1.8-7-4.9-7-9.1V4.4l7-2.6Z" fill="none" stroke="currentColor" strokeWidth="1.55" /><circle cx="10" cy="7.2" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.8 13.5c.5-2.1 1.6-3.2 3.2-3.2s2.8 1.1 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  if (route === 'openrouter') return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h4M6 10c2.5 0 3-4 5.5-4H17M6 10c2.5 0 3 4 5.5 4H17M14.5 3.5 17 6l-2.5 2.5M14.5 11.5 17 14l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
  return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><rect x="1.8" y="3" width="16.4" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m7 7-3 3 3 3m6-6 3 3-3 3m-2.2-7.2-1.6 8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/**
 * The glyph of one capability filter.
 * @param props - the filter.
 * @returns the decorative glyph.
 */
function FilterIcon({ filter }: { filter: ModelFilter }) {
  if (filter === 'reasoning') return <IconThinkOutlineRegular size={14} />
  if (filter === 'images') return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.6" cy="6.3" r="1.2" fill="currentColor" /><path d="m2.5 11.6 3.6-3.4 2.4 2.2 2-1.7 3 2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
  if (filter === 'tools') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.6 1.75h5.65v5.65L7.4 14.25 1.75 8.6 8.6 1.75Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="11.1" cy="4.9" r="1.1" fill="currentColor" /></svg>
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [filters, setFilters] = useState<ReadonlySet<ModelFilter>>(() => new Set())
  const [historical, setHistorical] = useState(false)
  const [kind, setKind] = useState<ModelRoute | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const sections = useMemo(() => modelSections(state.groups, group =>
    group.id === 'deepseek-account' ? t('provider.account') : routeTitle(group)), [state.groups, t])
  const choices = useMemo(() => sections.flatMap(section =>
    section.models.map(model => ({
      section,
      model,
      selection: {
        provider: section.provider,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [sections])
  const showSearch = choices.length > 4
  // The filter bar rides with search: a catalog small enough to show whole is
  // shown whole. Only kinds the catalog has, and filters that split it, are
  // offered or applied.
  const offeredKinds = useMemo(() => {
    const kinds = MODEL_ROUTES.filter(route => sections.some(section => section.route === route))
    return showSearch && kinds.length > 1 ? kinds : []
  }, [sections, showSearch])
  const offeredFilters = useMemo(() => showSearch ? splittingFilters(sections) : [], [sections, showSearch])
  const superseded = useMemo(() => new Map(sections.map(section => [section.key, supersededModels(section.models)])), [sections])
  const offersHistorical = showSearch && [...superseded.values()].some(ids => ids.size > 0)
  const filteredSections = useMemo(() => sections
    .filter(section => kind === null || !offeredKinds.includes(kind) || section.route === kind)
    .map((section): ModelSection => ({
      ...section,
      models: rankByName(section.models.filter(model => (
        historical || !offersHistorical || superseded.get(section.key)?.has(model.id) !== true
          || (state.current?.provider === section.provider && state.current.model === model.id)
      ) && offeredFilters.every(filter => !filters.has(filter) || hasCapability(model, filter))), showSearch ? query.trim() : ''),
    })).filter(section => section.models.length > 0), [
    sections, kind, offeredKinds, query, showSearch, offeredFilters, filters, historical, offersHistorical, superseded, state.current,
  ])
  const visibleModels = useMemo(() => filteredSections.flatMap(section => section.models.map(model => ({
    provider: section.provider, model: model.id,
  }))), [filteredSections])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const currentRoute = currentChoice?.section.route
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? state.retainedEffort
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const { pending } = state
  const busy = pending !== null
  // Recent selections other than the one in use, resolved against the loaded
  // catalog; entries whose model is no longer listed are skipped. An effort
  // equal to the model's default is shown as the bare model name.
  const recentChoices = useMemo<readonly RecentChoice[]>(() => {
    const current = state.current === null
      ? undefined
      : {
        provider: state.current.provider,
        model: state.current.model,
        ...effectiveEffort === undefined ? {} : { reasoningEffort: effectiveEffort },
      }
    const rows: RecentChoice[] = []
    for (const entry of state.recent) {
      if (rows.length === RECENT_SHOWN) break
      if (current !== undefined && sameSelection(entry, current)) continue
      const choice = choices.find(c => c.selection.provider === entry.provider && c.selection.model === entry.model)
      if (choice === undefined) continue
      const effort = choice.model.reasoning?.efforts.find(level => level.id === entry.reasoningEffort)
      const shownEffort = effort !== undefined && effort.id !== choice.model.reasoning?.defaultEffort ? effort : undefined
      const key = `${entry.provider}/${entry.model}/${effort?.id ?? ''}`
      // A changed effort list can leave two entries naming the same row.
      if (rows.some(row => row.key === key)) continue
      rows.push({
        key,
        route: choice.section.route,
        label: shownEffort === undefined
          ? choice.model.name
          : t('recent.label', { model: choice.model.name, effort: shownEffort.name }),
        selection: { provider: entry.provider, model: entry.model, ...effort === undefined ? {} : { reasoningEffort: effort.id } },
      })
    }
    return rows
  }, [state.recent, state.current, effectiveEffort, choices, t])

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  // Pane switches unmount the focused row; restore focus inside the menu so
  // keyboard navigation remains available.
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  const previousShowSearch = useRef(showSearch)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousShowSearch.current = showSearch
    const intent = paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null)
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model' && showSearch) {
        searchRef.current?.focus()
        return
      }
      // The checked row is the value in use; a pane without one opens on its
      // first row.
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? itemRefs.current.find(item => item !== null && !item.disabled)
      // Rows a selection in flight disabled cannot take the keyboard; the
      // trigger does, so the card's keys still reach the menu.
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredSections])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      itemRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because pane switches and async catalog loads resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state, query])
  /* jscpd:ignore-end */

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    if (state.current === null) paneFocus.current = 'drill'
    setPane(state.current === null ? 'model' : 'root')
    setOpen(true)
    reload()
  }

  /** Show only one access kind, or every kind again when it is the one shown. */
  const toggleKind = (next: ModelRoute): void => {
    setKind(shown => shown === next ? null : next)
    setHighlightedIndex(null)
  }

  /** Toggle one capability filter; the highlight returns to the current model or the first row. */
  const toggleFilter = (filter: ModelFilter): void => {
    setFilters((current) => {
      const next = new Set(current)
      if (!next.delete(filter)) next.add(filter)
      return next
    })
    setHighlightedIndex(null)
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }

  const drill = (next: Pane): void => {
    setQuery('')
    setHighlightedIndex(null)
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root' && state.current !== null) back(pane)
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && state.current !== null) back(pane)
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      closeAfterSelection()
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  let modelIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        {currentRoute !== undefined && <RouteIcon route={currentRoute} className={css.triggerRoute} />}
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role={pane === 'model' ? 'group' : 'menu'}
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>
                  {currentRoute !== undefined && <RouteIcon route={currentRoute} className={css.cellRoute} />}
                  {modelLabel}
                </span>
                <IconChevronRightOutlineRegular className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
              )}
              {recentChoices.length > 0 && (
                <>
                  <div className={css.recentDivider} role="separator" />
                  <div role="group" aria-label={t('recent.aria')}>
                    {recentChoices.map(row => (
                      <button
                        ref={itemRef()}
                        type="button"
                        role="menuitem"
                        className={clsx(css.option, css.recent)}
                        key={row.key}
                        title={row.label}
                        disabled={busy}
                        onClick={() => { submit(row.selection) }}
                      >
                        <RouteIcon route={row.route} className={css.recentRoute} />
                        <span className={css.optionCopy}><span className={css.modelName}>{row.label}</span></span>
                        <span className={css.check}>
                          {pending !== null && sameSelection(pending, row.selection) ? <StateDot state="ongoing" /> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {showSearch && <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== '' && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                  placeholder={t('search.placeholder')}
                  value={query}
                  readOnly={busy}
                  onChange={(event) => { changeQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    disabled={busy}
                    onClick={() => {
                      changeQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>}
              {(offeredKinds.length > 0 || offeredFilters.length > 0 || offersHistorical) && (
                <div className={css.filters} role="toolbar" aria-label={t('filter.aria')}>
                  {offeredKinds.map(route => (
                    <FilterToggle
                      key={route}
                      label={t(ROUTE_LABEL[route])}
                      pressed={kind === route}
                      disabled={busy}
                      onToggle={() => { toggleKind(route) }}
                    >
                      <RouteIcon route={route} />
                    </FilterToggle>
                  ))}
                  {offeredKinds.length > 0 && offeredFilters.length > 0 && <span className={css.filterGap} aria-hidden="true" />}
                  {offeredFilters.map(filter => (
                    <FilterToggle
                      key={filter}
                      label={t(FILTER_LABEL[filter])}
                      pressed={filters.has(filter)}
                      disabled={busy}
                      onToggle={() => { toggleFilter(filter) }}
                    >
                      <FilterIcon filter={filter} />
                    </FilterToggle>
                  ))}
                  {offersHistorical && (
                    <FilterToggle
                      label={t('filter.historical')}
                      pressed={historical}
                      disabled={busy}
                      className={css.historical}
                      onToggle={() => {
                        setHistorical(shown => !shown)
                        setHighlightedIndex(null)
                      }}
                    >
                      <IconClockOutlineRegular size={14} />
                    </FilterToggle>
                  )}
                </div>
              )}
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div
                ref={groupsRef}
                id={`${id}-models`}
                className={clsx(css.groups, 'scrollable')}
                role="menu"
                aria-label={t('menu.model')}
                hidden={filteredSections.length === 0}
              >
                {filteredSections.map(section => (
                  <MenuGroup key={section.key} label={section.title} icon={<RouteIcon route={section.route} className={css.sectionIcon} />}>
                    {section.models.map((model) => {
                      const index = modelIndex++
                      const selected = state.current?.provider === section.provider && state.current.model === model.id
                      return (
                        <button
                          ref={itemRef()}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          id={`${id}-model-${index}`}
                          tabIndex={showSearch ? -1 : 0}
                          onFocus={() => { setHighlightedIndex(index) }}
                          data-highlighted={index === activeModelIndex ? '' : undefined}
                          className={clsx(
                            css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
                          )}
                          onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                            if (showSearch) setHighlightedIndex(index)
                            else itemRefs.current[index]?.focus()
                          }}
                          key={model.id}
                          title={model.name}
                          disabled={busy}
                          onClick={() => { choose({ provider: section.provider, model: model.id }) }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.modelName}>{model.name}</span>
                          </span>
                          <span className={css.check}>
                            {pending?.provider === section.provider && pending.model === model.id
                              ? <StateDot state="ongoing" />
                              : selected ? <IconCheckOutlineRegular /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </MenuGroup>
                ))}
              </div>
              {state.status === 'ready' && filteredSections.length === 0 && (
                <div className={css.empty} role="status">{t(choices.length === 0 ? 'empty.models' : 'search.empty')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {pending !== null && pending.provider === state.current?.provider
                        && pending.model === state.current.model && pending.reasoningEffort === level.effort
                        ? <StateDot state="ongoing" />
                        : effectiveEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
