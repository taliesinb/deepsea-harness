import { describe, expect, it } from 'vitest'
import { resolveSessionTitleLlmConfig, slugifyTitle } from '../src/index.ts'

const base = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 1000 }

describe('slug style', () => {
  it('slugifies model output: lowercase, hyphens, word cap, no punctuation or quotes', () => {
    expect(slugifyTitle('"Fix Login Redirect"', 5)).toBe('fix-login-redirect')
    expect(slugifyTitle('Explain water, briefly!', 5)).toBe('explain-water-briefly')
    expect(slugifyTitle('one two three four five six seven', 5)).toBe('one-two-three-four-five')
    expect(slugifyTitle('  Café — naïve résumé  ', 5)).toBe('cafe-naive-resume')
    expect(slugifyTitle('!!!', 5)).toBe('')
  })

  it('accepts style in config and rejects unknown values', () => {
    expect(resolveSessionTitleLlmConfig({ ...base, style: 'slug' }).style).toBe('slug')
    expect(resolveSessionTitleLlmConfig(base).style).toBeUndefined()
    expect(() => resolveSessionTitleLlmConfig({ ...base, style: 'weird' as never })).toThrow(/style/u)
  })
})
