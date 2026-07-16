# Jubarte save-path parity notes

Status: **all fixtures green** — 21 parity fixtures × (legacy self-parity +
plain + mutation + part-level separator fidelity) plus 2 editor-created-content
cases and the focused unit suite. Harness:
`__tests__/saveDocx.parity.test.ts` (cross-engine model parity via the legacy
parser) and `__tests__/saveDocx.test.ts` (stamping, contract, RepackOptions,
fidelity gate, createDocx). Fixture set: 8 eigenport `review-fixtures/*.docx`,
folio visual `sample`/`docx-editor-demo`/`podily-bps`, 6 SDT-heavy corpus
picks, both `regressions/*.docx`, and 2 eigenport e2e note fixtures
(`footnote-bottom-overflow`, `endnotes-tracked-changes` — the only fixtures
with CONTENT notes; the rest carry separator-only note parts the model does
not retain).

## Runtime imports: ZERO from `docx/serializer/*` and `docx/rezip.ts`

The legacy fragment emitters the save path rides on are PORTED, not imported:
`docx/jubarte/emit/` holds self-contained copies of folio's legacy serializers
(xmlUtils, border, run (+drawing/shape), paragraph (+content dispatcher),
table (+grid), sectionProperties, blockSdt, comment, headerFooter (+watermark
synthesis), numbering) plus ports of the `rezip.ts` passes whose module pulls
in the serializer tree (relsUtils, images, hyperlinks, packaging =
materialization + watermark rebinding + comment packaging transforms,
packageMaintenance = core-props + empty scaffold + fidelity gate). Verified by
walking the transitive runtime import graph of `saveDocx.ts` + `toAst.ts`
(44 modules): the only modules reachable outside `docx/jubarte/` are
serializer-free parser-side utilities — `commentReplyMarkers`, `encryption/*`,
`headerFooterRefParser`, `headerFooterVerbatim`, `metafileRaster`,
`modelValidation`, `notePropertiesParser`, `numberingParser`, `parserEnums`,
`relsParser`, `sdtPropertiesPatch`, `sectionParser`, `selectiveXmlPatch`,
`unzip`, `xmlParser`, `types/*`, `utils/hexId`, `utils/tiffConverter` — plus
`jszip`, `better-result`, `fast-xml-parser`, `utif2`, `valibot`,
`@arthrod/jubarte`, `@stll/docx-core`, `@stll/docx-utils`. Deleting
`docx/serializer/*` and `rezip.ts` does not affect this path; the harness
itself still imports the legacy `repackDocx`/`parseDocx` as the comparison
baseline and is deleted together with the legacy code once the swap lands.

## Verdicts reused from the eigen port (re-verified here)

- **Trailing body `<w:sectPr>` is byte-preserved by jubarte's writer** in both
  write paths, so model edits to `finalSectionProperties` never land via the
  AST. `saveDocx.ts#replaceTrailingSectPr` post-processes the emitted
  `word/document.xml`, replacing the trailing sectPr with the ported
  `serializeSectionProperties(finalSectionProperties)` unconditionally.
- **`w14:paraId`/`w14:textId` are dropped on every regenerated paragraph.**
  Fixed by the ledger + re-stamp pass: `toAst.ts` records one
  `ParagraphTagExpectation` per `<w:p` start tag the part will contain
  (`typed` = re-stamp from the model; `opaque` = tags inside verbatim
  carriers, skipped untouched) and `saveDocx.ts#stampParagraphTags` rewrites
  the output part. Count mismatch ⇒ warn and skip (never corrupt). Applied to
  `word/document.xml`, header/footer parts, and per-note in
  `footnotes.xml`/`endnotes.xml`. Verified at scale: podily-bps re-stamps all
  615 paraIds to the exact legacy set. Stamping is gated on the part
  declaring `xmlns:w14`.
- **Typed move surface is broken on BOTH jubarte sides** (reader hoists
  wrappers, writer emits schema-invalid `w:name` on wrappers) — tracked-change
  wrappers and move range markers ride as verbatim fragments emitted by the
  ported `serializeParagraphContent` (also preserving folio's delText
  rewriting and `w:name`-on-range-markers layout). `06-moves.docx` green.
- **Note sidecar writer drops `continuationNotice` separators** (it only
  byte-preserves `separator`/`continuationSeparator`).
  `saveDocx.ts#restampNotesPart` splices the missing separator-kind notes back
  BYTE-EXACT from the ORIGINAL part (folio's model retains only normal notes,
  so unlike eigen there is no model-side separator list to serialize from).
  Because the parser drops separators from the model, the reparse diff cannot
  see them — the harness adds a part-level suite asserting both saves keep the
  same separator-type multiset (exercised by podily-bps: 6 separator-kind
  notes).
- **astToDocx output may be Uint8Array/Buffer (node) or Blob (browser)** —
  normalized in `outputToArrayBuffer`.
- **`opaque-body-passthrough` diagnostics throw loudly** (edits would be
  silently dropped); other non-info diagnostics are logged.

## Folio-specific deltas (vs the eigen reference implementation)

1. **Comments are deterministic — no harness normalization at all.** folio's
   legacy comment serializer preserves body-paragraph `w14:paraId`s from the
   model and mints ids only for THREADED comments via
   `ensureThreadedCommentParaIds` (content-derived `deterministicHexId`), and
   it writes no durableIds. The `legacy save self-parity` suite is green with
   zero normalization (eigen needed comment-paraId stripping; folio does not).
2. **Comment sidecars are rewritten post-write with folio's exact legacy
   serialization** (`rewriteCommentSidecars`): jubarte regenerates all four
   comment sidecars from the mapped AstComments, but folio's legacy save (a)
   writes `comments.xml` with its own serializer — including the empty
   `<w:comments/>` overwrite when the last comment was deleted and the part
   existed, (b) writes `commentsExtended.xml` ONLY when replies/resolved state
   exists and otherwise REMOVES the part + its `[Content_Types]` override +
   its relationship, and (c) never touches `commentsIds.xml` /
   `commentsExtensible.xml`. The post-pass replays exactly that on the output
   zip: legacy-serialized comments.xml + packaging ensure, extended-part
   write-or-remove, and byte-restore (or scrub, with packaging cleanup) of
   ids/extensible against the ORIGINAL package. The mapped AstComments remain
   in the AST so the writer's body anchor bookkeeping stays consistent.
3. **Both hard gates ported and enforced**: `assertValidFolioDocumentModel`
   (imported from `modelValidation.ts` — serializer-free) throws before any
   write; `assertDocumentPackageFidelity` (ported) runs in post-process on the
   FINAL `word/document.xml` (after sectPr replacement) against the original
   part text and throws `DocxPackageFidelityError` — unit-tested by stripping
   header references from sample.docx (legacy `repackDocx` throws identically;
   also proven for `createDocx` without `finalSectionProperties`, where BOTH
   engines refuse with the same error).
4. **Output part sanitation**: the legacy save copies only entries passing
   `isPreservableDocxEntry` (safe paths, allowlisted media MIME types, XML
   parts under known roots — e.g. `docProps/thumbnail.jpeg` is dropped);
   jubarte byte-preserves everything, so the post-pass applies the same filter
   to the output zip. Caught by the harness's part-name-set assertion on
   sample.docx.
5. **Headers/footers**: regenerated per part via the synthetic-package emit
   trick, but with folio's `serializeHeaderFooter` semantics layered on top —
   verbatim replay (`getHeaderFooterVerbatimXml` +
   `canReplayHeaderFooterVerbatim`) short-circuits the whole part;
   otherwise the watermark paragraph (raw `rawWatermarkXml` or the ported
   synthesizer) is inserted at `watermarkBlockIndex` by emitting the
   before/after block segments through separate synthetic packages; folio's
   full HF namespace set (incl. `a`/`pic` for DrawingML watermark replay) is
   declared on the root; mandatory `<w:p><w:pPr/></w:p>` fallback.
   `hasUnmaterializedHeaderFooter` semantics honored via the ported
   materialization pass (part + relationship under the existing rId +
   content-type override, rId collision remapping) — exercised by the
   "unmaterialized footer" harness case.
6. **Picture-watermark rebinding** (`rebindWatermarkRelIds`) ported verbatim
   and run against the package graph BEFORE header emission (the synthesized
   `<v:imagedata r:id>` reads `imageRId`).
7. **New images/hyperlinks**: folio's `processNewImages` (with
   tracked-change-wrapper descent and per-part HF rels) and
   `processNewHyperlinks` ported verbatim, run against the graph shim.
   Verified by the "new image + new hyperlink" harness case — which also
   proves jubarte's writer preserves shim-written `.rels`/media part text
   (the writer does not regenerate rels from its relationships record).
8. **Numbering**: folio has no `ensureNumberingPart` — its legacy full repack
   splices only CHANGED `w:abstractNum`/`w:num` definitions by id into the
   byte-preserved `word/numbering.xml` (change detected against a
   reparse/re-serialize baseline). `spliceNumberingIntoGraph` ports exactly
   that, pre-write, against the graph (like legacy, it does NOT create a
   missing numbering part).
9. **Notes**: folio's model has no `verbatimXml` on notes (no eigen-style
   verbatim splice) and no separator list — see the separator splice-back
   verdict above. Content notes are regenerated by jubarte from
   `mapNotesToAst` and re-stamped per note.
10. **RepackOptions parity**: `compressionLevel` (final zip DEFLATE level),
    `updateModifiedDate` (byte-identical core.xml when false), `modifiedBy`
    (only applied when `updateModifiedDate` is true, mirroring legacy) — all
    unit-tested against legacy output. Note the shared legacy quirk is
    reproduced: a SELF-CLOSING `<cp:lastModifiedBy/>` is not rewritten by
    `updateCoreProperties` (its regex only matches the open/close form).
11. **`createDocxWithJubarte`** keeps the legacy shape (empty scaffold +
    repack). DEVIATION in the ported scaffold: its `word/document.xml` root
    declares the legacy document serializer's full canonical namespace set
    (+ `mc:Ignorable="w14 w15 wp14"`) instead of the legacy scaffold's bare
    `w`/`r` — jubarte's writer PRESERVES the source root while the legacy
    save rewrites it, so the richer root is what makes the created package
    match legacy output (and keeps paraId re-stamping legal). Reparse parity
    with legacy `createDocx` is asserted in the unit suite.

## Mapping strategy (typed vs verbatim)

Typed jubarte nodes: paragraphs (`ppr` mirrors legacy `serializeParagraph`
assembly — `serializeParagraphFormatting(formatting, propertyChanges,
pPrMark)` inner + mid-doc `serializeSectionProperties` inside one `w:pPr`),
runs (`rpr` = `serializeRunProperties(formatting, propertyChanges)` fragment;
bold/italic/underline/strike flags derived FROM the fragment so the writer's
toggle reconciliation is a no-op), text (when the legacy `xml:space` decision
matches the writer's edge-whitespace rule), tab/line-page-column breaks/soft
hyphens/no-break hyphens, `footnoteRef`/`endnoteRef` → typed noteReference,
comment range markers + the synthesized reference run (folio's
`explicitCommentReferenceIds` rule preserved: the reference run is emitted at
the model's explicit `commentReference` position when present, synthesized
after `commentRangeEnd` otherwise), tables/rows/cells (`tblpr`/`tblgrid`/
`trpr`/`tcpr` = ported legacy fragments incl. `structuralChange`;
`colSpan`/`rowSpan` pinned to 1 so the writer's vMerge ledger never activates).

Verbatim carriers (legacy fragment on `opaqueElement`/`AstDrawing.xml`):
hyperlinks, bookmarks, simple/complex fields, inline SDTs, tracked-change
wrappers, move range markers, `mathEquation` (raw OMML), `w:sym`,
`w:fldChar`/`w:instrText`, textWrapping breaks, drawings (`rawXml` replay or
the ported drawing builder), shapes (`w:pict`), block SDTs
(`serializeBlockSdt` with the legacy block dispatcher).
`renderedPageBreakBefore` injects `<w:lastRenderedPageBreak/>` into the first
run, typed or inside a carrier — mirroring the legacy pending-flag loop.

Comment bodies reproduce the legacy comment serializer's deliberately REDUCED
fidelity (text/break content, bold/italic only, annotationRef run prepended to
the first paragraph, top-level-then-replies ordering, paraIds preserved) —
though the post-write sidecar rewrite makes the comment parts byte-identical
to legacy regardless.

## Residual risks (not observed in any fixture; would surface as parity diffs)

- jubarte preserves the SOURCE `w:document` root (namespace declarations);
  the legacy save rewrites it to a canonical 19-prefix set. Parse-equivalent
  everywhere (prefixes resolve), but an editor-inserted raw fragment using a
  prefix the source root never declared (e.g. `w16sdtdh` in a minimal
  third-party file) would produce an undeclared prefix where legacy would
  not. Not reachable from the current editor surface.
- A table whose ported `tblPr` serializes empty: jubarte still emits
  `<w:tblPr/>` (legacy emits nothing). A table without `columnWidths` gets a
  synthesized bare `<w:tblGrid>`. Parse-equivalent.
- A note or comment with zero paragraphs (the writer would substitute a
  `<w:r><w:t></w:t></w:r>` placeholder) — comment bodies suppress it with an
  empty opaque run, notes never carry zero blocks in the model.
- `updateDocumentXml`/`updateXmlFile`/`updateMultipleFiles`/`addRelationship`
  /`addMedia` (raw-buffer utilities in rezip.ts) are NOT part of this seam —
  they do not serialize the model and can survive or move as-is at swap time.

## Legacy exports added

None. (The parse-side port had added `buildSections`; the save side needed no
new legacy exports — everything else is either already exported or ported.)
