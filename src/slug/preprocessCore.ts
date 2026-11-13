import type { GlyphRequest, WindfoilBoundingBox, WindfoilGlyphOutline } from '../types.js'
import {
  readBox,
  readFiniteFloat32,
  readFlatNumbers,
  splitQuadraticIntoMonotonePieces,
  type WindfoilGlyphHeader,
  type WindfoilGlyphSource,
  type WindfoilLayerHeader,
  type WindfoilPreprocessOptions,
  type WindfoilPreprocessResult,
  type WindfoilPreprocessStats,
} from '../windfoil/preprocessCore.js'

export const SLUG_ROW_STRIDE = 1
export const SLUG_TARGET_PIECES_PER_BAND = 2
export const SLUG_MAX_BANDS = 32

export type SlugGlyphSource = WindfoilGlyphSource
export type SlugGlyphHeader = WindfoilGlyphHeader
export type SlugLayerHeader = WindfoilLayerHeader
export type SlugPreprocessStats = WindfoilPreprocessStats
export type SlugPreprocessResult = WindfoilPreprocessResult
export type SlugPreprocessOptions = Omit<WindfoilPreprocessOptions, 'orientLayers'>

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Slug preprocessing was aborted', 'AbortError')
  }
}

function chooseBandCount(pieceCount: number, targetPiecesPerBand: number): number {
  if (pieceCount <= targetPiecesPerBand) return 1
  return Math.min(Math.ceil(pieceCount / targetPiecesPerBand), SLUG_MAX_BANDS)
}

function bandIndex(coord: number, origin: number, invSpan: number, bandCount: number): number {
  if (invSpan <= 0) return 0
  return Math.min(Math.max(Math.floor((coord - origin) * invSpan), 0), bandCount - 1)
}

function extremumParameter(start: number, control: number, end: number): number | undefined {
  const secondDifference = start - 2 * control + end
  if (Math.abs(secondDifference) <= 1e-7) return undefined
  const parameter = (start - control) / secondDifference
  return parameter > 1e-4 && parameter < 1 - 1e-4 ? parameter : undefined
}

let scratchPieces = new Float64Array(1024)

function pushSubdividedQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number,
  output: Float64Array,
  at: number,
): number {
  const x01 = x0 + (cx - x0) * t
  const y01 = y0 + (cy - y0) * t
  const x12 = cx + (x1 - cx) * t
  const y12 = cy + (y1 - cy) * t
  const xMid = x01 + (x12 - x01) * t
  const yMid = y01 + (y12 - y01) * t
  output[at] = x0
  output[at + 1] = y0
  output[at + 2] = x01
  output[at + 3] = y01
  output[at + 4] = xMid
  output[at + 5] = yMid
  output[at + 6] = xMid
  output[at + 7] = yMid
  output[at + 8] = x12
  output[at + 9] = y12
  output[at + 10] = x1
  output[at + 11] = y1
  return at + 12
}

function splitOutline(quadratics: ArrayLike<number>, signal: AbortSignal | undefined): number {
  const quadLen = quadratics.length
  const maxOut = quadLen * 3
  if (scratchPieces.length < maxOut) {
    let size = scratchPieces.length
    while (size < maxOut) size *= 2
    scratchPieces = new Float64Array(size)
  }
  const output = scratchPieces
  let at = 0
  for (let offset = 0; offset < quadLen; offset += 6) {
    if (offset % 1536 === 0) throwIfAborted(signal)
    const x0 = quadratics[offset]!,
      y0 = quadratics[offset + 1]!,
      controlX = quadratics[offset + 2]!,
      controlY = quadratics[offset + 3]!,
      x1 = quadratics[offset + 4]!,
      y1 = quadratics[offset + 5]!
    if (
      controlX >= (x0 < x1 ? x0 : x1) &&
      controlX <= (x0 > x1 ? x0 : x1) &&
      controlY >= (y0 < y1 ? y0 : y1) &&
      controlY <= (y0 > y1 ? y0 : y1)
    ) {
      output[at] = x0
      output[at + 1] = y0
      output[at + 2] = controlX
      output[at + 3] = controlY
      output[at + 4] = x1
      output[at + 5] = y1
      at += 6
      continue
    }
    const xExtremum = extremumParameter(x0, controlX, x1)
    const yExtremum = extremumParameter(y0, controlY, y1)
    if (xExtremum === undefined && yExtremum === undefined) {
      output[at] = x0
      output[at + 1] = y0
      output[at + 2] = controlX
      output[at + 3] = controlY
      output[at + 4] = x1
      output[at + 5] = y1
      at += 6
      continue
    }
    const first =
      xExtremum === undefined
        ? yExtremum!
        : yExtremum === undefined
          ? xExtremum
          : Math.min(xExtremum, yExtremum)
    if (xExtremum === undefined || yExtremum === undefined || xExtremum === yExtremum) {
      at = pushSubdividedQuadratic(x0, y0, controlX, controlY, x1, y1, first, output, at)
      continue
    }
    const parameter = (Math.max(xExtremum, yExtremum) - first) / (1 - first)
    if (!(parameter > 0 && parameter < 1)) {
      at = pushSubdividedQuadratic(x0, y0, controlX, controlY, x1, y1, first, output, at)
      continue
    }
    const x01 = x0 + (controlX - x0) * first
    const y01 = y0 + (controlY - y0) * first
    const x12 = controlX + (x1 - controlX) * first
    const y12 = controlY + (y1 - controlY) * first
    const xMid = x01 + (x12 - x01) * first
    const yMid = y01 + (y12 - y01) * first
    output[at] = x0
    output[at + 1] = y0
    output[at + 2] = x01
    output[at + 3] = y01
    output[at + 4] = xMid
    output[at + 5] = yMid
    at = pushSubdividedQuadratic(xMid, yMid, x12, y12, x1, y1, parameter, output, at + 6)
  }
  return at
}

let bucketCapacity = 256
let hBucketData = new Int32Array(SLUG_MAX_BANDS * bucketCapacity)
let vBucketData = new Int32Array(SLUG_MAX_BANDS * bucketCapacity)
const hBucketCounts = new Int32Array(SLUG_MAX_BANDS)
const vBucketCounts = new Int32Array(SLUG_MAX_BANDS)
let xMinScratch = new Float32Array(256)
let xMaxScratch = new Float32Array(256)
let yMinScratch = new Float32Array(256)
let yMaxScratch = new Float32Array(256)
let spanFlagsScratch = new Uint8Array(256)
let bandClippedScratch = new Float32Array(256 * 6)
let bandRayMaxScratch = new Float32Array(256)
let descOrder = new Int32Array(256)
let scratchCurves = new Float32Array(1024)
let scratchRows = new Uint32Array(256)

interface PackedSlugBuffers {
  curveLen: number
  rowLen: number
}

function ensureSlugCurveCapacity(required: number, currentLen: number): Float32Array {
  if (required <= scratchCurves.length) return scratchCurves
  const next = new Float32Array(Math.max(scratchCurves.length * 2, required, 1024))
  if (currentLen > 0) next.set(scratchCurves.subarray(0, currentLen))
  scratchCurves = next
  return next
}

function ensureSlugRowCapacity(required: number, currentLen: number): Uint32Array {
  if (required <= scratchRows.length) return scratchRows
  const next = new Uint32Array(Math.max(scratchRows.length * 2, required, 256))
  if (currentLen > 0) next.set(scratchRows.subarray(0, currentLen))
  scratchRows = next
  return next
}

function solveMonotoneT(v0: number, vc: number, v1: number, target: number): number {
  const b = v0 - vc
  const a = b - (vc - v1)
  if (Math.abs(a) <= 1e-7) {
    const dv = v1 - v0
    return dv !== 0 ? Math.min(Math.max((target - v0) / dv, 0), 1) : 0
  }
  const c = v0 - target
  const d = Math.sqrt(Math.max(b * b - a * c, 0))
  const q = v0 < v1 ? b - d : b + d
  return Math.abs(q) > 1e-12 ? Math.min(Math.max(c / q, 0), 1) : 0
}

function packBandRow(
  curveStart: number,
  count: number,
  bandUMin: number,
  bandUMax: number,
  uMinGlyph: number,
  uMaxGlyph: number,
  uInvSpan: number,
): number {
  const safeCount = count > 63 ? 63 : count
  if (safeCount === 0 || uInvSpan <= 0) return (curveStart << 12) | safeCount
  const qMin = Math.max(0, Math.min(15, Math.floor((bandUMin - uMinGlyph) * uInvSpan * 16 - 1e-3)))
  const qMax = Math.max(0, Math.min(3, Math.floor((uMaxGlyph - bandUMax) * uInvSpan * 4 - 1e-3)))
  return (curveStart << 12) | (qMax << 10) | (qMin << 6) | safeCount
}

function emitDirectionalBands(
  pieces: Float64Array,
  bucketData: Int32Array,
  bucketCounts: Int32Array,
  bucketStride: number,
  bandCount: number,
  bandOrigin: number,
  bandStep: number,
  epsOrtho: number,
  uMinGlyph: number,
  uMaxGlyph: number,
  uInvSpan: number,
  rotated: boolean,
  packed: PackedSlugBuffers,
): number {
  let bandedPieces = 0
  const rows = ensureSlugRowCapacity(packed.rowLen + bandCount, packed.rowLen)
  for (let band = 0; band < bandCount; band++) {
    const count = bucketCounts[band]!
    const curveStart = packed.curveLen >>> 1
    if (count === 0) {
      rows[packed.rowLen++] = curveStart << 12
      continue
    }
    if (bandRayMaxScratch.length < count) {
      let size = bandRayMaxScratch.length
      while (size < count) size *= 2
      bandRayMaxScratch = new Float32Array(size)
      bandClippedScratch = new Float32Array(size * 6)
      descOrder = new Int32Array(size)
    }
    const vLo = bandOrigin + band * bandStep - epsOrtho
    const vHi = bandOrigin + (band + 1) * bandStep + epsOrtho
    const bucketBase = band * bucketStride
    let bandUMin = Infinity

    for (let i = 0; i < count; i++) {
      const pieceIdx = bucketData[bucketBase + i]!
      const offset = pieceIdx * 6
      // Transform into the ray's frame: (u, v) = (x, y) for H-bands, (y, -x) for V-bands.
      const u0 = rotated ? pieces[offset + 1]! : pieces[offset]!
      const v0 = rotated ? -pieces[offset]! : pieces[offset + 1]!
      const uc = rotated ? pieces[offset + 3]! : pieces[offset + 2]!
      const vc = rotated ? -pieces[offset + 2]! : pieces[offset + 3]!
      const u1 = rotated ? pieces[offset + 5]! : pieces[offset + 4]!
      const v1 = rotated ? -pieces[offset + 4]! : pieces[offset + 5]!

      let q0u = u0,
        q0v = v0,
        q1u = uc,
        q1v = vc,
        q2u = u1,
        q2v = v1

      if (bandCount > 1 && bandStep > 0 && !(u0 === u1 && u0 === uc)) {
        const rising = v0 < v1
        const ta = rising
          ? v0 < vLo
            ? solveMonotoneT(v0, vc, v1, vLo)
            : 0
          : v0 > vHi
            ? solveMonotoneT(v0, vc, v1, vHi)
            : 0
        const tb = rising
          ? v1 > vHi
            ? solveMonotoneT(v0, vc, v1, vHi)
            : 1
          : v1 < vLo
            ? solveMonotoneT(v0, vc, v1, vLo)
            : 1
        if ((ta > 0 || tb < 1) && tb > ta) {
          const ua = 1 - ta
          const ub = 1 - tb
          q0u = ua * ua * u0 + 2 * ua * ta * uc + ta * ta * u1
          q0v = ta === 0 ? v0 : rising ? vLo : vHi
          q2u = ub * ub * u0 + 2 * ub * tb * uc + tb * tb * u1
          q2v = tb === 1 ? v1 : rising ? vHi : vLo
          q1u = ua * ub * u0 + (ua * tb + ta * ub) * uc + ta * tb * u1
          q1v = ua * ub * v0 + (ua * tb + ta * ub) * vc + ta * tb * v1
        }
      }

      const pieceUMin = q0u < q2u ? q0u : q2u
      const pieceUMax = q0u > q2u ? q0u : q2u
      const pieceVMin = q0v < q2v ? q0v : q2v
      const pieceVMax = q0v > q2v ? q0v : q2v
      if (q1u < pieceUMin) q1u = pieceUMin
      else if (q1u > pieceUMax) q1u = pieceUMax
      if (q1v < pieceVMin) q1v = pieceVMin
      else if (q1v > pieceVMax) q1v = pieceVMax
      if (pieceUMin < bandUMin) bandUMin = pieceUMin

      if (count === 1) {
        const curves = ensureSlugCurveCapacity(packed.curveLen + 6, packed.curveLen)
        const w = packed.curveLen
        curves[w] = q0u
        curves[w + 1] = q0v
        curves[w + 2] = q2u
        curves[w + 3] = q2v
        curves[w + 4] = q1u
        curves[w + 5] = q1v
        packed.curveLen = w + 6
        rows[packed.rowLen++] = packBandRow(
          curveStart,
          1,
          bandUMin,
          pieceUMax,
          uMinGlyph,
          uMaxGlyph,
          uInvSpan,
        )
        bandedPieces += 1
        break
      }

      const outOffset = i * 6
      // Scratch stores [p1.u, p1.v, p3.u, p3.v, p2.u, p2.v] before SoA band emission.
      bandClippedScratch[outOffset] = q0u
      bandClippedScratch[outOffset + 1] = q0v
      bandClippedScratch[outOffset + 2] = q2u
      bandClippedScratch[outOffset + 3] = q2v
      bandClippedScratch[outOffset + 4] = q1u
      bandClippedScratch[outOffset + 5] = q1v
      bandRayMaxScratch[i] = pieceUMax
      descOrder[i] = i
    }
    if (count === 1) continue

    if (count === 2) {
      const curves = ensureSlugCurveCapacity(packed.curveLen + 12, packed.curveLen)
      const w = packed.curveLen
      const r0 = bandRayMaxScratch[0]!
      const r1 = bandRayMaxScratch[1]!
      const firstOff = r0 >= r1 ? 0 : 6
      const secondOff = 6 - firstOff
      curves[w] = bandClippedScratch[firstOff]!
      curves[w + 1] = bandClippedScratch[firstOff + 1]!
      curves[w + 2] = bandClippedScratch[firstOff + 2]!
      curves[w + 3] = bandClippedScratch[firstOff + 3]!
      curves[w + 4] = bandClippedScratch[secondOff]!
      curves[w + 5] = bandClippedScratch[secondOff + 1]!
      curves[w + 6] = bandClippedScratch[secondOff + 2]!
      curves[w + 7] = bandClippedScratch[secondOff + 3]!
      curves[w + 8] = bandClippedScratch[firstOff + 4]!
      curves[w + 9] = bandClippedScratch[firstOff + 5]!
      curves[w + 10] = bandClippedScratch[secondOff + 4]!
      curves[w + 11] = bandClippedScratch[secondOff + 5]!
      packed.curveLen = w + 12
      rows[packed.rowLen++] = packBandRow(
        curveStart,
        2,
        bandUMin,
        r0 >= r1 ? r0 : r1,
        uMinGlyph,
        uMaxGlyph,
        uInvSpan,
      )
      bandedPieces += 2
      continue
    }

    for (let i = 1; i < count; i++) {
      const idx = descOrder[i]!
      const key = bandRayMaxScratch[i]!
      let j = i - 1
      while (j >= 0 && bandRayMaxScratch[j]! < key) {
        bandRayMaxScratch[j + 1] = bandRayMaxScratch[j]!
        descOrder[j + 1] = descOrder[j]!
        j--
      }
      bandRayMaxScratch[j + 1] = key
      descOrder[j + 1] = idx
    }

    const emitCount = count > 63 ? 63 : count
    // Emit all endpoint pairs [p1_i, p3_i] contiguously first, then middle controls [p2_i].
    const curves = ensureSlugCurveCapacity(packed.curveLen + emitCount * 6, packed.curveLen)
    let curveWrite = packed.curveLen
    for (let i = 0; i < emitCount; i++) {
      const outOffset = descOrder[i]! * 6
      curves[curveWrite] = bandClippedScratch[outOffset]!
      curves[curveWrite + 1] = bandClippedScratch[outOffset + 1]!
      curves[curveWrite + 2] = bandClippedScratch[outOffset + 2]!
      curves[curveWrite + 3] = bandClippedScratch[outOffset + 3]!
      curveWrite += 4
    }
    for (let i = 0; i < emitCount; i++) {
      const outOffset = descOrder[i]! * 6
      curves[curveWrite] = bandClippedScratch[outOffset + 4]!
      curves[curveWrite + 1] = bandClippedScratch[outOffset + 5]!
      curveWrite += 2
    }
    packed.curveLen = curveWrite
    rows[packed.rowLen++] = packBandRow(
      curveStart,
      emitCount,
      bandUMin,
      bandRayMaxScratch[0]!,
      uMinGlyph,
      uMaxGlyph,
      uInvSpan,
    )
    bandedPieces += emitCount
  }
  return bandedPieces
}

function buildSlugBands(
  quadratics: ArrayLike<number>,
  bbox: WindfoilBoundingBox,
  targetPiecesPerBand: number,
  packed: PackedSlugBuffers,
  signal?: AbortSignal,
): {
  rowBase: number
  bandCount: number
  bandH: number
  invH: number
  monotonePieceCount: number
  bandRows: number
  bandedPieces: number
} {
  const pieceLen = splitOutline(quadratics, signal)
  const pieces = scratchPieces
  const monotonePieceCount = pieceLen / 6
  const rowBase = packed.rowLen
  if (monotonePieceCount === 0) {
    const emptyRow = (packed.curveLen >>> 1) << 12
    const rows = ensureSlugRowCapacity(packed.rowLen + 2, packed.rowLen)
    rows[packed.rowLen++] = emptyRow
    rows[packed.rowLen++] = emptyRow
    return {
      rowBase,
      bandCount: 1 | (1 << 8),
      bandH: 0,
      invH: 0,
      monotonePieceCount: 0,
      bandRows: 2,
      bandedPieces: 0,
    }
  }
  if (xMinScratch.length < monotonePieceCount) {
    let size = xMinScratch.length
    while (size < monotonePieceCount) size *= 2
    xMinScratch = new Float32Array(size)
    xMaxScratch = new Float32Array(size)
    yMinScratch = new Float32Array(size)
    yMaxScratch = new Float32Array(size)
    spanFlagsScratch = new Uint8Array(size)
  }
  if (bucketCapacity < monotonePieceCount) {
    while (bucketCapacity < monotonePieceCount) bucketCapacity *= 2
    hBucketData = new Int32Array(SLUG_MAX_BANDS * bucketCapacity)
    vBucketData = new Int32Array(SLUG_MAX_BANDS * bucketCapacity)
  }

  let hActivePieces = 0
  let vActivePieces = 0
  for (let i = 0; i < monotonePieceCount; i++) {
    const offset = i * 6
    const x0 = pieces[offset]!,
      y0 = pieces[offset + 1]!,
      x1 = pieces[offset + 4]!,
      y1 = pieces[offset + 5]!
    xMinScratch[i] = x0 < x1 ? x0 : x1
    xMaxScratch[i] = x0 > x1 ? x0 : x1
    yMinScratch[i] = y0 < y1 ? y0 : y1
    yMaxScratch[i] = y0 > y1 ? y0 : y1
    const hActive = yMinScratch[i] !== yMaxScratch[i] ? 1 : 0
    const vActive = xMinScratch[i] !== xMaxScratch[i] ? 2 : 0
    spanFlagsScratch[i] = hActive | vActive
    hActivePieces += hActive
    vActivePieces += vActive >>> 1
  }

  const hBandCount = chooseBandCount(Math.max(hActivePieces, 1), targetPiecesPerBand)
  const vBandCount = chooseBandCount(Math.max(vActivePieces, 1), targetPiecesPerBand)
  const width = bbox[2] - bbox[0]
  const height = bbox[3] - bbox[1]
  const invSpanX = width > 0 ? 1 / width : 0
  const invSpanY = height > 0 ? 1 / height : 0
  const invW = vBandCount * invSpanX
  const invH = hBandCount * invSpanY
  const epsX = width > 0 ? width * 1e-4 : 0
  const epsY = height > 0 ? height * 1e-4 : 0

  hBucketCounts.fill(0, 0, hBandCount)
  vBucketCounts.fill(0, 0, vBandCount)

  const rotY0 = -bbox[2]
  const stride = bucketCapacity
  for (let i = 0; i < monotonePieceCount; i++) {
    const flags = spanFlagsScratch[i]!
    // Cull horizontal segments from horizontal bands (zero Y span never crosses a horizontal ray).
    if (flags & 1) {
      const firstH =
        hBandCount > 1 ? bandIndex(yMinScratch[i]! - epsY, bbox[1], invH, hBandCount) : 0
      const lastH =
        hBandCount > 1 ? bandIndex(yMaxScratch[i]! + epsY, bbox[1], invH, hBandCount) : 0
      for (let band = firstH; band <= lastH; band++) {
        const idx = hBucketCounts[band]!
        hBucketData[band * stride + idx] = i
        hBucketCounts[band] = idx + 1
      }
    }

    // Cull vertical segments from vertical bands (zero X span never crosses a vertical ray).
    if (flags & 2) {
      const firstV =
        vBandCount > 1 ? bandIndex(-xMaxScratch[i]! - epsX, rotY0, invW, vBandCount) : 0
      const lastV = vBandCount > 1 ? bandIndex(-xMinScratch[i]! + epsX, rotY0, invW, vBandCount) : 0
      for (let band = firstV; band <= lastV; band++) {
        const idx = vBucketCounts[band]!
        vBucketData[band * stride + idx] = i
        vBucketCounts[band] = idx + 1
      }
    }
  }

  const hBanded = emitDirectionalBands(
    pieces,
    hBucketData,
    hBucketCounts,
    stride,
    hBandCount,
    bbox[1],
    height > 0 ? height / hBandCount : 0,
    epsY,
    bbox[0],
    bbox[2],
    invSpanX,
    false,
    packed,
  )
  const vBanded = emitDirectionalBands(
    pieces,
    vBucketData,
    vBucketCounts,
    stride,
    vBandCount,
    rotY0,
    width > 0 ? width / vBandCount : 0,
    epsX,
    bbox[1],
    bbox[3],
    invSpanY,
    true,
    packed,
  )

  return {
    rowBase,
    bandCount: hBandCount | (vBandCount << 8),
    bandH: invW,
    invH,
    monotonePieceCount,
    bandRows: hBandCount + vBandCount,
    bandedPieces: hBanded + vBanded,
  }
}

interface NormalizedOutline {
  readonly unitsPerEm: number
  readonly ascent: number
  readonly descent: number
  readonly bbox: WindfoilBoundingBox
  readonly quadratics: ArrayLike<number>
  readonly layers?: ReturnType<NonNullable<SlugPreprocessOptions['normalizeLayers']>>
  readonly clipBox?: WindfoilBoundingBox
}

function readQuadraticsFast(value: unknown, label: string): ArrayLike<number> {
  if (value instanceof Float32Array) {
    let check = 0
    for (const v of value) {
      check += v - v
    }
    if (!Number.isNaN(check)) return value
  } else if (value instanceof Float64Array) {
    let check = 0
    for (const raw of value) {
      const v = Math.fround(raw)
      check += v - v
    }
    if (!Number.isNaN(check)) return value
  } else if (Array.isArray(value)) {
    const list = value as readonly unknown[]
    let valid = true
    for (const item of list) {
      if (typeof item !== 'number') {
        valid = false
        break
      }
      const f = Math.fround(item)
      if (f - f !== 0) {
        valid = false
        break
      }
    }
    if (valid) return list as readonly number[]
  }
  return readFlatNumbers(value, label)
}

function normalizeOutline(
  value: unknown,
  label: string,
  normalizeLayers?: SlugPreprocessOptions['normalizeLayers'],
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
  const quadratics = readQuadraticsFast(outline.quadratics, `${label}.quadratics`)
  if (quadratics.length % 6 !== 0) {
    throw new RangeError(`${label}.quadratics length must be a multiple of 6`)
  }
  const clipBox =
    outline.clipBox === undefined ? undefined : readBox(outline.clipBox, `${label}.clipBox`)
  if (outline.layers === undefined && clipBox === undefined) {
    return { unitsPerEm, ascent, descent, bbox, quadratics }
  }
  const flatQuadratics = Array.isArray(quadratics)
    ? (quadratics as readonly number[])
    : readFlatNumbers(outline.quadratics, `${label}.quadratics`)
  const layers = normalizeLayers?.(outline.layers ?? [], flatQuadratics, bbox, unitsPerEm, label)
  return {
    unitsPerEm,
    ascent,
    descent,
    bbox,
    quadratics: flatQuadratics,
    ...(layers ? { layers } : {}),
    ...(clipBox ? { clipBox } : {}),
  }
}

function equalValues(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>,
    keys = Object.keys(a).filter((key) => key !== 'paintLabel' && a[key] !== undefined),
    otherKeys = Object.keys(b).filter((key) => key !== 'paintLabel' && b[key] !== undefined)
  return keys.length === otherKeys.length && keys.every((key) => equalValues(a[key], b[key]))
}

function outlinesEqual(left: NormalizedOutline, right: NormalizedOutline): boolean {
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
  return equalValues(left.layers, right.layers) && equalValues(left.clipBox, right.clipBox)
}

export { splitQuadraticIntoMonotonePieces }
export type { GlyphRequest, WindfoilBoundingBox, WindfoilGlyphOutline }

/**
 * Splits outlines into monotone pieces and packs bidirectional horizontal + vertical Slug
 * bands with endpoint-first `[p1, p3, p2]` layout and orthogonal degenerate culling.
 */
export function preprocessSlugGlyphs(
  sources: readonly SlugGlyphSource[],
  options: SlugPreprocessOptions = {},
): SlugPreprocessResult {
  throwIfAborted(options.signal)
  if (!Array.isArray(sources)) {
    throw new TypeError('sources must be an array of SlugGlyphSource records')
  }
  const targetPiecesPerBand =
    options.targetPiecesPerBand === undefined
      ? SLUG_TARGET_PIECES_PER_BAND
      : readFiniteFloat32(options.targetPiecesPerBand, 'options.targetPiecesPerBand')
  if (!Number.isInteger(targetPiecesPerBand) || targetPiecesPerBand <= 0) {
    throw new RangeError('options.targetPiecesPerBand must be a positive integer')
  }

  const uniqueByKey = new Map<string, NormalizedOutline>()
  const uniqueRaw = new Map<string, unknown>()
  for (let index = 0; index < sources.length; index++) {
    throwIfAborted(options.signal)
    const raw = (sources as readonly unknown[])[index] as
      { readonly request?: unknown; readonly outline?: unknown } | null | undefined
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError(`sources[${index}] must be an object`)
    }
    if (typeof raw.request !== 'object' || raw.request === null) {
      throw new TypeError(`sources[${index}].request must be a GlyphRequest`)
    }
    const key = (raw.request as { readonly key?: unknown }).key
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError(`sources[${index}].request.key must be a non-empty string`)
    }
    if (raw.outline !== undefined && uniqueRaw.get(key) === raw.outline) {
      continue
    }
    const outline = normalizeOutline(
      raw.outline,
      `sources[${index}].outline`,
      options.normalizeLayers,
    )
    const existing = uniqueByKey.get(key)
    if (existing !== undefined) {
      if (!outlinesEqual(existing, outline)) {
        throw new Error(`Duplicate glyph key "${key}" has conflicting outlines`)
      }
      continue
    }
    uniqueByKey.set(key, outline)
    uniqueRaw.set(key, raw.outline)
  }

  const sortedKeys = [...uniqueByKey.keys()].sort()
  const packed: PackedSlugBuffers = { curveLen: 0, rowLen: 0 }
  const glyphs = new Map<string, SlugGlyphHeader>()
  let totalMonotonePieces = 0
  let totalBands = 0
  let totalBandedPieces = 0
  let totalPaintLayers = 0
  let layered = false

  for (const key of sortedKeys) {
    throwIfAborted(options.signal)
    const outline = uniqueByKey.get(key)!
    if (outline.layers !== undefined) {
      layered = true
      const layerHeaders: SlugLayerHeader[] = []
      let glyphPieces = 0
      for (const layer of outline.layers) {
        const built = buildSlugBands(
          layer.quadratics,
          layer.bbox,
          targetPiecesPerBand,
          packed,
          options.signal,
        )
        glyphPieces += built.monotonePieceCount
        totalMonotonePieces += built.monotonePieceCount
        totalBands += built.bandRows
        totalBandedPieces += built.bandedPieces
        totalPaintLayers++
        layerHeaders.push({
          rowBase: built.rowBase,
          bandCount: built.bandCount,
          bandH: built.bandH,
          invH: built.invH,
          bbox: layer.bbox,
          monotonePieceCount: built.monotonePieceCount,
          paintKind: layer.paintKind,
          rgba: layer.rgba,
          paint: layer.paint,
          paintLabel: layer.paintLabel,
        })
      }
      const first = layerHeaders[0]
      glyphs.set(key, {
        rowBase: first?.rowBase ?? packed.rowLen,
        bandCount: first ? 1 : 0,
        bandH: first?.bandH ?? 0,
        invH: first?.invH ?? 0,
        unitsPerEm: outline.unitsPerEm,
        ascent: outline.ascent,
        descent: outline.descent,
        bbox: outline.bbox,
        monotonePieceCount: glyphPieces,
        layers: layerHeaders,
        ...(outline.clipBox ? { clipBox: outline.clipBox } : {}),
      })
      continue
    }

    const built = buildSlugBands(
      outline.quadratics,
      outline.bbox,
      targetPiecesPerBand,
      packed,
      options.signal,
    )
    totalMonotonePieces += built.monotonePieceCount
    totalBands += built.bandRows
    totalBandedPieces += built.bandedPieces
    if (built.monotonePieceCount > 0) totalPaintLayers++
    glyphs.set(key, {
      rowBase: built.rowBase,
      bandCount: built.bandCount,
      bandH: built.bandH,
      invH: built.invH,
      unitsPerEm: outline.unitsPerEm,
      ascent: outline.ascent,
      descent: outline.descent,
      bbox: outline.bbox,
      monotonePieceCount: built.monotonePieceCount,
      ...(outline.clipBox ? { clipBox: outline.clipBox } : {}),
    })
  }

  return {
    layered,
    curves: scratchCurves.slice(0, packed.curveLen),
    rows: scratchRows.slice(0, packed.rowLen),
    glyphs,
    stats: {
      paintLayers: totalPaintLayers,
      uniqueGlyphs: sortedKeys.length,
      monotonePieces: totalMonotonePieces,
      bandCount: totalBands,
      bandedPieces: totalBandedPieces,
      duplication: totalMonotonePieces > 0 ? totalBandedPieces / totalMonotonePieces : 0,
    },
  }
}
