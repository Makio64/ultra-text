import {
  materializeRichInlineLineRange,
  prepareRichInline,
  walkRichInlineLineRanges,
} from '@chenglou/pretext/rich-inline'

import type {
  DomSdfOptions,
  FontStyleSnapshot,
  GlyphLayout,
  TextBlockLayout,
  TextDecorationLayout,
} from '../types.js'
import { glyphClusters, isEmojiGrapheme } from './clusters.js'
import { transformText, type TextTransform } from './textTransform.js'

type MutableGlyph = { -readonly [K in keyof GlyphLayout]: GlyphLayout[K] }

export interface PretextInlineStyle {
  readonly decorations: readonly TextDecorationLayout[]
  readonly font: FontStyleSnapshot
  readonly keys: Map<string, string>
  readonly fontSize: number
  readonly layoutFont: string
  readonly letterSpacing: number
  readonly color: readonly [number, number, number, number]
  readonly z: number
  readonly transform: TextTransform | null
}

export interface PretextParentRecord {
  readonly owner: Element | null
  readonly inline: PretextInlineStyle | null
  readonly paragraph: Element | null
}

export function createPretextCapture(
  root: HTMLElement,
  document: Document,
  options: DomSdfOptions,
  bakeSize: number,
  invScale: number,
  rootRect: DOMRect,
  measuresBaselines: boolean,
  deviceScale: number,
  boxHeights: Map<FontStyleSnapshot, number>,
  glyphs: MutableGlyph[],
  displayNone: (element: Element) => boolean,
  inlineBox: (element: Element) => boolean,
  ignored: (element: Element) => boolean,
  resolveParent: (parent: HTMLElement) => PretextParentRecord,
  transformSeed: (node: Text, transform: TextTransform) => string | undefined,
  requestKey: (font: FontStyleSnapshot, keys: Map<string, string>, character: string) => string,
  parsePx: (value: string, fallback?: number, ref?: number) => number,
  canvasFont: (style: CSSStyleDeclaration, bakeSize: number) => string,
  fontMetrics: (
    context: CanvasRenderingContext2D,
    font: string,
    fontSize: number,
  ) => readonly [number, number],
  trackLayoutGrid: (box: { readonly left: number; readonly width: number }) => void,
  resolveLayoutScale: (context: CanvasRenderingContext2D) => number | undefined,
  canBreakCjk: (p: string, c: string) => boolean,
) {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('collectDomSnapshot: Canvas 2D is unavailable')
  }

  const measureAdvance = (
    advances: Map<string, number>,
    previous: string,
    character: string,
  ): number => {
    const cacheKey = previous ? previous + '\u0001' + character : character
    let advance = advances.get(cacheKey)
    if (advance === undefined) {
      advance = previous
        ? context.measureText(previous + character).width - measureAdvance(advances, '', previous)
        : context.measureText(character).width
      advances.set(cacheKey, advance)
    }
    return advance
  }

  let layoutScale: number | undefined
  if (measuresBaselines && deviceScale !== 1) {
    const range = document.createRange()
    const walker = document.createTreeWalker(root, 4)
    let samples = 16
    for (let node = walker.nextNode(); node && samples > 0; node = walker.nextNode()) {
      const text = node as Text
      const record = text.parentElement ? resolveParent(text.parentElement) : null
      if (!record?.inline || !record.owner) continue
      for (const { index, 0: character } of text.data.matchAll(/\S/gu)) {
        range.setStart(text, index)
        range.setEnd(text, index + character.length)
        const box = range.getBoundingClientRect()
        const height = box.height
        if (box.width <= 0 || height <= 0) continue
        trackLayoutGrid(box)
        if (!boxHeights.has(record.inline.font)) boxHeights.set(record.inline.font, height)
        if (--samples === 0) break
      }
    }
    layoutScale = resolveLayoutScale(context)
  }
  const pretextScale = layoutScale ?? 1

  const runMetrics = new Map<FontStyleSnapshot, readonly [number, number]>()
  const fontMetricsCache = new Map<string, readonly [Map<string, number>, Float64Array]>()
  const lineCache = new Map<string, ReturnType<typeof materializeRichInlineLineRange>[]>()
  const blockStyleCache = new Map<
    CSSStyleDeclaration,
    readonly [number, number, number, number, number, 'pre-wrap' | 'normal', 'keep-all' | 'normal']
  >()

  return [
    context,
    layoutScale,
    (
      block: HTMLElement,
      blockIndex: number,
      blockStyle: CSSStyleDeclaration,
      blockRect: DOMRect,
      clip: readonly [number, number, number, number],
      includeTextBox: (box: {
        readonly left: number
        readonly top: number
        readonly bottom: number
        readonly width: number
        readonly height: number
      }) => void,
      align: NonNullable<TextBlockLayout['textAlign']>,
      lastAlign: NonNullable<TextBlockLayout['textAlign']>,
    ): readonly [number, number, number] => {
      interface PretextItem {
        readonly text: string
        readonly font: string
        readonly letterSpacing: number
        readonly inline: PretextInlineStyle
      }
      let current: PretextItem[] = []
      const segments: PretextItem[][] = [current]
      let currentParagraph: Element | null = null
      const walker = document.createTreeWalker(block, 5)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType !== 3) {
          const element = node as HTMLElement
          if (element.tagName === 'BR') {
            if (
              !ignored(element) &&
              !displayNone(element) &&
              resolveParent(element).owner === block
            ) {
              segments.push((current = []))
            }
          } else if (
            (current.length > 0 || currentParagraph !== null) &&
            !displayNone(element) &&
            !inlineBox(element)
          ) {
            if (current.length > 0) segments.push((current = []))
            currentParagraph = null
          }
          continue
        }
        const textNode = node as Text
        const record = textNode.parentElement ? resolveParent(textNode.parentElement) : null
        if (!record?.inline || record.owner !== block) continue
        if (record.paragraph !== currentParagraph) {
          if (currentParagraph !== null && current.length > 0) segments.push((current = []))
          currentParagraph = record.paragraph
        }
        if (textNode.data.length > 0) {
          const { inline } = record
          const { transform } = inline
          const shown = transform
            ? transformText(textNode.data, transform, transformSeed(textNode, transform))
            : textNode.data
          const text = options.reshape ? options.reshape(shown) : shown
          current.push({
            text,
            font: inline.layoutFont,
            letterSpacing: inline.letterSpacing,
            inline,
          })
        }
      }

      let bm = blockStyleCache.get(blockStyle)
      if (!bm) {
        const inset = (side: 'Left' | 'Right' | 'Top'): number =>
          (/none|hidden/.test(blockStyle[`border${side}Style`])
            ? 0
            : parsePx(blockStyle[`border${side}Width`])) + parsePx(blockStyle[`padding${side}`])
        const cssSize = parsePx(blockStyle.fontSize, 16)
        const blockSize = cssSize * pretextScale
        const [bAscent, bDescent] = fontMetrics(
          context,
          canvasFont(blockStyle, blockSize),
          blockSize,
        )
        const ascent = bAscent / pretextScale
        const fontHeight = ascent + bDescent / pretextScale
        const lineHeight = parsePx(blockStyle.lineHeight, fontHeight, cssSize)
        const lineUnits = Math.round(lineHeight * pretextScale * 64)
        const lineLayout =
          Math.abs(lineUnits / 64 - lineHeight * pretextScale) < 1e-3
            ? lineUnits / 64
            : lineHeight * pretextScale
        const leading = lineLayout - bAscent - bDescent
        bm = [
          inset('Left'),
          inset('Right'),
          inset('Top'),
          lineHeight,
          Math.floor(leading / 2) / pretextScale + ascent,
          /pre(?!-l)|bre/.test(blockStyle.whiteSpace) ? 'pre-wrap' : 'normal',
          blockStyle.wordBreak === 'keep-all' ? 'keep-all' : 'normal',
        ]
        blockStyleCache.set(blockStyle, bm)
      }
      const [insetLeft, insetRight, insetTop, lineHeight, baselineOffset, whiteSpace, wordBreak] =
        bm
      const contentWidth = Math.max(1, blockRect.width - insetLeft - insetRight)
      const contentLeft = blockRect.left - rootRect.left + insetLeft
      const contentTop = blockRect.top - rootRect.top + insetTop
      for (const segment of segments)
        for (const { inline } of segment) {
          if (runMetrics.has(inline.font)) continue
          const size = inline.font.size * pretextScale
          const [mAscent, mDescent] = fontMetrics(
            context,
            inline.font.canvasFont.replace(`${bakeSize}px`, `${size}px`),
            size,
          )
          runMetrics.set(inline.font, [mAscent / pretextScale, mDescent / pretextScale])
        }
      let lines = 0
      let lineIndex = 0
      let measuredFont = ''
      let afterSpace = true
      let joined = false
      const justified = align === 'justify' || lastAlign === 'justify'
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex]!
        if (segment.length === 0) {
          if (segments.length > 1) lineIndex++
          continue
        }
        let hardPending = segmentIndex > 0
        let previousBreakCharacter = ''
        let prepKey = `${contentWidth}|${whiteSpace}|${wordBreak}`
        for (const s of segment) prepKey += `\u0001${s.font}\u0002${s.letterSpacing}\u0002${s.text}`
        let materializedLines = lineCache.get(prepKey)
        if (!materializedLines) {
          const prepared = prepareRichInline(segment, { whiteSpace, wordBreak })
          materializedLines = []
          walkRichInlineLineRanges(prepared, contentWidth, (lineRange) =>
            materializedLines!.push(materializeRichInlineLineRange(prepared, lineRange)),
          )
          lineCache.set(prepKey, materializedLines)
        }
        for (let rangeIndex = 0; rangeIndex < materializedLines.length; rangeIndex++) {
          const line = materializedLines[rangeIndex]!
          const lineAlign = rangeIndex < materializedLines.length - 1 ? align : lastAlign
          const slack = contentWidth - line.width
          const baselineCss = contentTop + baselineOffset + lineIndex * lineHeight
          lines++
          let penX =
            contentLeft + (lineAlign === 'center' ? slack * 0.5 : lineAlign === 'right' ? slack : 0)
          let sequence = 0
          let linePrevious: MutableGlyph | undefined
          const lineStart = glyphs.length

          for (const fragment of line.fragments) {
            const item = segment[fragment.itemIndex]
            if (!item) continue
            const { inline } = item
            if (fragment.gapBefore > 0) {
              previousBreakCharacter = ''
              afterSpace = true
            }
            penX += fragment.gapBefore
            if (measuredFont !== inline.layoutFont) {
              context.font = measuredFont = inline.layoutFont
            }
            const [runAscent, runDescent] = runMetrics.get(inline.font)!
            const descent = runDescent * invScale
            const lineBottom = (rootRect.height - baselineCss) * invScale - descent
            const top = rootRect.top + baselineCss - runAscent
            const bottom = rootRect.top + baselineCss + descent / invScale
            includeTextBox({
              left: rootRect.left + penX,
              top,
              bottom,
              width: fragment.occupiedWidth,
              height: bottom - top,
            })
            let previousCharacter = ''
            let previousCode = -1
            let runWidth = 0
            let renderedCharacters = 0

            const emojiFragment = isEmojiGrapheme(fragment.text)
            let fontEntry = fontMetricsCache.get(inline.layoutFont)
            if (!fontEntry) {
              fontEntry = [new Map(), new Float64Array(16513).fill(NaN)]
              fontMetricsCache.set(inline.layoutFont, fontEntry)
            }
            const [advances, ascii] = fontEntry
            for (const character of glyphClusters(fragment.text)) {
              const code = character.length === 1 ? character.charCodeAt(0) : -1
              const isAscii = code >= 0 && code < 128
              let loneAdvance = isAscii ? ascii[code]! : NaN
              if (Number.isNaN(loneAdvance)) {
                loneAdvance = measureAdvance(advances, '', character)
                if (isAscii) ascii[code] = loneAdvance
              }
              let advance = loneAdvance
              if (previousCharacter) {
                if (isAscii && previousCode >= 0 && previousCode < 128) {
                  const pairIdx = ((previousCode + 1) << 7) | code
                  advance = ascii[pairIdx]!
                  if (Number.isNaN(advance)) {
                    ascii[pairIdx] = advance =
                      context.measureText(previousCharacter + character).width -
                      ascii[previousCode]!
                  }
                } else {
                  advance = measureAdvance(advances, previousCharacter, character)
                }
              }
              const kerning = advance - loneAdvance
              if (emojiFragment && isEmojiGrapheme(character)) {
                if (Number.isNaN(ascii[16512]!)) {
                  const probe = prepareRichInline([{ text: '\u{1F600}', font: inline.layoutFont }])
                  let corrected = 0
                  walkRichInlineLineRanges(probe, 1e6, (probeLine) => {
                    corrected = probeLine.width
                  })
                  context.font = measuredFont = inline.layoutFont
                  ascii[16512] = Math.max(0, context.measureText('\u{1F600}').width - corrected)
                }
                advance -= ascii[16512]!
              }
              const spacing = renderedCharacters > 0 ? inline.letterSpacing : 0
              const nextWidth = runWidth + spacing + advance
              if (
                code <= 32
                  ? code === 32 || (code >= 9 && code <= 13)
                  : code >= 0x85 && /^\s$/u.test(character)
              ) {
                if (code === 0xa0) joined = true
                else if (!/[\u2007\u202f\ufeff]/.test(character)) afterSpace = true
                previousBreakCharacter = ''
                runWidth = nextWidth
                previousCharacter = character
                previousCode = code
                renderedCharacters++
                continue
              }
              const key = requestKey(inline.font, inline.keys, character)
              const isCjkSoft =
                options.cjkLineBreaking === true && canBreakCjk(previousBreakCharacter, character)
              const originX = (penX + runWidth + spacing + kerning) * invScale
              if (linePrevious) {
                if (afterSpace || isCjkSoft || joined)
                  linePrevious.decorationWidth ??= linePrevious.advance
                linePrevious.advance = originX - linePrevious.originX
              }
              const glyph: MutableGlyph = {
                glyphKey: key,
                fontSize: inline.fontSize,
                originX,
                lineBottom,
                baselineOffset: descent,
                advance: (nextWidth - runWidth - kerning) * invScale,
                block: blockIndex,
                breakBefore: hardPending
                  ? 'hard'
                  : afterSpace || sequence === 0 || isCjkSoft
                    ? 'soft'
                    : 'none',
                clip,
                color: inline.color,
                sequence,
                z: inline.z,
              }
              if (isCjkSoft) glyph.gapBefore = 0
              else if (linePrevious ? (afterSpace || joined) && justified : rangeIndex > 0)
                glyph.gapBefore = linePrevious
                  ? linePrevious.advance - linePrevious.decorationWidth!
                  : (measureAdvance(advances, '', ' ') + inline.letterSpacing) * invScale
              if (inline.decorations.length) {
                glyph.decorations = inline.decorations
                glyph.decorationWidth = glyph.advance
              }
              glyphs.push(glyph)
              linePrevious = glyph
              hardPending = false
              if (options.cjkLineBreaking) previousBreakCharacter = character
              afterSpace = joined = false
              sequence++
              runWidth = nextWidth
              previousCharacter = character
              previousCode = code
              renderedCharacters++
            }
            penX += fragment.occupiedWidth
          }
          if (lineAlign === 'justify' && slack > 0) {
            let spaces = 0
            for (let i = lineStart + 1; i < glyphs.length; i++)
              if (glyphs[i]!.gapBefore !== undefined) spaces++
            const share = (slack * invScale) / spaces
            for (let i = lineStart + 1, k = 0; spaces && i < glyphs.length; i++) {
              if (glyphs[i]!.gapBefore !== undefined) {
                k++
                glyphs[i - 1]!.advance += share
              }
              glyphs[i]!.originX += k * share
            }
          }
          afterSpace = true
          lineIndex++
        }
      }
      return [lines, contentLeft * invScale, contentWidth * invScale]
    },
  ] as const
}
