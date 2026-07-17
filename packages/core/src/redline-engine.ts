/**
 * The redline engine port: folio-core's compare seam as one narrow internal
 * interface with swappable adapters (plugin-style). Engines are byte
 * transformers — DOCX in, DOCX out — so no engine type ever reaches folio's
 * public API surface, and no engine package becomes a dependency: adapters
 * wrap modules the caller injects (`createJubarteWasmRedlineEngine`).
 *
 * The orchestrator (`generateRedlineDocx` in `./redline`) walks an ordered
 * engine ladder: compare → engine-independent self-check → revision
 * enumeration; an engine that throws or produces an unverifiable buffer is
 * skipped, and a fully failed ladder raises `RedlineEngineExhaustedError` —
 * never an unverified buffer.
 */

import { TaggedError } from "better-result";

import type { FolioDocumentStoryHandle } from "./ai-edits/headless";
import type { FolioAIEditSkippedOperation } from "./ai-edits/types";

/** Revision kinds enumerated from a redline package. */
export type RedlineRevisionType = "Inserted" | "Deleted" | "Moved" | "FormatChanged";

/**
 * One tracked revision in a redline package — the same object shape as the
 * jubarte CLI's `revisions --json` lines and the wasm `getRevisions` export.
 */
export type RedlineRevision = {
  type: RedlineRevisionType;
  author: string;
  date: string;
  part: string;
  moveGroupId: number | null;
  isMoveSource: boolean | null;
  formatChange: { changedProperties: string[] } | null;
  text: string;
};

/** A package part the story engine could not represent as story-scoped edits. */
export type GenerateRedlineUnprocessedStory = {
  baseStory: FolioDocumentStoryHandle | null;
  revisedStory: FolioDocumentStoryHandle | null;
  reason: "missing-base-story" | "missing-revised-story";
};

export type RedlineCompareOptions = {
  /** Author recorded on the generated tracked changes. */
  author: string;
};

export type RedlineCompareResult = {
  /** The redline package: the base with differences as tracked changes. */
  buffer: ArrayBuffer;
  /** Story-engine coverage gaps; package-level engines omit these. */
  skipped?: FolioAIEditSkippedOperation[];
  unprocessedStories?: GenerateRedlineUnprocessedStory[];
};

/** The port every compare backend implements. */
export type RedlineEngine = {
  /** Stable adapter identifier, recorded on results and error attempts. */
  name: string;
  compare(
    base: ArrayBuffer,
    revised: ArrayBuffer,
    options: RedlineCompareOptions,
  ): Promise<RedlineCompareResult>;
  acceptAll(docx: ArrayBuffer): Promise<ArrayBuffer>;
  rejectAll(docx: ArrayBuffer): Promise<ArrayBuffer>;
  getRevisions(docx: ArrayBuffer): Promise<RedlineRevision[]>;
};

/** One failed rung of the engine ladder. */
export type RedlineEngineAttempt = {
  engine: string;
  phase: "compare" | "self-check" | "revisions";
  message: string;
};

/** Raised when every engine in the ladder failed; carries the attempt log. */
export class RedlineEngineExhaustedError extends TaggedError("RedlineEngineExhaustedError")<{
  message: string;
  attempts: RedlineEngineAttempt[];
}>() {}

/**
 * Structural surface of the jubarte wasm package (wasm-pack `nodejs` target).
 * Structural on purpose: folio-core never imports the package — the caller
 * loads it (owning that dependency and its license) and injects it here.
 */
export type JubarteWasmModule = {
  compareDocuments(original: Uint8Array, modified: Uint8Array, author: string): Uint8Array;
  acceptRevisions(docx: Uint8Array): Uint8Array;
  rejectRevisions(docx: Uint8Array): Uint8Array;
  /** JSON array string of {@link RedlineRevision} objects. */
  getRevisions(docx: Uint8Array): string;
};

/** Copy wasm-returned bytes into a standalone `ArrayBuffer`. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const REVISION_TYPES: ReadonlySet<string> = new Set([
  "Inserted",
  "Deleted",
  "Moved",
  "FormatChanged",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRedlineRevision = (value: unknown): value is RedlineRevision => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value["type"] !== "string" || !REVISION_TYPES.has(value["type"])) {
    return false;
  }
  return (
    typeof value["author"] === "string" &&
    typeof value["date"] === "string" &&
    typeof value["part"] === "string" &&
    typeof value["text"] === "string"
  );
};

/** Parse and validate the wasm `getRevisions` JSON at the injection boundary. */
const parseRevisionsJson = (json: string): RedlineRevision[] => {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("jubarte getRevisions returned non-array JSON");
  }
  const revisions: RedlineRevision[] = [];
  for (const entry of parsed) {
    if (!isRedlineRevision(entry)) {
      throw new Error("jubarte getRevisions returned a malformed revision entry");
    }
    revisions.push(entry);
  }
  return revisions;
};

/** Wrap an injected jubarte wasm module as a `RedlineEngine`. */
export const createJubarteWasmRedlineEngine = (module: JubarteWasmModule): RedlineEngine => ({
  name: "jubarte-wasm",
  compare: async (base, revised, { author }) => ({
    buffer: toArrayBuffer(
      module.compareDocuments(new Uint8Array(base), new Uint8Array(revised), author),
    ),
  }),
  acceptAll: async (docx) => toArrayBuffer(module.acceptRevisions(new Uint8Array(docx))),
  rejectAll: async (docx) => toArrayBuffer(module.rejectRevisions(new Uint8Array(docx))),
  getRevisions: async (docx) => parseRevisionsJson(module.getRevisions(new Uint8Array(docx))),
});
