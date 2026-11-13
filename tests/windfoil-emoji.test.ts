import { resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { preprocessWindfoilOutlines } from '../src/windfoil/preprocess.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSvgEmojiOutlineProvider } from '../src/windfoil/emoji.js'
import type { GlyphRequest, WindfoilGlyphOutline } from '../src/types.js'
const glyph: WindfoilGlyphOutline = {
  unitsPerEm: 1000,
  ascent: 800,
  descent: -200,
  bbox: [0, 0, 10, 10],
  quadratics: [],
}
const svg = '<svg viewBox="0 0 10 10"><path d="M0 0H10V10H0Z" fill="#ff0000"/></svg>'
const request = (character: string): GlyphRequest => ({
  key: `font\0${character}`,
  character,
  font: {
    key: 'font',
    family: 'test',
    size: 20,
    canvasFont: '20px test',
    weight: '400',
    style: 'normal',
    stretch: 'normal',
    variant: 'normal',
    kerning: 'auto',
    featureSettings: 'normal',
    variationSettings: 'normal',
    opticalSizing: 'none',
  },
})
const signal = () => new AbortController().signal
afterEach(() => vi.unstubAllGlobals())
function canvas() {
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { font: '', measureText: () => ({ width: 30 }) }
      }
    },
  )
}
describe('SVG emoji provider', () => {
  it('chains text presentation and non-emoji to the text provider', async () => {
    const text = vi.fn(() => glyph),
      resolve = vi.fn((_cluster: string, _signal: AbortSignal) => Promise.resolve(svg)),
      provider = createSvgEmojiOutlineProvider({ text, resolve })
    expect(await provider(request('A'), signal())).toBe(glyph)
    expect(await provider(request('❤︎'), signal())).toBe(glyph)
    expect(resolve).not.toHaveBeenCalled()
    expect(text).toHaveBeenCalledTimes(2)
  })
  it('passes original clusters to resolve while sharing non-ZWJ FE0F cache keys', async () => {
    canvas()
    const resolve = vi.fn((_cluster: string, _signal: AbortSignal) => Promise.resolve(svg)),
      provider = createSvgEmojiOutlineProvider({ text: () => glyph, resolve })
    const first = await provider(request('❤️'), signal()),
      second = await provider(request('❤'), signal())
    expect(first).toBe(second)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[0]).toBe('❤️')
    expect(first!.descent).toBe(-409.6)
    expect(first!.bbox[0] + first!.bbox[2]).toBeCloseTo(3072)
    expect(first!.layers).toHaveLength(1)
  })
  it('retains FE0F in joined clusters and uses explicit em metrics', async () => {
    canvas()
    const resolve = vi.fn((_cluster: string, _signal: AbortSignal) => Promise.resolve(svg)),
      provider = createSvgEmojiOutlineProvider({
        text: () => null,
        resolve,
        em: { unitsPerEm: 1000, ascent: 900, descent: -100 },
      })
    const first = await provider(request('🏳️‍🌈'), signal())
    await provider(request('🏳‍🌈'), signal())
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(first!.descent).toBe(-100)
  })
  it('shares concurrent resolution and conversion without coupling caller cancellation', async () => {
    canvas()
    let finish!: (svg: string) => void
    const resolve = vi.fn(
      (_cluster: string, _signal: AbortSignal) =>
        new Promise<string>((done) => {
          finish = done
        }),
    )
    const text = vi.fn(() => glyph)
    const provider = createSvgEmojiOutlineProvider({ text, resolve })
    const controller = new AbortController()
    const first = provider(request('❤️'), controller.signal)
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = provider(request('❤'), signal())
    const third = provider(request('❤'), signal())
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    controller.abort()
    await cancelled
    expect(resolve.mock.calls[0]![1].aborted).toBe(false)
    finish(svg)
    const [a, b] = await Promise.all([second, third])
    expect(a).toBe(b)
    expect(a).not.toBeNull()
    expect(text).toHaveBeenCalledTimes(1)
    expect(await provider(request('❤️'), signal())).toBe(a)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('shares SVG loading across fonts and cancels abandoned work without poisoning a retry', async () => {
    canvas()
    let finish!: (svg: string) => void
    const resolve = vi.fn(
      (_cluster: string, _signal: AbortSignal) =>
        new Promise<string>((done) => {
          finish = done
        }),
    )
    const provider = createSvgEmojiOutlineProvider({ text: () => glyph, resolve })
    const controller = new AbortController()
    const original = request('😀')
    const first = provider(original, controller.signal)
    const second = provider(
      { ...original, font: { ...original.font, key: 'other-font' } },
      controller.signal,
    )
    const rejected = Promise.all([
      expect(first).rejects.toMatchObject({ name: 'AbortError' }),
      expect(second).rejects.toMatchObject({ name: 'AbortError' }),
    ])
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    const abandoned = finish
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(resolve.mock.calls[0]![1].aborted).toBe(true))
    const retried = provider(original, signal())
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    abandoned('<svg/>')
    finish(svg)
    const result = await retried
    expect(result!.layers).toHaveLength(1)
    expect(await provider(original, signal())).toBe(result)
    expect(resolve).toHaveBeenCalledTimes(2)
  })
  it('retries resolver failures instead of caching rejected work', async () => {
    canvas()
    const failure = new Error('transient resolver failure')
    const resolve = vi
      .fn((_cluster: string, _signal: AbortSignal) => Promise.resolve(svg))
      .mockRejectedValueOnce(failure)
    const provider = createSvgEmojiOutlineProvider({ text: () => glyph, resolve })
    await expect(provider(request('😀'), signal())).rejects.toBe(failure)
    expect(await provider(request('😀'), signal())).not.toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
  })
  it('falls back for overlapping translucent SVG groups while accepting single-path opacity', async () => {
    canvas()
    const provider = (children: string) =>
      createSvgEmojiOutlineProvider({
        text: () => glyph,
        resolve: () =>
          Promise.resolve(`<svg viewBox="0 0 10 10"><g opacity=".5">${children}</g></svg>`),
      })
    const red = '<path d="M0 0H10V10H0Z" fill="#ff0000"/>'
    const blue = '<path d="M2 2H8V8H2Z" fill="#0000ff"/>'
    expect(await provider(red + blue)(request('😀'), signal())).toBeNull()
    const single = await provider(red)(request('😀'), signal())
    expect(single!.layers).toHaveLength(1)
    expect(single!.layers![0]!.paint).toEqual({ type: 'solid', color: [1, 0, 0, 0.5] })
  })
  it('returns null for unavailable or unsupported art and honours abort during resolve', async () => {
    const provider = createSvgEmojiOutlineProvider({
      text: () => glyph,
      resolve: () => Promise.resolve(null),
    })
    expect(await provider(request('😀'), signal())).toBeNull()
    const controller = new AbortController()
    const aborted = createSvgEmojiOutlineProvider({
      text: () => glyph,
      resolve: () =>
        new Promise(() => {
          /* Remains pending until abort. */
        }),
    })
    const pending = aborted(request('😀'), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('accepts conservative bounds for the complete pinned Twemoji subset', async () => {
    canvas()
    const directory = resolve('tests/fixtures/emoji')
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.svg'))) {
      const provider = createSvgEmojiOutlineProvider({
        text: () => glyph,
        resolve: () => Promise.resolve(readFileSync(resolve(directory, name), 'utf8')),
      })
      const outline = await provider(request('😀'), signal())
      expect(outline, name).not.toBeNull()
      expect(
        () => preprocessWindfoilOutlines([{ key: name, outline: outline! }]),
        name,
      ).not.toThrow()
    }
  })
})
