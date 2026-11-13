import type { WindfoilShapePathLike } from '../../types.js'
import { readViewBox, type PathRecord, type Warn } from './document.js'
interface Vector {
  x: number
  y: number
}
interface Curve {
  isLineCurve?: boolean
  isQuadraticBezierCurve?: boolean
  isCubicBezierCurve?: boolean
  isEllipseCurve?: boolean
  v0?: Vector
  v1?: Vector
  v2?: Vector
  v3?: Vector
  aX?: number
  aY?: number
  xRadius?: number
  yRadius?: number
  aStartAngle?: number
  aEndAngle?: number
  aClockwise?: boolean
  aRotation?: number
}
export function shapePaths(
  source: { readonly paths: readonly WindfoilShapePathLike[]; readonly xml?: Element | Document },
  warn: Warn,
): { paths: PathRecord[]; viewBox?: readonly [number, number, number, number]; aspect: string } {
  const root =
      source.xml && ('documentElement' in source.xml ? source.xml.documentElement : source.xml),
    viewBox = root ? readViewBox(root) : undefined
  if (root?.querySelector('svg'))
    warn('nested-viewport-lost', 'SVGLoader does not preserve nested SVG viewports')
  const paths = source.paths.map((path, index): PathRecord => {
    let d = ''
    for (const sub of path.subPaths) {
      let first = true
      for (const object of sub.curves) {
        const curve = object as Curve,
          point = (v: Vector): string => `${v.x} ${v.y}`
        if (curve.isLineCurve && curve.v1 && curve.v2) {
          if (first) d += `M${point(curve.v1)}`
          d += `L${point(curve.v2)}`
        } else if (curve.isQuadraticBezierCurve && curve.v0 && curve.v1 && curve.v2) {
          if (first) d += `M${point(curve.v0)}`
          d += `Q${point(curve.v1)} ${point(curve.v2)}`
        } else if (curve.isCubicBezierCurve && curve.v0 && curve.v1 && curve.v2 && curve.v3) {
          if (first) d += `M${point(curve.v0)}`
          d += `C${point(curve.v1)} ${point(curve.v2)} ${point(curve.v3)}`
        } else if (curve.isEllipseCurve) {
          const {
            aX = 0,
            aY = 0,
            xRadius = 1,
            yRadius = 1,
            aStartAngle = 0,
            aEndAngle = 2 * Math.PI,
            aClockwise = false,
            aRotation = 0,
          } = curve
          let delta = aEndAngle - aStartAngle
          while (delta < 0) delta += Math.PI * 2
          while (delta > Math.PI * 2) delta -= Math.PI * 2
          if (aClockwise) delta = delta === Math.PI * 2 ? -Math.PI * 2 : delta - Math.PI * 2
          const p = (a: number): Vector => ({
            x:
              aX +
              xRadius * Math.cos(a) * Math.cos(aRotation) -
              yRadius * Math.sin(a) * Math.sin(aRotation),
            y:
              aY +
              xRadius * Math.cos(a) * Math.sin(aRotation) +
              yRadius * Math.sin(a) * Math.cos(aRotation),
          })
          if (first) d += `M${point(p(aStartAngle))}`
          const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
          for (let i = 1; i <= count; i++)
            d += `A${xRadius} ${yRadius} ${(aRotation * 180) / Math.PI} 0 ${aClockwise ? 0 : 1} ${point(p(aStartAngle + (delta * i) / count))}`
        } else warn('unsupported-element', 'Unsupported SVGLoader curve', `path[${index}]`)
        first = false
      }
      d += 'Z'
    }
    const raw = path.userData?.['style'],
      style = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    if (style['stroke'] && style['stroke'] !== 'none' && Number(style['strokeWidth'] ?? 1) > 0)
      warn('stroke-ignored', 'SVGLoader strokes are ignored', `path[${index}]`)
    return {
      d,
      source: `path[${index}]`,
      fill: typeof style['fill'] === 'string' ? style['fill'] : 'black',
      fillRule: style['fillRule'] === 'evenodd' ? 'evenodd' : 'nonzero',
      alpha: Number(style['opacity'] ?? 1) * Number(style['fillOpacity'] ?? 1),
    }
  })
  return {
    paths,
    ...(viewBox ? { viewBox } : {}),
    aspect: root?.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet',
  }
}
