/**
 * Jubarte AST → Document model mapping (structure walking).
 *
 * Structure comes from jubarte's typed AST nodes; the nodes are rebuilt
 * into the `XmlElement` shape the core's existing parsers consume, so
 * paragraphs, runs, tables, fields, SDTs, tracked changes, and watermarks
 * are all interpreted by the SAME legacy code the parity harness compares
 * against. Property bags (`ppr`/`rpr`/`tblpr`/…) flow through
 * {@link ./propShim}; verbatim-XML carriers are parsed with folio's
 * xmlParser. Source details jubarte's reader normalizes away are recovered
 * by pairing the AST with the parsed byte-preserved part text
 * ({@link ./pairedXml}); when pairing is impossible the pure-AST
 * reconstruction in {@link ./astToXml} is the fallback.
 *
 * Comment bodies pair against their raw `w:comment` elements; notes are
 * interpreted from the byte-preserved parts with the legacy note parsers
 * (jubarte drops `w:type` and separator notes entirely); headers/footers
 * reparse their preserved part XML through jubarte (synthetic single-part
 * package) and pair against the same preserved text.
 */

import { docxToAst } from "@arthrod/jubarte";
import JSZip from "jszip";

import type {
  BlockContent,
  Comment,
  DocumentBody,
  Endnote,
  Footnote,
  HeaderFooter,
  MediaFile,
  Paragraph,
  RelationshipMap,
  Theme,
} from "../../types/document";
import { parseBlockContent } from "../blockContentParser";
import { parseCommentsExtended } from "../commentParser";
import type { CommentExtendedInfo } from "../commentParser";
import { buildSections } from "../documentParser";
import { parseEndnotes, parseFootnotes } from "../footnoteParser";
import { assignHeaderFooterVerbatimXml } from "../headerFooterVerbatim";
import type { NumberingMap } from "../numberingParser";
import { parseParagraph } from "../paragraphParser";
import { RELATIONSHIP_TYPES, resolveRelativePath } from "../relsParser";
import { parseSectionProperties } from "../sectionParser";
import type { StyleMap } from "../styleParser";
import { parseWatermark } from "../watermarkParser";
import {
  collectXmlnsDeclarations,
  findChild,
  getAttribute,
  getChildElements,
  getLocalName,
  parseXml,
} from "../xmlParser";
import type { XmlElement } from "../xmlParser";
import { astElementsToXml, astElementToXml, scanPartAttributeRecovery } from "./astToXml";
import type { ReconstructContext } from "./astToXml";
import { pairedBlockChildren, pairedParagraph } from "./pairedXml";
import { buildRelationshipMap, partText } from "./readPackage";
import type { AstDocumentElement, AstPackage } from "./types";

/** Shared interpretation context threaded through the walkers. */
export type FromAstContext = {
  styles: StyleMap | null;
  theme: Theme | null;
  numbering: NumberingMap | null;
  rels: RelationshipMap;
  media: Map<string, MediaFile>;
  warnings: string[];
};

// ============================================================================
// RAW-PART PARSING
// ============================================================================

/** Parse a part's XML and return its root element by local name. */
function partRootElement(xml: string | null, localName: string): XmlElement | null {
  if (!xml) {
    return null;
  }
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch {
    return null;
  }
  return (
    (doc.elements ?? []).find(
      (el) =>
        el.type === "element" &&
        (el.name === `w:${localName}` || el.name?.endsWith(`:${localName}`)),
    ) ?? null
  );
}

function parseXmlFragmentRoot(xml: string): XmlElement | null {
  try {
    const parsed = parseXml(xml);
    return parsed.elements?.find((el) => el.type === "element") ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// DOCUMENT BODY
// ============================================================================

/**
 * Map the document body: AST children → BlockContent[], plus section
 * splitting (paragraph-level sectPr) and the body-final section properties.
 * Replicates the legacy missing-part behavior: when the package has no main
 * document part, warn "No document.xml found in DOCX" and return
 * `{ content: [] }`.
 */
export function mapDocumentBody(
  astPackage: AstPackage,
  finalSectPrXml: string | null,
  ctx: FromAstContext,
): DocumentBody {
  const result: DocumentBody = { content: [] };
  const docPath = astPackage.package.mainDocumentPath || "word/document.xml";
  const documentXml = partText(astPackage, docPath);
  if (documentXml === null) {
    ctx.warnings.push("No document.xml found in DOCX");
    return result;
  }

  const documentEl = partRootElement(documentXml, "document");
  const rawBodyEl = documentEl ? findChild(documentEl, "w", "body") : null;
  const rootXmlns = documentEl ? collectXmlnsDeclarations(documentEl) : {};
  const rctx: ReconstructContext = {
    rels: ctx.rels,
    rootXmlns,
    recovery: scanPartAttributeRecovery(documentXml),
    warnings: ctx.warnings,
  };

  let bodyChildren = rawBodyEl
    ? pairedBlockChildren(astPackage.document.children, rawBodyEl, rctx)
    : null;
  if (bodyChildren === null) {
    // Pure-AST fallback: jubarte drops the body-trailing <w:sectPr> from
    // `document.children`, so re-append the orchestrator-recovered fragment;
    // the paired path carries it naturally (raw body order).
    bodyChildren = astElementsToXml(astPackage.document.children, rctx);
    const finalSectPrEl = finalSectPrXml ? parseXmlFragmentRoot(finalSectPrXml) : null;
    if (finalSectPrEl) {
      bodyChildren = [...bodyChildren, finalSectPrEl];
    }
  }
  const bodyEl: XmlElement = {
    type: "element",
    name: rawBodyEl?.name ?? "w:body",
    elements: bodyChildren,
  };

  result.content = parseBlockContent(bodyEl, ctx.styles, ctx.theme, ctx.numbering, ctx.rels, ctx.media, {
    rootXmlns,
  });

  const finalSectPr = findChild(bodyEl, "w", "sectPr");
  if (finalSectPr) {
    result.finalSectionProperties = parseSectionProperties(finalSectPr);
  }
  result.sections = buildSections(result.content, result.finalSectionProperties);

  return result;
}

/** Core element mapper, exposed for reuse by comment/note/HF mapping. */
export function mapBlockElements(
  elements: readonly AstDocumentElement[],
  ctx: FromAstContext,
): BlockContent[] {
  const rctx: ReconstructContext = { rels: ctx.rels, rootXmlns: {}, warnings: ctx.warnings };
  const container: XmlElement = {
    type: "element",
    name: "w:body",
    elements: astElementsToXml(elements, rctx),
  };
  return parseBlockContent(container, ctx.styles, ctx.theme, ctx.numbering, ctx.rels, ctx.media);
}

// ============================================================================
// COMMENTS
// ============================================================================

type RawCommentEntry = {
  idRaw: string;
  author: string | null;
  initials: string | null;
  date: string | null;
  el: XmlElement;
};

/**
 * Byte-preserved comments.xml, parsed once: wrapper attributes (jubarte
 * cannot distinguish `w:initials=""` from an absent attribute) plus each
 * comment's raw element for body pairing.
 */
function scanRawComments(commentsXml: string | null): Map<string, RawCommentEntry> {
  const byId = new Map<string, RawCommentEntry>();
  if (!commentsXml) {
    return byId;
  }
  let root: XmlElement;
  try {
    root = parseXml(commentsXml);
  } catch {
    return byId;
  }
  const container = findChild(root, "w", "comments") ?? root;
  for (const child of getChildElements(container)) {
    const localName = child.name?.replace(/^.*:/u, "") ?? "";
    if (localName !== "comment") {
      continue;
    }
    const idRaw = getAttribute(child, "w", "id") ?? "0";
    byId.set(idRaw, {
      idRaw,
      author: getAttribute(child, "w", "author"),
      initials: getAttribute(child, "w", "initials"),
      date: getAttribute(child, "w", "date"),
      el: child,
    });
  }
  return byId;
}

/** Map out-of-band comments (bodies pair against the raw comment elements). */
export function mapComments(astPackage: AstPackage, ctx: FromAstContext): Comment[] {
  const astComments = astPackage.document.comments;
  if (astComments.length === 0) {
    return [];
  }

  const commentsXml = partText(astPackage, "word/comments.xml");
  const rawById = scanRawComments(commentsXml);
  const commentsExtendedXml = partText(astPackage, "word/commentsExtended.xml");
  const extendedByParaId: Map<string, CommentExtendedInfo> = commentsExtendedXml
    ? parseCommentsExtended(commentsExtendedXml)
    : new Map<string, CommentExtendedInfo>();

  const commentsRootEl = commentsXml ? partRootElement(commentsXml, "comments") : null;
  const rctx: ReconstructContext = {
    rels: ctx.rels,
    rootXmlns: commentsRootEl ? collectXmlnsDeclarations(commentsRootEl) : {},
    recovery: scanPartAttributeRecovery(commentsXml),
    warnings: ctx.warnings,
  };

  const comments: Comment[] = [];
  const commentIdByParaId = new Map<string, number>();
  const paraIdByCommentIndex = new Map<number, string>();

  for (const astComment of astComments) {
    const entry = rawById.get(astComment.commentId);
    const id = Number.parseInt(entry?.idRaw ?? astComment.commentId, 10);
    const author = entry ? (entry.author ?? "Unknown") : (astComment.authorName ?? "Unknown");
    const initials = entry ? (entry.initials ?? undefined) : (astComment.authorInitials ?? undefined);
    const localDate = entry ? (entry.date ?? undefined) : (astComment.date ?? undefined);
    const paraId = astComment.paraId ? astComment.paraId.toUpperCase() : null;
    const dateUtc = astComment.dateUtc ?? undefined;
    const date = dateUtc ?? localDate;
    const done = paraId ? extendedByParaId.get(paraId)?.done : undefined;

    // Legacy walks only the `w:p` children of `w:comment` (tables and other
    // block content inside comments are dropped by the legacy parser too).
    // Pair each AST paragraph with its raw counterpart positionally.
    const rawParagraphs = entry
      ? getChildElements(entry.el).filter((child) => getLocalName(child.name ?? "") === "p")
      : [];
    const paragraphs: Paragraph[] = [];
    let paragraphIndex = 0;
    for (const bodyChild of astComment.body) {
      if (bodyChild.type !== "paragraph") {
        continue;
      }
      const rawParagraph = rawParagraphs[paragraphIndex];
      paragraphIndex += 1;
      const paragraphEl = rawParagraph
        ? pairedParagraph(bodyChild, rawParagraph, rctx)
        : astElementToXml(bodyChild, rctx);
      if (paragraphEl) {
        paragraphs.push(parseParagraph(paragraphEl, ctx.styles, ctx.theme, null, ctx.rels, ctx.media));
      }
    }

    const commentIndex = comments.length;
    if (paraId) {
      commentIdByParaId.set(paraId, id);
      paraIdByCommentIndex.set(commentIndex, paraId);
    }

    comments.push({
      id,
      author,
      ...(initials !== undefined ? { initials } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(done !== undefined ? { done } : {}),
      content: paragraphs,
    });
  }

  // Second pass: resolve reply-thread parents (paraIdParent → numeric id),
  // leaving orphaned replies as top-level comments, mirroring legacy.
  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const astComment = astComments[i];
    if (!comment || !astComment) {
      continue;
    }
    let parentParaId = astComment.parentParaId ? astComment.parentParaId.toUpperCase() : undefined;
    if (!parentParaId) {
      const ownParaId = paraIdByCommentIndex.get(i);
      parentParaId = ownParaId ? extendedByParaId.get(ownParaId)?.parentParaId : undefined;
    }
    if (!parentParaId) {
      continue;
    }
    const parentId = commentIdByParaId.get(parentParaId);
    if (parentId !== undefined && parentId !== comment.id) {
      comments[i] = { ...comment, parentId };
    }
  }

  return comments;
}

// ============================================================================
// FOOTNOTES / ENDNOTES
// ============================================================================

/**
 * Map footnotes/endnotes from the byte-preserved part text with the legacy
 * note parsers rather than from `astPackage.document.notes`: jubarte's AST
 * drops `w:type` (so separator / continuationSeparator / continuationNotice
 * notes are indistinguishable — and the first two are omitted entirely) and
 * note-body `w:footnoteRef`/`w:separator` marks have no AST node kind. The
 * part text still comes from jubarte's package graph.
 */
export function mapNotes(
  astPackage: AstPackage,
  ctx: FromAstContext,
): {
  footnotes?: Footnote[];
  endnotes?: Endnote[];
} {
  const footnoteMap = parseFootnotes(
    partText(astPackage, "word/footnotes.xml"),
    ctx.styles,
    ctx.theme,
    ctx.numbering,
    ctx.rels,
    ctx.media,
  );
  const endnoteMap = parseEndnotes(
    partText(astPackage, "word/endnotes.xml"),
    ctx.styles,
    ctx.theme,
    ctx.numbering,
    ctx.rels,
    ctx.media,
  );
  return {
    footnotes: footnoteMap.getNormalFootnotes(),
    endnotes: endnoteMap.getNormalEndnotes(),
  };
}

// ============================================================================
// HEADERS / FOOTERS
// ============================================================================

const SYNTHETIC_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const SYNTHETIC_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/**
 * Rewrite a preserved `w:hdr`/`w:ftr` part as a standalone `w:document` so
 * jubarte can parse the block content through its main-document reader. The
 * root's attributes (namespace declarations) travel onto the synthetic
 * document root.
 */
function wrapHeaderFooterAsDocumentXml(partXml: string, rootLocalName: string): string | null {
  const openRe = new RegExp(`<([A-Za-z_][\\w.-]*:)?${rootLocalName}(?=[\\s/>])`, "u");
  const match = openRe.exec(partXml);
  if (!match) {
    return null;
  }
  const prefix = match[1] ?? "";
  const start = match.index;
  const openEnd = partXml.indexOf(">", start);
  if (openEnd === -1) {
    return null;
  }
  const attrs = partXml.slice(start + 1 + prefix.length + rootLocalName.length, openEnd).replace(/\/$/u, "");
  const before = partXml.slice(0, start);
  if (partXml[openEnd - 1] === "/") {
    return `${before}<${prefix}document${attrs}><${prefix}body></${prefix}body></${prefix}document>`;
  }
  const closeTag = `</${prefix}${rootLocalName}>`;
  const closeIdx = partXml.lastIndexOf(closeTag);
  if (closeIdx === -1) {
    return null;
  }
  const inner = partXml.slice(openEnd + 1, closeIdx);
  return `${before}<${prefix}document${attrs}><${prefix}body>${inner}</${prefix}body></${prefix}document>`;
}

/** Reparse one preserved header/footer part through jubarte. */
async function reparsePartThroughJubarte(
  partXml: string,
  rootLocalName: string,
  partRelsXml: string | null,
  warnings: string[],
): Promise<AstDocumentElement[] | null> {
  const documentXml = wrapHeaderFooterAsDocumentXml(partXml, rootLocalName);
  if (documentXml === null) {
    return null;
  }
  try {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", SYNTHETIC_CONTENT_TYPES);
    zip.file("_rels/.rels", SYNTHETIC_ROOT_RELS);
    zip.file("word/document.xml", documentXml);
    if (partRelsXml !== null) {
      // The part's own relationships ride along so jubarte keeps
      // relationship-backed structure (hyperlinks are unwrapped to plain
      // runs when their r:id cannot be resolved).
      zip.file("word/_rels/document.xml.rels", partRelsXml);
    }
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const result = await docxToAst({ buffer, arrayBuffer: buffer } as never);
    return result.astPackage.document.children;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`jubarte adapter: failed to reparse ${rootLocalName} part: ${message}`);
    return null;
  }
}

function relsPathForPart(partPath: string): string {
  const lastSlash = partPath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : partPath.slice(0, lastSlash);
  const filename = lastSlash === -1 ? partPath : partPath.slice(lastSlash + 1);
  return `${directory ? `${directory}/` : ""}_rels/${filename}.rels`;
}

function withoutChild(parent: XmlElement, child: XmlElement): XmlElement {
  return {
    ...parent,
    elements: (parent.elements ?? []).filter((el) => el !== child),
  };
}

async function parseHeaderFooterPart(
  partXml: string,
  isHeader: boolean,
  partRels: RelationshipMap,
  partRelsXml: string | null,
  ctx: FromAstContext,
): Promise<HeaderFooter> {
  const result: HeaderFooter = {
    type: isHeader ? "header" : "footer",
    hdrFtrType: "default",
    content: [],
  };

  const rootLocalName = isHeader ? "hdr" : "ftr";
  const rawRootEl = partRootElement(partXml, rootLocalName);
  const astChildren = await reparsePartThroughJubarte(partXml, rootLocalName, partRelsXml, ctx.warnings);
  if (!rawRootEl?.name || astChildren === null) {
    return result;
  }

  const rctx: ReconstructContext = {
    rels: partRels,
    rootXmlns: collectXmlnsDeclarations(rawRootEl),
    recovery: scanPartAttributeRecovery(partXml),
    warnings: ctx.warnings,
  };
  const children =
    pairedBlockChildren(astChildren, rawRootEl, rctx) ?? astElementsToXml(astChildren, rctx);
  const rootElement: XmlElement = {
    type: "element",
    name: rawRootEl.name,
    ...(rawRootEl.attributes && Object.keys(rawRootEl.attributes).length > 0
      ? { attributes: rawRootEl.attributes }
      : {}),
    elements: children,
  };

  // Mirrors legacy parseHeader/parseFooter: watermark detection first (the
  // hosting paragraph is excluded from block parsing), then the shared
  // block-content parser, then the verbatim-part capture.
  let contentRoot = rootElement;
  if (isHeader) {
    const watermarkResult = parseWatermark(rootElement);
    if (watermarkResult) {
      result.watermark = watermarkResult.watermark;
      result.rawWatermarkXml = watermarkResult.rawParagraphXml;
      result.watermarkBlockIndex = watermarkResult.blockIndex;
      contentRoot = withoutChild(rootElement, watermarkResult.hostingParagraph);
    }
  }

  result.content = parseBlockContent(
    contentRoot,
    ctx.styles,
    ctx.theme,
    ctx.numbering,
    partRels,
    ctx.media,
    {
      inHeaderFooter: true,
      rootXmlns: collectXmlnsDeclarations(rootElement),
    },
  );

  assignHeaderFooterVerbatimXml(result, partXml);
  return result;
}

/**
 * Map headers/footers keyed by rId (rels-map iteration order, mirroring the
 * legacy parseHeadersAndFooters). Content is obtained by reparsing each
 * preserved header/footer part through jubarte and pairing the resulting
 * AST with the preserved part text; part-local relationships resolve from
 * `word/_rels/<part>.rels`, falling back to the document rels; picture
 * watermarks are anchored to package-absolute media paths.
 */
export async function mapHeadersFooters(
  astPackage: AstPackage,
  ctx: FromAstContext,
): Promise<{ headers: Map<string, HeaderFooter>; footers: Map<string, HeaderFooter> }> {
  const headers = new Map<string, HeaderFooter>();
  const footers = new Map<string, HeaderFooter>();

  for (const [rId, rel] of ctx.rels.entries()) {
    const isHeader = rel.type === RELATIONSHIP_TYPES.header;
    const isFooter = rel.type === RELATIONSHIP_TYPES.footer;
    if ((!isHeader && !isFooter) || !rel.target) {
      continue;
    }

    const partPath = resolveRelativePath("word/_rels/document.xml.rels", rel.target);
    // oxlint-disable-next-line no-await-in-loop -- parts are reparsed serially, matching legacy order
    const partXml = partText(astPackage, partPath);
    if (partXml === null) {
      continue;
    }

    const partRelsPath = relsPathForPart(partPath);
    const partRelsXml = partText(astPackage, partRelsPath);
    const partRels = partRelsXml !== null ? buildRelationshipMap(astPackage, partPath) : ctx.rels;

    // oxlint-disable-next-line no-await-in-loop -- see above
    const headerFooter = await parseHeaderFooterPart(partXml, isHeader, partRels, partRelsXml, ctx);

    if (isHeader) {
      const watermark = headerFooter.watermark;
      if (watermark?.kind === "picture") {
        const imageRel = partRels.get(watermark.imageRId);
        if (imageRel?.type === RELATIONSHIP_TYPES.image && imageRel.target) {
          if (imageRel.targetMode === "External") {
            watermark.imageTarget = imageRel.target;
            watermark.imageTargetExternal = true;
          } else {
            watermark.imageTarget = resolveRelativePath(partRelsPath, imageRel.target);
          }
        }
      }
      headers.set(rId, headerFooter);
    } else {
      footers.set(rId, headerFooter);
    }
  }

  return { headers, footers };
}
