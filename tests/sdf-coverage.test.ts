import {
  DataTexture,
  LinearFilter,
  RedFormat,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import { float, vec3, vec4 } from 'three/tsl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildSdfAtlas } from '../src/atlas/buildAtlas.js'
import { SdfTextMaterial, type SdfTextMaterialOptions } from '../src/text/SdfTextMaterial.js'
import { resolveTextTone, toneCoverage, type ResolvedTextTone } from '../src/text/tone.js'
import type { SdfAtlas } from '../src/types.js'
import { traversePass } from './helpers/pass-graph.js'

type Value = number | readonly number[]

/** The fragment inputs a coverage ramp depends on. */
interface Probe {
  /** Atlas field value returned by every SDF sample. */
  field: number
  /** Screen pixels per `pxRange` texels, before the material's clamp to 1. */
  screenPxRange: number
  /** Requested outline expansion in field units, before the material's clamp. */
  expansion?: number
  /** 1 for a glyph of the colour band. */
  inBand?: number
  /**
   * The colour band's alpha at the fragment: 1 around colour ink, 0 around foreground ink that
   * shares the slot. Defaults to `inBand`, a slot that holds colour alone.
   */
  colour?: number
  /** 1 for a glyph in the atlas rows of monochrome shapes, or in the colour band below them. */
  inShapes?: number
  /** The tone's per-ink terms (D, H, T), as the vertex stage would send them. */
  terms?: readonly [number, number, number]
  /** Alpha of the instance colour, which holds the CSS colour's alpha and opacity. Opaque by default. */
  opacity?: number
  /** Alpha of the motion. `1` by default. */
  motion?: number
}

const WIDTH = 64
const HEIGHT = 64
const PX_RANGE = 12
const BAKE_SIZE = 96
const OUTLINE_WIDTH = 1

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1)

const combine = (a: Value, b: Value, op: (x: number, y: number) => number): Value => {
  if (typeof a === 'number' && typeof b === 'number') return op(a, b)
  const at = (value: Value, index: number): number =>
    typeof value === 'number' ? value : value[index]!
  const length = Math.max(
    typeof a === 'number' ? 1 : a.length,
    typeof b === 'number' ? 1 : b.length,
  )
  return Array.from({ length }, (_, index) => op(at(a, index), at(b, index)))
}

const scalar = (value: Value): number => {
  if (typeof value !== 'number') throw new TypeError(`expected a scalar, got [${String(value)}]`)
  return value
}

/**
 * Evaluates one node of a material's own coverage graph on the CPU. Only the leaves that vary
 * per fragment are stubbed: the atlas sample returns `probe.field`, the glyph UV's screen
 * derivatives are those of upright text whose footprint yields `probe.screenPxRange` (x along
 * the atlas's u, y along its v), the outline's UV-per-local varying yields
 * `probe.expansion`, and the colour-band and tone varyings return the probe's values. Anything
 * else unexpected throws, so the test cannot pass vacuously.
 */
function evaluator(material: SdfTextMaterial, atlas: Texture, probe: Probe) {
  const unit = material.unitRange.value
  const footprint = ((unit.x + unit.y) * 0.5) / probe.screenPxRange
  const uvPerLocal = ((probe.expansion ?? 0) * PX_RANGE) / (WIDTH * OUTLINE_WIDTH)
  let outline = false
  // TSL node internals are untyped here; the evaluator reads them structurally.
  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
  const evaluate = (node: any): Value => {
    if (node.isTextureNode && node.value === atlas) return [probe.field, probe.field, 0, 1]
    // The only other texture is the colour layer.
    if (node.isTextureNode) return [0, 0, 0, probe.colour ?? probe.inBand ?? 0]
    if (node.isPropertyNode && node.name === 'vUltraSdfUvPerLocal') {
      outline = true
      return [uvPerLocal, uvPerLocal]
    }
    if (node.isPropertyNode && node.name === 'vUltraColorGlyph') return probe.inBand ?? 0
    if (node.isVaryingNode && node.name === 'vUltraShapeGlyph') return probe.inShapes ?? 0
    if (node.isVaryingNode && node.name === 'vUltraTextTone') {
      if (!probe.terms) throw new TypeError('the probe has no tone terms')
      return probe.terms
    }
    if (node.isPropertyNode && node.name === 'vUltraTextColor') return [0, 0, 0, probe.opacity ?? 1]
    if (node.isPropertyNode && node.name === 'vUltraTextMotionAlpha') return probe.motion ?? 1
    if (node.isVarNode) return evaluate(node.node)
    // What a beauty pass shows; a shadow pass takes the node's other side.
    if (node.type === 'UltraTextPassNode') return evaluate(node.beautyNode)
    if (node.type === 'ConditionalNode') {
      // The colour layer's row flag is a comparison; every other condition is the effects'
      // in-cell test, and every probe sits inside its atlas cell.
      const condNode = node.condNode as { isOperatorNode?: boolean; op?: string } & Record<
        'aNode' | 'bNode',
        unknown
      >
      return condNode.isOperatorNode && condNode.op === '>'
        ? evaluate(
            scalar(evaluate(condNode.aNode)) > scalar(evaluate(condNode.bNode))
              ? node.ifNode
              : node.elseNode,
          )
        : evaluate(node.ifNode)
    }
    if (node.isConstNode || node.isUniformNode) {
      const value: unknown = node.value
      if (typeof value === 'number') return value
      if (value instanceof Vector2) return [value.x, value.y]
      if (value instanceof Vector3) return [value.x, value.y, value.z]
      throw new TypeError(`unsupported constant ${String(value)}`)
    }
    // vec2(a, b): effects read each tap once for the fill and the outline's silhouette.
    if (node.type === 'JoinNode')
      return (node.nodes as unknown[]).flatMap((part) => {
        const value = evaluate(part)
        return typeof value === 'number' ? [value] : value
      })
    if (node.isSplitNode) {
      const source = evaluate(node.node)
      const picked = Array.from(node.components as string).map((component) => {
        const index = 'xyzw'.includes(component)
          ? 'xyzw'.indexOf(component)
          : 'rgba'.indexOf(component)
        return typeof source === 'number' ? source : source[index]!
      })
      return picked.length === 1 ? picked[0]! : picked
    }
    if (node.isOperatorNode) {
      const a = evaluate(node.aNode)
      const b = evaluate(node.bNode)
      switch (node.op as string) {
        case '+':
          return combine(a, b, (x, y) => x + y)
        case '-':
          return combine(a, b, (x, y) => x - y)
        case '*':
          return combine(a, b, (x, y) => x * y)
        case '/':
          return combine(a, b, (x, y) => x / y)
      }
    }
    if (node.isMathNode) {
      const method = node.method as string
      if (method === 'dFdx') return [footprint, 0]
      if (method === 'dFdy') return [0, footprint]
      const a = evaluate(node.aNode)
      if (method === 'abs') return combine(a, 0, (x) => Math.abs(x))
      if (method === 'inversesqrt') return combine(a, 0, (x) => 1 / Math.sqrt(x))
      if (method === 'oneMinus') return combine(a, 0, (x) => 1 - x)
      const b = evaluate(node.bNode)
      if (method === 'min') return combine(a, b, Math.min)
      if (method === 'max') return combine(a, b, Math.max)
      // step(edge, x)
      if (method === 'step') return combine(a, b, (edge, x) => (x >= edge ? 1 : 0))
      if (method === 'dot') {
        const product = combine(a, b, (x, y) => x * y)
        return typeof product === 'number' ? product : product.reduce((sum, x) => sum + x, 0)
      }
      const c = evaluate(node.cNode)
      if (method === 'clamp') return combine(combine(a, b, Math.max), c, Math.min)
      if (method === 'mix') return scalar(a) + (scalar(b) - scalar(a)) * scalar(c)
      // smoothstep(low, high, x)
      if (method === 'smoothstep') {
        const t = clamp01((scalar(c) - scalar(a)) / (scalar(b) - scalar(a)))
        return t * t * (3 - 2 * t)
      }
    }
    throw new TypeError(`unsupported node ${String(node.type)} ${String(node.method ?? node.op)}`)
  }
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
  return (node: Node): { coverage: number; outline: boolean } => {
    outline = false
    const coverage = scalar(evaluate(node))
    return { coverage, outline }
  }
}

// Every walk below is over what a beauty pass builds: the colour graph also holds the
// silhouette a shadow pass shows in its place, which the shadow-map graph covers here.
const walk = (graph: Node, visit: (node: Node) => void): void => {
  traversePass(graph, 'beauty', visit)
}

const reaches = (graph: Node, wanted: (node: Node) => boolean): boolean => {
  let found = false
  walk(graph, (node) => {
    if (wanted(node)) found = true
  })
  return found
}

const isMath = (node: Node, method: string): node is Node & { aNode: Node } =>
  'method' in node && node.method === method

/** Every SDF coverage ramp in the beauty and shadow-map graphs: a clamp over an atlas sample. */
function coverageRamps(material: SdfTextMaterial, atlas: Texture, graphs?: Node[]): Node[] {
  const ramps = new Set<Node>()
  for (const graph of graphs ?? [material.colorNode!, material.maskShadowNode!]) {
    walk(graph, (node) => {
      if (
        isMath(node, 'clamp') &&
        reaches(node.aNode, (inner) => 'value' in inner && inner.value === atlas)
      )
        ramps.add(node)
    })
  }
  return [...ramps]
}

/** With a colour layer, each ramp is shown through a blend: linear for text, eased for the band. */
function layeredCoverage(material: SdfTextMaterial, ramps: readonly Node[]): Node[] {
  const blends = new Map<Node, Node>()
  for (const graph of [material.colorNode!, material.maskShadowNode!]) {
    walk(graph, (node) => {
      if (isMath(node, 'mix') && ramps.includes(node.aNode)) blends.set(node.aNode, node)
    })
  }
  return ramps.map((ramp) => {
    const blend = blends.get(ramp)
    if (!blend) throw new Error('a ramp of a layered material is shown unblended')
    return blend
  })
}

const eased = (t: number): number => t * t * (3 - 2 * t)

/** The beauty graph's nodes of one math method that read the tone's fragment uniform. */
function tonedNodes(material: SdfTextMaterial, method: string): Node[] {
  const curve = material.tone!.curve
  const found = new Set<Node>()
  walk(material.colorNode!, (node) => {
    if (isMath(node, method) && reaches(node, (inner) => inner === curve)) found.add(node)
  })
  return [...found]
}

/** The per-ink terms the vertex stage sends for an ink of encoded lightness `ink`. */
function inkTerms(tone: ResolvedTextTone, ink: number): [number, number, number] {
  const c1 = 0.012522878
  const c2 = 0.682171111
  const c3 = 0.305306011
  const b = tone.backdrop
  const delta = ink - b
  const k1 = c2 + 3 * c3 * b
  const k0 = c1 + 2 * c2 * b + 3 * c3 * b * b
  return [
    delta,
    tone.strength / (k0 + delta * (k1 + c3 * delta)),
    (tone.strength * tone.table * Math.min(Math.floor(4 * ink), 3)) / 3,
  ]
}

const materials: SdfTextMaterial[] = []
const atlases: Texture[] = []

/**
 * Three's texture defaults sample through mipmaps, which keeps whole quads. `levelZero()` is
 * an atlas as `buildSdfAtlas` makes one by default: level 0 only, so quads may be trimmed.
 */
function create(options: Partial<SdfTextMaterialOptions> = {}, atlas = new Texture()) {
  const material = new SdfTextMaterial({
    atlas,
    atlasWidth: WIDTH,
    atlasHeight: HEIGHT,
    pxRange: PX_RANGE,
    ...options,
  })
  atlases.push(atlas)
  materials.push(material)
  return { atlas, material, ramps: coverageRamps(material, atlas) }
}

function createLayered(options: Partial<SdfTextMaterialOptions> = {}, atlas?: Texture) {
  const layer = new Texture()
  atlases.push(layer)
  return create({ colorLayer: { texture: layer, top: 32, height: 32 }, ...options }, atlas)
}

const levelZero = (): Texture =>
  Object.assign(new Texture(), { generateMipmaps: false, minFilter: LinearFilter })

/** An atlas whose monochrome shapes start at row 16, as `SdfAtlas.shapeTop` names them. */
function createWithShapes(options: Partial<SdfTextMaterialOptions> = {}) {
  const atlas = new Texture()
  const material = new SdfTextMaterial({
    atlas,
    atlasWidth: WIDTH,
    atlasHeight: HEIGHT,
    pxRange: PX_RANGE,
    shapeTop: 16,
    ...options,
  })
  atlases.push(atlas)
  materials.push(material)
  return { atlas, material, ramps: coverageRamps(material, atlas) }
}

const named = (graph: Node, name: string): boolean =>
  reaches(graph, (node) => 'name' in node && node.name === name)

/** The row uniform of a material's shape flag: step(row, v) over the glyph's atlas rows. */
function shapeRow(material: SdfTextMaterial): number | undefined {
  let row: number | undefined
  walk(material.colorNode!, (node) => {
    if (!('name' in node) || node.name !== 'vUltraShapeGlyph') return
    walk(node, (inner) => {
      const uniform = inner as { isUniformNode?: boolean; value?: unknown }
      if (uniform.isUniformNode && typeof uniform.value === 'number') row = uniform.value
    })
  })
  return row
}

afterEach(() => {
  for (const material of materials.splice(0)) material.dispose()
  for (const atlas of atlases.splice(0)) atlas.dispose()
})

const CONFIGURATIONS: [string, Partial<SdfTextMaterialOptions>][] = [
  ['a plain fill', {}],
  ['a plain high-quality fill', { quality: 'high' }],
  ['a heavier threshold', { threshold: 0.45 }],
  ['the former defaults', { threshold: 0.515, stemDarkening: 0.12 }],
  ['an outline', { outline: { width: OUTLINE_WIDTH } }],
  [
    'an outline and drop shadow at high quality',
    { quality: 'high', outline: { width: OUTLINE_WIDTH }, dropShadow: {} },
  ],
  ['a drop shadow', { dropShadow: { offsetX: 3, offsetY: -3 } }],
]

const TONES: [string, SdfTextMaterialOptions['tone']][] = [
  ['the default tone', undefined],
  ['no tone', false],
  ['the Windows model', { model: 'windows', backdrop: '#000' }],
  ['the macOS model', { model: 'macos', backdrop: '#fff' }],
]

// One field unit per screen pixel is a glyph only a few pixels tall; 40 is 320 pixels per em,
// past the size where the macOS model stops.
const RANGES = [0.5, 1, 1.1, 1.5, 2, 4, 16, 40]

describe('SDF coverage', () => {
  describe.each(TONES)('with %s', (_, tone) => {
    it.each(CONFIGURATIONS)(
      'leaves the saturated background of %s at exactly zero coverage',
      (__, options) => {
        const { atlas, material, ramps } = create({
          ...options,
          ...(tone === undefined ? {} : { tone }),
        })
        expect(ramps.length).toBeGreaterThan(0)
        let outlines = 0
        // The requested expansions cover a thin outline, a wide one, and one past the baked range.
        for (const screenPxRange of RANGES) {
          for (const expansion of [0, 0.25, 0.49, 0.8]) {
            const sample = evaluator(material, atlas, { field: 0, screenPxRange, expansion })
            for (const ramp of ramps) {
              const where = `screenPxRange ${String(screenPxRange)}, expansion ${String(expansion)}`
              // The ramp's input never rises above its foot where the field is empty.
              expect(
                sample((ramp as Node & { aNode: Node }).aNode).coverage,
                where,
              ).toBeLessThanOrEqual(0)
              const { coverage, outline } = sample(ramp)
              if (outline) outlines++
              expect(coverage, where).toBe(0)
            }
          }
        }
        expect(outlines > 0).toBe(options.outline !== undefined)
      },
    )

    it('keeps zero coverage at zero through the tone', () => {
      if (tone === false) return
      const { atlas, material } = create(tone === undefined ? {} : { tone })
      const [toned] = tonedNodes(material, 'min')
      for (const ink of [0, 0.3, 0.75, 1]) {
        const terms = inkTerms(material.tone!.resolved, ink)
        for (const screenPxRange of RANGES) {
          const sample = evaluator(material, atlas, { field: 0, screenPxRange, terms })
          expect(sample(toned!).coverage).toBe(0)
        }
      }
    })
  })

  it('defaults to the baked contour with no stem darkening and a one-pixel linear ramp', () => {
    const { atlas, material, ramps } = create()
    expect(material.threshold.value).toBe(0.5)
    expect(material.stemDarkening.value).toBe(0)
    const fields = Array.from({ length: 21 }, (_, index) => index / 20)
    for (const screenPxRange of [1, 1.2, 1.5, 2, 4, 16]) {
      for (const field of fields) {
        const sample = evaluator(material, atlas, { field, screenPxRange })
        for (const ramp of ramps) {
          // Coverage of a straight edge: half at the contour, a pixel from none to all.
          expect(sample(ramp).coverage).toBeCloseTo(
            clamp01(screenPxRange * (field - 0.5) + 0.5),
            12,
          )
        }
      }
    }
  })

  it('keeps an explicit threshold and stem darkening wherever the background allows them', () => {
    const threshold = 0.515
    const { atlas, material, ramps } = create({ threshold, stemDarkening: 0.12 })
    const boost = (range: number): number => 0.12 * Math.min(Math.max(2 - range, 0), 1)
    const fields = Array.from({ length: 21 }, (_, index) => index / 20)
    for (const screenPxRange of [1.2, 1.5, 2, 4]) {
      for (const field of fields) {
        const sample = evaluator(material, atlas, { field, screenPxRange })
        for (const ramp of ramps) {
          // Unchanged from the uncapped formula once the empty cell already fell below the ramp.
          expect(sample(ramp).coverage).toBeCloseTo(
            clamp01(screenPxRange * (field - threshold) + boost(screenPxRange) + 0.5),
            12,
          )
        }
      }
    }
    // A glyph a few pixels tall: the whole field spans one screen pixel, so the ramp starts at
    // the empty cell and keeps what darkening fits (0.015 of the 0.12).
    for (const field of fields) {
      const sample = evaluator(material, atlas, { field, screenPxRange: 1 })
      for (const ramp of ramps) expect(sample(ramp).coverage).toBeCloseTo(clamp01(field), 12)
    }
    const contour = evaluator(material, atlas, { field: threshold, screenPxRange: 1 })
    expect(contour(ramps[0]!).coverage).toBeGreaterThan(0.5)
  })

  it('keeps the one-pixel ramp under extreme magnification', () => {
    const { atlas, material, ramps } = create()
    // Tens of thousands of screen pixels per field unit: a glyph magnified far beyond its
    // bake. A floor on the UV footprint used to cap the range and blur the edge over
    // several pixels here.
    for (const screenPxRange of [2e4, 1e5, 1e6]) {
      for (const offset of [-0.5, -0.25, 0, 0.25, 0.5]) {
        const field = 0.5 + offset / screenPxRange
        const sample = evaluator(material, atlas, { field, screenPxRange })
        for (const ramp of ramps) {
          expect(sample(ramp).coverage, `${String(screenPxRange)} ${String(offset)}`).toBeCloseTo(
            offset + 0.5,
            3,
          )
        }
      }
    }
  })

  it('shrinks an outline only as far as the baked range requires', () => {
    const { atlas, material, ramps } = create({ outline: { width: OUTLINE_WIDTH } })
    const coverage = (field: number, screenPxRange: number, expansion: number): number => {
      const sample = evaluator(material, atlas, { field, screenPxRange, expansion })
      const outline = ramps.map(sample).find((result) => result.outline)
      if (!outline) throw new Error('no outline ramp')
      return outline.coverage
    }
    // A thin outline on large text keeps its exact contour at half coverage.
    expect(coverage(0.5 - 0.25, 8, 0.25)).toBeCloseTo(0.5, 12)
    // At the range limit the field cannot hold a whole ramp outside the contour, so the ramp's
    // foot is pinned to the empty cell rather than tinting the whole quad.
    expect(coverage(0, 4, 0.49)).toBe(0)
    expect(coverage(0.125, 4, 0.49)).toBeCloseTo(0.5, 12)
    expect(coverage(0.5, 4, 0.49)).toBe(1)
  })

  it('keeps colour glyphs on their own contour and eased ramp unless a threshold is passed', () => {
    const fields = [0.4, 0.47, 0.5, 0.515, 0.53, 0.56, 0.6]
    for (const [threshold, band] of [
      [undefined, 0.515],
      [0.5, 0.5],
      [0.47, 0.47],
    ] as const) {
      const { atlas, material, ramps } = createLayered(threshold === undefined ? {} : { threshold })
      expect(ramps.length).toBeGreaterThan(0)
      for (const field of fields) {
        const text = evaluator(material, atlas, { field, screenPxRange: 8, inBand: 0 })
        const colour = evaluator(material, atlas, { field, screenPxRange: 8, inBand: 1 })
        for (const shown of layeredCoverage(material, ramps)) {
          // Text beside colour glyphs has the linear ramp of a material without a layer.
          expect(text(shown).coverage).toBeCloseTo(
            clamp01(8 * (field - (threshold ?? 0.5)) + 0.5),
            12,
          )
          // Colour glyphs keep the smoothstep they were always drawn with.
          expect(colour(shown).coverage).toBeCloseTo(eased(clamp01(8 * (field - band) + 0.5)), 12)
        }
      }
    }
  })

  it('tells text from colour inside one band slot by the alpha of the band, in the beauty pass', () => {
    const fields = [0.4, 0.47, 0.5, 0.515, 0.53, 0.56, 0.6]
    const { atlas, material } = createLayered()
    const beauty = layeredCoverage(material, coverageRamps(material, atlas, [material.colorNode!]))
    const cast = layeredCoverage(
      material,
      coverageRamps(material, atlas, [material.maskShadowNode!]),
    )
    expect(beauty.length).toBeGreaterThan(0)
    expect(cast.length).toBeGreaterThan(0)
    for (const field of fields) {
      const probe = { field, screenPxRange: 8, inBand: 1 }
      // A shaped line beside its emoji: one slot of the band, a fragment around each ink.
      const text = evaluator(material, atlas, { ...probe, colour: 0 })
      const emoji = evaluator(material, atlas, { ...probe, colour: 1 })
      const between = evaluator(material, atlas, { ...probe, colour: 0.5 })
      for (const shown of beauty) {
        // The text has the contour and the linear ramp of the text rows.
        expect(text(shown).coverage).toBeCloseTo(clamp01(8 * (field - 0.5) + 0.5), 12)
        expect(emoji(shown).coverage).toBeCloseTo(eased(clamp01(8 * (field - 0.515) + 0.5)), 12)
        const across = clamp01(8 * (field - 0.5075) + 0.5)
        expect(between(shown).coverage).toBeCloseTo((across + eased(across)) / 2, 12)
      }
      // A shadow map keeps the flag of the row: the whole slot on the band's contour.
      for (const shown of cast)
        expect(text(shown).coverage).toBeCloseTo(eased(clamp01(8 * (field - 0.515) + 0.5)), 12)
    }
  })

  it('eases no ramp without a colour layer', () => {
    for (const options of [
      {},
      { quality: 'high' },
      { outline: { width: 1 }, dropShadow: {} },
    ] as const) {
      const { material } = create(options)
      for (const graph of [material.colorNode!, material.maskShadowNode!])
        expect(reaches(graph, (node) => isMath(node, 'smoothstep'))).toBe(false)
    }
  })
})

describe('SDF tone', () => {
  const INKS = [0, 0.2, 0.5, 0.8, 1]
  const FIELDS = [0.42, 0.47, 0.5, 0.53, 0.58]

  it.each([
    ['the default: outline over white', undefined],
    ['white ink over black', { model: 'outline', backdrop: '#000' }],
    ['the Windows table over grey', { model: 'windows', backdrop: '#777' }],
    ['half strength', { model: 'windows', backdrop: '#222', strength: 0.5 }],
  ] as const)('shows the shared conversion of the fill coverage: %s', (_, option) => {
    const { atlas, material, ramps } = create(option ? { tone: option } : {})
    const resolved = resolveTextTone(option)!
    expect(material.tone!.resolved).toEqual(resolved)
    const [fill] = coverageRamps(material, atlas, [material.colorNode!])
    const [toned] = tonedNodes(material, 'min')
    expect(ramps).toContain(fill)
    for (const ink of INKS) {
      const terms = inkTerms(resolved, ink)
      for (const field of FIELDS) {
        const sample = evaluator(material, atlas, { field, screenPxRange: 8, terms })
        const exact = sample(fill!).coverage
        expect(sample(toned!).coverage).toBeCloseTo(toneCoverage(resolved, ink, exact), 12)
      }
    }
    // Equal ink and backdrop, or no strength, leave the coverage as it is.
    const same = evaluator(material, atlas, {
      field: 0.47,
      screenPxRange: 8,
      terms: [0, inkTerms(resolved, resolved.backdrop)[1], 0],
    })
    expect(same(toned!).coverage).toBeCloseTo(same(fill!).coverage, 12)
  })

  it.each([
    ['the default: outline over white', undefined],
    ['white ink over black', { model: 'outline', backdrop: '#000' }],
    ['the Windows table over grey', { model: 'windows', backdrop: '#777' }],
  ] as const)('converts the mask times the alpha of translucent ink: %s', (_, option) => {
    const { atlas, material } = create(option ? { tone: option } : {})
    const resolved = resolveTextTone(option)!
    const [fill] = coverageRamps(material, atlas, [material.colorNode!])
    const [toned] = tonedNodes(material, 'min')
    // The sRGB decode the conversion is built on, written out here: the pixel a browser's
    // encoded-space blend of mask x alpha lands on, as the alpha of a linear-light blend.
    const P = (x: number): number => x * (x * (0.305306011 * x + 0.682171111) + 0.012522878)
    const browser = (ink: number, mask: number): number => {
      const b = resolved.backdrop
      return Math.abs(ink - b) < 1e-3 ? mask : (P(b + (ink - b) * mask) - P(b)) / (P(ink) - P(b))
    }
    let apart = 0
    for (const ink of INKS) {
      const terms = inkTerms(resolved, ink)
      const weight = (resolved.table * Math.min(Math.floor(4 * ink), 3)) / 3
      for (const field of FIELDS)
        for (const [opacity, motion] of [
          [0.5, 1],
          [1, 0.25],
          [0.6, 0.5],
          [0, 1],
        ] as const) {
          const sample = evaluator(material, atlas, {
            field,
            screenPxRange: 8,
            terms,
            opacity,
            motion,
          })
          const exact = sample(fill!).coverage
          const shown = browser(ink, (exact + weight * exact * (1 - exact)) * opacity * motion)
          expect(sample(toned!).coverage).toBeCloseTo(shown, 9)
          expect(toneCoverage(resolved, ink, exact, opacity * motion)).toBeCloseTo(shown, 9)
          // Not the conversion of opaque ink scaled by that alpha.
          apart = Math.max(apart, Math.abs(shown - browser(ink, exact) * opacity * motion))
        }
    }
    expect(apart).toBeGreaterThan(0.1)
    // Fully covered half-opaque black ink on white is the browser's mid grey.
    if (!option) {
      const inside = evaluator(material, atlas, {
        field: 1,
        screenPxRange: 8,
        terms: inkTerms(resolved, 0),
        opacity: 0.5,
      })
      expect(inside(toned!).coverage).toBeCloseTo(1 - P(0.5), 9)
    }
  })

  it('folds the alpha of a fill into the conversion too, and never in a shadow map', () => {
    const alpha = float(0.5)
    const fill = (): Node<'vec4'> => vec4(vec3(0), alpha)
    const named = (name: string) => (node: Node) => 'name' in node && node.name === name
    // The ink's whole alpha as one product, apart from any coverage: what the mask is
    // multiplied by before the step across the backdrop.
    const opacities = (material: SdfTextMaterial, atlas: Texture, pass: 'beauty' | 'shadow') => {
      const found: Node[] = []
      traversePass(material.colorNode!, pass, (node) => {
        if (
          'op' in node &&
          node.op === '*' &&
          reaches(node, (inner) => inner === alpha) &&
          reaches(node, named('vUltraTextColor')) &&
          reaches(node, named('vUltraTextMotionAlpha')) &&
          !reaches(node, (inner) => 'value' in inner && inner.value === atlas)
        )
          found.push(node)
      })
      return found
    }
    const toned = create({ fill })
    expect(opacities(toned.material, toned.atlas, 'beauty').length).toBeGreaterThan(0)
    expect(opacities(toned.material, toned.atlas, 'shadow')).toEqual([])
    // An outline or a drop shadow is composed with the fill first: opaque-ink conversion.
    const effects = create({ fill, outline: { width: OUTLINE_WIDTH } })
    expect(opacities(effects.material, effects.atlas, 'beauty')).toEqual([])
    const exact = create({ fill, tone: false })
    expect(opacities(exact.material, exact.atlas, 'beauty')).toEqual([])
  })

  it('tones the beauty fill only: never a shadow map, and nothing with tone: false', () => {
    for (const options of [{}, { outline: { width: OUTLINE_WIDTH }, dropShadow: {} }] as const) {
      const { material } = create(options)
      const tone = material.tone!
      const reads = (graph: Node): boolean =>
        reaches(
          graph,
          (node) =>
            node === tone.curve ||
            node === tone.ink ||
            node === tone.dilation ||
            ('name' in node && node.name === 'vUltraTextTone'),
        )
      expect(reads(material.colorNode!)).toBe(true)
      expect(reads(material.maskNode!)).toBe(true)
      expect(reads(material.maskShadowNode!)).toBe(false)

      const off = create({ ...options, tone: false }).material
      expect(off.tone).toBeNull()
      for (const graph of [off.colorNode!, off.maskNode!, off.maskShadowNode!])
        expect(reaches(graph, (node) => 'name' in node && node.name === 'vUltraTextTone')).toBe(
          false,
        )
    }
  })

  it('tones the fill under an outline and a drop shadow, and leaves their coverage exact', () => {
    const option = { model: 'outline', backdrop: '#fff' } as const
    const { atlas, material } = create({
      tone: option,
      outline: { width: OUTLINE_WIDTH },
      dropShadow: {},
    })
    const resolved = resolveTextTone(option)!
    // One conversion in the graph: the fill's. The fill and the outline's silhouette are two
    // contours of the same taps, read once into one vector; the drop shadow feeds nothing.
    const toned = tonedNodes(material, 'min')
    expect(toned).toHaveLength(1)
    const beauty = coverageRamps(material, atlas, [material.colorNode!])
    expect(beauty).toHaveLength(3)
    const feeding = beauty.filter((ramp) => reaches(toned[0]!, (node) => node === ramp))
    expect(feeding).toHaveLength(2)
    const terms = inkTerms(resolved, 0)
    const at = (expansion: number) =>
      evaluator(material, atlas, { field: 0.5, screenPxRange: 8, expansion, terms })
    // Exactly one of the two shares the tap with the outline's expansion.
    expect(feeding.map((ramp) => at(0.25)(ramp).outline).sort()).toEqual([false, true])
    // The conversion reads the fill's contour alone: no outline width moves it.
    for (const expansion of [0, 0.25, 0.45])
      expect(at(expansion)(toned[0]!).coverage).toBeCloseTo(toneCoverage(resolved, 0, 0.5), 12)
  })

  it('reads each tap once for the fill and the outline, and sums both as filtered apart', () => {
    for (const quality of ['standard', 'high'] as const) {
      const paired = create({ quality, outline: { width: OUTLINE_WIDTH }, tone: false })
      // As many atlas reads in the beauty graph as taps: the fill's and the silhouette's share.
      // Effects read with the glyph's own footprint, so each read is a sample with gradients.
      const reads = new Set<Node>()
      walk(paired.material.colorNode!, (node) => {
        if ('value' in node && node.value === paired.atlas && 'gradNode' in node && node.gradNode)
          reads.add(node)
      })
      expect(reads.size).toBe(quality === 'high' ? 4 : 1)
      // Each tap's pair is the same select as the plain contour's: inside the cell, or 0.
      const pairs: Node[] = []
      walk(paired.material.colorNode!, (node) => {
        if (
          node.type === 'ConditionalNode' &&
          'ifNode' in node &&
          (node.ifNode as Node).type === 'JoinNode'
        )
          pairs.push(node)
      })
      expect(pairs).toHaveLength(quality === 'high' ? 4 : 1)
      for (const field of [0.3, 0.5, 0.62]) {
        const sample = evaluator(paired.material, paired.atlas, {
          field,
          screenPxRange: 3,
          expansion: 0.2,
        })
        for (const pair of pairs) {
          const [fill, silhouette] = (pair as Node & { ifNode: { nodes: Node[] } }).ifNode.nodes
          // The fill's contour, and the silhouette's, moved out by the outline's expansion.
          expect(sample(fill!).coverage).toBeCloseTo(clamp01(3 * (field - 0.5) + 0.5), 12)
          expect(sample(silhouette!).coverage).toBeCloseTo(clamp01(3 * (field - 0.3) + 0.5), 12)
        }
      }
    }
  })

  it('leaves colour glyphs untoned', () => {
    const option = { model: 'outline', backdrop: '#fff' } as const
    const { atlas, material } = createLayered({ tone: option })
    const resolved = resolveTextTone(option)!
    const [fill] = layeredCoverage(
      material,
      coverageRamps(material, atlas, [material.colorNode!]).slice(0, 1),
    )
    const [gated] = tonedNodes(material, 'mix')
    const terms = inkTerms(resolved, 0)
    const text = evaluator(material, atlas, { field: 0.5, screenPxRange: 8, inBand: 0, terms })
    expect(text(gated!).coverage).toBeCloseTo(toneCoverage(resolved, 0, 0.5), 12)
    const colour = evaluator(material, atlas, { field: 0.52, screenPxRange: 8, inBand: 1, terms })
    expect(colour(gated!).coverage).toBeCloseTo(colour(fill!).coverage, 12)
    expect(colour(fill!).coverage).toBeCloseTo(eased(clamp01(8 * (0.52 - 0.515) + 0.5)), 12)
  })

  it('tones text that shares a band slot with colour ink, and leaves that ink exact', () => {
    const option = { model: 'outline', backdrop: '#fff' } as const
    const { atlas, material } = createLayered({ tone: option })
    const resolved = resolveTextTone(option)!
    const [gated] = tonedNodes(material, 'mix')
    const terms = inkTerms(resolved, 0)
    const probe = { field: 0.52, screenPxRange: 8, inBand: 1, terms }
    const linear = clamp01(8 * (0.52 - 0.5) + 0.5)
    const text = evaluator(material, atlas, { ...probe, colour: 0 })
    expect(text(gated!).coverage).toBeCloseTo(toneCoverage(resolved, 0, linear), 12)
    expect(toneCoverage(resolved, 0, linear)).toBeGreaterThan(linear + 0.1)
    const emoji = evaluator(material, atlas, { ...probe, colour: 1 })
    expect(emoji(gated!).coverage).toBeCloseTo(eased(clamp01(8 * (0.52 - 0.515) + 0.5)), 12)
  })

  describe('monochrome shapes', () => {
    it.each([
      ['the outline model', { model: 'outline', backdrop: '#fff' }],
      ['the Windows table', { model: 'windows', backdrop: '#000' }],
      ['the macOS model', { model: 'macos', backdrop: '#fff' }],
    ] as const)('keep their baked coverage beside toned text: %s', (_, option) => {
      const { atlas, material } = createWithShapes({ tone: option })
      const resolved = resolveTextTone(option)!
      const [gated] = tonedNodes(material, 'mix')
      expect(gated).toBeDefined()
      for (const screenPxRange of [1.5, 3, 8, 40]) {
        const emPx = (screenPxRange * BAKE_SIZE) / PX_RANGE
        const d =
          emPx < resolved.bigPx ? Math.min(resolved.dilationEm * emPx, resolved.dilationPx) : 0
        for (const ink of [0, 0.5, 1]) {
          const terms = inkTerms(resolved, ink)
          for (const field of [0.4, 0.47, 0.5, 0.53, 0.6]) {
            const probe = { field, screenPxRange, terms }
            const ramp = (lift: number): number =>
              clamp01(screenPxRange * (field - 0.5) + 0.5 + lift)
            const shape = evaluator(material, atlas, { ...probe, inShapes: 1 })
            expect(shape(gated!).coverage).toBeCloseTo(ramp(0), 10)
            const text = evaluator(material, atlas, { ...probe, inShapes: 0 })
            const table = d > 0 || resolved.dilationPx === 0 ? resolved.table : 0
            expect(text(gated!).coverage).toBeCloseTo(
              toneCoverage({ ...resolved, table }, ink, ramp(d)),
              10,
            )
          }
        }
      }
      // Shapes are not colour glyphs: one contour, and no eased ramp.
      expect(named(material.colorNode!, 'vUltraColorGlyph')).toBe(false)
      expect(reaches(material.colorNode!, (node) => isMath(node, 'smoothstep'))).toBe(false)
      // Shadow maps never read the tone, so they need no flag either.
      expect(named(material.maskShadowNode!, 'vUltraShapeGlyph')).toBe(false)
    })

    it('stay exact on an atlas restored through the fields of the public SdfAtlas type', async () => {
      // Built by the public builder from a raster that packed its shapes from row 16 down.
      const canvas = document.createElement('canvas')
      vi.spyOn(canvas, 'getContext').mockReturnValue({
        getImageData: () => ({ data: new Uint8ClampedArray(WIDTH * HEIGHT * 4) }),
      } as unknown as GPUCanvasContext)
      const raster = {
        canvas,
        width: WIDTH,
        height: HEIGHT,
        bakeSize: BAKE_SIZE,
        pxRange: PX_RANGE,
        glyphs: new Map(),
        shapeTop: 16,
      }
      const built = await buildSdfAtlas({} as WebGPURenderer, raster, {
        mode: 'cpu',
        cpuWorker: false,
      })
      expect(built.shapeTop).toBe(16)

      // What a cache does: it stores the distance bytes and the fields the type declares,
      // and re-creates the texture, which then carries nothing of the builder's own.
      const bytes = (built.texture as DataTexture).image.data as Uint8Array
      const texture = new DataTexture(
        bytes.slice(),
        built.width,
        built.height,
        RedFormat,
        UnsignedByteType,
      )
      const restored: SdfAtlas = {
        texture,
        width: built.width,
        height: built.height,
        pxRange: built.pxRange,
        bakeSize: built.bakeSize,
        glyphs: new Map(built.glyphs),
        mode: built.mode,
        shapeTop: built.shapeTop,
        dispose: () => {
          texture.dispose()
        },
      }
      built.dispose()
      atlases.push(texture)
      expect(texture.userData).toEqual({})

      const option = { model: 'outline', backdrop: '#000' } as const
      const from = (atlas: SdfAtlas, shapeTop: number | undefined): SdfTextMaterial => {
        const material = new SdfTextMaterial({
          atlas: atlas.texture,
          atlasWidth: atlas.width,
          atlasHeight: atlas.height,
          pxRange: atlas.pxRange,
          bakeSize: atlas.bakeSize,
          shapeTop,
          tone: option,
        })
        materials.push(material)
        return material
      }
      const material = from(restored, restored.shapeTop)
      // The flag compares each glyph's atlas rows with row 16, half a texel in.
      expect(shapeRow(material)).toBe(16.5 / HEIGHT)

      const resolved = resolveTextTone(option)!
      const [gated] = tonedNodes(material, 'mix')
      for (const ink of [0, 1])
        for (const field of [0.4, 0.47, 0.5, 0.53, 0.6]) {
          const probe = { field, screenPxRange: 3, terms: inkTerms(resolved, ink) }
          const baked = clamp01(3 * (field - 0.5) + 0.5)
          const shape = evaluator(material, texture, { ...probe, inShapes: 1 })
          expect(shape(gated!).coverage).toBeCloseTo(baked, 10)
          const text = evaluator(material, texture, { ...probe, inShapes: 0 })
          expect(text(gated!).coverage).toBeCloseTo(toneCoverage(resolved, ink, baked), 10)
        }
      // White ink on black is thinned by the tone: a shape drawn as text would lose ink.
      expect(toneCoverage(resolved, 1, 0.5)).toBeLessThan(0.25)

      // The field is what carries the rows: without it this texture has no shapes to exempt,
      // and the row lies below the atlas, where no glyph is.
      expect(shapeRow(from(restored, undefined))).toBe((HEIGHT + 0.5) / HEIGHT)
    })

    it('are flagged in toned shaders whose quads may be trimmed, from a row no glyph reaches', () => {
      // One shader text for atlases with and without shapes: the row is a uniform.
      expect(shapeRow(create({}, levelZero()).material)).toBe((HEIGHT + 0.5) / HEIGHT)
      expect(shapeRow(createLayered({}, levelZero()).material)).toBe((HEIGHT + 0.5) / HEIGHT)
      expect(shapeRow(createWithShapes().material)).toBe(16.5 / HEIGHT)
      // Whole quads keep the shader without it, where it would cost every fragment and repay
      // nothing: mipmaps, effects and run motion. An atlas with shapes is flagged everywhere.
      for (const whole of [
        create().material,
        createLayered().material,
        create({ outline: { width: 1 } }, levelZero()).material,
        create({ dropShadow: {} }, levelZero()).material,
        create({ runMotion: true }, levelZero()).material,
      ])
        expect(named(whole.colorNode!, 'vUltraShapeGlyph')).toBe(false)
      expect(shapeRow(createWithShapes({ outline: { width: 1 } }).material)).toBe(16.5 / HEIGHT)
      const off = createWithShapes({ tone: false }).material
      expect(named(off.colorNode!, 'vUltraShapeGlyph')).toBe(false)
    })

    it('keep the toned text exact where the flag of an atlas without shapes is 0', () => {
      // mix(toned, baked, 0) is the toned coverage itself, whatever the probe.
      const option = { model: 'macos', backdrop: '#fff' } as const
      const { atlas, material } = create({ tone: option }, levelZero())
      const resolved = resolveTextTone(option)!
      const [gated] = tonedNodes(material, 'mix')
      expect(gated).toBeDefined()
      for (const screenPxRange of [1.5, 3, 8])
        for (const field of [0.4, 0.5, 0.6]) {
          const terms = inkTerms(resolved, 0)
          const text = evaluator(material, atlas, { field, screenPxRange, terms, inShapes: 0 })
          const emPx = (screenPxRange * BAKE_SIZE) / PX_RANGE
          const d =
            emPx < resolved.bigPx ? Math.min(resolved.dilationEm * emPx, resolved.dilationPx) : 0
          const table = d > 0 ? resolved.table : 0
          expect(text(gated!).coverage).toBeCloseTo(
            toneCoverage(
              { ...resolved, table },
              0,
              clamp01(screenPxRange * (field - 0.5) + 0.5 + d),
            ),
            10,
          )
        }
    })

    it('share the exemption with the colour band below them, which keeps its own contour', () => {
      const option = { model: 'macos', backdrop: '#fff' } as const
      const layer = new Texture()
      atlases.push(layer)
      const { atlas, material } = createWithShapes({
        tone: option,
        colorLayer: { texture: layer, top: 32, height: 32 },
      })
      const resolved = resolveTextTone(option)!
      const [gated] = tonedNodes(material, 'mix')
      const terms = inkTerms(resolved, 0)
      const probe = { field: 0.52, screenPxRange: 8, terms }
      const shape = evaluator(material, atlas, { ...probe, inShapes: 1, inBand: 0 })
      expect(shape(gated!).coverage).toBeCloseTo(clamp01(8 * (0.52 - 0.5) + 0.5), 10)
      const colour = evaluator(material, atlas, { ...probe, inShapes: 1, inBand: 1 })
      expect(colour(gated!).coverage).toBeCloseTo(eased(clamp01(8 * (0.52 - 0.515) + 0.5)), 10)
      // Text in a slot of the band lies below the shapes' first row too, and is still text:
      // toned, and dilated by this model.
      const text = evaluator(material, atlas, { ...probe, inShapes: 1, inBand: 1, colour: 0 })
      const d = Math.min(resolved.dilationEm * ((8 * BAKE_SIZE) / PX_RANGE), resolved.dilationPx)
      expect(text(gated!).coverage).toBeCloseTo(
        toneCoverage(resolved, 0, clamp01(8 * (0.52 - 0.5) + 0.5 + d)),
        10,
      )
    })
  })

  describe('macOS model', () => {
    const option = { model: 'macos', backdrop: '#fff' } as const
    const resolved = resolveTextTone(option)!
    const dilation = (emPx: number): number =>
      emPx < resolved.bigPx ? Math.min(resolved.dilationEm * emPx, resolved.dilationPx) : 0

    it.each([
      ['the default bake', undefined, BAKE_SIZE],
      ['a 48 texel bake', 48, 48],
    ])(
      'lifts the beauty contour by d below the size where it stops, with %s',
      (_, option48, bake) => {
        const { atlas, material } = create({
          tone: option,
          ...(option48 === undefined ? {} : { bakeSize: option48 }),
        })
        const [fill] = coverageRamps(material, atlas, [material.colorNode!])
        const [cast] = coverageRamps(material, atlas, [material.maskShadowNode!])
        expect(cast).not.toBe(fill)
        // 9, 24 and 72 pixels per em, the last one before the stop, and two past it.
        for (const emPx of [9, 24, 72, 255, 256, 400]) {
          const screenPxRange = (emPx * PX_RANGE) / bake
          if (screenPxRange < 1) continue
          const d = dilation(emPx)
          for (const field of FIELDS) {
            const sample = evaluator(material, atlas, { field, screenPxRange })
            // The empty-field cap comes first: a glyph of a few pixels takes the lift that fits.
            const foot = Math.min(d + 0.5 - screenPxRange * 0.5, 0)
            expect(sample(fill!).coverage, `${String(emPx)} px`).toBeCloseTo(
              clamp01(screenPxRange * field + foot),
              10,
            )
            // The shadow map keeps the baked contour.
            expect(sample(cast!).coverage).toBeCloseTo(
              clamp01(screenPxRange * (field - 0.5) + 0.5),
              10,
            )
          }
        }
        expect(dilation(9)).toBeCloseTo(0.0522, 4)
        expect(dilation(72)).toBe(0.3)
        expect(dilation(256)).toBe(0)
      },
    )

    it('keeps the dilation where the field ends inside the ramp, on a steeper ramp', () => {
      const { atlas, material } = create({ tone: option })
      const [fill] = coverageRamps(material, atlas, [material.colorNode!])
      const [cast] = coverageRamps(material, atlas, [material.maskShadowNode!])
      // From the floor of the range up to where a whole pixel of ramp fits beside the lift.
      for (const screenPxRange of [1, 1.03, 1.07, 1.1, 1.2, 2]) {
        const d = dilation((screenPxRange * BAKE_SIZE) / PX_RANGE)
        const slope = Math.max(screenPxRange, screenPxRange / (screenPxRange - 2 * d))
        const shown = (field: number): number =>
          evaluator(material, atlas, { field, screenPxRange })(fill!).coverage
        const where = `range ${String(screenPxRange)}`
        // The empty rest of the cell stays exactly empty.
        expect(shown(0), where).toBe(0)
        // The middle of the ramp lies d pixels outside the baked contour: the whole dilation.
        expect(shown(0.5 - d / screenPxRange), where).toBeCloseTo(0.5, 10)
        expect(shown(0.5), where).toBeCloseTo(clamp01(0.5 + (slope * d) / screenPxRange), 10)
        expect(shown(0.5), where).toBeGreaterThanOrEqual(0.5 + d - 1e-12)
        for (const field of [0.1, 0.3, 0.45, 0.55, 0.8])
          expect(shown(field), where).toBeCloseTo(
            clamp01(slope * (field - 0.5 + d / screenPxRange) + 0.5),
            10,
          )
        // With room for it, the ramp is the one pixel of every other size.
        if (screenPxRange >= 1 + 2 * d) expect(slope).toBe(screenPxRange)
        // The shadow map keeps the baked contour and its ramp.
        expect(evaluator(material, atlas, { field: 0.5, screenPxRange })(cast!).coverage).toBe(0.5)
      }
    })

    it('applies the ink-class table below that size only', () => {
      const { atlas, material } = create({ tone: option })
      const [fill] = coverageRamps(material, atlas, [material.colorNode!])
      const [toned] = tonedNodes(material, 'min')
      for (const ink of INKS) {
        const terms = inkTerms(resolved, ink)
        for (const emPx of [16, 128, 256, 512]) {
          const screenPxRange = (emPx * PX_RANGE) / BAKE_SIZE
          const sample = evaluator(material, atlas, { field: 0.49, screenPxRange, terms })
          const model = emPx < resolved.bigPx ? resolved : { ...resolved, table: 0 as const }
          expect(sample(toned!).coverage, `${String(ink)} at ${String(emPx)} px`).toBeCloseTo(
            toneCoverage(model, ink, sample(fill!).coverage),
            12,
          )
        }
      }
    })

    it('raises the ink by sampling the field d pixels lower on screen', () => {
      const { atlas, material } = create({ tone: option })
      const samples = (graph: Node): (Node & { uvNode: Node })[] => {
        const found = new Set<Node & { uvNode: Node }>()
        walk(graph, (node) => {
          if ('value' in node && node.value === atlas && 'uvNode' in node)
            found.add(node as Node & { uvNode: Node })
        })
        return [...found]
      }
      const derivative = (node: Node): boolean => isMath(node, 'dFdy')
      // Screen-up derivative times the rise, subtracted from the glyph UV: the sample below.
      const [beauty] = samples(material.colorNode!)
      expect(reaches(beauty!.uvNode, derivative)).toBe(true)
      // Three builds `sub` as an assignable OperatorNode itself, not wrapped in a VarNode.
      const lowered = beauty!.uvNode as Node & { op?: string; bNode?: Node }
      expect(lowered.op).toBe('-')
      expect(reaches(lowered.bNode!, derivative)).toBe(true)
      const [cast] = samples(material.maskShadowNode!)
      expect(reaches(cast!.uvNode, derivative)).toBe(false)
      // The other models sample the glyph UV as it is.
      const plain = create({ tone: { model: 'windows' } })
      const [other] = (() => {
        const found: (Node & { uvNode: Node })[] = []
        walk(plain.material.colorNode!, (node) => {
          if ('value' in node && node.value === plain.atlas && 'uvNode' in node)
            found.push(node as Node & { uvNode: Node })
        })
        return found
      })()
      expect(reaches(other!.uvNode, derivative)).toBe(false)
    })

    it('leaves colour glyphs on their contour, undilated', () => {
      const { atlas, material } = createLayered({ tone: option })
      const [fill] = coverageRamps(material, atlas, [material.colorNode!])
      const screenPxRange = 3
      const d = dilation((screenPxRange * BAKE_SIZE) / PX_RANGE)
      const text = evaluator(material, atlas, { field: 0.45, screenPxRange, inBand: 0 })
      const colour = evaluator(material, atlas, { field: 0.45, screenPxRange, inBand: 1 })
      expect(text(fill!).coverage).toBeCloseTo(clamp01(3 * (0.45 - 0.5) + 0.5 + d), 10)
      expect(colour(fill!).coverage).toBeCloseTo(clamp01(3 * (0.45 - 0.515) + 0.5), 10)
    })

    it('follows a later tone through its uniforms and refuses one of another kind', () => {
      const { material } = create({ tone: option })
      const graph = material.colorNode
      const dark = resolveTextTone({ model: 'macos', backdrop: '#000', strength: 0.5 })!
      expect(material.setTone(dark)).toBe(true)
      expect(material.colorNode).toBe(graph)
      expect(material.tone!.resolved).toBe(dark)
      expect(material.setTone(resolveTextTone({ model: 'outline' }))).toBe(false)
      expect(material.tone!.resolved).toBe(dark)
      const twin = material.clone()
      materials.push(twin)
      expect(twin.tone!.resolved).toBe(dark)
      expect(twin.tone!.dilates).toBe(true)
    })
  })
})
