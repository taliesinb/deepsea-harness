/**
 * Page presentation mode, set once by the web boot kernel before any client
 * plugin activates, and the persistence namespace that mode implies.
 *
 * The store engine is a platform module (one instance shared into every
 * client bundle), so a module-level cell here is visible to every plugin
 * without a window global. It lives beside the engine because the one thing
 * the mode must influence before plugins run is persistence: an embedded shell
 * shares the page origin — and therefore `localStorage` — with whatever page
 * frames it, so its persisted stores must not collide with the host page's
 * (`dsh.sessions.current`, drafts, layout preferences).
 * @module @deepseek-ai/dsh-client-store/src/page-mode
 */

/**
 * Embedded presentation: the shell renders exactly one Session, chrome-less,
 * for a parent document that frames it (`?embed=<sessionId>`).
 */
export interface EmbedPresentation {
  /** The Session the embedded shell shows; a plain id string at this layer. */
  readonly sessionId: string
}

let embed: EmbedPresentation | undefined
let namespace = ''

/**
 * Declare the embedded presentation for this page. Boot calls this once,
 * before plugin activation; a second call replaces the mode (tests).
 * @param presentation - the embed facts, or undefined for the ordinary shell.
 */
export function setEmbedPresentation(presentation: EmbedPresentation | undefined): void {
  embed = presentation === undefined ? undefined : Object.freeze({ ...presentation })
  namespace = embed === undefined ? '' : `embed:${embed.sessionId}:`
}

/** @returns the embedded presentation, or undefined in the ordinary shell. */
export function embedPresentation(): EmbedPresentation | undefined {
  return embed
}

/**
 * Map a persisted store name to its `localStorage` key under the current
 * page mode. The ordinary shell keeps names verbatim, so existing entries
 * stay valid; an embedded shell prefixes them per embedded Session.
 * @param name - the store's declared persist name.
 * @returns the storage key.
 */
export function persistenceKey(name: string): string {
  return `${namespace}${name}`
}
