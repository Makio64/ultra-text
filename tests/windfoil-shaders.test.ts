import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  Scene,
  WebGPURenderer,
  WGSLNodeBuilder,
  type Material,
  type Node,
} from 'three/webgpu'
import { renderGroup, vec4 } from 'three/tsl'
import { windfoilKernelSkirt } from '../src/windfoil/coverage.js'
import { buildWindfoilBackend } from '../src/windfoil/runtime.js'
import type {
  DomLayoutSnapshot,
  GlyphRequest,
  TextFill,
  TextToneOptions,
  WindfoilGlyphOutline,
} from '../src/types.js'
import { readyForShaderGeneration } from './helpers/shader-renderer.js'
const outline: WindfoilGlyphOutline = {
  unitsPerEm: 10,
  ascent: 10,
  descent: 0,
  bbox: [0, 0, 10, 10],
  quadratics: [0, 0, 5, 0, 10, 0, 10, 0, 10, 5, 10, 10, 10, 10, 5, 10, 0, 10, 0, 10, 0, 5, 0, 0],
}
const request = { key: 'a', character: 'a', font: { family: 'test' } } as GlyphRequest
const snapshot = {
  width: 20,
  height: 20,
  glyphs: [
    {
      glyphKey: 'a',
      fontSize: 10,
      originX: 0,
      lineBottom: 0,
      clip: [0, 0, 20, 20],
      color: [1, 1, 1, 1],
      sequence: 0,
      z: 0,
    },
  ],
  rects: [],
  blocks: [],
  requests: [request],
} as unknown as DomLayoutSnapshot
const renderers: WebGPURenderer[] = []
afterEach(async () => {
  for (const renderer of renderers) await renderer.dispose()
  renderers.length = 0
  vi.unstubAllGlobals()
})
/** What a `let` binds to the name `value` (three r187 binds a value read twice), else `value`. */
function bound(code: string, value: string): string {
  if (!/^\w+$/.test(value)) return value
  return new RegExp(`^\\s*let ${value} = (.*);$`, 'm').exec(code)?.[1] ?? value
}
/**
 * The WGSL name of three's `sRGBTransferEOTF()`: r187 gives it a short layout, so the builder
 * names it `fnN`, numbered in the order three's functions were made.
 */
function srgbToLinear(code: string): string {
  const declaration =
    /^fn (\w+) \( color : vec3<f32> \) -> vec3<f32> \{\s*return mix\( pow\( \( \( color \* vec3<f32>\( 0\.9478672986 \) \) \+ vec3<f32>\( 0\.0521327014 \) \), vec3<f32>\( 2\.4 \) \)/m
  return declaration.exec(code)?.[1] ?? '(no sRGB transfer)'
}
async function generate(
  layered: boolean,
  compositing: 'layers' | 'shader' = 'layers',
  // 'pass' builds the shader of a shadow map as three derives it from the material.
  shadow: boolean | 'pass' = false,
  customFill: boolean | TextFill = false,
  clone = false,
  solidOnly = false,
  tone?: TextToneOptions | false,
  // Whether each instance carries its font size, as a size-switch layout does.
  sized = false,
) {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  const renderer = readyForShaderGeneration(
    new WebGPURenderer({ canvas: document.createElement('canvas') }),
  )
  renderers.push(renderer)
  vi.spyOn(renderer, 'init').mockResolvedValue(renderer)
  vi.spyOn(renderer, 'setAnimationLoop').mockResolvedValue(undefined)
  vi.spyOn(renderer, 'hasFeature').mockReturnValue(false)
  const backend = await buildWindfoilBackend(
    renderer,
    [request],
    {
      outlineProvider: () =>
        layered
          ? {
              ...outline,
              quadratics: [],
              layers: [
                {
                  quadratics: outline.quadratics,
                  paint: solidOnly
                    ? { type: 'solid', color: [1, 0, 0, 0.5] }
                    : {
                        type: 'linear',
                        p0: [0, 0],
                        p1: [10, 0],
                        stops: [
                          { offset: 0, color: [1, 0, 0, 1] },
                          { offset: 1, color: [0, 0, 1, 1] },
                        ],
                      },
                },
                ...(solidOnly
                  ? [
                      {
                        quadratics: outline.quadratics,
                        paint: { type: 'foreground' as const, alpha: 0.75 },
                      },
                    ]
                  : []),
              ],
            }
          : outline,
      compositing,
    },
    new AbortController().signal,
  )
  const layout = sized
    ? { ...snapshot, glyphs: snapshot.glyphs.map((glyph) => ({ ...glyph, switchEm: 10 })) }
    : snapshot
  const part = backend!.color ?? backend!,
    geometry = part.createGeometry(layout, 0).geometry,
    source = part.createMaterial({
      motion: { enabled: false },
      maxSequence: 0,
      ...(customFill ? { fill: customFill === true ? () => vec4(0, 1, 0, 0.75) : customFill } : {}),
      ...(tone === undefined ? {} : { tone }),
    })
  const material = clone ? source.clone() : source
  const shadowMaterial = new MeshBasicNodeMaterial()
  if (shadow === 'pass') {
    const nodes = (
      renderer as unknown as {
        _getShadowNodes(source: Material): {
          colorNode: Node<'vec4'> | null
          positionNode: Node<'vec3'> | null
        }
      }
    )._getShadowNodes(material)
    ;(shadowMaterial as { isShadowPassMaterial?: boolean }).isShadowPassMaterial = true
    shadowMaterial.colorNode = nodes.colorNode
    shadowMaterial.positionNode = nodes.positionNode
  } else {
    shadowMaterial.positionNode = material.castShadowPositionNode
    shadowMaterial.maskNode = material.maskShadowNode
    shadowMaterial.colorNode = vec4(1)
  }
  const selected = shadow ? shadowMaterial : material
  const mesh = new Mesh(geometry, selected),
    scene = new Scene()
  scene.add(mesh)
  const builder = new WGSLNodeBuilder(mesh, renderer) as unknown as {
    scene: Scene
    camera: OrthographicCamera
    material: Material
    context: { material: Material }
    build(): void
    getAttributesArray(): { name: string }[]
    vertexShader: string
    fragmentShader: string
  }
  builder.scene = scene
  builder.camera = new OrthographicCamera(0, 20, 20, 0, 0.1, 10)
  builder.material = selected
  builder.context.material = selected
  builder.build()
  const result = {
    vertex: builder.vertexShader,
    fragment: builder.fragmentShader,
    attributes: builder.getAttributesArray().map((attribute) => attribute.name),
  }
  material.dispose()
  if (clone) source.dispose()
  shadowMaterial.dispose()
  geometry.dispose()
  backend!.dispose()
  return result
}
describe('Windfoil shader graphs', () => {
  it('pins the default analytic shader and omits the layered attribute', async () => {
    const shader = await generate(false)
    expect(shader.attributes).not.toContain('windfoilLayer')
    // Pins are of three r187's spelling: its shared `let`s and typed literals, same computation.
    // Re-pinned when the flat varyings took `either` vertex, their only change.
    // Re-pinned, with the tone-less and shadow-mask pins below, when plain outlines took the
    // evaluator layered ones already had: x mirrored by the walk's direction, one piece
    // integral, entry-point locals; that integral reads a full-width stretch's rise from the
    // window's bounds.
    // A piece that only passes beside the pixel must add the window's own height: the difference
    // of two roots left magnified interiors a few percent short.
    expect(shader.fragment).toContain(
      'let yq = select(select(q1.y + (a2.y * tq + 2.0 * b1.y) * tq, V.y, tq >= T.y), V.x, tq <= T.x);',
    )
    expect(shader.fragment).not.toContain('windfoil_integrate_inside')
    expect(
      createHash('sha256')
        .update(shader.vertex + '\0' + shader.fragment)
        .digest('hex'),
    ).toBe('30e774c6551e5a10086ac3449224bed208a581e9c8773d2975f31a0acbda3eb4')
  })
  it('adds just one layer attribute and evaluates gradients with integer storage indices', async () => {
    const shader = await generate(true)
    expect(shader.attributes).toContain('windfoilLayer')
    expect(shader.attributes.length).toBeLessThanOrEqual(8)
    expect(shader.fragment).toContain('ultraWindfoilPaints')
    expect(shader.fragment).toContain('unpack4x8unorm')
    expect(shader.fragment.indexOf('discard;')).toBeLessThan(shader.fragment.indexOf('for ('))
  })
  it('reads every per-glyph integer through a flat varying', async () => {
    // Rows, band counts, layer lists and paints are integers per instance. Interpolated, a
    // constant can arrive a hair under itself (Safari's relaxed math on Apple GPUs), and u32()
    // then truncates it: the pixel integrates another row's curves, a streak along the row.
    const shaders = [
      await generate(false),
      await generate(false, 'layers', 'pass'),
      await generate(true),
      await generate(true, 'shader'),
      await generate(true, 'shader', true),
    ]
    for (const shader of shaders) {
      const inputs = new Map<string, boolean>()
      for (const [, flat, name] of shader.fragment.matchAll(
        /@location\( \d+ \) (@interpolate\( flat, either \) )?(\w+) :/g,
      ))
        inputs.set(name!, flat !== undefined)
      const truncated = [...shader.fragment.matchAll(/u32\( \(? ?(\w+)/g)]
        .map(([, name]) => name!)
        .filter((name) => inputs.has(name))
      expect(truncated.length).toBeGreaterThan(0)
      expect(truncated.filter((name) => !inputs.get(name))).toEqual([])
    }
  })
  it('hands a custom fill its glyph index through a flat varying', async () => {
    // Callers truncate the ordinal to index per-glyph data, as Windfoil's own integers are.
    const fill: TextFill = ({ color, glyphIndex }) =>
      vec4(color.mul(glyphIndex), glyphIndex.mul(0.5))
    const read = async (layered: boolean, compositing: 'layers' | 'shader') =>
      Promise.all(
        ([false, true, 'pass'] as const).map(async (shadow) => {
          const shader = await generate(layered, compositing, shadow, fill)
          const index = /varyings\.vUltraFillIndex = ([^;]+);/.exec(shader.vertex)?.[1]
          return [
            index && bound(shader.vertex, index),
            /@location\( \d+ \) (@interpolate\( flat, either \) )?vUltraFillIndex : f32,/.exec(
              shader.fragment,
            )?.[1],
          ]
        }),
      )
    const flat = (index: string) =>
      Array.from({ length: 3 }, () => [index, '@interpolate( flat, either ) '])
    expect(await read(false, 'layers')).toEqual(flat('f32( instanceIndex )'))
    expect(await read(true, 'layers')).toEqual(flat('windfoilLayer.z'))
    // The compositor draws one quad per glyph and hands its fill the instance index.
    expect(await read(true, 'shader')).toEqual(flat('f32( instanceIndex )'))
  })
  it('builds the top-down compositor with one quad and shared clipping', async () => {
    const shader = await generate(true, 'shader')
    expect(shader.attributes).toContain('windfoilLayers')
    expect(shader.attributes.length).toBeLessThanOrEqual(7)
    expect(shader.fragment).toContain('windfoilComposite')
    // Each pixel walks its grid cell's top-down layer list, or every layer.
    expect(shader.fragment).toContain('windfoilGrid')
    expect(shader.fragment).toContain('windfoilCell')
    expect(shader.fragment).toContain('0.998')
    expect(shader.fragment.indexOf('discard;')).toBeLessThan(shader.fragment.indexOf('for ('))
  })
  it('omits gradient code and stop bindings for solid/foreground composite resources', async () => {
    const shader = await generate(true, 'shader', false, true, true, true)
    expect(shader.fragment).toContain('windfoilComposite')
    expect(shader.fragment).toContain('ultraWindfoilPaints')
    expect(shader.fragment).toContain('unpack4x8unorm')
    expect(shader.fragment).not.toContain('ultraWindfoilStops')
    expect(shader.fragment).not.toContain('atan2(')
    expect(shader.fragment.indexOf('discard;')).toBeLessThan(shader.fragment.indexOf('for ('))
  })
  it('keeps shadow loops clipped and independent of paint tables with foreground fill and cloning', async () => {
    const shadow = await generate(true, 'shader', true, true, true)
    expect(shadow.fragment).toContain('windfoilShadowUnion')
    expect(shadow.fragment).toContain('windfoilCell')
    expect(shadow.fragment).not.toContain('ultraWindfoilPaints')
    expect(shadow.fragment).not.toContain('ultraWindfoilStops')
    expect(shadow.fragment.indexOf('discard;')).toBeLessThan(shadow.fragment.indexOf('for ('))
    expect(shadow.attributes.length).toBeLessThanOrEqual(7)
    const beauty = await generate(true, 'layers', false, true, true)
    expect(beauty.attributes).toContain('windfoilLayer')
    expect(beauty.fragment).toContain('ultraWindfoilPaints')
  })
  it('pads the quad by the pass skirt along each glyph axis', async () => {
    // |screenY| and |screenX| over the determinant: the lengths of the two glyph-axis gradients.
    // Their scale is the skirt of the pass being drawn, never a literal fixed at compile time.
    const padding =
      /vec2<f32>\( length\( (\w+) \), length\( (\w+) \) \) \* vec2<f32>\( \( render\.ultraWindfoilSkirt \/ max\( abs\( \( \( \2\.x \* \1\.y \) - \( \2\.y \* \1\.x \) \) \), 1e-12 \) \) \)/
    // Text, its shadow mask, layered glyphs and the colour composite share the one extension.
    for (const shader of [
      await generate(false),
      await generate(false, 'layers', true),
      await generate(true),
      await generate(true, 'shader'),
      await generate(true, 'shader', true),
    ]) {
      expect(shader.vertex).toMatch(padding)
      expect(shader.vertex.split('ultraWindfoilSkirt : f32').length - 1).toBe(1)
      expect(shader.vertex).not.toMatch(/0\.5625|0\.9375/)
      expect(shader.fragment).not.toContain('ultraWindfoilSkirt')
    }
  })
  it('shares one skirt uniform that follows the sample count of the pass being drawn', () => {
    const skirt = windfoilKernelSkirt()
    expect(windfoilKernelSkirt()).toBe(skirt)
    expect(skirt.groupNode).toBe(renderGroup)
    expect(skirt.updateType).toBe('render')
    // What three's renderer reports during a pass: its own count, the render target the pass
    // draws into and the output render target, each with its count.
    const during = (pass: { own: number; target?: number; output?: number } | null) => {
      const renderer = pass && {
        // As three computes it: the render target's count, else the renderer's own.
        currentSamples: pass.target ?? pass.own,
        getRenderTarget: () => (pass.target === undefined ? null : { samples: pass.target }),
        getOutputRenderTarget: () => (pass.output === undefined ? null : { samples: pass.output }),
      }
      skirt.update({ renderer } as never)
      return skirt.value
    }
    // A 4-sample pass must hold every sample of each pixel that can hold ink.
    for (const samples of [4, 8]) expect(during({ own: samples })).toBe(0.9375)
    // WebGPU draws every lower count single-sampled: half the integration box is enough.
    for (const samples of [0, 1, 2, 3]) expect(during({ own: samples })).toBe(0.5625)
    // A render target decides for its own pass, whatever the renderer's count.
    expect(during({ own: 0, target: 4 })).toBe(0.9375)
    expect(during({ own: 4, target: 0 })).toBe(0.5625)
    // So does an output render target the pass draws straight into.
    expect(during({ own: 0, output: 4 })).toBe(0.9375)
    expect(during({ own: 4, output: 0 })).toBe(0.5625)
    // Behind three's frame buffer target, the pass is that target's.
    expect(during({ own: 0, target: 0, output: 4 })).toBe(0.5625)
    expect(during(null)).toBe(0.5625)
  })
  it('leaves no trace of the tone in the graph with tone: false', async () => {
    const shader = await generate(false, 'layers', false, false, false, false, false)
    // The analytic shader as it was before the tone existed (its skirt is since a uniform).
    expect(
      createHash('sha256')
        .update(shader.vertex + '\0' + shader.fragment)
        .digest('hex'),
    ).toBe('6cb8c805984e34c0af9c9f05e026fc73f311c47f2fc84a502d66893391601709')
    expect(shader.vertex + shader.fragment).not.toContain('vUltraTextTone')
  })
  it('tones text ink by default and never in a shadow mask', async () => {
    const luminance = '0.2126, 0.7152, 0.0722'
    const cubic = '0.305306011'
    const off = [false, 'layers', false, false, false, false, false] as const
    const exact = await generate(...off)
    const toned = await generate(false)
    expect(exact.vertex + exact.fragment).not.toContain(luminance)
    expect(exact.fragment).not.toContain(cubic)
    // The per-glyph terms come from the instance colour in the vertex stage, through one
    // flat varying; the fragment only evaluates the cubic.
    const linear = new RegExp(
      String.raw`dot\( vec4<f32>\( ${srgbToLinear(toned.vertex)}\( (\w+(?:\.\w+)?) \)`,
    )
    expect(bound(toned.vertex, linear.exec(toned.vertex)?.[1] ?? '')).toBe('sdfColor.xyz')
    expect(toned.vertex.split(luminance).length - 1).toBe(1)
    expect(toned.fragment).toContain('@interpolate( flat, either ) vUltraTextTone : vec3<f32>')
    expect(toned.fragment).not.toContain(luminance)
    // The step across the backdrop is taken for the mask times the ink's own alpha, and the
    // product of the factor and that alpha is clamped as one.
    const inkAlpha = String.raw`\( vUltraTextColor\.w \* vUltraTextMotionAlpha \)`
    expect(toned.fragment).toMatch(
      new RegExp(String.raw`= \( vUltraTextTone\.x \* \( nodeConst\d+ \* ${inkAlpha} \) \);`),
    )
    expect(toned.fragment).toMatch(
      /= min\( 1\.0, \( \( \( nodeConst\d+ \* \( object\.nodeUniform\d+\.z \+ .* \* vUltraTextColor\.w \) \* vUltraTextMotionAlpha \) \);/,
    )
    expect(exact.fragment).not.toMatch(new RegExp(inkAlpha))
    expect(toned.fragment.split(cubic).length - 1).toBe(1)
    // A fill graph supplies the ink per fragment, so its terms are computed there instead.
    const filled = await generate(false, 'layers', false, true)
    expect(filled.fragment).toMatch(
      /dot\( vec4<f32>\( 0\.0, 1\.0, 0\.0, 0\.75 \)\.xyz, vec3<f32>\( 0\.2126/,
    )
    expect(filled.vertex + filled.fragment).not.toContain('vUltraTextTone')
    const shadow = await generate(false, 'layers', true)
    expect(shadow).toEqual(await generate(false, 'layers', true, false, false, false, false))
    // Layered glyphs: foreground text ink only, with colour layers and shadows left exact.
    const layers = await generate(true)
    expect(layers.fragment.split(cubic).length - 1).toBe(1)
    const layeredShadow = await generate(true, 'layers', true)
    expect(layeredShadow.vertex + layeredShadow.fragment).not.toContain(cubic)
    expect(layeredShadow).toEqual(await generate(true, 'layers', true, false, false, false, false))
    // The composite of colour layers never tones.
    expect(await generate(true, 'shader')).toEqual(
      await generate(true, 'shader', false, false, false, false, false),
    )
  })
  it('keeps one shader text for the outline and Windows models, any backdrop and strength', async () => {
    const model = (tone: TextToneOptions) =>
      generate(false, 'layers', false, false, false, false, tone)
    const outline = await model({ model: 'outline' })
    expect(await generate(false)).toEqual(outline)
    expect(await model({ model: 'windows' })).toEqual(outline)
    expect(await model({ model: 'windows', backdrop: '#101010', strength: 0.4 })).toEqual(outline)
    const layered = (tone: TextToneOptions) =>
      generate(true, 'layers', false, true, false, false, tone)
    expect(await layered({ model: 'windows' })).toEqual(await layered({ model: 'outline' }))
  })
  it('dilates the outline in the macOS model alone, from the font size each instance carries', async () => {
    const macos: TextToneOptions = { model: 'macos' }
    const model = (
      tone: TextToneOptions,
      sized = false,
      shadow: boolean | 'pass' = false,
      layered = false,
    ) => generate(layered, 'layers', shadow, false, false, false, tone, sized)
    const exact = await model({ model: 'outline' }, true)
    expect(exact.vertex + exact.fragment).not.toContain('vUltraWindfoilDilation')
    const shader = await model(macos, true)
    // The law, the backdrop and the strength are uniforms: the model has one shader text.
    expect(await model({ model: 'macos', backdrop: '#101010', strength: 0.4 }, true)).toEqual(
      shader,
    )
    // The em is the third component of `sdfMeta`: no vertex buffer is added for it, and a
    // geometry that carries none reads as text of no size.
    expect(shader.attributes).toEqual(exact.attributes)
    expect(shader.vertex).toContain('abs( sdfMeta.z )')
    expect((await model(macos)).vertex).toContain('abs( vec3<f32>( sdfMeta, 0.0 ).z )')

    // d = min(ems x pixels per em, pixel limit), below zero from half a pixel under the size
    // where the model stops; the quad grows by d over the skirt of the pass.
    const law =
      /let (\w+) = mix\( -1\.0, min\( \( (\w+) \* object\.(\w+)\.x \), object\.\3\.y \), step\( \2, \( object\.\3\.z - 0\.5 \) \) \);\n\tvaryings\.vUltraWindfoilDilation = \1;\n\tlet (\w+) = max\( \1, 0\.0 \);/.exec(
        shader.vertex,
      )
    expect(law).not.toBeNull()
    expect(shader.vertex).toContain(`( render.ultraWindfoilSkirt + ${law![4]} )`)
    expect(shader.vertex).not.toMatch(/0\.5625|0\.9375/)

    // The fragment integrates a box 2d larger, sampled d lower on screen, and divides by one
    // growth; the ink-profile test keeps the pixel's own size.
    const box =
      /let (\w+) = max\( vUltraWindfoilDilation, 0\.0 \);\n\tlet (\w+) = \( \( \1 \* 2\.0 \) \+ 1\.0 \);\n\t(?:let )?\w+ = dpdx\( vUltraWindfoilPosition \);\n\t(?:let )?(\w+) = - dpdy\( vUltraWindfoilPosition \);\n\t(?:let )?(\w+) = max\( vec2<f32>\( length/.exec(
        shader.fragment,
      )
    expect(box).not.toBeNull()
    const [, amount, growth, down, pixel] = box!
    expect(shader.fragment).toContain(`( ${pixel} * vec2<f32>( ${growth} ) )`)
    expect(shader.fragment).toContain(
      `( vUltraWindfoilPosition - ( ${down} * vec2<f32>( ${amount} ) ) )`,
    )
    expect(shader.fragment).toContain(`if ( all( ( ( ${pixel} * vec2<f32>( 3.7 ) ) >= `)
    expect(shader.fragment).toContain(
      `abs( ( windfoilIntegral / ( ( ${pixel}.x * ${pixel}.y ) * ${growth} ) ) )`,
    )
    // The model's table stops with its dilation.
    expect(shader.fragment).toContain('( vUltraTextTone.z * step( 0.0, vUltraWindfoilDilation ) )')

    // A shadow silhouette is the exact outline: its fragment declares the varying its vertex
    // stage writes and never reads it.
    const shadow = await model(macos, true, true)
    expect(shadow.fragment.split('vUltraWindfoilDilation').length - 1).toBe(1)
    expect(shadow.fragment).toMatch(/abs\( \( windfoilIntegral \/ \( \w+\.x \* \w+\.y \) \) \)/)

    // Three multiplies a shadow map's silhouette by the beauty alpha: the pass still
    // integrates once, over the pixel's own box.
    const warn = vi.spyOn(console, 'warn')
    const pass = await model(macos, true, 'pass')
    expect(warn).not.toHaveBeenCalled()
    expect(pass.fragment.split('var<private> windfoilIntegral').length - 1).toBe(1)
    expect(pass.fragment).toMatch(/abs\( \( windfoilIntegral \/ \( \w+\.x \* \w+\.y \) \) \)/)
    expect(pass.fragment).not.toContain('max( vUltraWindfoilDilation, 0.0 )')
    // The conversion is for the beauty pass: none of it reaches a shadow map.
    expect(pass.fragment).not.toContain('0.305306011')
    expect(pass.vertex + pass.fragment).not.toContain('vUltraTextTone')

    // Colour layers of layered geometry have no size: only text ink dilates.
    const layered = await model(macos, true, false, true)
    expect(layered.vertex).toContain('( abs( sdfMeta.z ) * step( windfoilLayer.w, 0.25 ) )')
    expect(layered.attributes.length).toBeLessThanOrEqual(8)
  })
  it('keeps the tone out of the shadow pass three derives, which evaluates each paint once', async () => {
    // Three multiplies a shadow map's silhouette by the alpha of the colour graph.
    const warn = vi.spyOn(console, 'warn')
    const pass = (
      layered: boolean,
      fill: boolean,
      solidOnly: boolean,
      tone?: TextToneOptions | false,
    ) => generate(layered, 'layers', 'pass', fill, false, solidOnly, tone)
    for (const [layered, fill, solidOnly] of [
      [false, false, false],
      [false, true, false],
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ] as const) {
      const toned = await pass(layered, fill, solidOnly)
      const text = toned.vertex + toned.fragment
      expect(text).not.toContain('vUltraTextTone')
      expect(text).not.toContain('0.305306011')
      // One integral and one paint: a second copy would be declared under a renamed name.
      expect(text).not.toMatch(/windfoil\w+_1\b/)
      expect(await pass(layered, fill, solidOnly, { model: 'windows', backdrop: '#000' })).toEqual(
        toned,
      )
      // With paint functions the pass draws the exact paint: the text of a material without tone.
      if (layered && !solidOnly) expect(await pass(layered, fill, solidOnly, false)).toEqual(toned)
    }
    expect(warn).not.toHaveBeenCalled()
  })
  it('pins the default shadow-mask graph', async () => {
    const shadow = await generate(false, 'layers', true)
    expect(
      createHash('sha256')
        .update(shadow.vertex + '\0' + shadow.fragment)
        .digest('hex'),
    ).toBe('942a15fd958f15b023ee4705f819c3014dee635ac0a524eddccda880d7a2e573')
  })
})
