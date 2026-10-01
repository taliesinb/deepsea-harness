/**
 * Subscription usage for OAuth routes: one read of the provider's usage
 * endpoint with the route's own (refreshed) sign-in token. No model inference.
 */

import type { Models } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmResponseCost, LlmSubscriptionUsage, LlmSubscriptionWindow } from '@deepseek-ai/dsh-llm'
import { catalogProvider, oauthCatalogProvider } from './catalog.ts'

/** Anthropic's account usage endpoint (the data behind Claude Code's `/usage`). */
export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const ANTHROPIC_WINDOWS = [['five_hour', '5h'], ['seven_day', '7d']] as const
/** ChatGPT's Codex usage endpoint (the data behind the Codex CLI's `/status`). */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_WINDOWS = ['primary_window', 'secondary_window'] as const
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth'
const TIMEOUT_MS = 15_000

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Parse Anthropic's usage body defensively; unknown or null buckets are ignored.
 * @param body - parsed JSON response.
 * @param observedAt - reading time.
 * @returns normalized usage.
 */
export function parseAnthropicUsage(body: unknown, observedAt: string): LlmSubscriptionUsage {
  const root = record(body) ?? {}
  const windows: LlmSubscriptionWindow[] = []
  for (const [key, label] of ANTHROPIC_WINDOWS) {
    const bucket = record(root[key])
    const used = bucket?.utilization
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    const resetAt = typeof bucket?.resets_at === 'string' && Number.isFinite(Date.parse(bucket.resets_at))
      ? new Date(bucket.resets_at).toISOString()
      : undefined
    windows.push({ label, usedPercent: Math.min(100, Math.max(0, used)), ...resetAt === undefined ? {} : { resetAt } })
  }
  const extra = record(root.extra_usage)?.is_enabled
  return { windows, ...typeof extra === 'boolean' ? { extraUsageEnabled: extra } : {}, observedAt }
}

/**
 * Label a Codex window by its length: `5h`, `7d`, else whole hours/days/minutes.
 * @param seconds - `limit_window_seconds`.
 * @returns a short duration label.
 */
function codexWindowLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes > 0 && minutes % 1440 === 0) return `${String(minutes / 1440)}d`
  if (minutes > 0 && minutes % 60 === 0) return `${String(minutes / 60)}h`
  return `${String(minutes)}m`
}

/**
 * Parse ChatGPT's Codex usage body defensively; absent or malformed windows are ignored.
 * Credits, plan type and model availability are not part of the normalized reading.
 * @param body - parsed JSON response.
 * @param observedAt - reading time.
 * @returns normalized usage.
 */
export function parseCodexUsage(body: unknown, observedAt: string): LlmSubscriptionUsage {
  const limits = record(record(body)?.rate_limit)
  const windows: LlmSubscriptionWindow[] = []
  for (const key of CODEX_WINDOWS) {
    const window = record(limits?.[key])
    const used = window?.used_percent
    const seconds = window?.limit_window_seconds
    if (typeof used !== 'number' || !Number.isFinite(used) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue
    const reset = window?.reset_at
    const resetAt = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined
    const usedPercent = Math.min(100, Math.max(0, used))
    windows.push({ label: codexWindowLabel(seconds), usedPercent, ...resetAt === undefined ? {} : { resetAt } })
  }
  return { windows, observedAt }
}

/**
 * The ChatGPT account id carried in a Codex access token (as pi-ai's transport reads it).
 * @param token - OAuth access token (a JWT).
 * @returns the account id, or `undefined` when the token carries none.
 */
function codexAccountId(token: string): string | undefined {
  try {
    const payload = token.split('.')[1]
    if (payload === undefined) return undefined
    const claims = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    const id = record(claims?.[JWT_AUTH_CLAIM])?.chatgpt_account_id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * GET one usage endpoint with cancellation, timeout and the shared error mapping.
 * @param url - endpoint.
 * @param headers - request headers, including the route's credential.
 * @param signal - optional cancellation.
 * @returns the parsed JSON body.
 */
async function getUsage(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    headers: { ...headers, accept: 'application/json' },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'))
    throw new LlmError(`subscription usage rate limited${Number.isFinite(seconds) ? `; retry after ${String(seconds)}s` : ''}`, 'RATE_LIMIT')
  }
  if (!response.ok) throw new LlmError(`subscription usage request failed with HTTP ${String(response.status)}`, response.status === 401 || response.status === 403 ? 'AUTH' : 'PROVIDER_ERROR')
  return response.json()
}

/**
 * Read one OAuth route's current account usage.
 * @param models - the adapter snapshot's collection, which owns credential refresh.
 * @param provider - provider route key.
 * @param signal - optional cancellation.
 * @returns usage, or `undefined` for routes without a supported usage endpoint.
 */
export async function readSubscriptionUsage(
  models: Models,
  provider: string,
  signal?: AbortSignal,
): Promise<LlmSubscriptionUsage | undefined> {
  // `openai-codex` is subscription-only, so its native id and its `-oauth` route are both sign-ins.
  const native = oauthCatalogProvider(provider)?.id ?? (catalogProvider(provider)?.id === 'openai-codex' ? 'openai-codex' : undefined)
  if (native !== 'anthropic' && native !== 'openai-codex') return undefined
  const auth = await models.getAuth(provider)
  const token = auth?.auth.apiKey
  // A proxied/custom endpoint has no known usage contract; only the canonical API is read.
  const baseHost = auth?.auth.baseUrl === undefined ? undefined : new URL(auth.auth.baseUrl).host
  if (native === 'anthropic') {
    if (token === undefined || !token.startsWith('sk-ant-oat')) return undefined
    if (baseHost !== undefined && baseHost !== 'api.anthropic.com') return undefined
    const body = await getUsage(ANTHROPIC_USAGE_URL, {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    }, signal)
    return parseAnthropicUsage(body, new Date().toISOString())
  }
  const accountId = token === undefined ? undefined : codexAccountId(token)
  if (token === undefined || accountId === undefined) return undefined
  if (baseHost !== undefined && baseHost !== 'chatgpt.com') return undefined
  const body = await getUsage(CODEX_USAGE_URL, { authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId }, signal)
  return parseCodexUsage(body, new Date().toISOString())
}

/** OpenRouter's per-generation accounting endpoint. */
export const OPENROUTER_GENERATION_URL = 'https://openrouter.ai/api/v1/generation'

/**
 * Read OpenRouter's recorded charge for one past generation.
 * @param apiKey - the route's API key.
 * @param provider - provider route key.
 * @param responseId - OpenRouter generation id (`gen-…`).
 * @param signal - optional cancellation.
 * @returns USD charge, or `undefined` for other routes, missing keys, or ids that are not generation ids.
 */
export async function readResponseCost(
  apiKey: string | undefined,
  provider: string,
  responseId: string,
  signal?: AbortSignal,
): Promise<LlmResponseCost | undefined> {
  if (catalogProvider(provider)?.id !== 'openrouter' || apiKey === undefined || !/^gen-[A-Za-z0-9_-]{1,160}$/.test(responseId)) return undefined
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(`${OPENROUTER_GENERATION_URL}?id=${encodeURIComponent(responseId)}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (response.status === 429) throw new LlmError('response cost lookup rate limited', 'RATE_LIMIT')
  if (!response.ok) throw new LlmError(`response cost lookup failed with HTTP ${String(response.status)}`, response.status === 401 || response.status === 403 ? 'AUTH' : 'PROVIDER_ERROR')
  const body = await response.json() as { data?: { total_cost?: unknown } }
  const cost = body.data?.total_cost
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new LlmError('response cost lookup returned no total_cost', 'PROVIDER_ERROR')
  const text = String(cost)
  return { amount: /e/i.test(text) ? cost.toFixed(18).replace(/\.?0+$/, '') : text, currency: 'USD' }
}
