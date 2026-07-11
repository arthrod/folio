/**
 * @stll/premirror-bridge fixtures — fixtures and harnesses connecting the eigen
 * DOCX editor to the vendored premirror layout engine.
 *
 * Phase 1: deterministic snapshot builders + golden layout fixtures.
 * Phase 2 adds the pretext measurement path for the eigen measuring pipeline.
 */

import type {
  BlockSnapshot,
  MeasuredDocumentSnapshot,
  MeasuredRun,
  StyledRun,
} from "@premirror/core";

export type FixtureBlockSpec = {
  /** Visible text of the block's single run. */
  text: string;
  /** Explicit measured width in px (deterministic; no pretext involved). */
  widthPx: number;
  type?: BlockSnapshot["type"];
  attrs?: Record<string, unknown>;
};

export type FixtureDoc = {
  snapshot: MeasuredDocumentSnapshot;
  /** pmRange of each block, index-aligned with the input specs. */
  blockRanges: Array<{ from: number; to: number }>;
};

/**
 * Build a MeasuredDocumentSnapshot from block specs with hand-set widths.
 * pmRanges are assigned sequentially the way a PM doc would lay them out:
 * block node at `pos`, text starting at `pos + 1`, node size = text + 2.
 */
export function buildFixtureDoc(specs: FixtureBlockSpec[]): FixtureDoc {
  const blocks: BlockSnapshot[] = [];
  const measuredRuns: Record<string, MeasuredRun> = {};
  const blockRanges: Array<{ from: number; to: number }> = [];

  let pos = 0;
  specs.forEach((spec, i) => {
    const from = pos;
    const to = from + spec.text.length + 2;
    const runId = `r${i}`;
    const run: StyledRun = {
      id: runId,
      text: spec.text,
      font: "normal 400 16px Inter",
      marks: {},
      pmRange: { from: from + 1, to: to - 1 },
    };
    blocks.push({
      id: `b${i}`,
      type: spec.type ?? "paragraph",
      attrs: spec.attrs ?? {},
      runs: [run],
      pmRange: { from, to },
    });
    measuredRuns[runId] = {
      runId,
      prepared: {},
      widthPx: spec.widthPx,
      textLength: spec.text.length,
    };
    blockRanges.push({ from, to });
    pos = to;
  });

  return { snapshot: { blocks, measuredRuns }, blockRanges };
}

/** A short single-line paragraph spec (fits any sane frame width). */
export function oneLinePara(label: string): FixtureBlockSpec {
  return { text: `Paragraph ${label}.`, widthPx: 100 };
}
