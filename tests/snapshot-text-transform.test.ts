import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectDomSnapshot } from '../src/dom/snapshot.js'
import {
  precedingCharacter,
  resolveTextTransform,
  transformClusters,
  transformText,
  type TextTransform,
} from '../src/dom/textTransform.js'

interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function domRect({ left, top, width, height }: Box): DOMRect {
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

function setBox(element: Element, box: Box): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(domRect(box))
}

/**
 * Range boxes indexed by DOM offsets, as the browser reports them under text-transform: a
 * source character's box covers whatever it is drawn as. Missing offsets collapse.
 */
function installRangeBoxes(boxes: ReadonlyMap<Text, readonly (Box | null)[]>): void {
  const createRange = document.createRange.bind(document)
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => {
        const node = range.startContainer
        const box = node instanceof Text ? boxes.get(node)?.[range.startOffset] : null
        return domRect(box ?? { left: 0, top: 0, width: 0, height: 0 })
      },
    })
    return range
  })
}

/** One 10-unit box per UTF-16 offset, continuing along a single line across text nodes. */
function installLine(nodes: readonly Text[], top = 0): void {
  let left = 0
  const boxes = new Map<Text, Box[]>()
  for (const node of nodes) {
    boxes.set(
      node,
      Array.from(node.data, () => {
        const box = { left, top, width: 10, height: 20 }
        left += 10
        return box
      }),
    )
  }
  installRangeBoxes(boxes)
}

/** Canvas stand-in whose advances come from a per-character table (10 by default). */
function canvasContext(advance: (character: string) => number = () => 10) {
  const context = {
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    wordSpacing: '0px',
    direction: 'inherit',
    measureText: vi.fn((text: string) => ({
      width: Array.from(text).reduce((sum, character) => sum + advance(character), 0),
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
    })),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
  return context
}

function block(html: string, style = ''): HTMLElement {
  const root = document.body.appendChild(document.createElement('section'))
  root.innerHTML = `<p data-sdf-block style="border: 0; padding: 0; font: 10px/20px TransformTest; color: #fff; ${style}">${html}</p>`
  setBox(root, { left: 0, top: 0, width: 400, height: 60 })
  setBox(root.firstElementChild!, { left: 0, top: 0, width: 400, height: 60 })
  return root
}

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, 4)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

const drawn = (snapshot: { readonly glyphs: readonly { readonly glyphKey: string }[] }) =>
  snapshot.glyphs.map(({ glyphKey }) => glyphKey.slice(glyphKey.lastIndexOf('\u0000') + 1))

function transform(value: string, lang?: string): TextTransform {
  const element = document.body.appendChild(document.createElement('span'))
  if (lang !== undefined) element.lang = lang
  return resolveTextTransform(value, element)!
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('text-transform mapping', () => {
  it('reads the computed value and Blink’s case-map language from lang', () => {
    const span = document.body.appendChild(document.createElement('span'))
    expect(resolveTextTransform('none', span)).toBeNull()
    // Neither is reproduced, so text under them stays as written.
    expect(resolveTextTransform('math-auto', span)).toBeNull()
    expect(resolveTextTransform('full-size-kana', span)).toBeNull()
    expect(transform('uppercase')).toEqual({ caseMap: 'uppercase', locale: '', fullWidth: false })
    expect(transform('lowercase', 'tr-TR').locale).toBe('tr')
    expect(transform('uppercase', 'EL').locale).toBe('el')
    expect(transform('uppercase', 'az_Latn').locale).toBe('az')
    expect(transform('uppercase', 'tra').locale).toBe('')
    expect(transform('uppercase', 'en').locale).toBe('')
    // Capitalize ignores language in Chrome: Turkish "istanbul" becomes "Istanbul".
    expect(transform('capitalize', 'tr').locale).toBe('')
    expect(transform('capitalize full-width full-size-kana')).toEqual({
      caseMap: 'capitalize',
      locale: '',
      fullWidth: true,
    })
  })

  it('maps case like Chrome, including language and context rules', () => {
    expect(transformText('istanbul', transform('uppercase'))).toBe('ISTANBUL')
    expect(transformText('istanbul', transform('uppercase', 'tr'))).toBe('İSTANBUL')
    expect(transformText('IŞIK', transform('lowercase', 'tr'))).toBe('ışık')
    expect(transformText('ΟΔΟΣ ΟΔΟΣ', transform('lowercase'))).toBe('οδος οδος')
    // Chrome 153 renders this `lang="el"` uppercase as ΑΛΦΑ Ή ΜΑΪΟΥ ΑΝ.
    expect(transformText('άλφα ή Μαΐου α\u{301}ν', transform('uppercase', 'el'))).toBe(
      'ΑΛΦΑ Ή ΜΑΪΟΥ ΑΝ',
    )
    expect(transformText('straße ﬁx ŉ', transform('uppercase'))).toBe('STRASSE FIX ʼN')
  })

  it('capitalizes word-break segments like Chrome', () => {
    const capitalize = transform('capitalize')
    // Strings and results observed in Chrome 153.
    expect(
      transformText(
        "hello-world don't o'neil 3d _x (paren) ǆemal ßa ﬁsh ᾳb ⅰx ǅx Ǆx გამარჯობა",
        capitalize,
      ),
    ).toBe("Hello-World Don't O'neil 3d _x (Paren) ǅemal ßa ﬁsh ᾼb Ⅰx ǅx ǅx გამარჯობა")
    expect(transformText('\u{1E922}x \u{10428}x a\u{a0}b a\u{2009}c 1st x2y', capitalize)).toBe(
      '\u{1E922}x \u{10428}x A\u{a0}B A\u{2009}C 1st X2y',
    )
    // The preceding character decides whether the text starts a word.
    expect(transformText('rld', capitalize, 'o')).toBe('rld')
    expect(transformText('rld', capitalize, ' ')).toBe('Rld')
    expect(transformText('rld', capitalize, '-')).toBe('Rld')
  })

  it('widens characters for full-width', () => {
    expect(transformText('Ab1! ¥₩ ｶﾀｶﾅ', transform('full-width'))).toBe('Ａｂ１！ ￥￦ カタカナ')
    expect(transformText('ab', transform('uppercase full-width'))).toBe('ＡＢ')
    // A keycap's base keeps the emoji sequence intact.
    expect(transformText('#\u{fe0f}\u{20e3} 1\u{20e3}', transform('full-width'))).toBe(
      '#\u{fe0f}\u{20e3} 1\u{20e3}',
    )
  })

  it('shares the transformed text out to the source clusters', () => {
    const uppercase = transform('uppercase')
    expect(transformClusters('ABC 1', uppercase)).toBeUndefined()
    expect(transformClusters('abc', uppercase)).toEqual(['A', 'B', 'C'])
    // An expansion keeps every character in its source cluster's share.
    expect(transformClusters('straße', uppercase)).toEqual(['S', 'T', 'R', 'A', 'SS', 'E'])
    expect(transformClusters('a👍🏽ß', uppercase)).toEqual(['A', '👍🏽', 'SS'])
    // Context-dependent rules survive a length change elsewhere in the node.
    expect(transformClusters('ΣΑΣ İ', transform('lowercase'))).toEqual([
      'σ',
      'α',
      'ς',
      ' ',
      'i\u{307}',
    ])
    // Marks the mapping absorbs get empty shares.
    expect(transformClusters('α\u{301}ν', transform('uppercase', 'el'))).toEqual(['Α', '', 'Ν'])
    expect(transformClusters('I\u{307}x', transform('lowercase', 'tr'))).toEqual(['i', '', 'x'])
    expect(transformClusters('hi there', transform('capitalize'), 'x')).toEqual([
      'h',
      'i',
      ' ',
      'T',
      'h',
      'e',
      'r',
      'e',
    ])
  })

  it('maps clusters one at a time when the shares do not line up', () => {
    // Lithuanian inserts a dot before the grave, which no single source character owns.
    expect(transformText('I\u{300}x', transform('lowercase', 'lt'))).toBe('i\u{307}\u{300}x')
    expect(transformClusters('I\u{300}x', transform('lowercase', 'lt'))).toEqual([
      'i',
      '\u{300}',
      'x',
    ])
  })

  it('reads the character before a text node as Blink’s capitalize does', () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.innerHTML =
      '<p id="a"><b>wo</b>rld foo<br>bar</p>' +
      '<p id="b">bar<span style="display: inline-block">baz</span>qux</p>' +
      '<div id="c"><div>hello</div>world</div>' +
      '<p id="d">ab<span style="display: contents">cd</span>' +
      '<span style="display: none">zz</span>ef<img>gh<span></span>ij' +
      '<span style="display: inline-block"></span>kl</p>'
    const style = (element: Element) => getComputedStyle(element)
    const seed = (id: string, text: string) =>
      precedingCharacter(
        textNodes(document.getElementById(id)!).find((node) => node.data === text)!,
        style,
      )
    expect(seed('a', 'wo')).toBe(' ')
    expect(seed('a', 'rld foo')).toBe('o')
    expect(seed('a', 'bar')).toBe(' ')
    // An inline-block starts its own line box, yet Blink reads back into it.
    expect(seed('b', 'baz')).toBe(' ')
    expect(seed('b', 'qux')).toBe('z')
    expect(seed('c', 'world')).toBe(' ')
    expect(seed('d', 'cd')).toBe('b')
    expect(seed('d', 'ef')).toBe('d')
    expect(seed('d', 'gh')).toBe(' ')
    expect(seed('d', 'ij')).toBe('h')
    expect(seed('d', 'kl')).toBe(' ')
  })

  it('seeds capitalize with the last UTF-16 unit, so an astral letter ends a word at a boundary', () => {
    const root = document.body.appendChild(document.createElement('p'))
    root.innerHTML = '\u{1d400}<b>bc</b> \u{1d400}bc'
    const [first, second] = textNodes(root)
    const seed = precedingCharacter(second!, (element) => getComputedStyle(element))
    expect(seed).toBe(first!.data.slice(-1))
    const capitalize = transform('capitalize')
    // Chrome draws 𝐀Bc across the markup and 𝐀bc inside one text node.
    expect(transformText('bc', capitalize, seed)).toBe('Bc')
    expect(transformText('\u{1d400}bc', capitalize)).toBe('\u{1d400}bc')
  })
})

describe('text-transform capture', () => {
  it('draws the transformed characters at their Range boxes', () => {
    // The gallery's stair-poem caption: uppercase CSS over mixed-case source.
    const root = block(
      '<cite style="text-transform: uppercase; letter-spacing: 0.14em">SDF &amp; Windfoil · Two</cite>',
    )
    const [node] = textNodes(root)
    installLine([node!])
    const setStart = vi.spyOn(Range.prototype, 'setStart')

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(drawn(snapshot).join('')).toBe('SDF&WINDFOIL·TWO')
    expect(
      snapshot.requests
        .map(({ character }) => character)
        .sort()
        .join(''),
    ).toBe('&DFILNOSTW·')
    // Offsets still index the DOM text, which kept its source case.
    expect(node!.data).toBe('SDF & Windfoil · Two')
    expect(setStart.mock.calls.map(([, offset]) => offset)).toEqual([
      0, 1, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18, 19,
    ])
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([
      0, 10, 20, 40, 60, 70, 80, 90, 100, 110, 120, 130, 150, 170, 180, 190,
    ])
  })

  it('places expansions inside their source character’s box by advance', () => {
    const root = block('<span style="text-transform: uppercase">Straße ﬁx</span>')
    const [node] = textNodes(root)
    const box = (left: number, width: number) => ({ left, top: 0, width, height: 20 })
    installRangeBoxes(
      new Map([
        [
          node!,
          [
            box(0, 10),
            box(10, 10),
            box(20, 10),
            box(30, 10),
            box(40, 20), // ß draws SS
            box(60, 10),
            box(70, 5),
            box(75, 16), // ﬁ draws FI
            box(91, 10),
          ],
        ],
      ]),
    )
    canvasContext((character) => (character === 'F' ? 6 : character === 'I' ? 2 : 10))
    const setStart = vi.spyOn(Range.prototype, 'setStart')

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(drawn(snapshot)).toEqual(['S', 'T', 'R', 'A', 'S', 'S', 'E', 'F', 'I', 'X'])
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 75, 87, 91,
    ])
    // E's advance runs to the next origin, across the space, as every Range advance does.
    expect(snapshot.glyphs.map(({ advance }) => advance)).toEqual([
      10, 10, 10, 10, 10, 10, 15, 12, 4, 10,
    ])
    // Requests stay single characters, shared with the rest of the text.
    expect(snapshot.requests.map(({ character }) => character).sort()).toEqual([
      'A',
      'E',
      'F',
      'I',
      'R',
      'S',
      'T',
      'X',
    ])
    // Each source character is read once, however many glyphs it draws.
    expect(setStart.mock.calls.map(([, offset]) => offset)).toEqual([0, 1, 2, 3, 4, 5, 7, 8])
  })

  it('splits expansions evenly without Canvas and anchors their marks', () => {
    const root = block('<span style="text-transform: uppercase">ßǰ</span>')
    const [node] = textNodes(root)
    installRangeBoxes(
      new Map([
        [
          node!,
          [
            { left: 0, top: 0, width: 20, height: 20 },
            { left: 20, top: 0, width: 8, height: 20 },
          ],
        ],
      ]),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    // ǰ uppercases to J + combining caron, which anchors over the J.
    expect(drawn(snapshot)).toEqual(['S', 'S', 'J', '\u{30c}'])
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([0, 10, 20, 28])
    expect(snapshot.glyphs.map(({ advance }) => advance)).toEqual([10, 10, 8, 0])
  })

  it('drops marks a language-sensitive mapping absorbs and expands İ to i and a dot', () => {
    const root = block(
      '<span lang="el" style="text-transform: uppercase">α\u{301}ν</span> ' +
        '<span style="text-transform: lowercase">İX</span>',
    )
    const [greek, , dotted] = textNodes(root)
    const box = (left: number) => ({ left, top: 0, width: 10, height: 20 })
    installRangeBoxes(
      new Map([
        [greek!, [box(0), null, box(10)]],
        [dotted!, [box(30), box(40)]],
      ]),
    )
    canvasContext()

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(drawn(snapshot)).toEqual(['Α', 'Ν', 'i', '\u{307}', 'x'])
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([0, 10, 30, 40, 40])
  })

  it('continues capitalized words across inline markup but not across breaks', () => {
    const root = block('<b>wo</b>rld foo<br>bar', 'text-transform: capitalize')
    const nodes = textNodes(root)
    installLine(nodes)

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(drawn(snapshot).join('')).toBe('WorldFooBar')
  })

  it('follows a full-width transform where the browser computes one', () => {
    const root = block('<span style="text-transform: full-width">Ab 1</span>')
    installLine(textNodes(root))

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(drawn(snapshot)).toEqual(['Ａ', 'ｂ', '１'])
  })

  it('hands reshape the transformed text and checks its boundaries against it', () => {
    const root = block('<span style="text-transform: uppercase">aßa</span>')
    installLine(textNodes(root))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const reshape = vi.fn((text: string) => text.replace(/A/gu, 'Ä'))

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false, reshape })

    expect(reshape).toHaveBeenCalledWith('ASSA')
    expect(drawn(snapshot)).toEqual(['Ä', 'S', 'S', 'Ä'])
    expect(() =>
      collectDomSnapshot(root, { includeRootBackground: false, reshape: (text) => text + 'x' }),
    ).toThrow('preserve code point boundaries and whitespace')
  })

  it('lays out the transformed text with Pretext', async () => {
    const root = block(
      '<span style="text-transform: uppercase">straße</span> <i>wo</i>rld',
      'text-transform: capitalize',
    )
    const context = canvasContext((character) => (character === 'S' ? 12 : 10))

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })

    expect(drawn(snapshot).join('')).toBe('STRASSEWorld')
    // Each S of the expansion is measured as its own glyph, and E's advance runs to the next
    // origin, across the space, as it does under Range.
    expect(snapshot.glyphs.slice(0, 7).map(({ advance }) => advance)).toEqual([
      12, 10, 10, 10, 12, 12, 20,
    ])
    expect(context.measureText.mock.calls.some(([text]) => text.includes('ß'))).toBe(false)
  })

  it('shapes browser runs from the transformed text', async () => {
    const root = block(
      '<span style="text-transform: uppercase">straße</span> ' +
        '<span style="color: rgb(255, 0, 0)">wo</span>rld',
      'text-transform: capitalize',
    )
    installLine(textNodes(root))
    canvasContext()

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      textShaping: 'browser',
    })

    expect(snapshot.requests.map(({ character }) => character)).toEqual(
      expect.arrayContaining(['STRASSE', 'Wo', 'rld']),
    )
    expect(snapshot.requests.some(({ character }) => /ß|straße/u.test(character))).toBe(false)
  })

  it('maps each text node of a browser run on its own, as Blink does', async () => {
    // Chrome draws οδοσ οδος: the lone Σ in its own node is not a final sigma.
    const sigma = block('ΟΔΟ<span>Σ</span> ΟΔΟΣ', 'text-transform: lowercase')
    installLine(textNodes(sigma))
    canvasContext()
    const lower = await collectDomSnapshot(sigma, {
      includeRootBackground: false,
      textShaping: 'browser',
    })
    expect(lower.requests.map(({ character }) => character)).toEqual(['οδοσ οδος'])
    vi.restoreAllMocks()

    // Chrome draws BarBazqux: an inline-block starts a word, the text after it continues one.
    const boxed = block(
      'bar<span style="display: inline-block">baz</span>qux',
      'text-transform: capitalize',
    )
    installLine(textNodes(boxed))
    canvasContext()
    const capitalized = await collectDomSnapshot(boxed, {
      includeRootBackground: false,
      textShaping: 'browser',
    })
    expect(capitalized.requests.map(({ character }) => character).join('')).toBe('BarBazqux')
  })
})
