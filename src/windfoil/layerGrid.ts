import type { WindfoilCompositeHeader } from './compositeGeometry.js'
import { windfoilCompositeBox } from './compositeGeometry.js'
import { floatBits, type NormalizedPaint } from './paint.js'
import { throwIfAborted } from './storage.js'

/** Shader descent bound: the builder never splits a cell deeper than this. */
export const WINDFOIL_TREE_DEPTH = 12
/** List-entry flag: the layer covers the whole cell, so its coverage is exactly 1. */
export const WINDFOIL_SOLID = 0x8000_0000
/** Depth of the direct-index grid a pixel starts its descent from. */
const TOP = 4
/**
 * Index budget per glyph: split cells while partial layers × cell area (the root is 1) is at
 * least `minKey`, up to `maxNodes` nodes and about `maxWords` words of nodes and lists.
 * Artwork from the shapes API is indexed deeply; colour glyphs in text, many and usually
 * small on screen, get about the old fixed grid's depth.
 */
export interface WindfoilIndexTuning {
  readonly maxNodes?: number
  readonly minKey?: number
  readonly maxWords?: number
}
export const WINDFOIL_TEXT_INDEX: WindfoilIndexTuning = {
  maxNodes: 341,
  minKey: 4 ** -4,
  maxWords: 8192,
}
const MAX_NODES = 8192
const MIN_KEY = 4 ** -7
const MAX_WORDS = 2 ** 19

/**
 * A paint whose alpha is exactly 1 everywhere: colour passes read its 8-bit alpha and shadow
 * passes its unquantized maximum, so both must be 1. Foreground alpha is a runtime fill.
 */
export function windfoilPaintOpaque(paint: NormalizedPaint): boolean {
  const opaque = (color: readonly number[]): boolean => color[3] === 1
  return paint.kind === 0
    ? opaque(paint.color)
    : (paint.kind === 2 || paint.kind === 4) && paint.stops.every((stop) => opaque(stop.color))
}

const DEPTH_WEIGHT = new Float64Array(WINDFOIL_TREE_DEPTH + 1)
for (let d = 0; d <= WINDFOIL_TREE_DEPTH; d++) DEPTH_WEIGHT[d] = 4 ** -d

/** Parameter where a monotone quadratic reaches `value`, clamped to [0, 1]. */
function solve(p0: number, p1: number, p2: number, value: number): number {
  const a = p0 - 2 * p1 + p2,
    h = p1 - p0,
    c = p0 - value,
    disc = h * h - a * c,
    root = disc > 0 ? Math.sqrt(disc) : 0,
    den = h + (p2 >= p0 ? root : -root)
  if (den === 0) return 0
  const t = -c / den
  return t <= 0 ? 0 : t >= 1 ? 1 : t
}
const at = (p0: number, p1: number, p2: number, t: number): number => {
  const u = 1 - t
  return u * u * p0 + 2 * t * u * p1 + t * t * p2
}
// Field steps inside a strip: y, signed rise and side, in reused scratch storage.
let stepY = new Float64Array(64),
  stepD = new Int32Array(64)
function growSteps(count: number): void {
  const y2 = new Float64Array(count * 2),
    d2 = new Int32Array(count * 2)
  y2.set(stepY)
  d2.set(stepD)
  stepY = y2
  stepD = d2
}
function cancels(count: number): boolean {
  const sY = stepY
  if (count === 2) return sY[0] === sY[1]
  const sD = stepD
  for (let i = 0; i < count; i++) {
    const d = sD[i]!
    if (d === 0) continue
    const y = sY[i]!
    let sum = d
    for (let j = i + 1; j < count; j++) {
      if (sY[j] === y) {
        sum += sD[j]!
        sD[j] = 0
      }
    }
    if (sum !== 0) return false
  }
  return true
}
/** First index in `[lo, hi)` whose sorted value is at least `value`. */
function searchRange(sorted: Float64Array, lo: number, hi: number, value: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}
const HASH_BUCKETS = 4096
const HASH_MASK = HASH_BUCKETS - 1
const UNSET = 0x7fff_ffff
const EMPTY_F32 = new Float32Array(0)
const EMPTY_U32 = new Uint32Array(0)

let gridCurves: Float32Array = EMPTY_F32,
  gridRows: Uint32Array = EMPTY_U32,
  gridRowFloats: Float32Array = EMPTY_F32,
  gridOpaque: ArrayLike<number> = EMPTY_U32,
  gridTol = 0,
  gridEmptySlot = 0,
  gridNodeCount = 0,
  gridArenaUsed = 0,
  gridUsed = 0,
  gridTableLen = 0,
  gridInternCount = 0,
  gridBandGen = 0

let scratchBandLow = new Float64Array(64),
  scratchBandHeight = new Float64Array(64),
  poolPieceC = new Int32Array(0),
  poolPieceBounds = new Float64Array(0),
  poolPieceLow = new Float64Array(0),
  poolBandPrepared = new Int32Array(0),
  poolBandTallEnd = new Int32Array(0),
  poolBandActiveEnd = new Int32Array(0),
  poolBandTallest = new Float64Array(0),
  poolLayerSwap = new Uint8Array(0),
  poolLayerX0 = new Float64Array(0),
  poolLayerY0 = new Float64Array(0),
  poolLayerX1 = new Float64Array(0),
  poolLayerY1 = new Float64Array(0),
  poolLayerMaxSpan = new Float64Array(0),
  poolLayerBx0 = new Float64Array(0),
  poolLayerBy0 = new Float64Array(0),
  poolLayerBx1 = new Float64Array(0),
  poolLayerBy1Cap = new Float64Array(0),
  poolLayerRowBase = new Uint32Array(0),
  poolLayerBands = new Uint32Array(0),
  poolLayerBandH = new Float64Array(0),
  poolCellX = new Float64Array(0),
  poolCellY = new Float64Array(0),
  poolCellSide = new Float64Array(0),
  poolCellDepth = new Int32Array(0),
  poolCellKey = new Float64Array(0),
  poolCellKids = new Int32Array(0),
  poolCellFirst = new Int32Array(0),
  poolCellListStart = new Int32Array(0),
  poolCellListLen = new Int32Array(0),
  poolHeap = new Int32Array(0),
  poolOrder = new Int32Array(0),
  poolListArena = new Uint32Array(0),
  poolArenaInterned = new Int32Array(0),
  poolInternHash = new Int32Array(0),
  poolInternAt = new Int32Array(0),
  poolInternLen = new Int32Array(0),
  poolInternNext = new Int32Array(0),
  poolOut = new Uint32Array(4096)

const hashBucketGen = new Int32Array(HASH_BUCKETS),
  hashBucketHead = new Int32Array(HASH_BUCKETS)
let currentHashGen = 0

function ensureLayerPools(layerCount: number): void {
  if (poolLayerSwap.length >= layerCount) return
  const cap = Math.max(poolLayerSwap.length * 2, layerCount, 64)
  poolLayerSwap = new Uint8Array(cap)
  poolLayerX0 = new Float64Array(cap)
  poolLayerY0 = new Float64Array(cap)
  poolLayerX1 = new Float64Array(cap)
  poolLayerY1 = new Float64Array(cap)
  poolLayerMaxSpan = new Float64Array(cap)
  poolLayerBx0 = new Float64Array(cap)
  poolLayerBy0 = new Float64Array(cap)
  poolLayerBx1 = new Float64Array(cap)
  poolLayerBy1Cap = new Float64Array(cap)
  poolLayerRowBase = new Uint32Array(cap)
  poolLayerBands = new Uint32Array(cap)
  poolLayerBandH = new Float64Array(cap)
}

function ensureCellPools(maxCells: number): void {
  if (poolCellX.length >= maxCells) return
  const cap = Math.max(poolCellX.length * 2, maxCells)
  poolCellX = new Float64Array(cap)
  poolCellY = new Float64Array(cap)
  poolCellSide = new Float64Array(cap)
  poolCellDepth = new Int32Array(cap)
  poolCellKey = new Float64Array(cap)
  poolCellKids = new Int32Array(cap)
  poolCellFirst = new Int32Array(cap)
  poolCellListStart = new Int32Array(cap)
  poolCellListLen = new Int32Array(cap)
  poolHeap = new Int32Array(cap)
  poolOrder = new Int32Array(cap)
  poolInternHash = new Int32Array(cap + 1)
  poolInternAt = new Int32Array(cap + 1)
  poolInternLen = new Int32Array(cap + 1)
  poolInternNext = new Int32Array(cap + 1)
}

function reserveListArena(needed: number): void {
  if (poolListArena.length >= needed) return
  const cap = Math.max(poolListArena.length * 2, needed, 4096)
  const nextArena = new Uint32Array(cap)
  nextArena.set(poolListArena)
  poolListArena = nextArena
  const nextInterned = new Int32Array(cap)
  nextInterned.set(poolArenaInterned)
  poolArenaInterned = nextInterned
}

function reserveOut(needed: number, used: number): void {
  if (poolOut.length >= needed) return
  const grown = new Uint32Array(Math.max(poolOut.length * 2, needed, 4096))
  grown.set(poolOut.subarray(0, used))
  poolOut = grown
}

const SHELL_GAPS = [301, 132, 57, 23, 10, 4, 1]

function sortByLow(arr: Int32Array, start: number, end: number, keys: Float64Array): void {
  const count = end - start
  if (count <= 1) return
  if (count <= 24) {
    for (let i = start + 1; i < end; i++) {
      const keyIdx = arr[i]!,
        keyVal = keys[keyIdx]!
      let j = i - 1
      while (j >= start && keys[arr[j]!]! > keyVal) {
        arr[j + 1] = arr[j]!
        j--
      }
      arr[j + 1] = keyIdx
    }
    return
  }
  for (let g = 0; g < 7; g++) {
    const gap = SHELL_GAPS[g]!
    if (gap >= count) continue
    for (let i = start + gap; i < end; i++) {
      const keyIdx = arr[i]!,
        keyVal = keys[keyIdx]!
      let j = i - gap
      while (j >= start && keys[arr[j]!]! > keyVal) {
        arr[j + gap] = arr[j]!
        j -= gap
      }
      arr[j + gap] = keyIdx
    }
  }
}

function prepareBand(
  bandRecord: number,
  start: number,
  pieceCount: number,
  curves: Float32Array,
): void {
  if (pieceCount > scratchBandLow.length) {
    const capLen = Math.max(scratchBandLow.length * 2, pieceCount)
    scratchBandLow = new Float64Array(capLen)
    scratchBandHeight = new Float64Array(capLen)
  }
  const lowScratch = scratchBandLow,
    heightScratch = scratchBandHeight,
    cArr = poolPieceC,
    boundsArr = poolPieceBounds,
    shortLow = poolPieceLow
  let bottom = Infinity,
    top = -Infinity,
    activeCount = 0
  for (let k = 0; k < pieceCount; k++) {
    const c = (start + k) * 6,
      y0 = curves[c + 1]!,
      y1 = curves[c + 5]!,
      lo = y0 < y1 ? y0 : y1,
      hi = y0 < y1 ? y1 : y0,
      h = hi - lo
    lowScratch[k] = lo
    heightScratch[k] = h
    if (h !== 0) activeCount++
    if (lo < bottom) bottom = lo
    if (hi > top) top = hi
  }
  const cap = (top - bottom) / 16
  let tallLen = activeCount,
    shortCount = 0
  if (activeCount > 8) {
    tallLen = 0
    for (let k = 0; k < pieceCount; k++) {
      if (heightScratch[k]! > cap) tallLen++
    }
    shortCount = activeCount - tallLen
    if (shortCount <= 8) {
      tallLen = activeCount
      shortCount = 0
    }
  }
  const shortBase = start + tallLen,
    activeEnd = start + activeCount
  let ti = start,
    si = shortBase,
    tallest = 0
  if (shortCount === 0) {
    for (let k = 0; k < pieceCount; k++) {
      if (!heightScratch[k]) continue
      cArr[ti++] = k
    }
    sortByLow(cArr, start, activeEnd, lowScratch)
  } else {
    for (let k = 0; k < pieceCount; k++) {
      const h = heightScratch[k]!
      if (h === 0) continue
      if (h > cap) cArr[ti++] = k
      else {
        cArr[si++] = k
        if (h > tallest) tallest = h
      }
    }
    sortByLow(cArr, start, shortBase, lowScratch)
    sortByLow(cArr, shortBase, activeEnd, lowScratch)
  }
  for (let i = start; i < activeEnd; i++) {
    const k = cArr[i]!,
      c = (start + k) * 6,
      px0 = curves[c]!,
      py0 = curves[c + 1]!,
      px1 = curves[c + 2]!,
      px2 = curves[c + 4]!,
      py2 = curves[c + 5]!,
      up = py2 > py0,
      lo = up ? py0 : py2,
      i4 = i * 4
    cArr[i] = up ? c : ~c
    shortLow[i] = lo
    boundsArr[i4] = lo
    boundsArr[i4 + 1] = up ? py2 : py0
    let xl = px0 < px1 ? px0 : px1
    if (px2 < xl) xl = px2
    let xh = px0 > px1 ? px0 : px1
    if (px2 > xh) xh = px2
    boundsArr[i4 + 2] = xl
    boundsArr[i4 + 3] = xh
  }
  poolBandPrepared[bandRecord] = gridBandGen
  poolBandTallEnd[bandRecord] = shortBase
  poolBandActiveEnd[bandRecord] = activeEnd
  poolBandTallest[bandRecord] = tallest
}

function classifyLayer(
  layer: number,
  ey0: number,
  ex1: number,
  ey1: number,
  ex0Tol: number,
  ex1Tol: number,
  ey0Tol: number,
  ey1Tol: number,
): 0 | 1 | 2 {
  const bx0 = poolLayerBx0[layer]!,
    by0 = poolLayerBy0[layer]!,
    bx1 = poolLayerBx1[layer]!,
    by1Cap = poolLayerBy1Cap[layer]!
  if (ey1Tol < by0 || ey0Tol > by1Cap || ex1Tol < bx0 || ex0Tol > bx1) return 0
  const bands = poolLayerBands[layer]!,
    bandH = poolLayerBandH[layer]!,
    rowBase = poolLayerRowBase[layer]!,
    tol = gridTol,
    bandGen = gridBandGen,
    low = bands > 1 ? (ey0Tol <= by0 ? 0 : Math.min(bands, Math.floor((ey0Tol - by0) / bandH))) : 0,
    high =
      bands > 1
        ? ey1Tol >= by1Cap
          ? bands - 1
          : Math.min(bands - 1, Math.floor((ey1Tol - by0) / bandH))
        : 0,
    insideBox = bx0 < ex0Tol && bx1 > ex1Tol && by0 < ey0Tol && by1Cap > ey1Tol
  const cArr = poolPieceC,
    boundsArr = poolPieceBounds,
    shortLow = poolPieceLow,
    bandPrepared = poolBandPrepared,
    bandTallEnd = poolBandTallEnd,
    bandActiveEnd = poolBandActiveEnd,
    bandTallest = poolBandTallest,
    curves = gridCurves,
    rows = gridRows,
    rowFloats = gridRowFloats
  let winding = UNSET
  for (let band = low; band <= high; band++) {
    const s0 = bands > 1 ? Math.max(ey0, by0 + band * bandH - tol) : ey0,
      s1 = bands > 1 ? Math.min(ey1, by0 + (band + 1) * bandH + tol) : ey1
    if (s0 >= s1) continue
    const bandRecord = rowBase + band,
      record = bandRecord * 6
    if (rowFloats[record + 3]! > ex1Tol || rowFloats[record + 4]! < ex0Tol) {
      if (winding !== UNSET && winding !== 0) return 1
      winding = 0
      continue
    }
    const start = rows[record]!
    if (bandPrepared[bandRecord] !== bandGen) {
      prepareBand(bandRecord, start, rows[record + 1]!, curves)
    }
    const tallEnd = bandTallEnd[bandRecord]!,
      bandEnd = bandActiveEnd[bandRecord]!,
      hasShort = tallEnd < bandEnd,
      firstShort = hasShort
        ? searchRange(shortLow, tallEnd, bandEnd, s0 - bandTallest[bandRecord]!)
        : bandEnd,
      endShort = hasShort ? searchRange(shortLow, tallEnd, bandEnd, s1) : bandEnd,
      ranges = firstShort < endShort ? 2 : 1,
      maxSteps = (tallEnd - start + (endShort - firstShort)) << 1
    if (maxSteps > stepY.length) growSteps(maxSteps)
    const sY = stepY,
      sD = stepD
    let right = 0,
      left = 0,
      steps = 0,
      stepSum = 0
    for (let range = 0; range < ranges; range++) {
      const rStart = range === 0 ? start : firstShort,
        rEnd = range === 0 ? tallEnd : endShort
      for (let k = rStart; k < rEnd; k++) {
        const k4 = k * 4,
          yl = boundsArr[k4]!
        if (yl >= s1) break
        const yh = boundsArr[k4 + 1]!
        if (yh <= s0) continue
        const cs = cArr[k]!,
          sign = cs < 0 ? -1 : 1
        let xl = boundsArr[k4 + 2]!
        let onRight: number
        if (xl > ex1Tol) {
          onRight = 1
        } else {
          let xh = boundsArr[k4 + 3]!
          if (xh >= ex0Tol) {
            if (yl >= s0 && yh <= s1) return 1
            const c = cs < 0 ? ~cs : cs,
              px0 = curves[c]!,
              px2 = curves[c + 4]!
            let a: number
            if (yl >= s0) {
              a = sign > 0 ? px0 : px2
              if (a >= ex0Tol && a <= ex1Tol) return 1
              const b = at(
                px0,
                curves[c + 2]!,
                px2,
                solve(curves[c + 1]!, curves[c + 3]!, curves[c + 5]!, s1),
              )
              xl = a < b ? a : b
              xh = a < b ? b : a
              if (xh >= ex0Tol && xl <= ex1Tol) return 1
            } else if (yh <= s1) {
              const b = sign > 0 ? px2 : px0
              if (b >= ex0Tol && b <= ex1Tol) return 1
              a = at(
                px0,
                curves[c + 2]!,
                px2,
                solve(curves[c + 1]!, curves[c + 3]!, curves[c + 5]!, s0),
              )
              xl = a < b ? a : b
              xh = a < b ? b : a
              if (xh >= ex0Tol && xl <= ex1Tol) return 1
            } else {
              const px1 = curves[c + 2]!,
                py0 = curves[c + 1]!,
                py1 = curves[c + 3]!,
                py2 = curves[c + 5]!
              a = at(px0, px1, px2, solve(py0, py1, py2, s0))
              if (a >= ex0Tol && a <= ex1Tol) return 1
              const b = at(px0, px1, px2, solve(py0, py1, py2, s1))
              xl = a < b ? a : b
              xh = a < b ? b : a
              if (xh >= ex0Tol && xl <= ex1Tol) return 1
            }
            onRight = xl > ex1 ? 1 : 0
          } else {
            onRight = 0
          }
        }
        const stepWeight = onRight ? sign << 16 : sign
        if (yl > s0) {
          sY[steps] = yl
          sD[steps] = stepWeight
          steps++
          stepSum += stepWeight
        } else if (onRight) right += sign
        else left += sign
        if (yh < s1) {
          sY[steps] = yh
          sD[steps] = -stepWeight
          steps++
          stepSum -= stepWeight
        }
      }
    }
    if (right !== -left || (steps & 1) !== 0 || stepSum !== 0 || (steps !== 0 && !cancels(steps))) {
      return 1
    }
    if (right !== 0) {
      if (!insideBox || (winding !== UNSET && winding * right <= 0)) return 1
    } else if (winding !== UNSET && winding !== 0) {
      return 1
    }
    winding = right
  }
  if (winding === 0 || winding === UNSET) return 0
  return insideBox ? 2 : 1
}

function makeCell(
  x: number,
  y: number,
  size: number,
  depth: number,
  parentStart: number,
  parentLen: number,
): number {
  const nodeIdx = gridNodeCount++,
    arenaUsed = gridArenaUsed
  reserveListArena(arenaUsed + parentLen + 1)
  const listArena = poolListArena,
    layerSwap = poolLayerSwap,
    layerX0 = poolLayerX0,
    layerY0 = poolLayerY0,
    layerX1 = poolLayerX1,
    layerY1 = poolLayerY1,
    layerMaxSpan = poolLayerMaxSpan,
    opaque = gridOpaque,
    tol = gridTol,
    reach = size * 0.15625,
    spanSize = size + 2 * reach,
    cx0 = x - reach,
    cy0 = y - reach,
    cx1 = cx0 + spanSize,
    cy1 = cy0 + spanSize,
    cx0Tol = cx0 - tol,
    cy0Tol = cy0 - tol,
    cx1Tol = cx1 + tol,
    cy1Tol = cy1 + tol,
    widest = spanSize * 3.71
  let diff = false,
    outLen = 0,
    keyCount = 0
  for (let i = 0; i < parentLen; i++) {
    const entry = listArena[parentStart + i]!
    if (entry >= WINDFOIL_SOLID) {
      listArena[arenaUsed + outLen++] = entry
      continue
    }
    if (
      layerX0[entry]! > cx1 ||
      layerX1[entry]! < cx0 ||
      layerY0[entry]! > cy1 ||
      layerY1[entry]! < cy0
    ) {
      diff = true
      continue
    }
    if (widest >= layerMaxSpan[entry]!) {
      listArena[arenaUsed + outLen++] = entry
      keyCount++
      continue
    }
    const kind = layerSwap[entry]
      ? classifyLayer(entry, cx0, cy1, cx1, cy0Tol, cy1Tol, cx0Tol, cx1Tol)
      : classifyLayer(entry, cy0, cx1, cy1, cx0Tol, cx1Tol, cy0Tol, cy1Tol)
    if (!kind) {
      diff = true
      continue
    }
    if (kind === 1) {
      listArena[arenaUsed + outLen++] = entry
      keyCount++
    } else {
      diff = true
      listArena[arenaUsed + outLen++] = entry + WINDFOIL_SOLID
      if (opaque[entry]) {
        break
      }
    }
  }
  if (diff) {
    if (outLen === 0) {
      poolCellListStart[nodeIdx] = gridEmptySlot
      poolCellListLen[nodeIdx] = 0
    } else {
      poolCellListStart[nodeIdx] = arenaUsed
      poolCellListLen[nodeIdx] = outLen
      poolArenaInterned[arenaUsed] = -1
      gridArenaUsed = arenaUsed + outLen
    }
  } else {
    poolCellListStart[nodeIdx] = parentStart
    poolCellListLen[nodeIdx] = parentLen
  }
  poolCellX[nodeIdx] = x
  poolCellY[nodeIdx] = y
  poolCellSide[nodeIdx] = size
  poolCellDepth[nodeIdx] = depth
  poolCellKey[nodeIdx] = keyCount * DEPTH_WEIGHT[depth]!
  poolCellKids[nodeIdx] = -1
  poolCellFirst[nodeIdx] = -1
  return nodeIdx
}

function internList(listStart: number, listLen: number): number {
  const arenaInterned = poolArenaInterned,
    cached = arenaInterned[listStart]!
  if (cached >= 0) return cached
  const listArena = poolListArena,
    gen = currentHashGen,
    tableLen = gridTableLen,
    internHash = poolInternHash,
    internAt = poolInternAt,
    internLen = poolInternLen,
    internNext = poolInternNext
  let hash = listLen
  for (let i = 0; i < listLen; i++) {
    hash = Math.imul(hash ^ listArena[listStart + i]!, 0x01000193)
  }
  const bucket = hash & HASH_MASK
  const head = hashBucketGen[bucket] === gen ? hashBucketHead[bucket]! : -1
  const outArr = poolOut
  search: for (let id = head; id >= 0; id = internNext[id]!) {
    if (internHash[id] !== hash || internLen[id] !== listLen) continue
    const at = internAt[id]!,
      outBase = at - tableLen
    for (let i = 0; i < listLen; i++) {
      if (outArr[outBase + i] !== listArena[listStart + i]) continue search
    }
    arenaInterned[listStart] = at
    return at
  }
  const used = gridUsed,
    startAt = tableLen + used,
    id = gridInternCount++
  internHash[id] = hash
  internAt[id] = startAt
  internLen[id] = listLen
  internNext[id] = head
  hashBucketGen[bucket] = gen
  hashBucketHead[bucket] = id
  reserveOut(used + listLen, used)
  const dest = poolOut
  for (let i = 0; i < listLen; i++) {
    dest[used + i] = listArena[listStart + i]!
  }
  gridUsed = used + listLen
  arenaInterned[listStart] = startAt
  return startAt
}

/**
 * Appends a top-down layer index per composite glyph and stores its block's word offset in
 * word 11 of each of its layer rows. Block: `[kind, x0, y0, side, top, fullStart, fullEnd, grid]`,
 * then 3-word quadtree nodes `[firstChild, listStart, listEnd]` over the square from `(x0, y0)`
 * (children ordered x-then-y, 0 for a leaf), the `2^top`-square grid of the nodes at depth `top`
 * (or the leaves covering them), then the interned lists. A pixel descends while its footprint
 * lies within one eighth of a side of the child cell, starting at its top-grid cell when the
 * footprint fits there, and walks the deepest such cell's list, or every layer (`fullStart`)
 * when not even the root fits or `kind` is 0.
 *
 * Each list is classified exactly against the band pieces the shader integrates, over the cell
 * grown by 1.25 eighths: layers whose integral is 0 for every accepted footprint are dropped,
 * layers whose winding is nonzero and constant there carry `WINDFOIL_SOLID` (coverage 1), and
 * the list ends at the first solid layer whose paint is opaque, where the walk's opaque exit
 * would stop anyway. Anything else, including layers small enough for the ink-profile path,
 * stays for the full per-pixel test.
 */
export function appendWindfoilLayerGrids(
  table: Uint32Array,
  glyphs: Iterable<WindfoilCompositeHeader>,
  coverage: { readonly curves: Float32Array; readonly rows: Uint32Array },
  opaque: ArrayLike<number>,
  signal?: AbortSignal,
  tuning: WindfoilIndexTuning = {},
): Uint32Array {
  const floats = new Float32Array(table.buffer, table.byteOffset, table.length),
    { curves, rows } = coverage,
    rowFloats = new Float32Array(rows.buffer, rows.byteOffset, rows.length),
    totalLayers = Math.floor(table.length / 12)
  gridCurves = curves
  gridRows = rows
  gridRowFloats = rowFloats
  gridOpaque = opaque
  gridTableLen = table.length
  gridUsed = 0
  ensureLayerPools(totalLayers)
  const totalPieces = Math.ceil(curves.length / 6),
    totalBands = Math.ceil(rows.length / 6)
  if (poolPieceC.length < totalPieces) {
    const cap = Math.max(poolPieceC.length * 2, totalPieces)
    poolPieceC = new Int32Array(cap)
    poolPieceBounds = new Float64Array(cap * 4)
    poolPieceLow = new Float64Array(cap)
  }
  if (poolBandPrepared.length < totalBands) {
    const cap = Math.max(poolBandPrepared.length * 2, totalBands)
    poolBandPrepared = new Int32Array(cap)
    poolBandTallEnd = new Int32Array(cap)
    poolBandActiveEnd = new Int32Array(cap)
    poolBandTallest = new Float64Array(cap)
  }
  gridBandGen++
  const budget = tuning.maxNodes ?? MAX_NODES,
    minKey = tuning.minKey ?? MIN_KEY,
    maxWords = tuning.maxWords ?? MAX_WORDS
  ensureCellPools(budget + 8)
  const cellX = poolCellX,
    cellY = poolCellY,
    cellSide = poolCellSide,
    cellDepth = poolCellDepth,
    cellKey = poolCellKey,
    cellKids = poolCellKids,
    cellFirst = poolCellFirst,
    cellListStart = poolCellListStart,
    cellListLen = poolCellListLen,
    heap = poolHeap,
    order = poolOrder

  const tagRanges: number[] = []
  for (const header of glyphs) {
    const first = header.layerStart,
      count = header.layerCount
    if (!count) continue
    throwIfAborted(signal)
    for (let layer = first; layer < first + count; layer++) {
      const row = layer * 12,
        swap = (table[row + 9]! & 2) >> 1,
        lx0 = floats[row + 4]!,
        ly0 = floats[row + 5]!,
        lx1 = floats[row + 6]!,
        ly1 = floats[row + 7]!,
        bx0 = swap ? ly0 : lx0,
        by0 = swap ? lx0 : ly0,
        bx1 = swap ? ly1 : lx1,
        by1 = swap ? lx1 : ly1,
        bands = table[row + 1]!,
        bandH = floats[row + 2]!,
        dx = lx1 - lx0,
        dy = ly1 - ly0
      poolLayerSwap[layer] = swap
      poolLayerX0[layer] = lx0
      poolLayerY0[layer] = ly0
      poolLayerX1[layer] = lx1
      poolLayerY1[layer] = ly1
      poolLayerMaxSpan[layer] = dx > dy ? dx : dy
      poolLayerBx0[layer] = bx0
      poolLayerBy0[layer] = by0
      poolLayerBx1[layer] = bx1
      poolLayerBy1Cap[layer] = bands < 2 ? by1 : Math.min(by1, by0 + bands * bandH)
      poolLayerRowBase[layer] = table[row]!
      poolLayerBands[layer] = bands
      poolLayerBandH[layer] = bandH
    }
    const base = table.length + gridUsed,
      box = windfoilCompositeBox(header),
      x0 = Math.fround(box[0]),
      y0 = Math.fround(box[1]),
      side = Math.fround(Math.max(box[2] - box[0], box[3] - box[1]))
    reserveListArena(count + 2)
    for (let i = 0; i < count; i++) {
      poolListArena[i] = first + count - 1 - i
    }
    gridEmptySlot = count
    poolArenaInterned[0] = -1
    poolArenaInterned[count] = -1
    gridArenaUsed = count + 1
    // Classification tolerance and the deepest cell whose f32 bounds stay a quarter margin exact,
    // scaled by the largest coordinate a pixel or a piece of this glyph can have.
    const extent = Math.max(
      Math.abs(x0),
      Math.abs(y0),
      Math.abs(x0 + side),
      Math.abs(y0 + side),
      Math.abs(header.bbox[0]),
      Math.abs(header.bbox[1]),
      Math.abs(header.bbox[2]),
      Math.abs(header.bbox[3]),
    )
    gridTol = extent * 2 ** -16
    let depthLimit = 0
    while (depthLimit < WINDFOIL_TREE_DEPTH && side * 2 ** -(depthLimit + 1) >= extent * 2 ** -12)
      depthLimit++

    gridNodeCount = 0

    if (side > 0 && box[2] > box[0] && box[3] > box[1]) {
      const root = makeCell(x0, y0, side, 0, 0, count)
      let heapLen = 1
      heap[0] = root
      // Node records plus every list a node does not share with its parent.
      let words = 3 + cellListLen[root]!
      while (heapLen > 0 && gridNodeCount + 4 <= budget && words <= maxWords) {
        // Split the cell with the most partial-layer work per unit area of the artwork.
        const cell = heap[0],
          last = heap[--heapLen]!
        if (heapLen > 0) {
          const lastKey = cellKey[last]!
          let i = 0
          for (;;) {
            const l = 2 * i + 1
            if (l >= heapLen) break
            let m = l,
              mNode = heap[l]!,
              mKey = cellKey[mNode]!
            const r = l + 1
            if (r < heapLen) {
              const rNode = heap[r]!,
                rKey = cellKey[rNode]!
              if (rKey > mKey) {
                m = r
                mNode = rNode
                mKey = rKey
              }
            }
            if (lastKey >= mKey) break
            heap[i] = mNode
            i = m
          }
          heap[i] = last
        }
        if (cellKey[cell]! < minKey) break
        const cDepth = cellDepth[cell]!
        if (cDepth >= depthLimit) continue
        const cSide = cellSide[cell]!,
          cX = cellX[cell]!,
          cY = cellY[cell]!,
          cListStart = cellListStart[cell]!,
          cListLen = cellListLen[cell]!,
          half = Math.fround(cSide * 0.5),
          midX = Math.fround(cX + half),
          midY = Math.fround(cY + half),
          nextDepth = cDepth + 1,
          k0 = makeCell(cX, cY, half, nextDepth, cListStart, cListLen)
        makeCell(midX, cY, half, nextDepth, cListStart, cListLen)
        makeCell(cX, midY, half, nextDepth, cListStart, cListLen)
        makeCell(midX, midY, half, nextDepth, cListStart, cListLen)
        cellKids[cell] = k0
        for (let k = k0; k < k0 + 4; k++) {
          words += 3 + (cellListStart[k] === cListStart ? 0 : cellListLen[k]!)
          let i = heapLen++
          const kKey = cellKey[k]!
          while (i > 0) {
            const parent = (i - 1) >> 1,
              pNode = heap[parent]!
            if (cellKey[pNode]! >= kKey) break
            heap[i] = pNode
            i = parent
          }
          heap[i] = k
        }
      }
    }
    // Serialize breadth-first so siblings are adjacent, then intern every list once.
    let orderLen = 0
    if (gridNodeCount > 0) {
      order[0] = 0
      orderLen = 1
      for (let i = 0; i < orderLen; i++) {
        const cell = order[i]!,
          k0 = cellKids[cell]!
        if (k0 >= 0) {
          cellFirst[cell] = orderLen
          order[orderLen++] = k0
          order[orderLen++] = k0 + 1
          order[orderLen++] = k0 + 2
          order[orderLen++] = k0 + 3
        }
      }
    }
    // The top grid: every depth-`top` cell's node, or the shallower leaf covering it.
    let top = 0
    for (let i = 0; i < orderLen; i++) {
      const d = cellDepth[order[i]!]!
      const clamped = d < TOP ? d : TOP
      if (clamped > top) top = clamped
    }
    const records = base + 8,
      header0 = gridUsed,
      grid = records + 3 * orderLen,
      span = orderLen ? 1 << top : 0
    reserveOut(gridUsed + 8 + 3 * orderLen + span * span, gridUsed)
    gridUsed += 8 + 3 * orderLen + span * span
    // Lists are interned by identity (children share unchanged parent lists), then by content.
    currentHashGen++
    gridInternCount = 0
    const fullStart = internList(0, count)
    let out = poolOut
    out[header0] = orderLen ? 1 : 0
    out[header0 + 1] = floatBits(x0)
    out[header0 + 2] = floatBits(y0)
    out[header0 + 3] = floatBits(side)
    out[header0 + 4] = top
    out[header0 + 5] = fullStart
    out[header0 + 6] = fullStart + count
    out[header0 + 7] = grid
    for (let j = 0; j < span; j++)
      for (let i = 0; i < span; i++) {
        let index = 0
        for (let depth = 0; depth < top; depth++) {
          const firstChild = cellFirst[order[index]!]!
          if (firstChild < 0) break
          const bit = top - 1 - depth
          index = firstChild + ((i >> bit) & 1) + 2 * ((j >> bit) & 1)
        }
        out[grid - table.length + j * span + i] = records + 3 * index
      }
    for (let i = 0; i < orderLen; i++) {
      const cell = order[i]!,
        listLen = cellListLen[cell]!,
        listStart = internList(cellListStart[cell]!, listLen),
        record = header0 + 8 + 3 * i,
        firstChild = cellFirst[cell]!
      out = poolOut
      out[record] = firstChild < 0 ? 0 : records + 3 * firstChild
      out[record + 1] = listStart
      out[record + 2] = listStart + listLen
    }
    tagRanges.push(first, first + count, base)
  }
  const used = gridUsed
  gridCurves = EMPTY_F32
  gridRows = EMPTY_U32
  gridRowFloats = EMPTY_F32
  gridOpaque = EMPTY_U32
  const result = new Uint32Array(table.length + used)
  result.set(table)
  for (let i = 0; i < tagRanges.length; i += 3) {
    const start = tagRanges[i]!,
      end = tagRanges[i + 1]!,
      base = tagRanges[i + 2]!
    for (let layer = start; layer < end; layer++) result[layer * 12 + 11] = base
  }
  result.set(poolOut.subarray(0, used), table.length)
  if (poolPieceC.length > 262144) {
    poolPieceC = new Int32Array(0)
    poolPieceBounds = new Float64Array(0)
    poolPieceLow = new Float64Array(0)
  }
  if (poolBandPrepared.length > 262144) {
    poolBandPrepared = new Int32Array(0)
    poolBandTallEnd = new Int32Array(0)
    poolBandActiveEnd = new Int32Array(0)
    poolBandTallest = new Float64Array(0)
  }
  if (poolListArena.length > 262144) {
    poolListArena = new Uint32Array(0)
    poolArenaInterned = new Int32Array(0)
  }
  if (poolOut.length > 262144) {
    poolOut = new Uint32Array(4096)
  }
  return result
}
