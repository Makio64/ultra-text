import type { Node } from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  float,
  length,
  modelViewMatrix,
  uniform,
  vec2,
  vec4,
  viewportSize,
} from 'three/tsl'

import { isEmojiCandidate } from '../dom/clusters.js'
import type { GlyphKeepHook } from '../text/GlyphTextMaterial.js'
import type {
  DomLayoutSnapshot,
  GlyphLayout,
  GlyphRequest,
  SdfAtlas,
  WindfoilGlyphOutline,
} from '../types.js'
import { windfoilGlyphRect } from './geometry.js'
import type { WindfoilGlyphHeader } from './preprocessCore.js'

/**
 * Both batches keep a glyph whose projected em lies in [T, T·OVERLAP). The two pipelines
 * evaluate the same function on bit-identical inputs, but compilers may contract or
 * reassociate differently. While their results agree within 2^-12, a glyph can be drawn twice
 * for a moment but never dropped; on an Apple M3 Max they agreed to about 1e-7 near the
 * origin and 7e-5 a million units out.
 */
const OVERLAP = 1 + 2 ** -12
/** Anchors on or behind the eye plane go to Windfoil; WGSL has no infinity literal. */
const BEHIND_EYE = 3e38

export interface WindfoilSizeSwitch {
  /** Glyph keys drawn by the SDF companion when small and by Windfoil when large. */
  readonly keys: ReadonlySet<string>
  readonly sdf: GlyphKeepHook
  readonly windfoil: GlyphKeepHook
  /** The layout both batches draw: shared motion anchors plus each glyph's switch em. */
  layout(snapshot: DomLayoutSnapshot): DomLayoutSnapshot
}

export function assertThreshold(value: unknown): void {
  // Beyond the sentinel the f32 uniforms stop separating anchors behind the eye.
  if (!(typeof value === 'number' && value > 0 && value * OVERLAP < BEHIND_EYE))
    throw new RangeError('DomSdf: windfoil.sdfBelowPx must be a finite number of pixels above 0')
}

/**
 * The companion atlas as the size switch draws it: glyphs without outlines plus the
 * switchable ones. A switchable glyph whose raster came back as colour ink would change
 * artwork at the switch, so it is left to Windfoil alone. The view shares the atlas, which
 * stays owned by its builder; a null view means nothing is left to draw.
 */
export function companionView(
  atlas: SdfAtlas,
  missing: readonly string[],
  switchable: readonly GlyphRequest[],
): { readonly atlas: SdfAtlas | null; readonly keys: ReadonlySet<string> } {
  const keys = new Set(
    switchable
      .map((request) => request.key)
      .filter((key) => {
        const slot = atlas.glyphs.get(key)
        return !!slot && slot.color !== true
      }),
  )
  const kept = new Set([...missing, ...keys])
  return {
    keys,
    atlas: kept.size
      ? {
          ...atlas,
          glyphs: new Map([...atlas.glyphs].filter(([key]) => kept.has(key))),
          dispose() {
            /* Released by the builder that owns the atlas. */
          },
        }
      : null,
  }
}

/** Plain, drawable, single-paint outlines whose SDF raster shows the same artwork. */
export function switchableRequests(
  resolved: readonly {
    readonly request: GlyphRequest
    readonly outline: WindfoilGlyphOutline | null
  }[],
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
): GlyphRequest[] {
  return resolved.flatMap(({ request, outline }) => {
    const header = outline ? glyphs.get(request.key) : undefined
    return header &&
      header.monotonePieceCount > 0 &&
      !header.layers &&
      !header.clipBox &&
      !isEmojiCandidate(request.character)
      ? [request]
      : []
  })
}

export function createSizeSwitch(
  threshold: number,
  keys: ReadonlySet<string>,
  glyphs: ReadonlyMap<string, WindfoilGlyphHeader>,
  ordinalsOf: (snapshot: DomLayoutSnapshot) => Float32Array,
): WindfoilSizeSwitch {
  const below = uniform(threshold)
  const belowWithOverlap = uniform(threshold * OVERLAP)
  // One layout function, so both pipelines compile the same WGSL for the decision.
  const projectedEm = Fn<
    [Node<'vec4'>, Node<'vec4'>, Node<'vec4'>, Node<'vec2'>, Node<'float'>],
    Node<'float'>
  >(([clip, axisX, axisY, halfViewport, em]) => {
    const w = clip.w
    // Pixels per local unit along each axis (scaled by w²): the quotient rule on clip.xy / clip.w,
    // exact in orthographic and perspective views. Since w² > 0 on the taken branch, factoring
    // 1 / w² outside length() is exact and avoids scaling both 2-vectors before their norms.
    const jx = axisX.xy.mul(w).sub(clip.xy.mul(axisX.w)).mul(halfViewport).toConst()
    const jy = axisY.xy.mul(w).sub(clip.xy.mul(axisY.w)).mul(halfViewport).toConst()
    // The largest singular value of [jx jy]: independent of roll, mirroring and shear, and
    // free of the cancellation in the eigenvalue formula.
    const stretch = length(vec2(jx.x.add(jy.y), jx.y.sub(jy.x)))
      .add(length(vec2(jx.x.sub(jy.y), jx.y.add(jy.x))))
      .mul(0.5)
    return w.greaterThan(0).select(stretch.mul(em).div(w.mul(w)), float(BEHIND_EYE))
  }).setLayout({
    name: 'ultraProjectedEm',
    type: 'float',
    inputs: [
      { name: 'clip', type: 'vec4' },
      { name: 'axisX', type: 'vec4' },
      { name: 'axisY', type: 'vec4' },
      { name: 'halfViewport', type: 'vec2' },
      { name: 'em', type: 'float' },
    ],
  })
  const emPixels = (anchor: Node<'vec2'>, meta: Node<'vec3'>): Node<'float'> => {
    const modelViewProjection = cameraProjectionMatrix.mul(modelViewMatrix)
    return projectedEm(
      modelViewProjection.mul(vec4(anchor, meta.y, 1)),
      modelViewProjection.mul(vec4(1, 0, 0, 0)),
      modelViewProjection.mul(vec4(0, 1, 0, 0)),
      viewportSize.mul(0.5),
      meta.z,
    ).toConst()
  }
  // A zero em marks glyphs that never switch: missing outlines, colour and layered glyphs.
  const fixed = (meta: Node<'vec3'>): Node<'bool'> => meta.z.lessThanEqual(0)
  const derived = new WeakMap<DomLayoutSnapshot, DomLayoutSnapshot>()
  return {
    keys,
    // A NaN em compares false: the SDF batch drops it and Windfoil keeps it.
    sdf: (anchor, meta) => fixed(meta).or(emPixels(anchor, meta).lessThan(belowWithOverlap)),
    windfoil: (anchor, meta) => fixed(meta).or(emPixels(anchor, meta).lessThan(below).not()),
    layout(snapshot) {
      const cached = derived.get(snapshot)
      if (cached) return cached
      const ordinals = ordinalsOf(snapshot)
      const result: DomLayoutSnapshot = {
        ...snapshot,
        sizeSwitched: true,
        glyphs: snapshot.glyphs.map((glyph, index): GlyphLayout => {
          const header = keys.has(glyph.glyphKey) ? glyphs.get(glyph.glyphKey) : undefined
          // Zero or below never switches; a dilating tone still reads the magnitude as the em.
          if (!header) return { ...glyph, switchEm: glyph.switchEm ? -Math.abs(glyph.switchEm) : 0 }
          const rect = windfoilGlyphRect(glyph, header)
          return {
            ...glyph,
            // Clamped above zero so a degenerate size still switches instead of meaning
            // "never", which would let both batches draw it.
            switchEm: Math.max(glyph.fontSize, 1e-30),
            motionOrigin: glyph.motionOrigin ?? [
              (rect[0] + rect[2]) / 2,
              (rect[1] + rect[3]) / 2,
              ordinals[index]!,
            ],
          }
        }),
      }
      derived.set(snapshot, result)
      return result
    },
  }
}
