/** Declaration parsing, reference expansion, command resolution, and project-file discovery. */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readProjectDeclarations, searchDirectories } from '../src/project.ts'
import {
  McpSpecError, describeSpec, expandReferences, parseServerSpec, publicServerName, resolveClientConfig, resolveCommand, stringRecord,
} from '../src/spec.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-connect-spec-')))
  dirs.push(dir)
  return dir
}

describe('publicServerName', () => {
  it('keeps valid names and slugs others with a stable hash', () => {
    expect(publicServerName('lean-lsp')).toBe('lean-lsp')
    const slug = publicServerName('My Server!')
    expect(slug).toMatch(/^My_Server_[0-9a-f]{8}$/)
    expect(publicServerName('My Server!')).toBe(slug)
    expect(publicServerName('???')).toMatch(/^server_[0-9a-f]{8}$/)
    expect(() => publicServerName(' ')).toThrow(McpSpecError)
    expect(() => publicServerName('a\u0001b')).toThrow('control characters')
  })
})

describe('stringRecord', () => {
  it('copies frozen null-prototype records and rejects invalid entries', () => {
    const frozen = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, { A: '1' }))
    expect(stringRecord(frozen, 'env', 'environment')).toEqual({ A: '1' })
    expect(stringRecord(undefined, 'env', 'environment')).toEqual({})
    expect(stringRecord(null, 'env', 'environment')).toEqual({})
    expect(() => stringRecord([], 'env', 'environment')).toThrow('env must be an object of strings')
    expect(() => stringRecord('x', 'env', 'environment')).toThrow('env must be an object of strings')
    expect(() => stringRecord({ A: 1 }, 'env', 'environment')).toThrow('env.A must be a string')
    expect(() => stringRecord({ 'A=B': 'x' }, 'env', 'environment')).toThrow('invalid environment entry')
    expect(() => stringRecord({ 'bad header': 'x' }, 'headers', 'header')).toThrow('invalid header name')
    expect(() => stringRecord({ 'X-A': '1', 'x-a': '2' }, 'headers', 'header')).toThrow('duplicate name: x-a')
    expect(stringRecord(JSON.parse('{"__proto__":"x"}'), 'env', 'environment')).toEqual(JSON.parse('{"__proto__":"x"}'))
  })
})

describe('parseServerSpec', () => {
  it('accepts the .mcp.json stdio and HTTP forms', () => {
    expect(parseServerSpec({ command: 'uvx', args: ['srv'], cwd: 'sub', toolCallTimeoutMs: 5 }, 's')).toEqual({
      transport: 'stdio', command: 'uvx', args: ['srv'], env: {}, cwd: 'sub', toolCallTimeoutMs: 5,
    })
    expect(parseServerSpec({ type: 'http', url: 'https://x/mcp' }, 's')).toEqual({ transport: 'streamable-http', url: 'https://x/mcp', headers: {} })
    expect(parseServerSpec({ transport: 'streamable-http', url: 'https://x/mcp', headers: null }, 's').transport).toBe('streamable-http')
  })

  it.each([
    [null, 's must be an object'],
    [[], 's must be an object'],
    [{ args: [] }, 's.command is required'],
    [{ command: '' }, 's.command is required'],
    [{ command: 'x', cwd: 1 }, 's.cwd must be a string'],
    [{ command: 'x', args: [1] }, 's.args must be an array of strings'],
    [{ command: 'x', args: 'a' }, 's.args must be an array of strings'],
    [{ command: 'x', toolCallTimeoutMs: 0 }, 's.toolCallTimeoutMs must be a positive integer'],
    [{ type: 'http' }, 's.url is required'],
    [{ type: 'sse', url: 'u' }, 'deprecated SSE transport'],
    [{ type: 'ws', url: 'u' }, 'unsupported transport "ws"'],
  ])('rejects %j', (input, message) => {
    expect(() => parseServerSpec(input, 's')).toThrow(message)
  })
})

describe('expandReferences', () => {
  it('expands values and defaults and reports unset names', () => {
    const missing = new Set<string>()
    expect(expandReferences('${A}/${B:-b}/${C:-}/${D}', { A: 'a', D: '' }, missing)).toBe('a/b//')
    expect([...missing]).toEqual(['D'])
  })
})

describe('resolveCommand', () => {
  it('finds absolute, relative, and PATH commands', async () => {
    const dir = await tempDir()
    const tool = join(dir, 'tool')
    await writeFile(tool, '#!/bin/sh\n')
    await chmod(tool, 0o755)
    await mkdir(join(dir, 'tooldir'))
    expect(resolveCommand(tool, '/', undefined)).toBe(tool)
    expect(resolveCommand('./tool', dir, undefined)).toBe(tool)
    expect(resolveCommand('tool', '/', `::${join(dir, 'tooldir')}:${dir}`)).toBe(tool)
    expect(() => resolveCommand(join(dir, 'missing'), '/', undefined)).toThrow('is not an executable file')
    expect(() => resolveCommand('tool', '/', undefined)).toThrow('"tool" was not found in the 0 PATH directories; give its absolute path, or set env.PATH')
    expect(() => resolveCommand('absent', '/', `${dir}::/nonexistent`)).toThrow('was not found in the 2 PATH directories')
  })
})

describe('resolveClientConfig', () => {
  it('expands stdio declarations against the base directory', async () => {
    const base = await tempDir()
    const config = resolveClientConfig('srv', {
      transport: 'stdio', command: process.execPath, args: ['${ARG}'], env: { PATH: '${PATH}', K: 'v' }, cwd: '${SUB:-.}', toolCallTimeoutMs: 9,
    }, { baseDirectory: base, hostEnv: { ARG: 'x', PATH: process.env.PATH } })
    expect(config).toMatchObject({ transport: 'stdio', command: process.execPath, args: ['x'], cwd: base, toolCallTimeoutMs: 9, failOnStartupError: true })
    expect(describeSpec({ transport: 'stdio', command: 'node', args: ['a b'], env: { PATH: '${PATH}', K: 'v' } }, config)).toEqual([
      `command: ${JSON.stringify(process.execPath)} "a b"`, `cwd: ${base}`, 'env: PATH=${PATH}, K=…',
    ])
    expect(describeSpec({ transport: 'stdio', command: 'node', args: [], env: {} }, config)).toHaveLength(2)
  })

  it('validates HTTP declarations', () => {
    const options = { baseDirectory: '/', hostEnv: { TOKEN: 't' } }
    const config = resolveClientConfig('web', { transport: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, options)
    expect(config).toMatchObject({ url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } })
    expect(describeSpec({ transport: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: '…' } }, config)).toEqual(['url: https://x/mcp', 'headers: Authorization'])
    expect(describeSpec({ transport: 'streamable-http', url: 'https://x/mcp', headers: {} }, config)).toEqual(['url: https://x/mcp'])
    expect(() => resolveClientConfig('web', { transport: 'streamable-http', url: 'ftp://x', headers: {} }, options)).toThrow('must be an absolute http or https URL')
    expect(() => resolveClientConfig('web', { transport: 'streamable-http', url: 'not a url', headers: {} }, options)).toThrow('must be an absolute http or https URL')
    expect(() => resolveClientConfig('web', { transport: 'streamable-http', url: 'https://x', headers: { A: '${NL}' } }, { ...options, hostEnv: { NL: 'a\nb' } })).toThrow('header A has an invalid value')
    expect(() => resolveClientConfig('web', { transport: 'streamable-http', url: '${U}', headers: {} }, options)).toThrow('unset environment variables referenced without a default: U')
    expect(() => resolveClientConfig('srv', { transport: 'stdio', command: '${X}', args: [], env: {} }, options)).toThrow('without a default: X')
    expect(() => resolveClientConfig('bad name', { transport: 'streamable-http', url: 'https://x', headers: {} }, options)).toThrow('invalid server configuration')
  })
})

describe('project files', () => {
  it('searches from the working directory up to the repository root', async () => {
    const root = await tempDir()
    await mkdir(join(root, '.git'))
    const cwd = join(root, 'a', 'b')
    await mkdir(cwd, { recursive: true })
    expect(searchDirectories(cwd)).toEqual([cwd, join(root, 'a'), root])
    const loose = await tempDir()
    expect(searchDirectories(loose)).toEqual([loose])
  })

  it('merges files nearest first and reports unreadable ones', async () => {
    const near = await tempDir()
    const far = await tempDir()
    const broken = await tempDir()
    const shapeless = await tempDir()
    const unreadable = await tempDir()
    await writeFile(join(near, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'near' }, bad: { type: 'ws' } } }))
    await writeFile(join(far, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'far' }, b: { command: 'b' } } }))
    await writeFile(join(broken, '.mcp.json'), '{')
    await writeFile(join(shapeless, '.mcp.json'), '[]')
    await mkdir(join(unreadable, '.mcp.json'))
    const declarations = await readProjectDeclarations([near, far, broken, shapeless, unreadable])
    expect([...declarations.servers.values()].map(entry => [entry.name, entry.spec.transport === 'stdio' ? entry.spec.command : entry.spec.transport])).toEqual([
      ['a', 'near'], ['bad', 'invalid'], ['b', 'b'],
    ])
    expect(declarations.errors.map(entry => entry.source)).toEqual([
      join(broken, '.mcp.json'), join(shapeless, '.mcp.json'), join(unreadable, '.mcp.json'),
    ])
    expect(declarations.errors[0]?.error).toContain('invalid JSON')
    expect(declarations.errors[1]?.error).toBe('missing "mcpServers" object')
  })
})
