import { InstancedBufferAttribute, InstancedBufferGeometry } from 'three/webgpu'
import { byte, setBounds, setUnitQuad } from '../text/geometryUtils.js'
import type { DomLayoutSnapshot, WindfoilBoundingBox } from '../types.js'
/** The snapshot fields composite geometry reads; shape handles pass instance layouts. */
export type WindfoilCompositeLayout = Pick<DomLayoutSnapshot, 'glyphs' | 'width' | 'height'>
import type { WindfoilGlyphHeader } from './preprocess.js'
export interface WindfoilCompositeHeader extends WindfoilGlyphHeader {
  readonly layerStart: number
  readonly layerCount: number
}
const ATTRIBUTES = [
  ['sdfRect', 4],
  ['sdfClip', 4],
  ['sdfColor', 4],
  ['sdfMeta', 2],
  ['windfoilBounds', 4],
  ['windfoilLayers', 3],
] as const
/** Ink bounds after the optional outline clip; the composite quad and cell grid span it. */
export function windfoilCompositeBox(header: WindfoilGlyphHeader): WindfoilBoundingBox {
  const box = header.bbox,
    clip = header.clipBox
  return clip
    ? [
        Math.max(box[0], clip[0]),
        Math.max(box[1], clip[1]),
        Math.min(box[2], clip[2]),
        Math.min(box[3], clip[3]),
      ]
    : box
}
function drawable(header: WindfoilGlyphHeader | undefined): header is WindfoilGlyphHeader {
  if (!header?.monotonePieceCount) return false
  const box = header.bbox,
    clip = header.clipBox
  if (!clip) return box[0] < box[2] && box[1] < box[3]
  return (
    Math.max(box[0], clip[0]) < Math.min(box[2], clip[2]) &&
    Math.max(box[1], clip[1]) < Math.min(box[3], clip[3])
  )
}
let cachedSnapshot: WindfoilCompositeLayout | null = null
let cachedGlyphs: ReadonlyMap<string, WindfoilCompositeHeader> | null = null
let scratchHeaders = new Array<WindfoilCompositeHeader | undefined>(256)

function countInstances(
  snapshot: WindfoilCompositeLayout,
  glyphs: ReadonlyMap<string, WindfoilCompositeHeader>,
): number {
  const list = snapshot.glyphs
  const len = list.length
  if (scratchHeaders.length < len)
    scratchHeaders = new Array<WindfoilCompositeHeader | undefined>(len)
  const headers = scratchHeaders
  let count = 0
  for (let i = 0; i < len; i++) {
    const h = glyphs.get(list[i]!.glyphKey)
    if (drawable(h)) {
      headers[i] = h
      count++
    } else {
      headers[i] = undefined
    }
  }
  cachedSnapshot = snapshot
  cachedGlyphs = glyphs
  return count
}
export function windfoilCompositeContentFits(
  geometry: InstancedBufferGeometry,
  snapshot: WindfoilCompositeLayout,
  glyphs: ReadonlyMap<string, WindfoilCompositeHeader>,
): boolean {
  return countInstances(snapshot, glyphs) === geometry.instanceCount
}
function writeWindfoilCompositeGeometry(
  geometry: InstancedBufferGeometry,
  snapshot: WindfoilCompositeLayout,
  glyphs: ReadonlyMap<string, WindfoilCompositeHeader>,
  padding: number,
  ordinals?: Float32Array,
): number {
  if (cachedSnapshot !== snapshot || cachedGlyphs !== glyphs) {
    countInstances(snapshot, glyphs)
  }
  cachedSnapshot = null
  cachedGlyphs = null
  const headers = scratchHeaders
  let count = 0,
    maxSequence = 0,
    minZ = 0,
    maxZ = 0
  const rectAttribute = geometry.getAttribute('sdfRect') as InstancedBufferAttribute,
    clipAttribute = geometry.getAttribute('sdfClip') as InstancedBufferAttribute,
    colorAttribute = geometry.getAttribute('sdfColor') as InstancedBufferAttribute,
    metaAttribute = geometry.getAttribute('sdfMeta') as InstancedBufferAttribute,
    boundsAttribute = geometry.getAttribute('windfoilBounds') as InstancedBufferAttribute,
    layersAttribute = geometry.getAttribute('windfoilLayers') as InstancedBufferAttribute
  const rects = rectAttribute.array as Float32Array,
    clips = clipAttribute.array as Float32Array,
    colors = colorAttribute.array as Uint8Array,
    metadata = metaAttribute.array as Float32Array,
    bounds = boundsAttribute.array as Float32Array,
    layers = layersAttribute.array as Float32Array
  const list = snapshot.glyphs
  for (let index = 0, len = list.length; index < len; index++) {
    const header = headers[index]
    if (!header) continue
    const glyph = list[index]!
    const rawBox = header.bbox,
      clipBox = header.clipBox
    const b0 = clipBox ? Math.max(rawBox[0], clipBox[0]) : rawBox[0],
      b1 = clipBox ? Math.max(rawBox[1], clipBox[1]) : rawBox[1],
      b2 = clipBox ? Math.min(rawBox[2], clipBox[2]) : rawBox[2],
      b3 = clipBox ? Math.min(rawBox[3], clipBox[3]) : rawBox[3]
    const scale = glyph.fontSize / header.unitsPerEm,
      baseline = glyph.lineBottom + (glyph.baselineOffset ?? -header.descent * scale),
      ox = glyph.originX
    const offset = count * 4
    rects[offset] = ox + b0 * scale
    rects[offset + 1] = baseline + b1 * scale
    rects[offset + 2] = ox + b2 * scale
    rects[offset + 3] = baseline + b3 * scale
    const clip = glyph.clip
    clips[offset] = clip[0]
    clips[offset + 1] = clip[1]
    clips[offset + 2] = clip[2]
    clips[offset + 3] = clip[3]
    const color = glyph.color
    colors[offset] = byte(color[0])
    colors[offset + 1] = byte(color[1])
    colors[offset + 2] = byte(color[2])
    colors[offset + 3] = byte(color[3])
    const metaOffset = count * 2,
      seq = glyph.sequence,
      z = glyph.z
    metadata[metaOffset] = seq
    metadata[metaOffset + 1] = z
    bounds[offset] = b0
    bounds[offset + 1] = b1
    bounds[offset + 2] = b2
    bounds[offset + 3] = b3
    const layerOffset = count * 3
    layers[layerOffset] = header.layerStart
    layers[layerOffset + 1] = clipBox ? -header.layerCount : header.layerCount
    layers[layerOffset + 2] = ordinals ? ordinals[index]! : (glyph.motionOrigin?.[2] ?? count)
    count++
    if (seq > maxSequence) maxSequence = seq
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (headers.length > 16384) scratchHeaders = new Array<WindfoilCompositeHeader | undefined>(256)
  if (count) {
    rectAttribute.needsUpdate = true
    clipAttribute.needsUpdate = true
    colorAttribute.needsUpdate = true
    metaAttribute.needsUpdate = true
    boundsAttribute.needsUpdate = true
    layersAttribute.needsUpdate = true
  }
  ;(geometry.userData['ultraGlyphRects'] as Float32Array).set(rects)
  setBounds(geometry, snapshot.width, snapshot.height, padding, minZ, maxZ)
  return maxSequence
}
export function updateWindfoilCompositeGeometry(
  geometry: InstancedBufferGeometry,
  snapshot: WindfoilCompositeLayout,
  glyphs: ReadonlyMap<string, WindfoilCompositeHeader>,
  padding: number,
  ordinals?: Float32Array,
): number | null {
  if (!windfoilCompositeContentFits(geometry, snapshot, glyphs)) return null
  return writeWindfoilCompositeGeometry(geometry, snapshot, glyphs, padding, ordinals)
}
/** One quad per colour glyph. Clip boxes become analytic quad bounds. */
export function createWindfoilCompositeGeometry(
  snapshot: WindfoilCompositeLayout,
  glyphs: ReadonlyMap<string, WindfoilCompositeHeader>,
  padding: number,
  ordinals?: Float32Array,
): { geometry: InstancedBufferGeometry; maxSequence: number } {
  const geometry = new InstancedBufferGeometry(),
    count = countInstances(snapshot, glyphs)
  setUnitQuad(geometry)
  geometry.instanceCount = count
  geometry.name = 'ultra-text Windfoil colour glyph quads'
  for (const [name, size] of ATTRIBUTES)
    geometry.setAttribute(
      name,
      new InstancedBufferAttribute(
        name === 'sdfColor' ? new Uint8Array(count * size) : new Float32Array(count * size),
        size,
        name === 'sdfColor',
      ),
    )
  geometry.userData['ultraGlyphRects'] = new Float32Array(count * 4)
  return {
    geometry,
    maxSequence: writeWindfoilCompositeGeometry(geometry, snapshot, glyphs, padding, ordinals),
  }
}
