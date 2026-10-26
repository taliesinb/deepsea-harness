/** The import functions hand archives and parsed logs to the mounted Session Controller. */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionImportTarget } from '@deepseek-ai/dsh-api-session-controller'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { importSessionZip, storeSessionLogs } from '../src/index.ts'

const workspace: Partial<Workspace> = { path: '/w', title: 'w' }
const target: SessionImportTarget = { workspace: workspace as Workspace, origin: 'peer' }
const result = { sessionId: SessionId('stored'), imported: [], attachments: 0 }

describe('Session import functions', () => {
  it('delegate parsed logs and unzipped archive entries to the Session Controller', async () => {
    const ctx = new Context()
    const controller = {
      storeSessionLogs: vi.fn(async () => result),
      importSessionArchive: vi.fn(async () => result),
    }
    ctx.provide('sessionController', controller as never)
    const logs = {
      root: {
        header: { version: SESSION_FORMAT_VERSION, id: SessionId('s'), createdAt: 1, isSeeded: false } satisfies SessionHeader,
        events: [],
        inheritedEventCount: SessionLogOffset(0),
      },
      children: [],
    }
    expect(await storeSessionLogs(ctx, logs, target)).toBe(result)
    expect(controller.storeSessionLogs).toHaveBeenCalledWith(logs, target)
    expect(await importSessionZip(ctx, zipSync({ 'session.jsonl': strToU8('{}\n') }), target)).toBe(result)
    expect(controller.importSessionArchive).toHaveBeenCalledWith({ 'session.jsonl': strToU8('{}\n') }, target)
    await expect(importSessionZip(ctx, new Uint8Array([1, 2, 3]), target)).rejects.toThrow('not a readable ZIP archive')
  })

  it('refuse without a mounted Session Controller', async () => {
    const ctx = new Context()
    await expect(importSessionZip(ctx, zipSync({}), target)).rejects.toThrow('Session Controller is not mounted')
    const empty = { header: {} as SessionHeader, events: [], inheritedEventCount: SessionLogOffset(0) }
    expect(() => storeSessionLogs(ctx, { root: empty, children: [] }, target)).toThrow('Session Controller is not mounted')
  })
})
