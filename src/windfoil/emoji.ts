import type { createEmojiConverter } from './emojiMetrics.js'
import type {
  GlyphRequest,
  SvgEmojiOutlineProviderOptions,
  WindfoilGlyphOutline,
  WindfoilOutlineProvider,
} from '../types.js'
import { abortable, throwIfAborted } from './storage.js'

function emojiKey(cluster: string): string {
  // Twemoji filenames intentionally encode Unicode code points, including joiners.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...(cluster.includes('\u200d') ? cluster : cluster.replaceAll('\ufe0f', ''))]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join('-')
}

/** Share work while keeping cancellation local to each interested caller. */
function sharedCache<T>() {
  const values = new Map<string, T>()
  const pending = new Map<
    string,
    { controller: AbortController; promise: Promise<T>; users: number }
  >()
  return async (key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>) => {
    throwIfAborted(signal)
    if (values.has(key)) return values.get(key)!
    let entry = pending.get(key)
    if (!entry) {
      const controller = new AbortController()
      const created = {
        controller,
        users: 0,
        promise: Promise.resolve().then(async () => {
          throwIfAborted(controller.signal)
          const value = await load(controller.signal)
          throwIfAborted(controller.signal)
          values.set(key, value)
          return value
        }),
      }
      created.promise = created.promise.finally(() => {
        if (pending.get(key) === created) pending.delete(key)
      })
      pending.set(key, created)
      entry = created
    }
    entry.users++
    try {
      return await abortable(entry.promise, signal)
    } finally {
      entry.users--
      if (!entry.users && pending.get(key) === entry) {
        pending.delete(key)
        entry.controller.abort()
      }
    }
  }
}
/** App-supplied SVG emoji, sharing the text font's baseline and browser advance. */
export function createSvgEmojiOutlineProvider(
  options: SvgEmojiOutlineProviderOptions,
): WindfoilOutlineProvider {
  const svgCache = sharedCache<string | null>()
  const outlines = sharedCache<WindfoilGlyphOutline | null>()
  let convert: ReturnType<typeof createEmojiConverter> | undefined
  return async (request: GlyphRequest, signal: AbortSignal) => {
    throwIfAborted(signal)
    if (
      request.character.includes('\ufe0e') ||
      !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(request.character)
    )
      return options.text(request, signal)
    const cluster = emojiKey(request.character)
    const key = `${request.font.key}\0${cluster}`
    return outlines(key, signal, async (sharedSignal) => {
      const svg = await svgCache(cluster, sharedSignal, async (resolveSignal) =>
        options.resolve(request.character, resolveSignal),
      )
      if (svg === null) return null
      const module = await abortable(import('./emojiMetrics.js'), sharedSignal)
      convert ??= module.createEmojiConverter()
      return convert(svg, request, options, sharedSignal)
    })
  }
}
