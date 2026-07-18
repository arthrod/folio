/**
 * Faithful self-check medium tests.
 *
 * The pure tests pin the projection from folio's `extractDocxText` output to
 * comparable per-story content, and the accept/reject comparison. They need no
 * engine and run in CI.
 *
 * The gated tests prove the reason this medium exists: on real Word files the
 * folio-reviewer self-check drops OOXML it does not model, so a byte-faithful
 * engine's output fails verification and the ladder falls back. With the
 * XML-direct medium selected (`selfCheck: "engine-lossless"`), the jubarte-wasm
 * engine verifies across the corpus. Point:
 *   JUBARTE_WASM_PKG   -> built pkg/jubarte_wasm.js (nodejs target)
 *   REDLINE_CORPUS_DIR -> neurotic_docx_bench/corpus/word_based/docx_source
 *   REDLINE_CORPUS_CSV -> …/word_based/centralized_mapping.csv (optional; the
 *                         sweep derives it from REDLINE_CORPUS_DIR when unset)
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { ExtractedDocxParagraph, ExtractedDocxText } from "./docx/server/extractDocxText";
import { generateRedlineDocx } from "./redline";
import { createJubarteWasmRedlineEngine, type JubarteWasmModule } from "./redline-engine-jubarte";
import { compareLossless, toComparableDocxContent } from "./redline-lossless-verify";

const paragraph = (
  text: string,
  source: ExtractedDocxParagraph["source"],
  index: number,
): ExtractedDocxParagraph => ({ index, text, source });

const extracted = (paragraphs: ExtractedDocxParagraph[]): ExtractedDocxText => ({
  paragraphs,
  charCount: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
  view: "accepted",
});

describe("toComparableDocxContent (extractDocxText → comparable content)", () => {
  test("joins body paragraphs into the main story, dropping empty paragraphs", () => {
    const content = toComparableDocxContent(
      extracted([
        paragraph("Hello world", "body", 0),
        paragraph("", "body", 1),
        paragraph("Second", "body", 2),
      ]),
    );
    expect(content.mainText).toBe("Hello world\nSecond");
    expect(content.secondaryByType.size).toBe(0);
  });

  test("partitions header/footer stories by source and drops empty ones", () => {
    const content = toComparableDocxContent(
      extracted([
        paragraph("H", "header", 0),
        paragraph("", "footer", 1),
        paragraph("body", "body", 2),
      ]),
    );
    expect(content.mainText).toBe("body");
    expect(content.secondaryByType.get("header")).toEqual(["H"]);
    expect(content.secondaryByType.has("footer")).toBe(false);
  });
});

describe("compareLossless", () => {
  const of = (main: string): ReturnType<typeof toComparableDocxContent> => ({
    mainText: main,
    secondaryByType: new Map(),
  });

  test("returns null when accept reproduces revised and reject reproduces base", () => {
    expect(
      compareLossless({
        accepted: of("revised"),
        rejected: of("base"),
        base: of("base"),
        revised: of("revised"),
      }),
    ).toBeNull();
  });

  test("flags a dropped-content accept view", () => {
    expect(
      compareLossless({
        accepted: of("revsed"),
        rejected: of("base"),
        base: of("base"),
        revised: of("revised"),
      }),
    ).toBe("accept-all main story diverges from the revised document");
  });

  test("flags a header story missing from the reject view", () => {
    const base = {
      mainText: "b",
      secondaryByType: new Map([["header" as const, ["Confidential"]]]),
    };
    const rejected = { mainText: "b", secondaryByType: new Map() };
    expect(compareLossless({ accepted: of("r"), rejected, base, revised: of("r") })).toBe(
      "reject-all view drops a header story",
    );
  });
});

// --- Gated integration: the medium's reason to exist, on real Word files. ---

/**
 * Minimal quote-aware CSV line splitter. Handles double-quoted fields
 * containing commas and doubled-quote escapes (`""` → `"`). Sufficient
 * for the corpus mapping CSV; no external dependency.
 */
const splitCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
};

describe("splitCsvLine", () => {
  test("handles a quoted field containing a comma", () => {
    const line = 'a,b,"hello, world",c';
    expect(splitCsvLine(line)).toEqual(["a", "b", "hello, world", "c"]);
  });

  test("handles doubled-quote escapes inside a quoted field", () => {
    const line = 'a,"say ""hi""",c';
    expect(splitCsvLine(line)).toEqual(["a", 'say "hi"', "c"]);
  });

  test("handles a plain unquoted line", () => {
    const line = "a,b,c,d,e,f";
    expect(splitCsvLine(line)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

const wasmPkgPath = process.env["JUBARTE_WASM_PKG"];
const corpusDir = process.env["REDLINE_CORPUS_DIR"];
const haveTooling = wasmPkgPath !== undefined && existsSync(wasmPkgPath);

const loadWasm = (): JubarteWasmModule => {
  const require = createRequire(import.meta.url);
  // SAFETY: existence guarded by `haveTooling`; shape is the adapter's contract.
  const module = require(wasmPkgPath as string) as JubarteWasmModule & {
    initPanicHook?: () => void;
  };
  module.initPanicHook?.();
  return module;
};

const readDocx = (path: string): ArrayBuffer => {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

// The specific pair whose main-story drop (a deleted hyperlink in a table cell)
// the folio-reviewer self-check misses: it fell back off jubarte-wasm here.
const failingPairPresent =
  haveTooling &&
  corpusDir !== undefined &&
  existsSync(join(corpusDir, "docx_lots_of_comments.docx")) &&
  existsSync(join(corpusDir, "double_spacing_bold_demo_id_paraid_overflow.docx"));

describe.if(failingPairPresent)("engine-lossless self-check on the known folio-lossy pair", () => {
  test("jubarte-wasm verifies with the XML-direct medium (folio path fell back)", async () => {
    const module = loadWasm();
    const base = readDocx(join(corpusDir as string, "docx_lots_of_comments.docx"));
    const revised = readDocx(
      join(corpusDir as string, "double_spacing_bold_demo_id_paraid_overflow.docx"),
    );

    const result = await generateRedlineDocx(base, revised, {
      engines: [createJubarteWasmRedlineEngine(module)],
      selfCheck: "engine-lossless",
    });
    expect(result.engine).toBe("jubarte-wasm");
    expect(result.revisions.length).toBeGreaterThan(0);
  });
});

// Full corpus sweep: measure how many base→revised pairs verify via jubarte-wasm
// with the XML-direct self-check. The threshold guards the false-negative fix
// (the folio-reviewer path fell back on far more); residual failures are genuine
// engine artifacts (word-diff punctuation placement, AlternateContent choice
// resolution, volatile field results), not reviewer lossiness.
const csvPath =
  process.env["REDLINE_CORPUS_CSV"] ??
  (corpusDir !== undefined ? join(dirname(corpusDir), "centralized_mapping.csv") : undefined);
const haveCorpusSweep =
  haveTooling && corpusDir !== undefined && csvPath !== undefined && existsSync(csvPath);

describe.if(haveCorpusSweep)("engine-lossless corpus sweep (REDLINE_CORPUS_DIR + mapping)", () => {
  test("verifies via jubarte-wasm on the overwhelming majority of present pairs", async () => {
    const module = loadWasm();
    const rows = readFileSync(csvPath as string, "utf8").trim().split("\n").slice(1);

    const pairs: { stem: string; base: string; revised: string }[] = [];
    for (const row of rows) {
      const cols = splitCsvLine(row);
      const baseName = cols[4];
      const revisedName = cols[5];
      if (baseName === undefined || revisedName === undefined) {
        continue;
      }
      const base = join(corpusDir as string, baseName);
      const revised = join(corpusDir as string, revisedName);
      if (existsSync(base) && existsSync(revised)) {
        pairs.push({ stem: cols[0] ?? "", base, revised });
      }
    }
    expect(pairs.length).toBeGreaterThanOrEqual(100);

    const engine = createJubarteWasmRedlineEngine(module);
    const failures: string[] = [];
    for (const pair of pairs) {
      try {
        const result = await generateRedlineDocx(readDocx(pair.base), readDocx(pair.revised), {
          engines: [engine],
          selfCheck: "engine-lossless",
        });
        if (result.engine !== "jubarte-wasm") {
          failures.push(`${pair.stem}: engine=${result.engine}`);
        }
      } catch (error) {
        failures.push(`${pair.stem}: ${String(error).slice(0, 60)}`);
      }
    }
    const passRate = (pairs.length - failures.length) / pairs.length;
    // eslint-disable-next-line no-console -- surfaces the honest residual when a run regresses
    console.log(`engine-lossless sweep: ${pairs.length - failures.length}/${pairs.length} verified`);
    for (const failure of failures) {
      // eslint-disable-next-line no-console -- name each residual for triage
      console.log(`  fallback: ${failure}`);
    }
    // The folio-reviewer medium fell back on far more (its lossiness is the bug
    // this fixes). The residual few are genuine engine artifacts the self-check
    // correctly rejects (safe fallback), not reviewer false negatives — so the
    // floor sits below the current rate to tolerate engine-version drift without
    // masking a real medium regression, which the hard failing-pair test guards.
    expect(passRate).toBeGreaterThanOrEqual(0.9);
  }, 600_000);
});
