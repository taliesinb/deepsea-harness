/** Chat-only row visibility; durable events and trajectory inspection remain intact. */
import type { ChatNode } from './chat-nodes.ts'

/**
 * Whether Chat shows a command's row: every command except `permission`.
 * @param name - command name without the leading slash.
 * @returns whether the command contributes a visible Chat row.
 */
export function isVisibleChatCommand(name: string | null | undefined): boolean {
  return name !== 'permission'
}

/**
 * Exclude system prompts, ordinary Context, and permission commands from visible Chat rows.
 * Context containing tool changes retains its notice row.
 * @param node - projected Chat node.
 * @returns whether the node contributes a visible Chat row.
 */
export function isVisibleChatNode(node: ChatNode): boolean {
  return node.visibility === 'visible'
    && node.kind !== 'system-prompt'
    && (node.kind !== 'context'
      || node.data.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
    && !(node.kind === 'command' && !isVisibleChatCommand(node.data.name))
}
