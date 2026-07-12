import { describe, expect, it } from "bun:test";
import React from "react";

import type { LayoutOutput } from "@premirror/core";

import { PremirrorPageViewport } from "./index";

describe("@premirror/react", () => {
  it("creates a page viewport element", () => {
    const layout: LayoutOutput = {
      pages: [
        {
          index: 0,
          spec: { widthPx: 800, heightPx: 1000, preset: "letter" },
          frames: [{ bounds: { x: 80, y: 80, width: 640, height: 840 }, fragments: [] }],
        },
      ],
      mapping: {
        pmPosToLayout: () => null,
        layoutToPmPos: () => null,
      },
      metrics: {
        extractionMs: 0,
        measurementMs: 0,
        composeMs: 1,
        pages: 1,
        blocks: 0,
      },
    };

    const element = PremirrorPageViewport({
      layout,
      showDebug: true,
      editorLayer: <div />,
    });

    expect(React.isValidElement(element)).toBe(true);
  });
});

import { getPageLayoutGeometry, projectSelectionRects } from "./index";
import type { LayoutOutput as LO } from "@premirror/core";

function twoLineLayout(): LO {
  // One page, one frame at (96,96), two contiguous 20px lines:
  // line A pm[1,11) runs x0 w100, line B pm[11,21) runs x0 w80.
  const mk = (y: number, from: number, to: number, width: number) => ({
    y,
    height: 20,
    pmRange: { from, to },
    runs: [
      {
        runId: `r${from}`,
        text: "x".repeat(to - from),
        font: "16px serif",
        marks: {},
        x: 0,
        width,
        pmRange: { from, to },
      },
    ],
  });
  return {
    pages: [
      {
        index: 0,
        spec: { widthPx: 816, heightPx: 1056, preset: "letter" },
        frames: [
          {
            bounds: { x: 96, y: 96, width: 624, height: 864 },
            fragments: [
              {
                blockId: "block-0",
                fragmentIndex: 0,
                pmRange: { from: 0, to: 22 },
                lines: [mk(0, 1, 11, 100), mk(20, 11, 21, 80)],
              },
            ],
          },
        ],
      },
    ],
    mapping: { pmPosToLayout: () => null, layoutToPmPos: () => null },
    metrics: { extractionMs: 0, measurementMs: 0, composeMs: 0, pages: 1, blocks: 1 },
  };
}

describe("getPageLayoutGeometry (PR #110 review)", () => {
  it("stacks single-mode pages vertically with the gap", () => {
    const layout = twoLineLayout();
    layout.pages.push({ ...layout.pages[0]!, index: 1 });
    const g = getPageLayoutGeometry(layout, "single");
    expect(g.pagePlacements.length).toBe(2);
    expect(g.pagePlacements[0]).toEqual({ left: 0, top: 0 });
    expect(g.pagePlacements[1]!.top).toBe(1056 + 24);
    expect(g.width).toBe(816);
  });

  it("places spread-mode pages side by side", () => {
    const layout = twoLineLayout();
    layout.pages.push({ ...layout.pages[0]!, index: 1 });
    const g = getPageLayoutGeometry(layout, "spread");
    expect(g.pagePlacements[1]!.left).toBe(816 + 24);
    expect(g.pagePlacements[1]!.top).toBe(0);
  });
});

describe("projectSelectionRects (PR #110/folio #1 review)", () => {
  it("positions a collapsed caret by interpolating within the line", () => {
    // pm 6 is halfway through line A's run (span 10, width 100) -> x = 50.
    const rects = projectSelectionRects(twoLineLayout(), 6, 6);
    expect(rects.length).toBe(1);
    expect(rects[0]!.x).toBeCloseTo(96 + 50, 4);
    expect(rects[0]!.width).toBe(2);
  });

  it("emits exactly ONE caret rect at a line boundary (earlier line wins)", () => {
    // pm 11 === lineA.pmTo === lineB.pmFrom.
    const rects = projectSelectionRects(twoLineLayout(), 11, 11);
    expect(rects.length).toBe(1);
    expect(rects[0]!.y).toBeCloseTo(96 + 0, 4); // line A's y, not line B's
    expect(rects[0]!.x).toBeCloseTo(96 + 100, 4); // end of line A's run
  });

  it("clips a range rect to the intersected sub-range, not the full line", () => {
    // Select pm [3,8) inside line A: x from 20 to 70.
    const rects = projectSelectionRects(twoLineLayout(), 3, 8);
    expect(rects.length).toBe(1);
    expect(rects[0]!.x).toBeCloseTo(96 + 20, 4);
    expect(rects[0]!.width).toBeCloseTo(50, 4);
  });

  it("spans multiple lines with per-line sub-range rects", () => {
    const rects = projectSelectionRects(twoLineLayout(), 6, 16);
    expect(rects.length).toBe(2);
    expect(rects[0]!.x).toBeCloseTo(96 + 50, 4);
    expect(rects[0]!.width).toBeCloseTo(50, 4); // to end of line A
    expect(rects[1]!.x).toBeCloseTo(96 + 0, 4);
    expect(rects[1]!.width).toBeCloseTo(40, 4); // pm 11..16 of line B (span 10, w 80)
  });
});
