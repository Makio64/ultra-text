import { describe, expect, it } from 'vitest'
import { canonicalizeWinding, contoursIntersect } from '../src/windfoil/svg/winding.js'
import type { Point } from '../src/windfoil/svg/curves.js'
import type { WindfoilQuadratic } from '../src/types.js'

// Unaccelerated pairwise oracle: each pair is independently culled in both axes.
function pairwiseIntersects(contours: readonly (readonly Point[])[]): boolean {
  const segments = contours.flatMap((points, contour) =>
    points.slice(1).map((b, index) => ({
      a: points[index]!,
      b,
      contour,
      index,
      last: points.length - 2,
    })),
  )
  const cross = (a: Point, b: Point, p: Point): number =>
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!
    for (let j = 0; j < i; j++) {
      const t = segments[j]!
      if (
        s.contour === t.contour &&
        (Math.abs(s.index - t.index) === 1 || Math.abs(s.index - t.index) === s.last)
      )
        continue
      if (
        [0, 1].some(
          (axis) =>
            Math.max(s.a[axis]!, s.b[axis]!) < Math.min(t.a[axis]!, t.b[axis]!) ||
            Math.max(t.a[axis]!, t.b[axis]!) < Math.min(s.a[axis]!, s.b[axis]!),
        )
      )
        continue
      if (
        cross(s.a, s.b, t.a) * cross(s.a, s.b, t.b) <= 0 &&
        cross(t.a, t.b, s.a) * cross(t.a, t.b, s.b) <= 0
      )
        return true
    }
  }
  return false
}

describe('SVG contour intersection sweep', () => {
  it('matches an exhaustive oracle for both axes, touching edges, and degenerate segments', () => {
    let seed = 953210
    const random = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    for (let sample = 0; sample < 2000; sample++) {
      const contours: Point[][] = Array.from({ length: 1 + (sample % 12) }, (_, contour) => {
        const x = contour * 8,
          y = contour * 8,
          points: Point[] = Array.from({ length: 3 + (sample % 9) }, () => [
            x + Math.floor(random() * 12),
            y + Math.floor(random() * 12),
          ])
        points.push(points[0]!)
        return points
      })
      const scale = sample % 2 ? [100, 1] : [1, 100]
      const scaled = contours.map((points) =>
        points.map(([x, y]): Point => [x * scale[0]!, y * scale[1]!]),
      )
      expect(contoursIntersect(scaled), `sample ${sample}`).toBe(pairwiseIntersects(scaled))
    }
  })

  it('handles long horizontal and vertical rows without changing contact detection', () => {
    const row: Point[][] = Array.from({ length: 64 }, (_, i) => [
      [i * 12, 0],
      [i * 12 + 10, 0],
      [i * 12 + 10, 10],
      [i * 12, 10],
      [i * 12, 0],
    ])
    expect(contoursIntersect(row)).toBe(false)
    expect(contoursIntersect(row.map((c) => c.map(([x, y]): Point => [y, x])))).toBe(false)
    row.push([
      [10, 0],
      [12, 0],
      [12, 10],
      [10, 10],
      [10, 0],
    ])
    expect(contoursIntersect(row)).toBe(true)
    expect(contoursIntersect(row.map((c) => c.map(([x, y]): Point => [y, x])))).toBe(true)
  })

  it('computes exact Archimedes quadratic Bezier contour area independent of flattening tolerance', () => {
    // A two-quadratic lens whose chord polygon [0,0] -> [10,0] -> [0,0] has zero chord area,
    // while its true curved area is -200/3 (clockwise). Even under a huge flattening tolerance,
    // exact Archimedes integration preserves and reverses the contour instead of dropping it.
    const cwLens: WindfoilQuadratic[] = [
      [0, 0, 5, 10, 10, 0],
      [10, 0, 5, -10, 0, 0],
    ]
    const single = canonicalizeWinding([cwLens], 'nonzero', 100, false)
    expect(single.dropped).toBe(0)
    expect(single.contours).toHaveLength(1)
    expect(single.contours[0]![0]).toEqual([0, 0, 5, -10, 10, 0])

    const multi = canonicalizeWinding([cwLens], 'nonzero', 100, true)
    expect(multi.dropped).toBe(0)
    expect(multi.contours).toHaveLength(1)
    expect(multi.contours[0]![0]).toEqual([0, 0, 5, -10, 10, 0])
  })
})
