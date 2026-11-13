import {
  Mesh,
  type NodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
  WGSLNodeBuilder,
  type Material,
} from 'three/webgpu'
import { vi } from 'vitest'
import { readyForShaderGeneration } from './shader-renderer.js'

/** A renderer that never initialises, ready to generate WGSL through a node builder. */
export function shaderRenderer(): WebGPURenderer {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  const created = readyForShaderGeneration(
    new WebGPURenderer({ canvas: document.createElement('canvas') }),
  )
  vi.spyOn(created, 'hasFeature').mockReturnValue(false)
  return created
}

/** Disposes a renderer made by {@link shaderRenderer} without starting its backend. */
export async function disposeShaderRenderer(created: WebGPURenderer): Promise<void> {
  vi.spyOn(created, 'setAnimationLoop').mockResolvedValue(undefined)
  await created.dispose()
}

/** The fragment WGSL of `material` drawn on a quad. */
export function fragmentWgsl(renderer: WebGPURenderer, material: NodeMaterial): string {
  const geometry = new PlaneGeometry()
  try {
    const mesh = new Mesh(geometry, material)
    const scene = new Scene()
    scene.add(mesh)
    const camera = new PerspectiveCamera()
    camera.updateMatrixWorld()
    const builder = new WGSLNodeBuilder(mesh, renderer) as unknown as {
      scene: Scene
      camera: PerspectiveCamera
      material: Material
      context: { material: Material }
      build(): void
      fragmentShader: string
    }
    builder.scene = scene
    builder.camera = camera
    builder.material = material
    builder.context.material = material
    builder.build()
    return builder.fragmentShader
  } finally {
    geometry.dispose()
  }
}

/** The text of the first block that opens after `start`, braces balanced. */
export function blockAfter(wgsl: string, start: number): string {
  const open = wgsl.indexOf('{', start)
  let depth = 0
  for (let index = open; index < wgsl.length; index++) {
    if (wgsl[index] === '{') depth++
    else if (wgsl[index] === '}' && --depth === 0) return wgsl.slice(open, index + 1)
  }
  throw new Error('unbalanced WGSL block')
}

/** Occurrences of `pattern` in `text`. */
export const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

/** The WGSL of a compute node, built as three's node manager builds one. */
export function computeWgsl(renderer: WebGPURenderer, computeNode: object): string {
  const builder = new WGSLNodeBuilder(null as never, renderer) as unknown as {
    compute: object
    build(): void
    computeShader: string
  }
  builder.compute = computeNode
  builder.build()
  return builder.computeShader
}
