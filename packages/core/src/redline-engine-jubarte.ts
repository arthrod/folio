/**
 * The jubarte-wasm adapter for the `RedlineEngine` port.
 *
 * folio-core never imports the jubarte package — the caller loads it (owning
 * that dependency and its license) and injects it here as a structural
 * module. This keeps folio-core dependency-free of the comparer while still
 * providing the adapter shape, so the license boundary sits at the injector.
 */

import type { RedlineEngine, RedlineRevision } from "./redline-engine";

/**
 * Structural surface of the jubarte wasm package (wasm-pack `nodejs`/`web`
 * targets export the same names). Structural on purpose: folio-core never
 * imports the package — the caller injects a value matching this shape.
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
// The wasm module is synchronous; the engine port is Promise-based. Route sync
// throws into rejections, matching what the previous `async` wrappers did.
const asResolved = <T>(compute: () => T): Promise<T> => {
  try {
    return Promise.resolve(compute());
  } catch (error) {
    return Promise.reject(error);
  }
};

export const createJubarteWasmRedlineEngine = (module: JubarteWasmModule): RedlineEngine => ({
  name: "jubarte-wasm",
  compare: (base, revised, { author }) =>
    asResolved(() => ({
      buffer: toArrayBuffer(
        module.compareDocuments(new Uint8Array(base), new Uint8Array(revised), author),
      ),
    })),
  acceptAll: (docx) =>
    asResolved(() => toArrayBuffer(module.acceptRevisions(new Uint8Array(docx)))),
  rejectAll: (docx) =>
    asResolved(() => toArrayBuffer(module.rejectRevisions(new Uint8Array(docx)))),
  getRevisions: (docx) =>
    asResolved(() => parseRevisionsJson(module.getRevisions(new Uint8Array(docx)))),
});
