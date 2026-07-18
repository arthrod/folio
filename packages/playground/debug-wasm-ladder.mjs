// Probe: run folio-core's redline orchestrator with ONLY the jubarte wasm
// engine, so a primary-engine failure surfaces as RedlineEngineExhaustedError
// with per-phase attempts instead of being swallowed by the story fallback.
import { readFile } from "node:fs/promises";

import {
  createJubarteWasmRedlineEngine,
  generateRedlineDocx,
} from "@stll/folio-core/server";

import initWasm, {
  acceptRevisions,
  compareDocuments,
  getRevisions,
  initPanicHook,
  rejectRevisions,
} from "./src/redline/jubarte-wasm/jubarte_wasm.js";

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const wasmBytes = await readFile(new URL("./src/redline/jubarte-wasm/jubarte_wasm_bg.wasm", import.meta.url));
await initWasm({ module_or_path: wasmBytes });
initPanicHook();
const wasmEngine = createJubarteWasmRedlineEngine({
  compareDocuments,
  acceptRevisions,
  rejectRevisions,
  getRevisions,
});

const [aPath, bPath] = process.argv.slice(2);
const [a, b] = await Promise.all([readFile(aPath), readFile(bPath)]);

try {
  const started = performance.now();
  const result = await generateRedlineDocx(toArrayBuffer(a), toArrayBuffer(b), {
    engines: [wasmEngine],
    author: "debug-probe",
  });
  console.log(
    JSON.stringify(
      {
        outcome: "SUCCESS",
        engine: result.engine,
        revisions: result.revisions.length,
        elapsedMs: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify(
      {
        outcome: "FAILED",
        name: error?.constructor?.name,
        message: error?.message,
        attempts: error?.attempts ?? null,
      },
      null,
      2,
    ),
  );
}
