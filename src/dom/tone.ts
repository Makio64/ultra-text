import type { DomLayoutSnapshot, TextToneModel, TextToneOptions } from '../types.js'

/** A tone with every default applied; see `TextToneOptions`. */
export interface ResolvedTextTone {
  /** `0` keeps the exact coverage of the model's outline, `1` is the browser's full conversion. */
  readonly strength: number
  /** sRGB-encoded lightness of the colour the text is read against, `0` to `1`. */
  readonly backdrop: number
  /**
   * Whether the rasterizer re-weights its mask by ink class: `1` for macOS and Windows over a
   * known backdrop. The table lifts light ink for the darker backdrop a browser then thins it
   * against, so over a backdrop nobody knows it is `0` and light ink keeps its exact coverage.
   */
  readonly table: 0 | 1
  /** Outline dilation in ems, in device pixels at most `dilationPx`; zero outside macOS. */
  readonly dilationEm: number
  readonly dilationPx: number
  /** Device pixels per em from which the dilation and the table stop; `0` when unused. */
  readonly bigPx: number
  /**
   * Whether the backdrop is certain to be drawn in the frame behind the text: the options
   * named it, or the capture draws an opaque rectangle there. Otherwise the conversion only
   * applies in a render whose frame has a backdrop of its own; see `TextTone.frame`.
   */
  readonly framed?: boolean
}

/** What a caller knows about the page when the options say `'auto'`. */
export interface TextToneContext {
  readonly model?: Exclude<TextToneModel, 'auto'> | undefined
  /** sRGB-encoded lightness of what the text is drawn over; absent while nobody knows it. */
  readonly backdrop?: number | undefined
  /** True where the caller's own opaque rectangles lie behind the text. */
  readonly framed?: boolean | undefined
}

/** What a capture knows about the backgrounds it will draw behind its own text. */
export interface TextToneCapture extends Pick<DomLayoutSnapshot, 'glyphs' | 'rects'> {
  /** Whether `rects` holds the root's own background, so the page must not add it again. */
  readonly rootRect: boolean
  /**
   * False for a root that only exists to be captured, as the hidden source of a `Text`: the
   * page behind it is not what the text is drawn over, so it is not read, and only an opaque
   * rectangle of the capture makes the backdrop known. Defaults to true.
   */
  readonly page?: boolean
}

type Rgb = readonly [red: number, green: number, blue: number]
type Rgba = readonly [red: number, green: number, blue: number, alpha: number]

// P(x) = x(x(C3 x + C2) + C1) approximates the sRGB decode on [0, 1], and P(1) = 1.
export const C1 = 0.012522878
export const C2 = 0.682171111
export const C3 = 0.305306011
export const LUMINANCE = [0.2126, 0.7152, 0.0722] as const

const NAMED_COLORS: Readonly<Record<string, number>> = {
  black: 0x000000,
  white: 0xffffff,
  red: 0xff0000,
  green: 0x008000,
  blue: 0x0000ff,
  gray: 0x808080,
  grey: 0x808080,
  silver: 0xc0c0c0,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  aqua: 0x00ffff,
  magenta: 0xff00ff,
  fuchsia: 0xff00ff,
  orange: 0xffa500,
  purple: 0x800080,
  rebeccapurple: 0x663399,
  navy: 0x000080,
  teal: 0x008080,
  maroon: 0x800000,
  olive: 0x808000,
  lime: 0x00ff00,
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4)
}

/** The exact sRGB transfer function, linear to encoded; written so that white encodes to 1. */
export function srgbEncode(linear: number): number {
  const value = Math.min(1, Math.max(0, linear))
  return value <= 0.0031308 ? value * 12.92 : 1 + 1.055 * (value ** (1 / 2.4) - 1)
}

const lightnessRgb = (red: number, green: number, blue: number): number =>
  srgbEncode(
    LUMINANCE[0] * srgbToLinear(red) +
      LUMINANCE[1] * srgbToLinear(green) +
      LUMINANCE[2] * srgbToLinear(blue),
  )
const lightnessOf = (color: Rgb): number => lightnessRgb(color[0], color[1], color[2])
const lightnessHex = (hex: number): number => {
  const n = Math.floor(hex)
  return lightnessRgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const hueToRgb = (p: number, q: number, t: number): number => {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
  return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (4 - 6 * u) : p
}

const splitFn = (re: RegExp, s: string) =>
  re
    .exec(s)?.[1]
    ?.split(/[\s,/]+/)
    .filter(Boolean)

/** Encoded lightness of a colour's linear luminance: what the tone compares ink and backdrop by. */
export function toneLightness(
  color: string | number | { readonly r: number; readonly g: number; readonly b: number },
): number {
  if (typeof color === 'number') return lightnessHex(color)
  if (typeof color === 'object') {
    const { r, g, b } = color
    return srgbEncode(LUMINANCE[0] * r + LUMINANCE[1] * g + LUMINANCE[2] * b)
  }
  const s = color.trim().toLowerCase()
  const named = NAMED_COLORS[s]
  if (named !== undefined) return lightnessHex(named)
  if (s.startsWith('#')) {
    const n = s.length - 1
    const w = n === 3 || n === 4 ? 1 : n === 6 || n === 8 ? 2 : 0
    if (w) {
      const ch = (i: number): number =>
        parseInt(s.slice(1 + i * w, 1 + i * w + w).repeat(3 - w), 16) / 255
      return lightnessRgb(ch(0), ch(1), ch(2))
    }
  }
  const rgbMatch = splitFn(/^rgba?\(([^)]+)\)$/i, s)
  if (rgbMatch) {
    const ch = (i: number): number => {
      const c = rgbMatch[i]
      return c === undefined
        ? 0
        : Math.min(1, Math.max(0, parseFloat(c) / (c.endsWith('%') ? 100 : 255)))
    }
    return lightnessRgb(ch(0), ch(1), ch(2))
  }
  const hslMatch = splitFn(/^hsla?\(([^)]+)\)$/i, s)
  if (hslMatch) {
    const h = (((parseFloat(hslMatch[0] ?? '0') % 360) + 360) % 360) / 360
    const sat = Math.min(1, Math.max(0, parseFloat(hslMatch[1] ?? '0') / 100))
    const l = Math.min(1, Math.max(0, parseFloat(hslMatch[2] ?? '0') / 100))
    if (sat === 0) return lightnessRgb(l, l, l)
    const q = l <= 0.5 ? l * (1 + sat) : l + sat - l * sat
    const p = 2 * l - q
    return lightnessRgb(hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3))
  }
  return 0
}

/**
 * Applies the defaults. `false` means no conversion at all; an already resolved tone passes
 * through. `'auto'` takes what the context knows about the page: without a model the exact
 * outline, and without a backdrop white with the ink table off, whatever the model. Dark ink
 * then gains the weight it has on a white page, and light ink is neither thinned nor lifted.
 * A backdrop is known when the options name a colour or the context read one. From
 * JavaScript, `true` is the default tone and any other value that is not an object throws.
 */
export function resolveTextTone(
  options: TextToneOptions | ResolvedTextTone | false | undefined,
  context?: TextToneContext,
): ResolvedTextTone | null {
  if (options === false) return null
  if ((options as unknown) === true) options = undefined
  else if (options != null && typeof options !== 'object')
    throw new TypeError('ultra-text: tone must be an options object or false')
  if (options && 'table' in options) return options
  const requested = options?.model ?? 'auto'
  const model = requested === 'auto' ? (context?.model ?? 'outline') : requested
  const requestedBackdrop = options?.backdrop ?? 'auto'
  const backdrop =
    requestedBackdrop === 'auto' ? context?.backdrop : toneLightness(requestedBackdrop)
  const strength = options?.strength ?? 1
  const macos = model === 'macos'
  return {
    // A strength that is not a number keeps the default.
    strength: Math.min(
      1,
      Math.max(0, typeof strength !== 'number' || Number.isNaN(strength) ? 1 : strength),
    ),
    backdrop: backdrop ?? 1,
    table: model === 'outline' || backdrop === undefined ? 0 : 1,
    dilationEm: macos ? 0.0058 : 0,
    dilationPx: macos ? 0.3 : 0,
    bigPx: macos ? 256 : 0,
    framed: requestedBackdrop !== 'auto' || context?.framed === true,
  }
}

/** P'(b) and P''(b) / 2: the polynomial of the conversion around a backdrop of lightness b. */
export function backdropCurve(backdrop: number): [k0: number, k1: number] {
  const k1 = C2 + 3 * C3 * backdrop
  return [C1 + backdrop * (C2 + k1), k1]
}

/**
 * The same conversion on plain numbers, for CPU callers and tests. `ink` is the encoded
 * lightness of the text colour, `coverage` the exact pixel coverage and `opacity` the ink's
 * own alpha; the result is the alpha the pixel is blended with.
 */
export function toneCoverage(
  tone: ResolvedTextTone,
  ink: number,
  coverage: number,
  opacity = 1,
): number {
  const { strength, backdrop } = tone
  const [k0, k1] = backdropCurve(backdrop)
  const delta = ink - backdrop
  const table = (strength * tone.table * Math.min(Math.floor(4 * ink), 3)) / 3
  const mask = coverage + table * coverage * (1 - coverage)
  const y = delta * mask * opacity
  return Math.min(
    1,
    opacity *
      mask *
      (1 - strength + (strength / (k0 + delta * (k1 + C3 * delta))) * (k0 + y * (k1 + C3 * y))),
  )
}

/** Source-over on sRGB-encoded values, which is how a browser composites. */
function over(below: Rgb, [red, green, blue, alpha]: Rgba): Rgb {
  const opacity = Math.min(1, alpha)
  return [
    below[0] + (red - below[0]) * opacity,
    below[1] + (green - below[1]) * opacity,
    below[2] + (blue - below[2]) * opacity,
  ]
}

/**
 * sRGB-encoded channels per colour string, null where the string could not be read. Any
 * syntax other than `rgb()` costs a canvas readback, so each string is resolved once.
 */
const parsedColors = new Map<string, Rgba | null>()
let colorProbe: CanvasRenderingContext2D | null | undefined

function parseColor(document: Document, value: string): Rgba | null {
  if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return null
  let rgba = parsedColors.get(value)
  if (rgba !== undefined) return rgba
  const channels = splitFn(/^rgba?\(([^)]+)\)$/i, value)
  if (channels) {
    const read = (index: number, max: number): number => {
      const channel = channels[index]
      return channel === undefined ? 1 : parseFloat(channel) / (channel.endsWith('%') ? 100 : max)
    }
    rgba = [read(0, 255), read(1, 255), read(2, 255), read(3, 1)]
  } else {
    rgba = null
    try {
      if (colorProbe === undefined) {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        colorProbe = canvas.getContext('2d', { willReadFrequently: true }) ?? null
      }
      if (colorProbe) {
        colorProbe.fillStyle = '#0000'
        colorProbe.fillStyle = value
        colorProbe.clearRect(0, 0, 1, 1)
        colorProbe.fillRect(0, 0, 1, 1)
        const pixel = colorProbe.getImageData(0, 0, 1, 1).data
        rgba = [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255, pixel[3]! / 255]
      }
    } catch {
      colorProbe = null
    }
  }
  if (parsedColors.size >= 256) parsedColors.clear()
  parsedColors.set(value, rgba)
  return rgba
}

const prop = (s: CSSStyleDeclaration, k: string): string => s.getPropertyValue(k).trim()

function domBackdrop(root: Element, above: boolean): readonly [Rgb, boolean] | null {
  const layers: Rgba[] = []
  let known = false
  let image = false
  try {
    const document = root.ownerDocument
    const view = document.defaultView
    if (!view) return null
    const parent = (element: Element): Element | null =>
      element.assignedSlot ??
      element.parentElement ??
      (element.getRootNode() as Partial<ShadowRoot>).host ??
      null
    for (let element: Element | null = root; element; element = parent(element)) {
      const style = view.getComputedStyle(element)
      if (
        prop(style, 'display') === 'contents' ||
        (element !== document.documentElement &&
          element !== document.body &&
          (/hidden|collapse/.test(prop(style, 'visibility')) ||
            (prop(style, 'background-clip') + prop(style, '-webkit-background-clip')).includes(
              'text',
            )))
      )
        continue
      image ||= !/^(none)?$/.test(prop(style, 'background-image'))
      if (above && element === root) continue
      const layer = parseColor(document, style.backgroundColor)
      if (!layer || !(layer[3] > 0)) continue
      layers.push(layer)
      if (layer[3] >= 1) {
        known = !image
        break
      }
    }
  } catch {
    return null
  }
  return [layers.reduceRight<Rgb>(over, [1, 1, 1]), known]
}

function captureBackdrop(
  base: Rgb | null,
  { glyphs, rects }: TextToneCapture,
): readonly [number | undefined, boolean, boolean] {
  const samples = Math.min(glyphs.length, 512)
  const painted = rects.length > 1 ? [...rects].sort((first, second) => first.z - second.z) : rects
  const stacks = new Map<string, [number | undefined, boolean, number, number]>()
  let half = 0
  for (let sample = 0; sample < samples; sample++) {
    const glyph = glyphs[Math.floor((sample * glyphs.length) / samples)]!
    if (!rects.length || glyph.shapeGroup !== undefined) continue
    const x = glyph.originX + glyph.advance / 2
    const y = glyph.lineBottom + glyph.fontSize / 2
    let key = ''
    for (let order = 0; order < painted.length; order++) {
      const { rect, z } = painted[order]!
      if (z > glyph.z || x < rect[0] || x > rect[2] || y < rect[1] || y > rect[3]) continue
      key += `${order},`
    }
    let stack = stacks.get(key)
    if (!stack) {
      let color = base
      let framed = false
      for (const { rect, color: paint, z } of painted) {
        if (z > glyph.z || x < rect[0] || x > rect[2] || y < rect[1] || y > rect[3]) continue
        if (paint[3] >= 1) framed = true
        color = paint[3] >= 1 ? [paint[0], paint[1], paint[2]] : color && over(color, paint)
      }
      stacks.set(key, (stack = [color ? lightnessOf(color) : undefined, framed, 0, 0]))
    }
    stack[2] += glyph.fontSize
    half += glyph.fontSize / 2
    stack[3] +=
      glyph.fontSize * Math.min(Math.floor(4 * lightnessOf(glyph.color as unknown as Rgb)), 3)
  }
  for (const stack of [...stacks.values()].sort((a, b) => (a[0] ?? 1) - (b[0] ?? 1)))
    if ((half -= stack[2]) <= 0) {
      let lift = 0
      let here = 0
      for (const other of stacks.values()) {
        lift += other[3]
        if (Math.abs((other[0] ?? 1) - (stack[0] ?? 1)) <= 0.25) here += other[3]
      }
      return [stack[0], stack[1], here * 2 >= lift]
    }
  return [base ? lightnessOf(base) : undefined, false, true]
}

function domModel(root: Element): Exclude<TextToneModel, 'auto'> {
  try {
    const view = root.ownerDocument.defaultView
    if (!view) return 'outline'
    const navigator = view.navigator as {
      readonly platform?: string
      readonly maxTouchPoints?: number
      readonly userAgentData?: { readonly platform?: string }
    }
    const brand = navigator.userAgentData?.platform
    const platform = navigator.platform ?? ''
    if (platform ? platform.startsWith('Win') : brand === 'Windows') return 'windows'
    if (
      platform
        ? !(
            platform.startsWith('Mac') &&
            (brand === 'macOS' || (navigator.maxTouchPoints ?? 0) <= 1)
          )
        : brand !== 'macOS'
    )
      return 'outline'
    const style = view.getComputedStyle(root)
    return /^(antialiased|none)$/i.test(prop(style, '-webkit-font-smoothing')) ||
      /^grayscale$/i.test(prop(style, '-moz-osx-font-smoothing')) ||
      /^geometricprecision$/i.test(prop(style, 'text-rendering'))
      ? 'outline'
      : 'macos'
  } catch {
    return 'outline'
  }
}

/**
 * Resolves a `tone` option against the page that holds `root`: `'auto'` values come from the
 * platform, the root's computed CSS and the backgrounds behind the text, which are the
 * rectangles of `capture` over the page, or the page alone without one. A backdrop that
 * cannot be read stays unknown, which `resolveTextTone` shows as white with the ink table
 * off: a page without computed styles, one whose backgrounds hold no opaque colour or put an
 * image in front of it, or a capture that is not drawn over its page and has no opaque
 * rectangle behind its text. The exact outline has no table, so it takes the colour the page
 * most likely shows. Reads computed styles, so it belongs to a capture, never to the render
 * loop; an explicit model and backdrop read nothing, and `false` resolves to null.
 */
export function resolveDomTextTone(
  root: Element,
  option: TextToneOptions | false | undefined,
  capture?: TextToneCapture,
): ResolvedTextTone | null {
  if (option === false) return null
  const auto = (value: unknown): boolean => (value ?? 'auto') === 'auto'
  const model = auto(option?.model) ? domModel(root) : undefined
  let backdrop: number | undefined
  let framed = false
  let table = true
  if (auto(option?.backdrop)) {
    const read = capture?.page === false ? null : domBackdrop(root, !!capture?.rootRect)
    const page = read && (read[1] || (model ?? option?.model) === 'outline') ? read[0] : null
    if (capture) [backdrop, framed, table] = captureBackdrop(page, capture)
    else backdrop = page ? lightnessOf(page) : undefined
  }
  const tone = resolveTextTone(option, { model, backdrop, framed })
  return tone && !table ? { ...tone, table: 0 } : tone
}
