/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationStoreState } from './contract/views.ts'
import type { DraftInput, DraftSnapshot } from './contract/draft-editor.ts'
import { parseStoredDraft } from './draft.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: DraftInput) => void
  setLastPrompt: (draft: ConversationStoreState, prompt: DraftSnapshot) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft and last-prompt persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: '', view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: DraftInput) => { d.draft = text },
      setLastPrompt: (d, prompt: DraftSnapshot) => { d.lastPrompt = prompt },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/**
 * Read a Session's draft before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns saved semantic content, or an empty document when storage is absent or invalid.
 */
export function readConversationDraft(sessionId: SessionId): DraftSnapshot {
  return readStoredDocument(sessionId, 'draft') ?? { text: '', references: [] }
}

/**
 * Read a Session's last submitted prompt before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the saved semantic document, or undefined when storage holds no valid prompt.
 */
export function readConversationLastPrompt(sessionId: SessionId): DraftSnapshot | undefined {
  return readStoredDocument(sessionId, 'lastPrompt')
}

function readStoredDocument(sessionId: SessionId, field: 'draft' | 'lastPrompt'): DraftSnapshot | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return undefined
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !(field in stored)) return undefined
    return parseStoredDraft((stored as Record<typeof field, unknown>)[field])
  } catch (_error: unknown) {
    // Unavailable browser storage or malformed JSON has no usable saved document.
    return undefined
  }
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('view' in stored)) return null
    return typeof stored.view === 'string' ? stored.view : null
  } catch {
    return null
  }
}
