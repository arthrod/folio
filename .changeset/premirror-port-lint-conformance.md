---
"@stll/folio-core": patch
---

Lint conformance, no behavior change: the jubarte wasm engine wrappers return
explicit promises (sync wasm throws still surface as rejections), and the
deleted-drawing placeholder regex documents its deliberate NUL sentinel.
