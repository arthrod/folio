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

## 4. E-0 perf baseline — harness LANDED, budget assertion pending (LOW)

`tests/perf/segmentfit-baseline.mjs` + committed A/B JSON record forced-
relayout p50/p95 for pretext vs the legacy walk (steady-state parity, as
expected — pretext's win is cold-cache/overlong-token measurement,
characterized in the bridge's parity tests). Remaining: Arthur signs a
TARGET_MS (plan §12.6), then the budget assertion is committed as a test.

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

## 6. Premirror port follow-ups — bot-review triage on PR #7 (MEDIUM)

Findings from adversarial triage of the CodeAnt/Gemini review of the E-3/E-4
port branch. All are in PORTED upstream logic (samwillis/premirror lineage +
eigenport furniture superset); the port deliberately preserved upstream
behavior, so these are follow-ups, not port blockers. Refuted claims are
recorded in the PR conversation, not here.

- CONFIRMED (react projection): `fragmentProjection.tsx` resolves blocks to
  paragraph nodes only (`paragraphRangeFromBlockId` / `paragraphRangeAtPos`
  both require `type.name === "paragraph"`), but the adapter also emits
  `heading` blocks (`pushParagraphLike(..., "heading", ...)`); heading run
  decorations are silently skipped. Broaden to the block types the adapter
  emits, red-first.
- CONFIRMED (composer, latent): newline-split pieces reuse per-piece char
  offsets (`pushPlacedSegment(..., piece, 0, piece.length, ...)`) while
  `pmPosAtRunOffset` expects offsets into the ORIGINAL run text, so a run
  containing `\n` maps later pieces to duplicate pmRanges. Latent today
  because the PM adapter never emits `\n` inside a run (hard breaks are
  nodes); real for any host feeding raw multi-line runs.
- PLAUSIBLE, unverified (composer pagination family): endnote pages are
  appended after the header/footer composition loop (no furniture on endnote
  pages) and NUMPAGES is substituted from the body-page count before endnote
  pages exist; `fixWordBoundarySplits` moves trailing word chars to the next
  line without re-checking that line's fit. Verify against upstream behavior
  before changing — these may be Milestone-1 scope cuts, not bugs.
