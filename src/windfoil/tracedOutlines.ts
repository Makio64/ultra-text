import { createCanvas, isColorCandidate, setFontContext, waitForFonts } from '../atlas/rasterize.js'
import type {
  ColorGlyphMode,
  FontStyleSnapshot,
  GlyphRequest,
  WindfoilGlyphOutline,
  WindfoilOutlineProvider,
} from '../types.js'
import { createTraceScratch, traceCoverage } from './trace/outline.js'

/** @internal Options of the built-in outline tracer. */
export interface TracedOutlineOptions {
  /** Trace resolution in pixels per em, also each outline's `unitsPerEm`. Defaults to `256`. */
  readonly size?: number
  /** Furthest, in trace pixels, a fitted curve may stray from its contour. Defaults to `0.25`. */
  readonly tolerance?: number
  /** Which glyphs to test for colour ink, as `DomSdfOptions.colorGlyphs`. Defaults to `'emoji'`. */
  readonly colorGlyphs?: ColorGlyphMode
}

/** @internal A `WindfoilOutlineProvider` that traces the browser's own glyphs, and its cache. */
export interface TracedOutlines {
  readonly provider: WindfoilOutlineProvider
  /** Forgets every traced outline, as after a webfont load; work in flight is not kept. */
  clear(): void
  /** Forgets the outlines of every glyph key not listed. */
  retain(keys: Iterable<string>): void
}

/** A batch yields to the page once it has traced for this long. */
const SLICE_MS = 8
/** A font assignment the canvas rejects leaves this one in place. */
const SENTINEL_FONT = '1px serif'
const SIZE_TOKEN = /[\d.]+px/

/** The requests one task made with one signal, traced together. */
interface Batch {
  readonly signal: AbortSignal
  readonly requests: Map<string, GlyphRequest>
  readonly done: Promise<ReadonlyMap<string, WindfoilGlyphOutline | null>>
}

/** One glyph between measuring and tracing, in trace pixels; y grows downwards. */
interface Measured {
  readonly request: GlyphRequest
  readonly ascent: number
  readonly descent: number
  /** How far the ink box and the font box reach from the pen: left, right, up and down. */
  readonly reach: readonly [number, number, number, number]
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('The outline trace was aborted', 'AbortError')
  }
}

/**
 * A task after the page's own: a message is not clamped to 4 ms as a nested timer is, and it
 * does not run ahead of rendering as a `scheduler.yield()` continuation does, which held frames
 * back for 100 ms at a time in Chrome 156.
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      resolve()
    }
    port2.postMessage(null)
  })
}

/** Canvas box of a glyph with `margin` pixels around its reach: pen position and size. */
function boxOf(
  reach: Measured['reach'],
  margin: number,
): [originX: number, baselineY: number, width: number, height: number] {
  const originX = margin + Math.ceil(reach[0])
  const baselineY = margin + Math.ceil(reach[2])
  return [
    originX,
    baselineY,
    originX + Math.ceil(reach[1]) + margin,
    baselineY + Math.ceil(reach[3]) + margin,
  ]
}

/** Whether any texel on the edge of a `width` x `height` RGBA read holds ink. */
function touchesEdge(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  for (let x = 0; x < width; x++) {
    if (rgba[x * 4 + 3]! > 0 || rgba[((height - 1) * width + x) * 4 + 3]! > 0) return true
  }
  for (let y = 0; y < height; y++) {
    if (rgba[y * width * 4 + 3]! > 0 || rgba[((y + 1) * width - 1) * 4 + 3]! > 0) return true
  }
  return false
}

/**
 * @internal The outline provider `DomSdf` uses for Windfoil and Slug text when the caller gives
 * none. Each glyph is drawn as the SDF rasterizer draws it (the captured canvas font with its
 * stretch and kerning, an in-document canvas without font smoothing, exact geometry, a neutral
 * grey), at `size` pixels per em, then traced at half coverage and fitted with quadratics. The
 * outline follows that raster, not the font file: font-variation and feature settings are not
 * applied, as on any canvas. Colour glyphs, glyphs of a font the canvas rejects and shaped runs
 * resolve to `null`, for the SDF companion; a glyph without ink to an empty outline. Without a
 * 2D canvas every glyph is `null`, so the whole capture falls back to SDF. `descent` is the SDF
 * slot's, measured at the captured font's own size, so analytic and SDF glyphs share a baseline.
 * Ink the metrics miss is drawn again with half an em more room all round; a glyph whose ink
 * still reaches the edge of its box resolves to `null` too, rather than trace clipped.
 *
 * Calls made in one task with one signal trace as one batch, in slices of about 8 ms between
 * which the page runs and the signal is checked. Each batch has its own working memory, which
 * goes with it. Outlines stay cached per instance until `clear()` or `retain()` drops them; one
 * traced while `document.fonts.check()` still reported its font as not ready is never cached.
 */
export function createTracedOutlineProvider(
  document: Document,
  options: TracedOutlineOptions = {},
): TracedOutlines {
  const size = options.size ?? 256
  const tolerance = options.tolerance ?? 0.25
  const colorGlyphs = options.colorGlyphs ?? 'emoji'
  const cache = new Map<string, WindfoilGlyphOutline | null>()
  let epoch = 0
  /** The batches still open to requests of this task, by signal. */
  const open = new Map<AbortSignal, Batch>()

  const run = async (
    signal: AbortSignal,
    requests: ReadonlyMap<string, GlyphRequest>,
    started: number,
  ): Promise<ReadonlyMap<string, WindfoilGlyphOutline | null>> => {
    const results = new Map<string, WindfoilGlyphOutline | null>()
    // Each font of the batch, as captured and as traced: the captured canvas font with only
    // its size rewritten, as an adaptive SDF bake does.
    const groups = new Map<string, [GlyphRequest[], FontStyleSnapshot]>()
    for (const request of requests.values()) {
      // Shapes resolve elsewhere; a shaped run is one tile of a line, which no outline covers.
      if (request.shape || request.shaping) {
        results.set(request.key, null)
        continue
      }
      const group = groups.get(request.font.key)
      if (group) group[0].push(request)
      else {
        const font = request.font
        groups.set(font.key, [
          [request],
          { ...font, canvasFont: font.canvasFont.replace(SIZE_TOKEN, `${size}px`) },
        ])
      }
    }
    const traced = (request: GlyphRequest): GlyphRequest => ({
      ...request,
      font: groups.get(request.font.key)![1],
    })
    await waitForFonts(
      document,
      [...groups.values()].flatMap(([list]) => list.map(traced)),
      signal,
    )
    throwIfAborted(signal)

    const fonts = document.fonts as FontFaceSet | undefined
    const keep = (request: GlyphRequest, outline: WindfoilGlyphOutline | null): void => {
      results.set(request.key, outline)
      let ready = epoch === started
      try {
        ready &&= fonts?.check(traced(request).font.canvasFont, request.character) ?? true
      } catch {
        ready = false
      }
      if (ready) cache.set(request.key, outline)
    }

    const canvas = createCanvas(document)
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        // Not cached: the whole capture falls back to SDF, and a later build may try again.
        for (const [list] of groups.values())
          for (const request of list) results.set(request.key, null)
        return results
      }
      let current: FontStyleSnapshot | null = null
      const accepted = new Map<FontStyleSnapshot, boolean>()
      /** Applies a request's font as the rasterizer does; false when the canvas rejected it. */
      const use = (request: GlyphRequest): boolean => {
        if (current !== request.font) {
          context.font = SENTINEL_FONT
          const sentinel = context.font
          setFontContext(context, request, undefined, null)
          current = request.font
          accepted.set(request.font, context.font !== sentinel)
        }
        return accepted.get(request.font)!
      }

      // Measure every glyph first: sizing the canvas resets its context.
      const margin = Math.max(4, Math.ceil(size / 32))
      const measured: Measured[] = []
      let canvasWidth = 1
      let canvasHeight = 1
      for (const [list] of groups.values()) {
        throwIfAborted(signal)
        const bake = Number.parseFloat(SIZE_TOKEN.exec(list[0]!.font.canvasFont)?.[0] ?? '')
        if (!(bake > 0) || !use(list[0]!)) {
          for (const request of list) keep(request, null)
          continue
        }
        // The SDF slot's metrics, measured at the captured font's own size.
        const scale = size / bake
        const slots = list.map((request) => {
          const slot = context.measureText(request.character)
          return [
            Math.max(1, slot.fontBoundingBoxAscent || slot.actualBoundingBoxAscent) * scale,
            Math.max(1, slot.fontBoundingBoxDescent || slot.actualBoundingBoxDescent) * scale,
          ] as const
        })
        if (!use(traced(list[0]!))) {
          for (const request of list) keep(request, null)
          continue
        }
        list.forEach((request, index) => {
          const [ascent, descent] = slots[index]!
          // Ink can only be found in the ink box and the font box.
          const metrics = context.measureText(request.character)
          const reach = [
            Math.max(0, metrics.actualBoundingBoxLeft || 0),
            Math.max(metrics.width || 0, metrics.actualBoundingBoxRight || 0),
            Math.max(ascent, metrics.actualBoundingBoxAscent || 0),
            Math.max(descent, metrics.actualBoundingBoxDescent || 0),
          ] as const
          const [, , width, height] = boxOf(reach, margin)
          if (!(width <= 8 * size && height <= 8 * size)) {
            keep(request, null)
            return
          }
          canvasWidth = Math.max(canvasWidth, width)
          canvasHeight = Math.max(canvasHeight, height)
          measured.push({ request: traced(request), ascent, descent, reach })
        })
      }
      const resize = (width: number, height: number): void => {
        if (width <= canvas.width && height <= canvas.height) return
        canvas.width = Math.max(width, canvas.width)
        canvas.height = Math.max(height, canvas.height)
        current = null
      }
      resize(canvasWidth, canvasHeight)

      const exact = 'textRendering' in context
      const draw = (
        glyph: Measured,
        [originX, baselineY, width, height]: ReturnType<typeof boxOf>,
        fill: string,
        rendering: CanvasTextRendering,
      ): Uint8ClampedArray => {
        resize(width, height)
        use(glyph.request)
        context.fillStyle = fill
        if (exact) context.textRendering = rendering
        context.clearRect(0, 0, width, height)
        context.fillText(glyph.request.character, originX, baselineY)
        return context.getImageData(0, 0, width, height).data
      }
      const colorModule = measured.some((glyph) => isColorCandidate(glyph.request, colorGlyphs))
        ? await import('../atlas/colorGlyphs.js')
        : null
      throwIfAborted(signal)
      // This batch's working memory, grown to fit its largest glyph (about 1 MB at 256 px per
      // em) and released with the batch, so an idle tracer holds none.
      const scratch = createTraceScratch()
      let sliceStart = performance.now()
      for (const glyph of measured) {
        throwIfAborted(signal)
        let box = boxOf(glyph.reach, margin)
        const [, , width, height] = box
        // A candidate the font draws in the fill colour alone is text, as in the SDF bake: only
        // ink that ignores the fill goes to the companion.
        const colored =
          colorModule !== null &&
          isColorCandidate(glyph.request, colorGlyphs) &&
          colorModule.encodeColorBand(
            draw(glyph, box, '#fff', 'auto'),
            draw(glyph, box, '#000', 'auto'),
            width,
            height,
            0,
            [{ x: 0, y: 0, width, height }],
          ).colored[0] === true
        let outline: WindfoilGlyphOutline | null = null
        if (!colored) {
          // The SDF bake's text rendering: exact geometry, the neutral middle of a contrast table.
          let rgba = draw(glyph, box, '#606060', 'geometricPrecision')
          let clipped = touchesEdge(rgba, box[2], box[3])
          if (clipped) {
            // The metrics missed some ink: once more with half an em of room all round.
            box = boxOf(glyph.reach, margin + size / 2)
            rgba = draw(glyph, box, '#606060', 'geometricPrecision')
            clipped = touchesEdge(rgba, box[2], box[3])
          }
          // Ink past even that room would trace clipped: the SDF companion draws the glyph.
          if (!clipped) {
            const { quadratics, bbox } = traceCoverage(
              {
                alpha: rgba,
                width: box[2],
                height: box[3],
                stride: 4,
                offset: 3,
                originX: box[0],
                baselineY: box[1],
              },
              tolerance,
              scratch,
            )
            outline = {
              unitsPerEm: size,
              ascent: glyph.ascent,
              descent: -glyph.descent,
              bbox,
              quadratics,
            }
          }
        }
        keep(requests.get(glyph.request.key)!, outline)
        if (performance.now() - sliceStart > SLICE_MS) {
          await nextTask()
          throwIfAborted(signal)
          sliceStart = performance.now()
        }
      }
      return results
    } finally {
      // Release the backing store now: Safari counts a detached canvas against its canvas
      // memory until it is collected.
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
    }
  }

  const provider: WindfoilOutlineProvider = (request, signal) => {
    throwIfAborted(signal)
    const cached = cache.get(request.key)
    if (cached !== undefined) return cached
    let batch = open.get(signal)
    if (!batch) {
      const requests = new Map<string, GlyphRequest>()
      // Everything this task asks for with this signal joins before the batch starts. What a
      // clear() before then would drop is not cached either.
      const started = epoch
      const next: Batch = {
        signal,
        requests,
        done: Promise.resolve().then(() => {
          if (open.get(signal) === next) open.delete(signal)
          return run(signal, requests, started)
        }),
      }
      open.set(signal, (batch = next))
    }
    batch.requests.set(request.key, request)
    return batch.done.then((results) => results.get(request.key) ?? null)
  }

  return {
    provider,
    clear() {
      epoch++
      cache.clear()
    },
    retain(keys) {
      const live = new Set(keys)
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
    },
  }
}
