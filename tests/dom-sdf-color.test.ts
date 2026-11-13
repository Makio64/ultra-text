import { Mesh, Texture, type WebGPURenderer } from 'three/webgpu'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Rasterize from '../src/atlas/rasterize.js'
import type {
  DomLayoutSnapshot,
  GlyphRequest,
  GlyphSlot,
  RasterAtlas,
  SdfAtlas,
} from '../src/types.js'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), raster: vi.fn(), atlas: vi.fn() }))
vi.mock('../src/dom/snapshot.js', () => ({ collectDomSnapshot: mocks.snapshot }))
vi.mock('../src/atlas/rasterize.js', async (original) => ({
  ...(await original<typeof Rasterize>()),
  rasterizeGlyphAtlas: mocks.raster,
}))
vi.mock('../src/atlas/buildAtlas.js', () => ({ buildSdfAtlas: mocks.atlas }))
import { DomSdf } from '../src/dom/DomSdf.js'
import { SdfTextMaterial } from '../src/text/SdfTextMaterial.js'

const request: GlyphRequest = {
  key: 'emoji',
  character: '👍🏽',
  font: {
    key: 'face',
    family: 'sans-serif',
    canvasFont: '32px sans-serif',
    weight: '400',
    style: 'normal',
    stretch: 'normal',
    variant: 'normal',
    kerning: 'auto',
    featureSettings: 'normal',
    variationSettings: 'normal',
    opticalSizing: 'auto',
    size: 32,
  },
}
const snapshot: DomLayoutSnapshot = {
  width: 100,
  height: 100,
  lineCount: 1,
  atlasSignature: 'emoji',
  requests: [request],
  blocks: [],
  rects: [],
  glyphs: [0, 1].map((sequence) => ({
    glyphKey: 'emoji',
    originX: sequence * 20,
    lineBottom: 20,
    advance: 20,
    fontSize: 32,
    block: 0,
    breakBefore: 'none',
    clip: [0, 0, 100, 100],
    color: [1, 0, 0, 1],
    sequence,
    z: 1,
  })),
}
const slot: GlyphSlot = {
  key: 'emoji',
  character: '👍🏽',
  fontKey: 'face',
  u0: 0.1,
  v0: 0.5,
  u1: 0.9,
  v1: 0.9,
  planeX0: 0,
  planeY0: 0,
  planeX1: 20,
  planeY1: 20,
  descent: 2,
  advance: 20,
}
function atlas(
  color?: boolean,
): Omit<SdfAtlas, 'dispose'> & { dispose: ReturnType<typeof vi.fn<() => void>> } {
  return {
    texture: new Texture(),
    width: 8,
    height: 8,
    bakeSize: 32,
    pxRange: 4,
    mode: 'cpu',
    glyphs: new Map([['emoji', { ...slot, ...(color === undefined ? {} : { color }) }]]),
    ...(color ? { colorLayer: { texture: new Texture(), top: 4, height: 4 } } : {}),
    dispose: vi.fn<() => void>(),
  }
}
const raster: RasterAtlas = {
  canvas: document.createElement('canvas'),
  width: 8,
  height: 8,
  bakeSize: 32,
  pxRange: 4,
  glyphs: new Map(),
}
const renderer = {} as WebGPURenderer

beforeEach(() => {
  mocks.snapshot.mockReturnValue(snapshot)
  mocks.raster.mockReset().mockResolvedValue(raster)
  mocks.atlas.mockReset().mockResolvedValue(atlas(true))
})

describe('DomSdf colour atlas integration', () => {
  it('releases both owned textures once when a custom fill rejects construction', async () => {
    const owned = atlas(true)
    const sdfDispose = vi.spyOn(owned.texture, 'dispose')
    const colorDispose = vi.spyOn(owned.colorLayer!.texture, 'dispose')
    owned.dispose.mockImplementation(() => {
      owned.texture.dispose()
      owned.colorLayer!.texture.dispose()
    })
    mocks.atlas.mockResolvedValue(owned)
    await expect(
      DomSdf.create(renderer, document.createElement('div'), {
        observe: false,
        fill: () => {
          throw new Error('reject colour fill')
        },
      }),
    ).rejects.toThrow('reject colour fill')
    expect(owned.dispose).toHaveBeenCalledOnce()
    expect(sdfDispose).toHaveBeenCalledOnce()
    expect(colorDispose).toHaveBeenCalledOnce()
  })
  it('requires candidate slots to have been tested before reusing a shared atlas', async () => {
    const untested = atlas()
    const dom = await DomSdf.create(renderer, document.createElement('div'), {
      observe: false,
      sharedAtlas: untested,
    })
    expect(mocks.raster).toHaveBeenCalledOnce()
    expect(dom.stats.colorGlyphs).toBe(2)
    expect(dom.stats.textStorageBytes).toBe(64 + 8 * 4 * 4)
    expect(dom.options.colorGlyphs).toBeUndefined()
    dom.dispose()
    expect(untested.dispose).not.toHaveBeenCalled()
  })
  it.each([true, false])('reuses a verified shared slot with colour=%s', async (color) => {
    const shared = atlas(color)
    const dom = await DomSdf.create(renderer, document.createElement('div'), {
      observe: false,
      sharedAtlas: shared,
    })
    expect(mocks.raster).not.toHaveBeenCalled()
    expect(dom.stats.colorGlyphs).toBe(color ? 2 : 0)
    dom.dispose()
    expect(shared.dispose).not.toHaveBeenCalled()
  })
  it('allows monochrome mode to reuse an untested shared atlas and forwards explicit modes', async () => {
    const dom = await DomSdf.create(renderer, document.createElement('div'), {
      observe: false,
      sharedAtlas: atlas(),
      colorGlyphs: 'none',
    })
    expect(mocks.raster).not.toHaveBeenCalled()
    dom.dispose()
    const fresh = await DomSdf.create(renderer, document.createElement('div'), {
      observe: false,
      colorGlyphs: 'all',
    })
    expect(mocks.raster.mock.calls[0]![2]).toHaveProperty('colorGlyphs', 'all')
    fresh.dispose()
  })
  it('counts colour mip storage and retains the graph across an in-place update', async () => {
    const retained = atlas(true)
    mocks.atlas.mockResolvedValue(retained)
    const dom = await DomSdf.create(renderer, document.createElement('div'), {
      observe: false,
      quality: 'high',
    })
    expect(dom.stats.textStorageBytes).toBe(85 + 4 * (32 + 8 + 2 + 1))
    const meshes: Mesh[] = []
    dom.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof SdfTextMaterial)
        meshes.push(object as Mesh)
    })
    const material = meshes[0]!.material
    await dom.rebuild()
    expect(meshes[0]!.material).toBe(material)
    expect(mocks.atlas).toHaveBeenCalledOnce()
    dom.dispose()
    dom.dispose()
    expect(retained.dispose).toHaveBeenCalledOnce()
  })
  it('revalidates previously untested shared emoji slots when a subset expands', async () => {
    const plain = { ...request, key: 'plain', character: 'A' }
    const shared = {
      ...atlas(),
      glyphs: new Map([
        ['plain', { ...slot, key: 'plain', character: 'A' }],
        ['emoji', slot],
      ]),
    }
    mocks.snapshot.mockReturnValue({
      ...snapshot,
      atlasSignature: 'plain',
      requests: [plain],
      glyphs: [{ ...snapshot.glyphs[0]!, glyphKey: 'plain' }],
    })
    const dom = await DomSdf.create(renderer, document.createElement('div'), {
      observe: false,
      sharedAtlas: shared,
    })
    expect(mocks.raster).not.toHaveBeenCalled()
    mocks.snapshot.mockReturnValue({
      ...snapshot,
      atlasSignature: 'plain+emoji',
      requests: [plain, request],
      glyphs: [{ ...snapshot.glyphs[0]!, glyphKey: 'plain' }, snapshot.glyphs[1]!],
    })
    await dom.rebuild()
    expect(mocks.raster).toHaveBeenCalledOnce()
    expect(dom.atlasTexture).not.toBe(shared.texture)
    dom.dispose()
    expect(shared.dispose).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'updates the colour shader when a shared subset gains bitmap SVG (text colour=%s)',
    async (textColor) => {
      const shape: GlyphRequest = {
        ...request,
        key: 'bitmap',
        character: '\ufffc',
        shape: { bitmap: true, paths: [], box: [1000, 1000], bounds: [0, 0, 1000, 1000] },
      }
      const shared = {
        ...atlas(true),
        glyphs: new Map([
          ['emoji', { ...slot, color: textColor }],
          ['bitmap', { ...slot, key: 'bitmap', character: '\ufffc', color: true }],
        ]),
      }
      const fresh = {
        ...atlas(true),
        glyphs: new Map([
          ['emoji', slot],
          ['bitmap', { ...slot, key: 'bitmap', character: '\ufffc', color: true }],
        ]),
      }
      mocks.atlas.mockResolvedValue(fresh)
      const textMaterial = (dom: DomSdf): SdfTextMaterial | undefined => {
        let result: SdfTextMaterial | undefined
        dom.traverse((object) => {
          if (object instanceof Mesh && object.material instanceof SdfTextMaterial)
            result = object.material
        })
        return result
      }
      const dom = await DomSdf.create(renderer, document.createElement('div'), {
        observe: false,
        sharedAtlas: shared,
        colorGlyphs: 'none',
        svg: true,
      })
      expect(mocks.raster).not.toHaveBeenCalled()
      const original = textMaterial(dom)
      mocks.snapshot.mockReturnValue({
        ...snapshot,
        atlasSignature: 'emoji+bitmap',
        requests: [request, shape],
        glyphs: [
          ...snapshot.glyphs,
          { ...snapshot.glyphs[0]!, glyphKey: 'bitmap', shapeGroup: 0, sequence: 2 },
        ],
      })
      await dom.rebuild()
      if (textColor) {
        expect(mocks.raster).toHaveBeenCalledOnce()
        expect(dom.atlasTexture).toBe(fresh.texture)
      } else {
        expect(mocks.raster).not.toHaveBeenCalled()
        expect(dom.atlasTexture).toBe(shared.texture)
      }
      expect(textMaterial(dom)).not.toBe(original)
      dom.dispose()
      expect(shared.dispose).not.toHaveBeenCalled()
    },
  )
})
