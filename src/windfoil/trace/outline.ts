// Outline tracer: the 0.5 contours of a glyph's coverage mask fitted with quadratics, in the
// glyph's own frame. Pure: no canvas, no DOM, no module state.
import type { WindfoilBoundingBox } from '../../types.js'
import { marchingSquares } from './contours.js'
import { fitClosedPolyline } from './fit.js'
import type { CoverageMask, Polyline, TraceScratch } from './types.js'

/** Fresh working memory for `traceCoverage`; reuse it across the glyphs of one tracer. */
export function createTraceScratch(): TraceScratch {
  return {
    value: new Float32Array(0),
    next: new Int32Array(0),
    matrix: new Float64Array(0),
    rhsX: new Float64Array(0),
    rhsY: new Float64Array(0),
    ratio: new Float64Array(0),
  }
}

function polylineArea(points: Polyline): number {
  let area = 0
  for (let i = 0, n = points.length; i < n; i += 2) {
    const j = (i + 2) % n
    area += points[i]! * points[j + 1]! - points[j]! * points[i + 1]!
  }
  return area / 2
}

/** Signed area enclosed by a closed quadratic chain (exact, by Green's theorem). */
function quadraticsArea(q: ArrayLike<number>): number {
  let area = 0
  for (let o = 0; o < q.length; o += 6) {
    const x0 = q[o]!
    const y0 = q[o + 1]!
    const cx = q[o + 2]!
    const cy = q[o + 3]!
    const x1 = q[o + 4]!
    const y1 = q[o + 5]!
    // The chord term plus the curve's bulge.
    area += (x0 * y1 - x1 * y0) / 2 - ((x0 - cx) * (y1 - cy) - (x1 - cx) * (y0 - cy)) / 3
  }
  return area
}

/** At least two pieces, every value finite and no piece of zero length. */
function sound(q: ArrayLike<number>): boolean {
  if (q.length < 12) return false
  for (let o = 0; o < q.length; o += 6) {
    for (let k = 0; k < 6; k++) if (!Number.isFinite(q[o + k])) return false
    if (Math.abs(q[o]! - q[o + 4]!) + Math.abs(q[o + 1]! - q[o + 5]!) < 1e-6) return false
  }
  return true
}

/** The extremes of a quadratic along one axis, folded into `range` ([min, max]). */
function extend(range: [number, number], p0: number, c: number, p1: number): void {
  let low = p0 < p1 ? p0 : p1
  let high = p0 < p1 ? p1 : p0
  if (c < low || c > high) {
    const d0 = p0 - c
    const denominator = d0 + (p1 - c)
    if (denominator !== 0) {
      const extreme = p0 - (d0 * d0) / denominator
      if (extreme < low) low = extreme
      if (extreme > high) high = extreme
    }
  }
  if (low < range[0]) range[0] = low
  if (high > range[1]) range[1] = high
}

/**
 * Traces the 0.5 contours of a box-filtered coverage mask and fits each with quadratic Béziers
 * no further than `tolerance` mask pixels from it. The result is in mask pixels with its origin
 * at (`originX`, `baselineY`) and Y up, outer contours clockwise and holes counter-clockwise as
 * in TrueType; `bbox` bounds the curves themselves. A contour whose fit fails its checks keeps
 * its traced polyline as straight pieces. A mask without ink gives no quadratics and a zero box.
 */
export function traceCoverage(
  mask: CoverageMask,
  tolerance: number,
  scratch: TraceScratch = createTraceScratch(),
): { readonly quadratics: Float32Array; readonly bbox: WindfoilBoundingBox } {
  const pieces: ArrayLike<number>[] = []
  let total = 0
  for (const points of marchingSquares(mask, scratch)) {
    const area = polylineArea(points)
    let q: ArrayLike<number> | undefined = fitClosedPolyline(points, tolerance, scratch)?.quadratics
    if (q) {
      const fitted = quadraticsArea(q)
      if (!sound(q) || !(fitted * area > 0) || Math.abs(fitted) < 0.25 * Math.abs(area))
        q = undefined
    }
    if (!q) {
      const plain = new Float64Array(points.length * 3)
      for (let i = 0, o = 0, n = points.length; i < n; i += 2, o += 6) {
        const j = (i + 2) % n
        plain[o] = points[i]!
        plain[o + 1] = points[i + 1]!
        plain[o + 2] = (points[i]! + points[j]!) / 2
        plain[o + 3] = (points[i + 1]! + points[j + 1]!) / 2
        plain[o + 4] = points[j]!
        plain[o + 5] = points[j + 1]!
      }
      if (!sound(plain)) continue
      q = plain
    }
    pieces.push(q)
    total += q.length
  }
  const quadratics = new Float32Array(total)
  const x: [number, number] = [Infinity, -Infinity]
  const y: [number, number] = [Infinity, -Infinity]
  let at = 0
  for (const q of pieces) {
    for (let o = 0; o < q.length; o += 6, at += 6) {
      for (let k = 0; k < 6; k += 2) {
        quadratics[at + k] = q[o + k]! - mask.originX
        quadratics[at + k + 1] = mask.baselineY - q[o + k + 1]!
      }
      extend(x, quadratics[at]!, quadratics[at + 2]!, quadratics[at + 4]!)
      extend(y, quadratics[at + 1]!, quadratics[at + 3]!, quadratics[at + 5]!)
    }
  }
  return { quadratics, bbox: total ? [x[0], y[0], x[1], y[1]] : [0, 0, 0, 0] }
}
