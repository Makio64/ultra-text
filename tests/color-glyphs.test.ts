import { describe, expect, it } from 'vitest'
import { LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace } from 'three/webgpu'
import { createColorLayer, encodeColorBand } from '../src/atlas/colorGlyphs.js'
import { encodeColorBand as referenceColorBand } from './helpers/color-band-reference.js'

const pixels = (...values: number[][]) => new Uint8ClampedArray(values.flat())
const color = [40, 120, 220, 255]
const white = [255, 255, 255, 255]
const black = [0, 0, 0, 255]
const empty = [0, 0, 0, 0]
const slot = (x: number, width = 1) => ({ x, y: 0, width, height: 1 })

describe('encodeColorBand', () => {
  it('matches the full-queue reference across seeded noisy bands and ranges', () => {
    let seed = 42
    const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24
    for (let trial = 0; trial < 120; trial++) {
      const width = 1 + (random() % 37),
        height = 1 + (random() % 29)
      const white = Uint8ClampedArray.from({ length: width * height * 4 }, random)
      const black = Uint8ClampedArray.from(white, (value, index) =>
        index % 4 === 3 ? value : random() % 3 ? value : 0,
      )
      const slots = [{ x: 0, y: 0, width, height }]
      expect(encodeColorBand(white, black, width, height, trial % 41, slots)).toEqual(
        referenceColorBand(white, black, width, height, trial % 41, slots),
      )
    }
  })
  it('distinguishes foreground ink from chromatic, white, black and grayscale colour ink', () => {
    const input = pixels(white, color, white, black, [120, 120, 120, 255])
    const result = encodeColorBand(
      input,
      pixels(black, color, white, black, [120, 120, 120, 255]),
      5,
      1,
      0,
      [slot(0), slot(1), slot(2), slot(3), slot(4)],
    )
    expect(result.colored).toEqual([false, true, true, true, true])
    expect([...result.data]).toEqual([0, 0, 0, 0, ...color, ...white, ...black, 120, 120, 120, 255])
  })
  it('tolerates small read noise and rejects coverage below the SDF contour', () => {
    const result = encodeColorBand(
      pixels([252, 251, 253, 255], [42, 118, 218, 255], [40, 120, 220, 127]),
      pixels([2, 1, 3, 255], color, color),
      3,
      1,
      0,
      [slot(0), slot(1), slot(2)],
    )
    expect(result.colored).toEqual([false, true, false])
  })
  it('labels every empty texel by its nearest ink, without crossing row borders', () => {
    const W = pixels(color, empty, white, empty, empty, empty, empty, empty)
    const B = pixels(color, empty, black, empty, empty, empty, empty, empty)
    const result = encodeColorBand(W, B, 4, 2, 2, [slot(0), slot(2)])
    expect(result.colored).toEqual([true, false])
    // Colour carries its alpha on; foreground ink and what lies nearest to it stay clear.
    expect([...result.data.filter((_, index) => index % 4 === 3)]).toEqual([
      255, 255, 0, 0, 255, 255, 0, 0,
    ])
    // The end of one row and the start of the next are no neighbours: the texel under the
    // colour's row end is one step from the foreground ink and four from the colour.
    const row = pixels(empty, empty, empty, color, empty, white, empty, empty)
    const dark = pixels(empty, empty, empty, color, empty, black, empty, empty)
    expect([
      ...encodeColorBand(row, dark, 4, 2, 2, []).data.filter((_, index) => index % 4 === 3),
    ]).toEqual([0, 0, 255, 255, 0, 0, 0, 255])
  })
  it('reaches as far as the band, whatever the distance range, and halfway to other ink', () => {
    const W = new Uint8ClampedArray(40 * 4)
    W.set(color)
    W.set(white, 39 * 4)
    const B = W.slice()
    B.set(black, 39 * 4)
    const alpha = [...encodeColorBand(W, B, 40, 1, 2, []).data].filter((_, i) => i % 4 === 3)
    expect(alpha).toEqual([...Array<number>(20).fill(255), ...Array<number>(20).fill(0)])
    // Text that shares a slot with colour keeps its side free of that colour.
    const colours = [...encodeColorBand(W, B, 40, 1, 2, []).data.slice(0, 21 * 4)]
    expect(colours).toEqual([...Array.from({ length: 20 }, () => color).flat(), ...empty])
  })
  it('only classifies with a range of zero, or without colour ink', () => {
    const source = pixels(color, empty, empty)
    const classified = encodeColorBand(source, source, 3, 1, 0, [slot(0, 3)])
    expect(classified.colored).toEqual([true])
    expect([...classified.data]).toEqual([...color, ...empty, ...empty])
    const ink = encodeColorBand(pixels(white, empty), pixels(black, empty), 2, 1, 12, [slot(0, 2)])
    expect(ink.colored).toEqual([false])
    expect([...ink.data]).toEqual([...empty, ...empty])
  })
  it('preserves raster-order nearest-colour ties after removing interior seeds', () => {
    const red = [250, 20, 10, 255],
      blue = [10, 20, 250, 255]
    const source = pixels(red, red, empty, blue, blue)
    const result = encodeColorBand(source, source, 5, 1, 8, [slot(0, 5)])
    expect([...result.data]).toEqual([...red, ...red, ...red, ...blue, ...blue])
  })
  it('does not wrap dilation distance for ranges exceeding one byte', () => {
    const source = new Uint8ClampedArray(300 * 4)
    source.set(color)
    const result = encodeColorBand(source, source, 300, 1, 600, [slot(0, 300)])
    expect(result.colored).toEqual([true])
    for (let x = 0; x < 300; x++) expect([...result.data.slice(x * 4, x * 4 + 4)]).toEqual(color)
  })
  it('dilates observed ink independently of the slots used to report colour flags', () => {
    const source = pixels(color, empty, empty)
    expect([...encodeColorBand(source, source, 3, 1, 2, []).data]).toEqual([
      ...color,
      ...color,
      ...color,
    ])
  })
  it('keeps mixed runs premultiplied by binary colour weight', () => {
    const result = encodeColorBand(
      pixels(white, color, white),
      pixels(black, color, black),
      3,
      1,
      12,
      [slot(0, 3)],
    )
    expect(result.colored).toEqual([true])
    expect([...result.data]).toEqual([...empty, ...color, ...empty])
  })
})

describe('createColorLayer', () => {
  it('uses a top-origin sRGB RGBA texture with matching filtering and clamped anisotropy', () => {
    const band = { top: 4, height: 2, data: new Uint8Array(4 * 2 * 4) }
    const layer = createColorLayer(band, 4, { mipmaps: true, anisotropy: 8 }, 4)
    expect(layer.top).toBe(4)
    expect((layer.texture.image as { data: Uint8Array }).data).toBe(band.data)
    expect(layer.texture.colorSpace).toBe(SRGBColorSpace)
    expect(layer.texture.format).toBe(RGBAFormat)
    expect(layer.texture.flipY).toBe(false)
    expect(layer.texture.generateMipmaps).toBe(true)
    expect(layer.texture.minFilter).toBe(LinearMipmapLinearFilter)
    expect(layer.texture.anisotropy).toBe(4)
    expect(createColorLayer(band, 4, {}, 4).texture.minFilter).toBe(LinearFilter)
  })
})
