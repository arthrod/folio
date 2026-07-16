// PORT (jubarte save path): core-properties update, empty-DOCX scaffold, and
// the package fidelity gate lifted from docx/rezip.ts. rezip.ts imports the
// legacy serializer tree at module level, so these are ported rather than
// imported; behavior is identical.
// Deleted together with docx/rezip.ts when the legacy save is removed.

import JSZip from "jszip";

import type { Document } from "../../../types/document";
import { escapeXml } from "./xmlUtils";

// ============================================================================
// PACKAGE FIDELITY GATE
// ============================================================================

export class DocxPackageFidelityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxPackageFidelityError";
  }
}

const countDocumentSections = (xml: string): number =>
  Array.from(xml.matchAll(/<w:sectPr\b/gu)).length;

type HeaderFooterReference = {
  element: "headerReference" | "footerReference";
  type: string;
  rId: string;
};

const extractHeaderFooterReferences = (xml: string): HeaderFooterReference[] => {
  const references: HeaderFooterReference[] = [];
  const pattern = /<w:(?<element>headerReference|footerReference)\b[^>]*>/gu;
  for (const match of xml.matchAll(pattern)) {
    const tag = match[0];
    const type = /\bw:type="(?<type>[^"]+)"/u.exec(tag)?.groups?.["type"] ?? "default";
    const rId = /\br:id="(?<rId>[^"]+)"/u.exec(tag)?.groups?.["rId"];
    const element = match.groups?.["element"];
    if (!rId || (element !== "headerReference" && element !== "footerReference")) {
      continue;
    }
    references.push({ element, type, rId });
  }
  return references;
};

const hasParsedHeaderFooterPart = (doc: Document, ref: HeaderFooterReference): boolean => {
  const map = ref.element === "headerReference" ? doc.package.headers : doc.package.footers;
  return map?.has(ref.rId) ?? false;
};

/**
 * Throws {@link DocxPackageFidelityError} when the serialized document.xml
 * would drop sections or header/footer references present in the original —
 * a model-vs-original check independent of which engine emitted the XML.
 */
export function assertDocumentPackageFidelity(
  originalDocumentXml: string,
  serializedDocumentXml: string,
  doc: Document,
): void {
  const originalSectionCount = countDocumentSections(originalDocumentXml);
  const serializedSectionCount = countDocumentSections(serializedDocumentXml);
  if (serializedSectionCount < originalSectionCount) {
    throw new DocxPackageFidelityError(
      "Full DOCX repack would drop section properties. Use selective patching instead.",
    );
  }

  const serializedRefs = new Set(
    extractHeaderFooterReferences(serializedDocumentXml).map(
      (ref) => `${ref.element}:${ref.type}:${ref.rId}`,
    ),
  );
  const missingRefs = extractHeaderFooterReferences(originalDocumentXml).filter(
    (ref) =>
      hasParsedHeaderFooterPart(doc, ref) &&
      !serializedRefs.has(`${ref.element}:${ref.type}:${ref.rId}`),
  );
  if (missingRefs.length > 0) {
    throw new DocxPackageFidelityError(
      "Full DOCX repack would drop header/footer references. Use selective patching instead.",
    );
  }
}

// ============================================================================
// CORE PROPERTIES
// ============================================================================

/**
 * Update core properties XML with new modification date
 */
export function updateCoreProperties(
  corePropsXml: string,
  options: { updateModifiedDate?: boolean; modifiedBy?: string },
): string {
  let result = corePropsXml;

  if (options.updateModifiedDate) {
    const now = new Date().toISOString();

    // Update dcterms:modified
    if (result.includes("<dcterms:modified")) {
      result = result.replace(
        /<dcterms:modified[^<>]*>[^<]*<\/dcterms:modified>/u,
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`,
      );
    } else {
      // Add modified date if not present
      result = result.replace(
        "</cp:coreProperties>",
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
      );
    }
  }

  if (options.modifiedBy) {
    // Update cp:lastModifiedBy
    if (result.includes("<cp:lastModifiedBy")) {
      result = result.replace(
        /<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/u,
        `<cp:lastModifiedBy>${escapeXml(options.modifiedBy)}</cp:lastModifiedBy>`,
      );
    } else {
      // Add lastModifiedBy if not present
      result = result.replace(
        "</cp:coreProperties>",
        `<cp:lastModifiedBy>${escapeXml(options.modifiedBy)}</cp:lastModifiedBy></cp:coreProperties>`,
      );
    }
  }

  return result;
}

// ============================================================================
// EMPTY DOCX SCAFFOLD
// ============================================================================

/**
 * Create a new empty DOCX file
 *
 * @returns Promise resolving to minimal DOCX as ArrayBuffer
 */
export function createEmptyDocxScaffold(): Promise<ArrayBuffer> {
  const zip = new JSZip();

  // Content Types
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
  );

  // Package relationships
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );

  // Document relationships
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );

  // Document. DEVIATION from the legacy scaffold (rezip.ts createEmptyDocx),
  // which declares only `w`/`r`: jubarte's writer PRESERVES the source
  // document root, while the legacy save rewrites it with the document
  // serializer's full canonical namespace set. Declaring that same set here
  // makes the created package's root match the legacy `createDocx` output —
  // and keeps `w14:paraId` re-stamping legal on the regenerated body.
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14">
  <w:body>
    <w:p>
      <w:r>
        <w:t></w:t>
      </w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`,
  );

  // Minimal styles
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
        <w:sz w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="200" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`,
  );

  // Core properties
  const now = new Date().toISOString();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>EigenPal DOCX Editor</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
  );

  // App properties
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>EigenPal DOCX Editor</Application>
  <AppVersion>1.0.0</AppVersion>
</Properties>`,
  );

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
