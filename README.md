# @stll/folio

A modern `.docx`-compatible document editor for the browser, built on
ProseMirror and React.

Folio renders and edits OOXML/DOCX documents on a paged WYSIWYG canvas with
metric-compatible fonts, tracked changes, headers and footers, tables, comments,
template directives, and headless primitives for AI suggestions, citations, and
anonymization. The document core is framework-neutral; the React components are a
thin layer on top.

```tsx
import { DocxEditor } from "@stll/folio";
import "@stll/folio/editor.css";

export function Editor({ docx }: { docx: ArrayBuffer }) {
  return <DocxEditor source={docx} />;
}
```

## Install

```sh
bun add @stll/folio
```

Folio expects React (and an i18n runtime) to be provided by the host app:

```sh
bun add react react-dom use-intl
```

## Exports

- `.` — the React editor (`DocxEditor`, `FormattingBar`, `FolioUIProvider`) plus
  everything re-exported from `./core`.
- `./core` — the framework-neutral editor core: the DOCX ↔ document model,
  markdown bridge, and headless ProseMirror plugins (AI suggestions, citations,
  anonymization, template directives, autocomplete). No React in the import
  graph, so non-React adapters can build on it.
- `./markdown` — the DOCX document ↔ Markdown converter (`toMarkdown`,
  `fromMarkdown`).
- `./server` — DOM-free helpers a server needs to mint block ids that round-trip
  through the editor (`deriveBlockId`, `createEmptyDocument`, `createDocx`).
- `./editor.css` — the single bundled stylesheet. Import it once; it carries all
  editor styling and `@import`s the bundled document fonts from `@fontsource/*`
  (installed as dependencies), so no external network requests are made.

## Peer dependencies

- `react` ^19
- `react-dom` ^19
- `use-intl` >=4

## License

Apache-2.0
