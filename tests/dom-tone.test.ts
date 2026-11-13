import {
  Color,
  type Group,
  InstancedBufferGeometry,
  Mesh,
  SRGBColorSpace,
  Texture,
  WebGPUBackend,
  type WebGPURenderer,
} from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as RasterModule from '../src/atlas/rasterize.js'
import type { RasterizeOptions } from '../src/atlas/rasterize.js'
import type * as DomToneModule from '../src/dom/tone.js'
import type {
  BuildSdfAtlasOptions,
  DomLayoutSnapshot,
  DomSdfOptions,
  GlyphLayout,
  GlyphRequest,
  GlyphSlot,
  RasterAtlas,
  RectLayout,
  SdfAtlas,
} from '../src/types.js'
import type * as SdfMaterialModule from '../src/text/SdfTextMaterial.js'
import type { SdfTextMaterialOptions } from '../src/text/SdfTextMaterial.js'
import type * as WindfoilRuntime from '../src/windfoil/runtime.js'
import type { WindfoilBackend } from '../src/windfoil/runtime.js'

const domMocks = vi.hoisted(() => ({
  snapshot:
    vi.fn<
      (root: HTMLElement, options?: DomSdfOptions) => DomLayoutSnapshot | Promise<DomLayoutSnapshot>
    >(),
  rasterize:
    vi.fn<
      (
        document: Document,
        requests: readonly GlyphRequest[],
        options?: RasterizeOptions,
      ) => Promise<RasterAtlas>
    >(),
  buildAtlas:
    vi.fn<
      (
        renderer: WebGPURenderer,
        raster: RasterAtlas,
        options?: BuildSdfAtlasOptions,
      ) => Promise<SdfAtlas>
    >(),
  buildWindfoil: vi.fn<() => Promise<WindfoilBackend | null>>(),
  /** The options every SDF material was built from, in order. */
  sdfMaterials: [] as SdfTextMaterialOptions[],
}))

vi.mock('../src/dom/snapshot.js', () => ({
  collectDomSnapshot: domMocks.snapshot,
}))

vi.mock('../src/atlas/rasterize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RasterModule>()),
  rasterizeGlyphAtlas: domMocks.rasterize,
}))

vi.mock('../src/atlas/buildAtlas.js', () => ({
  buildSdfAtlas: domMocks.buildAtlas,
}))

vi.mock('../src/windfoil/runtime.js', () => ({
  buildWindfoilBackend: domMocks.buildWindfoil,
}))

vi.mock('../src/text/SdfTextMaterial.js', async (importOriginal) => {
  const original = await importOriginal<typeof SdfMaterialModule>()
  return {
    ...original,
    SdfTextMaterial: class extends original.SdfTextMaterial {
      constructor(options: SdfTextMaterialOptions) {
        domMocks.sdfMaterials.push(options)
        super(options)
      }
    },
  }
})

import { DomSdf } from '../src/dom/DomSdf.js'
import { Text } from '../src/dom/Text.js'
import { resolveDomTextTone } from '../src/dom/tone.js'
import type { GlyphTextMaterial } from '../src/text/GlyphTextMaterial.js'
import * as geometryBuilders from '../src/text/geometry.js'
import { SdfTextMaterial } from '../src/text/SdfTextMaterial.js'
import { resolveTextTone, toneLightness } from '../src/text/tone.js'
import { WindfoilMaterial } from '../src/windfoil/WindfoilMaterial.js'

// Each model over a white page that was read: a backdrop nobody read has no ink table, and
// one that was only read is not known to be drawn in the frame.
const OUTLINE = resolveTextTone({ model: 'outline' }, { backdrop: 1 })!
const MACOS = resolveTextTone({ model: 'macos' }, { backdrop: 1 })!
const WINDOWS = resolveTextTone({ model: 'windows' }, { backdrop: 1 })!
/** What a backdrop that is certainly drawn in the frame adds: a named one, or an opaque rectangle. */
const DRAWN = { framed: true } as const

const stubbedNavigator: string[] = []

/** What the page's navigator reports; jsdom itself reports no platform at all. */
function platform(values: { platform?: string; brand?: string; touch?: number }): void {
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(navigator, key, { configurable: true, value })
    stubbedNavigator.push(key)
  }
  if (values.platform !== undefined) define('platform', values.platform)
  if (values.brand !== undefined) define('userAgentData', { platform: values.brand })
  if (values.touch !== undefined) define('maxTouchPoints', values.touch)
}

/** Computed values jsdom cannot produce itself, for chosen elements; others stay real. */
function computed(styles: Map<Element, Record<string, string>>) {
  const real = window.getComputedStyle.bind(window)
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = real(element, pseudo)
    const values = styles.get(element)
    if (!values) return style
    return {
      backgroundColor: values['background-color'] ?? style.backgroundColor,
      getPropertyValue: (property: string) => values[property] ?? style.getPropertyValue(property),
    } as CSSStyleDeclaration
  })
}

function block(parent: Element = document.body, background?: string): HTMLElement {
  const element = parent.appendChild(document.createElement('div'))
  if (background) element.style.backgroundColor = background
  return element
}

// A page that names its paper: a walk that meets no opaque colour reads no backdrop.
beforeEach(() => {
  document.documentElement.style.backgroundColor = 'rgb(255, 255, 255)'
})

afterEach(() => {
  for (const key of stubbedNavigator.splice(0)) Reflect.deleteProperty(navigator, key)
  document.body.replaceChildren()
  document.body.removeAttribute('style')
  document.documentElement.removeAttribute('style')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveDomTextTone', () => {
  describe('model', () => {
    it('draws the exact outline over white where the platform is unknown', () => {
      expect(resolveDomTextTone(block(), undefined)).toEqual(OUTLINE)
      expect(resolveDomTextTone(block(), {})).toEqual(OUTLINE)
      expect(OUTLINE).toMatchObject({ strength: 1, backdrop: 1, table: 0, dilationPx: 0 })
    })

    it.each([
      [{ brand: 'Windows' }, WINDOWS],
      [{ platform: 'Win32' }, WINDOWS],
      // A brand the user agent blanks leaves the legacy platform to decide.
      [{ brand: '', platform: 'Win32' }, WINDOWS],
      [{ brand: 'macOS' }, MACOS],
      [{ brand: 'macOS', platform: 'MacIntel', touch: 0 }, MACOS],
      [{ platform: 'MacIntel' }, MACOS],
      [{ platform: 'MacIntel', touch: 0 }, MACOS],
      [{ platform: 'MacIntel', touch: 1 }, MACOS],
      // A user-agent override, as Playwright's desktop device applies on a Mac, renames the
      // brand only: the text is still rasterized by the system the legacy platform names.
      [{ brand: 'Windows', platform: 'MacIntel', touch: 0 }, MACOS],
      [{ brand: 'macOS', platform: 'Win32' }, WINDOWS],
      [{ brand: 'Android', platform: 'MacIntel', touch: 1 }, MACOS],
      // iPadOS calls itself a Mac and has a touch screen; a branded Mac may have one.
      [{ platform: 'MacIntel', touch: 5 }, OUTLINE],
      [{ brand: 'macOS', platform: 'MacIntel', touch: 5 }, MACOS],
      [{ platform: 'iPhone', touch: 5 }, OUTLINE],
      [{ platform: 'Linux x86_64' }, OUTLINE],
      [{ brand: 'Android', platform: 'Linux armv81', touch: 5 }, OUTLINE],
      [{ brand: 'Chrome OS', platform: 'Linux x86_64' }, OUTLINE],
      // The same override on a host that is neither: Playwright's desktop device on Linux, a
      // Mac user-agent string there, a desktop-site Windows string on Android.
      [{ brand: 'Windows', platform: 'Linux x86_64', touch: 0 }, OUTLINE],
      [{ brand: 'macOS', platform: 'Linux x86_64', touch: 0 }, OUTLINE],
      [{ brand: 'Windows', platform: 'Linux armv81', touch: 5 }, OUTLINE],
    ])('chooses the rasterizer of %j', (reported, expected) => {
      platform(reported)
      expect(resolveDomTextTone(block(), undefined)).toEqual(expected)
    })

    it('gives macOS and Windows the ink table and only macOS the dilation', () => {
      expect(MACOS).toMatchObject({ table: 1, dilationEm: 0.0058, dilationPx: 0.3, bigPx: 256 })
      expect(WINDOWS).toMatchObject({ table: 1, dilationEm: 0, dilationPx: 0, bigPx: 0 })
    })

    it.each([
      [{ '-webkit-font-smoothing': 'antialiased' }, OUTLINE],
      [{ '-webkit-font-smoothing': 'none' }, OUTLINE],
      [{ '-webkit-font-smoothing': ' Antialiased ' }, OUTLINE],
      [{ '-webkit-font-smoothing': 'auto' }, MACOS],
      [{ '-webkit-font-smoothing': 'subpixel-antialiased' }, MACOS],
      [{ '-webkit-font-smoothing': '' }, MACOS],
      [{ 'text-rendering': 'geometricPrecision' }, OUTLINE],
      [{ 'text-rendering': 'geometricprecision' }, OUTLINE],
      [{ 'text-rendering': 'optimizeLegibility' }, MACOS],
      [{ 'text-rendering': 'auto' }, MACOS],
      [{ '-moz-osx-font-smoothing': 'grayscale' }, OUTLINE],
      [{ '-moz-osx-font-smoothing': 'auto' }, MACOS],
      [{ '-webkit-font-smoothing': 'auto', 'text-rendering': 'geometricPrecision' }, OUTLINE],
    ])('reads macOS font smoothing from the computed CSS %j', (css, expected) => {
      platform({ platform: 'MacIntel', touch: 0 })
      const root = block()
      computed(new Map([[root, css]]))
      expect(resolveDomTextTone(root, undefined)).toEqual(expected)
    })

    it('reads the font smoothing of the root, which inherits it, not of an ancestor alone', () => {
      platform({ brand: 'macOS' })
      const parent = block()
      const root = block(parent)
      // jsdom inherits text-rendering as a browser does.
      parent.style.setProperty('text-rendering', 'geometricPrecision')
      expect(resolveDomTextTone(root, undefined)).toEqual(OUTLINE)
      root.style.setProperty('text-rendering', 'auto')
      expect(resolveDomTextTone(root, undefined)).toEqual(MACOS)
    })

    it('ignores the font smoothing off macOS', () => {
      platform({ brand: 'Windows' })
      const root = block()
      const styles = computed(new Map([[root, { '-webkit-font-smoothing': 'antialiased' }]]))
      expect(resolveDomTextTone(root, { backdrop: 'white' })).toEqual({ ...WINDOWS, ...DRAWN })
      expect(styles).not.toHaveBeenCalled()
    })

    it.each(['outline', 'macos', 'windows'] as const)(
      'lets an explicit %s model win without reading the page',
      (model) => {
        platform({ brand: model === 'macos' ? 'Windows' : 'macOS' })
        const styles = vi.spyOn(window, 'getComputedStyle')
        expect(resolveDomTextTone(block(), { model, backdrop: 0xffffff })).toEqual(
          resolveTextTone({ model, backdrop: 0xffffff }),
        )
        expect(styles).not.toHaveBeenCalled()
      },
    )

    it('falls back to the outline over white without a window or computed styles', () => {
      platform({ brand: 'macOS' })
      const detached = document.implementation.createHTMLDocument()
      const orphan = detached.body.appendChild(detached.createElement('div'))
      orphan.style.backgroundColor = 'rgb(0, 0, 0)'
      expect(orphan.ownerDocument.defaultView).toBeNull()
      expect(resolveDomTextTone(orphan, undefined)).toEqual(OUTLINE)

      vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
        throw new Error('not implemented')
      })
      expect(resolveDomTextTone(block(document.body, 'rgb(0, 0, 0)'), undefined)).toEqual(OUTLINE)
    })

    it('leaves the ink table off where the page behind the root cannot be read', () => {
      const unknown = { ...WINDOWS, table: 0 }
      const detached = document.implementation.createHTMLDocument()
      const orphan = detached.body.appendChild(detached.createElement('div'))
      expect(resolveDomTextTone(orphan, { model: 'windows' })).toEqual(unknown)
      // Named, the same white is known.
      expect(resolveDomTextTone(orphan, { model: 'windows', backdrop: '#fff' })).toEqual({
        ...WINDOWS,
        ...DRAWN,
      })

      const root = block(document.body, 'rgba(0, 0, 0, 0.5)')
      expect(resolveDomTextTone(root, { model: 'windows' })!.table).toBe(1)
      // A walk that breaks off has not reached what the root stands over.
      const real = window.getComputedStyle.bind(window)
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
        if (element === document.body) throw new Error('not implemented')
        return real(element)
      })
      expect(resolveDomTextTone(root, { model: 'windows' })).toEqual(unknown)
      expect(resolveDomTextTone(root, { model: 'macos' })).toEqual({ ...MACOS, table: 0 })
    })

    it('falls back to the outline when the window has no navigator', () => {
      vi.spyOn(window, 'navigator', 'get').mockReturnValue(undefined as unknown as Navigator)
      expect(resolveDomTextTone(block(), undefined)).toEqual(OUTLINE)
    })
  })

  describe('backdrop', () => {
    it('is white when nothing behind the root has a background', () => {
      const root = block(block())
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBe(1)
    })

    it('takes the nearest opaque background and reads nothing behind it', () => {
      document.documentElement.style.backgroundColor = 'rgb(255, 0, 0)'
      const panel = block(document.body, 'rgb(0, 0, 0)')
      const root = block(block(panel))
      const styles = vi.spyOn(window, 'getComputedStyle')
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBe(0)
      // The root, its transparent parent and the opaque panel: not the body or the page.
      expect(styles.mock.calls.map(([element]) => element)).toEqual([
        root,
        root.parentElement,
        panel,
      ])

      expect(resolveDomTextTone(block(root, 'rgb(255, 255, 255)'), undefined)!.backdrop).toBe(1)
    })

    it("uses the root's own opaque background", () => {
      const root = block(block(document.body, 'rgb(255, 255, 255)'), 'rgb(0, 0, 0)')
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBe(0)
    })

    it('reads the page background from the body or the root element', () => {
      document.body.style.backgroundColor = 'rgb(17, 17, 17)'
      expect(resolveDomTextTone(block(), undefined)!.backdrop).toBeCloseTo(17 / 255, 6)
      document.body.removeAttribute('style')
      document.documentElement.style.backgroundColor = 'rgb(0, 0, 0)'
      expect(resolveDomTextTone(block(), undefined)!.backdrop).toBe(0)
    })

    it('composites a translucent stack on encoded values, over a white page', () => {
      // Half black over white is encoded mid grey; blended in linear light it would be 0.735.
      const veil = block(document.body, 'rgba(0, 0, 0, 0.5)')
      expect(resolveDomTextTone(veil, undefined)!.backdrop).toBeCloseTo(0.5, 6)

      // Two veils over an opaque panel, and a page colour that must not show through.
      document.body.style.backgroundColor = 'rgb(0, 255, 0)'
      const panel = block(document.body, 'rgb(0, 0, 255)')
      const root = block(block(panel, 'rgba(255, 255, 255, 0.5)'), 'rgba(255, 0, 0, 0.5)')
      const expected = new Color().setRGB(0.75, 0.25, 0.5, SRGBColorSpace)
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBeCloseTo(toneLightness(expected), 6)
    })

    it('skips fully transparent layers and ignores background images', () => {
      const panel = block(document.body, 'rgb(0, 0, 0)')
      const root = block(block(panel, 'rgba(255, 255, 255, 0)'))
      root.style.backgroundImage = 'linear-gradient(white, white)'
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBe(0)
    })

    it('parses the space-separated syntax, percentages and the transparent keyword', () => {
      const [root, parent, panel] = [block(), block(), block()]
      parent.append(root)
      panel.append(parent)
      computed(
        new Map([
          [root, { 'background-color': 'transparent' }],
          [parent, { 'background-color': 'rgb(0 0 0 / 50%)' }],
          [panel, { 'background-color': 'rgb(100% 100% 100%)' }],
        ]),
      )
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBeCloseTo(0.5, 6)
    })

    it.each([
      ['#000', 0],
      [0xffffff, 1],
      [new Color(0x000000), 0],
    ] as const)(
      'lets the explicit colour %s win without reading backgrounds',
      (backdrop, value) => {
        document.body.style.backgroundColor = 'rgb(128, 128, 128)'
        const styles = vi.spyOn(window, 'getComputedStyle')
        const tone = resolveDomTextTone(block(), { backdrop, model: 'outline', strength: 0.25 })
        expect(tone).toEqual({ ...OUTLINE, ...DRAWN, backdrop: value, strength: 0.25 })
        expect(styles).not.toHaveBeenCalled()
      },
    )

    it('keeps the automatic backdrop beside an explicit model, and the reverse', () => {
      platform({ brand: 'macOS' })
      document.body.style.backgroundColor = 'rgb(0, 0, 0)'
      expect(resolveDomTextTone(block(), { model: 'windows', backdrop: 'auto' })).toEqual({
        ...WINDOWS,
        backdrop: 0,
      })
      expect(resolveDomTextTone(block(), { model: 'auto', backdrop: 'white' })).toEqual({
        ...MACOS,
        ...DRAWN,
      })
    })

    it('crosses shadow roots and follows slots', () => {
      const host = block(document.body, 'rgb(0, 0, 0)')
      const shadow = host.attachShadow({ mode: 'open' })
      const inside = shadow.appendChild(document.createElement('p'))
      expect(resolveDomTextTone(inside, undefined)!.backdrop).toBe(0)

      // A slotted element is drawn inside the slot's ancestors, not inside its light parent.
      const frame = shadow.appendChild(document.createElement('div'))
      frame.style.backgroundColor = 'rgb(255, 255, 255)'
      frame.append(document.createElement('slot'))
      const slotted = host.appendChild(document.createElement('span'))
      expect(resolveDomTextTone(slotted, undefined)!.backdrop).toBe(1)
    })

    it('holds the ink table back where the walk met no opaque colour', () => {
      // A page that names no paper: white is the canvas default, and only a guess.
      document.documentElement.removeAttribute('style')
      const root = block(block())
      expect(resolveDomTextTone(root, { model: 'windows' })).toEqual({ ...WINDOWS, table: 0 })
      expect(resolveDomTextTone(root, { model: 'macos' })).toEqual({ ...MACOS, table: 0 })
      // A veil alone is a guess as well; the exact outline, which has no table, still uses it.
      const veil = block(document.body, 'rgba(0, 0, 0, 0.5)')
      expect(resolveDomTextTone(veil, { model: 'windows' })).toEqual({ ...WINDOWS, table: 0 })
      expect(resolveDomTextTone(veil, { model: 'outline' })!.backdrop).toBeCloseTo(0.5, 6)
      platform({ platform: 'Linux x86_64' })
      expect(resolveDomTextTone(veil, undefined)!.backdrop).toBeCloseTo(0.5, 6)
      // A page that names its paper is known, under the veil too.
      document.documentElement.style.backgroundColor = 'rgb(255, 255, 255)'
      expect(resolveDomTextTone(root, { model: 'windows' })).toEqual(WINDOWS)
      expect(resolveDomTextTone(veil, { model: 'windows' })!.table).toBe(1)
      expect(resolveDomTextTone(veil, { model: 'windows' })!.backdrop).toBeCloseTo(0.5, 6)
    })

    it('takes a background image in front of the opaque colour as a guess', () => {
      const hero = block()
      const root = block(hero)
      computed(new Map([[hero, { 'background-image': 'url("hero.jpg")' }]]))
      expect(resolveDomTextTone(root, { model: 'windows' })).toEqual({ ...WINDOWS, table: 0 })
      expect(resolveDomTextTone(root, { model: 'macos' })).toEqual({ ...MACOS, table: 0 })
      expect(resolveDomTextTone(root, { model: 'outline' })).toEqual(OUTLINE)
      // An image on the root itself is in front of the page too, whoever draws its colour.
      const capture = { glyphs: [], rects: [], rootRect: true }
      expect(resolveDomTextTone(hero, { model: 'windows' }, capture)!.table).toBe(0)
      // An opaque colour in front of the image hides it.
      const card = block(root, 'rgb(0, 0, 0)')
      expect(resolveDomTextTone(card, { model: 'windows' })).toEqual({ ...WINDOWS, backdrop: 0 })
    })

    it('leaves out an ancestor without a box, a hidden one and one clipped to its text', () => {
      const contents = block(document.body, 'rgb(0, 0, 0)')
      contents.style.display = 'contents'
      expect(resolveDomTextTone(block(contents), undefined)!.backdrop).toBe(1)

      const hidden = block(document.body, 'rgb(0, 0, 0)')
      hidden.style.visibility = 'hidden'
      const shown = block(hidden)
      shown.style.visibility = 'visible'
      expect(resolveDomTextTone(shown, undefined)!.backdrop).toBe(1)

      const clipped = block(document.body, 'rgb(0, 0, 0)')
      const inside = block(clipped)
      const styles = computed(new Map([[clipped, { 'background-clip': 'text' }]]))
      expect(resolveDomTextTone(inside, undefined)!.backdrop).toBe(1)
      styles.mockRestore()
      computed(new Map([[clipped, { '-webkit-background-clip': 'text' }]]))
      expect(resolveDomTextTone(inside, undefined)!.backdrop).toBe(1)
    })

    it('still reads the page canvas from a hidden body', () => {
      document.body.style.backgroundColor = 'rgb(0, 0, 0)'
      document.body.style.visibility = 'hidden'
      expect(resolveDomTextTone(block(), undefined)!.backdrop).toBe(0)
      document.body.removeAttribute('style')
      document.documentElement.style.backgroundColor = 'rgb(0, 0, 0)'
      document.documentElement.style.visibility = 'hidden'
      expect(resolveDomTextTone(block(), undefined)!.backdrop).toBe(0)
    })

    it('resolves `false` to no tone and reads nothing', () => {
      const styles = vi.spyOn(window, 'getComputedStyle')
      expect(resolveDomTextTone(block(), false)).toBeNull()
      expect(styles).not.toHaveBeenCalled()
    })
  })

  describe('backdrop of a capture', () => {
    const glyphAt = (x: number, y: number, fontSize = 16, z = 1): GlyphLayout => ({
      glyphKey: 'face\u0000A',
      fontSize,
      originX: x - fontSize / 4,
      lineBottom: y - fontSize / 2,
      advance: fontSize / 2,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 240, 120],
      color: [0, 0, 0, 1],
      sequence: 0,
      z,
    })
    const box = (rect: RectLayout['rect'], color: RectLayout['color'], z = 0): RectLayout => ({
      rect,
      color,
      radius: 0,
      z,
      receiveShadow: false,
    })
    const LEFT = [0, 0, 120, 120] as const
    const RIGHT = [120, 0, 240, 120] as const
    const backdrop = (
      root: Element,
      glyphs: readonly GlyphLayout[],
      rects: readonly RectLayout[],
      rootRect = true,
    ): number => resolveDomTextTone(root, undefined, { glyphs, rects, rootRect })!.backdrop

    it('reads the paper a capture draws behind its text, not the page behind the root', () => {
      document.body.style.backgroundColor = 'rgb(0, 0, 0)'
      const root = block()
      // The paper is a rectangle inside the root, beside the text: no ancestor of anything.
      expect(backdrop(root, [glyphAt(20, 60)], [sheet([1, 1, 1, 1])])).toBe(1)
      expect(resolveDomTextTone(root, undefined)!.backdrop).toBe(0)
    })

    it('leaves text outside every rectangle on the page', () => {
      document.body.style.backgroundColor = 'rgb(0, 0, 0)'
      const rects = [box(RIGHT, [1, 1, 1, 1])]
      expect(backdrop(block(), [glyphAt(20, 60)], rects)).toBe(0)
      expect(backdrop(block(), [glyphAt(180, 60)], rects)).toBe(1)
      expect(backdrop(block(), [glyphAt(180, 130)], rects)).toBe(0)
    })

    it('ignores a rectangle in front of the text', () => {
      const rects = [sheet([0, 0, 0, 1], 2)]
      expect(backdrop(block(), [glyphAt(20, 60, 16, 1)], rects)).toBe(1)
      expect(backdrop(block(), [glyphAt(20, 60, 16, 2)], rects)).toBe(0)
    })

    it('composites the rectangles on encoded values, back to front', () => {
      const purple = toneLightness(new Color().setRGB(0.5, 0, 0.5, SRGBColorSpace))
      const veil = sheet([1, 0, 0, 0.5], 0)
      const blue = sheet([0, 0, 1, 1], -1)
      // Depth decides, whatever the order of capture.
      expect(backdrop(block(), [glyphAt(20, 60)], [veil, blue])).toBeCloseTo(purple, 9)
      expect(backdrop(block(), [glyphAt(20, 60)], [blue, veil])).toBeCloseTo(purple, 9)
      // At one depth the later rectangle paints over the earlier one.
      const [black, white] = [sheet([0, 0, 0, 1]), sheet([1, 1, 1, 1])]
      expect(backdrop(block(), [glyphAt(20, 60)], [black, white])).toBe(1)
      expect(backdrop(block(), [glyphAt(20, 60)], [white, black])).toBe(0)
      // A veil over the page: half black over white is encoded mid grey.
      expect(backdrop(block(), [glyphAt(20, 60)], [sheet([0, 0, 0, 0.5])])).toBeCloseTo(0.5, 9)
    })

    it("counts the root's own background once", () => {
      const root = block(document.body, 'rgba(0, 0, 0, 0.5)')
      // Captured as a rectangle, it is not read from the page again: 0.5, not 0.25.
      expect(backdrop(root, [glyphAt(20, 60)], [sheet([0, 0, 0, 0.5])])).toBeCloseTo(0.5, 9)
      // Left out of the capture, the page still has it behind the text.
      expect(backdrop(root, [glyphAt(20, 60)], [], false)).toBeCloseTo(0.5, 9)
      expect(backdrop(root, [glyphAt(20, 60)], [], true)).toBe(1)
    })

    it('lets the longer run of glyph edges decide between two backgrounds', () => {
      const rects = [box(LEFT, [0, 0, 0, 1]), box(RIGHT, [1, 1, 1, 1])]
      const small = (count: number): GlyphLayout[] =>
        Array.from({ length: count }, (_, index) => glyphAt(10 + index * 5, 60, 16))
      const heading = glyphAt(180, 60, 64)
      // A glyph weighs its size: three 16 px glyphs are less than one of 64 px, five are more.
      // By count the three would already win, by ink area not even the five.
      expect(backdrop(block(), [...small(3), heading], rects)).toBe(1)
      expect(backdrop(block(), [heading, ...small(5)], rects)).toBe(0)
    })

    it('takes the middle lightness when three backgrounds share the text', () => {
      const rects = [
        box([0, 0, 80, 120], [0, 0, 0, 1]),
        box([80, 0, 160, 120], [0.5, 0.5, 0.5, 1]),
        box([160, 0, 240, 120], [1, 1, 1, 1]),
      ]
      const glyphs = [glyphAt(40, 60), glyphAt(40, 80), glyphAt(120, 60), glyphAt(200, 60)]
      expect(backdrop(block(), [...glyphs, glyphAt(200, 80)], rects)).toBeCloseTo(0.5, 9)
    })

    it('skips SVG shapes and reads the page for a capture without text', () => {
      document.body.style.backgroundColor = 'rgb(0, 0, 0)'
      const rects = [sheet([1, 1, 1, 1])]
      expect(backdrop(block(), [{ ...glyphAt(20, 60), shapeGroup: 0 }], rects)).toBe(0)
      expect(backdrop(block(), [], rects)).toBe(0)
    })

    it('decides a long capture from a spread sample', () => {
      const rects = [box(LEFT, [0, 0, 0, 1]), box(RIGHT, [1, 1, 1, 1])]
      // Glyphs on the dark and on the light half, interleaved through the capture.
      const interleaved = (dark: number): GlyphLayout[] =>
        Array.from({ length: 5000 }, (_, index) => glyphAt(index % 10 < dark ? 60 : 180, 60))
      expect(backdrop(block(), interleaved(7), rects)).toBe(0)
      expect(backdrop(block(), interleaved(3), rects)).toBe(1)
      // Any regular stride of whole glyphs would read the first of every ten alone.
      expect(backdrop(block(), interleaved(1), rects)).toBe(1)
    })

    it('takes the middle lightness whatever the order the backgrounds are met in', () => {
      const rects = [
        box([0, 0, 80, 120], [1, 1, 1, 1]),
        box([80, 0, 160, 120], [0, 0, 0, 1]),
        box([160, 0, 240, 120], [0.5, 0.5, 0.5, 1]),
      ]
      // Met as white (40 %), black (20 %), grey (40 %): only a sorted walk stops at the grey.
      const glyphs = [
        glyphAt(40, 60),
        glyphAt(40, 80),
        glyphAt(120, 60),
        glyphAt(200, 60),
        glyphAt(200, 80),
      ]
      expect(backdrop(block(), glyphs, rects)).toBeCloseTo(0.5, 9)
    })

    it("samples a glyph at the centre of its box, not at its origin or its line's bottom", () => {
      const rects = [box([100, 50, 240, 120], [0, 0, 0, 1])]
      // A 32 px glyph centred four pixels inside the corner: its origin (96) and its line
      // bottom (38) both lie outside the rectangle.
      const glyph = glyphAt(104, 54, 32)
      expect([glyph.originX, glyph.lineBottom]).toEqual([96, 38])
      expect(backdrop(block(), [glyph], rects)).toBe(0)
      expect(backdrop(block(), [glyphAt(96, 54, 32)], rects)).toBe(1)
      expect(backdrop(block(), [glyphAt(104, 46, 32)], rects)).toBe(1)
    })

    it('reads at most 512 glyphs of a capture', () => {
      let visited = 0
      const glyphs = new Proxy(
        Array.from({ length: 5000 }, (_, index) => glyphAt(20 + (index % 10), 60)),
        {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) visited++
            return Reflect.get(target, key, receiver) as unknown
          },
        },
      )
      expect(backdrop(block(), glyphs, [])).toBe(1)
      expect(visited).toBe(512)
    })

    it('knows the backdrop only under an opaque rectangle while the page is a guess', () => {
      document.documentElement.removeAttribute('style')
      const light = { ...glyphAt(20, 60), color: [1, 1, 1, 1] } as const
      const capture = (rects: readonly RectLayout[]) =>
        resolveDomTextTone(
          block(),
          { model: 'windows' },
          { glyphs: [light], rects, rootRect: true },
        )!
      expect(capture([])).toEqual({ ...WINDOWS, table: 0 })
      expect(capture([sheet([0, 0, 0, 0.5])])).toEqual({ ...WINDOWS, table: 0 })
      expect(capture([sheet([0, 0, 0, 1])])).toEqual({ ...WINDOWS, ...DRAWN, backdrop: 0 })
    })

    it('tells whether the capture itself draws what the deciding glyphs stand over', () => {
      const framed = (glyphs: readonly GlyphLayout[], rects: readonly RectLayout[]) =>
        resolveDomTextTone(block(), undefined, { glyphs, rects, rootRect: true })!.framed
      // The page behind the root is known here, yet the frame may not hold it.
      expect(framed([glyphAt(20, 60)], [])).toBe(false)
      expect(framed([], [sheet([0, 0, 0, 1])])).toBe(false)
      expect(framed([glyphAt(20, 60)], [sheet([0, 0, 0, 0.5])])).toBe(false)
      expect(framed([glyphAt(20, 60)], [sheet([0, 0, 0, 1], 2)])).toBe(false)
      expect(framed([glyphAt(20, 60)], [sheet([0, 0, 0, 1])])).toBe(true)
      expect(framed([glyphAt(20, 60)], [sheet([1, 1, 1, 1], -2), sheet([0, 0, 0, 0.5])])).toBe(true)
      // The stack that decides the backdrop decides this too.
      const rects = [box(LEFT, [0, 0, 0, 1])]
      const onPaper = [glyphAt(20, 60), glyphAt(40, 60), glyphAt(60, 60)]
      expect(framed([...onPaper, glyphAt(180, 60)], rects)).toBe(true)
      expect(framed([...onPaper, glyphAt(180, 60, 64)], rects)).toBe(false)
    })

    describe('with light ink on another backdrop than the one chosen', () => {
      const inkAt = (x: number, fontSize: number, color: GlyphLayout['color']): GlyphLayout => ({
        ...glyphAt(x, 60, fontSize),
        color,
      })
      // A light card with a dark button on its left.
      const rects = [box([0, 0, 240, 120], [1, 1, 1, 1]), box(LEFT, [0, 0, 0, 1])]
      const label = [20, 50, 80].map((x) => inkAt(x, 24, [1, 1, 1, 1]))
      const body = (color: GlyphLayout['color']): GlyphLayout[] =>
        Array.from({ length: 20 }, (_, index) => inkAt(130 + index * 5, 16, color))
      const tone = (glyphs: readonly GlyphLayout[]) =>
        resolveDomTextTone(block(), { model: 'windows' }, { glyphs, rects, rootRect: true })!
      const CARD = { ...WINDOWS, ...DRAWN }

      it('holds the table back when the ink it would lift stands elsewhere', () => {
        // Dark body text on the card decides the backdrop and has no table weight of its own.
        expect(tone([...body([0, 0, 0, 1]), ...label])).toEqual({ ...CARD, table: 0 })
      })

      it('keeps the table while most of the ink it lifts stands on the chosen backdrop', () => {
        expect(tone([...body([0.6, 0.6, 0.6, 1]), ...label])).toEqual(CARD)
        expect(tone(body([0, 0, 0, 1]))).toEqual(CARD)
        // The label alone: the button is the backdrop.
        expect(tone(label)).toEqual({ ...CARD, backdrop: 0 })
        // A backdrop within a quarter of the chosen one counts as the same.
        const near = [box([0, 0, 240, 120], [1, 1, 1, 1]), box(LEFT, [0.8, 0.8, 0.8, 1])]
        const glyphs = [...body([0, 0, 0, 1]), ...label]
        expect(
          resolveDomTextTone(
            block(),
            { model: 'windows' },
            { glyphs, rects: near, rootRect: true },
          ),
        ).toEqual(CARD)
      })
    })

    describe('of a root that is not drawn over its page', () => {
      const hidden = (
        glyphs: readonly GlyphLayout[],
        rects: readonly RectLayout[],
        option: Parameters<typeof resolveDomTextTone>[1] = { model: 'windows' },
      ) => resolveDomTextTone(block(), option, { glyphs, rects, rootRect: true, page: false })!
      const UNKNOWN = { ...WINDOWS, table: 0 }

      it('reads no page, and knows no backdrop without a rectangle behind the text', () => {
        document.body.style.backgroundColor = 'rgb(0, 0, 0)'
        const styles = vi.spyOn(window, 'getComputedStyle')
        expect(hidden([glyphAt(20, 60)], [])).toEqual(UNKNOWN)
        expect(hidden([], [])).toEqual(UNKNOWN)
        expect(hidden([], [sheet([0, 0, 0, 1])])).toEqual(UNKNOWN)
        expect(styles).not.toHaveBeenCalled()
        // The model still comes from the platform and the root's computed CSS.
        platform({ brand: 'macOS' })
        expect(hidden([glyphAt(20, 60)], [], {})).toEqual({ ...MACOS, table: 0 })
        expect(styles).toHaveBeenCalled()
      })

      it('knows the backdrop of text over an opaque rectangle of the capture', () => {
        expect(hidden([glyphAt(20, 60)], [sheet([0, 0, 0, 1])])).toEqual({
          ...WINDOWS,
          ...DRAWN,
          backdrop: 0,
        })
        // A veil over an opaque rectangle is as known as the rectangle.
        const veiled = hidden([glyphAt(20, 60)], [sheet([1, 1, 1, 1], -2), sheet([0, 0, 0, 0.5])])
        expect(veiled.table).toBe(1)
        expect(veiled.framed).toBe(true)
        expect(veiled.backdrop).toBeCloseTo(0.5, 9)
        // A veil alone lets the scene through, as does a rectangle beside the text.
        expect(hidden([glyphAt(20, 60)], [sheet([0, 0, 0, 0.5])])).toEqual(UNKNOWN)
        expect(hidden([glyphAt(20, 60)], [box(RIGHT, [0, 0, 0, 1])])).toEqual(UNKNOWN)
        expect(hidden([glyphAt(20, 60)], [sheet([0, 0, 0, 1], 2)])).toEqual(UNKNOWN)
      })

      it('lets the longer run of glyph edges decide between known and unknown', () => {
        const rects = [box(LEFT, [0, 0, 0, 1])]
        const dark = [glyphAt(20, 60), glyphAt(40, 60), glyphAt(60, 60)]
        expect(hidden([...dark, glyphAt(180, 60)], rects).backdrop).toBe(0)
        expect(hidden([...dark, glyphAt(180, 60, 64)], rects)).toEqual(UNKNOWN)
      })

      it('ranks text over an unknown backdrop as the white it is toned against', () => {
        const rects = [
          box([0, 0, 80, 120], [0, 0, 0, 1]),
          box([80, 0, 160, 120], [0.5, 0.5, 0.5, 1]),
        ]
        // Black 40 %, grey 20 %, unknown 40 %: the grey is the median only with unknown as white.
        const glyphs = [
          glyphAt(200, 60),
          glyphAt(200, 80),
          glyphAt(40, 60),
          glyphAt(40, 80),
          glyphAt(120, 60),
        ]
        const tone = hidden(glyphs, rects)
        expect(tone.backdrop).toBeCloseTo(0.5, 9)
        expect(tone.table).toBe(1)
      })

      it('takes an explicit backdrop as known', () => {
        expect(hidden([glyphAt(20, 60)], [], { model: 'windows', backdrop: '#fff' })).toEqual({
          ...WINDOWS,
          ...DRAWN,
        })
      })
    })

    it('lets an explicit backdrop win over the capture', () => {
      const capture = { glyphs: [glyphAt(20, 60)], rects: [sheet([0, 0, 0, 1])], rootRect: true }
      expect(resolveDomTextTone(block(), { backdrop: '#fff' }, capture)!.backdrop).toBe(1)
      expect(resolveDomTextTone(block(), false, capture)).toBeNull()
    })
  })

  describe('colours only a canvas can read', () => {
    let copies = 0

    /**
     * A private copy of the module, since it creates its probe canvas once per page. The
     * query makes it a module of its own and leaves every other module instance shared.
     */
    async function fresh(pixels: Record<string, readonly number[]> | null) {
      const fills: string[] = []
      let style = ''
      const context = {
        set fillStyle(value: string) {
          // A canvas keeps its previous fill when it cannot parse the new one.
          if (pixels && value in pixels) style = value
          fills.push(value)
        },
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        getImageData: () => ({ data: pixels![style]! }),
      }
      const getContext = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(pixels ? (context as unknown as CanvasRenderingContext2D) : null)
      const specifier = `../src/dom/tone.js?probe=${++copies}`
      const module = (await import(/* @vite-ignore */ specifier)) as typeof DomToneModule
      expect(module.resolveDomTextTone).not.toBe(resolveDomTextTone)
      return { resolve: module.resolveDomTextTone, getContext, fills }
    }

    it('reads another colour syntax through one canvas pixel, once per string', async () => {
      const { resolve, getContext, fills } = await fresh({
        '#0000': [0, 0, 0, 0],
        'oklch(0.2 0 0)': [0, 0, 0, 255],
        'color(srgb 1 1 1 / 0.5)': [255, 255, 255, 128],
      })
      const [root, parent] = [block(), block()]
      parent.append(root)
      computed(
        new Map([
          [root, { 'background-color': 'color(srgb 1 1 1 / 0.5)' }],
          [parent, { 'background-color': 'oklch(0.2 0 0)' }],
        ]),
      )
      expect(resolve(root, undefined)!.backdrop).toBeCloseTo(128 / 255, 6)
      expect(resolve(root, undefined)!.backdrop).toBeCloseTo(128 / 255, 6)
      expect(getContext).toHaveBeenCalledOnce()
      expect(fills).toEqual(['#0000', 'color(srgb 1 1 1 / 0.5)', '#0000', 'oklch(0.2 0 0)'])
    })

    it('treats a colour the canvas rejects as no background', async () => {
      const { resolve } = await fresh({ '#0000': [0, 0, 0, 0] })
      const root = block(document.body, 'rgb(0, 0, 0)')
      computed(new Map([[root, { 'background-color': 'paint(checkerboard)' }]]))
      expect(resolve(root, undefined)!.backdrop).toBe(1)
    })

    it('skips such a layer where there is no canvas, and asks for one only once', async () => {
      const { resolve, getContext } = await fresh(null)
      const [root, parent] = [block(), block(document.body, 'rgb(0, 0, 0)')]
      parent.append(root)
      const styles = new Map([[root, { 'background-color': 'oklch(1 0 0)' }]])
      computed(styles)
      expect(resolve(root, undefined)!.backdrop).toBe(0)
      styles.set(root, { 'background-color': 'oklch(0.9 0 0)' })
      expect(resolve(root, undefined)!.backdrop).toBe(0)
      expect(getContext).toHaveBeenCalledOnce()
    })

    it('survives a canvas that throws', async () => {
      const { resolve, getContext } = await fresh(null)
      getContext.mockImplementation(() => {
        throw new Error('canvas blocked')
      })
      const root = block()
      computed(new Map([[root, { 'background-color': 'oklch(0 0 0)' }]]))
      expect(resolve(root, undefined)).toEqual(OUTLINE)
    })
  })
})

const renderer = {} as WebGPURenderer

function snapshot(width = 240): DomLayoutSnapshot {
  return {
    width,
    height: 120,
    glyphs: [],
    rects: [],
    blocks: [],
    requests: [],
    atlasSignature: 'face\u0000A',
    lineCount: 2,
  }
}

function raster(): RasterAtlas {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 4
  return { canvas, width: 4, height: 4, bakeSize: 32, pxRange: 4, glyphs: new Map() }
}

type TestAtlas = Omit<SdfAtlas, 'dispose' | 'glyphs'> & {
  glyphs: Map<string, GlyphSlot>
  dispose: ReturnType<typeof vi.fn<() => void>>
}

function atlas(): TestAtlas {
  return {
    texture: new Texture(),
    width: 4,
    height: 4,
    pxRange: 4,
    bakeSize: 32,
    glyphs: new Map(),
    mode: 'cpu',
    dispose: vi.fn<() => void>(),
  }
}

function textSnapshot(characters: string): DomLayoutSnapshot {
  const font = {
    key: 'face',
    canvasFont: '32px sans-serif',
    family: 'sans-serif',
    weight: '400',
    style: 'normal',
    stretch: 'normal',
    variant: 'normal',
    kerning: 'auto',
    featureSettings: 'normal',
    variationSettings: 'normal',
    opticalSizing: 'auto',
    size: 32,
  }
  const requests = [...new Set(characters)].sort().map((character) => ({
    key: `face\u0000${character}`,
    character,
    font,
  }))
  return {
    ...snapshot(),
    atlasSignature: requests.map((request) => request.key).join('\u0001'),
    requests,
    glyphs: Array.from(characters, (character, index) => ({
      glyphKey: `face\u0000${character}`,
      fontSize: 32,
      originX: index * 16,
      lineBottom: 20,
      advance: 16,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 240, 120],
      color: [1, 1, 1, 1],
      sequence: index,
      z: 1,
    })),
  }
}

/** A rectangle over the whole capture, as the root's own background is captured. */
function sheet(color: RectLayout['color'], z = -1): RectLayout {
  return { rect: [0, 0, 240, 120], color, radius: 0, z, receiveShadow: false }
}

/** A capture whose glyphs stand over `rects`; it requests nothing, so any atlas covers it. */
function inked(rects: readonly RectLayout[], characters = 'Hi'): DomLayoutSnapshot {
  return { ...snapshot(), glyphs: textSnapshot(characters).glyphs, rects }
}

function meshNamed(group: DomSdf, name: string): Mesh<InstancedBufferGeometry, GlyphTextMaterial> {
  const found = (group.children[0] as Group).children.find((child) => child.name === name)
  if (!(found instanceof Mesh)) throw new Error(`Expected the ${name} mesh`)
  return found as Mesh<InstancedBufferGeometry, GlyphTextMaterial>
}

const textMaterial = (group: DomSdf): GlyphTextMaterial =>
  meshNamed(group, 'ultra-text text').material

// P'(b) and P''(b) / 2 of the conversion's polynomial, at a white and at a black backdrop.
const CURVE_WHITE = [2.292783133, 1.598089144]
const CURVE_BLACK = [0.012522878, 0.682171111]

describe('the tone option of DomSdf and Text', () => {
  beforeEach(() => {
    domMocks.snapshot.mockReset().mockReturnValue(snapshot())
    domMocks.rasterize.mockReset().mockResolvedValue(raster())
    domMocks.buildAtlas.mockReset().mockImplementation(() => Promise.resolve(atlas()))
    domMocks.buildWindfoil.mockReset()
    domMocks.sdfMaterials.length = 0
  })

  it('gives the SDF material the size its atlas was really baked at', async () => {
    // The macOS model derives the em on screen from it; an adaptive bake may have lowered
    // the size below the one the caller asked for.
    const domSdf = await DomSdf.create(renderer, block(), {
      observe: false,
      bakeSize: 96,
      adaptiveBakeSize: true,
    })
    expect(atlas().bakeSize).toBe(32)
    expect(domMocks.sdfMaterials.map((options) => options.bakeSize)).toEqual([32])
    domSdf.dispose()
  })

  it('hands the shape rows of its atlas to the SDF material, from the typed field alone', async () => {
    // Atlases as a cache restores them: the public fields on a texture that carries no tag.
    domMocks.buildAtlas.mockImplementation(() => Promise.resolve({ ...atlas(), shapeTop: 2 }))
    const built = await DomSdf.create(renderer, block(), { observe: false })
    const shared = await DomSdf.create(renderer, block(), {
      observe: false,
      sharedAtlas: { ...atlas(), shapeTop: 3 },
    })
    domMocks.buildAtlas.mockImplementation(() => Promise.resolve(atlas()))
    const plain = await DomSdf.create(renderer, block(), { observe: false })

    expect(domMocks.sdfMaterials.map((options) => options.shapeTop)).toEqual([2, 3, undefined])
    for (const options of domMocks.sdfMaterials) expect(options.atlas.userData).toEqual({})
    const flagged = (domSdf: DomSdf): boolean => {
      let found = false
      textMaterial(domSdf).colorNode!.traverse((node) => {
        if ('name' in node && node.name === 'vUltraShapeGlyph') found = true
      })
      return found
    }
    expect([built, shared, plain].map(flagged)).toEqual([true, true, false])
    for (const domSdf of [built, shared, plain]) domSdf.dispose()
  })

  it('builds the SDF material from the tone the page resolves', async () => {
    platform({ brand: 'Windows' })
    document.body.style.backgroundColor = 'rgb(0, 0, 0)'
    const source = block()
    const domSdf = await DomSdf.create(renderer, source, { observe: false })

    const material = textMaterial(domSdf)
    expect(material).toBeInstanceOf(SdfTextMaterial)
    expect(material.tone!.resolved).toEqual({ ...WINDOWS, backdrop: 0 })
    expect(material.tone!.ink.value.toArray()).toEqual([0, 1, 1 / 3])
    // The caller's option stays as given: unset here, and never the resolved values.
    expect('tone' in domSdf.options).toBe(false)
    domSdf.dispose()
  })

  it('keeps the option as frozen caller input and resolves its automatic half', async () => {
    document.body.style.backgroundColor = 'rgb(0, 0, 0)'
    const tone = { strength: 0.5, model: 'windows' } as const
    const domSdf = await DomSdf.create(renderer, block(), { observe: false, tone })

    expect(domSdf.options.tone).toEqual(tone)
    expect(domSdf.options.tone).not.toBe(tone)
    expect(Object.isFrozen(domSdf.options.tone)).toBe(true)
    expect(textMaterial(domSdf).tone!.resolved).toEqual({ ...WINDOWS, strength: 0.5, backdrop: 0 })
    domSdf.dispose()
  })

  it('builds no conversion with `tone: false`, and reads nothing for it', async () => {
    const styles = vi.spyOn(window, 'getComputedStyle')
    const domSdf = await DomSdf.create(renderer, block(), { observe: false, tone: false })
    expect(textMaterial(domSdf).tone).toBeNull()
    await domSdf.rebuild()
    expect(textMaterial(domSdf).tone).toBeNull()
    expect(styles).not.toHaveBeenCalled()
    domSdf.dispose()
  })

  it('hands the resolved tone to the Windfoil backend', async () => {
    platform({ platform: 'MacIntel', touch: 0 })
    const createMaterial = vi.fn<WindfoilBackend['createMaterial']>(
      ({ maxSequence, motion, tone }) =>
        new SdfTextMaterial({
          atlas: new Texture(),
          atlasWidth: 1,
          atlasHeight: 1,
          pxRange: 1,
          maxSequence,
          motion,
          ...(tone === undefined ? {} : { tone }),
        }),
    )
    const setGlyphEm = vi.fn<WindfoilBackend['setGlyphEm']>()
    domMocks.buildWindfoil.mockResolvedValue({
      kind: 'windfoil',
      layered: false,
      companion: null,
      effects: null,
      color: null,
      sizeSwitch: null,
      motionOrdinals: () => new Float32Array(),
      covers: () => true,
      primaryCovers: () => true,
      analyticCovers: () => true,
      contentFits: () => true,
      glyphs: new Map(),
      storageBytes: 0,
      preprocessStats: {
        uniqueGlyphs: 0,
        paintLayers: 0,
        monotonePieces: 0,
        bandCount: 0,
        bandedPieces: 0,
        duplication: 1,
      },
      createGeometry: () => ({ geometry: new InstancedBufferGeometry(), maxSequence: 0 }),
      updateGeometry: () => 0,
      setGlyphEm,
      createMaterial,
      dispose: vi.fn<() => void>(),
    })
    const panel = block(document.body, 'rgb(0, 0, 0)')
    const domSdf = await DomSdf.create(renderer, block(panel), {
      observe: false,
      textBackend: 'windfoil',
      windfoil: { outlineProvider: () => null },
    })

    expect(createMaterial).toHaveBeenCalledOnce()
    expect(createMaterial.mock.calls[0]![0].tone).toEqual({ ...MACOS, backdrop: 0 })
    expect(textMaterial(domSdf).tone!.dilates).toBe(true)
    // A model that dilates reads each glyph's font size: the backend is told before it
    // builds the geometry.
    expect(setGlyphEm.mock.calls).toEqual([[true]])

    // The same capture on a white background: the material follows through its uniforms.
    panel.style.backgroundColor = 'rgb(255, 255, 255)'
    await domSdf.rebuild()
    expect(createMaterial).toHaveBeenCalledOnce()
    expect(textMaterial(domSdf).tone!.resolved).toEqual(MACOS)

    // A changed capture drawn as the exact outline: no font size in the new geometry.
    panel.style.setProperty('text-rendering', 'geometricPrecision')
    domMocks.snapshot.mockReturnValue(textSnapshot('B'))
    await domSdf.rebuild()
    expect(setGlyphEm.mock.lastCall).toEqual([false])
    expect(createMaterial).toHaveBeenCalledTimes(2)
    domSdf.dispose()
  })

  describe('with the real Windfoil runtime and its SDF companion', () => {
    const square = {
      unitsPerEm: 32,
      ascent: 32,
      descent: 0,
      bbox: [0, 0, 16, 32] as const,
      quadratics: [
        0, 0, 8, 0, 16, 0, 16, 0, 16, 16, 16, 32, 16, 32, 8, 32, 0, 32, 0, 32, 0, 16, 0, 0,
      ],
    }
    // A has an outline; Q has none and is drawn by the SDF companion.
    const windfoil = {
      outlineProvider: (request: GlyphRequest) => (request.character === 'Q' ? null : square),
      fallback: 'sdf-glyphs',
    } as const
    const webgpuRenderer = () =>
      ({
        init: () => Promise.resolve(),
        backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, {
          has: () => false,
          destroyAttribute: vi.fn(),
        }),
        info: { destroyAttribute: vi.fn() },
      }) as unknown as WebGPURenderer

    beforeEach(async () => {
      const { buildWindfoilBackend } = await vi.importActual<typeof WindfoilRuntime>(
        '../src/windfoil/runtime.js',
      )
      domMocks.buildWindfoil.mockImplementation(
        buildWindfoilBackend as unknown as () => Promise<WindfoilBackend | null>,
      )
      domMocks.rasterize.mockImplementation((_document, requests) =>
        Promise.resolve({
          ...raster(),
          glyphs: new Map(
            requests.map((request) => [
              request.key,
              {
                key: request.key,
                character: request.character,
                fontKey: request.font.key,
                u0: 0,
                v0: 0,
                u1: 1,
                v1: 1,
                planeX0: -2,
                planeY0: -2,
                planeX1: 18,
                planeY1: 34,
                descent: 0,
                advance: 16,
              },
            ]),
          ),
        }),
      )
      domMocks.buildAtlas.mockImplementation((_renderer, source) => {
        const retained = atlas()
        for (const [key, slot] of source.glyphs) retained.glyphs.set(key, slot)
        return Promise.resolve(retained)
      })
      domMocks.snapshot.mockReturnValue(textSnapshot('AQ'))
    })

    it('hands the shape rows of the companion atlas to its SDF material', async () => {
      domMocks.buildAtlas.mockImplementation((_renderer, source) =>
        Promise.resolve({ ...atlas(), glyphs: new Map(source.glyphs), shapeTop: 2 }),
      )
      const domSdf = await DomSdf.create(webgpuRenderer(), block(), {
        observe: false,
        textBackend: 'windfoil',
        windfoil,
      })
      expect(meshNamed(domSdf, 'ultra-text fallback glyphs').material).toBeInstanceOf(
        SdfTextMaterial,
      )
      expect(domMocks.sdfMaterials.map((options) => options.shapeTop)).toEqual([2])
      expect(domMocks.sdfMaterials[0]!.atlas.userData).toEqual({})
      domSdf.dispose()
    })

    it.each([
      ['with', 'AQ'],
      ['without', 'AB'],
    ])(
      'reflows with the glyph ems the live material reads after a model flip that failed, %s a companion',
      async (_, characters) => {
        platform({ platform: 'MacIntel', touch: 0 })
        const rect = { rect: [0, 0, 8, 8], color: [1, 1, 1, 1], radius: 0, z: 0 } as const
        domMocks.snapshot.mockReturnValue({
          ...textSnapshot(characters),
          rects: [{ ...rect, receiveShadow: false }],
        })
        const source = block()
        const domSdf = await DomSdf.create(webgpuRenderer(), source, {
          observe: false,
          reflowable: true,
          textBackend: 'windfoil',
          windfoil,
        })
        const meta = () => meshNamed(domSdf, 'ultra-text text').geometry.getAttribute('sdfMeta')
        const material = textMaterial(domSdf)
        expect(material.tone!.dilates).toBe(true)
        // The dilating model reads each glyph's em from a third component.
        expect([meta().itemSize, meta().getZ(0)]).toEqual([3, -32])

        // The root's CSS turns font smoothing off; the rebuild that follows chooses the
        // outline model and then fails while it builds the replacement.
        source.style.setProperty('text-rendering', 'geometricPrecision')
        const failing = vi.spyOn(geometryBuilders, 'createRectGeometry').mockImplementation(() => {
          throw new Error('replacement failed')
        })
        await expect(domSdf.rebuild()).rejects.toThrow('replacement failed')
        failing.mockRestore()
        expect(textMaterial(domSdf)).toBe(material)

        // The scene still shows the dilating material: a reflow must not drop the ems.
        domSdf.reflow(200)
        expect([meta().itemSize, meta().getZ(0)]).toEqual([3, -32])
        domSdf.dispose()
      },
    )

    it('tones the Windfoil material and the companion alike, and both follow a recapture', async () => {
      platform({ brand: 'Windows' })
      const panel = block(document.body, 'rgb(0, 0, 0)')
      const domSdf = await DomSdf.create(webgpuRenderer(), block(panel), {
        observe: false,
        textBackend: 'windfoil',
        windfoil,
        tone: { strength: 0.75 },
      })
      const primary = textMaterial(domSdf)
      const companion = meshNamed(domSdf, 'ultra-text fallback glyphs').material
      expect(primary).toBeInstanceOf(WindfoilMaterial)
      expect(companion).toBeInstanceOf(SdfTextMaterial)
      // The companion's own atlas names the bake size its material reads.
      expect(domMocks.sdfMaterials.map((options) => options.bakeSize)).toEqual([32])
      const dark = { ...WINDOWS, strength: 0.75, backdrop: 0 }
      expect(primary.tone!.resolved).toEqual(dark)
      expect(companion.tone!.resolved).toEqual(dark)
      expect(companion.tone).not.toBe(primary.tone)

      // An unchanged capture over a new background, then a changed capture over another.
      panel.style.backgroundColor = 'rgb(255, 255, 255)'
      await domSdf.rebuild()
      for (const material of [primary, companion]) {
        expect(material.tone!.resolved).toEqual({ ...dark, backdrop: 1 })
        expect(material.tone!.ink.value.toArray()).toEqual([1, 0.75, 0.25])
      }
      panel.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'
      domMocks.snapshot.mockReturnValue(textSnapshot('QA'))
      await domSdf.rebuild()
      for (const material of [primary, companion])
        expect(material.tone!.resolved.backdrop).toBeCloseTo(0.5, 6)
      expect(textMaterial(domSdf)).toBe(primary)
      expect(meshNamed(domSdf, 'ultra-text fallback glyphs').material).toBe(companion)
      expect(domMocks.buildWindfoil).toHaveBeenCalledOnce()
      domSdf.dispose()
    })

    it('rebuilds both materials when the model starts or stops adding shader nodes', async () => {
      platform({ brand: 'macOS' })
      const source = block()
      source.style.setProperty('text-rendering', 'geometricPrecision')
      const domSdf = await DomSdf.create(webgpuRenderer(), source, {
        observe: false,
        textBackend: 'windfoil',
        windfoil,
      })
      const primary = textMaterial(domSdf)
      const companion = meshNamed(domSdf, 'ultra-text fallback glyphs').material
      expect(primary.tone!.resolved).toEqual(OUTLINE)
      expect(companion.tone!.resolved).toEqual(OUTLINE)
      const disposals = [primary, companion].map((material) => vi.spyOn(material, 'dispose'))
      const meta = () => meshNamed(domSdf, 'ultra-text text').geometry.getAttribute('sdfMeta')
      const outlined = meta()
      expect(outlined.itemSize).toBe(2)

      source.style.removeProperty('text-rendering')
      await domSdf.rebuild()
      expect(textMaterial(domSdf)).not.toBe(primary)
      expect(textMaterial(domSdf).tone!.resolved).toEqual(MACOS)
      // The dilating model comes with geometry that carries each glyph's font size, below
      // zero so that nothing reads it as a size switch.
      expect(meta()).not.toBe(outlined)
      expect(meta().itemSize).toBe(3)
      expect(meta().getZ(0)).toBe(-32)
      const nextCompanion = meshNamed(domSdf, 'ultra-text fallback glyphs').material
      expect(nextCompanion).not.toBe(companion)
      expect(nextCompanion.tone!.resolved).toEqual(MACOS)
      // The refused tone never reached the materials that were on screen until the swap.
      expect(primary.tone!.resolved).toEqual(OUTLINE)
      expect(companion.tone!.resolved).toEqual(OUTLINE)
      for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
      // Only the materials are new: the outlines and the companion atlas are reused.
      expect(domMocks.buildWindfoil).toHaveBeenCalledOnce()
      expect(domMocks.buildAtlas).toHaveBeenCalledOnce()

      // Back to the exact outline: material and geometry leave the font size together.
      const dilating = textMaterial(domSdf)
      source.style.setProperty('text-rendering', 'geometricPrecision')
      await domSdf.rebuild()
      expect(textMaterial(domSdf)).not.toBe(dilating)
      expect(textMaterial(domSdf).tone!.dilates).toBe(false)
      expect(meta().itemSize).toBe(2)
      expect(domMocks.buildWindfoil).toHaveBeenCalledOnce()
      domSdf.dispose()
    })
  })

  it('reads the backdrop from the rectangles the capture draws behind its text', async () => {
    // The page is dark, the captured paper under the text is white.
    document.body.style.backgroundColor = 'rgb(0, 0, 0)'
    domMocks.snapshot.mockReturnValue(inked([sheet([1, 1, 1, 1])]))
    const domSdf = await DomSdf.create(renderer, block(), { observe: false })
    const material = textMaterial(domSdf)
    // The capture draws that paper itself: a backdrop certain to be in the frame.
    expect(material.tone!.resolved).toEqual({ ...OUTLINE, ...DRAWN })

    // The paper turns dark: a changed capture, updated in place, with the same material.
    domMocks.snapshot.mockReturnValue(inked([sheet([0, 0, 0, 1])]))
    await domSdf.rebuild()
    expect(textMaterial(domSdf)).toBe(material)
    expect(material.tone!.resolved).toEqual({ ...OUTLINE, ...DRAWN, backdrop: 0 })
    domSdf.dispose()
  })

  it("counts the root's background once, from the capture or else from the page", async () => {
    const root = block(document.body, 'rgba(0, 0, 0, 0.5)')
    const veil = sheet([0, 0, 0, 0.5])
    const resolved = async (capture: DomLayoutSnapshot, options: DomSdfOptions) => {
      domMocks.snapshot.mockReturnValue(capture)
      const domSdf = await DomSdf.create(renderer, root, { observe: false, ...options })
      const { backdrop } = textMaterial(domSdf).tone!.resolved
      domSdf.dispose()
      return backdrop
    }
    // By default the capture copies the root's background as a rectangle.
    expect(await resolved(inked([veil]), {})).toBeCloseTo(0.5, 9)
    // Left out of the capture, it is still what the page shows behind the text.
    expect(await resolved(inked([]), { includeRootBackground: false })).toBeCloseTo(0.5, 9)
    // A root that is itself a captured rectangle is copied whatever that option says.
    root.setAttribute('data-sdf-rect', '')
    expect(await resolved(inked([veil]), { includeRootBackground: false })).toBeCloseTo(0.5, 9)
    root.removeAttribute('data-sdf-rect')
    root.className = 'panel'
    const options = { includeRootBackground: false, rectSelector: '.panel' }
    expect(await resolved(inked([veil]), options)).toBeCloseTo(0.5, 9)
  })

  it('follows a new background through the uniforms of the same material', async () => {
    const source = block()
    const domSdf = await DomSdf.create(renderer, source, { observe: false })
    const material = textMaterial(domSdf)
    const tone = material.tone!
    const graph = material.colorNode
    expect(tone.resolved).toEqual(OUTLINE)
    expect(tone.curve.value.x).toBeCloseTo(CURVE_WHITE[0]!, 9)
    expect(tone.curve.value.y).toBeCloseTo(CURVE_WHITE[1]!, 9)

    // Nothing the layout reads changed: only the page behind the text went dark.
    document.body.style.backgroundColor = 'rgb(0, 0, 0)'
    await domSdf.rebuild()
    expect(domSdf.stats.geometryBuildMs).toBe(0)
    expect(textMaterial(domSdf)).toBe(material)
    expect(material.tone).toBe(tone)
    expect(material.colorNode).toBe(graph)
    expect(tone.resolved).toEqual({ ...OUTLINE, backdrop: 0 })
    expect(tone.ink.value.toArray()).toEqual([0, 1, 0])
    expect(tone.curve.value.x).toBeCloseTo(CURVE_BLACK[0]!, 9)
    expect(tone.curve.value.y).toBeCloseTo(CURVE_BLACK[1]!, 9)
    expect(tone.curve.value.z).toBe(0)

    // A changed layout updated in place carries the next background the same way.
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
    domMocks.snapshot.mockReturnValue(snapshot(260))
    await domSdf.rebuild()
    expect(domSdf.width).toBe(260)
    expect(textMaterial(domSdf)).toBe(material)
    expect(tone.resolved).toEqual(OUTLINE)
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    domSdf.dispose()
  })

  it('rebuilds the material when the model changes between macOS smoothing and the outline', async () => {
    platform({ platform: 'MacIntel', touch: 0 })
    const source = block()
    const domSdf = await DomSdf.create(renderer, source, { observe: false })
    const smoothed = textMaterial(domSdf)
    const disposeSmoothed = vi.spyOn(smoothed, 'dispose')
    expect(smoothed.tone!.resolved).toEqual(MACOS)
    expect(smoothed.tone!.dilates).toBe(true)

    // The capture is unchanged, yet the short circuit must not keep the dilating graph.
    source.style.setProperty('text-rendering', 'geometricPrecision')
    await domSdf.rebuild()
    const exact = textMaterial(domSdf)
    expect(exact).not.toBe(smoothed)
    expect(exact.tone!.resolved).toEqual(OUTLINE)
    expect(exact.tone!.dilates).toBe(false)
    expect(smoothed.tone!.resolved).toEqual(MACOS)
    expect(disposeSmoothed).toHaveBeenCalledOnce()

    // And back, on the path that would otherwise update the geometry in place.
    source.style.removeProperty('text-rendering')
    domMocks.snapshot.mockReturnValue(snapshot(260))
    await domSdf.rebuild()
    expect(textMaterial(domSdf)).not.toBe(exact)
    expect(textMaterial(domSdf).tone!.dilates).toBe(true)
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    domSdf.dispose()
  })

  it('leaves the tone as it was when the update it came with fails', async () => {
    const rect: RectLayout = {
      rect: [0, 0, 8, 8],
      color: [1, 1, 1, 1],
      radius: 0,
      z: 0,
      receiveShadow: false,
    }
    const initial: DomLayoutSnapshot = { ...snapshot(), rects: [rect] }
    domMocks.snapshot.mockReturnValue(initial)
    const domSdf = await DomSdf.create(renderer, block(), { observe: false })
    const tone = textMaterial(domSdf).tone!

    document.body.style.backgroundColor = 'rgb(0, 0, 0)'
    domMocks.snapshot.mockReturnValue({ ...initial, rects: [rect, rect] })
    const staging = vi.spyOn(geometryBuilders, 'createRectGeometry').mockImplementation(() => {
      throw new Error('staging failed')
    })
    await expect(domSdf.rebuild()).rejects.toThrow('staging failed')
    expect(tone.resolved).toEqual(OUTLINE)
    expect(tone.ink.value.x).toBe(1)

    staging.mockRestore()
    await domSdf.rebuild()
    expect(textMaterial(domSdf).tone).toBe(tone)
    expect(tone.resolved).toEqual({ ...OUTLINE, backdrop: 0 })
    domSdf.dispose()
  })

  it('keeps the tone across a reflow, which reads no DOM', async () => {
    document.body.style.backgroundColor = 'rgb(0, 0, 0)'
    const domSdf = await DomSdf.create(renderer, block(), { observe: false, reflowable: true })
    const tone = textMaterial(domSdf).tone!
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
    const styles = vi.spyOn(window, 'getComputedStyle')
    domSdf.reflow(180)
    expect(styles).not.toHaveBeenCalled()
    expect(textMaterial(domSdf).tone).toBe(tone)
    expect(tone.resolved.backdrop).toBe(0)
    domSdf.dispose()
  })

  describe('Text', () => {
    it('resolves the model from its owned source and never reads the page behind it', async () => {
      platform({ brand: 'macOS' })
      const parent = block(document.body, 'rgb(0, 0, 0)')
      const tone = { strength: 0.5 }
      const text = new Text('Hi', {
        renderer,
        parent,
        observe: false,
        css: { textRendering: 'geometricPrecision' },
        tone,
      })
      await text.ready

      expect(text.options.tone).toEqual(tone)
      expect(text.options.tone).not.toBe(tone)
      expect(Object.isFrozen(text.options.tone)).toBe(true)
      const material = textMaterial(text)
      // The black parent holds the hidden source; the scene draws the text over anything.
      expect(material.tone!.resolved).toEqual({ ...OUTLINE, strength: 0.5 })

      // Default font smoothing on macOS needs the dilating graph: a new material, whose ink
      // table stays off while nobody knows the backdrop.
      text.setCss('')
      await text.rebuild()
      expect(textMaterial(text)).not.toBe(material)
      expect(textMaterial(text).tone!.resolved).toEqual({ ...MACOS, strength: 0.5, table: 0 })
      expect(textMaterial(text).tone!.dilates).toBe(true)

      // The source's own opaque background arrives as the capture's root rectangle, which
      // the scene does draw behind the glyphs: a known backdrop, with the table.
      text.setCss({ backgroundColor: 'rgb(0, 0, 0)' })
      domMocks.snapshot.mockReturnValue(inked([sheet([0, 0, 0, 1])]))
      await text.rebuild()
      const smoothed = textMaterial(text)
      expect(smoothed.tone!.resolved).toEqual({ ...MACOS, ...DRAWN, strength: 0.5, backdrop: 0 })

      // A translucent one leaves the scene showing through: unknown again, in the uniforms
      // of the same material.
      domMocks.snapshot.mockReturnValue(inked([sheet([0, 0, 0, 0.5])]))
      await text.rebuild()
      expect(textMaterial(text)).toBe(smoothed)
      expect(smoothed.tone!.resolved).toEqual({ ...MACOS, strength: 0.5, table: 0 })
      expect(smoothed.tone!.ink.value.toArray()).toEqual([1, 0.5, 0])
      text.dispose()
    })

    it('reads no background behind its hidden source', async () => {
      platform({ brand: 'Windows' })
      const parent = block(document.body, 'rgb(0, 0, 0)')
      document.body.style.backgroundColor = 'rgb(0, 0, 0)'
      const styles = vi.spyOn(window, 'getComputedStyle')
      const text = new Text('Hi', { renderer, parent, observe: false })
      await text.ready
      // Windows text over a backdrop nobody knows: white is assumed, light ink stays exact.
      expect(textMaterial(text).tone!.resolved).toEqual({ ...WINDOWS, table: 0 })
      expect(styles).not.toHaveBeenCalled()
      text.dispose()
    })

    it('takes an explicit backdrop as known', async () => {
      platform({ brand: 'Windows' })
      const text = new Text('Hi', { renderer, observe: false, tone: { backdrop: '#000' } })
      await text.ready
      expect(textMaterial(text).tone!.resolved).toEqual({ ...WINDOWS, ...DRAWN, backdrop: 0 })
      text.dispose()
    })

    it('builds no conversion with `tone: false`', async () => {
      const text = new Text('Hi', { renderer, observe: false, tone: false })
      await text.ready
      expect(textMaterial(text).tone).toBeNull()
      text.dispose()
    })
  })
})
