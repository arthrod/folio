import { layoutNextLine, prepareWithSegments } from "@chenglou/pretext";
import type {
  BandObstacle,
  BlockFragment,
  BlockSnapshot,
  BreakReason,
  ComposeMetrics,
  FootnoteInput,
  FrameLayout,
  Interval,
  LayoutInput,
  LayoutOutput,
  LayoutPoint,
  LineBox,
  MappingIndex,
  MeasuredDocumentSnapshot,
  PageFurnitureInput,
  PageLayout,
  PlacedRun,
  Rect,
  StyledRun,
} from "@stll/premirror-core";
import { DEFAULT_LAYOUT_POLICIES } from "@stll/premirror-core";

const UNBOUNDED_WIDTH = 1_000_000_000;
// Bounded LRU: long editing sessions probe many transient substrings; an
// uncapped map is a slow leak. Refresh-on-get keeps hot fonts/words resident.
const PRETEXT_WIDTH_CACHE_MAX = 4000;
const pretextWidthCache = new Map<string, number>();

function widthByPretext(text: string, font: string): number | null {
  const key = `${font}\n${text}`;
  const cached = pretextWidthCache.get(key);
  if (cached !== undefined) {
    pretextWidthCache.delete(key);
    pretextWidthCache.set(key, cached);
    return cached;
  }
  try {
    const prepared = prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
    const line = layoutNextLine(prepared, { segmentIndex: 0, graphemeIndex: 0 }, UNBOUNDED_WIDTH);
    if (!line && text.length > 0) {
      return null;
    }
    const width = Math.max(0, line?.width ?? 0);
    pretextWidthCache.set(key, width);
    if (pretextWidthCache.size > PRETEXT_WIDTH_CACHE_MAX) {
      const oldest = pretextWidthCache.keys().next().value;
      if (oldest !== undefined) pretextWidthCache.delete(oldest);
    }
    return width;
  } catch {
    return null;
  }
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

// -----------------------------------------------------------------------------
// Policy resolution
// -----------------------------------------------------------------------------

type ResolvedPolicies = {
  widowLinesMin: number;
  orphanLinesMin: number;
  keepWithNextEnabled: boolean;
  minSlotWidthPx: number;
  slotSelectionPolicy: "single_slot_flow" | "multi_slot_fill";
};

function resolvePolicies(input: LayoutInput): ResolvedPolicies {
  const p = input.policies;
  // M1: `multi_slot_fill` is contract-compatible but uses the same leftmost slot as `single_slot_flow`.
  return {
    widowLinesMin: p.widowLinesMin ?? DEFAULT_LAYOUT_POLICIES.widowLinesMin ?? 2,
    orphanLinesMin: p.orphanLinesMin ?? DEFAULT_LAYOUT_POLICIES.orphanLinesMin ?? 2,
    keepWithNextEnabled:
      p.keepWithNextEnabled ?? DEFAULT_LAYOUT_POLICIES.keepWithNextEnabled ?? true,
    minSlotWidthPx: p.minSlotWidthPx ?? DEFAULT_LAYOUT_POLICIES.minSlotWidthPx ?? 48,
    slotSelectionPolicy: p.slotSelectionPolicy ?? "single_slot_flow",
  };
}

// -----------------------------------------------------------------------------
// Run width (prepared.widthPx contract + deterministic fallback)
// -----------------------------------------------------------------------------

function readWidthFromPrepared(prepared: unknown): number | null {
  if (prepared && typeof prepared === "object" && prepared !== null && "widthPx" in prepared) {
    const w = (prepared as { widthPx: unknown }).widthPx;
    if (typeof w === "number" && Number.isFinite(w)) return w;
  }
  return null;
}

function runWidthPx(run: StyledRun, measured: MeasuredDocumentSnapshot["measuredRuns"]): number {
  const m = measured[run.id];
  const w = m ? readWidthFromPrepared(m.prepared) : null;
  // prepared.widthPx is for the full measured run; only use it when lengths match.
  if (
    w !== null &&
    m &&
    typeof m.textLength === "number" &&
    m.textLength > 0 &&
    run.text.length === m.textLength
  ) {
    return Math.max(0, w);
  }
  const pretextWidth = widthByPretext(run.text, run.font);
  if (pretextWidth !== null) return pretextWidth;
  if (
    m &&
    typeof m.widthPx === "number" &&
    Number.isFinite(m.widthPx) &&
    typeof m.textLength === "number" &&
    m.textLength > 0
  ) {
    const ratio = run.text.length / m.textLength;
    return Math.max(0, m.widthPx * ratio);
  }
  /** Deterministic fallback when measurement is absent: 7px per code unit. */
  return run.text.length * 7;
}

function pmPosAtRunOffset(
  run: StyledRun,
  charFrom: number,
  charTo: number,
): { from: number; to: number } {
  const len = run.text.length;
  const span = run.pmRange.to - run.pmRange.from;
  if (len === 0) return { from: run.pmRange.from, to: run.pmRange.to };
  if (span === len) {
    return {
      from: run.pmRange.from + charFrom,
      to: run.pmRange.from + charTo,
    };
  }
  const from = run.pmRange.from + Math.floor((charFrom * span) / len);
  const toRaw = run.pmRange.from + Math.floor((charTo * span) / len);
  const to = charTo > charFrom ? Math.max(from + 1, toRaw) : toRaw;
  return { from, to };
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

// -----------------------------------------------------------------------------
// Geometry: frame + obstacles (M1 single-slot flow)
// -----------------------------------------------------------------------------

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  let cur = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n.start <= cur.end) cur = { start: cur.start, end: Math.max(cur.end, n.end) };
    else {
      out.push(cur);
      cur = n;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Picks the leftmost usable horizontal slot for `single_slot_flow`.
 * If carving yields no segment ≥ minSlotWidthPx, returns full frame width at x=0 (no-op-safe).
 */
function usableSlotForBand(
  frameWidth: number,
  lineTop: number,
  lineBottom: number,
  obstacles: BandObstacle[] | undefined,
  minSlotWidthPx: number,
): { x: number; width: number } {
  const blocked: Interval[] = [];
  for (const o of obstacles ?? []) {
    if (o.yEnd <= lineTop || o.yStart >= lineBottom) continue;
    blocked.push(...o.intervalsForBand(lineTop, lineBottom));
  }
  const merged = mergeIntervals(blocked);
  let cursor = 0;
  for (const b of merged) {
    const gapW = b.start - cursor;
    if (gapW >= minSlotWidthPx) return { x: cursor, width: gapW };
    cursor = Math.max(cursor, b.end);
  }
  const tail = frameWidth - cursor;
  if (tail >= minSlotWidthPx) return { x: cursor, width: tail };
  return { x: 0, width: frameWidth };
}

function contentFrameRect(page: LayoutInput["page"], margins: LayoutInput["margins"]): Rect {
  return {
    x: margins.leftPx,
    y: margins.topPx,
    width: page.widthPx - margins.leftPx - margins.rightPx,
    height: page.heightPx - margins.topPx - margins.bottomPx,
  };
}

// -----------------------------------------------------------------------------
// Line breaking (pre-measured runs)
// -----------------------------------------------------------------------------

type LineDraft = {
  runs: PlacedRun[];
  pmFrom: number;
  pmTo: number;
};

function pushPlacedSegment(
  run: StyledRun,
  measured: MeasuredDocumentSnapshot["measuredRuns"],
  text: string,
  charFrom: number,
  charTo: number,
  x: number,
  out: PlacedRun[],
): number {
  const w = runWidthPx({ ...run, text }, measured);
  const pm = pmPosAtRunOffset(run, charFrom, charTo);
  out.push({
    runId: run.id,
    text,
    font: run.font,
    marks: run.marks,
    x,
    width: w,
    pmRange: pm,
  });
  return w;
}

function recalcLineDraft(
  line: LineDraft,
  measured: MeasuredDocumentSnapshot["measuredRuns"],
): void {
  let x = 0;
  let pmFrom = Number.POSITIVE_INFINITY;
  let pmTo = 0;
  for (let i = 0; i < line.runs.length; i++) {
    const r = line.runs[i]!;
    const w = runWidthPx(
      {
        id: r.runId,
        text: r.text,
        font: r.font,
        marks: r.marks,
        pmRange: r.pmRange,
      },
      measured,
    );
    line.runs[i] = { ...r, x, width: w };
    x += w;
    pmFrom = Math.min(pmFrom, r.pmRange.from);
    pmTo = Math.max(pmTo, r.pmRange.to);
  }
  if (line.runs.length === 0) {
    // A drained line keeps its position but must not span stale content:
    // collapse to an empty range at its own start so mapping/cursor code
    // never lands inside a range this line no longer owns.
    line.pmTo = line.pmFrom;
    return;
  }
  line.pmFrom = pmFrom;
  line.pmTo = pmTo;
}

function splitPlacedRunAtWordBoundary(
  run: PlacedRun,
  keepLen: number,
  measured: MeasuredDocumentSnapshot["measuredRuns"],
): { left: PlacedRun; right: PlacedRun } {
  const totalLen = run.text.length;
  const span = Math.max(0, run.pmRange.to - run.pmRange.from);
  const splitPos = run.pmRange.from + Math.floor((keepLen * span) / Math.max(1, totalLen));
  const leftText = run.text.slice(0, keepLen);
  const rightText = run.text.slice(keepLen);
  const leftWidth = runWidthPx(
    {
      id: run.runId,
      text: leftText,
      font: run.font,
      marks: run.marks,
      pmRange: { from: run.pmRange.from, to: splitPos },
    },
    measured,
  );
  const rightWidth = runWidthPx(
    {
      id: run.runId,
      text: rightText,
      font: run.font,
      marks: run.marks,
      pmRange: { from: splitPos, to: run.pmRange.to },
    },
    measured,
  );
  return {
    left: {
      ...run,
      text: leftText,
      pmRange: { from: run.pmRange.from, to: splitPos },
      width: leftWidth,
    },
    right: {
      ...run,
      text: rightText,
      pmRange: { from: splitPos, to: run.pmRange.to },
      width: rightWidth,
    },
  };
}

function fixWordBoundarySplits(
  lines: LineDraft[],
  measured: MeasuredDocumentSnapshot["measuredRuns"],
): void {
  const lineText = (line: LineDraft): string => line.runs.map((r) => r.text).join("");
  const firstWordCharIndex = (text: string): number => {
    for (let i = 0; i < text.length; i++) {
      if (isWordChar(text[i])) return i;
      if (text[i] === "\n") return -1;
    }
    return -1;
  };

  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i]!;
    const next = lines[i + 1]!;
    if (current.runs.length === 0 || next.runs.length === 0) continue;

    const currentText = lineText(current);
    const nextText = lineText(next);
    const tail = currentText.at(-1);
    const nextFirstWord = firstWordCharIndex(nextText);
    if (nextFirstWord < 0) continue;
    const head = nextText[nextFirstWord];
    if (!isWordChar(tail) || !isWordChar(head)) continue;

    const moved: PlacedRun[] = [];
    while (current.runs.length > 0) {
      const last = current.runs[current.runs.length - 1]!;
      let j = last.text.length;
      while (j > 0 && isWordChar(last.text[j - 1])) j--;
      if (j === last.text.length) break;
      if (j === 0) {
        moved.unshift(last);
        current.runs.pop();
        continue;
      }
      const { left, right } = splitPlacedRunAtWordBoundary(last, j, measured);
      current.runs[current.runs.length - 1] = left;
      moved.unshift(right);
      break;
    }
    if (moved.length === 0) continue;
    next.runs = [...moved, ...next.runs];
    recalcLineDraft(current, measured);
    recalcLineDraft(next, measured);
  }
}

function breakBlockIntoLineDrafts(
  block: BlockSnapshot,
  snapshot: MeasuredDocumentSnapshot,
  contentWidth: number,
): LineDraft[] {
  const lines: LineDraft[] = [];
  const measuredRuns = snapshot.measuredRuns;

  let currentParts: PlacedRun[] = [];
  let lineWidthUsed = 0;
  let linePmFrom = Number.POSITIVE_INFINITY;
  let linePmTo = 0;

  const flushCurrentLine = (): void => {
    if (currentParts.length === 0) return;
    lines.push({
      runs: currentParts,
      pmFrom: linePmFrom,
      pmTo: linePmTo,
    });
    currentParts = [];
    lineWidthUsed = 0;
    linePmFrom = Number.POSITIVE_INFINITY;
    linePmTo = 0;
  };

  const appendToLine = (pr: PlacedRun, pmFrom: number, pmTo: number): void => {
    currentParts.push(pr);
    lineWidthUsed += pr.width;
    linePmFrom = Math.min(linePmFrom, pmFrom);
    linePmTo = Math.max(linePmTo, pmTo);
  };

  for (const run of block.runs) {
    const pieces = run.text.split("\n");
    for (let pi = 0; pi < pieces.length; pi++) {
      if (pi > 0) flushCurrentLine();
      const piece = pieces[pi] ?? "";

      if (run.atomic) {
        if (piece.length === 0) continue;
        const placed: PlacedRun[] = [];
        const width = pushPlacedSegment(run, measuredRuns, piece, 0, piece.length, 0, placed);
        const pr = placed[0]!;
        if (lineWidthUsed > 0 && lineWidthUsed + width > contentWidth) flushCurrentLine();
        appendToLine(pr, pr.pmRange.from, pr.pmRange.to);
        continue;
      }

      let offset = 0;
      while (offset < piece.length) {
        const end = piece.length;
        let best = offset;
        while (best < end) {
          const mid = best + 1;
          const sub = piece.slice(offset, mid);
          const w = runWidthPx({ ...run, text: sub }, measuredRuns);
          if (lineWidthUsed + w > contentWidth) break;
          best = mid;
        }
        const bestBeforeWhitespaceAdjust = best;

        // Prefer breaking at the most recent whitespace when we need a soft wrap.
        if (best > offset && best < piece.length) {
          for (let i = best - 1; i > offset; i--) {
            const ch = piece[i];
            if (ch === " " || ch === "\t") {
              // Include the whitespace with the previous line so the next line
              // doesn't start with an undecorated/unstyled position.
              best = i + 1;
              break;
            }
          }
        }

        // If the candidate would end with a one-letter trailing token and the
        // next character continues the same word, backtrack to the preceding
        // whitespace so we don't emit line ends like "... w".
        if (best > offset && best < piece.length && isWordChar(piece[best])) {
          const candidate = piece.slice(offset, best);
          const token = /(?:^|[ \t])([A-Za-z0-9])$/.exec(candidate);
          if (token) {
            const lastSpace = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
            if (lastSpace >= 0) {
              const backtracked = offset + lastSpace + 1;
              if (backtracked > offset) {
                best = backtracked;
              }
            }
          }
        }

        if (best === offset) {
          const sub = piece.slice(offset, offset + 1);
          const w = runWidthPx({ ...run, text: sub }, measuredRuns);
          if (lineWidthUsed > 0 && lineWidthUsed + w > contentWidth) {
            flushCurrentLine();
          }
          const placed: PlacedRun[] = [];
          pushPlacedSegment(run, measuredRuns, sub, offset, offset + 1, lineWidthUsed, placed);
          const pr = placed[0]!;
          appendToLine(pr, pr.pmRange.from, pr.pmRange.to);
          offset += 1;
        } else {
          const fittedLen = best - offset;
          const candidate = piece.slice(offset, best);
          const splittingWordAfterOneChar =
            lineWidthUsed > 0 &&
            fittedLen === 1 &&
            best < piece.length &&
            isWordChar(piece[offset]) &&
            isWordChar(piece[best]);
          const splittingWordAfterWhitespaceOneChar =
            lineWidthUsed > 0 &&
            best < piece.length &&
            /^[ \t]*[A-Za-z0-9]$/.test(candidate) &&
            isWordChar(piece[best]);
          if (splittingWordAfterOneChar) {
            // Avoid "single-character + rest-of-word" breaks (e.g. "c an").
            // Reflow this token on the next line; if it still can't fit there,
            // normal single-character fallback below will handle it.
            flushCurrentLine();
            continue;
          }
          if (splittingWordAfterWhitespaceOneChar) {
            // Also avoid wrapping as " w" + "ord" when only one word char
            // fits after leading whitespace.
            flushCurrentLine();
            continue;
          }

          const sub = candidate;
          const placed: PlacedRun[] = [];
          const x = lineWidthUsed;
          pushPlacedSegment(run, measuredRuns, sub, offset, best, x, placed);
          const pr = placed[0]!;
          appendToLine(pr, pr.pmRange.from, pr.pmRange.to);
          offset = best;
          const wrappedAtWhitespace = best < bestBeforeWhitespaceAdjust;
          if (wrappedAtWhitespace) {
            flushCurrentLine();
          }
        }
      }
    }
  }
  if (lines.length === 0 && currentParts.length === 0) {
    const anchor = block.runs[0]?.pmRange.from ?? block.pmRange.from + 1;
    lines.push({
      runs: [],
      pmFrom: anchor,
      pmTo: anchor,
    });
  }
  flushCurrentLine();
  fixWordBoundarySplits(lines, measuredRuns);
  return lines;
}

// -----------------------------------------------------------------------------
// Widow / orphan
// -----------------------------------------------------------------------------

function linesThatFitFirstFragment(
  remainingLines: number,
  maxLinesOnPage: number,
  orphanMin: number,
  widowMin: number,
): { fit: number; reason: BreakReason | undefined } {
  if (remainingLines === 0) return { fit: 0, reason: undefined };
  const cap = Math.min(maxLinesOnPage, remainingLines);
  if (cap >= remainingLines) return { fit: remainingLines, reason: undefined };

  if (remainingLines === 1) {
    return { fit: 0, reason: undefined };
  }

  const fit = cap;
  if (fit < orphanMin && remainingLines >= orphanMin) {
    return { fit: 0, reason: "widow_orphan_protection" };
  }
  if (remainingLines - fit < widowMin) {
    const alt = remainingLines - widowMin;
    if (alt >= orphanMin) {
      return { fit: alt, reason: "widow_orphan_protection" };
    }
    return { fit: 0, reason: "widow_orphan_protection" };
  }
  return { fit, reason: "frame_overflow" };
}

// -----------------------------------------------------------------------------
// Mapping index
// -----------------------------------------------------------------------------

type LineRef = {
  pageIndex: number;
  frameIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  pmFrom: number;
  pmTo: number;
};

function buildMappingIndex(refs: LineRef[]): MappingIndex {
  const sorted = [...refs].sort((a, b) => a.pmFrom - b.pmFrom);

  const pmPosToLayout = (pmPos: number): LayoutPoint | null => {
    // Binary search for the first ref with pmFrom > pmPos, then walk back
    // over the (rare) refs whose ranges still reach pmPos. Scanning back to
    // the LOWEST matching index preserves the linear scan's tie-break: a
    // boundary position (pmPos === pmTo) resolves to the EARLIER line, not
    // the next line whose pmFrom equals it (pinned by the mapping goldens).
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.pmFrom > pmPos) hi = mid;
      else lo = mid + 1;
    }
    let match: LineRef | null = null;
    for (let i = lo - 1; i >= 0; i--) {
      const r = sorted[i]!;
      if (r.pmTo < pmPos && r.pmFrom < pmPos) break;
      if ((pmPos >= r.pmFrom && pmPos < r.pmTo) || pmPos === r.pmTo) match = r;
    }
    if (match) {
      const r = match;
      if (pmPos >= r.pmFrom && pmPos < r.pmTo) {
        return {
          pageIndex: r.pageIndex,
          frameIndex: r.frameIndex,
          fragmentIndex: r.fragmentIndex,
          lineIndex: r.lineIndex,
          offsetInLine: pmPos - r.pmFrom,
        };
      }
      if (pmPos === r.pmTo) {
        return {
          pageIndex: r.pageIndex,
          frameIndex: r.frameIndex,
          fragmentIndex: r.fragmentIndex,
          lineIndex: r.lineIndex,
          offsetInLine: r.pmTo - r.pmFrom,
        };
      }
    }
    return null;
  };

  const layoutToPmPos = (point: LayoutPoint): number | null => {
    const hit = refs.find(
      (r) =>
        r.pageIndex === point.pageIndex &&
        r.frameIndex === point.frameIndex &&
        r.fragmentIndex === point.fragmentIndex &&
        r.lineIndex === point.lineIndex,
    );
    if (!hit) return null;
    const o = Math.max(0, Math.min(point.offsetInLine, hit.pmTo - hit.pmFrom));
    return hit.pmFrom + o;
  };

  return { pmPosToLayout, layoutToPmPos };
}

function offsetRunsForSlot(runs: PlacedRun[], slotX: number): PlacedRun[] {
  return runs.map((r) => ({ ...r, x: r.x + slotX }));
}

// -----------------------------------------------------------------------------
// Page furniture (header/footer)
// -----------------------------------------------------------------------------

/**
 * Compose header/footer content into a margin band using the same
 * pretext-measured line-breaking as the body. Furniture does not paginate: its
 * blocks stack from the band top and the resulting frame repeats on every page.
 * Line `y` is frame-relative (like the body); `bounds` carries the band's
 * absolute top-left and content width.
 *
 * `anchor` places the band relative to `distancePx`: `'top'` measures from the
 * page top edge to the band top; `'bottom'` measures from the page bottom edge
 * to the band bottom (so the band grows upward as content is added).
 *
 * `ctx` carries the per-page values used to resolve auto-updating field runs
 * (`field: 'page' | 'numPages'`), so the composed frame differs per page.
 */
type FurnitureContext = { pageNumber: number; totalPages: number };

/** Replace `field` runs' text with the resolved page number / total. */
function substituteFieldRuns(blocks: BlockSnapshot[], ctx: FurnitureContext): BlockSnapshot[] {
  let anyChanged = false;
  const out = blocks.map((block) => {
    let blockChanged = false;
    const runs = block.runs.map((run) => {
      if (!run.field) return run;
      blockChanged = true;
      anyChanged = true;
      const text = run.field === "page" ? String(ctx.pageNumber) : String(ctx.totalPages);
      return { ...run, text };
    });
    return blockChanged ? { ...block, runs } : block;
  });
  return anyChanged ? out : blocks;
}

function composeFurniture(
  furniture: PageFurnitureInput,
  input: LayoutInput,
  anchor: "top" | "bottom",
  ctx: FurnitureContext,
): FrameLayout {
  const lineHeight = input.typography.defaultLineHeightPx;
  const contentWidth = input.page.widthPx - input.margins.leftPx - input.margins.rightPx;
  const snapshot = furniture.snapshot;
  const blocks = substituteFieldRuns(snapshot.blocks, ctx);
  const fragments: BlockFragment[] = [];
  let y = 0;
  let fragmentIndex = 0;

  for (const block of blocks) {
    // block.runs may be field-substituted; measuredRuns keys are unchanged.
    const drafts = breakBlockIntoLineDrafts(block, snapshot, contentWidth);
    if (drafts.length === 0) continue;
    const lines: LineBox[] = drafts.map((d, li) => ({
      y: y + li * lineHeight,
      height: lineHeight,
      runs: offsetRunsForSlot(d.runs, 0),
      pmRange: { from: d.pmFrom, to: d.pmTo },
    }));
    const pmMin = Math.min(...drafts.map((d) => d.pmFrom));
    const pmMax = Math.max(...drafts.map((d) => d.pmTo));
    fragments.push({
      blockId: block.id,
      fragmentIndex,
      pmRange: { from: pmMin, to: pmMax },
      lines,
    });
    y += drafts.length * lineHeight;
    fragmentIndex += 1;
  }

  const bandY =
    anchor === "top" ? furniture.distancePx : input.page.heightPx - furniture.distancePx - y;

  return {
    bounds: {
      x: input.margins.leftPx,
      y: bandY,
      width: contentWidth,
      height: y,
    },
    fragments,
  };
}

/**
 * Compose a run of notes (footnotes or endnotes) into `area`. Each note's
 * blocks stack from the top of `area` via the same pretext-measured
 * line-breaking as the body, in the order given. Line `y` is frame-relative;
 * `bounds` carries the band's absolute top-left and the content width.
 */
function composeNotes(
  notes: ReadonlyArray<{ id: string; snapshot: MeasuredDocumentSnapshot }>,
  input: LayoutInput,
  area: Rect,
): FrameLayout {
  const lineHeight = input.typography.defaultLineHeightPx;
  const fragments: BlockFragment[] = [];
  let y = 0;
  let fragmentIndex = 0;

  for (const note of notes) {
    const snapshot = note.snapshot;
    for (const block of snapshot.blocks) {
      const drafts = breakBlockIntoLineDrafts(block, snapshot, area.width);
      if (drafts.length === 0) continue;
      const lines: LineBox[] = drafts.map((d, li) => ({
        y: y + li * lineHeight,
        height: lineHeight,
        runs: offsetRunsForSlot(d.runs, 0),
        pmRange: { from: d.pmFrom, to: d.pmTo },
      }));
      const pmMin = Math.min(...drafts.map((d) => d.pmFrom));
      const pmMax = Math.max(...drafts.map((d) => d.pmTo));
      fragments.push({
        blockId: `${note.id}:${block.id}`,
        fragmentIndex,
        pmRange: { from: pmMin, to: pmMax },
        lines,
      });
      y += drafts.length * lineHeight;
      fragmentIndex += 1;
    }
  }

  return {
    bounds: { x: area.x, y: area.y, width: area.width, height: y },
    fragments,
  };
}

/**
 * Compose a note run and paginate it across trailing pages. Notes are composed
 * once (via `composeNotes`), then their lines are packed into pages of
 * `contentFrame.height`; each page re-bases line `y` to the top of the content
 * frame. Returns one `FrameLayout` per page (empty when there are no notes).
 */
function paginateNotesToPages(
  notes: ReadonlyArray<{ id: string; snapshot: MeasuredDocumentSnapshot }>,
  input: LayoutInput,
  contentFrame: Rect,
): FrameLayout[] {
  const lineHeight = input.typography.defaultLineHeightPx;
  const composed = composeNotes(notes, input, {
    x: contentFrame.x,
    y: contentFrame.y,
    width: contentFrame.width,
    height: 0,
  });

  // Flatten to a line sequence tagged with its source fragment identity.
  const flat: Array<{ blockId: string; line: LineBox }> = [];
  for (const frag of composed.fragments) {
    for (const line of frag.lines) flat.push({ blockId: frag.blockId, line });
  }
  if (flat.length === 0) return [];

  const maxLines = Math.max(1, Math.floor(contentFrame.height / lineHeight));
  const pages: FrameLayout[] = [];

  for (let start = 0; start < flat.length; start += maxLines) {
    const slice = flat.slice(start, start + maxLines);
    const fragments: BlockFragment[] = [];
    let pageLineIdx = 0;
    let i = 0;
    while (i < slice.length) {
      const blockId = slice[i]!.blockId;
      const lines: LineBox[] = [];
      let pmFrom = Number.POSITIVE_INFINITY;
      let pmTo = 0;
      while (i < slice.length && slice[i]!.blockId === blockId) {
        const src = slice[i]!.line;
        lines.push({ ...src, y: pageLineIdx * lineHeight });
        pmFrom = Math.min(pmFrom, src.pmRange.from);
        pmTo = Math.max(pmTo, src.pmRange.to);
        pageLineIdx += 1;
        i += 1;
      }
      fragments.push({
        blockId,
        fragmentIndex: fragments.length,
        pmRange: { from: pmFrom, to: pmTo },
        lines,
      });
    }
    pages.push({
      bounds: {
        x: contentFrame.x,
        y: contentFrame.y,
        width: contentFrame.width,
        height: pageLineIdx * lineHeight,
      },
      fragments,
    });
  }

  return pages;
}

// -----------------------------------------------------------------------------
// composeLayout
// -----------------------------------------------------------------------------

export function composeLayout(
  snapshot: MeasuredDocumentSnapshot,
  previous: LayoutOutput | null,
  input: LayoutInput,
): LayoutOutput {
  void previous;
  const t0 = nowMs();

  const policies = resolvePolicies(input);
  const lineHeight = input.typography.defaultLineHeightPx;
  const frame = contentFrameRect(input.page, input.margins);
  // Footnotes reserve a band at the bottom of a page's content area, shrinking
  // that page's usable body height. `fullContentHeight` is the height before any
  // reservation; the per-page reservation is subtracted inside each body pass.
  const fullContentHeight = frame.height;
  const globalReservePx = Math.max(0, input.footnoteReservedPx ?? 0);
  const autoReserve = input.footnoteAutoReserve === true && (input.footnotes?.length ?? 0) > 0;
  const obstacles = input.obstacles;
  const blocks = snapshot.blocks;

  const contentWidthForBlockStart = (yInFrame: number): number => {
    const bandTop = frame.y + yInFrame;
    const bandBottom = bandTop + lineHeight;
    const slot = usableSlotForBand(
      frame.width,
      bandTop,
      bandBottom,
      obstacles,
      policies.minSlotWidthPx,
    );
    return slot.width;
  };

  const estimateBlockHeight = (b: BlockSnapshot, yInFrame: number): number => {
    const w = contentWidthForBlockStart(yInFrame);
    const d = breakBlockIntoLineDrafts(b, snapshot, w);
    return d.length * lineHeight;
  };

  // One body-layout pass. `reservedForPage(i)` gives page i's footnote band
  // height; the usable body height is `fullContentHeight` minus that. The pass
  // is pure w.r.t. that function, so the convergence loop can re-run it as the
  // per-page reservation changes.
  const runBodyPass = (
    reservedForPage: (pageIndex: number) => number,
  ): { pages: PageLayout[]; lineRefs: LineRef[] } => {
    const pages: PageLayout[] = [];
    const lineRefs: LineRef[] = [];

    let currentFragments: BlockFragment[] = [];
    let currentY = 0;
    let pageIndex = 0;

    const usableHeight = (): number => Math.max(0, fullContentHeight - reservedForPage(pageIndex));

    const flushPage = (reasonForLastFragment?: BreakReason): void => {
      if (currentFragments.length === 0) return;
      if (reasonForLastFragment !== undefined) {
        const last = currentFragments[currentFragments.length - 1]!;
        currentFragments[currentFragments.length - 1] = {
          ...last,
          breakReason: reasonForLastFragment,
        };
      }
      const frameLayout: FrameLayout = {
        bounds: { ...frame, height: usableHeight() },
        fragments: currentFragments,
      };
      pages.push({
        index: pageIndex,
        spec: input.page,
        frames: [frameLayout],
      });
      pageIndex += 1;
      currentFragments = [];
      currentY = 0;
    };

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]!;
      const manualBreak = block.attrs["manualPageBreakBefore"] === true;
      if (manualBreak && (currentFragments.length > 0 || currentY > 0)) {
        flushPage("manual_page_break");
      }

      const nextBlock = blocks[bi + 1];
      const keepNext =
        policies.keepWithNextEnabled &&
        block.attrs["keepWithNext"] === true &&
        nextBlock !== undefined;

      if (keepNext) {
        const h1 = estimateBlockHeight(block, currentY);
        const h2 = estimateBlockHeight(nextBlock, currentY + h1);
        const need = h1 + h2;
        const usable = usableHeight();
        const rem = usable - currentY;
        if (need <= usable && rem < need && (currentFragments.length > 0 || currentY > 0)) {
          flushPage("keep_with_next");
        }
      }

      const drafts = breakBlockIntoLineDrafts(block, snapshot, contentWidthForBlockStart(currentY));
      if (drafts.length === 0) continue;

      let lineCursor = 0;
      let fragmentIndex = 0;

      while (lineCursor < drafts.length) {
        const remaining = drafts.length - lineCursor;
        const maxLines = Math.max(0, Math.floor((usableHeight() - currentY) / lineHeight));
        const { fit, reason } = linesThatFitFirstFragment(
          remaining,
          Math.max(maxLines, 0),
          policies.orphanLinesMin,
          policies.widowLinesMin,
        );

        let useFit = fit;
        let breakReasonForSplit: BreakReason | undefined = reason;
        if (useFit === 0) {
          if (maxLines > 0) {
            // Never move a whole paragraph fragment to the next page when at
            // least one line can fit on this page. Split by line instead.
            useFit = Math.min(remaining, maxLines);
            breakReasonForSplit = "frame_overflow";
          } else if (currentY > 0) {
            flushPage(reason ?? "frame_overflow");
            continue;
          } else {
            useFit = 1;
            breakReasonForSplit = "frame_overflow";
          }
        }

        const chunk = drafts.slice(lineCursor, lineCursor + useFit);
        const assigned: LineBox[] = chunk.map((d, li) => {
          const y = currentY + li * lineHeight;
          const bt = frame.y + y;
          const bb = bt + lineHeight;
          const s = usableSlotForBand(frame.width, bt, bb, obstacles, policies.minSlotWidthPx);
          return {
            y,
            height: lineHeight,
            runs: offsetRunsForSlot(d.runs, s.x),
            pmRange: { from: d.pmFrom, to: d.pmTo },
          };
        });

        const pmMin = Math.min(...chunk.map((c) => c.pmFrom));
        const pmMax = Math.max(...chunk.map((c) => c.pmTo));

        const willContinue = lineCursor + useFit < drafts.length;
        const frag: BlockFragment = {
          blockId: block.id,
          fragmentIndex,
          pmRange: { from: pmMin, to: pmMax },
          lines: assigned,
          ...(willContinue ? { breakReason: breakReasonForSplit ?? "frame_overflow" } : {}),
        };

        const frIndex = 0;
        const fragIdx = currentFragments.length;
        for (let li = 0; li < assigned.length; li++) {
          const ln = assigned[li]!;
          lineRefs.push({
            pageIndex,
            frameIndex: frIndex,
            fragmentIndex: fragIdx,
            lineIndex: li,
            pmFrom: ln.pmRange.from,
            pmTo: ln.pmRange.to,
          });
        }

        currentFragments.push(frag);
        currentY += useFit * lineHeight;
        lineCursor += useFit;
        fragmentIndex += 1;

        if (lineCursor < drafts.length) {
          flushPage();
        }
      }
    }

    flushPage();

    if (pages.length === 0) {
      pages.push({
        index: 0,
        spec: input.page,
        frames: [{ bounds: { ...frame, height: usableHeight() }, fragments: [] }],
      });
    }

    return { pages, lineRefs };
  };

  // Height a page's notes occupy when composed into a full-width band.
  const measureNotesHeight = (notes: FootnoteInput[]): number =>
    composeNotes(notes, input, { x: frame.x, y: 0, width: frame.width, height: 0 }).bounds.height;

  // Group footnotes by the page their reference (`refPmPos`) resolves to, given
  // a body layout's mapping. A reference with no mapped line falls back to page 0.
  const groupNotesByPage = (refs: LineRef[]): Map<number, FootnoteInput[]> => {
    const map = buildMappingIndex(refs);
    const grouped = new Map<number, FootnoteInput[]>();
    for (const note of input.footnotes ?? []) {
      const p = map.pmPosToLayout(note.refPmPos)?.pageIndex ?? 0;
      const bucket = grouped.get(p);
      if (bucket) bucket.push(note);
      else grouped.set(p, [note]);
    }
    return grouped;
  };

  // Per-page reserved height. Non-auto: the fixed global band on every page.
  // Auto: this pass's converged per-page map (0 where a page has no notes).
  let reservedByPage = new Map<number, number>();
  const reservedForPage = (pageIndex: number): number =>
    autoReserve ? (reservedByPage.get(pageIndex) ?? 0) : globalReservePx;

  let bodyResult = runBodyPass(reservedForPage);

  if (autoReserve) {
    // Reserving a note's space can reflow the body and move a reference to a
    // different page, changing which page must reserve. Iterate to a fixed
    // point; the pass cap bounds the (rare) oscillating case.
    const MAX_PASSES = 6;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const grouped = groupNotesByPage(bodyResult.lineRefs);
      const next = new Map<number, number>();
      for (const [p, notes] of grouped) next.set(p, measureNotesHeight(notes));
      let stable = next.size === reservedByPage.size;
      if (stable) {
        for (const [p, h] of next) {
          if (reservedByPage.get(p) !== h) {
            stable = false;
            break;
          }
        }
      }
      if (stable) break;
      reservedByPage = next;
      bodyResult = runBodyPass(reservedForPage);
    }
  }

  const pages = bodyResult.pages;
  const lineRefs = bodyResult.lineRefs;

  // Body mapping index, built once: reused to place footnotes on the page their
  // reference lands on and returned as the layout's pm↔layout mapping.
  const mapping = buildMappingIndex(lineRefs);
  const notesByPage = groupNotesByPage(lineRefs);

  // Header/footer furniture is composed per page so field runs (PAGE/NUMPAGES)
  // resolve to that page's number and the total. With titlePg, page 0 uses the
  // first-page variant (or a blank band when that variant is absent).
  {
    const totalPages = pages.length;
    for (const page of pages) {
      const isFirst = page.index === 0;
      const useFirst = input.titlePg === true && isFirst;
      const headerFurniture = useFirst ? input.firstHeader : input.header;
      const footerFurniture = useFirst ? input.firstFooter : input.footer;
      const ctx = { pageNumber: page.index + 1, totalPages };
      if (headerFurniture) page.header = composeFurniture(headerFurniture, input, "top", ctx);
      if (footerFurniture) page.footer = composeFurniture(footerFurniture, input, "bottom", ctx);
      const reserved = reservedForPage(page.index);
      if (reserved > 0) {
        const area: Rect = {
          x: frame.x,
          y: frame.y + (fullContentHeight - reserved),
          width: frame.width,
          height: reserved,
        };
        page.footnoteArea = area;
        const notes = notesByPage.get(page.index);
        if (notes && notes.length > 0) {
          page.footnotes = composeNotes(notes, input, area);
        }
      }
    }
  }

  // Endnotes collect at the end of the document: they flow together onto
  // trailing page(s) appended after the body, stacked from the top of the
  // content frame and paginated when they exceed one page.
  const endnotes = input.endnotes ?? [];
  if (endnotes.length > 0) {
    const contentFrame: Rect = {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: fullContentHeight,
    };
    for (const endnotesFrame of paginateNotesToPages(endnotes, input, contentFrame)) {
      pages.push({ index: pages.length, spec: input.page, frames: [], endnotes: endnotesFrame });
    }
  }

  const t1 = nowMs();
  const composeMs = t1 - t0;

  const metrics: ComposeMetrics = {
    extractionMs: 0,
    measurementMs: 0,
    composeMs,
    pages: pages.length,
    blocks: blocks.length,
  };

  return {
    pages,
    mapping,
    metrics,
  };
}
