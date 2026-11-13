import type { Node } from 'three/webgpu'
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  bitcast,
  cameraProjectionMatrix,
  clamp,
  float,
  max,
  min,
  modelViewMatrix,
  uint,
  vec2,
  viewportSize,
  wgslFn,
} from 'three/tsl'

import type { GlyphVertexExtension } from '../text/GlyphTextMaterial.js'
import { windfoilKernelSkirt, type WindfoilDilation } from '../windfoil/coverage.js'
import type { WindfoilStorage } from '../windfoil/WindfoilMaterial.js'

const vertexSkirt = wgslFn<{
  mvp: Node<'mat4'>
  viewport: Node<'vec2'>
  quad: Node<'vec2'>
  position: Node<'vec2'>
  depth: Node<'float'>
  skirt: Node<'float'>
}>(`
fn slug_vertex_skirt(mvp: mat4x4f, viewport: vec2f, quad: vec2f, position: vec2f, depth: f32, skirt: f32) -> vec2f {
  let colX = mvp[0];
  let colY = mvp[1];
  let clip = mvp * vec4f(position, depth, 1.0);
  let safeW = max(clip.w, 1e-6);
  let sx = (colX.xy * safeW - clip.xy * colX.w) * viewport;
  let sy = (colY.xy * safeW - clip.xy * colY.w) * viewport;
  let absDet = max(abs(fma(sx.x, sy.y, -sx.y * sy.x)), 1e-20);
  let u = fma(quad, vec2f(2.0), vec2f(-1.0)) * vec2f(length(sy), length(sx)) * (skirt * 2.0 * safeW * safeW);
  let mult = max(clip.w, 0.0) / max(fma(-u.x, colX.w, fma(-u.y, colY.w, absDet * clip.w)), absDet * safeW * 0.0625);
  return u * mult;
}
`)

const vertexDilated = wgslFn<{
  mvp: Node<'mat4'>
  viewport: Node<'vec2'>
  quad: Node<'vec2'>
  position: Node<'vec2'>
  depth: Node<'float'>
  skirt: Node<'float'>
  em: Node<'float'>
  law: Node<'vec3'>
}>(`
fn slug_vertex_dilated(mvp: mat4x4f, viewport: vec2f, quad: vec2f, position: vec2f, depth: f32, skirt: f32, em: f32, law: vec3f) -> vec3f {
  let colX = mvp[0];
  let colY = mvp[1];
  let clip = mvp * vec4f(position, depth, 1.0);
  let safeW = max(clip.w, 1e-6);
  let sx = (colX.xy * safeW - clip.xy * colX.w) * viewport;
  let sy = (colY.xy * safeW - clip.xy * colY.w) * viewport;
  let det = fma(sx.x, sy.y, -sx.y * sy.x);
  let absDet = max(abs(det), 1e-20);
  let twoW2 = 2.0 * safeW * safeW;
  let len = vec2f(length(sy), length(sx));
  let emPixels = (em * absDet) / max(twoW2 * max(len.x, len.y), 1e-20);
  let signed = select(-1.0, min(emPixels * law.x, law.y), emPixels <= law.z - 0.5);
  let amount = max(signed, 0.0);
  let signedAmount = select(-amount, amount, det >= 0.0);
  let u = (fma(quad, vec2f(2.0), vec2f(-1.0)) * len * (skirt + amount) + vec2f(-sy.x, sx.x) * signedAmount) * twoW2;
  let mult = max(clip.w, 0.0) / max(fma(-u.x, colX.w, fma(-u.y, colY.w, absDet * clip.w)), absDet * safeW * 0.0625);
  return vec3f(u * mult, signed);
}
`)

export function slugVertexExtension(
  bounds: Node<'vec4'>,
  glyphPosition: Node<'vec2'>,
  dilation?: WindfoilDilation,
): GlyphVertexExtension {
  const modelViewProjection = cameraProjectionMatrix.mul(modelViewMatrix)
  return (quad, rect, position, depth, motionScale) => {
    const mvp = modelViewProjection.toConst()
    const boundsSize = bounds.zw.sub(bounds.xy)
    const localSize = rect.zw.sub(rect.xy).max(vec2(1e-6)).mul(max(motionScale, 1e-4))
    if (dilation) {
      const out = (
        vertexDilated({
          mvp,
          viewport: viewportSize,
          quad,
          position,
          depth,
          skirt: windfoilKernelSkirt(),
          em: dilation.em,
          law: dilation.law,
        }) as unknown as Node<'vec3'>
      ).toConst()
      dilation.amount.assign(out.z)
      const local = out.xy.toConst()
      glyphPosition.assign(bounds.xy.add(boundsSize.mul(quad.add(local.div(localSize)))))
      return position.add(local)
    }
    const localOffset = (
      vertexSkirt({
        mvp,
        viewport: viewportSize,
        quad,
        position,
        depth,
        skirt: windfoilKernelSkirt(),
      }) as unknown as Node<'vec2'>
    ).toConst()
    glyphPosition.assign(bounds.xy.add(boundsSize.mul(quad.add(localOffset.div(localSize)))))
    return position.add(localOffset)
  }
}

const pixelMetricsAuto = wgslFn<{
  p: Node<'vec2'>
}>(`
fn slug_pixel_metrics_auto(p: vec2f) -> vec4f {
  let dx = dpdx(p);
  let dy = dpdy(p);
  let lenSq = max(vec2f(fma(dx.x, dx.x, dy.x * dy.x), fma(dx.y, dx.y, dy.y * dy.y)), vec2f(1e-18));
  let inv = inverseSqrt(lenSq);
  return vec4f(lenSq * (inv * 0.5), inv);
}
`)

const pixelMetricsFromDy = wgslFn<{
  p: Node<'vec2'>
  dy: Node<'vec2'>
}>(`
fn slug_pixel_metrics(p: vec2f, dy: vec2f) -> vec4f {
  let dx = dpdx(p);
  let lenSq = max(vec2f(fma(dx.x, dx.x, dy.x * dy.x), fma(dx.y, dx.y, dy.y * dy.y)), vec2f(1e-18));
  let inv = inverseSqrt(lenSq);
  return vec4f(lenSq * (inv * 0.5), inv);
}
`)

export function slugPixelMetrics(glyphPosition: Node<'vec2'>, dy?: Node<'vec2'>): Node<'vec4'> {
  if (!dy) return pixelMetricsAuto({ p: glyphPosition }) as unknown as Node<'vec4'>
  return pixelMetricsFromDy({ p: glyphPosition, dy }) as unknown as Node<'vec4'>
}

const solveStraddle = wgslFn<{
  c1: Node<'vec2'>
  c2: Node<'vec2'>
  c3: Node<'vec2'>
  xLo: Node<'float'>
  dy1: Node<'float'>
  s: Node<'float'>
  invDiam: Node<'float'>
}>(`
fn slug_solve_straddle(c1: vec2f, c2: vec2f, c3: vec2f, xLo: f32, dy1: f32, s: f32, invDiam: f32) -> vec2f {
  let b = c1 - c2;
  let a = (c3 - c2) + b;
  let d = sqrt(max(fma(-a.y, dy1, b.y * b.y), 1e-24));
  let t = dy1 / fma(s, d, b.y);
  let u = saturate(fma(fma(a.x, t, -2.0 * b.x), t, c1.x - xLo) * invDiam);
  return vec2f(s * u, fma(-u, u, u));
}
`)

const bandActive = wgslFn<{
  packedRow: Node<'uint'>
  span: Node<'vec2'>
}>(`
fn slug_band_active(packedRow: u32, span: vec2f) -> bool {
  return (packedRow & 63u) > 0u && span.x > f32((packedRow >> 6u) & 15u) && span.y > f32((packedRow >> 10u) & 3u);
}
`)

const solveShadowStraddle = wgslFn<{
  c1: Node<'vec2'>
  c2: Node<'vec2'>
  c3: Node<'vec2'>
  rcX: Node<'float'>
  dy1: Node<'float'>
  s: Node<'float'>
}>(`
fn slug_solve_shadow_straddle(c1: vec2f, c2: vec2f, c3: vec2f, rcX: f32, dy1: f32, s: f32) -> f32 {
  let b = c1 - c2;
  let a = (c3 - c2) + b;
  let d = sqrt(max(fma(-a.y, dy1, b.y * b.y), 1e-24));
  let t = dy1 / fma(s, d, b.y);
  return select(0.0, s, fma(fma(a.x, t, -2.0 * b.x), t, c1.x) > rcX);
}
`)

const combineRays = wgslFn<{
  xc: Node<'vec2'>
  yc: Node<'vec2'>
}>(`
fn slug_combine_rays(xc: vec2f, yc: vec2f) -> f32 {
  let ax = abs(xc.x);
  let ay = abs(yc.x);
  let wx = xc.y * xc.y;
  let wy = yc.y * yc.y;
  let weighted = fma(ax, wx, ay * wy) / max(wx + wy, 1e-12);
  return saturate(max(weighted, min(ax, ay)));
}
`)

/**
 * Dual-ray Slug coverage evaluator over per-band clipped monotone quadratic pieces:
 * - SoA split `[p1, p3] | [p2]` band layout stores all endpoint pairs `[p1_i, p3_i]`
 *   contiguously before middle controls `[p2_i]`, achieving 100% L1 cache-line utilization
 *   during the endpoint walk and fetching `p2` only on pixel-straddling boundary curves.
 * - Per-band De Casteljau blossom clipping tightens each curve's `[xMin, xMax]` to the active
 *   band interval, maximizing early `Break()` and convex-hull winding bypasses at 0 extra VRAM.
 * - Single-word `uint32` `(curveStart << 12) | (qMax << 10) | (qMin << 6) | curveCount` band
 *   headers (`SLUG_ROW_STRIDE = 1`) with fine-grained bands (`targetPiecesPerBand = 2`),
 *   two-sided band bound culling (`qMin` and `qMax`), and orthogonal degenerate culling.
 * - Combines horizontal (`xc`) and rotated vertical (`yc`) rays via Lengyel's reliability
 *   weights `CalcCoverage`.
 */
export function createSlugCoverage(storage: WindfoilStorage) {
  const { curves, rows } = storage

  // Keep functions that capture storage inline. Three caches native layout-function code
  // across builders, which would skip registering these buffers in later render passes.
  const gatherRay = Fn<
    [
      Node<'uint'>,
      Node<'float'>,
      Node<'float'>,
      Node<'vec2'>,
      Node<'vec2'>,
      Node<'float'>,
      Node<'float'>,
    ],
    Node<'vec2'>
  >(([rowBase, maxBand, bf, uSpan, rc, half, invDiam]) => {
    const cw = vec2(0).toVar()
    If(bf.greaterThanEqual(-1e-4).and(bf.lessThanEqual(maxBand.add(1.0001))), () => {
      const bi = uint(clamp(bf, 0, maxBand)).toConst()
      const packedRow = uint(rows.element(rowBase.add(bi))).toConst()
      If(bandActive({ packedRow, span: uSpan }), () => {
        const count = packedRow.bitAnd(uint(0x3f)).toConst()
        const start = packedRow.shiftRight(uint(12)).toConst()
        const c2Base = start.add(count.shiftLeft(uint(1))).toConst()
        const xLo = rc.x.sub(half).toConst()
        const xHi = rc.x.add(half).toConst()
        const signMask = uint(0x80000000)
        const oneBits = uint(0x3f800000)

        Loop({ start: uint(0), end: count, type: 'uint' }, ({ i }) => {
          const base = start.add(i.shiftLeft(uint(1))).toConst()
          const c1 = vec2(curves.element(base)).toConst()
          const c3 = vec2(curves.element(base.add(1))).toConst()
          If(max(c1.x, c3.x).lessThanEqual(xLo), () => {
            Break()
          })
          const dy1 = c1.y.sub(rc.y).toConst()
          const dy3 = c3.y.sub(rc.y).toConst()
          const u1 = (bitcast(dy1, 'uint') as unknown as Node<'uint'>).toConst()
          const u3 = (bitcast(dy3, 'uint') as unknown as Node<'uint'>).toConst()
          If(u1.bitXor(u3).lessThan(signMask), () => {
            Continue()
          })
          const s = (
            bitcast(u1.bitAnd(signMask).bitOr(oneBits), 'float') as unknown as Node<'float'>
          ).toConst()
          If(min(c1.x, c3.x).greaterThanEqual(xHi), () => {
            cw.x.addAssign(s)
            Continue()
          })
          const c2 = vec2(curves.element(c2Base.add(i))).toConst()
          const hit = (
            solveStraddle({
              c1,
              c2,
              c3,
              xLo,
              dy1,
              s,
              invDiam,
            }) as unknown as Node<'vec2'>
          ).toConst()
          cw.x.addAssign(hit.x)
          cw.y.assign(max(cw.y, hit.y))
        })
      })
    })
    return cw
  })

  const evaluateFace = Fn<[Node<'vec4'>, Node<'vec4'>, Node<'vec2'>, Node<'vec4'>], Node<'float'>>(
    ([band, bandOrigin, center, metrics]) => {
      const bf = vec2(
        center.y.mul(band.w).add(bandOrigin.x),
        bandOrigin.y.sub(center.x.mul(band.z)),
      ).toConst()
      const totalBands = bandOrigin.zw.add(1).toConst()
      const scale4 = float(4).div(totalBands).toConst()
      const halfBand = vec2(metrics.y.mul(band.w), metrics.x.mul(band.z)).add(1e-4).toConst()
      const spanA = bf.add(halfBand).mul(scale4).toConst()
      const spanB = totalBands.sub(bf).add(halfBand).mul(scale4).toConst()
      const xc = gatherRay(
        uint(band.x),
        bandOrigin.z,
        bf.x,
        vec2(spanB.y.mul(4), spanA.y),
        center,
        metrics.x,
        metrics.z,
      ).toConst()
      const yc = gatherRay(
        uint(band.y),
        bandOrigin.w,
        bf.y,
        vec2(spanA.x.mul(4), spanB.x),
        vec2(center.y, center.x.negate()),
        metrics.y,
        metrics.w,
      ).toConst()
      return combineRays({ xc, yc }) as unknown as Node<'float'>
    },
  )

  const evaluateShadow = Fn<[Node<'vec4'>, Node<'vec4'>, Node<'vec2'>], Node<'float'>>(
    ([band, bandOrigin, center]) => {
      const cov = float(0).toVar()
      const bf = center.y.mul(band.w).add(bandOrigin.x).toConst()
      If(bf.greaterThanEqual(-1e-4).and(bf.lessThanEqual(bandOrigin.z.add(1.0001))), () => {
        const bi = uint(clamp(bf, 0, bandOrigin.z)).toConst()
        const packedRow = uint(rows.element(uint(band.x).add(bi))).toConst()
        const vx = bandOrigin.y.sub(center.x.mul(band.z)).toConst()
        const totalV = bandOrigin.w.add(1).toConst()
        const scaleV4 = float(4).div(totalV).toConst()
        const uSpan = vec2(totalV.sub(vx).add(1e-4).mul(scaleV4).mul(4), vx.add(1e-4).mul(scaleV4))
        If(bandActive({ packedRow, span: uSpan }), () => {
          const count = packedRow.bitAnd(uint(0x3f)).toConst()
          const start = packedRow.shiftRight(uint(12)).toConst()
          const c2Base = start.add(count.shiftLeft(uint(1))).toConst()
          const signMask = uint(0x80000000)
          const oneBits = uint(0x3f800000)

          Loop({ start: uint(0), end: count, type: 'uint' }, ({ i }) => {
            const base = start.add(i.shiftLeft(uint(1))).toConst()
            const c1 = vec2(curves.element(base)).toConst()
            const c3 = vec2(curves.element(base.add(1))).toConst()
            If(max(c1.x, c3.x).lessThanEqual(center.x), () => {
              Break()
            })
            const dy1 = c1.y.sub(center.y).toConst()
            const dy3 = c3.y.sub(center.y).toConst()
            const u1 = (bitcast(dy1, 'uint') as unknown as Node<'uint'>).toConst()
            const u3 = (bitcast(dy3, 'uint') as unknown as Node<'uint'>).toConst()
            If(u1.bitXor(u3).lessThan(signMask), () => {
              Continue()
            })
            const s = (
              bitcast(u1.bitAnd(signMask).bitOr(oneBits), 'float') as unknown as Node<'float'>
            ).toConst()
            If(min(c1.x, c3.x).greaterThan(center.x), () => {
              cov.addAssign(s)
              Continue()
            })
            const c2 = vec2(curves.element(c2Base.add(i))).toConst()
            cov.addAssign(
              solveShadowStraddle({
                c1,
                c2,
                c3,
                rcX: center.x,
                dy1,
                s,
              }) as unknown as Node<'float'>,
            )
          })
        })
      })
      return clamp(cov.abs(), 0, 1)
    },
  )

  return { evaluateFace, evaluateShadow }
}
