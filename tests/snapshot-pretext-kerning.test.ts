import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { collectDomSnapshot } from '../src/dom/snapshot.js'
import { reflowSnapshot } from '../src/text/reflow.js'
import type { GlyphLayout } from '../src/types.js'
import { resolveEmojiProbeWidth } from './helpers/emoji-probe.js'

/** Lone advances of Helvetica Neue Bold at 300 px, as Chrome measured them, and a wide emoji. */
const ADVANCES: Record<string, number> = {
  U: 222.3,
  L: 177.9,
  T: 183.3,
  R: 216.6,
  A: 205.5,
  ' ': 83.4,
  '😀': 360,
}
let kerning: Record<string, number> = {}

// Pretext keeps the first Canvas context it measures with for the whole module, so every test
// shares this stand-in: lone advances from the table, plus the pair kerning Canvas shapes in.
const context = {
  font: '',
  letterSpacing: '0px',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => {
    const characters = Array.from(text)
    let width = 0
    for (const [index, character] of characters.entries()) {
      width += ADVANCES[character] ?? 0
      if (index > 0) width += kerning[characters[index - 1]! + character] ?? 0
    }
    return {
      width,
      actualBoundingBoxAscent: 220,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 285,
      fontBoundingBoxDescent: 55,
    }
  },
} as unknown as CanvasRenderingContext2D
// Pretext caches measurements by font, so each title gets a family of its own.
let fontId = 0
// Layout boxes by element. Any other element is the span Pretext measures an emoji in, which
// the DOM draws 300 px wide.
const boxes = new Map<Element, DOMRect>()

function title(text: string, width = 1750, spacing = -9): HTMLElement {
  const root = document.body.appendChild(document.createElement('section'))
  root.innerHTML = `<h1 data-sdf-block style="border: 0; padding: 0; margin: 0; font: 700 300px/0.92 PretextKern${fontId++}; letter-spacing: ${spacing}px; color: #fff">${text}</h1>`
  boxes.set(root, new DOMRect(0, 0, 1750, 700))
  boxes.set(root.firstElementChild!, new DOMRect(0, 0, width, 700))
  return root
}

const snapshotOf = (root: HTMLElement) =>
  collectDomSnapshot(root, { textSelector: 'h1', bakeSize: 64, layoutEngine: 'pretext' })
const capture = async (root: HTMLElement) => (await snapshotOf(root)).glyphs
const rounded = (glyphs: readonly GlyphLayout[], key: 'originX' | 'advance') =>
  glyphs.map((glyph) => Number(glyph[key].toFixed(1)))

beforeEach(() => {
  kerning = {}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boxes.get(this) ?? new DOMRect(0, 0, this.textContent === '😀' ? 300 : 0, 0)
  })
  resolveEmojiProbeWidth(300)
})
afterEach(() => {
  boxes.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('Pretext capture of kerned pairs', () => {
  it('draws the second letter of a kerned pair where the browser draws it', async () => {
    // Letter-spacing -9 px. The browser draws the T of L-T (-27.6) that much further back,
    // whether GPOS puts the kerning on the L's advance or a legacy `kern` table splits it
    // between both advances and an offset; the R and A after it stay where they were.
    kerning = { LT: -27.6 }
    const glyphs = await capture(title('ULTRA'))
    expect(rounded(glyphs, 'originX')).toEqual([0, 213.3, 354.6, 528.9, 736.5])
    // Each advance reaches the next origin; the last keeps its own width.
    expect(rounded(glyphs, 'advance')).toEqual([213.3, 141.3, 174.3, 207.6, 196.5])
  })

  it('leaves unkerned text where it was', async () => {
    const glyphs = await capture(title('ULTRA'))
    expect(rounded(glyphs, 'originX')).toEqual([0, 213.3, 382.2, 556.5, 764.1])
    expect(rounded(glyphs, 'advance')).toEqual([213.3, 168.9, 174.3, 207.6, 196.5])
  })

  it('reaches across spaces on a line and starts each line without a pair', async () => {
    kerning = { LT: -27.6 }
    const line = await capture(title('LT LT'))
    expect(rounded(line, 'originX')).toEqual([0, 141.3, 390, 531.3])
    expect(rounded(line, 'advance')).toEqual([141.3, 248.7, 141.3, 174.3])

    const wrapped = await capture(title('LT LT', 500))
    expect(wrapped[2]!.lineBottom).toBeLessThan(wrapped[0]!.lineBottom)
    expect(rounded(wrapped, 'originX')).toEqual([0, 141.3, 0, 141.3])
    expect(rounded(wrapped, 'advance')).toEqual([141.3, 174.3, 141.3, 174.3])
  })

  it('reflows back to its captured width without moving a glyph', async () => {
    kerning = { LT: -27.6 }
    const snapshot = await snapshotOf(title('LT LT ULTRA'))
    const reflowed = reflowSnapshot(snapshot, snapshot.width).glyphs
    for (const [index, glyph] of snapshot.glyphs.entries())
      expect(reflowed[index]!.originX).toBeCloseTo(glyph.originX, 6)
  })

  it('keeps the emoji width correction out of the pair kerning', async () => {
    // Canvas draws the emoji 60 px wider than the DOM, which Pretext corrects for.
    kerning = { LT: -27.6 }
    const glyphs = await capture(title('LT😀', 1750, 0))
    expect(rounded(glyphs, 'originX')).toEqual([0, 150.3, 333.6])
    expect(rounded(glyphs, 'advance')).toEqual([150.3, 183.3, 300])
  })
})
