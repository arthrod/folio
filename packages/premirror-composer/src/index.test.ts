import { afterEach, describe, expect, it, mock } from "bun:test";

import type { LayoutInput, MeasuredDocumentSnapshot, PremirrorOptions } from "@stll/premirror-core";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@stll/premirror-core";

import { composeLayout } from "./index";

/**
 * `@chenglou/pretext` resolves to the deterministic local stub under `bun test`
 * (see UPSTREAM.md), so the real-measurement success path is never exercised
 * by the tests above (they all supply `measuredRuns` widths instead). We mock
 * the module boundary (transport layer) to cover both the upstream/production
 * pretext-success path and the pre-existing no-measurement deterministic
 * fallback path, without patching the pretext stub's exported functions
 * directly.
 */
function restorePretextStub(): void {
  mock.module("@chenglou/pretext", () => ({
    prepareWithSegments: () => ({}),
    layoutNextLine: () => null,
  }));
}

afterEach(() => {
  restorePretextStub();
});

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

  it("uses a real pretext-measured width when no measuredRuns entry exists (upstream pretext path)", () => {
    // Simulate the real @chenglou/pretext package succeeding, as it would in
    // production (Vite aliases to the real package; only `bun test` resolves
    // the deterministic stub via tsconfig paths). Mocking the module boundary
    // here, rather than patching the stub's functions, exercises the
    // `widthByPretext` success branch that the stub can never produce.
    mock.module("@chenglou/pretext", () => ({
      prepareWithSegments: (text: string) => ({ text }),
      layoutNextLine: (prepared: unknown) => {
        const { text } = prepared as { text: string };
        return {
          text,
          width: text.length * 100,
          end: { segmentIndex: 0, graphemeIndex: text.length },
        };
      },
    }));

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

    const out = composeLayout(snapshot, null, makeInput());
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("AB");
    expect(run?.width).toBe(200);
  });

  it("falls back to the deterministic 7px/char width when no measuredRuns entry exists and pretext fails", () => {
    // Prior/baseline behavior: when neither `prepared.widthPx` nor pretext
    // measurement is available, composeLayout must still produce stable
    // widths via the deterministic fallback rather than throwing or NaN-ing.
    mock.module("@chenglou/pretext", () => ({
      prepareWithSegments: () => {
        throw new Error("pretext unavailable");
      },
      layoutNextLine: () => null,
    }));

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

    const out = composeLayout(snapshot, null, makeInput());
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("XY");
    expect(run?.width).toBe(14);
  });
});
