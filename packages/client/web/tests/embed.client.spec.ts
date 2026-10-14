import { embedPresentation, setEmbedPresentation } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEmbedPresentation, parseEmbedPresentation } from '../src/embed.ts'

afterEach(() => {
  setEmbedPresentation(undefined)
})

describe('embed selector', () => {
  it('reads one non-empty embed query parameter, with or without the leading question mark', () => {
    expect(parseEmbedPresentation('?embed=abc')).toEqual({ sessionId: 'abc' })
    expect(parseEmbedPresentation('embed=abc&other=1')).toEqual({ sessionId: 'abc' })
    expect(parseEmbedPresentation('?embed=%20abc%20')).toEqual({ sessionId: 'abc' })
  })

  it('ignores an absent, empty, or repeated selector', () => {
    expect(parseEmbedPresentation('')).toBeUndefined()
    expect(parseEmbedPresentation('?token=x')).toBeUndefined()
    expect(parseEmbedPresentation('?embed=')).toBeUndefined()
    expect(parseEmbedPresentation('?embed=a&embed=b')).toBeUndefined()
  })

  it('publishes the mode to the shared store module before plugins run', () => {
    expect(applyEmbedPresentation('?embed=s1')).toEqual({ sessionId: 's1' })
    expect(embedPresentation()).toEqual({ sessionId: 's1' })
    expect(applyEmbedPresentation('')).toBeUndefined()
    expect(embedPresentation()).toBeUndefined()
  })
})
