# ultra-text

[![CI](https://github.com/Makio64/ultra-text/actions/workflows/ci.yml/badge.svg)](https://github.com/Makio64/ultra-text/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ultra-text)](https://www.npmjs.com/package/ultra-text)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f81f7.svg)](./LICENSE)

**DOM to WebGPU/TSL.** Real HTML, laid out by the browser, becomes live 3D text in the Three.js
`WebGPURenderer`, drawn by TSL shaders from a retained SDF atlas or analytic Windfoil outlines.

[Gallery](https://ultra-text.makio.io/) ·
[Documentation](https://ultra-text.makio.io/docs) ·
[HTML/3D demo](https://ultra-text.makio.io/demo) ·
[Changelog](https://github.com/Makio64/ultra-text/blob/main/CHANGELOG.md)

[![The ultra-text WebGPU gallery](https://ultra-text.makio.io/og.png)](https://ultra-text.makio.io/)

`ultra-text` measures marked HTML or a styled text string with the browser and returns a retained
`THREE.Group`. The default path bakes a distance-field atlas; the optional experimental
Windfoil path retains quadratic outlines instead.

- Browser-native layout and line breaking
- Static instanced glyph and rectangle geometry
- GPU SDF baking with an exact CPU fallback, or analytic quadratic outlines
- TSL motion, clipping, antialiasing, and shadow masks
- Text weight [matched to the browser's](#matching-the-browser) own blending, on by default
- Custom TSL fill and vertex hooks, outlines and hard drop shadows on every text backend, and solid
  CSS text decorations
- Transactional rebuilds with no DOM reads in the render loop
- Enforced bundle budget: the public entry stays at or under 35 kB min+brotli
  (size-limit, excluding Three.js, Pretext, and separately budgeted optional feature chunks)

The optional CPU builder has a separate 3 kB budget, plus 2.5 kB for its worker asset.

> [!NOTE]
> The baked atlas uses a **single-channel SDF** (not MSDF).
> Windfoil is a separate text backend, not an atlas mode. See
> [Limitations](#limitations) before using either path for demanding typography.

## Requirements and install

- ESM only; `require()` is not supported.
- Three.js `WebGPURenderer`; the classic `WebGLRenderer` is not supported.
- Three.js r187. The peer range is `>=0.187.0 <0.188.0`.
- Canvas 2D and the browser font-loading APIs. The default layout engine also needs DOM
  `Range`.
- `ResizeObserver` and `MutationObserver` unless `observe: false` is used.

`atlasMode: 'gpu'` requires a real WebGPU backend. The default `auto` mode can fall back to
the CPU atlas when `WebGPURenderer` is using its WebGL2 backend, or when the WebGPU device
cannot run the GPU passes.
The Windfoil and Slug paths require WebGPU and quadratic font outlines, from an app-supplied
resolver or, without one, traced from the browser's own glyphs. With `fallback: 'sdf'`,
selecting them can instead degrade the whole capture to SDF when WebGPU or an outline is
unavailable.

```sh
npm install ultra-text three@0.187
```

TypeScript projects also need matching Three.js declarations:

```sh
npm install --save-dev @types/three@0.187
```

The package has one runtime dependency, `@chenglou/pretext` (`^1.0.0`). It is installed for
every consumer but never loaded eagerly: `collectDomSnapshot` imports the
`@chenglou/pretext/rich-inline` subpath dynamically, only when `layoutEngine: 'pretext'` is
requested, which loads about 38 kB min+brotli more. The default Range engine never touches it.

## Quick start

Mark only the DOM content that should cross into Three.js:

```html
<article id="profile" data-text-rect data-text-receive-shadow>
  <p data-text-block>Runtime type, laid out by the browser.</p>

  <div class="tag" data-text-rect>
    <span data-text-block data-text-depth="4">WebGPU + TSL</span>
  </div>

  <button data-text-ignore>HTML-only action</button>
</article>
```

With an initialized `WebGPURenderer` and an existing scene:

```ts
import { DomText } from 'ultra-text'
// Note: DomSdf is also exported as an alias.

const source = document.querySelector<HTMLElement>('#profile')
if (!source) throw new Error('Missing #profile')

// Capture only after webfonts can affect the measured layout.
await document.fonts.ready

const domText = await DomText.create(renderer, source, {
  quality: 'high',
})

scene.add(domText)

// Later:
scene.remove(domText)
domText.dispose()
```

The source must stay connected and have a non-zero layout box while it is captured.

## String text with CSS

Use `Text` to create a Three.js group directly from a string. Pass the initialized renderer
and ordinary CSS properties:

```ts
import { Text } from 'ultra-text'

const text = new Text('Hello, WebGPU!', {
  renderer,
  css: {
    fontFamily: 'Arial, sans-serif',
    fontSize: 48,
    color: '#ffcc00',
    width: 320,
  },
  cssClass: 'headline',
})

await text.ready
scene.add(text)

// Later:
scene.remove(text)
text.dispose()
```

`css` accepts a property object or a CSS declaration string, such as
`'font-size: 48px; color: #ffcc00; width: 320px'`. Object keys can use camelCase, kebab-case,
or custom properties such as `'--accent'`. Numeric length values become pixels; unitless
properties such as `lineHeight` and `opacity` keep their numeric values. Use strings for
other units, for example `fontSize: '2rem'`.

`cssClass` applies classes from your app's stylesheets. Supply a space-separated string, an
array such as `['headline', 'accent']`, or a conditional map such as
`{ headline: true, muted: false }`. Sass, SCSS, and Stylus work through stylesheets compiled
by your app's build tool: pass the resulting class names to `cssClass`. Runtime `css` strings
use standard CSS declaration syntax.

`Text` owns a visually clipped, measurable DOM source whose content is literal text, including
HTML-looking strings. Its source is attached to `document.body` by default; pass a connected
`parent` element to inherit its CSS and match selectors scoped beneath it. The initial build
waits for fonts. The same [CSS capture limitations](#limitations) and `DomText` rendering
options apply, including `observe: false` for manual updates. A `Text` cannot see what your
scene draws behind it: name that colour as `tone: { backdrop }` so light text is weighted for
it; see [Matching the browser](#matching-the-browser).

```ts
text.text = 'Updated text'
text.setCss({ fontSize: 36, color: 'tomato' }) // Replace the inline CSS.
text.setClass(['headline', 'compact']) // Replace the classes.
await text.rebuild() // Await the updated capture; required with observe: false.
```

Default observers schedule updates when the text, inline style, or classes change. Call
`rebuild()` after external stylesheet changes that leave the source and its size unchanged.
`dispose()` aborts pending work, releases the rendered resources, and removes the owned DOM
source. `TextOptions`, `TextCss`, and `TextClass` are available as package-root type exports.

## TresJS, React Three Fiber, Mini3, and Vanilla JS

Copy the starter components once, then render `<UltraText source={source} />` in React,
`<UltraText :source="source" />` in Vue, or `await UltraText.create(renderer, source)` in Mini3.
They handle WebGPU setup, fonts, DOM updates and cleanup.

- [TresJS guide](https://ultra-text.makio.io/docs-tres) — verified with TresJS 5.10.0 and Vue 3.5.44.
- [React Three Fiber guide](https://ultra-text.makio.io/docs-r3f) — verified with R3F 9.8.2 and React 19.3.1,
  with a separate starter for the R3F 10 alpha.
- [Mini3 & Vanilla JS guide](https://ultra-text.makio.io/docs-mini3) — verified with Mini3 0.1.0-alpha.0 and `ultra-text/vanilla`.

With TresJS and React Three Fiber, install a Three.js release within the package's peer range.
Mini3 and custom WebGPU/Canvas engines import from `ultra-text/vanilla`, which has zero
Three.js runtime dependencies (`three` is an optional peer dependency). These starter
components are MIT consumer components to copy into your app, including with a coding agent;
they are not additional framework npm entry points. See the
[agent instructions](https://ultra-text.makio.io/integrations/AGENTS.md).

### Engine-agnostic Vanilla JS (`ultra-text/vanilla`)

Import from `ultra-text/vanilla` when using Mini3 or any custom WebGPU/Canvas renderer without
Three.js:

```ts
import { DomText } from 'ultra-text/vanilla'

const domText = await DomText.create(source, gpuDevice, {
  quality: 'high',
  reflowable: true,
  onChange(instance, reason) {
    // Upload instance.glyphs, instance.plainRects, instance.decorations
    // and bind instance.atlas.gpuTexture (or instance.atlas.data on CPU)
  },
})
```

`ultra-text/vanilla` exports `DomText` (`DomSdf`, `VanillaDomText`), `Text` (`VanillaText`),
`collectDomSnapshot`, `reflowSnapshot`, `rasterizeGlyphAtlas`, `buildVanillaSdfAtlas`
(`buildSdfAtlas`), `buildVanillaGpuSdfAtlas`, `buildVanillaCpuSdfAtlas`,
`packGlyphInstances`, `packRectInstances`, `packDecorationInstances`, and
`resolveDomTextTone`.

## Markup contract

| Attribute                  | Effect                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `data-text-block`          | Capture text in this element and its inline descendants. Nested blocks are captured once. |
| `data-text-rect`           | Capture the solid background colour, effective opacity, box, and uniform corner radius.   |
| `data-text-ignore`         | Exclude this element and all descendants.                                                 |
| `data-text-depth="n"`      | Set Z depth for this element; descendants inherit the nearest declared value.             |
| `data-text-receive-shadow` | Put this rectangle in the lit, shadow-receiving batch.                                    |

Custom `textSelector`, `rectSelector`, and `ignoreSelector` values replace the defaults. The
root background is captured by default, even when the root has no `data-text-rect`. The original
`data-sdf-*` names (`data-sdf-block`, `data-sdf-rect`, …) are still read, so markup written for
them keeps working.

The generated canvas/group is visual, not a semantic replacement. Keep the source HTML in the
accessibility tree and mark the canvas `aria-hidden="true"`. The source must be rendered with a
non-zero box during capture; with `observe: false`, it can become visually transparent after the
build without adding `aria-hidden`. Keep a separate semantic copy for any UI that cannot do that.

## Coordinates and lifecycle

Generated content uses the root's bottom-left corner as local `(0, 0)`. X and Y are CSS
pixels divided by `pixelsPerUnit`; Z is not scaled. `width` and `height` expose the current
local dimensions.

```ts
domSdf.setMotion({ enabled: true, mode: 'slide-up', speed: 0.8 })

await domSdf.rebuild() // Re-read layout; reuse retained text data when possible.
await domSdf.rebuild({ atlas: true }) // Force fresh SDF/Windfoil data.

console.table(domSdf.stats)
console.log(domSdf.width, domSdf.height, domSdf.atlasTexture)
```

Text that never moves keeps the motion graph out of its shaders. `DomText`/`DomSdf` read the
live motion mode at every build: with `mode: 'none'` they build static materials, whose vertex
stage has no clock, waves or slide timeline, and `createWindfoilShapes` is static by default.
The first `setMotion()` that sets another mode builds animated materials once, synchronously,
and swaps them in (the meshes stay; edits made to the old materials by hand are not carried
over), and the next frame compiles their pipelines. After that every motion change, `'none'`
included, is a uniform write again, until a capture made with mode `'none'` builds static
materials again. A standalone `SdfTextMaterial` takes `motion: false` for the same static graph:
`animated` is then false, `setMotion()` throws and `clone()` stays static. Text and unlit DOM
rects are unlit: scene lights, and ambient occlusion a render pass supplies, never reach their
shaders, so adding or changing lights never rebuilds them; shadow receivers stay lit.

By default, a root `ResizeObserver`, a subtree `MutationObserver`, and font-loading events
schedule coalesced rebuilds. Attribute-only mutation storms (a CSS transition, a JS tween)
are debounced, and a re-read that captures identical content stops before rebuilding
any geometry. Change detection hashes capture values directly, avoiding a serialized copy of
the entire layout. Set `observe: false` for manual control. Awaited builds reject normally;
`onError` receives errors from observer-scheduled rebuilds.

Rebuilds are atomic. A newer build aborts superseded work, and the previous rendered content
stays live until the replacement is ready. When retained text data and mesh structure are unchanged, a
rebuild reuses the compiled materials and meshes and only refreshes geometry; a capture that
is byte-identical to the current content stops right after the DOM read.
Rectangle and decoration replacements are staged with the text: an allocation failure
releases the replacements and preserves the previous meshes and material uniforms.

`dispose()` is idempotent. It cancels builds, disconnects observers, and releases every
geometry, material, texture, and render target created by the instance. The renderer, scene,
source HTML, lights, and cameras remain yours.

## Dynamic text and reflow

Reserve characters that may appear later so counters and readouts can reuse retained text data:

```ts
const domSdf = await DomSdf.create(renderer, source, {
  extraGlyphs: '0123456789.msKMB',
})

readout.textContent = `${ms.toFixed(1)} ms`
await domSdf.rebuild() // stats.atlasBuildMs remains 0 when text data is reused.
```

Rebuilds also reuse retained data when the requested font/glyph set is a subset of what is
already available. Removing text and restoring those glyphs does not rebake. A new text glyph
is usually drawn into the SDF atlas in place (see below); a new font, or a glyph that cannot be
patched in, rebuilds the data for the current capture. `extraGlyphs` keeps future characters
reserved.
They are reserved as written, so list capitals for `text-transform: uppercase` copy.
Use `rebuild({ atlas: true })` to regenerate or compact the retained data explicitly.

`extraGlyphs` prevents rebaking. A rebuild whose glyph count and attribute layout match the
retained geometry writes the new rects, UVs, colours and depth into those buffers instead of
allocating replacements. A count change still replaces the geometry. The DOM read and the GPU
upload of the changed attributes remain. Coalesce and await manual rebuilds for low-cadence copy,
and always handle awaited or observed errors.

Several groups can share one atlas. Build it once, pass it as `sharedAtlas`, and dispose it
yourself after the instances are gone. An instance whose capture needs a glyph the atlas does
not contain builds a private atlas instead of mutating the shared one.

For fast width-only changes, retain the capture and re-wrap from its measured advances:

```ts
const domSdf = await DomSdf.create(renderer, source, { reflowable: true })
domSdf.reflow(560)
```

`reflow()` does no DOM read, font measurement, or backend work. It updates the existing glyph
geometry attributes in place without reallocating GPU buffers and renumbers the per-line motion
stagger for the new line breaks. Each line follows the block's captured `text-align` and
`text-align-last`: left, center, right or justify, with `start`/`end` resolved by the block's
CSS direction and the `-webkit-` values of `<center>` and `align=` read as their plain sides.
Words wrap and align by their own width inside the block's content box, so a trailing space
hangs as in CSS, and no-break spaces never break a line. A justified line spreads its slack over
its word spaces (and `cjkLineBreaking` breaks), never around an inline SVG glued to a word; the
last line and lines before a `<br>` follow `text-align-last`. Captured at 320 px and reflowed to
200–560 px in headless Chrome 156 on an Apple M3 Max (Noto Sans, Arial, Helvetica Neue, Georgia,
Courier New, Times New Roman), glyphs land within 0.04 px of a fresh capture for left, center,
right, start and end, and within 0.06 px for justify, with the same line breaks.

It is a block-flow model, not a full CSS engine. It does not recompute `text-indent`, mixed font
sizes on one line (one line pitch per block), hyphenation, bidi reordering within a line,
floats, media queries, or captured rectangle geometry. In justified blocks each word space is
one Canvas space plus letter- and word-spacing, so inline padding, tabs and other space
characters are off by a few pixels there; a line that fills to within about 0.03 px can break
differently from the browser, and with `pixelSnap` a right-aligned or justified line can move
one quarter-pixel snap step. RTL scripts need `rtlReflow: true`. A capture made without
`OffscreenCanvas` (jsdom) records no natural word spaces, so its justified blocks reflow at their
measured spacing. Use `rebuild()` when CSS layout must be measured again.

A rebuild that adds text glyphs to an instance's own SDF atlas draws them into its free text rows
in place instead of baking a new atlas. Only the new glyphs are measured, drawn and encoded, with
the atlas's own encoder (the GPU jump flood for a GPU atlas, the exact CPU transform for a CPU
atlas); they are then copied into the live texture and its mipmaps are regenerated, so the
texture and the compiled materials stay. Patched glyphs match a full build exactly on a CPU atlas
and within one 8-bit step on a GPU atlas. After its first new glyph, an instance builds its
atlas with headroom: free rows of max(tallest text slot, a
quarter of the text rows) above any shapes and colour glyphs, in an atlas at least two widest
glyphs wide, which makes short texts' atlases 1.5–2.6 times larger. Glyphs that classify as
colour, SVG shapes, `rebuild({ atlas: true })` and webfont loads, Windfoil and Slug companions, a
caller's `sharedAtlas`, a lowered adaptive bake size, more than 2¹⁸ new texels, and glyphs that
do not fit rebuild the atlas in full; glyphs the text no longer uses stay until such a full
build. `ultra-text/vanilla` always rebuilds in full. On a 188-glyph text gaining one character
per rebuild (headless Chrome 156, Apple M3 Max, shared GPU, n = 50), the median time from
`rebuild()` to the first frame went from 9.0 to 6.7 ms with a GPU atlas and from 11.0 to 2.9 ms
with a CPU atlas; the first new glyph after a capture is still a full rebuild.

Reflow creates a new CPU snapshot with one shared clipping rectangle per block and places
words as it measures them, without retaining an intermediate word list.

## Layout engines

- `range` is the default. It reads the browser's rendered glyph boxes for the highest CSS
  fidelity and returns synchronously from `collectDomSnapshot()`.
- `pretext` lazily loads `@chenglou/pretext`, measures through Canvas, and returns a promise.
  It avoids one DOM geometry read per glyph, but models `white-space: normal`. It aligns and
  justifies inside its own line pass, following `text-align-last`. Prefer `range` for `<br>`,
  bidi-sensitive placement, floats, indentation, vertical writing, or exact CSS parity. On a
  display scale other than 1 it reads up to 16 glyph boxes per capture, to learn which pixel the
  browser rounds on.

```ts
import { collectDomSnapshot } from 'ultra-text'

const exact = collectDomSnapshot(source)
const fast = await collectDomSnapshot(source, { layoutEngine: 'pretext' })
```

A capture also records where the browser's layout put each font's baseline. A browser sets
it with the font's descent rounded to whole layout pixels (device pixels on a real display,
CSS pixels under device emulation), so it can sit half a pixel from the font's own descent
scaled to the size. Each glyph carries that rounded descent as `baselineOffset`, and both text
backends draw from it. Range captures and browser-shaped runs measure it through Canvas and
keep it only when it reproduces the text box the DOM reports; otherwise a Range glyph falls
back to the atlas or outline descent, and a shaped run to the descent Canvas reports at its
CSS size. Pretext builds its lines from the same rounded metrics, rounds the half-leading down
as the browser does, and takes a `normal` line height from the font's ascent plus descent.

Capture caches font metrics, glyph keys, and hidden/decoration ancestry within each read;
later captures refresh them so CSS and loaded-font changes stay visible. The glyph loops
avoid temporary object copies and redundant font assignments; layout-change detection hashes
each distinct glyph-key string once per capture. Browser shaping shares its Range, grapheme
segmenter, and Canvas context across blocks, and reuses descents for identical text at the
same font and size within a capture. The Range engine still measures each visible glyph for
exact placement. For width-only updates, use
`reflowable: true` and `reflow(width)` to avoid DOM capture entirely.

### Optional language support

Language extensions are off by default. For joined scripts, ligatures, combining marks, and
mixed-direction text, enable native browser shaping:

```ts
const text = await DomText.create(renderer, source, {
  textShaping: 'browser',
})
```

This lazily loaded path preserves complete rendered runs, including Arabic/Persian joining,
Indic conjuncts, Hebrew marks, and grapheme sequences. Equivalent inline markup shares shaping
context. It uses Range layout and SDF; Windfoil needs `fallback: 'sdf'`. No shaping dependency
or font is bundled. Supply fonts that cover your text.

Requested shaping and SVG rasterization modules load alongside font preparation. A capture
requesting both SVG and browser shaping also loads those modules together. These imports
remain conditional; the default glyph path does not load them.

Shaping, animation, and atlas reuse operate per run; wide runs use atlas tiles. Resize through
`rebuild()` (automatic with observation), not `reflow(width)`. Low-level `collectDomSnapshot()`
returns a promise; pass the same `textShaping` option to `SdfTextMaterial`. Run masks can use
more atlas memory than reusable glyphs. Changes in font or paint style split shaping context.
Emoji sequences (ZWJ, skin tone, flags, keycaps, tags and presentation selectors) stay whole
with both layout engines, without requiring browser shaping. SDF emoji retain the browser's
colours, including within mixed shaped runs; `colorGlyphs: 'none'` restores silhouettes.
Arbitrary OpenType feature settings remain unsupported.

For the default glyph path, `cjkLineBreaking: true` enables basic CJK reflow punctuation rules,
and `rtlReflow: true` enables uniform RTL word reflow. Neither implements mixed bidi reordering.
The legacy `reshape(text)` hook receives text after CSS `text-transform`. It must preserve code
point boundaries and whitespace with Range, and cannot be combined with browser shaping.
`adaptiveBakeSize: true` separately allows lowering SDF resolution on atlas overflow. All three
booleans default to `false`.

## Matching the browser

A browser blends its glyph mask on sRGB-encoded values; a scene blends coverage in linear
light. The same glyph therefore reads differently in the two: in linear light, dark text on a
light background comes out lighter and thinner than in the page, and light text on a dark
background heavier. `tone` converts the coverage of text ink so that the linear-light result
lands on the pixel the browser shows. It is on by default for both text backends, and it is
arithmetic on coverage the shader already has: no extra texture read and no extra draw.

```ts
// The page behind `source` is white, but the scene shows this text on a dark wall.
const label = await DomText.create(renderer, source, {
  tone: { backdrop: '#101418' },
})

// The font's own outline at exact coverage, with the conversion left out of the shaders.
const exact = await DomText.create(renderer, source, { tone: false })
```

| `tone` field | Default  | Meaning                                                                                       |
| ------------ | -------- | --------------------------------------------------------------------------------------------- |
| `backdrop`   | `'auto'` | Colour the text is read against: a hex value, a colour name, comma-separated `rgb()`/`hsl()`. |
| `model`      | `'auto'` | Rasterizer to imitate: `'outline'`, `'macos'` or `'windows'`.                                 |
| `strength`   | `1`      | From `0` to `1`: how much of the conversion applies.                                          |

Each capture resolves the `'auto'` values from the page, never in the render loop:

- **Model.** The platform and the source element's computed CSS decide. macOS with default
  font smoothing gives `'macos'`: CoreGraphics smoothing, which also grows every outline by
  min(0.0058 em, 0.30 px) to either side and twice that upwards, below 256 device pixels per
  em. macOS with `-webkit-font-smoothing: antialiased` or `none`,
  `-moz-osx-font-smoothing: grayscale` or `text-rendering: geometricPrecision` gives
  `'outline'`, exact outline coverage. Windows gives `'windows'`, Skia's contrast table.
  Linux, Android, iOS and iPadOS give `'outline'`.
- **Backdrop.** What the capture draws behind the text (its rectangles and root background),
  over the nearest opaque CSS background colour behind the source element. One backdrop
  serves a whole capture: the one behind most of its text.
- **Unknown backdrop.** Where nothing can tell (no opaque background colour behind the
  source, a background image in front of it, a `Text`, whose source is hidden, or a material
  you build yourself), dark text gets the weight it has on a white page and light text keeps
  its exact coverage: it is neither thinned nor lifted.

Set `tone.backdrop` to the colour your scene shows behind the text whenever that is not the
page's: text captured from a white page and shown on a dark wall, a `Text`, a standalone
`SdfTextMaterial`, or your own backdrop mesh on a transparent canvas. A `Text` whose CSS
gives it an opaque `background` of its own already knows its backdrop.

```ts
const title = new Text('Hello, WebGPU!', {
  renderer,
  css: { fontSize: 48, color: '#ffffff' },
  tone: { backdrop: '#101418' },
})
```

The conversion applies where the frame itself holds what the text is drawn over: an opaque
canvas or clear colour, a scene background, a rectangle the capture draws, or a `backdrop`
you name. On Three's default transparent canvas laid over the page, the browser blends the
canvas with the page, so text over nothing keeps its exact coverage there. Translucent text
(colour alpha, CSS `opacity`) is converted as the browser blends it; SDF text with an
`outline` or `dropShadow` converts as opaque ink. Emoji and other colour glyphs, SVG paint,
outline rings, drop shadows and shadow masks keep their exact coverage. `strength` scales
the conversion, not the `'macos'` model's outline growth: use `tone: false` or the
`'outline'` model for the font's own outline.

SDF text draws from the same starting point as Windfoil. The atlas bakes the font's own
outline, without the platform's smoothing, and the contour sits on it (`threshold: 0.5`, no
`stemDarkening`); the weight comes from `tone` alone.

### Pixel snapping

A capture keeps layout positions, which can lie between pixels. A browser paints each line of
upright text on a whole pixel row, and each glyph origin on a quarter of a device pixel while
the glyph is under 162 device pixels per em. `pixelSnap: true` moves captured lines and glyph
origins there, with no extra DOM read:

```ts
const overlay = await DomText.create(renderer, source, { pixelSnap: true })
```

Use it for text shown flat, unscaled and pixel-aligned over the page it was captured from.
It holds for the element's position at capture: capture again once the element has moved by a
fraction of a pixel. Under any other transform it only gives up the layout positions, so it
is off by default. `reflow()` snaps the re-wrapped layout again; browser-shaped runs take the
rows only, and inline SVG shapes are not moved.

### Multisampled targets

Windfoil pads each glyph quad for the sample count of the pass being drawn, so a 4×
multisampled canvas or render target keeps the coverage of its edge samples. There is
nothing to set, and single-sampled passes keep the tighter quad. A 4× pass shades more
fragments per glyph for it: 30% more at 8 px per em and 4.5% more at 64 (Noto Sans, counted
on the GPU).

### Measured limits

Measured on 2026-10-08 in headless Chromium 153 on macOS 15 (Apple M3 Max), at a display
scale of 1 and of 2, with Lato and Noto Sans Regular in four colour pairs, against a screenshot of the
same DOM element at its layout position. The mean difference over edge pixels is in 8-bit
sRGB levels (lower is closer); ink is the library's over Chrome's.

| Text, default options                | `geometricPrecision` page, 1× / 2× | Default smoothing, 1× / 2× | Ink       |
| ------------------------------------ | ---------------------------------- | -------------------------- | --------- |
| SDF, 9–24 CSS px                     | 15.5 / 13.7                        | 16.9 / 14.0                | 0.95–1.06 |
| Windfoil, under 162 device px per em | 12.3 / 12.6                        | 11.2 / 11.3                | 0.98–1.02 |
| Windfoil, 162–255 device px per em   | 47.6 / 49.0                        | 16.0 / 16.9                | 0.95–1.01 |
| Windfoil, from 256 device px per em  | 17.7 / 16.7                        | 17.7 / 16.7                | 1.00      |

With `tone: false`, the same Windfoil text at 64 and 128 px measured 44–47 levels where the
defaults measure 14–16 (Noto Sans, black and white, 1×, `geometricPrecision`). With
`pixelSnap`, 13, 16 and 24 CSS px text laid out between pixels went from 29–36 levels to 8–20.

- Only Chrome on macOS was measured. The `'windows'` model and the choices for Linux and
  Android follow Chromium's and Skia's source and were not run; Safari and Firefox were not
  measured.
- From 162 to 255 device pixels per em, Chrome on macOS draws smoothed text whatever
  `text-rendering: geometricPrecision` or `-webkit-font-smoothing: antialiased` ask for. The
  library keeps the exact outline on such pages, so text in that band carries about 0.95 of
  Chrome's ink (third row). A capture whose text all lies in the band can set
  `tone: { model: 'macos' }`.
- At whole-pixel font sizes below about 18 device pixels, Chrome fits glyph heights to whole
  pixels at some sizes: Lato capitals by up to 0.8 px between 9 and 17 px. The library draws
  the font's outline at every size, as Chrome does at fractional sizes.
- At 16 CSS px and below, some sizes sit 1/8 to 1/4 px from Chrome vertically (52 of 416
  measured cells), which costs up to 4.9 levels.
- From 256 device pixels per em, Chrome draws glyphs as paths with four coverage samples per
  pixel. Exact coverage stays 16–21 levels from that on edge pixels, at equal ink.
- One backdrop serves a capture. Text of one capture that stands on several backgrounds is
  toned for the one behind most of it; capture such regions separately for an exact match.
- With Windfoil, an inline SVG layer painted with the text colour is toned like the text.
  Solid and gradient paints keep their exact coverage.
- The `'macos'` outline growth is approximate on a CPU-built atlas (0.26 px sideways and
  0.28 px upwards at 96 px per em, where a GPU atlas gives 0.30 and 0.57), and is cut short
  below about 10 device pixels per em at the default `bakeSize` and `padding`.

## Options

Every option is optional. `DomSdf.options` contains the frozen values supplied by the caller,
not a copy with defaults filled in.

<details>
<summary><strong>All <code>DomSdf</code> options and defaults</strong></summary>

| Option                  | Default              | Description                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layoutEngine`          | `'range'`            | Browser Range layout or Canvas/Pretext layout.                                                                                                                                                                                                                                                                                            |
| `textShaping`           | `'none'`             | Opt-in `'browser'` shaping of retained text runs; see [language support](#optional-language-support).                                                                                                                                                                                                                                     |
| `textBackend`           | `'sdf'`              | Retained SDF coverage or experimental, WebGPU-only `'windfoil'` or `'slug'`.                                                                                                                                                                                                                                                              |
| `svg`                   | `false`              | Capture SVG paths/layers using Range; object options select policy, budget, bitmap rendering and images.                                                                                                                                                                                                                                  |
| `windfoil`              | —                    | Optional outline provider (without one, glyphs are traced from the browser's own rendering and `fallback` defaults to `'sdf-glyphs'`), `'error'`, `'sdf'` or `'sdf-glyphs'` fallback, band tuning and the `sdfBelowPx` size switch for Windfoil.                                                                                          |
| `slug`                  | —                    | Optional outline provider (traced glyphs without one), fallback, band tuning and the `sdfBelowPx` size switch for Slug (or falls back to `windfoil` options when omitted).                                                                                                                                                                |
| `textSelector`          | `[data-text-block]`  | Selector for text capture blocks; the default also matches `data-sdf-block`.                                                                                                                                                                                                                                                              |
| `rectSelector`          | `[data-text-rect]`   | Selector for captured background rectangles; the default also matches `data-sdf-rect`.                                                                                                                                                                                                                                                    |
| `ignoreSelector`        | `[data-text-ignore]` | Selector for excluded subtrees; the default also matches `data-sdf-ignore`.                                                                                                                                                                                                                                                               |
| `includeRootBackground` | `true`               | Capture the root's visible solid background.                                                                                                                                                                                                                                                                                              |
| `colorGlyphs`           | `'emoji'`            | Keep browser colours for emoji; `'all'` tests every glyph for colour-font ink; `'none'` keeps monochrome silhouettes. SDF only.                                                                                                                                                                                                           |
| `extraGlyphs`           | —                    | Characters or whole emoji sequences to reserve for every captured font style. A text glyph the atlas lacks is drawn into it in place when it fits (see [Dynamic text and reflow](#dynamic-text-and-reflow)); otherwise it forces a full atlas rebuild — a main-thread stall that can reach hundreds of milliseconds at large atlas sizes. |
| `sharedAtlas`           | —                    | Caller-owned SDF atlas. Used as-is when it already contains every captured glyph, and not disposed by `DomSdf`. A missing glyph builds a private atlas for that instance. Ignored by Windfoil.                                                                                                                                            |
| `pixelsPerUnit`         | `1`                  | Divide captured X/Y values by this positive scale.                                                                                                                                                                                                                                                                                        |
| `pixelSnap`             | `false`              | Put lines and glyph origins on the pixels the browser paints them on, for flat 1:1 overlays; see [Matching the browser](#matching-the-browser).                                                                                                                                                                                           |
| `textDepth`             | `1`                  | Default text Z.                                                                                                                                                                                                                                                                                                                           |
| `rectDepth`             | `0`                  | Default non-root rectangle Z.                                                                                                                                                                                                                                                                                                             |
| `panelDepth`            | `-1`                 | Default root rectangle Z.                                                                                                                                                                                                                                                                                                                 |
| `bakeSize`              | `96`                 | Canvas font raster size; minimum `16`.                                                                                                                                                                                                                                                                                                    |
| `adaptiveBakeSize`      | `false`              | Retry overflowing SDF atlases at a smaller bake size, down to 16px. Fitting atlases keep their requested resolution.                                                                                                                                                                                                                      |
| `padding`               | `12`                 | Glyph slot padding and SDF pixel range; minimum `2`.                                                                                                                                                                                                                                                                                      |
| `maxAtlasSize`          | `2048`               | Maximum atlas dimension; overflow rejects instead of dropping glyphs. Text, monochrome SVG shapes and colour glyphs pack in rows of their own.                                                                                                                                                                                            |
| `atlasMode`             | `'auto'`             | `'gpu'`, `'cpu'`, or GPU-first `'auto'`.                                                                                                                                                                                                                                                                                                  |
| `cpuWorker`             | `true`               | Run CPU encoding in a cancellable Worker when available; `false` uses the main thread.                                                                                                                                                                                                                                                    |
| `fill`                  | —                    | TSL callback returning a linear RGBA fill inside each letter; works with every text backend and `createWindfoilShapes`.                                                                                                                                                                                                                   |
| `vertex`                | —                    | TSL callback returning a local `vec3` corner position for glyphs and text decorations; works with every text backend and `createWindfoilShapes`.                                                                                                                                                                                          |
| `tone`                  | on                   | Text ink at the weight the browser gives it, for both backends: `{ strength, backdrop, model }`, or `false` for exact coverage; see [Matching the browser](#matching-the-browser).                                                                                                                                                        |
| `outline`               | —                    | Optional outline with local-unit `width`, `color`, and `opacity`, drawn from an SDF on every text backend.                                                                                                                                                                                                                                |
| `dropShadow`            | —                    | Optional hard shadow with local-unit `offsetX`/`offsetY`, `color`, and `opacity`, drawn from an SDF on every text backend.                                                                                                                                                                                                                |
| `threshold`             | `0.5`                | Sampled SDF edge threshold: the baked outline. Left unset, colour glyphs keep `0.515`, which hides the faint shading around some emoji. Text weight comes from `tone`.                                                                                                                                                                    |
| `shadowCutoff`          | `0.5`                | Coverage needed for a glyph to contribute to the shadow silhouette.                                                                                                                                                                                                                                                                       |
| `shadowFloor`           | `0.24`               | Brightness of a fully shadowed captured rectangle, from `0` to `1`.                                                                                                                                                                                                                                                                       |
| `quality`               | `'standard'`         | `'high'` adds four-tap sampling, mipmaps, and up to 4× anisotropy, for minified or steeply angled SDF text.                                                                                                                                                                                                                               |
| `stemDarkening`         | `0`                  | Extra weight in screen pixels for SDF glyphs under 16 device pixels per em, added on top of `tone`.                                                                                                                                                                                                                                       |
| `castShadow`            | `true`               | Whether the glyph mesh casts into shadow maps; `false` skips one text draw per shadow-casting light.                                                                                                                                                                                                                                      |
| `side`                  | `FrontSide`          | Face culling for the generated glyph planes; use Three's `DoubleSide` for flipping text.                                                                                                                                                                                                                                                  |
| `motion.enabled`        | `true`               | Enable TSL motion.                                                                                                                                                                                                                                                                                                                        |
| `motion.mode`           | `'slide-up'`         | `none`, `opacity`, `scale`, `offset`, four slide directions, or `all`.                                                                                                                                                                                                                                                                    |
| `motion.strength`       | `18`                 | Non-negative motion distance.                                                                                                                                                                                                                                                                                                             |
| `motion.speed`          | `1.35`               | Non-negative speed multiplier.                                                                                                                                                                                                                                                                                                            |
| `motion.stagger`        | `0.045`              | Non-negative per-glyph sequence offset.                                                                                                                                                                                                                                                                                                   |
| `reflowable`            | `false`              | Retain the capture so `reflow(width)` can wrap without the DOM.                                                                                                                                                                                                                                                                           |
| `cjkLineBreaking`       | `false`              | Add CJK reflow breaks without artificial spaces, including across inline elements.                                                                                                                                                                                                                                                        |
| `rtlReflow`             | `false`              | Capture CSS direction and glyph widths for RTL word reflow; Range engine only.                                                                                                                                                                                                                                                            |
| `reshape`               | —                    | App-supplied text transformation; see [Optional language support](#optional-language-support) for Range constraints.                                                                                                                                                                                                                      |
| `selectable`            | `false`              | Add `.sdf-selectable` to the source; the app supplies overlay positioning and selection CSS.                                                                                                                                                                                                                                              |
| `observe`               | `true`               | Observe root resize, subtree mutation, and completed font loads.                                                                                                                                                                                                                                                                          |
| `signal`                | —                    | Abort initial and later builds.                                                                                                                                                                                                                                                                                                           |
| `onError`               | —                    | Handle observer-scheduled rebuild failures.                                                                                                                                                                                                                                                                                               |

</details>

Text shown near 1:1 is closest to the browser with the defaults: `quality: 'standard'`, the
baked `threshold`, no `stemDarkening`, and its weight left to [`tone`](#matching-the-browser).
`quality: 'high'` is for minified or steeply angled SDF text, where its four taps and mipmaps
steady the edges; at 1:1 its wider filter draws small text lighter than the browser does. Raise
`bakeSize` and `padding` together for unusually large or oblique text, and adjust `threshold`
only slightly around its default. `threshold`, `stemDarkening` and `quality` are ignored by
active Windfoil coverage but still configure a requested whole-capture SDF fallback and the
SDF companion of `fallback: 'sdf-glyphs'` and `sdfBelowPx`; `tone` applies to both backends.

### Text effects, custom fills, and vertex hooks

`DomText.create()` (`DomSdf.create()`), `Text`, `SdfTextMaterial`, and `createWindfoilShapes`
accept custom TSL `fill` and `vertex` callbacks alongside SDF `outline` and `dropShadow` effects:

```ts
import { mix, sin, time, vec3, vec4 } from 'three/tsl'
import { DomText } from 'ultra-text'

const text = await DomText.create(renderer, source, {
  padding: 24,
  outline: { width: 1.2, color: '#cafae2', opacity: 0.8 },
  dropShadow: { offsetX: 5, offsetY: -6, color: '#030c09', opacity: 1 },
  fill: ({ position }) => {
    const wave = sin(position.x.mul(0.02).add(time)).mul(0.5).add(0.5)
    return vec4(mix(vec3(0.1, 0.8, 0.5), vec3(1, 0.25, 0.08), wave), 1)
  },
  vertex: ({ position, center, sequence }) => {
    const bob = sin(time.mul(2).add(sequence.mul(0.35))).mul(2)
    return position.add(vec3(0, bob, sin(center.x.mul(0.015).add(time)).mul(4)))
  },
})
```

The callbacks build TSL graphs once per material, including when a material is cloned or upgraded
from static to animated by `setMotion()`; they do not run in the animation loop.

`fill` receives `uv` (normalized glyph quad coordinates),
`position` (animated capture-local position), `color` (per-pixel linear RGB), `colorWeight`
(0 for CSS-tinted ink, 1 for baked colour ink), and `glyphIndex`
(the drawable index, which can change after a rebuild; layered Windfoil and its SDF companion
share a capture-order ordinal, so it stays continuous across `sdfBelowPx`). It is a whole number
at each pixel of a glyph, so `array.element(int(glyphIndex))` reads that glyph's entry. Return a `vec4`
containing linear RGB and an opacity multiplier. Glyph coverage, DOM opacity, motion, and block
clipping remain applied. Custom opacity also masks scene shadows. Use TSL `time`, uniforms, noise,
or `texture(myTexture, uv)` for animated, procedural, or textured letters; the caller owns
those uniforms and textures. SDF UVs include the glyph's baked padding. The fill hook works
with SDF, Windfoil, and Slug; it does not shade decorations, outlines, or drop shadows. With
[`tone`](#matching-the-browser) on, filled ink is weighted for the fill's own colour at each
pixel; pass `tone: false` when a fill paints artwork, such as a texture, rather than ink. On SDF,
style text while retaining emoji colours with `vec4(mix(myGradient, color, colorWeight), 1)`;
a fill that ignores `color` also recolours those emoji. Windfoil and Slug apply the fill to
foreground layers; fixed solid and gradient paints retain their own colours and alpha. CSS text alpha
and effective opacity multiply SDF colour glyphs once; outline, drop-shadow and scene-shadow
colours use the SDF silhouette.

`vertex` receives `position` (the rendered local `vec3` corner after built-in motion, `sdfTrim`
tightening, `outline`/`dropShadow` padding, and Windfoil/Slug edge skirts), `center` (un-animated
local `vec2` glyph anchor, shared across shaped runs, paint layers, companions, and decorations),
`uv` (corner UV in `0..1`, including SDF trim or effect padding when active), `glyphIndex`
(drawable instance index), `sequence` (per-line stagger index), `rect` (`[x0, y0, x1, y1]` glyph
bounding box in capture-local coordinates), and `clip` (`[x0, y0, x1, y1]` block clip rectangle in
capture-local coordinates). Return the final local `vec3` corner position. Block clipping reads the
pre-hook position, so 3D waves, twists, and Z-extrusions are not clipped at a block's static
bounds; size-switch rejected quads collapse after the hook. `vertex` runs on SDF, Windfoil, Slug,
their SDF companion and effect underlays, `DomText`/`DomSdf` text decorations, and
`createWindfoilShapes`.

Outlines and drop shadows are drawn from an SDF on every text backend. On `'windfoil'` and
`'slug'`, glyphs drawn from outlines keep their analytic fill and take their ring and shadow from
an SDF underlay: those glyphs are also baked into the SDF companion atlas, and one extra draw at
the text's own render order lays the ring and shadow under the fill, blended to match
single-pass SDF text (no light seam inside the ring, no gap at concave corners, no shadow through
see-through ink; exact without `tone`, and for opaque ink with it). Glyphs without outlines and
size-switched glyphs below `sdfBelowPx` are plain SDF text with their effects. The ring keeps SDF
edges under magnification, and an outline of width or opacity 0, or a shadow of opacity 0, draws
and bakes nothing. For a 77-glyph paragraph (headless Chrome 156, Apple M3 Max), Windfoil alone
holds no atlas and 45,840 bytes in one draw; with an outline it adds a 1072×472 companion atlas,
for 551,824 bytes in two draws. The underlay sorts with its own text, but the colour and fallback
parts of separate texts sort by render order rather than depth, and with
`renderer.sortObjects = false` the underlay draws over its fill. Width and offsets use local units (CSS pixels divided by `pixelsPerUnit`); positive Y points up.
An empty `outline` uses a black, fully opaque, 1-unit outline. An empty `dropShadow` uses
black at 0.5 opacity with offsets `(2, -2)`. Opacity is clamped to `0..1`; widths must be
non-negative and all numeric effect options must be finite. Effects remain clipped to the
marked text block, so leave room around its content when an effect should extend outward.

The outline expands outward and is limited to slightly less than half the atlas pixel
range, scaled to the glyph size. Increase `padding` to bake a wider usable field. Sampling
is clamped to each atlas cell to keep shifted lookups within that glyph. Drop
shadows are hard silhouettes with antialiased edges, without blur. They appear in the text
plane; `castShadow` still controls scene shadow casting independently.

Use `quality: 'high'` to apply the same four-sample antialiasing to fills, outlines, and drop
shadows. Thin outlines expose the baked contour more readily than plain fills; for large
display text, start with `bakeSize: 192` and `padding: 24`, as in the text lab. A denser bake
uses more atlas memory and takes longer to build. CPU and GPU fields can still differ in
their contour reconstruction; increasing canvas resolution alone does not remove atlas steps.

Solid CSS `underline`, `overline`, and `line-through` decorations are captured automatically,
including ancestor decorations, color, thickness, and underline offset. They use a separate
instanced batch, share glyph clipping and motion, and follow `reflow()`. Default/from-font
thickness and line positions use font-metric approximations; skip-ink, wavy, dotted, dashed,
and double decorations are not reproduced. The captured decoration metadata is available
on `GlyphLayout` for lower-level renderers; `DomSdf` owns the automatic decoration batch.

Open the interactive [text lab](https://ultra-text.makio.io/text-effects) to compare
worker/main-thread CPU baking with WebGPU and toggle each visual effect.

### Experimental Windfoil and Slug backends

Browsers expose the selected CSS font description, not its outline bytes. Supply an app-owned
resolver that returns OpenType-style, Y-up quadratic outlines, or omit it to trace the browser's
own glyphs:

```ts
import { DomText, type WindfoilOutlineProvider } from 'ultra-text'

// No outlineProvider: outlines traced from the browser's own glyphs at 256 px per em
const traced = await DomText.create(renderer, source, { textBackend: 'slug' })

// Exact outlines from an app-owned resolver
const outlineProvider: WindfoilOutlineProvider = (request, signal) =>
  myFontRegistry.resolveQuadraticOutline(request, signal)

const domText = await DomText.create(renderer, source, {
  textBackend: 'windfoil', // or 'slug'
  windfoil: { outlineProvider, fallback: 'sdf' },
})
```

Without an `outlineProvider`, each `DomSdf` traces its glyphs from the browser's own rendering.
Once `document.fonts.load()` resolves, a glyph is drawn at 256 px per em on the SDF bake's
in-document canvas (the captured canvas font with its stretch and kerning, no font smoothing),
and its half-coverage contour is fitted with quadratic curves. Against Noto Sans Regular's own
outlines (94 printable ASCII glyphs, headless Chrome 156 on macOS, Apple M3 Max), traced outlines
stay within 0.006 em (mean deviation 0.0002 em), keep every glyph's contour count and winding,
and hold 1.3 times the font's curves (Slug buffers of 381 kB against 180 kB from exact outlines).
Edges stay analytic under magnification but follow that raster, not the font file; supply a
provider for exact edges. Font-variation and feature settings are not applied, `fallback`
defaults to `'sdf-glyphs'`, and colour glyphs, fonts the canvas rejects and glyphs whose ink
overflows their box are drawn by the SDF companion. Tracing runs on the main thread in slices of
about 8 ms, about 0.5–0.6 ms per Latin glyph and 1.1–1.2 ms per CJK glyph, and is cached per
instance; `rebuild({ atlas: true })` and webfont loads trace again. Other rasterizers and
browsers are unmeasured. A provider that is not a function rejects before anything is allocated.

`textBackend: 'slug'` uses an extrema-split dual-ray Slug evaluator (`slug` options, or `windfoil`
options if `slug` is omitted) with endpoint-first `[p1, p3, p2]` storage, orthogonal degenerate
segment culling, convex-hull winding bypass, and fine-grained 2-word band headers (`targetPiecesPerBand: 4`
by default). It shares the same outline provider contract, `fallback` modes, `sdfBelowPx` size
switch, colour layers, tone weighting, outline and drop-shadow underlay, and Pretext/Range
reflow as `'windfoil'`.

The provider owns font fallback and variation mapping. It must emit every closed contour edge,
promote lines and convert cubics to quadratics, preserve contour/hole winding for the nonzero
fill rule, and return the glyph ink bounding box in the same font-unit coordinates. The
placeholder resolver above is illustrative; this package does not ship a font parser. Windfoil
keeps read-only curve/row buffers instead of a coverage texture. Each row band stores its curves
twice, sorted from either side, so a fragment integrates only the curves on its own side of the
band; `textStorageBytes` includes both copies. Adjacent band windows share their rounded
boundary and include neighbouring bands when necessary, keeping solid interiors continuous
under extreme magnification. Already monotone curves bypass temporary subdivision arrays
during preparation. A null outline either rejects or falls the whole capture back to SDF;
`fallback: 'sdf-glyphs'` (the default without an `outlineProvider`) retains available outlines
and adds one SDF companion for missing glyphs, whose colour emoji follow `colorGlyphs`. Lower
`targetPiecesPerBand` values trade more duplicated storage and preprocessing for less fragment
curve work; higher values do the reverse. Cache resolved outlines, honor the abort signal, and
avoid per-glyph network fetches. Requests using automatic optical sizing are separated by CSS font
size. Upstream describes the algorithm as novel and advises adopters to assess patent risk; see
[texel-org/windfoil](https://github.com/texel-org/windfoil) and the included
[third-party notice](./THIRD_PARTY_NOTICES.md).

The mixed mode paints its SDF companion above Windfoil, with decorations on top. Overlapping
glyphs or SVG paints split across those batches can therefore change painter order; use
whole-capture `fallback: 'sdf'` when that ordering must match the source exactly.

Windfoil text takes the same [`tone`](#matching-the-browser) as SDF text; `tone: false`
draws the exact outline area.

#### Size switch: SDF while small (experimental)

```ts
const domText = await DomText.create(renderer, source, {
  textBackend: 'windfoil',
  windfoil: { outlineProvider, fallback: 'sdf-glyphs', sdfBelowPx: 96 },
})
```

`windfoil.sdfBelowPx` keeps small text on the cheaper SDF path and draws a glyph with
analytic Windfoil coverage once it is shown large. Plain single-paint outline glyphs, including
filled SVG paint layers, are also baked into the SDF companion atlas. For every glyph and every
render pass, the GPU measures the projected em: the font size times the largest stretch of the
local-to-pixel mapping at the glyph's centre, in render-target (device) pixels, so a 48 CSS px
heading at DPR 2 seen 1:1 measures 96. Below `sdfBelowPx` the glyph comes from the atlas; at or
above it, from Windfoil. Nothing runs on the CPU per frame, and shadow maps and other passes
decide with their own camera and resolution. `fallback` only governs glyphs without an outline,
and a value that is not a positive finite number rejects the build.

Setting it to `bakeSize` (96 by default) never magnifies the atlas beyond one texel per pixel;
lower both together, including with `adaptiveBakeSize`. The switch is immediate. Both sides
draw the font's own outline under the same tone, so little moves at the threshold: with Lato
and Noto Sans at the default bake, in Chromium 153 on an Apple M3 Max, the SDF companion
carried 0.99–1.00 of Windfoil's ink at 24 and 32 CSS px (1× and 2×), and its edges sat within
about 0.1 px of Windfoil's at 96 px per em.

Colour and layered glyphs and emoji always use Windfoil; glyphs without an outline always use
the companion, as `fallback` allows. Fills keyed on `uv` change at the switch, so key them on
`position` or `glyphIndex`. The companion costs one more atlas bake (about 1.1 MiB for
printable ASCII at the default bake) and one more draw per pass, and very large glyph sets can
exceed `maxAtlasSize` and reject the rebuild. The outline provider must return the face the
browser renders, or the switch shows a different design. Glyphs split between the two batches
follow the painter-order caveat above.

### SVG shapes (experimental)

`svgToWindfoilOutlines` converts SVG markup, a live SVG element, SVG path records, or the
structural result of Three's `SVGLoader.parse()` into closed quadratic outlines. It is
synchronous and tree-shaken when unused. The smaller `windfoilOutlineFromSvgPaths` accepts
DOM-free path records in workers and Node without `DOMParser`.

```ts
import { svgToWindfoilOutlines, createWindfoilShapes } from 'ultra-text'

const converted = svgToWindfoilOutlines(
  '<svg viewBox="0 0 24 24"><path d="M12 2L22 22H2Z"/></svg>',
  { onWarning: (warning) => console.warn(warning.code, warning.message) },
)
const outlines = { triangle: converted.outline }
const shapes = await createWindfoilShapes(renderer, outlines, [
  { shape: 'triangle', x: 20, y: 20, size: 64, color: '#fc0' },
])
scene.add(shapes)
shapes.setInstances([{ shape: 'triangle', x: 40, y: 20, size: 96 }])
// Later: remove it from the scene and release its geometry, materials and storage.
shapes.dispose()
```

Instance `x` places outline x = 0, and `y` places its descender line (outline y = `descent`)
in local units. The scale is `size / unitsPerEm`.
`setInstances()` changes positions, colours, clipping and counts while keeping preprocessed
outlines. It validates the complete input before updating and reuses geometry buffers when
the expanded paint-layer count is unchanged.
Shapes are static by default (mode `'none'`): `setMotion()` updates uniforms, and the first other
mode swaps in an animated material once. The handle is a `Group` with `mesh` and frozen
`stats`; disposal is idempotent. It requires WebGPU and does not allocate an SDF atlas.
Instance `clip` rectangles work in both compositing modes; outline `clipBox` requires
`compositing: 'shader'`.

Separate calls using the same outlines record or `Map`, renderer, compositing mode and band
setting share prepared curves, layer indexes and GPU storage while any handle remains alive.
Keep the outlines container to reuse that work; newly allocated containers build independently.
Each call checks the outline contents, so edits build a new resource set while existing handles
retain their original artwork. Geometry, materials and motion remain independent. Disposing the
last handle releases the shared resources. A reuse reports `stats.preprocessMs: 0`;
`stats.storageBytes` reports each handle's full logical storage, including shared buffers, so
adding those values does not measure unique GPU allocation.

Shape handles accept `compositing: 'shader'`: one quad per instance composites its paint layers
top-down in the fragment shader and stops once a pixel is opaque, instead of blending one quad per
layer. Each artwork also gets an adaptive layer index: a quadtree whose cells list, top-down, only
the layers that can change a pixel there, classified exactly against the curves the shader
integrates. A pixel walks the deepest cell its footprint fits, so close zoom uses small cells. It
skips layers whose fill cannot reach the cell, takes full coverage without integrating from a layer
that covers the whole cell, and stops below the first such opaque one. The result matches walking
every layer, within 1/255 where a covering layer's integral would return 1 − ε. Composited layers
that a pixel crosses in fewer pieces along columns, typically wide and short ones, are integrated in
vertical bands. Outlines may hold up to 1024 layers, so large artwork composites in one quad.

Prefer shader compositing for densely layered or magnified artwork. On one Apple M3 Max whose GPU was
shared with other work, as ranges over four timing estimators and two sessions:

- On the 304-layer Ghostscript tiger in a 2048² frame, it took 1.5–2.2× less GPU time than the
  previous 16×16 cell index at every size from 256 to 16384 px tall (2.02 against 4.24 ms at the
  largest). Against upstream windfoil at its best band setting it was 2.2–5.5× faster from 1024 px
  up, and level at 256 px.
- On the demo owl it took 1.0–1.5× less time than that index.

Per-layer quads (`'layers'`) still draw a thumbnail of detailed artwork faster: 1.3–1.6× on the tiger at
256 px. There, few pixels each walk several exact integrals in sequence, while per-layer quads run
them in parallel.

The index is built once per outline on the main thread, and the larger fragment shader compiles
more slowly. On the demo, switching to the three animals cost about 80 ms more for their indexes
(about 110 kB each) than with the previous grid. A cold first view also compiled 80–160 ms longer, on
top of the shader-compositing pipeline already costing about 90 ms more than per-layer quads. That was
measured on the same machine while other work loaded its CPU and GPU. Colour glyphs in DOM text get a
much smaller index. A table past the device's storage-binding limit falls back to one cell per glyph.

With shader compositing, instance opacity applies to the whole artwork, layers blend in encoded sRGB,
plain outlines draw as one foreground layer, and `stats.instances` counts drawn instances rather than
layers.

Conversion supports all SVG path commands, basic shapes, transforms, same-document
`use`/`symbol`, nested viewports, and nonzero/evenodd contour winding. Curves are approximated
within `tolerance` (default `unitsPerEm / 4000`), with bounded subdivision and warnings when
that bound cannot be met. Connected SVG elements can use `computedStyle: true`; markup does
not load stylesheets or network resources. `layers` preserves painter order and solid,
foreground, and supported gradient paints. `outline` is the merged monochrome result.
Self-intersecting evenodd contours warn and fall back to nonzero; pre-resolve them with an
SVG simplifier when exact parity is required. Stroke expansion, masks, filters, patterns and
arbitrary clipping are not supported by this converter; inspect `warnings` or use
`unsupported: 'error'` and `strokes: 'error'`.

### Inline SVG

```ts
const text = await DomSdf.create(renderer, root, {
  svg: { unsupported: 'error', maxPathData: 1_000_000 },
  motion: { enabled: false, mode: 'none' },
})
```

`svg: true` opts in to SVGs inside text blocks and standalone SVGs inside the capture root.
The object form also accepts a `selector` (default `svg`). It requires Range layout and makes
`collectDomSnapshot` asynchronous. SVG paint layers share the text atlas, clipping, shadows
and motion; every layer of one icon moves together. CSS colours, fills, strokes, basic shapes
and element transforms are captured at rebuild time. SVG text and foreign content, external
references, filters, masks and arbitrary clip paths are not reproduced. `unsupported` defaults
to `'skip'`; `'error'` reports unsupported content. CSS/SMIL animation requires explicit
rebuilds. Root rotation/skew is rejected or skipped because capture layout is axis-aligned.

The SDF route uses native `Path2D` for exact fill rules, strokes, joins and dashes. Filled SVGs
can use Windfoil; stroke layers or ambiguous evenodd outlines follow `windfoil.fallback`.
`svg: { render: 'bitmap' }` stores all authored paint colours in a single SDF slot per SVG.
`images: true` also captures decoded images that pass a canvas taint probe; the library never
fetches their URLs. Capture images after loading them. Bitmap shapes remain colour candidates
regardless of the text `colorGlyphs` option. Bitmap capture composites nested SVG opacity
groups before rasterization, then applies root and DOM opacity once. Baked paint alpha still
uses the SDF silhouette: alpha below 50% is discarded, and interior alpha is hardened.

`stats.glyphs` counts text glyphs, `stats.shapes` counts SVG paint-layer instances, and
`stats.fallbackGlyphs` counts text glyphs without a Windfoil outline, drawn by the SDF
companion, and `stats.switchableGlyphs` counts instances the size switch can draw either way.
Atlas dimensions and `atlasTexture` describe that companion in mixed mode. `textStorageBytes`
includes curve, paint, composite-layer and companion texture storage. No GPU work runs on a steady frame
except rendering; capture and rasterization happen during rebuilds.

### Colour layers and SVG emoji

A `WindfoilGlyphOutline` can contain up to 1024 `layers`, each with closed `quadratics`, an
optional tight `bbox`, and a `paint`. `{ type: 'foreground' }` uses the captured CSS colour;
`{ type: 'solid', color: [r, g, b, a] }` uses sRGBA components in 0–1. Nonempty top-level
quadratics form an initial foreground layer. All layers share one glyph's motion and
stagger index. Layer opacity multiplies captured text alpha once. In the default
`compositing: 'layers'` mode they use ordinary painter-order blending; overlapping partially
transparent layers apply opacity separately and abutting antialiased edges may show seams.

```ts
import { createSvgEmojiOutlineProvider } from 'ultra-text'

const outlineProvider = createSvgEmojiOutlineProvider({
  text: fontOutlineProvider,
  resolve: async (cluster, signal) => loadAppEmojiSvg(cluster, signal),
  em: { unitsPerEm: 1000, ascent: 800, descent: -200 },
})
const text = await DomSdf.create(renderer, root, {
  textBackend: 'windfoil',
  windfoil: { outlineProvider, fallback: 'sdf-glyphs' },
})
```

The application owns the art and loading. `resolve` receives the original complete cluster
and returns SVG text or `null`; no artwork or network client ships in the library. The helper
caches converted emoji, centres them in the measured platform advance, and respects aborts.
Its cache uses Twemoji's filename convention: remove FE0F only for clusters without ZWJ,
then join lowercase hexadecimal code points with hyphens. FE0E requests use the text font.
Provide `em.descent` to select the reference baseline explicitly, or let the text provider
supply its metrics. That baseline sits on the captured text baseline; where a capture has
none, the bottom of the em box sits on the bottom of the text box. Keep emoji artwork
licences and attribution with your assets.
Translucent SVG groups containing multiple paints cannot be flattened faithfully into layers;
the helper returns `null` for those SVGs so the configured fallback can render them.

The demo's emoji comparison preserves the platform font instead of substituting SVG
artwork. For Windfoil it vectorises each native emoji bitmap in the browser: regions of
smoothly varying colour become layers with curve-fitted outlines, flat regions use solid
paints, and `fill` paints the shaded ones from colour sheets cut from the same bitmap, with
matching layout and glyph metrics. The first frame shows the traced bitmap; the layers
replace it once the page is idle. Hard edges are analytic at any zoom, while gradients,
glows, see-through artwork and detail about two texels wide keep the bitmap's softness.
No traced artwork ships with the package.

Windfoil also accepts `linear`, `radial` and `sweep` gradient paints. Stops contain `offset`
and sRGBA `color`; `extend` is `'pad'`, `'repeat'` or `'reflect'`. Paint coordinates are in
outline font units; an optional affine transform maps the gradient into those units.
Linear gradients use `p0`, `p1` and optional `p2`; radial gradients use `c0`, `r0`, `c1`, `r1`;
sweeps use `center`, `startAngle` and `endAngle` in degrees. SVG linear/radial gradients are
imported, including stop opacity and gradient transforms. Sweep gradients are authored through
the paint API because SVG has no native sweep-gradient element. Gradient interpolation and
shader layer compositing use encoded sRGB, then convert the resulting colour to linear RGB.

Opt-in `windfoil: { outlineProvider, compositing: 'shader' }` composites all layers of each
colour glyph before applying text alpha. It gives correct whole-glyph group opacity and walks
only the layers that can reach each pixel, stopping once it is opaque; nested SVG opacity groups
are not represented.
A glyph-local `clipBox: [xMin, yMin, xMax, yMax]` uses analytic
rectangle coverage in `DomSdf` and automatically selects this composite path for that glyph, including
base-only outlines and captures using `compositing: 'layers'`. Colour glyphs use their own instanced
batch, and ordinary glyphs retain their simpler shader. The default remains `'layers'`;
measure both modes on your target hardware for dense or large artwork. Shape handles support
layer paints and gradients and accept the same `compositing` option.

An application adapting COLRv1 data must expand `PaintColrLayers` and `PaintColrGlyph` into
ordered layers, bake outline transforms into the paths, and put paint-only transforms in
the paint's `transform`. Only source-over composition is supported; map a font ClipBox to
the outline's `clipBox`. Other composite modes, arbitrary clip paths, masks, filters and
variable paints need an application fallback. Coincident antialiased edges can show seams;
gradient output is not dithered.

## Text backends and atlas modes

SDF colour glyphs use an optional sRGB RGBA band beside the single-channel distance field.
Canvas extraction runs once during the atlas rebuild on the main thread and works with GPU,
CPU, CPU Worker and WebGL2 fallback atlas generation. The band uses about 80 KB per emoji at
`bakeSize: 96`, plus roughly one third for `quality: 'high'` mipmaps. Mixed shaped runs also
place their text in the band. `stats.textStorageBytes` includes these GPU texels; the retained
CPU upload copy is excluded. Captures without verified colour ink keep the original shader.
`stats.colorGlyphs` counts captured text glyphs with colour ink, so a mixed browser run counts
once. Low-level callers pass `atlas.colorLayer`, `atlas.bakeSize` and `atlas.shapeTop` to
`SdfTextMaterial` and dispose the full atlas. `shapeTop` marks the atlas rows of monochrome SVG
shapes, which keep their exact coverage while text takes the tone: keep it with the other
fields wherever an atlas is copied or restored from stored bytes.
Apple Color Emoji is a bitmap font whose largest strike is 160 px. In Chrome on macOS, a larger
`bakeSize` resamples that bitmap and ripples emoji edges once magnified; bake large emoji at 160.

Colour extraction uses a byte visitation grid and dilates from the ink boundary. Temporary
classification/queue arrays use five bytes per band texel, in addition to the four-byte RGBA
output.

An atlas made with `colorGlyphs: 'none'` or an older library version has untested slots.
Such an atlas is not reused for colour candidates: the capture builds a private atlas.
Rebuild atlases stored by an earlier version: the bake no longer carries the platform's font
smoothing, and the colour band's alpha now tells colour ink (1) from text ink (0).
Whole emoji sequences use different keys from their former components, so rebuild shared
atlases that were prepared per code point. Each sequence needs roughly a 1.2 em square slot.

`textBackend` chooses retained coverage. `atlasMode` only changes SDF generation:

`DOM → layout snapshot → Canvas glyph mask → SDF atlas → instanced geometry + TSL materials`

The transient mask uses deterministic shelf and skyline candidates across a bounded search
of aligned widths. Glyphs are never rotated, and the smallest tested used area is retained.

- `gpu` requires a real `WebGPUBackend` and fails if one is unavailable, if the device's
  limits cannot hold the passes (workgroup size, storage buffers per stage, two of them in the
  fragment stage, the atlas's jump-flood buffers at 8 bytes per texel and its glyph-mask copy
  at 4 bytes per texel in 256-byte rows, or its largest 2D texture), if the backend cannot copy
  the mask into a buffer, or if the device reports an error for them. The passes read the mask
  from that buffer, so none of their pipelines samples a texture. It runs on
  compatibility-mode devices as well as core ones. The passes are WGSL compute and render
  passes on the renderer's own device, compiled once per device, and the atlas texture is an
  `ExternalTexture` the atlas owns.
- `cpu` runs an exact Euclidean distance transform and uploads an R8 `DataTexture`.
  By default the transform runs in a short-lived module Worker; `cpuWorker: false` runs it
  on the main thread. Both modes produce identical bytes.
- `auto` tries the GPU path first, then falls back to the CPU path in each of those
  cases, including when an atlas is too large for the GPU path.
- `textBackend: 'windfoil'` resolves quadratic outlines, splits them into monotone pieces,
  files horizontal row bands, and evaluates analytic coverage per fragment. Beauty and
  shadow masks reject fragments outside the block before integrating curves.

Both SDF modes consume the same Canvas glyph mask and produce the same retained atlas.
Windfoil has a separate lifecycle. It reports no atlas texture unless the opt-in mixed mode or size switch has an SDF companion.

Plain text glyphs draw only the part of their quad where the distance field is not empty:
`rasterizeGlyphAtlas` records that box as `GlyphSlot.support`, `createGlyphGeometry` writes it
per glyph as the `sdfTrim` attribute, and `SdfTextMaterial` shrinks each quad to it, which
leaves about 60% fewer fragments for the same ink. Quads stay whole with outlines or drop
shadows, with run motion, and over mipmapped atlases (`quality: 'high'` DomSdf captures). A
custom position graph that places corners from `positionGeometry` itself should delete
`sdfTrim` from its geometry; code that rewrites `sdfUvRect` to show another glyph keeps whole
quads for those instances unless it rewrites `sdfTrim` with it.

The HTML/3D demo's SDF mode explicitly uses CPU atlases to reduce first-use GPU compilation for its
small document; `?atlas=gpu` compares the GPU path. The package default remains `auto`.

A GPU bake records the upload, the seed and jump-flood compute passes and the resolve in one
command buffer. The shader module and its pipelines are made on the device's first atlas and
kept for the device's lifetime, so later bakes and atlas patches only allocate their buffers,
which they destroy once the device has accepted the submission; a `DomSdf` makes them before it
reads the DOM, and the device compiles them meanwhile. When only a WebGPU atlas will read the
glyph mask (no colour candidates, `atlasMode` other than `'cpu'`, an initialized WebGPU
backend), the mask is drawn on a GPU-backed canvas, which skips the software canvas's set-up on
a page's first bake and is copied on the GPU; the CPU fallback of a failed GPU bake then reads
it back slowly. On Apple M3 Max with headless Chrome 156 (two back-to-back pairs on a lightly
loaded machine, with the comparison benchmark below), these and the capture fixes below (a faster layout
signature, requests sorted by code unit instead of `localeCompare`) took the first frame of a
1,000-glyph paragraph from 58.4–58.7 to 41.8–42.3 ms and of 200 labels from 64.3–66.4 to
46.1–46.8 ms, an edit of 10 letters from 6.0–6.2 to 4.8–5.1 ms and one adding a never-drawn
letter from 12.3 to 7.9–8.0 ms (GPU atlas), with the same rendered pixels.

`stats.textStorageBytes` is retained backend payload only. It excludes geometry, Canvas backing
stores, pipelines, provider caches, and transient bake memory; GPU SDF seeds use 16 bytes and
the glyph-mask copy 4 bytes (rows padded to 256 bytes) per atlas texel while a bake is active,
and the mask's upload texture, another 4 bytes per texel, lives only until it is copied. CPU
encoding uses one 4-byte-per-texel working grid plus `28 × height + 8` bytes of column scratch,
excluding the RGBA input, its alpha and the R8 output. DOM capture and the Canvas mask still
run on the main thread, and so does the mask's `getImageData` readback for colour candidates and
CPU atlases. CPU workers receive the mask's RGBA
pixels, take their alpha and transfer the encoded bytes back; they terminate on completion or
cancellation and preserve the previous content during transactional rebuilds. If Workers are unavailable or blocked by
CSP, baking falls back to the synchronous CPU encoder. A cancellation never starts that
fallback. Ship the generated worker asset with the package and allow it in `worker-src`.
The GPU path is unchanged and does not create a CPU worker. Latency- and memory-constrained
apps should cap `maxAtlasSize`, prefer strict `atlasMode: 'gpu'`, reserve known characters,
and retain native UI if WebGPU initialization fails:

```ts
const hud = await DomSdf.create(renderer, source, {
  atlasMode: 'gpu',
  maxAtlasSize: 1024,
  extraGlyphs: '0123456789.%+-/ms',
  observe: false,
  castShadow: false,
  motion: { enabled: false, mode: 'none' },
})
```

## Public API

Import only from the package root; deep imports are not part of the supported API.
[`src/index.ts`](https://github.com/Makio64/ultra-text/blob/main/src/index.ts)
defines that boundary, and
[`src/types.ts`](https://github.com/Makio64/ultra-text/blob/main/src/types.ts)
defines its public data contracts.

| Export                | Purpose                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `DomText`, `DomSdf`   | Retained capture, atlas, geometry, observers, motion, rebuilds, and disposal.                   |
| `collectDomSnapshot`  | Capture typed DOM layout data; sync for plain Range; async for Pretext, browser shaping or SVG. |
| `rasterizeGlyphAtlas` | Wait for fonts and create the packed transient Canvas 2D glyph mask.                            |
| `buildSdfAtlas`       | Build a GPU or CPU SDF atlas from the raster mask.                                              |
| `SdfTextMaterial`     | Standalone TSL SDF text material; `motion: false` builds it static.                             |
| `createGlyphGeometry` | Build static instanced glyph geometry.                                                          |
| `createRectGeometry`  | Build one instanced rectangle batch for a shadow-receiver state.                                |
| `createRectMaterial`  | Build the lit or unlit TSL rounded-rectangle material; `DoubleSide` draws in one pass.          |
| `reflowSnapshot`      | Re-wrap a retained snapshot without reading the DOM.                                            |

`DomText` (and its backward-compatible alias `DomSdf`) extends `THREE.Group` and exposes `width`,
`height`, `stats`, and `atlasTexture`, plus `setMotion()`, `reflow()`, `rebuild()`, and `dispose()`.
`stats.textBackend` reports the active path. `atlasMode` is null for pure Windfoil; mixed mode reports its companion atlas, and
`textStorageBytes` estimates retained texture or curve/row storage. `atlasTexture` is also
null under pure Windfoil.

The package root also exports all matching TypeScript types. Callers own resources returned
by the lower-level atlas, geometry, and material APIs.

The root also exports `svgToWindfoilOutlines`, `windfoilOutlineFromSvgPaths`,
`createWindfoilShapes`, and `createSvgEmojiOutlineProvider`. All are imported from
`'ultra-text'`; internal modules are not public package subpaths.

### Exported types

| Type                                            | Description                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BuildSdfAtlasOptions`                          | Options for `buildSdfAtlas`: mode, mipmaps, anisotropy, and an abort signal.                                                                                                        |
| `ColorGlyphMode`                                | Colour detection mode: `'emoji'`, `'all'`, or `'none'`.                                                                                                                             |
| `DomLayoutSnapshot`                             | One full typed capture: glyphs, rects, block metrics, atlas requests, size.                                                                                                         |
| `DomTextOptions`, `DomSdfOptions`               | Every option accepted by `DomText.create` and `collectDomSnapshot`.                                                                                                                 |
| `DomTextRebuildOptions`, `DomSdfRebuildOptions` | Options for `rebuild()`; `atlas: true` forces a fresh atlas.                                                                                                                        |
| `DomTextStats`, `DomSdfStats`                   | Timings and counts from the most recent build, exposed as `stats`.                                                                                                                  |
| `DomTextBackend`                                | Retained coverage name: `'sdf'` or `'windfoil'`.                                                                                                                                    |
| `DomTextLayoutEngine`                           | Layout engine name: `'range'` or `'pretext'`.                                                                                                                                       |
| `FontStyleSnapshot`                             | One captured font style, keyed for atlas sharing across identical styles.                                                                                                           |
| `GlyphBreak`                                    | Where a line may break before a glyph: `'none'`, `'soft'`, or `'hard'`.                                                                                                             |
| `GlyphLayout`                                   | One placed glyph: origin, advance, clip, colour, stagger sequence, and depth.                                                                                                       |
| `GlyphRequest`                                  | One font-style/character or whole emoji-sequence pair the atlas must contain.                                                                                                       |
| `GlyphSlot`                                     | One baked slot: UV window, plane box, metrics, optional support box, and colour flag.                                                                                               |
| `RasterAtlas`                                   | Transient Canvas 2D mask and optional RGBA colour band consumed by `buildSdfAtlas`.                                                                                                 |
| `RasterColorBand`                               | Transient sRGB RGBA band bytes and atlas row bounds.                                                                                                                                |
| `RasterizeOptions`                              | Options for `rasterizeGlyphAtlas`: bake size, padding, atlas limit, signal, and `previousAtlas`, whose colour classifications a rebuild with the same bake size and padding reuses. |
| `RectLayout`                                    | One captured rectangle: box, colour, corner radius, depth, and shadow flag.                                                                                                         |
| `SdfAnimationMode`                              | The nine motion modes, from `'none'` through the slides to `'all'`.                                                                                                                 |
| `SdfAtlas`                                      | Retained SDF texture, optional colour layer, shape rows, glyph map, mode, disposal.                                                                                                 |
| `SdfAtlasMode`                                  | Atlas generator selection: `'auto'`, `'gpu'`, or `'cpu'`.                                                                                                                           |
| `SdfColorLayer`                                 | Owned sRGB companion texture and atlas row bounds.                                                                                                                                  |
| `SdfMotionOptions`                              | Motion controls: enabled, mode, strength, speed, and stagger.                                                                                                                       |
| `SdfOutlineOptions`                             | Outward outline width, color, and opacity.                                                                                                                                          |
| `SdfDropShadowOptions`                          | Hard drop-shadow offsets, color, and opacity.                                                                                                                                       |
| `SdfTextMaterialOptions`                        | Constructor options for the standalone `SdfTextMaterial`.                                                                                                                           |
| `SdfTextQuality`                                | Sampling quality: `'standard'` or `'high'`.                                                                                                                                         |
| `TextBlockLayout`                               | Per-block wrap metrics that `reflowSnapshot` re-wraps from.                                                                                                                         |
| `TextDecorationLayout`                          | One solid decoration's line type, color, thickness, and local offset.                                                                                                               |
| `TextFill`                                      | Callback building a linear RGBA TSL graph for glyph interiors.                                                                                                                      |
| `TextFillContext`                               | Glyph UVs, local position, per-pixel colour, colour weight, and drawable index.                                                                                                     |
| `TextVertex`                                    | Callback building a local `vec3` TSL vertex position graph for glyph and decoration corners.                                                                                        |
| `TextVertexContext`                             | Corner position, centre, UV, drawable index, stagger sequence, rect, and clip box.                                                                                                  |
| `TextToneModel`                                 | Rasterizer a tone imitates: `'auto'`, `'outline'`, `'macos'`, or `'windows'`.                                                                                                       |
| `TextToneOptions`                               | Browser text weight: strength, backdrop colour, and model.                                                                                                                          |
| `WindfoilBoundingBox`                           | Font-unit `[xMin, yMin, xMax, yMax]` tuple.                                                                                                                                         |
| `WindfoilGlyphOutline`                          | Quadratic outline, font metrics, and bounding box returned by the provider.                                                                                                         |
| `WindfoilOutlineProvider`                       | App callback mapping a captured glyph request to its outline.                                                                                                                       |
| `WindfoilOptions`                               | Provider, whole-capture fallback, row-band tuning, and the SDF size switch.                                                                                                         |
| `WindfoilQuadratic`                             | One six-number quadratic Bézier tuple.                                                                                                                                              |

Additional SVG/vector contracts are exported as types:

- Capture: `DomSvgOptions`, `GlyphShape`, `GlyphShapePath`, `GlyphShapeStroke`.
- Conversion: `SvgToWindfoilOptions`, `WindfoilAffine`, `WindfoilEmBox`,
  `WindfoilShapePathLike`, `WindfoilSvgSource`, `WindfoilSvgPath`, `WindfoilSvgPaint`,
  `WindfoilSvgLayer`, `WindfoilSvgResult`, `WindfoilSvgWarning`, `WindfoilSvgWarningCode`.
- Shapes: `WindfoilShapeInstance`, `WindfoilShapes`, `WindfoilShapesOptions`,
  `WindfoilShapesStats`.
- Colour: `WindfoilOutlineLayer`, `WindfoilPaint`, `WindfoilForegroundPaint`,
  `WindfoilSolidPaint`, `WindfoilGradientBase`, `WindfoilGradientPaint`,
  `WindfoilLinearGradientPaint`, `WindfoilRadialGradientPaint`, `WindfoilSweepGradientPaint`,
  `WindfoilColorStop`, `WindfoilExtendMode`, `SvgEmojiOutlineProviderOptions`.

## Limitations

This is a selective visual reconstruction, not a general DOM renderer.

- SDF silhouettes remain single-channel, without true-MSDF corner reconstruction. Colour
  glyphs use the canvas default palette; `font-palette` and `font-variant-emoji` are not
  captured. Interior raster alpha below 50% is outside the SDF silhouette. Colour detail
  magnifies at the baked resolution, while the silhouette retains its SDF edge.
- Windfoil and Slug are experimental, WebGPU-only and nonzero-fill, and their edges are only as
  exact as their outlines: app-owned font outlines are exact, while traced outlines (no
  `outlineProvider`) follow the browser's raster at 256 px per em to about 0.006 em and cost
  main-thread time, about 1.2 ms per CJK glyph. They do not add shaping or CSS fidelity. Their
  antialiasing box is axis-aligned in glyph space and sized to each pixel's footprint, so rotated
  or sheared text approximates, rather than equals, an exact screen-pixel filter.
- By default, glyphs are rasterized by code point, except whole emoji sequences. Emoji
  sequences split across text nodes require browser shaping. Combining marks (U+0301 and friends) are
  approximated, not shaped: a zero-width mark is anchored at the caret after its base glyph
  using canvas metrics, which covers common accents but is not full shaping.
- Browser shaping, CJK reflow, RTL reflow, and legacy reshaping are [opt-in](#optional-language-support).
  Browser shaping retains ligatures and emoji ZWJ sequences as run masks. Vertical writing
  remains unsupported.
- `selectable: true` adds a CSS class only. The app must align and style the native DOM
  overlay for selection and copying.
- Form controls: interactive input elements (`<input>`, `<textarea>`, `<select>`, and
  `contenteditable`) should remain native DOM elements rather than converted to SDF blocks, as
  IME composition, caret navigation, and form state are native browser responsibilities.
- CSS `text-transform` follows Chrome's rules: `uppercase` and `lowercase` honour `lang` only
  for Turkish, Azerbaijani, Greek and Lithuanian, and `capitalize` ignores it. `full-width`
  applies where the browser computes it (Firefox, Safari); `full-size-kana`, `math-auto` and
  `::first-letter`/`::first-line` styles are not applied. With Range, a character that maps to
  several (ß → SS) splits its source box by advance, and their marks (ǰ → J̌) are approximated
  like other combining marks. A text node whose mapping cannot be split back per character maps
  each character alone, without context rules such as Lithuanian dot insertion.
- Strokes, shadows, gradients, filters, blend modes, masks, and CSS-transformed text are not
  reproduced. Use the explicit `outline`, `dropShadow`, and `fill` options for supported GPU
  text effects.
- Rectangles support a solid background, effective opacity, and one uniform radius. Borders,
  per-corner radii, images, CSS shadows, transforms, and clip paths are not reproduced.
- Text uses a finite rectangular clip per marked block. On axes with CSS `overflow: visible`,
  it includes the captured text boxes so tight line heights keep their descenders. Other
  overflow values keep the block bounds; arbitrary ancestor clipping is not reproduced.
- A captured line keeps its layout position. The browser paints each line with its top rounded
  to a whole layout pixel, so text laid out between pixel rows (a `1.4` line height at 16 px,
  a block centred on a half pixel) can sit up to half a layout pixel from the painted DOM in a
  1:1 overlay. Whole-pixel line heights and offsets match the DOM exactly, and the opt-in
  [`pixelSnap`](#pixel-snapping) applies the browser's rounding to a flat 1:1 overlay.
- Text weight follows the browser through `tone`, measured against Chrome on macOS only; see
  the [measured limits](#measured-limits).
- Hidden, transparent, disconnected, or zero-size source content is skipped or rejected.
- Creation and rebuilds perform real layout and atlas work; very large dynamic documents can
  be expensive.

Use native DOM text or a shaping-aware true-MSDF pipeline when exact shaping, sharp
high-contrast corners, or full CSS fidelity is required.

## Browser support

| Browser             | Status             | Notes                                                                                          |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| Chrome / Edge 128+  | Tested             | Chromium WebGPU end-to-end suite of the development repository.                                |
| Safari 26+          | Expected, untested | Ships WebGPU by default; not covered by automated tests.                                       |
| Firefox 141+        | Expected, untested | Ships WebGPU; not covered by automated tests.                                                  |
| Non-WebGPU browsers | SDF only, untested | `WebGPURenderer` may fall back to WebGL2 with `atlasMode: 'auto'` or `'cpu'`; Windfoil cannot. |

In production, serve over HTTPS, await `WebGPURenderer.init()`, and inspect the initialized
backend instead of relying on `navigator.gpu` alone.

The [gallery](https://ultra-text.makio.io/) automatically tries WebGL2 if WebGPU initialization fails, and its SDF atlases
can fall back to CPU generation when GPU baking fails. A failed startup shows the actual
error, phase and backend, with retry links and **Copy diagnostics** for browser, URL,
secure-context and stack details. An available WebGPU API alone does not guarantee a usable
adapter or a successful scene build.

The package is browser-only at runtime. Guard `DomSdf.create()` during SSR.

## Comparison with other 3D web text libraries

ultra-text renders the HTML you already have, with the fonts the page already loaded: there is
no font file to fetch or bake, layout and line breaking come from the browser, colour emoji keep
their colours, and one capture draws a whole subtree. That is where it leads, with draw calls,
frame time and GPU memory. Its first frame now comes before glyph's and after troika's; the
libraries that skip the DOM read still edit text faster.

The numbers below come from one browser benchmark kept with the development sources (not part
of this repository): each library on the three.js renderer it supports, in the same headless Chrome, with the same font (Noto Sans Regular), the
same 1,000-glyph paragraph or 200 labels, and the same 3200×2400 render target. A quick run on
2026-11-04: Apple M3 Max, macOS 15.8, Chrome 156, three 0.187.0-dev.ec2b745 on every page,
medians of 3 cold loads, 10 edits or 8 width changes. The machine was shared but lightly loaded
(1-minute load 4–6), so read them as ranges; a `--full` run is still to come. three-mesh-ui and
drei `<Html>` were not measured.

|                                        | `ultra-text` 0.1 (SDF)                                                                        | `@pmndrs/glyph` 0.1.0                                                                                                                          | `troika-three-text` 0.53.1 (drei `<Text>`)                                        |
| :------------------------------------- | :-------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| three.js renderer                      | `WebGPURenderer`; raw WebGPU through `ultra-text/vanilla`                                     | `WebGPURenderer` (classic `WebGLRenderer` unsupported)                                                                                         | classic `WebGLRenderer` only (GLSL through `onBeforeCompile`)                     |
| Fonts                                  | whatever the page loaded (WOFF2, system fonts, colour emoji), at its CSS weight; no bake step | a `.font.glb` from its CLI (Noto Sans, 304 glyphs: 7.4 s, 3.7 MB, 591 kB brotli) or a runtime bake of TTF/OTF; no WOFF/WOFF2 or variable fonts | a `.ttf`/`.otf`/`.woff` URL (`.woff2` throws); missing characters load from a CDN |
| Layout                                 | the browser's own CSS layout (Range) or Pretext                                               | its own shaping and layout (HarfRust in Wasm)                                                                                                  | its own layout in a worker                                                        |
| First frame, 1,000-glyph paragraph [1] | 41 ms                                                                                         | 53 ms (MSDF), 58 ms (Slug)                                                                                                                     | **23 ms**                                                                         |
| First frame, 200 labels [1]            | 46 ms (one capture)                                                                           | 80 ms                                                                                                                                          | 42 ms (200 `Text`), **27 ms** (`BatchedText`)                                     |
| Edit 10 letters already drawn [2]      | 4.4 ms                                                                                        | **3.1 ms**                                                                                                                                     | **3.1 ms**                                                                        |
| Edit adding a never-drawn letter [2]   | 7.4 ms (GPU atlas), 6.5 ms (CPU atlas), 5.1 ms with `extraGlyphs`                             | **2.8 ms** (baked ahead)                                                                                                                       | 3.0 ms                                                                            |
| Width change, 1,000 glyphs [2]         | **1.7 ms** with `reflow()`; 4.5 ms with CSS + `rebuild()`                                     | 2.1 ms                                                                                                                                         | 2.9 ms                                                                            |
| Frame, 1,000 glyphs [3]                | **0.09 ms**                                                                                   | 0.13 ms                                                                                                                                        | 0.17 ms                                                                           |
| Frame, 200 labels [3]                  | **0.09 ms**                                                                                   | 0.22 ms                                                                                                                                        | 1.67 ms (200 `Text`), 0.19 ms (`BatchedText`)                                     |
| Draw calls, paragraph / 200 labels     | **1 / 1**                                                                                     | 2 / 2 (double-sided text in two passes)                                                                                                        | 1 / 200 (1 with `BatchedText`)                                                    |
| GPU memory, paragraph [4]              | **0.64 MiB** (15 MiB while the GPU atlas bakes)                                               | 3.4 MiB MSDF, 0.35 MiB Slug (1.4 / 0.25 MiB for an ASCII-only bake)                                                                            | 2.0 MiB                                                                           |
| Zoom 10× / 100× [5]                    | sharp / edges waver (SDF); analytic with `textBackend: 'slug' \| 'windfoil'`                  | MSDF keeps corners; Slug exact                                                                                                                 | sharp / corners round                                                             |
| Outline and drop shadow                | on every backend                                                                              | MSDF only                                                                                                                                      | outline with blur and offset, inner stroke                                        |
| Colour emoji                           | **yes**, the browser's own                                                                    | not yet (roadmap)                                                                                                                              | monochrome                                                                        |
| JS, min+gzip                           | **38.7 kB** public entry                                                                      | 134.2 kB Three adapter + 511.2 kB shaper Wasm                                                                                                  | 46.3 kB with dependencies                                                         |

1. From the first authoring call to GPU completion of the first frame, with the font already
   loaded through each library's own API and a warm shader cache. ultra-text spends about 11 ms
   of its 41 ms baking the SDF atlas, 7 ms reading the DOM layout and 14 ms in the first render,
   where three builds the text material's shaders; troika typesets in a worker and generates
   glyph SDFs with WebGL as they are first used. troika's paragraph figure is from a rerun of the
   cold loads minutes later: in the full run and in another rerun its first frames took 49 and
   32 ms, 29 and 14 ms of it waiting for the GPU, which suggests its WebGL shaders missed the
   cache. ultra-text measured 40–41 ms and glyph MSDF 49–50 ms in those reruns.
2. From the change to GPU completion of the next frame. `rebuild()` reads the DOM again;
   `reflow()` re-wraps the retained capture without reading it. A never-drawn letter is drawn
   into the live atlas (see [Dynamic text and reflow](#dynamic-text-and-reflow)); glyph bakes
   every glyph ahead of time.
3. Whole frames at 3200×2400 by batch completion, including each renderer's clear and store of
   the target; GPU timestamps and per-process GPU time rank them the same way (troika ÷
   ultra-text 1.62–3.74 on the paragraph, glyph ÷ ultra-text 1.11–1.50). An empty frame costs
   about 0.14–0.16 ms on `WebGLRenderer` and 0.06–0.07 ms on `WebGPURenderer`, so much of troika's
   gap is the renderer: net of the empty frame, its text costs 0.010–0.114 ms (batch completion to
   GPU timer queries) against ultra-text's 0.010–0.017 ms, and glyph's 0.018–0.061 ms (two
   passes). 200 troika `Text` objects are CPU-bound (1.7 ms of CPU per frame).
4. Textures and buffers each library allocates, estimated at the API. glyph's figures are for the
   benchmark's 304-glyph bake; troika keeps its 1 MiB atlas both as a texture and as an SDF canvas.
5. The contact sheet `shots/zoom-grid.png` of each run.

Facts not measured here come from each project's documentation and source, checked on 2026-11-04:
[glyph's README](https://github.com/pmndrs/glyph) (renderers, formats, effects, emoji roadmap,
package sizes), [troika's README](https://github.com/protectwise/troika/tree/main/packages/troika-three-text)
(renderer, font formats, CDN fallback, effects) and bundlephobia (troika's size).

## Demo and documentation

- [Documentation](https://ultra-text.makio.io/docs), with the TresJS, React Three Fiber and
  Mini3 guides linked [above](#tresjs-react-three-fiber-mini3-and-vanilla-js).
- [HTML/3D demo](https://ultra-text.makio.io/demo): live HTML beside its retained WebGPU copy,
  with colour emoji and SVG exhibits.
- [Gallery](https://ultra-text.makio.io/): a WebGPU exhibition built with the library.

This repository holds the library only; the demo and gallery sources are not part of it.

## Development

The repository uses Node 22.23.2 (`.node-version`) and pnpm 12.3.4 (`packageManager`).
TypeScript 7 runs type checks and declaration builds through `tsc`; the `typescript`
dependency aliases the TypeScript 6 compatibility package required by typescript-eslint.

```sh
pnpm install --frozen-lockfile
pnpm test
```

| Command          | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm test`      | Run the Vitest unit suite.                                          |
| `pnpm typecheck` | Type-check browser and Node configurations.                         |
| `pnpm lint`      | Run ESLint with zero warnings allowed.                              |
| `pnpm build`     | Build ESM modules and TypeScript declarations into `dist/`.         |
| `pnpm check`     | Run formatting, lint, types, coverage, build, size, and package QA. |

The unit suite runs in jsdom: it checks CPU logic, generated shader text, graph wiring,
lifecycle and public behavior, but does not render. Pull requests and pushes to `main` run
`pnpm check`.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) covers pull requests, and [`AGENTS.md`](./AGENTS.md)
maps the repository and its invariants for contributors and coding agents.

## License

[MIT](./LICENSE) © David Ronai. Windfoil-derived preprocessing and shader portions are
Apache-2.0, and the Glyph-derived SDF effect composition and the Slug-derived coverage evaluator
keep their upstream MIT notices; see [third-party notices](./THIRD_PARTY_NOTICES.md), which also
lists the licensed test fixtures.
