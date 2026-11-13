import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectDomSnapshot } from '../src/dom/snapshot.js'
import { reflowSnapshot, snapGlyph } from '../src/text/reflow.js'
import type { DomLayoutSnapshot, DomSdfOptions, GlyphLayout } from '../src/types.js'

// `pixelSnap` against stubbed layout. The font is the one of snapshot-baseline.test.ts: ascent
// and descent of 0.987 and 0.213 em, rounded to whole pixels at the size they are asked at.
const ASCENT = 0.987
const DESCENT = 0.213
const boxHeight = (size: number, scale = 1): number =>
  (Math.round(size * scale * ASCENT) + Math.round(size * scale * DESCENT)) / scale

interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function domRect({ left, top, width, height }: Box): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({ left, top, width, height }),
  }
}

/** Layout reads since the last layout was installed: Range and element boxes. */
let reads = 0

/** One Range box per character offset of each text node. */
function installLayout(boxes: ReadonlyMap<Text, readonly (Box | null)[]>): void {
  reads = 0
  const createRange = document.createRange.bind(document)
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => {
        reads++
        const node = range.startContainer
        const box = node instanceof Text ? boxes.get(node)?.[range.startOffset] : null
        return domRect(box ?? { left: 0, top: 0, width: 0, height: 0 })
      },
    })
    return range
  })
}

/** A canvas that measures the font above, rounding at the size it is asked for. */
function installCanvas(): void {
  const context = {
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => {
      const size = Number.parseFloat(/([\d.]+)px/.exec(context.font)![1]!)
      return {
        width: Array.from(text).length * size * 0.5,
        fontBoundingBoxAscent: Math.round(size * ASCENT),
        fontBoundingBoxDescent: Math.round(size * DESCENT),
      }
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
}

const view = document.defaultView!
const realScale = Object.getOwnPropertyDescriptor(view, 'devicePixelRatio')

const deviceScale = (scale: number): void => {
  Object.defineProperty(view, 'devicePixelRatio', { configurable: true, value: scale })
}

/** A browser has a 2D canvas, which jsdom lacks: the capture then settles the layout pixel. */
function browser(scale = 1): void {
  Object.defineProperty(view, 'CanvasRenderingContext2D', { configurable: true, value: vi.fn() })
  deviceScale(scale)
  installCanvas()
}

interface Line {
  /** Client y of the text box top. */
  readonly top: number
  /** Client x of the first glyph origin. */
  readonly left?: number
  readonly size?: number
  readonly text?: string
  readonly advance?: number
}

const ROOT = 400

/**
 * A 400 px root whose top left corner is at `at`, with one block per line. Every position is
 * a client coordinate, as the browser reports it; `scale` is the pixel the layout rounded
 * its font metrics on.
 */
function layout(
  lines: readonly Line[],
  { at = [0, 0] as readonly [number, number], scale = 1, lineHeight = '' } = {},
): HTMLElement {
  const root = document.body.appendChild(document.createElement('section'))
  root.style.cssText = 'font: 20px Lato; color: rgb(0, 0, 0)'
  const rect = (box: Box) => () => (reads++, domRect(box))
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(
    rect({ left: at[0], top: at[1], width: ROOT, height: ROOT }),
  )
  const boxes = new Map<Text, readonly (Box | null)[]>()
  for (const { top, left = at[0] + 10, size = 20, text = 'Hxg', advance = 8 } of lines) {
    const block = root.appendChild(document.createElement('p'))
    block.dataset['sdfBlock'] = ''
    // jsdom reports default border widths; the Pretext engine reads the content box.
    block.style.border = '0'
    block.style.fontSize = `${size}px`
    block.style.lineHeight = lineHeight
    block.textContent = text
    vi.spyOn(block, 'getBoundingClientRect').mockImplementation(
      rect({ left: at[0], top, width: ROOT, height: 60 }),
    )
    boxes.set(
      block.firstChild as Text,
      Array.from(text, (_, offset) => ({
        left: left + offset * advance,
        top,
        width: advance,
        height: boxHeight(size, scale),
      })),
    )
  }
  installLayout(boxes)
  return root
}

/** Options of the synchronous Range capture. */
type RangeOptions = DomSdfOptions & { layoutEngine?: 'range'; textShaping?: 'none'; svg?: false }

const capture = (
  lines: readonly Line[],
  options: Parameters<typeof layout>[1] = {},
  capture: RangeOptions = {},
): DomLayoutSnapshot =>
  collectDomSnapshot(layout(lines, options), {
    includeRootBackground: false,
    pixelSnap: true,
    ...capture,
  })

/** Client y of each glyph's text box top, as the snapshot holds it. */
const tops = (
  snapshot: DomLayoutSnapshot,
  { rootTop = 0, size = 20, scale = 1, pixelsPerUnit = 1 } = {},
): number[] =>
  snapshot.glyphs.map(
    (glyph) => rootTop + ROOT - glyph.lineBottom * pixelsPerUnit - boxHeight(size, scale),
  )

/** Client x of each glyph origin. */
const origins = (snapshot: DomLayoutSnapshot, rootLeft = 0, pixelsPerUnit = 1): number[] =>
  snapshot.glyphs.map((glyph) => rootLeft + glyph.originX * pixelsPerUnit)

function expectClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length)
  for (const [index, value] of actual.entries()) expect(value).toBeCloseTo(expected[index]!, 9)
}

const unsnapped = (glyph: GlyphLayout): GlyphLayout => {
  const { snap, ...rest } = glyph
  return snap
    ? { ...rest, originX: glyph.originX - snap[0], lineBottom: glyph.lineBottom - snap[1] }
    : rest
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  Reflect.deleteProperty(view, 'CanvasRenderingContext2D')
  if (realScale) Object.defineProperty(view, 'devicePixelRatio', realScale)
  else Reflect.deleteProperty(view, 'devicePixelRatio')
})

describe('snapGlyph', () => {
  const place = (
    column: number,
    row: number,
    fontSize = 16,
    grid: readonly [number, number] = [4, 1],
    lean = 0,
  ) => {
    const glyph = { fontSize, originX: 0, lineBottom: 0 } as {
      fontSize: number
      originX: number
      lineBottom: number
      snap?: readonly [number, number]
    }
    snapGlyph(glyph, column, row, grid, lean)
    return glyph
  }

  it('takes the nearest row, a half going down the page', () => {
    // `lineBottom` grows up the page and `row` down it.
    expectClose(
      [10.25, 10.5, 10.75, 11, -30.25, -30.5, -30.75].map((row) => place(0, row).lineBottom),
      [0.25, -0.5, -0.25, 0, -0.25, -0.5, 0.25],
    )
  })

  it('takes the nearest quarter pixel, a half going right', () => {
    // 4 columns to the pixel: 40.4 is 10.1 px, 40.5 the tie between 10 and 10.25 px.
    expectClose(
      [40.4, 40.5, 40.6, 41, -40.4, -40.5, -40.6].map((column) => place(column, 0).originX),
      [-0.1, 0.125, 0.1, 0, 0.1, 0.125, -0.1],
    )
  })

  it('keeps a half a half through float arithmetic', () => {
    // A row or a column the arithmetic left a hair short of its half still goes the half's way.
    expect(place(0, 15.5 - 1e-12).lineBottom).toBeCloseTo(-0.5, 9)
    expect(place(0, 15.5 + 1e-12).lineBottom).toBeCloseTo(-0.5, 9)
    expect(place(40.5 - 1e-12, 0).originX).toBeCloseTo(0.125, 9)
    // Further than float error from the half, it goes the other way.
    expect(place(0, 15.49).lineBottom).toBeCloseTo(0.49, 9)
  })

  it('leaves the origin of a glyph of 162 device pixels per em or more', () => {
    // The grid is quarter device pixels per unit, so a font size times it is four ems of them.
    expect(place(40.4, 0, 161).originX).toBeCloseTo(-0.1, 9)
    expect(place(40.4, 0, 162).originX).toBe(0)
    expect(place(40.4, 0.25, 162).lineBottom).toBeCloseTo(0.25, 9)
    expect(place(80.4, 0, 80, [8, 2]).originX).toBeCloseTo(-0.05, 9)
    expect(place(80.4, 0, 81, [8, 2]).originX).toBe(0)
  })

  it('rounds a box where the rounding of its line leaves it', () => {
    // A line whose highest box starts at 23.5 goes half a pixel down. Text whose box ends at
    // 52.156 follows to 52.656 and takes row 53, not the 52 nearest to where it was laid out.
    expect(place(0, 52.15625, 16, [4, 1], -0.5).lineBottom).toBeCloseTo(52.15625 - 53, 9)
    expect(place(0, 52.15625).lineBottom).toBeCloseTo(52.15625 - 52, 9)
    // A box a whole number of pixels from the line's start moves exactly as the line does.
    for (const lean of [-0.5, -0.25, 0.125, 0.375])
      expect(place(0, 47 + lean, 16, [4, 1], lean).lineBottom).toBeCloseTo(lean, 9)
  })

  it('records the move in the units of the layout', () => {
    const glyph = place(41.2, 20.75, 2, [32, 8])
    expect(glyph.snap).toEqual([glyph.originX, glyph.lineBottom])
    expectClose([...glyph.snap!], [-0.2 / 32, -0.25 / 8])
  })
})

describe('pixelSnap', () => {
  it('paints each line with its text box top on a whole pixel, a half going down the page', () => {
    const snapshot = capture([{ top: 10.25 }, { top: 50.5 }, { top: 90.75 }, { top: 130 }])
    expectClose(tops(snapshot), [10, 10, 10, 51, 51, 51, 91, 91, 91, 130, 130, 130])
    expectClose(
      snapshot.glyphs.map((glyph) => glyph.snap![1]),
      [0.25, 0.25, 0.25, -0.5, -0.5, -0.5, -0.25, -0.25, -0.25, 0, 0, 0],
    )
    expect(snapshot.snapGrid).toEqual([4, 1])
    // The lines of one block keep one `lineBottom`: they are still one line.
    expect(new Set(snapshot.glyphs.slice(0, 3).map((glyph) => glyph.lineBottom)).size).toBe(1)
  })

  it('rounds the same way above the viewport', () => {
    const snapshot = capture([{ top: -30.25 }, { top: -30.5 }, { top: -30.75 }], {
      at: [-20.5, -200],
    })
    expectClose(
      tops(snapshot, { rootTop: -200 }).filter((_, index) => index % 3 === 0),
      [-30, -30, -31],
    )
    // Origins at -10.5, -2.5 and 5.5: already on quarter pixels.
    expectClose(origins(snapshot, -20.5).slice(0, 3), [-10.5, -2.5, 5.5])
  })

  it('puts each glyph origin on the nearest quarter device pixel', () => {
    const snapshot = capture([
      { top: 10, left: 10.1, advance: 8.3 },
      { top: 50, left: 10.125, advance: 8.25 },
    ])
    // 10.1, 18.4 and 26.7; then the tie 10.125, which goes right.
    expectClose(origins(snapshot), [10, 18.5, 26.75, 10.25, 18.5, 26.75])
    // Advances stay the browser's own: they are the layout, not the paint.
    expectClose(
      snapshot.glyphs.map((glyph) => glyph.advance),
      [8.3, 8.3, 8.3, 8.25, 8.25, 8.25],
    )
  })

  it('leaves the origin of text the browser does not draw from glyph masks', () => {
    const snapshot = capture([
      { top: 10.25, left: 10.1, size: 161, advance: 80 },
      { top: 200.25, left: 10.1, size: 162, advance: 80 },
    ])
    expect(origins(snapshot)[0]).toBeCloseTo(10, 9)
    expect(origins(snapshot)[3]).toBe(10.1)
    // Its line is still painted on a whole row.
    expect(snapshot.glyphs[3]!.snap).toEqual([0, 0.25])
  })

  it('counts device pixels at a device scale, falling back to it for the layout pixel', () => {
    // No canvas, so nothing settles the layout pixel: it is the device's.
    deviceScale(2)
    const snapshot = capture([
      { top: 10.2, left: 10.05, advance: 8.125 },
      { top: 50.25, left: 10.07, advance: 8.125 },
      { top: 90.3, size: 81, advance: 40 },
    ])
    expect(snapshot.snapGrid).toEqual([8, 2])
    // Half CSS pixels: 10.2 goes up, the tie 50.25 and 90.3 go down.
    expectClose(
      [tops(snapshot)[0]!, tops(snapshot)[3]!, tops(snapshot, { size: 81 })[6]!],
      [10, 50.5, 90.5],
    )
    // Eighths of a CSS pixel; 81 px is 162 device pixels per em.
    expectClose(origins(snapshot).slice(0, 6), [10, 18.125, 26.25, 10.125, 18.25, 26.375])
    expect(snapshot.glyphs[6]!.snap![0]).toBe(0)
  })

  it('rounds on a fractional device scale', () => {
    deviceScale(1.5)
    // Layout pixel 15.5: a tie, which floats leave a hair short of one.
    const snapshot = capture([{ top: 15.5 / 1.5 }, { top: 61 / 1.5 }, { top: 91.4 / 1.5 }])
    expect(snapshot.snapGrid).toEqual([6, 1.5])
    expectClose(
      tops(snapshot, { scale: 1 }).filter((_, index) => index % 3 === 0),
      [16 / 1.5, 61 / 1.5, 91 / 1.5],
    )
  })

  it('rounds on the layout pixel the capture settles at a real device scale', () => {
    browser(2)
    // Glyph edges on odd 1/128ths of a CSS pixel: a layout zoomed by the device scale.
    const snapshot = capture(
      [
        { top: 10.25, left: 10 + 1 / 128, advance: 8 + 1 / 64 },
        { top: 50.75 - 1 / 128, left: 10 + 1 / 128, advance: 8 + 1 / 64 },
      ],
      { scale: 2 },
    )
    expect(snapshot.snapGrid).toEqual([8, 2])
    expect(snapshot.glyphs[0]!.baselineOffset).toBe(4.5)
    expectClose(
      tops(snapshot, { scale: 2 }).filter((_, index) => index % 3 === 0),
      [10.5, 50.5],
    )
    // 10 + 1/128, 18 + 3/128 and 26 + 5/128 fall back to the eighth of a CSS pixel under them.
    expectClose(origins(snapshot).slice(0, 3), [10, 18, 26])
  })

  it('rounds on CSS pixels under device emulation, where glyph masks are still device ones', () => {
    browser(2)
    // 11 px text is 13 px tall on CSS pixels only: emulation scales the painted page alone.
    const snapshot = capture([
      { top: 10.5, left: 10.0625 },
      { top: 50.25, left: 10.0625, size: 11 },
    ])
    expect(snapshot.snapGrid).toEqual([8, 1])
    expectClose([tops(snapshot)[0]!, tops(snapshot, { size: 11 })[3]!], [11, 50])
    expectClose(origins(snapshot).slice(0, 3), [10.125, 18.125, 26.125])
  })

  it('falls back to the device scale where the capture cannot settle the layout pixel', () => {
    browser(2)
    // 20 px text is 24 px tall at both scales, with another descent at each.
    const snapshot = capture([{ top: 10.25 }])
    expect(snapshot.glyphs[0]!.baselineOffset).toBeUndefined()
    expect(snapshot.snapGrid).toEqual([8, 2])
    expectClose(tops(snapshot).slice(0, 1), [10.5])
  })

  it('snaps where a transform has put the root', () => {
    // Client boxes carry the translation: the grid is the viewport's, not the root's.
    const snapshot = capture([{ top: 12.6 + 20.25, left: 37.3 + 10 }], { at: [37.3, 12.6] })
    expectClose(tops(snapshot, { rootTop: 12.6 }), [33, 33, 33])
    expectClose(origins(snapshot, 37.3), [47.25, 55.25, 63.25])
    expectClose(
      snapshot.glyphs.map((glyph) => glyph.originX),
      [9.95, 17.95, 25.95],
    )
  })

  it('works in captured units', () => {
    const lines = [{ top: 10.25, left: 10.1, advance: 8.3 }]
    const snapshot = capture(lines, {}, { pixelsPerUnit: 8 })
    expect(snapshot.snapGrid).toEqual([32, 8])
    expectClose(tops(snapshot, { pixelsPerUnit: 8 }), [10, 10, 10])
    expectClose(origins(snapshot, 0, 8), [10, 18.5, 26.75])
    expectClose([...snapshot.glyphs[0]!.snap!], [-0.1 / 8, 0.25 / 8])
  })

  it('keeps the layout under the snap: block metrics and the positions it took off', () => {
    const lines = [
      { top: 10.25, left: 10.1, advance: 8.3 },
      { top: 50.5, left: 10.3, advance: 8.3 },
    ]
    const snapped = capture(lines)
    document.body.replaceChildren()
    vi.restoreAllMocks()
    const plain = capture(lines, {}, { pixelSnap: false })
    expect(snapped.blocks).toEqual(plain.blocks)
    expect(snapped.lineCount).toBe(plain.lineCount)
    for (const [index, glyph] of snapped.glyphs.entries()) {
      const layoutGlyph = unsnapped(glyph)
      const captured = plain.glyphs[index]!
      expect(layoutGlyph.originX).toBeCloseTo(captured.originX, 9)
      expect(layoutGlyph.lineBottom).toBeCloseTo(captured.lineBottom, 9)
      expect({ ...layoutGlyph, originX: 0, lineBottom: 0 }).toEqual({
        ...captured,
        originX: 0,
        lineBottom: 0,
      })
    }
  })

  it('leaves a capture without the option exactly as it was', () => {
    const lines = [
      { top: 10.25, left: 10.1, advance: 8.3 },
      { top: 50.5, left: 10.3, advance: 8.3 },
    ]
    const root = layout(lines)
    const options = { includeRootBackground: false } as const
    const absent = collectDomSnapshot(root, options)
    const off = collectDomSnapshot(root, { ...options, pixelSnap: false })
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent))
    expect('snapGrid' in absent).toBe(false)
    expect(absent.glyphs.some((glyph) => 'snap' in glyph)).toBe(false)
    // The layout's own numbers, untouched by any rounding.
    expect(absent.glyphs.map((glyph) => glyph.originX)).toEqual([
      10.1,
      10.1 + 8.3,
      10.1 + 16.6,
      10.3,
      10.3 + 8.3,
      10.3 + 16.6,
    ])
    expect(absent.glyphs[0]!.lineBottom).toBe(ROOT - 10.25 - boxHeight(20))
    expect(absent.glyphs[3]!.lineBottom).toBe(ROOT - 50.5 - boxHeight(20))
  })

  it('reads nothing more from the DOM', () => {
    const lines = [{ top: 10.25, text: 'Hamburgefonstiv' }, { top: 50.5 }, { top: 90.75 }]
    const styles = vi.spyOn(view, 'getComputedStyle')
    const root = layout(lines)
    collectDomSnapshot(root, { includeRootBackground: false })
    const plain = [reads, styles.mock.calls.length]
    reads = 0
    styles.mockClear()
    collectDomSnapshot(root, { includeRootBackground: false, pixelSnap: true })
    expect([reads, styles.mock.calls.length]).toEqual(plain)
    // One Range box per glyph, the root and one box per block.
    expect(plain[0]).toBe(21 + 1 + 3)
  })

  it('gives a browser-shaped run its row and leaves its tiles where they join', async () => {
    installCanvas()
    const root = layout([{ top: 10.25, left: 10.1, advance: 8.3 }])
    const shaped = await collectDomSnapshot(root, {
      includeRootBackground: false,
      textShaping: 'browser',
      pixelSnap: true,
    })
    expect(shaped.glyphs.length).toBeGreaterThan(0)
    for (const glyph of shaped.glyphs) {
      expect(glyph.snap).toEqual([0, 0.25])
      expect(glyph.originX).toBe(10.1)
      expect(ROOT - glyph.lineBottom - boxHeight(20)).toBeCloseTo(10, 9)
    }
    // A shaped capture is reflowed only to its own width, and comes back as it is.
    expect(reflowSnapshot(shaped, shaped.width)).toBe(shaped)
  })

  it('rounds a line where its highest box starts, and each box where that leaves it', () => {
    // Text beside a superscript: the raised box starts the line box, 4.65625 px above the
    // text's own. The browser rounds the line by that start; the text follows and is then
    // drawn on the nearest row, a row lower than its own nearest one for three phases of eight.
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 20px Lato; color: rgb(0, 0, 0)'
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
      domRect({ left: 0, top: 0, width: ROOT, height: 600 }),
    )
    const boxes = new Map<Text, readonly (Box | null)[]>()
    const phases = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
    for (const [index, phase] of phases.entries()) {
      const block = root.appendChild(document.createElement('p'))
      block.dataset['sdfBlock'] = ''
      block.innerHTML = 'Hx<span style="font-size: 16px; vertical-align: super">1</span>g\u0301'
      const top = index * 60 + phase
      vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(
        domRect({ left: 0, top, width: ROOT, height: 60 }),
      )
      const text = (left: number, raised = false): Box => ({
        left,
        top: top + (raised ? 23 : 27.65625),
        width: 8,
        height: boxHeight(raised ? 16 : 20),
      })
      boxes.set(block.firstChild as Text, [text(10), text(18)])
      boxes.set(block.querySelector('span')!.firstChild as Text, [text(26, true)])
      boxes.set(block.lastChild as Text, [text(34), null])
    }
    installLayout(boxes)
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false, pixelSnap: true })
    const top = (index: number, size: number): number =>
      600 - snapshot.glyphs[index]!.lineBottom - boxHeight(size)
    for (const [index, phase] of phases.entries()) {
      const line = index * 60 + (phase < 0.5 ? 0 : 1)
      // H, x, the raised 1, the g after it, and the accent on the g, which has no box of its own.
      expectClose(
        [
          top(index * 5, 20),
          top(index * 5 + 1, 20),
          top(index * 5 + 2, 16),
          top(index * 5 + 3, 20),
          top(index * 5 + 4, 20),
        ],
        [line + 28, line + 28, line + 23, line + 28, line + 28],
      )
    }
    // From phase 0.5 the text's own nearest row is 28 still: 28.156, 28.281 and 28.406.
    expect(snapshot.glyphs[4 * 5]!.snap![1]).toBeCloseTo(-0.84375, 9)
  })

  it('keeps lines apart that overlap by less than half their height', () => {
    // Two lines of 24 px boxes 13 px apart, in one block: each is rounded by its own top.
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 20px Lato; color: rgb(0, 0, 0)'
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
      domRect({ left: 0, top: 0, width: ROOT, height: ROOT }),
    )
    const block = root.appendChild(document.createElement('p'))
    block.dataset['sdfBlock'] = ''
    block.textContent = 'Hx gy'
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(
      domRect({ left: 0, top: 10, width: ROOT, height: 60 }),
    )
    const box = (left: number, top: number): Box => ({ left, top, width: 8, height: 24 })
    installLayout(
      new Map([
        [
          block.firstChild as Text,
          [box(10, 10.25), box(18, 10.25), null, box(10, 23.5), box(18, 23.5)],
        ],
      ]),
    )
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false, pixelSnap: true })
    expectClose(tops(snapshot), [10, 10, 24, 24])
  })

  it('snaps the lines Pretext lays out', async () => {
    browser()
    const root = layout([{ top: 0 }], { at: [0.3, 0.6], lineHeight: '22.4px' })
    root.querySelector('p')!.innerHTML = 'H<br>x<br>g'
    const options = { includeRootBackground: false, layoutEngine: 'pretext' } as const
    const plain = await collectDomSnapshot(root, options)
    const snapped = await collectDomSnapshot(root, { ...options, pixelSnap: true })
    expect(snapped.snapGrid).toEqual([4, 1])
    for (const [index, glyph] of snapped.glyphs.entries()) {
      // The model's text box bottom, in client pixels: the baseline plus a whole descent.
      const bottom = 0.6 + ROOT - plain.glyphs[index]!.lineBottom
      expect(0.6 + ROOT - glyph.lineBottom).toBeCloseTo(Math.floor(bottom + 0.5), 9)
      expect((0.3 + glyph.originX) * 4).toBeCloseTo(Math.round((0.3 + glyph.originX) * 4), 9)
      expect(glyph.lineBottom - glyph.snap![1]).toBeCloseTo(plain.glyphs[index]!.lineBottom, 9)
    }
    // Three lines 22.4 px apart from a fractional top: each has its own distance to a row.
    expect(new Set(snapped.glyphs.map((glyph) => glyph.snap![1].toFixed(3))).size).toBe(3)
  })
})

describe('pixelSnap and reflow', () => {
  const AT = [0.3, 0.7] as const
  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']
  const ADVANCE = 8.3
  const SPACE = 4.1
  const PITCH = 22.4

  /** One block of words wrapped at `width`, as a browser lays them out from the block's edge. */
  function wrapped(width: number, options: RangeOptions = {}): DomLayoutSnapshot {
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 20px Lato; color: rgb(0, 0, 0)'
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
      domRect({ left: AT[0], top: AT[1], width: ROOT, height: ROOT }),
    )
    const block = root.appendChild(document.createElement('p'))
    block.dataset['sdfBlock'] = ''
    block.style.lineHeight = `${PITCH}px`
    block.textContent = WORDS.join(' ')
    const left = AT[0] + 12.2
    const top = AT[1] + 6.15
    const boxes: (Box | null)[] = []
    let line = 0
    let pen = 0
    for (const [index, word] of WORDS.entries()) {
      if (index > 0) {
        boxes.push(null)
        if (pen + SPACE + word.length * ADVANCE > width) {
          line++
          pen = 0
        } else pen += SPACE
      }
      for (const _ of word) {
        boxes.push({
          left: left + pen,
          top: top + line * PITCH,
          width: ADVANCE,
          height: boxHeight(20),
        })
        pen += ADVANCE
      }
    }
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(
      domRect({ left, top, width, height: (line + 1) * PITCH }),
    )
    installLayout(new Map([[block.firstChild as Text, boxes]]))
    return collectDomSnapshot(root, { includeRootBackground: false, ...options })
  }

  const fresh = (): void => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  }

  /** Every glyph sits on the grid the browser would paint it on, the root's corner unmoved. */
  function expectOnGrid(snapshot: DomLayoutSnapshot): void {
    for (const glyph of snapshot.glyphs) {
      const bottom = AT[1] + snapshot.height - glyph.lineBottom
      expect(bottom).toBeCloseTo(Math.round(bottom), 9)
      const origin = (AT[0] + glyph.originX) * 4
      expect(origin).toBeCloseTo(Math.round(origin), 9)
      expect(Math.abs(glyph.snap![0])).toBeLessThanOrEqual(0.125 + 1e-9)
      expect(Math.abs(glyph.snap![1])).toBeLessThanOrEqual(0.5 + 1e-9)
    }
  }

  it('reproduces the snapped capture when reflowed to the captured width', () => {
    const captured = wrapped(120, { pixelSnap: true })
    expect(captured.lineCount).toBeGreaterThan(2)
    expectOnGrid(captured)
    const reflowed = reflowSnapshot(captured, captured.width)
    expect(reflowed.height).toBe(captured.height)
    expect(reflowed.snapGrid).toEqual(captured.snapGrid)
    for (const [index, glyph] of reflowed.glyphs.entries()) {
      const original = captured.glyphs[index]!
      expect(glyph.originX).toBeCloseTo(original.originX, 9)
      expect(glyph.lineBottom).toBeCloseTo(original.lineBottom, 9)
      expectClose([...glyph.snap!], [...original.snap!])
    }
  })

  it('re-wraps the layout itself and snaps what it moved', () => {
    const snapped = wrapped(120, { pixelSnap: true })
    fresh()
    const plain = wrapped(120)
    for (const width of [ROOT - 50, ROOT + 90]) {
      const reflowed = reflowSnapshot(snapped, width)
      const layoutOnly = reflowSnapshot(plain, width)
      expect(reflowed.lineCount).toBe(layoutOnly.lineCount)
      expect(reflowed.lineCount).not.toBe(snapped.lineCount)
      expect(reflowed.height).toBe(layoutOnly.height)
      expectOnGrid(reflowed)
      for (const [index, glyph] of reflowed.glyphs.entries()) {
        const moved = unsnapped(glyph)
        expect(moved.originX).toBeCloseTo(layoutOnly.glyphs[index]!.originX, 9)
        expect(moved.lineBottom).toBeCloseTo(layoutOnly.glyphs[index]!.lineBottom, 9)
        expect(moved.sequence).toBe(layoutOnly.glyphs[index]!.sequence)
      }
      // Lines 22.4 px apart: the re-wrapped ones are at five distances from a row.
      expect(new Set(reflowed.glyphs.map((glyph) => glyph.snap![1].toFixed(3))).size).toBe(
        Math.min(5, reflowed.lineCount),
      )
    }
  })

  it('keeps the snap of a glyph the re-wrap leaves in place, whatever row its line gave it', () => {
    const captured = wrapped(120, { pixelSnap: true })
    // As beside a superscript: the first line sits a row lower than its own boxes round to.
    const first = captured.glyphs[0]!.lineBottom
    const lowered = {
      ...captured,
      glyphs: captured.glyphs.map((glyph) =>
        glyph.lineBottom === first
          ? {
              ...glyph,
              lineBottom: glyph.lineBottom - 1,
              snap: [glyph.snap![0], glyph.snap![1] - 1] as const,
            }
          : glyph,
      ),
    }
    const reflowed = reflowSnapshot(lowered, lowered.width)
    for (const [index, glyph] of reflowed.glyphs.entries()) {
      expect(glyph.lineBottom).toBeCloseTo(lowered.glyphs[index]!.lineBottom, 9)
      expect(glyph.originX).toBeCloseTo(lowered.glyphs[index]!.originX, 9)
    }
    // Moved, a glyph is rounded by its own box: no line is known for it there.
    const narrow = reflowSnapshot(lowered, ROOT - 50)
    for (const [index, glyph] of narrow.glyphs.entries()) {
      const bottom = AT[1] + narrow.height - glyph.lineBottom
      expect(bottom).toBeCloseTo(Math.round(bottom), 9)
      const moved =
        Math.abs(glyph.originX - lowered.glyphs[index]!.originX) > 1e-6 ||
        Math.abs(
          narrow.height - glyph.lineBottom - (lowered.height - lowered.glyphs[index]!.lineBottom),
        ) > 1e-6
      if (moved) expect(Math.abs(glyph.snap![1])).toBeLessThanOrEqual(0.5 + 1e-9)
    }
    expect(narrow.glyphs.some((glyph) => Math.abs(glyph.snap![1]) > 0.5)).toBe(true)
  })

  it('reflows a capture without the option exactly as before', () => {
    const plain = wrapped(120)
    const reflowed = reflowSnapshot(plain, ROOT - 50)
    expect('snapGrid' in reflowed).toBe(false)
    expect(reflowed.glyphs.some((glyph) => 'snap' in glyph)).toBe(false)
  })
})
