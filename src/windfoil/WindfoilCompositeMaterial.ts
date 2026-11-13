import { SRGBColorSpace, type Node, type StorageBufferNode, type UniformNode } from 'three/webgpu'
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  attribute,
  bitcast,
  clamp,
  float,
  floor,
  mix,
  step,
  uint,
  uniform,
  varying,
  varyingProperty,
  vec2,
  vec4,
  wgslFn,
  workingToColorSpace,
} from 'three/tsl'
import {
  GlyphTextMaterial,
  srgbAttributeToWorking,
  type GlyphTextMaterialOptions,
} from '../text/GlyphTextMaterial.js'
import { createWindfoilCoverage, windfoilPixelBox, windfoilVertexExtension } from './coverage.js'
import type { WindfoilMaterialOptions } from './WindfoilMaterial.js'
import { WINDFOIL_SOLID, WINDFOIL_TREE_DEPTH } from './layerGrid.js'

const swapVec2 = wgslFn<{ v: Node<'vec2'>; swap: Node<'bool'> }>(`
fn windfoil_swap2(v: vec2f, swap: bool) -> vec2f {
  return select(v, v.yx, swap);
}
`)

const swapVec4 = wgslFn<{ v: Node<'vec4'>; swap: Node<'bool'> }>(`
fn windfoil_swap4(v: vec4f, swap: bool) -> vec4f {
  return select(v, v.yxwz, swap);
}
`)

const clipCoverageFn = wgslFn<{
  layerCount: Node<'float'>
  pixelLow: Node<'vec2'>
  pixelHigh: Node<'vec2'>
  clipBounds: Node<'vec4'>
  invArea: Node<'float'>
}>(`
fn windfoil_clip_coverage(layerCount: f32, pixelLow: vec2f, pixelHigh: vec2f, clipBounds: vec4f, invArea: f32) -> f32 {
  if (layerCount >= 0.0) { return 1.0; }
  let overlap = max(min(pixelHigh, clipBounds.zw) - max(pixelLow, clipBounds.xy), vec2f(0.0));
  return overlap.x * overlap.y * invArea;
}
`)

const cellFitsFn = wgslFn<{
  pixelLow: Node<'vec2'>
  pixelHigh: Node<'vec2'>
  corner: Node<'vec2'>
  extent: Node<'float'>
}>(`
fn windfoil_cell_fits(pixelLow: vec2f, pixelHigh: vec2f, corner: vec2f, extent: f32) -> bool {
  let margin = extent * 0.125;
  return all(pixelLow >= corner - margin) && all(pixelHigh <= corner + (extent + margin));
}
`)

type AssignableNode<T extends string> = Node<T> & {
  toVar(name?: string): Node<T> & { setAssignable(value: boolean): Node<T> }
}

function localVar<T extends string>(node: Node<T>, name?: string): Node<T> {
  return (node as AssignableNode<T>).toVar(name).setAssignable(true)
}

export interface WindfoilCompositeMaterialOptions
  extends WindfoilMaterialOptions, GlyphTextMaterialOptions {
  readonly layers: StorageBufferNode<'uint'>
  readonly paintFunctions: NonNullable<WindfoilMaterialOptions['paintFunctions']>
}
/** Composites in encoded sRGB before the shared DOM/motion alpha multiplier. */
export class WindfoilCompositeMaterial extends GlyphTextMaterial {
  readonly shadowCutoff: UniformNode<'float', number> = uniform(0.5)
  /** The layer table with each glyph's cell index (see `appendWindfoilLayerGrids`). */
  readonly windfoilLayers: StorageBufferNode<'uint'>
  constructor(options: WindfoilCompositeMaterialOptions) {
    const bounds = attribute<'vec4'>('windfoilBounds', 'vec4')
    const range = attribute<'vec3'>('windfoilLayers', 'vec3')
    // The fragment truncates the first layer to an index: interpolated, that constant can arrive
    // a hair under itself (Safari's relaxed math on Apple GPUs) and walk another glyph's layer
    // list. Flat keeps it exact (from `either` vertex, all equal); the vertex stage reads the motion
    // index from `range.z`.
    const layerRange = varying(range.xy, 'vUltraWindfoilLayers').setInterpolation('flat', 'either')
    const position = varyingProperty('vec2', 'vUltraWindfoilPosition')
    const foreground = varyingProperty('vec3', 'vUltraWindfoilForeground')
    const extend = windfoilVertexExtension(bounds, position)
    super(
      options,
      (quad, rect, local, depth, scale, uv) => {
        foreground.assign(attribute<'vec4'>('sdfColor', 'vec4').rgb)
        return extend(quad, rect, local, depth, scale, uv)
      },
      range.z,
    )
    this.name = 'ultra-text TSL Windfoil colour'
    this.windfoilLayers = options.layers
    this.shadowCutoff.value = Math.min(1, Math.max(0, options.shadowCutoff ?? 0.5))
    // Share the rounded-edge correction with the per-layer renderer. Most pixels
    // need only their intersecting bands, rather than two unconditional neighbours.
    const { profileFace, integrateFace } = createWindfoilCoverage(options)
    const { layers } = options
    const clipCoverage = (
      pixelLow: Node<'vec2'>,
      pixelHigh: Node<'vec2'>,
      invArea: Node<'float'>,
    ): Node<'float'> =>
      clipCoverageFn({
        layerCount: layerRange.y,
        pixelLow,
        pixelHigh,
        clipBounds: bounds,
        invArea,
      }) as Node<'float'>
    /**
     * Word range of this pixel's top-down layer list: the deepest quadtree cell whose
     * footprint allowance (an eighth of its side) holds the pixel box, or every layer.
     */
    const layerList = (
      pixelLow: Node<'vec2'>,
      pixelHigh: Node<'vec2'>,
    ): [Node<'uint'>, Node<'uint'>] => {
      const block = uint(layers.element(uint(layerRange.x).mul(uint(12)).add(uint(11)))).toConst(
        'windfoilGrid',
      )
      const cell = localVar(block.add(uint(4)), 'windfoilCell')
      If(uint(layers.element(block)).greaterThan(uint(0)), () => {
        const word = (offset: number): Node<'float'> =>
          bitcast(layers.element(block.add(uint(offset))), 'float') as unknown as Node<'float'>
        const origin = localVar(vec2(word(1), word(2))),
          side = localVar(word(3)),
          candidate = localVar(block.add(uint(8)))
        const fits = (corner: Node<'vec2'>, extent: Node<'float'>): Node<'bool'> =>
          cellFitsFn({ pixelLow, pixelHigh, corner, extent }) as Node<'bool'>
        // Start at the top grid's cell, a direct index, when the footprint fits it.
        const span = float(uint(1).shiftLeft(uint(layers.element(block.add(uint(4)))))).toConst()
        const cellStep = side.div(span).toConst()
        const index = clamp(
          floor(position.sub(origin).div(cellStep)),
          vec2(0),
          vec2(span.sub(1)),
        ).toConst()
        const corner = origin.add(index.mul(cellStep)).toConst()
        const descend = localVar(uint(1))
        If(fits(corner, cellStep), () => {
          const topCell = uint(
            layers.element(
              uint(layers.element(block.add(uint(7)))).add(uint(index.y.mul(span).add(index.x))),
            ),
          ).toConst()
          cell.assign(topCell)
          const firstChild = uint(layers.element(topCell)).toConst()
          If(firstChild.equal(uint(0)), () => {
            descend.assign(uint(0))
          }).Else(() => {
            const halfStep = cellStep.mul(0.5).toConst()
            const stepXY = step(corner.add(halfStep), position).toConst()
            origin.assign(corner.add(halfStep.mul(stepXY)))
            side.assign(halfStep)
            candidate.assign(firstChild.add(uint(stepXY.x.mul(3).add(stepXY.y.mul(6)))))
          })
        })
        If(descend.greaterThan(uint(0)), () => {
          Loop(WINDFOIL_TREE_DEPTH + 1, () => {
            If(fits(origin, side).not(), () => {
              Break()
            })
            cell.assign(candidate)
            const child = uint(layers.element(candidate)).toConst()
            If(child.equal(uint(0)), () => {
              Break()
            })
            side.mulAssign(0.5)
            const stepXY = step(origin.add(side), position).toConst()
            origin.addAssign(side.mul(stepXY))
            candidate.assign(child.add(uint(stepXY.x.mul(3).add(stepXY.y.mul(6)))))
          })
        })
      })
      const offset = cell.add(uint(1)).toConst()
      return [
        uint(layers.element(offset)).toConst(),
        uint(layers.element(offset.add(uint(1)))).toConst(),
      ]
    }
    /** Coverage of list entry `entry`: 1 for a cell-covering layer, else the pixel integral. */
    const entryCoverage = (
      entry: Node<'uint'>,
      row: Node<'uint'>,
      size: Node<'vec2'>,
      pixelLow: Node<'vec2'>,
      pixelHigh: Node<'vec2'>,
      invArea: Node<'float'>,
    ) => {
      const coverage = localVar(float(1))
      If(entry.lessThan(uint(WINDFOIL_SOLID)), () => {
        const read = (index: number): Node<'float'> =>
          bitcast(layers.element(row.add(uint(index))), 'float') as unknown as Node<'float'>
        const box = vec4(read(4), read(5), read(6), read(7)).toConst()
        const outside = pixelHigh.lessThan(box.xy).any().or(pixelLow.greaterThan(box.zw).any())
        If(outside, () => {
          Continue()
        })
        const header = vec4(
          float(layers.element(row)),
          float(layers.element(row.add(uint(1)))),
          read(2),
          read(3),
        ).toConst()
        // A transposed layer's pieces and bands run along x: integrate it in swapped axes.
        const swap = uint(layers.element(row.add(uint(9))))
          .bitAnd(uint(2))
          .notEqual(uint(0))
          .toConst()
        const center = (swapVec2({ v: position, swap }) as Node<'vec2'>).toConst(),
          extent = (swapVec2({ v: size, swap }) as Node<'vec2'>).toConst(),
          bounds = (swapVec4({ v: box, swap }) as Node<'vec4'>).toConst()
        If(size.mul(3.7).greaterThanEqual(box.zw.sub(box.xy)).all(), () => {
          coverage.assign(
            clamp(abs(profileFace(header, bounds, center, extent).mul(invArea)), 0, 1),
          )
        }).Else(() => {
          coverage.assign(
            clamp(abs(integrateFace(header, bounds.y, center, extent).mul(invArea)), 0, 1),
          )
        })
      })
      return coverage
    }
    const composite = Fn<Node<'vec4'>>(() => {
      const size = windfoilPixelBox(position).toConst()
      const halfSize = size.mul(0.5).toConst()
      const pixelLow = position.sub(halfSize).toConst(),
        pixelHigh = position.add(halfSize).toConst(),
        invArea = float(1).div(size.x.mul(size.y)).toConst()
      const acc = localVar(vec4(0), 'windfoilComposite')
      const clipped = clipCoverage(pixelLow, pixelHigh, invArea).toConst()
      If(clipped.greaterThanEqual(1 / 1024), () => {
        const [begin, finish] = layerList(pixelLow, pixelHigh)
        const fg = this.fillNode
          ? vec4(
              (workingToColorSpace(this.fillNode.rgb, SRGBColorSpace) as unknown as Node<'vec4'>)
                .rgb,
              clamp(this.fillNode.a, 0, 1),
            ).toConst()
          : vec4(foreground, 1).toConst()
        Loop({ start: begin, end: finish, type: 'uint', condition: '<' }, ({ i }) => {
          const entry = uint(layers.element(i)).toConst()
          const row = entry
            .bitAnd(uint(WINDFOIL_SOLID - 1))
            .mul(uint(12))
            .toConst()
          const coverage = entryCoverage(entry, row, size, pixelLow, pixelHigh, invArea)
          If(coverage.lessThan(1 / 1024), () => {
            Continue()
          })
          const paint = options.paintFunctions.evaluatePaint(
            uint(layers.element(row.add(uint(8)))),
            position,
            fg,
          )
          acc.addAssign(paint.mul(coverage.mul(acc.a.oneMinus())))
          If(acc.a.greaterThan(0.998), () => {
            Break()
          })
        })
        If(acc.a.greaterThan(0), () => {
          acc.assign(vec4(srgbAttributeToWorking(acc.rgb.div(acc.a)), acc.a.mul(clipped)))
        })
      })
      return acc
    })()
    const shadow = Fn<Node<'float'>>(() => {
      const size = windfoilPixelBox(position).toConst()
      const halfSize = size.mul(0.5).toConst()
      const pixelLow = position.sub(halfSize).toConst(),
        pixelHigh = position.add(halfSize).toConst(),
        invArea = float(1).div(size.x.mul(size.y)).toConst()
      const acc = localVar(float(0), 'windfoilShadowUnion')
      const clipped = clipCoverage(pixelLow, pixelHigh, invArea).toConst()
      If(clipped.greaterThan(this.shadowCutoff), () => {
        const [begin, finish] = layerList(pixelLow, pixelHigh)
        const fgAlpha = this.fillNode ? clamp(this.fillNode.a, 0, 1).toConst() : null
        const cutoff = this.shadowCutoff.div(clipped).toConst()
        Loop({ start: begin, end: finish, type: 'uint', condition: '<' }, ({ i }) => {
          const entry = uint(layers.element(i)).toConst()
          const row = entry
            .bitAnd(uint(WINDFOIL_SOLID - 1))
            .mul(uint(12))
            .toConst()
          const coverage = entryCoverage(entry, row, size, pixelLow, pixelHigh, invArea)
          If(coverage.lessThan(1 / 1024), () => {
            Continue()
          })
          const alpha = bitcast(
            layers.element(row.add(uint(10))),
            'float',
          ) as unknown as Node<'float'>
          const layerAlpha = fgAlpha
            ? alpha.mul(
                mix(
                  float(1),
                  fgAlpha,
                  float(uint(layers.element(row.add(uint(9)))).bitAnd(uint(1))),
                ),
              )
            : alpha
          acc.addAssign(coverage.mul(layerAlpha).mul(acc.oneMinus()))
          If(acc.greaterThan(cutoff), () => {
            Break()
          })
        })
      })
      return acc.mul(clipped)
    })()
    this.applyCoverage(composite.a, shadow, this.shadowCutoff, composite)
    const clip = Fn(() => {
      this.insideClip.not().discard()
    })()
    this.maskNode = this.maskNode!.bypass(clip)
    this.maskShadowNode = this.maskShadowNode!.bypass(clip)
  }
}
