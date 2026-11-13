import { Group, Texture, type WebGPURenderer } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as RasterModule from '../src/atlas/rasterize.js'
import type { RasterizeOptions } from '../src/atlas/rasterize.js'
import type {
  BuildSdfAtlasOptions,
  DomLayoutSnapshot,
  DomSdfOptions,
  GlyphRequest,
  RasterAtlas,
  SdfAtlas,
} from '../src/types.js'

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

import { DomSdf, Text } from '../src/index.js'

const renderer = {} as WebGPURenderer
const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')

function snapshot(width = 240): DomLayoutSnapshot {
  return {
    width,
    height: 120,
    glyphs: [],
    rects: [],
    blocks: [],
    requests: [],
    atlasSignature: '',
    lineCount: 2,
  }
}

function atlas() {
  return {
    texture: new Texture(),
    width: 4,
    height: 4,
    pxRange: 4,
    bakeSize: 32,
    glyphs: new Map(),
    mode: 'cpu' as const,
    dispose: vi.fn<() => void>(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setFonts(ready: Promise<unknown>) {
  const fonts = {
    ready,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  return fonts
}

beforeEach(() => {
  domMocks.snapshot.mockReset().mockReturnValue(snapshot())
  domMocks.rasterize.mockReset().mockResolvedValue({
    canvas: document.createElement('canvas'),
    width: 4,
    height: 4,
    bakeSize: 32,
    pxRange: 4,
    glyphs: new Map(),
  })
  domMocks.buildAtlas.mockReset().mockResolvedValue(atlas())
  Object.defineProperty(document, 'fonts', { configurable: true, value: undefined })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    },
  )
})

afterEach(() => {
  document.body.replaceChildren()
  if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor)
  else Reflect.deleteProperty(document, 'fonts')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Text', () => {
  it('builds literal text through the retained DomSdf API with a connected owned source', async () => {
    const text = new Text('<strong>Hello</strong>\nworld', { renderer, observe: false })
    const source = text.source
    const wrapper = source.parentElement!
    expect(text).toBeInstanceOf(Group)
    expect(text).toBeInstanceOf(DomSdf)
    expect(source.textContent).toBe('<strong>Hello</strong>\nworld')
    expect(source.children).toHaveLength(0)
    expect(source.hasAttribute('data-sdf-block')).toBe(true)
    expect(source.isConnected).toBe(true)
    expect(wrapper.parentElement).toBe(document.body)
    expect(wrapper.style.display).not.toBe('none')
    expect(wrapper.style.visibility).not.toBe('hidden')
    expect(source.style.display).not.toBe('none')
    expect(source.style.visibility).not.toBe('hidden')
    expect(await text.ready).toBe(text)
    expect(domMocks.snapshot).toHaveBeenCalledWith(source, text.options)
    expect(text.stats).toMatchObject({ atlasMode: 'cpu', lines: 2, draws: 1 })
    text.dispose()
    expect(source.isConnected).toBe(false)
    expect(wrapper.isConnected).toBe(false)
    expect(document.body.children).toHaveLength(0)
  })

  it('accepts camelCase, kebab-case and custom properties with CSS numeric units', async () => {
    const text = new Text('Styled', {
      renderer,
      observe: false,
      css: {
        fontSize: 32,
        'letter-spacing': 1.5,
        padding: 8,
        width: 360,
        lineHeight: 1.4,
        fontWeight: 600,
        fontSizeAdjust: 0.5,
        webkitLineClamp: 2,
        opacity: 0.75,
        zIndex: 2,
        gridColumn: 2,
        gridRowEnd: 4,
        initialLetter: 3,
        mathDepth: 1,
        '--accent': '#f60',
        '--count': 3,
        color: null,
        margin: undefined,
      },
    })
    const style = text.source.style
    expect(style.fontSize).toBe('32px')
    expect(style.letterSpacing).toBe('1.5px')
    expect(style.padding).toBe('8px')
    expect(style.width).toBe('360px')
    expect(style.lineHeight).toBe('1.4')
    expect(style.fontWeight).toBe('600')
    expect(style.fontSizeAdjust).toBe('0.5')
    expect(style.getPropertyValue('-webkit-line-clamp')).toBe('2')
    expect(style.opacity).toBe('0.75')
    expect(style.zIndex).toBe('2')
    expect(style.getPropertyValue('grid-column')).toBe('2')
    expect(style.getPropertyValue('grid-row-end')).toBe('4')
    expect(style.getPropertyValue('initial-letter')).toBe('3')
    expect(style.getPropertyValue('math-depth')).toBe('1')
    expect(style.getPropertyValue('--accent')).toBe('#f60')
    expect(style.getPropertyValue('--count')).toBe('3')
    expect(style.color).toBe('')
    expect(style.margin).toBe('')
    await text.ready
    text.dispose()
  })

  it('accepts a CSS declaration string and replaces styles without retaining old declarations', async () => {
    const text = new Text('Styled', {
      renderer,
      observe: false,
      css: 'font-size: 24px; color: red; letter-spacing: 2px;',
    })
    expect(text.source.style.fontSize).toBe('24px')
    expect(text.source.style.color).toBe('red')
    expect(text.setCss({ fontSize: 40, color: 'blue' })).toBe(text)
    expect(text.source.style.fontSize).toBe('40px')
    expect(text.source.style.color).toBe('blue')
    expect(text.source.style.letterSpacing).toBe('')
    expect(text.setCss('font-weight: bold;')).toBe(text)
    expect(text.source.style.fontWeight).toBe('bold')
    expect(text.source.style.fontSize).toBe('')
    expect(text.source.style.color).toBe('')
    await text.ready
    text.dispose()
  })

  it.each([
    ['space-separated names', 'headline accented'],
    ['class-name array', ['headline', 'accented']],
    ['conditional class map', { headline: true, accented: true, muted: false, none: null }],
  ] as const)('accepts %s from an ordinary compiled stylesheet', async (_, cssClass) => {
    const parent = document.body.appendChild(document.createElement('section'))
    const stylesheet = parent.appendChild(document.createElement('style'))
    stylesheet.textContent = '.headline { font-size: 48px; } .accented { color: rgb(12, 34, 56); }'
    const text = new Text('Classes', { renderer, observe: false, parent, cssClass })
    expect(text.source.classList.contains('headline')).toBe(true)
    expect(text.source.classList.contains('accented')).toBe(true)
    expect(text.source.classList.contains('muted')).toBe(false)
    expect(text.source.classList.contains('none')).toBe(false)
    expect(getComputedStyle(text.source).fontSize).toBe('48px')
    expect(getComputedStyle(text.source).color).toBe('rgb(12, 34, 56)')
    expect(text.source.parentElement!.parentElement).toBe(parent)
    await text.ready
    text.dispose()
    expect(parent.isConnected).toBe(true)
    expect(parent.children).toHaveLength(1)
    expect(parent.firstElementChild).toBe(stylesheet)
  })

  it('replaces class names while retaining the selectable source class', async () => {
    const text = new Text('Classes', {
      renderer,
      observe: false,
      selectable: true,
      cssClass: ['old', 'accented'],
    })
    expect(text.source.classList.contains('sdf-selectable')).toBe(true)
    expect(text.setClass({ next: true, muted: false })).toBe(text)
    expect([...text.source.classList].sort()).toEqual(['next', 'sdf-selectable'])
    expect(text.setClass('')).toBe(text)
    expect([...text.source.classList]).toEqual(['sdf-selectable'])
    await text.ready
    text.dispose()
  })

  it('copies and freezes CSS and class options without mutating caller-owned input', async () => {
    const css = { fontSize: 32, color: 'red' }
    const cssClass = { headline: true, muted: false }
    const options = { renderer, observe: false, css, cssClass }
    const text = new Text('Frozen options', options)
    css.fontSize = 99
    css.color = 'blue'
    cssClass.headline = false
    expect(Object.isFrozen(css)).toBe(false)
    expect(Object.isFrozen(cssClass)).toBe(false)
    expect(Object.isFrozen(options)).toBe(false)
    expect(Object.isFrozen(text.options)).toBe(true)
    expect(Object.isFrozen(text.options.css)).toBe(true)
    expect(Object.isFrozen(text.options.cssClass)).toBe(true)
    expect(text.options.css).toEqual({ fontSize: 32, color: 'red' })
    expect(text.options.cssClass).toEqual({ headline: true, muted: false })
    expect(text.source.style.fontSize).toBe('32px')
    expect(text.source.style.color).toBe('red')
    expect(text.source.classList.contains('headline')).toBe(true)
    text.setCss({ fontSize: 40 }).setClass('next')
    expect(text.options.css).toEqual({ fontSize: 32, color: 'red' })
    expect(text.options.cssClass).toEqual({ headline: true, muted: false })
    await text.ready
    text.dispose()
  })

  it('copies and freezes a class array before caller mutations', async () => {
    const cssClass = ['headline']
    const text = new Text('Classes', { renderer, observe: false, cssClass })
    cssClass.push('unexpected')
    expect(text.options.cssClass).toEqual(['headline'])
    expect(Object.isFrozen(text.options.cssClass)).toBe(true)
    expect(text.source.classList.contains('unexpected')).toBe(false)
    await text.ready
    text.dispose()
  })

  it('normalizes and deduplicates whitespace in every class form', async () => {
    const text = new Text('Classes', {
      renderer,
      observe: false,
      cssClass: [' headline accented ', 'headline'],
    })
    expect([...text.source.classList]).toEqual(['headline', 'accented'])
    text.setClass({ ' next\taccented ': true, next: true, hidden: undefined })
    expect([...text.source.classList]).toEqual(['next', 'accented'])
    await text.ready
    text.dispose()
  })

  it.each([NaN, Infinity, -Infinity])(
    'rejects a non-finite CSS length (%s) before adding an owned source',
    (fontSize) => {
      expect(() => new Text('Invalid', { renderer, css: { fontSize } })).toThrow(
        'CSS fontSize must be finite',
      )
      expect(document.body.children).toHaveLength(0)
      expect(domMocks.snapshot).not.toHaveBeenCalled()
    },
  )

  it('keeps the previous declarations when a CSS update is invalid', async () => {
    const text = new Text('Styled', {
      renderer,
      observe: false,
      css: { fontSize: 24, color: 'red' },
    })
    await text.ready
    expect(() => text.setCss({ fontSize: Infinity, color: 'blue' })).toThrow(
      'CSS fontSize must be finite',
    )
    expect(text.source.style.fontSize).toBe('24px')
    expect(text.source.style.color).toBe('red')
    text.dispose()
  })

  it('rejects a disconnected parent without leaving source elements in the page', () => {
    const parent = document.createElement('section')
    expect(() => new Text('Detached', { renderer, parent })).toThrow('parent must be connected')
    expect(parent.children).toHaveLength(0)
    expect(document.body.children).toHaveLength(0)
    expect(domMocks.snapshot).not.toHaveBeenCalled()
  })

  it('rejects source mutations after disposal', async () => {
    const text = new Text('Initial', { renderer, observe: false })
    await text.ready
    text.dispose()
    expect(() => {
      text.text = 'Disposed'
    }).toThrow('this instance is disposed')
    expect(() => text.setCss({ color: 'blue' })).toThrow('this instance is disposed')
    expect(() => text.setClass('changed')).toThrow('this instance is disposed')
    expect(text.text).toBe('Initial')
  })

  it('lets text changes and explicit rebuilds reuse retained atlas resources', async () => {
    const retained = atlas()
    domMocks.buildAtlas.mockResolvedValue(retained)
    const text = new Text('Initial', { renderer, observe: false })
    await text.ready
    text.text = '<em>Updated</em>'
    expect(text.text).toBe('<em>Updated</em>')
    expect(text.source.textContent).toBe('<em>Updated</em>')
    expect(text.source.children).toHaveLength(0)
    domMocks.snapshot.mockReturnValue(snapshot(300))
    await text.rebuild()
    expect(text.width).toBe(300)
    expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    expect(text.atlasTexture).toBe(retained.texture)
    text.dispose()
    text.dispose()
    expect(retained.dispose).toHaveBeenCalledOnce()
  })

  it.each(['text', 'css', 'class'] as const)(
    'recaptures a %s change made during its initial atlas build before ready resolves',
    async (change) => {
      const build = deferred<SdfAtlas>()
      const started = deferred<undefined>()
      const retained = atlas()
      domMocks.buildAtlas.mockImplementation(() => {
        started.resolve(undefined)
        return build.promise
      })
      domMocks.snapshot.mockImplementation((source) => {
        const updated =
          change === 'text'
            ? source.textContent === 'Updated'
            : change === 'css'
              ? source.style.width === '300px'
              : source.classList.contains('updated')
        return snapshot(updated ? 300 : 100)
      })
      const text = new Text('Initial', {
        renderer,
        observe: false,
        css: { width: 100 },
        cssClass: 'initial',
      })
      try {
        await started.promise
        expect(domMocks.snapshot).toHaveBeenCalledOnce()
        if (change === 'text') text.text = 'Updated'
        else if (change === 'css') text.setCss({ width: 300 })
        else text.setClass('updated')
        build.resolve(retained)
        expect(await text.ready).toBe(text)
        expect(text.source.isConnected).toBe(true)
        expect(text.width).toBe(300)
        expect(domMocks.snapshot).toHaveBeenCalledTimes(2)
        expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
        expect(retained.dispose).not.toHaveBeenCalled()
      } finally {
        text.dispose()
      }
      expect(retained.dispose).toHaveBeenCalledOnce()
    },
  )

  it('queues an explicit rebuild until initial font readiness and capture complete', async () => {
    const fonts = deferred<unknown>()
    setFonts(fonts.promise)
    const retained = atlas()
    domMocks.buildAtlas.mockResolvedValue(retained)
    const text = new Text('Initial', { renderer, observe: false })
    const ready = text.ready.then(
      (value) => value,
      (error: unknown) => error,
    )
    const rebuild = text.rebuild()
    const rebuilt = rebuild.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(domMocks.snapshot).not.toHaveBeenCalled()
      fonts.resolve(undefined)
      expect(await ready).toBe(text)
      expect(await rebuilt).toBeUndefined()
      expect(text.source.isConnected).toBe(true)
      expect(text.width).toBe(240)
      expect(domMocks.snapshot).toHaveBeenCalledTimes(2)
      expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
    } finally {
      fonts.resolve(undefined)
      text.dispose()
      await Promise.all([ready, rebuilt])
    }
    expect(retained.dispose).toHaveBeenCalledOnce()
  })

  it('queues an explicit rebuild during initial atlas work without disposing the instance', async () => {
    const build = deferred<SdfAtlas>()
    const started = deferred<undefined>()
    const retained = atlas()
    domMocks.buildAtlas.mockImplementationOnce(() => {
      started.resolve(undefined)
      return build.promise
    })
    const text = new Text('Initial', { renderer, observe: false })
    const ready = text.ready.then(
      (value) => value,
      (error: unknown) => error,
    )
    await started.promise
    const rebuilt = text.rebuild().then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(domMocks.snapshot).toHaveBeenCalledOnce()
      expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
      build.resolve(retained)
      expect(await ready).toBe(text)
      expect(await rebuilt).toBeUndefined()
      expect(text.source.isConnected).toBe(true)
      expect(text.width).toBe(240)
      expect(domMocks.snapshot).toHaveBeenCalledTimes(2)
      expect(domMocks.buildAtlas).toHaveBeenCalledOnce()
      expect(retained.dispose).not.toHaveBeenCalled()
    } finally {
      build.resolve(retained)
      text.dispose()
      await Promise.all([ready, rebuilt])
    }
    expect(retained.dispose).toHaveBeenCalledOnce()
  })

  it('keeps default mutation observers active for text and CSS changes', async () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const text = new Text('Initial', { renderer })
    await text.ready
    text.text = 'Observed'
    await Promise.resolve()
    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(domMocks.snapshot).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    text.setCss({ color: 'blue' }).setClass('changed')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(80)
    expect(domMocks.snapshot).toHaveBeenCalledTimes(3)
    text.dispose()
  })

  it('waits for document fonts before taking its initial snapshot', async () => {
    const fonts = deferred<unknown>()
    setFonts(fonts.promise)
    const text = new Text('Webfont', { renderer, observe: false })
    await Promise.resolve()
    expect(domMocks.snapshot).not.toHaveBeenCalled()
    expect(text.source.isConnected).toBe(true)
    fonts.resolve(undefined)
    expect(await text.ready).toBe(text)
    expect(domMocks.snapshot).toHaveBeenCalledOnce()
    text.dispose()
  })

  it('waits for replacement font readiness after a pre-ready CSS change', async () => {
    const initial = deferred<unknown>()
    const replacement = deferred<unknown>()
    const fonts = setFonts(initial.promise)
    const text = new Text('Webfont', { renderer, observe: false })
    try {
      fonts.ready = replacement.promise
      text.setCss({ fontFamily: 'Replacement', width: 300 })
      initial.resolve(undefined)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(domMocks.snapshot).not.toHaveBeenCalled()
      expect(domMocks.buildAtlas).not.toHaveBeenCalled()
      domMocks.snapshot.mockImplementation((source) => {
        expect(source.style.fontFamily).toBe('Replacement')
        return snapshot(Number.parseFloat(source.style.width))
      })
      replacement.resolve(undefined)
      expect(await text.ready).toBe(text)
      expect(domMocks.snapshot).toHaveBeenCalledOnce()
      expect(text.width).toBe(300)
      expect(text.source.isConnected).toBe(true)
    } finally {
      initial.resolve(undefined)
      replacement.resolve(undefined)
      text.dispose()
      await text.ready.catch(() => undefined)
    }
  })

  it('cancels the font wait and removes owned DOM when disposed before ready', async () => {
    const fonts = deferred<unknown>()
    setFonts(fonts.promise)
    const text = new Text('Pending font', { renderer, observe: false })
    const wrapper = text.source.parentElement!
    const rejected = expect(text.ready).rejects.toMatchObject({ name: 'AbortError' })
    text.dispose()
    text.dispose()
    await rejected
    expect(text.source.isConnected).toBe(false)
    expect(wrapper.isConnected).toBe(false)
    fonts.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(domMocks.snapshot).not.toHaveBeenCalled()
    expect(domMocks.buildAtlas).not.toHaveBeenCalled()
  })

  it('forwards an external abort while waiting for fonts and cleans up the source', async () => {
    const fonts = deferred<unknown>()
    setFonts(fonts.promise)
    const controller = new AbortController()
    const text = new Text('Pending font', {
      renderer,
      observe: false,
      signal: controller.signal,
    })
    const reason = new Error('cancel the pending text')
    const rejected = expect(text.ready).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    expect(document.body.children).toHaveLength(0)
    fonts.resolve(undefined)
    await Promise.resolve()
    expect(domMocks.snapshot).not.toHaveBeenCalled()
  })

  it('does not capture or leave source elements for an already aborted build', async () => {
    const controller = new AbortController()
    const reason = new Error('already aborted')
    controller.abort(reason)
    const text = new Text('Cancelled', { renderer, observe: false, signal: controller.signal })
    await expect(text.ready).rejects.toBe(reason)
    expect(domMocks.snapshot).not.toHaveBeenCalled()
    expect(document.body.children).toHaveLength(0)
  })

  it('removes owned DOM when document font readiness rejects', async () => {
    const fonts = deferred<unknown>()
    setFonts(fonts.promise)
    const text = new Text('Bad font', { renderer, observe: false })
    const rejected = expect(text.ready).rejects.toThrow('font failed')
    fonts.reject(new Error('font failed'))
    await rejected
    expect(domMocks.snapshot).not.toHaveBeenCalled()
    expect(document.body.children).toHaveLength(0)
  })

  it('removes owned DOM and releases an atlas when initial content construction fails', async () => {
    const retained = atlas()
    domMocks.buildAtlas.mockResolvedValue(retained)
    const text = new Text('Bad fill', {
      renderer,
      observe: false,
      fill: () => {
        throw new Error('fill failed')
      },
    })
    await expect(text.ready).rejects.toThrow('fill failed')
    expect(retained.dispose).toHaveBeenCalledOnce()
    expect(text.children).toHaveLength(0)
    expect(document.body.children).toHaveLength(0)
  })

  it('aborts a pending atlas build and disposes its late result after disposal', async () => {
    const build = deferred<SdfAtlas>()
    const started = deferred<AbortSignal>()
    domMocks.buildAtlas.mockImplementation((_renderer, _raster, options) => {
      started.resolve(options!.signal!)
      return build.promise
    })
    const text = new Text('Pending atlas', { renderer, observe: false })
    const signal = await started.promise
    const rejected = expect(text.ready).rejects.toMatchObject({ name: 'AbortError' })
    text.dispose()
    expect(signal.aborted).toBe(true)
    expect(document.body.children).toHaveLength(0)
    const late = atlas()
    build.resolve(late)
    await rejected
    expect(late.dispose).toHaveBeenCalledOnce()
    expect(text.children).toHaveLength(0)
    expect(text.atlasTexture).toBeNull()
  })

  it('keeps a supplied atlas caller-owned when removing its source on disposal', async () => {
    const shared = atlas()
    const text = new Text('Shared', { renderer, observe: false, sharedAtlas: shared })
    await text.ready
    expect(domMocks.rasterize).not.toHaveBeenCalled()
    expect(domMocks.buildAtlas).not.toHaveBeenCalled()
    expect(text.atlasTexture).toBe(shared.texture)
    text.dispose()
    expect(shared.dispose).not.toHaveBeenCalled()
    expect(document.body.children).toHaveLength(0)
  })
})
