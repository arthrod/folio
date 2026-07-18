# redline3 statistical benchmark: dissertation-slice fixtures

Companion report for `bench-redline3-stats.mjs`. Run 2026-07-18 against the deployed
playground (`https://folio-redline.cicero-im.workers.dev`), 210 runs: 7 pages x 10
fixtures x 3 repetitions, sequential, one fresh browser context per run.
**All 210 runs completed `ok`; no failures, hangs, or timeouts.**

## Method

- **Fixtures.** The dissertation demo pair (`dissertacao-a/b.docx`, ~11k body
  paragraphs, ~9.7 MB each) is too large to compare live in a page (the full
  compare needs ~11.9 GB peak, past wasm32's 4 GiB and browser JS heaps), so it
  was cut into 10 aligned slice pairs: `difflib.SequenceMatcher` over body
  paragraph texts (99.9% of paragraphs match), cuts placed at matched paragraph
  pairs nearest each decile boundary. Each slice is ~1,100 paragraphs / ~6.5 MB
  and keeps the full package (styles, numbering, media). The real edits
  concentrate in slices 3, 4, 5, 7; the rest are identical-content pairs, kept
  deliberately as a zero-diff baseline. Slices are generated outside the repo
  and are not committed (corpus-derived documents stay out of the repository).
- **Per-slice native redlines.** The native pages serve server-side precomputed
  redlines by design (a page cannot execute a native binary), so each slice pair
  was precomputed with the native jubarte CLI (v0.5.0; 3.2-4.4 s per slice).
- **Delivery.** Playwright route interception rewrites the `example-0` preset
  fetches (`pair1-{a,b,redline}.docx`) to the slice files. Every page in the
  matrix, including the upload-less Vue tier, therefore runs the same fixture
  through its normal preset path against the production deployment.
- **Sampling.** 3 full sweeps over (page x fixture); fresh context (fresh
  renderer, cold caches) per run; runs strictly sequential to avoid CPU/memory
  contamination. JS heap sampled via the CDP Performance domain, raw and after a
  forced GC (`HeapProfiler.collectGarbage`), at load and at end; layout/style/
  script CPU totals and DOM node counts from the same domain.
- **Timeout bug fixed first.** The original `bench-redline3.mjs` passed
  `{ timeout }` as the second argument of `page.waitForFunction`, which
  Playwright binds as `arg`, silently keeping the default 30 s cap. That made
  the TS engine look like a hang/timeout when it actually completes in ~35-55 s.
  Fixed in `1121507`; the stats script inherits the fix.

Environment: Apple M4 Pro, 24 GB, macOS (Darwin 25.5.0), Node v26.5.0,
Playwright 1.61.1 (headless Chromium), 1680x1000 viewport.

## Per page (n = 30: 10 fixtures x 3 reps)

| page | outcomes | load | redline wall | engine compare | heap@end raw | heap@end after GC | peak heap total | DOM nodes | layout CPU | script CPU |
|---|---|---|---|---|---|---|---|---|---|---|
| /redline3 (react-wasm, edit) | ok:30 | 203±35ms | 9.42±1.86s | 9.17±1.83s | 458±102M | 201±13M | 623M | 24.0k | 86ms | 1716ms |
| /redline3-view (react-wasm, view) | ok:30 | 195±31ms | 9.37±1.90s | 9.14±1.88s | 469±74M | 199±13M | 612M | 23.6k | 84ms | 1687ms |
| /redline3-ts (react-ts) | ok:30 | 202±44ms | 45.2±7.4s | 45.1±7.4s | 1083±545M | 202±12M | 1942M | 24.4k | 88ms | 1731ms |
| /redline3-native (react, precomputed) | ok:30 | 202±38ms | 0.74±0.31s | n/a | 264±46M | 208±18M | 425M | 21.6k | 63ms | 1189ms |
| /redline3-vue (vue-wasm) | ok:30 | 234±26ms | 14.6±2.8s | 7.07±1.40s | 328±106M | 33±2M | 596M | 172.9k | 156ms | 382ms |
| /redline3-vue-ts (vue-ts) | ok:30 | 250±28ms | 44.9±4.7s | 37.2±4.0s | 586±710M | 35±2M | 2164M | 173.1k | 152ms | 355ms |
| /redline3-vue-native (vue, precomputed) | ok:30 | 246±33ms | 7.48±0.88s | n/a | 362±172M | 30±2M | 706M | 172.9k | 145ms | 31ms |

Notes: "engine compare" is the app-reported compare time (React debug hook or
status footer); "redline wall" is click-to-revision-count. The native rows
measure fetch + revision enumeration + render of a precomputed redline, not a
live compare. Raw heap@end depends on GC timing (hence the wide sd on the TS
pages); the after-GC column is the retained set.

## Revision parity per fixture

| fixture | rust (wasm = native) | ts (jubarte-first-lossless) |
|---|---|---|
| slice0 | 0 | **30** |
| slice1 | 0 | 0 |
| slice2 | 0 | **6** |
| slice3 | 49 | **47** |
| slice4 | 1 | **15** |
| slice5 | 2 | 2 |
| slice6 | 0 | 0 |
| slice7 | 27 | **26** |
| slice8 | 0 | **2** |
| slice9 | 0 | **12** |

Counts were identical across all 3 reps of every page (deterministic engines).
The wasm and native builds agree everywhere, as they must (same Rust engine,
two builds). The TS port disagrees on 7 of 10 fixtures, in both directions: it
reports revisions on 5 identical-content pairs (up to 30 on slice0) and drops
revisions on the edit-heavy slices (47 vs 49; 26 vs 27). This is a real
cross-implementation discrepancy on table-free documents, separate from the
already-known table-document defect, and worth a dedicated investigation.

## Redline wall per fixture (mean±sd over 3 reps)

| fixture | /redline3 | /redline3-view | /redline3-ts | /redline3-native | /redline3-vue | /redline3-vue-ts | /redline3-vue-native |
|---|---|---|---|---|---|---|---|
| slice0 | 7.95±1.79s | 7.96±1.75s | 40.8±6.6s | 0.56s | 12.9±3.0s | 39.6±4.1s | 6.73s |
| slice1 | 9.35±2.14s | 9.24±2.08s | 43.6±6.4s | 0.58s | 14.9±3.5s | 44.4±6.4s | 7.54s |
| slice2 | 8.90±2.10s | 8.85±2.01s | 37.7±6.5s | 0.90s | 14.0±3.3s | 40.4±4.6s | 7.04s |
| slice3 | 9.50±2.11s | 9.44±2.10s | 47.9±5.4s | 0.94s | 15.4±3.4s | 45.0±3.6s | 7.75s |
| slice4 | 9.77±2.15s | 9.67±2.19s | 51.2±5.4s | 0.93s | 15.6±3.6s | 47.1±4.8s | 7.70s |
| slice5 | 9.90±2.10s | 9.78±2.24s | 48.8±9.0s | 0.62s | 15.8±3.5s | 47.6±5.2s | 7.69s |
| slice6 | 10.5±2.3s | 10.5±2.4s | 50.0±9.7s | 0.99s | 16.9±3.6s | 48.7±2.5s | 8.15s |
| slice7 | 9.99±2.14s | 10.1±2.4s | 47.4±7.1s | 0.65s | 14.8±1.5s | 46.8±5.4s | 7.74s |
| slice8 | 9.18±2.02s | 9.11±2.13s | 42.1±8.3s | 0.62s | 13.0±0.8s | 44.8±4.9s | 7.26s |
| slice9 | 9.16±2.02s | 9.11±2.11s | 42.4±7.0s | 0.59s | 12.8±0.4s | 44.6±2.3s | 7.21s |

Compare cost is dominated by document size, not edit count: the zero-diff
slices cost nearly as much as the edit-heavy ones on every live engine.

## Findings

1. **Engines.** For ~100-page chunks: native Rust 3.2-4.4 s (CLI), wasm
   7.1-9.2 s mean engine time (the usual ~2-2.5x wasm32 tax), TS port
   37-45 s (5-6x wasm) with peak heap totals near 2 GB (1.9-2.2 GB observed);
   materially larger documents would risk renderer OOM under the TS engine.
2. **Main-thread contention is measurable.** The same wasm engine averages
   7.1 s on the Vue page but 9.2 s on the React pages, where two folio editor
   panes mount concurrently with the compare. The TS engine shows the same
   effect (37.2 s Vue vs 45.1 s React).
3. **Render tiers trade latency for memory.** The React/folio tier retains
   ~200 MB after GC and renders a precomputed redline in 0.74 s; the Vue
   lossless-HTML tier retains only 30-35 MB but pays 6.7-8.2 s render at
   ~173k DOM nodes for the same document. View-only React buys nothing over
   the editable page (9.37 s vs 9.42 s: statistically identical).
4. **Fidelity.** Rust wasm/native are mutually consistent and report zero
   revisions on identical inputs. The TS port emits spurious revisions on
   identical-content pairs and drops revisions on edit-heavy pairs (see parity
   table); its wall time is also insensitive to actual edit count.
5. **Load is a non-story.** All pages load in ~200-250 ms with FCP ~200 ms on
   the Vue tier; engine compare and result rendering dominate everything.

## Reproducing

```sh
# 1. Cut aligned slices from the dissertation demo pair (outside the repo;
#    needs python-docx). Cuts at matched-paragraph decile boundaries via
#    difflib.SequenceMatcher; see bench-redline3-stats.mjs header for the
#    expected file layout: sliceK-{a,b,redline}.docx + manifest.json.
# 2. Precompute the native redlines per slice:
#    jubarte -b sliceK-a.docx -m sliceK-b.docx -o sliceK-redline.docx --force
# 3. Run:
SLICES_DIR=/path/to/slices REPS=3 node bench-redline3-stats.mjs
```

Raw per-run rows (JSONL) and the aggregated summary JSON are written under
`OUT_DIR` (default `bench-results/`, gitignored by absence: do not commit
corpus-derived outputs).

## Caveats

- Single machine, single browser build; absolute numbers move with hardware,
  but the ratios (wasm vs ts, React vs Vue tier) were stable across all reps.
- Native page rows benchmark the precompute-serving path, by design; they say
  nothing about native compare latency (measured separately at the CLI).
- The dissertation slices contain no tables, so the TS engine's known
  table-document defect is not exercised here.
- Deployed-site page assets come over the network (load column includes CDN
  variance); fixture bytes are served locally via route interception.
