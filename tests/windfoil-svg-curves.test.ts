import { describe, expect, it } from 'vitest'
import {
  affineNorm,
  applyAffine,
  arcToCubics,
  ContourBuilder,
  cubicToQuadratics,
  identity,
  invert,
  multiply,
  quadraticBounds,
  type Cubic,
} from '../src/windfoil/svg/curves.js'
import {
  canonicalizeWinding,
  flattenContour,
  signedArea,
  windingAt,
} from '../src/windfoil/svg/winding.js'
import type { WindfoilAffine, WindfoilQuadratic } from '../src/types.js'
const rectangle = (x: number, y: number, w: number, h: number): WindfoilQuadratic[] => {
  const b = new ContourBuilder()
  b.move(x, y)
  b.line(x + w, y)
  b.line(x + w, y + h)
  b.line(x, y + h)
  b.close()
  return b.contours[0]!
}
describe('SVG curve conversion', () => {
  it('bounds a seeded corpus of cubic approximation errors', () => {
    let seed = 1337
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return (seed / 2 ** 32 - 0.5) * 2000
    }
    const adversarial: Cubic[] = [
      [0, 0, 200, 300, -200, 300, 0, 0], // Closed loop.
      [0, 0, 100, 100, -100, -100, 0, 0], // Collinear cusp and reversal.
      [0, 0, 1, 1, 2, 2, 3, 3], // Exact promoted line.
      [-100, 0, -100, 200, 100, -200, 100, 0], // Inflection.
      [0, 0, 1, 1e-8, 2, -1e-8, 3, 0], // Near-collinear precision case.
    ]
    for (let sample = 0; sample < 1000; sample++) {
      const p = adversarial[sample] ?? (Array.from({ length: 8 }, random) as unknown as Cubic),
        tolerance = 0.25,
        { quads, capped } = cubicToQuadratics(p, tolerance)
      expect(capped).toBe(false)
      let maximumError = 0
      for (let k = 0; k < 256; k++) {
        const t = k / 255,
          index = Math.min(quads.length - 1, Math.floor(t * quads.length)),
          u = t * quads.length - index,
          q = quads[index]!
        let squaredError = 0
        for (let axis = 0; axis < 2; axis++) {
          const exact =
            (1 - t) ** 3 * p[axis]! +
            3 * (1 - t) ** 2 * t * p[axis + 2]! +
            3 * (1 - t) * t * t * p[axis + 4]! +
            t ** 3 * p[axis + 6]!
          const approximation =
            (1 - u) ** 2 * q[axis]! + 2 * (1 - u) * u * q[axis + 2]! + u * u * q[axis + 4]!
          squaredError += (exact - approximation) ** 2
        }
        maximumError = Math.max(maximumError, Math.sqrt(squaredError))
      }
      expect(maximumError).toBeLessThanOrEqual(tolerance + 1e-8)
    }
  })
  it('caps extreme cubics and normalizes arcs', () => {
    expect(cubicToQuadratics([0, 0, 1e8, 1e8, -1e8, 1e8, 0, 0], 1e-12).capped).toBe(true)
    const arc = {
      type: 'arc' as const,
      rx: 1,
      ry: -1,
      rotation: 35,
      large: true,
      sweep: true,
      x: 10,
      y: 0,
    }
    const cubics = arcToCubics([0, 0], arc, 3, 0.01)
    expect(cubics.length).toBeGreaterThanOrEqual(2)
    expect(cubics[0]!.slice(0, 2)).toEqual([0, 0])
    expect(cubics.at(-1)!.slice(6)).toEqual([10, 0])
    expect(arcToCubics([10, 0], arc, 1, 0.1)).toEqual([])
    expect(arcToCubics([0, 0], { ...arc, rx: 0 }, 1, 0.1)).toEqual([])
    expect(arcToCubics([0, 0], { ...arc, sweep: false }, 1, 0.1).length).toBeGreaterThan(0)
  })
  it('bounds transformed arc-to-quadratic error for every arc flag combination', () => {
    const transforms: WindfoilAffine[] = [
      identity,
      [100, 0, 0, 100, 2, -3],
      [2, 1, 15, 0.5, 100, -40],
      [-3, 2, 1, 4, 8, 9],
    ]
    const tolerance = 0.25
    for (const transform of transforms)
      for (const large of [false, true])
        for (const sweep of [false, true]) {
          const arc = { type: 'arc' as const, rx: 10, ry: 4, rotation: 0, large, sweep, x: 0, y: 4 }
          const cubics = arcToCubics([10, 0], arc, affineNorm(transform), tolerance / 2)
          const center = large === sweep ? [10, 4] : [0, 0]
          const inverse = invert(transform)!
          let maximum = 0
          for (const cubic of cubics) {
            const transformed = [
              ...applyAffine(transform, cubic[0], cubic[1]),
              ...applyAffine(transform, cubic[2], cubic[3]),
              ...applyAffine(transform, cubic[4], cubic[5]),
              ...applyAffine(transform, cubic[6], cubic[7]),
            ] as Cubic
            for (const q of cubicToQuadratics(transformed, tolerance / 2).quads)
              for (let k = 0; k <= 256; k++) {
                const t = k / 256,
                  u = 1 - t
                const actual = [
                  u * u * q[0] + 2 * u * t * q[2] + t * t * q[4],
                  u * u * q[1] + 2 * u * t * q[3] + t * t * q[5],
                ] as const
                const local = applyAffine(inverse, ...actual)
                const angle = Math.atan2((local[1] - center[1]!) / 4, (local[0] - center[0]!) / 10)
                const exact = applyAffine(
                  transform,
                  center[0]! + 10 * Math.cos(angle),
                  center[1]! + 4 * Math.sin(angle),
                )
                maximum = Math.max(maximum, Math.hypot(actual[0] - exact[0], actual[1] - exact[1]))
              }
          }
          expect(maximum).toBeLessThanOrEqual(tolerance)
          if (transform[0] === 100)
            expect(cubics.length).toBeGreaterThan(
              arcToCubics([10, 0], arc, 1, tolerance / 2).length,
            )
        }
  })
  it('closes contours bitwise and computes tight extrema', () => {
    const b = new ContourBuilder()
    b.move(0.1, 0.2)
    b.quad(0, 5, 3.1, 0.2)
    b.line(0.1, 0.2)
    b.close()
    const contour = b.contours[0]!
    expect(Object.is(contour[0]![0], contour.at(-1)![4])).toBe(true)
    expect(Object.is(contour[0]![1], contour.at(-1)![5])).toBe(true)
    expect(quadraticBounds([[0, 0, 1, 2, 2, 0]])).toEqual([0, 0, 2, 1])
    expect(quadraticBounds([])).toEqual([0, 0, 0, 0])
    expect(quadraticBounds([[0, 0, 1, -(2 ** -149), 2, 0]])).toEqual([0, -(2 ** -149), 2, 0])
    expect(() => b.quad(Infinity, 0, 1, 1)).toThrow(RangeError)
  })
  it('composes and inverts affine transformations', () => {
    const m = [2, 1, 3, 4, 5, 6] as const,
      inv = invert(m)!
    multiply(m, inv).forEach((v, i) => expect(v).toBeCloseTo(identity[i]!))
    expect(applyAffine(identity, 3, 4)).toEqual([3, 4])
    expect(invert([0, 0, 0, 0, 0, 0])).toBeNull()
    expect(affineNorm([2, 0, 0, 3, 0, 0])).toBe(3)
  })
})
describe('SVG canonical winding', () => {
  it('rewinds evenodd holes and removes redundant nonzero rings', () => {
    const outer = rectangle(0, 0, 10, 10),
      inner = rectangle(2, 2, 6, 6)
    const evenodd = canonicalizeWinding([outer, inner], 'evenodd', 0.01)
    expect(evenodd.contours).toHaveLength(2)
    expect(
      evenodd.contours.reduce((n, c) => n + windingAt(flattenContour(c, 0.01), [5, 5]), 0),
    ).toBe(0)
    const nonzero = canonicalizeWinding([outer, inner], 'nonzero', 0.01)
    expect(nonzero.contours).toHaveLength(1)
    expect(nonzero.dropped).toBe(1)
  })
  it('normalizes mirrored shapes and detects crossing contours', () => {
    const reversed = rectangle(0, 0, 10, 10)
      .reverse()
      .map((q) => [q[4], q[5], q[2], q[3], q[0], q[1]] as WindfoilQuadratic)
    expect(
      signedArea(flattenContour(canonicalizeWinding([reversed], 'nonzero', 0.1).contours[0]!, 0.1)),
    ).toBeGreaterThan(0)
    expect(
      canonicalizeWinding([rectangle(0, 0, 10, 10), rectangle(5, 5, 10, 10)], 'evenodd', 0.1)
        .intersects,
    ).toBe(true)
    expect(canonicalizeWinding([[[0, 0, 1, 0, 2, 0]]], 'nonzero', 0.1).dropped).toBe(1)
  })
})
