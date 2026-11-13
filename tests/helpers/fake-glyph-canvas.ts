import { vi } from 'vitest'

/** A glyph of the fake font, in em units: x from the pen, Y up from the baseline. */
export interface FakeGlyph {
  /** Non-overlapping ink rectangles `[x0, y0, x1, y1]`. */
  readonly boxes: readonly (readonly [number, number, number, number])[]
  readonly advance: number
  /** Paints this colour whatever the fill, as a colour emoji does. */
  readonly color?: readonly [number, number, number]
  /** The ink box `measureText` reports instead of the boxes' own, as metrics that miss ink. */
  readonly reported?: readonly [number, number, number, number]
}

export interface FakeDraw {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly font: string
  readonly fill: string
  readonly rendering: string
  readonly stretch: string
  readonly kerning: string
}

export interface FakeGlyphCanvas {
  /** Every font string the canvas accepted, in order. */
  readonly fonts: string[]
  readonly draws: FakeDraw[]
  /** Called after each draw. */
  onDraw?: ((draw: FakeDraw) => void) | undefined
}

const SIZE = /([\d.]+)px/

/**
 * Replaces the 2D context of every canvas with a fake that draws `glyphs` as exact box-filtered
 * coverage. A font string `accepts` refuses leaves the previous font in place, as a canvas
 * does; resizing the canvas resets the context. The font box is `ascent` above and `descent`
 * below the baseline, rounded to whole pixels like Chrome's metrics.
 */
export function installFakeGlyphCanvas(
  glyphs: Readonly<Record<string, FakeGlyph>>,
  options: {
    readonly accepts?: (font: string) => boolean
    readonly ascent?: number
    readonly descent?: number
  } = {},
): FakeGlyphCanvas {
  const ascent = options.ascent ?? 1.07
  const descent = options.descent ?? 0.293
  const log: FakeGlyphCanvas = { fonts: [], draws: [] }
  const contextOf = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
    let width = -1
    let height = -1
    let pixels = new Uint8ClampedArray(0)
    const state = {
      font: '10px sans-serif',
      fillStyle: '#000000',
      textRendering: 'auto',
      fontStretch: 'normal',
      fontKerning: 'auto',
      textAlign: 'start',
      textBaseline: 'alphabetic',
    }
    const sync = (): void => {
      if (canvas.width === width && canvas.height === height) return
      width = canvas.width
      height = canvas.height
      pixels = new Uint8ClampedArray(width * height * 4)
      Object.assign(state, {
        font: '10px sans-serif',
        fillStyle: '#000000',
        textRendering: 'auto',
        fontStretch: 'normal',
        fontKerning: 'auto',
      })
    }
    const size = (): number => Number.parseFloat(SIZE.exec(state.font)?.[1] ?? '10')
    const context = {
      canvas,
      get font() {
        sync()
        return state.font
      },
      set font(value: string) {
        sync()
        if (value === '1px serif' || (options.accepts?.(value) ?? true)) {
          state.font = value
          log.fonts.push(value)
        }
      },
      get fillStyle() {
        return state.fillStyle
      },
      set fillStyle(value: string) {
        sync()
        // A canvas reads colours back in full: '#fff' is '#ffffff'.
        state.fillStyle = value.replace(/^#(\w)(\w)(\w)$/, '#$1$1$2$2$3$3')
      },
      get textRendering() {
        return state.textRendering
      },
      set textRendering(value: string) {
        sync()
        state.textRendering = value
      },
      get fontStretch() {
        return state.fontStretch
      },
      set fontStretch(value: string) {
        sync()
        state.fontStretch = value
      },
      get fontKerning() {
        return state.fontKerning
      },
      set fontKerning(value: string) {
        sync()
        state.fontKerning = value
      },
      textAlign: 'start',
      textBaseline: 'alphabetic',
      measureText(text: string) {
        sync()
        const glyph = glyphs[text] ?? { boxes: [], advance: 0.5 }
        const em = size()
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
        for (const box of glyph.boxes) {
          x0 = Math.min(x0, box[0])
          y0 = Math.min(y0, box[1])
          x1 = Math.max(x1, box[2])
          y1 = Math.max(y1, box[3])
        }
        if (glyph.reported) [x0, y0, x1, y1] = glyph.reported
        const ink = glyph.boxes.length > 0
        return {
          width: glyph.advance * em,
          actualBoundingBoxLeft: ink ? -x0 * em : 0,
          actualBoundingBoxRight: ink ? x1 * em : 0,
          actualBoundingBoxAscent: ink ? y1 * em : 0,
          actualBoundingBoxDescent: ink ? -y0 * em : 0,
          fontBoundingBoxAscent: Math.round(ascent * em),
          fontBoundingBoxDescent: Math.round(descent * em),
        }
      },
      clearRect(x: number, y: number, w: number, h: number) {
        sync()
        for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
          pixels.fill(
            0,
            (row * width + Math.max(0, x)) * 4,
            (row * width + Math.min(width, x + w)) * 4,
          )
        }
      },
      fillText(text: string, x: number, y: number) {
        sync()
        const draw = {
          text,
          x,
          y,
          font: state.font,
          fill: state.fillStyle,
          rendering: state.textRendering,
          stretch: state.fontStretch,
          kerning: state.fontKerning,
        }
        log.draws.push(draw)
        log.onDraw?.(draw)
        const glyph = glyphs[text]
        if (!glyph) return
        const em = size()
        const hex = Number.parseInt(state.fillStyle.slice(1), 16)
        const [r, g, b] = glyph.color ?? [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
        for (const [bx0, by0, bx1, by1] of glyph.boxes) {
          const left = x + bx0 * em
          const right = x + bx1 * em
          const top = y - by1 * em
          const bottom = y - by0 * em
          for (
            let row = Math.max(0, Math.floor(top));
            row < Math.min(height, Math.ceil(bottom));
            row++
          ) {
            const h = Math.min(row + 1, bottom) - Math.max(row, top)
            for (
              let column = Math.max(0, Math.floor(left));
              column < Math.min(width, Math.ceil(right));
              column++
            ) {
              const w = Math.min(column + 1, right) - Math.max(column, left)
              const at = (row * width + column) * 4
              const alpha = Math.min(255, pixels[at + 3]! + Math.round(w * h * 255))
              pixels.set([r, g, b, alpha], at)
            }
          }
        }
      },
      getImageData(x: number, y: number, w: number, h: number) {
        sync()
        const data = new Uint8ClampedArray(w * h * 4)
        for (let row = 0; row < h; row++) {
          data.set(
            pixels.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4),
            row * w * 4,
          )
        }
        return { data, width: w, height: h }
      },
    }
    return context as unknown as CanvasRenderingContext2D
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return contextOf(this)
  } as never)
  return log
}

/** Installs a `document.fonts` that records loads; restore it with the returned function. */
export function installFakeFonts(check: (font: string, text: string) => boolean = () => true): {
  readonly loads: (readonly [string, string])[]
  readonly fonts: {
    load: ReturnType<typeof vi.fn<(font: string, text: string) => Promise<FontFace[]>>>
    check: ReturnType<typeof vi.fn<(font: string, text: string) => boolean>>
  }
  restore(): void
} {
  const loads: (readonly [string, string])[] = []
  const fonts = {
    load: vi.fn((font: string, text: string): Promise<FontFace[]> => {
      loads.push([font, text])
      return Promise.resolve([])
    }),
    check: vi.fn(check),
  }
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  return {
    loads,
    fonts,
    restore() {
      Reflect.deleteProperty(document, 'fonts')
    },
  }
}
