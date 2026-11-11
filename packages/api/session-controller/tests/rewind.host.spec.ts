/**
 * Session rewind: the stored log is cut just before one human prompt, keeping
 * the same Session identity. A prompt that opened its turn removes that whole
 * turn; a steering prompt closes its turn as interrupted; pending inbox input
 * at the cut is cancelled. Busy Sessions and invalid targets are refused
 * before anything changes.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { rewindSession, shapeRewoundLog } from '../src/rewind.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const ID = SessionId('rewound')

const FIRST = prompt('first')
const SECOND = prompt('second')
const STEER = prompt('steer')
const LOG: SessionEvent[] = [
  { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1, data: { target: 'next-turn', start: 0, inserted: [FIRST] } },
  { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
  { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 1, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  { type: 'step/start', seq: SessionSeq(3), time: 1, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: SessionSeq(4), time: 1, data: FIRST, surfaceOp: 'append' },
  { type: 'step/end', seq: SessionSeq(5), time: 2, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: SessionSeq(6), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'agent/inbox/spliced', seq: SessionSeq(7), time: 3, data: { target: 'next-turn', start: 0, inserted: [SECOND] } },
  { type: 'turn/start', seq: SessionSeq(8), time: 3, data: { turn: 2 } },
  { type: 'agent/inbox/spliced', seq: SessionSeq(9), time: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  { type: 'step/start', seq: SessionSeq(10), time: 3, data: { turn: 2, step: 1 } },
  { type: 'user/message', seq: SessionSeq(11), time: 3, data: SECOND, surfaceOp: 'append' },
  { type: 'step/end', seq: SessionSeq(12), time: 4, data: { turn: 2, step: 1 } },
  { type: 'step/start', seq: SessionSeq(13), time: 4, data: { turn: 2, step: 2 } },
  { type: 'user/message', seq: SessionSeq(14), time: 4, data: STEER, surfaceOp: 'append' },
  { type: 'step/end', seq: SessionSeq(15), time: 5, data: { turn: 2, step: 2 } },
  { type: 'turn/end', seq: SessionSeq(16), time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
]

describe('shapeRewoundLog', () => {
  it('drops the whole turn a prompt opened and cancels its prompt still queued at the cut', () => {
    const shaped = shapeRewoundLog(LOG, 11, 0)
    expect(shaped?.message).toBe(SECOND)
    expect(shaped?.events.slice(0, 8)).toEqual(LOG.slice(0, 8))
    expect(shaped?.events).toHaveLength(9)
    expect(shaped?.events.at(-1)).toEqual({
      type: 'agent/inbox/spliced', seq: 8, time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    })
  })

  it('cuts the first prompt down to an empty log without inventing events', () => {
    expect(shapeRewoundLog(LOG.slice(0, 7), 4, 0)?.events).toEqual([
      { ...LOG[0], data: LOG[0]?.data },
      { type: 'agent/inbox/spliced', seq: 1, time: 1, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
    ])
  })

  it('keeps the earlier part of a turn a steering prompt joined and closes it as interrupted', () => {
    const toolResult: SessionEvent = {
      type: 'tool/result', seq: SessionSeq(13), time: 4,
      data: { turn: 2, step: 1, message: { id: 'r', role: 'tool', content: [], source: { kind: 'tool', callId: 'c' } } },
    } as never
    const steerStep: SessionEvent = { type: 'step/start', seq: SessionSeq(14), time: 4, data: { turn: 2, step: 2 } }
    const steer: SessionEvent = { type: 'user/message', seq: SessionSeq(15), time: 4, data: STEER, surfaceOp: 'append' }
    const answered: SessionEvent[] = [...LOG.slice(0, 13), toolResult, steerStep, steer]
    const shaped = shapeRewoundLog(answered, 15, 0)
    expect(shaped?.message).toBe(STEER)
    expect(shaped?.events.slice(0, 15)).toEqual(answered.slice(0, 15))
    expect(shaped?.events.slice(15).map(event => [event.type, event.seq])).toEqual([['step/end', 15], ['turn/end', 16]])
    expect(shaped?.events.at(-1)).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
  })

  it('refuses events that are not stored human prompts, and cuts into a fork-inherited prefix', () => {
    const injected = createUserMessage({ content: [{ type: 'text', text: 'ctx' }], source: { kind: 'skill-invocation' } as never })
    const withContext = LOG.map(event => event.seq === 4 ? { ...event, data: injected } as SessionEvent : event)
    expect(shapeRewoundLog(LOG, 3, 0)).toBeUndefined()
    expect(shapeRewoundLog(LOG, 99, 0)).toBeUndefined()
    expect(shapeRewoundLog(withContext, 4, 0)).toBeUndefined()
    expect(shapeRewoundLog(LOG, 11, 9)).toBeUndefined()
  })
})

async function harness(options: { busy?: boolean } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rewind-')))
  dirs.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression: 'none' })
  const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: ID, createdAt: 1, isSeeded: false, cwd: home }
  const handle = await ctx.sessionPersistence.create(meta)
  await handle.append([...LOG])
  await handle.close()
  const reserved = new Set<SessionId>()
  ctx.provide('agents', {
    reserveHistory: (id: SessionId) => {
      if (reserved.has(id)) throw new Error('already reserved')
      reserved.add(id)
      return () => { reserved.delete(id) }
    },
  } as never)
  ctx.on('workspace/session-activity', async (_request, next) => {
    const rest = await next()
    return options.busy === true ? [{ kind: 'turn' }, ...rest] : rest
  })
  const followup = vi.fn<(message: UserMessage) => void>()
  const retire = vi.fn(() => Promise.resolve(true))
  const resolveAgent = vi.fn(() => Promise.resolve({ agent: { followup } }))
  const agents = { retire, resolveAgent } as unknown as ApiSessionAgentController
  // The trim announcement runs while the reservation still holds.
  const trimmed = vi.fn((_cursor: number, _tail: readonly SessionEvent[]) => {
    expect(reserved.has(ID)).toBe(true)
    return Promise.resolve()
  })
  const hooks = { trimmed }
  const read = async (): Promise<readonly SessionEvent[]> => {
    const reader = await ctx.sessionPersistence.open(ID, 'read')
    try {
      return (await reader.read()).events
    } finally {
      await reader.close()
    }
  }
  return { ctx, agents, retire, followup, reserved, read, hooks, trimmed }
}

describe('rewindSession', () => {
  it('deletes the prompt and every later event in the stored log under the same identity', async () => {
    const h = await harness()
    const value = await rewindSession(h.ctx, h.agents, { sessionId: ID, userEventSeq: SessionSeq(11), action: 'delete' }, { kind: 'user' }, h.hooks)
    expect(value).toEqual({ sessionId: ID, action: 'delete', content: SECOND.content, attachments: [] })
    const stored = await h.read()
    expect(stored.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(stored.some(event => event.type === 'user/message' && event.data.id === SECOND.id)).toBe(false)
    expect(h.reserved.size).toBe(0)
    expect(h.retire).toHaveBeenCalledWith(ID)
    // Seqs 0-7 are kept; the cancelling splice at seq 8 is the replaced log's tail.
    expect(h.trimmed).toHaveBeenCalledExactlyOnceWith(7, [stored[8]])
  })

  it('replays the original content as a fresh prompt after the rewind commits', async () => {
    const h = await harness()
    const value = await rewindSession(h.ctx, h.agents, { sessionId: ID, userEventSeq: SessionSeq(4), action: 'replay' }, { kind: 'user' }, h.hooks)
    expect(value).toMatchObject({ action: 'replay', replayed: true, content: FIRST.content })
    expect(await h.read()).toHaveLength(2)
    const resent = h.followup.mock.calls[0]?.[0]
    expect(resent?.content).toEqual(FIRST.content)
    expect(resent?.id).not.toBe(FIRST.id)
  })

  it('refuses a busy Session or a target that is not a human prompt without changing history', async () => {
    const busy = await harness({ busy: true })
    await expect(rewindSession(busy.ctx, busy.agents, { sessionId: ID, userEventSeq: SessionSeq(11), action: 'delete' }, { kind: 'user' }, busy.hooks))
      .rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(busy.retire).not.toHaveBeenCalled()
    expect(busy.trimmed).not.toHaveBeenCalled()
    expect(await busy.read()).toHaveLength(LOG.length)

    const idle = await harness()
    await expect(rewindSession(idle.ctx, idle.agents, { sessionId: ID, userEventSeq: SessionSeq(10), action: 'edit' }, { kind: 'user' }, idle.hooks))
      .rejects.toMatchObject({ code: 'session/rewind-invalid-target' })
    expect(await idle.read()).toHaveLength(LOG.length)
    expect(idle.reserved.size).toBe(0)
  })
})

describe('shapeRewoundLog outside a turn', () => {
  it('cuts a prompt recorded outside any turn without adding closers', () => {
    const loose: SessionEvent[] = [
      ...LOG.slice(0, 7),
      { type: 'user/message', seq: SessionSeq(7), time: 3, data: SECOND, surfaceOp: 'append' },
    ]
    expect(shapeRewoundLog(loose, 7, 0)?.events).toEqual(LOG.slice(0, 7))
  })
})

interface FakeOptions {
  readonly persistence?: Record<string, unknown>
  readonly reserve?: () => () => void
  readonly retire?: boolean
  readonly resolved?: unknown
  readonly fileUploads?: Record<string, unknown>
  readonly trimmed?: () => Promise<void>
}

/** A rewind over in-memory storage whose every collaborator can be made to fail. */
function fake(events: readonly SessionEvent[], options: FakeOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const released = vi.fn()
  const persistence = {
    stat: vi.fn(() => Promise.resolve({ revision: 'r1' })),
    open: vi.fn(() => Promise.resolve({
      inheritedEventCount: 0,
      read: () => Promise.resolve({ events }),
      close: () => Promise.resolve(),
    })),
    replace: vi.fn(() => Promise.resolve()),
    ...options.persistence,
  }
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('agents', { reserveHistory: options.reserve ?? (() => released) } as never)
  ctx.provide('fileUploads', options.fileUploads as never)
  const retire = vi.fn(() => Promise.resolve(options.retire ?? true))
  const resolveAgent = vi.fn(() => Promise.resolve(options.resolved ?? { agent: { followup: vi.fn() } }))
  const agents = { retire, resolveAgent } as unknown as ApiSessionAgentController
  const trimmed = vi.fn(options.trimmed ?? (() => Promise.resolve()))
  const run = (action: 'edit' | 'replay' | 'delete', seq = 11) =>
    rewindSession(ctx, agents, { sessionId: ID, userEventSeq: SessionSeq(seq), action }, { kind: 'user' }, { trimmed })
  return { ctx, agents, retire, resolveAgent, persistence, released, run, trimmed }
}

describe('rewindSession refusals and failures', () => {
  it('refuses a deployment whose storage cannot replace a log', async () => {
    const h = fake(LOG, { persistence: { replace: undefined } })
    await expect(h.run('delete')).rejects.toMatchObject({ code: 'session/rewind-unsupported' })
  })

  it('reports a refused reservation as busy without retiring the Agent', async () => {
    const h = fake(LOG, { reserve: () => { throw new Error('agent "rewound" has active or queued work') } })
    await expect(h.run('delete')).rejects.toMatchObject({
      code: 'session/agent-busy', message: 'Session is busy: agent "rewound" has active or queued work',
    })
    expect(h.retire).not.toHaveBeenCalled()
  })

  it('releases the reservation when the Agent belongs to another owner or the Session vanished', async () => {
    const owned = fake(LOG, { retire: false })
    await expect(owned.run('delete')).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(owned.released).toHaveBeenCalledOnce()
    const vanished = fake(LOG, { persistence: { stat: () => Promise.resolve(undefined) } })
    await expect(vanished.run('delete')).rejects.toMatchObject({ code: 'session/not-found' })
    expect(vanished.released).toHaveBeenCalledOnce()
    expect(vanished.persistence.replace).not.toHaveBeenCalled()
  })

  it.each([
    ['SessionRevisionConflictError', 'session/rewind-conflict'],
    ['SessionAlreadyOwnedError', 'session/writer-held'],
    ['Error', 'session/rewind-error'],
  ])('maps a %s from storage to %s and releases the reservation', async (name, code) => {
    const failure = Object.assign(new Error('storage refused'), { name })
    const h = fake(LOG, { persistence: { replace: () => Promise.reject(failure) } })
    await expect(h.run('delete')).rejects.toMatchObject({ code })
    expect(h.released).toHaveBeenCalledOnce()
  })

  it('stages an edited prompt\'s stored attachments again on the resumed Session without moving bytes', async () => {
    const image = { attachmentId: 'img', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
    const file = { attachmentId: 'file', name: 'notes.txt', bytes: 5 }
    const prompt = createUserMessage({
      content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: image }, { type: 'file', attachment: file }] as never,
      source: { kind: 'user' },
    })
    const log = LOG.map(event => event.seq === 11 ? { ...event, data: prompt } as SessionEvent : event)
    const agent = { followup: vi.fn() }
    const restage = vi.fn(() => ['r-img', 'r-file'])
    const h = fake(log, { resolved: { agent }, fileUploads: { restage } })
    const value = await h.run('edit')
    expect(restage).toHaveBeenCalledExactlyOnceWith(agent, [
      { type: 'image', attachment: image, encodedBytes: 3 },
      { type: 'file', attachment: file },
    ])
    expect(value.attachments).toEqual([
      { type: 'image', receiptId: 'r-img', image },
      { type: 'file', receiptId: 'r-file', file },
    ])

    // A Session that cannot be resumed or staged keeps the edit and returns its text alone.
    const unresumable = fake(log, { resolved: { error: { message: 'writer held' } }, fileUploads: { restage } })
    await expect(unresumable.run('edit')).resolves.toMatchObject({ action: 'edit', attachments: [] })
    const refused = fake(log, { fileUploads: { restage: () => { throw new Error('subagent') } } })
    await expect(refused.run('edit')).resolves.toMatchObject({ attachments: [] })
    // Edit without attachments resumes nothing.
    const plain = fake(LOG)
    await expect(plain.run('edit')).resolves.toMatchObject({ attachments: [] })
    expect(plain.resolveAgent).not.toHaveBeenCalled()
  })

  it('keeps a committed rewind when announcing the trimmed history fails', async () => {
    const h = fake(LOG, { trimmed: () => Promise.reject(new Error('projection read failed')) })
    await expect(h.run('delete')).resolves.toMatchObject({ action: 'delete' })
    expect(h.released).toHaveBeenCalledOnce()
  })

  it('reports an unqueued replay instead of failing after the rewind committed', async () => {
    const unresolved = fake(LOG, { resolved: { error: { message: 'writer held' } } })
    await expect(unresolved.run('replay')).resolves.toMatchObject({ action: 'replay', replayed: false })
    expect(unresolved.persistence.replace).toHaveBeenCalledOnce()
    const refused = fake(LOG, { resolved: { agent: { followup: () => { throw new Error('archived') } } } })
    await expect(refused.run('replay')).resolves.toMatchObject({ replayed: false })
  })
})
