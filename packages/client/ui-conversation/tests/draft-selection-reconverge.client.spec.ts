// @vitest-environment jsdom
/** The draft's DOM selection re-converges with the retained editor selection before focus and text input. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode, $setSelection } from 'lexical'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'

// Lexical installs its beforeinput listener only where InputEvent exposes target ranges.
vi.hoisted(() => {
  Object.defineProperty(InputEvent.prototype, 'getTargetRanges', { configurable: true, value: () => [] })
})

function fixture() {
  // jsdom has no Range geometry; these cases observe selection and focus, not scrolling.
  const geometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  onTestFinished(() => {
    if (geometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', geometry)
  })
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.tabIndex = 0
  const other = document.createElement('input')
  other.value = 'other control'
  document.body.append(root, other)
  onTestFinished(() => { root.remove(); other.remove() })
  // jsdom collapses the document Selection on focus(); browsers keep the
  // range when focus enters the editable host that already contains it.
  const focus = root.focus.bind(root)
  const mocked = vi.spyOn(root, 'focus').mockImplementation((options) => {
    const selection = document.getSelection()!
    const range = selection.rangeCount === 0 ? undefined : selection.getRangeAt(0).cloneRange()
    focus(options)
    if (range !== undefined) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
  })
  onTestFinished(() => { mocked.mockRestore() })
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection() },
    quoteLabels: () => ({ remove: 'Remove quote' }),
    openReference: () => false,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const dispose = runtime.register()
  const { editor } = runtime
  onTestFinished(dispose)
  editor.setRootElement(root)
  root.focus()
  editor.update(() => { $getRoot().selectEnd() }, { discrete: true })

  /**
   * Type like a browser: the target range is the DOM selection when the
   * keystroke arrives; an uncancelled insertion edits the DOM text and
   * reports it through `input`. Each keystroke is its own task, so the
   * editor commits between them.
   */
  const type = async (text: string): Promise<void> => {
    for (const data of text) {
      const selection = document.getSelection()!
      const range = selection.getRangeAt(0)
      const target = new StaticRange({
        startContainer: range.startContainer, startOffset: range.startOffset,
        endContainer: range.endContainer, endOffset: range.endOffset,
      })
      const before = new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true })
      Object.defineProperty(before, 'getTargetRanges', { value: () => [target] })
      root.dispatchEvent(before)
      if (!before.defaultPrevented) {
        const node = selection.anchorNode
        if (!(node instanceof Text)) throw new Error('Native insertion needs a text caret')
        const offset = selection.anchorOffset
        node.insertData(offset, data)
        selection.collapse(node, offset + data.length)
        root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data, bubbles: true }))
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  const modelCaret = () => editor.getEditorState().read(() => {
    const selected = $getSelection()
    if (!$isRangeSelection(selected)) return null
    return { text: selected.anchor.getNode().getTextContent(), offset: selected.anchor.offset, collapsed: selected.isCollapsed() }
  })
  const domCaret = () => {
    const selected = document.getSelection()!
    return { node: selected.anchorNode, offset: selected.anchorOffset }
  }
  /** The DOM caret as text and offset when it sits in the editor's text; otherwise its node. */
  const textCaret = () => {
    const { node, offset } = domCaret()
    return node instanceof Text && root.contains(node) ? { text: node.data, offset } : { node, offset }
  }
  /** Move the DOM selection to an element point on the editable root, as node removal leaves it. */
  const strandDOMSelection = async () => {
    document.getSelection()!.setBaseAndExtent(root, 0, root, 0)
    // jsdom reports the selection change in a later task, as browsers do.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { runtime, editor, root, other, dispose, type, modelCaret, domCaret, textCaret, strandDOMSelection }
}

it('types in order while focused with a converged selection', async () => {
  const f = fixture()
  await f.type('foo ba')
  expect(f.root.textContent).toBe('foo ba')
  expect(f.textCaret()).toEqual({ text: 'foo ba', offset: 6 })
})

it('types at the retained selection after focus returns to a stranded DOM selection', async () => {
  const f = fixture()
  await f.type('sent kept')
  f.other.focus()
  f.runtime.clearCommittedDraft(() => 5)
  expect(document.activeElement).toBe(f.other)
  await f.strandDOMSelection()
  expect(f.modelCaret()).toEqual({ text: 'kept', offset: 0, collapsed: true })

  f.root.focus()
  await Promise.resolve()
  expect(f.textCaret()).toEqual({ text: 'kept', offset: 0 })
  await f.type('go ')
  expect(f.root.textContent).toBe('go kept')
  expect(f.textCaret()).toEqual({ text: 'go kept', offset: 3 })
})

it('types in order when input reaches the editor while document focus stays on the body', async () => {
  const f = fixture()
  await f.type('first')
  f.other.focus()
  f.runtime.clearCommittedDraft(() => null)
  f.other.blur()
  expect(document.activeElement).toBe(document.body)
  await f.strandDOMSelection()

  await f.type('foo ba')
  expect(f.root.textContent).toBe('foo ba')
  expect(f.textCaret()).toEqual({ text: 'foo ba', offset: 6 })
  expect(document.activeElement).toBe(f.root)
})

it('restores the retained caret of a replaced draft instead of the stranded DOM point', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('alpha beta')
  await f.strandDOMSelection()
  expect(f.modelCaret()).toEqual({ text: 'alpha beta', offset: 10, collapsed: true })

  f.root.focus()
  await Promise.resolve()
  expect(f.textCaret()).toEqual({ text: 'alpha beta', offset: 10 })
  await f.type('!?')
  expect(f.root.textContent).toBe('alpha beta!?')
})

it('types at a retained mid-draft caret when input reaches the editor from the body', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('alpha beta')
  f.editor.update(() => {
    const text = $getRoot().getAllTextNodes()[0]
    if ($isTextNode(text)) text.select(5, 5)
  }, { discrete: true })
  f.other.blur()
  await f.strandDOMSelection()

  await f.type(', and')
  expect(f.root.textContent).toBe('alpha, and beta')
  expect(f.textCaret()).toEqual({ text: 'alpha, and beta', offset: 10 })
})

it('select-all after focus returns keeps the selection', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('Draft')

  // A select-all made in the task that returns focus, as a programmatic fill does.
  f.root.focus()
  document.getSelection()!.setBaseAndExtent(f.root, 0, f.root, f.root.childNodes.length)
  await Promise.resolve()
  const selection = document.getSelection()!
  expect(selection.isCollapsed).toBe(false)
  expect(selection.toString()).toBe('Draft')
})
it('selects the draft end when the editor holds no selection', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('alpha')
  f.editor.update(() => { $setSelection(null) }, { discrete: true })
  await f.strandDOMSelection()

  f.root.focus()
  await Promise.resolve()
  expect(f.textCaret()).toEqual({ text: 'alpha', offset: 5 })
})

it('leaves focus and the other control selection alone during background updates and its input', async () => {
  const f = fixture()
  await f.type('draft')
  f.other.focus()
  f.other.setSelectionRange(2, 7)
  const documentSelection = f.domCaret()

  f.runtime.clearCommittedDraft(() => null)
  f.runtime.setDraft('replaced')
  f.runtime.paste(' more')
  f.other.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }))
  await Promise.resolve()
  expect(f.root.textContent).toBe('replaced more')
  expect(document.activeElement).toBe(f.other)
  expect([f.other.selectionStart, f.other.selectionEnd]).toEqual([2, 7])
  expect(f.domCaret()).toEqual(documentSelection)
  expect(f.modelCaret()).toEqual({ text: 'replaced more', offset: 13, collapsed: true })
})

it('leaves the DOM selection of a running composition in place', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('alpha')
  f.other.blur()
  await f.strandDOMSelection()

  f.root.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertCompositionText', data: 'a', isComposing: true, bubbles: true, cancelable: true,
  }))
  expect(f.domCaret()).toEqual({ node: f.root, offset: 0 })
  expect(document.activeElement).toBe(document.body)
})

it('does not write the selection of a read-only editor', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('alpha')
  f.editor.setEditable(false)
  await f.strandDOMSelection()

  f.root.focus()
  await Promise.resolve()
  expect(f.domCaret()).toEqual({ node: f.root, offset: 0 })
})

it('removes the re-convergence listeners with the registration', async () => {
  const f = fixture()
  f.other.focus()
  f.runtime.setDraft('alpha')
  await f.strandDOMSelection()
  f.root.focus()
  f.dispose()
  await Promise.resolve()
  expect(f.domCaret()).toEqual({ node: f.root, offset: 0 })

  f.other.focus()
  f.other.blur()
  f.root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(document.body)
})
