import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rasterizeGlyphAtlas } from '../src/atlas/rasterize.js'
import type { FontStyleSnapshot, GlyphRequest } from '../src/types.js'
import type * as OutlineModule from '../src/windfoil/trace/outline.js'
import { createTracedOutlineProvider } from '../src/windfoil/tracedOutlines.js'
import {
  installFakeFonts,
  installFakeGlyphCanvas,
  type FakeGlyph,
} from './helpers/fake-glyph-canvas.js'

/** The working memory each trace was given, held weakly so it can be collected. */
const scratches = vi.hoisted(() => [] as WeakRef<object>[])

vi.mock('../src/windfoil/trace/outline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OutlineModule>()
  return {
    ...actual,
    traceCoverage(...args: Parameters<typeof actual.traceCoverage>) {
      scratches.push(new WeakRef(args[2]!))
      return actual.traceCoverage(...args)
    },
  }
})

const font: FontStyleSnapshot = {
  key: 'face',
  canvasFont: '600 96px Test',
  family: 'Test',
  weight: '600',
  style: 'normal',
  stretch: '75%',
  variant: 'normal',
  kerning: 'none',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'auto',
  size: 32,
}

const glyphs: Record<string, FakeGlyph> = {
  H: {
    boxes: [
      [0.1, 0, 0.2, 0.7],
      [0.2, 0.3, 0.5, 0.4],
      [0.5, 0, 0.6, 0.7],
    ],
    advance: 0.7,
  },
  I: { boxes: [[0.1, 0, 0.2, 0.7]], advance: 0.3 },
  '😀': { boxes: [[0.05, -0.1, 0.95, 0.8]], advance: 1, color: [250, 200, 40] },
  '©': { boxes: [[0.1, 0, 0.8, 0.7]], advance: 0.9 },
  '⠀': { boxes: [], advance: 0.5 },
  // Metrics that miss ink right of a 0.4 em advance: 0.4 em of it, then 1.1 em.
  J: { boxes: [[0, 0, 0.8, 0.7]], advance: 0.4, reported: [0, 0, 0.4, 0.7] },
  Q: { boxes: [[0, 0, 1.5, 0.7]], advance: 0.4, reported: [0, 0, 0.4, 0.7] },
}

function request(character: string, face: FontStyleSnapshot = font): GlyphRequest {
  return { key: `${face.key}\u0000${character}`, character, font: face }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

/** Signed area of a closed quadratic chain, Y up: negative for clockwise. */
function areaOf(q: ArrayLike<number>): number {
  let area = 0
  for (let o = 0; o < q.length; o += 6) {
    const [x0, y0, cx, cy, x1, y1] = [q[o]!, q[o + 1]!, q[o + 2]!, q[o + 3]!, q[o + 4]!, q[o + 5]!]
    area += (x0 * y1 - x1 * y0) / 2 - ((x0 - cx) * (y1 - cy) - (x1 - cx) * (y0 - cy)) / 3
  }
  return area
}

function contourCount(q: ArrayLike<number>): number {
  let count = 0
  for (let o = 0; o < q.length; o += 6) {
    if (o === 0 || q[o] !== q[o - 2] || q[o + 1] !== q[o - 1]) count++
  }
  return count
}

let fonts: ReturnType<typeof installFakeFonts>

beforeEach(() => {
  fonts = installFakeFonts()
})

afterEach(() => {
  fonts.restore()
  vi.restoreAllMocks()
})

describe('traced outline provider', () => {
  it('draws with the captured canvas font at the trace size, its stretch and kerning, once loaded', async () => {
    const canvas = installFakeGlyphCanvas(glyphs)
    let drawsAtLoad = -1
    fonts.fonts.load.mockImplementation((face: string, text: string) => {
      fonts.loads.push([face, text])
      drawsAtLoad = canvas.draws.length
      return Promise.resolve([])
    })
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    const traced = await Promise.all([provider(request('H'), scope), provider(request('I'), scope)])

    expect(traced.every((outline) => outline !== null)).toBe(true)
    // One batch: one load per font, with every character of the batch, before any drawing.
    expect(fonts.loads).toEqual([['600 256px Test', 'HI']])
    expect(drawsAtLoad).toBe(0)
    expect(canvas.draws.map(({ text }) => text)).toEqual(['H', 'I'])
    for (const draw of canvas.draws) {
      expect(draw).toMatchObject({
        font: '600 256px Test',
        stretch: 'condensed',
        kerning: 'none',
        fill: '#606060',
        rendering: 'geometricPrecision',
      })
    }
    // The bake canvas leaves the document with its batch.
    expect(document.documentElement.querySelector('canvas')).toBeNull()
  })

  it('traces the glyph in the SDF slot metrics, TrueType winding and the exact area', async () => {
    installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const outline = (await provider(request('H'), signal()))!

    expect(outline.unitsPerEm).toBe(256)
    // The descent rasterizeGlyphAtlas gives the slot of the same glyph, in em.
    const atlas = await rasterizeGlyphAtlas(document, [request('H')], { bakeSize: 96 })
    const slot = atlas.glyphs.get(request('H').key)!
    expect(outline.descent / outline.unitsPerEm).toBeCloseTo(-slot.descent / 96, 12)
    expect(outline.ascent).toBeCloseTo((Math.round(1.07 * 96) * 256) / 96, 9)
    expect(contourCount(outline.quadratics)).toBe(1)
    const area = areaOf(outline.quadratics)
    expect(area).toBeLessThan(0)
    expect(Math.abs(-area / (0.17 * 256 * 256) - 1)).toBeLessThan(0.005)
    const expected = [0.1, 0, 0.6, 0.7].map((value) => value * 256)
    for (const [index, value] of expected.entries()) {
      expect(outline.bbox[index]).toBeCloseTo(value, 1)
    }
  })

  it('sends colour ink to the SDF companion and traces candidates drawn in the fill', async () => {
    const canvas = installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    const [emoji, copyright] = await Promise.all([
      provider(request('😀'), scope),
      provider(request('©'), scope),
    ])
    expect(emoji).toBeNull()
    expect(copyright?.quadratics.length).toBeGreaterThan(0)
    // Both candidates are drawn in white and in black; only the monochrome one is traced.
    expect(canvas.draws.map(({ text, fill }) => `${text}${fill}`)).toEqual([
      '😀#ffffff',
      '😀#000000',
      '©#ffffff',
      '©#000000',
      '©#606060',
    ])

    const none = installFakeGlyphCanvas(glyphs)
    const traced = createTracedOutlineProvider(document, { colorGlyphs: 'none' })
    expect((await traced.provider(request('😀'), signal()))?.quadratics.length).toBeGreaterThan(0)
    expect(none.draws.map(({ fill }) => fill)).toEqual(['#606060'])
  })

  it('gives a glyph without ink an empty outline, never a box', async () => {
    installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    const [blank, letter] = await Promise.all([
      provider(request('⠀'), scope),
      provider(request('I'), scope),
    ])
    expect(blank).toEqual({
      unitsPerEm: 256,
      ascent: letter!.ascent,
      descent: letter!.descent,
      bbox: [0, 0, 0, 0],
      quadratics: new Float32Array(0),
    })
  })

  it('draws a glyph again with half an em more room when its metrics miss some ink', async () => {
    const canvas = installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const outline = (await provider(request('J'), signal()))!

    // Clipped in the box its metrics gave, then whole with 128 trace px more all round.
    expect(canvas.draws.map(({ text, x }) => `${text}@${x}`)).toEqual(['J@8', 'J@136'])
    expect(contourCount(outline.quadratics)).toBe(1)
    expect(Math.abs(-areaOf(outline.quadratics) / (0.56 * 256 * 256) - 1)).toBeLessThan(0.005)
    const expected = [0, 0, 0.8, 0.7].map((value) => value * 256)
    for (const [index, value] of expected.entries()) {
      expect(outline.bbox[index]).toBeCloseTo(value, 1)
    }
  })

  it('resolves null for ink past even the retried box, for the SDF companion, never clipped', async () => {
    const canvas = installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    const [clipped, letter] = await Promise.all([
      provider(request('Q'), scope),
      provider(request('I'), scope),
    ])
    expect(clipped).toBeNull()
    expect(letter?.quadratics.length).toBeGreaterThan(0)
    expect(canvas.draws.map(({ text }) => text)).toEqual(['Q', 'Q', 'I'])
  })

  it('resolves null for a font the canvas rejects, and for every glyph without a 2D canvas', async () => {
    const canvas = installFakeGlyphCanvas(glyphs, { accepts: (face) => !face.includes('Broken') })
    const broken = { ...font, key: 'broken', canvasFont: '400 96px Broken' }
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    const [rejected, kept] = await Promise.all([
      provider(request('H', broken), scope),
      provider(request('H'), scope),
    ])
    expect(rejected).toBeNull()
    expect(kept).not.toBeNull()
    expect(canvas.draws.every((draw) => draw.font === '600 256px Test')).toBe(true)

    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const calls = getContext.mock.calls.length
    const blind = createTracedOutlineProvider(document)
    expect(await blind.provider(request('H'), signal())).toBeNull()
    // Not cached: a later build tries again.
    expect(await blind.provider(request('H'), signal())).toBeNull()
    expect(getContext.mock.calls.length - calls).toBe(2)
    expect(document.documentElement.querySelector('canvas')).toBeNull()
  })

  it('caches per key until clear() or retain(), but not what it traced before the font was ready', async () => {
    const canvas = installFakeGlyphCanvas(glyphs)
    const traced = createTracedOutlineProvider(document)
    const scope = signal()
    const [first] = await Promise.all([
      traced.provider(request('H'), scope),
      traced.provider(request('I'), scope),
    ])
    // Cached results return synchronously, as the same objects.
    expect(traced.provider(request('H'), scope)).toBe(first)
    expect(canvas.draws).toHaveLength(2)

    traced.retain([request('I').key])
    expect(traced.provider(request('I'), scope)).not.toBeInstanceOf(Promise)
    const again = traced.provider(request('H'), scope)
    expect(again).toBeInstanceOf(Promise)
    expect(await again).not.toBe(first)

    traced.clear()
    expect(traced.provider(request('I'), scope)).toBeInstanceOf(Promise)

    fonts.fonts.check.mockReturnValue(false)
    const loading = createTracedOutlineProvider(document)
    await loading.provider(request('H'), scope)
    expect(loading.provider(request('H'), scope)).toBeInstanceOf(Promise)
  })

  it('drops results traced before clear() from the cache', async () => {
    installFakeGlyphCanvas(glyphs)
    const traced = createTracedOutlineProvider(document)
    const pending = traced.provider(request('H'), signal())
    // A font load lands while the batch is in flight.
    traced.clear()
    expect(await pending).not.toBeNull()
    expect(traced.provider(request('H'), signal())).toBeInstanceOf(Promise)
  })

  it('traces one batch per task and signal', async () => {
    installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    await Promise.all([
      provider(request('H'), scope),
      provider(request('I'), signal()),
      provider(request('©'), scope),
    ])
    expect(fonts.loads).toEqual([
      ['600 256px Test', 'H©'],
      ['600 256px Test', 'I'],
    ])
  })

  it('gives each batch its own working memory, shared by its glyphs and released after it', async () => {
    installFakeGlyphCanvas(glyphs)
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    scratches.length = 0
    const traced = createTracedOutlineProvider(document)
    const scope = signal()
    const [first] = await Promise.all([
      traced.provider(request('H'), scope),
      traced.provider(request('I'), scope),
    ])
    await traced.provider(request('©'), signal())
    const same = (a: number, b: number): boolean => scratches[a]!.deref() === scratches[b]!.deref()
    expect(scratches).toHaveLength(3)
    // The glyphs of a batch reuse its scratch; the next batch grows its own.
    expect(same(0, 1)).toBe(true)
    expect(same(1, 2)).toBe(false)

    // Once its batches are done, the tracer keeps none of it while it lives on.
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc()
    expect(scratches.map((scratch) => scratch.deref() === undefined)).toEqual([true, true, true])
    expect(traced.provider(request('H'), scope)).toBe(first)
  })

  it('throws for an aborted signal and stops between glyphs when aborted mid-batch', async () => {
    const canvas = installFakeGlyphCanvas(glyphs)
    const { provider } = createTracedOutlineProvider(document)
    const aborted = new AbortController()
    aborted.abort(new Error('superseded'))
    expect(() => provider(request('H'), aborted.signal)).toThrow('superseded')

    const controller = new AbortController()
    canvas.onDraw = () => {
      controller.abort(new Error('rebuilt'))
    }
    const batch = Promise.all([
      provider(request('H'), controller.signal),
      provider(request('I'), controller.signal),
    ])
    await expect(batch).rejects.toThrow('rebuilt')
    // The glyph being traced finishes; the next one is never drawn.
    expect(canvas.draws.map(({ text }) => text)).toEqual(['H'])
    expect(document.documentElement.querySelector('canvas')).toBeNull()
  })

  it('yields to the page between glyphs once a slice has run for 8 ms', async () => {
    installFakeGlyphCanvas(glyphs)
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 10))
    let yields = 0
    const Channel = globalThis.MessageChannel
    vi.stubGlobal(
      'MessageChannel',
      class extends Channel {
        constructor() {
          super()
          yields++
        }
      },
    )
    const { provider } = createTracedOutlineProvider(document)
    const scope = signal()
    const outlines = await Promise.all([
      provider(request('H'), scope),
      provider(request('I'), scope),
    ])
    expect(outlines.every((outline) => outline !== null)).toBe(true)
    // One yield after each glyph that ended a slice.
    expect(yields).toBe(2)
  })
})
