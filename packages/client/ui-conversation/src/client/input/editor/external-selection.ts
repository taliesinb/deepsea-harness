/**
 * Draft selection while focus is outside the editor. An update made while
 * another element has document focus keeps its editor selection out of the
 * DOM, so a background edit never moves focus or another control's selection.
 * The DOM selection can then fall behind the editor selection: after node
 * removal it collapses onto the root element. Focus entering the root and text
 * input addressed to the root write the editor selection back to the DOM
 * first, so typing lands at the editor selection.
 */
import type { LexicalEditor } from 'lexical'
import {
  $addUpdateTag, $getPreviousSelection, $getRoot, $isRangeSelection, $setSelection,
  BEFORE_INPUT_COMMAND, BLUR_COMMAND, COMMAND_PRIORITY_CRITICAL, RootNode, SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'

/** Whether document focus is outside the editor root. */
function focusOutside(root: HTMLElement): boolean {
  return !root.contains(root.ownerDocument.activeElement)
}

/**
 * Whether the document selection is a caret or range inside the editor's
 * content. A point outside the root is not, and neither is a point on the
 * root element beside its paragraphs, where a selection inside removed
 * paragraphs collapses; an empty root has no other caret position.
 */
function domSelectionInContent(root: HTMLElement): boolean {
  const selection = root.ownerDocument.getSelection()
  if (selection === null || selection.rangeCount === 0) return false
  const { anchorNode, focusNode } = selection
  if (anchorNode === root || focusNode === root) return !root.hasChildNodes()
  return root.contains(anchorNode) && root.contains(focusNode)
}

/**
 * Select the committed editor selection again, marked for a DOM selection
 * write; an editor without a range selection selects its end. Must run inside
 * an editor update.
 */
function $reselectRetainedSelection(): void {
  const retained = $getPreviousSelection()
  if (!$isRangeSelection(retained)) {
    $getRoot().selectEnd()
    return
  }
  const selection = retained.clone()
  selection.dirty = true
  $setSelection(selection)
}

/**
 * Keep the editor selection out of the DOM while focus is elsewhere, and
 * re-converge the DOM selection when focus or text input returns.
 * @param editor - the draft editor.
 * @returns the disposer for commands, the root transform, and root listeners.
 */
export function registerExternalSelection(editor: LexicalEditor): () => void {
  // Set by every update that skipped its DOM selection write; cleared once the
  // DOM selection is known to match the editor selection.
  let domSelectionStale = false
  // The text input whose update applies the editor selection instead of the
  // event's target range, which the browser computed from the stale DOM selection.
  let reselectedInput: InputEvent | null = null

  const preserveExternalSelection = (): false => {
    const root = editor.getRootElement()
    if (root !== null && focusOutside(root)) {
      $addUpdateTag(SKIP_DOM_SELECTION_TAG)
      domSelectionStale = true
    }
    return false
  }
  const reconcileSelectionChange = (): false => {
    const root = editor.getRootElement()
    if (root !== null && !focusOutside(root)) {
      // The editor selection was read from the user's DOM selection.
      domSelectionStale = false
      return false
    }
    // A DOM selection moved onto the root by node removal does not replace
    // the editor selection.
    if (root !== null && !domSelectionInContent(root)) $reselectRetainedSelection()
    return preserveExternalSelection()
  }
  /** @returns whether the editor selection was written to the DOM. */
  const reconverge = (root: HTMLElement): boolean => {
    if (!editor.isEditable() || (!domSelectionStale && domSelectionInContent(root))) return false
    domSelectionStale = false
    // Commit a pending update first, so its selection is the one retained.
    editor.read(() => {})
    // Focus is inside the root, so the root transform keeps this write.
    editor.update($reselectRetainedSelection, { discrete: true })
    return true
  }
  const listenOnRoot = (root: HTMLElement): (() => void) => {
    const onFocusIn = (): void => {
      // Lexical focuses the root from inside its own commit, which an update
      // must not interrupt; the microtask runs once that commit returns.
      queueMicrotask(() => {
        if (editor.getRootElement() === root && !focusOutside(root)) reconverge(root)
      })
    }
    const onBeforeInput = (event: InputEvent): void => {
      if (!(event.target instanceof Node) || !root.contains(event.target)) return
      // Moving the selection would detach a running composition from its text.
      if (event.isComposing) return
      // WebKit delivers text input to the editing host of the DOM selection
      // while document focus stays on the body, so every update would skip its
      // DOM selection write. The input shows that this editor is the target.
      if (focusOutside(root)) root.focus({ preventScroll: true })
      if (reconverge(root)) reselectedInput = event
    }
    // Document capture runs before Lexical's own beforeinput listener on the
    // root, which a listener on the root itself does not guarantee.
    const { ownerDocument } = root
    ownerDocument.addEventListener('beforeinput', onBeforeInput, { capture: true })
    root.addEventListener('focusin', onFocusIn)
    return () => {
      ownerDocument.removeEventListener('beforeinput', onBeforeInput, { capture: true })
      root.removeEventListener('focusin', onFocusIn)
    }
  }

  return mergeRegister(
    editor.registerCommand(BLUR_COMMAND, () => {
      // Finish this batch before an explicit focus can restore its updated selection.
      editor.update(preserveExternalSelection, { discrete: true })
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(SELECTION_CHANGE_COMMAND, reconcileSelectionChange, COMMAND_PRIORITY_CRITICAL),
    editor.registerNodeTransform(RootNode, preserveExternalSelection),
    editor.registerCommand(BEFORE_INPUT_COMMAND, (event) => {
      if (event !== reselectedInput) return false
      reselectedInput = null
      // A dirty selection also keeps Lexical from applying the stale target range.
      $reselectRetainedSelection()
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerRootListener(root => root === null ? undefined : listenOnRoot(root)),
  )
}
