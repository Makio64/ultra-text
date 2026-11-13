import type { WindfoilAffine, WindfoilPaint } from '../types.js'

export interface NormalizedPaint {
  readonly kind: 0 | 1 | 2 | 3 | 4
  readonly extend: 0 | 1 | 2
  readonly color: readonly number[]
  readonly inverse: WindfoilAffine
  readonly params: readonly number[]
  readonly stops: readonly { readonly offset: number; readonly color: readonly number[] }[]
  readonly alphaMax: number
}
const IDENTITY: WindfoilAffine = [1, 0, 0, 1, 0, 0]
const EMPTY_NUMBERS: readonly number[] = []
const EMPTY_STOPS: readonly { readonly offset: number; readonly color: readonly number[] }[] = []
const ZERO_COLOR: readonly number[] = [0, 0, 0, 0]
function solidPaint(color: readonly number[], kind: 0 | 1 = 0): NormalizedPaint {
  return {
    kind,
    color,
    extend: 0,
    inverse: IDENTITY,
    params: EMPTY_NUMBERS,
    stops: EMPTY_STOPS,
    alphaMax: color[3]!,
  }
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${label} must be finite`)
  if (!Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must fit float32`)
  return value
}
function tuple(value: unknown, length: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new TypeError(`${label} must contain ${length} numbers`)
  const out = new Array<number>(length)
  for (let index = 0; index < length; index++) {
    out[index] = finite(value[index], `${label}[${index}]`)
  }
  return out
}
function rgba(value: unknown, label: string): number[] {
  const out = tuple(value, 4, label)
  for (let index = 0; index < 4; index++) {
    const number = out[index]!
    if (number < 0 || number > 1) throw new RangeError(`${label}[${index}] must be in 0–1`)
  }
  return out
}
function inverseAffine(value: WindfoilAffine | undefined, label: string): WindfoilAffine {
  if (!value) return IDENTITY
  const [a, b, c, d, e, f] = tuple(value, 6, label) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const det = a * d - b * c
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d))
  if (scale === 0 || Math.abs(det) < 1e-12 * scale * scale)
    throw new RangeError(`${label} must be nonsingular`)
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}
export function normalizeWindfoilPaint(paint: WindfoilPaint, label = 'paint'): NormalizedPaint {
  // Validate runtime provider input as well as the declared contract.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!paint || typeof paint !== 'object') throw new TypeError(`${label} must be an object`)
  if (paint.type === 'solid') return solidPaint(rgba(paint.color, `${label}.color`))
  if (paint.type === 'foreground') {
    const alpha = finite(paint.alpha ?? 1, `${label}.alpha`)
    if (alpha < 0 || alpha > 1) throw new RangeError(`${label}.alpha must be in 0–1`)
    return solidPaint([0, 0, 0, alpha], 1)
  }
  const extend = paint.extend ?? 'pad'
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (extend !== 'pad' && extend !== 'repeat' && extend !== 'reflect')
    throw new TypeError(`${label}.extend is invalid`)
  const inverse = inverseAffine(paint.transform, `${label}.transform`)
  if (!Array.isArray(paint.stops)) throw new TypeError(`${label}.stops must be an array`)
  const rawStops = paint.stops as readonly {
    readonly offset: number
    readonly color: readonly number[]
  }[]
  const stopCount = rawStops.length
  const stops = new Array<{ offset: number; color: number[] }>(stopCount)
  let sorted = true
  let prevOffset = -Infinity
  let alphaMax = 0
  for (let index = 0; index < stopCount; index++) {
    const stop = rawStops[index]!
    const offset = finite(stop.offset, `${label}.stops[${index}].offset`)
    const color = rgba(stop.color, `${label}.stops[${index}].color`)
    if (offset < prevOffset) sorted = false
    prevOffset = offset
    const a = color[3]!
    if (a > alphaMax) alphaMax = a
    stops[index] = { offset, color }
  }
  if (!sorted) stops.sort((a, b) => a.offset - b.offset)
  // Validate geometry even when a zero-alpha colour line is omitted later.
  let params: number[], kind: 2 | 3 | 4
  const t0 = stopCount > 0 ? stops[0]!.offset : 0,
    t1 = stopCount > 0 ? stops[stopCount - 1]!.offset : 1
  const span = t1 - t0
  if (paint.type === 'linear') {
    const p0 = tuple(paint.p0, 2, `${label}.p0`),
      p1 = tuple(paint.p1, 2, `${label}.p1`)
    const p2 = paint.p2
      ? tuple(paint.p2, 2, `${label}.p2`)
      : [p0[0]! - (p1[1]! - p0[1]!), p0[1]! + p1[0]! - p0[0]!]
    const nx = p2[1]! - p0[1]!,
      ny = p0[0]! - p2[0]!
    const projection = (p1[0]! - p0[0]!) * nx + (p1[1]! - p0[1]!) * ny
    kind = 2
    if (Math.abs(projection) < 1e-20) return solidPaint(ZERO_COLOR)
    // Color-line normalization is equivalent to t'=(t-t0)/(t1-t0).
    const divisor = projection * (span || 1)
    params = [
      nx / divisor,
      ny / divisor,
      (-(p0[0]! * nx + p0[1]! * ny) / projection - t0) / (span || 1),
    ]
  } else if (paint.type === 'radial') {
    const c0 = tuple(paint.c0, 2, `${label}.c0`),
      c1 = tuple(paint.c1, 2, `${label}.c1`)
    const r0 = finite(paint.r0, `${label}.r0`),
      r1 = finite(paint.r1, `${label}.r1`)
    if (r0 < 0 || r1 < 0) throw new RangeError(`${label} radii must be non-negative`)
    const dx = c1[0]! - c0[0]!,
      dy = c1[1]! - c0[1]!,
      dr = r1 - r0
    params = [
      c0[0]! + dx * t0,
      c0[1]! + dy * t0,
      dx * (span || 1),
      dy * (span || 1),
      r0 + dr * t0,
      dr * (span || 1),
    ]
    kind = 3
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (paint.type === 'sweep') {
    const center = tuple(paint.center, 2, `${label}.center`)
    const start = (finite(paint.startAngle, `${label}.startAngle`) * Math.PI) / 180
    const end = (finite(paint.endAngle, `${label}.endAngle`) * Math.PI) / 180
    kind = 4
    if (end === start) return solidPaint(ZERO_COLOR)
    params = [center[0]!, center[1]!, start + (end - start) * t0, 1 / ((end - start) * (span || 1))]
  } else {
    throw new TypeError(`${label}.type is invalid`)
  }
  if (!stopCount || alphaMax === 0) return solidPaint(ZERO_COLOR)
  if (stopCount === 1 || span === 0) return solidPaint(stops[stopCount - 1]!.color)
  const invSpan = 1 / span
  for (let i = 0; i < stopCount; i++) {
    const stop = stops[i]!
    stop.offset = (stop.offset - t0) * invSpan
  }
  return {
    kind,
    extend: extend === 'pad' ? 0 : extend === 'repeat' ? 1 : 2,
    color: ZERO_COLOR,
    inverse,
    params,
    stops,
    alphaMax,
  }
}
const floatBitsBuf = new ArrayBuffer(4)
const floatBitsF32 = new Float32Array(floatBitsBuf)
const floatBitsU32 = new Uint32Array(floatBitsBuf)
const floatBitsView = new DataView(floatBitsBuf)
const isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
export function floatBits(value: number): number {
  if (isLittleEndian) {
    floatBitsF32[0] = value
    return floatBitsU32[0]!
  }
  floatBitsView.setFloat32(0, value, true)
  return floatBitsView.getUint32(0, true)
}
function colorBits(color: readonly number[]): number {
  return (
    (Math.round(color[0]! * 255) |
      (Math.round(color[1]! * 255) << 8) |
      (Math.round(color[2]! * 255) << 16) |
      (Math.round(color[3]! * 255) << 24)) >>>
    0
  )
}
function sameNormalizedPaint(a: NormalizedPaint, b: NormalizedPaint): boolean {
  if (a === b) return true
  if (
    a.kind !== b.kind ||
    a.extend !== b.extend ||
    a.alphaMax !== b.alphaMax ||
    a.params.length !== b.params.length ||
    a.stops.length !== b.stops.length
  )
    return false
  const ac = a.color,
    bc = b.color
  if (ac[0] !== bc[0] || ac[1] !== bc[1] || ac[2] !== bc[2] || ac[3] !== bc[3]) return false
  const ai = a.inverse,
    bi = b.inverse
  if (
    ai !== bi &&
    (ai[0] !== bi[0] ||
      ai[1] !== bi[1] ||
      ai[2] !== bi[2] ||
      ai[3] !== bi[3] ||
      ai[4] !== bi[4] ||
      ai[5] !== bi[5])
  )
    return false
  for (let i = 0; i < a.params.length; i++) {
    if (a.params[i] !== b.params[i]) return false
  }
  for (let i = 0; i < a.stops.length; i++) {
    const as = a.stops[i]!,
      bs = b.stops[i]!
    if (as.offset !== bs.offset) return false
    const asc = as.color,
      bsc = bs.color
    if (asc[0] !== bsc[0] || asc[1] !== bsc[1] || asc[2] !== bsc[2] || asc[3] !== bsc[3])
      return false
  }
  return true
}
function hashNormalizedPaint(paint: NormalizedPaint): number {
  let h = (paint.kind | (paint.extend << 4) | (paint.stops.length << 8)) ^ floatBits(paint.alphaMax)
  h = Math.imul(h ^ colorBits(paint.color), 0x01000193)
  if (paint.inverse !== IDENTITY) {
    const inv = paint.inverse
    h = Math.imul(h ^ floatBits(inv[0]), 0x01000193)
    h = Math.imul(h ^ floatBits(inv[3]), 0x01000193)
    h = Math.imul(h ^ floatBits(inv[4]), 0x01000193)
    h = Math.imul(h ^ floatBits(inv[5]), 0x01000193)
  }
  const params = paint.params
  for (const param of params) {
    h = Math.imul(h ^ floatBits(param), 0x01000193)
  }
  const stops = paint.stops
  if (stops.length > 0) {
    const first = stops[0]!,
      last = stops[stops.length - 1]!
    h = Math.imul(h ^ floatBits(first.offset) ^ colorBits(first.color), 0x01000193)
    h = Math.imul(h ^ floatBits(last.offset) ^ colorBits(last.color), 0x01000193)
  }
  return h
}
export function packWindfoilPaints(input: readonly NormalizedPaint[]): {
  paints: Uint32Array
  stops: Uint32Array
  indices: readonly number[]
} {
  const count = input.length,
    paints = new Uint32Array(count * 16),
    stops: number[] = [],
    indices = new Array<number>(count),
    uniquePaints: NormalizedPaint[] = [],
    nextInBucket = new Int32Array(count),
    buckets = new Map<number, number>()
  let paintWords = 0
  for (let paintIdx = 0; paintIdx < count; paintIdx++) {
    const paint = input[paintIdx]!
    const hash = hashNormalizedPaint(paint)
    const head = buckets.get(hash) ?? -1
    let index = -1
    for (let cand = head; cand >= 0; cand = nextInBucket[cand]!) {
      if (sameNormalizedPaint(uniquePaints[cand]!, paint)) {
        index = cand
        break
      }
    }
    if (index < 0) {
      index = paintWords >>> 4
      uniquePaints.push(paint)
      nextInBucket[index] = head
      buckets.set(hash, index)
      const inv = paint.inverse
      const params = paint.params
      const paintStops = paint.stops
      const stopLen = paintStops.length
      paints[paintWords] = paint.kind | (paint.extend << 4)
      paints[paintWords + 1] = stops.length >>> 1
      paints[paintWords + 2] = stopLen
      paints[paintWords + 3] = colorBits(paint.color)
      if (paint.kind === 2) {
        const g0 = params[0]!,
          g1 = params[1]!,
          g2 = params[2]!
        paints[paintWords + 10] = floatBits(inv[0] * g0 + inv[1] * g1)
        paints[paintWords + 11] = floatBits(inv[2] * g0 + inv[3] * g1)
        paints[paintWords + 12] = floatBits(inv[4] * g0 + inv[5] * g1 + g2)
      } else if (paint.kind >= 3) {
        paints[paintWords + 4] = floatBits(inv[0])
        paints[paintWords + 5] = floatBits(inv[1])
        paints[paintWords + 6] = floatBits(inv[2])
        paints[paintWords + 7] = floatBits(inv[3])
        paints[paintWords + 8] = floatBits(inv[4] - params[0]!)
        paints[paintWords + 9] = floatBits(inv[5] - params[1]!)
        if (paint.kind === 3) {
          paints[paintWords + 12] = floatBits(params[2]!)
          paints[paintWords + 13] = floatBits(params[3]!)
          paints[paintWords + 14] = floatBits(params[4]!)
          paints[paintWords + 15] = floatBits(params[5]!)
        } else {
          const scale = params[3]!
          paints[paintWords + 12] = floatBits(params[2]! * scale)
          paints[paintWords + 13] = floatBits(Math.PI * 2 * scale)
        }
      }
      paintWords += 16
      for (let i = 0; i < stopLen; i++) {
        const stop = paintStops[i]!
        stops.push(floatBits(stop.offset), colorBits(stop.color))
      }
    }
    indices[paintIdx] = index
  }
  return {
    paints: paintWords === paints.length ? paints : paints.slice(0, paintWords),
    stops: new Uint32Array(stops),
    indices,
  }
}
