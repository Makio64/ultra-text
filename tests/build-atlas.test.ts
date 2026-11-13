import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RasterAtlas, SdfAtlas } from '../src/types.js'

const atlasMocks = vi.hoisted(() => ({
  cpu: vi.fn(),
  gpu: vi.fn(),
}))

vi.mock('../src/atlas/cpuAtlas.js', () => ({
  buildCpuSdfAtlas: atlasMocks.cpu,
}))

vi.mock('../src/atlas/gpuAtlas.js', () => ({
  buildGpuSdfAtlas: atlasMocks.gpu,
}))

import { buildSdfAtlas } from '../src/atlas/buildAtlas.js'

const renderer = {} as Parameters<typeof buildSdfAtlas>[0]
const raster = {
  width: 4,
  height: 4,
  pxRange: 2,
  bakeSize: 32,
  glyphs: new Map(),
  canvas: document.createElement('canvas'),
} satisfies RasterAtlas

type TestAtlas = Omit<SdfAtlas, 'dispose'> & { dispose: ReturnType<typeof vi.fn> }

function atlas(mode: 'gpu' | 'cpu'): TestAtlas {
  return {
    texture: {} as SdfAtlas['texture'],
    width: 4,
    height: 4,
    pxRange: 2,
    bakeSize: 32,
    glyphs: new Map(),
    mode,
    dispose: vi.fn(),
  }
}

describe('buildSdfAtlas', () => {
  beforeEach(() => {
    atlasMocks.cpu.mockReset()
    atlasMocks.gpu.mockReset()
  })

  it('uses the CPU implementation directly when requested', async () => {
    const cpuAtlas = atlas('cpu')
    atlasMocks.cpu.mockReturnValue(cpuAtlas)

    await expect(buildSdfAtlas(renderer, raster, { mode: 'cpu' })).resolves.toBe(cpuAtlas)
    expect(atlasMocks.gpu).not.toHaveBeenCalled()
    expect(atlasMocks.cpu).toHaveBeenCalledOnce()
  })

  it('uses GPU mode and propagates a forced GPU failure', async () => {
    const gpuAtlas = atlas('gpu')
    atlasMocks.gpu.mockResolvedValueOnce(gpuAtlas)
    await expect(buildSdfAtlas(renderer, raster, { mode: 'gpu' })).resolves.toBe(gpuAtlas)

    atlasMocks.gpu.mockRejectedValueOnce(new Error('WebGPU unavailable'))
    await expect(buildSdfAtlas(renderer, raster, { mode: 'gpu' })).rejects.toThrow(
      'WebGPU unavailable',
    )
    expect(atlasMocks.cpu).not.toHaveBeenCalled()
  })

  it('returns the rows of monochrome shapes on the atlas, and repeats them on its texture', async () => {
    for (const mode of ['cpu', 'gpu'] as const) {
      const built = {
        ...atlas(mode),
        shapeTop: 12,
        texture: { userData: {} } as SdfAtlas['texture'],
      }
      atlasMocks[mode].mockResolvedValueOnce(built)
      const result = await buildSdfAtlas(renderer, raster, { mode })
      expect(result).toBe(built)
      expect(result.shapeTop).toBe(12)
      // For a material that is handed the texture without the field.
      expect(built.texture.userData).toEqual({ ultraShapeTop: 12 })

      const plain = { ...atlas(mode), texture: { userData: {} } as SdfAtlas['texture'] }
      atlasMocks[mode].mockResolvedValueOnce(plain)
      const none = await buildSdfAtlas(renderer, raster, { mode })
      expect('shapeTop' in none).toBe(false)
      expect(plain.texture.userData).toEqual({})
    }
  })

  it('forwards opt-in mip and anisotropy settings to the selected builder', async () => {
    const gpuAtlas = atlas('gpu')
    atlasMocks.gpu.mockResolvedValueOnce(gpuAtlas)

    await expect(
      buildSdfAtlas(renderer, raster, {
        mode: 'gpu',
        mipmaps: true,
        anisotropy: 4,
      }),
    ).resolves.toBe(gpuAtlas)
    expect(atlasMocks.gpu).toHaveBeenCalledWith(renderer, raster, {
      mode: 'gpu',
      mipmaps: true,
      anisotropy: 4,
    })
  })

  it('falls back to the exact CPU transform in auto mode and warns once per page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cpuAtlas = atlas('cpu')
    atlasMocks.gpu.mockRejectedValueOnce(new Error('WebGPU unavailable'))
    atlasMocks.cpu.mockReturnValueOnce(cpuAtlas)

    await expect(buildSdfAtlas(renderer, raster)).resolves.toBe(cpuAtlas)
    expect(atlasMocks.cpu).toHaveBeenCalledWith(raster, {})
    // The 10-100× slower path must be diagnosable, but not spam every rebuild.
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('falling back')

    atlasMocks.gpu.mockRejectedValueOnce(new Error('still unavailable'))
    atlasMocks.cpu.mockReturnValueOnce(atlas('cpu'))
    await buildSdfAtlas(renderer, raster)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('honors aborts before work and disposes a completed GPU atlas after a late abort', async () => {
    const early = new AbortController()
    early.abort(new DOMException('early', 'AbortError'))
    await expect(buildSdfAtlas(renderer, raster, { signal: early.signal })).rejects.toThrow('early')
    expect(atlasMocks.gpu).not.toHaveBeenCalled()

    const late = new AbortController()
    const gpuAtlas = atlas('gpu')
    atlasMocks.gpu.mockImplementationOnce(() => {
      late.abort(new DOMException('late', 'AbortError'))
      return Promise.resolve(gpuAtlas)
    })
    await expect(buildSdfAtlas(renderer, raster, { signal: late.signal })).rejects.toThrow('late')
    expect(gpuAtlas.dispose).toHaveBeenCalledOnce()
    expect(atlasMocks.cpu).not.toHaveBeenCalled()
  })

  it('disposes a completed CPU atlas if the signal aborts at its asynchronous boundary', async () => {
    const controller = new AbortController()
    const cpuAtlas = atlas('cpu')
    atlasMocks.cpu.mockImplementationOnce(() => {
      controller.abort(new DOMException('late CPU cancellation', 'AbortError'))
      return Promise.resolve(cpuAtlas)
    })
    await expect(
      buildSdfAtlas(renderer, raster, { mode: 'cpu', signal: controller.signal }),
    ).rejects.toThrow('late CPU cancellation')
    expect(cpuAtlas.dispose).toHaveBeenCalledOnce()
  })
})

describe('colour atlas ownership', () => {
  const colorRaster = { ...raster, colorBand: { top: 0, height: 4, data: new Uint8Array(64) } }
  const colorRenderer = { getMaxAnisotropy: () => 2 } as Parameters<typeof buildSdfAtlas>[0]
  it.each(['gpu', 'cpu', 'auto'] as const)(
    'attaches and disposes both textures in %s mode',
    async (mode) => {
      const base = {
        ...atlas(mode === 'gpu' ? 'gpu' : 'cpu'),
        shapeTop: 8,
        texture: { userData: {} } as SdfAtlas['texture'],
      }
      atlasMocks.cpu.mockResolvedValue(base)
      atlasMocks.gpu.mockImplementation(() =>
        mode === 'auto' ? Promise.reject(new Error('CPU fallback')) : Promise.resolve(base),
      )
      const result = await buildSdfAtlas(colorRenderer, colorRaster, {
        mode,
        mipmaps: true,
        anisotropy: 4,
      })
      expect(result.colorLayer!.texture.anisotropy).toBe(2)
      expect(result.colorLayer!.texture.generateMipmaps).toBe(true)
      // The copy that carries the colour layer keeps every other field of the atlas.
      expect(result.shapeTop).toBe(8)
      const dispose = vi.spyOn(result.colorLayer!.texture, 'dispose')
      result.dispose()
      result.dispose()
      expect(base.dispose).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledOnce()
    },
  )
  it('disposes the finished SDF when attaching the colour texture fails', async () => {
    const base = atlas('gpu')
    atlasMocks.gpu.mockResolvedValue(base)
    const renderer = {
      getMaxAnisotropy() {
        throw new Error('device lost')
      },
    } as unknown as Parameters<typeof buildSdfAtlas>[0]
    await expect(buildSdfAtlas(renderer, colorRaster, { mode: 'gpu' })).rejects.toThrow(
      'device lost',
    )
    expect(base.dispose).toHaveBeenCalledOnce()
  })
})
