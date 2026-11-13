// Outline tracer: marching-squares contours of a box-filtered coverage mask at 0.5, with the
// area-exact crossing rule.
//
// Conventions
// - Sample (x, y) of the mask sits at the texel centre (x + 0.5, y + 0.5); it is inside when its
//   coverage is at least 0.5.
// - The mask is surrounded by one implicit ring of empty samples (at -0.5 and size + 0.5), so
//   every contour closes even when ink touches the mask's edge.
// - Contours are closed polylines `[x0, y0, x1, y1, ...]` in mask coordinates (y down); the last
//   point joins the first. Inside is kept on the right of the direction of travel, so outer
//   boundaries have POSITIVE signed area `sum(x[i]*y[i+1] - x[i+1]*y[i]) / 2` and holes NEGATIVE:
//   once Y points up, outer contours run clockwise and holes counter-clockwise, as in TrueType.
// - Ambiguous cells use the bilinear saddle rule, so a hairline diagonal one texel wide stays one
//   stroke instead of breaking at every step; exact ties leave the two inside samples separate.
import type { CoverageMask, Polyline, TraceScratch } from './types.js'

/** A coverage within this much of 0 or 1 is pure (after subtracting the 0.5 iso level). */
const PURE = 0.499

// Directed edges keep inside samples on the right in y-down coordinates.
const CONNECTIONS: readonly (readonly number[])[] = [
  [],
  [0, 3],
  [1, 0],
  [1, 3],
  [2, 1],
  [],
  [2, 0],
  [2, 3],
  [3, 2],
  [0, 2],
  [],
  [1, 2],
  [3, 1],
  [0, 1],
  [3, 0],
  [],
]
const JOIN_5: readonly number[] = [0, 1, 2, 3]
const SPLIT_5: readonly number[] = [0, 3, 2, 1]
const JOIN_10: readonly number[] = [3, 0, 1, 2]
const SPLIT_10: readonly number[] = [1, 0, 3, 2]

function edgeAt(vertex: number, columns: number, side: number): number {
  return side === 0
    ? 2 * vertex
    : side === 1
      ? 2 * (vertex + 1) + 1
      : side === 2
        ? 2 * (vertex + columns)
        : 2 * vertex + 1
}

function collinear(points: readonly number[], a: number, b: number, c: number): boolean {
  const dx = points[b]! - points[a]!
  const dy = points[b + 1]! - points[a + 1]!
  const ex = points[c]! - points[b]!
  const ey = points[c + 1]! - points[b + 1]!
  return dx * ey === dy * ex && dx * ex + dy * ey >= 0
}

/** Appends a point, dropping exact straight continuations; no geometric tolerance. */
function appendPoint(points: Polyline, x: number, y: number): void {
  points.push(x, y)
  while (
    points.length >= 6 &&
    collinear(points, points.length - 6, points.length - 4, points.length - 2)
  ) {
    points[points.length - 4] = points[points.length - 2]!
    points[points.length - 3] = points[points.length - 1]!
    points.length -= 2
  }
}

function closeContour(points: Polyline): void {
  while (points.length >= 6 && collinear(points, points.length - 4, points.length - 2, 0))
    points.length -= 2
  while (points.length >= 6 && collinear(points, points.length - 2, 0, 2)) {
    points.copyWithin(0, 2)
    points.length -= 2
  }
}

/**
 * Closed 0.5 contours of the coverage `mask`, in mask pixel coordinates (y down): outer
 * boundaries have positive signed area, holes negative. Empty without ink. `scratch` is grown
 * as needed and every edge mark it holds is cleared again before this returns.
 */
export function marchingSquares(mask: CoverageMask, scratch: TraceScratch): Polyline[] {
  const { alpha, width, height } = mask
  const stride = mask.stride ?? 1
  const offset = mask.offset ?? 0
  const scale = alpha instanceof Float32Array ? 1 : 1 / 255
  const columns = width + 2
  const vertices = columns * (height + 2)
  if (scratch.value.length < vertices) scratch.value = new Float32Array(vertices)
  const value = scratch.value
  value.fill(-0.5, 0, columns)
  value.fill(-0.5, vertices - columns, vertices)
  let inkLeft = width
  let inkTop = height
  let inkRight = -1
  let inkBottom = -1
  for (let y = 0; y < height; y++) {
    const target = (y + 1) * columns + 1
    value[target - 1] = -0.5
    value[target + width] = -0.5
    let source = y * width * stride + offset
    let first = -1
    let last = -1
    for (let x = 0; x < width; x++, source += stride) {
      const v = alpha[source]! * scale - 0.5
      value[target + x] = v
      if (v >= 0) {
        if (first < 0) first = x
        last = x
      }
    }
    if (first >= 0) {
      if (first < inkLeft) inkLeft = first
      if (last > inkRight) inkRight = last
      if (y < inkTop) inkTop = y
      inkBottom = y
    }
  }
  if (inkRight < 0) return []
  if (scratch.next.length < 2 * vertices) scratch.next = new Int32Array(2 * vertices)
  const next = scratch.next
  const active: number[] = []
  for (let y = inkTop; y <= inkBottom + 1; y++) {
    let vertex = y * columns + inkLeft
    let a = value[vertex]!
    let d = value[vertex + columns]!
    let maskAD = (a >= 0 ? 1 : 0) | (d >= 0 ? 8 : 0)
    for (let x = inkLeft; x <= inkRight + 1; x++, vertex++) {
      const b = value[vertex + 1]!
      const c = value[vertex + columns + 1]!
      const maskBC = (b >= 0 ? 2 : 0) | (c >= 0 ? 4 : 0)
      const cell = maskAD | maskBC
      if (cell !== 0 && cell !== 15) {
        const saddle = a * c - b * d
        const connections =
          cell === 5
            ? saddle > 0
              ? JOIN_5
              : SPLIT_5
            : cell === 10
              ? saddle < 0
                ? JOIN_10
                : SPLIT_10
              : CONNECTIONS[cell]!
        for (let i = 0; i < connections.length; i += 2) {
          const from = edgeAt(vertex, columns, connections[i]!)
          next[from] = edgeAt(vertex, columns, connections[i + 1]!) + 1
          active.push(from)
        }
      }
      a = b
      d = c
      maskAD = ((maskBC >>> 1) & 1) | ((maskBC << 1) & 8)
    }
  }
  const contours: Polyline[] = []
  for (const start of active) {
    if (next[start] === 0) continue
    const points: Polyline = []
    let edge = start
    do {
      const vertex = edge >>> 1
      const vertical = edge & 1
      const y = (vertex / columns) | 0
      const x = vertex - y * columns
      const a = value[vertex]!
      const b = value[vertex + (vertical ? columns : 1)]!
      let t = -a / (b - a)
      // Box-filtered coverage: when one of the two samples is pure (fully in or out), the edge
      // crosses this grid line inside the other one, and the two coverages add up to its
      // position. Linear interpolation is off by up to 0.09 texel there.
      const high = a >= 0 ? a : b
      const low = a >= 0 ? b : a
      if (high >= PURE || low <= -PURE) {
        let fromHigh = high + low + 0.5
        fromHigh = fromHigh < 0 ? 0 : fromHigh > 1 ? 1 : fromHigh
        t = a >= 0 ? fromHigh : 1 - fromHigh
      }
      appendPoint(points, x - 0.5 + (vertical ? 0 : t), y - 0.5 + (vertical ? t : 0))
      const successor = next[edge]! - 1
      next[edge] = 0
      edge = successor
    } while (edge !== start)
    closeContour(points)
    if (points.length >= 6) contours.push(points)
  }
  return contours
}
