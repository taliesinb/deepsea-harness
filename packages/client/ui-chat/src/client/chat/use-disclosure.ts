/** Bind independent disclosure state to a Chat seat's reset source and its Turn's whole-Turn choice. */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DisclosureToggleEvent, TurnDisclosureBinding, UseDisclosure } from '../contract/slots.ts'

const NO_TURN: TurnDisclosureBinding = { choice: undefined }
const NO_TURN_SOURCE: ObservableSnapshot<TurnDisclosureBinding> = { getSnapshot: () => NO_TURN, subscribe: () => () => undefined }

/**
 * Own one disclosure. Its own toggle wins until the reset generation advances or a newer
 * whole-Turn choice arrives; without either, it shows `defaultOpen`. Option-click (an
 * `altKey` toggle) applies the toggled state to the whole Turn instead.
 * @param defaultOpen - the state shown before the reader chooses.
 * @param version - reset generation; unchanged generations retain local open state.
 * @param turn - the Turn's whole-Turn choice and how to make one.
 * @returns the open state, an explicit setter, and a toggle action.
 */
export function useDisclosure(
  defaultOpen = false,
  version = 0,
  turn: TurnDisclosureBinding = NO_TURN,
): ReturnType<UseDisclosure> {
  const [own, setOwn] = useState<{ version: number; generation: number; open: boolean } | null>(null)
  const generation = turn.choice?.generation ?? 0
  const expanded = own !== null && own.version === version && own.generation === generation
    ? own.open
    : turn.choice?.open ?? defaultOpen
  const setExpanded = useCallback((open: boolean) => {
    setOwn({ version, generation, open })
  }, [version, generation])
  const { applyToTurn } = turn
  const toggle = useCallback((event?: DisclosureToggleEvent) => {
    if (event?.altKey === true && applyToTurn !== undefined) applyToTurn(!expanded)
    else setOwn({ version, generation, open: !expanded })
  }, [applyToTurn, expanded, generation, version])
  return { expanded, setExpanded, toggle }
}

/**
 * Bind a Hook without subscribing until a component calls it.
 * @param reset - stable source whose version advances when the seat is hidden by its Turn.
 * @param turn - stable source of the seat's Turn binding; without one, Option-click toggles only the disclosure itself.
 * @returns a Hook with independent open state for each invocation.
 */
export function bindDisclosure(
  reset: ObservableSnapshot<number>,
  turn: ObservableSnapshot<TurnDisclosureBinding> = NO_TURN_SOURCE,
): UseDisclosure {
  const subscribeReset = (listener: () => void) => reset.subscribe(listener)
  const getReset = () => reset.getSnapshot()
  const subscribeTurn = (listener: () => void) => turn.subscribe(listener)
  const getTurn = () => turn.getSnapshot()
  return function useBoundDisclosure(defaultOpen = false) {
    const version = useSyncExternalStore(subscribeReset, getReset)
    const binding = useSyncExternalStore(subscribeTurn, getTurn)
    return useDisclosure(defaultOpen, version, binding)
  }
}
