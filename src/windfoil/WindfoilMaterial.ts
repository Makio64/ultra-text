import { createWindfoilCoverage, windfoilVertexExtension, windfoilPixelBox } from './coverage.js'
import type { Node, StorageBufferNode, UniformNode } from 'three/webgpu'
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
  type GlyphTextMaterialOptions,
  type GlyphVertexExtension,
} from '../text/GlyphTextMaterial.js'
import { resolveTextTone } from '../text/tone.js'

/** Storage buffers retained by one Windfoil outline atlas. */
export interface WindfoilStorage {
  /**
   * Three vec2 entries per xy-monotone quadratic piece. Each row stores its pieces
   * by descending x-maximum, followed by the same pieces by ascending x-minimum.
   */
  readonly curves: StorageBufferNode<'vec2'>
  /** Six uint entries per row: start, count, density, x-min, x-max and split bits. */
  readonly rows: StorageBufferNode<'uint'>
}

export interface WindfoilMaterialOptions extends WindfoilStorage, GlyphTextMaterialOptions {
  shadowCutoff?: number
  layered?: boolean
  paintFunctions?: {
    evaluatePaint(index: Node<'uint'>, point: Node<'vec2'>, foreground: Node<'vec4'>): Node<'vec4'>
  }
}

/** Analytic, atlas-free quadratic-outline text using the Windfoil coverage integral. */
export class WindfoilMaterial extends GlyphTextMaterial {
  readonly shadowCutoff: UniformNode<'float', number> = uniform(0.5)

  constructor(options: WindfoilMaterialOptions) {
    const bounds = attribute<'vec4'>('windfoilBounds', 'vec4')
    // The band header's first row and row count, like the paint index below, are integers the
    // fragment truncates. Interpolated, an instance's constant can arrive a hair under itself
    // (Safari's relaxed math on Apple GPUs) and read the previous row: flat keeps them exact. Any
    // vertex of the glyph gives the same value, so `either` serves compatibility-mode devices.
    const band = varying(
      attribute<'vec4'>('windfoilBand', 'vec4'),
      'vUltraWindfoilBand',
    ).setInterpolation('flat', 'either')
    const glyphPosition = varyingProperty('vec2', 'vUltraWindfoilPosition')
    const layer = options.layered ? attribute<'vec4'>('windfoilLayer', 'vec4') : null
    const paintVarying = layer
      ? varying(layer.w, 'vUltraWindfoilPaint').setInterpolation('flat', 'either')
      : null
    // A tone model that dilates the outline: each glyph's dilation in pixels, below zero from
    // the size where the model stops. Its em is the font size the instance carries in
    // `sdfMeta.z`, whose sign belongs to the size switch. An instance without one, and every
    // colour layer, reads as text of no size: the outline stays where it is.
    const dilation = resolveTextTone(options.tone)?.dilationPx
      ? varyingProperty('float', 'vUltraWindfoilDilation')
      : null
    const extension: GlyphVertexExtension = dilation
      ? (...vertex) => {
          const meta = attribute<'vec3'>('sdfMeta', 'vec3')
          // Attribute nodes are shared by name, and the shared graph may have declared this
          // one two wide: its own identity keeps the third component.
          meta.getHash = () => String(meta.id)
          const em = abs(meta.z)
          // The tone's uniforms exist by the time a shader function first runs.
          return windfoilVertexExtension(bounds, glyphPosition, {
            law: this.tone!.dilation,
            em: layer ? em.mul(step(layer.w, 0.25)) : em,
            amount: dilation,
          })(...vertex)
        }
      : windfoilVertexExtension(bounds, glyphPosition)
    super(options, extension, layer ? { index: layer.z, center: layer.xy } : undefined)
    this.name = 'ultra-text TSL Windfoil text'
    this.shadowCutoff.value = Math.min(1, Math.max(0, options.shadowCutoff ?? 0.5))

    const { integrateFace, profileFace } = createWindfoilCoverage(options)
    const coverageOf = (grown: Node<'float'> | null): Node<'float'> =>
      Fn<Node<'float'>>(() => {
        // The integration box matches the pixel footprint's spread along each
        // outline axis: a box of width w has variance w²/12, as does the footprint
        // when w is the length of that axis's screen gradient. fwidth() would use
        // the footprint's bounding box, blurring rotated or sheared text by up to
        // √2 per axis. Axis-aligned text gets the same box either way.
        const dy = grown ? dFdy(glyphPosition) : undefined
        const pixel = windfoilPixelBox(glyphPosition, dy)
        let size = pixel
        let center: Node<'vec2'> = glyphPosition
        let area = pixel.x.mul(pixel.y)
        if (grown) {
          // A box 2d pixels larger, divided by one growth: a straight edge at x pixels from
          // the centre then covers clamp(0.5 + x + d), the exact coverage of the outline moved
          // out by d. Sampled d pixels lower on screen, edges facing down keep their place
          // and edges facing up rise by 2d. Empty pixels stay 0 and pixels inside the ink 1,
          // but where a corner faces down the box overhangs the ink on two sides: that pixel
          // row gets no dilation from the side, and at worst (1 + d) / (1 + 2d) of its ink.
          const amount = max(grown, 0).toConst()
          const growth = amount.mul(2).add(1).toConst()
          size = pixel.mul(growth).toConst()
          center = glyphPosition.sub(dy!.mul(amount)).toConst()
          area = area.mul(growth)
        }
        const integral = float(0).toVar('windfoilIntegral')
        // Glyphs of a few pixels use their ink profile, whatever the dilation.
        If(pixel.mul(3.7).greaterThanEqual(bounds.zw.sub(bounds.xy)).all(), () => {
          integral.assign(profileFace(band, bounds, center, size))
        }).Else(() => {
          integral.assign(integrateFace(band, bounds.y, center, size))
        })
        return clamp(abs(integral.div(area)), 0, 1)
      })()
    // The exact coverage: every shadow mask, and the beauty pass of the models that keep the
    // outline as it is.
    const coverage = coverageOf(null)
    // Beauty coverage of foreground text ink, toned from the instance colour or from a fill's
    // own colour. Colour layers, paint and every shadow mask keep the exact coverage, and
    // with `tone: false` this is that same node: the graph has no trace of the conversion.
    const tone = this.tone
    // A toned graph reads the exact coverage more than once. One local keeps the integral in
    // one place; a conditional would evaluate it again in each of its branches.
    const exact = tone ? (dilation ? coverageOf(dilation) : coverage).toConst() : coverage
    // The model's table stops where its dilation does.
    const gate = dilation ? step(0, dilation) : undefined
    const inked = (ink?: Node<'vec3'>): Node<'float'> => this.toned(exact, ink, gate)
    // Layered geometry also carries solid colour layers, which stay exact.
    const foreground = (ink?: Node<'vec3'>): Node<'float'> =>
      tone && paintVarying ? mix(exact, inked(ink), step(paintVarying, 0.25)) : inked(ink)

    if (paintVarying && options.paintFunctions) {
      // `toning` false rebuilds the exact paint, whose alpha the shadow mask keeps.
      const painted = (toning: boolean): Node<'vec4'> =>
        Fn<Node<'vec4'>>(() => {
          const own = toning ? exact : coverage
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
      // A shadow pass reads the exact paint alone, so it evaluates one paint.
      const exactPaint = painted(false)
      this.applyCoverage(
        coverage,
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
      const alpha = coverage.mul(opacity).toConst()
      this.applyCoverage(
        coverage,
        alpha,
        this.shadowCutoff,
        vec4(
          solid.select(this.colorVarying.rgb, this.fillNode.rgb).context({ uniformFlow: true }),
          tone ? foreground(this.fillNode.rgb).mul(opacity).toConst() : alpha,
        ),
        !!tone,
      )
    } else {
      this.applyCoverage(
        foreground(this.fillNode?.rgb),
        coverage,
        this.shadowCutoff,
        undefined,
        !!tone,
      )
    }
    // Clip before the analytic coverage loops. A logical AND on the final mask
    // alone materializes coverage first, even for fragments outside the block.
    // Keep the test separate from derivative-dependent coverage: discard retains
    // helper invocations for derivatives at the surviving clip edge.
    const clip = Fn(() => {
      this.insideClip.not().discard()
    })()
    this.maskNode = this.maskNode!.bypass(clip)
    this.maskShadowNode = this.maskShadowNode!.bypass(clip)
  }
}
