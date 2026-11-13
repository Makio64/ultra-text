import type {
  DomSvgOptions,
  FontStyleSnapshot,
  GlyphLayout,
  GlyphRequest,
  GlyphShapePath,
  GlyphShapeStroke,
  WindfoilAffine,
} from '../types.js'

type Box = readonly [number, number, number, number]
type Color = readonly [number, number, number, number]
interface Layer {
  paths: GlyphShapePath[]
  color: Color
  bounds: Box
  clip?: Box
}
export interface SvgCaptureContext {
  readonly style: (element: Element) => CSSStyleDeclaration
  readonly opacity: (element: Element) => number
  readonly displayNone: (element: Element) => boolean
  readonly ignored: (element: Element) => boolean
  readonly color: (value: string, opacity: number) => [number, number, number, number]
  readonly requests: Map<string, GlyphRequest>
  readonly rootLeft: number
  readonly rootBottom: number
  readonly invScale: number
  readonly options: Readonly<DomSvgOptions>
  readonly budget: { pathData: number }
}
export interface SvgCapture {
  readonly box: Box
  readonly layers: readonly { readonly key: string; readonly color: Color; readonly clip?: Box }[]
  readonly overflow: boolean
}
const FONT: FontStyleSnapshot = {
  key: 'svg',
  canvasFont: '1000px sans-serif',
  family: 'sans-serif',
  weight: '400',
  style: 'normal',
  stretch: 'normal',
  variant: 'normal',
  kerning: 'none',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'none',
  size: 1000,
}
const IDENTITY: WindfoilAffine = [1, 0, 0, 1, 0, 0]
function multiply(a: WindfoilAffine, b: WindfoilAffine): WindfoilAffine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
function matrix(value: DOMMatrix): WindfoilAffine {
  return [value.a, value.b, value.c, value.d, value.e, value.f]
}
function policy(element: Element, context: SvgCaptureContext, reason: string): void {
  if (context.options.unsupported === 'error')
    throw new Error(`SVG capture <${element.localName}>: ${reason}`)
}
export function resolveSvgOptions(value: boolean | DomSvgOptions): DomSvgOptions {
  const options = typeof value === 'object' ? value : {}
  if (options.selector !== undefined && !options.selector.trim())
    throw new RangeError('svg.selector must be non-empty')
  if (
    options.maxPathData !== undefined &&
    (!Number.isSafeInteger(options.maxPathData) || options.maxPathData <= 0)
  )
    throw new RangeError('svg.maxPathData must be a positive integer')
  if (options.unsupported !== undefined && !['skip', 'error'].includes(options.unsupported))
    throw new RangeError('Invalid svg.unsupported policy')
  if (options.render !== undefined && !['bitmap'].includes(options.render))
    throw new RangeError('Invalid svg.render mode')
  return options
}
function numberOf(
  element: Element,
  style: CSSStyleDeclaration,
  name: string,
  fallback = 0,
): number {
  const css = style.getPropertyValue(name)
  const animated = (element as unknown as Record<string, { animVal?: { value?: number } }>)[name]
    ?.animVal?.value
  return (
    Number.parseFloat(
      css && css !== 'auto' ? css : String(animated ?? element.getAttribute(name) ?? fallback),
    ) || 0
  )
}
/** Synthesize native Path2D data without importing the optional vector converter. */
export function shapePathData(element: Element, style: CSSStyleDeclaration): string | null {
  const n = (name: string, fallback = 0) => numberOf(element, style, name, fallback)
  const name = element.localName
  if (name === 'path') {
    const css = style.getPropertyValue('d')
    return /^path\(["']/.test(css) ? css.slice(6, -2) : (element.getAttribute('d') ?? '')
  }
  if (name === 'line') return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`
  if (name === 'polygon' || name === 'polyline') {
    const points = element.getAttribute('points')?.trim() ?? ''
    return points ? `M${points}${name === 'polygon' ? 'Z' : ''}` : ''
  }
  if (name === 'circle' || name === 'ellipse') {
    const x = n('cx'),
      y = n('cy'),
      rx = name === 'circle' ? n('r') : n('rx'),
      ry = name === 'circle' ? rx : n('ry')
    return rx > 0 && ry > 0
      ? `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`
      : ''
  }
  if (name === 'rect') {
    const x = n('x'),
      y = n('y'),
      w = n('width'),
      h = n('height')
    if (w <= 0 || h <= 0) return ''
    const rx = Math.max(0, Math.min(w / 2, n('rx', n('ry')))),
      ry = Math.max(0, Math.min(h / 2, n('ry', rx)))
    return rx && ry
      ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      : `M${x} ${y}h${w}v${h}h${-w}Z`
  }
  return null
}
function instanceStyle(
  element: Element,
  inherited: CSSStyleDeclaration,
  computed: CSSStyleDeclaration,
): CSSStyleDeclaration {
  const style = element.ownerDocument.createElement('span').style
  for (const property of [
    'fill',
    'stroke',
    'color',
    'fill-rule',
    'fill-opacity',
    'stroke-opacity',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'stroke-dasharray',
    'stroke-dashoffset',
    'visibility',
    'paint-order',
  ]) {
    const authored =
      ((element as Partial<SVGElement>).style?.getPropertyValue(property) ?? '') ||
      element.getAttribute(property)
    style.setProperty(
      property,
      authored && authored !== 'inherit'
        ? authored
        : inherited.getPropertyValue(property) || computed.getPropertyValue(property),
    )
  }
  for (const property of [
    'display',
    'overflow',
    'filter',
    'mask',
    'clip-path',
    'mix-blend-mode',
    'vector-effect',
    'opacity',
  ])
    style.setProperty(property, computed.getPropertyValue(property))
  return style
}
function intersect(a: Box | undefined, b: Box): Box {
  return a
    ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
    : b
}
function transformBox(transform: WindfoilAffine, box: Box): Box {
  const t0 = transform[0]
  const t1 = transform[1]
  const t2 = transform[2]
  const t3 = transform[3]
  const t4 = transform[4]
  const t5 = transform[5]
  const b0 = box[0]
  const b1 = box[1]
  const b2 = box[2]
  const b3 = box[3]
  const x0 = t0 * b0 + t2 * b1 + t4
  const y0 = t1 * b0 + t3 * b1 + t5
  const x1 = t0 * b2 + t2 * b1 + t4
  const y1 = t1 * b2 + t3 * b1 + t5
  const x2 = t0 * b0 + t2 * b3 + t4
  const y2 = t1 * b0 + t3 * b3 + t5
  const x3 = t0 * b2 + t2 * b3 + t4
  const y3 = t1 * b2 + t3 * b3 + t5
  return [
    Math.min(x0, x1, x2, x3),
    Math.min(y0, y1, y2, y3),
    Math.max(x0, x1, x2, x3),
    Math.max(y0, y1, y2, y3),
  ]
}
function viewBoxMatrix(element: Element, w: number, h: number): WindfoilAffine {
  const vb = (element.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/).map(Number)
  if (vb.length !== 4 || !(vb[2]! > 0 && vb[3]! > 0)) return IDENTITY
  const preserve = element.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet'
  let sx = w / vb[2]!,
    sy = h / vb[3]!
  if (preserve !== 'none')
    sx = sy = preserve.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy)
  const align = (dimension: 'x' | 'Y') =>
    preserve.includes(`${dimension}Min`) ? 0 : preserve.includes(`${dimension}Max`) ? 1 : 0.5
  return [
    sx,
    0,
    0,
    sy,
    (w - vb[2]! * sx) * align('x') - vb[0]! * sx,
    (h - vb[3]! * sy) * align('Y') - vb[1]! * sy,
  ]
}
function reference(element: Element, href: string): Element | null {
  const tree = element.getRootNode() as Document | ShadowRoot
  return href.startsWith('#') ? tree.getElementById(href.slice(1)) : null
}

function keyOf(
  paths: readonly GlyphShapePath[],
  box: readonly [number, number],
  bitmap: boolean,
  bounds: Box,
  image?: HTMLImageElement,
): string {
  const serialized = JSON.stringify([
    paths.map((p) => ({ ...p, transform: p.transform.map((n) => Math.round(n * 1024) / 1024) })),
    box,
    bounds,
    bitmap,
    image?.currentSrc ?? image?.src,
  ])
  let a = 0x811c9dc5,
    b = 0x811c9dc5 ^ 0x5bd1e995
  for (let i = 0; i < serialized.length; i++) {
    const c = serialized.charCodeAt(i)
    a = Math.imul(a ^ c, 16777619)
    b = Math.imul(b ^ c, 1597334677)
  }
  return `svg\u0000${a}:${b}:${serialized.length}`
}
function strokeOf(
  element: SVGGeometryElement,
  style: CSSStyleDeclaration,
  scale: number,
): GlyphShapeStroke {
  const rawWidth = style.strokeWidth || (element.getAttribute('stroke-width') ?? '1')
  const viewport = element.ownerSVGElement?.viewBox.baseVal
  const percentage =
    viewport && viewport.width > 0
      ? Math.hypot(viewport.width, viewport.height) / Math.SQRT2 / 100
      : 1
  const width = Number.parseFloat(rawWidth) * (rawWidth.endsWith('%') ? percentage : 1)
  const nonScaling = style.getPropertyValue('vector-effect') === 'non-scaling-stroke'
  const pathLength = Number(element.getAttribute('pathLength'))
  const ratio = pathLength > 0 ? element.getTotalLength() / pathLength : 1
  const dash = (style.strokeDasharray || 'none').split(/[ ,]+/).map(Number.parseFloat)
  return {
    width: nonScaling ? width * scale : width,
    lineCap: (style.strokeLinecap || 'butt') as GlyphShapeStroke['lineCap'],
    lineJoin: (style.strokeLinejoin || 'miter') as GlyphShapeStroke['lineJoin'],
    miterLimit: Number(style.strokeMiterlimit) || 4,
    ...(dash.every(Number.isFinite) ? { dash: dash.map((n) => n * ratio) } : {}),
    dashOffset: (Number.parseFloat(style.strokeDashoffset) || 0) * ratio,
    ...(nonScaling ? { nonScaling: true } : {}),
  }
}

export function captureSvg(
  svg: SVGSVGElement | HTMLImageElement,
  context: SvgCaptureContext,
): SvgCapture | null {
  if (context.ignored(svg) || context.displayNone(svg)) return null
  const style = context.style(svg),
    rect = svg.getBoundingClientRect()
  const ctm = (svg as Partial<SVGSVGElement>).getScreenCTM?.()
  if (ctm && (Math.abs(ctm.b) > 1e-7 || Math.abs(ctm.c) > 1e-7 || ctm.a <= 0 || ctm.d <= 0)) {
    policy(svg, context, 'rotated, mirrored or skewed capture root')
    return null
  }
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  )
    return null
  const borderX =
    (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.paddingLeft) || 0)
  const borderY =
    (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.paddingTop) || 0)
  const left = rect.left + borderX,
    top = rect.top + borderY
  const width =
    rect.width -
    borderX -
    (Number.parseFloat(style.borderRightWidth) || 0) -
    (Number.parseFloat(style.paddingRight) || 0)
  const height =
    rect.height -
    borderY -
    (Number.parseFloat(style.borderBottomWidth) || 0) -
    (Number.parseFloat(style.paddingBottom) || 0)
  if (width <= 0 || height <= 0) return null
  const norm = 1000 / Math.max(width, height),
    box: readonly [number, number] = [width * norm, height * norm]
  const boxTransform: WindfoilAffine = [norm, 0, 0, norm, -left * norm, -top * norm]
  const fullBounds: Box = [0, 0, ...box]
  const bitmap = context.options.render === 'bitmap' || svg.localName === 'img'
  const layers: Layer[] = []
  const add = (path: GlyphShapePath, color: Color, bounds: Box, clip?: Box) => {
    if (color[3] <= 0) return
    const previous = layers.at(-1)
    if (
      previous &&
      previous.clip === clip &&
      color[3] === 1 &&
      previous.color.every((v, i) => v === color[i])
    ) {
      previous.paths.push(path)
      previous.bounds = [
        Math.min(previous.bounds[0], bounds[0]),
        Math.min(previous.bounds[1], bounds[1]),
        Math.max(previous.bounds[2], bounds[2]),
        Math.max(previous.bounds[3], bounds[3]),
      ]
    } else layers.push({ paths: [path], color, bounds, ...(clip ? { clip } : {}) })
  }
  const visiting = new Set<Element>()
  let opacityGroup = 0
  const walk = (
    element: Element,
    override?: WindfoilAffine,
    inherited?: CSSStyleDeclaration,
    alpha?: number,
    depth = 0,
    inheritedClip: Box | undefined = style.overflow === 'visible' ? undefined : fullBounds,
    parentGroups: readonly (readonly [number, number])[] = [],
  ): void => {
    if (depth > 8 || visiting.has(element)) {
      policy(element, context, 'cyclic or deeply nested use')
      return
    }
    if (context.ignored(element) || (!override && context.displayNone(element))) return
    const computed = context.style(element)
    const s = inherited ? instanceStyle(element, inherited, computed) : computed
    if (s.display === 'none') return
    const name = element.localName
    const ownOpacity = Number.parseFloat(computed.opacity || '1')
    const opacityGroups =
      bitmap && element !== svg && ownOpacity !== 1
        ? [...parentGroups, [opacityGroup++, ownOpacity] as const]
        : parentGroups
    const currentAlpha =
      alpha === undefined
        ? context.opacity(element)
        : alpha * Number.parseFloat(computed.opacity || '1')
    if (
      [
        'defs',
        'symbol',
        'clipPath',
        'mask',
        'marker',
        'pattern',
        'linearGradient',
        'radialGradient',
        'title',
        'desc',
        'metadata',
        'style',
        'script',
      ].includes(name) &&
      !override
    )
      return
    if (['image', 'text', 'foreignObject', 'filter'].includes(name)) {
      policy(element, context, 'unsupported content')
      return
    }
    for (const property of ['filter', 'mask', 'mix-blend-mode']) {
      const value = s.getPropertyValue(property)
      if (value && !['none', 'normal'].includes(value)) {
        policy(element, context, `unsupported ${property}`)
        return
      }
    }
    let transform = override
    if (transform) {
      const list = (element as Partial<SVGGraphicsElement>).transform?.baseVal.consolidate()
      if (list) transform = multiply(transform, matrix(list.matrix))
    } else {
      const ctm = (element as Partial<SVGGraphicsElement>).getScreenCTM?.()
      if (ctm) transform = multiply(boxTransform, matrix(ctm))
    }
    transform ??= IDENTITY
    if (!transform.every(Number.isFinite)) {
      policy(element, context, 'invalid transform')
      return
    }
    let clip = inheritedClip
    if (name === 'svg' && element !== svg && s.overflow !== 'visible') {
      const w = numberOf(element, computed, 'width'),
        h = numberOf(element, computed, 'height')
      const vb = viewBoxMatrix(element, w, h)
      if (Math.abs(transform[1]) > 1e-7 || Math.abs(transform[2]) > 1e-7 || !vb[0] || !vb[3]) {
        policy(element, context, 'non-rectangular nested viewport')
        return
      }
      const viewport = multiply(transform, [
        1 / vb[0],
        0,
        0,
        1 / vb[3],
        -vb[4] / vb[0],
        -vb[5] / vb[3],
      ])
      clip = intersect(clip, transformBox(viewport, [0, 0, w, h]))
    }
    const clipping = s.getPropertyValue('clip-path')
    if (clipping && clipping !== 'none') {
      const href = /url\(["']?(#[^"')]+)["']?\)/.exec(clipping)?.[1]
      const target = href ? reference(element, href) : null
      const rect = target?.children.length === 1 ? target.firstElementChild : null
      if (
        target?.localName !== 'clipPath' ||
        rect?.localName !== 'rect' ||
        numberOf(rect, context.style(rect), 'rx') ||
        numberOf(rect, context.style(rect), 'ry')
      ) {
        policy(element, context, 'unsupported clip-path')
        return
      }
      let clipTransform = transform
      if (target.getAttribute('clipPathUnits') === 'objectBoundingBox') {
        const bounds = (element as SVGGraphicsElement).getBBox()
        clipTransform = multiply(clipTransform, [
          bounds.width,
          0,
          0,
          bounds.height,
          bounds.x,
          bounds.y,
        ])
      }
      for (const part of [target, rect]) {
        const authored = (part as Partial<SVGGraphicsElement>).transform?.baseVal.consolidate()
        if (authored) clipTransform = multiply(clipTransform, matrix(authored.matrix))
      }
      if (Math.abs(clipTransform[1]) > 1e-7 || Math.abs(clipTransform[2]) > 1e-7) {
        policy(element, context, 'non-rectangular clip-path')
        return
      }
      const rectStyle = context.style(rect),
        x = numberOf(rect, rectStyle, 'x'),
        y = numberOf(rect, rectStyle, 'y')
      clip = intersect(
        clip,
        transformBox(clipTransform, [
          x,
          y,
          x + numberOf(rect, rectStyle, 'width'),
          y + numberOf(rect, rectStyle, 'height'),
        ]),
      )
    }
    if (clip && (clip[2] <= clip[0] || clip[3] <= clip[1])) return
    if (name === 'use') {
      const href = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? ''
      const target = reference(element, href)
      if (!target) {
        policy(element, context, 'external or missing use target')
        return
      }
      visiting.add(element)
      let targetTransform = multiply(transform, [
        1,
        0,
        0,
        1,
        numberOf(element, s, 'x'),
        numberOf(element, s, 'y'),
      ])
      if (['symbol', 'svg'].includes(target.localName)) {
        const w = numberOf(element, s, 'width'),
          h = numberOf(element, s, 'height')
        if (w > 0 && h > 0) {
          if (context.style(target).overflow !== 'visible')
            clip = intersect(clip, transformBox(targetTransform, [0, 0, w, h]))
          targetTransform = multiply(targetTransform, viewBoxMatrix(target, w, h))
        }
      }
      walk(target, targetTransform, s, currentAlpha, depth + 1, clip, opacityGroups)
      visiting.delete(element)
      return
    }
    if (['svg', 'g', 'a', 'symbol', 'switch'].includes(name)) {
      visiting.add(element)
      for (const child of element.children) {
        if (
          name === 'switch' &&
          (child.hasAttribute('requiredExtensions') || child.hasAttribute('requiredFeatures'))
        )
          continue
        walk(
          child,
          override ? transform : undefined,
          inherited ? s : undefined,
          alpha === undefined ? undefined : currentAlpha,
          depth,
          clip,
          opacityGroups,
        )
        if (name === 'switch') break
      }
      visiting.delete(element)
      return
    }
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return
    const d = shapePathData(element, computed)
    if (d === null) {
      policy(element, context, 'unsupported element')
      return
    }
    if (!d) return
    context.budget.pathData -= d.length
    if (context.budget.pathData < 0) throw new RangeError('SVG capture exceeds svg.maxPathData')
    let bounds = fullBounds
    try {
      const b = (element as SVGGraphicsElement).getBBox()
      const points = [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
      ].map(([x, y]) => [
        transform[0] * x! + transform[2] * y! + transform[4],
        transform[1] * x! + transform[3] * y! + transform[5],
      ])
      bounds = [
        Math.min(...points.map((p) => p[0]!)),
        Math.min(...points.map((p) => p[1]!)),
        Math.max(...points.map((p) => p[0]!)),
        Math.max(...points.map((p) => p[1]!)),
      ]
    } catch {
      /* A conservative viewport mask is safe on DOMs without getBBox. */
    }
    const order = (s.getPropertyValue('paint-order') || '').startsWith('stroke')
      ? ['stroke', 'fill']
      : ['fill', 'stroke']
    for (const paint of order) {
      let value =
        s.getPropertyValue(paint) ||
        (element.getAttribute(paint) ?? inherited?.getPropertyValue(paint) ?? '') ||
        (paint === 'fill' ? 'black' : 'none')
      if (value === 'none') continue
      if (value.startsWith('url(')) {
        const fallback = value.replace(/^url\([^)]*\)\s*/, '')
        if (!fallback) {
          policy(element, context, 'unsupported paint server')
          continue
        }
        value = fallback
      }
      if (value.toLowerCase() === 'currentcolor') value = s.color || (inherited?.color ?? 'black')
      const color = context.color(
        value,
        (bitmap ? 1 : currentAlpha) *
          Number.parseFloat(
            s.getPropertyValue(`${paint}-opacity`) ||
              (element.getAttribute(`${paint}-opacity`) ?? '1'),
          ),
      )
      const stroke =
        paint === 'stroke' ? strokeOf(element as SVGGeometryElement, s, norm) : undefined
      if (stroke && !(stroke.width > 0)) continue
      const amount = stroke
        ? (stroke.width *
            (stroke.nonScaling
              ? 1
              : Math.max(
                  Math.hypot(transform[0], transform[1]),
                  Math.hypot(transform[2], transform[3]),
                )) *
            (stroke.lineJoin === 'miter' ? stroke.miterLimit : 1)) /
          2
        : 0
      let ink: Box = [
        bounds[0] - amount,
        bounds[1] - amount,
        bounds[2] + amount,
        bounds[3] + amount,
      ]
      if (clip) ink = intersect(clip, ink)
      if (ink[2] <= ink[0] || ink[3] <= ink[1]) continue
      add(
        {
          d,
          transform,
          ...(stroke
            ? { stroke }
            : { fillRule: s.fillRule === 'evenodd' ? ('evenodd' as const) : ('nonzero' as const) }),
          ...(bitmap
            ? {
                color,
                ...(clip ? { clip } : {}),
                ...(opacityGroups.length ? { opacityGroups } : {}),
              }
            : {}),
        },
        color,
        ink,
        clip,
      )
    }
  }
  let image: HTMLImageElement | undefined
  if (svg.localName === 'img') {
    image = svg as HTMLImageElement
    if (!image.complete || !image.naturalWidth) {
      policy(svg, context, 'image is not decoded')
      return null
    }
    const scratch = svg.ownerDocument.createElement('canvas')
    scratch.width = scratch.height = 1
    try {
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(image, 0, 0, 1, 1)
      ctx.getImageData(0, 0, 1, 1)
    } catch {
      policy(svg, context, 'image is not CORS-clean')
      return null
    }
    layers.push({ paths: [], color: [1, 1, 1, context.opacity(svg)], bounds: fullBounds })
  } else walk(svg)
  if (!layers.length) return null
  const output = bitmap
    ? [
        {
          paths: layers.flatMap((l) => l.paths),
          color: [1, 1, 1, context.opacity(svg)] as Color,
          bounds: fullBounds,
        },
      ]
    : layers
  return {
    box: [
      (left - context.rootLeft) * context.invScale,
      (context.rootBottom - top - height) * context.invScale,
      (left + width - context.rootLeft) * context.invScale,
      (context.rootBottom - top) * context.invScale,
    ],
    overflow: style.overflow === 'visible',
    layers: output.map((layer) => {
      const key = keyOf(layer.paths, box, bitmap, layer.bounds, image)
      context.requests.set(key, {
        key,
        character: '\ufffc',
        font: FONT,
        shape: {
          paths: layer.paths,
          box,
          bounds: layer.bounds,
          ...(bitmap ? { bitmap: true } : {}),
          ...(image ? { image } : {}),
        },
      })
      return {
        key,
        color: layer.color,
        ...(layer.clip
          ? {
              clip: [
                (left + layer.clip[0] / norm - context.rootLeft) * context.invScale,
                (context.rootBottom - top - layer.clip[3] / norm) * context.invScale,
                (left + layer.clip[2] / norm - context.rootLeft) * context.invScale,
                (context.rootBottom - top - layer.clip[1] / norm) * context.invScale,
              ] as Box,
            }
          : {}),
      }
    }),
  }
}

/** Append all layers as one atomic inline and one animation unit. */
export function appendSvg(
  capture: SvgCapture,
  glyphs: GlyphLayout[],
  block: number,
  shapeGroup: number,
  clip: Box,
  z: number,
  sequence: number,
): void {
  const [x0, y0, x1, y1] = capture.box
  const previous = glyphs.at(-1)
  const baseline =
    previous?.block === block &&
    previous.lineBottom < y1 &&
    previous.lineBottom + previous.fontSize > y0
      ? previous.lineBottom
      : y0
  const clipped: Box = capture.overflow
    ? clip
    : [Math.max(clip[0], x0), Math.max(clip[1], y0), Math.min(clip[2], x1), Math.min(clip[3], y1)]
  const motionOrigin: readonly [number, number, number] = [
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    glyphs.length,
  ]
  capture.layers.forEach((layer, index) =>
    glyphs.push({
      glyphKey: layer.key,
      shapeGroup,
      fontSize: Math.max(x1 - x0, y1 - y0),
      originX: x0,
      lineBottom: baseline,
      baselineOffset: y0 - baseline,
      advance: index === capture.layers.length - 1 ? x1 - x0 : 0,
      block,
      breakBefore: index === 0 ? 'soft' : 'none',
      clip: layer.clip ? intersect(clipped, layer.clip) : clipped,
      color: layer.color,
      sequence,
      z,
      ...(capture.layers.length > 1 ? { motionOrigin } : {}),
    }),
  )
}

/** Assign SVG groups the same drawable ordinal while retaining shaped-run grouping. */
export function normalizeSvgMotion(glyphs: GlyphLayout[]): void {
  let ordinal = -1
  let previous: GlyphLayout | undefined
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i]!
    if (
      !(glyph.shapeGroup !== undefined && glyph.shapeGroup === previous?.shapeGroup) &&
      !(glyph.motionOrigin && glyph.motionOrigin === previous?.motionOrigin)
    )
      ordinal++
    if (glyph.motionOrigin)
      glyphs[i] = {
        ...glyph,
        motionOrigin: [glyph.motionOrigin[0], glyph.motionOrigin[1], ordinal],
      }
    previous = glyph
  }
}

/** Snap inline atomic shapes to nearby text without changing their visual box. */
export function normalizeSvgLines(
  glyphs: GlyphLayout[],
  start: number,
  boxes: ReadonlyMap<number, Box>,
): number {
  for (let index = start; index < glyphs.length;) {
    const first = glyphs[index]!
    if (first.shapeGroup === undefined) {
      index++
      continue
    }
    let end = index + 1
    while (end < glyphs.length && glyphs[end]!.shapeGroup === first.shapeGroup) end++
    const box = boxes.get(first.shapeGroup)!
    const before = index > start ? glyphs[index - 1] : undefined,
      after = glyphs[end]
    const adjacent = [before, after].find(
      (glyph) =>
        glyph &&
        glyph.shapeGroup === undefined &&
        glyph.lineBottom < box[3] &&
        glyph.lineBottom + glyph.fontSize > box[1],
    )
    if (adjacent)
      for (let layer = index; layer < end; layer++) {
        const glyph = glyphs[layer]!
        glyphs[layer] = {
          ...glyph,
          lineBottom: adjacent.lineBottom,
          baselineOffset: box[1] - adjacent.lineBottom,
        }
      }
    index = end
  }
  const sequences = new Map<number, number>()
  let previous: GlyphLayout | undefined
  for (let index = start; index < glyphs.length; index++) {
    const glyph = glyphs[index]!,
      key = Math.round(glyph.lineBottom * 4)
    const sameUnit =
      (glyph.shapeGroup !== undefined && glyph.shapeGroup === previous?.shapeGroup) ||
      (!!glyph.motionOrigin && glyph.motionOrigin === previous?.motionOrigin)
    const sequence = sameUnit ? glyphs[index - 1]!.sequence : (sequences.get(key) ?? 0)
    if (!sameUnit) sequences.set(key, sequence + 1)
    glyphs[index] = { ...glyph, sequence }
    previous = glyph
  }
  return sequences.size
}
