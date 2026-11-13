import {
  StorageBufferAttribute,
  type InstancedBufferGeometry,
  type StorageBufferNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { storage } from 'three/tsl'
import type { WindfoilOptions } from '../types.js'
import type {
  WindfoilGlyphHeader,
  WindfoilLayerHeader,
  WindfoilPreprocessResult,
} from './preprocess.js'
import type { WindfoilMaterialOptions, WindfoilStorage } from './WindfoilMaterial.js'
import { WindfoilCompositeMaterial } from './WindfoilCompositeMaterial.js'
import {
  createWindfoilCompositeGeometry,
  updateWindfoilCompositeGeometry,
  windfoilCompositeContentFits,
  type WindfoilCompositeHeader,
  type WindfoilCompositeLayout,
} from './compositeGeometry.js'
import { normalizeWindfoilPaint, packWindfoilPaints, floatBits } from './paint.js'
import { createWindfoilPaintFunctions } from './paintNodes.js'
import { disposeWindfoilStorage, throwIfAborted } from './storage.js'
import {
  appendWindfoilLayerGrids,
  windfoilPaintOpaque,
  WINDFOIL_TEXT_INDEX,
  type WindfoilIndexTuning,
} from './layerGrid.js'

export interface WindfoilColorPart {
  readonly glyphs: ReadonlyMap<string, WindfoilCompositeHeader>
  createGeometry(
    snapshot: WindfoilCompositeLayout,
    padding: number,
    ordinals?: Float32Array,
  ): { geometry: InstancedBufferGeometry; maxSequence: number }
  updateGeometry(
    geometry: InstancedBufferGeometry,
    snapshot: WindfoilCompositeLayout,
    padding: number,
    ordinals?: Float32Array,
  ): number | null
  contentFits(geometry: InstancedBufferGeometry, snapshot: WindfoilCompositeLayout): boolean
  createMaterial(
    options: Omit<WindfoilMaterialOptions, 'curves' | 'rows'>,
  ): WindfoilCompositeMaterial
}
export interface WindfoilColorResources {
  readonly storageBytes: number
  readonly paintFunctions: ReturnType<typeof createWindfoilPaintFunctions>
  readonly composite: WindfoilColorPart | null
  readonly plainGlyphs: ReadonlyMap<string, WindfoilGlyphHeader>
  dispose(): void
}
/** Pack paint rows and glyph layers in stable key/paint order before allocating. */
export function packWindfoilLayers(prepared: WindfoilPreprocessResult, signal?: AbortSignal) {
  const all: WindfoilLayerHeader[] = []
  const glyphs = new Map<string, WindfoilCompositeHeader>()
  for (const [key, header] of prepared.glyphs) {
    if (!header.layers) continue
    throwIfAborted(signal)
    const first = all.length
    all.push(...header.layers)
    glyphs.set(key, { ...header, layerStart: first, layerCount: all.length - first })
  }
  const normalized = new Array<ReturnType<typeof normalizeWindfoilPaint>>(all.length)
  let solidOnly = true
  for (let index = 0; index < all.length; index++) {
    if ((index & 255) === 0) throwIfAborted(signal)
    const layer = all[index]!
    const paint = normalizeWindfoilPaint(layer.paint, layer.paintLabel)
    normalized[index] = paint
    if (paint.kind >= 2) solidOnly = false
  }
  const packed = packWindfoilPaints(normalized)
  const table = new Uint32Array(all.length * 12),
    opaque: number[] = []
  let tableWords = 0
  const liveGlyphs = new Map<string, WindfoilCompositeHeader>()
  for (const [key, header] of glyphs) {
    const first = tableWords / 12
    const clip = header.clipBox,
      box = header.bbox
    const clippedOut =
      !!clip &&
      (Math.max(box[0], clip[0]) >= Math.min(box[2], clip[2]) ||
        Math.max(box[1], clip[1]) >= Math.min(box[3], clip[3]))
    const live: WindfoilLayerHeader[] = []
    let monotonePieceCount = 0
    for (let i = header.layerStart; i < header.layerStart + header.layerCount; i++) {
      const layer = all[i]!,
        paint = normalized[i]!,
        paintIndex = packed.indices[i]!
      if (paint.alphaMax === 0 || clippedOut) continue
      layer.paintIndex = paintIndex
      live.push(layer)
      monotonePieceCount += layer.monotonePieceCount
      opaque.push(windfoilPaintOpaque(paint) ? 1 : 0)
      const layerBox = layer.bbox
      table[tableWords] = layer.rowBase
      table[tableWords + 1] = layer.bandCount
      table[tableWords + 2] = floatBits(layer.bandH)
      table[tableWords + 3] = floatBits(layer.invH)
      table[tableWords + 4] = floatBits(layerBox[0])
      table[tableWords + 5] = floatBits(layerBox[1])
      table[tableWords + 6] = floatBits(layerBox[2])
      table[tableWords + 7] = floatBits(layerBox[3])
      table[tableWords + 8] = paintIndex
      table[tableWords + 9] = (layer.paintKind === 0 ? 1 : 0) | (layer.transposed ? 2 : 0)
      table[tableWords + 10] = floatBits(paint.alphaMax)
      tableWords += 12
    }
    const amended = {
      ...header,
      layers: live,
      layerStart: first,
      layerCount: tableWords / 12 - first,
      monotonePieceCount,
    }
    liveGlyphs.set(key, amended)
    // Prepared is private build state. Drop invisible gradient instances before geometry.
    ;(prepared.glyphs as Map<string, WindfoilGlyphHeader>).set(key, amended)
  }
  return {
    ...packed,
    solidOnly,
    layers: tableWords === table.length ? table : table.slice(0, tableWords),
    opaque,
    glyphs: liveGlyphs,
  }
}

export function buildWindfoilColorResources(
  renderer: WebGPURenderer,
  prepared: WindfoilPreprocessResult,
  options: WindfoilOptions,
  coverage: WindfoilStorage,
  signal?: AbortSignal,
  artwork = false,
): WindfoilColorResources {
  const packed = packWindfoilLayers(prepared, signal)
  throwIfAborted(signal)
  const attributes: StorageBufferAttribute[] = []
  const allocate = (data: Uint32Array, name: string): StorageBufferNode<'uint'> => {
    const attribute = new StorageBufferAttribute(data.length ? data : new Uint32Array(1), 1)
    attributes.push(attribute)
    return storage(attribute, 'uint', attribute.count).toReadOnly().setName(name)
  }
  try {
    const paints = allocate(packed.paints, 'ultraWindfoilPaints'),
      stops = allocate(packed.stops, 'ultraWindfoilStops')
    const paintFunctions = createWindfoilPaintFunctions({
      paints,
      stops,
      solidOnly: packed.solidOnly,
    })
    const compositeGlyphs = new Map<string, WindfoilCompositeHeader>()
    for (const [key, header] of packed.glyphs) {
      if (options.compositing === 'shader' || !!header.clipBox) {
        compositeGlyphs.set(key, header)
      }
    }
    const index = (tuning: WindfoilIndexTuning) =>
      appendWindfoilLayerGrids(
        packed.layers,
        compositeGlyphs.values(),
        prepared,
        packed.opaque,
        signal,
        tuning,
      )
    let table = compositeGlyphs.size ? index(artwork ? {} : WINDFOIL_TEXT_INDEX) : null
    // Past the device's binding limit, keep one unsplit cell per glyph: slower, never unbound.
    const limit = (
      renderer.backend as { device?: { limits: { maxStorageBufferBindingSize: number } } }
    ).device?.limits.maxStorageBufferBindingSize
    if (table && limit && table.byteLength > limit) table = index({ maxNodes: 1 })
    const layers = table ? allocate(table, 'ultraWindfoilLayers') : null
    const composite: WindfoilColorPart | null = layers
      ? {
          glyphs: compositeGlyphs,
          createGeometry(snapshot, padding, ordinals) {
            return createWindfoilCompositeGeometry(snapshot, compositeGlyphs, padding, ordinals)
          },
          updateGeometry(geometry, snapshot, padding, ordinals) {
            return updateWindfoilCompositeGeometry(
              geometry,
              snapshot,
              compositeGlyphs,
              padding,
              ordinals,
            )
          },
          contentFits(geometry, snapshot) {
            return windfoilCompositeContentFits(geometry, snapshot, compositeGlyphs)
          },
          createMaterial(materialOptions) {
            return new WindfoilCompositeMaterial({
              ...coverage,
              ...materialOptions,
              layers,
              paintFunctions,
            })
          },
        }
      : null
    let plainGlyphs: ReadonlyMap<string, WindfoilGlyphHeader>
    if (layers) {
      const filtered = new Map<string, WindfoilGlyphHeader>()
      for (const [key, header] of prepared.glyphs) {
        if (!compositeGlyphs.has(key)) filtered.set(key, header)
      }
      plainGlyphs = filtered
    } else {
      plainGlyphs = prepared.glyphs
    }
    let disposed = false
    return {
      paintFunctions,
      composite,
      plainGlyphs,
      storageBytes: packed.paints.byteLength + packed.stops.byteLength + (table?.byteLength ?? 0),
      dispose() {
        if (disposed) return
        disposed = true
        for (const attribute of attributes) disposeWindfoilStorage(renderer, attribute)
      },
    }
  } catch (error) {
    for (const attribute of attributes) disposeWindfoilStorage(renderer, attribute)
    throw error
  }
}
