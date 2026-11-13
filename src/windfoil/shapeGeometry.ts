import {
  Box3,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  SRGBColorSpace,
} from 'three/webgpu'
import type { GlyphLayout, WindfoilShapeInstance } from '../types.js'
import { setUnitQuad } from '../text/geometryUtils.js'
import {
  fillWindfoilGlyphRect,
  writeLayerInstance,
  type MutableWindfoilAttributes,
} from './geometry.js'
import type { WindfoilGlyphHeader } from './preprocess.js'
export function validateShapeInstances(
  instances: readonly WindfoilShapeInstance[],
  headers: ReadonlyMap<string, unknown>,
): void {
  let lastShape = ''
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!
    if (instance.shape !== lastShape) {
      if (!headers.has(instance.shape))
        throw new TypeError(`instances[${index}].shape is not an outline key`)
      lastShape = instance.shape
    }
    if (
      !Number.isFinite(instance.x) ||
      !Number.isFinite(instance.y) ||
      !Number.isFinite(instance.size) ||
      !Number.isFinite(instance.z ?? 0) ||
      !Number.isFinite(instance.sequence ?? 0) ||
      instance.size <= 0
    )
      throw new RangeError(`instances[${index}] requires finite coordinates and positive size`)
    const opacity = instance.opacity ?? 1
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
      throw new RangeError(`instances[${index}].opacity must be in [0, 1]`)
    const clip = instance.clip
    if (
      clip &&
      ((clip as readonly number[]).length !== 4 ||
        !Number.isFinite(clip[0]) ||
        !Number.isFinite(clip[1]) ||
        !Number.isFinite(clip[2]) ||
        !Number.isFinite(clip[3]) ||
        clip[0] > clip[2] ||
        clip[1] > clip[3])
    )
      throw new RangeError(`instances[${index}].clip must be an ordered finite rectangle`)
  }
}
const DEFAULT_CLIP = [-1e7, -1e7, 1e7, 1e7] as const
const DEFAULT_RGB = [1, 1, 1] as const
const sharedColor = new Color()
const sharedRgb = { r: 1, g: 1, b: 1 }
const colorCache = new Map<string | number, readonly [number, number, number]>()

function resolveInstanceRgb(
  input: WindfoilShapeInstance['color'],
): readonly [number, number, number] {
  if (input === undefined || input === 0xffffff) return DEFAULT_RGB
  const cached = colorCache.get(input as string | number)
  if (cached) return cached
  sharedColor.set(input).getRGB(sharedRgb, SRGBColorSpace)
  const rgb: readonly [number, number, number] = [sharedRgb.r, sharedRgb.g, sharedRgb.b]
  if (typeof input !== 'object') {
    if (colorCache.size > 999) colorCache.clear()
    colorCache.set(input, rgb)
  }
  return rgb
}

function countInstances(
  instances: readonly WindfoilShapeInstance[],
  headers: ReadonlyMap<string, WindfoilGlyphHeader>,
  layered: boolean,
): number {
  let total = 0
  let lastShape = ''
  let lastCount = 0
  for (const instance of instances) {
    if (instance.shape !== lastShape) {
      lastShape = instance.shape
      const header = headers.get(lastShape)!
      lastCount = header.monotonePieceCount ? (layered ? (header.layers?.length ?? 1) : 1) : 0
    }
    total += lastCount
  }
  return total
}
/** Instance fields as the shared glyph layout used by layer and composite geometry. */
export function shapeGlyphs(instances: readonly WindfoilShapeInstance[]): GlyphLayout[] {
  const n = instances.length
  const out = new Array<GlyphLayout>(n)
  for (let i = 0; i < n; i++) {
    const instance = instances[i]!
    const rgb = resolveInstanceRgb(instance.color)
    out[i] = {
      glyphKey: instance.shape,
      fontSize: instance.size,
      originX: instance.x,
      lineBottom: instance.y,
      advance: 0,
      block: 0,
      breakBefore: 'none',
      clip: instance.clip ?? DEFAULT_CLIP,
      color: [rgb[0], rgb[1], rgb[2], instance.opacity ?? 1],
      sequence: instance.sequence ?? 0,
      z: instance.z ?? 0,
    }
  }
  return out
}
/** Tight local bounds of every written quad, at its instance depth. */
export function setShapeBounds(geometry: InstancedBufferGeometry): void {
  const rects = geometry.getAttribute('sdfRect').array as Float32Array,
    meta = geometry.getAttribute('sdfMeta').array as Float32Array,
    bbox = geometry.boundingBox ?? new Box3(),
    count = geometry.instanceCount
  if (count === 0) {
    bbox.min.set(0, 0, 0)
    bbox.max.set(0, 0, 0)
  } else {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity
    for (let i = 0; i < count; i++) {
      const r = i * 4,
        z = meta[i * 2 + 1]!
      minX = Math.min(minX, rects[r]!, rects[r + 2]!)
      minY = Math.min(minY, rects[r + 1]!, rects[r + 3]!)
      if (z < minZ) minZ = z
      maxX = Math.max(maxX, rects[r]!, rects[r + 2]!)
      maxY = Math.max(maxY, rects[r + 1]!, rects[r + 3]!)
      if (z > maxZ) maxZ = z
    }
    bbox.min.set(minX, minY, minZ)
    bbox.max.set(maxX, maxY, maxZ)
  }
  geometry.boundingBox = bbox
  geometry.boundingSphere = bbox.getBoundingSphere(geometry.boundingSphere ?? new Sphere())
}
function writeInstances(
  instances: readonly WindfoilShapeInstance[],
  headers: ReadonlyMap<string, WindfoilGlyphHeader>,
  attrs: MutableWindfoilAttributes,
): number {
  let index = 0,
    maxSequence = 0
  const color: [number, number, number, number] = [1, 1, 1, 1]
  const glyph = {
    glyphKey: '',
    fontSize: 0,
    originX: 0,
    lineBottom: 0,
    advance: 0,
    block: 0,
    breakBefore: 'none' as const,
    clip: DEFAULT_CLIP as readonly [number, number, number, number],
    color,
    sequence: 0,
    z: 0,
  }
  const hasLayers = Boolean(attrs.layers)
  let lastShape = ''
  let lastHeader: WindfoilGlyphHeader | undefined
  for (let ordinal = 0; ordinal < instances.length; ordinal++) {
    const instance = instances[ordinal]!
    const header =
      instance.shape === lastShape
        ? lastHeader!
        : ((lastShape = instance.shape), (lastHeader = headers.get(lastShape)!))
    const sequence = instance.sequence ?? 0
    if (header.monotonePieceCount) {
      const rgb = resolveInstanceRgb(instance.color)
      color[0] = rgb[0]
      color[1] = rgb[1]
      color[2] = rgb[2]
      color[3] = instance.opacity ?? 1
      glyph.glyphKey = instance.shape
      glyph.fontSize = instance.size
      glyph.originX = instance.x
      glyph.lineBottom = instance.y
      glyph.clip = instance.clip ?? DEFAULT_CLIP
      glyph.sequence = sequence
      glyph.z = instance.z ?? 0
      const rect = hasLayers ? fillWindfoilGlyphRect(glyph, header) : undefined
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      for (const layer of (hasLayers && header.layers) || [header])
        writeLayerInstance(glyph, header, layer, index++, ordinal, attrs, rect)
      if (sequence > maxSequence) maxSequence = sequence
    }
  }
  return maxSequence
}
export function createWindfoilShapeGeometry(
  instances: readonly WindfoilShapeInstance[],
  headers: ReadonlyMap<string, WindfoilGlyphHeader>,
  layered = false,
): { geometry: InstancedBufferGeometry; maxSequence: number } {
  const count = countInstances(instances, headers, layered)
  const attrs = {
    rects: new Float32Array(count * 4),
    clips: new Float32Array(count * 4),
    colors: new Uint8Array(count * 4),
    metadata: new Float32Array(count * 2),
    bounds: new Float32Array(count * 4),
    bands: new Float32Array(count * 4),
    ...(layered ? { layers: new Float32Array(count * 4) } : {}),
  }
  const maxSequence = writeInstances(instances, headers, attrs)
  const geometry = new InstancedBufferGeometry()
  geometry.name = 'ultra-text instanced Windfoil shape quads'
  setUnitQuad(geometry)
  for (const [name, data, size, normalized] of [
    ['sdfRect', attrs.rects, 4, false],
    ['sdfClip', attrs.clips, 4, false],
    ['sdfColor', attrs.colors, 4, true],
    ['sdfMeta', attrs.metadata, 2, false],
    ['windfoilBounds', attrs.bounds, 4, false],
    ['windfoilBand', attrs.bands, 4, false],
  ] as const)
    geometry.setAttribute(name, new InstancedBufferAttribute(data, size, normalized))
  if (attrs.layers)
    geometry.setAttribute('windfoilLayer', new InstancedBufferAttribute(attrs.layers, 4))
  geometry.instanceCount = count
  setShapeBounds(geometry)
  return { geometry, maxSequence }
}
export function updateWindfoilShapeGeometry(
  geometry: InstancedBufferGeometry,
  instances: readonly WindfoilShapeInstance[],
  headers: ReadonlyMap<string, WindfoilGlyphHeader>,
): number | null {
  const layer = geometry.getAttribute('windfoilLayer') as InstancedBufferAttribute | undefined
  if (geometry.instanceCount !== countInstances(instances, headers, !!layer)) return null
  const array = <T extends Float32Array | Uint8Array>(name: string): T => {
    const attribute = geometry.getAttribute(name)
    attribute.needsUpdate = true
    return attribute.array as T
  }
  const maxSequence = writeInstances(instances, headers, {
    rects: array('sdfRect'),
    clips: array('sdfClip'),
    colors: array('sdfColor'),
    metadata: array('sdfMeta'),
    bounds: array('windfoilBounds'),
    bands: array('windfoilBand'),
    ...(layer ? { layers: array<Float32Array>('windfoilLayer') } : {}),
  })
  setShapeBounds(geometry)
  return maxSequence
}
