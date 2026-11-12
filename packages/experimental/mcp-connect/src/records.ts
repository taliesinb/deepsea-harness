/**
 * `plugin:mcp-connect/server` records and the Session projection that folds
 * them into the connections a resumed Session restores.
 * @module @deepseek-ai/dsh-experimental-mcp-connect
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { appendPluginRecord, pluginRecordOf, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ServerSpec } from './spec.ts'
import type { McpConnectRecord } from './types.ts'

/** Record type owned by this package. */
export const RECORD_TYPE = 'plugin:mcp-connect/server'

/**
 * Append one record to a Session.
 * @param session - Session whose log receives the record.
 * @param record - connection or disconnection.
 */
export function appendRecord(session: Session, record: McpConnectRecord): void {
  appendPluginRecord(session, RECORD_TYPE, record)
}

/**
 * Hash a declaration so a later read of its file can be compared with the approved one.
 * @param spec - validated declaration.
 * @returns hex SHA-256 of its JSON with sorted keys.
 */
export function hashSpec(spec: ServerSpec): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
  }
  return createHash('sha256').update(JSON.stringify(canonical(spec))).digest('hex')
}

const strings = z.record(z.string(), z.string())
const timeout = z.number().int().positive().optional()
const specSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()), env: strings,
    cwd: z.string().optional(), toolCallTimeoutMs: timeout,
  }).strict(),
  z.object({ transport: z.literal('streamable-http'), url: z.string().min(1), headers: strings, toolCallTimeoutMs: timeout }).strict(),
])
const connectBase = { op: z.literal('connect'), name: z.string().min(1), serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), baseDirectory: z.string().min(1) }
const connectSchema = z.discriminatedUnion('origin', [
  z.object({ ...connectBase, origin: z.literal('inline'), spec: specSchema }).strict(),
  z.object({ ...connectBase, origin: z.literal('project'), source: z.string().min(1), specHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
])
const recordSchema = z.union([
  connectSchema,
  z.object({ op: z.literal('disconnect'), serverName: z.string().min(1) }).strict(),
])

const stateSchema = z.object({
  /** Fork-inherited prefix length; a fork starts without its parent's connections. */
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  /** Connection records still in effect, by public server name, in connection order. */
  connections: z.record(z.string(), connectSchema),
})

/** Connections a Session's own records leave in effect. */
export type McpConnectState = z.infer<typeof stateSchema>

/** Host-only fold of `plugin:mcp-connect/server` records. */
export const mcpConnectProjection: ProjectionDefinition<'mcpConnect', McpConnectState> = {
  key: 'mcpConnect',
  stateVersion: 1,
  stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, connections: {} }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    const plugin = pluginRecordOf(event)
    if (plugin?.type !== RECORD_TYPE) return state
    // A malformed or newer record is skipped; throwing would fail every later read of this Session.
    const parsed = recordSchema.safeParse(plugin.data)
    if (!parsed.success) return state
    const record = parsed.data
    const { [record.serverName]: _previous, ...rest } = state.connections
    return { ...state, connections: record.op === 'connect' ? { ...rest, [record.serverName]: record } : rest }
  },
}
