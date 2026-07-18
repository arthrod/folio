/**
 * Shared page/engine/preset configuration for the redline3 demo family.
 *
 * One template, twelve-ish paths: {wasm, ts, native} × {editing, view-only} on
 * the React (folio editor) pages, plus full-Vue pages that render documents
 * through jubarte-first's lossless WmlToHtmlConverter (the folio editor is
 * React-only, so the Vue tier is a genuine no-React implementation).
 */

export type EngineKind = "wasm" | "ts" | "native";
/** react = folio-react editor; fvue = @stll/folio-vue editor; vue = full-Vue lossless-HTML tier. */
export type FrameworkKind = "react" | "fvue" | "vue";

export type R3PageConfig = {
  engine: EngineKind;
  viewOnly: boolean;
  framework: FrameworkKind;
};

declare global {
  interface Window {
    __R3_CONFIG?: { engine?: EngineKind; viewOnly?: boolean };
  }
}

export const resolvePageConfig = (framework: FrameworkKind): R3PageConfig => ({
  engine: window.__R3_CONFIG?.engine ?? "wasm",
  viewOnly: window.__R3_CONFIG?.viewOnly ?? false,
  framework,
});

/** Served path for a page combo (mirrors the html entry names). */
export const pagePath = ({ engine, viewOnly, framework }: R3PageConfig): string => {
  const parts = ["redline3"];
  if (framework === "vue") {
    parts.push("vue");
  }
  if (framework === "fvue") {
    parts.push("fvue");
  }
  if (engine !== "wasm") {
    parts.push(engine);
  }
  // Only the React tier ships separate view-only paths.
  if (viewOnly && framework === "react") {
    parts.push("view");
  }
  return `/${parts.join("-")}`;
};

export const ENGINE_KINDS: readonly EngineKind[] = ["wasm", "ts", "native"];

/** All shipped page combos, for the cross-navigation switcher. */
export const PAGE_MATRIX: readonly R3PageConfig[] = [
  ...ENGINE_KINDS.flatMap((engine) => [
    { engine, viewOnly: false, framework: "react" as const },
    { engine, viewOnly: true, framework: "react" as const },
  ]),
  // The folio-vue editor tier (@stll/folio-vue): full editors, wasm engine.
  { engine: "wasm", viewOnly: false, framework: "fvue" },
  // The lossless-HTML tier: featherweight, rendered via WmlToHtmlConverter.
  ...ENGINE_KINDS.map((engine) => ({ engine, viewOnly: true, framework: "vue" as const })),
];

export type PresetPair = {
  label: string;
  blurb: string;
  a: string;
  b: string;
  /** Redline precomputed by the native jubarte CLI (served as a deploy asset). */
  nativeRedline: string;
};

export const EXAMPLES: readonly PresetPair[] = [
  {
    label: "Services",
    blurb: "Master Services Agreement",
    a: "/redline3/pair1-a.docx",
    b: "/redline3/pair1-b.docx",
    nativeRedline: "/redline3/pair1-redline.docx",
  },
  {
    label: "Lease",
    blurb: "Commercial Lease Agreement",
    a: "/redline3/pair2-a.docx",
    b: "/redline3/pair2-b.docx",
    nativeRedline: "/redline3/pair2-redline.docx",
  },
  {
    label: "NDA",
    blurb: "Mutual Non-Disclosure Agreement",
    a: "/redline3/pair3-a.docx",
    b: "/redline3/pair3-b.docx",
    nativeRedline: "/redline3/pair3-redline.docx",
  },
];

export const GIANTS: readonly PresetPair[] = [
  {
    label: "Giant Services",
    blurb: "~200pp Master Services Agreement",
    a: "/redline3/giant1-a.docx",
    b: "/redline3/giant1-b.docx",
    nativeRedline: "/redline3/giant1-redline.docx",
  },
  {
    label: "Giant Credit",
    blurb: "~200pp Credit Facility Agreement",
    a: "/redline3/giant2-a.docx",
    b: "/redline3/giant2-b.docx",
    nativeRedline: "/redline3/giant2-redline.docx",
  },
];

/**
 * The dissertation compare needs ~11.9 GB peak (native measurement) — past
 * wasm32's 4 GiB and past browser JS heaps — so every engine page serves a
 * server-side precomputed redline for it, labeled by the engine that made it.
 */
export const DISSERTATION = {
  label: "Dissertation",
  blurb: "Doctoral dissertation, ~1000pp — redline precomputed server-side",
  a: "/redline3/dissertacao-a.docx",
  b: "/redline3/dissertacao-b.docx",
  redlineByEngine: {
    wasm: { url: "/redline3/dissertacao-redline.docx", label: "jubarte-native (server)" },
    // The AST pipeline is the jubarte-first output that passes folio's
    // self-check on this document (the lossless WmlComparer port currently
    // fails the reject-side check on table-bearing docs — known defect).
    ts: { url: "/redline3/dissertacao-redline-ts.docx", label: "jubarte-first-ast (server)" },
    native: { url: "/redline3/dissertacao-redline.docx", label: "jubarte-native (server)" },
  },
} as const;
