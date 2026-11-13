import type {
  GlyphRequest,
  SvgEmojiOutlineProviderOptions,
  WindfoilGlyphOutline,
  WindfoilOutlineLayer,
} from '../types.js'
import { abortable, throwIfAborted } from './storage.js'

/** Lazily loaded only after an app resolves an emoji SVG. */
export function createEmojiConverter() {
  const advances = new Map<string, number>()
  let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null
  return async (
    svg: string,
    request: GlyphRequest,
    options: SvgEmojiOutlineProviderOptions,
    signal: AbortSignal,
  ): Promise<WindfoilGlyphOutline | null> => {
    const text = options.em
      ? null
      : await abortable(
          Promise.resolve(
            options.text({ ...request, key: `${request.font.key}\0M`, character: 'M' }, signal),
          ),
          signal,
        )
    if (!options.em && !text) return null
    const upm = options.em?.unitsPerEm ?? 2048
    const descent = options.em?.descent ?? (text!.descent / text!.unitsPerEm) * upm
    const em = options.em ?? { unitsPerEm: upm, ascent: upm + descent, descent }
    const { svgToWindfoilOutlines } = await abortable(import('./svg/convert.js'), signal)
    throwIfAborted(signal)
    const result = svgToWindfoilOutlines(svg, { em })
    if (
      result.layers.some((layer) => layer.paint.type === 'unsupported') ||
      result.warnings.some((warning) =>
        [
          'stroke-ignored',
          'unsupported-element',
          'clip-path-ignored',
          'mask-ignored',
          'filter-ignored',
          'evenodd-ambiguous',
        ].includes(warning.code),
      )
    ) {
      return null
    }
    let advance = advances.get(`${request.font.canvasFont}\0${request.character}`)
    if (advance === undefined) {
      context ??=
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(1, 1).getContext('2d')
          : document.createElement('canvas').getContext('2d')
      if (!context) throw new Error('SVG emoji advance measurement requires a 2D canvas')
      context.font = request.font.canvasFont
      advance = (context.measureText(request.character).width / request.font.size) * upm
      advances.set(`${request.font.canvasFont}\0${request.character}`, advance)
    }
    const dx = (advance - result.outline.bbox[2] - result.outline.bbox[0]) / 2
    const shiftBox = (bbox: WindfoilGlyphOutline['bbox']): WindfoilGlyphOutline['bbox'] => [
      bbox[0] + dx,
      bbox[1],
      bbox[2] + dx,
      bbox[3],
    ]
    const layers: WindfoilOutlineLayer[] = result.layers.map((layer) => ({
      quadratics: Array.from(
        layer.outline.quadratics,
        (value, index) => value + (index % 2 ? 0 : dx),
      ),
      bbox: shiftBox(layer.outline.bbox),
      paint:
        layer.paint.type === 'linear' ||
        layer.paint.type === 'radial' ||
        layer.paint.type === 'sweep'
          ? {
              ...layer.paint,
              transform: (([a, b, c, d, e, f]) => [a, b, c, d, e + dx, f] as const)(
                layer.paint.transform ?? [1, 0, 0, 1, 0, 0],
              ),
            }
          : (layer.paint as WindfoilOutlineLayer['paint']),
    }))
    const outline: WindfoilGlyphOutline = {
      unitsPerEm: upm,
      ascent: em.ascent,
      descent,
      bbox: shiftBox(result.outline.bbox),
      quadratics: [],
      layers,
    }
    throwIfAborted(signal)
    return outline
  }
}
