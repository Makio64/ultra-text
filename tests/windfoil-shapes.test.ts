import {
  Color,
  DoubleSide,
  WebGPUBackend,
  type BufferAttribute,
  type Material,
  type WebGPURenderer,
} from 'three/webgpu'
import { vec4 } from 'three/tsl'
import { describe, expect, it, vi } from 'vitest'
import { buildWindfoilShapes } from '../src/windfoil/shapes.js'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'
import type { WindfoilGlyphOutline } from '../src/types.js'
const outline = svgToWindfoilOutlines({ d: 'M0 0H10V10H0Z' }).outline
function rendererHarness(gpu = true) {
  const destroyAttribute = vi.fn<(attribute: BufferAttribute) => void>(),
    destroyInfoAttribute = vi.fn(),
    init = vi.fn(() => Promise.resolve())
  const backend = gpu ? (Object.create(WebGPUBackend.prototype) as object) : {}
  Object.assign(backend, { has: () => true, destroyAttribute })
  return {
    renderer: {
      backend,
      init,
      info: { destroyAttribute: destroyInfoAttribute },
    } as unknown as WebGPURenderer,
    destroyAttribute,
    destroyInfoAttribute,
    init,
  }
}
const instance = { shape: 'box', x: -10, y: 20, size: 40 }
describe('Windfoil shapes handle', () => {
  it('builds one instanced mesh with motion disabled and correctly placed rects', async () => {
    const { renderer } = rendererHarness(),
      handle = await buildWindfoilShapes(renderer, { box: outline }, [instance])
    expect(handle.children).toEqual([handle.mesh])
    expect(handle.mesh.frustumCulled).toBe(false)
    expect(handle.mesh.castShadow).toBe(true)
    expect(handle.mesh.matrixAutoUpdate).toBe(false)
    expect(handle.mesh.geometry.getAttribute('sdfRect').array).toEqual(
      new Float32Array([-10, 20, 30, 60]),
    )
    expect(handle.mesh.geometry.boundingBox!.min.toArray()).toEqual([-10, 20, 0])
    expect(handle.mesh.geometry.boundingBox!.max.toArray()).toEqual([30, 60, 0])
    expect(handle.stats).toMatchObject({ shapes: 1, instances: 1, monotonePieces: 4 })
    expect(Object.isFrozen(handle.stats)).toBe(true)
    expect(
      (handle.mesh.material as { motionEnabled?: { value: number } }).motionEnabled?.value,
    ).toBe(0)
    handle.dispose()
  })
  it('keeps the exact coverage of shape paint: no shape material carries the text tone', async () => {
    const { renderer } = rendererHarness()
    const layered: WindfoilGlyphOutline = {
      ...outline,
      quadratics: [],
      layers: [
        { quadratics: outline.quadratics, paint: { type: 'solid', color: [1, 0, 0, 1] } },
        { quadratics: outline.quadratics, paint: { type: 'foreground' } },
      ],
    }
    for (const [source, options] of [
      [outline, {}],
      [outline, { fill: () => vec4(1, 0, 0, 1) }],
      [layered, {}],
      [layered, { compositing: 'shader' }],
    ] as const) {
      const handle = await buildWindfoilShapes(renderer, { box: source }, [instance], options)
      expect((handle.mesh.material as unknown as { tone: unknown }).tone).toBeNull()
      handle.dispose()
    }
  })
  it('normalizes colors and passes custom fill and material options', async () => {
    const { renderer } = rendererHarness(),
      fill = () => vec4(1, 0, 0, 1),
      handle = await buildWindfoilShapes(
        renderer,
        new Map([['box', outline]]),
        [
          {
            ...instance,
            color: new Color('#ff8000'),
            opacity: 0.5,
            z: 3,
            sequence: 7,
            clip: [-50, -20, 50, 100],
          },
        ],
        { fill, side: DoubleSide, castShadow: false, shadowCutoff: 0.25 },
      )
    expect(handle.mesh.geometry.getAttribute('sdfColor').array).toEqual(
      new Uint8Array([255, 128, 0, 128]),
    )
    expect(handle.mesh.geometry.getAttribute('sdfMeta').array).toEqual(new Float32Array([7, 3]))
    expect(handle.mesh.material).toMatchObject({ side: DoubleSide, maxSequence: { value: 7 } })
    expect(handle.mesh.castShadow).toBe(false)
    expect(handle.setMotion({ enabled: true, mode: 'scale' })).toBe(handle)
    handle.dispose()
  })
  it('validates before initializing and supports abort and WebGL failures', async () => {
    const h = rendererHarness()
    await expect(
      buildWindfoilShapes(h.renderer, { box: outline }, [{ ...instance, size: 0 }]),
    ).rejects.toThrow('positive size')
    await expect(
      buildWindfoilShapes(h.renderer, { box: outline }, [{ ...instance, shape: 'missing' }]),
    ).rejects.toThrow('outline key')
    await expect(
      buildWindfoilShapes(h.renderer, { box: outline }, [{ ...instance, opacity: 2 }]),
    ).rejects.toThrow('opacity')
    await expect(
      buildWindfoilShapes(h.renderer, { box: outline }, [{ ...instance, clip: [2, 2, 1, 1] }]),
    ).rejects.toThrow('clip')
    expect(h.init).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort('cancel')
    await expect(
      buildWindfoilShapes(h.renderer, { box: outline }, [instance], { signal: controller.signal }),
    ).rejects.toBe('cancel')
    await expect(
      buildWindfoilShapes(rendererHarness(false).renderer, { box: outline }, [instance]),
    ).rejects.toThrow('requires the WebGPU backend')
  })
  it('rejects initialization abort without allocating storage', async () => {
    const h = rendererHarness(),
      controller = new AbortController()
    h.init.mockReturnValue(new Promise(() => undefined))
    const pending = buildWindfoilShapes(h.renderer, { box: outline }, [instance], {
      signal: controller.signal,
    })
    controller.abort('stop')
    await expect(pending).rejects.toBe('stop')
    expect(h.destroyAttribute).not.toHaveBeenCalled()
  })
  it('rejects glyph-local clipBox before initialization or allocation', async () => {
    const h = rendererHarness()
    await expect(
      buildWindfoilShapes(h.renderer, { box: { ...outline, clipBox: [0, 0, 500, 500] } }, [
        instance,
      ]),
    ).rejects.toThrow('does not support outline clipBox')
    expect(h.init).not.toHaveBeenCalled()
    expect(h.destroyAttribute).not.toHaveBeenCalled()
  })
  it('rewrites equal counts and swaps geometry transactionally', async () => {
    const { renderer } = rendererHarness(),
      handle = await buildWindfoilShapes(renderer, { box: outline }, [instance]),
      old = handle.mesh.geometry,
      dispose = vi.spyOn(old, 'dispose')
    handle.setInstances([{ ...instance, x: 30, sequence: 8 }])
    expect(handle.mesh.geometry).toBe(old)
    expect(old.getAttribute('sdfRect').array[0]).toBe(30)
    expect(() => handle.setInstances([{ ...instance, opacity: -1 }])).toThrow()
    expect(handle.mesh.geometry).toBe(old)
    handle.setInstances([instance, instance])
    expect(handle.mesh.geometry).not.toBe(old)
    expect(dispose).toHaveBeenCalledOnce()
    expect(handle.stats.instances).toBe(2)
    expect(Object.isFrozen(handle.stats)).toBe(true)
    handle.dispose()
    expect(() => handle.setInstances([])).toThrow('disposed')
  })
  it('skips blank shapes and retains valid empty buffer placeholders', async () => {
    const { renderer } = rendererHarness(),
      empty: WindfoilGlyphOutline = { ...outline, bbox: [0, 0, 0, 0], quadratics: [] },
      handle = await buildWindfoilShapes(renderer, { box: empty }, [instance])
    expect(handle.stats.instances).toBe(0)
    expect(handle.stats.storageBytes).toBe(24)
    expect(handle.mesh.geometry.boundingBox!.isEmpty()).toBe(false)
    handle.dispose()
  })
  it('rewrites layered buffers without replacing attributes and validates the full batch first', async () => {
    const { renderer } = rendererHarness()
    const layered: WindfoilGlyphOutline = {
      ...outline,
      quadratics: [],
      layers: [
        { quadratics: outline.quadratics, paint: { type: 'solid', color: [1, 0.5, 0, 0.5] } },
        { quadratics: outline.quadratics, paint: { type: 'foreground', alpha: 0.75 } },
      ],
    }
    const sources = {
      box: layered,
      blank: { ...outline, bbox: [0, 0, 0, 0] as const, quadratics: [] },
    }
    const handle = await buildWindfoilShapes(renderer, sources, [instance, { ...instance, x: 50 }])
    const geometry = handle.mesh.geometry
    const attributes = Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        { attribute, version: (attribute as BufferAttribute).version },
      ]),
    )
    const moved = [
      { ...instance, shape: 'blank' },
      {
        ...instance,
        x: 30.1,
        y: -20.2,
        size: 17.3,
        z: 4,
        color: '#80ff20',
        opacity: 0.4,
        sequence: 19,
        clip: [-1, -2, 80, 90] as const,
      },
      { ...instance, x: -8.7, z: -3, sequence: 2 },
    ]
    handle.setInstances(moved)
    const fresh = await buildWindfoilShapes(renderer, sources, moved)
    expect(handle.mesh.geometry).toBe(geometry)
    for (const [name, before] of Object.entries(attributes)) {
      const attribute = geometry.getAttribute(name)
      expect(attribute).toBe(before.attribute)
      expect(attribute.array).toEqual(fresh.mesh.geometry.getAttribute(name).array)
      expect((attribute as BufferAttribute).version).toBe(
        before.version + Number(name !== 'position' && name !== 'normal'),
      )
    }
    expect(geometry.boundingBox).toEqual(fresh.mesh.geometry.boundingBox)
    expect(geometry.boundingSphere).toEqual(fresh.mesh.geometry.boundingSphere)
    expect(handle.mesh.material).toMatchObject({ maxSequence: { value: 19 } })
    const before = geometry.getAttribute('sdfRect').array.slice()
    expect(() =>
      handle.setInstances([
        { ...instance, x: 999 },
        { ...instance, size: -1 },
      ]),
    ).toThrow('positive size')
    expect(geometry.getAttribute('sdfRect').array).toEqual(before)
    handle.setInstances([{ ...instance, shape: 'blank' }])
    const empty = handle.mesh.geometry
    handle.setInstances([])
    expect(handle.mesh.geometry).toBe(empty)
    expect(empty.boundingBox!.min.toArray()).toEqual([0, 0, 0])
    expect(empty.boundingSphere!.radius).toBe(0)
    expect(handle.mesh.material).toMatchObject({ maxSequence: { value: 0 } })
    handle.dispose()
    fresh.dispose()
  })
  it('expands color layers with shared motion ordinals and opacity', async () => {
    const { renderer } = rendererHarness(),
      layered: WindfoilGlyphOutline = {
        ...outline,
        quadratics: [],
        layers: [
          { quadratics: outline.quadratics, paint: { type: 'solid', color: [1, 0, 0, 0.5] } },
          { quadratics: outline.quadratics, paint: { type: 'foreground', alpha: 0.25 } },
        ],
      },
      handle = await buildWindfoilShapes(renderer, { box: layered }, [
        { ...instance, opacity: 0.5 },
      ])
    expect(handle.stats.instances).toBe(2)
    expect(handle.mesh.geometry.getAttribute('windfoilLayer').array).toEqual(
      new Float32Array([10, 40, 0, 1, 10, 40, 0, 0]),
    )
    expect(handle.mesh.geometry.getAttribute('sdfColor').array).toEqual(
      new Uint8Array([255, 0, 0, 64, 255, 255, 255, 32]),
    )
    handle.dispose()
  })
  it('builds gradient shape resources lazily and disposes their extra storage once', async () => {
    const h = rendererHarness()
    const gradient: WindfoilGlyphOutline = {
      ...outline,
      quadratics: [],
      layers: [
        {
          quadratics: outline.quadratics,
          paint: {
            type: 'linear',
            p0: [0, 0],
            p1: [1000, 0],
            stops: [
              { offset: 0, color: [1, 0, 0, 1] },
              { offset: 1, color: [0, 0, 1, 1] },
            ],
          },
        },
      ],
    }
    const handle = await buildWindfoilShapes(h.renderer, { box: gradient }, [instance])
    expect(handle.mesh.geometry.getAttribute('windfoilLayer').getW(0)).toBeGreaterThanOrEqual(2)
    expect(handle.stats.instances).toBe(1)
    handle.dispose()
    handle.dispose()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(4)
    expect(h.destroyInfoAttribute).toHaveBeenCalledTimes(4)
  })
  it('draws static shapes by default and swaps in an animated material once', async () => {
    const layered: WindfoilGlyphOutline = {
      ...outline,
      quadratics: [],
      layers: [{ quadratics: outline.quadratics, paint: { type: 'solid', color: [1, 0, 0, 1] } }],
    }
    for (const [source, options] of [
      [outline, {}],
      [layered, { compositing: 'shader' }],
    ] as const) {
      const { renderer } = rendererHarness(),
        handle = await buildWindfoilShapes(renderer, { box: source }, [instance], {
          ...options,
          side: DoubleSide,
        })
      type Glyph = Material & { animated: boolean; motionMode: { value: number } }
      const still = handle.mesh.material as Glyph
      expect(still.animated).toBe(false)
      const released = vi.spyOn(still, 'dispose')
      // Uniform fields of the mode 'none' leave the static material in place.
      handle.setMotion({ enabled: true, strength: 4 })
      expect(handle.mesh.material).toBe(still)
      handle.setMotion({ mode: 'scale' })
      const moving = handle.mesh.material as Glyph & { motionStrength: { value: number } }
      expect(moving).not.toBe(still)
      expect(moving.animated).toBe(true)
      expect(moving.side).toBe(DoubleSide)
      expect(moving.motionMode.value).toBe(2)
      expect(moving.motionStrength.value).toBe(4)
      expect(released).toHaveBeenCalledOnce()
      handle.setMotion({ mode: 'none' })
      expect(handle.mesh.material).toBe(moving)
      expect(moving.motionMode.value).toBe(0)
      const disposeMoving = vi.spyOn(moving, 'dispose')
      handle.dispose()
      expect(disposeMoving).toHaveBeenCalledOnce()
      expect(released).toHaveBeenCalledOnce()
    }
  })
  it('builds animated shapes for an animated mode, and swaps nothing once disposed', async () => {
    const { renderer } = rendererHarness(),
      handle = await buildWindfoilShapes(renderer, { box: outline }, [instance], {
        motion: { enabled: false },
      })
    expect((handle.mesh.material as unknown as { animated: boolean }).animated).toBe(true)
    handle.dispose()
    const still = await buildWindfoilShapes(renderer, { box: outline }, [instance])
    const material = still.mesh.material
    still.dispose()
    still.setMotion({ mode: 'scale' })
    expect(still.mesh.material).toBe(material)
  })
  it('disposes buffers, geometry, material and group exactly once', async () => {
    const h = rendererHarness(),
      handle = await buildWindfoilShapes(h.renderer, { box: outline }, [instance]),
      event = vi.fn(),
      geometry = vi.spyOn(handle.mesh.geometry, 'dispose'),
      material = vi.spyOn(handle.mesh.material as Material, 'dispose')
    handle.addEventListener('dispose', event)
    handle.dispose()
    handle.dispose()
    expect(event).toHaveBeenCalledOnce()
    expect(geometry).toHaveBeenCalledOnce()
    expect(material).toHaveBeenCalledOnce()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(2)
    expect(h.destroyInfoAttribute).toHaveBeenCalledTimes(2)
  })
  it('shares live outline storage while keeping geometry and material state independent', async () => {
    const h = rendererHarness(),
      sources = new Map([['box', outline]])
    const a = await buildWindfoilShapes(h.renderer, sources, [instance])
    const b = await buildWindfoilShapes(h.renderer, sources, [instance], {
      fill: () => vec4(1, 0, 0, 1),
    })
    expect(b.stats.preprocessMs).toBe(0)
    expect(b.stats.storageBytes).toBe(a.stats.storageBytes)
    expect(b.mesh.geometry).not.toBe(a.mesh.geometry)
    expect(b.mesh.material).not.toBe(a.mesh.material)
    a.setInstances([{ ...instance, x: 90 }])
    a.setMotion({ enabled: true, mode: 'scale' })
    expect(b.mesh.geometry.getAttribute('sdfRect').getX(0)).toBe(instance.x)
    expect(b.mesh.material).toMatchObject({ motionEnabled: { value: 0 } })
    a.dispose()
    expect(h.destroyAttribute).not.toHaveBeenCalled()
    b.setInstances([{ ...instance, x: 50 }])
    expect(b.mesh.geometry.getAttribute('sdfRect').getX(0)).toBe(50)
    b.dispose()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(2)
  })
  it('releases only a failed material build lease when another handle uses the storage', async () => {
    const h = rendererHarness(),
      sources = { box: outline },
      failure = new Error('fill failed')
    const a = await buildWindfoilShapes(h.renderer, sources, [instance])
    await expect(
      buildWindfoilShapes(h.renderer, sources, [instance], {
        fill: () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(h.destroyAttribute).not.toHaveBeenCalled()
    const b = await buildWindfoilShapes(h.renderer, sources, [instance])
    expect(b.stats.preprocessMs).toBe(0)
    a.dispose()
    expect(h.destroyAttribute).not.toHaveBeenCalled()
    b.dispose()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(2)
  })
  it('rebuilds changed Map content without changing a retained handle', async () => {
    const h = rendererHarness(),
      sources = new Map([['box', outline]])
    const a = await buildWindfoilShapes(h.renderer, sources, [instance])
    const before = a.mesh.geometry.getAttribute('sdfRect').array.slice()
    sources.set('box', { ...outline, unitsPerEm: outline.unitsPerEm * 2 })
    const changed = await buildWindfoilShapes(h.renderer, sources, [instance])
    expect(changed.mesh.geometry.getAttribute('sdfRect').array).not.toEqual(before)
    expect(a.mesh.geometry.getAttribute('sdfRect').array).toEqual(before)
    sources.delete('box')
    await expect(buildWindfoilShapes(h.renderer, sources, [instance])).rejects.toThrow(
      'outline key',
    )
    expect(h.destroyAttribute).not.toHaveBeenCalled()
    a.dispose()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(2)
    changed.dispose()
    expect(h.destroyAttribute).toHaveBeenCalledTimes(4)
  })
})
