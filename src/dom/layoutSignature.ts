import type { DomLayoutSnapshot } from '../types.js'

// The walk below writes the capture's values as float64 words into this small buffer, which
// is hashed in one tight loop whenever it fills: about 2.5 times faster than mixing each value
// through a closure, and nothing larger than these 16 KB stays allocated.
const WORDS = 2048
const words = new Float64Array(WORDS)
const bits = new Int32Array(words.buffer)
const strings = new Map<string, number>()
let count = 0
let h1 = 0
let h2 = 0

// Markers for what is not a number; values this large never occur in a capture.
const STRING = -1e300
const STRING_ID = -2e300
const TRUE = -3e300
const FALSE = -4e300
const OPEN = -5e300
const CLOSE = -6e300
const OTHER = -7e300

function flush(): void {
  let a = h1
  let b = h2
  for (let index = 0, end = count * 2; index < end; index++) {
    const value = bits[index]!
    a = Math.imul(a ^ value, 16777619)
    b = Math.imul(b ^ value, 1597334677)
  }
  h1 = a
  h2 = b
  count = 0
}

function push(value: number): void {
  if (count === WORDS) flush()
  words[count++] = value
}

function walkString(value: string): void {
  const id = strings.get(value)
  if (id === undefined) {
    strings.set(value, strings.size)
    push(STRING)
    push(value.length)
    for (let index = 0; index < value.length; index++) push(value.charCodeAt(index))
  } else {
    push(STRING_ID)
    push(id)
  }
}

function walk(value: unknown): void {
  // `+ 0` folds -0 into 0: both lay out the same.
  if (typeof value === 'number') {
    if (count === WORDS) flush()
    words[count++] = value + 0
  } else if (typeof value === 'string') walkString(value)
  else if (typeof value === 'boolean') push(value ? TRUE : FALSE)
  else if (typeof value === 'object' && value !== null) {
    push(OPEN)
    // Capture records have a fixed schema and stable declaration order.
    // Field names are identical across captures; only their values matter.
    if (Array.isArray(value)) {
      const length = value.length
      if (length > 0 && typeof value[0] === 'number') {
        if (count + length > WORDS) flush()
        for (let index = 0; index < length; index++) words[count++] = (value[index] as number) + 0
      } else {
        for (let index = 0; index < length; index++) walk(value[index])
      }
    } else {
      const record = value as Record<string, unknown>
      for (const key in record) {
        if (Object.hasOwn(record, key)) walk(record[key])
      }
    }
    push(CLOSE)
  } else push(OTHER)
}

/** Hash the capture directly, without allocating its much larger JSON string. */
export function layoutSignatureOf(snapshot: DomLayoutSnapshot): string {
  h1 = 0x811c9dc5
  h2 = 0x811c9dc5 ^ 0x5bd1e995
  count = 0
  strings.clear()
  const glyphs = snapshot.glyphs
  push(glyphs.length)
  for (let index = 0, length = glyphs.length; index < length; index++) {
    const g = glyphs[index]!
    const { clip, color } = g
    walkString(g.glyphKey)
    walkString(g.breakBefore)
    if (count > WORDS - 24) flush()
    words[count++] = g.fontSize + 0
    words[count++] = g.originX + 0
    words[count++] = g.lineBottom + 0
    words[count++] = g.advance + 0
    words[count++] = g.block + 0
    words[count++] = g.sequence + 0
    words[count++] = g.z + 0
    words[count++] = clip[0] + 0
    words[count++] = clip[1] + 0
    words[count++] = clip[2] + 0
    words[count++] = clip[3] + 0
    words[count++] = color[0] + 0
    words[count++] = color[1] + 0
    words[count++] = color[2] + 0
    words[count++] = color[3] + 0
    words[count++] = (g.shapeGroup ?? OTHER) + 0
    words[count++] = (g.decorationWidth ?? OTHER) + 0
    words[count++] = (g.baselineOffset ?? OTHER) + 0
    words[count++] = (g.switchEm ?? OTHER) + 0
    words[count++] = (g.gapBefore ?? OTHER) + 0
    if (g.decorations) walk(g.decorations)
    if (g.snap) walk(g.snap)
    if (g.motionOrigin) walk(g.motionOrigin)
  }
  // Requests select retained glyph data separately through atlasSignature.
  const root = snapshot as unknown as Record<string, unknown>
  for (const key in root) {
    if (key !== 'requests' && key !== 'glyphs' && Object.hasOwn(root, key)) walk(root[key])
  }
  flush()
  strings.clear()
  return `${h1}:${h2}`
}
