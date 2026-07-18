/**
 * Browser wiring for the redline tool's compare engine.
 *
 * Loads the jubarte comparer as a WebAssembly module (built `--target web`)
 * and adapts it through folio-core's `RedlineEngine` port. jubarte-wasm is the
 * ONLY engine in the ladder: there is no fallback rung, so an engine failure
 * surfaces as a thrown `RedlineEngineExhaustedError` whose `attempts` name the
 * failing phase (compare / self-check / revisions) — never a silent downgrade.
 * folio-core's orchestrator still runs the engine-independent self-check
 * before any buffer is shown.
 */

import {
  createJubarteWasmRedlineEngine,
  generateRedlineDocx,
  RedlineEngineExhaustedError,
  type GenerateRedlineDocxResult,
  type JubarteWasmModule,
  type RedlineRevision,
} from "@stll/folio-core/server";

import initWasm, {
  acceptRevisions,
  compareDocuments,
  getRevisions,
  initPanicHook,
  rejectRevisions,
} from "./jubarte-wasm/jubarte_wasm.js";
// The bundler resolves the co-located `.wasm` to a served asset URL; passing it
// to `init` avoids relying on `import.meta.url` fetch heuristics.
import wasmUrl from "./jubarte-wasm/jubarte_wasm_bg.wasm?url";

export { RedlineEngineExhaustedError };

export type RedlineOutcome = {
  result: GenerateRedlineDocxResult;
  /** Which engine produced the verified buffer (always `jubarte-wasm`). */
  engine: string;
  /** Wall-clock milliseconds for the whole verified compare. */
  elapsedMs: number;
};

let wasmModulePromise: Promise<JubarteWasmModule> | null = null;

/** Load and initialise the jubarte wasm module once, then reuse it. */
const loadWasmModule = async (): Promise<JubarteWasmModule> => {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      // wasm-bindgen deprecated the positional-path form; pass the options object.
      await initWasm({ module_or_path: wasmUrl });
      initPanicHook();
      return { compareDocuments, acceptRevisions, rejectRevisions, getRevisions };
    })();
  }
  return wasmModulePromise;
};

/**
 * Run a verified redline over two docx buffers with jubarte-wasm as the sole
 * engine. Throws `RedlineEngineExhaustedError` (with per-phase `attempts`) on
 * failure. `performance.now` brackets the whole verified path.
 */
export const runRedline = async (
  base: ArrayBuffer,
  revised: ArrayBuffer,
  author: string,
): Promise<RedlineOutcome> => {
  const wasmModule = await loadWasmModule();
  const wasmEngine = createJubarteWasmRedlineEngine(wasmModule);
  const started = performance.now();
  const result = await generateRedlineDocx(base, revised, {
    engines: [wasmEngine],
    author,
  });
  return { result, engine: result.engine, elapsedMs: performance.now() - started };
};

/** Enumerate tracked revisions in an existing redline buffer (jubarte wasm facade). */
export const listRevisions = async (redline: ArrayBuffer): Promise<RedlineRevision[]> => {
  const wasmModule = await loadWasmModule();
  const wasmEngine = createJubarteWasmRedlineEngine(wasmModule);
  return wasmEngine.getRevisions(redline);
};

/** Copy wasm-returned bytes into a standalone `ArrayBuffer`. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

/** Accept every tracked revision in a redline buffer (jubarte wasm facade). */
export const acceptAllRevisions = async (redline: ArrayBuffer): Promise<ArrayBuffer> => {
  const wasmModule = await loadWasmModule();
  return toArrayBuffer(wasmModule.acceptRevisions(new Uint8Array(redline)));
};

/** Reject every tracked revision in a redline buffer (jubarte wasm facade). */
export const rejectAllRevisions = async (redline: ArrayBuffer): Promise<ArrayBuffer> => {
  const wasmModule = await loadWasmModule();
  return toArrayBuffer(wasmModule.rejectRevisions(new Uint8Array(redline)));
};
