/**
 * Parse→save→reparse roundtrip suite for the jubarte engine (converted from
 * the legacy-vs-jubarte parity harness once `parseDocx` became the jubarte
 * parser itself). For every fixture:
 *  - a save+reparse must preserve all visible body text, and
 *  - a SECOND save cycle must be a model fixed point (the first save may
 *    normalize once: canonical root namespaces, numbering-level w:ind
 *    materialization).
 * Heavyweight performance fixtures run the text check only.
 *
 * Run from packages/core (or the repo root) so bunfig.toml preloads the
 * canvas MeasureProvider: `bun test src/docx/jubarte`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDocx } from "../../parser";
import type { ParseOptions } from "../../parser";
import { repackDocx } from "../../rezip";
import { diffDocuments } from "./parityDiff";

const FIXTURE_DIRS = [
  join(import.meta.dir, "../../__tests__/__fixtures__/corpus"),
  join(import.meta.dir, "../../__tests__/__fixtures__/regressions"),
  join(import.meta.dir, "../../../../../../tests/visual/fixtures"),
  // Sibling-repo review corpus (tracked changes / comments); skipped silently
  // when the eigenport checkout is absent.
  "/Users/arthrod/temp/T/folio_eigen/eigenport/review-fixtures",
];

/** Fixtures excluded from the roundtrip gate entirely. */
const EXCLUDED_FIXTURES = new Set<string>([]);

/** Large perf fixtures: text-preservation check only (no second save cycle). */
const TEXT_ONLY_FIXTURES = /^perf/u;

const PARSE_OPTIONS: ParseOptions = {
  preloadFonts: false,
  parseHeadersFooters: true,
  parseNotes: true,
  detectVariables: true,
};

function loadFixtures(): Array<{ name: string; buffer: ArrayBuffer }> {
  const fixtures: Array<{ name: string; buffer: ArrayBuffer }> = [];
  for (const dir of FIXTURE_DIRS) {
    let files: string[];
    try {
      files = readdirSync(dir).toSorted();
    } catch {
      // Fixture directory unavailable in this checkout — skip silently.
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".docx") || EXCLUDED_FIXTURES.has(file)) {
        continue;
      }
      fixtures.push({ name: file, buffer: toArrayBuffer(readFileSync(join(dir, file))) });
    }
  }
  return fixtures;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function allBodyText(doc: Awaited<ReturnType<typeof parseDocx>>): string {
  const collect = (blocks: (typeof doc.package.document.content)[number][]): string => {
    let text = "";
    for (const block of blocks) {
      if (block.type === "paragraph") {
        for (const item of block.content) {
          if (item.type === "run") {
            for (const content of item.content) {
              if (content.type === "text") {
                text += content.text;
              }
            }
          } else if (item.type === "hyperlink") {
            for (const child of item.children) {
              if (child.type === "run") {
                for (const content of child.content) {
                  if (content.type === "text") {
                    text += content.text;
                  }
                }
              }
            }
          }
        }
      } else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            text += collect(cell.content);
          }
        }
      }
    }
    return text;
  };
  return collect(doc.package.document.content);
}

describe("jubarte parse/save roundtrip", () => {
  for (const fixture of loadFixtures()) {
    test(
      fixture.name,
      async () => {
        const original = await parseDocx(fixture.buffer.slice(0), PARSE_OPTIONS);
        // repackDocx mutates the model (rIds, reply markers) — save a fresh parse.
        const firstSaved = await repackDocx(
          await parseDocx(fixture.buffer.slice(0), PARSE_OPTIONS),
        );
        const firstReparsed = await parseDocx(firstSaved, PARSE_OPTIONS);
        expect(allBodyText(firstReparsed)).toBe(allBodyText(original));

        if (TEXT_ONLY_FIXTURES.test(fixture.name)) {
          return;
        }

        // Settled fixed point: a second save cycle must not change the model.
        const secondSaved = await repackDocx(await parseDocx(firstSaved, PARSE_OPTIONS));
        const secondReparsed = await parseDocx(secondSaved, PARSE_OPTIONS);
        const diffs = diffDocuments(firstReparsed, secondReparsed);
        if (diffs.length > 0) {
          console.error(`\n[roundtrip:${fixture.name}] ${diffs.length}+ differences:`);
          for (const diff of diffs.slice(0, 40)) {
            console.error(`  ${diff}`);
          }
        }
        expect(diffs).toEqual([]);
      },
      120_000,
    );
  }
});
