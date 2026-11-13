import type { WindfoilGlyphOutline } from '../types.js'
import * as core from './preprocessCore.js'
import { normalizeLayers } from './layerNormalization.js'
export * from './preprocessCore.js'
export function preprocessWindfoilGlyphs(
  sources: readonly core.WindfoilGlyphSource[],
  options: core.WindfoilPreprocessOptions = {},
): core.WindfoilPreprocessResult {
  return core.preprocessWindfoilGlyphs(sources, { ...options, normalizeLayers })
}
export function preprocessWindfoilOutlines(
  sources: readonly { readonly key: string; readonly outline: WindfoilGlyphOutline }[],
  options: core.WindfoilPreprocessOptions = {},
): core.WindfoilPreprocessResult {
  return core.preprocessWindfoilOutlines(sources, { ...options, normalizeLayers })
}
export function validateWindfoilGlyphOutline(
  outline: unknown,
): asserts outline is WindfoilGlyphOutline {
  core.validateWindfoilGlyphOutline(outline, normalizeLayers)
}
