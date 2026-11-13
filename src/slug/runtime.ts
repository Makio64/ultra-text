import { WebGPUBackend, type WebGPURenderer } from 'three/webgpu'
import type { DomLayoutSnapshot, GlyphRequest, SdfAtlas } from '../types.js'
import type { WindfoilColorResources } from '../windfoil/color.js'
import {
  createWindfoilGlyphGeometry,
  updateWindfoilGlyphGeometry,
  windfoilContentFits,
} from '../windfoil/geometry.js'
import type { WindfoilBackend, WindfoilBuildOptions } from '../windfoil/runtime.js'
import {
  abortable,
  createWindfoilStorage,
  drawnEffects,
  throwIfAborted,
  type TextEffects,
} from '../windfoil/storage.js'
import { preprocessSlugGlyphs } from './preprocessCore.js'
import { SlugMaterial } from './SlugMaterial.js'

/** All asynchronous resolution completes before retaining GPU storage. */
export async function buildSlugBackend(
  renderer: WebGPURenderer,
  requests: readonly GlyphRequest[],
  options: WindfoilBuildOptions,
  signal: AbortSignal,
  companionBuilder?: {
    build(requests: readonly GlyphRequest[], signal: AbortSignal): Promise<SdfAtlas>
    /** The caller's outline and drop shadow, which the companion then bakes every glyph for. */
    readonly effects?: TextEffects
  },
): Promise<WindfoilBackend | null> {
  const sdfBelow = options.sdfBelowPx
  const switchModule =
    sdfBelow === undefined ? null : await abortable(import('../windfoil/sizeSwitch.js'), signal)
  switchModule?.assertThreshold(sdfBelow)
  await abortable(renderer.init(), signal)
  throwIfAborted(signal)
  const fallback = options.fallback === 'sdf' || options.fallback === 'sdf-glyphs'
  if (!(renderer.backend instanceof WebGPUBackend)) {
    if (fallback) return null
    throw new Error(
      'DomSdf: the Slug text backend requires WebGPU; set slug.fallback to "sdf" to fall back',
    )
  }
  const limit =
    (renderer.backend as unknown as { device?: { limits: { maxVertexBuffers: number } } }).device
      ?.limits.maxVertexBuffers ?? 8
  if (limit < 7) {
    if (fallback) return null
    throw new Error('DomSdf: Slug requires at least seven vertex buffers')
  }
  const effects = companionBuilder?.effects ? drawnEffects(companionBuilder.effects) : null
  const extended =
    !!effects ||
    requests.some((request) => request.shape) ||
    options.fallback === 'sdf-glyphs' ||
    options.compositing === 'shader' ||
    sdfBelow !== undefined
  let extensions = extended ? await abortable(import('../windfoil/requests.js'), signal) : null
  let resolved: {
    request: GlyphRequest
    outline: Awaited<ReturnType<typeof options.outlineProvider>>
  }[]
  if (extensions) {
    resolved = await abortable(
      Promise.all(
        requests.map(async (request) => ({
          request,
          outline: await extensions!.resolveShapeRequest(request, options, signal),
        })),
      ),
      signal,
    )
  } else {
    const syncResolved: {
      request: GlyphRequest
      outline: Awaited<ReturnType<typeof options.outlineProvider>>
    }[] = []
    let pending:
      | Promise<{
          request: GlyphRequest
          outline: Awaited<ReturnType<typeof options.outlineProvider>>
        }>[]
      | null = null
    for (const request of requests) {
      const out = options.outlineProvider(request, signal)
      if (out instanceof Promise) {
        pending ??= syncResolved.map((item) => Promise.resolve(item))
        pending.push(out.then((outline) => ({ request, outline })))
      } else if (pending) {
        pending.push(Promise.resolve({ request, outline: out }))
      } else {
        syncResolved.push({ request, outline: out })
      }
    }
    resolved = pending ? await abortable(Promise.all(pending), signal) : syncResolved
  }
  throwIfAborted(signal)
  const missing = resolved.filter((item) => item.outline === null)
  if (missing.length) {
    if (
      options.fallback === 'sdf' ||
      (options.fallback === 'sdf-glyphs' && missing.length === resolved.length)
    )
      return null
    if (options.fallback !== 'sdf-glyphs' || !companionBuilder)
      throw new Error(
        `DomSdf: Slug outlineProvider returned null for ${JSON.stringify(missing[0]!.request.character)} in ${missing[0]!.request.font.family}`,
      )
  }
  const needsRequests = !extensions && resolved.some((item) => item.outline?.clipBox)
  const needsLayerNormalization = resolved.some(
    (item) => item.outline?.layers !== undefined || item.outline?.clipBox !== undefined,
  )
  const [lateExtensions, layerModule] =
    needsRequests || needsLayerNormalization
      ? await abortable(
          Promise.all([
            needsRequests ? import('../windfoil/requests.js') : Promise.resolve(null),
            needsLayerNormalization
              ? import('../windfoil/layerNormalization.js')
              : Promise.resolve(null),
          ]),
          signal,
        )
      : [null, null]
  extensions ??= lateExtensions
  // Composite shader path (`compositing: 'shader'` or `clipBox`) uses Windfoil's layer grid;
  // layered instances (default) and standard text use Ultra-Slug's dual-band preprocessing.
  const prepared = preprocessSlugGlyphs(
    resolved.filter(
      (item): item is typeof item & { outline: NonNullable<typeof item.outline> } =>
        item.outline !== null,
    ),
    {
      signal,
      ...(layerModule ? { normalizeLayers: layerModule.normalizeLayers } : {}),
      ...(options.targetPiecesPerBand === undefined
        ? {}
        : { targetPiecesPerBand: options.targetPiecesPerBand }),
    },
  )
  const switchable = companionBuilder
    ? (switchModule?.switchableRequests(resolved, prepared.glyphs) ?? [])
    : []
  // Effects bake every drawable outline for the underlay; an empty one is drawn by nothing.
  const companionReqs = effects
    ? resolved.flatMap((i) =>
        prepared.glyphs.get(i.request.key)?.monotonePieceCount ? [i.request] : [],
      )
    : switchable
  const layered = prepared.layered || missing.length > 0 || companionReqs.length > 0
  if (layered && limit < 8) {
    if (fallback) return null
    throw new Error('DomSdf: layered Slug requires eight vertex buffers')
  }
  const wantsColor = [...prepared.glyphs.values()].some(
    (header) =>
      (header.layers?.some((layer) => layer.paintKind === 2) ?? false) ||
      (header.layers && (options.compositing === 'shader' || !!header.clipBox)),
  )
  const colorPromise = wantsColor ? import('../windfoil/color.js') : null
  const companionResource =
    (missing.length || companionReqs.length) && companionBuilder
      ? await extensions!.buildCompanion(
          companionBuilder,
          [...missing.map((item) => item.request), ...companionReqs],
          signal,
        )
      : null
  let companion = companionResource?.atlas ?? null
  const view =
    companion && switchable.length
      ? switchModule!.companionView(
          companion,
          missing.map((item) => item.request.key),
          switchable,
        )
      : null
  if (view && !effects) {
    companion = view.atlas
    if (!companion) companionResource!.dispose()
  }
  let coverage: ReturnType<typeof createWindfoilStorage> | undefined,
    colorResources: WindfoilColorResources | null = null
  try {
    const colorModule = colorPromise ? await abortable(colorPromise, signal) : null
    throwIfAborted(signal)
    coverage = createWindfoilStorage(renderer, prepared)
    colorResources =
      colorModule?.buildWindfoilColorResources(
        renderer,
        prepared,
        { ...options, compositing: 'layers' },
        coverage,
        signal,
      ) ?? null
    const plainGlyphs = colorResources?.plainGlyphs ?? prepared.glyphs
    const ordinalsCache = new WeakMap<DomLayoutSnapshot, Float32Array>()
    const motionOrdinals = (snapshot: DomLayoutSnapshot): Float32Array => {
      let cached = ordinalsCache.get(snapshot)
      if (!cached) {
        if (extensions) {
          cached = extensions.motionOrdinals(snapshot, prepared.glyphs, companion)
        } else {
          const count = snapshot.glyphs.length
          cached = new Float32Array(count)
          for (let i = 0; i < count; i++) cached[i] = i
        }
        ordinalsCache.set(snapshot, cached)
      }
      return cached
    }
    const sizeSwitch = view?.keys.size
      ? switchModule!.createSizeSwitch(sdfBelow!, view.keys, prepared.glyphs, motionOrdinals)
      : null
    let glyphEm = false
    const sized = new WeakMap<DomLayoutSnapshot, DomLayoutSnapshot>()
    const withEm = (snapshot: DomLayoutSnapshot): DomLayoutSnapshot => {
      let layout = sized.get(snapshot)
      if (!layout) {
        layout = {
          ...snapshot,
          sizeSwitched: true,
          glyphs: snapshot.glyphs.map((glyph) => ({
            ...glyph,
            switchEm: glyph.shapeGroup === undefined ? -glyph.fontSize : 0,
          })),
        }
        sized.set(snapshot, layout)
      }
      return layout
    }
    const switched = (snapshot: DomLayoutSnapshot): DomLayoutSnapshot => {
      const layout = glyphEm ? withEm(snapshot) : snapshot
      return sizeSwitch?.layout(layout) ?? layout
    }
    let geometryLayered = layered,
      disposed = false
    const retained = coverage
    return {
      kind: 'slug',
      layered,
      companion,
      effects,
      color: colorResources?.composite ?? null,
      sizeSwitch,
      motionOrdinals,
      glyphs: prepared.glyphs,
      covers(key) {
        return prepared.glyphs.has(key) || !!companion?.glyphs.has(key)
      },
      primaryCovers(key) {
        return !!plainGlyphs.get(key)?.monotonePieceCount
      },
      analyticCovers(key) {
        return (
          !!plainGlyphs.get(key)?.monotonePieceCount ||
          !!colorResources?.composite?.glyphs.get(key)?.monotonePieceCount
        )
      },
      storageBytes: coverage.storageBytes + (colorResources?.storageBytes ?? 0),
      preprocessStats: prepared.stats,
      contentFits(geometry, snapshot) {
        return windfoilContentFits(geometry, switched(snapshot), plainGlyphs)
      },
      createGeometry(snapshot, padding, ordinals) {
        snapshot = switched(snapshot)
        ordinals ??= companion || colorResources?.composite ? motionOrdinals(snapshot) : undefined
        geometryLayered =
          layered || !!ordinals || snapshot.glyphs.some((glyph) => !!glyph.motionOrigin)
        if (geometryLayered && limit < 8)
          throw new Error('DomSdf: layered Slug requires eight vertex buffers')
        return createWindfoilGlyphGeometry(
          snapshot,
          plainGlyphs,
          padding,
          geometryLayered,
          ordinals,
        )
      },
      updateGeometry(geometry, snapshot, padding, ordinals) {
        snapshot = switched(snapshot)
        ordinals ??= companion || colorResources?.composite ? motionOrdinals(snapshot) : undefined
        return updateWindfoilGlyphGeometry(geometry, snapshot, plainGlyphs, padding, ordinals)
      },
      setGlyphEm(value) {
        glyphEm = value
      },
      createMaterial(materialOptions) {
        return new SlugMaterial({
          ...retained,
          layered: geometryLayered,
          ...(colorResources ? { paintFunctions: colorResources.paintFunctions } : {}),
          ...materialOptions,
          ...(sizeSwitch ? { keepGlyph: sizeSwitch.windfoil } : {}),
        })
      },
      dispose() {
        if (disposed) return
        disposed = true
        retained.dispose()
        colorResources?.dispose()
        companionResource?.dispose()
      },
    }
  } catch (error) {
    coverage?.dispose()
    colorResources?.dispose()
    companionResource?.dispose()
    throw error
  }
}
