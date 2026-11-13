import { alphaOfRgba, encodeSdfFromAlpha } from './atlas/cpuSdf.js'
import { JFA_WGSL, MIP_WGSL } from './atlas/jfaWgsl.js'
import {
  isColorCandidate,
  rasterizeGlyphAtlas,
  type RasterizeOptions,
  type ShapeRows,
} from './atlas/rasterize.js'
import { layoutSignatureOf } from './dom/layoutSignature.js'
import { collectDomSnapshot } from './dom/snapshot.js'
import {
  backdropCurve,
  resolveDomTextTone,
  resolveTextTone,
  srgbEncode,
  toneCoverage,
  toneLightness,
  type ResolvedTextTone,
  type TextToneCapture,
  type TextToneContext,
} from './dom/tone.js'
import { reflowSnapshot, snapGlyph } from './text/reflow.js'
import type {
  BuildSdfAtlasOptions,
  ColorGlyphMode,
  DomLayoutSnapshot,
  DomSdfOptions,
  DomSdfStats,
  DomSvgOptions,
  DomTextBackend,
  DomTextLayoutEngine,
  DomTextStats,
  FontStyleSnapshot,
  GlyphBreak,
  GlyphLayout,
  GlyphRequest,
  GlyphShape,
  GlyphShapePath,
  GlyphShapeStroke,
  GlyphSlot,
  RasterAtlas,
  RasterColorBand,
  RectLayout,
  SdfAnimationMode,
  SdfAtlasMode,
  SdfDropShadowOptions,
  SdfMotionOptions,
  SdfOutlineOptions,
  SdfTextQuality,
  SvgEmojiOutlineProviderOptions,
  SvgToWindfoilOptions,
  TextBlockLayout,
  TextClass,
  TextCss,
  TextDecorationLayout,
  TextToneModel,
  TextToneOptions,
  WindfoilAffine,
  WindfoilBoundingBox,
  WindfoilColorStop,
  WindfoilEmBox,
  WindfoilExtendMode,
  WindfoilForegroundPaint,
  WindfoilGlyphOutline,
  WindfoilGradientBase,
  WindfoilGradientPaint,
  WindfoilLinearGradientPaint,
  WindfoilOptions,
  WindfoilOutlineLayer,
  WindfoilOutlineProvider,
  WindfoilPaint,
  WindfoilQuadratic,
  WindfoilRadialGradientPaint,
  WindfoilShapeInstance,
  WindfoilShapePathLike,
  WindfoilShapesStats,
  WindfoilSolidPaint,
  WindfoilSvgLayer,
  WindfoilSvgPaint,
  WindfoilSvgPath,
  WindfoilSvgResult,
  WindfoilSvgSource,
  WindfoilSvgWarning,
  WindfoilSvgWarningCode,
  WindfoilSweepGradientPaint,
} from './types.js'
import { svgToWindfoilOutlines } from './windfoil/svg/convert.js'
import { windfoilOutlineFromSvgPaths } from './windfoil/svg/pathConverter.js'

export {
  alphaOfRgba,
  backdropCurve,
  collectDomSnapshot,
  encodeSdfFromAlpha,
  isColorCandidate,
  layoutSignatureOf,
  rasterizeGlyphAtlas,
  reflowSnapshot,
  resolveDomTextTone,
  resolveTextTone,
  snapGlyph,
  srgbEncode,
  svgToWindfoilOutlines,
  toneCoverage,
  toneLightness,
  windfoilOutlineFromSvgPaths,
}

export type {
  BuildSdfAtlasOptions,
  ColorGlyphMode,
  DomLayoutSnapshot,
  DomSdfStats,
  DomSvgOptions,
  DomTextBackend,
  DomTextLayoutEngine,
  DomTextStats,
  FontStyleSnapshot,
  GlyphBreak,
  GlyphLayout,
  GlyphRequest,
  GlyphShape,
  GlyphShapePath,
  GlyphShapeStroke,
  GlyphSlot,
  RasterAtlas,
  RasterColorBand,
  RasterizeOptions,
  RectLayout,
  ResolvedTextTone,
  SdfAnimationMode,
  SdfAtlasMode,
  SdfDropShadowOptions,
  SdfMotionOptions,
  SdfOutlineOptions,
  SdfTextQuality,
  SvgEmojiOutlineProviderOptions,
  SvgToWindfoilOptions,
  TextBlockLayout,
  TextClass,
  TextCss,
  TextDecorationLayout,
  TextToneCapture,
  TextToneContext,
  TextToneModel,
  TextToneOptions,
  WindfoilAffine,
  WindfoilBoundingBox,
  WindfoilColorStop,
  WindfoilEmBox,
  WindfoilExtendMode,
  WindfoilForegroundPaint,
  WindfoilGlyphOutline,
  WindfoilGradientBase,
  WindfoilGradientPaint,
  WindfoilLinearGradientPaint,
  WindfoilOptions,
  WindfoilOutlineLayer,
  WindfoilOutlineProvider,
  WindfoilPaint,
  WindfoilQuadratic,
  WindfoilRadialGradientPaint,
  WindfoilShapeInstance,
  WindfoilShapePathLike,
  WindfoilShapesStats,
  WindfoilSolidPaint,
  WindfoilSvgLayer,
  WindfoilSvgPaint,
  WindfoilSvgPath,
  WindfoilSvgResult,
  WindfoilSvgSource,
  WindfoilSvgWarning,
  WindfoilSvgWarningCode,
  WindfoilSweepGradientPaint,
}

/** Structural WebGPU texture handle returned by GPU atlas builds. */
export interface VanillaGpuTexture {
  readonly label?: string
  readonly width?: number
  readonly height?: number
  readonly format?: string
  readonly mipLevelCount?: number
  createView(descriptor?: { baseMipLevel?: number; mipLevelCount?: number }): unknown
  destroy(): void
}

/** Structural WebGPU device interface so callers need neither Three.js nor `@webgpu/types`. */
export interface VanillaGpuDevice {
  readonly limits?: {
    readonly maxStorageBufferBindingSize: number
    readonly maxBufferSize: number
    readonly maxComputeInvocationsPerWorkgroup?: number
    readonly maxComputeWorkgroupSizeX?: number
    readonly maxComputeWorkgroupSizeY?: number
    readonly maxStorageBuffersPerShaderStage?: number
    readonly maxStorageBuffersInFragmentStage?: number
    readonly maxTextureDimension2D?: number
  }
  createTexture(descriptor: {
    label?: string
    size: readonly [number, number] | [number, number]
    mipLevelCount?: number
    format: string
    usage: number
  }): VanillaGpuTexture
  createBuffer(descriptor: {
    label?: string
    size: number
    usage: number
    mappedAtCreation?: boolean
  }): { destroy(): void }
  createSampler(descriptor?: {
    label?: string
    minFilter?: 'nearest' | 'linear'
    magFilter?: 'nearest' | 'linear'
  }): unknown
  createShaderModule(descriptor: { label?: string; code: string }): unknown
  createComputePipeline(descriptor: {
    label?: string
    layout: 'auto'
    compute: { module: unknown; entryPoint: string }
  }): { getBindGroupLayout(index: number): unknown }
  createRenderPipeline(descriptor: {
    label?: string
    layout: 'auto'
    vertex: { module: unknown; entryPoint: string }
    fragment: { module: unknown; entryPoint: string; targets: readonly { format: string }[] }
    primitive?: { topology?: string }
  }): { getBindGroupLayout(index: number): unknown }
  createBindGroup(descriptor: {
    layout: unknown
    entries: readonly { binding: number; resource: unknown }[]
  }): unknown
  createCommandEncoder(descriptor?: { label?: string }): {
    copyTextureToBuffer(
      source: { texture: VanillaGpuTexture },
      destination: { buffer: { destroy(): void }; bytesPerRow: number; rowsPerImage: number },
      size: readonly [number, number] | [number, number],
    ): void
    beginComputePass(descriptor?: { label?: string }): {
      setPipeline(pipeline: unknown): void
      setBindGroup(index: number, bindGroup: unknown): void
      dispatchWorkgroups(x: number, y?: number, z?: number): void
      end(): void
    }
    beginRenderPass(descriptor: {
      label?: string
      colorAttachments: readonly {
        view: unknown
        loadOp: 'clear' | 'load'
        storeOp: 'store' | 'discard'
        clearValue?: { r: number; g: number; b: number; a: number }
      }[]
    }): {
      setPipeline(pipeline: unknown): void
      setBindGroup(index: number, bindGroup: unknown): void
      draw(vertexCount: number): void
      end(): void
    }
    finish(): unknown
  }
  readonly queue: {
    copyExternalImageToTexture(
      source: { source: HTMLCanvasElement; flipY?: boolean },
      destination: { texture: VanillaGpuTexture; premultipliedAlpha?: boolean },
      size: readonly [number, number] | [number, number],
    ): void
    writeBuffer(
      buffer: { destroy(): void },
      bufferOffset: number,
      data: ArrayBufferView,
      dataOffset?: number,
      size?: number,
    ): void
    writeTexture(
      destination: { texture: VanillaGpuTexture; mipLevel?: number },
      data: ArrayBufferView,
      dataLayout: { offset?: number; bytesPerRow: number; rowsPerImage?: number },
      size: readonly [number, number] | [number, number],
    ): void
    submit(commandBuffers: readonly unknown[]): void
  }
  pushErrorScope?(filter: 'validation' | 'out-of-memory' | 'internal'): void
  popErrorScope?(): Promise<{ readonly message?: string } | null>
}

/** A WebGPU `GPUDevice`, an engine renderer holding `{ device }`, or `null`/`undefined` for CPU mode. */
export type VanillaGpuDeviceSource =
  VanillaGpuDevice | { readonly device?: VanillaGpuDevice | null | undefined } | null | undefined

/** Companion colour layer owned and disposed by its `VanillaSdfAtlas`. */
export interface VanillaSdfColorLayer {
  readonly data: Uint8Array
  readonly gpuTexture?: VanillaGpuTexture | undefined
  readonly width: number
  readonly top: number
  readonly height: number
}

/** Engine-agnostic SDF atlas with CPU bytes and/or an adopted WebGPU `GPUTexture`. */
export interface VanillaSdfAtlas {
  /** Single-channel SDF bytes (`width * height`), present when built on CPU. */
  readonly data?: Uint8Array | undefined
  /** WebGPU `r8unorm` texture (`TEXTURE_BINDING | COPY_SRC`), present when built on GPU. */
  readonly gpuTexture?: VanillaGpuTexture | undefined
  readonly colorLayer?: VanillaSdfColorLayer | undefined
  readonly shapeTop?: number | undefined
  readonly width: number
  readonly height: number
  readonly pxRange: number
  readonly bakeSize: number
  readonly glyphs: ReadonlyMap<string, GlyphSlot>
  readonly mode: Exclude<SdfAtlasMode, 'auto'>
  /** Requested mipmap flag. */
  readonly mipmaps: boolean
  /** Requested anisotropy level. */
  readonly anisotropy: number
  dispose(): void
}

function resolveGpuDevice(source: VanillaGpuDeviceSource): VanillaGpuDevice | null {
  if (!source || typeof source !== 'object') return null
  if ('createTexture' in source && typeof source.createTexture === 'function') return source
  if ('device' in source && source.device && typeof source.device.createTexture === 'function') {
    return source.device
  }
  return null
}

function rasterRowBytes(width: number): number {
  return Math.ceil(width / 64) * 256
}

function jfaSteps(pxRange: number): number[] {
  const radius = Math.ceil(pxRange / 2) + 1
  let step = 1
  while (2 * step - 1 < radius) step *= 2
  const steps: number[] = []
  while (step >= 1) {
    steps.push(step)
    step = Math.floor(step / 2)
  }
  return steps
}

const COMPUTE_WORKGROUP_DIMENSION = 8
const ERROR_FILTERS = ['validation', 'out-of-memory', 'internal'] as const

function checkVanillaAtlasLimits(
  limits: NonNullable<VanillaGpuDevice['limits']>,
  width: number,
  height: number,
): void {
  for (const [name, need] of [
    ['maxComputeInvocationsPerWorkgroup', COMPUTE_WORKGROUP_DIMENSION ** 2],
    ['maxComputeWorkgroupSizeX', COMPUTE_WORKGROUP_DIMENSION],
    ['maxComputeWorkgroupSizeY', COMPUTE_WORKGROUP_DIMENSION],
    ['maxStorageBuffersPerShaderStage', 2],
    ['maxStorageBuffersInFragmentStage', 1],
  ] as const) {
    const value = limits[name]
    if (typeof value === 'number' && value < need) {
      throw new RangeError(`buildVanillaGpuSdfAtlas: ${name}=${value}, needs ${need}`)
    }
  }
  const largest = limits.maxTextureDimension2D
  if (typeof largest === 'number' && Math.max(width, height) > largest) {
    throw new RangeError(
      `buildVanillaGpuSdfAtlas: ${width}×${height} exceeds maxTextureDimension2D=${largest}`,
    )
  }
  const bytes = Math.max(width * height * 8, rasterRowBytes(width) * height)
  if (bytes > limits.maxStorageBufferBindingSize || bytes > limits.maxBufferSize) {
    throw new RangeError(
      `buildVanillaGpuSdfAtlas: ${width}×${height} exceeds storage-buffer limits`,
    )
  }
}

function openVanillaErrorScopes(device: VanillaGpuDevice): { close(): Promise<string | null> } {
  if (typeof device.pushErrorScope !== 'function' || typeof device.popErrorScope !== 'function') {
    return { close: () => Promise.resolve(null) }
  }
  const scoped = device as Required<Pick<VanillaGpuDevice, 'pushErrorScope' | 'popErrorScope'>>
  for (const filter of ERROR_FILTERS) scoped.pushErrorScope(filter)
  return {
    close() {
      return Promise.all(ERROR_FILTERS.map(() => scoped.popErrorScope())).then(
        (errors) => {
          const error = errors.find(Boolean)
          return error ? (error.message ?? 'unknown GPU error') : null
        },
        (error: unknown) => String(error),
      )
    },
  }
}

type CachedDevicePipelines = readonly [
  ReturnType<VanillaGpuDevice['createComputePipeline']>,
  ReturnType<VanillaGpuDevice['createComputePipeline']>,
  ReturnType<VanillaGpuDevice['createRenderPipeline']>,
  ReturnType<VanillaGpuDevice['createRenderPipeline']>,
  ReturnType<VanillaGpuDevice['createRenderPipeline']>,
  unknown,
]

const devicePipelines = new WeakMap<VanillaGpuDevice, CachedDevicePipelines>()

function getDevicePipelines(device: VanillaGpuDevice): CachedDevicePipelines {
  let cached = devicePipelines.get(device)
  if (cached) return cached
  const module = device.createShaderModule({ code: JFA_WGSL + MIP_WGSL })
  const compute = (entryPoint: string) =>
    device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } })
  const render = (vertex: string, fragment: string, format: string) =>
    device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: vertex },
      fragment: { module, entryPoint: fragment, targets: [{ format }] },
    })
  cached = [
    compute('seedMain'),
    compute('jumpMain'),
    render('fullscreenVert', 'resolveFrag', 'r8unorm'),
    render('mipVert', 'mipFrag', 'r8unorm'),
    render('mipVert', 'mipFrag', 'rgba8unorm-srgb'),
    device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
  ]
  devicePipelines.set(device, cached)
  return cached
}

function encodeMipmapChain(
  device: VanillaGpuDevice,
  encoder: ReturnType<VanillaGpuDevice['createCommandEncoder']>,
  texture: VanillaGpuTexture,
  mipLevelCount: number,
  pipeline: ReturnType<VanillaGpuDevice['createRenderPipeline']>,
  sampler: unknown,
): void {
  const view = (baseMipLevel: number) => texture.createView({ baseMipLevel, mipLevelCount: 1 })
  for (let level = 1; level < mipLevelCount; level++) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: view(level), loadOp: 'clear', storeOp: 'store' }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view(level - 1) },
          { binding: 1, resource: sampler },
        ],
      }),
    )
    pass.draw(3)
    pass.end()
  }
}

const DEFAULT_BUF_USAGE = { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }
const DEFAULT_TEX_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 }
interface UsageGlobals {
  GPUBufferUsage?: typeof DEFAULT_BUF_USAGE
  GPUTextureUsage?: typeof DEFAULT_TEX_USAGE
}
const texUsageOf = () => (globalThis as UsageGlobals).GPUTextureUsage ?? DEFAULT_TEX_USAGE
const bufUsageOf = () => (globalThis as UsageGlobals).GPUBufferUsage ?? DEFAULT_BUF_USAGE
const mipCount = (w: number, h: number, mipmaps: boolean): number =>
  mipmaps ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1

function createGpuColorLayer(
  device: VanillaGpuDevice,
  width: number,
  band: RasterColorBand,
  mipmaps: boolean,
): VanillaSdfColorLayer {
  const textures = texUsageOf()
  const mipLevelCount = mipCount(width, band.height, mipmaps)
  const gpuTexture = device.createTexture({
    size: [width, band.height],
    mipLevelCount,
    format: 'rgba8unorm-srgb',
    usage:
      textures.TEXTURE_BINDING |
      textures.COPY_DST |
      textures.COPY_SRC |
      (mipLevelCount > 1 ? textures.RENDER_ATTACHMENT : 0),
  })
  device.queue.writeTexture(
    { texture: gpuTexture, mipLevel: 0 },
    band.data,
    { offset: 0, bytesPerRow: width * 4, rowsPerImage: band.height },
    [width, band.height],
  )
  if (mipLevelCount > 1) {
    const pipelines = getDevicePipelines(device)
    const encoder = device.createCommandEncoder()
    encodeMipmapChain(device, encoder, gpuTexture, mipLevelCount, pipelines[4], pipelines[5])
    device.queue.submit([encoder.finish()])
  }
  return {
    data: band.data,
    gpuTexture,
    width,
    top: band.top,
    height: band.height,
  }
}

export async function buildVanillaGpuSdfAtlas(
  device: VanillaGpuDevice,
  raster: RasterAtlas,
  options: Omit<BuildSdfAtlasOptions, 'mode'> = {},
): Promise<VanillaSdfAtlas> {
  options.signal?.throwIfAborted()
  const { width, height } = raster
  if (device.limits) checkVanillaAtlasLimits(device.limits, width, height)

  const bufUsage = bufUsageOf()
  const texUsage = texUsageOf()
  const scopes = openVanillaErrorScopes(device)
  const bytesPerRow = rasterRowBytes(width)
  const steps = jfaSteps(raster.pxRange)
  const mipmaps = options.mipmaps === true
  const mipLevelCount = mipCount(width, height, mipmaps)

  let rasterTexture: VanillaGpuTexture | undefined
  let outputTexture: VanillaGpuTexture | undefined
  let retainOutput = false
  const transient: { destroy(): void }[] = []
  const makeBuf = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage })
    transient.push(b)
    return b
  }

  try {
    const pipelines = getDevicePipelines(device)
    rasterTexture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: texUsage.COPY_SRC | texUsage.COPY_DST | texUsage.RENDER_ATTACHMENT,
    })
    const rasterBuffer = makeBuf(bytesPerRow * height, bufUsage.STORAGE | bufUsage.COPY_DST)
    const seedBytes = width * height * 8
    const seedA = makeBuf(seedBytes, bufUsage.STORAGE)
    const seedB = makeBuf(seedBytes, bufUsage.STORAGE)
    const paramsByteLength = steps.length * 256 + 16
    const paramsBuffer = makeBuf(paramsByteLength, bufUsage.UNIFORM | bufUsage.COPY_DST)
    const paramsInts = new Int32Array(steps.length * 64 + 4)
    paramsInts.set([width, height, bytesPerRow / 4])
    new Float32Array(paramsInts.buffer, 12, 1)[0] = 1 / raster.pxRange
    steps.forEach((step, i) => paramsInts.set([width, height, step], (i + 1) * 64))
    device.queue.writeBuffer(paramsBuffer, 0, paramsInts)

    device.queue.copyExternalImageToTexture(
      { source: raster.canvas, flipY: false },
      { texture: rasterTexture, premultipliedAlpha: false },
      [width, height],
    )

    outputTexture = device.createTexture({
      size: [width, height],
      mipLevelCount,
      format: 'r8unorm',
      usage: texUsage.RENDER_ATTACHMENT | texUsage.TEXTURE_BINDING | texUsage.COPY_SRC,
    })

    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture: rasterTexture },
      { buffer: rasterBuffer, bytesPerRow, rowsPerImage: height },
      [width, height],
    )

    const groupsX = Math.ceil(width / COMPUTE_WORKGROUP_DIMENSION)
    const groupsY = Math.ceil(height / COMPUTE_WORKGROUP_DIMENSION)
    const bind = (
      pipeline: { getBindGroupLayout(index: number): unknown },
      offset: number,
      ...bufs: { destroy(): void }[]
    ) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer, offset, size: 16 } },
          ...bufs.map((buffer, idx) => ({ binding: idx + 1, resource: { buffer } })),
        ],
      })

    const computePass = encoder.beginComputePass()
    computePass.setPipeline(pipelines[0])
    computePass.setBindGroup(0, bind(pipelines[0], 0, rasterBuffer, seedA))
    computePass.dispatchWorkgroups(groupsX, groupsY)

    let currentIn = seedA
    let currentOut = seedB
    computePass.setPipeline(pipelines[1])
    for (let i = 0; i < steps.length; i++) {
      computePass.setBindGroup(0, bind(pipelines[1], (i + 1) * 256, currentIn, currentOut))
      computePass.dispatchWorkgroups(groupsX, groupsY)
      const prev = currentIn
      currentIn = currentOut
      currentOut = prev
    }
    computePass.end()

    const resolvePass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: outputTexture.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    resolvePass.setPipeline(pipelines[2])
    resolvePass.setBindGroup(0, bind(pipelines[2], 0, currentIn))
    resolvePass.draw(3)
    resolvePass.end()

    if (mipLevelCount > 1) {
      encodeMipmapChain(device, encoder, outputTexture, mipLevelCount, pipelines[3], pipelines[5])
    }

    device.queue.submit([encoder.finish()])
  } catch (error) {
    void scopes.close()
    for (const b of transient) b.destroy()
    outputTexture?.destroy()
    throw error
  } finally {
    rasterTexture?.destroy()
  }

  const rejection = await scopes.close()
  for (const b of transient) b.destroy()

  if (rejection !== null) {
    outputTexture.destroy()
    throw new Error(`buildVanillaGpuSdfAtlas: the device rejected the atlas passes: ${rejection}`)
  }

  try {
    options.signal?.throwIfAborted()
    const colorLayer = raster.colorBand
      ? createGpuColorLayer(device, width, raster.colorBand, mipmaps)
      : undefined
    retainOutput = true
    const retainedTexture = outputTexture
    let disposed = false
    const { shapeTop } = raster as RasterAtlas & ShapeRows
    return {
      ...(shapeTop === undefined ? {} : { shapeTop }),
      ...(colorLayer ? { colorLayer } : {}),
      gpuTexture: retainedTexture,
      width,
      height,
      pxRange: raster.pxRange,
      bakeSize: raster.bakeSize,
      glyphs: raster.glyphs,
      mode: 'gpu',
      mipmaps,
      anisotropy: mipmaps ? Math.max(1, options.anisotropy ?? 1) : 1,
      dispose(): void {
        if (disposed) return
        disposed = true
        colorLayer?.gpuTexture?.destroy()
        retainedTexture.destroy()
      },
    }
  } finally {
    if (!retainOutput) outputTexture.destroy()
  }
}

function readRasterPixels(raster: RasterAtlas): Uint8ClampedArray {
  const context = raster.canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('buildVanillaCpuSdfAtlas: Canvas 2D is unavailable')
  return context.getImageData(0, 0, raster.width, raster.height).data
}

export async function buildVanillaCpuSdfAtlas(
  raster: RasterAtlas,
  options: Omit<BuildSdfAtlasOptions, 'mode'> & { device?: VanillaGpuDeviceSource } = {},
): Promise<VanillaSdfAtlas> {
  options.signal?.throwIfAborted()
  let rgba = readRasterPixels(raster)
  let sdf: Uint8Array | undefined
  if (options.cpuWorker !== false && typeof Worker !== 'undefined') {
    try {
      const { encodeInWorker } = await import('./atlas/cpuWorker.js')
      sdf = await encodeInWorker(rgba, raster.width, raster.height, raster.pxRange, options.signal)
    } catch {
      options.signal?.throwIfAborted()
      if (rgba.byteLength === 0) rgba = readRasterPixels(raster)
    }
  }
  options.signal?.throwIfAborted()
  sdf ??= encodeSdfFromAlpha(
    alphaOfRgba(rgba, raster.width * raster.height),
    raster.width,
    raster.height,
    raster.pxRange,
  )

  const device = resolveGpuDevice(options.device)
  const mipmaps = options.mipmaps === true
  let gpuTexture: VanillaGpuTexture | undefined
  let colorLayer: VanillaSdfColorLayer | undefined

  if (device) {
    const texUsage = texUsageOf()
    const mipLevelCount = mipCount(raster.width, raster.height, mipmaps)
    gpuTexture = device.createTexture({
      size: [raster.width, raster.height],
      mipLevelCount,
      format: 'r8unorm',
      usage:
        texUsage.TEXTURE_BINDING |
        texUsage.COPY_DST |
        texUsage.COPY_SRC |
        (mipLevelCount > 1 ? texUsage.RENDER_ATTACHMENT : 0),
    })
    device.queue.writeTexture(
      { texture: gpuTexture, mipLevel: 0 },
      sdf,
      { offset: 0, bytesPerRow: raster.width, rowsPerImage: raster.height },
      [raster.width, raster.height],
    )
    if (mipLevelCount > 1) {
      const pipelines = getDevicePipelines(device)
      const encoder = device.createCommandEncoder()
      encodeMipmapChain(device, encoder, gpuTexture, mipLevelCount, pipelines[3], pipelines[5])
      device.queue.submit([encoder.finish()])
    }
    if (raster.colorBand) {
      colorLayer = createGpuColorLayer(device, raster.width, raster.colorBand, mipmaps)
    }
  } else if (raster.colorBand) {
    colorLayer = {
      data: raster.colorBand.data,
      width: raster.width,
      top: raster.colorBand.top,
      height: raster.colorBand.height,
    }
  }

  let disposed = false
  const { shapeTop } = raster as RasterAtlas & ShapeRows
  return {
    ...(shapeTop === undefined ? {} : { shapeTop }),
    ...(colorLayer ? { colorLayer } : {}),
    ...(gpuTexture ? { gpuTexture } : {}),
    data: sdf,
    width: raster.width,
    height: raster.height,
    pxRange: raster.pxRange,
    bakeSize: raster.bakeSize,
    glyphs: raster.glyphs,
    mode: 'cpu',
    mipmaps,
    anisotropy: mipmaps ? Math.max(1, options.anisotropy ?? 1) : 1,
    dispose(): void {
      if (disposed) return
      disposed = true
      colorLayer?.gpuTexture?.destroy()
      gpuTexture?.destroy()
    },
  }
}

let warnedVanillaGpuFallback = false

/**
 * Engine-agnostic SDF atlas builder. Accepts a `GPUDevice`, an object holding `{ device }`
 * (such as a Mini3 `Renderer`), or `null`/`undefined` for CPU generation.
 * In `'auto'` mode (default), tries the WebGPU JFA path when a device is provided and falls
 * back to the exact CPU EDT encoder if the device is absent or rejects the passes.
 */
export async function buildVanillaSdfAtlas(
  deviceOrRenderer: VanillaGpuDeviceSource,
  raster: RasterAtlas,
  options: BuildSdfAtlasOptions = {},
): Promise<VanillaSdfAtlas> {
  options.signal?.throwIfAborted()
  const mode = options.mode ?? 'auto'
  const device = resolveGpuDevice(deviceOrRenderer)

  if (mode === 'cpu') {
    return buildVanillaCpuSdfAtlas(raster, { ...options, device })
  }
  if (!device) {
    if (mode === 'gpu') {
      throw new Error(
        'buildVanillaSdfAtlas: mode "gpu" requires a WebGPU GPUDevice; use mode "auto" or "cpu" without a device',
      )
    }
    return buildVanillaCpuSdfAtlas(raster, options)
  }

  if (mode === 'gpu') {
    return buildVanillaGpuSdfAtlas(device, raster, options)
  }

  try {
    return await buildVanillaGpuSdfAtlas(device, raster, options)
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!warnedVanillaGpuFallback) {
      warnedVanillaGpuFallback = true
      console.warn(
        '[ultra-text] WebGPU JFA atlas generation failed; falling back to the CPU EDT generator.',
        error,
      )
    }
    return buildVanillaCpuSdfAtlas(raster, { ...options, device })
  }
}

export { buildVanillaSdfAtlas as buildSdfAtlas }

// ============================================================================
// Pure Typed-Array Instance Buffer Packers & In-Place Updaters
// ============================================================================

/** Unit quad vertex positions (`[0,0,0, 1,0,0, 1,1,0, 0,1,0]`, 4 vertices × 3 floats). */
export const UNIT_QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])

/** Unit quad vertex normals (`[0,0,1, ...]`, 4 vertices × 3 floats). */
export const UNIT_QUAD_NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])

/** Unit quad triangle indices (`[0, 1, 2, 0, 2, 3]`, 6 uint16 indices). */
export const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])

/** Engine-agnostic 3D axis-aligned bounding box and bounding sphere. */
export interface VanillaBounds {
  readonly min: readonly [x: number, y: number, z: number]
  readonly max: readonly [x: number, y: number, z: number]
  readonly center: readonly [x: number, y: number, z: number]
  readonly radius: number
}

/** Computes a bounding box and sphere in local capture coordinates. */
export function computeInstanceBounds(
  width: number,
  height: number,
  padding = 0,
  minZ = 0,
  maxZ = 0,
): VanillaBounds {
  const minX = -padding
  const minY = -padding
  const minBoundZ = minZ - padding
  const maxX = width + padding
  const maxY = height + padding
  const maxBoundZ = maxZ + padding
  const cx = (minX + maxX) * 0.5
  const cy = (minY + maxY) * 0.5
  const cz = (minBoundZ + maxBoundZ) * 0.5
  const dx = maxX - cx
  const dy = maxY - cy
  const dz = maxBoundZ - cz
  return {
    min: [minX, minY, minBoundZ],
    max: [maxX, maxY, maxBoundZ],
    center: [cx, cy, cz],
    radius: Math.sqrt(dx * dx + dy * dy + dz * dz),
  }
}

/** Packed typed-array instance attributes for SDF glyphs. */
export interface VanillaGlyphInstances {
  count: number
  maxSequence: number
  /** `[x0, y0, x1, y1]` per glyph in local capture units (`count * 4`). */
  rects: Float32Array
  /** Normalized `unorm16` `[u0, v1, u1, v0]` per glyph (`count * 4`). */
  uvRects: Uint16Array
  /** Normalized `unorm16` support trim `[u0, v1, u1, v0]` per glyph (`count * 4`), or `null` with `runMotion`. */
  trims: Uint16Array | null
  /** `[x0, y0, x1, y1]` clip box per glyph (`count * 4`). */
  clips: Float32Array
  /** Normalized `unorm8` `[r, g, b, a]` per glyph (`count * 4`). */
  colors: Uint8Array
  /** `[sequence, z]` or `[sequence, z, switchEm]` per glyph (`count * metaItemSize`). */
  metadata: Float32Array
  metaItemSize: 2 | 3
  /** `[centerX, centerY, ordinal]` per glyph (`count * 3`) when shaped runs or SVG groups are present. */
  runMotion: Float32Array | null
  bounds: VanillaBounds
}

/** Packed typed-array instance attributes for DOM background rectangles. */
export interface VanillaRectInstances {
  count: number
  readonly receiveShadow: boolean
  /** `[x0, y0, x1, y1]` per rectangle (`count * 4`). */
  rects: Float32Array
  /** Normalized `unorm8` `[r, g, b, a]` per rectangle (`count * 4`). */
  colors: Uint8Array
  /** Corner radius per rectangle (`count`). */
  radii: Float32Array
  /** Z depth per rectangle (`count`). */
  depths: Float32Array
  bounds: VanillaBounds
}

/** Packed typed-array instance attributes for CSS text decorations. */
export interface VanillaDecorationInstances {
  count: number
  /** Source glyph `[x0, y0, x1, y1]` per decoration (`count * 4`). */
  rects: Float32Array
  /** Decoration stroke `[x0, y0, x1, y1]` per decoration (`count * 4`). */
  decorationRects: Float32Array
  /** Motion index per decoration (`count`). */
  decorationIndices: Float32Array
  /** Normalized `unorm8` `[r, g, b, a]` per decoration (`count * 4`). */
  colors: Uint8Array
  /** `[x0, y0, x1, y1]` clip box per decoration (`count * 4`). */
  clips: Float32Array
  /** `[sequence, z]` per decoration (`count * 2`). */
  metadata: Float32Array
  /** `[centerX, centerY, ordinal]` per decoration (`count * 3`) when shaped runs are present. */
  runMotion: Float32Array | null
  bounds: VanillaBounds
}

function byte(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 255
  return (value * 255 + 0.5) | 0
}

function metaSize(snapshot: DomLayoutSnapshot): 2 | 3 {
  return snapshot.sizeSwitched || snapshot.glyphs.some((glyph) => glyph.switchEm !== undefined)
    ? 3
    : 2
}

function writeMeta(target: Float32Array, index: number, size: number, glyph: GlyphLayout): void {
  target[index * size] = glyph.sequence
  target[index * size + 1] = glyph.z
  if (size === 3) target[index * size + 2] = glyph.switchEm ?? 0
}

function needsRunMotion(snapshot: DomLayoutSnapshot): boolean {
  return (
    snapshot.textShaping === 'browser' ||
    snapshot.glyphs.some((glyph) => glyph.motionOrigin !== undefined)
  )
}

function shapeOrdinals(snapshot: DomLayoutSnapshot): Float32Array | undefined {
  const glyphs = snapshot.glyphs
  if (!glyphs.some((glyph) => glyph.shapeGroup !== undefined)) return undefined
  const out = new Float32Array(glyphs.length)
  let ordinal = -1
  let previous: number | undefined
  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index]!
    if (glyph.shapeGroup === undefined || glyph.shapeGroup !== previous) ordinal++
    previous = glyph.shapeGroup
    out[index] = glyph.motionOrigin?.[2] ?? ordinal
  }
  return out
}

function writeUvRect(target: Uint16Array, offset: number, slot: GlyphSlot): void {
  target[offset] = (slot.u0 * 65535 + 0.5) | 0
  target[offset + 1] = (slot.v1 * 65535 + 0.5) | 0
  target[offset + 2] = (slot.u1 * 65535 + 0.5) | 0
  target[offset + 3] = (slot.v0 * 65535 + 0.5) | 0
}

const unorm16Floor = (value: number): number =>
  Math.min(65535, Math.max(0, Math.floor(value * 65535)))

const unorm16Ceil = (value: number): number =>
  Math.min(65535, Math.max(0, Math.ceil(value * 65535)))

function writeTrim(target: Uint16Array, offset: number, slot: GlyphSlot, uvRects: Uint16Array) {
  const support = slot.support
  if (!support) {
    target[offset] = uvRects[offset]!
    target[offset + 1] = uvRects[offset + 1]!
    target[offset + 2] = uvRects[offset + 2]!
    target[offset + 3] = uvRects[offset + 3]!
    return
  }
  target[offset] = unorm16Floor(support.u0)
  target[offset + 1] = unorm16Ceil(support.v1)
  target[offset + 2] = unorm16Ceil(support.u1)
  target[offset + 3] = unorm16Floor(support.v0)
}

function writeGlyphRect(
  rects: Float32Array,
  offset: number,
  glyph: GlyphLayout,
  slot: GlyphSlot,
  bakeSize: number,
  shaped: boolean,
): void {
  const scale = glyph.fontSize / bakeSize
  const scaleX = shaped && slot.advance > 0 ? glyph.advance / slot.advance : scale
  const baseline = glyph.lineBottom + (glyph.baselineOffset ?? slot.descent * scale)
  rects[offset] = glyph.originX + slot.planeX0 * scaleX
  rects[offset + 1] = baseline + slot.planeY0 * scale
  rects[offset + 2] = glyph.originX + slot.planeX1 * scaleX
  rects[offset + 3] = baseline + slot.planeY1 * scale
}

export type GlyphAtlasLookup = Pick<VanillaSdfAtlas, 'bakeSize' | 'glyphs'>

function writeVanillaRunMotion(
  runMotion: Float32Array | null,
  index: number,
  ordinal: number,
  glyph: GlyphLayout,
  rects: Float32Array,
  offset: number,
  motionOrdinals: Float32Array | undefined,
): void {
  if (!runMotion) return
  const rOffset = index * 3
  const origin = glyph.motionOrigin
  runMotion[rOffset] = origin ? origin[0] : (rects[offset]! + rects[offset + 2]!) * 0.5
  runMotion[rOffset + 1] = origin ? origin[1] : (rects[offset + 1]! + rects[offset + 3]!) * 0.5
  runMotion[rOffset + 2] = origin ? origin[2] : (motionOrdinals?.[ordinal] ?? ordinal)
}

function writeVanillaGlyphBatch(
  snapshot: DomLayoutSnapshot,
  atlas: GlyphAtlasLookup,
  rects: Float32Array,
  uvRects: Uint16Array,
  trims: Uint16Array | null,
  clips: Float32Array,
  colors: Uint8Array,
  metadata: Float32Array,
  metaItemSize: number,
  runMotion: Float32Array | null,
  motionOrdinals: Float32Array | undefined,
): [number, number, number, number] {
  const glyphs = snapshot.glyphs
  const total = glyphs.length
  const shaped = snapshot.textShaping === 'browser'
  const bakeSize = atlas.bakeSize
  const atlasGlyphs = atlas.glyphs
  let count = 0
  let maxSequence = 0
  let minZ = 0
  let maxZ = 0
  for (let ordinal = 0; ordinal < total; ordinal++) {
    const glyph = glyphs[ordinal]!
    const slot = atlasGlyphs.get(glyph.glyphKey)
    if (!slot) continue
    const index = count++
    const offset = index * 4
    writeGlyphRect(rects, offset, glyph, slot, bakeSize, shaped)
    writeUvRect(uvRects, offset, slot)
    if (trims) writeTrim(trims, offset, slot, uvRects)
    const clip = glyph.clip
    clips[offset] = clip[0]
    clips[offset + 1] = clip[1]
    clips[offset + 2] = clip[2]
    clips[offset + 3] = clip[3]
    const color = glyph.color
    colors[offset] = byte(color[0])
    colors[offset + 1] = byte(color[1])
    colors[offset + 2] = byte(color[2])
    colors[offset + 3] = byte(color[3])
    writeMeta(metadata, index, metaItemSize, glyph)
    writeVanillaRunMotion(runMotion, index, ordinal, glyph, rects, offset, motionOrdinals)
    if (glyph.sequence > maxSequence) maxSequence = glyph.sequence
    if (glyph.z < minZ) minZ = glyph.z
    if (glyph.z > maxZ) maxZ = glyph.z
  }
  return [count, maxSequence, minZ, maxZ]
}

/** Packs instanced glyph attribute arrays from a layout snapshot and SDF atlas. */
export function packGlyphInstances(
  snapshot: DomLayoutSnapshot,
  atlas: GlyphAtlasLookup,
  motionPadding = 0,
  motionOrdinals?: Float32Array,
): VanillaGlyphInstances {
  const hasRunMotion = needsRunMotion(snapshot)
  motionOrdinals ??= hasRunMotion ? shapeOrdinals(snapshot) : undefined
  const total = snapshot.glyphs.length
  const rects = new Float32Array(total * 4)
  const uvRects = new Uint16Array(total * 4)
  const clips = new Float32Array(total * 4)
  const colors = new Uint8Array(total * 4)
  const metaItemSize = metaSize(snapshot)
  const metadata = new Float32Array(total * metaItemSize)
  const runMotion = hasRunMotion || motionOrdinals ? new Float32Array(total * 3) : null
  const trims = runMotion ? null : new Uint16Array(total * 4)
  const [count, maxSequence, minZ, maxZ] = writeVanillaGlyphBatch(
    snapshot,
    atlas,
    rects,
    uvRects,
    trims,
    clips,
    colors,
    metadata,
    metaItemSize,
    runMotion,
    motionOrdinals,
  )

  const full = count === total
  return {
    count,
    maxSequence,
    rects: full ? rects : rects.subarray(0, count * 4),
    uvRects: full ? uvRects : uvRects.subarray(0, count * 4),
    trims: trims ? (full ? trims : trims.subarray(0, count * 4)) : null,
    clips: full ? clips : clips.subarray(0, count * 4),
    colors: full ? colors : colors.subarray(0, count * 4),
    metadata: full ? metadata : metadata.subarray(0, count * metaItemSize),
    metaItemSize,
    runMotion: runMotion ? (full ? runMotion : runMotion.subarray(0, count * 3)) : null,
    bounds: computeInstanceBounds(snapshot.width, snapshot.height, motionPadding, minZ, maxZ),
  }
}

/**
 * Rewrites the glyph instance arrays that change on a reflow (`rects`, `clips`, `metadata`,
 * `runMotion`, `bounds`) in place without reallocating. Returns `maxSequence`, or `null` when
 * the glyph count no longer matches.
 */
export function updateGlyphInstances(
  instances: VanillaGlyphInstances,
  snapshot: DomLayoutSnapshot,
  atlas: GlyphAtlasLookup,
  motionPadding = 0,
  motionOrdinals?: Float32Array,
): number | null {
  const { rects, clips, metadata, metaItemSize, runMotion, count: instanceCount } = instances
  const glyphs = snapshot.glyphs
  const total = glyphs.length
  if (total < instanceCount) return null
  motionOrdinals ??= needsRunMotion(snapshot) ? shapeOrdinals(snapshot) : undefined
  const shaped = snapshot.textShaping === 'browser'
  const bakeSize = atlas.bakeSize
  const atlasGlyphs = atlas.glyphs

  let count = 0
  let maxSequence = 0
  let minZ = 0
  let maxZ = 0
  for (let ordinal = 0; ordinal < total; ordinal++) {
    const glyph = glyphs[ordinal]!
    const slot = atlasGlyphs.get(glyph.glyphKey)
    if (!slot) continue
    if (count >= instanceCount) return null
    const index = count++
    const offset = index * 4
    writeGlyphRect(rects, offset, glyph, slot, bakeSize, shaped)
    const clip = glyph.clip
    clips[offset] = clip[0]
    clips[offset + 1] = clip[1]
    clips[offset + 2] = clip[2]
    clips[offset + 3] = clip[3]
    metadata[index * metaItemSize] = glyph.sequence
    writeVanillaRunMotion(runMotion, index, ordinal, glyph, rects, offset, motionOrdinals)
    if (glyph.sequence > maxSequence) maxSequence = glyph.sequence
    if (glyph.z < minZ) minZ = glyph.z
    if (glyph.z > maxZ) maxZ = glyph.z
  }
  if (count !== instanceCount) return null
  instances.maxSequence = maxSequence
  instances.bounds = computeInstanceBounds(
    snapshot.width,
    snapshot.height,
    motionPadding,
    minZ,
    maxZ,
  )
  return maxSequence
}

/**
 * Rewrites all glyph instance arrays in place when the drawable count and layout match.
 * Returns `maxSequence`, or `null` without mutating when the buffers do not fit.
 */
export function updateGlyphContentInstances(
  instances: VanillaGlyphInstances,
  snapshot: DomLayoutSnapshot,
  atlas: GlyphAtlasLookup,
  motionPadding = 0,
  motionOrdinals?: Float32Array,
): number | null {
  const glyphs = snapshot.glyphs
  const total = glyphs.length
  const expectedCount = instances.count
  if (total < expectedCount || metaSize(snapshot) !== instances.metaItemSize) return null
  const hasRun = needsRunMotion(snapshot)
  motionOrdinals ??= hasRun ? shapeOrdinals(snapshot) : undefined
  const wantsRun = hasRun || !!motionOrdinals
  if (wantsRun !== (instances.runMotion !== null)) return null
  const atlasGlyphs = atlas.glyphs
  let drawable = 0
  for (let i = 0; i < total; i++) {
    if (atlasGlyphs.has(glyphs[i]!.glyphKey)) {
      drawable++
      if (drawable > expectedCount) return null
    } else if (drawable + (total - 1 - i) < expectedCount) {
      return null
    }
  }
  if (drawable !== expectedCount) return null

  const [, maxSequence, minZ, maxZ] = writeVanillaGlyphBatch(
    snapshot,
    atlas,
    instances.rects,
    instances.uvRects,
    instances.trims,
    instances.clips,
    instances.colors,
    instances.metadata,
    instances.metaItemSize,
    instances.runMotion,
    motionOrdinals,
  )
  instances.maxSequence = maxSequence
  instances.bounds = computeInstanceBounds(
    snapshot.width,
    snapshot.height,
    motionPadding,
    minZ,
    maxZ,
  )
  return maxSequence
}

function rectCountFor(snapshot: DomLayoutSnapshot, receiveShadow: boolean): number {
  let count = 0
  for (const rect of snapshot.rects) if (rect.receiveShadow === receiveShadow) count++
  return count
}

function writeRectBatch(
  snapshot: DomLayoutSnapshot,
  receiveShadow: boolean,
  rects: Float32Array,
  colors: Uint8Array,
  radii: Float32Array,
  depths: Float32Array,
): [number, number] {
  let index = 0
  let minZ = 0
  let maxZ = 0
  for (const item of snapshot.rects) {
    if (item.receiveShadow !== receiveShadow) continue
    const offset = index * 4
    rects[offset] = item.rect[0]
    rects[offset + 1] = item.rect[1]
    rects[offset + 2] = item.rect[2]
    rects[offset + 3] = item.rect[3]
    colors[offset] = byte(item.color[0])
    colors[offset + 1] = byte(item.color[1])
    colors[offset + 2] = byte(item.color[2])
    colors[offset + 3] = byte(item.color[3])
    radii[index] = item.radius
    depths[index] = item.z
    if (item.z < minZ) minZ = item.z
    if (item.z > maxZ) maxZ = item.z
    index++
  }
  return [minZ, maxZ]
}

/** Packs instanced rectangle attribute arrays for `receiveShadow: false` or `true`. */
export function packRectInstances(
  snapshot: DomLayoutSnapshot,
  receiveShadow = false,
): VanillaRectInstances | null {
  const count = rectCountFor(snapshot, receiveShadow)
  if (count === 0) return null
  const rects = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)
  const radii = new Float32Array(count)
  const depths = new Float32Array(count)
  const [minZ, maxZ] = writeRectBatch(snapshot, receiveShadow, rects, colors, radii, depths)
  return {
    count,
    receiveShadow,
    rects,
    colors,
    radii,
    depths,
    bounds: computeInstanceBounds(snapshot.width, snapshot.height, 0, minZ, maxZ),
  }
}

/** Rewrites a same-count rectangle batch in place. Returns `false` when the count changed. */
export function updateRectInstances(
  instances: VanillaRectInstances,
  snapshot: DomLayoutSnapshot,
  receiveShadow = instances.receiveShadow,
): boolean {
  if (rectCountFor(snapshot, receiveShadow) !== instances.count) return false
  const [minZ, maxZ] = writeRectBatch(
    snapshot,
    receiveShadow,
    instances.rects,
    instances.colors,
    instances.radii,
    instances.depths,
  )
  instances.bounds = computeInstanceBounds(snapshot.width, snapshot.height, 0, minZ, maxZ)
  return true
}

type DecorationRecord = readonly [
  stroke: readonly [number, number, number, number],
  rectIndex: number,
  motionIndex: number,
  color: readonly [number, number, number, number],
  clip: readonly [number, number, number, number],
  sequence: number,
  z: number,
  motionOrigin: readonly [number, number, number] | null,
]

function sameDecoration(a: TextDecorationLayout, b: TextDecorationLayout): boolean {
  return (
    a.line === b.line &&
    a.offset === b.offset &&
    a.thickness === b.thickness &&
    a.color.every((v, i) => v === b.color[i])
  )
}

let cachedVanillaRecordsSnapshot: DomLayoutSnapshot | null = null
let cachedVanillaRecordsDrawable: ((key: string) => boolean) | null = null
let cachedVanillaRecords: readonly DecorationRecord[] = []

function decorationRecords(
  snapshot: DomLayoutSnapshot,
  drawable: (key: string) => boolean,
): readonly DecorationRecord[] {
  if (snapshot === cachedVanillaRecordsSnapshot && drawable === cachedVanillaRecordsDrawable) {
    return cachedVanillaRecords
  }
  const glyphs = snapshot.glyphs
  const records: DecorationRecord[] = []
  if (glyphs.some((glyph) => glyph.decorations?.length)) {
    let glyphIndex = 0
    let motionIndex = -1
    let previousGroup: number | undefined
    for (let index = 0; index < glyphs.length; index++) {
      const glyph = glyphs[index]!
      if (!drawable(glyph.glyphKey)) continue
      if (glyph.shapeGroup === undefined || glyph.shapeGroup !== previousGroup) motionIndex++
      previousGroup = glyph.shapeGroup
      const decorations = glyph.decorations
      if (decorations) {
        for (const decoration of decorations) {
          if (decoration.thickness <= 0 || decoration.color[3] <= 0) continue
          const next = glyphs[index + 1]
          let right = glyph.originX + (glyph.decorationWidth ?? Math.abs(glyph.advance))
          if (
            next?.block === glyph.block &&
            next.lineBottom === glyph.lineBottom &&
            next.decorations?.some((candidate) => sameDecoration(decoration, candidate))
          ) {
            right = Math.max(right, next.originX)
          }
          const y = glyph.lineBottom + decoration.offset
          records.push([
            [glyph.originX, y - decoration.thickness / 2, right, y + decoration.thickness / 2],
            glyphIndex,
            glyph.motionOrigin?.[2] ?? motionIndex,
            decoration.color,
            glyph.clip,
            glyph.sequence,
            glyph.z,
            glyph.motionOrigin ?? null,
          ])
        }
      }
      glyphIndex++
    }
  }
  cachedVanillaRecordsSnapshot = snapshot
  cachedVanillaRecordsDrawable = drawable
  return (cachedVanillaRecords = records)
}

function writeDecorationBatch(
  records: readonly DecorationRecord[],
  sourceRects: ArrayLike<number>,
  rects: Float32Array,
  strokes: Float32Array,
  indices: Float32Array,
  colors: Uint8Array,
  clips: Float32Array,
  metadata: Float32Array,
  runMotion: Float32Array | null,
): [number, number] {
  let minZ = 0
  let maxZ = 0
  for (let index = 0; index < records.length; index++) {
    const [stroke, rectIndex, motionIndex, color, clip, sequence, z, motionOrigin] = records[index]!
    const offset = index * 4
    const srcOffset = rectIndex * 4
    rects[offset] = sourceRects[srcOffset] ?? 0
    rects[offset + 1] = sourceRects[srcOffset + 1] ?? 0
    rects[offset + 2] = sourceRects[srcOffset + 2] ?? 0
    rects[offset + 3] = sourceRects[srcOffset + 3] ?? 0
    strokes.set(stroke, offset)
    clips.set(clip, offset)
    indices[index] = motionIndex
    colors[offset] = byte(color[0])
    colors[offset + 1] = byte(color[1])
    colors[offset + 2] = byte(color[2])
    colors[offset + 3] = byte(color[3])
    metadata[index * 2] = sequence
    metadata[index * 2 + 1] = z
    if (runMotion && motionOrigin) runMotion.set(motionOrigin, index * 3)
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return [minZ, maxZ]
}

export function packDecorationInstances(
  snapshot: DomLayoutSnapshot,
  sourceGlyphRects: ArrayLike<number>,
  drawable: (key: string) => boolean,
  motionPadding = 0,
): VanillaDecorationInstances | null {
  const records = decorationRecords(snapshot, drawable)
  const count = records.length
  if (count === 0) return null
  const rects = new Float32Array(count * 4)
  const decorationRects = new Float32Array(count * 4)
  const decorationIndices = new Float32Array(count)
  const colors = new Uint8Array(count * 4)
  const clips = new Float32Array(count * 4)
  const metadata = new Float32Array(count * 2)
  const runMotion = records.some((record) => record[7] !== null)
    ? new Float32Array(count * 3)
    : null
  const [minZ, maxZ] = writeDecorationBatch(
    records,
    sourceGlyphRects,
    rects,
    decorationRects,
    decorationIndices,
    colors,
    clips,
    metadata,
    runMotion,
  )
  return {
    count,
    rects,
    decorationRects,
    decorationIndices,
    colors,
    clips,
    metadata,
    runMotion,
    bounds: computeInstanceBounds(snapshot.width, snapshot.height, motionPadding, minZ, maxZ),
  }
}

export function updateDecorationInstances(
  instances: VanillaDecorationInstances,
  snapshot: DomLayoutSnapshot,
  sourceGlyphRects: ArrayLike<number>,
  drawable: (key: string) => boolean,
  motionPadding = 0,
): boolean {
  const records = decorationRecords(snapshot, drawable)
  if (records.length === 0 || records.length !== instances.count) return false
  const wantsRun = records.some((record) => record[7] !== null)
  if (wantsRun !== (instances.runMotion !== null)) return false
  const [minZ, maxZ] = writeDecorationBatch(
    records,
    sourceGlyphRects,
    instances.rects,
    instances.decorationRects,
    instances.decorationIndices,
    instances.colors,
    instances.clips,
    instances.metadata,
    instances.runMotion,
  )
  instances.bounds = computeInstanceBounds(
    snapshot.width,
    snapshot.height,
    motionPadding,
    minZ,
    maxZ,
  )
  return true
}

// ============================================================================
// Retained Engine-Agnostic Controllers: VanillaDomText & VanillaText
// ============================================================================

export interface VanillaDomTextRebuildOptions {
  signal?: AbortSignal
}

export type VanillaChangeReason = 'create' | 'rebuild' | 'reflow' | 'motion' | 'dispose'

/** Options for `VanillaDomText` (`DomText` / `DomSdf` in `ultra-text/vanilla`). */
export interface VanillaDomTextOptions extends Omit<
  DomSdfOptions,
  'fill' | 'vertex' | 'sharedAtlas' | 'side' | 'textBackend' | 'windfoil'
> {
  /** Optional shared `VanillaSdfAtlas` across multiple `VanillaDomText` instances. */
  sharedAtlas?: VanillaSdfAtlas
  /** Called after initial creation, rebuild, reflow, motion update, or disposal. */
  onChange?: (instance: VanillaDomText, reason: VanillaChangeReason) => void
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function makeAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted', 'AbortError')
  }
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function linkAbortSignals(...signals: (AbortSignal | undefined)[]): [AbortController, () => void] {
  const controller = new AbortController()
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason ?? makeAbortError())
      return [controller, (): void => undefined]
    }
  }
  const listeners = activeSignals.map((signal) => {
    const onAbort = (): void => {
      controller.abort(signal.reason ?? makeAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return [signal, onAbort] as const
  })
  return [
    controller,
    (): void => {
      for (const [signal, onAbort] of listeners) {
        signal.removeEventListener('abort', onAbort)
      }
    },
  ]
}

async function waitForDocumentFonts(document: Document, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const fonts = document.fonts as FontFaceSet | undefined
  if (!fonts) return
  if (!signal) {
    await Promise.resolve(fonts.ready)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException(String(signal.reason ?? 'The operation was aborted'), 'AbortError'),
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve(fonts.ready).then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function hasAllGlyphs(
  atlas: VanillaSdfAtlas,
  snapshot: DomLayoutSnapshot,
  colorGlyphsOption: ColorGlyphMode | undefined,
): boolean {
  const bitmap =
    colorGlyphsOption === 'none' && snapshot.requests.some((request) => request.shape?.bitmap)
  return snapshot.requests.every((request) => {
    const slot = atlas.glyphs.get(request.key)
    return (
      slot !== undefined &&
      !(colorGlyphsOption === 'none' && bitmap && !request.shape && slot.color) &&
      (!isColorCandidate(request, colorGlyphsOption) || slot.color !== undefined)
    )
  })
}

export class VanillaDomText {
  readonly element: HTMLElement
  readonly device: VanillaGpuDevice | null
  readonly options: Readonly<VanillaDomTextOptions>

  glyphs!: VanillaGlyphInstances
  plainRects: VanillaRectInstances | null = null
  litRects: VanillaRectInstances | null = null
  decorations: VanillaDecorationInstances | null = null
  tone: ResolvedTextTone | null = null
  motion: Required<SdfMotionOptions>

  #a!: VanillaSdfAtlas
  #s: DomLayoutSnapshot | null = null
  #as = ''
  #ls = ''
  #o = true
  #st!: DomSdfStats
  #ro: ResizeObserver | null = null
  #mo: MutationObserver | null = null
  #uf: (() => void) | null = null
  #f: number | null = null
  #ac: AbortController | null = null
  #rv = 0
  #av = 0
  #sel = false
  #d = false
  #cbs = new Set<(instance: VanillaDomText, reason: VanillaChangeReason) => void>()

  protected constructor(
    element: HTMLElement,
    deviceOrRenderer: VanillaGpuDeviceSource,
    options: VanillaDomTextOptions,
  ) {
    this.element = element
    this.device = resolveGpuDevice(deviceOrRenderer)
    this.options = Object.freeze({ ...options })
    this.motion = {
      enabled: options.motion?.enabled ?? true,
      mode: options.motion?.mode ?? 'slide-up',
      strength: Math.max(0, options.motion?.strength ?? 18),
      speed: Math.max(0, options.motion?.speed ?? 1.35),
      stagger: Math.max(0, options.motion?.stagger ?? 0.045),
    }
    if (options.onChange) this.#cbs.add(options.onChange)
  }

  static async create(
    element: HTMLElement,
    deviceOrRenderer?: VanillaGpuDeviceSource,
    options: VanillaDomTextOptions = {},
  ): Promise<VanillaDomText> {
    if (!element.isConnected) {
      throw new Error('VanillaDomText.create requires a connected HTMLElement')
    }
    options.signal?.throwIfAborted()
    if (
      options.sharedAtlas &&
      (options.sharedAtlas.mipmaps !== (options.quality === 'high') ||
        ((options.colorGlyphs ?? 'emoji') !== 'none') !== Boolean(options.sharedAtlas.colorLayer))
    ) {
      throw new Error('VanillaDomText: sharedAtlas must match quality and colorGlyphs options')
    }

    const instance = new VanillaDomText(element, deviceOrRenderer, options)
    try {
      instance.applySelectableAttribute()
      await instance.rebuild(options.signal ? { signal: options.signal } : {})
      instance.setupObservers()
      instance.notify('create')
      return instance
    } catch (error) {
      instance.dispose()
      throw error
    }
  }

  get atlas(): VanillaSdfAtlas {
    return this.#a
  }

  get stats(): Readonly<DomSdfStats> {
    return this.#st
  }

  get snapshot(): DomLayoutSnapshot | null {
    return this.#s
  }

  get width(): number {
    return this.#s?.width ?? 0
  }

  get height(): number {
    return this.#s?.height ?? 0
  }

  get isDisposed(): boolean {
    return this.#d
  }

  subscribe(listener: (instance: VanillaDomText, reason: VanillaChangeReason) => void): () => void {
    this.#cbs.add(listener)
    return (): void => {
      this.#cbs.delete(listener)
    }
  }

  reflow(width: number): this {
    if (this.#d) {
      throw new Error('Cannot reflow a disposed VanillaDomText instance')
    }
    if (this.options.reflowable !== true || !this.#s) {
      throw new Error('VanillaDomText.reflow requires { reflowable: true } at creation time')
    }
    if (this.#s.textShaping === 'browser') {
      throw new Error(
        'VanillaDomText.reflow does not support textShaping: "browser"; call rebuild() after resizing',
      )
    }
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError('VanillaDomText.reflow: width must be a positive finite number')
    }
    const geometryStart = nowMs()
    const nextSnapshot = reflowSnapshot(this.#s, width)
    const motionPadding = Math.max(0, this.motion.strength)
    const maxSequence = updateGlyphInstances(this.glyphs, nextSnapshot, this.#a, motionPadding)
    if (maxSequence === null) {
      this.glyphs = packGlyphInstances(nextSnapshot, this.#a, motionPadding)
    }
    if (this.decorations) {
      const drawable = (key: string): boolean => this.#a.glyphs.has(key)
      if (
        !updateDecorationInstances(
          this.decorations,
          nextSnapshot,
          this.glyphs.rects,
          drawable,
          motionPadding,
        )
      ) {
        this.decorations = packDecorationInstances(
          nextSnapshot,
          this.glyphs.rects,
          drawable,
          motionPadding,
        )
      }
    }
    const geometryBuildMs = nowMs() - geometryStart
    this.#s = nextSnapshot
    this.#ls = ''
    const draws =
      (this.plainRects ? 1 : 0) +
      (this.litRects ? 1 : 0) +
      (this.glyphs.count > 0 ? 1 : 0) +
      (this.decorations ? 1 : 0)
    this.#st = Object.freeze({
      ...this.#st,
      atlasBuildMs: 0,
      layoutReadMs: 0,
      geometryBuildMs,
      lines: nextSnapshot.lineCount,
      draws,
    })
    this.notify('reflow')
    return this
  }

  setMotion(motion: SdfMotionOptions): this {
    if (this.#d) return this
    const previousStrength = this.motion.strength
    this.motion = {
      enabled: motion.enabled ?? this.motion.enabled,
      mode: motion.mode ?? this.motion.mode,
      strength: Math.max(0, motion.strength ?? this.motion.strength),
      speed: Math.max(0, motion.speed ?? this.motion.speed),
      stagger: Math.max(0, motion.stagger ?? this.motion.stagger),
    }
    if (this.motion.strength !== previousStrength && this.#s) {
      const padding = this.motion.strength
      let minZ = 0
      let maxZ = 0
      for (const glyph of this.#s.glyphs) {
        if (glyph.z < minZ) minZ = glyph.z
        if (glyph.z > maxZ) maxZ = glyph.z
      }
      this.glyphs.bounds = computeInstanceBounds(this.#s.width, this.#s.height, padding, minZ, maxZ)
    }
    this.notify('motion')
    return this
  }

  async rebuild(rebuildOptions: VanillaDomTextRebuildOptions = {}): Promise<this> {
    if (this.#d) {
      throw new Error('Cannot rebuild a disposed VanillaDomText instance')
    }
    if (!this.element.isConnected) {
      throw new Error('Cannot rebuild VanillaDomText when the source element is disconnected')
    }

    const version = ++this.#rv
    this.#ac?.abort(makeAbortError())
    const [controller, unlinkSignals] = linkAbortSignals(this.options.signal, rebuildOptions.signal)
    this.#ac = controller
    const { signal } = controller

    let nextAtlas: VanillaSdfAtlas | undefined
    let nextOwnsAtlas = true

    try {
      await waitForDocumentFonts(this.element.ownerDocument, signal)
      signal.throwIfAborted()

      const { device } = this
      const opts = this.options
      const sharedAtlas = opts.sharedAtlas
      const currentAtlas = this.#a as VanillaSdfAtlas | undefined
      const gpuUpload = opts.atlasMode !== 'cpu' && typeof device?.createShaderModule === 'function'
      if (gpuUpload && !sharedAtlas && !currentAtlas && !devicePipelines.has(device)) {
        try {
          getDevicePipelines(device)
          device.queue.submit([])
        } catch {
          // Deferred to buildVanillaSdfAtlas error handling.
        }
      }

      const layoutStart = nowMs()
      const snapshotOptions: DomSdfOptions = {
        ...(opts as Omit<VanillaDomTextOptions, 'sharedAtlas' | 'onChange'>),
        signal,
      }
      const snapshot = await collectDomSnapshot(this.element, snapshotOptions)
      const layoutReadMs = nowMs() - layoutStart
      signal.throwIfAborted()
      const nextTone = this.resolveCaptureTone(snapshot)

      const canUseSharedAtlas = Boolean(
        sharedAtlas && hasAllGlyphs(sharedAtlas, snapshot, opts.colorGlyphs),
      )
      const canReusePrivateAtlas = Boolean(
        !canUseSharedAtlas &&
        currentAtlas &&
        this.#o &&
        (this.#as === snapshot.atlasSignature ||
          hasAllGlyphs(currentAtlas, snapshot, opts.colorGlyphs)),
      )

      const nextLayoutSignature = layoutSignatureOf(snapshot)
      if (this.#ls === '' && this.#s) {
        this.#ls = layoutSignatureOf(this.#s)
      }
      if (
        (canUseSharedAtlas || canReusePrivateAtlas) &&
        this.#ls !== '' &&
        nextLayoutSignature === this.#ls
      ) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (version !== this.#rv || this.#d) {
          throw makeAbortError()
        }
        this.tone = nextTone
        this.#s = snapshot
        this.#st = Object.freeze({
          ...this.#st,
          atlasBuildMs: 0,
          layoutReadMs,
          geometryBuildMs: 0,
        })
        this.notify('rebuild')
        return this
      }

      const atlasStart = nowMs()
      const highQuality = opts.quality === 'high'
      if (canUseSharedAtlas && sharedAtlas) {
        nextAtlas = sharedAtlas
        nextOwnsAtlas = false
      } else if (canReusePrivateAtlas && currentAtlas) {
        nextAtlas = currentAtlas
        nextOwnsAtlas = true
      } else {
        const raster = await rasterizeGlyphAtlas(this.element.ownerDocument, snapshot.requests, {
          ...opts,
          previousAtlas: currentAtlas !== sharedAtlas ? currentAtlas : undefined,
          ...(gpuUpload ? { gpuUpload } : {}),
          signal,
        })
        signal.throwIfAborted()
        nextAtlas = await buildVanillaSdfAtlas(device, raster, {
          ...(opts.cpuWorker === undefined ? {} : { cpuWorker: opts.cpuWorker }),
          mode: opts.atlasMode ?? 'auto',
          mipmaps: highQuality,
          anisotropy: highQuality ? 4 : 1,
          signal,
        })
        ;(nextAtlas as VanillaSdfAtlas & { colorGlyphs?: ColorGlyphMode }).colorGlyphs =
          opts.colorGlyphs ?? 'emoji'
        nextOwnsAtlas = true
      }
      const atlasBuildMs = canUseSharedAtlas || canReusePrivateAtlas ? 0 : nowMs() - atlasStart
      signal.throwIfAborted()

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (version !== this.#rv || this.#d) {
        throw makeAbortError()
      }

      const resolvedAtlas = nextAtlas
      const geometryStart = nowMs()
      const motionPadding = Math.max(0, this.motion.strength)
      const drawable = (key: string): boolean => resolvedAtlas.glyphs.has(key)

      const currentGlyphs = this.glyphs as VanillaGlyphInstances | undefined
      if (
        !currentGlyphs ||
        updateGlyphContentInstances(currentGlyphs, snapshot, resolvedAtlas, motionPadding) === null
      ) {
        this.glyphs = packGlyphInstances(snapshot, resolvedAtlas, motionPadding)
      }

      if (!this.plainRects || !updateRectInstances(this.plainRects, snapshot, false)) {
        this.plainRects = packRectInstances(snapshot, false)
      }
      if (!this.litRects || !updateRectInstances(this.litRects, snapshot, true)) {
        this.litRects = packRectInstances(snapshot, true)
      }

      if (
        !this.decorations ||
        !updateDecorationInstances(
          this.decorations,
          snapshot,
          this.glyphs.rects,
          drawable,
          motionPadding,
        )
      ) {
        this.decorations = packDecorationInstances(
          snapshot,
          this.glyphs.rects,
          drawable,
          motionPadding,
        )
      }
      const geometryBuildMs = nowMs() - geometryStart

      const previousAtlas = this.#a as VanillaSdfAtlas | undefined
      const previousOwnsAtlas = this.#o
      this.#a = resolvedAtlas
      this.#o = nextOwnsAtlas
      this.tone = nextTone
      this.#s = snapshot
      if (!canUseSharedAtlas && !canReusePrivateAtlas) {
        this.#as = snapshot.atlasSignature
      }
      this.#ls = nextLayoutSignature
      this.#av = version

      let textGlyphs = 0
      let shapes = 0
      let colorGlyphCount = 0
      for (const glyph of snapshot.glyphs) {
        if (glyph.shapeGroup !== undefined) shapes++
        else {
          textGlyphs++
          if (resolvedAtlas.glyphs.get(glyph.glyphKey)?.color) colorGlyphCount++
        }
      }
      const mipFactor = highQuality ? 4 / 3 : 1
      const colorBytes = resolvedAtlas.colorLayer
        ? resolvedAtlas.width * resolvedAtlas.colorLayer.height * 4
        : 0
      const textStorageBytes = Math.round(
        (resolvedAtlas.width * resolvedAtlas.height + colorBytes) * mipFactor,
      )
      const draws =
        (this.plainRects ? 1 : 0) +
        (this.litRects ? 1 : 0) +
        (this.glyphs.count > 0 ? 1 : 0) +
        (this.decorations ? 1 : 0)

      this.#st = Object.freeze({
        colorGlyphs: colorGlyphCount,
        shapes,
        fallbackGlyphs: 0,
        switchableGlyphs: 0,
        atlasBuildMs,
        layoutReadMs,
        geometryBuildMs,
        glyphs: textGlyphs,
        rects: snapshot.rects.length,
        lines: snapshot.lineCount,
        draws,
        atlasWidth: resolvedAtlas.width,
        atlasHeight: resolvedAtlas.height,
        textBackend: 'sdf',
        atlasMode: resolvedAtlas.mode,
        textStorageBytes,
      })

      if (previousAtlas && previousOwnsAtlas && previousAtlas !== resolvedAtlas) {
        previousAtlas.dispose()
      }
      if (this.#av > 1) {
        this.notify('rebuild')
      }
      return this
    } catch (error) {
      if (nextAtlas && nextOwnsAtlas && nextAtlas !== (this.#a as VanillaSdfAtlas | undefined)) {
        nextAtlas.dispose()
      }
      throw error
    } finally {
      unlinkSignals()
      if (this.#ac === controller) {
        this.#ac = null
      }
    }
  }

  dispose(): void {
    if (this.#d) return
    this.#d = true
    this.#ac?.abort(makeAbortError())
    this.#ac = null
    if (this.#f !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.#f)
      this.#f = null
    }
    this.#ro?.disconnect()
    this.#ro = null
    this.#mo?.disconnect()
    this.#mo = null
    this.#uf?.()
    this.#uf = null
    if (this.#sel) {
      this.element.classList.remove('sdf-selectable')
      this.#sel = false
    }
    const currentAtlas = this.#a as VanillaSdfAtlas | undefined
    if (currentAtlas && this.#o) {
      currentAtlas.dispose()
    }
    this.#s = null
    this.notify('dispose')
    this.#cbs.clear()
  }

  protected resolveCaptureTone(snapshot: DomLayoutSnapshot): ResolvedTextTone | null {
    return resolveDomTextTone(this.element, this.options.tone, {
      glyphs: snapshot.glyphs,
      rects: snapshot.rects,
      rootRect: this.options.includeRootBackground !== false,
    })
  }

  protected notify(reason: VanillaChangeReason): void {
    for (const listener of this.#cbs) {
      listener(this, reason)
    }
  }

  protected applySelectableAttribute(): void {
    if (this.options.selectable !== true) return
    if (!this.element.classList.contains('sdf-selectable')) {
      this.element.classList.add('sdf-selectable')
      this.#sel = true
    }
  }

  protected setupObservers(): void {
    if (this.options.observe === false || this.#d) return
    const schedule = (): void => {
      if (this.#d || this.#f !== null) return
      if (typeof requestAnimationFrame === 'function') {
        this.#f = requestAnimationFrame(() => {
          this.#f = null
          if (this.#d || !this.element.isConnected) return
          void this.rebuild().catch((error: unknown) => {
            if (!isAbortError(error)) {
              this.options.onError?.(error)
            }
          })
        })
      }
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.#ro = new ResizeObserver(schedule)
      this.#ro.observe(this.element)
    }
    if (typeof MutationObserver !== 'undefined') {
      this.#mo = new MutationObserver(schedule)
      this.#mo.observe(this.element, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'dir', 'lang', 'data-text-depth', 'data-sdf-depth'],
      })
    }
    const fonts = this.element.ownerDocument.fonts as FontFaceSet | undefined
    if (fonts && typeof fonts.addEventListener === 'function') {
      fonts.addEventListener('loadingdone', schedule)
      this.#uf = (): void => {
        fonts.removeEventListener('loadingdone', schedule)
      }
    }
  }
}

export { VanillaDomText as DomSdf, VanillaDomText as DomText }

export interface VanillaTextOptions extends VanillaDomTextOptions {
  device?: VanillaGpuDeviceSource
  renderer?: VanillaGpuDeviceSource
  css?: TextCss
  cssClass?: TextClass
  parent?: HTMLElement
}

const UNITLESS_CSS = new Set(
  'aspect-ratio columns column-count fill-opacity flex flex-grow flex-shrink font-weight grid-column grid-row line-clamp line-height opacity order orphans scale stroke-opacity tab-size widows z-index zoom'.split(
    ' ',
  ),
)

const BASE_TEXT_STYLE: Readonly<Record<string, string>> = {
  position: 'fixed',
  left: '0',
  top: '0',
  margin: '0',
  pointerEvents: 'none',
  userSelect: 'none',
  webkitUserSelect: 'none',
  visibility: 'hidden',
  zIndex: '-2147483648',
}

function kebabProperty(name: string): string {
  if (name.startsWith('--')) return name
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function applyBaseStyle(element: HTMLElement): void {
  for (const [property, value] of Object.entries(BASE_TEXT_STYLE)) {
    element.style.setProperty(kebabProperty(property), value)
  }
}

function applyTextCss(element: HTMLElement, css: TextCss | undefined): void {
  element.removeAttribute('style')
  if (typeof css === 'string') {
    element.style.cssText = css
  } else if (css) {
    for (const [rawName, rawValue] of Object.entries(css)) {
      if (rawValue === undefined || rawValue === null) continue
      const property = kebabProperty(rawName)
      const value =
        typeof rawValue === 'number' && !property.startsWith('--') && !UNITLESS_CSS.has(property)
          ? `${String(rawValue)}px`
          : String(rawValue)
      element.style.setProperty(property, value)
    }
  }
  applyBaseStyle(element)
}

function classTokens(cssClass: TextClass | undefined): string[] {
  if (!cssClass) return []
  const raw =
    typeof cssClass === 'string'
      ? [cssClass]
      : Array.isArray(cssClass)
        ? (cssClass as readonly string[])
        : Object.entries(cssClass)
            .filter(([, enabled]) => Boolean(enabled))
            .map(([name]) => name)
  return raw.flatMap((entry) => entry.split(/\s+/)).filter(Boolean)
}

function createOwnedTextElement(text: string, options: VanillaTextOptions): HTMLElement {
  const parent = options.parent ?? (typeof document !== 'undefined' ? document.body : null)
  if (!parent?.isConnected) {
    throw new Error('VanillaText requires a connected parent element or document.body')
  }
  const element = parent.ownerDocument.createElement('div')
  element.setAttribute('data-sdf-block', '')
  element.setAttribute('aria-hidden', 'true')
  element.textContent = text
  applyTextCss(element, options.css)
  parent.appendChild(element)
  return element
}

function stripTextOnlyOptions(options: VanillaTextOptions): VanillaDomTextOptions {
  const domOptions: VanillaTextOptions = { ...options }
  delete domOptions.css
  delete domOptions.cssClass
  delete domOptions.parent
  delete domOptions.device
  delete domOptions.renderer
  return domOptions
}

export class VanillaText extends VanillaDomText {
  readonly ready: Promise<this>
  #t: string
  #c: string[] = []

  constructor(text: string, options: VanillaTextOptions = {}) {
    options.signal?.throwIfAborted()
    const element = createOwnedTextElement(text, options)
    super(element, options.device ?? options.renderer, stripTextOnlyOptions(options))
    this.#t = text
    this.#acls(options.cssClass)
    this.ready = this.#p(options.signal)
  }

  async #p(signal?: AbortSignal): Promise<this> {
    try {
      await this.rebuild(signal ? { signal } : {})
      this.setupObservers()
      this.notify('create')
      return this
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  static override create(text: string, options?: VanillaTextOptions): Promise<VanillaText>
  static override create(
    element: HTMLElement,
    deviceOrRenderer?: VanillaGpuDeviceSource,
    options?: VanillaDomTextOptions,
  ): Promise<VanillaDomText>
  static override async create(
    textOrElement: string | HTMLElement,
    optionsOrDevice?: VanillaTextOptions | VanillaGpuDeviceSource,
    maybeOptions?: VanillaDomTextOptions,
  ): Promise<VanillaDomText> {
    if (typeof textOrElement === 'string') {
      const instance = new VanillaText(
        textOrElement,
        (optionsOrDevice as VanillaTextOptions | undefined) ?? {},
      )
      return instance.ready
    }
    return super.create(textOrElement, optionsOrDevice as VanillaGpuDeviceSource, maybeOptions)
  }

  get text(): string {
    return this.#t
  }

  set text(value: string) {
    this.#t = value
    if (!this.isDisposed) {
      this.element.textContent = value
    }
  }

  async setText(value: string, options?: VanillaDomTextRebuildOptions): Promise<this> {
    this.text = value
    return this.rebuild(options)
  }

  async setCss(css: TextCss | undefined, options?: VanillaDomTextRebuildOptions): Promise<this> {
    if (!this.isDisposed) applyTextCss(this.element, css)
    return this.rebuild(options)
  }

  async setClass(
    cssClass: TextClass | undefined,
    options?: VanillaDomTextRebuildOptions,
  ): Promise<this> {
    if (!this.isDisposed) this.#acls(cssClass)
    return this.rebuild(options)
  }

  override dispose(): void {
    const wasDisposed = this.isDisposed
    super.dispose()
    if (!wasDisposed) {
      this.element.remove()
    }
  }

  protected override resolveCaptureTone(snapshot: DomLayoutSnapshot): ResolvedTextTone | null {
    return resolveDomTextTone(this.element, this.options.tone, {
      glyphs: snapshot.glyphs,
      rects: snapshot.rects,
      rootRect: this.options.includeRootBackground !== false,
      page: false,
    })
  }

  #acls(cssClass: TextClass | undefined): void {
    if (this.#c.length > 0) {
      this.element.classList.remove(...this.#c)
    }
    this.#c = classTokens(cssClass)
    if (this.#c.length > 0) {
      this.element.classList.add(...this.#c)
    }
  }
}

export { VanillaText as Text }
