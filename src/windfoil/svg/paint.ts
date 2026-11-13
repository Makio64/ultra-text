import type {
  WindfoilAffine,
  WindfoilBoundingBox,
  WindfoilColorStop,
  WindfoilSvgPaint,
} from '../../types.js'
import { invert, multiply } from './curves.js'
import { inlineValue, parseTransform, type PathRecord } from './document.js'
import { colorPaint } from './colors.js'
export { colorPaint } from './colors.js'
/** Paint transforms map gradient coordinates into output outline coordinates. */
export function resolvePaint(
  record: PathRecord,
  mapping: WindfoilAffine,
  userBounds: WindfoilBoundingBox,
): WindfoilSvgPaint {
  const value = record.fill ?? 'black',
    alpha = record.alpha ?? 1
  if (!record.element || (value.charCodeAt(0) | 32) !== 117) return colorPaint(value, alpha)
  const match = /^url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/.exec(value)
  if (!match) return colorPaint(value, alpha)
  const root = record.element.ownerDocument,
    gradient = root.getElementById(match[1]!)
  if (!gradient || !['linearGradient', 'radialGradient'].includes(gradient.localName))
    return { type: 'unsupported', value }
  const chain: Element[] = []
  let current: Element | null = gradient
  while (current && !chain.includes(current) && chain.length < 64) {
    chain.push(current)
    const href: string | null = current.getAttribute('href') ?? current.getAttribute('xlink:href')
    current = href?.startsWith('#') ? root.getElementById(href.slice(1)) : null
  }
  const attr = (name: string, fallback: string): string =>
    chain.find((e) => e.hasAttribute(name))?.getAttribute(name) ?? fallback
  const units = attr('gradientUnits', 'objectBoundingBox'),
    viewport = record.viewport ?? [1, 1]
  const coordinate = (name: string, fallback: string, axis: number): number => {
    const v = attr(name, fallback),
      basis =
        units === 'objectBoundingBox'
          ? 1
          : axis === 2
            ? Math.hypot(...viewport) / Math.SQRT2
            : viewport[axis]!
    return parseFloat(v) * (v.endsWith('%') ? basis / 100 : 1)
  }
  let gradientMatrix: WindfoilAffine
  try {
    gradientMatrix = parseTransform(attr('gradientTransform', ''))
  } catch {
    return { type: 'unsupported', value }
  }
  if (units === 'objectBoundingBox')
    gradientMatrix = multiply(
      [
        userBounds[2] - userBounds[0],
        0,
        0,
        userBounds[3] - userBounds[1],
        userBounds[0],
        userBounds[1],
      ],
      gradientMatrix,
    )
  const transform = multiply(mapping, gradientMatrix)
  if (!invert(transform)) return { type: 'unsupported', value }
  const stopRoot = chain.find((e) => Array.from(e.children).some((c) => c.localName === 'stop'))
  const stops: WindfoilColorStop[] = []
  for (const stop of Array.from(stopRoot?.children ?? [])) {
    if (stop.localName !== 'stop') continue
    const offset = stop.getAttribute('offset') ?? '0',
      paint = colorPaint(
        inlineValue(stop, 'stop-color') ?? 'black',
        Number(inlineValue(stop, 'stop-opacity') ?? 1) * alpha,
      )
    if (paint.type !== 'solid') return { type: 'unsupported', value }
    stops.push({
      offset: Math.max(
        stops.at(-1)?.offset ?? 0,
        Math.min(1, Math.max(0, parseFloat(offset) / (offset.endsWith('%') ? 100 : 1))),
      ),
      color: paint.color,
    })
  }
  if (!stops.length) return { type: 'solid', color: [0, 0, 0, 0] }
  const spread = attr('spreadMethod', 'pad'),
    extend = spread === 'reflect' || spread === 'repeat' ? spread : 'pad'
  if (gradient.localName === 'linearGradient')
    return {
      type: 'linear',
      p0: [coordinate('x1', '0%', 0), coordinate('y1', '0%', 1)],
      p1: [coordinate('x2', '100%', 0), coordinate('y2', '0%', 1)],
      transform,
      stops,
      extend,
    }
  const cx = coordinate('cx', '50%', 0),
    cy = coordinate('cy', '50%', 1),
    r0 = coordinate('fr', '0%', 2),
    r1 = coordinate('r', '50%', 2)
  let fx = coordinate('fx', String(cx), 0),
    fy = coordinate('fy', String(cy), 1)
  if (![cx, cy, fx, fy, r0, r1].every(Number.isFinite) || r0 < 0 || r1 < 0)
    return { type: 'unsupported', value }
  // SVG 1.1 projects an outside focal point onto the end circle. Preserve
  // the general two-circle model for SVG 2's explicitly nonzero fr.
  const distance = Math.hypot(fx - cx, fy - cy)
  if (r0 === 0 && distance > r1) {
    fx = cx + ((fx - cx) * r1) / distance
    fy = cy + ((fy - cy) * r1) / distance
  }
  if (r0 === 0 && r1 === 0) return { type: 'solid', color: stops.at(-1)!.color }
  return {
    type: 'radial',
    c0: [fx, fy],
    r0,
    c1: [cx, cy],
    r1,
    transform,
    stops,
    extend,
  }
}
