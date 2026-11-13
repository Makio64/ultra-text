import { DoubleSide, FrontSide, Texture, type Node, type NodeMaterial } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { bool, setCurrentStack, stack, uniform, vec3, vec4 } from 'three/tsl'

import { createRectMaterial } from '../src/text/RectMaterial.js'
import { SdfTextMaterial } from '../src/text/SdfTextMaterial.js'
import type { TextVertexContext } from '../src/types.js'
import { traversePass } from './helpers/pass-graph.js'

describe('TSL materials', () => {
  it('filters fills, outlines, and drop shadows equally without supersampling scene shadows', () => {
    const atlas = new Texture()
    const material = new SdfTextMaterial({
      atlas,
      atlasWidth: 128,
      atlasHeight: 64,
      pxRange: 24,
      quality: 'high',
      outline: { width: 1.2 },
      dropShadow: { offsetX: 4 },
    })
    const samples = (graph: Node, pass: 'beauty' | 'shadow' = 'beauty'): object[] => {
      const result = new Set<object>()
      const references = new Set<unknown>()
      traversePass(graph, pass, (node) => {
        if ('value' in node && node.value === atlas) {
          result.add(node)
          // TextureNode.grad() retains a base node for the texture binding;
          // that reference is not another GPU lookup.
          if ('referenceNode' in node) references.add(node.referenceNode)
        }
      })
      return [...result].filter((node) => !references.has(node))
    }
    const beauty = samples(material.colorNode!)
    // The fill and the outline's silhouette share their four taps; the drop shadow has four.
    expect(beauty).toHaveLength(8)
    const cast = samples(material.maskShadowNode!)
    expect(cast).toHaveLength(2)
    // Three builds a shadow pass from the colour graph's alpha as well as from the mask.
    // There the graph shows the mask's own two lookups: no beauty contour is evaluated.
    const pass = samples(material.colorNode!, 'shadow')
    expect(pass).toHaveLength(2)
    expect(new Set(pass)).toEqual(new Set(cast))
    // Mip selection must use the unclamped glyph UV footprint at cell borders.
    for (const node of beauty) expect(node).toHaveProperty('gradNode', expect.any(Array))
    material.dispose()
    atlas.dispose()
  })

  it('keeps a custom fill masked, animated through caller uniforms, and reproducible by cloning', () => {
    const phase = uniform(0)
    let builds = 0
    const material = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      fill: ({ uv, color, position, glyphIndex }) => {
        builds++
        return vec4(color.mul(uv.x.add(position.y).add(glyphIndex).add(phase)), uv.y)
      },
      outline: { width: 2, color: 'red' },
      dropShadow: { offsetX: 4, offsetY: -3, color: 'blue' },
    })
    expect(builds).toBe(1)
    const graph = material.colorNode
    phase.value = 0.5
    expect(material.colorNode).toBe(graph)
    const twin = material.clone()
    expect(builds).toBe(2)
    expect(twin.colorNode).not.toBe(graph)
    let phaseFound = false
    twin.colorNode!.traverse((node) => {
      if (node === phase) phaseFound = true
    })
    expect(phaseFound).toBe(true)
    expect(twin.maskShadowNode).toBeTruthy()
    material.dispose()
    twin.dispose()
  })

  it('evaluates a custom vertex hook in static, animated, cloned, and size-switched position graphs', () => {
    const wave = uniform(4)
    const contexts: TextVertexContext[] = []
    const vertex = (context: TextVertexContext) => {
      contexts.push(context)
      const { position, center, uv, glyphIndex, sequence, rect, clip } = context
      return vec3(
        position.x.add(center.x).add(uv.x).add(rect.x),
        position.y.add(sequence).add(clip.y),
        position.z.add(glyphIndex).add(wave),
      )
    }
    const staticMaterial = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      motion: false,
      vertex,
      keepGlyph: () => bool(true),
    })
    const buildPosition = (graph: Node | null): Node => {
      const call = ((graph as unknown as { positionNode?: Node } | null)?.positionNode ??
        graph) as unknown as {
        shaderNode: { jsFunc(): Node }
      }
      setCurrentStack(stack())
      try {
        return call.shaderNode.jsFunc()
      } finally {
        setCurrentStack(null)
      }
    }
    const hasWave = (graph: Node | null): boolean => {
      let found = false
      buildPosition(graph).traverse((node) => {
        if (node === wave) found = true
      })
      return found
    }
    expect(hasWave(staticMaterial.positionNode)).toBe(true)
    expect(contexts).toHaveLength(1)
    expect(Object.keys(contexts[0] ?? {}).sort()).toEqual([
      'center',
      'clip',
      'glyphIndex',
      'position',
      'rect',
      'sequence',
      'uv',
    ])
    for (const node of Object.values(contexts[0] ?? {})) {
      expect(typeof node).toBe('object')
    }
    expect(hasWave(staticMaterial.castShadowPositionNode)).toBe(true)

    const animatedTwin = staticMaterial.withMotion({ enabled: true, mode: 'offset' })
    expect(animatedTwin.animated).toBe(true)
    expect(hasWave(animatedTwin.positionNode)).toBe(true)
    expect(contexts).toHaveLength(3)

    const clone = animatedTwin.clone()
    expect(hasWave(clone.positionNode)).toBe(true)
    expect(contexts).toHaveLength(4)

    staticMaterial.dispose()
    animatedTwin.dispose()
    clone.dispose()
  })

  it('rejects invalid effect geometry before constructing a graph', () => {
    const options = { atlas: new Texture(), atlasWidth: 64, atlasHeight: 64, pxRange: 12 }
    expect(() => new SdfTextMaterial({ ...options, outline: { width: -1 } })).toThrow(RangeError)
    expect(() => new SdfTextMaterial({ ...options, dropShadow: { offsetX: NaN } })).toThrow(
      RangeError,
    )
    options.atlas.dispose()
  })
  it('configures the SDF text graph and updates motion only through uniforms', () => {
    const atlas = new Texture()
    const material = new SdfTextMaterial({
      atlas,
      atlasWidth: 128,
      atlasHeight: 64,
      pxRange: 8,
      quality: 'high',
      side: DoubleSide,
      threshold: 0.52,
      shadowCutoff: 0.72,
      maxSequence: 12,
      motion: { enabled: false, mode: 'scale', strength: 7, speed: 2, stagger: 0.1 },
    })

    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.forceSinglePass).toBe(true)
    expect(material.shadowSide).toBe(DoubleSide)
    expect(material.threshold.value).toBe(0.52)
    expect(material.shadowCutoff.value).toBe(0.72)
    expect(material.unitRange.value.toArray()).toEqual([8 / 128, 8 / 64])
    expect(material.motionEnabled.value).toBe(0)
    expect(material.motionStrength.value).toBe(7)
    expect(material.maxSequence.value).toBe(12)
    expect(material.positionNode).toBeTruthy()
    expect(material.maskNode).toBeTruthy()
    expect(material.maskShadowNode).toBeTruthy()
    let shadowCutoffReferences = 0
    material.maskShadowNode!.traverse((node) => {
      if (node === material.shadowCutoff) shadowCutoffReferences++
    })
    expect(shadowCutoffReferences).toBe(2)
    // The toned coverage is read several times; a lookup is one node however often it is.
    const beautyAtlasSamples = new Set<object>()
    const shadowAtlasSamples = new Set<object>()
    traversePass(material.colorNode!, 'beauty', (node) => {
      if ('value' in node && node.value === atlas) beautyAtlasSamples.add(node)
    })
    material.maskShadowNode!.traverse((node) => {
      if ('value' in node && node.value === atlas) shadowAtlasSamples.add(node)
    })
    expect(beautyAtlasSamples.size).toBe(4)
    expect(shadowAtlasSamples.size).toBe(1)
    // The pass three derives for a shadow map reads the colour graph's alpha: at high
    // quality too, that is the mask's single lookup and none of the four beauty ones.
    const passAtlasSamples = new Set<object>()
    traversePass(material.colorNode!, 'shadow', (node) => {
      if ('value' in node && node.value === atlas) passAtlasSamples.add(node)
    })
    expect(passAtlasSamples).toEqual(shadowAtlasSamples)

    const positionNode = material.positionNode
    material.setMotion({ enabled: true, mode: 'offset', strength: -1, speed: -2, stagger: -3 })
    expect(material.motionEnabled.value).toBe(1)
    expect(material.motionStrength.value).toBe(0)
    expect(material.motionSpeed.value).toBe(0)
    expect(material.motionStagger.value).toBe(0)
    expect(material.positionNode).toBe(positionNode)
    material.dispose()
  })

  it('clamps the shadow silhouette threshold to a normalized uniform', () => {
    const low = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 16,
      atlasHeight: 16,
      pxRange: 2,
      shadowCutoff: -1,
    })
    const high = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 16,
      atlasHeight: 16,
      pxRange: 2,
      shadowCutoff: 2,
    })
    const defaulted = new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 16,
      atlasHeight: 16,
      pxRange: 2,
    })

    expect(low.shadowCutoff.value).toBe(0)
    expect(high.shadowCutoff.value).toBe(1)
    expect(defaulted.shadowCutoff.value).toBe(0.5)
    // The baked contour with no extra weight, shown through the default tone.
    expect(defaulted.threshold.value).toBe(0.5)
    expect(defaulted.stemDarkening.value).toBe(0)
    expect(defaulted.tone?.resolved).toMatchObject({ strength: 1, backdrop: 1, table: 0 })
    // A material has no source element, so only a named backdrop is a known one: without it
    // a model's ink table stays off, and white ink keeps its exact coverage.
    const atlas = { atlas: new Texture(), atlasWidth: 16, atlasHeight: 16, pxRange: 2 }
    const unknown = new SdfTextMaterial({ ...atlas, tone: { model: 'windows' } })
    const named = new SdfTextMaterial({ ...atlas, tone: { model: 'windows', backdrop: '#fff' } })
    expect(unknown.tone?.resolved).toMatchObject({ backdrop: 1, table: 0 })
    expect(unknown.tone?.ink.value.toArray()).toEqual([1, 1, 0])
    expect(named.tone?.resolved).toMatchObject({ backdrop: 1, table: 1 })
    expect(named.tone?.ink.value.toArray()).toEqual([1, 1, 1 / 3])
    low.dispose()
    high.dispose()
    defaulted.dispose()
    unknown.dispose()
    named.dispose()
  })

  it('clones by rebuilding the graph from its construction options', () => {
    // The regression: three's Material.clone() constructs the concrete class with no
    // arguments, which used to throw `Cannot read properties of undefined (reading 'side')`
    // before copy() ever ran — the crash any consumer hit the first time anything cloned a
    // text material.
    const atlas = new Texture()
    const material = new SdfTextMaterial({
      atlas,
      atlasWidth: 128,
      atlasHeight: 64,
      pxRange: 8,
      quality: 'high',
      side: DoubleSide,
      threshold: 0.52,
      maxSequence: 12,
      motion: { enabled: false, mode: 'scale', strength: 7 },
    })
    // Post-construction mutations, which the clone must carry alongside the options.
    material.threshold.value = 0.6
    material.setMotion({ speed: 3 })
    material.wireframe = true
    material.visible = false

    const twin = material.clone()

    expect(twin).toBeInstanceOf(SdfTextMaterial)
    expect(twin).not.toBe(material)
    // The graph is rebuilt, not shared: the twin's knobs steer the twin's own graph.
    expect(twin.positionNode).not.toBe(material.positionNode)
    expect(twin.threshold).not.toBe(material.threshold)
    let twinThresholdReferences = 0
    twin.maskShadowNode!.traverse((node) => {
      if (node === twin.shadowCutoff) twinThresholdReferences++
      // The twin's graph must never reach back into the source's uniforms.
      expect(node).not.toBe(material.shadowCutoff)
    })
    expect(twinThresholdReferences).toBe(2)
    // The atlas itself is shared on purpose; its metrics came through the options.
    const twinAtlasSamples = new Set<object>()
    traversePass(twin.colorNode!, 'beauty', (node) => {
      if ('value' in node && node.value === atlas) twinAtlasSamples.add(node)
    })
    expect(twinAtlasSamples.size).toBe(4)
    expect(twin.quality).toBe('high')
    expect(twin.unitRange.value.toArray()).toEqual([8 / 128, 8 / 64])
    // Options, uniform mutations and material flags all carried.
    expect(twin.side).toBe(DoubleSide)
    expect(twin.forceSinglePass).toBe(true)
    expect(twin.threshold.value).toBe(0.6)
    expect(twin.motionSpeed.value).toBe(3)
    expect(twin.motionEnabled.value).toBe(0)
    expect(twin.motionStrength.value).toBe(7)
    expect(twin.maxSequence.value).toBe(12)
    expect(twin.wireframe).toBe(true)
    expect(twin.visible).toBe(false)
    // Independent after the fact.
    twin.threshold.value = 0.4
    expect(material.threshold.value).toBe(0.6)
    material.dispose()
    twin.dispose()
  })

  it('clones the lit rect material without losing its shadow floor', () => {
    const lit = createRectMaterial(true, 0.42)
    const twin = lit.clone()
    const floorOf = (candidate: NodeMaterial): number =>
      (candidate as unknown as { shadowFloor: { value: number } }).shadowFloor.value
    expect(floorOf(twin)).toBe(0.42)
    lit.dispose()
    twin.dispose()
  })

  it('creates front-sided rounded rect graphs in lit and unlit variants', () => {
    const unlit = createRectMaterial(false)
    const lit = createRectMaterial(true)
    for (const material of [unlit, lit]) {
      expect(material.side).toBe(FrontSide)
      expect(material.depthWrite).toBe(true)
      expect(material.positionNode).toBeTruthy()
      expect(material.maskNode).toBeTruthy()
      expect(material.maskShadowNode).toBeTruthy()
      material.dispose()
    }
  })

  it('clamps the lit receiver shadow floor and defaults it', () => {
    const read = (material: NodeMaterial): number =>
      (material as NodeMaterial & { shadowFloor: { value: number } }).shadowFloor.value

    const defaulted = createRectMaterial(true)
    const soft = createRectMaterial(true, 0.62)
    const low = createRectMaterial(true, -1)
    const high = createRectMaterial(true, 5)

    expect(read(defaulted)).toBe(0.24)
    expect(read(soft)).toBe(0.62)
    expect(read(low)).toBe(0)
    expect(read(high)).toBe(1)
    for (const material of [defaulted, soft, low, high]) material.dispose()
  })
})

describe('SDF colour variant', () => {
  it('provides the painted base and weight to fills, preserves clones, and excludes colour from shadows', () => {
    const atlas = new Texture()
    const color = new Texture()
    const contexts: unknown[] = []
    const material = new SdfTextMaterial({
      atlas,
      atlasWidth: 64,
      atlasHeight: 128,
      pxRange: 12,
      colorLayer: { texture: color, top: 64, height: 64 },
      outline: { width: 2 },
      fill: (context) => {
        contexts.push(context)
        return vec4(context.color, 1)
      },
    })
    const references = (graph: Node) => {
      let count = 0
      graph.traverse((node) => {
        if ('value' in node && node.value === color) count++
      })
      return count
    }
    expect(contexts[0]).toHaveProperty('colorWeight')
    expect(references(material.colorNode!)).toBeGreaterThan(0)
    const shadowMaterial = new SdfTextMaterial({
      atlas,
      atlasWidth: 64,
      atlasHeight: 128,
      pxRange: 12,
      colorLayer: { texture: color, top: 64, height: 64 },
    })
    expect(references(shadowMaterial.maskShadowNode!)).toBe(0)
    shadowMaterial.dispose()
    const twin = material.clone()
    expect(contexts).toHaveLength(2)
    expect(references(twin.colorNode!)).toBeGreaterThan(0)
    expect(twin.colorNode).not.toBe(material.colorNode)
    material.dispose()
    twin.dispose()
  })
  it('passes constant zero weight to fills without a colour layer', () => {
    let weight: Node<'float'> | undefined
    new SdfTextMaterial({
      atlas: new Texture(),
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      fill: ({ color, colorWeight }) => {
        weight = colorWeight
        return vec4(color, 1)
      },
    })
    let zero = false
    weight!.traverse((node) => {
      if ('value' in node && node.value === 0) zero = true
    })
    expect(zero).toBe(true)
  })
})
