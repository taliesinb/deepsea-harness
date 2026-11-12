/**
 * MCP server declarations as the model or a project `.mcp.json` states them,
 * and their resolution into `@deepseek-ai/dsh-mcp-client` configuration.
 * @module @deepseek-ai/dsh-experimental-mcp-connect
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Valid public `serverName` accepted by `@deepseek-ai/dsh-mcp-client`. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** `${NAME}` or `${NAME:-default}` reference to a host environment variable. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * One unexpanded server declaration. Strings may hold `${NAME}` references,
 * which are resolved from the host environment at each mount; the
 * declaration itself is what the session log records.
 */
export type ServerSpec = StdioSpec | HttpSpec

/** A server started as a child process speaking MCP over stdio. */
export interface StdioSpec {
  readonly transport: 'stdio'
  /** Absolute path, or a name looked up on the child's `PATH`. */
  readonly command: string
  readonly args: readonly string[]
  /** Variables set over the scrubbed host environment. */
  readonly env: Readonly<Record<string, string>>
  /** Child working directory; relative values resolve against the declaring directory. */
  readonly cwd?: string
  readonly toolCallTimeoutMs?: number
}

/** A server reached over MCP Streamable HTTP. */
export interface HttpSpec {
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
}

/** A declaration that is invalid or unsupported, kept so listing can explain it. */
export interface InvalidSpec {
  readonly transport: 'invalid'
  readonly error: string
}

/** Caller-correctable declaration or resolution failure. */
export class McpSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpSpecError'
  }
}

/**
 * Map a human-chosen server name to a public `serverName`. Valid names stay
 * unchanged; others become a slug plus a stable hash suffix.
 * @param name - name from the model or a `.mcp.json` key.
 * @returns a name matching `[A-Za-z0-9_-]{1,32}`.
 * @throws McpSpecError for an empty name or one with control characters.
 */
export function publicServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new McpSpecError('server name must be non-empty and contain no control characters')
  }
  if (SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'server'
  return `${slug}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`.slice(0, 32)
}

/**
 * Copy a JSON object of strings into a fresh plain record. Tool arguments
 * arrive deep-frozen with a null prototype, which Schemastery dictionaries reject.
 * @param value - candidate record.
 * @param field - field name for diagnostics.
 * @param kind - whether keys are environment names or HTTP header names.
 * @returns a plain record.
 * @throws McpSpecError when the value is not a record of valid string entries.
 */
export function stringRecord(value: unknown, field: string, kind: 'environment' | 'header'): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpSpecError(`${field} must be an object of strings`)
  const result: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new McpSpecError(`${field}.${key} must be a string`)
    if (kind === 'environment') {
      if (key.length === 0 || key.includes('=') || key.includes('\0') || entry.includes('\0')) {
        throw new McpSpecError(`${field} contains an invalid environment entry: ${JSON.stringify(key)}`)
      }
    } else {
      try {
        validateHeaderName(key)
      } catch (_invalidName) {
        throw new McpSpecError(`${field} contains an invalid header name: ${JSON.stringify(key)}`)
      }
    }
    const identity = kind === 'header' ? key.toLowerCase() : key
    if (seen.has(identity)) throw new McpSpecError(`${field} contains duplicate name: ${key}`)
    seen.add(identity)
    Object.defineProperty(result, key, { value: entry, enumerable: true, writable: true, configurable: true })
  }
  return result
}

/** Read an optional positive integer timeout. */
function timeoutOf(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new McpSpecError(`${field} must be a positive integer number of milliseconds`)
  }
  return value
}

/** Read an optional array of strings. */
function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new McpSpecError(`${field} must be an array of strings`)
  }
  return [...value as string[]]
}

/**
 * Validate one declaration in the `.mcp.json` server format used by Claude
 * Code and Cursor: `{ command, args?, env?, cwd? }` with optional
 * `type: "stdio"`, or `{ type: "http", url, headers? }`. The model-facing
 * inline form uses the same fields with `transport` in place of `type`.
 * @param input - one parsed server entry.
 * @param field - location for diagnostics.
 * @returns the validated declaration.
 * @throws McpSpecError for missing fields or an unsupported transport.
 */
export function parseServerSpec(input: unknown, field: string): ServerSpec {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new McpSpecError(`${field} must be an object`)
  const entry = input as Record<string, unknown>
  const declared = entry.transport ?? entry.type
  const toolCallTimeoutMs = timeoutOf(entry.toolCallTimeoutMs, `${field}.toolCallTimeoutMs`)
  const timeout = toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }
  switch (declared) {
    case undefined:
    case 'stdio': {
      if (typeof entry.command !== 'string' || entry.command.length === 0) {
        throw new McpSpecError(`${field}.command is required for a stdio server`)
      }
      if (entry.cwd !== undefined && typeof entry.cwd !== 'string') throw new McpSpecError(`${field}.cwd must be a string`)
      return {
        transport: 'stdio',
        command: entry.command,
        args: stringArray(entry.args, `${field}.args`),
        env: stringRecord(entry.env, `${field}.env`, 'environment'),
        ...typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {},
        ...timeout,
      }
    }
    case 'http':
    case 'streamable-http': {
      if (typeof entry.url !== 'string' || entry.url.length === 0) throw new McpSpecError(`${field}.url is required for an HTTP server`)
      return { transport: 'streamable-http', url: entry.url, headers: stringRecord(entry.headers, `${field}.headers`, 'header'), ...timeout }
    }
    case 'sse':
      throw new McpSpecError(`${field} uses the deprecated SSE transport, which is not supported; use a Streamable HTTP URL`)
    default:
      throw new McpSpecError(`${field} has unsupported transport ${JSON.stringify(declared)}`)
  }
}

/**
 * Replace `${NAME}` and `${NAME:-default}` references with host environment values.
 * @param value - text that may hold references.
 * @param env - host environment.
 * @param missing - receives each referenced name that is unset and has no default.
 * @returns the expanded text.
 */
export function expandReferences(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(REFERENCE, (_match, name: string, fallback: string | undefined) => {
    const found = env[name]
    if (found !== undefined && found !== '') return found
    if (fallback !== undefined) return fallback
    missing.add(name)
    return ''
  })
}

/** Expand every value of a record. */
function expandRecord(record: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv, missing: Set<string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) result[key] = expandReferences(value, env, missing)
  return result
}

/**
 * Find an executable the way the child's `PATH` would.
 * @param command - absolute path, path relative to `cwd`, or bare name.
 * @param cwd - directory relative paths resolve against.
 * @param path - the child's `PATH`.
 * @returns the absolute executable path.
 * @throws McpSpecError when no executable file is found.
 */
export function resolveCommand(command: string, cwd: string, path: string | undefined): string {
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch (_notExecutable) {
      return false
    }
  }
  if (isAbsolute(command) || command.includes('/')) {
    const candidate = resolve(cwd, command)
    if (executable(candidate)) return candidate
    throw new McpSpecError(`command ${JSON.stringify(command)} is not an executable file`)
  }
  const directories = (path ?? '').split(delimiter).filter(directory => directory.length > 0)
  for (const directory of directories) {
    const candidate = join(directory, command)
    if (executable(candidate)) return candidate
  }
  throw new McpSpecError(`command ${JSON.stringify(command)} was not found in the ${directories.length} PATH directories; give its absolute path, or set env.PATH`)
}

/** Inputs for {@link resolveClientConfig}. */
export interface ResolveOptions {
  /** Directory a relative `cwd` or command resolves against; the default child `cwd`. */
  readonly baseDirectory: string
  /** Host environment for `${NAME}` references. */
  readonly hostEnv: NodeJS.ProcessEnv
}

/**
 * Expand a declaration and validate it as `@deepseek-ai/dsh-mcp-client` config.
 * Startup failures are fatal so a failed connection never registers tools.
 * @param serverName - public server name.
 * @param spec - unexpanded declaration.
 * @param options - base directory and host environment.
 * @returns validated client config, with secrets expanded; never log it.
 * @throws McpSpecError when a reference is unset, the command is missing, or validation fails.
 */
export function resolveClientConfig(serverName: string, spec: ServerSpec, options: ResolveOptions): McpClient.Config {
  const missing = new Set<string>()
  let input: Parameters<typeof McpClient.Config>[0]
  const timeout = spec.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: spec.toolCallTimeoutMs }
  switch (spec.transport) {
    case 'stdio': {
      const env = expandRecord(spec.env, options.hostEnv, missing)
      const cwd = resolve(options.baseDirectory, expandReferences(spec.cwd ?? '.', options.hostEnv, missing))
      const command = expandReferences(spec.command, options.hostEnv, missing)
      const args = spec.args.map(arg => expandReferences(arg, options.hostEnv, missing))
      if (missing.size > 0) break
      const childPath = env.PATH ?? scrubbedParentEnv().PATH
      input = {
        transport: 'stdio', serverName, command: resolveCommand(command, cwd, childPath), args, env, cwd,
        failOnStartupError: true, ...timeout,
      }
      break
    }
    case 'streamable-http': {
      const url = expandReferences(spec.url, options.hostEnv, missing)
      const headers = expandRecord(spec.headers, options.hostEnv, missing)
      if (missing.size > 0) break
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
      } catch (_invalidUrl) {
        throw new McpSpecError(`url ${JSON.stringify(spec.url)} must be an absolute http or https URL`)
      }
      for (const [name, value] of Object.entries(headers)) {
        try {
          validateHeaderValue(name, value)
        } catch (_invalidValue) {
          throw new McpSpecError(`header ${name} has an invalid value after expansion`)
        }
      }
      input = { transport: 'streamable-http', serverName, url, headers, failOnStartupError: true, ...timeout }
      break
    }
  }
  if (missing.size > 0) {
    throw new McpSpecError(`unset environment variables referenced without a default: ${[...missing].sort().join(', ')}`)
  }
  try {
    return McpClient.Config(input)
  } catch (error: unknown) {
    throw new McpSpecError(`invalid server configuration: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Describe a declaration for the user: the command line or URL, the
 * directory, and environment or header names. Values stay hidden because
 * they may hold secrets; `${NAME}` references are shown as written.
 * @param spec - unexpanded declaration.
 * @param config - resolved config, for the absolute command and directory.
 * @returns one line per fact.
 */
export function describeSpec(spec: ServerSpec, config: McpClient.Config): string[] {
  switch (config.transport) {
    case 'stdio': {
      const stdio = spec as StdioSpec
      const lines = [`command: ${[config.command, ...stdio.args].map(part => JSON.stringify(part)).join(' ')}`, `cwd: ${config.cwd}`]
      const keys = Object.keys(stdio.env)
      if (keys.length > 0) lines.push(`env: ${keys.map(key => /\$\{/.test(stdio.env[key] ?? '') ? `${key}=${stdio.env[key]}` : `${key}=…`).join(', ')}`)
      return lines
    }
    case 'streamable-http': {
      const keys = Object.keys((spec as HttpSpec).headers)
      return [`url: ${(spec as HttpSpec).url}`, ...keys.length > 0 ? [`headers: ${keys.join(', ')}`] : []]
    }
  }
}
