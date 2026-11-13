// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { WindfoilBoundingBox, WindfoilQuadratic } from '../src/types.js'
import { ContourBuilder } from '../src/windfoil/svg/curves.js'
import { canonicalizeWinding } from '../src/windfoil/svg/winding.js'
import { integralCoverage, sampledCoverage, sampleContour } from './helpers/windfoil-oracle.js'

function ring(x: number, y: number, width: number, curved = false): WindfoilQuadratic[] {
  const b = new ContourBuilder()
  b.move(x, y)
  if (curved) {
    b.quad(x + width / 2, y - width / 3, x + width, y)
    b.quad(x + (width * 4) / 3, y + width / 2, x + width, y + width)
    b.quad(x + width / 2, y + (width * 4) / 3, x, y + width)
    b.quad(x - width / 3, y + width / 2, x, y)
  } else {
    b.line(x + width, y)
    b.line(x + width, y + width)
    b.line(x, y + width)
  }
  b.close()
  return b.contours[0]!
}
describe('independent SVG winding coverage oracle', () => {
  it('fails for raw same-direction evenodd holes and succeeds after canonicalization', () => {
    const contours = [ring(0, 0, 10), ring(2, 2, 6)]
    const box = [4, 4, 6, 6] as const
    expect(
      integralCoverage(
        contours.map((c) => sampleContour(c, 1)),
        box,
      ),
    ).toBe(1)
    expect(
      sampledCoverage(
        contours.map((c) => sampleContour(c, 1)),
        box,
        'evenodd',
      ),
    ).toBe(0)
    const canonical = canonicalizeWinding(contours, 'evenodd', 0.001)
    expect(
      integralCoverage(
        canonical.contours.map((c) => sampleContour(c, 1)),
        box,
      ),
    ).toBe(0)
  })
  for (const rule of ['nonzero', 'evenodd'] as const)
    for (const mirrored of [false, true])
      it(`matches a 64×64 point grid for ${rule}, mirrored=${mirrored}`, () => {
        const contours = [ring(0, 0, 10, true), ring(2, 2, 6), ring(4, 4, 2)].map((c) =>
          mirrored
            ? c.map(
                (q) => [-q[0] + 10, q[1], -q[2] + 10, q[3], -q[4] + 10, q[5]] as WindfoilQuadratic,
              )
            : c,
        )
        const original = contours.map((c) => sampleContour(c, 64))
        const canonical = canonicalizeWinding(contours, rule, 0.001).contours.map((c) =>
          sampleContour(c, 256),
        )
        const boxes: WindfoilBoundingBox[] = [
          [-2, -2, 12, 12],
          [1, 1, 9, 9],
          [3, 3, 7, 7],
          [-1, 2, 2, 6],
          [4, -1, 6, 1],
        ]
        for (const box of boxes)
          expect(
            Math.abs(integralCoverage(canonical, box) - sampledCoverage(original, box, rule)),
          ).toBeLessThan(0.01)
      })
})
