/**
 * Authorization flows for the pi-ai providers that ship a login. This is the
 * whole of the translation between the harness's neutral notice/prompt
 * vocabulary and pi-ai's `AuthInteraction`; nothing above it knows which
 * library ran the conversation.
 *
 * A provider's OAuth sign-in is a flow of its own route, `<provider>-oauth`,
 * whose grant is that route's credential record; the provider's own route keeps
 * the interactive API-key login, so a subscription and an API key never
 * overwrite each other.
 *
 * @module dsh-llm-pi-ai/login
 */

import type { AuthEvent, AuthPrompt, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationMethod, AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { catalogProvider, catalogProviderIds, oauthCatalogProvider, oauthProviderIds, oauthRouteDisplayName } from './catalog.ts'
import { installationDeviceId, recordKeyFor } from './auth.ts'
import { buildProvider } from './provider.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import { createModels } from './models.ts'

/**
 * The login method a provider's own route offers: its interactive API-key
 * login, when pi-ai collects the key through its own prompt — which every
 * installed provider with a key currently does, so a key can be typed into
 * pi-ai's prompt rather than into the settings form. Its OAuth sign-in is the
 * `<provider>-oauth` route's flow instead.
 * @param provider - the installed catalog provider.
 * @returns its methods; empty when it offers no key login.
 */
function keyLoginMethods(provider: Provider): AuthorizationMethod[] {
  const apiKey = provider.auth.apiKey
  return apiKey?.login === undefined ? [] : [{ id: 'api-key', label: apiKey.name }]
}

/**
 * Restate one pi-ai login event in the seam's vocabulary.
 *
 * A device-code grant is the one event carrying two things the human needs at
 * once — where to go and what to type there — which is why the neutral notice
 * has a `code` beside its `url` rather than folding the code into the message.
 * @param event - what pi-ai reported.
 * @param session - the attempt to report it to.
 */
function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...link === undefined ? {} : { url: link.url } })
      return
    }
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      // pi-ai's event union is open to new members: a build that meets one it
      // does not know still shows the human that something is happening rather
      // than going silent mid-login.
      session.notify({ message: 'Signing in…' })
  }
}

/**
 * Restate one pi-ai prompt in the seam's vocabulary.
 *
 * `manual_code` becomes a plain text question because the difference pi-ai
 * draws — a code the human copies from a browser rather than a value they know
 * — changes nothing a surface renders. Its own `signal` is carried through, and
 * that is the part which matters: it is how a flow racing a typed code against
 * a browser callback withdraws the losing question.
 * @param prompt - what pi-ai asked.
 * @returns the neutral prompt to put to the human.
 */
function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/**
 * Register the authorization flows of the installed catalog: an API-key flow
 * under each provider's own route that collects its key interactively, and an
 * OAuth flow under the `<provider>-oauth` route of each that ships OAuth.
 *
 * Registration is unconditional on configuration: a provider has to be signed
 * into before a route for it is worth adding, so the flow exists from the
 * moment the plugin mounts rather than appearing once a profile does.
 * @param ctx - the plugin context carrying `ctx.authorization`.
 * @param auth - the injectables every collection here is built with.
 */
export function registerPiAiFlows(ctx: Context, auth: PiAiAuthInjection): void {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId)
    /* v8 ignore next -- every id here names an installed provider. */
    if (provider === undefined) continue
    // An OAuth-only provider (openai-codex) has no key login; its only flow is
    // its OAuth route's.
    const [first, ...rest] = keyLoginMethods(provider)
    if (first === undefined || !addressable(ctx, providerId)) continue
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId),
      label: provider.name,
      methods: [first, ...rest],
      async run(session) {
        // A collection of its own, holding only the provider being signed
        // into: login is not serving requests, and the credential it produces
        // lands in the shared store either way.
        const models = createModels(auth)
        models.setProvider(provider)
        // pi-ai persists what the login returns through that same store, which
        // is what makes it the single writer of this record.
        await models.login(providerId, 'api_key', {
          signal: session.signal,
          notify: (event) => { relay(event, session) },
          prompt: prompt => session.prompt(restate(prompt)),
        })
      },
    })
  }
  for (const route of oauthProviderIds()) {
    const provider = oauthCatalogProvider(route)
    const oauth = provider?.auth.oauth
    /* v8 ignore next -- `oauthProviderIds()` lists exactly the routes this resolves. */
    if (provider === undefined || oauth === undefined) continue
    if (!addressable(ctx, route)) continue
    // The route's own provider: pi-ai stores the grant under the id it signs
    // into, which has to be the route, never the native provider id.
    const routeProvider = buildProvider({
      provider: route,
      displayName: oauthRouteDisplayName(route) ?? `${provider.name} OAuth`,
      models: provider.getModels().map(model => ({ ...model, provider: route })),
      namesCredential: false,
    })
    ctx.authorization.registerFlow({
      key: recordKeyFor(route),
      label: routeProvider.name,
      methods: [{ id: 'oauth', label: oauth.loginLabel ?? oauth.name }],
      async run(session) {
        const models = createModels(auth)
        models.setProvider(routeProvider)
        // Read before the sign-in starts because pi-ai asks for it
        // synchronously; only a provider that needs one (Sign in with ChatGPT)
        // asks, and only then is a new id stored.
        const device = await installationDeviceId(ctx)
        try {
          await models.login(route, 'oauth', {
            signal: session.signal,
            notify: (event) => { relay(event, session) },
            prompt: prompt => session.prompt(restate(prompt)),
          }, { getDeviceId: device.get })
        } finally {
          await device.stored()
        }
      },
    })
  }
}

/**
 * Whether a route key can address a credential record, warning when it cannot.
 * @param ctx - the plugin context, for its logger.
 * @param route - the route whose record a flow would write.
 * @returns whether its sign-in can be offered.
 */
function addressable(ctx: Context, route: string): boolean {
  if (isCredentialKeySegment(route)) return true
  /* v8 ignore next 3 -- every installed catalog id is a lowercase hyphenated
     identifier; the guard keeps a future upstream id outside the record
     grammar (dotted or uppercase, as vendor ids elsewhere already are) from
     throwing in `recordKeyFor` and failing the whole mount. */
  ctx.logger.warn(
    'llm-pi-ai: catalog route "%s" cannot address a credential record; its sign-in is not offered', route)
  return false
}
