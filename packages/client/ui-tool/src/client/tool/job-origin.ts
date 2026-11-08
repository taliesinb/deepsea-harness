/**
 * Job origins: one hidden Chat Node per background job, so a job tool row can
 * name and reach the call that started the job by keyed reads.
 */
import type { ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Chat Node kind of a job origin; also its Definition kind. */
export const JOB_ORIGIN_KIND = 'tool-job'

/** Facts of the durable job registration needed to present a job by its creating call. */
export interface JobOriginData {
  /** Exact creating invocation, a PTC sub-call when applicable. */
  readonly callId: string
  /** Root invocation owning `callId`; its Chat Node holds the call. */
  readonly rootCallId: string
  /** Producer-supplied one-line label, the command for a shell job. */
  readonly label: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Job origin; always hidden, read by job tool rows. */
    'tool-job': JobOriginData
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Read a job registration payload. The registry writes `job/registered` and,
 * repeating the same facts, `job/settled`; either may be the first loaded.
 * @param data - durable event payload.
 * @returns job id and origin, or null for a job no tool call created.
 */
function jobRegistration(data: unknown): { jobId: string; origin: JobOriginData } | null {
  const fields = record(data)
  const toolCall = record(fields?.toolCall)
  if (fields === null || toolCall === null) return null
  const { jobId, label } = fields
  const { callId, rootCallId } = toolCall
  if (typeof jobId !== 'string' || typeof label !== 'string' || typeof callId !== 'string' || typeof rootCallId !== 'string') return null
  return { jobId, origin: { callId, rootCallId, label } }
}

const matchRegistration = (event: { readonly data: unknown }) => {
  const registration = jobRegistration(event.data)
  return registration === null ? null : { id: registration.jobId, role: 'start' as const }
}

/** Job registrations folded into hidden Chat Nodes keyed by job id. */
export const jobOriginDefinition: ConversationNodeDefinitionInput<JobOriginData | null> = {
  kind: JOB_ORIGIN_KIND,
  target: 'chat',
  match: { 'job/registered': matchRegistration, 'job/settled': matchRegistration },
  start: (_context, match) => jobRegistration(match.event.data)?.origin ?? null,
  // A later settlement repeats the registration's facts.
  update: context => context.state,
  buildViewNode: (context): ChatNode<'tool-job'> | null => {
    const origin = context.state
    const start = context.start
    if (origin === undefined || origin === null || start === undefined) return null
    return {
      key: context.key,
      kind: JOB_ORIGIN_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: start.event.seq,
      location: start.location,
      visibility: 'hidden',
      data: origin,
    }
  },
}

/**
 * Find one call inside its root call's tree.
 * @param root - root call block of a Tool Chat Node.
 * @param callId - exact call to find.
 * @returns the call's current block, when loaded.
 */
export function findCall(root: ToolCallBlock, callId: string): ToolCallBlock | undefined {
  if (root.callId === callId) return root
  for (const child of root.subCalls) {
    const found = findCall(child, callId)
    if (found !== undefined) return found
  }
  return undefined
}
