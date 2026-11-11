/** Historical prompt actions and their frame-wide outcome notices. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionRewindValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredAttachmentDraft } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatKey } from '../locale.ts'
import { NS } from '../locale.ts'
import { RewindNoticeHost } from './RewindNoticeHost.tsx'

/** Destructive operation on one durable user prompt. */
export type UserRewindAction = 'edit' | 'replay' | 'delete'

/** Callbacks supplied by the historical-user keyed renderer registration. */
export interface UserRewindInjected {
  /**
   * Rewind after the bubble's inline confirmation; reported failures resolve without changing the draft.
   * @param seq - the prompt's `user/message` seq.
   * @param action - what to do with the prompt after the history before it is restored.
   */
  onRewind: (seq: number, action: UserRewindAction) => Promise<void>
  /**
   * Whether a rewind at this prompt must be confirmed first: always for `delete`; for `edit` and
   * `replay` only when it would discard what came after the prompt (see {@link discardsLaterWork}).
   * Read when the action is chosen, not during render.
   * @param seq - the prompt's `user/message` seq.
   * @param action - the chosen action.
   * @returns true when the bubble asks before running the action.
   */
  needsConfirmation: (seq: number, action: UserRewindAction) => boolean
}

/**
 * Whether anything after a prompt is worth keeping: a later human prompt, an assistant message, or a
 * tool call. Failed model attempts, turn and step boundaries, error turn ends, and injected context
 * are not, so rewinding a prompt whose turn only failed (an API error) discards nothing.
 * @param entries - the loaded event window, which reaches the live tail.
 * @param seq - the prompt's `user/message` seq.
 * @returns true when an event after `seq` would be lost.
 */
export function discardsLaterWork(entries: readonly SessionEventLikeEntry[], seq: number): boolean {
  return entries.some(({ event }) => {
    if (event.seq <= seq) return false
    switch (event.type) {
      case 'user/message':
        return event.data.source.kind === 'user'
      case 'assistant/message':
      case 'tool/call':
        return true
      default:
        return false
    }
  })
}

/** Transient outcome, held outside the bubble that a rewind may remove. */
export interface RewindNoticeState {
  readonly notice: { readonly key: ChatKey; readonly seq: number } | null
}

/** Apply-world state and callback consumed by the notice overlay. */
export interface RewindNoticeInjected {
  hooks: { rewind: HostObservable<RewindNoticeState> }
  dismissNotice: () => void
}

interface RewindDependencies {
  /** The Session's loaded event window; undefined while it has none. */
  events: () => readonly SessionEventLikeEntry[] | undefined
  rewind: (seq: number, action: UserRewindAction) => Promise<SessionRewindValue>
  /** Put the removed prompt and its staged attachments in the composer. */
  restore: (value: SessionRewindValue) => Promise<void>
  notify: (key: ChatKey) => void
}

/**
 * Plain prompt text of stored user content: text blocks joined in order.
 * @param content - stored user message content.
 * @returns the text a draft restores.
 */
export function promptText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Serialize one renderer's destructive actions and keep drafts unchanged on refusal. The Host's
 * history-trim frame updates every open window, this one included, so nothing here reloads.
 * @param dependencies - authoritative mutation, composer restoration, and feedback owners.
 * @returns callbacks for one retained Session renderer.
 */
export function createUserRewindActions(dependencies: RewindDependencies): UserRewindInjected {
  let pending = false
  return {
    needsConfirmation(seq, action) {
      if (action === 'delete') return true
      const events = dependencies.events()
      return events === undefined || discardsLaterWork(events, seq)
    },
    async onRewind(seq, action) {
      if (pending) return
      pending = true
      try {
        let value: SessionRewindValue
        try {
          value = await dependencies.rewind(seq, action)
        } catch (_error: unknown) {
          // The Host refused before removing anything; the current history stays as it is.
          dependencies.notify('message.rewind.failed')
          return
        }
        // A replay the Host could not queue returns its prompt to the draft instead of losing it.
        const unsent = action === 'replay' && value.replayed !== true
        if (action === 'edit' || unsent) await dependencies.restore(value)
        dependencies.notify(unsent ? 'message.rewind.replayFailed' : `message.rewind.${action}Done`)
      } catch (_error: unknown) {
        // History already changed on the Host; only the composer restore failed.
        dependencies.notify('message.rewind.restoreFailed')
      } finally {
        pending = false
      }
    },
  }
}

/**
 * Register the persistent outcome-notice host and bind Session-addressed actions.
 * @param ctx - Chat plugin context; owns overlay disposal and remote/composer services.
 * @returns an injection factory for durable prompt renderers.
 */
export function registerUserRewind(ctx: Context): (sessionId: SessionId) => UserRewindInjected {
  const state = createSnapshotStore<RewindNoticeState>({ notice: null })
  let noticeSeq = 0
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'chat.rewind', locale: NS,
    inject: (): RewindNoticeInjected => ({
      hooks: { rewind: state },
      dismissNotice: () => { state.set({ notice: null }) },
    }),
  }, RewindNoticeHost))
  return sessionId => createUserRewindActions({
    events: () => ctx.sessions.binding(sessionId)?.eventSource.getSnapshot().entries,
    rewind: async (seq, action) => {
      const result = await ctx.remote.session.rewind({ sessionId, userEventSeq: seq as SessionSeq, action })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    restore: async (value) => {
      const actx = ctx.sessions.scope(sessionId)
      if (actx === undefined) throw new Error('rewind: Session scope unavailable')
      // The history image cache usually already holds the bubble's image; otherwise it loads it once.
      const stored = await Promise.all(value.attachments.map(async (attachment): Promise<StoredAttachmentDraft> =>
        attachment.type === 'file' ? attachment : {
          ...attachment,
          previewUrl: ctx.uiConversation.peekImageUrl(sessionId, attachment.image)
            ?? await ctx.uiConversation.imageUrl(sessionId, attachment.image),
        }))
      const input = ctx.conversation.input.for(actx)
      input.setDraft(promptText(value.content))
      if (stored.length > 0) input.addAttachments(ctx.conversation.createStoredDrafts(stored).map(draft => draft.id))
    },
    notify: (key) => { state.set({ notice: { key, seq: ++noticeSeq } }) },
  })
}
