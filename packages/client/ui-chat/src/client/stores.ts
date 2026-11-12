/** Per-Session Chat view store. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ChatStoreState, TurnDisclosureEntry, TurnProcessViewEntry } from './contract/store.ts'
import type { TurnProcessSpec } from './contract/turn-process.ts'

type ChatActions = {
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    answerStep: number,
    open: boolean,
  ) => void
  setTurnDisclosure: (draft: ChatStoreState, turn: number, open: boolean) => void
}

/**
 * Read the whole-Turn disclosure choice of one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's latest choice, when one is in effect.
 */
export function turnDisclosure(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnDisclosureEntry> | undefined {
  return state.turnDisclosures.find(entry => entry.turn === turn)
}

/**
 * Resolve the manual disclosure choice for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

/**
 * Whether a foldable Turn's process is open: the reader's choice for the current answer generation
 * wins; otherwise the latest completed Turn stays open until the next input, and older Turns fold.
 * @param state - Chat store snapshot.
 * @param spec - the Turn's process specification.
 * @param defaultOpen - whether this Turn is exempt from automatic folding.
 * @returns the effective open state.
 */
export function turnProcessOpen(
  state: Readonly<ChatStoreState>,
  spec: Pick<TurnProcessSpec, 'turn' | 'answerStep'>,
  defaultOpen: boolean,
): boolean {
  const stored = storedTurnProcessEntry(state, spec.turn)
  if (stored === undefined || stored.answerStep !== (spec.answerStep ?? 0)) return defaultOpen
  return stored.collapsed !== true
}

/**
 * Create the Chat view store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    init: (): ChatStoreState => ({ turnProcesses: [], turnDisclosures: [], disclosureGeneration: 0 }),
    actions: {
      setTurnProcessOpen: (draft, turn, answerStep, open) => {
        const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
        const next = (open ? { turn, answerStep } : { turn, answerStep, collapsed: true }) satisfies TurnProcessViewEntry
        if (index < 0) draft.turnProcesses.push(next)
        else draft.turnProcesses[index] = next
        // Folding a Turn ends its whole-Turn choice, so reopening it shows each disclosure's default again.
        if (!open) draft.turnDisclosures = draft.turnDisclosures.filter(entry => entry.turn !== turn)
      },
      setTurnDisclosure: (draft, turn, open) => {
        draft.disclosureGeneration += 1
        const next = { turn, open, generation: draft.disclosureGeneration } satisfies TurnDisclosureEntry
        const index = draft.turnDisclosures.findIndex(entry => entry.turn === turn)
        if (index < 0) draft.turnDisclosures.push(next)
        else draft.turnDisclosures[index] = next
      },
    },
  })
}
