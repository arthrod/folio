/**
 * The @stll/folio-vue editor tier: the same redline3 template with FULL folio
 * editors in every column, in native Vue 3 (no React anywhere). The engine is
 * jubarte-wasm through folio's orchestrator; "Redline again" serializes the
 * edited columns via the Vue editor ref's `save()` — the parity-contract twin
 * of the React tier.
 */

import { computed, defineComponent, h, ref, shallowRef } from "vue";
import type { VNode } from "vue";

import { DocxEditor } from "@stll/folio-vue";

import {
  DISSERTATION,
  EXAMPLES,
  GIANTS,
  idleStatusLabel,
  PAGE_MATRIX,
  pagePath,
  resolvePageConfig,
  type PresetPair,
} from "../config";
import { engineFacade, RedlineEngineExhaustedError } from "../engines";
import { aggregateMonolith } from "../monolith";

const DEFAULT_AUTHOR = "Jubarte";

type View = "redline" | "monolith" | "accepted" | "rejected";
type Doc = { id: number; buffer: ArrayBuffer; name: string };
type Failure = { headline: string; attempts: { engine: string; phase: string; message: string }[] };

type VueEditorRef = {
  save: (options?: { selective?: boolean }) => Promise<ArrayBuffer | null>;
} | null;

export const FvueApp = defineComponent({
  name: "FvueRedline3App",
  setup() {
    const config = resolvePageConfig("fvue");
    const facade = engineFacade(config.engine);

    let nextId = 0;
    const docA = ref<Doc | null>(null);
    const docB = ref<Doc | null>(null);
    const editorA = shallowRef<VueEditorRef>(null);
    const editorB = shallowRef<VueEditorRef>(null);
    const redline = ref<ArrayBuffer | null>(null);
    const shown = ref<ArrayBuffer | null>(null);
    const shownKey = ref(0);
    const view = ref<View>("redline");
    const engineLabel = ref(facade.label);
    const revisionCount = ref<number | null>(null);
    const elapsedMs = ref<number | null>(null);
    const busy = ref(false);
    const failure = ref<Failure | null>(null);
    const status = ref(`Pick a pair — full folio-vue editors, redlines by ${facade.label}.`);

    const bothLoaded = computed(() => Boolean(docA.value && docB.value));

    const fetchBuffer = async (url: string): Promise<ArrayBuffer> => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`fetch ${url}: ${response.status}`);
      }
      return response.arrayBuffer();
    };

    const showBuffer = (buffer: ArrayBuffer): void => {
      shown.value = buffer;
      shownKey.value += 1;
    };

    const compare = async (a: Doc, b: Doc) => {
      busy.value = true;
      failure.value = null;
      status.value = `${facade.label} comparing ${a.name} → ${b.name}…`;
      try {
        const outcome = await facade.run(a.buffer, b.buffer, DEFAULT_AUTHOR);
        redline.value = outcome.result.buffer;
        engineLabel.value = outcome.engine;
        revisionCount.value = outcome.result.revisions.length;
        elapsedMs.value = outcome.elapsedMs;
        view.value = "redline";
        showBuffer(outcome.result.buffer);
        status.value = `Redline by ${outcome.engine} in ${(outcome.elapsedMs / 1000).toFixed(1)} s — ${outcome.result.revisions.length} revision(s), verified by folio's self-check.`;
      } catch (error) {
        redline.value = null;
        shown.value = null;
        if (error instanceof RedlineEngineExhaustedError) {
          failure.value = {
            headline: `${facade.label} failed — no fallback, this is the real error`,
            attempts: error.attempts,
          };
          status.value = "Engine failure. The error above is genuine.";
        } else {
          failure.value = {
            headline: "Compare crashed before the engine ladder",
            attempts: [
              {
                engine: facade.label,
                phase: "load",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          };
          status.value = "Compare failed.";
        }
      } finally {
        busy.value = false;
      }
    };

    const loadPair = async (preset: PresetPair) => {
      failure.value = null;
      status.value = `Loading ${preset.blurb}…`;
      try {
        const [ba, bb] = await Promise.all([fetchBuffer(preset.a), fetchBuffer(preset.b)]);
        nextId += 1;
        docA.value = { id: nextId, buffer: ba, name: `${preset.label} A.docx` };
        nextId += 1;
        docB.value = { id: nextId, buffer: bb, name: `${preset.label} B.docx` };
        await compare(docA.value, docB.value);
      } catch (error) {
        status.value = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    };

    const loadDissertation = async () => {
      failure.value = null;
      status.value = `Loading ${DISSERTATION.blurb}…`;
      busy.value = true;
      try {
        const [ba, bb] = await Promise.all([
          fetchBuffer(DISSERTATION.a),
          fetchBuffer(DISSERTATION.b),
        ]);
        nextId += 1;
        docA.value = { id: nextId, buffer: ba, name: "Dissertação (original).docx" };
        nextId += 1;
        docB.value = { id: nextId, buffer: bb, name: "Dissertação (revisada).docx" };
        const { url, label } = DISSERTATION.redlineByEngine[config.engine];
        const buffer = await fetchBuffer(url);
        status.value = "Enumerating revisions…";
        const revisions = await facade.listRevisions(buffer);
        redline.value = buffer;
        engineLabel.value = label;
        revisionCount.value = revisions.length;
        elapsedMs.value = null;
        view.value = "redline";
        showBuffer(buffer);
        status.value = `Dissertation redline by ${label} — ${revisions.length} revision(s), precomputed server-side.`;
      } catch (error) {
        status.value = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        busy.value = false;
      }
    };

    const rerun = async () => {
      const a = docA.value;
      const b = docB.value;
      if (!a || !b) {
        return;
      }
      status.value = "Serializing edited documents…";
      const [bufA, bufB] = await Promise.all([
        editorA.value?.save({ selective: false }),
        editorB.value?.save({ selective: false }),
      ]);
      await compare(bufA ? { ...a, buffer: bufA } : a, bufB ? { ...b, buffer: bufB } : b);
    };

    const setView = async (next: View) => {
      const buffer = redline.value;
      if (!buffer || view.value === next) {
        return;
      }
      try {
        if (next === "redline") {
          showBuffer(buffer);
        } else if (next === "monolith") {
          const aggregated = await aggregateMonolith(buffer);
          const revisions = await facade.listRevisions(aggregated.buffer);
          status.value = `Monolith: ${aggregated.elementsBefore} revision elements aggregated into ${aggregated.elementsAfter} — ${revisions.length} revision(s) after clustering.`;
          showBuffer(aggregated.buffer);
        } else if (next === "accepted") {
          showBuffer(await facade.acceptAll(buffer));
        } else {
          showBuffer(await facade.rejectAll(buffer));
        }
        view.value = next;
      } catch (error) {
        status.value = `${next} view failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    };

    const editorPane = (
      label: string,
      title: string,
      doc: Doc | null,
      onReady: (instance: VueEditorRef) => void,
    ): VNode =>
      h("section", { class: `r3-panel r3-pane${doc ? " r3-pane--ready" : ""}` }, [
        h("header", { class: "r3-panel-bar" }, [
          h("span", { class: "r3-tag" }, label),
          h("span", { class: "r3-panel-title", title: doc?.name ?? title }, doc ? doc.name : title),
        ]),
        h(
          "div",
          { class: "r3-panel-body" },
          doc
            ? [
                h(DocxEditor, {
                  key: doc.id,
                  ref: (instance: unknown) => onReady(instance as VueEditorRef),
                  document: null,
                  documentBuffer: doc.buffer,
                  author: DEFAULT_AUTHOR,
                  mode: "editing",
                  showRuler: false,
                  initialZoom: 0.72,
                }),
              ]
            : [h("div", { class: "r3-empty" }, [h("p", `${title} — pick a preset above`)])],
        ),
      ]);

    return () =>
      h("div", { class: "r3-shell" }, [
        h("header", { class: "r3-topbar" }, [
          h("div", { class: "r3-brand" }, [
            h("span", { class: "r3-wordmark" }, [
              "jubarte",
              h("span", { class: "r3-wordmark-x" }, "×"),
              "folio-vue",
            ]),
            h("p", { class: "r3-tagline" }, [
              "Full folio editors in native Vue 3, redlines by ",
              h("mark", engineLabel.value),
              ".",
            ]),
          ]),
          h("nav", { class: "r3-presets", "aria-label": "Sample document pairs" }, [
            ...EXAMPLES.map((preset, i) =>
              h(
                "button",
                {
                  type: "button",
                  class: "r3-preset",
                  "data-testid": `example-${i}`,
                  title: preset.blurb,
                  onClick: () => void loadPair(preset),
                },
                preset.label,
              ),
            ),
            h("span", { class: "r3-preset-rule", "aria-hidden": "true" }),
            ...GIANTS.map((preset, i) =>
              h(
                "button",
                {
                  type: "button",
                  class: "r3-preset",
                  "data-testid": `giant-${i}`,
                  title: preset.blurb,
                  onClick: () => void loadPair(preset),
                },
                preset.label,
              ),
            ),
            h("span", { class: "r3-preset-rule", "aria-hidden": "true" }),
            h(
              "button",
              {
                type: "button",
                class: "r3-preset r3-preset--marked",
                "data-testid": "dissertation",
                title: DISSERTATION.blurb,
                onClick: () => void loadDissertation(),
              },
              DISSERTATION.label,
            ),
          ]),
        ]),
        h(
          "nav",
          { class: "r3-switch", "aria-label": "Demo variants" },
          PAGE_MATRIX.map((combo) => {
            const path = pagePath(combo);
            const current = path === pagePath(config);
            const label = `${combo.framework}·${combo.engine}${combo.viewOnly && combo.framework === "react" ? "·view" : ""}`;
            return h(
              "a",
              { key: path, href: path, class: "r3-switch-link", "aria-current": current ? "page" : undefined },
              label,
            );
          }),
        ),
        failure.value
          ? h("div", { class: "r3-failure", role: "alert", "data-testid": "engine-failure" }, [
              h("strong", failure.value.headline),
              h(
                "ul",
                failure.value.attempts.map((attempt) =>
                  h("li", { key: `${attempt.engine}:${attempt.phase}` }, [
                    h("code", attempt.engine),
                    " failed at ",
                    h("code", attempt.phase),
                    `: ${attempt.message}`,
                  ]),
                ),
              ),
            ])
          : null,
        h("div", { class: "r3-grid r3-grid--vue" }, [
          editorPane("A", "Original", docA.value, (instance) => {
            editorA.value = instance;
          }),
          editorPane("B", "Revised", docB.value, (instance) => {
            editorB.value = instance;
          }),
          h("section", { class: "r3-panel r3-result" }, [
            h("header", { class: "r3-panel-bar" }, [
              h("span", { class: "r3-tag" }, "Redline"),
              ...(redline.value
                ? [
                    h("span", { class: "r3-meta", "data-testid": "engine" }, engineLabel.value),
                    h("span", { class: "r3-meta" }, [
                      h("strong", { "data-testid": "revision-count" }, String(revisionCount.value ?? "…")),
                      " revisions",
                    ]),
                    elapsedMs.value !== null
                      ? h("span", { class: "r3-meta" }, `${(elapsedMs.value / 1000).toFixed(1)} s`)
                      : null,
                    h("span", { class: "r3-spacer" }),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "r3-chip",
                        "data-testid": "rerun",
                        disabled: busy.value || !bothLoaded.value,
                        onClick: () => void rerun(),
                      },
                      "redline again",
                    ),
                    h(
                      "div",
                      { class: "r3-views", role: "group", "aria-label": "Redline view" },
                      (["redline", "monolith", "accepted", "rejected"] as const).map((candidate) =>
                        h(
                          "button",
                          {
                            key: candidate,
                            type: "button",
                            class: "r3-chip",
                            "aria-pressed": view.value === candidate ? "true" : "false",
                            "data-testid": `view-${candidate}`,
                            onClick: () => void setView(candidate),
                          },
                          candidate,
                        ),
                      ),
                    ),
                  ]
                : [
                    h(
                      "span",
                      { class: "r3-meta r3-meta--muted" },
                      idleStatusLabel(busy.value, bothLoaded.value, "comparing…"),
                    ),
                  ]),
            ]),
            h(
              "div",
              { class: "r3-panel-body" },
              shown.value
                ? [
                    h(DocxEditor, {
                      key: shownKey.value,
                      document: null,
                      documentBuffer: shown.value,
                      author: DEFAULT_AUTHOR,
                      mode: "editing",
                      showRuler: false,
                      initialZoom: 0.72,
                    }),
                  ]
                : [
                    h("div", { class: "r3-empty" }, [
                      busy.value ? h("div", { class: "r3-spinner", "aria-hidden": "true" }) : null,
                      h(
                        "p",
                        busy.value
                          ? `${facade.label} is comparing — results are verified before they are shown.`
                          : "The verified redline lands here.",
                      ),
                    ]),
                  ],
            ),
          ]),
        ]),
        h("footer", { class: "r3-status", "data-testid": "status" }, status.value),
      ]);
  },
});
