import { describe, expect, it } from 'vitest'

import { reflowSnapshot } from '../src/text/reflow.js'
import type { DomLayoutSnapshot, GlyphLayout } from '../src/types.js'

const ADVANCE = 10
const SPACE = 6
const PITCH = 20

/**
 * Lays out words the way a browser would at `width`, so the fixture itself is a
 * captured snapshot rather than hand-written numbers.
 */
function capture(words: readonly string[], width: number, blockLeft = 0): DomLayoutSnapshot {
  const glyphs: GlyphLayout[] = []
  const firstBaseline = 100
  let line = 0
  let penX = 0
  let lineHasWord = false

  for (const word of words) {
    const hard = word.startsWith('\n')
    const text = hard ? word.slice(1) : word
    const wordWidth = text.length * ADVANCE
    if (lineHasWord && (hard || penX + SPACE + wordWidth > width)) {
      line++
      penX = 0
      lineHasWord = false
    }
    const x = lineHasWord ? penX + SPACE : 0
    for (const [index, character] of Array.from(text).entries()) {
      glyphs.push({
        glyphKey: `face\u0000${character}`,
        fontSize: 16,
        originX: blockLeft + x + index * ADVANCE,
        lineBottom: firstBaseline - line * PITCH,
        advance: ADVANCE,
        block: 0,
        breakBefore: index === 0 ? (hard ? 'hard' : 'soft') : 'none',
        clip: [blockLeft, 0, blockLeft + width, 120],
        color: [1, 1, 1, 1],
        sequence: index,
        z: 0,
      })
    }
    penX = x + wordWidth
    lineHasWord = true
  }

  return {
    width,
    height: 120,
    glyphs,
    rects: [],
    blocks: [
      {
        left: blockLeft,
        firstBaseline,
        linePitch: PITCH,
        width,
        clip: [blockLeft, 0, blockLeft + width, 120],
      },
    ],
    requests: [],
    atlasSignature: 'face',
    lineCount: line + 1,
  }
}

function lines(snapshot: DomLayoutSnapshot): string[] {
  const byLine = new Map<number, GlyphLayout[]>()
  for (const glyph of snapshot.glyphs) {
    const bucket = byLine.get(glyph.lineBottom)
    if (bucket) bucket.push(glyph)
    else byLine.set(glyph.lineBottom, [glyph])
  }
  return [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, glyphs]) =>
      glyphs
        .slice()
        .sort((a, b) => a.originX - b.originX)
        .map((glyph) => glyph.glyphKey.slice(-1))
        .join(''),
    )
}

describe('reflowSnapshot', () => {
  it('preserves shaped runs at the captured width and requests a rebuild for other widths', () => {
    const snapshot = { ...capture(['hello'], 200), textShaping: 'browser' as const }
    expect(reflowSnapshot(snapshot, 200)).toBe(snapshot)
    expect(() => reflowSnapshot(snapshot, 100)).toThrow('requires a DOM rebuild')
  })
  it('reproduces the captured layout exactly when reflowed to the captured width', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    const captured = capture(words, 200)
    const reflowed = reflowSnapshot(captured, 200)

    expect(lines(reflowed)).toEqual(lines(captured))
    expect(reflowed.height).toBe(captured.height)
    expect(reflowed.glyphs).toHaveLength(captured.glyphs.length)
    for (const [index, glyph] of reflowed.glyphs.entries()) {
      const original = captured.glyphs[index]!
      expect(glyph.originX).toBeCloseTo(original.originX, 6)
      expect(glyph.lineBottom).toBeCloseTo(original.lineBottom, 6)
    }
  })

  it.each([
    [100, [8, 75, 114, 120], 2],
    [60, [8, 75, 74, 140], 3],
    [200, [8, 75, 214, 100], 1],
  ])(
    'preserves visible text clip margins when reflowing to %s units',
    (width, expected, lineCount) => {
      const initial = capture(['alpha', 'beta', 'gamma'], 100, 10)
      const glyphClip = [8, 75, 114, 120] as const
      const captured: DomLayoutSnapshot = {
        ...initial,
        blocks: [{ ...initial.blocks[0]!, clip: [10, 77, 110, 116] }],
        glyphs: initial.glyphs.map((glyph) => ({ ...glyph, clip: glyphClip })),
      }
      const before = structuredClone(captured)

      const reflowed = reflowSnapshot(captured, width)

      expect(reflowed.lineCount).toBe(lineCount)
      expect(reflowed.glyphs[0]!.clip).toEqual(expected)
      for (const glyph of reflowed.glyphs) {
        expect(glyph.clip).toBe(reflowed.glyphs[0]!.clip)
        expect(glyph.clip.every(Number.isFinite)).toBe(true)
        expect(glyph.lineBottom).toBeGreaterThanOrEqual(glyph.clip[1])
      }
      expect(captured).toEqual(before)
    },
  )

  it('re-wraps to a narrower measure and grows the reported height', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    const captured = capture(words, 200)
    const narrow = reflowSnapshot(captured, 110)

    expect(lines(captured).length).toBeLessThan(lines(narrow).length)
    expect(narrow.lineCount).toBe(lines(narrow).length)
    expect(narrow.height).toBeGreaterThan(captured.height)
    // Nothing is dropped and nothing overflows the new measure.
    expect(narrow.glyphs).toHaveLength(captured.glyphs.length)
    for (const glyph of narrow.glyphs) {
      expect(glyph.originX + glyph.advance).toBeLessThanOrEqual(110 + 1e-6)
    }
    // The same words, in the same order, just broken differently.
    expect(lines(narrow).join('')).toBe(lines(captured).join(''))
  })

  it('re-wraps to a wider measure and keeps the words in order', () => {
    const captured = capture(['alpha', 'beta', 'gamma', 'delta'], 110)
    const wide = reflowSnapshot(captured, 400)

    expect(lines(wide)).toEqual(['alphabetagammadelta'])
    expect(lines(wide).join('')).toBe(lines(captured).join(''))
  })

  it('keeps a forced break across re-wrapping', () => {
    const captured = capture(['alpha', '\nbeta'], 400)
    expect(lines(captured)).toEqual(['alpha', 'beta'])

    const wide = reflowSnapshot(captured, 4000)
    expect(lines(wide)).toEqual(['alpha', 'beta'])
  })

  it('keeps an oversized word intact and places a final single glyph after its measured gap', () => {
    const captured = capture(['oversized', 'x'], 400)
    const narrow = reflowSnapshot(captured, 20)
    expect(lines(narrow)).toEqual(['oversized', 'x'])
    expect(narrow.glyphs.at(-1)).toMatchObject({ originX: 0, sequence: 0 })
    const wide = reflowSnapshot(captured, 400)
    expect(wide.glyphs.at(-1)).toMatchObject({ originX: 96, sequence: 9 })
  })

  it('renumbers the stagger sequence per re-wrapped line', () => {
    const captured = capture(['alpha', 'beta', 'gamma', 'delta'], 200)
    const narrow = reflowSnapshot(captured, 110)

    // Slide staggering reads the per-line index; after moving glyphs to new
    // lines, every line must count 0..n-1 again instead of keeping the
    // captured order.
    const byLine = new Map<number, number[]>()
    for (const glyph of narrow.glyphs) {
      const bucket = byLine.get(glyph.lineBottom)
      if (bucket) bucket.push(glyph.sequence)
      else byLine.set(glyph.lineBottom, [glyph.sequence])
    }
    expect(byLine.size).toBeGreaterThan(1)
    for (const sequences of byLine.values()) {
      expect(sequences).toEqual(sequences.map((_, index) => index))
    }
  })

  it('honours each block inset instead of snapping every block to one measure', () => {
    const captured = capture(['alpha', 'beta'], 120, 40)
    const reflowed = reflowSnapshot(captured, 220)

    // The block keeps its 40-unit inset and widens by the same delta as the root.
    expect(reflowed.glyphs[0]!.originX).toBe(40)
    expect(reflowed.blocks[0]!.left).toBe(40)
  })

  it('rejects a non-positive width and still updates an empty capture width', () => {
    const captured = capture(['alpha'], 200)
    expect(() => reflowSnapshot(captured, 0)).toThrow('positive finite')
    expect(() => reflowSnapshot(captured, Number.NaN)).toThrow('positive finite')

    const empty: DomLayoutSnapshot = { ...captured, glyphs: [] }
    expect(reflowSnapshot(empty, 999)).toMatchObject({ width: 999, glyphs: [], lineCount: 0 })
  })

  it('shares one clip per block and shifts it once without mutating the capture', () => {
    const first = capture(['alpha', 'beta'], 200)
    const second = capture(['gamma', 'delta'], 200, 10)
    const captured: DomLayoutSnapshot = {
      ...first,
      glyphs: [
        ...first.glyphs,
        ...second.glyphs.map((glyph) => ({ ...glyph, block: 1, lineBottom: 60 })),
      ],
      blocks: [first.blocks[0]!, { ...second.blocks[0]!, firstBaseline: 60 }],
      lineCount: 2,
    }
    const before = structuredClone(captured)
    const narrow = reflowSnapshot(captured, 60)

    expect(narrow.lineCount).toBe(4)
    expect(narrow.height).toBe(160)
    const firstClip = narrow.glyphs[0]!.clip
    const secondClip = narrow.glyphs[first.glyphs.length]!.clip
    expect(firstClip).toEqual([0, 100, 60, 160])
    expect(secondClip).toEqual([10, 40, 70, 140])
    expect(firstClip).not.toBe(secondClip)
    for (const glyph of narrow.glyphs) {
      expect(glyph.clip).toBe(glyph.block === 0 ? firstClip : secondClip)
    }
    expect(captured).toEqual(before)
    expect(reflowSnapshot(captured, 60)).toEqual(narrow)
  })

  it('shifts fallback clips independently when a preceding block grows', () => {
    const first = capture(['alpha', 'beta'], 200)
    const captured: DomLayoutSnapshot = {
      ...first,
      glyphs: [
        ...first.glyphs,
        ...first.glyphs.slice(0, 2).map((glyph) => ({ ...glyph, block: 1, lineBottom: 40 })),
      ],
    }
    const before = structuredClone(captured)
    const narrow = reflowSnapshot(captured, 60)
    for (const glyph of narrow.glyphs.slice(first.glyphs.length)) {
      expect(glyph.lineBottom).toBe(60)
      expect(glyph.clip).toEqual([0, 20, 200, 140])
    }
    expect(captured).toEqual(before)
  })

  it('wraps CJK characters across lines without artificial space gaps', () => {
    const glyphs: GlyphLayout[] = ['東', '京', '日', '本'].map((c, i) => ({
      glyphKey: `face\u0000${c}`,
      fontSize: 16,
      originX: i * 16,
      lineBottom: 100,
      advance: 16,
      block: 0,
      breakBefore: i === 0 ? 'none' : 'soft',
      clip: [0, 0, 100, 100],
      color: [1, 1, 1, 1],
      sequence: i,
      z: 0,
    }))
    const snapshot: DomLayoutSnapshot = {
      width: 100,
      height: 100,
      glyphs,
      rects: [],
      blocks: [
        {
          left: 0,
          firstBaseline: 100,
          linePitch: 20,
          width: 100,
          clip: [0, 0, 100, 100],
        },
      ],
      requests: [],
      atlasSignature: 'face',
      lineCount: 1,
    }

    const reflowed = reflowSnapshot(snapshot, 35)
    expect(reflowed.glyphs[0]?.originX).toBe(0)
    expect(reflowed.glyphs[1]?.originX).toBe(16)
    expect(reflowed.glyphs[2]?.originX).toBe(0)
    expect(reflowed.glyphs[3]?.originX).toBe(16)
  })

  it('lays out right-to-left blocks with inverted originX alignment', () => {
    const words = ['hello']
    const captured = capture(words, 200)
    const rtlSnapshot: DomLayoutSnapshot = {
      ...captured,
      blocks: [
        {
          ...captured.blocks[0]!,
          direction: 'rtl',
        },
      ],
    }

    const reflowed = reflowSnapshot(rtlSnapshot, 200)
    expect(reflowed.glyphs[0]?.originX).toBe(150)
  })

  it('reflows captured RTL advances within the block and keeps word spacing', () => {
    const captured = capture(['اب', 'جد'], 100)
    const rtl: DomLayoutSnapshot = {
      ...captured,
      blocks: captured.blocks.map((block) => ({ ...block, direction: 'rtl' })),
      glyphs: captured.glyphs.map((glyph, index) => ({
        ...glyph,
        originX: 90 - glyph.originX,
        decorationWidth: 10,
        advance: [-10, -16, -10, 10][index]!,
      })),
    }
    expect(reflowSnapshot(rtl, 100).glyphs.map((g) => g.originX)).toEqual([90, 80, 64, 54])
    expect(reflowSnapshot(rtl, 25).glyphs.map((g) => g.originX)).toEqual([15, 5, 15, 5])
    expect(reflowSnapshot(rtl, 25).lineCount).toBe(2)
  })

  it('removes cross-line gaps only when capture explicitly recorded a CJK break', () => {
    const captured = capture(['東', '京'], 10)
    const plain = reflowSnapshot(captured, 100)
    expect(plain.glyphs[1]!.originX).toBeCloseTo(10 + 16 * 0.26)
    const cjk: DomLayoutSnapshot = {
      ...captured,
      glyphs: captured.glyphs.map((g) => ({ ...g, gapBefore: 0 })),
    }
    expect(reflowSnapshot(cjk, 100).glyphs[1]!.originX).toBe(10)
  })

  it('reflows center, right, and justify aligned blocks without DOM re-reads', () => {
    // 'alpha' (50) + space (6) + 'beta' (40) = 96 on line 0 when width is 120; 'gamma' (50) on line 1.
    const centered = reflowSnapshot(rangeCapture(['alpha', 'beta', 'gamma'], 200, 'center'), 120)
    // Line 0 slack = 120 - 96 = 24 -> shift = +12. Line 1 slack = 120 - 50 = 70 -> shift = +35.
    expect(centered.glyphs[0]!.originX).toBeCloseTo(12)
    expect(centered.glyphs[5]!.originX).toBeCloseTo(12 + 56)
    expect(centered.glyphs[9]!.originX).toBeCloseTo(35)

    const rightAligned = reflowSnapshot(rangeCapture(['alpha', 'beta', 'gamma'], 200, 'right'), 120)
    expect(rightAligned.glyphs[0]!.originX).toBeCloseTo(24)
    expect(rightAligned.glyphs[5]!.originX).toBeCloseTo(24 + 56)
    expect(rightAligned.glyphs[9]!.originX).toBeCloseTo(70)

    // Captured on one line, which a justified block leaves at its natural spacing.
    const justified = reflowSnapshot(rangeCapture(['alpha', 'beta', 'gamma'], 200, 'justify'), 120)
    // Line 0 has 2 words ('alpha', 'beta'), slack = 24, so 'alpha' starts at 0 and 'beta' shifts by +24 -> 56 + 24 = 80 (ends at 120).
    // Line 1 is the final line ('gamma'), so it stays at 0.
    expect(justified.glyphs[0]!.originX).toBeCloseTo(0)
    expect(justified.glyphs[5]!.originX).toBeCloseTo(80)
    expect(justified.glyphs[9]!.originX).toBeCloseTo(0)
  })
})

type Side = NonNullable<DomLayoutSnapshot['blocks'][number]['textAlign']>

/**
 * Lays words out as a browser would at `width` under CSS `text-align` (`align`, a physical
 * side) and `text-align-last`, and records them as a Range capture does: each advance reaches
 * the next glyph's origin on its line, across a space and a justified line's expansion too; a
 * word's last glyph keeps its own width; and the natural space is recorded before the first
 * word of each captured line, and before every word of a justified block. A word written with
 * a leading '\n' follows a forced break. `rtl` lays the lines from the right as `rtlReflow`
 * captures them: in logical order, with every glyph's own width.
 */
function rangeCapture(
  words: readonly string[],
  width: number,
  align: Side = 'left',
  { alignLast, rtl = false }: { readonly alignLast?: Side; readonly rtl?: boolean } = {},
): DomLayoutSnapshot {
  const start: Side = rtl ? 'right' : 'left'
  const lines: { text: string; hard: boolean }[][] = [[]]
  let pen = 0
  for (const word of words) {
    const hard = word.startsWith('\n')
    const text = hard ? word.slice(1) : word
    const line = lines.at(-1)!
    if (line.length && (hard || pen + SPACE + text.length * ADVANCE > width)) {
      lines.push([{ text, hard }])
      pen = text.length * ADVANCE
    } else {
      pen = line.length ? pen + SPACE + text.length * ADVANCE : text.length * ADVANCE
      line.push({ text, hard })
    }
  }
  const justified = align === 'justify' || alignLast === 'justify'
  const glyphs: { -readonly [K in keyof GlyphLayout]: GlyphLayout[K] }[] = []
  for (const [lineIndex, line] of lines.entries()) {
    const final = lineIndex === lines.length - 1 || lines[lineIndex + 1]![0]!.hard
    const side = final ? (alignLast ?? (align === 'justify' ? start : align)) : align
    const natural = line.reduce((sum, { text }) => sum + text.length * ADVANCE, 0)
    const slack = width - natural - (line.length - 1) * SPACE
    const gap = side === 'justify' && line.length > 1 ? SPACE + slack / (line.length - 1) : SPACE
    // Distance from the line's start edge: the left, or the right of an RTL line.
    let along = side === 'center' ? slack / 2 : side !== start && side !== 'justify' ? slack : 0
    const lineBottom = 100 - lineIndex * PITCH
    for (const [wordIndex, { text, hard }] of line.entries()) {
      for (let index = 0; index < text.length; index++) {
        const previous = glyphs.at(-1)
        const originX = rtl ? width - along - (index + 1) * ADVANCE : along + index * ADVANCE
        if (previous?.lineBottom === lineBottom) {
          if (index === 0 && !rtl) previous.decorationWidth = ADVANCE
          previous.advance = originX - previous.originX
        }
        glyphs.push({
          glyphKey: `face\u0000${text[index]}`,
          fontSize: 16,
          originX,
          lineBottom,
          advance: ADVANCE,
          block: 0,
          breakBefore: index > 0 ? 'none' : hard ? 'hard' : 'soft',
          clip: [0, 0, width, 120],
          color: [1, 1, 1, 1],
          sequence: glyphs.length,
          z: 0,
          ...(index === 0 && !hard && glyphs.length && (justified || wordIndex === 0)
            ? { gapBefore: SPACE }
            : {}),
          ...(rtl ? { decorationWidth: ADVANCE } : {}),
        })
      }
      along += text.length * ADVANCE + gap
    }
  }
  const lastSide = alignLast ?? (align === 'justify' ? start : align)
  const derived = align === 'justify' ? start : align
  return {
    width,
    height: 120,
    glyphs,
    rects: [],
    blocks: [
      {
        left: 0,
        firstBaseline: 100,
        linePitch: PITCH,
        width,
        clip: [0, 0, width, 120],
        ...(rtl ? { direction: 'rtl' as const } : {}),
        ...(lastSide !== derived
          ? { textAlign: align, textAlignLast: lastSide }
          : align !== start
            ? { textAlign: align }
            : {}),
      },
    ],
    requests: [],
    atlasSignature: 'face',
    lineCount: lines.length,
  }
}

/** The ink edges of each output line, top to bottom: every fixture glyph is ADVANCE wide. */
function lineEdges(snapshot: DomLayoutSnapshot): { left: number; right: number }[] {
  const byLine = new Map<number, number[]>()
  for (const glyph of snapshot.glyphs) {
    byLine.set(glyph.lineBottom, [...(byLine.get(glyph.lineBottom) ?? []), glyph.originX])
  }
  return [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, xs]) => ({ left: Math.min(...xs), right: Math.max(...xs) + ADVANCE }))
}

function expectEdges(edge: { left: number; right: number }, left: number, right: number): void {
  expect(edge.left).toBeCloseTo(left, 6)
  expect(edge.right).toBeCloseTo(right, 6)
}

const PROSE = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota']

describe('reflowSnapshot alignment', () => {
  it.each([
    ['left', false],
    ['center', false],
    ['right', false],
    ['justify', false],
    ['left', true],
    ['center', true],
    ['right', true],
    ['justify', true],
  ] as const)(
    'reflows %s-aligned text (rtl: %s) where a capture at the new width puts it',
    (align, rtl) => {
      const captured = rangeCapture(PROSE, 200, align, { rtl })
      for (const width of [200, 130, 170, 260, 410, 90]) {
        const reflowed = reflowSnapshot(captured, width)
        const truth = rangeCapture(PROSE, width, align, { rtl })
        expect(reflowed.lineCount).toBe(truth.lineCount)
        for (const [index, glyph] of truth.glyphs.entries()) {
          // Reflow keeps the top edge where it was and lets new lines extend the bottom.
          const placed = reflowed.glyphs[index]!
          expect(reflowed.height - placed.lineBottom).toBe(truth.height - glyph.lineBottom)
          expect(placed.originX).toBeCloseTo(glyph.originX, 6)
        }
      }
    },
  )

  it('ends right-aligned lines flush and centres lines by their ink after a re-wrap', () => {
    // Most of these lines end on a word the capture had followed by a space on its line.
    for (const edge of lineEdges(reflowSnapshot(rangeCapture(PROSE, 200, 'right'), 130))) {
      expect(edge.right).toBeCloseTo(130)
    }
    const centred = lineEdges(reflowSnapshot(rangeCapture(PROSE, 200, 'center'), 130))
    expect(centred.length).toBeGreaterThan(2)
    for (const edge of centred) expect(edge.left).toBeCloseTo(130 - edge.right)
  })

  it('wraps by ink, so the space after a line-ending word hangs past the measure', () => {
    // 'alpha' (50) + space (6) + 'beta' (40) is exactly 96; the space after 'beta' is not.
    expect(lines(reflowSnapshot(rangeCapture(['alpha', 'beta', 'gamma'], 200), 96))).toEqual([
      'alphabeta',
      'gamma',
    ])
  })

  it('justifies every line edge to edge but the last, a line before a forced break and a lone word', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', '\nepsilon', 'zeta', 'longestword', 'eta']
    const reflowed = reflowSnapshot(rangeCapture(words, 200, 'justify'), 130)
    expect(lines(reflowed)).toEqual([
      'alphabeta',
      'gammadelta',
      'epsilonzeta',
      'longestword',
      'eta',
    ])
    const edges = lineEdges(reflowed)
    expectEdges(edges[0]!, 0, 130)
    expectEdges(edges[2]!, 0, 130)
    // The line before the forced break, the word alone on its line and the last line keep
    // their natural spacing on the start edge.
    expectEdges(edges[1]!, 0, 106)
    expectEdges(edges[3]!, 0, 110)
    expectEdges(edges[4]!, 0, 30)
  })

  it('aligns the last line by text-align-last', () => {
    const justifiedLast = lineEdges(
      reflowSnapshot(rangeCapture(PROSE, 200, 'justify', { alignLast: 'justify' }), 140),
    )
    expect(justifiedLast).toHaveLength(4)
    for (const edge of justifiedLast) expectEdges(edge, 0, 140)
    const centredLast = lineEdges(
      reflowSnapshot(rangeCapture(PROSE, 200, 'left', { alignLast: 'center' }), 130),
    )
    for (const edge of centredLast.slice(0, -1)) expect(edge.left).toBe(0)
    expectEdges(centredLast.at(-1)!, 45, 85)
  })

  it('aligns RTL lines to the end and the centre, and justifies them from the right', () => {
    const end = lineEdges(reflowSnapshot(rangeCapture(PROSE, 200, 'left', { rtl: true }), 130))
    for (const edge of end) expect(edge.left).toBeCloseTo(0)
    const centred = lineEdges(
      reflowSnapshot(rangeCapture(PROSE, 200, 'center', { rtl: true }), 130),
    )
    for (const edge of centred) expect(edge.left).toBeCloseTo(130 - edge.right)
    const justified = lineEdges(
      reflowSnapshot(rangeCapture(PROSE, 200, 'justify', { rtl: true }), 130),
    )
    for (const edge of justified.slice(0, -1)) expectEdges(edge, 0, 130)
    // The last line starts on the right.
    expectEdges(justified.at(-1)!, 90, 130)
  })

  it('keeps a shape glued to its words when it justifies a line', () => {
    // 'ab<svg/>cd ef' justified at 100 over 'gh': the shape's first layer and the word after it
    // are soft breaks with no space, so only the space before 'ef' takes the 18 of slack.
    const base = {
      fontSize: 16,
      block: 0,
      clip: [0, 0, 100, 120] as const,
      color: [1, 1, 1, 1] as const,
      z: 0,
      lineBottom: 100,
    }
    const glyphs: GlyphLayout[] = [
      { ...base, glyphKey: 'f\u0000a', originX: 0, advance: 10, breakBefore: 'soft', sequence: 0 },
      { ...base, glyphKey: 'f\u0000b', originX: 10, advance: 10, breakBefore: 'none', sequence: 1 },
      {
        ...base,
        glyphKey: 'svg:0',
        shapeGroup: 0,
        originX: 20,
        advance: 16,
        breakBefore: 'soft',
        sequence: 2,
      },
      { ...base, glyphKey: 'f\u0000c', originX: 36, advance: 10, breakBefore: 'soft', sequence: 3 },
      {
        ...base,
        glyphKey: 'f\u0000d',
        originX: 46,
        advance: 34,
        decorationWidth: 10,
        breakBefore: 'none',
        sequence: 4,
      },
      {
        ...base,
        glyphKey: 'f\u0000e',
        originX: 80,
        advance: 10,
        breakBefore: 'soft',
        gapBefore: SPACE,
        sequence: 5,
      },
      { ...base, glyphKey: 'f\u0000f', originX: 90, advance: 10, breakBefore: 'none', sequence: 6 },
      {
        ...base,
        glyphKey: 'f\u0000g',
        originX: 0,
        lineBottom: 80,
        advance: 10,
        breakBefore: 'soft',
        gapBefore: SPACE,
        sequence: 0,
      },
      {
        ...base,
        glyphKey: 'f\u0000h',
        originX: 10,
        lineBottom: 80,
        advance: 10,
        breakBefore: 'none',
        sequence: 1,
      },
    ]
    const snapshot: DomLayoutSnapshot = {
      width: 100,
      height: 120,
      glyphs,
      rects: [],
      blocks: [
        {
          left: 0,
          firstBaseline: 100,
          linePitch: 20,
          width: 100,
          clip: [0, 0, 100, 120],
          textAlign: 'justify',
        },
      ],
      requests: [],
      atlasSignature: 'f',
      lineCount: 2,
    }
    const at = (width: number) => reflowSnapshot(snapshot, width).glyphs.map((g) => g.originX)
    expect(at(100)).toEqual([0, 10, 20, 36, 46, 80, 90, 0, 10])
    // One line at 150: the last, at natural spacing; the measured 0 gaps stay 0.
    expect(at(150)).toEqual([0, 10, 20, 36, 46, 62, 72, 88, 98])
  })

  it.each([
    ['left to right', false, [0, 10, 26, 36, 52, 62], [0, 10, 30, 40, 0, 10]],
    ['right to left', true, [90, 80, 64, 54, 38, 28], [40, 30, 10, 0, 40, 30]],
  ])(
    'justifies a no-break space inside a word, %s, and never breaks there',
    (_, rtl, wide, narrow) => {
      // 'ab cd' over 'ef', justified at 60 with a no-break space between 'b' and 'c': a 6-unit
      // space the line widened to 20. Each glyph is 10 wide.
      const lines = [
        ['a', 'b', 'c', 'd'],
        ['e', 'f'],
      ]
      const x = rtl ? [50, 40, 10, 0, 50, 40] : [0, 10, 40, 50, 0, 10]
      const glyphs: GlyphLayout[] = lines.flat().map((character, index) => {
        const next = x[index + 1]
        const lineEnd = index === 3 || index === 5
        return {
          glyphKey: `f\u0000${character}`,
          fontSize: 16,
          originX: x[index]!,
          lineBottom: index < 4 ? 100 : 80,
          advance: lineEnd ? 10 : next! - x[index]!,
          ...(rtl || index === 1 ? { decorationWidth: 10 } : {}),
          block: 0,
          breakBefore: index === 0 || index === 4 ? 'soft' : 'none',
          ...(index === 2 || index === 4 ? { gapBefore: 6 } : {}),
          clip: [0, 0, 60, 120],
          color: [1, 1, 1, 1],
          sequence: index < 4 ? index : index - 4,
          z: 0,
        }
      })
      const snapshot: DomLayoutSnapshot = {
        width: 60,
        height: 120,
        glyphs,
        rects: [],
        blocks: [
          {
            left: 0,
            firstBaseline: 100,
            linePitch: 20,
            width: 60,
            clip: [0, 0, 60, 120],
            textAlign: 'justify',
            ...(rtl ? { direction: 'rtl' as const } : {}),
          },
        ],
        requests: [],
        atlasSignature: 'f',
        lineCount: 2,
      }
      const at = (width: number) => reflowSnapshot(snapshot, width).glyphs.map((g) => g.originX)
      expect(at(60)).toEqual(x)
      // One last line at 100, at natural spacing; at 50 'ab cd' spreads 4 into its space.
      expect(at(100)).toEqual(wide)
      expect(at(50)).toEqual(narrow)
      expect(reflowSnapshot(snapshot, 30).lineCount).toBe(2)
    },
  )

  it('justifies opt-in CJK breaks, which have no space', () => {
    const glyphs: GlyphLayout[] = Array.from('東京日本語文字漢', (character, index) => {
      const line = Math.floor(index / 6)
      const column = index % 6
      // Six 16-unit characters fill 96 of 100: the first line spreads 4 over its 5 breaks.
      const step = line === 0 ? 16.8 : 16
      return {
        glyphKey: `face\u0000${character}`,
        fontSize: 16,
        originX: column * step,
        lineBottom: 100 - line * 20,
        advance: column < 5 && line === 0 ? step : 16,
        ...(column < 5 && line === 0 ? { decorationWidth: 16 } : {}),
        block: 0,
        breakBefore: 'soft' as const,
        gapBefore: 0,
        clip: [0, 0, 100, 120] as const,
        color: [1, 1, 1, 1] as const,
        sequence: column,
        z: 0,
      }
    })
    const snapshot: DomLayoutSnapshot = {
      width: 100,
      height: 120,
      glyphs,
      rects: [],
      blocks: [
        {
          left: 0,
          firstBaseline: 100,
          linePitch: 20,
          width: 100,
          clip: [0, 0, 100, 120],
          textAlign: 'justify',
        },
      ],
      requests: [],
      atlasSignature: 'face',
      lineCount: 2,
    }
    const same = reflowSnapshot(snapshot, 100).glyphs.map((g) => g.originX)
    same.forEach((x, index) => expect(x).toBeCloseTo(glyphs[index]!.originX))
    // Four characters (64) on each line at 70: 6 over 3 breaks; the last line keeps 16.
    const narrow = reflowSnapshot(snapshot, 70).glyphs.map((g) => g.originX)
    expect(narrow.slice(0, 4).map((x) => +x.toFixed(6))).toEqual([0, 18, 36, 54])
    expect(narrow.slice(4).map((x) => +x.toFixed(6))).toEqual([0, 16, 32, 48])
  })

  it('leaves a justified capture without natural spaces at its measured spacing', () => {
    // A capture taken where Canvas cannot measure (jsdom) records no word spaces to widen.
    const plain = capture(['alpha', 'beta', 'gamma'], 200)
    const justified = { ...plain, blocks: [{ ...plain.blocks[0]!, textAlign: 'justify' as const }] }
    expect(reflowSnapshot(justified, 120).glyphs.map((g) => g.originX)).toEqual(
      reflowSnapshot(plain, 120).glyphs.map((g) => g.originX),
    )
  })
})
