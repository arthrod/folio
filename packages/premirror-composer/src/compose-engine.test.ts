import { describe, expect, it } from "bun:test";

import type {
  BandObstacle,
  BlockSnapshot,
  LayoutInput,
  MeasuredDocumentSnapshot,
  MeasuredRun,
  PremirrorOptions,
} from "@stll/premirror-core";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@stll/premirror-core";

import { composeLayout } from "./index";

/**
 * Engine-behavior coverage for the vendored composer: line wrapping, the
 * widow/orphan fit decision and its page-flush branches, keep-with-next,
 * the position<->layout mapping index, the prepared-width fast path, and
 * obstacle slot carving. No segment-fit engine is injected (E-4
 * unification), so widths come from `measuredRuns` and are exact.
 */

const FONT = "normal 400 16px Inter";

type BlockSpec = {
  text: string;
  /** Total measured width of the run; sub-strings scale proportionally. */
  widthPx?: number;
  attrs?: Record<string, unknown>;
  /** Override the run's prepared payload (e.g. to exercise prepared.widthPx). */
  prepared?: unknown;
};

/** Builds a single-run-per-block measured snapshot with sequential pm ranges. */
function makeSnapshot(specs: BlockSpec[]): MeasuredDocumentSnapshot {
  const blocks: BlockSnapshot[] = [];
  const measuredRuns: Record<string, MeasuredRun> = {};
  let pm = 1;
  specs.forEach((spec, i) => {
    const runId = `r${i}`;
    const from = pm;
    const to = from + spec.text.length;
    blocks.push({
      id: `b${i}`,
      type: "paragraph",
      attrs: spec.attrs ?? {},
      pmRange: { from, to: to + 1 },
      runs: [{ id: runId, text: spec.text, font: FONT, marks: {}, pmRange: { from, to } }],
    });
    measuredRuns[runId] = {
      runId,
      prepared: spec.prepared ?? {},
      widthPx: spec.widthPx ?? Math.max(20, spec.text.length * 10),
      textLength: spec.text.length,
    };
    pm = to + 2;
  });
  return { blocks, measuredRuns };
}

function makeInput(overrides?: Partial<PremirrorOptions>): LayoutInput {
  return createLayoutInputFromOptions(
    defaultPremirrorOptions({
      margins: { topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
      ...overrides,
    }),
  );
}

/** Page of the given content size with zero margins (frame === page). */
function pageInput(widthPx: number, heightPx: number, overrides?: Partial<PremirrorOptions>) {
  return makeInput({ page: { widthPx, heightPx, preset: "letter" }, ...overrides });
}

function allFragments(out: ReturnType<typeof composeLayout>) {
  return out.pages.flatMap((p) => p.frames.flatMap((f) => f.fragments));
}

describe("composer line wrapping", () => {
  it("wraps a wide paragraph onto multiple lines within one fragment", () => {
    // ~10px/char, 200px frame => ~20 chars/line; five words wrap to >1 line.
    const snapshot = makeSnapshot([{ text: "alpha bravo charlie delta echo foxtrot" }]);
    const out = composeLayout(snapshot, null, pageInput(200, 2000));
    const frag = out.pages[0]?.frames[0]?.fragments[0];
    expect(frag).toBeDefined();
    expect((frag?.lines.length ?? 0) > 1).toBe(true);
    // Wrapped lines never exceed the frame width.
    for (const line of frag?.lines ?? []) {
      let lineWidth = 0;
      for (const r of line.runs) lineWidth = Math.max(lineWidth, r.x + r.width);
      expect(lineWidth).toBeLessThanOrEqual(200 + 1e-6);
    }
  });
});

describe("composer widow/orphan fit decision", () => {
  it("characterizes the #113 override: places a single orphan line when only one fits (currentY===0)", () => {
    // frame height 30 => maxLines===1 at top. Paragraph wraps to >=3 lines,
    // orphanLinesMin===2. linesThatFitFirstFragment returns fit:0
    // (widow_orphan_protection), but the composer overrides it and splits one
    // line onto the page anyway. This documents upstream defect #113 — update
    // this expectation if/when the override is removed upstream.
    const snapshot = makeSnapshot([{ text: "alpha bravo charlie delta echo foxtrot golf hotel" }]);
    const out = composeLayout(snapshot, null, pageInput(200, 30));
    const firstFrag = out.pages[0]?.frames[0]?.fragments[0];
    expect(firstFrag?.lines.length).toBe(1);
    // One line per page => page count equals the total wrapped line count.
    const totalLines = allFragments(out).reduce((acc, f) => acc + f.lines.length, 0);
    expect(out.pages.length).toBe(totalLines);
  });

  it("force-fits one line at the top of a page when no full line height is available", () => {
    // frame height 10 < lineHeight 20 => maxLines===0 even at currentY===0,
    // exercising the `useFit = 1` fallback (one line per page).
    const snapshot = makeSnapshot([{ text: "one two three four five" }]);
    const out = composeLayout(snapshot, null, pageInput(200, 10));
    expect(out.pages.length).toBeGreaterThan(1);
    for (const frag of allFragments(out)) {
      expect(frag.lines.length).toBe(1);
    }
  });

  it("flushes to the next page when the current page has no room mid-document", () => {
    // frame height 50 => 2 lines/page. Three single-line blocks: block2 starts
    // at currentY===40 (maxLines===0, currentY>0) and must flush to page 2.
    const snapshot = makeSnapshot([
      { text: "aaa", widthPx: 30 },
      { text: "bbb", widthPx: 30 },
      { text: "ccc", widthPx: 30 },
    ]);
    const out = composeLayout(snapshot, null, pageInput(200, 50));
    expect(out.pages.length).toBe(2);
    // block2 (id b2) lands on the second page.
    const page2Ids = out.pages[1]?.frames[0]?.fragments.map((f) => f.blockId);
    expect(page2Ids).toContain("b2");
  });
});

describe("composer keep-with-next", () => {
  it("flushes before a keep-with-next block that cannot fit with its successor", () => {
    // frame height 60 => 3 lines/page. block0 (1 line) leaves currentY=20.
    // block1 keepWithNext (1 line) + block2 (2 lines) need 60 but only 40
    // remains => flush before block1, tagging block0's fragment.
    const snapshot = makeSnapshot([
      { text: "aaa", widthPx: 30 },
      { text: "bbb", widthPx: 30, attrs: { keepWithNext: true } },
      { text: "wide enough to wrap twice here", widthPx: 300 },
    ]);
    const out = composeLayout(snapshot, null, pageInput(200, 60));
    expect(out.pages.length).toBeGreaterThanOrEqual(2);
    const page0 = out.pages[0]?.frames[0]?.fragments ?? [];
    expect(page0.map((f) => f.blockId)).toEqual(["b0"]);
    expect(page0.at(-1)?.breakReason).toBe("keep_with_next");
    // block1 and block2 stay together on the next page.
    const page1Ids = out.pages[1]?.frames[0]?.fragments.map((f) => f.blockId) ?? [];
    expect(page1Ids).toContain("b1");
    expect(page1Ids).toContain("b2");
  });
});

describe("composer mapping index", () => {
  it("maps a boundary position to the earlier line and round-trips it", () => {
    const snapshot = makeSnapshot([{ text: "alpha bravo charlie delta echo" }]);
    const out = composeLayout(snapshot, null, pageInput(200, 2000));
    const line = out.pages[0]?.frames[0]?.fragments[0]?.lines[0];
    expect(line).toBeDefined();
    const boundary = line?.pmRange.to ?? 0;
    const point = out.mapping.pmPosToLayout(boundary);
    expect(point).not.toBeNull();
    if (!point) return;
    // A boundary (pos === pmTo) resolves onto the earlier line, not the next.
    expect(point.lineIndex).toBe(0);
    expect(out.mapping.layoutToPmPos(point)).toBe(boundary);
  });

  it("returns null for out-of-range positions and unknown layout points", () => {
    const out = composeLayout(makeSnapshot([{ text: "Mapping" }]), null, pageInput(400, 2000));
    expect(out.mapping.pmPosToLayout(100000)).toBeNull();
    expect(
      out.mapping.layoutToPmPos({
        pageIndex: 999,
        frameIndex: 0,
        fragmentIndex: 0,
        lineIndex: 0,
        offsetInLine: 0,
      }),
    ).toBeNull();
  });

  it("clamps an over-long offsetInLine back into the line", () => {
    const out = composeLayout(makeSnapshot([{ text: "Clamp" }]), null, pageInput(400, 2000));
    const point = out.mapping.pmPosToLayout(2);
    expect(point).not.toBeNull();
    if (!point) return;
    const clamped = out.mapping.layoutToPmPos({ ...point, offsetInLine: 9999 });
    expect(clamped).not.toBeNull();
    // Never maps beyond the line's own pm range.
    expect(clamped! <= (out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.pmRange.to ?? 0)).toBe(
      true,
    );
  });
});

describe("composer run width sources", () => {
  it("uses prepared.widthPx when the measured run covers the whole run", () => {
    // Short text that fits on one line and is never split, so run.text.length
    // matches measuredRun.textLength and the prepared.widthPx fast path wins.
    const snapshot = makeSnapshot([{ text: "Hi", widthPx: 20, prepared: { widthPx: 123 } }]);
    const out = composeLayout(snapshot, null, pageInput(400, 2000));
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run?.width).toBe(123);
  });
});

describe("composer empty document", () => {
  it("emits a single empty page when there are no blocks", () => {
    const out = composeLayout({ blocks: [], measuredRuns: {} }, null, pageInput(400, 2000));
    expect(out.pages.length).toBe(1);
    expect(out.pages[0]?.frames[0]?.fragments.length).toBe(0);
  });
});

describe("composer obstacle slot carving", () => {
  it("offsets placed runs into the usable slot beside a band obstacle", () => {
    const obstacle: BandObstacle = {
      id: "ob1",
      yStart: 0,
      yEnd: 10000,
      // Blocks the left 100px of every band; the usable slot is [100, 200].
      intervalsForBand: () => [{ start: 0, end: 100 }],
    };
    const base = pageInput(200, 2000);
    const input: LayoutInput = { ...base, obstacles: [obstacle] };
    const out = composeLayout(makeSnapshot([{ text: "shifted", widthPx: 40 }]), null, input);
    const run = out.pages[0]?.frames[0]?.fragments[0]?.lines[0]?.runs[0];
    expect(run).toBeDefined();
    expect(run!.x).toBeGreaterThanOrEqual(100);
  });
});
