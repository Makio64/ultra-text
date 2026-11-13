import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three/webgpu'
import type { BuildSdfAtlasOptions, RasterColorBand, SdfColorLayer } from '../types.js'

interface ColorSlot {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * @internal Classify fillStyle-invariant ink and label every empty texel by its nearest ink:
 * colour carries its colour and full alpha on, foreground ink leaves the texel clear. The
 * alpha of the band is then 1 around colour and 0 around text that shares a slot with it,
 * whatever the distance. A `pxRange` of 0 only classifies.
 */
let scratchState = new Uint8Array(0)
let scratchQueue = new Uint32Array(0)
let scratchQueueX = new Int32Array(0)

export function encodeColorBand(
  white: Uint8ClampedArray,
  black: Uint8ClampedArray,
  width: number,
  height: number,
  pxRange: number,
  slots: readonly ColorSlot[],
): { data: Uint8Array; colored: boolean[] } {
  const count = width * height
  const data = new Uint8Array(count * 4)
  // Whole-pixel copies preserve byte order on either endian architecture.
  const packed = new Uint32Array(data.buffer)
  // 0 = empty, 1 = colour or nearest to it, 2 = nearest to foreground, 255 = solid foreground.
  if (scratchState.length < count) scratchState = new Uint8Array(count)
  const state = scratchState
  state.fill(0, 0, count)
  let hasColor = false
  let firstInkIndex = -1
  let lastInkIndex = -1
  for (let index = 0, at = 0; index < count; index++, at += 4) {
    if (white[at + 3]! < 128) continue
    if (firstInkIndex < 0) firstInkIndex = index
    lastInkIndex = index
    const b0 = black[at]!
    const b1 = black[at + 1]!
    const b2 = black[at + 2]!
    if (white[at]! - b0 >= 128 && white[at + 1]! - b1 >= 128 && white[at + 2]! - b2 >= 128) {
      state[index] = 255
      continue
    }
    data[at] = b0
    data[at + 1] = b1
    data[at + 2] = b2
    data[at + 3] = 255
    state[index] = 1
    hasColor = true
  }
  const colored = slots.map((slot) => {
    if (!hasColor) return false
    const xEnd = slot.x + slot.width
    const yEnd = slot.y + slot.height
    for (let y = slot.y; y < yEnd; y++) {
      const row = y * width
      for (let x = slot.x; x < xEnd; x++) {
        if (state[row + x] === 1) return true
      }
    }
    return false
  })
  if (pxRange <= 0 || !hasColor) {
    if (scratchState.length > 65536) scratchState = new Uint8Array(0)
    return { data, colored }
  }
  if (scratchQueue.length < count) {
    scratchQueue = new Uint32Array(count)
    scratchQueueX = new Int32Array(count)
  }
  const queue = scratchQueue
  const queueX = scratchQueueX
  let tail = 0
  const minInkY = (firstInkIndex / width) | 0
  const maxInkY = (lastInkIndex / width) | 0
  // Interior seeds cannot reach empty pixels directly. Keeping only boundary
  // seeds preserves their raster-order tie breaking and avoids four visits per
  // interior texel. The waves below are breadth-first, from both kinds of ink at once.
  for (let y = minInkY; y <= maxInkY; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const index = row + x
      if (state[index] === 0) continue
      if (
        (x > 0 && state[index - 1] === 0) ||
        (x + 1 < width && state[index + 1] === 0) ||
        (y > 0 && state[index - width] === 0) ||
        (y + 1 < height && state[index + width] === 0)
      ) {
        queueX[tail] = x
        queue[tail++] = index
      }
    }
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head]!
    const x = queueX[head]!
    if (state[index] === 1) {
      const colorWord = packed[index]!
      if (x > 0) {
        const next = index - 1
        if (state[next] === 0) {
          state[next] = 1
          packed[next] = colorWord
          queueX[tail] = x - 1
          queue[tail++] = next
        }
      }
      if (x + 1 < width) {
        const next = index + 1
        if (state[next] === 0) {
          state[next] = 1
          packed[next] = colorWord
          queueX[tail] = x + 1
          queue[tail++] = next
        }
      }
      if (index >= width) {
        const next = index - width
        if (state[next] === 0) {
          state[next] = 1
          packed[next] = colorWord
          queueX[tail] = x
          queue[tail++] = next
        }
      }
      if (index + width < count) {
        const next = index + width
        if (state[next] === 0) {
          state[next] = 1
          packed[next] = colorWord
          queueX[tail] = x
          queue[tail++] = next
        }
      }
    } else {
      if (x > 0) {
        const next = index - 1
        if (state[next] === 0) {
          state[next] = 2
          queueX[tail] = x - 1
          queue[tail++] = next
        }
      }
      if (x + 1 < width) {
        const next = index + 1
        if (state[next] === 0) {
          state[next] = 2
          queueX[tail] = x + 1
          queue[tail++] = next
        }
      }
      if (index >= width) {
        const next = index - width
        if (state[next] === 0) {
          state[next] = 2
          queueX[tail] = x
          queue[tail++] = next
        }
      }
      if (index + width < count) {
        const next = index + width
        if (state[next] === 0) {
          state[next] = 2
          queueX[tail] = x
          queue[tail++] = next
        }
      }
    }
  }
  if (scratchState.length > 65536) scratchState = new Uint8Array(0)
  if (scratchQueue.length > 65536) {
    scratchQueue = new Uint32Array(0)
    scratchQueueX = new Int32Array(0)
  }
  return { data, colored }
}

/** @internal Upload-ready colour band; ownership transfers to its atlas wrapper. */
export function createColorLayer(
  band: RasterColorBand,
  width: number,
  options: BuildSdfAtlasOptions,
  maxAnisotropy: number,
): SdfColorLayer {
  const texture = new DataTexture(band.data, width, band.height, RGBAFormat, UnsignedByteType)
  texture.colorSpace = SRGBColorSpace
  texture.flipY = false
  texture.generateMipmaps = options.mipmaps ?? false
  texture.minFilter = texture.generateMipmaps ? LinearMipmapLinearFilter : LinearFilter
  texture.magFilter = LinearFilter
  texture.anisotropy = Math.max(1, Math.min(options.anisotropy ?? 1, maxAnisotropy))
  texture.needsUpdate = true
  return { texture, top: band.top, height: band.height }
}
