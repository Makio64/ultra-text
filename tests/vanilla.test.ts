import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as RasterModule from '../src/atlas/rasterize.js'
import type { RasterizeOptions } from '../src/atlas/rasterize.js'
import type {
  DomLayoutSnapshot,
  DomSdfOptions,
  GlyphLayout,
  GlyphRequest,
  GlyphSlot,
  RasterAtlas,
} from '../src/types.js'

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
}))

vi.mock('../src/dom/snapshot.js', () => ({
  collectDomSnapshot: domMocks.snapshot,
}))

vi.mock('../src/atlas/rasterize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RasterModule>()),
  rasterizeGlyphAtlas: domMocks.rasterize,
}))

import * as vanilla from '../src/vanilla.js'
import {
  buildSdfAtlas,
  buildVanillaCpuSdfAtlas,
  buildVanillaGpuSdfAtlas,
  buildVanillaSdfAtlas,
  computeInstanceBounds,
  DomSdf,
  DomText,
  packDecorationInstances,
  packGlyphInstances,
  packRectInstances,
  Text,
  UNIT_QUAD_INDICES,
  UNIT_QUAD_NORMALS,
  UNIT_QUAD_POSITIONS,
  updateDecorationInstances,
  updateGlyphContentInstances,
  updateGlyphInstances,
  updateRectInstances,
  VanillaDomText,
  VanillaText,
  type VanillaGpuDevice,
  type VanillaGpuTexture,
} from '../src/vanilla.js'

const font = {
  key: 'face',
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
} as const

function makeSlot(key: string, color?: boolean): GlyphSlot {
  return {
    key,
    character: key.split('\u0000')[1] ?? 'A',
    fontKey: 'face',
    u0: 0.125,
    v0: 0.25,
    u1: 0.375,
    v1: 0.75,
    planeX0: -2,
    planeY0: -3,
    planeX1: 12,
    planeY1: 15,
    descent: 3,
    advance: 10,
    ...(color ? { color: true } : {}),
  }
}

function makeRaster(withColor = false): RasterAtlas {
  const width = 16
  const height = 16
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 4; y < 12; y++) {
    for (let x = 4; x < 12; x++) {
      rgba[(y * width + x) * 4 + 3] = 255
    }
  }
  const canvas = {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data: rgba }),
    }),
  } as unknown as HTMLCanvasElement

  const glyphs = new Map<string, GlyphSlot>([
    ['face\u0000A', makeSlot('face\u0000A')],
    ['face\u0000B', makeSlot('face\u0000B', withColor)],
    ['shape\u00000', makeSlot('shape\u00000')],
  ])
  return {
    canvas,
    width,
    height,
    bakeSize: 32,
    pxRange: 4,
    glyphs,
    ...(withColor
      ? {
          colorBand: {
            top: 0,
            height: 8,
            data: new Uint8Array(width * 8 * 4),
          },
        }
      : {}),
  }
}

function makeSnapshot(text = 'AB', width = 200): DomLayoutSnapshot {
  const glyphs = Array.from(text, (ch, idx): GlyphLayout => ({
    glyphKey: `face\u0000${ch}`,
    fontSize: 32,
    originX: idx * 16,
    lineBottom: 24,
    advance: 16,
    block: 0,
    breakBefore: idx === 0 ? 'none' : 'soft',
    clip: [0, 0, width, 60],
    color: [0.1, 0.2, 0.3, 1],
    sequence: idx,
    z: idx === 0 ? -1 : 2,
    decorations: [
      {
        line: 'underline',
        color: [0.1, 0.2, 0.3, 1],
        thickness: 2,
        offset: 3,
      },
    ],
    decorationWidth: 14,
  }))
  const requests: GlyphRequest[] = [...new Set(text)].map((ch) => ({
    key: `face\u0000${ch}`,
    character: ch,
    font,
  }))
  return {
    width,
    height: 60,
    lineCount: 1,
    atlasSignature: `face:${text}`,
    requests,
    glyphs,
    rects: [
      {
        rect: [0, 0, width, 60],
        color: [0.9, 0.9, 0.9, 1],
        radius: 6,
        z: -2,
        receiveShadow: false,
      },
      {
        rect: [4, 4, width - 4, 56],
        color: [1, 1, 1, 1],
        radius: 4,
        z: -1,
        receiveShadow: true,
      },
    ],
    blocks: [
      {
        left: 0,
        firstBaseline: 20,
        linePitch: 24,
        width,
        clip: [0, 0, width, 60],
      },
    ],
  }
}

function makeMockGpuDevice(
  options: {
    rejectScope?: string
    limits?: Partial<NonNullable<VanillaGpuDevice['limits']>>
  } = {},
): {
  device: VanillaGpuDevice
  textures: (VanillaGpuTexture & { destroyed: boolean })[]
  buffers: { destroyed: boolean }[]
} {
  const textures: (VanillaGpuTexture & { destroyed: boolean })[] = []
  const buffers: { destroyed: boolean }[] = []

  const device: VanillaGpuDevice = {
    limits: {
      maxTextureDimension2D: 4096,
      maxStorageBufferBindingSize: 64 * 1024 * 1024,
      maxBufferSize: 64 * 1024 * 1024,
      ...options.limits,
    },
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
      submit: vi.fn(),
    },
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createRenderPipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createSampler: vi.fn(() => ({})),
    createBuffer: vi.fn(() => {
      const buf = {
        destroyed: false,
        destroy() {
          buf.destroyed = true
        },
      }
      buffers.push(buf)
      return buf
    }),
    createTexture: vi.fn((desc: Parameters<VanillaGpuDevice['createTexture']>[0]) => {
      const [w, h] = desc.size
      const tex = {
        width: w,
        height: h,
        depthOrArrayLayers: 1,
        mipLevelCount: desc.mipLevelCount ?? 1,
        sampleCount: 1,
        dimension: '2d',
        format: desc.format,
        usage: desc.usage,
        label: desc.label ?? '',
        destroyed: false,
        createView: vi.fn(() => ({})),
        destroy: vi.fn(() => {
          tex.destroyed = true
        }),
      }
      textures.push(tex)
      return tex
    }),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      copyTextureToBuffer: vi.fn(),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
      beginRenderPass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
    })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() =>
      Promise.resolve(options.rejectScope ? { message: options.rejectScope } : null),
    ),
  }

  return { device, textures, buffers }
}

describe('ultra-text/vanilla module boundary', () => {
  it('has zero runtime imports from three, three/webgpu, or three/tsl', () => {
    const source = readFileSync('src/vanilla.ts', 'utf8')
    expect(source).not.toMatch(/from\s+['"]three(?:\/[^'"]*)?['"]/)
    expect(source).not.toMatch(/import\s*\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)/)
  })

  it('exports the complete engine-agnostic API and aliases', () => {
    expect(DomText).toBe(VanillaDomText)
    expect(DomSdf).toBe(VanillaDomText)
    expect(Text).toBe(VanillaText)
    expect(buildSdfAtlas).toBe(buildVanillaSdfAtlas)
    expect(UNIT_QUAD_POSITIONS).toHaveLength(12)
    expect(UNIT_QUAD_NORMALS).toHaveLength(12)
    expect(UNIT_QUAD_INDICES).toEqual(new Uint16Array([0, 1, 2, 0, 2, 3]))
    expect(typeof vanilla.encodeSdfFromAlpha).toBe('function')
    expect(typeof vanilla.resolveDomTextTone).toBe('function')
    expect(typeof vanilla.svgToWindfoilOutlines).toBe('function')
  })
})

describe('buildVanillaCpuSdfAtlas, buildVanillaGpuSdfAtlas, and buildVanillaSdfAtlas', () => {
  it('builds a CPU SDF atlas without a GPUDevice and uploads when a device is provided', async () => {
    const raster = makeRaster(true)
    const cpuOnly = await buildVanillaCpuSdfAtlas(raster, { cpuWorker: false })
    expect(cpuOnly.mode).toBe('cpu')
    expect(cpuOnly.data).toBeInstanceOf(Uint8Array)
    expect(cpuOnly.data?.byteLength).toBe(raster.width * raster.height)
    expect(cpuOnly.gpuTexture).toBeUndefined()
    expect(cpuOnly.colorLayer?.data).toBeInstanceOf(Uint8Array)
    cpuOnly.dispose()
    cpuOnly.dispose()

    const { device, textures } = makeMockGpuDevice()
    const withDevice = await buildVanillaCpuSdfAtlas(raster, {
      cpuWorker: false,
      device: { device },
      mipmaps: true,
      anisotropy: 4,
    })
    expect(withDevice.mode).toBe('cpu')
    expect(withDevice.gpuTexture).toBeDefined()
    expect(withDevice.colorLayer?.gpuTexture).toBeDefined()
    expect(withDevice.anisotropy).toBe(4)
    withDevice.dispose()
    expect(textures.every((t) => t.destroyed)).toBe(true)
  })

  it('builds a GPU JFA SDF atlas on a raw GPUDevice and cleans up scratch buffers', async () => {
    const raster = makeRaster(true)
    const { device, textures, buffers } = makeMockGpuDevice()
    const atlas = await buildVanillaGpuSdfAtlas(device, raster, {
      mipmaps: true,
      anisotropy: 8,
    })
    expect(atlas.mode).toBe('gpu')
    expect(atlas.gpuTexture).toBeDefined()
    expect(atlas.colorLayer?.gpuTexture).toBeDefined()
    expect(atlas.mipmaps).toBe(true)
    expect(atlas.anisotropy).toBe(8)
    expect(buffers.every((b) => b.destroyed)).toBe(true)

    atlas.dispose()
    atlas.dispose()
    expect(textures.every((t) => t.destroyed)).toBe(true)
  })

  it('rejects oversized GPU atlases and device error scope failures, and falls back in auto mode', async () => {
    const raster = makeRaster(false)
    const smallDevice = makeMockGpuDevice({ limits: { maxTextureDimension2D: 8 } }).device
    await expect(buildVanillaGpuSdfAtlas(smallDevice, raster)).rejects.toThrow(
      /maxTextureDimension2D/,
    )

    const rejecting = makeMockGpuDevice({ rejectScope: 'validation failed' })
    await expect(buildVanillaGpuSdfAtlas(rejecting.device, raster)).rejects.toThrow(
      /validation failed/,
    )
    expect(rejecting.textures.every((t) => t.destroyed)).toBe(true)

    const fallback = await buildVanillaSdfAtlas(rejecting.device, raster, {
      mode: 'auto',
      cpuWorker: false,
    })
    expect(fallback.mode).toBe('cpu')
    fallback.dispose()

    await expect(buildVanillaSdfAtlas(null, raster, { mode: 'gpu' })).rejects.toThrow(
      /requires a WebGPU GPUDevice/,
    )
  })
})

describe('typed-array instance buffer packing and in-place updates', () => {
  it('packs and updates glyph, rect, and decoration buffers in place', async () => {
    const raster = makeRaster(true)
    const atlas = await buildVanillaCpuSdfAtlas(raster, { cpuWorker: false })
    const snap = makeSnapshot('AB', 200)

    const glyphs = packGlyphInstances(snap, atlas, 10)
    expect(glyphs.count).toBe(2)
    expect(glyphs.maxSequence).toBe(1)
    expect(glyphs.bounds.max).toEqual([210, 70, 12])

    const widerSnap = makeSnapshot('AB', 260)
    expect(updateGlyphInstances(glyphs, widerSnap, atlas, 12)).toBe(1)
    expect(glyphs.bounds.max[0]).toBe(272)

    expect(updateGlyphContentInstances(glyphs, snap, atlas, 8)).toBe(1)
    const longerSnap = makeSnapshot('ABA', 200)
    expect(updateGlyphInstances(glyphs, longerSnap, atlas, 8)).toBeNull()
    expect(updateGlyphContentInstances(glyphs, longerSnap, atlas, 8)).toBeNull()

    const plainRects = packRectInstances(snap, false)
    const litRects = packRectInstances(snap, true)
    expect(plainRects?.count).toBe(1)
    expect(litRects?.count).toBe(1)
    expect(plainRects && updateRectInstances(plainRects, widerSnap, false)).toBe(true)

    const drawable = (key: string) => atlas.glyphs.has(key)
    const decorations = packDecorationInstances(snap, glyphs.rects, drawable, 10)
    expect(decorations?.count).toBe(2)
    expect(
      decorations && updateDecorationInstances(decorations, widerSnap, glyphs.rects, drawable, 10),
    ).toBe(true)

    expect(computeInstanceBounds(100, 50, 5, -2, 3)).toEqual({
      min: [-5, -5, -7],
      max: [105, 55, 8],
      center: [50, 25, 0.5],
      radius: Math.hypot(55, 30, 7.5),
    })

    atlas.dispose()
  })
})

describe('VanillaDomText and VanillaText lifecycle', () => {
  let element: HTMLElement

  beforeEach(() => {
    element = document.createElement('div')
    document.body.appendChild(element)
    domMocks.snapshot.mockReset()
    domMocks.rasterize.mockReset()
    domMocks.snapshot.mockImplementation((_el, opts) =>
      makeSnapshot('AB', 200 + (opts?.padding ?? 0)),
    )
    domMocks.rasterize.mockImplementation(() => Promise.resolve(makeRaster(true)))
  })

  afterEach(() => {
    element.remove()
  })

  it('creates, observes, reflows, updates motion, reuses atlases, and disposes idempotently', async () => {
    const { device } = makeMockGpuDevice()
    const events: string[] = []
    const domText = await VanillaDomText.create(
      element,
      { device },
      {
        selectable: true,
        reflowable: true,
        quality: 'high',
        onChange: (_inst, reason) => events.push(reason),
      },
    )

    expect(element.classList.contains('sdf-selectable')).toBe(true)
    expect(domText.width).toBe(200)
    expect(domText.height).toBe(60)
    expect(domText.stats.glyphs).toBe(2)
    expect(domText.stats.colorGlyphs).toBe(1)
    expect(domText.stats.atlasMode).toBe('gpu')
    expect(events).toEqual(['create'])

    domText.setMotion({ strength: 24, speed: 2 })
    expect(domText.motion.strength).toBe(24)
    expect(domText.glyphs.bounds.max[0]).toBe(224)
    expect(events.at(-1)).toBe('motion')

    domText.reflow(160)
    expect(events.at(-1)).toBe('reflow')

    // Rebuild with identical snapshot reuses layout signature and private atlas
    await domText.rebuild()
    expect(domText.stats.atlasBuildMs).toBe(0)
    expect(events.at(-1)).toBe('rebuild')

    domText.dispose()
    domText.dispose()
    expect(domText.isDisposed).toBe(true)
    expect(element.classList.contains('sdf-selectable')).toBe(false)
    expect(events.at(-1)).toBe('dispose')
  })

  it('manages an owned hidden DOM element in VanillaText', async () => {
    const text = await VanillaText.create('Hello Vanilla', {
      css: { fontSize: 28, lineHeight: 1.4, '--accent': '#ff0080' },
      cssClass: { headline: true, active: true, hidden: false },
      cpuWorker: false,
    })

    expect(text.text).toBe('Hello Vanilla')
    expect(text.element.isConnected).toBe(true)
    expect(text.element.style.fontSize).toBe('28px')
    expect(text.element.style.lineHeight).toBe('1.4')
    expect(text.element.classList.contains('headline')).toBe(true)
    expect(text.element.classList.contains('active')).toBe(true)
    expect(text.element.classList.contains('hidden')).toBe(false)

    await text.setText('Updated')
    expect(text.text).toBe('Updated')
    await text.setCss('font-size: 20px')
    expect(text.element.style.fontSize).toBe('20px')
    await text.setClass('next-class')
    expect(text.element.classList.contains('next-class')).toBe(true)
    expect(text.element.classList.contains('headline')).toBe(false)

    text.dispose()
    expect(text.element.isConnected).toBe(false)
  })
})
