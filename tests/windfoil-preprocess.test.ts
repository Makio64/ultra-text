import { describe, expect, it } from 'vitest'

import type { FontStyleSnapshot, GlyphRequest } from '../src/types.js'
import { readFlatNumbers } from '../src/windfoil/preprocessCore.js'
import {
  preprocessWindfoilGlyphs,
  splitQuadraticIntoMonotonePieces,
  validateWindfoilGlyphOutline,
  WINDFOIL_ROW_STRIDE,
  type WindfoilBoundingBox,
  type WindfoilGlyphOutline,
  type WindfoilGlyphSource,
} from '../src/windfoil/preprocess.js'

const font = {
  key: 'test-font',
  canvasFont: '16px Test',
  family: 'Test',
  weight: '400',
  style: 'normal',
  stretch: 'normal',
  variant: 'normal',
  kerning: 'auto',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'auto',
  size: 16,
} satisfies FontStyleSnapshot

function line(x0: number, y0: number, x1: number, y1: number): readonly number[] {
  return [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1]
}

function outline(
  quadratics: ArrayLike<number>,
  bbox: WindfoilBoundingBox = [0, 0, 10, 10],
): WindfoilGlyphOutline {
  return {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    bbox,
    quadratics,
  }
}

function source(key: string, glyphOutline: WindfoilGlyphOutline): WindfoilGlyphSource {
  const request: GlyphRequest = { key, character: key.slice(-1), font }
  return { request, outline: glyphOutline }
}

function rectangle(): readonly number[] {
  return [
    ...line(0, 0, 10, 0),
    ...line(10, 0, 10, 10),
    ...line(10, 10, 0, 10),
    ...line(0, 10, 0, 0),
  ]
}

function floatFromBits(bits: number): number {
  const view = new DataView(new ArrayBuffer(4))
  view.setUint32(0, bits, true)
  return view.getFloat32(0, true)
}

describe('Windfoil quadratic preprocessing', () => {
  it('preserves indexed diagnostics and single reads while validating coordinates', () => {
    for (const value of [undefined, NaN, Infinity, '2']) {
      expect(() => readFlatNumbers([0, value], 'outline.quadratics')).toThrow(
        new TypeError('outline.quadratics[1] must be a finite number'),
      )
    }
    expect(() => readFlatNumbers([0, 1e40], 'outline.quadratics')).toThrow(
      new RangeError('outline.quadratics[1] must be representable as a finite float32'),
    )
    let reads = 0
    expect(
      readFlatNumbers(
        {
          length: 1,
          get 0() {
            reads++
            return -0
          },
        },
        'coordinates',
      ),
    ).toEqual([-0])
    expect(reads).toBe(1)
  })

  it('splits at distinct x/y extrema into chained xy-monotone pieces', () => {
    const quadratic = [0, 0, 4, 6, 2, -2] as const
    const pieces = splitQuadraticIntoMonotonePieces(quadratic)

    expect(pieces).toHaveLength(3)
    expect(pieces[0]?.slice(0, 2)).toEqual(quadratic.slice(0, 2))
    expect(pieces.at(-1)?.slice(4, 6)).toEqual(quadratic.slice(4, 6))
    for (let index = 1; index < pieces.length; index++) {
      expect(pieces[index - 1]?.slice(4, 6)).toEqual(pieces[index]?.slice(0, 2))
    }
    for (const piece of pieces) {
      expect(piece[2]).toBeGreaterThanOrEqual(Math.min(piece[0], piece[4]))
      expect(piece[2]).toBeLessThanOrEqual(Math.max(piece[0], piece[4]))
      expect(piece[3]).toBeGreaterThanOrEqual(Math.min(piece[1], piece[5]))
      expect(piece[3]).toBeLessThanOrEqual(Math.max(piece[1], piece[5]))
    }

    // Coincident extrema are one split, not a zero-length third piece.
    expect(splitQuadraticIntoMonotonePieces([0, 0, 2, 2, 0, 0])).toHaveLength(2)
  })

  it.each([
    [0, 0, 2, 4, 4, 8],
    [4, 8, 2, 4, 0, 0],
    [0, 0, 0, 4, 4, 4],
    [-0, -0, -0, -0, -0, -0],
  ])('keeps an already monotone segment unchanged (%j)', (...quadratic) => {
    expect(splitQuadraticIntoMonotonePieces(quadratic)).toEqual([quadratic])
    const prepared = preprocessWindfoilGlyphs([source('font:Q', outline(quadratic))])
    expect(prepared.stats.monotonePieces).toBe(1)
    // Nonhorizontal segments are stored in both traversal orders without changing
    // their control points. Horizontal segments retain their density/bounds only.
    if (quadratic[1] !== quadratic[3] || quadratic[1] !== quadratic[5]) {
      expect([...prepared.curves]).toEqual([...quadratic, ...quadratic])
    } else expect(prepared.curves).toHaveLength(0)
  })

  it('preserves each original quadratic when splitting seeded extrema in either order', () => {
    let seed = 904715
    const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 20 - 10
    for (let sample = 0; sample < 128; sample++) {
      const original = Array.from({ length: 6 }, random)
      const cuts = [0, 1]
      for (let axis = 0; axis < 2; axis++) {
        const t =
          (original[axis]! - original[axis + 2]!) /
          (original[axis]! - 2 * original[axis + 2]! + original[axis + 4]!)
        if (t > 0 && t < 1 && !cuts.includes(t)) cuts.push(t)
      }
      cuts.sort((a, b) => a - b)
      const pieces = splitQuadraticIntoMonotonePieces(original)
      expect(pieces).toHaveLength(cuts.length - 1)
      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index]!
        for (let axis = 0; axis < 2; axis++) {
          expect(piece[axis + 2]!).toBeGreaterThanOrEqual(
            Math.min(piece[axis]!, piece[axis + 4]!) - 1e-12,
          )
          expect(piece[axis + 2]!).toBeLessThanOrEqual(
            Math.max(piece[axis]!, piece[axis + 4]!) + 1e-12,
          )
          for (const u of [0, 0.25, 0.5, 0.75, 1]) {
            const t = cuts[index]! + (cuts[index + 1]! - cuts[index]!) * u
            const reconstructed =
              (1 - u) ** 2 * piece[axis]! +
              2 * (1 - u) * u * piece[axis + 2]! +
              u ** 2 * piece[axis + 4]!
            const expected =
              (1 - t) ** 2 * original[axis]! +
              2 * (1 - t) * t * original[axis + 2]! +
              t ** 2 * original[axis + 4]!
            expect(reconstructed).toBeCloseTo(expected, 11)
          }
        }
      }
    }
  })

  it('shares duplicate request keys and produces stable storage independent of request order', () => {
    const glyphA = outline(rectangle())
    const glyphAClone = outline([...rectangle()])
    const glyphB = outline(
      [...line(0, 10, 5, 0), ...line(5, 0, 10, 10), ...line(10, 10, 0, 10)],
      [0, 0, 10, 10],
    )

    const first = preprocessWindfoilGlyphs([
      source('font:B', glyphB),
      source('font:A', glyphA),
      source('font:A', glyphAClone),
    ])
    const second = preprocessWindfoilGlyphs([
      source('font:A', glyphAClone),
      source('font:B', glyphB),
      source('font:B', outline(Array.from(glyphB.quadratics))),
    ])

    expect(first.stats.uniqueGlyphs).toBe(2)
    expect([...first.glyphs.keys()]).toEqual(['font:A', 'font:B'])
    expect([...first.curves]).toEqual([...second.curves])
    expect([...first.rows]).toEqual([...second.rows])
    expect([...first.glyphs.entries()]).toEqual([...second.glyphs.entries()])
  })

  it('files pieces into row bands and stores a minification density profile', () => {
    const result = preprocessWindfoilGlyphs([source('font:R', outline(rectangle()))], {
      targetPiecesPerBand: 1,
    })
    const header = result.glyphs.get('font:R')

    expect(header).toMatchObject({
      rowBase: 0,
      bandCount: 4,
      bandH: 2.5,
      invH: Math.fround(0.4),
      monotonePieceCount: 4,
    })
    expect(result.rows).toHaveLength(4 * WINDFOIL_ROW_STRIDE)
    expect(result.stats.bandedPieces).toBe(8)
    expect(result.stats.duplication).toBe(2)
    // Each band keeps its two pieces in both traversal orders.
    expect(result.curves).toHaveLength(2 * 8 * 6)

    for (let row = 0; row < 4; row++) {
      const offset = row * WINDFOIL_ROW_STRIDE
      expect(result.rows[offset + 1]).toBe(2)
      expect(floatFromBits(result.rows[offset + 2]!)).toBeCloseTo(1)
      expect(floatFromBits(result.rows[offset + 3]!)).toBe(0)
      expect(floatFromBits(result.rows[offset + 4]!)).toBe(10)
    }
  })

  it('stores each band by descending x-maximum, then ascending x-minimum, with a balanced split', () => {
    const quadratics = [4, 0, 8, 2, 6].flatMap((x) => line(x, 0, x, 10))
    const result = preprocessWindfoilGlyphs([
      source('font:bars', outline(quadratics, [0, 0, 8, 10])),
    ])

    expect(result.rows[1]).toBe(5)
    expect([0, 1, 2, 3, 4].map((index) => result.curves[index * 6])).toEqual([8, 6, 4, 2, 0])
    expect([5, 6, 7, 8, 9].map((index) => result.curves[index * 6])).toEqual([0, 2, 4, 6, 8])
    expect(floatFromBits(result.rows[2]!)).toBeCloseTo(2.5)
    // Left of x = 4, fewer bars start before a pixel than end after it.
    expect(floatFromBits(result.rows[5]!)).toBe(4)

    // Short bands are sorted too: both walks stop at the first far-side piece.
    const short = preprocessWindfoilGlyphs([
      source('font:pair', outline([...line(2, 0, 2, 10), ...line(6, 10, 6, 0)], [2, 0, 6, 10])),
    ])
    expect([0, 1, 2, 3].map((index) => short.curves[index * 6])).toEqual([6, 2, 2, 6])
    expect(floatFromBits(short.rows[5]!)).toBe(4)
  })

  it('keeps equal-bound traversal ties stable and excludes horizontal pieces from the split', () => {
    const first = line(4, 0, 4, 10),
      second = line(4, 10, 4, 0),
      left = line(0, 0, 0, 10),
      right = line(8, 10, 8, 0)
    const result = preprocessWindfoilGlyphs([
      source(
        'font:ties',
        outline([...first, ...second, ...line(-10, 5, 20, 5), ...left, ...right]),
      ),
    ])
    expect([...result.curves]).toEqual([
      ...right,
      ...first,
      ...second,
      ...left,
      ...left,
      ...first,
      ...second,
      ...right,
    ])
    expect(result.rows[1]).toBe(4)
    expect(floatFromBits(result.rows[5]!)).toBe(4)
    // Horizontal pieces still widen the density profile's bounds, even though
    // they contribute no winding integral and are omitted from both walks.
    expect(floatFromBits(result.rows[3]!)).toBe(-10)
    expect(floatFromBits(result.rows[4]!)).toBe(20)
    expect(floatFromBits(result.rows[2]!)).toBeCloseTo(-8 / 30)
  })

  it('lets a fragment walk either order of a band and integrate the same coverage', () => {
    // Two oppositely wound curved contours: an O with a counter, filed into
    // several bands so pieces are sliced by row windows.
    const letterO = outline(
      [
        [500, 700, 900, 700, 900, 300],
        [900, 300, 900, -100, 500, -100],
        [500, -100, 100, -100, 100, 300],
        [100, 300, 100, 700, 500, 700],
        [500, 500, 300, 500, 300, 300],
        [300, 300, 300, 100, 500, 100],
        [500, 100, 700, 100, 700, 300],
        [700, 300, 700, 500, 500, 500],
      ].flat(),
      [100, -100, 900, 700],
    )
    const result = preprocessWindfoilGlyphs([source('font:O', letterO)], {
      targetPiecesPerBand: 3,
    })
    const header = result.glyphs.get('font:O')!
    expect(header.bandCount).toBeGreaterThan(1)

    const clamp = (value: number, low: number, high: number): number =>
      Math.min(Math.max(value, low), high)
    // Area between one piece and the pixel's left edge inside a row window, by
    // dense sampling: the quantity the shader evaluates in closed form.
    const leftEdgeArea = (
      index: number,
      centerX: number,
      halfX: number,
      low: number,
      high: number,
    ): number => {
      const [x0, y0, cx, cy, x1, y1] = result.curves.subarray(index * 6, index * 6 + 6)
      let area = 0
      let previousX = x0!
      let previousY = y0!
      for (let step = 1; step <= 2048; step++) {
        const t = step / 2048
        const u = 1 - t
        const x = u * u * x0! + 2 * u * t * cx! + t * t * x1!
        const y = u * u * y0! + 2 * u * t * cy! + t * t * y1!
        const middle = clamp((previousX + x) / 2 - centerX, -halfX, halfX)
        area += (middle + halfX) * (clamp(y, low, high) - clamp(previousY, low, high))
        previousX = x
        previousY = y
      }
      return area
    }
    const walk = (
      row: number,
      centerX: number,
      halfX: number,
      low: number,
      high: number,
      leftward: boolean,
    ): { integral: number; visited: number } => {
      const start = result.rows[row * WINDFOIL_ROW_STRIDE]!
      const count = result.rows[row * WINDFOIL_ROW_STRIDE + 1]!
      let integral = 0
      let visited = 0
      for (let offset = 0; offset < count; offset++) {
        const index = start + (leftward ? count : 0) + offset
        const x0 = result.curves[index * 6]! - centerX
        const x1 = result.curves[index * 6 + 4]! - centerX
        // The shader's far-side stop: wholly left of the pixel for the
        // descending-xMax walk, wholly right of it for the ascending-xMin walk.
        if ((leftward ? -Math.min(x0, x1) : Math.max(x0, x1)) <= -halfX) break
        visited++
        const rise =
          clamp(result.curves[index * 6 + 5]!, low, high) -
          clamp(result.curves[index * 6 + 1]!, low, high)
        integral +=
          leftEdgeArea(index, centerX, halfX, low, high) - (leftward ? 2 * halfX * rise : 0)
      }
      return { integral, visited }
    }

    let comparisons = 0
    let splitVisits = 0
    let descendingOnlyVisits = 0
    for (let band = 0; band < header.bandCount; band++) {
      const row = header.rowBase + band
      const bandLow = header.bbox[1] + band * header.bandH
      const split = floatFromBits(result.rows[row * WINDFOIL_ROW_STRIDE + 5]!)
      expect(split).toBeGreaterThanOrEqual(header.bbox[0])
      expect(split).toBeLessThanOrEqual(header.bbox[2])
      for (const [lowFraction, highFraction] of [
        [0, 1],
        [0.2, 0.45],
        [0.6, 0.95],
      ] as const) {
        const low = bandLow + lowFraction * header.bandH
        const high = bandLow + highFraction * header.bandH
        for (let centerX = 60; centerX <= 940; centerX += 40) {
          for (const halfX of [3, 25, 90]) {
            const rightward = walk(row, centerX, halfX, low, high, false)
            const leftward = walk(row, centerX, halfX, low, high, true)
            expect(leftward.integral).toBeCloseTo(rightward.integral, 6)
            splitVisits += centerX < split ? leftward.visited : rightward.visited
            descendingOnlyVisits += rightward.visited
            comparisons++
          }
        }
      }
    }
    expect(comparisons).toBeGreaterThan(100)
    // Choosing the walk by the split visits fewer pieces than one fixed order.
    expect(splitVisits).toBeLessThan(descendingOnlyVisits * 0.8)
  })

  it('validates outlines, rejects conflicting sharing, and honors aborts', () => {
    expect(() => validateWindfoilGlyphOutline(outline(rectangle()))).not.toThrow()
    expect(() =>
      validateWindfoilGlyphOutline({ ...outline(rectangle()), quadratics: [0, 1] }),
    ).toThrow(/multiple of 6/)
    expect(() =>
      validateWindfoilGlyphOutline({ ...outline(rectangle()), quadratics: [0, 0, 0, 0, 0, NaN] }),
    ).toThrow(/finite number/)
    expect(() =>
      validateWindfoilGlyphOutline({ ...outline(rectangle()), bbox: [10, 0, 0, 10] }),
    ).toThrow(/minima/)
    expect(() => validateWindfoilGlyphOutline({ ...outline(rectangle()), unitsPerEm: 0 })).toThrow(
      /positive/,
    )
    expect(() =>
      preprocessWindfoilGlyphs([source('font:A', outline(rectangle()))], {
        targetPiecesPerBand: 0,
      }),
    ).toThrow(/positive integer/)
    expect(() =>
      preprocessWindfoilGlyphs([
        source('font:A', outline(rectangle())),
        source('font:A', outline(line(0, 0, 1, 1), [0, 0, 1, 1])),
      ]),
    ).toThrow(/conflicting outlines/)

    const controller = new AbortController()
    const reason = new DOMException('stop preprocessing', 'AbortError')
    controller.abort(reason)
    expect(() =>
      preprocessWindfoilGlyphs([source('font:A', outline(rectangle()))], {
        signal: controller.signal,
      }),
    ).toThrow(reason)
  })
})
