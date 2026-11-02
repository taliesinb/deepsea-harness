/**
 * Recently chosen model selections: one list shared by every Session's
 * directory and persisted in this browser profile's localStorage. Entries hold
 * the effective reasoning effort (an omitted effort resolves to the model's
 * catalog default when the selection is recorded), so a selection made with
 * and without an explicit default effort is one entry.
 */
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** localStorage name of the persisted list. */
const PERSIST_NAME = 'dsh.model-selection.recent.v1'

/** Entries kept; more than the menu shows so the current and uncatalogued entries can be skipped. */
const RETAINED = 8

/** Recent selections, most recent first. */
export type RecentModelList = readonly ModelSelection[]

/**
 * The recent-selection list. Values read back from localStorage are filtered
 * to well-formed entries before first use.
 */
export class RecentModels {
  /** Most recent first; updates notify every Session's directory. */
  readonly store: SnapshotStore<RecentModelList> = createSnapshotStore<RecentModelList>([], { persist: { name: PERSIST_NAME } })

  /** Read the persisted list back, dropping malformed entries. */
  constructor() {
    const stored: unknown = this.store.getSnapshot()
    const valid = Array.isArray(stored) ? stored.filter(isSelection).slice(0, RETAINED) : []
    if (!Array.isArray(stored) || valid.length !== stored.length) this.store.set(valid)
  }

  /**
   * Move selections to the front of the list, the first argument ending up first.
   * @param groups - the loaded catalog, which resolves an omitted effort to the model's default.
   * @param selections - the selections to record, most recent first; `null` entries are skipped.
   */
  record(groups: readonly ModelProviderGroup[], ...selections: readonly (ModelSelection | null)[]): void {
    const entries = selections.filter(value => value !== null).map(value => effective(groups, value))
    const next: ModelSelection[] = []
    for (const entry of [...entries, ...this.store.getSnapshot()]) {
      if (next.length === RETAINED) break
      if (!next.some(kept => sameSelection(kept, entry))) next.push(entry)
    }
    this.store.set(next)
  }
}

/**
 * Whether two effective selections name the same provider, model and effort.
 * @param a - one selection.
 * @param b - the other selection.
 * @returns true when all three fields match.
 */
export function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** A selection with an omitted effort resolved to its model's catalog default. */
function effective(groups: readonly ModelProviderGroup[], selection: ModelSelection): ModelSelection {
  const reasoningEffort = selection.reasoningEffort
    ?? groups.find(group => group.id === selection.provider)
      ?.models.find(model => model.id === selection.model)?.reasoning?.defaultEffort
  return {
    provider: selection.provider,
    model: selection.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/** Whether a persisted value is a well-formed selection. */
function isSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null) return false
  const { provider, model, reasoningEffort } = value as Partial<Record<keyof ModelSelection, unknown>>
  return typeof provider === 'string' && typeof model === 'string'
    && (reasoningEffort === undefined || typeof reasoningEffort === 'string')
}
