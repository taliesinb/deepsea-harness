/** Browser-safe request, result, and lifecycle vocabulary for the Session Remote service. */
import type { NativeFileApplication } from '@deepseek-ai/dsh-native-command/types'

import type {
  AttachmentIdType, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host state persisted for cold Session list summaries. */
    sessionListMetadata: SessionListMetadata
    /** Host state for the boot-constant image-limit view. */
    imageLimits: null
    /** Durable model selection already used by a request and still pending for a later request. */
    modelSelection: ModelSelectionProjectionState
  }
  interface SessionProjectionMap {
    /** Persisted facts used to summarize a Session without activating it. */
    sessionListMetadata: SessionListMetadata
    /** Image-intake limits enforced by the Session prompt endpoint. */
    imageLimits: ImageAttachmentLimits
    /** Durable model selection already used and selected for the next request. */
    modelSelection: ModelSelectionProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete validated model selection requested for subsequent prompt
     * assembly. Log-only: it never enters derived model history.
     */
    'model/selection': ModelSelection
  }
}

/** Persisted hints used to summarize a cold Session. */
export interface SessionListMetadata {
  /** Whether the folded prefix contains no turn. */
  readonly blank: boolean
  /** Latest human-authored prompt time in the folded prefix. */
  readonly lastPromptAt: number | null
}

/**
 * Every available wire value a Session-list row carries as partial, possibly
 * stale hints. `kind` and `asOfSeq` are independent facts: `kind` says which
 * sequence space `asOfSeq` belongs to, and therefore how a client may merge
 * the block; `asOfSeq` is the producer's watermark in that space.
 */
export interface SessionProjectionHints {
  /**
   * `sequenced`: the Host's live registry produced the block for an attached
   * Session, so `asOfSeq` is comparable with baselines and frames of the same
   * connection. `cached`: a header-only listing viewed the block from the
   * persisted projection cache, so `asOfSeq` is the stored record's own
   * watermark and must not be compared with the connected Session's values.
   */
  readonly kind: 'cached' | 'sequenced'
  /** Watermark of the block in the sequence space named by `kind`. */
  readonly asOfSeq: number
  /** Provider-validated values present in the block; omitted keys remain unknown. */
  readonly values: SessionProjectionValues
}

/** Complete projection values at an exact Session event cursor. */
export interface SessionProjectionBaseline {
  readonly asOfSeq: number
  /** Provider-validated values; omitted keys are absent capabilities at this cut. */
  readonly values: SessionProjectionValues
}

/** Typed known projections plus JSON-safe values contributed outside this compilation face. */
export type SessionProjectionValues = Partial<SessionProjectionMap>
  & Readonly<Record<string, SessionProjectionValue>>

/**
 * Browser-submitted prompt content; the Host promotes image bytes to durable
 * references. File parts carry the opaque receipt returned by a preceding
 * `uploadFile` call on the same Session.
 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }
  | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }

/** Complete model selection for one Session. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Host fold state for durable model selection. */
export interface ModelSelectionProjectionState {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Later user selection not yet consumed by a matching model request. */
  readonly pending: ModelSelection | null
}

/** Client view of the durable model-selection fold. */
export interface ModelSelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next request should use, falling back to {@link lastUsed}. */
  readonly next: ModelSelection | null
}

/** One adapter-owned reasoning effort for an exact model route. */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[]
  readonly defaultEffort?: string
}

/**
 * What one exact model route offers, published so a Client can filter the
 * catalog without its own model vocabulary. Every flag is display metadata;
 * request admission does not read it.
 */
export interface ModelCapabilities {
  /** The route accepts image input (its resolved input modalities include `image`). */
  readonly images: boolean
  /** The route exposes selectable reasoning levels. */
  readonly reasoning: boolean
  /**
   * The route accepts declared tools. Every current chat adapter does; the flag
   * keeps the contract open for one that does not.
   */
  readonly tools: boolean
  /**
   * Using the route costs nothing per token: a route served on this machine
   * (`auth: local`), or one whose published list prices are zero for input and output.
   */
  readonly free: boolean
}

/** One model displayed inside its provider group. */
export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Filterable capabilities; absent from a Host that does not publish them. */
  readonly capabilities?: ModelCapabilities
  readonly reasoning?: ModelReasoning
}

/** One provider and its successfully loaded model catalog. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  /**
   * Catalog (vendor) provider the route resolves to, when its adapter reports
   * one, e.g. `anthropic` for `anthropic-oauth` or `openrouter` for `openrouter-oauth`.
   */
  readonly catalogProvider?: string
  /** Display name of that catalog provider, e.g. `Anthropic`, for titling a route whose name is its bare key. */
  readonly vendor?: string
  /**
   * How the route authenticates and is billed, when its adapter reports it: a
   * subscription sign-in (a plan), a per-token API key, or a model served on
   * this machine.
   */
  readonly auth?: 'subscription' | 'api-key' | 'local'
  readonly models: readonly ModelCatalogModel[]
}

/** One provider whose model catalog lookup failed. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** Host-generation model catalog and the default used by unconfigured Sessions. */
export interface ModelCatalog {
  readonly default: ModelSelection
  /** Provider routes with at least one currently available catalog model. */
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}

/** One client-requested mutation of a still-pending queue item. */
export type QueueAction =
  | {
    readonly kind: 'edit'
    /** Non-empty text-only replacement content. */
    readonly content: readonly TextBlock[]
  }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** One Session list entry. */
export interface SessionSummary {
  /** Whether this Session currently owns a live Agent. */
  readonly agentAvailable: boolean
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: SessionProjectionHints
}

/** One session-content search result. */
export interface SessionSearchItem {
  readonly sessionId: SessionId
  readonly snippet: string
}

/** Maximum number of Sessions returned by one search. */
export const SESSION_SEARCH_RESULT_LIMIT = 20

/** Maximum search snippet length in Unicode code points. */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session/provider-credentials-unavailable': Record<string, never>
    'session/provider-models-unavailable': { readonly provider: string }
    'session/model-unavailable': { readonly provider: string; readonly model: string }
    'session/conflict': {
      readonly sessionId: SessionId
      readonly requestedCwd: string
      readonly existingCwd?: string
    }
    'session/projections-unavailable': Record<string, never>
    'session/writer-held': { readonly sessionId: SessionId }
    'session/agent-busy': { readonly reason: string }
    'session/invalid-time-zone': { readonly value: string }
    'session/workspace-attach-failed': { readonly sessionId: SessionId; readonly workspaceId: string }
    'agent-preset/conflict': {
      readonly sessionId: SessionId
      readonly requestedPreset: string
      readonly existingPreset?: string
    }
    'session/attachment-invalid': { readonly reason: string }
    'session/queue-item-not-found': { readonly itemId: MessageId }
    'session/steer-unavailable': { readonly itemId: MessageId }
    'session/title-invalid': { readonly sessionId: SessionId }
    'session/fork-unavailable': { readonly sessionId: SessionId }
    /**
     * Move refused: retiring the Session's Agent would interrupt the work in
     * `blockers` (a turn, background jobs, subagents); retry with `stopLive`.
     * Empty `blockers` mean another owner or process holds the Session.
     */
    'session/move-live': { readonly sessionId: SessionId; readonly blockers: readonly SessionActivity[] }
    /** Move refused: no stored Session with this id. */
    'session/move-missing': { readonly sessionId: SessionId }
    /** Move refused: the Session already belongs to the destination Workspace. */
    'session/move-same-workspace': { readonly sessionId: SessionId }
    /** Move failed after validation; the message carries the storage or registry failure. */
    'session/move-error': { readonly sessionId: SessionId }
    /** The mounted Session storage cannot relocate Sessions. */
    'session/move-unsupported': Record<string, never>
    /**
     * Copy refused: the source's Agent is running a turn and `truncate` was
     * not decided; `blockers` name the source's work in flight.
     */
    'session/copy-live': { readonly sessionId: SessionId; readonly blockers: readonly SessionActivity[] }
    /** Copy refused: no stored Session with this id. */
    'session/copy-missing': { readonly sessionId: SessionId }
    /** Copy failed after validation; the message carries the read or storage failure. */
    'session/copy-error': { readonly sessionId: SessionId }
    /** The destination directory could not be registered as a Workspace. */
    'workspace/create-failed': { readonly path: string }
    'subagent/not-found': {
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
    }
    'subagent/catalog-diagnostic': {
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
      readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    }
  }
}

/** Session-addressed request for the human-invocable skill catalog. */
export interface SkillListRequest {
  readonly sessionId: SessionId
}

/** One skill available to the Session's human-facing composer. */
export interface SkillEntry {
  /** Absolute SKILL.md path when supplied by a filesystem provider. */
  readonly path?: string
  /** Kebab-case identifier referenced as `/name`. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Whether the same skill is also advertised to the model. */
  readonly modelInvocable: boolean
}

/** Human-invocable skills visible through one Session's composition. */
export interface SkillListValue {
  readonly skills: readonly SkillEntry[]
}

/** Session list request. */
export interface SessionListRequest {
  readonly cursor?: string
}

/** Session list response value. */
export interface SessionListValue {
  readonly items: readonly SessionSummary[]
}

/** Session search request. */
export interface SessionSearchRequest {
  readonly query: string
}

/** Session search response value. */
export interface SessionSearchValue {
  readonly items: readonly SessionSearchItem[]
  readonly hasMore: boolean
}

/** Session creation or explicit-id adoption request. */
export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}

/** Session creation response value. */
export interface SessionCreateValue {
  readonly sessionId: SessionId
  readonly agentPreset?: string
}

/** Session model-selection request. */
export interface SessionSelectModelRequest extends ModelSelection {
  readonly sessionId: SessionId
}

/** Accepted model selection after Host resolution. */
export interface SessionSelectModelValue {
  readonly selected: ModelSelection
}

/** Session rename request. */
export interface SessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

/** Normalized title and the durable event position that committed it. */
export interface SessionRenameValue {
  readonly title: string
  readonly seq: number
}

/** Where a moved Session goes: an existing Workspace, or a directory registered as one on the way. */
export type SessionMoveDestination =
  | { readonly workspaceId: WorkspaceId }
  | { readonly path: string; readonly title?: string }

/** Move one Session, with its same-cwd subagent descendants, to another Workspace. */
export interface SessionMoveRequest {
  readonly sessionId: SessionId
  readonly destination: SessionMoveDestination
  /**
   * Also move a Session whose Agent has work in flight (a turn, running
   * background jobs, running subagents), interrupting it. A resident Agent
   * with nothing in flight is always retired silently; it resumes cold in the
   * new Workspace on the next open. Without this flag a Session with such
   * work is refused with `session/move-live`, whose details name it.
   */
  readonly stopLive?: boolean
  /** Append the relocation notice the Agent reads on its next step; default true. */
  readonly notify?: boolean
}

/** Result of one move. */
export interface SessionMoveValue {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  /** Every Session that changed Workspace, subagent descendants included. */
  readonly moved: readonly SessionId[]
}

/** Why one Session of a batch did not move. */
export interface SessionMoveSkip {
  readonly sessionId: SessionId
  readonly reason: 'live' | 'missing' | 'same-workspace' | 'error'
  readonly message: string
  /** For `live`: the work a move would interrupt (empty when another owner or process holds the Session). */
  readonly blockers?: readonly SessionActivity[]
}

/** Move several Sessions to one Workspace. */
export interface SessionMoveManyRequest {
  readonly sessionIds: readonly SessionId[]
  readonly destination: SessionMoveDestination
  /** Same policy as {@link SessionMoveRequest.stopLive}, applied to every Session. */
  readonly stopLive?: boolean
  /** Same policy as {@link SessionMoveRequest.notify}, applied to every Session. */
  readonly notify?: boolean
}

/** Result of a batch move: skips are reported, not thrown. */
export interface SessionMoveManyValue {
  readonly workspaceId: WorkspaceId
  readonly moved: readonly SessionId[]
  readonly skipped: readonly SessionMoveSkip[]
}

/**
 * Copy one Session, with its subagent descendants, into a Workspace (its own
 * included) as a new Session with a fresh id. The source is only read: a
 * running Agent keeps running.
 */
export interface SessionCopyRequest {
  readonly sessionId: SessionId
  readonly destination: SessionMoveDestination
  /**
   * What to do with a turn in progress at the source. `true`: drop it whole
   * (the copy ends after the last completed turn and the prompt that started
   * the turn is cancelled). `false`: copy what has been recorded and close the
   * turn as interrupted. Omitted: a running source is refused with
   * `session/copy-live` so the caller decides; a cold source whose last turn
   * never ended is closed as interrupted.
   */
  readonly truncate?: boolean
  /** Title recorded on the copy as a user rename; omitted keeps the source's title. */
  readonly title?: string
  /** Append the copy notice the Agent reads on its next step; default true. */
  readonly notify?: boolean
}

/** Result of one copy. */
export interface SessionCopyValue {
  /** The new root Session. */
  readonly sessionId: SessionId
  /** The Session that was copied. */
  readonly sourceSessionId: SessionId
  readonly workspaceId: WorkspaceId
  /** Every Session stored, root first, descendants after. */
  readonly copied: readonly SessionId[]
  /** Whether a turn in progress was dropped. */
  readonly truncated: boolean
}

/** Session fork request. */
export interface SessionForkRequest {
  readonly sessionId: SessionId
  /** Exact inclusive source event seq; omission selects the latest completed-turn prefix. */
  readonly atSeq?: number
}

/** Identity of a newly forked Session. */
export interface SessionForkValue {
  readonly sessionId: SessionId
}

/** Session prompt request. */
export interface SessionPromptRequest {
  /** Client-minted identity persisted on the exact accepted user message. */
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  /** At least one non-whitespace text part or attachment. */
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}

/** Receipt after one prompt enters the target Agent inbox. */
export interface SessionPromptValue {
  readonly accepted: true
}

/** Durable image read request. */
export interface SessionAttachmentRequest {
  readonly sessionId: SessionId
  readonly attachmentId: AttachmentIdType
}

/** Durable image read response value. */
export interface SessionAttachmentValue {
  readonly attachment: ImageAttachmentRef
  readonly data: string
}

/** Pending queue mutation request. */
export interface SessionUpdateQueueRequest {
  readonly sessionId: SessionId
  readonly itemId: MessageId
  readonly action: QueueAction
}

/** Receipt after one pending queue mutation commits. */
export interface SessionUpdateQueueValue {
  readonly accepted: true
}

/** Active-turn cancellation request. */
export interface SessionCancelRequest {
  readonly sessionId: SessionId
}

/** Receipt after cancellation is admitted to the live Agent. */
export interface SessionCancelValue {
  readonly accepted: true
}

/** Request to open one path prepared by a Session-aware caller on the Host desktop. */
export interface SessionOpenWorkspacePathRequest {
  /** File-manager navigation when requested; omission uses the default application. */
  readonly action?: 'reveal'
  /** Registered application identifier; ignored for reveal. Omission preserves the operating system default. */
  readonly application?: string
  /** Path after best-effort Session workspace resolution, in Host filesystem syntax. */
  readonly path: string
}

/** Confirmation that the Host handed a workspace path to its native opener. */
export interface SessionOpenWorkspacePathValue {
  readonly opened: true
}

/** Client-minted prompt identity used to reconcile optimistic and durable messages. */
export type SessionRequestId = Branded<'session-request-id'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Browser prompt correlation and optional Host-validated time zone. */
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string }
  }
}

/** Durable identity selecting an ordinary Session or one direct subagent child. */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly mode: 'one-shot' | 'continuable' | 'unknown'
  }

/** One non-activating Session projection read. */
export interface SessionProjectionsRequest {
  readonly sessionId: SessionId
}

/** Complete Session projection baseline; null when the Session does not exist. */
export type SessionProjectionsValue = SessionProjectionBaseline | null

/** One raw Session event in the Remote journal. */
export interface SessionEventEntry {
  readonly type: 'event'
  readonly event: SessionWireEvent
}

/** Current logical Session metadata carried on the browser wire. */
export interface SessionWireHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  /** Whether the Session contains a fork-inherited prefix. */
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** Browser wire surface operation; replacement endpoints are earlier event seqs in surface order. */
export type SessionWireSurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/** One history-page record with compact Assistant streams embedded inside events. */
export type SessionHistoryRecord = SessionEventEntry

/**
 * Exact Session event envelope accepted by the Client journal adapter.
 * Surface events require surfaceOp; only non-Assistant surface events may cite earlier sources.
 * Durable readers own recognition of merge-extensible event names.
 */
export interface SessionWireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly ignorable?: true
  /** Earlier sources on current surface events; opaque JSON on unknown ignorable events. */
  readonly sourceEventSeqs?: JsonValue
  /** Canonical placement on current surface events; opaque JSON on unknown ignorable events. */
  readonly surfaceOp?: JsonValue
}

/** One message-aligned backwards-history request. */
export interface SessionPageRequest {
  readonly address: SessionAddress
  /** Inclusive log cut obtained from the corresponding follow opening frame. */
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
  /** Stop at a Turn start after both minima, unless maxMessages or history exhaustion wins. */
  readonly turnWindow?: {
    /** Minimum append-origin user/assistant messages; must not exceed maxMessages. */
    readonly minMessages: number
    /** Minimum Turn starts crossed, including the partial Turn at beforeSeq. */
    readonly minTurns: number
  }
}

/** One live event request for a durable Session address. */
export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
  readonly address: SessionAddress
  /** Include process-local assistant presentation frames for the Web client. */
  readonly assistantStream?: true
}

/** One active assistant attempt in a reconnect opening snapshot. */
export interface SessionAssistantStreamAttempt {
  readonly attemptId: LlmAttemptId
  /** Last durable Session seq observed when this attempt started. */
  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number
  /** Dense position expected for the next live chunk frame. */
  readonly nextIndex: number
  /** Compact detached stream accumulated at this opening revision. */
  readonly stream: readonly JsonValue[]
}

/** Complete process-local assistant state at one follow opening. */
export interface SessionAssistantStreamBaseline {
  readonly revision: number
  readonly activeAttempt?: SessionAssistantStreamAttempt
}

/** Browser wire form of one process-local assistant frame. */
export type SessionAssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly startedAfterSeq: SessionSeqCursor
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: JsonValue
  }
  | {
    readonly type: 'end'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    /** Number of chunk frames represented by this terminal marker. */
    readonly index: number
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
      | { readonly kind: 'abandoned' }
  }

/** One contiguous backwards page of a Session log. */
export interface SessionPage {
  readonly records: readonly SessionHistoryRecord[]
  readonly hasMore: boolean
}

/** Complete opening window followed by ordered durable events and opted-in assistant frames. */
export type SessionFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly header: SessionWireHeader
    readonly cursor: number
    readonly records: readonly SessionHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: SessionProjectionBaseline
    readonly assistantStream?: SessionAssistantStreamBaseline
  }
  | SessionEventEntry
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

/** Complete live control baseline emitted once per control stream generation. */
export interface SessionControlBaseline {
  readonly projections: Readonly<Record<SessionId, SessionProjectionBaseline>>
}

/** One finished projection value and its durable watermark. */
export interface SessionProjectionUpdate {
  readonly sessionId: SessionId
  readonly key: string
  readonly value: JsonValue
  readonly seq: number
}

/** Host-wide live state stream. Each generation starts with exactly one baseline. */
export type SessionControlFrame =
  | { readonly type: 'baseline'; readonly value: SessionControlBaseline }
  | ({ readonly type: 'projection' } & SessionProjectionUpdate)

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A Session became visible or its Agent was created or disposed.
     * Consumers upsert the summary and replace its current running and availability state.
     * @mode emit
     * @param summary - current list row for the Session.
     */
    'api-session/added'(summary: SessionSummary): void
    /**
     * A Session left the live Host registry.
     * @mode emit
     * @param sessionId - removed Session identity.
     */
    'api-session/removed'(sessionId: SessionId): void
    /**
     * One Agent changed running state.
     * @mode emit
     * @param sessionId - Agent and Session identity.
     * @param running - whether the Agent is running.
     */
    'api-session/status'(sessionId: SessionId, running: boolean): void
    /**
     * One user-authored durable message advanced Session list activity.
     * @mode emit
     * @param sessionId - addressed Session identity.
     * @param updatedAt - durable message time used for list ordering.
     */
    'api-session/activity'(sessionId: SessionId, updatedAt: number): void
    /**
     * One Agent failed outside a durable turn position.
     * @mode emit
     * @param sessionId - Agent and Session identity.
     * @param message - user-safe failure chain.
     */
    'api-session/error'(sessionId: SessionId, message: string): void
  }
}

/** JSON-compatible projection value accepted by list consumers. */
export type SessionProjectionValue = JsonValue

/** Application metadata returned by the serving desktop for one file. */
export type SessionWorkspacePathApplication = NativeFileApplication
