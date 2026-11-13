import {
  DataTexture,
  RedFormat,
  Texture,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi, type Mock } from 'vitest'

import { appendGlyphs } from '../src/atlas/appendAtlas.js'
import { appendCursors, rasterizeGlyphAtlas, type ShapeRows } from '../src/atlas/rasterize.js'
import type { GlyphRequest, GlyphSlot, RasterAtlas, SdfAtlas } from '../src/types.js'

const request: GlyphRequest = {
  key: 'face\u0000A',
  character: 'A',
  font: {
    key: 'face',
    canvasFont: '600 32px sans-serif',
    family: 'sans-serif',
    weight: '600',
    style: 'normal',
    stretch: '100%',
    variant: 'normal',
    kerning: 'auto',
    featureSettings: 'normal',
    variationSettings: 'normal',
    opticalSizing: 'auto',
    size: 16,
  },
}

/** A small seeded generator, so the randomized layouts replay exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function glyph(character: string): GlyphRequest {
  return { ...request, key: `face\u0000${character}`, character }
}

/** A CPU atlas over a raster's glyph map, which `buildSdfAtlas` shares the same way. */
function cpuAtlas(raster: RasterAtlas): Omit<SdfAtlas, 'dispose'> & { dispose: Mock<() => void> } {
  const { width, height } = raster
  return {
    texture: new DataTexture(
      new Uint8Array(width * height),
      width,
      height,
      RedFormat,
      UnsignedByteType,
    ),
    width,
    height,
    pxRange: raster.pxRange,
    bakeSize: raster.bakeSize,
    glyphs: raster.glyphs,
    mode: 'cpu',
    dispose: vi.fn<() => void>(),
  }
}

/** A renderer that only copies between textures, and that copy's mock. */
function copyingRenderer(): [WebGPURenderer, Mock<WebGPURenderer['copyTextureToTexture']>] {
  const copy = vi.fn<WebGPURenderer['copyTextureToTexture']>()
  return [{ copyTextureToTexture: copy } as unknown as WebGPURenderer, copy]
}

type Sizes = ReadonlyMap<string, readonly [number, number]>

/** Slot rectangles in texels, from the UVs of whole text glyphs: u0 = (x + 1.5) / width. */
function slotRects(atlas: Pick<RasterAtlas, 'glyphs' | 'width' | 'height'>, sizes: Sizes) {
  return Array.from(atlas.glyphs.values(), (slot) => {
    const [w, h] = sizes.get(slot.character)!
    return {
      key: slot.key,
      x: Math.round(slot.u0 * atlas.width - 1.5),
      y: Math.round(slot.v0 * atlas.height - 1.5),
      w,
      h,
    }
  })
}

function layoutProblems(atlas: Pick<RasterAtlas, 'glyphs' | 'width' | 'height'>, sizes: Sizes) {
  const rects = slotRects(atlas, sizes)
  const problems: string[] = []
  for (const a of rects) {
    if (a.x < 0 || a.y < 0 || a.x + a.w > atlas.width || a.y + a.h > atlas.height)
      problems.push(`${a.key} out of ${atlas.width}x${atlas.height}`)
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!
      const b = rects[j]!
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        problems.push(`${a.key} overlaps ${b.key}`)
    }
  }
  return problems
}

/** A shelf layout never starts one slot inside another's rows; a skyline does. */
function isSkylineLayout(atlas: Pick<RasterAtlas, 'glyphs' | 'width' | 'height'>, sizes: Sizes) {
  const rects = slotRects(atlas, sizes)
  return rects.some((a) => rects.some((b) => a.y < b.y && b.y < a.y + a.h))
}

describe('rasterizeGlyphAtlas', () => {
  let context: CanvasRenderingContext2D
  let fillText: ReturnType<typeof vi.fn>
  let measureText: ReturnType<typeof vi.fn>

  function mockSlotSizes(entries: readonly (readonly [string, readonly [number, number]])[]): {
    requests: GlyphRequest[]
    sizes: ReadonlyMap<string, readonly [number, number]>
  } {
    const sizes = new Map<string, readonly [number, number]>(entries)
    measureText.mockImplementation((character: string) => {
      const [slotWidth, slotHeight] = sizes.get(character)!
      const inkWidth = slotWidth - 6
      return {
        width: inkWidth,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: inkWidth,
        actualBoundingBoxAscent: slotHeight - 7,
        actualBoundingBoxDescent: 1,
        fontBoundingBoxAscent: slotHeight - 7,
        fontBoundingBoxDescent: 1,
      }
    })
    return {
      sizes,
      requests: Array.from(sizes, ([character]) => ({
        ...request,
        key: `face\u0000${character}`,
        character,
      })),
    }
  }

  beforeEach(() => {
    fillText = vi.fn()
    measureText = vi.fn(() => ({
      width: 10,
      actualBoundingBoxLeft: 1,
      actualBoundingBoxRight: 10,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    }))
    context = {
      font: '',
      fontKerning: 'auto',
      fontStretch: 'normal',
      fontVariantCaps: 'normal',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      fillStyle: '',
      clearRect: vi.fn(),
      fillText,
      measureText,
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Every read returns blank pixels: patches bake to empty fields. */
  function readsBlank(): void {
    Object.assign(context, {
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      })),
    })
  }

  /** With padding 2 a slot is exactly [width, height] texels, as `mockSlotSizes` lays out. */
  function useSlotSizes(sizes: Sizes): void {
    measureText.mockImplementation((character: string) => {
      const [slotWidth, slotHeight] = sizes.get(character)!
      const inkWidth = slotWidth - 6
      return {
        width: inkWidth,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: inkWidth,
        actualBoundingBoxAscent: slotHeight - 7,
        actualBoundingBoxDescent: 1,
        fontBoundingBoxAscent: slotHeight - 7,
        fontBoundingBoxDescent: 1,
      }
    })
  }

  it('packs candidates in a lower band, verifies colours, and preserves untested mono slots', async () => {
    const emoji = { ...request, key: 'emoji', character: '👨‍👩‍👧' }
    const read = vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4)
      data.set([40, 120, 220, 255], (2 * width + 2) * 4)
      return { data }
    })
    Object.assign(context, { getImageData: read })
    const atlas = await rasterizeGlyphAtlas(document, [request, emoji], { padding: 4 })
    // Two reads classify the candidate on a pack of its own, two encode the band.
    expect(read).toHaveBeenCalledTimes(4)
    expect(atlas.colorBand).toBeDefined()
    const top = atlas.colorBand!.top
    expect(top).toBeGreaterThan(0)
    expect(top % 4).toBe(0)
    expect(atlas.glyphs.get('emoji')!.v0 * atlas.height).toBeGreaterThan(top)
    expect(atlas.glyphs.get(request.key)!.v1 * atlas.height).toBeLessThan(top)
    expect(atlas.glyphs.get('emoji')!.color).toBe(true)
    expect(atlas.glyphs.get(request.key)!.color).toBeUndefined()
    expect(fillText.mock.calls.filter(([text]) => text === emoji.character)).toHaveLength(4)
    const none = await rasterizeGlyphAtlas(document, [request, emoji], { colorGlyphs: 'none' })
    expect(none.colorBand).toBeUndefined()
    expect(none.glyphs.get('emoji')!.color).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('bakes a candidate the font draws in the fill colour as text, in the text rows', async () => {
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly d?: string) {}
      },
    )
    const draws: { text: string; fill: string; rendering: string }[] = []
    fillText.mockImplementation((text: string) =>
      draws.push({ text, fill: context.fillStyle as string, rendering: context.textRendering }),
    )
    // Every read shows ink that follows the fill: a copyright sign, not an emoji.
    const read = vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4)
      const ink = context.fillStyle === '#000' ? 0 : 255
      data.set([ink, ink, ink, 255], (2 * width + 2) * 4)
      return { data }
    })
    Object.assign(context, {
      textRendering: 'auto',
      canvas: document.createElement('canvas'),
      getImageData: read,
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      fill: vi.fn(),
    })
    const sign = { ...request, key: 'sign', character: '\u00a9' }
    const shape: GlyphRequest = {
      ...request,
      key: 'shape',
      character: '',
      shape: {
        paths: [{ d: 'M0 0h10v10z', transform: [1, 0, 0, 1, 0, 0] }],
        box: [1000, 500],
        bounds: [100, 50, 600, 400],
      },
    }
    const atlas: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(
      document,
      [request, sign, shape],
      { padding: 4 },
    )
    // Tested in black and in white, then drawn once more as the text it is.
    expect(draws.filter((draw) => draw.text === sign.character)).toEqual([
      { text: sign.character, fill: '#000', rendering: 'auto' },
      { text: sign.character, fill: '#fff', rendering: 'auto' },
      { text: sign.character, fill: '#606060', rendering: 'geometricPrecision' },
    ])
    expect(read).toHaveBeenCalledTimes(2)
    // Tested without colour ink, as the slot's public flag says.
    expect(atlas.glyphs.get('sign')!.color).toBe(false)
    expect(atlas.glyphs.get(request.key)!.color).toBeUndefined()
    expect(atlas.colorBand).toBeUndefined()
    // With the text, above the rows of the shapes that keep their exact coverage.
    expect(atlas.glyphs.get('sign')!.v1 * atlas.height).toBeLessThan(atlas.shapeTop!)
    expect(atlas.glyphs.get('shape')!.v0 * atlas.height).toBeGreaterThan(atlas.shapeTop!)

    // Beside a real emoji, which keeps the band to itself. Slots are 21 texels wide here and
    // the emoji sorts first: its ink ignores the fill, the sign's follows it.
    const emoji = { ...request, key: 'emoji', character: '👨‍👩‍👧' }
    read.mockImplementation((_x, _y, width, height) => {
      const data = new Uint8ClampedArray(width * height * 4)
      const ink = context.fillStyle === '#000' ? 0 : 255
      data.set([40, 120, 220, 255], (2 * width + 2) * 4)
      data.set([ink, ink, ink, 255], (2 * width + 23) * 4)
      return { data }
    })
    const mixed = await rasterizeGlyphAtlas(document, [request, sign, emoji], { padding: 4 })
    const top = mixed.colorBand!.top
    expect(mixed.glyphs.get('emoji')!.color).toBe(true)
    expect(mixed.glyphs.get('emoji')!.v0 * mixed.height).toBeGreaterThan(top)
    expect(mixed.glyphs.get('sign')!.color).toBe(false)
    expect(mixed.glyphs.get('sign')!.v1 * mixed.height).toBeLessThan(top)
  })

  it('bakes on a canvas that is in the document with font smoothing off, and takes it out', async () => {
    const attached: boolean[] = []
    const canvases = new Set<HTMLCanvasElement>()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      canvases.add(this)
      return context
    } as never)
    fillText.mockImplementation(() => {
      for (const canvas of canvases) attached.push(canvas.isConnected)
    })
    // A page whose root would hand its own text settings down to a canvas in it.
    document.documentElement.dir = 'rtl'
    document.documentElement.lang = 'ja'
    try {
      const atlas = await rasterizeGlyphAtlas(document, [request])
      expect(attached).toEqual([true])
      const [canvas] = canvases
      expect(atlas.canvas).toBe(canvas)
      expect(canvas!.isConnected).toBe(false)
      const { style } = canvas!
      expect(style.getPropertyValue('display')).toBe('none')
      expect(style.getPropertyPriority('display')).toBe('important')
      expect(style.getPropertyValue('direction')).toBe('ltr')
      expect(style.getPropertyPriority('direction')).toBe('important')
      // jsdom drops the properties it does not know; a browser keeps the smoothing ones.
      expect(canvas!.dir).toBe('ltr')
      expect(canvas!.getAttribute('lang')).toBe('')

      // Out of the document again after a failure, an abort and a retried bake size.
      canvases.clear()
      fillText.mockImplementation(() => {
        throw new Error('draw failed')
      })
      await expect(rasterizeGlyphAtlas(document, [request])).rejects.toThrow('draw failed')
      const controller = new AbortController()
      fillText.mockImplementation(() => controller.abort(new Error('cancel bake')))
      await expect(
        rasterizeGlyphAtlas(document, [request, { ...request, key: 'B', character: 'B' }], {
          signal: controller.signal,
        }),
      ).rejects.toThrow('cancel bake')
      fillText.mockReset()
      measureText.mockImplementation(() => ({
        width: context.font.startsWith('600 32px') ? 200 : 10,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 10,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }))
      await rasterizeGlyphAtlas(document, [request], {
        maxAtlasSize: 64,
        adaptiveBakeSize: true,
      })
      expect(canvases.size).toBe(4)
      for (const each of canvases) expect(each.isConnected).toBe(false)
      expect(document.querySelector('canvas')).toBeNull()
    } finally {
      document.documentElement.removeAttribute('dir')
      document.documentElement.removeAttribute('lang')
    }
  })

  it('keeps A and B tintable inside a coloured browser-shaped A😀B slot', async () => {
    const mixed: GlyphRequest = {
      ...request,
      character: 'A😀B',
      shaping: { direction: 'ltr', language: 'en', letterSpacing: 0, wordSpacing: 0 },
    }
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      getImageData: vi.fn((_x, _y, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        const foreground = context.fillStyle === '#000' ? 0 : 255
        data.set([foreground, foreground, foreground, 255], (2 * width + 2) * 4)
        data.set([230, 160, 20, 255], (2 * width + 3) * 4)
        data.set([foreground, foreground, foreground, 255], (2 * width + 4) * 4)
        return { data }
      }),
    })
    const result = await rasterizeGlyphAtlas(document, [mixed], { padding: 4 })
    const data = result.colorBand!.data
    expect([...data.slice((2 * result.width + 2) * 4, (2 * result.width + 5) * 4)]).toEqual([
      0, 0, 0, 0, 230, 160, 20, 255, 0, 0, 0, 0,
    ])
    expect(result.glyphs.get(mixed.key)!.color).toBe(true)
  })

  it('starts an all-candidate band at zero and omits verified monochrome colour storage', async () => {
    const read = vi.fn((_x, _y, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }))
    Object.assign(context, { getImageData: read })
    const atlas = await rasterizeGlyphAtlas(document, [request], { colorGlyphs: 'all' })
    expect(read).toHaveBeenCalledWith(0, 0, atlas.width, atlas.height)
    expect(atlas.glyphs.get(request.key)!.color).toBe(false)
    expect(atlas.colorBand).toBeUndefined()
  })

  it('keeps tall emoji ink inside its slot even in monochrome mode', async () => {
    measureText.mockReturnValue({
      width: 10,
      actualBoundingBoxLeft: 1,
      actualBoundingBoxRight: 10,
      actualBoundingBoxAscent: 18,
      actualBoundingBoxDescent: 8,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    })
    const emoji = { ...request, key: 'emoji', character: '👍🏽' }
    const atlas = await rasterizeGlyphAtlas(document, [emoji], { colorGlyphs: 'none', padding: 4 })
    expect(atlas.glyphs.get('emoji')!.planeY0).toBe(-11.5)
    expect(atlas.glyphs.get('emoji')!.planeY1).toBe(21.5)
    expect(measureText).toHaveBeenCalledWith('👍🏽')
    expect(fillText).toHaveBeenCalledWith('👍🏽', expect.any(Number), expect.any(Number))
  })

  it('aborts between colour classification draw passes', async () => {
    const controller = new AbortController()
    Object.assign(context, {
      getImageData: vi.fn((_x, _y, width: number, height: number) => {
        controller.abort(new Error('cancel colour'))
        return { data: new Uint8ClampedArray(width * height * 4) }
      }),
    })
    await expect(
      rasterizeGlyphAtlas(document, [request], { colorGlyphs: 'all', signal: controller.signal }),
    ).rejects.toThrow('cancel colour')
    expect(fillText).toHaveBeenCalledOnce()
  })

  it('measures, packs, and draws unique glyphs into a compact aligned mask', async () => {
    const atlas = await rasterizeGlyphAtlas(document, [request], {
      bakeSize: 32,
      padding: 4,
      maxAtlasSize: 64,
    })

    expect(atlas.width % 4).toBe(0)
    expect(atlas.height % 4).toBe(0)
    expect(atlas.width).toBeLessThanOrEqual(64)
    expect(atlas.pxRange).toBe(4)
    expect(atlas.glyphs.get(request.key)?.character).toBe('A')

    // The sampled window must cover exactly the plane box, in texels: if the UVs
    // span the padded shelf slot instead, every glyph renders a few percent small.
    const slot = atlas.glyphs.get(request.key)
    if (!slot) throw new Error('Expected the glyph slot')
    expect((slot.u1 - slot.u0) * atlas.width).toBeCloseTo(slot.planeX1 - slot.planeX0, 6)
    expect((slot.v1 - slot.v0) * atlas.height).toBeCloseTo(slot.planeY1 - slot.planeY0, 6)
    expect(context.fontStretch).toBe('normal')
    expect(context.fontVariantCaps).toBe('normal')
    expect(fillText).toHaveBeenCalledOnce()

    await rasterizeGlyphAtlas(
      document,
      [
        {
          ...request,
          key: 'caps\u0000A',
          font: { ...request.font, key: 'caps', variant: 'tabular-nums all-small-caps' },
        },
      ],
      { bakeSize: 32, padding: 4, maxAtlasSize: 64 },
    )
    expect(context.fontVariantCaps).toBe('all-small-caps')
  })

  it('bakes text as its exact outline in mid grey, and colour glyphs and shapes as before', async () => {
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly d?: string) {}
      },
    )
    const fills: string[] = []
    Object.assign(context, {
      textRendering: 'auto',
      canvas: document.createElement('canvas'),
      // Ink that ignores the fill: the candidate is a colour glyph.
      getImageData: vi.fn((_x, _y, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        data.set([40, 120, 220, 255], (2 * width + 2) * 4)
        return { data }
      }),
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      fill: vi.fn(() => fills.push(context.fillStyle as string)),
    })
    const measured: string[] = []
    measureText.mockImplementation(() => {
      measured.push(context.textRendering)
      return {
        width: 10,
        actualBoundingBoxLeft: 1,
        actualBoundingBoxRight: 10,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }
    })
    const draws: { text: string; fill: string; rendering: string }[] = []
    fillText.mockImplementation((text: string) =>
      draws.push({ text, fill: context.fillStyle as string, rendering: context.textRendering }),
    )
    const emoji = { ...request, key: 'emoji', character: '👨‍👩‍👧' }
    const shape: GlyphRequest = {
      ...request,
      key: 'shape',
      character: '',
      shape: {
        paths: [{ d: 'M0 0h10v10z', transform: [1, 0, 0, 1, 0, 0] }],
        box: [1000, 500],
        bounds: [100, 50, 600, 400],
      },
    }
    await rasterizeGlyphAtlas(document, [request, emoji, shape], { padding: 4 })

    // Metrics are read before any draw changes the rendering mode: slots and advances are
    // those of the default mode.
    expect(measured).toEqual(['auto', 'auto'])
    // The outline itself, in the neutral middle of a rasterizer's contrast table.
    expect(draws.filter((draw) => draw.text === 'A')).toEqual([
      { text: 'A', fill: '#606060', rendering: 'geometricPrecision' },
    ])
    // The classification compares a black and a white draw of the default rendering: once on
    // a pack of the candidates alone, once in the band.
    expect(draws.filter((draw) => draw.text === emoji.character)).toEqual([
      { text: emoji.character, fill: '#000', rendering: 'auto' },
      { text: emoji.character, fill: '#fff', rendering: 'auto' },
      { text: emoji.character, fill: '#000', rendering: 'auto' },
      { text: emoji.character, fill: '#fff', rendering: 'auto' },
    ])
    expect(fills).toEqual(['#fff'])
  })

  it('packs monochrome shapes in rows of their own, below the text and above the colour band', async () => {
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly d?: string) {}
      },
    )
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      getImageData: vi.fn((_x, _y, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        data.set([40, 120, 220, 255], (2 * width + 2) * 4)
        return { data }
      }),
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      fill: vi.fn(),
    })
    const shape = (key: string, height: number): GlyphRequest => ({
      ...request,
      key,
      character: '',
      shape: {
        paths: [{ d: 'M0 0h10v10z', transform: [1, 0, 0, 1, 0, 0] }],
        box: [1000, 1000],
        bounds: [0, 0, 300, height],
      },
    })
    const emoji = { ...request, key: 'emoji', character: '👨‍👩‍👧' }
    const letters = ['B', 'C', 'D', 'E', 'F'].map((character) => ({
      ...request,
      key: `face\u0000${character}`,
      character,
    }))
    // The shapes are the tallest and the shortest slots: sorted by size alone they would
    // surround the text.
    const requests = [shape('tall', 900), request, ...letters, emoji, shape('short', 40)]
    // The declared result is the public raster; the shape rows ride on it as an internal extra.
    expectTypeOf(rasterizeGlyphAtlas).returns.toEqualTypeOf<Promise<RasterAtlas>>()
    const atlas: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(document, requests, {
      padding: 4,
    })
    const rows = (key: string): [number, number] => {
      const slot = atlas.glyphs.get(key)!
      return [slot.v0 * atlas.height, slot.v1 * atlas.height]
    }
    const top = atlas.shapeTop!
    expect(top).toBeGreaterThan(0)
    expect(top % 4).toBe(0)
    for (const text of [request, ...letters]) expect(rows(text.key)[1]).toBeLessThan(top)
    for (const key of ['tall', 'short']) {
      expect(rows(key)[0]).toBeGreaterThan(top)
      expect(rows(key)[1]).toBeLessThan(atlas.colorBand!.top)
    }
    expect(rows('emoji')[0]).toBeGreaterThan(atlas.colorBand!.top)

    // Shapes alone start at the first row; without shapes there is nothing to name.
    const only: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(
      document,
      [shape('only', 500)],
      {
        padding: 4,
      },
    )
    expect(only.shapeTop).toBe(0)
    const plain = await rasterizeGlyphAtlas(document, [request, ...letters, emoji], { padding: 4 })
    expect('shapeTop' in plain).toBe(false)
  })

  it('draws every slot from a whole-pixel origin, where a canvas puts its text anyway', async () => {
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
    })
    const WIDTH = 40.3
    measureText.mockImplementation(() => ({
      width: WIDTH,
      // Ink starts left of the origin by a fraction of a pixel.
      actualBoundingBoxLeft: 0.4,
      actualBoundingBoxRight: 40.1,
      // Stacked marks rise above the font box by a fraction of a pixel.
      actualBoundingBoxAscent: 12.3625,
      actualBoundingBoxDescent: 3.2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    }))
    const shaping = { direction: 'ltr', language: 'th', letterSpacing: 0, wordSpacing: 0 } as const
    const run: GlyphRequest = { ...request, key: 'run', character: 'กี่ปี้', shaping }
    // Three tiles of one run: each draws the whole run, moved left by its start.
    const tiles = [
      [0, 0.3],
      [0.3, 0.7],
      [0.7, 1],
    ].map(([from, to], index): GlyphRequest => ({
      ...request,
      key: `tile${String(index)}`,
      character: 'กี่ปี้ กี่ปี้',
      shaping: { ...shaping, slice: [from!, to!] },
    }))
    const requests = [run, request, ...tiles]
    for (const padding of [4, 4.3]) {
      fillText.mockClear()
      const atlas = await rasterizeGlyphAtlas(document, requests, { padding })
      const calls = fillText.mock.calls as [string, number, number][]
      expect(calls).toHaveLength(requests.length)
      // Draws follow the slot order, which sorts by size and then by key.
      const order = [...atlas.glyphs.keys()]
      for (const [index, [text, x, baseline]] of calls.entries()) {
        const where = `${text} at padding ${String(padding)}`
        const slot = atlas.glyphs.get(order[index]!)!
        const start = slot.key.startsWith('tile')
          ? WIDTH * tiles[Number(slot.key.slice(4))]!.shaping!.slice![0]
          : 0
        // The canvas is asked for a whole pixel both ways, so it has nothing to round.
        expect(Math.abs(x - Math.round(x)), where).toBeLessThan(1e-9)
        expect(Number.isInteger(baseline), where).toBe(true)
        // The slot says where the origin of its own glyph space then lies: a tile's start.
        expect(slot.u0 * atlas.width - slot.planeX0).toBeCloseTo(x + start, 9)
        expect(slot.v0 * atlas.height + slot.planeY1).toBeCloseTo(baseline, 9)
      }
      // The box still holds all the ink and the padding around it, within a pixel.
      const whole = atlas.glyphs.get('run')!
      expect(whole.planeY1 + 0.5).toBeGreaterThanOrEqual(12.3625 + padding)
      expect(whole.planeY1 + 0.5).toBeLessThan(12.3625 + padding + 1)
      expect(-(whole.planeX0 - 0.5)).toBeGreaterThanOrEqual(0.4 + padding)
      expect(-(whole.planeX0 - 0.5)).toBeLessThan(0.4 + padding + 1)
      // Tiles still join at their exact boundaries: an inner edge is the tile's own start or end.
      const [first, middle, last] = ['tile0', 'tile1', 'tile2'].map((id) => atlas.glyphs.get(id)!)
      expect(first!.planeX1).toBeCloseTo(first!.advance, 9)
      expect(middle!.planeX0).toBeCloseTo(0, 9)
      expect(middle!.planeX1).toBeCloseTo(middle!.advance, 9)
      expect(last!.planeX0).toBeCloseTo(0, 9)
    }
  })

  it('bounds the non-empty field of each text slot by its ink, the range and filtering', async () => {
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
    })
    // A small mark high in a tall font box: a quote sign's ink, far from the baseline.
    measureText.mockImplementation(() => ({
      width: 30,
      actualBoundingBoxLeft: -8.25,
      actualBoundingBoxRight: 14.5,
      actualBoundingBoxAscent: 70,
      actualBoundingBoxDescent: -50.5,
      fontBoundingBoxAscent: 76,
      fontBoundingBoxDescent: 20,
    }))
    const padding = 12
    const tile: GlyphRequest = {
      ...request,
      key: 'tile',
      character: 'quoted',
      shaping: {
        direction: 'ltr',
        language: 'en',
        letterSpacing: 0,
        wordSpacing: 0,
        slice: [0, 0.5],
      },
    }
    const emoji: GlyphRequest = { ...request, key: 'emoji', character: '😀' }
    const atlas = await rasterizeGlyphAtlas(document, [request, tile, emoji], {
      bakeSize: 96,
      padding,
      colorGlyphs: 'none',
    })
    const slot = atlas.glyphs.get(request.key)!
    const support = slot.support!
    expect(support).toBeDefined()
    // Plane units from atlas UV, through the slot's own mapping.
    const x = (u: number) => slot.planeX0 + (u - slot.u0) * atlas.width
    const y = (v: number) => slot.planeY1 - (v - slot.v0) * atlas.height
    // The ink box (8.25 .. 14.5 across, 50.5 .. 70 up) and pxRange / 2 + 2 texels around it,
    // out to whole texels: the field is empty beyond the range's half, plus a texel of
    // filtering and half a texel of slack for the metrics; and the macOS rise, 0.006 em.
    const reach = padding / 2 + 2 + 0.006 * 96
    expect(x(support.u0)).toBeCloseTo(Math.floor(8.25 - reach), 9)
    expect(x(support.u1)).toBeCloseTo(Math.ceil(14.5 + reach), 9)
    expect(y(support.v1)).toBeCloseTo(Math.floor(50.5 - reach), 9)
    expect(y(support.v0)).toBeCloseTo(Math.ceil(70 + reach), 9)
    // Inside the sampled window, and much smaller than it.
    expect(support.u0).toBeGreaterThanOrEqual(slot.u0)
    expect(support.u1).toBeLessThanOrEqual(slot.u1)
    expect(support.v0).toBeGreaterThanOrEqual(slot.v0)
    expect(support.v1).toBeLessThanOrEqual(slot.v1)
    expect((support.v1 - support.v0) / (slot.v1 - slot.v0)).toBeLessThan(0.4)
    // Tiles of a shaped line and colour candidates (even drawn as text) keep whole slots.
    expect(atlas.glyphs.get('tile')!.support).toBeUndefined()
    expect(atlas.glyphs.get('emoji')!.support).toBeUndefined()

    // Where the range's half and filtering reach past a narrow padding, the slot bounds it.
    measureText.mockImplementation(() => ({
      width: 30,
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: 31,
      actualBoundingBoxAscent: 76,
      actualBoundingBoxDescent: 20,
      fontBoundingBoxAscent: 76,
      fontBoundingBoxDescent: 20,
    }))
    const full = await rasterizeGlyphAtlas(document, [request], { bakeSize: 96, padding: 2 })
    const whole = full.glyphs.get(request.key)!
    expect(whole.support).toEqual({ u0: whole.u0, v0: whole.v0, u1: whole.u1, v1: whole.v1 })
  })

  it('bakes without a rendering mode where the canvas has none', async () => {
    const fills: string[] = []
    fillText.mockImplementation(() => fills.push(context.fillStyle as string))
    await rasterizeGlyphAtlas(document, [request], { padding: 4 })
    expect(fills).toEqual(['#606060'])
    expect('textRendering' in context).toBe(false)
  })

  it('applies run direction, language, and bake-scaled spacing without leaking state', async () => {
    Object.assign(context, {
      direction: 'inherit',
      letterSpacing: '0px',
      wordSpacing: '0px',
      lang: 'inherit',
      canvas: document.createElement('canvas'),
    })
    const draws: {
      text: string
      direction: string
      language: string
      letter: string
      word: string
    }[] = []
    fillText.mockImplementation((text: string) =>
      draws.push({
        text,
        direction: context.direction,
        language: context.canvas.lang,
        letter: context.letterSpacing,
        word: context.wordSpacing,
      }),
    )
    const shaped: GlyphRequest = {
      ...request,
      key: 'a-run',
      character: 'سلام',
      shaping: { direction: 'rtl', language: 'ar', letterSpacing: 0.125, wordSpacing: 0.25 },
    }
    await rasterizeGlyphAtlas(document, [shaped, { ...request, key: 'z-plain' }], { bakeSize: 32 })
    expect(draws).toEqual([
      { text: 'سلام', direction: 'rtl', language: 'ar', letter: '4px', word: '8px' },
      { text: 'A', direction: 'inherit', language: '', letter: '0px', word: '0px' },
    ])
  })

  it('crops internal tile quads while preserving padded raster context', async () => {
    const clip = vi.fn()
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip,
    })
    const requests: GlyphRequest[] = [0, 1].map((tile) => ({
      ...request,
      key: `tile-${tile}`,
      character: 'joined text',
      shaping: {
        direction: 'rtl',
        language: 'ar',
        letterSpacing: 0,
        wordSpacing: 0,
        slice: [tile / 2, (tile + 1) / 2],
      },
    }))
    const atlas = await rasterizeGlyphAtlas(document, requests, { bakeSize: 32, padding: 4 })
    const left = atlas.glyphs.get('tile-0')!
    const right = atlas.glyphs.get('tile-1')!
    expect(left.planeX0).toBeLessThan(0)
    expect(left.planeX1).toBe(left.advance)
    expect(right.planeX0).toBe(0)
    expect(right.planeX1).toBeGreaterThan(right.advance)
    for (const slot of [left, right])
      expect((slot.u1 - slot.u0) * atlas.width).toBeCloseTo(slot.planeX1 - slot.planeX0)
    expect(clip).toHaveBeenCalledTimes(2)
    expect(fillText.mock.calls.map((call) => String(call[0]))).toEqual([
      'joined text',
      'joined text',
    ])
  })

  it('fills vertical skyline gaps that fixed-height shelves cannot use', async () => {
    const { requests, sizes } = mockSlotSizes([
      ['A', [40, 44]],
      ['B', [20, 36]],
      ['C', [8, 28]],
    ])

    const atlas = await rasterizeGlyphAtlas(document, requests, {
      bakeSize: 32,
      padding: 2,
      maxAtlasSize: 64,
    })

    // A shelf needs 72px of height. Skyline packing puts C above the shorter B.
    expect([atlas.width, atlas.height]).toEqual([60, 64])
    expect(fillText).toHaveBeenCalledTimes(requests.length)

    const rectangles = requests.map(({ key, character }) => {
      const slot = atlas.glyphs.get(key)!
      const [width, height] = sizes.get(character)!
      return {
        x: Math.round(slot.u0 * atlas.width - 1.5),
        y: Math.round(slot.v0 * atlas.height - 1.5),
        width,
        height,
      }
    })
    for (const rectangle of rectangles) {
      expect(rectangle.x).toBeGreaterThanOrEqual(0)
      expect(rectangle.y).toBeGreaterThanOrEqual(0)
      expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(atlas.width)
      expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(atlas.height)
    }
    for (let left = 0; left < rectangles.length; left++) {
      for (let right = left + 1; right < rectangles.length; right++) {
        const a = rectangles[left]!
        const b = rectangles[right]!
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true)
      }
    }
  })

  it('searches aligned widths and retains the smallest packed texel area', async () => {
    const { requests } = mockSlotSizes([
      ['A', [36, 40]],
      ['B', [28, 20]],
    ])

    const atlas = await rasterizeGlyphAtlas(document, requests, {
      bakeSize: 32,
      padding: 2,
      maxAtlasSize: 64,
    })

    // The old first-success 64px shelf was 64x40; stacking is 15.6% smaller.
    expect([atlas.width, atlas.height]).toEqual([36, 60])
  })

  it('validates options, aborts, and reports masks that exceed the atlas', async () => {
    await expect(rasterizeGlyphAtlas(document, [request], { bakeSize: 8 })).rejects.toThrow(
      'bakeSize must be at least 16',
    )
    await expect(rasterizeGlyphAtlas(document, [request], { padding: 1 })).rejects.toThrow(
      'padding must be at least 2',
    )
    await expect(rasterizeGlyphAtlas(document, [request], { maxAtlasSize: 63 })).rejects.toThrow(
      'maxAtlasSize must be an integer of at least 64',
    )

    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(
      rasterizeGlyphAtlas(document, [request], { signal: controller.signal }),
    ).rejects.toThrow('cancelled')

    measureText.mockReturnValue({
      width: 58,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 58,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    })
    const aligned = await rasterizeGlyphAtlas(document, [request], {
      padding: 2,
      maxAtlasSize: 65,
    })
    expect(aligned.width).toBe(64)

    measureText.mockReturnValue({
      width: 59,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 59,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    })
    await expect(
      rasterizeGlyphAtlas(document, [request], { padding: 2, maxAtlasSize: 65 }),
    ).rejects.toThrow('exceed the 65×65 atlas limit')

    measureText.mockReturnValue({
      width: 100,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 100,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    })
    await expect(
      rasterizeGlyphAtlas(document, [request], { padding: 4, maxAtlasSize: 64 }),
    ).rejects.toThrow('exceed the 64×64 atlas limit')
  })

  it('only reduces overflowing atlases when adaptive baking is explicitly enabled', async () => {
    const requests: GlyphRequest[] = Array.from({ length: 150 }, (_, i) => ({
      ...request,
      font: { ...request.font, canvasFont: '600 96px sans-serif' },
      key: `face\u0000${String.fromCharCode(0x4e00 + i)}`,
      character: String.fromCharCode(0x4e00 + i),
    }))

    measureText.mockImplementation(() => {
      const size = Number.parseFloat(/([\d.]+)px/.exec(context.font)![1]!)
      return {
        width: size * 0.5,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: size * 0.5,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
        fontBoundingBoxAscent: size * 0.8,
        fontBoundingBoxDescent: size * 0.2,
      }
    })
    for (const options of [{}, { adaptiveBakeSize: false }]) {
      await expect(
        rasterizeGlyphAtlas(document, requests, { ...options, maxAtlasSize: 512 }),
      ).rejects.toThrow('atlas limit')
    }
    const atlas = await rasterizeGlyphAtlas(document, requests, {
      maxAtlasSize: 512,
      adaptiveBakeSize: true,
      bakeSize: 96,
    })

    expect(atlas.bakeSize).toBeLessThan(96)
    expect(atlas.bakeSize).toBeGreaterThanOrEqual(16)
    expect(atlas.width).toBeLessThanOrEqual(512)
    expect(atlas.height).toBeLessThanOrEqual(512)
    expect(requests[0]!.font.canvasFont).toBe('600 96px sans-serif')
    const fitting = await rasterizeGlyphAtlas(document, requests, { adaptiveBakeSize: true })
    expect(fitting.bakeSize).toBe(96)
    expect((await rasterizeGlyphAtlas(document, requests)).bakeSize).toBe(96)
  })

  it('reuses only the colour classifications of a matching previousAtlas', async () => {
    const sign = { ...request, key: 'sign', character: '©' }
    const emoji = { ...request, key: 'emoji', character: '👨‍👩‍👧' }
    const read = vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4)
      const ink = context.fillStyle === '#000' ? 0 : 255
      data.set([40, 120, 220, 255], (2 * width + 2) * 4)
      data.set([ink, ink, ink, 255], (2 * width + 23) * 4)
      return { data }
    })
    Object.assign(context, { getImageData: read })
    const cold = await rasterizeGlyphAtlas(document, [glyph('A'), sign, emoji], { padding: 4 })
    // Two reads classify the candidates on a pack of their own, two encode the band.
    expect(read).toHaveBeenCalledTimes(4)
    read.mockClear()
    measureText.mockClear()
    const warm = await rasterizeGlyphAtlas(document, [glyph('A'), glyph('B'), sign, emoji], {
      padding: 4,
      previousAtlas: cold,
    })
    // The scratch pair is skipped; the band is still drawn and read, every glyph measured.
    expect(read).toHaveBeenCalledTimes(2)
    expect(measureText).toHaveBeenCalledTimes(4)
    expect(warm.glyphs.get(sign.key)!.color).toBe(false)
    expect(warm.glyphs.get(emoji.key)!.color).toBe(true)
    // Plain values: a copy of the glyph map serves as well as the atlas itself.
    read.mockClear()
    await rasterizeGlyphAtlas(document, [glyph('A'), sign, emoji], {
      padding: 4,
      previousAtlas: { ...cold, glyphs: new Map(cold.glyphs) },
    })
    expect(read).toHaveBeenCalledTimes(2)
    // Text-presentation symbols and GPU rebuilds whose candidates already classified as monochrome stay GPU-backed.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContext.mockClear()
    await rasterizeGlyphAtlas(document, [glyph('A'), sign], {
      padding: 4,
      gpuUpload: true,
    })
    expect(getContext).toHaveBeenCalledWith('2d', { willReadFrequently: false })
    getContext.mockClear()
    await rasterizeGlyphAtlas(document, [glyph('A'), emoji], {
      padding: 4,
      gpuUpload: true,
    })
    expect(getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true })
    getContext.mockClear()
    await rasterizeGlyphAtlas(document, [glyph('A'), emoji], {
      padding: 4,
      gpuUpload: true,
      previousAtlas: {
        ...cold,
        glyphs: new Map([[emoji.key, { ...cold.glyphs.get(emoji.key)!, color: false }]]),
      },
    })
    expect(getContext).toHaveBeenCalledWith('2d', { willReadFrequently: false })
    // Another padding or bake size classifies again.
    for (const options of [{ padding: 6 }, { padding: 4, bakeSize: 64 }]) {
      read.mockClear()
      await rasterizeGlyphAtlas(document, [glyph('A'), sign, emoji], {
        ...options,
        previousAtlas: cold,
      })
      expect(read).toHaveBeenCalledTimes(4)
    }
  })

  it('keeps a bitmap shape in the colour band whatever a previous atlas says', async () => {
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly d?: string) {}
      },
    )
    // Every pixel follows the fill, so the shape's ink classifies as monochrome.
    let reads = 0
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        const ink = reads++ % 2 === 0 ? 0 : 255
        for (let i = 0; i < width * height; i++) data.set([ink, ink, ink, 255], i * 4)
        return { data }
      }),
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      fill: vi.fn(),
    })
    const icon: GlyphRequest = {
      ...request,
      key: 'icon',
      character: '',
      shape: {
        paths: [{ d: 'M0 0h10v10z', transform: [1, 0, 0, 1, 0, 0] }],
        box: [1000, 1000],
        bounds: [0, 0, 300, 300],
        bitmap: true,
      },
    }
    const cold: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(document, [glyph('A'), icon], {
      padding: 4,
    })
    expect(cold.glyphs.get('icon')!.color).toBe(false)
    expect(cold.shapeTop).toBeUndefined()
    // A warm rebuild used to move it to the shape rows, where it lost the text tone.
    const warm: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(
      document,
      [glyph('A'), glyph('B'), icon],
      { padding: 4, previousAtlas: cold },
    )
    expect(warm.shapeTop).toBeUndefined()
    expect(warm.glyphs.get('icon')!.color).toBe(false)
  })

  it('records an append cursor on request, with headroom above the shapes and colour band', async () => {
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly d?: string) {}
      },
    )
    Object.assign(context, {
      canvas: document.createElement('canvas'),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        data.set([40, 120, 220, 255], (2 * width + 2) * 4)
        return { data }
      }),
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      fill: vi.fn(),
    })
    const shape: GlyphRequest = {
      ...request,
      key: 'shape',
      character: '',
      shape: {
        paths: [{ d: 'M0 0h10v10z', transform: [1, 0, 0, 1, 0, 0] }],
        box: [1000, 500],
        bounds: [100, 50, 600, 400],
      },
    }
    const emoji = { ...request, key: 'emoji', character: '👨‍👩‍👧' }
    const requests = [glyph('A'), glyph('B'), shape, emoji]
    const tight: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(document, requests, {
      padding: 4,
    })
    expect(appendCursors.get(tight.glyphs)).toBeUndefined()
    const cursorOnly: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(document, requests, {
      padding: 4,
      appendable: true,
    })
    expect(cursorOnly.height).toBe(tight.height)
    expect(appendCursors.get(cursorOnly.glyphs)).toMatchObject({
      width: tight.width,
      height: tight.height,
      bakeSize: 96,
      pxRange: 4,
      colorGlyphs: 'emoji',
      bottom: tight.shapeTop,
    })
    const roomy: RasterAtlas & ShapeRows = await rasterizeGlyphAtlas(document, requests, {
      padding: 4,
      appendable: 'headroom',
    })
    const room = roomy.height - tight.height
    // A tallest text slot or a quarter of the text rows, whichever is more.
    expect(room).toBeGreaterThan(0)
    expect(room % 4).toBe(0)
    // At least two of the widest text slot (21 texels here) wide, aligned to 4, whatever the
    // shapes' width.
    expect(roomy.width).toBe(Math.max(tight.width, 44))
    expect(roomy.shapeTop).toBe(tight.shapeTop! + room)
    expect(roomy.colorBand!.top).toBe(tight.colorBand!.top + room)
    expect(appendCursors.get(roomy.glyphs)!.bottom).toBe(roomy.shapeTop)
    for (const key of [glyph('A').key, glyph('B').key]) {
      expect(roomy.glyphs.get(key)!.u0 * roomy.width).toBeCloseTo(
        tight.glyphs.get(key)!.u0 * tight.width,
        9,
      )
      expect(roomy.glyphs.get(key)!.v0 * roomy.height).toBeCloseTo(
        tight.glyphs.get(key)!.v0 * tight.height,
        9,
      )
    }
    expect(roomy.glyphs.get('shape')!.v0 * roomy.height).toBeCloseTo(
      tight.glyphs.get('shape')!.v0 * tight.height + room,
      9,
    )
  })

  it('appends into the free text rows of shelf and skyline packings without overlap or loss', async () => {
    readsBlank()
    const sizes = new Map<string, readonly [number, number]>()
    useSlotSizes(sizes)
    const [renderer] = copyingRenderer()
    let appends = 0
    let rebuilds = 0
    let wrapped = 0
    let skyline = 0
    const problems: string[] = []
    for (let trial = 0; trial < 120; trial++) {
      const random = mulberry32(1000 + trial)
      sizes.clear()
      let next = 0
      const make = (): string => {
        const character = String.fromCodePoint(0x4e00 + next++)
        // Mixed heights favour skyline packings.
        sizes.set(character, [8 + Math.floor(random() * 50), 8 + Math.floor(random() * 50)])
        return character
      }
      let characters = Array.from({ length: 5 + Math.floor(random() * 40) }, make)
      let atlas = cpuAtlas(
        await rasterizeGlyphAtlas(document, characters.map(glyph), {
          padding: 2,
          maxAtlasSize: 512,
          appendable: true,
        }),
      )
      for (let round = 0; round < 8; round++) {
        // A capture holds its current text only: some glyphs go, new ones come.
        if (random() < 0.3) characters = characters.filter(() => random() < 0.8)
        characters = [...characters, ...Array.from({ length: 1 + Math.floor(random() * 4) }, make)]
        const where = `trial ${trial} round ${round}`
        const patched = await appendGlyphs(
          renderer,
          document,
          atlas,
          characters.map(glyph),
          {},
          new AbortController().signal,
        )
        if (patched) {
          appends++
          if (patched.texture !== atlas.texture || patched.dispose !== atlas.dispose)
            problems.push(`${where}: a new texture`)
          if (patched.width !== atlas.width || patched.height !== atlas.height)
            problems.push(`${where}: resized`)
          for (const [key, slot] of atlas.glyphs)
            if (patched.glyphs.get(key) !== slot) problems.push(`${where}: moved ${key}`)
          if (slotRects(patched, sizes).some((rect) => !atlas.glyphs.has(rect.key) && rect.x === 0))
            wrapped++
          atlas = patched as typeof atlas
        } else {
          rebuilds++
          atlas = cpuAtlas(
            await rasterizeGlyphAtlas(document, characters.map(glyph), {
              padding: 2,
              maxAtlasSize: 512,
              appendable: 'headroom',
            }),
          )
          if (isSkylineLayout(atlas, sizes)) skyline++
        }
        for (const issue of layoutProblems(atlas, sizes)) problems.push(`${where}: ${issue}`)
        for (const character of characters)
          if (!atlas.glyphs.has(glyph(character).key)) problems.push(`${where}: lost ${character}`)
      }
    }
    expect(problems).toEqual([])
    expect(appends).toBeGreaterThan(100)
    expect(wrapped).toBeGreaterThan(0)
    expect(rebuilds).toBeGreaterThan(0)
    expect(skyline).toBeGreaterThan(0)
  })

  it('gives a patched glyph the slot formulas of a full build, at the cursor', async () => {
    readsBlank()
    const { requests } = mockSlotSizes([
      ['A', [30, 40]],
      ['B', [26, 40]],
      ['C', [22, 38]],
    ])
    const [renderer, copy] = copyingRenderer()
    const base = cpuAtlas(
      await rasterizeGlyphAtlas(document, requests.slice(0, 2), {
        padding: 2,
        appendable: 'headroom',
      }),
    )
    const cursor = appendCursors.get(base.glyphs)!
    fillText.mockClear()
    const patched = (await appendGlyphs(
      renderer,
      document,
      base,
      requests,
      {},
      new AbortController().signal,
    ))!
    const drawn = [...fillText.mock.calls]
    const fill = context.fillStyle
    const cold = await rasterizeGlyphAtlas(document, requests, { padding: 2 })
    const fresh = patched.glyphs.get(glyph('C').key)!
    const reference = cold.glyphs.get(glyph('C').key)!
    const placed = (slot: GlyphSlot, width: number, height: number) => ({
      ...slot,
      u0: 0,
      v0: 0,
      // In texels from the slot's sampled origin.
      u1: (slot.u1 - slot.u0) * width,
      v1: (slot.v1 - slot.v0) * height,
      support: slot.support && {
        u0: (slot.support.u0 - slot.u0) * width,
        v0: (slot.support.v0 - slot.v0) * height,
        u1: (slot.support.u1 - slot.u0) * width,
        v1: (slot.support.v1 - slot.v0) * height,
      },
    })
    expect(fresh.support).toBeDefined()
    const expected = placed(reference, cold.width, cold.height)
    const actual = placed(fresh, patched.width, patched.height)
    const texels = (slot: typeof actual): number[] => [
      slot.u1,
      slot.v1,
      slot.support!.u0,
      slot.support!.v0,
      slot.support!.u1,
      slot.support!.v1,
    ]
    texels(actual).forEach((value, index) => {
      expect(value).toBeCloseTo(texels(expected)[index]!, 9)
    })
    expect({ ...actual, u1: 0, v1: 0, support: null }).toEqual({
      ...expected,
      u1: 0,
      v1: 0,
      support: null,
    })
    // At the cursor (wrapped to the headroom when the last row is full), drawn once by the
    // text rules on the patch canvas, and copied there.
    const x = Math.round(fresh.u0 * patched.width - 1.5)
    const y = Math.round(fresh.v0 * patched.height - 1.5)
    expect([x, y]).toEqual(
      cursor.x + 22 <= cursor.width ? [cursor.x, cursor.y] : [0, cursor.y + cursor.rowHeight],
    )
    expect(drawn).toEqual([['C', 3, 34]])
    expect(fill).toBe('#606060')
    expect(copy).toHaveBeenCalledOnce()
    const [source, target, box, position] = copy.mock.calls[0]!
    expect(target).toBe(base.texture)
    expect(source).not.toBe(base.texture)
    expect([box!.min.x, box!.min.y, box!.max.x, box!.max.y]).toEqual([0, 0, 22, 38])
    expect([position!.x, position!.y]).toEqual([x, y])
    expect(appendCursors.get(patched.glyphs)).toMatchObject({ x: x + 22, y })
    expect(appendCursors.get(base.glyphs)).toBe(cursor)
  })

  it('aborts a patch before it reaches the texture and leaves the atlas appendable', async () => {
    readsBlank()
    const { requests } = mockSlotSizes([
      ['A', [30, 40]],
      ['B', [26, 40]],
      ['C', [22, 38]],
      ['D', [21, 38]],
    ])
    const [renderer, copy] = copyingRenderer()
    const base = cpuAtlas(
      await rasterizeGlyphAtlas(document, requests.slice(0, 2), {
        padding: 2,
        appendable: 'headroom',
      }),
    )
    const cursor = appendCursors.get(base.glyphs)
    const controller = new AbortController()
    fillText.mockImplementationOnce(() => {
      controller.abort(new DOMException('superseded', 'AbortError'))
    })
    await expect(
      appendGlyphs(renderer, document, base, requests, {}, controller.signal),
    ).rejects.toThrow('superseded')
    expect(copy).not.toHaveBeenCalled()
    expect(appendCursors.get(base.glyphs)).toBe(cursor)
    expect(base.dispose).not.toHaveBeenCalled()
    expect(document.querySelector('canvas')).toBeNull()
    const retry = await appendGlyphs(
      renderer,
      document,
      base,
      requests,
      {},
      new AbortController().signal,
    )
    expect(retry!.glyphs.size).toBe(4)
    expect(copy).toHaveBeenCalled()
  })

  it('keeps the glyphs a capture drops until a full build compacts the atlas', async () => {
    readsBlank()
    const { requests } = mockSlotSizes([
      ['A', [30, 40]],
      ['B', [26, 40]],
      ['C', [22, 38]],
    ])
    const base = cpuAtlas(
      await rasterizeGlyphAtlas(document, requests.slice(0, 2), {
        padding: 2,
        appendable: 'headroom',
      }),
    )
    const patched = await appendGlyphs(
      copyingRenderer()[0],
      document,
      base,
      [requests[2]!],
      {},
      new AbortController().signal,
    )
    expect([...patched!.glyphs.values()].map((slot) => slot.character).sort()).toEqual([
      'A',
      'B',
      'C',
    ])
  })

  it('leaves shapes, colour glyphs, other bake sizes and what does not fit to a full build', async () => {
    let colour = true
    Object.assign(context, {
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        const ink = context.fillStyle === '#000' ? 0 : 255
        data.set(colour ? [40, 120, 220, 255] : [ink, ink, ink, 255], (2 * width + 2) * 4)
        return { data }
      }),
    })
    const [renderer, copy] = copyingRenderer()
    const signal = new AbortController().signal
    const raster = await rasterizeGlyphAtlas(document, [glyph('A')], {
      padding: 4,
      appendable: 'headroom',
    })
    const base = cpuAtlas(raster)
    const emoji = { ...request, key: 'emoji', character: '😀' }
    const shape: GlyphRequest = {
      ...request,
      key: 'shape',
      character: '',
      shape: { paths: [], box: [1000, 1000], bounds: [0, 0, 100, 100] },
    }
    const refused = [
      // No cursor: an atlas that DomSdf did not build for appends.
      () =>
        rasterizeGlyphAtlas(document, [glyph('A')], { padding: 4 }).then((plain) =>
          appendGlyphs(renderer, document, cpuAtlas(plain), [glyph('B')], {}, signal),
        ),
      () => appendGlyphs(renderer, document, base, [glyph('B'), shape], {}, signal),
      () => appendGlyphs(renderer, document, base, [emoji], {}, signal),
      // A cursor baked at another size, as an adaptive bake lowers it.
      () => appendGlyphs(renderer, document, base, [glyph('B')], { bakeSize: 64 }, signal),
      () => appendGlyphs(renderer, document, base, [glyph('B')], { colorGlyphs: 'all' }, signal),
      // Nothing new.
      () => appendGlyphs(renderer, document, base, [glyph('A')], {}, signal),
    ]
    for (const attempt of refused) expect(await attempt()).toBeNull()
    expect(copy).not.toHaveBeenCalled()

    // A candidate the font draws in the fill alone is text, and takes the text rows.
    colour = false
    fillText.mockClear()
    const patched = await appendGlyphs(renderer, document, base, [emoji], {}, signal)
    expect(patched!.glyphs.get('emoji')!.color).toBe(false)
    expect(fillText.mock.calls.map(([text]) => String(text))).toEqual(['😀', '😀', '😀'])
    expect(context.fillStyle).toBe('#606060')

    // Too wide for the atlas, too tall for the free rows, and past the texel budget.
    measureText.mockImplementation((character: string) => {
      const [width, height] =
        character === 'W' ? [400, 10] : character === 'T' ? [10, 400] : [60, 30]
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: height,
        actualBoundingBoxDescent: 0,
        fontBoundingBoxAscent: height,
        fontBoundingBoxDescent: 0,
      }
    })
    for (const character of ['W', 'T'])
      expect(
        await appendGlyphs(renderer, document, base, [glyph(character)], {}, signal),
      ).toBeNull()
    const wide = mockSlotSizes([
      ['X', [800, 600]],
      ['Y', [600, 500]],
    ])
    const large = cpuAtlas(
      await rasterizeGlyphAtlas(document, wide.requests.slice(0, 1), {
        padding: 2,
        appendable: 'headroom',
      }),
    )
    const room = appendCursors.get(large.glyphs)!
    expect(room.bottom - room.y - room.rowHeight).toBeGreaterThanOrEqual(500)
    copy.mockClear()
    expect(await appendGlyphs(renderer, document, large, wide.requests, {}, signal)).toBeNull()
    expect(copy).not.toHaveBeenCalled()
  })

  it('refuses a patch past its texel budget before reading back its colour candidates', async () => {
    const read = vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }))
    Object.assign(context, { getImageData: read })
    const { requests } = mockSlotSizes([
      ['A', [600, 400]],
      ['😀', [580, 380]],
      ['😁', [580, 380]],
    ])
    const base = cpuAtlas(
      await rasterizeGlyphAtlas(document, requests.slice(0, 1), {
        padding: 2,
        appendable: 'headroom',
      }),
    )
    // Both emoji fit the free rows, but together they pass the 2^18-texel budget.
    const cursor = appendCursors.get(base.glyphs)!
    expect(cursor.bottom - cursor.y - cursor.rowHeight).toBeGreaterThanOrEqual(380)
    read.mockClear()
    const [renderer, copy] = copyingRenderer()
    expect(
      await appendGlyphs(renderer, document, base, requests, {}, new AbortController().signal),
    ).toBeNull()
    // The full build that follows classifies them anyway: the declined patch reads nothing.
    expect(read).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })

  it('patches a CPU atlas’s bytes row by row, and uploads them whole when it cannot copy', async () => {
    // Ink everywhere: each patched texel is inside a glyph.
    Object.assign(context, {
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(255),
      })),
    })
    const { requests } = mockSlotSizes([
      ['A', [40, 40]],
      ['D', [40, 20]],
      ['E', [40, 20]],
    ])
    const raster = await rasterizeGlyphAtlas(document, requests.slice(0, 1), {
      padding: 2,
      appendable: 'headroom',
    })
    // A's 40×40, widened to two of it, with 40 rows of headroom: D ends A's row, E wraps.
    expect([raster.width, raster.height]).toEqual([80, 80])
    const base = cpuAtlas(raster)
    base.texture.generateMipmaps = true
    const target = base.texture as DataTexture & { mipmapsAutoUpdate: boolean }
    const mipmapsDuringCopies: boolean[] = []
    const [renderer, copy] = copyingRenderer()
    copy.mockImplementation(() => {
      mipmapsDuringCopies.push(target.mipmapsAutoUpdate)
    })
    const signal = new AbortController().signal
    const patched = await appendGlyphs(renderer, document, base, requests, {}, signal)
    const calls = copy.mock.calls
    expect(
      calls.map(([, , box, position]) => [
        box!.min.x,
        box!.min.y,
        box!.max.x,
        box!.max.y,
        position!.x,
        position!.y,
      ]),
    ).toEqual([
      [0, 0, 40, 20, 40, 0],
      [0, 20, 40, 40, 0, 40],
    ])
    // Only the last copy regenerates the mipmaps.
    expect(mipmapsDuringCopies).toEqual([false, true])
    expect(target.mipmapsAutoUpdate).toBe(true)
    const bytes = target.image.data as Uint8Array
    const patchedTexel = (index: number): boolean => {
      const x = index % 80
      const y = Math.floor(index / 80)
      return (x >= 40 && y < 20) || (x < 40 && y >= 40 && y < 60)
    }
    expect(bytes.every((byte, index) => byte === (patchedTexel(index) ? 255 : 0))).toBe(true)
    expect(appendCursors.get(patched!.glyphs)).toMatchObject({ x: 40, y: 40, rowHeight: 20 })

    // No copy: the patched bytes go up whole. A render target's texture has no bytes to send.
    const version = target.version
    bytes.fill(0)
    const stale = { copyTextureToTexture: undefined } as unknown as WebGPURenderer
    expect(await appendGlyphs(stale, document, base, requests, {}, signal)).not.toBeNull()
    expect(target.version).toBe(version + 1)
    expect(bytes.every((byte, index) => byte === (patchedTexel(index) ? 255 : 0))).toBe(true)
    const gpu = { ...base, texture: new Texture() }
    appendCursors.set(gpu.glyphs, appendCursors.get(base.glyphs)!)
    expect(await appendGlyphs(stale, document, gpu, requests, {}, signal)).toBeNull()
  })
})
