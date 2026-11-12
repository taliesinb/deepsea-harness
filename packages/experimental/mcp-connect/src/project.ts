/**
 * Project `.mcp.json` discovery: servers a repository declares for MCP
 * clients, offered to `mcp_connect` by name.
 * @module @deepseek-ai/dsh-experimental-mcp-connect
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { McpSpecError, parseServerSpec, type InvalidSpec, type ServerSpec } from './spec.ts'

/** File name read in each searched directory. */
export const PROJECT_FILE = '.mcp.json'

/** One server a project file declares. */
export interface DeclaredServer {
  /** Name as written in the file. */
  readonly name: string
  /** Absolute path of the declaring file. */
  readonly source: string
  readonly spec: ServerSpec | InvalidSpec
}

/** Every declaration visible from one directory, nearest file first. */
export interface ProjectDeclarations {
  /** Declarations by name; a nearer file's entry hides a farther one. */
  readonly servers: ReadonlyMap<string, DeclaredServer>
  /** Files that exist but could not be read or parsed. */
  readonly errors: readonly { readonly source: string; readonly error: string }[]
}

/**
 * Directories searched for project files: the working directory and each
 * ancestor up to and including the nearest one holding `.git`. Without a
 * `.git` ancestor only the working directory itself is searched.
 * @param workingDirectory - the session's absolute working directory.
 * @returns absolute directories, nearest first.
 */
export function searchDirectories(workingDirectory: string): string[] {
  const chain: string[] = []
  let current = workingDirectory
  let root: string | undefined
  for (;;) {
    chain.push(current)
    if (existsSync(join(current, '.git'))) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return root === undefined ? [workingDirectory] : chain
}

/**
 * Read every project file visible from a directory.
 * @param directories - directories to search, nearest first.
 * @returns the merged declarations and per-file read or parse errors.
 */
export async function readProjectDeclarations(directories: readonly string[]): Promise<ProjectDeclarations> {
  const servers = new Map<string, DeclaredServer>()
  const errors: { source: string; error: string }[] = []
  for (const directory of directories) {
    const source = join(directory, PROJECT_FILE)
    let text: string
    try {
      text = await readFile(source, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ source, error: String(error) })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      errors.push({ source, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const table = typeof parsed === 'object' && parsed !== null ? (parsed as { mcpServers?: unknown }).mcpServers : undefined
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      errors.push({ source, error: 'missing "mcpServers" object' })
      continue
    }
    for (const [name, entry] of Object.entries(table)) {
      if (servers.has(name)) continue
      let spec: ServerSpec | InvalidSpec
      try {
        spec = parseServerSpec(entry, `mcpServers.${name}`)
      } catch (error: unknown) {
        if (!(error instanceof McpSpecError)) throw error
        spec = { transport: 'invalid', error: error.message }
      }
      servers.set(name, { name, source, spec })
    }
  }
  return { servers, errors }
}
