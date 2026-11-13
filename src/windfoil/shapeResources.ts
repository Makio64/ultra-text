import type { WebGPURenderer } from 'three/webgpu'
import type { WindfoilColorStop, WindfoilGlyphOutline, WindfoilPaint } from '../types.js'
import {
  preprocessWindfoilOutlines,
  WINDFOIL_TARGET_PIECES_PER_BAND,
  type WindfoilPreprocessResult,
} from './preprocess.js'
import type { WindfoilColorResources } from './color.js'
import { abortable, createWindfoilStorage, throwIfAborted } from './storage.js'

type OutlineEntries = readonly (readonly [string, WindfoilGlyphOutline])[]
type ShapeStorage = ReturnType<typeof createWindfoilStorage>
interface ShapeResources {
  readonly prepared: WindfoilPreprocessResult
  readonly storage: ShapeStorage
  readonly colorResources: WindfoilColorResources | undefined
  readonly preprocessMs: number
  dispose(): void
}
interface CachedResources {
  readonly outlines: OutlineEntries
  readonly shader: boolean
  readonly target: number
  readonly backend: object
  readonly device: object | undefined
  readonly controller: AbortController
  promise: Promise<ShapeResources>
  resources?: ShapeResources
  references: number
}

// A source only retains resources while a pending build or a live handle leases them.
// Storage nodes belong to one renderer; sharing them across devices is invalid.
const active = new WeakMap<object, WeakMap<WebGPURenderer, Set<CachedResources>>>()

/** Validation/preprocessing read numeric indices; ignore any custom iterator. */
function copyIndexed<T>(value: ArrayLike<T>): T[] {
  const result = new Array<T>(value.length)
  for (let i = 0; i < result.length; i++) result[i] = value[i]!
  return result
}

function copyQuadratics(value: ArrayLike<number>): ArrayLike<number> {
  return value instanceof Float32Array ? value.slice() : copyIndexed(value)
}

/** Copy supported paint fields without converting invalid gradient tuples into valid arrays. */
function copyPaint(paint: WindfoilPaint): WindfoilPaint {
  const tuple = <T>(value: T): T => (Array.isArray(value) ? copyIndexed(value) : value) as T
  if (paint.type === 'foreground')
    return { type: paint.type, ...(paint.alpha === undefined ? {} : { alpha: paint.alpha }) }
  if (paint.type === 'solid')
    return { type: paint.type, color: copyIndexed(paint.color) as [number, number, number, number] }
  const gradient = {
    ...(paint.extend === undefined ? {} : { extend: paint.extend }),
    ...(paint.transform === undefined ? {} : { transform: tuple(paint.transform) }),
    stops: Array.isArray(paint.stops)
      ? (paint.stops as readonly WindfoilColorStop[]).map((stop) => ({
          offset: stop.offset,
          color: tuple(stop.color),
        }))
      : paint.stops,
  }
  if (paint.type === 'linear')
    return {
      ...gradient,
      type: paint.type,
      p0: tuple(paint.p0),
      p1: tuple(paint.p1),
      ...(paint.p2 === undefined ? {} : { p2: tuple(paint.p2) }),
    }
  if (paint.type === 'radial')
    return {
      ...gradient,
      type: paint.type,
      c0: tuple(paint.c0),
      r0: paint.r0,
      c1: tuple(paint.c1),
      r1: paint.r1,
    }
  return {
    ...gradient,
    type: paint.type,
    center: tuple(paint.center),
    startAngle: paint.startAngle,
    endAngle: paint.endAngle,
  }
}

/** Validation reads a null layer list from untyped callers as an empty one. */
function layersOf(outline: WindfoilGlyphOutline): WindfoilGlyphOutline['layers'] {
  const layers = outline.layers as WindfoilGlyphOutline['layers'] | null
  return layers === null ? [] : layers
}

function copyOutlines(entries: OutlineEntries): OutlineEntries {
  return entries.map(([key, outline]) => {
    const layers = layersOf(outline)
    return [
      key,
      {
        unitsPerEm: outline.unitsPerEm,
        ascent: outline.ascent,
        descent: outline.descent,
        bbox: copyIndexed(outline.bbox) as [number, number, number, number],
        quadratics: copyQuadratics(outline.quadratics),
        ...(outline.clipBox === undefined
          ? {}
          : { clipBox: copyIndexed(outline.clipBox) as [number, number, number, number] }),
        ...(layers === undefined
          ? {}
          : {
              layers: copyIndexed(layers).map((layer) => ({
                quadratics: copyQuadratics(layer.quadratics),
                ...(layer.bbox === undefined
                  ? {}
                  : { bbox: copyIndexed(layer.bbox) as [number, number, number, number] }),
                paint: copyPaint(layer.paint),
              })),
            }),
      },
    ]
  })
}

/** Compare every supported input field exactly; no hash can turn mutations into a cache hit. */
function equalValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!equalValues(a[i], b[i])) return false
    return true
  }
  const left = Object.entries(a),
    right = Object.entries(b)
  return (
    left.length === right.length &&
    left.every(
      ([key, value], index) => key === right[index]![0] && equalValues(value, right[index]![1]),
    )
  )
}

function equalNumbers(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

function equalPaint(a: WindfoilPaint, raw: WindfoilPaint): boolean {
  if (a.type === 'foreground' && raw.type === 'foreground') return Object.is(a.alpha, raw.alpha)
  if (a.type === 'solid' && raw.type === 'solid') return equalNumbers(a.color, raw.color)
  return equalValues(a, copyPaint(raw))
}

function equalOutlines(snapshot: OutlineEntries, entries: OutlineEntries): boolean {
  if (snapshot.length !== entries.length) return false
  return snapshot.every(([key, a], index) => {
    const [nextKey, b] = entries[index]!
    if (
      key !== nextKey ||
      !Object.is(a.unitsPerEm, b.unitsPerEm) ||
      !Object.is(a.ascent, b.ascent) ||
      !Object.is(a.descent, b.descent) ||
      !equalNumbers(a.bbox, b.bbox) ||
      !equalNumbers(a.quadratics, b.quadratics) ||
      !equalNumbers(a.clipBox, b.clipBox)
    )
      return false
    const layers = layersOf(b)
    if (a.layers === undefined || layers === undefined) return a.layers === layers
    return (
      a.layers.length === layers.length &&
      a.layers.every((layer, i) => {
        const other = layers[i]!
        return (
          equalNumbers(layer.bbox, other.bbox) &&
          equalNumbers(layer.quadratics, other.quadratics) &&
          equalPaint(layer.paint, other.paint)
        )
      })
    )
  })
}

async function buildResources(
  renderer: WebGPURenderer,
  entries: OutlineEntries,
  shader: boolean,
  target: number,
  signal: AbortSignal,
): Promise<ShapeResources> {
  const earlyColorPromise = shader ? import('./color.js') : null
  const start = performance.now(),
    prepared = preprocessWindfoilOutlines(
      entries.map(([key, outline]) => ({
        key,
        outline: shader ? { ...outline, layers: outline.layers ?? [] } : outline,
      })),
      { signal, orientLayers: () => shader, targetPiecesPerBand: target },
    ),
    preprocessMs = performance.now() - start
  const colorModule =
    shader ||
    [...prepared.glyphs.values()].some((header) =>
      header.layers?.some((layer) => layer.paintKind === 2),
    )
      ? await abortable(earlyColorPromise ?? import('./color.js'), signal)
      : null
  throwIfAborted(signal)
  const storage = createWindfoilStorage(renderer, prepared)
  let colorResources: WindfoilColorResources | undefined
  try {
    colorResources = colorModule?.buildWindfoilColorResources(
      renderer,
      prepared,
      { outlineProvider: () => null, ...(shader ? { compositing: 'shader' as const } : {}) },
      storage,
      signal,
      true,
    )
    let disposed = false
    return {
      prepared,
      storage,
      colorResources,
      preprocessMs,
      dispose() {
        if (disposed) return
        disposed = true
        colorResources?.dispose()
        storage.dispose()
      },
    }
  } catch (error) {
    colorResources?.dispose()
    storage.dispose()
    throw error
  }
}

export async function acquireWindfoilShapeResources(
  renderer: WebGPURenderer,
  source: object,
  entries: OutlineEntries,
  shader: boolean,
  targetPiecesPerBand?: number,
  signal?: AbortSignal,
): Promise<Omit<ShapeResources, 'dispose'> & { readonly release: () => void }> {
  throwIfAborted(signal)
  const target = targetPiecesPerBand ?? WINDFOIL_TARGET_PIECES_PER_BAND
  const backend = renderer.backend,
    device = (backend as { device?: object }).device
  let renderers = active.get(source)
  if (!renderers) active.set(source, (renderers = new WeakMap()))
  let bucket = renderers.get(renderer)
  if (!bucket) renderers.set(renderer, (bucket = new Set()))
  let entry = [...bucket].find(
    (candidate) =>
      candidate.shader === shader &&
      candidate.target === target &&
      candidate.backend === backend &&
      candidate.device === device &&
      equalOutlines(candidate.outlines, entries),
  )
  const reused = !!entry
  if (!entry) {
    // Snapshot before any lazy import, so caller mutations cannot change an in-flight build.
    const outlines = copyOutlines(entries)
    const controller = new AbortController()
    entry = {
      outlines,
      shader,
      target,
      backend,
      device,
      controller,
      references: 0,
      promise: buildResources(renderer, outlines, shader, target, controller.signal),
    }
    const created = entry
    entry.promise = entry.promise.then(
      (resources) => {
        created.resources = resources
        if (created.references === 0) resources.dispose()
        return resources
      },
      (error: unknown) => {
        bucket.delete(created)
        throw error
      },
    )
    bucket.add(entry)
  }
  entry.references++
  const leased = entry
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    if (--leased.references === 0) {
      bucket.delete(leased)
      leased.controller.abort()
      leased.resources?.dispose()
    }
  }
  try {
    const resources = await abortable(entry.promise, signal)
    throwIfAborted(signal)
    return {
      prepared: resources.prepared,
      storage: resources.storage,
      colorResources: resources.colorResources,
      preprocessMs: reused ? 0 : resources.preprocessMs,
      release,
    }
  } catch (error) {
    release()
    throw error
  }
}
