import { describe, expect, it } from 'vitest'
import { createChatStore, storedTurnProcessEntry, turnDisclosure, turnProcessOpen } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('stores manual expansion and collapse for the current answer generation', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 3 }])

    store.actions.setTurnProcessOpen(2, 4, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4 }])

    store.actions.setTurnProcessOpen(2, 4, false)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4, collapsed: true }])
    store.actions.setTurnProcessOpen(2, 4, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4 }])
  })

  it('closes only the requested Turn-process entry', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    store.actions.setTurnProcessOpen(3, 4, true)

    store.actions.setTurnProcessOpen(2, 3, false)
    store.actions.setTurnProcessOpen(9, 10, false)

    expect(store.store.getSnapshot().turnProcesses).toEqual([
      { turn: 2, answerStep: 3, collapsed: true },
      { turn: 3, answerStep: 4 },
      { turn: 9, answerStep: 10, collapsed: true },
    ])
  })

  it.each([false, true])('uses the default %s only without a matching manual answer choice', (defaultOpen) => {
    const store = createChatStore().create()
    const spec = { turn: 2, answerStep: 3 }
    const open = () => turnProcessOpen(store.store.getSnapshot(), spec, defaultOpen)
    expect(storedTurnProcessEntry(store.store.getSnapshot(), 2)).toBeUndefined()
    expect(open()).toBe(defaultOpen)
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(open()).toBe(true)
    store.actions.setTurnProcessOpen(2, 3, false)
    expect(open()).toBe(false)
    expect(turnProcessOpen(store.store.getSnapshot(), { turn: 2, answerStep: 4 }, defaultOpen)).toBe(defaultOpen)
    expect(turnProcessOpen(store.store.getSnapshot(), { turn: 3, answerStep: 3 }, defaultOpen)).toBe(defaultOpen)
  })

  it('orders whole-Turn disclosure choices and ends a Turn\'s choice when the Turn folds', () => {
    const store = createChatStore().create()
    const choice = (turn: number) => turnDisclosure(store.store.getSnapshot(), turn)
    store.actions.setTurnDisclosure(2, true)
    store.actions.setTurnDisclosure(3, false)
    store.actions.setTurnDisclosure(2, false)
    expect(choice(2)).toEqual({ turn: 2, open: false, generation: 3 })
    expect(choice(3)).toEqual({ turn: 3, open: false, generation: 2 })
    store.actions.setTurnProcessOpen(2, 0, true)
    expect(choice(2)).toBeDefined()
    store.actions.setTurnProcessOpen(2, 0, false)
    expect(choice(2)).toBeUndefined()
    expect(choice(3)).toBeDefined()
  })
})
