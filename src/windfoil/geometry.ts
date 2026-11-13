import { InstancedBufferAttribute, InstancedBufferGeometry } from 'three/webgpu'
import { byte, metaSize, setBounds, setUnitQuad, writeMeta } from '../text/geometryUtils.js'
import { GLYPH_RECTS_KEY } from '../text/decorations.js'
import type { DomLayoutSnapshot, GlyphLayout, WindfoilBoundingBox } from '../types.js'
import type { WindfoilGlyphHeader, WindfoilLayerHeader } from './preprocess.js'

const ATTRIBUTES = [
  'sdfRect',
  'sdfClip',
  'sdfColor',
  'sdfMeta',
  'windfoilBounds',
  'windfoilBand',
] as const
const LAYERED_ATTRIBUTES = [...ATTRIBUTES, 'windfoilLayer'] as const

export interface MutableWindfoilAttributes {
  readonly rects: Float32Array
  readonly clips: Float32Array
  readonly colors: Uint8Array
  readonly metadata: Float32Array
  /** Components per `sdfMeta` entry; `3` carries the size-switch em. Defaults to `2`. */
  readonly metaSize?: number
  readonly bounds: Float32Array
  readonly bands: Float32Array
  readonly layers?: Float32Array
  readonly glyphRects?: Float32Array
}

const scratchRect: [number, number, number, number] = [0, 0, 0, 0]

export function fillWindfoilGlyphRect(
  glyph: GlyphLayout,
  header: WindfoilGlyphHeader,
  bbox: WindfoilBoundingBox = header.bbox,
  out: [number, number, number, number] = scratchRect,
): [number, number, number, number] {
  const scale = glyph.fontSize / header.unitsPerEm
  const baseline = glyph.lineBottom + (glyph.baselineOffset ?? -header.descent * scale)
  out[0] = glyph.originX + bbox[0] * scale
  out[1] = baseline + bbox[1] * scale
  out[2] = glyph.originX + bbox[2] * scale
  out[3] = baseline + bbox[3] * scale
  return out
}

export function windfoilGlyphRect(
  glyph: GlyphLayout,
  header: WindfoilGlyphHeader,
  bbox: WindfoilBoundingBox = header.bbox,
): readonly [number, number, number, number] {
  return fillWindfoilGlyphRect(glyph, header, bbox, [0, 0, 0, 0])
}

/** Shared by text and shape geometry; one layer adds only one vertex attribute. */
export function writeLayerInstance(
  glyph: GlyphLayout,
  header: WindfoilGlyphHeader,
  layer: WindfoilGlyphHeader | WindfoilLayerHeader,
  index: number,
  ordinal: number,
  attributes: MutableWindfoilAttributes,
  glyphRect?: readonly [number, number, number, number],
): void {
  const offset = index * 4
  const scale = glyph.fontSize / header.unitsPerEm
  const baseline = glyph.lineBottom + (glyph.baselineOffset ?? -header.descent * scale)
  const ox = glyph.originX
  const lBox = layer.bbox
  const b0 = lBox[0],
    b1 = lBox[1],
    b2 = lBox[2],
    b3 = lBox[3]
  const rects = attributes.rects
  rects[offset] = ox + b0 * scale
  rects[offset + 1] = baseline + b1 * scale
  rects[offset + 2] = ox + b2 * scale
  rects[offset + 3] = baseline + b3 * scale
  const clips = attributes.clips,
    clip = glyph.clip
  clips[offset] = clip[0]
  clips[offset + 1] = clip[1]
  clips[offset + 2] = clip[2]
  clips[offset + 3] = clip[3]
  const paint = 'paintKind' in layer ? layer : null
  const rgb = paint?.paintKind === 1 ? paint.rgba : glyph.color
  const colors = attributes.colors
  colors[offset] = byte(rgb[0])
  colors[offset + 1] = byte(rgb[1])
  colors[offset + 2] = byte(rgb[2])
  colors[offset + 3] = byte(glyph.color[3] * (paint ? paint.rgba[3] : 1))
  writeMeta(attributes.metadata, index, attributes.metaSize ?? 2, glyph)
  const bounds = attributes.bounds
  bounds[offset] = b0
  bounds[offset + 1] = b1
  bounds[offset + 2] = b2
  bounds[offset + 3] = b3
  const bands = attributes.bands
  bands[offset] = layer.rowBase
  bands[offset + 1] = layer.bandCount
  bands[offset + 2] = layer.bandH
  bands[offset + 3] = layer.invH
  const layers = attributes.layers
  if (layers) {
    const rect = glyphRect ?? fillWindfoilGlyphRect(glyph, header, header.bbox, scratchRect)
    const mo = glyph.motionOrigin
    layers[offset] = mo ? mo[0] : (rect[0] + rect[2]) / 2
    layers[offset + 1] = mo ? mo[1] : (rect[1] + rect[3]) / 2
    layers[offset + 2] = ordinal
    layers[offset + 3] =
      paint?.paintKind === 2 ? 2 + (paint.paintIndex ?? 0) : (paint?.paintKind ?? 0)
  }
}

function countLayout(
  snapshot: DomLayoutSnapshot,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
  layered: boolean,
): { instances: number; drawable: number } {
  let instances = 0,
    drawable = 0
  for (const glyph of snapshot.glyphs) {
    const header = glyphs.get(glyph.glyphKey)
    if (header?.monotonePieceCount) {
      drawable++
      instances += layered ? (header.layers?.length ?? 1) : 1
    }
  }
  return { instances, drawable }
}

function writeGeometry(
  snapshot: DomLayoutSnapshot,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
  attributes: MutableWindfoilAttributes,
  ordinals?: Float32Array,
): { maxSequence: number; minZ: number; maxZ: number } {
  let instance = 0,
    drawable = 0,
    maxSequence = 0,
    minZ = 0,
    maxZ = 0
  const glyphList = snapshot.glyphs
  for (let i = 0; i < glyphList.length; i++) {
    const glyph = glyphList[i]!
    const header = glyphs.get(glyph.glyphKey)
    if (!header?.monotonePieceCount) continue
    const ordinal = ordinals?.[i] ?? glyph.motionOrigin?.[2] ?? drawable
    const rect =
      attributes.layers || attributes.glyphRects
        ? fillWindfoilGlyphRect(glyph, header, header.bbox, scratchRect)
        : undefined
    if (attributes.glyphRects && rect) {
      const rectOffset = drawable * 4
      attributes.glyphRects[rectOffset] = rect[0]
      attributes.glyphRects[rectOffset + 1] = rect[1]
      attributes.glyphRects[rectOffset + 2] = rect[2]
      attributes.glyphRects[rectOffset + 3] = rect[3]
    }
    if (attributes.layers && header.layers) {
      for (const layer of header.layers) {
        writeLayerInstance(glyph, header, layer, instance++, ordinal, attributes, rect)
      }
    } else {
      writeLayerInstance(
        glyph,
        header,
        header.layers?.[0] ?? header,
        instance++,
        ordinal,
        attributes,
        rect,
      )
    }
    drawable++
    if (glyph.sequence > maxSequence) maxSequence = glyph.sequence
    if (glyph.z < minZ) minZ = glyph.z
    if (glyph.z > maxZ) maxZ = glyph.z
  }
  return { maxSequence, minZ, maxZ }
}

/** Ordinary outlines retain the original six instance attributes. */
export function createWindfoilGlyphGeometry(
  snapshot: DomLayoutSnapshot,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
  motionPadding: number,
  layered = false,
  ordinals?: Float32Array,
): { geometry: InstancedBufferGeometry; maxSequence: number } {
  layered ||= !!ordinals || snapshot.glyphs.some((glyph) => !!glyph.motionOrigin)
  const { instances: count, drawable } = countLayout(snapshot, glyphs, layered)
  const meta = metaSize(snapshot)
  const mutable: MutableWindfoilAttributes = {
    rects: new Float32Array(count * 4),
    clips: new Float32Array(count * 4),
    colors: new Uint8Array(count * 4),
    metadata: new Float32Array(count * meta),
    metaSize: meta,
    bounds: new Float32Array(count * 4),
    bands: new Float32Array(count * 4),
    ...(layered
      ? {
          layers: new Float32Array(count * 4),
          glyphRects: new Float32Array(drawable * 4),
        }
      : {}),
  }
  const result = writeGeometry(snapshot, glyphs, mutable, ordinals)
  const geometry = new InstancedBufferGeometry()
  geometry.name = 'ultra-text instanced Windfoil glyph quads'
  setUnitQuad(geometry)
  for (const [name, data, size, normalized] of [
    ['sdfRect', mutable.rects, 4, false],
    ['sdfClip', mutable.clips, 4, false],
    ['sdfColor', mutable.colors, 4, true],
    ['sdfMeta', mutable.metadata, meta, false],
    ['windfoilBounds', mutable.bounds, 4, false],
    ['windfoilBand', mutable.bands, 4, false],
  ] as const)
    geometry.setAttribute(name, new InstancedBufferAttribute(data, size, normalized))
  if (mutable.layers) {
    geometry.setAttribute('windfoilLayer', new InstancedBufferAttribute(mutable.layers, 4))
    geometry.userData[GLYPH_RECTS_KEY] = mutable.glyphRects
    geometry.userData['ultraOwnGlyphRects'] = mutable.glyphRects
  }
  geometry.instanceCount = count
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, result.minZ, result.maxZ)
  return { geometry, maxSequence: result.maxSequence }
}

export function windfoilContentFits(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
): boolean {
  const layered =
    (geometry.getAttribute('windfoilLayer') as InstancedBufferAttribute | undefined) !== undefined
  const names = layered ? LAYERED_ATTRIBUTES : ATTRIBUTES
  for (const name of names) {
    if (
      (geometry.getAttribute(name) as InstancedBufferAttribute | undefined)?.count !==
      geometry.instanceCount
    )
      return false
  }
  if (
    (geometry.getAttribute('sdfMeta') as InstancedBufferAttribute).itemSize !== metaSize(snapshot)
  )
    return false
  let instances = 0,
    drawable = 0
  for (const glyph of snapshot.glyphs) {
    const header = glyphs.get(glyph.glyphKey)
    const layers = header?.layers?.length ?? 1
    if (!layered && (glyph.motionOrigin || layers > 1)) return false
    if (header?.monotonePieceCount) {
      drawable++
      instances += layered ? layers : 1
    }
  }
  return (
    instances === geometry.instanceCount &&
    (!layered ||
      (geometry.userData['ultraOwnGlyphRects'] as Float32Array | undefined)?.length ===
        drawable * 4)
  )
}

export function updateWindfoilGlyphGeometry(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
  motionPadding: number,
  ordinals?: Float32Array,
): number | null {
  if (!windfoilContentFits(geometry, snapshot, glyphs)) return null
  const array = (name: string): Float32Array => geometry.getAttribute(name).array as Float32Array
  const layer = geometry.getAttribute('windfoilLayer') as InstancedBufferAttribute | undefined
  const result = writeGeometry(
    snapshot,
    glyphs,
    {
      rects: array('sdfRect'),
      clips: array('sdfClip'),
      colors: geometry.getAttribute('sdfColor').array as Uint8Array,
      metadata: array('sdfMeta'),
      metaSize: geometry.getAttribute('sdfMeta').itemSize,
      bounds: array('windfoilBounds'),
      bands: array('windfoilBand'),
      ...(layer
        ? {
            layers: layer.array as Float32Array,
            glyphRects: geometry.userData['ultraOwnGlyphRects'] as Float32Array,
          }
        : {}),
    },
    ordinals,
  )
  for (const name of layer ? LAYERED_ATTRIBUTES : ATTRIBUTES)
    (geometry.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, result.minZ, result.maxZ)
  return result.maxSequence
}
