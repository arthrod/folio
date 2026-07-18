import { describe, expect, it } from "bun:test";

import type { LayoutOutput } from "@stll/premirror-core";
import { schema as basicSchema } from "prosemirror-schema-basic";

import { buildFragmentDecorations } from "./index";

// Doc: <p>hello world</p> at pos 0, text starts at 1, node size 13.
const doc = basicSchema.node("doc", null, [
  basicSchema.node("paragraph", null, [basicSchema.text("hello world")]),
]);

function singleParagraphLayout(): LayoutOutput {
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
                pmRange: { from: 0, to: 13 },
                lines: [
                  {
                    y: 0,
                    height: 20,
                    pmRange: { from: 1, to: 12 },
                    runs: [
                      {
                        runId: "r0",
                        text: "hello world",
                        font: "16px serif",
                        marks: {},
                        x: 0,
                        width: 88,
                        pmRange: { from: 1, to: 12 },
                      },
                    ],
                  },
                ],
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

describe("buildFragmentDecorations", () => {
  it("emits an absolutely-positioned node decoration per paragraph box and inline run decorations", () => {
    const layout = singleParagraphLayout();
    const set = buildFragmentDecorations(doc, layout, "single");

    const found = set.find();
    expect(found.length).toBe(2);

    const nodeDeco = found.find((d) => d.from === 0 && d.to === 13);
    expect(nodeDeco).toBeDefined();
    const nodeSpec = (nodeDeco as unknown as { type: { attrs: Record<string, string> } }).type
      .attrs;
    expect(nodeSpec["class"]).toBe("premirror-fragment-paragraph");
    expect(nodeSpec["style"]).toContain("position:absolute");
    // Page placement (0,0) + frame bounds (96,96) + line y 0.
    expect(nodeSpec["style"]).toContain("left:96px");
    expect(nodeSpec["style"]).toContain("top:96px");

    const runDeco = found.find((d) => d.from === 1 && d.to === 12);
    expect(runDeco).toBeDefined();
    const runSpec = (runDeco as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    expect(runSpec["class"]).toBe("premirror-fragment-run");
    // Run offsets are RELATIVE to the paragraph box.
    expect(runSpec["style"]).toContain("left:0px");
    expect(runSpec["style"]).toContain("top:0px");
    expect(runSpec["style"]).toContain("line-height:20px");
  });

  it("spread mode offsets the second page horizontally", () => {
    const layout = singleParagraphLayout();
    // Duplicate the page so page index 1 exists (content still maps to the
    // same doc paragraph — good enough to observe placement math).
    layout.pages.push({ ...layout.pages[0]!, index: 1 });
    const set = buildFragmentDecorations(doc, layout, "spread");
    const found = set.find();
    // Node decorations merge into one box spanning both placements; the box
    // must extend PAST the first page's width (right edge on page 2).
    const nodeDeco = found.find((d) => d.from === 0 && d.to === 13)!;
    const style = (nodeDeco as unknown as { type: { attrs: Record<string, string> } }).type.attrs[
      "style"
    ]!;
    const width = Number(/width:(\d+(?:\.\d+)?)px/.exec(style)?.[1]);
    expect(width).toBeGreaterThan(816);
  });

  // The following cases exercise behavior that already existed when this
  // function lived inline in examples/premirror-demo/src/App.tsx, before
  // being lifted into this package — asserted here so the lift didn't
  // silently change semantics.

  it('falls back to resolving the paragraph from the line position when the fragment blockId does not match "block-<pos>"', () => {
    const layout = singleParagraphLayout();
    // An id shape the demo's `block-<pos>` convention never produces, so
    // `paragraphRangeFromBlockId` returns null and the function must fall
    // back to `paragraphRangeAtPos(doc, line.pmRange.from)`.
    layout.pages[0]!.frames[0]!.fragments[0]!.blockId = "not-a-block-id";

    const set = buildFragmentDecorations(doc, layout, "single");
    const found = set.find();
    expect(found.length).toBe(2);

    const nodeDeco = found.find((d) => d.from === 0 && d.to === 13);
    expect(nodeDeco).toBeDefined();
    const nodeSpec = (nodeDeco as unknown as { type: { attrs: Record<string, string> } }).type
      .attrs;
    expect(nodeSpec["style"]).toContain("left:96px");
    expect(nodeSpec["style"]).toContain("top:96px");
  });

  it("skips degenerate runs whose pmRange has no width", () => {
    const layout = singleParagraphLayout();
    const firstLine = layout.pages[0]!.frames[0]!.fragments[0]!.lines[0]!;
    // A zero-width run (e.g. an empty formatting boundary marker) alongside
    // the real run.
    firstLine.runs.push({
      runId: "r1",
      text: "",
      font: "16px serif",
      marks: {},
      x: 88,
      width: 0,
      pmRange: { from: 7, to: 7 },
    });

    const set = buildFragmentDecorations(doc, layout, "single");
    const found = set.find();
    // Still just the paragraph node decoration + the one real run — the
    // degenerate run produces no inline decoration.
    expect(found.length).toBe(2);
    expect(found.some((d) => d.from === 7 && d.to === 7)).toBe(false);
  });

  it("merges multiple lines of the same paragraph into a single paragraph box", () => {
    const layout = singleParagraphLayout();
    const fragment = layout.pages[0]!.frames[0]!.fragments[0]!;
    fragment.lines = [
      {
        y: 0,
        height: 20,
        pmRange: { from: 1, to: 6 },
        runs: [
          {
            runId: "r0",
            text: "hello",
            font: "16px serif",
            marks: {},
            x: 0,
            width: 40,
            pmRange: { from: 1, to: 6 },
          },
        ],
      },
      {
        y: 20,
        height: 20,
        pmRange: { from: 6, to: 12 },
        runs: [
          {
            runId: "r1",
            text: "world",
            font: "16px serif",
            marks: {},
            x: 0,
            width: 40,
            pmRange: { from: 6, to: 12 },
          },
        ],
      },
    ];

    const set = buildFragmentDecorations(doc, layout, "single");
    const found = set.find();
    // One merged paragraph box + one inline decoration per line's run.
    expect(found.length).toBe(3);

    const nodeDeco = found.find((d) => d.from === 0 && d.to === 13)!;
    const style = (nodeDeco as unknown as { type: { attrs: Record<string, string> } }).type.attrs[
      "style"
    ]!;
    // Box spans both lines: top of line 1 (96) to bottom of line 2 (96+20+20).
    expect(style).toContain("top:96px");
    expect(style).toContain("height:40px");

    // Second run's top offset (relative to the paragraph box) reflects its
    // own line's position, not the first line's.
    const secondRunDeco = found.find((d) => d.from === 6 && d.to === 12)!;
    const runStyle = (secondRunDeco as unknown as { type: { attrs: Record<string, string> } }).type
      .attrs["style"]!;
    expect(runStyle).toContain("top:20px");
  });
});
