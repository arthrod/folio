/**
 * Page-stack geometry shared by the viewport, the selection projection,
 * and the fragment projection. Lives in its own module so fragmentProjection
 * does not import the package barrel (circular-import review finding).
 */
import type { LayoutOutput } from "@stll/premirror-core";

/** Gap between stacked/spread pages in px. */
export const PAGE_STACK_GAP_PX = 24;

export type PageLayoutMode = "single" | "spread";

export type PagePlacement = {
  left: number;
  top: number;
};

export type PageLayoutGeometry = {
  width: number;
  height: number;
  pagePlacements: PagePlacement[];
};

export function getPageLayoutGeometry(
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode = "single",
): PageLayoutGeometry {
  if (layout.pages.length === 0) {
    return { width: 0, height: 0, pagePlacements: [] };
  }

  if (pageLayoutMode === "spread") {
    const rows = Math.ceil(layout.pages.length / 2);
    const rowTops: number[] = new Array(rows).fill(0);
    const rowHeights: number[] = new Array(rows).fill(0);
    const rowWidths: number[] = new Array(rows).fill(0);

    let runningTop = 0;
    for (let row = 0; row < rows; row++) {
      rowTops[row] = runningTop;
      const left = layout.pages[row * 2];
      const right = layout.pages[row * 2 + 1];
      const leftW = left?.spec.widthPx ?? 0;
      const rightW = right?.spec.widthPx ?? 0;
      const leftH = left?.spec.heightPx ?? 0;
      const rightH = right?.spec.heightPx ?? 0;
      const rowHeight = Math.max(leftH, rightH);
      rowHeights[row] = rowHeight;
      rowWidths[row] = leftW + (right ? PAGE_STACK_GAP_PX + rightW : 0);
      runningTop += rowHeight + (row < rows - 1 ? PAGE_STACK_GAP_PX : 0);
    }

    const pagePlacements: PagePlacement[] = layout.pages.map((_, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2;
      if (col === 0) return { left: 0, top: rowTops[row] ?? 0 };
      const leftPageWidth = layout.pages[row * 2]?.spec.widthPx ?? 0;
      return { left: leftPageWidth + PAGE_STACK_GAP_PX, top: rowTops[row] ?? 0 };
    });

    return {
      width: Math.max(0, ...rowWidths),
      height: runningTop,
      pagePlacements,
    };
  }

  const pagePlacements: PagePlacement[] = [];
  let top = 0;
  let width = 0;
  for (let i = 0; i < layout.pages.length; i++) {
    const page = layout.pages[i]!;
    pagePlacements.push({ left: 0, top });
    top += page.spec.heightPx + (i < layout.pages.length - 1 ? PAGE_STACK_GAP_PX : 0);
    width = Math.max(width, page.spec.widthPx);
  }
  return { width, height: top, pagePlacements };
}
