// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
  defaultEffort: 'high',
}
const groups: ModelDirectoryState['groups'] = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek 4 Flash', reasoning },
    { id: 'deepseek-v4-pro', name: 'DeepSeek 4 Pro', reasoning },
  ],
}, {
  id: 'anthropic-oauth',
  name: 'Anthropic Plan',
  auth: 'subscription',
  models: [{ id: 'opus', name: 'Claude Opus 5.5' }],
}]
const entry = (model: string, reasoningEffort: string): ModelSelection => ({ provider: 'deepseek-official', model, reasoningEffort })

function state(overrides: Partial<ModelDirectoryState>): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups,
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    recent: [],
    ...overrides,
  }
}

function mount(overrides: Partial<ModelDirectoryState>) {
  const directory = createSnapshotStore(state(overrides))
  const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: /^Select model/ }))
  return { directory, select }
}

afterEach(cleanup)

describe('ModelSelect recent selections', () => {
  it('lists up to four catalogued selections other than the one in use, naming only non-default efforts', async () => {
    const { select } = mount({
      recent: [
        entry('deepseek-v4-flash', 'max'),
        entry('deepseek-v4-flash', 'high'),
        { provider: 'anthropic-oauth', model: 'opus' },
        { provider: 'removed', model: 'gone' },
        entry('deepseek-v4-pro', 'high'),
        entry('deepseek-v4-pro', 'off'),
        entry('deepseek-v4-pro', 'max'),
      ],
    })
    expect(screen.getByRole('separator')).toBeTruthy()
    const recent = screen.getByRole('group', { name: 'Recent models' })
    const rows = [...recent.querySelectorAll('[role="menuitem"]')]
    expect(rows.map(row => row.textContent)).toEqual([
      'DeepSeek 4 Flash - Max',
      'Claude Opus 5.5',
      'DeepSeek 4 Pro',
      'DeepSeek 4 Pro - Off',
    ])
    // Each row carries its route's glyph: the plan shield, the API code frame.
    expect(rows[1]!.querySelector('path[d^="M10 1.8"]')).not.toBeNull()
    expect(rows[2]!.querySelector('rect[x="1.8"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek 4 Pro' }))
    await waitFor(() => { expect(select).toHaveBeenCalledWith(entry('deepseek-v4-pro', 'high')) })
  })

  it('switches effort on the model in use from a recent row, and walks the rows with the arrows', async () => {
    const { select } = mount({ recent: [entry('deepseek-v4-flash', 'max')] })
    const row = screen.getByRole('menuitem', { name: 'DeepSeek 4 Flash - Max' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(row)
    fireEvent.click(row)
    await waitFor(() => { expect(select).toHaveBeenCalledWith(entry('deepseek-v4-flash', 'max')) })
  })

  it('shows no divider when the only recent selection is the one in use', () => {
    mount({ recent: [entry('deepseek-v4-flash', 'high')] })
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Recent models' })).toBeNull()
  })

  it('spins on the recent row whose selection is pending', () => {
    mount({ recent: [entry('deepseek-v4-pro', 'max')], pending: entry('deepseek-v4-pro', 'max') })
    const row = screen.getByRole('menuitem', { name: 'DeepSeek 4 Pro - Max' })
    expect(row.hasAttribute('disabled')).toBe(true)
    expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: /^Model/ }).querySelector('[data-state="ongoing"]')).toBeNull()
  })
})
