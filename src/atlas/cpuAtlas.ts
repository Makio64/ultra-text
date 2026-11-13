import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  UnsignedByteType,
} from 'three/webgpu'

import type { BuildSdfAtlasOptions, RasterAtlas, SdfAtlas } from '../types.js'
import { alphaOfRgba, encodeSdfFromAlpha } from './cpuSdf.js'
import type { ShapeRows } from './rasterize.js'

function readPixels(raster: RasterAtlas): Uint8ClampedArray {
  const context = raster.canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('buildCpuSdfAtlas: Canvas 2D is unavailable')
  return context.getImageData(0, 0, raster.width, raster.height).data
}

export async function buildCpuSdfAtlas(
  raster: RasterAtlas,
  options: Omit<BuildSdfAtlasOptions, 'mode'> = {},
): Promise<SdfAtlas> {
  const { width, height, pxRange, bakeSize, glyphs, shapeTop } = raster as RasterAtlas & ShapeRows
  const { signal, mipmaps = false, anisotropy = 1, cpuWorker } = options
  signal?.throwIfAborted()
  let rgba = readPixels(raster)
  let sdf: Uint8Array | undefined
  if (cpuWorker !== false && typeof Worker !== 'undefined') {
    try {
      const { encodeInWorker } = await import('./cpuWorker.js')
      // The worker takes the alpha out of the pixels: on an M3 Max at 8 Mpx, that loop is
      // ~15 ms of this thread in Chrome and ~7 in WebKit. (Sending an ImageBitmap of the
      // canvas instead costs WebKit's page thread more than the readback it saves.)
      sdf = await encodeInWorker(rgba, width, height, pxRange, signal)
    } catch {
      signal?.throwIfAborted()
      // A worker can fail to load under CSP or an older bundler. Its transferred
      // input may already be detached, so recapture before the synchronous fallback.
      if (rgba.byteLength === 0) rgba = readPixels(raster)
    }
  }
  signal?.throwIfAborted()
  sdf ??= encodeSdfFromAlpha(alphaOfRgba(rgba, width * height), width, height, pxRange)
  const texture = new DataTexture(sdf, width, height, RedFormat, UnsignedByteType)
  texture.name = 'ultra-text runtime SDF atlas (CPU EDT)'
  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.generateMipmaps = mipmaps
  texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter
  texture.magFilter = LinearFilter
  texture.anisotropy = mipmaps ? Math.max(1, anisotropy) : 1
  texture.needsUpdate = true

  let disposed = false
  return {
    ...(shapeTop === undefined ? {} : { shapeTop }),
    texture,
    width,
    height,
    pxRange,
    bakeSize,
    glyphs,
    mode: 'cpu',
    dispose(): void {
      if (disposed) return
      disposed = true
      texture.dispose()
    },
  }
}
