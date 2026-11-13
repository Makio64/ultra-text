import type { WindfoilAffine, WindfoilBoundingBox, WindfoilQuadratic } from '../../types.js'
import type { Segment } from './pathData.js'

export const identity: WindfoilAffine = [1, 0, 0, 1, 0, 0]
export type Point = readonly [number, number]
export type Cubic = readonly [number, number, number, number, number, number, number, number]
export function applyAffine(m: WindfoilAffine, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
export function multiply(a: WindfoilAffine, b: WindfoilAffine): WindfoilAffine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
export function invert(m: WindfoilAffine): WindfoilAffine | null {
  const d = m[0] * m[3] - m[1] * m[2]
  return !Number.isFinite(d) || d === 0
    ? null
    : [
        m[3] / d,
        -m[1] / d,
        -m[2] / d,
        m[0] / d,
        (m[2] * m[5] - m[3] * m[4]) / d,
        (m[1] * m[4] - m[0] * m[5]) / d,
      ]
}
export function affineNorm(m: WindfoilAffine): number {
  const m0 = m[0],
    m1 = m[1],
    m2 = m[2],
    m3 = m[3]
  const s = m0 * m0 + m1 * m1 + m2 * m2 + m3 * m3,
    d = m0 * m3 - m1 * m2
  return Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * d * d))) * 0.5)
}
const CUBIC_BOUND_SCALE = Math.sqrt(3) / 36
export function cubicToQuadratics(
  p: Cubic,
  tolerance: number,
): { quads: WindfoilQuadratic[]; capped: boolean } {
  let r0 = p[0],
    r1 = p[1],
    r2 = p[2],
    r3 = p[3],
    r4 = p[4],
    r5 = p[5]
  const r6 = p[6],
    r7 = p[7]
  const bound = CUBIC_BOUND_SCALE * Math.hypot(r6 - 3 * r4 + 3 * r2 - r0, r7 - 3 * r5 + 3 * r3 - r1)
  const needed = Math.max(1, Math.ceil(Math.cbrt(bound / tolerance))),
    n = Math.min(64, needed),
    quads = new Array<WindfoilQuadratic>(n)
  for (let i = 0; i < n; i++) {
    const t = 1 / (n - i)
    const ax = r0 + (r2 - r0) * t,
      ay = r1 + (r3 - r1) * t,
      bx = r2 + (r4 - r2) * t,
      by = r3 + (r5 - r3) * t,
      cx = r4 + (r6 - r4) * t,
      cy = r5 + (r7 - r5) * t,
      dx = ax + (bx - ax) * t,
      dy = ay + (by - ay) * t,
      ex = bx + (cx - bx) * t,
      ey = by + (cy - by) * t,
      fx = dx + (ex - dx) * t,
      fy = dy + (ey - dy) * t
    quads[i] = [r0, r1, (3 * (ax + dx) - r0 - fx) * 0.25, (3 * (ay + dy) - r1 - fy) * 0.25, fx, fy]
    r0 = fx
    r1 = fy
    r2 = ex
    r3 = ey
    r4 = cx
    r5 = cy
  }
  return { quads, capped: needed > 64 }
}
export function arcToCubics(
  start: Point,
  arc: Extract<Segment, { type: 'arc' }>,
  sigmaMax: number,
  tolerance: number,
): Cubic[] {
  let rx = Math.abs(arc.rx),
    ry = Math.abs(arc.ry)
  if (!rx || !ry || (start[0] === arc.x && start[1] === arc.y)) return []
  const phi = (arc.rotation * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi),
    dx = (start[0] - arc.x) * 0.5,
    dy = (start[1] - arc.y) * 0.5
  const xp = cos * dx + sin * dy,
    yp = -sin * dx + cos * dy,
    lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const denominator = rx * rx * yp * yp + ry * ry * xp * xp
  const factor =
    (arc.large === arc.sweep ? -1 : 1) *
    Math.sqrt(Math.max(0, (rx * rx * ry * ry - denominator) / denominator))
  const cxp = (factor * rx * yp) / ry,
    cyp = (-factor * ry * xp) / rx,
    cx = cos * cxp - sin * cyp + (start[0] + arc.x) * 0.5,
    cy = sin * cxp + cos * cyp + (start[1] + arc.y) * 0.5
  const theta = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx)
  let delta = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx) - theta
  if (arc.sweep && delta < 0) delta += 2 * Math.PI
  if (!arc.sweep && delta > 0) delta -= 2 * Math.PI
  const quarter = Math.PI * 0.5,
    maxAngle =
      quarter * Math.min(1, Math.pow(tolerance / (2.7e-4 * Math.max(rx, ry) * sigmaMax), 1 / 6))
  const n = Math.min(4096, Math.max(1, Math.ceil(Math.abs(delta) / maxAngle))),
    result = new Array<Cubic>(n),
    rxCos = rx * cos,
    rySin = ry * sin,
    rxSin = rx * sin,
    ryCos = ry * cos,
    cos0 = Math.cos(theta),
    sin0 = Math.sin(theta)
  let a = theta,
    px = start[0],
    py = start[1],
    ux = -rxCos * sin0 - rySin * cos0,
    uy = -rxSin * sin0 + ryCos * cos0
  for (let i = 0; i < n; i++) {
    const b = theta + (delta * (i + 1)) / n,
      k = (4 / 3) * Math.tan((b - a) * 0.25),
      cosB = Math.cos(b),
      sinB = Math.sin(b),
      qx = i === n - 1 ? arc.x : cx + rxCos * cosB - rySin * sinB,
      qy = i === n - 1 ? arc.y : cy + rxSin * cosB + ryCos * sinB,
      vx = -rxCos * sinB - rySin * cosB,
      vy = -rxSin * sinB + ryCos * cosB
    result[i] = [px, py, px + k * ux, py + k * uy, qx - k * vx, qy - k * vy, qx, qy]
    a = b
    px = qx
    py = qy
    ux = vx
    uy = vy
  }
  return result
}
export class ContourBuilder {
  readonly contours: WindfoilQuadratic[][] = []
  private current: WindfoilQuadratic[] = []
  private startX = 0
  private startY = 0
  private pointX = 0
  private pointY = 0
  move(x: number, y: number): void {
    this.close()
    const fx = Math.fround(x),
      fy = Math.fround(y)
    this.startX = this.pointX = fx
    this.startY = this.pointY = fy
  }
  line(x: number, y: number): void {
    x = Math.fround(x)
    y = Math.fround(y)
    if (x === this.pointX && y === this.pointY) return
    this.quad((this.pointX + x) * 0.5, (this.pointY + y) * 0.5, x, y)
  }
  quad(cx: number, cy: number, x: number, y: number): void {
    const x0 = this.pointX,
      y0 = this.pointY,
      fcx = Math.fround(cx),
      fcy = Math.fround(cy),
      fx = Math.fround(x),
      fy = Math.fround(y)
    if (
      !Number.isFinite(x0) ||
      !Number.isFinite(y0) ||
      !Number.isFinite(fcx) ||
      !Number.isFinite(fcy) ||
      !Number.isFinite(fx) ||
      !Number.isFinite(fy)
    )
      throw new RangeError('SVG coordinates must be finite float32 values')
    if (x0 !== fcx || y0 !== fcy || x0 !== fx || y0 !== fy)
      this.current.push([x0, y0, fcx, fcy, fx, fy])
    this.pointX = fx
    this.pointY = fy
  }
  cubic(
    r0: number,
    r1: number,
    r2: number,
    r3: number,
    r4: number,
    r5: number,
    r6: number,
    r7: number,
    tolerance: number,
  ): boolean {
    const bound =
      CUBIC_BOUND_SCALE * Math.hypot(r6 - 3 * r4 + 3 * r2 - r0, r7 - 3 * r5 + 3 * r3 - r1)
    const needed = Math.max(1, Math.ceil(Math.cbrt(bound / tolerance))),
      n = Math.min(64, needed)
    for (let i = 0; i < n; i++) {
      const t = 1 / (n - i)
      const ax = r0 + (r2 - r0) * t,
        ay = r1 + (r3 - r1) * t,
        bx = r2 + (r4 - r2) * t,
        by = r3 + (r5 - r3) * t,
        cx = r4 + (r6 - r4) * t,
        cy = r5 + (r7 - r5) * t,
        dx = ax + (bx - ax) * t,
        dy = ay + (by - ay) * t,
        ex = bx + (cx - bx) * t,
        ey = by + (cy - by) * t,
        fx = dx + (ex - dx) * t,
        fy = dy + (ey - dy) * t
      this.quad((3 * (ax + dx) - r0 - fx) * 0.25, (3 * (ay + dy) - r1 - fy) * 0.25, fx, fy)
      r0 = fx
      r1 = fy
      r2 = ex
      r3 = ey
      r4 = cx
      r5 = cy
    }
    return needed > 64
  }
  close(): void {
    if (this.current.length) {
      this.line(this.startX, this.startY)
      this.contours.push(this.current)
      this.current = []
    }
    this.pointX = this.startX
    this.pointY = this.startY
  }
}
const OUTWARD_FLOAT = new Float32Array(1)
const OUTWARD_UINT = new Uint32Array(OUTWARD_FLOAT.buffer)
function outward(value: number, up: boolean): number {
  const rounded = Math.fround(value)
  if ((up && rounded >= value) || (!up && rounded <= value)) return rounded
  if (rounded === 0) return up ? 2 ** -149 : -(2 ** -149)
  OUTWARD_FLOAT[0] = rounded
  OUTWARD_UINT[0] = (OUTWARD_UINT[0] ?? 0) + (rounded >= 0 === up ? 1 : -1)
  return OUTWARD_FLOAT[0]
}
export function quadraticBounds(quadratics: readonly WindfoilQuadratic[]): WindfoilBoundingBox {
  if (!quadratics.length) return [0, 0, 0, 0]
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const q of quadratics) {
    const ax = q[0],
      ay = q[1],
      bx = q[2],
      by = q[3],
      cx = q[4],
      cy = q[5]
    if (ax < minX) minX = ax
    if (cx < minX) minX = cx
    if (ax > maxX) maxX = ax
    if (cx > maxX) maxX = cx
    if (ay < minY) minY = ay
    if (cy < minY) minY = cy
    if (ay > maxY) maxY = ay
    if (cy > maxY) maxY = cy
    if (bx < minX || bx > maxX) {
      const t = (ax - bx) / (ax - 2 * bx + cx)
      if (t > 0 && t < 1) {
        const u = 1 - t
        const x = u * u * ax + 2 * u * t * bx + t * t * cx
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
    if (by < minY || by > maxY) {
      const t = (ay - by) / (ay - 2 * by + cy)
      if (t > 0 && t < 1) {
        const u = 1 - t
        const y = u * u * ay + 2 * u * t * by + t * t * cy
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return [outward(minX, false), outward(minY, false), outward(maxX, true), outward(maxY, true)]
}
