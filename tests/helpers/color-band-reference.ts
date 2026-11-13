// Reference encoder: every ink texel is a seed, in raster order, and one breadth-first walk
// over a full queue labels each empty texel by the ink that reaches it first.
// Used as a byte-exact oracle for the boundary-seed implementation.
interface ColorSlot {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** @internal Classify fillStyle-invariant ink and label every empty texel by its nearest ink. */
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
  // -1: empty; 0: colour ink; 1: nearest to colour ink; -2: foreground ink or nearest to it.
  const kind = new Int8Array(count).fill(-1)
  const queue = new Uint32Array(count)
  let tail = 0
  let hasColor = false
  for (let index = 0; index < count; index++) {
    const at = index * 4
    if (white[at + 3]! < 128) continue
    queue[tail++] = index
    if (
      Math.min(
        white[at]! - black[at]!,
        white[at + 1]! - black[at + 1]!,
        white[at + 2]! - black[at + 2]!,
      ) >= 128
    ) {
      kind[index] = -2
      continue
    }
    data[at] = black[at]!
    data[at + 1] = black[at + 1]!
    data[at + 2] = black[at + 2]!
    data[at + 3] = 255
    kind[index] = 0
    hasColor = true
  }
  const colored = slots.map((slot) => {
    for (let y = slot.y; y < slot.y + slot.height; y++) {
      for (let x = slot.x; x < slot.x + slot.width; x++) {
        if (kind[y * width + x] === 0) return true
      }
    }
    return false
  })
  if (pxRange <= 0 || !hasColor) return { data, colored }
  const visit = (next: number, previous: number): void => {
    if (kind[next] !== -1) return
    if (kind[previous]! >= 0) {
      kind[next] = 1
      for (let channel = 0; channel < 4; channel++)
        data[next * 4 + channel] = data[previous * 4 + channel]!
    } else kind[next] = -2
    queue[tail++] = next
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head]!
    const x = index % width
    if (x > 0) visit(index - 1, index)
    if (x + 1 < width) visit(index + 1, index)
    if (index >= width) visit(index - width, index)
    if (index + width < count) visit(index + width, index)
  }
  return { data, colored }
}
