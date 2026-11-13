import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectDomSnapshot } from '../src/dom/snapshot.js'
import type { DomLayoutSnapshot } from '../src/types.js'

// A font whose ascent and descent are 0.987 and 0.213 em (Lato), as Chromium's layout and its
// canvas text metrics both report them: rounded to whole pixels at the size they are asked at.
// At 20 px that is 20 + 4 on CSS pixels, and (39 + 9) / 2 = 19.5 + 4.5 on the half-pixel
// grid of a device scale of 2: one text box height, two baselines.
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

/** How many Range boxes the capture has read since the last layout was installed. */
let rangeReads = 0

/** One Range box per character offset of each text node; a missing box is a collapsed range. */
function installLayout(boxes: ReadonlyMap<Text, readonly (Box | null)[]>): void {
  rangeReads = 0
  const createRange = document.createRange.bind(document)
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => {
        rangeReads++
        const node = range.startContainer
        const box = node instanceof Text ? boxes.get(node)?.[range.startOffset] : null
        return domRect(box ?? { left: 0, top: 0, width: 0, height: 0 })
      },
    })
    return range
  })
}

/** A canvas that measures the font above, rounding at the size it is asked for. */
function installCanvas(): { readonly sizes: number[]; readonly getContext: unknown } {
  const sizes: number[] = []
  const context = {
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => {
      const size = Number.parseFloat(/([\d.]+)px/.exec(context.font)![1]!)
      sizes.push(size)
      return {
        width: Array.from(text).length * size * 0.5,
        fontBoundingBoxAscent: Math.round(size * ASCENT),
        fontBoundingBoxDescent: Math.round(size * DESCENT),
      }
    },
  }
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context as unknown as CanvasRenderingContext2D)
  return { sizes, getContext }
}

const view = document.defaultView!
const realScale = Object.getOwnPropertyDescriptor(view, 'devicePixelRatio')

/** A browser has a 2D canvas, which jsdom lacks, and a device scale. */
function browser(deviceScale = 1): void {
  Object.defineProperty(view, 'CanvasRenderingContext2D', { configurable: true, value: vi.fn() })
  Object.defineProperty(view, 'devicePixelRatio', { configurable: true, value: deviceScale })
}

/**
 * A root at `rootLeft` with one block per font size. Each block holds `text`, laid out left
 * to right from `left` inside the root in `advance`-wide boxes, as tall as `scale` makes that
 * size unless `height` says.
 */
function layout(
  sizes: readonly number[],
  {
    scale = 1,
    left = 10,
    advance = 8,
    text = 'Hxg',
    height = undefined as number | undefined,
    rootLeft = 0,
    lineHeight = '',
  } = {},
): HTMLElement {
  const root = document.body.appendChild(document.createElement('section'))
  root.style.cssText = 'font: 20px Lato; color: rgb(0, 0, 0)'
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
    domRect({ left: rootLeft, top: 0, width: 400, height: 400 }),
  )
  const boxes = new Map<Text, readonly (Box | null)[]>()
  for (const [index, size] of sizes.entries()) {
    const block = root.appendChild(document.createElement('p'))
    block.dataset['sdfBlock'] = ''
    // jsdom reports default border widths; the Pretext engine reads the content box.
    block.style.border = '0'
    block.style.fontSize = `${size}px`
    block.style.lineHeight = lineHeight
    block.textContent = text
    const top = index * 60
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(
      domRect({ left: rootLeft, top, width: 400, height: 60 }),
    )
    boxes.set(
      block.firstChild as Text,
      Array.from(text, (character, offset) =>
        /\p{M}/u.test(character)
          ? null
          : {
              left: rootLeft + left + offset * advance,
              top,
              width: advance,
              height: height ?? boxHeight(size, scale),
            },
      ),
    )
  }
  installLayout(boxes)
  return root
}

const capture = (
  sizes: readonly number[],
  { pixelsPerUnit = 1, ...options }: Parameters<typeof layout>[1] & { pixelsPerUnit?: number } = {},
): DomLayoutSnapshot =>
  collectDomSnapshot(layout(sizes, options), { includeRootBackground: false, pixelsPerUnit })

/** Where a glyph's baseline sits, measured up from the bottom of the 400 px root. */
const baselineOf = (snapshot: DomLayoutSnapshot, index = 0): number =>
  snapshot.glyphs[index]!.lineBottom + snapshot.glyphs[index]!.baselineOffset!

const baselines = (snapshot: DomLayoutSnapshot): (number | undefined)[] =>
  snapshot.glyphs.map((glyph) => glyph.baselineOffset)

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  Reflect.deleteProperty(view, 'CanvasRenderingContext2D')
  if (realScale) Object.defineProperty(view, 'devicePixelRatio', realScale)
  else Reflect.deleteProperty(view, 'devicePixelRatio')
})

describe('captured baselines', () => {
  it("gives Range glyphs the browser's pixel-rounded descent instead of a scaled one", () => {
    browser()
    const { sizes } = installCanvas()
    // 20 px: 4.26 px of descent is 4 px in the layout. 26 px: 5.54 px is 6 px.
    const snapshot = capture([20, 26])
    expect(baselines(snapshot)).toEqual([4, 4, 4, 6, 6, 6])
    // The text box bottom stays the captured position; the baseline is measured up from it.
    expect(snapshot.glyphs[0]!.lineBottom).toBe(400 - boxHeight(20))
    expect(sizes).toEqual([20, 26])
  })

  it('reports the descent in captured units', () => {
    browser()
    installCanvas()
    expect(baselines(capture([20], { pixelsPerUnit: 8 }))).toEqual([0.5, 0.5, 0.5])
  })

  it('gives a combining mark the baseline of the text it sits in', () => {
    browser()
    installCanvas()
    const snapshot = capture([20], { text: 'éx' })
    // The mark has no Range box of its own to measure; it follows its run.
    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.split('\u0000')[1])).toEqual([
      'e',
      '\u0301',
      'x',
    ])
    expect(baselines(snapshot)).toEqual([4, 4, 4])
  })

  it('leaves the baseline to the atlas when the canvas font is not the one laid out', () => {
    browser()
    installCanvas()
    // A text box 2 px taller than this font's ascent plus descent: another font is in the DOM.
    expect(baselines(capture([20], { height: boxHeight(20) + 2 }))).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('does not ask for a canvas where there is none to measure with', () => {
    const { getContext } = installCanvas()
    expect(baselines(capture([20]))).toEqual([undefined, undefined, undefined])
    expect(getContext).not.toHaveBeenCalled()
  })

  it('rounds on the device pixel grid at a real device scale', () => {
    browser(2)
    const { sizes } = installCanvas()
    // Layout at a scale of 2 leaves glyph edges on odd 1/128ths of a CSS pixel.
    const snapshot = capture([20], { scale: 2, left: 10 + 1 / 128, advance: 8 + 1 / 64 })
    // (39 + 9) / 2: the same 24 px text box as on CSS pixels, with 4.5 px under the baseline.
    expect(baselines(snapshot)).toEqual([4.5, 4.5, 4.5])
    expect(sizes).toEqual([40])
  })

  it('stays on CSS pixels under device emulation, settled by a font that fits only them', () => {
    browser(2)
    installCanvas()
    // Emulation scales the painted page only: edges stay whole 1/64ths of a CSS pixel.
    // 11 px is 13 px tall on CSS pixels and 13.5 px on device ones; 20 px is 24 px on both.
    expect(boxHeight(11)).not.toBe(boxHeight(11, 2))
    expect(boxHeight(20)).toBe(boxHeight(20, 2))
    expect(baselines(capture([20, 11]))).toEqual([4, 4, 4, 2, 2, 2])
  })

  it('follows a font that fits only the device scale when edges happen to be whole', () => {
    browser(2)
    installCanvas()
    expect(baselines(capture([20, 11], { scale: 2 }))).toEqual([4.5, 4.5, 4.5, 2.5, 2.5, 2.5])
  })

  it('leaves a font alone when both scales fit its text box with different descents', () => {
    browser(2)
    installCanvas()
    // 10 px: 10 + 2 on CSS pixels and (20 + 4) / 2 on device ones, the same baseline either way.
    expect(baselines(capture([20, 10]))).toEqual([undefined, undefined, undefined, 2, 2, 2])
  })

  it('does not let fonts that disagree about the scale settle the others', () => {
    browser(2)
    installCanvas()
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 20px Lato; color: rgb(0, 0, 0)'
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
      domRect({ left: 0, top: 0, width: 400, height: 400 }),
    )
    const boxes = new Map<Text, readonly (Box | null)[]>()
    // 11 px laid out on CSS pixels, 12 px on device ones, and 20 px that fits both.
    for (const [index, [size, scale]] of (
      [
        [11, 1],
        [12, 2],
        [20, 1],
      ] as const
    ).entries()) {
      const block = root.appendChild(document.createElement('p'))
      block.dataset['sdfBlock'] = ''
      block.style.fontSize = `${size}px`
      block.textContent = 'H'
      vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(
        domRect({ left: 0, top: index * 60, width: 400, height: 60 }),
      )
      boxes.set(block.firstChild as Text, [
        { left: 10, top: index * 60, width: 8, height: boxHeight(size, scale) },
      ])
    }
    installLayout(boxes)
    expect(baselines(collectDomSnapshot(root, { includeRootBackground: false }))).toEqual([
      2,
      2.5,
      undefined,
    ])
  })

  it('trusts neither scale when glyph edges are on neither layout grid', () => {
    browser(2)
    const { getContext } = installCanvas()
    // A third of a pixel is no 64th of a layout pixel at either scale: not a Chromium layout.
    expect(baselines(capture([20], { left: 10 + 1 / 3 }))).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(getContext).not.toHaveBeenCalled()
  })

  it('reads the layout grid from the root, wherever a transform or a scroll has put it', () => {
    browser(2)
    installCanvas()
    // A translated root carries its glyphs with it: their distances stay on the grid.
    const moved = capture([20, 11], { scale: 2, left: 10 + 1 / 128, rootLeft: 37.123 })
    expect(baselines(moved)).toEqual([4.5, 4.5, 4.5, 2.5, 2.5, 2.5])
    expect(moved.glyphs[0]!.originX).toBeCloseTo(10 + 1 / 128, 9)
  })

  it('keeps the same baselines when a snapshot is captured twice', () => {
    browser()
    installCanvas()
    const first = capture([20, 26])
    document.body.replaceChildren()
    vi.restoreAllMocks()
    installCanvas()
    expect(capture([20, 26])).toEqual(first)
  })
})

describe('captured baselines of shaped and Pretext text', () => {
  it('gives a browser-shaped run the layout descent of a real device scale', async () => {
    browser(2)
    installCanvas()
    const root = layout([20], { scale: 2, left: 10 + 1 / 128, advance: 8 + 1 / 64 })
    const shaped = await collectDomSnapshot(root, {
      includeRootBackground: false,
      textShaping: 'browser',
    })
    // One run, whose descent Canvas reports as 4 px at its CSS size and the layout set at 4.5.
    expect(shaped.glyphs).toHaveLength(1)
    expect(baselines(shaped)).toEqual([4.5])
  })

  it('leaves a shaped run the descent Canvas measured where the scale stays open', async () => {
    browser(2)
    installCanvas()
    const shaped = await collectDomSnapshot(layout([20]), {
      includeRootBackground: false,
      textShaping: 'browser',
    })
    expect(baselines(shaped)).toEqual([4])
  })

  it('draws Pretext lines on the baseline its model sets, half-leading rounded down', async () => {
    browser()
    installCanvas()
    const snapshot = await collectDomSnapshot(layout([20], { lineHeight: '29px' }), {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    // 24 px of font in a 29 px line: 2.5 px of half-leading is 2 px in the layout, and the
    // baseline sits 20 px of ascent under it.
    expect(baselines(snapshot)).toEqual([4, 4, 4])
    expect(baselineOf(snapshot)).toBe(400 - 22)
  })

  it("takes a normal line height from the font's own height in Pretext", async () => {
    browser()
    installCanvas()
    const root = layout([20])
    root.querySelector('p')!.innerHTML = 'H<br>x'
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    // No leading at all: the first baseline is the ascent, the second a font height below.
    expect([baselineOf(snapshot, 0), baselineOf(snapshot, 1)]).toEqual([400 - 20, 400 - 44])
  })

  it('measures Pretext text on device pixels at a real device scale', async () => {
    browser(2)
    installCanvas()
    const root = layout([20], {
      scale: 2,
      left: 10 + 1 / 128,
      advance: 8 + 1 / 64,
      lineHeight: '30px',
    })
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    // (39 + 9) / 2 px of font in a 30 px line: 3 px of half-leading, then 19.5 px of ascent.
    expect(baselines(snapshot)).toEqual([4.5, 4.5, 4.5])
    expect(baselineOf(snapshot)).toBe(400 - 22.5)
  })

  it('holds a Pretext line height on the layout grid it reads back a hair off', async () => {
    browser(3)
    installCanvas()
    // 1.4 times 13.3333 px reads back as 18.6666 px: 55.9998 device pixels where the layout
    // holds 56. With 48 of font in it, that is 4 device pixels of half-leading, not 3.
    const root = layout([13.3333], {
      scale: 3,
      left: 10 + 1 / 192,
      advance: 8 + 1 / 96,
      lineHeight: '18.6666px',
    })
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    expect(baselines(snapshot)).toEqual([3, 3, 3])
    expect(baselineOf(snapshot)).toBeCloseTo(400 - 4 / 3 - 13, 9)
  })

  it('keeps Pretext on CSS pixels under device emulation and where the scale stays open', async () => {
    browser(2)
    installCanvas()
    // 11 px text is 13 px tall on CSS pixels only; 20 px text fits both scales.
    for (const [size, descent, ascent] of [
      [11, 2, 11],
      [20, 4, 20],
    ] as const) {
      const snapshot = await collectDomSnapshot(layout([size], { lineHeight: '30px' }), {
        includeRootBackground: false,
        layoutEngine: 'pretext',
      })
      expect(baselines(snapshot)).toEqual([descent, descent, descent])
      expect(baselineOf(snapshot)).toBe(400 - Math.floor((30 - ascent - descent) / 2) - ascent)
      document.body.replaceChildren()
      vi.restoreAllMocks()
      installCanvas()
    }
  })

  it('reads a handful of glyph boxes for the Pretext scale, not one per glyph', async () => {
    browser(2)
    installCanvas()
    const root = layout([20, 20], { text: 'Hamburgefonstiv', lineHeight: '30px' })
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    expect(snapshot.glyphs).toHaveLength(30)
    expect(rangeReads).toBe(16)
  })

  it('reads no glyph box for Pretext where a layout pixel is a CSS pixel', async () => {
    browser()
    installCanvas()
    const root = layout([20], { text: 'Hamburgefonstiv', lineHeight: '30px' })
    await collectDomSnapshot(root, { includeRootBackground: false, layoutEngine: 'pretext' })
    expect(rangeReads).toBe(0)
  })
})
