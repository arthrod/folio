/**
 * Document model → jubarte AST mapping for the SAVE path.
 *
 * Structure (paragraphs, runs, text, tables, comment anchors) maps to typed
 * jubarte nodes; property bags (`pPr`/`rPr`/`tblPr`/`trPr`/`tcPr`) are built
 * by the PORTED legacy property serializers (./emit/*) — the single source of
 * truth for which properties get emitted — and converted to `AstRunProp`
 * trees via {@link ./propShim}. Content whose legacy emission carries
 * normalization the typed AST cannot express faithfully (tracked-change
 * wrappers with their delText nuances, hyperlink attributes, fields expanded
 * to fldChar runs, bookmarks with preserved ids, drawings/shapes, SDTs, math)
 * rides on `opaqueElement`/`drawing` verbatim carriers holding the exact
 * legacy-serialized fragment, which jubarte's writer re-emits byte-for-byte.
 *
 * jubarte's package writer drops `w14:paraId`/`w14:textId` on every paragraph
 * it regenerates from a typed node. Each mapping context therefore records a
 * {@link ParagraphTagExpectation} ledger — the expected `<w:p` tag stream of
 * the emitted part in document order — so the save orchestrator can re-stamp
 * the ids afterwards without ever touching a paragraph that came out of a
 * verbatim carrier (those already carry their ids).
 */

import type {
  BlockContent,
  Comment,
  Endnote,
  Footnote,
  Paragraph,
  Run,
  RunContent,
  Table,
  TableCell,
  TableRow,
  TextContent,
} from "../../types/document";
import { parseXml } from "../xmlParser";
import { serializeBlockSdt } from "./emit/blockSdtSerializer";
import {
  extractPPrInner,
  serializeParagraph,
  serializeParagraphContent,
  serializeParagraphFormatting,
} from "./emit/paragraphSerializer";
import {
  serializeBreakContent,
  serializeDrawingContent,
  serializeFieldChar,
  serializeInstrText,
  serializeRunProperties,
  serializeShapeContent,
  serializeSymbolContent,
  serializeTextContent,
} from "./emit/runSerializer";
import { serializeSectionProperties } from "./emit/sectionPropertiesSerializer";
import {
  serializeTable,
  serializeTableCellFormatting,
  serializeTableFormatting,
  serializeTableGrid,
  serializeTableRowFormatting,
} from "./emit/tableSerializer";
import { escapeXml } from "./emit/xmlUtils";
import { containerElementToAstProps } from "./propShim";
import type {
  AstComment,
  AstDocumentElement,
  AstNote,
  AstOpaqueElement,
  AstParagraph,
  AstRun,
  AstRunProp,
  AstTable,
  AstTableCell,
  AstTableRow,
} from "./types";

// ============================================================================
// Paragraph-tag ledger (paraId/textId re-stamping support)
// ============================================================================

/**
 * One entry per `<w:p` start tag the emitted part will contain, in document
 * order. `typed` entries come from AstParagraph nodes the jubarte writer
 * regenerates (attribute-less — the stamper re-adds the ids); `opaque`
 * entries cover `<w:p` tags inside verbatim carriers, which already carry
 * their attributes and must be skipped untouched.
 */
export type ParagraphTagExpectation =
  | { kind: "typed"; paraId?: string; textId?: string }
  | { kind: "opaque"; count: number };

export type ToAstContext = {
  /** Expected `<w:p` tag stream for the emitted part, in document order. */
  paragraphTags: ParagraphTagExpectation[];
};

export function createToAstContext(): ToAstContext {
  return { paragraphTags: [] };
}

/** Matches every `<w:p` start tag (`<w:p>`, `<w:p/>`, `<w:p attrs…>`) and nothing else. */
const W_P_TAG_RE = /<w:p[\s/>]/gu;

/** Count the `<w:p` start tags inside an XML fragment. */
export function countParagraphTags(xml: string): number {
  let count = 0;
  W_P_TAG_RE.lastIndex = 0;
  while (W_P_TAG_RE.exec(xml) !== null) {
    count += 1;
  }
  return count;
}

function pushOpaqueTags(ctx: ToAstContext, xml: string): void {
  const count = countParagraphTags(xml);
  if (count > 0) {
    ctx.paragraphTags.push({ kind: "opaque", count });
  }
}

/** Wrap a legacy-serialized fragment as a verbatim carrier, recording its `<w:p` tags. */
function opaque(ctx: ToAstContext, name: string, xml: string): AstOpaqueElement {
  pushOpaqueTags(ctx, xml);
  return { type: "opaqueElement", name, xml };
}

/** Record a fragment's `<w:p` tags (shape/drawing textboxes) and pass it through. */
function withOpaqueTags(ctx: ToAstContext, xml: string): string {
  pushOpaqueTags(ctx, xml);
  return xml;
}

// ============================================================================
// Property-fragment → AstRunProp[] shim
// ============================================================================

/**
 * Parse a legacy property fragment (`<w:pPr>…</w:pPr>`, `<w:rPr>…`,
 * `<w:tblPr>…`, …) into the writer's structured property list. Returns null
 * for an empty fragment (⇒ the writer emits nothing / its minimal fallback).
 */
function fragmentToProps(fragmentXml: string): AstRunProp[] | null {
  if (!fragmentXml) {
    return null;
  }
  const root = parseXml(fragmentXml);
  const container = root.elements?.[0];
  return containerElementToAstProps(container);
}

function findProp(props: readonly AstRunProp[] | null, name: string): AstRunProp | undefined {
  return props?.find((prop) => prop.name === name);
}

/** Mirrors the writer's `toggleIsOn` so its rPr toggle reconciliation is a no-op. */
function toggleOn(props: readonly AstRunProp[] | null, name: string): boolean {
  const prop = findProp(props, name);
  if (!prop) {
    return false;
  }
  const value = prop.attrs["w:val"];
  return value !== "false" && value !== "0";
}

/** Mirrors the writer's `underlineIsOn`. */
function underlineOn(props: readonly AstRunProp[] | null): boolean {
  const prop = findProp(props, "w:u");
  if (!prop) {
    return false;
  }
  const value = prop.attrs["w:val"];
  return value !== undefined && value !== "false" && value !== "0" && value !== "none";
}

const NULL_INDENT = (): AstParagraph["indent"] => ({
  start: null,
  end: null,
  firstLine: null,
  hanging: null,
});

// ============================================================================
// Runs
// ============================================================================

/**
 * Legacy `serializeTextContent` adds `xml:space="preserve"` for
 * `preserveSpace || leading/trailing space || '  '`; jubarte's `writeText`
 * uses an edge-whitespace test. When they agree, a typed text node is
 * byte-equivalent; when they disagree, carry the legacy fragment verbatim.
 */
function mapText(ctx: ToAstContext, content: TextContent): AstDocumentElement {
  const legacyPreserve =
    Boolean(content.preserveSpace) ||
    content.text.startsWith(" ") ||
    content.text.endsWith(" ") ||
    content.text.includes("  ");
  const jubartePreserve = /^\s|\s$/u.test(content.text);
  if (legacyPreserve === jubartePreserve) {
    return { type: "text", value: content.text };
  }
  return opaque(ctx, "w:t", serializeTextContent(content));
}

function mapRunContent(ctx: ToAstContext, content: RunContent): AstDocumentElement | null {
  switch (content.type) {
    case "text":
      return mapText(ctx, content);
    case "tab":
      return { type: "tab" };
    case "break":
      // ST_BrType page/column round-trip typed; textWrapping (with its
      // `w:clear`) has no typed AST shape — carry the legacy fragment.
      if (content.breakType === "page" || content.breakType === "column") {
        return { type: "break", breakType: content.breakType };
      }
      if (content.breakType === "textWrapping") {
        return opaque(ctx, "w:br", serializeBreakContent(content));
      }
      return { type: "break", breakType: "line" };
    case "symbol":
      return opaque(ctx, "w:sym", serializeSymbolContent(content));
    case "footnoteRef":
      return { type: "noteReference", noteType: "footnote", noteId: String(content.id) };
    case "endnoteRef":
      return { type: "noteReference", noteType: "endnote", noteId: String(content.id) };
    case "fieldChar":
      // Legacy emits `w:fldLock="true"`; jubarte's typed node emits `"1"`.
      // Verbatim keeps the bytes identical.
      return opaque(ctx, "w:fldChar", serializeFieldChar(content));
    case "instrText":
      return opaque(ctx, "w:instrText", serializeInstrText(content));
    case "softHyphen":
      return { type: "softHyphen" };
    case "noBreakHyphen":
      return { type: "noBreakHyphen" };
    case "drawing":
      // The legacy run serializer replays `rawXml` when captured and rebuilds
      // the `<w:drawing>` from the typed Image model otherwise; the AST
      // drawing carrier re-emits either verbatim.
      return {
        type: "drawing",
        xml: withOpaqueTags(ctx, content.rawXml ?? serializeDrawingContent(content)),
        children: [],
      };
    case "shape":
      return opaque(ctx, "w:pict", serializeShapeContent(content));
    default:
      return null;
  }
}

function mapRun(ctx: ToAstContext, run: Run): AstRun {
  const rprXml = serializeRunProperties(run.formatting, run.propertyChanges);
  const rpr = rprXml ? fragmentToProps(rprXml) : null;
  const children: AstDocumentElement[] = [];
  for (const item of run.content) {
    const mapped = mapRunContent(ctx, item);
    if (mapped) {
      children.push(mapped);
    }
  }
  const astRun: AstRun = {
    type: "run",
    children,
    // The toggle flags mirror the rpr encoding so the writer's
    // `reconcileRunToggles` is an exact no-op and the rpr emits verbatim.
    isBold: toggleOn(rpr, "w:b"),
    isItalic: toggleOn(rpr, "w:i"),
    isUnderline: underlineOn(rpr),
    isStrikethrough: toggleOn(rpr, "w:strike"),
    isSmallCaps: false,
    isAllCaps: false,
    verticalAlignment: "baseline",
    font: null,
    fontSize: null,
    highlight: null,
  };
  if (rpr) {
    astRun.rpr = rpr;
  }
  return astRun;
}

// ============================================================================
// Paragraphs
// ============================================================================

const RUN_OPEN_RE = /<w:r(?=[\s>/])[^>]*>/u;

/**
 * Mirror of the legacy `injectRenderedPageBreakIntoFirstRun`: put a
 * `<w:lastRenderedPageBreak/>` inside the first run of the paragraph, whether
 * that run is a typed AstRun or lives inside a verbatim carrier.
 */
function injectRenderedPageBreak(children: AstDocumentElement[]): void {
  for (const child of children) {
    if (child.type === "run") {
      child.children.unshift({ type: "lastRenderedPageBreak" });
      return;
    }
    if (
      (child.type === "opaqueElement" || child.type === "drawing") &&
      RUN_OPEN_RE.test(child.xml)
    ) {
      child.xml = child.xml.replace(RUN_OPEN_RE, (match) => `${match}<w:lastRenderedPageBreak/>`);
      return;
    }
  }
}

/**
 * The `<w:pPr>` fragment exactly as the legacy `serializeParagraph` assembles
 * it: formatting + property changes + paragraph-mark change from
 * `serializeParagraphFormatting`, with the mid-document `<w:sectPr>` appended
 * inside the same container.
 */
function paragraphPPrXml(paragraph: Paragraph): string {
  const pPrXml = serializeParagraphFormatting(
    paragraph.formatting,
    paragraph.propertyChanges,
    paragraph.pPrMark,
  );
  const sectionPropertiesXml = serializeSectionProperties(paragraph.sectionProperties);
  if (!pPrXml && !sectionPropertiesXml) {
    return "";
  }
  return `<w:pPr>${extractPPrInner(pPrXml)}${sectionPropertiesXml}</w:pPr>`;
}

function mapParagraph(ctx: ToAstContext, paragraph: Paragraph): AstParagraph {
  ctx.paragraphTags.push({
    kind: "typed",
    ...(paragraph.paraId !== undefined ? { paraId: paragraph.paraId } : {}),
    ...(paragraph.textId !== undefined ? { textId: paragraph.textId } : {}),
  });

  const pprXml = paragraphPPrXml(paragraph);
  const ppr = pprXml ? fragmentToProps(pprXml) : null;

  // Comment ids whose reference run is modeled explicitly (parsed-from-Word),
  // so the matching commentRangeEnd does not double-emit it — mirrors the
  // legacy serializeParagraph.
  const explicitCommentReferenceIds = new Set<number>();
  for (const item of paragraph.content) {
    if (item.type === "commentReference") {
      explicitCommentReferenceIds.add(item.id);
    }
  }

  const children: AstDocumentElement[] = [];
  for (const item of paragraph.content) {
    switch (item.type) {
      case "run":
        children.push(mapRun(ctx, item));
        break;
      case "commentRangeStart":
        children.push({
          type: "commentRangeStart",
          commentId: String(item.id) as AstComment["commentId"],
        });
        break;
      case "commentRangeEnd":
        children.push({
          type: "commentRangeEnd",
          commentId: String(item.id) as AstComment["commentId"],
        });
        // The legacy serializer synthesizes the reference run unless the
        // model carries an explicit `commentReference` node for this id.
        if (!explicitCommentReferenceIds.has(item.id)) {
          children.push(commentReferenceRun(item.id));
        }
        break;
      case "commentReference":
        children.push(commentReferenceRun(item.id));
        break;
      default: {
        // Everything else — hyperlinks (attribute set + rId), bookmarks
        // (preserved ids), fields (expanded to fldChar runs), inline SDTs,
        // tracked-change wrappers (delText/drawing nuances), move range
        // markers, math — is emitted by the legacy dispatcher and carried
        // verbatim.
        const xml = serializeParagraphContent(item, explicitCommentReferenceIds);
        if (xml) {
          children.push(opaque(ctx, `w:${item.type}`, xml));
        }
        break;
      }
    }
  }

  if (paragraph.renderedPageBreakBefore) {
    injectRenderedPageBreak(children);
  }

  const node: AstParagraph = {
    type: "paragraph",
    children,
    indent: NULL_INDENT(),
  };
  if (ppr) {
    node.ppr = ppr;
  }
  if (paragraph.paraId) {
    node.paraId = paragraph.paraId as NonNullable<AstParagraph["paraId"]>;
  }
  return node;
}

function commentReferenceRun(id: number): AstRun {
  return {
    type: "run",
    children: [{ type: "commentReference", commentId: String(id) as AstComment["commentId"] }],
    rpr: [{ name: "w:rStyle", attrs: { "w:val": "CommentReference" } }],
    isBold: false,
    isItalic: false,
    isUnderline: false,
    isStrikethrough: false,
    isSmallCaps: false,
    isAllCaps: false,
    verticalAlignment: "baseline",
    font: null,
    fontSize: null,
    highlight: null,
  };
}

// ============================================================================
// Tables
// ============================================================================

function mapTableCell(ctx: ToAstContext, cell: TableCell): AstTableCell {
  const tcPrXml = serializeTableCellFormatting(
    cell.formatting,
    cell.propertyChanges,
    cell.structuralChange,
  );
  const tcpr = tcPrXml ? fragmentToProps(tcPrXml) : null;
  const children = modelBlocksToAstElements(cell.content, ctx);
  if (children.length === 0) {
    // The writer emits the mandatory `<w:p/>` placeholder — account for it.
    ctx.paragraphTags.push({ kind: "opaque", count: 1 });
  }
  const node: AstTableCell = {
    type: "tableCell",
    children,
    // colSpan/rowSpan stay 1 so the writer's vMerge ledger never activates:
    // the model keeps merge state per-row inside each cell's tcPr, which is
    // re-emitted verbatim — exactly the legacy layout.
    colSpan: 1,
    rowSpan: 1,
  };
  if (tcpr) {
    node.tcpr = tcpr;
  }
  return node;
}

function mapTableRow(ctx: ToAstContext, row: TableRow): AstTableRow {
  const trPrXml = serializeTableRowFormatting(
    row.formatting,
    row.propertyChanges,
    row.structuralChange,
  );
  const trpr = trPrXml ? fragmentToProps(trPrXml) : null;
  const node: AstTableRow = {
    type: "tableRow",
    children: row.cells.map((cell) => mapTableCell(ctx, cell)),
    isHeader: false,
  };
  if (trpr) {
    node.trpr = trpr;
  }
  return node;
}

function mapTable(ctx: ToAstContext, table: Table): AstTable {
  const tblPrXml = serializeTableFormatting(table.formatting, table.propertyChanges);
  const tblGridXml = serializeTableGrid(table.columnWidths);
  const node: AstTable = {
    type: "table",
    children: table.rows.map((row) => mapTableRow(ctx, row)),
    styleId: null,
    styleName: null,
  };
  const tblpr = tblPrXml ? fragmentToProps(tblPrXml) : null;
  if (tblpr) {
    node.tblpr = tblpr;
  }
  const tblgrid = tblGridXml ? fragmentToProps(tblGridXml) : null;
  if (tblgrid) {
    node.tblgrid = tblgrid;
  }
  return node;
}

// ============================================================================
// Blocks
// ============================================================================

/** Legacy block dispatcher used for block-SDT inner content (verbatim carrier). */
function serializeBlockForSdt(block: BlockContent): string {
  if (block.type === "paragraph") {
    return serializeParagraph(block);
  }
  if (block.type === "table") {
    return serializeTable(block);
  }
  return serializeBlockSdt(block, serializeBlockForSdt);
}

/**
 * Map model block content to jubarte AST elements. `ctx.paragraphTags`
 * accumulates the paragraph-tag ledger the orchestrator uses to re-stamp
 * `w14:paraId`/`w14:textId` after the writer runs.
 */
export function modelBlocksToAstElements(
  blocks: readonly BlockContent[],
  ctx: ToAstContext,
): AstDocumentElement[] {
  const out: AstDocumentElement[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      out.push(mapParagraph(ctx, block));
    } else if (block.type === "table") {
      out.push(mapTable(ctx, block));
    } else if (block.type === "blockSdt") {
      out.push(opaque(ctx, "w:sdt", serializeBlockSdt(block, serializeBlockForSdt)));
    }
  }
  return out;
}

// ============================================================================
// Comments (legacy commentSerializer semantics through jubarte's sidecars)
// ============================================================================

const ANNOTATION_REF_RUN =
  '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>';

/**
 * Comment bodies reproduce the legacy comment serializer's deliberately
 * REDUCED fidelity — text/break run content, bold/italic only — so both save
 * paths reparse to the same model. The first paragraph gets the annotationRef
 * run Word requires; paragraph paraIds are PRESERVED (folio's legacy
 * serializer writes `w14:paraId` from the model, minting deterministic ids
 * only for threaded comments via `ensureThreadedCommentParaIds`, which the
 * orchestrator runs before this mapping).
 */
function mapCommentParagraph(paragraph: Paragraph, withAnnotationRef: boolean): AstParagraph {
  const children: AstDocumentElement[] = [];
  if (withAnnotationRef) {
    children.push({ type: "opaqueElement", name: "w:r", xml: ANNOTATION_REF_RUN });
  }
  for (const item of paragraph.content) {
    if (item.type !== "run") {
      continue;
    }
    children.push(mapCommentRun(item));
  }
  if (children.length === 0) {
    // Keep the writer from substituting its `<w:r><w:t></w:t></w:r>`
    // placeholder — the legacy serializer emits a bare `<w:p>` here.
    children.push({ type: "opaqueElement", name: "w:r", xml: "" });
  }
  const node: AstParagraph = {
    type: "paragraph",
    children,
    indent: NULL_INDENT(),
  };
  if (paragraph.paraId) {
    node.paraId = paragraph.paraId as NonNullable<AstParagraph["paraId"]>;
  }
  return node;
}

function mapCommentRun(run: Run): AstRun {
  const props: AstRunProp[] = [];
  if (run.formatting?.bold) {
    props.push({ name: "w:b", attrs: {} });
  }
  if (run.formatting?.italic) {
    props.push({ name: "w:i", attrs: {} });
  }
  const children: AstDocumentElement[] = [];
  for (const item of run.content) {
    if (item.type === "text") {
      const legacyPreserve = item.text !== item.text.trim() || item.text.includes("  ");
      const jubartePreserve = /^\s|\s$/u.test(item.text);
      if (legacyPreserve === jubartePreserve) {
        children.push({ type: "text", value: item.text });
      } else {
        const xml = legacyPreserve
          ? `<w:t xml:space="preserve">${escapeXml(item.text)}</w:t>`
          : `<w:t>${escapeXml(item.text)}</w:t>`;
        children.push({ type: "opaqueElement", name: "w:t", xml });
      }
    } else if (item.type === "break") {
      children.push({ type: "break", breakType: "line" });
    }
  }
  const node: AstRun = {
    type: "run",
    children,
    isBold: Boolean(run.formatting?.bold),
    isItalic: Boolean(run.formatting?.italic),
    isUnderline: false,
    isStrikethrough: false,
    isSmallCaps: false,
    isAllCaps: false,
    verticalAlignment: "baseline",
    font: null,
    fontSize: null,
    highlight: null,
  };
  if (props.length > 0) {
    node.rpr = props;
  }
  return node;
}

/**
 * Map model comments to jubarte AstComments with folio's legacy serializer
 * semantics: top-level comments first then replies, paragraph paraIds
 * preserved (threaded anchors already minted deterministically by
 * `ensureThreadedCommentParaIds` — the orchestrator MUST run it before this),
 * threading via the LAST body paragraph's paraId, no durableIds and no UTC
 * dates (folio's legacy save writes neither commentsIds.xml nor
 * commentsExtensible.xml; the orchestrator restores those parts to their
 * original bytes afterwards).
 */
export function mapCommentsToAst(comments: readonly Comment[]): AstComment[] {
  if (comments.length === 0) {
    return [];
  }

  const topLevel: Comment[] = [];
  const replies: Comment[] = [];
  for (const comment of comments) {
    (comment.parentId === null || comment.parentId === undefined ? topLevel : replies).push(
      comment,
    );
  }
  const ordered = [...topLevel, ...replies];

  const anchorByCommentId = new Map<number, string>();
  for (const comment of ordered) {
    const anchor = comment.content.at(-1)?.paraId;
    if (anchor) {
      anchorByCommentId.set(comment.id, anchor);
    }
  }

  return ordered.map((comment) => {
    const paragraphs = comment.content;
    const body: AstDocumentElement[] = [];
    if (paragraphs.length === 0) {
      body.push(mapCommentParagraph({ type: "paragraph", content: [] }, true));
    } else {
      paragraphs.forEach((paragraph, index) => {
        body.push(mapCommentParagraph(paragraph, index === 0));
      });
    }
    const anchor = anchorByCommentId.get(comment.id) ?? null;
    const parentAnchor =
      comment.parentId !== undefined ? (anchorByCommentId.get(comment.parentId) ?? null) : null;
    return {
      type: "comment",
      commentId: String(comment.id) as AstComment["commentId"],
      body,
      authorName: comment.author ?? "",
      authorInitials: comment.initials ?? null,
      date: (comment.date ?? null) as AstComment["date"],
      dateUtc: null,
      paraId: anchor as AstComment["paraId"],
      parentParaId: parentAnchor as AstComment["parentParaId"],
      durableId: null,
      done: comment.done ?? false,
    };
  });
}

// ============================================================================
// Footnotes / endnotes
// ============================================================================

export type MappedNotes = {
  notes: AstNote[];
  /**
   * Per-note paragraph-tag ledgers keyed `${noteType}:${noteId}` — used to
   * re-stamp paraIds inside the regenerated footnotes/endnotes parts.
   */
  ledgers: Map<string, ParagraphTagExpectation[]>;
};

/**
 * Map content notes (separators stay byte-preserved inside the part by
 * jubarte's sidecar writer, mirroring the legacy separator-first ordering;
 * `continuationNotice` separators the writer drops are spliced back by the
 * orchestrator from the ORIGINAL part bytes — folio's model retains only
 * normal notes). Note bodies use the FULL block mapper — matching the legacy
 * note serializer, which reuses the document body serializers.
 */
export function mapNotesToAst(
  footnotes: readonly Footnote[],
  endnotes: readonly Endnote[],
): MappedNotes {
  const notes: AstNote[] = [];
  const ledgers = new Map<string, ParagraphTagExpectation[]>();
  const add = (noteType: "footnote" | "endnote", list: readonly (Footnote | Endnote)[]) => {
    for (const note of list) {
      const ctx = createToAstContext();
      const body = modelBlocksToAstElements(note.content as BlockContent[], ctx);
      notes.push({ type: "note", noteType, noteId: String(note.id), body });
      ledgers.set(`${noteType}:${note.id}`, ctx.paragraphTags);
    }
  };
  add("footnote", footnotes);
  add("endnote", endnotes);
  return { notes, ledgers };
}
