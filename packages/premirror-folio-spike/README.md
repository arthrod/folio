# folio → premirror single-contenteditable spike

Phase 3 of `the premirror port plan (mirrored from arthrod/eigenport)`.

A **text-only** DOCX (`public/sample.docx`, from `tests/visual/fixtures/`) is parsed
by `@stll/folio-core`'s `parseDocx`, mapped to a ProseMirror doc
(`src/docToPm.ts` — paragraphs + bold/italic runs; every other block kind is
skipped and reported), composed into pages by `@premirror/composer` with real
`@chenglou/pretext` measurement, and rendered through **one visible
contenteditable** with fragments projected by `buildFragmentDecorations`
(`@premirror/react`).

```sh
bun run --filter @stll/premirror-folio-spike dev   # from the repo root
```

## Why this exists

Eigen's dual rendering (hidden PM at `left:-9999px` + static painter) is the
root cause of the IME caret anchor hacks, the invisible y-cursor remote
carets, the hand-painted selection overlay, focus-stealing, and the
accessibility hole. This spike is the counter-architecture: the editor the
user sees IS the ProseMirror view.

## Evaluation checklist (plan Phase 3 step 3)

Record pass/fail per item against this spike before the Phase 4 gate:

- [ ] **Native caret & selection** — no `useSelectionOverlay` equivalent
      anywhere in this app; selection is the browser's.
- [ ] **IME composition** at a page/fragment boundary (CJK input mid-page and
      at the last line of a page) — the `folio's selection-overlay + hidden-PM pain points` pain case.
- [ ] **Remote carets**: wire `yCursorPlugin` (the collab playground
      pattern) — decorations should be VISIBLE by construction, no
      `RemoteSelectionOverlay` repaint layer.
- [ ] **Screen reader**: VoiceOver announces page content (vs silence on the
      hidden-PM architecture).
- [ ] **Focus behavior**: toolbar-less here, but clicks inside pages must not
      need `stopPropagation` gymnastics.
- [ ] **Typing at fragment boundaries** under PM's DOMObserver: type at the
      end of a page, backspace across a page break, Enter mid-paragraph —
      no ghost characters, no caret jumps (the genuinely unproven mechanic).
- [ ] **Geometry sanity vs painter**: same fixture through the eigen editor;
      compare line breaks per paragraph (exactness is a Phase 4 gate item,
      Word is the referee).

## Explicit non-goals (per plan)

Tables, images, headers/footers, footnotes, sections/columns, floats,
tracked changes, comments. Non-paragraph blocks in the fixture are dropped
and listed in the header bar.
