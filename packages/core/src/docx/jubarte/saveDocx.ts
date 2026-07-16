/**
 * Jubarte-backed DOCX save — full replacement for the legacy `repackDocx`.
 *
 * Flow:
 *  1. Read the original buffer through jubarte (`readDocxPackage`) — every
 *     part byte-preserved on the package graph.
 *  2. Run the legacy model-level pre-passes (header/footer materialization,
 *     new images / hyperlinks, picture-watermark rId rebinding, numbering
 *     splice, core-props update) against the package graph through a minimal
 *     JSZip-shaped shim, using the ported legacy logic from ./emit.
 *  3. Replace `document.children` / `comments` / `notes` with the mapped AST
 *     (see {@link ./toAst}); regenerate header/footer parts through a
 *     synthetic jubarte package per part (folio's verbatim-replay and
 *     watermark-at-index semantics preserved).
 *  4. `astToDocxWithDiagnostics` writes the package; non-info diagnostics are
 *     surfaced, and `opaque-body-passthrough` (edits silently dropped) throws.
 *  5. Post-process the output zip: re-stamp `w14:paraId`/`w14:textId` on the
 *     paragraphs jubarte regenerated (its writer drops them), swap the
 *     trailing body `<w:sectPr>` for the model's `finalSectionProperties`
 *     (jubarte byte-preserves the source one, so model edits to the final
 *     section would otherwise never land), splice back `continuationNotice`
 *     note separators the sidecar writer drops, enforce the package fidelity
 *     gate, and rewrite the comment sidecars with folio's exact legacy
 *     serialization (extended part only when replies/resolved exist;
 *     commentsIds/commentsExtensible byte-restored). See SAVE-PARITY-NOTES.md.
 */

import { panic } from "better-result";
import JSZip from "jszip";
import { astToDocxWithDiagnostics } from "@arthrod/jubarte";

import type { Comment, Document, SectionProperties } from "../../types/document";
import { applyReplyThreadMarkers } from "../commentReplyMarkers";
import { assertValidFolioDocumentModel } from "../modelValidation";
import { isPreservableDocxEntry, repairDocxArchive } from "../unzip";
import { parseEndnotes, parseFootnotes } from "../footnoteParser";
import { parseNumbering } from "../numberingParser";
import { RELATIONSHIP_TYPES } from "../relsParser";
import {
  buildPatchedNoteXml,
  buildPatchedNumberingXml,
  collectChangedNumberingDefs,
  collectParaIds,
  extractParagraphXml,
} from "../selectiveXmlPatch";
import {
  ensureThreadedCommentParaIds,
  serializeComments,
  serializeCommentsExtended,
} from "./emit/commentSerializer";
import {
  buildNamespaceDeclarations,
  serializeWatermarkParagraph,
} from "./emit/headerFooterSerializer";
import { collectHyperlinksWithoutRId, processNewHyperlinks } from "./emit/hyperlinks";
import { collectImageParts, processNewImages } from "./emit/images";
import {
  DOCUMENT_NAMESPACES,
  serializeDocument as emitFullDocumentXml,
} from "./emit/documentSerializer";
import { serializeEndnotes, serializeFootnotes } from "./emit/noteSerializer";
import { serializeNumberingXml } from "./emit/numberingSerializer";
import {
  addCommentsExtendedOverride,
  addCommentsExtendedRelationship,
  COMMENTS_EXTENDED_PART,
  COMMENTS_EXTENDED_PART_LOWER,
  ensureCommentsContentType,
  ensureCommentsRelationship,
  materializeNewHeaderFooterParts,
  rebindWatermarkRelIds,
  removeCommentsExtendedOverride,
  removeCommentsExtendedRelationship,
} from "./emit/packaging";
import {
  assertDocumentPackageFidelity,
  createEmptyDocxScaffold,
  updateCoreProperties,
} from "./emit/packageMaintenance";
import {
  headerFooterFilename,
  findZipEntryCaseInsensitive,
  transformPackagingFile,
} from "./emit/relsUtils";
import { resetAutoIdCounter } from "./emit/runSerializer";
import { serializeSectionProperties } from "./emit/sectionPropertiesSerializer";
import { findPart, readDocxPackage } from "./readPackage";
import {
  createToAstContext,
  mapCommentsToAst,
  mapNotesToAst,
  modelBlocksToAstElements,
  type MappedNotes,
  type ParagraphTagExpectation,
} from "./toAst";
import type { AstDocumentElement, AstPackage, AstPackagePart } from "./types";

export { DocxPackageFidelityError } from "./emit/packageMaintenance";

/** Options for repacking DOCX — same shape as the legacy `RepackOptions`. */
export type RepackOptions = {
  /** Compression level (0-9, default: 6) */
  compressionLevel?: number;
  /** Whether to update modification date in docProps/core.xml */
  updateModifiedDate?: boolean;
  /** Custom modifier name for lastModifiedBy */
  modifiedBy?: string;
};

// ============================================================================
// JSZip-shaped shim over the jubarte package graph
// ============================================================================

/**
 * The ported rezip helpers only use `zip.file(path)` reads, `zip.file(path,
 * content)` writes, and `zip.forEach`. This shim maps that surface onto the
 * jubarte package graph so the ported logic runs unchanged; compression
 * options are ignored (the final zip is generated once at the end).
 */
function graphZipShim(astPackage: AstPackage): JSZip {
  const parts = astPackage.package.parts;
  const shim = {
    file(path: string, content?: string | ArrayBuffer | Uint8Array, _options?: unknown) {
      if (content === undefined) {
        const part = parts[path];
        if (!part) {
          return null;
        }
        return {
          async: (type: string): Promise<string | ArrayBuffer> => {
            if (type === "text") {
              if (typeof part.text === "string") {
                return Promise.resolve(part.text);
              }
              return Promise.resolve(
                new TextDecoder().decode(toU8(part.bytes ?? new Uint8Array())),
              );
            }
            const u8 = part.bytes ? toU8(part.bytes) : new TextEncoder().encode(part.text ?? "");
            return Promise.resolve(
              u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer,
            );
          },
        };
      }
      const previous = parts[path];
      const record: AstPackagePart = {
        path,
        kind: typeof content === "string" ? "xml" : "binary",
        contentType: previous?.contentType ?? null,
        preservation: previous?.preservation ?? "bestEffort",
      };
      if (typeof content === "string") {
        record.text = content;
      } else {
        record.bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
      }
      parts[path] = record;
      return shim;
    },
    forEach(callback: (relativePath: string) => void) {
      for (const key of Object.keys(parts)) {
        callback(key);
      }
    },
  };
  // SAFETY: the shim implements exactly the JSZip surface (file/forEach) the
  // ported rezip helpers use; see the doc comment above.
  return shim as unknown as JSZip;
}

function toU8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function graphPartText(astPackage: AstPackage, path: string): string | null {
  const part = findPart(astPackage, path);
  if (!part) {
    return null;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (part.bytes) {
    return new TextDecoder().decode(toU8(part.bytes));
  }
  return null;
}

// ============================================================================
// paraId / textId re-stamping
// ============================================================================

const W_P_TAG_RE = /<w:p[\s/>]/gu;

/**
 * `w14:paraId` stamping is only legal when the part declares the `w14`
 * namespace prefix; writing the attribute into a part without the
 * declaration produces XML Word rejects as corrupt. Word-produced files
 * always declare it, but minimal scaffolds or third-party producers may not.
 */
function declaresW14(xml: string): boolean {
  return xml.includes("xmlns:w14=");
}

/**
 * Re-stamp `w14:paraId`/`w14:textId` onto the `<w:p` tags of an emitted XML
 * string, following the paragraph-tag ledger recorded during mapping. Returns
 * null (⇒ caller keeps the input untouched) when the tag count does not match
 * the ledger — never corrupt.
 */
export function stampParagraphTags(
  xml: string,
  tags: readonly ParagraphTagExpectation[],
): string | null {
  const matchIndexes: number[] = [];
  W_P_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = W_P_TAG_RE.exec(xml)) !== null) {
    matchIndexes.push(match.index);
  }
  const expected = tags.reduce((total, tag) => total + (tag.kind === "opaque" ? tag.count : 1), 0);
  if (expected !== matchIndexes.length) {
    return null;
  }
  const inserts: { index: number; attrs: string }[] = [];
  let cursor = 0;
  for (const tag of tags) {
    if (tag.kind === "opaque") {
      cursor += tag.count;
      continue;
    }
    const attrs =
      (tag.paraId ? ` w14:paraId="${tag.paraId}"` : "") +
      (tag.textId ? ` w14:textId="${tag.textId}"` : "");
    if (attrs) {
      // SAFETY: cursor < matchIndexes.length because expected === matchIndexes.length
      inserts.push({ index: matchIndexes[cursor]!, attrs });
    }
    cursor += 1;
  }
  if (inserts.length === 0) {
    return xml;
  }
  let out = "";
  let sliceFrom = 0;
  for (const { index, attrs } of inserts) {
    const insertAt = index + "<w:p".length;
    out += xml.slice(sliceFrom, insertAt) + attrs;
    sliceFrom = insertAt;
  }
  return out + xml.slice(sliceFrom);
}

// ============================================================================
// Trailing body sectPr replacement
// ============================================================================

const SECT_PR_TOKEN_RE =
  /<w:sectPr\b(?:[^>"']|"[^"]*"|'[^']*')*\/>|<w:sectPr\b(?:[^>"']|"[^"]*"|'[^']*')*>|<\/w:sectPr>/gu;

function findTrailingSectPr(xml: string, bodyClose: number): { start: number; end: number } | null {
  SECT_PR_TOKEN_RE.lastIndex = 0;
  const stack: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = SECT_PR_TOKEN_RE.exec(xml)) !== null && match.index < bodyClose) {
    const token = match[0];
    if (token === "</w:sectPr>") {
      const open = stack.pop();
      const end = match.index + token.length;
      if (open !== undefined && stack.length === 0 && /^\s*$/u.test(xml.slice(end, bodyClose))) {
        return { start: open, end };
      }
      continue;
    }
    if (token.endsWith("/>")) {
      const end = match.index + token.length;
      if (stack.length === 0 && /^\s*$/u.test(xml.slice(end, bodyClose))) {
        return { start: match.index, end };
      }
      continue;
    }
    stack.push(match.index);
  }
  return null;
}

/**
 * jubarte's package writer byte-preserves the trailing body `<w:sectPr>` from
 * the SOURCE document (both its region patcher and whole-body regenerator
 * splice the original bytes back). The model's `finalSectionProperties` is
 * authoritative for the save, so replace the trailing sectPr with the
 * legacy-serialized model version (or remove/insert it when only one side
 * has one).
 */
function replaceTrailingSectPr(xml: string, props: SectionProperties | undefined): string {
  const replacement = props ? serializeSectionProperties(props) : "";
  const bodyClose = xml.lastIndexOf("</w:body>");
  if (bodyClose === -1) {
    return xml;
  }
  const existing = findTrailingSectPr(xml, bodyClose);
  if (existing) {
    return xml.slice(0, existing.start) + replacement + xml.slice(existing.end);
  }
  if (!replacement) {
    return xml;
  }
  return xml.slice(0, bodyClose) + replacement + xml.slice(bodyClose);
}

// ============================================================================
// Header / footer parts via a synthetic jubarte package
// ============================================================================

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const SYNTHETIC_CONTENT_TYPES =
  `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const SYNTHETIC_ROOT_RELS =
  `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const HEADER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const FOOTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";

function syntheticPart(path: string, text: string, contentType: string | null): AstPackagePart {
  return { path, kind: "xml", contentType, preservation: "bestEffort", text };
}

/**
 * Emit body-inner XML for a block list by running it through a minimal
 * synthetic jubarte package (the same regenerator/writer path the main
 * document uses), then extracting the `<w:body>` payload.
 */
async function emitBodyXmlViaJubarte(elements: AstDocumentElement[]): Promise<string> {
  const syntheticDocument = `${XML_DECL}<w:document ${buildNamespaceDeclarations()}><w:body></w:body></w:document>`;
  const syntheticPackage: AstPackage = {
    type: "docxPackage",
    document: { type: "document", children: elements, comments: [], notes: [] },
    package: {
      mainDocumentPath: "word/document.xml",
      parts: {
        "[Content_Types].xml": syntheticPart("[Content_Types].xml", SYNTHETIC_CONTENT_TYPES, null),
        "_rels/.rels": syntheticPart("_rels/.rels", SYNTHETIC_ROOT_RELS, null),
        "word/document.xml": syntheticPart(
          "word/document.xml",
          syntheticDocument,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ),
      },
      relationships: {
        "": [
          {
            sourcePath: "",
            id: "rId1",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
            target: "word/document.xml",
            targetMode: null,
          },
        ],
        "word/document.xml": [],
      },
      contentTypes: {
        defaults: {
          rels: "application/vnd.openxmlformats-package.relationships+xml",
          xml: "application/xml",
        },
        overrides: [
          {
            partName: "/word/document.xml",
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
          },
        ],
      },
    },
    diagnostics: [],
    policy: { strict: [], unknown: "preserveWhenSafe" },
  };

  const result = await astToDocxWithDiagnostics(syntheticPackage);
  surfaceDiagnostics(result.diagnostics, "header/footer synthetic package");
  const buffer = await outputToArrayBuffer(result.output);
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")!.async("text");
  const bodyMatch = /<w:body(?:\s[^>]*)?>(?<inner>[\s\S]*)<\/w:body>/u.exec(documentXml);
  if (!bodyMatch) {
    throw new Error("jubarte synthetic package produced no <w:body>");
  }
  // SAFETY: named group `inner` always present when the regex matches
  return bodyMatch.groups!["inner"]!;
}

/**
 * Emit a block list through the synthetic package and re-stamp its
 * paraId/textId tags from the mapping ledger. Empty list ⇒ empty string.
 */
async function emitBlocksViaJubarte(
  blocks: readonly import("../../types/document").BlockContent[],
  partLabel: string,
): Promise<string> {
  if (blocks.length === 0) {
    return "";
  }
  const ctx = createToAstContext();
  const elements = modelBlocksToAstElements(blocks, ctx);
  const inner = await emitBodyXmlViaJubarte(elements);
  const stamped = stampParagraphTags(inner, ctx.paragraphTags);
  if (stamped === null) {
    console.warn(
      `[jubarte-save] paragraph tag count mismatch in ${partLabel}; skipping paraId re-stamp`,
    );
    return inner;
  }
  return stamped;
}

/**
 * Build one header/footer part's XML with folio's legacy semantics
 * (serializeHeaderFooter): verbatim replay when the captured part can be
 * replayed; otherwise jubarte-emitted block content with the watermark
 * paragraph (raw or synthesized) inserted at `watermarkBlockIndex`, and the
 * mandatory empty paragraph fallback.
 */
async function buildHeaderFooterPartXml(
  hf: import("../../types/document").HeaderFooter,
  partLabel: string,
): Promise<string> {
  const { getHeaderFooterVerbatimXml, canReplayHeaderFooterVerbatim } =
    await import("../headerFooterVerbatim");
  const verbatim = getHeaderFooterVerbatimXml(hf);
  if (verbatim && canReplayHeaderFooterVerbatim(hf)) {
    return verbatim;
  }

  const rootTag = hf.type === "header" ? "w:hdr" : "w:ftr";
  const nsDecl = buildNamespaceDeclarations();

  const watermarkXml = serializeWatermarkParagraph(hf);
  let contentXml: string;
  if (watermarkXml) {
    const insertIndex =
      hf.watermarkBlockIndex === undefined
        ? 0
        : Math.max(0, Math.min(hf.watermarkBlockIndex, hf.content.length));
    const before = await emitBlocksViaJubarte(hf.content.slice(0, insertIndex), partLabel);
    const after = await emitBlocksViaJubarte(hf.content.slice(insertIndex), partLabel);
    contentXml = before + watermarkXml + after;
  } else {
    contentXml = await emitBlocksViaJubarte(hf.content, partLabel);
  }

  // Ensure at least one empty paragraph (required by OOXML spec)
  if (!contentXml) {
    contentXml = "<w:p><w:pPr/></w:p>";
  }

  return `${XML_DECL}\n<${rootTag} ${nsDecl}>${contentXml}</${rootTag}>`;
}

/**
 * Regenerate every header/footer part in the model into the package graph,
 * mirroring the legacy `serializeHeadersFootersToZip` semantics (part path
 * from the rId's relationship target).
 */
async function writeHeaderFooterParts(doc: Document, astPackage: AstPackage): Promise<void> {
  const rels = doc.package.relationships;
  if (!rels) {
    return;
  }

  const groups = [
    { map: doc.package.headers, type: RELATIONSHIP_TYPES.header, isHeader: true },
    { map: doc.package.footers, type: RELATIONSHIP_TYPES.footer, isHeader: false },
  ];

  for (const { map, type, isHeader } of groups) {
    if (!map) {
      continue;
    }
    for (const [rId, headerFooter] of map.entries()) {
      const rel = rels.get(rId);
      if (!rel || rel.type !== type || !rel.target) {
        continue;
      }
      const partPath = headerFooterFilename(rel.target);
      // oxlint-disable-next-line no-await-in-loop -- parts are emitted serially, matching legacy order
      const partXml = await buildHeaderFooterPartXml(headerFooter, partPath);
      const previous = astPackage.package.parts[partPath];
      astPackage.package.parts[partPath] = {
        path: partPath,
        kind: "xml",
        contentType:
          previous?.contentType ?? (isHeader ? HEADER_CONTENT_TYPE : FOOTER_CONTENT_TYPE),
        preservation: previous?.preservation ?? "bestEffort",
        text: partXml,
      };
    }
  }
}

// ============================================================================
// Numbering splice (folio's serializeNumberingIntoZip semantics)
// ============================================================================

/**
 * Splice edited numbering definitions into the byte-preserved
 * word/numbering.xml on the package graph. The model does not faithfully
 * retain the whole part, so only definitions whose serialization differs
 * from a re-parse/re-serialize baseline are spliced by id; everything else
 * stays byte-exact — exactly the legacy full-repack behavior.
 */
function spliceNumberingIntoGraph(doc: Document, astPackage: AstPackage, shim: JSZip): void {
  const numbering = doc.package.numbering;
  if (!numbering || (numbering.abstractNums.length === 0 && numbering.nums.length === 0)) {
    return;
  }
  const part = findPart(astPackage, "word/numbering.xml");
  if (!part) {
    return;
  }
  const originalXml = graphPartText(astPackage, "word/numbering.xml");
  if (originalXml === null) {
    return;
  }
  const baselineXml = serializeNumberingXml(parseNumbering(originalXml).definitions);
  const currentXml = serializeNumberingXml(numbering);
  const changed = collectChangedNumberingDefs(baselineXml, currentXml);
  if (changed.abstractNums.size === 0 && changed.nums.size === 0) {
    return;
  }
  const patched = buildPatchedNumberingXml(originalXml, currentXml, changed);
  if (patched === null) {
    return;
  }
  shim.file(part.path, patched);
}

// ============================================================================
// Notes part re-stamping / separator splice-back
// ============================================================================

type SeparatorNote = { id: string; xml: string };

/**
 * Extract the non-normal (separator-kind) notes from a preserved
 * footnotes/endnotes part, byte-exact. jubarte's sidecar writer preserves
 * `separator`/`continuationSeparator` notes but drops `continuationNotice`;
 * the dropped ones are spliced back from these captures.
 */
function extractSeparatorNotes(
  xml: string | null,
  noteTag: "w:footnote" | "w:endnote",
): SeparatorNote[] {
  if (!xml) {
    return [];
  }
  const out: SeparatorNote[] = [];
  const openRe = new RegExp(`<${noteTag}\\b[^>]*>`, "gu");
  const closeTag = `</${noteTag}>`;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(xml)) !== null) {
    const openTag = match[0];
    if (openTag.endsWith("/>")) {
      continue;
    }
    const typeAttr = /w:type="(?<type>[^"]*)"/u.exec(openTag)?.groups?.["type"];
    const idAttr = /w:id="(?<id>[^"]*)"/u.exec(openTag)?.groups?.["id"];
    const closeIdx = xml.indexOf(closeTag, openRe.lastIndex);
    if (closeIdx === -1) {
      break;
    }
    const end = closeIdx + closeTag.length;
    if (idAttr !== undefined && typeAttr !== undefined && typeAttr !== "normal") {
      out.push({ id: idAttr, xml: xml.slice(match.index, end) });
    }
    openRe.lastIndex = end;
  }
  return out;
}

async function restampNotesPart(
  zip: JSZip,
  path: string,
  noteTag: "w:footnote" | "w:endnote",
  mapped: MappedNotes,
  originalPartXml: string | null,
): Promise<void> {
  const file = zip.file(path);
  if (!file) {
    return;
  }
  let xml = await file.async("text");
  const noteType = noteTag === "w:footnote" ? "footnote" : "endnote";
  const openRe = new RegExp(`<${noteTag}\\b[^>]*>`, "gu");
  const closeTag = `</${noteTag}>`;

  // jubarte's sidecar writer only byte-preserves `separator` /
  // `continuationSeparator` notes; other separator kinds Word requires
  // (`continuationNotice`) are dropped from the regenerated part. Splice any
  // original separator missing from the output back in — byte-exact from the
  // preserved source part, ahead of the first content note — so the
  // separator set matches the legacy save (which never rewrites them).
  const presentIds = new Set<string>();
  let firstContentNoteIdx = -1;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openRe.exec(xml)) !== null) {
    const idAttr = /w:id="(?<id>[^"]*)"/u.exec(openMatch[0])?.groups?.["id"];
    if (idAttr !== undefined) {
      presentIds.add(idAttr);
    }
    const typeAttr = /w:type="(?<type>[^"]*)"/u.exec(openMatch[0])?.groups?.["type"];
    if (firstContentNoteIdx === -1 && (typeAttr === undefined || typeAttr === "normal")) {
      firstContentNoteIdx = openMatch.index;
    }
  }
  const missing = extractSeparatorNotes(originalPartXml, noteTag).filter(
    (note) => !presentIds.has(note.id),
  );
  if (missing.length > 0) {
    const insertXml = missing.map((note) => note.xml).join("");
    const insertAt =
      firstContentNoteIdx === -1 ? xml.lastIndexOf(`</${noteTag}s>`) : firstContentNoteIdx;
    if (insertAt !== -1) {
      xml = xml.slice(0, insertAt) + insertXml + xml.slice(insertAt);
      zip.file(path, xml);
    }
  }

  // Re-stamp paraId/textId per content note from the mapping ledgers.
  let out = "";
  let cursor = 0;
  let changed = false;
  openRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(xml)) !== null) {
    const openTag = match[0];
    if (openTag.endsWith("/>")) {
      continue;
    }
    const closeIdx = xml.indexOf(closeTag, openRe.lastIndex);
    if (closeIdx === -1) {
      break;
    }
    const end = closeIdx + closeTag.length;
    const typeAttr = /w:type="(?<type>[^"]*)"/u.exec(openTag)?.groups?.["type"];
    const idAttr = /w:id="(?<id>[^"]*)"/u.exec(openTag)?.groups?.["id"];
    if (idAttr !== undefined && (typeAttr === undefined || typeAttr === "normal")) {
      const tags = mapped.ledgers.get(`${noteType}:${idAttr}`);
      if (tags && declaresW14(xml)) {
        const slice = xml.slice(match.index, end);
        const stamped = stampParagraphTags(slice, tags);
        if (stamped === null) {
          console.warn(
            `[jubarte-save] paragraph tag count mismatch in ${path} ${noteTag}#${idAttr}; skipping paraId re-stamp`,
          );
        } else if (stamped !== slice) {
          out += xml.slice(cursor, match.index) + stamped;
          cursor = end;
          changed = true;
        }
      }
    }
    openRe.lastIndex = end;
  }
  if (changed) {
    zip.file(path, out + xml.slice(cursor));
  }
}

// ============================================================================
// Comment sidecars (folio legacy semantics, post-write)
// ============================================================================

type OriginalCommentSidecars = {
  hadCommentsFile: boolean;
  /** Byte-preserved original text of the parts folio's legacy save never touches. */
  commentsIds: string | null;
  commentsExtensible: string | null;
};

function captureOriginalCommentSidecars(astPackage: AstPackage): OriginalCommentSidecars {
  return {
    hadCommentsFile: astPackage.package.parts["word/comments.xml"] !== undefined,
    commentsIds: graphPartText(astPackage, "word/commentsIds.xml"),
    commentsExtensible: graphPartText(astPackage, "word/commentsExtensible.xml"),
  };
}

/**
 * Rewrite the comment sidecars with folio's exact legacy serialization.
 *
 * jubarte's writer regenerates comments.xml / commentsExtended.xml /
 * commentsIds.xml / commentsExtensible.xml from the mapped AstComments.
 * Folio's legacy save instead (a) writes comments.xml with its own
 * serializer (deterministic paraIds preserved from the model), (b) writes
 * commentsExtended.xml ONLY when replies/resolved state exists and REMOVES
 * the part + its override + its relationship otherwise, and (c) never
 * touches commentsIds.xml / commentsExtensible.xml (byte-preserved). This
 * post-pass replays exactly that on the output zip; the AstComments only
 * keep the writer's body/anchor bookkeeping consistent.
 */
async function rewriteCommentSidecars(
  zip: JSZip,
  comments: Comment[],
  originals: OriginalCommentSidecars,
  compressionLevel: number,
): Promise<void> {
  // (c) Restore the untouched-by-legacy sidecars: original bytes when the
  // source had them, removal (with packaging scrub) when jubarte minted new
  // ones the legacy save would not produce.
  const restore: { path: string; original: string | null }[] = [
    { path: "word/commentsIds.xml", original: originals.commentsIds },
    { path: "word/commentsExtensible.xml", original: originals.commentsExtensible },
  ];
  for (const { path, original } of restore) {
    const existing = findZipEntryCaseInsensitive(zip, path.toLowerCase());
    if (original !== null) {
      zip.file(existing?.name ?? path, original, {
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });
    } else if (existing) {
      zip.remove(existing.name);
      const partBasename = path.slice("word/".length);
      // oxlint-disable-next-line no-await-in-loop -- both transforms edit the same packaging files sequentially
      await transformPackagingFile(
        zip,
        "[Content_Types].xml",
        (xml) => xml.replace(new RegExp(`<Override\\b[^>]*${partBasename}[^>]*\\/>`, "giu"), ""),
        compressionLevel,
      );
      // oxlint-disable-next-line no-await-in-loop -- see above
      await transformPackagingFile(
        zip,
        "word/_rels/document.xml.rels",
        (xml) =>
          xml.replace(new RegExp(`<Relationship\\b[^>]*${partBasename}[^>]*\\/>`, "giu"), ""),
        compressionLevel,
      );
    }
  }

  // (a) comments.xml with folio's serializer — including the empty
  // `<w:comments/>` overwrite when the last comment was deleted.
  if (comments.length === 0 && !originals.hadCommentsFile) {
    return;
  }
  // `ensureThreadedCommentParaIds` already ran before the AST mapping (the
  // minted deterministic ids must land in comments.xml AND the AST).
  zip.file("word/comments.xml", serializeComments(comments), {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  // Sequential, not Promise.all: comments.xml and commentsExtended.xml both
  // edit [Content_Types].xml and document.xml.rels, so concurrent
  // read-modify-write would drop one part's override/relationship.
  await ensureCommentsContentType(zip, compressionLevel);
  await ensureCommentsRelationship(zip, compressionLevel);

  // (b) commentsExtended.xml: write when there is thread/resolved state,
  // remove the part AND its override AND its relationship when there is none.
  const extendedXml = serializeCommentsExtended(comments);
  const existingExtended = findZipEntryCaseInsensitive(zip, COMMENTS_EXTENDED_PART_LOWER);
  if (extendedXml === null) {
    if (!existingExtended) {
      return;
    }
    zip.remove(existingExtended.name);
    await transformPackagingFile(
      zip,
      "[Content_Types].xml",
      removeCommentsExtendedOverride,
      compressionLevel,
    );
    await transformPackagingFile(
      zip,
      "word/_rels/document.xml.rels",
      removeCommentsExtendedRelationship,
      compressionLevel,
    );
    return;
  }
  zip.file(existingExtended?.name ?? COMMENTS_EXTENDED_PART, extendedXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
  await transformPackagingFile(
    zip,
    "[Content_Types].xml",
    addCommentsExtendedOverride,
    compressionLevel,
  );
  await transformPackagingFile(
    zip,
    "word/_rels/document.xml.rels",
    addCommentsExtendedRelationship,
    compressionLevel,
  );
}

// ============================================================================
// Output handling
// ============================================================================

/**
 * Add any missing canonical `xmlns:` declarations to the `<w:document>` root
 * tag. Existing declarations are never modified; roots that are not
 * `w:document` (alt-prefix producers take the full-regeneration path) are
 * returned unchanged.
 */
function ensureRootNamespaceDeclarations(xml: string): string {
  const rootStart = xml.indexOf("<w:document");
  if (rootStart === -1) {
    return xml;
  }
  const rootEnd = xml.indexOf(">", rootStart);
  if (rootEnd === -1) {
    return xml;
  }
  // oxlint-disable-next-line prefer-set-has -- rootTag is a string; .includes is substring search
  const rootTag = xml.slice(rootStart, rootEnd);
  const missing = DOCUMENT_NAMESPACES.filter(
    ([prefix]) => !rootTag.includes(`xmlns:${prefix}=`),
  );
  if (missing.length === 0) {
    return xml;
  }
  const declarations = missing.map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`).join("");
  return `${xml.slice(0, rootEnd)}${declarations}${xml.slice(rootEnd)}`;
}

function surfaceDiagnostics(
  diagnostics: readonly { severity: string; code: string; message: string }[],
  context: string,
  options: { recoverOpaqueBody?: boolean } = {},
): { opaqueBody: boolean } {
  let opaqueBody = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "opaque-body-passthrough") {
      // The body was byte-preserved instead of regenerated — every model edit
      // in it would be silently dropped. For the main document the caller
      // recovers by regenerating document.xml wholesale from the model (the
      // legacy save's behavior — e.g. for producers that bind
      // WordprocessingML to a non-`w` prefix); anywhere else this must be
      // loud.
      if (options.recoverOpaqueBody) {
        opaqueBody = true;
        continue;
      }
      throw new Error(`jubarte save (${context}): ${diagnostic.code}: ${diagnostic.message}`);
    }
    if (diagnostic.severity !== "info") {
      console.warn(`[jubarte-save] ${context}: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  return { opaqueBody };
}

function outputToArrayBuffer(output: unknown): Promise<ArrayBuffer> {
  if (output instanceof ArrayBuffer) {
    return Promise.resolve(output);
  }
  if (typeof Blob !== "undefined" && output instanceof Blob) {
    return output.arrayBuffer();
  }
  if (ArrayBuffer.isView(output)) {
    const view = output as Uint8Array;
    return Promise.resolve(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
  }
  throw new Error("jubarte save: unexpected writer output type");
}

// ============================================================================
// Main entry points
// ============================================================================

/**
 * Repack a Document into a valid DOCX via jubarte. Same contract as the
 * legacy `repackDocx` (options, mutation of new image/hyperlink rIds,
 * original-buffer requirement, model validation and package fidelity gates).
 */
export async function repackDocxWithJubarte(
  doc: Document,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  // Validate we have an original buffer to base on
  if (!doc.originalBuffer) {
    panic(
      "Cannot repack document: no original buffer for round-trip. " +
        "Use createDocx() for new documents.",
    );
  }
  const { compressionLevel = 6, updateModifiedDate = true, modifiedBy } = options;

  // Reset the drawing/shape auto-id counter per save, mirroring the reset the
  // legacy serializeDocument pass performs.
  resetAutoIdCounter();

  // jubarte's writer byte-preserves the source container, so a damaged
  // end-of-central-directory record in the round-trip baseline would survive
  // into the saved file. Repair it up front (the legacy parser repaired at
  // parse time and saved from the repaired bytes); an unrepairable archive
  // proceeds with the raw bytes and fails loudly downstream.
  const originalBuffer = (await repairDocxArchive(doc.originalBuffer)) ?? doc.originalBuffer;

  const { astPackage } = await readDocxPackage(originalBuffer);
  const shim = graphZipShim(astPackage);

  // Byte-preserved originals the post-passes compare against / splice from —
  // captured before any graph mutation. The note parts are read from the raw
  // original archive, not the package graph: the graph's part text drops the
  // whitespace between the XML declaration and the root element, and the
  // note-splice pass restores these parts VERBATIM when no note was edited.
  const originalDocumentXml = graphPartText(astPackage, "word/document.xml");
  const { footnotesXml: originalFootnotesXml, endnotesXml: originalEndnotesXml } =
    await readOriginalNoteParts(originalBuffer);
  const originalCommentSidecars = captureOriginalCommentSidecars(astPackage);

  // Legacy model-level pre-passes, ported, against the package graph. These
  // mutate rIds in the model so the emitters output correct references.
  await materializeNewHeaderFooterParts(doc, shim, compressionLevel);
  await processNewImages(collectImageParts(doc), shim, compressionLevel);
  await processNewHyperlinks(
    collectHyperlinksWithoutRId(doc.package.document.content),
    shim,
    compressionLevel,
  );

  assertValidFolioDocumentModel(doc, "Cannot repack invalid DOCX document model");

  // Give every reply comment its parent's anchor before serializing, so the
  // reply round-trips with matching commentRange markers + reference.
  applyReplyThreadMarkers(doc);

  // Comments: mint the deterministic threading paraIds BEFORE mapping, so
  // the ids land in both the AST and the post-pass comments.xml rewrite.
  const comments = doc.package.document.comments ?? [];
  ensureThreadedCommentParaIds(comments);

  // Body.
  const bodyCtx = createToAstContext();
  astPackage.document.children = modelBlocksToAstElements(doc.package.document.content, bodyCtx);
  astPackage.document.comments = mapCommentsToAst(comments);

  // Footnotes/endnotes: jubarte keeps source separators byte-preserved and
  // regenerates content notes from these nodes.
  const mappedNotes = mapNotesToAst(doc.package.footnotes ?? [], doc.package.endnotes ?? []);
  astPackage.document.notes = mappedNotes.notes;

  // Rebind picture-watermark image rIds so each header references the image
  // in its own rels — before the header parts are emitted (the synthesized
  // `<v:imagedata r:id>` reads `imageRId`).
  await rebindWatermarkRelIds(doc, shim, compressionLevel);

  // Headers/footers regenerated per part through a synthetic package.
  await writeHeaderFooterParts(doc, astPackage);

  // Splice edited numbering definitions into word/numbering.xml (untouched
  // definitions and the parts the model omits stay byte-exact).
  spliceNumberingIntoGraph(doc, astPackage, shim);

  // docProps/core.xml modification date, mirroring legacy behavior.
  if (updateModifiedDate) {
    const corePart = astPackage.package.parts["docProps/core.xml"];
    if (corePart && typeof corePart.text === "string") {
      astPackage.package.parts["docProps/core.xml"] = {
        ...corePart,
        text: updateCoreProperties(corePart.text, {
          updateModifiedDate,
          ...(modifiedBy !== undefined ? { modifiedBy } : {}),
        }),
      };
    }
  }

  const result = await astToDocxWithDiagnostics(astPackage);
  const { opaqueBody } = surfaceDiagnostics(result.diagnostics, "word/document.xml", {
    recoverOpaqueBody: true,
  });
  const written = await outputToArrayBuffer(result.output);

  return postProcessOutput({
    buffer: written,
    doc,
    regenerateBody: opaqueBody,
    bodyTags: bodyCtx.paragraphTags,
    mappedNotes,
    comments,
    originalDocumentXml,
    originalFootnotesXml,
    originalEndnotesXml,
    originalCommentSidecars,
    compressionLevel,
  });
}

type PostProcessArgs = {
  buffer: ArrayBuffer;
  doc: Document;
  /** Regenerate document.xml wholesale (jubarte could not rewrite the body). */
  regenerateBody: boolean;
  bodyTags: readonly ParagraphTagExpectation[];
  mappedNotes: MappedNotes;
  comments: Comment[];
  originalDocumentXml: string | null;
  originalFootnotesXml: string | null;
  originalEndnotesXml: string | null;
  originalCommentSidecars: OriginalCommentSidecars;
  compressionLevel: number;
};

/**
 * Note-part text straight from the original archive bytes (case-insensitive
 * entry lookup, mirroring the legacy `findNotePartEntry`).
 */
async function readOriginalNoteParts(
  originalBuffer: ArrayBuffer,
): Promise<{ footnotesXml: string | null; endnotesXml: string | null }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(originalBuffer);
  } catch {
    // Damaged archive JSZip cannot read (e.g. truncated end-of-central-
    // directory record) — jubarte's reader repairs it internally, so the
    // save proceeds; only the verbatim note-splice baselines are lost.
    return { footnotesXml: null, endnotesXml: null };
  }
  const read = (lowerPath: string): Promise<string> | null => {
    const entry = findZipEntryCaseInsensitive(zip, lowerPath);
    return entry ? entry.async("text") : null;
  };
  const footnotes = read("word/footnotes.xml");
  const endnotes = read("word/endnotes.xml");
  return {
    footnotesXml: footnotes === null ? null : await footnotes,
    endnotesXml: endnotes === null ? null : await endnotes,
  };
}

/**
 * Restore legacy full-repack note fidelity: jubarte regenerates the note
 * parts from the model (dropping unmodeled markup such as the in-note
 * `w:footnoteRef` auto-number runs), but the legacy save spliced only the
 * EDITED note paragraphs into the ORIGINAL part bytes, keeping separators
 * and every unedited note byte-exact.
 *
 * "Edited" is detected exactly the legacy way: the model's note
 * serialization is compared per-paraId against a BASELINE that re-parses
 * and re-serializes the original part; both sides share the same (lossy)
 * parse+serialize, so only genuine body edits differ. No edit ⇒ the
 * original part is restored verbatim; edits ⇒ they are spliced into the
 * original bytes; an unspliceable edit keeps jubarte's regenerated part
 * (edits land, at the cost of byte-exactness of the unedited remainder).
 */
function spliceNotePart<TNote>(
  zip: JSZip,
  path: string,
  notes: readonly TNote[],
  serializeNotes: (notes: readonly TNote[]) => string,
  parseBaselineNotes: (xml: string) => TNote[],
  originalXml: string | null,
): void {
  if (originalXml === null) {
    return;
  }
  if (notes.length === 0) {
    // No model notes (separator-only part, or notes not parsed): the legacy
    // save never rewrote the part — restore it verbatim.
    zip.file(path, originalXml);
    return;
  }
  const currentXml = serializeNotes(notes);
  const baselineXml = serializeNotes(parseBaselineNotes(originalXml));
  const changedIds = collectChangedNoteParaIds(baselineXml, currentXml);
  if (changedIds.size === 0) {
    zip.file(path, originalXml);
    return;
  }
  const patched = buildPatchedNoteXml(originalXml, currentXml, changedIds);
  if (patched !== null) {
    zip.file(path, patched);
  }
}

/**
 * The note paragraphs whose current serialization differs from the baseline
 * (re-parsed original) serialization — i.e. the ones actually edited. A
 * paragraph is only considered when its `paraId` resolves uniquely in both,
 * so it can be spliced safely. Ported from the legacy rezip.ts.
 */
function collectChangedNoteParaIds(baselineXml: string, currentXml: string): Set<string> {
  const changed = new Set<string>();
  const baselineIds = collectParaIds(baselineXml);
  for (const [id, count] of collectParaIds(currentXml)) {
    if (count !== 1 || baselineIds.get(id) !== 1) {
      continue;
    }
    const before = extractParagraphXml(baselineXml, id);
    const after = extractParagraphXml(currentXml, id);
    if (before !== null && after !== null && before !== after) {
      changed.add(id);
    }
  }
  return changed;
}

async function postProcessOutput(args: PostProcessArgs): Promise<ArrayBuffer> {
  const {
    buffer,
    doc,
    regenerateBody,
    bodyTags,
    mappedNotes,
    comments,
    originalDocumentXml,
    originalFootnotesXml,
    originalEndnotesXml,
    originalCommentSidecars,
    compressionLevel,
  } = args;
  const zip = await JSZip.loadAsync(buffer);

  // The legacy save copies only entries passing the `isPreservableDocxEntry`
  // sanitation allowlist (safe paths, allowlisted media MIME types, XML parts
  // under known roots — e.g. `docProps/thumbnail.jpeg` is dropped). jubarte
  // byte-preserves every part, so apply the same filter to its output.
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && !isPreservableDocxEntry(path)) {
      zip.remove(path);
    }
  }

  const documentFile = zip.file("word/document.xml");
  if (regenerateBody) {
    // jubarte byte-preserved the body (opaque-body-passthrough): regenerate
    // document.xml from the model with the ported legacy serializer. The
    // emitted paragraphs already carry their `w14:paraId`s and the final
    // `<w:sectPr>`, so the stamping and sectPr-swap passes are skipped.
    const xml = emitFullDocumentXml(doc);
    if (originalDocumentXml !== null) {
      assertDocumentPackageFidelity(originalDocumentXml, xml, doc);
    }
    zip.file("word/document.xml", xml);
  } else if (documentFile) {
    let xml = await documentFile.async("text");
    // The writer regenerates body blocks with folio's emitters, whose output
    // relies on the canonical prefix set (wp/a/pic on drawings, w16* on raw
    // SDT replays). A source whose root declares only a minimal set (a
    // third-party producer) would end up with undeclared prefixes — the
    // legacy save always rewrote the root with the full set, so add any
    // missing declarations before stamping.
    xml = ensureRootNamespaceDeclarations(xml);
    const stamped = declaresW14(xml) ? stampParagraphTags(xml, bodyTags) : xml;
    if (stamped === null) {
      console.warn(
        "[jubarte-save] paragraph tag count mismatch in word/document.xml; skipping paraId re-stamp",
      );
    } else {
      xml = stamped;
    }
    xml = replaceTrailingSectPr(xml, doc.package.document.finalSectionProperties);
    if (originalDocumentXml !== null) {
      assertDocumentPackageFidelity(originalDocumentXml, xml, doc);
    }
    zip.file("word/document.xml", xml);
  }

  await restampNotesPart(
    zip,
    "word/footnotes.xml",
    "w:footnote",
    mappedNotes,
    originalFootnotesXml,
  );
  await restampNotesPart(zip, "word/endnotes.xml", "w:endnote", mappedNotes, originalEndnotesXml);

  spliceNotePart(
    zip,
    "word/footnotes.xml",
    doc.package.footnotes ?? [],
    serializeFootnotes,
    (xml) => parseFootnotes(xml).getNormalFootnotes(),
    originalFootnotesXml,
  );
  spliceNotePart(
    zip,
    "word/endnotes.xml",
    doc.package.endnotes ?? [],
    serializeEndnotes,
    (xml) => parseEndnotes(xml).getNormalEndnotes(),
    originalEndnotesXml,
  );

  await rewriteCommentSidecars(zip, comments, originalCommentSidecars, compressionLevel);

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Create a new DOCX from a Document without an original buffer — legacy
 * `createDocx` semantics: fabricate the empty-DOCX scaffold as the baseline,
 * then run the same repack path over it.
 */
export async function createDocxWithJubarte(doc: Document): Promise<ArrayBuffer> {
  const emptyBuffer = await createEmptyDocxScaffold();
  const docWithBuffer: Document = { ...doc, originalBuffer: emptyBuffer };
  return repackDocxWithJubarte(docWithBuffer);
}
