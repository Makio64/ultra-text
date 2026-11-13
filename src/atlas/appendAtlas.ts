import {
  Box2,
  DataTexture,
  RedFormat,
  UnsignedByteType,
  Vector2,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'

import type { DomSdfOptions, GlyphRequest, SdfAtlas } from '../types.js'
import { alphaOfRgba, encodeSdfFromAlpha } from './cpuSdf.js'
import { atlasDevice, encodeGpuSdf, generateAtlasMips, type AtlasGpuTexture } from './gpuAtlas.js'
import {
  appendCursors,
  createCanvas,
  glyphPainter,
  isColorCandidate,
  measureGlyph,
  packShelves,
  slotOf,
  waitForFonts,
  type MeasuredGlyph,
} from './rasterize.js'

/**
 * A larger patch is left to a full rebuild, which spreads its work better: the patch's exact
 * transform runs on the page's thread, where 2^18 texels (about twenty 96 px glyphs) take a
 * few milliseconds.
 */
const PATCH_TEXELS = 1 << 18

/** The new glyphs of one atlas row and where they go: never a box that spans two rows. */
interface Run {
  readonly x: number
  readonly y: number
  /** First row of the run on the patch canvas, where the runs are stacked. */
  readonly top: number
  width: number
  height: number
  readonly glyphs: MeasuredGlyph[]
}

/**
 * @internal Draws the text glyphs of a `capture` that `atlas` lacks into the free text rows of
 * its live texture, so a rebuild keeps the texture and every material that samples it. Only
 * the new glyphs are measured and drawn, row by row of the atlas, on one small canvas, by the
 * full build's rules and slot formulas (`glyphPainter`, `slotOf`). Their distance field comes
 * from the atlas's own encoder, a jump flood of the patch alone for a GPU atlas and the exact
 * transform for a CPU one, so the new slots hold the bytes a full build would give them; each
 * row's box is then copied into the texture, whose mipmaps three regenerates, and a CPU
 * atlas's bytes follow.
 *
 * Resolves with the next wrapper: the same texture, colour layer, shape rows and `dispose`,
 * with the old slots and the new ones; its own cursor is recorded under its glyph map, so it
 * becomes the live one only when the caller commits that wrapper. Slots the capture no longer
 * uses stay in the texture until the next full build compacts it. Resolves `null`, having
 * written nothing the caller must undo, when the caller must rebuild in full instead: a shape,
 * a glyph that classifies as colour, an atlas without a cursor or with a lowered adaptive bake
 * size, a patch past its texel budget, or glyphs that do not fit. What an aborted patch already
 * copied lies in rows no slot samples, and the next patch overwrites it.
 */
export async function appendGlyphs(
  renderer: WebGPURenderer,
  document: Document,
  atlas: SdfAtlas,
  capture: readonly GlyphRequest[],
  options: Pick<DomSdfOptions, 'colorGlyphs' | 'bakeSize'>,
  signal: AbortSignal,
): Promise<SdfAtlas | null> {
  const cursor = appendCursors.get(atlas.glyphs)
  const colorGlyphs = options.colorGlyphs ?? 'emoji'
  const requests = capture.filter((request) => !atlas.glyphs.has(request.key))
  if (
    cursor?.bakeSize !== (options.bakeSize ?? 96) ||
    cursor.colorGlyphs !== colorGlyphs ||
    cursor.width !== atlas.width ||
    cursor.height !== atlas.height ||
    !requests.length ||
    requests.some((request) => request.shape !== undefined)
  )
    return null
  const [, shapingModule] = await Promise.all([
    waitForFonts(document, requests, signal),
    requests.some((request) => request.shaping) ? import('../dom/browserShaping.js') : undefined,
  ])
  signal.throwIfAborted()
  const shaping = shapingModule?.setShapingContext
  const { width, height, bakeSize, pxRange: padding } = cursor
  const canvas = createCanvas(document)
  try {
    // A GPU patch reads at most a tiny candidate scratch pack and uploads the patch texture.
    const context = canvas.getContext('2d', {
      willReadFrequently: atlas.mode !== 'gpu',
    })
    if (!context) return null
    let lastFont: GlyphRequest['font'] | null = null
    const fresh = requests.map((request) => {
      const [glyph, font] = measureGlyph(
        context,
        request,
        padding,
        shaping,
        isColorCandidate(request, colorGlyphs),
        lastFont,
      )
      lastFont = font
      return glyph
    })
    fresh.sort(
      (a, b) =>
        b.height - a.height ||
        b.width - a.width ||
        (a.request.key < b.request.key ? -1 : a.request.key > b.request.key ? 1 : 0),
    )
    // The patch stacks its glyphs' rows, so it is never smaller than their summed area: a batch
    // past the budget is refused before its colour candidates are drawn and read back.
    let area = 0
    for (const glyph of fresh) area += glyph.width * glyph.height
    if (area > PATCH_TEXELS) return null
    const painter = glyphPainter(context, shaping, signal)

    // Colour candidates are classified as in a full build, on a pack of their own: one that
    // keeps its colour needs the colour band, which only a full build can grow.
    const candidates = fresh.filter((glyph) => isColorCandidate(glyph.request, colorGlyphs))
    if (candidates.length) {
      const scratch = packShelves(candidates, width, 1 << 14)
      if (!scratch) return null
      const { encodeColorBand } = await import('./colorGlyphs.js')
      signal.throwIfAborted()
      canvas.width = scratch.width
      canvas.height = scratch.height
      painter.reset()
      const paint = (fill: string): Uint8ClampedArray => {
        context.clearRect(0, 0, scratch.width, scratch.height)
        for (const glyph of candidates) painter.draw(glyph, false, fill)
        return context.getImageData(0, 0, scratch.width, scratch.height).data
      }
      const dark = paint('#000')
      const { colored } = encodeColorBand(
        paint('#fff'),
        dark,
        scratch.width,
        scratch.height,
        0,
        candidates,
      )
      if (colored.some(Boolean)) return null
    }

    // The full build's shelf, continued from its last text row.
    let { x, y, rowHeight } = cursor
    const runs: Run[] = []
    let patchWidth = 0
    let patchHeight = 0
    for (const glyph of fresh) {
      if (x + glyph.width > width) {
        x = 0
        y += rowHeight
        rowHeight = 0
      }
      if (glyph.width > width || y + glyph.height > cursor.bottom) return null
      let run = runs.at(-1)
      if (run?.y !== y) {
        if (run) patchHeight += run.height
        runs.push((run = { x, y, top: patchHeight, width: 0, height: 0, glyphs: [] }))
      }
      glyph.x = x
      glyph.y = y
      run.glyphs.push(glyph)
      x += glyph.width
      run.width = x - run.x
      if (glyph.height > run.height) run.height = glyph.height
      if (glyph.height > rowHeight) rowHeight = glyph.height
      if (run.width > patchWidth) patchWidth = run.width
    }
    patchHeight += runs.at(-1)!.height
    if (patchWidth * patchHeight > PATCH_TEXELS) return null

    canvas.width = patchWidth
    canvas.height = patchHeight
    painter.reset()
    context.clearRect(0, 0, patchWidth, patchHeight)
    for (const run of runs) {
      for (const glyph of run.glyphs) {
        painter.draw({ ...glyph, x: glyph.x - run.x, y: glyph.y - run.y + run.top }, true)
      }
    }

    const target: Texture & { mipmapsAutoUpdate?: boolean; sourceTexture?: unknown } = atlas.texture
    if (atlas.mode === 'gpu') {
      // A patch takes the encoder its atlas was baked with. The jump flood and the exact
      // transform disagree by up to 25/255 of the range even at the edge, so a CPU patch
      // in a GPU atlas would draw its glyphs a shade off a full build's. The patch's field
      // and its copies into the live texture go out in one submission on the device's cached
      // passes, then three regenerates the texture's mips. A device that fails here leaves
      // the full build to fall back, as `auto` does, or to throw.
      const live = target.sourceTexture as AtlasGpuTexture | null | undefined
      if (!live) return null
      const field = await encodeGpuSdf(
        atlasDevice(renderer),
        { canvas, width: patchWidth, height: patchHeight, pxRange: padding },
        1,
        (encoder, patch) => {
          for (const run of runs) {
            encoder.copyTextureToTexture(
              { texture: patch, origin: [0, run.top] },
              { texture: live, origin: [run.x, run.y] },
              [run.width, run.height],
            )
          }
        },
      ).catch(() => null)
      if (!field) return null
      field.destroy()
      try {
        if (live.mipLevelCount > 1) await generateAtlasMips(renderer, target)
      } catch {
        return null
      }
      signal.throwIfAborted()
    } else {
      // A CPU atlas keeps its bytes, which a later upload sends whole: they take the patch too.
      // (`mipmapsAutoUpdate` is r187's; r186 regenerates the mipmaps after every copy.)
      const image = target.image as { data?: unknown } | null
      const bytes =
        image?.data instanceof Uint8Array && image.data.length === width * height
          ? image.data
          : undefined
      const pixels = context.getImageData(0, 0, patchWidth, patchHeight).data
      const field = encodeSdfFromAlpha(
        alphaOfRgba(pixels, patchWidth * patchHeight),
        patchWidth,
        patchHeight,
        padding,
      )
      signal.throwIfAborted()

      // Everything from here on is synchronous, so a newer build cannot interleave its own patch.
      if (bytes) {
        for (const run of runs) {
          for (let row = 0; row < run.height; row++) {
            const from = (run.top + row) * patchWidth
            bytes.set(field.subarray(from, from + run.width), (run.y + row) * width + run.x)
          }
        }
      }
      const patch = new DataTexture(field, patchWidth, patchHeight, RedFormat, UnsignedByteType)
      patch.needsUpdate = true
      const autoMipmaps = target.mipmapsAutoUpdate
      try {
        runs.forEach((run, index) => {
          // Each copy regenerates the whole mip chain: only the last needs to.
          if (autoMipmaps) target.mipmapsAutoUpdate = index === runs.length - 1
          renderer.copyTextureToTexture(
            patch,
            target,
            new Box2(new Vector2(0, run.top), new Vector2(run.width, run.top + run.height)),
            new Vector2(run.x, run.y),
          )
        })
      } catch {
        // A renderer that cannot copy between textures uploads the atlas's bytes again, whole.
        if (!bytes) return null
        target.needsUpdate = true
      } finally {
        if (autoMipmaps) target.mipmapsAutoUpdate = true
        patch.dispose()
      }
    }

    const glyphs = new Map(atlas.glyphs)
    for (const glyph of fresh) {
      glyphs.set(
        glyph.request.key,
        slotOf(
          glyph,
          padding,
          bakeSize,
          width,
          height,
          false,
          isColorCandidate(glyph.request, colorGlyphs),
        ),
      )
    }
    appendCursors.set(glyphs, { ...cursor, x, y, rowHeight })
    return { ...atlas, glyphs }
  } finally {
    canvas.remove()
  }
}
