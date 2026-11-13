import type {
  ColorGlyphMode,
  GlyphRequest,
  GlyphSlot,
  RasterAtlas,
  RasterColorBand,
} from '../types.js'
import { isEmojiCandidate, isEmojiGrapheme } from '../dom/clusters.js'
import type { setShapingContext } from '../dom/browserShaping.js'

type ShapingContext = typeof setShapingContext

/** @internal Shared measured slot used by the lazy shape rasterizer. */
export interface MeasuredGlyph {
  readonly request: GlyphRequest
  readonly width: number
  readonly height: number
  readonly planeX0: number
  readonly planeY0: number
  readonly planeX1: number
  readonly planeY1: number
  readonly descent: number
  readonly advance: number
  readonly drawOffsetX: number
  /**
   * The ink box of a text glyph in plane units (x0, y0, x1, y1, y up from the baseline), from
   * the canvas's own metrics; absent where the slot is drawn whole.
   */
  readonly ink?: readonly [number, number, number, number]
  x: number
  y: number
}

/**
 * @internal The first atlas row of the monochrome shapes, when the raster holds any. They are
 * packed below the text so that a material can tell them from text by their place in the atlas.
 */
export interface ShapeRows {
  readonly shapeTop?: number
}

/**
 * @internal Where later text glyphs fit in an atlas without moving any slot: a shelf cursor
 * over its text rows, which end at `bottom`, the first row of its shapes or colour band (or its
 * height). Every slot that reaches row `y` or below ends left of `x`; below `y + rowHeight`
 * the text rows are free.
 */
export interface AppendCursor {
  readonly width: number
  readonly height: number
  readonly bakeSize: number
  readonly pxRange: number
  readonly colorGlyphs: ColorGlyphMode
  readonly bottom: number
  readonly x: number
  readonly y: number
  readonly rowHeight: number
}

/**
 * @internal The cursors of the rasters built with `appendable`, keyed by their glyph map, which
 * every `SdfAtlas` built from the raster shares. A few numbers each: no canvas is kept.
 */
export const appendCursors = new WeakMap<ReadonlyMap<string, GlyphSlot>, AppendCursor>()

interface PackedGlyphs {
  width: number
  height: number
}

interface CanvasFontContext extends CanvasRenderingContext2D {
  fontKerning: CanvasFontKerning
  fontStretch: CanvasFontStretch
  fontVariantCaps: CanvasFontVariantCaps
  letterSpacing: string
  wordSpacing: string
}

export interface RasterizeOptions {
  /** Colour-glyph detection; defaults to 'emoji'. */
  colorGlyphs?: ColorGlyphMode
  /** Canvas font raster size in pixels; must be at least `16`. Defaults to `96`. */
  bakeSize?: number
  /**
   * Retry overflowing atlases at a smaller bake size, down to 16px.
   * Defaults to `false`; fitting atlases keep their requested resolution.
   */
  adaptiveBakeSize?: boolean
  /**
   * Glyph slot padding in texels; must be at least `2`. Defaults to `12`. The
   * padding doubles as the SDF pixel range (`RasterAtlas.pxRange`).
   */
  padding?: number
  /**
   * Maximum atlas dimension in texels; must be an integer of at least `64`.
   * Defaults to `2048`. Glyphs that cannot pack reject instead of dropping. Text, monochrome
   * shapes and colour glyphs take rows of their own, one kind below the other.
   */
  maxAtlasSize?: number
  /** Aborts the rasterization between font waits and glyph draws. */
  signal?: AbortSignal
  /**
   * An atlas built earlier for the same fonts, with this `bakeSize` and `padding`
   * (`pxRange`): a colour candidate whose slot there already carries `GlyphSlot.color` keeps
   * that classification, instead of being drawn twice on a scratch canvas and read back.
   * Bitmap SVG shapes and glyphs it lacks are classified as usual, and every glyph is still
   * measured, packed and drawn: only the classification is reused. Omit it after a webfont
   * swap. `DomSdf` passes its retained atlas when a capture's new glyphs rebuild it in full.
   */
  previousAtlas?: Pick<RasterAtlas, 'glyphs' | 'bakeSize' | 'pxRange'> | undefined
  /**
   * @internal Set by `DomSdf` for its own SDF atlases. The raster then records its
   * `AppendCursor` in `appendCursors`, so that `appendAtlas.ts` can draw later text glyphs
   * into the live texture. `'headroom'` also leaves free text rows for them, within
   * `maxAtlasSize`: a tallest text slot, or a quarter of the text rows when more, between
   * the text and the shapes and colour band, which therefore keep their rows across appends,
   * in an atlas at least two of its widest text glyphs wide. DomSdf asks for it once an
   * instance has gained glyphs; a capture that never gains any stays tight.
   */
  appendable?: boolean | 'headroom' | undefined
  /**
   * @internal Set by `DomSdf` when only a WebGPU atlas uploads the raster. Without colour
   * candidates, which are read back, the bake canvas is then GPU-backed (no
   * `willReadFrequently`): its first draw on a page skips the software canvas's set-up, 7 to
   * 12 ms on an M3 Max, and the atlas copies it on the GPU. Reading such a canvas back takes
   * hundreds of milliseconds, which only the CPU fallback of a failed GPU build pays.
   */
  gpuUpload?: boolean | undefined
}

/** @internal Shared atlas compatibility and raster candidacy rule. */
export function isColorCandidate(request: GlyphRequest, mode: ColorGlyphMode = 'emoji'): boolean {
  if (request.shape) return request.shape.bitmap === true
  return mode === 'all' || (mode === 'emoji' && isEmojiCandidate(request.character))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The atlas build was aborted', 'AbortError')
  }
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)))
}

function align4(value: number): number {
  return Math.max(4, Math.ceil(value / 4) * 4)
}

const CANVAS_FONT_STRETCHES = [
  ['ultra-condensed', 50],
  ['extra-condensed', 62.5],
  ['condensed', 75],
  ['semi-condensed', 87.5],
  ['normal', 100],
  ['semi-expanded', 112.5],
  ['expanded', 125],
  ['extra-expanded', 150],
  ['ultra-expanded', 200],
] as const satisfies readonly (readonly [CanvasFontStretch, number])[]

function canvasFontStretch(value: string): CanvasFontStretch {
  if (value === '100%' || value === 'normal') return 'normal'
  const percentage = Number.parseFloat(value)
  if (!Number.isFinite(percentage)) {
    return CANVAS_FONT_STRETCHES.find(([name]) => name === value)?.[0] ?? 'normal'
  }
  return CANVAS_FONT_STRETCHES.reduce((a, b) =>
    Math.abs(b[1] - percentage) < Math.abs(a[1] - percentage) ? b : a,
  )[0]
}

/** @internal The bake canvas's font state for a request, shared with the outline tracer. */
export function setFontContext(
  context: CanvasRenderingContext2D,
  request: GlyphRequest,
  shaping: ShapingContext | undefined,
  lastFont: GlyphRequest['font'] | null,
): GlyphRequest['font'] {
  const { font } = request
  if (lastFont !== font) {
    const extended: CanvasFontContext = context
    context.font = font.canvasFont
    if (!lastFont) {
      context.textAlign = 'left'
      context.textBaseline = 'alphabetic'
    }
    if ('fontKerning' in extended) extended.fontKerning = font.kerning as CanvasFontKerning
    if ('fontStretch' in extended) extended.fontStretch = canvasFontStretch(font.stretch)
    if ('fontVariantCaps' in extended)
      extended.fontVariantCaps =
        (/\b(?:(?:all-)?(?:small|petite)-caps|unicase|titling-caps)\b/.exec(font.variant)?.[0] ??
          'normal') as CanvasFontVariantCaps
  }
  shaping?.(context, request)
  return font
}

/** @internal Measures one text glyph's slot; `appendAtlas.ts` shares it with the cold build. */
export function measureGlyph(
  context: CanvasRenderingContext2D,
  request: GlyphRequest,
  padding: number,
  shaping: ShapingContext | undefined,
  candidate = false,
  lastFont: GlyphRequest['font'] | null = null,
): [MeasuredGlyph, GlyphRequest['font']] {
  const nextFont = setFontContext(context, request, shaping, lastFont)
  const metrics = context.measureText(request.character)
  const slice = request.shaping?.slice
  const from = slice?.[0] ?? 0
  const to = slice?.[1] ?? 1
  const advance = metrics.width * (to - from)
  const left = from === 0 ? Math.max(0, metrics.actualBoundingBoxLeft) : 0
  const right = slice
    ? advance + (to === 1 ? Math.max(0, metrics.actualBoundingBoxRight - metrics.width) : 0)
    : Math.max(metrics.width, metrics.actualBoundingBoxRight)
  const ascent = Math.max(1, metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent)
  const descent = Math.max(1, metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent)
  // A canvas draws text on a whole pixel row and, across, on a quarter pixel at best, whatever
  // origin it is given. The slot's origin is therefore a whole pixel: ink left of the origin
  // or taller than the font box was otherwise baked up to half a texel off, and the tiles of
  // a sliced run a quarter texel off each other.
  const drawOffsetX = metrics.width * from
  const planeX0 = -Math.ceil(left + padding - drawOffsetX) - drawOffsetX
  const planeX1 = right + padding
  const inkBounds =
    request.shaping !== undefined || candidate || isEmojiCandidate(request.character)
  const planeY0 = -Math.max(descent, inkBounds ? metrics.actualBoundingBoxDescent : 0) - padding
  const planeY1 = Math.ceil(
    Math.max(ascent, inkBounds ? metrics.actualBoundingBoxAscent : 0) + padding,
  )
  // Only whole, plain text glyphs trim their quads: a tile of a shaped line is clipped to its
  // slice, and colour candidates are bitmaps whose ink the metrics need not bound.
  const ink: MeasuredGlyph['ink'] =
    inkBounds || slice
      ? undefined
      : [
          -metrics.actualBoundingBoxLeft,
          -metrics.actualBoundingBoxDescent,
          metrics.actualBoundingBoxRight,
          metrics.actualBoundingBoxAscent,
        ]

  return [
    {
      request,
      width: Math.max(2, Math.ceil(planeX1 - planeX0) + 2),
      height: Math.max(2, Math.ceil(planeY1 - planeY0) + 2),
      planeX0,
      planeY0,
      planeX1,
      planeY1,
      descent,
      advance,
      drawOffsetX,
      ...(ink?.every(Number.isFinite) ? { ink } : {}),
      x: 0,
      y: 0,
    },
    nextFont,
  ]
}

/**
 * @internal The slot of a glyph drawn at (glyph.x, glyph.y) of a `width`×`height` atlas. The
 * full build and an append patch both take their slots from here, so they cannot drift apart.
 * A `banded` glyph is a colour candidate in the band; an `uncoloured` one a candidate that
 * classified as text.
 */
export function slotOf(
  glyph: MeasuredGlyph,
  padding: number,
  bakeSize: number,
  width: number,
  height: number,
  banded: boolean,
  uncoloured: boolean,
): GlyphSlot {
  // The sampled window must follow the drawn plane box, not the shelf slot:
  // the slot is `ceil(extent) + 2` texels wide and the glyph origin above is
  // offset by one, so the plane spans texels 1 .. 1 + extent. Both bounds move
  // inward by half a texel so bilinear filtering cannot reach a neighbour.
  const slice = glyph.request.shaping?.slice
  const planeX0 = glyph.planeX0 + (slice && slice[0] > 0 ? -glyph.planeX0 : 0.5)
  const planeY0 = glyph.planeY0 + 0.5
  const planeX1 = glyph.planeX1 - (slice && slice[1] < 1 ? glyph.planeX1 - glyph.advance : 0.5)
  const planeY1 = glyph.planeY1 - 0.5
  const uv = (x0: number, y0: number, x1: number, y1: number) => ({
    u0: (glyph.x + 1 + x0 - glyph.planeX0) / width,
    v0: (glyph.y + 1 + glyph.planeY1 - y1) / height,
    u1: (glyph.x + 1 + x1 - glyph.planeX0) / width,
    v1: (glyph.y + 1 + glyph.planeY1 - y0) / height,
  })
  const ink = banded ? undefined : glyph.ink
  const reach = padding / 2 + 2 + 0.006 * bakeSize
  const sx0 = ink ? Math.max(planeX0, Math.floor(ink[0] - reach)) : 0
  const sy0 = ink ? Math.max(planeY0, Math.floor(ink[1] - reach)) : 0
  const sx1 = ink ? Math.min(planeX1, Math.ceil(ink[2] + reach)) : 0
  const sy1 = ink ? Math.min(planeY1, Math.ceil(ink[3] + reach)) : 0
  return {
    ...(uncoloured ? { color: false } : {}),
    key: glyph.request.key,
    character: glyph.request.character,
    fontKey: glyph.request.font.key,
    ...uv(planeX0, planeY0, planeX1, planeY1),
    planeX0,
    planeY0,
    planeX1,
    planeY1,
    descent: glyph.descent,
    advance: glyph.advance,
    ...(ink && sx1 > sx0 && sy1 > sy0 ? { support: uv(sx0, sy0, sx1, sy1) } : {}),
  }
}

/**
 * @internal Draws glyphs into their slots of one canvas, by the rules of the full build and of
 * an append patch alike. `reset()` forgets the context state cached here: call it whenever
 * the canvas is resized, which resets that state.
 */
export function glyphPainter(
  context: CanvasRenderingContext2D,
  shaping: ShapingContext | undefined,
  signal: AbortSignal | undefined,
  drawShape?: (glyph: MeasuredGlyph) => void,
): { draw(glyph: MeasuredGlyph, text: boolean, fill?: string): void; reset(): void } {
  // A text mask must be the outline itself on every platform. The bake canvas has font
  // smoothing off; where the engine has the property, text also asks for exact geometry,
  // and it takes a mid grey fill, the neutral middle of a rasterizer's contrast table.
  // Colour glyphs keep the default rendering and the fills their classification compares;
  // shapes are paths, which none of this affects.
  const exactText = 'textRendering' in context
  let lastFont: GlyphRequest['font'] | null = null
  let lastFill = ''
  let lastTextRendering = ''
  return {
    reset() {
      lastFont = null
      lastFill = ''
      lastTextRendering = ''
    },
    draw(glyph, text, fill = '#fff') {
      throwIfAborted(signal)
      const targetFill = text ? '#606060' : fill
      if (lastFill !== targetFill) {
        context.fillStyle = targetFill
        lastFill = targetFill
      }
      if (glyph.request.shape) {
        drawShape!(glyph)
        lastFill = ''
        return
      }
      lastFont = setFontContext(context, glyph.request, shaping, lastFont)
      if (exactText) {
        const targetRendering = text ? 'geometricPrecision' : 'auto'
        if (lastTextRendering !== targetRendering) {
          context.textRendering = targetRendering
          lastTextRendering = targetRendering
        }
      }
      const originX = glyph.x - glyph.planeX0 + 1
      const baselineY = glyph.y + glyph.planeY1 + 1
      if (glyph.request.shaping?.slice) {
        context.save()
        context.beginPath()
        context.rect(
          glyph.x + 1,
          glyph.y + 1,
          glyph.planeX1 - glyph.planeX0,
          glyph.planeY1 - glyph.planeY0,
        )
        context.clip()
        context.fillText(glyph.request.character, originX - glyph.drawOffsetX, baselineY)
        context.restore()
      } else context.fillText(glyph.request.character, originX, baselineY)
    },
  }
}

/** The first row of a non-empty run of packed glyphs. */
function topOf(rows: readonly MeasuredGlyph[]): number {
  return rows.reduce((top, glyph) => (glyph.y < top ? glyph.y : top), rows[0]!.y)
}

let lastOverflowWidth = Infinity

/** @internal Row-major shelf packing; also lays out the colour candidates of an append. */
export function packShelves(
  glyphs: MeasuredGlyph[],
  width: number,
  maxSize: number,
): { width: number; height: number } | null {
  let x = 0
  let y = 0
  let rowHeight = 0
  let usedWidth = 0

  for (const glyph of glyphs) {
    const gw = glyph.width
    const gh = glyph.height
    if (gw > width) {
      if (gw < lastOverflowWidth) lastOverflowWidth = gw
      return null
    }
    if (gh > maxSize) return null
    if (x + gw > width) {
      if (x + gw < lastOverflowWidth) lastOverflowWidth = x + gw
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    if (y + gh > maxSize) return null
    glyph.x = x
    glyph.y = y
    x += gw
    if (gh > rowHeight) rowHeight = gh
    if (x > usedWidth) usedWidth = x
  }

  return {
    width: align4(usedWidth),
    height: align4(y + rowHeight),
  }
}

let skylineX = new Int32Array(256)
let skylineY = new Int32Array(256)
let skylineW = new Int32Array(256)

/** Bottom-left skyline packing fills the vertical gaps that fixed-height shelves leave behind. */
function packSkyline(
  glyphs: MeasuredGlyph[],
  width: number,
  maxSize: number,
): { width: number; height: number } | null {
  const needed = glyphs.length + 2
  if (skylineX.length < needed) {
    skylineX = new Int32Array(needed)
    skylineY = new Int32Array(needed)
    skylineW = new Int32Array(needed)
  }
  const sx = skylineX
  const sy = skylineY
  const sw = skylineW
  sx[0] = 0
  sy[0] = 0
  sw[0] = width
  let skylineLen = 1
  let usedWidth = 0
  let usedHeight = 0
  const shift = (to: number, from: number): void => {
    sx.copyWithin(to, from, skylineLen)
    sy.copyWithin(to, from, skylineLen)
    sw.copyWithin(to, from, skylineLen)
  }

  const minH = glyphs[glyphs.length - 1]!.height
  let wasteBudget = width * maxSize
  const over = (): null => (
    (lastOverflowWidth = Math.min(lastOverflowWidth, width + Math.ceil(-wasteBudget / maxSize))),
    null
  )
  for (const g of glyphs) wasteBudget -= g.width * g.height
  if (wasteBudget < 0) return over()

  for (const glyph of glyphs) {
    const gw = glyph.width
    const gh = glyph.height
    if (gh > maxSize) return null
    let bestIndex = -1
    let bestBottom = Infinity
    let bestWaste = Infinity
    const tail = skylineLen - 1
    let maxAllowedY = sw[tail]! >= gw && sy[tail]! < maxSize - gh ? sy[tail]! : maxSize - gh

    for (let index = 0; index < skylineLen; index++) {
      const firstY = sy[index]!
      if (firstY > maxAllowedY) continue
      const x = sx[index]!
      if (x + gw > width) {
        if (x + gw < lastOverflowWidth) lastOverflowWidth = x + gw
        break
      }

      let remaining = gw - sw[index]!
      let y = firstY
      let waste = 0
      if (remaining > 0) {
        let coveredArea = sw[index]! * firstY
        for (let cursor = index + 1; ; cursor++) {
          const nodeY = sy[cursor]!
          if (nodeY > maxAllowedY) {
            index = cursor
            remaining = 1
            break
          }
          if (nodeY > y) y = nodeY
          const nodeW = sw[cursor]!
          coveredArea += (remaining < nodeW ? remaining : nodeW) * nodeY
          if ((remaining -= nodeW) <= 0) break
        }
        if (remaining > 0) continue
        waste = y * gw - coveredArea
      }
      const bottom = y + gh
      if (bottom < bestBottom || waste < bestWaste) {
        bestIndex = index
        bestBottom = bottom
        bestWaste = waste
        maxAllowedY = waste === 0 ? y - 1 : y
        if (maxAllowedY < 0) break
      }
    }
    if (maxAllowedY >= 0 && usedWidth + gw < lastOverflowWidth) lastOverflowWidth = usedWidth + gw

    if (
      bestIndex < 0 ||
      (wasteBudget -= bestWaste + (bestBottom > maxSize - minH ? gw * (maxSize - bestBottom) : 0)) <
        0
    )
      return bestIndex < 0 ? null : over()
    const gx = sx[bestIndex]!
    const right = gx + gw
    glyph.x = gx
    glyph.y = bestBottom - gh
    let cursor = bestIndex
    while (cursor < skylineLen && sx[cursor]! + sw[cursor]! <= right) cursor++
    if (cursor < skylineLen && sx[cursor]! < right) {
      sw[cursor] = sx[cursor]! + sw[cursor]! - right
      sx[cursor] = right
    }
    let newCount = 1
    if (bestIndex > 0 && sy[bestIndex - 1] === bestBottom) {
      sw[bestIndex - 1] = sw[bestIndex - 1]! + gw
      newCount = 0
      if (cursor < skylineLen && sy[cursor] === bestBottom) {
        sw[bestIndex - 1] = sw[bestIndex - 1]! + sw[cursor]!
        cursor++
      }
    } else if (cursor < skylineLen && sy[cursor] === bestBottom) {
      sx[cursor] = gx
      sw[cursor] = sw[cursor]! + gw
      newCount = 0
    }
    const delta = newCount - (cursor - bestIndex)
    if (delta !== 0 && cursor < skylineLen) shift(cursor + delta, cursor)
    skylineLen += delta
    if (newCount) {
      sx[bestIndex] = gx
      sy[bestIndex] = bestBottom
      sw[bestIndex] = gw
    }

    if (right > usedWidth) usedWidth = right
    if (bestBottom > usedHeight) usedHeight = bestBottom
  }

  return { width: align4(usedWidth), height: align4(usedHeight) }
}

/** Packs each group into rows of its own, one group below the other. */
function packStacked(
  groups: readonly MeasuredGlyph[][],
  width: number,
  limit: number,
  pack: typeof packShelves,
): { width: number; height: number } | null {
  let packedWidth = 0
  let height = 0
  for (const group of groups) {
    const packed = pack(group, width, limit - height)
    if (!packed || height + packed.height > limit) return null
    for (const glyph of group) glyph.y += height
    packedWidth = Math.max(packedWidth, packed.width)
    height += packed.height
  }
  return { width: packedWidth, height }
}

function rememberPacking(
  glyphs: readonly MeasuredGlyph[],
  size: { width: number; height: number },
  positions: Int32Array,
): PackedGlyphs {
  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index]!
    positions[index * 2] = glyph.x
    positions[index * 2 + 1] = glyph.y
  }
  return { width: size.width, height: size.height }
}

function isBetterPacking(
  candidate: Pick<PackedGlyphs, 'width' | 'height'>,
  current: PackedGlyphs,
): boolean {
  return (
    (candidate.width * candidate.height - current.width * current.height ||
      Math.max(candidate.width, candidate.height) - Math.max(current.width, current.height) ||
      candidate.width - current.width) < 0
  )
}

/**
 * The bake canvas. Font smoothing follows the canvas element's computed style, and only while
 * the element is in a document: there it is turned off, in every engine, so a mask is the
 * outline itself. Everything else a page would hand down (spacing, font features and
 * variations, direction, language) is cut off, so the mask stays what a detached canvas draws.
 * The caller takes it out of the document again.
 * @internal Shared with the atlas append path and the outline tracer.
 */
export function createCanvas(document: Document): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  for (const [property, value] of [
    ['all', 'initial'],
    ['display', 'none'],
    ['direction', 'ltr'],
    ['-webkit-font-smoothing', 'antialiased'],
    ['-moz-osx-font-smoothing', 'grayscale'],
  ] as const)
    canvas.style.setProperty(property, value, 'important')
  canvas.dir = 'ltr'
  canvas.lang = ''
  document.documentElement.append(canvas)
  return canvas
}

/** @internal Loads every face the text requests draw with; shared with the outline tracer. */
export async function waitForFonts(
  document: Document,
  requests: readonly GlyphRequest[],
  signal?: AbortSignal,
): Promise<void> {
  const fonts = document.fonts as FontFaceSet | undefined
  if (!fonts) return
  const byFont = new Map<string, { font: string; text: string }>()
  for (const request of requests) {
    if (request.shape) continue
    const current = byFont.get(request.font.key)
    if (current) current.text += request.character
    else byFont.set(request.font.key, { font: request.font.canvasFont, text: request.character })
  }
  const ok = fonts.status === 'loaded' && !('mock' in (fonts as { load: object }).load)
  await Promise.all(
    Array.from(byFont.values(), (i) => {
      try {
        if (ok && fonts.check(i.font, i.text)) return
      } catch {
        // Load below when check rejects an uncommon font shorthand.
      }
      return fonts.load(i.font, i.text)
    }) as Promise<unknown>[],
  )
  throwIfAborted(signal)
}

/**
 * Rasterizes every required font-face/character or emoji-sequence pair into one tightly packed
 * alpha atlas. The output is a transient mask; the retained texture is a
 * single-channel distance field produced by the CPU or WebGPU compute backend.
 */
export async function rasterizeGlyphAtlas(
  document: Document,
  requests: readonly GlyphRequest[],
  options: RasterizeOptions = {},
): Promise<RasterAtlas> {
  const bakeSize = options.bakeSize ?? 96
  const padding = options.padding ?? 12
  const maxAtlasSize = options.maxAtlasSize ?? 2048
  if (!Number.isFinite(bakeSize) || bakeSize < 16) {
    throw new RangeError('rasterizeGlyphAtlas: bakeSize must be at least 16')
  }
  if (!Number.isFinite(padding) || padding < 2) {
    throw new RangeError('rasterizeGlyphAtlas: padding must be at least 2')
  }
  if (!Number.isInteger(maxAtlasSize) || maxAtlasSize < 64) {
    throw new RangeError('rasterizeGlyphAtlas: maxAtlasSize must be an integer of at least 64')
  }

  throwIfAborted(options.signal)
  const [, shapingModule, shapes] = await Promise.all([
    waitForFonts(document, requests, options.signal),
    requests.some((request) => request.shaping) ? import('../dom/browserShaping.js') : undefined,
    requests.some((request) => request.shape) ? import('./shapeRaster.js') : undefined,
  ])
  const shaping = shapingModule?.setShapingContext
  throwIfAborted(options.signal)

  const canvas = createCanvas(document)
  try {
    // A glyph a matching previous atlas has classified keeps its classification. A bitmap
    // shape always keeps its place in the band, as on a cold build: never history-dependent.
    const previous =
      options.previousAtlas?.bakeSize === bakeSize && options.previousAtlas.pxRange === padding
        ? options.previousAtlas.glyphs
        : undefined
    const context = canvas.getContext('2d', {
      willReadFrequently:
        !options.gpuUpload ||
        requests.some(
          (request) =>
            isColorCandidate(request, options.colorGlyphs) &&
            (request.shape !== undefined ||
              ((options.colorGlyphs === 'all' || isEmojiGrapheme(request.character)) &&
                previous?.get(request.key)?.color !== false)),
        ),
    })
    if (!context) throw new Error('rasterizeGlyphAtlas: Canvas 2D is unavailable')

    const packingLimit = maxAtlasSize - (maxAtlasSize % 4)
    let lastFont: GlyphRequest['font'] | null = null
    const measured = requests.map((request) => {
      if (request.shape) return shapes!.measureShape(request, bakeSize, padding)
      const [glyph, nextFont] = measureGlyph(
        context,
        request,
        padding,
        shaping,
        isColorCandidate(request, options.colorGlyphs),
        lastFont,
      )
      lastFont = nextFont
      return glyph
    })
    measured.sort(
      (a, b) =>
        b.height - a.height ||
        b.width - a.width ||
        (a.request.key < b.request.key ? -1 : a.request.key > b.request.key ? 1 : 0),
    )

    const banded = new Set<MeasuredGlyph>()
    const uncoloured = new Set<MeasuredGlyph>()
    const tested: MeasuredGlyph[] = []
    for (const glyph of measured) {
      if (!isColorCandidate(glyph.request, options.colorGlyphs)) continue
      const known = glyph.request.shape ? undefined : previous?.get(glyph.request.key)?.color
      if (known === false) uncoloured.add(glyph)
      else {
        banded.add(glyph)
        if (!glyph.request.shape && known === undefined) tested.push(glyph)
      }
    }
    const painter = glyphPainter(context, shaping, options.signal, (glyph) => {
      shapes!.drawShapeSlot(context, glyph, bakeSize)
    })
    const drawGlyph = (glyph: MeasuredGlyph, fill?: string): void => {
      painter.draw(glyph, !glyph.request.shape && !banded.has(glyph), fill)
    }

    // A candidate the font draws in the fill colour alone is text, whatever Unicode lists it
    // as: a copyright sign, an arrow, the tiles of a shaped line beside the one that holds
    // its emoji. Each font candidate is drawn in black and in white on a pack of their own,
    // and only one with ink that ignores the fill keeps its place in the band; the others are
    // baked, packed and flagged with the text.
    const colorGlyphs = banded.size ? await import('./colorGlyphs.js') : undefined
    throwIfAborted(options.signal)
    const scratch = tested.length ? packShelves(tested, packingLimit, packingLimit) : null
    if (scratch) {
      canvas.width = scratch.width
      canvas.height = scratch.height
      painter.reset()
      const paint = (fill: string): Uint8ClampedArray => {
        context.clearRect(0, 0, canvas.width, canvas.height)
        for (const glyph of tested) drawGlyph(glyph, fill)
        return context.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const dark = paint('#000')
      const { colored } = colorGlyphs!.encodeColorBand(
        paint('#fff'),
        dark,
        canvas.width,
        canvas.height,
        0,
        tested,
      )
      tested.forEach((glyph, index) => {
        if (colored[index]) return
        banded.delete(glyph)
        uncoloured.add(glyph)
      })
    }

    // Three kinds of rows, top to bottom: text, monochrome shapes, colour.
    const textRows: MeasuredGlyph[] = []
    const shapeRows: MeasuredGlyph[] = []
    const band: MeasuredGlyph[] = []
    let totalArea = 0
    let widestGlyph = 4
    let exceedsLimit = false
    for (const glyph of measured) {
      totalArea += glyph.width * glyph.height
      if (glyph.width > widestGlyph) widestGlyph = glyph.width
      if (glyph.width > packingLimit || glyph.height > packingLimit) exceedsLimit = true
      if (banded.has(glyph)) band.push(glyph)
      else if (glyph.request.shape) shapeRows.push(glyph)
      else textRows.push(glyph)
    }
    const groups = [textRows, shapeRows, band].filter((group) => group.length)
    const packGlyphs = (pack: typeof packShelves, width: number, limit: number) =>
      groups.length > 1 ? packStacked(groups, width, limit, pack) : pack(measured, width, limit)
    const impossible = totalArea > packingLimit * packingLimit || exceedsLimit
    const bestPositions = new Int32Array(measured.length * 2)
    let shelfWidth = Math.min(packingLimit, Math.max(64, nextPowerOfTwo(Math.sqrt(totalArea))))
    let packed = impossible ? null : packGlyphs(packShelves, shelfWidth, packingLimit)
    while (!packed && shelfWidth < packingLimit) {
      shelfWidth = Math.min(packingLimit, shelfWidth * 2)
      packed = packGlyphs(packShelves, shelfWidth, packingLimit)
    }
    let best = packed && !impossible ? rememberPacking(measured, packed, bestPositions) : null

    if (!impossible && measured.length > 0) {
      const minRequiredLimit = groups.reduce((sum, g) => sum + align4(g[0]!.height), 0)
      const minimumWidth = Math.min(
        packingLimit,
        align4(Math.max(widestGlyph, Math.ceil(totalArea / packingLimit))),
      )
      // Search at most about 64 aligned widths. Trying both the shelf and skyline
      // heuristic keeps the old pack as a no-regression candidate while allowing
      // short glyphs to occupy holes below taller neighbours.
      const widthStep = align4(Math.max(4, Math.ceil((packingLimit - minimumWidth) / 64)))
      const maxHeightFor = (width: number): number =>
        best ? Math.min(packingLimit, Math.floor((best.width * best.height) / width)) : packingLimit
      const nextW = [minimumWidth, minimumWidth]
      for (let width = minimumWidth; ; width = Math.min(packingLimit, width + widthStep)) {
        throwIfAborted(options.signal)
        if (maxHeightFor(width) < minRequiredLimit) break
        const minH = align4(Math.max(minRequiredLimit, Math.ceil(totalArea / width)))
        for (let i = 0; i < 2; i++) {
          if (width < nextW[i]!) continue
          const maxCandidateHeight = maxHeightFor(width)
          if (minH > maxCandidateHeight) break
          lastOverflowWidth = Infinity
          const candidate = packGlyphs(i ? packSkyline : packShelves, width, maxCandidateHeight)
          nextW[i] = lastOverflowWidth
          if (candidate && (!best || isBetterPacking(candidate, best))) {
            best = rememberPacking(measured, candidate, bestPositions)
          }
        }
        if (width === packingLimit) break
      }
    }

    if (!best) {
      if (options.adaptiveBakeSize === true && bakeSize > 16) {
        const nextSize = Math.max(16, Math.floor(bakeSize * 0.8))
        const scaled = requests.map((request) => ({
          ...request,
          font: {
            ...request.font,
            canvasFont: request.font.canvasFont.replace(
              /[\d.]+px/,
              (size) => `${(Number.parseFloat(size) * nextSize) / bakeSize}px`,
            ),
          },
        }))
        return await rasterizeGlyphAtlas(document, scaled, { ...options, bakeSize: nextSize })
      }
      throw new Error(
        `rasterizeGlyphAtlas: ${requests.length} glyphs exceed the ${maxAtlasSize}×${maxAtlasSize} atlas limit`,
      )
    }
    for (let index = 0; index < measured.length; index++) {
      measured[index]!.x = bestPositions[index * 2]!
      measured[index]!.y = bestPositions[index * 2 + 1]!
    }

    // The text rows, packed first, end where the shapes or else the colour band begin. Headroom
    // for later appends goes there, so the rows below move down once, now, never on an append.
    let textBottom = !textRows.length ? 0 : groups.length > 1 ? topOf(groups[1]!) : best.height
    if (options.appendable === 'headroom' && textRows.length) {
      // Rows of at least two of the widest text glyphs: a one-column atlas has no row that
      // takes a glyph wider than its own.
      let widestText = 0
      for (const glyph of textRows) if (glyph.width > widestText) widestText = glyph.width
      best.width = Math.min(packingLimit, Math.max(best.width, align4(2 * widestText)))
      const room = Math.min(
        packingLimit - best.height,
        align4(Math.max(textRows[0]!.height, textBottom / 4)),
      )
      if (room > 0) {
        for (const glyph of measured) if (glyph.y >= textBottom) glyph.y += room
        best.height += room
        textBottom += room
      }
    }

    canvas.width = best.width
    canvas.height = best.height
    painter.reset()
    context.clearRect(0, 0, canvas.width, canvas.height)
    const bandTop = band.length ? topOf(band) : 0
    const bandHeight = canvas.height - bandTop
    let black: Uint8ClampedArray | undefined
    if (band.length) {
      for (const glyph of band) drawGlyph(glyph, '#000')
      black = context.getImageData(0, bandTop, canvas.width, bandHeight).data
      context.clearRect(0, bandTop, canvas.width, bandHeight)
    }
    const glyphSlots = new Map<string, GlyphSlot>()
    for (const glyph of measured) {
      drawGlyph(glyph)
      glyphSlots.set(
        glyph.request.key,
        slotOf(
          glyph,
          padding,
          bakeSize,
          canvas.width,
          canvas.height,
          banded.has(glyph),
          uncoloured.has(glyph),
        ),
      )
    }

    let colorBand: RasterColorBand | undefined
    if (black) {
      const white = context.getImageData(0, bandTop, canvas.width, bandHeight).data
      const encoded = colorGlyphs!.encodeColorBand(
        white,
        black,
        canvas.width,
        bandHeight,
        padding,
        band.map((glyph) => ({ ...glyph, y: glyph.y - bandTop })),
      )
      for (const [index, glyph] of band.entries()) {
        const slot = glyphSlots.get(glyph.request.key)!
        glyphSlots.set(glyph.request.key, { ...slot, color: encoded.colored[index]! })
      }
      if (encoded.colored.some(Boolean))
        colorBand = { top: bandTop, height: bandHeight, data: encoded.data }
    }
    const shapeTop = shapeRows.length ? topOf(shapeRows) : undefined
    if (options.appendable) {
      // The last text row is the one the lowest-starting slot begins on; whatever reaches
      // that row or below bounds where the cursor starts and how far the row runs down.
      let x = 0
      let y = 0
      let rowHeight = 0
      for (const glyph of textRows)
        if (glyph.y > y && glyph.y + textRows[0]!.height <= textBottom) y = glyph.y
      for (const glyph of textRows) {
        const reach = glyph.y + glyph.height - y
        if (reach > 0) {
          if (glyph.x + glyph.width > x) x = glyph.x + glyph.width
          if (reach > rowHeight) rowHeight = reach
        }
      }
      appendCursors.set(glyphSlots, {
        width: canvas.width,
        height: canvas.height,
        bakeSize,
        pxRange: padding,
        colorGlyphs: options.colorGlyphs ?? 'emoji',
        bottom: textBottom,
        x,
        y,
        rowHeight,
      })
    }
    return {
      ...(colorBand ? { colorBand } : {}),
      ...(shapeTop !== undefined ? { shapeTop } : {}),
      canvas,
      width: canvas.width,
      height: canvas.height,
      bakeSize,
      pxRange: padding,
      glyphs: glyphSlots,
    }
  } finally {
    canvas.remove()
  }
}
