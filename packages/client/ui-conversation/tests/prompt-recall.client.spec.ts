// @vitest-environment jsdom
/** ArrowUp prompt recall through the real input shell: what is remembered, when it refills, and what it restores. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { $getSelection, $isRangeSelection, $nodesOfType } from 'lexical'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DraftReference, DraftSnapshot } from '../src/client/contract/draft-editor.ts'
import type {
  CommandClaim, DraftAttachmentId, InputTriggerController, SubmitOutcome,
} from '../src/client/contract/input.ts'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import { CommandChipNode } from '../src/client/input/editor/command-chip-node.tsx'
import { QuoteNode } from '../src/client/input/editor/QuoteNode.tsx'
import { SessionInputShell, type SessionInputDeps } from '../src/client/input/facade.ts'

const session: Omit<DraftReference, 'offset' | 'length'> = {
  source: 'reference', ref: '@[研究记录](dsh-session:c291cmNl)', label: '研究记录', appearance: 'session',
  clipboardText: '@[研究记录](dsh-session:c291cmNl)',
}

/** `see <session chip> now`, as a picked `@` reference leaves it. */
const referenced: DraftSnapshot = {
  text: `see ${session.clipboardText} now`,
  references: [{ ...session, offset: 4, length: session.clipboardText.length }],
}

function makeShell(overrides: Partial<SessionInputDeps> = {}): SessionInputShell {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const shell = new SessionInputShell({
    actx: ctx,
    defaultSink: () => Promise.resolve<SubmitOutcome>({ kind: 'success' }),
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    ...overrides,
  })
  onTestFinished(() => { shell.dispose() })
  shell.refreshLexiconSubscription()
  return shell
}

/** Submit the current draft and wait until the Host accepted it and the editor cleared. */
async function send(shell: SessionInputShell): Promise<void> {
  shell.submit()
  await vi.waitFor(() => { expect(shell.snapshot).toMatchObject({ phase: 'plain', draft: '' }) })
}

/** Type at the live caret, which must exist, and return the resulting draft text. */
function typeAtCaret(shell: SessionInputShell, text: string): string {
  expect(shell.editor.getEditorState().read(() => {
    const selection = $getSelection()
    return $isRangeSelection(selection) && selection.isCollapsed()
  })).toBe(true)
  expect(shell.actions.insertText(text, shell.actions.captureInsertion())).toBe(true)
  return shell.snapshot.draft
}

function goalClaim(): CommandClaim & { readonly submitted: string[] } {
  const submitted: string[] = []
  return {
    name: 'goal', token: '/goal ', submitted,
    submit: (args) => { submitted.push(args); return Promise.resolve({ kind: 'success' }) },
  }
}

function triggers(claim: CommandClaim): InputTriggerController {
  return {
    lexicon: createSnapshotStore(new Map()),
    launcher: createSnapshotStore<string | null>(null),
    track: () => {},
    arbitrate: () => 'pass',
    onSpace: () => false,
    serializeReference: (_source, ref) => Promise.resolve(ref),
    adjudicate: () => Promise.resolve(undefined),
    resolveClaim: () => Promise.resolve(claim),
    openReference: () => false,
    toggleSource: () => {},
  }
}

describe('ArrowUp prompt recall', () => {
  it('refills an empty draft with the last sent prompt, its reference chips and quotes, caret at the end', async () => {
    const shell = makeShell({ inputTriggers: () => triggers(goalClaim()) })
    expect(shell.recallPrompt()).toBe(false) // nothing sent yet
    shell.setDraft(referenced)
    expect(shell.insertQuote('quoted line')).toBe(true)
    const sent = shell.draftSnapshot
    await send(shell)

    expect(shell.recallPrompt()).toBe(true)
    expect(shell.draftSnapshot).toEqual(sent)
    expect(shell.editor.getEditorState().read(() => ({
      chips: $nodesOfType(ReferenceChipNode).map(node => node.getLabel()),
      quotes: $nodesOfType(QuoteNode).map(node => node.getQuoteText()),
    }))).toEqual({ chips: ['研究记录'], quotes: ['quoted line'] })
    expect(typeAtCaret(shell, '!')).toBe(`${sent.text}!`)
  })

  it('leaves a draft with any text or attachment, and a busy input, unchanged', async () => {
    const sink = Promise.withResolvers<SubmitOutcome>()
    let pending = false
    const shell = makeShell({
      defaultSink: () => pending ? sink.promise : Promise.resolve({ kind: 'success' }),
    })
    shell.setDraft('first')
    await send(shell)

    shell.setDraft('\n')
    expect(shell.recallPrompt()).toBe(false)
    expect(shell.snapshot.draft).toBe('\n')
    shell.setDraft('')
    expect(shell.addAttachments(['image' as DraftAttachmentId])).toBe(true)
    expect(shell.recallPrompt()).toBe(false)
    expect(shell.snapshot).toMatchObject({ draft: '', attachmentIds: ['image'] })

    expect(shell.removeAttachment('image' as DraftAttachmentId)).toBe(true)
    pending = true
    shell.setDraft('second')
    shell.submit()
    expect(shell.snapshot.phase).toBe('sending')
    expect(shell.recallPrompt()).toBe(false)
    expect(shell.snapshot.draft).toBe('second')
    sink.resolve({ kind: 'success' })
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('') })

    shell.dispose()
    expect(shell.recallPrompt()).toBe(false)
  })

  it('recalls one level: clearing again recalls the same prompt until another is sent', async () => {
    const shell = makeShell()
    shell.setDraft('first')
    await send(shell)
    expect(shell.recallPrompt()).toBe(true)
    shell.setDraft('')
    expect(shell.recallPrompt()).toBe(true)
    expect(shell.snapshot.draft).toBe('first')

    shell.setDraft('second')
    await send(shell)
    expect(shell.recallPrompt()).toBe(true)
    expect(shell.snapshot.draft).toBe('second')
  })

  it('remembers only prompts the Host accepted', async () => {
    let outcome: SubmitOutcome = { kind: 'success' }
    const shell = makeShell({ defaultSink: () => Promise.resolve(outcome) })
    shell.setDraft('accepted')
    await send(shell)
    outcome = { kind: 'error' }
    shell.setDraft('refused')
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.draft).toBe('refused')
    shell.setDraft('')
    expect(shell.recallPrompt()).toBe(true)
    expect(shell.snapshot.draft).toBe('accepted')
  })

  it('rebuilds a submitted command chip and keeps the caret after its arguments', async () => {
    const claim = goalClaim()
    const shell = makeShell({ inputTriggers: () => triggers(claim) })
    shell.setDraft('/goal ')
    expect(shell.beginCommand(claim, { start: 0, end: 6, draftRev: shell.snapshot.draftRev })).toBe(true)
    expect(shell.actions.insertText('ship it', shell.actions.captureInsertion())).toBe(true)
    await send(shell)
    expect(claim.submitted).toEqual(['ship it'])

    expect(shell.recallPrompt()).toBe(true)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
    expect(shell.editor.getEditorState().read(() => $nodesOfType(CommandChipNode).length)).toBe(1)
    expect(shell.draftSnapshot).toEqual({ text: '/goal ship it', references: [], command: { token: '/goal ' } })
    expect(typeAtCaret(shell, '!')).toBe('/goal ship it!')
  })

  it('restores a command chip written inside an editor update only while that write is the latest', async () => {
    const claim = goalClaim()
    const resolveClaim = vi.fn(() => Promise.resolve(claim))
    const shell = makeShell({ inputTriggers: () => ({ ...triggers(claim), resolveClaim }) })
    const goal: DraftSnapshot = { text: '/goal ship', references: [], command: { token: '/goal ' } }
    shell.editor.update(() => {
      shell.setDraft(goal)
      shell.setDraft('plain words')
    }, { discrete: true })
    expect(shell.snapshot.draft).toBe('plain words')
    expect(resolveClaim).not.toHaveBeenCalled()

    shell.editor.update(() => { shell.setDraft(goal) }, { discrete: true })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
    expect(resolveClaim).toHaveBeenCalledOnce()
    expect(typeAtCaret(shell, '!')).toBe('/goal ship!')
  })

  it('registers the sent attachments again from the files captured at submission', async () => {
    const files = [new File([Uint8Array.of(1)], 'shot.png', { type: 'image/png' })]
    const capture = vi.fn(() => files)
    const readmit = vi.fn(() => ['fresh' as DraftAttachmentId])
    const shell = makeShell({ promptAttachments: { capture, readmit } })
    expect(shell.addAttachments(['sent' as DraftAttachmentId])).toBe(true)
    shell.setDraft('what is this?')
    await send(shell)
    expect(capture).toHaveBeenCalledWith(['sent'])
    expect(shell.snapshot.attachmentIds).toEqual([])

    expect(shell.recallPrompt()).toBe(true)
    expect(readmit).toHaveBeenCalledWith(files)
    expect(shell.snapshot).toMatchObject({ draft: 'what is this?', attachmentIds: ['fresh'] })

    const successor = makeShell({ promptAttachments: { capture, readmit } })
    successor.seedLastPrompt(shell.rememberedPrompt)
    expect(successor.recallPrompt()).toBe(true)
    expect(readmit).toHaveBeenLastCalledWith(files)
    expect(successor.snapshot).toMatchObject({ draft: 'what is this?', attachmentIds: ['fresh'] })
  })

  it('recalls the text of a prompt whose attachment files are unavailable', async () => {
    const shell = makeShell()
    expect(shell.addAttachments(['sent' as DraftAttachmentId])).toBe(true)
    shell.setDraft('caption')
    await send(shell)
    expect(shell.recallPrompt()).toBe(true)
    expect(shell.snapshot).toMatchObject({ draft: 'caption', attachmentIds: [] })
  })

  it('persists the sent prompt through the bound writer and recalls a seeded one', async () => {
    const write = vi.fn<(draft: DraftSnapshot) => void>()
    const writePrompt = vi.fn<(prompt: DraftSnapshot) => void>()
    const first = makeShell({ inputTriggers: () => triggers(goalClaim()) })
    const unbind = first.bindDraftPersistence(write, writePrompt)
    first.persistCurrentDraft()
    expect(writePrompt).not.toHaveBeenCalled()
    first.setDraft(referenced)
    await send(first)
    expect(writePrompt).toHaveBeenLastCalledWith(referenced)
    first.persistCurrentDraft()
    expect(writePrompt).toHaveBeenCalledTimes(2)
    unbind()
    first.setDraft('unbound')
    await send(first)
    expect(writePrompt).toHaveBeenCalledTimes(2)

    const reloaded = makeShell({ promptAttachments: { capture: () => [], readmit: vi.fn(() => []) } })
    reloaded.seedLastPrompt({ draft: JSON.parse(JSON.stringify(writePrompt.mock.lastCall![0])) as DraftSnapshot, files: [] })
    expect(reloaded.recallPrompt()).toBe(true)
    expect(reloaded.draftSnapshot).toEqual(referenced)
    expect(reloaded.snapshot.attachmentIds).toEqual([])

    const blank = makeShell()
    blank.seedLastPrompt(undefined)
    expect(blank.recallPrompt()).toBe(false)
  })

  it('keeps the newer writer bound when a superseded one unbinds', async () => {
    const shell = makeShell()
    const stale = vi.fn<(prompt: DraftSnapshot) => void>()
    const current = vi.fn<(prompt: DraftSnapshot) => void>()
    const unbindStale = shell.bindDraftPersistence(() => {}, stale)
    shell.bindDraftPersistence(() => {}, current)
    unbindStale()
    shell.setDraft('kept')
    await send(shell)
    expect(stale).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledWith({ text: 'kept', references: [] })
  })
})
