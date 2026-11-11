/**
 * The `conversation.draft.editor` Factory: one private Lexical editor over a
 * draft document, with the composer's reference chips and quotes but none of
 * its triggers, keymap, submission, or attachments.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { HoverCardGroup } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DraftSnapshot } from '../../contract/draft-editor.ts'
import { snapshotDraft } from '../../draft.ts'
import { ComposerContentEditable } from './ComposerContentEditable.tsx'
import { DecoratorPortals } from './DecoratorPortals.tsx'
import { DraftEditorRuntime } from './runtime.ts'
import css from './DraftDocumentEditor.module.css'

/** No command or skill names are recognized, so no text renders as a trigger reference. */
const NO_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

type DraftDocumentEditorProps = FactoryComponentPropsOf<'conversation.draft.editor'>

/** Mutable per-mount bookkeeping read by editor listeners. */
interface EditorState {
  props: DraftDocumentEditorProps
  /** Serialized last document reported or loaded, so selection-only commits stay silent. */
  reported: string
  /** Command chip of the loaded document, kept while the text still starts with its token. */
  command: DraftSnapshot['command']
  seeding: boolean
}

/**
 * Project the editor into a semantic document.
 * @param runtime - the editor runtime after `refreshProjection`.
 * @param command - command chip of the loaded document.
 * @returns the current document.
 */
function documentOf(runtime: DraftEditorRuntime, command: DraftSnapshot['command']): DraftSnapshot {
  const { clipboardText, occurrences, quotes } = runtime.projection
  const kept = command !== undefined && clipboardText.startsWith(command.token.trimEnd()) ? command.token : undefined
  return snapshotDraft(clipboardText, occurrences, kept, quotes)
}

/**
 * Render one editable draft document.
 * @param props - the document, its revision, change and blur callbacks, labels, and the Session's reference opener.
 * @returns the scrollport with its editable surface, placeholder, and chip portals.
 */
export function DraftDocumentEditor(props: DraftDocumentEditorProps): ReactNode {
  const { value, revision, onBlur, placeholder, ariaLabel } = props
  const state = useRef<EditorState | null>(null)
  if (state.current === null) state.current = { props, reported: '', command: undefined, seeding: false }
  state.current.props = props
  const [empty, setEmpty] = useState(value.text === '' && (value.quotes?.length ?? 0) === 0)
  const [runtime] = useState(() => {
    const editor: DraftEditorRuntime = new DraftEditorRuntime({
      onUpdate: () => {
        const current = state.current
        /* v8 ignore next -- the state ref is assigned before the runtime is created. */
        if (current === null) return
        editor.refreshProjection()
        const document = documentOf(editor, current.command)
        setEmpty(document.text === '')
        const serialized = JSON.stringify(document)
        if (current.seeding || serialized === current.reported) return
        current.reported = serialized
        current.props.onChange(document)
      },
      quoteLabels: () => ({ remove: state.current?.props.t('quote.remove') ?? '' }),
      openReference: (source, reference) => state.current?.props.openReference(source, reference) ?? false,
      lexicon: () => NO_LEXICON,
      resolveLexicon: () => undefined,
    })
    return editor
  })
  useEffect(() => runtime.register(), [runtime])
  useEffect(() => {
    const current = state.current
    /* v8 ignore next -- the state ref is assigned during the first render. */
    if (current === null) return
    current.seeding = true
    current.command = value.command
    try {
      if (value.references.length === 0 && (value.quotes?.length ?? 0) === 0) runtime.setDraft(value.text)
      else runtime.restoreDraft(value.text, value.references, value.quotes, { remove: current.props.t('quote.remove') })
      runtime.clearHistory()
    } finally {
      current.seeding = false
    }
    runtime.refreshProjection()
    current.reported = JSON.stringify(documentOf(runtime, current.command))
    // The document reloads only when its revision changes; a new `value` object of the same revision is the caller's echo.
  }, [runtime, revision])
  return (
    <div className={css.scroll}>
      <HoverCardGroup className={css.grow}>
        <ComposerContentEditable
          editor={runtime.editor}
          editable
          className={css.input}
          aria-label={ariaLabel}
          data-composer-input={undefined}
          data-draft-document-input
          onBlur={onBlur}
        />
        {empty && <div aria-hidden className={css.placeholder}>{placeholder}</div>}
        <DecoratorPortals editor={runtime.editor} />
      </HoverCardGroup>
    </div>
  )
}
