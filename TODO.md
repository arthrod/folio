# TODO — folio (redline/editor line)

Findings from the 2026-07-17 jubarte-integration session (all verified; the
deployed matrix is https://folio-redline.cicero-im.workers.dev/redline3 and
its variant switcher).

## 1. Surface engine-ladder attempts (HIGH)

`generateRedlineDocx` records per-engine `attempts` (engine/phase/message)
but DISCARDS them when a later rung succeeds — a primary-engine failure is
invisible to callers, which let the deployed demo silently serve the
fallback for weeks. Return `attempts` in `GenerateRedlineDocxResult`
(additive, non-breaking) and require consumer surfaces to show engine
identity. Fallback policy belongs in writing: demo surfaces run a single
engine (no fallback); product surfaces may ladder only with attempts
surfaced.

## 2. Resolution-fidelity harness family (HIGH — D-1 extension)

The pPrMark-before-table corruption lived in VIEW RESOLUTION
(`resolveChange` accept path), which the parse→serialize round-trip harness
never exercises. Add a corpus family: for each redline, folio's
accept-all/reject-all views must equal the revised/base texts AND agree with
jubarte-native's accept/reject of the same buffer. (The self-check judges
through folio's own resolver — triangulate so a resolver bug cannot
systematically reject the Word-canonical engine; that exact failure shipped.)

## 3. prosemirror-transform join semantics are load-bearing (MEDIUM)

`tr.join` is NON-atomic since prosemirror-transform 1.8: it applies
destructive `clearIncompatible` steps BEFORE failing on an incompatible
boundary. `comments.ts` is fixed (`canJoin` gate + Word semantics for the
empty mark-deleted paragraph; tests in `pPrMark-accept-reject.test.ts`).
On any PM bump, re-run those tests first. `suggestionMode.ts`'s
`applyPPrDel` also calls `tr.join` in a try/catch — safe today only because
its `dispatch` sits inside the try (the half-applied tr is discarded);
add the `canJoin` gate there for symmetry.

## 4. E-0 perf baseline debt (MEDIUM)

The playground runs `segmentFitLineBreaking` ON with parity dogfoods but no
committed p50/p95 keystroke-to-paint baseline — violating the plan's own
"E-0 runs before any flag flips" sequencing. Land E-0 or mark the playground
flip demo-exempt in the plan.

## 5. Playground follow-ups (LOW)

- Switch the `jubarte-src` source-alias imports to the (now regenerated,
  fully typed) jubarte-first dist and delete the ambient declarations in
  `src/vite-env.d.ts`.
- React-tier pages paint only after JS boot (no FCP entry in the CDP
  snapshot; the Vue tiers paint at ~200 ms). Add a static skeleton to the
  entry HTML.
- The monolith view (paragraph-block aggregation, judge-verified
  view-preserving) is demo-local (`src/redline3/monolith.ts`); consider
  upstreaming as a folio-core redline post-processing option.
- `bench-redline3.mjs` (CDP load/render/memory snapshot) is committed at the
  repo root; run Lighthouse separately for scored vitals.
