import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, RefObject } from "react";
import { IntlProvider } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import type { DocxEditorRef } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";
import type { RedlineRevision } from "@stll/folio-core/server";

import {
  acceptAllRevisions,
  listRevisions,
  RedlineEngineExhaustedError,
  rejectAllRevisions,
  runRedline,
} from "../redline/engine";

const DEFAULT_AUTHOR = "Jubarte";

// Ready-to-play pairs. All of these run jubarte-wasm live in the browser.
const EXAMPLES = [
  {
    label: "Services",
    blurb: "Master Services Agreement",
    a: "/redline3/pair1-a.docx",
    b: "/redline3/pair1-b.docx",
  },
  {
    label: "Lease",
    blurb: "Commercial Lease Agreement",
    a: "/redline3/pair2-a.docx",
    b: "/redline3/pair2-b.docx",
  },
  {
    label: "NDA",
    blurb: "Mutual Non-Disclosure Agreement",
    a: "/redline3/pair3-a.docx",
    b: "/redline3/pair3-b.docx",
  },
] as const;

// ~200-page pairs; jubarte-wasm compares these live in ~10–20 s.
const GIANTS = [
  {
    label: "Giant Services",
    blurb: "~200pp Master Services Agreement",
    a: "/redline3/giant1-a.docx",
    b: "/redline3/giant1-b.docx",
  },
  {
    label: "Giant Credit",
    blurb: "~200pp Credit Facility Agreement",
    a: "/redline3/giant2-a.docx",
    b: "/redline3/giant2-b.docx",
  },
] as const;

// A real ~1000-page dissertation (9.8 MB, 276k runs). Its compare peaks at
// ~11.9 GB of memory — beyond wasm32's 4 GiB address space — so the redline is
// precomputed by the SAME jubarte engine compiled natively (the server path).
// Everything else on this page runs the wasm build live.
const DISSERTATION = {
  label: "Dissertation",
  blurb: "Doctoral dissertation, ~1000pp — redline precomputed by native jubarte",
  a: "/redline3/dissertacao-a.docx",
  b: "/redline3/dissertacao-b.docx",
  redline: "/redline3/dissertacao-redline.docx",
  engineLabel: "jubarte-native (server)",
} as const;

type View = "redline" | "accepted" | "rejected";
type Side = "a" | "b";
type Doc = { id: number; buffer: ArrayBuffer; name: string };

type RedlineState = {
  redline: ArrayBuffer;
  shown: ArrayBuffer;
  view: View;
  revisions: RedlineRevision[];
  engine: string;
  elapsedMs: number | null;
};

type EngineFailure = {
  headline: string;
  attempts: { engine: string; phase: string; message: string }[];
};

// Headless-dogfood hook.
declare global {
  var __redline3:
    | {
        loadExample: (index: number) => Promise<void>;
        loadGiant: (index: number) => Promise<void>;
        loadDissertation: () => Promise<void>;
        rerun: () => Promise<void>;
        swap: () => void;
        getState: () => {
          view: View;
          revisions: RedlineRevision[];
          engine: string;
          elapsedMs: number | null;
          failure: EngineFailure | null;
        } | null;
      }
    | undefined;
}

export function Redline3App() {
  const editorARef = useRef<DocxEditorRef>(null);
  const editorBRef = useRef<DocxEditorRef>(null);
  const idRef = useRef(0);
  const suppressAutoRun = useRef(false);
  const [docA, setDocA] = useState<Doc | null>(null);
  const [docB, setDocB] = useState<Doc | null>(null);
  const [state, setState] = useState<RedlineState | null>(null);
  const [failure, setFailure] = useState<EngineFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(
    "Drop two versions, or pick a pair — the redline is computed by jubarte, verified by folio.",
  );

  const generate = useCallback(async (a: Doc, b: Doc) => {
    setBusy(true);
    setFailure(null);
    setStatus(`jubarte-wasm comparing ${a.name} → ${b.name}…`);
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
      setStatus(
        `Redline by ${engine} in ${(elapsedMs / 1000).toFixed(1)} s — ${result.revisions.length} revision(s), verified by folio's self-check.`,
      );
    } catch (error) {
      setState(null);
      if (error instanceof RedlineEngineExhaustedError) {
        setFailure({ headline: "jubarte-wasm failed — no fallback, this is the real error", attempts: error.attempts });
        setStatus("Engine failure. The error above is genuine; nothing was silently substituted.");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setFailure({ headline: "Compare crashed before the engine ladder", attempts: [{ engine: "-", phase: "load", message }] });
        setStatus("Compare failed.");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // The moment both documents land, redline them. Presets that carry a
  // precomputed redline suppress this (they set the result themselves).
  useEffect(() => {
    if (docA && docB && !suppressAutoRun.current) {
      void generate(docA, docB);
    }
  }, [docA, docB, generate]);

  const setDoc = useCallback((side: Side, doc: Doc) => {
    suppressAutoRun.current = false;
    if (side === "a") {
      setDocA(doc);
    } else {
      setDocB(doc);
    }
  }, []);

  const readFile = useCallback(
    async (file: File, side: Side) => {
      const buffer = await file.arrayBuffer();
      idRef.current += 1;
      setDoc(side, { id: idRef.current, buffer, name: file.name });
    },
    [setDoc],
  );

  const pickFile = useCallback(
    (side: Side) => (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.currentTarget.value = "";
      if (file) {
        void readFile(file, side);
      }
    },
    [readFile],
  );

  const onDrop = useCallback(
    (side: Side) => (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (file && file.name.toLowerCase().endsWith(".docx")) {
        void readFile(file, side);
      }
    },
    [readFile],
  );

  const swap = useCallback(() => {
    suppressAutoRun.current = false;
    setDocA(docB);
    setDocB(docA);
  }, [docA, docB]);

  const clear = useCallback(() => {
    setDocA(null);
    setDocB(null);
    setState(null);
    setFailure(null);
    setStatus("Cleared. Drop two versions or pick a pair.");
  }, []);

  // Re-run the compare from the CURRENT editor contents, so edits made in the
  // A/B columns feed the next redline.
  const rerun = useCallback(async () => {
    if (!docA || !docB) {
      return;
    }
    setStatus("Serializing edited documents…");
    const [bufA, bufB] = await Promise.all([
      editorARef.current?.save({ selective: false }),
      editorBRef.current?.save({ selective: false }),
    ]);
    const a: Doc = bufA ? { ...docA, buffer: bufA } : docA;
    const b: Doc = bufB ? { ...docB, buffer: bufB } : docB;
    await generate(a, b);
  }, [docA, docB, generate]);

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

  const loadPair = useCallback(async (urlA: string, urlB: string, nameA: string, nameB: string, label: string) => {
    setStatus(`Loading ${label}…`);
    try {
      const [ra, rb] = await Promise.all([fetch(urlA), fetch(urlB)]);
      if (!ra.ok || !rb.ok) {
        throw new Error(`fetch ${ra.status}/${rb.status}`);
      }
      const [ba, bb] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer()]);
      idRef.current += 1;
      const aDoc = { id: idRef.current, buffer: ba, name: nameA };
      idRef.current += 1;
      const bDoc = { id: idRef.current, buffer: bb, name: nameB };
      setDocA(aDoc);
      setDocB(bDoc);
    } catch (error) {
      setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const loadExample = useCallback(
    (index: number) => {
      suppressAutoRun.current = false;
      const ex = EXAMPLES[index] ?? EXAMPLES[0];
      return loadPair(ex.a, ex.b, `${ex.label} A.docx`, `${ex.label} B.docx`, ex.blurb);
    },
    [loadPair],
  );

  const loadGiant = useCallback(
    (index: number) => {
      suppressAutoRun.current = false;
      const g = GIANTS[index] ?? GIANTS[0];
      return loadPair(g.a, g.b, `${g.label} A.docx`, `${g.label} B.docx`, g.blurb);
    },
    [loadPair],
  );

  // The dissertation ships its redline precomputed by native jubarte: the pair
  // needs ~11.9 GB to compare, past wasm32's 4 GiB ceiling. The wasm build
  // still enumerates the revisions and drives the accept/reject views live.
  const loadDissertation = useCallback(async () => {
    setStatus(`Loading ${DISSERTATION.blurb}…`);
    setFailure(null);
    try {
      suppressAutoRun.current = true;
      const [ra, rb, rr] = await Promise.all([
        fetch(DISSERTATION.a),
        fetch(DISSERTATION.b),
        fetch(DISSERTATION.redline),
      ]);
      if (!ra.ok || !rb.ok || !rr.ok) {
        throw new Error(`fetch ${ra.status}/${rb.status}/${rr.status}`);
      }
      const [ba, bb, br] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer(), rr.arrayBuffer()]);
      idRef.current += 1;
      setDocA({ id: idRef.current, buffer: ba, name: "Dissertação (original).docx" });
      idRef.current += 1;
      setDocB({ id: idRef.current, buffer: bb, name: "Dissertação (revisada).docx" });
      setBusy(true);
      setStatus("Enumerating revisions (jubarte-wasm)…");
      const revisions = await listRevisions(br);
      setState({
        redline: br,
        shown: br,
        view: "redline",
        revisions,
        engine: DISSERTATION.engineLabel,
        elapsedMs: null,
      });
      setStatus(
        `Dissertation redline by ${DISSERTATION.engineLabel} — ${revisions.length} revision(s). ` +
          "This pair needs ~11.9 GB to compare, past wasm32's 4 GiB; the identical engine ran natively.",
      );
    } catch (error) {
      setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    globalThis.__redline3 = {
      loadExample,
      loadGiant,
      loadDissertation,
      rerun,
      swap,
      getState: () =>
        state || failure
          ? {
              view: state?.view ?? "redline",
              revisions: state?.revisions ?? [],
              engine: state?.engine ?? "-",
              elapsedMs: state?.elapsedMs ?? null,
              failure,
            }
          : null,
    };
    return () => {
      globalThis.__redline3 = undefined;
    };
  }, [loadExample, loadGiant, loadDissertation, rerun, swap, state, failure]);

  const bothLoaded = Boolean(docA && docB);

  return (
    <IntlProvider
      locale="en"
      messages={getFolioMessages("en")}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <div className="r3-shell">
        <header className="r3-topbar">
          <div className="r3-brand">
            <span className="r3-wordmark">
              jubarte<span className="r3-wordmark-x">×</span>folio
            </span>
            <p className="r3-tagline">
              Word-grade redlines, computed by <mark>jubarte</mark>, verified &amp; rendered by folio.
            </p>
          </div>
          <nav className="r3-presets" aria-label="Sample document pairs">
            {EXAMPLES.map((ex, i) => (
              <button
                key={ex.label}
                type="button"
                className="r3-preset"
                onClick={() => void loadExample(i)}
                data-testid={`example-${i}`}
                title={ex.blurb}
              >
                {ex.label}
              </button>
            ))}
            <span className="r3-preset-rule" aria-hidden="true" />
            {GIANTS.map((g, i) => (
              <button
                key={g.label}
                type="button"
                className="r3-preset"
                onClick={() => void loadGiant(i)}
                data-testid={`giant-${i}`}
                title={`${g.blurb} — compared live by jubarte-wasm`}
              >
                {g.label}
              </button>
            ))}
            <span className="r3-preset-rule" aria-hidden="true" />
            <button
              type="button"
              className="r3-preset r3-preset--marked"
              onClick={() => void loadDissertation()}
              data-testid="dissertation"
              title={DISSERTATION.blurb}
            >
              {DISSERTATION.label}
            </button>
            {(docA || docB) && (
              <button type="button" className="r3-preset r3-preset--quiet" onClick={clear} data-testid="clear">
                Clear
              </button>
            )}
          </nav>
        </header>

        {failure && (
          <div className="r3-failure" role="alert" data-testid="engine-failure">
            <strong>{failure.headline}</strong>
            <ul>
              {failure.attempts.map((attempt) => (
                <li key={`${attempt.engine}:${attempt.phase}`}>
                  <code>{attempt.engine}</code> failed at <code>{attempt.phase}</code>: {attempt.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="r3-grid">
          <DocPane
            label="A"
            title="Original"
            doc={docA}
            testid="doc-a-input"
            editorRef={editorARef}
            onPick={pickFile("a")}
            onDrop={onDrop("a")}
          />

          <div className="r3-spine">
            <button
              type="button"
              className="r3-swap"
              onClick={swap}
              disabled={!docA && !docB}
              title="Swap A and B"
              aria-label="Swap A and B"
              data-testid="swap"
            >
              &#8646;
            </button>
            {bothLoaded && state && (
              <button
                type="button"
                className="r3-rerun"
                onClick={() => void rerun()}
                disabled={busy}
                title="Serialize the edited columns and redline again"
                data-testid="rerun"
              >
                Redline&nbsp;again
              </button>
            )}
          </div>

          <DocPane
            label="B"
            title="Revised"
            doc={docB}
            testid="doc-b-input"
            editorRef={editorBRef}
            onPick={pickFile("b")}
            onDrop={onDrop("b")}
          />

          <section className="r3-panel r3-result">
            <header className="r3-panel-bar">
              <span className="r3-tag">Redline</span>
              {state ? (
                <>
                  <span className="r3-meta" data-testid="engine">
                    {state.engine}
                  </span>
                  <span className="r3-meta">
                    <strong data-testid="revision-count">{state.revisions.length}</strong>&nbsp;revisions
                  </span>
                  {state.elapsedMs !== null && (
                    <span className="r3-meta">{(state.elapsedMs / 1000).toFixed(1)}&nbsp;s</span>
                  )}
                  <span className="r3-spacer" />
                  <div className="r3-views" role="group" aria-label="Redline view">
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
                  {busy ? "comparing…" : bothLoaded ? "…" : "waiting for A and B"}
                </span>
              )}
            </header>
            <div className="r3-panel-body">
              {state ? (
                <DocxEditor
                  key={`${state.view}-${state.revisions.length}`}
                  document={null}
                  documentBuffer={state.shown}
                  author={DEFAULT_AUTHOR}
                  mode="editing"
                  showRuler={false}
                  initialZoom={0.72}
                  onError={(error) => setStatus(`Editor: ${error.message}`)}
                />
              ) : (
                <div className="r3-empty">
                  {busy ? (
                    <>
                      <div className="r3-spinner" aria-hidden="true" />
                      <p>jubarte is comparing — the result is verified before it is shown.</p>
                    </>
                  ) : (
                    <p>The verified redline lands here.</p>
                  )}
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

type DocPaneProps = {
  label: string;
  title: string;
  doc: Doc | null;
  testid: string;
  editorRef: RefObject<DocxEditorRef | null>;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

function DocPane({ label, title, doc, testid, editorRef, onPick, onDrop }: DocPaneProps) {
  return (
    <section
      className={`r3-panel r3-pane${doc ? " r3-pane--ready" : ""}`}
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <header className="r3-panel-bar">
        <span className="r3-tag">{label}</span>
        <span className="r3-panel-title" title={doc?.name ?? title}>
          {doc ? doc.name : title}
        </span>
        {doc ? (
          <label className="r3-replace">
            Replace
            <input type="file" accept=".docx" hidden onChange={onPick} data-testid={testid} />
          </label>
        ) : null}
      </header>
      <div className="r3-panel-body">
        {doc ? (
          <DocxEditor
            key={doc.id}
            ref={editorRef}
            document={null}
            documentBuffer={doc.buffer}
            author={DEFAULT_AUTHOR}
            mode="editing"
            showRuler={false}
            initialZoom={0.72}
          />
        ) : (
          <label className="r3-drop">
            <span className="r3-drop-title">{title}</span>
            <span className="r3-drop-hint">Drop a .docx here, or click to choose</span>
            <input type="file" accept=".docx" hidden onChange={onPick} data-testid={testid} />
          </label>
        )}
      </div>
    </section>
  );
}
