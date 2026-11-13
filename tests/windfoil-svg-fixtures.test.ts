/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'
import { validateWindfoilGlyphOutline } from '../src/windfoil/preprocess.js'
import type { WindfoilGlyphOutline, WindfoilOutlineLayer } from '../src/types.js'

function curvedSegments(outline: WindfoilGlyphOutline): number {
  const points = outline.quadratics,
    minimumBend = (outline.ascent - outline.descent) / 1000
  let count = 0
  for (let offset = 0; offset < points.length; offset += 6) {
    const dx = points[offset + 4]! - points[offset]!,
      dy = points[offset + 5]! - points[offset + 1]!,
      chordLength = Math.hypot(dx, dy)
    if (chordLength === 0) continue
    // A quadratic's midpoint lies half as far from its chord as its control point.
    // Promoted lines therefore do not count as curves, regardless of SVG commands.
    const midpointBend =
      Math.abs(
        dx * (points[offset + 3]! - points[offset + 1]!) -
          dy * (points[offset + 2]! - points[offset]!),
      ) /
      (2 * chordLength)
    if (midpointBend >= minimumBend) count++
  }
  return count
}

describe('animal SVG artwork', () => {
  for (const [name, paintCount] of [
    ['wolf', 53],
    ['owl', 57],
    ['bear', 57],
  ] as const)
    it(`keeps ${name}'s paints valid and shows curves throughout the portrait`, () => {
      const result = svgToWindfoilOutlines(
        readFileSync(resolve(`tests/fixtures/svg/animals/${name}.svg`), 'utf8'),
        { unsupported: 'error', strokes: 'error', checkOverlaps: false },
      )
      expect(result.warnings).toEqual([])
      expect(result.layers).toHaveLength(paintCount)
      expect(result.stats.droppedContours).toBe(0)
      const layers: WindfoilOutlineLayer[] = result.layers.flatMap((layer) =>
        layer.paint.type === 'unsupported' ? [] : [{ ...layer.outline, paint: layer.paint }],
      )
      expect(layers).toHaveLength(paintCount)
      for (const layer of result.layers)
        expect(() => validateWindfoilGlyphOutline(layer.outline)).not.toThrow()
      expect(() =>
        validateWindfoilGlyphOutline({ ...result.outline, quadratics: [], layers }),
      ).not.toThrow()

      const curved = result.layers.map((layer) => curvedSegments(layer.outline))
      // Curvature must cover the portrait rather than only its circular eyes or ears.
      expect(curved.filter((count) => count > 0).length).toBeGreaterThanOrEqual(
        Math.ceil(paintCount / 2),
      )
      expect(curved.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(paintCount)
    })
})

describe('licensed SVG corpus', () => {
  for (const name of ['x', 'github', 'linkedin'])
    it(`converts ${name} in place without grammar or paint errors`, () => {
      const result = svgToWindfoilOutlines(
        readFileSync(resolve(`tests/fixtures/svg/social/${name}.svg`), 'utf8'),
      )
      expect(result.stats.quadratics).toBeGreaterThan(0)
      expect(
        result.warnings.filter((w) => ['path-data-error', 'unsupported-paint'].includes(w.code)),
      ).toEqual([])
      expect(() => validateWindfoilGlyphOutline(result.outline)).not.toThrow()
    })
  for (const file of readdirSync(resolve('tests/fixtures/emoji')).filter((file) =>
    file.endsWith('.svg'),
  ))
    it(`converts ${file} into valid color layers`, () => {
      const result = svgToWindfoilOutlines(
        readFileSync(resolve('tests/fixtures/emoji', file), 'utf8'),
      )
      expect(result.layers.length).toBeGreaterThan(0)
      expect(result.layers.some((layer) => layer.paint.type === 'unsupported')).toBe(false)
      const layers: WindfoilOutlineLayer[] = result.layers.flatMap((layer) =>
        layer.paint.type === 'unsupported'
          ? []
          : [
              {
                quadratics: layer.outline.quadratics,
                bbox: layer.outline.bbox,
                paint: layer.paint,
              },
            ],
      )
      expect(() =>
        validateWindfoilGlyphOutline({ ...result.outline, quadratics: [], layers }),
      ).not.toThrow()
    })
})
