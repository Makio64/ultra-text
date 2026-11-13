import {
  BufferAttribute,
  WebGPUBackend,
  type StorageBufferNode,
  type WebGPURenderer,
} from 'three/webgpu'
import type * as ThreeTsl from 'three/tsl'
import { describe, expect, it, vi } from 'vitest'

type RuntimeStorageFactory = (
  attribute: BufferAttribute,
  type: 'vec2' | 'uint',
  count: number,
) => StorageBufferNode<'vec2' | 'uint'>

const tslMocks = vi.hoisted(() => ({ storage: vi.fn<RuntimeStorageFactory>() }))

vi.mock('three/tsl', async (importOriginal) => {
  const actual = await importOriginal<typeof ThreeTsl>()
  tslMocks.storage.mockImplementation(actual.storage as unknown as RuntimeStorageFactory)
  return { ...actual, storage: tslMocks.storage }
})

import type {
  DomLayoutSnapshot,
  FontStyleSnapshot,
  GlyphRequest,
  SdfAtlas,
  WindfoilGlyphOutline,
  WindfoilOutlineProvider,
} from '../src/types.js'
import { WindfoilMaterial } from '../src/windfoil/WindfoilMaterial.js'
import { buildWindfoilBackend } from '../src/windfoil/runtime.js'

const font = {
  key: 'test-font',
  canvasFont: '16px Test',
  family: 'Test',
  weight: '400',
  style: 'normal',
  stretch: 'normal',
  variant: 'normal',
  kerning: 'auto',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'auto',
  size: 16,
} satisfies FontStyleSnapshot

const rectangleOutline: WindfoilGlyphOutline = {
  unitsPerEm: 1_000,
  ascent: 800,
  descent: -200,
  bbox: [0, 0, 10, 10],
  quadratics: [0, 0, 5, 0, 10, 0, 10, 0, 10, 5, 10, 10, 10, 10, 5, 10, 0, 10, 0, 10, 0, 5, 0, 0],
}

function request(key = 'test-font\u0000A', character = 'A'): GlyphRequest {
  return { key, character, font }
}

interface RendererHarness {
  readonly renderer: WebGPURenderer
  readonly init: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly has: ReturnType<typeof vi.fn<(attribute: object) => boolean>>
  readonly destroyAttribute: ReturnType<typeof vi.fn<(attribute: BufferAttribute) => void>>
  readonly destroyInfoAttribute: ReturnType<typeof vi.fn<(attribute: BufferAttribute) => void>>
}

function rendererHarness(webgpu = true, allocated = false): RendererHarness {
  const backend = (webgpu ? Object.create(WebGPUBackend.prototype) : {}) as {
    has(attribute: object): boolean
    destroyAttribute(attribute: BufferAttribute): void
  }
  const has = vi.fn<(attribute: object) => boolean>(() => allocated)
  const destroyAttribute = vi.fn<(attribute: BufferAttribute) => void>()
  Object.assign(backend, { has, destroyAttribute })

  const init = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const destroyInfoAttribute = vi.fn<(attribute: BufferAttribute) => void>()
  const renderer = {
    backend,
    info: { destroyAttribute: destroyInfoAttribute },
    init,
  } as unknown as WebGPURenderer
  return { renderer, init, has, destroyAttribute, destroyInfoAttribute }
}

function snapshot(glyphKey = 'test-font\u0000A'): DomLayoutSnapshot {
  return {
    width: 100,
    height: 40,
    glyphs: [
      {
        glyphKey,
        fontSize: 20,
        originX: 4,
        lineBottom: 2,
        advance: 12,
        block: 0,
        breakBefore: 'none',
        clip: [0, 0, 100, 40],
        color: [1, 1, 1, 1],
        sequence: 3,
        z: 1,
      },
    ],
    rects: [],
    blocks: [{ left: 0, firstBaseline: 6, linePitch: 20, width: 100, clip: [0, 0, 100, 40] }],
    requests: [],
    atlasSignature: 'test-font',
    lineCount: 1,
  }
}

function capturedStorageNodes(): StorageBufferNode<'vec2' | 'uint'>[] {
  return tslMocks.storage.mock.results.map(
    ({ value }) => value as StorageBufferNode<'vec2' | 'uint'>,
  )
}

describe('buildWindfoilBackend', () => {
  it('resolves every outline with the build signal and constructs named, read-only storage', async () => {
    const { renderer, init } = rendererHarness()
    const controller = new AbortController()
    const requests = [request(), request('test-font\u0000B', 'B')]
    const outlineProvider = vi.fn<WindfoilOutlineProvider>(() => Promise.resolve(rectangleOutline))

    const backend = await buildWindfoilBackend(
      renderer,
      requests,
      { outlineProvider },
      controller.signal,
    )

    expect(init).toHaveBeenCalledOnce()
    expect(outlineProvider).toHaveBeenCalledTimes(2)
    expect(outlineProvider.mock.calls).toEqual(
      requests.map((glyphRequest) => [glyphRequest, controller.signal]),
    )
    expect(backend).not.toBeNull()
    expect(backend?.kind).toBe('windfoil')
    expect([...backend!.glyphs.keys()]).toEqual(['test-font\u0000A', 'test-font\u0000B'])
    expect(backend?.preprocessStats).toMatchObject({
      uniqueGlyphs: 2,
      monotonePieces: 8,
      bandCount: 2,
      bandedPieces: 4,
    })
    // Two glyphs × two banded pieces × two traversal orders × 24 bytes, plus
    // two six-word rows.
    expect(backend?.storageBytes).toBe(240)

    const material = backend!.createMaterial({
      motion: { enabled: false },
      maxSequence: 3,
    })
    const storageNodes = capturedStorageNodes().sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    expect(
      storageNodes.map((node) => ({
        name: node.name,
        // The attribute's count: three r188 no longer copies it to the node (`bufferCount`).
        count: (node.value as BufferAttribute).count,
        itemSize: (node.value as BufferAttribute).itemSize,
        bytes: (node.value as BufferAttribute).array.byteLength,
        access: node.access,
      })),
    ).toEqual([
      {
        name: 'ultraWindfoilCurves',
        count: 24,
        itemSize: 2,
        bytes: 192,
        access: 'readOnly',
      },
      {
        name: 'ultraWindfoilRows',
        count: 12,
        itemSize: 1,
        bytes: 48,
        access: 'readOnly',
      },
    ])

    material.dispose()
    backend?.dispose()
  })

  it('uses non-empty placeholder bindings for an empty capture while reporting zero payload bytes', async () => {
    const { renderer, has } = rendererHarness()
    const backend = await buildWindfoilBackend(
      renderer,
      [],
      { outlineProvider: vi.fn() },
      new AbortController().signal,
    )

    expect(backend?.storageBytes).toBe(0)
    backend!.dispose()
    const attributes = has.mock.calls.map(([attribute]) => attribute as BufferAttribute)
    expect(attributes.map((attribute) => attribute.count).sort((a, b) => a - b)).toEqual([1, 1])
    expect(attributes.map((attribute) => attribute.array.byteLength).sort((a, b) => a - b)).toEqual(
      [4, 8],
    )
  })

  it('delegates geometry creation, retained updates, and material creation to the Windfoil path', async () => {
    const { renderer } = rendererHarness()
    const backend = await buildWindfoilBackend(
      renderer,
      [request()],
      { outlineProvider: () => rectangleOutline },
      new AbortController().signal,
    )
    const initial = snapshot()
    const built = backend!.createGeometry(initial, 5)

    expect(built.geometry.instanceCount).toBe(1)
    expect(built.maxSequence).toBe(3)
    expect(built.geometry.getAttribute('windfoilBand')).toBeTruthy()
    const updated = {
      ...initial,
      glyphs: initial.glyphs.map((glyph) => ({ ...glyph, originX: 20, sequence: 9 })),
    }
    expect(backend!.updateGeometry(built.geometry, updated, 8)).toBe(9)

    const material = backend!.createMaterial({
      shadowCutoff: 0.8,
      motion: { enabled: true, mode: 'offset' },
      maxSequence: 9,
    })
    expect(material).toBeInstanceOf(WindfoilMaterial)
    expect(material.maxSequence.value).toBe(9)
    expect((material as WindfoilMaterial).shadowCutoff.value).toBe(0.8)

    material.dispose()
    built.geometry.dispose()
    backend!.dispose()
  })

  it('returns a whole-capture SDF fallback before outline work on a non-WebGPU backend', async () => {
    const { renderer, init } = rendererHarness(false)
    const outlineProvider = vi.fn<WindfoilOutlineProvider>(() => rectangleOutline)

    await expect(
      buildWindfoilBackend(
        renderer,
        [request()],
        { outlineProvider, fallback: 'sdf' },
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
    expect(init).toHaveBeenCalledOnce()
    expect(outlineProvider).not.toHaveBeenCalled()

    await expect(
      buildWindfoilBackend(
        renderer,
        [request()],
        { outlineProvider },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/requires WebGPU/)
  })

  it('falls back for the entire capture when any outline is unavailable', async () => {
    const { renderer, has } = rendererHarness()
    const requests = [request(), request('test-font\u0000B', 'B')]
    const outlineProvider = vi.fn<WindfoilOutlineProvider>((glyphRequest) =>
      glyphRequest.character === 'A' ? rectangleOutline : null,
    )

    await expect(
      buildWindfoilBackend(
        renderer,
        requests,
        { outlineProvider, fallback: 'sdf' },
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
    expect(outlineProvider).toHaveBeenCalledTimes(2)
    expect(has).not.toHaveBeenCalled()

    await expect(
      buildWindfoilBackend(renderer, requests, { outlineProvider }, new AbortController().signal),
    ).rejects.toThrow(/returned null for "B" in Test/)
  })

  it('propagates provider failures and abort reasons without constructing storage', async () => {
    const rejectedHarness = rendererHarness()
    const providerFailure = new Error('font parser failed')
    await expect(
      buildWindfoilBackend(
        rejectedHarness.renderer,
        [request()],
        { outlineProvider: () => Promise.reject(providerFailure) },
        new AbortController().signal,
      ),
    ).rejects.toBe(providerFailure)
    expect(rejectedHarness.has).not.toHaveBeenCalled()

    const abortedHarness = rendererHarness()
    const controller = new AbortController()
    const abortReason = new DOMException('superseded', 'AbortError')
    const outlineProvider = vi.fn<WindfoilOutlineProvider>(() => {
      controller.abort(abortReason)
      return rectangleOutline
    })
    await expect(
      buildWindfoilBackend(
        abortedHarness.renderer,
        [request()],
        { outlineProvider },
        controller.signal,
      ),
    ).rejects.toBe(abortReason)
    expect(outlineProvider).toHaveBeenCalledOnce()
    expect(abortedHarness.has).not.toHaveBeenCalled()

    const alreadyAborted = new AbortController()
    alreadyAborted.abort(abortReason)
    const earlyProvider = vi.fn<WindfoilOutlineProvider>(() => rectangleOutline)
    await expect(
      buildWindfoilBackend(
        abortedHarness.renderer,
        [request()],
        { outlineProvider: earlyProvider },
        alreadyAborted.signal,
      ),
    ).rejects.toBe(abortReason)
    expect(earlyProvider).not.toHaveBeenCalled()
  })

  it('unblocks immediately when init or an outline provider ignores cancellation', async () => {
    const initHarness = rendererHarness()
    initHarness.init.mockImplementationOnce(() => new Promise<void>(() => undefined))
    const initAbort = new AbortController()
    const initBuild = buildWindfoilBackend(
      initHarness.renderer,
      [request()],
      { outlineProvider: () => rectangleOutline },
      initAbort.signal,
    )
    const initReason = new DOMException('cancel init', 'AbortError')
    initAbort.abort(initReason)
    await expect(initBuild).rejects.toBe(initReason)

    const providerHarness = rendererHarness()
    const providerAbort = new AbortController()
    const outlineProvider = vi.fn<WindfoilOutlineProvider>(
      () => new Promise<WindfoilGlyphOutline>(() => undefined),
    )
    const providerBuild = buildWindfoilBackend(
      providerHarness.renderer,
      [request()],
      { outlineProvider },
      providerAbort.signal,
    )
    await vi.waitFor(() => expect(outlineProvider).toHaveBeenCalledOnce())
    const providerReason = new DOMException('cancel provider', 'AbortError')
    providerAbort.abort(providerReason)
    await expect(providerBuild).rejects.toBe(providerReason)
  })

  it('disposes each allocated storage buffer and renderer accounting entry exactly once', async () => {
    const { renderer, has, destroyAttribute, destroyInfoAttribute } = rendererHarness(true, true)
    const disposeSpy = vi.spyOn(BufferAttribute.prototype, 'dispose')
    const backend = await buildWindfoilBackend(
      renderer,
      [request()],
      { outlineProvider: () => rectangleOutline },
      new AbortController().signal,
    )
    backend!.dispose()
    backend!.dispose()

    expect(disposeSpy).toHaveBeenCalledTimes(2)
    expect(has).toHaveBeenCalledTimes(2)
    const attributes = has.mock.calls.map(([attribute]) => attribute as BufferAttribute)
    expect(has.mock.calls.map(([attribute]) => attribute)).toEqual(attributes)
    expect(destroyAttribute).toHaveBeenCalledTimes(2)
    expect(destroyAttribute.mock.calls.map(([attribute]) => attribute)).toEqual(attributes)
    expect(destroyInfoAttribute).toHaveBeenCalledTimes(2)
    expect(destroyInfoAttribute.mock.calls.map(([attribute]) => attribute)).toEqual(attributes)
  })
  it('partitions missing glyphs into one companion and shares drawable ordinals', async () => {
    const harness = rendererHarness(true, true),
      dispose = vi.fn<() => void>()
    const atlas = { glyphs: new Map([['missing', {}]]), dispose } as unknown as SdfAtlas
    const build = vi.fn((_requests: readonly GlyphRequest[], _signal: AbortSignal) =>
      Promise.resolve(atlas),
    )
    const backend = await buildWindfoilBackend(
      harness.renderer,
      [request('a'), request('missing', '😀'), request('blank', ' ')],
      {
        fallback: 'sdf-glyphs',
        outlineProvider: (request) =>
          request.key === 'missing'
            ? null
            : request.key === 'blank'
              ? { ...rectangleOutline, quadratics: [] }
              : rectangleOutline,
      },
      new AbortController().signal,
      { build },
    )
    expect(build.mock.calls[0]![0].map((request) => request.key)).toEqual(['missing'])
    expect(backend!.companion).toBe(atlas)
    expect(backend!.covers('missing')).toBe(true)
    expect(backend!.covers('unknown')).toBe(false)
    const base = snapshot('a'),
      layout = {
        ...base,
        glyphs: [
          base.glyphs[0]!,
          { ...base.glyphs[0]!, glyphKey: 'missing' },
          { ...base.glyphs[0]!, glyphKey: 'blank' },
          { ...base.glyphs[0]!, shapeGroup: 1 },
          { ...base.glyphs[0]!, shapeGroup: 1 },
        ],
      }
    expect(Array.from(backend!.motionOrdinals(layout))).toEqual([0, 1, -1, 2, 2])
    const geometry = backend!.createGeometry(layout, 0).geometry
    expect(
      Array.from(geometry.getAttribute('windfoilLayer').array).filter(
        (_value, index) => index % 4 === 2,
      ),
    ).toEqual([0, 2, 2])
    expect(backend!.updateGeometry(geometry, layout, 0)).not.toBeNull()
    geometry.dispose()
    backend!.dispose()
    backend!.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('keeps whole-capture fallback for all-null and non-WebGPU sdf-glyphs builds', async () => {
    for (const webgpu of [true, false])
      expect(
        await buildWindfoilBackend(
          rendererHarness(webgpu).renderer,
          [request()],
          { fallback: 'sdf-glyphs', outlineProvider: () => null },
          new AbortController().signal,
        ),
      ).toBeNull()
  })
  it('releases a companion that resolves after cancellation without allocating storage', async () => {
    const harness = rendererHarness(true, true),
      controller = new AbortController(),
      dispose = vi.fn<() => void>()
    let finish!: (atlas: SdfAtlas) => void
    const build = vi.fn(
      () =>
        new Promise<SdfAtlas>((resolve) => {
          finish = resolve
        }),
    )
    const promise = buildWindfoilBackend(
      harness.renderer,
      [request('a'), request('missing')],
      {
        fallback: 'sdf-glyphs',
        outlineProvider: (request) => (request.key === 'a' ? rectangleOutline : null),
      },
      controller.signal,
      { build },
    )
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce())
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    finish({ glyphs: new Map(), dispose } as unknown as SdfAtlas)
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledOnce()
    expect(harness.has).not.toHaveBeenCalled()
  })
  it('disposes the companion on storage failure and propagates companion failures', async () => {
    const harness = rendererHarness(true, true),
      dispose = vi.fn<() => void>(),
      atlas = { glyphs: new Map(), dispose } as unknown as SdfAtlas
    const failure = new Error('storage failed')
    tslMocks.storage.mockImplementationOnce(() => {
      throw failure
    })
    await expect(
      buildWindfoilBackend(
        harness.renderer,
        [request('a'), request('missing')],
        {
          fallback: 'sdf-glyphs',
          outlineProvider: (request) => (request.key === 'a' ? rectangleOutline : null),
        },
        new AbortController().signal,
        { build: () => Promise.resolve(atlas) },
      ),
    ).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledOnce()
    expect(harness.has).toHaveBeenCalledTimes(2)
    await expect(
      buildWindfoilBackend(
        harness.renderer,
        [request('a'), request('missing')],
        {
          fallback: 'sdf-glyphs',
          outlineProvider: (request) => (request.key === 'a' ? rectangleOutline : null),
        },
        new AbortController().signal,
        { build: () => Promise.reject(failure) },
      ),
    ).rejects.toBe(failure)
  })
  it('resolves inline filled paths without calling the text provider and falls back for strokes and path clips', async () => {
    const outlineProvider = vi.fn<WindfoilOutlineProvider>(() => rectangleOutline)
    const shape = {
      paths: [{ d: 'M0 0H10V10H0Z', transform: [1, 0, 0, 1, 0, 0] as const }],
      box: [10, 10] as const,
      bounds: [0, 0, 10, 10] as const,
    }
    const backend = await buildWindfoilBackend(
      rendererHarness().renderer,
      [{ ...request('shape'), shape }],
      { outlineProvider },
      new AbortController().signal,
    )
    expect(outlineProvider).not.toHaveBeenCalled()
    expect(backend!.glyphs.get('shape')!.monotonePieceCount).toBe(4)
    backend!.dispose()
    const stroked = {
      ...shape,
      paths: shape.paths.map((path) => ({
        ...path,
        stroke: { width: 1, lineCap: 'butt' as const, lineJoin: 'miter' as const, miterLimit: 4 },
      })),
    }
    expect(
      await buildWindfoilBackend(
        rendererHarness().renderer,
        [{ ...request('shape'), shape: stroked }],
        { outlineProvider, fallback: 'sdf' },
        new AbortController().signal,
      ),
    ).toBeNull()
    expect(
      await buildWindfoilBackend(
        rendererHarness().renderer,
        [
          {
            ...request('shape'),
            shape: {
              ...shape,
              paths: shape.paths.map((path) => ({ ...path, clip: [0, 0, 5, 5] as const })),
            },
          },
        ],
        { outlineProvider, fallback: 'sdf' },
        new AbortController().signal,
      ),
    ).toBeNull()
    expect(outlineProvider).not.toHaveBeenCalled()
  })
  it('guards both ordinary and layered vertex buffer requirements before allocation', async () => {
    const harness = rendererHarness()
    Object.assign(harness.renderer.backend, { device: { limits: { maxVertexBuffers: 6 } } })
    expect(
      await buildWindfoilBackend(
        harness.renderer,
        [request()],
        { outlineProvider: () => rectangleOutline, fallback: 'sdf' },
        new AbortController().signal,
      ),
    ).toBeNull()
    await expect(
      buildWindfoilBackend(
        harness.renderer,
        [request()],
        { outlineProvider: () => rectangleOutline },
        new AbortController().signal,
      ),
    ).rejects.toThrow('seven vertex buffers')
    Object.assign(harness.renderer.backend, { device: { limits: { maxVertexBuffers: 7 } } })
    await expect(
      buildWindfoilBackend(
        harness.renderer,
        [request()],
        {
          outlineProvider: () => ({
            ...rectangleOutline,
            quadratics: [],
            layers: [
              {
                quadratics: rectangleOutline.quadratics,
                paint: { type: 'solid', color: [1, 0, 0, 1] },
              },
            ],
          }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('eight vertex buffers')
  })
  it('routes base-only clip boxes through composites and drops fully clipped glyphs', async () => {
    for (const clipBox of [
      [2, 2, 8, 8],
      [20, 20, 30, 30],
    ] as const) {
      const backend = await buildWindfoilBackend(
        rendererHarness().renderer,
        [request()],
        { compositing: 'layers', outlineProvider: () => ({ ...rectangleOutline, clipBox }) },
        new AbortController().signal,
      )
      expect(backend!.color).not.toBeNull()
      const visible = clipBox[0] === 2
      expect(backend!.glyphs.get(request().key)!.monotonePieceCount > 0).toBe(visible)
      const { geometry } = backend!.color!.createGeometry(snapshot(), 0)
      expect(geometry.instanceCount).toBe(visible ? 1 : 0)
      expect(Array.from(backend!.motionOrdinals(snapshot()))).toEqual([visible ? 0 : -1])
      geometry.dispose()
      backend!.dispose()
    }
  })
})
