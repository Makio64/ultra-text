import type { DomLayoutSnapshot, GlyphLayout } from '../types.js'

/**
 * Re-wraps a captured snapshot to a new content width without touching the DOM.
 *
 * Every metric this needs was measured by the browser at capture time: per-glyph
 * advances (so kerning survives), each word's own width, the gaps the browser put
 * between words and the natural width of their spaces, and each block's baseline
 * pitch. Line breaking is then a greedy pass over those numbers, which is why it costs
 * no layout read, no font measurement and no atlas work. Words wrap by their own width
 * in the block's content box, the space after a line's last word hanging as in CSS.
 * Reflowing back to the captured width reproduces the captured positions, to the
 * layout's subpixel rounding where lines align. A capture made with `pixelSnap` is
 * re-wrapped from its unsnapped layout, and each glyph is then snapped where it lands.
 *
 * Each line aligns as its block's captured `text-align` and `text-align-last` say: to
 * the left, the right or the centre, by the ink of its words, or justified. A justified
 * line spreads its slack over its word spaces (and opt-in CJK breaks), never at a shape
 * glued to a word; a no-break space (U+00A0) is a word space it widens too, though no
 * line breaks there. The last line, and each line before a forced break, align by
 * `text-align-last`, or else on the start edge; a line of one word has no space to
 * spread and stays on the edge lines are laid from. Justification needs the natural word
 * spaces a browser capture records (Canvas measures them); a capture without them, such
 * as one taken in jsdom, keeps its justified blocks at their natural spacing.
 *
 * This is a block-flow model, not a CSS engine. `text-indent`, mixed font sizes on a
 * line (each block keeps one line pitch), hyphenation, bidi reordering within a line
 * and floats are not reproduced, and captured background rectangles keep their
 * captured geometry — only text moves.
 */
const rawOriginX = (glyph: GlyphLayout, grid: DomLayoutSnapshot['snapGrid']): number =>
  grid && glyph.snap ? glyph.originX - glyph.snap[0] : glyph.originX
const rawLineBottom = (glyph: GlyphLayout, grid: DomLayoutSnapshot['snapGrid']): number =>
  grid && glyph.snap ? glyph.lineBottom - glyph.snap[1] : glyph.lineBottom

export function reflowSnapshot(snapshot: DomLayoutSnapshot, width: number): DomLayoutSnapshot {
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError('reflowSnapshot: width must be a positive finite number')
  }
  if (snapshot.textShaping === 'browser') {
    if (width === snapshot.width) return snapshot
    throw new Error('reflowSnapshot: browser-shaped text requires a DOM rebuild to change width')
  }
  if (snapshot.glyphs.length === 0) return { ...snapshot, width, lineCount: 0 }

  const grid = snapshot.snapGrid
  const captured = snapshot.glyphs
  const widthDelta = width - snapshot.width
  type PlacedGlyph = { -readonly [K in keyof GlyphLayout]: GlyphLayout[K] } & {
    clip: [number, number, number, number]
  }
  const glyphs = new Array<PlacedGlyph>(captured.length)
  const clips: [number, number, number, number][] = []
  let flowShift = 0
  let cursor = 0
  let lineCount = 0

  while (cursor < captured.length) {
    const blockIndex = captured[cursor]!.block
    let end = cursor
    while (end < captured.length && captured[end]!.block === blockIndex) end++

    const block = snapshot.blocks[blockIndex]
    if (!block || block.linePitch <= 0) {
      for (let index = cursor; index < end; index++) {
        const glyph = captured[index]!
        const clip: [number, number, number, number] = [...glyph.clip]
        clips.push(clip)
        glyphs[index] = {
          ...glyph,
          originX: rawOriginX(glyph, grid),
          lineBottom: rawLineBottom(glyph, grid),
          clip,
        }
      }
      if (block?.linePitch !== 0) lineCount += countCapturedLines(captured, cursor, end, grid)
      cursor = end
      continue
    }

    const available = Math.max(1, block.width + widthDelta)
    const blockTop = block.clip[3] - flowShift
    const clip: [number, number, number, number] = [
      block.clip[0],
      0,
      block.clip[2] + available - block.width,
      blockTop,
    ]
    const capturedLines = countCapturedLines(captured, cursor, end, grid)
    let overflowClip: GlyphLayout['clip'] | undefined
    for (let index = cursor; index < end; index++) {
      const glyph = captured[index]!
      if (glyph.shapeGroup !== undefined) continue
      if (
        glyph.clip[0] < block.clip[0] ||
        glyph.clip[1] < block.clip[1] ||
        glyph.clip[2] > block.clip[2] ||
        glyph.clip[3] > block.clip[3]
      ) {
        overflowClip = glyph.clip
        clip[0] += glyph.clip[0] - block.clip[0]
        clip[2] += glyph.clip[2] - block.clip[2]
        clip[3] = glyph.clip[3] - flowShift
      }
      break
    }
    clips.push(clip)
    let line = 0
    let penX = 0
    let lineSequence = 0
    let lineStart = cursor
    let lineSpaces = 0
    const rtl = block.direction === 'rtl'
    const join = (index: number): number => {
      const left = captured[index - +!rtl]!
      return (
        captured[index]!.gapBefore! +
        rawOriginX(left, grid) +
        (left.decorationWidth ?? left.advance) -
        rawOriginX(captured[index - +rtl]!, grid)
      )
    }
    const align = block.textAlign
    const lastAlign = block.textAlignLast ?? (align === 'justify' ? undefined : align)
    const alignLine = (lineEnd: number, finalLine: boolean): void => {
      const side = finalLine ? lastAlign : align
      const slack = side ? available - penX : 0
      if (slack <= 0) return
      const dir = rtl ? -slack : slack
      if (side === 'justify') {
        const invSpaces = dir / lineSpaces
        for (let i = lineStart, spaces = 0; lineSpaces && i < lineEnd; i++) {
          if (i > lineStart && captured[i]!.gapBefore !== undefined) spaces++
          glyphs[i]!.originX += spaces * invSpaces
        }
      } else {
        const shift = side === 'center' ? dir * 0.5 : (side === 'right') !== rtl ? dir : 0
        if (shift) for (let i = lineStart; i < lineEnd; i++) glyphs[i]!.originX += shift
      }
    }

    let prevLeft = 0
    for (let start = cursor; start < end;) {
      const first = captured[start]!
      let wordEnd = start
      let wordWidth = 0
      let wordLeft = rawOriginX(first, grid)
      let wordRight = wordLeft
      let joined = 0
      let wordHasShape = false
      do {
        const glyph = captured[wordEnd++]!
        wordWidth += glyph.advance
        if (glyph.shapeGroup !== undefined) wordHasShape = true
        if (glyph.gapBefore !== undefined && wordEnd > start + 1) joined += join(wordEnd - 1)
        if (rtl) {
          const gx = rawOriginX(glyph, grid)
          if (gx < wordLeft) wordLeft = gx
          const gr = gx + (glyph.decorationWidth ?? Math.abs(glyph.advance))
          if (gr > wordRight) wordRight = gr
        }
      } while (wordEnd < end && captured[wordEnd]!.breakBefore === 'none')
      const tail = captured[wordEnd - 1]!
      const ink =
        (rtl
          ? wordRight - wordLeft
          : wordWidth - tail.advance + (tail.decorationWidth ?? tail.advance)) + joined

      let gapBefore = first.gapBefore
      if (gapBefore === undefined) {
        gapBefore = first.fontSize * 0.26
        if (start > cursor) {
          const last = captured[start - 1]!
          if (rawLineBottom(last, grid) === rawLineBottom(first, grid)) {
            gapBefore = Math.max(
              0,
              rtl
                ? prevLeft - wordRight
                : wordLeft - rawOriginX(last, grid) - (last.decorationWidth ?? last.advance),
            )
          }
        }
      }
      if (
        lineSequence > 0 &&
        (first.breakBefore === 'hard' || penX + gapBefore + ink > available)
      ) {
        alignLine(start, first.breakBefore === 'hard')
        line++
        penX = 0
        lineSequence = 0
        lineStart = start
        lineSpaces = 0
      }
      const x = lineSequence > 0 ? penX + gapBefore : 0
      const baseline = block.firstBaseline - flowShift - line * block.linePitch
      const baseOriginX = block.left + (rtl ? Math.max(0, available - x - ink) : x) - wordLeft
      if (start > lineStart && first.gapBefore !== undefined) lineSpaces++
      for (let index = start, shift = rtl ? joined : 0; index < wordEnd; index++) {
        const glyph = captured[index]!
        if (index > start && glyph.gapBefore !== undefined) {
          lineSpaces++
          const j = join(index)
          shift += rtl ? -j : j
        }
        glyphs[index] = {
          ...glyph,
          originX: baseOriginX + rawOriginX(glyph, grid) + shift,
          lineBottom: baseline,
          sequence:
            wordHasShape &&
            glyph.shapeGroup !== undefined &&
            captured[index + 1]?.shapeGroup === glyph.shapeGroup
              ? lineSequence
              : lineSequence++,
          clip,
        }
      }
      penX = x + ink
      prevLeft = wordLeft
      start = wordEnd
    }
    alignLine(end, true)

    const addedLines = line + 1 - capturedLines
    clip[1] = overflowClip
      ? overflowClip[1] - flowShift - addedLines * block.linePitch
      : block.firstBaseline - flowShift - line * block.linePitch - block.linePitch

    flowShift += addedLines * block.linePitch
    lineCount += line + 1
    cursor = end
  }

  if (flowShift !== 0) {
    for (const clip of clips) {
      clip[1] += flowShift
      clip[3] += flowShift
    }
  }

  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index]!
    glyph.lineBottom += flowShift
    const original = captured[index]!
    if (!grid && original.shapeGroup === undefined && !original.motionOrigin) continue
    const origX = rawOriginX(original, grid),
      origY = rawLineBottom(original, grid)
    if (original.shapeGroup !== undefined) {
      const dx = glyph.originX - origX,
        dy = glyph.lineBottom - origY
      glyph.clip = [
        Math.max(glyph.clip[0], original.clip[0] + dx),
        Math.max(glyph.clip[1], original.clip[1] + dy),
        Math.min(glyph.clip[2], original.clip[2] + dx),
        Math.min(glyph.clip[3], original.clip[3] + dy),
      ]
    }
    if (original.motionOrigin)
      glyph.motionOrigin = [
        original.motionOrigin[0] + glyph.originX - origX,
        original.motionOrigin[1] + glyph.lineBottom - origY,
        original.motionOrigin[2],
      ]
    if (grid && glyph.snap) {
      const dx = glyph.originX - origX,
        dy = origY - glyph.lineBottom + flowShift
      if (Math.abs(dx) + Math.abs(dy) < 1e-9) {
        glyph.originX += glyph.snap[0]
        glyph.lineBottom += glyph.snap[1]
      } else snapGlyph(glyph, (dx - glyph.snap[0]) * grid[0], (dy + glyph.snap[1]) * grid[1], grid)
    }
  }
  return { ...snapshot, glyphs, width, height: snapshot.height + flowShift, lineCount }
}

/**
 * @internal Moves a glyph onto the pixel grid of `pixelSnap` and records the move. `column`
 * is its origin in quarter device pixels and `row` the bottom of its text box in layout
 * pixels down the page, each counted from any whole one. The box takes the nearest row, a
 * half going down the page, as the browser paints a line. The origin takes the nearest
 * quarter pixel where the browser draws glyph masks: under 162 device pixels per em.
 *
 * `lean` is how far under its own nearest row the glyph's line starts. The browser rounds
 * the line first and a box where that leaves it, so a box held off the line's rows by a
 * fraction (the text beside a superscript) can end a row away from its own nearest one.
 */
export function snapGlyph(
  glyph: {
    -readonly [
      K in keyof Pick<GlyphLayout, 'fontSize' | 'originX' | 'lineBottom' | 'snap'>
    ]: GlyphLayout[K]
  },
  column: number,
  row: number,
  grid: readonly [number, number],
  lean = 0,
): void {
  // Coordinates reach here through float arithmetic; the bias keeps a half a half.
  const x =
    glyph.fontSize * grid[0] < 648 ? (Math.floor(column + 0.5 + 1e-6) - column) / grid[0] : 0
  const y = (row - Math.floor(row - lean + 0.5 + 1e-6)) / grid[1]
  glyph.originX += x
  glyph.lineBottom += y
  glyph.snap = [x, y]
}

const scratchBaselines = new Set<number>()

function countCapturedLines(
  glyphs: readonly GlyphLayout[],
  from: number,
  to: number,
  grid: DomLayoutSnapshot['snapGrid'],
): number {
  if (to <= from) return 1
  scratchBaselines.clear()
  let prev = NaN
  for (let index = from; index < to; index++) {
    const bottom = rawLineBottom(glyphs[index]!, grid)
    if (bottom !== prev) scratchBaselines.add(Math.round((prev = bottom) * 4))
  }
  return scratchBaselines.size
}
