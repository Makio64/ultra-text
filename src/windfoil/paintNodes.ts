import type { Node, StorageBufferNode } from 'three/webgpu'
import {
  Break,
  Fn,
  If,
  Loop,
  atan,
  bitcast,
  float,
  fract,
  uint,
  vec2,
  vec4,
  wgslFn,
} from 'three/tsl'

const solidPaint = wgslFn<{
  raw: Node<'uint'>
  kind: Node<'uint'>
  foreground: Node<'vec4'>
}>(`
fn windfoil_solid_paint(raw: u32, kind: u32, foreground: vec4f) -> vec4f {
  let color = unpack4x8unorm(raw);
  let resolved = select(color, vec4f(foreground.rgb, foreground.a * color.a), kind == 1u);
  return vec4f(resolved.rgb * resolved.a, resolved.a);
}
`)

const radialPaintT = wgslFn<{
  q: Node<'vec2'>
  delta: Node<'vec2'>
  r: Node<'float'>
  dr: Node<'float'>
}>(`
fn windfoil_radial_t(q: vec2f, delta: vec2f, r: f32, dr: f32) -> vec2f {
  let a = dot(delta, delta) - dr * dr;
  let b = dot(q, delta) + r * dr;
  let c = dot(q, q) - r * r;
  if (abs(a) < 1e-12) {
    if (abs(b) < 5e-13) { return vec2f(0.0, 0.0); }
    let t = (0.5 * c) / b;
    return vec2f(t, select(0.0, 1.0, r + dr * t >= 0.0));
  }
  let disc = b * b - a * c;
  if (disc < 0.0) { return vec2f(0.0, 0.0); }
  let root = sqrt(disc);
  let roots = (b + vec2f(-root, root)) / a;
  let hi = max(roots.x, roots.y);
  let t = select(min(roots.x, roots.y), hi, r + dr * hi >= 0.0);
  return vec2f(t, select(0.0, 1.0, r + dr * t >= 0.0));
}
`)

const extendPaintT = wgslFn<{
  t: Node<'float'>
  extend: Node<'uint'>
}>(`
fn windfoil_extend_t(t: f32, extend: u32) -> f32 {
  return select(
    select(1.0 - abs(fract(t * 0.5) * 2.0 - 1.0), fract(t), extend == 1u),
    clamp(t, 0.0, 1.0),
    extend == 0u
  );
}
`)

const mixTwoStops = wgslFn<{
  prevRaw: Node<'uint'>
  nextRaw: Node<'uint'>
  t: Node<'float'>
}>(`
fn windfoil_mix_two_stops(prevRaw: u32, nextRaw: u32, t: f32) -> vec4f {
  let prev = unpack4x8unorm(prevRaw);
  let next = unpack4x8unorm(nextRaw);
  return mix(vec4f(prev.rgb * prev.a, prev.a), vec4f(next.rgb * next.a, next.a), t);
}
`)

const mixPaintStops = wgslFn<{
  prevRaw: Node<'uint'>
  nextRaw: Node<'uint'>
  offset: Node<'float'>
  nextOffset: Node<'float'>
  t: Node<'float'>
}>(`
fn windfoil_mix_stops(prevRaw: u32, nextRaw: u32, offset: f32, nextOffset: f32, t: f32) -> vec4f {
  let prev = unpack4x8unorm(prevRaw);
  let next = unpack4x8unorm(nextRaw);
  let frac = select(clamp((t - offset) / max(nextOffset - offset, 1e-9), 0.0, 1.0), 1.0, nextOffset == offset);
  return mix(vec4f(prev.rgb * prev.a, prev.a), vec4f(next.rgb * next.a, next.a), frac);
}
`)

type AssignableNode<T extends string> = Node<T> & {
  toVar(name?: string): Node<T> & { setAssignable(value: boolean): Node<T> }
}

function localVar<T extends string>(node: Node<T>, name?: string): Node<T> {
  return (node as AssignableNode<T>).toVar(name).setAssignable(true)
}

/** Evaluate premultiplied encoded-sRGB paint without derivatives. */
export function createWindfoilPaintFunctions({
  paints,
  stops,
  solidOnly = false,
}: {
  readonly paints: StorageBufferNode<'uint'>
  readonly stops: StorageBufferNode<'uint'>
  readonly solidOnly?: boolean
}) {
  const evaluatePaint = Fn<[Node<'uint'>, Node<'vec2'>, Node<'vec4'>], Node<'vec4'>>(
    ([paintIndex, point, foreground]) => {
      const base = paintIndex.mul(16).toConst()
      const flags = uint(paints.element(base)).toConst()
      const kind = flags.bitAnd(uint(15)).toConst()
      if (solidOnly) {
        return solidPaint({
          raw: uint(paints.element(base.add(uint(3)))),
          kind,
          foreground,
        }) as unknown as Node<'vec4'>
      }
      const read = (offset: number): Node<'float'> =>
        bitcast(paints.element(base.add(uint(offset))), 'float') as unknown as Node<'float'>
      const result = localVar(vec4(0), 'windfoilPaint')
      If(kind.lessThan(2), () => {
        result.assign(
          solidPaint({
            raw: uint(paints.element(base.add(uint(3)))),
            kind,
            foreground,
          }),
        )
      }).Else(() => {
        const t = localVar(float(0))
        const valid = localVar(float(1))
        If(kind.equal(2), () => {
          t.assign(
            point.x
              .mul(read(10))
              .add(point.y.mul(read(11)))
              .add(read(12)),
          )
        }).Else(() => {
          const q = vec2(
            point.x
              .mul(read(4))
              .add(point.y.mul(read(6)))
              .add(read(8)),
            point.x
              .mul(read(5))
              .add(point.y.mul(read(7)))
              .add(read(9)),
          ).toConst()
          If(kind.equal(3), () => {
            const rad = (
              radialPaintT({
                q,
                delta: vec2(read(12), read(13)),
                r: read(14),
                dr: read(15),
              }) as unknown as Node<'vec2'>
            ).toConst()
            t.assign(rad.x)
            valid.assign(rad.y)
          }).Else(() => {
            const angle = atan(q.y, q.x)
            t.assign(
              fract(angle.mul(1 / (Math.PI * 2)).add(1))
                .mul(read(13))
                .sub(read(12)),
            )
          })
        })
        If(valid.greaterThan(0), () => {
          const extend = flags.shiftRight(uint(4))
          const tExt = (extendPaintT({ t, extend }) as Node<'float'>).toConst()
          const first = uint(paints.element(base.add(uint(1)))).toConst()
          const count = uint(paints.element(base.add(uint(2)))).toConst()
          const firstRow = first.mul(2).toConst()
          If(count.equal(uint(2)), () => {
            result.assign(
              mixTwoStops({
                prevRaw: uint(stops.element(firstRow.add(uint(1)))),
                nextRaw: uint(stops.element(firstRow.add(uint(3)))),
                t: tExt,
              }),
            )
          }).Else(() => {
            const offset = localVar(float(0))
            Loop({ start: uint(1), end: count, type: 'uint' }, ({ i }) => {
              const row = firstRow.add(i.mul(2)).toConst()
              const nextOffset = (
                bitcast(stops.element(row), 'float') as unknown as Node<'float'>
              ).toConst()
              const isLast = i.add(uint(1)).greaterThanEqual(count)
              If(tExt.lessThan(nextOffset).or(isLast), () => {
                result.assign(
                  mixPaintStops({
                    prevRaw: uint(stops.element(row.sub(uint(1)))),
                    nextRaw: uint(stops.element(row.add(uint(1)))),
                    offset,
                    nextOffset,
                    t: tExt,
                  }),
                )
                Break()
              })
              offset.assign(nextOffset)
            })
          })
        })
      })
      return result
    },
  )
  return { evaluatePaint }
}
