/**
 * `importSessionArchive` / `storeSessionLogs`: the storing half of a
 * cross-host move. Archive entries shaped like `session.export`'s (root log,
 * `subagents/<id>/session[.vN].jsonl`, `media/`, `files/`) become stored
 * Sessions of the destination Workspace through a real JSONL backend.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import {
  FOREIGN_DELIVERY_EVENT_TYPE, importSessionArchive, SESSION_IMPORT_NOTICE_SOURCE, storeSessionLogs,
} from '../src/import.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false, cwd: '/remote/proj', ...extra }
}

/** One exported log as `session.export` writes it: the physical header line, then one line per event. */
function serializeSessionLog(meta: SessionHeader, events: readonly SessionEvent[]): string {
  const line = { type: 'session', ...meta, delegationDepth: meta.delegationDepth ?? 0 }
  return `${[JSON.stringify(line), ...events.map(event => JSON.stringify(event))].join('\n')}\n`
}

function oneTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2000, data: createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'turn/end', seq: SessionSeq(2), time: 2001, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** An event declared by a package this one does not depend on, built through its envelope fields. */
function foreignTypedEvent(type: string, seq: number, data: Record<string, unknown>): SessionEvent {
  const event: Omit<SessionEvent, 'type' | 'data'> & { readonly type: string; readonly data: unknown } = {
    type, seq: SessionSeq(seq), time: 2002, data,
  }
  return event as SessionEvent
}

interface Harness {
  ctx: Context
  root: string
  saved: { images: number; files: string[] }
  workspace: Workspace
  attached: SessionId[]
  stored: SessionHeader[]
}

async function mount(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  dirs.push(home)
  const root = join(home, 'sessions')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const saved = { images: 0, files: [] as string[] }
  ctx.provide('attachments', {
    saveImage: vi.fn(async () => {
      saved.images += 1
      return { attachmentId: 'sha256-abc' }
    }),
    saveFile: vi.fn(async (input: { name?: string }) => {
      saved.files.push(input.name ?? '?')
      return {}
    }),
  } as never)
  const attached: SessionId[] = []
  const stored: SessionHeader[] = []
  ctx.on('session-persistence/stored', (meta) => { stored.push(meta) })
  const partial: Partial<Workspace> = {
    id: WorkspaceId('ws-1'), path: '/local/dest', title: 'dest',
    attachSession: vi.fn(async (id: SessionId) => { attached.push(id) }),
  }
  const workspace = partial as Workspace
  return { ctx, root, saved, workspace, attached, stored }
}

/** A released V3 log with one completed turn. */
function v3Log(id: string, extra: Record<string, unknown> = {}, events: readonly Record<string, unknown>[] = []): string {
  const turn = events.length
  return [
    JSON.stringify({ type: 'session', version: 3, id, createdAt: 1000, cwd: '/remote/proj', isSeeded: false, delegationDepth: 0, ...extra }),
    ...events.map(event => JSON.stringify(event)),
    JSON.stringify({ type: 'turn/start', seq: turn, time: 2000, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: turn + 1, time: 2001, data: { turn: 1, reason: { kind: 'completed' } } }),
    '',
  ].join('\n')
}

function noticeText(events: readonly SessionEvent[]): string {
  const notice = events.at(-1)
  if (notice?.type !== 'agent/inbox/spliced') throw new Error('missing notice')
  const text = notice.data.inserted[0]?.content[0]
  return text?.type === 'text' ? text.text : ''
}

/** A log whose second turn started at time 3000 and never ended, with its prompt queued just before. */
function midTurn(): SessionEvent[] {
  return [
    ...oneTurn(),
    { type: 'agent/inbox/spliced', seq: SessionSeq(3), time: 2999, data: { target: 'next-turn', start: 0, inserted: [createUserMessage({
      content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' },
    })] } },
    { type: 'turn/start', seq: SessionSeq(4), time: 3000, data: { turn: 2 } },
  ]
}

function bundle(entries: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(entries)) files[path] = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return files
}

async function read(root: string, id: SessionId): Promise<{ header: SessionHeader; events: readonly SessionEvent[] }> {
  const fresh = new Context()
  contexts.push(fresh)
  await fresh.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const handle = await fresh.sessionPersistence.open(id, 'read')
  try {
    return { header: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

describe('importSessionArchive', () => {
  it('stores root and subagent logs under the destination cwd, saves attachments, notifies, attaches the root', async () => {
    const { ctx, root, saved, workspace, attached, stored: announced } = await mount()
    const rootId = SessionId('session-root')
    const childId = SessionId('session-child')
    const zip = bundle({
      'session.v4.jsonl': serializeSessionLog(header('session-root'), oneTurn()),
      'subagents/session-child/session.v4.jsonl': serializeSessionLog(
        header('session-child', { parentSession: rootId, origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
      'media/sha256-abc.png': new Uint8Array([1, 2, 3, 4]),
      'files/ab/abababababababababababababababababababababababababababababababab/notes.txt': new TextEncoder().encode('hello'),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'alpha/dsh' })
    expect(result).toEqual({
      sessionId: rootId,
      attachments: 2,
      truncated: false,
      imported: [
        { sessionId: rootId, exportedId: rootId },
        { sessionId: childId, exportedId: childId, parentSessionId: rootId },
      ],
    })
    expect(saved).toEqual({ images: 1, files: ['notes.txt'] })
    expect(attached).toEqual([rootId])
    expect(announced.map(meta => [meta.id, meta.cwd])).toEqual([[rootId, '/local/dest'], [childId, '/local/dest']])

    const stored = await read(root, rootId)
    expect(stored.header.cwd).toBe('/local/dest')
    expect(stored.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end', 'agent/inbox/spliced'])
    const notice = stored.events[3]
    if (notice?.type !== 'agent/inbox/spliced') throw new Error('missing notice')
    expect(notice.data.target).toBe('next-step')
    expect(notice.data.inserted[0]?.source).toMatchObject({ kind: SESSION_IMPORT_NOTICE_SOURCE, form: 'notice' })
    const text = notice.data.inserted[0]?.content[0]
    expect(text?.type === 'text' ? text.text : '').toContain('imported from alpha/dsh into the workspace `dest` (/local/dest)')
    expect((await read(root, childId)).header).toMatchObject({ cwd: '/local/dest', parentSession: rootId })
  })

  it('mints new ids on collision, re-identifies the family, and appends nothing with notify=false', async () => {
    const { ctx, root, workspace } = await mount()
    const existing = await ctx.sessionPersistence.create(header('session-root', { cwd: '/elsewhere' }))
    await existing.append(oneTurn())
    await existing.close()
    const exportedRoot = SessionId('session-root')
    const exportedChild = SessionId('session-child')
    const zip = bundle({
      'session.jsonl': serializeSessionLog(header('session-root'), [
        ...oneTurn(),
        foreignTypedEvent('subagent/catalog', 3, { version: 0, childId: exportedChild, childCreatedAt: 1000, mode: 'one-shot' }),
        foreignTypedEvent('session-log-deepseek/delivery-accepted', 4, {
          sessionId: exportedRoot, sessionFormatVersion: SESSION_FORMAT_VERSION, throughSeq: 2,
        }),
      ]),
      'subagents/session-child/session.jsonl': serializeSessionLog(
        header('session-child', { parentSession: exportedRoot, origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'beta', notify: false })
    expect(result.sessionId).not.toBe(exportedRoot)
    const child = result.imported[1]
    expect(child).toMatchObject({ exportedId: exportedChild, parentSessionId: result.sessionId })
    // The child id was free here, so it is kept.
    expect(child?.sessionId).toBe(exportedChild)

    const stored = await read(root, result.sessionId)
    expect(stored.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'subagent/catalog', FOREIGN_DELIVERY_EVENT_TYPE,
    ])
    expect(stored.events[4]).toMatchObject({ ignorable: true, data: { sessionId: exportedRoot, throughSeq: 2 } })
  })

  it('remaps a parent catalog to its re-identified children with keepIds=false', async () => {
    const { ctx, root, workspace } = await mount()
    const exportedChild = SessionId('session-child')
    const zip = bundle({
      'session.jsonl': serializeSessionLog(header('session-root'), [
        ...oneTurn(),
        foreignTypedEvent('subagent/catalog', 3, { version: 0, childId: exportedChild, childCreatedAt: 1000, mode: 'one-shot' }),
      ]),
      'subagents/session-child/session.jsonl': serializeSessionLog(
        header('session-child', { parentSession: SessionId('session-root'), origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'beta', keepIds: false, notify: false })
    const newChild = result.imported[1]?.sessionId
    expect(newChild).not.toBe(exportedChild)
    const stored = await read(root, result.sessionId)
    expect(stored.events[3]).toMatchObject({ type: 'subagent/catalog', data: { childId: newChild } })
  })

  it('migrates a historical generation with the archive\'s own child evidence', async () => {
    const { ctx, root, workspace } = await mount()
    const zip = bundle({
      'session.v3.jsonl': v3Log('legacy-root'),
      'subagents/legacy-child/session.v3.jsonl': v3Log('legacy-child', { parentSession: 'legacy-root', origin: 'subagent', delegationDepth: 1 }),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'old host', notify: false })
    const stored = await read(root, result.sessionId)
    expect(stored.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(stored.events.map(event => event.type)).toEqual(['turn/start', 'turn/end', 'subagent/catalog'])
    expect(stored.events[2]?.data).toMatchObject({ childId: 'legacy-child' })
  })

  it('refuses archives without a root log and logs that are not JSONL sessions', async () => {
    const { ctx, workspace } = await mount()
    await expect(importSessionArchive(ctx, bundle({ 'media/x.png': new Uint8Array([1]) }), { workspace, origin: 'x' }))
      .rejects.toThrow('no root session log')
    await expect(importSessionArchive(ctx, bundle({ 'session.jsonl': 'not json\n' }), { workspace, origin: 'x' }))
      .rejects.toThrow('header line is not JSON')
    await expect(importSessionArchive(ctx, bundle({ 'session.jsonl': '\n' }), { workspace, origin: 'x' }))
      .rejects.toThrow('session.jsonl: empty log')
    for (const first of ['42', 'null', '[]', '{"type":"turn/start"}']) {
      await expect(importSessionArchive(ctx, bundle({ 'session.jsonl': `${first}\n` }), { workspace, origin: 'x' }))
        .rejects.toThrow('first line is not a session header')
    }
    await expect(importSessionArchive(ctx, bundle({ 'session.jsonl': `${JSON.stringify({ type: 'session', id: 'r', createdAt: 1 })}\n` }), {
      workspace, origin: 'x',
    })).rejects.toThrow('session.jsonl: header carries no format version')
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('is unavailable without an attachments service', async () => {
    const { workspace } = await mount()
    const bare = new Context()
    contexts.push(bare)
    await expect(importSessionArchive(bare, bundle({ 'session.jsonl': serializeSessionLog(header('r'), oneTurn()) }), { workspace, origin: 'x' }))
      .rejects.toThrow('missing attachments service')
  })

  it('keeps a header without cwd as one under the destination and carries its agent preset', async () => {
    const { ctx, root, workspace } = await mount()
    const bare: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId('no-cwd'), createdAt: 1000, isSeeded: false, agentPreset: 'reviewer',
    }
    const result = await importSessionArchive(ctx, bundle({ 'session.jsonl': serializeSessionLog(bare, oneTurn()) }), {
      workspace, origin: 'x', notify: false,
    })
    expect((await read(root, result.sessionId)).header).toMatchObject({ cwd: '/local/dest', agentPreset: 'reviewer' })
  })

  it('migrates a historical root whose subagent log is already current', async () => {
    const { ctx, root, workspace } = await mount()
    const zip = bundle({
      'session.v3.jsonl': v3Log('legacy-root'),
      'subagents/fresh-child/session.v4.jsonl': serializeSessionLog(
        header('fresh-child', { parentSession: SessionId('legacy-root'), origin: 'subagent', delegationDepth: 1 }),
        oneTurn(),
      ),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'old host', notify: false })
    expect(result.imported.map(entry => entry.sessionId)).toEqual(['legacy-root', 'fresh-child'])
    const stored = await read(root, result.sessionId)
    expect(stored.events.at(-1)).toMatchObject({ type: 'subagent/catalog', data: { childId: 'fresh-child' } })
  })

  it('records a historical child whose descriptor cannot be read as a member of unknown mode', async () => {
    const { ctx, root, workspace } = await mount()
    const zip = bundle({
      'session.v3.jsonl': v3Log('legacy-root'),
      'subagents/odd-child/session.v3.jsonl': v3Log('odd-child', { parentSession: 'legacy-root', origin: 'subagent', delegationDepth: 1 }, [
        { type: 'subagent/descriptor', seq: 0, time: 1500, data: { version: 3, mode: 'continuable', label: 'no provider' } },
      ]),
    })
    const result = await importSessionArchive(ctx, zip, { workspace, origin: 'old host', notify: false })
    const stored = await read(root, result.sessionId)
    expect(stored.events.at(-1)).toMatchObject({ type: 'subagent/catalog', data: { childId: 'odd-child', childCreatedAt: 1000, mode: 'unknown' } })
  })

  it('refuses a historical archive whose subagent log has no identity', async () => {
    const { ctx, workspace } = await mount()
    const zip = bundle({
      'session.v3.jsonl': v3Log('legacy-root'),
      'subagents/anonymous/session.v3.jsonl': v3Log('ignored', { id: 7, createdAt: 'never', parentSession: 'legacy-root', origin: 'subagent' }),
    })
    await expect(importSessionArchive(ctx, zip, { workspace, origin: 'old host' })).rejects.toThrow()
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('saves an image whose bytes hash to another id and warns that its references will not resolve', async () => {
    const { ctx, saved, workspace } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await importSessionArchive(ctx, bundle({
      'session.jsonl': serializeSessionLog(header('r'), oneTurn()),
      'media/sha256-other.webp': new Uint8Array([9]),
      'media/sha256-abc.bmp': new Uint8Array([9]),
    }), { workspace, origin: 'x', notify: false })
    expect(result.attachments).toBe(1)
    expect(saved.images).toBe(1)
    expect(warn).toHaveBeenCalledWith('session import: image media/sha256-other.webp was stored as sha256-abc; references to it will not resolve')
  })
})

describe('storeSessionLogs', () => {
  it('stores already parsed logs with the caller\'s options', async () => {
    const { ctx, root, workspace, attached } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('parsed'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) },
      children: [],
    }, { workspace, origin: '/backups/home', keepIds: true, notify: false })
    expect(result).toEqual({
      sessionId: 'parsed', imported: [{ sessionId: 'parsed', exportedId: 'parsed' }], attachments: 0, truncated: false,
    })
    expect(attached).toEqual(['parsed'])
    expect((await read(root, SessionId('parsed'))).events).toHaveLength(3)
  })

  it('copies with fresh ids, a title, and the copy notice in copy mode, and words a same-host notice', async () => {
    const { ctx, root, workspace } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('original'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) },
      children: [],
    }, { workspace, origin: 'the workspace `src`', mode: 'copy', title: '  Original (copy) ', crossHost: false })
    expect(result.sessionId).not.toBe('original')
    const stored = await read(root, result.sessionId)
    expect(stored.events.slice(3).map(event => event.type)).toEqual(['session/title', 'agent/inbox/spliced'])
    expect(stored.events[3]).toMatchObject({ data: { title: 'Original (copy)' } })
    const notice = stored.events[4]
    if (notice?.type !== 'agent/inbox/spliced') throw new Error('missing notice')
    const text = notice.data.inserted[0]?.content[0]
    expect(text?.type === 'text' ? text.text : '').toContain('Earlier file references may need to be re-read from the new location.')
  })

  it('refuses a log the current format would not read back', async () => {
    const { ctx, workspace } = await mount()
    const broken: SessionEvent = { type: 'turn/end', seq: SessionSeq(0), time: 1, data: { turn: 9, reason: { kind: 'completed' } } }
    await expect(storeSessionLogs(ctx, {
      root: { header: header('broken'), events: [broken], inheritedEventCount: SessionLogOffset(0) },
      children: [],
    }, { workspace, origin: 'x', notify: false })).rejects.toThrow()
    expect(await ctx.sessionPersistence.stat(SessionId('broken'))).toBeUndefined()
  })

  it('is unavailable without session persistence', async () => {
    const { workspace } = await mount()
    const bare = new Context()
    contexts.push(bare)
    await expect(storeSessionLogs(bare, {
      root: { header: header('r'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) }, children: [],
    }, { workspace, origin: 'x' })).rejects.toThrow('missing session-persistence service')
  })

  it('names the new id in a same-host import notice when the exported one is taken', async () => {
    const { ctx, root, workspace } = await mount()
    const existing = await ctx.sessionPersistence.create(header('taken'))
    await existing.append(oneTurn())
    await existing.close()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('taken'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) }, children: [],
    }, { workspace, origin: '/backups/home', crossHost: false })
    const text = noticeText((await read(root, result.sessionId)).events)
    expect(text).toContain('imported from /backups/home into the workspace `dest` (/local/dest).')
    expect(text).toContain(`Its id changed from \`taken\` to \`${result.sessionId}\`.`)
    expect(text).not.toContain('on this host')
    expect(text).toContain('Earlier file references may need to be re-read from the new location.')
  })

  it('words a cross-host copy notice for a turn closed as interrupted', async () => {
    const { ctx, root, workspace } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('busy'), events: midTurn(), inheritedEventCount: SessionLogOffset(0) }, children: [],
    }, { workspace, origin: 'alpha/dsh', mode: 'copy' })
    expect(result.truncated).toBe(false)
    const stored = await read(root, result.sessionId)
    expect(stored.events.at(-2)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
    const text = noticeText(stored.events)
    expect(text).toContain('this session is a copy of session `busy` from alpha/dsh')
    expect(text).toContain('(/local/dest) on this host. The original continues separately')
    expect(text).toContain('it is recorded here as interrupted, and the outcome of any tool call it had pending is unknown.')
    expect(text).toContain('Files referenced earlier in the conversation lived on the original host')
  })

  it('drops a turn in progress with the descendants born in it, and says so in the notice', async () => {
    const { ctx, root, workspace } = await mount()
    const parent = SessionId('busy')
    const child = (id: string, createdAt: number) => ({
      header: header(id, { parentSession: parent, origin: 'subagent', delegationDepth: 1, createdAt }),
      events: oneTurn(),
      inheritedEventCount: SessionLogOffset(0),
    })
    const result = await storeSessionLogs(ctx, {
      root: { header: header('busy'), events: midTurn(), inheritedEventCount: SessionLogOffset(0) },
      children: [child('before', 2500), child('during', 3000)],
    }, { workspace, origin: 'alpha/dsh', mode: 'copy', truncate: true })
    expect(result.truncated).toBe(true)
    expect(result.imported.map(entry => entry.exportedId)).toEqual(['busy', 'before'])
    expect(result.imported[1]?.parentSessionId).toBe(result.sessionId)
    const stored = await read(root, result.sessionId)
    expect(stored.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'agent/inbox/spliced', 'agent/inbox/spliced', 'agent/inbox/spliced',
    ])
    expect(noticeText(stored.events)).toContain('that turn, and the prompt that started it, are not part of this copy.')
  })

  it('refuses a family holding two logs for one id', async () => {
    const { ctx, workspace } = await mount()
    const log = { header: header('twice'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) }
    await expect(storeSessionLogs(ctx, { root: log, children: [log] }, { workspace, origin: 'x' }))
      .rejects.toThrow('the archive holds two logs for "twice"')
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('keeps the parent id of a descendant whose parent is not part of the family', async () => {
    const { ctx, root, workspace } = await mount()
    const orphan = header('orphan', { parentSession: SessionId('elsewhere'), origin: 'subagent', delegationDepth: 1 })
    const result = await storeSessionLogs(ctx, {
      root: { header: header('r'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) },
      children: [{ header: orphan, events: oneTurn(), inheritedEventCount: SessionLogOffset(0) }],
    }, { workspace, origin: 'x', notify: false })
    expect(result.imported[1]).toEqual({ sessionId: 'orphan', exportedId: 'orphan', parentSessionId: 'elsewhere' })
    expect((await read(root, SessionId('orphan'))).header.parentSession).toBe('elsewhere')
  })

  it('stores the notice as the first event of an empty log', async () => {
    const { ctx, root, workspace } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: { header: header('empty'), events: [], inheritedEventCount: SessionLogOffset(0) }, children: [],
    }, { workspace, origin: 'x' })
    const stored = await read(root, result.sessionId)
    expect(stored.events).toMatchObject([{ type: 'agent/inbox/spliced', seq: 0 }])
  })

  it('keeps a forked log\'s inherited cut', async () => {
    const { ctx, root, workspace } = await mount()
    const result = await storeSessionLogs(ctx, {
      root: {
        header: header('fork', { parentSession: SessionId('ancestor'), isSeeded: true }),
        events: [...oneTurn(), { type: 'session/end-seed', seq: SessionSeq(3), time: 2001, data: { inherited: true } }],
        inheritedEventCount: SessionLogOffset(3),
      },
      children: [],
    }, { workspace, origin: 'x', notify: false })
    const fresh = new Context()
    contexts.push(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await fresh.sessionPersistence.open(result.sessionId, 'read')
    try {
      expect(handle.header).toMatchObject({ isSeeded: true, parentSession: 'ancestor' })
      expect(handle.inheritedEventCount).toBe(3)
    } finally {
      await handle.close()
    }
  })

  it('observes cancellation before storing and passes a live signal to persistence', async () => {
    const { ctx, workspace } = await mount()
    const log = { header: header('signalled'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) }
    const aborted = new AbortController()
    aborted.abort(new Error('caller left'))
    await expect(storeSessionLogs(ctx, { root: log, children: [] }, { workspace, origin: 'x', signal: aborted.signal }))
      .rejects.toThrow('caller left')
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    const create = vi.spyOn(ctx.sessionPersistence, 'create')
    const { signal } = new AbortController()
    const result = await storeSessionLogs(ctx, { root: log, children: [] }, { workspace, origin: 'x', signal, notify: false })
    expect(result.sessionId).toBe('signalled')
    expect(stat).toHaveBeenCalledWith('signalled', { signal })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'signalled' }), { signal })
  })

  it('stores the log and warns when seeding the projection cache fails', async () => {
    const { ctx, root, workspace, stored: announced } = await mount()
    ctx.provide('sessionProjectionCache', { coldSnapshot: () => { throw new Error('cache full') } } as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await storeSessionLogs(ctx, {
      root: { header: header('cached'), events: oneTurn(), inheritedEventCount: SessionLogOffset(0) }, children: [],
    }, { workspace, origin: 'x', notify: false })
    expect(warn).toHaveBeenCalledWith('session import: projection cache seed for "cached" failed: Error: cache full')
    expect(announced.map(meta => meta.id)).toEqual([result.sessionId])
    expect((await read(root, result.sessionId)).events).toHaveLength(3)
  })
})
