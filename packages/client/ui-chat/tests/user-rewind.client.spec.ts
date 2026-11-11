/**
 * Historical prompt actions after their inline confirmation: edit and an
 * unqueued replay return the prompt to the draft, a refused rewind touches
 * nothing, and the visible history is left to the Host's trim frame.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRewindValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createUserRewindActions, discardsLaterWork, promptText } from '../src/client/chat/rewind.ts'

const value = (over: Partial<SessionRewindValue> = {}): SessionRewindValue => ({
  sessionId: SessionId('s'), action: 'edit', content: [{ type: 'text', text: 'hi' }], attachments: [], ...over,
})

/** One window entry; only `seq`, `type` and a user message's source matter to the rule. */
function entry(seq: number, type: string, data: unknown = {}): SessionEventLikeEntry {
  return { type: 'event', event: { seq, time: seq, type, data } } as SessionEventLikeEntry
}

/** A prompt at seq 1 whose turn ended in an API error after one failed attempt. */
const FAILED_TURN = [
  entry(0, 'turn/start', { turn: 1 }),
  entry(1, 'user/message', { source: { kind: 'user' } }),
  entry(2, 'step/start', { turn: 1, step: 1 }),
  entry(3, 'assistant/attempt', { turn: 1, step: 1, stream: [] }),
  entry(4, 'step/end', { turn: 1, step: 1 }),
  entry(5, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: '503', code: 'SERVER_ERROR' } } }),
]

function harness(options: {
  result?: SessionRewindValue | Error
  restore?: Error
  events?: readonly SessionEventLikeEntry[]
} = {}) {
  const calls: string[] = []
  const dependencies = {
    events: () => options.events,
    rewind: vi.fn(() => {
      calls.push('rewind')
      return options.result instanceof Error ? Promise.reject(options.result) : Promise.resolve(options.result ?? value())
    }),
    restore: vi.fn(() => {
      calls.push('restore')
      return options.restore === undefined ? Promise.resolve() : Promise.reject(options.restore)
    }),
    notify: vi.fn((key: string) => { calls.push(`notify:${key}`) }),
  }
  return { calls, dependencies, actions: createUserRewindActions(dependencies) }
}

describe('historical prompt rewind actions', () => {
  it('restores an edited prompt to the composer', async () => {
    const h = harness()
    await h.actions.onRewind(3, 'edit')
    expect(h.dependencies.rewind).toHaveBeenCalledWith(3, 'edit')
    expect(h.calls).toEqual(['rewind', 'restore', 'notify:message.rewind.editDone'])
  })

  it('returns an unqueued replay to the draft and reports it', async () => {
    const h = harness({ result: value({ action: 'replay', replayed: false }) })
    await h.actions.onRewind(3, 'replay')
    expect(h.calls).toEqual(['rewind', 'restore', 'notify:message.rewind.replayFailed'])
    const sent = harness({ result: value({ action: 'replay', replayed: true }) })
    await sent.actions.onRewind(3, 'replay')
    expect(sent.calls).toEqual(['rewind', 'notify:message.rewind.replayDone'])
  })

  it('reports a refused rewind without touching the draft, and a failed restore after a committed one', async () => {
    const refused = harness({ result: new Error('busy') })
    await refused.actions.onRewind(3, 'edit')
    expect(refused.calls).toEqual(['rewind', 'notify:message.rewind.failed'])
    const unrestored = harness({ restore: new Error('scope gone') })
    await unrestored.actions.onRewind(3, 'edit')
    expect(unrestored.calls).toEqual(['rewind', 'restore', 'notify:message.rewind.restoreFailed'])
  })

  it('ignores a second gesture while one is pending', async () => {
    const h = harness()
    await Promise.all([h.actions.onRewind(1, 'delete'), h.actions.onRewind(2, 'delete')])
    expect(h.dependencies.rewind).toHaveBeenCalledTimes(1)
  })

  it('asks first only when a rewind discards later work, and always before a delete', () => {
    expect(discardsLaterWork(FAILED_TURN, 1)).toBe(false)
    expect(discardsLaterWork([...FAILED_TURN, entry(6, 'user/message', { source: { kind: 'injected' } })], 1)).toBe(false)
    for (const later of [
      entry(6, 'user/message', { source: { kind: 'user' } }),
      entry(6, 'assistant/message', {}),
      entry(6, 'tool/call', {}),
    ]) expect(discardsLaterWork([...FAILED_TURN, later], 1)).toBe(true)
    // Events before the prompt never count.
    expect(discardsLaterWork([entry(0, 'assistant/message'), ...FAILED_TURN.slice(1)], 1)).toBe(false)

    const failed = harness({ events: FAILED_TURN }).actions
    expect([failed.needsConfirmation(1, 'replay'), failed.needsConfirmation(1, 'edit'), failed.needsConfirmation(1, 'delete')])
      .toEqual([false, false, true])
    // Without a loaded window nothing is known, so it asks.
    expect(harness().actions.needsConfirmation(1, 'replay')).toBe(true)
  })

  it('restores the prompt text without its attachment blocks', () => {
    expect(promptText([{ type: 'text', text: 'a' }, { type: 'image' } as never, { type: 'text', text: 'b' }])).toBe('ab')
  })
})
