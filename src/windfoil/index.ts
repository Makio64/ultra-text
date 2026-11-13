import type { WebGPURenderer } from 'three/webgpu'
import type {
  WindfoilGlyphOutline,
  WindfoilShapeInstance,
  WindfoilShapes,
  WindfoilShapesOptions,
} from '../types.js'
export { windfoilOutlineFromSvgPaths } from './svg/pathConverter.js'
export { svgToWindfoilOutlines } from './svg/convert.js'
export { createSvgEmojiOutlineProvider } from './emoji.js'
export async function createWindfoilShapes(
  renderer: WebGPURenderer,
  outlines:
    ReadonlyMap<string, WindfoilGlyphOutline> | Readonly<Record<string, WindfoilGlyphOutline>>,
  instances: readonly WindfoilShapeInstance[],
  options?: WindfoilShapesOptions,
): Promise<WindfoilShapes> {
  const { buildWindfoilShapes } = await import('./shapes.js')
  return buildWindfoilShapes(renderer, outlines, instances, options)
}
