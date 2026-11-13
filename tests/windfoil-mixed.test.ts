import {
  type InstancedBufferAttribute,
  InstancedBufferGeometry,
  Texture,
  WebGPUBackend,
  type WebGPURenderer,
} from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'
import type {
  DomLayoutSnapshot,
  DomSdfOptions,
  FontStyleSnapshot,
  GlyphRequest,
  GlyphSlot,
  SdfAtlas,
  WindfoilGlyphOutline,
  WindfoilOptions,
  WindfoilOutlineProvider,
} from '../src/types.js'
import { buildWindfoilBackend, type WindfoilBackend } from '../src/windfoil/runtime.js'
import { buildSlugBackend } from '../src/slug/runtime.js'
import { createExtraTextParts } from '../src/windfoil/mixed.js'
import { glyphRectTable } from '../src/text/decorations.js'
import { disposeShaderRenderer, fragmentWgsl, shaderRenderer } from './helpers/wgsl-build.js'

const font: FontStyleSnapshot = {
  key: 'font',
  canvasFont: '10px Test',
  family: 'Test',
  weight: '400',
  style: 'normal',
  stretch: 'normal',
  variant: 'normal',
  kerning: 'auto',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'auto',
  size: 10,
}
const square: WindfoilGlyphOutline = {
  unitsPerEm: 10,
  ascent: 10,
  descent: 0,
  bbox: [0, 0, 10, 10],
  quadratics: [0, 0, 5, 0, 10, 0, 10, 0, 10, 5, 10, 10, 10, 10, 5, 10, 0, 10, 0, 10, 0, 5, 0, 0],
}
function snapshot(keys = ['a', 'blank', 'color', 'sdf', 'a']): DomLayoutSnapshot {
  return {
    width: 100,
    height: 40,
    lineCount: 1,
    atlasSignature: 'mixed',
    rects: [],
    blocks: [],
    requests: [...new Set(keys)].map((key) => ({ key, character: key, font })),
    glyphs: keys.map((key, index) => ({
      glyphKey: key,
      fontSize: 10,
      originX: index * 12,
      lineBottom: 3,
      advance: 10,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 100, 40],
      color: [1, 1, 1, 1],
      sequence: index * 2,
      z: 1,
    })),
  }
}
async function setup(layout = snapshot()) {
  const texture = new Texture()
  const atlas: SdfAtlas = {
    get texture() {
      return texture
    },
    width: 16,
    height: 16,
    pxRange: 2,
    bakeSize: 10,
    mode: 'cpu',
    glyphs: new Map([
      [
        'sdf',
        {
          key: 'sdf',
          character: 'sdf',
          fontKey: 'font',
          u0: 0,
          v0: 0,
          u1: 1,
          v1: 1,
          planeX0: 0,
          planeY0: 0,
          planeX1: 10,
          planeY1: 10,
          descent: 0,
          advance: 10,
        },
      ],
    ]),
    dispose: () => texture.dispose(),
  }
  const renderer = {
    init: () => Promise.resolve(),
    backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, { has: () => false }),
  } as unknown as WebGPURenderer
  const backend = (await buildWindfoilBackend(
    renderer,
    layout.requests,
    {
      fallback: 'sdf-glyphs',
      compositing: 'shader',
      outlineProvider: (request) => {
        if (request.key === 'sdf') return null
        if (request.key === 'blank') return { ...square, quadratics: [] }
        if (request.key === 'color')
          return {
            ...square,
            quadratics: [],
            layers: [
              { quadratics: square.quadratics, paint: { type: 'solid', color: [1, 0, 0, 1] } },
            ],
          }
        return square
      },
    },
    new AbortController().signal,
    { build: () => Promise.resolve(atlas) },
  ))!
  return { backend, atlas }
}

describe('mixed Windfoil content transactions', () => {
  it('preserves global drawable order and motion when combining three text batches', async () => {
    const layout = snapshot(),
      { backend } = await setup(layout)
    const primary = backend.createGeometry(layout, 0).geometry
    const extras = createExtraTextParts(layout, backend, { castShadow: false }, { enabled: false })
    expect(extras.meshes.map((mesh) => mesh.renderOrder)).toEqual([2.25, 2.5])
    expect(extras.meshes.every((mesh) => !mesh.castShadow && !mesh.frustumCulled)).toBe(true)
    expect(Array.from(backend.motionOrdinals(layout))).toEqual([0, -1, 1, 2, 3])
    expect(extras.meshes[0]!.geometry.getAttribute('windfoilLayers').getZ(0)).toBe(1)
    expect(extras.meshes[1]!.geometry.getAttribute('sdfRunMotion').getZ(0)).toBe(2)
    extras.mergeRects(layout, primary)
    expect(Array.from(glyphRectTable(primary)).slice(0, 16)).toEqual([
      0, 3, 10, 13, 24, 3, 34, 13, 36, 3, 46, 13, 48, 3, 58, 13,
    ])
    const moved: DomLayoutSnapshot = {
      ...layout,
      glyphs: layout.glyphs.map((glyph) => ({
        ...glyph,
        originX: glyph.originX + 1,
        sequence: glyph.sequence + 5,
      })),
    }
    const oldGeometries = extras.meshes.map((mesh) => mesh.geometry)
    const staged = extras.prepare(moved, 0)
    expect(staged).toEqual([null, null])
    backend.updateGeometry(primary, moved, 0)
    extras.commit(staged, moved, 0)
    extras.mergeRects(moved, primary)
    // Repeated merges must start from the primary's own table, never the previous merged table.
    extras.mergeRects(moved, primary)
    expect(Array.from(glyphRectTable(primary)).slice(0, 16)).toEqual([
      1, 3, 11, 13, 25, 3, 35, 13, 37, 3, 47, 13, 49, 3, 59, 13,
    ])
    expect(extras.meshes.map((mesh) => mesh.geometry)).toEqual(oldGeometries)
    expect(extras.meshes.map((mesh) => mesh.material.maxSequence.value)).toEqual([13, 13])
    const motion = extras.meshes.map((mesh) => vi.spyOn(mesh.material, 'setMotion'))
    extras.setMotion({ strength: 12 })
    for (const spy of motion) expect(spy).toHaveBeenCalledWith({ strength: 12 })
    primary.dispose()
    for (const mesh of extras.meshes) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    backend.dispose()
  })

  it('builds static colour and companion parts for motion: false, padded by the given strength', async () => {
    const layout = snapshot(),
      { backend } = await setup(layout)
    const animated = createExtraTextParts(layout, backend, {}, { strength: 30 })
    const still = createExtraTextParts(layout, backend, {}, false, 30)
    expect(animated.meshes.map((mesh) => mesh.material.animated)).toEqual([true, true])
    expect(still.meshes.map((mesh) => mesh.material.animated)).toEqual([false, false])
    // The live strength still pads the bounds of static parts.
    const unpadded = createExtraTextParts(layout, backend, {}, false, 0)
    for (const [index, mesh] of still.meshes.entries()) {
      const box = mesh.geometry.boundingSphere ?? mesh.geometry.boundingBox
      expect(box).toEqual(
        animated.meshes[index]!.geometry.boundingSphere ??
          animated.meshes[index]!.geometry.boundingBox,
      )
      expect(box).not.toEqual(
        unpadded.meshes[index]!.geometry.boundingSphere ??
          unpadded.meshes[index]!.geometry.boundingBox,
      )
    }
    for (const mesh of unpadded.meshes) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    for (const mesh of [...animated.meshes, ...still.meshes]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    backend.dispose()
  })

  it('stages count changes without releasing live geometry until commit', async () => {
    const layout = snapshot(),
      { backend } = await setup(layout)
    const extras = createExtraTextParts(layout, backend, {}, {})
    const old = extras.meshes.map((mesh) => mesh.geometry)
    const disposed = old.map((geometry) => vi.spyOn(geometry, 'dispose'))
    const next = snapshot(['color', 'sdf', 'color', 'sdf'])
    const staged = extras.prepare(next, 4)
    expect(staged.every((geometry) => geometry instanceof InstancedBufferGeometry)).toBe(true)
    for (const spy of disposed) expect(spy).not.toHaveBeenCalled()
    expect(extras.meshes.map((mesh) => mesh.geometry)).toEqual(old)
    extras.commit(staged, next, 4)
    for (const spy of disposed) expect(spy).toHaveBeenCalledOnce()
    expect(extras.meshes.map((mesh) => mesh.geometry.instanceCount)).toEqual([2, 2])
    for (const mesh of extras.meshes) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    backend.dispose()
  })

  it('releases staged colour geometry when the companion cannot be prepared', async () => {
    const layout = snapshot(),
      { backend, atlas } = await setup(layout)
    const extras = createExtraTextParts(layout, backend, {}, {})
    const create = vi.spyOn(backend.color!, 'createGeometry')
    const disposed = vi.spyOn(InstancedBufferGeometry.prototype, 'dispose')
    const old = extras.meshes.map((mesh) => mesh.geometry)
    const lookup = vi.spyOn(atlas.glyphs, 'get').mockImplementation(() => {
      throw new Error('companion unavailable')
    })
    expect(() => extras.prepare(snapshot(['color', 'color', 'sdf', 'sdf']), 0)).toThrow(
      'companion unavailable',
    )
    expect(create).toHaveBeenCalledOnce()
    const created = create.mock.results[0]!.value as ReturnType<
      NonNullable<typeof backend.color>['createGeometry']
    >
    expect(disposed.mock.instances).toEqual([created.geometry])
    expect(extras.meshes.map((mesh) => mesh.geometry)).toEqual(old)
    lookup.mockRestore()
    disposed.mockRestore()
    for (const mesh of extras.meshes) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    backend.dispose()
  })

  it('releases both partial parts if the SDF material fails after colour allocation', async () => {
    const layout = snapshot(),
      { backend, atlas } = await setup(layout)
    const original = backend.color!.createMaterial.bind(backend.color!)
    const create = vi.spyOn(backend.color!, 'createMaterial')
    const disposed = vi.spyOn(InstancedBufferGeometry.prototype, 'dispose')
    const materialDisposed = vi.fn()
    create.mockImplementation((options) => {
      create.mockRestore()
      const material = original(options)
      material.addEventListener('dispose', materialDisposed)
      return material
    })
    const texture = vi.spyOn(atlas, 'texture', 'get').mockImplementation(() => {
      throw new Error('material unavailable')
    })
    expect(() => createExtraTextParts(layout, backend, {}, {})).toThrow('material unavailable')
    expect(disposed).toHaveBeenCalledTimes(2)
    expect(materialDisposed).toHaveBeenCalledOnce()
    texture.mockRestore()
    disposed.mockRestore()
    backend.dispose()
  })
})

// ---------------------------------------------------------------------------------------------
// Outlines and drop shadows on analytic text

const EFFECT_KEYS = ['a', 'b', 'blank', 'color', 'clip', 'sdf']
/** A slot whose u0 names its glyph, so each instance's `sdfUvRect` says which glyph it draws. */
function keyedSlot(key: string, plane: readonly number[] = [0, 0, 10, 10]): GlyphSlot {
  const index = EFFECT_KEYS.indexOf(key)
  return {
    key,
    character: key,
    fontKey: 'font',
    u0: (index + 1) / 16,
    v0: 0,
    u1: (index + 2) / 16,
    v1: 1,
    planeX0: plane[0]!,
    planeY0: plane[1]!,
    planeX1: plane[2]!,
    planeY1: plane[3]!,
    descent: 0,
    advance: 10,
  }
}
/** A companion builder that bakes exactly the requested glyphs, as the SDF atlas build does. */
function bakingBuilder(effects?: DomSdfOptions, plane?: readonly number[]) {
  const disposed = vi.fn()
  const build = vi.fn((requests: readonly GlyphRequest[], _signal: AbortSignal) => {
    const texture = new Texture()
    return Promise.resolve<SdfAtlas>({
      texture,
      width: 16,
      height: 16,
      pxRange: 2,
      bakeSize: 10,
      mode: 'cpu',
      glyphs: new Map(requests.map((request) => [request.key, keyedSlot(request.key, plane)])),
      dispose: () => {
        disposed()
        texture.dispose()
      },
    })
  })
  return { build, disposed, ...(effects ? { effects } : {}) }
}
function fakeRenderer(): WebGPURenderer {
  return {
    init: () => Promise.resolve(),
    backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, { has: () => false }),
  } as unknown as WebGPURenderer
}
const layeredSquare: WindfoilGlyphOutline = {
  ...square,
  quadratics: [],
  layers: [{ quadratics: square.quadratics, paint: { type: 'solid', color: [1, 0, 0, 1] } }],
}
/** Plain squares, an empty outline, a layered glyph, a clipped one and one without outline. */
const effectProvider: WindfoilOutlineProvider = (request) => {
  if (request.key === 'sdf') return null
  if (request.key === 'blank') return { ...square, quadratics: [] }
  if (request.key === 'color') return layeredSquare
  if (request.key === 'clip') return { ...layeredSquare, clipBox: [0, 0, 6, 10] }
  return square
}
const EFFECTS: DomSdfOptions = { outline: { width: 1 }, dropShadow: {} }
type Built = Awaited<ReturnType<typeof buildWindfoilBackend>>
async function effectBackend(
  kind: 'windfoil' | 'slug',
  layout: DomLayoutSnapshot,
  options: Partial<WindfoilOptions>,
  builder: ReturnType<typeof bakingBuilder>,
): Promise<WindfoilBackend> {
  const build = kind === 'slug' ? buildSlugBackend : buildWindfoilBackend
  const backend: Built = await build(
    fakeRenderer(),
    layout.requests,
    { fallback: 'sdf-glyphs', outlineProvider: effectProvider, ...options },
    new AbortController().signal,
    builder,
  )
  return backend!
}
/** The glyphs an SDF part draws, read back from each instance's `sdfUvRect`. */
function sdfKeys(mesh: { geometry: InstancedBufferGeometry }): string[] {
  const uv = mesh.geometry.getAttribute('sdfUvRect') as InstancedBufferAttribute
  return Array.from(
    { length: mesh.geometry.instanceCount },
    (_, index) => EFFECT_KEYS[Math.round((uv.array[index * 4]! / 65535) * 16) - 1]!,
  )
}
function parts(extras: ReturnType<typeof createExtraTextParts>) {
  return extras.meshes.map((mesh) => [
    mesh.name,
    mesh.renderOrder,
    mesh.name.includes('colour') ? 'analytic' : sdfKeys(mesh).join(','),
  ])
}
function release(extras: ReturnType<typeof createExtraTextParts>, backend: WindfoilBackend) {
  for (const mesh of extras.meshes) {
    mesh.geometry.dispose()
    mesh.material.dispose()
  }
  backend.dispose()
}

describe('outlines and drop shadows on analytic text', () => {
  it('draws every glyph once: the underlay rings analytic glyphs, the SDF fallback the rest', async () => {
    const layout = snapshot(['a', 'blank', 'color', 'sdf', 'a'])
    const plain = bakingBuilder()
    const off = await effectBackend('windfoil', layout, { compositing: 'shader' }, plain)
    expect(plain.build.mock.calls.map(([requests]) => requests.map((r) => r.key))).toEqual([
      ['sdf'],
    ])
    const builder = bakingBuilder(EFFECTS)
    const backend = await effectBackend('windfoil', layout, { compositing: 'shader' }, builder)
    // The colour part's glyph is baked for its ring; the empty outline is drawn by nothing.
    expect(builder.build.mock.calls.map(([requests]) => requests.map((r) => r.key))).toEqual([
      ['sdf', 'a', 'color'],
    ])
    expect(backend.effects).toEqual(EFFECTS)
    expect(['a', 'blank', 'color', 'sdf'].map((key) => backend.analyticCovers(key))).toEqual([
      true,
      false,
      true,
      false,
    ])
    const extras = createExtraTextParts(layout, backend, EFFECTS, false)
    expect(parts(extras)).toEqual([
      ['ultra-text Windfoil colour glyphs', 2.25, 'analytic'],
      ['ultra-text text effects', 2, 'a,color,a'],
      ['ultra-text fallback glyphs', 2.5, 'sdf'],
    ])
    // Effects change neither the drawn glyphs nor their motion order.
    expect(Array.from(backend.motionOrdinals(layout))).toEqual([0, -1, 1, 2, 3])
    expect(Array.from(backend.motionOrdinals(layout))).toEqual(
      Array.from(off.motionOrdinals(layout)),
    )
    const drawable = (retained: WindfoilBackend) =>
      ['a', 'blank', 'color', 'sdf'].filter(
        (key) =>
          (retained.glyphs.get(key)?.monotonePieceCount ?? 0) > 0 ||
          !!retained.companion?.glyphs.has(key),
      )
    expect(drawable(backend)).toEqual(drawable(off))
    release(extras, backend)
    off.dispose()
    expect(builder.disposed).toHaveBeenCalledOnce()
  })

  it('gives a Slug glyph clipped by the colour part its ring, not a second SDF fill', async () => {
    const layout = snapshot(['a', 'clip', 'sdf'])
    const builder = bakingBuilder(EFFECTS)
    const backend = await effectBackend('slug', layout, {}, builder)
    expect(builder.build.mock.calls[0]![0].map((r) => r.key)).toEqual(['sdf', 'a', 'clip'])
    expect(backend.primaryCovers('clip')).toBe(false)
    expect(backend.analyticCovers('clip')).toBe(true)
    const extras = createExtraTextParts(layout, backend, EFFECTS, false)
    expect(parts(extras)).toEqual([
      ['ultra-text Windfoil colour glyphs', 2.25, 'analytic'],
      ['ultra-text text effects', 2, 'a,clip'],
      ['ultra-text fallback glyphs', 2.5, 'sdf'],
    ])
    release(extras, backend)
  })

  it('treats a zero outline width or opacity and a zero shadow opacity as no effects', async () => {
    const layout = snapshot(['a', 'b'])
    for (const none of [
      { outline: { width: 0 } },
      { outline: { opacity: 0 }, dropShadow: { opacity: 0 } },
      { dropShadow: { opacity: -1 } },
    ] satisfies DomSdfOptions[]) {
      const builder = bakingBuilder(none)
      const backend = await effectBackend('windfoil', layout, {}, builder)
      expect(backend.effects).toBeNull()
      expect(builder.build).not.toHaveBeenCalled()
      expect(backend.companion).toBeNull()
      backend.dispose()
    }
    // A visible shadow keeps its underlay, without the outline that draws nothing.
    const options: DomSdfOptions = { outline: { width: 0 }, dropShadow: { opacity: 0.5 } }
    const backend = await effectBackend('windfoil', layout, {}, bakingBuilder(options))
    expect(backend.effects).toEqual({ dropShadow: { opacity: 0.5 } })
    const extras = createExtraTextParts(layout, backend, options, false)
    expect(parts(extras)).toEqual([['ultra-text text effects', 2, 'a,b']])
    release(extras, backend)
  })

  it('casts the underlay into shadow maps only for an outline', async () => {
    const layout = snapshot(['a'])
    const cases: [DomSdfOptions, boolean][] = [
      [{ dropShadow: {} }, false],
      [{ outline: { width: 1 } }, true],
      [{ outline: { width: 1 }, castShadow: false }, false],
    ]
    for (const [options, cast] of cases) {
      const backend = await effectBackend('windfoil', layout, {}, bakingBuilder(options))
      const extras = createExtraTextParts(layout, backend, options, false)
      expect(extras.meshes.map((mesh) => [mesh.name, mesh.castShadow])).toEqual([
        ['ultra-text text effects', cast],
      ])
      release(extras, backend)
    }
  })

  it('moves the underlay about the anchor and ordinal of the part that fills the glyph', async () => {
    const layout = snapshot(['a', 'color', 'sdf'])
    // SDF cells wider than the ink on every side, unevenly, as a raster cell can be.
    const builder = bakingBuilder(EFFECTS, [-3, -1, 12, 11])
    const backend = await effectBackend('windfoil', layout, { compositing: 'shader' }, builder)
    const primary = backend.createGeometry(layout, 0).geometry
    const extras = createExtraTextParts(layout, backend, EFFECTS, {})
    const [colour, underlay] = extras.meshes
    const run = underlay!.geometry.getAttribute('sdfRunMotion') as InstancedBufferAttribute
    const layer = primary.getAttribute('windfoilLayer') as InstancedBufferAttribute
    const colourRect = colour!.geometry.getAttribute('sdfRect') as InstancedBufferAttribute
    const colourLayers = colour!.geometry.getAttribute('windfoilLayers') as InstancedBufferAttribute
    expect(sdfKeys(underlay!)).toEqual(['a', 'color'])
    // The primary's anchor, its ink box centre, rather than the SDF cell's.
    expect([run.getX(0), run.getY(0), run.getZ(0)]).toEqual([
      layer.getX(0),
      layer.getY(0),
      layer.getZ(0),
    ])
    expect([run.getX(0), run.getY(0)]).toEqual([5, 8])
    // The colour part scales about the centre of its rect.
    expect([run.getX(1), run.getY(1), run.getZ(1)]).toEqual([
      (colourRect.getX(0) + colourRect.getZ(0)) / 2,
      (colourRect.getY(0) + colourRect.getW(0)) / 2,
      colourLayers.getZ(0),
    ])
    primary.dispose()
    release(extras, backend)
  })

  it('switches the underlay with the Windfoil batch and whole SDF glyphs with the SDF batch', async () => {
    const layout = snapshot(['a', 'b', 'sdf'])
    const backend = await effectBackend(
      'windfoil',
      layout,
      { sdfBelowPx: 12 },
      bakingBuilder(EFFECTS),
    )
    const sizeSwitch = backend.sizeSwitch!
    expect([...sizeSwitch.keys]).toEqual(['a', 'b'])
    const sdf = vi.fn(sizeSwitch.sdf)
    const windfoil = vi.fn(sizeSwitch.windfoil)
    const spied: WindfoilBackend = { ...backend, sizeSwitch: { ...sizeSwitch, sdf, windfoil } }
    const extras = createExtraTextParts(layout, spied, EFFECTS, false)
    expect(parts(extras)).toEqual([
      ['ultra-text text effects', 2, 'a,b'],
      ['ultra-text fallback glyphs', 2.5, 'a,b,sdf'],
    ])
    for (const mesh of extras.meshes) expect(mesh.geometry.getAttribute('sdfMeta').itemSize).toBe(3)
    const renderer = shaderRenderer()
    fragmentWgsl(renderer, extras.meshes[0]!.material)
    expect([windfoil.mock.calls.length > 0, sdf.mock.calls.length]).toEqual([true, 0])
    windfoil.mockClear()
    fragmentWgsl(renderer, extras.meshes[1]!.material)
    expect([windfoil.mock.calls.length, sdf.mock.calls.length > 0]).toEqual([0, true])
    await disposeShaderRenderer(renderer)
    release(extras, backend)
  })

  it('keeps the underlay tied with its text in three’s depth sort, wherever colour glyphs lie', async () => {
    // three sorts transparent items of one render order by the projected centre of each
    // geometry's bounding sphere, and only then by age. The underlay also holds the colour
    // part's glyphs: lifted by data-sdf-depth, they must not move its centre nearer than the
    // text's, or three draws it over the fill it lies under.
    const lift = (layout: DomLayoutSnapshot, z: number): DomLayoutSnapshot => ({
      ...layout,
      glyphs: layout.glyphs.map((glyph) =>
        glyph.glyphKey === 'color' ? { ...glyph, z, originX: glyph.originX + 1 } : glyph,
      ),
    })
    const layout = lift(snapshot(['a', 'color', 'a']), 8)
    const backend = await effectBackend(
      'windfoil',
      layout,
      { compositing: 'shader' },
      bakingBuilder(EFFECTS),
    )
    const primary = backend.createGeometry(layout, 18).geometry
    const extras = createExtraTextParts(layout, backend, EFFECTS, false, 18)
    const underlay = extras.meshes.find((mesh) => mesh.name === 'ultra-text text effects')!
    expect(sdfKeys(underlay)).toEqual(['a', 'color', 'a'])
    expect(underlay.geometry.boundingSphere).toEqual(primary.boundingSphere)
    // Rewritten in place, and lowered below the text.
    for (const z of [12, -6]) {
      const moved = lift(layout, z)
      expect(backend.updateGeometry(primary, moved, 18)).not.toBeNull()
      const staged = extras.prepare(moved, 18)
      expect(staged.every((geometry) => geometry === null)).toBe(true)
      extras.commit(staged, moved, 18)
      expect(underlay.geometry.boundingSphere).toEqual(primary.boundingSphere)
    }
    primary.dispose()
    release(extras, backend)
  })
})
