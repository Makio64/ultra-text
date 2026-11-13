import { describe, expect, it } from 'vitest'

import { encodeSdfFromAlpha } from '../src/atlas/cpuSdf.js'

function at(values: Uint8Array, index: number): number {
  const value = values[index]
  if (value === undefined) throw new RangeError(`Missing test value at index ${index}`)
  return value
}

// Independent reference: compare every pixel with every possible seed instead
// of using separable row/column transforms or a lower envelope.
function bruteForceSdf(
  alpha: Uint8Array,
  width: number,
  height: number,
  range: number,
): Uint8Array {
  const result = new Uint8Array(alpha.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let inside = Math.fround(1e20)
      let outside = Math.fround(1e20)
      for (let sy = 0; sy < height; sy++) {
        for (let sx = 0; sx < width; sx++) {
          const coverage = alpha[sy * width + sx]!
          const offset = 0.5 - coverage / 255
          // The encoder stores seed costs and each axis result as f32.
          const distance = (cost: number): number =>
            Math.fround(Math.fround((x - sx) ** 2 + Math.fround(cost)) + (y - sy) ** 2)
          if (coverage > 0) {
            inside = Math.min(inside, distance(offset > 0 ? offset ** 2 : 0))
          }
          if (coverage < 255) {
            outside = Math.min(outside, distance(offset < 0 ? offset ** 2 : 0))
          }
        }
      }
      const normalized = 0.5 + (Math.sqrt(outside) - Math.sqrt(inside)) * (1 / range)
      result[y * width + x] = Math.round(Math.max(0, Math.min(1, normalized)) * 255)
    }
  }
  return result
}

describe('encodeSdfFromAlpha', () => {
  it('matches weighted Euclidean distances for fractional and binary masks', () => {
    let seed = 7127
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (const [width, height] of [
      [9, 1],
      [1, 9],
      [7, 5],
      [4, 8],
    ] as const) {
      for (const range of [0.25, 2, 12, 1e12]) {
        for (const binary of [false, true]) {
          const alpha = Uint8Array.from({ length: width * height }, () =>
            binary ? (random() < 0.5 ? 0 : 255) : Math.floor(random() * 256),
          )
          expect(encodeSdfFromAlpha(alpha, width, height, range)).toEqual(
            bruteForceSdf(alpha, width, height, range),
          )
        }
      }
    }
  })

  it('chooses the cheaper fractional seed at equal horizontal distances', () => {
    const alpha = new Uint8Array([64, 0, 127])
    expect(encodeSdfFromAlpha(alpha, 3, 1, 4)).toEqual(bruteForceSdf(alpha, 3, 1, 4))
    alpha.reverse()
    expect(encodeSdfFromAlpha(alpha, 3, 1, 4)).toEqual(bruteForceSdf(alpha, 3, 1, 4))
  })

  it('preserves every alpha seed cost along both axes and leaves its input intact', () => {
    const alpha = Uint8Array.from({ length: 256 }, (_, index) => index)
    const original = alpha.slice()
    for (const [width, height] of [
      [256, 1],
      [1, 256],
      [16, 16],
    ] as const) {
      for (const range of [0.25, 4, 12, 1e12]) {
        expect(encodeSdfFromAlpha(alpha, width, height, range)).toEqual(
          bruteForceSdf(alpha, width, height, range),
        )
      }
    }
    expect(alpha).toEqual(original)
  })

  it('handles long empty and solid runs, distant seeds and rectangular grids', () => {
    for (const [width, height] of [
      [73, 3],
      [3, 73],
      [19, 17],
    ] as const) {
      for (const background of [0, 255]) {
        const alpha = new Uint8Array(width * height).fill(background)
        alpha[0] = 255 - background
        alpha[Math.floor(alpha.length / 2)] = 127
        alpha[alpha.length - 1] = 128
        for (const range of [2, 128, 1e12]) {
          expect(encodeSdfFromAlpha(alpha, width, height, range)).toEqual(
            bruteForceSdf(alpha, width, height, range),
          )
        }
      }
    }
  })

  it('preserves finite missing-seed distances even for very large ranges', () => {
    for (const coverage of [0, 255]) {
      const alpha = new Uint8Array(12).fill(coverage)
      expect(encodeSdfFromAlpha(alpha, 4, 3, 1e12)).toEqual(bruteForceSdf(alpha, 4, 3, 1e12))
    }
  })

  it('validates the pixel type, dimensions, length, and distance range', () => {
    expect(() =>
      encodeSdfFromAlpha(new Uint16Array([0]) as unknown as Uint8Array, 1, 1, 1),
    ).toThrow(TypeError)

    expect(() => encodeSdfFromAlpha(new Uint8Array(0), 0, 1, 1)).toThrow(
      /width must be a positive integer/,
    )
    expect(() => encodeSdfFromAlpha(new Uint8Array(1), 1.5, 1, 1)).toThrow(
      /width must be a positive integer/,
    )
    expect(() => encodeSdfFromAlpha(new Uint8Array(0), 1, -1, 1)).toThrow(
      /height must be a positive integer/,
    )
    expect(() => encodeSdfFromAlpha(new Uint8Array(2), 1, 1, 1)).toThrow(
      /does not match width \* height/,
    )
    expect(() => encodeSdfFromAlpha(new Uint8Array(1), 1, 1, 0)).toThrow(
      /pxRange must be a positive finite number/,
    )
    expect(() => encodeSdfFromAlpha(new Uint8Array(1), 1, 1, Number.POSITIVE_INFINITY)).toThrow(
      /pxRange must be a positive finite number/,
    )
  })

  it('encodes the edge around 128 with the correct inside/outside sign', () => {
    const outsideEdge = at(encodeSdfFromAlpha(new Uint8Array([127]), 1, 1, 8), 0)
    const insideEdge = at(encodeSdfFromAlpha(new Uint8Array([128]), 1, 1, 8), 0)

    expect(outsideEdge).toBe(127)
    expect(insideEdge).toBe(128)

    const binaryEdge = encodeSdfFromAlpha(new Uint8Array([0, 255]), 2, 1, 4)
    const outside = at(binaryEdge, 0)
    const inside = at(binaryEdge, 1)

    expect(outside).toBeLessThan(128)
    expect(inside).toBeGreaterThan(127)
    expect(outside + inside).toBe(255)
    expect((outside + inside) / 2).toBe(127.5)
  })

  it('is symmetric across horizontal, vertical, and diagonal reflections', () => {
    const width = 5
    const height = 5
    const alpha = new Uint8Array(width * height)
    alpha[2 * width + 2] = 255

    const sdf = encodeSdfFromAlpha(alpha, width, height, 8)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = at(sdf, y * width + x)
        expect(value).toBe(at(sdf, y * width + (width - 1 - x)))
        expect(value).toBe(at(sdf, (height - 1 - y) * width + x))
        expect(value).toBe(at(sdf, x * width + y))
      }
    }
  })

  it('changes monotonically from far outside through the solid centre', () => {
    const alpha = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0])
    const sdf = encodeSdfFromAlpha(alpha, alpha.length, 1, 8)
    const centre = 5

    for (let index = 1; index <= centre; index++) {
      expect(at(sdf, index)).toBeGreaterThan(at(sdf, index - 1))
    }
    for (let index = centre + 1; index < sdf.length; index++) {
      expect(at(sdf, index)).toBeLessThan(at(sdf, index - 1))
    }
  })

  it('handles one-pixel, one-dimensional, all-solid, and all-empty inputs', () => {
    expect([...encodeSdfFromAlpha(new Uint8Array([0]), 1, 1, 4)]).toEqual([0])
    expect([...encodeSdfFromAlpha(new Uint8Array([255]), 1, 1, 4)]).toEqual([255])

    const horizontal = encodeSdfFromAlpha(new Uint8Array([0, 0, 255, 0, 0]), 5, 1, 8)
    const vertical = encodeSdfFromAlpha(new Uint8Array([0, 0, 255, 0, 0]), 1, 5, 8)
    expect([...vertical]).toEqual([...horizontal])

    expect([...encodeSdfFromAlpha(new Uint8ClampedArray(6).fill(255), 3, 2, 4)]).toEqual(
      new Array<number>(6).fill(255),
    )
    expect([...encodeSdfFromAlpha(new Uint8ClampedArray(6), 3, 2, 4)]).toEqual(
      new Array<number>(6).fill(0),
    )
  })
})
