import { createHash } from 'node:crypto'
import {
  GLSLNodeBuilder,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  Scene,
  Texture,
  WebGPURenderer,
  WGSLNodeBuilder,
  type Material,
  type Node,
} from 'three/webgpu'
import { vec3, vec4 } from 'three/tsl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SdfTextMaterial, type SdfTextMaterialOptions } from '../src/text/SdfTextMaterial.js'
import { createGlyphGeometry } from '../src/text/geometry.js'
import type { DomLayoutSnapshot, SdfAtlas, TextFill, TextVertex } from '../src/types.js'
import baseline from './fixtures/sdf-shader-baseline.json'
import { readyForShaderGeneration } from './helpers/shader-renderer.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
// The intended changes since the baseline, written back as recorded: the UV footprint became
// the length of each axis's screen gradient instead of `fwidth()`, which read text turned in
// its plane up to √2 small; its floor dropped from 1e-5 to 1e-9 (1e-18 on the squared
// gradient), which had blurred edges under strong magnification; and the coverage ramp became
// linear with its foot at zero instead of a smoothstep around zero.
const asRecorded = (shader: string) =>
  shader
    .replaceAll(
      'inverseSqrt( max( ( ( dpdx( vUltraSdfUv ) * dpdx( vUltraSdfUv ) ) + ( - dpdy( vUltraSdfUv ) * - dpdy( vUltraSdfUv ) ) ), vec2<f32>( 1e-18 ) ) )',
      '( vec2<f32>( 1.0, 1.0 ) / max( fwidth( vUltraSdfUv ), vec2<f32>( 1e-9 ) ) )',
    )
    .replaceAll(
      'inversesqrt( max( ( ( dFdx( vUltraSdfUv ) * dFdx( vUltraSdfUv ) ) + ( dFdy( vUltraSdfUv ) * dFdy( vUltraSdfUv ) ) ), 1e-18 ) )',
      '( vec2( 1.0, 1.0 ) / max( fwidth( vUltraSdfUv ), 1e-9 ) )',
    )
    .replaceAll(/(fwidth\( vUltraSdfUv \), (?:vec2<f32>\( )?)1e-9\b/g, '$10.00001')
    .replaceAll(
      /((?:dpd[xy]|dFd[xy])\( vUltraSdfUv \) \* (?:vec2(?:<f32>)?\( )?)0\.125\b/g,
      '$10.25',
    )
    .replaceAll(/\( (\w+) \* (?:vec2(?:<f32>)?\( )?3\.0(?: \))? \)/g, '$1')
    .replaceAll(
      /min\( \( \( (\w+) \+ 0\.5 \) - (\( \w+ \* .+? \)) \), 0\.0 \)/g,
      'min( ( $1 - $2 ), -0.5 )',
    )
    .replaceAll(
      /clamp\( (\( \( \w+ \* \w+\.[xr] \) \+ \w+ \)), 0\.0, 1\.0 \)/g,
      'smoothstep( -0.5, 0.5, $1 )',
    )
const configurations: Partial<SdfTextMaterialOptions>[] = [
  {},
  { outline: { width: 1 }, dropShadow: {} },
  // Re-recorded when the fill index became a flat varying, which a shader carries only when its
  // fill reads `glyphIndex`: this one does not.
  { fill: ({ uv, color }) => vec4(color.mul(uv.x), 1) },
  { quality: 'high' },
  { textShaping: 'browser' },
  { quality: 'high', outline: { width: 1 }, dropShadow: {} },
  { quality: 'high', outline: { width: 0 }, fill: ({ color }) => vec4(color, 0) },
  {
    quality: 'high',
    outline: { width: 1 },
    dropShadow: {},
    fill: ({ uv, color }) => vec4(color, uv.x.greaterThan(0.5).select(1, 0)),
  },
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

interface Variant {
  webgl?: boolean
  /** `true`: the material's own shadow mask. `'pass'`: the shader three derives for a shadow map. */
  shadow?: boolean | 'pass'
  /** Adds a companion colour band below the glyph's cell. */
  layer?: boolean
  /**
   * Rows of monochrome shapes from row 16 down: named through the material's `shapeTop`, as
   * a caller passes `SdfAtlas.shapeTop`, or `'texture'` for the tag `buildSdfAtlas` leaves on
   * the atlas texture.
   */
  shapes?: boolean | 'texture'
  /** Draws a geometry without `sdfTrim`, as a custom geometry would be: whole quads. */
  untrimmed?: boolean
  /** An atlas sampled through mipmaps, as `buildSdfAtlas` makes one with `mipmaps: true`. */
  mipmaps?: boolean
  /** The text material draws wireframe, as an inspector's toggle sets it. */
  wireframe?: boolean
}

/** A texture sampled at level 0, as `buildSdfAtlas` makes one by default. */
const levelZero = (): Texture =>
  Object.assign(new Texture(), { generateMipmaps: false, minFilter: LinearFilter })

/** Generated vertex and fragment text of one material configuration. */
function generate(options: Partial<SdfTextMaterialOptions>, variant: Variant = {}) {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  const renderer = readyForShaderGeneration(
    new WebGPURenderer({
      canvas: document.createElement('canvas'),
      forceWebGL: variant.webgl === true,
    }),
  )
  vi.spyOn(renderer, 'hasFeature').mockReturnValue(false)
  const atlas: SdfAtlas = {
    // The atlas `buildSdfAtlas` returns by default: level 0 only.
    texture: Object.assign(new Texture(), {
      generateMipmaps: variant.mipmaps === true,
      minFilter: variant.mipmaps === true ? LinearMipmapLinearFilter : LinearFilter,
    }),
    width: 64,
    height: 64,
    bakeSize: 32,
    pxRange: 12,
    mode: 'cpu',
    dispose: vi.fn(),
    glyphs: new Map([
      [
        'A',
        {
          key: 'A',
          character: 'A',
          fontKey: 'face',
          u0: 0,
          v0: 0,
          u1: 1,
          v1: variant.layer ? 0.4 : 1,
          planeX0: 0,
          planeY0: 0,
          planeX1: 24,
          planeY1: 32,
          descent: 0,
          advance: 24,
        },
      ],
    ]),
  }
  const snapshot: DomLayoutSnapshot = {
    ...(options.textShaping === 'browser' ? { textShaping: 'browser' } : {}),
    width: 64,
    height: 64,
    lineCount: 1,
    atlasSignature: 'A',
    glyphs: [
      {
        glyphKey: 'A',
        fontSize: 32,
        originX: 0,
        lineBottom: 0,
        advance: 24,
        block: 0,
        breakBefore: 'none',
        clip: [0, 0, 64, 64],
        color: [1, 1, 1, 1],
        sequence: 0,
        z: 0,
      },
    ],
    blocks: [],
    rects: [],
    requests: [],
  }
  const geometry = createGlyphGeometry(snapshot, atlas, 0).geometry
  if (variant.untrimmed) geometry.deleteAttribute('sdfTrim')
  if (variant.shapes === 'texture') atlas.texture.userData['ultraShapeTop'] = 16
  const layer = variant.layer ? new Texture() : null
  const material = new SdfTextMaterial({
    atlas: atlas.texture,
    atlasWidth: 64,
    atlasHeight: 64,
    pxRange: 12,
    ...(variant.shapes === true ? { shapeTop: 16 } : {}),
    ...(layer ? { colorLayer: { texture: layer, top: 32, height: 32 } } : {}),
    ...options,
  })
  material.wireframe = variant.wireframe === true
  let selected: Material = material
  if (variant.shadow === 'pass') {
    const nodes = (
      renderer as unknown as {
        _getShadowNodes(source: Material): {
          colorNode: Node<'vec4'> | null
          positionNode: Node<'vec3'> | null
        }
      }
    )._getShadowNodes(material)
    const pass = new MeshBasicNodeMaterial()
    ;(pass as { isShadowPassMaterial?: boolean }).isShadowPassMaterial = true
    pass.colorNode = nodes.colorNode
    pass.positionNode = nodes.positionNode
    selected = pass
  } else if (variant.shadow) {
    material.colorNode = vec4(1)
    material.maskNode = material.maskShadowNode
    material.positionNode = material.castShadowPositionNode
  }
  const mesh = new Mesh(geometry, selected)
  const scene = new Scene()
  scene.add(mesh)
  const Builder = variant.webgl ? GLSLNodeBuilder : WGSLNodeBuilder
  const builder = new Builder(mesh, renderer) as unknown as {
    scene: Scene
    camera: OrthographicCamera
    material: Material
    context: { material: Material }
    build(): void
    vertexShader: string
    fragmentShader: string
  }
  builder.scene = scene
  builder.camera = new OrthographicCamera(0, 64, 64, 0, 0.1, 100)
  builder.material = selected
  builder.context.material = selected
  try {
    builder.build()
    return { vertex: builder.vertexShader, fragment: builder.fragmentShader }
  } finally {
    geometry.dispose()
    material.dispose()
    if (selected !== material) selected.dispose()
    atlas.texture.dispose()
    layer?.dispose()
    vi.spyOn(renderer, 'setAnimationLoop').mockResolvedValue(undefined)
    void renderer.dispose()
  }
}

/**
 * The value a generated `target = …;` statement assigns, through the `let` three r187 binds a
 * value read more than once to.
 */
function assigned(shader: string, target: string): string | undefined {
  const value = new RegExp(`^\\s*${target.replaceAll('.', '\\.')} = (.*);$`, 'm').exec(shader)?.[1]
  if (value === undefined || !/^\w+$/.test(value)) return value
  return new RegExp(`^\\s*let ${value} = (.*);$`, 'm').exec(shader)?.[1] ?? value
}

/** Names declared twice by `let` in one WGSL scope, which no compiler accepts. */
function redeclared(shader: string): string[] {
  const scopes = [new Set<string>()]
  const duplicates: string[] = []
  for (const token of shader.matchAll(/[{}]|\blet\s+([A-Za-z_]\w*)/g)) {
    if (token[0] === '{') scopes.push(new Set())
    else if (token[0] === '}') scopes.pop()
    else {
      const scope = scopes.at(-1)!
      if (scope.has(token[1]!)) duplicates.push(token[1]!)
      scope.add(token[1]!)
    }
  }
  return duplicates
}

/** The value a generated local is declared with: by `let` in WGSL, by its type in GLSL. */
function declared(shader: string, name: string): string | undefined {
  return new RegExp(`^\\s*(?:let|float|bool) ${name} = (.*);$`, 'm').exec(shader)?.[1]
}

describe('SDF no-colour shader compatibility with the pre-emoji baseline', () => {
  // Hashes of the spelling of the three release in the fixture's `three`: re-recorded when only
  // three's code generation changed the text of the same shaders.
  const cases = [
    ...baseline.cases,
    ...[false, true].flatMap((webgl) =>
      [5, 6, 7].flatMap((index) =>
        [false, true].map((shadow) => ({ webgl, index, shadow, vertex: '', fragment: '' })),
      ),
    ),
  ]
  for (const recorded of cases)
    it(`${recorded.webgl ? 'GLSL' : 'WGSL'} configuration ${recorded.index}, ${recorded.shadow ? 'shadow' : 'beauty'}`, () => {
      // Without a tone the graph is the recorded one: no varying, no uniform, no local of it.
      // A geometry without `sdfTrim` keeps whole quads, and the vertex stage it always had.
      const shader = generate(
        { ...configurations[recorded.index]!, tone: false },
        { ...recorded, untrimmed: true },
      )
      if (recorded.vertex && !(recorded.index === 1 && !recorded.webgl))
        expect(hash(shader.vertex)).toBe(recorded.vertex)
      // The original effects hashes contain an invalid same-scope WGSL let
      // redeclaration. Preserve every other baseline hash, while testing those
      // effects explicitly for the compiler failure instead of blessing it.
      // WGSL shares its uniform layout across stages, so fixing fragment locals
      // also reorders effect-only vertex uniforms. GLSL vertices remain exact.
      // GLSL configuration 1 was re-recorded when the fill and the outline's silhouette came to
      // read each tap once: one sample per tap gives both contours, and the texture's flip
      // uniform moved after the effect colours in the block both stages share.
      if (recorded.fragment && !(recorded.index === 1 && !recorded.webgl))
        expect(hash(asRecorded(shader.fragment))).toBe(recorded.fragment)
      if (!recorded.webgl) expect(redeclared(shader.fragment)).toEqual([])
    })
})

describe('SDF shader text by tone', () => {
  const shapes: [string, Partial<SdfTextMaterialOptions>, Variant][] = [
    ['plain text', {}, {}],
    ['high quality', { quality: 'high' }, {}],
    ['an outline and a drop shadow', { outline: { width: 1 }, dropShadow: {} }, {}],
    ['a fill', { fill: ({ uv, color }) => vec4(color.mul(uv.x), 1) }, {}],
    ['a colour layer', {}, { layer: true }],
    ['a colour layer with effects', { outline: { width: 1 }, dropShadow: {} }, { layer: true }],
    ['shape rows', {}, { shapes: true }],
    [
      'shape rows above a colour layer, with effects',
      { quality: 'high', outline: { width: 1 }, dropShadow: {} },
      { layer: true, shapes: true },
    ],
  ]
  const tones: [string, SdfTextMaterialOptions['tone']][] = [
    ['default', undefined],
    ['outline', { model: 'outline' }],
    ['windows', { model: 'windows' }],
    ['dark', { model: 'outline', backdrop: '#000', strength: 0.5 }],
    ['macos', { model: 'macos' }],
    ['off', false],
  ]
  const texts = (
    options: Partial<SdfTextMaterialOptions>,
    variant: Variant,
  ): Record<string, string> =>
    Object.fromEntries(
      tones.map(([name, tone]) => {
        const shader = generate({ ...options, ...(tone === undefined ? {} : { tone }) }, variant)
        return [name, `${shader.vertex}\n${shader.fragment}`]
      }),
    )

  for (const webgl of [false, true])
    it.each(shapes)(
      `${webgl ? 'GLSL' : 'WGSL'}: one text for outline and Windows, more only for macOS, with %s`,
      (_, options, variant) => {
        const beauty = texts(options, { ...variant, webgl })
        // Compatibility-mode devices reject a flat varying that takes the default first vertex.
        if (!webgl) {
          for (const [name, text] of Object.entries(beauty))
            expect(text, name).not.toMatch(/@interpolate\( flat \)/)
          if (variant.shapes)
            expect(beauty['default']).toContain('@interpolate( flat, either ) vUltraShapeGlyph')
        }
        // Recorded pipelines replay on every platform: only the macOS model may add text.
        expect(beauty['outline']).toBe(beauty['default'])
        expect(beauty['windows']).toBe(beauty['default'])
        expect(beauty['dark']).toBe(beauty['default'])
        expect(beauty['macos']).not.toBe(beauty['default'])
        expect(beauty['off']).not.toBe(beauty['default'])
        // The ink terms ride one flat varying, unless a fill supplies the ink per fragment.
        expect(beauty['default']!.includes('vUltraTextTone')).toBe(!options.fill)
        expect(beauty['off']).not.toContain('vUltraTextTone')
        // A shadow map never sees the tone, the dilation or the rise.
        const cast = texts(options, { ...variant, webgl, shadow: true })
        for (const [name] of tones) expect(cast[name], name).toBe(cast['off'])
        expect(cast['off']).not.toContain('vUltraTextTone')
        // Three multiplies that map's silhouette by the alpha of the colour graph. The pass
        // it derives reads the silhouette there too: one text whatever the tone, the macOS
        // model included, with none of the conversion, the dilation or the rise.
        const pass = texts(options, { ...variant, webgl, shadow: 'pass' })
        for (const [name] of tones) {
          expect(pass[name], name).toBe(pass['off'])
          expect(pass[name], name).not.toContain('vUltraTextTone')
          expect(pass[name], name).not.toContain('0.305306011')
        }
      },
    )

  // [what is drawn, options, variant, texture lookups of the beauty pass, of a shadow pass]
  it.each([
    ['plain text', {}, {}, 1, 1],
    ['the macOS model', { tone: { model: 'macos' } }, {}, 1, 1],
    ['high quality', { quality: 'high' }, {}, 4, 1],
    ['high quality in the macOS model', { quality: 'high', tone: { model: 'macos' } }, {}, 4, 1],
    // A shadow map holds the fill's silhouette and its outline ring; a drop shadow casts none.
    // The beauty pass reads each of the fill's four taps once for the outline's silhouette too,
    // and four more for the drop shadow.
    [
      'effects at high quality',
      { quality: 'high', outline: { width: 1 }, dropShadow: {} },
      {},
      8,
      2,
    ],
    ['an outline', { outline: { width: 1 } }, {}, 1, 2],
    ['a colour layer', {}, { layer: true }, 2, 1],
    ['shape rows above a colour layer', {}, { layer: true, shapes: true }, 2, 1],
  ] as [string, Partial<SdfTextMaterialOptions>, Variant, number, number][])(
    'evaluates only the shadow coverage in a shadow pass of %s',
    (_, options, variant, beautyLookups, lookups) => {
      const sampled = (shader: string): number =>
        shader.match(/= textureSample(Grad)?\(/g)?.length ?? 0
      const pass = generate(options, { ...variant, shadow: 'pass' }).fragment
      // As many field lookups as the shadow mask alone, and never the colour band's texels.
      expect(sampled(generate(options, variant).fragment)).toBe(beautyLookups)
      expect(sampled(pass)).toBe(lookups)
      expect(sampled(generate(options, { ...variant, shadow: true }).fragment)).toBe(lookups)
      expect(pass.match(/var \w+ : texture_2d<f32>;/g)).toHaveLength(1)
      // No sample at a raised or offset position, and no trace of the beauty graph's inputs.
      expect(pass).not.toMatch(/dpdy\( vUltraSdfUv \) \* vec2<f32>\( \w+ \) \) \)/)
      expect(pass).not.toContain('vUltraShapeGlyph')
      expect(redeclared(pass)).toEqual([])
    },
  )

  it.each(shapes)('declares each WGSL local once with %s', (_, options, variant) => {
    for (const [, tone] of tones) {
      const shader = generate({ ...options, ...(tone === undefined ? {} : { tone }) }, variant)
      expect(redeclared(shader.fragment)).toEqual([])
    }
  })

  it('keeps one text whether or not a threshold is passed', () => {
    for (const layer of [false, true]) {
      const implicit = generate({}, { layer })
      const explicit = generate({ threshold: 0.47, stemDarkening: 0.2 }, { layer })
      expect(explicit).toEqual(implicit)
    }
  })

  it('flags shape rows in every toned beauty pass that may trim, with or without shapes', () => {
    for (const layer of [false, true]) {
      const toned = generate({}, { layer, shapes: true })
      expect(toned.vertex).toContain('vUltraShapeGlyph')
      expect(toned.fragment).toContain('vUltraShapeGlyph')
      // The row is a uniform: another one is the same text.
      expect(generate({ shapeTop: 40 }, { layer })).toEqual(toned)
      // A texture straight from `buildSdfAtlas` names the same rows without the option.
      expect(generate({}, { layer, shapes: 'texture' })).toEqual(toned)
      // An atlas without shapes (`undefined` is no row) puts the row below the atlas, where
      // the flag is 0: the same text again, so pages mixing both share one pipeline.
      expect(generate({ shapeTop: undefined }, { layer })).toEqual(toned)
      expect(generate({}, { layer })).toEqual(toned)
      // Without a tone, and in a shadow map, there is no flag at all.
      const untoned = generate({ tone: false }, { layer, shapes: true })
      expect(untoned).toEqual(generate({ tone: false }, { layer }))
      expect(`${untoned.vertex}\n${untoned.fragment}`).not.toContain('vUltraShapeGlyph')
      const cast = generate({}, { layer, shapes: true, shadow: true })
      expect(cast).toEqual(generate({}, { layer, shadow: true }))
      expect(`${cast.vertex}\n${cast.fragment}`).not.toContain('vUltraShapeGlyph')
      // Whole quads keep the text without the flag unless the atlas has shapes: there it would
      // cost every fragment and repay nothing. Mipmaps, effects and run motion draw them.
      for (const [options, variant] of [
        [{}, { mipmaps: true }],
        [{ quality: 'high' }, { mipmaps: true }],
        [{ outline: { width: 1 } }, {}],
        [{ dropShadow: {} }, {}],
        [{ textShaping: 'browser' }, {}],
      ] as [Partial<SdfTextMaterialOptions>, Variant][]) {
        const whole = generate(options, { ...variant, layer })
        expect(`${whole.vertex}\n${whole.fragment}`).not.toContain('vUltraShapeGlyph')
        expect(generate(options, { ...variant, layer, shapes: true }).fragment).toContain(
          'vUltraShapeGlyph',
        )
      }
    }
  })

  it('puts the shape row of an atlas without shapes below its last texel row', () => {
    const material = new SdfTextMaterial({
      atlas: levelZero(),
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
    })
    const shaped = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      shapeTop: 16,
    })
    // Three's default texture samples through mipmaps: whole quads, and no flag without shapes.
    const mipmapped = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
    })
    const rows = (target: SdfTextMaterial): number[] => {
      const values: number[] = []
      target.colorNode?.traverse((node) => {
        const value = (node as { isUniformNode?: boolean; value?: unknown }).value
        if ((node as { isUniformNode?: boolean }).isUniformNode && typeof value === 'number')
          values.push(value)
      })
      return values
    }
    try {
      // The flag is step(row, v) over v in [0, 1]: (64 + 0.5) / 64 lies above every glyph.
      expect(rows(material)).toContain(64.5 / 64)
      expect(rows(shaped)).toContain(16.5 / 64)
      expect(rows(mipmapped)).not.toContain(64.5 / 64)
    } finally {
      material.dispose()
      shaped.dispose()
      mipmapped.dispose()
    }
  })

  it('reads the macOS dilation only in the fragment stage of that model', () => {
    const { vertex, fragment } = generate({ tone: { model: 'macos' } })
    const plain = generate({})
    // The rise samples the field through a screen-space derivative of the glyph UV: one more
    // than the two the footprint squares in every model.
    expect(plain.fragment.match(/dpdy\( vUltraSdfUv \)/g)).toHaveLength(2)
    expect(fragment.match(/dpdy\( vUltraSdfUv \)/g)).toHaveLength(3)
    // The same varyings as the other models: nothing of it is computed per vertex. The dilation
    // reads the shape flag first, which only moves that varying's location.
    const varyings = (shader: string) =>
      (shader.match(/@location\( \d+ \).*/g) ?? [])
        .map((line) => line.replace(/@location\( \d+ \) /, ''))
        .sort()
    expect(varyings(vertex)).toEqual(varyings(plain.vertex))
  })

  it('supersamples high-quality contours over a 4-rook rotated grid (±1/8, ±3/8 px)', () => {
    const high = generate({ quality: 'high' }).fragment
    expect(high).toMatch(/dpdx\( vUltraSdfUv \) \* vec2<f32>\( 0\.125 \)/)
    expect(high).toMatch(/dpdy\( vUltraSdfUv \) \* vec2<f32>\( 0\.125 \)/)
    expect(high.match(/\* vec2<f32>\( 3\.0 \)/g)).toHaveLength(4)
  })

  it("measures the footprint by the length of each UV axis's screen gradient", () => {
    // `fwidth()` is the footprint's bounding box: text turned in its plane read up to √2
    // smaller than it is, with a wider ramp and a size gate that moved with the angle.
    for (const webgl of [false, true]) {
      const plain = generate({}, { webgl })
      expect(plain.fragment).not.toContain('fwidth')
      expect(plain.fragment).toMatch(
        /inverse[sS]qrt\( max\( \( \( (\w+\( vUltraSdfUv \)) \* \1 \) \+ \( (-? ?\w+\( vUltraSdfUv \)) \* \2 \) \), (?:vec2<f32>\( )?1e-18(?: \))? \) \)/,
      )
      // Every derivative is written in place: a shared local would renumber the vertex stage's.
      expect(plain.fragment).not.toMatch(/(?:let|vec2) \w+ = -? ?(?:dpd|dFd)[xy]\( vUltraSdfUv \);/)
      // The recorded baseline holds the `fwidth()` form, with the same vertex stage.
      const whole = generate({ tone: false }, { webgl, untrimmed: true })
      expect(asRecorded(whole.fragment)).toContain('fwidth( vUltraSdfUv )')
    }
  })
})

describe('SDF quad trim', () => {
  // The fragment of a trimmed quad, up to the numbering of its locals and uniforms, which the
  // two stages share: the vertex stage's trim takes some of the numbers, and a uniform read
  // in both stages (the range, for a wider trim) is a member of the shared block twice.
  const locals = (shader: string): string => {
    const names = new Map<string, string>()
    return shader
      .replaceAll(
        /\n\s*(nodeUniform\d+ : \w+(<f32>)?,?|(float|vec\d|mat\d|u?int) nodeUniform\d+;)/g,
        '',
      )
      .replaceAll(/\b(nodeConst|nodeVar|nodeUniform)\d+/g, (name, kind: string) => {
        if (!names.has(name)) names.set(name, `${kind}#${String(names.size)}`)
        return names.get(name)!
      })
  }
  const plain: [string, Partial<SdfTextMaterialOptions>, Variant][] = [
    ['plain text', {}, {}],
    ['high quality', { quality: 'high' }, {}],
    ['the macOS model', { tone: { model: 'macos' } }, {}],
    ['a fill', { fill: ({ uv, color }) => vec4(color.mul(uv.x), 1) }, {}],
    ['a colour layer', {}, { layer: true }],
    ['no tone', { tone: false }, {}],
  ]

  it.each(plain)('trims the quad in the vertex stage alone with %s', (_, options, variant) => {
    for (const webgl of [false, true]) {
      const trimmed = generate(options, { ...variant, webgl })
      const whole = generate(options, { ...variant, webgl, untrimmed: true })
      // The geometry decides: its trim is read where it has one, and only per vertex.
      expect(trimmed.vertex).toContain('sdfTrim')
      expect(whole.vertex).not.toContain('sdfTrim')
      expect(locals(trimmed.fragment)).toBe(locals(whole.fragment))
      if (!webgl) expect(redeclared(trimmed.vertex)).toEqual([])
      // A shadow map is trimmed the same way, and samples nothing more for it.
      for (const shadow of [true, 'pass'] as const) {
        const cast = generate(options, { ...variant, webgl, shadow })
        expect(cast.vertex).toContain('sdfTrim')
        const wholeCast = generate(options, { ...variant, webgl, shadow, untrimmed: true })
        expect(locals(cast.fragment)).toBe(locals(wholeCast.fragment))
      }
    }
  })

  it('widens the trim for samples off the fragment, and never in a shadow map', () => {
    // Half the field's range in UV: the range uniform halved, over the slot's UV span.
    const widened = /\* vec2<f32>\( 0\.5 \) \) \/ abs\( /
    // 'high' reads the field a quarter pixel around the fragment: a wider trim, from the range
    // uniform (no atlas-size literal, so atlases of any size share the shader).
    expect(generate({ quality: 'high' }).vertex).toMatch(widened)
    expect(generate({ quality: 'high' }).vertex).not.toMatch(/0\.0078125|0\.015625/)
    // The macOS rise, under 0.006 em, is in the support box itself; plain text samples its own UV.
    expect(generate({ tone: { model: 'macos' } }).vertex).not.toMatch(widened)
    expect(generate({}).vertex).not.toMatch(widened)
    for (const shadow of [true, 'pass'] as const)
      expect(generate({ quality: 'high' }, { shadow }).vertex).toBe(generate({}, { shadow }).vertex)
  })

  it('keeps whole quads over a mipmapped atlas, whose levels blur past the support box', () => {
    for (const quality of ['standard', 'high'] as const) {
      const blurred = generate({ quality }, { mipmaps: true })
      expect(blurred.vertex).not.toContain('sdfTrim')
      expect(blurred).toEqual(generate({ quality }, { mipmaps: true, untrimmed: true }))
    }
  })

  it('keeps whole quads with effects, which reach past the cell, and with run motion', () => {
    for (const options of [
      { outline: { width: 1 } },
      { dropShadow: {} },
      { textShaping: 'browser' },
    ] as Partial<SdfTextMaterialOptions>[]) {
      const shader = generate(options)
      expect(shader.vertex).not.toContain('sdfTrim')
    }
  })

  it('shares the position graph between beauty and shadow, built once per pass', () => {
    const atlas = levelZero()
    const material = new SdfTextMaterial({ atlas, atlasWidth: 64, atlasHeight: 64, pxRange: 12 })
    const moving = new SdfTextMaterial({
      atlas,
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      runMotion: true,
    })
    const mipmapped = new Texture()
    const blurred = new SdfTextMaterial({
      atlas: mipmapped,
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
    })
    try {
      // Two passes, one graph: the probes in front of it hand over each pass's geometry.
      const graph = (node: Node | null) => (node as { positionNode?: Node }).positionNode
      expect(material.castShadowPositionNode).not.toBe(material.positionNode)
      expect(graph(material.castShadowPositionNode)).toBe(graph(material.positionNode))
      // Run motion and mipmaps have no trim, and no probe.
      expect(moving.castShadowPositionNode).toBe(moving.positionNode)
      expect(blurred.castShadowPositionNode).toBe(blurred.positionNode)
    } finally {
      material.dispose()
      moving.dispose()
      blurred.dispose()
      atlas.dispose()
      mipmapped.dispose()
    }
  })
})

describe('SDF wireframe', () => {
  // The field's sample, and the clip test (the varyings stay declared: the vertex writes them).
  const samplesField = /\btexture(Sample)?\(/
  const clips = /vUltraTextClip\.[xyzw]/

  it('draws each quad edge in the ink, with no coverage or clip to cut it', () => {
    for (const webgl of [false, true]) {
      const solid = generate({}, { webgl })
      const lines = generate({}, { webgl, wireframe: true })
      // A wireframe rasterizes only the quad's edges: they lie in its padding, where the field
      // reads outside, and the padding reaches past the block's clip. Both vanished the text.
      expect(solid.fragment).toMatch(samplesField)
      expect(solid.fragment).toMatch(clips)
      expect(lines.fragment).not.toMatch(samplesField)
      expect(lines.fragment).not.toMatch(clips)
      expect(lines.fragment).toMatch(/vUltraTextColor\.(xyz|rgb)/)
      // Dark ink is lifted by its luminance to a floor, so black text still draws on black.
      expect(lines.fragment).toMatch(/0\.2126/)
      expect(lines.fragment).toMatch(/\b0\.4\b/)
      expect(solid.fragment).not.toMatch(/0\.2126/)
      // The pass three derives for a shadow map keeps its silhouette.
      expect(generate({}, { webgl, shadow: 'pass', wireframe: true })).toEqual(
        generate({}, { webgl, shadow: 'pass' }),
      )
    }
  })
})

describe('SDF custom fill', () => {
  // Read in the colour and the alpha, so the shadow passes need the index too.
  const fill: TextFill = ({ color, glyphIndex }) => vec4(color.mul(glyphIndex), glyphIndex.mul(0.5))

  it.each([
    ['plain text', {}, {}, 'f32( instanceIndex )'],
    // Run motion feeds the fill only under the size switch; see windfoil-size-switch.test.ts.
    ['browser shaping', { textShaping: 'browser' }, {}, 'f32( instanceIndex )'],
    [
      'effects at high quality',
      { quality: 'high', outline: { width: 1 }, dropShadow: {} },
      {},
      'f32( instanceIndex )',
    ],
    ['a colour layer', {}, { layer: true }, 'f32( instanceIndex )'],
  ] as [string, Partial<SdfTextMaterialOptions>, Variant, string][])(
    'hands the fill its glyph index through a flat varying with %s',
    (_, options, variant, index) => {
      // The index is an integer per instance that callers truncate, as in
      // `uniformArray.element(int(glyphIndex))`. Interpolated, the constant can arrive a hair
      // under itself (Safari's relaxed math on Apple GPUs) and read the previous glyph's entry.
      for (const shadow of [false, true, 'pass'] as const) {
        const shader = generate({ ...options, fill }, { ...variant, shadow })
        expect(assigned(shader.vertex, 'varyings.vUltraFillIndex')).toBe(index)
        expect(shader.fragment).toMatch(
          /@location\( \d+ \) @interpolate\( flat, either \) vUltraFillIndex : f32,/,
        )
        const gl = generate({ ...options, fill }, { ...variant, shadow, webgl: true })
        expect(gl.fragment).toMatch(/^flat +in float vUltraFillIndex;$/m)
      }
    },
  )
})

describe('SDF custom vertex', () => {
  const vertex: TextVertex = ({ position, center, uv, glyphIndex, sequence, rect, clip }) =>
    position.add(
      vec3(
        center.x.mul(0.01).add(uv.x.mul(0.02)).add(rect.z.mul(0.03)),
        center.y.mul(0.01).add(uv.y.mul(0.02)).add(clip.x.mul(0.03)),
        glyphIndex.add(sequence).mul(0.125),
      ),
    )

  it('displaces vertex positions after assigning the un-displaced local clip varying', () => {
    for (const motion of [false, {}] as const) {
      const shader = generate({ vertex, motion })
      expect(shader.vertex).toContain('0.125')
      const localAssign = shader.vertex.indexOf('varyings.vUltraTextLocal =')
      const customZScale = shader.vertex.indexOf('0.125')
      expect(localAssign).toBeGreaterThan(-1)
      expect(customZScale).toBeGreaterThan(localAssign)
    }
  })
})

describe('SDF effects underlay', () => {
  const effects: Partial<SdfTextMaterialOptions> = { outline: { width: 1 }, dropShadow: {} }
  const fill: TextFill = ({ color, uv }) => vec4(color, uv.x)

  it.each([
    ['outline and drop shadow', effects],
    ['outline alone', { outline: { width: 2 } }],
    ['drop shadow alone', { dropShadow: { opacity: 1 } }],
    ['a fill and high quality', { ...effects, quality: 'high', fill }],
    ['a tone', { ...effects, tone: { backdrop: '#ffffff' } }],
    ['no tone', { ...effects, tone: false }],
  ] as [string, Partial<SdfTextMaterialOptions>][])(
    'composes %s for analytic text drawn over it, in the same vertex stage',
    (_, options) => {
      for (const webgl of [false, true]) {
        const single = generate(options, { webgl })
        const underlay = generate({ ...options, underlay: true }, { webgl })
        // The underlay divides by what the fill leaves and floods where the fill covers.
        expect(underlay.fragment).not.toBe(single.fragment)
        expect(underlay.fragment).toMatch(/0\.001/)
        expect(redeclared(underlay.fragment)).toEqual([])
        // Its paint's alpha, the ring's and shadow's, is divided by 1 - k, what the fill drawn
        // over it leaves: k = min(1, coverage x ink alpha x fill alpha), toned as the fill is.
        // Where 1 - k is under 1e-3 the divisor is 1. SDF text drawn alone divides by nothing.
        const divided = /vec4(?:<f32>)?\( .+, \( \w+ \/ (\w+) \) \);$/m
        const divisor = divided.exec(underlay.fragment)?.[1]
        expect(divisor, 'the paint’s alpha divided').toBeDefined()
        const choice = new RegExp(
          `if \\( (\\w+) \\) \\{\\s*${divisor} = 1\\.0;\\s*\\} else \\{\\s*${divisor} = (\\w+);\\s*\\}`,
        ).exec(underlay.fragment)
        expect(choice, 'a divisor of 1 where the fill floods').not.toBeNull()
        const [, flood = '', rest = ''] = choice ?? []
        expect(declared(underlay.fragment, rest)).toMatch(
          /^\( 1\.0 - min\( .*\bvUltraTextColor\.w\b.*, 1\.0 \) \)$/,
        )
        expect(declared(underlay.fragment, flood)).toBe(`( ${rest} < 0.001 )`)
        expect(single.fragment).not.toMatch(divided)
        // Nothing of it is computed per vertex: the same attributes and varyings. A tone's
        // uniforms, which the stages share, may be numbered in another order.
        const inputs = (shader: string) =>
          (shader.match(/@location\( \d+ \).*|^(?:in|out|flat) .*;$/gm) ?? [])
            .map((line) => line.replace(/@location\( \d+ \) /, ''))
            .sort()
        expect(inputs(underlay.vertex)).toEqual(inputs(single.vertex))
      }
    },
  )

  it('keeps the SDF silhouette of fill and ring in shadow maps', () => {
    for (const shadow of [true, 'pass'] as const) {
      const single = generate(effects, { shadow })
      const underlay = generate({ ...effects, underlay: true }, { shadow })
      expect(underlay).toEqual(single)
    }
  })

  it('leaves every shader without the option as it was', () => {
    for (const options of [{}, effects, { ...effects, quality: 'high' as const, fill }])
      expect(generate({ ...options, underlay: false })).toEqual(generate(options))
  })
})
