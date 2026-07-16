// PORT (jubarte save path): full document.xml serializer lifted from the
// deleted docx/serializer/documentSerializer.ts, re-based onto the emit
// ports. Used as the save orchestrator's fallback when jubarte's AST writer
// cannot regenerate the body (opaque-body-passthrough — e.g. a producer
// bound WordprocessingML to a non-`w` prefix): the legacy save always
// regenerated document.xml from the model, so the fallback restores exactly
// that behavior.

import type { BlockContent, Document, DocumentBody } from "../../../types/document";
import { serializeBlockSdt } from "./blockSdtSerializer";
import { serializeParagraph } from "./paragraphSerializer";
import { serializeSectionProperties } from "./sectionPropertiesSerializer";
import { serializeTable } from "./tableSerializer";

/**
 * Namespace declarations for the document root. Declares every namespace the
 * parser preserves verbatim through `rawPropertiesXml` / `rawEndPropertiesXml`
 * (and any other raw replay path): a canonical `<w:sdtPr>` legitimately
 * contains `<w16sdtdh:dataHash>` / `<w16cex:*>` / `<w16cid:*>` children that
 * the parser stores opaquely; without these declarations on the document
 * root, the replayed XML would carry undefined prefixes and Word refuses to
 * open the file.
 */
export const DOCUMENT_NAMESPACES: readonly (readonly [prefix: string, uri: string])[] = [
  ["wpc", "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"],
  ["mc", "http://schemas.openxmlformats.org/markup-compatibility/2006"],
  ["o", "urn:schemas-microsoft-com:office:office"],
  ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
  ["m", "http://schemas.openxmlformats.org/officeDocument/2006/math"],
  ["v", "urn:schemas-microsoft-com:vml"],
  ["wp14", "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"],
  ["wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"],
  ["w10", "urn:schemas-microsoft-com:office:word"],
  ["w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"],
  ["w14", "http://schemas.microsoft.com/office/word/2010/wordml"],
  ["w15", "http://schemas.microsoft.com/office/word/2012/wordml"],
  ["w16", "http://schemas.microsoft.com/office/word/2018/wordml"],
  ["w16cex", "http://schemas.microsoft.com/office/word/2018/wordml/cex"],
  ["w16cid", "http://schemas.microsoft.com/office/word/2016/wordml/cid"],
  ["w16sdtdh", "http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash"],
  ["w16se", "http://schemas.microsoft.com/office/word/2015/wordml/symex"],
  ["wpg", "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"],
  ["wps", "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"],
];

const NAMESPACE_DECLARATIONS = DOCUMENT_NAMESPACES.map(
  ([prefix, uri]) => `xmlns:${prefix}="${uri}"`,
).join(" ");

function serializeBlockContent(block: BlockContent): string {
  if (block.type === "paragraph") {
    return serializeParagraph(block);
  }
  if (block.type === "table") {
    return serializeTable(block);
  }
  return serializeBlockSdt(block, serializeBlockContent);
}

/** Body-inner XML: all blocks followed by the final `<w:sectPr>` when present. */
export function serializeDocumentBody(body: DocumentBody): string {
  const blocks = body.content.map((block) => serializeBlockContent(block)).join("");
  const finalSectPr = body.finalSectionProperties
    ? serializeSectionProperties(body.finalSectionProperties)
    : "";
  return blocks + finalSectPr;
}

/** Full document.xml payload, shaped like the legacy `serializeDocument`. */
export function serializeDocument(doc: Document): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${NAMESPACE_DECLARATIONS} mc:Ignorable="w14 w15 wp14">` +
    `<w:body>${serializeDocumentBody(doc.package.document)}</w:body>` +
    "</w:document>"
  );
}
