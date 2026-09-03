// @vitest-environment jsdom
/** The shell pins the document scroll origin; WebKit focus-reveal scrolls
 * (Safari standalone web apps shift the whole viewport and never restore it)
 * must snap back to (0, 0) instead of sticking. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pinDocumentScroll } from '../src/scroll-pin.ts'

/** Present the given document scroll offset through the jsdom window. */
function setOffset(x: number, y: number): void {
  Object.defineProperty(window, 'scrollX', { value: x, configurable: true })
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  setOffset(0, 0)
})

describe('pinDocumentScroll', () => {
  it('corrects an offset the page already carries at install time', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    setOffset(0, 84)
    const unpin = pinDocumentScroll()
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
    unpin()
  })

  it('snaps the origin back when the window scrolls after install', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const unpin = pinDocumentScroll()
    expect(scrollTo).not.toHaveBeenCalled()

    setOffset(0, 42)
    window.dispatchEvent(new Event('scroll'))
    expect(scrollTo).toHaveBeenCalledWith(0, 0)

    scrollTo.mockClear()
    setOffset(17, 0)
    window.dispatchEvent(new Event('scroll'))
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
    unpin()
  })

  it('leaves a window already at the origin untouched', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const unpin = pinDocumentScroll()
    window.dispatchEvent(new Event('scroll'))
    expect(scrollTo).not.toHaveBeenCalled()
    unpin()
  })

  it('stops listening once uninstalled', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const unpin = pinDocumentScroll()
    unpin()
    setOffset(0, 42)
    window.dispatchEvent(new Event('scroll'))
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
