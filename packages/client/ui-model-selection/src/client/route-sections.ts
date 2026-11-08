/**
 * What the composer model menu sections and filters by: one section per
 * provider and access kind (a plan sign-in, a first-party API key, each
 * upstream vendor of an OpenRouter route, a server on this machine), the
 * capability flags the Host publishes per model, and which models a newer
 * version of the same line supersedes. Access kinds come from the route
 * metadata the catalog carries (`auth`, `catalogProvider`), never from route
 * ids or names; an OpenRouter route is split by the vendor its model ids and
 * names carry (`anthropic/…`, `Anthropic: …`).
 */
import type { ModelCapabilities, ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { orderModelProviders } from './provider-order.ts'

/**
 * How a route is reached: a plan sign-in (`auth: subscription`), a
 * first-party API key (the default, including routes that report no auth),
 * OpenRouter (a route whose catalog provider is `openrouter`, keyed or signed
 * in), or a model served on this machine (`auth: local`).
 */
export type ModelRoute = 'plan' | 'api' | 'openrouter' | 'local'

/** Kind filter order, and the order of a provider's sections. */
export const MODEL_ROUTES: readonly ModelRoute[] = ['plan', 'api', 'openrouter', 'local']

/**
 * Classify one provider group by its route metadata.
 * @param group - the catalog group's billing kind and catalog provider.
 * @returns the access kind of the group's route.
 */
export function modelRoute(group: Pick<ModelProviderGroup, 'auth' | 'catalogProvider'>): ModelRoute {
  if (group.auth === 'subscription') return 'plan'
  if (group.auth === 'local') return 'local'
  return group.catalogProvider === 'openrouter' ? 'openrouter' : 'api'
}

/**
 * The heading of a route: its configured name, or, for a route that carries
 * only its bare key as its name, its catalog provider's display name.
 * @param group - the catalog group.
 * @returns the heading text.
 */
export function routeTitle(group: Pick<ModelProviderGroup, 'id' | 'name' | 'vendor'>): string {
  return group.name === group.id ? group.vendor ?? group.name : group.name
}

/** One section of the model menu: one route, or one upstream vendor of an OpenRouter route. */
export interface ModelSection {
  /** Unique key: the route id, followed by the vendor for an OpenRouter split. */
  readonly key: string
  /** The route id the section's models are selected through. */
  readonly provider: string
  /** The route's access kind. */
  readonly route: ModelRoute
  /** Heading text, beside the kind's glyph. */
  readonly title: string
  /**
   * Heading for a list without glyphs: the title, followed by the route's
   * name for an OpenRouter vendor (`Anthropic \u00b7 OpenRouter`).
   */
  readonly label: string
  /** Models in catalog order; an OpenRouter vendor's names lose their `Vendor: ` prefix. */
  readonly models: readonly ModelCatalogModel[]
}

/** Letters and digits only, lower-cased: `Z.ai` and `z-ai` are both `zai`. */
function normalized(name: string): string {
  return name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Whether two normalized provider names name one provider: equal, or one a prefix of the other (`deepseek`, `deepseekaccount`). */
function sameProvider(left: string, right: string): boolean {
  if (left === right) return true
  return Math.min(left.length, right.length) >= 3 && (left.startsWith(right) || right.startsWith(left))
}

/** A model name's `Vendor: ` prefix and the rest. */
const VENDOR_NAME = /^([^:]+):\s+(.+)$/u

/**
 * Split an OpenRouter route by upstream vendor: the vendor slug of a model id
 * (`anthropic/claude-…`, `~anthropic/…`), titled by the `Vendor: ` name prefix
 * most of that slug's models carry, so `meta/…` and `meta-llama/…` (both
 * `Meta: …`) share a section. Models whose vendor has no title stay in one
 * section of the route itself.
 */
function vendorSections(group: ModelProviderGroup, title: string): { vendors: ModelSection[]; rest: ModelSection | undefined } {
  const slugOf = (model: ModelCatalogModel): string | undefined => {
    const slash = model.id.indexOf('/')
    return slash <= 0 ? undefined : model.id.slice(0, slash).replace(/^~/u, '')
  }
  const counts = new Map<string, Map<string, number>>()
  for (const model of group.models) {
    const slug = slugOf(model)
    const prefix = VENDOR_NAME.exec(model.name)?.[1]?.trim()
    if (slug === undefined || prefix === undefined) continue
    const forSlug = counts.get(slug) ?? new Map<string, number>()
    forSlug.set(prefix, (forSlug.get(prefix) ?? 0) + 1)
    counts.set(slug, forSlug)
  }
  const commonest = (prefixes: Map<string, number>): string => [...prefixes].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0]
  const titles = new Map([...counts].map(([slug, prefixes]) => [slug, commonest(prefixes)]))
  const vendors = new Map<string, { title: string; models: ModelCatalogModel[] }>()
  const rest: ModelCatalogModel[] = []
  for (const model of group.models) {
    const slug = slugOf(model)
    const vendor = slug === undefined ? undefined : titles.get(slug)
    if (vendor === undefined) {
      rest.push(model)
      continue
    }
    const key = normalized(vendor)
    const entry = vendors.get(key) ?? { title: vendor, models: [] }
    const name = VENDOR_NAME.exec(model.name)?.[2] ?? model.name
    entry.models.push(name === model.name ? model : { ...model, name })
    vendors.set(key, entry)
  }
  return {
    vendors: [...vendors].map(([key, entry]) => ({
      key: `${group.id}/${key}`, provider: group.id, route: 'openrouter' as const, title: entry.title,
      label: `${entry.title} \u00b7 ${title}`, models: entry.models,
    })),
    rest: rest.length === 0 ? undefined : { key: group.id, provider: group.id, route: 'openrouter', title, label: title, models: rest },
  }
}

/**
 * Arrange the catalog as model-menu sections, one per provider and access
 * kind. Providers of plan and first-party API routes come first, in catalog
 * order with DeepSeek Account and DeepSeek leading; within a provider its
 * plan, then its API key, then its OpenRouter vendor section, so `Anthropic
 * Plan`, `Anthropic` and OpenRouter's `Anthropic` sit together (providers
 * match by name, a name that extends another joining it: `OpenAI Codex`
 * joins `OpenAI`). Servers on this machine follow, each its own provider;
 * then the OpenRouter vendors no other route offers, alphabetically; then
 * the OpenRouter models without a vendor.
 * @param groups - the loaded provider groups.
 * @param title - the heading of a route; defaults to {@link routeTitle}.
 * @returns the sections in display order, each with at least one model.
 */
export function modelSections(
  groups: readonly ModelProviderGroup[],
  title: (group: ModelProviderGroup) => string = routeTitle,
): ModelSection[] {
  const providers: { key: string; sections: ModelSection[] }[] = []
  const local: ModelSection[] = []
  const routers: ReturnType<typeof vendorSections>[] = []
  for (const group of orderModelProviders(groups)) {
    if (group.models.length === 0) continue
    const route = modelRoute(group)
    if (route === 'openrouter') {
      routers.push(vendorSections(group, title(group)))
      continue
    }
    const section: ModelSection = {
      key: group.id, provider: group.id, route, title: title(group), label: title(group), models: group.models,
    }
    if (route === 'local') {
      local.push(section)
      continue
    }
    const key = normalized(group.vendor ?? group.name)
    const provider = providers.find(entry => sameProvider(entry.key, key))
    if (provider === undefined) providers.push({ key, sections: [section] })
    else provider.sections.push(section)
  }
  const routerOnly: { key: string; title: string; sections: ModelSection[] }[] = []
  const several = routers.length > 1
  for (const split of routers) {
    for (const vendor of split.vendors) {
      // Two OpenRouter routes offering one vendor name the route as well.
      const section = several ? { ...vendor, title: vendor.label } : vendor
      const key = normalized(vendor.title)
      const provider = providers.find(entry => sameProvider(entry.key, key))
      if (provider !== undefined) {
        provider.sections.push(section)
        continue
      }
      const only = routerOnly.find(entry => entry.key === key)
      if (only === undefined) routerOnly.push({ key, title: vendor.title, sections: [section] })
      else only.sections.push(section)
    }
  }
  const rank = (section: ModelSection): number => MODEL_ROUTES.indexOf(section.route)
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
  return [
    ...providers.flatMap(provider => provider.sections.toSorted((left, right) => rank(left) - rank(right))),
    ...local,
    ...routerOnly.toSorted((left, right) => collator.compare(left.title, right.title)).flatMap(entry => entry.sections),
    ...routers.flatMap(split => split.rest === undefined ? [] : [split.rest]),
  ]
}

/** A capability the model menu filters by. */
export type ModelFilter = keyof ModelCapabilities

/** Filter chip order. */
export const MODEL_FILTERS: readonly ModelFilter[] = ['images', 'reasoning', 'tools', 'free']

/**
 * Whether the Host published a capability for one model.
 * @param model - catalog model; a Host without capability metadata publishes none.
 * @param filter - capability to test.
 * @returns true only for a published, set flag.
 */
export function hasCapability(model: ModelCatalogModel, filter: ModelFilter): boolean {
  return model.capabilities?.[filter] === true
}

/**
 * The filters worth offering: those that split the catalog, held by some
 * models and not by others.
 * @param groups - the loaded provider groups or sections.
 * @returns the splitting filters in chip order.
 */
export function splittingFilters(groups: readonly Pick<ModelProviderGroup, 'models'>[]): ModelFilter[] {
  const models = groups.flatMap(group => group.models)
  return MODEL_FILTERS.filter(filter => models.some(model => hasCapability(model, filter))
    && models.some(model => !hasCapability(model, filter)))
}

/** Trailing date or `latest` markers a catalog appends to a model name. */
const MARKERS = /\s*\((?:[a-z]{3}-\d{1,2}-\d{4}|\d{4}-\d{2}-\d{2}|latest)\)|\s+\d{1,2}-\d{4}$|\s+\d{4}-\d{2}-\d{2}$|\s+latest$/giu
/** A dated snapshot marker, as distinct from `latest`. */
const DATED = /\((?:[a-z]{3}-\d{1,2}-\d{4}|\d{4}-\d{2}-\d{2})\)|\s\d{1,2}-\d{4}$|\s\d{4}-\d{2}-\d{2}$/iu
/** The first standalone version number, optionally `v`-prefixed: `5.5`, `V4.1`, not `4o`, `o3` or `27B`. */
const VERSION = /(?<![\p{L}\p{N}.])v?(\d+(?:\.\d+)*)(?![\p{L}\p{N}.])/iu

/** One model's place in its line: the name without its version, and the version. */
function lineOf(name: string): { key: string; version: readonly number[]; dated: boolean } {
  const bare = name.replace(MARKERS, '').trim()
  const match = VERSION.exec(bare)
  const version = match?.[1]?.split('.').map(Number) ?? []
  const key = (match === null ? bare : `${bare.slice(0, match.index)}#${bare.slice(match.index + match[0].length)}`)
    .toLocaleLowerCase().replace(/[-_]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return { key, version, dated: DATED.test(name) }
}

/** Compare two versions component-wise; a missing component counts as zero. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * The models of one route that a newer model of the same line supersedes. A
 * line is a model name without its version number and trailing date or
 * `latest` marker (`Claude Opus 4.5 (latest)` and `Claude Opus 5.5` share
 * `claude opus #`); a model is superseded by a higher version in its line, and
 * a dated snapshot by an undated model of the same line and version. Names
 * without a standalone version only form lines with their own snapshots.
 * @param models - one route's models.
 * @returns ids of the superseded models.
 */
export function supersededModels(models: readonly ModelCatalogModel[]): ReadonlySet<string> {
  const lines = new Map<string, { id: string; version: readonly number[]; dated: boolean }[]>()
  for (const model of models) {
    const line = lineOf(model.name)
    const members = lines.get(line.key) ?? []
    members.push({ id: model.id, version: line.version, dated: line.dated })
    lines.set(line.key, members)
  }
  const superseded = new Set<string>()
  for (const members of lines.values()) {
    for (const member of members) {
      if (members.some(other => compareVersions(other.version, member.version) > 0
        || (member.dated && !other.dated && compareVersions(other.version, member.version) === 0))) {
        superseded.add(member.id)
      }
    }
  }
  return superseded
}
