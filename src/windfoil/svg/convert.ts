import type {
  SvgToWindfoilOptions,
  WindfoilSvgResult,
  WindfoilSvgSource,
  WindfoilSvgWarning,
} from '../../types.js'
import { walkSvg, type Warn } from './document.js'
import { shapePaths } from './shapePath.js'
import { resolvePaint } from './paint.js'
import { convertSvgPaths, windfoilOutlineFromSvgPaths } from './pathConverter.js'
/** Convert SVG markup, live elements, path records or SVGLoader output. */
export function svgToWindfoilOutlines(
  source: WindfoilSvgSource,
  options: SvgToWindfoilOptions = {},
): WindfoilSvgResult {
  if (typeof source !== 'string' && !('nodeType' in source) && !('paths' in source))
    return windfoilOutlineFromSvgPaths(source, options)
  const warnings: WindfoilSvgWarning[] = []
  const warn: Warn = (code, message, where) => {
    const warning: WindfoilSvgWarning = { code, message, ...(where ? { source: where } : {}) }
    warnings.push(warning)
    options.onWarning?.(warning)
    if ((code === 'stroke-ignored' ? options.strokes : options.unsupported) === 'error')
      throw new TypeError(`SVG ${code}: ${message}`)
  }
  let data: ReturnType<typeof walkSvg>
  if (typeof source === 'string') {
    if (typeof DOMParser === 'undefined')
      throw new TypeError(
        'SVG markup requires DOMParser; pass DOM-free path records in Node or Workers',
      )
    const document = new DOMParser().parseFromString(source, 'image/svg+xml')
    if (document.getElementsByTagNameNS('*', 'parsererror').length)
      throw new TypeError('Malformed SVG XML')
    data = walkSvg(document.documentElement, options, warn)
  } else if ('nodeType' in source) data = walkSvg(source, options, warn)
  else data = shapePaths(source, warn)
  const result = convertSvgPaths(
    data.paths,
    {
      ...options,
      ...((options.viewBox ?? data.viewBox) ? { viewBox: options.viewBox ?? data.viewBox! } : {}),
      preserveAspectRatio: options.preserveAspectRatio ?? data.aspect,
    },
    resolvePaint,
  )
  return { ...result, warnings: [...warnings, ...result.warnings] }
}
