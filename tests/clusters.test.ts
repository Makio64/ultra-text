import { describe, expect, it, vi } from 'vitest'
import { glyphClusters, isEmojiCandidate, isEmojiGrapheme } from '../src/dom/clusters.js'

const sequences = [
  '👨‍👩‍👧',
  '👍🏽',
  '🇯🇵',
  '1\uFE0F\u20E3',
  '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  '❤\uFE0F',
  '❤\uFE0E',
  '#\uFE0F\u20E3',
  '1\u20E3',
  '👩🏽‍💻',
]

describe('glyphClusters', () => {
  it.each(sequences)('keeps %s as one emoji cluster', (text) => {
    expect([...glyphClusters(text)]).toEqual([text])
  })
  it('groups regional indicators pairwise', () => {
    expect([...glyphClusters('🇯🇵🇺🇸🇫')]).toEqual(['🇯🇵', '🇺🇸', '🇫'])
  })
  it.each(['e\u0301', 'नमस्ते', 'a\uFE0F', 'a\u20E3', 'x\u200Dy', '\r\n'])(
    'keeps non-emoji %s per code point',
    (text) => {
      expect([...glyphClusters(text)]).toEqual(Array.from(text))
    },
  )
  it('returns hint-free prose without creating a segmenter', () => {
    const spy = vi.spyOn(Intl, 'Segmenter')
    expect(glyphClusters('Plain prose 日 😀')).toBe('Plain prose 日 😀')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('falls back to code points if Segmenter is unavailable, even after first use', () => {
    glyphClusters('👍🏽')
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true })
    try {
      expect([...glyphClusters('👍🏽')]).toEqual(Array.from('👍🏽'))
    } finally {
      Object.defineProperty(Intl, 'Segmenter', descriptor)
    }
  })
  it('matches Pretext emoji detection and the broader colour candidate set', () => {
    for (const text of ['😀', '❤\uFE0F', '👍🏽']) expect(isEmojiGrapheme(text)).toBe(true)
    for (const text of ['❤\uFE0E', 'A']) expect(isEmojiGrapheme(text)).toBe(false)
    for (const text of ['😀', '©', '🇯', '1\u20E3', '❤\uFE0F', '\uFE0F'])
      expect(isEmojiCandidate(text)).toBe(true)
    for (const text of ['A', 'é', '日']) expect(isEmojiCandidate(text)).toBe(false)
  })
})
