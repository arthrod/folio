---
"@stll/folio-core": minor
---

Add an experimental segment-fit line-breaking seam to the measurement pipeline (`setSegmentFitEngine`, `__folioFeatureFlags.segmentFitLineBreaking`). Default behavior is unchanged; when a host installs an engine and enables the flag, plain non-justified text runs are fitted from prepared segment widths instead of per-word canvas measurement and `findMaxFittingLength` slice probes. The first engine (pretext-backed) ships in the private `@stll/premirror-bridge` package.
