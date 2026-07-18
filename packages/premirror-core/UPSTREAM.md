# Vendored from premirror

- **Upstream:** https://github.com/arthrod/premirror (fork of samwillis/premirror) (`packages/core`)
- **Vendored at commit:** `29b78634d6496206c84015068eb7d66d9cdc312c` (2026-07-11)
- **License:** MIT (Sam Willis) — see `LICENSE` in this directory.

## Local changes since vendoring

- `tsconfig.json`: `extends` repointed to `../../tsconfig.premirror-base.json` (premirror's root base copied to the eigenport root under that name).

- 2026-07-11 tooling reconcile: `prettier --write` (house format); no lint fixes were needed in THIS package (the 2 prefer-const fixes were in premirror-composer only). When re-diffing against upstream, run prettier over the upstream side first.
- 2026-07-11 (PR #110 / ce21ed65): `defaultPremirrorOptions` deep-merges partial `policies` with `DEFAULT_LAYOUT_POLICIES` (was replace-not-merge). Regression: `src/index.test.ts` describe `defaultPremirrorOptions policies merge (PR #110 review)`. **Upstream disposition:** local fork fix — re-apply or PR upstream on next re-vendor (not yet landed on arthrod/premirror).

- 2026-07-18 (E-4 unification): `SegmentFitEngineLike` (+ `SegmentFitLineLike`, `SegmentFitPreparedLike`) structural seam type added — mirrors folio-core's `SegmentFitEngine` (`packages/core/src/layout-engine/measure/segmentFit.ts`) without a folio-core dependency, so the packages stay standalone/upstreamable. `PremirrorOptions.engine` + `LayoutInput.engine` optional fields threaded through `defaultPremirrorOptions` / `createLayoutInputFromOptions`. **Upstream disposition:** candidate PR to samwillis/premirror together with the composer/adapter DI refactor.

Keep this log current: every local edit to vendored files gets a line here.
Generic fixes should be PR'd upstream, not fork-drifted.
