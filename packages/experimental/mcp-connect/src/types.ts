/**
 * Session record types for MCP servers connected by `mcp_connect`.
 * @module @deepseek-ai/dsh-experimental-mcp-connect
 */

import type { ServerSpec } from './spec.ts'

/** Fields shared by every connection record. */
interface ConnectRecordBase {
  readonly op: 'connect'
  /** Name the model or project file used. */
  readonly name: string
  /** Public server name in the `mcp__<serverName>__` tool prefix. */
  readonly serverName: string
  /** Directory relative paths resolved against at connection time. */
  readonly baseDirectory: string
}

/** A server the model declared inline; the arguments it passed are already in the log. */
export interface InlineConnectRecord extends ConnectRecordBase {
  readonly origin: 'inline'
  readonly spec: ServerSpec
}

/**
 * A server declared in a project `.mcp.json`. Its declaration is not copied
 * into the log because the file may hold literal secrets; resume reads the
 * file again and reconnects only when the declaration hash still matches.
 */
export interface ProjectConnectRecord extends ConnectRecordBase {
  readonly origin: 'project'
  /** Absolute path of the declaring `.mcp.json`. */
  readonly source: string
  /** SHA-256 of the approved declaration's canonical JSON. */
  readonly specHash: string
}

/** A disconnection by `mcp_disconnect`. */
export interface DisconnectRecord {
  readonly op: 'disconnect'
  readonly serverName: string
}

/** One `plugin:mcp-connect/server` record. */
export type McpConnectRecord = InlineConnectRecord | ProjectConnectRecord | DisconnectRecord

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Connections and disconnections of session-scoped MCP servers, replayed on resume. */
    'plugin:mcp-connect/server': McpConnectRecord
  }
}
