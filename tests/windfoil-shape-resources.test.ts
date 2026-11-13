import { WebGPUBackend, type BufferAttribute, type WebGPURenderer } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'
import type { WindfoilGlyphOutline } from '../src/types.js'
import { acquireWindfoilShapeResources } from '../src/windfoil/shapeResources.js'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'

const box = svgToWindfoilOutlines({ d: 'M0 0H10V10H0Z' }).outline
function harness() {
  const destroyAttribute = vi.fn<(attribute: BufferAttribute) => void>()
  const backend = Object.create(WebGPUBackend.prototype) as WebGPUBackend
  Object.assign(backend, { has: () => true, destroyAttribute })
  return {
    renderer: {
      backend,
      info: { destroyAttribute: vi.fn() },
    } as unknown as WebGPURenderer,
    destroyAttribute,
  }
}
function acquire(
  renderer: WebGPURenderer,
  source: Readonly<Record<string, WindfoilGlyphOutline>>,
  shader = false,
  target?: number,
  signal?: AbortSignal,
) {
  return acquireWindfoilShapeResources(
    renderer,
    source,
    Object.entries(source),
    shader,
    target,
    signal,
  )
}
function layered() {
  return {
    box: {
      ...box,
      quadratics: [],
      layers: [
        {
          quadratics: box.quadratics,
          paint: {
            type: 'solid' as const,
            color: [1, 0, 0, 1] as [number, number, number, number],
          },
        },
      ],
    },
  }
}
function customIterator<T extends readonly unknown[]>(values: T): T {
  return Object.assign([...values], {
    [Symbol.iterator](): never {
      throw new Error('Snapshots must read numeric indices')
    },
  }) as unknown as T
}
function indexedCurves(values: ArrayLike<number>): ArrayLike<number> {
  return Object.assign(
    { length: values.length },
    Object.fromEntries(Array.from({ length: values.length }, (_value, i) => [i, values[i]!])),
    {
      [Symbol.iterator](): never {
        throw new Error('Snapshots must read numeric indices')
      },
    },
  )
}

describe('active Windfoil shape resources', () => {
  it('shares preprocessing, color packing and layer indexes until the last lease releases', async () => {
    const h = harness(),
      source = layered()
    const a = await acquire(h.renderer, source, true)
    const b = await acquire(h.renderer, source, true)
    expect(b.prepared).toBe(a.prepared)
    expect(b.storage).toBe(a.storage)
    expect(b.colorResources).toBe(a.colorResources)
    expect(b.colorResources!.composite).toBe(a.colorResources!.composite)
    expect(b.preprocessMs).toBe(0)
    a.release()
    a.release()
    expect(h.destroyAttribute).not.toHaveBeenCalled()
    b.release()
    b.release()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(5)
    const next = await acquire(h.renderer, source, true)
    expect(next.prepared).not.toBe(a.prepared)
    expect(next.storage).not.toBe(a.storage)
    next.release()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(10)
  })
  it('reuses equivalent replacement objects inside one source without retaining mutable data', async () => {
    const h = harness(),
      source = layered()
    const a = await acquire(h.renderer, source, true)
    source.box = {
      ...source.box,
      layers: source.box.layers.map((layer) => ({
        ...layer,
        quadratics: Array.from(layer.quadratics),
        paint: { ...layer.paint, color: [...layer.paint.color] },
      })),
    }
    const b = await acquire(h.renderer, source, true)
    expect(b.prepared).toBe(a.prepared)
    source.box.layers[0]!.paint.color[0] = 0
    source.box.layers[0]!.paint.color[1] = 1
    const changed = await acquire(h.renderer, source, true)
    expect(changed.prepared).not.toBe(a.prepared)
    expect(changed.colorResources).not.toBe(a.colorResources)
    expect(a.prepared.glyphs.get('box')!.layers![0]!.rgba).toEqual([1, 0, 0, 1])
    expect(changed.prepared.glyphs.get('box')!.layers![0]!.rgba).toEqual([0, 1, 0, 1])
    a.release()
    b.release()
    changed.release()
  })
  it('keeps a null layer list as the empty layered outline validation accepts', async () => {
    const h = harness(),
      source = { box: { ...box, layers: null } } as unknown as Readonly<
        Record<string, WindfoilGlyphOutline>
      >
    for (const shader of [false, true]) {
      const a = await acquire(h.renderer, source, shader)
      const b = await acquire(h.renderer, source, shader)
      expect(b.prepared).toBe(a.prepared)
      // Its base curves are the one foreground layer, unlike an outline without a layer list.
      expect(a.prepared.glyphs.get('box')!.layers).toHaveLength(1)
      const plain = await acquire(h.renderer, { box }, shader)
      expect(plain.prepared.glyphs.get('box')!.layers === undefined).toBe(!shader)
      a.release()
      b.release()
      plain.release()
    }
  })
  it('snapshots supported array-like outlines and paints by numeric index', async () => {
    const h = harness()
    const plain = {
      box: { ...box, bbox: customIterator(box.bbox), quadratics: indexedCurves(box.quadratics) },
    }
    const p = await acquire(h.renderer, plain)
    expect(p.prepared.stats.monotonePieces).toBe(4)
    expect(p.prepared.glyphs.get('box')!.bbox).toEqual(box.bbox)
    const source = {
      box: {
        ...box,
        bbox: customIterator(box.bbox),
        quadratics: indexedCurves([]),
        clipBox: customIterator(box.bbox),
        layers: customIterator([
          {
            quadratics: indexedCurves(box.quadratics),
            bbox: customIterator(box.bbox),
            paint: { type: 'solid' as const, color: customIterator([1, 0, 0, 1] as const) },
          },
        ]),
      },
    }
    const a = await acquire(h.renderer, source, true)
    const b = await acquire(h.renderer, source, true)
    expect(a.prepared.stats.monotonePieces).toBe(4)
    expect(a.prepared.glyphs.get('box')!.bbox).toEqual(box.bbox)
    expect(a.prepared.glyphs.get('box')!.clipBox).toEqual(box.bbox)
    expect(a.prepared.glyphs.get('box')!.layers![0]!.rgba).toEqual([1, 0, 0, 1])
    expect(b.prepared).toBe(a.prepared)
    for (const lease of [p, a, b]) lease.release()
  })
  it('copies gradient array tuples by index while preserving invalid tuple rejection', async () => {
    const h = harness()
    const paint = {
      type: 'linear' as const,
      p0: customIterator([0, 0] as const),
      p1: customIterator([1000, 0] as const),
      p2: customIterator([0, 1000] as const),
      transform: customIterator([1, 0, 0, 1, 0, 0] as const),
      stops: customIterator([
        { offset: 0, color: customIterator([1, 0, 0, 1] as const) },
        { offset: 1, color: customIterator([0, 0, 1, 1] as const) },
      ]),
    }
    const source = {
      box: { ...box, quadratics: [], layers: [{ quadratics: box.quadratics, paint }] },
    }
    const a = await acquire(h.renderer, source, true)
    const b = await acquire(h.renderer, source, true)
    expect(a.prepared.glyphs.get('box')!.layers![0]!.paint).toEqual({
      type: 'linear',
      p0: [0, 0],
      p1: [1000, 0],
      p2: [0, 1000],
      transform: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    })
    expect(b.prepared).toBe(a.prepared)
    const invalid = {
      box: {
        ...source.box,
        layers: [
          {
            quadratics: box.quadratics,
            paint: {
              ...paint,
              p0: new Float32Array([0, 0]) as unknown as readonly [number, number],
            },
          },
        ],
      },
    }
    await expect(acquire(h.renderer, invalid, true)).rejects.toThrow('p0')
    for (const lease of [a, b]) lease.release()
  })
  it('detects typed curve, metadata, outline-key and gradient mutations', async () => {
    const h = harness()
    const curves = Float64Array.from(box.quadratics)
    const source = { box: { ...box, quadratics: curves } }
    const a = await acquire(h.renderer, source)
    curves[2] = curves[2]! + 1
    const curveChange = await acquire(h.renderer, source)
    expect(curveChange.prepared).not.toBe(a.prepared)
    source.box = { ...source.box, unitsPerEm: box.unitsPerEm * 2 }
    const metadataChange = await acquire(h.renderer, source)
    expect(metadataChange.prepared).not.toBe(curveChange.prepared)
    const renamed = { other: source.box }
    const keyChange = await acquireWindfoilShapeResources(
      h.renderer,
      source,
      Object.entries(renamed),
      false,
    )
    expect(keyChange.prepared.glyphs.has('other')).toBe(true)
    const stops = [
      { offset: 0, color: [1, 0, 0, 1] as const },
      { offset: 1, color: [0, 0, 1, 1] as const },
    ]
    const gradient = {
      box: {
        ...box,
        quadratics: [],
        layers: [
          {
            quadratics: box.quadratics,
            paint: { type: 'linear' as const, p0: [0, 0] as const, p1: [1000, 0] as const, stops },
          },
        ],
      },
    }
    const g = await acquire(h.renderer, gradient, true)
    stops[0]!.offset = 0.25
    const gradientChange = await acquire(h.renderer, gradient, true)
    expect(gradientChange.colorResources).not.toBe(g.colorResources)
    for (const lease of [a, curveChange, metadataChange, keyChange, g, gradientChange])
      lease.release()
  })
  it('separates compositing, band tuning, source identity, renderers and replacement devices', async () => {
    const h = harness(),
      other = harness(),
      source = layered()
    const a = await acquire(h.renderer, source)
    const canonical = await acquire(h.renderer, source, false, 10)
    expect(canonical.prepared).toBe(a.prepared)
    const shader = await acquire(h.renderer, source, true)
    const tuning = await acquire(h.renderer, source, false, 1)
    const copy = await acquire(h.renderer, { ...source })
    const renderer = await acquire(other.renderer, source)
    Object.assign(h.renderer.backend, { device: {} })
    const device = await acquire(h.renderer, source)
    for (const lease of [shader, tuning, copy, renderer, device])
      expect(lease.storage).not.toBe(a.storage)
    for (const lease of [a, canonical, shader, tuning, copy, renderer, device]) lease.release()
  })
  it('lets one cancelled concurrent lease reject without cancelling the survivor', async () => {
    const h = harness(),
      source = layered(),
      controller = new AbortController()
    const a = acquire(h.renderer, source, true, undefined, controller.signal)
    const b = acquire(h.renderer, source, true)
    controller.abort('cancel one')
    await expect(a).rejects.toBe('cancel one')
    const survivor = await b
    expect(survivor.prepared.stats.uniqueGlyphs).toBe(1)
    expect(h.destroyAttribute).not.toHaveBeenCalled()
    survivor.release()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(5)
  })
  it('releases abandoned builds and does not retain rejected resources', async () => {
    const h = harness(),
      source = { box },
      controller = new AbortController()
    const abandoned = acquire(h.renderer, source, false, undefined, controller.signal)
    controller.abort('abandon')
    await expect(abandoned).rejects.toBe('abandon')
    expect(h.destroyAttribute).toHaveBeenCalledTimes(2)
    const fresh = await acquire(h.renderer, source)
    expect(fresh.preprocessMs).toBeGreaterThanOrEqual(0)
    fresh.release()
    const gradient = {
      box: {
        ...box,
        quadratics: [],
        layers: [
          {
            quadratics: box.quadratics,
            paint: {
              type: 'linear' as const,
              p0: [0, 0] as const,
              p1: [1000, 0] as const,
              stops: [{ offset: NaN, color: [1, 0, 0, 1] as const }],
            },
          },
        ],
      },
    }
    await expect(acquire(h.renderer, gradient, true)).rejects.toThrow('must be finite')
    expect(h.destroyAttribute).toHaveBeenCalledTimes(6)
    gradient.box.layers[0]!.paint.stops[0]!.offset = 0
    const repaired = await acquire(h.renderer, gradient, true)
    expect(repaired.colorResources!.composite).not.toBeNull()
    repaired.release()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(11)
  })
})
