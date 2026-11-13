// Hint-free prose keeps the native string iterator and allocates nothing.
const EMOJI_SEQUENCE_HINT =
  /\u200D|\u20E3|\uFE0E|\uFE0F|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]/u
const EMOJI_SEQUENCE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[#*0-9]\uFE0F?\u20E3$/u
let graphemes: Intl.Segmenter | undefined

/** @internal Code points, except that emoji grapheme sequences stay whole. */
export function glyphClusters(text: string): Iterable<string> {
  if (!EMOJI_SEQUENCE_HINT.test(text) || typeof Intl.Segmenter !== 'function') return text
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const result: string[] = []
  for (const { segment } of graphemes.segment(text)) {
    if (segment.length > 1 && EMOJI_SEQUENCE.test(segment)) result.push(segment)
    else for (const point of segment) result.push(point)
  }
  return result
}

const nonAscii = (text: string): boolean => text.length > 1 || text.charCodeAt(0) >= 0xa9

/** @internal Matches Pretext's emoji width-correction predicate. */
export function isEmojiGrapheme(text: string): boolean {
  return nonAscii(text) && /\p{Emoji_Presentation}|\uFE0F/u.test(text)
}

/** @internal Broad candidate predicate shared by capture and colour rasterization. */
export function isEmojiCandidate(text: string): boolean {
  return (
    nonAscii(text) && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3\uFE0F]/u.test(text)
  )
}
