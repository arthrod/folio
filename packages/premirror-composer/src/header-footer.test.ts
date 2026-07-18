import { afterEach, describe, expect, it, mock } from "bun:test";

import type {
  LayoutInput,
  MeasuredDocumentSnapshot,
  MeasuredRun,
  PremirrorOptions,
} from "@stll/premirror-core";
import { createLayoutInputFromOptions, defaultPremirrorOptions } from "@stll/premirror-core";

import { composeLayout } from "./index";

/**
 * Header/footer page furniture, composed through the SAME pretext-measured
 * line-breaking pipeline as the body. Under `bun test`, `@chenglou/pretext`
 * resolves to the deterministic stub, so widths come from `measuredRuns`.
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

const FONT = "normal 400 16px Inter";

/** Single-paragraph snapshot with one run; ~10px/char via measuredRuns. */
function singleBlockSnapshot(text: string, widthPx?: number): MeasuredDocumentSnapshot {
  const runId = "r0";
  return {
    blocks: [
      {
        id: "b0",
        type: "paragraph",
        attrs: {},
        pmRange: { from: 1, to: text.length + 2 },
        runs: [
          { id: runId, text, font: FONT, marks: {}, pmRange: { from: 1, to: text.length + 1 } },
        ],
      },
    ],
    measuredRuns: {
      [runId]: {
        runId,
        prepared: {},
        widthPx: widthPx ?? Math.max(20, text.length * 10),
        textLength: text.length,
      },
    },
  };
}

/** Multi-run single-paragraph snapshot; runs may carry a `field` marker. */
function multiRunSnapshot(
  runs: Array<{ id: string; text: string; field?: "page" | "numPages" }>,
): MeasuredDocumentSnapshot {
  let pm = 1;
  const styled = runs.map((r) => {
    const from = pm;
    const to = pm + r.text.length;
    pm = to;
    return {
      id: r.id,
      text: r.text,
      font: FONT,
      marks: {},
      pmRange: { from, to },
      ...(r.field ? { field: r.field } : {}),
    };
  });
  const measuredRuns: Record<string, MeasuredRun> = {};
  for (const s of styled) {
    measuredRuns[s.id] = {
      runId: s.id,
      prepared: {},
      widthPx: Math.max(10, s.text.length * 10),
      textLength: s.text.length,
    };
  }
  return {
    blocks: [
      { id: "fb", type: "paragraph", attrs: {}, pmRange: { from: 1, to: pm + 1 }, runs: styled },
    ],
    measuredRuns,
  };
}

function furnitureText(
  frame: { fragments: { lines: { runs: { text: string }[] }[] }[] } | undefined,
): string {
  return (frame?.fragments ?? [])
    .flatMap((f) => f.lines)
    .flatMap((l) => l.runs)
    .map((r) => r.text)
    .join("");
}

function makeInput(overrides?: Partial<PremirrorOptions>): LayoutInput {
  return createLayoutInputFromOptions(
    defaultPremirrorOptions({
      margins: { topPx: 96, rightPx: 0, bottomPx: 0, leftPx: 0 },
      ...overrides,
    }),
  );
}

/** N single-run blocks (one per line, given the small per-line widthPx). */
function multiBlockSnapshot(lines: string[], widthPx = 40): MeasuredDocumentSnapshot {
  const blocks: MeasuredDocumentSnapshot["blocks"] = [];
  const measuredRuns: MeasuredDocumentSnapshot["measuredRuns"] = {};
  lines.forEach((text, i) => {
    const runId = `r${i}`;
    const from = i * 10 + 1;
    blocks.push({
      id: `b${i}`,
      type: "paragraph",
      attrs: {},
      pmRange: { from, to: from + text.length + 1 },
      runs: [{ id: runId, text, font: FONT, marks: {}, pmRange: { from, to: from + text.length } }],
    });
    measuredRuns[runId] = { runId, prepared: {}, widthPx, textLength: text.length };
  });
  return { blocks, measuredRuns };
}

/** Single-run block with NO measuredRuns entry, forcing the pretext/fallback width paths. */
function unmeasuredBlockSnapshot(text: string): MeasuredDocumentSnapshot {
  return {
    blocks: [
      {
        id: "u0",
        type: "paragraph",
        attrs: {},
        pmRange: { from: 1, to: text.length + 2 },
        runs: [
          { id: "ur0", text, font: FONT, marks: {}, pmRange: { from: 1, to: text.length + 1 } },
        ],
      },
    ],
    measuredRuns: {},
  };
}

describe("composer header band", () => {
  it("lays header content into the top-margin band on every page", () => {
    // Body long enough to paginate to 2 pages (content height 104 => 5 lines/page).
    const body = singleBlockSnapshot("word ".repeat(60).trim(), 3000);
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      header: { snapshot: singleBlockSnapshot("My header", 90), distancePx: 24 },
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBeGreaterThan(1);

    for (const page of out.pages) {
      const header = page.header;
      expect(header, `page ${page.index}: header frame`).toBeDefined();
      if (!header) continue;
      // Band sits in the top margin: left-aligned, at distancePx, content width.
      expect(header.bounds.x).toBe(0);
      expect(header.bounds.y).toBe(24);
      expect(header.bounds.width).toBe(400);
      const line0 = header.fragments[0]?.lines[0];
      expect(line0, `page ${page.index}: header first line`).toBeDefined();
      expect(line0?.y).toBe(0); // frame-relative, like the body
      expect(line0?.runs.map((r) => r.text).join("")).toContain("My header");
    }
  });
});

describe("composer footer band", () => {
  it("lays footer content into the bottom-margin band on every page", () => {
    const body = singleBlockSnapshot("word ".repeat(60).trim(), 3000);
    const input: LayoutInput = {
      ...makeInput({
        page: { widthPx: 400, heightPx: 200, preset: "letter" },
      }),
      footer: { snapshot: singleBlockSnapshot("Page footer", 110), distancePx: 24 },
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBeGreaterThan(1);

    for (const page of out.pages) {
      const footer = page.footer;
      expect(footer, `page ${page.index}: footer frame`).toBeDefined();
      if (!footer) continue;
      // Band is bottom-anchored: distancePx measured from the page bottom edge
      // to the band's bottom => top = height - distance - bandHeight.
      expect(footer.bounds.x).toBe(0);
      expect(footer.bounds.width).toBe(400);
      expect(footer.bounds.y).toBe(200 - 24 - footer.bounds.height);
      const line0 = footer.fragments[0]?.lines[0];
      expect(line0, `page ${page.index}: footer first line`).toBeDefined();
      expect(line0?.y).toBe(0); // frame-relative
      expect(line0?.runs.map((r) => r.text).join("")).toContain("Page footer");
    }
  });

  it("grows the footer band upward as its content height increases (bottom anchor)", () => {
    // Single-page body; only the footer band height varies between the two
    // inputs below, isolating the bottom-anchor math from pagination.
    const body = singleBlockSnapshot("short body", 60);
    const page = { widthPx: 400, heightPx: 200, preset: "letter" as const };

    const oneLineInput: LayoutInput = {
      ...makeInput({ page }),
      footer: { snapshot: multiBlockSnapshot(["L1"]), distancePx: 24 },
    };
    const threeLineInput: LayoutInput = {
      ...makeInput({ page }),
      footer: { snapshot: multiBlockSnapshot(["L1", "L2", "L3"]), distancePx: 24 },
    };

    const oneLineFooter = composeLayout(body, null, oneLineInput).pages[0]?.footer;
    const threeLineFooter = composeLayout(body, null, threeLineInput).pages[0]?.footer;
    expect(oneLineFooter).toBeDefined();
    expect(threeLineFooter).toBeDefined();
    if (!oneLineFooter || !threeLineFooter) return;

    expect(oneLineFooter.bounds.height).toBe(20);
    expect(threeLineFooter.bounds.height).toBe(60);
    // Bottom-anchored: top = pageHeight - distance - bandHeight.
    expect(oneLineFooter.bounds.y).toBe(200 - 24 - 20);
    expect(threeLineFooter.bounds.y).toBe(200 - 24 - 60);
    // Taller footer content pushes the band's top edge further up the page.
    expect(threeLineFooter.bounds.y).toBeLessThan(oneLineFooter.bounds.y);
  });
});

describe("composer furniture width sources (transport-layer pretext mocking)", () => {
  it("composes footer content via the real pretext-measured width path (changed code)", () => {
    // No measuredRuns entry for the footer run, so runWidthPx must fall
    // through to widthByPretext. Mocking the @chenglou/pretext module
    // boundary (not composeFurniture/runWidthPx internals) exercises the
    // upstream-success branch for the newly bottom-anchored footer band.
    mock.module("@chenglou/pretext", () => ({
      prepareWithSegments: (text: string) => ({ text }),
      layoutNextLine: (prepared: unknown) => {
        const { text } = prepared as { text: string };
        return {
          text,
          width: text.length * 50,
          end: { segmentIndex: 0, graphemeIndex: text.length },
        };
      },
    }));

    const body = singleBlockSnapshot("short body", 60);
    const footerText = "Foot";
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 1000, heightPx: 200, preset: "letter" } }),
      footer: { snapshot: unmeasuredBlockSnapshot(footerText), distancePx: 24 },
    };

    const out = composeLayout(body, null, input);
    const footer = out.pages[0]?.footer;
    expect(footer).toBeDefined();
    if (!footer) return;
    expect(footer.bounds.height).toBe(20); // one line, no wrap
    expect(footer.bounds.y).toBe(200 - 24 - 20);
    const run = footer.fragments[0]?.lines[0]?.runs[0];
    expect(run?.width).toBe(footerText.length * 50);
  });

  it("falls back to the deterministic header width when pretext is unavailable (prior)", () => {
    // The header (top anchor) predates this PR; this pins that its
    // pre-existing pretext-failure fallback still behaves identically after
    // composeFurniture was generalized to take an `anchor` parameter.
    mock.module("@chenglou/pretext", () => ({
      prepareWithSegments: () => {
        throw new Error("pretext unavailable");
      },
      layoutNextLine: () => null,
    }));

    const body = singleBlockSnapshot("short body", 60);
    const headerText = "XY";
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      header: { snapshot: unmeasuredBlockSnapshot(headerText), distancePx: 24 },
    };

    const out = composeLayout(body, null, input);
    const header = out.pages[0]?.header;
    expect(header).toBeDefined();
    if (!header) return;
    const run = header.fragments[0]?.lines[0]?.runs[0];
    expect(run?.text).toBe("XY");
    expect(run?.width).toBe(14); // deterministic 7px/char fallback
    expect(header.bounds.y).toBe(24); // top anchor: unchanged prior behavior
  });
});

describe("composer without header/footer furniture (prior behavior)", () => {
  it("leaves page.header and page.footer undefined when neither is configured", () => {
    // Baseline behavior predating both the header (#148) and footer (this
    // PR) furniture features: composeLayout must not populate `header`/
    // `footer` on PageLayout when the corresponding LayoutInput field is
    // absent, so existing callers that never set them see no change.
    const body = singleBlockSnapshot("plain body text with no furniture configured", 3000);
    const input = makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } });

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBeGreaterThan(0);
    for (const page of out.pages) {
      expect(page.header).toBeUndefined();
      expect(page.footer).toBeUndefined();
    }
  });
});

describe("composer page-number fields", () => {
  it("substitutes PAGE and NUMPAGES per page in footer furniture", () => {
    const body = singleBlockSnapshot("word ".repeat(60).trim(), 3000);
    const footer = multiRunSnapshot([
      { id: "f0", text: "Page " },
      { id: "f1", text: "#", field: "page" },
      { id: "f2", text: " / " },
      { id: "f3", text: "#", field: "numPages" },
    ]);
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      footer: { snapshot: footer, distancePx: 24 },
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBeGreaterThan(1);
    const total = out.pages.length;

    // PAGE -> 1-based page number; NUMPAGES -> total; substituted per page.
    expect(furnitureText(out.pages[0]?.footer)).toBe(`Page 1 / ${total}`);
    expect(furnitureText(out.pages[1]?.footer)).toBe(`Page 2 / ${total}`);
  });
});

describe("composer different-first-page", () => {
  it("uses the first-page header on page 0 and the default header elsewhere", () => {
    const body = singleBlockSnapshot("word ".repeat(60).trim(), 3000);
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      header: { snapshot: singleBlockSnapshot("Default header", 130), distancePx: 24 },
      firstHeader: { snapshot: singleBlockSnapshot("First header", 110), distancePx: 24 },
      titlePg: true,
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBeGreaterThan(1);
    expect(furnitureText(out.pages[0]?.header)).toContain("First header");
    expect(furnitureText(out.pages[1]?.header)).toContain("Default header");
  });

  it("leaves the first-page band blank when titlePg is set without a first variant", () => {
    const body = singleBlockSnapshot("word ".repeat(60).trim(), 3000);
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      header: { snapshot: singleBlockSnapshot("Default header", 130), distancePx: 24 },
      titlePg: true,
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBeGreaterThan(1);
    expect(out.pages[0]?.header).toBeUndefined();
    expect(furnitureText(out.pages[1]?.header)).toContain("Default header");
  });
});

describe("composer footnote reserved area", () => {
  it("reserves a bottom band that shrinks the body and exposes footnoteArea", () => {
    const body = singleBlockSnapshot("word ".repeat(30).trim(), 1490);
    const base = makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } });

    const without = composeLayout(body, null, base);
    const withReserve = composeLayout(body, null, { ...base, footnoteReservedPx: 60 });

    // Reserving space shrinks the usable body height => more pages.
    expect(withReserve.pages.length).toBeGreaterThan(without.pages.length);
    for (const page of without.pages) expect(page.footnoteArea).toBeUndefined();

    for (const page of withReserve.pages) {
      const area = page.footnoteArea;
      expect(area, `page ${page.index}: footnoteArea`).toBeDefined();
      if (!area) continue;
      expect(area.x).toBe(0); // left margin
      expect(area.width).toBe(400); // content width
      expect(area.height).toBe(60);
      // Directly below the shrunk content: y = topMargin + (contentHeight - reserve).
      expect(area.y).toBe(96 + (104 - 60));
    }
  });
});

describe("composer footnote composition", () => {
  it("places each note on the page its reference lands on", () => {
    // Two blocks forced onto separate pages via a manual page break.
    const body: MeasuredDocumentSnapshot = {
      blocks: [
        {
          id: "b0",
          type: "paragraph",
          attrs: {},
          pmRange: { from: 1, to: 7 },
          runs: [{ id: "r0", text: "Alpha", font: FONT, marks: {}, pmRange: { from: 1, to: 6 } }],
        },
        {
          id: "b1",
          type: "paragraph",
          attrs: { manualPageBreakBefore: true },
          pmRange: { from: 8, to: 14 },
          runs: [{ id: "r1", text: "Bravo", font: FONT, marks: {}, pmRange: { from: 8, to: 13 } }],
        },
      ],
      measuredRuns: {
        r0: { runId: "r0", prepared: {}, widthPx: 50, textLength: 5 },
        r1: { runId: "r1", prepared: {}, widthPx: 50, textLength: 5 },
      },
    };
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      footnoteReservedPx: 40,
      footnotes: [
        { id: "fn1", refPmPos: 3, snapshot: singleBlockSnapshot("First note", 100) },
        { id: "fn2", refPmPos: 10, snapshot: singleBlockSnapshot("Second note", 110) },
      ],
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBe(2);

    // fn1 ref (pm 3, block b0) -> page 0; fn2 ref (pm 10, block b1) -> page 1.
    expect(furnitureText(out.pages[0]?.footnotes)).toContain("First note");
    expect(furnitureText(out.pages[1]?.footnotes)).toContain("Second note");
    // Notes are composed at the top of the reserved band.
    expect(out.pages[0]?.footnotes?.bounds.y).toBe(out.pages[0]?.footnoteArea?.y);
  });
});

/** N single-line paragraphs, one run each; 20px tall lines, well under width. */
function lineBlocks(count: number): MeasuredDocumentSnapshot {
  const blocks = [];
  const measuredRuns: Record<string, MeasuredRun> = {};
  for (let i = 0; i < count; i++) {
    const rid = `lr${i}`;
    const from = 1 + i * 10;
    blocks.push({
      id: `lb${i}`,
      type: "paragraph" as const,
      attrs: {},
      pmRange: { from: i * 10, to: from + 6 },
      runs: [{ id: rid, text: `Line${i}`, font: FONT, marks: {}, pmRange: { from, to: from + 5 } }],
    });
    measuredRuns[rid] = { runId: rid, prepared: {}, widthPx: 50, textLength: 5 };
  }
  return { blocks, measuredRuns };
}

/** A note that composes to exactly two 20px lines (two single-line blocks). */
function twoLineNote(): MeasuredDocumentSnapshot {
  return {
    blocks: [
      {
        id: "n0",
        type: "paragraph",
        attrs: {},
        pmRange: { from: 1, to: 7 },
        runs: [{ id: "nr0", text: "Note A", font: FONT, marks: {}, pmRange: { from: 1, to: 7 } }],
      },
      {
        id: "n1",
        type: "paragraph",
        attrs: {},
        pmRange: { from: 8, to: 14 },
        runs: [{ id: "nr1", text: "Note B", font: FONT, marks: {}, pmRange: { from: 8, to: 14 } }],
      },
    ],
    measuredRuns: {
      nr0: { runId: "nr0", prepared: {}, widthPx: 60, textLength: 6 },
      nr1: { runId: "nr1", prepared: {}, widthPx: 60, textLength: 6 },
    },
  };
}

describe("composer footnote convergence (per-page auto reserve)", () => {
  it("reserves space only on pages with notes and reflows the body to a fixed point", () => {
    // 8 single-line paragraphs. Content height 104 => 5 lines/page unreserved.
    const body = lineBlocks(8);
    const base = makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } });

    // Baseline: no notes => page 0 holds all 5 that fit.
    const baseline = composeLayout(body, null, base);
    expect(baseline.pages[0]?.frames[0]?.fragments.length).toBe(5);

    // The note's reference (pm 12) lands in block index 1 => page 0. Auto-reserve
    // sizes the band to the note (two lines => 40px), shrinking page 0's usable
    // height to 64px => 3 lines. The reference stays on page 0, so the layout is
    // stable at that reservation (no oscillation).
    const input: LayoutInput = {
      ...base,
      footnoteAutoReserve: true,
      footnotes: [{ id: "fn1", refPmPos: 12, snapshot: twoLineNote() }],
    };

    const out = composeLayout(body, null, input);
    expect(out.pages.length).toBe(2);

    // Reservation reflowed the body: page 0 dropped from 5 lines to 3.
    expect(out.pages[0]?.frames[0]?.fragments.length).toBe(3);
    expect(out.pages[1]?.frames[0]?.fragments.length).toBe(5);

    // The note sits in page 0's band; page 1 has no notes, so no reserved area.
    expect(furnitureText(out.pages[0]?.footnotes)).toContain("Note A");
    expect(furnitureText(out.pages[0]?.footnotes)).toContain("Note B");
    expect(out.pages[0]?.footnoteArea?.height).toBe(40);
    expect(out.pages[0]?.footnoteArea?.y).toBe(96 + (104 - 40));
    expect(out.pages[1]?.footnoteArea).toBeUndefined();
  });
});

describe("composer endnotes", () => {
  it("collects endnotes onto a trailing page after the body, in order", () => {
    // Three single-line paragraphs fit on one page (content height 104 => 5/pg).
    const body = lineBlocks(3);
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      endnotes: [
        { id: "en1", snapshot: singleBlockSnapshot("Endnote one", 110) },
        { id: "en2", snapshot: singleBlockSnapshot("Endnote two", 110) },
      ],
    };

    const out = composeLayout(body, null, input);

    // Body is one page; endnotes collect onto a second, trailing page.
    expect(out.pages.length).toBe(2);
    expect(out.pages[0]?.endnotes).toBeUndefined();
    expect(out.pages[1]?.index).toBe(1);
    // The endnotes page carries no body content.
    expect(out.pages[1]?.frames.length).toBe(0);
    // Notes are stacked in order from the top of the content frame.
    expect(furnitureText(out.pages[1]?.endnotes)).toBe("Endnote oneEndnote two");
    expect(out.pages[1]?.endnotes?.bounds.y).toBe(96);
  });

  it("overflows a long endnote run across multiple trailing pages", () => {
    const body = lineBlocks(2); // one body page
    // Eight one-line endnotes; content height 104 => 5 lines/page => 5 + 3.
    const endnotes = Array.from({ length: 8 }, (_, i) => ({
      id: `en${i}`,
      snapshot: singleBlockSnapshot(`E${i}`, 40),
    }));
    const input: LayoutInput = {
      ...makeInput({ page: { widthPx: 400, heightPx: 200, preset: "letter" } }),
      endnotes,
    };

    const out = composeLayout(body, null, input);

    // One body page + two endnote pages.
    expect(out.pages.length).toBe(3);
    expect(out.pages[0]?.endnotes).toBeUndefined();
    expect(out.pages[0]?.frames.length).toBe(1);

    // Both endnote pages are body-less and continue the page indices.
    expect(out.pages[1]?.index).toBe(1);
    expect(out.pages[2]?.index).toBe(2);
    expect(out.pages[1]?.frames.length).toBe(0);
    expect(out.pages[2]?.frames.length).toBe(0);

    // Notes split 5 + 3 and, concatenated, preserve document order.
    const p1 = out.pages[1]?.endnotes;
    const p2 = out.pages[2]?.endnotes;
    expect(p1?.fragments.flatMap((f) => f.lines).length).toBe(5);
    expect(p2?.fragments.flatMap((f) => f.lines).length).toBe(3);
    expect(furnitureText(p1) + furnitureText(p2)).toBe("E0E1E2E3E4E5E6E7");

    // Each overflow page re-bases to the top of the content frame.
    expect(p1?.bounds.y).toBe(96);
    expect(p2?.bounds.y).toBe(96);
    expect(p2?.fragments[0]?.lines[0]?.y).toBe(0);
  });
});
