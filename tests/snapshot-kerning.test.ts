import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectDomSnapshot } from '../src/dom/snapshot.js'

interface Box {
  readonly left: number
  readonly width: number
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({ left, top, width, height }),
  }
}

/** Range boxes along one line, by the offset of each character in the block's text node. */
function installRangeBoxes(node: Text, boxes: readonly Box[]): void {
  const createRange = document.createRange.bind(document)
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => {
        const box = range.startContainer === node ? boxes[range.startOffset] : undefined
        return box ? domRect(box.left, 0, box.width, 340) : domRect(0, 0, 0, 0)
      },
    })
    return range
  })
}

/** Canvas stand-in: lone advances from a table, plus the pair kerning Canvas shapes in. */
function installCanvas(advances: Record<string, number>, kerning: Record<string, number>): void {
  const measure = (text: string) => {
    const characters = Array.from(text)
    let width = 0
    for (const [index, character] of characters.entries()) {
      width += advances[character] ?? 0
      if (index > 0) width += kerning[characters[index - 1]! + character] ?? 0
    }
    return width
  }
  const context = {
    font: '',
    letterSpacing: '0px',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: vi.fn((text: string) => ({
      width: measure(text),
      actualBoundingBoxAscent: 220,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 285,
      fontBoundingBoxDescent: 55,
    })),
  }
  // The capture measures kerning on an OffscreenCanvas, which a browser has and jsdom lacks.
  Object.defineProperty(window, 'OffscreenCanvas', {
    configurable: true,
    value: class {
      getContext() {
        return context
      }
    },
  })
}

function title(): { root: HTMLElement; text: Text } {
  const root = document.body.appendChild(document.createElement('section'))
  root.innerHTML =
    '<h1 data-sdf-block style="margin: 0; font: 700 300px/0.92 KernTest; letter-spacing: -9px; color: #fff">ULTRA</h1>'
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 1750, 340))
  const block = root.firstElementChild!
  vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 1750, 340))
  return { root, text: block.firstChild as Text }
}

const origins = (root: HTMLElement) =>
  collectDomSnapshot(root, { textSelector: 'h1', bakeSize: 64 }).glyphs.map((glyph) =>
    Number(glyph.originX.toFixed(1)),
  )

/** Lone advances of Helvetica Neue Bold at 300 px, as Chrome measured them. */
const ADVANCES = { U: 222.3, L: 177.9, T: 183.3, R: 216.6, A: 205.5 }

afterEach(() => {
  document.body.replaceChildren()
  Reflect.deleteProperty(window, 'OffscreenCanvas')
  vi.restoreAllMocks()
})

describe('Range capture of kerned pairs', () => {
  it('draws the second glyph of a split legacy kern where the browser draws it', () => {
    // Chrome 153 on macOS, Helvetica Neue Bold 300 px, letter-spacing -9 px: the L-T kerning
    // (-27.6) is split, -13.8 off the L's box and -13.8 off the T's, and the T's outline is
    // drawn a further 13.8 to the left of its box.
    const { root, text } = title()
    installRangeBoxes(text, [
      { left: 0, width: 213.3 },
      { left: 213.3, width: 155.1 },
      { left: 368.4, width: 160.5 },
      { left: 528.9, width: 207.6 },
      { left: 736.5, width: 196.5 },
    ])
    installCanvas(ADVANCES, { LT: -27.6 })
    expect(origins(root)).toEqual([0, 213.3, 354.6, 528.9, 736.5])
  })

  it('leaves a GPOS kern, which the boxes already show whole, where its box is', () => {
    const { root, text } = title()
    installRangeBoxes(text, [
      { left: 0, width: 213.3 },
      { left: 213.3, width: 141.3 },
      { left: 354.6, width: 174.3 },
      { left: 528.9, width: 207.6 },
      { left: 736.5, width: 196.5 },
    ])
    installCanvas(ADVANCES, { LT: -27.6 })
    expect(origins(root)).toEqual([0, 213.3, 354.6, 528.9, 736.5])
  })

  it('leaves text the page sets without kerning on its boxes, whatever Canvas kerns', () => {
    // `font-kerning: none`: the boxes show no kerning at all, while Canvas still kerns L-T.
    const { root, text } = title()
    installRangeBoxes(text, [
      { left: 0, width: 213.3 },
      { left: 213.3, width: 168.9 },
      { left: 382.2, width: 174.3 },
      { left: 556.5, width: 207.6 },
      { left: 764.1, width: 196.5 },
    ])
    installCanvas(ADVANCES, { LT: -27.6 })
    expect(origins(root)).toEqual([0, 213.3, 382.2, 556.5, 764.1])
  })

  it('leaves unkerned text on its boxes', () => {
    const { root, text } = title()
    installRangeBoxes(text, [
      { left: 0, width: 213.3 },
      { left: 213.3, width: 168.9 },
      { left: 382.2, width: 174.3 },
      { left: 556.5, width: 207.6 },
      { left: 764.1, width: 196.5 },
    ])
    installCanvas(ADVANCES, {})
    expect(origins(root)).toEqual([0, 213.3, 382.2, 556.5, 764.1])
  })
})
