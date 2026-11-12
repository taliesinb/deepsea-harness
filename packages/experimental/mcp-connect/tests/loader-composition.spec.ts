/** The bundle's plugin booted through the real Loader, connecting a server a project file declares. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import McpResourceRuntime from '@deepseek-ai/dsh-mcp-resources'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import * as McpConnect from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const server = fileURLToPath(new URL('./fixtures/server.ts', import.meta.url))
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('mcp-connect through real Loader composition', () => {
  it('connects a declared server after approval and unregisters its tools on disposal', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-connect-loader-')))
    const project = join(root, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'lean-lsp': { command: process.execPath, args: [server] } } }))

    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
      ['@deepseek-ai/dsh-user-approval', ApprovalService],
      ['@deepseek-ai/dsh-mcp-resources', McpResourceRuntime],
      ['@deepseek-ai/dsh-experimental-mcp-connect', McpConnect],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ])
    const config = [...modules.keys()].flatMap(name => [
      `- name: 'cordis:${name}'`,
      ...name === '@deepseek-ai/dsh-agent-loop' ? ['  config:', '    agents: []'] : [],
    ]).join('\n') + '\n'
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, config)
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp_connect', { name: 'lean-lsp' }),
      toolCallResponse('c2', 'mcp__lean-lsp__add', { a: 20, b: 22 }),
      textResponse('done'),
    ])
    context.llm.registerAdapter(['mock'], adapter)
    const reasons: string[] = []
    context.on('approval/request', async (request) => {
      reasons.push(request.reason ?? '')
      return 'allowed-once'
    })
    const agent = await context.agentLoop.create(SessionId('loader'), { provider: 'mock', model: 'model' }, { cwd: project })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use lean' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(`declared in ${join(project, '.mcp.json')}`)
    const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result'
      ? [event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')]
      : [])
    expect(results).toEqual([
      JSON.stringify({ serverName: 'lean-lsp', tools: ['mcp__lean-lsp__add', 'mcp__lean-lsp__echo', 'mcp__lean-lsp__pid'] }),
      '42',
    ])

    const entry = [...context.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-mcp-connect')
    await entry!.fiber!.dispose()
    const remaining = context.tools.definitions(agent).map(tool => tool.name)
    expect(remaining.filter(name => name.startsWith('mcp_') || name.startsWith('mcp__'))).toEqual([])
  }, 30_000)
})
