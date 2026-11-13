import {
  ExternalTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  WebGPUBackend,
  type WebGPURenderer,
} from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { buildSdfAtlas } from '../src/atlas/buildAtlas.js'
import { buildGpuSdfAtlas, encodeGpuSdf, prepareAtlasPasses } from '../src/atlas/gpuAtlas.js'
import { JFA_WGSL } from '../src/atlas/jfaWgsl.js'
import type { ShapeRows } from '../src/atlas/rasterize.js'
import type { RasterAtlas, SdfAtlas } from '../src/types.js'

const buildCpuSdfAtlas = vi.hoisted(() => vi.fn<() => Promise<SdfAtlas>>())
vi.mock('../src/atlas/cpuAtlas.js', () => ({ buildCpuSdfAtlas }))

const BUFFER_USAGE = { COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }
const TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 }

beforeEach(() => {
  vi.stubGlobal('GPUBufferUsage', BUFFER_USAGE)
  vi.stubGlobal('GPUTextureUsage', TEXTURE_USAGE)
})
afterEach(() => vi.unstubAllGlobals())

function raster(width: number, height: number, pxRange = 4): RasterAtlas {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, width, height, bakeSize: 32, pxRange, glyphs: new Map() }
}

// The WebGPU defaults of a device without 'core-features-and-limits' (Chrome 155 reports these).
const compatLimits = {
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728,
  maxComputeInvocationsPerWorkgroup: 128,
  maxComputeWorkgroupSizeX: 128,
  maxComputeWorkgroupSizeY: 128,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBuffersInFragmentStage: 4,
  maxTextureDimension2D: 4096,
}

interface FakeBuffer {
  size: number
  usage: number
  destroy: Mock<() => void>
}

interface FakeTexture {
  size: [number, number]
  format: string
  usage: number
  mipLevelCount: number
  createView: Mock<(descriptor?: object) => object>
  destroy: Mock<() => void>
}

interface FakeBindGroup {
  layout: string
  entries: { binding: number; resource: unknown }[]
}

type ErrorFilter = 'validation' | 'out-of-memory' | 'internal'

/**
 * A device that logs its calls in `events` and keeps what it made. Its error scopes answer
 * through `report`, which sees each filter as it is popped.
 */
function fakeDevice() {
  const events: string[] = []
  const buffers: FakeBuffer[] = []
  const textures: FakeTexture[] = []
  const bindGroups: FakeBindGroup[] = []
  const dispatches: [number, number][] = []
  const scopes: ErrorFilter[] = []
  const report = vi.fn<(filter: ErrorFilter) => Promise<{ message: string } | null>>(() =>
    Promise.resolve(null),
  )
  const pipeline = (entryPoint: string) => ({
    entryPoint,
    getBindGroupLayout: (index: number) => `${entryPoint} layout ${index}`,
  })
  const pass = () => ({
    setPipeline: (made: { entryPoint: string }) => void events.push(made.entryPoint),
    setBindGroup: vi.fn(),
    dispatchWorkgroups: (x: number, y: number) => {
      dispatches.push([x, y])
      events.push('dispatch')
    },
    draw: () => void events.push('draw'),
    end: () => void events.push('end'),
  })
  const device = {
    limits: compatLimits as Partial<typeof compatLimits>,
    createShaderModule: vi.fn((descriptor: { code: string }) => ({ code: descriptor.code })),
    createComputePipeline: vi.fn((descriptor: { compute: { entryPoint: string } }) =>
      pipeline(descriptor.compute.entryPoint),
    ),
    createRenderPipeline: vi.fn((descriptor: { fragment: { entryPoint: string } }) =>
      pipeline(descriptor.fragment.entryPoint),
    ),
    createBuffer: vi.fn((descriptor: { size: number; usage: number }) => {
      const buffer = { ...descriptor, destroy: vi.fn(() => void events.push('destroy buffer')) }
      buffers.push(buffer)
      return buffer
    }),
    createTexture: vi.fn(
      (descriptor: {
        size: [number, number]
        format: string
        usage: number
        mipLevelCount?: number
      }) => {
        const texture: FakeTexture = {
          ...descriptor,
          mipLevelCount: descriptor.mipLevelCount ?? 1,
          createView: vi.fn((view?: object) => ({ texture: descriptor.format, ...view })),
          destroy: vi.fn(() => void events.push(`destroy ${descriptor.format}`)),
        }
        textures.push(texture)
        return texture
      },
    ),
    createBindGroup: vi.fn((descriptor: FakeBindGroup) => {
      bindGroups.push(descriptor)
      return descriptor
    }),
    createCommandEncoder: vi.fn(() => ({
      copyTextureToBuffer: vi.fn(() => void events.push('copy to buffer')),
      copyTextureToTexture: vi.fn(() => void events.push('copy to texture')),
      beginComputePass: vi.fn(() => {
        events.push('compute pass')
        return pass()
      }),
      beginRenderPass: vi.fn(() => {
        events.push('render pass')
        return pass()
      }),
      finish: () => 'commands',
    })),
    queue: {
      writeBuffer: vi.fn(
        (_buffer: unknown, _offset: number, _data: Int32Array) => void events.push('write params'),
      ),
      copyExternalImageToTexture: vi.fn(() => void events.push('upload')),
      submit: vi.fn(() => void events.push('submit')),
    },
    pushErrorScope: vi.fn((filter: ErrorFilter) => {
      scopes.push(filter)
      events.push(`push ${filter}`)
    }),
    popErrorScope: vi.fn(() => {
      const filter = scopes.pop()
      if (!filter) return Promise.reject(new Error('empty error scope stack'))
      events.push(`pop ${filter}`)
      return report(filter)
    }),
  }
  return { device, events, buffers, textures, bindGroups, dispatches, scopes, report }
}

/** A WebGPU backend around a fake device, with three's mip pass mocked. */
function rendererHarness() {
  const fake = fakeDevice()
  const backend = Object.create(WebGPUBackend.prototype) as WebGPUBackend
  const generateMipmaps = vi.fn()
  Object.assign(backend, { device: fake.device, generateMipmaps })
  const initTexture = vi.fn()
  const renderer = {
    backend,
    getMaxAnisotropy: () => 16,
    init: vi.fn(() => Promise.resolve()),
    initTexture,
  } as unknown as WebGPURenderer
  return { renderer, generateMipmaps, initTexture, ...fake }
}

const output = (h: ReturnType<typeof rendererHarness>) =>
  h.textures.find((texture) => texture.format === 'r8unorm')!

describe('buildGpuSdfAtlas', () => {
  it('dispatches the passes as 8x8 workgroups with partial-tile coverage', async () => {
    const h = rendererHarness()
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(17, 33))
    // The seeds, then the two steps of a pxRange 4 ladder.
    expect(h.dispatches).toEqual([
      [3, 5],
      [3, 5],
      [3, 5],
    ])
    atlas.dispose()
  })

  it('uploads, copies, floods and resolves in one submission, then releases the transients', async () => {
    const h = rendererHarness()
    const input = raster(17, 33)
    const atlas = await buildGpuSdfAtlas(h.renderer, input)
    const upload = h.textures.find((texture) => texture.format === 'rgba8unorm')!
    expect(h.device.queue.copyExternalImageToTexture).toHaveBeenCalledWith(
      { source: input.canvas, flipY: false },
      { texture: upload, premultipliedAlpha: false },
      [17, 33],
    )
    expect(h.events.slice(h.events.indexOf('copy to buffer'))).toEqual([
      'copy to buffer',
      'compute pass',
      'seedMain',
      'dispatch',
      'jumpMain',
      'dispatch',
      'dispatch',
      'end',
      'render pass',
      'resolveFrag',
      'draw',
      'end',
      'submit',
      'pop internal',
      'pop out-of-memory',
      'pop validation',
      'destroy rgba8unorm',
      'destroy buffer',
      'destroy buffer',
      'destroy buffer',
      'destroy buffer',
    ])
    expect(h.device.queue.submit).toHaveBeenCalledOnce()
    // The raster words, two vec2<f32> seed buffers and the parameters.
    expect(h.buffers.map((buffer) => [buffer.size, buffer.usage])).toEqual([
      [256 * 33, BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST],
      [17 * 33 * 8, BUFFER_USAGE.STORAGE],
      [17 * 33 * 8, BUFFER_USAGE.STORAGE],
      [2 * 256 + 16, BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST],
    ])
    expect(output(h).destroy).not.toHaveBeenCalled()
    atlas.dispose()
  })

  it.each([
    [1, 256],
    [64, 256],
    [65, 512],
    [2048, 8192],
  ])('pads a %i-texel raster row to %i bytes', async (width, bytesPerRow) => {
    const h = rendererHarness()
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(width, 3))
    expect(h.buffers[0]!.size).toBe(bytesPerRow * 3)
    const params = h.device.queue.writeBuffer.mock.calls[0]![2]
    // width, height, row stride in words, then 1 / pxRange as f32.
    expect([...params.subarray(0, 3)]).toEqual([width, 3, bytesPerRow / 4])
    expect(new Float32Array(params.buffer, 12, 1)[0]).toBe(0.25)
    atlas.dispose()
  })

  it('walks the jump ladder between both seed buffers and resolves the last one written', async () => {
    const h = rendererHarness()
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(40, 20, 32))
    const params = h.device.queue.writeBuffer.mock.calls[0]![2]
    const steps = [16, 8, 4, 2, 1]
    steps.forEach((step, index) => {
      expect([...params.subarray((index + 1) * 64, (index + 1) * 64 + 3)]).toEqual([40, 20, step])
    })
    const [words, seedA, seedB, uniforms] = h.buffers
    const storage = (group: FakeBindGroup) =>
      group.entries.slice(1).map((entry) => (entry.resource as { buffer: unknown }).buffer)
    const [seed, ...rest] = h.bindGroups
    expect(storage(seed!)).toEqual([words, seedA])
    rest.slice(0, steps.length).forEach((group, index) => {
      expect(group.entries[0]!.resource).toEqual({
        buffer: uniforms,
        offset: (index + 1) * 256,
        size: 16,
      })
      expect(storage(group)).toEqual(index % 2 ? [seedB, seedA] : [seedA, seedB])
    })
    // Five steps end in seedB.
    expect(storage(rest[steps.length]!)).toEqual([seedB])
    atlas.dispose()
  })

  it('makes its shader module and pipelines once per device, whatever the atlas size', async () => {
    const h = rendererHarness()
    const atlases = await Promise.all([
      buildGpuSdfAtlas(h.renderer, raster(17, 33)),
      buildGpuSdfAtlas(h.renderer, raster(48, 35, 32)),
    ])
    atlases.push(await buildGpuSdfAtlas(h.renderer, raster(5, 7, 12)))
    expect(h.device.createShaderModule).toHaveBeenCalledOnce()
    expect(h.device.createShaderModule.mock.calls[0]![0].code).toBe(JFA_WGSL)
    expect(h.device.createComputePipeline).toHaveBeenCalledTimes(2)
    expect(h.device.createRenderPipeline).toHaveBeenCalledOnce()
    for (const atlas of atlases) atlas.dispose()
    const other = rendererHarness()
    ;(await buildGpuSdfAtlas(other.renderer, raster(4, 4))).dispose()
    expect(other.device.createShaderModule).toHaveBeenCalledOnce()
  })

  it('wraps the field in an ExternalTexture that the atlas disposes once', async () => {
    const h = rendererHarness()
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(17, 33))
    const texture = atlas.texture as ExternalTexture
    expect(texture).toBeInstanceOf(ExternalTexture)
    expect(texture.sourceTexture).toBe(output(h))
    expect(texture.colorSpace).toBe(NoColorSpace)
    // The public texture metadata must describe the owned r8unorm field, so Three samples
    // one channel and preserves the atlas's scalar shader bindings across backends.
    expect(texture.format).toBe(RedFormat)
    expect([texture.minFilter, texture.magFilter, texture.generateMipmaps]).toEqual([
      LinearFilter,
      LinearFilter,
      false,
    ])
    expect(texture.image).toEqual({ width: 17, height: 33 })
    expect(atlas).toMatchObject({ width: 17, height: 33, pxRange: 4, bakeSize: 32, mode: 'gpu' })
    expect(output(h).mipLevelCount).toBe(1)
    expect(output(h).usage).toBe(
      TEXTURE_USAGE.RENDER_ATTACHMENT |
        TEXTURE_USAGE.TEXTURE_BINDING |
        TEXTURE_USAGE.COPY_SRC |
        TEXTURE_USAGE.COPY_DST,
    )
    const disposed = vi.fn()
    texture.addEventListener('dispose', disposed)
    atlas.dispose()
    atlas.dispose()
    expect(disposed).toHaveBeenCalledOnce()
    expect(output(h).destroy).toHaveBeenCalledOnce()
    expect(h.generateMipmaps).not.toHaveBeenCalled()
  })

  it("asks three's mip pass for the full chain when mipmaps are requested", async () => {
    const h = rendererHarness()
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(300, 40), {
      mipmaps: true,
      anisotropy: 32,
    })
    const texture = atlas.texture
    expect(output(h).mipLevelCount).toBe(9)
    // The material keeps whole quads over a texture that says it has mipmaps.
    expect(texture.generateMipmaps).toBe(true)
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter)
    expect(texture.anisotropy).toBe(16)
    expect(h.initTexture).toHaveBeenCalledWith(texture)
    expect(h.generateMipmaps).toHaveBeenCalledWith(texture)
    // Level 0 only: the resolve writes one level and three fills the rest after it.
    expect(output(h).createView).toHaveBeenCalledWith({ mipLevelCount: 1 })
    atlas.dispose()
  })

  it.each(['initTexture', 'generateMipmaps'] as const)(
    'releases the texture when %s fails before the atlas is returned',
    async (method) => {
      const h = rendererHarness()
      let texture: SdfAtlas['texture'] | undefined
      const disposed = vi.fn()
      h.initTexture.mockImplementation((value: SdfAtlas['texture']) => {
        texture = value
        texture.addEventListener('dispose', disposed)
        if (method === 'initTexture') throw new Error('mip setup failed')
      })
      if (method === 'generateMipmaps') {
        h.generateMipmaps.mockImplementation(() => {
          throw new Error('mip setup failed')
        })
      }
      await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33), { mipmaps: true })).rejects.toThrow(
        'mip setup failed',
      )
      expect(texture).toBeInstanceOf(ExternalTexture)
      expect(disposed).toHaveBeenCalledOnce()
      for (const made of [...h.buffers, ...h.textures]) expect(made.destroy).toHaveBeenCalledOnce()
    },
  )

  it('rejects and releases a mipmapped atlas when the device rejects its mip pass', async () => {
    const h = rendererHarness()
    h.generateMipmaps.mockImplementation(() => {
      h.report.mockImplementationOnce(() => Promise.resolve({ message: 'mip pass failed' }))
    })
    await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33), { mipmaps: true })).rejects.toThrow(
      'mip pass failed',
    )
    expect(h.scopes).toEqual([])
    for (const made of [...h.buffers, ...h.textures]) expect(made.destroy).toHaveBeenCalledOnce()
  })

  it('carries the rows of monochrome shapes from the raster to the atlas', async () => {
    const h = rendererHarness()
    const shaped: RasterAtlas & ShapeRows = { ...raster(17, 33), shapeTop: 12 }
    const atlas = await buildGpuSdfAtlas(h.renderer, shaped)
    expect(atlas.shapeTop).toBe(12)
    atlas.dispose()
  })

  it('runs on the compatibility-mode default limits', async () => {
    const h = rendererHarness()
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(2048, 2048, 12))
    expect(atlas.mode).toBe('gpu')
    atlas.dispose()
  })

  it.each([
    ['maxComputeInvocationsPerWorkgroup', { maxComputeInvocationsPerWorkgroup: 32 }, 64, 64],
    ['maxStorageBuffersInFragmentStage', { maxStorageBuffersInFragmentStage: 0 }, 64, 64],
    ['maxTextureDimension2D', { maxTextureDimension2D: 1024 }, 1100, 64],
    ['storage-buffer', { maxStorageBufferBindingSize: 1 << 20 }, 512, 512],
  ])('rejects before any GPU work past the %s limit', async (name, limits, width, height) => {
    const h = rendererHarness()
    h.device.limits = { ...compatLimits, ...limits }
    await expect(buildGpuSdfAtlas(h.renderer, raster(width, height))).rejects.toThrow(
      new RegExp(name),
    )
    expect(h.device.createBuffer).not.toHaveBeenCalled()
    expect(h.device.createTexture).not.toHaveBeenCalled()
    expect(h.device.pushErrorScope).not.toHaveBeenCalled()
  })

  it.each(['createCommandEncoder', 'GPUBufferUsage'] as const)(
    'rejects before any GPU work without %s',
    async (missing) => {
      const h = rendererHarness()
      if (missing === 'GPUBufferUsage') vi.stubGlobal('GPUBufferUsage', undefined)
      else Object.assign(h.device, { createCommandEncoder: undefined })
      await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33))).rejects.toThrow(
        'cannot run the atlas passes',
      )
      expect(h.device.createBuffer).not.toHaveBeenCalled()
    },
  )

  it('rejects on a renderer without the WebGPU backend', async () => {
    const renderer = {
      backend: { isWebGLBackend: true },
      init: () => Promise.resolve(),
    } as unknown as WebGPURenderer
    await expect(buildGpuSdfAtlas(renderer, raster(17, 33))).rejects.toThrow(
      'requires the WebGPU backend',
    )
  })

  it.each(['validation', 'out-of-memory', 'internal'] as const)(
    'rejects and releases everything on a %s error, then makes its passes again',
    async (filter) => {
      const h = rendererHarness()
      h.report.mockImplementation((popped) =>
        Promise.resolve(popped === filter ? { message: `${filter} failure` } : null),
      )
      await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33))).rejects.toThrow(
        `the device rejected the atlas passes: ${filter} failure`,
      )
      for (const made of [...h.buffers, ...h.textures]) expect(made.destroy).toHaveBeenCalledOnce()
      expect(h.scopes).toEqual([])
      h.report.mockResolvedValue(null)
      ;(await buildGpuSdfAtlas(h.renderer, raster(17, 33))).dispose()
      expect(h.device.createShaderModule).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects when the device cannot report on the passes', async () => {
    const h = rendererHarness()
    h.report.mockRejectedValue(new Error('device lost'))
    await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33))).rejects.toThrow(
      'the device rejected the atlas passes: Error: device lost',
    )
    expect(output(h).destroy).toHaveBeenCalledOnce()
  })

  it('builds without error scopes on a device that has none', async () => {
    const h = rendererHarness()
    Object.assign(h.device, { pushErrorScope: undefined, popErrorScope: undefined })
    const atlas = await buildGpuSdfAtlas(h.renderer, raster(17, 33))
    expect(atlas.mode).toBe('gpu')
    atlas.dispose()
  })

  it('closes its scopes and releases everything when a call throws', async () => {
    const h = rendererHarness()
    h.device.queue.copyExternalImageToTexture.mockImplementation(() => {
      throw new DOMException('The canvas is tainted', 'SecurityError')
    })
    await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33))).rejects.toThrow('tainted')
    expect(h.scopes).toEqual([])
    for (const made of [...h.buffers, ...h.textures]) expect(made.destroy).toHaveBeenCalledOnce()
    expect(h.device.queue.submit).not.toHaveBeenCalled()
  })
})

describe('prepareAtlasPasses', () => {
  it('makes the passes ahead of the first atlas, which reuses them', async () => {
    const h = rendererHarness()
    prepareAtlasPasses(h.renderer)
    prepareAtlasPasses(h.renderer)
    expect(h.device.createShaderModule).toHaveBeenCalledOnce()
    expect(h.device.createComputePipeline).toHaveBeenCalledTimes(2)
    expect(h.device.queue.submit).toHaveBeenCalledExactlyOnceWith([])
    ;(await buildGpuSdfAtlas(h.renderer, raster(17, 33))).dispose()
    expect(h.device.createShaderModule).toHaveBeenCalledOnce()
  })

  it('leaves passes the device rejected to fail the first atlas, which makes them again', async () => {
    const h = rendererHarness()
    prepareAtlasPasses(h.renderer)
    // The submission that used the rejected passes reports them.
    h.report.mockImplementationOnce(() => Promise.resolve({ message: 'invalid pipeline' }))
    await expect(buildGpuSdfAtlas(h.renderer, raster(17, 33))).rejects.toThrow('invalid pipeline')
    ;(await buildGpuSdfAtlas(h.renderer, raster(17, 33))).dispose()
    expect(h.device.createShaderModule).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a WebGPU device', () => {
    expect(() => {
      prepareAtlasPasses({ backend: {} } as unknown as WebGPURenderer)
    }).not.toThrow()
  })
})

describe('encodeGpuSdf', () => {
  it('lets a patch add commands that read the field before the submission', async () => {
    const h = rendererHarness()
    const finish = vi.fn(
      (encoder: { copyTextureToTexture(...args: unknown[]): void }, texture: unknown) => {
        encoder.copyTextureToTexture({ texture, origin: [0, 0] }, {}, [4, 4])
      },
    )
    const device = h.device as unknown as Parameters<typeof encodeGpuSdf>[0]
    const field = await encodeGpuSdf(device, raster(8, 8), 1, finish)
    expect(finish).toHaveBeenCalledWith(expect.anything(), field)
    expect(h.events.indexOf('copy to texture')).toBeGreaterThan(h.events.indexOf('draw'))
    expect(h.events.indexOf('copy to texture')).toBeLessThan(h.events.indexOf('submit'))
  })
})

describe('buildSdfAtlas on a device that cannot run the GPU passes', () => {
  const cpuAtlas = (): SdfAtlas => ({
    texture: {} as SdfAtlas['texture'],
    width: 17,
    height: 33,
    pxRange: 4,
    bakeSize: 32,
    glyphs: new Map(),
    mode: 'cpu',
    dispose: vi.fn(),
  })

  it('falls back to the CPU encoder in auto mode before any GPU work, and rethrows in gpu mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = rendererHarness()
    // A device below even compatibility mode's limits for the workgroup.
    h.device.limits = { ...compatLimits, maxComputeInvocationsPerWorkgroup: 32 }
    const fallback = cpuAtlas()
    buildCpuSdfAtlas.mockResolvedValueOnce(fallback)

    await expect(buildSdfAtlas(h.renderer, raster(17, 33))).resolves.toBe(fallback)
    await expect(buildSdfAtlas(h.renderer, raster(17, 33), { mode: 'gpu' })).rejects.toThrow(
      RangeError,
    )
    expect(h.device.queue.submit).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().some((value) => value instanceof RangeError)).toBe(true)
  })

  it('falls back to the CPU encoder when the device reports an error for the passes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = rendererHarness()
    // What a device reports at submission when a kernel failed to build (Chrome's wording).
    const invalid = { message: '[Invalid ComputePipeline (unlabeled)] is invalid.' }
    h.report.mockImplementation((filter) =>
      Promise.resolve(filter === 'validation' ? invalid : null),
    )
    const fallback = cpuAtlas()
    buildCpuSdfAtlas.mockResolvedValueOnce(fallback)

    await expect(buildSdfAtlas(h.renderer, raster(17, 33))).resolves.toBe(fallback)
    expect(output(h).destroy).toHaveBeenCalledOnce()
    await expect(buildSdfAtlas(h.renderer, raster(17, 33), { mode: 'gpu' })).rejects.toThrow(
      'the device rejected the atlas passes: [Invalid ComputePipeline (unlabeled)] is invalid.',
    )
  })

  it.each(['tainted', 'no encoder'] as const)(
    'falls back to the CPU encoder when the raster cannot reach the passes (%s)',
    async (failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const h = rendererHarness()
      if (failure === 'no encoder') Object.assign(h.device, { createCommandEncoder: undefined })
      else
        h.device.queue.copyExternalImageToTexture.mockImplementation(() => {
          throw new DOMException('The canvas is tainted', 'SecurityError')
        })
      const fallback = cpuAtlas()
      buildCpuSdfAtlas.mockResolvedValueOnce(fallback)
      await expect(buildSdfAtlas(h.renderer, raster(17, 33))).resolves.toBe(fallback)
      await expect(buildSdfAtlas(h.renderer, raster(17, 33), { mode: 'gpu' })).rejects.toThrow()
      expect(h.device.queue.submit).not.toHaveBeenCalled()
    },
  )
})
