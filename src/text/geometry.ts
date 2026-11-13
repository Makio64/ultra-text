import { InstancedBufferAttribute, InstancedBufferGeometry } from 'three/webgpu'
import { byte, metaSize, setBounds, setUnitQuad, writeMeta } from './geometryUtils.js'

import type { DomLayoutSnapshot, GlyphLayout, GlyphSlot, SdfAtlas } from '../types.js'

/** Whether a snapshot needs shared animation centres and drawable ordinals. */
export function needsRunMotion(snapshot: DomLayoutSnapshot): boolean {
  return (
    snapshot.textShaping === 'browser' ||
    snapshot.glyphs.some((glyph) => glyph.motionOrigin !== undefined)
  )
}

function shapeOrdinals(snapshot: DomLayoutSnapshot): Float32Array | undefined {
  const glyphs = snapshot.glyphs
  if (!glyphs.some((glyph) => glyph.shapeGroup !== undefined)) return undefined
  const out = new Float32Array(glyphs.length)
  let ordinal = -1,
    previous: number | undefined
  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index]!
    if (glyph.shapeGroup === undefined || glyph.shapeGroup !== previous) ordinal++
    previous = glyph.shapeGroup
    out[index] = glyph.motionOrigin?.[2] ?? ordinal
  }
  return out
}

/**
 * The atlas UV of a glyph's quad, in `sdfUvRect`'s order: (u0, v1, u1, v0), so that the
 * quad's corner 0 samples the first pair and corner 1 the second. Canvas atlases are
 * top-left-origin while Three.js UVs are bottom-left-origin.
 */
function writeUvRect(target: Uint16Array, offset: number, slot: GlyphSlot): void {
  target[offset] = (slot.u0 * 65535 + 0.5) | 0
  target[offset + 1] = (slot.v1 * 65535 + 0.5) | 0
  target[offset + 2] = (slot.u1 * 65535 + 0.5) | 0
  target[offset + 3] = (slot.v0 * 65535 + 0.5) | 0
}

/** Four element stores: V8 inlines this, where `TypedArray.set` from a tuple is ~2x slower per glyph. */
function put4(target: Float32Array, offset: number, source: readonly number[]): void {
  target[offset] = source[0]!
  target[offset + 1] = source[1]!
  target[offset + 2] = source[2]!
  target[offset + 3] = source[3]!
}

const clamp16 = (v: number): number => Math.min(65535, Math.max(0, v))

/**
 * The slot's support box in the same order and units, rounded outwards so the quad only grows;
 * a slot without one repeats its own UV rect, which draws the whole quad.
 */
function writeTrim(target: Uint16Array, offset: number, slot: GlyphSlot, uvRects: Uint16Array) {
  const s = slot.support
  target[offset] = s ? clamp16(Math.floor(s.u0 * 65535)) : uvRects[offset]!
  target[offset + 1] = s ? clamp16(Math.ceil(s.v1 * 65535)) : uvRects[offset + 1]!
  target[offset + 2] = s ? clamp16(Math.ceil(s.u1 * 65535)) : uvRects[offset + 2]!
  target[offset + 3] = s ? clamp16(Math.floor(s.v0 * 65535)) : uvRects[offset + 3]!
}

function writeGlyphRect(
  rects: Float32Array,
  offset: number,
  glyph: GlyphLayout,
  slot: GlyphSlot,
  invBakeSize: number,
  shaped: boolean,
): void {
  const scale = glyph.fontSize * invBakeSize
  const scaleX = shaped && slot.advance > 0 ? glyph.advance / slot.advance : scale
  // Range.getBoundingClientRect() reports the text box, not the line box, so
  // lineBottom already sits on the descender line: adding half the CSS
  // leading back on top of it lifted every glyph off its baseline.
  const baseline = glyph.lineBottom + (glyph.baselineOffset ?? slot.descent * scale)
  rects[offset] = glyph.originX + slot.planeX0 * scaleX
  rects[offset + 1] = baseline + slot.planeY0 * scale
  rects[offset + 2] = glyph.originX + slot.planeX1 * scaleX
  rects[offset + 3] = baseline + slot.planeY1 * scale
}

function writeRunMotion(
  runMotion: Float32Array | null,
  index: number,
  ordinal: number,
  glyph: GlyphLayout,
  rects: Float32Array,
  offset: number,
  motionOrdinals: Float32Array | undefined,
): void {
  if (!runMotion) return
  const rOffset = index * 3
  const origin = glyph.motionOrigin
  runMotion[rOffset] = origin ? origin[0] : (rects[offset]! + rects[offset + 2]!) * 0.5
  runMotion[rOffset + 1] = origin ? origin[1] : (rects[offset + 1]! + rects[offset + 3]!) * 0.5
  runMotion[rOffset + 2] = origin ? origin[2] : (motionOrdinals?.[ordinal] ?? ordinal)
}

function writeGlyphBatch(
  snapshot: DomLayoutSnapshot,
  atlas: SdfAtlas,
  rects: Float32Array,
  clips: Float32Array,
  metadata: Float32Array,
  metaItemSize: number,
  runMotion: Float32Array | null,
  motionOrdinals: Float32Array | undefined,
  uvRects?: Uint16Array,
  trims?: Uint16Array | null,
  colors?: Uint8Array,
  maxCount = Infinity,
): [number, number, number, number] {
  const glyphs = snapshot.glyphs
  const total = glyphs.length
  const shaped = snapshot.textShaping === 'browser'
  const invBakeSize = 1 / atlas.bakeSize
  const atlasGlyphs = atlas.glyphs
  let count = 0
  let maxSequence = 0
  let minZ = 0
  let maxZ = 0
  let prevColor: GlyphLayout['color'] | undefined
  let c0 = 0
  let c1 = 0
  let c2 = 0
  let c3 = 0
  for (let ordinal = 0; ordinal < total; ordinal++) {
    const glyph = glyphs[ordinal]!
    const slot = atlasGlyphs.get(glyph.glyphKey)
    if (!slot) continue
    if (count >= maxCount) return [-1, 0, 0, 0]
    const index = count++
    const offset = index * 4
    writeGlyphRect(rects, offset, glyph, slot, invBakeSize, shaped)
    put4(clips, offset, glyph.clip)
    if (uvRects && colors) {
      writeUvRect(uvRects, offset, slot)
      if (trims) writeTrim(trims, offset, slot, uvRects)
      const color = glyph.color
      if (color !== prevColor) {
        prevColor = color
        c0 = byte(color[0])
        c1 = byte(color[1])
        c2 = byte(color[2])
        c3 = byte(color[3])
      }
      colors[offset] = c0
      colors[offset + 1] = c1
      colors[offset + 2] = c2
      colors[offset + 3] = c3
      writeMeta(metadata, index, metaItemSize, glyph)
    } else {
      metadata[index * metaItemSize] = glyph.sequence
    }
    if (runMotion) writeRunMotion(runMotion, index, ordinal, glyph, rects, offset, motionOrdinals)
    if (glyph.sequence > maxSequence) maxSequence = glyph.sequence
    if (glyph.z < minZ) minZ = glyph.z
    if (glyph.z > maxZ) maxZ = glyph.z
  }
  return [count, maxSequence, minZ, maxZ]
}

const attrOf = <T extends Float32Array | Uint16Array | Uint8Array>(
  geometry: InstancedBufferGeometry,
  name: string,
): (InstancedBufferAttribute & { array: T }) | undefined =>
  geometry.getAttribute(name) as (InstancedBufferAttribute & { array: T }) | undefined

export function createGlyphGeometry(
  snapshot: DomLayoutSnapshot,
  atlas: SdfAtlas,
  motionPadding: number,
  motionOrdinals?: Float32Array,
): { geometry: InstancedBufferGeometry; maxSequence: number } {
  const hasRunMotion = needsRunMotion(snapshot)
  motionOrdinals ??= hasRunMotion ? shapeOrdinals(snapshot) : undefined
  const total = snapshot.glyphs.length
  const rects = new Float32Array(total * 4)
  const uvRects = new Uint16Array(total * 4)
  const clips = new Float32Array(total * 4)
  const colors = new Uint8Array(total * 4)
  const meta = metaSize(snapshot)
  const metadata = new Float32Array(total * meta)
  const runMotion = hasRunMotion || motionOrdinals ? new Float32Array(total * 3) : null
  const trims = runMotion ? null : new Uint16Array(total * 4)
  const [count, maxSequence, minZ, maxZ] = writeGlyphBatch(
    snapshot,
    atlas,
    rects,
    clips,
    metadata,
    meta,
    runMotion,
    motionOrdinals,
    uvRects,
    trims,
    colors,
  )

  const geometry = new InstancedBufferGeometry()
  geometry.name = 'ultra-text instanced glyph quads'
  setUnitQuad(geometry)
  for (const [name, array, size, normalized] of [
    ['sdfRect', rects, 4, false],
    ['sdfUvRect', uvRects, 4, true],
    ['sdfClip', clips, 4, false],
    ['sdfColor', colors, 4, true],
    ['sdfMeta', metadata, meta, false],
    ['sdfRunMotion', runMotion, 3, false],
    ['sdfTrim', trims, 4, true],
  ] as const) {
    if (array)
      geometry.setAttribute(
        name,
        new InstancedBufferAttribute(
          count === total ? array : array.subarray(0, count * size),
          size,
          normalized,
        ),
      )
  }
  geometry.instanceCount = count
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, minZ, maxZ)
  return { geometry, maxSequence }
}

export function updateGlyphGeometry(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  atlas: SdfAtlas,
  motionPadding: number,
  motionOrdinals?: Float32Array,
): number | null {
  const instanceCount = geometry.instanceCount
  if (snapshot.glyphs.length < instanceCount) return null
  const rectAttribute = attrOf<Float32Array>(geometry, 'sdfRect')
  const clipAttribute = attrOf<Float32Array>(geometry, 'sdfClip')
  const metaAttribute = attrOf<Float32Array>(geometry, 'sdfMeta')
  if (!rectAttribute || !clipAttribute || !metaAttribute) return null
  motionOrdinals ??= needsRunMotion(snapshot) ? shapeOrdinals(snapshot) : undefined
  const runAttribute = attrOf<Float32Array>(geometry, 'sdfRunMotion')
  const [count, maxSequence, minZ, maxZ] = writeGlyphBatch(
    snapshot,
    atlas,
    rectAttribute.array,
    clipAttribute.array,
    metaAttribute.array,
    metaAttribute.itemSize,
    runAttribute ? runAttribute.array : null,
    motionOrdinals,
    undefined,
    undefined,
    undefined,
    instanceCount,
  )
  if (count !== instanceCount) return null

  rectAttribute.needsUpdate = true
  clipAttribute.needsUpdate = true
  metaAttribute.needsUpdate = true
  if (runAttribute) runAttribute.needsUpdate = true
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, minZ, maxZ)
  return maxSequence
}

function drawableGlyphCountMatches(
  snapshot: DomLayoutSnapshot,
  atlas: SdfAtlas,
  expectedCount: number,
): boolean {
  let count = 0
  for (const glyph of snapshot.glyphs) {
    if (atlas.glyphs.has(glyph.glyphKey) && ++count > expectedCount) return false
  }
  return count === expectedCount
}

function instanceAttribute(
  geometry: InstancedBufferGeometry,
  name: string,
  itemSize: number,
): boolean {
  const attribute = attrOf(geometry, name)
  return attribute?.itemSize === itemSize && attribute.count === geometry.instanceCount
}

export function glyphContentFits(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  atlas: SdfAtlas,
  motionOrdinals?: Float32Array,
): boolean {
  const instanceCount = geometry.instanceCount
  if (snapshot.glyphs.length < instanceCount) return false
  for (const name of ['sdfRect', 'sdfUvRect', 'sdfClip', 'sdfColor']) {
    if (!instanceAttribute(geometry, name, 4)) return false
  }
  if (!instanceAttribute(geometry, 'sdfMeta', metaSize(snapshot))) return false
  const run = attrOf(geometry, 'sdfRunMotion')
  const wantsRun = needsRunMotion(snapshot) || !!motionOrdinals
  const trim = attrOf(geometry, 'sdfTrim')
  const layoutFits = wantsRun
    ? run?.itemSize === 3 && run.count === instanceCount && trim === undefined
    : run === undefined && (trim === undefined || instanceAttribute(geometry, 'sdfTrim', 4))
  return layoutFits && drawableGlyphCountMatches(snapshot, atlas, instanceCount)
}

export function updateGlyphContent(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  atlas: SdfAtlas,
  motionPadding: number,
  motionOrdinals?: Float32Array,
  checked?: boolean,
): number | null {
  motionOrdinals ??= needsRunMotion(snapshot) ? shapeOrdinals(snapshot) : undefined
  if (!checked && !glyphContentFits(geometry, snapshot, atlas, motionOrdinals)) return null
  const trimAttribute = attrOf<Uint16Array>(geometry, 'sdfTrim')
  const metaAttribute = attrOf<Float32Array>(geometry, 'sdfMeta')!
  const runAttribute = attrOf<Float32Array>(geometry, 'sdfRunMotion')
  const [, maxSequence, minZ, maxZ] = writeGlyphBatch(
    snapshot,
    atlas,
    attrOf<Float32Array>(geometry, 'sdfRect')!.array,
    attrOf<Float32Array>(geometry, 'sdfClip')!.array,
    metaAttribute.array,
    metaAttribute.itemSize,
    runAttribute ? runAttribute.array : null,
    motionOrdinals,
    attrOf<Uint16Array>(geometry, 'sdfUvRect')!.array,
    trimAttribute ? trimAttribute.array : null,
    attrOf<Uint8Array>(geometry, 'sdfColor')!.array,
  )
  for (const name of ['sdfRect', 'sdfUvRect', 'sdfClip', 'sdfColor', 'sdfMeta']) {
    attrOf(geometry, name)!.needsUpdate = true
  }
  if (trimAttribute) trimAttribute.needsUpdate = true
  if (runAttribute) runAttribute.needsUpdate = true
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, minZ, maxZ)
  return maxSequence
}

function rectCountFor(snapshot: DomLayoutSnapshot, receiveShadow: boolean): number {
  let count = 0
  for (const rect of snapshot.rects) if (rect.receiveShadow === receiveShadow) count++
  return count
}

function writeRectBatch(
  snapshot: DomLayoutSnapshot,
  receiveShadow: boolean,
  rects: Float32Array,
  colors: Uint8Array,
  radii: Float32Array,
  depths: Float32Array,
): [number, number] {
  let index = 0
  let minZ = 0
  let maxZ = 0
  for (const item of snapshot.rects) {
    if (item.receiveShadow !== receiveShadow) continue
    const offset = index * 4
    put4(rects, offset, item.rect)
    colors[offset] = byte(item.color[0])
    colors[offset + 1] = byte(item.color[1])
    colors[offset + 2] = byte(item.color[2])
    colors[offset + 3] = byte(item.color[3])
    radii[index] = item.radius
    depths[index] = item.z
    if (item.z < minZ) minZ = item.z
    if (item.z > maxZ) maxZ = item.z
    index++
  }
  return [minZ, maxZ]
}

/** True when a rectangle batch has the same instance count and attribute layout. */
export function rectContentFits(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  receiveShadow: boolean,
): boolean {
  if (snapshot.rects.length < geometry.instanceCount) return false
  if (
    !instanceAttribute(geometry, 'sdfRect', 4) ||
    !instanceAttribute(geometry, 'sdfColor', 4) ||
    !instanceAttribute(geometry, 'sdfRadius', 1) ||
    !instanceAttribute(geometry, 'sdfZ', 1)
  ) {
    return false
  }
  return rectCountFor(snapshot, receiveShadow) === geometry.instanceCount
}

/** Rewrites a same-count rectangle batch. Returns false without writing when it does not fit. */
export function updateRectGeometry(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  receiveShadow: boolean,
): boolean {
  if (!rectContentFits(geometry, snapshot, receiveShadow)) return false
  const [minZ, maxZ] = writeRectBatch(
    snapshot,
    receiveShadow,
    attrOf<Float32Array>(geometry, 'sdfRect')!.array,
    attrOf<Uint8Array>(geometry, 'sdfColor')!.array,
    attrOf<Float32Array>(geometry, 'sdfRadius')!.array,
    attrOf<Float32Array>(geometry, 'sdfZ')!.array,
  )
  for (const name of ['sdfRect', 'sdfColor', 'sdfRadius', 'sdfZ']) {
    attrOf(geometry, name)!.needsUpdate = true
  }
  setBounds(geometry, snapshot.width, snapshot.height, 0, minZ, maxZ)
  return true
}

/**
 * Builds one instanced rectangle batch for a shadow-receiver state: pass
 * `receiveShadow: true` for the lit batch, `false` for the plain one.
 * Returns null when the snapshot has no rectangles in that bucket — callers
 * must handle the empty case instead of creating a zero-instance mesh.
 */
export function createRectGeometry(
  snapshot: DomLayoutSnapshot,
  receiveShadow: boolean,
): InstancedBufferGeometry | null {
  const count = rectCountFor(snapshot, receiveShadow)
  if (count === 0) return null
  const rects = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)
  const radii = new Float32Array(count)
  const depths = new Float32Array(count)
  const [minZ, maxZ] = writeRectBatch(snapshot, receiveShadow, rects, colors, radii, depths)

  const geometry = new InstancedBufferGeometry()
  geometry.name = receiveShadow
    ? 'ultra-text instanced shadow-receiving DOM rects'
    : 'ultra-text instanced DOM rects'
  setUnitQuad(geometry)
  for (const [name, array, size, normalized] of [
    ['sdfRect', rects, 4, false],
    ['sdfColor', colors, 4, true],
    ['sdfRadius', radii, 1, false],
    ['sdfZ', depths, 1, false],
  ] as const) {
    geometry.setAttribute(name, new InstancedBufferAttribute(array, size, normalized))
  }
  geometry.instanceCount = count
  setBounds(geometry, snapshot.width, snapshot.height, 0, minZ, maxZ)
  return geometry
}
