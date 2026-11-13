import { describe, expect, it } from 'vitest'

import { marchingSquares } from '../src/windfoil/trace/contours.js'
import { createTraceScratch, traceCoverage } from '../src/windfoil/trace/outline.js'

/** Exact box-filtered coverage of axis-aligned rectangles: `[x0, y0, x1, y1, sign]`. */
function rectangleMask(
  width: number,
  height: number,
  rectangles: readonly (readonly [number, number, number, number, number])[],
): Float32Array {
  const mask = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let coverage = 0
      for (const [x0, y0, x1, y1, sign] of rectangles) {
        const w = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0))
        const h = Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0))
        coverage += sign * w * h
      }
      mask[y * width + x] = coverage
    }
  }
  return mask
}

/** Box-filtered coverage of any shape, from `n` x `n` samples per texel. */
function sampledMask(
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
  n = 32,
): Float32Array {
  const mask = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hits = 0
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) if (inside(x + (i + 0.5) / n, y + (j + 0.5) / n)) hits++
      }
      mask[y * width + x] = hits / (n * n)
    }
  }
  return mask
}

/** Closed contours of a quadratic run: a piece that does not start where the last ended opens one. */
function contoursOf(q: Float32Array): Float32Array[] {
  const out: number[][] = []
  for (let o = 0; o < q.length; o += 6) {
    const last = out.at(-1)
    if (!last || last.at(-2) !== q[o] || last.at(-1) !== q[o + 1]) out.push([])
    out.at(-1)!.push(...q.subarray(o, o + 6))
  }
  return out.map((contour) => Float32Array.from(contour))
}

/** Signed area of a closed quadratic chain, Y up: negative for clockwise. */
function areaOf(q: ArrayLike<number>): number {
  let area = 0
  for (let o = 0; o < q.length; o += 6) {
    const [x0, y0, cx, cy, x1, y1] = [q[o]!, q[o + 1]!, q[o + 2]!, q[o + 3]!, q[o + 4]!, q[o + 5]!]
    area += (x0 * y1 - x1 * y0) / 2 - ((x0 - cx) * (y1 - cy) - (x1 - cx) * (y0 - cy)) / 3
  }
  return area
}

/** Distance from (px, py) to the nearest point of the quadratic run, sampled finely. */
function distanceTo(q: Float32Array, px: number, py: number): number {
  let best = Infinity
  for (let o = 0; o < q.length; o += 6) {
    for (let k = 0; k <= 64; k++) {
      const t = k / 64
      const u = 1 - t
      const x = u * u * q[o]! + 2 * u * t * q[o + 2]! + t * t * q[o + 4]!
      const y = u * u * q[o + 1]! + 2 * u * t * q[o + 3]! + t * t * q[o + 5]!
      best = Math.min(best, Math.hypot(x - px, y - py))
    }
  }
  return best
}

describe('outline tracer core', () => {
  it('traces a square with a square hole as two contours of opposite winding and the exact area', () => {
    const width = 128
    const height = 128
    // Off-grid edges exercise the area-exact crossings.
    const alpha = rectangleMask(width, height, [
      [10.3, 12.6, 110.8, 113.1, 1],
      [40.45, 41.7, 80.25, 81.9, -1],
    ])
    const { quadratics, bbox } = traceCoverage(
      { alpha, width, height, originX: 10, baselineY: 120 },
      0.25,
    )
    const contours = contoursOf(quadratics)
    expect(contours).toHaveLength(2)
    const areas = contours.map(areaOf).sort((a, b) => a - b)
    // TrueType winding with Y up: the outer contour runs clockwise, the hole counter-clockwise.
    expect(areas[0]).toBeLessThan(0)
    expect(areas[1]).toBeGreaterThan(0)
    const exact = 100.5 * 100.5 - 39.8 * 40.2
    expect(Math.abs(Math.abs(areas[0]! + areas[1]!) - exact) / exact).toBeLessThan(0.005)
    // Glyph frame: x from the pen, y up from the baseline.
    expect(bbox[0]).toBeCloseTo(0.3, 1)
    expect(bbox[2]).toBeCloseTo(100.8, 1)
    expect(bbox[1]).toBeCloseTo(120 - 113.1, 1)
    expect(bbox[3]).toBeCloseTo(120 - 12.6, 1)
  })

  it('keeps a one-pixel 45° hairline as one stroke through its saddle cells', () => {
    const width = 64
    const height = 64
    // A strip one pixel wide (perpendicular) along y = x, from (8, 8) to (56, 56).
    const alpha = sampledMask(width, height, (x, y) => {
      const along = (x + y) / Math.SQRT2
      const across = (x - y) / Math.SQRT2
      return Math.abs(across) <= 0.5 && along >= 8 * Math.SQRT2 && along <= 56 * Math.SQRT2
    })
    const scratch = createTraceScratch()
    expect(
      marchingSquares({ alpha, width, height, originX: 0, baselineY: 0 }, scratch),
    ).toHaveLength(1)
    const { quadratics } = traceCoverage(
      { alpha, width, height, originX: 0, baselineY: 0 },
      0.25,
      scratch,
    )
    const contours = contoursOf(quadratics)
    expect(contours).toHaveLength(1)
    // Y up: clockwise, as an outer contour.
    expect(areaOf(contours[0]!)).toBeLessThan(0)
    expect(Math.abs(areaOf(contours[0]!))).toBeGreaterThan(0.8 * 48 * Math.SQRT2)
  })

  it('keeps the vertex of an acute wedge within a bounded distance', () => {
    const width = 160
    const height = 96
    // A 30° wedge with its vertex at (20.4, 48.3), opening to the right.
    const half = (15 * Math.PI) / 180
    const [vx, vy] = [20.4, 48.3]
    const alpha = sampledMask(width, height, (x, y) => {
      const dx = x - vx
      const dy = y - vy
      return dx > 0 && dx < 120 && Math.abs(dy) <= dx * Math.tan(half)
    })
    const { quadratics } = traceCoverage({ alpha, width, height, originX: 0, baselineY: 0 }, 0.25)
    expect(contoursOf(quadratics)).toHaveLength(1)
    // The vertex in the glyph frame (Y up): the fit rebuilds most of what the 0.5 contour of
    // a box-filtered vertex loses.
    expect(distanceTo(quadratics, vx, -vy)).toBeLessThan(1)
    // Away from the vertex the sides stay within the tolerance and the raster's round-off.
    const sx = vx + 80
    const sy = vy + 80 * Math.tan(half)
    expect(distanceTo(quadratics, sx, -sy)).toBeLessThan(0.3)
  })

  it('keeps the traced polyline as straight pieces where the fit collapses', () => {
    // Two faint texels side by side: the fitted chain encloses nothing, the 0.5 contour does.
    const alpha = new Float32Array(8 * 8)
    alpha[3 * 8 + 3] = 0.6
    alpha[3 * 8 + 4] = 0.6
    const { quadratics } = traceCoverage(
      { alpha, width: 8, height: 8, originX: 0, baselineY: 0 },
      0.25,
    )
    expect(contoursOf(quadratics)).toHaveLength(1)
    expect(quadratics).toHaveLength(6 * 6)
    for (let o = 0; o < quadratics.length; o += 6) {
      expect(quadratics[o + 2]).toBeCloseTo((quadratics[o]! + quadratics[o + 4]!) / 2, 6)
      expect(quadratics[o + 3]).toBeCloseTo((quadratics[o + 1]! + quadratics[o + 5]!) / 2, 6)
    }
    expect(areaOf(quadratics)).toBeCloseTo(-0.22, 3)
  })

  it('returns no curves and a zero box for a blank mask, bytes or floats', () => {
    for (const alpha of [new Uint8ClampedArray(32 * 16), new Float32Array(32 * 16).fill(0.49)]) {
      const traced = traceCoverage(
        { alpha, width: 32, height: 16, originX: 4, baselineY: 12 },
        0.25,
      )
      expect(traced.quadratics).toHaveLength(0)
      expect(traced.bbox).toEqual([0, 0, 0, 0])
    }
  })

  it('reads canvas RGBA alpha in place and closes ink that touches the mask edge', () => {
    const width = 24
    const height = 20
    const rgba = new Uint8ClampedArray(width * height * 4)
    // Full coverage from the left edge to x = 12, rows 0..20: ink on three edges of the mask.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < 12; x++) rgba[(y * width + x) * 4 + 3] = 255
    const { quadratics, bbox } = traceCoverage(
      { alpha: rgba, width, height, stride: 4, offset: 3, originX: 0, baselineY: height },
      0.25,
    )
    expect(contoursOf(quadratics)).toHaveLength(1)
    expect(Math.abs(areaOf(quadratics))).toBeCloseTo(12 * 20, 0)
    for (const [index, value] of [0, 0, 12, 20].entries()) expect(bbox[index]).toBeCloseTo(value, 6)
  })
})
