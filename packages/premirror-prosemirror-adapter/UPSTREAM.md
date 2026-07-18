# Vendored from premirror

- **Upstream:** https://github.com/arthrod/premirror (fork of samwillis/premirror) (`packages/prosemirror-adapter`)
- **Vendored at commit:** `29b78634d6496206c84015068eb7d66d9cdc312c` (2026-07-11)
- **License:** MIT (Sam Willis) — see `LICENSE` in this directory.

## Local changes since vendoring

- `tsconfig.json`: `extends` repointed to `../../tsconfig.premirror-base.json` (premirror's root base copied to the eigenport root under that name).

**Verified 2026-07-11:** under `bun test`, tsconfig `paths` wins — tests measure via the deterministic pretext stub (`length*7` fallback), NOT real pretext. Vite (demo) aliases to the real package source. Keep this in mind for fixtures.

- 2026-07-11 tooling reconcile: `prettier --write` (house format); no lint fixes were needed in THIS package (the 2 prefer-const fixes were in premirror-composer only). When re-diffing against upstream, run prettier over the upstream side first.
- 2026-07-11 (PR #110 / ce21ed65): local regression tests in `src/index.test.ts` — mocked measurement-path coverage and root-selection (`ResolvedPos.before(1)` at depth 0 does not throw). **Upstream disposition:** tests-only local additions; candidate to PR upstream with the adapter suite.
- 2026-07-15 (PR #110 / c4043db1): `src/snapshot-extraction.test.ts` — list/blockquote/heading/nesting/hard-break snapshot extraction + no-op invalidation path.

Keep this log current: every local edit to vendored files gets a line here.
Generic fixes should be PR'd upstream, not fork-drifted.
