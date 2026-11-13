import {
  DoubleSide,
  FrontSide,
  Material,
  MeshBasicNodeMaterial,
  Node,
  SRGBColorSpace,
  type NodeBuilder,
  type Side,
  type UniformNode,
} from 'three/webgpu'
import {
  Fn,
  attribute,
  bool,
  clamp,
  colorSpaceToWorking,
  cos,
  float,
  instanceIndex,
  int,
  luminance,
  max,
  min,
  mix,
  mod,
  positionGeometry,
  sin,
  time,
  uniform,
  varying,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

import type {
  SdfAnimationMode,
  SdfMotionOptions,
  TextFill,
  TextToneOptions,
  TextVertex,
} from '../types.js'
import { resolveTextTone, TextTone, type ResolvedTextTone } from './tone.js'

/** Shared construction options for the retained SDF and Windfoil text materials. */
export interface GlyphTextMaterialOptions {
  /** Match a snapshot captured with browser shaping; enables shared run motion. */
  textShaping?: 'none' | 'browser'
  /** Share motion centres and ordinals supplied by geometry. */
  runMotion?: boolean
  /** Custom linear-color TSL fill; opacity is multiplied by glyph coverage and DOM opacity. */
  fill?: TextFill | undefined
  /** Custom TSL vertex position in capture-local coordinates. */
  vertex?: TextVertex | undefined
  /** Face culling side. Defaults to `FrontSide`. */
  side?: Side | undefined
  /**
   * Initial motion state; adjustable later through `setMotion()`. `false` builds static text:
   * the vertex stage has no motion graph (no clock, waves or slide timeline) and the fragment
   * no motion alpha, `animated` is false, and `setMotion()` throws. Draws like motion with
   * mode `'none'`.
   */
  motion?: SdfMotionOptions | false
  /** Largest per-line stagger index in the geometry. Defaults to `0`. */
  maxSequence?: number
  /**
   * Shows text ink at the weight a browser gives it; see `TextToneOptions`. There is no
   * source element here: an `'auto'` model is the exact outline, and an `'auto'` backdrop is
   * unknown, which tones dark ink against white and keeps light ink at its exact coverage
   * whatever the model. Name the `backdrop` colour the scene shows behind the text for the
   * full conversion. `false` leaves the conversion out of the shader graph. Defaults to on.
   */
  tone?: TextToneOptions | ResolvedTextTone | false
  /**
   * @internal Size switch. Decides from per-instance data and per-pass uniforms only, so a
   * quad's four vertices agree; `false` collapses the quad onto its motion anchor, which
   * rasterizes nothing in beauty or shadow passes. Requires `sdfMeta` as
   * (sequence, depth, switch em).
   */
  keepGlyph?: GlyphKeepHook
}

export type GlyphMotionSource =
  Node<'float'> | { readonly index: Node<'float'>; readonly center: Node<'vec2'> }

export type GlyphVertexExtension = (
  quad: Node<'vec2'>,
  rect: Node<'vec4'>,
  position: Node<'vec2'>,
  depth: Node<'float'>,
  motionScale: Node<'float'>,
  fillUv: Node<'vec2'> | null,
  // A coverage backend may only attach varyings and intentionally return nothing.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
) => Node<'vec2'> | void

/** Per-glyph keep test for the size switch; see `GlyphTextMaterialOptions.keepGlyph`. */
export type GlyphKeepHook = (anchor: Node<'vec2'>, meta: Node<'vec3'>) => Node<'bool'>

/** @internal Fragment paint hook, evaluated before the caller's custom fill. */
export type GlyphPaintExtension = (cssColor: Node<'vec3'>) => {
  readonly rgb: Node<'vec3'>
  readonly weight: Node<'float'>
}

const MODE_CODES: Readonly<Record<SdfAnimationMode, number>> = Object.freeze({
  none: 0,
  opacity: 1,
  scale: 2,
  offset: 3,
  'slide-up': 4,
  'slide-down': 5,
  'slide-left': 6,
  'slide-right': 7,
  all: 8,
})

/** @internal Whether this motion state needs the motion graph: any mode but `'none'`. */
export function isAnimatedMotion(motion: SdfMotionOptions | false | undefined): boolean {
  return motion !== false && motion?.mode !== 'none'
}

/** Convert normalized DOM sRGB attributes into Three's working colour space. */
export function srgbAttributeToWorking(node: Node<'vec3'>): Node<'vec3'> {
  // ColorSpaceNode reports vec4 in r185, so truncate with a real conversion.
  return vec3(colorSpaceToWorking(node, SRGBColorSpace) as unknown as Node<'vec3'>)
}

class PassNode extends Node {
  static readonly type: string = 'UltraTextPassNode'

  constructor(
    readonly beautyNode: Node,
    readonly shadowNode: Node,
  ) {
    super()
  }

  // generateNodeType, not getNodeType: three caches the result per builder.
  override generateNodeType(builder: NodeBuilder): string {
    return this.beautyNode.getNodeType(builder)
  }

  override setup(builder: NodeBuilder): Node {
    return (builder.material as { isShadowPassMaterial?: boolean }).isShadowPassMaterial
      ? this.shadowNode
      : this.beautyNode
  }
}

/** `beauty`, giving way to `shadow` in the pass three derives for a shadow map. */
export function outsideShadowPass<T extends Node>(beauty: T, shadow: T): T {
  return new PassNode(beauty, shadow) as Node as T
}

class WireframeNode extends PassNode {
  static override readonly type = 'UltraTextWireframeNode'

  override setup(builder: NodeBuilder): Node {
    const m = builder.material as { wireframe?: boolean; isShadowPassMaterial?: boolean }
    return m.wireframe === true && !m.isShadowPassMaterial ? this.shadowNode : this.beautyNode
  }
}

const WIREFRAME_LINE_LUMINANCE = 0.4

/** `solid`, giving way to `lines` when the material draws wireframe. */
function outsideWireframe<T extends Node>(solid: T, lines: T): T {
  return new WireframeNode(solid, lines) as Node as T
}

/**
 * Shared retained-glyph vertex, motion, clipping, colour, and shadow plumbing.
 *
 * The two text backends differ only in how they produce coverage. Keeping the
 * rest in one graph makes switching backend preserve layout and animation
 * semantics, and avoids shipping the motion graph twice.
 */
export class GlyphTextMaterial extends MeshBasicNodeMaterial {
  readonly motionEnabled: UniformNode<'float', number> = uniform(1)
  readonly motionMode: UniformNode<'int', number> = uniform(MODE_CODES['slide-up'], 'int')
  readonly motionStrength: UniformNode<'float', number> = uniform(18)
  readonly motionSpeed: UniformNode<'float', number> = uniform(1.35)
  readonly motionStagger: UniformNode<'float', number> = uniform(0.045)
  readonly maxSequence: UniformNode<'float', number> = uniform(0)
  /** Uniforms of the tone conversion; null when the material was built with `tone: false`. */
  readonly tone: TextTone | null
  /**
   * False for static text, built with `motion: false`: its shader has no motion graph, its
   * motion uniforms read as disabled, and `setMotion()` throws.
   */
  readonly animated: boolean

  protected readonly colorVarying = varyingProperty('vec4', 'vUltraTextColor')
  protected readonly insideClip: Node<'bool'>
  protected readonly fillNode: Node<'vec4'> | null
  protected readonly baseColor: Node<'vec3'>
  protected readonly colorWeight: Node<'float'>

  #av = varyingProperty('float', 'vUltraTextMotionAlpha')
  #gt: Node<'vec3'> | null
  #rm: (motion?: SdfMotionOptions) => this

  constructor(
    options: GlyphTextMaterialOptions,
    extendVertex?: GlyphVertexExtension,
    motionIndex?: GlyphMotionSource,
    paint?: GlyphPaintExtension,
  ) {
    super()
    this.#rm = (motion) =>
      new (
        this.constructor as new (
          remakeOptions: GlyphTextMaterialOptions,
          remakeExtension?: GlyphVertexExtension,
          remakeIndex?: GlyphMotionSource,
          remakePaint?: GlyphPaintExtension,
        ) => this
      )(motion ? { ...options, motion } : options, extendVertex, motionIndex, paint)
    const animated = (this.animated = options.motion !== false)
    this.lights = false
    this.transparent = true
    this.depthWrite = false
    this.depthTest = true
    this.side = options.side ?? FrontSide
    this.shadowSide = this.side
    this.forceSinglePass = this.side === DoubleSide
    this.toneMapped = false
    this.maxSequence.value = options.maxSequence ?? 0
    const tone = resolveTextTone(options.tone)
    this.tone = tone && new TextTone(tone)

    const localVarying = varyingProperty('vec2', 'vUltraTextLocal')
    const clipVarying = varyingProperty('vec4', 'vUltraTextClip')
    const glyphRect = attribute<'vec4'>('sdfRect', 'vec4')
    const glyphClip = attribute<'vec4'>('sdfClip', 'vec4')
    const glyphColor = attribute<'vec4'>('sdfColor', 'vec4')
    this.#gt =
      this.tone &&
      varying(
        this.tone.inkTerms(srgbAttributeToWorking(vec3(glyphColor.rgb))),
        'vUltraTextTone',
      ).setInterpolation('flat', 'either')
    // Sequence and depth are the only per-glyph metadata. The compacted draw's
    // global index is already supplied by the GPU, including after blank glyphs.
    const keepGlyph = options.keepGlyph
    const glyphMeta = keepGlyph
      ? attribute<'vec3'>('sdfMeta', 'vec3')
      : attribute<'vec2'>('sdfMeta', 'vec2')
    const runMotion =
      (options.runMotion ?? options.textShaping === 'browser')
        ? attribute<'vec3'>('sdfRunMotion', 'vec3')
        : null
    const source = motionIndex && 'index' in motionIndex ? motionIndex : null
    const indexSource = source?.index ?? (motionIndex as Node<'float'> | undefined)
    const fillUv = options.fill ? varyingProperty('vec2', 'vUltraFillUv') : null
    // Switched batches share global ordinals, so glyphIndex stays continuous across a switch.
    // Fills truncate it to read per-glyph data. Interpolated, an instance's constant can arrive
    // a hair under itself (Safari's relaxed math on Apple GPUs) and read the previous glyph's
    // entry: flat keeps it exact.
    const fillIndex = options.fill
      ? varying(
          (keepGlyph ? (runMotion?.z ?? source?.index) : source?.index) ?? float(instanceIndex),
          'vUltraFillIndex',
        ).setInterpolation('flat', 'either')
      : null

    // The anchor motion scales about, and the size switch's anchor.
    const motionCenter = (): Node<'vec2'> =>
      (runMotion?.xy ?? source?.center ?? glyphRect.xy.add(glyphRect.zw).mul(0.5)).toConst()
    const basePositionOf = (quad: Node<'vec2'>): Node<'vec2'> =>
      glyphRect.xy.add(glyphRect.zw.sub(glyphRect.xy).mul(quad)).toConst()
    // What both graphs do with the moved position: the backend's extension, the size switch
    // and the shared varyings. Returns the drawn position.
    const finishVertex = (
      quad: Node<'vec2'>,
      center: Node<'vec2'> | null,
      position: Node<'vec2'>,
      motionScale: Node<'float'>,
      glyphIndex?: Node<'float'>,
    ): Node<'vec3'> => {
      const uv = fillUv ?? (options.vertex ? vec2(quad).toVar() : null)
      const extendedPosition =
        extendVertex?.(quad, glyphRect, position, glyphMeta.y, motionScale, uv) ?? position
      // The un-animated anchor and the unscaled em decide, so motion never moves a glyph
      // between the two batches of a size switch.
      const keep = center && keepGlyph?.(center, glyphMeta as unknown as Node<'vec3'>)
      const drawnPosition = keep
        ? vec2(keep.select(extendedPosition, center)).toConst()
        : extendedPosition
      localVarying.assign(drawnPosition)
      this.colorVarying.assign(vec4(srgbAttributeToWorking(vec3(glyphColor.rgb)), glyphColor.a))
      clipVarying.assign(glyphClip)
      const localPosition = vec3(drawnPosition, glyphMeta.y)
      if (!options.vertex) return localPosition
      const displaced = options.vertex({
        position: localPosition,
        center: center!,
        uv: uv!,
        glyphIndex: glyphIndex ?? (runMotion?.z ?? indexSource ?? float(instanceIndex)).toConst(),
        sequence: glyphMeta.x,
        rect: glyphRect,
        clip: glyphClip,
      })
      return keep ? vec3(keep.select(displaced, vec3(center, glyphMeta.y))) : displaced
    }

    // Static text: the motion graph's disabled branch alone, without its clock, waves and
    // slide timeline. Only the size switch or a custom vertex hook reads the anchor.
    const staticPosition = (): Node<'vec3'> => {
      const quad = positionGeometry.xy
      fillUv?.assign(quad)
      const center = keepGlyph || options.vertex ? motionCenter() : null
      return finishVertex(quad, center, basePositionOf(quad), float(1))
    }
    // Reused expressions need shader locals as well as shared JavaScript nodes;
    // otherwise the motion/clip expressions expand repeatedly in generated WGSL.
    // Immutable intermediates use toConst(); only the accumulated position mutates.
    const animatedPosition = (): Node<'vec3'> => {
      const quad = positionGeometry.xy
      fillUv?.assign(quad)
      const center = motionCenter()
      const basePosition = basePositionOf(quad)
      const sequence = glyphMeta.x
      const glyphIndex = (runMotion?.z ?? indexSource ?? float(instanceIndex)).toConst()
      const clock = time.mul(this.motionSpeed).toConst()
      const wave = sin(
        clock.mul(Math.PI * 2).sub(glyphIndex.mul(this.motionStagger).mul(Math.PI * 2)),
      )
      const pulse = wave.mul(0.5).add(0.5).toConst()

      const mode = (code: number) => int(this.motionMode).equal(code)
      const isOpacity = mode(MODE_CODES.opacity)
      const isScale = mode(MODE_CODES.scale)
      const isOffset = mode(MODE_CODES.offset)
      const isSlideUp = mode(MODE_CODES['slide-up'])
      const isSlideDown = mode(MODE_CODES['slide-down'])
      const isSlideLeft = mode(MODE_CODES['slide-left'])
      const isSlideRight = mode(MODE_CODES['slide-right'])
      const isAll = mode(MODE_CODES.all).toConst()

      const scale = isScale
        .select(
          float(0.86).add(pulse.mul(0.22)),
          isAll.select(float(0.94).add(pulse.mul(0.08)), float(1)),
        )
        .toConst()
      const animated = vec2(center.add(basePosition.sub(center).mul(scale))).toVar()
      const offsetX = sin(clock.mul(3.1).add(glyphIndex.mul(0.55)))
        .mul(this.motionStrength)
        .mul(0.32)
      const offsetY = cos(clock.mul(2.7).add(glyphIndex.mul(0.45)))
        .mul(this.motionStrength)
        .mul(0.18)
      animated.x.addAssign(isOffset.select(offsetX, 0))
      animated.y.addAssign(
        isOffset.select(
          offsetY,
          isAll.select(
            sin(clock.mul(2.5).add(glyphIndex.mul(0.35)))
              .mul(this.motionStrength)
              .mul(0.16),
            0,
          ),
        ),
      )

      const enterDuration = 0.58
      const holdDuration = 1.15
      const exitDuration = 0.24
      const sequenceSpan = this.maxSequence.mul(this.motionStagger).toConst()
      const cycle = max(
        sequenceSpan.add(enterDuration + holdDuration + exitDuration),
        0.001,
      ).toConst()
      const slidePhase = mod(clock, cycle).toConst()
      const localPhase = slidePhase.sub(sequence.mul(this.motionStagger)).toConst()
      const enterT = clamp(localPhase.div(enterDuration), 0, 1)
      const inverseEnter = float(1).sub(enterT).toConst()
      const easeOut = float(1).sub(inverseEnter.mul(inverseEnter).mul(inverseEnter))
      const exitStart = sequenceSpan.add(enterDuration + holdDuration).toConst()
      const exitT = clamp(slidePhase.sub(exitStart).div(exitDuration), 0, 1).toConst()
      const travelRatio = localPhase
        .lessThan(0)
        .select(
          float(1),
          localPhase
            .lessThan(enterDuration)
            .select(
              float(1).sub(easeOut),
              slidePhase.lessThan(exitStart).select(float(0), exitT.mul(exitT).mul(exitT).negate()),
            ),
        )
        .toConst()
      const clipSize = glyphClip.zw.sub(glyphClip.xy).toConst()
      const verticalTravel = max(this.motionStrength, clipSize.y.mul(1.18))
        .mul(travelRatio)
        .toConst()
      const horizontalTravel = max(this.motionStrength, clipSize.x.mul(1.18))
        .mul(travelRatio)
        .toConst()
      animated.x.addAssign(
        isSlideLeft.select(horizontalTravel, isSlideRight.select(horizontalTravel.negate(), 0)),
      )
      animated.y.addAssign(
        isSlideUp.select(verticalTravel.negate(), isSlideDown.select(verticalTravel, 0)),
      )

      const animationEnabled = this.motionEnabled
        .greaterThan(0.5)
        .and(int(this.motionMode).notEqual(MODE_CODES.none))
        .toConst()
      const finalPosition = vec2(animationEnabled.select(animated, basePosition)).toConst()
      const animatedAlpha = isOpacity.select(
        float(0.25).add(pulse.mul(0.75)),
        isAll.select(float(0.55).add(pulse.mul(0.45)), float(1)),
      )

      const motionScale = animationEnabled.select(scale, 1)
      const drawnPosition = finishVertex(quad, center, finalPosition, motionScale, glyphIndex)
      this.#av.assign(animationEnabled.select(animatedAlpha, 1))
      return drawnPosition
    }
    const positionNode = Fn<Node<'vec3'>>(animated ? animatedPosition : staticPosition)()
    this.positionNode = positionNode
    this.castShadowPositionNode = positionNode
    const painted = paint?.(this.colorVarying.rgb)
    this.baseColor = painted?.rgb ?? this.colorVarying.rgb
    this.colorWeight = painted?.weight ?? float(0)
    this.fillNode =
      options.fill && fillUv && fillIndex
        ? options.fill({
            uv: fillUv,
            position: localVarying,
            color: this.baseColor,
            colorWeight: this.colorWeight,
            glyphIndex: fillIndex,
          })
        : null

    // A quad's padding reaches past its block, so the clip would cut its wireframe's edges.
    this.insideClip = outsideWireframe(
      localVarying.x
        .greaterThanEqual(clipVarying.x)
        .and(localVarying.y.greaterThanEqual(clipVarying.y))
        .and(localVarying.x.lessThanEqual(clipVarying.z))
        .and(localVarying.y.lessThanEqual(clipVarying.w)),
      bool(true),
    )
    if (options.motion !== false) this.setMotion(options.motion ?? {})
    else {
      // What a caller reads off a static material: motion disabled, mode none.
      this.motionEnabled.value = 0
      this.motionMode.value = MODE_CODES.none
    }
  }

  /** @internal The ink's alpha: the CSS colour's, times the motion's for animated text. */
  protected inkAlpha(): Node<'float'> {
    return this.animated ? this.colorVarying.a.mul(this.#av) : this.colorVarying.a
  }

  /**
   * Attach one backend's beauty and shadow coverage to the shared graph. `folded` says the
   * beauty coverage holds the factor `toned()` returns for the ink's own alpha.
   */
  protected applyCoverage(
    coverage: Node<'float'>,
    shadowCoverage: Node<'float'>,
    shadowCutoff: Node<'float'>,
    paint?: Node<'vec4'>,
    folded = false,
  ): void {
    const fill = this.fillNode
    const paintedAlpha = paint?.a ?? (fill ? coverage.mul(clamp(fill.a, 0, 1)) : coverage)
    const castCoverage = fill && !paint ? shadowCoverage.mul(clamp(fill.a, 0, 1)) : shadowCoverage
    const inked = (covered: Node<'float'>): Node<'float'> => {
      const ink = covered.mul(this.colorVarying.a)
      return this.animated ? ink.mul(this.#av) : ink
    }
    // A folded factor times the ink's alpha is the converted coverage, clamped as one.
    // Shadow passes keep the exact product.
    const alpha = (
      folded
        ? outsideShadowPass(min(1, inked(paintedAlpha)), inked(castCoverage))
        : inked(outsideShadowPass(paintedAlpha, castCoverage))
    ).toConst()
    // Wireframe lines take the ink with none of the coverage, which is zero along a quad's
    // edges. A paint's colour means nothing outside its shape, so lines keep the CSS colour,
    // lifted toward white until it reaches the line floor.
    const lineAlpha = this.inkAlpha().toConst()
    const lineInk = vec3(fill?.rgb ?? this.baseColor).toConst()
    const lineInkLuminance = luminance(lineInk).toConst()
    const lineLift = clamp(
      float(WIREFRAME_LINE_LUMINANCE)
        .sub(lineInkLuminance)
        .div(max(float(1).sub(lineInkLuminance), 1e-4)),
      0,
      1,
    )
    this.colorNode = outsideWireframe(
      vec4(outsideShadowPass(paint?.rgb ?? fill?.rgb ?? this.baseColor, vec3(0)), alpha),
      vec4(mix(lineInk, vec3(1), lineLift), lineAlpha),
    )
    this.maskNode = this.insideClip.and(outsideWireframe(alpha, lineAlpha).greaterThan(0.001))
    this.maskShadowNode = this.insideClip
      .and(castCoverage.greaterThan(shadowCutoff))
      .and(this.inkAlpha().greaterThan(shadowCutoff))
  }

  /**
   * Beauty coverage of text ink as a browser would show it, or the same node when the
   * material has no tone. The ink is the instance colour, whose terms reach the fragment
   * through one flat varying, unless a fill graph supplies the colour per fragment.
   * `tableGate` is for a model whose table stops at a size. Shadow masks, colour layers and
   * shape paint must keep the exact coverage.
   *
   * The ink's own alpha is part of the mask a browser blends: the CSS colour's alpha and
   * opacity, the motion's, a fill's. The result is the factor that `applyCoverage` multiplies
   * by that alpha, so the caller passes it `folded`. `fold` false converts as for opaque ink,
   * for a caller that composes the result with other coverages first.
   */
  protected toned(
    coverage: Node<'float'>,
    ink?: Node<'vec3'>,
    tableGate?: Node<'float'>,
    fold = true,
  ): Node<'float'> {
    const tone = this.tone
    if (!tone) return coverage
    let opacity: Node<'float'> | undefined
    if (fold) {
      opacity = this.inkAlpha()
      if (this.fillNode) opacity = opacity.mul(clamp(this.fillNode.a, 0, 1))
    }
    return tone.apply(coverage, ink ? tone.inkTerms(ink).toConst() : this.#gt!, tableGate, opacity)
  }

  /**
   * Follows a recaptured tone through the uniforms. False means this material was built for
   * a tone of another kind, because the conversion or a model's extra nodes would have to
   * appear or go: the caller rebuilds the material.
   */
  setTone(tone: ResolvedTextTone | null): boolean {
    const current = this.tone
    if (!current || !tone || !current.fits(tone)) return !current && !tone
    current.update(tone)
    return true
  }

  /**
   * Rebuilds an equivalent material from this one's original construction options.
   *
   * Three's `Material.clone()` constructs the concrete class with **no arguments** and
   * copies properties across. This graph cannot survive that: it closes over required
   * options — an atlas and its metrics on the SDF backend, outline tables on Windfoil —
   * so the argument-less twin threw before `copy()` ever ran, and three's generic node
   * property copy would hand the twin a graph still wired to the *source's* uniforms,
   * leaving its own knobs connected to nothing. {@link remake} re-runs the constructor
   * with the stored options instead, rebuilding a private graph over the same shared
   * resources (the atlas texture is shared on purpose); the loop then carries the current
   * value of every numeric uniform knob — this class's and any subclass's, discovered as
   * own properties — into the twin's own uniforms, and the classic scalar-flag copy brings
   * side, opacity, blending, visibility, wireframe and friends. The tone's uniforms live on
   * its own object, so its current values are handed over whole. The one non-numeric uniform
   * in the family, the SDF unit range, is derived from the options and already correct in
   * the twin. Hand edits made to the node graph after construction are deliberately not
   * carried, and subclasses inherit all of this untouched because each passes its own
   * options object through `super()`. A static material's clone is static.
   */
  override clone(): this {
    return this.withMotion()
  }

  /**
   * @internal The animated twin of a static material: rebuilt like `clone()` with the
   * motion graph and `motion`, carrying every other state. Motion knobs `motion` leaves out
   * take their defaults.
   */
  withMotion(motion?: SdfMotionOptions): this {
    const twin = this.#rm(motion)
    // The classic fixed-list scalar copy — side, opacity, blending, visibility and friends —
    // not NodeMaterial's generic property pass, which would re-wire this rebuilt graph back
    // into the source's nodes. Wireframe sits above the base list, so it rides separately.
    Material.prototype.copy.call(twin, this)
    twin.wireframe = this.wireframe
    for (const key in twin) {
      const target = twin[key as keyof this] as { isUniformNode?: boolean; value: unknown } | null
      if (
        target?.isUniformNode &&
        typeof target.value === 'number' &&
        !(motion && key.startsWith('motion'))
      ) {
        target.value = (this[key as keyof this] as { value: number }).value
      }
    }
    if (this.tone) twin.tone?.update(this.tone.resolved)
    return twin
  }

  /**
   * Writes the given motion fields into the uniforms; safe to call every frame. Throws on a
   * static material (`motion: false`), which has no motion graph to drive.
   */
  setMotion(options: SdfMotionOptions): this {
    if (!this.animated) throw new Error('ultra-text: setMotion() cannot run with motion: false')
    if (options.enabled !== undefined) this.motionEnabled.value = options.enabled ? 1 : 0
    if (options.mode !== undefined) this.motionMode.value = MODE_CODES[options.mode]
    if (options.strength !== undefined) this.motionStrength.value = Math.max(0, options.strength)
    if (options.speed !== undefined) this.motionSpeed.value = Math.max(0, options.speed)
    if (options.stagger !== undefined) this.motionStagger.value = Math.max(0, options.stagger)
    return this
  }
}
