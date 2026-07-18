---
"@stll/folio-core": patch
---

Fix five review findings: decodeURIComponent crash on bare-% SVG data URLs, undeclared w16du namespace on header/footer/note serializer roots, dropped w16du:dateUtc on hyperlink-nested tracked changes, textbox corruption inside deleted fields, and quote-aware CSV parsing in the corpus sweep test.
