/**
 * DOCX Repacker - Repack modified document into valid DOCX
 *
 * `repackDocx`/`createDocx` are backed by `@arthrod/jubarte`: the original
 * buffer is read into jubarte's byte-preserved package graph, the model is
 * mapped onto the AST, and jubarte's writer regenerates only the parts that
 * changed (see ./jubarte/saveDocx). Untouched parts — styles.xml, theme,
 * fontTable, media, relationships, docProps — round-trip byte-identical.
 *
 * The generic zip utilities (selective XML updates, relationship/media
 * insertion, core-properties maintenance, validation) live here unchanged;
 * they operate on raw DOCX buffers and have no serializer dependency.
 */

import { panic } from "better-result";
import JSZip from "jszip";

import type { HeaderFooter } from "../types/content";
import type { Document } from "../types/document";
import { serializeHeaderFooter } from "./jubarte/emit/headerFooterSerializer";
import { findMaxRId, getContentTypeForExtension } from "./jubarte/emit/relsUtils";
import { escapeXml } from "./jubarte/emit/xmlUtils";
import { createDocxWithJubarte, repackDocxWithJubarte } from "./jubarte/saveDocx";
import type { RepackOptions } from "./jubarte/saveDocx";
import { RELATIONSHIP_TYPES, resolveRelativePath } from "./relsParser";
import type { RawDocxContent } from "./unzip";

// Public re-exports (preserve the historical deep-import surface).
export type { RepackOptions } from "./jubarte/saveDocx";
export { DocxPackageFidelityError } from "./jubarte/emit/packageMaintenance";
export { findMaxRId } from "./jubarte/emit/relsUtils";
export { updateCoreProperties } from "./jubarte/emit/packageMaintenance";
export {
  COMMENTS_CONTENT_TYPE,
  COMMENTS_EXTENDED_CONTENT_TYPE,
  COMMENTS_EXTENDED_PART,
  COMMENTS_EXTENDED_PART_LOWER,
  addCommentsExtendedOverride,
  removeCommentsExtendedOverride,
  addCommentsExtendedRelationship,
  removeCommentsExtendedRelationship,
  hasUnmaterializedHeaderFooterPart as hasUnmaterializedHeaderFooter,
} from "./jubarte/emit/packaging";
export { createEmptyDocxScaffold as createEmptyDocx } from "./jubarte/emit/packageMaintenance";

// ============================================================================
// MAIN REPACKER
// ============================================================================

/**
 * Repack a Document into a valid DOCX file
 *
 * @param doc - Document with modified content
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 * @throws {Error} if document has no original buffer for round-trip
 */
export function repackDocx(doc: Document, options: RepackOptions = {}): Promise<ArrayBuffer> {
  return repackDocxWithJubarte(doc, options);
}

/**
 * Repack a Document using an already-loaded ZIP as the round-trip baseline
 * instead of `doc.originalBuffer`.
 *
 * @param doc - Document with modified content
 * @param rawContent - Original raw content from unzipDocx (the baseline
 *   archive is taken from `rawContent.originalZip`)
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function repackDocxFromRaw(
  doc: Document,
  rawContent: RawDocxContent,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const baseline = await rawContent.originalZip.generateAsync({ type: "arraybuffer" });
  return repackDocxWithJubarte({ ...doc, originalBuffer: baseline }, options);
}

// ============================================================================
// SELECTIVE UPDATES
// ============================================================================

/**
 * Update only document.xml in a DOCX buffer (minimal changes)
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param newDocumentXml - New document.xml content
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function updateDocumentXml(
  originalBuffer: ArrayBuffer,
  newDocumentXml: string,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const { compressionLevel = 6 } = options;

  // Load original ZIP
  const zip = await JSZip.loadAsync(originalBuffer);

  // Update document.xml
  zip.file("word/document.xml", newDocumentXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  // Generate new DOCX
  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Update a specific XML file in a DOCX buffer
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param path - Path within the ZIP (e.g., "word/styles.xml")
 * @param content - New XML content
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function updateXmlFile(
  originalBuffer: ArrayBuffer,
  path: string,
  content: string,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const { compressionLevel = 6 } = options;

  const zip = await JSZip.loadAsync(originalBuffer);

  zip.file(path, content, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Update multiple files in a DOCX buffer
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param updates - Map of path -> content for files to update
 * @param options - Optional repack options
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export async function updateMultipleFiles(
  originalBuffer: ArrayBuffer,
  updates: Map<string, string | ArrayBuffer>,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  return applyUpdatesToZip(zip, updates, options);
}

/**
 * Apply file updates to an already-loaded JSZip instance and generate the output.
 * Use this when the zip is already loaded to avoid a redundant decompression pass.
 */
export function applyUpdatesToZip(
  zip: JSZip,
  updates: Map<string, string | ArrayBuffer>,
  options: RepackOptions = {},
): Promise<ArrayBuffer> {
  const { compressionLevel = 6 } = options;

  for (const [path, content] of updates) {
    zip.file(path, content, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }

  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

// ============================================================================
// RELATIONSHIP MANAGEMENT
// ============================================================================

/**
 * Add a new relationship to document.xml.rels
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param relationship - New relationship to add
 * @returns Promise resolving to { buffer: ArrayBuffer, rId: string }
 */
export async function addRelationship(
  originalBuffer: ArrayBuffer,
  relationship: {
    type: string;
    target: string;
    targetMode?: "External" | "Internal";
  },
): Promise<{ buffer: ArrayBuffer; rId: string }> {
  const zip = await JSZip.loadAsync(originalBuffer);

  // Read existing relationships
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);

  if (!relsFile) {
    panic("document.xml.rels not found in DOCX");
  }

  const relsXml = await relsFile.async("text");

  // Generate new rId
  const newRId = `rId${findMaxRId(relsXml) + 1}`;

  // Build new relationship element
  const targetModeAttr = relationship.targetMode === "External" ? ' TargetMode="External"' : "";

  const newRelElement = `<Relationship Id="${newRId}" Type="${relationship.type}" Target="${escapeXml(relationship.target)}"${targetModeAttr}/>`;

  // Insert before closing tag
  const updatedRelsXml = relsXml.replace("</Relationships>", `${newRelElement}</Relationships>`);

  // Update the ZIP
  zip.file(relsPath, updatedRelsXml);

  const buffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return { buffer, rId: newRId };
}

/**
 * Add a media file to the DOCX
 *
 * @param originalBuffer - Original DOCX as ArrayBuffer
 * @param filename - Filename for the media (e.g., "image1.png")
 * @param data - Binary data for the media file
 * @param mimeType - MIME type (e.g., "image/png")
 * @returns Promise resolving to { buffer: ArrayBuffer, rId: string, path: string }
 */
export async function addMedia(
  originalBuffer: ArrayBuffer,
  filename: string,
  data: ArrayBuffer,
  mimeType: string,
): Promise<{ buffer: ArrayBuffer; rId: string; path: string }> {
  const zip = await JSZip.loadAsync(originalBuffer);

  // Determine media path
  const mediaPath = `word/media/${filename}`;

  // Add media file
  zip.file(mediaPath, data);

  // Add relationship
  const relResult = await addRelationship(await zip.generateAsync({ type: "arraybuffer" }), {
    type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    target: `media/${filename}`,
  });

  // Update content types if needed
  const contentTypesFile = zip.file("[Content_Types].xml");
  if (contentTypesFile) {
    const contentTypesXml = await contentTypesFile.async("text");
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    // Check if extension is already registered
    const hasExtension = contentTypesXml.includes(`Extension="${extension}"`);

    if (!hasExtension && extension) {
      // Add content type for this extension
      const contentType = getContentTypeForExtension(extension, mimeType);
      const extensionElement = `<Default Extension="${extension}" ContentType="${contentType}"/>`;

      // Insert after other defaults
      const updatedContentTypes = contentTypesXml.replace(
        "</Types>",
        `${extensionElement}</Types>`,
      );

      const finalZip = await JSZip.loadAsync(relResult.buffer);
      finalZip.file("[Content_Types].xml", updatedContentTypes);

      return {
        buffer: await finalZip.generateAsync({
          type: "arraybuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        }),
        rId: relResult.rId,
        path: mediaPath,
      };
    }
  }

  return {
    buffer: relResult.buffer,
    rId: relResult.rId,
    path: mediaPath,
  };
}

// ============================================================================
// HEADER/FOOTER SERIALIZATION
// ============================================================================

/**
 * A picture watermark is "model-driven" when its raw VML was cleared (so the
 * save synthesizes `<v:imagedata r:id>` from `imageRId`). Historically the
 * selective fast-path bailed to the full repack whenever one was present;
 * the jubarte save performs the per-header image relationship rebinding
 * itself, so this predicate remains only as a public helper.
 */
export function hasModelDrivenPictureWatermark(doc: Document): boolean {
  const headers = doc.package.headers;
  if (!headers) {
    return false;
  }
  for (const hf of headers.values()) {
    if (hf.watermark?.kind === "picture" && !hf.rawWatermarkXml) {
      return true;
    }
  }
  return false;
}

/**
 * Collect serialized header/footer XML updates from the document model.
 * Uses the relationship map to resolve rId → filename.
 */
export function collectHeaderFooterUpdates(doc: Document): Map<string, string> {
  const updates = new Map<string, string>();
  const rels = doc.package.relationships;
  if (!rels) {
    return updates;
  }

  const documentRelsPath = "word/_rels/document.xml.rels";
  const parts: {
    map: Map<string, HeaderFooter> | undefined;
    type: string;
  }[] = [
    { map: doc.package.headers, type: RELATIONSHIP_TYPES.header },
    { map: doc.package.footers, type: RELATIONSHIP_TYPES.footer },
  ];

  for (const { map, type } of parts) {
    if (!map) {
      continue;
    }
    for (const [rId, headerFooter] of map.entries()) {
      const rel = rels.get(rId);
      if (rel && rel.type === type && rel.target) {
        const filename = resolveRelativePath(documentRelsPath, rel.target);
        updates.set(filename, serializeHeaderFooter(headerFooter));
      }
    }
  }

  return updates;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that a buffer is a valid DOCX file
 *
 * @param buffer - Buffer to validate
 * @returns Promise resolving to validation result
 */
export async function validateDocx(buffer: ArrayBuffer): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const zip = await JSZip.loadAsync(buffer);

    // Check for required files
    const requiredFiles = ["[Content_Types].xml", "word/document.xml"];

    for (const file of requiredFiles) {
      if (!zip.file(file)) {
        errors.push(`Missing required file: ${file}`);
      }
    }

    // Check for recommended files
    const recommendedFiles = ["_rels/.rels", "word/_rels/document.xml.rels", "word/styles.xml"];

    for (const file of recommendedFiles) {
      if (!zip.file(file)) {
        warnings.push(`Missing recommended file: ${file}`);
      }
    }

    // Validate document.xml is valid XML
    const docFile = zip.file("word/document.xml");
    if (docFile) {
      const docXml = await docFile.async("text");

      // Basic XML validation
      if (!docXml.includes("<?xml")) {
        warnings.push("document.xml missing XML declaration");
      }

      if (!docXml.includes("<w:document")) {
        errors.push("document.xml missing w:document element");
      }

      if (!docXml.includes("<w:body>")) {
        errors.push("document.xml missing w:body element");
      }
    }

    // Validate Content_Types.xml
    const ctFile = zip.file("[Content_Types].xml");
    if (ctFile) {
      const ctXml = await ctFile.async("text");

      if (
        !ctXml.includes("word/document.xml") &&
        !ctXml.includes(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        )
      ) {
        warnings.push("Content_Types.xml may be missing document.xml type declaration");
      }
    }
  } catch (error) {
    errors.push(
      `Failed to read as ZIP: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if buffer looks like a DOCX file (quick check)
 *
 * @param buffer - Buffer to check
 * @returns true if buffer starts with ZIP signature
 */
export function isDocxBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) {
    return false;
  }

  const view = new Uint8Array(buffer);

  // ZIP file signature: PK (0x50, 0x4B)
  return view[0] === 0x50 && view[1] === 0x4b;
}

// ============================================================================
// CREATE NEW DOCX
// ============================================================================

/**
 * Create a new DOCX from a Document (without requiring original buffer)
 *
 * @param doc - Document to serialize
 * @returns Promise resolving to DOCX as ArrayBuffer
 */
export function createDocx(doc: Document): Promise<ArrayBuffer> {
  return createDocxWithJubarte(doc);
}

// ============================================================================
// EXPORTS
// ============================================================================

export default repackDocx;
