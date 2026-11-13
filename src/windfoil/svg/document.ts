/* SVG CSSOM uses an empty string for missing values, which must fall through. */
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import type {
  SvgToWindfoilOptions,
  WindfoilAffine,
  WindfoilSvgPath,
  WindfoilSvgWarningCode,
} from '../../types.js'
import { identity, invert, multiply } from './curves.js'
import { viewportTransform } from './viewport.js'
export type Warn = (code: WindfoilSvgWarningCode, message: string, source?: string) => void
export interface SvgViewport {
  readonly inverse: WindfoilAffine
  readonly width: number
  readonly height: number
}
export interface PathRecord extends WindfoilSvgPath {
  readonly source: string
  readonly alpha?: number
  readonly element?: Element
  readonly viewport?: readonly [number, number]
  readonly viewports?: readonly SvgViewport[]
}
export function parseTransform(text: string): WindfoilAffine {
  let result = identity,
    position = 0
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  for (const match of text.matchAll(pattern)) {
    if (text.slice(position, match.index).trim().replaceAll(',', ''))
      throw new TypeError('Invalid SVG transform')
    const numbers = match[2]!
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
      name = match[1]!
    if (!numbers.every(Number.isFinite)) throw new TypeError('Invalid SVG transform parameters')
    const a = numbers[0]!,
      b = numbers[1] ?? 0,
      c = numbers[2] ?? 0,
      angle = (a * Math.PI) / 180
    let matrix: WindfoilAffine
    if (name === 'matrix' && numbers.length === 6) matrix = numbers as unknown as WindfoilAffine
    else if (name === 'translate' && numbers.length >= 1 && numbers.length <= 2)
      matrix = [1, 0, 0, 1, a, b]
    else if (name === 'scale' && numbers.length >= 1 && numbers.length <= 2)
      matrix = [a, 0, 0, numbers[1] ?? a, 0, 0]
    else if (name === 'rotate' && (numbers.length === 1 || numbers.length === 3)) {
      const co = Math.cos(angle),
        si = Math.sin(angle)
      matrix = [co, si, -si, co, b - co * b + si * c, c - si * b - co * c]
    } else if (name === 'skewX' && numbers.length === 1) matrix = [1, 0, Math.tan(angle), 1, 0, 0]
    else if (name === 'skewY' && numbers.length === 1) matrix = [1, Math.tan(angle), 0, 1, 0, 0]
    else throw new TypeError(`Unsupported SVG transform ${name}`)
    result = multiply(result, matrix)
    position = match.index + match[0].length
  }
  if (text.slice(position).trim()) throw new TypeError('Invalid SVG transform')
  return result
}
export function readViewBox(root: Element): readonly [number, number, number, number] | undefined {
  const value = root.getAttribute('viewBox')
  if (value) {
    const v = value
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (v.length !== 4 || !v.every(Number.isFinite)) throw new TypeError('Invalid SVG viewBox')
    return v as unknown as readonly [number, number, number, number]
  }
  const width = Number((root.getAttribute('width') ?? '').replace(/px$/, '')),
    height = Number((root.getAttribute('height') ?? '').replace(/px$/, ''))
  return width && height ? [0, 0, width, height] : undefined
}
export { viewportTransform } from './viewport.js'
type Styles = Record<string, string>
const inherited = [
  'fill',
  'fill-rule',
  'fill-opacity',
  'visibility',
  'stroke',
  'stroke-width',
  'color',
]
const allStyleKeys = [...inherited, 'display', 'opacity', 'clip-path', 'mask', 'filter'] as const
const ignoredProperties = [
  ['clip-path', 'clip-path-ignored'],
  ['mask', 'mask-ignored'],
  ['filter', 'filter-ignored'],
] as const
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'switch', 'symbol'])
const SKIPPED_TAGS = new Set([
  'defs',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
  'pattern',
  'marker',
  'title',
  'desc',
  'metadata',
])
export function inlineValue(element: Element, name: string): string | undefined {
  const rawStyle = element.getAttribute('style')
  if (rawStyle) {
    const entries = rawStyle.split(';')
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!
      const colon = entry.indexOf(':')
      if (colon >= 0 && entry.slice(0, colon).trim() === name) {
        return entry.slice(colon + 1).trim()
      }
    }
  }
  return element.getAttribute(name) ?? undefined
}
export function walkSvg(
  root: Element,
  options: SvgToWindfoilOptions,
  warn: Warn,
): { paths: PathRecord[]; viewBox?: readonly [number, number, number, number]; aspect: string } {
  const paths: PathRecord[] = [],
    viewBox = readViewBox(root),
    aspect =
      options.preserveAspectRatio ?? root.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet'
  const screen = root as SVGGraphicsElement,
    live =
      options.computedStyle !== false &&
      root.isConnected &&
      typeof screen.getScreenCTM === 'function' &&
      typeof getComputedStyle === 'function'
  const fromMatrix = (m: DOMMatrix): WindfoilAffine => [m.a, m.b, m.c, m.d, m.e, m.f]
  const rootMatrix = live ? screen.getScreenCTM() : null,
    rootInverse = rootMatrix ? invert(fromMatrix(rootMatrix)) : null
  let count = 0,
    characters = 0,
    stopped = false,
    index = 0
  const length = (value: string | null | undefined, base: number, fallback = 0): number => {
    if (value == null || value === '') return fallback
    if (value === 'auto') return NaN
    if (!/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:px|%)?$/i.test(value.trim()))
      throw new TypeError(`Unsupported SVG length ${value}`)
    return value.endsWith('%') ? (parseFloat(value) * base) / 100 : parseFloat(value)
  }
  const visit = (
    element: Element,
    parentMatrix: WindfoilAffine,
    parentStyle: Styles,
    opacity: number,
    viewport: readonly [number, number],
    stack: readonly Element[],
    referenced = false,
    viewports: readonly SvgViewport[] = [],
    useTarget = false,
  ): void => {
    if (stopped) return
    const tag = element.localName,
      source = tag + (element.id ? `#${element.id}` : `[${index++}]`)
    if (tag === 'symbol' && !useTarget) return
    const style: Styles = {
      fill: parentStyle['fill'] ?? '',
      'fill-rule': parentStyle['fill-rule'] ?? '',
      'fill-opacity': parentStyle['fill-opacity'] ?? '',
      visibility: parentStyle['visibility'] ?? '',
      stroke: parentStyle['stroke'] ?? '',
      'stroke-width': parentStyle['stroke-width'] ?? '',
      color: parentStyle['color'] ?? '',
      display: '',
      opacity: '',
      'clip-path': '',
      mask: '',
      filter: '',
    }
    const computed = live && !referenced ? getComputedStyle(element) : null
    if (computed) {
      for (const key of allStyleKeys) {
        style[key] = computed.getPropertyValue(key) || inlineValue(element, key) || style[key] || ''
      }
    } else {
      let rawStyle = ''
      for (const attr of element.attributes) {
        if (attr.name === 'style') rawStyle = attr.value
        else if (attr.name in style && attr.value) style[attr.name] = attr.value
      }
      if (rawStyle) {
        const inlineMap: Styles = {}
        const entries = rawStyle.split(';')
        for (const entry of entries) {
          const colon = entry.indexOf(':')
          if (colon >= 0) {
            inlineMap[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim()
          }
        }
        for (const key of allStyleKeys) {
          if (key in inlineMap) {
            style[key] = inlineMap[key] || parentStyle[key] || ''
          }
        }
      }
    }
    if (style['display'] === 'none') return
    const alpha = opacity * (style['opacity'] === '' ? 1 : Number(style['opacity']))
    if (alpha === 0) return
    if (tag === 'style') {
      if (!live) warn('stylesheet-ignored', 'Detached SVG style sheets are ignored', source)
      return
    }
    for (const [property, code] of ignoredProperties) {
      if (style[property] && style[property] !== 'none')
        warn(code, `SVG ${property} is ignored`, source)
    }
    let matrix: WindfoilAffine
    const rawTransform = element.getAttribute('transform')
    if (rawTransform) {
      try {
        matrix = multiply(parentMatrix, parseTransform(rawTransform))
      } catch {
        warn('degenerate-transform', 'Invalid SVG transform', source)
        return
      }
    } else {
      matrix = parentMatrix
    }
    if (live && !referenced && rootInverse && element !== root) {
      const ctm = (element as unknown as { getScreenCTM?: () => DOMMatrix | null }).getScreenCTM?.()
      if (ctm) matrix = multiply(rootInverse, fromMatrix(ctm))
    }
    if (matrix !== identity && !invert(matrix)) {
      warn('degenerate-transform', 'Singular SVG transform', source)
      return
    }
    let localViewport = viewport,
      localViewports = viewports
    try {
      if ((tag === 'svg' && element !== root) || tag === 'symbol') {
        const width = length(element.getAttribute('width'), viewport[0], viewport[0]),
          height = length(element.getAttribute('height'), viewport[1], viewport[1]),
          box = readViewBox(element)
        if (width <= 0 || height <= 0) return
        const viewportMatrix = box
          ? viewportTransform(
              box,
              width,
              height,
              element.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet',
            )
          : identity
        if (!live || referenced)
          matrix = multiply(
            matrix,
            multiply(
              [
                1,
                0,
                0,
                1,
                length(element.getAttribute('x'), viewport[0]),
                length(element.getAttribute('y'), viewport[1]),
              ],
              viewportMatrix,
            ),
          )
        localViewport = box ? [box[2], box[3]] : [width, height]
        // The clip frame precedes viewBox mapping, so meet letterboxing belongs
        // to the viewport and rotated ancestors do not enlarge its rectangle.
        localViewports = [
          ...viewports,
          { inverse: invert(multiply(matrix, invert(viewportMatrix)!))!, width, height },
        ]
      }
      if (tag === 'use') {
        const href = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? ''
        if (!href.startsWith('#')) {
          warn('external-reference', 'Only same-document SVG references are supported', source)
          return
        }
        const target =
          Array.from(root.querySelectorAll('[id]')).find((e) => e.id === href.slice(1)) ??
          (root.id === href.slice(1) ? root : null)
        if (!target) {
          warn('external-reference', `Missing SVG reference ${href}`, source)
          return
        }
        if (stack.includes(target)) {
          warn('external-reference', `Cyclic SVG reference ${href}`, source)
          return
        }
        const useMatrix = multiply(matrix, [
          1,
          0,
          0,
          1,
          length(element.getAttribute('x'), viewport[0]),
          length(element.getAttribute('y'), viewport[1]),
        ])
        const useViewport: readonly [number, number] = [
          length(element.getAttribute('width'), viewport[0], viewport[0]),
          length(element.getAttribute('height'), viewport[1], viewport[1]),
        ]
        visit(
          target,
          useMatrix,
          style,
          alpha,
          useViewport,
          [...stack, target],
          true,
          viewports,
          true,
        )
        return
      }
      if (CONTAINER_TAGS.has(tag)) {
        const children = element.children,
          childLimit = tag === 'switch' ? Math.min(1, children.length) : children.length,
          firstPath = paths.length
        for (let i = 0; i < childLimit; i++)
          visit(
            children[i]!,
            matrix,
            style,
            alpha,
            localViewport,
            stack,
            referenced,
            localViewports,
          )
        if (
          Number(style['opacity']) > 0 &&
          Number(style['opacity']) < 1 &&
          paths.length - firstPath > 1
        )
          warn(
            'unsupported-element',
            'Group opacity across multiple paints requires isolated compositing',
            source,
          )
        return
      }
      if (SKIPPED_TAGS.has(tag)) return
      const stroke = style['stroke']
      if (stroke && stroke !== 'none' && length(style['stroke-width'], viewport[0], 1) > 0)
        warn('stroke-ignored', 'SVG strokes must be expanded to filled paths', source)
      if (
        style['visibility'] === 'hidden' ||
        style['visibility'] === 'collapse' ||
        style['fill'] === 'none' ||
        Number(style['fill-opacity'] || 1) === 0
      )
        return
      const n = (name: string, base: number, fallback = 0): number =>
        length(element.getAttribute(name), base, fallback)
      let d = ''
      if (tag === 'path') d = element.getAttribute('d') ?? ''
      else if (tag === 'rect') {
        const x = n('x', viewport[0]),
          y = n('y', viewport[1]),
          w = n('width', viewport[0]),
          h = n('height', viewport[1])
        if (w <= 0 || h <= 0) return
        let rx = n('rx', viewport[0], NaN),
          ry = n('ry', viewport[1], NaN)
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry
        if (Number.isNaN(ry)) ry = rx
        rx = Math.min(w / 2, Math.max(0, rx))
        ry = Math.min(h / 2, Math.max(0, ry))
        d =
          rx && ry
            ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
            : `M${x} ${y}h${w}v${h}h${-w}Z`
      } else if (tag === 'circle' || tag === 'ellipse') {
        const x = n('cx', viewport[0]),
          y = n('cy', viewport[1])
        let rx = n(
            tag === 'circle' ? 'r' : 'rx',
            tag === 'circle' ? Math.hypot(...viewport) / Math.SQRT2 : viewport[0],
            NaN,
          ),
          ry = tag === 'circle' ? rx : n('ry', viewport[1], NaN)
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry
        if (Number.isNaN(ry)) ry = rx
        if (rx <= 0 || ry <= 0) return
        d = `M${x + rx} ${y}A${rx} ${ry} 0 1 1 ${x - rx} ${y}A${rx} ${ry} 0 1 1 ${x + rx} ${y}Z`
      } else if (tag === 'polygon' || tag === 'polyline')
        d = `M${element.getAttribute('points') ?? ''}Z`
      else if (tag === 'line') return
      else {
        warn('unsupported-element', `Unsupported SVG element ${tag}`, source)
        return
      }
      if (
        ++count > (options.maxElements ?? 10000) ||
        (characters += d.length) > (options.maxPathData ?? 1000000)
      ) {
        warn('limit-exceeded', 'SVG expansion limit exceeded', source)
        stopped = true
        return
      }
      paths.push({
        d,
        fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
        fill: style['fill'] || 'black',
        transform: matrix,
        alpha: alpha * Number(style['fill-opacity'] || 1),
        source,
        element,
        viewport: localViewport,
        ...(localViewports.length ? { viewports: localViewports } : {}),
      })
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('SVG ')) throw error
      warn('unsupported-unit', error instanceof Error ? error.message : String(error), source)
    }
  }
  visit(root, identity, {}, 1, viewBox ? [viewBox[2], viewBox[3]] : [100, 100], [])
  return { paths, ...(viewBox ? { viewBox } : {}), aspect }
}
