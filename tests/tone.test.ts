import { Color } from 'three/webgpu'
import { float, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import {
  resolveTextTone,
  srgbEncode,
  TextTone,
  toneCoverage,
  toneLightness,
  type ResolvedTextTone,
} from '../src/text/tone.js'

// The sRGB decode approximation the conversion is built on, written out independently.
const P = (x: number): number => x * (x * (0.305306011 * x + 0.682171111) + 0.012522878)
const srgbDecode = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)

const tone = (overrides: Partial<ResolvedTextTone> = {}): ResolvedTextTone => ({
  strength: 1,
  backdrop: 1,
  table: 0,
  dilationEm: 0,
  dilationPx: 0,
  bigPx: 0,
  framed: false,
  ...overrides,
})
const steps = (count: number): number[] => Array.from({ length: count + 1 }, (_, n) => n / count)

describe('resolveTextTone', () => {
  it('defaults to the exact outline over white at full strength', () => {
    expect(resolveTextTone(undefined)).toEqual(tone())
    expect(resolveTextTone({})).toEqual(tone())
    expect(resolveTextTone({ model: 'auto', backdrop: 'auto' })).toEqual(tone())
  })

  it('returns null for false and passes a resolved tone through', () => {
    expect(resolveTextTone(false)).toBeNull()
    expect(resolveTextTone(false, { model: 'macos', backdrop: 0 })).toBeNull()
    const resolved = tone({ strength: 0.4, backdrop: 0.2, table: 1 })
    expect(resolveTextTone(resolved)).toBe(resolved)
    expect(resolveTextTone(resolved, { model: 'macos', backdrop: 1 })).toBe(resolved)
  })

  it('gives each model its table and dilation over a backdrop it knows', () => {
    const backdrop = '#ffffff'
    const framed = true
    expect(resolveTextTone({ model: 'outline', backdrop })).toEqual(tone({ framed }))
    expect(resolveTextTone({ model: 'windows', backdrop })).toEqual(tone({ table: 1, framed }))
    expect(resolveTextTone({ model: 'macos', backdrop })).toEqual(
      tone({ table: 1, dilationEm: 0.0058, dilationPx: 0.3, bigPx: 256, framed }),
    )
  })

  it('counts a backdrop as drawn in the frame when it is named or the context draws it', () => {
    // A named colour is the caller's word that the scene shows it behind the text.
    expect(resolveTextTone({ backdrop: '#102030' })!.framed).toBe(true)
    expect(resolveTextTone({ backdrop: 0xffffff }, { backdrop: 0 })!.framed).toBe(true)
    // A backdrop the context read from the page is known, yet nothing says the frame holds it.
    expect(resolveTextTone(undefined, { backdrop: 0.2 })!.framed).toBe(false)
    expect(resolveTextTone({ backdrop: 'auto' }, { backdrop: 0.2, framed: false })!.framed).toBe(
      false,
    )
    expect(resolveTextTone(undefined, { backdrop: 0.2, framed: true })!.framed).toBe(true)
    expect(resolveTextTone({ model: 'macos' }, { framed: true })!.framed).toBe(true)
  })

  it('takes true as the default tone and rejects any other value that is not an object', () => {
    const loose = resolveTextTone as (options: unknown, context?: unknown) => unknown
    expect(loose(true)).toEqual(tone())
    expect(loose(true, { model: 'windows', backdrop: 0.25 })).toEqual(
      tone({ backdrop: 0.25, table: 1 }),
    )
    expect(loose(null)).toEqual(tone())
    for (const mistake of ['auto', 1, 0, '', Symbol('tone'), () => undefined])
      expect(() => loose(mistake), String(mistake)).toThrow(
        new TypeError('ultra-text: tone must be an options object or false'),
      )
  })

  it('turns the ink table off while the backdrop is unknown, and keeps the dilation', () => {
    // Neither the options nor the context name a backdrop: white is only assumed.
    const smoothed = tone({ dilationEm: 0.0058, dilationPx: 0.3, bigPx: 256 })
    expect(resolveTextTone({ model: 'outline' })).toEqual(tone())
    expect(resolveTextTone({ model: 'windows' })).toEqual(tone())
    expect(resolveTextTone({ model: 'macos' })).toEqual(smoothed)
    expect(resolveTextTone({ model: 'macos', backdrop: 'auto' })).toEqual(smoothed)
    expect(resolveTextTone(undefined, { model: 'macos' })).toEqual(smoothed)
    expect(resolveTextTone({}, { model: 'windows', backdrop: undefined })).toEqual(tone())
    // A white backdrop somebody named is known, though it is the same white.
    expect(resolveTextTone({ model: 'windows', backdrop: 0xffffff })!.table).toBe(1)
    expect(resolveTextTone({ model: 'windows' }, { backdrop: 1 })!.table).toBe(1)
    expect(resolveTextTone(undefined, { model: 'macos', backdrop: 1 })!.table).toBe(1)
  })

  it('takes the model and backdrop from the context only when the options say auto', () => {
    const context = { model: 'macos', backdrop: 0 } as const
    expect(resolveTextTone(undefined, context)).toEqual(
      tone({ backdrop: 0, table: 1, dilationEm: 0.0058, dilationPx: 0.3, bigPx: 256 }),
    )
    expect(resolveTextTone({ model: 'auto' }, { model: 'windows', backdrop: 0.25 })).toEqual(
      tone({ backdrop: 0.25, table: 1 }),
    )
    expect(resolveTextTone({ model: 'outline', backdrop: '#ffffff' }, context)).toEqual(
      tone({ framed: true }),
    )
    expect(resolveTextTone({ backdrop: 0xffffff }, context)!.backdrop).toBe(1)
    expect(resolveTextTone({ model: 'windows' }, context)!.dilationPx).toBe(0)
  })

  it('reads the backdrop as the encoded lightness of its linear luminance', () => {
    expect(resolveTextTone({ backdrop: '#000000' })!.backdrop).toBe(0)
    expect(resolveTextTone({ backdrop: 0xffffff })!.backdrop).toBe(1)
    // A grey is as light as its own encoded value.
    expect(resolveTextTone({ backdrop: '#777777' })!.backdrop).toBeCloseTo(0x77 / 255, 6)
    expect(resolveTextTone({ backdrop: new Color(0x404040) })!.backdrop).toBeCloseTo(0x40 / 255, 6)
    // A colour is as light as the grey of the same luminance.
    expect(resolveTextTone({ backdrop: '#ff0000' })!.backdrop).toBeCloseTo(srgbEncode(0.2126), 6)
    expect(resolveTextTone({ backdrop: '#00ff00' })!.backdrop).toBeCloseTo(srgbEncode(0.7152), 6)
    expect(toneLightness('#0000ff')).toBeCloseTo(srgbEncode(0.0722), 6)
  })

  it('clamps the strength and ignores one that is not a number', () => {
    expect(resolveTextTone({ strength: 0 })!.strength).toBe(0)
    expect(resolveTextTone({ strength: 0.35 })!.strength).toBe(0.35)
    expect(resolveTextTone({ strength: -2 })!.strength).toBe(0)
    expect(resolveTextTone({ strength: 7 })!.strength).toBe(1)
    expect(resolveTextTone({ strength: Number.NaN })!.strength).toBe(1)
    expect(resolveTextTone({ strength: Number.POSITIVE_INFINITY })!.strength).toBe(1)
    expect(resolveTextTone({ strength: Number.NEGATIVE_INFINITY })!.strength).toBe(0)
    // From JavaScript: a value that is no number at all must not reach the uniforms as NaN.
    for (const strength of ['x', {}, [], '0.5', null, true]) {
      const resolved = resolveTextTone({ strength } as never)!
      expect(resolved.strength, JSON.stringify(strength)).toBe(1)
      expect(new TextTone(resolved).ink.value.toArray()).toEqual([1, 1, 0])
      expect(toneCoverage(resolved, 0, 0)).toBe(0)
    }
  })

  it('keeps the macOS outline dilation whole at every strength', () => {
    for (const strength of [0, 0.25, 1]) {
      const resolved = resolveTextTone({ model: 'macos', strength })!
      expect([resolved.dilationEm, resolved.dilationPx, resolved.bigPx]).toEqual([0.0058, 0.3, 256])
      expect(new TextTone(resolved).dilation.value.toArray()).toEqual([0.0058, 0.3, 256])
    }
    // At zero the coverage of that dilated outline is exact.
    const none = resolveTextTone({ model: 'macos', strength: 0, backdrop: '#000' })!
    for (const coverage of steps(16)) expect(toneCoverage(none, 1, coverage)).toBeCloseTo(coverage)
  })
})

describe('srgbEncode', () => {
  it('is the exact piecewise transfer function and inverts the decode', () => {
    expect(srgbEncode(0)).toBe(0)
    expect(srgbEncode(1)).toBe(1)
    expect(srgbEncode(0.002)).toBeCloseTo(0.02584, 12)
    expect(srgbEncode(0.5)).toBeCloseTo(0.735356983, 8)
    expect(srgbEncode(-1)).toBe(0)
    expect(srgbEncode(3)).toBe(1)
    for (const value of steps(64)) expect(srgbEncode(srgbDecode(value))).toBeCloseTo(value, 9)
  })
})

describe('toneCoverage', () => {
  const backdrops = [0, 0.03, 0.2, 0.4667, 0.5, 0.75, 0.97, 1]
  const inks = [0, 0.01, 0.24, 0.25, 0.4667, 0.5, 0.74, 0.76, 0.99, 1]
  const strengths = [0, 0.3, 0.5, 1]
  const tables = [0, 1] as const
  const each = (visit: (resolved: ResolvedTextTone, ink: number, label: string) => void): void => {
    for (const backdrop of backdrops)
      for (const ink of inks)
        for (const strength of strengths)
          for (const table of tables)
            visit(
              tone({ backdrop, strength, table }),
              ink,
              `b=${backdrop} i=${ink} S=${strength} table=${table}`,
            )
  }

  it('keeps zero coverage exactly zero and full coverage one', () => {
    each((resolved, ink, label) => {
      expect(toneCoverage(resolved, ink, 0), label).toBe(0)
      const full = toneCoverage(resolved, ink, 1)
      expect(Math.abs(full - 1), label).toBeLessThan(1e-6)
      expect(full, label).toBeLessThanOrEqual(1)
    })
  })

  it('rises with coverage and stays inside [0, 1] for every ink, backdrop and strength', () => {
    each((resolved, ink, label) => {
      let previous = 0
      for (const coverage of steps(512)) {
        const value = toneCoverage(resolved, ink, coverage)
        // Compared in place: an assertion per step costs far more than the sweep itself.
        if (!(value >= previous - 1e-12 && value <= 1))
          expect.fail(`${label} u=${coverage}: ${value} after ${previous}`)
        previous = value
      }
    })
  })

  it('is the encoded-space blend seen in linear light', () => {
    // a' = (P(b + (i - b) m) - P(b)) / (P(i) - P(b)), blended with the mask m by the strength.
    each((resolved, ink, label) => {
      const { backdrop, strength } = resolved
      if (Math.abs(ink - backdrop) < 1e-3) return
      const weight = (strength * resolved.table * Math.min(Math.floor(4 * ink), 3)) / 3
      for (const coverage of steps(32)) {
        const mask = coverage + weight * coverage * (1 - coverage)
        const blend = (P(backdrop + (ink - backdrop) * mask) - P(backdrop)) / (P(ink) - P(backdrop))
        expect(toneCoverage(resolved, ink, coverage), `${label} u=${coverage}`).toBeCloseTo(
          (1 - strength) * mask + strength * blend,
          9,
        )
      }
    })
  })

  it('leaves the mask alone where ink and backdrop are equally light', () => {
    for (const lightness of [0, 0.1, 0.5, 0.8, 1])
      for (const table of tables)
        for (const coverage of steps(32)) {
          const weight = (table * Math.min(Math.floor(4 * lightness), 3)) / 3
          expect(
            toneCoverage(tone({ backdrop: lightness, table }), lightness, coverage),
          ).toBeCloseTo(coverage + weight * coverage * (1 - coverage), 12)
        }
  })

  it('returns exact coverage at strength zero', () => {
    each((resolved, ink, label) => {
      if (resolved.strength !== 0) return
      for (const coverage of steps(32))
        expect(toneCoverage(resolved, ink, coverage), label).toBeCloseTo(coverage, 12)
    })
  })

  it('darkens black ink on white and thins white ink on black along the decode curve', () => {
    for (const coverage of steps(64)) {
      expect(toneCoverage(tone(), 0, coverage)).toBeCloseTo(1 - P(1 - coverage) / P(1), 9)
      expect(toneCoverage(tone({ backdrop: 0 }), 1, coverage)).toBeCloseTo(P(coverage) / P(1), 9)
    }
    // Half-covered black ink on white lands on the browser's mid grey, not on linear 0.5.
    expect(toneCoverage(tone(), 0, 0.5)).toBeCloseTo(1 - P(0.5), 9)
    expect(toneCoverage(tone(), 0, 0.5)).toBeGreaterThan(0.78)
    expect(toneCoverage(tone({ backdrop: 0 }), 1, 0.5)).toBeLessThan(0.22)
  })

  it('neither thins nor lifts white ink while the backdrop is unknown, whatever the model', () => {
    for (const model of ['outline', 'macos', 'windows'] as const) {
      const unknown = resolveTextTone({ model })!
      for (const coverage of steps(64)) {
        expect(toneCoverage(unknown, 1, coverage), model).toBeCloseTo(coverage, 12)
        // Dark ink is toned as on a white page.
        expect(toneCoverage(unknown, 0, coverage), model).toBeCloseTo(1 - P(1 - coverage) / P(1), 9)
      }
      for (const ink of inks)
        for (const coverage of steps(32))
          expect(toneCoverage(unknown, ink, coverage)).toBeGreaterThanOrEqual(coverage - 1e-12)
    }
    // Over a white somebody named, the table lifts white ink as the rasterizer does.
    const known = resolveTextTone({ model: 'windows', backdrop: '#fff' })!
    expect(toneCoverage(known, 1, 0.5)).toBeCloseTo(0.75, 12)
  })

  it('weights the table by ink class: none for dark ink, all of it for light ink', () => {
    const windows = tone({ backdrop: 0.5, table: 1 })
    const outline = tone({ backdrop: 0.5 })
    // Below a quarter the class weight is zero, so both models agree.
    expect(toneCoverage(windows, 0.2, 0.5)).toBe(toneCoverage(outline, 0.2, 0.5))
    const rise = (ink: number): number =>
      toneCoverage(tone({ backdrop: ink, table: 1 }), ink, 0.5) - 0.5
    expect(rise(0.1)).toBeCloseTo(0, 12)
    expect(rise(0.3)).toBeCloseTo(0.25 / 3, 12)
    expect(rise(0.6)).toBeCloseTo(0.5 / 3, 12)
    expect(rise(0.8)).toBeCloseTo(0.25, 12)
    expect(rise(1)).toBeCloseTo(0.25, 12)
    // The strength scales the table with the rest of the conversion.
    expect(toneCoverage(tone({ backdrop: 1, table: 1, strength: 0.5 }), 1, 0.5)).toBeCloseTo(
      0.5 + 0.125,
      12,
    )
  })

  it('converts the mask times the opacity of translucent ink', () => {
    // A browser blends mask x alpha on encoded values: the pixel is P(b + (i - b) m a).
    each((resolved, ink, label) => {
      const { backdrop, strength } = resolved
      if (Math.abs(ink - backdrop) < 1e-3) return
      const weight = (strength * resolved.table * Math.min(Math.floor(4 * ink), 3)) / 3
      for (const opacity of [0, 0.25, 0.5, 0.8, 1])
        for (const coverage of steps(16)) {
          const mask = (coverage + weight * coverage * (1 - coverage)) * opacity
          const blend =
            (P(backdrop + (ink - backdrop) * mask) - P(backdrop)) / (P(ink) - P(backdrop))
          expect(
            toneCoverage(resolved, ink, coverage, opacity),
            `${label} u=${coverage} a=${opacity}`,
          ).toBeCloseTo((1 - strength) * mask + strength * blend, 9)
        }
    })
    // Half-opaque black on white is the browser's mid grey, not half of the opaque conversion.
    expect(toneCoverage(tone(), 0, 1, 0.5)).toBeCloseTo(1 - P(0.5), 9)
    expect(toneCoverage(tone(), 0, 1, 0.5)).toBeGreaterThan(0.78)
    expect(toneCoverage(tone(), 0, 1) * 0.5).toBe(0.5)
    // Opaque ink is the conversion without the argument.
    each((resolved, ink) => {
      for (const coverage of steps(8))
        expect(toneCoverage(resolved, ink, coverage, 1)).toBe(toneCoverage(resolved, ink, coverage))
    })
  })

  it('approximates the true sRGB decode within a level and a half of an 8-bit target', () => {
    let worst = 0
    for (const coverage of steps(255)) {
      const exact = 1 - srgbDecode(1 - coverage)
      worst = Math.max(worst, Math.abs(toneCoverage(tone(), 0, coverage) - exact))
    }
    expect(worst * 255).toBeLessThan(1.5)
  })
})

describe('TextTone', () => {
  it('holds the resolved tone in uniforms read by one shader stage each', () => {
    const resolved = tone({ backdrop: 0.25, strength: 0.6, table: 1 })
    const owner = new TextTone(resolved)
    expect(owner.resolved).toBe(resolved)
    expect(owner.dilates).toBe(false)
    expect(owner.ink.value.toArray()).toEqual([0.25, 0.6, 0.6 / 3])
    const k1 = 0.682171111 + 3 * 0.305306011 * 0.25
    const k0 = 0.012522878 + 2 * 0.682171111 * 0.25 + 3 * 0.305306011 * 0.25 * 0.25
    expect(owner.curve.value.x).toBeCloseTo(k0, 12)
    expect(owner.curve.value.y).toBeCloseTo(k1, 12)
    expect(owner.curve.value.z).toBeCloseTo(0.4, 12)
    expect(owner.dilation.value.toArray()).toEqual([0, 0, 0])
  })

  it('follows a later backdrop and strength without changing its kind', () => {
    const owner = new TextTone(tone())
    const dark = tone({ backdrop: 0, strength: 0.5 })
    expect(owner.fits(dark)).toBe(true)
    owner.update(dark)
    expect(owner.resolved).toBe(dark)
    expect(owner.ink.value.toArray()).toEqual([0, 0.5, 0])
    expect(owner.curve.value.toArray()).toEqual([0.012522878, 0.682171111, 0.5])
    // Outline and Windows differ only in a uniform; the macOS model needs its own graph.
    expect(owner.fits(tone({ table: 1 }))).toBe(true)
    const macos = resolveTextTone({ model: 'macos' })!
    expect(owner.fits(macos)).toBe(false)
    const dilating = new TextTone(macos)
    expect(dilating.dilates).toBe(true)
    expect(dilating.dilation.value.toArray()).toEqual([0.0058, 0.3, 256])
    expect(dilating.fits(tone())).toBe(false)
    expect(dilating.fits(macos)).toBe(true)
  })

  it('builds the per-ink terms and the conversion from its own uniforms', () => {
    const owner = new TextTone(tone())
    const references = (root: { traverse(visit: (node: unknown) => void): void }) => {
      const found = new Set<unknown>()
      root.traverse((node) => found.add(node))
      return found
    }
    const terms = owner.inkTerms(vec3(0.2, 0.3, 0.4))
    expect(references(terms).has(owner.ink)).toBe(true)
    expect(references(terms).has(owner.curve)).toBe(false)
    const gate = float(1)
    const toned = owner.apply(float(0.5), terms, gate)
    expect(references(toned).has(owner.curve)).toBe(true)
    expect(references(toned).has(gate)).toBe(true)
    expect(references(owner.apply(float(0.5), terms)).has(gate)).toBe(false)
    // The dilation uniform belongs to the backends' macOS graphs only.
    expect(references(toned).has(owner.dilation)).toBe(false)
    // Opaque ink is clamped here; with the ink's opacity the caller clamps the product.
    const opacity = float(0.5)
    const factor = owner.apply(float(0.5), terms, undefined, opacity)
    expect(references(factor).has(opacity)).toBe(true)
    expect(references(toned).has(opacity)).toBe(false)
    // TSL hands a function's result out behind a variable intent.
    const method = (node: unknown): unknown => {
      const inner = node as { node?: { method?: string }; method?: string }
      return (inner.node ?? inner).method
    }
    expect(method(toned)).toBe('min')
    expect(method(factor)).not.toBe('min')
  })

  describe('in a render', () => {
    // What three's renderer and scene report during one render.
    const pass = (
      renderer: {
        alpha?: boolean
        clearAlpha?: number
        target?: { isPostProcessingRenderTarget?: boolean } | null
      } | null,
      scene: { background?: unknown; backgroundNode?: unknown } | null = {},
    ) => ({
      renderer: renderer && {
        alpha: renderer.alpha ?? true,
        getClearAlpha: () => renderer.clearAlpha ?? 0,
        getRenderTarget: () => renderer.target ?? null,
      },
      scene,
    })
    const resolved = tone({ backdrop: 0.25, strength: 0.6, table: 1 })
    const converting = { ink: [0.25, 0.6, 0.6 / 3], rest: 0.4 }
    const standingDown = { ink: [0.25, 0, 0.6 / 3], rest: 1 }
    const during = (owner: TextTone, frame: ReturnType<typeof pass>) => {
      owner.curve.update(frame as never)
      return { ink: owner.ink.value.toArray(), rest: owner.curve.value.z }
    }

    it('stands the blend down over nothing in the frame, and keeps the table', () => {
      // three's default canvas: transparent, cleared to alpha 0, no scene background.
      const owner = new TextTone(resolved)
      const k = owner.curve.value.toArray().slice(0, 2)
      expect(during(owner, pass({}))).toEqual(standingDown)
      // The backdrop polynomial and the dilation law are untouched.
      expect(owner.curve.value.toArray().slice(0, 2)).toEqual(k)
      const macos = new TextTone(resolveTextTone({ model: 'macos' })!)
      expect(during(macos, pass({})).ink).toEqual([1, 0, 0])
      expect(macos.dilation.value.toArray()).toEqual([0.0058, 0.3, 256])
      // The same holds in a transparent render target, and behind three's frame buffer.
      expect(during(owner, pass({ target: {} }))).toEqual(standingDown)
      expect(during(owner, pass({ target: { isPostProcessingRenderTarget: true } }))).toEqual(
        standingDown,
      )
    })

    it('converts where the frame holds what the text is blended over', () => {
      const frames = [
        pass({}, { background: {} }),
        pass({}, { backgroundNode: {} }),
        pass({ clearAlpha: 1 }),
        pass({ alpha: false, clearAlpha: 0 }),
        pass({ alpha: false, clearAlpha: 0, target: { isPostProcessingRenderTarget: true } }),
        pass(null),
      ]
      for (const frame of frames) {
        const owner = new TextTone(resolved)
        // From the other state, so that the frame is what restores the conversion.
        expect(during(owner, pass({}))).toEqual(standingDown)
        expect(during(owner, frame)).toEqual(converting)
      }
      // An opaque canvas says nothing about a transparent target of the caller's own.
      const owner = new TextTone(resolved)
      expect(during(owner, pass({ alpha: false, clearAlpha: 0, target: {} }))).toEqual(standingDown)
    })

    it('always converts over a backdrop the tone knows to be drawn', () => {
      const owner = new TextTone({ ...resolved, framed: true })
      expect(during(owner, pass({}))).toEqual(converting)
      expect(during(owner, pass({ target: {} }))).toEqual(converting)
    })

    it('follows each render and a later tone from the state of the last frame', () => {
      const owner = new TextTone(resolved)
      expect(during(owner, pass({}))).toEqual(standingDown)
      // A recapture while the frame is transparent stays exact.
      owner.update(tone({ backdrop: 0, strength: 1, table: 1 }))
      expect(owner.ink.value.toArray()).toEqual([0, 0, 1 / 3])
      expect(owner.curve.value.z).toBe(1)
      expect(during(owner, pass({}, { background: {} }))).toEqual({ ink: [0, 1, 1 / 3], rest: 0 })
      // A tone that becomes framed converts at once, before any render.
      expect(during(owner, pass({})).rest).toBe(1)
      owner.update(tone({ backdrop: 0, framed: true }))
      expect(owner.curve.value.z).toBe(1)
      expect(during(owner, pass({})).rest).toBe(0)
    })
  })
})
