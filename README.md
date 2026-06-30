<p align="center">
  <img src=".github/assets/banner.png" alt="@stll/folio" width="100%" />
</p>

# folio

A Word-document editor for the browser. It opens a real `.docx`, lets you edit
it, and writes a real `.docx` back — preserving pagination, tables, headers and
footers, tracked changes, and footnotes.

The OOXML parser, document model, and page-layout engine are React-free, so they
run on a server or under any framework. The React editor is one layer on top.

Part of [stella](https://github.com/stella/stella), an open-source legal workspace.

## Packages

This is a [bun](https://bun.sh) workspace monorepo with two published packages:

| Package                                 | What it is                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@stll/folio-core`](./packages/core)   | the headless, framework-neutral core — OOXML parsing, the document model, the ProseMirror integration, and the layout engine; no React in the import graph, so non-React adapters can build on it |
| [`@stll/folio-react`](./packages/react) | the React editor and its components, built on `@stll/folio-core`                                                                                                                                  |

## Install

```sh
# the React editor (pulls in @stll/folio-core)
bun add @stll/folio-react react react-dom use-intl

# or just the headless engine
bun add @stll/folio-core
```

## Usage

```tsx
import { DocxEditor } from "@stll/folio-react";
import "@stll/folio-react/editor.css";

export function Editor({ docx }: { docx: ArrayBuffer }) {
  return <DocxEditor documentBuffer={docx} onSave={(out) => download(out)} />;
}
```

The editor renders to the DOM; under SSR, load it from a client-only/dynamic
import.

## Development

```sh
bun install
bun run build       # builds both packages (core first)
bun run typecheck
bun run test        # unit suite for both packages
bun run lint
bun run validate-dist   # clean-room publish-shape validation for both packages
```

## Acknowledgements

folio began as a private fork of [Eigenpal](https://eigenpal.com)'s
[docx-editor](https://github.com/eigenpal/docx-editor) by
[Jedr Blaszyk](https://github.com/jedrazb). The code has since been extended
(mostly to match the needs of stella). After the upstream repository was taken
down, we're publishing folio in case the fork is useful to others as well. The
original license and copyright are preserved in [`NOTICE.md`](./NOTICE.md).

## License

[Apache-2.0](./LICENSE)
