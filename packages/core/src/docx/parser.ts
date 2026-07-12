/**
 * Main Parser Orchestrator - Unified parseDocx function
 *
 * `parseDocx` is backed by `@arthrod/jubarte`: the DOCX bytes are read into
 * jubarte's byte-preserved package graph and mapped onto the `Document`
 * model (see ./jubarte/parseDocx). Part interpretation (styles, theme,
 * settings, numbering) still runs the core's own interpreters over the
 * preserved part text; encryption, media policy, normalization passes,
 * model validation, and error wrapping keep the pre-swap contract.
 */

import { TaggedError } from "better-result";

import type { Document, MediaFile } from "../types/document";
import type { DocxInput } from "../utils/docxInput";
import { parseDocxWithJubarte } from "./jubarte/parseDocx";
import { partText, readDocxPackage } from "./jubarte/readPackage";
import type { DocxUnzipOptions } from "./unzip";

// ============================================================================
// PROGRESS CALLBACK
// ============================================================================

/**
 * Progress callback for tracking parsing stages
 */
export type ProgressCallback = (stage: string, percent: number) => void;

/**
 * Host hook for converting media the browser cannot render natively
 * (EMF/WMF/TIFF) into a displayable `data:` or `blob:` URL. Receives the
 * parsed {@link MediaFile} (original bytes on `.data`); return the replacement
 * URL, or `null`/`undefined` to keep the built-in handling. Built-in handling
 * already extracts an embedded PNG/JPEG from EMF/WMF when one exists; this
 * hook is for vector-only metafiles where the host rasterizes server-side.
 */
export type MediaResolver = (file: MediaFile) => Promise<string | null | undefined>;

/**
 * Parsing options
 */
export type ParseOptions = {
  /** Progress callback for tracking parsing stages */
  onProgress?: ProgressCallback;
  /** Whether to preload fonts (default: true) */
  preloadFonts?: boolean;
  /** Whether to parse headers/footers (default: true) */
  parseHeadersFooters?: boolean;
  /** Whether to parse footnotes/endnotes (default: true) */
  parseNotes?: boolean;
  /** Whether to detect template variables (default: true) */
  detectVariables?: boolean;
  /** Password for Agile-encrypted .docx files (Office 2010+). */
  password?: string | undefined;
  /** Security limits for DOCX ZIP extraction */
  unzipLimits?: DocxUnzipOptions;
  /** Optional async hook to override display URLs for non-browser media. */
  mediaResolver?: MediaResolver;
};

// ============================================================================
// MAIN PARSER
// ============================================================================

/**
 * Parse a DOCX file into a complete Document model
 *
 * @param input - DOCX file as ArrayBuffer, Uint8Array, Blob, or File
 * @param options - Parsing options
 * @returns Promise resolving to Document
 * @throws {Error} if parsing fails
 */
export function parseDocx(input: DocxInput, options: ParseOptions = {}): Promise<Document> {
  return parseDocxWithJubarte(input, options);
}

/** DOCX parsing failure: malformed package, unsupported feature, or
 *  upstream parser exception. Wraps the original cause for diagnostics. */
export class DocxParseError extends TaggedError("DocxParseError")<{
  message: string;
  cause?: unknown;
}>() {}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Quick parse - parse a DOCX without font loading
 * Useful for quick content extraction or when fonts aren't needed
 */
export function quickParseDocx(buffer: ArrayBuffer): Promise<Document> {
  return parseDocx(buffer, {
    preloadFonts: false,
    parseHeadersFooters: false,
    parseNotes: false,
    detectVariables: true,
  });
}

/**
 * Full parse - parse everything including fonts
 */
export function fullParseDocx(
  buffer: ArrayBuffer,
  onProgress?: ProgressCallback,
): Promise<Document> {
  return parseDocx(buffer, {
    ...(onProgress !== undefined ? { onProgress } : {}),
    preloadFonts: true,
    parseHeadersFooters: true,
    parseNotes: true,
    detectVariables: true,
  });
}

/**
 * Get template variables from a DOCX without full parsing
 * Faster than full parse when you only need variables
 */
export async function getDocxVariables(buffer: ArrayBuffer): Promise<string[]> {
  const { astPackage } = await readDocxPackage(buffer);
  const mainPath = astPackage.package.mainDocumentPath || "word/document.xml";
  if (partText(astPackage, mainPath) === null) {
    return [];
  }
  const doc = await quickParseDocx(buffer);
  return doc.templateVariables ?? [];
}

/**
 * Get document summary without full parsing
 */
export async function getDocxSummary(buffer: ArrayBuffer): Promise<{
  hasDocument: boolean;
  hasStyles: boolean;
  hasTheme: boolean;
  hasNumbering: boolean;
  headerCount: number;
  footerCount: number;
  mediaCount: number;
  variableCount: number;
}> {
  const { astPackage } = await readDocxPackage(buffer);
  const paths = Object.keys(astPackage.package.parts);
  const mainPath = astPackage.package.mainDocumentPath || "word/document.xml";
  const hasDocument = partText(astPackage, mainPath) !== null;
  const variables = hasDocument ? ((await quickParseDocx(buffer)).templateVariables ?? []) : [];

  return {
    hasDocument,
    hasStyles: partText(astPackage, "word/styles.xml") !== null,
    hasTheme: partText(astPackage, "word/theme/theme1.xml") !== null,
    hasNumbering: partText(astPackage, "word/numbering.xml") !== null,
    headerCount: paths.filter((p) => /^word\/header\d+\.xml$/iu.test(p)).length,
    footerCount: paths.filter((p) => /^word\/footer\d+\.xml$/iu.test(p)).length,
    mediaCount: paths.filter((p) => /^word\/media\//iu.test(p)).length,
    variableCount: variables.length,
  };
}
