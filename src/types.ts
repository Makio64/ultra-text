import type {
  ColorRepresentation,
  Group,
  Mesh,
  Node,
  Side,
  Texture,
  WebGPURenderer,
} from 'three/webgpu'

/** Inputs to a fill graph, evaluated by the GPU for each visible glyph fragment. */
export interface TextFillContext {
  /** Normalized glyph quad coordinates, including the atlas padding for SDF text. */
  readonly uv: Node<'vec2'>
  /** Animated position in the capture's local coordinate system. */
  readonly position: Node<'vec2'>
  /** Per-pixel base colour in Three's linear working space, including baked colour ink. */
  readonly color: Node<'vec3'>
  /** Baked colour weight: 0 for CSS-tinted text, 1 for colour ink. */
  readonly colorWeight: Node<'float'>
  /**
   * Drawable-glyph index; may change after a rebuild. Plain SDF text uses its instance index.
   * Layered Windfoil, including its SDF companion and `windfoil.sdfBelowPx`, uses a
   * capture-order ordinal shared by both batches and by every layer of one glyph or SVG, so
   * it stays continuous across the size switch. A whole number, the same at every pixel of
   * the glyph (a flat varying), so `int(glyphIndex)` indexes per-glyph data exactly.
   */
  readonly glyphIndex: Node<'float'>
}

/** Build linear RGB plus an opacity multiplier; coverage and DOM opacity remain applied. */
export type TextFill = (context: TextFillContext) => Node<'vec4'>

/** Inputs to a vertex graph, evaluated by the GPU for each glyph or decoration quad corner. */
export interface TextVertexContext {
  /** Corner position `[x, y, z]` in capture-local coordinates, after built-in motion when active. */
  readonly position: Node<'vec3'>
  /** Glyph anchor `[x, y]` in capture-local coordinates, shared across shaped runs, layers, and decorations. */
  readonly center: Node<'vec2'>
  /** Normalized glyph quad coordinates (`0..1`), including SDF trim or effect padding when active. */
  readonly uv: Node<'vec2'>
  /** Drawable-glyph index (`0, 1, 2, ...`), shared across shaped runs, layers, companions, and decorations. */
  readonly glyphIndex: Node<'float'>
  /** Per-line stagger index (`0, 1, 2, ...`). */
  readonly sequence: Node<'float'>
  /** Glyph bounding box `[x0, y0, x1, y1]` in capture-local coordinates. */
  readonly rect: Node<'vec4'>
  /** Block clip rectangle `[x0, y0, x1, y1]` in capture-local coordinates. */
  readonly clip: Node<'vec4'>
}

/** Build a custom 3D vertex position `[x, y, z]` in capture-local coordinates for beauty and shadow passes. */
export type TextVertex = (context: TextVertexContext) => Node<'vec3'>

/**
 * Which rasterizer the tone imitates. `'outline'`: exact outline coverage, as browsers draw
 * very large text, Linux greyscale text and macOS text without font smoothing. `'macos'`:
 * CoreGraphics font smoothing, which also dilates the outline below 256 device pixels per
 * em. `'windows'`: Skia's contrast table. `'auto'` chooses from the platform and the source
 * element's computed CSS; a material without a source element resolves it to `'outline'`.
 * The table of `'macos'` and `'windows'` lifts light ink, and applies over a known backdrop.
 */
export type TextToneModel = 'auto' | 'outline' | 'macos' | 'windows'

/**
 * Makes text ink show the weight a browser gives it. Glyph coverage is blended in linear
 * light, while browsers blend their glyph mask on sRGB-encoded values: dark ink on a lighter
 * backdrop reads heavier there, and light ink on a darker backdrop thinner. The tone converts
 * the coverage of text ink, with the ink's own alpha, so the linear-light result lands on the
 * browser's pixel. Shadow masks, colour glyphs and SVG paint keep exact coverage.
 *
 * The conversion applies where the frame itself holds what the text is blended over: an
 * opaque canvas or clear colour, a scene background, an opaque rectangle the capture draws
 * behind the text, or a `backdrop` you name. Text over nothing in a transparent frame is
 * blended with the page by the browser, on encoded values, so it keeps its exact coverage
 * there, with the model's outline and ink table.
 */
export interface TextToneOptions {
  /**
   * How much of the conversion is applied, from `0`, none, to `1`, the browser's full
   * conversion. It scales the blend and the ink table, not the `'macos'` model's outline
   * dilation: at `0` that model still draws its dilated outline, at exact coverage. Use
   * `tone: false`, or the `'outline'` model at `0`, for the font's own outline. Defaults
   * to `1`.
   */
  readonly strength?: number
  /**
   * Colour the text is read against, in a form `THREE.Color` reads: a hex number or string,
   * a colour name, comma-separated `rgb()` or `hsl()`. `'auto'`, the default, uses what the
   * capture draws behind the text, over the opaque CSS background colour behind the source
   * element. Where that cannot be known (no opaque colour, a background image in front of
   * it, a `Text`, a material without a source element) white is assumed and the model's ink
   * table is off: dark ink gains weight, light ink keeps its exact coverage. Name the colour
   * the scene draws behind the text for the full conversion; leave any other CSS colour
   * syntax to `'auto'`.
   */
  // A colour may be any string, so the literal only documents the keyword.
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  readonly backdrop?: ColorRepresentation | 'auto'
  /** Defaults to `'auto'`. */
  readonly model?: TextToneModel
}

export interface SdfOutlineOptions {
  /** Outward width in local units. Defaults to `1`. Limited by the baked distance range. */
  readonly width?: number
  readonly color?: ColorRepresentation
  /** Opacity from 0 to 1. Defaults to `1`. */
  readonly opacity?: number
}

export interface SdfDropShadowOptions {
  /** Offset in local units; positive X points right. Defaults to `2`. */
  readonly offsetX?: number
  /** Offset in local units; positive Y points up. Defaults to `-2`. */
  readonly offsetY?: number
  readonly color?: ColorRepresentation
  /** Opacity from 0 to 1. Defaults to `0.5`. */
  readonly opacity?: number
}

/**
 * How the distance field is generated. `gpu` requires a real WebGPU backend and
 * fails without one; `cpu` runs an exact Euclidean distance transform; `auto`
 * tries the GPU path first and falls back to the CPU path.
 */
export type SdfAtlasMode = 'auto' | 'gpu' | 'cpu'
/** Which glyphs keep the colours Canvas 2D paints. */
export type ColorGlyphMode = 'emoji' | 'all' | 'none'
/**
 * Text sampling quality. `high` adds four-tap sampling, atlas mipmaps, and up
 * to 4× anisotropy for cleaner small or minified text; `standard` uses one
 * sample and no mips for the fastest and smallest retained path.
 */
export type SdfTextQuality = 'standard' | 'high'
/**
 * Text layout implementation: the browser's DOM `Range` engine, or the
 * Canvas-measured Pretext engine loaded lazily on first use.
 */
export type DomTextLayoutEngine = 'range' | 'pretext'
/** Retained text coverage implementation. Windfoil and Slug are WebGPU-only and analytic. */
export type DomTextBackend = 'sdf' | 'windfoil' | 'slug'

/**
 * Per-glyph motion mode: static (`none`), pulsing (`opacity`, `scale`,
 * `offset`), one of the four staggered slide directions, or everything
 * combined (`all`).
 */
export type SdfAnimationMode =
  | 'none'
  | 'opacity'
  | 'scale'
  | 'offset'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'all'

export interface SdfMotionOptions {
  /** Enable TSL motion. Defaults to `true`. A uniform: toggling it never rebuilds a shader. */
  enabled?: boolean
  /**
   * Animation mode. Defaults to `'slide-up'`. `'none'` draws static text: `DomText`/`DomSdf`/
   * `Text` and `createWindfoilShapes` then build their materials without the motion graph (no
   * clock, waves, slide timeline or motion alpha in the shaders). The first `setMotion()` that
   * sets another mode builds animated materials once, synchronously, and swaps them in; after
   * that, every motion change — `'none'` included — is a uniform write again.
   */
  mode?: SdfAnimationMode
  /** Non-negative motion distance in local units. Defaults to `18`. */
  strength?: number
  /** Non-negative speed multiplier. Defaults to `1.35`. */
  speed?: number
  /** Non-negative per-glyph sequence offset for the slide modes. Defaults to `0.045`. */
  stagger?: number
}

export interface FontStyleSnapshot {
  readonly key: string
  readonly canvasFont: string
  readonly family: string
  readonly weight: string
  readonly style: string
  readonly stretch: string
  readonly variant: string
  readonly kerning: string
  readonly featureSettings: string
  readonly variationSettings: string
  readonly opticalSizing: string
  readonly size: number
}

export interface GlyphRequest {
  readonly key: string
  /** Captured SVG paint layer; its font is a placeholder and its character is U+FFFC. */
  readonly shape?: GlyphShape
  /** A code point or whole emoji sequence, or a complete run with browser shaping. */
  readonly character: string
  readonly font: FontStyleSnapshot
  /** Canvas shaping state for a retained browser text run. Spacing is in em units. */
  readonly shaping?: {
    readonly direction: 'ltr' | 'rtl'
    readonly language: string
    readonly letterSpacing: number
    readonly wordSpacing: number
    /** Horizontal slice of a shaped run as fractions of its advance, for atlas tiling. */
    readonly slice?: readonly [number, number]
  }
}

export type WindfoilBoundingBox = readonly [xMin: number, yMin: number, xMax: number, yMax: number]

export type WindfoilQuadratic = readonly [
  x0: number,
  y0: number,
  controlX: number,
  controlY: number,
  x1: number,
  y1: number,
]

/** SVG affine order: x' = a*x+c*y+e; y' = b*x+d*y+f. */
export type WindfoilAffine = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
]
export interface WindfoilSolidPaint {
  readonly type: 'solid'
  readonly color: readonly [number, number, number, number]
}
export interface WindfoilForegroundPaint {
  readonly type: 'foreground'
  readonly alpha?: number
}
export type WindfoilExtendMode = 'pad' | 'repeat' | 'reflect'
export interface WindfoilColorStop {
  readonly offset: number
  readonly color: readonly [number, number, number, number]
}
export interface WindfoilGradientBase {
  readonly stops: readonly WindfoilColorStop[]
  readonly extend?: WindfoilExtendMode
  readonly transform?: WindfoilAffine
}
export interface WindfoilLinearGradientPaint extends WindfoilGradientBase {
  readonly type: 'linear'
  readonly p0: readonly [number, number]
  readonly p1: readonly [number, number]
  readonly p2?: readonly [number, number]
}
export interface WindfoilRadialGradientPaint extends WindfoilGradientBase {
  readonly type: 'radial'
  readonly c0: readonly [number, number]
  readonly r0: number
  readonly c1: readonly [number, number]
  readonly r1: number
}
export interface WindfoilSweepGradientPaint extends WindfoilGradientBase {
  readonly type: 'sweep'
  readonly center: readonly [number, number]
  readonly startAngle: number
  readonly endAngle: number
}
export type WindfoilGradientPaint =
  WindfoilLinearGradientPaint | WindfoilRadialGradientPaint | WindfoilSweepGradientPaint
/** Paint components are straight sRGB 0–1. */
export type WindfoilPaint = WindfoilSolidPaint | WindfoilForegroundPaint | WindfoilGradientPaint
export interface WindfoilOutlineLayer {
  readonly quadratics: ArrayLike<number>
  /** Defaults to the control-point hull; contained in the outline bbox. */
  readonly bbox?: WindfoilBoundingBox
  readonly paint: WindfoilPaint
}

/**
 * One glyph outline in OpenType font units: positive Y points up and `descent`
 * is normally negative. Each flat quadratic run is
 * `[x0, y0, controlX, controlY, x1, y1]`.
 */
export interface WindfoilGlyphOutline {
  readonly unitsPerEm: number
  readonly ascent: number
  readonly descent: number
  readonly bbox: WindfoilBoundingBox
  readonly quadratics: ArrayLike<number>
  /** Paint order, bottom to top; base quadratics are foreground. At most 1024. */
  readonly layers?: readonly WindfoilOutlineLayer[]
  readonly clipBox?: WindfoilBoundingBox
}

/** Resolve the font outline selected by the browser for one captured glyph. */
export type WindfoilOutlineProvider = (
  request: GlyphRequest,
  signal: AbortSignal,
) => WindfoilGlyphOutline | null | Promise<WindfoilGlyphOutline | null>

export interface WindfoilOptions {
  /**
   * Maps the captured CSS font request to an OpenType quadratic outline.
   * Return `null` when the face, character or complete emoji sequence is unavailable.
   * When omitted, `DomSdf` traces each glyph from the browser's own Canvas 2D rendering of the
   * captured font at 256 pixels per em and fits it with quadratics. On Noto Sans these stay
   * within 0.006 em of the font's outlines (0.0002 em on average) with about 1.3 times its
   * curves. Font-variation and feature settings are not applied, as on any canvas, and colour
   * glyphs are drawn by the SDF companion. Supply the font's own outlines to keep edges exact
   * under any magnification.
   */
  readonly outlineProvider?: WindfoilOutlineProvider
  /**
   * What to do when a provider returns `null`. Defaults to `'error'`, or to `'sdf-glyphs'`
   * when `outlineProvider` is omitted.
   */
  readonly fallback?: 'error' | 'sdf' | 'sdf-glyphs'
  /** Layer instances by default; shader composites before applying group opacity. */
  readonly compositing?: 'layers' | 'shader'
  /** Target monotone-piece count per horizontal row band. Defaults to `10`. */
  readonly targetPiecesPerBand?: number
  /**
   * Experimental size switch. Plain single-paint outline glyphs are also baked into an SDF
   * companion atlas and drawn from it while their projected em is smaller than this many
   * render-target (device) pixels; at or above it they use analytic Windfoil coverage.
   * Decided per glyph and per render pass on the GPU from the pass's camera and viewport (not
   * a mip level or eye sub-viewport), so shadow maps use their own resolution. Colour and layered glyphs stay Windfoil; glyphs without
   * an outline stay SDF. Undefined (the default) disables it. Setting it to `bakeSize` keeps
   * the atlas at or below one texel per pixel.
   */
  readonly sdfBelowPx?: number
}

/** Configuration for the analytic Slug text backend (`textBackend: 'slug'`). */
export type SlugOptions = WindfoilOptions

export interface GlyphSlot {
  /** True: colour ink; false: tested without colour ink; absent: not tested. */
  readonly color?: boolean
  readonly key: string
  readonly character: string
  readonly fontKey: string
  readonly u0: number
  readonly v0: number
  readonly u1: number
  readonly v1: number
  readonly planeX0: number
  readonly planeY0: number
  readonly planeX1: number
  readonly planeY1: number
  readonly descent: number
  readonly advance: number
  /**
   * The part of the slot whose distance field is not empty, in the same atlas UV as `u0`..`v1`
   * (`v0` the top): the glyph's ink box and half the field's range, with room for bilinear
   * filtering and the macOS tone's rise, rounded out to whole texels within the slot's window.
   * Where each fragment samples level 0 of the atlas at (or just below) its own UV, a quad over
   * it shows what a quad over the whole slot shows, from a fraction of the fragments; glyph
   * geometry trims its quads to it. `rasterizeGlyphAtlas` sets it on plain text glyphs, not on
   * shapes, colour candidates or the tiles of a shaped line; absent, the whole slot is drawn.
   */
  readonly support?: {
    readonly u0: number
    readonly v0: number
    readonly u1: number
    readonly v1: number
  }
}

/** Transient sRGB colour texels, premultiplied by colour weight stored in alpha. */
export interface RasterColorBand {
  readonly top: number
  readonly height: number
  readonly data: Uint8Array
}

/** Companion colour texture owned and disposed by its SdfAtlas. */
export interface SdfColorLayer {
  readonly texture: Texture
  readonly top: number
  readonly height: number
}

export interface RasterAtlas {
  readonly colorBand?: RasterColorBand
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
  readonly bakeSize: number
  readonly pxRange: number
  readonly glyphs: ReadonlyMap<string, GlyphSlot>
}

export interface SdfAtlas {
  readonly colorLayer?: SdfColorLayer
  /**
   * First texel row of the atlas's monochrome SVG shapes, which are packed below every text
   * glyph and above the colour band. A toned SDF material draws the glyphs from this row down
   * at their baked coverage, since a tone is for text ink. Carry it wherever an atlas is
   * copied or restored from stored bytes, and hand it to `SdfTextMaterial` as `shapeTop`.
   * Absent: the atlas has no shape rows.
   */
  readonly shapeTop?: number | undefined
  readonly texture: Texture
  readonly width: number
  readonly height: number
  readonly pxRange: number
  readonly bakeSize: number
  readonly glyphs: ReadonlyMap<string, GlyphSlot>
  readonly mode: Exclude<SdfAtlasMode, 'auto'>
  dispose(): void
}

/** Where a line may break before a glyph, as captured from the DOM. */
export type GlyphBreak = 'none' | 'soft' | 'hard'

/** One solid CSS text decoration, positioned relative to the captured text-box bottom. */
export interface TextDecorationLayout {
  readonly line: 'underline' | 'overline' | 'line-through'
  readonly color: readonly [number, number, number, number]
  readonly thickness: number
  readonly offset: number
}

export interface GlyphLayout {
  /** Capture-local SVG index shared by its paint layers. */
  readonly shapeGroup?: number
  /** Solid decorations attached to this glyph; preserved by retained reflow. */
  readonly decorations?: readonly TextDecorationLayout[]
  /**
   * Captured character width, excluding following whitespace: for decorations, for RTL reflow,
   * and on the last glyph of a word whose `advance` reaches across the space after it, so
   * reflow wraps and aligns words by their own width.
   */
  readonly decorationWidth?: number
  readonly glyphKey: string
  readonly fontSize: number
  readonly originX: number
  readonly lineBottom: number
  /**
   * Distance from `lineBottom` up to the glyph's baseline (the bottom of its box, for an SVG
   * shape). Captured text carries the font's descent as the browser's layout rounds it to
   * whole pixels: confirmed against the DOM's text boxes by Range captures, modelled by
   * Pretext. Absent, the baseline is the atlas or outline descent scaled to the font size.
   */
  readonly baselineOffset?: number
  /**
   * The move `pixelSnap` gave this glyph, already part of `originX` and `lineBottom`: taken
   * off them, it leaves the position the browser's layout gave the glyph.
   */
  readonly snap?: readonly [x: number, y: number]
  /** Shared animation centre and index for the tiles of a browser-shaped run. */
  readonly motionOrigin?: readonly [number, number, number]
  /**
   * @internal Size-switch em in local units; zero or below never switches, and a tone that
   * dilates the outline reads the magnitude as the font size. Set only on the layouts a
   * Windfoil backend derives, never on captured or stored snapshots.
   */
  readonly switchEm?: number
  /**
   * Distance to the next glyph's origin, so it carries the browser's kerning.
   * The last glyph on a line has no next origin and keeps its own ink width.
   */
  readonly advance: number
  /** Index into `DomLayoutSnapshot.blocks`. */
  readonly block: number
  /**
   * Explicit gap at a soft break; `0` keeps opt-in CJK breaks space-free. Browser captures
   * record the natural width of the whitespace before a word that starts a captured line, and
   * before every word after whitespace in a justified block, whose measured gaps hold the
   * justification. Reflow justifies a line over these breaks only. In a justified block the
   * glyph after a no-break space (U+00A0) records one too, with `breakBefore: 'none'`: reflow
   * widens that space as CSS does, but never breaks a line there.
   */
  readonly gapBefore?: number
  readonly breakBefore: GlyphBreak
  readonly clip: readonly [number, number, number, number]
  readonly color: readonly [number, number, number, number]
  readonly sequence: number
  readonly z: number
}

/** Per-block metrics that `reflowSnapshot` needs to re-wrap without the DOM. */
export interface TextBlockLayout {
  /** Left edge of the block's content box, in captured units. */
  readonly left: number
  /** Baseline of the block's first line, measured up from the capture bottom. */
  readonly firstBaseline: number
  /** Vertical distance between consecutive baselines. */
  readonly linePitch: number
  /** Width of the block's content box, which lines wrap and align in. */
  readonly width: number
  /** The block's border box, which bounds its glyphs' clips. */
  readonly clip: readonly [number, number, number, number]
  /** Captured CSS direction when `rtlReflow` is enabled. */
  readonly direction?: 'ltr' | 'rtl'
  /**
   * The side the block's lines align to: CSS `text-align`, with `start`, `end` and the
   * `-webkit-` values of `<center>` and `align` resolved by the block's direction. Absent when
   * it is the edge reflow lays lines from: the left, or the right of an RTL block under
   * `rtlReflow`.
   */
  readonly textAlign?: 'left' | 'center' | 'right' | 'justify'
  /**
   * How the last line, and each line before a forced break, aligns when CSS
   * `text-align-last` sets it apart from `textAlign`. Without it those lines follow
   * `textAlign`, and a justified block ends them on the edge reflow lays lines from.
   * `textAlign` is always present alongside it.
   */
  readonly textAlignLast?: 'left' | 'center' | 'right' | 'justify'
}

export interface RectLayout {
  readonly rect: readonly [number, number, number, number]
  readonly color: readonly [number, number, number, number]
  readonly radius: number
  readonly z: number
  readonly receiveShadow: boolean
}

export interface DomLayoutSnapshot {
  /** Browser-shaped runs retain their captured line breaks; resize through rebuild(). */
  readonly textShaping?: 'browser'
  readonly width: number
  readonly height: number
  readonly glyphs: readonly GlyphLayout[]
  readonly rects: readonly RectLayout[]
  readonly blocks: readonly TextBlockLayout[]
  readonly requests: readonly GlyphRequest[]
  readonly atlasSignature: string
  readonly lineCount: number
  /**
   * Set by `pixelSnap`: quarter device pixels and layout pixels per captured unit, the grids
   * `reflowSnapshot` snaps the origin and the line of a glyph it moves to.
   */
  readonly snapGrid?: readonly [x: number, y: number]
  /**
   * @internal Set on the layouts a Windfoil backend derives for `windfoil.sdfBelowPx` or for
   * a tone that dilates, so their `sdfMeta` stays three wide even without glyphs; never on
   * captured or stored snapshots.
   */
  readonly sizeSwitched?: true
}

export interface DomSdfStats {
  /** Captured text glyphs with baked SDF colour ink; excludes shape layers. */
  colorGlyphs: number
  /** Captured SVG paint-layer instances, excluded from `glyphs`. */
  shapes: number
  /** Text glyphs without a Windfoil outline, drawn by the SDF companion of the Windfoil backend. */
  fallbackGlyphs: number
  /**
   * Glyph and SVG-layer instances that `windfoil.sdfBelowPx` draws from the SDF companion
   * when small and with Windfoil when large; `0` unless the size switch is active.
   */
  switchableGlyphs: number
  /** Time spent preparing retained text data, in ms. `0` when it was reused. */
  atlasBuildMs: number
  /** Time spent reading DOM layout for the capture, in ms. */
  layoutReadMs: number
  /** Time spent building or updating the instanced geometry, in ms. */
  geometryBuildMs: number
  /** Number of captured glyph instances. */
  glyphs: number
  /** Number of captured rectangle instances. */
  rects: number
  /** Number of captured text lines. */
  lines: number
  /** Number of retained meshes (draw calls) in the generated group. */
  draws: number
  /** Atlas texture width in texels; `0` for Windfoil. */
  atlasWidth: number
  /** Atlas texture height in texels; `0` for Windfoil. */
  atlasHeight: number
  /** Which retained text implementation is active. */
  textBackend: DomTextBackend
  /** Which generator produced the retained SDF atlas; `null` for Windfoil. */
  atlasMode: 'gpu' | 'cpu' | null
  /** Retained atlas texture or Windfoil curve/row storage only, in bytes. */
  textStorageBytes: number
}

export interface DomSdfOptions {
  /** SDF colour detection: 'emoji' (default), 'all' colour fonts, or 'none' silhouettes. */
  colorGlyphs?: ColorGlyphMode
  /** Capture inline SVGs with the Range engine. Lazily loaded; off by default. */
  svg?: boolean | DomSvgOptions
  /** Custom TSL fill inside the glyph mask, for either text backend. */
  fill?: TextFill
  /** Custom TSL vertex position in capture-local coordinates, for either text backend and decorations. */
  vertex?: TextVertex
  /**
   * Shows text ink at the weight a browser gives it, for either text backend; see
   * `TextToneOptions`. Each capture resolves the `'auto'` values from the page: the model
   * from the platform and the source's computed font smoothing and `text-rendering`, the
   * backdrop from the captured rectangles behind the text, over the background colours
   * behind the source. One backdrop serves the whole capture, the one behind most of its
   * text; set `backdrop` where the scene shows the text against something the page does not.
   * `false` leaves the conversion out of the shaders. Defaults to on.
   */
  tone?: TextToneOptions | false
  /**
   * Outward outline, for either text backend; independent of scene shadow casting. On
   * Windfoil and Slug, glyphs drawn from outlines keep their exact fill, and the outline and
   * drop shadow come from an SDF underlay: those glyphs are also baked into the SDF companion
   * atlas, and one more draw, under the fill at the same render order, blends its ring and
   * shadow so that the two draws match single-pass SDF text. That costs the SDF bake, its
   * texture and an extra pipeline, and the ring keeps SDF edges under magnification. Glyphs
   * without outlines, and size-switched ones while small, are whole SDF text. A zero width or
   * opacity draws and bakes nothing. Limits: magnified, see-through ink shows the background
   * in a concave corner that the field rounds and the analytic fill leaves open; the colour
   * and fallback parts of separate texts sort by render order, not by depth.
   */
  outline?: SdfOutlineOptions
  /**
   * Hard drop shadow in the text plane, for either text backend; on Windfoil and Slug the SDF
   * underlay of `outline` draws it. A zero opacity draws and bakes nothing.
   */
  dropShadow?: SdfDropShadowOptions
  /**
   * Text layout implementation. `range` reads the browser's rendered glyph
   * boxes for maximum CSS fidelity. `pretext` measures and wraps through
   * `@chenglou/pretext` without a DOM Range read per glyph. Defaults to `range`.
   */
  layoutEngine?: DomTextLayoutEngine
  /**
   * Opt-in native Canvas shaping of complete rendered text runs. Defaults to 'none'.
   * 'browser' lazily loads the shaping module and makes collectDomSnapshot asynchronous.
   * Requires Range and SDF (or Windfoil's SDF fallback); resize with rebuild(), not reflow().
   */
  textShaping?: 'none' | 'browser'
  /**
   * Retained text coverage implementation. `'sdf'` is the default. Windfoil and
   * Slug evaluate quadratic outlines analytically and require WebGPU (see
   * `WindfoilOptions.fallback`). Their outlines come from `windfoil.outlineProvider`
   * (or `slug.outlineProvider`) below, or are traced from the captured fonts.
   */
  textBackend?: DomTextBackend
  /** Configuration used only when `textBackend` is `'windfoil'` (or as fallback for `'slug'`). */
  windfoil?: WindfoilOptions
  /** Configuration used when `textBackend` is `'slug'`. */
  slug?: SlugOptions
  /**
   * Text is collected only from these blocks. Defaults to `[data-text-block], [data-sdf-block]`.
   */
  textSelector?: string
  /**
   * Background rectangles are copied from these elements. Defaults to
   * `[data-text-rect], [data-sdf-rect]`.
   */
  rectSelector?: string
  /**
   * A matching element and its descendants are ignored.
   * Defaults to `[data-text-ignore], [data-sdf-ignore]`.
   */
  ignoreSelector?: string
  /**
   * Capture the root's visible solid background even when the root does not
   * match `rectSelector`. Defaults to `true`.
   */
  includeRootBackground?: boolean
  /**
   * Extra characters to bake for every captured font style, even when the DOM
   * does not currently contain them. They are baked as written, so list the
   * characters that CSS `text-transform` displays.
   *
   * Text that changes after capture — a live counter, a timing readout — would
   * otherwise need a new atlas the first time it shows a digit it has never
   * shown before. Listing those characters up front keeps the atlas signature
   * stable, so later rebuilds only repack instances. Missing one is not a
   * hiccup: a single new character or emoji sequence re-rasterizes, re-encodes and re-uploads
   * the whole atlas — a main-thread stall that can reach hundreds of
   * milliseconds at large atlas sizes, especially on the CPU fallback path.
   */
  extraGlyphs?: string
  /**
   * Caller-owned SDF atlas shared by several `DomSdf` instances.
   *
   * When every captured glyph is already in this atlas, the instance skips
   * rasterization and encoding and does not dispose the atlas. A missing glyph
   * builds a private atlas for that instance only. Windfoil ignores this option.
   * Dispose the shared atlas after every instance that uses it has been disposed.
   */
  sharedAtlas?: SdfAtlas
  /**
   * Captured X/Y values are divided by this positive scale to produce local
   * units. Z depths are not scaled. Defaults to `1` (one CSS pixel per unit).
   */
  pixelsPerUnit?: number
  /**
   * Puts captured text where the browser paints it instead of where its layout holds it. A
   * browser paints upright text with each line on a whole layout pixel, a half going down
   * the page, and each glyph origin on a quarter device pixel while the glyph is under 162
   * device pixels per em. The capture applies both, with every layout engine, from where the
   * element is in the viewport as it is read, and reads nothing more from the DOM. A Range
   * line is rounded as the browser rounds it, by the top of its highest text box, and each
   * box where that leaves it: text beside a superscript can land a row from its own nearest
   * one. Browser-shaped runs take the rows only, and they and Pretext round box by box.
   *
   * For text shown flat and unscaled over the page it was captured from: one unit on
   * `pixelsPerUnit` CSS pixels, the capture's corner on the element's. The result holds for
   * that position alone, so capture again once the element has moved by a fraction of a
   * pixel; lines sit up to a pixel nearer or further apart than the layout's pitch; and text
   * shown under any other transform only loses its layout positions. A layout pixel is the
   * one the capture settles for its baselines, else a device pixel. Under a CSS transform
   * the browser rounds a line where the layout holds it and the translation separately,
   * while the capture rounds where the two put it: the same row unless both carry a fraction.
   *
   * `DomSdf.reflow()` re-wraps the unsnapped layout and snaps each glyph it moved by its own
   * box, taking the element's top left corner as unmoved. Motion animates around the snapped
   * positions. Defaults to `false`.
   */
  pixelSnap?: boolean
  /** Default text Z for elements without an inherited `data-text-depth` (or `data-sdf-depth`). Defaults to `1`. */
  textDepth?: number
  /** Default Z for non-root captured rectangles. Defaults to `0`. */
  rectDepth?: number
  /** Default Z for the root rectangle. Defaults to `-1`. */
  panelDepth?: number
  /** Canvas font raster size in pixels; minimum `16`. Defaults to `96`. */
  bakeSize?: number
  /**
   * Retry overflowing atlases at a smaller bake size, down to 16px.
   * Defaults to `false`; fitting atlases keep their requested resolution.
   */
  adaptiveBakeSize?: boolean
  /** Enable CJK soft breaks with basic punctuation rules. Defaults to `false`. */
  cjkLineBreaking?: boolean
  /** Enable reflow of uniform RTL blocks captured with Range. Defaults to `false`. */
  rtlReflow?: boolean
  /**
   * Optional text reshape hook for complex scripts (such as Arabic or Persian)
   * that require contextual glyph shaping. It receives text after CSS
   * `text-transform`. Range capture requires unchanged code point boundaries
   * and whitespace; no reshaper is bundled or loaded.
   */
  reshape?: (text: string) => string
  /**
   * Add `.sdf-selectable` to the source. The app supplies overlay positioning
   * and CSS for native selection and copying.
   * Defaults to `false`.
   */
  selectable?: boolean
  /**
   * Glyph slot padding in atlas texels; minimum `2`. Defaults to `12`. The
   * padding doubles as the SDF pixel range, so raise it together with
   * `bakeSize` for unusually large or oblique text.
   */
  padding?: number
  /**
   * Maximum atlas dimension in texels; minimum `64`. Defaults to `2048`.
   * Overflow rejects the build instead of silently dropping glyphs. Text, monochrome SVG
   * shapes and colour glyphs are packed in rows of their own, one kind below the other, so a
   * capture that mixes them can need a shelf row more than its glyphs alone: near the limit,
   * raise it or set `adaptiveBakeSize`.
   */
  maxAtlasSize?: number
  /**
   * How the distance field is generated: `'gpu'`, `'cpu'`, or the GPU-first
   * `'auto'`. Defaults to `'auto'`.
   */
  atlasMode?: SdfAtlasMode
  /** Bake CPU distance fields in a Worker when available. Defaults to `true`. */
  cpuWorker?: boolean
  /**
   * SDF value treated as the glyph edge, in the atlas's `0..1` encoding.
   * Defaults to `0.5`, the baked outline; colour glyphs then keep `0.515`,
   * which hides the faint shading around some emoji strikes. The weight a
   * browser gives text comes from `tone`, not from a biased contour.
   */
  threshold?: number
  /**
   * Glyph coverage a fragment needs before it contributes to the shadow
   * silhouette. Defaults to `0.5`.
   */
  shadowCutoff?: number
  /**
   * Brightness of a fully shadowed rectangle, from `0` (black) to `1` (no
   * visible shadow). Defaults to `0.24`.
   */
  shadowFloor?: number
  /**
   * `high` uses four derivative-offset SDF samples, atlas mipmaps, and up to
   * 4× anisotropy for cleaner small/minified text. Defaults to `standard`
   * (one sample, no mips) for the fastest and smallest retained path.
   */
  quality?: SdfTextQuality
  /**
   * Extra weight in screen pixels for SDF glyphs under 16 pixels per em, on
   * top of `tone`. Defaults to `0`.
   */
  stemDarkening?: number
  /**
   * Whether the glyph mesh casts into shadow maps. Defaults to `true`; set to
   * `false` to skip the extra text draw per shadow-casting light when the
   * scene never needs text shadows.
   */
  castShadow?: boolean
  /** Face culling side for the generated glyph planes. Defaults to `FrontSide`. */
  side?: Side
  /**
   * TSL motion configuration; see `SdfMotionOptions` for the per-field defaults. Each build
   * reads the live mode: `'none'` builds static text without the motion graph, and the first
   * `setMotion()` to another mode swaps in animated materials once.
   */
  motion?: SdfMotionOptions
  /**
   * Retain the capture so `DomSdf.reflow(width)` can re-wrap the text without
   * reading the DOM again. Costs roughly 200 bytes per glyph; off by default.
   */
  reflowable?: boolean
  /**
   * Observe root resize, subtree mutation, and completed font loads, and
   * schedule coalesced rebuilds. Defaults to `true`; set to `false` for manual
   * `rebuild()` control.
   */
  observe?: boolean
  /** Aborts the initial build and any later rebuilds. */
  signal?: AbortSignal
  /**
   * Receives errors from observer-scheduled rebuilds, which no caller awaits.
   * Directly awaited `create()`/`rebuild()` calls reject normally instead.
   */
  onError?: (error: unknown) => void
}

export interface BuildSdfAtlasOptions {
  /** Use a module Worker for CPU encoding, falling back when unavailable. Defaults to `true`. */
  cpuWorker?: boolean
  /**
   * Generator selection. `'gpu'` fails without a real WebGPU backend, or on a
   * device whose limits cannot hold the passes or that reports an error for
   * them; `'cpu'` always works; the default `'auto'` tries the GPU path and
   * falls back to the CPU encoder in those cases, with a one-time console warning.
   */
  mode?: SdfAtlasMode
  /**
   * Generate and sample a mip chain for the retained atlas. This improves
   * minified text at the cost of roughly one third more texture memory.
   */
  mipmaps?: boolean
  /**
   * Requested atlas anisotropy. Values above `1` only have an effect when
   * mipmaps are enabled and are clamped by the active renderer.
   */
  anisotropy?: number
  signal?: AbortSignal
}

/** Alias for DomSdfOptions under the modern package name. */
export type DomTextOptions = DomSdfOptions

/** Inline CSS declarations, or camelCase/kebab-case properties (including custom properties). */
export type TextCss = string | Readonly<Record<string, string | number | null | undefined>>

/** Existing stylesheet classes, a list of class names, or a conditional class map. */
export type TextClass =
  string | readonly string[] | Readonly<Record<string, boolean | null | undefined>>

/** Options for direct string text with an owned, measurable DOM source. */
export interface TextOptions extends DomSdfOptions {
  /** Initialized renderer used to build the retained text. */
  renderer: WebGPURenderer
  /** Inline declarations. Numeric lengths use px; unitless properties keep plain numbers. */
  css?: TextCss
  /** Classes from loaded CSS, including stylesheets compiled from Sass or Stylus. */
  cssClass?: TextClass
  /** Connected container for inheritance and ancestor selectors. Defaults to document.body. */
  parent?: HTMLElement
}

/** Alias for DomSdfStats under the modern package name. */
export type DomTextStats = DomSdfStats

/** One source path in normalized SVG box space (longer side = 1000, Y down). */
export interface GlyphShapePath {
  readonly d: string
  readonly transform: WindfoilAffine
  readonly fillRule?: 'nonzero' | 'evenodd'
  readonly stroke?: GlyphShapeStroke
  /** Authored sRGBA paint, used only for bitmap capture. */
  readonly color?: readonly [number, number, number, number]
  /** @internal Normalized axis-aligned viewport clip for a merged bitmap path. */
  readonly clip?: readonly [number, number, number, number]
  /** @internal Nested SVG opacity groups, identified in painter order. */
  readonly opacityGroups?: readonly (readonly [number, number])[]
}

export interface GlyphShapeStroke {
  readonly width: number
  readonly lineCap: 'butt' | 'round' | 'square'
  readonly lineJoin: 'miter' | 'round' | 'bevel'
  readonly miterLimit: number
  readonly dash?: readonly number[]
  readonly dashOffset?: number
  readonly nonScaling?: boolean
}

export interface GlyphShape {
  readonly paths: readonly GlyphShapePath[]
  readonly box: readonly [number, number]
  readonly bounds: readonly [number, number, number, number]
  readonly bitmap?: true
  /** @internal Decoded, taint-probed image retained only until atlas rasterization. */
  readonly image?: HTMLImageElement
}

export interface DomSvgOptions {
  /** Outermost SVG selector. Defaults to `svg`. */
  readonly selector?: string
  readonly unsupported?: 'skip' | 'error'
  /** Positive path-data character budget; defaults to 1,000,000. */
  readonly maxPathData?: number
  /** Bake authored colours into one slot per SVG. */
  readonly render?: 'bitmap'
  /** Include loaded same-origin or CORS-clean images. */
  readonly images?: boolean
}

/** A filled path in SVG user space (positive Y points down). */
export interface WindfoilSvgPath {
  readonly d: string
  readonly fillRule?: 'nonzero' | 'evenodd'
  readonly transform?: WindfoilAffine
  readonly fill?: string
}
export interface WindfoilShapePathLike {
  readonly subPaths: readonly { readonly curves: readonly object[] }[]
  readonly userData?: Readonly<Record<string, unknown>>
}
export type WindfoilSvgSource =
  | string
  | SVGElement
  | WindfoilSvgPath
  | readonly WindfoilSvgPath[]
  | {
      readonly paths: readonly WindfoilShapePathLike[]
      readonly xml?: Element | Document
    }
export interface WindfoilEmBox {
  readonly unitsPerEm: number
  readonly ascent: number
  readonly descent: number
  readonly advance?: number
}
export interface SvgToWindfoilOptions {
  readonly em?: WindfoilEmBox
  readonly viewBox?: readonly [x: number, y: number, width: number, height: number]
  readonly preserveAspectRatio?: string
  readonly tolerance?: number
  readonly strokes?: 'warn' | 'error'
  readonly unsupported?: 'warn' | 'error'
  readonly computedStyle?: boolean
  readonly checkOverlaps?: boolean
  readonly maxElements?: number
  readonly maxPathData?: number
  readonly onWarning?: (warning: WindfoilSvgWarning) => void
}
export type WindfoilSvgPaint =
  WindfoilPaint | { readonly type: 'unsupported'; readonly value: string }
export interface WindfoilSvgLayer {
  readonly outline: WindfoilGlyphOutline
  readonly paint: WindfoilSvgPaint
  readonly source: string
}
export type WindfoilSvgWarningCode =
  | 'stroke-ignored'
  | 'unsupported-element'
  | 'unsupported-paint'
  | 'clip-path-ignored'
  | 'mask-ignored'
  | 'filter-ignored'
  | 'stylesheet-ignored'
  | 'unsupported-unit'
  | 'external-reference'
  | 'path-data-error'
  | 'self-intersection'
  | 'evenodd-ambiguous'
  | 'overlap'
  | 'viewport-overflow'
  | 'nested-viewport-lost'
  | 'degenerate-transform'
  | 'tolerance-capped'
  | 'dense-outline'
  | 'limit-exceeded'
  | 'empty'
export interface WindfoilSvgWarning {
  readonly code: WindfoilSvgWarningCode
  readonly message: string
  readonly source?: string
}
export interface WindfoilSvgResult {
  readonly outline: WindfoilGlyphOutline
  readonly layers: readonly WindfoilSvgLayer[]
  readonly warnings: readonly WindfoilSvgWarning[]
  readonly viewBox: readonly [number, number, number, number]
  readonly advance: number
  readonly stats: {
    readonly contours: number
    readonly quadratics: number
    readonly monotonePieces: number
    readonly cubics: number
    readonly arcs: number
    readonly droppedContours: number
  }
}
export interface WindfoilShapeInstance {
  readonly shape: string
  readonly x: number
  readonly y: number
  readonly size: number
  readonly color?: ColorRepresentation
  readonly opacity?: number
  readonly z?: number
  readonly sequence?: number
  readonly clip?: readonly [x0: number, y0: number, x1: number, y1: number]
}
export interface WindfoilShapesOptions {
  readonly fill?: TextFill
  readonly vertex?: TextVertex
  readonly side?: Side
  /**
   * Defaults to `{ enabled: false, mode: 'none' }`: static shapes, built without the motion
   * graph. `setMotion()` with another mode swaps in an animated material once (the mesh stays;
   * graph edits made on its material by hand are not carried over).
   */
  readonly motion?: SdfMotionOptions
  readonly castShadow?: boolean
  readonly shadowCutoff?: number
  readonly targetPiecesPerBand?: number
  /**
   * `'layers'` (default) draws one quad per paint layer in painter order. `'shader'` draws
   * one quad per instance and composites its layers top-down in the fragment shader,
   * stopping once opaque; it applies instance opacity to the whole artwork and supports
   * outline `clipBox`.
   */
  readonly compositing?: 'layers' | 'shader'
  readonly signal?: AbortSignal
}
export interface WindfoilShapesStats {
  readonly shapes: number
  readonly instances: number
  readonly monotonePieces: number
  readonly bandCount: number
  readonly duplication: number
  /** Full logical storage used by this handle; may be shared with other live handles. */
  readonly storageBytes: number
  /** Curve preprocessing time for this call, or zero when reusing live prepared resources. */
  readonly preprocessMs: number
}
export interface WindfoilShapes extends Group {
  readonly mesh: Mesh
  readonly stats: WindfoilShapesStats
  setInstances(instances: readonly WindfoilShapeInstance[]): void
  /**
   * Updates the motion uniforms. On static shapes (mode `'none'`), the first other mode
   * replaces `mesh.material` with an animated one, once.
   */
  setMotion(motion: SdfMotionOptions): this
  dispose(): void
}

/** SVG artwork stays app-owned; `resolve` receives the original emoji cluster. */
export interface SvgEmojiOutlineProviderOptions {
  resolve(cluster: string, signal: AbortSignal): Promise<string | null>
  readonly text: WindfoilOutlineProvider
  readonly em?: WindfoilEmBox
}
