import {
  type BufferAttribute,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  Scene,
  Texture,
  WebGPUBackend,
  WebGPURenderer,
  WGSLNodeBuilder,
} from 'three/webgpu'
import { vec4 } from 'three/tsl'
import { describe, expect, it, vi } from 'vitest'

import type {
  DomLayoutSnapshot,
  FontStyleSnapshot,
  GlyphRequest,
  GlyphSlot,
  WindfoilBoundingBox,
  WindfoilGlyphOutline,
} from '../src/types.js'
import { preprocessSlugGlyphs, SLUG_ROW_STRIDE } from '../src/slug/preprocessCore.js'
import { SlugMaterial } from '../src/slug/SlugMaterial.js'
import { buildSlugBackend } from '../src/slug/runtime.js'
import { createTracedOutlineProvider } from '../src/windfoil/tracedOutlines.js'
import { installFakeFonts, installFakeGlyphCanvas } from './helpers/fake-glyph-canvas.js'
import { readyForShaderGeneration } from './helpers/shader-renderer.js'

const font = {
  key: 'test-font',
  canvasFont: '16px Test',
  family: 'Test',
  weight: '400',
  style: 'normal',
  stretch: 'normal',
  variant: 'normal',
  kerning: 'auto',
  featureSettings: 'normal',
  variationSettings: 'normal',
  opticalSizing: 'auto',
  size: 16,
} satisfies FontStyleSnapshot

function line(x0: number, y0: number, x1: number, y1: number): readonly number[] {
  return [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1]
}

function outline(
  quadratics: ArrayLike<number>,
  bbox: WindfoilBoundingBox = [0, 0, 10, 10],
): WindfoilGlyphOutline {
  return {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200,
    bbox,
    quadratics,
  }
}

function rectangle(): readonly number[] {
  return [
    ...line(0, 0, 10, 0),
    ...line(10, 0, 10, 10),
    ...line(10, 10, 0, 10),
    ...line(0, 10, 0, 0),
  ]
}

function rendererHarness(webgpu = true): WebGPURenderer {
  const backend = (webgpu ? Object.create(WebGPUBackend.prototype) : {}) as {
    has(attribute: object): boolean
    destroyAttribute(attribute: BufferAttribute): void
  }
  Object.assign(backend, {
    has: vi.fn(() => true),
    destroyAttribute: vi.fn(),
  })
  return {
    backend,
    info: { destroyAttribute: vi.fn() },
    init: vi.fn(() => Promise.resolve()),
  } as unknown as WebGPURenderer
}

function snapshot(glyphKey = 'test-font\u0000A'): DomLayoutSnapshot {
  return {
    width: 100,
    height: 40,
    glyphs: [
      {
        glyphKey,
        fontSize: 20,
        originX: 4,
        lineBottom: 2,
        advance: 12,
        block: 0,
        breakBefore: 'none',
        clip: [0, 0, 100, 40],
        color: [1, 1, 1, 1],
        sequence: 0,
        z: 1,
      },
    ],
    rects: [],
    blocks: [
      {
        left: 0,
        firstBaseline: 20,
        linePitch: 24,
        width: 100,
        clip: [0, 0, 100, 40],
      },
    ],
    requests: [{ key: glyphKey, character: 'A', font }],
    atlasSignature: glyphKey,
    lineCount: 1,
  }
}

describe('Ultra-Slug preprocessing and runtime', () => {
  it('culls orthogonal degenerate segments and packs SoA [p1, p3] | [p2] bidirectional bands', () => {
    const request: GlyphRequest = { key: 'test-font\u0000A', character: 'A', font }
    const prepared = preprocessSlugGlyphs([{ request, outline: outline(rectangle()) }])

    const header = prepared.glyphs.get(request.key)!
    expect(header).toBeDefined()
    expect(header.monotonePieceCount).toBe(4)

    // 1 horizontal band and 1 vertical band packed into bandCount (1 | (1 << 8) = 257).
    const hBandCount = header.bandCount & 0xff
    const vBandCount = header.bandCount >> 8
    expect(hBandCount).toBe(1)
    expect(vBandCount).toBe(1)
    expect(prepared.rows.length).toBe((hBandCount + vBandCount) * SLUG_ROW_STRIDE)

    // A 4-edge axis-aligned rectangle has 2 horizontal edges and 2 vertical edges:
    // - Horizontal band culls the 2 horizontal edges -> only 2 vertical edges remain!
    // - Vertical band culls the 2 vertical edges -> only 2 horizontal edges remain!
    const hPacked = prepared.rows[0]!
    const hCurveStart = hPacked >>> 12
    const hCurveCount = hPacked & 0xfff
    expect(hCurveStart).toBe(0)
    expect(hCurveCount).toBe(2)

    const vPacked = prepared.rows[SLUG_ROW_STRIDE]!
    const vCurveStart = vPacked >>> 12
    const vCurveCount = vPacked & 0xfff
    expect(vCurveStart).toBe(6)
    expect(vCurveCount).toBe(2)

    // Horizontal band SoA layout: [p1_0, p3_0, p1_1, p3_1, p2_0, p2_1]
    expect(Array.from(prepared.curves.slice(0, 12))).toEqual([
      10, 0, 10, 10, 0, 10, 0, 0, 10, 5, 0, 5,
    ])
    // Vertical band in rotated frame (x', y') = (y, -x), SoA layout: [p1_0, p3_0, p1_1, p3_1, p2_0, p2_1]
    expect(Array.from(prepared.curves.slice(12, 24))).toEqual([
      10, -10, 10, -0, 0, -0, 0, -10, 10, -5, 0, -5,
    ])

    // Indented band [6, 0, 7, 10] inside bbox [0, 0, 10, 10] packs non-zero qMin (bits 6..9) and qMax (bits 10..11).
    const indented = [
      ...line(6, 0, 7, 0),
      ...line(7, 0, 7, 10),
      ...line(7, 10, 6, 10),
      ...line(6, 10, 6, 0),
    ]
    const indentedPrepared = preprocessSlugGlyphs(
      [{ request, outline: outline(indented, [0, 0, 10, 10]) }],
      { targetPiecesPerBand: 1 },
    )
    const indentedHRow = indentedPrepared.rows[0]!
    expect(indentedHRow & 0x3f).toBe(2)
    expect((indentedHRow >>> 6) & 0xf).toBeGreaterThan(0)
    expect((indentedHRow >>> 10) & 0x3).toBeGreaterThan(0)
  })

  it('builds a retained Slug backend, creates SlugMaterial & geometry, and disposes cleanly', async () => {
    const renderer = rendererHarness(true)
    const key = 'test-font\u0000A'
    const req: GlyphRequest = { key, character: 'A', font }
    const backend = await buildSlugBackend(
      renderer,
      [req],
      {
        outlineProvider: () => outline(rectangle()),
      },
      new AbortController().signal,
    )

    expect(backend).not.toBeNull()
    expect(backend!.kind).toBe('slug')
    expect(backend!.covers(key)).toBe(true)
    expect(backend!.primaryCovers(key)).toBe(true)

    const layout = snapshot(key)
    const { geometry, maxSequence } = backend!.createGeometry(layout, 18)
    expect(maxSequence).toBe(0)
    expect(backend!.contentFits(geometry, layout)).toBe(true)
    expect(backend!.updateGeometry(geometry, layout, 18)).toBe(0)

    const material = backend!.createMaterial({
      motion: false,
      maxSequence: 0,
      tone: false,
    })
    expect(material).toBeInstanceOf(SlugMaterial)

    geometry.dispose()
    material.dispose()
    backend!.dispose()
  })

  it('handles empty outlines and subdivides non-monotone quadratics across multiple bands', () => {
    const emptyReq: GlyphRequest = { key: 'test-font\u0000 ', character: ' ', font }
    const curveReq: GlyphRequest = { key: 'test-font\u0000S', character: 'S', font }
    // Arch with interior X and Y extrema: (0,0) -> control (12, 12) -> (4, 8), plus closing edges
    const arch = [0, 0, 12, 12, 4, 8, ...line(4, 8, 0, 8), ...line(0, 8, 0, 0)]
    const prepared = preprocessSlugGlyphs(
      [
        { request: emptyReq, outline: outline([], [0, 0, 0, 0]) },
        { request: curveReq, outline: outline(arch, [0, 0, 10, 10]) },
      ],
      { targetPiecesPerBand: 1 },
    )

    const emptyHeader = prepared.glyphs.get(emptyReq.key)!
    expect(emptyHeader.monotonePieceCount).toBe(0)
    expect(emptyHeader.bandCount).toBe(1 | (1 << 8))

    const curveHeader = prepared.glyphs.get(curveReq.key)!
    expect(curveHeader.monotonePieceCount).toBeGreaterThan(3)
    expect(curveHeader.bandCount & 0xff).toBeGreaterThan(1)
    expect(curveHeader.bandCount >> 8).toBeGreaterThan(1)
  })

  it('respects AbortSignal cancellation', () => {
    const controller = new AbortController()
    controller.abort()
    const request: GlyphRequest = { key: 'test-font\u0000A', character: 'A', font }
    expect(() =>
      preprocessSlugGlyphs([{ request, outline: outline(rectangle()) }], {
        signal: controller.signal,
      }),
    ).toThrow()
  })

  it('quantizes qMin and qMax across the full glyph span without multi-band saturation and enforces strict Float32 monotonicity', () => {
    const request: GlyphRequest = { key: 'test-font\u0000I', character: 'I', font }
    // Narrow vertical stem at x in [50, 75] inside a [0, 0, 100, 100] glyph bbox,
    // subdivided into 12 vertical pairs (24 active vertical pieces) so hBandCount = 24.
    const stem: number[] = []
    for (let i = 0; i < 12; i++) {
      const y0 = (i * 100) / 12
      const y1 = ((i + 1) * 100) / 12
      stem.push(75, y0, 75, y1 - 1e-4, 75, y1)
      stem.push(...line(50, y1, 50, y0))
    }
    stem.push(...line(50, 0, 75, 0), ...line(75, 100, 50, 100))
    const prepared = preprocessSlugGlyphs([{ request, outline: outline(stem, [0, 0, 100, 100]) }], {
      targetPiecesPerBand: 1,
    })

    const header = prepared.glyphs.get(request.key)!
    const hBandCount = header.bandCount & 0xff
    const vBandCount = header.bandCount >> 8
    expect(hBandCount).toBe(24)
    expect(vBandCount).toBe(2)

    // In horizontal band 0, uMin = 50 (50% of 100) and uMax = 75 (75% of 100, margin 25%).
    // Conservative full-span quantization (-1e-4 margin): qMin = floor((0.5 - 1e-4) * 16) = 7 (not saturated at 15!),
    // qMax = floor((0.25 - 1e-4) * 4) = 0 (or 1 when > 25%, not saturated at 3!).
    const hRow0 = prepared.rows[0]!
    const qMin = (hRow0 >>> 6) & 0xf
    const qMax = (hRow0 >>> 10) & 0x3
    expect(qMin).toBe(7)
    expect(qMax).toBeLessThan(3)

    // Verify all emitted SoA [c1, c3] | [c2] control points satisfy min(c1, c3) <= c2 <= max(c1, c3) in Float32.
    const totalBands = hBandCount + vBandCount
    for (let r = 0; r < totalBands; r++) {
      const packed = prepared.rows[r * SLUG_ROW_STRIDE]!
      const count = packed & 0x3f
      const curveStart = (packed >>> 12) * 2
      const c2Base = curveStart + count * 4
      for (let i = 0; i < count; i++) {
        const pairIdx = curveStart + i * 4
        const c2Idx = c2Base + i * 2
        const c1x = prepared.curves[pairIdx]!
        const c1y = prepared.curves[pairIdx + 1]!
        const c3x = prepared.curves[pairIdx + 2]!
        const c3y = prepared.curves[pairIdx + 3]!
        const c2x = prepared.curves[c2Idx]!
        const c2y = prepared.curves[c2Idx + 1]!
        expect(c2x).toBeGreaterThanOrEqual(Math.min(c1x, c3x))
        expect(c2x).toBeLessThanOrEqual(Math.max(c1x, c3x))
        expect(c2y).toBeGreaterThanOrEqual(Math.min(c1y, c3y))
        expect(c2y).toBeLessThanOrEqual(Math.max(c1y, c3y))
      }
    }
  })

  it('solves curved quadratic straddle intersections with exact second-difference a = (c3 - c2) + b and emits isolated beauty/shadow WGSL', async () => {
    // Verify the Citardauq quadratic root math used in slug_solve_straddle on a curved monotone segment:
    // Segment from p1 = (0, -4) via control p2 = (2, -3) to p3 = (10, 6), crossing y = 0.
    // True B_y(t) = (y1 - 2*y2 + y3)*t^2 - 2*(y1 - y2)*t + y1 = 8*t^2 + 2*t - 4 = 0 => t = 4 / (1 + sqrt(33)).
    // At t = 0.59307033, true B_x(t) = 6*t^2 + 4*t = 4.48267583 (whereas the buggy a = c3 - c1 gave 4.196).
    const c1 = { x: 0, y: -4 }
    const c2 = { x: 2, y: -3 }
    const c3 = { x: 10, y: 6 }
    const bx = c1.x - c2.x
    const by = c1.y - c2.y
    const ax = c3.x - c2.x + bx
    const ay = c3.y - c2.y + by
    const s = c1.y < 0 ? -1 : 1
    const d = Math.sqrt(Math.max(by * by - ay * c1.y, 0))
    const t = c1.y / (s * d + by)
    const xHit = (ax * t - 2 * bx) * t + c1.x
    const residualY = (ay * t - 2 * by) * t + c1.y
    expect(residualY).toBeCloseTo(0, 6)
    expect(xHit).toBeCloseTo(4.48267583, 6)

    // Generate WGSL for both the beauty pass and shadow pass of SlugMaterial.
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
    const renderer = readyForShaderGeneration(
      new WebGPURenderer({ canvas: document.createElement('canvas') }),
    )
    vi.spyOn(renderer, 'init').mockResolvedValue(renderer)
    vi.spyOn(renderer, 'setAnimationLoop').mockResolvedValue(undefined)
    vi.spyOn(renderer, 'hasFeature').mockReturnValue(false)

    try {
      const key = 'test-font\u0000A'
      const req: GlyphRequest = { key, character: 'A', font }
      const backend = await buildSlugBackend(
        renderer,
        [req],
        { outlineProvider: () => outline(rectangle()) },
        new AbortController().signal,
      )
      const layout = snapshot(key)
      const { geometry } = backend!.createGeometry(layout, 18)
      const material = backend!.createMaterial({
        motion: false,
        maxSequence: 0,
        tone: false,
      })

      const buildWgsl = (mat: Material) => {
        const mesh = new Mesh(geometry, mat)
        const scene = new Scene()
        scene.add(mesh)
        const builder = new WGSLNodeBuilder(mesh, renderer) as unknown as {
          scene: Scene
          camera: OrthographicCamera
          material: Material
          context: { material: Material }
          build(): void
          fragmentShader: string
        }
        builder.scene = scene
        builder.camera = new OrthographicCamera(0, 100, 40, 0, 0.1, 10)
        builder.material = mat
        builder.context.material = mat
        builder.build()
        // Reflection, shadow and camera passes build separate programs on the same renderer.
        // Cached function code must still register the buffers with each new builder.
        expect(builder.fragmentShader).toMatch(/var<storage, read> ultraWindfoilRows\b/)
        expect(builder.fragmentShader).toMatch(/var<storage, read> ultraWindfoilCurves\b/)
        return builder.fragmentShader
      }

      const beautyFragment = buildWgsl(material)
      buildWgsl(material)
      expect(beautyFragment).toContain('slug_solve_straddle')
      expect(beautyFragment).toContain('slug_combine_rays')
      expect(beautyFragment).toContain('let a = (c3 - c2) + b;')
      expect(beautyFragment).toContain('return vec2f(s * u, fma(-u, u, u));')
      expect(beautyFragment).toContain('let wx = xc.y * xc.y;')
      expect(beautyFragment).not.toContain('slug_solve_shadow_straddle')

      const shadowMaterial = new MeshBasicNodeMaterial()
      shadowMaterial.positionNode = material.castShadowPositionNode
      shadowMaterial.maskNode = material.maskShadowNode
      shadowMaterial.colorNode = vec4(1)
      const shadowFragment = buildWgsl(shadowMaterial)
      buildWgsl(shadowMaterial)
      expect(shadowFragment).toContain('slug_solve_shadow_straddle')
      expect(shadowFragment).toContain('let a = (c3 - c2) + b;')
      expect(shadowFragment).not.toContain('slug_combine_rays')

      shadowMaterial.dispose()
      material.dispose()
      geometry.dispose()
      backend!.dispose()
    } finally {
      await renderer.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('builds Slug from traced outlines and routes colour ink to the SDF companion', async () => {
    installFakeGlyphCanvas({
      Z: {
        boxes: [
          [0.1, 0, 0.6, 0.1],
          [0.3, 0.1, 0.4, 0.6],
          [0.1, 0.6, 0.6, 0.7],
        ],
        advance: 0.7,
      },
      '🚀': { boxes: [[0.05, -0.1, 0.95, 0.8]], advance: 1, color: [220, 60, 40] },
    })
    const fonts = installFakeFonts()
    try {
      const z: GlyphRequest = { key: 'test-font\u0000Z', character: 'Z', font }
      const rocket: GlyphRequest = { key: 'test-font\u0000🚀', character: '🚀', font }
      const companion = {
        texture: new Texture(),
        width: 4,
        height: 4,
        pxRange: 2,
        bakeSize: 16,
        mode: 'cpu' as const,
        glyphs: new Map([[rocket.key, {} as GlyphSlot]]),
        dispose: vi.fn(),
      }
      const build = vi.fn(() => Promise.resolve(companion))
      const traced = createTracedOutlineProvider(document)
      const backend = await buildSlugBackend(
        rendererHarness(true),
        [z, rocket],
        { outlineProvider: traced.provider, fallback: 'sdf-glyphs' },
        new AbortController().signal,
        { build },
      )
      expect(backend!.primaryCovers(z.key)).toBe(true)
      expect(backend!.glyphs.get(z.key)!.monotonePieceCount).toBeGreaterThanOrEqual(4)
      expect(build).toHaveBeenCalledWith([rocket], expect.any(AbortSignal))
      expect(backend!.covers(rocket.key)).toBe(true)
      expect(backend!.primaryCovers(rocket.key)).toBe(false)
      backend!.dispose()
      expect(companion.dispose).toHaveBeenCalledOnce()
    } finally {
      fonts.restore()
    }
  })
})
