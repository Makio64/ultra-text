import type { WindfoilBoundingBox, WindfoilQuadratic } from '../../src/types.js'

export type Point = readonly [number, number]

/** Uniform reference sampling, independent of the converter's recursive flattener. */
export function sampleContour(curves: readonly WindfoilQuadratic[], steps = 128): Point[] {
  const points: Point[] = []
  for (const q of curves)
    for (let i = 0; i < steps; i++) {
      const t = i / steps,
        u = 1 - t
      points.push([
        u * u * q[0] + 2 * u * t * q[2] + t * t * q[4],
        u * u * q[1] + 2 * u * t * q[3] + t * t * q[5],
      ])
    }
  return points
}

export function polygonArea(points: readonly Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!
    area += a[0] * b[1] - a[1] * b[0]
  }
  return area / 2
}

/** Green's theorem on each contour clipped to a pixel box computes ∫w dA. */
export function integralCoverage(
  contours: readonly (readonly Point[])[],
  box: WindfoilBoundingBox,
): number {
  const clip = (input: readonly Point[], axis: 0 | 1, edge: number, sign: number): Point[] => {
    const output: Point[] = []
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!,
        b = input[(i + 1) % input.length]!
      const insideA = sign * (a[axis] - edge) >= 0,
        insideB = sign * (b[axis] - edge) >= 0
      if (insideA) output.push(a)
      if (insideA !== insideB) {
        const t = (edge - a[axis]) / (b[axis] - a[axis])
        output.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
      }
    }
    return output
  }
  let integral = 0
  for (const contour of contours) {
    let polygon = [...contour]
    polygon = clip(polygon, 0, box[0], 1)
    polygon = clip(polygon, 0, box[2], -1)
    polygon = clip(polygon, 1, box[1], 1)
    polygon = clip(polygon, 1, box[3], -1)
    integral += polygonArea(polygon)
  }
  return Math.min(1, Math.abs(integral) / ((box[2] - box[0]) * (box[3] - box[1])))
}

/** A separate horizontal-ray point oracle, preserving the input SVG fill rule. */
export function sampledCoverage(
  contours: readonly (readonly Point[])[],
  box: WindfoilBoundingBox,
  rule: 'evenodd' | 'nonzero',
  grid = 64,
): number {
  let filled = 0
  for (let y = 0; y < grid; y++)
    for (let x = 0; x < grid; x++) {
      const px = box[0] + ((x + 0.5) / grid) * (box[2] - box[0]),
        py = box[1] + ((y + 0.5) / grid) * (box[3] - box[1])
      let winding = 0
      for (const contour of contours)
        for (let i = 0; i < contour.length; i++) {
          const a = contour[i]!,
            b = contour[(i + 1) % contour.length]!
          if ((a[1] <= py && b[1] > py) || (a[1] > py && b[1] <= py)) {
            const crossingX = a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
            if (crossingX > px) winding += b[1] > a[1] ? 1 : -1
          }
        }
      if (rule === 'evenodd' ? Math.abs(winding) % 2 === 1 : winding !== 0) filled++
    }
  return filled / grid ** 2
}

export function outlineArea(quadratics: ArrayLike<number>): number {
  // Direct quadratic line integral; no winding canonicalizer or flattener used.
  let area = 0
  for (let i = 0; i < quadratics.length; i += 6) {
    const x0 = quadratics[i]!,
      y0 = quadratics[i + 1]!,
      cx = quadratics[i + 2]!,
      cy = quadratics[i + 3]!,
      x1 = quadratics[i + 4]!,
      y1 = quadratics[i + 5]!
    area += (2 * (x0 * cy - y0 * cx + cx * y1 - cy * x1) + x0 * y1 - y0 * x1) / 6
  }
  return Math.abs(area)
}
