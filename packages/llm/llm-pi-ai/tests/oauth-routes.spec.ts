import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, Model, OAuthCredential, Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import * as LlmPiAi from '../src/index.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiAuthInjection } from '../src/adapter.ts'
import { credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import { catalogProvider, oauthCatalogProvider, oauthProviderIds, oauthRouteAuth, oauthRouteDisplayName } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { parseAnthropicProfile, parseAnthropicUsage, parseCodexUsage } from '../src/subscription-usage.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'

// Enumerate independently of the helper under test: adding an installed OAuth
// flow must add coverage even if alias registration accidentally omits it.
const flows = builtinProviders().filter(provider => provider.auth.oauth !== undefined)
  .map(provider => ({ id: provider.id, route: `${provider.id}-oauth` }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('OAuth route tests must not make network calls'))))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function routeProvider(route: string): Provider {
  const provider = resolveProfiles({ [route]: {} }).get(route)?.piProvider
  if (provider === undefined) throw new Error(`No provider for ${route}`)
  return provider
}

function firstModel(provider: Provider): Model<Api> {
  const model = provider.getModels()[0]
  if (model === undefined) throw new Error(`No catalog model for ${provider.id}`)
  return model
}

function grant(access: string, expires = Date.now() + 3_600_000): OAuthCredential {
  return { type: 'oauth', access, refresh: `${access}-refresh`, expires }
}

function response(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant', provider: model.provider, model: model.id, api: model.api,
    content: [{ type: 'text', text: 'hello', textSignature: 'opaque-text-signature' }],
    responseId: 'native-response-id', stopReason: 'stop', timestamp: 1,
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

function completed(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  stream.push({ type: 'start', partial: message })
  stream.push({ type: 'text_start', contentIndex: 0, partial: message })
  stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hello', partial: message })
  stream.push({ type: 'text_end', contentIndex: 0, content: 'hello', partial: message })
  stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}

async function adapterContext(route: string, auth: PiAiAuthInjection, onReplayDegrade = vi.fn()): Promise<Context> {
  const profiles = resolveProfiles({ [route]: {} })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([route], new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve(undefined),
    auth,
    onReplayDegrade,
  }))
  return ctx
}

describe('response cost', () => {
  it('looks up one OpenRouter generation charge with the route key and ignores other routes and ids', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: { id: 'gen-1', total_cost: 0.01234 } }))))
    vi.stubGlobal('fetch', fetchMock)
    const profiles = resolveProfiles({ openrouter: {}, anthropic: {} })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['openrouter', 'anthropic'], new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: () => Promise.resolve('sk-or-fixture'), auth: memoryAuth(),
    }))
    await expect(ctx.llm.responseCost('openrouter', 'gen-1790793644-abc')).resolves.toEqual({ amount: '0.01234', currency: 'USD' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/generation?id=gen-1790793644-abc')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-fixture')
    await expect(ctx.llm.responseCost('openrouter', 'not-a-generation')).resolves.toBeUndefined()
    await expect(ctx.llm.responseCost('anthropic', 'gen-1')).resolves.toBeUndefined()
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(ctx.llm.responseCost('openrouter', 'gen-2')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('sign-in state', () => {
  it('reports the Anthropic account from its profile, nothing for a route without a grant, and no state for API-key routes', async () => {
    const native = catalogProvider('anthropic-oauth')!
    vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: 'sk-ant-oat01-state' })
    const profile = {
      account: { uuid: 'account-uuid', email: 'user@example.com', full_name: 'Fixture User' },
      organization: { uuid: 'org-uuid', name: 'Fixture Org', organization_type: 'claude_max' },
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(profile), { headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await adapterContext('anthropic-oauth', memoryAuth({ 'anthropic-oauth': grant('sk-ant-oat01-state') }))
    await expect(ctx.llm.describeSignIn('anthropic-oauth')).resolves.toEqual({
      signedIn: true,
      account: { id: 'account-uuid/org-uuid', email: 'user@example.com', name: 'Fixture User', organization: 'Fixture Org', plan: 'claude_max' },
    })
    expect(fetchMock.mock.calls.map(call => (call as unknown as [string])[0])).toEqual(['https://api.anthropic.com/api/oauth/profile'])
    const empty = await adapterContext('anthropic-oauth', memoryAuth({}))
    await expect(empty.llm.describeSignIn('anthropic-oauth')).resolves.toEqual({ signedIn: false })
    const keyed = await adapterContext('anthropic', memoryAuth({}))
    await expect(keyed.llm.describeSignIn('anthropic')).resolves.toBeUndefined()
  })

  it('counts a grant that reaches requests as headers alone (Kimi Code)', async () => {
    const ctx = await adapterContext('kimi-coding-oauth', memoryAuth({ 'kimi-coding-oauth': grant('kimi-access') }))
    await expect(ctx.llm.describeSignIn('kimi-coding-oauth')).resolves.toEqual({ signedIn: true })
    const empty = await adapterContext('kimi-coding-oauth', memoryAuth({}))
    await expect(empty.llm.describeSignIn('kimi-coding-oauth')).resolves.toEqual({ signedIn: false })
  })

  it('reads the Codex account from the token claims without a request', async () => {
    const claims = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fixture', chatgpt_plan_type: 'pro' },
      'https://api.openai.com/profile': { email: 'user@example.com' },
    })).toString('base64url')
    const token = `header.${claims}.signature`
    vi.spyOn(catalogProvider('openai-codex-oauth')!.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: token })
    const ctx = await adapterContext('openai-codex-oauth', memoryAuth({ 'openai-codex-oauth': grant(token) }))
    await expect(ctx.llm.describeSignIn('openai-codex-oauth')).resolves.toEqual({
      signedIn: true, account: { id: 'acct-fixture', email: 'user@example.com', plan: 'pro' },
    })
  })
})

describe('subscription usage', () => {
  it('reads Anthropic account usage once with the route token, normalizes it, and skips other routes', async () => {
    const native = catalogProvider('anthropic-oauth')!
    vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: 'sk-ant-oat01-fixture' })
    const body = {
      five_hour: { utilization: 3.0, resets_at: '2026-10-01T05:00:00.5+00:00' },
      seven_day: { utilization: 41, resets_at: '2026-10-04T11:00:00+00:00' },
      seven_day_opus: null, iguana_necktie: null,
      extra_usage: { is_enabled: false },
    }
    const profile = {
      account: { uuid: 'account-uuid', email: 'user@example.com', full_name: 'Fixture User', display_name: 'fixture' },
      organization: { uuid: 'org-uuid', name: 'Fixture Org', organization_type: 'claude_team' },
    }
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/profile') ? profile : body), { headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await adapterContext('anthropic-oauth', memoryAuth({ 'anthropic-oauth': grant('sk-ant-oat01-fixture') }))
    const usage = await ctx.llm.subscriptionUsage('anthropic-oauth')
    expect(usage).toMatchObject({
      windows: [
        { label: '5h', usedPercent: 3, resetAt: '2026-10-01T05:00:00.500Z' },
        { label: '7d', usedPercent: 41, resetAt: '2026-10-04T11:00:00.000Z' },
      ],
      extraUsageEnabled: false,
      account: { id: 'account-uuid/org-uuid', email: 'user@example.com', name: 'Fixture User', organization: 'Fixture Org', plan: 'claude_team' },
    })
    expect(fetchMock.mock.calls.map(call => call[0]).sort()).toEqual(['https://api.anthropic.com/api/oauth/profile', 'https://api.anthropic.com/api/oauth/usage'])
    for (const call of fetchMock.mock.calls) {
      expect(((call as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer sk-ant-oat01-fixture')
    }
    // The profile of a token is read once; later readings reuse it.
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '160' } }))
    await expect(ctx.llm.subscriptionUsage('anthropic-oauth')).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    await expect(ctx.llm.subscriptionUsage('anthropic-oauth')).resolves.toMatchObject({ account: { email: 'user@example.com' } })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const other = flows.find(flow => flow.id !== 'anthropic' && flow.id !== 'openai-codex')!
    const otherCtx = await adapterContext(other.route, memoryAuth({ [other.route]: grant('other-access') }))
    await expect(otherCtx.llm.subscriptionUsage(other.route)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('a failed Anthropic profile read leaves the usage reading without an account', async () => {
    const native = catalogProvider('anthropic-oauth')!
    vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: 'sk-ant-oat01-noprofile' })
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.endsWith('/profile')
      ? new Response('', { status: 403 })
      : new Response(JSON.stringify({ five_hour: { utilization: 1 } }), { headers: { 'content-type': 'application/json' } }))))
    const ctx = await adapterContext('anthropic-oauth', memoryAuth({ 'anthropic-oauth': grant('sk-ant-oat01-noprofile') }))
    const usage = await ctx.llm.subscriptionUsage('anthropic-oauth')
    expect(usage?.windows).toEqual([{ label: '5h', usedPercent: 1 }])
    expect(usage?.account).toBeUndefined()
    expect(parseAnthropicProfile({ account: { display_name: 'only-display' }, organization: null })).toEqual({ name: 'only-display' })
    expect(parseAnthropicProfile({})).toBeUndefined()
  })

  it('reads Codex account usage with the route token and its account id, labelling windows by length', async () => {
    const claims = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fixture', chatgpt_account_user_id: 'user-fixture', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'user@example.com', email_verified: true },
    })).toString('base64url')
    const token = `header.${claims}.signature`
    const native = catalogProvider('openai-codex-oauth')!
    vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: token })
    const body = {
      plan_type: 'plus',
      rate_limit: {
        allowed: true, limit_reached: false,
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1790884286 },
        secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 100, reset_at: 1791483086 },
      },
      credits: { has_credits: false, unlimited: false, balance: '0' },
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await adapterContext('openai-codex-oauth', memoryAuth({ 'openai-codex-oauth': grant(token) }))
    await expect(ctx.llm.subscriptionUsage('openai-codex-oauth')).resolves.toMatchObject({
      windows: [
        { label: '5h', usedPercent: 12, resetAt: new Date(1790884286 * 1000).toISOString() },
        { label: '7d', usedPercent: 3, resetAt: new Date(1791483086 * 1000).toISOString() },
      ],
      account: { id: 'acct-fixture/user-fixture', email: 'user@example.com', plan: 'plus' },
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${token}`)
    expect(headers['chatgpt-account-id']).toBe('acct-fixture')
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(ctx.llm.subscriptionUsage('openai-codex-oauth')).rejects.toMatchObject({ code: 'AUTH' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reads no Codex usage for tokens without readable claims or an account id', async () => {
    const native = catalogProvider('openai-codex-oauth')!
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const noAccount = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } })).toString('base64url')}.s`
    for (const token of ['opaque-token', 'h.!!not-json!!.s', noAccount]) {
      vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: token })
      const ctx = await adapterContext('openai-codex-oauth', memoryAuth({ 'openai-codex-oauth': grant(token) }))
      await expect(ctx.llm.subscriptionUsage('openai-codex-oauth')).resolves.toBeUndefined()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps at most sixteen Anthropic profiles, evicting the oldest token', async () => {
    const native = catalogProvider('anthropic-oauth')!
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/profile') ? { account: { email: 'user@example.com' } } : {}), { headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const read = async (token: string) => {
      vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: token })
      const ctx = await adapterContext('anthropic-oauth', memoryAuth({ 'anthropic-oauth': grant(token) }))
      return ctx.llm.subscriptionUsage('anthropic-oauth')
    }
    for (let i = 0; i < 17; i++) await read(`sk-ant-oat01-evict-${String(i)}`)
    const profiles = () => fetchMock.mock.calls.filter(call => call[0].endsWith('/profile')).length
    expect(profiles()).toBe(17)
    await read('sk-ant-oat01-evict-16')
    expect(profiles()).toBe(17)
    await expect(read('sk-ant-oat01-evict-0')).resolves.toMatchObject({ account: { email: 'user@example.com' } })
    expect(profiles()).toBe(18)
  })

  it('parses only well-formed Codex windows', () => {
    expect(parseCodexUsage({ rate_limit: {
      primary_window: { used_percent: 140, limit_window_seconds: 3600, reset_at: 0 },
      secondary_window: { used_percent: 'x', limit_window_seconds: 604800 },
    } }, '2026-10-01T00:00:00.000Z')).toEqual({ windows: [{ label: '1h', usedPercent: 100 }], observedAt: '2026-10-01T00:00:00.000Z' })
    expect(parseCodexUsage(null, '2026-10-01T00:00:00.000Z').windows).toEqual([])
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 90 } } }, '2026-10-01T00:00:00.000Z').windows)
      .toEqual([{ label: '2m', usedPercent: 1 }])
    expect(parseAnthropicUsage(null, '2026-10-01T00:00:00.000Z')).toEqual({ windows: [], observedAt: '2026-10-01T00:00:00.000Z' })
  })
})

describe('every installed OAuth catalog route', () => {
  it('enumerates exactly one dedicated alias per installed OAuth flow', () => {
    expect(flows.length).toBeGreaterThan(0)
    expect([...oauthProviderIds()].sort()).toEqual(flows.map(flow => flow.route).sort())
    expect(new Set(oauthProviderIds()).size).toBe(flows.length)
    for (const provider of builtinProviders().filter(provider => provider.auth.oauth === undefined)) {
      expect(oauthCatalogProvider(`${provider.id}-oauth`)).toBeUndefined()
    }
    expect(oauthCatalogProvider('not-a-provider-oauth')).toBeUndefined()
    expect(oauthCatalogProvider(`${flows[0]!.route}-oauth`)).toBeUndefined()
  })

  it.each(flows)('$route keeps a separate identity and OAuth-only auth', ({ id, route }) => {
    const base = catalogProvider(id)!
    const alias = routeProvider(route)
    const nativeRoute = routeProvider(id)
    expect(catalogProvider(route)).toBe(base)
    expect(oauthCatalogProvider(route)).toBe(base)
    expect(oauthCatalogProvider(id)).toBeUndefined()
    expect(alias.id).toBe(route)
    expect(alias.auth).toEqual({ oauth: base.auth.oauth })
    expect(alias.auth.apiKey).toBeUndefined()
    expect(nativeRoute.auth).toBe(base.auth)
    expect(alias.getModels().length).toBeGreaterThan(0)
    expect(alias.getModels()).toEqual(nativeRoute.getModels().map(model => ({ ...model, provider: route })))
    expect(alias.getModels().every(model => model.provider === route)).toBe(true)
    expect(nativeRoute.getModels().every(model => model.provider === id)).toBe(true)
    expect(base.getModels().every(model => model.provider === id)).toBe(true)
    expect(firstModel(alias)).not.toBe(firstModel(nativeRoute))
  })

  describe.each(flows)('$route configuration guard', ({ route }) => {
    it.each([
      { apiKeyEnv: 'OAUTH_TEST_API_KEY' },
      { api: 'openai-completions' },
      { baseURL: 'https://untrusted.example/v1' },
    ])('rejects %j in strict and deferred resolution', (override) => {
      for (const mode of ['strict', 'deferred'] as const) {
        expect(() => resolveProfiles({ [route]: override }, mode)).toThrow(/OAuth grant and native catalog/)
      }
    })

    it('accepts only the auth declaration matching its classification', () => {
      const auth = oauthRouteAuth(route)!
      expect(resolveProfiles({ [route]: { auth } }).get(route)?.auth).toBe(auth)
      expect(() => resolveProfiles({ [route]: { auth: 'local' } })).toThrow(/billed as "(subscription|api-key)"; its auth cannot be "local"/)
    })
  })

  it('offers every alias in the dormant plugin directory without a configured profile', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: {} })
    const directory = ctx.llm.listConfigurableProviders()
    for (const { id, route } of flows) {
      expect(directory.filter(entry => entry.provider === route)).toEqual([{
        provider: route,
        displayName: oauthRouteDisplayName(route),
        settingsNs: 'llm-pi-ai', settingsPath: ['providers', route], declared: false,
        signIn: { kind: oauthRouteAuth(route) === 'subscription' ? 'subscription' : 'oauth', vendor: catalogProvider(route)!.name },
      }])
      expect(directory.some(entry => entry.provider === id)).toBe(true)
    }
  })
})

describe.each(flows)('$route credential isolation and dispatch', ({ id, route }) => {
  it('refreshes and deletes only the alias record through the real credential bridge', async () => {
    const records = new Context()
    await records.plugin(MemoryCredentials)
    const credentials = credentialStoreFrom(records)
    const baseCredential = { type: 'api_key' as const, key: `${id}-base-key` }
    const expired = grant(`${route}-expired`, 0)
    const refreshed = grant(`${route}-refreshed`)
    await credentials.modify(id, () => Promise.resolve(baseCredential))
    await credentials.modify(route, () => Promise.resolve(expired))
    expect(recordKeyFor(id)).not.toBe(recordKeyFor(route))

    const native = catalogProvider(route)!
    const refresh = vi.spyOn(native.auth.oauth!, 'refresh').mockResolvedValue(refreshed)
    const toAuth = vi.spyOn(native.auth.oauth!, 'toAuth').mockImplementation(credential => Promise.resolve({ apiKey: credential.access }))
    const stream = vi.spyOn(native, 'streamSimple').mockImplementation(model => completed(response(model)))
    const auth = { ...memoryAuth(), credentials }
    const ctx = await adapterContext(route, auth)
    const model = firstModel(routeProvider(route))
    const result = await assemble(ctx, { provider: route, model: model.id, messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(refresh).toHaveBeenCalledExactlyOnceWith(expired, expect.any(AbortSignal))
    expect(toAuth).toHaveBeenCalledWith(refreshed)
    expect(stream.mock.calls[0]?.[2]).toMatchObject({ apiKey: refreshed.access })
    expect(await credentials.read(id)).toEqual(baseCredential)
    expect(await credentials.read(route)).toEqual(refreshed)
    expect(await records.credentials.readRecord(recordKeyFor(route))).toEqual({ kind: 'grant', payload: refreshed })
    expect(await credentials.list()).toEqual(expect.arrayContaining([
      { providerId: id, type: 'api_key' }, { providerId: route, type: 'oauth' },
    ]))

    await credentials.delete(route)
    expect(await credentials.read(route)).toBeUndefined()
    expect(await credentials.read(id)).toEqual(baseCredential)
    await credentials.modify(route, () => Promise.resolve(refreshed))
    await credentials.delete(id)
    expect(await credentials.read(id)).toBeUndefined()
    expect(await credentials.read(route)).toEqual(refreshed)
  })

  it('never falls back to ambient keys or the base credential when no usable alias grant exists', async () => {
    const native = catalogProvider(route)!
    const dispatch = vi.spyOn(native, 'streamSimple').mockImplementation(model => completed(response(model)))
    const refresh = vi.spyOn(native.auth.oauth!, 'refresh').mockRejectedValue(new Error('test refresh refused'))
    const toAuth = vi.spyOn(native.auth.oauth!, 'toAuth').mockRejectedValue(new Error('unexpected auth derivation'))
    const apiKeyResolve = native.auth.apiKey === undefined ? undefined : vi.spyOn(native.auth.apiKey, 'resolve')

    // Missing grant, incorrectly stored API key, and failed refresh must all
    // fail closed, even when every ambient name resolves to a usable-looking key.
    for (const aliasCredential of [undefined, { type: 'api_key' as const, key: 'wrong-route-key' }, grant('expired', 0)]) {
      const auth = memoryAuth({ [id]: grant('base-grant') })
      if (aliasCredential !== undefined) auth.stored.set(route, aliasCredential)
      const env = vi.fn(() => Promise.resolve('ambient-api-key'))
      const fileExists = vi.fn(() => Promise.resolve(false))
      auth.authContext = { env, fileExists }
      const ctx = await adapterContext(route, auth)
      const result = await assemble(ctx, { provider: route, model: firstModel(routeProvider(route)).id, messages: [] })
      expect(result.finish).toMatchObject({ kind: 'error' })
      expect(env).not.toHaveBeenCalled()
      expect(fileExists).not.toHaveBeenCalled()
      expect(auth.stored.get(id)).toEqual(expect.objectContaining({ access: 'base-grant' }))
    }
    expect(dispatch).not.toHaveBeenCalled()
    expect(toAuth).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledOnce()
    if (apiKeyResolve !== undefined) expect(apiKeyResolve).not.toHaveBeenCalled()
  })

  it('translates both native dispatch methods without mutating catalog models or caller history', () => {
    const native = catalogProvider(route)!
    const alias = routeProvider(route)
    const model = firstModel(alias)
    const own = response(model)
    const foreign = { ...own, provider: 'unrelated-provider' }
    const context = normalizeContext({ messages: [own, foreign] })
    const before = structuredClone(context)
    for (const method of ['stream', 'streamSimple'] as const) {
      const spy = vi.spyOn(native, method).mockImplementation((dispatched: Model<Api>) => completed(response(dispatched)))
      const options = { apiKey: 'already-resolved-grant' }
      alias[method](model, context, options)
      const [dispatched, history, forwarded] = spy.mock.calls[0]!
      expect(spy.mock.contexts[0]).toBe(native)
      expect(dispatched).toEqual({ ...model, provider: id })
      expect(dispatched).not.toBe(model)
      expect(history.messages[0]).toEqual({ ...own, provider: id })
      expect(history.messages[1]).toEqual(foreign)
      expect(forwarded).toBe(options)
      expect(model.provider).toBe(route)
      expect(context).toEqual(before)
    }
  })

  it('writes alias replay state and restores native history with signatures on the next adapter request', async () => {
    const native = catalogProvider(route)!
    vi.spyOn(native.auth.oauth!, 'toAuth').mockResolvedValue({ apiKey: 'alias-access' })
    const refresh = vi.spyOn(native.auth.oauth!, 'refresh').mockRejectedValue(new Error('fresh grant must not refresh'))
    const nativeResponses: AssistantMessage[] = []
    const stream = vi.spyOn(native, 'streamSimple').mockImplementation((model) => {
      const message = response(model)
      nativeResponses.push(message)
      return completed(message)
    })
    const degrade = vi.fn()
    const ctx = await adapterContext(route, memoryAuth({ [route]: grant('alias-access') }), degrade)
    const model = firstModel(routeProvider(route))
    const first = await assemble(ctx, { provider: route, model: model.id, messages: [] })
    expect(first.finish).toEqual({ kind: 'stop' })
    expect(first.message.source).toMatchObject({
      kind: 'model', provider: route, model: model.id,
      replayState: {
        response: { kind: 'pi-ai', provider: route, model: model.id, responseId: 'native-response-id' },
        blocks: [{ type: 'text', textSignature: 'opaque-text-signature' }],
      },
    })
    const saved = structuredClone(first.message)
    const second = await assemble(ctx, { provider: route, model: model.id, messages: [first.message] })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls.every(([dispatched]) => dispatched.provider === id)).toBe(true)
    expect(stream.mock.calls[1]?.[1].messages[0]).toMatchObject({
      role: 'assistant', provider: id, model: model.id, responseId: 'native-response-id',
      content: [{ type: 'text', text: 'hello', textSignature: 'opaque-text-signature' }],
    })
    expect(nativeResponses.every(message => message.provider === id)).toBe(true)
    expect(first.message).toEqual(saved)
    expect(degrade).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('OAuth route classification', () => {
  it("follows pi-ai's isSubscription: plans are subscriptions, OpenRouter's issued key is pay-per-use", () => {
    for (const id of oauthProviderIds()) {
      const oauth = oauthCatalogProvider(id)!.auth.oauth!
      expect(oauthRouteAuth(id)).toBe(oauth.isSubscription === true ? 'subscription' : 'api-key')
      expect(oauthRouteDisplayName(id)).toBe(`${oauthCatalogProvider(id)!.name} ${oauth.isSubscription === true ? 'Plan' : 'OAuth'}`)
    }
    expect(oauthRouteAuth('anthropic-oauth')).toBe('subscription')
    expect(oauthRouteAuth('openai-codex-oauth')).toBe('subscription')
    expect(oauthRouteAuth('openrouter-oauth')).toBe('api-key')
    expect(oauthRouteAuth('anthropic')).toBeUndefined()
  })
})
