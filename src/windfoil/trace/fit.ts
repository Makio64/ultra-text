// Outline tracer: curve fitter, a closed polyline to few quadratic Béziers.
//
// Method
// 1. Resample the polyline uniformly along its length (0.5 texel).
// 2. Corners: a sample is a corner when the direction turns by at least 55° between the chords
//    3 texels before and after it, most of that turn already shows at half that window (a
//    small circle fails this, a real corner passes), and it is the local maximum. The corner
//    point is the intersection of two straight lines fitted to the samples on each side, clear
//    of the antialiasing round-off, so a true corner stays sharp.
// 3. Each smooth span (corner to corner, or the whole loop when there is no corner) is one
//    quadratic B-spline fitted by linear least squares: its Bézier pieces share their tangent
//    at every join (G1, in fact C1 in the fit's parameter). Spans are clamped at the corner
//    points; a cornerless loop is periodic.
// 4. Pieces whose geometric error exceeds the tolerance are halved and the span refitted, so
//    flat stretches keep long curves and tight bends get short ones. The distance from a
//    sample to a piece is found by three Newton steps from the sample's own parameter
//    (`nearQuadraticSq`), not by flattening the piece into chords. Neighbouring pieces that
//    one curve can replace within the tolerance are then merged, keeping both outer tangents.
//
// Output is in the polyline's units and orientation: `[x0, y0, cx, cy, x1, y1, ...]`, each
// piece's end equal to the next piece's start, the last end equal to the first start.
import type { FittedOutline, TraceScratch } from './types.js'

const STRAIGHT = Math.sin((0.5 * Math.PI) / 180)
/** Turn, in radians, that makes a corner. */
const CORNER_ANGLE = (55 * Math.PI) / 180
/** Chord length, in texels, of the turn test. */
const CORNER_WINDOW = 3
/** Share of the turn that must already show at half the window. */
const CORNER_SHARPNESS = 0.72
/** Texels each side of a corner left out of the fit: the antialiasing rounds a corner off. */
const CORNER_TRIM = 1
/** Furthest, in texels, a corner may move from the polyline to the meeting point of its sides. */
const CORNER_REACH = 1.5
/** Resampling step, in texels. */
const STEP = 0.5
/** Starting piece length, in texels. */
const INITIAL_PIECE = 32
/** Shortest piece, in texels. */
const MIN_PIECE = 1
/** Most pieces per span. */
const MAX_PIECES = 512
/** Weight of the second-difference penalty. */
const SMOOTHING = 1e-4

/** A corner: the sample it was found at and the refined meeting point of its two sides. */
interface Corner {
  readonly index: number
  readonly x: number
  readonly y: number
}

/** An end point of a clamped span; null on both ends of a periodic one. */
type SpanEnd = readonly [number, number] | null

/** One fit of a span: its pieces, the largest sample distance per piece and overall. */
interface SpanFit {
  readonly quads: Float64Array
  readonly error: Float64Array
  readonly worst: number
}

/** The polyline resampled at a uniform spacing: `count` samples, flat `[x, y, ...]`. */
function resampleClosed(points: ArrayLike<number>): {
  samples: Float64Array
  count: number
  length: number
  spacing: number
} {
  const n = points.length / 2
  const cumulative = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    cumulative[i + 1] =
      cumulative[i]! +
      Math.hypot(points[2 * j]! - points[2 * i]!, points[2 * j + 1]! - points[2 * i + 1]!)
  }
  const length = cumulative[n]!
  const count = Math.max(8, Math.round(length / STEP))
  const out = new Float64Array(count * 2)
  let segment = 0
  for (let k = 0; k < count; k++) {
    const target = (k * length) / count
    while (segment < n - 1 && cumulative[segment + 1]! <= target) segment++
    const span = cumulative[segment + 1]! - cumulative[segment]!
    const t = span > 0 ? (target - cumulative[segment]!) / span : 0
    const j = (segment + 1) % n
    out[2 * k] = points[2 * segment]! + (points[2 * j]! - points[2 * segment]!) * t
    out[2 * k + 1] = points[2 * segment + 1]! + (points[2 * j + 1]! - points[2 * segment + 1]!) * t
  }
  return { samples: out, count, length, spacing: length / count }
}

/** Turn angle (radians, 0..pi) at sample i between chords reaching `reach` samples each way. */
function turnAt(q: Float64Array, count: number, i: number, reach: number): number {
  const a = (((i - reach) % count) + count) % count
  const b = (i + reach) % count
  const ux = q[2 * i]! - q[2 * a]!
  const uy = q[2 * i + 1]! - q[2 * a + 1]!
  const vx = q[2 * b]! - q[2 * i]!
  const vy = q[2 * b + 1]! - q[2 * i + 1]!
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy))
}

/** Total-least-squares line through `steps + 1` cyclic samples from `start`: point + direction. */
function fitLine(
  q: Float64Array,
  count: number,
  start: number,
  steps: number,
  direction: number,
): [number, number, number, number] {
  let mx = 0
  let my = 0
  for (let k = 0; k <= steps; k++) {
    const i = (((start + direction * k) % count) + count) % count
    mx += q[2 * i]!
    my += q[2 * i + 1]!
  }
  mx /= steps + 1
  my /= steps + 1
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let k = 0; k <= steps; k++) {
    const i = (((start + direction * k) % count) + count) % count
    const dx = q[2 * i]! - mx
    const dy = q[2 * i + 1]! - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return [mx, my, Math.cos(angle), Math.sin(angle)]
}

function findCorners(q: Float64Array, count: number, spacing: number): Corner[] {
  const length = count * spacing
  const window = Math.min(CORNER_WINDOW, length / 8)
  const reach = Math.max(2, Math.round(window / spacing))
  const half = Math.max(1, Math.round(reach / 2))
  if (count < 4 * reach) return []
  const turn = new Float64Array(count)
  const tanSq = Math.tan(CORNER_ANGLE - 1e-7) ** 2
  for (let i = 0; i < count; i++) {
    const a = i >= reach ? i - reach : i - reach + count
    const b = i + reach < count ? i + reach : i + reach - count
    const ux = q[2 * i]! - q[2 * a]!
    const uy = q[2 * i + 1]! - q[2 * a + 1]!
    const vx = q[2 * b]! - q[2 * i]!
    const vy = q[2 * b + 1]! - q[2 * i + 1]!
    const dot = ux * vx + uy * vy
    const cross = ux * vy - uy * vx
    // Under the corner angle without the arctangent: a forward turn with a small cross product.
    turn[i] = dot > 0 && cross * cross <= tanSq * (dot * dot) ? 0 : Math.abs(Math.atan2(cross, dot))
  }
  const corners: number[] = []
  for (let i = 0; i < count; i++) {
    if (turn[i]! < CORNER_ANGLE) continue
    let peak = true
    for (let k = 1; k <= reach && peak; k++) {
      // Strict on one side so a plateau yields exactly one corner.
      if (
        turn[(i + k) % count]! > turn[i]! ||
        turn[(((i - k) % count) + count) % count]! >= turn[i]!
      )
        peak = false
    }
    if (!peak) continue
    if (turnAt(q, count, i, half) < CORNER_SHARPNESS * turn[i]!) continue
    corners.push(i)
  }
  // Refine each corner to the meeting point of its two sides.
  const skip = Math.max(1, Math.round(CORNER_TRIM / spacing))
  return corners.map((i, index) => {
    const previous = corners[(index - 1 + corners.length) % corners.length]!
    const following = corners[(index + 1) % corners.length]!
    const room = (a: number, b: number): number =>
      corners.length === 1 ? count : (((b - a) % count) + count) % count
    const before = Math.min(reach + skip, Math.floor(room(previous, i) / 2)) - skip
    const after = Math.min(reach + skip, Math.floor(room(i, following) / 2)) - skip
    let x = q[2 * i]!
    let y = q[2 * i + 1]!
    if (before >= 2 && after >= 2) {
      const a = fitLine(q, count, i - skip, before, -1)
      const b = fitLine(q, count, i + skip, after, 1)
      const det = a[2] * b[3] - a[3] * b[2]
      if (Math.abs(det) > 0.2) {
        const t = ((b[0] - a[0]) * b[3] - (b[1] - a[1]) * b[2]) / det
        const px = a[0] + a[2] * t
        const py = a[1] + a[3] * t
        if (Math.hypot(px - x, py - y) <= CORNER_REACH) {
          x = px
          y = py
        }
      }
    }
    return { index: i, x, y }
  })
}

function solve(
  matrix: Float64Array,
  size: number,
  rhsX: Float64Array,
  rhsY: Float64Array,
  periodic: boolean,
): void {
  for (let column = 0; column < size; column++) {
    const rowEnd = periodic ? size : Math.min(size, column + 3)
    const colEnd = periodic ? size : Math.min(size, column + 5)
    let pivot = column
    let best = Math.abs(matrix[column * size + column]!)
    for (let row = column + 1; row < rowEnd; row++) {
      const candidate = Math.abs(matrix[row * size + column]!)
      if (candidate > best) {
        best = candidate
        pivot = row
      }
    }
    if (best < 1e-14) continue
    const colOffset = column * size
    if (pivot !== column) {
      const pivOffset = pivot * size
      for (let k = column; k < colEnd; k++) {
        const swap = matrix[colOffset + k]!
        matrix[colOffset + k] = matrix[pivOffset + k]!
        matrix[pivOffset + k] = swap
      }
      let swap = rhsX[column]!
      rhsX[column] = rhsX[pivot]!
      rhsX[pivot] = swap
      swap = rhsY[column]!
      rhsY[column] = rhsY[pivot]!
      rhsY[pivot] = swap
    }
    const diagonal = matrix[colOffset + column]!
    for (let row = column + 1; row < rowEnd; row++) {
      const rowOffset = row * size
      const factor = matrix[rowOffset + column]! / diagonal
      if (factor === 0) continue
      for (let k = column; k < colEnd; k++) {
        const colVal = matrix[colOffset + k]!
        if (colVal !== 0) matrix[rowOffset + k]! -= factor * colVal
      }
      rhsX[row]! -= factor * rhsX[column]!
      rhsY[row]! -= factor * rhsY[column]!
    }
  }
  for (let row = size - 1; row >= 0; row--) {
    const rowOffset = row * size
    const colEnd = periodic ? size : Math.min(size, row + 5)
    let sx = rhsX[row]!
    let sy = rhsY[row]!
    for (let k = row + 1; k < colEnd; k++) {
      const mVal = matrix[rowOffset + k]!
      if (mVal !== 0) {
        sx -= mVal * rhsX[k]!
        sy -= mVal * rhsY[k]!
      }
    }
    const diagonal = matrix[rowOffset + row]!
    rhsX[row] = Math.abs(diagonal) < 1e-14 ? 0 : sx / diagonal
    rhsY[row] = Math.abs(diagonal) < 1e-14 ? 0 : sy / diagonal
  }
}

/**
 * Squared distance from (px, py) to the quadratic at quads[o..o+5], searching from `guess`.
 * Newton on the derivative of the squared distance, clamped to the piece; three steps bring
 * a sample that is within a tolerance of the curve to well under a hundredth of a texel.
 */
function nearQuadraticSq(
  px: number,
  py: number,
  quads: Float64Array,
  o: number,
  guess: number,
  cutoffSq = 0,
): number {
  const x0 = quads[o]!
  const y0 = quads[o + 1]!
  const ax = x0 - 2 * quads[o + 2]! + quads[o + 4]!
  const ay = y0 - 2 * quads[o + 3]! + quads[o + 5]!
  const bx = 2 * (quads[o + 2]! - x0)
  const by = 2 * (quads[o + 3]! - y0)
  let t = guess < 0 ? 0 : guess > 1 ? 1 : guess
  let ex: number
  let ey: number
  for (let k = 0; k < 3; k++) {
    ex = (ax * t + bx) * t + x0 - px
    ey = (ay * t + by) * t + y0 - py
    const dSq = ex * ex + ey * ey
    if (dSq <= cutoffSq) return dSq
    const dx = 2 * ax * t + bx
    const dy = 2 * ay * t + by
    const slope = dx * dx + dy * dy + 2 * (ex * ax + ey * ay)
    if (!(slope > 1e-12)) return dSq
    let next = t - (ex * dx + ey * dy) / slope
    next = next < 0 ? 0 : next > 1 ? 1 : next
    if (next === t) return dSq
    t = next
  }
  ex = (ax * t + bx) * t + x0 - px
  ey = (ay * t + by) * t + y0 - py
  return ex * ex + ey * ey
}

/**
 * Least-squares quadratic B-spline through `data` (flat x, y) with parameters `u`.
 * `knots` has m + 1 increasing values covering the parameter range. Clamped: the curve starts
 * at `first` and ends at `last`. Periodic: `first`/`last` are null and the range wraps.
 * Returns the m Bézier pieces as flat `[x0, y0, cx, cy, x1, y1]`.
 */
function fitSpline(
  data: ArrayLike<number>,
  u: Float64Array,
  knots: Float64Array,
  first: SpanEnd,
  last: SpanEnd,
  scratch: TraceScratch,
): Float64Array {
  const m = knots.length - 1
  const periodic = first === null
  const matLen = m * m
  if (scratch.matrix.length < matLen) scratch.matrix = new Float64Array(matLen)
  if (scratch.rhsX.length < m) scratch.rhsX = new Float64Array(m)
  if (scratch.rhsY.length < m) scratch.rhsY = new Float64Array(m)
  if (scratch.ratio.length < m + 1) scratch.ratio = new Float64Array(m + 1)
  const { matrix, rhsX, rhsY, ratio } = scratch
  matrix.fill(0, 0, matLen)
  rhsX.fill(0, 0, m)
  rhsY.fill(0, 0, m)
  // Knot point k = ratio[k] * C[k-1] + (1 - ratio[k]) * C[k].
  for (let k = 0; k <= m; k++) {
    const here = knots[Math.min(k, m - 1) + 1]! - knots[Math.min(k, m - 1)]!
    const before = k > 0 ? knots[k]! - knots[k - 1]! : periodic ? knots[m]! - knots[m - 1]! : 0
    const after = k < m ? here : periodic ? knots[1]! - knots[0]! : 0
    ratio[k] = after / (before + after || 1)
  }
  let piece = 0
  for (let i = 0; i < u.length; i++) {
    while (piece < m - 1 && u[i]! >= knots[piece + 1]!) piece++
    const s = Math.min(
      1,
      Math.max(0, (u[i]! - knots[piece]!) / (knots[piece + 1]! - knots[piece]!)),
    )
    const oneMinusS = 1 - s
    const b0 = oneMinusS * oneMinusS
    const b1 = 2 * s * oneMinusS
    const b2 = s * s
    let x = data[2 * i]!
    let y = data[2 * i + 1]!
    const r0 = ratio[piece]!
    const r1 = ratio[piece + 1]!
    const hasPrev = periodic || piece > 0
    const hasNext = periodic || piece < m - 1
    let wPrev = 0
    let wCurr = b1
    let wNext = 0
    // Start knot.
    if (!hasPrev) {
      x -= b0 * first[0]
      y -= b0 * first[1]
    } else {
      wPrev = b0 * r0
      wCurr += b0 * (1 - r0)
    }
    // End knot. A clamped span is given both of its ends.
    if (!hasNext) {
      x -= b2 * last![0]
      y -= b2 * last![1]
    } else {
      wCurr += b2 * r1
      wNext = b2 * (1 - r1)
    }
    rhsX[piece]! += wCurr * x
    rhsY[piece]! += wCurr * y
    const rowCurr = piece * m
    matrix[rowCurr + piece]! += wCurr * wCurr
    if (hasPrev) {
      const colPrev = piece > 0 ? piece - 1 : m - 1
      const rowPrev = colPrev * m
      rhsX[colPrev]! += wPrev * x
      rhsY[colPrev]! += wPrev * y
      const prodPrevCurr = wPrev * wCurr
      matrix[rowPrev + colPrev]! += wPrev * wPrev
      matrix[rowPrev + piece]! += prodPrevCurr
      matrix[rowCurr + colPrev]! += prodPrevCurr
      if (hasNext) {
        const colNext = piece + 1 < m ? piece + 1 : 0
        const rowNext = colNext * m
        rhsX[colNext]! += wNext * x
        rhsY[colNext]! += wNext * y
        const prodCurrNext = wCurr * wNext
        const prodPrevNext = wPrev * wNext
        matrix[rowNext + colNext]! += wNext * wNext
        matrix[rowCurr + colNext]! += prodCurrNext
        matrix[rowNext + piece]! += prodCurrNext
        matrix[rowPrev + colNext]! += prodPrevNext
        matrix[rowNext + colPrev]! += prodPrevNext
      }
    } else if (hasNext) {
      const colNext = piece + 1 < m ? piece + 1 : 0
      const rowNext = colNext * m
      rhsX[colNext]! += wNext * x
      rhsY[colNext]! += wNext * y
      const prodCurrNext = wCurr * wNext
      matrix[rowNext + colNext]! += wNext * wNext
      matrix[rowCurr + colNext]! += prodCurrNext
      matrix[rowNext + piece]! += prodCurrNext
    }
  }
  // A light second-difference penalty keeps the system well posed where data is sparse.
  if (m >= 3) {
    const from = periodic ? 0 : 1
    const to = periodic ? m : m - 1
    for (let k = from; k < to; k++) {
      const i0 = k > 0 ? k - 1 : m - 1
      const i1 = k
      const i2 = k + 1 < m ? k + 1 : 0
      const r0 = i0 * m
      const r1 = i1 * m
      const r2 = i2 * m
      matrix[r0 + i0]! += SMOOTHING
      matrix[r0 + i1]! -= 2 * SMOOTHING
      matrix[r0 + i2]! += SMOOTHING
      matrix[r1 + i0]! -= 2 * SMOOTHING
      matrix[r1 + i1]! += 4 * SMOOTHING
      matrix[r1 + i2]! -= 2 * SMOOTHING
      matrix[r2 + i0]! += SMOOTHING
      matrix[r2 + i1]! -= 2 * SMOOTHING
      matrix[r2 + i2]! += SMOOTHING
    }
  } else {
    for (let k = 0; k < m; k++) matrix[k * m + k]! += 1e-9
  }
  solve(matrix, m, rhsX, rhsY, periodic)
  const quads = new Float64Array(m * 6)
  const knotPoint = (k: number, o: number): void => {
    if (!periodic && k === 0) {
      quads[o] = first[0]
      quads[o + 1] = first[1]
    } else if (!periodic && k === m) {
      quads[o] = last![0]
      quads[o + 1] = last![1]
    } else {
      const a = (k - 1 + m) % m
      const b = k % m
      quads[o] = ratio[k]! * rhsX[a]! + (1 - ratio[k]!) * rhsX[b]!
      quads[o + 1] = ratio[k]! * rhsY[a]! + (1 - ratio[k]!) * rhsY[b]!
    }
  }
  for (let k = 0; k < m; k++) {
    knotPoint(k, k * 6)
    quads[k * 6 + 2] = rhsX[k]!
    quads[k * 6 + 3] = rhsY[k]!
    knotPoint(k + 1, k * 6 + 4)
  }
  return quads
}

function evaluateSpan(
  data: ArrayLike<number>,
  u: Float64Array,
  knots: Float64Array,
  first: SpanEnd,
  last: SpanEnd,
  tolerance: number,
  scratch: TraceScratch,
): SpanFit {
  const periodic = first === null
  const m = knots.length - 1
  const quads = fitSpline(data, u, knots, first, last, scratch)
  const error = new Float64Array(m)
  let piece = 0
  let worst = 0
  const halfTolSq = (tolerance * 0.5) ** 2
  for (let i = 0; i < u.length; i++) {
    while (piece < m - 1 && u[i]! >= knots[piece + 1]!) piece++
    const px = data[2 * i]!
    const py = data[2 * i + 1]!
    const curErr = error[piece]!
    let dSq = nearQuadraticSq(
      px,
      py,
      quads,
      piece * 6,
      (u[i]! - knots[piece]!) / (knots[piece + 1]! - knots[piece]!),
      curErr < halfTolSq ? curErr : halfTolSq,
    )
    if (dSq > halfTolSq) {
      // The nearest point may lie on a neighbouring piece near a knot.
      if (piece > 0 || periodic) {
        const prevSq = nearQuadraticSq(px, py, quads, ((piece - 1 + m) % m) * 6, 1, curErr)
        if (prevSq < dSq) dSq = prevSq
      }
      if (piece < m - 1 || periodic) {
        const nextSq = nearQuadraticSq(px, py, quads, ((piece + 1) % m) * 6, 0, curErr)
        if (nextSq < dSq) dSq = nextSq
      }
    }
    if (dSq > curErr) error[piece] = dSq
  }
  for (let k = 0; k < m; k++) {
    const d = Math.sqrt(error[k]!)
    error[k] = d
    if (d > worst) worst = d
  }
  return { quads, error, worst }
}

function fitSpan(
  data: ArrayLike<number>,
  u: Float64Array,
  range: number,
  first: SpanEnd,
  last: SpanEnd,
  tolerance: number,
  scratch: TraceScratch,
): { quads: Float64Array; error: number } {
  const minimum = first === null ? 4 : 1
  const count = Math.max(minimum, Math.round(range / INITIAL_PIECE))
  let knots = Float64Array.from({ length: count + 1 }, (_, k) => (k * range) / count)
  let fitted = evaluateSpan(data, u, knots, first, last, tolerance, scratch)
  // Refine: halve every piece that misses the tolerance, refit, repeat.
  for (let round = 0; round < 12 && fitted.worst > tolerance; round++) {
    const m = knots.length - 1
    const next = [knots[0]!]
    let split = false
    for (let k = 0; k < m; k++) {
      if (fitted.error[k]! > tolerance && knots[k + 1]! - knots[k]! >= 2 * MIN_PIECE) {
        next.push((knots[k]! + knots[k + 1]!) / 2)
        split = true
      }
      next.push(knots[k + 1]!)
    }
    if (!split || next.length - 1 > MAX_PIECES) break
    knots = Float64Array.from(next)
    fitted = evaluateSpan(data, u, knots, first, last, tolerance, scratch)
  }
  // Local merge: two neighbouring pieces become one whose control point is where the first
  // piece's start tangent meets the second piece's end tangent, so both outer joins stay G1;
  // kept when the samples of both pieces stay within the tolerance.
  const quads = Array.from(fitted.quads)
  const bounds = Array.from(knots)
  const budget = Math.max(tolerance, fitted.worst)
  let worst = fitted.worst
  let low = 0
  const candidate = new Float64Array(6)
  for (let k = 0; k + 1 < quads.length / 6 && quads.length / 6 > minimum;) {
    const a = k * 6
    const b = a + 6
    const d1x = quads[a + 2]! - quads[a]!
    const d1y = quads[a + 3]! - quads[a + 1]!
    const d2x = quads[b + 2]! - quads[b + 4]!
    const d2y = quads[b + 3]! - quads[b + 5]!
    const rx = quads[b + 4]! - quads[a]!
    const ry = quads[b + 5]! - quads[a + 1]!
    const det = d1x * d2y - d1y * d2x
    const chord = Math.hypot(rx, ry)
    let ok = chord > 1e-9
    candidate[0] = quads[a]!
    candidate[1] = quads[a + 1]!
    candidate[4] = quads[b + 4]!
    candidate[5] = quads[b + 5]!
    let curved = false
    if (ok && Math.abs(det) > 1e-12) {
      const t = (rx * d2y - ry * d2x) / det
      const v = (rx * d1y - ry * d1x) / det
      if (t > 1e-6 && v > 1e-6) {
        candidate[2] = quads[a]! + d1x * t
        candidate[3] = quads[a + 1]! + d1y * t
        // A control point far beyond the chord means the tangents are nearly parallel.
        curved =
          Math.hypot(candidate[2] - quads[a]!, candidate[3] - quads[a + 1]!) +
            Math.hypot(candidate[2] - quads[b + 4]!, candidate[3] - quads[b + 5]!) <=
          3 * chord
      }
    }
    if (ok && !curved) {
      // Both tangents within half a degree of the chord: a straight piece (the joins it
      // leaves turn by less than that).
      const l1 = Math.hypot(d1x, d1y)
      const l2 = Math.hypot(d2x, d2y)
      const straight =
        Math.abs(d1x * ry - d1y * rx) <= STRAIGHT * l1 * chord &&
        d1x * rx + d1y * ry > 0 &&
        Math.abs(d2x * ry - d2y * rx) <= STRAIGHT * l2 * chord &&
        d2x * rx + d2y * ry < 0
      if (straight) {
        candidate[2] = (quads[a]! + quads[b + 4]!) / 2
        candidate[3] = (quads[a + 1]! + quads[b + 5]!) / 2
      } else ok = false
    }
    let error = 0
    if (ok) {
      while (low < u.length && u[low]! < bounds[k]!) low++
      let errorSq = 0
      const budgetSq = budget * budget
      const b0 = bounds[k]!
      const bSpan = bounds[k + 2]! - b0
      for (let i = low; i < u.length && u[i]! < bounds[k + 2]!; i++) {
        const dSq = nearQuadraticSq(
          data[2 * i]!,
          data[2 * i + 1]!,
          candidate,
          0,
          (u[i]! - b0) / bSpan,
          errorSq,
        )
        if (dSq > errorSq) {
          errorSq = dSq
          if (errorSq > budgetSq) break
        }
      }
      error = Math.sqrt(errorSq)
    }
    if (ok && error <= budget) {
      quads.splice(a, 12, ...candidate)
      bounds.splice(k + 1, 1)
      if (error > worst) worst = error
    } else k++
  }
  return { quads: Float64Array.from(quads), error: worst }
}

/**
 * Fits a closed polyline (flat `[x, y, ...]`, the last point joins the first) with quadratic
 * Béziers whose distance from the resampled polyline stays within `tolerance` texels
 * (round-off within a texel of a corner is exempt). Orientation is the input's. Null when the
 * polyline is degenerate.
 */
export function fitClosedPolyline(
  points: ArrayLike<number>,
  tolerance: number,
  scratch: TraceScratch,
): FittedOutline | null {
  if (points.length < 6) return null
  const { samples: q, count, length, spacing } = resampleClosed(points)
  if (!(length > 1e-6)) return null
  const corners = findCorners(q, count, spacing)
  const pieces: number[] = []
  let maxError = 0
  if (corners.length === 0) {
    const u = Float64Array.from({ length: count }, (_, i) => i * spacing)
    const fitted = fitSpan(q, u, length, null, null, tolerance, scratch)
    maxError = fitted.error
    for (const value of fitted.quads) pieces.push(value)
  } else {
    const trim = Math.max(1, Math.round(CORNER_TRIM / spacing))
    for (let c = 0; c < corners.length; c++) {
      const from = corners[c]!
      const to = corners[(c + 1) % corners.length]!
      const steps =
        corners.length === 1 ? count : (((to.index - from.index) % count) + count) % count
      const range = steps * spacing
      const spanLen = steps - 2 * trim + 1
      if (spanLen < 2) {
        pieces.push(from.x, from.y, (from.x + to.x) / 2, (from.y + to.y) / 2, to.x, to.y)
      } else {
        const data = new Float64Array(spanLen * 2)
        const u = new Float64Array(spanLen)
        for (let idx = 0, k = trim; idx < spanLen; idx++, k++) {
          const i = (from.index + k) % count
          data[2 * idx] = q[2 * i]!
          data[2 * idx + 1] = q[2 * i + 1]!
          u[idx] = k * spacing
        }
        const fitted = fitSpan(data, u, range, [from.x, from.y], [to.x, to.y], tolerance, scratch)
        if (fitted.error > maxError) maxError = fitted.error
        for (const value of fitted.quads) pieces.push(value)
      }
    }
  }
  const quadratics = Float64Array.from(pieces)
  const n = quadratics.length / 6
  // Make the chain exactly closed: each piece starts where the previous one ended.
  for (let i = 0; i < n; i++) {
    const previous = ((i - 1 + n) % n) * 6
    quadratics[i * 6] = quadratics[previous + 4]!
    quadratics[i * 6 + 1] = quadratics[previous + 5]!
  }
  return { quadratics, maxError }
}
