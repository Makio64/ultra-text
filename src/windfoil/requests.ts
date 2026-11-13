import type { DomLayoutSnapshot, GlyphRequest, SdfAtlas } from '../types.js'
import type { WindfoilGlyphHeader } from './preprocess.js'
import type { WindfoilBuildOptions } from './runtime.js'
import { abortable, throwIfAborted } from './storage.js'
/** Optional inline-SVG request conversion; ordinary font requests bypass this module. */
export async function resolveShapeRequest(
  request: GlyphRequest,
  options: WindfoilBuildOptions,
  signal: AbortSignal,
) {
  const shape = request.shape
  if (!shape) return options.outlineProvider(request, signal)
  if (shape.bitmap || shape.paths.some((path) => path.stroke ?? path.clip)) return null
  const { svgToWindfoilOutlines } = await abortable(import('./svg/convert.js'), signal)
  const result = svgToWindfoilOutlines(shape.paths, {
    em: { unitsPerEm: 1000, ascent: shape.box[1], descent: 0, advance: shape.box[0] },
    viewBox: [0, 0, shape.box[0], shape.box[1]],
    preserveAspectRatio: 'none',
  })
  return result.warnings.some((warning) => warning.code === 'evenodd-ambiguous')
    ? null
    : result.outline
}
/** Release a late companion result when abort wins the race, exactly once. */
export async function buildCompanion(
  builder: { build(requests: readonly GlyphRequest[], signal: AbortSignal): Promise<SdfAtlas> },
  requests: readonly GlyphRequest[],
  signal: AbortSignal,
) {
  let atlas: SdfAtlas | null = null,
    disposed = false
  const dispose = (): void => {
    if (!disposed && atlas) {
      disposed = true
      atlas.dispose()
    }
  }
  const pending = builder.build(requests, signal)
  void pending.then(
    (result) => {
      atlas = result
      if (signal.aborted) dispose()
    },
    () => {
      /* Awaited below. */
    },
  )
  atlas = await abortable(pending, signal)
  if (signal.aborted) {
    dispose()
    throwIfAborted(signal)
  }
  return { atlas, dispose }
}
export function motionOrdinals(
  snapshot: DomLayoutSnapshot,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
  companion: SdfAtlas | null,
): Float32Array {
  const list = snapshot.glyphs,
    count = list.length,
    out = new Float32Array(count)
  let ordinal = -1,
    previous: number | undefined
  for (let i = 0; i < count; i++) {
    const glyph = list[i]!
    if (!glyphs.get(glyph.glyphKey)?.monotonePieceCount && !companion?.glyphs.has(glyph.glyphKey)) {
      out[i] = -1
      continue
    }
    if (glyph.shapeGroup === undefined || glyph.shapeGroup !== previous) ordinal++
    previous = glyph.shapeGroup
    out[i] = glyph.motionOrigin?.[2] ?? ordinal
  }
  return out
}
