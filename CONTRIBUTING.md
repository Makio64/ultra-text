# Contributing

Thanks for helping improve `ultra-text`.

## Development setup

The repository uses Node 22.23.2 and pnpm 12.3.4. CI reads the same `.node-version` pin.
TypeScript 7 supplies `tsc` through the `@typescript/native` alias, while the `typescript`
alias supplies the TypeScript 6 API needed by typescript-eslint.

```sh
pnpm install --frozen-lockfile
pnpm test   # Vitest unit suite
pnpm check  # formatting, lint, types, coverage, build, size, and package QA
```

## Conventions

Read [`AGENTS.md`](./AGENTS.md) first: it maps the repository and lists the invariants
(ESM `.js` import suffixes, transactional rebuilds, idempotent disposal, the frozen options
contract, and more) that changes must preserve.

The public API surface is locked by `tests/public-exports.test.ts`. Adding, renaming, or
removing a root export fails that test on purpose — update the test and the README together,
deliberately.

## Pull requests

- Keep changes narrow and include tests that fail before the fix.
- Run `pnpm check` before opening the PR; CI runs the same checks. The unit suite does not
  render: when a change affects rendering, check it in a WebGPU browser too and say how.
- Report security issues privately, as [`SECURITY.md`](./SECURITY.md) describes.
- Update `README.md` and `CHANGELOG.md` (under `## [Unreleased]`) for public changes.
