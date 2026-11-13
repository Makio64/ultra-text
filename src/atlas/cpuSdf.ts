/**
 * A finite stand-in for infinity in the squared-distance grids.
 *
 * Keeping the sentinel finite avoids `Infinity - Infinity` while constructing
 * the lower envelope of parabolas. Its square root is far beyond any practical
 * atlas extent, so missing inside/outside pixels still saturate at the correct
 * encoded endpoint.
 */
const FAR_DISTANCE_SQUARED = 1e20

type AlphaPixels = Uint8Array | Uint8ClampedArray

/** The alpha byte of each RGBA pixel, as the encoder reads coverage. */
export function alphaOfRgba(rgba: Uint8ClampedArray, pixelCount: number): Uint8Array {
  const alpha = new Uint8Array(pixelCount)
  for (let source = 3, target = 0; target < pixelCount; source += 4, target++) {
    alpha[target] = rgba[source]!
  }
  return alpha
}

function assertInputs(alpha: AlphaPixels, width: number, height: number, pxRange: number): number {
  if (!(alpha instanceof Uint8Array) && !(alpha instanceof Uint8ClampedArray)) {
    throw new TypeError('encodeSdfFromAlpha: alpha must be a Uint8Array or Uint8ClampedArray')
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError('encodeSdfFromAlpha: width must be a positive integer')
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError('encodeSdfFromAlpha: height must be a positive integer')
  }

  const pixelCount = width * height
  if (!Number.isSafeInteger(pixelCount)) {
    throw new RangeError('encodeSdfFromAlpha: width * height exceeds the safe integer range')
  }
  if (alpha.length !== pixelCount) {
    throw new RangeError(
      `encodeSdfFromAlpha: alpha length ${alpha.length} does not match width * height (${pixelCount})`,
    )
  }
  if (!Number.isFinite(pxRange) || pxRange <= 0) {
    throw new RangeError('encodeSdfFromAlpha: pxRange must be a positive finite number')
  }

  return pixelCount
}

let edtMinOut = 0
let edtMaxOut = -1

/**
 * Exact one-dimensional squared Euclidean distance transform.
 *
 * This is the lower-envelope algorithm from Felzenszwalb and Huttenlocher. It
 * runs in O(length), performs no allocations, and accepts non-zero seed costs
 * so fractional alpha coverage can place the glyph edge between pixel centres.
 * The envelope retains the original costs before writing back into the grid,
 * avoiding a copy of each column in both directions.
 */
function edt1d(
  grid: Float32Array,
  startSeed: number,
  endSeed: number,
  outStart: number,
  outEnd: number,
  clampSqDist: number,
  maxRadius: number,
): void {
  let first = startSeed
  while (first <= endSeed && grid[first]! >= clampSqDist) first++
  if (first > endSeed) {
    edtMinOut = outEnd + 1
    edtMaxOut = outStart - 1
    return
  }

  const firstCost = grid[first]!
  if (first === outStart) {
    let different = first + 1
    if (firstCost <= 1) {
      while (different <= endSeed && grid[different]! <= 1) different++
    } else {
      while (different <= endSeed && grid[different] === firstCost) different++
    }
    // A constant line or a line of immediate seeds (cost <= 1) is already its own distance transform.
    if (different > endSeed && endSeed >= outEnd) {
      edtMinOut = outStart
      edtMaxOut = outEnd
      return
    }
  }

  const parabolaIndices = scratchParabolaIndices
  const parabolaCosts = scratchParabolaCosts
  const parabolaOffsets = scratchParabolaOffsets
  const boundaries = scratchBoundaries
  let envelopeEnd = 0
  parabolaIndices[0] = first
  parabolaCosts[0] = firstCost
  parabolaOffsets[0] = firstCost + first * first

  for (let q = first + 1; q <= endSeed; q++) {
    let cost = grid[q]!
    if (cost >= clampSqDist) {
      while (q < endSeed && grid[q + 1]! >= clampSqDist) q++
      continue
    }
    if (cost <= 1 && grid[q - 1]! <= 1) {
      while (q < endSeed && grid[q + 1]! <= 1) q++
      cost = grid[q]!
    } else if (cost === grid[q - 1]!) {
      while (q < endSeed && grid[q + 1] === cost) q++
    }
    const costPlusQSquared = cost + q * q
    while (
      envelopeEnd > 0 &&
      (costPlusQSquared - parabolaOffsets[envelopeEnd]!) * 0.5 <=
        boundaries[envelopeEnd]! * (q - parabolaIndices[envelopeEnd]!)
    ) {
      envelopeEnd--
    }
    const intersection =
      ((costPlusQSquared - parabolaOffsets[envelopeEnd]!) * 0.5) /
      (q - parabolaIndices[envelopeEnd]!)

    envelopeEnd++
    parabolaIndices[envelopeEnd] = q
    parabolaCosts[envelopeEnd] = cost
    parabolaOffsets[envelopeEnd] = costPlusQSquared
    boundaries[envelopeEnd] = intersection
  }

  const minOut = first - maxRadius > outStart ? first - maxRadius : outStart
  const lastSeed = parabolaIndices[envelopeEnd]!
  const maxOut = lastSeed + maxRadius < outEnd ? lastSeed + maxRadius : outEnd
  let b0 = minOut
  for (let e = 0; e <= envelopeEnd; e++) {
    const b1 = e === envelopeEnd ? maxOut : Math.floor(boundaries[e + 1]!)
    if (b1 >= b0) {
      const nearest = parabolaIndices[e]!
      const cost = parabolaCosts[e]!
      const r0 = nearest - maxRadius
      const r1 = nearest + maxRadius
      const s1 = maxOut < b1 ? maxOut : b1
      const segStart = b0 > r0 ? b0 : r0
      const segEnd = s1 < r1 ? s1 : r1
      for (let q = segStart; q <= segEnd; q++) {
        const cur = grid[q]!
        if (cur <= 1) continue
        const delta = q - nearest
        const d = delta * delta + cost
        if (d < cur) grid[q] = d
      }
      b0 = b1 + 1
      if (b0 > maxOut) break
    }
  }
  edtMinOut = minOut
  edtMaxOut = maxOut
}

const SEED_COST = Float32Array.from({ length: 256 }, (_, coverage) => {
  const edgeOffset = 0.5 - coverage / 255
  return Math.fround(edgeOffset * edgeOffset)
})

let scratchDistances = new Float32Array(0)
let scratchParabolaIndices = new Int32Array(0)
let scratchParabolaCosts = new Float32Array(0)
let scratchParabolaOffsets = new Float64Array(0)
let scratchBoundaries = new Float64Array(0)
let scratchInside = new Float32Array(0)
let scratchOutside = new Float32Array(0)
let scratchActiveRows = new Int32Array(0)

/**
 * Alpha seeds cost less than 0.25. A closer seed therefore always beats a
 * farther seed in the same direction (squared integer distances differ by at
 * least one). Each empty or solid run is bounded by at most one seed on each
 * side, so one pass splits each run at its midpoint and fills both ends.
 */
function horizontalRowDistances(
  alpha: AlphaPixels,
  alphaRow: number,
  distances: Float32Array,
  distRow: number,
  width: number,
  firstNonZero: number,
  maxRadius: number,
): number {
  let lastNonZero = width - 1
  for (let x = 0; x < width; x++) {
    const coverage = alpha[alphaRow + x]!
    if (coverage === 0 || coverage === 255) {
      const a = x
      if (x === 0 && firstNonZero > 0) x = firstNonZero - 1
      else while (x + 1 < width && alpha[alphaRow + x + 1] === coverage) x++
      const isZero = coverage === 0
      if (isZero && x === width - 1) lastNonZero = a - 1
      const sign = isZero ? 1 : -1
      const lCov = a > 0 ? alpha[alphaRow + a - 1]! : -1
      const rCov = x + 1 < width ? alpha[alphaRow + x + 1]! : -1
      const lCost =
        lCov < 0 ? FAR_DISTANCE_SQUARED : (isZero ? lCov < 128 : lCov >= 128) ? SEED_COST[lCov]! : 0
      const rCost =
        rCov < 0 ? FAR_DISTANCE_SQUARED : (isZero ? rCov < 128 : rCov >= 128) ? SEED_COST[rCov]! : 0
      const mid = rCov < 0 ? x : lCov < 0 ? a - 1 : (a + x - (rCost < lCost ? 1 : 0)) >> 1
      const lEnd = lCov < 0 ? a - 1 : mid < a + maxRadius - 1 ? mid : a + maxRadius - 1
      const rStart = rCov < 0 ? x + 1 : mid + 1 > x - maxRadius + 1 ? mid + 1 : x - maxRadius + 1
      for (let p = a, d = 1; p <= lEnd; p++, d++) {
        distances[distRow + p] = sign * (d * d + lCost)
      }
      if (lEnd + 1 < rStart) {
        distances.fill(sign * FAR_DISTANCE_SQUARED, distRow + lEnd + 1, distRow + rStart)
      }
      for (let p = rStart, d = x + 1 - rStart; p <= x; p++, d--) {
        distances[distRow + p] = sign * (d * d + rCost)
      }
    } else {
      distances[distRow + x] = coverage < 128 ? SEED_COST[coverage]! : -SEED_COST[coverage]!
    }
  }
  return lastNonZero
}

/**
 * Encode an alpha coverage mask as a single-channel signed distance field.
 *
 * The returned byte uses the conventional SDF encoding:
 *
 * - the edge is 0.5 (the nearest byte representation is 128),
 * - inside pixels are greater than 0.5,
 * - outside pixels are less than 0.5,
 * - `pxRange` pixels of signed distance span one encoded unit.
 *
 * Fractional source alpha is retained as a sub-pixel seed cost rather than
 * thresholded away. The two exact Euclidean distance transforms are O(width *
 * height); temporary storage is one grid plus O(height) scratch.
 */
export function encodeSdfFromAlpha(
  alpha: AlphaPixels,
  width: number,
  height: number,
  pxRange: number,
): Uint8Array {
  const pixelCount = assertInputs(alpha, width, height, pxRange)
  const encoded = new Uint8Array(pixelCount)
  const scale255 = 255 / pxRange
  const clampSqDist = 0.25 * pxRange * pxRange * (1 + 1e-6)
  const skipEmptyRows = clampSqDist <= FAR_DISTANCE_SQUARED
  const maxRadius = skipEmptyRows ? Math.ceil(0.5 * pxRange + 1) : width > height ? width : height
  // Pad power-of-two widths by one 64-byte cache line (16 floats) so vertical
  // column gathers do not alias onto the same L1 cache set on every row.
  const distStride = (width & 63) === 0 ? width + 16 : width
  const requiredDistances = distStride * height
  if (scratchDistances.length < requiredDistances) {
    scratchDistances = new Float32Array(requiredDistances)
  }
  if (scratchParabolaIndices.length < height) {
    scratchParabolaIndices = new Int32Array(height)
    scratchParabolaCosts = new Float32Array(height)
    scratchParabolaOffsets = new Float64Array(height)
    scratchBoundaries = new Float64Array(height)
    scratchInside = new Float32Array(height)
    scratchOutside = new Float32Array(height)
    scratchActiveRows = new Int32Array(height)
  }
  const distances = scratchDistances
  const activeRows = scratchActiveRows
  const inside = scratchInside
  const outside = scratchOutside
  const sentinel = skipEmptyRows ? FAR_DISTANCE_SQUARED : clampSqDist
  inside.fill(sentinel, 0, height)
  outside.fill(0, 0, height)
  const lastRow = height - 1
  const u32 =
    (alpha.byteOffset & 3) === 0
      ? new Uint32Array(alpha.buffer, alpha.byteOffset, alpha.byteLength >>> 2)
      : null

  let anyNonZero = false
  let scanY = 0
  while (scanY < height) {
    let bandCount = 0
    let bandMinX = width
    let bandMaxX = -1
    let lastActiveY = -1
    for (; scanY < height; scanY++) {
      const alphaRow = scanY * width
      let firstNonZero = 0
      if (u32 !== null && (alphaRow & 3) === 0) {
        const wStart = alphaRow >>> 2
        const wEnd = wStart + (width >>> 2)
        let w = wStart
        while (w < wEnd && u32[w] === 0) w++
        firstNonZero = (w - wStart) << 2
      }
      while (firstNonZero < width && alpha[alphaRow + firstNonZero] === 0) firstNonZero++
      if (firstNonZero === width) {
        if (!skipEmptyRows) {
          const distRow = bandCount * distStride
          distances.fill(FAR_DISTANCE_SQUARED, distRow, distRow + width)
          activeRows[bandCount++] = scanY
          lastActiveY = scanY
        } else if (bandCount > 0 && scanY - lastActiveY >= 2 * maxRadius) {
          scanY++
          break
        }
        continue
      }
      anyNonZero = true
      const distRow = bandCount * distStride
      const lastNonZero = horizontalRowDistances(
        alpha,
        alphaRow,
        distances,
        distRow,
        width,
        firstNonZero,
        maxRadius,
      )
      activeRows[bandCount++] = scanY
      lastActiveY = scanY
      if (firstNonZero < bandMinX) bandMinX = firstNonZero
      if (lastNonZero > bandMaxX) bandMaxX = lastNonZero
    }

    if (bandCount === 0) break
    if (!anyNonZero) {
      const byte = 128 - Math.sqrt(FAR_DISTANCE_SQUARED) * scale255
      const fillByte = byte <= 0 ? 0 : byte | 0
      if (fillByte !== 0) encoded.fill(fillByte)
      if (scratchDistances.length > 4_500_000) scratchDistances = new Float32Array(0)
      return encoded
    }

    const firstActiveY = activeRows[0]!
    const bandMinY = skipEmptyRows ? (firstActiveY > maxRadius ? firstActiveY - maxRadius : 0) : 0
    const bandMaxY = skipEmptyRows
      ? lastActiveY + maxRadius < lastRow
        ? lastActiveY + maxRadius
        : lastRow
      : lastRow
    const bandHeight = bandMaxY - bandMinY + 1
    const colStart = skipEmptyRows ? (bandMinX > maxRadius ? bandMinX - maxRadius : 0) : 0
    const colEnd = skipEmptyRows
      ? bandMaxX + maxRadius < width - 1
        ? bandMaxX + maxRadius
        : width - 1
      : width - 1

    for (let x = colStart; x <= colEnd; x++) {
      // Transform contiguous columns in scratch instead of repeatedly traversing
      // two atlas-sized grids at a cache-unfriendly stride.
      let r = 0
      let offset = x
      while (r < bandCount && distances[offset]! >= clampSqDist) {
        r++
        offset += distStride
      }
      if (r === bandCount) continue
      const firstInSeed = activeRows[r]!
      let lastInSeed = firstInSeed
      let firstNeg = -1
      let lastNeg = -1
      let negCount = 0
      for (; r < bandCount; r++, offset += distStride) {
        const distance = distances[offset]!
        if (distance >= clampSqDist) continue
        const y = activeRows[r]!
        lastInSeed = y
        if (distance >= 0) {
          inside[y] = distance
        } else {
          inside[y] = 0
          outside[y] = -distance
          if (firstNeg < 0) firstNeg = y
          lastNeg = y
          negCount++
        }
      }
      const hasPositive = negCount < bandHeight
      let yStart = bandMinY
      let yEnd = bandMaxY
      if (hasPositive) {
        edt1d(inside, firstInSeed, lastInSeed, bandMinY, bandMaxY, clampSqDist, maxRadius)
        yStart = edtMinOut
        yEnd = edtMaxOut
      }
      const pureInEnd = firstNeg < 0 ? yEnd : firstNeg - 1
      let y = yStart
      let idx = y * width + x
      for (; y <= pureInEnd; y++, idx += width) {
        const inSq = inside[y]!
        if (inSq < clampSqDist) encoded[idx] = (128 - Math.sqrt(inSq) * scale255) | 0
      }
      if (firstNeg >= 0) {
        edt1d(
          outside,
          firstNeg > 0 ? firstNeg - 1 : 0,
          lastNeg < lastRow ? lastNeg + 1 : lastRow,
          firstNeg,
          lastNeg,
          clampSqDist,
          maxRadius,
        )
        for (; y <= lastNeg; y++, idx += width) {
          const inSq = inside[y]!
          if (inSq > 0) {
            if (inSq < clampSqDist) encoded[idx] = (128 - Math.sqrt(inSq) * scale255) | 0
          } else {
            const outSq = outside[y]!
            encoded[idx] = outSq >= clampSqDist ? 255 : (128 + Math.sqrt(outSq) * scale255) | 0
          }
        }
        for (; y <= yEnd; y++, idx += width) {
          const inSq = inside[y]!
          if (inSq < clampSqDist) encoded[idx] = (128 - Math.sqrt(inSq) * scale255) | 0
        }
        outside.fill(0, firstNeg, lastNeg + 1)
      }
      inside.fill(sentinel, yStart, yEnd + 1)
    }
  }

  if (scratchDistances.length > 4_500_000) scratchDistances = new Float32Array(0)
  return encoded
}
