import { promises as fsPromises } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

let configDir: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeMockServers()
  if (configDir !== undefined) await rm(configDir, { recursive: true, force: true })
  configDir = undefined
})

/**
 * A person's Anthropic SDK configuration as the `ant` tooling writes it: an
 * active profile signed in with user OAuth, its access token expired so the
 * SDK would refresh it against whatever base URL the client was built with.
 */
async function anthropicConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-anthropic-config-'))
  await mkdir(join(dir, 'configs'))
  await mkdir(join(dir, 'credentials'))
  await writeFile(join(dir, 'configs', 'default.json'), JSON.stringify({
    workspace_id: 'wrkspc_person',
    authentication: { type: 'user_oauth', client_id: 'person-client' },
  }))
  await writeFile(join(dir, 'credentials', 'default.json'), JSON.stringify({
    access_token: 'sk-ant-oat01-person-access',
    refresh_token: 'sk-ant-ort01-person-refresh',
    expires_at: Math.floor(Date.now() / 1000) - 60,
  }), { mode: 0o600 })
  return dir
}

describe('Anthropic SDK local configuration', () => {
  it('never reads it for a route whose sign-in supplies only an Authorization header', async () => {
    configDir = await anthropicConfigDir()
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', configDir)
    vi.stubEnv('ANTHROPIC_PROFILE', '')
    const readFile = vi.spyOn(fsPromises, 'readFile')
    const server = await mockServer([
      { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock end of request' } }) },
      { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock end of request' } }) },
    ])
    // Kimi Code's sign-in: pi-ai's `kimi-coding` provider speaks Anthropic
    // Messages and turns the stored grant into a bare `Authorization` header.
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ 'kimi-coding': { baseURL: server.url } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({
        'kimi-coding': { type: 'oauth', access: 'kimi-access', refresh: 'kimi-refresh', expires: Date.now() + 3_600_000 },
      }),
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'kimi-coding',
      model: 'k3',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('mock end of request') as string } },
    })
    expect(server.paths).toEqual([expect.stringMatching(/^\/v1\/messages\b/)])
    expect(server.headers[0]?.authorization).toBe('Bearer kimi-access')
    expect(server.headers[0]?.['x-api-key']).toBeUndefined()
    expect(server.headers[0]?.['anthropic-workspace-id']).toBeUndefined()
    expect(JSON.stringify([server.headers, server.requests])).not.toContain('person')
    const dir = configDir
    expect(readFile.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith(dir))).toEqual([])
  })
})
