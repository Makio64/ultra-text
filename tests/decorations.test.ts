import { InstancedBufferAttribute, InstancedBufferGeometry } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import {
  createDecorationGeometry,
  TextDecorationMaterial,
  updateDecorationGeometry,
} from '../src/text/decorations.js'
import { reflowSnapshot } from '../src/text/reflow.js'
import type { DomLayoutSnapshot, GlyphLayout, TextDecorationLayout } from '../src/types.js'

const decoration: TextDecorationLayout = {
  line: 'underline',
  color: [1, 0, 0, 1],
  thickness: 2,
  offset: 3,
}
const glyph: GlyphLayout = {
  glyphKey: 'A',
  fontSize: 20,
  originX: 0,
  lineBottom: 30,
  advance: 20,
  block: 0,
  breakBefore: 'soft',
  clip: [0, 0, 80, 60],
  color: [1, 1, 1, 1],
  sequence: 0,
  z: 1,
  decorations: [decoration],
  decorationWidth: 15,
}
const snapshot: DomLayoutSnapshot = {
  glyphs: [glyph, { ...glyph, originX: 30, sequence: 1 }],
  width: 80,
  height: 60,
  rects: [],
  requests: [],
  atlasSignature: '',
  lineCount: 1,
  blocks: [{ left: 0, firstBaseline: 30, linePitch: 24, width: 80, clip: [0, 0, 80, 60] }],
}
function sourceGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute(
    'sdfRect',
    new InstancedBufferAttribute(new Float32Array([0, 20, 20, 40, 30, 20, 50, 40]), 4),
  )
  return geometry
}

describe('solid decoration geometry', () => {
  it('fills shared inter-word gaps without extending the trailing decoration', () => {
    const source = sourceGeometry()
    const geometry = createDecorationGeometry(snapshot, source, () => true, 18)!
    expect([...geometry.getAttribute('decorationRect').array]).toEqual([
      0, 32, 30, 34, 30, 32, 45, 34,
    ])
    expect([...geometry.getAttribute('sdfRect').array]).toEqual([
      ...source.getAttribute('sdfRect').array,
    ])
    expect([...geometry.getAttribute('decorationIndex').array]).toEqual([0, 1])
    expect([...geometry.getAttribute('sdfColor').array]).toEqual([255, 0, 0, 255, 255, 0, 0, 255])
    geometry.dispose()
    source.dispose()
  })

  it('keeps decoration motion aligned after a grouped SVG and a fallback glyph', () => {
    const group = {
      ...glyph,
      glyphKey: 'shape',
      shapeGroup: 4,
      motionOrigin: [10, 10, 0] as const,
      decorations: [],
    }
    const layout = {
      ...snapshot,
      glyphs: [
        { ...glyph, glyphKey: 'blank', decorations: [] },
        group,
        { ...group },
        { ...glyph, glyphKey: 'fallback', decorations: [] },
        { ...glyph, glyphKey: 'text' },
      ],
    }
    const source = sourceGeometry()
    const rects = new Float32Array([0, 0, 20, 20, 0, 0, 20, 20, 20, 0, 40, 20, 40, 0, 60, 20])
    source.userData['ultraGlyphRects'] = rects
    const result = createDecorationGeometry(layout, source, (key) => key !== 'blank', 0)!
    expect(Array.from(result.getAttribute('decorationIndex').array)).toEqual([2])
    expect(Array.from(result.getAttribute('sdfRect').array)).toEqual([40, 0, 60, 20])
    rects.set([45, 0, 65, 20], 12)
    expect(updateDecorationGeometry(result, layout, source, (key) => key !== 'blank', 0)).toBe(true)
    expect(Array.from(result.getAttribute('decorationIndex').array)).toEqual([2])
    expect(Array.from(result.getAttribute('sdfRect').array)).toEqual([45, 0, 65, 20])
    result.dispose()
    source.dispose()
  })

  it('moves the decorations to the new baselines after retained reflow', () => {
    const reflowed = reflowSnapshot(snapshot, 25)
    const source = sourceGeometry()
    const geometry = createDecorationGeometry(reflowed, source, () => true, 18)!
    const rects = [...geometry.getAttribute('decorationRect').array]
    expect(reflowed.lineCount).toBe(2)
    expect(rects[1]! - rects[5]!).toBe(24)
    expect(rects[2]! - rects[0]!).toBe(15)
    expect(rects[6]! - rects[4]!).toBe(15)
    expect(reflowed.glyphs[0]!.decorations).toBe(glyph.decorations)
    geometry.dispose()
    source.dispose()
  })

  it('rewrites a same-count decoration batch in place', () => {
    const source = sourceGeometry()
    const geometry = createDecorationGeometry(snapshot, source, () => true, 18)!
    const moved: DomLayoutSnapshot = {
      ...snapshot,
      glyphs: snapshot.glyphs.map((item) => ({ ...item, originX: item.originX + 5 })),
    }
    const movedSource = sourceGeometry()
    movedSource.getAttribute('sdfRect').setXYZW(0, 5, 20, 25, 40)
    expect(updateDecorationGeometry(geometry, moved, movedSource, () => true, 18)).toBe(true)
    const fresh = createDecorationGeometry(moved, movedSource, () => true, 18)!
    expect([...geometry.getAttribute('decorationRect').array]).toEqual([
      ...fresh.getAttribute('decorationRect').array,
    ])
    expect([...geometry.getAttribute('sdfRect').array]).toEqual([
      ...fresh.getAttribute('sdfRect').array,
    ])
    expect(
      updateDecorationGeometry(geometry, { ...moved, glyphs: [] }, movedSource, () => true, 18),
    ).toBe(false)
    fresh.dispose()
    geometry.dispose()
    source.dispose()
    movedSource.dispose()
  })

  it('omits invisible, absent, and non-drawable decorations', () => {
    const source = sourceGeometry()
    expect(createDecorationGeometry(snapshot, source, () => false, 18)).toBeNull()
    expect(createDecorationGeometry({ ...snapshot, glyphs: [] }, source, () => true, 18)).toBeNull()
    for (const change of [{ thickness: 0 }, { color: [1, 0, 0, 0] as const }]) {
      expect(
        createDecorationGeometry(
          { ...snapshot, glyphs: [{ ...glyph, decorations: [{ ...decoration, ...change }] }] },
          source,
          () => true,
          18,
        ),
      ).toBeNull()
    }
    const material = new TextDecorationMaterial({ motion: { mode: 'scale' } })
    const clone = material.clone()
    expect(clone.positionNode).not.toBe(material.positionNode)
    expect(clone.maskShadowNode).toBeTruthy()
    clone.dispose()
    material.dispose()
    source.dispose()
  })
})
