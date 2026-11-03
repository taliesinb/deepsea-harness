import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Credential, LoginOptions } from '@earendil-works/pi-ai'

const login = vi.hoisted(() => vi.fn())

// The whole of what this module does with pi-ai is run one provider's login
// against a collection built with the harness store, so the collection is the
// boundary worth observing; a real login would open a browser.
vi.mock('../src/models.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/models.ts')>(),
  createModels: () => ({ setProvider: () => {}, login }),
}))

const { credentialStoreFrom, authContextFrom, DEVICE_ID_KEY, recordKeyFor } = await import('../src/auth.ts')
const { registerPiAiFlows } = await import('../src/login.ts')

const CODEX = recordKeyFor('openai-codex-oauth')
const dirs: string[] = []

/** A context with the record store, the seam, and every pi-ai login flow. */
async function harness(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  registerPiAiFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
  return ctx
}

/** An interaction recording everything a flow says, answering every question. */
function surface(answer = 'typed'): AuthorizationInteraction & {
  notices: AuthorizationNotice[]
  prompts: AuthorizationPrompt[]
} {
  const notices: AuthorizationNotice[] = []
  const prompts: AuthorizationPrompt[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => {
      prompts.push(prompt)
      return Promise.resolve(answer)
    },
  }
}

/** Drive one attempt, letting the mocked login talk back through `converse`. */
async function attempt(
  ctx: Context,
  converse: (interaction: AuthInteraction, options?: LoginOptions) => Promise<void>,
  request: { key?: CredentialKey; method?: string } = {},
): Promise<ReturnType<typeof surface>> {
  const ui = surface()
  login.mockImplementation(async (
    providerId: string, _type: AuthType, interaction: AuthInteraction, options?: LoginOptions,
  ) => {
    await converse(interaction, options)
    const granted: Credential = { type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }
    await credentialStoreFrom(ctx).modify(providerId, () => Promise.resolve(granted))
    return granted
  })
  await expect(ctx.authorization.begin({
    key: request.key ?? CODEX,
    interaction: ui,
    ...request.method === undefined ? {} : { method: request.method },
  })).resolves.toEqual({ status: 'authorized' })
  return ui
}

afterEach(async () => {
  login.mockReset()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('pi-ai login flows', () => {
  it('offers key logins on provider routes and OAuth sign-ins on their -oauth routes', async () => {
    const ctx = await harness()
    const offered = ctx.authorization.list()
    const methods = (route: string): string[] | undefined =>
      offered.find(entry => entry.key === recordKeyFor(route))?.methods.map(one => one.id)

    // The OAuth-only provider is exactly the case this exists for: nothing
    // else could ever configure it. Its own route has no key login to offer.
    expect(offered.find(entry => entry.key === CODEX)?.methods)
      .toEqual([{ id: 'oauth', label: expect.stringContaining('ChatGPT') as string }])
    expect(methods('openai-codex')).toBeUndefined()
    // A provider offering both splits them: the subscription on its own route,
    // so its grant never replaces the provider route's API key.
    expect(methods('anthropic')).toEqual(['api-key'])
    expect(methods('anthropic-oauth')).toEqual(['oauth'])
    // A key-only provider still gets a flow, because pi-ai collects the key
    // through its own prompt rather than leaving it to the settings form.
    expect(methods('deepseek')).toEqual(['api-key'])
    expect(methods('deepseek-oauth')).toBeUndefined()
    // Sign in with ChatGPT is offered too: the flow supplies the installation
    // device id it requires.
    expect(methods('openai')).toEqual(['api-key'])
    expect(offered.find(entry => entry.key === recordKeyFor('openai-oauth'))?.methods)
      .toEqual([{ id: 'oauth', label: 'Sign in with ChatGPT' }])
  })

  it('runs the pi-ai auth type the chosen flow names, under the route it signs into', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve())
    expect(login).toHaveBeenLastCalledWith('openai-codex-oauth', 'oauth', expect.anything(), expect.anything())

    await attempt(ctx, () => Promise.resolve(), { key: recordKeyFor('anthropic'), method: 'api-key' })
    expect(login).toHaveBeenLastCalledWith('anthropic', 'api_key', expect.anything())

    await ctx.credentials.deleteRecord(recordKeyFor('anthropic'))
    await attempt(ctx, () => Promise.resolve(), { key: recordKeyFor('anthropic-oauth') })
    expect(login).toHaveBeenLastCalledWith('anthropic-oauth', 'oauth', expect.anything(), expect.anything())
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic-oauth'))).resolves.toMatchObject({ kind: 'grant' })
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic'))).resolves.toBeUndefined()
  })

  it('stores no device id for a sign-in that never asks for one', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve())

    await expect(ctx.credentials.readRecord(DEVICE_ID_KEY)).resolves.toBeUndefined()
  })

  it('creates the installation device id on first use and presents it to every later sign-in', async () => {
    const ctx = await harness()
    const asked: string[] = []
    const ask = (_interaction: AuthInteraction, options?: LoginOptions): Promise<void> => {
      asked.push(options!.getDeviceId!(), options!.getDeviceId!())
      return Promise.resolve()
    }

    await attempt(ctx, ask, { key: recordKeyFor('openai-oauth') })
    const [id] = asked
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    await expect(ctx.credentials.readRecord(DEVICE_ID_KEY)).resolves.toEqual({ kind: 'grant', payload: { id } })

    await attempt(ctx, ask, { key: recordKeyFor('openai-oauth') })
    expect(asked).toEqual([id, id, id, id])
  })

  it('replaces an unreadable device record instead of presenting it', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(DEVICE_ID_KEY, () => Promise.resolve({ kind: 'grant', payload: { id: 'not-a-uuid' } }))
    let presented: string | undefined

    await attempt(ctx, (_interaction, options) => {
      presented = options?.getDeviceId?.()
      return Promise.resolve()
    }, { key: recordKeyFor('openai-oauth') })

    expect(presented).not.toBe('not-a-uuid')
    await expect(ctx.credentials.readRecord(DEVICE_ID_KEY)).resolves.toEqual({ kind: 'grant', payload: { id: presented } })
  })

  it('commits what the login produced, where the adapter reads it back', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve())

    await expect(ctx.credentials.readRecord(CODEX)).resolves.toEqual({
      kind: 'grant',
      payload: { type: 'oauth', access: 'at', refresh: 'rt', expires: 1 },
    })
  })

  it('restates every pi-ai login event in the neutral vocabulary', async () => {
    const ctx = await harness()
    const events: AuthEvent[] = [
      { type: 'info', message: 'Read this first', links: [{ url: 'https://help.example' }] },
      { type: 'info', message: 'Nothing to open' },
      { type: 'auth_url', url: 'https://auth.example/start', instructions: 'Approve in the tab' },
      { type: 'auth_url', url: 'https://auth.example/plain' },
      { type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example' },
      { type: 'progress', message: 'Exchanging the code' },
      // pi-ai's event union is open; an unrecognised member must still show
      // the human that something is happening.
      { type: 'quantum-handshake' } as unknown as AuthEvent,
    ]

    const ui = await attempt(ctx, (interaction) => {
      for (const event of events) interaction.notify(event)
      return Promise.resolve()
    })

    expect(ui.notices).toEqual([
      { message: 'Read this first', url: 'https://help.example' },
      { message: 'Nothing to open' },
      { message: 'Approve in the tab', url: 'https://auth.example/start' },
      { message: 'Open this page to continue signing in.', url: 'https://auth.example/plain' },
      {
        message: 'Enter this code on the verification page to finish signing in.',
        url: 'https://device.example',
        code: 'WXYZ-1234',
      },
      { message: 'Exchanging the code' },
      { message: 'Signing in…' },
    ])
  })

  it('restates every pi-ai prompt, carrying the per-prompt withdrawal signal', async () => {
    const ctx = await harness()
    const withdraw = new AbortController()
    const prompts: AuthPrompt[] = [
      { type: 'text', message: 'Your workspace', placeholder: 'acme' },
      { type: 'secret', message: 'Paste the key' },
      { type: 'secret', message: 'Paste the token', placeholder: 'sk-…' },
      { type: 'select', message: 'Which account?', options: [{ id: 'a', label: 'Work' }] },
      // The manual-code question a browser callback can win the race against.
      { type: 'manual_code', message: 'Paste the code', signal: withdraw.signal },
    ]

    const ui = await attempt(ctx, async (interaction) => {
      for (const prompt of prompts) await interaction.prompt(prompt)
    })

    expect(ui.prompts).toEqual([
      { kind: 'text', message: 'Your workspace', placeholder: 'acme' },
      { kind: 'secret', message: 'Paste the key' },
      { kind: 'secret', message: 'Paste the token', placeholder: 'sk-…' },
      { kind: 'select', message: 'Which account?', options: [{ id: 'a', label: 'Work' }] },
      { kind: 'text', message: 'Paste the code', signal: withdraw.signal },
    ])
  })

  it('hands the flow the attempt-wide cancellation signal', async () => {
    const ctx = await harness()
    let seen: AbortSignal | undefined
    const controller = new AbortController()
    login.mockImplementation((_id: string, _type: AuthType, interaction: AuthInteraction) => {
      seen = interaction.signal
      controller.abort()
      return new Promise(() => {})
    })

    await expect(ctx.authorization.begin({
      key: CODEX,
      interaction: surface(),
      signal: controller.signal,
    })).resolves.toEqual({ status: 'cancelled' })
    expect(seen?.aborted).toBe(true)
  })
})
