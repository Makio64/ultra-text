// Shapes shared by the outline tracer's modules (trace/*.ts). Types only: this file emits no
// JavaScript.
//
// Coordinates. A coverage mask is row-major from its top-left corner, x right, y down, one unit
// per texel, texel (i, j) centred on (i + 0.5, j + 0.5). Contours and fitted pieces stay in
// those mask units until `traceCoverage` moves them to the glyph's own frame: origin at the pen
// on the baseline, Y up, as an OpenType outline.

/** A closed polyline `[x0, y0, x1, y1, ...]`; the last point joins the first. */
export type Polyline = number[]

/**
 * Box-filtered coverage of one glyph, traced at 0.5. Coverage bytes (`Uint8Array`,
 * `Uint8ClampedArray`) run 0..255 and floats 0..1.
 */
export interface CoverageMask {
  readonly alpha: Uint8Array | Uint8ClampedArray | Float32Array
  readonly width: number
  readonly height: number
  /** Elements per texel, `4` for canvas RGBA; defaults to `1`. */
  readonly stride?: number
  /** Element of the coverage within a texel, `3` for canvas alpha; defaults to `0`. */
  readonly offset?: number
  /** Mask x of the pen position the glyph was drawn at. */
  readonly originX: number
  /** Mask y of the baseline the glyph was drawn on. */
  readonly baselineY: number
}

/** Reusable working memory of one tracer; it only ever grows while the tracer lives. */
export interface TraceScratch {
  value: Float32Array
  next: Int32Array
  matrix: Float64Array
  rhsX: Float64Array
  rhsY: Float64Array
  ratio: Float64Array
}

/** `fitClosedPolyline`: a closed chain of quadratics in the polyline's own units. */
export interface FittedOutline {
  /** `[x0, y0, cx, cy, x1, y1, ...]`: each piece starts where the previous one ended. */
  readonly quadratics: Float64Array
  /** Largest distance from a resampled point to the curve. */
  readonly maxError: number
}
