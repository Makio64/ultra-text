import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  UnsignedByteType,
  type DataTexture,
} from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { buildCpuSdfAtlas } from '../src/atlas/cpuAtlas.js'
import type { RasterAtlas } from '../src/types.js'

function rasterWithAlpha(alpha: readonly number[], contextAvailable = true): RasterAtlas {
  const canvas = document.createElement('canvas')
  canvas.width = alpha.length
  canvas.height = 1
  const rgba = new Uint8ClampedArray(alpha.length * 4)
  for (const [index, value] of alpha.entries()) rgba[index * 4 + 3] = value
  vi.spyOn(canvas, 'getContext').mockReturnValue(
    contextAvailable
      ? ({
          getImageData: () => ({ data: rgba }),
        } as unknown as GPUCanvasContext)
      : null,
  )
  return {
    canvas,
    width: alpha.length,
    height: 1,
    bakeSize: 32,
    pxRange: 4,
    glyphs: new Map(),
  }
}

describe('buildCpuSdfAtlas', () => {
  it('creates a compact linear-filtered R8 texture and owns its disposal', async () => {
    const atlas = await buildCpuSdfAtlas(rasterWithAlpha([0, 0, 255, 255, 0]))
    const texture = atlas.texture as DataTexture
    const dispose = vi.spyOn(texture, 'dispose')

    expect(atlas.mode).toBe('cpu')
    expect(atlas.width).toBe(5)
    expect(texture.format).toBe(RedFormat)
    expect(texture.type).toBe(UnsignedByteType)
    expect(texture.colorSpace).toBe(NoColorSpace)
    expect(texture.minFilter).toBe(LinearFilter)
    expect(texture.magFilter).toBe(LinearFilter)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.flipY).toBe(false)
    expect([...(texture.image.data as Uint8Array)]).toHaveLength(5)

    atlas.dispose()
    atlas.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('carries the rows of monochrome shapes from the raster to the atlas', async () => {
    // What `rasterizeGlyphAtlas` returns beside the public raster fields, when it packed shapes.
    const raster = { ...rasterWithAlpha([0, 255, 255, 0]), shapeTop: 0 }
    for (const cpuWorker of [false, true]) {
      const atlas = await buildCpuSdfAtlas(raster, { cpuWorker })
      expect(atlas.shapeTop).toBe(0)
      atlas.dispose()
    }
    const plain = await buildCpuSdfAtlas(rasterWithAlpha([0, 255, 255, 0]))
    expect('shapeTop' in plain).toBe(false)
    plain.dispose()
  })

  it('fails clearly when Canvas 2D is unavailable', async () => {
    const raster = rasterWithAlpha([0], false)
    await expect(buildCpuSdfAtlas(raster)).rejects.toThrow('Canvas 2D is unavailable')
  })

  it('keeps mipmaps and anisotropy behind explicit texture options', async () => {
    const atlas = await buildCpuSdfAtlas(rasterWithAlpha([0, 255, 0]), {
      mipmaps: true,
      anisotropy: 4,
    })
    const texture = atlas.texture as DataTexture

    expect(texture.generateMipmaps).toBe(true)
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter)
    expect(texture.magFilter).toBe(LinearFilter)
    expect(texture.anisotropy).toBe(4)
    atlas.dispose()
  })
})
