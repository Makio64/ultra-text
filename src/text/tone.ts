import { Vector3, type Node, type UniformNode } from 'three/webgpu'
import { clamp, dot, float, floor, min, uniform, vec3 } from 'three/tsl'

import {
  backdropCurve,
  C1,
  C2,
  C3,
  LUMINANCE,
  resolveTextTone,
  srgbEncode,
  toneCoverage,
  toneLightness,
  type ResolvedTextTone,
  type TextToneContext,
} from '../dom/tone.js'

export {
  resolveTextTone,
  srgbEncode,
  toneCoverage,
  toneLightness,
  type ResolvedTextTone,
  type TextToneContext,
}

/** What a render tells the tone: the parts of a renderer and a scene it reads. */
export interface ToneFrameRenderer {
  readonly alpha?: boolean
  getClearAlpha(): number
  getRenderTarget(): { readonly isPostProcessingRenderTarget?: boolean } | null
}
export interface ToneFrameScene {
  readonly background?: unknown
  readonly backgroundNode?: unknown
}

/**
 * Makes linear-light text show what a browser shows. Browsers blend the glyph mask on
 * sRGB-encoded values, so a half-covered pixel of dark ink on a lighter backdrop is darker
 * than exact coverage blended in linear light, and light ink on a darker backdrop is thinner.
 * With encoded lightness i of the ink and b of the backdrop, the linear-light coverage that
 * lands on the browser's pixel is (P(b + (i - b) m) - P(b)) / (P(i) - P(b)) for the mask m,
 * which holds the ink's own alpha.
 * It is evaluated as a polynomial around b divided by the mean slope of P between b and i,
 * which is never below C1, so equal ink and backdrop need no special case, zero coverage
 * stays exactly zero and full coverage stays one.
 *
 * One instance owns the uniforms of one material. `update()` follows a later backdrop or
 * strength without rebuilding the shader; the model's nodes are fixed at construction. Each
 * uniform is read by one shader stage, since one shared by two is declared twice.
 *
 * The conversion belongs to a render that blends the text itself. Text over nothing in its
 * frame, as on a transparent canvas, is blended with the page by the browser, on encoded
 * values: exact coverage is the browser's pixel there, so each render decides; see `frame`.
 */
export class TextTone {
  /** (backdrop lightness, strength, a third of strength x table), read by the per-ink terms. */
  readonly ink: UniformNode<'vec3', Vector3> = uniform(new Vector3())
  /** (K0, K1, 1 - strength): the polynomial at the backdrop, read by every toned fragment. */
  readonly curve: UniformNode<'vec3', Vector3> = uniform(new Vector3())
  /** (dilationEm, dilationPx, bigPx), for a backend's macOS outline dilation. */
  readonly dilation: UniformNode<'vec3', Vector3> = uniform(new Vector3())
  /** Whether the graph was built for a dilating model, which adds nodes the others lack. */
  readonly dilates: boolean
  resolved: ResolvedTextTone
  #b = true

  constructor(tone: ResolvedTextTone) {
    this.dilates = tone.dilationPx > 0
    this.resolved = tone
    this.update(tone)
    this.curve.onRenderUpdate(({ renderer, scene }) => {
      this.frame(renderer as unknown as ToneFrameRenderer | null, scene)
    })
  }

  frame(renderer: ToneFrameRenderer | null, scene: ToneFrameScene | null): void {
    const target = renderer?.getRenderTarget()
    const blended =
      this.resolved.framed === true ||
      !renderer ||
      renderer.getClearAlpha() >= 1 ||
      (renderer.alpha === false && (!target || target.isPostProcessingRenderTarget === true)) ||
      !!scene?.background ||
      !!scene?.backgroundNode
    if (blended === this.#b) return
    this.#b = blended
    this.#w()
  }

  #w(): void {
    const { strength, backdrop, table } = this.resolved
    const converted = this.#b ? strength : 0
    this.ink.value.set(backdrop, converted, (strength * table) / 3)
    this.curve.value.set(...backdropCurve(backdrop), 1 - converted)
  }

  fits(tone: ResolvedTextTone): boolean {
    return this.dilates === tone.dilationPx > 0
  }

  update(tone: ResolvedTextTone): void {
    this.resolved = tone
    this.#w()
    this.dilation.value.set(tone.dilationEm, tone.dilationPx, tone.bigPx)
  }

  /**
   * Per-ink terms (D, H, T) from a linear working-space colour: the lightness step from the
   * backdrop, the strength over the mean slope across it, and the rasterizer table's weight
   * for the ink's class. Constant over a glyph, so the vertex stage can compute them.
   */
  inkTerms(ink: Node<'vec3'>): Node<'vec3'> {
    const luminance = clamp(dot(ink, vec3(...LUMINANCE)), 0, 1).toConst()
    // A native select: a branch here would be hoisted into the wrong stage of a varying.
    const lightness = luminance
      .lessThanEqual(0.0031308)
      .select(
        luminance.mul(12.92),
        luminance
          .pow(1 / 2.4)
          .sub(1)
          .mul(1.055)
          .add(1),
      )
      .context({ uniformFlow: true })
      .toConst()
    const backdrop = this.ink.x
    const delta = lightness.sub(backdrop).toConst()
    const k1 = backdrop
      .mul(3 * C3)
      .add(C2)
      .toConst()
    const slope = backdrop
      .mul(k1.add(C2))
      .add(C1)
      .add(delta.mul(k1.add(delta.mul(C3))))
    return vec3(delta, this.ink.y.div(slope), this.ink.z.mul(min(floor(lightness.mul(4)), 3)))
  }

  /**
   * Converts exact coverage with the terms of its ink. `tableGate` scales the table weight
   * per fragment, for a model whose table stops at a size. A browser blends the mask times
   * the ink's own alpha: with `opacity` the step across the backdrop is taken for that
   * product and the factor alone is returned, for a caller that multiplies it by the same
   * alpha and clamps the product.
   */
  apply(
    coverage: Node<'float'>,
    terms: Node<'vec3'>,
    tableGate?: Node<'float'>,
    opacity?: Node<'float'>,
  ): Node<'float'> {
    // Read three times below: a caller's own local is reused as it is.
    const exact = (coverage as { isVarNode?: boolean }).isVarNode ? coverage : coverage.toConst()
    const table = tableGate ? terms.z.mul(tableGate) : terms.z
    const mask = exact.add(table.mul(exact).mul(float(1).sub(exact))).toConst()
    const y = terms.x.mul(opacity ? mask.mul(opacity) : mask).toConst()
    const { curve } = this
    const toned = mask.mul(curve.z.add(terms.y.mul(curve.x.add(y.mul(curve.y.add(y.mul(C3)))))))
    return opacity ? toned : min(1, toned)
  }
}
