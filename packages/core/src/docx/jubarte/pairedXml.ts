/**
 * Paired AST ⇄ raw-part reconstruction.
 *
 * Jubarte's typed AST normalizes away source details folio's legacy model
 * preserves (xml:space on w:t, w14:textId, the full hyperlink attribute set,
 * w:br clear, w:sym, byte-exact w:sdtPr, sdt sibling range markers) and it
 * flattens a few wrappers entirely (inline w:moveFrom/w:moveTo — Word never
 * writes the w:name jubarte requires on them; attribute-less w:hyperlink;
 * checkbox / sdtPr-less / self-closing w:sdt). The byte-preserved part text
 * is authoritative for all of it.
 *
 * This module walks the PARSED raw part (folio's xmlParser over the
 * byte-preserved text) as a spine, in lockstep with the jubarte AST: every
 * raw child must be claimed by the AST node stream (kind-verified; texts are
 * value-verified), so the AST still fully "explains" the document. Leaf
 * content nodes are emitted from the raw tree (recovering the dropped
 * attributes); property containers (pPr/rPr/tblPr/…) come from jubarte's
 * property trees via the propShim, per the mapping mandate; wrapper shells
 * take the raw element's name+attributes with recursively paired children;
 * the known reader-flattened constructs are re-lifted from the raw subtree
 * with claim accounting. Any divergence the walk cannot explain raises
 * {@link PairingBail} and the affected container falls back to the pure-AST
 * reconstruction in {@link ./astToXml} — degrading recovery, never
 * mis-assigning it.
 */

import { getAttribute, getChildElements, getLocalName, getTextContent } from "../xmlParser";
import type { XmlElement } from "../xmlParser";
import { astElementsToXml, astElementToXml } from "./astToXml";
import type { ReconstructContext } from "./astToXml";
import { astPropsToContainerElement } from "./propShim";
import type {
  AstDocumentElement,
  AstParagraph,
  AstRun,
  AstTable,
  AstTableCell,
} from "./types";

/** Raised when the raw spine cannot be explained by the AST stream. */
class PairingBail extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PairingBail";
  }
}

/** Raw child kinds that produce no AST node and are invisible to legacy parsing. */
const RAW_INVISIBLE = new Set(["proofErr", "permStart", "permEnd"]);

function bail(reason: string): never {
  throw new PairingBail(reason);
}

function shell(raw: XmlElement, children: XmlElement[]): XmlElement {
  const el: XmlElement = { type: "element", name: raw.name ?? "" };
  if (raw.attributes && Object.keys(raw.attributes).length > 0) {
    el.attributes = { ...raw.attributes };
  }
  if (children.length > 0) {
    el.elements = children;
  }
  return el;
}

/**
 * Stream of AST nodes being claimed by the raw spine. A single stream is
 * shared across wrapper recursion within one container (hoisted-wrapper
 * children live in the parent's AST child list).
 */
class AstStream {
  private index = 0;
  private readonly nodes: readonly AstDocumentElement[];

  constructor(nodes: readonly AstDocumentElement[]) {
    this.nodes = nodes;
  }

  peek(): AstDocumentElement | undefined {
    return this.nodes[this.index];
  }

  /** Claim the next AST node, verifying its kind. */
  claim(expected: string | readonly string[]): AstDocumentElement {
    const node = this.nodes[this.index];
    if (!node) {
      bail(`raw element expected AST ${String(expected)} but stream is exhausted`);
    }
    const kinds = typeof expected === "string" ? [expected] : expected;
    if (!kinds.includes(node.type)) {
      bail(`raw element expected AST ${kinds.join("|")} but found ${node.type}`);
    }
    this.index += 1;
    return node;
  }

  finish(): void {
    if (this.index !== this.nodes.length) {
      bail(`AST stream has ${this.nodes.length - this.index} unclaimed node(s)`);
    }
  }
}

// ============================================================================
// BLOCK-LEVEL PAIRING (body, sdtContent at block level, table cells, HF root)
// ============================================================================

/**
 * Pair a block container's raw children with its AST children. Returns the
 * reconstructed XmlElements, or null when pairing bailed (caller falls back
 * to the pure-AST reconstruction).
 */
export function pairedBlockChildren(
  nodes: readonly AstDocumentElement[],
  rawContainer: XmlElement,
  ctx: ReconstructContext,
): XmlElement[] | null {
  try {
    const stream = new AstStream(nodes);
    const out = pairBlockList(getChildElements(rawContainer), stream, ctx);
    stream.finish();
    return out;
  } catch (error) {
    if (error instanceof PairingBail) {
      warnBailOnce(ctx, error.message);
      return null;
    }
    throw error;
  }
}

function warnBailOnce(ctx: ReconstructContext, reason: string): void {
  const message = `jubarte adapter: raw-part pairing diverged (${reason}); source recovery disabled for that container`;
  if (!ctx.warnings.includes(message)) {
    ctx.warnings.push(message);
  }
}

function pairBlockList(
  rawKids: readonly XmlElement[],
  stream: AstStream,
  ctx: ReconstructContext,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const rawKid of rawKids) {
    const local = getLocalName(rawKid.name ?? "");
    if (RAW_INVISIBLE.has(local)) {
      continue;
    }
    switch (local) {
      case "p": {
        const node = stream.claim("paragraph");
        if (node.type !== "paragraph") {
          bail("unreachable");
        }
        out.push(pairedParagraph(node, rawKid, ctx));
        break;
      }
      case "tbl": {
        const node = stream.claim("table");
        if (node.type !== "table") {
          bail("unreachable");
        }
        out.push(pairedTable(node, rawKid, ctx));
        break;
      }
      case "sdt": {
        out.push(pairSdt(rawKid, stream, ctx, "block"));
        break;
      }
      case "sectPr": {
        // Body-level sectPr: the trailing one has no AST node (recovered by
        // the orchestrator from part text); a non-trailing one surfaces as
        // an opaque carrier. Either way the raw element is authoritative.
        if (stream.peek()?.type === "opaqueElement") {
          stream.claim("opaqueElement");
        }
        out.push(rawKid);
        break;
      }
      case "oMath":
      case "oMathPara": {
        // Block-level math: legacy block parsing ignores it; jubarte
        // surfaces a mathBlock node.
        if (stream.peek()?.type === "mathBlock") {
          stream.claim("mathBlock");
        }
        out.push(rawKid);
        break;
      }
      case "bookmarkStart": {
        const node = stream.claim("bookmarkStart");
        out.push(astElementToXml(node, ctx) ?? rawKid);
        break;
      }
      case "bookmarkEnd": {
        const node = stream.claim("bookmarkEnd");
        out.push(astElementToXml(node, ctx) ?? rawKid);
        break;
      }
      case "commentRangeStart":
      case "commentRangeEnd":
      case "moveFromRangeStart":
      case "moveFromRangeEnd":
      case "moveToRangeStart":
      case "moveToRangeEnd": {
        const kindMap: Record<string, string> = {
          commentRangeStart: "commentRangeStart",
          commentRangeEnd: "commentRangeEnd",
          moveFromRangeStart: "moveRangeStart",
          moveFromRangeEnd: "moveRangeEnd",
          moveToRangeStart: "moveRangeStart",
          moveToRangeEnd: "moveRangeEnd",
        };
        const node = stream.claim(kindMap[local] as string);
        out.push(astElementToXml(node, ctx) ?? rawKid);
        break;
      }
      default:
        bail(`unexpected block-level raw element ${local}`);
    }
  }
  return out;
}

// ============================================================================
// SDT PAIRING (shared by block + inline levels)
// ============================================================================

/**
 * Pair one raw `<w:sdt>` element. When jubarte kept the AstSdt, the shell,
 * verbatim sdtPr/sdtEndPr, and any sibling range markers come from the raw
 * element while the content children pair recursively. When the reader
 * dropped or unwrapped the sdt (self-closing, sdtPr-less, checkbox), the raw
 * subtree is lifted verbatim and the hoisted AST children are claimed
 * without being used.
 */
function pairSdt(
  rawSdt: XmlElement,
  stream: AstStream,
  ctx: ReconstructContext,
  level: "block" | "inline",
): XmlElement {
  if (stream.peek()?.type === "sdt") {
    const node = stream.claim("sdt");
    if (node.type !== "sdt") {
      bail("unreachable");
    }
    const children: XmlElement[] = [];
    for (const rawChild of getChildElements(rawSdt)) {
      const childLocal = getLocalName(rawChild.name ?? "");
      if (childLocal === "sdtContent") {
        const contentStream = new AstStream(node.children);
        const paired =
          level === "block"
            ? pairBlockList(getChildElements(rawChild), contentStream, ctx)
            : pairInlineList(getChildElements(rawChild), contentStream, ctx);
        contentStream.finish();
        children.push(shell(rawChild, paired));
        continue;
      }
      // sdtPr, sdtEndPr, and MS-OE376 sibling range markers: verbatim.
      children.push(rawChild);
    }
    return shell(rawSdt, children);
  }

  // Reader-flattened sdt: claim whatever the AST carries in its place.
  const rawContent = findRawChild(rawSdt, "sdtContent");
  if (rawContent) {
    const isCheckbox = sdtHasCheckbox(rawSdt);
    if (isCheckbox) {
      // The whole control collapsed to a single run carrying a checkbox node.
      const node = stream.claim("run");
      if (node.type !== "run" || !node.children.some((child) => child.type === "checkbox")) {
        bail("checkbox sdt paired with a run that has no checkbox node");
      }
    } else {
      // Unwrapped sdt: its content children were hoisted into the parent.
      claimHoistedSdtContent(rawContent, stream, level);
    }
  }
  // Self-closing / empty sdt: nothing to claim.
  return rawSdt;
}

function findRawChild(el: XmlElement, localName: string): XmlElement | null {
  for (const child of getChildElements(el)) {
    if (getLocalName(child.name ?? "") === localName) {
      return child;
    }
  }
  return null;
}

function sdtHasCheckbox(rawSdt: XmlElement): boolean {
  const sdtPr = findRawChild(rawSdt, "sdtPr");
  if (!sdtPr) {
    return false;
  }
  return getChildElements(sdtPr).some((child) => getLocalName(child.name ?? "") === "checkbox");
}

/** Claim the AST nodes an unwrapped sdt's content contributed to the parent. */
function claimHoistedSdtContent(
  rawContent: XmlElement,
  stream: AstStream,
  level: "block" | "inline",
): void {
  for (const rawChild of getChildElements(rawContent)) {
    const local = getLocalName(rawChild.name ?? "");
    if (RAW_INVISIBLE.has(local)) {
      continue;
    }
    if (level === "block") {
      if (local === "p") {
        stream.claim("paragraph");
      } else if (local === "tbl") {
        stream.claim("table");
      } else if (local === "sdt") {
        pairSdt(rawChild, stream, /* ctx not needed for claims */ CLAIM_ONLY_CTX, level);
      } else {
        bail(`unwrapped sdt content has unexpected block child ${local}`);
      }
      continue;
    }
    claimInlineRaw(rawChild, stream);
  }
}

/**
 * Claim-only context for lifted subtrees (their reconstruction is the raw
 * element itself, so interpretation inputs are never consulted).
 */
const CLAIM_ONLY_CTX: ReconstructContext = {
  rels: new Map(),
  rootXmlns: {},
  warnings: [],
};

/** Claim the AST node(s) one raw inline child contributed, without output. */
function claimInlineRaw(rawKid: XmlElement, stream: AstStream): void {
  const local = getLocalName(rawKid.name ?? "");
  if (RAW_INVISIBLE.has(local)) {
    return;
  }
  const INLINE_CLAIM: Record<string, string | readonly string[]> = {
    r: "run",
    hyperlink: "hyperlink",
    bookmarkStart: "bookmarkStart",
    bookmarkEnd: "bookmarkEnd",
    commentRangeStart: "commentRangeStart",
    commentRangeEnd: "commentRangeEnd",
    ins: "inserted",
    del: "deleted",
    fldSimple: "simpleField",
    oMath: "mathBlock",
    oMathPara: "mathBlock",
    moveFromRangeStart: "moveRangeStart",
    moveFromRangeEnd: "moveRangeEnd",
    moveToRangeStart: "moveRangeStart",
    moveToRangeEnd: "moveRangeEnd",
    lastRenderedPageBreak: "lastRenderedPageBreak",
  };
  if (local === "sdt") {
    pairSdt(rawKid, stream, CLAIM_ONLY_CTX, "inline");
    return;
  }
  if (local === "smartTag") {
    stream.claim("smartTag");
    return;
  }
  if (local === "moveFrom" || local === "moveTo") {
    if (stream.peek()?.type === local) {
      stream.claim(local);
      return;
    }
    for (const inner of getChildElements(rawKid)) {
      claimInlineRaw(inner, stream);
    }
    return;
  }
  const expected = INLINE_CLAIM[local];
  if (!expected) {
    bail(`unexpected inline raw element ${local}`);
  }
  stream.claim(expected);
}

// ============================================================================
// PARAGRAPH PAIRING
// ============================================================================

/** Reconstruct a paragraph paired with its raw `w:p` element. */
export function pairedParagraph(
  node: AstParagraph,
  rawParagraph: XmlElement,
  ctx: ReconstructContext,
): XmlElement {
  // Verify the pairing before trusting raw attributes.
  const rawParaId =
    getAttribute(rawParagraph, "w14", "paraId") ?? getAttribute(rawParagraph, "w", "paraId");
  if (node.paraId && rawParaId && node.paraId !== rawParaId) {
    warnBailOnce(ctx, `paragraph paraId mismatch (${node.paraId} vs ${rawParaId})`);
    return astElementToXml(node, ctx) ?? shell(rawParagraph, []);
  }

  let children: XmlElement[] | null = null;
  try {
    const stream = new AstStream(node.children);
    children = pairInlineList(contentChildren(rawParagraph), stream, ctx);
    stream.finish();
  } catch (error) {
    if (!(error instanceof PairingBail)) {
      throw error;
    }
    warnBailOnce(ctx, error.message);
    children = null;
  }

  if (children === null) {
    // Fallback: pure-AST paragraph, still keeping the raw attributes.
    const fallback = astElementToXml(node, ctx);
    if (fallback && rawParagraph.attributes) {
      fallback.attributes = { ...rawParagraph.attributes };
    }
    return fallback ?? shell(rawParagraph, []);
  }

  const pPr = astPropsToContainerElement("w:pPr", node.ppr);
  const el: XmlElement = { type: "element", name: rawParagraph.name ?? "w:p" };
  if (rawParagraph.attributes && Object.keys(rawParagraph.attributes).length > 0) {
    el.attributes = { ...rawParagraph.attributes };
  }
  const allChildren = pPr ? [pPr, ...children] : children;
  if (allChildren.length > 0) {
    el.elements = allChildren;
  }
  return el;
}

/** Raw paragraph/wrapper/cell children minus the property containers. */
function contentChildren(raw: XmlElement): XmlElement[] {
  return getChildElements(raw).filter((child) => {
    const local = getLocalName(child.name ?? "");
    return local !== "pPr" && local !== "rPr" && local !== "tcPr";
  });
}

function pairInlineList(
  rawKids: readonly XmlElement[],
  stream: AstStream,
  ctx: ReconstructContext,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const rawKid of rawKids) {
    const local = getLocalName(rawKid.name ?? "");
    if (RAW_INVISIBLE.has(local)) {
      continue;
    }
    switch (local) {
      case "r": {
        const node = stream.claim("run");
        if (node.type !== "run") {
          bail("unreachable");
        }
        out.push(pairedRun(node, rawKid, ctx));
        break;
      }
      case "hyperlink": {
        if (stream.peek()?.type === "hyperlink") {
          const node = stream.claim("hyperlink");
          if (node.type !== "hyperlink") {
            bail("unreachable");
          }
          const innerStream = new AstStream(node.children);
          const inner = pairInlineList(contentChildren(rawKid), innerStream, ctx);
          innerStream.finish();
          out.push(shell(rawKid, inner));
          break;
        }
        // Attribute-less hyperlink unwrapped by the reader: rebuild the
        // wrapper shell from raw and claim its hoisted children.
        const inner = pairInlineList(contentChildren(rawKid), stream, ctx);
        out.push(shell(rawKid, inner));
        break;
      }
      case "moveFrom":
      case "moveTo": {
        if (stream.peek()?.type === local) {
          const node = stream.claim(local);
          if (node.type !== "moveFrom" && node.type !== "moveTo") {
            bail("unreachable");
          }
          const innerStream = new AstStream(node.children);
          const inner = pairInlineList(contentChildren(rawKid), innerStream, ctx);
          innerStream.finish();
          out.push(shell(rawKid, inner));
          break;
        }
        // Hoisted wrapper (Word writes w:name on the range markers, not the
        // wrapper, so jubarte inlines the children): rebuild from raw.
        const inner = pairInlineList(contentChildren(rawKid), stream, ctx);
        out.push(shell(rawKid, inner));
        break;
      }
      case "ins":
      case "del": {
        const node = stream.claim(local === "ins" ? "inserted" : "deleted");
        if (node.type !== "inserted" && node.type !== "deleted") {
          bail("unreachable");
        }
        const innerStream = new AstStream(node.children);
        const inner = pairInlineList(contentChildren(rawKid), innerStream, ctx);
        innerStream.finish();
        out.push(shell(rawKid, inner));
        break;
      }
      case "smartTag": {
        const node = stream.claim("smartTag");
        if (node.type !== "smartTag") {
          bail("unreachable");
        }
        // Jubarte surfaces smartTagPr as an opaque child alongside the
        // content; pair only the AST children that raw content explains.
        const innerStream = new AstStream(node.children);
        const inner: XmlElement[] = [];
        for (const rawChild of getChildElements(rawKid)) {
          if (getLocalName(rawChild.name ?? "") === "smartTagPr") {
            if (innerStream.peek()?.type === "opaqueElement") {
              innerStream.claim("opaqueElement");
            }
            inner.push(rawChild);
            continue;
          }
          inner.push(...pairInlineList([rawChild], innerStream, ctx));
        }
        innerStream.finish();
        out.push(shell(rawKid, inner));
        break;
      }
      case "sdt": {
        out.push(pairSdt(rawKid, stream, ctx, "inline"));
        break;
      }
      case "fldSimple": {
        const node = stream.claim("simpleField");
        if (node.type !== "simpleField") {
          bail("unreachable");
        }
        const innerStream = new AstStream(node.children);
        const inner = pairInlineList(contentChildren(rawKid), innerStream, ctx);
        innerStream.finish();
        out.push(shell(rawKid, inner));
        break;
      }
      case "oMath":
      case "oMathPara": {
        stream.claim("mathBlock");
        out.push(rawKid);
        break;
      }
      case "bookmarkStart":
      case "bookmarkEnd":
      case "commentRangeStart":
      case "commentRangeEnd":
      case "moveFromRangeStart":
      case "moveFromRangeEnd":
      case "moveToRangeStart":
      case "moveToRangeEnd": {
        const kindMap: Record<string, string> = {
          bookmarkStart: "bookmarkStart",
          bookmarkEnd: "bookmarkEnd",
          commentRangeStart: "commentRangeStart",
          commentRangeEnd: "commentRangeEnd",
          moveFromRangeStart: "moveRangeStart",
          moveFromRangeEnd: "moveRangeEnd",
          moveToRangeStart: "moveRangeStart",
          moveToRangeEnd: "moveRangeEnd",
        };
        stream.claim(kindMap[local] as string);
        out.push(rawKid);
        break;
      }
      case "customXmlInsRangeStart":
      case "customXmlInsRangeEnd":
      case "customXmlDelRangeStart":
      case "customXmlDelRangeEnd":
      case "customXmlMoveFromRangeStart":
      case "customXmlMoveFromRangeEnd":
      case "customXmlMoveToRangeStart":
      case "customXmlMoveToRangeEnd": {
        stream.claim(local.endsWith("Start") ? "customXmlRangeStart" : "customXmlRangeEnd");
        out.push(rawKid);
        break;
      }
      default:
        bail(`unexpected paragraph-level raw element ${local}`);
    }
  }
  return out;
}

// ============================================================================
// RUN PAIRING
// ============================================================================

function pairedRun(node: AstRun, rawRun: XmlElement, _ctx: ReconstructContext): XmlElement {
  const stream = new AstStream(node.children);
  const out: XmlElement[] = [];

  for (const rawKid of getChildElements(rawRun)) {
    const local = getLocalName(rawKid.name ?? "");
    switch (local) {
      case "rPr":
        // Property container comes from jubarte's rpr tree via the propShim.
        continue;
      case "t":
      case "delText": {
        if (stream.peek()?.type === "checkbox") {
          // Checkbox control: the reader keeps the sdt wrapper (dist 0.4.0+)
          // but replaces the glyph text with a checkbox node. The raw w:t is
          // authoritative for the glyph and its xml:space.
          stream.claim("checkbox");
          out.push(rawKid);
          break;
        }
        if (stream.peek()?.type !== "text") {
          // Jubarte drops empty text nodes; skip the raw element only when
          // it carries no content, otherwise the pairing is wrong.
          if (getTextContent(rawKid) === "") {
            continue;
          }
          bail(`raw ${local} has no AST text counterpart`);
        }
        const node2 = stream.claim("text");
        if (node2.type !== "text") {
          bail("unreachable");
        }
        if (getTextContent(rawKid) !== node2.value) {
          bail("raw text value differs from AST text value");
        }
        out.push(rawKid);
        break;
      }
      case "sym": {
        // Jubarte resolves w:sym to a plain text character; the raw element
        // restores SymbolContent (font + char).
        stream.claim("text");
        out.push(rawKid);
        break;
      }
      case "instrText":
      case "delInstrText": {
        const node2 = stream.claim("fieldInstruction");
        if (node2.type !== "fieldInstruction") {
          bail("unreachable");
        }
        if (getTextContent(rawKid) !== node2.value) {
          bail("raw instrText value differs from AST value");
        }
        out.push(rawKid);
        break;
      }
      case "tab": {
        stream.claim("tab");
        out.push(rawKid);
        break;
      }
      case "br": {
        stream.claim("break");
        out.push(rawKid);
        break;
      }
      case "cr": {
        stream.claim("opaqueElement");
        out.push(rawKid);
        break;
      }
      case "softHyphen": {
        stream.claim("softHyphen");
        out.push(rawKid);
        break;
      }
      case "noBreakHyphen": {
        stream.claim("noBreakHyphen");
        out.push(rawKid);
        break;
      }
      case "lastRenderedPageBreak": {
        stream.claim("lastRenderedPageBreak");
        out.push(rawKid);
        break;
      }
      case "fldChar": {
        // Raw keeps the numberingChange/originalValue child jubarte drops.
        // The reader also drops ORPHAN separate/end field characters (a
        // field whose begin run was lost inside a tracked-change wrapper —
        // folio's model has never retained those); the legacy parser reads
        // the orphan from the raw XML, so restore it without claiming.
        if (stream.peek()?.type === "fieldChar") {
          stream.claim("fieldChar");
        }
        out.push(rawKid);
        break;
      }
      case "footnoteReference":
      case "endnoteReference": {
        stream.claim("noteReference");
        out.push(rawKid);
        break;
      }
      case "commentReference": {
        stream.claim("commentReference");
        out.push(rawKid);
        break;
      }
      case "drawing":
      case "pict": {
        stream.claim("drawing");
        out.push(rawKid);
        break;
      }
      case "AlternateContent": {
        stream.claim("alternateContent");
        out.push(rawKid);
        break;
      }
      case "object": {
        stream.claim("opaqueElement");
        out.push(rawKid);
        break;
      }
      case "footnoteRef":
      case "endnoteRef":
      case "annotationRef":
      case "separator":
      case "continuationSeparator": {
        // Note-body marks have no AST node; legacy ignores them in run
        // content, so emitting them verbatim is round-trip-safe.
        out.push(rawKid);
        break;
      }
      default:
        bail(`unexpected run-level raw element ${local}`);
    }
  }
  stream.finish();

  const rPr = astPropsToContainerElement("w:rPr", node.rpr);
  const children = rPr ? [rPr, ...out] : out;
  return shell(rawRun, children);
}

// ============================================================================
// TABLE PAIRING (with vertical-merge re-expansion against the raw rows)
// ============================================================================

function pairedTable(node: AstTable, rawTable: XmlElement, ctx: ReconstructContext): XmlElement {
  try {
    return pairTableInner(node, rawTable, ctx);
  } catch (error) {
    if (!(error instanceof PairingBail)) {
      throw error;
    }
    warnBailOnce(ctx, error.message);
    return astElementToXml(node, ctx) ?? shell(rawTable, []);
  }
}

type ContinuationQueue = {
  startCol: number;
  entries: NonNullable<AstTableCell["vMergeContinuationCells"]>[number][];
  index: number;
};

/** Grid span of a raw `w:tc` (its tcPr gridSpan, defaulting to 1). */
function rawGridSpan(rawCell: XmlElement): number {
  const tcPr = findRawChild(rawCell, "tcPr");
  if (!tcPr) {
    return 1;
  }
  for (const child of getChildElements(tcPr)) {
    if (getLocalName(child.name ?? "") === "gridSpan") {
      const raw = getAttribute(child, "w", "val");
      const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return 1;
}

function pairTableInner(node: AstTable, rawTable: XmlElement, ctx: ReconstructContext): XmlElement {
  const children: XmlElement[] = [];
  const tblPr = astPropsToContainerElement("w:tblPr", node.tblpr);
  if (tblPr) {
    children.push(tblPr);
  }
  const tblGrid = astPropsToContainerElement("w:tblGrid", node.tblgrid);
  if (tblGrid) {
    children.push(tblGrid);
  }

  const astRows = node.children.filter(
    (child): child is Extract<AstDocumentElement, { type: "tableRow" }> =>
      child.type === "tableRow",
  );
  let rowIdx = 0;
  // Continuation cells jubarte stashed on their anchors, re-consumed in raw
  // row order (the raw row still contains the continuation `w:tc`).
  const continuations: ContinuationQueue[] = [];

  for (const rawKid of getChildElements(rawTable)) {
    const local = getLocalName(rawKid.name ?? "");
    if (local === "tblPr" || local === "tblGrid") {
      continue;
    }
    if (local !== "tr") {
      if (local === "bookmarkStart" || local === "bookmarkEnd") {
        children.push(rawKid);
        continue;
      }
      bail(`unexpected table-level raw element ${local}`);
    }
    const astRow = astRows[rowIdx];
    if (!astRow) {
      bail("raw table has more rows than the AST");
    }
    rowIdx += 1;

    const rowChildren: XmlElement[] = [];
    const trPr = astPropsToContainerElement("w:trPr", astRow.trpr);
    if (trPr) {
      rowChildren.push(trPr);
    }

    const astCells = astRow.children.filter(
      (child): child is AstTableCell => child.type === "tableCell",
    );
    let cellIdx = 0;
    let gridCol = 0;

    for (const rawCell of getChildElements(rawKid)) {
      const cellLocal = getLocalName(rawCell.name ?? "");
      if (cellLocal === "trPr") {
        continue;
      }
      if (cellLocal === "tblPrEx" || cellLocal === "bookmarkStart" || cellLocal === "bookmarkEnd") {
        // tblPrEx surfaces as an opaque carrier on the AST row; bookmarks
        // between cells stay verbatim. Neither participates in cell claims.
        rowChildren.push(rawCell);
        continue;
      }
      if (cellLocal !== "tc") {
        bail(`unexpected row-level raw element ${cellLocal}`);
      }

      const span = rawGridSpan(rawCell);
      if (isVMergeContinuation(rawCell)) {
        const entry = takeContinuation(continuations, gridCol);
        gridCol += span;
        if (entry) {
          const cellChildren: XmlElement[] = [];
          const tcPr = entry.tcpr ? astPropsToContainerElement("w:tcPr", entry.tcpr) : null;
          if (tcPr) {
            cellChildren.push(tcPr);
          }
          const contentStream = new AstStream(entry.children);
          cellChildren.push(...pairBlockList(contentChildren(rawCell), contentStream, ctx));
          contentStream.finish();
          rowChildren.push(shell(rawCell, cellChildren));
          continue;
        }
        // No stashed continuation for this column — the raw cell is
        // authoritative (the reader dropped its content as an empty merge).
        rowChildren.push(rawCell);
        continue;
      }

      const astCell = astCells[cellIdx];
      if (!astCell) {
        bail("raw row has more cells than the AST");
      }
      cellIdx += 1;

      if ((astCell.vMergeContinuationCells?.length ?? 0) > 0) {
        continuations.push({
          startCol: gridCol,
          entries: astCell.vMergeContinuationCells ?? [],
          index: 0,
        });
      }
      gridCol += span;

      const cellChildren: XmlElement[] = [];
      const tcPr = astPropsToContainerElement("w:tcPr", astCell.tcpr);
      if (tcPr) {
        cellChildren.push(tcPr);
      }
      const contentStream = new AstStream(astCell.children);
      cellChildren.push(...pairBlockList(contentChildren(rawCell), contentStream, ctx));
      contentStream.finish();
      rowChildren.push(shell(rawCell, cellChildren));
    }

    if (cellIdx !== astCells.length) {
      bail("AST row has unclaimed cells");
    }
    children.push(shell(rawKid, rowChildren));
  }

  if (rowIdx !== astRows.length) {
    bail("AST table has unclaimed rows");
  }
  return shell(rawTable, children);
}

/** Whether a raw `w:tc` is a vertical-merge continuation (vMerge without restart). */
function isVMergeContinuation(rawCell: XmlElement): boolean {
  const tcPr = findRawChild(rawCell, "tcPr");
  if (!tcPr) {
    return false;
  }
  for (const child of getChildElements(tcPr)) {
    if (getLocalName(child.name ?? "") === "vMerge") {
      const val = getAttribute(child, "w", "val");
      return val === null || val === "continue";
    }
  }
  return false;
}

function takeContinuation(
  queues: ContinuationQueue[],
  gridCol: number,
): NonNullable<AstTableCell["vMergeContinuationCells"]>[number] | null {
  for (const queue of queues) {
    if (queue.startCol === gridCol && queue.index < queue.entries.length) {
      const entry = queue.entries[queue.index];
      queue.index += 1;
      return entry ?? null;
    }
  }
  return null;
}

/**
 * Reconstruct a block container's children with raw pairing when the raw
 * container is available, falling back to the pure-AST reconstruction.
 */
export function reconstructBlockChildren(
  nodes: readonly AstDocumentElement[],
  rawContainer: XmlElement | null,
  ctx: ReconstructContext,
): XmlElement[] {
  if (rawContainer) {
    const paired = pairedBlockChildren(nodes, rawContainer, ctx);
    if (paired !== null) {
      return paired;
    }
  }
  return astElementsToXml(nodes, ctx);
}
