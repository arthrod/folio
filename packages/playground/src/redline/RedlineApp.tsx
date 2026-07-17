import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { IntlProvider } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import type { DocxEditorRef } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";
import type { RedlineRevision } from "@stll/folio-core/server";

import { acceptAllRevisions, rejectAllRevisions, runRedline } from "./engine";

const DEFAULT_AUTHOR = "Folio Redline";
const DEMO_BASE = "/redline/base.docx";
const DEMO_REVISED = "/redline/revised.docx";

type View = "redline" | "accepted" | "rejected";

type RedlineState = {
  /** The verified redline package (never an unverified engine buffer). */
  redline: ArrayBuffer;
  /** Buffer currently shown in the editor (redline / accepted / rejected). */
  shown: ArrayBuffer;
  view: View;
  revisions: RedlineRevision[];
  engine: string;
  elapsedMs: number;
  /** Comment anchors painted by the editor once the buffer renders. */
  commentAnchors: number;
};

// Test hook: the Chrome dogfood specs drive the tool through this and read
// engine/revision/comment state without scraping the DOM.
declare global {
  var __redline:
    | {
        loadDemo: () => Promise<void>;
        getState: () => Omit<RedlineState, "redline" | "shown"> | null;
        setView: (view: View) => void;
      }
    | undefined;
}

const countCommentAnchors = (): number =>
  document.querySelectorAll(".paged-editor__pages [data-comment-id]").length;

export function RedlineApp() {
  const editorRef = useRef<DocxEditorRef>(null);
  const [base, setBase] = useState<ArrayBuffer | null>(null);
  const [revised, setRevised] = useState<ArrayBuffer | null>(null);
  const [baseName, setBaseName] = useState("");
  const [revisedName, setRevisedName] = useState("");
  const [state, setState] = useState<RedlineState | null>(null);
  const [status, setStatus] = useState("Load a base and a revised .docx, or the comment demo.");
  const [busy, setBusy] = useState(false);

  const generate = useCallback(
    async (baseBuffer: ArrayBuffer, revisedBuffer: ArrayBuffer) => {
      setBusy(true);
      setStatus("Comparing…");
      try {
        const { result, engine, elapsedMs } = await runRedline(
          baseBuffer,
          revisedBuffer,
          DEFAULT_AUTHOR,
        );
        setState({
          redline: result.buffer,
          shown: result.buffer,
          view: "redline",
          revisions: result.revisions,
          engine,
          elapsedMs,
          commentAnchors: 0,
        });
        setStatus(
          `Redline via ${engine} in ${elapsedMs.toFixed(0)} ms — ${result.revisions.length} revision(s).`,
        );
      } catch (error) {
        setStatus(`Compare failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const loadDemo = useCallback(async () => {
    setStatus("Loading comment demo…");
    const [baseResponse, revisedResponse] = await Promise.all([
      fetch(DEMO_BASE),
      fetch(DEMO_REVISED),
    ]);
    const [baseBuffer, revisedBuffer] = await Promise.all([
      baseResponse.arrayBuffer(),
      revisedResponse.arrayBuffer(),
    ]);
    setBase(baseBuffer);
    setRevised(revisedBuffer);
    setBaseName("base.docx");
    setRevisedName("revised.docx");
    await generate(baseBuffer, revisedBuffer);
  }, [generate]);

  const pickFile = useCallback(
    (side: "base" | "revised") => async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.currentTarget.value = "";
      if (!file) {
        return;
      }
      const buffer = await file.arrayBuffer();
      if (side === "base") {
        setBase(buffer);
        setBaseName(file.name);
      } else {
        setRevised(buffer);
        setRevisedName(file.name);
      }
    },
    [],
  );

  const setView = useCallback(
    (view: View) => {
      setState((prev) => {
        if (!prev) {
          return prev;
        }
        if (view === "redline") {
          return { ...prev, view, shown: prev.redline };
        }
        // Accept/reject are computed lazily off the verified redline.
        void (async () => {
          const shown =
            view === "accepted"
              ? await acceptAllRevisions(prev.redline)
              : await rejectAllRevisions(prev.redline);
          setState((current) => (current ? { ...current, view, shown } : current));
        })();
        return prev;
      });
    },
    [],
  );

  // Surface the painted comment-anchor count once the shown buffer lays out.
  // Layout runs a few frames after the view is created, so re-read across a
  // short settle window and bump state when the count changes.
  const handleEditorViewReady = useCallback(() => {
    let frame = 0;
    const settle = () => {
      const anchors = countCommentAnchors();
      setState((prev) =>
        prev && prev.commentAnchors !== anchors ? { ...prev, commentAnchors: anchors } : prev,
      );
      frame += 1;
      if (frame < 8) {
        requestAnimationFrame(settle);
      }
    };
    requestAnimationFrame(settle);
  }, []);

  useEffect(() => {
    globalThis.__redline = {
      loadDemo,
      getState: () =>
        state
          ? {
              view: state.view,
              revisions: state.revisions,
              engine: state.engine,
              elapsedMs: state.elapsedMs,
              commentAnchors: countCommentAnchors(),
            }
          : null,
      setView,
    };
    return () => {
      globalThis.__redline = undefined;
    };
  }, [loadDemo, setView, state]);

  const canGenerate = base !== null && revised !== null && !busy;
  const commentRevisions = state?.revisions.filter((r) => r.text.trim().length > 0) ?? [];

  return (
    <IntlProvider
      locale="en"
      messages={getFolioMessages("en")}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <div className="rl-shell">
        <header className="rl-header">
          <h1 className="rl-title">Folio Redline</h1>
          <span className="rl-sub">
            jubarte-wasm comparer · folio editor · verified through the RedlineEngine port
          </span>
        </header>

        <div className="rl-body">
          <aside className="rl-side">
            <div className="rl-group">
              <label className="rl-file">
                <span>Base .docx</span>
                <input type="file" accept=".docx" onChange={pickFile("base")} data-testid="base-input" />
                <em>{baseName || "none"}</em>
              </label>
              <label className="rl-file">
                <span>Revised .docx</span>
                <input
                  type="file"
                  accept=".docx"
                  onChange={pickFile("revised")}
                  data-testid="revised-input"
                />
                <em>{revisedName || "none"}</em>
              </label>
              <button
                type="button"
                className="rl-btn rl-btn--primary"
                disabled={!canGenerate}
                onClick={() => base && revised && void generate(base, revised)}
                data-testid="generate"
              >
                Generate redline
              </button>
              <button
                type="button"
                className="rl-btn"
                disabled={busy}
                onClick={() => void loadDemo()}
                data-testid="load-demo"
              >
                Load comment demo
              </button>
            </div>

            {state && (
              <div className="rl-group" data-testid="summary">
                <div className="rl-stat">
                  <span>Engine</span>
                  <strong data-testid="engine">{state.engine}</strong>
                </div>
                <div className="rl-stat">
                  <span>Revisions</span>
                  <strong data-testid="revision-count">{state.revisions.length}</strong>
                </div>
                <div className="rl-stat">
                  <span>Comment anchors</span>
                  <strong data-testid="comment-anchors">{countCommentAnchors()}</strong>
                </div>
                <div className="rl-stat">
                  <span>Compare</span>
                  <strong>{state.elapsedMs.toFixed(0)} ms</strong>
                </div>
                <div className="rl-views">
                  {(["redline", "accepted", "rejected"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      className="rl-btn rl-btn--chip"
                      aria-pressed={state.view === view}
                      onClick={() => setView(view)}
                      data-testid={`view-${view}`}
                    >
                      {view}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {state && (
              <div className="rl-group rl-revisions" data-testid="revisions">
                {commentRevisions.slice(0, 100).map((r, index) => (
                  <div key={index} className={`rl-rev rl-rev--${r.type.toLowerCase()}`}>
                    <span className="rl-rev-type">{r.type}</span>
                    <span className="rl-rev-text">{r.text.slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <main className="rl-editor">
            {state ? (
              <DocxEditor
                key={state.view}
                ref={editorRef}
                document={null}
                documentBuffer={state.shown}
                author={DEFAULT_AUTHOR}
                mode="viewing"
                showToolbar={false}
                showRuler={false}
                onError={(error) => setStatus(`Editor: ${error.message}`)}
                onEditorViewReady={handleEditorViewReady}
              />
            ) : (
              <div className="rl-empty">The redline renders here once you generate one.</div>
            )}
          </main>
        </div>

        <footer className="rl-status" data-testid="status">
          {status}
        </footer>
      </div>
    </IntlProvider>
  );
}
