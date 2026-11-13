import type { WindfoilSvgPaint } from '../../types.js'
let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
const parsedColorCache = new Map<string, readonly [number, number, number, number]>()
function parseColor(raw: string): readonly [number, number, number, number] | null {
  const cached = parsedColorCache.get(raw)
  if (cached) return cached
  let value = raw.trim().toLowerCase()
  let out: readonly [number, number, number, number] | null = null
  if (value === 'black') out = [0, 0, 0, 1]
  else if (value === 'white') out = [1, 1, 1, 1]
  else if (value === 'transparent') out = [0, 0, 0, 0]
  else {
    if (/^#[\da-f]{3,4}$/.test(value)) value = '#' + value.slice(1).replace(/./g, (c) => c + c)
    if (/^#[\da-f]{6}(?:[\da-f]{2})?$/.test(value)) {
      out = [
        parseInt(value.slice(1, 3), 16) / 255,
        parseInt(value.slice(3, 5), 16) / 255,
        parseInt(value.slice(5, 7), 16) / 255,
        value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1,
      ]
    } else {
      const match = /^rgba?\((.*)\)$/.exec(value)
      if (match) {
        const parts = match[1]!.trim().split(/[\s,/]+/)
        if (parts.length === 3 || parts.length === 4) {
          const nums = parts.map(
            (p, i) => parseFloat(p) / (p.endsWith('%') ? 100 : i < 3 ? 255 : 1),
          )
          if (nums.every(Number.isFinite))
            out = [
              Math.max(0, Math.min(1, nums[0]!)),
              Math.max(0, Math.min(1, nums[1]!)),
              Math.max(0, Math.min(1, nums[2]!)),
              Math.max(0, Math.min(1, nums[3] ?? 1)),
            ]
        }
      }
    }
  }
  if (out) {
    if (parsedColorCache.size >= 1024) parsedColorCache.clear()
    parsedColorCache.set(raw, out)
  }
  return out
}
export function colorPaint(value: string, alpha = 1): WindfoilSvgPaint {
  if (value.toLowerCase() === 'currentcolor') return { type: 'foreground', alpha }
  let rgba = parseColor(value)
  if (!rgba) {
    if (context === undefined) {
      context = null
      if (typeof OffscreenCanvas !== 'undefined')
        context = new OffscreenCanvas(1, 1).getContext('2d')
      else if (
        typeof document !== 'undefined' &&
        typeof globalThis.CanvasRenderingContext2D !== 'undefined'
      )
        context = document.createElement('canvas').getContext('2d')
    }
    if (context) {
      context.fillStyle = '#010203'
      context.fillStyle = value
      const first = context.fillStyle
      context.fillStyle = '#030201'
      context.fillStyle = value
      if (first === context.fillStyle) rgba = parseColor(first)
    }
  }
  return rgba
    ? { type: 'solid', color: [rgba[0], rgba[1], rgba[2], rgba[3] * alpha] }
    : { type: 'unsupported', value }
}
