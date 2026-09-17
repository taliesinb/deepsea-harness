/**
 * `relocate()`: moving a cold stored session to another working directory.
 * The header's cwd decides the project directory, so the artifact is
 * republished under the new one with the requested events appended after the
 * stored tail, and the old directory leaves the root for a sibling backup
 * directory. Live sessions (an open write handle in this process, or a lock
 * held by another instance) refuse.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence, SessionRelocateAppend } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence, { RELOCATION_BACKUP_DIRNAME } from '../src/index.ts'
import { sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
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

})
