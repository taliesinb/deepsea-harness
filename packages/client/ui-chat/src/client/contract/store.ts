/** Chat-owned per-Session view state. */

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/** One manual whole-Turn disclosure choice for a Turn answer generation. */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly answerStep: number
  /** Explicitly collapsed; absent means explicitly opened. */
  readonly collapsed?: true
}

/**
 * One whole-Turn disclosure choice, made by Option-clicking a disclosure in the Turn: every disclosure
 * of the Turn shows `open` until the reader toggles it again or the Turn folds.
 */
export interface TurnDisclosureEntry {
  readonly turn: number
  readonly open: boolean
  /** Store-wide order of the choice; a disclosure's own later toggle wins over an older choice. */
  readonly generation: number
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[]
  turnDisclosures: TurnDisclosureEntry[]
  /** Generation of the latest whole-Turn disclosure choice. */
  disclosureGeneration: number
}
