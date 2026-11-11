/** `job_output` and `job_kill` rows, naming the job by the call that started it. */
import { useMemo } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { findCall, JOB_ORIGIN_KIND, jobOriginDefinition, type JobOriginData } from '../job-origin.ts'
import { revealToolCall } from '../reveal-call.ts'
import { DetailsRow, type DetailsSubject } from './details-row.tsx'

/** Chat Node keys the row reads its job's origin through. */
export interface JobRowInjected {
  /** @param jobId - registry job id. @returns key of the job's origin Node. */
  jobNodeKey: (jobId: string) => string
  /** @param callId - root Tool call id. @returns key of that call's Chat Node. */
  callNodeKey: (callId: string) => string
}

type JobRowProps = ToolCallViewProps & PropsLocale<'conversation'> & InjectFace<JobRowInjected>

function firstLine(text: string): string {
  const end = text.indexOf('\n')
  return (end < 0 ? text : text.slice(0, end)).trim()
}

/**
 * Present a job tool call by the description of the call that started the
 * job, or the job's label, as a link to that call; the job id stays the
 * link's tooltip and the expanded title. A job whose creating call is not
 * loaded in this transcript keeps its id. A waiting `job_output` reads
 * "Wait for job".
 * @param props - Tool call, keyed Node readers, and locale.
 * @returns the recorded-result row.
 */
export function JobRow(props: JobRowProps) {
  const { toolName, block, useChat, jobNodeKey, callNodeKey } = props
  const jobId = block.args.complete('job_id') ? block.args.text('job_id') : undefined
  const origin = useChat((chat) => {
    const node = jobId === undefined ? undefined : chat.nodes.get(jobNodeKey(jobId))
    return node?.kind === JOB_ORIGIN_KIND ? node.data as JobOriginData : undefined
  })
  // undefined while the creating call is not loaded; '' when it has no description.
  const description = useChat((chat) => {
    if (origin === undefined) return undefined
    const node = chat.nodes.get(callNodeKey(origin.rootCallId))
    if (node?.kind !== 'tool-call') return undefined
    const call = findCall((node.data as ToolChatData).root, origin.callId)
    return call === undefined ? undefined : call.args.text('description') ?? ''
  })
  const subject = useMemo((): DetailsSubject | undefined => {
    if (jobId === undefined || origin === undefined || description === undefined) return undefined
    const callId = origin.callId
    return {
      id: jobId,
      label: firstLine(description) || firstLine(origin.label) || jobId,
      reveal: (element) => { revealToolCall(element, callId) },
    }
  }, [jobId, origin, description])
  const waiting = toolName === 'job_output' && block.args.value('wait') === true
  return <DetailsRow {...props} titleKey={waiting ? 'tool.title.waitJob' : undefined} subject={subject} />
}

/** Register the job origin Definition and the `job_output` / `job_kill` rows. */
export const jobToolview = {
  name: 'job-toolview',
  inject: ['slots', 'uiConversation'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.uiConversation.events.register(jobOriginDefinition), 'ui-tool: job origins')
    const inject = (): JobRowInjected => ({
      jobNodeKey: jobId => ctx.uiConversation.contextKey(JOB_ORIGIN_KIND, jobId),
      callNodeKey: callId => ctx.uiConversation.contextKey('tool-call', callId),
    })
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'job_output', locale: NS, inject }, JobRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'job_kill', locale: NS, inject }, JobRow)
    })
  },
}
