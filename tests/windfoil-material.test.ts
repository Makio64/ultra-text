import {
  DoubleSide,
  FrontSide,
  StorageBufferAttribute,
  type Node,
  type StorageBufferNode,
} from 'three/webgpu'
import { NodeAccess, storage } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { resolveTextTone } from '../src/text/tone.js'
import { WindfoilMaterial } from '../src/windfoil/WindfoilMaterial.js'

function createStorage(): {
  curves: StorageBufferNode<'vec2'>
  rows: StorageBufferNode<'uint'>
} {
  // One band: its square's pieces by descending xMax, then by ascending xMin.
  const curvesAttribute = new StorageBufferAttribute(
    new Float32Array([
      0, 0, 5, 0, 10, 0, 10, 0, 10, 5, 10, 10, 10, 10, 5, 10, 0, 10, 0, 10, 0, 5, 0, 0, 0, 10, 0, 5,
      0, 0, 0, 0, 5, 0, 10, 0, 10, 10, 5, 10, 0, 10, 10, 0, 10, 5, 10, 10,
    ]),
    2,
  )
  const rowsAttribute = new StorageBufferAttribute(new Uint32Array([0, 4, 0, 0, 0, 0]), 1)
  return {
    curves: storage(curvesAttribute, 'vec2', curvesAttribute.count).toReadOnly(),
    rows: storage(rowsAttribute, 'uint', rowsAttribute.count).toReadOnly(),
  }
}

function countReferences(root: Node, target: Node): number {
  let references = 0
  root.traverse((node) => {
    if (node === target) references++
  })
  return references
}

describe('Windfoil TSL material', () => {
  it('clones by rebuilding the graph from its construction options', () => {
    const material = new WindfoilMaterial({ ...createStorage(), side: DoubleSide })
    material.shadowCutoff.value = 0.3
    material.setMotion({ speed: 3 })

    const twin = material.clone()

    expect(twin).toBeInstanceOf(WindfoilMaterial)
    expect(twin).not.toBe(material)
    expect(twin.positionNode).not.toBe(material.positionNode)
    expect(twin.side).toBe(DoubleSide)
    expect(twin.shadowCutoff).not.toBe(material.shadowCutoff)
    expect(twin.shadowCutoff.value).toBe(0.3)
    expect(twin.motionSpeed.value).toBe(3)
    material.dispose()
    twin.dispose()
  })

  it('configures analytic coverage with the shared retained-text graph', () => {
    const buffers = createStorage()
    const material = new WindfoilMaterial({
      ...buffers,
      side: DoubleSide,
      shadowCutoff: 0.72,
      maxSequence: 12,
      motion: { enabled: false, mode: 'scale', strength: 7, speed: 2, stagger: 0.1 },
    })

    expect(buffers.curves.access).toBe(NodeAccess.READ_ONLY)
    expect(buffers.rows.access).toBe(NodeAccess.READ_ONLY)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.depthTest).toBe(true)
    expect(material.side).toBe(DoubleSide)
    expect(material.shadowSide).toBe(DoubleSide)
    expect(material.forceSinglePass).toBe(true)
    expect(material.toneMapped).toBe(false)
    expect(material.shadowCutoff.value).toBe(0.72)
    expect(material.motionEnabled.value).toBe(0)
    expect(material.motionStrength.value).toBe(7)
    expect(material.maxSequence.value).toBe(12)
    expect(material.positionNode).toBeTruthy()
    expect(material.castShadowPositionNode).toBe(material.positionNode)
    expect(material.colorNode).toBeTruthy()
    expect(material.maskNode).toBeTruthy()
    expect(material.maskShadowNode).toBeTruthy()
    expect(countReferences(material.maskShadowNode!, material.shadowCutoff)).toBe(2)

    const positionNode = material.positionNode
    material.setMotion({ enabled: true, mode: 'offset', strength: -1, speed: -2, stagger: -3 })
    expect(material.motionEnabled.value).toBe(1)
    expect(material.motionStrength.value).toBe(0)
    expect(material.motionSpeed.value).toBe(0)
    expect(material.motionStagger.value).toBe(0)
    expect(material.positionNode).toBe(positionNode)
    material.dispose()
  })

  it('defaults to a front-sided half-coverage shadow and clamps overrides', () => {
    const defaulted = new WindfoilMaterial(createStorage())
    const low = new WindfoilMaterial({ ...createStorage(), shadowCutoff: -1 })
    const high = new WindfoilMaterial({ ...createStorage(), shadowCutoff: 2 })

    expect(defaulted.side).toBe(FrontSide)
    expect(defaulted.shadowSide).toBe(FrontSide)
    expect(defaulted.forceSinglePass).toBe(false)
    expect(defaulted.shadowCutoff.value).toBe(0.5)
    expect(low.shadowCutoff.value).toBe(0)
    expect(high.shadowCutoff.value).toBe(1)
    defaulted.dispose()
    low.dispose()
    high.dispose()
  })

  it('tones text ink by default, on beauty coverage alone', () => {
    const toned = new WindfoilMaterial(createStorage())
    const exact = new WindfoilMaterial({ ...createStorage(), tone: false })
    const dark = new WindfoilMaterial({
      ...createStorage(),
      tone: { backdrop: '#000000', strength: 0.5, model: 'windows' },
    })
    const resolved = resolveTextTone({ strength: 0.2 })!
    const given = new WindfoilMaterial({ ...createStorage(), tone: resolved })

    expect(exact.tone).toBeNull()
    // No source element here: the exact outline read against white, at full strength.
    expect(toned.tone!.resolved).toEqual({
      strength: 1,
      backdrop: 1,
      table: 0,
      dilationEm: 0,
      dilationPx: 0,
      bigPx: 0,
      framed: false,
    })
    // A named backdrop is the caller's word that the scene draws it behind the text.
    expect(dark.tone!.resolved).toMatchObject({
      strength: 0.5,
      backdrop: 0,
      table: 1,
      framed: true,
    })
    expect(dark.tone!.ink.value.toArray()).toEqual([0, 0.5, 0.5 / 3])
    expect(given.tone!.resolved).toBe(resolved)

    const { curve, ink } = toned.tone!
    expect(countReferences(toned.colorNode!, curve)).toBeGreaterThan(0)
    expect(countReferences(toned.maskNode!, curve)).toBeGreaterThan(0)
    // The per-glyph terms reach the fragment through one varying fed by the ink uniform.
    expect(countReferences(toned.colorNode!, ink)).toBeGreaterThan(0)
    // Shadow silhouettes keep the exact coverage.
    expect(countReferences(toned.maskShadowNode!, curve)).toBe(0)
    expect(countReferences(toned.maskShadowNode!, ink)).toBe(0)
    for (const material of [toned, exact, dark, given]) material.dispose()
  })

  it('follows a recaptured tone through its uniforms and says when it needs a rebuild', () => {
    const toned = new WindfoilMaterial(createStorage())
    const exact = new WindfoilMaterial({ ...createStorage(), tone: false })
    const colorNode = toned.colorNode

    const dark = resolveTextTone({ backdrop: '#000000', strength: 0.25, model: 'windows' })!
    expect(toned.setTone(dark)).toBe(true)
    expect(toned.tone!.resolved).toBe(dark)
    expect(toned.tone!.ink.value.toArray()).toEqual([0, 0.25, 0.25 / 3])
    expect(toned.tone!.curve.value.toArray()).toEqual([0.012522878, 0.682171111, 0.75])
    expect(toned.colorNode).toBe(colorNode)

    // A graph without the conversion, or with the macOS model's nodes, is another material.
    expect(toned.setTone(null)).toBe(false)
    expect(toned.setTone(resolveTextTone({ model: 'macos' }))).toBe(false)
    expect(toned.tone!.resolved).toBe(dark)
    expect(exact.setTone(null)).toBe(true)
    expect(exact.setTone(dark)).toBe(false)
    expect(exact.tone).toBeNull()

    const twin = toned.clone()
    expect(twin.tone).not.toBe(toned.tone)
    expect(twin.tone!.curve).not.toBe(toned.tone!.curve)
    expect(twin.tone!.resolved).toBe(dark)
    expect(twin.tone!.ink.value.toArray()).toEqual([0, 0.25, 0.25 / 3])
    expect(exact.clone().tone).toBeNull()
    for (const material of [toned, exact, twin]) material.dispose()
  })

  it('builds the macOS model as a graph of its own, whose law follows the tone uniforms', () => {
    const macos = new WindfoilMaterial({
      ...createStorage(),
      tone: { model: 'macos', backdrop: '#ffffff' },
    })
    const tone = macos.tone!
    expect(tone.dilates).toBe(true)
    expect(tone.resolved).toMatchObject({
      table: 1,
      dilationEm: 0.0058,
      dilationPx: 0.3,
      bigPx: 256,
    })
    expect(tone.dilation.value.toArray()).toEqual([0.0058, 0.3, 256])
    expect(tone.ink.value.toArray()).toEqual([1, 1, 1 / 3])
    // A material has no source element: without a named backdrop the model keeps its
    // dilation and loses its ink table, so light ink is neither lifted nor thinned.
    const unknown = new WindfoilMaterial({ ...createStorage(), tone: { model: 'macos' } })
    expect(unknown.tone!.dilates).toBe(true)
    expect(unknown.tone!.resolved).toMatchObject({ backdrop: 1, table: 0, dilationPx: 0.3 })
    expect(unknown.tone!.ink.value.toArray()).toEqual([1, 1, 0])
    unknown.dispose()
    // The other models share one graph, which holds nothing of the dilation.
    const plain = new WindfoilMaterial(createStorage())
    expect(plain.tone!.dilates).toBe(false)

    // Another law of the same model needs no rebuild; a model that keeps the outline does.
    const colorNode = macos.colorNode
    const wider = { ...tone.resolved, backdrop: 0, dilationEm: 0.01, dilationPx: 0.5, bigPx: 128 }
    expect(macos.setTone(wider)).toBe(true)
    expect(tone.dilation.value.toArray()).toEqual([0.01, 0.5, 128])
    expect(macos.colorNode).toBe(colorNode)
    expect(macos.setTone(resolveTextTone({ model: 'windows' }))).toBe(false)
    expect(macos.setTone(null)).toBe(false)
    expect(tone.resolved).toBe(wider)

    const twin = macos.clone()
    expect(twin.tone!.dilates).toBe(true)
    expect(twin.tone!.dilation).not.toBe(tone.dilation)
    expect(twin.tone!.dilation.value.toArray()).toEqual([0.01, 0.5, 128])
    for (const material of [macos, plain, twin]) material.dispose()
  })
})
