import {
  ExternalTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  WebGPUBackend,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'

import type { BuildSdfAtlasOptions, RasterAtlas, SdfAtlas } from '../types.js'
import { JFA_WGSL } from './jfaWgsl.js'
import type { ShapeRows } from './rasterize.js'

// 8×8 = 64 invocations fits the compatibility-mode default of 128 as well as the core 256.
// Every invocation reads its neighbours from one buffer and writes only its own texel to
// another, so the workgroup shape changes scheduling, never a byte of the atlas.
const COMPUTE_WORKGROUP_DIMENSION = 8
// The seed kernel reads the raster words and writes seeds; the jump kernel binds a read-only
// input and a writable output. The resolve pass reads only the final seeds (with the inside
// bit carried in the sign of seed.x) in its fragment stage.
const COMPUTE_STORAGE_BUFFERS = 2
const FRAGMENT_STORAGE_BUFFERS = 1

interface AtlasDeviceLimits {
  readonly maxStorageBufferBindingSize: number
  readonly maxBufferSize: number
  readonly maxComputeInvocationsPerWorkgroup?: number
  readonly maxComputeWorkgroupSizeX?: number
  readonly maxComputeWorkgroupSizeY?: number
  readonly maxStorageBuffersPerShaderStage?: number
  readonly maxStorageBuffersInFragmentStage?: number
  readonly maxTextureDimension2D?: number
}

type AtlasErrorFilter = 'validation' | 'out-of-memory' | 'internal'

/** @internal The WebGPU texture calls the atlas makes (no `@webgpu/types` needed). */
export interface AtlasGpuTexture {
  readonly mipLevelCount: number
  createView(descriptor?: { baseMipLevel?: number; mipLevelCount?: number }): unknown
  destroy(): void
}

interface AtlasGpuBuffer {
  destroy(): void
}

interface AtlasPipeline {
  getBindGroupLayout(index: number): unknown
}

interface AtlasPass {
  setPipeline(pipeline: AtlasPipeline): void
  setBindGroup(index: number, bindGroup: unknown): void
  end(): void
}

/** @internal One command encoder of the atlas passes, which a patch adds its copies to. */
export interface AtlasEncoder {
  copyTextureToBuffer(
    source: { texture: AtlasGpuTexture },
    destination: { buffer: AtlasGpuBuffer; bytesPerRow: number; rowsPerImage: number },
    size: [number, number],
  ): void
  copyTextureToTexture(
    source: { texture: AtlasGpuTexture; origin: [number, number] },
    destination: { texture: AtlasGpuTexture; origin: [number, number] },
    size: [number, number],
  ): void
  beginComputePass(): AtlasPass & { dispatchWorkgroups(x: number, y: number): void }
  beginRenderPass(descriptor: {
    colorAttachments: { view: unknown; loadOp: 'clear'; storeOp: 'store' }[]
  }): AtlasPass & { draw(vertexCount: number): void }
  finish(): unknown
}

/** @internal The device calls of the atlas passes, called with the device as `this`. */
export interface AtlasDevice {
  readonly limits?: AtlasDeviceLimits
  createTexture(descriptor: {
    size: [number, number]
    mipLevelCount?: number
    format: string
    usage: number
  }): AtlasGpuTexture
  createBuffer(descriptor: { size: number; usage: number }): AtlasGpuBuffer
  createShaderModule(descriptor: { label: string; code: string }): unknown
  createComputePipeline(descriptor: {
    layout: 'auto'
    compute: { module: unknown; entryPoint: string }
  }): AtlasPipeline
  createRenderPipeline(descriptor: {
    layout: 'auto'
    vertex: { module: unknown; entryPoint: string }
    fragment: { module: unknown; entryPoint: string; targets: { format: string }[] }
  }): AtlasPipeline
  createBindGroup(descriptor: {
    layout: unknown
    entries: { binding: number; resource: unknown }[]
  }): unknown
  createCommandEncoder(): AtlasEncoder
  readonly queue: {
    copyExternalImageToTexture(
      source: { source: HTMLCanvasElement; flipY: boolean },
      destination: { texture: AtlasGpuTexture; premultipliedAlpha: boolean },
      size: [number, number],
    ): void
    writeBuffer(buffer: AtlasGpuBuffer, offset: number, data: Int32Array): void
    submit(commandBuffers: unknown[]): void
  }
  readonly pushErrorScope?: (filter: AtlasErrorFilter) => void
  readonly popErrorScope?: () => Promise<{ readonly message?: string } | null>
}

interface UsageFlags {
  GPUBufferUsage?: { STORAGE: number; UNIFORM: number; COPY_DST: number }
  GPUTextureUsage?: {
    COPY_SRC: number
    COPY_DST: number
    TEXTURE_BINDING: number
    RENDER_ATTACHMENT: number
  }
}

const KERNEL_NEEDS = [
  ['maxComputeInvocationsPerWorkgroup', COMPUTE_WORKGROUP_DIMENSION ** 2],
  ['maxComputeWorkgroupSizeX', COMPUTE_WORKGROUP_DIMENSION],
  ['maxComputeWorkgroupSizeY', COMPUTE_WORKGROUP_DIMENSION],
  ['maxStorageBuffersPerShaderStage', COMPUTE_STORAGE_BUFFERS],
  ['maxStorageBuffersInFragmentStage', FRAGMENT_STORAGE_BUFFERS],
] as const satisfies readonly (readonly [keyof AtlasDeviceLimits, number])[]

/** A texture-to-buffer copy aligns each row to 256 bytes; the raster keeps 4 bytes a texel. */
function rasterRowBytes(width: number): number {
  return Math.ceil(width / 64) * 256
}

/**
 * Past a device limit the passes are invalid, which WebGPU reports only asynchronously:
 * checking first lets `auto` fall back without GPU work and `gpu` fail with a reason.
 */
function checkAtlasLimits(limits: AtlasDeviceLimits, width: number, height: number): void {
  for (const [name, need] of KERNEL_NEEDS) {
    const value = limits[name]
    // A browser that predates a limit does not report it, and then has nothing to check.
    if (value !== undefined && value < need) {
      throw new RangeError(`buildGpuSdfAtlas: ${name}=${value}, needs ${need}; use atlasMode "cpu"`)
    }
  }
  const largest = limits.maxTextureDimension2D
  if (largest !== undefined && Math.max(width, height) > largest) {
    throw new RangeError(
      `buildGpuSdfAtlas: ${width}×${height} exceeds maxTextureDimension2D=${largest}; lower maxAtlasSize`,
    )
  }
  // Each ping-pong seed buffer holds one vec2<f32> per texel and is bound whole, as is the
  // raster copy, whose rows are padded to 256 bytes (more than the seeds below 64 texels wide).
  const bytes = Math.max(width * height * 8, rasterRowBytes(width) * height)
  if (bytes > limits.maxStorageBufferBindingSize || bytes > limits.maxBufferSize) {
    throw new RangeError(
      `buildGpuSdfAtlas: ${width}×${height} exceeds storage-buffer limits; use atlasMode "cpu" or lower maxAtlasSize`,
    )
  }
}

const ERROR_FILTERS: readonly AtlasErrorFilter[] = ['validation', 'out-of-memory', 'internal']

/**
 * Captures what the device reports about the calls made until `close()`. Without a scope an
 * invalid pass would surface only as a console warning, and the atlas would come back blank
 * or wrong while `auto` saw nothing to fall back from. `close()` pops synchronously, so
 * concurrent builds cannot interleave scopes, and never rejects.
 */
function openErrorScopes(device: AtlasDevice): { close(): Promise<string | null> } {
  const push = device.pushErrorScope
  const pop = device.popErrorScope
  if (!push || !pop) {
    return { close: () => Promise.resolve(null) }
  }
  for (const filter of ERROR_FILTERS) push.call(device, filter)
  return {
    close() {
      return Promise.all(ERROR_FILTERS.map(() => pop.call(device))).then(
        (errors) => {
          const error = errors.find(Boolean)
          return error ? (error.message ?? 'unknown GPU error') : null
        },
        (error: unknown) => String(error),
      )
    },
  }
}

/**
 * The jump-flood ladder only has to reach as far as the encoding can represent.
 *
 * A byte stores `0.5 - signedDistance / pxRange`, so everything beyond
 * `pxRange / 2` pixels from an edge saturates to 0 or 1 no matter what distance
 * the field holds there. A ladder `S, S/2, … 1` propagates at most `2S - 1`
 * pixels per axis, so the smallest sufficient first step is `(radius + 1) / 2`
 * rounded up to a power of two.
 *
 * Sizing the ladder from `pxRange` instead of the atlas extent is what keeps this
 * at three or four passes rather than one per octave of the atlas: at 2048² and
 * the default padding that is 4 passes instead of 12.
 */
function jfaSteps(pxRange: number): number[] {
  const radius = Math.ceil(pxRange * 0.5) + 1
  let step = 1
  while (step * 2 - 1 < radius) step <<= 1
  const steps: number[] = []
  for (; step >= 1; step >>= 1) steps.push(step)
  return steps
}

interface AtlasPipelines {
  readonly seed: AtlasPipeline
  readonly jump: AtlasPipeline
  readonly resolve: AtlasPipeline
}

/**
 * One shader module and pipeline set per device, made on its first atlas and kept for its
 * lifetime: a few native objects, while the buffers of a build live only through its
 * submission. Writing the passes in WGSL spares every page three's node graph build of
 * three passes on its first atlas, and every later build and patch the rebuild of their
 * graphs (about 15 and 3 ms on an M3 Max).
 */
const devicePipelines = new WeakMap<AtlasDevice, AtlasPipelines>()

function atlasPipelines(device: AtlasDevice): AtlasPipelines {
  let pipelines = devicePipelines.get(device)
  if (!pipelines) {
    const module = device.createShaderModule({ label: 'ultra-text atlas', code: JFA_WGSL })
    const compute = (entryPoint: string): AtlasPipeline =>
      device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } })
    pipelines = {
      seed: compute('seedMain'),
      jump: compute('jumpMain'),
      resolve: device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'fullscreenVert' },
        fragment: { module, entryPoint: 'resolveFrag', targets: [{ format: 'r8unorm' }] },
      }),
    }
    devicePipelines.set(device, pipelines)
  }
  return pipelines
}

/**
 * @internal Starts the native compile of the device's atlas passes ahead of its first atlas,
 * while the caller reads the DOM: the device compiles them meanwhile (about 2.5 ms on an M3 Max
 * with a warm shader cache), and the atlas then waits for its own work only. Making them
 * cannot throw; a device that rejects them fails the first atlas's submission instead, in its
 * error scopes, and that build makes them again.
 */
export function prepareAtlasPasses(renderer: WebGPURenderer): void {
  const device = atlasDevice(renderer)
  if (device?.createShaderModule && !devicePipelines.has(device)) {
    atlasPipelines(device)
    device.queue.submit([])
  }
}

/**
 * @internal Regenerates the mips of an atlas texture from its level 0 with three's own mip
 * pass, as three does for a render target, after the submissions that wrote it.
 */
export async function generateAtlasMips(renderer: WebGPURenderer, texture: Texture): Promise<void> {
  const scopes = openErrorScopes(atlasDevice(renderer)!)
  let reported: Promise<string | null>
  try {
    renderer.initTexture(texture)
    ;(renderer.backend as unknown as { generateMipmaps(texture: Texture): void }).generateMipmaps(
      texture,
    )
  } finally {
    reported = scopes.close()
  }
  const rejection = await reported
  if (rejection !== null) throw new Error(`buildGpuSdfAtlas: mip generation failed: ${rejection}`)
}

/** @internal The device behind a WebGPU-backend renderer, or `undefined`. */
export function atlasDevice(renderer: WebGPURenderer): AtlasDevice | undefined {
  return (renderer.backend as unknown as { device?: AtlasDevice }).device
}

/**
 * @internal Runs the atlas passes over `raster` into level 0 of a new r8unorm texture of
 * `mipLevelCount` levels, all in one command buffer: the canvas is uploaded and copied into a storage buffer
 * of 256-byte rows, the seeds are found and flooded in two ping-pong buffers, and the resolve
 * pass encodes the distances. `finish` may add commands that use the texture before it is
 * submitted, as a patch does. Resolves with the texture once the device has accepted every
 * call; rejects, holding nothing, when the device's limits cannot hold the passes, lacks
 * these calls or reports an error for them. The buffers and the upload live only through the
 * submission: destroying them waits for the submitted work.
 */
export async function encodeGpuSdf(
  device: AtlasDevice | undefined,
  raster: Pick<RasterAtlas, 'canvas' | 'width' | 'height' | 'pxRange'>,
  mipLevelCount: number,
  finish?: (encoder: AtlasEncoder, texture: AtlasGpuTexture) => void,
): Promise<AtlasGpuTexture> {
  const { width, height, pxRange } = raster
  const { GPUBufferUsage: buffers, GPUTextureUsage: textures } = globalThis as UsageFlags
  if (!device?.createCommandEncoder || !buffers || !textures)
    throw new Error('buildGpuSdfAtlas: device cannot run the atlas passes')
  if (device.limits) checkAtlasLimits(device.limits, width, height)
  const transient: { destroy(): void }[] = []
  let output: AtlasGpuTexture | undefined
  try {
    const scopes = openErrorScopes(device)
    let reported: Promise<string | null>
    try {
      const pipelines = atlasPipelines(device)
      const steps = jfaSteps(pxRange)
      const rowBytes = rasterRowBytes(width)
      const buffer = (size: number, usage: number): AtlasGpuBuffer => {
        const created = device.createBuffer({ size, usage })
        transient.push(created)
        return created
      }
      const upload = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: textures.COPY_SRC | textures.COPY_DST | textures.RENDER_ATTACHMENT,
      })
      transient.push(upload)
      const words = buffer(rowBytes * height, buffers.STORAGE | buffers.COPY_DST)
      const seeds = [
        buffer(width * height * 8, buffers.STORAGE),
        buffer(width * height * 8, buffers.STORAGE),
      ]
      // Uniform slots 256 bytes apart: the seed and resolve parameters, then one per step.
      const params = buffer(steps.length * 256 + 16, buffers.UNIFORM | buffers.COPY_DST)
      const values = new Int32Array(steps.length * 64 + 4)
      values.set([width, height, rowBytes / 4])
      new Float32Array(values.buffer, 12, 1)[0] = 1 / pxRange
      steps.forEach((step, index) => values.set([width, height, step], (index + 1) * 64))
      device.queue.writeBuffer(params, 0, values)
      // Exactly as three uploads a CanvasTexture: rgba8unorm, no flip, straight alpha.
      device.queue.copyExternalImageToTexture(
        { source: raster.canvas, flipY: false },
        { texture: upload, premultipliedAlpha: false },
        [width, height],
      )
      output = device.createTexture({
        size: [width, height],
        mipLevelCount,
        format: 'r8unorm',
        usage:
          textures.RENDER_ATTACHMENT |
          textures.TEXTURE_BINDING |
          textures.COPY_SRC |
          textures.COPY_DST,
      })
      const bind = (
        pipeline: AtlasPipeline,
        offset: number,
        ...storageBuffers: AtlasGpuBuffer[]
      ): unknown =>
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: params, offset, size: 16 } },
            ...storageBuffers.map((resource, index) => ({
              binding: index + 1,
              resource: { buffer: resource },
            })),
          ],
        })
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer(
        { texture: upload },
        { buffer: words, bytesPerRow: rowBytes, rowsPerImage: height },
        [width, height],
      )
      const groupsX = Math.ceil(width / COMPUTE_WORKGROUP_DIMENSION)
      const groupsY = Math.ceil(height / COMPUTE_WORKGROUP_DIMENSION)
      const flood = encoder.beginComputePass()
      flood.setPipeline(pipelines.seed)
      flood.setBindGroup(0, bind(pipelines.seed, 0, words, seeds[0]!))
      flood.dispatchWorkgroups(groupsX, groupsY)
      flood.setPipeline(pipelines.jump)
      steps.forEach((_, index) => {
        const into = seeds[(index + 1) % 2]!
        flood.setBindGroup(0, bind(pipelines.jump, (index + 1) * 256, seeds[index % 2]!, into))
        flood.dispatchWorkgroups(groupsX, groupsY)
      })
      flood.end()
      // The full-screen triangle writes every texel of level 0.
      const resolve = encoder.beginRenderPass({
        colorAttachments: [
          { view: output.createView({ mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' },
        ],
      })
      resolve.setPipeline(pipelines.resolve)
      resolve.setBindGroup(0, bind(pipelines.resolve, 0, seeds[steps.length % 2]!))
      resolve.draw(3)
      resolve.end()
      finish?.(encoder, output)
      device.queue.submit([encoder.finish()])
    } finally {
      reported = scopes.close()
    }
    const rejection = await reported
    if (rejection !== null) {
      // A later build makes its pipelines again rather than reusing ones the device rejected.
      devicePipelines.delete(device)
      throw new Error(`buildGpuSdfAtlas: the device rejected the atlas passes: ${rejection}`)
    }
    const retained = output
    output = undefined
    return retained
  } finally {
    for (const resource of transient) resource.destroy()
    output?.destroy()
  }
}

/**
 * Generates a compact R8 runtime SDF on the renderer's WebGPU device: boundary seeding and a
 * storage-buffer jump flood in compute passes, then a resolve render pass (`JFA_WGSL`). The
 * texture is an `ExternalTexture` the atlas owns, with three's mips when `mipmaps`. It
 * rejects, instead of returning a blank or wrong atlas, when the device's limits cannot hold
 * the passes, the backend lacks the calls, or the device reports an error for them.
 */
export async function buildGpuSdfAtlas(
  renderer: WebGPURenderer,
  raster: RasterAtlas,
  options: Pick<BuildSdfAtlasOptions, 'mipmaps' | 'anisotropy'> = {},
): Promise<SdfAtlas> {
  await renderer.init()
  if (!(renderer.backend instanceof WebGPUBackend)) {
    throw new Error('buildGpuSdfAtlas: requires the WebGPU backend; use mode "cpu"')
  }
  const { width, height } = raster
  const mipmaps = options.mipmaps === true
  // three's full mip chain when `mipmaps`.
  const levels = mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1
  const gpuTexture = await encodeGpuSdf(atlasDevice(renderer), raster, levels)
  const texture = new ExternalTexture(gpuTexture)
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    // three never destroys an external texture's GPU texture: its owner does.
    try {
      texture.dispose()
    } finally {
      gpuTexture.destroy()
    }
  }
  try {
    // three sizes the texture's memory from its image.
    ;(texture as { image: unknown }).image = { width, height }
    texture.name = 'ultra-text SDF atlas'
    texture.format = RedFormat
    texture.colorSpace = NoColorSpace
    // Read by the material, which keeps whole quads over mipmaps; three never generates an
    // external texture's mips itself (`generateAtlasMips` does).
    texture.generateMipmaps = mipmaps
    texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter
    texture.magFilter = LinearFilter
    texture.anisotropy = mipmaps
      ? Math.min(Math.max(1, options.anisotropy ?? 1), renderer.getMaxAnisotropy())
      : 1
    if (mipmaps) await generateAtlasMips(renderer, texture)
  } catch (error) {
    dispose()
    throw error
  }
  const { shapeTop } = raster as RasterAtlas & ShapeRows
  return {
    ...(shapeTop === undefined ? {} : { shapeTop }),
    texture,
    width,
    height,
    pxRange: raster.pxRange,
    bakeSize: raster.bakeSize,
    glyphs: raster.glyphs,
    mode: 'gpu',
    dispose,
  }
}
