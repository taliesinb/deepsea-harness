// Web e2e scenario: message IconActions + clocks. Cold-seeds a deterministic
// completed-turn-tail fork case with an unchanged resume header (zero model
// calls) and pins the settled conversation aria after the footers are
// focus-revealed — the surface package jsdom tests cannot substitute for
// (docs/testing.md snapshot rule).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import type { Browser, Page, Request as BrowserRequest } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, realizeSeedFixture, renderSeedFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/message-actions', import.meta.url))
// Borrowed read-only: this scenario needs any settled user+assistant pair, not
// a new recording (workspace-management / sidebar-scrollbar pattern).
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const FORK_EXPECTED = join(SNAPSHOT_DIR, 'fork.expected.md')
const UNOPENED_FORK_EXPECTED = join(SNAPSHOT_DIR, 'fork-unopened.expected.md')
const REWIND_CONFIRM_EXPECTED = join(SNAPSHOT_DIR, 'rewind-confirm.expected.md')
const REWIND_EXPECTED = join(SNAPSHOT_DIR, 'rewind.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'message-actions-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
const MID_TURN_TEXT = 'I will read both files before answering.'
const SECOND_PROMPT = 'Now give the final answer.'
const NEXT_PROMPT = 'Keep this later input in the original conversation.'

/**
 * Adapt the borrowed recording into response -> tools -> interrupted Think,
 * followed by two ordinary completed responses. The first response keeps
 * copy/clock but is not a legal branch point; the second is the real turn tail.
 * @param raw - Recorded seeded-history JSONL.
 * @returns A contiguous, closed three-turn fixture.
 */
function completedTailFixture(raw: string): string {
  const decoded = parseSeedFixture(raw)
  const stepTwoStart = decoded.events.findIndex(event =>
    event.type === 'step/start' && event.data.turn === 1 && event.data.step === 2)
  if (stepTwoStart < 0) throw new Error('borrowed fixture has no step-two start')
  const kept = decoded.events.slice(0, stepTwoStart + 1).map((event) => {
    if (event.type !== 'assistant/message' || event.data.turn !== 1 || event.data.step !== 1) return event
    const finish = event.data.stream.findIndex(record =>
      record.type === 'chunk' && record.chunk.type === 'finish')
    if (finish < 0) throw new Error('borrowed step-one Assistant message has no finish record')
    const finishRecord = event.data.stream[finish]!
    if (finishRecord.type !== 'chunk') throw new Error('borrowed step-one finish is not a chunk record')
    const streamTime = finishRecord.time
    return {
      ...event,
      data: {
        ...event.data,
        message: {
          ...event.data.message,
          content: [...event.data.message.content, { type: 'text' as const, text: MID_TURN_TEXT }],
        },
        stream: [
          ...event.data.stream.slice(0, finish),
          { type: 'chunk' as const, time: streamTime, chunk: { type: 'block-start' as const, index: 3, blockType: 'text' as const } },
          { type: 'text-chunks' as const, time0: streamTime, index: 3, dt: [], texts: [MID_TURN_TEXT] },
          {
            type: 'chunk' as const,
            time: streamTime,
            chunk: { type: 'block-end' as const, index: 3, block: { type: 'text' as const, text: MID_TURN_TEXT } },
          },
          ...event.data.stream.slice(finish),
        ],
      },
    }
  })
  const inheritedHeader = kept.findLast(event => event.type === 'request/header')
  if (inheritedHeader?.type !== 'request/header') {
    throw new Error('borrowed recording has no request header')
  }
  let seq = (kept.at(-1)?.seq ?? -1) + 1
  let time = (kept.at(-1)?.time ?? -1) + 1
  const at = (event: Record<string, unknown>): { seq: number; time: number } & Record<string, unknown> => ({
    ...event,
    seq: seq++,
    time: time++,
  })
  const tail = [
    at({
      type: 'assistant/attempt',
      data: {
        turn: 1,
        step: 2,
        stream: [
          { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'reasoning-chunks', time0: time, index: 0, dt: [], texts: ['This path was interrupted.'] },
          {
            type: 'chunk',
            time,
            chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'This path was interrupted.' } },
          },
          { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      },
    }),
    at({ type: 'step/end', data: { turn: 1, step: 2 } }),
    at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
    at({ type: 'turn/start', data: { turn: 2 } }),
    at({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: SECOND_PROMPT }],
        source: { kind: 'user' },
        role: 'user',
        id: '{{message:98}}',
      },
      surfaceOp: 'append',
    }),
    at({ type: 'step/start', data: { turn: 2, step: 1 } }),
    at({ type: 'request/header', data: { header: inheritedHeader.data.header, reason: 'resume' } }),
    at({
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'DONE' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          id: '{{message:99}}',
        },
        stream: [
          { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['DONE'] },
          { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } } },
          { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      },
      surfaceOp: 'append',
    }),
    at({ type: 'step/end', data: { turn: 2, step: 1 } }),
    at({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }),
    at({
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-turn', start: 0,
        inserted: [{
          role: 'user', id: '{{message:100}}', source: { kind: 'user' },
          content: [{ type: 'text', text: NEXT_PROMPT }],
        }],
      },
    }),
    at({ type: 'turn/start', data: { turn: 3 } }),
    at({
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    }),
    at({ type: 'step/start', data: { turn: 3, step: 1 } }),
    at({
      type: 'user/message', surfaceOp: 'append',
      data: {
        role: 'user', id: '{{message:100}}', source: { kind: 'user' },
        content: [{ type: 'text', text: NEXT_PROMPT }],
      },
    }),
    at({
      type: 'assistant/message', surfaceOp: 'append',
      data: {
        turn: 3, step: 1,
        message: {
          role: 'assistant', id: '{{message:101}}',
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          content: [{ type: 'text', text: 'ORIGINAL ONLY' }],
        },
        stream: [
          { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['ORIGINAL ONLY'] },
          { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'ORIGINAL ONLY' } } },
          { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      },
    }),
    at({ type: 'step/end', data: { turn: 3, step: 1 } }),
    at({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }),
  ]
  return renderSeedFixture(decoded.headerLine, [...kept, ...tail])
}

describe('web e2e: message IconActions and clocks on settled history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let hostClock: ReturnType<typeof pinHostClock> | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await mkdir(fileURLToPath(new URL('../../../.artifacts/screenshots/non-migrating-session-reads', import.meta.url)), { recursive: true })
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    const raw = completedTailFixture(await readFile(SEED, 'utf8'))
    expect(fixtureUserPrompts(raw), 'adapted seed must carry all prompts').toEqual([PROMPT, SECOND_PROMPT, NEXT_PROMPT])
    expect(parseSeedFixture(raw).events.flatMap(event => event.type === 'request/header'
      ? [event.data.reason]
      : []), 'adapted seed must carry an unchanged resume header').toEqual(['initial', 'resume'])
    // The fixture carries no times of its own, so the seed anchors them at
    // `Date.now() - 60_000` unless the scenario names the shared fixture day.
    // 90 s keeps the earliest rows in the `1min` bucket and the later ones,
    // carried by their stream spans, inside `now` — what the fork golden records.
    await seedSession(scaffold, raw, SEED_ID, undefined, { createdAt: WEB_FIXTURE_TIME - 90_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // Fork summaries use Host time; placeholders use browser time. Each pin
    // starts at the fixture date, so keep these calls adjacent: setup between
    // them can create enough clock skew to reverse the fork order.
    hostClock = pinHostClock()
    await pinBrowserClock(page)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      hostClock?.mockRestore()
    }
  })

  it.skipIf(MODE === 'record')('enables branch only on the completed transcript tail', async () => {
    onTestFailed(() => saveFailureShot(page, 'screenshots/non-migrating-session-reads/web-e2e-message-actions'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(MID_TURN_TEXT, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(
      () => page.getByRole('button', { name: 'System prompt', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(0)

    // Focus-reveal the footers (hover:hover keeps them opacity-hidden until
    // hover/focus-within). Branch renders only under assistant answers — user
    // bubbles carry none — and only a completed transcript tail enables it.
    const copyButtons = page.getByRole('button', { name: 'Copy' })
    await expect.poll(() => copyButtons.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(4)
    await copyButtons.first().focus()
    const branchButtons = page.getByRole('button', { name: 'Branch into a new conversation' })
    await expect.poll(() => branchButtons.count(), { timeout: 5_000 }).toBe(3)
    await expect.poll(
      () => branchButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-disabled'))),
      { timeout: 5_000 },
    ).toEqual(['true', null, null])
    await branchButtons.first().press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect.poll(() => page.getByRole('tooltip').allTextContents(), { timeout: 5_000 })
      .toEqual(['Available only on the last message of a completed turn'])
    await expect.poll(() => page.getByRole('button', { name: 'Edit' }).count(), { timeout: 5_000 }).toBe(0)
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps an action tooltip above the sticky composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-action-tooltip-layer'))
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    await page.mouse.move(0, 0)
    const copy = page.getByRole('button', { name: 'Copy', exact: true }).last()
    const composer = page.locator('[data-composer-seat]')
    const tooltip = page.getByRole('tooltip', { name: 'Copy', exact: true })
    const originalViewport = page.viewportSize()
    if (originalViewport === null) throw new Error('tooltip probe requires a fixed viewport')
    try {
      await page.setViewportSize({ width: originalViewport.width, height: 600 })
      // Grow the sticky seat upward so the bottom tooltip overlaps it without
      // depending on the fixture's resting composer height.
      await composer.evaluate((element) => { element.style.paddingTop = '48px' })
      await copy.evaluate((button) => {
        const scrollport = button.closest<HTMLElement>('[data-conversation-scroll]')
        const composer = scrollport?.querySelector<HTMLElement>('[data-composer-seat]') ?? null
        if (scrollport === null || composer === null) throw new Error('conversation geometry is unavailable')
        const buttonRect = button.getBoundingClientRect()
        const composerTop = composer.getBoundingClientRect().top
        scrollport.scrollTop += buttonRect.bottom - (composerTop - 8)
      })
      await copy.hover()
      await tooltip.waitFor({ state: 'visible', timeout: 5_000 })
      // Tooltip is intentionally pointer-transparent. Enable hit testing only
      // for this stacking probe; paint order is unchanged.
      await tooltip.evaluate((element) => { element.style.pointerEvents = 'auto' })
      const probe = await tooltip.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const composer = document.querySelector<HTMLElement>('[data-composer-seat]')
        if (composer === null) throw new Error('composer geometry is unavailable')
        const composerRect = composer.getBoundingClientRect()
        const hit = document.elementFromPoint(x, y)
        return {
          insideComposer: composerRect.top <= y && y <= composerRect.bottom,
          hitsTooltip: hit !== null && element.contains(hit),
        }
      })
      expect(probe.insideComposer).toBe(true)
      expect(probe.hitsTooltip).toBe(true)
    } finally {
      if (await tooltip.count() > 0) {
        await tooltip.evaluate((element) => { element.style.removeProperty('pointer-events') })
      }
      if (await composer.count() > 0) {
        await composer.evaluate((element) => { element.style.removeProperty('padding-top') })
      }
      await page.mouse.move(0, 0)
      if (await copy.count() > 0) await copy.evaluate((element) => { element.blur() })
      if (await tooltip.count() > 0) await tooltip.waitFor({ state: 'hidden', timeout: 5_000 })
      await page.setViewportSize(originalViewport)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the conversation aria golden with IconActions and clocks', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions-aria'))
    await page.getByRole('button', { name: /^Select model, current/ })
      .waitFor({ timeout: 10_000 })
    await page.getByText(/Cache hit \d+%/u).first().waitFor({ timeout: 10_000 })
    await page.mouse.move(0, 0)
    // The golden includes the keyboard-focused action and its visible tooltip.
    const copy = page.getByRole('button', { name: 'Copy', exact: true }).first()
    await copy.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await page.getByRole('tooltip', { name: 'Copy', exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('persists performance detail and hides statistics in Compact', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-performance-usage'))
    const stats = page.locator('[data-composer-stat]')
    const statsText = async (): Promise<string> => (await stats.allTextContents()).join(' ')
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const row = dialog.getByText('Performance & usage', { exact: true }).locator('../..')
    await row.getByRole('button', { name: 'Detailed', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Compact', exact: true }).click()
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'ui-chat')?.value).toMatchObject({ performanceUsage: 'compact' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => stats.locator('button').count()).toBe(0)
    expect(await statsText()).not.toContain('turns')
    expect(await statsText()).toContain('Cache hit')
    await stats.first().hover()
    expect(await page.getByRole('dialog').count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'compact.expected.md'), await captureStableAria(page, '[data-composer-dock]', scaffold.workspaceCwd), MODE)
    const warningStart = tripwire.warnings.length
    await page.reload()
    await openSettings(page, 'en')
    await row.getByRole('button', { name: 'Compact', exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await row.getByRole('button', { name: 'Compact', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Detailed', exact: true }).click()
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'ui-chat')?.value).toMatchObject({ performanceUsage: 'detailed' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => stats.locator('button').count()).toBe(2)
    expect(await page.locator('[data-turn-tail]').getByRole('button', { name: /Ran for/ }).count()).toBe(0)
  })

  it.skipIf(MODE === 'record')('forks through the settled-message and session-row actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-fork'))
    // The second answer is followed by another completed user turn in the source.
    const existing = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    await page.getByRole('button', { name: 'Branch into a new conversation' }).nth(1).click()
    await expect.poll(
      () => scaffold.ctx.agents.list().find(agent => !existing.has(agent.id)),
      { timeout: 15_000 },
    ).toBeDefined()
    const child = scaffold.ctx.agents.list().find(agent =>
      !existing.has(agent.id))!
    expect(child.session.header.parentSession).toBeUndefined()
    expect(child.inbox.nextTurn).toEqual([])
    expect(child.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.content.some(part =>
        part.type === 'text' && part.text === NEXT_PROMPT)))).toBe(false)
    await expect.poll(
      () => page.locator('[role="treeitem"]').count(),
      { timeout: 10_000 },
    ).toBe(3)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').textContent(),
      { timeout: 10_000 },
    ).toContain('Use the read tool twice (1)')
    // The row action owns a distinct ui-workspace injection from the message
    // action above, so exercise both through the loaded app before capture.
    const sourceRow = page.locator('[role="treeitem"][aria-selected="true"]')
    const rowBox = await sourceRow.boundingBox()
    if (rowBox === null) throw new Error('fork source row has no layout box')
    const actionButton = sourceRow.locator('button[aria-label^="Session actions for "]')
    await sourceRow.hover({ position: { x: rowBox.width - 16, y: rowBox.height / 2 } })
    await expect.poll(() => actionButton.isVisible(), { timeout: 2_000 }).toBe(true)
    const buttonBox = await actionButton.boundingBox()
    if (buttonBox === null) throw new Error('fork source row action has no layout box')
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
    const beforeNested = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    await page.getByRole('menuitem', { name: 'Fork session' }).click()
    await expect.poll(
      () => scaffold.ctx.agents.list().filter(agent => !beforeNested.has(agent.id)).length,
      { timeout: 15_000 },
    ).toBe(1)
    expect(scaffold.ctx.agents.list().find(agent => !beforeNested.has(agent.id))!.session.header.parentSession).toBeUndefined()
    await expect.poll(
      () => page.locator('[role="treeitem"]').count(),
      { timeout: 10_000 },
    ).toBe(4)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    // The child row is published before its inherited title rename settles;
    // wait for that second RPC projection before freezing the ARIA tree.
    await expect.poll(
      () => page.locator('[role="treeitem"]').allTextContents(),
      { timeout: 10_000 },
    ).toEqual(expect.arrayContaining([expect.stringContaining('Use the read tool twice (2)')]))
    expect(await sourceRow.textContent()).toContain('Use the read tool twice (1)')
    const tree = await captureStableAria(
      page,
      '[role="tree"][aria-label="Sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(FORK_EXPECTED, tree, MODE)
  })

  it.skipIf(MODE === 'record')('forks an unopened current-format Session from its sidebar row', async () => {
    onTestFailed(() => saveFailureShot(page, 'screenshots/non-migrating-session-reads/current-cold-fork'))
    const id = SessionId('message-actions-current-cold')
    await seedSession(scaffold, completedTailFixture(await readFile(SEED, 'utf8')), id)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    const row = page.locator(`[data-row-key="session:${id}"]`)
    await row.waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    await row.hover()
    await row.locator('button[aria-label^="Session actions for "]').click()
    const existing = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    await page.getByRole('menuitem', { name: 'Fork session', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agents.list().some(agent => !existing.has(agent.id))).toBe(true)
    expect(scaffold.ctx.agents.list().find(agent => !existing.has(agent.id))!.session.header.parentSession).toBeUndefined()
    expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    expect(await row.getAttribute('aria-selected')).not.toBe('true')
  })

  it.skipIf(MODE === 'record')('guides only a migration-required sidebar fork to opening its source', async () => {
    onTestFailed(() => saveFailureShot(page, 'screenshots/non-migrating-session-reads/migration-required-fork'))
    const id = SessionId('message-actions-needs-migration')
    const [header, ...events] = realizeSeedFixture(scaffold, await readFile(SEED, 'utf8'), id).trimEnd().split('\n')
      .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
    expect(header?.version).toBe(3)
    const projects = (await readdir(scaffold.persistenceRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
    expect(projects).toHaveLength(1)
    const directory = join(scaffold.persistenceRoot, projects[0]!.name, id)
    const predecessor = join(directory, 'session.v3.jsonl.zstd')
    const createdAt = WEB_FIXTURE_TIME - 90_000
    const rows = [{ ...header, id, cwd: scaffold.workspaceCwd, createdAt },
      ...events.map((event, seq) => ({ ...event, seq, time: createdAt + seq + 1 }))]
    const source = Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))))
    await mkdir(directory, { recursive: true })
    await writeFile(predecessor, source)
    await expect(scaffold.ctx.sessionPersistence.stat(id)).resolves.toMatchObject({ formatStatus: 'migration-required' })

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: /^Show \d+ more sessions$/ }).click()
    const row = page.locator(`[data-row-key="session:${id}"]`)
    await row.waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const forkRequests: string[] = []
    const trackFork = (request: BrowserRequest): void => {
      const path = new URL(request.url()).pathname
      if (path === '/api/session/fork') forkRequests.push(path)
    }
    page.on('request', trackFork)
    const existing = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    try {
      await row.hover()
      await row.locator('button[aria-label^="Session actions for "]').click()
      await page.getByRole('menuitem', { name: 'Fork session', exact: true }).click()
      const notice = page.getByRole('alert').filter({ hasText: 'Open the original session to complete migration before creating a branch.' })
      await notice.waitFor()
      expect(await page.getByRole('menuitem', { name: 'Fork session', exact: true }).count()).toBe(0)
      expect(forkRequests).toEqual(['/api/session/fork'])
      expect(scaffold.ctx.agents.get(id)).toBeUndefined()
      expect(await readdir(directory)).toEqual(['session.v3.jsonl.zstd'])
      expect(await readFile(predecessor)).toEqual(source)
      await compareOrRefreshGolden(UNOPENED_FORK_EXPECTED,
        await captureStableAria(page, '[role="alert"]', scaffold.workspaceCwd), MODE)
      await notice.getByRole('button', { name: 'Open original session', exact: true }).click()
      await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => scaffold.ctx.agents.get(id)).toBeDefined()
      await expect(scaffold.ctx.sessionPersistence.stat(id)).resolves.toMatchObject({ formatStatus: 'current' })
      expect(await readdir(directory)).toContain(`session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`)
      expect(await readFile(predecessor)).toEqual(source)
      expect(forkRequests).toEqual(['/api/session/fork'])
      expect(scaffold.ctx.agents.list().filter(agent => !existing.has(agent.id) && agent.id !== id)).toEqual([])
    } finally {
      page.off('request', trackFork)
    }
  })

  it.skipIf(MODE === 'record')('rewinds historical prompts inline: delete, then edit back into the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-rewind'))
    const id = SessionId('message-actions-rewind')
    await seedSession(scaffold, completedTailFixture(await readFile(SEED, 'utf8')), id)
    const storedPrompts = async (): Promise<string[]> => {
      const handle = await scaffold.ctx.sessionPersistence.open(id, 'read')
      try {
        return (await handle.read()).events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
          ? [event.data.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')]
          : [])
      } finally {
        await handle.close()
      }
    }
    expect(await storedPrompts()).toEqual([PROMPT, SECOND_PROMPT, NEXT_PROMPT])
    /** Open the seeded Session from the sidebar, expanding its group and list as needed. */
    const openSession = async (target: Page) => {
      const group = target.getByRole('treeitem', { name: 'Ungrouped' })
      await group.waitFor()
      if (await group.getAttribute('aria-expanded') === 'false') await group.click()
      const row = target.locator(`[data-row-key="session:${id}"]`)
      const more = target.getByRole('button', { name: /^Show \d+ more sessions$/ })
      await Promise.race([row.waitFor(), more.waitFor()])
      if (!await row.isVisible()) await more.click()
      await row.click()
    }
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await openSession(page)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('ORIGINAL ONLY', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    // A second window on the same Session follows the rewind live.
    const watcher = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(watcher, 'web-e2e-message-rewind-watcher'))
    await pinBrowserClock(watcher)
    await watcher.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await watcher.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSession(watcher)
    await expect.poll(() => watcher.getByText('ORIGINAL ONLY', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    // Surviving rows must stay the same DOM nodes: a trim removes only what follows the cut.
    const markKept = (target: Page) => target.evaluate(() => {
      const kept = document.querySelector<HTMLElement & { rewindKept?: true }>('[data-prompt-rewind]')
      if (kept !== null) kept.rewindKept = true
    })
    const stillKept = (target: Page) => target.evaluate(() =>
      (document.querySelector<HTMLElement & { rewindKept?: true }>('[data-prompt-rewind]'))?.rewindKept === true)
    await markKept(page)
    await markKept(watcher)
    const historyReads: string[] = []
    const recordRead = (request: BrowserRequest) => {
      if (/\/api\/session\/(page|follow)\b/.test(request.url())) historyReads.push(request.url())
    }
    page.on('request', recordRead)
    watcher.on('request', recordRead)

    // Deleting the last prompt asks inline, in place of its clock and icons, before changing anything.
    const last = page.locator('[data-prompt-rewind]').filter({ hasText: NEXT_PROMPT })
    await last.hover()
    await last.getByRole('button', { name: 'Delete', exact: true }).click()
    const confirmation = last.locator('[data-prompt-rewind-confirm="delete"]')
    await confirmation.waitFor()
    expect(await storedPrompts()).toEqual([PROMPT, SECOND_PROMPT, NEXT_PROMPT])
    await page.mouse.move(0, 0)
    await compareOrRefreshGolden(REWIND_CONFIRM_EXPECTED,
      await captureStableAria(page, '[data-prompt-rewind-confirm]', scaffold.workspaceCwd), MODE)
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(storedPrompts, { timeout: 15_000 }).toEqual([PROMPT, SECOND_PROMPT])
    await expect.poll(() => page.getByText('ORIGINAL ONLY', { exact: true }).count(), { timeout: 15_000 }).toBe(0)
    await expect.poll(() => watcher.getByText('ORIGINAL ONLY', { exact: true }).count(), { timeout: 15_000 }).toBe(0)
    expect(await watcher.getByText(SECOND_PROMPT, { exact: true }).count()).toBe(1)
    expect([await stillKept(page), await stillKept(watcher)]).toEqual([true, true])
    expect(historyReads).toEqual([])
    page.off('request', recordRead)
    await watcher.close()

    // Editing the second prompt removes its turn and returns its text to the composer.
    const second = page.locator('[data-prompt-rewind]').filter({ hasText: SECOND_PROMPT })
    await second.hover()
    await second.getByRole('button', { name: 'Edit', exact: true }).click()
    await second.locator('[data-prompt-rewind-confirm="edit"]').getByRole('button', { name: 'Edit', exact: true }).click()
    await expect.poll(storedPrompts, { timeout: 15_000 }).toEqual([PROMPT])
    const composer = page.getByRole('textbox', { name: /^Message or run a task/ })
    await expect.poll(() => composer.textContent(), { timeout: 15_000 }).toBe(SECOND_PROMPT)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(0)
    await page.mouse.move(0, 0)
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    await page.getByText(/Cache hit \d+%/u).first().waitFor({ timeout: 10_000 })
    await compareOrRefreshGolden(REWIND_EXPECTED, (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(id).join('{{seededId}}'), MODE)
    expect(tripwire.pageErrors).toEqual([])
  })
  it.skipIf(MODE === 'record')('issued zero model calls and kept a closed inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'compact.expected.md', 'fork.expected.md', 'fork-unopened.expected.md',
      'rewind-confirm.expected.md', 'rewind.expected.md', 'ui.expected.md',
    ])
  })
})
