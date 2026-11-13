# Repository guide for coding agents

These instructions apply to the entire repository. Keep changes narrow, preserve unrelated
work in the tree, and use the source and tests as the authority when prose disagrees.

## Toolchain

- Node.js 22.23.2, pinned in `.node-version` and shared by CI
- pnpm 12.3.4, pinned in `package.json`
- TypeScript 7 in strict ESM mode, with the TypeScript 6 API compatibility package for ESLint
- Three.js r187 (`0.187.0` in development) through `three/webgpu` and `three/tsl`; the peer
  range is `>=0.187.0 <0.188.0`
- Vitest with jsdom for unit tests

Install with:

```sh
pnpm install --frozen-lockfile
```

## Source of truth

- `src/index.ts` and `src/vanilla.ts` define the supported package boundary (`ultra-text`,
  `ultra-text/vanilla`, and `./package.json`); do not introduce or document deep imports.
- `src/types.ts` defines the public data and option contracts.
- `package.json` defines canonical commands, package contents, peer ranges, and the measured
  size budgets of the public entries and each optional chunk.
- `README.md` documents user-facing behavior. Update it when public behavior changes.
- `CHANGELOG.md` follows Keep a Changelog; add concise entries under `## [Unreleased]` for
  meaningful public changes.

## Repository map

| Path             | Responsibility                                                                    |
| ---------------- | --------------------------------------------------------------------------------- |
| `src/dom/`       | DOM capture, layout engines, retained `DomText` lifecycle, observers, disposal.   |
| `src/atlas/`     | Glyph rasterization plus CPU EDT and WebGPU/TSL atlas generation.                 |
| `src/text/`      | Instanced geometry, TSL materials, motion, clipping, shadows, and reflow.         |
| `src/windfoil/`  | Experimental analytic-outline backend, SVG conversion, colour layers and emoji.   |
| `src/slug/`      | Experimental Slug analytic-outline backend sharing Windfoil's outline provider.   |
| `src/vanilla.ts` | Three.js-free `ultra-text/vanilla` entry: raw WebGPU/CPU atlases and typed packs. |
| `tests/`         | jsdom unit tests for CPU logic, graph wiring, lifecycle, and public behavior.     |
| `.github/`       | CI and tag-driven npm release workflows.                                          |

## Invariants

- Preserve `.js` suffixes in TypeScript relative imports; emitted ESM depends on them.
- Keep public runtime exports and type exports routed through the relevant `index.ts` files.
- Do not casually widen the Three.js peer range. WebGPU and TSL APIs move between minors.
  Test against the release the range declares.
- Use `three/webgpu` and `three/tsl`; the classic `WebGLRenderer` is unsupported.
- Keep the expensive DOM read, glyph rasterization, and geometry construction out of the
  steady-state render path.
- Preserve transactional rebuilds: newer work aborts superseded work, and live content is
  swapped only after its replacement is ready.
- Preserve idempotent disposal and release partial resources on failure or abort.
- Keep GPU and CPU atlas modes compatible at the public `SdfAtlas` boundary. `auto` must
  remain able to fall back to CPU generation.
- Treat `DomText.options` as frozen caller input, not a resolved-default object.
- Keep the package side-effect-free and tree-shakeable.
- Add or update tests with behavior changes. Prefer regression tests that fail before the
  fix.

## Change workflow

1. Inspect `git status` and the focused diff before editing. Existing changes belong to the
   user unless the task says otherwise.
2. Read the nearest source, tests, and public types before changing behavior.
3. Make the smallest coherent change and keep the public root export explicit.
4. Run targeted tests while iterating.
5. Run the verification appropriate to the change's scope below before handoff.

Useful targeted commands:

```sh
pnpm exec vitest run tests/dom-sdf.test.ts
pnpm exec vitest run tests/build-atlas.test.ts
pnpm exec prettier --check README.md AGENTS.md
```

| Change                            | Minimum verification                                         |
| --------------------------------- | ------------------------------------------------------------ |
| Markdown only                     | Prettier check for the changed Markdown files.               |
| DOM, atlas, text, or public types | Relevant Vitest file, then `pnpm test` and `pnpm typecheck`. |
| Package metadata or exports       | `pnpm package:check`.                                        |
| Broad or release-facing           | `pnpm check`, then a rendering check in a WebGPU browser.    |

`pnpm check` runs formatting, lint, type-checking, coverage, the library build, size limits,
`publint`, `attw`, and a pack dry run. CI runs the same command. The unit suite does not
render; prefer local WebGPU hardware for rendering checks.

Shader snapshot tests (`tests/sdf-shaders.test.ts`, `tests/windfoil-shaders.test.ts`) pin the
WGSL that the development Three.js generates. When only Three.js changes, diff the old and new
shaders, confirm the difference is code generation alone, then re-record the pins.

## Saving and resuming long work

Sessions, subagents and workflows can be interrupted at any time. Work so that an
interruption loses minutes, not hours.

- Keep a progress log for multi-step tasks in the git-ignored `reports/<task>/`: what is done,
  what is left, test results and decisions. Update it after every edit batch and test run.
- Snapshot the working tree to local `wip/<task>/<stamp>` branches through a throwaway index
  (`GIT_INDEX_FILE`), so HEAD, the shared index and the files stay untouched. Never stash,
  commit, reset or push just to save.
- A restarted agent first reads its log and the files it owns, then continues from there.

## Generated and local files

Never hand-edit or commit generated output and local caches: `dist/`, `coverage/`,
`reports/`. The package build recreates `dist/`.

Keep performance claims reproducible and hardware-qualified. Prefer same-session A/B
measurements over unqualified frame-rate numbers.

## Releases

Do not publish locally. The release workflow publishes an exact `v*` tag to npm with
provenance and requires the tag to match `package.json`. Keep release changes intentional:
version, changelog, tests, package checks, then tag.
