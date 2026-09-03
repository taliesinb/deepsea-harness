/**
 * Document scroll pin for the single-viewport shell.
 *
 * The shell renders one full-viewport application (`html`, `body`, and the
 * mount point are all `height: 100%`), so the document itself never has
 * meaningful scrollable overflow. WebKit still scrolls the window
 * programmatically — focusing an element inside a popup that hugs the
 * viewport edge triggers its focus-reveal scroll, which bypasses the
 * `overflow: hidden` clip that base.css puts on the root. In a Safari
 * standalone web app ("Add to Dock") the shifted viewport then sticks: no
 * document scrollbar exists to undo it, and the app sits above a blank band.
 * @module @deepseek-ai/dsh-client-web/src/scroll-pin
 */

/** Uninstaller returned by {@link pinDocumentScroll}. */
export type ScrollPinDispose = () => void

/**
 * Keep the document scroll origin at (0, 0) for the window's lifetime.
 * Inner-scroller events never reach a window scroll listener (`scroll` does
 * not bubble), so the pin only ever answers real document scrolls, and it
 * corrects an offset the page loaded with (session restore) immediately.
 * @param win - Window whose document scroll stays pinned.
 * @returns Uninstaller removing the listener.
 */
export function pinDocumentScroll(win: Window = window): ScrollPinDispose {
  const reset = (): void => {
    if (win.scrollX !== 0 || win.scrollY !== 0) win.scrollTo(0, 0)
  }
  win.addEventListener('scroll', reset, { passive: true })
  reset()
  return () => { win.removeEventListener('scroll', reset) }
}
