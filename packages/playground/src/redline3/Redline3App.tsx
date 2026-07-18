import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, RefObject } from "react";
import { IntlProvider } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import type { DocxEditorRef } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";
import type { RedlineRevision } from "@stll/folio-core/server";

import {
  DISSERTATION,
  EXAMPLES,
  GIANTS,
  idleStatusLabel,
  PAGE_MATRIX,
  pagePath,
  type PresetPair,
  type R3PageConfig,
} from "./config";
import { engineFacade, RedlineEngineExhaustedError } from "./engines";
import { aggregateMonolith } from "./monolith";

const DEFAULT_AUTHOR = "Jubarte";

type View = "redline" | "monolith" | "accepted" | "rejected";
type Side = "a" | "b";
type Doc = { id: number; buffer: ArrayBuffer; name: string };

type MonolithState = {
  buffer: ArrayBuffer;
  elementsBefore: number;
  elementsAfter: number;
  revisions: RedlineRevision[];
};

type RedlineState = {
  redline: ArrayBuffer;
  shown: ArrayBuffer;
  view: View;
  revisions: RedlineRevision[];
  engine: string;
  elapsedMs: number | null;
  monolith: MonolithState | null;
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
        setView: (view: View) => void;
        rerun: () => Promise<void>;
        swap: () => void;
        /** Base64 of the aggregated monolith buffer (null until computed). */
        getMonolithBase64: () => string | null;
        getState: () => {
          view: View;
          revisions: RedlineRevision[];
          engine: string;
          elapsedMs: number | null;
          monolith: { elementsBefore: number; elementsAfter: number; revisions: number } | null;
          failure: EngineFailure | null;
        } | null;
      }
    | undefined;
}

export function Redline3App({ config }: { config: R3PageConfig }) {
  const facade = engineFacade(config.engine);
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
    facade.live
      ? `Drop two versions, or pick a pair — computed by ${facade.label}, verified by folio.`
      : "Pick a pair — the redlines on this page were precomputed by native jubarte server-side.",
  );

  const generate = useCallback(
    async (a: Doc, b: Doc) => {
      setBusy(true);
      setFailure(null);
      setStatus(`${facade.label} comparing ${a.name} → ${b.name}…`);
      try {
        const { result, engine, elapsedMs } = await facade.run(a.buffer, b.buffer, DEFAULT_AUTHOR);
        setState({
          redline: result.buffer,
          shown: result.buffer,
          view: "redline",
          revisions: result.revisions,
          engine,
          elapsedMs,
          monolith: null,
        });
        setStatus(
          `Redline by ${engine} in ${(elapsedMs / 1000).toFixed(1)} s — ${result.revisions.length} revision(s), verified by folio's self-check.`,
        );
      } catch (error) {
        setState(null);
        if (error instanceof RedlineEngineExhaustedError) {
          setFailure({
            headline: `${facade.label} failed — no fallback, this is the real error`,
            attempts: error.attempts,
          });
          setStatus(
            "Engine failure. The error above is genuine; nothing was silently substituted.",
          );
        } else {
          const message = error instanceof Error ? error.message : String(error);
          setFailure({
            headline: "Compare crashed before the engine ladder",
            attempts: [{ engine: facade.label, phase: "load", message }],
          });
          setStatus("Compare failed.");
        }
      } finally {
        setBusy(false);
      }
    },
    [facade],
  );

  useEffect(() => {
    if (docA && docB && !suppressAutoRun.current) {
      void generate(docA, docB);
    }
  }, [docA, docB, generate]);

  const readFile = useCallback(
    async (file: File, side: Side) => {
      if (!facade.live) {
        setStatus(
          "This page's engine runs server-side (native binary); uploads cannot be compared here. Use the presets, or the wasm/ts pages for live compares.",
        );
        return;
      }
      const buffer = await file.arrayBuffer();
      idRef.current += 1;
      suppressAutoRun.current = false;
      const doc = { id: idRef.current, buffer, name: file.name };
      if (side === "a") {
        setDocA(doc);
      } else {
        setDocB(doc);
      }
    },
    [facade],
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
    suppressAutoRun.current = !facade.live;
    setDocA(docB);
    setDocB(docA);
  }, [docA, docB, facade]);

  const clear = useCallback(() => {
    setDocA(null);
    setDocB(null);
    setState(null);
    setFailure(null);
    setStatus("Cleared. Drop two versions or pick a pair.");
  }, []);

  const rerun = useCallback(async () => {
    if (!docA || !docB || !facade.live) {
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
  }, [docA, docB, facade, generate]);

  const setView = useCallback(
    (view: View) => {
      // Read state directly (not via a setState updater): updaters must stay
      // pure, and launching the async view materialization inside one
      // double-fires under StrictMode.
      const prev = state;
      if (!prev) {
        return;
      }
      if (view === "redline") {
        setState({ ...prev, view, shown: prev.redline });
        return;
      }
      void (async () => {
        try {
          if (view === "monolith") {
            const monolith =
              prev.monolith ??
              (await (async () => {
                const aggregated = await aggregateMonolith(prev.redline);
                const revisions = await facade.listRevisions(aggregated.buffer);
                return { ...aggregated, revisions };
              })());
            setStatus(
              `Monolith: ${monolith.elementsBefore} revision elements aggregated into ${monolith.elementsAfter} — ${monolith.revisions.length} revision(s) after clustering.`,
            );
            setState((current) =>
              current ? { ...current, view, shown: monolith.buffer, monolith } : current,
            );
            return;
          }
          const shown =
            view === "accepted"
              ? await facade.acceptAll(prev.redline)
              : await facade.rejectAll(prev.redline);
          setState((current) => (current ? { ...current, view, shown } : current));
        } catch (error) {
          setStatus(
            `${view} view failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    },
    [facade, state],
  );

  const applyPrecomputed = useCallback(
    async (redlineUrl: string, engineLabel: string) => {
      const response = await fetch(redlineUrl);
      if (!response.ok) {
        throw new Error(`fetch ${redlineUrl}: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      setBusy(true);
      setStatus("Enumerating revisions…");
      try {
        const revisions = await facade.listRevisions(buffer);
        setState({
          redline: buffer,
          shown: buffer,
          view: "redline",
          revisions,
          engine: engineLabel,
          elapsedMs: null,
          monolith: null,
        });
        setStatus(
          `Redline by ${engineLabel} — ${revisions.length} revision(s), precomputed server-side.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [facade],
  );

  const loadPair = useCallback(
    async (preset: PresetPair, nameA: string, nameB: string) => {
      setStatus(`Loading ${preset.blurb}…`);
      setFailure(null);
      try {
        const [ra, rb] = await Promise.all([fetch(preset.a), fetch(preset.b)]);
        if (!ra.ok || !rb.ok) {
          throw new Error(`fetch ${ra.status}/${rb.status}`);
        }
        const [ba, bb] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer()]);
        suppressAutoRun.current = !facade.live;
        idRef.current += 1;
        setDocA({ id: idRef.current, buffer: ba, name: nameA });
        idRef.current += 1;
        setDocB({ id: idRef.current, buffer: bb, name: nameB });
        if (!facade.live) {
          await applyPrecomputed(preset.nativeRedline, facade.label);
        }
      } catch (error) {
        setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [applyPrecomputed, facade],
  );

  const loadExample = useCallback(
    async (index: number) => {
      const preset = EXAMPLES.at(index);
      if (preset) {
        await loadPair(preset, `${preset.label} A.docx`, `${preset.label} B.docx`);
      }
    },
    [loadPair],
  );

  const loadGiant = useCallback(
    async (index: number) => {
      const preset = GIANTS.at(index);
      if (preset) {
        await loadPair(preset, `${preset.label} A.docx`, `${preset.label} B.docx`);
      }
    },
    [loadPair],
  );

  const loadDissertation = useCallback(async () => {
    setStatus(`Loading ${DISSERTATION.blurb}…`);
    setFailure(null);
    try {
      suppressAutoRun.current = true;
      const [ra, rb] = await Promise.all([fetch(DISSERTATION.a), fetch(DISSERTATION.b)]);
      if (!ra.ok || !rb.ok) {
        throw new Error(`fetch ${ra.status}/${rb.status}`);
      }
      const [ba, bb] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer()]);
      idRef.current += 1;
      setDocA({ id: idRef.current, buffer: ba, name: "Dissertação (original).docx" });
      idRef.current += 1;
      setDocB({ id: idRef.current, buffer: bb, name: "Dissertação (revisada).docx" });
      const { url, label } = DISSERTATION.redlineByEngine[config.engine];
      await applyPrecomputed(url, label);
      setStatus(
        `Dissertation redline by ${label}. Comparing this pair needs ~11.9 GB — past wasm32's 4 GiB and browser heaps — so the identical engine ran server-side.`,
      );
    } catch (error) {
      setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [applyPrecomputed, config.engine]);

  useEffect(() => {
    globalThis.__redline3 = {
      loadExample,
      loadGiant,
      loadDissertation,
      setView,
      rerun,
      swap,
      getMonolithBase64: () => {
        const buffer = state?.monolith?.buffer;
        if (!buffer) {
          return null;
        }
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      },
      getState: () =>
        state || failure
          ? {
              view: state?.view ?? "redline",
              revisions: state?.revisions ?? [],
              engine: state?.engine ?? "-",
              elapsedMs: state?.elapsedMs ?? null,
              monolith: state?.monolith
                ? {
                    elementsBefore: state.monolith.elementsBefore,
                    elementsAfter: state.monolith.elementsAfter,
                    revisions: state.monolith.revisions.length,
                  }
                : null,
              failure,
            }
          : null,
    };
    return () => {
      globalThis.__redline3 = undefined;
    };
  }, [loadExample, loadGiant, loadDissertation, setView, rerun, swap, state, failure]);

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
              Word-grade redlines by <mark>{facade.label}</mark>
              {config.viewOnly ? " · view-only" : ""}, verified &amp; rendered by folio.
            </p>
          </div>
          <nav className="r3-presets" aria-label="Sample document pairs">
            {EXAMPLES.map((preset, i) => (
              <button
                key={preset.label}
                type="button"
                className="r3-preset"
                onClick={() => void loadExample(i)}
                data-testid={`example-${i}`}
                title={preset.blurb}
              >
                {preset.label}
              </button>
            ))}
            <span className="r3-preset-rule" aria-hidden="true" />
            {GIANTS.map((preset, i) => (
              <button
                key={preset.label}
                type="button"
                className="r3-preset"
                onClick={() => void loadGiant(i)}
                data-testid={`giant-${i}`}
                title={preset.blurb}
              >
                {preset.label}
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
              <button
                type="button"
                className="r3-preset r3-preset--quiet"
                onClick={clear}
                data-testid="clear"
              >
                Clear
              </button>
            )}
          </nav>
        </header>

        <nav className="r3-switch" aria-label="Demo variants">
          {PAGE_MATRIX.map((combo) => {
            const path = pagePath(combo);
            const current = path === pagePath(config);
            const label = `${combo.framework}·${combo.engine}${combo.viewOnly && combo.framework === "react" ? "·view" : ""}`;
            return (
              <a
                key={path}
                href={path}
                className="r3-switch-link"
                aria-current={current ? "page" : undefined}
              >
                {label}
              </a>
            );
          })}
        </nav>

        {failure && (
          <div className="r3-failure" role="alert" data-testid="engine-failure">
            <strong>{failure.headline}</strong>
            <ul>
              {failure.attempts.map((attempt) => (
                <li key={`${attempt.engine}:${attempt.phase}`}>
                  <code>{attempt.engine}</code> failed at <code>{attempt.phase}</code>:{" "}
                  {attempt.message}
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
            viewOnly={config.viewOnly}
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
            {bothLoaded && state && facade.live && !config.viewOnly && (
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
            viewOnly={config.viewOnly}
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
                    <strong data-testid="revision-count">{state.revisions.length}</strong>
                    &nbsp;revisions
                  </span>
                  {state.elapsedMs !== null && (
                    <span className="r3-meta">{(state.elapsedMs / 1000).toFixed(1)}&nbsp;s</span>
                  )}
                  <span className="r3-spacer" />
                  <div className="r3-views" role="group" aria-label="Redline view">
                    {(["redline", "monolith", "accepted", "rejected"] as const).map((view) => (
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
                  {idleStatusLabel(busy, bothLoaded, "comparing…")}
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
                  mode={config.viewOnly ? "viewing" : "editing"}
                  readOnly={config.viewOnly}
                  showRuler={false}
                  initialZoom={0.72}
                  onError={(error) => setStatus(`Editor: ${error.message}`)}
                />
              ) : (
                <div className="r3-empty">
                  {busy ? (
                    <>
                      <div className="r3-spinner" aria-hidden="true" />
                      <p>{facade.label} is working — results are verified before they are shown.</p>
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
  viewOnly: boolean;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

function DocPane({ label, title, doc, testid, editorRef, viewOnly, onPick, onDrop }: DocPaneProps) {
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
            mode={viewOnly ? "viewing" : "editing"}
            readOnly={viewOnly}
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
