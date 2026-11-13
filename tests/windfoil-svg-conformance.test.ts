/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { SVGLoader, type SVGResult } from 'three/addons/loaders/SVGLoader.js'
import { describe, expect, it } from 'vitest'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'
import { viewportTransform } from '../src/windfoil/svg/viewport.js'
import { applyAffine } from '../src/windfoil/svg/curves.js'
import { outlineArea } from './helpers/windfoil-oracle.js'
import { preprocessWindfoilOutlines } from '../src/windfoil/preprocess.js'

describe('SVG interoperability and document conformance', () => {
  for (const file of readdirSync(resolve('tests/fixtures/svg')).filter((file) =>
    file.endsWith('.svg'),
  ))
    it(`converts original corpus ${file} to accepted preprocessing input`, () => {
      const result = svgToWindfoilOutlines(
        readFileSync(resolve('tests/fixtures/svg', file), 'utf8'),
      )
      expect(result.warnings.some((w) => w.code === 'path-data-error')).toBe(false)
      expect(() =>
        preprocessWindfoilOutlines([{ key: file, outline: result.outline }]),
      ).not.toThrow()
      if (file === 'stroked-icon.svg') {
        expect(result.stats.quadratics).toBe(0)
        expect(result.warnings.map((w) => w.code)).toContain('stroke-ignored')
      } else expect(result.stats.quadratics).toBeGreaterThan(0)
      if (file === 'evenodd-star.svg')
        expect(result.warnings.map((w) => w.code)).toContain('evenodd-ambiguous')
      if (file === 'gradient.svg') expect(result.layers[0]!.paint.type).toBe('linear')
    })
  for (const name of ['x', 'github', 'linkedin'])
    it(`matches real SVGLoader geometry and typed SVGResult for ${name}`, () => {
      const text = readFileSync(resolve(`tests/fixtures/svg/social/${name}.svg`), 'utf8')
      const loaderResult: SVGResult = new SVGLoader().parse(text)
      const expected = svgToWindfoilOutlines(text),
        actual = svgToWindfoilOutlines(loaderResult)
      expect(
        Math.abs(
          outlineArea(actual.outline.quadratics) / outlineArea(expected.outline.quadratics) - 1,
        ),
      ).toBeLessThan(0.005)
      for (let axis = 0; axis < 4; axis++)
        expect(Math.abs(actual.outline.bbox[axis]! - expected.outline.bbox[axis]!)).toBeLessThan(5)
    })
  it('maps all nine preserveAspectRatio alignments in meet and slice modes', () => {
    for (const [xName, xAlign] of [
      ['Min', 0],
      ['Mid', 0.5],
      ['Max', 1],
    ] as const)
      for (const [yName, yAlign] of [
        ['Min', 0],
        ['Mid', 0.5],
        ['Max', 1],
      ] as const)
        for (const mode of ['meet', 'slice'])
          for (const [width, height] of [
            [200, 100],
            [100, 200],
          ] as const) {
            const scale = mode === 'meet' ? 10 : 20
            const matrix = viewportTransform(
              [10, 20, 10, 10],
              width,
              height,
              `x${xName}Y${yName} ${mode}`,
            )
            expect(applyAffine(matrix, 10, 20)).toEqual([
              (width - 10 * scale) * xAlign || 0,
              (height - 10 * scale) * yAlign || 0,
            ])
            expect(applyAffine(matrix, 20, 30)).toEqual([
              (width - 10 * scale) * xAlign + 10 * scale,
              (height - 10 * scale) * yAlign + 10 * scale,
            ])
          }
  })
  it('bounds expanded 10×10×10×10 use fanout long before walking it all', () => {
    let definitions = '<path id="p0" d="M0 0H1V1H0Z"/>'
    for (let level = 1; level <= 4; level++)
      definitions += `<g id="p${level}">${`<use href="#p${level - 1}"/>`.repeat(10)}</g>`
    const text = `<svg viewBox="0 0 1 1"><defs>${definitions}</defs><use href="#p4"/></svg>`
    svgToWindfoilOutlines(text, { maxElements: 1 })
    const start = performance.now()
    const result = svgToWindfoilOutlines(text, { maxElements: 20 })
    // About 5 ms when the limit stops the walk, over 700 ms for the full 10,000 elements. The
    // budget sits between, with room for a machine busy with other work.
    expect(performance.now() - start).toBeLessThan(250)
    expect(result.layers).toHaveLength(20)
    expect(result.warnings.some((w) => w.code === 'limit-exceeded')).toBe(true)
    expect(() => svgToWindfoilOutlines(text, { maxElements: 20, unsupported: 'error' })).toThrow(
      'limit-exceeded',
    )
  })
  for (const [shape, area] of [
    ['<rect x="2" y="2" width="6" height="4"/>', 24],
    ['<rect x="2" y="2" width="6" height="4" rx="10" ry="10"/>', Math.PI * 3 * 2],
    ['<rect x="2" y="2" width="6" height="4" rx="1"/>', 24 - (4 - Math.PI)],
    ['<rect x="2" y="2" width="6" height="4" ry="1"/>', 24 - (4 - Math.PI)],
    ['<rect x="2" y="2" width="6" height="4" rx="auto" ry="1"/>', 24 - (4 - Math.PI)],
    ['<circle cx="5" cy="5" r="3"/>', Math.PI * 9],
    ['<ellipse cx="5" cy="5" rx="3" ry="2"/>', Math.PI * 6],
    ['<polygon points="0,0 10,0 5,10"/>', 50],
    ['<polyline points="0,0 10,0 5,10"/>', 50],
  ] as const)
    it(`retains basic-shape area within 0.1%: ${shape}`, () => {
      const result = svgToWindfoilOutlines(`<svg viewBox="0 0 10 10">${shape}</svg>`, {
        em: { unitsPerEm: 10, ascent: 10, descent: 0 },
      })
      expect(Math.abs(outlineArea(result.outline.quadratics) / area - 1)).toBeLessThan(0.001)
    })
  it('matches SVGLoader ellipse curves, rotated arcs and open filled subpaths', () => {
    for (const shape of [
      '<circle cx="5" cy="5" r="4"/>',
      '<ellipse cx="5" cy="5" rx="4" ry="2" transform="rotate(20 5 5)"/>',
      '<path d="M1 5A4 2 30 0 0 9 5L5 8"/>',
      '<path d="M1 5A4 2 30 1 1 9 5L5 8"/>',
    ]) {
      const text = `<svg viewBox="0 0 10 10">${shape}</svg>`
      const expected = svgToWindfoilOutlines(text)
      const actual = svgToWindfoilOutlines(new SVGLoader().parse(text))
      expect(
        Math.abs(
          outlineArea(actual.outline.quadratics) / outlineArea(expected.outline.quadratics) - 1,
        ),
      ).toBeLessThan(0.005)
      for (let axis = 0; axis < 4; axis++)
        expect(Math.abs(actual.outline.bbox[axis]! - expected.outline.bbox[axis]!)).toBeLessThan(5)
    }
  })
  it('reports SVGLoader stroke and unsupported-curve losses while preserving valid curves', () => {
    const result = svgToWindfoilOutlines({
      paths: [
        {
          userData: { style: { stroke: '#000', strokeWidth: 2 } },
          subPaths: [
            {
              curves: [
                { isLineCurve: true, v1: { x: 0, y: 0 }, v2: { x: 10, y: 0 } },
                { isLineCurve: true, v1: { x: 10, y: 0 }, v2: { x: 10, y: 10 } },
                { isLineCurve: true, v1: { x: 10, y: 10 }, v2: { x: 0, y: 10 } },
                { isUnsupportedCurve: true },
              ],
            },
          ],
        },
      ],
    })
    expect(result.stats.quadratics).toBe(4)
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['stroke-ignored', 'unsupported-element']),
    )
    expect(() =>
      svgToWindfoilOutlines(
        { paths: [{ userData: { style: { stroke: 'red' } }, subPaths: [] }] },
        { strokes: 'error' },
      ),
    ).toThrow('stroke-ignored')
  })
  it('reports invalid SVG gradient transforms and radii rather than returning invalid paints', () => {
    for (const attributes of [
      'gradientTransform="garbage(2)"',
      'gradientTransform="scale(0)"',
      'r="-1"',
      'r="bad"',
    ]) {
      const result = svgToWindfoilOutlines(
        `<svg viewBox="0 0 10 10"><defs><radialGradient id="p" ${attributes}><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs><rect width="10" height="10" fill="url(#p)"/></svg>`,
      )
      expect(result.layers[0]!.paint.type).toBe('unsupported')
      expect(result.warnings.map((w) => w.code)).toContain('unsupported-paint')
    }
  })
  it('inherits gradient stops, clamps decreasing offsets and handles empty paint servers', () => {
    const result = svgToWindfoilOutlines(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="base"><stop offset="-1" stop-color="#f00"/><stop offset=".8" stop-color="#0f0" stop-opacity=".5"/><stop offset=".2" stop-color="#00f"/><stop offset="2" stop-color="#fff"/></linearGradient><linearGradient id="p" href="#base" spreadMethod="repeat"/><radialGradient id="empty"/></defs><rect width="10" height="10" fill="url(#p)" fill-opacity=".5"/><rect width="1" height="1" fill="url(#empty)"/></svg>',
    )
    expect(result.layers[0]!.paint).toMatchObject({
      type: 'linear',
      extend: 'repeat',
      stops: [
        { offset: 0, color: [1, 0, 0, 0.5] },
        { offset: 0.8, color: [0, 1, 0, 0.25] },
        { offset: 0.8, color: [0, 0, 1, 0.5] },
        { offset: 1, color: [1, 1, 1, 0.5] },
      ],
    })
    expect(result.layers[1]!.paint).toEqual({ type: 'solid', color: [0, 0, 0, 0] })
  })
})
