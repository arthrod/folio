import { Toolbar } from "@base-ui-components/react/toolbar";
import { Switch } from "@base-ui-components/react/switch";
import { ProseMirror, ProseMirrorDoc, reactKeys } from "@handlewithcare/react-prosemirror";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@premirror/core";
import { createPremirror } from "@premirror/prosemirror-adapter";
import {
  buildFragmentDecorations,
  type PageLayoutMode,
  PremirrorPageViewport,
  usePremirrorEngine,
  useProjectedSelection,
} from "@premirror/react";
import { keymap } from "prosemirror-keymap";
import { EditorState, Selection, type Transaction } from "prosemirror-state";
import { baseKeymap, joinBackward, selectNodeBackward, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";

import { LuBold, LuItalic, LuCode, LuSeparatorHorizontal, LuGithub } from "react-icons/lu";

import { demoSchema } from "./schema";

function buildInitialState(runtime: ReturnType<typeof createPremirror>): EditorState {
  const strong = demoSchema.marks.strong;
  const em = demoSchema.marks.em;
  const code = demoSchema.marks.code;
  if (!strong || !em || !code) {
    throw new Error("demoSchema missing basic marks");
  }

  const fixtureParagraphs = [
    "Premirror Milestone 1 test document. This paragraph is intentionally long so we can validate word wrapping inside the composed frame. The quick brown fox jumps over the lazy dog while pagination logic tracks run boundaries and maps document ranges to absolute fragment positions.",
    "Second paragraph for wrapping and flow. We expect lines to break naturally at word boundaries and continue on subsequent lines before moving to the next page frame. This should mimic a word-processor style reading flow rather than a single scroll box.",
    "Third paragraph adds more content pressure. Layout metrics should increase pages when required, and each line fragment should remain fully inside the page content rect with no orphan leading character rendered outside its decorated run.",
    "Fourth paragraph repeats structured prose to force pagination. Typography and measured widths from pretext should drive deterministic line breaks. Selection and caret mapping should still align with these visual fragments.",
    "Fifth paragraph: the architecture keeps ProseMirror as source of truth while decorations project fragments into absolute page coordinates. This gives us editable rich text with page-aware rendering behavior.",
    "Sixth paragraph closes the synthetic test fixture. If everything works, we should see multiple pages and no inner frame scrolling. Wrapping should remain stable across refreshes.",
  ];
  const repeated = Array.from({ length: 7 }, (_, i) =>
    fixtureParagraphs.map((text) => `${text} Section ${i + 1}.`),
  ).flat();
  const docNodes = repeated.flatMap((text, i) => {
    const paragraph = demoSchema.node("paragraph", null, [demoSchema.text(text)]);
    if ((i + 1) % 3 === 0) {
      return [paragraph, demoSchema.node("paragraph")];
    }
    return [paragraph];
  });
  const doc = demoSchema.node("doc", null, docNodes);

  return EditorState.create({
    doc,
    schema: demoSchema,
    plugins: [
      reactKeys(),
      history(),
      ...runtime.plugins,
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
        "Mod-b": toggleMark(strong),
        "Mod-i": toggleMark(em),
        "Mod-`": toggleMark(code),
        ArrowLeft: (state, dispatch) => {
          if (!state.selection.empty) return false;
          const pos = state.selection.from;
          if (pos <= 1) return false;
          if (!dispatch) return true;
          dispatch(
            state.tr.setSelection(Selection.near(state.doc.resolve(pos - 1), -1)).scrollIntoView(),
          );
          return true;
        },
        ArrowRight: (state, dispatch) => {
          if (!state.selection.empty) return false;
          const pos = state.selection.from;
          const max = Math.max(1, state.doc.content.size);
          if (pos >= max) return false;
          if (!dispatch) return true;
          dispatch(
            state.tr.setSelection(Selection.near(state.doc.resolve(pos + 1), 1)).scrollIntoView(),
          );
          return true;
        },
        Backspace: (state, dispatch) => {
          if (!state.selection.empty) return false;
          const { $from } = state.selection;
          if ($from.parent.isTextblock && $from.parentOffset === 0) {
            if (joinBackward(state, dispatch)) return true;
            if (selectNodeBackward(state, dispatch)) return true;
          }
          const pos = state.selection.from;
          if (pos <= 1) return false;
          if (!dispatch) return true;
          dispatch(state.tr.delete(pos - 1, pos).scrollIntoView());
          return true;
        },
      }),
      keymap(baseKeymap),
      ...runtime.keymaps,
    ],
  });
}

export function App(): ReactElement {
  const options = useMemo(() => {
    const defaults = defaultPremirrorOptions();
    return {
      ...defaults,
      typography: {
        ...defaults.typography,
        defaultFont: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      },
    };
  }, []);
  const runtime = useMemo(() => createPremirror(options), [options]);
  const layoutInput = useMemo(() => createLayoutInputFromOptions(options), [options]);

  const [editorState, setEditorState] = useState(() => buildInitialState(runtime));
  const [showDebug, setShowDebug] = useState(false);
  const [pageLayoutMode, setPageLayoutMode] = useState<PageLayoutMode>("spread");

  const { layout, diagnostics } = usePremirrorEngine({
    editorState,
    runtime,
    layoutInput,
  });

  const projection = useProjectedSelection(editorState, layout, pageLayoutMode);
  const fragmentDecorations = useMemo(
    () => buildFragmentDecorations(editorState.doc, layout, pageLayoutMode),
    [editorState.doc, layout, pageLayoutMode],
  );

  const dispatch = useCallback((tr: Transaction) => {
    setEditorState((s) => s.apply(tr));
  }, []);

  const run = useCallback(
    (fn: (s: EditorState, d?: (tr: Parameters<EditorState["apply"]>[0]) => void) => boolean) => {
      fn(editorState, dispatch);
    },
    [editorState, dispatch],
  );

  const strongMark = demoSchema.marks.strong;
  const emMark = demoSchema.marks.em;
  const codeMark = demoSchema.marks.code;

  const toggleBold = useCallback(() => {
    if (!strongMark) return;
    run((s, d) => toggleMark(strongMark)(s, d));
  }, [run, strongMark]);

  const toggleItalic = useCallback(() => {
    if (!emMark) return;
    run((s, d) => toggleMark(emMark)(s, d));
  }, [run, emMark]);

  const toggleCode = useCallback(() => {
    if (!codeMark) return;
    run((s, d) => toggleMark(codeMark)(s, d));
  }, [run, codeMark]);

  const pageBreak = useCallback(() => {
    run((s, d) => runtime.commands.insertPageBreak(s, d));
  }, [run, runtime.commands]);

  return (
    <div className="word-shell">
      <Toolbar.Root className="word-toolbar">
        <Toolbar.Group className="word-toolbar-group">
          <Toolbar.Button
            className="word-toolbar-icon-btn"
            type="button"
            onClick={toggleBold}
            aria-label="Bold"
          >
            <LuBold />
          </Toolbar.Button>
          <Toolbar.Button
            className="word-toolbar-icon-btn"
            type="button"
            onClick={toggleItalic}
            aria-label="Italic"
          >
            <LuItalic />
          </Toolbar.Button>
          <Toolbar.Button
            className="word-toolbar-icon-btn"
            type="button"
            onClick={toggleCode}
            aria-label="Code"
          >
            <LuCode />
          </Toolbar.Button>
          <Toolbar.Separator className="word-toolbar-sep" />
          <Toolbar.Button
            className="word-toolbar-icon-btn"
            type="button"
            onClick={pageBreak}
            aria-label="Page break"
          >
            <LuSeparatorHorizontal />
          </Toolbar.Button>
        </Toolbar.Group>
        <Toolbar.Group className="word-toolbar-group word-toolbar-debug">
          <a
            className="word-toolbar-link-btn"
            href="https://github.com/samwillis/premirror"
            target="_blank"
            rel="noopener noreferrer"
          >
            <LuGithub />
            premirror
          </a>
          <Toolbar.Separator className="word-toolbar-sep" />
          <span className="word-toolbar-label">Facing</span>
          <Switch.Root
            aria-label="Facing pages"
            className="word-debug-switch"
            checked={pageLayoutMode === "spread"}
            onCheckedChange={(checked) => {
              setPageLayoutMode(checked ? "spread" : "single");
            }}
          >
            <Switch.Thumb className="word-debug-thumb" />
          </Switch.Root>
          <Toolbar.Separator className="word-toolbar-sep" />
          <span className="word-toolbar-label">Debug</span>
          <Switch.Root
            aria-label="Debug overlays"
            className="word-debug-switch"
            checked={showDebug}
            onCheckedChange={(checked) => {
              setShowDebug(checked);
            }}
          >
            <Switch.Thumb className="word-debug-thumb" />
          </Switch.Root>
        </Toolbar.Group>
      </Toolbar.Root>

      <div className="doc-title-row">
        <div className="doc-title">Untitled document</div>
        <div className="doc-meta">
          pages {layout.pages.length} · compose {diagnostics.timings.composeMs.toFixed(1)}ms ·
          measure {diagnostics.timings.measurementMs.toFixed(1)}ms
        </div>
      </div>

      <div className="paged-viewport-wrap">
        <div className="paged-viewport-inner">
          <div className="premirror-stack">
            <PremirrorPageViewport
              layout={layout}
              showDebug={showDebug}
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
            {showDebug ? (
              <div className="selection-overlay" aria-hidden>
                {projection.rects.map((r, i) => (
                  <div
                    key={i}
                    className="selection-rect"
                    style={{
                      left: r.x,
                      top: r.y,
                      width: r.width,
                      height: r.height,
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
