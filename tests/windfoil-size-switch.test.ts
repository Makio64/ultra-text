import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Texture,
  UniformNode,
  WebGPUBackend,
  WebGPURenderer,
  WGSLNodeBuilder,
  type BufferAttribute,
  type InstancedBufferGeometry,
  type Material,
  type Node,
  type StorageBufferNode,
} from 'three/webgpu'
import type * as ThreeTsl from 'three/tsl'

type StorageFactory = (
  attribute: BufferAttribute,
  type: 'vec2' | 'uint',
  count: number,
) => StorageBufferNode<'vec2' | 'uint'>
const tslMocks = vi.hoisted(() => ({ storage: vi.fn<StorageFactory>() }))
vi.mock('three/tsl', async (importOriginal) => {
  const actual = await importOriginal<typeof ThreeTsl>()
  tslMocks.storage.mockImplementation(actual.storage as unknown as StorageFactory)
  return { ...actual, storage: tslMocks.storage }
})

import { vec2, vec3, vec4 } from 'three/tsl'

import type { GlyphKeepHook, GlyphTextMaterial } from '../src/text/GlyphTextMaterial.js'
import {
  createGlyphGeometry,
  glyphContentFits,
  updateGlyphContent,
  updateGlyphGeometry,
} from '../src/text/geometry.js'
import { glyphRectTable } from '../src/text/decorations.js'
import { SdfTextMaterial } from '../src/text/SdfTextMaterial.js'
import type {
  DomLayoutSnapshot,
  FontStyleSnapshot,
  GlyphLayout,
  GlyphRequest,
  GlyphSlot,
  SdfAtlas,
  WindfoilGlyphOutline,
  WindfoilOptions,
  WindfoilOutlineProvider,
} from '../src/types.js'
import {
  createWindfoilGlyphGeometry,
  updateWindfoilGlyphGeometry,
  windfoilContentFits,
  windfoilGlyphRect,
} from '../src/windfoil/geometry.js'
import { createExtraTextParts } from '../src/windfoil/mixed.js'
import {
  preprocessWindfoilGlyphs,
  type WindfoilGlyphHeader,
} from '../src/windfoil/preprocessCore.js'
import { buildWindfoilBackend, type WindfoilBackend } from '../src/windfoil/runtime.js'
import {
  assertThreshold,
  companionView,
  createSizeSwitch,
  switchableRequests,
} from '../src/windfoil/sizeSwitch.js'
import { readyForShaderGeneration } from './helpers/shader-renderer.js'

// ---------------------------------------------------------------------------------------------
// Fixtures

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
const blank: WindfoilGlyphOutline = { ...square, quadratics: [] }
const layered: WindfoilGlyphOutline = {
  ...square,
  quadratics: [],
  layers: [{ quadratics: square.quadratics, paint: { type: 'solid', color: [1, 0, 0, 1] } }],
}
const clipped: WindfoilGlyphOutline = { ...square, clipBox: [2, 2, 8, 8] }

/** Outlines by request key: `null` has none, and any key not listed is a plain square. */
function provider(
  outlines: Readonly<Record<string, WindfoilGlyphOutline | null>> = {},
): WindfoilOutlineProvider {
  return (request) => (request.key in outlines ? (outlines[request.key] ?? null) : square)
}

function request(key: string, character = key): GlyphRequest {
  return { key, character, font }
}

/** A cell 2 units larger than the ink on every side, so ink and cell rects never coincide. */
function slot(key: string, color?: true): GlyphSlot {
  return {
    key,
    character: key,
    fontKey: 'font',
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    planeX0: -2,
    planeY0: -2,
    planeX1: 12,
    planeY1: 12,
    descent: 0,
    advance: 10,
    ...(color ? { color } : {}),
  }
}

const disposals = new WeakMap<SdfAtlas, ReturnType<typeof vi.fn<() => void>>>()
/** The spy behind a test atlas's `dispose`. */
function disposeOf(atlas: SdfAtlas | undefined) {
  return disposals.get(atlas!)!
}

function companionAtlas(requests: readonly GlyphRequest[], colorKeys: readonly string[] = []) {
  const dispose = vi.fn<() => void>()
  const atlas: SdfAtlas = {
    texture: new Texture(),
    width: 64,
    height: 64,
    pxRange: 12,
    bakeSize: 10,
    mode: 'cpu',
    glyphs: new Map(
      requests.map((item) => [item.key, slot(item.key, colorKeys.includes(item.key) || undefined)]),
    ),
    dispose,
  }
  disposals.set(atlas, dispose)
  return atlas
}

function companionBuilder(colorKeys: readonly string[] = []) {
  const atlases: SdfAtlas[] = []
  const build = vi.fn((requests: readonly GlyphRequest[], _signal: AbortSignal) => {
    const atlas = companionAtlas(requests, colorKeys)
    atlases.push(atlas)
    return Promise.resolve(atlas)
  })
  return { build, atlases }
}

function layout(
  keys: readonly string[],
  glyph: (index: number) => Partial<GlyphLayout> = () => ({}),
): DomLayoutSnapshot {
  return {
    width: 100,
    height: 40,
    lineCount: 1,
    atlasSignature: 'switch',
    rects: [],
    blocks: [],
    requests: [...new Set(keys)].map((key) => request(key)),
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
      sequence: index,
      z: 1,
      ...glyph(index),
    })),
  }
}

interface RendererHarness {
  readonly renderer: WebGPURenderer
  readonly init: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly has: ReturnType<typeof vi.fn<(attribute: object) => boolean>>
}

function rendererHarness(webgpu = true, maxVertexBuffers?: number): RendererHarness {
  const backend = (webgpu ? Object.create(WebGPUBackend.prototype) : {}) as object
  const has = vi.fn<(attribute: object) => boolean>(() => true)
  Object.assign(backend, {
    has,
    destroyAttribute: vi.fn(),
    ...(maxVertexBuffers === undefined ? {} : { device: { limits: { maxVertexBuffers } } }),
  })
  const init = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const renderer = {
    backend,
    info: { destroyAttribute: vi.fn() },
    init,
  } as unknown as WebGPURenderer
  return { renderer, init, has }
}

async function build(
  keys: readonly string[],
  options: Omit<WindfoilOptions, 'outlineProvider'> & {
    readonly outlines?: Readonly<Record<string, WindfoilGlyphOutline | null>>
  },
  builder: ReturnType<typeof companionBuilder> | null = companionBuilder(),
  renderer: WebGPURenderer = rendererHarness().renderer,
) {
  const { outlines, ...windfoil } = options
  const backend = await buildWindfoilBackend(
    renderer,
    keys.map((key) => request(key, key === 'emoji' ? '😀' : key)),
    { ...windfoil, outlineProvider: provider(outlines) },
    new AbortController().signal,
    builder ?? undefined,
  )
  return backend!
}

/** Float32 contents of an attribute as raw bit patterns, so comparisons are exact. */
function bits(geometry: InstancedBufferGeometry, name: string): Uint32Array {
  const array = geometry.getAttribute(name).array as Float32Array
  return new Uint32Array(array.buffer, array.byteOffset, array.length)
}

function column(
  geometry: InstancedBufferGeometry,
  name: string,
  component: number,
  row: number,
): number {
  const attribute = geometry.getAttribute(name) as BufferAttribute
  return (attribute.array as Float32Array)[row * attribute.itemSize + component]!
}

function rowBits(
  geometry: InstancedBufferGeometry,
  name: string,
  row: number,
  components: readonly number[],
): number[] {
  const raw = bits(geometry, name),
    size = geometry.getAttribute(name).itemSize
  return components.map((component) => raw[row * size + component]!)
}

function disposeParts(extras: ReturnType<typeof createExtraTextParts>): void {
  for (const mesh of extras.meshes) {
    mesh.geometry.dispose()
    mesh.material.dispose()
  }
}

// ---------------------------------------------------------------------------------------------
// Threshold validation and classification

describe('windfoil.sdfBelowPx validation', () => {
  // 1e39 and Number.MAX_VALUE round to an infinite f32 uniform, which would also send anchors
  // behind the eye to the SDF batch.
  it.each([
    0,
    -0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e39,
    Number.MAX_VALUE,
    '96',
    null,
  ])('rejects %s before renderer init, outline work, or any fallback decision', async (value) => {
    for (const webgpu of [true, false]) {
      const harness = rendererHarness(webgpu)
      const outlineProvider = vi.fn<WindfoilOutlineProvider>(() => square)
      const build = vi.fn(() => Promise.resolve(companionAtlas([])))
      await expect(
        buildWindfoilBackend(
          harness.renderer,
          [request('a')],
          {
            outlineProvider,
            fallback: 'sdf',
            sdfBelowPx: value as unknown as number,
          },
          new AbortController().signal,
          { build },
        ),
      ).rejects.toThrow(RangeError)
      expect(harness.init).not.toHaveBeenCalled()
      expect(outlineProvider).not.toHaveBeenCalled()
      expect(build).not.toHaveBeenCalled()
      expect(harness.has).not.toHaveBeenCalled()
    }
  })

  it('accepts any positive threshold the GPU can represent and leaves the default unset', () => {
    for (const value of [1e-6, 0.5, 96, 1e9, 1e37])
      expect(() => assertThreshold(value)).not.toThrow()
    expect(() => assertThreshold(undefined)).toThrow(/sdfBelowPx must be a finite number/)
  })
})

describe('size-switch classification', () => {
  it('bakes missing glyphs plus plain outlines into one companion and switches only the plain ones', async () => {
    const companion = companionBuilder()
    const backend = await build(
      ['plain', 'blank', 'layered', 'clipped', 'emoji', 'missing'],
      {
        fallback: 'sdf-glyphs',
        sdfBelowPx: 96,
        outlines: { blank, layered, clipped, missing: null },
      },
      companion,
    )
    expect(companion.build).toHaveBeenCalledOnce()
    expect(companion.build.mock.calls[0]![0].map((item) => item.key)).toEqual(['missing', 'plain'])
    expect(backend.layered).toBe(true)
    expect(backend.sizeSwitch).not.toBeNull()
    expect([...backend.sizeSwitch!.keys]).toEqual(['plain'])
    // The companion is a filtered view sharing the baked texture.
    expect(backend.companion).not.toBe(companion.atlases[0])
    expect(backend.companion!.texture).toBe(companion.atlases[0]!.texture)
    expect([...backend.companion!.glyphs.keys()].sort()).toEqual(['missing', 'plain'])
    const coverage = Object.fromEntries(
      ['plain', 'blank', 'layered', 'clipped', 'emoji', 'missing', 'unknown'].map((key) => [
        key,
        [backend.covers(key), backend.primaryCovers(key)],
      ]),
    )
    expect(coverage).toEqual({
      plain: [true, true],
      blank: [true, false],
      layered: [true, true],
      // A clip box routes the glyph through the colour composite, not the primary batch.
      clipped: [true, false],
      emoji: [true, true],
      missing: [true, false],
      unknown: [false, false],
    })
    expect(backend.color).not.toBeNull()
    backend.companion!.dispose()
    expect(disposeOf(companion.atlases[0])).not.toHaveBeenCalled()
    backend.dispose()
    backend.dispose()
    expect(disposeOf(companion.atlases[0])).toHaveBeenCalledOnce()
  })

  it('switches without missing glyphs under every fallback, and needs the companion builder', async () => {
    for (const fallback of [undefined, 'sdf', 'sdf-glyphs'] as const) {
      const companion = companionBuilder()
      const backend = await build(
        ['a', 'b'],
        { ...(fallback ? { fallback } : {}), sdfBelowPx: 96 },
        companion,
      )
      expect(companion.build.mock.calls[0]![0].map((item) => item.key)).toEqual(['a', 'b'])
      expect([...backend.sizeSwitch!.keys]).toEqual(['a', 'b'])
      backend.dispose()
      expect(disposeOf(companion.atlases[0])).toHaveBeenCalledOnce()
    }
    const unbuilt = await build(['a'], { sdfBelowPx: 96 }, null)
    expect(unbuilt.sizeSwitch).toBeNull()
    expect(unbuilt.companion).toBeNull()
    expect(unbuilt.layered).toBe(false)
    unbuilt.dispose()
  })

  it('demotes a switchable glyph whose baked slot came back as colour ink', async () => {
    const companion = companionBuilder(['plain'])
    const backend = await build(
      ['plain', 'missing'],
      { fallback: 'sdf-glyphs', sdfBelowPx: 96, outlines: { missing: null } },
      companion,
    )
    expect(companion.build.mock.calls[0]![0].map((item) => item.key)).toEqual(['missing', 'plain'])
    expect([...backend.companion!.glyphs.keys()]).toEqual(['missing'])
    expect(backend.sizeSwitch).toBeNull()
    expect(backend.primaryCovers('plain')).toBe(true)
    backend.dispose()
    backend.dispose()
    expect(disposeOf(companion.atlases[0])).toHaveBeenCalledOnce()

    // With nothing left to draw from it, the companion is released at once and exactly once.
    const onlyColor = companionBuilder(['plain'])
    const bare = await build(['plain'], { sdfBelowPx: 96 }, onlyColor)
    expect(bare.companion).toBeNull()
    expect(bare.sizeSwitch).toBeNull()
    expect(disposeOf(onlyColor.atlases[0])).toHaveBeenCalledOnce()
    bare.dispose()
    expect(disposeOf(onlyColor.atlases[0])).toHaveBeenCalledOnce()
  })

  it('filters views and requests without the runtime', () => {
    const atlas = companionAtlas([request('a'), request('b'), request('c'), request('m')], ['c'])
    const view = companionView(atlas, ['m'], [request('a'), request('c'), request('gone')])
    expect([...view.keys]).toEqual(['a'])
    expect([...view.atlas!.glyphs.keys()]).toEqual(['a', 'm'])
    expect(view.atlas!.glyphs.get('a')).toBe(atlas.glyphs.get('a'))
    view.atlas!.dispose()
    expect(disposeOf(atlas)).not.toHaveBeenCalled()
    expect(companionView(atlas, [], [request('c')])).toEqual({ keys: new Set(), atlas: null })

    const header = (fields: Partial<WindfoilGlyphHeader> = {}) =>
      ({ monotonePieceCount: 4, ...fields }) as WindfoilGlyphHeader
    const headers = new Map([
      ['plain', header()],
      ['blank', header({ monotonePieceCount: 0 })],
      ['layered', header({ layers: [] })],
      ['clipped', header({ clipBox: [2, 2, 8, 8] })],
      ['emoji', header()],
      ['keycap', header()],
      ['stale', header()],
    ])
    expect(
      switchableRequests(
        [
          { request: request('plain'), outline: square },
          { request: request('blank'), outline: blank },
          { request: request('layered'), outline: layered },
          { request: request('clipped'), outline: clipped },
          { request: request('emoji', '😀'), outline: square },
          { request: request('keycap', '1\u20E3'), outline: square },
          { request: request('missing'), outline: null },
          // A header without a resolved outline never switches.
          { request: request('stale'), outline: null },
        ],
        headers,
      ).map((item) => item.key),
    ).toEqual(['plain'])
  })
})

// ---------------------------------------------------------------------------------------------
// Derived layout and geometry

describe('size-switch layouts', () => {
  it('derives one memoised layout and never writes switch data into the captured snapshot', async () => {
    const backend = await build(['a', 'm'], {
      fallback: 'sdf-glyphs',
      sdfBelowPx: 96,
      outlines: { m: null },
    })
    const captured = layout(['a', 'm', 'a', 'm'], (index) =>
      index === 2 ? { motionOrigin: [7.25, 8.5, 9] as const, fontSize: 0 } : {},
    )
    const pristine = structuredClone(captured)
    const sizeSwitch = backend.sizeSwitch!
    const derived = sizeSwitch.layout(captured)
    expect(sizeSwitch.layout(captured)).toBe(derived)
    expect(sizeSwitch.layout({ ...captured })).not.toBe(derived)
    expect(derived).not.toBe(captured)
    expect(derived.requests).toBe(captured.requests)
    const header = backend.glyphs.get('a')!
    const ink = windfoilGlyphRect(captured.glyphs[0]!, header)
    expect(derived.glyphs.map((glyph) => [glyph.switchEm, glyph.motionOrigin])).toEqual([
      [10, [(ink[0] + ink[2]) / 2, (ink[1] + ink[3]) / 2, 0]],
      [0, undefined],
      // A caller's motion origin is kept, and a degenerate size still switches.
      [1e-30, [7.25, 8.5, 9]],
      [0, undefined],
    ])
    expect(derived.glyphs[2]!.motionOrigin).toBe(captured.glyphs[2]!.motionOrigin)

    const primary = backend.createGeometry(captured, 0).geometry
    const extras = createExtraTextParts(captured, backend, {}, { enabled: false })
    expect(backend.contentFits(primary, captured)).toBe(true)
    expect(backend.updateGeometry(primary, captured, 0)).not.toBeNull()
    extras.commit(extras.prepare(captured, 0), captured, 0)
    extras.mergeRects(captured, primary)
    expect(captured).toEqual(pristine)
    expect(captured.glyphs.some((glyph) => 'switchEm' in glyph)).toBe(false)
    primary.dispose()
    disposeParts(extras)
    backend.dispose()
  })

  it('carries each glyph font size for a tone that dilates, and switches the same glyphs', async () => {
    const captured = layout(['a', 'layered', 'a'], (index) =>
      index === 2 ? { shapeGroup: 0 } : {},
    )
    const pristine = structuredClone(captured)
    const ems = (geometry: InstancedBufferGeometry): number[] =>
      Array.from({ length: geometry.instanceCount }, (_, row) =>
        column(geometry, 'sdfMeta', 2, row),
      )

    // With the switch: a switchable glyph keeps its positive em, one that never switches a
    // negative one, and an SVG shape, which has no font size, zero.
    const switching = await build(['a', 'layered'], { sdfBelowPx: 96, outlines: { layered } })
    const plain = switching.createGeometry(captured, 0).geometry
    expect(ems(plain)).toEqual([10, 0, 10])
    switching.setGlyphEm(true)
    expect(switching.contentFits(plain, captured)).toBe(true)
    const sized = switching.createGeometry(captured, 0).geometry
    expect(ems(sized)).toEqual([10, -10, 10])
    expect(switching.updateGeometry(plain, captured, 0)).not.toBeNull()
    expect(ems(plain)).toEqual([10, -10, 10])
    plain.dispose()
    sized.dispose()
    switching.dispose()

    // Without one the geometry is two wide until a dilating tone asks for the font size.
    const fixed = await build(['a', 'layered'], { outlines: { layered } }, null)
    const narrow = fixed.createGeometry(captured, 0).geometry
    expect(narrow.getAttribute('sdfMeta').itemSize).toBe(2)
    fixed.setGlyphEm(true)
    expect(fixed.contentFits(narrow, captured)).toBe(false)
    expect(fixed.updateGeometry(narrow, captured, 0)).toBeNull()
    const wide = fixed.createGeometry(captured, 0).geometry
    expect(ems(wide)).toEqual([-10, -10, 0])
    // An empty batch stays three wide, as the material that reads it expects.
    const empty = fixed.createGeometry(layout([]), 0).geometry
    expect(empty.getAttribute('sdfMeta').itemSize).toBe(3)
    fixed.setGlyphEm(false)
    expect(fixed.contentFits(wide, captured)).toBe(false)
    expect(captured).toEqual(pristine)
    for (const geometry of [narrow, wide, empty]) geometry.dispose()
    fixed.dispose()
  })

  it('gives both batches bit-identical anchors, depths, ems, and ordinals', async () => {
    const backend = await build(['a', 'm', 'b'], {
      fallback: 'sdf-glyphs',
      sdfBelowPx: 96,
      outlines: { m: null },
    })
    // Fractional values that are not exact in binary, so any recomputation would show.
    const captured = layout(['a', 'm', 'b', 'a'], (index) => ({
      fontSize: 13.37 + index * 0.1,
      originX: 0.1 + index * 11.3,
      lineBottom: 3.3,
      z: 0.7 + index * 0.01,
    }))
    const { geometry: primary } = backend.createGeometry(captured, 0)
    const extras = createExtraTextParts(captured, backend, {}, { enabled: false })
    const companion = extras.meshes[0]!.geometry
    expect(extras.meshes.map((mesh) => mesh.name)).toEqual(['ultra-text fallback glyphs'])
    expect(primary.getAttribute('sdfMeta').itemSize).toBe(3)
    expect(companion.getAttribute('sdfMeta').itemSize).toBe(3)
    // Primary rows: a, b, a. Companion rows: a, m, b, a.
    expect(primary.instanceCount).toBe(3)
    expect(companion.instanceCount).toBe(4)
    const pairs = [
      [0, 0],
      [1, 2],
      [2, 3],
    ] as const
    for (const [windfoilRow, sdfRow] of pairs) {
      expect(rowBits(primary, 'windfoilLayer', windfoilRow, [0, 1, 2])).toEqual(
        rowBits(companion, 'sdfRunMotion', sdfRow, [0, 1, 2]),
      )
      expect(rowBits(primary, 'sdfMeta', windfoilRow, [0, 1, 2])).toEqual(
        rowBits(companion, 'sdfMeta', sdfRow, [0, 1, 2]),
      )
    }
    const glyphs = captured.glyphs
    expect([0, 1, 2].map((row) => column(primary, 'sdfMeta', 2, row))).toEqual(
      [0, 2, 3].map((index) => Math.fround(glyphs[index]!.fontSize)),
    )
    // The anchor is the Windfoil ink centre, never the SDF cell centre.
    const ink = windfoilGlyphRect(glyphs[0]!, backend.glyphs.get('a')!)
    expect([
      column(companion, 'sdfRunMotion', 0, 0),
      column(companion, 'sdfRunMotion', 1, 0),
    ]).toEqual([Math.fround((ink[0] + ink[2]) / 2), Math.fround((ink[1] + ink[3]) / 2)])
    // The missing glyph never switches, and keeps its own ordinal.
    expect(column(companion, 'sdfMeta', 2, 1)).toBe(0)
    expect([0, 1, 2, 3].map((row) => column(companion, 'sdfRunMotion', 2, row))).toEqual([
      0, 1, 2, 3,
    ])
    expect(Array.from(backend.motionOrdinals(captured))).toEqual([0, 1, 2, 3])
    primary.dispose()
    disposeParts(extras)
    backend.dispose()
  })

  it('leaves the default Windfoil and mixed paths untouched when the switch is off', async () => {
    const companion = companionBuilder()
    const backend = await build(
      ['a', 'm'],
      { fallback: 'sdf-glyphs', outlines: { m: null } },
      companion,
    )
    expect(companion.build.mock.calls[0]![0].map((item) => item.key)).toEqual(['m'])
    expect(backend.sizeSwitch).toBeNull()
    expect(backend.companion).toBe(companion.atlases[0])
    const captured = layout(['a', 'm', 'a'])
    const primary = backend.createGeometry(captured, 0).geometry
    const extras = createExtraTextParts(captured, backend, {}, { enabled: false })
    expect(primary.getAttribute('sdfMeta').itemSize).toBe(2)
    expect(extras.meshes[0]!.geometry.getAttribute('sdfMeta').itemSize).toBe(2)
    expect(Array.from(backend.motionOrdinals(captured))).toEqual([0, 1, 2])
    extras.mergeRects(captured, primary)
    expect(Array.from(glyphRectTable(primary))).toEqual([
      0, 3, 10, 13, 10, 1, 24, 15, 24, 3, 34, 13,
    ])
    primary.dispose()
    disposeParts(extras)
    backend.dispose()
  })

  it('keeps decoration rows aligned when a glyph lives in two batches', async () => {
    const backend = await build(['a', 'b', 'c'], {
      fallback: 'sdf-glyphs',
      compositing: 'shader',
      sdfBelowPx: 96,
      outlines: { b: null, c: layered },
    })
    const captured = layout(['a', 'b', 'a', 'c'])
    const primary = backend.createGeometry(captured, 0).geometry
    const extras = createExtraTextParts(captured, backend, {}, { enabled: false })
    expect(extras.meshes.map((mesh) => mesh.name)).toEqual([
      'ultra-text Windfoil colour glyphs',
      'ultra-text fallback glyphs',
    ])
    // Primary: a, a. Colour: c. Companion: a, b, a (cells 2 units larger than the ink).
    expect(Array.from(glyphRectTable(extras.meshes[1]!.geometry))).toEqual([
      -2, 1, 12, 15, 10, 1, 24, 15, 22, 1, 36, 15,
    ])
    extras.mergeRects(captured, primary)
    expect(Array.from(glyphRectTable(primary))).toEqual([
      // a: Windfoil ink, b: SDF cell, a: Windfoil ink, c: colour composite.
      0, 3, 10, 13, 10, 1, 24, 15, 24, 3, 34, 13, 36, 3, 46, 13,
    ])

    // A reflow rewrites both batches in place; anchors move while the em stays.
    const sizeSwitch = backend.sizeSwitch!
    const derive = vi.spyOn(sizeSwitch, 'layout')
    const moved: DomLayoutSnapshot = {
      ...captured,
      glyphs: captured.glyphs.map((glyph) => ({ ...glyph, originX: glyph.originX + 1 })),
    }
    const geometries = extras.meshes.map((mesh) => mesh.geometry)
    expect(backend.contentFits(primary, moved)).toBe(true)
    // The colour glyph (sequence 3) is not in the primary batch.
    expect(backend.updateGeometry(primary, moved, 0)).toBe(2)
    const staged = extras.prepare(moved, 0)
    expect(staged).toEqual([null, null])
    extras.commit(staged, moved, 0)
    extras.mergeRects(moved, primary)
    extras.meshes.forEach((mesh, index) => expect(mesh.geometry).toBe(geometries[index]))
    expect(Array.from(glyphRectTable(primary))).toEqual([
      1, 3, 11, 13, 11, 1, 25, 15, 25, 3, 35, 13, 37, 3, 47, 13,
    ])
    const companion = geometries[1]!
    for (const [windfoilRow, sdfRow] of [
      [0, 0],
      [1, 2],
    ] as const) {
      expect(rowBits(primary, 'windfoilLayer', windfoilRow, [0, 1, 2])).toEqual(
        rowBits(companion, 'sdfRunMotion', sdfRow, [0, 1, 2]),
      )
      expect(column(primary, 'sdfMeta', 2, windfoilRow)).toBe(10)
      expect(column(companion, 'sdfMeta', 2, sdfRow)).toBe(10)
    }
    expect(column(primary, 'windfoilLayer', 0, 0)).toBe(6)
    // Every consumer of one snapshot shares a single derived layout.
    const derivedForMoved = new Set(
      derive.mock.calls.flatMap(([input], call) =>
        input === moved ? [derive.mock.results[call]!.value as DomLayoutSnapshot] : [],
      ),
    )
    expect(derive.mock.calls.filter(([input]) => input === moved).length).toBeGreaterThan(2)
    expect(derivedForMoved.size).toBe(1)
    primary.dispose()
    disposeParts(extras)
    backend.dispose()
  })

  it('writes a three-wide sdfMeta only for switch layouts and refuses to mix strides', () => {
    const atlas = companionAtlas([request('a')])
    const plain = layout(['a', 'a'])
    const switched = layout(['a', 'a'], (index) => ({ switchEm: index ? 0 : 10 }))
    const narrow = createGlyphGeometry(plain, atlas, 0).geometry
    const wide = createGlyphGeometry(switched, atlas, 0).geometry
    expect(narrow.getAttribute('sdfMeta').itemSize).toBe(2)
    expect(Array.from(wide.getAttribute('sdfMeta').array)).toEqual([0, 1, 10, 1, 1, 0])
    expect(glyphContentFits(wide, switched, atlas)).toBe(true)
    expect(glyphContentFits(narrow, switched, atlas)).toBe(false)
    expect(glyphContentFits(wide, plain, atlas)).toBe(false)
    expect(updateGlyphContent(narrow, switched, atlas, 0)).toBeNull()
    const rewritten = layout(['a', 'a'], (index) => ({ switchEm: 20 + index, sequence: 5, z: 2 }))
    expect(updateGlyphContent(wide, rewritten, atlas, 0)).toBe(5)
    expect(Array.from(wide.getAttribute('sdfMeta').array)).toEqual([5, 2, 20, 5, 2, 21])
    // The reflow path rewrites only the sequence, at the attribute's own stride.
    expect(
      updateGlyphGeometry(
        wide,
        layout(['a', 'a'], () => ({ sequence: 7 })),
        atlas,
        0,
      ),
    ).toBe(7)
    expect(Array.from(wide.getAttribute('sdfMeta').array)).toEqual([7, 2, 20, 7, 2, 21])
    narrow.dispose()
    wide.dispose()
    atlas.dispose()

    const { glyphs } = preprocessWindfoilGlyphs([{ request: request('a'), outline: square }], {})
    const windfoilNarrow = createWindfoilGlyphGeometry(plain, glyphs, 0, true).geometry
    const windfoilWide = createWindfoilGlyphGeometry(switched, glyphs, 0, true).geometry
    expect(windfoilNarrow.getAttribute('sdfMeta').itemSize).toBe(2)
    expect(Array.from(windfoilWide.getAttribute('sdfMeta').array)).toEqual([0, 1, 10, 1, 1, 0])
    expect(windfoilContentFits(windfoilWide, switched, glyphs)).toBe(true)
    expect(windfoilContentFits(windfoilNarrow, switched, glyphs)).toBe(false)
    expect(windfoilContentFits(windfoilWide, plain, glyphs)).toBe(false)
    expect(updateWindfoilGlyphGeometry(windfoilNarrow, switched, glyphs, 0)).toBeNull()
    expect(updateWindfoilGlyphGeometry(windfoilWide, rewritten, glyphs, 0)).toBe(5)
    expect(Array.from(windfoilWide.getAttribute('sdfMeta').array)).toEqual([5, 2, 20, 5, 2, 21])
    windfoilNarrow.dispose()
    windfoilWide.dispose()
  })
})

// ---------------------------------------------------------------------------------------------
// Lifecycle and guards

describe('size-switch lifecycle', () => {
  it('releases a companion that resolves after cancellation without allocating storage', async () => {
    const harness = rendererHarness(),
      controller = new AbortController()
    let finish!: (atlas: SdfAtlas) => void
    const build = vi.fn(
      () =>
        new Promise<SdfAtlas>((resolve) => {
          finish = resolve
        }),
    )
    const pending = buildWindfoilBackend(
      harness.renderer,
      [request('a')],
      { outlineProvider: () => square, sdfBelowPx: 96 },
      controller.signal,
      { build },
    )
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const late = companionAtlas([request('a')])
    finish(late)
    await Promise.resolve()
    expect(disposeOf(late)).toHaveBeenCalledOnce()
    expect(harness.has).not.toHaveBeenCalled()
  })

  it('disposes the companion once when storage fails after the bake', async () => {
    const harness = rendererHarness()
    const companion = companionBuilder()
    const failure = new Error('storage failed')
    tslMocks.storage.mockImplementationOnce(() => {
      throw failure
    })
    await expect(
      buildWindfoilBackend(
        harness.renderer,
        [request('a')],
        { outlineProvider: () => square, sdfBelowPx: 96 },
        new AbortController().signal,
        companion,
      ),
    ).rejects.toBe(failure)
    expect(companion.atlases).toHaveLength(1)
    expect(disposeOf(companion.atlases[0])).toHaveBeenCalledOnce()
  })

  it('needs eight vertex buffers before baking, falling back only when allowed', async () => {
    const companion = companionBuilder()
    const limited = rendererHarness(true, 7)
    expect(
      await buildWindfoilBackend(
        limited.renderer,
        [request('a')],
        { outlineProvider: () => square, fallback: 'sdf-glyphs', sdfBelowPx: 96 },
        new AbortController().signal,
        companion,
      ),
    ).toBeNull()
    await expect(
      buildWindfoilBackend(
        limited.renderer,
        [request('a')],
        { outlineProvider: () => square, sdfBelowPx: 96 },
        new AbortController().signal,
        companion,
      ),
    ).rejects.toThrow('eight vertex buffers')
    expect(companion.build).not.toHaveBeenCalled()
    expect(limited.has).not.toHaveBeenCalled()
    // The same device still runs plain Windfoil when the switch is off.
    const plain = await buildWindfoilBackend(
      limited.renderer,
      [request('a')],
      { outlineProvider: () => square },
      new AbortController().signal,
      companion,
    )
    expect(plain?.layered).toBe(false)
    plain!.dispose()
  })
})

// ---------------------------------------------------------------------------------------------
// Shader graphs

const renderers: WebGPURenderer[] = []
afterEach(async () => {
  for (const renderer of renderers) await renderer.dispose()
  renderers.length = 0
})

function shaderRenderer(): WebGPURenderer {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  const renderer = readyForShaderGeneration(
    new WebGPURenderer({ canvas: document.createElement('canvas') }),
  )
  renderers.push(renderer)
  vi.spyOn(renderer, 'init').mockResolvedValue(renderer)
  vi.spyOn(renderer, 'setAnimationLoop').mockResolvedValue(undefined)
  vi.spyOn(renderer, 'hasFeature').mockReturnValue(false)
  return renderer
}

interface Shader {
  readonly vertex: string
  readonly fragment: string
  readonly attributes: readonly string[]
}

function generate(
  renderer: WebGPURenderer,
  geometry: InstancedBufferGeometry,
  material: Material,
  shadow = false,
): Shader {
  let selected = material
  if (shadow) {
    const source = material as GlyphTextMaterial
    const shadowMaterial = new MeshBasicNodeMaterial()
    shadowMaterial.positionNode = source.castShadowPositionNode
    shadowMaterial.maskNode = source.maskShadowNode
    shadowMaterial.colorNode = vec4(1)
    selected = shadowMaterial
  }
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
  if (shadow) selected.dispose()
  return {
    vertex: builder.vertexShader,
    fragment: builder.fragmentShader,
    attributes: builder.getAttributesArray().map((item) => item.name),
  }
}

interface SwitchedGraphs {
  readonly backend: WindfoilBackend
  readonly windfoil: Shader
  readonly windfoilShadow: Shader
  readonly sdf: Shader
  readonly sdfShadow: Shader
  readonly windfoilClone: Shader
  readonly sdfClone: Shader
}

/** The Windfoil primary and its SDF companion, beauty and shadow, with or without the switch. */
async function generateGraphs(sdfBelowPx?: number): Promise<SwitchedGraphs> {
  const renderer = shaderRenderer()
  const captured = layout(['a', 'm'])
  const backend = (await buildWindfoilBackend(
    renderer,
    captured.requests,
    {
      outlineProvider: provider({ m: null }),
      fallback: 'sdf-glyphs',
      ...(sdfBelowPx === undefined ? {} : { sdfBelowPx }),
    },
    new AbortController().signal,
    companionBuilder(),
  ))!
  const primary = backend.createGeometry(captured, 0).geometry
  const material = backend.createMaterial({ motion: { enabled: false }, maxSequence: 1 })
  const extras = createExtraTextParts(captured, backend, {}, { enabled: false })
  const part = extras.meshes[0]!
  const windfoilClone = material.clone()
  const sdfClone = part.material.clone()
  const graphs: SwitchedGraphs = {
    backend,
    windfoil: generate(renderer, primary, material),
    windfoilShadow: generate(renderer, primary, material, true),
    sdf: generate(renderer, part.geometry, part.material),
    sdfShadow: generate(renderer, part.geometry, part.material, true),
    windfoilClone: generate(renderer, primary, windfoilClone),
    sdfClone: generate(renderer, part.geometry, sdfClone),
  }
  expect(material.castShadowPositionNode).toBe(material.positionNode)
  expect(part.material.castShadowPositionNode).toBe(part.material.positionNode)
  for (const disposable of [material, windfoilClone, sdfClone, primary]) disposable.dispose()
  disposeParts(extras)
  backend.dispose()
  return graphs
}

/** Every function of a stage, with generated names numbered by first use. */
function canonicalFunctions(shader: string): string {
  const names = new Map<string, string>()
  const counts = new Map<string, number>()
  return shader
    .slice(shader.search(/^fn /m))
    .replace(/\b(nodeUniform|nodeVar|nodeConst)\d+/g, (name, kind: string) => {
      let renamed = names.get(name)
      if (!renamed) {
        const count = counts.get(kind) ?? 0
        counts.set(kind, count + 1)
        renamed = `${kind}#${count}`
        names.set(name, renamed)
      }
      return renamed
    })
}

function projectedEmFunction(vertex: string): string {
  const start = vertex.indexOf('fn ultraProjectedEm')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = vertex.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return vertex.slice(start, end + 2)
}

describe('size-switch shader graphs', () => {
  it('compiles one shared projected-em function into every switched vertex stage', async () => {
    const graphs = await generateGraphs(96)
    const stages = [
      graphs.windfoil,
      graphs.windfoilShadow,
      graphs.windfoilClone,
      graphs.sdf,
      graphs.sdfShadow,
      graphs.sdfClone,
    ]
    const functions = stages.map((stage) => projectedEmFunction(stage.vertex))
    expect(new Set(functions).size).toBe(1)
    expect(functions[0]).toMatch(
      /^fn ultraProjectedEm \( clip : vec4<f32>, axisX : vec4<f32>, axisY : vec4<f32>, halfViewport : vec2<f32>, em : f32 \) -> f32 \{/,
    )
    for (const stage of stages) {
      expect(stage.vertex).toMatch(/sdfMeta : vec3<f32>/)
      expect(stage.vertex.match(/ultraProjectedEm\(/g)).toHaveLength(1)
      // The fragment stages are the unswitched ones: the decision is vertex-only.
      expect(stage.fragment).not.toContain('ultraProjectedEm')
    }
    for (const stage of [graphs.windfoil, graphs.windfoilShadow, graphs.windfoilClone])
      expect(stage.attributes.length).toBeLessThanOrEqual(8)
    for (const stage of [graphs.sdf, graphs.sdfShadow, graphs.sdfClone])
      expect(stage.attributes.length).toBeLessThanOrEqual(7)
    expect(graphs.windfoil.attributes).toContain('windfoilLayer')
    expect(graphs.sdf.attributes).toContain('sdfRunMotion')
  })

  it('decides from the un-animated motion anchor, depth, and em of each batch', async () => {
    const graphs = await generateGraphs(96)
    for (const [stage, anchor, drop] of [
      [graphs.windfoil, 'windfoilLayer', '! ( '],
      [graphs.windfoilShadow, 'windfoilLayer', '! ( '],
      [graphs.sdf, 'sdfRunMotion', ''],
      [graphs.sdfShadow, 'sdfRunMotion', ''],
    ] as const) {
      const call =
        /let (\w+) = ultraProjectedEm\( \( (\w+) \* vec4<f32>\( (\w+), sdfMeta\.y, 1\.0 \) \), \( \2 \* vec4<f32>\( 1\.0, 0\.0, 0\.0, 0\.0 \) \), \( \2 \* vec4<f32>\( 0\.0, 1\.0, 0\.0, 0\.0 \) \), \( render\.(\w+)\.zw \* vec2<f32>\( 0\.5 \) \), sdfMeta\.z \);/.exec(
          stage.vertex,
        )
      expect(call).not.toBeNull()
      const [, emPixels, product, center] = call!
      expect(stage.vertex).toContain(
        `${product} = ( render.cameraProjectionMatrix * modelViewMatrix );`,
      )
      expect(stage.vertex).toContain(`let ${center} = ${anchor}.xy;`)
      // The same local is the scale motion's centre, so motion never moves the decision.
      expect(stage.vertex).toMatch(
        new RegExp(
          `= \\( ${center!} \\+ \\( \\( \\w+ - ${center!} \\) \\* vec2<f32>\\( \\w+ \\) \\) \\);`,
        ),
      )
      const condition = new RegExp(
        `if \\( \\( \\( sdfMeta\\.z <= 0\\.0 \\) \\|\\| \\( ${drop.replace(/[()!]/g, '\\$&')}${emPixels!} < object\\.\\w+ \\)`,
      )
      expect(stage.vertex).toMatch(condition)
    }
  })

  it('keeps default graphs free of the gate and the switched fragments unchanged', async () => {
    const off = await generateGraphs()
    const on = await generateGraphs(96)
    for (const stage of [off.windfoil, off.windfoilShadow, off.sdf, off.sdfShadow]) {
      expect(stage.vertex).not.toContain('ultraProjectedEm')
      expect(stage.vertex).toMatch(/sdfMeta : vec2<f32>/)
    }
    expect(off.backend.sizeSwitch).toBeNull()
    // The shared uniform struct gains the vertex gate's threshold, and generated names shift,
    // but every fragment function is the same code.
    for (const name of ['windfoil', 'windfoilShadow', 'sdf', 'sdfShadow'] as const) {
      expect(on[name].fragment).not.toBe(off[name].fragment)
      expect(canonicalFunctions(on[name].fragment), name).toBe(
        canonicalFunctions(off[name].fragment),
      )
    }
  })

  it('passes the keep hook the motion anchor and the vec3 metadata, again for clones', () => {
    const renderer = shaderRenderer()
    const atlas = companionAtlas([request('a')])
    const captured = layout(['a'], () => ({ switchEm: 10 }))
    const geometry = createGlyphGeometry(captured, atlas, 0, Float32Array.of(0)).geometry
    const received: [Node, Node][] = []
    const keepGlyph = vi.fn<GlyphKeepHook>((anchor, meta) => {
      received.push([anchor, meta])
      return meta.z.greaterThan(anchor.x)
    })
    const material = new SdfTextMaterial({
      atlas: atlas.texture,
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      runMotion: true,
      keepGlyph,
    })
    expect(material.castShadowPositionNode).toBe(material.positionNode)
    const beauty = generate(renderer, geometry, material)
    expect(keepGlyph).toHaveBeenCalled()
    const [, meta] = received[0]!
    expect((meta as Node & { nodeType: string }).nodeType).toBe('vec3')
    // The anchor argument is the run-motion centre local.
    expect(beauty.vertex).toMatch(/let (\w+) = sdfRunMotion\.xy;[\s\S]*\( sdfMeta\.z > \1\.x \)/)
    const calls = keepGlyph.mock.calls.length
    const twin = material.clone()
    generate(renderer, geometry, twin)
    expect(keepGlyph.mock.calls.length).toBeGreaterThan(calls)
    expect(generate(renderer, geometry, twin).vertex).toBe(beauty.vertex)
    material.dispose()
    twin.dispose()
    geometry.dispose()
    atlas.dispose()
  })

  it('keeps sdfMeta three wide across an empty recapture', async () => {
    const renderer = shaderRenderer()
    const captured = layout(['a'])
    const backend = (await buildWindfoilBackend(
      renderer,
      captured.requests,
      { outlineProvider: () => square, sdfBelowPx: 96 },
      new AbortController().signal,
      companionBuilder(),
    ))!
    const empty = layout([])
    const primary = backend.createGeometry(empty, 0).geometry
    expect(primary.instanceCount).toBe(0)
    // A two-wide empty batch compiles a vec2 pipeline that three keeps when a later in-place
    // update swaps the three-wide geometry under the same material: every glyph would then
    // read a zero em and be drawn by both batches.
    expect(primary.getAttribute('sdfMeta').itemSize).toBe(3)
    const material = backend.createMaterial({ motion: { enabled: false }, maxSequence: 0 })
    const extras = createExtraTextParts(empty, backend, {}, { enabled: false })
    for (const [geometry, part] of [
      [primary, material],
      [extras.meshes[0]!.geometry, extras.meshes[0]!.material],
    ] as const) {
      expect(geometry.getAttribute('sdfMeta').itemSize).toBe(3)
      expect(generate(renderer, geometry, part).vertex).toMatch(/sdfMeta : vec3<f32>/)
    }
    material.dispose()
    primary.dispose()
    disposeParts(extras)
    backend.dispose()
  })

  it('feeds custom fills the shared ordinal, so glyphIndex is continuous across the switch', async () => {
    const fill = ({ glyphIndex, color }: { glyphIndex: Node<'float'>; color: Node<'vec3'> }) =>
      vec4(color, glyphIndex)
    const fillIndex = /varyings\.vUltraFillIndex = ([^;]+);/
    const indices = async (sdfBelowPx?: number) => {
      const renderer = shaderRenderer()
      const captured = layout(['a', 'm'])
      const backend = (await buildWindfoilBackend(
        renderer,
        captured.requests,
        {
          outlineProvider: provider({ m: null }),
          fallback: 'sdf-glyphs',
          ...(sdfBelowPx === undefined ? {} : { sdfBelowPx }),
        },
        new AbortController().signal,
        companionBuilder(),
      ))!
      const primary = backend.createGeometry(captured, 0).geometry
      const material = backend.createMaterial({ motion: { enabled: false }, maxSequence: 1, fill })
      const extras = createExtraTextParts(captured, backend, { fill }, { enabled: false })
      const result = [
        fillIndex.exec(generate(renderer, primary, material).vertex)?.[1],
        fillIndex.exec(
          generate(renderer, extras.meshes[0]!.geometry, extras.meshes[0]!.material).vertex,
        )?.[1],
      ]
      material.dispose()
      primary.dispose()
      disposeParts(extras)
      backend.dispose()
      return result
    }
    // Both batches expose the global drawable ordinal both of them animate with.
    expect(await indices(96)).toEqual(['windfoilLayer.z', 'sdfRunMotion.z'])
    // Without the switch the companion keeps its historical per-batch instance index.
    expect(await indices()).toEqual(['windfoilLayer.z', 'f32( instanceIndex )'])
  })
})

// ---------------------------------------------------------------------------------------------
// CPU twin of the emitted gate

type Value = number | boolean | readonly number[] | { readonly [name: string]: Value }

/**
 * A tiny evaluator for the straight-line WGSL the gate emits: `var`/`let`, assignments,
 * `if`/`else`, `return`, vector constructors, swizzles, `length`, arithmetic, and comparisons.
 * Every arithmetic result is rounded to f32 as the GPU would (without contraction).
 */
function wgslEvaluator(source: string) {
  const tokens: string[] = []
  const pattern =
    /\s*(?:(\d+(?:\.\d*)?(?:e[+-]?\d+)?)|([A-Za-z_]\w*(?:<f32>)?)|(\|\||&&|<=|>=|==|!=|->|[-+*/<>!(){}=;:,.]))/y
  for (let match = pattern.exec(source); match; match = pattern.exec(source))
    tokens.push(match[1] ?? match[2] ?? match[3]!)
  let at = 0
  const peek = () => tokens[at]
  const next = () => tokens[at++]!
  const take = (token: string) => {
    if (tokens[at] !== token)
      throw new Error(`expected ${token} at ${tokens.slice(at, at + 6).join(' ')}`)
    at++
  }
  const f32 = Math.fround
  const lanes = (value: Value): readonly number[] =>
    typeof value === 'number' ? [value] : (value as readonly number[])
  const map = (left: Value, right: Value, operation: (a: number, b: number) => number): Value => {
    if (typeof left === 'number' && typeof right === 'number') return f32(operation(left, right))
    const a = lanes(left),
      b = lanes(right)
    const size = Math.max(a.length, b.length)
    return Array.from({ length: size }, (_, index) =>
      f32(operation(a[a.length === 1 ? 0 : index]!, b[b.length === 1 ? 0 : index]!)),
    )
  }
  type Expression = (scope: Map<string, Value>) => Value
  const binary: Readonly<Record<string, readonly [number, (a: Value, b: Value) => Value]>> = {
    '||': [1, (a, b) => Boolean(a) || Boolean(b)],
    '&&': [2, (a, b) => Boolean(a) && Boolean(b)],
    '<': [3, (a, b) => (a as number) < (b as number)],
    '<=': [3, (a, b) => (a as number) <= (b as number)],
    '>': [3, (a, b) => (a as number) > (b as number)],
    '>=': [3, (a, b) => (a as number) >= (b as number)],
    '+': [4, (a, b) => map(a, b, (x, y) => x + y)],
    '-': [4, (a, b) => map(a, b, (x, y) => x - y)],
    '*': [5, (a, b) => map(a, b, (x, y) => x * y)],
    '/': [5, (a, b) => map(a, b, (x, y) => x / y)],
  }
  const swizzle = (value: Value, member: string): Value => {
    if (typeof value === 'object' && !Array.isArray(value))
      return (value as Readonly<Record<string, Value>>)[member]!
    const components = lanes(value)
    const picked = member.split('').map((letter) => components['xyzw'.indexOf(letter)]!)
    return picked.length === 1 ? picked[0]! : picked
  }
  const primary = (): Expression => {
    const token = next()
    let expression: Expression
    if (token === '(') {
      expression = parse(0)
      take(')')
    } else if (token === '!') {
      const operand = primary()
      expression = (scope) => !operand(scope)
    } else if (token === '-') {
      const operand = primary()
      expression = (scope) => map(0, operand(scope), (_zero, value) => -value)
    } else if (/^\d/.test(token)) {
      const value = f32(Number(token))
      expression = () => value
    } else if (peek() === '(') {
      take('(')
      const args: Expression[] = []
      while (peek() !== ')') {
        args.push(parse(0))
        if (peek() === ',') take(',')
      }
      take(')')
      const size = /^vec(\d)</.exec(token)?.[1]
      if (size)
        expression = (scope) => {
          const values = args.flatMap((arg) => lanes(arg(scope)))
          return values.length === 1 ? Array<number>(Number(size)).fill(values[0]!) : values
        }
      else if (token === 'length')
        expression = (scope) =>
          f32(
            Math.sqrt(
              lanes(args[0]!(scope)).reduce((sum, value) => f32(sum + f32(value * value)), 0),
            ),
          )
      else throw new Error(`unsupported call ${token}`)
    } else {
      expression = (scope) => {
        if (!scope.has(token)) throw new Error(`unbound ${token}`)
        return scope.get(token)!
      }
    }
    while (peek() === '.') {
      take('.')
      const member = next(),
        base = expression
      expression = (scope) => swizzle(base(scope), member)
    }
    return expression
  }
  const parse = (minimum: number): Expression => {
    let left = primary()
    for (;;) {
      const operator = peek()
      const entry = operator === undefined ? undefined : binary[operator]
      if (!entry || entry[0] <= minimum) return left
      next()
      const [precedence, apply] = entry
      const right = parse(precedence),
        lhs = left
      left = (scope) => apply(lhs(scope), right(scope))
    }
  }
  type Statement = (scope: Map<string, Value>) => { readonly value: Value } | undefined
  const block = (): Statement[] => {
    const statements: Statement[] = []
    take('{')
    while (peek() !== '}') statements.push(statement())
    take('}')
    return statements
  }
  const run = (statements: readonly Statement[], scope: Map<string, Value>) => {
    for (const item of statements) {
      const result = item(scope)
      if (result) return result
    }
    return undefined
  }
  const statement = (): Statement => {
    const token = next()
    if (token === 'var') {
      let skipped = next()
      while (skipped !== ';') skipped = next()
      return () => undefined
    }
    if (token === 'let' || peek() === '=') {
      const name = token === 'let' ? next() : token
      take('=')
      const value = parse(0)
      take(';')
      return (scope) => {
        scope.set(name, value(scope))
        return undefined
      }
    }
    if (token === 'if') {
      const condition = parse(0)
      const then = block()
      let otherwise: Statement[] = []
      if (peek() === 'else') {
        take('else')
        otherwise = block()
      }
      return (scope) => run(condition(scope) ? then : otherwise, scope)
    }
    if (token === 'return') {
      const value = parse(0)
      take(';')
      return (scope) => ({ value: value(scope) })
    }
    throw new Error(`unsupported statement ${token}`)
  }
  return {
    /** Evaluates one expression, such as an `if` condition copied from a shader. */
    expression(scope: Readonly<Record<string, Value>>): Value {
      at = 0
      return parse(0)(new Map(Object.entries(scope)))
    },
    /** Runs a whole `fn name ( a : T, ... ) -> T { ... }` definition. */
    call(...args: readonly Value[]): Value {
      at = 0
      take('fn')
      next()
      take('(')
      const names: string[] = []
      while (peek() !== ')') {
        names.push(next())
        while (peek() !== ',' && peek() !== ')') next()
        if (peek() === ',') take(',')
      }
      take(')')
      take('->')
      next()
      const body = block()
      const scope = new Map<string, Value>(names.map((name, index) => [name, args[index]!]))
      return run(body, scope)!.value
    },
  }
}

/** Largest singular value of the local-to-pixel Jacobian, by central differences in f64. */
function referenceEmPixels(
  modelViewProjection: Matrix4,
  anchor: readonly [number, number, number],
  viewport: readonly [number, number],
  em: number,
): number {
  const m = modelViewProjection.elements
  const pixel = (x: number, y: number): [number, number] => {
    const z = anchor[2]
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
    return [((cx / cw) * viewport[0]) / 2, ((cy / cw) * viewport[1]) / 2]
  }
  const h = 1e-4
  const [x, y] = anchor
  const dx = pixel(x + h, y).map((value, index) => (value - pixel(x - h, y)[index]!) / (2 * h))
  const dy = pixel(x, y + h).map((value, index) => (value - pixel(x, y - h)[index]!) / (2 * h))
  // Eigenvalues of JᵀJ: an independent route from the shader's closed form.
  const a = dx[0]! ** 2 + dx[1]! ** 2,
    b = dx[0]! * dy[0]! + dx[1]! * dy[1]!,
    c = dy[0]! ** 2 + dy[1]! ** 2
  return Math.sqrt((a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b)) * em
}

interface View {
  readonly name: string
  readonly camera: OrthographicCamera | PerspectiveCamera
  readonly object: Object3D
  readonly viewport: readonly [number, number]
  readonly anchors: readonly (readonly [number, number, number])[]
  readonly expected?: number
}

function views(): View[] {
  const make = (
    name: string,
    camera: OrthographicCamera | PerspectiveCamera,
    object: Object3D,
    viewport: readonly [number, number],
    anchors: readonly (readonly [number, number, number])[],
    expected?: number,
  ): View => {
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    object.updateMatrixWorld()
    return {
      name,
      camera,
      object,
      viewport,
      anchors,
      ...(expected === undefined ? {} : { expected }),
    }
  }
  const ortho = () => {
    const camera = new OrthographicCamera(0, 400, 200, 0, -100, 100)
    camera.position.z = 10
    return camera
  }
  const rolled = ortho()
  rolled.rotation.z = (37 * Math.PI) / 180
  const yawed = new Object3D()
  yawed.rotation.y = Math.PI / 3
  yawed.scale.x = -1
  const sheared = new Object3D()
  sheared.matrixAutoUpdate = false
  sheared.matrix.set(1, 0.75, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  const perspective = new PerspectiveCamera(50, 1.5, 0.1, 1000)
  perspective.position.set(3, -40, 25)
  perspective.lookAt(0, 0, 0)
  const tilted = new Object3D()
  tilted.rotation.x = (70 * Math.PI) / 180
  tilted.position.set(-20, 5, -3)
  const anchors = [
    [10, 20, 0],
    [123.25, 45.5, 1],
    [-60, 80, 0.5],
  ] as const
  return [
    // 800 px across 400 units: exactly 2 px per unit, so a 48-unit em is 96 px.
    make('orthographic 1:1', ortho(), new Object3D(), [800, 400], [[10, 20, 0]], 96),
    make('orthographic anisotropic', ortho(), new Object3D(), [1600, 400], anchors, 4 * 48),
    make('orthographic rolled 37°', rolled, new Object3D(), [800, 400], anchors, 96),
    // A 60° yaw halves x, so y's 2 px per unit dominates; the mirror changes nothing.
    make('orthographic yawed and mirrored', ortho(), yawed, [800, 400], anchors, 96),
    make('orthographic sheared', ortho(), sheared, [800, 400], anchors),
    make('perspective', perspective, new Object3D(), [1500, 1000], anchors),
    make(
      'perspective tilted plane',
      perspective,
      tilted,
      [1500, 1000],
      [
        [0, 0, 0],
        [30, -10, 0],
        [-15, 40, 2],
        [60, 60, 0],
      ],
    ),
  ]
}

describe('CPU twin of the projected-em gate', () => {
  it('evaluates the emitted WGSL to the reference σmax·em in orthographic, rotated, and perspective views', async () => {
    const graphs = await generateGraphs(96)
    const evaluator = wgslEvaluator(projectedEmFunction(graphs.sdf.vertex))
    const em = 48
    for (const view of views()) {
      const modelView = new Matrix4().multiplyMatrices(
        view.camera.matrixWorldInverse,
        view.object.matrixWorld,
      )
      const product = new Matrix4().multiplyMatrices(view.camera.projectionMatrix, modelView)
      const e = product.elements.map((value) => Math.fround(value))
      const transform = (v: readonly number[]) =>
        [0, 1, 2, 3].map((row) =>
          Math.fround(
            e[row]! * v[0]! + e[4 + row]! * v[1]! + e[8 + row]! * v[2]! + e[12 + row]! * v[3]!,
          ),
        )
      for (const anchor of view.anchors) {
        const twin = evaluator.call(
          transform([...anchor, 1]),
          transform([1, 0, 0, 0]),
          transform([0, 1, 0, 0]),
          [view.viewport[0] / 2, view.viewport[1] / 2],
          em,
        ) as number
        const reference = referenceEmPixels(product, anchor, view.viewport, em)
        expect(twin, `${view.name} at ${anchor.join(',')}`).toBeGreaterThan(0)
        expect(
          Math.abs(twin - reference) / reference,
          `${view.name} at ${anchor.join(',')}`,
        ).toBeLessThan(1e-5)
        if (view.expected !== undefined) expect(twin / view.expected, view.name).toBeCloseTo(1, 5)
      }
    }
  })

  it('sends anchors on or behind the eye plane, and NaN, to Windfoil alone', async () => {
    const graphs = await generateGraphs(96)
    const evaluator = wgslEvaluator(projectedEmFunction(graphs.windfoil.vertex))
    const behind = evaluator.call([1, 2, 3, -0.5], [1, 0, 0, 0.1], [0, 1, 0, 0.1], [400, 300], 10)
    const onPlane = evaluator.call([1, 2, 3, 0], [1, 0, 0, 0], [0, 1, 0, 0], [400, 300], 10)
    const invalid = evaluator.call(
      [1, 2, 3, Number.NaN],
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [400, 300],
      10,
    )
    for (const value of [behind, onPlane, invalid]) expect(value).toBe(Math.fround(3e38))
  })

  it('partitions every projected em between the batches, overlapping only just above T', async () => {
    const graphs = await generateGraphs(96)
    const sizeSwitch = graphs.backend.sizeSwitch
    // The switch was disposed with its backend, but its hooks are plain node factories.
    expect(sizeSwitch).not.toBeNull()
    const thresholds = (hook: GlyphKeepHook): number[] => {
      const found: number[] = []
      hook(vec2(0), vec3(0, 0, 1)).traverse((node) => {
        if (node instanceof UniformNode && typeof node.value === 'number') found.push(node.value)
      })
      return found
    }
    const T = 96
    expect(thresholds(sizeSwitch!.windfoil)).toEqual([T])
    expect(thresholds(sizeSwitch!.sdf)).toEqual([T * (1 + 2 ** -12)])
    const gate = (vertex: string, threshold: number) => {
      const condition = /let (\w+) = ultraProjectedEm\([^;]*;\s*if \( (.*) \) \{/.exec(vertex)
      expect(condition).not.toBeNull()
      const [, emPixels, source] = condition!
      const uniform = /object\.(\w+)/.exec(source!)![1]!
      const evaluator = wgslEvaluator(source!)
      return (em: number, pixels: number) =>
        evaluator.expression({
          sdfMeta: [0, 0, em],
          [emPixels!]: Math.fround(pixels),
          object: { [uniform]: Math.fround(threshold) },
        }) as boolean
    }
    const windfoil = gate(graphs.windfoil.vertex, T)
    const sdf = gate(graphs.sdf.vertex, T * (1 + 2 ** -12))
    const windfoilShadow = gate(graphs.windfoilShadow.vertex, T)
    const sdfShadow = gate(graphs.sdfShadow.vertex, T * (1 + 2 ** -12))
    const samples = [
      0,
      1,
      T / 2,
      T * (1 - 2 ** -20),
      T,
      T * (1 + 2 ** -14),
      T * (1 + 2 ** -12) * (1 - 2 ** -22),
      T * (1 + 2 ** -12),
      T * (1 + 2 ** -10),
      2 * T,
      3e38,
      Number.NaN,
    ]
    for (const pixels of samples) {
      const f = Math.fround(pixels)
      const keeps = [sdf(10, pixels), windfoil(10, pixels)]
      expect([sdfShadow(10, pixels), windfoilShadow(10, pixels)]).toEqual(keeps)
      const band = f >= T && f < Math.fround(T * (1 + 2 ** -12))
      const expected = Number.isNaN(f)
        ? [false, true]
        : band
          ? [true, true]
          : f < T
            ? [true, false]
            : [false, true]
      expect(keeps, `em ${pixels} px`).toEqual(expected)
      // A zero em marks a glyph that never switches: every batch holding it draws it.
      expect([sdf(0, pixels), windfoil(0, pixels)]).toEqual([true, true])
    }
  })

  it('computes the same emitted function without a backend', () => {
    const renderer = shaderRenderer()
    const sizeSwitch = createSizeSwitch(96, new Set(['a']), new Map(), () => new Float32Array())
    const atlas = companionAtlas([request('a')])
    const geometry = createGlyphGeometry(
      layout(['a'], () => ({ switchEm: 10 })),
      atlas,
      0,
      Float32Array.of(0),
    ).geometry
    const material = new SdfTextMaterial({
      atlas: atlas.texture,
      atlasWidth: 64,
      atlasHeight: 64,
      pxRange: 12,
      runMotion: true,
      keepGlyph: sizeSwitch.sdf,
    })
    const shader = generate(renderer, geometry, material)
    expect(shader.vertex).toContain('fn ultraProjectedEm')
    material.dispose()
    geometry.dispose()
    atlas.dispose()
  })
})
