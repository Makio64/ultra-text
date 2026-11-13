# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-14

First public release, for Three.js r187 (`>=0.187.0 <0.188.0`).

### Added

- `DomText` (alias `DomSdf`): capture marked HTML (`data-text-*`, or the equivalent
  `data-sdf-*` attributes) into a retained `THREE.Group` of instanced glyph, rectangle and
  decoration geometry, with observer-driven rebuilds that abort superseded work, swap content
  only once its replacement is ready, and dispose idempotently.
- `Text`: a styled string with CSS, owned by the library, with `setText()`, `setCss()`,
  `setClass()` and `rebuild()`.
- Runtime single-channel SDF atlases from a TSL jump-flood pass on WebGPU, with an exact CPU
  distance transform (in a worker) as the `auto` fallback, including on the WebGL2 backend and
  on WebGPU compatibility-mode devices. Rebuilds that gain glyphs patch them into the live atlas.
- Layout by the browser's own `Range` measurements, or the optional Pretext and browser
  shaping engines, with `reflow(width)` for width-only updates without DOM reads, keeping each
  block's `text-align` and `text-align-last`.
- Text weight matched to the browser's own blending (`tone`), DOM baselines, pixel snapping,
  and multisampled-target support.
- TSL motion modes (or static text with `motion: false`), clipping, shadow masks, custom fills
  and vertex hooks, outlines, drop shadows and CSS text decorations on every text backend.
  Under `material.wireframe`, text draws each character's box.
- Experimental Windfoil backend: analytic quadratic outlines from an app-supplied font resolver
  or traced from the browser's own glyphs, with SVG shapes, inline SVG capture, colour layers
  and SVG emoji.
- Experimental Slug backend (`textBackend: 'slug'`, `SlugOptions`): an extrema-split, dual-ray
  quadratic-outline evaluator sharing Windfoil's outline provider, `fallback` modes,
  `sdfBelowPx` size switch, colour layers, `tone` and reflow.
- `ultra-text/vanilla`: a Three.js-free entry for Mini3 and custom WebGPU or Canvas engines,
  with typed-array instance packs.
- Enforced size budgets for the public entry and each optional chunk.

[Unreleased]: https://github.com/Makio64/ultra-text/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Makio64/ultra-text/releases/tag/v1.0.0
