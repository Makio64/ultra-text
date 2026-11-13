/**
 * CPU port of `WindfoilCompositeMaterial`'s fragment walk: the quadtree list lookup (in f32,
 * exactly as the shader evaluates it), each layer's coverage (`layerCoverage`, with the
 * integrateFace/profileFace ports from `coverage.ts` in f64) and the top-down composite with its
 * opaque exit. Counters report the work each walk does.
 */
const f = Math.fround
const SOLID = 0x8000_0000
const DEPTH = 12

export interface WalkTables {
  readonly table: Uint32Array
  readonly curves: Float32Array
  readonly rows: Uint32Array
  readonly paints?: Uint32Array
  readonly stops?: Uint32Array
}
export interface WalkCounters {
  entries: number
  integrals: number
  profiles: number
  pieces: number
  solid: number
  bands: number
}
export const walkCounters = (): WalkCounters => ({
  entries: 0,
  integrals: 0,
  profiles: 0,
  pieces: 0,
  solid: 0,
  bands: 0,
})
const view = (data: Uint32Array): Float32Array =>
  new Float32Array(data.buffer, data.byteOffset, data.length)

/** Word range `[start, end)` the shader walks for this pixel footprint, and its tree depth. */
export function selectList(
  table: Uint32Array,
  layerStart: number,
  x: number,
  y: number,
  sx: number,
  sy: number,
  tree = true,
): { start: number; end: number; depth: number; cell: number } {
  const floats = view(table),
    block = table[layerStart * 12 + 11]!
  let cell = 0,
    depth = -1
  if (tree && table[block]! > 0) {
    const lo = [f(x - f(sx * 0.5)), f(y - f(sy * 0.5))],
      hi = [f(x + f(sx * 0.5)), f(y + f(sy * 0.5))]
    let ox = floats[block + 1]!,
      oy = floats[block + 2]!,
      side = floats[block + 3]!,
      candidate = block + 8,
      start = 0
    const fits = (cx: number, cy: number, extent: number): boolean => {
      const margin = f(extent * 0.125)
      return (
        lo[0]! >= f(cx - margin) &&
        lo[1]! >= f(cy - margin) &&
        hi[0]! <= f(f(cx + extent) + margin) &&
        hi[1]! <= f(f(cy + extent) + margin)
      )
    }
    const top = table[block + 4]!,
      span = 1 << top,
      step = f(side / span),
      ix = Math.min(Math.max(Math.floor(f(f(x - ox) / step)), 0), span - 1),
      iy = Math.min(Math.max(Math.floor(f(f(y - oy) / step)), 0), span - 1),
      cx = f(ox + f(ix * step)),
      cy = f(oy + f(iy * step))
    if (fits(cx, cy, step)) {
      candidate = table[table[block + 7]! + iy * span + ix]!
      ox = cx
      oy = cy
      side = step
      start = top
    }
    for (let level = start; level <= DEPTH; level++) {
      const margin = f(side * 0.125)
      if (!(
        lo[0]! >= f(ox - margin) &&
        lo[1]! >= f(oy - margin) &&
        hi[0]! <= f(f(ox + side) + margin) &&
        hi[1]! <= f(f(oy + side) + margin)
      ))
        break
      cell = candidate
      depth = level
      const child = table[candidate]!
      if (!child) break
      side = f(side * 0.5)
      const mx = f(ox + side),
        my = f(oy + side),
        right = x >= mx,
        up = y >= my
      ox = right ? mx : ox
      oy = up ? my : oy
      candidate = child + (right ? 3 : 0) + (up ? 6 : 0)
    }
  }
  const offset = cell ? cell + 1 : block + 5
  return { start: table[offset]!, end: table[offset + 1]!, depth, cell }
}

function integrateInside(
  a2: readonly number[],
  a1: readonly number[],
  x0: number,
  ta: number,
  tb: number,
  hx: number,
): number {
  if (tb <= ta) return 0
  const tm = 0.5 * (ta + tb),
    d = 0.5 * (tb - ta),
    xMid = (a2[0]! * tm + a1[0]!) * tm + x0 + hx,
    dx = 2 * a2[0]! * tm + a1[0]!,
    dy = 2 * a2[1]! * tm + a1[1]!
  return 2 * d * xMid * dy + ((2 * d * d * d) / 3) * (a2[0]! * dy + 2 * a2[1]! * dx)
}

function integratePiece(
  q1: readonly number[],
  q2: readonly number[],
  q3: readonly number[],
  lo: number,
  hi: number,
  hx: number,
): number {
  const a2 = [q1[0]! - 2 * q2[0]! + q3[0]!, q1[1]! - 2 * q2[1]! + q3[1]!],
    a1 = [2 * (q2[0]! - q1[0]!), 2 * (q2[1]! - q1[1]!)],
    yRising = q3[1]! >= q1[1]!,
    xRising = q3[0]! >= q1[0]!,
    A2 = [a2[1]!, a2[1]!, a2[0]!, a2[0]!],
    A1 = [a1[1]!, a1[1]!, a1[0]!, a1[0]!],
    V = [yRising ? lo : hi, yRising ? hi : lo, -hx, hx],
    R = [yRising, yRising, xRising, xRising],
    Q1 = [q1[1]!, q1[1]!, q1[0]!, q1[0]!],
    Q3 = [q3[1]!, q3[1]!, q3[0]!, q3[0]!],
    T = [0, 0, 0, 0]
  for (let k = 0; k < 4; k++) {
    const sg = R[k] ? 1 : -1,
      c = Q1[k]! - V[k]!,
      disc = Math.max(A1[k]! * A1[k]! - 4 * A2[k]! * c, 0),
      sq = Math.sqrt(disc),
      qq = -0.5 * (A1[k]! + (A1[k]! >= 0 ? sq : -sq)),
      useR1 = A1[k]! < 0 === R[k],
      num = useR1 ? qq : c,
      den = useR1 ? A2[k]! : qq,
      raw = Math.min(Math.max(den !== 0 ? num / den : 0, 0), 1)
    T[k] = c * sg >= 0 ? 0 : (Q3[k]! - V[k]!) * sg <= 0 ? 1 : raw
  }
  if (T[1]! <= T[0]!) return 0
  const tcx = Math.min(Math.max(T[2]!, T[0]!), T[1]!),
    tcy = Math.min(Math.max(T[3]!, T[0]!), T[1]!),
    t1 = xRising ? tcx : tcy,
    t2 = Math.max(xRising ? tcy : tcx, t1)
  let acc = integrateInside(a2, a1, q1[0]!, t1, t2, hx)
  const [ra, rb] = xRising ? [t2, T[1]!] : [T[0]!, t1],
    d = Math.max(rb - ra, 0),
    tm = 0.5 * (ra + rb)
  acc += d * (2 * a2[1]! * tm + a1[1]!) * (2 * hx)
  return acc
}

const bandIndex = (dy: number, invH: number, count: number): number =>
  Math.min(Math.max(Math.floor(dy * invH), 0), count - 1)

/** `layerCoverage` for one layer row: `null` where the shader's box test continues the walk. */
export function layerCoverage(
  tables: WalkTables,
  row: number,
  x: number,
  y: number,
  sx: number,
  sy: number,
  counters?: WalkCounters,
): number | null {
  const { table, curves, rows } = tables,
    floats = view(table),
    rowFloats = view(rows)
  if (
    x + sx / 2 < floats[row + 4]! ||
    y + sy / 2 < floats[row + 5]! ||
    x - sx / 2 > floats[row + 6]! ||
    y - sy / 2 > floats[row + 7]!
  )
    return null
  // A transposed layer integrates in swapped axes.
  const swap = (table[row + 9]! & 2) >> 1
  if (swap) [x, y, sx, sy] = [y, x, sy, sx]
  const bx0 = floats[row + 4 + swap]!,
    by0 = floats[row + 5 - swap]!,
    bx1 = floats[row + 6 + swap]!,
    by1 = floats[row + 7 - swap]!
  const rowBase = table[row]!,
    count = table[row + 1]!,
    bandH = floats[row + 2]!,
    invH = floats[row + 3]!
  let integral = 0
  if (sx * 3.7 >= bx1 - bx0 && sy * 3.7 >= by1 - by0) {
    if (counters) counters.profiles++
    const lx = x - sx / 2,
      hx = x + sx / 2,
      ly = y - sy / 2,
      hy = y + sy / 2,
      overlap = (a0: number, a1: number, b0: number, b1: number): number =>
        Math.max(Math.min(a1, b1) - Math.max(a0, b0), 0)
    if (overlap(lx, hx, bx0, bx1) > 0)
      for (let i = bandIndex(ly - by0, invH, count); i <= bandIndex(hy - by0, invH, count); i++) {
        const at = (rowBase + i) * 6,
          edge = by0 + i * bandH
        integral +=
          rowFloats[at + 2]! *
          overlap(ly, hy, edge, edge + bandH) *
          overlap(lx, hx, rowFloats[at + 3]!, rowFloats[at + 4]!)
      }
  } else {
    if (counters) counters.integrals++
    // The composite shader's seamless band walk: one band of slack either side, shared edges.
    const halfY = sy / 2,
      origin = by0 - y
    for (
      let i = bandIndex(-origin - halfY - bandH, invH, count);
      i <= bandIndex(-origin + halfY + bandH, invH, count);
      i++
    ) {
      let low = -halfY,
        high = halfY
      if (count > 1) {
        low = Math.max(low, origin + i * bandH)
        high = Math.min(high, origin + (i + 1) * bandH)
      }
      if (high <= low) continue
      if (counters) counters.bands++
      const at = (rowBase + i) * 6,
        pieces = rows[at + 1]!,
        leftward = x < rowFloats[at + 5]!,
        start = rows[at]! + (leftward ? pieces : 0),
        direction = leftward ? -1 : 1,
        halfX = sx / 2,
        edgeOffset = leftward ? -sx : 0,
        ulp = Math.max(Math.abs(x), Math.abs(y)) * 1.2e-7
      for (let k = 0; k < pieces; k++) {
        if (counters) counters.pieces++
        const c = (start + k) * 6,
          q1 = [curves[c]! - x, curves[c + 1]! - y],
          q2 = [curves[c + 2]! - x, curves[c + 3]! - y],
          q3 = [curves[c + 4]! - x, curves[c + 5]! - y],
          xMax = Math.max(q1[0]!, q3[0]!),
          xMin = Math.min(q1[0]!, q3[0]!)
        if ((leftward ? -xMin : xMax) <= -halfX) break
        const yMin = Math.min(q1[1]!, q3[1]!),
          yMax = Math.max(q1[1]!, q3[1]!),
          lo = Math.max(low, yMin),
          hi = Math.min(high, yMax)
        if (hi <= lo) continue
        const clampY = (v: number): number => Math.min(Math.max(v, low), high),
          rise = clampY(q3[1]!) - clampY(q1[1]!)
        if ((leftward ? -xMax : xMin) >= halfX) {
          integral += direction * sx * rise
          continue
        }
        if (xMax - xMin + (yMax - yMin) <= ulp * 16) {
          integral +=
            (Math.min(Math.max((q1[0]! + q3[0]!) / 2, -halfX), halfX) + halfX + edgeOffset) * rise
          continue
        }
        integral += integratePiece(q1, q2, q3, lo, hi, halfX) + edgeOffset * rise
      }
    }
  }
  return Math.min(Math.max(Math.abs(integral / (sx * sy)), 0), 1)
}

const unpack = (word: number): number[] => [0, 8, 16, 24].map((s) => ((word >>> s) & 255) / 255)
/** `evaluatePaint` in f64: premultiplied encoded sRGB. */
export function evaluatePaint(
  tables: WalkTables,
  index: number,
  x: number,
  y: number,
  foreground: readonly number[],
): number[] {
  const paints = tables.paints!,
    stops = tables.stops!,
    floats = view(paints),
    stopFloats = view(stops),
    base = index * 16,
    kind = paints[base]! & 15,
    extend = paints[base]! >>> 4,
    premul = (c: readonly number[]): number[] => [
      c[0]! * c[3]!,
      c[1]! * c[3]!,
      c[2]! * c[3]!,
      c[3]!,
    ]
  if (kind < 2) {
    const color = unpack(paints[base + 3]!)
    return premul(
      kind === 1
        ? [foreground[0]!, foreground[1]!, foreground[2]!, foreground[3]! * color[3]!]
        : color,
    )
  }
  const read = (k: number): number => floats[base + k]!,
    px = x * read(4) + y * read(6) + read(8),
    py = x * read(5) + y * read(7) + read(9)
  let t = 0,
    valid = 1
  if (kind === 2) t = px * read(10) + py * read(11) + read(12)
  else if (kind === 3) {
    const qx = px - read(10),
      qy = py - read(11),
      dx = read(12),
      dy = read(13),
      r = read(14),
      dr = read(15),
      a = dx * dx + dy * dy - dr * dr,
      b = -2 * (qx * dx + qy * dy + r * dr),
      c = qx * qx + qy * qy - r * r
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) < 1e-12) valid = 0
      else t = -c / b
    } else {
      const disc = b * b - 4 * a * c,
        root = Math.sqrt(Math.max(disc, 0)),
        u = (-b + root) / (2 * a),
        v = (-b - root) / (2 * a)
      t = r + dr * Math.max(u, v) >= 0 ? Math.max(u, v) : Math.min(u, v)
      if (disc < 0) valid = 0
    }
    if (r + dr * t < 0) valid = 0
  } else {
    const angle = Math.atan2(py - read(11), px - read(10)),
      turn = angle / (Math.PI * 2) + 1
    t = (turn - Math.floor(turn)) * Math.PI * 2 - read(12)
    t *= read(13)
  }
  const fract = (v: number): number => v - Math.floor(v)
  t =
    extend === 0
      ? Math.min(Math.max(t, 0), 1)
      : extend === 1
        ? fract(t)
        : 1 - Math.abs(fract(t * 0.5) * 2 - 1)
  const first = paints[base + 1]!,
    count = paints[base + 2]!
  let previous = unpack(stops[first * 2 + 1]!),
    offset = stopFloats[first * 2]!,
    result = premul(previous)
  for (let i = 1; i < count; i++) {
    const at = (first + i) * 2,
      nextOffset = stopFloats[at]!,
      next = unpack(stops[at + 1]!),
      fraction =
        nextOffset === offset
          ? 1
          : Math.min(Math.max((t - offset) / Math.max(nextOffset - offset, 1e-9), 0), 1),
      a = premul(previous),
      b = premul(next)
    result = a.map((value, k) => value + (b[k]! - value) * fraction)
    if (t < nextOffset) break
    previous = next
    offset = nextOffset
  }
  return result.map((value) => value * valid)
}

/**
 * The composite walk for one pixel. `tree: false` walks the full list, which is the unpruned
 * reference. Returns premultiplied encoded-sRGB RGBA before the clip multiplier.
 */
export function compositeWalk(
  tables: WalkTables,
  layerStart: number,
  x: number,
  y: number,
  sx: number,
  sy: number,
  options: {
    readonly tree?: boolean
    readonly foreground?: readonly number[]
    readonly counters?: WalkCounters
    readonly visit?: (layer: number, coverage: number, solid: boolean) => void
  } = {},
): number[] {
  const { table } = tables,
    { start, end } = selectList(table, layerStart, x, y, sx, sy, options.tree ?? true),
    acc = [0, 0, 0, 0],
    counters = options.counters
  for (let i = start; i < end; i++) {
    if (counters) counters.entries++
    const entry = table[i]!,
      solid = entry >= SOLID,
      layer = solid ? entry - SOLID : entry,
      row = layer * 12
    if (solid && counters) counters.solid++
    const coverage = solid ? 1 : layerCoverage(tables, row, x, y, sx, sy, counters)
    if (coverage === null || coverage < 1 / 1024) continue
    options.visit?.(layer, coverage, solid)
    if (tables.paints) {
      const paint = evaluatePaint(tables, table[row + 8]!, x, y, options.foreground ?? [1, 1, 1, 1])
      const keep = 1 - acc[3]!
      for (let k = 0; k < 4; k++) acc[k] = acc[k]! + paint[k]! * coverage * keep
    } else acc[3] = acc[3]! + coverage * (1 - acc[3]!)
    if (acc[3]! > 0.998) break
  }
  return acc
}

/** The shadow loop: the union of layer coverage × unquantized alpha, stopping past `cutoff`. */
export function shadowWalk(
  tables: WalkTables,
  layerStart: number,
  x: number,
  y: number,
  sx: number,
  sy: number,
  cutoff: number,
  tree = true,
): number {
  const { table } = tables,
    floats = view(table),
    { start, end } = selectList(table, layerStart, x, y, sx, sy, tree)
  let acc = 0
  for (let i = start; i < end; i++) {
    const entry = table[i]!,
      solid = entry >= SOLID,
      row = (solid ? entry - SOLID : entry) * 12,
      coverage = solid ? 1 : layerCoverage(tables, row, x, y, sx, sy)
    if (coverage === null) continue
    acc += coverage * floats[row + 10]! * (1 - acc)
    if (acc > cutoff) break
  }
  return acc
}
