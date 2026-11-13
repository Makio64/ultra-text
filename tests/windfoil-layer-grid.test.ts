import { describe, expect, it } from 'vitest'
import type { WindfoilGlyphOutline, WindfoilPaint } from '../src/types.js'
import { preprocessWindfoilOutlines } from '../src/windfoil/preprocess.js'
import { packWindfoilLayers } from '../src/windfoil/color.js'
import {
  appendWindfoilLayerGrids,
  windfoilPaintOpaque,
  WINDFOIL_SOLID,
  WINDFOIL_TREE_DEPTH,
} from '../src/windfoil/layerGrid.js'
import { normalizeWindfoilPaint } from '../src/windfoil/paint.js'
import {
  compositeWalk,
  evaluatePaint,
  layerCoverage,
  selectList,
  shadowWalk,
  walkCounters,
  type WalkTables,
} from './helpers/windfoil-walk.js'

type Rgba = [number, number, number, number]
const line = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0,
  y0,
  (x0 + x1) / 2,
  (y0 + y1) / 2,
  x1,
  y1,
]
/** Closed polygon through `points`, one straight quadratic per edge. */
const polygon = (points: readonly (readonly [number, number])[]): number[] =>
  points.flatMap((p, i) => {
    const q = points[(i + 1) % points.length]!
    return line(p[0], p[1], q[0], q[1])
  })
const rect = (x0: number, y0: number, x1: number, y1: number, reverse = false): number[] => {
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  return polygon(reverse ? corners.reverse() : corners)
}
/** Eight-arc quadratic ellipse, rotated by `angle`; `reverse` flips its winding. */
function ellipse(cx: number, cy: number, rx: number, ry: number, angle = 0, reverse = false) {
  const out: number[] = [],
    c = Math.cos(angle),
    s = Math.sin(angle),
    at = (t: number, k = 1): [number, number] => {
      const x = Math.cos(t) * rx * k,
        y = Math.sin(t) * ry * k
      return [cx + x * c - y * s, cy + x * s + y * c]
    }
  for (let i = 0; i < 8; i++) {
    const a = ((reverse ? 8 - i : i) * Math.PI) / 4,
      b = ((reverse ? 7 - i : i + 1) * Math.PI) / 4,
      k = 1 / Math.cos(Math.PI / 8)
    out.push(...at(a), ...at((a + b) / 2, k), ...at(b))
  }
  return out
}
/** Self-crossing {n/2} star: its core winds twice. */
function star(cx: number, cy: number, r: number, n = 5): number[] {
  const points = Array.from({ length: n }, (_, i): [number, number] => {
    const t = (i * 2 * 2 * Math.PI) / n + 0.3
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
  })
  return polygon(points)
}
function random(seed: number) {
  return (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
}
/** Dense random artwork: every winding case, clip, gradient, translucent and foreground paint. */
function artwork(count: number, seed: number, clipBox?: [number, number, number, number]) {
  const rnd = random(seed)
  const color = (alpha: number): Rgba => [rnd(), rnd(), rnd(), alpha]
  const paint = (): WindfoilPaint => {
    const pick = rnd()
    if (pick < 0.45) return { type: 'solid', color: color(1) }
    if (pick < 0.65) return { type: 'solid', color: color(rnd() < 0.5 ? 0.5 : 0.999) }
    if (pick < 0.75)
      return {
        type: 'linear',
        p0: [rnd() * 1000, rnd() * 1000],
        p1: [rnd() * 1000, rnd() * 1000],
        stops: [
          { offset: 0, color: color(1) },
          { offset: 1, color: color(rnd() < 0.5 ? 1 : 0.4) },
        ],
      }
    if (pick < 0.82)
      return {
        type: 'radial',
        c0: [500, 500],
        r0: 0,
        c1: [500 + rnd() * 50, 500],
        r1: 300 + rnd() * 400,
        stops: [
          { offset: 0, color: color(1) },
          { offset: 1, color: color(1) },
        ],
      }
    if (pick < 0.9)
      return {
        type: 'sweep',
        center: [rnd() * 1000, rnd() * 1000],
        startAngle: 0,
        endAngle: 360,
        stops: [
          { offset: 0, color: color(1) },
          { offset: 1, color: color(1) },
        ],
        extend: 'repeat',
      }
    return { type: 'foreground', alpha: rnd() < 0.5 ? 1 : 0.6 }
  }
  const layers = [{ quadratics: rect(0, 0, 1000, 1000), paint: paint() }]
  for (let i = 1; i < count; i++) {
    const x = 20 + rnd() * 960,
      y = 20 + rnd() * 960,
      r = 2 + rnd() ** 2 * 380,
      kind = rnd()
    let quadratics: number[]
    const clampX = (v: number): number => Math.min(1000, Math.max(0, v))
    if (kind < 0.3)
      quadratics = rect(clampX(x - r), clampX(y - r * 0.7), clampX(x + r), clampX(y + r))
    else if (kind < 0.45)
      // A ring: the hole winds back to zero.
      quadratics = [
        ...ellipse(x, y, Math.min(r, 400), Math.min(r, 400) * 0.8, rnd()),
        ...ellipse(x, y, Math.min(r, 400) * 0.5, Math.min(r, 400) * 0.3, rnd(), true),
      ]
    else if (kind < 0.55)
      // Two same-direction overlaps: winding 2 where they meet.
      quadratics = [
        ...ellipse(x, y, Math.min(r, 300), Math.min(r, 300) * 0.6, rnd()),
        ...rect(clampX(x - r * 0.3), clampX(y - r * 0.3), clampX(x + r * 0.6), clampX(y + r * 0.6)),
      ]
    else if (kind < 0.65) quadratics = star(x, y, Math.min(r, 450))
    else quadratics = ellipse(x, y, Math.min(r, 450), Math.min(r, 450) * (0.3 + rnd()), rnd() * 3)
    const clamped = quadratics.map((v) => Math.min(1000, Math.max(0, v)))
    layers.push({ quadratics: clamped, paint: paint() })
  }
  return {
    unitsPerEm: 1000,
    ascent: 1000,
    descent: 0,
    bbox: [0, 0, 1000, 1000],
    quadratics: [],
    layers,
    ...(clipBox ? { clipBox } : {}),
  } as WindfoilGlyphOutline
}
function build(
  outlines: Record<string, WindfoilGlyphOutline>,
  tuning?: { maxNodes?: number; minKey?: number },
  targetPiecesPerBand = 2,
  orient = true,
) {
  const prepared = preprocessWindfoilOutlines(
    Object.entries(outlines).map(([key, outline]) => ({ key, outline })),
    { targetPiecesPerBand, orientLayers: () => orient },
  )
  const packed = packWindfoilLayers(prepared)
  const table = appendWindfoilLayerGrids(
    packed.layers,
    packed.glyphs.values(),
    prepared,
    packed.opaque,
    undefined,
    tuning,
  )
  const tables: WalkTables = {
    table,
    curves: prepared.curves,
    rows: prepared.rows,
    paints: packed.paints,
    stops: packed.stops,
  }
  return { packed, prepared, table, tables }
}
function* nodes(table: Uint32Array, block: number) {
  const floats = new Float32Array(table.buffer, table.byteOffset, table.length)
  const stack: [number, number, number, number, number][] = [
    [block + 8, floats[block + 1]!, floats[block + 2]!, floats[block + 3]!, 0],
  ]
  while (stack.length) {
    const [record, x, y, side, depth] = stack.pop()!
    yield { record, x, y, side, depth }
    const child = table[record]!,
      half = Math.fround(side * 0.5)
    if (child)
      for (let k = 0; k < 4; k++)
        stack.push([
          child + 3 * k,
          k & 1 ? Math.fround(x + half) : x,
          k & 2 ? Math.fround(y + half) : y,
          half,
          depth + 1,
        ])
  }
}

describe('Windfoil composite layer tree', () => {
  it('tags every row with its block and keeps an unpruned top-down full list', () => {
    const { packed, table } = build({ a: artwork(7, 11) })
    expect(table.subarray(0, packed.layers.length).filter((_, i) => i % 12 !== 11)).toEqual(
      packed.layers.filter((_, i) => i % 12 !== 11),
    )
    const block = packed.layers.length
    for (let row = 0; row < 7; row++) expect(table[row * 12 + 11]).toBe(block)
    expect(table[block]).toBe(1)
    const floats = new Float32Array(table.buffer)
    expect([1, 2, 3].map((k) => floats[block + k])).toEqual([0, 0, 1000])
    // The direct-index top grid is at most 16 × 16 cells and sits after the node records.
    expect(table[block + 4]).toBeLessThanOrEqual(4)
    expect(table[block + 7]).toBeGreaterThan(block + 8)
    expect(Array.from(table.subarray(table[block + 5], table[block + 6]))).toEqual([
      6, 5, 4, 3, 2, 1, 0,
    ])
    // A footprint wider than the root's allowance walks every layer.
    expect(selectList(table, 0, 500, 500, 600, 600).depth).toBe(0)
    expect(selectList(table, 0, 500, 500, 1300, 1300)).toMatchObject({ depth: -1, cell: 0 })
    expect(selectList(table, 0, 500, 500, 1, 1).depth).toBeGreaterThan(0)
  })
  it('bounds nodes and depth, interns lists, and keeps children inside their parent lists', () => {
    const { packed, table } = build({ a: artwork(40, 5) }, { maxNodes: 777, minKey: 4 ** -12 })
    const block = packed.layers.length
    let count = 0
    const ranges = new Map<string, string>()
    for (const node of nodes(table, block)) {
      count++
      expect(node.depth).toBeLessThanOrEqual(WINDFOIL_TREE_DEPTH)
      const start = table[node.record + 1]!,
        end = table[node.record + 2]!,
        list = Array.from(table.subarray(start, end))
      // Identical lists share one range.
      const key = list.join()
      expect(ranges.get(key) ?? `${start}:${end}`).toBe(`${start}:${end}`)
      ranges.set(key, `${start}:${end}`)
      const child = table[node.record]!
      for (let k = 0; child && k < 4; k++) {
        const kid = Array.from(
          table.subarray(table[child + 3 * k + 1], table[child + 3 * k + 2]),
          (e) => e % WINDFOIL_SOLID,
        )
        // Top-down order is preserved and a child only drops or settles parent layers.
        const parent = list.map((e) => e % WINDFOIL_SOLID)
        expect(
          kid.every((layer, i) => i === 0 || parent.indexOf(layer) > parent.indexOf(kid[i - 1]!)),
        ).toBe(true)
        expect(kid.every((layer) => parent.includes(layer))).toBe(true)
      }
    }
    expect(count).toBeLessThanOrEqual(777)
    expect(count).toBeGreaterThan(700)
  })
  it('prunes exactly: every dropped, solid and truncated layer agrees with the unpruned walk', () => {
    const SAMPLES = 3000
    const outlines = {
      a: artwork(48, 3),
      b: artwork(24, 9, [180, 260, 770, 810]),
      c: artwork(12, 17),
    }
    const { packed, table, tables } = build(outlines, { maxNodes: 6000, minKey: 4 ** -9 })
    // Wide layers are filed in vertical bands; both orientations must prune exactly.
    const flags = Array.from({ length: packed.layers.length / 12 }, (_, i) => table[i * 12 + 9]!)
    expect(flags.filter((flag) => flag & 2).length).toBeGreaterThan(10)
    expect(flags.filter((flag) => !(flag & 2)).length).toBeGreaterThan(10)
    const rnd = random(21)
    let solids = 0,
      drops = 0,
      truncations = 0,
      deep = 0,
      worst = 0
    for (const header of packed.glyphs.values()) {
      const block = table[header.layerStart * 12 + 11]!,
        cells = [...nodes(table, block)]
      for (let n = 0; n < SAMPLES; n++) {
        let x = -30 + rnd() * 1060,
          y = -30 + rnd() * 1060
        // Half the samples straddle a cell edge within a few footprints.
        const size = 10 ** (-3 + rnd() * 5.5),
          sx = Math.fround(size * (0.5 + rnd())),
          sy = Math.fround(size * (0.5 + rnd()))
        if (rnd() < 0.5) {
          const cell = cells[Math.floor(rnd() * cells.length)]!,
            jitter = (rnd() - 0.5) * 4 * size
          x = rnd() < 0.5 ? cell.x + jitter : cell.x + rnd() * cell.side
          y = rnd() < 0.5 ? cell.y + jitter : cell.y + rnd() * cell.side
        }
        x = Math.fround(x)
        y = Math.fround(y)
        const pick = selectList(table, header.layerStart, x, y, sx, sy)
        if (pick.depth >= 4) deep++
        const list = Array.from(table.subarray(pick.start, pick.end))
        const kept = new Set(list.map((e) => e % WINDFOIL_SOLID))
        // Walk the unpruned list and check each layer the pruned list settled or dropped.
        const full = compositeWalk(tables, header.layerStart, x, y, sx, sy, { tree: false })
        const pruned = compositeWalk(tables, header.layerStart, x, y, sx, sy)
        for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(full[k]! - pruned[k]!))
        // Shadow masks agree at any cutoff. Only the thresholded union is observable: at an
        // exact tie a settled layer's coverage of 1 may walk on where 1 + ε stopped.
        for (const cutoff of [0.5, 0.9995]) {
          const a = shadowWalk(tables, header.layerStart, x, y, sx, sy, cutoff),
            b = shadowWalk(tables, header.layerStart, x, y, sx, sy, cutoff, false)
          expect(a > cutoff, JSON.stringify({ x, y, sx, sy, a, b })).toBe(b > cutoff)
        }
        const truncatedAt = list.length && list.at(-1)! >= WINDFOIL_SOLID ? list.at(-1)! : null
        for (const entry of list) {
          if (entry < WINDFOIL_SOLID) continue
          const row = (entry - WINDFOIL_SOLID) * 12,
            coverage = layerCoverage(tables, row, x, y, sx, sy)
          solids++
          expect(coverage, JSON.stringify({ x, y, sx, sy, entry })).not.toBeNull()
          expect(coverage!).toBeGreaterThan(1 - 1e-6)
        }
        let stop = header.layerStart - 1
        if (truncatedAt !== null && packed.opaque[truncatedAt - WINDFOIL_SOLID]) {
          stop = truncatedAt - WINDFOIL_SOLID
          truncations++
          const paint = evaluatePaint(tables, table[stop * 12 + 8]!, x, y, [1, 1, 1, 1])
          expect(paint[3]).toBeCloseTo(1, 6)
        }
        for (let layer = header.layerStart + header.layerCount - 1; layer > stop; layer--) {
          if (kept.has(layer)) continue
          drops++
          const coverage = layerCoverage(tables, layer * 12, x, y, sx, sy)
          expect(coverage ?? 0, JSON.stringify({ x, y, sx, sy, layer })).toBeLessThan(1e-6)
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-6)
    console.log({ solids, drops, truncations, deep, worst })
    expect(solids).toBeGreaterThan(2000)
    expect(drops).toBeGreaterThan(20000)
    expect(truncations).toBeGreaterThan(1000)
    expect(deep).toBeGreaterThan(1000)
  }, 60_000)
  it('cuts the walk on dense artwork while the pruned image stays the unpruned one', () => {
    const { packed, tables } = build({ a: artwork(57, 29) })
    const header = packed.glyphs.get('a')!,
      rnd = random(4),
      tree = walkCounters(),
      full = walkCounters()
    for (let n = 0; n < 4000; n++) {
      const x = Math.fround(rnd() * 1000),
        y = Math.fround(rnd() * 1000),
        px = Math.fround(10 ** (-2 + rnd() * 2))
      const a = compositeWalk(tables, header.layerStart, x, y, px, px, { counters: tree })
      const b = compositeWalk(tables, header.layerStart, x, y, px, px, {
        tree: false,
        counters: full,
      })
      for (let k = 0; k < 4; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThanOrEqual(1e-6)
    }
    expect(tree.entries).toBeLessThan(full.entries / 8)
    expect(tree.integrals).toBeLessThan(full.integrals / 2)
    expect(tree.solid).toBeGreaterThan(1000)
  })
  it('leaves open contours and profile-sized layers to the per-pixel test', () => {
    const open = {
      unitsPerEm: 100,
      ascent: 100,
      descent: 0,
      bbox: [0, 0, 100, 100],
      quadratics: [],
      layers: [
        // Three sides of a square: no closed winding, so it may not be settled.
        {
          quadratics: [...line(10, 10, 90, 10), ...line(90, 10, 90, 90), ...line(90, 90, 10, 90)],
          paint: { type: 'solid', color: [1, 0, 0, 1] },
        },
        { quadratics: rect(0, 0, 100, 100), paint: { type: 'solid', color: [0, 0, 1, 0.5] } },
        { quadratics: rect(40, 40, 40.5, 40.5), paint: { type: 'solid', color: [0, 1, 0, 1] } },
      ],
    } as WindfoilGlyphOutline
    const { packed, table } = build({ open }, { minKey: 4 ** -10 })
    const block = table[11]!
    for (const node of nodes(table, block)) {
      const list = Array.from(table.subarray(table[node.record + 1], table[node.record + 2]))
      // The open layer (row 0) is dropped only by its box, never settled solid.
      expect(list).not.toContain(0 + WINDFOIL_SOLID)
      if (node.x + node.side < 10 || node.x > 90 || node.y + node.side < 10 || node.y > 90) continue
      const reach = node.side * 0.15625
      if (node.x - reach <= 90 && node.x + node.side + reach >= 10) expect(list).toContain(0)
    }
    expect(packed.glyphs.get('open')!.layerCount).toBe(3)
  })
  it('files wide composite layers in vertical bands without changing their coverage', () => {
    const outline = {
      unitsPerEm: 1000,
      ascent: 1000,
      descent: 0,
      bbox: [0, 0, 1000, 1000],
      quadratics: [],
      layers: [
        {
          quadratics: ellipse(500, 300, 450, 40, 0.05),
          paint: { type: 'solid', color: [1, 0, 0, 1] },
        },
        { quadratics: ellipse(300, 500, 40, 420), paint: { type: 'solid', color: [0, 1, 0, 1] } },
        { quadratics: star(600, 650, 300, 7), paint: { type: 'solid', color: [0, 0, 1, 0.5] } },
      ],
    } as WindfoilGlyphOutline
    const rows = build({ a: outline }, undefined, 2, false),
      columns = build({ a: outline }, undefined, 2, true)
    const flags = [0, 1, 2].map((layer) => columns.table[layer * 12 + 9]! & 2)
    // Only the wide ellipse is cheaper to walk along x; nothing moves without the option.
    expect(flags).toEqual([2, 0, 0])
    expect([0, 1, 2].map((layer) => rows.table[layer * 12 + 9]! & 2)).toEqual([0, 0, 0])
    expect(columns.prepared.glyphs.get('a')!.layers![0]!.transposed).toBe(true)
    // Bands clip ink only along their axis: a box that cuts into the ink keeps rows.
    const clipped = { ...outline.layers![0]!, bbox: [70, 270, 930, 330] as const }
    const cut = build({ a: { ...outline, layers: [clipped] } }, {}, 2, true)
    expect(cut.table[9]! & 2).toBe(0)
    const rnd = random(8)
    for (let n = 0; n < 3000; n++) {
      const x = rnd() * 1000,
        y = rnd() * 1000,
        size = 10 ** (-1 + rnd() * 2.5)
      for (let layer = 0; layer < 3; layer++) {
        const a = layerCoverage(rows.tables, layer * 12, x, y, size, size * 0.7),
          b = layerCoverage(columns.tables, layer * 12, x, y, size, size * 0.7)
        // Footprints stay below the profile path's size, where band direction matters.
        expect(b ?? 0).toBeCloseTo(a ?? 0, 6)
      }
    }
  })
  it('treats only paints that are exactly opaque everywhere as occluders', () => {
    const opaque = (paint: WindfoilPaint): boolean =>
      windfoilPaintOpaque(normalizeWindfoilPaint(paint))
    const stops = (a: number, b: number) => [
      { offset: 0, color: [1, 0, 0, a] as Rgba },
      { offset: 1, color: [0, 0, 1, b] as Rgba },
    ]
    expect(opaque({ type: 'solid', color: [1, 0, 0, 1] })).toBe(true)
    // 0.999 packs to byte 255, exactly 1 in colour passes, but shadows read the raw 0.999.
    expect(opaque({ type: 'solid', color: [1, 0, 0, 0.999] })).toBe(false)
    expect(opaque({ type: 'solid', color: [1, 0, 0, 0.99] })).toBe(false)
    expect(opaque({ type: 'foreground' })).toBe(false)
    expect(opaque({ type: 'linear', p0: [0, 0], p1: [1, 0], stops: stops(1, 1) })).toBe(true)
    expect(opaque({ type: 'linear', p0: [0, 0], p1: [1, 0], stops: stops(1, 0.5) })).toBe(false)
    expect(
      opaque({ type: 'sweep', center: [0, 0], startAngle: 0, endAngle: 90, stops: stops(1, 1) }),
    ).toBe(true)
    // Two-point conical gradients can be undefined (transparent) off their cone.
    expect(
      opaque({ type: 'radial', c0: [0, 0], r0: 0, c1: [0, 0], r1: 5, stops: stops(1, 1) }),
    ).toBe(false)
  })
  it('stops building when aborted', () => {
    const controller = new AbortController()
    const prepared = preprocessWindfoilOutlines([{ key: 'a', outline: artwork(20, 2) }])
    const packed = packWindfoilLayers(prepared)
    controller.abort(new Error('stop'))
    expect(() =>
      appendWindfoilLayerGrids(
        packed.layers,
        packed.glyphs.values(),
        prepared,
        packed.opaque,
        controller.signal,
      ),
    ).toThrow('stop')
  })
})
