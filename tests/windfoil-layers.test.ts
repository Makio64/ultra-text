import { describe, expect, it } from 'vitest'
import type { BufferAttribute } from 'three/webgpu'
import type {
  DomLayoutSnapshot,
  GlyphRequest,
  WindfoilGlyphOutline,
  WindfoilGradientPaint,
} from '../src/types.js'
import { preprocessWindfoilOutlines, WINDFOIL_MAX_LAYERS } from '../src/windfoil/preprocess.js'
import {
  createWindfoilGlyphGeometry,
  updateWindfoilGlyphGeometry,
  windfoilContentFits,
} from '../src/windfoil/geometry.js'
import { normalizeWindfoilPaint, packWindfoilPaints } from '../src/windfoil/paint.js'
import { packWindfoilLayers } from '../src/windfoil/color.js'
import {
  createWindfoilCompositeGeometry,
  updateWindfoilCompositeGeometry,
} from '../src/windfoil/compositeGeometry.js'
const square = [0, 0, 5, 0, 10, 0, 10, 0, 10, 5, 10, 10, 10, 10, 5, 10, 0, 10, 0, 10, 0, 5, 0, 0]
const outline: WindfoilGlyphOutline = {
  unitsPerEm: 10,
  ascent: 10,
  descent: 0,
  bbox: [0, 0, 10, 10],
  quadratics: [],
  layers: [
    { quadratics: square, paint: { type: 'solid', color: [1, 0, 0, 0.5] } },
    { quadratics: square, paint: { type: 'foreground', alpha: 0.75 } },
  ],
}
function prepare(value = outline) {
  return preprocessWindfoilOutlines([{ key: 'a', outline: value }])
}
const snapshot: DomLayoutSnapshot = {
  width: 100,
  height: 40,
  glyphs: [
    {
      glyphKey: 'a',
      fontSize: 10,
      originX: 2,
      lineBottom: 3,
      advance: 10,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 100, 40],
      color: [0, 0.5, 1, 0.5],
      sequence: 2,
      z: 4,
    },
  ],
  rects: [],
  requests: [] as GlyphRequest[],
  blocks: [],
  capturedAt: 0,
} as unknown as DomLayoutSnapshot

describe('Windfoil layered outlines', () => {
  it('validates paint, layer bounds and layer cap with labelled errors', () => {
    expect(() =>
      prepare({
        ...outline,
        layers: [{ quadratics: square, paint: { type: 'solid', color: [1, 2, 0, 1] } }],
      }),
    ).toThrow('sources[0].outline.layers[0].paint.color[1]')
    expect(() =>
      prepare({
        ...outline,
        layers: [{ quadratics: square, bbox: [-1, 0, 10, 10], paint: { type: 'foreground' } }],
      }),
    ).toThrow('layers[0].bbox')
    expect(() =>
      prepare({
        ...outline,
        layers: Array.from({ length: WINDFOIL_MAX_LAYERS + 1 }, () => outline.layers![0]!),
      }),
    ).toThrow('layers.length')
  })
  it('files layers in paint order and drops empty and transparent solid layers', () => {
    const prepared = prepare({
      ...outline,
      layers: [
        ...outline.layers!,
        { quadratics: [], paint: { type: 'foreground' } },
        { quadratics: square, paint: { type: 'solid', color: [1, 0, 0, 0] } },
      ],
    })
    const header = prepared.glyphs.get('a')!
    expect(header.layers).toHaveLength(2)
    expect(header.layers![1]!.rowBase).toBeGreaterThan(header.layers![0]!.rowBase)
    expect(header.rowBase).toBe(header.layers![0]!.rowBase)
    expect(header.monotonePieceCount).toBe(8)
    expect(prepared.layered).toBe(true)
    expect(prepared.stats.paintLayers).toBe(2)
  })
  it('rejects conflicting paints for the same key but accepts equivalent copies', () => {
    expect(() =>
      preprocessWindfoilOutlines([
        { key: 'a', outline },
        { key: 'a', outline: { ...outline } },
      ]),
    ).not.toThrow()
    expect(() =>
      preprocessWindfoilOutlines([
        { key: 'a', outline },
        { key: 'a', outline: { ...outline, layers: [outline.layers![0]!] } },
      ]),
    ).toThrow('conflicting outlines')
  })
  it('compares gradient fields and nested stops independently of object property order', () => {
    const paints: WindfoilGradientPaint[] = [
      { type: 'linear', p0: [0, 0], p1: [10, 0], stops: [] },
      { type: 'radial', c0: [0, 0], r0: 1, c1: [2, 2], r1: 10, stops: [] },
      { type: 'sweep', center: [5, 5], startAngle: 0, endAngle: 360, stops: [] },
    ]
    for (const paint of paints) {
      const first: WindfoilGradientPaint = {
        ...paint,
        transform: [1, 0, 0, 1, 2, 3],
        stops: [
          { offset: 0, color: [1, 0, 0, 1] },
          { offset: 1, color: [0, 0, 1, 1] },
        ],
      }
      const second = Object.fromEntries(
        Object.entries(first).reverse(),
      ) as unknown as WindfoilGradientPaint
      const source = (paint: WindfoilGradientPaint) => ({
        key: 'a',
        outline: { ...outline, layers: [{ quadratics: square, paint }] },
      })
      expect(() =>
        preprocessWindfoilOutlines([
          source(first),
          source({ ...second, stops: first.stops.map(({ offset, color }) => ({ color, offset })) }),
        ]),
      ).not.toThrow()
      expect(() =>
        preprocessWindfoilOutlines([
          source(first),
          source({ ...second, stops: [...first.stops].reverse() }),
        ]),
      ).toThrow('conflicting outlines')
      expect(() =>
        preprocessWindfoilOutlines([
          source(first),
          source({ ...second, transform: [1, 0, 0, 1, 3, 2] }),
        ]),
      ).toThrow('conflicting outlines')
    }
  })
  it('expands instances while preserving glyph centres, ordinals, opacity and union rectangles', () => {
    const prepared = prepare(),
      { geometry } = createWindfoilGlyphGeometry(
        snapshot,
        prepared.glyphs,
        0,
        true,
        new Float32Array([7]),
      )
    expect(geometry.instanceCount).toBe(2)
    expect(Array.from(geometry.getAttribute('windfoilLayer').array)).toEqual([
      7, 8, 7, 1, 7, 8, 7, 0,
    ])
    expect(Array.from(geometry.getAttribute('sdfColor').array)).toEqual([
      255, 0, 0, 64, 0, 128, 255, 96,
    ])
    const table = geometry.userData['ultraGlyphRects'] as Float32Array
    expect(Array.from(table)).toEqual([2, 3, 12, 13])
    const moved = {
      ...snapshot,
      glyphs: snapshot.glyphs.map((glyph) => ({ ...glyph, originX: 4 })),
    }
    expect(updateWindfoilGlyphGeometry(geometry, moved, prepared.glyphs, 0)).toBe(2)
    expect(geometry.userData['ultraGlyphRects']).toBe(table)
    expect(Array.from(table)).toEqual([4, 3, 14, 13])
    expect(windfoilContentFits(geometry, { ...snapshot, glyphs: [] }, prepared.glyphs)).toBe(false)
    geometry.dispose()
  })
  it('keeps ordinary outline geometry at six instance attributes', () => {
    const prepared = prepare({
      ...outline,
      quadratics: square,
      layers: undefined,
    } as unknown as WindfoilGlyphOutline)
    const { geometry } = createWindfoilGlyphGeometry(snapshot, prepared.glyphs, 0)
    expect(Object.keys(geometry.attributes)).toEqual([
      'position',
      'normal',
      'sdfRect',
      'sdfClip',
      'sdfColor',
      'sdfMeta',
      'windfoilBounds',
      'windfoilBand',
    ])
    expect(geometry.userData['ultraGlyphRects']).toBeUndefined()
    geometry.dispose()
  })
  it('accepts exact ink bounds with controls outside and rejects clipped-away instances', () => {
    const curved = [0, 0, 20, 10, 0, 20, 0, 20, 0, 10, 0, 0]
    expect(() =>
      prepare({
        ...outline,
        bbox: [0, 0, 10, 20],
        layers: [{ quadratics: curved, bbox: [0, 0, 10, 20], paint: { type: 'foreground' } }],
      }),
    ).not.toThrow()
    const prepared = prepare({ ...outline, clipBox: [30, 30, 40, 40] })
    const packed = packWindfoilLayers(prepared)
    expect(prepared.glyphs.get('a')!.monotonePieceCount).toBe(0)
    expect(packed.layers).toHaveLength(0)
    const { geometry } = createWindfoilCompositeGeometry(snapshot, packed.glyphs, 0)
    expect(geometry.instanceCount).toBe(0)
    geometry.dispose()
  })
  it('validates extrema on both axes without replacing tight bounds with control bounds', () => {
    for (const sign of [-1, 1]) {
      const box = sign > 0 ? ([0, 0, 10, 20] as const) : ([-10, -20, -0, -0] as const)
      const value = {
        ...outline,
        bbox: box,
        layers: [
          {
            quadratics: [-0, -0, sign * 20, sign * 40, -0, -0],
            bbox: box,
            paint: { type: 'foreground' as const },
          },
        ],
      }
      expect(() => prepare(value)).not.toThrow()
      for (const axis of [0, 1]) {
        const smaller: number[] = [...box]
        smaller[sign > 0 ? axis + 2 : axis] = sign * (axis ? 19.8 : 9.8)
        const tighter = smaller as unknown as WindfoilGlyphOutline['bbox']
        expect(() =>
          prepare({
            ...value,
            bbox: tighter,
            layers: [{ ...value.layers[0]!, bbox: tighter }],
          }),
        ).toThrow('layers[0].bbox')
      }
    }
  })
  it('packs composite layers and updates one quad per colour glyph', () => {
    const prepared = prepare(),
      packed = packWindfoilLayers(prepared)
    expect(packed.layers).toHaveLength(24)
    expect(packed.layers[8]).toBe(0)
    expect(packed.layers[20]).toBe(1)
    const { geometry } = createWindfoilCompositeGeometry(
      snapshot,
      packed.glyphs,
      0,
      new Float32Array([5]),
    )
    expect(geometry.instanceCount).toBe(1)
    expect(Array.from(geometry.getAttribute('windfoilLayers').array)).toEqual([0, 2, 5])
    expect(updateWindfoilCompositeGeometry(geometry, snapshot, packed.glyphs, 0)).toBe(2)
    expect(
      updateWindfoilCompositeGeometry(geometry, { ...snapshot, glyphs: [] }, packed.glyphs, 0),
    ).toBeNull()
    geometry.dispose()
  })
  it('updates composite buffers once while retaining clipped rects and capture ordinals', () => {
    const packed = packWindfoilLayers(prepare({ ...outline, clipBox: [2, 3, 8, 9] }))
    const glyph = snapshot.glyphs[0]!
    const layout: DomLayoutSnapshot = {
      ...snapshot,
      glyphs: [
        { ...glyph, glyphKey: 'missing' },
        glyph,
        {
          ...glyph,
          fontSize: 20,
          originX: 4,
          lineBottom: 5,
          baselineOffset: 7,
          color: [-0.2, 0.501, 1.2, 0.5],
          sequence: 9,
          z: -3,
          motionOrigin: [20, 20, 12],
        },
      ],
    }
    const { geometry, maxSequence } = createWindfoilCompositeGeometry(
      layout,
      packed.glyphs,
      2,
      new Float32Array([11, 7, 8]),
    )
    expect(maxSequence).toBe(9)
    expect(geometry.instanceCount).toBe(2)
    expect(Array.from(geometry.getAttribute('sdfRect').array)).toEqual([
      4, 6, 10, 12, 8, 18, 20, 30,
    ])
    expect(Array.from(geometry.getAttribute('sdfColor').array)).toEqual([
      0, 128, 255, 128, 0, 128, 255, 128,
    ])
    expect(Array.from(geometry.getAttribute('sdfMeta').array)).toEqual([2, 4, 9, -3])
    expect(Array.from(geometry.getAttribute('windfoilLayers').array)).toEqual([0, -2, 7, 0, -2, 8])
    const attributes = Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        { attribute, version: (attribute as BufferAttribute).version },
      ]),
    )
    const table = geometry.userData['ultraGlyphRects'] as Float32Array
    expect(updateWindfoilCompositeGeometry(geometry, layout, packed.glyphs, 2)).toBe(9)
    expect(Array.from(geometry.getAttribute('windfoilLayers').array)).toEqual([0, -2, 0, 0, -2, 12])
    expect(geometry.userData['ultraGlyphRects']).toBe(table)
    expect(table).toEqual(geometry.getAttribute('sdfRect').array)
    expect(geometry.boundingBox?.min.toArray()).toEqual([-2, -2, -5])
    expect(geometry.boundingBox?.max.toArray()).toEqual([102, 42, 6])
    for (const [name, before] of Object.entries(attributes)) {
      expect(geometry.getAttribute(name)).toBe(before.attribute)
      expect((geometry.getAttribute(name) as BufferAttribute).version).toBe(
        before.version + Number(name !== 'position' && name !== 'normal'),
      )
    }
    expect(
      updateWindfoilCompositeGeometry(geometry, { ...layout, glyphs: [] }, packed.glyphs, 2),
    ).toBeNull()
    expect(table).toEqual(geometry.getAttribute('sdfRect').array)
    geometry.dispose()
  })
})
describe('Windfoil paint normalization', () => {
  const stops = [
    { offset: 2, color: [1, 0, 0, 1] as const },
    { offset: 4, color: [0, 0, 1, 0.5] as const },
  ]
  it('normalizes colour lines and inverts gradient transforms', () => {
    const paint = normalizeWindfoilPaint({
      type: 'linear',
      p0: [0, 0],
      p1: [10, 0],
      stops,
      transform: [2, 0, 0, 2, 4, 6],
    })
    expect(paint.inverse).toEqual([0.5, -0, -0, 0.5, -2, -3])
    expect(paint.params).toEqual([0.05, 0, -1])
    expect(paint.stops.map((stop) => stop.offset)).toEqual([0, 1])
    expect(paint.alphaMax).toBe(1)
  })
  it('handles solid/foreground, singleton stops, transparent and degenerate paints', () => {
    expect(normalizeWindfoilPaint({ type: 'foreground', alpha: 0.3 }).kind).toBe(1)
    expect(
      normalizeWindfoilPaint({ type: 'linear', p0: [0, 0], p1: [1, 0], stops: [stops[0]!] }).kind,
    ).toBe(0)
    expect(normalizeWindfoilPaint({ type: 'linear', p0: [0, 0], p1: [0, 0], stops }).alphaMax).toBe(
      0,
    )
    expect(
      normalizeWindfoilPaint({ type: 'sweep', center: [0, 0], startAngle: 0, endAngle: 0, stops })
        .alphaMax,
    ).toBe(0)
    expect(() =>
      normalizeWindfoilPaint({
        type: 'linear',
        p0: [0, 0],
        p1: [1, 0],
        stops,
        transform: [1, 1, 1, 1, 0, 0],
      }),
    ).toThrow('nonsingular')
    expect(() =>
      normalizeWindfoilPaint({ type: 'radial', c0: [0, 0], c1: [0, 0], r0: -1, r1: 1, stops }),
    ).toThrow('radii')
  })
  it('packs stable shared paints and radial/sweep invariants', () => {
    const radial = normalizeWindfoilPaint({
      type: 'radial',
      c0: [0, 0],
      c1: [2, 2],
      r0: 0,
      r1: 10,
      stops,
      extend: 'reflect',
    })
    expect(radial.params).toEqual([4, 4, 4, 4, 20, 20])
    const sweep = normalizeWindfoilPaint({
      type: 'sweep',
      center: [1, 2],
      startAngle: 0,
      endAngle: 360,
      stops,
      extend: 'repeat',
    })
    const packed = packWindfoilPaints([radial, sweep, radial])
    expect(packed.paints).toHaveLength(32)
    expect(packed.stops).toHaveLength(8)
    expect(packed.indices).toEqual([0, 1, 0])
  })
})
