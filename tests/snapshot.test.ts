import { afterEach, describe, expect, it, vi } from 'vitest'

import { layoutSignatureOf } from '../src/dom/layoutSignature.js'
import { collectDomSnapshot, physicalAlign } from '../src/dom/snapshot.js'
import { reflowSnapshot } from '../src/text/reflow.js'

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

function installRangeLayout(layout: ReadonlyMap<Text, Box>): void {
  const createRange = document.createRange.bind(document)
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => {
        const node = range.startContainer
        if (!(node instanceof Text)) return domRect({ left: 0, top: 0, width: 0, height: 0 })
        const box = layout.get(node)
        if (!box) return domRect({ left: 0, top: 0, width: 0, height: 0 })
        const characterWidth = box.width / Math.max(1, node.data.length)
        return domRect({
          left: box.left + range.startOffset * characterWidth,
          top: box.top,
          width: (range.endOffset - range.startOffset) * characterWidth,
          height: box.height,
        })
      },
    })
    return range
  })
}

function textNode(selector: string): Text {
  const node = document.querySelector(selector)?.firstChild
  if (!(node instanceof Text)) throw new Error(`Expected a text node at ${selector}`)
  return node
}

/** Like installRangeLayout, but with an explicit box (or null) per character offset. */
function installPerCharacterLayout(boxes: ReadonlyMap<Text, readonly (Box | null)[]>): void {
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

function pretextContext(): CanvasRenderingContext2D {
  return {
    canvas: { lang: '' },
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({
      width: Array.from(text).length * 10,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
    }),
  } as unknown as CanvasRenderingContext2D
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('collectDomSnapshot', () => {
  it.each(['', 'overflow: visible'])(
    'keeps tight-line descenders inside the finite glyph clip (%s)',
    (overflow) => {
      const root = document.body.appendChild(document.createElement('section'))
      root.innerHTML = `<h1 data-sdf-block style="font: 28px/18px Arial; ${overflow}">pgyjq</h1>`
      const block = root.firstElementChild!
      setBox(root, { left: 10, top: 20, width: 200, height: 100 })
      setBox(block, { left: 30, top: 40, width: 80, height: 18 })
      installRangeLayout(
        new Map([[block.firstChild as Text, { left: 28, top: 36, width: 84, height: 28 }]]),
      )

      const snapshot = collectDomSnapshot(root, { includeRootBackground: false, pixelsPerUnit: 2 })

      expect(snapshot.blocks[0]).toMatchObject({ left: 10, width: 40, clip: [10, 31, 50, 40] })
      expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual([
        'p',
        'g',
        'y',
        'j',
        'q',
      ])
      expect(snapshot.glyphs[0]).toMatchObject({ originX: 9, lineBottom: 28, fontSize: 14 })
      for (const glyph of snapshot.glyphs) {
        expect(glyph.clip).toEqual([9, 28, 51, 42])
        expect(glyph.clip).toBe(snapshot.glyphs[0]!.clip)
        expect(glyph.clip.every(Number.isFinite)).toBe(true)
        expect(glyph.lineBottom).toBe(28)
        expect(glyph.advance).toBeCloseTo(8.4)
      }
    },
  )

  it('unions every line text box without changing tight multiline block metrics', () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<h1 data-sdf-block style="font: 28px/18px Arial"><span>pgy</span><br><span>jq</span></h1>'
    const block = root.firstElementChild!
    const spans = block.querySelectorAll('span')
    setBox(root, { left: 10, top: 20, width: 200, height: 100 })
    setBox(block, { left: 30, top: 40, width: 80, height: 36 })
    installRangeLayout(
      new Map([
        [spans[0]!.firstChild as Text, { left: 28, top: 36, width: 60, height: 28 }],
        [spans[1]!.firstChild as Text, { left: 32, top: 54, width: 84, height: 28 }],
      ]),
    )

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false, pixelsPerUnit: 2 })

    expect(snapshot.lineCount).toBe(2)
    expect(snapshot.blocks[0]).toMatchObject({
      left: 10,
      width: 40,
      firstBaseline: 28,
      linePitch: 9,
      clip: [10, 22, 50, 40],
    })
    expect(snapshot.glyphs[0]).toMatchObject({ originX: 9, lineBottom: 28 })
    expect(snapshot.glyphs[3]).toMatchObject({ originX: 11, lineBottom: 19 })
    for (const glyph of snapshot.glyphs) {
      expect(glyph.clip).toEqual([9, 19, 53, 42])
      expect(glyph.clip).toBe(snapshot.glyphs[0]!.clip)
    }
  })

  it.each([
    ['overflow: hidden', [10, 31, 50, 40]],
    ['overflow: clip', [10, 31, 50, 40]],
    ['overflow: scroll', [10, 31, 50, 40]],
    ['overflow: auto', [10, 31, 50, 40]],
    ['overflow-x: clip; overflow-y: visible', [10, 28, 50, 42]],
    ['overflow-x: visible; overflow-y: clip', [9, 31, 51, 40]],
  ])('preserves explicit block overflow clipping (%s)', (overflow, expected) => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = `<h1 data-sdf-block style="font: 28px/18px Arial; ${overflow}">pgyjq</h1>`
    const block = root.firstElementChild! as HTMLElement
    // jsdom does not expand the overflow shorthand into the browser's computed longhands.
    if (block.style.overflow) {
      block.style.overflowX = block.style.overflow
      block.style.overflowY = block.style.overflow
    }
    setBox(root, { left: 10, top: 20, width: 200, height: 100 })
    setBox(block, { left: 30, top: 40, width: 80, height: 18 })
    installRangeLayout(
      new Map([[block.firstChild as Text, { left: 28, top: 36, width: 84, height: 28 }]]),
    )

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false, pixelsPerUnit: 2 })

    expect(snapshot.blocks[0]!.clip).toEqual([10, 31, 50, 40])
    expect(snapshot.glyphs[0]).toMatchObject({ originX: 9, lineBottom: 28, clip: expected })
  })

  it('includes browser-shaped text boxes outside a tight line without moving its baseline', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = '<h1 data-sdf-block style="font: 28px/18px Arial">pgyjq</h1>'
    const block = root.firstElementChild!
    setBox(root, { left: 10, top: 20, width: 200, height: 100 })
    setBox(block, { left: 30, top: 40, width: 80, height: 18 })
    installRangeLayout(
      new Map([[block.firstChild as Text, { left: 28, top: 36, width: 84, height: 28 }]]),
    )

    const snapshot = await collectDomSnapshot(root, {
      textShaping: 'browser',
      includeRootBackground: false,
      pixelsPerUnit: 2,
    })

    expect(snapshot.glyphs).toHaveLength(1)
    expect(snapshot.glyphs[0]).toMatchObject({
      originX: 9,
      lineBottom: 28,
      baselineOffset: 1,
      clip: [9, 28, 51, 42],
    })
    expect(snapshot.blocks[0]).toMatchObject({ left: 10, width: 40, clip: [10, 31, 50, 40] })
  })

  it('includes Pretext font boxes outside a tight line without changing layout bounds', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<h1 data-sdf-block style="border: 0; padding: 0; font: 10px/6px PretextDescenderTest">pgyjq</h1>'
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 100, height: 60 })
    setBox(block, { left: 10, top: 10, width: 50, height: 6 })

    const snapshot = await collectDomSnapshot(root, {
      layoutEngine: 'pretext',
      includeRootBackground: false,
      pixelsPerUnit: 2,
    })

    expect(snapshot.lineCount).toBe(1)
    expect(snapshot.blocks[0]).toMatchObject({ left: 5, width: 25, clip: [5, 22, 30, 25] })
    expect(snapshot.glyphs[0]).toMatchObject({
      originX: 5,
      lineBottom: 21,
      baselineOffset: 1,
      clip: [5, 21, 30, 26],
    })
  })

  it('keeps revisited line sequences and combining marks independent between overlapping blocks', () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = '<p data-sdf-block>AB́C</p><p data-sdf-block>AB́C</p>'
    setBox(root, { left: 0, top: 0, width: 100, height: 60 })
    const boxes = new Map<Text, readonly (Box | null)[]>()
    for (const block of root.children) {
      setBox(block, { left: 0, top: 0, width: 100, height: 60 })
      boxes.set(block.firstChild as Text, [
        { left: 0, top: 0, width: 10, height: 20 },
        { left: 0, top: 24, width: 10, height: 20 },
        null,
        { left: 10, top: 0, width: 10, height: 20 },
      ])
    }
    installPerCharacterLayout(boxes)
    const capture = collectDomSnapshot(root, { includeRootBackground: false })
    expect(capture.lineCount).toBe(4)
    expect(capture.glyphs.map(({ sequence }) => sequence)).toEqual([0, 0, 1, 1, 0, 0, 1, 1])
    expect(capture.glyphs.map(({ block }) => block)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    expect(capture.glyphs[2]).toMatchObject({ advance: 0, originX: 10, lineBottom: 16 })
  })

  it('skips whitespace Range writes without losing UTF-16 positions or soft breaks', () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.dataset['sdfBlock'] = ''
    root.textContent = ' \tA\n😀\u00a0B '
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    installRangeLayout(
      new Map([[root.firstChild as Text, { left: 0, top: 0, width: 90, height: 20 }]]),
    )
    const setStart = vi.spyOn(Range.prototype, 'setStart')
    const setEnd = vi.spyOn(Range.prototype, 'setEnd')
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([20, 40, 70])
    // The no-break space before 'B' draws nothing either, but joins it to the emoji.
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual(['soft', 'soft', 'none'])
    expect(setStart.mock.calls.map(([, offset]) => offset)).toEqual([2, 4, 7])
    expect(setEnd.mock.calls.map(([, offset]) => offset)).toEqual([3, 6, 8])
  })

  it('does not measure descendants of display:none and reads them again after revealing', () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.dataset['sdfBlock'] = ''
    root.innerHTML = '<span style="display: none"><b>Hidden</b></span><i>V</i>'
    const hidden = root.querySelector('span')!
    const hiddenText = root.querySelector('b')!.firstChild as Text
    const visibleText = root.querySelector('i')!.firstChild as Text
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    installRangeLayout(
      new Map([
        [hiddenText, { left: 0, top: 0, width: 60, height: 20 }],
        [visibleText, { left: 60, top: 0, width: 10, height: 20 }],
      ]),
    )
    const setStart = vi.spyOn(Range.prototype, 'setStart')
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.glyphs).toHaveLength(1)
    expect(setStart.mock.calls.map(([node]) => node)).toEqual([visibleText])
    hidden.style.display = 'inline'
    expect(collectDomSnapshot(root, { includeRootBackground: false }).glyphs).toHaveLength(7)
  })

  it('shares font metrics within a capture and refreshes them after fonts or CSS change', () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.dataset['sdfBlock'] = ''
    root.style.cssText = 'font: 20px/24px Arial; text-decoration-line: overline; opacity: .5'
    root.innerHTML = '<span>A</span><span>B</span><b style="font-size: 40px">C</b>'
    setBox(root, { left: 0, top: 0, width: 200, height: 50 })
    installRangeLayout(
      new Map(
        Array.from(root.children, (element, index) => [
          element.firstChild as Text,
          { left: index * 20, top: 0, width: 20, height: 40 },
        ]),
      ),
    )
    const context = pretextContext()
    let metricScale = 1
    const measure = vi.fn(() => {
      const size = context.font.includes('40px') ? 40 : 20
      return {
        width: size,
        fontBoundingBoxAscent: size * 0.8 * metricScale,
        fontBoundingBoxDescent: size * 0.2 * metricScale,
      } as TextMetrics
    })
    context.measureText = measure
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    const first = collectDomSnapshot(root, { includeRootBackground: false })
    expect(measure).toHaveBeenCalledTimes(2)
    expect(first.glyphs.map((glyph) => glyph.decorations?.[0]?.offset)).toEqual([20, 20, 40])
    expect(first.glyphs.map((glyph) => glyph.color[3])).toEqual([0.5, 0.5, 0.5])
    metricScale = 2
    root.style.opacity = '1'
    root.style.textDecorationColor = 'rgb(255, 0, 0)'
    const second = collectDomSnapshot(root, { includeRootBackground: false })
    expect(measure).toHaveBeenCalledTimes(4)
    expect(second.glyphs.map((glyph) => glyph.decorations?.[0]?.offset)).toEqual([40, 40, 80])
    expect(second.glyphs.map((glyph) => glyph.decorations?.[0]?.color)).toEqual([
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
    ])
    expect(first.glyphs[0]!.decorations?.[0]?.offset).toBe(20)
  })

  it('does not allocate browser shaping helpers when there are no text blocks', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    const createRange = vi.spyOn(document, 'createRange')
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    const snapshot = await collectDomSnapshot(root, {
      textShaping: 'browser',
      includeRootBackground: false,
    })
    expect(snapshot.glyphs).toEqual([])
    expect(createRange).not.toHaveBeenCalled()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('shares browser shaping helpers and keys descent measurements by size and text per capture', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 16px Arial; color: rgb(0, 0, 0)'
    root.innerHTML =
      '<p data-sdf-block>A</p><p data-sdf-block>A</p>' +
      '<p data-sdf-block style="font-size: 32px">A</p><p data-sdf-block>漢</p>'
    setBox(root, { left: 10, top: 20, width: 200, height: 160 })
    const boxes = new Map<Text, Box>()
    for (const [index, block] of Array.from(root.children).entries()) {
      const box = { left: 10, top: 20 + index * 40, width: 100, height: 40 }
      setBox(block, box)
      boxes.set(block.firstChild as Text, box)
    }
    installRangeLayout(boxes)
    const createRange = vi.spyOn(document, 'createRange')
    const canvas = pretextContext()
    let metricScale = 1
    const measure = vi.fn((text: string) => ({
      fontBoundingBoxDescent:
        (text === '漢' ? 5 : canvas.font.includes('32px') ? 4 : 2) * metricScale,
    }))
    canvas.measureText = measure as unknown as typeof canvas.measureText
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas)
    const first = await collectDomSnapshot(root, {
      textShaping: 'browser',
      includeRootBackground: false,
      pixelsPerUnit: 2,
    })
    expect(first.glyphs.map(({ baselineOffset }) => baselineOffset)).toEqual([1, 1, 2, 2.5])
    expect(measure).toHaveBeenCalledTimes(3)
    expect(getContext).toHaveBeenCalledTimes(1)
    expect(createRange).toHaveBeenCalledTimes(1)

    metricScale = 2 // A newly loaded fallback font must invalidate all measured descents.
    const second = await collectDomSnapshot(root, {
      textShaping: 'browser',
      includeRootBackground: false,
      pixelsPerUnit: 2,
    })
    expect(second.glyphs.map(({ baselineOffset }) => baselineOffset)).toEqual([2, 2, 4, 5])
    expect(first.glyphs.map(({ baselineOffset }) => baselineOffset)).toEqual([1, 1, 2, 2.5])
    expect(measure).toHaveBeenCalledTimes(6)
    expect(getContext).toHaveBeenCalledTimes(2)
    expect(createRange).toHaveBeenCalledTimes(2)
  })

  it('keeps browser shaping opt-in and includes shaping state in retained keys', async () => {
    const canvas = pretextContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas)
    const root = document.body.appendChild(document.createElement('div'))
    root.setAttribute('data-sdf-block', '')
    root.style.cssText = 'font: 16px Arial; color: white; direction: rtl; letter-spacing: 2px'
    root.lang = 'ar'
    root.textContent = 'سلام'
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    installRangeLayout(
      new Map([[root.firstChild as Text, { left: 40, top: 0, width: 40, height: 20 }]]),
    )
    const plain = collectDomSnapshot(root)
    expect(plain).not.toBeInstanceOf(Promise)
    expect(plain.glyphs).toHaveLength(4)
    expect(plain.textShaping).toBeUndefined()
    expect(collectDomSnapshot(root, { textShaping: 'none' })).toEqual(plain)
    const pending = collectDomSnapshot(root, { textShaping: 'browser' })
    expect(pending).toBeInstanceOf(Promise)
    const shaped = await pending
    expect(shaped.glyphs).toHaveLength(1)
    expect(shaped.glyphs[0]!.baselineOffset).toBe(2)
    expect(canvas.font).toContain('16px')
    expect(shaped.requests[0]).toMatchObject({
      character: 'سلام',
      shaping: { direction: 'rtl', language: 'ar', letterSpacing: 0.125, wordSpacing: 0 },
    })
    root.lang = 'fa'
    const persian = await collectDomSnapshot(root, { textShaping: 'browser' })
    expect(persian.atlasSignature).not.toBe(shaped.atlasSignature)
    root.style.direction = 'ltr'
    const ltr = await collectDomSnapshot(root, { textShaping: 'browser' })
    expect(ltr.atlasSignature).not.toBe(persian.atlasSignature)
  })

  it('rejects incompatible browser shaping options and propagates cancellation', async () => {
    const root = document.body.appendChild(document.createElement('div'))
    root.setAttribute('data-sdf-block', '')
    root.textContent = 'text'
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    for (const options of [
      { layoutEngine: 'pretext' as const },
      { reshape: (text: string) => text },
    ]) {
      await expect(
        collectDomSnapshot(root, { ...options, textShaping: 'browser' }),
      ).rejects.toThrow('requires Range')
    }
    await expect(
      collectDomSnapshot(root, { textShaping: 'browser', textBackend: 'windfoil' }),
    ).rejects.toThrow('requires SDF')
    const controller = new AbortController()
    const reason = new Error('capture cancelled')
    controller.abort(reason)
    await expect(
      collectDomSnapshot(root, { textShaping: 'browser', signal: controller.signal }),
    ).rejects.toBe(reason)
  })

  it('captures inherited solid decorations with CSS color, thickness, and underline offset', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block style="font: 20px/24px serif; text-decoration-line: underline overline line-through; text-decoration-style: solid; text-decoration-color: rgb(255, 0, 0); text-decoration-thickness: 2px; text-underline-offset: 3px"><span style="font: 20px/24px serif; text-decoration-line: none">AB</span></p>'
    document.body.append(root)
    const block = root.querySelector('p')!
    const span = root.querySelector('span')!
    setBox(root, { left: 0, top: 0, width: 100, height: 60 })
    setBox(block, { left: 0, top: 0, width: 100, height: 40 })
    installRangeLayout(
      new Map([[span.firstChild as Text, { left: 0, top: 10, width: 40, height: 20 }]]),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const snapshot = collectDomSnapshot(root, { pixelsPerUnit: 2, includeRootBackground: false })
    expect(snapshot.glyphs[0]!.decorationWidth).toBe(10)
    expect(snapshot.glyphs[0]!.decorations).toEqual([
      { line: 'underline', color: [1, 0, 0, 1], thickness: 1, offset: -0.5 },
      { line: 'overline', color: [1, 0, 0, 1], thickness: 1, offset: 5 },
      { line: 'line-through', color: [1, 0, 0, 1], thickness: 1, offset: 4 },
    ])
    expect(snapshot.glyphs[1]!.decorations).toBe(snapshot.glyphs[0]!.decorations)
    block.setAttribute('style', 'text-decoration-line: underline; text-decoration-style: wavy')
    expect(collectDomSnapshot(root).glyphs[0]!.decorations).toBeUndefined()
  })

  it('uses Pretext without creating a DOM Range when requested', async () => {
    const root = document.createElement('section')
    // Keep the mocked content box explicit: jsdom 30 reports nonzero default border widths.
    root.innerHTML =
      '<p data-sdf-block style="border: 0; font: 10px/12px PretextTest; color: rgb(255, 255, 255); text-decoration-line: underline">AB CD</p>'
    document.body.append(root)
    const block = root.querySelector('p')!
    setBox(root, { left: 0, top: 0, width: 100, height: 60 })
    setBox(block, { left: 10, top: 10, width: 25, height: 30 })

    const context = {
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      measureText: (text: string) => ({
        width: Array.from(text).length * 10,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
      }),
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    const createRange = vi.spyOn(document, 'createRange')

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })

    expect(createRange).not.toHaveBeenCalled()
    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual(['A', 'B', 'C', 'D'])
    expect(snapshot.glyphs.map(({ sequence }) => sequence)).toEqual([0, 1, 0, 1])
    expect(snapshot.glyphs[0]!.decorations?.[0]).toMatchObject({ line: 'underline', offset: 1 })
    expect(snapshot.glyphs[0]!.decorationWidth).toBe(10)
    expect(snapshot.lineCount).toBe(2)
    expect(new Set(snapshot.glyphs.map(({ lineBottom }) => lineBottom)).size).toBe(2)
  })

  it('assigns nested text to its nearest block exactly once and scales captured layout', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<div data-sdf-block id="outer" style="color: rgb(255, 0, 0); font-size: 20px; line-height: 24px">' +
      '<span id="a" data-sdf-depth="3">A</span>' +
      '<div data-sdf-block id="inner"><span id="b">B</span></div>' +
      '<span data-sdf-ignore><span id="ignored">C</span></span>' +
      '</div>'
    document.body.append(root)

    const outer = document.querySelector('#outer')!
    const inner = document.querySelector('#inner')!
    setBox(root, { left: 10, top: 20, width: 200, height: 100 })
    setBox(outer, { left: 20, top: 30, width: 180, height: 50 })
    setBox(inner, { left: 30, top: 45, width: 80, height: 20 })

    installRangeLayout(
      new Map([
        [textNode('#a'), { left: 25, top: 35, width: 12, height: 20 }],
        [textNode('#b'), { left: 35, top: 47, width: 12, height: 20 }],
        [textNode('#ignored'), { left: 50, top: 55, width: 12, height: 20 }],
      ]),
    )

    const snapshot = collectDomSnapshot(root, {
      includeRootBackground: false,
      pixelsPerUnit: 2,
      textDepth: 7,
    })

    expect(snapshot.width).toBe(100)
    expect(snapshot.height).toBe(50)
    expect(snapshot.glyphs).toHaveLength(2)
    expect(snapshot.requests.map(({ character }) => character)).toEqual(['A', 'B'])
    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual(['A', 'B'])
    expect(snapshot.glyphs[0]).toMatchObject({
      originX: 7.5,
      lineBottom: 32.5,
      clip: [5, 20, 95, 45],
      sequence: 0,
      z: 3,
    })
    expect(snapshot.glyphs[1]).toMatchObject({
      originX: 12.5,
      clip: [10, 26.5, 50, 37.5],
      sequence: 0,
      z: 7,
    })
    expect(snapshot.lineCount).toBe(2)
    expect(snapshot.atlasSignature).toContain('\u0000A')
    expect(snapshot.atlasSignature).toContain('\u0000B')
    expect(snapshot.atlasSignature).not.toContain('\u0000C')
  })

  it('omits hidden, transparent, ignored, and zero-area content while preserving effective alpha', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<div data-sdf-block id="visible-text" style="opacity: .5; color: rgba(255, 255, 255, .4)">V</div>' +
      '<div data-sdf-block id="display-none" style="display: none">D</div>' +
      '<div data-sdf-block id="visibility-hidden" style="visibility: hidden">H</div>' +
      '<div data-sdf-block><span id="transparent-text" style="opacity: 0">O</span></div>' +
      '<div data-sdf-block><span id="zero-text">Z</span></div>' +
      '<div data-sdf-ignore><div data-sdf-block id="ignored-text">I</div></div>' +
      '<div data-sdf-rect id="visible-rect" data-sdf-depth="4" data-sdf-receive-shadow ' +
      'style="background-color: rgb(10 20 30 / 50%); opacity: .5; border-top-left-radius: 25%"></div>' +
      '<div data-sdf-rect id="hidden-rect" style="display: none; background: red"></div>' +
      '<div data-sdf-rect id="transparent-rect" style="background: transparent"></div>' +
      '<div data-sdf-rect id="zero-rect" style="background: red"></div>' +
      '<div data-sdf-ignore><div data-sdf-rect id="ignored-rect" style="background: red"></div></div>'
    document.body.append(root)

    setBox(root, { left: 0, top: 0, width: 160, height: 100 })
    for (const element of root.querySelectorAll('[data-sdf-block]')) {
      setBox(element, { left: 10, top: 10, width: 100, height: 20 })
    }
    setBox(document.querySelector('#visible-rect')!, {
      left: 20,
      top: 40,
      width: 40,
      height: 20,
    })
    setBox(document.querySelector('#hidden-rect')!, {
      left: 20,
      top: 65,
      width: 40,
      height: 20,
    })
    setBox(document.querySelector('#transparent-rect')!, {
      left: 65,
      top: 40,
      width: 40,
      height: 20,
    })
    setBox(document.querySelector('#zero-rect')!, {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    })
    setBox(document.querySelector('#ignored-rect')!, {
      left: 110,
      top: 40,
      width: 40,
      height: 20,
    })

    const rangeLayout = new Map<Text, Box>()
    for (const character of ['V', 'D', 'H', 'O', 'I']) {
      rangeLayout.set(
        textNode(
          `#${character === 'V' ? 'visible-text' : character === 'D' ? 'display-none' : character === 'H' ? 'visibility-hidden' : character === 'O' ? 'transparent-text' : 'ignored-text'}`,
        ),
        {
          left: 10,
          top: 10,
          width: 10,
          height: 16,
        },
      )
    }
    rangeLayout.set(textNode('#zero-text'), { left: 10, top: 10, width: 0, height: 0 })
    installRangeLayout(rangeLayout)

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(snapshot.requests.map(({ character }) => character)).toEqual(['V'])
    expect(snapshot.glyphs).toHaveLength(1)
    expect(snapshot.glyphs[0]!.color[3]).toBeCloseTo(0.2)
    expect(snapshot.rects).toEqual([
      expect.objectContaining({
        rect: [20, 40, 60, 60],
        radius: 5,
        z: 4,
        receiveShadow: true,
      }),
    ])
    expect(snapshot.rects[0]!.color[3]).toBeCloseTo(0.25)
  })

  it('reads the data-text-* markup names as it reads the data-sdf-* ones', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<div data-text-block id="text-block" style="color: rgb(255, 0, 0)">' +
      '<span id="deep" data-text-depth="3">A</span>' +
      '<span data-text-ignore><span id="text-ignored">C</span></span>' +
      '</div>' +
      '<div data-text-rect id="text-rect" data-text-depth="4" data-text-receive-shadow ' +
      'style="background-color: rgb(10 20 30)"></div>' +
      // Both names on one element: the data-text-* value wins.
      '<div data-text-rect id="both-rect" data-text-depth="6" data-sdf-depth="2" ' +
      'style="background-color: rgb(10 20 30)"></div>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 100 })
    setBox(document.querySelector('#text-block')!, { left: 10, top: 10, width: 100, height: 20 })
    setBox(document.querySelector('#text-rect')!, { left: 20, top: 40, width: 40, height: 20 })
    setBox(document.querySelector('#both-rect')!, { left: 80, top: 40, width: 40, height: 20 })
    installRangeLayout(
      new Map([
        [textNode('#deep'), { left: 10, top: 10, width: 10, height: 16 }],
        [textNode('#text-ignored'), { left: 30, top: 10, width: 10, height: 16 }],
      ]),
    )

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(snapshot.requests.map(({ character }) => character)).toEqual(['A'])
    expect(snapshot.glyphs).toEqual([expect.objectContaining({ z: 3 })])
    expect(snapshot.rects).toEqual([
      expect.objectContaining({ rect: [20, 40, 60, 60], z: 4, receiveShadow: true }),
      expect.objectContaining({ rect: [80, 40, 120, 60], z: 6, receiveShadow: false }),
    ])
  })

  it('validates browser attachment, source bounds, and pixels-per-unit before capture', () => {
    const detached = document.createElement('div')
    setBox(detached, { left: 0, top: 0, width: 100, height: 50 })
    expect(() => collectDomSnapshot(detached)).toThrow('must be connected')

    document.body.append(detached)
    setBox(detached, { left: 0, top: 0, width: 0, height: 50 })
    expect(() => collectDomSnapshot(detached)).toThrow('has no layout box')

    setBox(detached, { left: 0, top: 0, width: 100, height: 50 })
    for (const pixelsPerUnit of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => collectDomSnapshot(detached, { pixelsPerUnit })).toThrow(
        'pixelsPerUnit must be a positive finite number',
      )
    }
  })

  it('captures the root itself as text and a rounded background when it opts in', () => {
    const root = document.createElement('section')
    root.setAttribute('data-sdf-block', '')
    root.setAttribute('data-sdf-rect', '')
    root.setAttribute('data-sdf-receive-shadow', '')
    root.style.cssText =
      'background: rgb(20, 40, 60); border-top-left-radius: 10px; color: #fff; font-size: 16px'
    root.textContent = 'R'
    document.body.append(root)
    setBox(root, { left: 5, top: 10, width: 120, height: 40 })
    installRangeLayout(
      new Map([[root.firstChild as Text, { left: 10, top: 20, width: 10, height: 16 }]]),
    )

    const snapshot = collectDomSnapshot(root)

    expect(snapshot.requests.map(({ character }) => character)).toEqual(['R'])
    expect(snapshot.rects).toHaveLength(1)
    expect(snapshot.rects[0]).toMatchObject({
      rect: [0, 0, 120, 40],
      radius: 10,
      z: -1,
      receiveShadow: true,
    })
  })

  it('honors custom selectors and deduplicates repeated glyph requests on one line', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p class="copy" style="font-family: serif; font-style: italic; font-variant: small-caps; font-weight: 700">AA</p>' +
      '<div class="skip"><p class="copy" id="custom-ignored">X</p></div>' +
      '<div class="panel" style="background: rgb(20, 30, 40)"></div>'
    document.body.append(root)
    const copy = root.querySelector('.copy')!
    const panel = root.querySelector('.panel')!
    setBox(root, { left: 0, top: 0, width: 200, height: 80 })
    setBox(copy, { left: 10, top: 10, width: 100, height: 20 })
    setBox(panel, { left: 10, top: 40, width: 100, height: 20 })
    setBox(root.querySelector('#custom-ignored')!, {
      left: 10,
      top: 10,
      width: 100,
      height: 20,
    })
    installRangeLayout(
      new Map([
        [copy.firstChild as Text, { left: 10, top: 10, width: 20, height: 16 }],
        [textNode('#custom-ignored'), { left: 10, top: 10, width: 10, height: 16 }],
      ]),
    )

    const snapshot = collectDomSnapshot(root, {
      textSelector: '.copy',
      rectSelector: '.panel',
      ignoreSelector: '.skip',
      includeRootBackground: false,
      bakeSize: 128,
    })

    expect(snapshot.glyphs.map(({ sequence }) => sequence)).toEqual([0, 1])
    expect(snapshot.requests).toHaveLength(1)
    expect(snapshot.requests[0]!.character).toBe('A')
    expect(snapshot.requests[0]!.font.canvasFont).toContain('italic small-caps 700 128px serif')
    expect(snapshot.rects).toHaveLength(1)
    expect(snapshot.rects[0]!.rect).toEqual([10, 20, 110, 40])
  })

  it('reserves extraGlyphs for every captured font without emitting instances', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block style="font-family: serif; font-weight: 400">A</p>' +
      '<p data-sdf-block style="font-family: serif; font-weight: 700">A</p>'
    document.body.append(root)
    const [light, bold] = Array.from(root.querySelectorAll('p'))
    setBox(root, { left: 0, top: 0, width: 200, height: 80 })
    setBox(light!, { left: 0, top: 0, width: 100, height: 20 })
    setBox(bold!, { left: 0, top: 20, width: 100, height: 20 })
    installRangeLayout(
      new Map([
        [light!.firstChild as Text, { left: 0, top: 0, width: 10, height: 16 }],
        [bold!.firstChild as Text, { left: 0, top: 20, width: 10, height: 16 }],
      ]),
    )

    const baseline = collectDomSnapshot(root, { includeRootBackground: false })
    const snapshot = collectDomSnapshot(root, {
      includeRootBackground: false,
      // Whitespace is skipped, and 'A' is already present, so neither duplicates.
      extraGlyphs: '01A ',
    })

    // Two weights x {A, 0, 1}: the extras are baked once per captured font.
    expect(baseline.requests).toHaveLength(2)
    expect(snapshot.requests).toHaveLength(6)
    expect(snapshot.requests.filter((request) => request.character === '0')).toHaveLength(2)
    // Reserved slots are atlas-only; nothing extra is drawn.
    expect(snapshot.glyphs).toHaveLength(baseline.glyphs.length)
    expect(snapshot.atlasSignature).not.toBe(baseline.atlasSignature)
  })

  it('captures colours as DOM-exact sRGB values instead of linear light', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block id="dark-text" style="color: rgb(17, 17, 17)">A</p>' +
      '<div data-sdf-rect id="dark-rect" style="background-color: rgb(20, 40, 60)"></div>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 100, height: 60 })
    setBox(document.querySelector('#dark-text')!, { left: 0, top: 0, width: 100, height: 20 })
    setBox(document.querySelector('#dark-rect')!, { left: 0, top: 30, width: 100, height: 20 })
    installRangeLayout(
      new Map([[textNode('#dark-text'), { left: 2, top: 2, width: 10, height: 16 }]]),
    )

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    // #111111 must survive the Uint8 instance attribute exactly as the DOM
    // shows it; the old linear conversion quantized it back as ~#0d0d0d.
    expect(snapshot.glyphs[0]!.color.slice(0, 3)).toEqual([17 / 255, 17 / 255, 17 / 255])
    expect(snapshot.rects[0]!.color.slice(0, 3)).toEqual([20 / 255, 40 / 255, 60 / 255])
  })

  it('anchors combining marks to the caret after their base glyph', () => {
    const root = document.createElement('section')
    root.innerHTML = '<p data-sdf-block id="marked">éx</p>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(document.querySelector('#marked')!, { left: 0, top: 0, width: 100, height: 20 })
    installPerCharacterLayout(
      new Map([
        [
          textNode('#marked'),
          [
            { left: 10, top: 4, width: 10, height: 16 },
            // U+0301 advances the pen by nothing: its Range collapses.
            null,
            { left: 20, top: 4, width: 10, height: 16 },
          ],
        ],
      ]),
    )

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual(['e', '́', 'x'])
    const [base, mark] = snapshot.glyphs
    // The caret after 'e' sits at its origin plus its ink width.
    expect(mark!.originX).toBeCloseTo(base!.originX + 10, 6)
    expect(mark!.lineBottom).toBe(base!.lineBottom)
    expect(mark!.breakBefore).toBe('none')
    // The following glyph back-fills the mark's advance, keeping word width.
    expect(mark!.advance).toBeCloseTo(0, 6)
    expect(snapshot.glyphs.map(({ sequence }) => sequence)).toEqual([0, 1, 2])
    expect(snapshot.requests.some(({ character }) => character === '́')).toBe(true)
  })

  it('still drops a combining mark that has no base glyph to anchor to', () => {
    const root = document.createElement('section')
    root.innerHTML = '<p data-sdf-block id="orphan">́a</p>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(document.querySelector('#orphan')!, { left: 0, top: 0, width: 100, height: 20 })
    installPerCharacterLayout(
      new Map([[textNode('#orphan'), [null, { left: 10, top: 4, width: 10, height: 16 }]]]),
    )

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })

    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual(['a'])
  })

  it('forces hard breaks at <br> and between nested block children in pretext mode', async () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block id="br-block" style="font: 10px PretextTest; line-height: 12px; color: #fff">AB<br>CD</p>' +
      '<div data-sdf-block id="nested-block" style="font: 10px PretextTest; line-height: 12px; color: #fff">' +
      '<div>EF</div><div>GH</div></div>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 120 })
    setBox(document.querySelector('#br-block')!, { left: 0, top: 0, width: 100, height: 30 })
    setBox(document.querySelector('#nested-block')!, { left: 0, top: 40, width: 100, height: 30 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })

    const byCharacter = (character: string) =>
      snapshot.glyphs.find(({ glyphKey }) => glyphKey.endsWith(character))!
    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
    ])
    // <br> pushes CD onto its own line and records a break reflow must keep.
    expect(byCharacter('C').breakBefore).toBe('hard')
    expect(byCharacter('C').lineBottom).toBeLessThan(byCharacter('A').lineBottom)
    // Nested block-level children each start their own paragraph.
    expect(byCharacter('G').breakBefore).toBe('hard')
    expect(byCharacter('G').lineBottom).toBeLessThan(byCharacter('E').lineBottom)
  })

  it('keeps automatic optical-size outlines distinct only for Windfoil', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block><span id="small" style="font-size: 12px">A</span>' +
      '<span id="large" style="font-size: 72px">A</span></p>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 90 })
    setBox(root.querySelector('p')!, { left: 0, top: 0, width: 200, height: 90 })
    installRangeLayout(
      new Map([
        [textNode('#small'), { left: 0, top: 60, width: 8, height: 12 }],
        [textNode('#large'), { left: 20, top: 0, width: 48, height: 72 }],
      ]),
    )

    const sdf = collectDomSnapshot(root, { includeRootBackground: false })
    const windfoil = collectDomSnapshot(root, {
      includeRootBackground: false,
      textBackend: 'windfoil',
    })

    // SDF draws both instances from one scalable slot. Windfoil's provider
    // must see both CSS sizes because `font-optical-sizing: auto` may select
    // different outlines for them.
    expect(sdf.requests).toHaveLength(1)
    expect(windfoil.requests.map(({ font }) => font.size).sort((a, b) => a - b)).toEqual([12, 72])
    expect(new Set(windfoil.glyphs.map(({ glyphKey }) => glyphKey))).toHaveProperty('size', 2)
  })

  it('keeps pairwise measurements separate per font size', async () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block style="font: 32px PretextTest; line-height: 40px; color: #fff">AB ' +
      '<span style="font-size: 16px">AB</span></p>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 400, height: 60 })
    setBox(root.querySelector('p')!, { left: 0, top: 0, width: 400, height: 40 })
    // Width scales with the context's font size, like a real canvas.
    const context = pretextContext()
    let currentFont = ''
    Object.defineProperty(context, 'font', {
      get: () => currentFont,
      set: (value: string) => {
        currentFont = value
      },
    })
    context.measureText = (text: string) =>
      ({
        width: Array.from(text).length * (currentFont.includes('16px') ? 8 : 16),
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
      }) as TextMetrics
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })

    // The pair cache must not collide across sizes of the same face: the
    // font-style key is deliberately size-less, but advances are not. The B
    // before the space reaches the next word's origin, as every advance does.
    const { glyphs } = snapshot
    const advances = glyphs.map(({ advance }) => advance)
    expect(advances[0]).toBe(16)
    expect(advances[1]).toBe(glyphs[2]!.originX - glyphs[1]!.originX)
    expect(advances.slice(2)).toEqual([8, 8])
  })

  it('breaks pretext lines around skipped block-level children', async () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<div data-sdf-block id="fused" style="font: 10px PretextTest; line-height: 12px; color: #fff">' +
      'one<div data-sdf-ignore>ad</div>two</div>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 120 })
    setBox(document.querySelector('#fused')!, { left: 0, top: 0, width: 100, height: 40 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })

    // The ignored div is block-level and still occupies a line in the DOM, so
    // 'one' and 'two' must not fuse into one continuous run.
    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.at(-1))).toEqual([
      'o',
      'n',
      'e',
      't',
      'w',
      'o',
    ])
    const one = snapshot.glyphs[0]!
    const two = snapshot.glyphs[3]!
    expect(two.breakBefore).toBe('hard')
    expect(two.lineBottom).toBeLessThan(one.lineBottom)
  })

  it('measures pretext text pairwise instead of per growing prefix', async () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<p data-sdf-block style="font: 10px PretextTest; line-height: 12px; color: #fff">' +
      'mississippi mississippi mississippi</p>'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 400, height: 60 })
    setBox(root.querySelector('p')!, { left: 0, top: 0, width: 400, height: 40 })
    const context = pretextContext()
    const measure = vi.spyOn(context, 'measureText')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)

    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })

    expect(snapshot.glyphs).toHaveLength(33)
    // The old loop measured every growing prefix — for this block, strings up
    // to the full 35 characters. Pairwise measurement (plus Pretext's own
    // word-segment measurements) never exceeds one word.
    const longest = Math.max(...measure.mock.calls.map(([text]) => Array.from(text).length))
    expect(longest).toBeLessThanOrEqual('mississippi'.length)
  })

  it('identifies soft breaks on CJK ideograms while respecting Kinsoku Shori punctuation', () => {
    const root = document.createElement('div')
    root.setAttribute('data-sdf-block', '')
    root.style.cssText = 'color: #fff; font-size: 16px'
    root.textContent = '東京、日本'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    installRangeLayout(
      new Map([[root.firstChild as Text, { left: 0, top: 0, width: 80, height: 16 }]]),
    )

    const snapshot = collectDomSnapshot(root, { cjkLineBreaking: true })
    const breaks = snapshot.glyphs.map((g) => g.breakBefore)
    expect(breaks).toEqual(['soft', 'soft', 'none', 'soft', 'soft'])
    expect(collectDomSnapshot(root).glyphs.map((g) => g.breakBefore)).toEqual([
      'soft',
      'none',
      'none',
      'none',
      'none',
    ])
    expect(collectDomSnapshot(root, { cjkLineBreaking: false }).glyphs).toEqual(
      collectDomSnapshot(root).glyphs,
    )
  })

  it('applies options.reshape to text nodes and captures RTL direction', () => {
    const root = document.createElement('div')
    root.setAttribute('data-sdf-block', '')
    root.style.cssText = 'color: #fff; font-size: 16px; direction: rtl'
    root.textContent = 'abc'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    installRangeLayout(
      new Map([[root.firstChild as Text, { left: 0, top: 0, width: 30, height: 16 }]]),
    )

    const snapshot = collectDomSnapshot(root, {
      reshape: (text) => text.toUpperCase(),
      rtlReflow: true,
    })

    expect(snapshot.blocks[0]?.direction).toBe('rtl')
    expect(snapshot.requests.map((r) => r.character)).toEqual(['A', 'B', 'C'])
    const plain = collectDomSnapshot(root)
    expect(plain.blocks[0]?.direction).toBeUndefined()
    expect(plain.glyphs[0]?.decorationWidth).toBeUndefined()
    expect(plain.requests.map((r) => r.character)).toEqual(['a', 'b', 'c'])
  })

  it('keeps opt-in CJK breaks across inline markup and preserves explicit breaks', () => {
    const root = document.createElement('div')
    root.setAttribute('data-sdf-block', '')
    root.style.cssText = 'font: 16px sans-serif; color: #fff'
    root.innerHTML = '東<span>京</span>日本<br>語'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    installRangeLayout(
      new Map([
        [root.childNodes[0] as Text, { left: 0, top: 0, width: 16, height: 16 }],
        [
          root.querySelector('span')!.firstChild as Text,
          { left: 16, top: 0, width: 16, height: 16 },
        ],
        [root.childNodes[2] as Text, { left: 32, top: 0, width: 32, height: 16 }],
        [root.lastChild as Text, { left: 0, top: 20, width: 16, height: 16 }],
      ]),
    )
    const snapshot = collectDomSnapshot(root, { cjkLineBreaking: true })
    expect(snapshot.glyphs.map((g) => g.breakBefore)).toEqual([
      'soft',
      'soft',
      'soft',
      'soft',
      'hard',
    ])
    expect(snapshot.glyphs.slice(1, 4).map((g) => g.gapBefore)).toEqual([0, 0, 0])
  })

  it('rejects reshape callbacks that change Range offsets or whitespace', () => {
    const root = document.createElement('div')
    root.setAttribute('data-sdf-block', '')
    root.style.cssText = 'font: 16px sans-serif; color: #fff'
    root.textContent = 'لا ب'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    for (const reshape of [
      (text: string) => text.replace('لا', '\ufefb'),
      (text: string) => text + 'ب',
      (text: string) => text.replace(' ', 'ب'),
    ]) {
      expect(() => collectDomSnapshot(root, { reshape })).toThrow(
        'preserve code point boundaries and whitespace',
      )
    }
  })

  it('does not claim RTL reflow support for the Pretext engine', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    await expect(
      collectDomSnapshot(root, { layoutEngine: 'pretext', rtlReflow: true }),
    ).rejects.toThrow('rtlReflow requires the Range')
  })

  it('adds CJK soft breaks to Pretext only when enabled', async () => {
    const root = document.createElement('div')
    root.dataset['sdfBlock'] = ''
    root.style.cssText = 'font: 16px PretextTest; line-height: 20px; color: #fff'
    root.innerHTML = '東<span>京</span>日本'
    document.body.append(root)
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const defaults = await collectDomSnapshot(root, { layoutEngine: 'pretext' })
    const enabled = await collectDomSnapshot(root, {
      layoutEngine: 'pretext',
      cjkLineBreaking: true,
    })
    expect(defaults.glyphs.map((glyph) => glyph.gapBefore)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(enabled.glyphs.map((glyph) => glyph.breakBefore)).toEqual([
      'soft',
      'soft',
      'soft',
      'soft',
    ])
    expect(enabled.glyphs.slice(1).map((glyph) => glyph.gapBefore)).toEqual([0, 0, 0])
  })
})

describe('alignment and word metrics capture', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'OffscreenCanvas')
  })

  /** One 'AB CD' line, captured with `style` on its block. */
  function alignedBlock(style: string, options: { readonly rtlReflow?: boolean } = {}) {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = `<p data-sdf-block style="font: 10px/12px Arial; ${style}">AB CD</p>`
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(block, { left: 0, top: 0, width: 100, height: 12 })
    installRangeLayout(
      new Map([[block.firstChild as Text, { left: 0, top: 0, width: 50, height: 12 }]]),
    )
    return collectDomSnapshot(root, { includeRootBackground: false, ...options })
  }

  /** Canvas stand-in on OffscreenCanvas, which a browser has and jsdom lacks. */
  function installOffscreenCanvas(width: (text: string) => number): void {
    const context = {
      font: '',
      letterSpacing: '0px',
      measureText: (text: string) => ({ width: width(text) }),
    }
    Object.defineProperty(window, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        getContext() {
          return context
        }
      },
    })
  }

  /** Ten units a character, six a space, as the fixtures' Range boxes lay them out. */
  const tenAndSix = (text: string) =>
    Array.from(text).reduce((sum, character) => sum + (character === ' ' ? 6 : 10), 0)

  it.each([
    ['center', 'center'],
    ['right', 'right'],
    ['justify', 'justify'],
    ['end', 'right'],
    ['left', undefined],
    ['start', undefined],
  ])('records text-align: %s as %s', (value, expected) => {
    const { blocks } = alignedBlock(`text-align: ${value}`)
    expect(blocks[0]!.textAlign).toBe(expected)
    expect(blocks[0]!.textAlignLast).toBeUndefined()
  })

  it.each([
    ['start', 'right', undefined],
    ['end', undefined, 'left'],
    ['left', undefined, 'left'],
    ['right', 'right', undefined],
    ['center', 'center', 'center'],
  ])(
    'resolves text-align: %s in an RTL block by its direction, then by the reflow edge',
    (value, plain, rtlReflow) => {
      // Without rtlReflow lines reflow from the left, so the start of an RTL block is right.
      const captured = alignedBlock(`direction: rtl; text-align: ${value}`)
      expect(captured.blocks[0]).not.toHaveProperty('direction')
      expect(captured.blocks[0]!.textAlign).toBe(plain)
      document.body.replaceChildren()
      vi.restoreAllMocks()
      const reflowable = alignedBlock(`direction: rtl; text-align: ${value}`, { rtlReflow: true })
      expect(reflowable.blocks[0]!.direction).toBe('rtl')
      expect(reflowable.blocks[0]!.textAlign).toBe(rtlReflow)
    },
  )

  it('resolves the -webkit- sides and start and end by direction', () => {
    expect(physicalAlign('-webkit-center', false)).toBe('center')
    expect(physicalAlign('-webkit-right', false)).toBe('right')
    expect(physicalAlign('-webkit-left', true)).toBe('left')
    expect(physicalAlign('start', true)).toBe('right')
    expect(physicalAlign('end', true)).toBe('left')
    expect(physicalAlign('end', false)).toBe('right')
    for (const value of ['', 'start', 'auto', 'match-parent']) {
      expect(physicalAlign(value, false)).toBe('left')
    }
    expect(physicalAlign('justify', true)).toBe('justify')
  })

  it.each([
    ['text-align: justify; text-align-last: justify', 'justify', 'justify'],
    ['text-align: left; text-align-last: center', 'left', 'center'],
    ['text-align: center; text-align-last: left', 'center', 'left'],
    ['text-align: justify; text-align-last: end', 'justify', 'right'],
    ['text-align: justify; direction: rtl', 'justify', 'right'],
    ['text-align: center; text-align-last: center', 'center', undefined],
    ['text-align: justify; text-align-last: start', 'justify', undefined],
    ['text-align: justify', 'justify', undefined],
  ])('records %s as %s, then %s for the last line', (style, align, last) => {
    const { blocks } = alignedBlock(style)
    expect(blocks[0]!.textAlign).toBe(align)
    expect(blocks[0]!.textAlignLast).toBe(last)
  })

  it('keeps an aligned line apart from an aligned last line in the layout signature', () => {
    // One line looks the same either way, but a narrower reflow does not.
    const centred = alignedBlock('text-align: center')
    document.body.replaceChildren()
    vi.restoreAllMocks()
    const centredLast = alignedBlock('text-align: left; text-align-last: center')
    expect(centredLast.glyphs).toEqual(centred.glyphs)
    expect(layoutSignatureOf(centredLast)).not.toBe(layoutSignatureOf(centred))
    expect(reflowSnapshot(centred, 30).glyphs[0]!.originX).toBe(5)
    expect(reflowSnapshot(centredLast, 30).glyphs[0]!.originX).toBe(0)
  })

  it('wraps and aligns Range lines in the content box, inside borders and padding', () => {
    const root = document.body.appendChild(document.createElement('section'))
    // jsdom reports a medium width for the borders this block has no style for.
    root.innerHTML =
      '<p data-sdf-block style="font: 10px/12px Arial; padding: 0 8px 0 24px; border-left: 6px solid">AB</p>'
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    setBox(block, { left: 10, top: 0, width: 100, height: 12 })
    installRangeLayout(
      new Map([[block.firstChild as Text, { left: 40, top: 0, width: 20, height: 12 }]]),
    )
    const scaled = collectDomSnapshot(root, { includeRootBackground: false, pixelsPerUnit: 2 })
    expect(scaled.blocks[0]).toMatchObject({ left: 20, width: 31, clip: [5, 14, 55, 20] })
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.blocks[0]).toMatchObject({ left: 40, width: 62, clip: [10, 28, 110, 40] })
    // At the captured width the glyphs stay put, and the clip spans the border box.
    const same = reflowSnapshot(snapshot, 200)
    expect(same.glyphs.map(({ originX }) => originX)).toEqual([40, 50])
    const clip = same.glyphs[0]!.clip
    expect([clip[0], clip[2]]).toEqual([10, 110])
  })

  it("keeps a word's own width when its advance reaches across the space after it", () => {
    const { glyphs } = alignedBlock('')
    expect(glyphs.map(({ advance }) => advance)).toEqual([10, 20, 10, 10])
    expect(glyphs.map(({ decorationWidth }) => decorationWidth)).toEqual([
      undefined,
      10,
      undefined,
      undefined,
    ])
  })

  it('records natural word spaces where a captured line starts and in justified blocks', () => {
    installOffscreenCanvas(tenAndSix)
    const capture = (style: string, text = 'AB CD EF') => {
      document.body.replaceChildren()
      vi.restoreAllMocks()
      const root = document.body.appendChild(document.createElement('section'))
      root.innerHTML = `<p data-sdf-block style="font: 10px/12px Arial; ${style}">${text}</p>`
      const block = root.firstElementChild!
      setBox(root, { left: 0, top: 0, width: 100, height: 40 })
      setBox(block, { left: 0, top: 0, width: 100, height: 24 })
      // Two lines: the words up to the last on the first, the last one alone on the second.
      const node = block.firstChild as Text
      const last = node.data.lastIndexOf(' ')
      const boxes = Array.from(node.data, (character, index) => {
        if (index > last) return { left: (index - last - 1) * 10, top: 12, width: 10, height: 12 }
        const left = tenAndSix(node.data.slice(0, index))
        return character === ' ' ? null : { left, top: 0, width: 10, height: 12 }
      })
      installPerCharacterLayout(new Map([[node, boxes]]))
      return collectDomSnapshot(root, { includeRootBackground: false }).glyphs.map(
        ({ gapBefore }) => gapBefore,
      )
    }
    // The first word of the second line; the words of a justified block too.
    expect(capture('')).toEqual([undefined, undefined, undefined, undefined, 6, undefined])
    expect(capture('text-align: justify')).toEqual([
      undefined,
      undefined,
      6,
      undefined,
      6,
      undefined,
    ])
    expect(capture('text-align: left; text-align-last: justify')[2]).toBe(6)
    // A space takes its letter and word spacing; a run collapses to one unless it is kept.
    expect(capture('letter-spacing: 1px; word-spacing: 2px')[4]).toBe(9)
    expect(capture('text-align: justify', 'AB   CD EF')[2]).toBe(6)
    expect(capture('text-align: justify; white-space: pre-wrap', 'AB   CD EF')[2]).toBe(18)
    // Without a Canvas to measure them (jsdom), there are none to record.
    Reflect.deleteProperty(window, 'OffscreenCanvas')
    expect(capture('text-align: justify')).toEqual(Array(6).fill(undefined))
  })

  it('breaks no line at a no-break space, and still at an ideographic one', () => {
    // U+00A0, U+2007, U+202F, U+FEFF and the word joiner U+2060 join their words; U+0020 and
    // U+3000 are where a line may break.
    const text = 'A\u00a0B\u2007C\u202fD\ufeffE\u2060F G\u3000H'
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = '<p data-sdf-block style="font: 10px/12px Arial"></p>'
    const block = root.firstElementChild!
    block.textContent = text
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    setBox(block, { left: 0, top: 0, width: 200, height: 12 })
    // A 10-unit box a character, and none for the word joiner, which has no width.
    const boxes = Array.from(text, (character, index) =>
      character === '\u2060' ? null : { left: index * 10, top: 0, width: 10, height: 12 },
    )
    installPerCharacterLayout(new Map([[block.firstChild as Text, boxes]]))
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.glyphs.map(({ glyphKey }) => glyphKey.slice(-1)).join('')).toBe('ABCDEFGH')
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual([
      'soft',
      'none',
      'none',
      'none',
      'none',
      'none',
      'soft',
      'soft',
    ])
    // Re-wrapped narrower, the joined words keep one line: 'G' and 'H' each take one of their own.
    const narrow = reflowSnapshot(snapshot, 25)
    expect(narrow.lineCount).toBe(3)
    expect(new Set(narrow.glyphs.slice(0, 6).map(({ lineBottom }) => lineBottom)).size).toBe(1)
  })

  it('justifies a no-break space where CSS does, with no break: U+00A0, not U+202F', () => {
    installOffscreenCanvas(tenAndSix)
    const text = 'AB\u00a0CD EF\u202fGH IJ'
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = '<p data-sdf-block style="font: 10px/12px Arial; text-align: justify"></p>'
    const block = root.firstElementChild!
    block.textContent = text
    setBox(root, { left: 0, top: 0, width: 200, height: 40 })
    setBox(block, { left: 0, top: 0, width: 200, height: 12 })
    // One last line at natural spacing: six units a space and U+00A0, two for U+202F.
    const lefts = [0, 10, -1, 26, 36, -1, 52, 62, -1, 74, 84, -1, 100, 110]
    installPerCharacterLayout(
      new Map([
        [
          block.firstChild as Text,
          lefts.map((left) => (left < 0 ? null : { left, top: 0, width: 10, height: 12 })),
        ],
      ]),
    )
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual([
      'soft',
      'none',
      'none',
      'none',
      'soft',
      'none',
      'none',
      'none',
      'soft',
      'none',
    ])
    // U+00A0 records its natural width before 'C', and 'B' its own width; U+202F stays in its word.
    expect(snapshot.glyphs.map(({ gapBefore }) => gapBefore)).toEqual([
      undefined,
      undefined,
      6,
      undefined,
      6,
      undefined,
      undefined,
      undefined,
      6,
      undefined,
    ])
    expect(snapshot.glyphs[1]).toMatchObject({ advance: 16, decorationWidth: 10 })
    expect(snapshot.glyphs[5]).toMatchObject({ advance: 12 })
    expect(snapshot.glyphs[5]!.decorationWidth).toBeUndefined()
    expect(reflowSnapshot(snapshot, 200).glyphs.map(({ originX }) => originX)).toEqual(
      lefts.filter((left) => left >= 0),
    )
    // At 55 'AB CD' spreads 9 into its no-break space; 'EF GH' has no space to spread.
    expect(reflowSnapshot(snapshot, 55).glyphs.map(({ originX }) => originX)).toEqual([
      0, 10, 35, 45, 0, 10, 22, 32, 0, 10,
    ])
  })

  it('keeps the advance a glyph lays out by, where Canvas measures it within its box', () => {
    // The Range box spans whole 64ths of a pixel, past the advance the layout spaces by.
    installOffscreenCanvas((text) => Array.from(text).length * 9.98)
    const { glyphs } = alignedBlock('')
    expect(glyphs.map(({ advance }) => +advance.toFixed(4))).toEqual([10, 20, 10, 9.98])
    expect(glyphs[1]!.decorationWidth).toBeCloseTo(9.98)
    // A width that Canvas shapes otherwise (a feature it cannot set) keeps the box.
    installOffscreenCanvas((text) => Array.from(text).length * 9.5)
    document.body.replaceChildren()
    vi.restoreAllMocks()
    expect(alignedBlock('').glyphs[3]!.advance).toBe(10)
  })

  it('records a forced break after <br> even with whitespace around it', () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = '<p data-sdf-block style="font: 10px/12px Arial">AB <br>\nCD EF</p>'
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(block, { left: 0, top: 0, width: 100, height: 36 })
    const box = (left: number, top: number) => ({ left, top, width: 10, height: 12 })
    installPerCharacterLayout(
      new Map([
        [block.firstChild as Text, [box(0, 0), box(10, 0), null]],
        // 'EF' wraps softly to a third line.
        [block.lastChild as Text, [null, box(0, 12), box(10, 12), null, box(0, 24), box(10, 24)]],
      ]),
    )
    const { glyphs } = collectDomSnapshot(root, { includeRootBackground: false })
    expect(glyphs.map(({ breakBefore }) => breakBefore)).toEqual([
      'soft',
      'none',
      'hard',
      'none',
      'soft',
      'none',
    ])
  })

  it('takes no forced break from a <br> the layout hides where the line wraps anyway', () => {
    // A responsive `<br>` under display: none, at the space where the line wraps softly.
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<p data-sdf-block style="font: 10px/12px Arial">AB <br style="display: none">CD EF</p>'
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(block, { left: 0, top: 0, width: 100, height: 24 })
    const box = (left: number, top: number) => ({ left, top, width: 10, height: 12 })
    installPerCharacterLayout(
      new Map([
        [block.firstChild as Text, [box(0, 0), box(10, 0), null]],
        [block.lastChild as Text, [box(0, 12), box(10, 12), null, box(26, 12), box(36, 12)]],
      ]),
    )
    const { glyphs } = collectDomSnapshot(root, { includeRootBackground: false })
    expect(glyphs.map(({ breakBefore }) => breakBefore)).toEqual([
      'soft',
      'none',
      'soft',
      'none',
      'soft',
      'none',
    ])
  })

  /** Lets the SVG capture read an inline SVG in jsdom: its box, transforms and paint. */
  function mockInlineSvgs(boxes: ReadonlyMap<Element, Box>): void {
    for (const [svg, box] of boxes) {
      setBox(svg, box)
      for (const element of [svg, ...svg.querySelectorAll('*')]) {
        Object.defineProperty(element, 'getScreenCTM', {
          configurable: true,
          value: () => ({ a: 1, b: 0, c: 0, d: 1, e: box.left, f: box.top }),
        })
        Object.defineProperty(element, 'getBBox', {
          configurable: true,
          value: () => ({ x: 0, y: 0, width: box.width, height: box.height }),
        })
      }
    }
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      if (element.namespaceURI !== 'http://www.w3.org/2000/svg') return computed(element)
      const style = document.createElement('span').style
      style.cssText =
        'display:inline;visibility:visible;overflow:hidden;fill:rgb(0,0,0);stroke:none;fill-opacity:1;stroke-opacity:1;stroke-width:1;stroke-miterlimit:4;opacity:1;' +
        (element.getAttribute('style') ?? '')
      return style
    })
  }

  const SQUARE =
    '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

  it('keeps the measured gap after an icon that starts a line', async () => {
    installOffscreenCanvas(tenAndSix)
    const root = document.body.appendChild(document.createElement('section'))
    // The icon's margin and the space put 'DO' 12 past it; a space alone is 6.
    root.innerHTML = `<p data-sdf-block style="font: 10px/12px Arial">${SQUARE} DO</p>`
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(block, { left: 0, top: 0, width: 100, height: 12 })
    mockInlineSvgs(
      new Map([[block.firstElementChild!, { left: 0, top: 1, width: 10, height: 10 }]]),
    )
    const box = (left: number) => ({ left, top: 0, width: 10, height: 12 })
    installPerCharacterLayout(new Map([[block.lastChild as Text, [null, box(22), box(32)]]]))
    const snapshot = await collectDomSnapshot(root, { includeRootBackground: false, svg: true })
    expect(snapshot.glyphs.map(({ shapeGroup }) => shapeGroup)).toEqual([0, undefined, undefined])
    expect(snapshot.glyphs[1]!.gapBefore).toBeUndefined()
    expect(reflowSnapshot(snapshot, 100).glyphs.map(({ originX }) => originX)).toEqual([0, 22, 32])
  })

  it('captures a justified line whose skipped SVG follows a shape and a space', async () => {
    installOffscreenCanvas(tenAndSix)
    const root = document.body.appendChild(document.createElement('section'))
    // The second SVG is hidden, so the capture appends nothing for it.
    root.innerHTML =
      '<p data-sdf-block style="font: 10px/12px Arial; text-align: justify">' +
      `AB ${SQUARE} ${SQUARE.replace('<svg', '<svg style="display: none"')} CD</p>`
    const block = root.firstElementChild!
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(block, { left: 0, top: 0, width: 100, height: 12 })
    const [shown, hidden] = block.querySelectorAll('svg')
    mockInlineSvgs(
      new Map([
        [shown!, { left: 26, top: 1, width: 10, height: 10 }],
        [hidden!, { left: 0, top: 0, width: 0, height: 0 }],
      ]),
    )
    const box = (left: number) => ({ left, top: 0, width: 10, height: 12 })
    installPerCharacterLayout(
      new Map([
        [block.firstChild as Text, [box(0), box(10), null]],
        [block.lastChild as Text, [null, box(42), box(52)]],
      ]),
    )
    const snapshot = await collectDomSnapshot(root, { includeRootBackground: false, svg: true })
    expect(snapshot.glyphs.map(({ shapeGroup }) => shapeGroup)).toEqual([
      undefined,
      undefined,
      0,
      undefined,
      undefined,
    ])
    // The shown icon and 'CD' each take the natural space before them.
    expect(snapshot.glyphs.map(({ gapBefore }) => gapBefore)).toEqual([
      undefined,
      undefined,
      6,
      6,
      undefined,
    ])
  })

  it('justifies Pretext lines over their word spaces and reflows them in place', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<p data-sdf-block style="border: 0; font: 10px/12px PretextTest; text-align: justify">AB <b>CD</b> EF GH</p>'
    setBox(root, { left: 0, top: 0, width: 200, height: 60 })
    setBox(root.firstElementChild!, { left: 0, top: 0, width: 65, height: 24 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    // 'AB CD' spreads 15 of slack into its space; the last line keeps its natural spaces.
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([0, 10, 45, 55, 0, 10, 30, 40])
    // The space between the inline items is a word break, recorded at its natural width.
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual([
      'soft',
      'none',
      'soft',
      'none',
      'soft',
      'none',
      'soft',
      'none',
    ])
    expect(snapshot.glyphs.map(({ gapBefore }) => gapBefore)).toEqual([
      undefined,
      undefined,
      10,
      undefined,
      10,
      undefined,
      10,
      undefined,
    ])
    expect(snapshot.glyphs[1]).toMatchObject({ advance: 35, decorationWidth: 10 })
    expect(snapshot.blocks[0]!.textAlign).toBe('justify')
    // Reflow widths are the root's: 200 keeps the block's 65, and 255 widens it to 120.
    expect(reflowSnapshot(snapshot, 200).glyphs.map(({ originX }) => originX)).toEqual(
      snapshot.glyphs.map(({ originX }) => originX),
    )
    expect(reflowSnapshot(snapshot, 255).glyphs.map(({ originX }) => originX)).toEqual([
      0, 10, 30, 40, 60, 70, 90, 100,
    ])
  })

  it('justifies Pretext no-break spaces as CSS does, unbroken: U+00A0, not U+202F', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<p data-sdf-block style="border: 0; font: 10px/12px PretextTest; text-align: justify"></p>'
    root.firstElementChild!.textContent = 'AB\u00a0CD EF\u202fGH IJ'
    setBox(root, { left: 0, top: 0, width: 200, height: 60 })
    setBox(root.firstElementChild!, { left: 0, top: 0, width: 65, height: 36 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    // 'AB CD' spreads 15 into its U+00A0; 'EF GH' has no space to spread.
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([
      0, 10, 45, 55, 0, 10, 30, 40, 0, 10,
    ])
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual([
      'soft',
      'none',
      'none',
      'none',
      'soft',
      'none',
      'none',
      'none',
      'soft',
      'none',
    ])
    expect(snapshot.glyphs.map(({ gapBefore }) => gapBefore)).toEqual([
      undefined,
      undefined,
      10,
      undefined,
      10,
      undefined,
      undefined,
      undefined,
      10,
      undefined,
    ])
    expect(reflowSnapshot(snapshot, 200).glyphs.map(({ originX }) => originX)).toEqual(
      snapshot.glyphs.map(({ originX }) => originX),
    )
  })

  it('aligns each Pretext paragraph by text-align-last on its last line', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<p data-sdf-block style="border: 0; font: 10px/12px PretextTest; text-align: right; text-align-last: center">AB CD EF<br>GH</p>'
    setBox(root, { left: 0, top: 0, width: 200, height: 60 })
    setBox(root.firstElementChild!, { left: 0, top: 0, width: 65, height: 36 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())
    const snapshot = await collectDomSnapshot(root, {
      includeRootBackground: false,
      layoutEngine: 'pretext',
    })
    // 'AB CD' ends on the right; 'EF' and 'GH' end their paragraphs, centred.
    expect(snapshot.glyphs.map(({ originX }) => originX)).toEqual([
      15, 25, 45, 55, 22.5, 32.5, 22.5, 32.5,
    ])
    expect(snapshot.blocks[0]).toMatchObject({ textAlign: 'right', textAlignLast: 'center' })
  })
})

describe('emoji cluster capture', () => {
  function fixture(text: string, boxes?: readonly (Box | null)[]) {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML = '<p data-sdf-block></p>'
    root.firstElementChild!.textContent = text
    const node = root.firstElementChild!.firstChild as Text
    for (const element of [root, root.firstElementChild!])
      setBox(element, { left: 0, top: 0, width: 400, height: 40 })
    if (boxes) installPerCharacterLayout(new Map([[node, boxes]]))
    else
      installRangeLayout(
        new Map([[node, { left: 0, top: 0, width: text.length * 10, height: 20 }]]),
      )
    return root
  }

  it('emits whole ZWJ, modifier, flag, keycap, tag and presentation sequences', () => {
    const samples = [
      '👨‍👩‍👧',
      '👍🏽',
      '🇯🇵',
      '1\uFE0F\u20E3',
      '🏴\u{E0067}\u{E0062}\u{E007F}',
      '❤\uFE0F',
      '❤\uFE0E',
    ]
    const snapshot = collectDomSnapshot(fixture(samples.join(' ')))
    expect(snapshot.glyphs).toHaveLength(samples.length)
    expect(new Set(snapshot.requests.map((request) => request.character))).toEqual(new Set(samples))
    expect(new Set(snapshot.glyphs.map((glyph) => glyph.originX)).size).toBe(samples.length)
  })

  it('does not anchor a collapsed emoji sequence as a combining mark', () => {
    const root = fixture('A❤\uFE0F', [{ left: 0, top: 0, width: 10, height: 20 }, null, null])
    const snapshot = collectDomSnapshot(root)
    expect(snapshot.requests.map((request) => request.character)).toEqual(['A'])
  })

  it('keeps taller emoji and its following neighbour on their text line', () => {
    const root = fixture('A👍🏽B', [
      { left: 0, top: 3, width: 10, height: 20 },
      { left: 10, top: 0, width: 15, height: 26 },
      null,
      null,
      null,
      { left: 25, top: 3, width: 10, height: 20 },
    ])
    const snapshot = collectDomSnapshot(root)
    expect(snapshot.lineCount).toBe(1)
    expect(snapshot.glyphs.map((glyph) => glyph.breakBefore)).toEqual(['soft', 'none', 'none'])
    expect(snapshot.glyphs.map((glyph) => glyph.advance)).toEqual([10, 15, 10])
  })

  // A 20-unit line-height under 22-unit text boxes: each line's boxes reach 2 into the next's.
  // The block is 40 wide, so the last word wraps.
  const tight = (left: number, line: number, width = 10) => ({
    left,
    top: line * 20,
    width,
    height: 22,
  })
  function tightFixture(text: string, boxes: readonly (Box | null)[]) {
    const root = fixture(text, boxes)
    setBox(root.firstElementChild!, { left: 0, top: 0, width: 40, height: 40 })
    return root
  }

  it('starts the next line after an emoji that ends one, under a tight line-height', () => {
    const root = tightFixture('A👍 B', [
      tight(0, 0),
      tight(10, 0, 20),
      null,
      tight(30, 0, 4),
      tight(0, 1),
    ])
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.lineCount).toBe(2)
    expect(snapshot.glyphs.map(({ lineBottom }) => lineBottom)).toEqual([18, 18, -2])
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual(['soft', 'none', 'soft'])
    // The emoji ends its line with its own width, and reflow keeps 'B' at the next line's start.
    expect(snapshot.glyphs[1]!.advance).toBe(20)
    expect(reflowSnapshot(snapshot, 400).glyphs.map(({ originX }) => originX)).toEqual([0, 10, 0])
  })

  it('keeps an emoji that starts a line off the line before it, under a tight line-height', () => {
    const root = tightFixture('A 👍B', [
      tight(0, 0),
      tight(10, 0, 4),
      tight(0, 1, 20),
      null,
      tight(20, 1),
    ])
    const snapshot = collectDomSnapshot(root, { includeRootBackground: false })
    expect(snapshot.lineCount).toBe(2)
    expect(snapshot.glyphs.map(({ lineBottom }) => lineBottom)).toEqual([18, -2, -2])
    expect(snapshot.glyphs.map(({ breakBefore }) => breakBefore)).toEqual(['soft', 'soft', 'none'])
    expect(snapshot.glyphs[0]!.advance).toBe(10)
    expect(reflowSnapshot(snapshot, 400).glyphs.map(({ originX }) => originX)).toEqual([0, 0, 20])
  })

  it('reserves whole extra emoji sequences and preserves reshape and CJK breaks', () => {
    const snapshot = collectDomSnapshot(fixture('日👍🏽本'), {
      cjkLineBreaking: true,
      reshape: (text) => text,
      extraGlyphs: '❤\uFE0F x',
    })
    expect(snapshot.glyphs).toHaveLength(3)
    expect(snapshot.glyphs.map((glyph) => glyph.breakBefore)).toEqual(['soft', 'soft', 'soft'])
    expect(snapshot.requests.map((request) => request.character)).toEqual(
      expect.arrayContaining(['👍🏽', '❤\uFE0F', 'x']),
    )
    expect(snapshot.requests.some((request) => request.character === '🏽')).toBe(false)
  })

  it('does not expand non-emoji extraGlyphs into pure emoji font families', () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.innerHTML =
      '<p data-sdf-block>' +
      '<span id="t" style="font-family: Inter, sans-serif">12</span>' +
      '<span id="e" style="font-family: \'Apple Color Emoji\', \'Noto Color Emoji\'">🎨</span>' +
      '</p>'
    const p = root.firstElementChild!
    const textSpan = root.querySelector('#t')!
    const emojiSpan = root.querySelector('#e')!
    for (const element of [root, p, textSpan, emojiSpan])
      setBox(element, { left: 0, top: 0, width: 200, height: 40 })
    installRangeLayout(
      new Map([
        [textSpan.firstChild as Text, { left: 0, top: 0, width: 20, height: 20 }],
        [emojiSpan.firstChild as Text, { left: 20, top: 0, width: 20, height: 20 }],
      ]),
    )
    const snapshot = collectDomSnapshot(root, { extraGlyphs: '0123456789.ms 🚀' })
    const emojiFontRequests = snapshot.requests.filter((r) => /emoji/i.test(r.font.family))
    expect(emojiFontRequests.map((r) => r.character)).toEqual(['🎨', '🚀'])
    const textFontRequests = snapshot.requests.filter((r) => !/emoji/i.test(r.font.family))
    expect(textFontRequests.map((r) => r.character)).toEqual(
      expect.arrayContaining(['0', '1', '2', '9', '.', 'm', 's', '🚀']),
    )
  })

  it('supports visibility:collapse, visible children of hidden blocks, font-variant-caps, border:hidden, and relative em/unitless lengths', () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'background: #112233; font-size: 20px; border-top-left-radius: 0.5em'
    root.innerHTML =
      '<p data-sdf-block style="visibility: hidden; font-size: 20px; line-height: 1.5; border: 10px hidden red; padding-left: 4px">' +
      'hidden' +
      '<span id="vis" style="visibility: visible; font-variant-caps: all-small-caps">OK</span>' +
      '<span id="col" style="visibility: collapse">no</span>' +
      '</p>'
    const p = root.firstElementChild!
    const vis = root.querySelector('#vis')!
    const col = root.querySelector('#col')!
    for (const element of [root, p, vis, col])
      setBox(element, { left: 0, top: 0, width: 100, height: 40 })
    installRangeLayout(
      new Map([
        [p.firstChild as Text, { left: 0, top: 0, width: 40, height: 20 }],
        [vis.firstChild as Text, { left: 4, top: 0, width: 20, height: 20 }],
        [col.firstChild as Text, { left: 24, top: 0, width: 20, height: 20 }],
      ]),
    )
    const snapshot = collectDomSnapshot(root)
    expect(snapshot.glyphs.map((g) => g.glyphKey.split('\u0000')[1])).toEqual(['O', 'K'])
    expect(snapshot.requests[0]!.font.variant).toBe('all-small-caps')
    expect(snapshot.blocks[0]).toMatchObject({ left: 4, width: 96, linePitch: 30 })
    expect(snapshot.rects[0]!.radius).toBe(10)
  })

  it('breaks CJK supplementary ideographs, compatibility ideographs, halfwidth kana, Hangul, and Kinsoku marks', async () => {
    // 𠮷 (U+20BB7 Extension B), 﨑 (U+FA11 Compatibility Ideograph), prolonged sound mark ー,
    // iteration mark 々, smart quotes “”, halfwidth katakana ｶﾀ, and Korean Hangul 한글.
    const text = '𠮷野“﨑々”ーｶﾀ 한글!'
    const root = fixture(text)
    const snapshot = collectDomSnapshot(root, { cjkLineBreaking: true })
    expect(snapshot.glyphs.map((g) => g.glyphKey.split('\u0000')[1])).toEqual([
      '𠮷',
      '野',
      '“',
      '﨑',
      '々',
      '”',
      'ー',
      'ｶ',
      'ﾀ',
      '한',
      '글',
      '!',
    ])
    // Breaks before 野, “, ｶ, ﾀ, 한, 글; forbidden before 﨑 (after opening “), 々, ”, ー, and !.
    expect(snapshot.glyphs.map((g) => g.breakBefore)).toEqual([
      'soft',
      'soft',
      'soft',
      'none',
      'none',
      'none',
      'none',
      'soft',
      'soft',
      'soft',
      'soft',
      'none',
    ])

    // Without cjkLineBreaking, Korean space-delimited words keep syllables together (keep-all).
    const keepAll = collectDomSnapshot(root)
    expect(keepAll.glyphs.slice(-3).map((g) => g.breakBefore)).toEqual(['soft', 'none', 'none'])

    // Pretext shares the same CJK and Kinsoku rules.
    const canvas = pretextContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas)
    const pretextSnap = await collectDomSnapshot(root, {
      layoutEngine: 'pretext',
      cjkLineBreaking: true,
    })
    expect(pretextSnap.glyphs.map((g) => g.breakBefore)).toEqual(
      snapshot.glyphs.map((g) => g.breakBefore),
    )
  })

  it('captures and reflows vocalized Arabic RTL words with harakat combining marks', () => {
    // 'بَ جَ' in RTL: 'ب' (left 90, width 10), fatha U+064E (collapsed), space, 'ج' (left 74, width 10), fatha U+064E (collapsed)
    const root = fixture('ب\u064e ج\u064e', [
      { left: 90, top: 0, width: 10, height: 20 },
      null,
      null,
      { left: 74, top: 0, width: 10, height: 20 },
      null,
    ])
    const block = root.firstElementChild as HTMLElement
    block.style.direction = 'rtl'
    setBox(root, { left: 0, top: 0, width: 100, height: 40 })
    setBox(block, { left: 0, top: 0, width: 100, height: 20 })

    const snapshot = collectDomSnapshot(root, { includeRootBackground: false, rtlReflow: true })
    expect(snapshot.blocks[0]?.direction).toBe('rtl')
    expect(snapshot.glyphs.map((g) => g.decorationWidth)).toEqual([10, 0, 10, 0])
    expect(snapshot.glyphs.map((g) => g.originX)).toEqual([90, 100, 74, 84])

    // Reflowing at the captured width preserves exact positions and inter-word gap (6).
    const same = reflowSnapshot(snapshot, 100)
    expect(same.glyphs.map((g) => g.originX)).toEqual([90, 100, 74, 84])

    // Reflowing narrower wraps the second vocalized Arabic word onto line 2 flush right.
    const narrow = reflowSnapshot(snapshot, 20)
    expect(narrow.lineCount).toBe(2)
    expect(narrow.glyphs.map((g) => g.originX)).toEqual([10, 20, 10, 20])
  })

  it('retains collapsed combining marks and keys CJK/Arabic descents by language in browser shaping', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 16px sans-serif; color: #fff'
    root.innerHTML =
      '<p data-sdf-block lang="ar" style="direction: rtl">ب\u061c\u064e\u200cت</p>' +
      '<p data-sdf-block lang="zh-Hans">直</p>' +
      '<p data-sdf-block lang="ja">直</p>'
    setBox(root, { left: 0, top: 0, width: 200, height: 120 })
    const [ar, zh, ja] = Array.from(root.children) as HTMLElement[]
    setBox(ar!, { left: 0, top: 0, width: 100, height: 20 })
    setBox(zh!, { left: 0, top: 40, width: 100, height: 20 })
    setBox(ja!, { left: 0, top: 80, width: 100, height: 20 })
    installPerCharacterLayout(
      new Map([
        // Simulate a collapsed ALM (U+061C) and combining mark/joiner (U+064E U+200C) inside an Arabic run.
        [
          ar!.firstChild as Text,
          [
            { left: 80, top: 0, width: 10, height: 20 },
            null,
            null,
            null,
            { left: 70, top: 0, width: 10, height: 20 },
          ],
        ],
        [zh!.firstChild as Text, [{ left: 0, top: 40, width: 16, height: 20 }]],
        [ja!.firstChild as Text, [{ left: 0, top: 80, width: 16, height: 20 }]],
      ]),
    )
    const canvas = pretextContext()
    Object.assign(canvas, { lang: 'inherit' })
    canvas.measureText = vi.fn(() => ({
      width: 16,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: (canvas as unknown as { lang: string }).lang === 'ja' ? 6 : 4,
    })) as unknown as typeof canvas.measureText
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas)

    const snapshot = await collectDomSnapshot(root, {
      textShaping: 'browser',
      includeRootBackground: false,
    })
    expect(snapshot.requests.find((r) => r.shaping?.language === 'ar')?.character).toBe(
      'ب\u061c\u064e\u200cت',
    )
    expect(snapshot.glyphs[1]!.baselineOffset).toBe(4)
    expect(snapshot.glyphs[2]!.baselineOffset).toBe(6)
  })

  it('forwards word-break: keep-all and white-space: pre-wrap to Pretext 1.0.0 rich inline layout', async () => {
    const root = document.body.appendChild(document.createElement('section'))
    root.style.cssText = 'font: 16px sans-serif; color: #fff'
    root.innerHTML =
      '<p data-sdf-block style="word-break: normal">일 이삼 오</p>' +
      '<p data-sdf-block style="word-break: keep-all">일 이삼 오</p>' +
      '<p data-sdf-block style="white-space: pre-wrap">A\nB   C</p>'
    setBox(root, { left: 0, top: 0, width: 200, height: 120 })
    const [normalBlock, keepAllBlock, preWrapBlock] = Array.from(root.children) as HTMLElement[]
    setBox(normalBlock!, { left: 0, top: 0, width: 35, height: 60 })
    setBox(keepAllBlock!, { left: 0, top: 60, width: 35, height: 60 })
    setBox(preWrapBlock!, { left: 0, top: 120, width: 200, height: 40 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(pretextContext())

    const snapshot = await collectDomSnapshot(root, {
      layoutEngine: 'pretext',
      includeRootBackground: false,
    })
    const blockLines = (block: number) =>
      new Set(snapshot.glyphs.filter((g) => g.block === block).map((g) => g.lineBottom)).size
    // At width 35px (10px per glyph/space), word-break: normal fits '일 이' + '삼 오' on 2 lines,
    // whereas word-break: keep-all keeps '이삼' unbroken across lines ('일' / '이삼' / '오' = 3 lines).
    expect(blockLines(0)).toBe(2)
    expect(blockLines(1)).toBe(3)
    // white-space: pre-wrap preserves both the newline and the 3 spaces between B and C.
    expect(blockLines(2)).toBe(2)
    expect(snapshot.lineCount).toBe(7)
    const preGlyphs = snapshot.glyphs.filter((g) => g.block === 2)
    expect(preGlyphs.map((g) => g.glyphKey.slice(-1))).toEqual(['A', 'B', 'C'])
    expect(preGlyphs[2]!.originX - preGlyphs[1]!.originX).toBeGreaterThan(25)
  })
})
