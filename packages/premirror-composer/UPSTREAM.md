# Vendored from premirror

- **Upstream:** https://github.com/arthrod/premirror (fork of samwillis/premirror) (`packages/composer`)
- **Vendored at commit:** `29b78634d6496206c84015068eb7d66d9cdc312c` (2026-07-11)
- **License:** MIT (Sam Willis) — see `LICENSE` in this directory.

## Local changes since vendoring

- `tsconfig.json`: `extends` repointed to `../../tsconfig.premirror-base.json` (premirror's root base copied to the eigenport root under that name).

**Verified 2026-07-11:** under `bun test`, tsconfig `paths` wins — tests measure via the deterministic pretext stub (`length*7` fallback), NOT real pretext. Vite (demo) aliases to the real package source. Keep this in mind for fixtures.

- 2026-07-11 tooling reconcile: `prettier --write` (house format) + `eslint --fix` (2 prefer-const in composer). When re-diffing against upstream, run prettier over the upstream side first.

- 2026-07-11 folio vendor: copied from eigenport@806c7fe8 (arthrod/eigenport feat/premirror-phase3-projection), which vendored arthrod/premirror@29b7863 and carries the logged local changes above. Folio tooling reconcile (oxfmt/oxlint) follows in a separate commit.

Keep this log current: every local edit to vendored files gets a line here.
Generic fixes should be PR'd upstream, not fork-drifted.

- 2026-07-12 review sync: vendored sources re-synced from eigenport (PR review fixes: bounded pretext width cache, drained-line pmRange collapse, mapping binary search, policies deep-merge, selection projection interpolation + boundary dedup + geometry module, demo Selection.near). See arthrod/eigenport#110/#118 threads.
