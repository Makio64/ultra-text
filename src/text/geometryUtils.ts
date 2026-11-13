import {
  Box3,
  Float32BufferAttribute,
  type InstancedBufferGeometry,
  Sphere,
  Uint16BufferAttribute,
} from 'three/webgpu'

import type { DomLayoutSnapshot, GlyphLayout } from '../types.js'

const UNIT_QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
const UNIT_QUAD_NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])

// No `uv`: every graph here derives its own texture coordinates from the
// instanced rect attributes, so the unit quad only needs position and the
// normal that the lit shadow receiver samples with.
export function setUnitQuad(geometry: InstancedBufferGeometry): void {
  geometry.setAttribute('position', new Float32BufferAttribute(UNIT_QUAD_POSITIONS, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(UNIT_QUAD_NORMALS, 3))
  geometry.setIndex(new Uint16BufferAttribute(UNIT_QUAD_INDICES, 1))
}

export function byte(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 255 : (value * 255 + 0.5) | 0
}

/**
 * `sdfMeta` gains a third component, the switch em, only on size-switch layouts. A switched
 * layout keeps it even when empty: retained materials read three components, and a pipeline
 * built over a two-wide empty batch would outlive the batch it is later updated with.
 */
export function metaSize(snapshot: DomLayoutSnapshot): 2 | 3 {
  return snapshot.sizeSwitched || snapshot.glyphs.some((glyph) => glyph.switchEm !== undefined)
    ? 3
    : 2
}

export function writeMeta(
  target: Float32Array,
  index: number,
  size: number,
  glyph: GlyphLayout,
): void {
  const o = index * size
  target[o] = glyph.sequence
  target[o + 1] = glyph.z
  if (size === 3) target[o + 2] = glyph.switchEm ?? 0
}

export function setBounds(
  geometry: InstancedBufferGeometry,
  width: number,
  height: number,
  padding: number,
  minZ: number,
  maxZ: number,
): void {
  const box = (geometry.boundingBox ??= new Box3())
  box.min.set(-padding, -padding, minZ - padding)
  box.max.set(width + padding, height + padding, maxZ + padding)
  box.getBoundingSphere((geometry.boundingSphere ??= new Sphere()))
}
