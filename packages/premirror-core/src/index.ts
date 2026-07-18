/**
 * @premirror/core — public contracts for Premirror (Milestone 1).
 */

// --- Shared primitives -------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };

export type Interval = { start: number; end: number };

export type PagePreset = "letter" | "a4";

export type PageSpec = {
  widthPx: number;
  heightPx: number;
  preset?: PagePreset;
};

export type PageMargins = {
  topPx: number;
  rightPx: number;
  bottomPx: number;
  leftPx: number;
};

export type TypographyConfig = {
  defaultFont: string;
  defaultLineHeightPx: number;
  tabSize?: number;
};

export type LayoutPolicyConfig = {
  widowLinesMin?: number;
  orphanLinesMin?: number;
  keepWithNextEnabled?: boolean;
  minSlotWidthPx?: number;
  slotSelectionPolicy?: "single_slot_flow" | "multi_slot_fill";
};

export type PremirrorOptions = {
  page: PageSpec;
  margins: PageMargins;
  typography: TypographyConfig;
  policies?: LayoutPolicyConfig;
  features?: Record<string, boolean>;
  /**
   * Line-fitting engine used for text measurement (E-4 unification). Absent
   * engine means measurement falls back to the deterministic per-character
   * widths; no premirror package talks to a concrete engine directly.
   */
  engine?: SegmentFitEngineLike;
};

// --- Segment-fit engine seam -------------------------------------------------

/**
 * One fitted line piece returned by the engine. Structural mirror of
 * folio-core's `SegmentFitLine` (`packages/core/src/layout-engine/measure/
 * segmentFit.ts`); see `SegmentFitEngineLike`.
 */
export type SegmentFitLineLike = {
  /** Exclusive end offset in the prepared text (UTF-16 code units). */
  endChar: number;
  /** Measured advance width of the fitted piece in px. */
  width: number;
  /** Opaque continuation cursor; pass back to `fitLine` for the next piece. */
  cursor: unknown;
};

/** A prepared (segmented + measured) text handle. Opaque to premirror. */
export type SegmentFitPreparedLike = unknown;

/**
 * Pluggable line-fitting engine injected into the premirror measurement
 * pipeline. This is a STRUCTURAL mirror of folio-core's `SegmentFitEngine`
 * seam type (`packages/core/src/layout-engine/measure/segmentFit.ts`) —
 * deliberately declared here without a folio-core dependency so the premirror
 * packages stay standalone and upstreamable to samwillis/premirror. Any object
 * with this shape satisfies it: `@stll/premirror-bridge`'s
 * `pretextSegmentFitEngine`, or a deterministic test fake.
 */
export type SegmentFitEngineLike = {
  /**
   * Whether the engine can fit `text` with offsets that stay aligned to the
   * original string. Engines that normalize input before segmenting must
   * decline such texts here; declined texts measure through the fallback.
   */
  supportsText?: (text: string) => boolean;
  /**
   * Prepare `text` for fitting under the given CSS font string.
   * Implementations should cache.
   */
  prepare: (text: string, cssFont: string) => SegmentFitPreparedLike;
  /**
   * Fit the next line piece starting at `cursor` (null = start of text) into
   * `maxWidth` px. Returns null when nothing fits.
   */
  fitLine: (
    prepared: SegmentFitPreparedLike,
    cursor: unknown | null,
    maxWidth: number,
  ) => SegmentFitLineLike | null;
  /** Drop any prepared/measured state. */
  clearCaches?: () => void;
};

// --- Snapshot model ----------------------------------------------------------

export type ResolvedMarkSet = {
  strong?: boolean;
  em?: boolean;
  code?: boolean;
  linkHref?: string;
};

export type StyledRun = {
  id: string;
  text: string;
  font: string;
  marks: ResolvedMarkSet;
  pmRange: { from: number; to: number };
  atomic?: boolean;
  /**
   * Auto-updating field. In header/footer furniture the run's `text` is
   * replaced per page: `'page'` → the 1-based page number, `'numPages'` → the
   * total page count. Ignored for body content.
   */
  field?: "page" | "numPages";
};

export type BlockSnapshot = {
  id: string;
  type: "paragraph" | "heading" | "blockquote";
  attrs: Record<string, unknown>;
  runs: StyledRun[];
  pmRange: { from: number; to: number };
};

export type UnmeasuredDocumentSnapshot = {
  blocks: BlockSnapshot[];
};

export type MeasuredRun = {
  runId: string;
  prepared: unknown;
  widthPx?: number;
  textLength?: number;
};

export type MeasuredDocumentSnapshot = UnmeasuredDocumentSnapshot & {
  measuredRuns: Record<string, MeasuredRun>;
};

// --- Layout model ------------------------------------------------------------

export type BreakReason =
  | "frame_overflow"
  | "manual_page_break"
  | "keep_with_next"
  | "widow_orphan_protection";

export type PlacedRun = {
  runId: string;
  text: string;
  font: string;
  marks: ResolvedMarkSet;
  x: number;
  width: number;
  pmRange: { from: number; to: number };
};

export type LineBox = {
  y: number;
  height: number;
  runs: PlacedRun[];
  pmRange: { from: number; to: number };
};

export type BlockFragment = {
  blockId: string;
  fragmentIndex: number;
  pmRange: { from: number; to: number };
  lines: LineBox[];
  breakReason?: BreakReason;
};

export type FrameLayout = {
  bounds: Rect;
  fragments: BlockFragment[];
};

export type PageLayout = {
  index: number;
  spec: PageSpec;
  frames: FrameLayout[];
  /** Composed header furniture placed in the top-margin band (repeats per page). */
  header?: FrameLayout;
  /** Composed footer furniture placed in the bottom-margin band (repeats per page). */
  footer?: FrameLayout;
  /**
   * Reserved band at the bottom of the content area for footnotes (below the
   * body, above the bottom margin). Present when `footnoteReservedPx` is set.
   */
  footnoteArea?: Rect;
  /**
   * Composed footnote content for this page (notes whose references land here),
   * stacked from the top of `footnoteArea`. Line `y` is frame-relative.
   */
  footnotes?: FrameLayout;
  /**
   * Composed endnote content, present on the trailing page(s) that collect the
   * document's endnotes. Stacked from the top of the content frame; line `y` is
   * frame-relative. A page carrying endnotes has an empty `frames`.
   */
  endnotes?: FrameLayout;
};

export type LayoutPoint = {
  pageIndex: number;
  frameIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  offsetInLine: number;
};

export type MappingIndex = {
  pmPosToLayout: (pmPos: number) => LayoutPoint | null;
  layoutToPmPos: (point: LayoutPoint) => number | null;
};

export type ComposeMetrics = {
  extractionMs: number;
  measurementMs: number;
  composeMs: number;
  pages: number;
  blocks: number;
};

/**
 * Page furniture (header/footer) content composed into a page margin band via
 * the same pretext-measured line-breaking as the body. `distancePx` is the
 * offset from the page edge to the band's top-left corner.
 */
export type PageFurnitureInput = {
  snapshot: MeasuredDocumentSnapshot;
  distancePx: number;
};

/**
 * A footnote to compose into the reserved bottom band. `refPmPos` is the body
 * pm position of the note's reference marker, which determines the page the
 * note is placed on (the page its reference lands on).
 */
export type FootnoteInput = {
  id: string;
  refPmPos: number;
  snapshot: MeasuredDocumentSnapshot;
};

/**
 * An endnote collected at the end of the document. Unlike footnotes, endnotes
 * do not sit on their reference's page — they flow together onto trailing
 * page(s) after the body, in the order given.
 */
export type EndnoteInput = {
  id: string;
  snapshot: MeasuredDocumentSnapshot;
};

export type LayoutInput = {
  page: PageSpec;
  margins: PageMargins;
  typography: TypographyConfig;
  policies: LayoutPolicyConfig;
  /**
   * Line-fitting engine for runs without usable measured widths (E-4
   * unification). Absent engine means the deterministic fallback widths.
   */
  engine?: SegmentFitEngineLike;
  obstacles?: BandObstacle[];
  /** Optional header content laid into the top-margin band on every page. */
  header?: PageFurnitureInput;
  /**
   * Optional footer content laid into the bottom-margin band on every page.
   * `distancePx` is measured from the page's BOTTOM edge to the band's bottom.
   */
  footer?: PageFurnitureInput;
  /**
   * Different-first-page (OOXML `w:titlePg`). When true, the first page (index
   * 0) uses `firstHeader`/`firstFooter` instead of `header`/`footer`; if the
   * first-page variant is absent, that band is blank on the first page.
   */
  titlePg?: boolean;
  /** First-page header, used on page 0 when `titlePg` is true. */
  firstHeader?: PageFurnitureInput;
  /** First-page footer, used on page 0 when `titlePg` is true. */
  firstFooter?: PageFurnitureInput;
  /**
   * Height (px) reserved at the bottom of every page's content area for
   * footnotes. Shrinks the usable body height and exposes `PageLayout.footnoteArea`.
   * A fixed, global reservation applied to every page (ignored when
   * `footnoteAutoReserve` is true).
   */
  footnoteReservedPx?: number;
  /**
   * Footnotes to compose into the reserved band. Each note is placed on the
   * page its reference (`refPmPos`) lands on.
   */
  footnotes?: FootnoteInput[];
  /**
   * Reserve footnote space per page instead of globally: each page reserves only
   * the height its own notes need (pages without notes reserve nothing). Because
   * reserving space can reflow the body — and move a reference to another page —
   * the layout is iterated to a fixed point (bounded pass count). Requires
   * `footnotes`; `footnoteReservedPx` is ignored when this is set.
   */
  footnoteAutoReserve?: boolean;
  /**
   * Endnotes collected at the end of the document. They flow together onto
   * trailing page(s) appended after the body, in array order, and are exposed
   * via `PageLayout.endnotes` on those pages.
   */
  endnotes?: EndnoteInput[];
};

export type LayoutOutput = {
  pages: PageLayout[];
  mapping: MappingIndex;
  metrics: ComposeMetrics;
};

export type ComposeWarning = {
  code: string;
  message: string;
};

export type ComposeDiagnostics = {
  warnings: ComposeWarning[];
  timings: ComposeMetrics;
};

export type ProjectedSelection = {
  pmRange: { from: number; to: number };
  rects: Rect[];
};

export type BandObstacle = {
  id: string;
  yStart: number;
  yEnd: number;
  intervalsForBand: (bandTop: number, bandBottom: number) => Interval[];
};

// --- Defaults & helpers ------------------------------------------------------

/** US Letter @ 96 DPI (common CSS px baseline). */
export const LETTER_PAGE_PX: PageSpec = {
  widthPx: 816,
  heightPx: 1056,
  preset: "letter",
};

/** ISO A4 @ 96 DPI. */
export const A4_PAGE_PX: PageSpec = {
  widthPx: 794,
  heightPx: 1123,
  preset: "a4",
};

export const DEFAULT_PAGE_MARGINS: PageMargins = {
  topPx: 96,
  rightPx: 96,
  bottomPx: 96,
  leftPx: 96,
};

export const DEFAULT_TYPOGRAPHY: TypographyConfig = {
  defaultFont: "system-ui, sans-serif",
  defaultLineHeightPx: 20,
  tabSize: 4,
};

export const DEFAULT_LAYOUT_POLICIES: LayoutPolicyConfig = {
  widowLinesMin: 2,
  orphanLinesMin: 2,
  keepWithNextEnabled: true,
  minSlotWidthPx: 48,
  slotSelectionPolicy: "single_slot_flow",
};

export function pageSpecForPreset(preset: PagePreset): PageSpec {
  return preset === "a4" ? { ...A4_PAGE_PX } : { ...LETTER_PAGE_PX };
}

export function defaultPremirrorOptions(overrides?: Partial<PremirrorOptions>): PremirrorOptions {
  const page = overrides?.page ?? { ...LETTER_PAGE_PX };
  const margins = overrides?.margins ?? { ...DEFAULT_PAGE_MARGINS };
  const typography = overrides?.typography ?? { ...DEFAULT_TYPOGRAPHY };
  // Merge per-field like createLayoutInputFromOptions does: a partial
  // override must not drop the unspecified policy defaults.
  const policies = { ...DEFAULT_LAYOUT_POLICIES, ...overrides?.policies };
  const features = overrides?.features;
  const engine = overrides?.engine;
  return {
    page,
    margins,
    typography,
    policies,
    ...(features !== undefined ? { features } : {}),
    ...(engine !== undefined ? { engine } : {}),
  };
}

export function createLayoutInputFromOptions(options: PremirrorOptions): LayoutInput {
  return {
    page: options.page,
    margins: options.margins,
    typography: options.typography,
    policies: { ...DEFAULT_LAYOUT_POLICIES, ...options.policies },
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
  };
}

/** Demo bootstrap helper (kept for existing app imports). */
export function buildPremirrorBanner(): string {
  return "Premirror monorepo initialized";
}
