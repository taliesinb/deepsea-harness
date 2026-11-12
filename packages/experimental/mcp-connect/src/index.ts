/**
 * Model tools that connect MCP servers to the calling Agent only:
 * `mcp_connect`, `mcp_disconnect`, and `mcp_list`. Each connection mounts one
 * `@deepseek-ai/dsh-mcp-client` instance in the Agent's scope after the user
 * approves it, is recorded in the Session, and is restored on resume.
 * @module @deepseek-ai/dsh-experimental-mcp-connect
 */

import { dirname } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { readProjectDeclarations, searchDirectories, type DeclaredServer } from './project.ts'
import { appendRecord, hashSpec, mcpConnectProjection } from './records.ts'
import {
  McpSpecError, describeSpec, parseServerSpec, publicServerName, resolveClientConfig, type ServerSpec,
} from './spec.ts'
import type { InlineConnectRecord, ProjectConnectRecord } from './types.ts'

export type { McpConnectRecord } from './types.ts'
export type { ServerSpec } from './spec.ts'

/** Cordis plugin name. */
export const name = 'mcp-connect'

/** Services required to register the tools and resolve session directories. */
export const inject = ['tools', 'agents', 'workingDirectory', 'sessionProjections']

/** Deployment settings. */
export interface Config {
  /** Longest wait for a server to start and list its tools, in milliseconds. */
  startupTimeoutMs: number
  /** Offer servers declared in project `.mcp.json` files to `mcp_connect` and `mcp_list`. */
  projectFiles: boolean
}

export const Config: z<Partial<Config>, Config> = z.object({
  startupTimeoutMs: z.number().step(1).min(1).default(120_000)
    .description('Longest wait for a server to start and list its tools, in milliseconds.'),
  projectFiles: z.boolean().default(true)
    .description('Offer servers declared in project .mcp.json files by name.'),
})

/** One server connected in one Agent. */
interface Connection {
  readonly name: string
  readonly serverName: string
  readonly origin: 'inline' | 'project'
  readonly source?: string
  readonly transport: ServerSpec['transport']
  /** Present while connected. */
  fiber?: Fiber
  status: 'connected' | 'failed'
  error?: string
}

/** Model-correctable refusal or failure. */
class McpConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpConnectError'
  }
}

const TOOL_PREFIX = /^mcp__([A-Za-z0-9_-]{1,32})__/

/**
 * Register the tools and restore recorded connections into resumed Agents
 * and into Agents already live when this plugin loads.
 * @param ctx - plugin context.
 * @param config - deployment settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const projection = await ctx.sessionProjections.register(mcpConnectProjection)
  const live = new Map<Agent, Map<string, Connection>>()
  const connectionsOf = (agent: Agent): Map<string, Connection> => {
    let connections = live.get(agent)
    if (connections === undefined) {
      connections = new Map()
      live.set(agent, connections)
    }
    return connections
  }

  // Fibers belong to each Agent's scope, not to this plugin: unloading this
  // plugin must close them itself, or HMR would leave unmanaged servers.
  ctx.effect(() => async () => {
    const fibers = [...live.values()].flatMap(connections => [...connections.values()].flatMap(c => c.fiber ?? []))
    live.clear()
    await Promise.allSettled(fibers.map(fiber => fiber.dispose()))
  }, 'mcp-connect.connections')
  ctx.on('agent/disposed', ({ agent }) => { live.delete(agent) })

  /** Tool names a server contributes to one Agent. */
  const toolsOf = (agent: Agent, serverName: string): string[] =>
    ctx.tools.definitions(agent).map(tool => tool.name).filter(tool => tool.startsWith(`mcp__${serverName}__`)).sort()

  /**
   * Mount one client in an Agent's scope and wait for its first tool list.
   * Cancellation and the startup timeout dispose the client, which stops its process.
   */
  async function mount(agent: Agent, clientConfig: McpClient.Config, signal?: AbortSignal): Promise<Fiber> {
    const fiber = agent.ctx.plugin(McpClient, clientConfig)
    const timeout = AbortSignal.timeout(config.startupTimeoutMs)
    const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const onStop = (): void => { void fiber.dispose() }
    stop.addEventListener('abort', onStop, { once: true })
    try {
      await fiber
    } catch (error: unknown) {
      void fiber.dispose()
      if (signal?.aborted === true) throw signal.reason
      if (timeout.aborted) {
        throw new McpConnectError(`server "${clientConfig.serverName}" did not finish startup within ${config.startupTimeoutMs} ms`)
      }
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      throw new McpConnectError(`server "${clientConfig.serverName}" failed to start or list its tools${cause}`)
    } finally {
      stop.removeEventListener('abort', onStop)
    }
    if (stop.aborted) {
      await fiber.dispose()
      if (signal?.aborted === true) throw signal.reason
      throw new McpConnectError(`server "${clientConfig.serverName}" did not finish startup within ${config.startupTimeoutMs} ms`)
    }
    return fiber
  }

  /** Project declarations visible from an Agent's working directory. */
  async function declarationsFor(agent: Agent) {
    const directories = searchDirectories(ctx.workingDirectory.get(agent.session))
    return { directories, ...await readProjectDeclarations(directories) }
  }

  /** Reconnect the servers a Session's records leave connected. */
  async function restore(agent: Agent): Promise<void> {
    const records = Object.values(projection.stateOf(agent.session).connections)
    if (records.length === 0) return
    const connections = connectionsOf(agent)
    const files = new Map<string, Awaited<ReturnType<typeof readProjectDeclarations>>>()
    for (const record of records) {
      if (connections.get(record.serverName)?.status === 'connected') continue
      const connection: Connection = {
        name: record.name, serverName: record.serverName, origin: record.origin, transport: 'stdio', status: 'failed',
        ...record.origin === 'project' ? { source: record.source } : {},
      }
      connections.set(record.serverName, connection)
      try {
        let spec: ServerSpec
        if (record.origin === 'inline') {
          spec = parseServerSpec(record.spec, 'record')
        } else {
          let declarations = files.get(record.source)
          if (declarations === undefined) {
            declarations = await readProjectDeclarations([dirname(record.source)])
            files.set(record.source, declarations)
          }
          const declared = declarations.servers.get(record.name)
          if (declared === undefined || declared.source !== record.source || declared.spec.transport === 'invalid') {
            throw new McpConnectError(`"${record.name}" is no longer declared in ${record.source}; call mcp_connect again`)
          }
          if (hashSpec(declared.spec) !== record.specHash) {
            throw new McpConnectError(`"${record.name}" changed in ${record.source} since it was approved; call mcp_connect again`)
          }
          spec = declared.spec
        }
        Object.assign(connection, { transport: spec.transport })
        const clientConfig = resolveClientConfig(record.serverName, spec, { baseDirectory: record.baseDirectory, hostEnv: process.env })
        connection.fiber = await mount(agent, clientConfig)
        connection.status = 'connected'
      } catch (error: unknown) {
        connection.error = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`mcp-connect: could not restore "${record.serverName}" in ${agent.id}: ${connection.error}`)
      }
    }
  }

  // A failed restore is reported through mcp_list and never rejects: the
  // creation listener is awaited, and a rejection would make resume fail.
  ctx.on('agent/created', async ({ agent, source }) => {
    if (source === 'resume') await restore(agent)
  })
  for (const agent of ctx.agents.list()) await restore(agent)

  ctx.tools.register(defineTool({
    name: 'mcp_connect',
    description: 'Connect an MCP server to this session only. Give just name to use a server declared in the project .mcp.json (see mcp_list), or define one with command (stdio) or url (Streamable HTTP). The user must approve every connection. The server runs as the user, outside the sandbox. Its tools, named `mcp__<server>__<tool>`, are callable from your next step and stay until mcp_disconnect or the end of the session; resuming the session reconnects it. Strings may reference host environment variables as ${NAME} or ${NAME:-default}.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name: a .mcp.json entry, or a new name when command or url is given.' },
      command: { type: 'string', description: 'stdio: executable, absolute or found on PATH.' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio: arguments, passed without a shell.' },
      env: { type: 'object', additionalProperties: true, description: 'stdio: environment variables (string values) set over the host environment.' },
      cwd: { type: 'string', description: 'stdio: working directory; relative to the session working directory, which is the default.' },
      url: { type: 'string', description: 'Streamable HTTP: endpoint URL.' },
      headers: { type: 'object', additionalProperties: true, description: 'Streamable HTTP: request headers (string values).' },
      toolCallTimeoutMs: { type: 'integer', description: 'Timeout for each call to one of the server\'s tools, in milliseconds.' },
      reason: { type: 'string', description: 'Why the task needs this server, shown to the user with the approval request.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new McpConnectError('mcp_connect requires a calling agent')
      const serverName = publicServerName(args.name)
      const connections = connectionsOf(agent)
      if (connections.get(serverName)?.status === 'connected') {
        throw new McpConnectError(`"${args.name}" is already connected in this session; call mcp_disconnect first to reconnect it`)
      }
      const inline = args.command !== undefined || args.url !== undefined
      let spec: ServerSpec
      let baseDirectory: string
      let declared: DeclaredServer | undefined
      if (inline) {
        spec = parseServerSpec({
          transport: args.url !== undefined ? 'streamable-http' : 'stdio',
          command: args.command, args: args.args, env: args.env, cwd: args.cwd,
          url: args.url, headers: args.headers, toolCallTimeoutMs: args.toolCallTimeoutMs,
        }, 'arguments')
        baseDirectory = ctx.workingDirectory.get(agent.session)
      } else {
        if (!config.projectFiles) throw new McpConnectError('project .mcp.json files are disabled; pass command or url')
        const declarations = await declarationsFor(agent)
        declared = declarations.servers.get(args.name)
        if (declared === undefined) {
          throw new McpConnectError(`no server named "${args.name}" is declared in .mcp.json (searched ${declarations.directories.join(', ')}); call mcp_list, or pass command or url`)
        }
        if (declared.spec.transport === 'invalid') throw new McpConnectError(`${declared.source}: ${declared.spec.error}`)
        spec = declared.spec
        baseDirectory = dirname(declared.source)
      }
      const clientConfig = resolveClientConfig(serverName, spec, { baseDirectory, hostEnv: process.env })

      const approval = ctx.get('approval')
      if (approval === undefined) throw new McpConnectError('connecting an MCP server needs user approval, but this session has no approval service')
      const facts = [
        `MCP server "${args.name}"${serverName === args.name ? '' : ` (tools prefixed mcp__${serverName}__)`}`,
        ...declared === undefined ? [] : [`declared in ${declared.source}`],
        ...describeSpec(spec, clientConfig),
        ...args.reason === undefined ? [] : [`reason: ${args.reason}`],
      ]
      const question = `Connect ${facts.join('\n')}\nIt runs as you, outside the sandbox, for this session.`
      const outcome = await approval.request({
        agent, toolName: 'mcp_connect', callId: exec.callId, reason: question, displayReason: { en: question }, signal: exec.signal,
      })
      if (outcome !== 'allowed-once') throw new McpConnectError(`the user did not approve connecting "${args.name}" (${outcome})`)

      const shadowed = ctx.tools.definitions().some(tool => tool.name.startsWith(`mcp__${serverName}__`))
      const fiber = await mount(agent, clientConfig, exec.signal)
      const connection: Connection = {
        name: args.name, serverName, origin: inline ? 'inline' : 'project', transport: spec.transport, fiber, status: 'connected',
        ...declared === undefined ? {} : { source: declared.source },
      }
      connections.set(serverName, connection)
      const base = { op: 'connect', name: args.name, serverName, baseDirectory } as const
      appendRecord(agent.session, declared === undefined
        ? { ...base, origin: 'inline', spec } satisfies InlineConnectRecord
        : { ...base, origin: 'project', source: declared.source, specHash: hashSpec(spec) } satisfies ProjectConnectRecord)
      return JSON.stringify({
        serverName,
        tools: toolsOf(agent, serverName),
        ...shadowed ? { note: `This session's "${serverName}" hides the profile's server of the same name.` } : {},
      })
    },
    presentCall: args => ({ card: 'generic', title: `Connect MCP server ${args.name}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'mcp_disconnect',
    description: 'Disconnect an MCP server that mcp_connect connected in this session and stop it. Its tools are gone from your next step.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name passed to mcp_connect.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new McpConnectError('mcp_disconnect requires a calling agent')
      const connections = connectionsOf(agent)
      const serverName = publicServerName(args.name)
      const connection = connections.get(serverName)
      if (connection === undefined) {
        throw new McpConnectError(`"${args.name}" is not connected by mcp_connect in this session; servers from the profile cannot be disconnected here`)
      }
      const removed = toolsOf(agent, serverName)
      connections.delete(serverName)
      await connection.fiber?.dispose()
      appendRecord(agent.session, { op: 'disconnect', serverName })
      return JSON.stringify({ serverName, removed })
    },
    presentCall: args => ({ card: 'generic', title: `Disconnect MCP server ${args.name}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'mcp_list',
    description: 'List MCP servers: those connected in this session, those the profile provides, and those declared in project .mcp.json files, which mcp_connect accepts by name.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new McpConnectError('mcp_list requires a calling agent')
      const connections = live.get(agent) ?? new Map<string, Connection>()
      const session = [...connections.values()].map(connection => ({
        name: connection.name,
        serverName: connection.serverName,
        origin: connection.origin,
        ...connection.source === undefined ? {} : { source: connection.source },
        status: connection.status,
        ...connection.status === 'connected' ? { tools: toolsOf(agent, connection.serverName) } : { error: connection.error },
      }))
      const profileTools = new Map<string, number>()
      for (const tool of ctx.tools.definitions(agent)) {
        const server = TOOL_PREFIX.exec(tool.name)?.[1]
        if (server !== undefined && !connections.has(server)) profileTools.set(server, (profileTools.get(server) ?? 0) + 1)
      }
      const profile = [...profileTools].sort(([a], [b]) => a.localeCompare(b)).map(([serverName, tools]) => ({ serverName, tools }))
      let project: unknown[] = []
      let projectErrors: unknown[] = []
      if (config.projectFiles) {
        const declarations = await declarationsFor(agent)
        project = [...declarations.servers.values()].map((declared) => {
          const { name: declaredName, source, spec } = declared
          if (spec.transport === 'invalid') return { name: declaredName, source, error: spec.error }
          const target = spec.transport === 'stdio' ? { command: [spec.command, ...spec.args].join(' ') } : { url: spec.url }
          const connected = connections.get(publicServerName(declaredName))?.status === 'connected'
          return { name: declaredName, source, transport: spec.transport, ...target, connected }
        })
        projectErrors = [...declarations.errors]
      }
      return JSON.stringify({ session, profile, project, ...projectErrors.length > 0 ? { projectErrors } : {} })
    },
    presentCall: () => ({ card: 'generic', title: 'List MCP servers', kind: 'read', rawInput: {} }),
  }))
}

export { McpSpecError }
