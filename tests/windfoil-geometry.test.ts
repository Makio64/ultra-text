import type { InstancedBufferAttribute } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import {
  createWindfoilGlyphGeometry,
  updateWindfoilGlyphGeometry,
} from '../src/windfoil/geometry.js'
import type { WindfoilGlyphHeader } from '../src/windfoil/preprocess.js'
import type { DomLayoutSnapshot, GlyphLayout } from '../src/types.js'

const primaryHeader: WindfoilGlyphHeader = {
  rowBase: 7,
  bandCount: 3,
  bandH: 300,
  invH: 1 / 300,
  unitsPerEm: 1_000,
  ascent: 800,
  descent: -200,
  bbox: [-50, -200, 650, 700],
  monotonePieceCount: 12,
}

const alternateHeader: WindfoilGlyphHeader = {
  rowBase: 22,
  bandCount: 2,
  bandH: 500,
  invH: 1 / 500,
  unitsPerEm: 2_000,
  ascent: 1_500,
  descent: -500,
  bbox: [100, -400, 1_100, 1_400],
  monotonePieceCount: 4,
}

const firstGlyph: GlyphLayout = {
  glyphKey: 'face\u0000A',
  fontSize: 50,
  originX: 20,
  lineBottom: 10,
  advance: 40,
  block: 0,
  breakBefore: 'none',
  clip: [0, 0, 200, 100],
  color: [1, 0.5, 0, 0.75],
  sequence: 4,
  z: 2,
}

const snapshot: DomLayoutSnapshot = {
  width: 200,
  height: 100,
  glyphs: [
    firstGlyph,
    {
      ...firstGlyph,
      glyphKey: 'missing',
      originX: 60,
      sequence: 99,
    },
    {
      ...firstGlyph,
      glyphKey: 'face\u0000B',
      fontSize: 100,
      originX: 80,
      lineBottom: 25,
      clip: [5, 6, 190, 90],
      color: [0.25, 1, 0, 1],
      sequence: 6,
      z: 3,
    },
  ],
  rects: [],
  blocks: [{ left: 0, firstBaseline: 20, linePitch: 20, width: 200, clip: [0, 0, 200, 100] }],
  requests: [],
  atlasSignature: 'face',
  lineCount: 1,
}

const glyphs = new Map<string, WindfoilGlyphHeader>([
  ['face\u0000A', primaryHeader],
  ['face\u0000B', alternateHeader],
])

describe('Windfoil instanced geometry', () => {
  it('maps OpenType y-up bounds onto DOM-local quads and packs analytic headers', () => {
    const { geometry, maxSequence } = createWindfoilGlyphGeometry(snapshot, glyphs, 24)

    expect(geometry.instanceCount).toBe(2)
    expect(maxSequence).toBe(6)
    expect([...geometry.getAttribute('position').array]).toEqual([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ])
    expect([...geometry.index!.array]).toEqual([0, 1, 2, 0, 2, 3])

    // A: scale=.05, baseline=10-(-200*.05)=20.
    // B: scale=.05, baseline=25-(-500*.05)=50.
    expect([...geometry.getAttribute('sdfRect').array]).toEqual([
      17.5, 10, 52.5, 55, 85, 30, 135, 120,
    ])
    expect([...geometry.getAttribute('windfoilBounds').array]).toEqual([
      -50, -200, 650, 700, 100, -400, 1100, 1400,
    ])
    expect([...geometry.getAttribute('windfoilBand').array]).toEqual([
      7,
      3,
      300,
      Math.fround(1 / 300),
      22,
      2,
      500,
      Math.fround(1 / 500),
    ])
    expect([...geometry.getAttribute('sdfClip').array]).toEqual([0, 0, 200, 100, 5, 6, 190, 90])
    expect(geometry.getAttribute('sdfMeta').itemSize).toBe(2)
    expect([...geometry.getAttribute('sdfMeta').array]).toEqual([4, 2, 6, 3])
    expect(geometry.getAttribute('sdfMeta').array.byteLength).toBe(geometry.instanceCount * 8)
    const color = geometry.getAttribute('sdfColor')
    expect(color.normalized).toBe(true)
    expect([...color.array]).toEqual([255, 128, 0, 191, 64, 255, 0, 255])
    expect(geometry.boundingBox?.min.toArray()).toEqual([-24, -24, -24])
    expect(geometry.boundingBox?.max.toArray()).toEqual([224, 124, 27])
    geometry.dispose()
  })

  it('updates every per-instance attribute in place when glyph order and colour change', () => {
    const { geometry } = createWindfoilGlyphGeometry(snapshot, glyphs, 24)
    const boundsAttribute = geometry.getAttribute('windfoilBounds')
    const bandAttribute = geometry.getAttribute('windfoilBand')
    const colorAttribute = geometry.getAttribute('sdfColor')
    const attributes = [
      geometry.getAttribute('sdfRect'),
      geometry.getAttribute('sdfClip'),
      colorAttribute,
      geometry.getAttribute('sdfMeta'),
      boundsAttribute,
      bandAttribute,
    ] as InstancedBufferAttribute[]
    const versions = attributes.map((attribute) => attribute.version)

    const moved: DomLayoutSnapshot = {
      ...snapshot,
      width: 300,
      height: 180,
      glyphs: [...snapshot.glyphs].reverse().map((glyph, index) => ({
        ...glyph,
        originX: glyph.originX + 10,
        lineBottom: glyph.lineBottom + 20,
        color: index === 0 ? ([0, 0.25, 1, 0.5] as const) : ([0.75, 0, 0.5, 1] as const),
        sequence: index,
        z: glyph.z + 5,
      })),
    }

    expect(updateWindfoilGlyphGeometry(geometry, moved, glyphs, 12)).toBe(2)
    const fresh = createWindfoilGlyphGeometry(moved, glyphs, 12)
    for (const name of [
      'sdfRect',
      'sdfClip',
      'sdfColor',
      'sdfMeta',
      'windfoilBounds',
      'windfoilBand',
    ]) {
      expect([...geometry.getAttribute(name).array]).toEqual([
        ...fresh.geometry.getAttribute(name).array,
      ])
    }
    expect(attributes.map((attribute) => attribute.version)).toEqual(
      versions.map((version) => version + 1),
    )
    expect(geometry.getAttribute('windfoilBounds')).toBe(boundsAttribute)
    expect(geometry.getAttribute('windfoilBand')).toBe(bandAttribute)
    expect(geometry.getAttribute('sdfColor')).toBe(colorAttribute)
    expect(geometry.boundingBox?.max.toArray()).toEqual([312, 192, 20])

    fresh.geometry.dispose()
    geometry.dispose()
  })

  it('returns null when headers are absent or the retained shape is incompatible', () => {
    const { geometry } = createWindfoilGlyphGeometry(snapshot, glyphs, 24)
    const fewer = new Map(glyphs)
    fewer.delete('face\u0000B')
    expect(updateWindfoilGlyphGeometry(geometry, snapshot, fewer, 24)).toBeNull()

    const missingAttribute = createWindfoilGlyphGeometry(snapshot, glyphs, 24).geometry
    missingAttribute.deleteAttribute('windfoilBand')
    expect(updateWindfoilGlyphGeometry(missingAttribute, snapshot, glyphs, 24)).toBeNull()
    missingAttribute.dispose()
    geometry.dispose()
  })

  it('omits blank glyph quads while preserving later instance order', () => {
    const blank: WindfoilGlyphHeader = {
      ...primaryHeader,
      bbox: [0, 0, 0, 0],
      monotonePieceCount: 0,
    }
    const withBlank = new Map(glyphs).set('face\u0000A', blank)
    const { geometry, maxSequence } = createWindfoilGlyphGeometry(snapshot, withBlank, 0)

    expect(geometry.instanceCount).toBe(1)
    expect(maxSequence).toBe(6)
    expect([...geometry.getAttribute('sdfMeta').array]).toEqual([6, 3])
    geometry.dispose()
  })

  it('keeps unrounded shared motion centers and explicit origins across layered updates', () => {
    const header: WindfoilGlyphHeader = {
      ...primaryHeader,
      layers: [
        {
          ...primaryHeader,
          paintKind: 0,
          rgba: [0, 0, 0, 1],
          paint: { type: 'foreground' },
          paintLabel: 'foreground',
        },
        {
          ...primaryHeader,
          bbox: [-17.3, -91.7, 511.1, 399.3],
          paintKind: 1,
          rgba: [1, 0.25, 0, 0.5],
          paint: { type: 'solid', color: [1, 0.25, 0, 0.5] },
          paintLabel: 'solid',
        },
      ],
    }
    const glyph = {
      ...firstGlyph,
      originX: 123456.789,
      lineBottom: -17.125,
      fontSize: 13.7,
      baselineOffset: 0.37,
    }
    const input = { ...snapshot, glyphs: [glyph] }
    const headers = new Map([[glyph.glyphKey, header]])
    const { geometry } = createWindfoilGlyphGeometry(
      input,
      headers,
      0,
      true,
      new Float32Array([19]),
    )
    const scale = glyph.fontSize / header.unitsPerEm
    const center = [
      Math.fround(
        (glyph.originX + header.bbox[0] * scale + (glyph.originX + header.bbox[2] * scale)) / 2,
      ),
      Math.fround(
        (glyph.lineBottom +
          glyph.baselineOffset +
          header.bbox[1] * scale +
          (glyph.lineBottom + glyph.baselineOffset + header.bbox[3] * scale)) /
          2,
      ),
    ]
    expect([...geometry.getAttribute('windfoilLayer').array]).toEqual([
      ...center,
      19,
      0,
      ...center,
      19,
      1,
    ])
    const moved = { ...input, glyphs: [{ ...glyph, motionOrigin: [2.1, -3.2, 7] as const }] }
    expect(updateWindfoilGlyphGeometry(geometry, moved, headers, 0, new Float32Array([23]))).toBe(4)
    expect([...geometry.getAttribute('windfoilLayer').array]).toEqual([
      Math.fround(2.1),
      Math.fround(-3.2),
      23,
      0,
      Math.fround(2.1),
      Math.fround(-3.2),
      23,
      1,
    ])
    geometry.dispose()
  })
})
