/**
 * SessionMoveController over a real JSONL backend and a real Workspace
 * registry: the relocation notice, registry re-accounting, subagent
 * descendants following their root, the live-Agent policy, and the moveMany
 * skip report.
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
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ApiSessionAgentController } from '../src/agent.ts'
import type { ApiSessionList } from '../src/list.ts'
import { SESSION_MOVE_NOTICE_SOURCE, SessionMoveController, sessionMoveNoticeText } from '../src/move.ts'

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
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-')))
  dirs.push(home)
  const paths = { a: join(home, 'alpha'), b: join(home, 'beta'), c: join(home, 'gamma') }
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
  ctx.provide('agents', { get: (id: SessionId) => live.get(id), list: () => [...live.values()] } as never)
  ctx.provide('sessions', { get: (id: SessionId) => live.get(id), list: () => [] } as never)
  await ctx.plugin(WorkspaceRegistry)
  const a = await ctx.workspaceRegistry.create(paths.a, 'Alpha')
  const b = await ctx.workspaceRegistry.create(paths.b, 'Beta')
  const c = await ctx.workspaceRegistry.create(paths.c, 'Gamma')
  const emitted: SessionHeader[] = []
  const summarizeCold = vi.fn((header: SessionHeader) => {
    emitted.push(header)
    return { sessionId: header.id, updatedAt: header.createdAt, agentAvailable: false, running: false, blank: false }
  })
  const retire = vi.fn(async (id: SessionId) => live.delete(id))
  const controller = new SessionMoveController(
    ctx,
    { retire } as Pick<ApiSessionAgentController, 'retire'> as ApiSessionAgentController,
    { summarizeCold } as Pick<ApiSessionList, 'summarizeCold'> as ApiSessionList,
  )
  return { ctx, home, paths, a, b, c, live, retire, controller, emitted }
}

function header(id: string, cwd: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd, ...extra }
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: SessionSeq(1), time: 1, data: createUserMessage({
    content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
  }), surfaceOp: 'append' },
  { type: 'sandbox/mode', seq: SessionSeq(2), time: 1, data: { mode: 'workspace-write' } },
  { type: 'turn/end', seq: SessionSeq(3), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

async function store(ctx: Context, meta: SessionHeader, workspace?: Workspace): Promise<void> {
  const handle = await ctx.sessionPersistence.create(meta)
  await handle.append(EVENTS)
  await handle.close()
  await workspace?.attachSession(meta.id)
}

async function pendingNextStep(ctx: Context, id: string): Promise<{ kind: string; text: string }[]> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
  try {
    const { events } = await handle.read()
    let pending: { kind: string; text: string }[] = []
    for (const event of events) {
      if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-step') continue
      const inserted = event.data.inserted.map(message => ({
        kind: message.source.kind,
        text: message.content[0]?.type === 'text' ? message.content[0].text : '',
      }))
      pending = pending.toSpliced(event.data.start, event.data.removedCount ?? 0, ...inserted)
    }
    return pending
  } finally {
    await handle.close()
  }
}

describe('SessionMoveController', () => {
  it('moves a cold session, re-accounts it, notifies with the permission clause, and refreshes its row', async () => {
    const { ctx, paths, a, b, controller, emitted } = await harness()
    await store(ctx, header('s1', paths.a), a)
    const result = await controller.move({ sessionId: SessionId('s1'), destination: { workspaceId: b.id } })
    expect(result).toEqual({ sessionId: 's1', workspaceId: b.id, moved: ['s1'] })
    expect(a.sessionIds).toEqual([])
    expect(b.sessionIds).toEqual(['s1'])
    expect((await ctx.sessionPersistence.stat(SessionId('s1')))?.header.cwd).toBe(paths.b)
    const pending = await pendingNextStep(ctx, 's1')
    expect(pending).toEqual([{
      kind: SESSION_MOVE_NOTICE_SOURCE,
      text: sessionMoveNoticeText({ title: 'Alpha', path: paths.a }, { title: 'Beta', path: paths.b }, 'workspace-write'),
    }])
    expect(pending[0]?.text).toContain('`Workspace Write`')
    expect(emitted.map(meta => [meta.id, meta.cwd])).toEqual([['s1', paths.b]])
  })

  it('replaces the pending notice on a second move before the Agent runs, keeping the original origin', async () => {
    const { ctx, paths, a, b, c, controller } = await harness()
    await store(ctx, header('s3', paths.a), a)
    await controller.move({ sessionId: SessionId('s3'), destination: { workspaceId: b.id } })
    await controller.move({ sessionId: SessionId('s3'), destination: { workspaceId: c.id } })
    const pending = await pendingNextStep(ctx, 's3')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.text).toContain(`from \`Alpha\` (${paths.a}) to \`Gamma\` (${paths.c})`)
    expect(c.sessionIds).toEqual(['s3'])
    expect(b.sessionIds).toEqual([])
  })

  it('omits the notice on request, refuses the same workspace, and reports unknown destinations and sessions', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('quiet', paths.a), a)
    await controller.move({ sessionId: SessionId('quiet'), destination: { workspaceId: b.id }, notify: false })
    expect(await pendingNextStep(ctx, 'quiet')).toEqual([])
    await expect(controller.move({ sessionId: SessionId('quiet'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/move-same-workspace' })
    await expect(controller.move({ sessionId: SessionId('nope'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/move-missing' })
    await expect(controller.move({ sessionId: SessionId('quiet'), destination: { workspaceId: 'missing' as Workspace['id'] } }))
      .rejects.toBeInstanceOf(RemoteError)
  })

  it('registers a directory destination and attaches a session stored there without an account', async () => {
    const { ctx, home, paths, a, controller } = await harness()
    const fresh = join(home, 'fresh')
    await mkdir(fresh)
    await store(ctx, header('s2', paths.a), a)
    const moved = await controller.move({ sessionId: SessionId('s2'), destination: { path: fresh } })
    expect(ctx.workspaceRegistry.get(moved.workspaceId)?.sessionIds).toEqual(['s2'])
    await store(ctx, header('stray', paths.a))
    expect(await controller.move({ sessionId: SessionId('stray'), destination: { workspaceId: a.id } }))
      .toEqual({ sessionId: 'stray', workspaceId: a.id, moved: ['stray'] })
    expect(a.sessionIds).toEqual(['stray'])
    await expect(controller.move({ sessionId: SessionId('s2'), destination: { path: join(home, 'absent') } }))
      .rejects.toMatchObject({ code: 'workspace/create-failed' })
  })

  it('moves same-cwd subagent descendants with their root', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('root', paths.a), a)
    await store(ctx, header('child', paths.a, { origin: 'subagent', parentSession: SessionId('root'), delegationDepth: 1 }))
    await store(ctx, header('grandchild', paths.a, { origin: 'subagent', parentSession: SessionId('child'), delegationDepth: 2 }))
    const result = await controller.move({ sessionId: SessionId('root'), destination: { workspaceId: b.id } })
    expect(result.moved).toEqual(['child', 'grandchild', 'root'])
    for (const id of ['root', 'child', 'grandchild']) {
      expect((await ctx.sessionPersistence.stat(SessionId(id)))?.header.cwd).toBe(paths.b)
    }
    expect(b.sessionIds).toEqual(['root'])
  })

  it('retires an idle resident agent silently and refuses a running one until stopLive; moveMany reports skips', async () => {
    const { ctx, paths, a, b, live, retire, controller } = await harness()
    await store(ctx, header('idle', paths.a), a)
    await store(ctx, header('running', paths.a), a)
    await store(ctx, header('cold', paths.a), a)
    live.set(SessionId('idle'), { id: SessionId('idle'), status: 'idle' })
    live.set(SessionId('running'), { id: SessionId('running'), status: 'running' })

    const batch = await controller.moveMany({
      sessionIds: [SessionId('idle'), SessionId('running'), SessionId('cold')],
      destination: { workspaceId: b.id },
    })
    expect(batch.moved).toEqual(['idle', 'cold'])
    expect(batch.skipped).toEqual([expect.objectContaining({ sessionId: 'running', reason: 'live' })])
    expect(retire).toHaveBeenCalledWith('idle')
    await expect(controller.move({ sessionId: SessionId('running'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/move-live', details: { sessionId: 'running' } })
    expect(await controller.move({ sessionId: SessionId('running'), destination: { workspaceId: b.id }, stopLive: true }))
      .toMatchObject({ moved: ['running'] })
    expect(b.sessionIds.toSorted()).toEqual(['cold', 'idle', 'running'])
  })

  it('leaves a session whose resident Agent another owner holds', async () => {
    const { ctx, paths, a, b, live, retire, controller } = await harness()
    await store(ctx, header('owned', paths.a), a)
    live.set(SessionId('owned'), { id: SessionId('owned'), status: 'idle' })
    retire.mockResolvedValueOnce(false)
    await expect(controller.move({ sessionId: SessionId('owned'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/move-live' })
    expect(a.sessionIds).toEqual(['owned'])
  })
})
