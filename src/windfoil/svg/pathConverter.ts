import type {
  SvgToWindfoilOptions,
  WindfoilAffine,
  WindfoilBoundingBox,
  WindfoilGlyphOutline,
  WindfoilQuadratic,
  WindfoilSvgLayer,
  WindfoilSvgPaint,
  WindfoilSvgPath,
  WindfoilSvgResult,
  WindfoilSvgWarning,
} from '../../types.js'
import {
  affineNorm,
  applyAffine,
  arcToCubics,
  ContourBuilder,
  identity,
  invert,
  multiply,
  quadraticBounds,
} from './curves.js'
import type { PathRecord, Warn } from './document.js'
import { viewportTransform } from './viewport.js'
import { parsePathData, type Segment } from './pathData.js'
import { colorPaint } from './colors.js'
import { canonicalizeWinding } from './winding.js'
function contoursFromSegments(
  segments: readonly Segment[],
  matrix: WindfoilAffine,
  tolerance: number,
  warn: Warn,
  source: string,
): { contours: WindfoilQuadratic[][]; cubics: number; arcs: number } {
  const builder = new ContourBuilder()
  const m0 = matrix[0],
    m1 = matrix[1],
    m2 = matrix[2],
    m3 = matrix[3],
    m4 = matrix[4],
    m5 = matrix[5],
    halfTol = tolerance * 0.5
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    cubics = 0,
    arcs = 0,
    sigmaMax = -1
  const cubic = (
    p0: number,
    p1: number,
    p2: number,
    p3: number,
    p4: number,
    p5: number,
    p6: number,
    p7: number,
  ): void => {
    const capped = builder.cubic(
      m0 * p0 + m2 * p1 + m4,
      m1 * p0 + m3 * p1 + m5,
      m0 * p2 + m2 * p3 + m4,
      m1 * p2 + m3 * p3 + m5,
      m0 * p4 + m2 * p5 + m4,
      m1 * p4 + m3 * p5 + m5,
      m0 * p6 + m2 * p7 + m4,
      m1 * p6 + m3 * p7 + m5,
      halfTol,
    )
    if (capped)
      warn('tolerance-capped', 'Cubic conversion reached the 64-piece tolerance cap', source)
  }
  for (const segment of segments) {
    if (segment.type === 'close') {
      builder.close()
      x = sx
      y = sy
      continue
    }
    const segX = segment.x,
      segY = segment.y,
      endX = m0 * segX + m2 * segY + m4,
      endY = m1 * segX + m3 * segY + m5
    if (segment.type === 'move') {
      builder.move(endX, endY)
      sx = segX
      sy = segY
    } else if (segment.type === 'line') builder.line(endX, endY)
    else if (segment.type === 'quad')
      builder.quad(
        m0 * segment.x1 + m2 * segment.y1 + m4,
        m1 * segment.x1 + m3 * segment.y1 + m5,
        endX,
        endY,
      )
    else if (segment.type === 'cubic') {
      cubics++
      cubic(x, y, segment.x1, segment.y1, segment.x2, segment.y2, segX, segY)
    } else {
      arcs++
      if (!segment.rx || !segment.ry) builder.line(endX, endY)
      else {
        if (sigmaMax < 0) sigmaMax = affineNorm(matrix)
        for (const p of arcToCubics([x, y], segment, sigmaMax, halfTol))
          cubic(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7])
      }
    }
    x = segX
    y = segY
  }
  builder.close()
  return { contours: builder.contours, cubics, arcs }
}
function monotoneCount(quads: readonly WindfoilQuadratic[]): number {
  let count = 0
  for (const q of quads) {
    const tx = (q[0] - q[2]) / (q[0] - 2 * q[2] + q[4])
    const ty = (q[1] - q[3]) / (q[1] - 2 * q[3] + q[5])
    const hasTx = tx > 0 && tx < 1
    const hasTy = ty > 0 && ty < 1 && ty !== tx
    count += 1 + (hasTx ? 1 : 0) + (hasTy ? 1 : 0)
  }
  return count
}
/** Convert filled SVG geometry to closed, float32-exact, Y-up Windfoil outlines. */
export function convertSvgPaths(
  paths: readonly PathRecord[],
  options: SvgToWindfoilOptions = {},
  paintResolver?: (
    record: PathRecord,
    mapping: WindfoilAffine,
    bounds: WindfoilBoundingBox,
  ) => WindfoilSvgPaint,
): WindfoilSvgResult {
  const warnings: WindfoilSvgWarning[] = []
  const warn: Warn = (code, message, where) => {
    const warning: WindfoilSvgWarning = { code, message, ...(where ? { source: where } : {}) }
    warnings.push(warning)
    options.onWarning?.(warning)
    if ((code === 'stroke-ignored' ? options.strokes : options.unsupported) === 'error')
      throw new TypeError(`SVG ${code}: ${message}`)
  }
  const em = options.em ?? { unitsPerEm: 1000, ascent: 1000, descent: 0 },
    tolerance = options.tolerance ?? em.unitsPerEm / 4000
  if (
    ![em.unitsPerEm, em.ascent, em.descent, tolerance, em.advance ?? 1].every(Number.isFinite) ||
    em.unitsPerEm <= 0 ||
    em.ascent <= em.descent ||
    tolerance <= 0 ||
    (em.advance !== undefined && em.advance <= 0)
  )
    throw new RangeError('SVG em dimensions and tolerance must be finite and positive')
  for (const limit of [options.maxElements, options.maxPathData])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new RangeError('SVG limits must be positive safe integers')
  let characters = 0
  const parsed: {
    record: PathRecord
    segments: Segment[]
  }[] = []
  for (const record of paths) {
    if (
      parsed.length >= (options.maxElements ?? 10000) ||
      (characters += record.d.length) > (options.maxPathData ?? 1000000)
    ) {
      warn('limit-exceeded', 'SVG path expansion limit exceeded', record.source)
      break
    }
    if (record.fill === 'none' || record.alpha === 0) continue
    if (
      record.transform &&
      (Array.from(record.transform).length !== 6 || !record.transform.every(Number.isFinite))
    )
      throw new TypeError('SVG transforms require six finite values')
    if (
      record.transform &&
      record.transform[0] * record.transform[3] - record.transform[1] * record.transform[2] === 0
    ) {
      warn('degenerate-transform', 'Singular SVG transform', record.source)
      continue
    }
    const result = parsePathData(record.d)
    if (result.error !== undefined)
      warn('path-data-error', `Invalid path data at character ${result.error}`, record.source)
    parsed.push({
      record,
      segments: result.segments,
    })
  }
  let viewBox = options.viewBox
  if (!viewBox) {
    const all: WindfoilQuadratic[] = []
    for (const item of parsed) {
      const contours = contoursFromSegments(
        item.segments,
        item.record.transform ?? identity,
        tolerance,
        () => undefined,
        item.record.source,
      ).contours
      for (const contour of contours) all.push(...contour)
    }
    const bounds = quadraticBounds(all)
    viewBox = [bounds[0], bounds[1], bounds[2] - bounds[0] || 1, bounds[3] - bounds[1] || 1]
  }
  if (
    Array.from(viewBox).length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  )
    throw new RangeError('SVG viewBox must have positive finite width and height')
  const advance = em.advance ?? (viewBox[2] * (em.ascent - em.descent)) / viewBox[3]
  const mapping = multiply(
    [1, 0, 0, -1, 0, em.ascent],
    viewportTransform(
      viewBox,
      advance,
      em.ascent - em.descent,
      options.preserveAspectRatio ?? 'xMidYMid meet',
    ),
  )
  const layers: WindfoilSvgLayer[] = []
  let contours = 0,
    cubics = 0,
    arcs = 0,
    droppedContours = 0,
    totalQuads = 0,
    monotonePieces = 0,
    mergedMinX = Infinity,
    mergedMinY = Infinity,
    mergedMaxX = -Infinity,
    mergedMaxY = -Infinity
  const outline = (quads: readonly WindfoilQuadratic[]): WindfoilGlyphOutline => {
    const flat = new Float32Array(quads.length * 6)
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i]!
      const offset = i * 6
      flat[offset] = q[0]
      flat[offset + 1] = q[1]
      flat[offset + 2] = q[2]
      flat[offset + 3] = q[3]
      flat[offset + 4] = q[4]
      flat[offset + 5] = q[5]
    }
    return {
      unitsPerEm: em.unitsPerEm,
      ascent: em.ascent,
      descent: em.descent,
      bbox: quadraticBounds(quads),
      quadratics: flat,
    }
  }
  const emptyBounds: WindfoilBoundingBox = [0, 0, 0, 0]
  for (const { record, segments } of parsed) {
    const transform = record.transform ? multiply(mapping, record.transform) : mapping,
      converted = contoursFromSegments(segments, transform, tolerance, warn, record.source)
    const canonical = canonicalizeWinding(
      converted.contours,
      record.fillRule ?? 'nonzero',
      tolerance,
      options.checkOverlaps !== false,
    )
    if (canonical.intersects)
      warn(
        record.fillRule === 'evenodd' ? 'evenodd-ambiguous' : 'self-intersection',
        'Intersecting contours use nonzero winding; normalize with picosvg for exact fill',
        record.source,
      )
    const canonContours = canonical.contours
    const quads =
      canonContours.length === 1
        ? canonContours[0]!
        : canonContours.length === 0
          ? []
          : canonContours.flat()
    if (!quads.length) continue
    const fill = record.fill ?? ''
    const needsUserBounds =
      paintResolver !== undefined &&
      record.element !== undefined &&
      (fill.charCodeAt(0) | 32) === 117 &&
      /^url\(/i.test(fill)
    const userBounds = needsUserBounds
      ? quadraticBounds(
          contoursFromSegments(
            segments,
            identity,
            tolerance,
            () => undefined,
            record.source,
          ).contours.flat(),
        )
      : emptyBounds
    const result = outline(quads),
      paint = paintResolver
        ? paintResolver(record, transform, userBounds)
        : colorPaint(record.fill ?? 'black', record.alpha ?? 1)
    if (paint.type === 'unsupported')
      warn('unsupported-paint', `Unsupported SVG paint ${paint.value}`, record.source)
    if (
      options.checkOverlaps !== false &&
      layers.some((layer) => {
        const a = layer.outline.bbox,
          b = result.bbox
        return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
      })
    )
      warn(
        'overlap',
        'Merged SVG elements overlap; use separate layers for independent coverage',
        record.source,
      )
    if (
      result.bbox[0] < 0 ||
      result.bbox[1] < em.descent ||
      result.bbox[2] > advance ||
      result.bbox[3] > em.ascent ||
      record.viewports?.some((viewport) => {
        const toViewport = multiply(viewport.inverse, invert(mapping)!),
          bounds = quadraticBounds(
            quads.map(
              (q) =>
                [
                  ...applyAffine(toViewport, q[0], q[1]),
                  ...applyAffine(toViewport, q[2], q[3]),
                  ...applyAffine(toViewport, q[4], q[5]),
                ] as WindfoilQuadratic,
            ),
          ),
          epsilon = Math.max(viewport.width, viewport.height) * 1e-6
        return (
          bounds[0] < -epsilon ||
          bounds[1] < -epsilon ||
          bounds[2] > viewport.width + epsilon ||
          bounds[3] > viewport.height + epsilon
        )
      })
    )
      warn(
        'viewport-overflow',
        'SVG ink extends outside its viewport; clipping is not applied',
        record.source,
      )
    layers.push({ outline: result, paint, source: record.source })
    const rBox = result.bbox
    if (rBox[0] < mergedMinX) mergedMinX = rBox[0]
    if (rBox[1] < mergedMinY) mergedMinY = rBox[1]
    if (rBox[2] > mergedMaxX) mergedMaxX = rBox[2]
    if (rBox[3] > mergedMaxY) mergedMaxY = rBox[3]
    totalQuads += quads.length
    monotonePieces += monotoneCount(quads)
    contours += canonContours.length
    cubics += converted.cubics
    arcs += converted.arcs
    droppedContours += canonical.dropped
  }
  if (monotonePieces > 640)
    warn(
      'dense-outline',
      'Outline exceeds 640 monotone pieces; split independent parts into separate keys',
    )
  if (!totalQuads) warn('empty', 'SVG contains no filled geometry')
  let mergedFlat: Float32Array
  if (layers.length === 1) {
    mergedFlat = new Float32Array(layers[0]!.outline.quadratics)
  } else {
    mergedFlat = new Float32Array(totalQuads * 6)
    let writeOffset = 0
    for (const layer of layers) {
      const layerQuads = layer.outline.quadratics as Float32Array
      mergedFlat.set(layerQuads, writeOffset)
      writeOffset += layerQuads.length
    }
  }
  const mergedOutline: WindfoilGlyphOutline = {
    unitsPerEm: em.unitsPerEm,
    ascent: em.ascent,
    descent: em.descent,
    bbox: totalQuads ? [mergedMinX, mergedMinY, mergedMaxX, mergedMaxY] : [0, 0, 0, 0],
    quadratics: mergedFlat,
  }
  return {
    outline: mergedOutline,
    layers,
    warnings,
    viewBox,
    advance,
    stats: { contours, quadratics: totalQuads, monotonePieces, cubics, arcs, droppedContours },
  }
}

/** DOM-free SVG path conversion, suitable for Node scripts and workers. */
export function windfoilOutlineFromSvgPaths(
  source: WindfoilSvgPath | readonly WindfoilSvgPath[],
  options: SvgToWindfoilOptions = {},
): WindfoilSvgResult {
  const paths: readonly WindfoilSvgPath[] = Array.isArray(source)
    ? (source as readonly WindfoilSvgPath[])
    : [source as WindfoilSvgPath]
  return convertSvgPaths(
    paths.map((record, index) => ({ ...record, source: `path[${index}]` })),
    options,
  )
}
