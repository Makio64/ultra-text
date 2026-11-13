import { Group, Mesh, type InstancedBufferGeometry, type WebGPURenderer } from 'three/webgpu'

import type * as AppendAtlas from '../atlas/appendAtlas.js'
import { buildSdfAtlas } from '../atlas/buildAtlas.js'
import { prepareAtlasPasses } from '../atlas/gpuAtlas.js'
import { isColorCandidate, rasterizeGlyphAtlas, type RasterizeOptions } from '../atlas/rasterize.js'
import { createRectMaterial } from '../text/RectMaterial.js'
import { isAnimatedMotion, type GlyphTextMaterial } from '../text/GlyphTextMaterial.js'
import { SdfTextMaterial } from '../text/SdfTextMaterial.js'
import {
  createGlyphGeometry,
  createRectGeometry,
  glyphContentFits,
  needsRunMotion,
  rectContentFits,
  updateGlyphContent,
  updateGlyphGeometry,
  updateRectGeometry,
} from '../text/geometry.js'
import { reflowSnapshot } from '../text/reflow.js'
import {
  canUpdateDecorationGeometry,
  createDecorationGeometry,
  TextDecorationMaterial,
  updateDecorationGeometry,
} from '../text/decorations.js'
import type { ResolvedTextTone } from '../text/tone.js'
import type {
  DomLayoutSnapshot,
  DomSdfOptions,
  DomSdfStats,
  SdfAtlas,
  SdfMotionOptions,
} from '../types.js'
import type { createExtraTextParts } from '../windfoil/mixed.js'
import type { WindfoilBackend, WindfoilBuildOptions } from '../windfoil/runtime.js'
import type { TracedOutlines } from '../windfoil/tracedOutlines.js'
import { DEFAULT_RECT_SELECTOR } from './markup.js'
import { collectDomSnapshot } from './snapshot.js'
import { layoutSignatureOf } from './layoutSignature.js'
import { resolveDomTextTone } from './tone.js'

const EMPTY_STATS: Readonly<DomSdfStats> = Object.freeze({
  atlasBuildMs: 0,
  layoutReadMs: 0,
  geometryBuildMs: 0,
  glyphs: 0,
  shapes: 0,
  colorGlyphs: 0,
  fallbackGlyphs: 0,
  switchableGlyphs: 0,
  rects: 0,
  lines: 0,
  draws: 0,
  atlasWidth: 0,
  atlasHeight: 0,
  textBackend: 'sdf',
  atlasMode: null,
  textStorageBytes: 0,
})

type RetainedTextBackend = SdfAtlas | WindfoilBackend

function isWindfoilBackend(backend: RetainedTextBackend): backend is WindfoilBackend {
  return 'kind' in backend
}

function buildGlyphGeometry(
  snapshot: DomLayoutSnapshot,
  backend: RetainedTextBackend,
  motionPadding: number,
): { geometry: InstancedBufferGeometry; maxSequence: number } {
  return isWindfoilBackend(backend)
    ? backend.createGeometry(snapshot, motionPadding)
    : createGlyphGeometry(snapshot, backend, motionPadding)
}

function sdfStorageBytes(atlas: SdfAtlas, mipmaps: boolean): number {
  const count = (w: number, h: number, bpp: number): number =>
    w * h * bpp + (mipmaps && (w > 1 || h > 1) ? count(w >> 1 || 1, h >> 1 || 1, bpp) : 0)
  return (
    count(atlas.width, atlas.height, 1) +
    (atlas.colorLayer ? count(atlas.width, atlas.colorLayer.height, 4) : 0)
  )
}

interface ContentBundle {
  readonly g: Group
  readonly m: GlyphTextMaterial
  readonly tg: InstancedBufferGeometry
  readonly a: boolean
  sm(change: SdfMotionOptions, live: SdfMotionOptions): void
  st(tone: ResolvedTextTone | null): boolean
  ud(snapshot: DomLayoutSnapshot, backend: RetainedTextBackend, motion: SdfMotionOptions): void
  rg(geometry: InstancedBufferGeometry): void
  u(
    snapshot: DomLayoutSnapshot,
    backend: RetainedTextBackend,
    motion: SdfMotionOptions,
    tone?: ResolvedTextTone | null,
  ): boolean
  d(): void
}

/** Trailing debounce for attribute-only mutations (CSS transitions fire per frame). */
const ATTRIBUTE_DEBOUNCE_MS = 80
/** A perpetually animating page still refreshes at least this often. */
const ATTRIBUTE_MAX_WAIT_MS = 320

export interface DomSdfRebuildOptions {
  /**
   * Regenerate the font atlas even when the requested face/codepoint set has
   * not changed. Use this after a same-family webfont is replaced in place.
   */
  atlas?: boolean
}

function now(): number {
  return performance.now()
}

function abortError(message = 'The DOM SDF build was aborted'): DOMException {
  return new DOMException(message, 'AbortError')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError()
}

function createContent(
  snapshot: DomLayoutSnapshot,
  backend: RetainedTextBackend,
  options: DomSdfOptions,
  motion: SdfMotionOptions,
  tone: ResolvedTextTone | null,
  makeExtraParts?: typeof createExtraTextParts,
): ContentBundle {
  // Every text material shows the tone this capture resolved, not the caller's option.
  const materialOptions = { ...options, tone: tone ?? (false as const) }
  const group = new Group()
  group.name = 'ultra-text generated DOM content'
  group.matrixAutoUpdate = false
  group.updateMatrix()

  // Live motion, not the frozen construction options: setMotion() can raise the
  // strength after the fact.
  const strength = motion.strength ?? 18
  // The live mode 'none' builds static materials, without the motion graph; the first
  // setMotion() to another mode swaps in animated ones (see `setMotion` below).
  let animated = isAnimatedMotion(motion)
  const materialMotion = (live: SdfMotionOptions): SdfMotionOptions | false =>
    animated ? live : false
  const { geometry: glyphGeometry, maxSequence } = buildGlyphGeometry(snapshot, backend, strength)
  const hasExtras = isWindfoilBackend(backend) && !!(backend.companion ?? backend.color)
  const usesColor = (layout: DomLayoutSnapshot): boolean =>
    !!(isWindfoilBackend(backend) ? backend.companion?.colorLayer : backend.colorLayer) &&
    (options.colorGlyphs !== 'none' || layout.requests.some((request) => request.shape?.bitmap))
  const colorEnabled = usesColor(snapshot)
  const runMotion = needsRunMotion(snapshot) || hasExtras
  const maxSeq = (s: DomLayoutSnapshot): number =>
    s.glyphs.reduce((max, glyph) => Math.max(max, glyph.sequence), 0)
  const globalSequence = hasExtras ? maxSeq(snapshot) : maxSequence
  let textMaterial: GlyphTextMaterial
  try {
    textMaterial = isWindfoilBackend(backend)
      ? backend.createMaterial({
          ...materialOptions,
          maxSequence: hasExtras ? globalSequence : maxSequence,
          motion: materialMotion(motion),
        })
      : new SdfTextMaterial({
          ...materialOptions,
          runMotion,
          ...(colorEnabled ? { colorLayer: backend.colorLayer! } : {}),
          atlas: backend.texture,
          atlasWidth: backend.width,
          atlasHeight: backend.height,
          pxRange: backend.pxRange,
          // The size the atlas was really baked at, which an adaptive bake may have lowered.
          bakeSize: backend.bakeSize,
          shapeTop: backend.shapeTop,
          maxSequence,
          motion: materialMotion(motion),
        })
  } catch (error) {
    glyphGeometry.dispose()
    throw error
  }
  // Made before the text mesh. The parts of one text share its depth, where three draws in
  // creation order: an effects underlay at the text's render order goes under it, while
  // separate texts still sort by depth.
  let extras: ReturnType<typeof createExtraTextParts> | undefined
  try {
    if (hasExtras && isWindfoilBackend(backend))
      extras = makeExtraParts!(snapshot, backend, materialOptions, materialMotion(motion), strength)
  } catch (error) {
    glyphGeometry.dispose()
    textMaterial.dispose()
    throw error
  }
  const text = new Mesh(glyphGeometry, textMaterial)
  text.name = 'ultra-text text'
  text.castShadow = options.castShadow !== false
  text.frustumCulled = false
  text.renderOrder = 2
  text.matrixAutoUpdate = false
  text.updateMatrix()
  group.add(text)

  const ownedMeshes: Mesh[] = [text]
  const disposeMeshes = (): void => {
    for (const mesh of ownedMeshes) {
      mesh.geometry.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        material.dispose()
    }
    ownedMeshes.length = 0
    group.clear()
  }
  try {
    if (extras) {
      for (const mesh of extras.meshes) {
        group.add(mesh)
        ownedMeshes.push(mesh)
      }
      extras.mergeRects(snapshot, text.geometry)
    }
  } catch (error) {
    disposeMeshes()
    throw error
  }
  let decorations: Mesh<InstancedBufferGeometry, TextDecorationMaterial> | null = null
  const glyphDrawable = (retained: RetainedTextBackend, key: string): boolean => {
    if (isWindfoilBackend(retained))
      return (
        (retained.glyphs.get(key)?.monotonePieceCount ?? 0) > 0 ||
        !!retained.companion?.glyphs.has(key)
      )
    return retained.glyphs.has(key)
  }
  const prepareDecorations = (
    layout: DomLayoutSnapshot,
    retained: RetainedTextBackend,
    liveMotion: SdfMotionOptions,
    nextTextGeometry: InstancedBufferGeometry,
    nextSequence: number,
    drawable: (key: string) => boolean = (key) => glyphDrawable(retained, key),
  ): readonly [InstancedBufferGeometry | null, TextDecorationMaterial | null] => {
    const geometry = createDecorationGeometry(
      layout,
      nextTextGeometry,
      drawable,
      liveMotion.strength ?? 18,
    )
    try {
      return [
        geometry,
        geometry && !decorations
          ? new TextDecorationMaterial({
              textShaping: options.textShaping ?? 'none',
              side: options.side,
              vertex: options.vertex,
              motion: materialMotion(liveMotion),
              maxSequence: nextSequence,
            })
          : null,
      ]
    } catch (error) {
      geometry?.dispose()
      throw error
    }
  }
  const commitDecorations = (
    [geometry, material]: ReturnType<typeof prepareDecorations>,
    liveMotion: SdfMotionOptions,
  ): void => {
    if (!geometry) {
      if (decorations) {
        group.remove(decorations)
        ownedMeshes.splice(ownedMeshes.indexOf(decorations), 1)
        decorations.geometry.dispose()
        decorations.material.dispose()
        decorations = null
      }
      return
    }
    if (decorations) {
      const previous = decorations.geometry
      decorations.geometry = geometry
      previous.dispose()
      if (animated) decorations.material.setMotion(liveMotion)
      decorations.material.maxSequence.value = textMaterial.maxSequence.value
    } else {
      decorations = new Mesh(geometry, material!)
      decorations.name = 'ultra-text text decorations'
      decorations.castShadow = options.castShadow !== false
      decorations.renderOrder = 3
      decorations.frustumCulled = false
      group.add(decorations)
      ownedMeshes.push(decorations)
    }
  }
  const updateDecorations = (
    layout: DomLayoutSnapshot,
    retained: RetainedTextBackend,
    liveMotion: SdfMotionOptions,
    drawable: (key: string) => boolean = (key) => glyphDrawable(retained, key),
  ): void => {
    if (!decorations) return
    if (
      updateDecorationGeometry(
        decorations.geometry,
        layout,
        text.geometry,
        drawable,
        liveMotion.strength ?? 18,
      )
    ) {
      if (animated) decorations.material.setMotion(liveMotion)
      decorations.material.maxSequence.value = textMaterial.maxSequence.value
      return
    }
    commitDecorations(
      prepareDecorations(
        layout,
        retained,
        liveMotion,
        text.geometry,
        textMaterial.maxSequence.value,
        drawable,
      ),
      liveMotion,
    )
  }
  const addRects = (receiver: boolean, name: string): Mesh | null => {
    const geometry = createRectGeometry(snapshot, receiver)
    if (!geometry) return null
    let mesh: Mesh
    try {
      mesh = new Mesh(geometry, createRectMaterial(receiver, options.shadowFloor))
    } catch (error) {
      geometry.dispose()
      throw error
    }
    mesh.name = name
    mesh.receiveShadow = receiver
    mesh.frustumCulled = true
    mesh.renderOrder = 0
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    group.add(mesh)
    ownedMeshes.push(mesh)
    return mesh
  }
  let plainRects: Mesh | null = null
  let receivers: Mesh | null = null
  try {
    const initialDecorations = prepareDecorations(
      snapshot,
      backend,
      motion,
      text.geometry,
      textMaterial.maxSequence.value,
    )
    if (initialDecorations[0]) commitDecorations(initialDecorations, motion)
    plainRects = addRects(false, 'ultra-text DOM rectangles')
    receivers = addRects(true, 'ultra-text shadow receivers')
  } catch (error) {
    disposeMeshes()
    throw error
  }

  const swapGeometry = (mesh: Mesh, geometry: InstancedBufferGeometry): void => {
    const previous = mesh.geometry
    mesh.geometry = geometry
    previous.dispose()
  }

  // The bundle's text materials were built from one tone, so they accept or refuse together.
  const setTone = (next: ResolvedTextTone | null): boolean => {
    if (!textMaterial.setTone(next)) return false
    for (const mesh of extras?.meshes ?? []) mesh.material.setTone(next)
    return true
  }
  /** Whether `setTone` would accept this tone, without writing it. */
  const toneFits = (next: ResolvedTextTone | null): boolean => {
    const current = textMaterial.tone
    return current && next ? current.fits(next) : !current && !next
  }

  let disposed = false
  return {
    g: group,
    get m(): GlyphTextMaterial {
      return textMaterial
    },
    get a(): boolean {
      return animated
    },
    sm(change, live) {
      if (animated) {
        textMaterial.setMotion(change)
        extras?.setMotion(change)
        decorations?.material.setMotion(change)
        return
      }
      if (!isAnimatedMotion(live)) return
      const meshes: Mesh<InstancedBufferGeometry, GlyphTextMaterial>[] = [
        text,
        ...(extras?.meshes ?? []),
        ...(decorations ? [decorations] : []),
      ]
      const twins: GlyphTextMaterial[] = []
      try {
        for (const mesh of meshes) twins.push(mesh.material.withMotion(live))
      } catch (error) {
        for (const twin of twins) twin.dispose()
        throw error
      }
      meshes.forEach((mesh, index) => {
        const previous = mesh.material
        mesh.material = twins[index]!
        previous.dispose()
      })
      textMaterial = twins[0]!
      animated = true
    },
    st: setTone,
    ud: updateDecorations,
    get tg(): InstancedBufferGeometry {
      return text.geometry
    },
    rg(geometry: InstancedBufferGeometry): void {
      swapGeometry(text, geometry)
    },
    u(
      nextSnapshot: DomLayoutSnapshot,
      nextBackend: RetainedTextBackend,
      liveMotion: SdfMotionOptions,
      nextTone?: ResolvedTextTone | null,
    ) {
      if (
        nextTone !== undefined &&
        (!toneFits(nextTone) || animated !== isAnimatedMotion(liveMotion))
      )
        return false
      if (runMotion !== (needsRunMotion(nextSnapshot) || hasExtras)) return false
      if (colorEnabled !== usesColor(nextSnapshot)) return false
      const wantsPlain = nextSnapshot.rects.some((rect) => !rect.receiveShadow)
      const wantsReceivers = nextSnapshot.rects.some((rect) => rect.receiveShadow)
      if (wantsPlain !== (plainRects !== null) || wantsReceivers !== (receivers !== null)) {
        return false
      }
      const strength = liveMotion.strength ?? 18
      const drawable = (key: string): boolean => glyphDrawable(nextBackend, key)
      const decorationsFit = canUpdateDecorationGeometry(
        decorations?.geometry ?? null,
        nextSnapshot,
        drawable,
      )
      if (hasExtras && !decorationsFit) return false
      const glyphsFit =
        decorationsFit &&
        (isWindfoilBackend(nextBackend)
          ? nextBackend.contentFits(text.geometry, nextSnapshot)
          : glyphContentFits(text.geometry, nextSnapshot, nextBackend))
      const plainFit =
        !plainRects ||
        rectContentFits(plainRects.geometry as InstancedBufferGeometry, nextSnapshot, false)
      const receiverFit =
        !receivers ||
        rectContentFits(receivers.geometry as InstancedBufferGeometry, nextSnapshot, true)
      let built: { geometry: InstancedBufferGeometry; maxSequence: number } | null = null
      let nextParts: readonly (InstancedBufferGeometry | null)[] = []
      let nextPlain: InstancedBufferGeometry | null = null
      let nextReceivers: InstancedBufferGeometry | null = null
      let nextDecorations: ReturnType<typeof prepareDecorations> | null = null
      const releaseStaged = (): void => {
        built?.geometry.dispose()
        for (const geometry of nextParts) geometry?.dispose()
        nextPlain?.dispose()
        nextReceivers?.dispose()
        nextDecorations?.[0]?.dispose()
        nextDecorations?.[1]?.dispose()
      }
      try {
        nextParts = extras?.prepare(nextSnapshot, strength) ?? []
        if (!glyphsFit) built = buildGlyphGeometry(nextSnapshot, nextBackend, strength)
        if (plainRects && !plainFit) nextPlain = createRectGeometry(nextSnapshot, false)
        if (receivers && !receiverFit) nextReceivers = createRectGeometry(nextSnapshot, true)
        if (!decorationsFit) {
          const source = built?.geometry ?? text.geometry
          nextDecorations = prepareDecorations(
            nextSnapshot,
            nextBackend,
            liveMotion,
            source,
            built?.maxSequence ?? textMaterial.maxSequence.value,
            drawable,
          )
        }
      } catch (error) {
        releaseStaged()
        throw error
      }
      if (built) {
        swapGeometry(text, built.geometry)
        textMaterial.maxSequence.value = built.maxSequence
      } else {
        const maxSequence = isWindfoilBackend(nextBackend)
          ? nextBackend.updateGeometry(text.geometry, nextSnapshot, strength)
          : updateGlyphContent(text.geometry, nextSnapshot, nextBackend, strength, undefined, true)
        if (maxSequence === null) {
          releaseStaged()
          throw new Error('DomSdf: glyph buffers changed during the update')
        }
        textMaterial.maxSequence.value = maxSequence
      }
      if (extras) {
        extras.commit(nextParts, nextSnapshot, strength)
        textMaterial.maxSequence.value = maxSeq(nextSnapshot)
        extras.mergeRects(nextSnapshot, text.geometry)
      }
      if (nextDecorations) commitDecorations(nextDecorations, liveMotion)
      else updateDecorations(nextSnapshot, nextBackend, liveMotion, drawable)
      if (plainRects && nextPlain) swapGeometry(plainRects, nextPlain)
      else if (plainRects)
        updateRectGeometry(plainRects.geometry as InstancedBufferGeometry, nextSnapshot, false)
      if (receivers && nextReceivers) swapGeometry(receivers, nextReceivers)
      else if (receivers)
        updateRectGeometry(receivers.geometry as InstancedBufferGeometry, nextSnapshot, true)
      if (nextTone !== undefined) setTone(nextTone)
      return true
    },
    d(): void {
      if (disposed) return
      disposed = true
      disposeMeshes()
    },
  }
}

export class DomSdf extends Group {
  readonly renderer: WebGPURenderer
  readonly source: HTMLElement
  readonly options: Readonly<DomSdfOptions>
  protected readonly pageBackdrop: boolean = true

  #r: RetainedTextBackend | null = null
  #o = false
  #c: ContentBundle | null = null
  #a: AbortController | null = null
  #g = 0
  #d = false
  #f = 0
  #t = 0
  #dl = 0
  #fa = false
  #ro: ResizeObserver | null = null
  #mo: MutationObserver | null = null
  #uf: (() => void) | null = null
  private snapshot: DomLayoutSnapshot | null = null
  #w = 0
  #h = 0
  #as = ''
  #ls = ''
  #cm = false
  #ga = false
  #ac: Promise<typeof AppendAtlas | null> | undefined
  #st: Readonly<DomSdfStats> = EMPTY_STATS
  #m: SdfMotionOptions
  #to: TracedOutlines | null = null

  protected constructor(renderer: WebGPURenderer, source: HTMLElement, options: DomSdfOptions) {
    super()
    this.name = 'ultra-text DOM SDF'
    this.renderer = renderer
    this.source = source
    const copy = { ...options }
    for (const key of [
      'motion',
      'windfoil',
      'slug',
      'svg',
      'tone',
      'outline',
      'dropShadow',
    ] as const) {
      if (typeof copy[key] === 'object')
        (copy as Record<string, unknown>)[key] = Object.freeze({ ...copy[key] })
    }
    this.options = Object.freeze(copy)
    this.#m = { ...options.motion }
    if (options.selectable) this.source.classList.add('sdf-selectable')
  }

  static async create(
    renderer: WebGPURenderer,
    source: HTMLElement,
    options: DomSdfOptions = {},
  ): Promise<DomSdf> {
    const domSdf = new DomSdf(renderer, source, options)
    await domSdf.initialize()
    return domSdf
  }

  protected async initialize(): Promise<void> {
    try {
      await this.rebuild({ atlas: true })
      this.#co()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  get width(): number {
    return this.#c ? this.#w : 0
  }

  get height(): number {
    return this.#c ? this.#h : 0
  }

  get stats(): Readonly<DomSdfStats> {
    return this.#st
  }

  get atlasTexture(): SdfAtlas['texture'] | null {
    const retained = this.#r
    return retained
      ? isWindfoilBackend(retained)
        ? (retained.companion?.texture ?? null)
        : retained.texture
      : null
  }

  setMotion(options: SdfMotionOptions): this {
    const motion = { ...this.#m, ...options }
    this.#c?.sm(options, motion)
    this.#m = motion
    return this
  }

  reflow(width: number): this {
    if (this.#d) throw new Error('DomSdf.reflow: this instance is disposed')
    if (!this.snapshot) {
      throw new Error('DomSdf.reflow: create the instance with reflowable: true first')
    }
    if (!this.#r || !this.#c) return this
    const retained = this.#r
    const content = this.#c
    if (isWindfoilBackend(retained)) retained.setGlyphEm(!!content.m.tone?.dilates)

    const started = now()
    const reflowed = reflowSnapshot(this.snapshot, width)
    const strength = this.#m.strength ?? 18
    if (isWindfoilBackend(retained) && (retained.companion || retained.color)) {
      if (!content.u(reflowed, retained, this.#m))
        throw new Error('DomSdf.reflow: incompatible retained content')
    } else {
      let maxSequence = isWindfoilBackend(retained)
        ? retained.updateGeometry(content.tg, reflowed, strength)
        : updateGlyphGeometry(content.tg, reflowed, retained, strength)
      if (maxSequence === null) {
        const built = buildGlyphGeometry(reflowed, retained, strength)
        content.rg(built.geometry)
        maxSequence = built.maxSequence
      }
      content.m.maxSequence.value = maxSequence
      content.ud(reflowed, retained, this.#m)
    }
    this.#cm = false
    this.#w = reflowed.width
    this.#h = reflowed.height
    this.#st = Object.freeze({
      ...this.#st,
      lines: reflowed.lineCount,
      layoutReadMs: 0,
      atlasBuildMs: 0,
      geometryBuildMs: now() - started,
    })
    return this
  }

  async rebuild(rebuildOptions: DomSdfRebuildOptions = {}): Promise<void> {
    if (this.#d) throw new Error('DomSdf.rebuild: this instance is disposed')
    const externalSignal = this.options.signal
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? abortError()
    }

    this.#a?.abort(abortError('Superseded by a newer DOM SDF build'))
    const controller = new AbortController()
    this.#a = controller
    const generation = ++this.#g
    const forwardAbort = (): void => {
      controller.abort(externalSignal?.reason ?? abortError())
    }
    externalSignal?.addEventListener('abort', forwardAbort, { once: true })

    let nextRetained: RetainedTextBackend | null = null
    let ownsNextRetained = false
    let appended = false
    let nextContent: ContentBundle | null = null
    try {
      await Promise.resolve()
      throwIfAborted(controller.signal)
      if (generation !== this.#g) {
        throw abortError('Superseded by a newer DOM SDF build')
      }

      const opts = this.options
      const gpuUpload =
        opts.atlasMode !== 'cpu' &&
        this.renderer.initialized &&
        (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      const backendKind = opts.textBackend
      const isAnalyticOption = backendKind === 'windfoil' || backendKind === 'slug'
      if (gpuUpload && !isAnalyticOption && !this.#r) prepareAtlasPasses(this.renderer)

      const layoutStarted = now()
      const snapshot = await collectDomSnapshot(this.source, opts)
      const tone = resolveDomTextTone(this.source, opts.tone, {
        glyphs: snapshot.glyphs,
        rects: snapshot.rects,
        rootRect:
          opts.includeRootBackground !== false ||
          this.source.matches(opts.rectSelector ?? DEFAULT_RECT_SELECTOR),
        page: this.pageBackdrop,
      })
      const layoutReadMs = now() - layoutStarted
      throwIfAborted(controller.signal)

      let bitmap: boolean | undefined
      const atlasCovers = (atlas: SdfAtlas): boolean => {
        if (opts.colorGlyphs === 'none') {
          bitmap ??= snapshot.requests.some((request) => request.shape?.bitmap)
        }
        return snapshot.requests.every((request) => {
          const slot = atlas.glyphs.get(request.key)
          return (
            slot !== undefined &&
            !(opts.colorGlyphs === 'none' && bitmap && !request.shape && slot.color) &&
            (!isColorCandidate(request, opts.colorGlyphs) || slot.color !== undefined)
          )
        })
      }
      const retained = this.#r
      const canReuseRetainedText =
        rebuildOptions.atlas !== true &&
        retained !== null &&
        (this.#as === snapshot.atlasSignature ||
          (isWindfoilBackend(retained)
            ? snapshot.requests.every((request) => retained.covers(request.key))
            : atlasCovers(retained)))
      const signature = layoutSignatureOf(snapshot)
      if (
        canReuseRetainedText &&
        this.#c !== null &&
        this.#cm &&
        signature === this.#ls &&
        generation === this.#g &&
        this.#c.st(tone)
      ) {
        this.#st = Object.freeze({
          ...this.#st,
          layoutReadMs,
          atlasBuildMs: 0,
          geometryBuildMs: 0,
        })
        if (opts.svg) this.#om()
        return
      }

      let atlasBuildMs = 0
      const sharedAtlas = isAnalyticOption ? undefined : opts.sharedAtlas
      const sharedCovers = sharedAtlas !== undefined && atlasCovers(sharedAtlas)
      if (canReuseRetainedText) {
        nextRetained = retained
      } else if (sharedCovers) {
        nextRetained = sharedAtlas
        ownsNextRetained = false
      } else {
        const atlasStarted = now()
        const appendTo =
          !isAnalyticOption &&
          rebuildOptions.atlas !== true &&
          this.#o &&
          retained &&
          !isWindfoilBackend(retained)
            ? retained
            : null
        const chunk =
          appendTo && (await (this.#ac ??= import('../atlas/appendAtlas.js').catch(() => null)))
        if (appendTo && chunk) {
          this.#ga = true
          nextRetained = await chunk.appendGlyphs(
            this.renderer,
            this.source.ownerDocument,
            appendTo,
            snapshot.requests,
            opts,
            controller.signal,
          )
          appended = !!nextRetained
        }
        const previousAtlas =
          rebuildOptions.atlas !== true &&
          retained !== null &&
          !isWindfoilBackend(retained) &&
          retained !== opts.sharedAtlas
            ? retained
            : undefined
        const buildAtlas = async (
          requests: DomLayoutSnapshot['requests'],
          signal: AbortSignal,
          appendable?: RasterizeOptions['appendable'],
        ): Promise<SdfAtlas> => {
          const def = <K extends keyof DomSdfOptions>(...ks: K[]) =>
            Object.fromEntries(ks.flatMap((k) => (opts[k] === undefined ? [] : [[k, opts[k]]])))
          const raster = await rasterizeGlyphAtlas(this.source.ownerDocument, requests, {
            signal,
            previousAtlas,
            appendable,
            ...(gpuUpload ? { gpuUpload } : {}),
            ...def('colorGlyphs', 'bakeSize', 'padding', 'maxAtlasSize', 'adaptiveBakeSize'),
          })
          return buildSdfAtlas(this.renderer, raster, {
            signal,
            mipmaps: opts.quality === 'high',
            anisotropy: opts.quality === 'high' ? 4 : 1,
            ...(opts.atlasMode === undefined ? {} : { mode: opts.atlasMode }),
            ...def('cpuWorker'),
          })
        }
        if (!appended && isAnalyticOption && opts.textShaping !== 'browser') {
          const analytic =
            (backendKind === 'slug' ? (opts.slug ?? opts.windfoil) : opts.windfoil) ?? {}
          const outlineProvider: unknown = analytic.outlineProvider
          if (outlineProvider !== undefined && typeof outlineProvider !== 'function') {
            throw new TypeError(
              `DomSdf: textBackend "${backendKind}" requires ${backendKind}.outlineProvider`,
            )
          }
          let resolved: WindfoilBuildOptions
          if (analytic.outlineProvider) {
            resolved = { ...analytic, outlineProvider: analytic.outlineProvider }
          } else {
            if (!this.#to) {
              const { createTracedOutlineProvider } = await import('../windfoil/tracedOutlines.js')
              throwIfAborted(controller.signal)
              this.#to ??= createTracedOutlineProvider(
                this.source.ownerDocument,
                opts.colorGlyphs === undefined ? {} : { colorGlyphs: opts.colorGlyphs },
              )
            } else if (rebuildOptions.atlas === true) {
              this.#to.clear()
            }
            resolved = {
              ...analytic,
              fallback: analytic.fallback ?? 'sdf-glyphs',
              outlineProvider: this.#to.provider,
            }
          }
          const build =
            backendKind === 'slug'
              ? (await import('../slug/runtime.js')).buildSlugBackend
              : (await import('../windfoil/runtime.js')).buildWindfoilBackend
          nextRetained = await build(
            this.renderer,
            snapshot.requests,
            resolved,
            controller.signal,
            { build: buildAtlas, effects: opts },
          )
        }
        if (!appended) {
          nextRetained ??= await buildAtlas(
            snapshot.requests,
            controller.signal,
            this.#ga ? 'headroom' : true,
          )
          ownsNextRetained = true
        }
        atlasBuildMs = now() - atlasStarted
      }
      throwIfAborted(controller.signal)
      if (generation !== this.#g || !nextRetained) {
        throw abortError('Superseded by a newer DOM SDF build')
      }

      const geometryStarted = now()
      if (isWindfoilBackend(nextRetained)) nextRetained.setGlyphEm(!!tone?.dilationPx)
      const updatedInPlace =
        (canReuseRetainedText || appended) &&
        (this.#c?.u(snapshot, nextRetained, this.#m, tone) ?? false)
      if (!updatedInPlace) {
        const extra =
          isWindfoilBackend(nextRetained) && (nextRetained.companion || nextRetained.color)
            ? await import('../windfoil/mixed.js')
            : undefined
        throwIfAborted(controller.signal)
        nextContent = createContent(
          snapshot,
          nextRetained,
          opts,
          this.#m,
          tone,
          extra?.createExtraTextParts,
        )
      }
      const geometryBuildMs = now() - geometryStarted
      throwIfAborted(controller.signal)

      const oldContent = this.#c
      const oldRetained = this.#r
      let activeContent: ContentBundle
      if (nextContent) {
        if (oldContent) this.remove(oldContent.g)
        this.add(nextContent.g)
        this.#c = nextContent
        activeContent = nextContent
      } else {
        activeContent = oldContent!
      }
      const ownedPrevious = this.#o
      this.#r = nextRetained
      this.#o = canReuseRetainedText || appended ? ownedPrevious : ownsNextRetained
      this.snapshot = opts.reflowable === true ? snapshot : null
      this.#w = snapshot.width
      this.#h = snapshot.height
      this.#as = snapshot.atlasSignature
      this.#ls = signature
      this.#cm = true
      if (opts.svg) this.#om()
      this.#to?.retain(snapshot.requests.map((request) => request.key))
      const windfoil = isWindfoilBackend(nextRetained) ? nextRetained : null
      const atlas = windfoil ? windfoil.companion : (nextRetained as SdfAtlas)
      const glyphs = atlas?.glyphs
      const switchKeys = windfoil?.sizeSwitch?.keys
      let glyphCount = 0
      let shapeCount = 0
      let colorGlyphCount = 0
      let fallbackGlyphCount = 0
      let switchableGlyphCount = 0
      for (const glyph of snapshot.glyphs) {
        if (switchKeys?.has(glyph.glyphKey)) switchableGlyphCount++
        if (glyph.shapeGroup !== undefined) {
          shapeCount++
          continue
        }
        glyphCount++
        const slot = glyphs?.get(glyph.glyphKey)
        if (slot && !windfoil?.analyticCovers(glyph.glyphKey)) {
          if (slot.color) colorGlyphCount++
          if (windfoil) fallbackGlyphCount++
        }
      }
      this.#st = Object.freeze({
        atlasBuildMs,
        layoutReadMs,
        geometryBuildMs,
        glyphs: glyphCount,
        shapes: shapeCount,
        colorGlyphs: colorGlyphCount,
        fallbackGlyphs: fallbackGlyphCount,
        switchableGlyphs: switchableGlyphCount,
        rects: snapshot.rects.length,
        lines: snapshot.lineCount,
        draws: activeContent.g.children.length,
        atlasWidth: atlas?.width ?? 0,
        atlasHeight: atlas?.height ?? 0,
        textBackend: windfoil ? windfoil.kind : ('sdf' as const),
        atlasMode: atlas?.mode ?? null,
        textStorageBytes:
          (windfoil?.storageBytes ?? 0) +
          (atlas ? sdfStorageBytes(atlas, opts.quality === 'high') : 0),
      })
      nextContent = null
      ownsNextRetained = false
      if (oldContent && oldContent !== activeContent) oldContent.d()
      if (oldRetained && oldRetained !== nextRetained && ownedPrevious && !appended) {
        oldRetained.dispose()
      }
    } catch (error) {
      nextContent?.d()
      if (ownsNextRetained) nextRetained?.dispose()
      throw error
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort)
      if (this.#a === controller) this.#a = null
    }
  }

  #sr(forceAtlas = false, lazy = false): void {
    if (this.#d) return
    this.#fa ||= forceAtlas
    const view = this.source.ownerDocument.defaultView
    if (!view) return
    if (lazy && this.#f === 0) {
      const nowMs = now()
      if (this.#t !== 0) view.clearTimeout(this.#t)
      else this.#dl = nowMs + ATTRIBUTE_MAX_WAIT_MS
      const delay = Math.min(ATTRIBUTE_DEBOUNCE_MS, Math.max(0, this.#dl - nowMs))
      this.#t = view.setTimeout(() => {
        this.#t = 0
        this.#rr()
      }, delay)
      return
    }
    if (this.#t !== 0) {
      view.clearTimeout(this.#t)
      this.#t = 0
    }
    if (this.#f !== 0) return
    this.#f = view.requestAnimationFrame(() => {
      this.#f = 0
      this.#rr()
    })
  }

  #rr(): void {
    const atlas = this.#fa
    this.#fa = false
    void this.rebuild({ atlas }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.options.onError?.(error)
    })
  }

  #co(): void {
    if (this.options.observe === false || this.#d) return
    const view = this.source.ownerDocument.defaultView
    if (!view) return

    this.#ro = new ResizeObserver(() => {
      this.#sr()
    })
    this.#ro.observe(this.source)
    this.#mo = new MutationObserver((records) => {
      this.#sr(
        false,
        records.every((record) => record.type === 'attributes'),
      )
    })
    this.#om()

    const fonts = this.source.ownerDocument.fonts as FontFaceSet | undefined
    if (fonts) {
      const onFontsLoaded = (): void => {
        this.#to?.clear()
        this.#sr(true)
      }
      fonts.addEventListener('loadingdone', onFontsLoaded)
      this.#uf = () => {
        fonts.removeEventListener('loadingdone', onFontsLoaded)
      }
    }
  }

  #om(): void {
    const observer = this.#mo
    if (!observer) return
    observer.disconnect()
    const options = { attributes: true, characterData: true, childList: true, subtree: true }
    observer.observe(this.source, options)
    if (!this.options.svg) return
    const seen = new Set<Element>([this.source])
    const pending: Element[] = [this.source]
    while (pending.length) {
      const source = pending.pop()!
      const uses = [...source.querySelectorAll('use')]
      if (source.localName === 'use') uses.unshift(source as SVGUseElement)
      for (const use of uses) {
        const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? ''
        const tree = use.getRootNode() as Document | ShadowRoot
        const target = href.startsWith('#') ? tree.getElementById(href.slice(1)) : null
        if (!target || seen.has(target)) continue
        seen.add(target)
        if (!this.source.contains(target)) observer.observe(target, options)
        pending.push(target)
      }
    }
  }

  override dispose(): void {
    if (this.#d) return
    this.#d = true
    this.#g++
    this.#a?.abort(abortError('The DOM SDF instance was disposed'))
    const view = this.source.ownerDocument.defaultView
    if (view && this.#f !== 0) view.cancelAnimationFrame(this.#f)
    if (view && this.#t !== 0) view.clearTimeout(this.#t)
    this.#ro?.disconnect()
    this.#mo?.disconnect()
    this.#uf?.()
    if (this.#c) {
      this.remove(this.#c.g)
      this.#c.d()
    }
    if (this.#o) this.#r?.dispose()
    this.#to?.clear()
    this.#a = this.#ro = this.#mo = this.#uf = this.#c = this.#r = this.#to = this.snapshot = null
    this.#f = this.#t = this.#w = this.#h = 0
    this.#o = this.#cm = false
    this.#as = this.#ls = ''
    this.#st = EMPTY_STATS
    this.source.classList.remove('sdf-selectable')
    this.clear()
    super.dispose()
  }
}
