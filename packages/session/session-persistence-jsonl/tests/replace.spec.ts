/**
 * `replace()`: the explicit destructive rewrite behind Session rewind. The
 * current artifact is atomically replaced by a validated shorter log under the
 * same identity and header; a stale revision or an open writer refuses
 * without changing the stored log.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionRevisionConflictError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '../src/index.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function mount(compression: 'none' | 'zstd'): Promise<SessionPersistence> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-jsonl-replace-'))
  dirs.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression })
  return ctx.sessionPersistence
}

async function readAll(backend: SessionPersistence, id: SessionId) {
  const handle = await backend.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('replace', () => {
  it.each(['none', 'zstd'] as const)('replaces the stored log with a shorter prefix under the same header (%s)', async (compression) => {
    const backend = await mount(compression)
    const id = SessionId('rewound')
    const log = oneTurnLog()
    const handle = await backend.create(meta('rewound', '/work'))
    await handle.append(log)
    await handle.close()
    const before = await backend.stat(id)

    await backend.replace?.({ id, expectedRevision: before!.revision, events: log.slice(0, 1) })

    expect(await readAll(backend, id)).toEqual(log.slice(0, 1))
    const after = await backend.stat(id)
    expect(after?.header).toEqual(before?.header)
    expect(after?.revision).not.toBe(before?.revision)
    // The replaced log accepts ordinary appends from its new end.
    const writer = await backend.open(id, 'write')
    await writer.append(log.slice(1))
    await writer.close()
    expect(await readAll(backend, id)).toEqual(log)
  })

  it('refuses a stale revision and an open writer without changing the log', async () => {
    const backend = await mount('none')
    const id = SessionId('guarded')
    const log = oneTurnLog()
    const handle = await backend.create(meta('guarded', '/work'))
    await handle.append(log.slice(0, 1))
    await handle.flush()
    const stale = (await backend.stat(id))!.revision
    await handle.append(log.slice(1))
    await handle.flush()

    await expect(backend.replace?.({ id, expectedRevision: (await backend.stat(id))!.revision, events: [] }))
      .rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    await handle.close()
    await expect(backend.replace?.({ id, expectedRevision: stale, events: [] }))
      .rejects.toBeInstanceOf(SessionRevisionConflictError)
    expect(await readAll(backend, id)).toEqual(log)
    await expect(backend.replace?.({ id: SessionId('never-stored'), expectedRevision: stale, events: [] }))
      .rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
  })
})
