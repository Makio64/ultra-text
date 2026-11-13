import { vi } from 'vitest'

/**
 * Pretext corrects Canvas emoji widths by the width the page lays one emoji out at. It reads
 * its probe span's rectangle and resolved `width` and keeps the rectangle only where the two
 * agree; jsdom resolves no width. Resolve the probe to `width` px, as a browser does, beside a
 * `getBoundingClientRect` mock that gives the span the same width.
 */
export function resolveEmojiProbeWidth(width: number): void {
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo)
    if (element.textContent !== '\u{1F600}') return style
    return new Proxy(style, {
      get(target, key) {
        if (key === 'width') return `${String(width)}px`
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
  })
}
