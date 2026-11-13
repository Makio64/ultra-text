import type { GlyphRequest, GlyphShapePath } from '../types.js'
import type { MeasuredGlyph } from './rasterize.js'

/** Shapes use the same texel-plane contract as font glyphs, with their baseline at box bottom. */
export function measureShape(
  request: GlyphRequest,
  bakeSize: number,
  padding: number,
): MeasuredGlyph {
  const shape = request.shape!
  const scale = bakeSize / 1000
  const [x0, y0, x1, y1] = shape.bounds
  const planeX0 = x0 * scale - padding
  const planeX1 = x1 * scale + padding
  const planeY0 = (shape.box[1] - y1) * scale - padding
  const planeY1 = (shape.box[1] - y0) * scale + padding
  return {
    request,
    width: Math.max(2, Math.ceil(planeX1 - planeX0) + 2),
    height: Math.max(2, Math.ceil(planeY1 - planeY0) + 2),
    planeX0,
    planeX1,
    planeY0,
    planeY1,
    descent: 0,
    advance: 0,
    drawOffsetX: 0,
    x: 0,
    y: 0,
  }
}

/** Draw one retained mask; bitmap requests supply authored per-path colours. */
export function drawShapeSlot(
  context: CanvasRenderingContext2D,
  glyph: MeasuredGlyph,
  bakeSize: number,
): void {
  const shape = glyph.request.shape!
  const scale = bakeSize / 1000
  const prepare = (target: CanvasRenderingContext2D, x: number, y: number) => {
    target.setTransform(
      scale,
      0,
      0,
      scale,
      x - glyph.planeX0 + 1,
      y + glyph.planeY1 + 1 - shape.box[1] * scale,
    )
    // The ink bounds may be cropped by a viewport; never spill into adjacent atlas slots.
    target.beginPath()
    target.rect(
      shape.bounds[0],
      shape.bounds[1],
      shape.bounds[2] - shape.bounds[0],
      shape.bounds[3] - shape.bounds[1],
    )
    target.clip()
  }
  const draw = (context: CanvasRenderingContext2D, item: GlyphShapePath) => {
    context.save()
    try {
      if (item.clip) {
        context.beginPath()
        context.rect(
          item.clip[0],
          item.clip[1],
          item.clip[2] - item.clip[0],
          item.clip[3] - item.clip[1],
        )
        context.clip()
      }
      if (shape.bitmap && item.color) {
        const [r, g, b, a] = item.color
        context.fillStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`
      }
      context.strokeStyle = context.fillStyle
      let path = new Path2D(item.d)
      const stroke = item.stroke
      if (stroke?.nonScaling) {
        const transformed = new Path2D()
        const [a, b, c, d, e, f] = item.transform
        transformed.addPath(path, { a, b, c, d, e, f })
        path = transformed
      } else context.transform(...item.transform)
      if (stroke) {
        context.lineWidth = stroke.width
        context.lineCap = stroke.lineCap
        context.lineJoin = stroke.lineJoin
        context.miterLimit = stroke.miterLimit
        context.setLineDash(stroke.dash ? [...stroke.dash] : [])
        context.lineDashOffset = stroke.dashOffset ?? 0
        context.stroke(path)
      } else context.fill(path, item.fillRule ?? 'nonzero')
    } finally {
      context.restore()
    }
  }
  context.save()
  try {
    prepare(context, glyph.x, glyph.y)
    if (shape.image) context.drawImage(shape.image, 0, 0, ...shape.box)
    else if (shape.bitmap && shape.paths.some((path) => path.opacityGroups?.length)) {
      // Canvas applies opacity to each paint. Isolate SVG element/group opacity so
      // overlapping children and fill/stroke are composited before the alpha scales.
      const stack: { id: number; alpha: number; context: CanvasRenderingContext2D }[] = []
      const close = () => {
        const group = stack.pop()!
        const parent = stack.at(-1)?.context ?? context
        parent.save()
        try {
          parent.setTransform(1, 0, 0, 1, 0, 0)
          parent.globalAlpha = group.alpha
          parent.drawImage(
            group.context.canvas,
            stack.length ? 0 : glyph.x,
            stack.length ? 0 : glyph.y,
          )
        } finally {
          parent.restore()
          group.context.canvas.width = group.context.canvas.height = 0
        }
      }
      try {
        for (const item of shape.paths) {
          const groups = item.opacityGroups ?? []
          let shared = 0
          while (shared < stack.length && stack[shared]!.id === groups[shared]?.[0]) shared++
          while (stack.length > shared) close()
          for (let i = shared; i < groups.length; i++) {
            const canvas = context.canvas.ownerDocument.createElement('canvas')
            canvas.width = glyph.width
            canvas.height = glyph.height
            const target = canvas.getContext('2d')
            if (!target) throw new Error('SVG opacity compositing requires Canvas 2D')
            prepare(target, 0, 0)
            stack.push({ id: groups[i]![0], alpha: groups[i]![1], context: target })
          }
          draw(stack.at(-1)?.context ?? context, item)
        }
        while (stack.length) close()
      } finally {
        for (const group of stack) group.context.canvas.width = group.context.canvas.height = 0
      }
    } else for (const item of shape.paths) draw(context, item)
  } finally {
    context.restore()
  }
}
