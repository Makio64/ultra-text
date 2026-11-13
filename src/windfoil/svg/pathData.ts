/** Absolute SVG path segments. All coordinates stay in double precision. */
export type Segment =
  | { type: 'move'; x: number; y: number }
  | { type: 'line'; x: number; y: number }
  | { type: 'quad'; x1: number; y1: number; x: number; y: number }
  | { type: 'cubic'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | {
      type: 'arc'
      rx: number
      ry: number
      rotation: number
      large: boolean
      sweep: boolean
      x: number
      y: number
    }
  | { type: 'close' }

class PathDataError extends Error {
  constructor(readonly index: number) {
    super(`Invalid SVG path at ${index}`)
  }
}

export function parsePathData(d: string): { segments: Segment[]; error?: number } {
  const segments: Segment[] = [],
    len = d.length
  let i = 0,
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    px = 0,
    py = 0,
    previous = '',
    command = '',
    allowComma = false
  const skip = (): void => {
    while (i < len) {
      const c = d.charCodeAt(i)
      if (c === 32 || (c >= 9 && c <= 13)) i++
      else break
    }
  }
  const number = (flag = false): number => {
    skip()
    if (d.charCodeAt(i) === 44) {
      if (!allowComma) throw new PathDataError(i)
      i++
      skip()
    }
    const start = i
    allowComma = true
    if (flag) {
      const c = d.charCodeAt(i++)
      if (c !== 48 && c !== 49) throw new PathDataError(start)
      return c - 48
    }
    let ch = d.charCodeAt(i)
    let neg = false
    if (ch === 43 || ch === 45) {
      neg = ch === 45
      i++
      ch = d.charCodeAt(i)
    }
    let digits = 0,
      intVal = 0
    while (ch >= 48 && ch <= 57) {
      intVal = intVal * 10 + (ch - 48)
      i++
      digits++
      ch = d.charCodeAt(i)
    }
    let hasFracOrExp = false
    if (ch === 46) {
      hasFracOrExp = true
      i++
      ch = d.charCodeAt(i)
      while (ch >= 48 && ch <= 57) {
        i++
        digits++
        ch = d.charCodeAt(i)
      }
    }
    if (!digits) throw new PathDataError(start)
    if (ch === 101 || ch === 69) {
      hasFracOrExp = true
      const exponent = i++
      ch = d.charCodeAt(i)
      if (ch === 43 || ch === 45) i++
      const first = i
      while (d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) i++
      if (i === first) throw new PathDataError(exponent)
    }
    if (!hasFracOrExp && digits <= 15) {
      return neg ? (intVal === 0 ? 0 : -intVal) : intVal
    }
    const value = Number(d.slice(start, i))
    if (!Number.isFinite(value)) throw new PathDataError(start)
    return value
  }
  try {
    for (;;) {
      skip()
      if (i === len) break
      const c = d[i]!
      if ('MmLlHhVvCcSsQqTtAaZz'.includes(c)) {
        command = c
        allowComma = false
        i++
      } else if (!command || /[a-z]/i.test(c)) throw new PathDataError(i)
      const upper = command.toUpperCase(),
        relative = command !== upper
      if (!segments.length && upper !== 'M') throw new PathDataError(i)
      if (upper === 'Z') {
        segments.push({ type: 'close' })
        x = sx
        y = sy
        previous = 'Z'
        command = ''
        continue
      }
      const ox = relative ? x : 0,
        oy = relative ? y : 0
      let segment: Exclude<Segment, { type: 'close' }>
      switch (upper) {
        case 'M':
        case 'L':
          segment = { type: upper === 'M' ? 'move' : 'line', x: number() + ox, y: number() + oy }
          break
        case 'H':
          segment = { type: 'line', x: number() + ox, y }
          break
        case 'V':
          segment = { type: 'line', x, y: number() + oy }
          break
        case 'Q':
          segment = {
            type: 'quad',
            x1: number() + ox,
            y1: number() + oy,
            x: number() + ox,
            y: number() + oy,
          }
          break
        case 'T':
          segment = {
            type: 'quad',
            x1: previous === 'Q' || previous === 'T' ? 2 * x - px : x,
            y1: previous === 'Q' || previous === 'T' ? 2 * y - py : y,
            x: number() + ox,
            y: number() + oy,
          }
          break
        case 'C':
          segment = {
            type: 'cubic',
            x1: number() + ox,
            y1: number() + oy,
            x2: number() + ox,
            y2: number() + oy,
            x: number() + ox,
            y: number() + oy,
          }
          break
        case 'S':
          segment = {
            type: 'cubic',
            x1: previous === 'C' || previous === 'S' ? 2 * x - px : x,
            y1: previous === 'C' || previous === 'S' ? 2 * y - py : y,
            x2: number() + ox,
            y2: number() + oy,
            x: number() + ox,
            y: number() + oy,
          }
          break
        case 'A':
          segment = {
            type: 'arc',
            rx: number(),
            ry: number(),
            rotation: number(),
            large: number(true) === 1,
            sweep: number(true) === 1,
            x: number() + ox,
            y: number() + oy,
          }
          break
        default:
          throw new PathDataError(i)
      }
      segments.push(segment)
      x = segment.x
      y = segment.y
      if (upper === 'M') {
        sx = x
        sy = y
        command = relative ? 'l' : 'L'
      }
      if (segment.type === 'quad') {
        px = segment.x1
        py = segment.y1
      } else if (segment.type === 'cubic') {
        px = segment.x2
        py = segment.y2
      }
      previous = upper
    }
    return { segments }
  } catch (error) {
    return { segments, error: error instanceof PathDataError ? error.index : i }
  }
}
