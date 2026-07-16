/**
 * Jubarte-backed parseDocx — same contract as the legacy parser orchestrator
 * (docx/parser.ts), with all DOCX byte/XML de-serialization done by
 * `@arthrod/jubarte` and structure mapped through {@link ./fromAst}.
 *
 * Part interpretation (styles/theme/settings/numbering) runs the core's
 * existing interpreters over the byte-preserved part text from the jubarte
 * package graph. Stage order, progress strings, normalization passes,
 * warnings, validation, and error wrapping mirror the legacy orchestrator
 * exactly — the parity harness diffs the two Document models field by field.
 */

import type {
  Document,
  DocumentBody,
  DocxPackage,
  Endnote,
  Footnote,
  HeaderFooter,
  MediaFile,
  StyleDefinitions,
  Theme,
} from "../../types/document";
import type { DocxInput } from "../../utils/docxInput";
import { toArrayBuffer } from "../../utils/docxInput";
import { loadFontsWithMapping } from "../../utils/fontLoader";
import { normalizeCommentReferences } from "../commentReferenceNormalization";
import { extractAllTemplateVariables } from "../documentParser";
import { DocxEncryptionError } from "../encryption/errors";
import { decryptDocxIfNeeded } from "../encryption/openEncryptedDocx";
import { normalizeHeaderFooterReferences } from "../headerFooterReferenceNormalization";
import {
  DocxModelValidationError,
  formatDocumentModelIssues,
  validateFolioDocumentModel,
} from "../modelValidation";
import { parseNumbering } from "../numberingParser";
import { normalizeNumberingReferences } from "../numberingReferenceNormalization";
import { DocxParseError } from "../parser";
import type { MediaResolver, ParseOptions } from "../parser";
import { parseSettings } from "../settingsParser";
import { parseStylesPackage } from "../styleParser";
import type { StyleMap } from "../styleParser";
import { applyThemeFontLang, parseTheme } from "../themeParser";
import { normalizeTrackedMoveRanges } from "../trackedMoveRangeNormalization";
import type { FromAstContext } from "./fromAst";
import { mapComments, mapDocumentBody, mapHeadersFooters, mapNotes } from "./fromAst";
import {
  buildMediaMapFromPackage,
  buildRelationshipMap,
  extractFinalSectPrXml,
  partText,
  readDocxPackage,
} from "./readPackage";

/**
 * Parse a DOCX file into a complete Document model via jubarte.
 * Mirrors the legacy `parseDocx` contract (options, progress stages,
 * normalization passes, validation, assembled package shape).
 */
export async function parseDocxWithJubarte(
  input: DocxInput,
  options: ParseOptions = {},
): Promise<Document> {
  const inputBuffer = input instanceof ArrayBuffer ? input : await toArrayBuffer(input);
  const {
    // oxlint-disable-next-line no-empty-function -- intentional no-op default
    onProgress = () => {},
    preloadFonts = true,
    parseHeadersFooters = true,
    parseNotes = true,
    detectVariables = true,
    password,
    // Accepted for signature parity with the legacy parser but not forwarded:
    // jubarte enforces its own zip-security policy inside docxToAst. Mapping
    // folio's DocxUnzipOptions onto jubarte's ZipLimits is deferred until the
    // walker lands and the parity harness can observe the limits.
    unzipLimits: _unzipLimits,
    mediaResolver,
  } = options;

  const warnings: string[] = [];

  try {
    // ========================================================================
    // STAGE 1: Read DOCX package (0-10%)
    // ========================================================================
    onProgress("Extracting DOCX...", 0);
    // Encrypted CFB containers go through the existing OFFCRYPTO path before
    // jubarte ever sees bytes; jubarte only receives a plain OOXML ZIP.
    const { data: buffer, wasEncrypted } = await decryptDocxIfNeeded(inputBuffer, { password });
    if (wasEncrypted) {
      warnings.push(
        "Document was opened from password-protected storage; saving writes an unencrypted .docx file.",
      );
    }
    const {
      astPackage,
      warnings: readWarnings,
      buffer: packageBuffer,
    } = await readDocxPackage(buffer);
    warnings.push(...readWarnings);
    onProgress("Extracted DOCX", 10);

    // ========================================================================
    // STAGE 2: Parse relationships (10-15%)
    // ========================================================================
    onProgress("Parsing relationships...", 10);
    const rels = buildRelationshipMap(
      astPackage,
      astPackage.package.mainDocumentPath || "word/document.xml",
    );
    onProgress("Parsed relationships", 15);

    // ========================================================================
    // STAGE 3: Parse theme (15-20%)
    // ========================================================================
    onProgress("Parsing theme...", 15);
    const theme = parseTheme(partText(astPackage, "word/theme/theme1.xml"));
    // Settings must be read before styles so `w:themeFontLang` can fill the
    // theme's empty EastAsian/complex-script slots (eigenpal/docx-editor#949);
    // styles, body, and header/footer parsing all resolve theme fonts off this
    // mutated theme object.
    const settings = parseSettings(partText(astPackage, "word/settings.xml"));
    applyThemeFontLang(theme, settings.themeFontLang);
    onProgress("Parsed theme", 20);

    // ========================================================================
    // STAGE 4: Parse styles (20-30%)
    // ========================================================================
    onProgress("Parsing styles...", 20);
    let styles: StyleMap | null = null;
    let styleDefinitions: StyleDefinitions | undefined;

    const stylesXml = partText(astPackage, "word/styles.xml");
    if (stylesXml) {
      const parsedStyles = parseStylesPackage(stylesXml, theme);
      styles = parsedStyles.styles;
      styleDefinitions = parsedStyles.styleDefinitions;
    }
    onProgress("Parsed styles", 30);

    // ========================================================================
    // STAGE 5: Parse numbering (30-35%)
    // ========================================================================
    onProgress("Parsing numbering...", 30);
    const numbering = parseNumbering(partText(astPackage, "word/numbering.xml"));
    onProgress("Parsed numbering", 35);

    // ========================================================================
    // STAGE 6: Build media file map (35-40%)
    // ========================================================================
    onProgress("Processing media files...", 35);
    const media = await buildMediaMapFromPackage(astPackage, warnings);
    if (mediaResolver) {
      await applyMediaResolver(media, mediaResolver);
    }
    onProgress("Processed media", 40);

    const ctx: FromAstContext = {
      styles,
      theme,
      numbering,
      rels,
      media,
      warnings,
    };

    // ========================================================================
    // STAGE 7: Parse document body (40-55%)
    // ========================================================================
    onProgress("Parsing document body...", 40);
    const finalSectPrXml = extractFinalSectPrXml(astPackage);
    const documentBody: DocumentBody = mapDocumentBody(astPackage, finalSectPrXml, ctx);
    onProgress("Parsed document body", 55);

    // ========================================================================
    // STAGE 8: Parse headers/footers (55-65%)
    // ========================================================================
    let headers: Map<string, HeaderFooter> | undefined;
    let footers: Map<string, HeaderFooter> | undefined;

    if (parseHeadersFooters) {
      onProgress("Parsing headers/footers...", 55);
      const hf = await mapHeadersFooters(astPackage, ctx);
      headers = hf.headers;
      footers = hf.footers;
      onProgress("Parsed headers/footers", 65);
    } else {
      onProgress("Skipping headers/footers", 65);
    }

    // ========================================================================
    // STAGE 9: Parse footnotes/endnotes (65-75%)
    // ========================================================================
    let footnotes: Footnote[] | undefined;
    let endnotes: Endnote[] | undefined;

    if (parseNotes) {
      onProgress("Parsing footnotes/endnotes...", 65);
      const notes = mapNotes(astPackage, ctx);
      footnotes = notes.footnotes;
      endnotes = notes.endnotes;
      onProgress("Parsed footnotes/endnotes", 75);
    } else {
      onProgress("Skipping footnotes/endnotes", 75);
    }

    // ========================================================================
    // STAGE 9b: Parse comments (75-77%)
    // ========================================================================
    onProgress("Parsing comments...", 75);
    const comments = mapComments(astPackage, ctx);
    if (comments.length > 0) {
      documentBody.comments = comments;
    }
    const commentReferenceNormalization = normalizeCommentReferences({
      documentBody,
      comments,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
    });
    if (commentReferenceNormalization.removedDanglingReferences > 0) {
      warnings.push(
        `Removed ${commentReferenceNormalization.removedDanglingReferences} dangling comment reference marker(s) whose comments.xml entries are missing.`,
      );
    }
    if (commentReferenceNormalization.reanchoredUnbalancedRanges > 0) {
      warnings.push(
        `Re-anchored ${commentReferenceNormalization.reanchoredUnbalancedRanges} unbalanced comment range marker(s) as point comments.`,
      );
    }
    const headerFooterReferenceNormalization = normalizeHeaderFooterReferences({
      documentBody,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
    });
    if (headerFooterReferenceNormalization.removedDanglingHeaderReferences > 0) {
      warnings.push(
        `Removed ${headerFooterReferenceNormalization.removedDanglingHeaderReferences} dangling header reference(s) whose header parts are missing.`,
      );
    }
    if (headerFooterReferenceNormalization.removedDanglingFooterReferences > 0) {
      warnings.push(
        `Removed ${headerFooterReferenceNormalization.removedDanglingFooterReferences} dangling footer reference(s) whose footer parts are missing.`,
      );
    }
    const numberingReferenceNormalization = normalizeNumberingReferences({
      documentBody,
      numbering,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
    });
    if (numberingReferenceNormalization.removedMissingNumberingReferences > 0) {
      warnings.push(
        `Removed ${numberingReferenceNormalization.removedMissingNumberingReferences} numbering reference(s) whose numbering definitions are missing.`,
      );
    }
    const trackedMoveRangeNormalization = normalizeTrackedMoveRanges({
      documentBody,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
    });
    if (trackedMoveRangeNormalization.removedUnbalancedMoveRangeMarkers > 0) {
      warnings.push(
        `Removed ${trackedMoveRangeNormalization.removedUnbalancedMoveRangeMarkers} unbalanced tracked move range marker(s).`,
      );
    }

    // ========================================================================
    // STAGE 10: Detect template variables (77-80%)
    // ========================================================================
    let templateVariables: string[] | undefined;

    if (detectVariables) {
      onProgress("Detecting template variables...", 75);
      templateVariables = extractAllTemplateVariables(documentBody.content);
      onProgress("Detected variables", 80);
    } else {
      onProgress("Skipping variable detection", 80);
    }

    // ========================================================================
    // STAGE 11: Extract fonts (80-90%) — loading is deferred to the component
    // ========================================================================
    onProgress("Extracting fonts...", 80);
    const requiredFonts = extractDocumentFontNames(theme, styleDefinitions, documentBody);
    onProgress("Extracted fonts", 90);

    if (preloadFonts) {
      onProgress("Loading fonts...", 90);
      await loadFontsWithMapping(requiredFonts);
      onProgress("Loaded fonts", 95);
    } else {
      onProgress("Skipping font loading", 95);
    }

    // ========================================================================
    // STAGE 12: Assemble final Document (95-100%)
    // ========================================================================
    onProgress("Assembling document...", 95);

    const pkg: DocxPackage = {
      document: documentBody,
      settings,
      ...(styleDefinitions !== undefined ? { styles: styleDefinitions } : {}),
      theme,
      numbering: numbering.definitions,
      ...(headers !== undefined ? { headers } : {}),
      ...(footers !== undefined ? { footers } : {}),
      ...(footnotes !== undefined ? { footnotes } : {}),
      ...(endnotes !== undefined ? { endnotes } : {}),
      relationships: rels,
      media,
    };

    // Like the legacy parser, `originalBuffer` is the decrypted and (for
    // truncated-EOCD archives) repaired ZIP bytes the package graph was read
    // from, so a later save round-trips a well-formed container.
    const document: Document = {
      package: pkg,
      originalBuffer: packageBuffer,
      ...(templateVariables !== undefined ? { templateVariables } : {}),
      ...(requiredFonts.length > 0 ? { requiredFonts } : {}),
    };

    const validation = validateFolioDocumentModel(document);
    const parsedCompleteModel = parseHeadersFooters && parseNotes;
    if (!validation.valid && parsedCompleteModel) {
      throw new DocxModelValidationError(
        "Parsed DOCX produced an invalid document model",
        validation.issues,
      );
    }
    warnings.push(...formatDocumentModelIssues(validation.issues));
    if (warnings.length > 0) {
      document.warnings = warnings;
    }

    onProgress("Complete", 100);
    return document;
  } catch (error) {
    if (error instanceof DocxEncryptionError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxParseError({
      message: `Failed to parse DOCX: ${message}`,
      cause: error,
    });
  }
}

async function applyMediaResolver(
  media: Map<string, MediaFile>,
  resolver: MediaResolver,
): Promise<void> {
  const files = [...new Set(media.values())];
  await Promise.all(
    files.map(async (file) => {
      try {
        const url = await resolver(file);
        if (url) {
          file.dataUrl = url;
        }
      } catch {
        // Host hook failure: keep built-in display URL.
      }
    }),
  );
}

/**
 * Extract all font family names referenced in the document (synchronous, no
 * network). Duplicated from the private `extractDocumentFontNames` in
 * docx/parser.ts (source of truth) — the parity harness compares the
 * resulting `requiredFonts` arrays.
 */
function extractDocumentFontNames(
  theme: Theme | null,
  styleDefinitions: StyleDefinitions | undefined,
  documentBody: DocumentBody,
): string[] {
  const docxFonts = new Set<string>();

  if (theme?.fontScheme) {
    const { majorFont, minorFont } = theme.fontScheme;
    if (majorFont?.latin) {
      docxFonts.add(majorFont.latin);
    }
    if (minorFont?.latin) {
      docxFonts.add(minorFont.latin);
    }
  }

  if (styleDefinitions?.docDefaults?.rPr?.fontFamily?.ascii) {
    docxFonts.add(styleDefinitions.docDefaults.rPr.fontFamily.ascii);
  }

  if (styleDefinitions?.styles) {
    for (const style of styleDefinitions.styles) {
      if (style.rPr?.fontFamily?.ascii) {
        docxFonts.add(style.rPr.fontFamily.ascii);
      }
      if (style.rPr?.fontFamily?.hAnsi) {
        docxFonts.add(style.rPr.fontFamily.hAnsi);
      }
    }
  }

  for (const block of documentBody.content) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (item.type === "run" && item.formatting?.fontFamily) {
          if (item.formatting.fontFamily.ascii) {
            docxFonts.add(item.formatting.fontFamily.ascii);
          }
          if (item.formatting.fontFamily.hAnsi) {
            docxFonts.add(item.formatting.fontFamily.hAnsi);
          }
        }
      }
    }
  }

  return Array.from(docxFonts);
}
