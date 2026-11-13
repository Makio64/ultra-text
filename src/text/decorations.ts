import { InstancedBufferAttribute, InstancedBufferGeometry } from 'three/webgpu'
import { attribute, float, mix } from 'three/tsl'

import type { DomLayoutSnapshot, TextDecorationLayout } from '../types.js'
import { GlyphTextMaterial, type GlyphTextMaterialOptions } from './GlyphTextMaterial.js'
import { byte, setBounds, setUnitQuad } from './geometryUtils.js'

export const GLYPH_RECTS_KEY = 'ultraGlyphRects'
export function glyphRectTable(geometry: InstancedBufferGeometry): ArrayLike<number> {
  return (
    (geometry.userData[GLYPH_RECTS_KEY] as Float32Array | undefined) ??
    geometry.getAttribute('sdfRect').array
  )
}

/** Decoration quads share their source glyph's motion center, index, and clip. */
export class TextDecorationMaterial extends GlyphTextMaterial {
  constructor(options: GlyphTextMaterialOptions) {
    super(
      options,
      (quad, rect, position, _depth, scale) => {
        const decoration = attribute<'vec4'>('decorationRect', 'vec4')
        if (options.motion === false) return mix(decoration.xy, decoration.zw, quad)
        const delta = mix(decoration.xy.sub(rect.xy), decoration.zw.sub(rect.zw), quad)
        return position.add(delta.mul(scale))
      },
      attribute<'float'>('decorationIndex', 'float'),
    )
    this.name = 'ultra-text solid text decorations'
    this.applyCoverage(float(1), float(1), float(0.5))
  }
}

function sameDecoration(a: TextDecorationLayout, b: TextDecorationLayout): boolean {
  return (
    a.line === b.line &&
    a.offset === b.offset &&
    a.thickness === b.thickness &&
    a.color.every((v, i) => v === b.color[i])
  )
}

type DecorationRecord = readonly [
  stroke: readonly [number, number, number, number],
  rectIndex: number,
  motionIndex: number,
  color: readonly [number, number, number, number],
  clip: readonly [number, number, number, number],
  sequence: number,
  z: number,
  motionOrigin: readonly [number, number, number] | null,
]

let cachedSnapshot: DomLayoutSnapshot | null = null
let cachedDrawable: ((key: string) => boolean) | null = null
let cachedRecords: readonly DecorationRecord[] = []

function decorationRecords(
  snapshot: DomLayoutSnapshot,
  drawable: (key: string) => boolean,
): readonly DecorationRecord[] {
  if (snapshot === cachedSnapshot && drawable === cachedDrawable) return cachedRecords
  const glyphs = snapshot.glyphs
  const records: DecorationRecord[] = []
  if (glyphs.some((glyph) => glyph.decorations?.length)) {
    let glyphIndex = 0
    let motionIndex = -1
    let previousGroup: number | undefined
    for (let index = 0; index < glyphs.length; index++) {
      const glyph = glyphs[index]!
      if (!drawable(glyph.glyphKey)) continue
      if (glyph.shapeGroup === undefined || glyph.shapeGroup !== previousGroup) motionIndex++
      previousGroup = glyph.shapeGroup
      const decorations = glyph.decorations
      if (decorations) {
        for (const decoration of decorations) {
          if (decoration.thickness <= 0 || decoration.color[3] <= 0) continue
          const next = glyphs[index + 1]
          let right = glyph.originX + (glyph.decorationWidth ?? Math.abs(glyph.advance))
          if (
            next?.block === glyph.block &&
            next.lineBottom === glyph.lineBottom &&
            next.decorations?.some((candidate) => sameDecoration(decoration, candidate))
          ) {
            right = Math.max(right, next.originX)
          }
          const y = glyph.lineBottom + decoration.offset
          records.push([
            [glyph.originX, y - decoration.thickness / 2, right, y + decoration.thickness / 2],
            glyphIndex,
            glyph.motionOrigin?.[2] ?? motionIndex,
            decoration.color,
            glyph.clip,
            glyph.sequence,
            glyph.z,
            glyph.motionOrigin ?? null,
          ])
        }
      }
      glyphIndex++
    }
  }
  cachedSnapshot = snapshot
  cachedDrawable = drawable
  return (cachedRecords = records)
}

const DECORATION_ATTRS = [
  'sdfRect',
  'decorationRect',
  'decorationIndex',
  'sdfColor',
  'sdfClip',
  'sdfMeta',
] as const

function decorationAttributesMatch(
  geometry: InstancedBufferGeometry,
  records: readonly DecorationRecord[],
): boolean {
  const count = geometry.instanceCount
  if (!count || records.length !== count) return false
  if (
    DECORATION_ATTRS.some(
      (name) => (geometry.getAttribute(name) as { count: number } | undefined)?.count !== count,
    )
  )
    return false
  const run = geometry.getAttribute('sdfRunMotion') as { count: number } | undefined
  return records.some((r) => r[7]) ? run?.count === count : !run
}

function writeDecorationBatch(
  records: readonly DecorationRecord[],
  sourceRects: ArrayLike<number>,
  rects: Float32Array,
  strokes: Float32Array,
  indices: Float32Array,
  colors: Uint8Array,
  clips: Float32Array,
  metadata: Float32Array,
  runMotion: Float32Array | null,
): [number, number] {
  let minZ = 0
  let maxZ = 0
  for (let index = 0; index < records.length; index++) {
    const [stroke, rectIndex, motionIndex, color, clip, sequence, z, motionOrigin] = records[index]!
    const offset = index * 4
    const srcOffset = rectIndex * 4
    for (let i = 0; i < 4; i++) {
      rects[offset + i] = sourceRects[srcOffset + i] ?? 0
      colors[offset + i] = byte(color[i]!)
    }
    strokes.set(stroke, offset)
    clips.set(clip, offset)
    indices[index] = motionIndex
    metadata[index * 2] = sequence
    metadata[index * 2 + 1] = z
    if (runMotion && motionOrigin) runMotion.set(motionOrigin, index * 3)
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return [minZ, maxZ]
}

/**
 * True when an existing decoration batch can be rewritten without allocating.
 * A null geometry matches only an empty decoration list.
 */
export function canUpdateDecorationGeometry(
  geometry: InstancedBufferGeometry | null,
  snapshot: DomLayoutSnapshot,
  drawable: (key: string) => boolean,
): boolean {
  const records = decorationRecords(snapshot, drawable)
  return geometry ? decorationAttributesMatch(geometry, records) : !records.length
}

/** Rewrites a same-count decoration batch from the current glyph rects. */
export function updateDecorationGeometry(
  geometry: InstancedBufferGeometry,
  snapshot: DomLayoutSnapshot,
  textGeometry: InstancedBufferGeometry,
  drawable: (key: string) => boolean,
  motionPadding: number,
): boolean {
  const records = decorationRecords(snapshot, drawable)
  if (!decorationAttributesMatch(geometry, records)) return false
  const run = geometry.getAttribute('sdfRunMotion') as InstancedBufferAttribute | undefined
  const arr = <T extends Float32Array | Uint8Array>(n: string): T =>
    geometry.getAttribute(n).array as T
  const [minZ, maxZ] = writeDecorationBatch(
    records,
    glyphRectTable(textGeometry),
    arr('sdfRect'),
    arr('decorationRect'),
    arr('decorationIndex'),
    arr('sdfColor'),
    arr('sdfClip'),
    arr('sdfMeta'),
    run ? (run.array as Float32Array) : null,
  )
  for (const name of DECORATION_ATTRS) {
    geometry.getAttribute(name).needsUpdate = true
  }
  if (run) run.needsUpdate = true
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, minZ, maxZ)
  return true
}

export function createDecorationGeometry(
  snapshot: DomLayoutSnapshot,
  textGeometry: InstancedBufferGeometry,
  drawable: (key: string) => boolean,
  motionPadding: number,
): InstancedBufferGeometry | null {
  const records = decorationRecords(snapshot, drawable)
  const count = records.length
  if (!count) return null
  const rects = new Float32Array(count * 4)
  const strokes = new Float32Array(count * 4)
  const indices = new Float32Array(count)
  const colors = new Uint8Array(count * 4)
  const clips = new Float32Array(count * 4)
  const metadata = new Float32Array(count * 2)
  const runMotion = records.some((record) => record[7] !== null)
    ? new Float32Array(count * 3)
    : null
  const [minZ, maxZ] = writeDecorationBatch(
    records,
    glyphRectTable(textGeometry),
    rects,
    strokes,
    indices,
    colors,
    clips,
    metadata,
    runMotion,
  )
  const geometry = new InstancedBufferGeometry()
  geometry.name = 'ultra-text instanced solid text decorations'
  setUnitQuad(geometry)
  const attr = (name: string, a: Float32Array | Uint8Array, n: number, norm = false): void => {
    geometry.setAttribute(name, new InstancedBufferAttribute(a, n, norm))
  }
  attr('sdfRect', rects, 4)
  attr('decorationRect', strokes, 4)
  attr('decorationIndex', indices, 1)
  attr('sdfColor', colors, 4, true)
  attr('sdfClip', clips, 4)
  attr('sdfMeta', metadata, 2)
  if (runMotion) attr('sdfRunMotion', runMotion, 3)
  geometry.instanceCount = count
  setBounds(geometry, snapshot.width, snapshot.height, motionPadding, minZ, maxZ)
  return geometry
}
