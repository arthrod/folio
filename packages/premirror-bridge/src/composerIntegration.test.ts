import { afterEach, describe, expect, it } from "bun:test";

import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "@stll/folio-core/layout-engine/measure/__tests__/fakeTextMeasure";
import { composeLayout } from "@stll/premirror-composer";
import type { MeasuredDocumentSnapshot, SegmentFitEngineLike } from "@stll/premirror-core";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@stll/premirror-core";

import { clearPreparedCache, pretextSegmentFitEngine } from "./pretextEngine";

/**
 * E-4 integration sanity: the composer — refactored to consume an injected
 * `SegmentFitEngineLike` — runs end-to-end on the REAL pretext-backed engine,
 * proving the bridge satisfies premirror-core's structural seam type. The
 * fake canvas (fixed 5px/char) makes pretext's measurement deterministic
 * under `bun test`, so engine-derived widths are distinguishable from the
 * composer's 7px/char no-engine fallback.
 */

// Compile-time proof: the folio-core-typed bridge engine satisfies
// premirror-core's structural mirror of the seam.
const engine: SegmentFitEngineLike = pretextSegmentFitEngine;

// Unique font string: the composer's width LRU and the bridge's prepared
// cache both key on (font, text); keep this suite's entries isolated.
const FONT = "16px BridgeIntegration";

afterEach(() => {
  clearPreparedCache();
});

function unmeasuredSnapshot(text: string): MeasuredDocumentSnapshot {
  return {
    blocks: [
      {
        id: "b0",
        type: "paragraph",
        attrs: {},
        pmRange: { from: 1, to: text.length + 2 },
        runs: [
          { id: "r0", text, font: FONT, marks: {}, pmRange: { from: 1, to: text.length + 1 } },
        ],
      },
    ],
    measuredRuns: {},
  };
}

describe("composer end-to-end on the real pretext engine", () => {
  it("paginates a tiny snapshot with engine-measured, finite widths", () => {
    withFakeTextMeasure(
      () => {
        const text = "alpha bravo charlie";
        const out = composeLayout(
          unmeasuredSnapshot(text),
          null,
          createLayoutInputFromOptions(defaultPremirrorOptions({ engine })),
        );

        expect(out.pages.length).toBeGreaterThanOrEqual(1);
        const runs = out.pages.flatMap((p) =>
          p.frames.flatMap((f) => f.fragments.flatMap((fr) => fr.lines.flatMap((l) => l.runs))),
        );
        expect(runs.length).toBeGreaterThan(0);
        for (const run of runs) {
          expect(Number.isFinite(run.width)).toBe(true);
        }
        // Widths are engine-derived (5px/char via the fake canvas), not the
        // composer's 7px/char no-engine fallback.
        const full = runs.find((r) => r.text === text);
        expect(full?.width).toBe(text.length * 5);
      },
      { charWidth: fixedCharWidth(5) },
    );
  });
});
