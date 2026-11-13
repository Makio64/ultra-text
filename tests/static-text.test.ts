import {
  DirectionalLight,
  DoubleSide,
  GLSLNodeBuilder,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  StorageBufferAttribute,
  Texture,
  WebGPURenderer,
  WGSLNodeBuilder,
  type Material,
  type NodeMaterial,
} from 'three/webgpu'
import { storage } from 'three/tsl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRectMaterial } from '../src/text/RectMaterial.js'
import { isAnimatedMotion } from '../src/text/GlyphTextMaterial.js'
import { SdfTextMaterial, type SdfTextMaterialOptions } from '../src/text/SdfTextMaterial.js'
import { TextDecorationMaterial } from '../src/text/decorations.js'
import { WindfoilMaterial } from '../src/windfoil/WindfoilMaterial.js'
import { readyForShaderGeneration } from './helpers/shader-renderer.js'
import { disposeShaderRenderer, shaderRenderer } from './helpers/wgsl-build.js'

let renderer: WebGPURenderer
beforeEach(() => {
  renderer = shaderRenderer()
})
afterEach(async () => {
  await disposeShaderRenderer(renderer)
})

/**
 * Both stages of `material` on a quad, in a scene with a shadow-casting light when `lit`, as
 * WGSL, or as the WebGL2 fallback's GLSL when `webgl` is the renderer's GLSL twin.
 */
function wgsl(
  material: NodeMaterial,
  lit = false,
  webgl?: WebGPURenderer,
): { vertex: string; fragment: string } {
  const geometry = new PlaneGeometry()
  try {
    const mesh = new Mesh(geometry, material)
    const scene = new Scene()
    scene.add(mesh)
    const camera = new PerspectiveCamera()
    camera.updateMatrixWorld()
    const light = new DirectionalLight(0xffffff, 2)
    light.castShadow = true
    if (lit) scene.add(light, light.target)
    scene.updateMatrixWorld()
    const Builder = webgl ? GLSLNodeBuilder : WGSLNodeBuilder
    const builder = new Builder(mesh, webgl ?? renderer) as unknown as {
      scene: Scene
      camera: PerspectiveCamera
      material: Material
      lightsNode: unknown
      context: { material: Material }
      build(): void
      vertexShader: string
      fragmentShader: string
    }
    builder.scene = scene
    builder.camera = camera
    builder.material = material
    builder.context.material = material
    if (lit) {
      const lights = renderer.lighting.getNode(scene)
      lights.setLights([light])
      builder.lightsNode = lights
    }
    builder.build()
    return { vertex: builder.vertexShader, fragment: builder.fragmentShader }
  } finally {
    geometry.dispose()
  }
}

const sdfOptions = (extra: Partial<SdfTextMaterialOptions> = {}): SdfTextMaterialOptions => ({
  atlas: new Texture(),
  atlasWidth: 64,
  atlasHeight: 64,
  pxRange: 8,
  ...extra,
})

function windfoilStorage() {
  const curves = new StorageBufferAttribute(new Float32Array(12), 2)
  const rows = new StorageBufferAttribute(new Uint32Array([0, 1, 0, 0, 0, 0]), 1)
  return {
    curves: storage(curves, 'vec2', curves.count).toReadOnly(),
    rows: storage(rows, 'uint', rows.count).toReadOnly(),
  }
}

/** Traces of the motion graph: its clock, waves, slide timeline and motion alpha. */
function expectMotionGraph(code: { vertex: string; fragment: string }, present: boolean): void {
  for (const trace of ['sin(', 'tsl_mod_float', 'vUltraTextMotionAlpha'])
    expect(code.vertex.includes(trace)).toBe(present)
  expect(code.fragment.includes('vUltraTextMotionAlpha')).toBe(present)
}

describe('static text materials (motion: false)', () => {
  it('decides the kind from the mode alone', () => {
    expect(isAnimatedMotion(undefined)).toBe(true)
    expect(isAnimatedMotion({})).toBe(true)
    expect(isAnimatedMotion({ enabled: false })).toBe(true)
    expect(isAnimatedMotion({ enabled: false, mode: 'scale' })).toBe(true)
    expect(isAnimatedMotion({ mode: 'none' })).toBe(false)
    expect(isAnimatedMotion(false)).toBe(false)
  })

  it('builds SDF text without the motion graph and reads as disabled', () => {
    const animated = new SdfTextMaterial(sdfOptions())
    const still = new SdfTextMaterial(sdfOptions({ motion: false }))
    expect(animated.animated).toBe(true)
    expect(still.animated).toBe(false)
    expect(still.motionEnabled.value).toBe(0)
    expect(still.motionMode.value).toBe(0)
    expectMotionGraph(wgsl(animated), true)
    const code = wgsl(still)
    expectMotionGraph(code, false)
    // The same atlas sample and coverage remain.
    expect(code.fragment).toContain('textureSample')
    animated.dispose()
    still.dispose()
  })

  it('keeps effects, fills and the size switch on the static graph', () => {
    const still = new SdfTextMaterial(
      sdfOptions({
        motion: false,
        outline: { width: 1 },
        dropShadow: {},
        keepGlyph: (anchor) => anchor.x.greaterThan(0),
      }),
    )
    const code = wgsl(still)
    expectMotionGraph(code, false)
    expect(code.vertex).toContain('vUltraSdfUvBounds')
    still.dispose()
  })

  it('refuses motion on a static material, clones static, and twins into an animated one', () => {
    const still = new SdfTextMaterial(
      sdfOptions({ motion: false, threshold: 0.47, maxSequence: 5, side: DoubleSide }),
    )
    expect(() => still.setMotion({ mode: 'offset' })).toThrow(/motion: false/)
    const clone = still.clone()
    expect(clone.animated).toBe(false)
    expect(() => clone.setMotion({ speed: 2 })).toThrow(/motion: false/)
    expectMotionGraph(wgsl(clone), false)

    still.shadowCutoff.value = 0.3
    const twin = still.withMotion({ mode: 'offset', strength: 4 })
    expect(twin).toBeInstanceOf(SdfTextMaterial)
    expect(twin.animated).toBe(true)
    expect(twin.motionEnabled.value).toBe(1)
    expect(twin.motionMode.value).toBe(3)
    expect(twin.motionStrength.value).toBe(4)
    expect(twin.motionSpeed.value).toBe(1.35)
    expect(twin.threshold.value).toBe(0.47)
    expect(twin.shadowCutoff.value).toBe(0.3)
    expect(twin.maxSequence.value).toBe(5)
    expect(twin.side).toBe(DoubleSide)
    expectMotionGraph(wgsl(twin), true)
    twin.setMotion({ speed: 2 })
    expect(twin.motionSpeed.value).toBe(2)
    for (const material of [still, clone, twin]) material.dispose()
  })

  it('builds the same static graph for the WebGL2 fallback', async () => {
    const webgl = readyForShaderGeneration(
      new WebGPURenderer({ canvas: document.createElement('canvas'), forceWebGL: true }),
    )
    vi.spyOn(webgl, 'hasFeature').mockReturnValue(false)
    try {
      for (const motion of [{}, { motion: false }] as const) {
        const animated = !('motion' in motion)
        for (const material of [
          new SdfTextMaterial(sdfOptions(motion)),
          new TextDecorationMaterial(motion),
        ]) {
          const code = wgsl(material, false, webgl)
          for (const trace of ['sin(', 'mod(', 'vUltraTextMotionAlpha'])
            expect(code.vertex.includes(trace)).toBe(animated)
          expect(code.fragment.includes('vUltraTextMotionAlpha')).toBe(animated)
          material.dispose()
        }
      }
    } finally {
      await disposeShaderRenderer(webgl)
    }
  })

  it('builds static decorations and Windfoil text, with their shadow passes', () => {
    const decorations = new TextDecorationMaterial({ motion: false })
    const windfoil = new WindfoilMaterial({ ...windfoilStorage(), motion: false })
    for (const material of [decorations, windfoil]) {
      expect(material.animated).toBe(false)
      expect(material.castShadowPositionNode).toBe(material.positionNode)
      expectMotionGraph(wgsl(material), false)
    }
    const twin = windfoil.withMotion({})
    expect(twin).toBeInstanceOf(WindfoilMaterial)
    expectMotionGraph(wgsl(twin), true)
    for (const material of [decorations, windfoil, twin]) material.dispose()
  })
})

describe('unlit text and rects', () => {
  it('keeps the scene lights out of text and plain rect shaders', () => {
    // MeshBasic's default: the scene's lights reach the shader, though they change no pixel.
    const lit = new SdfTextMaterial(sdfOptions())
    lit.lights = true
    expect(wgsl(lit, true).fragment).not.toBe(wgsl(lit).fragment)
    lit.dispose()
    const materials = [
      new SdfTextMaterial(sdfOptions()),
      new SdfTextMaterial(sdfOptions({ motion: false })),
      new TextDecorationMaterial({}),
      new WindfoilMaterial(windfoilStorage()),
      createRectMaterial(false),
    ]
    for (const material of materials) {
      expect(material.lights).toBe(false)
      expect(wgsl(material, true).fragment).toBe(wgsl(material).fragment)
      material.dispose()
    }
  })

  it('keeps shadow receivers lit and draws a double-sided rect in one pass', () => {
    const receiver = createRectMaterial(true)
    const plain = createRectMaterial(false)
    expect(receiver.lights).toBe(true)
    expect(wgsl(receiver, true).fragment).not.toBe(wgsl(receiver).fragment)
    for (const material of [receiver, plain]) {
      expect(material.forceSinglePass).toBe(true)
      material.dispose()
    }
  })
})
