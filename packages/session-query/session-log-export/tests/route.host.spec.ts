import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  Config,
  SESSION_LOG_FILENAME,
  SESSION_LOG_EXPORT_PATH,
  SESSION_LOG_IMPORT_PATH,
  apply,
  inject,
  type SessionImportTarget,
} from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId

function readHandle(id: string): SessionHandle {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
    delegationDepth: 0,
  }
  return {
    id: header.id,
    header,
    access: 'read',
    read: async () => ({ eventState: 'detached', events: [] }),
    close: async () => {},
  } as unknown as SessionHandle
}

async function mounted(withServices: boolean): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  if (withServices) {
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => ({ header: readHandle(String(id)).header }),
      open: async (id: SessionId) => readHandle(String(id)),
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { connection, dispose: () => fiber.dispose() }
}

describe('Session log export Fetch route', () => {
  it('registers one GET/HEAD route and removes it with the plugin fiber', async () => {
    const { connection, dispose } = await mounted(true)
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ), connection.browserPeer)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files[SESSION_LOG_FILENAME] as Uint8Array)).toContain('"id":"session-1"')

    const head = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`, { method: 'HEAD' },
    ), connection.browserPeer)
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()

    await dispose()
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ), connection.browserPeer)).status).toBe(404)
  })

  it('validates the query before reporting missing export services', async () => {
    const { connection, dispose } = await mounted(false)
    const shared = connection.createSharedFetchHandler('/api')
    expect((await shared.fetch(new Request(`http://host${SESSION_LOG_EXPORT_PATH}`), connection.browserPeer)).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1&includeDescendants=1`,
    ), connection.browserPeer)).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ), connection.browserPeer)).status).toBe(500)
    await dispose()
  })

  it('validates the compression level', () => {
    expect(Config({})).toEqual({ compressionLevel: 6 })
    expect(Config({ compressionLevel: 0 })).toEqual({ compressionLevel: 0 })
    expect(Config({ compressionLevel: 9 })).toEqual({ compressionLevel: 9 })
    for (const compressionLevel of [-1, 10, 1.5]) {
      expect(() => Config({ compressionLevel } as never)).toThrow()
    }
  })
})

describe('Session log import Fetch route', () => {
  async function importRoute(registry?: object, controller?: object): Promise<{
    readonly post: (query: string, body?: Uint8Array | ReadableStream<Uint8Array>) => Promise<Response>
    readonly dispose: () => Promise<void>
  }> {
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} } as never)
    if (registry !== undefined) ctx.provide('workspaceRegistry', registry as never)
    if (controller !== undefined) ctx.provide('sessionController', controller as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    const shared = connection.createSharedFetchHandler('/api')
    return {
      post: (query, body) => shared.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}?${query}`, postInit(body)), connection.browserPeer),
      dispose: () => fiber.dispose(),
    }
  }

  function postInit(body?: Uint8Array | ReadableStream<Uint8Array>): RequestInit {
    if (body === undefined) return { method: 'POST' }
    if (body instanceof ReadableStream) {
      // Node requires half-duplex for a streamed request body; the DOM RequestInit type does not declare it.
      const streamed: RequestInit & { readonly duplex: 'half' } = { method: 'POST', body, duplex: 'half' }
      return streamed
    }
    return { method: 'POST', body: new Blob([new Uint8Array(body)]), headers: { 'content-type': 'application/zip' } }
  }

  const destination = { id: 'w', path: '/w', title: 'w' }
  const stored = { sessionId: 'imported', imported: [], attachments: 0, truncated: false }

  it('imports the archive into the named Workspace with the query policy and answers the stored ids', async () => {
    const importSessionArchive = vi.fn<(entries: Record<string, Uint8Array>, target: SessionImportTarget) => Promise<typeof stored>>(
      async () => stored,
    )
    const { post, dispose } = await importRoute(
      { get: () => destination, create: async () => ({ ...destination, path: '/created' }) },
      { importSessionArchive },
    )
    const archive = zipSync({ [SESSION_LOG_FILENAME]: strToU8('{}\n') })

    const defaults = await post('workspaceId=w', archive)
    expect(defaults.status).toBe(200)
    expect(await defaults.json()).toEqual(stored)
    expect(importSessionArchive).toHaveBeenLastCalledWith({ [SESSION_LOG_FILENAME]: strToU8('{}\n') }, expect.objectContaining({
      workspace: destination, origin: 'another DSH host', mode: 'move', keepIds: true, truncate: false, notify: true,
    }))
    expect(importSessionArchive.mock.lastCall?.[1]).not.toHaveProperty('title')

    const chunks = [archive.subarray(0, 10), archive.subarray(10)]
    const streamed = await post(
      'cwd=/created&origin=laptop&mode=copy&keepIds=false&truncate=true&title=Copied&notify=false',
      new ReadableStream<Uint8Array>({ pull: (controller) => {
        const chunk = chunks.shift()
        if (chunk === undefined) controller.close()
        else controller.enqueue(chunk)
      } }),
    )
    expect(streamed.status).toBe(200)
    expect(importSessionArchive).toHaveBeenLastCalledWith({ [SESSION_LOG_FILENAME]: strToU8('{}\n') }, expect.objectContaining({
      workspace: { ...destination, path: '/created' },
      origin: 'laptop', mode: 'copy', keepIds: false, truncate: true, title: 'Copied', notify: false,
    }))
    await dispose()
  })

  it('refuses an archive larger than 256 MiB without importing it', async () => {
    const importSessionArchive = vi.fn(async () => stored)
    const { post, dispose } = await importRoute({ get: () => destination }, { importSessionArchive })
    const chunk = new Uint8Array(16 * 1024 * 1024)
    let sent = 0
    let cancelled = false
    const response = await post('workspaceId=w', new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += 1
        controller.enqueue(chunk)
      },
      cancel: () => { cancelled = true },
    }))
    expect(response.status).toBe(413)
    expect(await response.text()).toBe('archive too large')
    expect(sent).toBeLessThan(20)
    expect(cancelled).toBe(true)
    expect(importSessionArchive).not.toHaveBeenCalled()
    await dispose()
  })

  it('reports non-Error failures from the registry and the Session Controller', async () => {
    const { post, dispose } = await importRoute(
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario
      { get: () => destination, create: () => Promise.reject('permission denied') },
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario
      { importSessionArchive: () => Promise.reject('disk full') },
    )
    const refused = await post('cwd=/locked', new Uint8Array([1]))
    expect(refused.status).toBe(400)
    expect(await refused.text()).toBe('destination is not usable as a workspace: permission denied')
    const failed = await post('workspaceId=w', zipSync({}))
    expect(failed.status).toBe(422)
    expect(await failed.text()).toBe('session import failed: disk full')
    await dispose()
  })

  it('validates the destination before reading the archive and removes the route with the plugin fiber', async () => {
    const missingRegistry = await importRoute()
    expect((await missingRegistry.post('workspaceId=w', new Uint8Array([1]))).status).toBe(500)
    await missingRegistry.dispose()

    const { post, dispose } = await importRoute({
      get: () => undefined,
      create: () => Promise.reject(new Error('not a directory')),
    })
    expect((await post('', new Uint8Array([1]))).status).toBe(400)
    expect((await post('workspaceId=w&cwd=/x', new Uint8Array([1]))).status).toBe(400)
    expect((await post('workspaceId=missing', new Uint8Array([1]))).status).toBe(404)
    expect((await post('cwd=/not-a-dir', new Uint8Array([1]))).status).toBe(400)
    await dispose()
    expect((await post('workspaceId=missing', new Uint8Array([1]))).status).toBe(404)
  })

  it('answers 422 for an archive it cannot import', async () => {
    const { post, dispose } = await importRoute({ get: () => ({ id: 'w', path: '/w', title: 'w' }) })
    const response = await post('workspaceId=w', new Uint8Array([1, 2, 3]))
    expect(response.status).toBe(422)
    expect(await response.text()).toContain('session import failed')
    expect((await post('workspaceId=w')).status).toBe(400)
    await dispose()
  })
})
