/**
 * Historical prompt actions after their inline confirmation: edit and an
 * unqueued replay return the prompt to the draft, a refused rewind touches
 * nothing, and the visible history is left to the Host's trim frame.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRewindValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { createUserRewindActions, promptText } from '../src/client/chat/rewind.ts'

const value = (over: Partial<SessionRewindValue> = {}): SessionRewindValue => ({
  sessionId: SessionId('s'), action: 'edit', content: [{ type: 'text', text: 'hi' }], attachments: [], ...over,
})

function harness(options: { result?: SessionRewindValue | Error; restore?: Error } = {}) {
  const calls: string[] = []
  const dependencies = {
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

  it('restores the prompt text without its attachment blocks', () => {
    expect(promptText([{ type: 'text', text: 'a' }, { type: 'image' } as never, { type: 'text', text: 'b' }])).toBe('ab')
  })
})
