/**
 * Reviewer-view resolution fidelity harness (resolution-fidelity family;
 * D-pipeline extension — the class the round-trip harness cannot see).
 *
 * The parse→serialize round-trip harness (`roundtrip-fidelity.test.ts`) never
 * exercises VIEW RESOLUTION: `FolioDocxReviewer.readReviewedStory` materializes
 * accept-all (`final`) / reject-all (`original`) views through the ProseMirror
 * resolver, and that path has shipped corruption twice (the non-atomic
 * `tr.join` pPrMark bug, and — found by the D-2 bench scoreboard — a
 * `TransformError: Structure replace would overwrite content` thrown on the
 * reject view of ~23% of Word's own corpus redlines).
 *
 * This harness sweeps a corpus of REDLINE documents (Word-made tracked-change
 * files; the bench repo's `corpus/word_based/docx_redlines_randomized`) and
 * asserts both views of every main story materialize without throwing. Known
 * failures live in `reviewer-views-known-throws.json` with a class name and an
 * owning task; the ledger only ratchets down — a ledgered file that stops
 * throwing fails as stale so the entry gets removed, and any NEW throw fails
 * loudly with the file name and error.
 *
 * Run: REVIEWER_REDLINE_CORPUS_DIR=…/corpus/word_based/docx_redlines_randomized \
 *      bun test packages/core/src/reviewer-views-fidelity.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FolioDocxReviewer } from "./ai-edits/headless";
import knownThrows from "./reviewer-views-known-throws.json";

const CORPUS = process.env.REVIEWER_REDLINE_CORPUS_DIR;
const files = CORPUS
  ? readdirSync(CORPUS)
      .filter((f) => f.endsWith(".docx"))
      .sort()
  : [];

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

/** Both views of every main story; returns the first thrown error, if any. */
const materializeViews = async (docx: ArrayBuffer): Promise<string | null> => {
  for (const view of ["final", "original"] as const) {
    try {
      const reviewer = await FolioDocxReviewer.fromBuffer(docx);
      for (const { handle } of reviewer.listStories()) {
        if (handle.type !== "main") {
          continue;
        }
        reviewer.readReviewedStory({ story: handle, view });
      }
    } catch (error) {
      return `${view}: ${String(error)}`;
    }
  }
  return null;
};

describe.if(Boolean(CORPUS))("reviewer views materialize on corpus redlines", () => {
  for (const file of files) {
    test(file, async () => {
      const buffer = readFileSync(join(CORPUS as string, file));
      const failure = await materializeViews(toArrayBuffer(buffer));
      const known = (knownThrows as Record<string, string>)[file];
      if (known) {
        // Ratchet: a ledgered file must still throw; a clean run means the
        // entry is stale and must be removed.
        expect(failure, `ledger entry "${known}" is stale — remove it`).not.toBeNull();
        return;
      }
      expect(failure).toBeNull();
    });
  }
});
