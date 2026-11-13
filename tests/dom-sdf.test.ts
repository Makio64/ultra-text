import type * as RasterModule from '../src/atlas/rasterize.js'
import {
  DoubleSide,
  Group,
  InstancedBufferGeometry,
  Mesh,
  Texture,
  WebGPUBackend,
  type WebGPURenderer,
} from 'three/webgpu'
import { setCurrentStack, stack } from 'three/tsl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { appendGlyphs } from '../src/atlas/appendAtlas.js'
import type { RasterizeOptions } from '../src/atlas/rasterize.js'
import type {
  BuildSdfAtlasOptions,
  DomLayoutSnapshot,
  DomSdfOptions,
  GlyphRequest,
  GlyphSlot,
  RasterAtlas,
  SdfAtlas,
} from '../src/types.js'
import type { WindfoilBackend } from '../src/windfoil/runtime.js'
import type * as WindfoilRuntime from '../src/windfoil/runtime.js'
import type { WindfoilGlyphHeader } from '../src/windfoil/preprocess.js'

const domMocks = vi.hoisted(() => ({
  snapshot:
    vi.fn<
      (root: HTMLElement, options?: DomSdfOptions) => DomLayoutSnapshot | Promise<DomLayoutSnapshot>
    >(),
  rasterize:
    vi.fn<
      (
        document: Document,
        requests: readonly GlyphRequest[],
        options?: RasterizeOptions,
      ) => Promise<RasterAtlas>
    >(),
  buildAtlas:
    vi.fn<
      (
        renderer: WebGPURenderer,
        raster: RasterAtlas,
        options?: BuildSdfAtlasOptions,
      ) => Promise<SdfAtlas>
    >(),
  buildWindfoil: vi.fn<() => Promise<WindfoilBackend | null>>(),
  append: vi.fn<(...args: Parameters<typeof appendGlyphs>) => Promise<SdfAtlas | null>>(),
  prepare: vi.fn<(renderer: WebGPURenderer) => void>(),
}))

vi.mock('../src/dom/snapshot.js', () => ({
  collectDomSnapshot: domMocks.snapshot,
}))

vi.mock('../src/atlas/rasterize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RasterModule>()),
  rasterizeGlyphAtlas: domMocks.rasterize,
}))

vi.mock('../src/atlas/buildAtlas.js', () => ({
  buildSdfAtlas: domMocks.buildAtlas,
}))

vi.mock('../src/windfoil/runtime.js', () => ({
  buildWindfoilBackend: domMocks.buildWindfoil,
}))

vi.mock('../src/atlas/appendAtlas.js', () => ({
  appendGlyphs: domMocks.append,
}))

vi.mock('../src/atlas/gpuAtlas.js', () => ({
  prepareAtlasPasses: domMocks.prepare,
}))

import { DomSdf } from '../src/dom/DomSdf.js'
import { GlyphTextMaterial } from '../src/text/GlyphTextMaterial.js'
import { SdfTextMaterial } from '../src/text/SdfTextMaterial.js'
import * as geometryBuilders from '../src/text/geometry.js'
import * as decorations from '../src/text/decorations.js'

const renderer = {} as WebGPURenderer

function snapshot(signature = 'face\u0000A'): DomLayoutSnapshot {
  return {
    width: 240,
    height: 120,
    glyphs: [],
    rects: [],
    blocks: [],
    requests: [],
    atlasSignature: signature,
    lineCount: 2,
  }
}

function raster(): RasterAtlas {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 4
  return {
    canvas,
    width: 4,
    height: 4,
    bakeSize: 32,
    pxRange: 4,
    glyphs: new Map(),
  }
}

function textSnapshot(characters: string, fontKey = 'face'): DomLayoutSnapshot {
  const font = {
    key: fontKey,
    canvasFont: '32px sans-serif',
    family: 'sans-serif',
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
  const requests = [...new Set(characters)].sort().map((character) => ({
    key: `${fontKey}\u0000${character}`,
    character,
    font,
  }))
  return {
    ...snapshot(requests.map((request) => request.key).join('\u0001')),
    requests,
    glyphs: Array.from(characters, (character, index) => ({
      glyphKey: `${fontKey}\u0000${character}`,
      fontSize: 32,
      originX: index * 16,
      lineBottom: 20,
      advance: 16,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 240, 120],
      color: [1, 1, 1, 1],
      sequence: index,
      z: 1,
    })),
  }
}

type TestAtlas = Omit<SdfAtlas, 'dispose' | 'glyphs'> & {
  glyphs: Map<string, GlyphSlot>
  dispose: ReturnType<typeof vi.fn<() => void>>
}

function atlas(mode: 'gpu' | 'cpu' = 'gpu'): TestAtlas {
  return {
    texture: new Texture(),
    width: 4,
    height: 4,
    pxRange: 4,
    bakeSize: 32,
    glyphs: new Map(),
    mode,
    dispose: vi.fn<() => void>(),
  }
}

function windfoilBackend(): WindfoilBackend & {
  glyphs: Map<string, WindfoilGlyphHeader>
  dispose: ReturnType<typeof vi.fn<() => void>>
  createGeometry: ReturnType<typeof vi.fn<WindfoilBackend['createGeometry']>>
  updateGeometry: ReturnType<typeof vi.fn<WindfoilBackend['updateGeometry']>>
} {
  const createGeometry = vi.fn<WindfoilBackend['createGeometry']>(() => ({
    geometry: new InstancedBufferGeometry(),
    maxSequence: 0,
  }))
  const updateGeometry = vi.fn<WindfoilBackend['updateGeometry']>(() => 0)
  return {
    kind: 'windfoil',
    layered: false,
    companion: null,
    effects: null,
    color: null,
    sizeSwitch: null,
    motionOrdinals: (snapshot) => Float32Array.from(snapshot.glyphs, (_, index) => index),
    covers(key) {
      return this.glyphs.has(key)
    },
    primaryCovers(key) {
      return !!this.glyphs.get(key)?.monotonePieceCount
    },
    analyticCovers(key) {
      return this.primaryCovers(key)
    },
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
    createGeometry,
    updateGeometry,
    setGlyphEm: () => undefined,
    createMaterial: ({ maxSequence, motion, shadowCutoff, side }) =>
      new SdfTextMaterial({
        atlas: new Texture(),
        atlasWidth: 1,
        atlasHeight: 1,
        pxRange: 1,
        maxSequence,
        motion,
        ...(side === undefined ? {} : { side }),
        ...(shadowCutoff === undefined ? {} : { shadowCutoff }),
      }),
    dispose: vi.fn<() => void>(),
  }
}

function textMesh(domSdf: DomSdf): Mesh {
  const content = domSdf.children[0]
  if (!(content instanceof Group)) throw new Error('Expected generated content group')
  const text = content.children.find((child) => child.name === 'ultra-text text')
  if (!(text instanceof Mesh)) throw new Error('Expected generated SDF text mesh')
  return text as Mesh
}

function textMaterial(domSdf: DomSdf): SdfTextMaterial {
  const material = textMesh(domSdf).material
  if (!(material instanceof SdfTextMaterial)) {
    throw new Error('Expected generated SDF text material')
  }
  return material
}

beforeEach(() => {
  domMocks.snapshot.mockReset()
  domMocks.rasterize.mockReset()
  domMocks.buildAtlas.mockReset()
  domMocks.buildWindfoil.mockReset()
  domMocks.append.mockReset()
  domMocks.append.mockResolvedValue(null)
})

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DomSdf', () => {
  it('releases text and rectangle resources when later content construction fails', async () => {
    const layout: DomLayoutSnapshot = {
      ...snapshot(),
      rects: [
        { rect: [0, 0, 240, 120], color: [1, 1, 1, 1], radius: 0, z: 0, receiveShadow: false },
      ],
    }
    domMocks.snapshot.mockReturnValue(layout)
    domMocks.rasterize.mockResolvedValue(raster())
    const retained = atlas()
    domMocks.buildAtlas.mockResolvedValue(retained)
    const buildRect = geometryBuilders.createRectGeometry
    vi.spyOn(geometryBuilders, 'createRectGeometry').mockImplementation((capture, receives) => {
      if (receives) throw new Error('receiver construction failed')
      return buildRect(capture, receives)
    })
    const disposeGeometry = vi.spyOn(InstancedBufferGeometry.prototype, 'dispose')
    const disposeMaterial = vi.spyOn(SdfTextMaterial.prototype, 'dispose')
    const source = document.body.appendChild(document.createElement('article'))
    await expect(DomSdf.create(renderer, source, { observe: false })).rejects.toThrow(
      'receiver construction failed',
    )
    expect(disposeGeometry).toHaveBeenCalledTimes(2)
    expect(disposeMaterial).toHaveBeenCalledOnce()
    expect(retained.dispose).toHaveBeenCalledOnce()
  })

  it.each(['rectangles', 'decorations'] as const)(
    'keeps a rebuild atomic when staging %s fails',
    async (failure) => {
      const initial: DomLayoutSnapshot = {
        ...snapshot(),
        rects: [
          { rect: [0, 0, 240, 120], color: [1, 1, 1, 1], radius: 0, z: 0, receiveShadow: false },
        ],
      }
      domMocks.snapshot.mockReturnValue(initial)
      domMocks.rasterize.mockResolvedValue(raster())
      const retained = atlas()
      domMocks.buildAtlas.mockResolvedValue(retained)
      const source = document.body.appendChild(document.createElement('article'))
      const domSdf = await DomSdf.create(renderer, source, { observe: false })
      const meshes = (domSdf.children[0] as Group).children as Mesh[]
      const previous = meshes.map((mesh) => mesh.geometry)
      const disposals = previous.map((geometry) => vi.spyOn(geometry, 'dispose'))
      const stats = domSdf.stats
      retained.glyphs.set('face\u0000A', {
        key: 'face\u0000A',
        character: 'A',
        fontKey: 'face',
        u0: 0,
        v0: 0,
        u1: 1,
        v1: 1,
        planeX0: 0,
        planeY0: 0,
        planeX1: 16,
        planeY1: 32,
        descent: 0,
        advance: 16,
      })
      const added = textSnapshot('A')
      domMocks.snapshot.mockReturnValue({
        ...added,
        width: 260,
        rects: [
          ...initial.rects,
          { rect: [0, 0, 8, 8], color: [0, 0, 0, 1], radius: 0, z: 1, receiveShadow: false },
        ],
        glyphs:
          failure === 'decorations'
            ? added.glyphs.map((glyph) => ({
                ...glyph,
                decorations: [
                  {
                    line: 'underline' as const,
                    thickness: 1,
                    offset: 1,
                    color: [1, 0, 0, 1] as const,
                  },
                ],
              }))
            : added.glyphs,
      })
      const spy =
        failure === 'rectangles'
          ? vi.spyOn(geometryBuilders, 'createRectGeometry')
          : vi.spyOn(decorations, 'createDecorationGeometry')
      spy.mockImplementation(() => {
        throw new Error('staging failed')
      })
      const releaseStaged = vi.spyOn(InstancedBufferGeometry.prototype, 'dispose')
      await expect(domSdf.rebuild()).rejects.toThrow('staging failed')
      expect(meshes.map((mesh) => mesh.geometry)).toEqual(previous)
      expect(disposals.every((dispose) => dispose.mock.calls.length === 0)).toBe(true)
      expect(releaseStaged).toHaveBeenCalled()
      expect(domSdf.stats).toBe(stats)
      expect(retained.dispose).not.toHaveBeenCalled()
      spy.mockRestore()
      await domSdf.rebuild()
      expect(meshes[0]!.geometry).not.toBe(previous[0])
      domSdf.dispose()
      expect(retained.dispose).toHaveBeenCalledOnce()
    },
  )

  it('retains, reflows, updates, and disposes the solid decoration batch', async () => {
    const base = textSnapshot('AB')
    const layout: DomLayoutSnapshot = {
      ...base,
      blocks: [{ left: 0, firstBaseline: 20, linePitch: 32, width: 240, clip: [0, 0, 240, 120] }],
      glyphs: base.glyphs.map((glyph) => ({
        ...glyph,
        breakBefore: 'soft',
        decorations: [{ line: 'underline', thickness: 2, offset: 2, color: [1, 0, 0, 1] }],
      })),
    }
    const retained = atlas()
    for (const request of base.requests)
      retained.glyphs.set(request.key, {
        key: request.key,
        character: request.character,
        fontKey: request.font.key,
        u0: 0,
        v0: 0,
        u1: 1,
        v1: 1,
        planeX0: 0,
        planeY0: 0,
        planeX1: 16,
        planeY1: 32,
        descent: 0,
        advance: 16,
      })
    domMocks.snapshot.mockReturnValue(layout)
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(retained)
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, {
      observe: false,
      reflowable: true,
      cpuWorker: false,
    })
    expect(domMocks.buildAtlas.mock.calls[0]![2]!.cpuWorker).toBe(false)
    expect(domSdf.stats.draws).toBe(2)
    const strokes = domSdf.getObjectByName('ultra-text text decorations') as Mesh
    const material = strokes.material as SdfTextMaterial
    const previous = vi.spyOn(strokes.geometry, 'dispose')
    const decorationGeometry = strokes.geometry
    const strokesBefore = [...strokes.geometry.getAttribute('decorationRect').array]
    domSdf.setMotion({ speed: 3 })
    expect(material.motionSpeed.value).toBe(3)
    domSdf.reflow(20)
    expect(strokes.geometry).toBe(decorationGeometry)
    expect(previous).not.toHaveBeenCalled()
    expect([...strokes.geometry.getAttribute('decorationRect').array]).not.toEqual(strokesBefore)
    expect(domSdf.stats.lines).toBe(2)
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    const releaseGeometry = vi.spyOn(strokes.geometry, 'dispose')
    const releaseMaterial = vi.spyOn(material, 'dispose')
    domMocks.snapshot.mockReturnValue(base)
    await domSdf.rebuild()
    expect(domSdf.stats.draws).toBe(1)
    expect(releaseGeometry).toHaveBeenCalledOnce()
    expect(releaseMaterial).toHaveBeenCalledOnce()
    domMocks.snapshot.mockReturnValue(layout)
    await domSdf.rebuild()
    expect(domSdf.stats.draws).toBe(2)
    domSdf.dispose()
    domSdf.dispose()
    expect(retained.dispose).toHaveBeenCalledOnce()
  })

  it('rewrites same-count text and rectangles in place, and replaces them when the count changes', async () => {
    const layout: DomLayoutSnapshot = {
      ...textSnapshot('AB'),
      rects: [
        { rect: [0, 0, 240, 120], color: [1, 1, 1, 1], radius: 4, z: 0, receiveShadow: false },
      ],
    }
    const retained = atlas()
    for (const request of layout.requests) {
      retained.glyphs.set(request.key, {
        key: request.key,
        character: request.character,
        fontKey: request.font.key,
        u0: 0,
        v0: 0,
        u1: 1,
        v1: 1,
        planeX0: 0,
        planeY0: 0,
        planeX1: 16,
        planeY1: 32,
        descent: 0,
        advance: 16,
      })
    }
    domMocks.snapshot.mockReturnValue(layout)
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(retained)
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, { observe: false })
    const textGeometry = textMesh(domSdf).geometry
    const rect = domSdf.getObjectByName('ultra-text DOM rectangles') as Mesh
    const rectGeometry = rect.geometry
    const next: DomLayoutSnapshot = {
      ...textSnapshot('AB'),
      width: 300,
      glyphs: textSnapshot('AB').glyphs.map((glyph, index) => ({
        ...glyph,
        originX: 40 + index,
        color: [0, 1, 0, 1],
      })),
      rects: [{ rect: [2, 3, 40, 50], color: [0, 0, 1, 1], radius: 8, z: 0, receiveShadow: false }],
    }
    domMocks.snapshot.mockReturnValue(next)
    await domSdf.rebuild()
    expect(textMesh(domSdf).geometry).toBe(textGeometry)
    expect(rect.geometry).toBe(rectGeometry)
    expect(textGeometry.getAttribute('sdfRect').getX(0)).toBe(40)
    expect(textGeometry.getAttribute('sdfColor').array[0]).toBe(0)
    expect([...(rectGeometry as InstancedBufferGeometry).getAttribute('sdfRect').array]).toEqual([
      2, 3, 40, 50,
    ])

    domMocks.snapshot.mockReturnValue(textSnapshot('A'))
    await domSdf.rebuild()
    expect(textMesh(domSdf).geometry).not.toBe(textGeometry)
    expect((textMesh(domSdf).geometry as InstancedBufferGeometry).instanceCount).toBe(1)
    domSdf.dispose()
  })

  it('shares a caller-owned atlas and does not dispose it', async () => {
    const layout = textSnapshot('AB')
    const shared = atlas()
    for (const request of layout.requests) {
      shared.glyphs.set(request.key, {
        key: request.key,
        character: request.character,
        fontKey: request.font.key,
        u0: 0,
        v0: 0,
        u1: 1,
        v1: 1,
        planeX0: 0,
        planeY0: 0,
        planeX1: 16,
        planeY1: 32,
        descent: 0,
        advance: 16,
      })
    }
    domMocks.snapshot.mockReturnValue(layout)
    const first = document.body.appendChild(document.createElement('article'))
    const second = document.body.appendChild(document.createElement('section'))
    const a = await DomSdf.create(renderer, first, { observe: false, sharedAtlas: shared })
    const b = await DomSdf.create(renderer, second, { observe: false, sharedAtlas: shared })
    expect(domMocks.rasterize).not.toHaveBeenCalled()
    expect(domMocks.buildAtlas).not.toHaveBeenCalled()
    expect(a.atlasTexture).toBe(shared.texture)
    expect(b.atlasTexture).toBe(shared.texture)
    a.dispose()
    expect(shared.dispose).not.toHaveBeenCalled()
    b.dispose()
    expect(shared.dispose).not.toHaveBeenCalled()

    const privateAtlas = atlas()
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(privateAtlas)
    domMocks.snapshot.mockReturnValue(textSnapshot('C'))
    const third = document.body.appendChild(document.createElement('article'))
    const c = await DomSdf.create(renderer, third, { observe: false, sharedAtlas: shared })
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    expect(c.atlasTexture).toBe(privateAtlas.texture)
    c.dispose()
    expect(privateAtlas.dispose).toHaveBeenCalledOnce()
    expect(shared.dispose).not.toHaveBeenCalled()
  })

  it('releases partial resources when a custom fill builder throws', async () => {
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    const retained = atlas()
    domMocks.buildAtlas.mockResolvedValue(retained)
    const release = vi.spyOn(InstancedBufferGeometry.prototype, 'dispose')
    const source = document.body.appendChild(document.createElement('article'))
    await expect(
      DomSdf.create(renderer, source, {
        observe: false,
        fill: () => {
          throw new Error('bad fill')
        },
      }),
    ).rejects.toThrow('bad fill')
    expect(release).toHaveBeenCalledOnce()
    expect(retained.dispose).toHaveBeenCalledOnce()
  })
  it.each(['sdf', 'windfoil'] as const)(
    'reuses %s data across subsets, empty text, and restored glyphs; rebuilds for new faces or glyphs',
    async (textBackend) => {
      const initial = textSnapshot('AB')
      const sdf = atlas()
      const analytic = windfoilBackend()
      for (const request of initial.requests) {
        sdf.glyphs.set(request.key, {
          key: request.key,
          character: request.character,
          fontKey: request.font.key,
          u0: 0,
          v0: 0,
          u1: 1,
          v1: 1,
          planeX0: 0,
          planeY0: 0,
          planeX1: 16,
          planeY1: 32,
          descent: 0,
          advance: 16,
        })
        analytic.glyphs.set(request.key, {
          rowBase: 0,
          bandCount: 1,
          bandH: 32,
          invH: 1 / 32,
          unitsPerEm: 32,
          ascent: 32,
          descent: 0,
          bbox: [0, 0, 16, 32],
          monotonePieceCount: 4,
        })
      }
      domMocks.snapshot.mockReturnValue(initial)
      domMocks.rasterize.mockResolvedValue(raster())
      domMocks.buildAtlas.mockResolvedValue(sdf)
      domMocks.buildWindfoil.mockResolvedValue(analytic)
      const source = document.body.appendChild(document.createElement('article'))
      const domSdf = await DomSdf.create(renderer, source, {
        textBackend,
        windfoil: { outlineProvider: () => null },
        observe: false,
      })
      const build = textBackend === 'sdf' ? domMocks.buildAtlas : domMocks.buildWindfoil
      const material = textMaterial(domSdf)

      for (const characters of ['A', '', 'B', 'BA']) {
        domMocks.snapshot.mockReturnValue(textSnapshot(characters))
        await domSdf.rebuild()
        expect(build).toHaveBeenCalledOnce()
        expect(domSdf.stats.atlasBuildMs).toBe(0)
        expect(domSdf.stats.glyphs).toBe(characters.length)
        expect(textMaterial(domSdf)).toBe(material)
        if (textBackend === 'sdf') {
          expect((textMesh(domSdf).geometry as InstancedBufferGeometry).instanceCount).toBe(
            characters.length,
          )
        }
      }

      // Explicit font invalidation still rebuilds even for a fully covered set.
      await domSdf.rebuild({ atlas: true })
      expect(build).toHaveBeenCalledTimes(2)
      domMocks.snapshot.mockReturnValue(textSnapshot('AB', 'another-face'))
      await domSdf.rebuild()
      expect(build).toHaveBeenCalledTimes(3)
      domMocks.snapshot.mockReturnValue(textSnapshot('AC'))
      await domSdf.rebuild()
      expect(build).toHaveBeenCalledTimes(4)
      domSdf.dispose()
    },
  )

  it('retains the optional Windfoil backend without rasterizing an SDF atlas', async () => {
    domMocks.snapshot.mockResolvedValue(snapshot())
    const retained = windfoilBackend()
    domMocks.buildWindfoil.mockResolvedValue(retained)
    const source = document.body.appendChild(document.createElement('article'))
    const outlineProvider = vi.fn()

    const domSdf = await DomSdf.create(renderer, source, {
      textBackend: 'windfoil',
      windfoil: { outlineProvider },
      side: DoubleSide,
      reflowable: true,
      observe: false,
    })

    expect(Object.isFrozen(domSdf.options.windfoil)).toBe(true)
    expect(domMocks.buildWindfoil).toHaveBeenCalledWith(
      renderer,
      [],
      expect.objectContaining({ outlineProvider }),
      expect.any(AbortSignal),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ build: expect.any(Function) }),
    )
    expect(domMocks.rasterize).not.toHaveBeenCalled()
    expect(domMocks.buildAtlas).not.toHaveBeenCalled()
    expect(domSdf.atlasTexture).toBeNull()
    expect(domSdf.stats).toMatchObject({
      textBackend: 'windfoil',
      atlasMode: null,
      atlasWidth: 0,
      atlasHeight: 0,
      textStorageBytes: 96,
    })
    expect(textMaterial(domSdf).side).toBe(DoubleSide)
    expect(textMaterial(domSdf).shadowSide).toBe(DoubleSide)

    domSdf.reflow(180)
    expect(retained.updateGeometry.mock.calls).toHaveLength(1)
    expect(domSdf.width).toBe(180)
    expect(domSdf.stats.lines).toBe(0)
    domSdf.dispose()
    domSdf.dispose()
    expect(retained.dispose.mock.calls).toHaveLength(1)
  })

  it('falls back as one capture when Windfoil cannot resolve every outline', async () => {
    domMocks.snapshot.mockResolvedValue(snapshot())
    domMocks.buildWindfoil.mockResolvedValue(null)
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas('cpu'))
    const source = document.body.appendChild(document.createElement('article'))

    const domSdf = await DomSdf.create(renderer, source, {
      textBackend: 'windfoil',
      windfoil: { outlineProvider: vi.fn(), fallback: 'sdf' },
      observe: false,
    })

    expect(domMocks.rasterize).toHaveBeenCalledOnce()
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    expect(domSdf.stats).toMatchObject({ textBackend: 'sdf', atlasMode: 'cpu' })
    domSdf.dispose()
  })

  it('supports zero-config Windfoil without an explicit outlineProvider and forwards effects flag', async () => {
    domMocks.snapshot.mockResolvedValue(snapshot())
    const retained = windfoilBackend()
    domMocks.buildWindfoil.mockResolvedValue(retained)
    const source = document.body.appendChild(document.createElement('article'))

    const domSdf = await DomSdf.create(renderer, source, {
      textBackend: 'windfoil',
      outline: { width: 2 },
      observe: false,
    })
    expect(domMocks.buildWindfoil).toHaveBeenCalledWith(
      renderer,
      [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      { fallback: 'sdf-glyphs', outlineProvider: expect.any(Function) },
      expect.any(AbortSignal),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        build: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        effects: expect.objectContaining({ outline: { width: 2 } }),
      }),
    )
    expect(domMocks.rasterize).not.toHaveBeenCalled()
    domSdf.dispose()
  })

  it('draws the effects underlay under analytic text at its render order and releases it once', async () => {
    const actual = await vi.importActual<typeof WindfoilRuntime>('../src/windfoil/runtime.js')
    domMocks.snapshot.mockResolvedValue(textSnapshot('AB'))
    const companionDispose = vi.fn()
    const companion = vi.fn((requests: readonly GlyphRequest[]) =>
      Promise.resolve<SdfAtlas>({
        texture: new Texture(),
        width: 16,
        height: 16,
        pxRange: 4,
        bakeSize: 32,
        mode: 'cpu',
        glyphs: new Map(
          requests.map((request, index): [string, GlyphSlot] => [
            request.key,
            {
              key: request.key,
              character: request.character,
              fontKey: 'face',
              u0: index / 4,
              v0: 0,
              u1: (index + 1) / 4,
              v1: 1,
              planeX0: 0,
              planeY0: 0,
              planeX1: 20,
              planeY1: 24,
              descent: 0,
              advance: 16,
            },
          ]),
        ),
        dispose: companionDispose,
      }),
    )
    const device = {
      init: () => Promise.resolve(),
      backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, {
        has: () => false,
      }),
    } as unknown as WebGPURenderer
    const square = [
      0, 0, 5, 0, 10, 0, 10, 0, 10, 5, 10, 10, 10, 10, 5, 10, 0, 10, 0, 10, 0, 5, 0, 0,
    ]
    domMocks.buildWindfoil.mockImplementation((...args: unknown[]) => {
      const [, requests, , signal, builder] = args as Parameters<typeof actual.buildWindfoilBackend>
      return actual.buildWindfoilBackend(
        device,
        requests,
        {
          outlineProvider: () => ({
            unitsPerEm: 10,
            ascent: 10,
            descent: 0,
            bbox: [0, 0, 10, 10],
            quadratics: square,
          }),
        },
        signal,
        { ...builder!, build: companion },
      )
    })
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, {
      textBackend: 'windfoil',
      windfoil: { outlineProvider: vi.fn() },
      outline: { width: 1 },
      dropShadow: {},
      observe: false,
    })
    expect(companion.mock.calls.map(([requests]) => requests.length)).toEqual([2])
    const content = domSdf.children[0] as Group
    const named = (name: string) =>
      content.children.find((child) => child.name === name) as Mesh<
        InstancedBufferGeometry,
        GlyphTextMaterial
      >
    const text = named('ultra-text text')
    const underlay = named('ultra-text text effects')
    // The same render order, made first: three draws it under its own text and still sorts
    // separate texts by depth.
    expect([text.renderOrder, underlay.renderOrder]).toEqual([2, 2])
    expect(underlay.id).toBeLessThan(text.id)
    expect(content.children[0]).toBe(text)
    expect(underlay.castShadow).toBe(true)
    expect(underlay.geometry.instanceCount).toBe(2)
    expect(domSdf.stats).toMatchObject({
      textBackend: 'windfoil',
      glyphs: 2,
      draws: 2,
      fallbackGlyphs: 0,
      colorGlyphs: 0,
      atlasWidth: 16,
    })
    const geometryDispose = vi.spyOn(underlay.geometry, 'dispose')
    const materialDispose = vi.spyOn(underlay.material, 'dispose')
    domSdf.dispose()
    domSdf.dispose()
    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(materialDispose).toHaveBeenCalledOnce()
    expect(companionDispose).toHaveBeenCalledOnce()
  })

  it('awaits the lazy Pretext capture selected by the caller', async () => {
    domMocks.snapshot.mockResolvedValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))

    const domSdf = await DomSdf.create(renderer, source, {
      layoutEngine: 'pretext',
      observe: false,
    })

    expect(domMocks.snapshot).toHaveBeenCalledWith(
      source,
      expect.objectContaining({ layoutEngine: 'pretext' }),
    )
    domSdf.dispose()
  })

  it('persists merged motion uniforms across an atlas-reusing rebuild and disposes ownership once', async () => {
    const layout = snapshot()
    const rasterAtlas = raster()
    const sdfAtlas = atlas()
    // The second capture moves the layout but keeps the atlas signature, so
    // the rebuild reuses both the atlas and the compiled material.
    domMocks.snapshot.mockReturnValueOnce(layout).mockReturnValue({ ...layout, width: 260 })
    domMocks.rasterize.mockResolvedValue(rasterAtlas)
    domMocks.buildAtlas.mockResolvedValue(sdfAtlas)
    const source = document.body.appendChild(document.createElement('article'))

    const domSdf = await DomSdf.create(renderer, source, {
      observe: false,
      atlasMode: 'gpu',
      bakeSize: 64,
      padding: 6,
      maxAtlasSize: 512,
      threshold: 0.5,
      shadowCutoff: 0.72,
      side: DoubleSide,
      motion: {
        enabled: true,
        mode: 'scale',
        strength: 5,
        speed: 0.5,
        stagger: 0.1,
      },
    })
    expect(Object.isFrozen(domSdf.options)).toBe(true)
    expect(Object.isFrozen(domSdf.options.motion)).toBe(true)
    expect(domSdf.width).toBe(240)
    expect(domSdf.height).toBe(120)
    expect(domSdf.stats).toMatchObject({
      glyphs: 0,
      rects: 0,
      lines: 2,
      draws: 1,
      atlasWidth: 4,
      atlasHeight: 4,
      atlasMode: 'gpu',
      textStorageBytes: 16,
    })
    const rasterizeOptions = domMocks.rasterize.mock.calls[0]![2]
    expect(rasterizeOptions).toBeDefined()
    if (!rasterizeOptions) throw new Error('Expected rasterize options')
    expect(rasterizeOptions).toMatchObject({
      bakeSize: 64,
      padding: 6,
      maxAtlasSize: 512,
    })
    expect(rasterizeOptions.signal).toBeInstanceOf(AbortSignal)
    const buildOptions = domMocks.buildAtlas.mock.calls[0]![2]
    expect(buildOptions).toBeDefined()
    if (!buildOptions) throw new Error('Expected atlas build options')
    expect(domMocks.buildAtlas.mock.calls[0]!.slice(0, 2)).toEqual([renderer, rasterAtlas])
    expect(buildOptions).toMatchObject({
      mode: 'gpu',
      mipmaps: false,
      anisotropy: 1,
    })
    expect(buildOptions.signal).toBeInstanceOf(AbortSignal)

    const firstMaterial = textMaterial(domSdf)
    const disposeFirstMaterial = vi.spyOn(firstMaterial, 'dispose')
    expect(firstMaterial.shadowCutoff.value).toBe(0.72)
    expect(firstMaterial.threshold.value).toBe(0.5)
    expect(firstMaterial.side).toBe(DoubleSide)
    expect(firstMaterial.shadowSide).toBe(DoubleSide)
    domSdf.setMotion({ enabled: false, mode: 'offset', strength: 9, speed: 2 })
    expect(firstMaterial.motionEnabled.value).toBe(0)
    expect(firstMaterial.motionStrength.value).toBe(9)

    await domSdf.rebuild()

    expect(domMocks.snapshot).toHaveBeenCalledTimes(2)
    expect(domMocks.rasterize).toHaveBeenCalledOnce()
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    // Same atlas, same mesh structure: the compiled TSL material survives the
    // rebuild and only the geometry was replaced.
    expect(disposeFirstMaterial).not.toHaveBeenCalled()
    const rebuiltMaterial = textMaterial(domSdf)
    expect(rebuiltMaterial).toBe(firstMaterial)
    expect(domSdf.width).toBe(260)
    expect(rebuiltMaterial.motionEnabled.value).toBe(0)
    expect(rebuiltMaterial.motionStrength.value).toBe(9)
    expect(rebuiltMaterial.motionSpeed.value).toBe(2)
    expect(rebuiltMaterial.motionStagger.value).toBe(0.1)
    expect(rebuiltMaterial.shadowCutoff.value).toBe(0.72)

    const onDispose = vi.fn()
    domSdf.addEventListener('dispose', onDispose)
    domSdf.dispose()
    domSdf.dispose()
    expect(onDispose).toHaveBeenCalledOnce()
    expect(disposeFirstMaterial).toHaveBeenCalledOnce()
    expect(sdfAtlas.dispose).toHaveBeenCalledOnce()
    expect(domSdf.width).toBe(0)
    expect(domSdf.height).toBe(0)
    expect(domSdf.atlasTexture).toBeNull()
    expect(domSdf.children).toHaveLength(0)
    expect(domSdf.stats).toMatchObject({
      glyphs: 0,
      rects: 0,
      lines: 0,
      draws: 0,
      atlasWidth: 0,
      atlasHeight: 0,
    })
    await expect(domSdf.rebuild()).rejects.toThrow('this instance is disposed')
  })

  describe('static text', () => {
    /** A one-line underlined capture, its atlas, and the instance built from them. */
    async function underlined(options: DomSdfOptions) {
      const base = textSnapshot('AB')
      const layout: DomLayoutSnapshot = {
        ...base,
        glyphs: base.glyphs.map((glyph) => ({
          ...glyph,
          decorations: [{ line: 'underline', thickness: 2, offset: 2, color: [1, 0, 0, 1] }],
        })),
      }
      const retained = atlas()
      for (const request of base.requests)
        retained.glyphs.set(request.key, {
          key: request.key,
          character: request.character,
          fontKey: request.font.key,
          u0: 0,
          v0: 0,
          u1: 1,
          v1: 1,
          planeX0: 0,
          planeY0: 0,
          planeX1: 16,
          planeY1: 32,
          descent: 0,
          advance: 16,
        })
      domMocks.snapshot.mockReturnValue(layout)
      domMocks.rasterize.mockResolvedValue(raster())
      domMocks.buildAtlas.mockResolvedValue(retained)
      const source = document.body.appendChild(document.createElement('article'))
      const domSdf = await DomSdf.create(renderer, source, { observe: false, ...options })
      const strokes = (): Mesh => domSdf.getObjectByName('ultra-text text decorations') as Mesh
      const materials = () => [
        textMaterial(domSdf),
        strokes().material as unknown as { animated: boolean } & SdfTextMaterial,
      ]
      return { domSdf, layout, retained, strokes, materials }
    }

    it('builds static materials for the mode none and swaps in animated ones once', async () => {
      const motion = { enabled: false, mode: 'none', strength: 9 } as const
      const { domSdf, layout, strokes, materials } = await underlined({ motion })
      const [text, decoration] = materials()
      expect(text!.animated).toBe(false)
      expect(decoration!.animated).toBe(false)
      expect(text!.motionEnabled.value).toBe(0)
      const mesh = textMesh(domSdf)
      const geometry = mesh.geometry
      const disposals = [text!, decoration!].map((material) => vi.spyOn(material, 'dispose'))

      // Uniform-only fields and the mode 'none' keep the static materials untouched.
      domSdf.setMotion({ enabled: true, speed: 2 })
      expect(materials()).toEqual([text, decoration])
      expect(disposals.every((dispose) => dispose.mock.calls.length === 0)).toBe(true)

      domSdf.setMotion({ mode: 'offset' })
      const [animatedText, animatedDecoration] = materials()
      expect(animatedText).not.toBe(text)
      expect(animatedDecoration).not.toBe(decoration)
      expect(animatedText!.animated).toBe(true)
      expect(animatedDecoration!.animated).toBe(true)
      // The live motion, merged across calls, reaches the twins.
      expect(animatedText!.motionEnabled.value).toBe(1)
      expect(animatedText!.motionMode.value).toBe(3)
      expect(animatedText!.motionStrength.value).toBe(9)
      expect(animatedText!.motionSpeed.value).toBe(2)
      expect(animatedDecoration!.motionMode.value).toBe(3)
      // The rest of the state is carried; meshes and geometries stay.
      expect(animatedText!.maxSequence.value).toBe(text!.maxSequence.value)
      expect(animatedText!.threshold.value).toBe(text!.threshold.value)
      expect(textMesh(domSdf)).toBe(mesh)
      expect(mesh.geometry).toBe(geometry)
      expect(strokes().parent).toBe(mesh.parent)
      for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
      expect(domSdf.options.motion).toEqual(motion)

      // Once animated, every motion change is a uniform write, mode 'none' included.
      domSdf.setMotion({ mode: 'none', stagger: 0.2 })
      expect(materials()).toEqual([animatedText, animatedDecoration])
      expect(animatedText!.motionMode.value).toBe(0)
      expect(animatedText!.motionStagger.value).toBeCloseTo(0.2)

      // A new capture builds what the live mode asks for: static again.
      const disposeAnimated = vi.spyOn(animatedText!, 'dispose')
      domMocks.snapshot.mockReturnValue({ ...layout, width: 260 })
      await domSdf.rebuild()
      expect(textMaterial(domSdf)).not.toBe(animatedText)
      expect(textMaterial(domSdf).animated).toBe(false)
      expect(disposeAnimated).toHaveBeenCalledOnce()
      domSdf.dispose()
      expect(disposeAnimated).toHaveBeenCalledOnce()
    })

    it('builds animated materials for any other mode, enabled or not', async () => {
      const { domSdf, materials } = await underlined({ motion: { enabled: false } })
      for (const material of materials()) expect(material.animated).toBe(true)
      domSdf.setMotion({ mode: 'none' })
      domSdf.dispose()
    })

    it('keeps the static text and its live motion when an animated twin fails', async () => {
      const { domSdf, materials } = await underlined({ motion: { mode: 'none' } })
      const before = materials()
      const disposals = before.map((material) => vi.spyOn(material, 'dispose'))
      // Taken before the spy replaces it, and only ever called with its material.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const original = GlyphTextMaterial.prototype.withMotion
      let built = 0
      let released = 0
      // The text's twin builds; the decorations' fails, so nothing may be swapped.
      const twin = vi.spyOn(GlyphTextMaterial.prototype, 'withMotion').mockImplementation(function (
        this: GlyphTextMaterial,
        motion,
      ) {
        if (built++) throw new Error('twin failed')
        const result = original.call(this, motion)
        result.addEventListener('dispose', () => released++)
        return result
      })
      expect(() => domSdf.setMotion({ mode: 'scale' })).toThrow('twin failed')
      twin.mockRestore()
      expect(built).toBe(2)
      expect(released).toBe(1)
      expect(materials()).toEqual(before)
      for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled()
      // The failed mode was not committed: a later uniform field leaves the text static.
      domSdf.setMotion({ speed: 3 })
      expect(materials()).toEqual(before)
      domSdf.setMotion({ mode: 'scale' })
      expect(materials()[0]!.animated).toBe(true)
      expect(materials()[0]!.motionSpeed.value).toBe(3)
      domSdf.dispose()
    })
  })

  it('keeps mipmaps and anisotropy behind the explicit high-quality option', async () => {
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))

    const domSdf = await DomSdf.create(renderer, source, {
      observe: false,
      quality: 'high',
    })
    const buildOptions = domMocks.buildAtlas.mock.calls[0]![2]
    expect(buildOptions).toMatchObject({
      mipmaps: true,
      anisotropy: 4,
    })
    expect(domSdf.stats.textStorageBytes).toBe(21)
    expect(textMaterial(domSdf).quality).toBe('high')
    domSdf.dispose()
  })

  it('replaces and disposes the previous atlas only after a forced rebuild succeeds', async () => {
    const firstAtlas = atlas('gpu')
    const secondAtlas = atlas('cpu')
    const secondLayout: DomLayoutSnapshot = {
      ...snapshot('second'),
      rects: [
        {
          rect: [0, 0, 240, 120],
          color: [0.2, 0.3, 0.4, 1],
          radius: 8,
          z: -1,
          receiveShadow: false,
        },
        {
          rect: [10, 10, 100, 50],
          color: [1, 1, 1, 0.8],
          radius: 4,
          z: 0,
          receiveShadow: true,
        },
      ],
    }
    domMocks.snapshot.mockReturnValueOnce(snapshot('first')).mockReturnValueOnce(secondLayout)
    domMocks.rasterize.mockResolvedValueOnce(raster()).mockResolvedValueOnce(raster())
    domMocks.buildAtlas.mockResolvedValueOnce(firstAtlas).mockResolvedValueOnce(secondAtlas)
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, { observe: false })

    await domSdf.rebuild({ atlas: true })

    expect(firstAtlas.dispose).toHaveBeenCalledOnce()
    expect(secondAtlas.dispose).not.toHaveBeenCalled()
    expect(domSdf.atlasTexture).toBe(secondAtlas.texture)
    expect(domSdf.stats.atlasMode).toBe('cpu')
    expect(domSdf.stats.draws).toBe(3)
    expect((domSdf.children[0] as Group).children.map(({ name }) => name)).toEqual([
      'ultra-text text',
      'ultra-text DOM rectangles',
      'ultra-text shadow receivers',
    ])
    domSdf.dispose()
    expect(secondAtlas.dispose).toHaveBeenCalledOnce()
  })

  it('observes transitive use references within their shadow root', async () => {
    class InertResizeObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const shadow = document.body
      .appendChild(document.createElement('section'))
      .attachShadow({ mode: 'open' })
    shadow.innerHTML =
      '<svg><defs><use id="alias" href="#mark"/><rect id="mark" width="10" height="10"/></defs></svg><article><svg><use href="#alias"/></svg></article>'
    const unrelated = document.body.appendChild(document.createElement('div'))
    unrelated.id = 'alias'
    const source = shadow.querySelector('article')!
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const content = await DomSdf.create(renderer, source, { svg: true })
    expect(observe.mock.calls.map(([target]) => target)).toEqual([
      source,
      shadow.getElementById('alias'),
      shadow.getElementById('mark'),
    ])
    content.dispose()
  })

  it('refreshes external use targets when href changes without changing the captured layout', async () => {
    class InertResizeObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    document.body.innerHTML =
      '<svg><defs><rect id="one" width="10" height="10"/><rect id="two" width="10" height="10"/></defs></svg><article><svg><use href="#one"/></svg></article>'
    const source = document.querySelector('article')!
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const content = await DomSdf.create(renderer, source, { svg: true })
    expect(observe.mock.calls.map(([target]) => target)).toEqual([
      source,
      document.getElementById('one'),
    ])
    observe.mockClear()
    source.querySelector('use')!.setAttribute('href', '#two')
    await content.rebuild()
    expect(content.stats.geometryBuildMs).toBe(0)
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    expect(observe.mock.calls.map(([target]) => target)).toEqual([
      source,
      document.getElementById('two'),
    ])
    content.dispose()
  })

  it('disconnects observers and cancels a queued rebuild when disposed', async () => {
    const resizeInstances: {
      callback: ResizeObserverCallback
      observe: ReturnType<typeof vi.fn<(target: Element) => void>>
      disconnect: ReturnType<typeof vi.fn<() => void>>
    }[] = []
    class FakeResizeObserver {
      readonly observe = vi.fn<(target: Element) => void>()
      readonly unobserve = vi.fn<(target: Element) => void>()
      readonly disconnect = vi.fn<() => void>()

      constructor(readonly callback: ResizeObserverCallback) {
        resizeInstances.push(this)
      }
    }
    const mutationInstances: {
      callback: MutationCallback
      observe: ReturnType<typeof vi.fn<(target: Node, options?: MutationObserverInit) => void>>
      disconnect: ReturnType<typeof vi.fn<() => void>>
    }[] = []
    class FakeMutationObserver {
      readonly observe = vi.fn<(target: Node, options?: MutationObserverInit) => void>()
      readonly disconnect = vi.fn<() => void>()
      readonly takeRecords = vi.fn(() => [])

      constructor(readonly callback: MutationCallback) {
        mutationInstances.push(this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41)
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    const fontListeners = new Map<string, EventListener>()
    const fonts = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        fontListeners.set(type, listener)
      }),
      removeEventListener: vi.fn((type: string) => {
        fontListeners.delete(type)
      }),
    }
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })

    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    const sdfAtlas = atlas()
    domMocks.buildAtlas.mockResolvedValue(sdfAtlas)
    const source = document.body.appendChild(document.createElement('article'))
    source.innerHTML = '<div data-sdf-block></div><div data-sdf-rect></div>'
    const domSdf = await DomSdf.create(renderer, source)

    // Only the root, and only once: re-arming a ResizeObserver after each
    // rebuild makes the re-observe fire the callback, which schedules the next
    // rebuild forever.
    expect(resizeInstances).toHaveLength(1)
    expect(resizeInstances[0]!.observe.mock.calls.map(([target]) => target)).toEqual([source])
    await domSdf.rebuild()
    expect(resizeInstances[0]!.observe).toHaveBeenCalledOnce()
    expect(resizeInstances[0]!.disconnect).not.toHaveBeenCalled()
    // Every attribute must stay observed — stylesheets restyle the copy
    // through arbitrary attribute selectors ([open], :disabled, dir), so an
    // attributeFilter would freeze the capture on exactly those flips. The
    // storm cost is bounded by the debounce and the unchanged-capture skip.
    expect(mutationInstances[0]!.observe).toHaveBeenCalledWith(source, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    expect(fonts.addEventListener).toHaveBeenCalledWith('loadingdone', expect.any(Function))

    resizeInstances[0]!.callback([], resizeInstances[0] as unknown as ResizeObserver)
    mutationInstances[0]!.callback([], mutationInstances[0] as unknown as MutationObserver)
    fontListeners.get('loadingdone')?.(new Event('loadingdone'))
    expect(requestFrame).toHaveBeenCalledOnce()

    domSdf.dispose()

    expect(cancelFrame).toHaveBeenCalledWith(41)
    expect(resizeInstances[0]!.disconnect).toHaveBeenCalled()
    expect(mutationInstances[0]!.disconnect).toHaveBeenCalled()
    expect(fonts.removeEventListener).toHaveBeenCalledWith('loadingdone', expect.any(Function))
    expect(sdfAtlas.dispose).toHaveBeenCalledOnce()
  })

  it('does not rebuild in a loop while observing an idle element', async () => {
    // A real ResizeObserver fires once for every newly observed target. Modelling
    // that is the whole point: re-arming the observer on each rebuild used to feed
    // the callback that schedules the next rebuild, spinning at ~120 rebuilds/s.
    let pending: (() => void)[] = []
    class FiringResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        pending.push(() => {
          this.callback([], this)
        })
      }
      unobserve = vi.fn<() => void>()
      disconnect = vi.fn<() => void>()
    }
    class InertMutationObserver {
      observe = vi.fn<() => void>()
      disconnect = vi.fn<() => void>()
      takeRecords = vi.fn<() => MutationRecord[]>(() => [])
    }
    vi.stubGlobal('ResizeObserver', FiringResizeObserver)
    vi.stubGlobal('MutationObserver', InertMutationObserver)

    // Run scheduled frames synchronously so a runaway loop shows up as an
    // unbounded rebuild count instead of hanging the test.
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))
    source.innerHTML = '<div data-sdf-block></div><div data-sdf-rect></div>'

    const domSdf = await DomSdf.create(renderer, source)
    const rebuilds = () => domMocks.snapshot.mock.calls.length

    const initialRebuilds = rebuilds()
    for (let round = 0; round < 20; round++) {
      const flush = pending
      pending = []
      for (const fire of flush) fire()
      const queued = frames.splice(0)
      for (const frame of queued) frame(round)
      await Promise.resolve()
      await Promise.resolve()
    }

    // The initial observe legitimately triggers one rebuild; nothing after that.
    expect(rebuilds() - initialRebuilds).toBeLessThanOrEqual(1)
    domSdf.dispose()
  })

  it('keeps a GPU-only raster on the GPU and compiles the passes while the DOM is read', async () => {
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const order: string[] = []
    domMocks.prepare.mockImplementationOnce(() => void order.push('prepare'))
    domMocks.snapshot.mockImplementationOnce(() => {
      order.push('capture')
      return snapshot()
    })
    const gpu = {
      initialized: true,
      backend: { isWebGPUBackend: true },
    } as unknown as WebGPURenderer
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(gpu, source, { observe: false })
    expect(order).toEqual(['prepare', 'capture'])
    expect(domMocks.rasterize.mock.calls[0]![2]).toMatchObject({ gpuUpload: true })
    // Later atlases of the instance find the passes ready.
    await domSdf.rebuild({ atlas: true })
    expect(domMocks.prepare).toHaveBeenCalledOnce()
    expect(domMocks.rasterize.mock.calls[1]![2]).toMatchObject({ gpuUpload: true })
    domSdf.dispose()

    for (const [target, options] of [
      [gpu, { observe: false, atlasMode: 'cpu' }],
      [{ initialized: true, backend: { isWebGLBackend: true } }, { observe: false }],
      [{ initialized: false, backend: { isWebGPUBackend: true } }, { observe: false }],
    ] as const) {
      domMocks.rasterize.mockClear()
      const other = await DomSdf.create(target as WebGPURenderer, source, options)
      expect(domMocks.rasterize.mock.calls[0]![2]).not.toHaveProperty('gpuUpload')
      other.dispose()
    }
    expect(domMocks.prepare).toHaveBeenCalledOnce()
  })

  it('short-circuits a rebuild when the capture is unchanged', async () => {
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, { observe: false })
    const mesh = textMesh(domSdf)
    const geometry = mesh.geometry
    const group = domSdf.children[0]

    await domSdf.rebuild()

    // The DOM was re-read, but nothing the capture reads changed: content,
    // geometry and stats all stay put instead of being rebuilt.
    expect(domMocks.snapshot).toHaveBeenCalledTimes(2)
    expect(domSdf.children[0]).toBe(group)
    expect(textMesh(domSdf)).toBe(mesh)
    expect(mesh.geometry).toBe(geometry)
    expect(domSdf.stats.geometryBuildMs).toBe(0)

    // A forced atlas rebuild must not short-circuit.
    await domSdf.rebuild({ atlas: true })
    expect(domMocks.rasterize).toHaveBeenCalledTimes(2)
    domSdf.dispose()
  })

  it('rebuilds the content bundle when the mesh structure changes', async () => {
    const bare = snapshot()
    const withRect: DomLayoutSnapshot = {
      ...snapshot(),
      rects: [
        { rect: [0, 0, 240, 120], color: [1, 1, 1, 1], radius: 0, z: 0, receiveShadow: false },
      ],
    }
    domMocks.snapshot.mockReturnValueOnce(bare).mockReturnValue(withRect)
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, { observe: false })
    const firstMaterial = textMaterial(domSdf)
    const disposeFirstMaterial = vi.spyOn(firstMaterial, 'dispose')

    await domSdf.rebuild()

    // A rectangle bucket appeared: the bundle cannot be patched in place.
    expect(disposeFirstMaterial).toHaveBeenCalledOnce()
    expect(textMaterial(domSdf)).not.toBe(firstMaterial)
    expect((domSdf.children[0] as Group).children.map(({ name }) => name)).toEqual([
      'ultra-text text',
      'ultra-text DOM rectangles',
    ])
    domSdf.dispose()
  })

  it('keeps text out of the shadow map when castShadow is disabled', async () => {
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))

    const defaulted = await DomSdf.create(renderer, source, { observe: false })
    expect(textMesh(defaulted).castShadow).toBe(true)
    defaulted.dispose()

    const disabled = await DomSdf.create(renderer, source, { observe: false, castShadow: false })
    expect(textMesh(disabled).castShadow).toBe(false)
    disabled.dispose()
  })

  it('debounces attribute-only mutations and keeps text changes on the frame path', async () => {
    let mutationCallback: MutationCallback | undefined
    class CapturingMutationObserver {
      observe = vi.fn<() => void>()
      disconnect = vi.fn<() => void>()
      takeRecords = vi.fn<() => MutationRecord[]>(() => [])

      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }
    }
    class InertResizeObserver {
      observe = vi.fn<() => void>()
      unobserve = vi.fn<() => void>()
      disconnect = vi.fn<() => void>()
    }
    vi.stubGlobal('MutationObserver', CapturingMutationObserver)
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(11)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const timers: (() => void)[] = []
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: () => void,
    ) => {
      timers.push(handler)
      return timers.length
    }) as unknown as typeof window.setTimeout)
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined)

    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source)
    if (!mutationCallback) throw new Error('Expected the mutation observer to be constructed')

    const attributeRecord = { type: 'attributes' } as MutationRecord
    const textRecord = { type: 'characterData' } as MutationRecord

    // Attribute-only bursts ride a trailing timeout, not the frame.
    mutationCallback([attributeRecord], {} as MutationObserver)
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 80)
    expect(requestFrame).not.toHaveBeenCalled()
    // A second burst re-arms the timer instead of stacking another.
    mutationCallback([attributeRecord], {} as MutationObserver)
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)

    // The trailing timer performs the rebuild.
    const before = domMocks.snapshot.mock.calls.length
    timers.at(-1)!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(domMocks.snapshot.mock.calls.length).toBe(before + 1)

    // Text or structure changes go straight to the next frame.
    mutationCallback([attributeRecord, textRecord], {} as MutationObserver)
    expect(requestFrame).toHaveBeenCalledOnce()
    domSdf.dispose()
  })

  it('toggles sdf-selectable class on source element and cleans up on dispose', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn<() => void>()
        unobserve = vi.fn<() => void>()
        disconnect = vi.fn<() => void>()
      },
    )
    domMocks.snapshot.mockReturnValue(snapshot())
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlas())
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, { selectable: true })

    expect(source.classList.contains('sdf-selectable')).toBe(true)

    domSdf.dispose()
    expect(source.classList.contains('sdf-selectable')).toBe(false)
  })

  describe('windfoil.sdfBelowPx', () => {
    const square = {
      unitsPerEm: 32,
      ascent: 32,
      descent: 0,
      bbox: [0, 0, 16, 32] as const,
      quadratics: [
        0, 0, 8, 0, 16, 0, 16, 0, 16, 16, 16, 32, 16, 32, 8, 32, 0, 32, 0, 32, 0, 16, 0, 0,
      ],
    }
    // A has a plain outline, Q none, L a single solid paint layer, and the space no ink.
    const outlineProvider = vi.fn((request: GlyphRequest) =>
      request.character === 'Q'
        ? null
        : request.character === 'L'
          ? {
              ...square,
              quadratics: [],
              layers: [
                {
                  quadratics: square.quadratics,
                  paint: { type: 'solid' as const, color: [1, 0, 0, 1] as const },
                },
              ],
            }
          : request.character === ' '
            ? { ...square, quadratics: [] }
            : square,
    )
    const webgpuRenderer = () =>
      ({
        init: () => Promise.resolve(),
        backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, {
          has: () => false,
          destroyAttribute: vi.fn(),
        }),
        info: { destroyAttribute: vi.fn() },
      }) as unknown as WebGPURenderer

    /** The real Windfoil runtime behind DomSdf, with the SDF companion built from test slots. */
    async function realWindfoil(): Promise<TestAtlas[]> {
      const { buildWindfoilBackend } = await vi.importActual<typeof WindfoilRuntime>(
        '../src/windfoil/runtime.js',
      )
      domMocks.buildWindfoil.mockImplementation(
        buildWindfoilBackend as unknown as () => Promise<WindfoilBackend | null>,
      )
      domMocks.rasterize.mockImplementation((_document, requests) =>
        Promise.resolve({
          ...raster(),
          glyphs: new Map(
            requests.map((request) => [
              request.key,
              {
                key: request.key,
                character: request.character,
                fontKey: request.font.key,
                u0: 0,
                v0: 0,
                u1: 1,
                v1: 1,
                planeX0: -2,
                planeY0: -2,
                planeX1: 18,
                planeY1: 34,
                descent: 0,
                advance: 16,
              },
            ]),
          ),
        }),
      )
      const built: TestAtlas[] = []
      domMocks.buildAtlas.mockImplementation((_renderer, source) => {
        const retained = atlas('cpu')
        for (const [key, slot] of source.glyphs) retained.glyphs.set(key, slot)
        built.push(retained)
        return Promise.resolve(retained)
      })
      return built
    }

    function meshNamed(domSdf: DomSdf, name: string): Mesh<InstancedBufferGeometry> {
      const found = (domSdf.children[0] as Group).children.find((child) => child.name === name)
      if (!(found instanceof Mesh)) throw new Error(`Expected the ${name} mesh`)
      return found as Mesh<InstancedBufferGeometry>
    }

    it('keeps the threshold as frozen caller input and bakes switchable glyphs with missing ones', async () => {
      const built = await realWindfoil()
      const captured = textSnapshot('AQLA ')
      domMocks.snapshot.mockReturnValue(captured)
      const source = document.body.appendChild(document.createElement('article'))
      const windfoil = { outlineProvider, fallback: 'sdf-glyphs', sdfBelowPx: 96 } as const
      const domSdf = await DomSdf.create(webgpuRenderer(), source, {
        textBackend: 'windfoil',
        windfoil,
        reflowable: true,
        observe: false,
        motion: { enabled: false },
      })

      expect(Object.isFrozen(domSdf.options.windfoil)).toBe(true)
      expect(domSdf.options.windfoil).toEqual(windfoil)
      expect(domSdf.options.windfoil).not.toBe(windfoil)
      expect(domMocks.rasterize).toHaveBeenCalledOnce()
      expect(domMocks.rasterize.mock.calls[0]![1].map((request) => request.character)).toEqual([
        'Q',
        'A',
      ])
      expect(domSdf.stats).toMatchObject({
        textBackend: 'windfoil',
        atlasMode: 'cpu',
        glyphs: 5,
        colorGlyphs: 0,
        // Q alone lacks an outline; A is drawn from the companion only while it is small.
        fallbackGlyphs: 1,
        switchableGlyphs: 2,
        draws: 2,
      })
      expect(domSdf.atlasTexture).toBe(built[0]!.texture)
      const text = meshNamed(domSdf, 'ultra-text text')
      const companion = meshNamed(domSdf, 'ultra-text fallback glyphs')
      expect(text.geometry.getAttribute('sdfMeta').itemSize).toBe(3)
      expect(companion.geometry.getAttribute('sdfMeta').itemSize).toBe(3)

      // Reflow and a covered rebuild update both batches in place from the captured layout.
      const [textGeometry, companionGeometry] = [text.geometry, companion.geometry]
      domSdf.reflow(180)
      expect(text.geometry).toBe(textGeometry)
      expect(companion.geometry).toBe(companionGeometry)
      expect((domSdf as unknown as { snapshot: DomLayoutSnapshot }).snapshot).toBe(captured)
      expect(captured.glyphs.some((glyph) => 'switchEm' in glyph || glyph.motionOrigin)).toBe(false)
      const [textMaterial, companionMaterial] = [text.material, companion.material]
      for (const [characters, stats] of [
        ['AL', { glyphs: 2, fallbackGlyphs: 0, switchableGlyphs: 1 }],
        ['', { glyphs: 0, fallbackGlyphs: 0, switchableGlyphs: 0 }],
        ['QA', { glyphs: 2, fallbackGlyphs: 1, switchableGlyphs: 1 }],
      ] as const) {
        domMocks.snapshot.mockReturnValue(textSnapshot(characters))
        await domSdf.rebuild()
        expect(domSdf.stats).toMatchObject(stats)
        expect(meshNamed(domSdf, 'ultra-text text').material).toBe(textMaterial)
        expect(meshNamed(domSdf, 'ultra-text fallback glyphs').material).toBe(companionMaterial)
      }
      expect(domMocks.buildWindfoil).toHaveBeenCalledOnce()

      domSdf.dispose()
      expect(domSdf.stats.switchableGlyphs).toBe(0)
      expect(built).toHaveLength(1)
      expect(built[0]!.dispose).toHaveBeenCalledOnce()
    })

    it('underlines each switched glyph once, from its Windfoil ink rect', async () => {
      await realWindfoil()
      const underline = {
        line: 'underline',
        color: [1, 1, 1, 1],
        thickness: 2,
        offset: 4,
      } as const
      const base = textSnapshot('AQA')
      domMocks.snapshot.mockReturnValue({
        ...base,
        glyphs: base.glyphs.map((glyph) => ({ ...glyph, decorations: [underline] })),
      })
      const source = document.body.appendChild(document.createElement('article'))
      const domSdf = await DomSdf.create(webgpuRenderer(), source, {
        textBackend: 'windfoil',
        windfoil: { outlineProvider, fallback: 'sdf-glyphs', sdfBelowPx: 96 },
        observe: false,
      })
      expect(domSdf.stats).toMatchObject({ switchableGlyphs: 2, fallbackGlyphs: 1, draws: 3 })
      const decorations = meshNamed(domSdf, 'ultra-text text decorations').geometry
      expect(decorations.instanceCount).toBe(3)
      expect(Array.from(decorations.getAttribute('sdfRect').array)).toEqual([
        // A: Windfoil ink. Q: its SDF cell, 2 units wider on each side. A: Windfoil ink.
        0, 20, 16, 52, 14, 18, 34, 54, 32, 20, 48, 52,
      ])
      domSdf.dispose()
    })

    it('adds nothing when the threshold is unset', async () => {
      await realWindfoil()
      domMocks.snapshot.mockReturnValue(textSnapshot('AQLA '))
      const source = document.body.appendChild(document.createElement('article'))
      const domSdf = await DomSdf.create(webgpuRenderer(), source, {
        textBackend: 'windfoil',
        windfoil: { outlineProvider, fallback: 'sdf-glyphs' },
        observe: false,
      })
      expect('sdfBelowPx' in domSdf.options.windfoil!).toBe(false)
      expect(domMocks.rasterize.mock.calls[0]![1].map((request) => request.character)).toEqual([
        'Q',
      ])
      expect(domSdf.stats).toMatchObject({ fallbackGlyphs: 1, switchableGlyphs: 0, draws: 2 })
      expect(
        meshNamed(domSdf, 'ultra-text fallback glyphs').geometry.getAttribute('sdfMeta').itemSize,
      ).toBe(2)
      domSdf.dispose()
    })
  })
})

describe('DomSdf atlas appends', () => {
  function glyphSlot(character: string): GlyphSlot {
    return {
      key: `face\u0000${character}`,
      character,
      fontKey: 'face',
      u0: 0,
      v0: 0,
      u1: 0.5,
      v1: 0.5,
      planeX0: 0,
      planeY0: 0,
      planeX1: 16,
      planeY1: 32,
      descent: 0,
      advance: 16,
    }
  }

  function atlasWith(characters: string): TestAtlas {
    const result = atlas()
    for (const character of characters)
      result.glyphs.set(`face\u0000${character}`, glyphSlot(character))
    return result
  }

  /** What `appendGlyphs` resolves with: the live wrapper's texture and dispose, more slots. */
  function patched(live: SdfAtlas, characters: string): SdfAtlas {
    const glyphs = new Map(live.glyphs)
    for (const character of characters) glyphs.set(`face\u0000${character}`, glyphSlot(character))
    return { ...live, glyphs }
  }

  async function createWith(
    live: TestAtlas,
    characters: string,
    options: DomSdfOptions = { observe: false },
  ): Promise<DomSdf> {
    domMocks.snapshot.mockReturnValue(textSnapshot(characters))
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValueOnce(live)
    const source = document.body.appendChild(document.createElement('article'))
    return DomSdf.create(renderer, source, options)
  }

  it('patches new text glyphs into the live atlas, keeping its texture and materials', async () => {
    const live = atlasWith('AB')
    const domSdf = await createWith(live, 'AB')
    expect(domMocks.rasterize.mock.calls[0]![2]).toMatchObject({ appendable: true })
    const material = textMaterial(domSdf)
    const disposeMaterial = vi.spyOn(material, 'dispose')
    const first = patched(live, 'C')
    domMocks.append.mockResolvedValueOnce(first)
    domMocks.snapshot.mockReturnValue(textSnapshot('ABC'))

    await domSdf.rebuild()

    expect(domMocks.append).toHaveBeenCalledWith(
      renderer,
      document,
      live,
      textSnapshot('ABC').requests,
      domSdf.options,
      expect.any(AbortSignal),
    )
    expect(domMocks.rasterize).toHaveBeenCalledOnce()
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    expect(domSdf.atlasTexture).toBe(live.texture)
    expect(textMaterial(domSdf)).toBe(material)
    expect(disposeMaterial).not.toHaveBeenCalled()
    expect((textMesh(domSdf).geometry as InstancedBufferGeometry).instanceCount).toBe(3)
    // The wrappers share one texture and one dispose: nothing is released yet.
    expect(live.dispose).not.toHaveBeenCalled()

    // The next glyph patches the patched wrapper, which now owns the texture.
    domMocks.append.mockResolvedValueOnce(patched(first, 'D'))
    domMocks.snapshot.mockReturnValue(textSnapshot('ABCD'))
    await domSdf.rebuild()
    expect(domMocks.append.mock.calls[1]![2]).toBe(first)
    expect(textMaterial(domSdf)).toBe(material)
    expect(live.dispose).not.toHaveBeenCalled()
    domSdf.dispose()
    domSdf.dispose()
    expect(live.dispose).toHaveBeenCalledOnce()
  })

  it('never disposes the live texture for a patch that a newer build supersedes', async () => {
    const live = atlasWith('AB')
    const domSdf = await createWith(live, 'AB')
    let resolvePatch!: (atlas: SdfAtlas) => void
    domMocks.append.mockImplementationOnce(
      () =>
        new Promise<SdfAtlas>((resolve) => {
          resolvePatch = resolve
        }),
    )
    domMocks.snapshot.mockReturnValue(textSnapshot('ABC'))
    const superseded = domSdf.rebuild()
    await vi.waitFor(() => {
      expect(domMocks.append).toHaveBeenCalledOnce()
    })
    // The newer capture is covered by the live atlas: it keeps it as it is.
    domMocks.snapshot.mockReturnValue(textSnapshot('BA'))
    const newer = domSdf.rebuild()
    resolvePatch(patched(live, 'C'))
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' })
    await newer
    expect(live.dispose).not.toHaveBeenCalled()
    expect(domSdf.atlasTexture).toBe(live.texture)
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    domSdf.dispose()
    expect(live.dispose).toHaveBeenCalledOnce()
  })

  it('builds fresh materials over a patched atlas that the bundle cannot update to', async () => {
    const live = atlasWith('AB')
    const domSdf = await createWith(live, 'AB')
    const material = textMaterial(domSdf)
    const disposeMaterial = vi.spyOn(material, 'dispose')
    domMocks.append.mockResolvedValueOnce(patched(live, 'C'))
    // A background rectangle needs a mesh that the retained bundle lacks.
    domMocks.snapshot.mockReturnValue({
      ...textSnapshot('ABC'),
      rects: [
        { rect: [0, 0, 240, 120], color: [1, 1, 1, 1], radius: 0, z: 0, receiveShadow: false },
      ],
    })
    await domSdf.rebuild()
    expect(domMocks.append).toHaveBeenCalledOnce()
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    expect(domSdf.atlasTexture).toBe(live.texture)
    expect(textMaterial(domSdf)).not.toBe(material)
    expect(disposeMaterial).toHaveBeenCalled()
    expect((textMesh(domSdf).geometry as InstancedBufferGeometry).instanceCount).toBe(3)
    // The old bundle is gone, but its atlas wrapper shares the live texture: it stays.
    expect(live.dispose).not.toHaveBeenCalled()
    domSdf.dispose()
    expect(live.dispose).toHaveBeenCalledOnce()
  })

  it('rebuilds in full when the patch declines, and releases the old atlas once', async () => {
    const live = atlasWith('AB')
    const domSdf = await createWith(live, 'AB')
    const material = textMaterial(domSdf)
    const replacement = atlasWith('ABC😀')
    domMocks.buildAtlas.mockResolvedValueOnce(replacement)
    domMocks.snapshot.mockReturnValue(textSnapshot('ABC😀'))
    await domSdf.rebuild()
    expect(domMocks.append).toHaveBeenCalledOnce()
    const options = domMocks.rasterize.mock.calls[1]![2]!
    // Colour classifications are reused, and having gained glyphs the instance leaves
    // headroom for the next ones, though it is rebuilt by hand (observe: false).
    expect(options.previousAtlas).toBe(live)
    expect(options.appendable).toBe('headroom')
    expect(domSdf.atlasTexture).toBe(replacement.texture)
    expect(textMaterial(domSdf)).not.toBe(material)
    expect(live.dispose).toHaveBeenCalledOnce()
    domSdf.dispose()
    expect(replacement.dispose).toHaveBeenCalledOnce()
    expect(live.dispose).toHaveBeenCalledOnce()
  })

  it('rebuilds in full, tight, when the patch chunk fails to load, and asks for it once', async () => {
    let loads = 0
    vi.doMock('../src/atlas/appendAtlas.js', () => {
      loads++
      throw new TypeError('Failed to fetch dynamically imported module')
    })
    class InertResizeObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    try {
      const live = atlasWith('AB')
      const domSdf = await createWith(live, 'AB', {})
      const replacement = atlasWith('ABC')
      domMocks.buildAtlas.mockResolvedValueOnce(replacement)
      domMocks.snapshot.mockReturnValue(textSnapshot('ABC'))
      await domSdf.rebuild()
      expect(loads).toBe(1)
      expect(domSdf.atlasTexture).toBe(replacement.texture)
      expect(live.dispose).toHaveBeenCalledOnce()
      // No patch can use headroom: the observed instance's atlas stays tight.
      expect(domMocks.rasterize.mock.calls[1]![2]).toMatchObject({
        appendable: true,
        previousAtlas: live,
      })
      // The next new glyph rebuilds in full too, without another request for the chunk.
      const next = atlasWith('ABCD')
      domMocks.buildAtlas.mockResolvedValueOnce(next)
      domMocks.snapshot.mockReturnValue(textSnapshot('ABCD'))
      await domSdf.rebuild()
      expect(loads).toBe(1)
      expect(domMocks.rasterize.mock.calls[2]![2]).toMatchObject({ appendable: true })
      expect(domSdf.atlasTexture).toBe(next.texture)
      expect(domMocks.append).not.toHaveBeenCalled()
      domSdf.dispose()
      expect(replacement.dispose).toHaveBeenCalledOnce()
      expect(next.dispose).toHaveBeenCalledOnce()
    } finally {
      vi.doMock('../src/atlas/appendAtlas.js', () => ({ appendGlyphs: domMocks.append }))
    }
  })

  it('leaves headroom once an observed instance has gained glyphs', async () => {
    class InertResizeObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    const live = atlasWith('AB')
    const domSdf = await createWith(live, 'AB', {})
    expect(domMocks.rasterize.mock.calls[0]![2]).toMatchObject({ appendable: true })
    domMocks.buildAtlas.mockResolvedValueOnce(atlasWith('ABC'))
    domMocks.snapshot.mockReturnValue(textSnapshot('ABC'))
    await domSdf.rebuild()
    expect(domMocks.rasterize.mock.calls[1]![2]).toMatchObject({ appendable: 'headroom' })
    // A forced rebuild of the same text keeps the headroom, and never patches.
    domMocks.buildAtlas.mockResolvedValueOnce(atlasWith('ABCD'))
    domMocks.snapshot.mockReturnValue(textSnapshot('ABCD'))
    await domSdf.rebuild({ atlas: true })
    expect(domMocks.append).toHaveBeenCalledOnce()
    expect(domMocks.rasterize.mock.calls[2]![2]).toMatchObject({
      appendable: 'headroom',
      previousAtlas: undefined,
    })
    domSdf.dispose()
  })

  it('never patches a caller’s shared atlas or Windfoil text', async () => {
    const shared = atlasWith('AB')
    domMocks.snapshot.mockReturnValue(textSnapshot('AB'))
    domMocks.rasterize.mockResolvedValue(raster())
    const source = document.body.appendChild(document.createElement('article'))
    const sharing = await DomSdf.create(renderer, source, {
      observe: false,
      sharedAtlas: shared,
    })
    expect(sharing.atlasTexture).toBe(shared.texture)
    const own = atlasWith('ABC')
    domMocks.buildAtlas.mockResolvedValueOnce(own)
    domMocks.snapshot.mockReturnValue(textSnapshot('ABC'))
    await sharing.rebuild()
    expect(domMocks.append).not.toHaveBeenCalled()
    expect(sharing.atlasTexture).toBe(own.texture)
    sharing.dispose()
    expect(shared.dispose).not.toHaveBeenCalled()

    const windfoil = windfoilBackend()
    domMocks.buildWindfoil.mockResolvedValue(windfoil)
    domMocks.snapshot.mockReturnValue(textSnapshot('AB'))
    const analytic = await DomSdf.create(renderer, source, {
      observe: false,
      textBackend: 'windfoil',
      windfoil: { outlineProvider: () => null },
    })
    domMocks.snapshot.mockReturnValue(textSnapshot('ABC'))
    await analytic.rebuild()
    expect(domMocks.buildWindfoil).toHaveBeenCalledTimes(2)
    expect(domMocks.append).not.toHaveBeenCalled()
    analytic.dispose()
  })

  it('wires a custom vertex hook into text and decoration materials across static-to-animated upgrades', async () => {
    const base = textSnapshot('A')
    const decorated = {
      ...base,
      glyphs: [
        {
          ...base.glyphs[0]!,
          decorations: [
            { line: 'underline' as const, color: [1, 1, 1, 1] as const, thickness: 2, offset: -2 },
          ],
        },
      ],
    }
    domMocks.snapshot.mockReturnValue(decorated)
    domMocks.rasterize.mockResolvedValue(raster())
    domMocks.buildAtlas.mockResolvedValue(atlasWith('A'))
    const vertex = vi.fn(({ position }: { position: unknown }) => position as never)
    const source = document.body.appendChild(document.createElement('article'))
    const domSdf = await DomSdf.create(renderer, source, {
      observe: false,
      motion: { enabled: false, mode: 'none' },
      vertex,
    })
    const evalPositions = () => {
      const content = domSdf.children[0] as Group
      setCurrentStack(stack())
      try {
        for (const child of content.children) {
          const mat = (child as Mesh<InstancedBufferGeometry, GlyphTextMaterial>).material
          const call = ((mat.positionNode as { positionNode?: unknown } | null)?.positionNode ??
            mat.positionNode) as { shaderNode: { jsFunc(): unknown } }
          call.shaderNode.jsFunc()
        }
      } finally {
        setCurrentStack(null)
      }
    }
    evalPositions()
    // Evaluated once for the static text material and once for the static decoration material.
    expect(vertex).toHaveBeenCalledTimes(2)
    domSdf.setMotion({ enabled: true, mode: 'offset' })
    evalPositions()
    // Re-evaluated for both animated twins when upgrading from static 'none' to 'offset'.
    expect(vertex).toHaveBeenCalledTimes(4)
    domSdf.dispose()
  })
})
