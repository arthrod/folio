# @stll/premirror-composer

Layout composer for the premirror pagination engine: turns a measured document snapshot from `@stll/premirror-core` into pages, frames, line boxes, and placed runs, including header/footer page furniture. Text measurement goes through an injected `SegmentFitEngineLike` (`LayoutInput.engine`; e.g. `@stll/premirror-bridge`'s pretext-backed engine) with deterministic fallbacks when no engine is present — this package never imports a concrete measurement engine (E-4 one-pretext-surface invariant; see `UPSTREAM.md`).

Port of [samwillis/premirror](https://github.com/samwillis/premirror) (MIT © 2026 Sam Willis), via the arthrod/premirror fork and the eigenport furniture extension.

Run tests with `bun test packages/premirror-composer` from the repo root, or `bun test src` in this directory. `bun run benchmark` runs the compose benchmark.
