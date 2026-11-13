import {
  Group,
  Mesh,
  WebGPUBackend,
  type InstancedBufferGeometry,
  type WebGPURenderer,
} from 'three/webgpu'
import type {
  SdfMotionOptions,
  WindfoilGlyphOutline,
  WindfoilShapeInstance,
  WindfoilShapes,
  WindfoilShapesOptions,
  WindfoilShapesStats,
} from '../types.js'
import { validateWindfoilGlyphOutline, type WindfoilPreprocessResult } from './preprocess.js'
import { WindfoilMaterial } from './WindfoilMaterial.js'
import {
  createWindfoilShapeGeometry,
  setShapeBounds,
  shapeGlyphs,
  updateWindfoilShapeGeometry,
  validateShapeInstances,
} from './shapeGeometry.js'
import type { WindfoilColorPart } from './color.js'
import { isAnimatedMotion, type GlyphTextMaterial } from '../text/GlyphTextMaterial.js'
import { abortable, throwIfAborted } from './storage.js'
import { acquireWindfoilShapeResources } from './shapeResources.js'
interface Built {
  geometry: InstancedBufferGeometry
  maxSequence: number
}
let scratchOrdinals = new Float32Array(0)
/** Layer instances, or one composite quad per instance with instance-order motion ordinals. */
function shapeGeometry(
  instances: readonly WindfoilShapeInstance[],
  prepared: WindfoilPreprocessResult,
  composite: WindfoilColorPart | null,
  geometry?: InstancedBufferGeometry,
): Built {
  if (!composite) {
    if (geometry) {
      const maxSequence = updateWindfoilShapeGeometry(geometry, instances, prepared.glyphs)
      if (maxSequence !== null) return { geometry, maxSequence }
    }
    return createWindfoilShapeGeometry(instances, prepared.glyphs, prepared.layered)
  }
  if (instances.length > scratchOrdinals.length) {
    scratchOrdinals = new Float32Array(instances.length)
    for (let i = 0; i < instances.length; i++) scratchOrdinals[i] = i
  }
  const layout = { glyphs: shapeGlyphs(instances), width: 0, height: 0 },
    ordinals = scratchOrdinals.subarray(0, instances.length)
  if (geometry) {
    const maxSequence = composite.updateGeometry(geometry, layout, 0, ordinals)
    if (maxSequence !== null) {
      setShapeBounds(geometry)
      return { geometry, maxSequence }
    }
  }
  const created = composite.createGeometry(layout, 0, ordinals)
  setShapeBounds(created.geometry)
  return created
}
class WindfoilShapesGroup extends Group implements WindfoilShapes {
  readonly mesh: Mesh<InstancedBufferGeometry, GlyphTextMaterial>
  private disposed = false
  constructor(
    readonly prepared: WindfoilPreprocessResult,
    readonly composite: WindfoilColorPart | null,
    geometry: InstancedBufferGeometry,
    material: GlyphTextMaterial,
    readonly release: () => void,
    private statistics: WindfoilShapesStats,
    castShadow: boolean,
    /** The live motion; the material is static while its mode is `'none'`. */
    private motion: SdfMotionOptions,
  ) {
    super()
    this.statistics = Object.freeze(statistics)
    this.mesh = new Mesh(geometry, material)
    this.mesh.name = 'ultra-text Windfoil shapes'
    this.mesh.castShadow = castShadow
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.add(this.mesh)
  }
  get stats(): WindfoilShapesStats {
    return this.statistics
  }
  setInstances(instances: readonly WindfoilShapeInstance[]): void {
    if (this.disposed) throw new Error('Windfoil shapes are disposed')
    validateShapeInstances(instances, this.prepared.glyphs)
    const next = shapeGeometry(instances, this.prepared, this.composite, this.mesh.geometry)
    if (next.geometry !== this.mesh.geometry) {
      const old = this.mesh.geometry
      this.mesh.geometry = next.geometry
      old.dispose()
    }
    this.mesh.material.maxSequence.value = next.maxSequence
    this.statistics = Object.freeze({
      ...this.statistics,
      instances: this.mesh.geometry.instanceCount,
    })
  }
  setMotion(motion: SdfMotionOptions): this {
    const live = { ...this.motion, ...motion }
    const material = this.mesh.material
    if (material.animated) material.setMotion(motion)
    else if (isAnimatedMotion(live) && !this.disposed) {
      // Static shapes have no motion graph: the first animated mode swaps in an animated
      // twin, built before the static material is released.
      this.mesh.material = material.withMotion(live)
      material.dispose()
    }
    this.motion = live
    return this
  }
  override dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.release()
    super.dispose()
  }
}
export async function buildWindfoilShapes(
  renderer: WebGPURenderer,
  outlines:
    ReadonlyMap<string, WindfoilGlyphOutline> | Readonly<Record<string, WindfoilGlyphOutline>>,
  instances: readonly WindfoilShapeInstance[],
  options: WindfoilShapesOptions = {},
): Promise<WindfoilShapes> {
  throwIfAborted(options.signal)
  const shader = options.compositing === 'shader'
  if (![undefined, 'layers', 'shader'].includes(options.compositing))
    throw new TypeError("compositing must be 'layers' or 'shader'")
  const entries: [string, WindfoilGlyphOutline][] =
    outlines instanceof Map
      ? [...(outlines as ReadonlyMap<string, WindfoilGlyphOutline>).entries()]
      : Object.entries(outlines as Readonly<Record<string, WindfoilGlyphOutline>>)
  const map = new Map(entries)
  for (const [key, outline] of entries) {
    if (!key) throw new TypeError('Outline keys must be non-empty')
    if (outline.clipBox !== undefined && !shader)
      throw new TypeError(
        "createWindfoilShapes does not support outline clipBox with layer compositing; use compositing: 'shader' or instance clip rectangles",
      )
    validateWindfoilGlyphOutline(outline)
  }
  validateShapeInstances(instances, map)
  await abortable(renderer.init(), options.signal)
  throwIfAborted(options.signal)
  if (!(renderer.backend instanceof WebGPUBackend))
    throw new Error(
      'createWindfoilShapes requires the WebGPU backend; render SVGs with SVGLoader + ShapeGeometry on WebGL2',
    )
  const resources = await acquireWindfoilShapeResources(
    renderer,
    outlines,
    entries,
    shader,
    options.targetPiecesPerBand,
    options.signal,
  )
  const { prepared, storage, colorResources, preprocessMs } = resources
  let geometry: InstancedBufferGeometry | undefined, material: GlyphTextMaterial | undefined
  try {
    throwIfAborted(options.signal)
    const composite = colorResources?.composite ?? null
    const built = shapeGeometry(instances, prepared, composite)
    geometry = built.geometry
    const motion = { ...(options.motion ?? { enabled: false, mode: 'none' as const }) }
    const materialOptions = {
      ...options,
      // Static by default: mode 'none' builds no motion graph.
      motion: isAnimatedMotion(motion) && motion,
      maxSequence: built.maxSequence,
      // Shape paint keeps its exact coverage: the tone is for text ink.
      tone: false as const,
    }
    material = composite
      ? composite.createMaterial(materialOptions)
      : new WindfoilMaterial({
          ...storage,
          ...materialOptions,
          layered: prepared.layered,
          ...(colorResources ? { paintFunctions: colorResources.paintFunctions } : {}),
        })
    return new WindfoilShapesGroup(
      prepared,
      composite,
      geometry,
      material,
      resources.release,
      {
        shapes: prepared.stats.uniqueGlyphs,
        instances: geometry.instanceCount,
        monotonePieces: prepared.stats.monotonePieces,
        bandCount: prepared.stats.bandCount,
        duplication: prepared.stats.duplication,
        storageBytes: storage.storageBytes + (colorResources?.storageBytes ?? 0),
        preprocessMs,
      },
      options.castShadow !== false,
      motion,
    )
  } catch (error) {
    material?.dispose()
    geometry?.dispose()
    resources.release()
    throw error
  }
}
