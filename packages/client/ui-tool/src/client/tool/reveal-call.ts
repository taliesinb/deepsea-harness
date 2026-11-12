/** Bring one Tool call row of the same transcript into view and mark it briefly. */
import { flushSync } from 'react-dom'

function callRow(scope: ParentNode, callId: string): HTMLElement | undefined {
  for (const row of scope.querySelectorAll<HTMLElement>('[data-chat-call-id]')) {
    if (row.dataset.chatCallId === callId) return row
  }
  return undefined
}

/**
 * Reveal the row of one Tool call in the transcript that contains `origin`:
 * collapsed groups around it open as they do for browser find (`beforematch`),
 * the row scrolls to the middle of the view, and `data-tool-call-reveal`
 * marks it until its highlight animation ends.
 * @param origin - element the gesture came from; selects the transcript.
 * @param callId - exact call to reveal.
 * @returns whether the call's row is loaded.
 */
export function revealToolCall(origin: HTMLElement, callId: string): boolean {
  const scope = origin.closest('[data-conversation-scroll]') ?? origin.ownerDocument
  const row = callRow(scope, callId)
  if (row === undefined) return false
  const closed: HTMLElement[] = []
  for (let element = row.parentElement; element !== null && element !== scope; element = element.parentElement) {
    if (element.getAttribute('hidden') === 'until-found') closed.push(element)
  }
  // Outermost first, each committed before the next, so an opened group renders its members.
  for (const element of closed.reverse()) flushSync(() => { element.dispatchEvent(new Event('beforematch')) })
  const reduced = origin.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  row.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'center', inline: 'nearest' })
  // Re-adding the mark after a layout read restarts a highlight that is still running.
  row.removeAttribute('data-tool-call-reveal')
  row.getBoundingClientRect()
  row.setAttribute('data-tool-call-reveal', '')
  const unmark = (event: AnimationEvent): void => {
    if (event.target !== row) return
    row.removeEventListener('animationend', unmark)
    row.removeAttribute('data-tool-call-reveal')
  }
  row.addEventListener('animationend', unmark)
  return true
}
