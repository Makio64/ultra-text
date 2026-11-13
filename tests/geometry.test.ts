import { Texture } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import {
  createGlyphGeometry,
  createRectGeometry,
  updateGlyphContent,
  updateGlyphGeometry,
  updateRectGeometry,
} from '../src/text/geometry.js'
import type { DomLayoutSnapshot, GlyphSlot, SdfAtlas } from '../src/types.js'

const glyphSlot: GlyphSlot = {
  key: 'face\u0000A',
  character: 'A',
  fontKey: 'face',
  u0: 0.125,
  v0: 0.25,
  u1: 0.375,
  v1: 0.75,
  planeX0: -2,
  planeY0: -3,
  planeX1: 12,
  planeY1: 15,
  descent: 3,
  advance: 10,
}

const snapshot: DomLayoutSnapshot = {
  width: 200,
  height: 100,
  glyphs: [
    {
      glyphKey: glyphSlot.key,
      fontSize: 32,
      originX: 10,
      lineBottom: 20,
      advance: 16,
      block: 0,
      breakBefore: 'soft',
      clip: [0, 0, 200, 100],
      color: [1, 0.5, 0, 0.75],
      sequence: 4,
      z: 2,
    },
    {
      glyphKey: 'missing',
      fontSize: 32,
      originX: 0,
      lineBottom: 0,
      advance: 16,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 200, 100],
      color: [1, 1, 1, 1],
      sequence: 9,
      z: 2,
    },
    {
      glyphKey: glyphSlot.key,
      fontSize: 32,
      originX: 40,
      lineBottom: 20,
      advance: 16,
      block: 0,
      breakBefore: 'soft',
      clip: [0, 0, 200, 100],
      color: [0.5, 1, 0, 1],
      sequence: 6,
      z: 3,
    },
  ],
  rects: [
    {
      rect: [0, 0, 200, 100],
      color: [0.5, 0.25, 0.125, 1],
      radius: 12,
      z: -1,
      receiveShadow: true,
    },
    {
      rect: [5, 6, 20, 30],
      color: [1, 0, 0, 0.5],
      radius: 3,
      z: 1,
      receiveShadow: false,
    },
  ],
  blocks: [{ left: 0, firstBaseline: 20, linePitch: 20, width: 200, clip: [0, 0, 200, 100] }],
  requests: [],
  atlasSignature: 'face',
  lineCount: 1,
}

const atlas: SdfAtlas = {
  texture: new Texture(),
  width: 64,
  height: 64,
  pxRange: 8,
  bakeSize: 32,
  glyphs: new Map([[glyphSlot.key, glyphSlot]]),
  mode: 'cpu',
  dispose: () => undefined,
}

describe('instanced DOM geometry', () => {
  it('uses captured native descent for shaped runs before and after geometry updates', () => {
    const shaped: DomLayoutSnapshot = {
      ...snapshot,
      textShaping: 'browser',
      glyphs: [{ ...snapshot.glyphs[0]!, baselineOffset: 2.5, motionOrigin: [20, 30, 0] }],
    }
    const { geometry } = createGlyphGeometry(shaped, atlas, 0)
    expect(geometry.getAttribute('sdfRect').getY(0)).toBe(19.5)
    expect([...geometry.getAttribute('sdfRunMotion').array]).toEqual([20, 30, 0])
    const moved: DomLayoutSnapshot = {
      ...shaped,
      glyphs: [{ ...shaped.glyphs[0]!, lineBottom: 30, motionOrigin: [25, 35, 0] }],
    }
    updateGlyphGeometry(geometry, moved, atlas, 0)
    expect(geometry.getAttribute('sdfRect').getY(0)).toBe(29.5)
    expect([...geometry.getAttribute('sdfRunMotion').array]).toEqual([25, 35, 0])
    geometry.dispose()
  })

  it('packs visible glyphs into static normalized attributes with canvas UVs flipped', () => {
    const { geometry, maxSequence } = createGlyphGeometry(snapshot, atlas, 24)
    const uvRect = geometry.getAttribute('sdfUvRect')
    const color = geometry.getAttribute('sdfColor')
    const metadata = geometry.getAttribute('sdfMeta')

    expect(geometry.instanceCount).toBe(2)
    expect(maxSequence).toBe(6)
    expect(uvRect.normalized).toBe(true)
    expect([...uvRect.array]).toEqual([
      Math.round(0.125 * 65535),
      Math.round(0.75 * 65535),
      Math.round(0.375 * 65535),
      Math.round(0.25 * 65535),
      Math.round(0.125 * 65535),
      Math.round(0.75 * 65535),
      Math.round(0.375 * 65535),
      Math.round(0.25 * 65535),
    ])
    expect(color.normalized).toBe(true)
    expect([...color.array]).toEqual([255, 128, 0, 191, 128, 255, 0, 255])
    // Only sequence and depth are uploaded; the shader reads the instance index.
    expect(metadata.itemSize).toBe(2)
    expect([...metadata.array]).toEqual([4, 2, 6, 3])
    expect(metadata.array.byteLength).toBe(geometry.instanceCount * 8)
    expect(geometry.getAttribute('normal').count).toBe(4)
    expect(geometry.boundingBox?.min.x).toBe(-24)
    expect(geometry.boundingBox?.max.x).toBe(224)
    geometry.dispose()
  })

  it('updates rects, clips and sequences in place without touching UVs or colors', () => {
    const { geometry } = createGlyphGeometry(snapshot, atlas, 24)
    const uvBefore = [...geometry.getAttribute('sdfUvRect').array]
    const colorBefore = [...geometry.getAttribute('sdfColor').array]

    // A reflow-style change: same glyphs, moved and renumbered per line.
    const moved: DomLayoutSnapshot = {
      ...snapshot,
      width: 300,
      glyphs: snapshot.glyphs.map((glyph, index) => ({
        ...glyph,
        originX: glyph.originX + 25,
        lineBottom: glyph.lineBottom + 40,
        sequence: index,
      })),
    }
    const maxSequence = updateGlyphGeometry(geometry, moved, atlas, 24)
    expect(maxSequence).toBe(2)

    // The in-place result matches a from-scratch build for what changed…
    const fresh = createGlyphGeometry(moved, atlas, 24)
    expect([...geometry.getAttribute('sdfRect').array]).toEqual([
      ...fresh.geometry.getAttribute('sdfRect').array,
    ])
    expect([...geometry.getAttribute('sdfClip').array]).toEqual([
      ...fresh.geometry.getAttribute('sdfClip').array,
    ])
    expect([...geometry.getAttribute('sdfMeta').array]).toEqual([
      ...fresh.geometry.getAttribute('sdfMeta').array,
    ])
    // …while the untouched attributes keep their original storage and bytes.
    expect([...geometry.getAttribute('sdfUvRect').array]).toEqual(uvBefore)
    expect([...geometry.getAttribute('sdfColor').array]).toEqual(colorBefore)
    expect(geometry.boundingBox?.max.x).toBe(324)

    fresh.geometry.dispose()
    geometry.dispose()
  })

  it('rewrites colours and UVs in place when the glyph count matches', () => {
    const { geometry } = createGlyphGeometry(snapshot, atlas, 24)
    const other: GlyphSlot = { ...glyphSlot, key: 'face\u0000B', character: 'B', u0: 0.5, u1: 0.75 }
    const contentAtlas: SdfAtlas = {
      ...atlas,
      glyphs: new Map([
        [glyphSlot.key, glyphSlot],
        [other.key, other],
      ]),
    }
    const moved: DomLayoutSnapshot = {
      ...snapshot,
      glyphs: [
        { ...snapshot.glyphs[0]!, originX: 80, color: [0, 0, 1, 1], z: 4 },
        { ...snapshot.glyphs[2]!, glyphKey: other.key, color: [0, 1, 0, 1] },
      ],
    }
    expect(updateGlyphContent(geometry, moved, contentAtlas, 24)).toBe(6)
    const fresh = createGlyphGeometry(moved, contentAtlas, 24)
    for (const name of ['sdfRect', 'sdfUvRect', 'sdfClip', 'sdfColor', 'sdfMeta']) {
      expect([...geometry.getAttribute(name).array]).toEqual([
        ...fresh.geometry.getAttribute(name).array,
      ])
    }
    expect(
      updateGlyphContent(
        geometry,
        { ...moved, glyphs: moved.glyphs.slice(0, 1) },
        contentAtlas,
        24,
      ),
    ).toBeNull()
    expect([...geometry.getAttribute('sdfColor').array]).toEqual([
      ...fresh.geometry.getAttribute('sdfColor').array,
    ])
    fresh.geometry.dispose()
    geometry.dispose()
  })

  it('trims each quad to its slot support, rounded outwards in the UV rect’s order', () => {
    const supported: GlyphSlot = {
      ...glyphSlot,
      support: { u0: 0.15, v0: 0.3, u1: 0.35, v1: 0.6 },
    }
    const other: GlyphSlot = { ...glyphSlot, key: 'face\u0000B', character: 'B' }
    const trimmedAtlas: SdfAtlas = {
      ...atlas,
      glyphs: new Map([
        [supported.key, supported],
        [other.key, other],
      ]),
    }
    const layout: DomLayoutSnapshot = {
      ...snapshot,
      glyphs: [snapshot.glyphs[0]!, { ...snapshot.glyphs[2]!, glyphKey: other.key }],
    }
    const { geometry } = createGlyphGeometry(layout, trimmedAtlas, 0)
    const trim = geometry.getAttribute('sdfTrim')
    const uvRect = geometry.getAttribute('sdfUvRect')
    expect(trim.normalized).toBe(true)
    expect(trim.itemSize).toBe(4)
    // (u0, v1, u1, v0) like the UV rect: lower bounds floor, upper bounds ceil.
    expect([...trim.array.subarray(0, 4)]).toEqual([
      Math.floor(0.15 * 65535),
      Math.ceil(0.6 * 65535),
      Math.ceil(0.35 * 65535),
      Math.floor(0.3 * 65535),
    ])
    // A slot without a support box repeats its UV rect: the whole quad.
    expect([...trim.array.subarray(4, 8)]).toEqual([...uvRect.array.subarray(4, 8)])

    // A content rewrite keeps the trim with its glyph, as a fresh build writes it.
    const swapped: DomLayoutSnapshot = {
      ...layout,
      glyphs: [layout.glyphs[1]!, layout.glyphs[0]!],
    }
    expect(updateGlyphContent(geometry, swapped, trimmedAtlas, 0)).not.toBeNull()
    const fresh = createGlyphGeometry(swapped, trimmedAtlas, 0)
    expect([...geometry.getAttribute('sdfTrim').array]).toEqual([
      ...fresh.geometry.getAttribute('sdfTrim').array,
    ])
    // A reflow only moves positions: the trim is in atlas UV and keeps its bytes.
    const before = [...geometry.getAttribute('sdfTrim').array]
    const moved = {
      ...swapped,
      glyphs: swapped.glyphs.map((glyph) => ({ ...glyph, originX: glyph.originX + 7 })),
    }
    expect(updateGlyphGeometry(geometry, moved, trimmedAtlas, 0)).not.toBeNull()
    expect([...geometry.getAttribute('sdfTrim').array]).toEqual(before)
    fresh.geometry.dispose()
    geometry.dispose()
  })

  it('keeps whole quads, and no trim, for run motion; content fits only a matching layout', () => {
    const shaped: DomLayoutSnapshot = { ...snapshot, textShaping: 'browser' }
    const run = createGlyphGeometry(shaped, atlas, 0).geometry
    // Run motion takes a vertex buffer of its own: with the trim beside a pass that reads the
    // normal it would pass WebGPU's minimum of eight.
    expect(run.getAttribute('sdfRunMotion')).toBeDefined()
    expect(run.getAttribute('sdfTrim')).toBeUndefined()
    const plain = createGlyphGeometry(snapshot, atlas, 0).geometry
    expect(plain.getAttribute('sdfTrim')).toBeDefined()
    // Neither layout is rewritten into the other's geometry. One whose trim was deleted, to
    // draw whole quads, is rewritten in place and keeps drawing them.
    expect(updateGlyphContent(run, snapshot, atlas, 0)).toBeNull()
    expect(updateGlyphContent(plain, shaped, atlas, 0)).toBeNull()
    plain.deleteAttribute('sdfTrim')
    expect(updateGlyphContent(plain, snapshot, atlas, 0)).not.toBeNull()
    expect(plain.getAttribute('sdfTrim')).toBeUndefined()
    run.dispose()
    plain.dispose()
  })

  it('rewrites a same-count rectangle batch in place', () => {
    const geometry = createRectGeometry(snapshot, true)!
    const moved: DomLayoutSnapshot = {
      ...snapshot,
      rects: snapshot.rects.map((rect) =>
        rect.receiveShadow
          ? { ...rect, rect: [1, 2, 3, 4] as const, radius: 7, color: [0, 0, 1, 1] as const }
          : rect,
      ),
    }
    expect(updateRectGeometry(geometry, moved, true)).toBe(true)
    const fresh = createRectGeometry(moved, true)!
    expect([...geometry.getAttribute('sdfRect').array]).toEqual([
      ...fresh.getAttribute('sdfRect').array,
    ])
    expect([...geometry.getAttribute('sdfRadius').array]).toEqual([7])
    expect(updateRectGeometry(geometry, { ...moved, rects: [] }, true)).toBe(false)
    fresh.dispose()
    geometry.dispose()
  })

  it('refuses an in-place update when the glyph set no longer matches', () => {
    const { geometry } = createGlyphGeometry(snapshot, atlas, 24)

    const fewer: DomLayoutSnapshot = { ...snapshot, glyphs: snapshot.glyphs.slice(0, 1) }
    expect(updateGlyphGeometry(geometry, fewer, atlas, 24)).toBeNull()

    const more: DomLayoutSnapshot = {
      ...snapshot,
      glyphs: [...snapshot.glyphs, snapshot.glyphs[0]!],
    }
    expect(updateGlyphGeometry(geometry, more, atlas, 24)).toBeNull()
    geometry.dispose()
  })

  it('splits shadow receivers from plain rectangles and returns null for an empty bucket', () => {
    const receiver = createRectGeometry(snapshot, true)
    const plain = createRectGeometry(snapshot, false)
    expect(receiver?.instanceCount).toBe(1)
    expect(plain?.instanceCount).toBe(1)
    expect([...receiver!.getAttribute('sdfRadius').array]).toEqual([12])
    expect([...plain!.getAttribute('sdfZ').array]).toEqual([1])

    const empty = { ...snapshot, rects: [] }
    expect(createRectGeometry(empty, false)).toBeNull()
    receiver?.dispose()
    plain?.dispose()
  })
})
