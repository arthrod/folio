# @stll/premirror-prosemirror-adapter

ProseMirror adapter for the premirror pagination engine: extracts block and styled-run snapshots from `EditorState`, measures runs via `@chenglou/pretext` (a deterministic stub under `bun test`; see `UPSTREAM.md`), and exposes the premirror runtime plugin plus its invalidation key.

Port of [samwillis/premirror](https://github.com/samwillis/premirror) (MIT © 2026 Sam Willis), via the arthrod/premirror fork and the eigenport furniture extension.

Run tests with `bun test packages/premirror-prosemirror-adapter` from the repo root, or `bun test src` in this directory.
