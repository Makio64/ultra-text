import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GlyphRequest } from '../src/types.js'

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
} as const
const fontDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')

afterEach(() => {
  vi.doUnmock('../src/dom/browserShaping.js')
  vi.doUnmock('../src/dom/pretextLayout.js')
  vi.doUnmock('../src/dom/svgCapture.js')
  vi.doUnmock('../src/atlas/shapeRaster.js')
  vi.resetModules()
  if (fontDescriptor) Object.defineProperty(document, 'fonts', fontDescriptor)
  else Reflect.deleteProperty(document, 'fonts')
})

describe('optional capture loading', () => {
  it('keeps ordinary Range capture independent of the Pretext layout module', async () => {
    const loadPretext = vi.fn(() => {
      throw new Error('unexpected pretext import')
    })
    vi.doMock('../src/dom/pretextLayout.js', loadPretext)
    const { collectDomSnapshot } = await import('../src/dom/snapshot.js')
    const root = document.body.appendChild(document.createElement('div'))
    root.setAttribute('data-sdf-block', '')
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 20,
      bottom: 20,
      width: 20,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot).not.toBeInstanceOf(Promise)
    expect(loadPretext).not.toHaveBeenCalled()
    root.remove()
  })

  it('starts browser shaping while the SVG module is still loading', async () => {
    let releaseSvg!: () => void
    const svgLoading = new Promise<void>((resolve) => {
      releaseSvg = resolve
    })
    const loadSvg = vi.fn(async () => {
      await svgLoading
      return { resolveSvgOptions: vi.fn() }
    })
    const loadShaping = vi.fn(() => ({
      validateBrowserShaping: () => {
        throw new Error('finished loading')
      },
    }))
    vi.doMock('../src/dom/svgCapture.js', loadSvg)
    vi.doMock('../src/dom/browserShaping.js', loadShaping)
    const { collectDomSnapshot } = await import('../src/dom/snapshot.js')
    const capture = collectDomSnapshot(document.createElement('div'), {
      svg: true,
      textShaping: 'browser',
    })
    try {
      await vi.waitFor(() => {
        expect(loadSvg).toHaveBeenCalledOnce()
        expect(loadShaping).toHaveBeenCalledOnce()
      })
    } finally {
      releaseSvg()
      await expect(capture).rejects.toThrow('finished loading')
    }
  })

  it('starts optional rasterizers while the font request is pending', async () => {
    let releaseFonts!: () => void
    const fontsLoading = new Promise<void>((resolve) => {
      releaseFonts = resolve
    })
    const loadFonts = vi.fn(() => fontsLoading)
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: loadFonts } })
    const loadShaping = vi.fn(() => ({ setShapingContext: vi.fn() }))
    const loadShapes = vi.fn(() => ({ measureShape: vi.fn() }))
    vi.doMock('../src/dom/browserShaping.js', loadShaping)
    vi.doMock('../src/atlas/shapeRaster.js', loadShapes)
    const { rasterizeGlyphAtlas } = await import('../src/atlas/rasterize.js')
    const controller = new AbortController()
    const requests: GlyphRequest[] = [
      {
        key: 'run',
        character: 'joined text',
        font,
        shaping: { direction: 'ltr', language: 'en', letterSpacing: 0, wordSpacing: 0 },
      },
      {
        key: 'shape',
        character: '\uFFFC',
        font,
        shape: { box: [10, 10], bounds: [0, 0, 10, 10], paths: [] },
      },
    ]
    const capture = rasterizeGlyphAtlas(document, requests, { signal: controller.signal })
    try {
      await vi.waitFor(() => {
        expect(loadFonts).toHaveBeenCalledOnce()
        expect(loadShaping).toHaveBeenCalledOnce()
        expect(loadShapes).toHaveBeenCalledOnce()
      })
    } finally {
      controller.abort(new Error('cancel pending fonts'))
      releaseFonts()
      await expect(capture).rejects.toThrow('cancel pending fonts')
    }
  })

  it('keeps ordinary rasterization independent of optional modules', async () => {
    const loadShaping = vi.fn(() => {
      throw new Error('unexpected shaping import')
    })
    const loadShapes = vi.fn(() => {
      throw new Error('unexpected shape import')
    })
    vi.doMock('../src/dom/browserShaping.js', loadShaping)
    vi.doMock('../src/atlas/shapeRaster.js', loadShapes)
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => Promise.reject(new Error('stop before drawing')) },
    })
    const { rasterizeGlyphAtlas } = await import('../src/atlas/rasterize.js')
    await expect(
      rasterizeGlyphAtlas(document, [{ key: 'A', character: 'A', font }]),
    ).rejects.toThrow('stop before drawing')
    expect(loadShaping).not.toHaveBeenCalled()
    expect(loadShapes).not.toHaveBeenCalled()
  })
})
