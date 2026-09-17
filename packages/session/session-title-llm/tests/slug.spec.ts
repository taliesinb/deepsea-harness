import { describe, expect, it } from 'vitest'
import { resolveSessionTitleStyle, slugifyTitle, slugTitleInstruction, slugTitleWords } from '../src/index.ts'

describe('slug style', () => {
  it('slugifies model output: lowercase, hyphens, word cap, no punctuation or quotes', () => {
    expect(slugifyTitle('"Fix Login Redirect"', 5)).toBe('fix-login-redirect')
    expect(slugifyTitle('Explain water, briefly!', 5)).toBe('explain-water-briefly')
    expect(slugifyTitle('one two three four five six seven', 5)).toBe('one-two-three-four-five')
    expect(slugifyTitle('  Café — naïve résumé  ', 5)).toBe('cafe-naive-resume')
    expect(slugifyTitle('!!!', 5)).toBe('')
  })

  it('keeps the slug word cap between 2 and 6 and states it in the instruction', () => {
    expect([1, 2, 5, 6, 9].map(slugTitleWords)).toEqual([2, 2, 5, 6, 6])
    expect(slugTitleInstruction(9).join('\n')).toContain('6 or fewer lowercase ASCII words')
  })

  it('accepts natural, slug, or absence and rejects anything else', () => {
    expect(resolveSessionTitleStyle('p', 'slug')).toBe('slug')
    expect(resolveSessionTitleStyle('p', 'natural')).toBe('natural')
    expect(resolveSessionTitleStyle('p', undefined)).toBeUndefined()
    expect(() => resolveSessionTitleStyle('p', 'weird')).toThrow('p: style must be "natural" or "slug"')
  })
})
