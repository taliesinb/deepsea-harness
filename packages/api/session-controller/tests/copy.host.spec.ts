/**
 * SessionCopyController over a real JSONL backend and a real Workspace
 * registry: a cold copy into another (or the same) Workspace with a fresh id,
 * title and copy notice, the source untouched; subagent descendants copied
 * along; a running source refused until the caller decides `truncate`, then
 * dropped whole or closed as interrupted; an idle resident Agent asks nothing.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { SessionCopyController } from '../src/copy.ts'
import { SESSION_COPY_NOTICE_SOURCE } from '../src/import.ts'
import { shapeCopiedLog } from '../src/shape.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface FakeAgent {
  readonly id: SessionId
  status: 'idle' | 'running'
}

async function harness() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-copy-')))
  dirs.push(home)
  const paths = { a: join(home, 'alpha'), b: join(home, 'beta') }
  for (const path of Object.values(paths)) await mkdir(path)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(
    { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root: join(home, 'storage') },
  )
  await ctx.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression: 'none' })
  const live = new Map<SessionId, FakeAgent>()
  const flush = vi.fn(() => Promise.resolve(true))
  ctx.provide('agents', { get: (id: SessionId) => live.get(id), list: () => [...live.values()] } as never)
  ctx.provide('sessions', { get: (id: SessionId) => live.get(id), list: () => [], flush } as never)
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const rest = await next()
    return live.get(sessionId)?.status === 'running' ? [{ kind: 'turn' }, ...rest] : rest
  })
  await ctx.plugin(WorkspaceRegistry)
  const a = await ctx.workspaceRegistry.create(paths.a, 'Alpha')
  const b = await ctx.workspaceRegistry.create(paths.b, 'Beta')
  return { ctx, paths, a, b, live, flush, controller: new SessionCopyController(ctx) }
}

function header(id: string, cwd: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd, ...extra }
}

async function store(ctx: Context, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await ctx.sessionPersistence.create(meta)
  if (events.length > 0) await handle.append([...events])
  await handle.close()
}

async function readEvents(ctx: Context, id: string): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const DONE: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: SessionSeq(1), time: 1, data: prompt('work'), surfaceOp: 'append' },
  { type: 'session/title', seq: SessionSeq(2), time: 1, data: { title: 'Work', messageSeqs: [], source: { kind: 'user' } } },
  { type: 'turn/end', seq: SessionSeq(3), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
const RUNNING: SessionEvent[] = [
  ...DONE,
  { type: 'agent/inbox/spliced', seq: SessionSeq(4), time: 3, data: { target: 'next-turn', start: 0, inserted: [prompt('go')] } },
  { type: 'turn/start', seq: SessionSeq(5), time: 4, data: { turn: 2 } },
  { type: 'step/start', seq: SessionSeq(6), time: 6, data: { turn: 2, step: 1 } },
]

describe('shapeCopiedLog', () => {
  it('keeps a balanced log, closes an open turn as interrupted, or drops it and cancels its queued prompt', () => {
    expect(shapeCopiedLog(DONE)).toEqual({ events: DONE, truncated: false, openTurn: false })
    const asIs = shapeCopiedLog(RUNNING)
    expect(asIs.events.slice(RUNNING.length).map(event => event.type)).toEqual(['step/end', 'turn/end'])
    expect(asIs.events.at(-1)).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
    const dropped = shapeCopiedLog(RUNNING, { truncate: true })
    expect(dropped).toMatchObject({ truncated: true, openTurn: true, cutTime: 4 })
    expect(dropped.events.map(event => event.type)).toEqual([...DONE.map(event => event.type), 'agent/inbox/spliced', 'agent/inbox/spliced'])
    expect(dropped.events.at(-1)).toMatchObject({ seq: 5, data: { target: 'next-turn', removedCount: 1, outcome: 'canceled' } })
  })
})

describe('SessionCopyController', () => {
  it('copies a cold session with a fresh id, title and notice; the source is untouched; the same workspace is allowed', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('s1', paths.a), DONE)
    await a.attachSession(SessionId('s1'))
    const result = await controller.copy({ sessionId: SessionId('s1'), destination: { workspaceId: b.id }, title: 'Work (copy)' })
    expect(result).toMatchObject({ sourceSessionId: 's1', workspaceId: b.id, truncated: false })
    expect(result.sessionId).toMatch(/^session-[0-9a-f-]{36}$/u)
    expect(result.copied).toEqual([result.sessionId])
    expect(a.sessionIds).toEqual(['s1'])
    expect(b.sessionIds).toEqual([result.sessionId])
    expect((await ctx.sessionPersistence.stat(SessionId('s1')))?.header.cwd).toBe(paths.a)
    expect((await ctx.sessionPersistence.stat(result.sessionId))?.header.cwd).toBe(paths.b)
    expect(await readEvents(ctx, 's1')).toHaveLength(DONE.length)
    const events = await readEvents(ctx, result.sessionId)
    expect(events.map(event => event.type)).toEqual([...DONE.map(event => event.type), 'session/title', 'agent/inbox/spliced'])
    expect(events[4]).toMatchObject({ data: { title: 'Work (copy)', source: { kind: 'user' } } })
    const notice = events[5]
    if (notice?.type !== 'agent/inbox/spliced') throw new Error('missing notice')
    expect(notice.data.inserted[0]?.source).toMatchObject({ kind: SESSION_COPY_NOTICE_SOURCE, sourceSessionId: 's1' })
    const text = notice.data.inserted[0]?.content[0]
    expect(text?.type === 'text' ? text.text : '').toContain(`copy of session \`s1\` from the workspace \`Alpha\` (${paths.a})`)

    const again = await controller.copy({ sessionId: SessionId('s1'), destination: { workspaceId: a.id }, notify: false })
    expect(a.sessionIds.toSorted()).toEqual([again.sessionId, 's1'].toSorted())
    expect((await readEvents(ctx, again.sessionId)).map(event => event.type)).toEqual(DONE.map(event => event.type))
  })

  it('copies subagent descendants along, re-parented to the new root; an idle resident Agent asks nothing and is flushed', async () => {
    const { ctx, paths, a, b, live, flush, controller } = await harness()
    await store(ctx, header('p', paths.a), DONE)
    await a.attachSession(SessionId('p'))
    await store(ctx, header('c', paths.a, { origin: 'subagent', parentSession: SessionId('p'), delegationDepth: 1 }), DONE)
    live.set(SessionId('p'), { id: SessionId('p'), status: 'idle' })
    const result = await controller.copy({ sessionId: SessionId('p'), destination: { workspaceId: b.id } })
    expect(result.copied).toHaveLength(2)
    expect(flush).toHaveBeenCalledTimes(1)
    const child = await ctx.sessionPersistence.stat(result.copied[1] as SessionId)
    expect(child?.header).toMatchObject({ parentSession: result.sessionId, cwd: paths.b, origin: 'subagent' })
    expect(b.sessionIds).toEqual([result.sessionId])
  })

  it('refuses a running source until truncate is decided, then drops the turn or closes it as interrupted', async () => {
    const { ctx, paths, a, b, live, controller } = await harness()
    await store(ctx, header('run', paths.a), RUNNING)
    await a.attachSession(SessionId('run'))
    live.set(SessionId('run'), { id: SessionId('run'), status: 'running' })
    await expect(controller.copy({ sessionId: SessionId('run'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/copy-live', details: { sessionId: 'run', blockers: [{ kind: 'turn' }] } })

    const dropped = await controller.copy({ sessionId: SessionId('run'), destination: { workspaceId: b.id }, truncate: true, notify: false })
    expect(dropped.truncated).toBe(true)
    const droppedEvents = await readEvents(ctx, dropped.sessionId)
    expect(droppedEvents.map(event => event.type)).toEqual([...DONE.map(event => event.type), 'agent/inbox/spliced', 'agent/inbox/spliced'])

    const kept = await controller.copy({ sessionId: SessionId('run'), destination: { workspaceId: b.id }, truncate: false, notify: false })
    expect(kept.truncated).toBe(false)
    const keptEvents = await readEvents(ctx, kept.sessionId)
    expect(keptEvents.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
    // The source is untouched by either copy.
    expect(await readEvents(ctx, 'run')).toHaveLength(RUNNING.length)
  })

  it('reports a missing source', async () => {
    const { b, controller } = await harness()
    await expect(controller.copy({ sessionId: SessionId('nope'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/copy-missing' })
  })
})
