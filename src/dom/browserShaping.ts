import type {
  DomSdfOptions,
  GlyphLayout,
  FontStyleSnapshot,
  GlyphRequest,
  TextDecorationLayout,
} from '../types.js'
import { precedingCharacter, transformText, type TextTransform } from './textTransform.js'

interface InlineStyle {
  readonly font: FontStyleSnapshot
  readonly fontSize: number
  readonly letterSpacing: number
  readonly wordSpacing: number
  readonly color: readonly [number, number, number, number]
  readonly decorations: readonly TextDecorationLayout[]
  readonly z: number
  readonly transform: TextTransform | null
}

interface CaptureContext {
  readonly style: (element: Element) => CSSStyleDeclaration
  readonly inline: (parent: HTMLElement) => InlineStyle | null
  readonly signal: AbortSignal | undefined
  readonly options: DomSdfOptions
  readonly svg?: (element: Element, sequence: number) => void
  /** Told each measured grapheme box, so the capture can find the browser's baseline. */
  readonly box?: (
    font: FontStyleSnapshot,
    box: {
      readonly left: number
      readonly top: number
      readonly right: number
      readonly bottom: number
      readonly width: number
      readonly height: number
    },
  ) => void
}

/** Applied only by the opt-in atlas path; ordinary glyphs also reset shared Canvas state. */
export function setShapingContext(context: CanvasRenderingContext2D, request: GlyphRequest): void {
  const slice = request.shaping?.slice
  if (slice && !(slice[0] >= 0 && slice[0] < slice[1] && slice[1] <= 1)) {
    throw new RangeError('Browser shaping slices must satisfy 0 <= start < end <= 1')
  }
  context.direction = request.shaping?.direction ?? 'inherit'
  context.canvas.lang = request.shaping?.language ?? ''
  if ('lang' in context) context.lang = request.shaping?.language ?? 'inherit'
  const size = request.shaping
    ? Number.parseFloat(/[\d.]+px/.exec(request.font.canvasFont)?.[0] ?? '0')
    : 0
  context.letterSpacing = `${(request.shaping?.letterSpacing ?? 0) * size}px`
  context.wordSpacing = `${(request.shaping?.wordSpacing ?? 0) * size}px`
}

/** Native helpers and measured descents are shared only within one capture. */
export function createBrowserCapture(document: Document) {
  let helpers:
    | {
        range: Range
        segmenter: Intl.Segmenter
        canvas: HTMLCanvasElement
        metricsContext: CanvasRenderingContext2D | null
      }
    | undefined
  const descents = new Map<FontStyleSnapshot, Map<string, number>>()
  return (
    block: HTMLElement,
    context: CaptureContext & {
      readonly blockIndex: number
      readonly rootRect: DOMRect
      readonly invScale: number
      readonly clip: [number, number, number, number]
      readonly glyphs: GlyphLayout[]
      readonly requests: Map<string, GlyphRequest>
      readonly lineKeys: Set<string>
      readonly lineSequences: Map<string, number>
    },
  ): void => {
    if (!helpers) {
      const canvas = document.createElement('canvas')
      helpers = {
        range: document.createRange(),
        segmenter: new Intl.Segmenter(undefined, { granularity: 'grapheme' }),
        canvas,
        metricsContext: canvas.getContext('2d'),
      }
    }
    const { range, segmenter, canvas, metricsContext } = helpers
    const { blockIndex, rootRect, invScale, clip, glyphs, requests, lineKeys, lineSequences } =
      context
    let previousRun = -1
    let sequence = 0
    let baselineOffset: number | undefined
    let motionOrigin!: readonly [number, number, number]
    let motionIndex = (glyphs.at(-1)?.motionOrigin?.[2] ?? -1) + 1
    for (const entry of captureBrowserRuns(block, context, range, segmenter)) {
      if ('svg' in entry) {
        context.svg?.(entry.svg, sequence)
        motionIndex = (glyphs.at(-1)?.motionOrigin?.[2] ?? motionIndex) + 1
        continue
      }
      const { inline, bounds, request, run } = entry
      requests.set(request.key, request)
      const lineKey = `${blockIndex}:${Math.round(bounds.top * 4)}`
      if (run !== previousRun) {
        sequence = lineSequences.get(lineKey) ?? 0
        lineSequences.set(lineKey, sequence + 1)
        previousRun = run
        const slice = request.shaping?.slice ?? [0, 1]
        const width = bounds.width / (slice[1] - slice[0])
        motionOrigin = [
          (bounds.left - width * slice[0] + width / 2 - rootRect.left) * invScale,
          (rootRect.bottom - (bounds.top + bounds.bottom) / 2) * invScale,
          motionIndex++,
        ]
        if (metricsContext) {
          // Font metrics are pixel-rounded at each size; scaling baked metrics can
          // otherwise move a shaped line by half a CSS pixel.
          let byText = descents.get(request.font)
          if (!byText) descents.set(request.font, (byText = new Map<string, number>()))
          const lang = request.shaping?.language ?? ''
          const metricKey = lang ? `${lang}\u0000${request.character}` : request.character
          let descent = byText.get(metricKey)
          if (descent === undefined) {
            canvas.lang = lang
            if ('lang' in metricsContext) metricsContext.lang = lang || 'inherit'
            metricsContext.font = request.font.canvasFont.replace(
              /[\d.]+px/,
              `${inline.font.size}px`,
            )
            descent = metricsContext.measureText(request.character).fontBoundingBoxDescent
            byText.set(metricKey, descent)
          }
          baselineOffset = descent * invScale
        }
      }
      lineKeys.add(lineKey)
      glyphs.push({
        glyphKey: request.key,
        fontSize: inline.fontSize,
        originX: (bounds.left - rootRect.left) * invScale,
        lineBottom: (rootRect.bottom - bounds.bottom) * invScale,
        ...(baselineOffset !== undefined && Number.isFinite(baselineOffset)
          ? { baselineOffset }
          : {}),
        motionOrigin,
        advance: bounds.width * invScale,
        decorations: inline.decorations,
        decorationWidth: bounds.width * invScale,
        block: blockIndex,
        breakBefore: 'hard',
        clip,
        color: inline.color,
        sequence,
        z: inline.z,
      })
    }
  }
}

interface BrowserTextRun {
  readonly run: number
  readonly inline: InlineStyle
  readonly request: GlyphRequest
  readonly bounds: { left: number; top: number; right: number; bottom: number; width: number }
}

export function validateBrowserShaping(options: DomSdfOptions): void {
  if (options.layoutEngine === 'pretext' || options.reshape) {
    throw new Error('textShaping "browser" requires Range without a reshape callback')
  }
  if (
    options.textBackend === 'windfoil' &&
    !['sdf', 'sdf-glyphs'].includes(options.windfoil?.fallback ?? '')
  ) {
    throw new Error('textShaping "browser" requires SDF or windfoil.fallback: "sdf"')
  }
  if (typeof Intl.Segmenter !== 'function') {
    throw new Error('textShaping "browser" requires Intl.Segmenter')
  }
}

/** Keep native shaping context intact, including across equivalent inline markup. */
function captureBrowserRuns(
  block: HTMLElement,
  context: CaptureContext,
  range: Range,
  segmenter: Intl.Segmenter,
): (BrowserTextRun | { svg: Element })[] {
  const document = block.ownerDocument
  const result: (BrowserTextRun | { svg: Element })[] = []
  let nodes: Text[] = []
  let inline: InlineStyle | null = null
  let shaping: NonNullable<GlyphRequest['shaping']> | null = null
  let styleKey = ''
  let preserveNewlines = false

  const flush = (): void => {
    if (!inline || !shaping || nodes.length === 0) return
    const activeInline = inline
    const activeShaping = shaping
    const source = nodes.length === 1 ? nodes[0]!.data : nodes.map((node) => node.data).join('')
    let nodeIndex = 0
    let nodeOffset = 0
    let text = ''
    // Blink maps each text node on its own, so a transformed run notes where its text enters
    // one: case context stops there, and `capitalize` reads the character before each piece.
    let pieces: { readonly at: number; readonly node: number; readonly offset: number }[] = []
    let bounds: BrowserTextRun['bounds'] | null = null
    const transform = activeInline.transform
    const append = (segment: string, index: number, node: number, nodeStart: number): void => {
      for (let from = index; transform;) {
        if (pieces.at(-1)?.node !== node)
          pieces.push({ at: text.length + from - index, node, offset: from - nodeStart })
        // A cluster can continue into the next text node across inline markup.
        from = nodeStart + nodes[node]!.length
        if (index + segment.length <= from || node === nodes.length - 1) break
        nodeStart = from
        node++
      }
      text += segment
    }
    const emit = (): void => {
      const run = text.replace(/ +$/u, '')
      let character = run
      if (transform) {
        character = ''
        for (const [index, piece] of pieces.entries()) {
          const end = Math.min(pieces[index + 1]?.at ?? run.length, run.length)
          if (end <= piece.at) continue
          const data = nodes[piece.node]!.data
          character += transformText(
            run.slice(piece.at, end),
            transform,
            transform.caseMap !== 'capitalize'
              ? undefined
              : piece.offset > 0
                ? Array.from(data.slice(Math.max(0, piece.offset - 2), piece.offset)).pop()
                : precedingCharacter(nodes[piece.node]!, context.style),
          )
        }
      }
      if (bounds && /[^\s\p{Cf}]/u.test(character)) {
        // Leave room for SDF padding and small bake-size-dependent metric differences.
        const tileWidth = Math.max(
          1,
          ((context.options.maxAtlasSize ?? 2048) - 2 * (context.options.padding ?? 12) - 4) * 0.9,
        )
        const tiles = Math.max(
          1,
          Math.ceil(
            ((bounds.width / activeInline.font.size) * (context.options.bakeSize ?? 96)) /
              tileWidth,
          ),
        )
        for (let tile = 0; tile < tiles; tile++) {
          const slice = [tile / tiles, (tile + 1) / tiles] as const
          const state = tiles > 1 ? { ...activeShaping, slice } : activeShaping
          result.push({
            run: result.length - tile,
            inline: activeInline,
            bounds:
              tiles === 1
                ? bounds
                : {
                    ...bounds,
                    left: bounds.left + bounds.width * slice[0],
                    right: bounds.left + bounds.width * slice[1],
                    width: bounds.width / tiles,
                  },
            request: {
              key: `${activeInline.font.key}\u0000browser:${JSON.stringify(state)}:${character}`,
              character,
              font: activeInline.font,
              shaping: state,
            },
          })
        }
      }
      bounds = null
      text = ''
      pieces = []
    }
    const locate = (offset: number): void => {
      while (nodeIndex < nodes.length - 1 && offset >= nodeOffset + nodes[nodeIndex]!.length) {
        nodeOffset += nodes[nodeIndex++]!.length
      }
    }
    const scratchBox = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    for (const part of segmenter.segment(source)) {
      context.signal?.throwIfAborted()
      const seg = part.segment
      const c0 = seg.charCodeAt(0)
      if (c0 <= 32 && (seg === ' ' || /^[\t\n\r ]+$/u.test(seg))) {
        if (preserveNewlines && seg !== ' ' && /[\n\r\t]/u.test(seg)) emit()
        else if (bounds) text += ' '
        continue
      }
      locate(part.index)
      const firstNode = nodeIndex
      const firstStart = nodeOffset
      range.setStart(nodes[nodeIndex]!, part.index - nodeOffset)
      const end = part.index + seg.length
      locate(end)
      range.setEnd(nodes[nodeIndex]!, end - nodeOffset)
      const box = range.getBoundingClientRect()
      const width = box.width
      const height = box.height
      if (height <= 0 || width <= 0) {
        // Joiners, isolates, combining marks, and other bidi controls still participate in shaping.
        if (bounds ? /^[\p{Cf}\p{M}]+$/u.test(seg) : /^\p{Cf}+$/u.test(seg))
          append(seg, part.index, firstNode, firstStart)
        continue
      }
      const left = box.left
      const right = box.right
      const top = box.top
      const bottom = box.bottom
      scratchBox.left = left
      scratchBox.top = top
      scratchBox.right = right
      scratchBox.bottom = bottom
      scratchBox.width = width
      scratchBox.height = height
      context.box?.(activeInline.font, scratchBox)
      if (bounds && (Math.abs(top - bounds.top) > 0.5 || Math.abs(bottom - bounds.bottom) > 0.5))
        emit()
      append(seg, part.index, firstNode, firstStart)
      if (bounds) {
        if (left < bounds.left) bounds.left = left
        if (right > bounds.right) bounds.right = right
        if (top < bounds.top) bounds.top = top
        if (bottom > bounds.bottom) bounds.bottom = bottom
        bounds.width = bounds.right - bounds.left
      } else {
        bounds = { left, right, top, bottom, width }
      }
    }
    emit()
    nodes = []
  }

  let blockLang: string | undefined
  const langOf = (element: Element): string =>
    element.getAttribute('lang') ??
    (element === block
      ? (blockLang ??= block.closest('[lang]')?.getAttribute('lang') ?? '')
      : element.parentElement
        ? langOf(element.parentElement)
        : '')

  let prevStyle: CSSStyleDeclaration | null = null
  const walker = document.createTreeWalker(block, 5 /* SHOW_ELEMENT | SHOW_TEXT */)
  let node = walker.nextNode()
  while (node) {
    context.signal?.throwIfAborted()
    if (node.nodeType === 1) {
      const element = node as Element
      if (
        context.svg &&
        (element.localName === 'svg' || element.localName === 'img') &&
        !element.parentElement?.closest('svg')
      ) {
        flush()
        result.push({ svg: element })
      }
      if (element.tagName === 'BR') flush()
      else if (nodes.length > 0 && context.style(element) !== prevStyle) {
        const display = context.style(element).display
        if (display && !display.startsWith('inline') && display !== 'contents') flush()
      }
    } else {
      const textNode = node as Text
      const parent = textNode.parentElement!
      const nextInline =
        context.svg && parent.closest('svg') && !parent.closest('foreignObject')
          ? null
          : context.inline(parent)
      if (!nextInline) flush()
      else {
        const style = context.style(parent)
        if (nextInline === inline && style === prevStyle && !parent.hasAttribute('lang')) {
          nodes.push(textNode)
          node = walker.nextNode()
          continue
        }
        const size = nextInline.font.size
        const whiteSpace = style.whiteSpace
        const nextShaping: NonNullable<GlyphRequest['shaping']> = {
          direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
          language: langOf(parent),
          letterSpacing: nextInline.letterSpacing / size,
          wordSpacing: nextInline.wordSpacing / size,
        }
        const nextKey = `${nextInline.font.key}|${size}|${nextInline.color.join(',')}|${nextInline.decorations.length ? JSON.stringify(nextInline.decorations) : ''}|${nextInline.z}|${nextShaping.direction}|${nextShaping.language}|${nextShaping.letterSpacing}|${nextShaping.wordSpacing}|${whiteSpace}|${nextInline.transform ? JSON.stringify(nextInline.transform) : ''}`
        if (nextKey !== styleKey) flush()
        inline = nextInline
        prevStyle = style
        shaping = nextShaping
        styleKey = nextKey
        preserveNewlines = ['pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(whiteSpace)
        nodes.push(textNode)
      }
    }
    node = walker.nextNode()
  }
  flush()
  return result
}
