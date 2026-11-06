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
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { SessionActivity, Workspace } from '@deepseek-ai/dsh-workspace'
import type { ApiSessionAgentController } from '../src/agent.ts'
import {
  describeBlockers, SESSION_MOVE_NOTICE_SOURCE, SessionMoveController, sessionMoveNoticeText, workingDirectoryReset,
} from '../src/move.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A move notice as a V3-to-V4 migration attributes it; V3 logs recorded `from` in any form. */
    'plugin:session-move': { readonly kind: 'plugin:session-move'; readonly from?: string } & ContextFormed
  }
}

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
  // Sessions resident without an Agent of their own.
  const residentSessions = new Map<SessionId, { readonly id: SessionId }>()
  const jobs = new Map<SessionId, string[]>()
  ctx.provide('agents', { get: (id: SessionId) => live.get(id), list: () => [...live.values()] } as never)
  // The activity providers the Agent and job registries install, reduced to these fakes.
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const rest = await next()
    const own: SessionActivity[] = []
    if (live.get(sessionId)?.status === 'running') own.push({ kind: 'turn' })
    const labels = jobs.get(sessionId) ?? []
    if (labels.length > 0) {
      own.push({ kind: 'job', items: labels.map((label, index) => ({ id: `bash-${String(index + 1)}`, label })) })
    }
    own.push({ kind: 'schedule', items: [{ id: 'reminder' }] })
    return [...own, ...rest]
  })
  ctx.provide('sessions', { get: (id: SessionId) => live.get(id) ?? residentSessions.get(id), list: () => [] } as never)
  await ctx.plugin(WorkspaceRegistry)
  const a = await ctx.workspaceRegistry.create(paths.a, 'Alpha')
  const b = await ctx.workspaceRegistry.create(paths.b, 'Beta')
  const c = await ctx.workspaceRegistry.create(paths.c, 'Gamma')
  const emitted: SessionHeader[] = []
  ctx.on('session-persistence/stored', (stored) => { emitted.push(stored) })
  const retire = vi.fn(async (id: SessionId) => {
    live.delete(id)
    residentSessions.delete(id)
    return true
  })
  const controller = new SessionMoveController(
    ctx,
    { retire } as Pick<ApiSessionAgentController, 'retire'> as ApiSessionAgentController,
  )
  return { ctx, home, paths, a, b, c, live, residentSessions, jobs, retire, controller, emitted }
}

function header(id: string, cwd: string | undefined, extra: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }), ...extra,
  }
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: SessionSeq(1), time: 1, data: createUserMessage({
    content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
  }), surfaceOp: 'append' },
  { type: 'sandbox/mode', seq: SessionSeq(2), time: 1, data: { mode: 'workspace-write' } },
  { type: 'turn/end', seq: SessionSeq(3), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** {@link EVENTS} without its `sandbox/mode`: a Session that never recorded its permissions. */
const UNSANDBOXED_EVENTS: SessionEvent[] = EVENTS
  .filter(event => event.type !== 'sandbox/mode')
  .map((event, index) => ({ ...event, seq: SessionSeq(index) }))

async function store(ctx: Context, meta: SessionHeader, workspace?: Workspace, events = EVENTS): Promise<void> {
  const handle = await ctx.sessionPersistence.create(meta)
  await handle.append(events)
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

  it('points a working directory outside the destination at the destination, and keeps one inside it', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    const cd = async (id: string, cwd: string): Promise<void> => {
      await store(ctx, header(id, paths.a), a)
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'write')
      await handle.append([{ type: 'working-directory/change', seq: SessionSeq(EVENTS.length), time: 3, data: { cwd } }])
      await handle.close()
    }
    const lastDirectory = async (id: string): Promise<string | undefined> => {
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
      try {
        return (await handle.read()).events.findLast(event => event.type === 'working-directory/change')?.data.cwd
      } finally {
        await handle.close()
      }
    }
    await cd('wd-out', join(paths.a, 'sub'))
    await controller.move({ sessionId: SessionId('wd-out'), destination: { workspaceId: b.id } })
    expect(await lastDirectory('wd-out')).toBe(paths.b)
    await cd('wd-in', join(paths.b, 'pkg'))
    await controller.move({ sessionId: SessionId('wd-in'), destination: { workspaceId: b.id } })
    expect(await lastDirectory('wd-in')).toBe(join(paths.b, 'pkg'))
    expect(workingDirectoryReset(undefined, paths.b)).toEqual([])
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
      .rejects.toMatchObject({ code: 'session/move-live', details: { sessionId: 'running', blockers: [{ kind: 'turn' }] } })
    expect(await controller.move({ sessionId: SessionId('running'), destination: { workspaceId: b.id }, stopLive: true }))
      .toMatchObject({ moved: ['running'] })
    expect(b.sessionIds.toSorted()).toEqual(['cold', 'idle', 'running'])
  })

  it('names the background jobs a move would kill, and moves past them with stopLive', async () => {
    const { ctx, paths, a, b, live, jobs, retire, controller } = await harness()
    await store(ctx, header('busy', paths.a), a)
    live.set(SessionId('busy'), { id: SessionId('busy'), status: 'idle' })
    jobs.set(SessionId('busy'), ['sleep 600'])
    const refusal = controller.move({ sessionId: SessionId('busy'), destination: { workspaceId: b.id } })
    await expect(refusal).rejects.toMatchObject({
      code: 'session/move-live',
      details: { blockers: [{ kind: 'job', items: [{ id: 'bash-1', label: 'sleep 600' }] }] },
    })
    await expect(refusal).rejects.toThrow('1 background job running (sleep 600)')
    expect(retire).not.toHaveBeenCalled()
    expect(await controller.move({ sessionId: SessionId('busy'), destination: { workspaceId: b.id }, stopLive: true }))
      .toMatchObject({ moved: ['busy'] })
  })

  it('leaves a session whose resident Agent another owner holds', async () => {
    const { ctx, paths, a, b, live, retire, controller } = await harness()
    await store(ctx, header('owned', paths.a), a)
    live.set(SessionId('owned'), { id: SessionId('owned'), status: 'idle' })
    retire.mockResolvedValueOnce(false)
    await expect(controller.move({ sessionId: SessionId('owned'), destination: { workspaceId: b.id } }))
      .rejects.toMatchObject({ code: 'session/move-live', details: { blockers: [] } })
    expect(a.sessionIds).toEqual(['owned'])
  })
})

describe('SessionMoveController edge Sessions', () => {
  it('names the moved-from place as "(no workspace)" for a Session stored without a cwd', async () => {
    const { ctx, paths, b, controller } = await harness()
    await store(ctx, header('homeless', undefined), undefined, UNSANDBOXED_EVENTS)
    expect(await controller.move({ sessionId: SessionId('homeless'), destination: { workspaceId: b.id } }))
      .toEqual({ sessionId: 'homeless', workspaceId: b.id, moved: ['homeless'] })
    expect(b.sessionIds).toEqual(['homeless'])
    expect(await pendingNextStep(ctx, 'homeless')).toEqual([{
      kind: SESSION_MOVE_NOTICE_SOURCE,
      text: sessionMoveNoticeText({ title: '(no workspace)', path: '(none)' }, { title: 'Beta', path: paths.b }, undefined),
    }])
  })

  it('moves a Session out of a directory that no longer exists, naming it by its basename', async () => {
    const { ctx, home, paths, b, controller } = await harness()
    const gone = join(home, 'gone')
    await mkdir(gone)
    await store(ctx, header('orphan', gone))
    await rm(gone, { recursive: true })
    expect(await controller.move({ sessionId: SessionId('orphan'), destination: { workspaceId: b.id } }))
      .toMatchObject({ moved: ['orphan'] })
    expect((await ctx.sessionPersistence.stat(SessionId('orphan')))?.header.cwd).toBe(paths.b)
    expect((await pendingNextStep(ctx, 'orphan'))[0]?.text).toContain(`from \`gone\` (${gone})`)
  })

  it('refuses to move a subagent already stored under the destination directory', async () => {
    const { ctx, paths, a, controller } = await harness()
    await store(ctx, header('stray-child', paths.a, { origin: 'subagent', parentSession: SessionId('elsewhere'), delegationDepth: 1 }))
    await expect(controller.move({ sessionId: SessionId('stray-child'), destination: { workspaceId: a.id } }))
      .rejects.toMatchObject({ code: 'session/move-same-workspace' })
    expect(a.sessionIds).toEqual([])
  })

  it('moves each Session of a batch once, even when a descendant or a repeat is listed after its root', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('batch-root', paths.a), a)
    await store(ctx, header('batch-child', paths.a, { origin: 'subagent', parentSession: SessionId('batch-root'), delegationDepth: 1 }))
    const batch = await controller.moveMany({
      sessionIds: [SessionId('batch-root'), SessionId('batch-child'), SessionId('batch-root')],
      destination: { workspaceId: b.id },
    })
    expect(batch).toEqual({ workspaceId: b.id, moved: ['batch-child', 'batch-root'], skipped: [] })
  })

  it('leaves behind a resident descendant another owner holds and retires one it can', async () => {
    const { ctx, paths, a, b, live, residentSessions, retire, controller } = await harness()
    await store(ctx, header('parent', paths.a), a)
    const child = (id: string) => header(id, paths.a, { origin: 'subagent', parentSession: SessionId('parent'), delegationDepth: 1 })
    await store(ctx, child('held-child'))
    await store(ctx, child('open-child'))
    live.set(SessionId('held-child'), { id: SessionId('held-child'), status: 'idle' })
    residentSessions.set(SessionId('open-child'), { id: SessionId('open-child') })
    retire.mockImplementation(async (id) => {
      if (id === SessionId('held-child')) return false
      residentSessions.delete(id)
      return true
    })
    const result = await controller.move({ sessionId: SessionId('parent'), destination: { workspaceId: b.id } })
    expect(result.moved.toSorted()).toEqual(['open-child', 'parent'])
    expect(retire.mock.calls.map(([id]) => id).toSorted()).toEqual(['held-child', 'open-child'])
    expect((await ctx.sessionPersistence.stat(SessionId('held-child')))?.header.cwd).toBe(paths.a)
    expect((await ctx.sessionPersistence.stat(SessionId('open-child')))?.header.cwd).toBe(paths.b)
  })

  it('reports a root another process holds open after moving its descendants', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('held-root', paths.a), a)
    await store(ctx, header('freed-child', paths.a, { origin: 'subagent', parentSession: SessionId('held-root'), delegationDepth: 1 }))
    const writer = await ctx.sessionPersistence.open(SessionId('held-root'), 'write')
    try {
      expect(await controller.moveMany({ sessionIds: [SessionId('held-root')], destination: { workspaceId: b.id } })).toEqual({
        workspaceId: b.id,
        moved: ['freed-child'],
        skipped: [{ sessionId: 'held-root', reason: 'live', message: 'session "held-root" is open in another process', blockers: [] }],
      })
    } finally {
      await writer.close()
    }
    expect(a.sessionIds).toEqual(['held-root'])
  })

  it('moves each Session of a stored parent cycle once', async () => {
    const { ctx, paths, b, controller } = await harness()
    const subagent = (id: string, parent: string) =>
      header(id, paths.a, { origin: 'subagent', parentSession: SessionId(parent), delegationDepth: 1 })
    await store(ctx, subagent('cycle-a', 'cycle-b'))
    await store(ctx, subagent('cycle-b', 'cycle-a'))
    const result = await controller.move({ sessionId: SessionId('cycle-a'), destination: { workspaceId: b.id } })
    expect(result.moved.toSorted()).toEqual(['cycle-a', 'cycle-b'])
    for (const id of ['cycle-a', 'cycle-b']) {
      expect((await ctx.sessionPersistence.stat(SessionId(id)))?.header.cwd).toBe(paths.b)
    }
  })
})

describe('SessionMoveController storage failures', () => {
  it('refuses when the deployment\'s session storage cannot relocate', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const workspace = { id: 'only' as Workspace['id'] }
    ctx.provide('workspaceRegistry', { get: () => workspace } as never)
    const controller = new SessionMoveController(ctx, {} as ApiSessionAgentController)
    await expect(controller.move({ sessionId: SessionId('s'), destination: { workspaceId: workspace.id } }))
      .rejects.toMatchObject({ code: 'session/move-unsupported' })
  })

  it('maps relocation failures to missing and error skips', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    for (const id of ['lost', 'broken', 'thrown']) await store(ctx, header(id, paths.a), a)
    const relocate = vi.spyOn(ctx.sessionPersistence, 'relocate')
    relocate.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'SessionPersistenceNotFoundError' }))
    relocate.mockRejectedValueOnce(new Error('disk full'))
    relocate.mockRejectedValueOnce('plain refusal')
    const batch = await controller.moveMany({
      sessionIds: [SessionId('lost'), SessionId('broken'), SessionId('thrown')],
      destination: { workspaceId: b.id },
    })
    expect(batch.moved).toEqual([])
    expect(batch.skipped).toEqual([
      { sessionId: 'lost', reason: 'missing', message: 'session "lost" has no stored log' },
      { sessionId: 'broken', reason: 'error', message: 'disk full' },
      { sessionId: 'thrown', reason: 'error', message: 'plain refusal' },
    ])
    expect(a.sessionIds.toSorted()).toEqual(['broken', 'lost', 'thrown'])
  })

  it('reports a Session that moved on disk but could not join the destination account', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('unattached', paths.a), a)
    vi.spyOn(b, 'attachSession').mockRejectedValueOnce(new Error('account locked'))
    await expect(controller.move({ sessionId: SessionId('unattached'), destination: { workspaceId: b.id } })).rejects.toMatchObject({
      code: 'session/move-error',
      message: 'moved on disk but could not attach to "Beta": Error: account locked',
    })
    expect((await ctx.sessionPersistence.stat(SessionId('unattached')))?.header.cwd).toBe(paths.b)
  })

  it('completes a move whose projection-cache rebind fails', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('cached', paths.a), a)
    const rebind = vi.fn(() => Promise.reject(new Error('cache offline')))
    ctx.provide('sessionProjectionCache', { rebind } as never)
    expect(await controller.move({ sessionId: SessionId('cached'), destination: { workspaceId: b.id } }))
      .toMatchObject({ moved: ['cached'] })
    expect(rebind).toHaveBeenCalledOnce()
    expect(b.sessionIds).toEqual(['cached'])
  })

  it('still notifies, without a permission clause, when the stored log cannot be read beforehand', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    await store(ctx, header('unread', paths.a), a)
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('read failed'))
    await controller.move({ sessionId: SessionId('unread'), destination: { workspaceId: b.id } })
    expect(await pendingNextStep(ctx, 'unread')).toEqual([{
      kind: SESSION_MOVE_NOTICE_SOURCE,
      text: sessionMoveNoticeText({ title: 'Alpha', path: paths.a }, { title: 'Beta', path: paths.b }, undefined),
    }])
  })

  it('replaces a migrated pending move notice, keeping the current origin when the old one names none it can read', async () => {
    const { ctx, paths, a, b, controller } = await harness()
    const migrated = (id: string, from?: string): SessionEvent[] => [...UNSANDBOXED_EVENTS, {
      type: 'agent/inbox/spliced',
      seq: SessionSeq(UNSANDBOXED_EVENTS.length),
      time: 3,
      data: {
        target: 'next-step',
        start: 0,
        inserted: [createUserMessage({
          content: [{ type: 'text', text: `moved before (${id})` }],
          source: { kind: 'plugin:session-move', ...(from === undefined ? {} : { from }), form: 'notice', summary: 'Moved' },
        })],
      },
    }]
    await store(ctx, header('migrated', paths.a), a, migrated('migrated'))
    await store(ctx, header('migrated-text', paths.a), a, migrated('migrated-text', 'Old place'))
    for (const id of ['migrated', 'migrated-text']) {
      await controller.move({ sessionId: SessionId(id), destination: { workspaceId: b.id } })
      expect(await pendingNextStep(ctx, id)).toEqual([{
        kind: SESSION_MOVE_NOTICE_SOURCE,
        text: sessionMoveNoticeText({ title: 'Alpha', path: paths.a }, { title: 'Beta', path: paths.b }, undefined),
      }])
    }
  })
})

describe('Session move text', () => {
  it('adds a permission clause only for a recorded, known sandbox mode', () => {
    const from = { title: 'Alpha', path: '/alpha' }
    const to = { title: 'Beta', path: '/beta' }
    expect(sessionMoveNoticeText(from, to, 'read-only')).toContain('`Read Only`')
    expect(sessionMoveNoticeText(from, to, undefined)).not.toContain('permissions')
    expect(sessionMoveNoticeText(from, to, 'danger-full-access')).toBe(sessionMoveNoticeText(from, to, undefined))
  })

  it('names each blocking family with counts and at most three labels', () => {
    expect(describeBlockers([
      { kind: 'job', items: [{ id: 'bash-1' }, { id: 'bash-2', label: 'npm test' }, { id: 'bash-3' }, { id: 'bash-4' }] },
      { kind: 'subagent', items: [{ id: 'sub-1', label: 'review' }] },
      { kind: 'subagent', items: [{ id: 'sub-2' }, { id: 'sub-3' }] },
      { kind: 'job' },
      { kind: 'schedule', items: [{ id: 'reminder' }] },
    ])).toBe([
      '4 background jobs running (bash-1, npm test, bash-3, …)',
      '1 subagent running (review)',
      '2 subagents running (sub-2, sub-3)',
      '0 background jobs running',
      'schedule activity (reminder)',
    ].join('; '))
  })
})
