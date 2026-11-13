import type { WindfoilAffine } from '../../types.js'
export function viewportTransform(
  box: readonly [number, number, number, number],
  width: number,
  height: number,
  aspect = 'xMidYMid meet',
): WindfoilAffine {
  if (!(box[2] > 0 && box[3] > 0 && width > 0 && height > 0))
    throw new RangeError('SVG viewport width and height must be positive')
  let sx = width / box[2],
    sy = height / box[3],
    ax = 0,
    ay = 0
  const tokens = aspect
      .trim()
      .replace(/^defer\s+/, '')
      .split(/\s+/),
    align = tokens[0]!
  if (align !== 'none') {
    if (
      !/^x(Min|Mid|Max)Y(Min|Mid|Max)$/.test(align) ||
      (tokens[1] && tokens[1] !== 'meet' && tokens[1] !== 'slice')
    )
      throw new TypeError('Invalid preserveAspectRatio')
    sx = sy = tokens[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
    ax = (width - sx * box[2]) * (align.includes('xMax') ? 1 : align.includes('xMid') ? 0.5 : 0)
    ay = (height - sy * box[3]) * (align.includes('YMax') ? 1 : align.includes('YMid') ? 0.5 : 0)
  }
  return [sx, 0, 0, sy, ax - sx * box[0], ay - sy * box[1]]
}
