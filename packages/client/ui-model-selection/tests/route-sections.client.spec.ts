import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it } from 'vitest'
import {
  hasCapability, modelRoute, modelSections, routeTitle, splittingFilters, supersededModels,
} from '../src/client/route-sections.ts'

const named = (...names: string[]): ModelCatalogModel[] => names.map(name => ({ id: name, name }))
const superseded = (...names: string[]): string[] => [...supersededModels(named(...names))]

describe('model routes', () => {
  it('classifies routes by billing metadata, never by id or name', () => {
    expect(modelRoute({ auth: 'subscription', catalogProvider: 'anthropic' })).toBe('plan')
    expect(modelRoute({ auth: 'api-key', catalogProvider: 'anthropic' })).toBe('api')
    expect(modelRoute({ auth: 'api-key', catalogProvider: 'openrouter' })).toBe('openrouter')
    expect(modelRoute({ auth: 'local' })).toBe('local')
    // No metadata: a keyed route, whatever it is called.
    expect(modelRoute({})).toBe('api')
    const misleading: ModelProviderGroup = { id: 'openrouter-oauth', name: 'Local Plan OpenRouter', models: [] }
    expect(modelRoute(misleading)).toBe('api')
  })

  it('titles a route by its configured name, else by its catalog provider', () => {
    expect(routeTitle({ id: 'anthropic-oauth', name: 'Anthropic Plan', vendor: 'Anthropic' })).toBe('Anthropic Plan')
    expect(routeTitle({ id: 'anthropic', name: 'anthropic', vendor: 'Anthropic' })).toBe('Anthropic')
    expect(routeTitle({ id: 'gateway', name: 'gateway' })).toBe('gateway')
  })
})

describe('model sections', () => {
  const group = (id: string, name: string, route: Partial<ModelProviderGroup> = {}, models = named(`${id}-model`)): ModelProviderGroup =>
    ({ id, name, models, ...route })
  const router = (id = 'openrouter', name = 'openrouter') => group(id, name, { auth: 'api-key', catalogProvider: 'openrouter', vendor: 'OpenRouter' }, [
    { id: 'anthropic/claude-opus-4.5', name: 'Anthropic: Claude Opus 4.5' },
    { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest' },
    { id: 'meta-llama/llama-3', name: 'Meta: Llama 3' },
    { id: 'meta/muse', name: 'Meta: Muse' },
    { id: 'mistralai/saba', name: 'Mistral: Saba' },
    { id: 'mistralai/mistral-large', name: 'Mistral Large' },
    { id: 'openai/gpt-5', name: 'OpenAI: GPT-5' },
    { id: 'deepseek/v4', name: 'DeepSeek: V4' },
    { id: 'openrouter/auto', name: 'Auto Router' },
    { id: 'auto', name: 'Auto' },
  ])
  const catalog = [
    group('lmstudio', 'LM Studio', { auth: 'local' }),
    router(),
    group('openai-codex-oauth', 'OpenAI Codex Plan', { auth: 'subscription', catalogProvider: 'openai-codex', vendor: 'OpenAI Codex' }),
    group('anthropic', 'anthropic', { auth: 'api-key', catalogProvider: 'anthropic', vendor: 'Anthropic' }),
    group('empty', 'Empty', {}, []),
    group('deepseek-official', 'DeepSeek'),
    group('anthropic-oauth', 'Anthropic Plan', { auth: 'subscription', catalogProvider: 'anthropic', vendor: 'Anthropic' }),
  ]

  it('keeps each provider together: plan, API key, then its OpenRouter vendor; local next; other vendors last', () => {
    expect(modelSections(catalog).map(section => [section.route, section.title, section.provider])).toEqual([
      ['api', 'DeepSeek', 'deepseek-official'],
      ['openrouter', 'DeepSeek', 'openrouter'],
      ['plan', 'OpenAI Codex Plan', 'openai-codex-oauth'],
      ['openrouter', 'OpenAI', 'openrouter'],
      ['plan', 'Anthropic Plan', 'anthropic-oauth'],
      ['api', 'Anthropic', 'anthropic'],
      ['openrouter', 'Anthropic', 'openrouter'],
      ['local', 'LM Studio', 'lmstudio'],
      ['openrouter', 'Meta', 'openrouter'],
      ['openrouter', 'Mistral', 'openrouter'],
      ['openrouter', 'OpenRouter', 'openrouter'],
    ])
  })

  it('splits OpenRouter by vendor slug, titled by the name prefix, and strips the prefix from the rows', () => {
    const sections = modelSections([router()])
    const rows = (title: string) => sections.find(section => section.title === title)?.models.map(model => [model.id, model.name])
    expect(rows('Anthropic')).toEqual([
      ['anthropic/claude-opus-4.5', 'Claude Opus 4.5'], ['~anthropic/claude-opus-latest', 'Claude Opus Latest'],
    ])
    expect(rows('Meta')).toEqual([['meta-llama/llama-3', 'Llama 3'], ['meta/muse', 'Muse']])
    expect(rows('Mistral')).toEqual([['mistralai/saba', 'Saba'], ['mistralai/mistral-large', 'Mistral Large']])
    expect(rows('OpenRouter')).toEqual([['openrouter/auto', 'Auto Router'], ['auto', 'Auto']])
    expect(new Set(sections.map(section => section.key)).size).toBe(sections.length)
  })

  it('names the route beside the vendor when two OpenRouter routes offer it', () => {
    const titles = modelSections([router(), router('openrouter-oauth', 'OpenRouter OAuth')]).map(section => section.title)
    expect(titles).toContain('Anthropic \u00b7 OpenRouter')
    expect(titles).toContain('Anthropic \u00b7 OpenRouter OAuth')
  })

  it('takes a localized title for a route', () => {
    const titles = modelSections([group('deepseek-account', 'DeepSeek Account'), group('deepseek-official', 'DeepSeek')],
      entry => entry.id === 'deepseek-account' ? 'DeepSeek \u8d26\u53f7' : routeTitle(entry)).map(section => section.title)
    expect(titles).toEqual(['DeepSeek \u8d26\u53f7', 'DeepSeek'])
  })
})

describe('model capabilities', () => {
  const model = (id: string, capabilities?: ModelCatalogModel['capabilities']): ModelCatalogModel =>
    ({ id, name: id, ...capabilities === undefined ? {} : { capabilities } })

  it('reads published flags only; a Host without them offers nothing to filter', () => {
    expect(hasCapability(model('a', { images: true, reasoning: false, tools: true, free: false }), 'images')).toBe(true)
    expect(hasCapability(model('a', { images: true, reasoning: false, tools: true, free: false }), 'reasoning')).toBe(false)
    expect(hasCapability(model('legacy'), 'tools')).toBe(false)
  })

  it('offers only filters that split the catalog', () => {
    const groups: ModelProviderGroup[] = [
      { id: 'one', name: 'One', models: [model('a', { images: true, reasoning: true, tools: true, free: false })] },
      { id: 'two', name: 'Two', models: [model('b', { images: false, reasoning: true, tools: true, free: true })] },
    ]
    expect(splittingFilters(groups)).toEqual(['images', 'free'])
    expect(splittingFilters([{ models: [model('c')] }])).toEqual([])
  })
})

describe('superseded models', () => {
  it('keeps the newest version of each line', () => {
    expect(superseded(
      'Claude Opus 4.5 (latest)', 'Claude Opus 4.5', 'Claude Opus 4.8', 'Claude Opus 5', 'Claude Opus 5.5',
      'Claude Sonnet 4.6', 'Claude Sonnet 5', 'Claude Haiku 4.5 (latest)', 'Claude Haiku 4.5',
      'Claude Fable 5', 'Claude Fable 5.1',
    )).toEqual([
      'Claude Opus 4.5 (latest)', 'Claude Opus 4.5', 'Claude Opus 4.8', 'Claude Opus 5',
      'Claude Sonnet 4.6', 'Claude Fable 5',
    ])
  })

  it('treats separators, case and a v prefix alike, and keeps variants on their own lines', () => {
    expect(superseded(
      'GPT-5', 'GPT-5.5', 'GPT-5 Mini', 'GPT-5.4 mini', 'GPT-5.4 nano', 'GPT-5.6 Luna', 'GPT-6 Luna',
      'GPT-5 Chat Latest', 'GPT-5.3 Chat (latest)', 'Gemini 2.5 Flash-Lite', 'Gemini 3.5 Flash Lite',
      'DeepSeek V4 Pro', 'DeepSeek V4.1 Flash',
    )).toEqual(['GPT-5', 'GPT-5 Mini', 'GPT-5.6 Luna', 'GPT-5 Chat Latest', 'Gemini 2.5 Flash-Lite'])
  })

  it('supersedes a dated snapshot by its undated model, and leaves names without a version alone', () => {
    expect(superseded('GPT-4o', 'GPT-4o (2024-05-13)', 'GPT-4o mini', 'o3', 'o4-mini', 'Qwen3.8 27B (free)'))
      .toEqual(['GPT-4o (2024-05-13)'])
    expect(superseded('Deep Research Preview (Apr-21-2026)', 'Gemini 2.5 Computer Use Preview 10-2025')).toEqual([])
  })

  it('compares lines within the names given, so OpenRouter vendors stay apart', () => {
    expect(superseded('Anthropic: Claude Opus 4.5', 'Anthropic: Claude Opus 5', 'Other: Claude Opus 6 (free)'))
      .toEqual(['Anthropic: Claude Opus 4.5'])
  })
})
