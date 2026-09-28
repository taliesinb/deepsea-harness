/**
 * Plain-text reference scan (the plain-text-reference decision;
 * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 * a `/name` or `@name` token whose name is on the trigger's lexicon, and
 * syntax-recognizable `@path` file and folder tokens. Pure derivation — the editor's
 * text-ref entity transform consumes these ranges; editing the text out of
 * match shape simply drops the range next scan.
 */

/**
 * One plain-text reference range (the plain-text-reference decision;
 * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 * a `/name` or `@name` token whose name is on the trigger's lexicon, or an
 * `@path` file or folder token. Pure derivation — editing the text out of
 * match shape simply drops the range next scan.
 */
export interface TextRefRange {
  readonly start: number
  readonly end: number
  readonly trigger: string
}

/** Editable token name following a registered punctuation trigger. */
const TEXT_REF_NAME_RE = /^[\w-]+/
/** One `@` path token: a quoted path through its closing quote or line end, or an unquoted run. */
const PATH_TOKEN_RE = /(^|\s)(@(?:"[^"\n]*"?|[^\s"]\S*))/g
/**
 * Punctuation that ends prose rather than a path: the characters the
 * sent-message file and folder rules in ui-reference strip from the end of an
 * unquoted token.
 */
const TRAILING_PUNCTUATION = new Set('.,;:!?，。；：！？')
/** An unquoted token names a path only with a separator or an extension; a bare `@name` stays plain until a lexicon claims it. */
const PATH_LIKE_RE = /^@.*[/\\.]/u

/**
 * End of the whole `@path` file or folder token at `start`, so a path is never
 * cut at its directory prefix. A closed quote ends at its quote and an
 * unquoted token with a separator or extension drops trailing punctuation,
 * the spans the sent-message rules render. An open quote (a folder drill in
 * progress) ends at its last slash when only trailing punctuation and
 * whitespace or the draft end follow it.
 * @param draft - draft text.
 * @param start - offset of the token's `@`.
 * @param token - the path token at `start`.
 * @returns the token's end offset, or undefined when it names no path.
 */
function pathEnd(draft: string, start: number, token: string): number | undefined {
  if (!token.startsWith('@"')) {
    let length = token.length
    while (TRAILING_PUNCTUATION.has(token.charAt(length - 1))) length -= 1
    return PATH_LIKE_RE.test(token.slice(0, length)) ? start + length : undefined
  }
  if (token.length > 3 && token.endsWith('"')) return start + token.length
  const slash = token.lastIndexOf('/')
  if (slash < 0) return undefined
  let next = start + slash + 1
  while (TRAILING_PUNCTUATION.has(draft.charAt(next))) next += 1
  return next === draft.length || /\s/u.test(draft.charAt(next)) ? start + slash + 1 : undefined
}
/**
 * What may follow a `/name` token: whitespace or the draft end, the boundary
 * the host skill gesture (`dsh-tool-skill`) requires, so `/nfs-hg/xxx`,
 * `/plan.md`, and `/plan。` are prose, never a reference.
 */
const SLASH_TOKEN_END_RE = /^(?:\s|$)/

/**
 * Scan the draft for plain-text reference tokens against the hot lexicons.
 * Word-boundary discipline: the trigger must sit at the draft
 * start or after whitespace ('x/name' never matches); the name must be an
 * exact lexicon member; a `/name` token must end at whitespace or the draft
 * end ('/name/x' is a path, '/name。' is prose).
 * @param draft - draft text.
 * @param lexicon - per-trigger name lists; missing catalogs match no named tokens.
 * @returns matched ranges in draft order.
 */
export function scanTextRefs(
  draft: string, lexicon: ReadonlyMap<string, readonly string[]>,
): TextRefRange[] {
  if (draft === '') return []
  const out: TextRefRange[] = []
  for (const [trigger, names] of lexicon) {
    if (trigger.length !== 1 || names.length === 0) continue
    for (let start = 0; start < draft.length; start++) {
      if (draft.charAt(start) !== trigger || (start > 0 && !/\s/u.test(draft.charAt(start - 1)))) continue
      const name = TEXT_REF_NAME_RE.exec(draft.slice(start + 1))?.[0] ?? ''
      if (name === '' || !names.includes(name)) continue
      const end = start + 1 + name.length
      if (trigger === '/' && !SLASH_TOKEN_END_RE.test(draft.slice(end))) continue
      out.push({ start, end, trigger })
    }
  }
  PATH_TOKEN_RE.lastIndex = 0
  let path: RegExpExecArray | null
  while ((path = PATH_TOKEN_RE.exec(draft)) !== null) {
    const start = path.index + (path[1]?.length ?? 0)
    const end = pathEnd(draft, start, path[2] ?? '')
    if (end !== undefined && !out.some(range => range.start < end && range.end > start)) {
      out.push({ start, end, trigger: '@' })
    }
  }
  return out.sort((left, right) => left.start - right.start)
}
