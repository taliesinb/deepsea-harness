/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm/listProviders` joined with `llm/listConfigurableProviders`),
 * the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials/describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, LlmSignInRoute, LlmSignInState, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
  /** A browser sign-in route: its card shows the account instead of a key field. */
  readonly signIn?: LlmSignInRoute
  /** How the route is paid for, as its adapter reports it (or its profile declares it). */
  readonly auth?: 'subscription' | 'api-key' | 'local'
  readonly error?: string
}

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns account and official routes first, then other routes in their original order.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const auths = new Map(registered.flatMap(provider => provider.auth === undefined ? [] : [[provider.id, provider.auth] as const]))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    ...entry.signIn === undefined ? {} : { signIn: { ...entry.signIn } },
    ...(auth => auth === undefined ? {} : { auth })(auths.get(entry.provider)),
    ...entry.error === undefined ? {} : { error: entry.error },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows.toSorted((left, right) =>
    (left.provider === 'deepseek-account' ? 0 : left.provider === 'deepseek-official' ? 1 : 2)
      - (right.provider === 'deepseek-account' ? 0 : right.provider === 'deepseek-official' ? 1 : 2))
}

/** The page's three sections: keyed providers, sign-in plans, servers on this machine. */
export type ModelsGroup = 'apiKeys' | 'plans' | 'local'

/**
 * The section a provider belongs to: a subscription sign-in is a plan, a route
 * its adapter (or profile) calls local is local, everything else takes a key.
 * @param entry - the row's directory entry.
 * @returns its section.
 */
export function modelsGroupOf(entry: ProviderDirectoryEntry): ModelsGroup {
  if (entry.signIn?.kind === 'subscription' || entry.auth === 'subscription') return 'plans'
  return entry.auth === 'local' ? 'local' : 'apiKeys'
}

/** Whether a base URL names this machine. */
function loopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host)
  } catch {
    return false
  }
}

/**
 * The auth an unregistered route's profile implies, as llm-pi-ai would infer
 * it: a declared `auth`, else local for a hand-declared route on this machine.
 */
function profileAuth(entry: ProviderDirectoryEntry, profile: unknown): ProviderDirectoryEntry['auth'] {
  if (typeof profile !== 'object' || profile === null) return undefined
  const { auth, baseURL } = profile as { auth?: unknown; baseURL?: unknown }
  if (auth === 'subscription' || auth === 'api-key' || auth === 'local') return auth
  return entry.declared === true && typeof baseURL === 'string' && loopbackUrl(baseURL) ? 'local' : undefined
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** Account route has usable credentials for the configured inference origin. */
  accountAvailable?: boolean
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialInfo | undefined
  /**
   * Credential state for the page's derived `<ROUTE>_API_KEY`, described only
   * while the profile names no reference — the provider-card seat's
   * `keyConfigured` fact for dormant and keyless rows, matching the editor's
   * own derivation rule.
   */
  derivedCredential?: CredentialInfo
  /**
   * A sign-in route's state and account, once described; absent while the
   * route is unregistered (no profile) or the read failed.
   */
  signInState?: LlmSignInState
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param ctx - the page plugin's context, whose `remote.llm` and
   * `remote.credentials` namespaces carry the directory and credential reads.
   * @param schema - settings-owned schema and immutable path operations.
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const [registered, declared] = await Promise.all([
      this.ctx.remote.llm.listProviders(),
      this.ctx.remote.llm.listConfigurableProviders(),
      this.describeFace.ensure(),
    ])
    if (!registered.ok) { this.failLoad(generation, registered.error.message); return }
    if (!declared.ok) { this.failLoad(generation, declared.error.message); return }
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
      return
    }
    const providers = joinProviderDirectory(registered.value, declared.value)
    const writable = mirrored.view.writable
    const views: readonly SettingsNamespaceView[] = mirrored.view.namespaces
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      // A configured route that failed to register still belongs in its section.
      const inferred = entry.auth === undefined && namespace !== undefined && entry.settingsPath.length > 0
        ? profileAuth(entry, this.schema.getPath(namespace.value, entry.settingsPath))
        : undefined
      return {
        entry: inferred === undefined ? entry : { ...entry, auth: inferred },
        configured,
        removable,
        apiKeyEnv: entry.provider === 'deepseek-account' || entry.signIn !== undefined ? undefined : apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    if (rows.some(row => row.entry.provider === 'deepseek-account')) {
      const catalog = await this.ctx.remote.session.modelCatalog()
      for (const row of rows) {
        if (row.entry.provider === 'deepseek-account') row.accountAvailable = catalog.ok
          && catalog.value.groups.some(group => group.id === 'deepseek-account' && group.models.length > 0)
      }
    }
    // A sign-in route keeps its grant in its own credential record, never behind a key reference.
    const keyed = (row: ProviderRow): boolean => row.entry.provider !== 'deepseek-account' && row.entry.signIn === undefined
    const refs = [...new Set(rows.filter(keyed).map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    // Sign-in state is display enrichment: one read per registered sign-in route, failures leave it absent.
    const signIns = new Map<string, LlmSignInState>()
    await Promise.all(rows.filter(row => row.entry.signIn !== undefined && row.entry.active).map(async (row) => {
      const response = await this.ctx.remote.llm.describeSignIn(row.entry.provider)
      if (response.ok && response.value !== undefined) signIns.set(row.entry.provider, response.value)
    }))
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      const response = await this.ctx.remote.credentials.describe(refs)
      // Credential state is an enrichment for the Models page: a failure
      // degrades the badge instead of failing the load. The onboarding
      // projection below retains the failure distinction.
      if (response.ok) credentials = response.value
      else credentialError = response.error.message
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.filter(row => row.entry.provider !== 'deepseek-account' || row.accountAvailable === true).map((row) => {
        if (row.entry.provider === 'deepseek-account') return row
        const signInState = signIns.get(row.entry.provider)
        if (row.entry.signIn !== undefined) return signInState === undefined ? row : { ...row, signInState }
        const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
        const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
        return {
          ...row,
          ...named === undefined ? {} : { credential: named },
          ...derived === undefined ? {} : { derivedCredential: derived },
        }
      })
      s.namespaces = namespaces
    })
  }

  /** Publish one load's failure text, unless a newer load already took over. */
  private failLoad(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.entry.provider === 'deepseek-account') return row.accountAvailable === true
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
