import type { WindfoilBoundingBox, WindfoilPaint } from '../types.js'
import {
  readBox,
  readFlatCoordinates,
  readFlatNumbers,
  readFiniteFloat32,
  WINDFOIL_MAX_LAYERS,
  type NormalizedLayer,
} from './preprocessCore.js'
function layerHull(curves: ArrayLike<number>): WindfoilBoundingBox {
  const n = curves.length
  if (!n) return [0, 0, 0, 0]
  let x0 = curves[0]!,
    y0 = curves[1]!,
    x1 = x0,
    y1 = y0
  for (let i = 2; i < n; i += 2) {
    const x = curves[i]!,
      y = curves[i + 1]!
    if (x < x0) x0 = x
    else if (x > x1) x1 = x
    if (y < y0) y0 = y
    else if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/** Tight curve bounds accept controls outside an explicitly supplied ink box. */
function curvesInsideBox(
  curves: ArrayLike<number>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const n = curves.length
  for (let i = 0; i < n; i += 6) {
    const ax = curves[i]!,
      ay = curves[i + 1]!,
      bx = curves[i + 2]!,
      by = curves[i + 3]!,
      cx = curves[i + 4]!,
      cy = curves[i + 5]!
    if (!(
      ax >= minX &&
      ax <= maxX &&
      cx >= minX &&
      cx <= maxX &&
      ay >= minY &&
      ay <= maxY &&
      cy >= minY &&
      cy <= maxY
    ))
      return false
    if (!(bx >= minX && bx <= maxX)) {
      if (!Number.isFinite(bx)) return false
      const t = (ax - bx) / (ax - 2 * bx + cx)
      if (t > 0 && t < 1) {
        const u = 1 - t
        const x = u * u * ax + 2 * u * t * bx + t * t * cx
        if (x < minX || x > maxX) return false
      }
    }
    if (!(by >= minY && by <= maxY)) {
      if (!Number.isFinite(by)) return false
      const t = (ay - by) / (ay - 2 * by + cy)
      if (t > 0 && t < 1) {
        const u = 1 - t
        const y = u * u * ay + 2 * u * t * by + t * t * cy
        if (y < minY || y > maxY) return false
      }
    }
  }
  return true
}

function readPaint(
  value: unknown,
  label: string,
): Pick<NormalizedLayer, 'paint' | 'paintKind' | 'rgba'> {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${label} must be an object`)
  const paint = value as WindfoilPaint
  if (paint.type === 'foreground') {
    const raw = paint.alpha ?? 1
    const alpha =
      typeof raw === 'number' && raw >= 0 && raw <= 1
        ? raw
        : readFiniteFloat32(raw, `${label}.alpha`)
    if (alpha < 0 || alpha > 1) throw new RangeError(`${label}.alpha must be in 0–1`)
    return { paint: { type: 'foreground', alpha }, paintKind: 0, rgba: [0, 0, 0, alpha] }
  }
  if (paint.type === 'solid') {
    const c = paint.color as readonly unknown[]
    const color =
      Array.isArray(c) &&
      c.length === 4 &&
      typeof c[0] === 'number' &&
      typeof c[1] === 'number' &&
      typeof c[2] === 'number' &&
      typeof c[3] === 'number'
        ? (c as readonly number[])
        : readFlatNumbers(paint.color, `${label}.color`, 4)
    for (let i = 0; i < 4; i++) {
      const v = color[i]!
      if (!(v >= 0 && v <= 1)) {
        readFiniteFloat32(v, `${label}.color[${i}]`)
        throw new RangeError(`${label}.color[${i}] must be in 0–1`)
      }
    }
    const rgba: readonly [number, number, number, number] = [
      color[0]!,
      color[1]!,
      color[2]!,
      color[3]!,
    ]
    return { paint: { type: 'solid', color: rgba }, paintKind: 1, rgba }
  }
  // Unknown runtime tags are rejected even though the public union is exhaustive.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (paint.type === 'linear' || paint.type === 'radial' || paint.type === 'sweep') {
    // Full gradient normalization is performed by the lazy colour module before allocation.
    return { paint, paintKind: 2, rgba: [0, 0, 0, 1] }
  }
  throw new TypeError(`${label}.type must be solid, foreground, linear, radial or sweep`)
}

export function normalizeLayers(
  inputValue: unknown,
  quadratics: ArrayLike<number>,
  bbox: WindfoilBoundingBox,
  unitsPerEm: number,
  label: string,
): readonly NormalizedLayer[] {
  if (typeof inputValue !== 'object' || inputValue === null || !('length' in inputValue)) {
    throw new TypeError(`${label}.layers must be an array-like list`)
  }
  const input = inputValue as ArrayLike<unknown>
  if (
    !Number.isSafeInteger(input.length) ||
    input.length < 0 ||
    input.length > WINDFOIL_MAX_LAYERS
  ) {
    throw new RangeError(`${label}.layers.length must be between 0 and ${WINDFOIL_MAX_LAYERS}`)
  }
  const layers: NormalizedLayer[] = []
  const epsilon = 1e-4 * unitsPerEm
  const minX = bbox[0] - epsilon,
    minY = bbox[1] - epsilon,
    maxX = bbox[2] + epsilon,
    maxY = bbox[3] + epsilon
  const append = (
    curves: ArrayLike<number>,
    box: WindfoilBoundingBox,
    paint: unknown,
    paintLabel: string,
    hullChecked: boolean,
  ): void => {
    const normalized = readPaint(paint, paintLabel)
    if (curves.length) {
      if (
        box[0] < minX ||
        box[1] < minY ||
        box[2] > maxX ||
        box[3] > maxY ||
        (!hullChecked && !curvesInsideBox(curves, minX, minY, maxX, maxY))
      ) {
        const prefix = paintLabel.replace(/\.paint$/, '')
        readFlatCoordinates(curves, `${prefix}.quadratics`)
        throw new RangeError(`${prefix}.bbox must lie inside ${label}.bbox`)
      }
    }
    layers.push({ quadratics: curves, bbox: box, paintLabel, ...normalized })
  }
  if (quadratics.length) append(quadratics, bbox, { type: 'foreground' }, `${label}.paint`, false)
  for (let i = 0; i < input.length; i++) {
    const layerLabel = `${label}.layers[${i}]`
    const layer = input[i]
    if (typeof layer !== 'object' || layer === null)
      throw new TypeError(`${layerLabel} must be an object`)
    const value = layer as { quadratics?: unknown; bbox?: unknown; paint?: unknown }
    const hasBox = value.bbox !== undefined
    const curves =
      hasBox && value.quadratics instanceof Float32Array && value.quadratics.length > 0
        ? value.quadratics
        : readFlatCoordinates(value.quadratics, `${layerLabel}.quadratics`)
    if (curves.length % 6) {
      readFlatCoordinates(value.quadratics, `${layerLabel}.quadratics`)
      throw new RangeError(`${layerLabel}.quadratics length must be a multiple of 6`)
    }
    const box = hasBox ? readBox(value.bbox, `${layerLabel}.bbox`) : layerHull(curves)
    append(curves, box, value.paint, `${layerLabel}.paint`, !hasBox)
  }
  return layers
}
