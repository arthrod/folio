/**
 * The three engine facades behind the redline3 pages.
 *
 * - `wasm` — jubarte-rust compiled to wasm32, run live in the browser through
 *   folio's orchestrator (self-check included). No fallback rung.
 * - `ts` — jubarte-first's LOSSLESS WmlComparer port (browser-isomorphic; the
 *   packaging boundary is wired via `wireWmlComparerNodeAdapter`), also run
 *   through folio's orchestrator. Its `CompareDocuments` swallows errors into
 *   an empty byte array — the adapter converts that to a throw so nothing
 *   fails silently.
 * - `native` — jubarte-rust built natively; it cannot run in a page, so every
 *   preset ships a server-side precomputed redline and uploads are declined
 *   with an explanation.
 */

import {
  generateRedlineDocx,
  type GenerateRedlineDocxResult,
  type RedlineRevision,
} from "@stll/folio-core/server";

import { DocumentComparer } from "jubarte-src/lossless/DocumentComparer.ts";
import { wireWmlComparerNodeAdapter } from "jubarte-src/lossless/lib/ooxml-package-jszip.ts";

import {
  acceptAllRevisions as wasmAcceptAll,
  listRevisions as wasmListRevisions,
  rejectAllRevisions as wasmRejectAll,
  runRedline as wasmRunRedline,
} from "../redline/engine";
import type { EngineKind } from "./config";

export { RedlineEngineExhaustedError } from "../redline/engine";

type LadderOptions = NonNullable<Parameters<typeof generateRedlineDocx>[2]>;
type LadderEngine = NonNullable<LadderOptions["engines"]>[number];

export type RedlineRunOutcome = {
  result: GenerateRedlineDocxResult;
  engine: string;
  elapsedMs: number;
};

export type EngineFacade = {
  kind: EngineKind;
  /** Engine name shown in the result bar. */
  label: string;
  /** Whether uploads/presets compare live in the page. */
  live: boolean;
  /** Live verified compare. Throws on `live: false`. */
  run: (a: ArrayBuffer, b: ArrayBuffer, author: string) => Promise<RedlineRunOutcome>;
  acceptAll: (redline: ArrayBuffer) => Promise<ArrayBuffer>;
  rejectAll: (redline: ArrayBuffer) => Promise<ArrayBuffer>;
  listRevisions: (redline: ArrayBuffer) => Promise<RedlineRevision[]>;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

// ---------------------------------------------------------------------------
// jubarte-first lossless (TypeScript) engine
// ---------------------------------------------------------------------------

let losslessWired = false;
export const ensureLosslessWired = (): void => {
  if (!losslessWired) {
    wireWmlComparerNodeAdapter();
    losslessWired = true;
  }
};

const losslessCompareBytes = (a: ArrayBuffer, b: ArrayBuffer, author: string): Uint8Array => {
  ensureLosslessWired();
  const out = DocumentComparer.CompareDocuments(new Uint8Array(a), new Uint8Array(b), author);
  if (out.length === 0) {
    // CompareDocuments catches internally and returns an empty array; treat
    // that as the failure it is instead of passing zero bytes downstream.
    throw new Error("jubarte-first lossless CompareDocuments failed (see browser console)");
  }
  return out;
};

type LosslessRevisionEntry = {
  Author?: string;
  Date?: string;
  RevisionType?: string;
  Text?: string;
  MoveGroupId?: number | null;
  IsMoveSource?: boolean | null;
  FormatChange?: { changedProperties?: string[] } | null;
};

const REVISION_TYPES = new Set(["Inserted", "Deleted", "Moved", "FormatChanged"]);

const losslessListRevisions = (redline: ArrayBuffer): RedlineRevision[] => {
  ensureLosslessWired();
  const parsed: unknown = JSON.parse(DocumentComparer.GetRevisionsJson(new Uint8Array(redline)));
  const entries =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { Revisions?: unknown[] }).Revisions)
      ? ((parsed as { Revisions: LosslessRevisionEntry[] }).Revisions ?? [])
      : [];
  const revisions: RedlineRevision[] = [];
  for (const entry of entries) {
    const type = entry.RevisionType ?? "";
    if (!REVISION_TYPES.has(type)) {
      continue;
    }
    revisions.push({
      type: type as RedlineRevision["type"],
      author: entry.Author ?? "",
      date: entry.Date ?? "",
      part: "word/document.xml",
      text: entry.Text ?? "",
      moveGroupId: entry.MoveGroupId ?? null,
      isMoveSource: entry.IsMoveSource ?? null,
      formatChange: entry.FormatChange?.changedProperties
        ? { changedProperties: entry.FormatChange.changedProperties }
        : null,
    });
  }
  return revisions;
};

const tsLadderEngine: LadderEngine = {
  name: "jubarte-first-lossless",
  compare: (base, revised, { author }) =>
    Promise.resolve({
      buffer: toArrayBuffer(losslessCompareBytes(base, revised, author)),
    }),
  acceptAll: async (docx) => {
    ensureLosslessWired();
    const { acceptRevisionsDocxBytes } =
      await import("jubarte-src/lossless/lib/ooxml-package-jszip.ts");
    return toArrayBuffer(acceptRevisionsDocxBytes(new Uint8Array(docx)));
  },
  rejectAll: async (docx) => {
    ensureLosslessWired();
    const { rejectRevisionsDocxBytes } =
      await import("jubarte-src/lossless/lib/ooxml-package-jszip.ts");
    return toArrayBuffer(rejectRevisionsDocxBytes(new Uint8Array(docx)));
  },
  getRevisions: (docx) => Promise.resolve(losslessListRevisions(docx)),
};

const runTsRedline = async (
  a: ArrayBuffer,
  b: ArrayBuffer,
  author: string,
): Promise<RedlineRunOutcome> => {
  const started = performance.now();
  const result = await generateRedlineDocx(a, b, { engines: [tsLadderEngine], author });
  return { result, engine: result.engine, elapsedMs: performance.now() - started };
};

// ---------------------------------------------------------------------------
// Facades
// ---------------------------------------------------------------------------

const wasmFacade: EngineFacade = {
  kind: "wasm",
  label: "jubarte-wasm",
  live: true,
  run: wasmRunRedline,
  acceptAll: wasmAcceptAll,
  rejectAll: wasmRejectAll,
  listRevisions: wasmListRevisions,
};

const tsFacade: EngineFacade = {
  kind: "ts",
  label: "jubarte-first-lossless",
  live: true,
  run: runTsRedline,
  acceptAll: (redline) => tsLadderEngine.acceptAll(redline),
  rejectAll: (redline) => tsLadderEngine.rejectAll(redline),
  listRevisions: (redline) => tsLadderEngine.getRevisions(redline),
};

const nativeFacade: EngineFacade = {
  kind: "native",
  label: "jubarte-native (server)",
  live: false,
  run: () => {
    throw new Error(
      "jubarte-native runs server-side; this page serves precomputed redlines for its presets",
    );
  },
  // View resolution on precomputed native output is generic tracked-changes
  // processing; the wasm build of the SAME engine does it client-side.
  acceptAll: wasmAcceptAll,
  rejectAll: wasmRejectAll,
  listRevisions: wasmListRevisions,
};

export const engineFacade = (kind: EngineKind): EngineFacade => {
  if (kind === "ts") {
    return tsFacade;
  }
  if (kind === "native") {
    return nativeFacade;
  }
  return wasmFacade;
};
