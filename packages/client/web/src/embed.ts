/**
 * Embedded presentation selection from the page URL. `?embed=<sessionId>`
 * asks the shell to render that one Session chrome-less for a framing
 * document (a remote-workspace iframe in another DSH GUI). The selector is a
 * query parameter, never a path segment: the shell computes every Host URL
 * relative to the served document's directory, so a path would move the
 * mount point.
 * @module @deepseek-ai/dsh-client-web/src/embed
 */
import { type EmbedPresentation, setEmbedPresentation } from '@deepseek-ai/dsh-client-store'

/** Query parameter naming the embedded Session. */
export const EMBED_QUERY = 'embed'

/**
 * Parse the embed selector from a query string.
 * @param search - `location.search` (leading `?` optional).
 * @returns the presentation, or undefined when absent, empty, or repeated.
 */
export function parseEmbedPresentation(search: string): EmbedPresentation | undefined {
  const values = new URLSearchParams(search).getAll(EMBED_QUERY)
  if (values.length !== 1) return undefined
  const sessionId = values[0]?.trim() ?? ''
  return sessionId === '' ? undefined : { sessionId }
}

/**
 * Apply the page's embed selector to the shared store module before any
 * plugin activates, so persisted stores resolve their namespaced keys and
 * shell plugins observe the mode from their first render.
 * @param search - `location.search` of the booting page.
 * @returns the applied presentation, for the caller's diagnostics.
 */
export function applyEmbedPresentation(search: string): EmbedPresentation | undefined {
  const presentation = parseEmbedPresentation(search)
  setEmbedPresentation(presentation)
  return presentation
}
