import type { normalizeLayers } from './layerNormalization.js'
import type {
  GlyphRequest,
  WindfoilBoundingBox,
  WindfoilGlyphOutline,
  WindfoilPaint,
  WindfoilQuadratic,
} from '../types.js'

export type { WindfoilBoundingBox, WindfoilGlyphOutline, WindfoilQuadratic } from '../types.js'

/**
 * CPU preprocessing for the horizontal-band acceleration structure described by
 * texel-org/windfoil. The geometry and banding behavior is based on the
 * Apache-2.0 reference at commit 46bb1f170938564b08e358c3be20dac1b4b9e7fb.
 */

export const WINDFOIL_ROW_STRIDE = 6
export const WINDFOIL_TARGET_PIECES_PER_BAND = 10
export const WINDFOIL_MAX_BANDS = 64
export const WINDFOIL_MAX_LAYERS = 1024

const FLOAT32_FAR = 3e38

export interface WindfoilGlyphSource {
  readonly request: GlyphRequest
  readonly outline: WindfoilGlyphOutline
}

export interface WindfoilLayerHeader {
  readonly rowBase: number
  readonly bandCount: number
  readonly bandH: number
  readonly invH: number
  readonly bbox: WindfoilBoundingBox
  readonly monotonePieceCount: number
  readonly paintKind: 0 | 1 | 2
  readonly rgba: readonly [number, number, number, number]
  readonly paint: WindfoilPaint
  readonly paintLabel: string
  /** Bands run along x: the stored pieces and band header have x and y swapped. */
  readonly transposed?: boolean
  paintIndex?: number
}

export interface WindfoilGlyphHeader {
  /** Index of the first row record, not the first u32. */
  readonly rowBase: number
  readonly bandCount: number
  readonly bandH: number
  readonly invH: number
  readonly unitsPerEm: number
  readonly ascent: number
  readonly descent: number
  readonly bbox: WindfoilBoundingBox
  readonly monotonePieceCount: number
  readonly layers?: readonly WindfoilLayerHeader[]
  readonly clipBox?: WindfoilBoundingBox
}

export interface WindfoilPreprocessStats {
  readonly paintLayers: number
  readonly uniqueGlyphs: number
  readonly monotonePieces: number
  readonly bandCount: number
  readonly bandedPieces: number
  readonly duplication: number
}

export interface WindfoilPreprocessResult {
  /**
   * Three vec2 values per band-duplicated monotone quadratic. From `curveStart`,
   * each band stores its `curveCount` pieces by descending x-maximum, then the
   * same pieces again by ascending x-minimum.
   */
  readonly layered: boolean
  readonly curves: Float32Array
  /** `[curveStart, curveCount, densityBits, xMinBits, xMaxBits, splitBits]` per band. */
  readonly rows: Uint32Array
  /** Glyph metadata keyed by `GlyphRequest.key`. */
  readonly glyphs: ReadonlyMap<string, WindfoilGlyphHeader>
  readonly stats: WindfoilPreprocessStats
}

export interface WindfoilPreprocessOptions {
  /** Target monotone-piece count before band overlap; defaults to `10`. */
  readonly targetPiecesPerBand?: number
  readonly signal?: AbortSignal
  readonly normalizeLayers?: typeof normalizeLayers
  /**
   * Layered outlines this returns true for are drawn only by the composite shader, which may
   * integrate a layer along x: such a layer is filed in vertical bands when that walks fewer
   * pieces (wide, short layers), and its header is marked `transposed`.
   */
  readonly orientLayers?: (outline: { readonly clipBox?: WindfoilBoundingBox }) => boolean
}

export interface NormalizedLayer {
  readonly bbox: WindfoilBoundingBox
  readonly quadratics: ArrayLike<number>
  readonly paint: WindfoilPaint
  readonly paintLabel: string
  readonly paintKind: 0 | 1 | 2
  readonly rgba: readonly [number, number, number, number]
}
interface NormalizedOutline {
  readonly unitsPerEm: number
  readonly ascent: number
  readonly descent: number
  readonly bbox: WindfoilBoundingBox
  readonly quadratics: ArrayLike<number>
  readonly layers?: readonly NormalizedLayer[]
  readonly clipBox?: WindfoilBoundingBox
}

interface NormalizedSource {
  readonly key: string
  readonly outline: NormalizedOutline
}

interface BandHeader {
  readonly rowBase: number
  readonly bandCount: number
  readonly bandH: number
  readonly invH: number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Windfoil preprocessing was aborted', 'AbortError')
  }
}

export function readFiniteFloat32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`)
  }
  if (!Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${label} must be representable as a finite float32`)
  }
  return value
}

export function readFlatNumbers(
  value: unknown,
  label: string,
  expectedLength?: number,
): readonly number[] {
  if (typeof value !== 'object' || value === null || !('length' in value)) {
    throw new TypeError(`${label} must be an array-like list of numbers`)
  }

  const length = (value as { readonly length: unknown }).length
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new RangeError(`${label}.length must be a non-negative safe integer`)
  }
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} numbers`)
  }

  const source = value as Readonly<Record<number, unknown>>
  const result = new Array<number>(length as number)
  for (let index = 0; index < result.length; index++) {
    const item = source[index]
    // Most outlines contain thousands of valid coordinates. Build the indexed
    // diagnostic only on failure, while retaining the shared validation errors.
    result[index] =
      typeof item === 'number' && Number.isFinite(item) && Number.isFinite(Math.fround(item))
        ? item
        : readFiniteFloat32(item, `${label}[${index}]`)
  }
  return result
}

export function readFlatCoordinates(value: unknown, label: string): ArrayLike<number> {
  if (value instanceof Float32Array) {
    for (let index = 0; index < value.length; index++) {
      if (!Number.isFinite(value[index])) {
        readFiniteFloat32(value[index], `${label}[${index}]`)
      }
    }
    return value
  }
  if (value instanceof Float64Array) {
    for (let index = 0; index < value.length; index++) {
      if (!Number.isFinite(Math.fround(value[index]!))) {
        readFiniteFloat32(value[index], `${label}[${index}]`)
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    const arr = value as readonly unknown[]
    const len = arr.length
    for (let index = 0; index < len; index++) {
      const item = arr[index]
      if (typeof item !== 'number' || !Number.isFinite(Math.fround(item))) {
        readFiniteFloat32(item, `${label}[${index}]`)
      }
    }
    return arr as readonly number[]
  }
  return readFlatNumbers(value, label)
}

export function readBox(value: unknown, label: string): WindfoilBoundingBox {
  const v =
    Array.isArray(value) &&
    value.length === 4 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    typeof value[3] === 'number' &&
    Number.isFinite(
      Math.fround(value[0]) + Math.fround(value[1]) + Math.fround(value[2]) + Math.fround(value[3]),
    )
      ? (value as readonly number[])
      : readFlatNumbers(value, label, 4)
  if (v[0]! > v[2]! || v[1]! > v[3]!)
    throw new RangeError(`${label} minima must not exceed its maxima`)
  return [v[0]!, v[1]!, v[2]!, v[3]!]
}

function normalizeOutline(
  value: unknown,
  label: string,
  normalizeLayers?: WindfoilPreprocessOptions['normalizeLayers'],
): NormalizedOutline {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${label} must be an object`)
  }
  const outline = value as {
    readonly unitsPerEm?: unknown
    readonly ascent?: unknown
    readonly descent?: unknown
    readonly bbox?: unknown
    readonly quadratics?: unknown
    readonly layers?: unknown
    readonly clipBox?: unknown
  }

  const unitsPerEm = readFiniteFloat32(outline.unitsPerEm, `${label}.unitsPerEm`)
  if (unitsPerEm <= 0) throw new RangeError(`${label}.unitsPerEm must be positive`)
  const ascent = readFiniteFloat32(outline.ascent, `${label}.ascent`)
  const descent = readFiniteFloat32(outline.descent, `${label}.descent`)
  const bbox = readBox(outline.bbox, `${label}.bbox`)

  const quadratics = readFlatCoordinates(outline.quadratics, `${label}.quadratics`)
  if (quadratics.length % 6 !== 0) {
    throw new RangeError(`${label}.quadratics length must be a multiple of 6`)
  }

  const clipBox =
    outline.clipBox === undefined ? undefined : readBox(outline.clipBox, `${label}.clipBox`)
  if (outline.layers === undefined && clipBox === undefined) {
    return { unitsPerEm, ascent, descent, bbox, quadratics }
  }
  const layers = normalizeLayers?.(outline.layers ?? [], quadratics, bbox, unitsPerEm, label)

  return {
    unitsPerEm,
    ascent,
    descent,
    bbox,
    quadratics,
    ...(layers ? { layers } : {}),
    ...(clipBox ? { clipBox } : {}),
  }
}

/** Runtime validation for data received from a font-outline provider. */
export function validateWindfoilGlyphOutline(
  outline: unknown,
  normalizeLayers?: WindfoilPreprocessOptions['normalizeLayers'],
): asserts outline is WindfoilGlyphOutline {
  normalizeOutline(outline, 'outline', normalizeLayers)
}

function normalizeSource(
  value: unknown,
  index: number,
  normalizeLayers?: WindfoilPreprocessOptions['normalizeLayers'],
): NormalizedSource {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`sources[${index}] must be an object`)
  }
  const source = value as { readonly request?: unknown; readonly outline?: unknown }
  if (typeof source.request !== 'object' || source.request === null) {
    throw new TypeError(`sources[${index}].request must be a GlyphRequest`)
  }
  const key = (source.request as { readonly key?: unknown }).key
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError(`sources[${index}].request.key must be a non-empty string`)
  }
  return {
    key,
    outline: normalizeOutline(source.outline, `sources[${index}].outline`, normalizeLayers),
  }
}

function equalValues(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (!equalValues(left[i], right[i])) return false
    }
    return true
  }
  if (Array.isArray(right)) return false
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>,
    keys = Object.keys(a).filter((key) => key !== 'paintLabel' && a[key] !== undefined),
    otherKeys = Object.keys(b).filter((key) => key !== 'paintLabel' && b[key] !== undefined)
  return keys.length === otherKeys.length && keys.every((key) => equalValues(a[key], b[key]))
}

function layersEqual(
  left: readonly NormalizedLayer[] | undefined,
  right: readonly NormalizedLayer[] | undefined,
): boolean {
  if (left === right) return true
  if (left?.length !== right?.length) return false
  if (!left || !right) return true
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!,
      b = right[i]!
    if (
      a.paintKind !== b.paintKind ||
      a.bbox[0] !== b.bbox[0] ||
      a.bbox[1] !== b.bbox[1] ||
      a.bbox[2] !== b.bbox[2] ||
      a.bbox[3] !== b.bbox[3] ||
      a.rgba[0] !== b.rgba[0] ||
      a.rgba[1] !== b.rgba[1] ||
      a.rgba[2] !== b.rgba[2] ||
      a.rgba[3] !== b.rgba[3] ||
      a.quadratics.length !== b.quadratics.length
    ) {
      return false
    }
    for (let j = 0; j < a.quadratics.length; j++) {
      if (a.quadratics[j] !== b.quadratics[j]) return false
    }
    if (!equalValues(a.paint, b.paint)) return false
  }
  return true
}

function outlinesEqual(left: NormalizedOutline, right: NormalizedOutline): boolean {
  if (left === right) return true
  if (
    left.unitsPerEm !== right.unitsPerEm ||
    left.ascent !== right.ascent ||
    left.descent !== right.descent
  ) {
    return false
  }
  for (let index = 0; index < left.bbox.length; index++) {
    if (left.bbox[index] !== right.bbox[index]) return false
  }
  if (left.quadratics.length !== right.quadratics.length) return false
  for (let index = 0; index < left.quadratics.length; index++) {
    if (left.quadratics[index] !== right.quadratics[index]) return false
  }
  return layersEqual(left.layers, right.layers) && equalValues(left.clipBox, right.clipBox)
}

function extremumParameter(start: number, control: number, end: number): number | undefined {
  const secondDifference = start - 2 * control + end
  if (secondDifference === 0) return undefined
  const parameter = (start - control) / secondDifference
  return parameter > 0 && parameter < 1 ? parameter : undefined
}

function subdivideQuadratic(
  quadratic: WindfoilQuadratic,
  parameter: number,
): readonly [WindfoilQuadratic, WindfoilQuadratic] {
  const interpolate = (start: number, end: number): number => start + (end - start) * parameter
  const x01 = interpolate(quadratic[0], quadratic[2])
  const y01 = interpolate(quadratic[1], quadratic[3])
  const x12 = interpolate(quadratic[2], quadratic[4])
  const y12 = interpolate(quadratic[3], quadratic[5])
  const xMid = interpolate(x01, x12)
  const yMid = interpolate(y01, y12)
  return [
    [quadratic[0], quadratic[1], x01, y01, xMid, yMid],
    [xMid, yMid, x12, y12, quadratic[4], quadratic[5]],
  ]
}

function splitValidatedQuadratic(quadratic: WindfoilQuadratic): readonly WindfoilQuadratic[] {
  const xExtremum = extremumParameter(quadratic[0], quadratic[2], quadratic[4])
  const yExtremum = extremumParameter(quadratic[1], quadratic[3], quadratic[5])
  if (xExtremum === undefined && yExtremum === undefined) return [quadratic]
  const first =
    xExtremum === undefined
      ? yExtremum!
      : yExtremum === undefined
        ? xExtremum
        : Math.min(xExtremum, yExtremum)
  const [left, remainder] = subdivideQuadratic(quadratic, first)
  if (xExtremum === undefined || yExtremum === undefined || xExtremum === yExtremum)
    return [left, remainder]
  const parameter = (Math.max(xExtremum, yExtremum) - first) / (1 - first)
  if (!(parameter > 0 && parameter < 1)) return [left, remainder]
  const [middle, right] = subdivideQuadratic(remainder, parameter)
  return [left, middle, right]
}

/** Splits one quadratic at each interior x/y extremum, producing one to three pieces. */
export function splitQuadraticIntoMonotonePieces(
  quadratic: ArrayLike<number>,
): readonly WindfoilQuadratic[] {
  const values = readFlatNumbers(quadratic, 'quadratic', 6)
  return splitValidatedQuadratic([
    values[0]!,
    values[1]!,
    values[2]!,
    values[3]!,
    values[4]!,
    values[5]!,
  ])
}

function writeSubdividedQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number,
  output: Float64Array,
  outIdx: number,
): number {
  const x01 = x0 + (cx - x0) * t
  const y01 = y0 + (cy - y0) * t
  const x12 = cx + (x1 - cx) * t
  const y12 = cy + (y1 - cy) * t
  const xMid = x01 + (x12 - x01) * t
  const yMid = y01 + (y12 - y01) * t
  output[outIdx] = x0
  output[outIdx + 1] = y0
  output[outIdx + 2] = x01
  output[outIdx + 3] = y01
  output[outIdx + 4] = xMid
  output[outIdx + 5] = yMid
  output[outIdx + 6] = xMid
  output[outIdx + 7] = yMid
  output[outIdx + 8] = x12
  output[outIdx + 9] = y12
  output[outIdx + 10] = x1
  output[outIdx + 11] = y1
  return outIdx + 12
}

let scratchPieces = new Float64Array(1024)

function splitOutline(quadratics: ArrayLike<number>, signal: AbortSignal | undefined): number {
  const quadLen = quadratics.length
  const maxFloats = quadLen * 3
  if (maxFloats > scratchPieces.length) {
    scratchPieces = new Float64Array(Math.max(scratchPieces.length * 2, maxFloats, 1024))
  }
  const output = scratchPieces
  let outLen = 0
  for (let offset = 0; offset < quadLen; offset += 6) {
    if ((offset & 1023) === 0 && offset % 1536 === 0) throwIfAborted(signal)
    const x0 = quadratics[offset]!,
      y0 = quadratics[offset + 1]!,
      controlX = quadratics[offset + 2]!,
      controlY = quadratics[offset + 3]!,
      x1 = quadratics[offset + 4]!,
      y1 = quadratics[offset + 5]!
    // A control point inside the endpoint interval makes that coordinate monotone.
    // Most font/SVG segments already satisfy both axes, so emit them without any
    // per-segment parameter, tuple or subdivision arrays during a cold build.
    if (
      controlX >= (x0 < x1 ? x0 : x1) &&
      controlX <= (x0 > x1 ? x0 : x1) &&
      controlY >= (y0 < y1 ? y0 : y1) &&
      controlY <= (y0 > y1 ? y0 : y1)
    ) {
      output[outLen] = x0
      output[outLen + 1] = y0
      output[outLen + 2] = controlX
      output[outLen + 3] = controlY
      output[outLen + 4] = x1
      output[outLen + 5] = y1
      outLen += 6
      continue
    }
    const xExtremum = extremumParameter(x0, controlX, x1)
    const yExtremum = extremumParameter(y0, controlY, y1)
    if (xExtremum === undefined && yExtremum === undefined) {
      output[outLen] = x0
      output[outLen + 1] = y0
      output[outLen + 2] = controlX
      output[outLen + 3] = controlY
      output[outLen + 4] = x1
      output[outLen + 5] = y1
      outLen += 6
      continue
    }
    const first =
      xExtremum === undefined
        ? yExtremum!
        : yExtremum === undefined
          ? xExtremum
          : Math.min(xExtremum, yExtremum)
    if (xExtremum === undefined || yExtremum === undefined || xExtremum === yExtremum) {
      outLen = writeSubdividedQuadratic(x0, y0, controlX, controlY, x1, y1, first, output, outLen)
      continue
    }
    const parameter = (Math.max(xExtremum, yExtremum) - first) / (1 - first)
    if (!(parameter > 0 && parameter < 1)) {
      outLen = writeSubdividedQuadratic(x0, y0, controlX, controlY, x1, y1, first, output, outLen)
      continue
    }
    const x01 = x0 + (controlX - x0) * first
    const y01 = y0 + (controlY - y0) * first
    const x12 = controlX + (x1 - controlX) * first
    const y12 = controlY + (y1 - controlY) * first
    const xMid = x01 + (x12 - x01) * first
    const yMid = y01 + (y12 - y01) * first
    output[outLen] = x0
    output[outLen + 1] = y0
    output[outLen + 2] = x01
    output[outLen + 3] = y01
    output[outLen + 4] = xMid
    output[outLen + 5] = yMid
    outLen = writeSubdividedQuadratic(xMid, yMid, x12, y12, x1, y1, parameter, output, outLen + 6)
  }
  return outLen
}

function chooseBandCount(pieceCount: number, targetPiecesPerBand: number): number {
  if (pieceCount <= targetPiecesPerBand) return 1
  return Math.min(Math.ceil(pieceCount / targetPiecesPerBand), WINDFOIL_MAX_BANDS)
}

function bandIndex(y: number, y0: number, invH: number, bandCount: number): number {
  if (invH <= 0) return 0
  return Math.min(Math.max(Math.floor((y - y0) * invH), 0), bandCount - 1)
}

function monotoneRoot(
  a: number,
  hy: number,
  start: number,
  end: number,
  value: number,
  rising: boolean,
): number {
  if (rising ? start >= value : start <= value) return 0
  if (rising ? end <= value : end >= value) return 1
  const c = start - value
  const disc = hy * hy - a * c
  const rootD = disc > 0 ? Math.sqrt(disc) : 0
  const den = hy + (rising ? rootD : -rootD)
  if (den === 0) return 0
  const root = -c / den
  return root <= 0 ? 0 : root >= 1 ? 1 : root
}

function bandWindingArea(
  pieces: Float64Array,
  bucket: readonly number[],
  xReference: number,
  bandMin: number,
  bandMax: number,
): number {
  let area = 0
  for (let i = 0, n = bucket.length; i < n; i++) {
    const offset = bucket[i]! * 6
    const y0 = pieces[offset + 1]!
    const y1 = pieces[offset + 5]!
    if (y0 === y1) continue
    const rising = y1 >= y0
    const yLo = rising ? y0 : y1
    const yHi = rising ? y1 : y0
    const overlapMin = bandMin > yLo ? bandMin : yLo
    const overlapMax = bandMax < yHi ? bandMax : yHi
    if (overlapMax <= overlapMin) continue

    const x0 = pieces[offset]!
    const controlX = pieces[offset + 2]!
    const controlY = pieces[offset + 3]!
    const x1 = pieces[offset + 4]!

    if (yLo >= bandMin && yHi <= bandMax) {
      area +=
        ((x0 + controlX + x1) / 3 - xReference) * (y1 - y0) +
        ((x1 - x0) * (y0 - 2 * controlY + y1)) / 6
      continue
    }

    const ay = y0 - 2 * controlY + y1
    const hy = controlY - y0
    const by = 2 * hy
    const ax = x0 - 2 * controlX + x1
    const bx = 2 * (controlX - x0)
    const cx = x0 - xReference
    const c3 = 0.5 * ax * ay
    const c2 = (ax * by + 2 * bx * ay) / 3
    const c1 = 0.5 * bx * by + cx * ay
    const c0 = cx * by

    const startParameter = (rising ? y0 >= bandMin : y0 <= bandMax)
      ? 0
      : monotoneRoot(ay, hy, y0, y1, rising ? overlapMin : overlapMax, rising)
    const endParameter = (rising ? y1 <= bandMax : y1 >= bandMin)
      ? 1
      : monotoneRoot(ay, hy, y0, y1, rising ? overlapMax : overlapMin, rising)
    if (endParameter <= startParameter) continue

    const endValue =
      endParameter === 1
        ? c3 + c2 + c1 + c0
        : ((c3 * endParameter + c2) * endParameter + c1) * endParameter * endParameter +
          c0 * endParameter
    const startValue =
      startParameter === 0
        ? 0
        : ((c3 * startParameter + c2) * startParameter + c1) * startParameter * startParameter +
          c0 * startParameter
    area += endValue - startValue
  }
  return area
}

const scratchF32 = new Float32Array(1)
const scratchU32 = new Uint32Array(scratchF32.buffer)

function float32Bits(value: number, label: string): number {
  scratchF32[0] = value
  if (!Number.isFinite(scratchF32[0])) {
    throw new RangeError(`${label} must be representable as a finite float32`)
  }
  return scratchU32[0]!
}

/**
 * The x at which as many band pieces start left of a fragment as end right of it.
 *
 * A fragment right of the split walks the band by descending x-maximum and stops
 * at the first piece wholly to its left; one left of it walks by ascending
 * x-minimum and stops at the first piece wholly to its right. Each walk then
 * visits at most the pieces on its own side. Because `byXMin` is ascending and
 * `byXMax` is descending, the median interval of their 2N bounds is found in
 * O(log N) steps and centered at its midpoint.
 */
function balancedSplit(
  byXMin: Int32Array,
  byXMax: Int32Array,
  count: number,
  pieceXMin: Float64Array,
  pieceXMax: Float64Array,
): number {
  if (count === 0) return 0
  let lo = 0
  let hi = count
  while (lo < hi) {
    const i = (lo + hi) >>> 1
    if (pieceXMax[byXMax[i]!]! > pieceXMin[byXMin[i]!]!) lo = i + 1
    else hi = i
  }
  const lower =
    lo === 0
      ? pieceXMax[byXMax[0]!]!
      : lo === count
        ? pieceXMin[byXMin[count - 1]!]!
        : Math.max(pieceXMin[byXMin[lo - 1]!]!, pieceXMax[byXMax[lo]!]!)
  const upper =
    lo === 0
      ? pieceXMin[byXMin[0]!]!
      : lo === count
        ? pieceXMax[byXMax[count - 1]!]!
        : Math.min(pieceXMin[byXMin[lo]!]!, pieceXMax[byXMax[lo - 1]!]!)
  return 0.5 * (lower + upper)
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} exceeds Uint32 storage`)
  }
}

let scratchPieceXMin = new Float64Array(256)
let scratchPieceXMax = new Float64Array(256)
let scratchPieceHasYSpan = new Uint8Array(256)
let scratchGather = new Int32Array(256)
let scratchByXMin = new Int32Array(256)
let scratchCurves = new Float32Array(0)
let scratchRows = new Uint32Array(0)
const scratchBuckets = Array.from({ length: WINDFOIL_MAX_BANDS }, () => [] as number[])

interface PackedBuffers {
  curveLen: number
  rowLen: number
}

function ensureCurveCapacity(required: number, currentLen: number): Float32Array {
  if (required <= scratchCurves.length) return scratchCurves
  const next = new Float32Array(Math.max(scratchCurves.length * 2, required, 1024))
  if (currentLen > 0) next.set(scratchCurves.subarray(0, currentLen))
  scratchCurves = next
  return next
}

function ensureRowCapacity(required: number, currentLen: number): Uint32Array {
  if (required <= scratchRows.length) return scratchRows
  const next = new Uint32Array(Math.max(scratchRows.length * 2, required, 256))
  if (currentLen > 0) next.set(scratchRows.subarray(0, currentLen))
  scratchRows = next
  return next
}

function fileBands(
  pieces: Float64Array,
  pieceCount: number,
  y0: number,
  y1: number,
  packed: PackedBuffers,
  targetPiecesPerBand: number,
  signal: AbortSignal | undefined,
): BandHeader {
  const bandCount = chooseBandCount(pieceCount, targetPiecesPerBand)
  const invH = bandCount > 1 && y1 > y0 ? bandCount / (y1 - y0) : 0
  const buckets = scratchBuckets
  for (let band = 0; band < bandCount; band++) buckets[band]!.length = 0
  if (pieceCount > scratchPieceXMin.length) {
    const cap = Math.max(scratchPieceXMin.length * 2, pieceCount)
    scratchPieceXMin = new Float64Array(cap)
    scratchPieceXMax = new Float64Array(cap)
    scratchPieceHasYSpan = new Uint8Array(cap)
    scratchGather = new Int32Array(cap)
    scratchByXMin = new Int32Array(cap)
  }
  const pieceXMin = scratchPieceXMin
  const pieceXMax = scratchPieceXMax
  const pieceHasYSpan = scratchPieceHasYSpan
  let xLeft = Number.POSITIVE_INFINITY

  for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex++) {
    if ((pieceIndex & 255) === 0) throwIfAborted(signal)
    const offset = pieceIndex * 6
    const py0 = pieces[offset + 1]!
    const py1 = pieces[offset + 3]!
    const py2 = pieces[offset + 5]!
    let yMin = py0 < py1 ? py0 : py1
    if (py2 < yMin) yMin = py2
    let yMax = py0 > py1 ? py0 : py1
    if (py2 > yMax) yMax = py2
    const firstBand = bandIndex(yMin, y0, invH, bandCount)
    const lastBand = bandIndex(yMax, y0, invH, bandCount)
    for (let band = firstBand; band <= lastBand; band++) buckets[band]!.push(pieceIndex)
    const fPy0 = Math.fround(py0)
    pieceHasYSpan[pieceIndex] = fPy0 !== Math.fround(py1) || fPy0 !== Math.fround(py2) ? 1 : 0
    const px0 = pieces[offset]!
    const px1 = pieces[offset + 2]!
    const px2 = pieces[offset + 4]!
    let xMin = px0 < px1 ? px0 : px1
    if (px2 < xMin) xMin = px2
    let xMax = px0 > px1 ? px0 : px1
    if (px2 > xMax) xMax = px2
    pieceXMin[pieceIndex] = xMin
    pieceXMax[pieceIndex] = xMax
    if (xMin < xLeft) xLeft = xMin
  }

  const rowBase = packed.rowLen / WINDFOIL_ROW_STRIDE
  assertUint32(rowBase, 'rowBase')
  const exactBandH = bandCount > 1 ? (y1 - y0) / bandCount : y1 - y0
  const roundedInvH = Math.fround(invH)
  if (!Number.isFinite(roundedInvH)) {
    throw new RangeError('inverse band height must be representable as a finite float32')
  }
  const bandH =
    bandCount > 1 && roundedInvH > 0 ? Math.fround(1 / roundedInvH) : Math.fround(exactBandH)
  if (!Number.isFinite(bandH)) {
    throw new RangeError('band height must be representable as a finite float32')
  }

  const gather = scratchGather
  const byXMin = scratchByXMin
  const rows = ensureRowCapacity(packed.rowLen + bandCount * WINDFOIL_ROW_STRIDE, packed.rowLen)

  for (let band = 0; band < bandCount; band++) {
    throwIfAborted(signal)
    const bucket = buckets[band]!
    const bucketLen = bucket.length
    for (let i = 1; i < bucketLen; i++) {
      const idx = bucket[i]!
      const key = pieceXMax[idx]!
      let j = i - 1
      while (j >= 0 && pieceXMax[bucket[j]!]! < key) {
        bucket[j + 1] = bucket[j]!
        j--
      }
      bucket[j + 1] = idx
    }
    let gatherLen = 0
    let xMin = FLOAT32_FAR
    let xMax = -FLOAT32_FAR
    for (let i = 0; i < bucketLen; i++) {
      const pieceIndex = bucket[i]!
      const pMin = pieceXMin[pieceIndex]!
      const pMax = pieceXMax[pieceIndex]!
      if (pMin < xMin) xMin = pMin
      if (pMax > xMax) xMax = pMax
      if (pieceHasYSpan[pieceIndex]) {
        gather[gatherLen] = pieceIndex
        byXMin[gatherLen] = pieceIndex
        gatherLen++
      }
    }
    for (let i = 1; i < gatherLen; i++) {
      const idx = byXMin[i]!
      const key = pieceXMin[idx]!
      let j = i - 1
      while (j >= 0 && pieceXMin[byXMin[j]!]! > key) {
        byXMin[j + 1] = byXMin[j]!
        j--
      }
      byXMin[j + 1] = idx
    }
    const curveStart = packed.curveLen / 6
    assertUint32(curveStart, 'curveStart')
    assertUint32(gatherLen, 'curveCount')
    const curves = ensureCurveCapacity(packed.curveLen + gatherLen * 12, packed.curveLen)
    let curveWrite = packed.curveLen
    // Both traversal orders of the same pieces. The shader integrates either
    // toward the pixel's left edge (descending xMax) or its right edge
    // (ascending xMin); over closed contours the two integrals are equal.
    for (let traversal = 0; traversal < 2; traversal++) {
      const list = traversal ? byXMin : gather
      for (let i = 0; i < gatherLen; i++) {
        const offset = list[i]! * 6
        curves[curveWrite] = pieces[offset]!
        curves[curveWrite + 1] = pieces[offset + 1]!
        curves[curveWrite + 2] = pieces[offset + 2]!
        curves[curveWrite + 3] = pieces[offset + 3]!
        curves[curveWrite + 4] = pieces[offset + 4]!
        curves[curveWrite + 5] = pieces[offset + 5]!
        curveWrite += 6
      }
    }
    packed.curveLen = curveWrite
    // The sorted indices already reference the cached bounds. Reading them directly
    // avoids two mapped scratch arrays and a traversal-pair array for every band.
    const split = balancedSplit(byXMin, gather, gatherLen, pieceXMin, pieceXMax)
    const area = pieceCount
      ? bandWindingArea(pieces, bucket, xLeft, y0 + band * exactBandH, y0 + (band + 1) * exactBandH)
      : 0
    const density = area / Math.max(bandH * (xMax - xMin), 1e-30)
    const rowWrite = packed.rowLen
    rows[rowWrite] = curveStart
    rows[rowWrite + 1] = gatherLen
    rows[rowWrite + 2] = float32Bits(density, 'band density')
    rows[rowWrite + 3] = float32Bits(xMin, 'band xMin')
    rows[rowWrite + 4] = float32Bits(xMax, 'band xMax')
    rows[rowWrite + 5] = float32Bits(split, 'band split')
    packed.rowLen = rowWrite + WINDFOIL_ROW_STRIDE
  }

  return { rowBase, bandCount, bandH, invH: roundedInvH }
}

function compareKeys(
  left: readonly [string, NormalizedOutline],
  right: readonly [string, NormalizedOutline],
): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
}

function shouldTransposeLayer(
  pieces: Float64Array,
  pieceFloats: number,
  bbox: WindfoilBoundingBox,
  monotonePieceCount: number,
  bands: number,
): boolean {
  const xLow = bbox[0],
    xHigh = bbox[2],
    xExtent = xHigh - xLow
  const yLow = bbox[1],
    yHigh = bbox[3],
    yExtent = yHigh - yLow
  if (!(xExtent > 0 && yExtent > 0)) return false
  let xSpan = 0
  let ySpan = 0
  for (let i = 0; i < pieceFloats; i += 6) {
    const x0 = pieces[i]!,
      y0 = pieces[i + 1]!,
      cx = pieces[i + 2]!,
      cy = pieces[i + 3]!,
      x1 = pieces[i + 4]!,
      y1 = pieces[i + 5]!
    if (
      x0 < xLow ||
      x0 > xHigh ||
      cx < xLow ||
      cx > xHigh ||
      x1 < xLow ||
      x1 > xHigh ||
      y0 < yLow ||
      y0 > yHigh ||
      cy < yLow ||
      cy > yHigh ||
      y1 < yLow ||
      y1 > yHigh
    ) {
      return false
    }
    xSpan += Math.abs(x1 - x0)
    ySpan += Math.abs(y1 - y0)
  }
  const walked0 = (monotonePieceCount + (bands * xSpan) / xExtent) / xExtent
  const walked1 = (monotonePieceCount + (bands * ySpan) / yExtent) / yExtent
  return walked0 < 0.8 * walked1
}

/**
 * Builds shared curve and row storage for the unique request keys in `sources`.
 * Conflicting outlines under one key reject instead of making sharing order-dependent.
 */
export function preprocessWindfoilGlyphs(
  sources: readonly WindfoilGlyphSource[],
  options: WindfoilPreprocessOptions = {},
): WindfoilPreprocessResult {
  throwIfAborted(options.signal)
  const targetPiecesPerBand = options.targetPiecesPerBand ?? WINDFOIL_TARGET_PIECES_PER_BAND
  if (!Number.isInteger(targetPiecesPerBand) || targetPiecesPerBand <= 0) {
    throw new RangeError('targetPiecesPerBand must be a positive integer')
  }

  const unique = new Map<string, NormalizedOutline>()
  const uniqueRaw = new Map<string, unknown>()
  for (let index = 0; index < sources.length; index++) {
    throwIfAborted(options.signal)
    const entry = sources[index] as
      | { readonly request?: { readonly key?: unknown }; readonly outline?: unknown }
      | null
      | undefined
    const rawKey = entry?.request?.key
    if (
      typeof rawKey === 'string' &&
      rawKey.length > 0 &&
      entry?.outline !== undefined &&
      uniqueRaw.get(rawKey) === entry.outline
    ) {
      continue
    }
    const source = normalizeSource(sources[index], index, options.normalizeLayers)
    const previous = unique.get(source.key)
    if (previous === undefined) {
      unique.set(source.key, source.outline)
      uniqueRaw.set(source.key, sources[index]!.outline)
    } else if (!outlinesEqual(previous, source.outline)) {
      throw new Error(`GlyphRequest key ${JSON.stringify(source.key)} has conflicting outlines`)
    }
  }

  const packed: PackedBuffers = { curveLen: 0, rowLen: 0 }
  const glyphs = new Map<string, WindfoilGlyphHeader>()
  let monotonePieces = 0
  let paintLayers = 0
  let layered = false
  try {
    const sortedGlyphs = [...unique.entries()].sort(compareKeys)
    for (const [key, outline] of sortedGlyphs) {
      throwIfAborted(options.signal)
      const layers: WindfoilLayerHeader[] = []
      const orient = outline.layers && options.orientLayers?.(outline)
      const inputs = outline.layers ?? [
        {
          quadratics: outline.quadratics,
          bbox: outline.bbox,
          paint: { type: 'foreground' } as const,
          paintKind: 0 as const,
          rgba: [0, 0, 0, 1] as const,
          paintLabel: 'paint',
        },
      ]
      for (const layer of inputs) {
        throwIfAborted(options.signal)
        if (
          outline.layers &&
          (!layer.quadratics.length || (layer.paintKind === 1 && layer.rgba[3] === 0))
        )
          continue
        const pieceFloats = splitOutline(layer.quadratics, options.signal)
        const monotonePieceCount = pieceFloats / 6
        if (outline.layers && monotonePieceCount === 0) continue
        monotonePieces += monotonePieceCount
        const pieces = scratchPieces
        // A pixel spans about `size / (extent / bands)` bands of about `(1 + span × bands /
        // extent) / bands` of the pieces each: pieces walked per unit of pixel size along an axis
        // (0: vertical bands). A degenerate extent yields NaN, which keeps rows. Bands clip ink
        // only along their own axis, so a box that cuts into the ink also keeps rows.
        const bands = chooseBandCount(monotonePieceCount, targetPiecesPerBand)
        const transposed =
          !!orient &&
          bands > 1 &&
          shouldTransposeLayer(pieces, pieceFloats, layer.bbox, monotonePieceCount, bands)
        if (transposed) {
          for (let i = 0; i < pieceFloats; i += 2) {
            const temp = pieces[i]!
            pieces[i] = pieces[i + 1]!
            pieces[i + 1] = temp
          }
        }
        const bandHeader = fileBands(
          pieces,
          monotonePieceCount,
          layer.bbox[transposed ? 0 : 1],
          layer.bbox[transposed ? 2 : 3],
          packed,
          targetPiecesPerBand,
          options.signal,
        )
        const layerHeader: WindfoilLayerHeader = transposed
          ? {
              rowBase: bandHeader.rowBase,
              bandCount: bandHeader.bandCount,
              bandH: bandHeader.bandH,
              invH: bandHeader.invH,
              transposed: true,
              bbox: layer.bbox,
              monotonePieceCount,
              paintKind: layer.paintKind,
              rgba: layer.rgba,
              paint: layer.paint,
              paintLabel: layer.paintLabel,
            }
          : {
              rowBase: bandHeader.rowBase,
              bandCount: bandHeader.bandCount,
              bandH: bandHeader.bandH,
              invH: bandHeader.invH,
              bbox: layer.bbox,
              monotonePieceCount,
              paintKind: layer.paintKind,
              rgba: layer.rgba,
              paint: layer.paint,
              paintLabel: layer.paintLabel,
            }
        layers.push(layerHeader)
      }
      const first = layers[0] ?? { rowBase: 0, bandCount: 0, bandH: 0, invH: 0 }
      let glyphPieces = 0
      for (const layer of layers) {
        if (layer.monotonePieceCount > 0) paintLayers++
        glyphPieces += layer.monotonePieceCount
        if (!layered && (layer.paintKind !== 0 || layer.rgba[3] !== 1)) layered = true
      }
      if (layers.length > 1) layered = true
      glyphs.set(key, {
        rowBase: first.rowBase,
        bandCount: first.bandCount,
        bandH: first.bandH,
        invH: first.invH,
        unitsPerEm: outline.unitsPerEm,
        ascent: outline.ascent,
        descent: outline.descent,
        bbox: outline.bbox,
        monotonePieceCount: glyphPieces,
        ...(outline.layers ? { layers } : {}),
        ...(outline.clipBox ? { clipBox: outline.clipBox } : {}),
      })
    }
    throwIfAborted(options.signal)

    // Band filing duplication only; each band's second traversal order is not counted.
    let bandedPieces = 0
    for (let row = 1; row < packed.rowLen; row += WINDFOIL_ROW_STRIDE) {
      bandedPieces += scratchRows[row]!
    }
    return {
      layered,
      curves: scratchCurves.slice(0, packed.curveLen),
      rows: scratchRows.slice(0, packed.rowLen),
      glyphs,
      stats: {
        paintLayers,
        uniqueGlyphs: glyphs.size,
        monotonePieces,
        bandCount: packed.rowLen / WINDFOIL_ROW_STRIDE,
        bandedPieces,
        duplication: monotonePieces > 0 ? bandedPieces / monotonePieces : 1,
      },
    }
  } finally {
    if (scratchPieces.length > 98304) {
      for (let i = 0; i < WINDFOIL_MAX_BANDS; i++) scratchBuckets[i]!.length = 0
      scratchPieces = new Float64Array(1024)
    }
    if (scratchCurves.length > 262144) scratchCurves = new Float32Array(0)
    if (scratchRows.length > 65536) scratchRows = new Uint32Array(0)
    if (scratchPieceXMin.length > 16384) {
      scratchPieceXMin = new Float64Array(256)
      scratchPieceXMax = new Float64Array(256)
      scratchPieceHasYSpan = new Uint8Array(256)
      scratchGather = new Int32Array(256)
      scratchByXMin = new Int32Array(256)
    }
  }
}

/** Shared keyed-outline preprocessing for the shapes API. */
export function preprocessWindfoilOutlines(
  sources: readonly { readonly key: string; readonly outline: WindfoilGlyphOutline }[],
  options: WindfoilPreprocessOptions = {},
): WindfoilPreprocessResult {
  return preprocessWindfoilGlyphs(
    sources.map((source) => ({
      request: { key: source.key } as GlyphRequest,
      outline: source.outline,
    })),
    options,
  )
}
