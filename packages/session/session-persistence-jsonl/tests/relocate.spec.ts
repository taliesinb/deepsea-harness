/**
 * `relocate()`: moving a cold stored session to another working directory.
 * The header's cwd decides the project directory, so the artifact is
 * republished under the new one with the requested events appended after the
 * stored tail, and the old directory leaves the root for a sibling backup
 * directory. Live sessions (an open write handle in this process, or a lock
 * held by another instance) refuse.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence, SessionRelocateAppend } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '../src/index.ts'
import { RELOCATION_BACKUP_DIRNAME } from '../src/index.ts'
import { generationLogPath, projectDir, sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

/** Injected filesystem failures: publishing the relocated log, and restoring the backup. */
const faults = vi.hoisted(() => ({ publish: false, restore: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.publish && String(args[0]).endsWith('.tmp')) throw new Error('injected publication failure')
      return actual.open(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.restore && String(args[0]).includes(RELOCATION_BACKUP_DIRNAME)) throw new Error('injected restore failure')
      return actual.rename(...args)
    },
  }
})

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  faults.publish = false
  faults.restore = false
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshHome(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-jsonl-relocate-'))
  dirs.push(home)
  return { home, root: join(home, 'sessions') }
}

async function mount(root: string, compression: 'none' | 'zstd' = 'none'): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx.sessionPersistence
}

async function stored(backend: SessionPersistence, header: SessionHeader, events: SessionEvent[] = oneTurnLog()): Promise<void> {
  const handle = await backend.create(header)
  await handle.append(events)
  await handle.close()
}

const NOTICE: SessionRelocateAppend = {
  type: 'agent/inbox/spliced',
  data: {
    target: 'next-step',
    start: 0,
    inserted: [createUserMessage({ content: [{ type: 'text', text: 'moved' }], source: { kind: 'user' } })],
  },
}

describe('relocate', () => {
  it.each(['none', 'zstd'] as const)('republishes under the new cwd, appends events, and backs up the old directory (%s)', async (compression) => {
    const { home, root } = await freshHome()
    const backend = await mount(root, compression)
    await stored(backend, meta('moved', '/work/old'))

    const result = await backend.relocate?.({ id: SessionId('moved'), cwd: '/work/new', append: [NOTICE] })
    expect(result).toMatchObject({ moved: true, inheritedEventCount: 0, header: { id: 'moved', cwd: '/work/new', createdAt: 1000 } })
    expect(result?.backupPath?.startsWith(join(home, RELOCATION_BACKUP_DIRNAME))).toBe(true)
    expect(existsSync(sessionDir(root, '/work/old', SessionId('moved')))).toBe(false)
    expect((await readdir(result?.backupPath ?? '')).length).toBeGreaterThan(0)

    const reopened = await backend.open(SessionId('moved'), 'read')
    expect(reopened.header.cwd).toBe('/work/new')
    const read = await reopened.read()
    const count = oneTurnLog().length
    expect(read.events.map(event => event.seq)).toEqual([...Array(count + 1).keys()])
    expect(read.events[count]).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-step' } })
    await reopened.close()

    expect((await backend.list()).map(snapshot => [snapshot.header.id, snapshot.header.cwd])).toEqual([['moved', '/work/new']])
    const fresh = await mount(root, compression)
    expect((await fresh.stat(SessionId('moved')))?.header.cwd).toBe('/work/new')
    // A write open afterwards works at the new location: no stale lock, no duplicate id.
    const writer = await fresh.open(SessionId('moved'), 'write')
    await writer.append([{ type: 'turn/start', seq: SessionSeq(count + 1), time: 9, data: { turn: 2 } }])
    await writer.close()
  })

  it('is a no-op for the same cwd and refuses unknown ids', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    await stored(backend, meta('same', '/work/old'))
    const result = await backend.relocate?.({ id: SessionId('same'), cwd: '/work/old/' })
    expect(result?.moved).toBe(false)
    expect(existsSync(sessionDir(root, '/work/old', SessionId('same')))).toBe(true)
    await expect(backend.relocate?.({ id: SessionId('missing'), cwd: '/x' })).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })

  it('refuses a session that is open for writing, here or in another instance', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    const holder = await backend.create(meta('live', '/work/old'))
    await holder.append(oneTurnLog())
    await expect(backend.relocate?.({ id: SessionId('live'), cwd: '/work/new' })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    const other = await mount(root)
    await expect(other.relocate?.({ id: SessionId('live'), cwd: '/work/new' })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await holder.close()
    expect((await other.relocate?.({ id: SessionId('live'), cwd: '/work/new' }))?.moved).toBe(true)
    expect((await backend.relocate?.({ id: SessionId('live'), cwd: '/work/new' }))?.moved).toBe(false)
    expect(existsSync(sessionDir(root, '/work/old', SessionId('live')))).toBe(false)
  })

  it('refuses appended events the current format rejects and leaves the session in place', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    await stored(backend, meta('strict', '/work/old'))
    const invalid: SessionRelocateAppend = { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }
    await expect(backend.relocate?.({ id: SessionId('strict'), cwd: '/work/new', append: [invalid] })).rejects.toThrow()
    expect((await backend.stat(SessionId('strict')))?.header.cwd).toBe('/work/old')
    expect(existsSync(sessionDir(root, '/work/new', SessionId('strict')))).toBe(false)
  })

  it('keeps a seeded lifecycle and its inherited cut', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    const events = oneTurnLog()
    const cut = events.length
    const seeded: SessionEvent[] = [
      ...events,
      { type: 'session/end-seed', seq: SessionSeq(cut), time: 10, data: { inherited: true } },
    ]
    const handle = await backend.create(
      { ...meta('fork', '/work/old'), parentSession: SessionId('parent'), isSeeded: true },
      { inheritedEventCount: SessionLogOffset(cut) },
    )
    await handle.append(seeded)
    await handle.close()
    const result = await backend.relocate?.({ id: SessionId('fork'), cwd: '/work/new' })
    expect(result).toMatchObject({ moved: true, inheritedEventCount: cut, header: { isSeeded: true, parentSession: 'parent' } })
    const reopened = await backend.open(SessionId('fork'), 'read')
    expect(reopened.inheritedEventCount).toBe(cut)
    await reopened.close()
  })

  it('publishes a historical generation first and moves a session stored without a cwd', async () => {
    const { root } = await freshHome()
    const id = SessionId('historical')
    const path = generationLogPath(root, undefined, id, 3, 'none')
    const message = { id: 'next', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [message] } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: message, surfaceOp: 'append' },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
    const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [header, ...rows].map(row => `${JSON.stringify(row)}\n`).join(''))
    const backend = await mount(root)

    const result = await backend.relocate?.({ id, cwd: '/work/new', append: [NOTICE] })
    expect(result).toMatchObject({ moved: true, header: { version: 4, cwd: '/work/new' } })
    expect(existsSync(sessionDir(root, undefined, id))).toBe(false)
    expect(await readdir(result?.backupPath ?? '')).toEqual(expect.arrayContaining(['session.v3.jsonl', 'session.v4.jsonl']))
    const reopened = await backend.open(id, 'read')
    const events = (await reopened.read()).events
    await reopened.close()
    expect(events.map(event => event.seq)).toEqual([...events.keys()])
    expect(events.at(-1)).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-step' } })
  })

  it('numbers events appended to an empty log from zero and keeps their ignorable marker', async () => {
    const { root } = await freshHome()
    const id = SessionId('empty')
    const path = generationLogPath(root, '/work/old', id, 4, 'none')
    await mkdir(dirname(path), { recursive: true })
    const header = { type: 'session', version: 4, id, createdAt: 1, cwd: '/work/old', isSeeded: false, delegationDepth: 0 }
    await writeFile(path, `${JSON.stringify(header)}\n`)
    const backend = await mount(root)

    const ignorable: SessionRelocateAppend = { ...NOTICE, ignorable: true }
    expect((await backend.relocate?.({ id, cwd: '/work/new', append: [ignorable] }))?.moved).toBe(true)
    const reopened = await backend.open(id, 'read')
    expect((await reopened.read()).events).toEqual([expect.objectContaining({ type: 'agent/inbox/spliced', seq: 0, ignorable: true })])
    await reopened.close()
  })

  it('rewrites the header in place when the new cwd shares the old project directory', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    await stored(backend, meta('collide', '/work/old'))
    expect(projectDir(root, '/work:old')).toBe(projectDir(root, '/work/old'))

    const result = await backend.relocate?.({ id: SessionId('collide'), cwd: '/work:old' })
    expect(result).toMatchObject({ moved: true, header: { cwd: '/work:old' } })
    expect((await backend.stat(SessionId('collide')))?.header.cwd).toBe('/work:old')
    expect(existsSync(sessionDir(root, '/work/old', SessionId('collide')))).toBe(true)
  })

  it('refuses a destination directory that already holds a log for the id', async () => {
    const { home, root } = await freshHome()
    const backend = await mount(root)
    await stored(backend, meta('taken', '/work/old'))
    // The listing scans real project directories only, so a linked project directory hides this log until the destination check.
    const elsewhere = join(home, 'linked-project')
    const occupied = join(elsewhere, 'taken', 'session.v4.jsonl')
    await mkdir(dirname(occupied), { recursive: true })
    await writeFile(occupied, '')
    await symlink(elsewhere, projectDir(root, '/work/new'), 'junction')

    await expect(backend.relocate?.({ id: SessionId('taken'), cwd: '/work/new' })).rejects.toThrow('a log already exists')
    expect((await backend.stat(SessionId('taken')))?.header.cwd).toBe('/work/old')
  })

  it('restores the previous directory when publishing the relocated log fails', async () => {
    const { home, root } = await freshHome()
    const backend = await mount(root)
    await stored(backend, meta('restored', '/work/old'))
    faults.publish = true

    await expect(backend.relocate?.({ id: SessionId('restored'), cwd: '/work/new' })).rejects.toThrow('injected publication failure')
    faults.publish = false
    expect(existsSync(sessionDir(root, '/work/new', SessionId('restored')))).toBe(false)
    expect(await readdir(join(home, RELOCATION_BACKUP_DIRNAME))).toEqual([])
    expect((await backend.stat(SessionId('restored')))?.header.cwd).toBe('/work/old')
    expect((await backend.relocate?.({ id: SessionId('restored'), cwd: '/work/new' }))?.moved).toBe(true)
  })

  it('names the backup when the previous directory cannot be restored', async () => {
    const { home, root } = await freshHome()
    const backend = await mount(root)
    await stored(backend, meta('stranded', '/work/old'))
    faults.publish = true
    faults.restore = true

    const failure = await backend.relocate?.({ id: SessionId('stranded'), cwd: '/work/new' }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const [backup] = await readdir(join(home, RELOCATION_BACKUP_DIRNAME))
    expect(failure).toMatchObject({
      message: `session "stranded": relocation failed and the previous artifact remains at ${join(home, RELOCATION_BACKUP_DIRNAME, backup ?? '')}`,
      errors: [expect.objectContaining({ message: 'injected publication failure' }), expect.objectContaining({ message: 'injected restore failure' })],
    })
    expect(await backend.stat(SessionId('stranded'))).toBeUndefined()
  })

  it('refuses an appended inherited end-seed marker that would change the inherited cut', async () => {
    const { root } = await freshHome()
    const backend = await mount(root)
    const events = oneTurnLog()
    const cut = events.length
    const handle = await backend.create(
      { ...meta('recut', '/work/old'), parentSession: SessionId('parent'), isSeeded: true },
      { inheritedEventCount: SessionLogOffset(cut) },
    )
    await handle.append([...events, { type: 'session/end-seed', seq: SessionSeq(cut), time: 10, data: { inherited: true } }])
    await handle.close()
    const marker: SessionRelocateAppend = { type: 'session/end-seed', data: { inherited: true } }
    await expect(backend.relocate?.({ id: SessionId('recut'), cwd: '/work/new', append: [marker] })).rejects.toThrow('changed its inherited cut')
  })
})
