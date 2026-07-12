/**
 * Jubarte AST → folio XmlElement reconstruction.
 *
 * The core's legacy parsers (paragraphParser/runParser/tableParser/…)
 * consume `XmlElement` trees. This module rebuilds, for each typed jubarte
 * AST node, the `XmlElement` the legacy parser would have received from
 * `parseXml(document.xml)`:
 *
 * - structure (element order, nesting) comes from the typed AST nodes;
 * - property containers (`w:pPr`/`w:rPr`/`w:tblPr`/`w:tblGrid`/`w:trPr`/
 *   `w:tcPr`) come from jubarte's raw property trees via {@link ../propShim};
 * - verbatim-XML carriers (drawing/pict, mc:AlternateContent, OMML math,
 *   opaque elements, `w:sdtPr`) are parsed with folio's xmlParser, with the
 *   namespace declarations jubarte injects onto captured fragments stripped
 *   back off so byte captures (`rawXml`, `ommlXml`, `rawPropertiesXml`)
 *   match what the legacy parser captured from the original part.
 *
 * Jubarte collapses vertical merges (anchor `rowSpan` + stashed
 * continuation cells); {@link reconstructTable} re-expands them into the
 * per-row `w:tc` layout the legacy tableParser expects.
 */

import type { RelationshipMap } from "../../types/document";
import { RELATIONSHIP_TYPES } from "../relsParser";
import { getAttribute, parseXml } from "../xmlParser";
import type { XmlElement } from "../xmlParser";
import { astPropsToContainerElement } from "./propShim";
import type {
  AstDocumentElement,
  AstHyperlink,
  AstParagraph,
  AstRun,
  AstSdt,
  AstTable,
  AstTableCell,
} from "./types";

export type ReconstructContext = {
  /** Relationship map of the part being reconstructed (hyperlink rId recovery). */
  rels: RelationshipMap;
  /** Root `xmlns` declarations of the source part (injected-decl stripping). */
  rootXmlns: Record<string, string>;
  /** Attribute recovery scanned from the byte-preserved part text. */
  recovery?: PartAttributeRecovery;
  warnings: string[];
};

/**
 * Attributes jubarte's AST drops but folio's model surfaces, recovered from
 * the byte-preserved part text via stable-id joins (never by position):
 * `w14:textId` keyed by the paragraph's unique `w14:paraId`, and hyperlink
 * `w:tooltip`/`w:history`/`w:docLocation` keyed by `r:id`. Values are the
 * literal source attribute strings, so the legacy interpreters apply their
 * own semantics unchanged.
 */
export type PartAttributeRecovery = {
  textIdByParaId: Map<string, string>;
  hyperlinkAttrsByRId: Map<string, Record<string, string>>;
};

/** Attribute-aware open-tag matcher: quoted values may contain `>` or `/`. */
const openTagRe = (localName: string): RegExp =>
  new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}(\\s(?:[^>"]|"[^"]*")*)?/?>`, "gu");

function parseTagAttributes(attrText: string): XmlElement | null {
  try {
    const parsed = parseXml(`<x${attrText}/>`);
    return parsed.elements?.find((el) => el.type === "element") ?? null;
  } catch {
    return null;
  }
}

/** Scan a part's text for the recoverable attribute joins. */
export function scanPartAttributeRecovery(partXml: string | null): PartAttributeRecovery {
  const textIdByParaId = new Map<string, string>();
  const hyperlinkAttrsByRId = new Map<string, Record<string, string>>();
  if (!partXml) {
    return { textIdByParaId, hyperlinkAttrsByRId };
  }

  if (partXml.includes("textId")) {
    for (const match of partXml.matchAll(openTagRe("p"))) {
      const attrText = match[1];
      if (!attrText || !attrText.includes("textId")) {
        continue;
      }
      const el = parseTagAttributes(attrText);
      const paraId = getAttribute(el, "w14", "paraId") ?? getAttribute(el, "w", "paraId");
      const textId = getAttribute(el, "w14", "textId") ?? getAttribute(el, "w", "textId");
      if (paraId && textId && !textIdByParaId.has(paraId)) {
        textIdByParaId.set(paraId, textId);
      }
    }
  }

  for (const match of partXml.matchAll(openTagRe("hyperlink"))) {
    const attrText = match[1];
    if (!attrText) {
      continue;
    }
    const el = parseTagAttributes(attrText);
    const rId = getAttribute(el, "r", "id");
    if (!rId || hyperlinkAttrsByRId.has(rId)) {
      continue;
    }
    const extra: Record<string, string> = {};
    const tooltip = getAttribute(el, "w", "tooltip");
    if (tooltip !== null) {
      extra["w:tooltip"] = tooltip;
    }
    const history = getAttribute(el, "w", "history");
    if (history !== null) {
      extra["w:history"] = history;
    }
    const docLocation = getAttribute(el, "w", "docLocation");
    if (docLocation !== null) {
      extra["w:docLocation"] = docLocation;
    }
    if (Object.keys(extra).length > 0) {
      hyperlinkAttrsByRId.set(rId, extra);
    }
  }

  return { textIdByParaId, hyperlinkAttrsByRId };
}

/**
 * Namespace URIs jubarte's reader injects onto captured verbatim fragments
 * (`AstDrawing.xml`, `AstOpaqueElement.xml`, …) so they stay self-contained.
 * The source elements did not carry these declarations (they live on the
 * part root), so reconstruction strips them again — otherwise byte captures
 * like `DrawingContent.rawXml` diverge from the legacy parser's.
 */
const JUBARTE_INJECTED_XMLNS_URIS = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://schemas.openxmlformats.org/drawingml/2006/picture",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingInk",
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
  "urn:schemas-microsoft-com:vml",
  "urn:schemas-microsoft-com:office:office",
]);

/** Reconstruct a list of AST nodes into XmlElements (order preserved). */
export function astElementsToXml(
  nodes: readonly AstDocumentElement[],
  ctx: ReconstructContext,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of nodes) {
    const el = astElementToXml(node, ctx);
    if (el !== null) {
      out.push(el);
    }
  }
  return out;
}

function element(
  name: string,
  attributes?: Record<string, string | undefined>,
  elements?: XmlElement[],
): XmlElement {
  const el: XmlElement = { type: "element", name };
  if (attributes) {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        clean[key] = value;
      }
    }
    if (Object.keys(clean).length > 0) {
      el.attributes = clean;
    }
  }
  if (elements && elements.length > 0) {
    el.elements = elements;
  }
  return el;
}

function textElement(name: string, value: string): XmlElement {
  const el: XmlElement = { type: "element", name };
  const attrs: Record<string, string> = {};
  if (value !== value.trim()) {
    // The legacy parser reads xml:space off the source attribute; jubarte
    // does not surface it, so infer it from edge whitespace (the condition
    // under which Word writes the attribute).
    attrs["xml:space"] = "preserve";
  }
  if (Object.keys(attrs).length > 0) {
    el.attributes = attrs;
  }
  if (value.length > 0) {
    el.elements = [{ type: "text", text: value }];
  }
  return el;
}

/** Parse a verbatim jubarte carrier fragment and strip injected xmlns decls. */
export function parseCarrierElement(xml: string, ctx: ReconstructContext): XmlElement | null {
  let parsed: XmlElement;
  try {
    parsed = parseXml(xml);
  } catch {
    ctx.warnings.push("jubarte adapter: failed to parse preserved XML fragment");
    return null;
  }
  const root = parsed.elements?.find((el) => el.type === "element");
  if (!root) {
    return null;
  }
  stripInjectedXmlns(root, ctx);
  return root;
}

function stripInjectedXmlns(el: XmlElement, ctx: ReconstructContext): void {
  const attrs = el.attributes;
  if (!attrs) {
    return;
  }
  const kept: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) {
      const stringValue = value === undefined ? "" : String(value);
      if (ctx.rootXmlns[key] === stringValue || JUBARTE_INJECTED_XMLNS_URIS.has(stringValue)) {
        continue;
      }
    }
    kept[key] = value;
  }
  if (Object.keys(kept).length === 0) {
    delete el.attributes;
  } else {
    el.attributes = kept;
  }
}

function trackedChangeAttrs(node: {
  changeId?: string | null;
  author?: string | null;
  date?: string | null;
}): Record<string, string | undefined> {
  return {
    "w:id": node.changeId ?? undefined,
    "w:author": node.author ?? undefined,
    "w:date": node.date ?? undefined,
  };
}

function onOffAttr(value: boolean | undefined): string | undefined {
  return value ? "1" : undefined;
}

/** Reconstruct one AST node. Returns null for nodes with no XML equivalent. */
export function astElementToXml(
  node: AstDocumentElement,
  ctx: ReconstructContext,
): XmlElement | null {
  switch (node.type) {
    case "paragraph":
      return reconstructParagraph(node, ctx);
    case "run":
      return reconstructRun(node, ctx);
    case "text":
      return textElement("w:t", node.value);
    case "tab":
      return element("w:tab");
    case "break": {
      let type: string | undefined;
      if (node.breakType === "page" || node.breakType === "column") {
        type = node.breakType;
      }
      return element("w:br", { "w:type": type });
    }
    case "softHyphen":
      return element("w:softHyphen");
    case "noBreakHyphen":
      return element("w:noBreakHyphen");
    case "lastRenderedPageBreak":
      return element("w:lastRenderedPageBreak");
    case "fieldChar":
      return element("w:fldChar", {
        "w:fldCharType": node.fieldCharType,
        "w:fldLock": onOffAttr(node.fieldLock),
        "w:dirty": onOffAttr(node.dirty),
      });
    case "fieldInstruction": {
      const name = node.deleted ? "w:delInstrText" : "w:instrText";
      return textElement(name, node.value);
    }
    case "simpleField":
      return element(
        "w:fldSimple",
        {
          "w:instr": node.instruction,
          "w:fldLock": onOffAttr(node.fieldLock),
          "w:dirty": onOffAttr(node.dirty),
        },
        astElementsToXml(node.children, ctx),
      );
    case "hyperlink":
      return reconstructHyperlink(node, ctx);
    case "bookmarkStart":
      return element("w:bookmarkStart", {
        "w:id": node.bookmarkId,
        "w:name": node.name,
      });
    case "bookmarkEnd":
      return element("w:bookmarkEnd", { "w:id": node.bookmarkId });
    case "commentRangeStart":
      return element("w:commentRangeStart", { "w:id": node.commentId });
    case "commentRangeEnd":
      return element("w:commentRangeEnd", { "w:id": node.commentId });
    case "commentReference":
      return element("w:commentReference", { "w:id": node.commentId });
    case "noteReference": {
      const name = node.noteType === "footnote" ? "w:footnoteReference" : "w:endnoteReference";
      return element(name, { "w:id": node.noteId });
    }
    case "inserted":
      return element("w:ins", trackedChangeAttrs(node), astElementsToXml(node.children, ctx));
    case "deleted":
      return element("w:del", trackedChangeAttrs(node), astElementsToXml(node.children, ctx));
    case "moveFrom":
      return element(
        "w:moveFrom",
        { ...trackedChangeAttrs(node), "w:name": node.moveName },
        astElementsToXml(node.children, ctx),
      );
    case "moveTo":
      return element(
        "w:moveTo",
        { ...trackedChangeAttrs(node), "w:name": node.moveName },
        astElementsToXml(node.children, ctx),
      );
    case "moveRangeStart": {
      const name = node.kind === "moveFrom" ? "w:moveFromRangeStart" : "w:moveToRangeStart";
      return element(name, {
        "w:id": node.changeId ?? undefined,
        "w:name": node.moveName ?? undefined,
        "w:author": node.author ?? undefined,
        "w:date": node.date ?? undefined,
      });
    }
    case "moveRangeEnd": {
      const name = node.kind === "moveFrom" ? "w:moveFromRangeEnd" : "w:moveToRangeEnd";
      return element(name, { "w:id": node.changeId ?? undefined });
    }
    case "customXmlRangeStart": {
      const name = `w:customXml${customXmlKindName(node.kind)}RangeStart`;
      return element(name, trackedChangeAttrs(node));
    }
    case "customXmlRangeEnd": {
      const name = `w:customXml${customXmlKindName(node.kind)}RangeEnd`;
      return element(name, { "w:id": node.changeId ?? undefined });
    }
    case "drawing":
    case "alternateContent":
    case "mathBlock":
      return parseCarrierElement(node.xml, ctx);
    case "opaqueElement":
      return parseCarrierElement(node.xml, ctx);
    case "sdt":
      return reconstructSdt(node, ctx);
    case "smartTag":
      return element(
        "w:smartTag",
        {
          "w:uri": node.uri ?? undefined,
          "w:element": node.element ?? undefined,
        },
        astElementsToXml(node.children, ctx),
      );
    case "table":
      return reconstructTable(node, ctx);
    case "tableRow":
      // Rows are reconstructed by reconstructTable (vMerge re-expansion needs
      // whole-table context); a stray row outside a table has no equivalent.
      return null;
    case "tableCell":
      return reconstructCell(node, ctx);
    case "checkbox":
      // The reader (dist 0.4.0+) keeps the checkbox control's <w:sdt>
      // wrapper as an AstSdt but replaces the glyph text inside the content
      // run with this node. The raw glyph (and its trailing space, if any)
      // is only recoverable through the paired walk; the fallback emits the
      // standard Word glyph for the checked state.
      return textElement("w:t", node.checked ? "\u2612" : "\u2610");
    case "image":
      // Images only occur inside drawing carriers, which are reconstructed
      // verbatim; a standalone image node has no faithful XML equivalent.
      return null;
    case "note":
    case "comment":
      return null;
    default:
      return null;
  }
}

function customXmlKindName(kind: "ins" | "del" | "moveFrom" | "moveTo"): string {
  switch (kind) {
    case "ins":
      return "Ins";
    case "del":
      return "Del";
    case "moveFrom":
      return "MoveFrom";
    case "moveTo":
      return "MoveTo";
  }
}

function reconstructParagraph(node: AstParagraph, ctx: ReconstructContext): XmlElement {
  const children: XmlElement[] = [];
  const pPr = astPropsToContainerElement("w:pPr", node.ppr);
  if (pPr) {
    children.push(pPr);
  }
  children.push(...astElementsToXml(node.children, ctx));
  const textId = node.paraId ? ctx.recovery?.textIdByParaId.get(node.paraId) : undefined;
  return element(
    "w:p",
    { "w14:paraId": node.paraId ?? undefined, "w14:textId": textId },
    children,
  );
}

function reconstructRun(node: AstRun, ctx: ReconstructContext): XmlElement {
  const children: XmlElement[] = [];
  const rPr = astPropsToContainerElement("w:rPr", node.rpr);
  if (rPr) {
    children.push(rPr);
  }
  children.push(...astElementsToXml(node.children, ctx));
  return element("w:r", undefined, children);
}

function reconstructHyperlink(node: AstHyperlink, ctx: ReconstructContext): XmlElement {
  // Jubarte resolves the relationship and keeps only the target URL; recover
  // the r:id by reverse lookup so the legacy hyperlink parser (which stores
  // the rId and re-resolves the target itself) sees the original attribute.
  let rId: string | undefined;
  if (node.href !== undefined) {
    for (const [id, rel] of ctx.rels) {
      if (rel.type === RELATIONSHIP_TYPES.hyperlink && rel.target === node.href) {
        rId = id;
        break;
      }
    }
  }
  const recovered = rId ? ctx.recovery?.hyperlinkAttrsByRId.get(rId) : undefined;
  return element(
    "w:hyperlink",
    {
      "r:id": rId,
      ...recovered,
      "w:anchor": node.anchor,
      "w:tgtFrame": node.targetFrame ?? undefined,
    },
    astElementsToXml(node.children, ctx),
  );
}

function reconstructSdt(node: AstSdt, ctx: ReconstructContext): XmlElement {
  const children: XmlElement[] = [];
  const sdtPr = node.sdtPrXml
    ? parseCarrierElement(node.sdtPrXml, ctx)
    : synthesizeSdtPr(node);
  if (sdtPr) {
    children.push(sdtPr);
  }
  children.push(element("w:sdtContent", undefined, astElementsToXml(node.children, ctx)));
  return element("w:sdt", undefined, children);
}

/**
 * Rebuild `<w:sdtPr>` from the typed fields for the (rare) controls whose
 * sdtPr carried only modeled children, so jubarte kept no verbatim capture.
 */
function synthesizeSdtPr(node: AstSdt): XmlElement | null {
  const children: XmlElement[] = [];
  if (node.alias !== null) {
    children.push(element("w:alias", { "w:val": node.alias }));
  }
  if (node.tag !== null) {
    children.push(element("w:tag", { "w:val": node.tag }));
  }
  if (node.lock !== null) {
    children.push(element("w:lock", { "w:val": node.lock }));
  }
  if (node.showingPlcHdr) {
    children.push(element("w:showingPlcHdr"));
  }
  if (children.length === 0) {
    return null;
  }
  return element("w:sdtPr", undefined, children);
}

// ============================================================================
// TABLES (vertical-merge re-expansion)
// ============================================================================

type ScheduledCell = {
  gridCol: number;
  span: number;
  el: XmlElement;
};

function reconstructTable(node: AstTable, ctx: ReconstructContext): XmlElement {
  const children: XmlElement[] = [];
  const tblPr = astPropsToContainerElement("w:tblPr", node.tblpr);
  if (tblPr) {
    children.push(tblPr);
  }
  const tblGrid = astPropsToContainerElement("w:tblGrid", node.tblgrid);
  if (tblGrid) {
    children.push(tblGrid);
  }

  // Jubarte models a vertical merge as `rowSpan` on the anchor cell and
  // removes the continuation cells from their rows (stashing their content
  // on the anchor). The legacy tableParser expects the flat per-row layout,
  // so re-insert one continuation `w:tc` per spanned row at the anchor's
  // grid column.
  const insertions = new Map<number, ScheduledCell[]>();
  let rowIndex = -1;
  for (const child of node.children) {
    if (child.type !== "tableRow") {
      const el = astElementToXml(child, ctx);
      if (el) {
        children.push(el);
      }
      continue;
    }
    rowIndex += 1;

    const rowChildren: XmlElement[] = [];
    const trPr = astPropsToContainerElement("w:trPr", child.trpr);
    if (trPr) {
      rowChildren.push(trPr);
    }

    const scheduled = (insertions.get(rowIndex) ?? []).toSorted((a, b) => a.gridCol - b.gridCol);
    let scheduledIdx = 0;
    let gridCol = 0;

    for (const rowChild of child.children) {
      if (rowChild.type !== "tableCell") {
        const el = astElementToXml(rowChild, ctx);
        if (el) {
          rowChildren.push(el);
        }
        continue;
      }
      // Continuation cells scheduled at or before this grid column go first.
      while (scheduledIdx < scheduled.length) {
        const pending = scheduled[scheduledIdx];
        if (!pending || pending.gridCol > gridCol) {
          break;
        }
        rowChildren.push(pending.el);
        gridCol += pending.span;
        scheduledIdx += 1;
      }

      const span = rowChild.colSpan > 0 ? rowChild.colSpan : 1;
      const continuations = rowChild.vMergeContinuationCells ?? [];
      const anchorRow = rowIndex;
      const anchorGridCol = gridCol;
      for (const [index, continuation] of continuations.entries()) {
        const targetRow = anchorRow + 1 + index;
        const list = insertions.get(targetRow) ?? [];
        list.push({
          gridCol: anchorGridCol,
          span,
          el: reconstructContinuationCell(continuation, ctx),
        });
        insertions.set(targetRow, list);
      }

      rowChildren.push(reconstructCell(rowChild, ctx));
      gridCol += span;
    }

    while (scheduledIdx < scheduled.length) {
      const pending = scheduled[scheduledIdx];
      if (!pending) {
        break;
      }
      rowChildren.push(pending.el);
      gridCol += pending.span;
      scheduledIdx += 1;
    }

    children.push(element("w:tr", undefined, rowChildren));
  }

  return element("w:tbl", undefined, children);
}

function reconstructCell(node: AstTableCell, ctx: ReconstructContext): XmlElement {
  const children: XmlElement[] = [];
  const tcPr = astPropsToContainerElement("w:tcPr", node.tcpr);
  if (tcPr) {
    children.push(tcPr);
  }
  children.push(...astElementsToXml(node.children, ctx));
  return element("w:tc", undefined, children);
}

function reconstructContinuationCell(
  continuation: NonNullable<AstTableCell["vMergeContinuationCells"]>[number],
  ctx: ReconstructContext,
): XmlElement {
  const children: XmlElement[] = [];
  const tcPr = continuation.tcpr
    ? astPropsToContainerElement("w:tcPr", continuation.tcpr)
    : element("w:tcPr", undefined, [element("w:vMerge")]);
  if (tcPr) {
    children.push(tcPr);
  }
  children.push(...astElementsToXml(continuation.children, ctx));
  return element("w:tc", undefined, children);
}
