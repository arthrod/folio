/**
 * @stll/premirror-bridge — folio-side bridge to the vendored premirror stack.
 *
 * Exposes the pretext-backed SegmentFitEngine for folio's measurement seam
 * (see `@stll/folio-core` layout-engine/measure/segmentFit.ts). Install at a
 * composition root:
 *
 *   setSegmentFitEngine(pretextSegmentFitEngine);
 *   globalThis.__folioFeatureFlags = { segmentFitLineBreaking: true };
 */

export { pretextSegmentFitEngine, clearPreparedCache, preparedCacheSize } from "./pretextEngine";
