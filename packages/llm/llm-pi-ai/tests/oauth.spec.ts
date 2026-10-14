import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Credential } from '@earendil-works/pi-ai'

const login = vi.hoisted(() => vi.fn())

// The whole of what this module does with pi-ai is run one provider's login
// against a collection built with the harness store, so the collection is the
// boundary worth observing; a real login would open a browser.
vi.mock('../src/models.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/models.ts')>(),
  createModels: () => ({ setProvider: () => {}, login }),
}))

const { credentialStoreFrom, authContextFrom, recordKeyFor } = await import('../src/auth.ts')
const { registerPiAiOAuthFlows } = await import('../src/oauth.ts')

const CODEX = recordKeyFor('openai-codex-oauth')
const dirs: string[] = []

/** A context with the record store, the seam, and every pi-ai login flow. */
async function harness(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  registerPiAiOAuthFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
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
  converse: (interaction: AuthInteraction) => Promise<void>,
  request: { key?: CredentialKey; method?: string } = {},
): Promise<ReturnType<typeof surface>> {
  const ui = surface()
  login.mockImplementation(async (providerId: string, _type: AuthType, interaction: AuthInteraction) => {
    await converse(interaction)
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

describe('pi-ai OAuth flows', () => {
  it('offers one flow per installed provider, with the methods that provider ships', async () => {
    const ctx = await harness()
    const offered = ctx.authorization.list()

    // The OAuth-only provider is exactly the case this exists for: nothing
    // else could ever configure it.
    expect(offered.find(entry => entry.key === CODEX)?.methods)
      .toEqual([{ id: 'oauth', label: expect.stringContaining('ChatGPT') as string }])
    // Anthropic's subscription login owns a separate credential and route.
    expect(offered.find(entry => entry.key === recordKeyFor('anthropic-oauth'))?.methods.map(one => one.id))
      .toEqual(['oauth'])
    expect(offered.find(entry => entry.key === recordKeyFor('anthropic'))).toBeUndefined()
    // OAuth commands never offer key-only providers.
    expect(offered.find(entry => entry.key === recordKeyFor('deepseek'))).toBeUndefined()
  })

  it('runs the pi-ai auth type the chosen method names', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve())
    expect(login).toHaveBeenLastCalledWith('openai-codex-oauth', 'oauth', expect.anything())

    await attempt(ctx, () => Promise.resolve(), { key: recordKeyFor('anthropic-oauth') })
    expect(login).toHaveBeenLastCalledWith('anthropic-oauth', 'oauth', expect.anything())
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic-oauth'))).resolves.toMatchObject({ kind: 'grant' })
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic'))).resolves.toBeUndefined()
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

  it('sends people to the provider simulator\'s pages while simulating', async () => {
    vi.stubEnv('DSH_PROVIDER_SIMULATOR', 'http://127.0.0.1:4100')
    try {
      const ctx = await harness()
      const ui = await attempt(ctx, (interaction) => {
        interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?code=true' })
        interaction.notify({ type: 'device_code', userCode: 'AB-12', verificationUri: 'https://auth.x.ai/device' })
        interaction.notify({ type: 'info', message: 'Docs', links: [{ url: 'https://docs.example/page' }] })
        return Promise.resolve()
      })
      expect(ui.notices.slice(0, 3)).toEqual([
        { message: 'Open this page to continue signing in.', url: 'http://127.0.0.1:4100/claude.ai/oauth/authorize?code=true' },
        { message: 'Enter this code on the verification page to finish signing in.', url: 'http://127.0.0.1:4100/auth.x.ai/device', code: 'AB-12' },
        { message: 'Docs', url: 'https://docs.example/page' },
      ])
    } finally {
      vi.unstubAllEnvs()
    }
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

    const withdrawable = ui.prompts[4]?.signal
    expect(ui.prompts.map(({ signal: _signal, ...prompt }) => prompt)).toEqual([
      { kind: 'text', message: 'Your workspace', placeholder: 'acme' },
      { kind: 'secret', message: 'Paste the key' },
      { kind: 'secret', message: 'Paste the token', placeholder: 'sk-…' },
      { kind: 'select', message: 'Which account?', options: [{ id: 'a', label: 'Work' }] },
      { kind: 'text', message: 'Paste the code' },
    ])
    // Only the racing question carries a signal, and pi-ai's withdrawal reaches it.
    expect(ui.prompts.slice(0, 4).every(prompt => prompt.signal === undefined)).toBe(true)
    expect(withdrawable?.aborted).toBe(false)
    withdraw.abort()
    expect(withdrawable?.aborted).toBe(true)
  })

  it('withdraws a racing question when the attempt is cancelled, so the flow can close its callback server', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    let questionSignal: AbortSignal | undefined
    const asked = Promise.withResolvers<undefined>()
    login.mockImplementation(async (_id: string, _type: AuthType, interaction: AuthInteraction) => {
      // pi-ai's loopback shape: its own signal for the manual question, aborted only after the await.
      const manual = new AbortController()
      try { await interaction.prompt({ type: 'manual_code', message: 'Paste the code', signal: manual.signal }) }
      finally { manual.abort() }
      return new Promise(() => {})
    })
    const ui = surface()
    ui.prompt = (prompt) => {
      questionSignal = prompt.signal
      asked.resolve(undefined)
      return new Promise((_resolve, reject) => { prompt.signal?.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true }) })
    }
    const outcome = ctx.authorization.begin({ key: CODEX, interaction: ui, signal: controller.signal })
    await asked.promise
    expect(questionSignal?.aborted).toBe(false)
    controller.abort()
    await expect(outcome).resolves.toEqual({ status: 'cancelled' })
    expect(questionSignal?.aborted).toBe(true)
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
