// @vitest-environment jsdom
/**
 * The `conversation.draft.editor` Factory: loading a document with chips and
 * quotes, reporting edits, keeping a command chip of its value, and reloading
 * only on a new revision.
 */
import { createElement, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { $getRoot, KEY_ENTER_COMMAND, type LexicalEditor } from 'lexical'
import { DraftDocumentEditor } from '../src/client/input/editor/DraftDocumentEditor.tsx'
import type { DraftSnapshot } from '../src/client/contract/draft-editor.ts'

afterEach(cleanup)

type Props = ComponentProps<typeof DraftDocumentEditor>

const REFERENCE = {
  source: 'file', ref: 'src/a.ts', offset: 6, length: 9, label: 'a.ts', clipboardText: '@src/a.ts', appearance: 'file' as const,
}
const DOCUMENT: DraftSnapshot = { text: 'Check @src/a.ts please', references: [REFERENCE] }

function renderEditor(overrides: Partial<Props> = {}) {
  const onChange = vi.fn<(draft: DraftSnapshot) => void>()
  const props = {
    value: DOCUMENT,
    revision: 'a',
    onChange,
    placeholder: 'Empty draft',
    ariaLabel: 'Draft',
    openReference: () => false,
    t: (key: string) => key,
    ...overrides,
  } as Props
  const view = render(createElement(DraftDocumentEditor, props))
  const root = view.container.querySelector<HTMLElement & { __lexicalEditor?: LexicalEditor }>('[data-draft-document-input]')
  const editor = root?.__lexicalEditor
  if (root === null || editor === undefined) throw new Error('editor root not bound')
  return { ...view, root, editor, onChange, props }
}

function append(editor: LexicalEditor, text: string): void {
  act(() => {
    editor.update(() => { $getRoot().selectEnd().insertText(text) }, { discrete: true })
  })
}

describe('DraftDocumentEditor', () => {
  it('loads the document with its chip, without reporting the load', () => {
    const { root, onChange } = renderEditor()
    expect(root.textContent).toContain('a.ts')
    expect(root.hasAttribute('data-composer-input')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports each edit as a document that keeps the chip', () => {
    const { editor, onChange } = renderEditor()
    append(editor, '!')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.lastCall?.[0]).toEqual({ text: 'Check @src/a.ts please!', references: [REFERENCE] })
  })

  it('keeps the command chip of its value while the text starts with the token', () => {
    const { editor, onChange } = renderEditor({ value: { text: '/goal ship it', references: [], command: { token: '/goal ' } } })
    append(editor, ' now')
    expect(onChange.mock.lastCall?.[0]).toEqual({ text: '/goal ship it now', references: [], command: { token: '/goal ' } })
    act(() => {
      editor.update(() => {
        $getRoot().clear()
        $getRoot().selectEnd().insertText('ship it')
      }, { discrete: true })
    })
    expect(onChange.mock.lastCall?.[0]).toEqual({ text: 'ship it', references: [] })
  })

  it.each([false, true])('makes Enter a line break (shift=%s) and submits nothing', (shiftKey) => {
    const { editor, onChange } = renderEditor({ value: { text: 'first', references: [] } })
    act(() => { editor.update(() => { $getRoot().selectEnd() }, { discrete: true }) })
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey, cancelable: true })
    act(() => { editor.dispatchCommand(KEY_ENTER_COMMAND, event) })
    append(editor, 'second')
    expect(event.defaultPrevented).toBe(true)
    expect(onChange.mock.lastCall?.[0]).toEqual({ text: 'first\nsecond', references: [] })
  })

  it('shows the placeholder only while empty', () => {
    const { container, editor } = renderEditor({ value: { text: '', references: [] } })
    expect(container.textContent).toContain('Empty draft')
    append(editor, 'x')
    expect(container.textContent).not.toContain('Empty draft')
  })

  it('reloads its value on a new revision and keeps local edits otherwise', () => {
    const { editor, rerender, root, props } = renderEditor()
    append(editor, ' (local)')
    rerender(createElement(DraftDocumentEditor, { ...props, value: { text: 'other', references: [] } }))
    expect(root.textContent).toContain('(local)')
    rerender(createElement(DraftDocumentEditor, { ...props, value: { text: 'other', references: [] }, revision: 'b' }))
    expect(root.textContent).toBe('other')
  })
})
