import type * as SvgCapture from './svgCapture.js'
import type * as PretextLayout from './pretextLayout.js'

import { snapGlyph } from '../text/reflow.js'
import type * as BrowserShaping from './browserShaping.js'
import { glyphClusters, isEmojiCandidate } from './clusters.js'
import { DEFAULT_IGNORE_SELECTOR, DEFAULT_RECT_SELECTOR, DEFAULT_TEXT_SELECTOR } from './markup.js'
import {
  precedingCharacter,
  resolveTextTransform,
  transformClusters,
  type TextTransform,
} from './textTransform.js'
import type {
  DomLayoutSnapshot,
  DomSdfOptions,
  DomSvgOptions,
  FontStyleSnapshot,
  GlyphLayout,
  GlyphRequest,
  RectLayout,
  TextBlockLayout,
  TextDecorationLayout,
} from '../types.js'

// The `data-text-*` name leads; the original `data-sdf-*` name is still read.
const DEPTH_ATTRIBUTE = 'data-text-depth'
const LEGACY_DEPTH_ATTRIBUTE = 'data-sdf-depth'
const SHOW_ELEMENT = 1
const SHOW_TEXT = 4
/** Placeholder so a block that contributes no text still occupies its index. */
const EMPTY_BLOCK: TextBlockLayout = {
  left: 0,
  firstBaseline: 0,
  linePitch: 0,
  width: 0,
  clip: [0, 0, 0, 0],
}

// Range offsets remain valid only when code point lengths and whitespace match.
const reshapeBoundaries = (text: string): string =>
  text.replace(/\S/gu, (character) => String(character.length))

/** The part of a Range box that one glyph occupies. */
type GlyphBox = Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width' | 'height'>

const canBreakCjk = (p: string, c: string): boolean =>
  !!p &&
  /[\u2e80-\ud7ff\uf900-\uff9f\u{20000}-\u{323af}]/u.test(p + c) &&
  !'、。，．・！？：；ー〜…々）」』】〕〉》］｝”’\'"!?,.:;%｡､･ｰ'.includes(c) &&
  !'（「『【〔〈《［｛“‘\'"('.includes(p)

function parsePx(value: string | null | undefined, fallback = 0, ref = 0): number {
  const parsed = Number.parseFloat(value!)
  return !Number.isFinite(parsed)
    ? fallback
    : ref && value!.endsWith('%')
      ? (parsed * ref) / 100
      : ref && (value!.endsWith('em') || !/[a-z]/i.test(value!))
        ? parsed * ref
        : parsed
}

const isHidden = (style: CSSStyleDeclaration): boolean => /hidden|collapse/.test(style.visibility)

/** Border and padding on one side of a box. jsdom reports a medium border where there is none. */
const inset = (style: CSSStyleDeclaration, side: 'Left' | 'Right'): number =>
  (/none|hidden/.test(style[`border${side}Style`]) ? 0 : parsePx(style[`border${side}Width`])) +
  parsePx(style[`padding${side}`])

type TextAlign = NonNullable<TextBlockLayout['textAlign']>

/**
 * @internal The side a computed CSS `text-align` or `text-align-last` lines up to: `start` and
 * `end` by the block's own direction, and the `-webkit-` values that `<center>` and the
 * `align` attribute compute to as plain sides. Anything else, `auto` or jsdom's empty value,
 * is the start edge.
 */
export function physicalAlign(value: string, rtl: boolean): TextAlign {
  const side = value.replace('-webkit-', '')
  return /^(left|right|center|justify)$/.test(side)
    ? (side as TextAlign)
    : (side === 'end') !== rtl
      ? 'right'
      : 'left'
}

type CachedWidthRun = [string, GlyphBox[], GlyphBox | undefined]
const sameBox = (a: GlyphBox, b: GlyphBox | undefined): boolean =>
  !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

let colorProbe: CanvasRenderingContext2D | null = null
let sharedKerningContext: OffscreenCanvasRenderingContext2D | null | undefined
let sharedWidthsByFont = new Map<string, Map<string, number>>()
let cachedTextRuns = new WeakMap<Text, CachedWidthRun>()
let lastFontSetSize = -1

const TRANSPARENT_SRGBA = [0, 0, 0, 0] as unknown as [number, number, number, number]
const parsedColors = new Map<string, [number, number, number, number]>([
  ['transparent', TRANSPARENT_SRGBA],
  ['rgba(0, 0, 0, 0)', TRANSPARENT_SRGBA],
])

function cssColorToSrgba(
  document: Document,
  value: string,
  opacity: number,
): [number, number, number, number] {
  if (opacity <= 0 || !value) return TRANSPARENT_SRGBA
  let rgba = parsedColors.get(value)
  if (!rgba) {
    const functional = /rgba?\(([^)]+)\)/i.exec(value)
    if (functional) {
      const channels = functional[1]!.trim().split(/[\s,/]+/)
      const read = (i: number, max = 255): number => {
        const v = channels[i]
        return v ? (v.includes('%') ? parseFloat(v) / 100 : parseFloat(v) / max) : max === 1 ? 1 : 0
      }
      rgba = [read(0), read(1), read(2), read(3, 1)]
    } else {
      colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!colorProbe) throw new Error('collectDomSnapshot: Canvas 2D is unavailable')
      colorProbe.fillStyle = '#000'
      colorProbe.fillStyle = value
      colorProbe.clearRect(0, 0, 1, 1)
      colorProbe.fillRect(0, 0, 1, 1)
      const pixel = colorProbe.getImageData(0, 0, 1, 1).data
      rgba = [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255, pixel[3]! / 255]
    }
    if (parsedColors.size >= 1024) parsedColors.clear()
    parsedColors.set(value, rgba)
  }
  if (rgba[3] <= 0) return TRANSPARENT_SRGBA
  return opacity === 1
    ? rgba
    : [rgba[0], rgba[1], rgba[2], Math.min(1, Math.max(0, rgba[3] * opacity))]
}

const EMPTY_DECORATION_OWNERS: readonly never[] = []

function canvasFont(style: CSSStyleDeclaration, bakeSize: number): string {
  const rawStyle = style.fontStyle
  const fontStyle =
    rawStyle === 'italic' ? 'italic ' : rawStyle.startsWith('oblique') ? 'oblique ' : ''
  const variant = /(?:^|\s)small-caps(?:\s|$)/.test(style.fontVariant) ? 'small-caps ' : ''
  return `${fontStyle}${variant}${style.fontWeight || '400'} ${bakeSize}px ${style.fontFamily}`.trim()
}

type CanvasFontMetrics = readonly [number, number]

function fontMetrics(
  context: CanvasRenderingContext2D,
  font: string,
  fontSize: number,
  cache: Map<string, CanvasFontMetrics>,
): CanvasFontMetrics {
  let result = cache.get(font)
  if (!result) {
    context.font = font
    const metrics = context.measureText('Mg')
    result = [
      Math.max(
        1,
        metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontSize * 0.8,
      ),
      Math.max(
        0,
        metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontSize * 0.2,
      ),
    ]
    cache.set(font, result)
  }
  return result
}

/**
 * Whether the distance between two client coordinates misses the layout grid at `scale`.
 * Chromium positions layout in 1/64ths of a layout pixel. Client rectangles are 32-bit
 * floats, so the slack grows with the coordinates themselves, not with their difference.
 */
function offLayoutGrid(coordinate: number, origin: number, scale: number): boolean {
  const units = (coordinate - origin) * 64 * scale
  return (
    Math.abs(units - Math.round(units)) >
    0.02 + (Math.abs(coordinate) + Math.abs(origin)) * 64 * scale * 2 ** -22
  )
}

function layoutDescents(
  context: CanvasRenderingContext2D,
  boxHeights: ReadonlyMap<FontStyleSnapshot, number>,
  scales: readonly number[],
  bakeSize: number,
  cache: Map<string, CanvasFontMetrics>,
): readonly [Map<FontStyleSnapshot, number>, number | undefined] {
  const candidates: [FontStyleSnapshot, (number | undefined)[], number[]][] = []
  let settled = -1
  for (const [font, height] of boxHeights) {
    const descents = scales.map((scale) => {
      const size = font.size * scale
      const [ascent, descent] = fontMetrics(
        context,
        font.canvasFont.replace(`${bakeSize}px`, `${size}px`),
        size,
        cache,
      )
      return Math.abs((ascent + descent) / scale - height) < 0.01 ? descent / scale : undefined
    })
    const fitting = descents.filter((d): d is number => d !== undefined)
    candidates.push([font, descents, fitting])
    if (fitting.length === 1) {
      const index = descents.indexOf(fitting[0])
      settled = settled === -1 || settled === index ? index : -2
    }
  }
  const result = new Map<FontStyleSnapshot, number>()
  for (const [font, descents, fitting] of candidates) {
    if (!fitting.length) continue
    const descent = fitting.every((value) => Math.abs(value - fitting[0]!) < 1e-3)
      ? fitting[0]
      : settled >= 0
        ? descents[settled]
        : undefined
    if (descent !== undefined) result.set(font, descent)
  }
  return [result, scales.length === 1 ? scales[0] : scales[settled]]
}

/**
 * Captures all DOM reads in one phase. The default Range engine returns
 * synchronously; the Pretext engine is loaded lazily and returns a promise.
 * Glyph animation and rendering use only the resulting static typed data.
 */
export function collectDomSnapshot(
  root: HTMLElement,
  options: DomSdfOptions &
    (
      | { readonly textShaping: 'browser' }
      | { readonly layoutEngine: 'pretext' }
      | { readonly svg: true | DomSvgOptions }
    ),
): Promise<DomLayoutSnapshot>
export function collectDomSnapshot(
  root: HTMLElement,
  options?: DomSdfOptions & {
    readonly layoutEngine?: 'range'
    readonly textShaping?: 'none'
    readonly svg?: false
  },
): DomLayoutSnapshot
export function collectDomSnapshot(
  root: HTMLElement,
  options: DomSdfOptions,
): DomLayoutSnapshot | Promise<DomLayoutSnapshot>
export function collectDomSnapshot(
  root: HTMLElement,
  options: DomSdfOptions = {},
): DomLayoutSnapshot | Promise<DomLayoutSnapshot> {
  if (options.svg || options.textShaping === 'browser' || options.layoutEngine === 'pretext') {
    return Promise.all([
      options.layoutEngine === 'pretext' ? import('./pretextLayout.js') : undefined,
      options.textShaping === 'browser' ? import('./browserShaping.js') : undefined,
      options.svg ? import('./svgCapture.js') : undefined,
    ]).then(([pretext, shaping, svg]) => {
      if (svg && pretext) throw new RangeError('svg requires the Range layout engine')
      svg?.resolveSvgOptions(options.svg!)
      shaping?.validateBrowserShaping(options)
      return collectDomSnapshotSync(root, options, pretext, shaping, svg)
    })
  }
  return collectDomSnapshotSync(root, options)
}

function collectDomSnapshotSync(
  root: HTMLElement,
  options: DomSdfOptions,
  pretext?: typeof PretextLayout,
  shaping?: typeof BrowserShaping,
  svg?: typeof SvgCapture,
): DomLayoutSnapshot {
  const document = root.ownerDocument
  const view = document.defaultView
  if (!view)
    throw new Error('collectDomSnapshot: the element is not attached to a browser document')
  if (!root.isConnected) throw new Error('collectDomSnapshot: the source element must be connected')
  const textSelector = options.textSelector ?? DEFAULT_TEXT_SELECTOR
  const rectSelector = options.rectSelector ?? DEFAULT_RECT_SELECTOR
  const ignoreSelector = options.ignoreSelector ?? DEFAULT_IGNORE_SELECTOR
  const bakeSize = options.bakeSize ?? 96
  const pixelsPerUnit = options.pixelsPerUnit ?? 1
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) {
    throw new RangeError('collectDomSnapshot: pixelsPerUnit must be a positive finite number')
  }
  const invScale = 1 / pixelsPerUnit
  const rootRect = root.getBoundingClientRect()
  const { left: rootLeft, bottom: rootBottom } = rootRect
  if (rootRect.width <= 0 || rootRect.height <= 0) {
    throw new Error('collectDomSnapshot: the source element has no layout box')
  }
  if (options.layoutEngine !== undefined && !['range', 'pretext'].includes(options.layoutEngine)) {
    throw new RangeError("collectDomSnapshot: layoutEngine must be 'range' or 'pretext'")
  }

  // Built mutably so each glyph's advance can be back-filled from the next
  // glyph's origin, which is what carries the browser's kerning.
  type MutableGlyph = { -readonly [K in keyof GlyphLayout]: GlyphLayout[K] }
  const glyphs: MutableGlyph[] = []
  const blockLayouts: TextBlockLayout[] = []
  let afterSpace = true
  const rects: RectLayout[] = []
  const requests = new Map<string, GlyphRequest>()
  let lineCount = 0
  interface NodeRecord {
    readonly el: Element
    readonly u: NodeRecord | null
    readonly owner: Element | null
    readonly ig: boolean
    readonly do: Element | null
    readonly k?: string | undefined
    readonly p?: NodeRecord | undefined
    s?: CSSStyleDeclaration
    d?: string
    b?: boolean
    o?: number
    h?: boolean
    dec?: readonly Element[]
    inline?: InlineStyle | null
    paragraph?: Element | null
  }
  const defaultTextAttr = textSelector === DEFAULT_TEXT_SELECTOR
  const defaultIgnoreAttr = ignoreSelector === DEFAULT_IGNORE_SELECTOR
  const attrOnly = defaultTextAttr && defaultIgnoreAttr
  const fonts = document.fonts as FontFaceSet | undefined
  const nativeBrowser =
    'CanvasRenderingContext2D' in view &&
    'OffscreenCanvas' in view &&
    fonts?.status === 'loaded' &&
    Function.prototype.toString.call(view.OffscreenCanvas).includes('[native')
  if (nativeBrowser && fonts.size !== lastFontSetSize) {
    lastFontSetSize = fonts.size
    sharedWidthsByFont = new Map()
    cachedTextRuns = new WeakMap()
  }
  let share = !svg && !('mock' in (view as { getComputedStyle: object }).getComputedStyle)
  try {
    for (const s of (root.getRootNode() as { styleSheets?: StyleSheetList }).styleSheets ?? [])
      for (const r of s.cssRules) if (/[:+~]/.test(r.cssText)) share = false
  } catch {
    share = false
  }
  const pathStyles = new Map<string, NodeRecord>()
  const nodes = new Map<Element, NodeRecord>()
  const nodeOf = (el: Element): NodeRecord => {
    let rec = nodes.get(el)
    if (!rec) {
      const parent = el === root ? null : el.parentElement
      const u = parent ? nodeOf(parent) : null
      const hasAttrs = !attrOnly || el.hasAttributes()
      let k =
        share && (el === root || u?.k !== undefined) ? `${u?.k ?? ''}>${el.localName}` : undefined
      if (k && el !== root)
        for (const a of el.attributes)
          k += `\u0001${a.name}=${
            a.name === 'style'
              ? a.value.replace(/(?:^|;)\s*(?:left|top|right|bottom|inset)\s*:[^;]*/gi, '')
              : a.value
          }`
      const p = k ? pathStyles.get(k) : undefined
      rec = {
        el,
        u,
        owner:
          hasAttrs &&
          (defaultTextAttr
            ? el.hasAttribute('data-text-block') || el.hasAttribute('data-sdf-block')
            : el.matches(textSelector))
            ? el
            : (u?.owner ?? null),
        ig:
          (u?.ig ?? false) ||
          (hasAttrs &&
            (defaultIgnoreAttr
              ? el.hasAttribute('data-text-ignore') || el.hasAttribute('data-sdf-ignore')
              : el.matches(ignoreSelector))),
        do:
          hasAttrs && (el.hasAttribute(DEPTH_ATTRIBUTE) || el.hasAttribute(LEGACY_DEPTH_ATTRIBUTE))
            ? el
            : (u?.do ?? null),
        k,
        p,
      }
      if (k && !p) pathStyles.set(k, rec)
      nodes.set(el, rec)
    }
    return rec
  }
  const styleOf = (el: Element, rec = nodeOf(el)): CSSStyleDeclaration =>
    (rec.s ??= rec.p ? styleOf(rec.p.el, rec.p) : view.getComputedStyle(el))
  const opacityOf = (el: Element, rec = nodeOf(el)): number =>
    (rec.o ??= rec.p
      ? opacityOf(rec.p.el, rec.p)
      : (Number.parseFloat(styleOf(el, rec).opacity) || 0) *
        (rec.u ? opacityOf(rec.u.el, rec.u) : 1))
  const displayNone = (el: Element, rec = nodeOf(el)): boolean =>
    (rec.h ??= rec.p
      ? displayNone(rec.p.el, rec.p)
      : (rec.u !== null && displayNone(rec.u.el, rec.u)) ||
        (rec.d ??= styleOf(el, rec).display) === 'none')
  const isInlineBox = (el: Element, rec = nodeOf(el)): boolean =>
    (rec.b ??= rec.p
      ? isInlineBox(rec.p.el, rec.p)
      : /^(|inline.*|contents)$/.test((rec.d ??= styleOf(el, rec).display)))
  const decorationsOf = (el: Element, rec = nodeOf(el)): readonly Element[] => {
    if (!rec.dec) {
      const inherited = rec.u ? decorationsOf(rec.u.el, rec.u) : EMPTY_DECORATION_OWNERS
      const style = styleOf(el, rec)
      const line = style.textDecorationLine || style.textDecoration
      rec.dec =
        line &&
        line !== 'none' &&
        /underline|overline|line-through/.test(line) &&
        (!style.textDecorationStyle || style.textDecorationStyle === 'solid')
          ? [el, ...inherited]
          : inherited
    }
    return rec.dec
  }
  // Inheriting matters: inline markup inside a positioned block (`<strong>`, a `<code>` span)
  // would otherwise fall back to the default depth while its surrounding text sits forward.
  const depthOf = (element: Element, fallback: number): number => {
    const owner = nodeOf(element).do
    return owner
      ? parsePx(
          owner.getAttribute(DEPTH_ATTRIBUTE) ?? owner.getAttribute(LEGACY_DEPTH_ATTRIBUTE),
          fallback,
        )
      : fallback
  }
  const isIgnored = (element: Element): boolean => nodeOf(element).ig

  let shapeGroup = 0
  const shapeBoxes = new Map<number, readonly [number, number, number, number]>()
  const capturedSvgs = new Set<Element>()
  const svgOptions = options.svg ? svg!.resolveSvgOptions(options.svg) : null
  const svgContext = svgOptions
    ? {
        style: styleOf,
        opacity: opacityOf,
        displayNone,
        ignored: isIgnored,
        color: (value: string, opacity: number) => cssColorToSrgba(document, value, opacity),
        requests,
        rootLeft,
        rootBottom,
        invScale,
        options: svgOptions,
        budget: { pathData: svgOptions.maxPathData ?? 1_000_000 },
      }
    : null
  const captureShape = (
    element: Element,
    blockIndex: number,
    clip: readonly [number, number, number, number],
    sequence: number,
  ): boolean => {
    if (
      !svgContext ||
      !svg ||
      (!element.matches(svgOptions!.selector ?? 'svg') &&
        !(svgOptions!.images && element.localName === 'img'))
    )
      return false
    const ancestorSvg = element.parentElement?.closest('svg')
    if (ancestorSvg && root.contains(ancestorSvg)) return false
    capturedSvgs.add(element)
    const capture = svg.captureSvg(element as SVGSVGElement, svgContext)
    if (capture) {
      shapeBoxes.set(shapeGroup, capture.box)
      svg.appendSvg(
        capture,
        glyphs,
        blockIndex,
        shapeGroup++,
        clip,
        depthOf(element, options.textDepth ?? 1),
        sequence,
      )
    }
    return true
  }
  const blocks = [
    ...(root.matches(textSelector) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(textSelector),
  ]

  const layoutEngine = options.layoutEngine ?? 'range'
  if (options.rtlReflow && layoutEngine !== 'range') {
    throw new RangeError('collectDomSnapshot: rtlReflow requires the Range layout engine')
  }
  let range: Range | undefined
  const appendBrowserRuns = shaping?.createBrowserCapture(document)
  // Font metrics for decorations, and advances that split a text-transform expansion.
  let fontProbe: CanvasRenderingContext2D | null | undefined
  // Metrics are size-dependent, so key by the full Canvas font, not the atlas key.
  // Keep the cache local: a subsequent capture may run after a webfont has loaded.
  const metricsByFont = new Map<string, CanvasFontMetrics>()
  // Range text runs as [font, first glyph, end], with the text box height the DOM gave each
  // font and whether any glyph edge, taken from the root's, misses the layout grid at CSS or
  // device scale. One pass after the walk turns these into the browser's own baselines; see
  // `layoutDescents`. jsdom has no 2D canvas to measure with and logs an error when asked.
  const measuresBaselines = 'CanvasRenderingContext2D' in view
  const deviceScale = view.devicePixelRatio > 0 ? view.devicePixelRatio : 1
  const textRuns: (readonly [FontStyleSnapshot, number, number])[] = []
  const boxHeights = new Map<FontStyleSnapshot, number>()
  let offCssGrid = false
  let offDeviceGrid = false
  const offBox = (l: number, w: number, scale: number): boolean =>
    offLayoutGrid(l, rootLeft, scale) || offLayoutGrid(l + w, rootLeft, scale)
  const trackLayoutGrid = (l: number, w: number): void => {
    if (!offCssGrid) offCssGrid = offBox(l, w, 1)
    if (deviceScale !== 1 && !offDeviceGrid) offDeviceGrid = offBox(l, w, deviceScale)
  }
  // A layout pixel can only be the device's or the CSS one where every glyph edge is whole
  // on that grid; text laid out at a device scale leaves edges between CSS grid lines.
  const layoutScales = (): number[] => [
    ...(deviceScale === 1 || offDeviceGrid ? [] : [deviceScale]),
    ...(offCssGrid ? [] : [1]),
  ]
  const readDecorations = (
    parent: HTMLElement,
    layoutFont: string,
    fontSize: number,
    opacity: number,
  ): readonly TextDecorationLayout[] => {
    const owners = decorationsOf(parent)
    if (owners.length === 0) return EMPTY_DECORATION_OWNERS
    fontProbe ??= document.createElement('canvas').getContext('2d')
    const [ascent, descent] = fontProbe
      ? fontMetrics(fontProbe, layoutFont, fontSize, metricsByFont)
      : [fontSize * 0.8, fontSize * 0.2]
    const result: TextDecorationLayout[] = []
    for (const owner of owners) {
      const style = styleOf(owner)
      const lineTokens = (style.textDecorationLine || style.textDecoration || '').split(/\s+/)
      const cssSize = parsePx(style.fontSize, fontSize)
      const thickness = Math.max(0, parsePx(style.textDecorationThickness, cssSize / 16, cssSize))
      const underlineOffset = parsePx(style.textUnderlineOffset, cssSize * 0.1, cssSize)
      const color = cssColorToSrgba(
        document,
        !style.textDecorationColor || style.textDecorationColor === 'currentcolor'
          ? style.color
          : style.textDecorationColor,
        opacity,
      )
      for (const line of ['underline', 'overline', 'line-through'] as const) {
        if (!lineTokens.includes(line)) continue
        const offset =
          descent +
          (line === 'underline' ? -underlineOffset : line === 'overline' ? ascent : fontSize * 0.3)
        result.push({ line, color, thickness: thickness * invScale, offset: offset * invScale })
      }
    }
    return result
  }
  // Every value below depends only on the text node's parent element, but a
  // block routinely holds many text nodes per element (inline markup, text split
  // around <strong>), so resolve each parent once. `null` marks a skipped one.
  interface InlineStyle {
    readonly decorations: readonly TextDecorationLayout[]
    readonly font: FontStyleSnapshot
    readonly keys: Map<string, string>
    readonly fontSize: number
    readonly layoutFont: string
    readonly widths: Map<string, number>
    readonly letterSpacing: number
    readonly wordSpacing: number
    /**
     * One space in this style, with its letter and word spacing: what reflow puts between the
     * words a whitespace run joins. Zero where Canvas cannot measure it (jsdom).
     */
    readonly space: number
    /** Whether `white-space` keeps each space of a run instead of collapsing it to one. */
    readonly keepsSpaces: boolean
    readonly color: readonly [number, number, number, number]
    readonly z: number
    /** Computed `text-transform`; null when it leaves the text as written. */
    readonly transform: TextTransform | null
  }
  type FontEntry = readonly [
    FontStyleSnapshot,
    Map<string, string>,
    string,
    Map<string, number>,
    number,
  ]
  const capturedKeys = new Map<string, Map<string, string>>()
  const fontEntries = new Map<string, FontEntry>()
  // Automatic optical sizing can select a different outline at each CSS size.
  // Keep SDF's usual size-independent atlas sharing, but distinguish those
  // requests when the app has explicitly selected the outline backend.
  const fontRequestKey = (font: FontStyleSnapshot): string =>
    options.textBackend === 'windfoil' && font.opticalSizing === 'auto'
      ? `${font.key}|${font.size}`
      : font.key
  const requestKey = (
    font: FontStyleSnapshot,
    keys: Map<string, string>,
    character: string,
  ): string => {
    let key = keys.get(character)
    if (key === undefined) {
      key = `${fontRequestKey(font)}\u0000${character}`
      keys.set(character, key)
      requests.set(key, { key, character, font })
    }
    return key
  }

  // Pair kerning and lone widths as Canvas shapes them, at the run's CSS size, for the Range
  // walk's kerning shift (below), on a context of their own: an OffscreenCanvas, which every
  // browser that can draw the result has, and jsdom does not. Keyed per layout font.
  const measuresKerning = 'OffscreenCanvas' in view
  let kerningContext: OffscreenCanvasRenderingContext2D | null | undefined
  let lastKerningFont = ''
  const canvasWidth = (cssFont: string, widths: Map<string, number>, text: string): number => {
    let width = widths.get(text)
    if (width === undefined) {
      if (kerningContext === undefined) {
        kerningContext =
          (nativeBrowser ? sharedKerningContext : undefined) ??
          new (view as Window & { OffscreenCanvas: typeof OffscreenCanvas }).OffscreenCanvas(
            1,
            1,
          ).getContext('2d')
        if (kerningContext) kerningContext.letterSpacing = '0px'
        if (nativeBrowser) sharedKerningContext = kerningContext
      }
      if (kerningContext && lastKerningFont !== cssFont) {
        kerningContext.font = lastKerningFont = cssFont
      }
      width = kerningContext?.measureText(text).width ?? 0
      widths.set(text, width)
    }
    return width
  }

  const resolveFont = (style: CSSStyleDeclaration): FontEntry => {
    const shorthand = style.fontKerning && style.font
    let entry = shorthand ? fontEntries.get(shorthand) : undefined
    if (entry) return entry
    const or = (v: string, d = 'normal') => v || d
    const family = style.fontFamily
    const weight = or(style.fontWeight, '400')
    const fontStyle = or(style.fontStyle)
    const stretch = or(style.fontStretch)
    const variant = or(style.fontVariant || style.fontVariantCaps)
    const kerning = or(style.fontKerning, 'auto')
    const featureSettings = or(style.fontFeatureSettings)
    const variationSettings = or(style.fontVariationSettings)
    const opticalSizing = or(style.fontOpticalSizing, 'auto')
    const key = [
      family,
      weight,
      fontStyle,
      stretch,
      variant,
      kerning,
      featureSettings,
      variationSettings,
      opticalSizing,
    ].join('|')
    const size = parsePx(style.fontSize, 16)
    const cacheKey = `${key}\u0000${size}`
    entry = fontEntries.get(cacheKey)
    if (!entry) {
      const font: FontStyleSnapshot = {
        key,
        canvasFont: canvasFont(style, bakeSize),
        family,
        weight,
        style: fontStyle,
        stretch,
        variant,
        kerning,
        featureSettings,
        variationSettings,
        opticalSizing,
        size,
      }
      const reqKey = fontRequestKey(font)
      let keys = capturedKeys.get(reqKey)
      if (!keys) capturedKeys.set(reqKey, (keys = new Map<string, string>()))
      const layoutFont = font.canvasFont.replace(`${bakeSize}px`, `${size}px`)
      let widths = nativeBrowser ? sharedWidthsByFont.get(layoutFont) : undefined
      if (!widths) {
        widths = new Map<string, number>()
        if (nativeBrowser) sharedWidthsByFont.set(layoutFont, widths)
      }
      entry = [
        font,
        keys,
        layoutFont,
        widths,
        measuresKerning ? canvasWidth(layoutFont, widths, ' ') : 0,
      ]
      fontEntries.set(cacheKey, entry)
    }
    if (shorthand) fontEntries.set(shorthand, entry)
    return entry
  }

  const resolveInline = (parent: HTMLElement): InlineStyle | null => {
    const style = styleOf(parent)
    if (isHidden(style)) return null
    const opacity = opacityOf(parent)
    if (opacity <= 0) return null
    const [font, keys, layoutFont, widths, space] = resolveFont(style)
    const spacing = parsePx(style.letterSpacing, 0, font.size)
    const wordSpacing = parsePx(style.wordSpacing, 0, font.size)
    const whiteSpace = style.whiteSpace
    return {
      decorations: readDecorations(parent, layoutFont, font.size, opacity),
      font,
      keys,
      fontSize: font.size * invScale,
      layoutFont,
      widths,
      letterSpacing: spacing,
      wordSpacing,
      space: space && (space + spacing + wordSpacing) * invScale,
      keepsSpaces: whiteSpace !== 'normal' && /pre(?!-l)|bre/.test(whiteSpace),
      color: cssColorToSrgba(document, style.color, opacity),
      z: depthOf(parent, options.textDepth ?? 1),
      transform: resolveTextTransform(style.textTransform, parent),
    }
  }

  const transformSeed = (node: Text, transform: TextTransform): string | undefined =>
    transform.caseMap === 'capitalize' ? precedingCharacter(node, styleOf) : undefined

  const expansionBoxes = (
    share: string,
    box: GlyphBox,
    font: FontStyleSnapshot,
  ): (GlyphBox & { readonly c: string })[] | undefined => {
    if (share.length <= (share.codePointAt(0)! > 0xffff ? 2 : 1)) return undefined
    const parts = Array.from(share)
    fontProbe ??= document.createElement('canvas').getContext('2d')
    if (fontProbe) fontProbe.font = font.canvasFont
    const advances = parts.map((part) =>
      /^\p{M}/u.test(part) ? 0 : (fontProbe?.measureText(part).width ?? 1),
    )
    const total = advances.reduce((sum, advance) => sum + advance, 0)
    let left = box.left
    return parts.map((c, index) => {
      const width = total > 0 ? (box.width * advances[index]!) / total : box.width / parts.length
      const item = {
        left,
        top: box.top,
        bottom: box.bottom,
        width,
        height: box.height,
        c,
      }
      left += width
      return item
    })
  }

  const paragraphOf = (el: Element, rec: NodeRecord, block: Element): Element =>
    el === block || !isInlineBox(el, rec)
      ? el
      : rec.u?.owner === block
        ? (rec.u.paragraph ??= paragraphOf(rec.u.el, rec.u, block))
        : block

  const resolveParent = (parent: HTMLElement) => {
    const rec = nodeOf(parent)
    if (rec.inline === undefined) {
      if (rec.p) {
        if (rec.p.inline === undefined) resolveParent(rec.p.el as HTMLElement)
        rec.inline = rec.ig ? null : rec.p.inline!
      } else {
        rec.inline = rec.ig || displayNone(parent, rec) ? null : resolveInline(parent)
      }
      rec.paragraph =
        pretext && rec.owner && rec.inline ? paragraphOf(parent, rec, rec.owner) : null
    }
    return rec as NodeRecord & {
      readonly inline: InlineStyle | null
      readonly paragraph: Element | null
    }
  }

  const pretextCapture = pretext?.createPretextCapture(
    root,
    document,
    options,
    bakeSize,
    invScale,
    rootRect,
    measuresBaselines,
    deviceScale,
    boxHeights,
    glyphs,
    displayNone,
    isInlineBox,
    isIgnored,
    resolveParent,
    transformSeed,
    requestKey,
    parsePx,
    canvasFont,
    (context, font, fontSize) => fontMetrics(context, font, fontSize, metricsByFont),
    (box) => trackLayoutGrid(box.left, box.width),
    (context) => layoutDescents(context, boxHeights, layoutScales(), bakeSize, metricsByFont)[1],
    canBreakCjk,
  )
  fontProbe = pretextCapture?.[0]
  // The layout pixel in CSS pixels, once the grid or the fonts single it out.
  let layoutScale = pretextCapture?.[1]
  // For `pixelSnap`: the painted line of each Range glyph, by glyph index, and the top of the
  // highest text box of each line.
  const paintLines: number[] = []
  const lineTops: number[] = []
  const sequences = new Map<number, number>()

  const toRect = (b: DOMRect): [number, number, number, number] => [
    (b.left - rootLeft) * invScale,
    (rootBottom - b.bottom) * invScale,
    (b.right - rootLeft) * invScale,
    (rootBottom - b.top) * invScale,
  ]
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!
    // The array index is the glyphs' block reference, so every block gets an
    // entry even when it contributes no text.
    blockLayouts[blockIndex] = EMPTY_BLOCK
    if (isIgnored(block) || displayNone(block)) continue
    const blockStyle = styleOf(block)
    const blockRect = block.getBoundingClientRect()
    if (blockRect.width <= 0 || blockRect.height <= 0) continue
    const overflow = blockStyle.overflow
    const overflowX = blockStyle.overflowX || overflow || 'visible'
    const overflowY = blockStyle.overflowY || overflow || 'visible'
    const insetLeft = inset(blockStyle, 'Left')
    const insetRight = inset(blockStyle, 'Right')
    const rtl = blockStyle.direction === 'rtl'
    const align = physicalAlign(blockStyle.textAlign, rtl)
    const lastValue = blockStyle.textAlignLast
    const lastAlign = physicalAlign(
      lastValue && lastValue !== 'auto' ? lastValue : align === 'justify' ? '' : align,
      rtl,
    )
    const justified = align === 'justify' || lastAlign === 'justify'
    const lineHeightRaw = blockStyle.lineHeight
    const clip = toRect(blockRect)
    const layoutClip = [...clip] as const
    let minLeft = blockRect.left
    let maxRight = blockRect.right
    let minTop = blockRect.top
    let maxBottom = blockRect.bottom
    const includeTextBox = (box: GlyphBox): void => {
      if (box.left < minLeft) minLeft = box.left
      if (box.left + box.width > maxRight) maxRight = box.left + box.width
      if (box.top < minTop) minTop = box.top
      if (box.bottom > maxBottom) maxBottom = box.bottom
    }
    const blockStart = glyphs.length
    const lineCountBefore = lineCount
    let blockLeft = clip[0] + insetLeft * invScale
    let blockWidth = clip[2] - clip[0] - (insetLeft + insetRight) * invScale

    if (appendBrowserRuns) {
      const lineKeys = new Set<string>()
      appendBrowserRuns(block, {
        options,
        style: styleOf,
        inline: (parent) => {
          const record = resolveParent(parent)
          return record.owner === block ? record.inline : null
        },
        signal: options.signal,
        blockIndex,
        rootRect,
        invScale,
        clip,
        glyphs,
        requests,
        lineKeys,
        lineSequences: new Map(),
        ...(svg
          ? {
              svg: (element: Element, sequence: number) => {
                captureShape(element, blockIndex, clip, sequence)
              },
            }
          : {}),
        box: (font, box) => {
          includeTextBox(box)
          if (measuresBaselines) {
            trackLayoutGrid(box.left, box.width)
            if (!boxHeights.has(font)) boxHeights.set(font, box.height)
          }
        },
      })
      lineCount += lineKeys.size
      // A shaped run arrives with the descent Canvas reports at its CSS size, which is the
      // layout's only where a layout pixel is a CSS pixel. Its glyphs join the same pass.
      if (measuresBaselines)
        for (let index = blockStart; index < glyphs.length; index++) {
          const glyph = glyphs[index]!
          const font = glyph.shapeGroup === undefined && requests.get(glyph.glyphKey)?.font
          if (font) textRuns.push([font, index, index + 1])
        }
    } else if (layoutEngine === 'range') {
      range ??= document.createRange()
      sequences.clear()
      const nextSequence = (lineKey: number): number => {
        const seq = sequences.get(lineKey) ?? 0
        sequences.set(lineKey, seq + 1)
        return seq
      }
      const walker = block.firstElementChild
        ? document.createTreeWalker(block, SHOW_TEXT | SHOW_ELEMENT)
        : null
      let markAnchorLineKey = 0
      let hasMarkAnchor = false
      let previousCharacter = ''
      let hasPrevBounds = false
      let prevTop = 0
      let prevBottom = 0
      let prevHeight = 0
      let previousEmoji = false
      let gap = 0
      let forced = false
      let blockSynced = true
      let nodeIndex = 0
      let node: Node | null = walker ? walker.nextNode() : block.firstChild
      for (; node; node = walker ? walker.nextNode() : node.nextSibling) {
        nodeIndex++
        if (node.nodeType !== 3) {
          if (!walker) continue
          const element = node as Element
          const shapeStart = glyphs.length
          if (
            svg &&
            nodeOf(element).owner === block &&
            captureShape(element, blockIndex, clip, (glyphs[glyphs.length - 1]?.sequence ?? -1) + 1)
          ) {
            const last = glyphs[glyphs.length - 1]
            if (last?.shapeGroup !== undefined) {
              const lineKey = hasMarkAnchor
                ? markAnchorLineKey
                : Math.round(element.getBoundingClientRect().top * 4)
              const sequence = nextSequence(lineKey)
              for (
                let i = glyphs.length - 1;
                i >= 0 && glyphs[i]!.shapeGroup === last.shapeGroup;
                i--
              )
                glyphs[i]!.sequence = sequence
              if (gap && justified && shapeStart < glyphs.length)
                glyphs[shapeStart]!.gapBefore = gap
            }
            gap = 0
            afterSpace = true
            hasMarkAnchor = false
            previousCharacter = ''
          }
          forced ||= element.tagName === 'BR' && !displayNone(element)
          if (forced || (options.cjkLineBreaking && !isInlineBox(element))) previousCharacter = ''
          continue
        }
        const textNode = node as Text
        const parent = textNode.parentElement
        if (svg && parent?.closest('svg') && !parent.closest('foreignObject')) continue
        const record = parent ? resolveParent(parent) : null
        if (!record?.inline || record.owner !== block) {
          hasMarkAnchor = false
          previousCharacter = ''
          continue
        }
        const {
          font,
          keys,
          fontSize,
          layoutFont,
          widths,
          letterSpacing,
          wordSpacing,
          space,
          keepsSpaces,
          color,
          z,
          decorations,
          transform,
        } = record.inline
        let utf16Offset = 0
        let textData = textNode.data
        let shown = transform
          ? transformClusters(textData, transform, transformSeed(textNode, transform))
          : undefined
        if (options.reshape) {
          const input = shown ? shown.join('') : textData
          const reshaped = options.reshape(input)
          if (reshapeBoundaries(input) !== reshapeBoundaries(reshaped)) {
            throw new RangeError(
              'collectDomSnapshot: Range reshaping must preserve code point boundaries and whitespace',
            )
          }
          let end = 0
          if (shown) shown = shown.map((share) => reshaped.slice(end, (end += share.length)))
          else textData = reshaped
        }

        const emojiText = isEmojiCandidate(textData)
        const runStart = glyphs.length
        let boxHeight = 0
        let clusterIndex = 0
        let hasKernPrevious = false
        let kernPrevChar = ''
        let kernPrevLeft = 0
        let kernPrevWidth = -1
        let kernPrevCarry = 0
        let hit: CachedWidthRun | undefined
        let canSync = false
        let synced = false
        if (nativeBrowser && !shown && !options.reshape && !options.svg) {
          const runKey = `${nodeIndex}|${blockRect.width}|${textData}|${layoutFont}|${letterSpacing}|${wordSpacing}`
          hit = cachedTextRuns.get(textNode)
          if (hit?.[0] === runKey && sameBox(blockRect, hit[2])) {
            canSync = true
            synced = blockSynced
          } else {
            blockSynced = false
            cachedTextRuns.set(textNode, (hit = [runKey, [], undefined]))
          }
        }
        const rects = hit?.[1]
        let ci = -1
        for (const cluster of glyphClusters(textData)) {
          ci++
          const share = shown ? shown[clusterIndex++]! : cluster
          const nextOffset = utf16Offset + cluster.length

          if (
            share === ' ' ||
            (share.length === 1 && share.charCodeAt(0) >= 9 && /^\s$/u.test(share))
          ) {
            if (share === ' ' || !/[\u2007\u202f\ufeff]/.test(share)) {
              if (!gap || keepsSpaces) gap += space
              if (share !== '\u00a0') afterSpace = true
            }
            hasMarkAnchor = hasKernPrevious = false
            previousCharacter = ''
            utf16Offset = nextOffset
            continue
          }
          if (!share) {
            hasKernPrevious = false
            utf16Offset = nextOffset
            continue
          }
          let r: GlyphBox
          if (rects && synced) {
            r = rects[ci]!
          } else {
            range.setEnd(textNode, nextOffset)
            range.setStart(textNode, utf16Offset)
            const d = range.getBoundingClientRect()
            r = { left: d.left, top: d.top, bottom: d.bottom, width: d.width, height: d.height }
            if (rects) {
              if (canSync && sameBox(r, rects[ci])) synced = true
              else rects[ci] = r
            }
          }
          utf16Offset = nextOffset
          if (measuresBaselines) trackLayoutGrid(r.left, r.width)
          const parts = share === cluster ? undefined : expansionBoxes(share, r, font)
          for (let part = 0, partLen = parts ? parts.length : 1; part < partLen; part++) {
            const box = parts ? parts[part]! : r
            const character = parts ? parts[part]!.c : share
            const { left: bLeft, top: bTop, bottom: bBottom, width: bWidth, height: bHeight } = box
            if (bWidth <= 0 || bHeight <= 0) {
              const previous = glyphs[glyphs.length - 1]
              hasKernPrevious = false
              if (!hasMarkAnchor || !previous || !/^\p{M}/u.test(character)) continue
              const key = requestKey(font, keys, character)
              const sequence = nextSequence(markAnchorLineKey)
              if (options.pixelSnap) paintLines[glyphs.length] = paintLines[glyphs.length - 1]!
              glyphs.push({
                glyphKey: key,
                fontSize,
                originX: previous.originX + previous.advance,
                lineBottom: previous.lineBottom,
                advance: 0,
                ...(options.rtlReflow ? { decorationWidth: 0 } : {}),
                block: blockIndex,
                breakBefore: 'none',
                clip,
                color,
                sequence,
                z,
              })
              continue
            }

            includeTextBox(box)

            const key = requestKey(font, keys, character)
            const previous = glyphs[glyphs.length - 1]
            const sameBlock = previous?.block === blockIndex
            const emoji = emojiText && isEmojiCandidate(character)
            const sharesLine =
              sameBlock &&
              hasPrevBounds &&
              Math.min(bBottom, prevBottom) - Math.max(bTop, prevTop) >
                Math.min(bHeight, prevHeight) * 0.5
            const sameEmojiLine = sharesLine && (emoji || previousEmoji)
            const lineKey = sameEmojiLine ? markAnchorLineKey : Math.round(bTop * 4)
            const sequence = nextSequence(lineKey)

            const lineBottom = sameEmojiLine
              ? previous.lineBottom
              : (rootBottom - bBottom) * invScale
            const lineChanged = sameBlock && previous.lineBottom !== lineBottom
            let kernShift = 0
            let kernCarry = 0
            let charWidth = -1
            if (hasKernPrevious && measuresKerning && !parts && !emoji && !lineChanged) {
              const firstWidth =
                kernPrevWidth >= 0 ? kernPrevWidth : canvasWidth(layoutFont, widths, kernPrevChar)
              const shown = bLeft - kernPrevLeft - letterSpacing - firstWidth - kernPrevCarry
              if (Math.abs(shown) > (nativeBrowser ? 0.02 : 0.0025)) {
                charWidth = canvasWidth(layoutFont, widths, character)
                const pair =
                  canvasWidth(layoutFont, widths, kernPrevChar + character) - firstWidth - charWidth
                if (
                  Math.abs(pair) > 0.01 &&
                  Math.abs(shown - pair / 2) <= Math.min(0.25, Math.abs(pair) / 4)
                ) {
                  kernCarry = pair - shown
                  kernShift = kernCarry
                }
              }
            }
            const originX = (bLeft - rootLeft + kernShift) * invScale
            boxHeight ||= bHeight
            if (options.pixelSnap) {
              if (sharesLine) lineTops[lineTops.length - 1] = Math.min(lineTops.at(-1)!, bTop)
              else lineTops.push(bTop)
              paintLines[glyphs.length] = lineTops.length - 1
            }
            hasPrevBounds = true
            prevTop = bTop
            prevBottom = bBottom
            prevHeight = bHeight
            previousEmoji = emoji
            const isCjkSoft =
              options.cjkLineBreaking === true && canBreakCjk(previousCharacter, character)
            if (sameBlock && !lineChanged && previous.shapeGroup === undefined) {
              if (gap || afterSpace || isCjkSoft) previous.decorationWidth ??= previous.advance
              previous.advance = originX - previous.originX
            }
            const soft = !sameBlock || isCjkSoft || (afterSpace && !(forced && lineChanged))
            const lone =
              measuresKerning && !parts && !emoji
                ? (charWidth >= 0
                    ? charWidth
                    : (charWidth = canvasWidth(layoutFont, widths, character))) + letterSpacing
                : bWidth
            const glyph: MutableGlyph = {
              glyphKey: key,
              fontSize,
              originX,
              lineBottom,
              advance: (Math.abs(lone - bWidth) < 0.04 ? lone : bWidth) * invScale,
              block: blockIndex,
              breakBefore: soft ? 'soft' : lineChanged ? 'hard' : 'none',
              clip,
              color,
              sequence,
              z,
            }
            if (isCjkSoft) glyph.gapBefore = 0
            else if (
              gap &&
              (justified
                ? soft || !lineChanged
                : soft && lineChanged && previous.shapeGroup === undefined)
            )
              glyph.gapBefore = gap
            if (decorations.length || options.rtlReflow) {
              glyph.decorations = decorations
              glyph.decorationWidth = glyph.advance
            }
            glyphs.push(glyph)
            gap = 0
            forced = false
            if (parts || emoji) {
              hasKernPrevious = false
            } else {
              hasKernPrevious = true
              kernPrevChar = character
              kernPrevLeft = bLeft
              kernPrevWidth = charWidth
              kernPrevCarry = kernCarry
            }
            afterSpace = false
            if (options.cjkLineBreaking) previousCharacter = character
            markAnchorLineKey = lineKey
            hasMarkAnchor = true
          }
        }
        if (hit) hit[2] = blockRect
        if (measuresBaselines && boxHeight > 0) {
          textRuns.push([font, runStart, glyphs.length])
          if (!boxHeights.has(font)) boxHeights.set(font, boxHeight)
        }
      }
      lineCount += sequences.size
    } else {
      const [lines, left, width] = pretextCapture![2](
        block,
        blockIndex,
        blockStyle,
        blockRect,
        clip,
        includeTextBox,
        align,
        lastAlign,
      )
      lineCount += lines
      blockLeft = left
      blockWidth = width
    }
    if (overflowX === 'visible') {
      clip[0] = (minLeft - rootLeft) * invScale
      clip[2] = (maxRight - rootLeft) * invScale
    }
    if (overflowY === 'visible') {
      clip[1] = (rootBottom - maxBottom) * invScale
      clip[3] = (rootBottom - minTop) * invScale
    }
    afterSpace = true
    if (svg) {
      for (let index = blockStart; index < glyphs.length; index++) {
        if (glyphs[index]!.shapeGroup !== undefined) {
          lineCount = lineCountBefore + svg.normalizeSvgLines(glyphs, blockStart, shapeBoxes)
          break
        }
      }
    }

    // Line pitch comes straight from the captured baselines, so re-wrapping needs
    // no half-leading model: line n simply sits n pitches below the first.
    // `lineBottom` grows upward, so the first line holds the largest value.
    if (glyphs.length > blockStart) {
      let first = -Infinity
      let second = -Infinity
      for (let index = blockStart; index < glyphs.length; index++) {
        const value = glyphs[index]!.lineBottom
        if (value > first) {
          if (first - value < -1e-4) second = first
          first = value
        } else if (value < first - 1e-4 && value > second) second = value
      }
      const firstSize = glyphs[blockStart]!.fontSize * pixelsPerUnit
      const cssPitch = parsePx(lineHeightRaw, firstSize * 1.2, firstSize) * invScale
      const rtlReflow = !!options.rtlReflow && rtl
      const natural = rtlReflow ? 'right' : 'left'
      blockLayouts[blockIndex] = {
        left: blockLeft,
        firstBaseline: first,
        linePitch: second > -Infinity ? first - second : cssPitch,
        width: blockWidth,
        clip: layoutClip,
        ...(options.rtlReflow
          ? { direction: rtlReflow ? ('rtl' as const) : ('ltr' as const) }
          : {}),
        ...(lastAlign !== (align === 'justify' ? natural : align)
          ? { textAlign: align, textAlignLast: lastAlign }
          : align !== natural
            ? { textAlign: align }
            : {}),
      }
    }
  }
  if (textRuns.length > 0) {
    const scales = layoutScales()
    if (scales.length > 0 && (fontProbe ??= document.createElement('canvas').getContext('2d'))) {
      const [descents, scale] = layoutDescents(
        fontProbe,
        boxHeights,
        scales,
        bakeSize,
        metricsByFont,
      )
      layoutScale = scale
      for (const [font, from, to] of textRuns) {
        const descent = descents.get(font)
        if (descent !== undefined)
          for (let index = from; index < to; index++)
            glyphs[index]!.baselineOffset = descent * invScale
      }
    }
  }
  // `pixelSnap`: every text glyph moves from its layout position to the one the browser paints
  // it at. A text box is a whole number of layout pixels tall, so rounding its captured bottom
  // rounds its top; the pass reads nothing from the DOM. A Range line is rounded as the
  // browser rounds it, where its highest box starts, and each of its boxes where that puts
  // it. The tiles of a shaped run are slices of one drawing and keep their captured x, as SVG
  // shapes keep their boxes.
  let snapGrid: readonly [number, number] | undefined
  if (options.pixelSnap) {
    const rowScale = layoutScale ?? deviceScale
    snapGrid = [4 * deviceScale * pixelsPerUnit, rowScale * pixelsPerUnit]
    for (let index = 0; index < glyphs.length; index++) {
      const glyph = glyphs[index]!
      if (glyph.shapeGroup !== undefined) continue
      const line = paintLines[index]
      const top = line === undefined ? 0 : lineTops[line]! * rowScale
      snapGlyph(
        glyph,
        shaping ? 0 : rootLeft * 4 * deviceScale + glyph.originX * snapGrid[0],
        rootBottom * rowScale - glyph.lineBottom * snapGrid[1],
        snapGrid,
        top - Math.floor(top + 0.5 + 1e-6),
      )
    }
  }
  const rectElements = [
    ...(root.matches(rectSelector) || options.includeRootBackground !== false ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(rectSelector),
  ]

  for (const element of rectElements) {
    if (isIgnored(element) || displayNone(element)) continue
    const style = styleOf(element)
    if (isHidden(style)) continue
    const color = cssColorToSrgba(document, style.backgroundColor, opacityOf(element))
    if (color[3] <= 0) continue
    const bounds = element === root ? rootRect : element.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) continue
    const zDefault = element === root ? (options.panelDepth ?? -1) : (options.rectDepth ?? 0)
    const rawRad = style.borderTopLeftRadius.split(/[\s/]/, 1)[0] ?? ''
    rects.push({
      rect: toRect(bounds),
      color,
      radius:
        Math.max(
          0,
          parsePx(
            rawRad,
            0,
            rawRad.endsWith('%')
              ? Math.min(bounds.width, bounds.height)
              : parsePx(style.fontSize, 16),
          ),
        ) * invScale,
      z: depthOf(element, zDefault),
      receiveShadow:
        element.hasAttribute('data-text-receive-shadow') ||
        element.hasAttribute('data-sdf-receive-shadow'),
    })
  }

  if (svgContext) {
    for (const element of root.querySelectorAll(
      `${svgOptions!.selector ?? 'svg'}${svgOptions!.images ? ',img' : ''}`,
    )) {
      if (capturedSvgs.has(element) || element.closest(textSelector)) continue
      const start = glyphs.length
      const clip: readonly [number, number, number, number] = [
        0,
        0,
        rootRect.width * invScale,
        rootRect.height * invScale,
      ]
      captureShape(element, blockLayouts.length, clip, 0)
      if (glyphs.length > start) {
        const first = glyphs[start]!
        blockLayouts.push({
          left: first.originX,
          firstBaseline: first.lineBottom,
          linePitch: 0,
          width: first.advance,
          clip,
        })
      }
    }
  }

  // Reserve slots for characters the DOM may show later. They produce atlas
  // entries but no instances, so nothing is drawn until the text actually uses them.
  for (const character of glyphClusters(options.extraGlyphs ?? '')) {
    if (/^\s$/u.test(character)) continue
    const emoji = isEmojiCandidate(character)
    for (const [font, keys] of fontEntries.values()) {
      if (!emoji && /\bemoji\b/i.test(font.family)) continue
      requestKey(font, keys, character)
    }
  }

  if (svg) svg.normalizeSvgMotion(glyphs)
  const requestList = [...requests.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  )
  const atlasSignature = requestList.map((request) => request.key).join('\u0001')

  return {
    ...(shaping ? { textShaping: 'browser' as const } : {}),
    width: rootRect.width * invScale,
    height: rootRect.height * invScale,
    glyphs,
    rects,
    blocks: blockLayouts,
    requests: requestList,
    atlasSignature,
    lineCount,
    ...(snapGrid ? { snapGrid } : {}),
  }
}
