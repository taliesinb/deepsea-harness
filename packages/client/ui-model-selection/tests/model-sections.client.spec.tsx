// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'

const t: ComponentProps<typeof ModelSelect>['t'] = key => (en as Record<string, string>)[key] ?? key

const ALL = { images: true, reasoning: true, tools: true, free: false }
const model = (id: string, name = id, capabilities: ModelCatalogModel['capabilities'] = ALL): ModelCatalogModel =>
  ({ id, name, capabilities })

const PLAN: ModelProviderGroup = {
  id: 'anthropic-oauth', name: 'Anthropic Plan', auth: 'subscription', catalogProvider: 'anthropic', vendor: 'Anthropic',
  models: [model('opus-5-5', 'Claude Opus 5.5'), model('opus-4-5', 'Claude Opus 4.5'), model('sonnet-5', 'Claude Sonnet 5')],
}
const ANTHROPIC: ModelProviderGroup = {
  id: 'anthropic', name: 'anthropic', auth: 'api-key', catalogProvider: 'anthropic', vendor: 'Anthropic',
  models: [model('claude-opus-5-5', 'Claude Opus 5.5')],
}
const API: ModelProviderGroup = {
  id: 'deepseek-official', name: 'DeepSeek',
  models: [model('flash', 'DeepSeek Flash', { images: false, reasoning: true, tools: true, free: false })],
}
const ROUTER: ModelProviderGroup = {
  id: 'openrouter', name: 'openrouter', auth: 'api-key', catalogProvider: 'openrouter', vendor: 'OpenRouter',
  models: [
    model('mistralai/mistral-saba', 'Mistral: Saba', { images: false, reasoning: false, tools: true, free: false }),
    model('anthropic/claude-haiku-5', 'Anthropic: Claude Haiku 5', { images: true, reasoning: false, tools: true, free: false }),
    model('vendor/free-one', 'Vendor: Free One', { images: false, reasoning: false, tools: true, free: true }),
    model('openrouter/auto', 'Auto Router', { images: true, reasoning: true, tools: true, free: false }),
  ],
}
const LOCAL: ModelProviderGroup = {
  id: 'lmstudio', name: 'LM Studio', auth: 'local',
  models: [model('qwen', 'Qwen Coder', { images: false, reasoning: false, tools: true, free: true })],
}
const ALL_ROUTES = [LOCAL, ROUTER, API, ANTHROPIC, PLAN]

function state(groups: readonly ModelProviderGroup[], current: ModelDirectoryState['current'] = null): ModelDirectoryState {
  return { current, routable: current !== null, groups, failures: [], status: 'ready', pending: null, error: null, recent: [] }
}

function open(groups: readonly ModelProviderGroup[], current: ModelDirectoryState['current'] = null) {
  const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  render(<ModelSelect locked={false} available directory={createSnapshotStore(state(groups, current))}
    load={vi.fn()} select={select} t={t} />)
  const trigger = screen.getByRole('button', { name: /^Select model/ })
  fireEvent.click(trigger)
  if (current !== null) fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
  return { trigger, select }
}

const rows = (): string[] => screen.getAllByRole('menuitemradio').map(row => row.textContent ?? '')
const filter = (name: string): HTMLElement => screen.getByRole('button', { name })

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

afterEach(cleanup)

const groups = (): string[] => [...document.querySelectorAll('[data-menu-group-heading]')].map(heading => heading.textContent ?? '')
const glyphs = (): (string | null | undefined)[] => [...document.querySelectorAll('[data-menu-group-heading] path')].map(path => path.getAttribute('d')?.slice(0, 8))

describe('ModelSelect route sections', () => {
  it('sections the menu by provider and access kind, splitting OpenRouter by vendor', () => {
    open(ALL_ROUTES)
    // DeepSeek first; a provider's plan, API key and OpenRouter vendor together; this machine's servers;
    // the vendors only OpenRouter offers, alphabetically; then OpenRouter models without a vendor.
    expect(groups()).toEqual(['DeepSeek', 'Anthropic Plan', 'Anthropic', 'Anthropic', 'LM Studio', 'Mistral', 'Vendor', 'OpenRouter'])
    expect(document.querySelectorAll('[data-menu-group-heading] svg')).toHaveLength(8)
    expect(glyphs()[1]).toBe('M10 1.8 ')
    // An OpenRouter vendor's rows lose the `Vendor: ` prefix.
    expect(rows()).toEqual(['DeepSeek Flash', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Opus 5.5', 'Claude Haiku 5', 'Qwen Coder', 'Saba', 'Free One', 'Auto Router'])
  })

  it('names the route beside a vendor that two OpenRouter routes offer', () => {
    open([ROUTER, { ...ROUTER, id: 'openrouter-2', name: 'Team Router' }])
    expect(groups()).toContain('Anthropic \u00b7 Team Router')
  })

  it('marks the current route with its glyph on the trigger and the Model cell', () => {
    const { trigger } = open([PLAN, API], { provider: 'anthropic-oauth', model: 'opus-5-5' })
    expect(trigger.querySelector('path[d^="M10 1.8"]')).not.toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: /^Model/ }).querySelector('path[d^="M10 1.8"]')).not.toBeNull()
  })
})

describe('ModelSelect filters', () => {
  it('offers only filters that split the catalog and narrows to models with every pressed capability', () => {
    open(ALL_ROUTES)
    const toolbar = screen.getByRole('toolbar', { name: 'Model filters' })
    expect([...toolbar.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['Plans', 'API keys', 'OpenRouter', 'Local', 'Images', 'Reasoning', 'Free', 'Older models'])
    fireEvent.click(filter('Reasoning'))
    expect(filter('Reasoning').getAttribute('aria-pressed')).toBe('true')
    expect(rows()).toEqual(['DeepSeek Flash', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Opus 5.5', 'Auto Router'])
    fireEvent.click(filter('Images'))
    expect(rows()).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Opus 5.5', 'Auto Router'])
    // Headings follow the rows: no other section is left.
    expect(groups()).toEqual(['Anthropic Plan', 'Anthropic', 'OpenRouter'])
    fireEvent.click(filter('Images'))
    fireEvent.click(filter('Reasoning'))
    fireEvent.click(filter('Free'))
    expect(rows()).toEqual(['Qwen Coder', 'Free One'])
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })

  it('filters by access kind like radio buttons: one kind at a time, the active one clears', () => {
    open(ALL_ROUTES)
    fireEvent.click(filter('Plans'))
    expect(filter('Plans').getAttribute('aria-pressed')).toBe('true')
    expect(groups()).toEqual(['Anthropic Plan'])
    fireEvent.click(filter('OpenRouter'))
    expect(filter('Plans').getAttribute('aria-pressed')).toBe('false')
    expect(groups()).toEqual(['Anthropic', 'Mistral', 'Vendor', 'OpenRouter'])
    fireEvent.click(filter('Images'))
    expect(rows()).toEqual(['Claude Haiku 5', 'Auto Router'])
    fireEvent.click(filter('Images'))
    fireEvent.click(filter('OpenRouter'))
    expect(filter('OpenRouter').getAttribute('aria-pressed')).toBe('false')
    expect(groups()).toHaveLength(8)
  })

  it('offers no kind filters for a catalog of one access kind', () => {
    open([API, { ...API, id: 'custom', name: 'Custom', models: [model('a'), model('b'), model('c'), model('d')] }])
    const toolbar = screen.queryByRole('toolbar')
    expect(toolbar === null ? [] : [...toolbar.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .not.toContain('API keys')
  })

  it('explains each filter in a tooltip at once, on hover and on focus', () => {
    open(ALL_ROUTES)
    fireEvent.mouseEnter(filter('OpenRouter'))
    expect(screen.getByRole('tooltip').textContent).toBe('OpenRouter')
    fireEvent.mouseLeave(filter('OpenRouter'))
    fireEvent.focus(filter('Images'))
    expect(screen.getByRole('tooltip').textContent).toBe('Images')
  })

  it('announces an empty result and keeps search over the filtered rows', () => {
    open(ALL_ROUTES)
    fireEvent.click(filter('Free'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'opus' } })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe(en['search.empty'])
  })

  it('hides superseded models until older models are shown, except the current model', () => {
    open(ALL_ROUTES)
    expect(rows()).not.toContain('Claude Opus 4.5')
    const older = filter('Older models')
    expect(older.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(older)
    expect(older.getAttribute('aria-pressed')).toBe('true')
    expect(rows().slice(1, 4)).toEqual(['Claude Opus 5.5', 'Claude Opus 4.5', 'Claude Sonnet 5'])
    cleanup()

    open(ALL_ROUTES, { provider: 'anthropic-oauth', model: 'opus-4-5' })
    expect(rows()).toContain('Claude Opus 4.5')
    expect(screen.getByRole('menuitemradio', { name: 'Claude Opus 4.5' }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows a catalog small enough to skip search whole, without a filter bar', () => {
    open([PLAN])
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(rows()).toEqual(['Claude Opus 5.5', 'Claude Opus 4.5', 'Claude Sonnet 5'])
  })

  it('offers no filters for a Host that publishes no capabilities', () => {
    const legacy = (id: string): ModelCatalogModel => ({ id, name: id })
    open([{ id: 'legacy', name: 'Legacy', models: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(legacy) }])
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(rows()).toHaveLength(5)
  })
})

it('keeps each route glyph on the one line of its branch', () => {
  // Glyph consumers outside this package locate the glyphs by these lines.
  const source = readFileSync(resolve(import.meta.dirname, '../src/client/ModelSelect.tsx'), 'utf8')
  const body = source.split('function RouteIcon')[1]!
  const openrouter = body.split("if (route === 'openrouter') return ")[1]!.split('\n')
  expect([...openrouter[0]!.matchAll(/ d="([^"]+)"/g)]).toHaveLength(1)
  expect(openrouter[1]).toContain('<rect x="1.8" y="3" width="16.4" height="14" rx="3"')
  expect(body.split("if (route === 'plan') return ")[1]!.split('\n')[0]).toContain('cx="10" cy="7.2" r="2"')
})
