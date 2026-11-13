import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectDomSnapshot } from '../src/dom/snapshot.js'
import { resolveEmojiProbeWidth } from './helpers/emoji-probe.js'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
let widthOf = (text: string) => [...segmenter.segment(text)].length * 10
const measureText = vi.fn((text: string) => ({
  width: widthOf(text),
  actualBoundingBoxAscent: 8,
  actualBoundingBoxDescent: 2,
  fontBoundingBoxAscent: 8,
  fontBoundingBoxDescent: 2,
}))
const context = {
  font: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText,
} as unknown as CanvasRenderingContext2D
let fontId = 0

function fixture(text: string, spacing = 0): HTMLElement {
  const root = document.body.appendChild(document.createElement('div'))
  root.dataset['sdfBlock'] = ''
  root.textContent = text
  root.style.cssText = `border:0; padding:0; margin:0; font:10px/12px PretextEmoji${fontId++}; color:white; letter-spacing:${spacing}px`
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 30))
  return root
}

beforeEach(() => {
  widthOf = (text) => [...segmenter.segment(text)].length * 10
  measureText.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Pretext emoji clusters', () => {
  it('emits one glyph and one advance per emoji sequence', async () => {
    const snapshot = await collectDomSnapshot(fixture('A👨‍👩‍👧B'), { layoutEngine: 'pretext' })
    expect(snapshot.glyphs).toHaveLength(3)
    expect(snapshot.glyphs.map((glyph) => glyph.advance)).toEqual([10, 10, 10])
  })
  it('applies letter spacing once per sequence', async () => {
    const snapshot = await collectDomSnapshot(fixture('A👨‍👩‍👧B', 2), { layoutEngine: 'pretext' })
    expect(snapshot.glyphs.map((glyph) => glyph.originX)).toEqual([0, 12, 24])
  })
  it('measures pairs at cluster boundaries', async () => {
    await collectDomSnapshot(fixture('A👍🏽B'), { layoutEngine: 'pretext' })
    expect(measureText).toHaveBeenCalledWith('A👍🏽')
    expect(measureText.mock.calls.some(([text]) => text === '🏽' || text === '👍')).toBe(false)
  })
  it('subtracts Pretext emoji width correction when the fallback font is wider on canvas', async () => {
    widthOf = (text) =>
      [...segmenter.segment(text)].reduce(
        (sum, { segment }) => sum + (segment === '😀' ? 14 : 10),
        0,
      )
    const root = fixture('A😀B')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, 0, this.textContent === '😀' ? 10 : 500, 30)
    })
    resolveEmojiProbeWidth(10)
    const snapshot = await collectDomSnapshot(root, { layoutEngine: 'pretext' })
    expect(snapshot.glyphs.map((glyph) => glyph.originX)).toEqual([0, 10, 20])
    expect(snapshot.glyphs[1]!.advance).toBe(10)
  })
})
