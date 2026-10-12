// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { RecentModels } from '../src/client/recent.ts'

const KEY = 'dsh.model-selection.recent.v1'

const groups: readonly ModelProviderGroup[] = [{
  id: 'p',
  name: 'Provider',
  models: [{
    id: 'thinker',
    name: 'Thinker',
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
  }],
}]

afterEach(() => { localStorage.clear() })

describe('RecentModels', () => {
  it('persists the list and reads it back in a later page', () => {
    new RecentModels().record(groups, { provider: 'p', model: 'thinker' })
    expect(new RecentModels().store.getSnapshot()).toEqual([{ provider: 'p', model: 'thinker', reasoningEffort: 'low' }])
  })

  it('drops malformed stored entries and replaces a stored value that is not a list', () => {
    localStorage.setItem(KEY, JSON.stringify([{ provider: 'p', model: 'm' }, { provider: 1 }, null, { provider: 'p', model: 'n', reasoningEffort: 2 }]))
    expect(new RecentModels().store.getSnapshot()).toEqual([{ provider: 'p', model: 'm' }])
    localStorage.setItem(KEY, JSON.stringify({ provider: 'p' }))
    expect(new RecentModels().store.getSnapshot()).toEqual([])
    expect(localStorage.getItem(KEY)).toBe('[]')
  })

  it('keeps uncatalogued efforts as recorded, moves repeats to the front, and keeps eight entries', () => {
    const recent = new RecentModels()
    for (let index = 0; index < 10; index += 1) recent.record(groups, { provider: 'other', model: `m${index}` })
    recent.record(groups, { provider: 'other', model: 'm5' }, null)
    const list = recent.store.getSnapshot()
    expect(list).toHaveLength(8)
    expect(list.slice(0, 3).map(entry => entry.model)).toEqual(['m5', 'm9', 'm8'])
    expect(list[0]).toEqual({ provider: 'other', model: 'm5' })
  })
})
