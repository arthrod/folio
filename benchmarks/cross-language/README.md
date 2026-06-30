# Cross-language parse benchmark

A context comparison for folio's DOCX parser against implementations in other
languages — separate from the in-process JS suite (`../`, tinybench + CodSpeed).

Where the JS suite answers _"did this PR regress folio?"_, this answers _"where
does a JS DOCX parser sit beside native (Rust) and interpreted (Python)
implementations, and what bar should the planned folio-core Rust rewrite
clear?"_ It is **on-demand and documented, not a CI regression gate** (the
runtimes differ, so CodSpeed — which is JS-only — doesn't apply).

## Run

```sh
# 1. python-docx (optional): pip install python-docx
# 2. docx-rs (optional):     cargo build --release   # in ./rust
bun benchmarks/cross-language/run.ts
```

Each parser self-times a parse loop over the same fixtures (small/medium/large
from `tests/visual/fixtures`) and emits median ms per parse; the runner
tabulates them. Any toolchain that's missing is skipped with a note rather than
failing the run.

## Method + caveat

This measures **parse cost, not equivalence** — the libraries build different
things from the same bytes:

- **folio** — a full, editable document model (the richest, and JS).
- **docx-rs** — a structured Rust model.
- **python-docx** — a lazy `lxml`/C-backed element tree (does the least eagerly,
  which is why it often looks fastest).

So treat the columns as "how much work each library does to read a `.docx`,"
not a like-for-like race.

## Indicative numbers

Machine-specific (Apple silicon, run it yourself for your hardware), median ms
per parse:

| fixture | folio · JS | python-docx | docx-rs · Rust |
| ------- | ---------- | ----------- | -------------- |
| small   | ~9         | ~1.3        | ~1.6           |
| medium  | ~31        | ~3.8        | ~7.6           |
| large   | ~105       | ~12         | ~28            |

docx-rs (Rust) parses a large document ~4× faster than folio-JS — the bar the
folio-core rewrite should clear.

## Round-trip fidelity — why folio can't just adopt docx-rs

An editor must re-serialize exactly what it parsed (lossless round-trip).
docx-rs **cannot**: `read_docx → build → pack` panics on all three fixtures with
`internal error: entered unreachable code` (`run.rs:370`). Its reader and writer
are separate, misaligned models — the reader produces `RunChild::InstrTextString`
(from `w:instrText`, the instruction text inside fields: page numbers, TOC,
cross-references, dates — ubiquitous), and the writer has `=> unreachable!()` for
it. So docx-rs is an excellent parse-speed reference, but its model is not a
foundation folio can build an editor on. The reusable layer is one level down:
`quick-xml`, the XML reader docx-rs is built on.

Reproduce: `cargo build --release` in `./rust`, then
`bun benchmarks/cross-language/roundtrip-check.ts`.
