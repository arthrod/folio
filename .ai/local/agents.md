## Repository Specifics

folio is a Bun-first TypeScript monorepo: a Word-document (`.docx`) editor for
the browser, built on ProseMirror. Two published packages plus a dev playground:

- `@stll/folio-core` (`packages/core`) — the headless engine: OOXML parsing, the
  document model, the ProseMirror integration, and the page-layout engine. It is
  **framework-neutral and must stay React-free** (enforced by the
  `react-free-core` + `model-purity` arch tests and the clean-room dist check).
- `@stll/folio-react` (`packages/react`) — the React editor: a thin renderer over
  folio-core. UI logic lives in core managers; the hooks are thin bindings.
- `packages/playground` — a private Vite app that mounts the editor for the
  visual + interaction e2e tests; not published.

### Commands

- `bun install`
- `bun run build` (core first, then react)
- `bun run typecheck`
- `bun run test` (unit suites, both packages)
- `bun run lint`
- `bun run validate-dist` (clean-room publish-shape check)
- `bun run test:interactions` (Playwright behaviour e2e via the playground)
- `bun run test:differential` (folio vs python-docx parse parity; full corpus)
- `bun run format` (oxfmt)

### Working Rules

- **Keep `@stll/folio-core` React-free.** Never import `react`/`react-dom` (or a
  React-package type) into `packages/core`. Framework-agnostic UI logic belongs in
  a core manager (`extends Subscribable`, which documents both a React
  `useSyncExternalStore` and a Vue `watchEffect` binding); the React hook is a
  thin binding only. Declare a minimal structural type in core rather than
  importing one from the React package.
- **Preserve upstream attribution.** folio is a fork of the Eigenpal docx-editor
  (see `NOTICE.md`). `NOTICE.md`, `LICENSE`, and the `eigenpal` / `docx-editor`
  attribution comments must stay verbatim — never scrub them.
- **Fix pre-existing bugs you find** (separate commit) rather than preserving
  known-wrong behaviour to "keep behaviour identical".
- Behaviour is guarded by the interaction e2e suite and the python-docx
  differential parity gate — extend them when you change parsing, layout, or
  editor interactions.
- Return minimal data from public APIs; do not export types that have no consumer.
