/**
 * Corpus-driven round-trip fidelity harness — the drop-detection pipeline.
 *
 * The editor round-trip `parseDocx → toProseDoc → fromProseDoc → serialize`
 * (materialized here by {@link FolioDocxReviewer}, the exact path the editor
 * runs on load/save) must not change a document's extractable text. When it
 * does, content is silently lost or duplicated — the class of bug that produced
 * the inline-content-control unwrap and the textbox-fallback drops on the
 * `file_114` corpus pair.
 *
 * This module reuses folio's own XML-direct reader
 * ({@link extractComparableDocxContent}) — nothing here parses OOXML by hand.
 * The only added logic is an order-independent (multiset) diff of the body
 * story: a paragraph present on one side and not the other is a `net` entry.
 * Order-independence matters because a single dropped paragraph shifts every
 * line after it, and a positional diff would report the shift as dozens of
 * spurious changes.
 *
 * The companion `roundtrip-known-diffs.json` ledger records the corpus files
 * whose net diff is a *known, triaged* class awaiting a fix (each entry names
 * its class and the workstream that closes it). The test asserts empty `net`
 * for un-ledgered files (any NEW drop fails loudly, with the paragraph text in
 * the assertion) and non-empty `net` for ledgered files (an emptied entry is
 * stale and must be removed — the ledger may only ratchet down).
 */

import { FolioDocxReviewer } from "./ai-edits/headless";
import {
  extractComparableDocxContent,
  type ComparableDocxContent,
} from "./redline-lossless-verify";

/** One paragraph that exists on exactly one side of the round-trip. */
export type RoundtripNetDiff = {
  side: "dropped" | "added";
  text: string;
};

export type RoundtripDiff = {
  /** Body paragraphs present on one side only (multiset difference). */
  net: RoundtripNetDiff[];
};

const ab = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Multiset of body lines → count. Header/footer stories are id-local; the body is the invariant. */
const bodyMultiset = (content: ComparableDocxContent): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const line of content.mainText.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
};

/**
 * Round-trip `docx` through the editor path and return the multiset difference
 * of its extractable body text: `dropped` entries are present in the input and
 * missing from the output, `added` entries are the reverse. Empty `net` means
 * the round-trip preserved the body text exactly.
 */
export const diffRoundtripContent = async (docx: Uint8Array): Promise<RoundtripDiff> => {
  const input = await extractComparableDocxContent(ab(docx));
  const reviewer = await FolioDocxReviewer.fromBuffer(ab(docx));
  const output = await extractComparableDocxContent(await reviewer.toBuffer());

  const before = bodyMultiset(input);
  const after = bodyMultiset(output);
  const net: RoundtripNetDiff[] = [];
  for (const [text, count] of before) {
    const delta = count - (after.get(text) ?? 0);
    for (let i = 0; i < delta; i++) {
      net.push({ side: "dropped", text });
    }
  }
  for (const [text, count] of after) {
    const delta = count - (before.get(text) ?? 0);
    for (let i = 0; i < delta; i++) {
      net.push({ side: "added", text });
    }
  }
  return { net };
};
