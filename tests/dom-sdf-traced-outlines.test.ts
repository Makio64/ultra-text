import { InstancedBufferGeometry, Texture, type WebGPURenderer } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as RasterModule from '../src/atlas/rasterize.js'
import type {
  DomLayoutSnapshot,
  DomSdfOptions,
  WindfoilOptions,
  WindfoilOutlineProvider,
} from '../src/types.js'
import type { WindfoilBackend } from '../src/windfoil/runtime.js'

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn<() => Promise<DomLayoutSnapshot>>(),
  rasterize: vi.fn(),
  buildAtlas: vi.fn(),
  buildWindfoil: vi.fn<(...args: unknown[]) => Promise<WindfoilBackend | null>>(),
  buildSlug: vi.fn<(...args: unknown[]) => Promise<WindfoilBackend | null>>(),
  tracers: [] as {
    provider: ReturnType<typeof vi.fn<WindfoilOutlineProvider>>
    clear: ReturnType<typeof vi.fn<() => void>>
    retain: ReturnType<typeof vi.fn<(keys: Iterable<string>) => void>>
  }[],
  trace: vi.fn(),
}))

vi.mock('../src/dom/snapshot.js', () => ({ collectDomSnapshot: mocks.snapshot }))
vi.mock('../src/atlas/rasterize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RasterModule>()),
  rasterizeGlyphAtlas: mocks.rasterize,
}))
vi.mock('../src/atlas/buildAtlas.js', () => ({ buildSdfAtlas: mocks.buildAtlas }))
vi.mock('../src/windfoil/runtime.js', () => ({ buildWindfoilBackend: mocks.buildWindfoil }))
vi.mock('../src/slug/runtime.js', () => ({ buildSlugBackend: mocks.buildSlug }))
vi.mock('../src/windfoil/tracedOutlines.js', () => ({ createTracedOutlineProvider: mocks.trace }))

import { DomSdf } from '../src/dom/DomSdf.js'
import { SdfTextMaterial } from '../src/text/SdfTextMaterial.js'

const renderer = {} as WebGPURenderer
const font = {
  key: 'face',
  canvasFont: '96px Test',
  family: 'Test',
  weight: '400',
  style: 'normal',
  stretch: 'normal',
  variant: 'normal',
  kerning: 'auto',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'auto',
  size: 32,
}

function snapshot(characters = 'AB'): DomLayoutSnapshot {
  const requests = Array.from(characters, (character) => ({
    key: `face\u0000${character}`,
    character,
    font,
  }))
  return {
    width: 240,
    height: 120,
    glyphs: [],
    rects: [],
    blocks: [],
    requests,
    atlasSignature: requests.map((request) => request.key).join('\u0001'),
    lineCount: 1,
  }
}

function windfoilBackend(): WindfoilBackend {
  return {
    kind: 'windfoil',
    layered: false,
    companion: null,
    effects: null,
    color: null,
    sizeSwitch: null,
    motionOrdinals: () => new Float32Array(0),
    covers: () => false,
    primaryCovers: () => false,
    analyticCovers: () => false,
    contentFits: () => true,
    glyphs: new Map(),
    storageBytes: 96,
    preprocessStats: {
      uniqueGlyphs: 0,
      paintLayers: 0,
      monotonePieces: 0,
      bandCount: 0,
      bandedPieces: 0,
      duplication: 1,
    },
    createGeometry: () => ({ geometry: new InstancedBufferGeometry(), maxSequence: 0 }),
    updateGeometry: () => 0,
    setGlyphEm: () => undefined,
    createMaterial: ({ maxSequence, motion }) =>
      new SdfTextMaterial({
        atlas: new Texture(),
        atlasWidth: 1,
        atlasHeight: 1,
        pxRange: 1,
        maxSequence,
        motion,
      }),
    dispose: vi.fn(),
  }
}

/** The options DomSdf handed the Windfoil runtime in its `call`-th build. */
function analyticOptions(call = 0): Record<string, unknown> {
  return mocks.buildWindfoil.mock.calls[call]![2] as Record<string, unknown>
}

function create(options: DomSdfOptions): Promise<DomSdf> {
  const source = document.body.appendChild(document.createElement('article'))
  return DomSdf.create(renderer, source, { observe: false, ...options })
}

beforeEach(() => {
  mocks.tracers.length = 0
  mocks.snapshot.mockReset()
  mocks.snapshot.mockImplementation(() => Promise.resolve(snapshot()))
  mocks.buildWindfoil.mockReset()
  mocks.buildWindfoil.mockImplementation(() => Promise.resolve(windfoilBackend()))
  mocks.buildSlug.mockReset()
  mocks.buildSlug.mockImplementation(() => Promise.resolve({ ...windfoilBackend(), kind: 'slug' }))
  mocks.trace.mockReset()
  mocks.trace.mockImplementation(() => {
    const tracer = {
      provider: vi.fn<WindfoilOutlineProvider>(() => null),
      clear: vi.fn<() => void>(),
      retain: vi.fn<(keys: Iterable<string>) => void>(),
    }
    mocks.tracers.push(tracer)
    return tracer
  })
})

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DomSdf without an outline provider', () => {
  it.each([['nope'], [42], [null], [{}]])(
    'rejects a provider that is not a function (%s) before allocating text resources',
    async (outlineProvider) => {
      await expect(
        create({
          textBackend: 'windfoil',
          windfoil: { outlineProvider } as unknown as WindfoilOptions,
        }),
      ).rejects.toThrow(
        new TypeError('DomSdf: textBackend "windfoil" requires windfoil.outlineProvider'),
      )
      await expect(
        create({
          textBackend: 'slug',
          slug: { outlineProvider } as unknown as WindfoilOptions,
        }),
      ).rejects.toThrow('DomSdf: textBackend "slug" requires slug.outlineProvider')
      expect(mocks.buildWindfoil).not.toHaveBeenCalled()
      expect(mocks.buildSlug).not.toHaveBeenCalled()
      expect(mocks.trace).not.toHaveBeenCalled()
      expect(mocks.rasterize).not.toHaveBeenCalled()
      expect(mocks.buildAtlas).not.toHaveBeenCalled()
    },
  )

  it('traces through one tracer per instance, from the source document, with sdf-glyphs by default', async () => {
    const domSdf = await create({ textBackend: 'windfoil', colorGlyphs: 'all' })
    expect(mocks.trace).toHaveBeenCalledExactlyOnceWith(document, { colorGlyphs: 'all' })
    const tracer = mocks.tracers[0]!
    expect(analyticOptions()).toEqual({ fallback: 'sdf-glyphs', outlineProvider: tracer.provider })
    // The frozen caller input stays as given.
    expect(domSdf.options.windfoil).toBeUndefined()

    await domSdf.rebuild({ atlas: true })
    expect(mocks.trace).toHaveBeenCalledOnce()
    expect(analyticOptions(1)).toEqual({ fallback: 'sdf-glyphs', outlineProvider: tracer.provider })
    domSdf.dispose()

    const kept = await create({
      textBackend: 'windfoil',
      windfoil: { fallback: 'sdf', sdfBelowPx: 12 },
    })
    expect(analyticOptions(2)).toEqual({
      fallback: 'sdf',
      sdfBelowPx: 12,
      outlineProvider: mocks.tracers[1]!.provider,
    })
    kept.dispose()
  })

  it('traces in the document that owns the source, as for a same-origin iframe', async () => {
    const frame = document.body.appendChild(document.createElement('iframe'))
    const owner = frame.contentDocument!
    expect(owner).not.toBe(document)
    const source = owner.body.appendChild(owner.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, {
      observe: false,
      textBackend: 'windfoil',
    })
    expect(mocks.trace).toHaveBeenCalledExactlyOnceWith(owner, {})
    domSdf.dispose()
  })

  it('traces Slug text too, from the Slug options or else the Windfoil ones', async () => {
    const domSdf = await create({ textBackend: 'slug', windfoil: { fallback: 'sdf' } })
    expect(mocks.buildSlug.mock.calls[0]![2]).toEqual({
      fallback: 'sdf',
      outlineProvider: mocks.tracers[0]!.provider,
    })
    expect(domSdf.stats.textBackend).toBe('slug')
    domSdf.dispose()
    expect(mocks.tracers[0]!.clear).toHaveBeenCalledOnce()
  })

  it('leaves an explicit provider and its error fallback to the caller', async () => {
    const outlineProvider = vi.fn<WindfoilOutlineProvider>(() => null)
    const domSdf = await create({ textBackend: 'windfoil', windfoil: { outlineProvider } })
    expect(mocks.trace).not.toHaveBeenCalled()
    expect(analyticOptions()).toEqual({ outlineProvider })
    domSdf.dispose()
  })

  it('keeps traced outlines of the glyphs each committed capture shows', async () => {
    const domSdf = await create({ textBackend: 'windfoil' })
    const tracer = mocks.tracers[0]!
    expect(tracer.retain).toHaveBeenCalledOnce()
    expect([...tracer.retain.mock.calls[0]![0]]).toEqual(['face\u0000A', 'face\u0000B'])

    mocks.snapshot.mockImplementation(() => Promise.resolve(snapshot('BC')))
    await domSdf.rebuild()
    expect([...tracer.retain.mock.calls[1]![0]]).toEqual(['face\u0000B', 'face\u0000C'])

    // A failed build commits nothing and keeps what the cache holds.
    mocks.buildWindfoil.mockRejectedValueOnce(new Error('device lost'))
    mocks.snapshot.mockImplementation(() => Promise.resolve(snapshot('D')))
    await expect(domSdf.rebuild()).rejects.toThrow('device lost')
    expect(tracer.retain).toHaveBeenCalledTimes(2)
    domSdf.dispose()
  })

  it('traces again on a forced atlas rebuild, as after a webfont is replaced in place', async () => {
    const domSdf = await create({ textBackend: 'windfoil' })
    const tracer = mocks.tracers[0]!
    // A new glyph rebuilds the text data, and the outlines already traced stay cached.
    mocks.snapshot.mockImplementation(() => Promise.resolve(snapshot('ABC')))
    await domSdf.rebuild()
    expect(mocks.buildWindfoil).toHaveBeenCalledTimes(2)
    expect(tracer.clear).not.toHaveBeenCalled()

    // `atlas: true` promises fresh text data: nothing traced from the old face is reused.
    await domSdf.rebuild({ atlas: true })
    expect(mocks.buildWindfoil).toHaveBeenCalledTimes(3)
    expect(tracer.clear).toHaveBeenCalledOnce()
    expect(tracer.clear.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.buildWindfoil.mock.invocationCallOrder[2]!,
    )
    domSdf.dispose()
  })

  it('clears the traced outlines when a font loads and when the instance is disposed', async () => {
    class FakeObserver {
      readonly observe = vi.fn()
      readonly disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', FakeObserver)
    vi.stubGlobal('MutationObserver', FakeObserver)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const listeners = new Map<string, EventListener>()
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      },
    })

    const domSdf = await create({ textBackend: 'windfoil', observe: true })
    const tracer = mocks.tracers[0]!
    listeners.get('loadingdone')?.(new Event('loadingdone'))
    expect(tracer.clear).toHaveBeenCalledOnce()
    expect(requestFrame).toHaveBeenCalled()
    domSdf.dispose()
    expect(tracer.clear).toHaveBeenCalledTimes(2)
    domSdf.dispose()
    expect(tracer.clear).toHaveBeenCalledTimes(2)
    Reflect.deleteProperty(document, 'fonts')
  })
})
