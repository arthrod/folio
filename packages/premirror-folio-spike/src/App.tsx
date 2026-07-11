import { ProseMirror, ProseMirrorDoc, reactKeys } from "@handlewithcare/react-prosemirror";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@premirror/core";
import { createPremirror } from "@premirror/prosemirror-adapter";
import {
  buildFragmentDecorations,
  type PageLayoutMode,
  PremirrorPageViewport,
  usePremirrorEngine,
} from "@premirror/react";
import { parseDocx } from "@stll/folio-core/docx/parser";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorState, type Transaction } from "prosemirror-state";
import { useCallback, useEffect, useMemo, useState } from "react";

import { docToPmDoc } from "./docToPm";
import { spikeSchema } from "./schema";

export function App() {
  const options = useMemo(() => defaultPremirrorOptions(), []);
  const runtime = useMemo(() => createPremirror(options), [options]);
  const layoutInput = useMemo(() => createLayoutInputFromOptions(options), [options]);

  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pageLayoutMode] = useState<PageLayoutMode>("single");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("sample.docx");
        const buffer = await resp.arrayBuffer();
        const document = await parseDocx(buffer);
        if (cancelled) return;
        const { doc, skippedBlocks } = docToPmDoc(document, spikeSchema);
        setSkipped(skippedBlocks);
        setEditorState(
          EditorState.create({
            schema: spikeSchema,
            doc,
            plugins: [
              reactKeys(),
              history(),
              keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
              keymap(baseKeymap),
              ...runtime.plugins,
              ...runtime.keymaps,
            ],
          }),
        );
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  const engine = usePremirrorEngine(
    editorState
      ? { editorState, runtime, layoutInput }
      : {
          editorState: EditorState.create({ schema: spikeSchema }),
          runtime,
          layoutInput,
        },
  );

  const fragmentDecorations = useMemo(
    () =>
      editorState ? buildFragmentDecorations(editorState.doc, engine.layout, pageLayoutMode) : null,
    [editorState, engine.layout, pageLayoutMode],
  );

  const dispatch = useCallback((tr: Transaction) => {
    setEditorState((s) => (s ? s.apply(tr) : s));
  }, []);

  if (error) return <pre style={{ color: "crimson", padding: 24 }}>{error}</pre>;
  if (!editorState || !fragmentDecorations) {
    return <p style={{ padding: 24 }}>Parsing sample.docx…</p>;
  }

  return (
    <div style={{ padding: 24, background: "#f1f5f9", minHeight: "100vh" }}>
      <header style={{ marginBottom: 12, font: "14px system-ui" }}>
        <strong>folio → premirror single-contenteditable spike.</strong> DOCX parsed by
        @stll/folio-core; body text composed by @premirror/composer; ONE visible ProseMirror,
        fragments projected by decorations. Native caret/selection/IME — no hidden PM, no painted
        overlay.
        {skipped.length > 0 && (
          <em> Skipped non-paragraph blocks: {skipped.join(", ")} (spike non-goal).</em>
        )}
      </header>
      <PremirrorPageViewport
        layout={engine.layout}
        pageLayoutMode={pageLayoutMode}
        editorLayer={
          <ProseMirror
            state={editorState}
            dispatchTransaction={dispatch}
            decorations={() => fragmentDecorations}
          >
            <ProseMirrorDoc />
          </ProseMirror>
        }
      />
    </div>
  );
}
