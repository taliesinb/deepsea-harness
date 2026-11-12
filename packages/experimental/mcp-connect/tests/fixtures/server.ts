/** Test MCP server: reports its pid and carries literal server instructions. Run: node server.ts */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { writeFileSync } from 'node:fs'
import { z } from 'zod'

if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid))
if (process.env.FIXTURE_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_DELAY_MS)))

serveStdio(() => {
  const server = new McpServer(
    { name: 'mcp-connect-fixture', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: 'FIXTURE_INSTRUCTION: call pid to learn the server process.' },
  )
  server.registerTool('add', {
    description: 'Adds two numbers.',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
  }, async args => ({ content: [{ type: 'text', text: String(args.a + args.b) }] }))
  server.registerTool('pid', {
    description: 'Returns the server pid and cwd.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, cwd: process.cwd() }) }] }))
  server.registerTool('echo', {
    description: 'Returns FIXTURE_ECHO from the environment.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'text', text: process.env.FIXTURE_ECHO ?? '<unset>' }] }))
  return server
})
