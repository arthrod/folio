/**
 * Browser wiring for the redline tool's compare engine.
 *
 * Loads the jubarte comparer as a WebAssembly module (built `--target web`)
 * and adapts it through folio-core's `RedlineEngine` port. The tool therefore
 * exercises the real Phase-1 architecture end to end in the browser: the wasm
 * engine is primary, the pure-TypeScript story engine is the fallback rung,
 * and folio-core's orchestrator runs the engine-independent self-check before
 * any buffer is shown.
 */

import {
  createJubarteWasmRedlineEngine,
  generateRedlineDocx,
  storyRedlineEngine,
  type GenerateRedlineDocxResult,
  type JubarteWasmModule,
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

export type RedlineOutcome = {
  result: GenerateRedlineDocxResult;
  /** Which engine produced the verified buffer (`jubarte-wasm` or `folio-story`). */
  engine: string;
  /** Wall-clock milliseconds for the whole verified compare. */
  elapsedMs: number;
};

let wasmModulePromise: Promise<JubarteWasmModule> | null = null;

/** Load and initialise the jubarte wasm module once, then reuse it. */
const loadWasmModule = async (): Promise<JubarteWasmModule> => {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      await initWasm(wasmUrl);
      initPanicHook();
      return { compareDocuments, acceptRevisions, rejectRevisions, getRevisions };
    })();
  }
  return wasmModulePromise;
};

/**
 * Run a verified redline over two docx buffers. The wasm engine is tried
 * first; folio's story engine is the fallback rung; the orchestrator's
 * self-check gates both. `performance.now` brackets the whole verified path.
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
    engines: [wasmEngine, storyRedlineEngine],
    author,
    // Byte engine: verify through folio's XML-direct extractor, not the
    // editorial reviewer (which drops OOXML it cannot model, a false negative).
    selfCheck: "engine-lossless",
  });
  return { result, engine: result.engine, elapsedMs: performance.now() - started };
};

/** Accept every tracked revision in a redline buffer (jubarte wasm facade). */
export const acceptAllRevisions = async (redline: ArrayBuffer): Promise<ArrayBuffer> => {
  const wasmModule = await loadWasmModule();
  const bytes = wasmModule.acceptRevisions(new Uint8Array(redline));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

/** Reject every tracked revision in a redline buffer (jubarte wasm facade). */
export const rejectAllRevisions = async (redline: ArrayBuffer): Promise<ArrayBuffer> => {
  const wasmModule = await loadWasmModule();
  const bytes = wasmModule.rejectRevisions(new Uint8Array(redline));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
