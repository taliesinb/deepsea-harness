/**
 * Provider simulation: with `DSH_PROVIDER_SIMULATOR` naming a loopback HTTP
 * server, every request this process makes to a model provider's host goes to
 * that server instead, which answers in the provider's own protocol (a test
 * double of the provider: accounts, keys, sign-in, quotas and prices, without
 * inference). The provider's host leads the rewritten path, so one simulator
 * serves every provider:
 *
 *   https://openrouter.ai/api/v1/chat/completions?x=1
 *   → http://127.0.0.1:<port>/openrouter.ai/api/v1/chat/completions?x=1
 *
 * It is all or nothing: every provider host on the list is redirected, so a
 * provider the simulator does not offer fails there rather than reaching the
 * real service, and a real credential in a simulated home is never sent out.
 * Hosts not on the list (search, MCP servers, documentation) are untouched.
 * @module
 */

/**
 * Hosts of model providers, by registrable domain (a request to the domain or
 * any subdomain is redirected) or, for shared domains, by exact host.
 */
export const PROVIDER_DOMAINS: readonly string[] = [
  'anthropic.com', 'claude.ai', 'claude.com',
  'openai.com', 'chatgpt.com',
  'openrouter.ai',
  'deepseek.com',
  'moonshot.ai', 'moonshot.cn', 'kimi.com',
  'x.ai',
  'mistral.ai',
  'groq.com',
  'together.xyz',
  'fireworks.ai',
  'cerebras.ai',
  'z.ai', 'bigmodel.cn',
  'minimax.io', 'minimaxi.com',
  'githubcopilot.com',
]

/** Provider hosts on shared domains, matched exactly. */
export const PROVIDER_HOSTS: readonly string[] = [
  'generativelanguage.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
]

/** The environment variable naming the simulator. */
export const SIMULATOR_VARIABLE = 'DSH_PROVIDER_SIMULATOR'

/** Whether a host belongs to a model provider. */
export function isProviderHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, '')
  return PROVIDER_HOSTS.includes(name)
    || PROVIDER_DOMAINS.some(domain => name === domain || name.endsWith(`.${domain}`))
}

/**
 * The simulator's base URL from the environment, or `undefined` when the
 * process talks to the real providers. Only a loopback `http:` URL is
 * accepted: anything else throws, so a mistyped value cannot send traffic
 * elsewhere.
 * @param env - the environment to read (default: this process's).
 * @returns the base URL without a trailing slash, or `undefined`.
 */
export function providerSimulator(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const raw = env[SIMULATOR_VARIABLE]
  if (raw === undefined || raw === '') return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${SIMULATOR_VARIABLE} is not a URL: ${raw}`)
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.search !== '' || url.hash !== '') {
    throw new Error(`${SIMULATOR_VARIABLE} must be a loopback http URL, not ${raw}`)
  }
  return url.href.replace(/\/+$/u, '')
}

/**
 * A provider URL as the simulator serves it; any other URL unchanged.
 * @param url - the URL a client is about to use (a request, a link to open).
 * @param simulator - the simulator's base URL; without one, the URL is returned as is.
 * @returns the rewritten or original URL.
 */
export function simulatedUrl(url: string, simulator: string | undefined = providerSimulator()): string {
  if (simulator === undefined) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !isProviderHost(parsed.hostname)) return url
  return `${simulator}/${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`
}

/**
 * A provider WebSocket URL (`wss://`, `ws://`) as the simulator serves it
 * (`ws://<simulator host>/<provider host><path>`); any other URL unchanged.
 * @param url - the URL a client is about to connect to.
 * @param simulator - the simulator's base URL; without one, the URL is returned as is.
 * @returns the rewritten or original URL.
 */
export function simulatedSocketUrl(url: string, simulator: string | undefined = providerSimulator()): string {
  if (simulator === undefined) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if ((parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') || !isProviderHost(parsed.hostname)) return url
  return `${simulator.replace(/^http:/u, 'ws:')}/${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`
}

/**
 * Wrap a `fetch` so provider requests go to the simulator. Every other
 * request, and every option of a redirected one (method, headers, body,
 * signal), passes through unchanged.
 * @param inner - the fetch to wrap.
 * @param simulator - the simulator's base URL.
 * @returns the wrapping fetch.
 */
export function simulatedFetch(inner: typeof fetch, simulator: string): typeof fetch {
  const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      const target = simulatedUrl(input.url, simulator)
      return inner(target === input.url ? input : new Request(target, input), init)
    }
    const url = input instanceof URL ? input.href : input
    const target = simulatedUrl(url, simulator)
    return inner(target === url ? input : target, init)
  }
  return wrapped as typeof fetch
}

/**
 * Redirect this process's provider traffic while the returned disposer has
 * not run: `globalThis.fetch` and `globalThis.WebSocket` are wrapped when
 * `DSH_PROVIDER_SIMULATOR` is set, and left alone otherwise. Provider SDKs
 * read them when they build a client or open a socket, which happens per
 * request, after boot; a transport the simulator does not serve fails there
 * rather than reaching the provider.
 * @param env - the environment to read (default: this process's).
 * @returns a disposer restoring the original fetch, or `undefined` when not simulating.
 */
export function installProviderSimulation(env: Readonly<Record<string, string | undefined>> = process.env): (() => void) | undefined {
  const simulator = providerSimulator(env)
  if (simulator === undefined) return undefined
  const original = globalThis.fetch
  const wrapped = simulatedFetch(original, simulator)
  globalThis.fetch = wrapped
  const OriginalSocket = globalThis.WebSocket as typeof WebSocket | undefined
  let socket: typeof WebSocket | undefined
  if (OriginalSocket !== undefined) {
    socket = class SimulatedWebSocket extends OriginalSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(simulatedSocketUrl(url instanceof URL ? url.href : url, simulator), protocols)
      }
    }
    globalThis.WebSocket = socket
  }
  return () => {
    // Only restore what this install put in place: a later wrapper stays.
    if (globalThis.fetch === wrapped) globalThis.fetch = original
    if (socket !== undefined && OriginalSocket !== undefined && globalThis.WebSocket === socket) globalThis.WebSocket = OriginalSocket
  }
}
