# Jubarte parse-parity notes

Status: **all 41 parity fixtures pass** (`bun test src/docx/jubarte`), plus
synthetic stress cases (multi-row vertical merges with gridSpan, OMML math,
smartTag, break/hyphen run content, VML text-watermark headers) in
`__tests__/synthetic.parity.test.ts`. The full `src/docx` suite (854 tests)
is green and `bun run typecheck` (tsconfig.build.json) is clean.

## Recovery architecture (why parity holds against the frozen dist)

Jubarte's reader (mammoth lineage) normalizes away source details folio's
legacy model preserves; team decision was to recover them from the
byte-preserved part text rather than extend the reader. (One scoped reader
fix WAS adopted later as dist 0.4.0 — `<w:sdt>` wrappers are now always
preserved, including checkbox controls and sdtPr-less/self-closing forms,
and attribute-less `<w:hyperlink>` wrappers are kept.) Three layers:

1. **Pure-AST reconstruction** (`astToXml.ts`): every typed AST node is
   rebuilt into the `XmlElement` the legacy parsers consume — structure from
   the AST, property containers from jubarte's `ppr`/`rpr`/`tblpr`/… trees
   via the propShim, verbatim carriers (drawing/pict, mc:AlternateContent,
   OMML, opaque elements, sdtPr) parsed with folio's xmlParser (with
   jubarte's injected `xmlns:*` declarations stripped so `elementToXml` byte
   captures match legacy). Vertical merges are re-expanded from
   `vMergeContinuationCells` by grid-column bookkeeping.
2. **Paired reconstruction** (`pairedXml.ts`, the default path): the parsed
   byte-preserved part is walked as a spine in lockstep with the AST. Every
   raw child must be claimed by the AST stream (kind-verified; text values
   verified), so the AST still fully explains the document. Leaf content
   nodes are emitted from the raw tree — recovering `xml:space`, `w:br`
   `clear`/`textWrapping`, `w:sym`, `w:fldChar`'s `numberingChange`
   `w:original`, `w14:textId`; wrapper shells take the raw element's
   name+attributes — recovering hyperlink `r:id`/`tooltip`/`history`/
   `docLocation` and alternative namespace prefixes; `w:sdtPr`, `w:sdtEndPr`,
   and MS-OE376 sdt sibling range markers are lifted verbatim. The
   reader-flattened constructs are re-lifted from the raw subtree with claim
   accounting:
   - hoisted inline `w:moveFrom`/`w:moveTo` (Word writes `w:name` on the
     range markers, not the wrapper, so jubarte inlines every real-world
     move wrapper);
   - attribute-less `w:hyperlink` (unwrapped by readers before dist 0.4.0;
     the regroup branch remains as a safety net);
   - checkbox controls: the sdt wrapper survives (0.4.0) but the glyph text
     inside the content run is still replaced by a checkbox node — the raw
     `w:t` restores the exact glyph and its `xml:space`;
   - vanished `w:sdt` forms (pre-0.4.0 readers collapsed checkbox sdts and
     dropped sdtPr-less/self-closing ones; the lift branch remains as a
     safety net).
3. **Bail-out**: any divergence the pairing cannot explain raises a bail for
   that container only; it falls back to layer 1 with a warning
   (`raw-part pairing diverged`). Recovery degrades, never mis-assigns.

Out-of-band parts:
- **Notes** are interpreted from the byte-preserved footnotes/endnotes parts
  with the legacy `parseFootnotes`/`parseEndnotes` (jubarte drops `w:type`,
  omits separator notes entirely, and has no node kind for note-body
  `w:footnoteRef`/`w:separator` marks).
- **Comments**: wrapper attributes (id/author/initials/date) come from the
  preserved comments.xml (jubarte cannot represent `w:initials=""` vs an
  absent attribute); bodies pair per-comment against the raw `w:comment`
  element; `dateUtc`/`paraId`/`parentParaId` joins come from the AST;
  `done`/threading via the exported legacy `parseCommentsExtended`.
- **Headers/footers** reparse the preserved part through jubarte as a
  synthetic single-part package (the part's own `.rels` must ride along as
  `word/_rels/document.xml.rels`, otherwise the reader unwraps
  relationship-backed hyperlinks), then pair against the same preserved
  part text. Watermark detection, `rawWatermarkXml` capture, and picture
  watermark anchoring mirror legacy `parseHeader`.
- The body-final `<w:sectPr>` arrives naturally through body pairing; the
  pure-AST fallback recovers it via `extractFinalSectPrXml` (prefix-agnostic,
  depth-aware, body-trailing-only scan in readPackage.ts).

## Known residual limitations (none hit by the corpus)

- When pairing bails for a container, the fallback infers `xml:space` from
  edge whitespace, loses `textId` for paraId-less paragraphs, and emits the
  standard Word glyph (not the source glyph/rPr) for checkbox nodes; the
  bail warning names the trigger. Bails observed during development came from
  unhandled raw kinds and were fixed by extending the pairing tables
  (`tcPr` in cells, `w:annotationRef`, block-level `oMathPara`).
- `w:comment` bodies containing tables are dropped by the LEGACY parser
  (only `w:p` children are walked); the adapter matches that.
- Legacy skips `w:customXml` wrappers at paragraph level; jubarte's handling
  of them is untested in the corpus (a pairing bail would surface it).

## Legacy exports added (no behavior change)

- `buildSections` in `docx/documentParser.ts`.
