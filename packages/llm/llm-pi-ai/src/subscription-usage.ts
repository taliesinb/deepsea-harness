/**
 * Subscription usage for OAuth routes: one read of the provider's usage
 * endpoint with the route's own (refreshed) sign-in token. No model inference.
 */

import type { Models } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmSubscriptionUsage, LlmSubscriptionWindow } from '@deepseek-ai/dsh-llm'
import { oauthCatalogProvider } from './catalog.ts'

/** Anthropic's account usage endpoint (the data behind Claude Code's `/usage`). */
export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const ANTHROPIC_WINDOWS = [['five_hour', '5h'], ['seven_day', '7d']] as const
const TIMEOUT_MS = 15_000

/**
 * Parse Anthropic's usage body defensively; unknown or null buckets are ignored.
 * @param body - parsed JSON response.
 * @param observedAt - reading time.
 * @returns normalized usage.
 */
export function parseAnthropicUsage(body: unknown, observedAt: string): LlmSubscriptionUsage {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
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
  if (oauthCatalogProvider(provider)?.id !== 'anthropic') return undefined
  const auth = await models.getAuth(provider)
  const token = auth?.auth.apiKey
  // A proxied/custom endpoint has no known usage contract; only the canonical API is read.
  if (token === undefined || !token.startsWith('sk-ant-oat')) return undefined
  if (auth?.auth.baseUrl !== undefined && new URL(auth.auth.baseUrl).host !== 'api.anthropic.com') return undefined
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(ANTHROPIC_USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'))
    throw new LlmError(`subscription usage rate limited${Number.isFinite(seconds) ? `; retry after ${String(seconds)}s` : ''}`, 'RATE_LIMIT')
  }
  if (!response.ok) throw new LlmError(`subscription usage request failed with HTTP ${String(response.status)}`, response.status === 401 || response.status === 403 ? 'AUTH' : 'PROVIDER_ERROR')
  return parseAnthropicUsage(await response.json(), new Date().toISOString())
}
