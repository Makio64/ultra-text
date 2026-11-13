import type { Node, UniformNode } from 'three/webgpu'
import {
  Fn,
  If,
  abs,
  attribute,
  clamp,
  dFdy,
  float,
  max,
  mix,
  step,
  uint,
  uniform,
  varying,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl'

import {
  GlyphTextMaterial,
  srgbAttributeToWorking,
  type GlyphVertexExtension,
} from '../text/GlyphTextMaterial.js'
import { resolveTextTone } from '../text/tone.js'
import type { WindfoilMaterialOptions } from '../windfoil/WindfoilMaterial.js'
import { createSlugCoverage, slugPixelMetrics, slugVertexExtension } from './coverage.js'

export type SlugMaterialOptions = WindfoilMaterialOptions

/** Analytic, atlas-free quadratic-outline text using the dual-ray Slug coverage evaluator. */
export class SlugMaterial extends GlyphTextMaterial {
  readonly shadowCutoff: UniformNode<'float', number> = uniform(0.5)

  constructor(options: SlugMaterialOptions) {
    const bounds = attribute<'vec4'>('windfoilBounds', 'vec4')
    const rawBand = attribute<'vec4'>('windfoilBand', 'vec4')
    const packedCounts = uint(rawBand.y)
    const hBandCount = packedCounts.bitAnd(uint(255))
    const vBandCount = packedCounts.shiftRight(uint(8))
    const band = varying(
      vec4(rawBand.x, rawBand.x.add(float(hBandCount)), rawBand.z, rawBand.w),
      'vUltraWindfoilBand',
    ).setInterpolation('flat', 'either')
    const bandOrigin = varying(
      vec4(
        bounds.y.negate().mul(rawBand.w),
        bounds.z.mul(rawBand.z),
        float(hBandCount.sub(uint(1))),
        float(vBandCount.sub(uint(1))),
      ),
      'vUltraSlugOrigin',
    ).setInterpolation('flat', 'either')
    const glyphPosition = varyingProperty('vec2', 'vUltraWindfoilPosition')
    const layer = options.layered ? attribute<'vec4'>('windfoilLayer', 'vec4') : null
    const paintVarying = layer
      ? varying(layer.w, 'vUltraWindfoilPaint').setInterpolation('flat', 'either')
      : null
    const dilation = resolveTextTone(options.tone)?.dilationPx
      ? varyingProperty('float', 'vUltraWindfoilDilation')
      : null
    const extension: GlyphVertexExtension = dilation
      ? (...vertex) => {
          const meta = attribute<'vec3'>('sdfMeta', 'vec3')
          meta.getHash = () => String(meta.id)
          const em = abs(meta.z)
          return slugVertexExtension(bounds, glyphPosition, {
            law: this.tone!.dilation,
            em: layer ? em.mul(step(layer.w, 0.25)) : em,
            amount: dilation,
          })(...vertex)
        }
      : slugVertexExtension(bounds, glyphPosition)
    super(options, extension, layer ? { index: layer.z, center: layer.xy } : undefined)
    this.name = 'ultra-text TSL Slug text'
    this.shadowCutoff.value = Math.min(1, Math.max(0, options.shadowCutoff ?? 0.5))

    const { evaluateFace, evaluateShadow } = createSlugCoverage(options)
    let sharedDy: Node<'vec2'> | undefined
    let sharedMetrics: Node<'vec4'> | undefined
    const getDy = (): Node<'vec2'> => (sharedDy ??= dFdy(glyphPosition).toConst())
    const getMetrics = (): Node<'vec4'> =>
      (sharedMetrics ??= slugPixelMetrics(glyphPosition, dilation ? getDy() : undefined).toConst())
    const coverageOf = (grown: Node<'float'> | null): Node<'float'> => {
      const metrics = getMetrics()
      if (!grown) return evaluateFace(band, bandOrigin, glyphPosition, metrics).toConst()
      const amount = max(grown, 0).toConst()
      const growth = amount.mul(2).add(1).toConst()
      const invGrowth = float(1).div(growth).toConst()
      const halfAndInv = vec4(metrics.xy.mul(growth), metrics.zw.mul(invGrowth)).toConst()
      const center = glyphPosition.sub(getDy().mul(amount)).toConst()
      return clamp(evaluateFace(band, bandOrigin, center, halfAndInv).mul(growth), 0, 1).toConst()
    }
    let plainCoverage: Node<'float'> | undefined
    const getPlainCoverage = (): Node<'float'> => (plainCoverage ??= coverageOf(null))
    const shadowCoverage = evaluateShadow(band, bandOrigin, glyphPosition).toConst()
    const tone = this.tone
    const exact = tone ? (dilation ? coverageOf(dilation) : getPlainCoverage()) : getPlainCoverage()
    const gate = dilation ? step(0, dilation) : undefined
    const inked = (ink?: Node<'vec3'>): Node<'float'> => this.toned(exact, ink, gate)
    const foreground = (ink?: Node<'vec3'>): Node<'float'> =>
      tone && paintVarying ? mix(exact, inked(ink), step(paintVarying, 0.25)) : inked(ink)

    if (paintVarying && options.paintFunctions) {
      const painted = (toning: boolean): Node<'vec4'> =>
        Fn<Node<'vec4'>>(() => {
          const own = toning ? exact : getPlainCoverage()
          const result = (
            vec4(this.colorVarying.rgb, own).toVar() as unknown as {
              setAssignable(value: boolean): Node<'vec4'>
            }
          ).setAssignable(true)
          If(own.greaterThan(0), () => {
            If(paintVarying.greaterThanEqual(2), () => {
              const encoded = options.paintFunctions!.evaluatePaint(
                uint(paintVarying.sub(2)),
                glyphPosition,
                vec4(0),
              )
              result.assign(
                vec4(
                  srgbAttributeToWorking(vec3(encoded.rgb.div(max(encoded.a, 1e-6)))),
                  encoded.a.mul(own),
                ),
              )
            }).ElseIf(paintVarying.lessThan(0.5), () => {
              if (this.fillNode)
                result.assign(
                  vec4(
                    this.fillNode.rgb,
                    (toning ? inked(this.fillNode.rgb) : own).mul(clamp(this.fillNode.a, 0, 1)),
                  ),
                )
              else if (toning) result.assign(vec4(this.colorVarying.rgb, inked()))
            })
          })
          return result
        })()
      const exactPaint = painted(false)
      this.applyCoverage(
        exact,
        exactPaint.a,
        this.shadowCutoff,
        tone ? painted(true) : exactPaint,
        !!tone,
      )
    } else if (paintVarying && this.fillNode) {
      const solid = paintVarying.greaterThan(0.5).toConst()
      const opacity = solid
        .select(float(1), clamp(this.fillNode.a, 0, 1))
        .context({ uniformFlow: true })
        .toConst()
      const beautyAlpha = (tone ? foreground(this.fillNode.rgb) : getPlainCoverage())
        .mul(opacity)
        .toConst()
      this.applyCoverage(
        beautyAlpha,
        shadowCoverage.mul(opacity).toConst(),
        this.shadowCutoff,
        vec4(
          solid.select(this.colorVarying.rgb, this.fillNode.rgb).context({ uniformFlow: true }),
          beautyAlpha,
        ),
        !!tone,
      )
    } else {
      this.applyCoverage(
        foreground(this.fillNode?.rgb),
        shadowCoverage,
        this.shadowCutoff,
        undefined,
        !!tone,
      )
    }
    const clip = Fn(() => {
      this.insideClip.not().discard()
    })()
    this.maskNode = this.maskNode!.bypass(clip)
    this.maskShadowNode = this.maskShadowNode!.bypass(clip)
  }
}
