/** Pure diff-card derivation from raw file-mutation calls and result metadata. @module */
import type { DiffBlockProps, DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolArgs } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'
import { recordedAbsolutePath } from './recorded-path.ts'

/** Room for a path, one removed/added pair, and three context lines on each side. */
export const CHAT_DIFF_MAX_LINES = 9

/**
 * The {@link DiffBlock} props this derivation owns. Picked off the primitive's
 * props so the two stay in step; `maxLines`/`className` belong to each render
 * site.
 */
export interface DiffCardModel {
  /**
   * The props {@link DiffBlock} draws. Held as a nested object so a render site
   * spreads exactly the primitive's own surface and can never leak a
   * neighbouring field into it.
   */
  card: Pick<DiffBlockProps, 'diffs'>
}

/**
 * Narrow opaque result metadata's `diffs` to well-formed hunks.
 * @param diffs - the metadata field to validate.
 * @returns the validated hunks, or null when the payload is not usable.
 */
function narrowDiffs(diffs: unknown): DiffHunk[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: DiffHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

type IntendedDiff = { tool: 'write' | 'edit' | 'str_replace_editor'; diff: DiffHunk }

function intendedDiff(block: ToolCallBlock): IntendedDiff | null {
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  if (parsed.name === 'str_replace_editor') {
    const { command, path, file_text: fileText, old_str: oldText, new_str: newText } = parsed.args
    if (typeof path !== 'string' || path.trim() === '') return null
    if (command === 'create') {
      if (fileText !== undefined && typeof fileText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: null, newText: fileText ?? '' },
      }
    }
    if (command === 'str_replace') {
      if (oldText !== undefined && typeof oldText !== 'string') return null
      if (newText !== undefined && typeof newText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: oldText ?? null, newText: newText ?? '' },
      }
    }
    return null
  }
  const { file_path: path } = parsed.args
  if (typeof path !== 'string' || path.trim() === '') return null
  if (parsed.name === 'write') {
    const { content } = parsed.args
    return typeof content === 'string'
      ? { tool: 'write', diff: { path, oldText: null, newText: content } }
      : null
  }
  if (parsed.name !== 'edit') return null
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = parsed.args
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return null
  return { tool: 'edit', diff: { path, oldText: oldText || null, newText } }
}

function appliedDiffs(meta: unknown): DiffHunk[] | 'empty' | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  return narrowDiffs(diffs)
}

/**
 * Derive running diffs for root write/edit and `str_replace_editor`
 * create/replace calls, plus applied settled diffs for root write/edit calls.
 * A successful write with valid empty metadata uses its argument-derived
 * whole-file diff, matching create and identical-overwrite presentation;
 * `str_replace_editor` settles through Generic because it has no result view.
 * A settled call whose arguments carry no single intended diff, such as a
 * multi-file patch, shows only the applied diffs its result metadata records.
 * @param block - running or settled Tool block.
 * @returns the diff-card props, or null for the generic path.
 */
export function diffCardModel(block: ToolCallBlock): DiffCardModel | null {
  if (block.parentCallId !== undefined) return null
  const intended = intendedDiff(block)
  if (intended === null) {
    if (!('kind' in block) || block.isError) return null
    const applied = appliedDiffs(block.meta)
    return applied === null || applied === 'empty' ? null : { card: { diffs: applied } }
  }
  if (!('kind' in block)) return { card: { diffs: [intended.diff] } }
  if (intended.tool === 'str_replace_editor') return null
  if (block.isError) return null
  const applied = appliedDiffs(block.meta)
  if (applied === null || applied === 'empty') {
    return intended.tool === 'write' ? { card: { diffs: [intended.diff] } } : null
  }
  const path = recordedAbsolutePath(block.meta, 'path')
  return { card: { diffs: applied.map(diff => diff.path === path ? { ...diff, path: intended.diff.path } : diff) } }
}

/**
 * The diff card of a root write/edit call whose arguments are still streaming,
/**
 * The streaming arguments of a preparing root write/edit call whose diff card
 * the expanded row shows. A collapsed row reads nothing beyond its own summary.
 */
export interface PreparingDiffSource {
  readonly toolName: 'write' | 'edit'
  /** The preparing call's argument view, which grows in place. */
  readonly args: ToolArgs
}

/**
 * Select the streaming diff card of a preparing call.
 * @param toolName - wire tool name.
 * @param args - the preparing call's argument view.
 * @returns the source for write and edit once `file_path` is complete, else null.
 */
export function preparingDiffSource(toolName: string, args: ToolArgs): PreparingDiffSource | null {
  if (toolName !== 'write' && toolName !== 'edit') return null
  return args.complete('file_path') ? { toolName, args } : null
}

/**
 * Count the decoded characters of the content fields streamed so far. Read
 * during render, it makes every streamed character republish the block.
 * @param source - the streaming call.
 * @returns `content` length for write, `old_string` plus `new_string` length for edit.
 */
export function preparingDiffProgress(source: PreparingDiffSource): number {
  const { toolName, args } = source
  return toolName === 'write'
    ? args.stringLength('content') ?? 0
    : (args.stringLength('old_string') ?? 0) + (args.stringLength('new_string') ?? 0)
}

/**
 * Read the intended diff from the arguments streamed so far: the `content` as
 * a whole-file diff for write, the `old_string`/`new_string` pair for edit,
 * as {@link diffCardModel} reads them once the call is dispatched.
 * @param source - the streaming call.
 * @returns the diff card, or null until a content field opens.
 */
export function preparingDiffCard(source: PreparingDiffSource): DiffCardModel | null {
  const { toolName, args } = source
  const path = args.text('file_path')
  if (path === undefined) return null
  if (toolName === 'write') {
    const content = args.text('content')
    return content === undefined ? null : { card: { diffs: [{ path, oldText: null, newText: content }] } }
  }
  const oldText = args.text('old_string')
  const newText = args.text('new_string')
  return oldText === undefined && newText === undefined ? null
    : { card: { diffs: [{ path, oldText: oldText || null, newText: newText ?? '' }] } }
}
