/**
 * RedlineEngine port tests: folio-core's compare seam is one narrow internal
 * interface with swappable adapters (plugin-style). These tests drive the
 * orchestrator with engine doubles — no engine package is required — and pin
 * the four invariants of the port:
 *
 * 1. A verified engine's buffer flows through untouched, with the engine's
 *    revision enumeration and name on the result.
 * 2. The ladder walks to the next engine when one throws.
 * 3. The engine-independent self-check (accept-all ≍ revised, reject-all ≍
 *    base, judged through `FolioDocxReviewer`, never the engine's own
 *    accept/reject) rejects a wrong buffer; a failing ladder never returns an
 *    unverified buffer.
 * 4. Package-level engines report empty deprecated `skipped` /
 *    `unprocessedStories` fields.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { FolioDocxReviewer } from "./ai-edits/headless";
import { createDocx } from "./docx/rezip";
import { generateRedlineDocx } from "./redline";
import {
  RedlineEngineExhaustedError,
  type RedlineEngine,
  type RedlineRevision,
} from "./redline-engine";
import { createJubarteWasmRedlineEngine, type JubarteWasmModule } from "./redline-engine-jubarte";
import { createEmptyDocument } from "./utils/createDocument";

type ParagraphSpec = { text: string; paraId?: string };

const buildDocxBuffer = (paragraphs: readonly ParagraphSpec[]): Promise<ArrayBuffer> => {
  const template = createEmptyDocument();
  return createDocx({
    ...template,
    package: {
      ...template.package,
      document: {
        ...template.package.document,
        content: paragraphs.map(({ text, paraId }) => ({
          type: "paragraph",
          content: [{ type: "run", content: [{ type: "text", text }] }],
          ...(paraId !== undefined && { paraId }),
        })),
      },
    },
  });
};

/** A genuine base→revisedText redline built through the reviewer. */
const buildTrackedRedline = async (
  base: ArrayBuffer,
  revisedText: string,
): Promise<ArrayBuffer> => {
  const reviewer = await FolioDocxReviewer.fromBuffer(base, { author: "Engine double" });
  const target = reviewer.snapshot().blocks.at(0);
  if (!target) {
    throw new Error("expected a main-story block");
  }
  reviewer.applyOperations(
    [{ id: "double-1", type: "replaceBlock", blockId: target.id, text: revisedText }],
    { mode: "tracked-changes" },
  );
  return reviewer.toBuffer();
};

const DOUBLE_REVISIONS: RedlineRevision[] = [
  {
    type: "Deleted",
    author: "Engine double",
    date: "2026-07-17T00:00:00Z",
    part: "word/document.xml",
    moveGroupId: null,
    isMoveSource: null,
    formatChange: null,
    text: "thirty",
  },
  {
    type: "Inserted",
    author: "Engine double",
    date: "2026-07-17T00:00:00Z",
    part: "word/document.xml",
    moveGroupId: null,
    isMoveSource: null,
    formatChange: null,
    text: "sixty",
  },
];

/**
 * Engine double. `acceptAll`/`rejectAll` throw: the orchestrator's self-check
 * must be engine-independent, so the double proves they are never consulted.
 */
const engineDouble = (
  name: string,
  compare: (base: ArrayBuffer, revised: ArrayBuffer) => Promise<ArrayBuffer>,
  revisions: RedlineRevision[] = DOUBLE_REVISIONS,
): RedlineEngine => ({
  name,
  compare: async (base, revised) => ({ buffer: await compare(base, revised) }),
  acceptAll: () => {
    throw new Error(`${name}.acceptAll must not be called by the orchestrator`);
  },
  rejectAll: () => {
    throw new Error(`${name}.rejectAll must not be called by the orchestrator`);
  },
  getRevisions: async () => revisions,
});

const BASE_TEXT = "Payment is due within thirty days.";
const REVISED_TEXT = "Payment is due within sixty days.";

const buildComparePair = async (): Promise<{ base: ArrayBuffer; revised: ArrayBuffer }> => ({
  base: await buildDocxBuffer([{ text: BASE_TEXT, paraId: "00000001" }]),
  revised: await buildDocxBuffer([{ text: REVISED_TEXT, paraId: "00000001" }]),
});

describe("RedlineEngine port", () => {
  test("a verified engine's buffer flows through with revisions, engine name, and empty deprecated fields", async () => {
    const { base, revised } = await buildComparePair();
    const redline = await buildTrackedRedline(base, REVISED_TEXT);
    const engine = engineDouble("double-primary", async () => redline);

    const result = await generateRedlineDocx(base, revised, { engines: [engine] });

    expect(result.engine).toBe("double-primary");
    expect(result.revisions).toEqual(DOUBLE_REVISIONS);
    expect(result.skipped).toEqual([]);
    expect(result.unprocessedStories).toEqual([]);
    const view = await FolioDocxReviewer.fromBuffer(result.buffer);
    expect(view.snapshot().blocks.at(0)?.text).toBe(REVISED_TEXT);
  });

  test("the ladder falls back to the next engine when the primary throws", async () => {
    const { base, revised } = await buildComparePair();
    const redline = await buildTrackedRedline(base, REVISED_TEXT);
    const primary = engineDouble("double-broken", async () => {
      throw new Error("engine trap");
    });
    const fallback = engineDouble("double-fallback", async () => redline);

    const result = await generateRedlineDocx(base, revised, {
      engines: [primary, fallback],
    });

    expect(result.engine).toBe("double-fallback");
    expect(result.revisions).toEqual(DOUBLE_REVISIONS);
  });

  test("the self-check rejects a buffer whose accept view does not equal the revised text", async () => {
    const { base, revised } = await buildComparePair();
    // A lying engine: returns the base unchanged (no tracked changes), so the
    // output's final view equals the base, not the revised document.
    const lying = engineDouble("double-lying", async (lyingBase) => lyingBase);
    const redline = await buildTrackedRedline(base, REVISED_TEXT);
    const honest = engineDouble("double-honest", async () => redline);

    const result = await generateRedlineDocx(base, revised, {
      engines: [lying, honest],
    });
    expect(result.engine).toBe("double-honest");
  });

  test("a ladder with no verifiable engine throws a typed error and never returns a buffer", async () => {
    const { base, revised } = await buildComparePair();
    const lying = engineDouble("double-lying", async (lyingBase) => lyingBase);
    const broken = engineDouble("double-broken", async () => {
      throw new Error("engine trap");
    });

    await expect(
      generateRedlineDocx(base, revised, { engines: [lying, broken] }),
    ).rejects.toBeInstanceOf(RedlineEngineExhaustedError);

    try {
      await generateRedlineDocx(base, revised, { engines: [lying, broken] });
    } catch (error) {
      if (!(error instanceof RedlineEngineExhaustedError)) {
        throw error;
      }
      expect(error.attempts.map(({ engine }) => engine)).toEqual(["double-lying", "double-broken"]);
      expect(error.attempts.at(0)?.phase).toBe("self-check");
      expect(error.attempts.at(1)?.phase).toBe("compare");
    }
  });
});

describe("createJubarteWasmRedlineEngine", () => {
  test("adapts the structural wasm module: bytes in, ArrayBuffer out, revisions JSON parsed", async () => {
    const { base, revised } = await buildComparePair();
    const redline = await buildTrackedRedline(base, REVISED_TEXT);
    const authors: string[] = [];
    const module: JubarteWasmModule = {
      compareDocuments: (original, modified, author) => {
        authors.push(author);
        expect(original).toBeInstanceOf(Uint8Array);
        expect(modified).toBeInstanceOf(Uint8Array);
        return new Uint8Array(redline);
      },
      acceptRevisions: (docx) => docx,
      rejectRevisions: (docx) => docx,
      getRevisions: () => JSON.stringify(DOUBLE_REVISIONS),
    };

    const engine = createJubarteWasmRedlineEngine(module);
    expect(engine.name).toBe("jubarte-wasm");

    const compared = await engine.compare(base, revised, { author: "Jan Kubica" });
    expect(authors).toEqual(["Jan Kubica"]);
    expect(compared.buffer).toBeInstanceOf(ArrayBuffer);

    const revisions = await engine.getRevisions(compared.buffer);
    expect(revisions).toEqual(DOUBLE_REVISIONS);

    const accepted = await engine.acceptAll(compared.buffer);
    expect(accepted).toBeInstanceOf(ArrayBuffer);
  });

  test("wires as the primary engine through generateRedlineDocx", async () => {
    const { base, revised } = await buildComparePair();
    const redline = await buildTrackedRedline(base, REVISED_TEXT);
    const module: JubarteWasmModule = {
      compareDocuments: () => new Uint8Array(redline),
      acceptRevisions: (docx) => docx,
      rejectRevisions: (docx) => docx,
      getRevisions: () => JSON.stringify(DOUBLE_REVISIONS),
    };

    const result = await generateRedlineDocx(base, revised, {
      engines: [createJubarteWasmRedlineEngine(module)],
    });

    expect(result.engine).toBe("jubarte-wasm");
    expect(result.revisions).toEqual(DOUBLE_REVISIONS);
  });
});

// Integration against the real wasm package, when present. Point
// JUBARTE_WASM_PKG at the built pkg/jubarte_wasm.js (nodejs target).
const wasmPkgPath = process.env["JUBARTE_WASM_PKG"];
const haveWasmPkg = wasmPkgPath !== undefined && existsSync(wasmPkgPath);

describe.if(haveWasmPkg)("jubarte-wasm integration (JUBARTE_WASM_PKG)", () => {
  test("real compare satisfies both redline invariants and enumerates revisions", async () => {
    const require = createRequire(import.meta.url);
    // SAFETY: existence checked by the describe.if guard; shape validated below.
    const module = require(wasmPkgPath as string) as JubarteWasmModule & {
      initPanicHook?: () => void;
    };
    module.initPanicHook?.();

    const base = await buildDocxBuffer([
      { text: "Alpha paragraph stays untouched.", paraId: "00000001" },
      { text: BASE_TEXT, paraId: "00000002" },
      { text: "Omega paragraph closes the document.", paraId: "00000003" },
    ]);
    const revised = await buildDocxBuffer([
      { text: "Alpha paragraph stays untouched.", paraId: "00000001" },
      { text: REVISED_TEXT, paraId: "00000002" },
      { text: "Omega paragraph closes the document.", paraId: "00000003" },
    ]);

    const result = await generateRedlineDocx(base, revised, {
      engines: [createJubarteWasmRedlineEngine(module)],
      author: "Integration author",
    });

    expect(result.engine).toBe("jubarte-wasm");
    expect(result.revisions.length).toBeGreaterThan(0);
    expect(new Set(result.revisions.map(({ author }) => author))).toEqual(
      new Set(["Integration author"]),
    );

    const acceptView = await FolioDocxReviewer.fromBuffer(result.buffer);
    expect(acceptView.snapshot().blocks.map(({ text }) => text)).toEqual([
      "Alpha paragraph stays untouched.",
      REVISED_TEXT,
      "Omega paragraph closes the document.",
    ]);
    const rejectView = await FolioDocxReviewer.fromBuffer(result.buffer);
    rejectView.rejectAll();
    expect(rejectView.snapshot().blocks.map(({ text }) => text)).toEqual([
      "Alpha paragraph stays untouched.",
      BASE_TEXT,
      "Omega paragraph closes the document.",
    ]);
  });
});

// Real-world regression: on genuine Word files, headers/footers carry distinct
// relationship ids that folio preserves across the base, revised, and output
// packages. The self-check must match those stories by content, not by the
// unstable id — otherwise every such redline fails verification and falls back
// off the wasm engine (observed: ~38% fallback across the corpus). Point
// REDLINE_CORPUS_DIR at neurotic_docx_bench/corpus/word_based/docx_source.
// RED against the rId-keyed self-check (engine falls back to "folio-story");
// GREEN once secondary stories match on content.
const corpusDir = process.env["REDLINE_CORPUS_DIR"];
const haveCorpusPair =
  haveWasmPkg &&
  corpusDir !== undefined &&
  existsSync(join(corpusDir, "comments.docx")) &&
  existsSync(join(corpusDir, "complex_style_attr.docx"));

describe.if(haveCorpusPair)(
  "jubarte-wasm real-world header/footer self-check (REDLINE_CORPUS_DIR)",
  () => {
    test("a real header/footer pair verifies via the wasm engine, not a fallback", async () => {
      const require = createRequire(import.meta.url);
      const module = require(wasmPkgPath as string) as JubarteWasmModule & {
        initPanicHook?: () => void;
      };
      module.initPanicHook?.();

      const read = (name: string): ArrayBuffer => {
        const bytes = readFileSync(join(corpusDir as string, name));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      };
      const result = await generateRedlineDocx(
        read("comments.docx"),
        read("complex_style_attr.docx"),
        {
          engines: [createJubarteWasmRedlineEngine(module)],
        },
      );

      expect(result.engine).toBe("jubarte-wasm");
      expect(result.revisions.length).toBeGreaterThan(0);
    });
  },
);
