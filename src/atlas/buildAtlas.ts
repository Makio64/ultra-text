import type { WebGPURenderer } from 'three/webgpu'

import type { BuildSdfAtlasOptions, RasterAtlas, SdfAtlas } from '../types.js'
import { buildGpuSdfAtlas } from './gpuAtlas.js'

function retainAtlas(atlas: SdfAtlas, signal?: AbortSignal): SdfAtlas {
  if (signal?.aborted) {
    atlas.dispose()
    signal.throwIfAborted()
  }
  return atlas
}

async function withColorLayer(
  atlas: SdfAtlas,
  raster: RasterAtlas,
  renderer: WebGPURenderer,
  options: BuildSdfAtlasOptions,
): Promise<SdfAtlas> {
  if (!raster.colorBand) return atlas
  let colorLayer: SdfAtlas['colorLayer']
  try {
    const { createColorLayer } = await import('./colorGlyphs.js')
    options.signal?.throwIfAborted()
    colorLayer = createColorLayer(
      raster.colorBand,
      raster.width,
      options,
      renderer.getMaxAnisotropy(),
    )
    options.signal?.throwIfAborted()
    let disposed = false
    return {
      ...atlas,
      colorLayer,
      dispose() {
        if (disposed) return
        disposed = true
        try {
          atlas.dispose()
        } finally {
          colorLayer!.texture.dispose()
        }
      },
    }
  } catch (error) {
    try {
      atlas.dispose()
    } finally {
      colorLayer?.texture.dispose()
    }
    throw error
  }
}

let warnedGpuFallback = false

/**
 * Builds the retained single-channel SDF atlas from a packed glyph mask.
 *
 * `mode: 'gpu'` runs the WebGPU compute encoder and rethrows if a real WebGPU
 * backend is unavailable, if the device's limits cannot hold the passes, or if
 * the device reports an error for them; `'cpu'` runs the exact Euclidean
 * distance transform; the default `'auto'` tries the GPU path first and falls
 * back to the CPU encoder, warning once per page because the fallback is
 * 10-100× slower.
 * An aborted `signal` rejects with the abort reason and disposes any atlas
 * that was already produced. The caller owns the returned atlas.
 */
export async function buildSdfAtlas(
  renderer: WebGPURenderer,
  raster: RasterAtlas,
  options: BuildSdfAtlasOptions = {},
): Promise<SdfAtlas> {
  const mode = options.mode
  options.signal?.throwIfAborted()

  const buildCpu = async (): Promise<SdfAtlas> => {
    const { buildCpuSdfAtlas } = await import('./cpuAtlas.js')
    options.signal?.throwIfAborted()
    return retainAtlas(await buildCpuSdfAtlas(raster, options), options.signal)
  }
  let atlas: SdfAtlas
  if (mode === 'cpu') atlas = await buildCpu()
  else {
    try {
      atlas = retainAtlas(await buildGpuSdfAtlas(renderer, raster, options), options.signal)
    } catch (error) {
      if (mode === 'gpu') throw error
      options.signal?.throwIfAborted()
      if (!warnedGpuFallback) {
        warnedGpuFallback = true
        console.warn('ultra-text: falling back to CPU SDF', error)
      }
      atlas = await buildCpu()
    }
  }
  // `SdfAtlas.shapeTop` names the rows of the monochrome shapes. The texture repeats it for
  // a material that is handed the texture without that field.
  if (atlas.shapeTop !== undefined) atlas.texture.userData['ultraShapeTop'] = atlas.shapeTop
  return withColorLayer(atlas, raster, renderer, options)
}
