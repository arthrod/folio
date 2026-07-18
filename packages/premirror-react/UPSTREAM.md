# Vendored from premirror

- **Upstream:** https://github.com/arthrod/premirror (fork of samwillis/premirror) (`packages/react`)
- **Vendored at commit:** `29b78634d6496206c84015068eb7d66d9cdc312c` (2026-07-11)
- **License:** MIT (Sam Willis) — see `LICENSE` in this directory.

## Local changes since vendoring

- `tsconfig.json`: `extends` repointed to `../../tsconfig.premirror-base.json` (premirror's root base copied to the eigenport root under that name).
- `tsconfig.json`: pretext-stub `paths` entry repointed to sibling `premirror-prosemirror-adapter`.

- 2026-07-11 tooling reconcile: `prettier --write` (house format); no lint fixes were needed in THIS package (the 2 prefer-const fixes were in premirror-composer only). When re-diffing against upstream, run prettier over the upstream side first.

- 2026-07-11 phase 3: `buildFragmentDecorations` lifted from the demo into `@premirror/react` (`src/fragmentProjection.tsx`, + prosemirror-model/view deps); demo now imports it. Candidate upstream PR.

- 2026-07-18 (E-4 unification): no code change — the engine option passes through untouched (`PremirrorOptions.engine` reaches the adapter via `createPremirror`, `LayoutInput.engine` reaches the composer via `usePremirrorEngine`'s `layoutInput`); this package has no measurement logic of its own. The tsconfig `paths` entry pointing at the (now deleted) adapter pretext stub is removed. Guard: `src/one-pretext-surface.test.ts`.

Keep this log current: every local edit to vendored files gets a line here.
Generic fixes should be PR'd upstream, not fork-drifted.
