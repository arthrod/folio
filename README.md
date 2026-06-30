<p align="center">
  <img src=".github/assets/banner.png" alt="folio" width="100%" />
</p>

# @stll/folio

A Word-document editor for the browser. It opens a real `.docx`, lets you edit
it, and writes a real `.docx` back — preserving pagination, tables, headers and
footers, tracked changes, and footnotes.

The OOXML parser, document model, and page-layout engine are React-free, so they
run on a server or under any framework. The React editor is one layer on top.

Part of [stella](https://github.com/stella/stella), an open-source legal workspace.

## Install

```sh
bun add @stll/folio react react-dom use-intl
```

## Usage

```tsx
import { DocxEditor } from "@stll/folio";
import "@stll/folio/editor.css";

export function Editor({ docx }: { docx: ArrayBuffer }) {
  return <DocxEditor documentBuffer={docx} onSave={(out) => download(out)} />;
}
```

The editor renders to the DOM; under SSR, load it from a client-only/dynamic
import.

## Exports

| Import | What it is |
| --- | --- |
| `@stll/folio` | the React editor and its components |
| `@stll/folio/core` | headless — OOXML parsing, the document model, the layout engine; no React in the import graph, so non-React adapters can build on it |
| `@stll/folio/markdown` | DOCX ↔ Markdown conversion |
| `@stll/folio/server` | DOM-free helpers for server-side use |
| `@stll/folio/editor.css` | the single bundled stylesheet — import once; it `@import`s the document fonts from `@fontsource/*` (installed as deps), so no external network requests |

## Peer dependencies

`react` ^19 · `react-dom` ^19 · `use-intl` >=4

## Acknowledgements

folio began as a private fork of [Eigenpal](https://eigenpal.com)'s
[docx-editor](https://github.com/eigenpal/docx-editor) by
[Jedr Blaszyk](https://github.com/jedrazb). The code has since been extended
(mostly to match the needs of stella). After the upstream repository was taken
down, we're publishing folio in
case the fork is useful to others as well. The original license and copyright are
preserved in [`NOTICE.md`](./NOTICE.md).

## License

[Apache-2.0](./LICENSE)
