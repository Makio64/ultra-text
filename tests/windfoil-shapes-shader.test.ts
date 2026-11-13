import {
  DoubleSide,
  WebGPUBackend,
  type BufferAttribute,
  type InstancedBufferGeometry,
  type Mesh,
  type WebGPURenderer,
} from 'three/webgpu'
import type { GlyphTextMaterial } from '../src/text/GlyphTextMaterial.js'
import { describe, expect, it, vi } from 'vitest'
import { buildWindfoilShapes } from '../src/windfoil/shapes.js'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'
import type { WindfoilGlyphOutline } from '../src/types.js'
const outline = svgToWindfoilOutlines({ d: 'M0 0H10V10H0Z' }).outline
function rendererHarness() {
  const destroyAttribute = vi.fn<(attribute: BufferAttribute) => void>(),
    init = vi.fn(() => Promise.resolve())
  const backend = Object.assign(Object.create(WebGPUBackend.prototype) as object, {
    has: () => true,
    destroyAttribute,
  })
  return {
    renderer: { backend, init, info: { destroyAttribute: vi.fn() } } as unknown as WebGPURenderer,
    destroyAttribute,
    init,
  }
}
const layered: WindfoilGlyphOutline = {
  ...outline,
  quadratics: [],
  layers: [
    { quadratics: outline.quadratics, paint: { type: 'solid', color: [1, 0, 0, 0.5] } },
    { quadratics: outline.quadratics, paint: { type: 'foreground', alpha: 0.25 } },
    { quadratics: outline.quadratics, paint: { type: 'solid', color: [0, 1, 0, 1] } },
  ],
}
const instance = { shape: 'art', x: -10, y: 20, size: 40 }
describe("Windfoil shapes with compositing: 'shader'", () => {
  it('keeps one cell per glyph when the index would pass the storage binding limit', async () => {
    const box = (x0: number, x1: number): number[] => {
      const edge = (a: number, b: number, c: number, d: number) => [
        a,
        b,
        (a + c) / 2,
        (b + d) / 2,
        c,
        d,
      ]
      return [
        ...edge(x0, 0, x1, 0),
        ...edge(x1, 0, x1, 10),
        ...edge(x1, 10, x0, 10),
        ...edge(x0, 10, x0, 0),
      ]
    }
    const art: WindfoilGlyphOutline = {
      ...outline,
      quadratics: [],
      layers: Array.from({ length: 12 }, (_, i) => ({
        quadratics: box(i * 0.4, i * 0.4 + 5),
        paint: {
          type: 'solid' as const,
          color: [i / 12, 0, 0, 1] as [number, number, number, number],
        },
      })),
    }
    const built: { bytes: number; root: number }[] = []
    for (const limit of [undefined, 2048]) {
      const { renderer } = rendererHarness()
      if (limit)
        Object.assign(renderer.backend, {
          device: { limits: { maxStorageBufferBindingSize: limit } },
        })
      const handle = await buildWindfoilShapes(renderer, { art }, [instance], {
        compositing: 'shader',
      })
      const table = (
        handle.mesh.material as unknown as { windfoilLayers: { value: { array: Uint32Array } } }
      ).windfoilLayers.value.array
      built.push({ bytes: table.byteLength, root: table[table[11]! + 8]! })
      handle.dispose()
    }
    expect(built[0]!.bytes).toBeGreaterThan(2048)
    expect(built[0]!.root).toBeGreaterThan(0)
    // The fallback's root is a leaf: every pixel walks the root's classified list.
    expect(built[1]!.root).toBe(0)
    expect(built[1]!.bytes).toBeLessThan(2048)
  })
  it('draws one composite quad per instance and keeps instance opacity for the group', async () => {
    const { renderer } = rendererHarness()
    const handle = await buildWindfoilShapes(
      renderer,
      { art: layered },
      [{ ...instance, opacity: 0.5, color: '#00f', sequence: 2, z: 3 }],
      { compositing: 'shader', side: DoubleSide, shadowCutoff: 0.25 },
    )
    const mesh = handle.mesh as Mesh<InstancedBufferGeometry, GlyphTextMaterial>
    const geometry = mesh.geometry
    expect(handle.stats.instances).toBe(1)
    expect(geometry.instanceCount).toBe(1)
    expect(mesh.material.name).toBe('ultra-text TSL Windfoil colour')
    expect(mesh.material.side).toBe(DoubleSide)
    expect(
      (mesh.material as unknown as { shadowCutoff: { value: number } }).shadowCutoff.value,
    ).toBe(0.25)
    expect(geometry.getAttribute('windfoilBand')).toBeUndefined()
    expect(geometry.getAttribute('windfoilLayer')).toBeUndefined()
    expect(Array.from(geometry.getAttribute('windfoilLayers').array)).toEqual([0, 3, 0])
    expect(geometry.getAttribute('sdfRect').array).toEqual(new Float32Array([-10, 20, 30, 60]))
    // Paint alpha stays in the layer table; the instance colour/opacity is written once.
    expect(geometry.getAttribute('sdfColor').array).toEqual(new Uint8Array([0, 0, 255, 128]))
    expect(Array.from(geometry.getAttribute('sdfMeta').array)).toEqual([2, 3])
    expect(geometry.boundingBox!.min.toArray()).toEqual([-10, 20, 3])
    expect(geometry.boundingBox!.max.toArray()).toEqual([30, 60, 3])
    expect(mesh.material.maxSequence.value).toBe(2)
    handle.dispose()
  })
  it('wraps plain outlines as one foreground layer so one mesh draws every shape', async () => {
    const { renderer } = rendererHarness()
    const handle = await buildWindfoilShapes(
      renderer,
      { box: outline, art: layered },
      [
        { ...instance, shape: 'box' },
        { ...instance, shape: 'art' },
      ],
      { compositing: 'shader' },
    )
    expect(handle.children).toEqual([handle.mesh])
    expect(handle.stats.instances).toBe(2)
    // Keys are packed in sorted order: art rows 0..2, box row 3.
    expect(Array.from(handle.mesh.geometry.getAttribute('windfoilLayers').array)).toEqual([
      3, 1, 0, 0, 3, 1,
    ])
    handle.dispose()
  })
  it('accepts clipBox only in shader mode and clips the composite quad analytically', async () => {
    const h = rendererHarness()
    const clipped = { ...outline, clipBox: [0, 0, 500, 1000] as const }
    await expect(buildWindfoilShapes(h.renderer, { art: clipped }, [instance])).rejects.toThrow(
      'does not support outline clipBox',
    )
    expect(h.init).not.toHaveBeenCalled()
    const handle = await buildWindfoilShapes(h.renderer, { art: clipped }, [instance], {
      compositing: 'shader',
    })
    const layers = handle.mesh.geometry.getAttribute('windfoilLayers').array
    expect(layers[1]).toBe(-1)
    expect(handle.mesh.geometry.getAttribute('sdfRect').array).toEqual(
      new Float32Array([-10, 20, 10, 60]),
    )
    handle.dispose()
  })
  it('rejects unknown compositing before initialization', async () => {
    const h = rendererHarness()
    await expect(
      buildWindfoilShapes(h.renderer, { art: layered }, [instance], {
        compositing: 'painter' as 'layers',
      }),
    ).rejects.toThrow("compositing must be 'layers' or 'shader'")
    expect(h.init).not.toHaveBeenCalled()
  })
  it('rewrites equal counts in place, swaps changed counts, and keeps instance ordinals', async () => {
    const { renderer } = rendererHarness()
    const blank: WindfoilGlyphOutline = { ...outline, quadratics: [], layers: [] }
    const handle = await buildWindfoilShapes(renderer, { art: layered, blank }, [instance], {
      compositing: 'shader',
    })
    const first = handle.mesh.geometry
    handle.setInstances([{ ...instance, x: 0 }])
    expect(handle.mesh.geometry).toBe(first)
    expect(first.getAttribute('sdfRect').array).toEqual(new Float32Array([0, 20, 40, 60]))
    expect(first.boundingBox!.min.x).toBe(0)
    const disposed = vi.spyOn(first, 'dispose')
    // The blank instance draws nothing but still consumes ordinal 0, as in layer mode.
    handle.setInstances([{ ...instance, shape: 'blank' }, instance, { ...instance, x: 50 }])
    expect(disposed).toHaveBeenCalledOnce()
    expect(handle.stats.instances).toBe(2)
    expect(Array.from(handle.mesh.geometry.getAttribute('windfoilLayers').array)).toEqual([
      0, 3, 1, 0, 3, 2,
    ])
    expect(() => {
      handle.setInstances([{ ...instance, shape: 'missing' }])
    }).toThrow('is not an outline key')
    expect(handle.stats.instances).toBe(2)
    handle.dispose()
  })
  it('releases curve, row, paint, stop and layer storage exactly once', async () => {
    const h = rendererHarness()
    const handle = await buildWindfoilShapes(h.renderer, { art: layered }, [instance], {
      compositing: 'shader',
    })
    handle.dispose()
    handle.dispose()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(5)
    expect(() => {
      handle.setInstances([instance])
    }).toThrow('disposed')
  })
})
