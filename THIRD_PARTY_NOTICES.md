# Third-party notices

## Glyph

The SDF outline/drop-shadow composition and atlas-cell sampling in
`src/text/SdfTextMaterial.ts` are adapted from [pmndrs/glyph](https://github.com/pmndrs/glyph),
revision [`b491aa7d77e865d175ee0dafa77863ea5e2ed812`](https://github.com/pmndrs/glyph/commit/b491aa7d77e865d175ee0dafa77863ea5e2ed812).
They are modified for this project's single-channel atlases, clipping, motion, and fill API.
Copyright (c) 2026 Poimandres. The upstream MIT license is included in
[`licenses/GLYPH-MIT.txt`](licenses/GLYPH-MIT.txt).

## Windfoil

Portions of the Windfoil text backend are adapted from and based on Windfoil:

- Project: [texel-org/windfoil](https://github.com/texel-org/windfoil)
- Reference revision: [`46bb1f170938564b08e358c3be20dac1b4b9e7fb`](https://github.com/texel-org/windfoil/commit/46bb1f170938564b08e358c3be20dac1b4b9e7fb)
- Copyright 2026 Matt DesLauriers
- License: Apache License 2.0

The Windfoil-derived preprocessing and shader code in this project was adapted and
modified for TypeScript, Three.js WebGPU, and TSL integration. It is not an unmodified
copy of the upstream implementation.

The full Apache License 2.0 text, including the upstream copyright notice, is provided
in [`licenses/WINDFOIL-APACHE-2.0.txt`](licenses/WINDFOIL-APACHE-2.0.txt).

## Slug

The coverage evaluator of the Slug text backend in `src/slug/` (the horizontal and vertical
ray solves and their weighted combination) is adapted from the Slug reference shaders:

- Project: [EricLengyel/Slug](https://github.com/EricLengyel/Slug), the reference code for
  the algorithm in Lengyel's 2017 [JCGT paper](https://jcgt.org/published/0006/02/02/)
- Copyright (c) 2017 Eric Lengyel
- License: MIT (upstream offers MIT or Apache License 2.0; this project uses MIT)

The code is rewritten in WGSL and TSL for this project's band layout and storage buffers.
Upstream has dedicated the Slug patent to the public domain. This project is not affiliated
with Terathon Software or the commercial Slug Library. The upstream MIT license is included
in [`licenses/SLUG-MIT.txt`](licenses/SLUG-MIT.txt).

## Test fixtures

These files are used only by tests and are not part of the npm package:

- `tests/fixtures/emoji/`: Twemoji artwork by Twitter, Inc. and contributors,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see the README and license there.
- `tests/fixtures/svg/social/`: the X, GitHub and LinkedIn marks from
  [Simple Icons](https://github.com/simple-icons/simple-icons), CC0-1.0. Their owners retain
  all trademark rights.
