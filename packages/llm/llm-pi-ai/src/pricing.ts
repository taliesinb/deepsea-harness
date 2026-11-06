/**
 * List prices from the installed pi-ai catalog, published as provider-neutral
 * `LlmModelPricing` so consumers (billing displays) can estimate spend without
 * importing pi-ai themselves.
 */

import type { Api, Model, ModelCost } from '@earendil-works/pi-ai'
import { builtinProviders, getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all'
import type { LlmModelPricing, LlmModelTokenRates } from '@deepseek-ai/dsh-llm'
import { catalogModels, catalogProvider, oauthRouteAuth } from './catalog.ts'

/** Installed catalog models per route; the installed catalog is fixed for the process. */
const routeModels = new Map<string, Map<string, Model<Api>>>()
let subscriptionOnly: ReadonlySet<string> | undefined

/**
 * Plain decimal spelling of one catalog rate.
 * @param value - rate per million tokens.
 * @returns the decimal string, or `undefined` for a negative or non-finite rate.
 */
function decimal(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined
  const text = String(value)
  return /e/i.test(text) ? value.toFixed(18).replace(/\.?0+$/, '') : text
}

/**
 * Convert one pi-ai rate set.
 * @param cost - pi-ai per-million rates.
 * @returns provider-neutral rates, or `undefined` when a rate is malformed.
 */
function rates(cost: Pick<ModelCost, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): LlmModelTokenRates | undefined {
  const inputPerMillion = decimal(cost.input)
  const outputPerMillion = decimal(cost.output)
  const cacheReadPerMillion = decimal(cost.cacheRead)
  const cacheWritePerMillion = decimal(cost.cacheWrite)
  if (inputPerMillion === undefined || outputPerMillion === undefined) return undefined
  return {
    inputPerMillion,
    outputPerMillion,
    ...cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion },
    ...cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion },
  }
}

/**
 * Catalog provider ids whose only authentication is a subscription sign-in:
 * their catalog rates are list prices, not what the route charges.
 * @returns the subscription-only catalog provider ids.
 */
function subscriptionOnlyProviders(): ReadonlySet<string> {
  subscriptionOnly ??= new Set(builtinProviders()
    .filter(provider => provider.auth.oauth?.isSubscription === true && provider.auth.apiKey === undefined)
    .map(provider => provider.id))
  return subscriptionOnly
}

/**
 * Published list prices for one exact route, when the installed catalog
 * describes the model and the route is billed per token.
 * @param provider - provider route key.
 * @param model - exact model id.
 * @returns USD list prices, or `undefined` for subscription routes, models the
 *   catalog does not describe, and catalog entries without rates.
 */
export function catalogPricing(provider: string, model: string): LlmModelPricing | undefined {
  return subscriptionRoute(provider) ? undefined : catalogListPricing(provider, model)
}

/**
 * Whether a route is billed by subscription rather than per token: a dedicated
 * `-oauth` route whose sign-in pi-ai marks `isSubscription` (not OpenRouter's,
 * which issues a pay-per-use key), or a catalog provider whose only
 * authentication is such a sign-in.
 * @param provider - provider route key.
 * @returns true for subscription routes.
 */
export function subscriptionRoute(provider: string): boolean {
  const oauth = oauthRouteAuth(provider)
  if (oauth !== undefined) return oauth === 'subscription'
  const catalogId = catalogProvider(provider)?.id
  return catalogId !== undefined && subscriptionOnlyProviders().has(catalogId)
}

/**
 * The installed catalog's list prices for a route's model regardless of how
 * the route is billed: for a subscription route, what the same usage would
 * cost on the provider's per-token API.
 * @param provider - provider route key.
 * @param model - exact model id.
 * @returns USD list prices, or `undefined` for models the catalog does not
 *   describe and catalog entries without rates.
 */
export function catalogListPricing(provider: string, model: string): LlmModelPricing | undefined {
  if (catalogProvider(provider) === undefined) return undefined
  let models = routeModels.get(provider)
  if (models === undefined) {
    models = catalogModels(provider)
    routeModels.set(provider, models)
  }
  const cost = models.get(model)?.cost
  if (cost === undefined || (cost.input === 0 && cost.output === 0)) return undefined
  const base = rates(cost)
  if (base === undefined) return undefined
  const tiers = (cost.tiers ?? []).flatMap((tier) => {
    const tierRates = rates(tier)
    return tierRates === undefined || !Number.isSafeInteger(tier.inputTokensAbove)
      ? []
      : [{ ...tierRates, inputTokensAbove: tier.inputTokensAbove }]
  })
  const generatedAt = getBuiltinModelDataGeneratedAt()
  return {
    ...base,
    currency: 'USD',
    ...tiers.length === 0 ? {} : { tiers },
    source: generatedAt === undefined ? 'pi-ai catalog' : `pi-ai catalog ${new Date(generatedAt).toISOString().slice(0, 10)}`,
  }
}
