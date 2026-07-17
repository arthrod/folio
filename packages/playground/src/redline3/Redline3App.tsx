import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { IntlProvider } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import type { DocxEditorRef } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";
import type { RedlineRevision } from "@stll/folio-core/server";

import { acceptAllRevisions, rejectAllRevisions, runRedline } from "../redline/engine";

const DEFAULT_AUTHOR = "Folio Redline";
const DEMO_BASE = "/redline/base.docx";
const DEMO_REVISED = "/redline/revised.docx";
const SAMPLE_A = "/redline3/sample-a.docx";
const SAMPLE_B = "/redline3/sample-b.docx";
const SAMPLE_A_XL = "/redline3/sample-a-xl.docx";
const SAMPLE_B_XL = "/redline3/sample-b-xl.docx";

type View = "redline" | "accepted" | "rejected";
type Doc = { buffer: ArrayBuffer; name: string };

type RedlineState = {
  redline: ArrayBuffer;
  shown: ArrayBuffer;
  view: View;
  revisions: RedlineRevision[];
  engine: string;
  elapsedMs: number;
};

// Headless-dogfood hook.
declare global {
  var __redline3:
    | {
        loadDemo: () => Promise<void>;
        swap: () => void;
        getState: () => Omit<RedlineState, "redline" | "shown"> | null;
      }
    | undefined;
}

export function Redline3App() {
  const editorRef = useRef<DocxEditorRef>(null);
  const [docA, setDocA] = useState<Doc | null>(null);
  const [docB, setDocB] = useState<Doc | null>(null);
  const [state, setState] = useState<RedlineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [poof, setPoof] = useState(false);
  const [status, setStatus] = useState(
    "Import A and B — the redline appears the instant both land.",
  );

  const generate = useCallback(async (a: Doc, b: Doc) => {
    setBusy(true);
    setStatus(`Comparing ${a.name} → ${b.name}…`);
    try {
      const { result, engine, elapsedMs } = await runRedline(a.buffer, b.buffer, DEFAULT_AUTHOR);
      setState({
        redline: result.buffer,
        shown: result.buffer,
        view: "redline",
        revisions: result.revisions,
        engine,
        elapsedMs,
      });
      setPoof(true);
      setStatus(
        `Redline via ${engine} in ${elapsedMs.toFixed(0)} ms — ${result.revisions.length} revision(s).`,
      );
    } catch (error) {
      setStatus(`Compare failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  // The moment both documents are in, redline. Re-runs on swap.
  useEffect(() => {
    if (docA && docB) {
      void generate(docA, docB);
    }
  }, [docA, docB, generate]);

  useEffect(() => {
    if (!poof) {
      return;
    }
    const id = requestAnimationFrame(() => setTimeout(() => setPoof(false), 650));
    return () => cancelAnimationFrame(id);
  }, [poof]);

  const readFile = useCallback(async (file: File, side: "a" | "b") => {
    const buffer = await file.arrayBuffer();
    const doc = { buffer, name: file.name };
    if (side === "a") {
      setDocA(doc);
    } else {
      setDocB(doc);
    }
  }, []);

  const pickFile = useCallback(
    (side: "a" | "b") => (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.currentTarget.value = "";
      if (file) {
        void readFile(file, side);
      }
    },
    [readFile],
  );

  const onDrop = useCallback(
    (side: "a" | "b") => (event: DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (file && file.name.toLowerCase().endsWith(".docx")) {
        void readFile(file, side);
      }
    },
    [readFile],
  );

  const swap = useCallback(() => {
    setDocA(docB);
    setDocB(docA);
  }, [docA, docB]);

  const setView = useCallback((view: View) => {
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      if (view === "redline") {
        return { ...prev, view, shown: prev.redline };
      }
      void (async () => {
        const shown =
          view === "accepted"
            ? await acceptAllRevisions(prev.redline)
            : await rejectAllRevisions(prev.redline);
        setState((current) => (current ? { ...current, view, shown } : current));
      })();
      return prev;
    });
  }, []);

  const loadPair = useCallback(
    async (urlA: string, urlB: string, nameA: string, nameB: string, label: string) => {
      setStatus(`Loading ${label}…`);
      const [ra, rb] = await Promise.all([fetch(urlA), fetch(urlB)]);
      const [ba, bb] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer()]);
      setDocA({ buffer: ba, name: nameA });
      setDocB({ buffer: bb, name: nameB });
    },
    [],
  );

  const loadDemo = useCallback(
    () => loadPair(DEMO_BASE, DEMO_REVISED, "base.docx", "revised.docx", "demo A + B"),
    [loadPair],
  );

  const loadSamples = useCallback(
    () => loadPair(SAMPLE_A, SAMPLE_B, "sample-a.docx", "sample-b.docx", "the sample pair (~35pp)"),
    [loadPair],
  );

  const loadSamplesXl = useCallback(
    () =>
      loadPair(
        SAMPLE_A_XL,
        SAMPLE_B_XL,
        "sample-a-xl.docx",
        "sample-b-xl.docx",
        "the 200-page pair (compare can take a few minutes)",
      ),
    [loadPair],
  );

  useEffect(() => {
    globalThis.__redline3 = {
      loadDemo,
      loadSamples,
      loadSamplesXl,
      swap,
      getState: () =>
        state
          ? {
              view: state.view,
              revisions: state.revisions,
              engine: state.engine,
              elapsedMs: state.elapsedMs,
            }
          : null,
    };
    return () => {
      globalThis.__redline3 = undefined;
    };
  }, [loadDemo, swap, state]);

  return (
    <IntlProvider
      locale="en"
      messages={getFolioMessages("en")}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <div className="r3-shell">
        <header className="r3-header">
          <h1 className="r3-title">Folio Redline</h1>
          <span className="r3-sub">import A · import B · poof — redline · pretext line-fitting</span>
          <button
            type="button"
            className="r3-demo"
            onClick={() => void loadSamples()}
            data-testid="load-samples"
          >
            Play with samples (~35pp)
          </button>
          <button
            type="button"
            className="r3-demo"
            onClick={() => void loadSamplesXl()}
            data-testid="load-samples-xl"
            title="Two ~200-page documents. Rendering is fast (pretext); the jubarte-wasm compare can take a few minutes."
          >
            200-page stress pair ⏳
          </button>
          <button type="button" className="r3-demo" onClick={() => void loadDemo()} data-testid="load-demo">
            Small demo
          </button>
        </header>

        <div className="r3-grid">
          <DropCard
            label="A"
            title="Original"
            doc={docA}
            testid="doc-a-input"
            onPick={pickFile("a")}
            onDrop={onDrop("a")}
          />

          <div className="r3-swapcol">
            <button
              type="button"
              className="r3-swap"
              onClick={swap}
              disabled={!docA && !docB}
              title="Swap A and B"
              aria-label="Swap A and B"
              data-testid="swap"
            >
              ⇄
            </button>
          </div>

          <DropCard
            label="B"
            title="Revised"
            doc={docB}
            testid="doc-b-input"
            onPick={pickFile("b")}
            onDrop={onDrop("b")}
          />

          <section className={`r3-result${poof ? " r3-result--poof" : ""}`}>
            <div className="r3-result-bar">
              <span className="r3-badge">Redline</span>
              {state ? (
                <>
                  <span className="r3-meta" data-testid="engine">{state.engine}</span>
                  <span className="r3-meta">
                    <strong data-testid="revision-count">{state.revisions.length}</strong> revisions
                  </span>
                  <span className="r3-meta">{state.elapsedMs.toFixed(0)} ms</span>
                  <span className="r3-spacer" />
                  <div className="r3-views">
                    {(["redline", "accepted", "rejected"] as const).map((view) => (
                      <button
                        key={view}
                        type="button"
                        className="r3-chip"
                        aria-pressed={state.view === view}
                        onClick={() => setView(view)}
                        data-testid={`view-${view}`}
                      >
                        {view}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <span className="r3-meta r3-meta--muted">
                  {busy ? "comparing…" : "waiting for A and B"}
                </span>
              )}
            </div>
            <div className="r3-editor">
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
                />
              ) : (
                <div className="r3-empty">
                  <div className="r3-empty-poof">✦</div>
                  <p>Poof — your redline lands here.</p>
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="r3-status" data-testid="status">
          {status}
        </footer>
      </div>
    </IntlProvider>
  );
}

type DropCardProps = {
  label: string;
  title: string;
  doc: Doc | null;
  testid: string;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => void;
};

function DropCard({ label, title, doc, testid, onPick, onDrop }: DropCardProps) {
  return (
    <label
      className={`r3-card${doc ? " r3-card--ready" : ""}`}
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <span className="r3-card-tag">{label}</span>
      <span className="r3-card-title">{title}</span>
      {doc ? (
        <span className="r3-card-file" title={doc.name}>
          ✓ {doc.name}
        </span>
      ) : (
        <span className="r3-card-hint">Drop a .docx here, or click to choose</span>
      )}
      <input type="file" accept=".docx" onChange={onPick} data-testid={testid} hidden />
    </label>
  );
}
