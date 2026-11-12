/** mcp_connect, mcp_disconnect, and mcp_list against a real stdio MCP server and a production AgentLoop. */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import McpResourceRuntime from '@deepseek-ai/dsh-mcp-resources'
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import * as McpConnect from '@deepseek-ai/dsh-experimental-mcp-connect'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const server = fileURLToPath(new URL('./fixtures/server.ts', import.meta.url))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-connect-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface HarnessOptions {
  readonly decision?: ApprovalOutcome
  readonly policy?: 'ask' | 'never'
  readonly persistenceRoot?: string
  readonly config?: Partial<McpConnect.Config>
}

async function harness(adapter: MockAdapter, options: HarnessOptions = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  await ctx.plugin(McpResourceRuntime)
  await ctx.plugin(ApprovalService, { policy: options.policy ?? 'ask' })
  if (options.persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: options.persistenceRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const asked: ApprovalRequestEvent[] = []
  ctx.on('approval/request', async (request) => {
    asked.push(request)
    return options.decision ?? 'allowed-once'
  })
  const plugin: Fiber = ctx.plugin(McpConnect, options.config ?? {})
  return { ctx, asked, plugin }
}

const agentOptions = { provider: 'mock', model: 'model' }

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Text of each tool result, by call id. */
function results(agent: Agent): Map<string, { text: string; isError: boolean }> {
  const map = new Map<string, { text: string; isError: boolean }>()
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'tool/result') continue
    const message = event.data.message
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    map.set(message.toolCallId, { text, isError: message.isError === true })
  }
  return map
}

const names = (request: GenerateOptions | undefined): string[] => request?.tools?.map(tool => tool.name) ?? []
const records = (agent: Agent) => agent.session.snapshotEvents().flatMap((event) => {
  const record = pluginRecordOf(event)
  return record?.type === 'plugin:mcp-connect/server' ? [record.data as McpConnect.McpConnectRecord] : []
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (_gone) {
    return false
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20))
}

const inline = { name: 'fx', command: process.execPath, args: [server] }

describe('mcp_connect inline', () => {
  it('asks the user, mounts the server for this Agent only, and records the declaration', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_connect', { ...inline, env: { FIXTURE_ECHO: '${MCP_CONNECT_TEST_UNSET:-fallback}' }, reason: 'testing' }),
      toolCallResponse('c2', 'mcp__fx__add', { a: 1, b: 2 }),
      toolCallResponse('c3', 'mcp__fx__echo', {}),
      textResponse('done'),
      textResponse('other'),
    ])
    const { ctx, asked } = await harness(adapter)
    const cwd = await tempDir()
    const agent = await ctx.agentLoop.create(SessionId('inline'), agentOptions, { cwd })
    const other = await ctx.agentLoop.create(SessionId('other'), agentOptions, { cwd })
    await send(agent, 'connect')

    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe('mcp_connect')
    expect(asked[0]?.reason).toContain(JSON.stringify(process.execPath))
    expect(asked[0]?.reason).toContain('FIXTURE_ECHO=${MCP_CONNECT_TEST_UNSET:-fallback}')
    expect(asked[0]?.reason).toContain('reason: testing')
    const byCall = results(agent)
    expect(JSON.parse(byCall.get('c1')!.text)).toEqual({ serverName: 'fx', tools: ['mcp__fx__add', 'mcp__fx__echo', 'mcp__fx__pid'] })
    expect(byCall.get('c2')?.text).toBe('3')
    expect(byCall.get('c3')?.text).toBe('fallback')
    expect(names(adapter.requests[0])).not.toContain('mcp__fx__add')
    expect(names(adapter.requests[1])).toContain('mcp__fx__add')
    expect(records(agent)).toEqual([{
      op: 'connect', name: 'fx', serverName: 'fx', baseDirectory: cwd, origin: 'inline',
      spec: { transport: 'stdio', command: process.execPath, args: [server], env: { FIXTURE_ECHO: '${MCP_CONNECT_TEST_UNSET:-fallback}' } },
    }])

    await send(other, 'hello')
    expect(names(adapter.requests.at(-1)).filter(name => name.startsWith('mcp__'))).toEqual([])
  }, 30_000)

  it.each([
    ['a rejected request', { decision: 'rejected' as const }],
    ['the never policy', { policy: 'never' as const }],
  ])('does not start the server after %s', async (_label, options) => {
    const pidFile = join(await tempDir(), 'pid')
    const adapter = new MockAdapter([toolCallResponse('c1', 'mcp_connect', { ...inline, env: { FIXTURE_PID_FILE: pidFile } }), textResponse('ok')])
    const { ctx } = await harness(adapter, options)
    const agent = await ctx.agentLoop.create(SessionId('rejected'), agentOptions, { cwd: await tempDir() })
    await send(agent, 'connect')
    const result = results(agent).get('c1')
    expect(result?.isError).toBe(true)
    expect(result?.text).toContain('the user did not approve connecting "fx" (rejected)')
    expect(existsSync(pidFile)).toBe(false)
    expect(records(agent)).toEqual([])
  }, 30_000)

  it('reports a missing command before asking the user', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'mcp_connect', { name: 'fx', command: 'mcp-connect-no-such-command' }), textResponse('ok')])
    const { ctx, asked } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('missing'), agentOptions, { cwd: await tempDir() })
    await send(agent, 'connect')
    expect(results(agent).get('c1')?.text).toContain('"mcp-connect-no-such-command" was not found in the ')
    expect(asked).toEqual([])
  }, 30_000)

  it('reports a server that fails to start and keeps the name free', async () => {
    const bad = join(await tempDir(), 'bad.mjs')
    await writeFile(bad, 'process.exit(3)\n')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_connect', { name: 'fx', command: process.execPath, args: [bad] }),
      toolCallResponse('c2', 'mcp_connect', inline),
      textResponse('ok'),
    ])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('failing'), agentOptions, { cwd: await tempDir() })
    await send(agent, 'connect')
    const byCall = results(agent)
    expect(byCall.get('c1')?.text).toContain('server "fx" failed to start or list its tools')
    expect(byCall.get('c2')?.isError).toBe(false)
    expect(records(agent).map(record => record.op)).toEqual(['connect'])
  }, 30_000)

  it('stops a slow startup when the turn is cancelled', async () => {
    const pidFile = join(await tempDir(), 'pid')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_connect', { ...inline, env: { FIXTURE_PID_FILE: pidFile, FIXTURE_DELAY_MS: '20000' } }),
    ])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('cancelled'), agentOptions, { cwd: await tempDir() })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await eventually(() => existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    agent.cancel({ kind: 'user' } as never)
    await agent.whenIdle()
    await eventually(() => !alive(pid))
    expect(alive(pid)).toBe(false)
    expect(records(agent)).toEqual([])
    expect(ctx.tools.definitions(agent).some(tool => tool.name.startsWith('mcp__fx__'))).toBe(false)
  }, 30_000)

  it('stops a startup that exceeds startupTimeoutMs', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_connect', { ...inline, env: { FIXTURE_DELAY_MS: '20000' } }),
      textResponse('ok'),
    ])
    const { ctx } = await harness(adapter, { config: { startupTimeoutMs: 300 } })
    const agent = await ctx.agentLoop.create(SessionId('timeout'), agentOptions, { cwd: await tempDir() })
    await send(agent, 'connect')
    expect(results(agent).get('c1')?.text).toContain('server "fx" did not finish startup within 300 ms')
  }, 30_000)
})

describe('mcp_disconnect and plugin lifecycle', () => {
  it('disconnects, stops the process, and records it', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_connect', inline),
      toolCallResponse('c2', 'mcp__fx__pid', {}),
      toolCallResponse('c3', 'mcp_disconnect', { name: 'fx' }),
      textResponse('ok'),
    ])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('disconnect'), agentOptions, { cwd: await tempDir() })
    await send(agent, 'go')
    const byCall = results(agent)
    const pid = (JSON.parse(byCall.get('c2')!.text) as { pid: number }).pid
    expect(JSON.parse(byCall.get('c3')!.text)).toEqual({ serverName: 'fx', removed: ['mcp__fx__add', 'mcp__fx__echo', 'mcp__fx__pid'] })
    await eventually(() => !alive(pid))
    expect(alive(pid)).toBe(false)
    expect(names(adapter.requests.at(-1))).not.toContain('mcp__fx__add')
    expect(records(agent).map(record => record.op)).toEqual(['connect', 'disconnect'])
  }, 30_000)

  it('stops its servers when the plugin unloads and restores them when it loads again', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'mcp_connect', inline), toolCallResponse('c2', 'mcp__fx__pid', {}), textResponse('ok')])
    const { ctx, plugin } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('reload'), agentOptions, { cwd: await tempDir() })
    await send(agent, 'go')
    const pid = (JSON.parse(results(agent).get('c2')!.text) as { pid: number }).pid
    await plugin.dispose()
    await eventually(() => !alive(pid))
    expect(alive(pid)).toBe(false)
    expect(ctx.tools.definitions(agent).some(tool => tool.name.startsWith('mcp__fx__'))).toBe(false)

    await ctx.plugin(McpConnect, {})
    expect(ctx.tools.definitions(agent).map(tool => tool.name)).toContain('mcp__fx__add')
  }, 30_000)
})

describe('project .mcp.json', () => {
  async function project(servers: unknown): Promise<{ root: string; cwd: string }> {
    const root = await tempDir()
    await mkdir(join(root, '.git'))
    const cwd = join(root, 'sub', 'dir')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
    return { root, cwd }
  }

  it('lists declared servers and connects one by name', async () => {
    const { root, cwd } = await project({
      'fx': { command: process.execPath, args: [server], env: { FIXTURE_ECHO: 'from-file' } },
      'remote': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
      'old': { type: 'sse', url: 'https://example.com/sse' },
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_list', {}),
      toolCallResponse('c2', 'mcp_connect', { name: 'fx' }),
      toolCallResponse('c3', 'mcp__fx__pid', {}),
      toolCallResponse('c4', 'mcp__fx__echo', {}),
      toolCallResponse('c5', 'mcp_list', {}),
      textResponse('ok'),
    ])
    const { ctx, asked } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('project'), agentOptions, { cwd })
    await send(agent, 'go')
    const byCall = results(agent)
    const source = join(root, '.mcp.json')
    const before = JSON.parse(byCall.get('c1')!.text) as { project: unknown[]; session: unknown[] }
    expect(before.session).toEqual([])
    expect(before.project).toEqual([
      { name: 'fx', source, transport: 'stdio', command: `${process.execPath} ${server}`, connected: false },
      { name: 'remote', source, transport: 'streamable-http', url: 'https://example.com/mcp', connected: false },
      { name: 'old', source, error: 'mcpServers.old uses the deprecated SSE transport, which is not supported; use a Streamable HTTP URL' },
    ])
    expect(asked[0]?.reason).toContain(`declared in ${source}`)
    expect(asked[0]?.reason).toContain('env: FIXTURE_ECHO=…')
    expect((JSON.parse(byCall.get('c3')!.text) as { cwd: string }).cwd).toBe(root)
    expect(byCall.get('c4')?.text).toBe('from-file')
    const after = JSON.parse(byCall.get('c5')!.text) as { project: { name: string; connected?: boolean }[]; session: unknown[] }
    expect(after.project.find(entry => entry.name === 'fx')?.connected).toBe(true)
    expect(after.session).toEqual([{
      name: 'fx', serverName: 'fx', origin: 'project', source, status: 'connected', tools: ['mcp__fx__add', 'mcp__fx__echo', 'mcp__fx__pid'],
    }])
    const [record] = records(agent)
    expect(record).toMatchObject({ origin: 'project', source, baseDirectory: root })
    expect(JSON.stringify(record)).not.toContain('from-file')
  }, 30_000)

  it('names the searched directories when a name is not declared', async () => {
    const { root, cwd } = await project({})
    const adapter = new MockAdapter([toolCallResponse('c1', 'mcp_connect', { name: 'nope' }), textResponse('ok')])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('undeclared'), agentOptions, { cwd })
    await send(agent, 'go')
    const text = results(agent).get('c1')?.text ?? ''
    expect(text).toContain('no server named "nope" is declared in .mcp.json')
    expect(text).toContain(root)
  }, 30_000)
})

describe('resume and fork', () => {
  it('reconnects recorded servers before the first resumed request', async () => {
    const root = await tempDir()
    const cwd = await tempDir()
    const id = SessionId('resumed')
    const first = await harness(new MockAdapter([toolCallResponse('c1', 'mcp_connect', inline), textResponse('ok')]), { persistenceRoot: root })
    const created = await first.ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions })
    await send(created.agent, 'connect')
    await created.dispose()
    await first.ctx.fiber.dispose()

    const adapter = new MockAdapter([toolCallResponse('c2', 'mcp__fx__add', { a: 2, b: 5 }), textResponse('done')])
    const second = await harness(adapter, { persistenceRoot: root })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: id, agentOptions })
    await send(resumed.agent, 'add')
    expect(names(adapter.requests[0])).toContain('mcp__fx__add')
    expect(results(resumed.agent).get('c2')?.text).toBe('7')
    expect(second.asked).toEqual([])
  }, 30_000)

  it('does not reconnect a project server whose declaration changed, and reports why', async () => {
    const projectRoot = await tempDir()
    await mkdir(join(projectRoot, '.git'))
    const file = join(projectRoot, '.mcp.json')
    await writeFile(file, JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [server] } } }))
    const root = await tempDir()
    const id = SessionId('changed')
    const first = await harness(new MockAdapter([toolCallResponse('c1', 'mcp_connect', { name: 'fx' }), textResponse('ok')]), { persistenceRoot: root })
    const created = await first.ctx.agents.create({ sessionId: id, meta: { cwd: projectRoot }, agentOptions })
    await send(created.agent, 'connect')
    await created.dispose()
    await first.ctx.fiber.dispose()
    await writeFile(file, JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [server, '--changed'] } } }))

    const adapter = new MockAdapter([toolCallResponse('c2', 'mcp_list', {}), textResponse('done')])
    const second = await harness(adapter, { persistenceRoot: root })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: id, agentOptions })
    await send(resumed.agent, 'list')
    expect(names(adapter.requests[0])).not.toContain('mcp__fx__add')
    const listed = JSON.parse(results(resumed.agent).get('c2')!.text) as { session: unknown[] }
    expect(listed.session).toEqual([{
      name: 'fx', serverName: 'fx', origin: 'project', source: file, status: 'failed',
      error: `"fx" changed in ${file} since it was approved; call mcp_connect again`,
    }])
  }, 30_000)

  it('ignores records a fork inherits from its parent session', async () => {
    const root = await tempDir()
    const parentId = SessionId('parent')
    const first = await harness(new MockAdapter([toolCallResponse('c1', 'mcp_connect', inline), textResponse('ok')]), { persistenceRoot: root })
    const parent = await first.ctx.agents.create({ sessionId: parentId, meta: { cwd: await tempDir() }, agentOptions })
    await send(parent.agent, 'connect')
    const seed = parent.agent.session.snapshotEvents()
    const fork = await first.ctx.agents.create({
      sessionId: SessionId('fork'), meta: { isSeeded: true, parentSession: parentId }, seed, inheritedEventCount: seed.length as never, agentOptions,
    })
    expect(records(fork.agent)).toHaveLength(1)
    expect(first.ctx.tools.definitions(fork.agent).some(tool => tool.name.startsWith('mcp__fx__'))).toBe(false)
    await fork.dispose()

    const resumed = await first.ctx.agents.resume({ resumeSessionId: SessionId('fork'), agentOptions })
    expect(first.ctx.tools.definitions(resumed.agent).some(tool => tool.name.startsWith('mcp__fx__'))).toBe(false)
    expect(first.ctx.tools.definitions(parent.agent).some(tool => tool.name.startsWith('mcp__fx__'))).toBe(true)
  }, 30_000)
})
