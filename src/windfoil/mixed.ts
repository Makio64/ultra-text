import { Mesh, type InstancedBufferGeometry } from 'three/webgpu'
import type { DomLayoutSnapshot, DomSdfOptions, SdfAtlas, SdfMotionOptions } from '../types.js'
import type { WindfoilBackend } from './runtime.js'
import type { GlyphTextMaterial, GlyphKeepHook } from '../text/GlyphTextMaterial.js'
import { createGlyphGeometry, glyphContentFits, updateGlyphContent } from '../text/geometry.js'
import { setBounds } from '../text/geometryUtils.js'
import { GLYPH_RECTS_KEY, glyphRectTable } from '../text/decorations.js'
import { SdfTextMaterial } from '../text/SdfTextMaterial.js'
import { windfoilGlyphRect } from './geometry.js'

type TextMesh = Mesh<InstancedBufferGeometry, GlyphTextMaterial>
interface Part {
  readonly mesh: TextMesh
  readonly covers: (key: string) => boolean
  readonly build: (snapshot: DomLayoutSnapshot, strength: number) => InstancedBufferGeometry
  readonly fits: (snapshot: DomLayoutSnapshot) => boolean
  readonly update: (snapshot: DomLayoutSnapshot, strength: number) => void
}
/**
 * Optional colour and SDF companions. Loaded only when a backend actually has extra parts.
 * `motion` false builds them static, like the primary; `strength` pads their bounds.
 */
export function createExtraTextParts(
  snapshot: DomLayoutSnapshot,
  backend: WindfoilBackend,
  options: DomSdfOptions,
  motion: SdfMotionOptions | false,
  strength = (motion === false ? undefined : motion.strength) ?? 18,
) {
  const parts: Part[] = []
  const sequence = snapshot.glyphs.reduce((max, glyph) => Math.max(max, glyph.sequence), 0)
  const add = (
    build: Part['build'],
    material: () => GlyphTextMaterial,
    covers: Part['covers'],
    fits: (geometry: InstancedBufferGeometry, layout: DomLayoutSnapshot) => boolean,
    update: (
      geometry: InstancedBufferGeometry,
      layout: DomLayoutSnapshot,
      strength: number,
    ) => unknown,
    name: string,
    order: number,
    cast = true,
  ): void => {
    const geometry = build(snapshot, strength)
    let mesh: TextMesh
    try {
      mesh = new Mesh(geometry, material())
    } catch (error) {
      geometry.dispose()
      throw error
    }
    mesh.name = name
    mesh.renderOrder = order
    mesh.castShadow = cast && options.castShadow !== false
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    parts.push({
      mesh,
      covers,
      build,
      fits: (layout) => fits(mesh.geometry, layout),
      update: (layout, padding) => {
        update(mesh.geometry, layout, padding)
      },
    })
  }
  try {
    const color = backend.color
    if (color)
      add(
        (layout, padding) =>
          color.createGeometry(layout, padding, backend.motionOrdinals(layout)).geometry,
        () => color.createMaterial({ ...options, motion, maxSequence: sequence }),
        (key) => !!color.glyphs.get(key)?.monotonePieceCount,
        (geometry, layout) => color.contentFits(geometry, layout),
        (geometry, layout, padding) =>
          color.updateGeometry(geometry, layout, padding, backend.motionOrdinals(layout)),
        'ultra-text Windfoil colour glyphs',
        2.25,
      )
    const atlas = backend.companion
    if (atlas) {
      const sizeSwitch = backend.sizeSwitch
      // Size-switched glyphs share the primary's anchors and carry their switch em.
      const switched = (layout: DomLayoutSnapshot): DomLayoutSnapshot =>
        sizeSwitch?.layout(layout) ?? layout
      const addSdf = (
        subAtlas: SdfAtlas,
        matOpts: DomSdfOptions & { readonly underlay?: boolean },
        keepGlyph: GlyphKeepHook | undefined,
        name: string,
        order: number,
        layoutOf = switched,
        cast?: boolean,
        bounds?: (
          geometry: InstancedBufferGeometry,
          layout: DomLayoutSnapshot,
          padding: number,
        ) => void,
      ) =>
        add(
          (layout, padding) => {
            const geometry = createGlyphGeometry(
              layoutOf(layout),
              subAtlas,
              padding,
              backend.motionOrdinals(layout),
            ).geometry
            bounds?.(geometry, layout, padding)
            return geometry
          },
          () =>
            new SdfTextMaterial({
              ...matOpts,
              atlas: subAtlas.texture,
              atlasWidth: subAtlas.width,
              atlasHeight: subAtlas.height,
              pxRange: subAtlas.pxRange,
              bakeSize: subAtlas.bakeSize,
              shapeTop: subAtlas.shapeTop,
              motion,
              runMotion: true,
              maxSequence: sequence,
              ...(keepGlyph ? { keepGlyph } : {}),
              ...(subAtlas.colorLayer &&
              (options.colorGlyphs !== 'none' ||
                snapshot.requests.some((request) => request.shape?.bitmap))
                ? { colorLayer: subAtlas.colorLayer }
                : {}),
            }),
          (key) => subAtlas.glyphs.has(key),
          (geometry, layout) =>
            glyphContentFits(geometry, layoutOf(layout), subAtlas, backend.motionOrdinals(layout)),
          (geometry, layout, padding) => {
            updateGlyphContent(
              geometry,
              layoutOf(layout),
              subAtlas,
              padding,
              backend.motionOrdinals(layout),
            )
            bounds?.(geometry, layout, padding)
          },
          name,
          order,
          cast,
        )
      const effects = backend.effects
      if (effects) {
        // The underlay moves with the glyph it outlines: it scales about the primary's or the
        // colour part's anchor, with that part's ordinal, not about the centre of its SDF cell.
        const anchors = new WeakMap<DomLayoutSnapshot, DomLayoutSnapshot>()
        const anchored = (layout: DomLayoutSnapshot): DomLayoutSnapshot => {
          let result = anchors.get(layout)
          if (!result) {
            const base = switched(layout)
            const ordinals = backend.motionOrdinals(layout)
            result = {
              ...base,
              glyphs: base.glyphs.map((glyph, index) => {
                const composite = backend.color?.glyphs.get(glyph.glyphKey)
                const header = composite ?? backend.glyphs.get(glyph.glyphKey)
                if (glyph.motionOrigin || !header) return glyph
                const [x0, y0, x1, y1] = header.bbox
                const clip = composite?.clipBox
                const rect = windfoilGlyphRect(
                  glyph,
                  header,
                  clip
                    ? [
                        Math.max(x0, clip[0]),
                        Math.max(y0, clip[1]),
                        Math.min(x1, clip[2]),
                        Math.min(y1, clip[3]),
                      ]
                    : header.bbox,
                )
                return {
                  ...glyph,
                  motionOrigin: [
                    (rect[0] + rect[2]) / 2,
                    (rect[1] + rect[3]) / 2,
                    ordinals[index]!,
                  ],
                }
              }),
            }
            anchors.set(layout, result)
          }
          return result
        }
        // Glyphs that the primary or the colour part draws from outlines keep that exact fill,
        // over an underlay of their ring and shadow at the fill's render order. DomSdf makes it
        // before the fill, so that three draws it first at their shared depth while separate
        // texts still sort by depth. Glyphs without outlines, and size-switched ones while
        // small, stay whole SDF text, effects included.
        const { outline: _outline, dropShadow: _dropShadow, ...plain } = options
        const slots = [...atlas.glyphs]
        const underlaid = slots.filter(([key]) => backend.analyticCovers(key))
        const whole = slots.filter(([key]) => !backend.glyphs.has(key) || sizeSwitch?.keys.has(key))
        if (underlaid.length)
          addSdf(
            { ...atlas, glyphs: new Map(underlaid) },
            { ...plain, ...effects, underlay: true },
            sizeSwitch?.windfoil,
            'ultra-text text effects',
            2,
            anchored,
            // Shadow maps take the ring from the underlay, which casts its SDF fill with it so
            // that no crack opens along the ring's inner edge. A drop shadow alone adds nothing.
            !!effects.outline,
            // That shared depth is the projected centre of each geometry's bounding sphere, which
            // three compares before their age. The underlay also holds the colour part's glyphs,
            // which data-sdf-depth may lift or lower: it takes the text's bounds, those of the
            // glyphs the primary draws, so that the two always tie.
            (geometry, layout, padding) => {
              let minZ = 0,
                maxZ = 0
              for (const glyph of layout.glyphs)
                if (backend.primaryCovers(glyph.glyphKey)) {
                  if (glyph.z < minZ) minZ = glyph.z
                  if (glyph.z > maxZ) maxZ = glyph.z
                }
              setBounds(geometry, layout.width, layout.height, padding, minZ, maxZ)
            },
          )
        if (whole.length)
          addSdf(
            { ...atlas, glyphs: new Map(whole) },
            options,
            sizeSwitch?.sdf,
            'ultra-text fallback glyphs',
            2.5,
          )
      } else {
        addSdf(atlas, options, sizeSwitch?.sdf, 'ultra-text fallback glyphs', 2.5)
      }
    }
  } catch (error) {
    for (const part of parts) {
      part.mesh.geometry.dispose()
      part.mesh.material.dispose()
    }
    throw error
  }
  return {
    meshes: parts.map((part) => part.mesh),
    /** For animated parts; static ones are swapped whole (see DomSdf's bundle). */
    setMotion(value: SdfMotionOptions) {
      for (const part of parts) part.mesh.material.setMotion(value)
    },
    prepare(
      layout: DomLayoutSnapshot,
      padding: number,
    ): readonly (InstancedBufferGeometry | null)[] {
      const staged: (InstancedBufferGeometry | null)[] = []
      try {
        for (const part of parts)
          staged.push(part.fits(layout) ? null : part.build(layout, padding))
        return staged
      } catch (error) {
        for (const geometry of staged) geometry?.dispose()
        throw error
      }
    },
    commit(
      staged: readonly (InstancedBufferGeometry | null)[],
      layout: DomLayoutSnapshot,
      padding: number,
    ) {
      const max = layout.glyphs.reduce((value, glyph) => Math.max(value, glyph.sequence), 0)
      parts.forEach((part, index) => {
        const next = staged[index]
        if (next) {
          const old = part.mesh.geometry
          part.mesh.geometry = next
          old.dispose()
        } else part.update(layout, padding)
        part.mesh.material.maxSequence.value = max
      })
    },
    mergeRects(layout: DomLayoutSnapshot, primary: InstancedBufferGeometry) {
      const sources = [
        (primary.userData['ultraOwnGlyphRects'] as Float32Array | undefined) ??
          glyphRectTable(primary),
        ...parts.map((part) => glyphRectTable(part.mesh.geometry)),
      ]
      const cursors = new Uint32Array(sources.length),
        result = new Float32Array(layout.glyphs.length * 4)
      let target = 0
      for (const glyph of layout.glyphs) {
        // A size-switched glyph is held by the primary and the SDF companion: take the
        // primary's ink rect and advance every holder's row.
        let first = -1
        for (let source = 0; source < sources.length; source++) {
          const holds =
            source === 0
              ? backend.primaryCovers(glyph.glyphKey)
              : parts[source - 1]!.covers(glyph.glyphKey)
          if (!holds) continue
          const offset = cursors[source]!++ * 4
          if (first >= 0) continue
          first = source
          for (let c = 0; c < 4; c++) result[target + c] = sources[source]![offset + c]!
        }
        if (first >= 0) target += 4
      }
      primary.userData[GLYPH_RECTS_KEY] = result
    },
  }
}
