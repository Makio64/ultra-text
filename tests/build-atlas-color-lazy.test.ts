import { Texture, type WebGPURenderer } from 'three/webgpu'
import { afterEach, expect, it, vi } from 'vitest'
import type { RasterAtlas, SdfAtlas } from '../src/types.js'

const mocks = vi.hoisted(() => ({ gpu: vi.fn() }))
vi.mock('../src/atlas/gpuAtlas.js', () => ({ buildGpuSdfAtlas: mocks.gpu }))
const raster: RasterAtlas = {
  width: 4,
  height: 4,
  pxRange: 2,
  bakeSize: 32,
  glyphs: new Map(),
  canvas: document.createElement('canvas'),
}
const renderer = { getMaxAnisotropy: () => 1 } as WebGPURenderer
const colorRaster = { ...raster, colorBand: { top: 0, height: 4, data: new Uint8Array(64) } }
const base = (): Omit<SdfAtlas, 'dispose'> & { dispose: ReturnType<typeof vi.fn<() => void>> } => ({
  ...raster,
  texture: new Texture(),
  mode: 'gpu',
  dispose: vi.fn<() => void>(),
})

afterEach(() => {
  vi.doUnmock('../src/atlas/colorGlyphs.js')
  vi.resetModules()
})

it('never loads the colour module for an atlas without a colour band', async () => {
  vi.resetModules()
  const load = vi.fn(() => {
    throw new Error('unexpected colour import')
  })
  vi.doMock('../src/atlas/colorGlyphs.js', load)
  const atlas = base()
  mocks.gpu.mockResolvedValue(atlas)
  const { buildSdfAtlas } = await import('../src/atlas/buildAtlas.js')
  await expect(buildSdfAtlas(renderer, raster, { mode: 'gpu' })).resolves.toBe(atlas)
  expect(load).not.toHaveBeenCalled()
})

it('releases the SDF if cancellation arrives while the colour module is loading', async () => {
  vi.resetModules()
  const controller = new AbortController()
  const createColorLayer = vi.fn()
  vi.doMock('../src/atlas/colorGlyphs.js', () => {
    controller.abort(new Error('cancel lazy colour'))
    return { createColorLayer }
  })
  const atlas = base()
  mocks.gpu.mockResolvedValue(atlas)
  const { buildSdfAtlas } = await import('../src/atlas/buildAtlas.js')
  await expect(
    buildSdfAtlas(renderer, colorRaster, { mode: 'gpu', signal: controller.signal }),
  ).rejects.toThrow('cancel lazy colour')
  expect(atlas.dispose).toHaveBeenCalledOnce()
  expect(createColorLayer).not.toHaveBeenCalled()
})

it('releases both textures once if cancellation arrives during colour texture creation', async () => {
  vi.resetModules()
  const controller = new AbortController()
  const texture = new Texture()
  const dispose = vi.spyOn(texture, 'dispose')
  vi.doMock('../src/atlas/colorGlyphs.js', () => ({
    createColorLayer: () => {
      controller.abort(new Error('cancel colour texture'))
      return { texture, top: 0, height: 4 }
    },
  }))
  const atlas = base()
  mocks.gpu.mockResolvedValue(atlas)
  const { buildSdfAtlas } = await import('../src/atlas/buildAtlas.js')
  await expect(
    buildSdfAtlas(renderer, colorRaster, { mode: 'gpu', signal: controller.signal }),
  ).rejects.toThrow('cancel colour texture')
  expect(atlas.dispose).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})
