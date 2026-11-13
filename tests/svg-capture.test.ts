import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendSvg,
  captureSvg,
  resolveSvgOptions,
  shapePathData,
  type SvgCaptureContext,
} from '../src/dom/svgCapture.js'
import { collectDomSnapshot } from '../src/dom/snapshot.js'
import { drawShapeSlot, measureShape } from '../src/atlas/shapeRaster.js'
import type { GlyphLayout, GlyphRequest } from '../src/types.js'

const rect = (x = 0, y = 0, width = 100, height = 100) => ({
  x,
  y,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
  width,
  height,
  toJSON: () => ({}),
})
function setup(markup: string, options: SvgCaptureContext['options'] = {}) {
  document.body.innerHTML = `<div id="root"><svg width="100" height="100">${markup}</svg></div>`
  const svg = document.querySelector('svg')!
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect())
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    Object.defineProperty(el, 'getScreenCTM', {
      configurable: true,
      value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    })
    Object.defineProperty(el, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    })
  }
  const nativeStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    if (el.namespaceURI !== 'http://www.w3.org/2000/svg') return nativeStyle(el)
    const style = document.createElement('span').style
    style.cssText =
      'display:inline;visibility:visible;overflow:hidden;fill:rgb(0,0,0);stroke:none;fill-opacity:1;stroke-opacity:1;stroke-width:1;stroke-miterlimit:4;opacity:1'
    for (const name of [
      'fill',
      'color',
      'visibility',
      'overflow',
      'filter',
      'mask',
      'mix-blend-mode',
      'vector-effect',
      'paint-order',
      'stroke-dasharray',
      'stroke-dashoffset',
      'fill-rule',
      'opacity',
      'clip-path',
      'stroke',
      'fill-opacity',
      'stroke-opacity',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'stroke-miterlimit',
    ]) {
      const value = el.getAttribute(name)
      if (value) style.setProperty(name, value)
    }
    style.cssText += ';' + (el.getAttribute('style') ?? '')
    return style
  })
  const requests = new Map<string, GlyphRequest>()
  const context: SvgCaptureContext = {
    style: (el) => getComputedStyle(el),
    opacity: () => 1,
    displayNone: () => false,
    ignored: () => false,
    color: (v, a) =>
      ['red', 'rgb(255, 0, 0)'].includes(v)
        ? [1, 0, 0, a]
        : v === 'blue'
          ? [0, 0, 1, a]
          : [0, 0, 0, a],
    requests,
    rootLeft: 0,
    rootBottom: 100,
    invScale: 1,
    options,
    budget: { pathData: 10000 },
  }
  return { svg, context, requests }
}
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
describe('SVG capture', () => {
  it('merges adjacent opaque paints but preserves painter order', () => {
    const { svg, context, requests } = setup(
      '<path fill="red" d="M0 0H10V10Z"/><rect fill="red" width="10" height="10"/><circle fill="blue" r="5"/>',
    )
    const capture = captureSvg(svg, context)!
    expect(capture.layers).toHaveLength(2)
    expect([...requests.values()][0]!.shape!.paths).toHaveLength(2)
    expect(capture.layers.map((l) => l.color)).toEqual([
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ])
  })
  it('retains paint alpha and never merges translucent neighbours', () => {
    const { svg, context } = setup(
      '<path fill="red" fill-opacity=".5" d="M0 0H10V10Z"/><path fill="red" fill-opacity=".5" d="M0 0H10V10Z"/>',
    )
    expect(captureSvg(svg, context)!.layers.map((l) => l.color[3])).toEqual([0.5, 0.5])
  })
  it('ignores colour in mask keys and rejects path expansion over budget', () => {
    const { svg, context } = setup('<path fill="red" d="M0 0H10V10Z"/>')
    const first = captureSvg(svg, context)!.layers[0]!.key
    svg.firstElementChild!.setAttribute('fill', 'blue')
    expect(captureSvg(svg, context)!.layers[0]!.key).toBe(first)
    context.budget.pathData = 1
    expect(() => captureSvg(svg, context)).toThrow('maxPathData')
  })
  it('captures bitmap SVG colours in one request', () => {
    const { svg, context, requests } = setup(
      '<path fill="red" d="M0 0H10V10Z"/><path fill="blue" d="M10 0H20V10Z"/>',
      { render: 'bitmap' },
    )
    expect(captureSvg(svg, context)!.layers).toHaveLength(1)
    const shape = [...requests.values()][0]!.shape!
    expect(shape.bitmap).toBe(true)
    expect(shape.paths.map((p) => p.color)).toEqual([
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ])
  })
  it('reports unsupported content and cyclic use references', () => {
    const { svg, context } = setup('<use id="a" href="#a"/>', { unsupported: 'error' })
    expect(() => captureSvg(svg, context)).toThrow('cyclic')
    svg.innerHTML = '<text>hello</text>'
    expect(() => captureSvg(svg, context)).toThrow('unsupported content')
  })
  it('inherits use paints and composes referenced group opacity without source ancestry', () => {
    const { svg, context } = setup(
      '<defs><g id="mark" opacity=".5"><rect width="20" height="20"/></g></defs><use href="#mark" fill="red" opacity=".5"/>',
    )
    const capture = captureSvg(svg, {
      ...context,
      opacity: (element) => Number(element.getAttribute('opacity') ?? 1),
    })!
    expect(capture.layers).toHaveLength(1)
    expect(capture.layers[0]!.color).toEqual([1, 0, 0, 0.25])
  })

  it('ignores source-only hidden ancestry when expanding a use instance', () => {
    const { svg, context } = setup(
      '<defs><g id="mark"><rect width="20" height="20"/></g></defs><use href="#mark" fill="red"/>',
    )
    const capture = captureSvg(svg, {
      ...context,
      displayNone: (element) => !!element.closest('defs'),
    })!
    expect(capture.layers[0]!.color).toEqual([1, 0, 0, 1])
  })

  it('preserves rectangular clip paths and prevents merging across viewports', () => {
    const { svg, context, requests } = setup(
      '<defs><clipPath id="cut"><rect x="20" y="20" width="30" height="30"/></clipPath></defs><g clip-path="url(#cut)"><rect fill="red" width="100" height="100"/></g><rect fill="red" width="10" height="10"/>',
    )
    const capture = captureSvg(svg, context)!
    expect(capture.layers).toHaveLength(2)
    expect(capture.layers[0]!.clip).toEqual([20, 50, 50, 80])
    expect([...requests.values()][0]!.shape!.bounds).toEqual([200, 200, 500, 500])
  })

  it('rejects use recursion beyond eight references without limiting ordinary group nesting', () => {
    const groups = Array.from(
      { length: 10 },
      (_, i) => `<g id="g${i}"><use href="#g${i + 1}"/></g>`,
    ).join('')
    const { svg, context } = setup(
      `<defs>${groups}<g id="g10"><rect width="10" height="10"/></g></defs><use href="#g0"/>`,
      { unsupported: 'error' },
    )
    expect(() => captureSvg(svg, context)).toThrow('deeply nested')
  })

  it('groups motion, advance and baseline of all layers', () => {
    const { svg, context } = setup(
      '<path fill="red" d="M0 0H10V10Z"/><path fill="blue" d="M0 0H20V20Z"/>',
    )
    const glyphs: GlyphLayout[] = []
    appendSvg(captureSvg(svg, context)!, glyphs, 0, 0, [0, 0, 100, 100], 1, 0)
    expect(glyphs.map((g) => g.advance)).toEqual([0, 100])
    expect(glyphs[0]!.motionOrigin).toEqual([50, 50, 0])
    expect(glyphs[1]!.motionOrigin).toBe(glyphs[0]!.motionOrigin)
  })
  it('validates opt-in options and preserves synchronous default capture', async () => {
    expect(() => resolveSvgOptions({ maxPathData: 0 })).toThrow(RangeError)
    expect(() => resolveSvgOptions({ selector: ' ' })).toThrow(RangeError)
    const { svg } = setup('<rect width="20" height="10"/>')
    const root = svg.parentElement!
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect())
    expect(collectDomSnapshot(root)).not.toBeInstanceOf(Promise)
    const pending = collectDomSnapshot(root, { svg: true })
    expect(pending).toBeInstanceOf(Promise)
    await pending
  })
  it('captures standalone SVG into synthetic blocks and excludes SVG text', async () => {
    const { svg } = setup('<rect width="20" height="10"/><text>ignored</text>')
    const root = svg.parentElement!
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect())
    const snapshot = await collectDomSnapshot(root, { svg: true })
    expect(snapshot.glyphs).toHaveLength(1)
    expect(snapshot.requests[0]!.shape).toBeDefined()
    expect(snapshot.blocks[0]!.linePitch).toBe(0)
  })
  it('synthesizes round rects, ellipses, lines and polygons', () => {
    const { svg } = setup(
      '<rect width="20" height="10" rx="2"/><ellipse rx="2" ry="3"/><line x2="4"/><polygon points="0,0 2,0 2,2"/>',
    )
    const paths = [...svg.children].map((el) => shapePathData(el, getComputedStyle(el)))
    expect(paths[0]).toContain('A2 2')
    expect(paths[1]).toContain('a2 3')
    expect(paths[2]).toBe('M0 0L4 0')
    expect(paths[3]).toBe('M0,0 2,0 2,2Z')
  })
})
describe('SVG raster slots', () => {
  it('uses texel planes and inherited black/white drawing state', () => {
    const { svg, context, requests } = setup('<path fill="red" stroke="blue" d="M0 0H10V10Z"/>')
    captureSvg(svg, context)
    const request = [...requests.values()][0]!
    const measured = measureShape(request, 100, 4)
    expect(measured.advance).toBe(0)
    expect(measured.descent).toBe(0)
    const fill = vi.fn(),
      setTransform = vi.fn()
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly d: string) {}
      },
    )
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform,
      transform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill,
      fillStyle: '#000',
    } as unknown as CanvasRenderingContext2D
    drawShapeSlot(ctx, measured, 100)
    expect(setTransform).toHaveBeenCalledWith(0.1, 0, 0, 0.1, 5, 5)
    expect(fill).toHaveBeenCalledWith(expect.objectContaining({ d: 'M0 0H10V10Z' }), 'nonzero')
    expect(ctx.fillStyle).toBe('#000')
  })
})

describe('SVG capture boundaries', () => {
  it.each([
    ['<use href="other.svg#mark"/>', 'use target'],
    ['<path d="M0 0L1 1" filter="url(#blur)"/>', 'filter'],
    ['<path d="M0 0L1 1" mask="url(#mask)"/>', 'mask'],
    ['<path d="M0 0L1 1" style="mix-blend-mode:multiply"/>', 'mix-blend-mode'],
    ['<path d="M0 0L1 1" clip-path="url(#missing)"/>', 'clip-path'],
    ['<path d="M0 0L1 1" fill="url(#gradient)"/>', 'paint server'],
    ['<unknown/>', 'unsupported element'],
    ['<image/>', 'unsupported content'],
  ])('applies skip/error policy to %s', (markup, reason) => {
    const { svg, context } = setup(markup)
    expect(captureSvg(svg, context)).toBeNull()
    expect(() => captureSvg(svg, { ...context, options: { unsupported: 'error' } })).toThrow(reason)
  })

  it('skips ignored, hidden, collapsed and zero-area roots before creating requests', () => {
    const { svg, context, requests } = setup('<rect width="10" height="10"/>')
    expect(captureSvg(svg, { ...context, ignored: () => true })).toBeNull()
    expect(captureSvg(svg, { ...context, displayNone: () => true })).toBeNull()
    for (const visibility of ['hidden', 'collapse']) {
      svg.setAttribute('visibility', visibility)
      expect(captureSvg(svg, context)).toBeNull()
    }
    svg.removeAttribute('visibility')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 100))
    expect(captureSvg(svg, context)).toBeNull()
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect())
    svg.setAttribute('style', 'padding:60px')
    expect(captureSvg(svg, context)).toBeNull()
    expect(requests.size).toBe(0)
  })

  it('rejects root rotation and nonfinite descendant transforms', () => {
    const { svg, context } = setup('<rect width="10" height="10"/>', { unsupported: 'error' })
    Object.defineProperty(svg, 'getScreenCTM', {
      value: () => ({ a: 1, b: 0.2, c: 0, d: 1, e: 0, f: 0 }),
    })
    expect(() => captureSvg(svg, context)).toThrow('capture root')
    Object.defineProperty(svg, 'getScreenCTM', {
      value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    })
    Object.defineProperty(svg.firstElementChild!, 'getScreenCTM', {
      value: () => ({ a: NaN, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    })
    expect(() => captureSvg(svg, context)).toThrow('invalid transform')
  })

  it('supports currentColor and URL fallback paints in explicit paint order', () => {
    const { svg, context } = setup(
      '<rect width="20" height="20" color="red" fill="currentColor" stroke="url(#missing) blue" paint-order="stroke fill"/>',
    )
    expect(captureSvg(svg, context)!.layers.map((l) => l.color)).toEqual([
      [0, 0, 1, 1],
      [1, 0, 0, 1],
    ])
  })

  it('handles empty geometry, hidden leaves, transparent paint and conditional switch', () => {
    const { svg, context } = setup(
      '<rect width="0" height="10"/><circle r="0"/><polygon/><rect width="10" height="10" visibility="hidden"/><path d="M0 0L2 2" fill-opacity="0"/><switch><rect requiredFeatures="unsupported" width="20" height="20"/><rect fill="red" width="10" height="10"/><rect fill="blue" width="10" height="10"/></switch>',
    )
    expect(captureSvg(svg, context)!.layers.map((l) => l.color)).toEqual([[1, 0, 0, 1]])
  })

  it('retains a conservative viewport when getBBox fails', () => {
    const { svg, context, requests } = setup('<path d="M0 0L20 20"/>')
    Object.defineProperty(svg.firstElementChild!, 'getBBox', {
      value: () => {
        throw new Error('not rendered')
      },
    })
    captureSvg(svg, context)
    expect([...requests.values()][0]!.shape!.bounds).toEqual([0, 0, 1000, 1000])
  })

  it('normalizes percentage strokes, dash metrics and non-scaling width', () => {
    const { svg, context, requests } = setup(
      '<path d="M0 0L20 20" fill="none" stroke="red" stroke-width="2%" stroke-dasharray="1px 2px" stroke-dashoffset="3px" pathLength="10" vector-effect="non-scaling-stroke"/>',
    )
    Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 100, height: 100 } } })
    Object.defineProperty(svg.firstElementChild!, 'getTotalLength', { value: () => 20 })
    captureSvg(svg, context)
    expect([...requests.values()][0]!.shape!.paths[0]!.stroke).toEqual({
      width: 20,
      lineCap: 'butt',
      lineJoin: 'miter',
      miterLimit: 4,
      dash: [2, 4],
      dashOffset: 6,
      nonScaling: true,
    })
  })

  it('applies objectBoundingBox clips and skips empty or rounded clips', () => {
    const { svg, context } = setup(
      '<defs><clipPath id="cut" clipPathUnits="objectBoundingBox"><rect x=".25" y=".25" width=".5" height=".5"/></clipPath></defs><rect width="100" height="100" clip-path="url(#cut)"/>',
    )
    expect(captureSvg(svg, context)!.layers[0]!.clip).toEqual([25, 25, 75, 75])
    svg.querySelector('clipPath rect')!.setAttribute('rx', '.1')
    expect(captureSvg(svg, context)).toBeNull()
    svg.querySelector('clipPath rect')!.removeAttribute('rx')
    svg.querySelector('clipPath rect')!.setAttribute('width', '0')
    expect(captureSvg(svg, context)).toBeNull()
  })

  it.each(['none', 'xMinYMin meet', 'xMaxYMax slice'])(
    'expands symbol viewBox with %s',
    (preserve) => {
      const { svg, context, requests } = setup(
        `<defs><symbol id="mark" viewBox="0 0 20 10" preserveAspectRatio="${preserve}"><rect width="20" height="10"/></symbol></defs><use href="#mark" x="2" y="3" width="40" height="40" fill="red"/>`,
      )
      const capture = captureSvg(svg, context)!
      expect(capture.layers[0]!.color).toEqual([1, 0, 0, 1])
      const transform = [...requests.values()][0]!.shape!.paths[0]!.transform
      expect(transform.slice(0, 4)).toEqual(
        preserve === 'none'
          ? [20, 0, 0, 40]
          : preserve.includes('slice')
            ? [40, 0, 0, 40]
            : [20, 0, 0, 20],
      )
    },
  )

  it('captures nested opacity groups once and leaves root opacity on the glyph', () => {
    const { svg, context, requests } = setup(
      '<g opacity=".8"><rect fill="red" width="20" height="20"/><g opacity=".6"><rect fill="blue" width="20" height="20"/></g></g>',
      { render: 'bitmap' },
    )
    const capture = captureSvg(svg, { ...context, opacity: () => 0.5 })!
    const paths = [...requests.values()][0]!.shape!.paths
    expect(capture.layers[0]!.color).toEqual([1, 1, 1, 0.5])
    expect(paths[0]!.color).toEqual([1, 0, 0, 1])
    expect(paths[0]!.opacityGroups).toEqual([[0, 0.8]])
    expect(paths[1]!.opacityGroups).toEqual([
      [0, 0.8],
      [1, 0.6],
    ])
  })

  it('probes decoded images for taint and preserves CSS opacity', () => {
    const { context } = setup('')
    const image = document.createElement('img')
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(rect())
    Object.defineProperty(image, 'naturalWidth', { value: 100 })
    const drawImage = vi.fn(),
      getImageData = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      getImageData,
    } as unknown as CanvasRenderingContext2D)
    const capture = captureSvg(image, { ...context, opacity: () => 0.4 })!
    expect(capture.layers[0]!.color).toEqual([1, 1, 1, 0.4])
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 1, 1)
    getImageData.mockImplementation(() => {
      throw new Error('tainted')
    })
    expect(captureSvg(image, context)).toBeNull()
    expect(() => captureSvg(image, { ...context, options: { unsupported: 'error' } })).toThrow(
      'CORS-clean',
    )
    Object.defineProperty(image, 'complete', { value: false })
    expect(captureSvg(image, context)).toBeNull()
  })
})

describe('shape slot drawing variants', () => {
  type MockMethods = 'fill' | 'stroke' | 'setLineDash' | 'rect' | 'transform' | 'drawImage'
  type MockContext = Omit<CanvasRenderingContext2D, MockMethods> &
    Record<MockMethods, ReturnType<typeof vi.fn<(...args: unknown[]) => void>>>
  const path = { d: 'M0 0H10V10Z', transform: [2, 0, 0, 2, 1, 1] as const }
  function canvasContext(canvas = document.createElement('canvas')) {
    return {
      canvas,
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
      fillStyle: '#fff',
      globalAlpha: 1,
    } as unknown as MockContext
  }
  function request(
    paths: NonNullable<GlyphRequest['shape']>['paths'],
    bitmap = false,
  ): GlyphRequest {
    const { svg, context, requests } = setup('<rect width="10" height="10"/>')
    captureSvg(svg, context)
    const source = [...requests.values()][0]!
    return {
      ...source,
      shape: {
        paths,
        box: [1000, 500],
        bounds: [100, 50, 600, 400],
        ...(bitmap ? { bitmap: true } : {}),
      },
    }
  }
  function mockPath() {
    const addPath = vi.fn()
    vi.stubGlobal(
      'Path2D',
      class {
        addPath = addPath
        constructor(readonly d?: string) {}
      },
    )
    return addPath
  }
  it.each([false, true])('draws dashed strokes with nonScaling=%s', (nonScaling) => {
    const addPath = mockPath(),
      ctx = canvasContext()
    const stroke = {
      width: 4,
      lineCap: 'round' as const,
      lineJoin: 'bevel' as const,
      miterLimit: 5,
      dash: [2, 3],
      dashOffset: 1,
      ...(nonScaling ? { nonScaling: true } : {}),
    }
    const measured = measureShape(request([{ ...path, stroke }]), 100, 4)
    drawShapeSlot(ctx, measured, 100)
    expect(ctx.lineWidth).toBe(4)
    expect(ctx.lineCap).toBe('round')
    expect(ctx.lineJoin).toBe('bevel')
    expect(ctx.lineDashOffset).toBe(1)
    expect(ctx.setLineDash).toHaveBeenCalledWith([2, 3])
    expect(ctx.stroke).toHaveBeenCalledOnce()
    if (nonScaling)
      expect(addPath).toHaveBeenCalledWith(expect.anything(), {
        a: 2,
        b: 0,
        c: 0,
        d: 2,
        e: 1,
        f: 1,
      })
    else expect(ctx.transform).toHaveBeenCalledWith(...path.transform)
  })
  it('draws authored evenodd bitmap paint under its own viewport clip', () => {
    mockPath()
    const ctx = canvasContext(),
      measured = measureShape(
        request(
          [{ ...path, fillRule: 'evenodd', clip: [100, 100, 200, 200], color: [1, 0, 0, 0.6] }],
          true,
        ),
        100,
        4,
      )
    drawShapeSlot(ctx, measured, 100)
    expect(ctx.rect).toHaveBeenCalledWith(100, 100, 100, 100)
    expect(ctx.fill).toHaveBeenCalledWith(expect.anything(), 'evenodd')
    expect(ctx.fillStyle).toBe('rgba(255,0,0,0.6)')
  })
  it('draws retained decoded images once', () => {
    const image = document.createElement('img'),
      source = request([])
    const ctx = canvasContext()
    drawShapeSlot(ctx, measureShape({ ...source, shape: { ...source.shape!, image } }, 100, 4), 100)
    expect(ctx.drawImage).toHaveBeenCalledWith(image, 0, 0, 1000, 500)
  })
  it('composites each nested opacity group once and releases temporary canvases', () => {
    mockPath()
    const ctx = canvasContext(),
      targets: MockContext[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const target = canvasContext(this)
      targets.push(target)
      return target
    })
    const a = { ...path, color: [1, 0, 0, 1] as const, opacityGroups: [[0, 0.8]] as const }
    const b = {
      ...a,
      opacityGroups: [
        [0, 0.8],
        [1, 0.6],
      ] as const,
    }
    drawShapeSlot(ctx, measureShape(request([a, b, a, path], true), 100, 4), 100)
    expect(targets).toHaveLength(2)
    expect(targets[0]!.fill).toHaveBeenCalledTimes(2)
    expect(targets[1]!.fill).toHaveBeenCalledOnce()
    expect(targets[0]!.drawImage).toHaveBeenCalledOnce()
    expect(ctx.drawImage).toHaveBeenCalledOnce()
    expect(ctx.fill).toHaveBeenCalledOnce()
    expect(targets.every((target) => target.canvas.width === 0 && target.canvas.height === 0)).toBe(
      true,
    )
  })
})
