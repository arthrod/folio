# Vendored from premirror

- **Upstream:** https://github.com/arthrod/premirror (fork of samwillis/premirror) (`packages/composer`)
- **Vendored at commit:** `29b78634d6496206c84015068eb7d66d9cdc312c` (2026-07-11)
- **License:** MIT (Sam Willis) — see `LICENSE` in this directory.

## Local changes since vendoring

- `tsconfig.json`: `extends` repointed to `../../tsconfig.premirror-base.json` (premirror's root base copied to the eigenport root under that name).

**Verified 2026-07-11:** under `bun test`, tsconfig `paths` wins — tests measure via the deterministic pretext stub (`length*7` fallback), NOT real pretext. Vite (demo) aliases to the real package source. Keep this in mind for fixtures.

- 2026-07-11 tooling reconcile: `prettier --write` (house format) + `eslint --fix` (2 prefer-const in composer). When re-diffing against upstream, run prettier over the upstream side first.

- 2026-07-18 (E-4 unification): the composer no longer imports `@chenglou/pretext`. `widthByPretext(text, font)` became `widthBySegmentFit(engine, text, font)` over the injected `SegmentFitEngineLike` (`LayoutInput.engine`, threaded from `PremirrorOptions.engine`); the bounded width LRU is unchanged. Absent/declining/failing engine takes the same null path as before (measuredRuns ratio, then 7px/char). The `src/shims/pretext-stub.ts` shim and the tsconfig `paths` mapping are gone; tests inject deterministic fake engines instead of `mock.module`. Guard: `src/one-pretext-surface.test.ts`. **Upstream disposition:** candidate PR to samwillis/premirror with the premirror-core seam type.

Keep this log current: every local edit to vendored files gets a line here.
Generic fixes should be PR'd upstream, not fork-drifted.
