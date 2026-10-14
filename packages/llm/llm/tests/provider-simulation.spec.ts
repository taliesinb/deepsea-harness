/** Provider simulation: which hosts are redirected, how, and when. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installProviderSimulation, isProviderHost, providerSimulator, simulatedFetch, simulatedSocketUrl, simulatedUrl,
} from '../src/provider-simulation.ts'

const SIM = 'http://127.0.0.1:4100'

afterEach(() => { vi.unstubAllGlobals() })

describe('provider simulation', () => {
  it('knows provider hosts by domain and by exact shared host', () => {
    for (const host of ['api.anthropic.com', 'claude.ai', 'openrouter.ai', 'api.deepseek.com', 'api.moonshot.ai', 'auth.x.ai', 'generativelanguage.googleapis.com', 'API.OpenAI.com.'])
      expect(isProviderHost(host), host).toBe(true)
    for (const host of ['example.com', 'googleapis.com', 'storage.googleapis.com', 'notanthropic.com', 'github.com'])
      expect(isProviderHost(host), host).toBe(false)
  })

  it('accepts only a loopback http simulator', () => {
    expect(providerSimulator({})).toBeUndefined()
    expect(providerSimulator({ DSH_PROVIDER_SIMULATOR: '' })).toBeUndefined()
    expect(providerSimulator({ DSH_PROVIDER_SIMULATOR: `${SIM}/` })).toBe(SIM)
    expect(providerSimulator({ DSH_PROVIDER_SIMULATOR: 'http://localhost:4100/sim' })).toBe('http://localhost:4100/sim')
    for (const bad of ['https://127.0.0.1:4100', 'http://example.com:4100', 'not a url', 'http://127.0.0.1:4100/?x=1'])
      expect(() => providerSimulator({ DSH_PROVIDER_SIMULATOR: bad }), bad).toThrow(/DSH_PROVIDER_SIMULATOR/)
  })

  it('rewrites provider URLs with the host leading the path, and nothing else', () => {
    expect(simulatedUrl('https://openrouter.ai/api/v1/generation?id=g-1', SIM)).toBe(`${SIM}/openrouter.ai/api/v1/generation?id=g-1`)
    expect(simulatedUrl('https://claude.ai/oauth/authorize?code=true', SIM)).toBe(`${SIM}/claude.ai/oauth/authorize?code=true`)
    expect(simulatedUrl('https://example.com/a', SIM)).toBe('https://example.com/a')
    expect(simulatedUrl('wss://api.openai.com/v1/responses', SIM)).toBe('wss://api.openai.com/v1/responses')
    expect(simulatedUrl('https://openrouter.ai/x', undefined)).toBe('https://openrouter.ai/x')
  })

  it('wraps fetch for strings, URLs and Requests, keeping the request options', async () => {
    const inner = vi.fn(async (input: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      url: input instanceof Request ? input.url : String(input),
      method: input instanceof Request ? input.method : init?.method,
      header: input instanceof Request ? input.headers.get('x-test') : new Headers(init?.headers).get('x-test'),
    })))
    const wrapped = simulatedFetch(inner as unknown as typeof fetch, SIM)
    expect(await (await wrapped('https://api.deepseek.com/user/balance', { method: 'GET', headers: { 'x-test': '1' } })).json())
      .toEqual({ url: `${SIM}/api.deepseek.com/user/balance`, method: 'GET', header: '1' })
    expect(await (await wrapped(new URL('https://example.com/ok'))).json()).toMatchObject({ url: 'https://example.com/ok' })
    const request = new Request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'x-test': '2' }, body: '{}' })
    expect(await (await wrapped(request)).json())
      .toEqual({ url: `${SIM}/openrouter.ai/api/v1/chat/completions`, method: 'POST', header: '2' })
  })

  it('rewrites provider WebSocket URLs to the simulator, and nothing else', () => {
    expect(simulatedSocketUrl('wss://chatgpt.com/backend-api/codex/responses?x=1', SIM)).toBe('ws://127.0.0.1:4100/chatgpt.com/backend-api/codex/responses?x=1')
    expect(simulatedSocketUrl('wss://example.com/socket', SIM)).toBe('wss://example.com/socket')
    expect(simulatedSocketUrl('https://chatgpt.com/x', SIM)).toBe('https://chatgpt.com/x')
  })

  it('installs on globalThis.fetch and WebSocket only when simulating, and the disposer restores them', () => {
    const original = vi.fn()
    const opened: string[] = []
    // A constructor function, as the global is called with `new`.
    function FakeSocket(url: string) { opened.push(url) }
    vi.stubGlobal('fetch', original)
    vi.stubGlobal('WebSocket', FakeSocket)
    expect(installProviderSimulation({})).toBeUndefined()
    expect(globalThis.fetch).toBe(original)
    const dispose = installProviderSimulation({ DSH_PROVIDER_SIMULATOR: SIM })!
    expect(globalThis.fetch).not.toBe(original)
    new globalThis.WebSocket('wss://chatgpt.com/backend-api/codex/responses')
    new globalThis.WebSocket(new URL('wss://example.com/s'))
    expect(opened).toEqual(['ws://127.0.0.1:4100/chatgpt.com/backend-api/codex/responses', 'wss://example.com/s'])
    dispose()
    expect(globalThis.fetch).toBe(original)
    expect(globalThis.WebSocket).toBe(FakeSocket)
  })
})
