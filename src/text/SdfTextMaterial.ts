import {
  Color,
  LinearFilter,
  NearestFilter,
  Node,
  Vector2,
  type NodeBuilder,
  type Texture,
  type UniformNode,
} from 'three/webgpu'
import {
  attribute,
  clamp,
  dFdx,
  dFdy,
  dot,
  float,
  max,
  min,
  mix,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  varyingProperty,
  vec2,
  vec4,
} from 'three/tsl'

import type {
  SdfColorLayer,
  SdfDropShadowOptions,
  SdfOutlineOptions,
  SdfTextQuality,
} from '../types.js'
import {
  GlyphTextMaterial,
  type GlyphTextMaterialOptions,
  type GlyphPaintExtension,
} from './GlyphTextMaterial.js'

// Effect composition and atlas-cell clamping adapted from pmndrs/glyph (MIT).
// Copyright (c) 2026 Poimandres. See THIRD_PARTY_NOTICES.md and licenses/GLYPH-MIT.txt.

export interface SdfTextMaterialOptions extends GlyphTextMaterialOptions {
  /** Companion colour band from SdfAtlas; omitted keeps the original shader graph. */
  colorLayer?: SdfColorLayer
  outline?: SdfOutlineOptions
  dropShadow?: SdfDropShadowOptions
  /** The single-channel distance-field texture, from `SdfAtlas.texture`. */
  atlas: Texture
  /** Atlas width in texels, from `SdfAtlas.width`. */
  atlasWidth: number
  /** Atlas height in texels, from `SdfAtlas.height`. */
  atlasHeight: number
  /** Distance-field pixel range, from `SdfAtlas.pxRange`. */
  pxRange: number
  /** Font size of the atlas bake in texels, from `SdfAtlas.bakeSize`. Defaults to `96`. */
  bakeSize?: number
  /**
   * First texel row of the atlas's monochrome shapes, from `SdfAtlas.shapeTop`: glyphs from
   * that row down keep their baked coverage where text takes a tone. Defaults to none.
   */
  shapeTop?: number | undefined
  /**
   * SDF contour in the atlas encoding. Defaults to `0.5`, the baked outline; colour glyphs
   * then keep `0.515`, which hides the faint shading around some emoji strikes.
   */
  threshold?: number
  /** Coverage required by the shadow silhouette. Defaults to `0.5`. */
  shadowCutoff?: number
  /** `'high'` adds four derivative-offset samples. Defaults to `'standard'`. */
  quality?: SdfTextQuality
  /** Extra weight in screen pixels for glyphs under 16 pixels per em. Defaults to `0`. */
  stemDarkening?: number
  /**
   * @internal Draws the outline ring and drop shadow alone, under analytic text drawn after
   * it with the same coverage: the underlay of the Windfoil and Slug backends. Needs an
   * outline or a drop shadow.
   */
  underlay?: boolean
}

type GlyphGeometry = { hasAttribute(name: string): boolean } | null

/**
 * Whether minified text samples the atlas's mipmaps, whose texels blur the field beyond the
 * support box of a slot: about a pixel of faint halo around small glyphs, which only whole
 * quads keep.
 */
const blurred = (atlas: Texture): boolean =>
  atlas.minFilter !== LinearFilter &&
  atlas.minFilter !== NearestFilter &&
  (atlas.generateMipmaps || atlas.mipmaps.length > 1)

/**
 * The position graph, with the geometry of the build it is set up in handed over first: the
 * vertex extension is JavaScript run while the graph is set up, and reads the attributes there.
 */
class GeometryProbeNode extends Node {
  static readonly type = 'UltraTextGeometryProbeNode'

  constructor(
    readonly positionNode: Node,
    readonly probe: (geometry: GlyphGeometry) => void,
  ) {
    super()
  }

  override getNodeType(builder: NodeBuilder): string {
    return this.positionNode.getNodeType(builder)
  }

  override setup(builder: NodeBuilder): Node {
    this.probe((builder as { geometry?: GlyphGeometry }).geometry ?? null)
    return this.positionNode
  }
}

/** Retained single-channel SDF text with TSL motion, clipping, and shadows. */
export class SdfTextMaterial extends GlyphTextMaterial {
  readonly threshold: UniformNode<'float', number> = uniform(0.5)
  readonly shadowCutoff: UniformNode<'float', number> = uniform(0.5)
  readonly stemDarkening: UniformNode<'float', number> = uniform(0)
  readonly unitRange: UniformNode<'vec2', Vector2> = uniform(new Vector2())
  readonly quality: SdfTextQuality

  constructor(options: SdfTextMaterialOptions) {
    const outline = options.outline
    const shadow = options.dropShadow
    const width = outline ? (outline.width ?? 1) : 0
    const offsetX = shadow ? (shadow.offsetX ?? 2) : 0
    const offsetY = shadow ? (shadow.offsetY ?? -2) : 0
    const outlineOpacity = outline?.opacity ?? 1
    const shadowOpacity = shadow?.opacity ?? 0.5
    if (
      ![width, offsetX, offsetY, outlineOpacity, shadowOpacity].every(Number.isFinite) ||
      width < 0
    ) {
      throw new RangeError(
        'SdfTextMaterial: effects require finite values and a non-negative outline width',
      )
    }
    const effects = outline !== undefined || shadow !== undefined
    // Whether quads may shrink to their glyphs' support boxes (`sdfTrim`): effect quads reach
    // past the cell, run motion's vertex buffer leaves none for the trim, and mipmaps blur the
    // field past the box.
    const trimmable =
      !effects &&
      !(options.runMotion ?? options.textShaping === 'browser') &&
      !blurred(options.atlas)
    const glyphUvRect = attribute<'vec4'>('sdfUvRect', 'vec4')
    const uvVarying = varyingProperty('vec2', 'vUltraSdfUv')
    const uvBounds = effects ? varyingProperty('vec4', 'vUltraSdfUvBounds') : null
    const uvPerLocal = effects ? varyingProperty('vec2', 'vUltraSdfUvPerLocal') : null
    const layer = options.colorLayer
    const inBand = layer ? varyingProperty('float', 'vUltraColorGlyph') : null
    const bandTop = layer ? uniform((layer.top + 0.5) / options.atlasHeight) : null
    const bandMap = layer
      ? uniform(new Vector2(options.atlasHeight / layer.height, layer.top / layer.height))
      : null
    // Monochrome shapes keep their baked coverage where text takes a tone. Their rows lie
    // below the text and above the colour band, from the one the atlas names; a texture from
    // `buildSdfAtlas` repeats it for a caller that passes no `shapeTop`. Only a shader whose
    // fragment reads the flag carries it, flat from `either` vertex like GlyphTextMaterial's.
    // A toned shader that can trim its quads carries it whether or not the atlas has shapes:
    // without them the row is one below the atlas, which no glyph reaches, so the flag is 0 and
    // the shader is the one a shape atlas uses (the row is a uniform), mixing the exact
    // coverage in at weight 0. Whole quads would pay for that per fragment with nothing back.
    const shapeTop: unknown = options.shapeTop ?? options.atlas.userData['ultraShapeTop']
    const shaped = typeof shapeTop === 'number'
    const inShapes =
      options.tone !== false && (shaped || trimmable)
        ? varying(
            step(
              uniform(((shaped ? shapeTop : options.atlasHeight) + 0.5) / options.atlasHeight),
              min(glyphUvRect.y, glyphUvRect.w),
            ),
            'vUltraShapeGlyph',
          ).setInterpolation('flat', 'either')
        : null
    const paint: GlyphPaintExtension | undefined = layer
      ? (css) => {
          const halfTexel = vec2(0.5 / options.atlasWidth, 0.5 / options.atlasHeight)
          const safeUv = uvBounds
            ? clamp(uvVarying, uvBounds.xy.add(halfTexel), uvBounds.zw.sub(halfTexel))
            : uvVarying
          const bandUv = vec2(safeUv.x, safeUv.y.mul(bandMap!.x).sub(bandMap!.y))
          const sample = texture(layer.texture, bandUv)
          const scale = vec2(1, bandMap!.x)
          const texel = (
            uvBounds ? sample.grad(dFdx(uvVarying).mul(scale), dFdy(uvVarying).mul(scale)) : sample
          ).toConst()
          const glyph = step(0.5, inBand!).toConst()
          const weight = texel.a.mul(glyph).toConst()
          return { rgb: css.mul(weight.oneMinus()).add(texel.rgb.mul(glyph)), weight }
        }
      : undefined
    // Set once constructed and per build, before the vertex extension below runs.
    const built: { material?: SdfTextMaterial; geometry?: GlyphGeometry; cast?: boolean } = {}
    super(
      options,
      (quad, rect, position, _depth, motionScale, fillUv) => {
        inBand?.assign(step(bandTop!, min(glyphUvRect.y, glyphUvRect.w)))
        const uvSpan = glyphUvRect.zw.sub(glyphUvRect.xy)
        if (uvBounds && uvPerLocal) {
          const size = rect.zw.sub(rect.xy).max(1e-6)
          const padding = vec2(width + Math.abs(offsetX), width + Math.abs(offsetY))
          const extra = quad.mul(2).sub(1).mul(padding)
          uvPerLocal.assign(uvSpan.div(size))
          uvBounds.assign(
            vec4(min(glyphUvRect.xy, glyphUvRect.zw), max(glyphUvRect.xy, glyphUvRect.zw)),
          )
          const expandedQuad = quad.add(extra.div(size))
          fillUv?.assign(expandedQuad)
          uvVarying.assign(glyphUvRect.xy.add(uvSpan.mul(expandedQuad)))
          return position.add(options.motion === false ? extra : extra.mul(motionScale))
        }
        const material = built.material
        if (material && built.geometry?.hasAttribute('sdfTrim') && !blurred(options.atlas)) {
          // Most of a glyph's quad is empty field, which every fragment there samples to no
          // coverage. `sdfTrim` is the slot's support box in the order and units of the UV
          // rect, the macOS rise included: the quad shrinks to it, in quad units. A box outside
          // this instance's slot (a UV rect rewritten to another glyph) leaves the whole quad.
          // 'high' samples a quarter pixel around each fragment: half the field's range more
          // covers that down to about 6 pixels per em at the default bake.
          const trim = attribute<'vec4'>('sdfTrim', 'vec4')
          const span = uvSpan.toConst()
          const bounds = trim.sub(glyphUvRect.xyxy).div(vec4(span, span)).toConst()
          const sum = bounds.xy.add(bounds.zw).sub(1).abs().toConst()
          const inside = max(sum.x, sum.y).lessThan(1)
          const reach =
            !built.cast && material.quality === 'high'
              ? material.unitRange.mul(0.5).div(span.abs()).toConst()
              : null
          const limits = clamp(
            reach ? bounds.add(vec4(reach.negate(), reach)) : bounds,
            0,
            1,
          ).toConst()
          const trimmed = inside
            .select(mix(limits.xy, limits.zw, quad), quad)
            .context({ uniformFlow: true })
            .toConst()
          fillUv?.assign(trimmed)
          uvVarying.assign(glyphUvRect.xy.add(span.mul(trimmed)))
          // The quad's own size times the motion's scale: exact for every motion mode, whose
          // centre stays the untrimmed rect's.
          const step = rect.zw.sub(rect.xy).mul(trimmed.sub(quad))
          return position.add(options.motion === false ? step : step.mul(motionScale))
        }
        uvVarying.assign(glyphUvRect.xy.add(uvSpan.mul(quad)))
      },
      undefined,
      paint,
    )
    built.material = this
    // Where quads may be trimmed, the geometry decides: a custom geometry without `sdfTrim`
    // keeps the whole quads and the vertex stage it always had. Glyph geometry with run motion
    // has none. A shadow map samples each fragment's own UV, so its quads keep to the support
    // box itself.
    if (trimmable) {
      const graph = this.positionNode!
      this.positionNode = new GeometryProbeNode(graph, (geometry) => {
        built.geometry = geometry
        built.cast = false
      })
      this.castShadowPositionNode = new GeometryProbeNode(graph, (geometry) => {
        built.geometry = geometry
        built.cast = true
      })
    }
    this.name = 'ultra-text TSL runtime SDF text'
    this.threshold.value = options.threshold ?? 0.5
    this.shadowCutoff.value = Math.min(1, Math.max(0, options.shadowCutoff ?? 0.5))
    this.stemDarkening.value = Math.max(0, options.stemDarkening ?? 0)
    this.quality = options.quality ?? 'standard'
    this.unitRange.value.set(
      options.pxRange / options.atlasWidth,
      options.pxRange / options.atlasHeight,
    )

    // Texels per pixel along each atlas axis: one over the length of that axis's screen
    // gradient, as Windfoil's pixel box measures it. `fwidth()` is the footprint's bounding box,
    // which reads text turned in its plane up to √2 smaller than it is: a wider ramp, and a
    // stem darkening and tone size gate that moved with the angle. Axis-aligned text gets the
    // same value. Each derivative is its own node, so the shader gains no local and the vertex
    // stage, which shares their numbering, keeps its text.
    // The floor only guards a zero footprint. A larger one, such as 1e-5 on the gradient, capped
    // the range once a texel spanned more than 1e5 / atlasWidth pixels and blurred magnified
    // edges over several pixels, unevenly on a non-square atlas.
    const squared = (derivative: typeof dFdx) => derivative(uvVarying).mul(derivative(uvVarying))
    const screenTextureSize = squared(dFdx).add(squared(dFdy)).max(1e-18).inverseSqrt()
    // Effect contours revisit shared coverage nodes in several conditional branches.
    // Three r186 can redeclare a toConst() local twice in the same branch; mutable
    // locals hoist that shared calculation. Keep the ordinary text graph unchanged.
    const local = (node: Node<'float'>): Node<'float'> => (effects ? node.toVar() : node.toConst())
    const screenPxRange = local(max(dot(this.unitRange, screenTextureSize).mul(0.5), 1))
    const rawStemBoost = this.stemDarkening.mul(clamp(float(2).sub(screenPxRange), 0, 1))
    const stemBoost = local(inBand ? rawStemBoost.mul(inBand.oneMinus()) : rawStemBoost)
    // Colour glyphs sit a little inside the default contour; an explicit threshold moves both.
    const contour = inBand
      ? this.threshold.add(inBand.mul(uniform(options.threshold === undefined ? 0.015 : 0)))
      : this.threshold
    // A slot of the colour band can hold text beside its colour ink, as a shaped line does
    // beside its emoji. The beauty pass therefore tells the two apart per fragment, by the
    // band's own alpha: 1 around colour ink, 0 around foreground ink. Shadow maps keep the
    // row flag.
    const colour = layer ? this.colorWeight : null
    const inkContour = colour
      ? this.threshold.add(colour.mul(uniform(options.threshold === undefined ? 0.015 : 0)))
      : contour
    // 1 where the baked coverage is kept: a shape's rows or colour ink.
    const exact =
      colour && inShapes && inBand
        ? max(inShapes.mul(inBand.oneMinus()), colour)
        : (colour ?? inShapes)
    // macOS font smoothing, for text ink below the size where the browser stops applying it:
    // the outline grows by d = min(dilationEm ems, dilationPx pixels) to each side, by 2 d
    // upwards and not at all downwards, which is a dilation by d and a rise by d. `smoothed`
    // is 1 where that holds, `rise` is d in screen pixels. Other models add no node here.
    const tone = this.tone
    let smoothed: Node<'float'> | undefined
    let rise: Node<'float'> | undefined
    if (tone?.dilates) {
      const emPx = screenPxRange.mul(uniform((options.bakeSize ?? 96) / options.pxRange)).toConst()
      const small = step(tone.dilation.z, emPx).oneMinus()
      smoothed = local(exact ? small.mul(exact.oneMinus()) : small)
      rise = local(min(emPx.mul(tone.dilation.x), tone.dilation.y).mul(smoothed))
    }
    // The ramp input where the field saturates to 0, the empty rest of the atlas cell, capped
    // at the ramp's foot so that background keeps exactly zero coverage. Uncapped, a glyph a
    // few pixels tall lifted its whole quad to ~3% alpha through stem darkening, and an outline
    // near the range limit to over a third; the mask then kept every fragment of the quad.
    // `lift` moves the contour outwards by that many screen pixels.
    const rampAtEmptyField = (
      edge: Node<'float'>,
      lift: Node<'float'> = stemBoost,
      slope?: Node<'float'>,
    ) =>
      local(
        min(
          slope
            ? slope.mul(lift.div(screenPxRange).sub(edge)).add(0.5)
            : lift.add(0.5).sub(screenPxRange.mul(edge)),
          0,
        ),
      )
    // Shadow maps keep the baked contour; only the beauty contour is dilated. A distance field
    // has one offset for every edge: d, which is exact on upright and level strokes.
    const lift = rise ? stemBoost.add(rise) : stemBoost
    // The field reaches zero screenPxRange / 2 pixels outside the contour. Where that is less
    // than the half pixel of ramp plus the dilation, the ramp steepens so that it still starts
    // at the empty field and its middle still lies `rise` outside: s / (s - 2 rise) for s.
    const inkSlope = rise
      ? local(max(screenPxRange, screenPxRange.div(max(screenPxRange.sub(rise.mul(2)), 0.25))))
      : undefined
    const castRamp = rampAtEmptyField(contour)
    const fillRamp = rise || colour ? rampAtEmptyField(inkContour, lift, inkSlope) : castRamp
    // The rise samples the field that many pixels lower on screen.
    const inkUv = rise ? uvVarying.sub(dFdy(uvVarying).mul(rise)) : uvVarying
    const coverageAt = (sampleUv: Node<'vec2'>): Node<'float'> => {
      return distanceCoverage(sampleUv, castRamp, inBand, screenPxRange)
    }
    // The atlas texel under one sample, read with the glyph's own footprint.
    const fieldAt = (sampleUv: Node<'vec2'>): Node<'float'> => {
      const halfTexel = vec2(0.5 / options.atlasWidth, 0.5 / options.atlasHeight)
      const safeUv = uvBounds
        ? clamp(sampleUv, uvBounds.xy.add(halfTexel), uvBounds.zw.sub(halfTexel))
        : sampleUv
      const sample = texture(options.atlas, safeUv)
      // Clamping changes the implicit derivatives at a cell boundary. Preserve
      // the original footprint so mip/anisotropic filtering cannot form seams.
      return (uvBounds ? sample.grad(dFdx(uvVarying), dFdy(uvVarying)) : sample).r
    }
    // One pixel of linear ramp across the contour: the coverage of a straight edge. Colour
    // glyphs keep the eased ramp, whose shorter foot hides the ink colour around their texels.
    const contourAt = (
      field: Node<'float'>,
      ramp: Node<'float'> = fillRamp,
      eased: Node<'float'> | null = colour ?? inBand,
      slope: Node<'float'> = inkSlope ?? screenPxRange,
    ): Node<'float'> => {
      const across = slope.mul(field).add(ramp)
      const linear = clamp(across, 0, 1)
      return eased ? mix(linear, smoothstep(0, 1, across), eased) : linear
    }
    // Effect quads reach past the glyph's cell; samples there read nothing.
    const insideCell = (sampleUv: Node<'vec2'>, bounds: Node<'vec4'>): Node<'bool'> =>
      sampleUv.x
        .greaterThanEqual(bounds.x)
        .and(sampleUv.y.greaterThanEqual(bounds.y))
        .and(sampleUv.x.lessThanEqual(bounds.z))
        .and(sampleUv.y.lessThanEqual(bounds.w))
    const distanceCoverage = (
      sampleUv: Node<'vec2'>,
      ramp?: Node<'float'>,
      eased: Node<'float'> | null = colour ?? inBand,
      slope?: Node<'float'>,
    ): Node<'float'> => {
      const alpha = contourAt(fieldAt(sampleUv), ramp, eased, slope)
      return uvBounds ? insideCell(sampleUv, uvBounds).select(alpha, 0) : alpha
    }
    const uvDx = this.quality === 'high' ? dFdx(uvVarying).mul(0.125).toConst() : null
    const uvDy = this.quality === 'high' ? dFdy(uvVarying).mul(0.125).toConst() : null
    // 'high' filters a contour over a 4-rook rotated grid (±1/8, ±3/8 px) so horizontal,
    // vertical and diagonal strokes each see four distinct subpixel strata instead of two.
    const tapsAround = (sampleUv: Node<'vec2'>): Node<'vec2'>[] =>
      uvDx && uvDy
        ? [
            sampleUv.sub(uvDx).sub(uvDy.mul(3)),
            sampleUv.add(uvDx.mul(3)).sub(uvDy),
            sampleUv.sub(uvDx.mul(3)).add(uvDy),
            sampleUv.add(uvDx).add(uvDy.mul(3)),
          ]
        : [sampleUv]
    // Filter every beauty contour alike: subtracting differently filtered
    // silhouettes produces a jagged ring, even when its requested width is zero.
    const filteredCoverage = (sampleUv: Node<'vec2'>, ramp?: Node<'float'>): Node<'float'> => {
      const taps = tapsAround(sampleUv).map((tap) => distanceCoverage(tap, ramp))
      if (taps.length === 1) return taps[0]!
      return taps.reduce((sum, tap) => sum.add(tap)).mul(0.25)
    }
    // Text ink is shown at the weight a browser gives it. Shapes, colour glyphs, outline rings,
    // drop shadows and shadow maps keep the exact coverage. `fold` false where the result is
    // composed with a ring and a drop shadow before the ink's alpha.
    const ink = (baked: Node<'float'>, fold = true): Node<'float'> => {
      const toned = this.toned(baked, this.fillNode?.rgb, smoothed, fold)
      return exact && tone ? mix(toned, baked, exact) : toned
    }
    // The field encodes only half of pxRange outside the contour. Clamp the
    // requested expansion so the outline's contour stays inside it; its ramp
    // is capped at the empty field like the fill's.
    const expansion =
      outline && uvPerLocal
        ? min(uvPerLocal.x.abs().mul((options.atlasWidth * width) / options.pxRange), 0.49)
        : null
    const outlineRamp = expansion
      ? rampAtEmptyField(inkContour.sub(expansion), lift, inkSlope)
      : fillRamp
    let coverage: Node<'float'>
    let outlined: Node<'float'> | null = null
    if (expansion && uvBounds) {
      // The fill and the outline's silhouette are two contours of the same taps. Each tap is
      // read once, in the one branch that skips taps outside the glyph's cell (most of an
      // effect quad), and gives both contours: component for component the sums of
      // filteredCoverage, in the same order.
      const pairs = tapsAround(inkUv).map((tap) => {
        const field = fieldAt(tap)
        return insideCell(tap, uvBounds).select(
          vec2(contourAt(field), contourAt(field, outlineRamp)),
          vec2(0),
        )
      })
      const sums = (
        pairs.length === 1 ? pairs[0]! : pairs.reduce((sum, pair) => sum.add(pair)).mul(0.25)
      ).toVar()
      coverage = sums.x
      outlined = sums.y
    } else coverage = filteredCoverage(inkUv)
    // Shadow maps filter the finished silhouette; don't supersample that path.
    if (effects && uvPerLocal) {
      coverage = coverage.toConst()
      const inked = tone ? ink(coverage, false).toConst() : coverage
      const fillOpacity = this.fillNode ? clamp(this.fillNode.a, 0, 1) : float(1)
      const fillAlpha = inked.mul(fillOpacity).toConst()
      const fillColor = this.fillNode?.rgb ?? this.baseColor
      const silhouette = outlined ? outlined.toConst() : inked
      const ringOpacity = Math.min(1, Math.max(0, outlineOpacity))
      // The ring is what the exact silhouette shows around the fill as it is drawn.
      let ring = max(silhouette.sub(inked), 0).mul(ringOpacity).toConst()
      const glyphAlpha = fillAlpha.add(ring).toConst()
      // An underlay draws the ring and shadow alone; analytic text then fills the glyph at the
      // alpha k this coverage gives, toned and folded with the ink's alpha as that fill is, and
      // hides k of whatever lies under it. Drawn over the rest, 1 - k, the two draws blend as
      // the one above does, at any ink alpha. Where k is about 1 the fill hides the underlay,
      // and the ring floods the outline's whole silhouette: it covers what an analytic edge
      // leaves bare where the field rounds a corner.
      const rest = options.underlay
        ? float(1)
            .sub(min((tone ? ink(coverage) : coverage).mul(this.inkAlpha()).mul(fillOpacity), 1))
            .toConst()
        : null
      const flood = rest?.lessThan(1e-3)
      if (flood) ring = flood.select(outline ? silhouette.mul(ringOpacity) : 0, ring).toConst()
      const shadowAlpha = (
        shadow
          ? filteredCoverage(inkUv.sub(uvPerLocal.mul(vec2(offsetX, offsetY))))
              .mul(Math.min(1, Math.max(0, shadowOpacity)))
              .mul(float(1).sub(flood ? flood.select(ring, glyphAlpha) : glyphAlpha))
          : float(0)
      ).toConst()
      const alpha = (flood ? ring : glyphAlpha).add(shadowAlpha).toConst()
      const outlineInk = uniform(new Color(outline?.color ?? 0x000000)).mul(ring)
      const rgb = (flood ? outlineInk : fillColor.mul(fillAlpha).add(outlineInk))
        .add(uniform(new Color(shadow?.color ?? 0x000000)).mul(shadowAlpha))
        .div(max(alpha, 1e-6))
      const shadowFill = coverageAt(uvVarying).toConst()
      const castOutlineRamp =
        expansion && (rise || colour) ? rampAtEmptyField(contour.sub(expansion)) : outlineRamp
      const shadowRing = outline
        ? max(
            distanceCoverage(uvVarying, castOutlineRamp, inBand, screenPxRange).sub(shadowFill),
            0,
          ).mul(ringOpacity)
        : float(0)
      this.applyCoverage(
        coverage,
        shadowFill.mul(fillOpacity).add(shadowRing),
        this.shadowCutoff,
        vec4(rgb, flood && rest ? alpha.div(flood.select(1, rest)) : alpha),
        !!flood,
      )
    } else {
      this.applyCoverage(
        tone ? ink(coverage.toConst()) : coverage,
        coverageAt(uvVarying),
        this.shadowCutoff,
        undefined,
        !!tone,
      )
    }
  }
}
