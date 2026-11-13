import { glyphClusters } from './clusters.js'

/**
 * @internal Computed `text-transform` of captured text. The DOM keeps the source characters
 * while the browser draws transformed ones, so capture maps them itself, following Blink:
 * case maps distinguish only Turkic, Greek and Lithuanian languages from the root mapping,
 * and `capitalize` ignores language. `full-width` applies where the browser computes it
 * (Firefox and Safari); `full-size-kana` and `math-auto` are not applied.
 */
export interface TextTransform {
  readonly caseMap: 'uppercase' | 'lowercase' | 'capitalize' | undefined
  /** `tr`, `az`, `el` or `lt` from the element's `lang`; empty for the root mapping. */
  readonly locale: string
  readonly fullWidth: boolean
}

const FULL_WIDTH =
  /[!-~¢£¥¦¬¯₩](?![\u{fe0e}\u{fe0f}]?\u{20e3})|[\u{ff61}-\u{ff9f}\u{ffe8}-\u{ffee}]/gu
let words: Intl.Segmenter | undefined

/** @internal Null when the computed value changes nothing that capture can reproduce. */
export function resolveTextTransform(value: string, element: Element): TextTransform | null {
  if (!value || value === 'none') return null
  const keywords = value.split(' ')
  const caseMap = (['uppercase', 'lowercase', 'capitalize'] as const).find((k) =>
    keywords.includes(k),
  )
  const fullWidth = keywords.includes('full-width')
  if (!caseMap && !fullWidth) return null
  const lang =
    caseMap && caseMap !== 'capitalize'
      ? (element.closest('[lang]')?.getAttribute('lang') ?? '')
      : ''
  return {
    caseMap,
    locale: /^(?:tr|az|el|lt)(?=$|[-_])/i.exec(lang)?.[0].toLowerCase() ?? '',
    fullWidth,
  }
}

/**
 * @internal The whole transformed text, for layouts that measure it themselves. `previous`
 * is the character before the text, which decides whether `capitalize` starts a word.
 */
export function transformText(text: string, transform: TextTransform, previous = ' '): string {
  const { caseMap, locale } = transform
  const cased =
    caseMap === 'uppercase'
      ? locale
        ? text.toLocaleUpperCase(locale)
        : text.toUpperCase()
      : caseMap === 'lowercase'
        ? locale
          ? text.toLocaleLowerCase(locale)
          : text.toLowerCase()
        : caseMap === 'capitalize'
          ? capitalize(text, previous)
          : text
  return transform.fullWidth ? cased.replace(FULL_WIDTH, widen) : cased
}

/**
 * @internal What the browser draws for each glyph cluster of `text`, so Range offsets can keep
 * indexing the DOM text; `undefined` when the transform changes nothing. The whole text is
 * mapped at once (Greek final sigma and accents and the Turkic and Lithuanian dot rules
 * depend on context) and split back into shares, each found through its cluster's own
 * mapping. A share can be empty, for a mark the mapping absorbed, or hold several characters
 * (ß → SS). Clusters map one at a time when the shares do not line up.
 */
export function transformClusters(
  text: string,
  transform: TextTransform,
  previous = ' ',
): string[] | undefined {
  const mapped = transformText(text, transform, previous)
  if (mapped === text) return undefined
  // Capitalize maps characters one for one, so only full-width applies alone.
  const alone =
    transform.caseMap === 'capitalize' ? { ...transform, caseMap: undefined } : transform
  const own = (cluster: string): string => transformText(cluster, alone)
  const clusters = Array.from(glyphClusters(text))
  const shares: string[] = []
  let offset = 0
  for (const cluster of clusters) {
    const expected = own(cluster)
    const point = mapped.codePointAt(offset)
    const share = mapped.startsWith(expected, offset)
      ? expected
      : /^\p{M}/u.test(cluster)
        ? ''
        : point === undefined
          ? undefined
          : String.fromCodePoint(point)
    if (share === undefined) break
    shares.push(share)
    offset += share.length
  }
  return shares.length === clusters.length && offset === mapped.length ? shares : clusters.map(own)
}

/**
 * @internal The character before `node` as Blink's `capitalize` sees it: the last UTF-16 unit of
 * the nearest preceding text, read backwards through inline markup and into inline boxes, or a
 * space after a line break, a block or an empty box.
 */
export function precedingCharacter(
  node: Node,
  style: (element: Element) => CSSStyleDeclaration,
): string {
  for (let current = node; ;) {
    const previous = current.previousSibling
    if (previous) {
      const character = lastCharacter(previous, style, true)
      if (character !== undefined) return character
      current = previous
    } else {
      const parent = current.parentElement
      if (!parent || !isInlineFlow(style(parent).display)) return ' '
      current = parent
    }
  }
}

const isInlineFlow = (d: string): boolean => !d || d === 'inline' || d === 'contents'

function lastCharacter(
  node: Node,
  style: (element: Element) => CSSStyleDeclaration,
  sibling: boolean,
): string | undefined {
  // Blink reads one UTF-16 unit: half a supplementary-plane letter, which ends the word there.
  if (node.nodeType === 3) return (node as Text).data.slice(-1) || undefined
  if (node.nodeType !== 1) return undefined
  const element = node as Element
  if (element.tagName === 'BR') return ' '
  const display = style(element).display
  if (display === 'none') return undefined
  // Replaced elements are atomic boxes even when their display is inline.
  if (/^(?:audio|canvas|embed|iframe|img|math|object|svg|video)$/.test(element.localName))
    return ' '
  // Text after a block-level sibling starts an anonymous block of its own.
  if (sibling && !isInlineFlow(display) && !display.startsWith('inline')) return ' '
  for (let child = element.lastChild; child; child = child.previousSibling) {
    const character = lastCharacter(child, style, false)
    if (character !== undefined) return character
  }
  return isInlineFlow(display) ? undefined : ' '
}

/**
 * Blink title-cases the first UTF-16 unit of every word-break segment, seeded with the
 * character before the text so that a word split by inline markup stays one word.
 */
function capitalize(text: string, previous: string): string {
  if (typeof Intl.Segmenter !== 'function') return text
  words ??= new Intl.Segmenter(undefined, { granularity: 'word' })
  let result = ''
  let end = 0
  for (const { index } of words.segment(previous + text)) {
    const start = index - previous.length
    if (start < 0) continue
    const point = String.fromCodePoint(text.codePointAt(start)!)
    result += text.slice(end, start) + titlecase(point)
    end = start + point.length
  }
  return result + text.slice(end)
}

/** Simple (single-character) titlecase, as ICU's `u_totitle` gives it for the BMP. */
function titlecase(point: string): string {
  const code = point.codePointAt(0)!
  // Latin digraphs have titlecase letters of their own: ǆ and Ǆ become ǅ.
  if (code >= 0x1c4 && code <= 0x1cc)
    return String.fromCharCode(0x1c5 + 3 * (((code - 0x1c4) / 3) | 0))
  if (code >= 0x1f1 && code <= 0x1f3) return '\u01f2'
  // Greek letters with ypogegrammeni take prosgegrammeni capitals: ᾳ becomes ᾼ.
  if (code >= 0x1f80 && code <= 0x1faf) return String.fromCharCode(code | 8)
  if (code === 0x1fb3 || code === 0x1fc3 || code === 0x1ff3) return String.fromCharCode(code + 9)
  // Georgian Mkhedruli is its own titlecase; Blink leaves supplementary planes alone.
  const upper = (code >= 0x10d0 && code <= 0x10ff) || code > 0xffff ? point : point.toUpperCase()
  return upper.length === 1 ? upper : point
}

function widen(character: string): string {
  const code = character.charCodeAt(0)
  return code >= 0xff61
    ? character.normalize('NFKC')
    : String.fromCharCode(code <= 0x7e ? code + 0xfee0 : 0xffe0 + '¢£¬¯¦¥₩'.indexOf(character))
}
