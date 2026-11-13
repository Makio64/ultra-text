import type { Node, UniformNode } from 'three/webgpu'
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  bitcast,
  cameraProjectionMatrix,
  clamp,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  renderGroup,
  step,
  uint,
  uniform,
  vec2,
  vec4,
  viewportSize,
  wgslFn,
} from 'three/tsl'

import type { GlyphVertexExtension } from '../text/GlyphTextMaterial.js'
import type { WindfoilStorage } from './WindfoilMaterial.js'

/*
 * Adapted from texel-org/windfoil's Apache-2.0 reference implementation,
 * src/windfoil.wgsl (Matt DesLauriers, 2026). The CPU prepass guarantees that
 * each quadratic passed here is monotone in x and y, and the caller mirrors x so
 * that the walk always runs toward -x. This closed form computes the piece's
 * contribution to the pixel's winding integral: one vec4 root solve gives the
 * parameters where the piece meets the row window and the pixel's two sides.
 * `lo` and `hi` are the window already cut to the piece's own extent, so the
 * piece is at `lo` and `hi` exactly at the first two of those parameters.
 */
const integratePiece = wgslFn<{
  q1: Node<'vec2'>
  q2: Node<'vec2'>
  q3: Node<'vec2'>
  lo: Node<'float'>
  hi: Node<'float'>
  hx: Node<'float'>
}>(`
fn windfoil_integrate_piece(q1: vec2f, q2: vec2f, q3: vec2f, lo: f32, hi: f32, hx: f32) -> f32 {
  let a2 = q1 - 2.0 * q2 + q3;
  let b1 = q2 - q1;
  let y_rising = q3.y >= q1.y;
  let x_rising = q3.x >= q1.x;
  let A2 = a2.yyxx;
  let B1 = b1.yyxx;
  let V = vec4f(
    select(vec2f(hi, lo), vec2f(lo, hi), y_rising),
    select(vec2f(hx, -hx), vec2f(-hx, hx), x_rising)
  );
  let R = vec2<bool>(y_rising, x_rising).xxyy;
  let C = q1.yyxx - V;
  let sat0 = select(C <= vec4f(0.0), C >= vec4f(0.0), R);
  let sat1 = select(q3.yyxx >= V, q3.yyxx <= V, R);
  let sq = sqrt(max(B1 * B1 - A2 * C, vec4f(0.0)));
  let den = B1 + select(-sq, sq, R);
  let raw = clamp(select(vec4f(0.0), -C / den, den != vec4f(0.0)), vec4f(0.0), vec4f(1.0));
  let T = select(select(raw, vec4f(1.0), sat1), vec4f(0.0), sat0);
  if (T.y <= T.x) { return 0.0; }
  let tc = clamp(T.zw, T.xx, T.yy);
  let t1 = tc.x;
  let t2 = max(tc.y, t1);
  var acc = 0.0;
  let dt = t2 - t1;
  if (dt > 0.0) {
    let tm = 0.5 * (t1 + t2);
    let hmid = a2 * tm + b1;
    let x_mid = (hmid.x + b1.x) * tm + q1.x + hx;
    acc = dt * (x_mid * hmid.y + (dt * dt * (1.0 / 12.0)) * (a2.x * hmid.y + 2.0 * a2.y * hmid.x));
  }
  // The stretch right of the pixel spans its full width, times its rise: from the window's
  // start to the crossing of the pixel's right side on a piece moving right, from that crossing
  // to the window's end on one moving left. A crossing outside the window is the window's own
  // bound there, taken as given: a piece that only passes beside the pixel then adds exactly
  // what the full-width shortcut would, and one on the far side exactly nothing. The difference
  // of two roots loses that under magnification, where it is a few units in their last place.
  let tq = select(t1, t2, x_rising);
  let yq = select(select(q1.y + (a2.y * tq + 2.0 * b1.y) * tq, V.y, tq >= T.y), V.x, tq <= T.x);
  acc += select(yq - V.x, V.y - yq, x_rising) * hx;
  return acc + acc;
}
`)

// Reciprocal and direct heights round independently. Include a neighbour only
// if the selected windows miss part of the pixel, matching their shared edges.
const bandRange = wgslFn<{
  origin: Node<'float'>
  halfY: Node<'float'>
  height: Node<'float'>
  inverseHeight: Node<'float'>
  count: Node<'uint'>
}>(`
fn windfoil_band_range(origin: f32, halfY: f32, height: f32, inverseHeight: f32, count: u32) -> vec2u {
  let limit = f32(count) - 1.0;
  var first = u32(clamp(floor((-origin - halfY) * inverseHeight), 0.0, limit));
  var last = u32(clamp(floor((-origin + halfY) * inverseHeight), 0.0, limit));
  first -= select(0u, 1u, first > 0u && origin + f32(first) * height > -halfY);
  last += select(0u, 1u, last + 1u < count && origin + f32(last + 1u) * height < halfY);
  return vec2u(first, last);
}
`)

const bandWindow = wgslFn<{
  origin: Node<'float'>
  halfY: Node<'float'>
  height: Node<'float'>
  count: Node<'uint'>
  band: Node<'uint'>
}>(`
fn windfoil_band_window(origin: f32, halfY: f32, height: f32, count: u32, band: u32) -> vec2f {
  if (count <= 1u) { return vec2f(-halfY, halfY); }
  return vec2f(
    max(-halfY, origin + f32(band) * height),
    min(halfY, origin + f32(band + 1u) * height)
  );
}
`)

const ROW_STRIDE = 6
// The skirt must leave no ink outside the quad, on single-sampled and 4-sample passes alike.
// A fragment integrates a box reaching half a pixel from its centre. A multisampled pass also
// stores it only in the samples its quad covers, and WebGPU's only such count, 4, puts them
// 1/8 and 3/8 px from the centre along the screen axes: 3/8 px across an axis-aligned edge,
// √10/8 px across a rotated one at most. Each skirt adds 1/16 px for the rasterizer's
// sub-pixel grid, which holds that rotated case too.
const KERNEL_SKIRT_PX = 0.5625
const MULTISAMPLE_SKIRT_PX = 0.9375
const SKIRT_MAX_SCALE = 16

let kernelSkirt: UniformNode<'float', number> | undefined
/**
 * The skirt of the pass being drawn, in pixels: one uniform for every Windfoil material, set
 * from the pass's sample count at each render, whenever its shader was compiled. The count is
 * that of the target the pass draws into: a render target, three's frame buffer target in its
 * place, or else an output render target; the renderer's own count only without any.
 */
export function windfoilKernelSkirt(): UniformNode<'float', number> {
  return (kernelSkirt ??= uniform(KERNEL_SKIRT_PX)
    .setName('ultraWindfoilSkirt')
    .setGroup(renderGroup)
    .onRenderUpdate(({ renderer }) => {
      const target = renderer?.getRenderTarget() ?? renderer?.getOutputRenderTarget()
      const samples = target ? target.samples : (renderer?.currentSamples ?? 0)
      return samples >= 4 ? MULTISAMPLE_SKIRT_PX : KERNEL_SKIRT_PX
    }))
}

/** What a tone model that dilates the outline adds to the quad of each glyph. */
export interface WindfoilDilation {
  /** (ems, pixels at most, pixels per em from which it stops): `TextTone.dilation`. */
  readonly law: Node<'vec3'>
  /** The glyph's font size in local units; zero where the outline must stay as it is. */
  readonly em: Node<'float'>
  /**
   * Receives the glyph's dilation in pixels of the pass being drawn, for its fragments; below
   * zero from the size where the model stops.
   */
  readonly amount: Node<'float'>
}

export function windfoilVertexExtension(
  bounds: Node<'vec4'>,
  glyphPosition: Node<'vec2'>,
  dilation?: WindfoilDilation,
): GlyphVertexExtension {
  const modelViewProjection = cameraProjectionMatrix.mul(modelViewMatrix)
  return (quad, rect, position, depth, motionScale) => {
    const clipAt = (point: Node<'vec2'>): Node<'vec4'> =>
      modelViewProjection.mul(vec4(point, depth, 1))
    // Vertices behind the camera get no skirt below, so only the positive side of w matters.
    const toPixels = (clip: Node<'vec4'>): Node<'vec2'> =>
      clip.xy.div(max(clip.w, 1e-6)).mul(viewportSize).mul(0.5)
    const clip = clipAt(position)
    const clipX = clipAt(position.add(vec2(1, 0)))
    const clipY = clipAt(position.add(vec2(0, 1)))
    const projected = toPixels(clip)
    const screenX = toPixels(clipX).sub(projected)
    const screenY = toPixels(clipY).sub(projected)
    const determinant = screenX.x.mul(screenY.y).sub(screenX.y.mul(screenY.x))
    if (dilation) {
      // The same quad as below, for fragments that integrate a box 2d pixels larger and sample
      // it d pixels lower on screen: the skirt grows by d, and the quad moves by the local
      // vector whose screen image is d pixels up. Each corner still carries the outline
      // coordinate of where it lands, so a pass that ignores d draws the glyph unmoved.
      const pixel = vec2(length(screenY), length(screenX))
        .div(max(abs(determinant), 1e-12))
        .toConst()
      const emPixels = dilation.em.div(max(pixel.x, pixel.y)).toConst()
      // The step sits half a pixel early: text laid out at exactly the limit must not
      // straddle it through the rounding of the screen differences above. A glyph of unknown
      // size reads as one of no size: no dilation, and still below the limit.
      const signed = mix(
        float(-1),
        min(emPixels.mul(dilation.law.x), dilation.law.y),
        step(emPixels, dilation.law.z.sub(0.5)),
      ).toConst()
      dilation.amount.assign(signed)
      const amount = max(signed, 0).toConst()
      const rise = vec2(screenY.x.negate(), screenX.x).mul(
        amount.mul(determinant).div(max(determinant.mul(determinant), 1e-24)),
      )
      const linear = quad
        .mul(2)
        .sub(1)
        .mul(pixel)
        .mul(windfoilKernelSkirt().add(amount))
        .add(rise)
        .toConst()
      const deltaW = dot(linear, vec2(clipX.w, clipY.w).sub(clip.w))
      const local = linear
        .mul(max(clip.w, 0).div(max(clip.w.sub(deltaW), max(clip.w, 1e-6).div(SKIRT_MAX_SCALE))))
        .toConst()
      const size = bounds.zw.sub(bounds.xy)
      glyphPosition.assign(
        bounds.xy
          .add(size.mul(quad))
          .add(
            local.mul(size.div(rect.zw.sub(rect.xy).max(vec2(1e-6)).mul(max(motionScale, 1e-4)))),
          ),
      )
      return position.add(local)
    }
    // A fragment integrates a glyph-space box whose sides are the lengths of
    // each glyph axis's screen gradient (windfoilPixelBox), so it can hold ink
    // only within half that box of the ink bbox. Per pixel those gradients are
    // |screenY| / |det| local units along x and |screenX| / |det| along y, the
    // rows of the inverse 2x2 screen Jacobian. Padding by that skirt keeps
    // rotated, sheared, perspective, beauty, and shadow passes from clipping
    // the partly covered pixels just outside the bbox. The rows' absolute sums
    // would bound a screen-aligned pixel instead, up to √2 further than the box
    // reaches on rotated text.
    const inverseDeterminant = windfoilKernelSkirt().div(max(abs(determinant), 1e-12))
    const linearPadding = vec2(length(screenY), length(screenX)).mul(inverseDeterminant)
    // That Jacobian is local to the vertex, but moving the vertex changes its
    // screen scale by w / w'. Unscaled, a distant glyph seen at a grazing angle
    // pushed its near corners past the camera and drew its quad across dozens of
    // screens of zero-coverage fragments. clip.w is affine in local position, so
    // the differences above are its exact gradient, and scaling the move by
    // w / (w - Δw) lands the corner exactly on the linear screen offset; moving
    // toward the camera, w' = w² / (w - Δw) stays positive. An offset beyond the
    // plane's horizon has no solution, so moves away are capped. Vertices behind
    // the camera are never visible and their edges are clipped at the near plane,
    // so max(w, 0) gives them no skirt; the branch-free form keeps the startup
    // vertex shader small.
    const direction = quad.mul(2).sub(1)
    const deltaW = dot(direction.mul(linearPadding), vec2(clipX.w, clipY.w).sub(clip.w))
    const localPadding = linearPadding.mul(
      max(clip.w, 0).div(max(clip.w.sub(deltaW), max(clip.w, 1e-6).div(SKIRT_MAX_SCALE))),
    )
    const outlinePerLocal = bounds.zw
      .sub(bounds.xy)
      .div(rect.zw.sub(rect.xy).max(vec2(1e-6)).mul(max(motionScale, 1e-4)))
    const outlinePadding = localPadding.mul(outlinePerLocal)
    glyphPosition.assign(
      bounds.xy
        .sub(outlinePadding)
        .add(bounds.zw.sub(bounds.xy).add(outlinePadding.mul(2)).mul(quad)),
    )
    return position.add(direction.mul(localPadding))
  }
}

type AssignableNode<T extends string> = Node<T> & {
  toVar(name?: string): Node<T> & { setAssignable(value: boolean): Node<T> }
}

export function createWindfoilCoverage(storage: WindfoilStorage) {
  const { curves, rows } = storage
  const localVar = <T extends string>(node: Node<T>, name?: string): Node<T> =>
    (node as AssignableNode<T>).toVar(name).setAssignable(true)
  const overlap = Fn<[Node<'float'>, Node<'float'>, Node<'float'>, Node<'float'>], Node<'float'>>(
    ([a0, a1, b0, b1]) => max(min(a1, b1).sub(max(a0, b0)), 0),
  )

  // Left of a row's split, fewer pieces start before the pixel than end after it: the row's
  // second copy, by ascending x-minimum, is walked toward the right edge instead. Mirroring x
  // by `direction` turns that walk into the first one, by descending x-maximum toward the left
  // edge. Every closed contour rises and falls by the same amount inside a row window, so both
  // sums are equal and each walk can stop at the first piece wholly on its far side. Pieces on
  // the near side cost one full-width span.
  const integrateFace = Fn<
    [Node<'vec4'>, Node<'float'>, Node<'vec2'>, Node<'vec2'>],
    Node<'float'>
  >(([header, y0, center, size]) => {
    const rowBase = uint(header.x).toConst()
    const count = uint(header.y).toConst()
    const halfX = size.x.mul(0.5).toConst()
    const halfY = size.y.mul(0.5).toConst()
    const relativeOrigin = y0.sub(center.y).toConst()
    const ulp16 = max(abs(center.x), abs(center.y)).mul(1.92e-6).toConst()
    const range = (
      bandRange({
        origin: relativeOrigin,
        halfY,
        height: header.z,
        inverseHeight: header.w,
        count,
      }) as Node<'uvec2'>
    ).toConst()
    const accumulated = localVar(float(0), 'windfoilFaceIntegral')
    Loop({ start: range.x, end: range.y, type: 'uint', condition: '<=' }, ({ i }) => {
      const win = (
        bandWindow({
          origin: relativeOrigin,
          halfY,
          height: header.z,
          count,
          band: i,
        }) as Node<'vec2'>
      ).toConst()
      const windowLow = win.x
      const windowHigh = win.y
      If(windowHigh.lessThanEqual(windowLow), () => {
        Continue()
      })
      const row = rowBase.add(i).mul(ROW_STRIDE).toConst()
      const pieceCount = uint(rows.element(row.add(1))).toConst()
      const split = (
        bitcast(rows.element(row.add(5)), 'float') as unknown as Node<'float'>
      ).toConst()
      const leftward = center.x.lessThan(split).toConst()
      const leftF = float(leftward).toConst()
      const listStart = uint(rows.element(row)).add(uint(leftward).mul(pieceCount)).toConst()
      const direction = float(1).sub(leftF.mul(2)).toConst()
      const bandAcc = localVar(float(0))
      Loop({ start: uint(0), end: pieceCount, type: 'uint' }, ({ i: k }) => {
        const base = listStart.add(k).mul(3).toConst()
        const q1 = vec2(curves.element(base)).sub(center).toConst()
        const q3 = vec2(curves.element(base.add(2)))
          .sub(center)
          .toConst()
        const sx1 = q1.x.mul(direction).toConst()
        const sx3 = q3.x.mul(direction).toConst()
        If(max(sx1, sx3).lessThanEqual(halfX.negate()), () => {
          Break()
        })
        const yMinimum = min(q1.y, q3.y).toConst()
        const yMaximum = max(q1.y, q3.y).toConst()
        const low = max(windowLow, yMinimum).toConst()
        const high = min(windowHigh, yMaximum).toConst()
        const spanY = high.sub(low).toConst()
        If(spanY.lessThanEqual(0), () => {
          Continue()
        })
        If(min(sx1, sx3).greaterThanEqual(halfX), () => {
          const rise = spanY.mul(float(q3.y.greaterThanEqual(q1.y)).mul(2).sub(1))
          bandAcc.addAssign(size.x.mul(rise))
          Continue()
        })
        If(abs(sx3.sub(sx1)).add(yMaximum.sub(yMinimum)).lessThanEqual(ulp16), () => {
          const rise = spanY.mul(float(q3.y.greaterThanEqual(q1.y)).mul(2).sub(1))
          bandAcc.addAssign(
            clamp(sx1.add(sx3).mul(0.5), halfX.negate(), halfX).add(halfX).mul(rise),
          )
          Continue()
        })
        const q2 = vec2(curves.element(base.add(1)))
          .sub(center)
          .toConst()
        bandAcc.addAssign(
          integratePiece({
            q1: vec2(sx1, q1.y),
            q2: vec2(q2.x.mul(direction), q2.y),
            q3: vec2(sx3, q3.y),
            lo: low,
            hi: high,
            hx: halfX,
          }) as Node<'float'>,
        )
      })
      accumulated.addAssign(direction.mul(bandAcc))
    })
    return accumulated
  })

  const profileFace = Fn<[Node<'vec4'>, Node<'vec4'>, Node<'vec2'>, Node<'vec2'>], Node<'float'>>(
    ([header, box, center, size]) => {
      const half = size.mul(0.5).toConst()
      const pixelLow = center.sub(half).toConst()
      const pixelHigh = center.add(half).toConst()
      const ink = localVar(float(0), 'windfoilProfileIntegral')
      If(min(pixelHigh.x, box.z).greaterThan(max(pixelLow.x, box.x)), () => {
        const rowBase = uint(header.x).toConst()
        const limit = header.y.sub(1).toConst()
        const first = uint(clamp(floor(pixelLow.y.sub(box.y).mul(header.w)), 0, limit)).toConst()
        const last = uint(clamp(floor(pixelHigh.y.sub(box.y).mul(header.w)), 0, limit)).toConst()
        Loop({ start: first, end: last, type: 'uint', condition: '<=' }, ({ i }) => {
          const row = rowBase.add(i).mul(ROW_STRIDE).toConst()
          const edgeLow = box.y.add(float(i).mul(header.z)).toConst()
          const edgeHigh = edgeLow.add(header.z)
          const overlapY = overlap(pixelLow.y, pixelHigh.y, edgeLow, edgeHigh)
          const rowXMin = bitcast(rows.element(row.add(3)), 'float') as unknown as Node<'float'>
          const rowXMax = bitcast(rows.element(row.add(4)), 'float') as unknown as Node<'float'>
          const density = bitcast(rows.element(row.add(2)), 'float') as unknown as Node<'float'>
          const overlapX = overlap(pixelLow.x, pixelHigh.x, rowXMin, rowXMax)
          ink.addAssign(density.mul(overlapY).mul(overlapX))
        })
      })
      return ink
    },
  )

  return { integrateFace, profileFace }
}

export function windfoilPixelBox(
  glyphPosition: Node<'vec2'>,
  dy: Node<'vec2'> = dFdy(glyphPosition),
): Node<'vec2'> {
  const dx = dFdx(glyphPosition)
  return vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y))).max(vec2(1e-9))
}
