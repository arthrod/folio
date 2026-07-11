# Vendored from premirror

- **Upstream:** https://github.com/arthrod/premirror (fork of samwillis/premirror) (`packages/core`)
- **Vendored at commit:** `29b78634d6496206c84015068eb7d66d9cdc312c` (2026-07-11)
- **License:** MIT (Sam Willis) — see `LICENSE` in this directory.

## Local changes since vendoring

- `tsconfig.json`: `extends` repointed to `../../tsconfig.premirror-base.json` (premirror's root base copied to the eigenport root under that name).

- 2026-07-11 tooling reconcile: `prettier --write` (house format) + `eslint --fix` (2 prefer-const in composer). When re-diffing against upstream, run prettier over the upstream side first.

- 2026-07-11 folio vendor: copied from eigenport@806c7fe8 (arthrod/eigenport feat/premirror-phase3-projection), which vendored arthrod/premirror@29b7863 and carries the logged local changes above. Folio tooling reconcile (oxfmt/oxlint) follows in a separate commit.

Keep this log current: every local edit to vendored files gets a line here.
Generic fixes should be PR'd upstream, not fork-drifted.
