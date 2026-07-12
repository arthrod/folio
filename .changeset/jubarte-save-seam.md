---
"@stll/folio-core": major
---

Replace the hand-written OOXML de/serializer with the jubarte engine. `parseDocx`, `repackDocx`, `createDocx`, and `attemptSelectiveSave` keep their signatures but now run on `@arthrod/jubarte` (lossless AST, byte-preserved package graph, block-patching writer). Removed: the `docx/serializer/*` string serializers and `selectiveXmlPatch`-based paragraph splicing (selective save now returns the full jubarte save instead of bailing to a caller-side repack). Save output canonicalizes the document root namespace declarations and materializes numbering-level indentation into list paragraphs; untouched parts remain byte-preserved.
