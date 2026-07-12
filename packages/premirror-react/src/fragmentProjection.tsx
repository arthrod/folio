/**
 * Fragment projection: materialize a composed LayoutOutput onto a single
 * visible contenteditable by absolutely positioning ProseMirror-rendered
 * paragraphs (node decorations) and their line pieces (inline decorations)
 * into page coordinates. Lifted from the demo app so hosts (and the eigen
 * single-contenteditable spike) can consume it as library API.
 *
 * Local addition on top of upstream premirror (see UPSTREAM.md): upstream
 * keeps this in `apps/demo/src/App.tsx`; PR it back upstream when stable.
 */

import type { LayoutOutput } from "@premirror/core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";

import { getPageLayoutGeometry, type PageLayoutMode } from "./geometry";

type ParagraphBox = {
  from: number;
  to: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function styleForRunPosition(left: number, top: number, lineHeight: number): string {
  return [
    "position:absolute",
    `left:${left}px`,
    `top:${top}px`,
    `height:${lineHeight}px`,
    `line-height:${lineHeight}px`,
    "white-space:pre",
  ].join(";");
}

function clampPos(doc: ProseMirrorNode, pos: number): number {
  // Positions BEFORE a node start at 0 (block-0 is the first top-level
  // paragraph); clamping the low bound to 1 made the first block miss the
  // blockId fast path (review finding).
  const max = Math.max(0, doc.content.size);
  return Math.max(0, Math.min(pos, max));
}

function paragraphRangeFromBlockId(
  doc: ProseMirrorNode,
  blockId: string,
): { from: number; to: number } | null {
  const m = /^block-(\d+)$/.exec(blockId);
  if (!m) return null;
  const pos = clampPos(doc, Number.parseInt(m[1]!, 10));
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== "paragraph") return null;
  return { from: pos, to: pos + node.nodeSize };
}

function paragraphRangeAtPos(
  doc: ProseMirrorNode,
  pos: number,
): { from: number; to: number } | null {
  const clamped = clampPos(doc, pos);
  const resolved = doc.resolve(clamped);
  for (let d = resolved.depth; d >= 0; d--) {
    const node = resolved.node(d);
    if (node.type.name !== "paragraph") continue;
    const from = resolved.before(d);
    const to = from + node.nodeSize;
    return { from, to };
  }
  return null;
}

/**
 * Build the decoration set that projects `layout` onto the editable doc.
 * Paragraph node decorations carry the absolute page-space box; run inline
 * decorations position each line piece RELATIVE to its paragraph box.
 */
export function buildFragmentDecorations(
  doc: ProseMirrorNode,
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode,
): DecorationSet {
  const decorations: Decoration[] = [];
  const paragraphBoxes = new Map<string, ParagraphBox>();
  const runPlacements: Array<{
    runFrom: number;
    runTo: number;
    paragraphKey: string;
    left: number;
    top: number;
    width: number;
    lineHeight: number;
  }> = [];

  const upsertParagraphLine = (
    key: string,
    paragraph: { from: number; to: number },
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void => {
    const prev = paragraphBoxes.get(key);
    if (!prev) {
      paragraphBoxes.set(key, {
        from: paragraph.from,
        to: paragraph.to,
        left,
        top,
        right,
        bottom,
      });
      return;
    }
    prev.left = Math.min(prev.left, left);
    prev.top = Math.min(prev.top, top);
    prev.right = Math.max(prev.right, right);
    prev.bottom = Math.max(prev.bottom, bottom);
  };

  const geometry = getPageLayoutGeometry(layout, pageLayoutMode);
  layout.pages.forEach((page, pageIdx) => {
    const pagePlacement = geometry.pagePlacements[pageIdx] ?? { left: 0, top: 0 };
    for (const frame of page.frames) {
      for (const fragment of frame.fragments) {
        const fragmentParagraph = paragraphRangeFromBlockId(doc, fragment.blockId);
        for (const line of fragment.lines) {
          const lineTop = pagePlacement.top + frame.bounds.y + line.y;
          const lineBottom = lineTop + line.height;
          const paragraph =
            fragmentParagraph ??
            paragraphRangeAtPos(doc, line.pmRange.from) ??
            paragraphRangeAtPos(
              doc,
              line.pmRange.from > 1 ? line.pmRange.from - 1 : line.pmRange.from,
            );
          if (paragraph) {
            // Paragraph box should represent full editable context width, not
            // just measured text bounds, so clicks in trailing whitespace map
            // to expected caret positions.
            const lineLeft = pagePlacement.left + frame.bounds.x;
            const lineRight = pagePlacement.left + frame.bounds.x + frame.bounds.width;
            const paragraphKey = `${paragraph.from}:${paragraph.to}`;
            upsertParagraphLine(paragraphKey, paragraph, lineLeft, lineTop, lineRight, lineBottom);
          }

          for (const run of line.runs) {
            if (run.pmRange.from >= run.pmRange.to) continue;
            // Runs always belong to their line's paragraph; resolving a run
            // independently could disagree with the line's box key and
            // silently drop the decoration (review finding).
            if (!paragraph) continue;
            runPlacements.push({
              runFrom: run.pmRange.from,
              runTo: run.pmRange.to,
              paragraphKey: `${paragraph.from}:${paragraph.to}`,
              left: pagePlacement.left + frame.bounds.x + run.x,
              top: lineTop,
              width: run.width,
              lineHeight: line.height,
            });
          }
        }
      }
    }
  });

  for (const box of paragraphBoxes.values()) {
    decorations.push(
      Decoration.node(box.from, box.to, {
        class: "premirror-fragment-paragraph",
        style: [
          "position:absolute",
          `left:${box.left}px`,
          `top:${box.top}px`,
          `width:${Math.max(1, box.right - box.left)}px`,
          `height:${Math.max(1, box.bottom - box.top)}px`,
          "margin:0",
          "overflow:visible",
        ].join(";"),
      }),
    );
  }

  for (const run of runPlacements) {
    const paragraphBox = paragraphBoxes.get(run.paragraphKey);
    if (!paragraphBox) continue;
    decorations.push(
      Decoration.inline(
        run.runFrom,
        run.runTo,
        {
          class: "premirror-fragment-run",
          style: styleForRunPosition(
            run.left - paragraphBox.left,
            run.top - paragraphBox.top,
            run.lineHeight,
          ),
        },
        {
          inclusiveStart: false,
          inclusiveEnd: false,
        },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}
