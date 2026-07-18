#!/usr/bin/env bash
# Vendor the browser-target jubarte comparer wasm into the redline tool.
#
# The comparer engine and its wasm adapter are benchmark-owned by design
# (GET_JUBARTE_RUST.md): source in ~/T/jubarte-redlines, adapter crate in
# neurotic_docx_bench. This script rebuilds the browser (`--target web`)
# artifact and copies the glue + wasm into src/redline/jubarte-wasm/ and a
# demo comment fixture pair into public/redline/. The .wasm and .docx are
# git-ignored (generated/external); this script regenerates them.
set -euo pipefail

BENCH="${NEUROTIC_BENCH:-$HOME/T/neurotic_docx_bench}"
ADAPTER="$BENCH/src/neurotic_docx_bench/utils/jubarte/jubarte-wasm"
CORPUS="$BENCH/corpus/word_based/docx_source"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/redline/jubarte-wasm"
PUBLIC="$(cd "$(dirname "$0")/.." && pwd)/public/redline"

echo "▶ building browser-target wasm from $ADAPTER"
( cd "$ADAPTER" && wasm-pack build --target web --release --out-dir pkg-web )

mkdir -p "$DEST" "$PUBLIC"
cp "$ADAPTER/pkg-web/jubarte_wasm.js" "$DEST/"
cp "$ADAPTER/pkg-web/jubarte_wasm_bg.wasm" "$DEST/"
cp "$ADAPTER/pkg-web/jubarte_wasm.d.ts" "$DEST/"
cp "$ADAPTER/pkg-web/jubarte_wasm_bg.wasm.d.ts" "$DEST/"

# Demo pair: two documents that both carry (threaded) comments so the tool's
# comment-carryover path is exercised out of the box.
cp "$CORPUS/docx_lots_of_comments_addition.docx" "$PUBLIC/base.docx"
cp "$CORPUS/docx_lots_of_comments.docx" "$PUBLIC/revised.docx"

echo "✓ vendored wasm → $DEST and demo fixtures → $PUBLIC"

# Newer wasm-bindgen glue carries Deno-style @ts-self-types, which tsc ignores;
# mark the generated file ts-nocheck so playground typecheck skips it.
if ! head -1 "$DEST/jubarte_wasm.js" | grep -q ts-nocheck; then
  printf '// @ts-nocheck — wasm-bindgen generated glue; typed via jubarte_wasm.d.ts\n%s' "$(cat "$DEST/jubarte_wasm.js")" > "$DEST/jubarte_wasm.js"
fi
