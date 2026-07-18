/**
 * The full-Vue redline3 app — zero React. Vue 3 render functions for the
 * chrome; documents and redlines render as HTML through jubarte-first's
 * lossless `WmlToHtmlConverter` (see ./renderHtml). The folio paged editor is
 * React-only, so this tier is a genuine second implementation, not a wrapper.
 */

import { computed, defineComponent, h, ref } from "vue";
import type { VNode } from "vue";

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
import { docxToHtml } from "./renderHtml";

const DEFAULT_AUTHOR = "Jubarte";

type View = "redline" | "monolith" | "accepted" | "rejected";
type PaneDoc = { name: string; buffer: ArrayBuffer; html: string };
type Failure = { headline: string; attempts: { engine: string; phase: string; message: string }[] };

export const VueRedline3App = defineComponent({
  name: "VueRedline3App",
  setup() {
    const config = resolvePageConfig("vue");
    const facade = engineFacade(config.engine);

    const docA = ref<PaneDoc | null>(null);
    const docB = ref<PaneDoc | null>(null);
    const redline = ref<ArrayBuffer | null>(null);
    const shownHtml = ref<string | null>(null);
    const view = ref<View>("redline");
    const engineLabel = ref(facade.label);
    const revisionCount = ref<number | null>(null);
    const elapsedMs = ref<number | null>(null);
    const busy = ref(false);
    const failure = ref<Failure | null>(null);
    const status = ref(
      facade.live
        ? `Pick a pair — computed by ${facade.label}, verified by folio, rendered as lossless HTML.`
        : "Pick a pair — precomputed by native jubarte server-side, rendered as lossless HTML.",
    );

    const bothLoaded = computed(() => Boolean(docA.value && docB.value));

    const fetchBuffer = async (url: string): Promise<ArrayBuffer> => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`fetch ${url}: ${response.status}`);
      }
      return response.arrayBuffer();
    };

    const showRedline = async (buffer: ArrayBuffer, label: string, ms: number | null) => {
      redline.value = buffer;
      engineLabel.value = label;
      elapsedMs.value = ms;
      view.value = "redline";
      status.value = "Enumerating revisions…";
      revisionCount.value = (await facade.listRevisions(buffer)).length;
      status.value = "Rendering tracked-changes HTML…";
      shownHtml.value = docxToHtml(buffer, true);
      status.value =
        `Redline by ${label}${ms !== null ? ` in ${(ms / 1000).toFixed(1)} s` : " (precomputed server-side)"} — ` +
        `${revisionCount.value} revision(s).`;
    };

    const compareLive = async () => {
      const a = docA.value;
      const b = docB.value;
      if (!a || !b) {
        return;
      }
      busy.value = true;
      failure.value = null;
      status.value = `${facade.label} comparing ${a.name} → ${b.name}…`;
      try {
        const outcome = await facade.run(a.buffer, b.buffer, DEFAULT_AUTHOR);
        await showRedline(outcome.result.buffer, outcome.engine, outcome.elapsedMs);
      } catch (error) {
        redline.value = null;
        shownHtml.value = null;
        if (error instanceof RedlineEngineExhaustedError) {
          failure.value = {
            headline: `${facade.label} failed — no fallback, this is the real error`,
            attempts: error.attempts,
          };
          status.value =
            "Engine failure. The error above is genuine; nothing was silently substituted.";
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

    const loadPane = (side: "a" | "b", name: string, buffer: ArrayBuffer) => {
      status.value = `Rendering ${name}…`;
      const html = docxToHtml(buffer, false);
      const doc: PaneDoc = { name, buffer, html };
      if (side === "a") {
        docA.value = doc;
      } else {
        docB.value = doc;
      }
    };

    const loadPair = async (preset: PresetPair) => {
      busy.value = true;
      failure.value = null;
      status.value = `Loading ${preset.blurb}…`;
      try {
        const [ba, bb] = await Promise.all([fetchBuffer(preset.a), fetchBuffer(preset.b)]);
        await loadPane("a", `${preset.label} A.docx`, ba);
        await loadPane("b", `${preset.label} B.docx`, bb);
        if (facade.live) {
          busy.value = false;
          await compareLive();
        } else {
          await showRedline(await fetchBuffer(preset.nativeRedline), facade.label, null);
        }
      } catch (error) {
        status.value = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        busy.value = false;
      }
    };

    const loadDissertation = async () => {
      busy.value = true;
      failure.value = null;
      status.value = `Loading ${DISSERTATION.blurb}…`;
      try {
        const [ba, bb] = await Promise.all([
          fetchBuffer(DISSERTATION.a),
          fetchBuffer(DISSERTATION.b),
        ]);
        await loadPane("a", "Dissertação (original).docx", ba);
        await loadPane("b", "Dissertação (revisada).docx", bb);
        const { url, label } = DISSERTATION.redlineByEngine[config.engine];
        await showRedline(await fetchBuffer(url), label, null);
      } catch (error) {
        status.value = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        busy.value = false;
      }
    };

    const setView = async (next: View) => {
      const buffer = redline.value;
      if (!buffer || view.value === next) {
        return;
      }
      busy.value = true;
      try {
        if (next === "redline") {
          shownHtml.value = docxToHtml(buffer, true);
        } else if (next === "monolith") {
          const aggregated = await aggregateMonolith(buffer);
          const revisions = await facade.listRevisions(aggregated.buffer);
          shownHtml.value = docxToHtml(aggregated.buffer, true);
          status.value =
            `Monolith: ${aggregated.elementsBefore} revision elements aggregated into ` +
            `${aggregated.elementsAfter} — ${revisions.length} revision(s) after clustering.`;
        } else if (next === "accepted") {
          shownHtml.value = docxToHtml(await facade.acceptAll(buffer), false);
        } else {
          shownHtml.value = docxToHtml(await facade.rejectAll(buffer), false);
        }
        view.value = next;
      } catch (error) {
        status.value = `${next} view failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        busy.value = false;
      }
    };

    const pane = (label: string, doc: PaneDoc | null, title: string): VNode =>
      h("section", { class: `r3-panel r3-pane${doc ? " r3-pane--ready" : ""}` }, [
        h("header", { class: "r3-panel-bar" }, [
          h("span", { class: "r3-tag" }, label),
          h("span", { class: "r3-panel-title", title: doc?.name ?? title }, doc ? doc.name : title),
        ]),
        h(
          "div",
          { class: "r3-panel-body" },
          doc
            ? [h("iframe", { class: "r3-htmlframe", srcdoc: doc.html, title: doc.name })]
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
              "vue",
            ]),
            h("p", { class: "r3-tagline" }, [
              "Full-Vue tier: redlines by ",
              h("mark", engineLabel.value),
              ", rendered as lossless HTML (no React, no folio editor).",
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
              {
                key: path,
                href: path,
                class: "r3-switch-link",
                "aria-current": current ? "page" : undefined,
              },
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
                    ` failed at `,
                    h("code", attempt.phase),
                    `: ${attempt.message}`,
                  ]),
                ),
              ),
            ])
          : null,
        h("div", { class: "r3-grid r3-grid--vue" }, [
          pane("A", docA.value, "Original"),
          pane("B", docB.value, "Revised"),
          h("section", { class: "r3-panel r3-result" }, [
            h("header", { class: "r3-panel-bar" }, [
              h("span", { class: "r3-tag" }, "Redline"),
              ...(redline.value
                ? [
                    h("span", { class: "r3-meta", "data-testid": "engine" }, engineLabel.value),
                    h("span", { class: "r3-meta" }, [
                      h(
                        "strong",
                        { "data-testid": "revision-count" },
                        String(revisionCount.value ?? "…"),
                      ),
                      " revisions",
                    ]),
                    elapsedMs.value !== null
                      ? h("span", { class: "r3-meta" }, `${(elapsedMs.value / 1000).toFixed(1)} s`)
                      : null,
                    h("span", { class: "r3-spacer" }),
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
                      idleStatusLabel(busy.value, bothLoaded.value, "working…"),
                    ),
                  ]),
            ]),
            h(
              "div",
              { class: "r3-panel-body" },
              shownHtml.value
                ? [
                    h("iframe", {
                      class: "r3-htmlframe",
                      srcdoc: shownHtml.value,
                      title: "Redline",
                    }),
                  ]
                : [
                    h("div", { class: "r3-empty" }, [
                      busy.value ? h("div", { class: "r3-spinner", "aria-hidden": "true" }) : null,
                      h(
                        "p",
                        busy.value
                          ? "Working — results are verified before they are shown."
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
