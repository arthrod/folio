import { describe, expect, it } from "bun:test";

import type {
  LayoutInput,
  MeasuredDocumentSnapshot,
  PremirrorOptions,
  SegmentFitEngineLike,
} from "@stll/premirror-core";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@stll/premirror-core";

import { composeLayout } from "./index";

/**
 * The composer measures through an injected `SegmentFitEngineLike`
 * (E-4 unification; see UPSTREAM.md). Most tests supply `measuredRuns` widths
 * and no engine, so widths are exact; the engine success and failure paths
 * are covered explicitly below by injecting deterministic fakes — no module
 * mocking involved.
 */

function makeInput(overrides?: Partial<PremirrorOptions>): LayoutInput {
  return createLayoutInputFromOptions(defaultPremirrorOptions(overrides));
}

function makeSnapshot(text: string): MeasuredDocumentSnapshot {
  return {
    blocks: [
      {
        id: "b1",
        type: "paragraph",
        attrs: {},
        pmRange: { from: 1, to: text.length + 2 },
        runs: [
          {
            id: "r1",
            text,
            font: "normal 400 16px Inter",
            marks: {},
            pmRange: { from: 1, to: text.length + 1 },
          },
        ],
      },
    ],
    measuredRuns: {
      r1: {
        runId: "r1",
        prepared: {},
        widthPx: Math.max(20, text.length * 8),
        textLength: text.length,
      },
    },
  };
}

describe("@premirror/composer", () => {
  it("produces at least one page and frame", () => {
    const out = composeLayout(makeSnapshot("Hello Premirror"), null, makeInput());
    expect(out.pages.length).toBeGreaterThan(0);
    expect(out.pages[0]?.frames.length).toBe(1);
  });

  it("is deterministic for page+fragment structure", () => {
    const snapshot = makeSnapshot("Determinism test paragraph that wraps.");
    const input = makeInput();
    const a = composeLayout(snapshot, null, input);
    const b = composeLayout(snapshot, null, input);
    expect(JSON.stringify(a.pages)).toBe(JSON.stringify(b.pages));
  });

  it("applies manual page break before a block", () => {
    const snapshot: MeasuredDocumentSnapshot = {
      blocks: [
        {
          id: "b1",
          type: "paragraph",
          attrs: {},
          pmRange: { from: 1, to: 20 },
          runs: [
            {
              id: "r1",
              text: "First block.",
              font: "normal 400 16px Inter",
              marks: {},
              pmRange: { from: 1, to: 12 },
            },
          ],
        },
        {
          id: "b2",
          type: "paragraph",
          attrs: { manualPageBreakBefore: true },
          pmRange: { from: 21, to: 40 },
          runs: [
            {
              id: "r2",
              text: "Second block.",
              font: "normal 400 16px Inter",
              marks: {},
              pmRange: { from: 21, to: 33 },
            },
          ],
        },
      ],
      measuredRuns: {
        r1: { runId: "r1", prepared: {}, widthPx: 80, textLength: 12 },
        r2: { runId: "r2", prepared: {}, widthPx: 90, textLength: 13 },
      },
    };
    const out = composeLayout(snapshot, null, makeInput());
    expect(out.pages.length).toBeGreaterThanOrEqual(2);
  });

  it("round-trips mapping positions for a line", () => {
    const out = composeLayout(makeSnapshot("Mapping"), null, makeInput());
    const point = out.mapping.pmPosToLayout(2);
    expect(point).not.toBeNull();
    if (!point) return;
    const back = out.mapping.layoutToPmPos(point);
    expect(back).toBe(2);
  });

  it("uses an engine-measured width when no measuredRuns entry exists (engine success path)", () => {
    // Inject a deterministic engine, as the bridge would in production.
    // Exercises the `widthBySegmentFit` success branch (formerly the
    // pretext-module success path, then covered by mocking the module
    // boundary; the seam makes plain injection sufficient).
    const engine: SegmentFitEngineLike = {
      prepare: (text: string) => ({ text }),
      fitLine: (prepared) => {
        const { text } = prepared as { text: string };
        return {
          endChar: text.length,
          width: text.length * 100,
          cursor: null,
        };
      },
    };

    const snapshot: MeasuredDocumentSnapshot = {
      blocks: [
        {
          id: "b1",
          type: "paragraph",
          attrs: {},
          pmRange: { from: 1, to: 4 },
          runs: [
            {
              id: "unmeasured-run",
              text: "AB",
              font: "normal 400 16px Inter",
              marks: {},
              pmRange: { from: 1, to: 3 },
            },
          ],
        },
      ],
      measuredRuns: {},
    };

    const out = composeLayout(snapshot, null, makeInput({ engine }));
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("AB");
    expect(run?.width).toBe(200);
  });

  it("falls back to the deterministic 7px/char width when no measuredRuns entry exists and the engine fails", () => {
    // Prior/baseline behavior: when neither `prepared.widthPx` nor engine
    // measurement is available, composeLayout must still produce stable
    // widths via the deterministic fallback rather than throwing or NaN-ing.
    const engine: SegmentFitEngineLike = {
      prepare: () => {
        throw new Error("engine unavailable");
      },
      fitLine: () => null,
    };

    const snapshot: MeasuredDocumentSnapshot = {
      blocks: [
        {
          id: "b1",
          type: "paragraph",
          attrs: {},
          pmRange: { from: 1, to: 4 },
          runs: [
            {
              id: "no-measurement-run",
              text: "XY",
              font: "normal 400 16px Inter",
              marks: {},
              pmRange: { from: 1, to: 3 },
            },
          ],
        },
      ],
      measuredRuns: {},
    };

    const out = composeLayout(snapshot, null, makeInput({ engine }));
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("XY");
    expect(run?.width).toBe(14);
  });
});

describe("segment-fit engine injection (E-4 unification)", () => {
  // Unique font string: the module-level width LRU keys on (font, text), so
  // sharing fonts with other suites would let a cached width cross tests.
  const ENGINE_FONT = "normal 400 17px SeamProbe";

  const fakeTenPxEngine: SegmentFitEngineLike = {
    prepare: (text: string) => ({ text }),
    fitLine: (prepared) => {
      const { text } = prepared as { text: string };
      if (text.length === 0) return null;
      return { endChar: text.length, width: text.length * 10, cursor: null };
    },
  };

  function unmeasuredSnapshot(text: string): MeasuredDocumentSnapshot {
    return {
      blocks: [
        {
          id: "b1",
          type: "paragraph",
          attrs: {},
          pmRange: { from: 1, to: text.length + 2 },
          runs: [
            {
              id: "seam-run",
              text,
              font: ENGINE_FONT,
              marks: {},
              pmRange: { from: 1, to: text.length + 1 },
            },
          ],
        },
      ],
      measuredRuns: {},
    };
  }

  it("measures unmeasured runs through the injected engine (fake 10px/char widths show up)", () => {
    const out = composeLayout(
      unmeasuredSnapshot("engine"),
      null,
      makeInput({ engine: fakeTenPxEngine }),
    );
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("engine");
    expect(run?.width).toBe(60);
  });

  it("hits the deterministic 7px/char fallback when no engine is injected", () => {
    const out = composeLayout(unmeasuredSnapshot("fallback"), null, makeInput());
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("fallback");
    expect(run?.width).toBe(56);
  });

  it("keeps width caches per engine: a second engine's widths are its own, not the first's", () => {
    const fakeTwentyPxEngine: SegmentFitEngineLike = {
      prepare: (text: string) => ({ text }),
      fitLine: (prepared) => {
        const { text } = prepared as { text: string };
        if (text.length === 0) return null;
        return { endChar: text.length, width: text.length * 20, cursor: null };
      },
    };
    // Same font + text through both engines, deliberately: engine identity
    // must be part of the cache identity, or the second measure returns the
    // first engine's cached width.
    const first = composeLayout(
      unmeasuredSnapshot("shared"),
      null,
      makeInput({ engine: fakeTenPxEngine }),
    );
    expect(first.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0]?.width).toBe(60);
    const second = composeLayout(
      unmeasuredSnapshot("shared"),
      null,
      makeInput({ engine: fakeTwentyPxEngine }),
    );
    expect(second.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0]?.width).toBe(120);
  });
});
