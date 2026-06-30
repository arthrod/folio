/**
 * scrollPageInfo
 *
 * Framework-agnostic page-indicator state for the scrollable editor: the
 * current/total page derivation and the total-count clamp. The React
 * `useZoomAndPageInfo` hook owns the React state and the scroll/layout DOM
 * reads; this module owns the pure geometry.
 */

export type ScrollPageInfo = {
  currentPage: number;
  totalPages: number;
  visible: boolean;
};

export const updateScrollPageTotal = (
  previous: ScrollPageInfo,
  totalPages: number,
): ScrollPageInfo => ({
  ...previous,
  currentPage: Math.min(previous.currentPage, totalPages),
  totalPages,
});

export type ScrollPageMetrics = {
  /** Laid-out page heights (unscaled), top to bottom. */
  pageHeights: readonly number[];
  /** Current scroll offset of the container (scaled by zoom). */
  scrollTop: number;
  /** Visible height of the scroll container. */
  clientHeight: number;
  /** Current zoom factor. */
  zoom: number;
  /** Padding above the first page in the scroll container. */
  viewportPaddingTop: number;
  /** Gap rendered between consecutive pages. */
  pageGap: number;
};

/**
 * Derive the current page (the one under the viewport center) and total page
 * count from the laid-out page heights and the live scroll position. Returns
 * null when there are no pages to measure.
 */
export const computeScrollPageInfo = ({
  pageHeights,
  scrollTop,
  clientHeight,
  zoom,
  viewportPaddingTop,
  pageGap,
}: ScrollPageMetrics): { currentPage: number; totalPages: number } | null => {
  const totalPages = pageHeights.length;
  if (totalPages === 0) {
    return null;
  }

  const scaledViewportCenter = scrollTop + clientHeight / 2;
  const viewportCenter = scaledViewportCenter / Math.max(zoom, Number.EPSILON);

  let accumulatedY = viewportPaddingTop;
  let currentPage = 1;
  for (let i = 0; i < totalPages; i++) {
    // SAFETY: i is bounded by totalPages
    const pageHeight = pageHeights[i]!;
    const pageEnd = accumulatedY + pageHeight;
    if (viewportCenter < pageEnd) {
      currentPage = i + 1;
      break;
    }
    accumulatedY = pageEnd + pageGap;
    currentPage = i + 2;
  }

  return { currentPage: Math.min(currentPage, totalPages), totalPages };
};
