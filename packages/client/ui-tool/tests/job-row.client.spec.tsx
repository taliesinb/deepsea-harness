// @vitest-environment jsdom
/** Job tool rows: the waiting title, the origin link, its fallbacks, and the reveal of the originating call. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationMatchHandler, ConversationNodeContext, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { statusLine } from '@deepseek-ai/dsh-tool-jobs/src/render.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { findCall, jobOriginDefinition, type JobOriginData } from '../src/client/tool/job-origin.ts'
import { revealToolCall } from '../src/client/tool/reveal-call.ts'
import { JobRow, jobToolview } from '../src/client/tool/toolviews/job-row.tsx'

const t = makeTranslate(en, commonEn)
const BASH_ARGS = '{"command":"sleep 120; echo done","description":"Sleep 120 s in the background","run_in_background":true}'

function settled(callId: string, name: string, argsRaw: string, text: string, extra: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId, name,
    args: PartialArguments.fromText(argsRaw), call: { name, argsRaw },
    content: [{ type: 'text', text }], isError: false, subCalls: [], ...extra,
  }
}

function started(callId: string, name: string, argsRaw: string): ToolCallBlock {
  return {
    phase: 'start', callId, name, argsRaw, args: PartialArguments.fromText(argsRaw),
    turn: 2, step: 1, time: 1_000, subCalls: [],
  }
}

const origin: JobOriginData = { callId: 'c-bash', rootCallId: 'c-bash', label: 'sleep 120; echo done\nsecond line' }

/** Chat Nodes by key, read through the same keyed store the row's `useChat` selectors see. */
function chatOf(nodes: Nodes) {
  const chat = { nodes: { get: (key: string) => nodes[key] } }
  return (selector: (snapshot: never) => unknown) => selector(chat as never)
}

type Nodes = Record<string, { kind: string; data: unknown }>

function rowProps(block: ToolCallBlock, toolName: string, nodes: Nodes): Parameters<typeof JobRow>[0] {
  return {
    useDisclosure, toolName, block, t,
    useChat: chatOf(nodes),
    jobNodeKey: (jobId: string) => `job/${jobId}`,
    callNodeKey: (callId: string) => `call/${callId}`,
  } as never
}

const loaded = (bash: ToolCallBlock = settled('c-bash', 'bash', BASH_ARGS, 'started background job bash-1')) => ({
  'job/bash-1': { kind: 'tool-job', data: origin },
  'call/c-bash': { kind: 'tool-call', data: { root: bash } },
})

const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockClear()
  Element.prototype.scrollIntoView = scrollIntoView
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('JobRow', () => {
  it('titles a waiting job_output and names the job by its creating call', () => {
    render(<JobRow {...rowProps(started('c-wait', 'job_output', '{"job_id":"bash-1","wait":true,"timeout_ms":150000}'), 'job_output', loaded())} />)
    expect(screen.getByText('Wait for job')).toBeTruthy()
    const link = screen.getByRole('button', { name: 'Sleep 120 s in the background' })
    expect(link.getAttribute('title')).toBe('bash-1')
  })

  it('keeps the read title, puts the status after the link, and keeps the id in the expanded details', () => {
    const block = settled('c-read', 'job_output', '{"job_id":"bash-1"}', `partial\n${statusLine({ status: 'running' })}`)
    render(<JobRow {...rowProps(block, 'job_output', loaded())} />)
    expect(screen.getByText('Read job output')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sleep 120 s in the background' })).toBeTruthy()
    expect(screen.getByText('· Running')).toBeTruthy()
    fireEvent.click(screen.getByText('Read job output'))
    expect(screen.getAllByText('Sleep 120 s in the background')).toHaveLength(1)
    expect(screen.queryByText('· Running')).toBeNull()
    expect(screen.getByText('bash-1')).toBeTruthy()
  })

  it('names a job_kill receipt the same way', () => {
    const block = settled('c-kill', 'job_kill', '{"job_id":"bash-1"}', 'requested cancellation of job bash-1')
    render(<JobRow {...rowProps(block, 'job_kill', loaded())} />)
    expect(screen.getByText('Cancel background job')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sleep 120 s in the background' })).toBeTruthy()
    expect(screen.getByText('· Cancellation requested')).toBeTruthy()
  })

  it('uses the first line of the job label for a call without a description', () => {
    const bash = settled('c-bash', 'bash', '{"command":"sleep 120; echo done"}', 'started background job bash-1')
    render(<JobRow {...rowProps(started('c-read', 'job_output', '{"job_id":"bash-1"}'), 'job_output', loaded(bash))} />)
    expect(screen.getByRole('button', { name: 'sleep 120; echo done' })).toBeTruthy()
  })

  it('finds a creating PTC sub-call inside its root call', () => {
    const child = settled('c-child', 'bash', BASH_ARGS, 'started background job bash-1', { parentCallId: 'c-root' })
    const root = settled('c-root', 'run_code', '{"code":"x"}', 'ok', { subCalls: [child] })
    expect(findCall(root, 'c-child')).toBe(child)
    expect(findCall(root, 'c-other')).toBeUndefined()
    const nodes = {
      'job/bash-1': { kind: 'tool-job', data: { callId: 'c-child', rootCallId: 'c-root', label: 'x' } },
      'call/c-root': { kind: 'tool-call', data: { root } },
    }
    render(<JobRow {...rowProps(started('c-read', 'job_output', '{"job_id":"bash-1"}'), 'job_output', nodes)} />)
    expect(screen.getByRole('button', { name: 'Sleep 120 s in the background' })).toBeTruthy()
  })

  it.each([
    ['no origin is loaded', {}],
    ['the creating call is not loaded', { 'job/bash-1': { kind: 'tool-job', data: origin } }],
    ['the creating call is outside its root', { 'job/bash-1': { kind: 'tool-job', data: origin }, 'call/c-bash': { kind: 'tool-call', data: { root: started('c-root', 'bash', '{}') } } }],
    ['the keys name other Node kinds', { 'job/bash-1': { kind: 'tool-call', data: origin } }],
  ])('falls back to the job id when %s', (_case, nodes) => {
    render(<JobRow {...rowProps(started('c-read', 'job_output', '{"job_id":"bash-1"}'), 'job_output', nodes)} />)
    expect(screen.getByText('bash-1')).toBeTruthy()
    expect(screen.queryByTitle('bash-1')).toBeNull()
  })

  it('reads no origin before the job id is complete, and none for a failed call', () => {
    const preparing: ToolCallBlock = { phase: 'preparing', callId: 'c-p', name: 'job_output', args: PartialArguments.fromText('{"job_id":"bash'), turn: 1, step: 1, time: 1, subCalls: [] }
    const view = render(<JobRow {...rowProps(preparing, 'job_output', loaded())} />)
    expect(screen.queryByRole('button', { name: 'Sleep 120 s in the background' })).toBeNull()
    view.unmount()
    const failed = settled('c-f', 'job_output', '{"job_id":"bash-1"}', 'unknown job bash-1', { isError: true })
    render(<JobRow {...rowProps(failed, 'job_output', loaded())} />)
    expect(screen.queryByRole('button', { name: 'Sleep 120 s in the background' })).toBeNull()
    expect(screen.getByText('unknown job bash-1')).toBeTruthy()
  })

  it('reveals the creating call from the link without toggling its own row', () => {
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const group = document.createElement('div')
    group.setAttribute('hidden', 'until-found')
    const opened = vi.fn(() => { group.removeAttribute('hidden') })
    group.addEventListener('beforematch', opened)
    const target = document.createElement('div')
    target.dataset.chatCallId = 'c-bash'
    group.append(target)
    const host = document.createElement('div')
    scroll.append(group, host)
    document.body.append(scroll)
    render(<JobRow {...rowProps(settled('c-read', 'job_output', '{"job_id":"bash-1"}', `x\n${statusLine({ status: 'running' })}`), 'job_output', loaded())} />, { container: host })
    const link = screen.getByRole('button', { name: 'Sleep 120 s in the background' })
    fireEvent.keyDown(link, { key: 'Enter' })
    fireEvent.click(link)
    expect(opened).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    expect(scrollIntoView.mock.contexts).toEqual([target])
    expect(target.hasAttribute('data-tool-call-reveal')).toBe(true)
    expect(screen.queryByText('Output')).toBeNull()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    scroll.remove()
  })
})

describe('revealToolCall', () => {
  function transcript(): { origin: HTMLElement; row: HTMLElement } {
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const other = document.createElement('div')
    other.dataset.chatCallId = 'c-other'
    const row = document.createElement('div')
    row.dataset.chatCallId = 'c-bash'
    row.append(document.createElement('span'))
    const origin = document.createElement('button')
    scroll.append(other, row, origin)
    document.body.append(scroll)
    return { origin, row }
  }

  it('reports a call that is not loaded in the transcript', () => {
    const { origin } = transcript()
    expect(revealToolCall(origin, 'c-missing')).toBe(false)
  })

  it('jumps without motion when reduced motion is requested and unmarks the row when its highlight ends', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const { origin, row } = transcript()
    expect(revealToolCall(origin, 'c-bash')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'center', inline: 'nearest' })
    expect(scrollIntoView.mock.contexts).toEqual([row])
    row.firstElementChild!.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(row.hasAttribute('data-tool-call-reveal')).toBe(true)
    row.dispatchEvent(new Event('animationend'))
    expect(row.hasAttribute('data-tool-call-reveal')).toBe(false)
  })
})

describe('jobOriginDefinition', () => {
  const registration = {
    jobId: 'bash-1', owner: 'session-1', kind: 'bash', label: 'sleep 120; echo done', startedAt: 1,
    toolCall: { callId: 'c-bash', rootCallId: 'c-bash' },
  }
  const table = jobOriginDefinition.match as Readonly<Record<string, ConversationMatchHandler>>
  const event = (type: string, data: unknown, seq = 5) => ({ type, seq, time: seq, data }) as never
  const startOf = (data: unknown): ConversationStartMatch => ({ event: event('job/registered', data), role: 'start', location: { kind: 'session' } })
  const context = (start: ConversationStartMatch | undefined, state: JobOriginData | null | undefined) => ({
    key: 'k', kind: 'tool-job', id: 'bash-1', matches: [], start, state, current: new Map(),
  }) as ConversationNodeContext<JobOriginData | null> & { state: JobOriginData | null }

  it('opens one Context per job from either lifecycle record', () => {
    expect(table['job/registered']!(event('job/registered', registration))).toEqual({ id: 'bash-1', role: 'start' })
    expect(table['job/settled']!(event('job/settled', { ...registration, status: 'completed' }))).toEqual({ id: 'bash-1', role: 'start' })
  })

  it.each([
    ['no creating call', { ...registration, toolCall: undefined }],
    ['a malformed creating call', { ...registration, toolCall: { callId: 'c' } }],
    ['no job id', { ...registration, jobId: 1 }],
    ['a non-record payload', ['bash-1']],
  ])('ignores a record with %s', (_case, data) => {
    expect(table['job/registered']!(event('job/registered', data))).toBeNull()
    expect(jobOriginDefinition.start(context(undefined, undefined), startOf(data), { previous: () => undefined })).toBeNull()
  })

  it('keeps the first loaded facts and builds one hidden Chat Node', () => {
    const start = startOf(registration)
    const state = jobOriginDefinition.start(context(undefined, undefined), start, { previous: () => undefined })
    expect(state).toEqual({ callId: 'c-bash', rootCallId: 'c-bash', label: 'sleep 120; echo done' })
    expect(jobOriginDefinition.update(context(start, state), { event: event('job/settled', registration, 9), role: 'start', location: { kind: 'session' } })).toBe(state)
    expect(jobOriginDefinition.buildViewNode!(context(start, state))).toEqual({
      key: 'k', kind: 'tool-job', id: 'bash-1', target: 'chat', anchorSeq: 5,
      location: { kind: 'session' }, visibility: 'hidden', data: state,
    })
    expect(jobOriginDefinition.buildViewNode!(context(start, null))).toBeNull()
    expect(jobOriginDefinition.buildViewNode!(context(undefined, state))).toBeNull()
  })
})

describe('jobToolview', () => {
  it('registers the origin Definition and both job rows with keyed Node readers', () => {
    const disposeDefinition = vi.fn()
    const registerDefinition = vi.fn(() => disposeDefinition)
    type Readers = { jobNodeKey: (id: string) => string; callNodeKey: (id: string) => string }
    const register = vi.fn((_spec: { key: string; inject: () => Readers }, _component: unknown) => () => undefined)
    const inject = vi.fn((_name: string, callback: () => Iterable<() => void>) => {
      for (const dispose of callback()) dispose()
    })
    const effect = vi.fn((callback: () => () => void) => callback())
    jobToolview.apply({
      effect,
      slots: { inject, register },
      uiConversation: { events: { register: registerDefinition }, contextKey: (kind: string, id: string) => `${kind}|${id}` },
    } as never)
    expect(registerDefinition).toHaveBeenCalledWith(jobOriginDefinition)
    expect(register.mock.calls.map(([spec]) => spec.key)).toEqual(['job_output', 'job_kill'])
    const readers = register.mock.calls[0]![0].inject()
    expect(readers.jobNodeKey('bash-1')).toBe('tool-job|bash-1')
    expect(readers.callNodeKey('c-bash')).toBe('tool-call|c-bash')
  })
})
