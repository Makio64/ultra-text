import { describe, expect, it, vi } from 'vitest'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'
import { parseTransform, viewportTransform } from '../src/windfoil/svg/document.js'
import { colorPaint } from '../src/windfoil/svg/paint.js'
import { validateWindfoilGlyphOutline } from '../src/windfoil/preprocess.js'
import type { WindfoilQuadratic } from '../src/types.js'
import { windingAt, flattenContour } from '../src/windfoil/svg/winding.js'
const rect = 'M0 0H10V10H0Z'
const svg = (body: string, attributes = 'viewBox="0 0 10 10"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`
const codes = (result: ReturnType<typeof svgToWindfoilOutlines>): string[] =>
  result.warnings.map((w) => w.code)

describe('SVG to Windfoil outlines', () => {
  it('maps to explicit font metrics, float32-exact quadratics and a tight bbox', () => {
    const result = svgToWindfoilOutlines(
      { d: rect },
      {
        viewBox: [0, 0, 10, 10],
        em: { unitsPerEm: 1000, ascent: 800, descent: -200, advance: 1000 },
      },
    )
    expect(result.outline.bbox).toEqual([0, -200, 1000, 800])
    expect(result.advance).toBe(1000)
    expect(result.outline.quadratics).toBeInstanceOf(Float32Array)
    expect(() => validateWindfoilGlyphOutline(result.outline)).not.toThrow()
    expect(result.stats.quadratics).toBe(4)
    expect(result.stats.contours).toBe(1)
    expect(result.layers[0]!.paint).toEqual({ type: 'solid', color: [0, 0, 0, 1] })
  })
  it('fills evenodd holes and canonicalizes nonzero rings per element', () => {
    const d = rect + 'M2 2H8V8H2Z'
    expect(svgToWindfoilOutlines({ d, fillRule: 'evenodd' }).stats.contours).toBe(2)
    expect(svgToWindfoilOutlines({ d }).stats.contours).toBe(1)
    const mirrored = svgToWindfoilOutlines([
      { d: rect },
      { d: rect, transform: [-1, 0, 0, 1, 20, 0] },
    ])
    expect(mirrored.stats.contours).toBe(2)
    const q = Array.from(mirrored.outline.quadratics),
      quads: WindfoilQuadratic[] = []
    for (let i = 0; i < q.length; i += 6)
      quads.push(q.slice(i, i + 6) as unknown as WindfoilQuadratic)
    expect(windingAt(flattenContour(quads.slice(0, 4), 0.1), [500, 500])).toBe(1)
    expect(windingAt(flattenContour(quads.slice(4), 0.1), [1500, 500])).toBe(1)
  })
  it('warns for ambiguous intersections and can enforce strict conversion', () => {
    const source = { d: 'M0 0L10 10L0 10L10 0Z', fillRule: 'evenodd' as const }
    expect(codes(svgToWindfoilOutlines(source))).toContain('evenodd-ambiguous')
    expect(() => svgToWindfoilOutlines(source, { unsupported: 'error' })).toThrow(
      'evenodd-ambiguous',
    )
    expect(codes(svgToWindfoilOutlines({ ...source, fillRule: 'nonzero' }))).toContain(
      'self-intersection',
    )
    expect(codes(svgToWindfoilOutlines(source, { checkOverlaps: false }))).not.toContain(
      'evenodd-ambiguous',
    )
  })
  it('parses cubics, quadratics, smooth curves and arc circles', () => {
    const result = svgToWindfoilOutlines({
      d: 'M10 0A10 10 0 1 1-10 0A10 10 0 1 1 10 0ZM0 0C1 3 4 3 5 0S9-3 10 0Q4 2 0 0T-10 0Z',
    })
    expect(result.stats.arcs).toBe(2)
    expect(result.stats.cubics).toBe(2)
    expect(result.stats.quadratics).toBeGreaterThan(10)
  })
  it('keeps valid path prefixes and rejects malformed XML', () => {
    const warning = vi.fn(),
      result = svgToWindfoilOutlines({ d: rect + 'L1e 3' }, { onWarning: warning })
    expect(codes(result)).toContain('path-data-error')
    expect(result.stats.quadratics).toBe(4)
    expect(warning).toHaveBeenCalled()
    expect(() => svgToWindfoilOutlines('<svg><path></svg>')).toThrow('Malformed SVG')
    expect(() => svgToWindfoilOutlines({ d: rect }, { viewBox: [0, 0, 0, 1] })).toThrow(RangeError)
    expect(() => svgToWindfoilOutlines({ d: rect }, { tolerance: 0 })).toThrow(RangeError)
    expect(() => svgToWindfoilOutlines({ d: rect }, { maxElements: 0 })).toThrow(RangeError)
  })
  it('returns empty outlines and diagnoses transforms, overlap and clipping', () => {
    expect(codes(svgToWindfoilOutlines({ d: '' }))).toContain('empty')
    expect(codes(svgToWindfoilOutlines({ d: rect, transform: [0, 0, 0, 0, 0, 0] }))).toContain(
      'degenerate-transform',
    )
    expect(codes(svgToWindfoilOutlines([{ d: rect }, { d: rect }]))).toContain('overlap')
    expect(codes(svgToWindfoilOutlines({ d: rect }, { viewBox: [1, 1, 2, 2] }))).toContain(
      'viewport-overflow',
    )
    expect(() => svgToWindfoilOutlines({ d: rect, transform: [1, 0, 0, 1, Infinity, 0] })).toThrow(
      TypeError,
    )
  })
  it('maps preserveAspectRatio meet, slice and none correctly', () => {
    expect(viewportTransform([0, 0, 10, 10], 200, 100, 'xMaxYMin meet')).toEqual([
      10, 0, 0, 10, 100, 0,
    ])
    expect(viewportTransform([0, 0, 10, 10], 200, 100, 'xMinYMax slice')).toEqual([
      20, 0, 0, 20, 0, -100,
    ])
    expect(viewportTransform([0, 0, 10, 10], 200, 100, 'none')).toEqual([20, 0, 0, 10, 0, 0])
    expect(() => viewportTransform([0, 0, 10, 10], 100, 100, 'bad')).toThrow()
  })
  it('parses complete affine transform lists', () => {
    expect(parseTransform('translate(10,20) scale(2) rotate(90 1 1)')).toEqual([
      expect.closeTo(0),
      2,
      -2,
      expect.closeTo(0),
      14,
      20,
    ])
    expect(parseTransform('matrix(1 0 0 1 2 3) skewX(45) skewY(45)')).toEqual([
      expect.closeTo(2),
      expect.closeTo(1),
      expect.closeTo(1),
      1,
      2,
      3,
    ])
    expect(() => parseTransform('foo(3)')).toThrow()
    expect(() => parseTransform('scale(1)junk')).toThrow()
    expect(() => parseTransform('matrix(1 2)')).toThrow()
  })
})
describe('SVG document structure and paints', () => {
  it('converts basic shapes with inline, inherited and presentation styles', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<g fill="#f00" opacity=".5"><rect width="4" height="4" rx="1"/><circle cx="7" cy="2" r="2" fill="currentColor"/><ellipse cx="2" cy="7" rx="2" ry="1"/><polygon points="5 5 9 5 9 9" style="fill: #00f"/><polyline points="5 6 8 6 8 8"/></g>',
      ),
    )
    expect(result.layers).toHaveLength(5)
    expect(result.layers[0]!.paint).toEqual({ type: 'solid', color: [1, 0, 0, 0.5] })
    expect(result.layers[1]!.paint).toEqual({ type: 'foreground', alpha: 0.5 })
    expect(result.layers[3]!.paint).toEqual({ type: 'solid', color: [0, 0, 1, 0.5] })
  })
  it('preserves visibility overrides and drops display none or transparent shapes', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<g visibility="hidden"><path visibility="visible" d="' +
          rect +
          '"/></g><g display="none"><path d="' +
          rect +
          '"/></g><path opacity="0" d="' +
          rect +
          '"/><path fill="none" d="' +
          rect +
          '"/><path fill-opacity="0" d="' +
          rect +
          '"/>',
      ),
    )
    expect(result.layers).toHaveLength(1)
  })
  it('warns when container opacity needs isolated multi-paint compositing', () => {
    const source = svg(
      '<g opacity=".5"><rect width="8" height="8"/><rect width="4" height="4"/></g>',
    )
    expect(codes(svgToWindfoilOutlines(source))).toContain('unsupported-element')
    expect(() => svgToWindfoilOutlines(source, { unsupported: 'error' })).toThrow(
      'isolated compositing',
    )
    expect(
      codes(svgToWindfoilOutlines(svg('<g opacity=".5"><rect width="4" height="4"/></g>'))),
    ).not.toContain('unsupported-element')
  })
  it('expands repeated symbols with viewports and prevents cycles and fanout', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<defs><symbol id="s" viewBox="0 0 10 10"><path d="' +
          rect +
          '"/></symbol></defs><use href="#s" width="5" height="5"/><use href="#s" x="5" y="5" width="5" height="5"/>',
      ),
    )
    expect(result.layers).toHaveLength(2)
    expect(result.layers[0]!.outline.bbox).toEqual([0, 500, 500, 1000])
    expect(result.layers[1]!.outline.bbox).toEqual([500, 0, 1000, 500])
    expect(codes(svgToWindfoilOutlines(svg('<use id="a" href="#a"/>')))).toContain(
      'external-reference',
    )
    expect(
      codes(svgToWindfoilOutlines(svg('<use href="https://example.com/icon.svg#s"/>'))),
    ).toContain('external-reference')
    expect(
      codes(
        svgToWindfoilOutlines(
          svg('<defs><path id="p" d="' + rect + '"/></defs><use href="#p"/><use href="#p"/>'),
          { maxElements: 1 },
        ),
      ),
    ).toContain('limit-exceeded')
    expect(
      codes(svgToWindfoilOutlines([{ d: rect }, { d: rect }], { maxPathData: rect.length })),
    ).toContain('limit-exceeded')
  })
  it('maps nested svg and chooses the first switch child', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<svg x="5" y="5" width="5" height="5" viewBox="0 0 10 10"><path d="' +
          rect +
          '"/></svg><switch><rect width="1" height="1"/><rect width="2" height="2"/></switch>',
      ),
    )
    expect(result.layers).toHaveLength(2)
    expect(result.layers[0]!.outline.bbox).toEqual([500, 0, 1000, 500])
  })
  it('renders symbols only as the direct target of a use', () => {
    const source = svg(
      '<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol>' +
        '<g id="group"><symbol viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></g>' +
        '<use href="#group"/><use href="#s"/>',
    )
    expect(svgToWindfoilOutlines(source).layers).toHaveLength(1)
  })
  it('copies ellipse auto radii in either direction and skips two auto radii', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<ellipse cx="5" cy="5" ry="2"/><ellipse cx="5" cy="5" rx="2"/>' +
          '<ellipse cx="5" cy="5" rx="auto" ry="2"/>' +
          '<ellipse cx="5" cy="5" rx="2" ry="auto"/>' +
          '<ellipse rx="auto" ry="auto"/><ellipse/><ellipse rx="0" ry="2"/>',
      ),
    )
    expect(result.layers).toHaveLength(4)
    for (const layer of result.layers) {
      const bounds = layer.outline.bbox
      expect(bounds[0]).toBeCloseTo(300, 1)
      expect(bounds[1]).toBeCloseTo(300, 1)
      expect(bounds[2]).toBeCloseTo(700, 1)
      expect(bounds[3]).toBeCloseTo(700, 1)
    }
    expect(codes(result)).not.toContain('path-data-error')
  })
  it('warns for nested viewport overflow in its own frame, including symbols', () => {
    const crossing = svg(
      '<svg x="2" y="2" width="2" height="2" viewBox="0 0 2 2"><rect width="5" height="5"/></svg>',
    )
    expect(codes(svgToWindfoilOutlines(crossing))).toContain('viewport-overflow')
    expect(() => svgToWindfoilOutlines(crossing, { unsupported: 'error' })).toThrow(
      'viewport-overflow',
    )
    expect(
      codes(
        svgToWindfoilOutlines(
          svg(
            '<defs><symbol id="s" viewBox="0 0 2 2"><rect width="5" height="5"/></symbol></defs><use href="#s" width="2" height="2"/>',
          ),
        ),
      ),
    ).toContain('viewport-overflow')
    // meet exposes letterbox space beyond the viewBox; ancestor rotation must
    // not turn that rectangular viewport into a smaller axis-aligned box.
    const contained = svg(
      '<g transform="translate(5 1) rotate(20)"><svg width="4" height="2" viewBox="0 0 2 2"><rect x="-1" width="4" height="2"/></svg></g>',
    )
    expect(codes(svgToWindfoilOutlines(contained))).not.toContain('viewport-overflow')
  })
  it('reports unsupported features without rendering ignored resources', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<style>.x{fill:red}</style><path d="' +
          rect +
          '" fill="url(#p)" stroke="black" clip-path="url(#clip)" mask="url(#m)" filter="url(#f)"/><text>Hi</text><line stroke="black"/><rect width="1em" height="2"/><rect width="-1" height="1"/>',
      ),
    )
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'stylesheet-ignored',
        'stroke-ignored',
        'clip-path-ignored',
        'mask-ignored',
        'filter-ignored',
        'unsupported-element',
        'unsupported-unit',
        'unsupported-paint',
      ]),
    )
    expect(result.layers).toHaveLength(1)
    expect(() =>
      svgToWindfoilOutlines(svg('<path d="' + rect + '" stroke="black"/>'), { strokes: 'error' }),
    ).toThrow()
  })
  it('supports percentages, root dimensions, non-svg roots and large viewBox offsets', () => {
    expect(
      svgToWindfoilOutlines(svg('<rect width="50%" height="50%"/>', 'width="20px" height="10px"'))
        .outline.bbox,
    ).toEqual([0, 500, 1000, 1000])
    expect(
      svgToWindfoilOutlines(
        svg('<path d="M10000 10000h10v10h-10Z"/>', 'viewBox="10000 10000 10 10"'),
      ).outline.bbox,
    ).toEqual([0, 0, 1000, 1000])
    const element = new DOMParser()
      .parseFromString(svg('<path d="' + rect + '"/>'), 'image/svg+xml')
      .querySelector('path')!
    expect(svgToWindfoilOutlines(element).stats.quadratics).toBe(4)
  })
  it('parses fallback CSS colors and foreground alpha', () => {
    expect(colorPaint('#f008', 0.5)).toEqual({ type: 'solid', color: [1, 0, 0, (136 / 255) * 0.5] })
    expect(colorPaint('rgb(100% 0% 0% / 50%)')).toEqual({ type: 'solid', color: [1, 0, 0, 0.5] })
    expect(colorPaint('rgba(255, 0, 128, 0.25)')).toEqual({
      type: 'solid',
      color: [1, 0, 128 / 255, 0.25],
    })
    expect(colorPaint('white')).toEqual({ type: 'solid', color: [1, 1, 1, 1] })
    expect(colorPaint('transparent')).toEqual({ type: 'solid', color: [0, 0, 0, 0] })
    expect(colorPaint('currentColor', 0.3)).toEqual({ type: 'foreground', alpha: 0.3 })
    expect(colorPaint('definitely-not-a-color')).toEqual({
      type: 'unsupported',
      value: 'definitely-not-a-color',
    })
  })
  it('converts inherited SVG gradient paints and their output transforms', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="100%" stop-color="#00f"/></linearGradient><linearGradient id="g2" href="#g" x2="50%" spreadMethod="reflect"/><radialGradient id="r"><stop stop-color="#fff"/></radialGradient></defs><path d="' +
          rect +
          '" fill="url(#g2)"/><circle cx="5" cy="5" r="4" fill="url(#r)"/>',
      ),
    )
    expect(result.layers[0]!.paint).toMatchObject({
      type: 'linear',
      p1: [0.5, 0],
      extend: 'reflect',
      transform: [1000, 0, 0, -1000, 0, 1000],
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    })
    expect(result.layers[1]!.paint.type).toBe('radial')
  })
  it('normalizes SVG radial percentages and clamps an outside focal point', () => {
    const result = svgToWindfoilOutlines(
      svg(
        '<defs><radialGradient id="r" gradientUnits="userSpaceOnUse" fx="100" fy="5"><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient><radialGradient id="zero" href="#r" r="0"/></defs><rect width="20" height="10" fill="url(#r)"/><rect width="20" height="10" fill="url(#zero)"/>',
        'viewBox="0 0 20 10"',
      ),
    )
    const radius = Math.hypot(20, 10) / Math.SQRT2 / 2
    expect(result.layers[0]!.paint).toMatchObject({
      type: 'radial',
      c0: [10 + radius, 5],
      r0: 0,
      c1: [10, 5],
      r1: radius,
    })
    expect(result.layers[1]!.paint).toEqual({ type: 'solid', color: [0, 0, 0, 1] })
  })
  it('accepts structural SVGLoader curves and diagnoses nested viewport loss', () => {
    const xml = new DOMParser().parseFromString(svg('<svg/>'), 'image/svg+xml')
    const source = {
      xml,
      paths: [
        {
          userData: { style: { fill: '#fff' } },
          subPaths: [
            {
              curves: [
                { isLineCurve: true, v1: { x: 0, y: 0 }, v2: { x: 10, y: 0 } },
                {
                  isQuadraticBezierCurve: true,
                  v0: { x: 10, y: 0 },
                  v1: { x: 10, y: 5 },
                  v2: { x: 10, y: 10 },
                },
                {
                  isCubicBezierCurve: true,
                  v0: { x: 10, y: 10 },
                  v1: { x: 5, y: 10 },
                  v2: { x: 0, y: 10 },
                  v3: { x: 0, y: 0 },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = svgToWindfoilOutlines(source)
    expect(result.layers).toHaveLength(1)
    expect(codes(result)).toContain('nested-viewport-lost')
  })
})
