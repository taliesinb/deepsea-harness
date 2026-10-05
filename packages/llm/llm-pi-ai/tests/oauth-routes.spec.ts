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
import { catalogProvider, oauthCatalogProvider, oauthProviderIds } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
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
  })

  it('offers every alias in the dormant plugin directory without a configured profile', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: {} })
    const directory = ctx.llm.listConfigurableProviders()
    for (const { id, route } of flows) {
      expect(directory.filter(entry => entry.provider === route)).toEqual([{
        provider: route,
        displayName: `${catalogProvider(id)!.name} OAuth`,
        settingsNs: 'llm-pi-ai', settingsPath: ['providers', route], declared: false,
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
