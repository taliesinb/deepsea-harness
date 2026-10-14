// @vitest-environment jsdom
/**
 * A command this browser runs in a New Session engages it: command rows alone
 * keep a Session blank (the hero hides them), so Chat converts the Session as
 * an accepted first prompt would when the command's row is visible. Hidden
 * rows, started Sessions, unbound Sessions, and command rows this browser did
 * not run leave the upstream New Session behavior untouched.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISession, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  apply as applyConversation, inject as injectConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyChat, inject as injectChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'
import { isVisibleChatCommand } from '../src/client/contract/chat-visibility.ts'

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-new' as SessionId
const STARTED = 'session-started' as SessionId
const UNBOUND = 'session-unbound' as SessionId
const ACK = 'Feedback recorded for session session-new.'

/** jsdom has no ResizeObserver; the composer seat and Chat measure through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom has no font-loading events; the composer's control row listens for them.
const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})

function event(seq: number, type: string, data: unknown): SessionEventLikeEntry {
  return { type: 'event', event: { seq, time: 1_700_000_000_000 + seq, type, data } as unknown as SessionEvent }
}

/** The durable lifecycle pair the Host records for `/feedback …` in a fresh Session. */
const FEEDBACK_ROWS = [
  event(0, 'command/run', { commandId: 'cmd-1', name: 'feedback', args: ' unreadable', source: { kind: 'user' } }),
  event(1, 'command/done', { commandId: 'cmd-1', kind: 'success', text: ACK }),
]

function AppRoot({ renderSlot }: PropsRenderSlots<'main'>) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const chatSettings = stubConfigForm<ChatSettings>()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (namespace: string) => namespace === CHAT_SETTINGS_NAMESPACE ? chatSettings.scope : stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
  runtime.ctx.provide('sidebarRightTabs', {
    register: vi.fn(() => () => {}),
    get: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
  } as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  let main: ReturnType<typeof runtime.sessions.retain> | undefined
  const openSession = (id: SessionId): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    main?.release()
    main = next
  }
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      openSession(SID)
    }),
    openSession,
  } as never)
  runtime.remote.provideNamespaces({
    session: { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })) },
  })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)

  const engage = vi.fn<ISession['engage']>()
  await runtime.sessions.add({
    id: SID,
    summary: { title: '', displayTitle: 'proj', cwd: '/proj', blank: true },
    snapshot: { blank: true },
    events: FEEDBACK_ROWS,
    session: { engage },
  })
  const engageStarted = vi.fn<ISession['engage']>()
  await runtime.sessions.add({ id: STARTED, summary: { title: 'S', displayTitle: 'S' }, session: { engage: engageStarted } })
  const engageUnbound = vi.fn<ISession['engage']>()
  await runtime.sessions.add({ id: UNBOUND, summary: { blank: true }, snapshot: { blank: true }, session: { engage: engageUnbound } })
  openSession(SID)
  runtime.sessions.retain(STARTED, { source: 'testView' })

  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.approval.detail': { kind: 'single', scope: 'session' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  return { runtime, engage, engageStarted, engageUnbound }
}

describe('commands run in a New Session', () => {
  it('shows the command row once this browser ran the command, instead of keeping the hero', async () => {
    const b = await bench()
    const view = b.runtime.renderRoot()
    await b.runtime.flush()
    // Upstream: command rows alone keep the Session blank; the hero hides them.
    expect(view.container.querySelector('[data-phase="hero"]')).not.toBeNull()
    expect(view.queryByText(ACK, { exact: false })).toBeNull()

    b.runtime.ctx.emit('command/executed', SID, 'feedback', { kind: 'success', text: ACK })
    expect(b.engage).toHaveBeenCalledTimes(1)
    // The Session Controller's conversion (its own spec covers it): engage clears blank.
    await b.runtime.sessions.updateSessionSnapshot(SID, (draft) => { draft.blank = false })

    expect(view.container.querySelector('[data-phase="hero"]')).toBeNull()
    expect(await view.findByText(ACK, { exact: false })).toBeTruthy()
  })

  it('engages for an error result too: its row is visible', async () => {
    const b = await bench()
    b.runtime.ctx.emit('command/executed', SID, 'compact', { kind: 'error', text: 'nothing to compact' })
    expect(b.engage).toHaveBeenCalledTimes(1)
  })

  it('leaves the New Session state alone for hidden rows, started Sessions, and unbound Sessions', async () => {
    const b = await bench()
    const view = b.runtime.renderRoot()
    await b.runtime.flush()
    expect(isVisibleChatCommand('permission')).toBe(false)
    b.runtime.ctx.emit('command/executed', SID, 'permission', { kind: 'success', text: 'preset workspace-write' })
    b.runtime.ctx.emit('command/executed', STARTED, 'feedback', { kind: 'success', text: ACK })
    b.runtime.ctx.emit('command/executed', UNBOUND, 'feedback', { kind: 'success', text: ACK })
    b.runtime.ctx.emit('command/executed', 'session-missing' as SessionId, 'feedback', { kind: 'success', text: ACK })
    await b.runtime.flush()

    expect(b.engage).not.toHaveBeenCalled()
    expect(b.engageStarted).not.toHaveBeenCalled()
    expect(b.engageUnbound).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-phase="hero"]')).not.toBeNull()
  })
})
