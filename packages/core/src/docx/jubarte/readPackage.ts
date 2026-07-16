/**
 * Helpers for reading jubarte's byte-preserved package graph — part lookup,
 * relationship maps, media map construction, and body-final sectPr recovery.
 *
 * These replace the JSZip/`RawDocxContent` plumbing: every part the old
 * unzip layer surfaced is available on `AstPackage.package.parts`, already
 * subject to jubarte's zip-security policy.
 */

import { docxToAst } from "@arthrod/jubarte";

import type { MediaFile, Relationship, RelationshipMap } from "../../types/document";
import { convertTiffToPngDataUrl, isTiffMimeType } from "../../utils/tiffConverter";
import { extractMetafileRaster, isMetafileMimeType } from "../metafileRaster";
import { getMediaMimeType, mediaToDataUrl, repairDocxArchive } from "../unzip";
import type { AstPackage, AstPackagePart } from "./types";

/** Result of reading a DOCX buffer through jubarte. */
export type JubarteReadResult = {
  astPackage: AstPackage;
  warnings: string[];
  /**
   * The bytes the package graph was actually read from: the input, or the
   * repaired archive when the input's end-of-central-directory record was
   * truncated. Callers persisting a round-trip baseline must use this (the
   * legacy parser exposed the repaired bytes as `originalBuffer`).
   */
  buffer: ArrayBuffer;
};

/**
 * Run jubarte's reader on a normalized buffer. Node and browser builds of
 * jubarte take differently-keyed input objects (`{buffer}` vs
 * `{arrayBuffer}`); supplying both keys satisfies whichever build resolved.
 * A container jubarte's reader rejects gets one repair attempt (truncated
 * end-of-central-directory record — the shape the legacy unzip repaired).
 */
export async function readDocxPackage(buffer: ArrayBuffer): Promise<JubarteReadResult> {
  let effectiveBuffer = buffer;
  const read = (bytes: ArrayBuffer) =>
    docxToAst({ buffer: bytes, arrayBuffer: bytes } as never);
  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read(buffer);
  } catch (error) {
    const repaired = await repairDocxArchive(buffer);
    if (repaired === null || repaired === buffer) {
      throw error;
    }
    effectiveBuffer = repaired;
    result = await read(repaired);
  }
  const warnings: string[] = [];
  for (const message of result.messages ?? []) {
    if (message.type === "warning" || message.type === "error") {
      warnings.push(message.message);
    }
  }
  for (const warning of result.warnings ?? []) {
    warnings.push(warning);
  }
  for (const diagnostic of result.astPackage.diagnostics ?? []) {
    if (diagnostic.severity !== "info") {
      warnings.push(`${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  return { astPackage: result.astPackage, warnings, buffer: effectiveBuffer };
}

/** Case-insensitive part lookup on the package graph. */
export function findPart(pkg: AstPackage, path: string): AstPackagePart | undefined {
  const parts = pkg.package.parts;
  const direct = parts[path];
  if (direct) {
    return direct;
  }
  const lower = path.toLowerCase();
  for (const [key, part] of Object.entries(parts)) {
    if (key.toLowerCase() === lower) {
      return part;
    }
  }
  return undefined;
}

/** Text of an XML part, or null when the part is absent/binary. */
export function partText(pkg: AstPackage, path: string): string | null {
  const part = findPart(pkg, path);
  if (!part) {
    return null;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (part.bytes) {
    return new TextDecoder().decode(toUint8(part.bytes));
  }
  return null;
}

/** Bytes of a binary part as ArrayBuffer, or null. */
export function partBytes(pkg: AstPackage, path: string): ArrayBuffer | null {
  const part = findPart(pkg, path);
  if (!part) {
    return null;
  }
  return partBytesOf(part);
}

function partBytesOf(part: AstPackagePart): ArrayBuffer | null {
  if (part.bytes) {
    const u8 = toUint8(part.bytes);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  }
  if (typeof part.text === "string") {
    return new TextEncoder().encode(part.text).buffer as ArrayBuffer;
  }
  return null;
}

function toUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Build the document-level relationship map from the package graph.
 * Equivalent to parsing `word/_rels/document.xml.rels` with relsParser:
 * `targetMode` is set only when the source declared it explicitly.
 */
export function buildRelationshipMap(pkg: AstPackage, sourcePath: string): RelationshipMap {
  const map: RelationshipMap = new Map();
  for (const rel of pkg.package.relationships[sourcePath] ?? []) {
    const relationship: Relationship = {
      id: rel.id,
      type: rel.type,
      target: rel.target,
    };
    if (rel.targetMode === "External") {
      relationship.targetMode = "External";
    } else if (rel.targetMode === "Internal") {
      relationship.targetMode = "Internal";
    }
    map.set(rel.id, relationship);
  }
  return map;
}

/**
 * Media MIME types folio loads by default. Mirrors the private
 * `DEFAULT_ALLOWED_MEDIA_MIME_TYPES` gate in docx/unzip.ts; jubarte preserves
 * every part, so the adapter re-applies the same inclusion policy to keep the
 * media map identical to the legacy parser's.
 */
const ALLOWED_MEDIA_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
  "image/x-emf",
  "image/x-wmf",
]);

/** Mirrors the private `maxMediaBytes` default in docx/unzip.ts. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * Byte-signature validation for media entries. Duplicated from the private
 * `isMediaContentAllowed` in docx/unzip.ts (source of truth) so the adapter
 * does not need to widen the legacy module's export surface yet.
 */
function isMediaContentAllowed(data: ArrayBuffer, mimeType: string): boolean {
  const bytes = new Uint8Array(data);
  switch (mimeType) {
    case "image/png":
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8;
    case "image/gif":
      return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
    case "image/bmp":
      return bytes[0] === 0x42 && bytes[1] === 0x4d;
    case "image/webp":
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case "image/tiff":
      return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
    case "image/x-emf":
    case "image/emf":
      return (
        bytes.length >= 44 &&
        bytes[0] === 1 &&
        bytes[40] === 0x20 &&
        bytes[41] === 0x45 &&
        bytes[42] === 0x4d &&
        bytes[43] === 0x46
      );
    case "image/x-wmf":
    case "image/wmf":
      return (
        bytes.length >= 4 &&
        ((bytes[0] === 0xd7 && bytes[1] === 0xcd && bytes[2] === 0xc6 && bytes[3] === 0x9a) ||
          ((bytes[0] === 0x01 || bytes[0] === 0x02) &&
            bytes[1] === 0x00 &&
            bytes[2] === 0x09 &&
            bytes[3] === 0x00))
      );
    default:
      return false;
  }
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * Base64-encoding a large image eagerly costs main-thread time at parse; the
 * lazy getter defers it to first render access. Duplicated from the private
 * `attachLazyDataUrl` in docx/parser.ts (source of truth).
 */
function attachLazyDataUrl(mediaFile: MediaFile): void {
  let cachedDataUrl: string | undefined;
  Object.defineProperty(mediaFile, "dataUrl", {
    configurable: true,
    enumerable: false,
    get() {
      cachedDataUrl ??= mediaToDataUrl(mediaFile.data, mediaFile.mimeType);
      return cachedDataUrl;
    },
  });
}

/**
 * Build the media file map from binary parts under word/media/, mirroring the
 * legacy pipeline exactly (unzip's inclusion gate + parser.ts buildMediaMap):
 * eager TIFF→PNG re-encode, metafile raster extraction for EMF/WMF display,
 * lazy dataUrl for everything else, entries keyed by full path and by the
 * word/-stripped path relationship targets use.
 */
export async function buildMediaMapFromPackage(
  pkg: AstPackage,
  warnings: string[],
): Promise<Map<string, MediaFile>> {
  const media = new Map<string, MediaFile>();
  for (const [path, part] of Object.entries(pkg.package.parts)) {
    if (!path.toLowerCase().startsWith("word/media/")) {
      continue;
    }
    const mimeType = getMediaMimeType(path);
    if (!ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) {
      continue;
    }
    const data = partBytesOf(part);
    if (!data) {
      continue;
    }
    if (data.byteLength > MAX_MEDIA_BYTES) {
      warnings.push(
        `Skipped oversized media file: ${path}; original entry preserved for round-trip.`,
      );
      continue;
    }
    if (!isMediaContentAllowed(data, mimeType)) {
      continue;
    }

    const filename = path.split("/").pop() || path;

    // TIFF: browsers don't render TIFF in <img>, so decode + re-encode as
    // PNG eagerly (mimeType, data, and filename extension move together so
    // re-export writes a PNG matching its declared type). On conversion
    // failure fall through to lazy attachment with the original TIFF data.
    if (isTiffMimeType(mimeType)) {
      // oxlint-disable-next-line no-await-in-loop -- TIFF decode uses a shared Canvas; conversions must stay serialized to avoid contention
      const converted = await convertTiffToPngDataUrl(data);
      if (converted) {
        const mediaFile: MediaFile = {
          path,
          filename: filename.replace(/\.tiff?$/iu, ".png"),
          mimeType: "image/png",
          data: converted.data,
          dataUrl: converted.dataUrl,
        };
        setMediaEntry(media, path, mediaFile);
        continue;
      }
    }

    const raster = isMetafileMimeType(mimeType) ? extractMetafileRaster(data) : null;
    if (raster) {
      const mediaFile: MediaFile = {
        path,
        filename,
        mimeType,
        data,
        dataUrl: mediaToDataUrl(copyBytesToArrayBuffer(raster.bytes), raster.mimeType),
      };
      setMediaEntry(media, path, mediaFile);
      continue;
    }

    const mediaFile: MediaFile = {
      path,
      filename,
      mimeType,
      data,
    };
    attachLazyDataUrl(mediaFile);
    setMediaEntry(media, path, mediaFile);
  }
  return media;
}

function setMediaEntry(media: Map<string, MediaFile>, path: string, mediaFile: MediaFile): void {
  media.set(path, mediaFile);
  const normalizedPath = path.replace(/^word\//u, "");
  if (normalizedPath !== path) {
    media.set(normalizedPath, mediaFile);
  }
}

/**
 * Recover the body-final `<w:sectPr>` fragment from the byte-preserved
 * document part. Jubarte's AST does not model the trailing section
 * properties as a node; the preserved part text is authoritative. The scan
 * is bounded and structural: last `<w:sectPr` opening under the body,
 * matched to its closing tag; the fragment is then parsed by a real XML
 * parser downstream, so a bad extraction fails loudly rather than silently.
 */
export function extractFinalSectPrXml(pkg: AstPackage): string | null {
  const documentXml = partText(pkg, pkg.package.mainDocumentPath || "word/document.xml");
  if (!documentXml) {
    return null;
  }
  // The producer may bind WordprocessingML to any prefix (alt-prefix
  // fixtures use ns0:), so locate body/sectPr tags by local name.
  const bodyCloseMatch = lastMatch(documentXml, /<\/(?:[A-Za-z_][\w.-]*:)?body>/gu);
  if (!bodyCloseMatch) {
    return null;
  }
  const bodyClose = bodyCloseMatch.index;
  const openRe = /<(?:[A-Za-z_][\w.-]*:)?sectPr(?=[\s/>])/gu;
  const opens: number[] = [];
  for (const match of documentXml.matchAll(openRe)) {
    if (match.index >= bodyClose) {
      break;
    }
    opens.push(match.index);
  }
  // The final section properties are the body's LAST child: only a sectPr
  // whose closing tag is followed (modulo whitespace) by </w:body> counts.
  // Anything else (a sectPr nested in a paragraph's pPr, or inside a
  // sectPrChange snapshot) is not the body-final sectPr — the legacy parser
  // reads the body's direct child, so a nested match must be rejected.
  // Scan candidates from the last opening backwards; nested sectPr openings
  // fail the whitespace-tail check until the outermost one wins.
  for (let i = opens.length - 1; i >= 0; i--) {
    const openIndex = opens[i];
    if (openIndex === undefined) {
      continue;
    }
    const fragmentEnd = matchSectPrEnd(documentXml, openIndex, bodyClose);
    if (fragmentEnd !== null && documentXml.slice(fragmentEnd, bodyClose).trim() === "") {
      return documentXml.slice(openIndex, fragmentEnd);
    }
  }
  return null;
}

function lastMatch(text: string, re: RegExp): { index: number } | null {
  let result: { index: number } | null = null;
  for (const match of text.matchAll(re)) {
    result = { index: match.index };
  }
  return result;
}

/**
 * Given the index of a `sectPr` opening, return the index just past its
 * matching end (self-closing `/>` or depth-matched close tag), or null when
 * the markup is unbalanced before `limit`. Prefix-agnostic; nested openings
 * (a sectPrChange snapshot nests another sectPr) are depth-matched.
 */
function matchSectPrEnd(xml: string, openIndex: number, limit: number): number | null {
  const tagEnd = xml.indexOf(">", openIndex);
  if (tagEnd === -1 || tagEnd > limit) {
    return null;
  }
  if (xml[tagEnd - 1] === "/") {
    return tagEnd + 1;
  }
  const tokenRe = /<(\/?)(?:[A-Za-z_][\w.-]*:)?sectPr(?=[\s/>])/gu;
  tokenRe.lastIndex = tagEnd + 1;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null && match.index < limit) {
    const tokenEnd = xml.indexOf(">", match.index);
    if (tokenEnd === -1) {
      return null;
    }
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return tokenEnd + 1;
      }
    } else if (xml[tokenEnd - 1] !== "/") {
      depth += 1;
    }
    tokenRe.lastIndex = tokenEnd + 1;
  }
  return null;
}
