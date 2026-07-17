import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import knownDiffs from "./roundtrip-known-diffs.json";
import { diffRoundtripContent } from "./roundtrip-fidelity";

/**
 * The corpus lives in the (AGPL, CI-only) neurotic_docx_bench repo, so the sweep
 * is gated on an env var pointing at a `*_redline.docx` folder — the same
 * pattern the wasm-integration suites use. Unset ⇒ the sweep is skipped; the
 * shape assertions below still document the harness contract in prose.
 */
const CORPUS = process.env.ROUNDTRIP_CORPUS_DIR;
const files = CORPUS ? readdirSync(CORPUS).filter((f) => f.endsWith(".docx")).sort() : [];
const ledger = knownDiffs as Record<string, string>;

describe.if(Boolean(CORPUS))("PM round-trip preserves body text (corpus sweep)", () => {
  for (const file of files) {
    test(file, async () => {
      const buf = new Uint8Array(readFileSync(join(CORPUS!, file)));
      const { net } = await diffRoundtripContent(buf);
      const known = ledger[file];
      if (known) {
        // A ledgered file is a KNOWN, triaged drop awaiting its fix. An empty
        // net means the fix landed and the entry is stale — fail so the ledger
        // ratchets down (entries may only be removed, never left dangling).
        expect(net.length, `stale ledger entry "${known}" — round-trip is now clean, remove it`).toBeGreaterThan(0);
        return;
      }
      // Un-ledgered: any drop or addition is a NEW regression. The failing
      // assertion carries the offending paragraph text so triage starts here.
      expect(net, `NEW round-trip drop in ${file} — triage, ledger a class, or fix`).toEqual([]);
    });
  }
});
