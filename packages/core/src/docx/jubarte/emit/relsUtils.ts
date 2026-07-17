// PORT (jubarte save path): relationship / packaging string helpers lifted
// from docx/rezip.ts. rezip.ts imports the legacy serializer tree at module
// level, so these are ported rather than imported; behavior is identical.
// Deleted together with docx/rezip.ts when the legacy save is removed.

import type JSZip from "jszip";

/**
 * Find the highest rId number in a relationships XML string.
 */
export function findMaxRId(relsXml: string): number {
  let maxId = 0;
  for (const match of relsXml.matchAll(/Id="rId(?<id>\d+)"/gu)) {
    // SAFETY: named group `id` always present when regex matches
    const id = Number.parseInt(match.groups!["id"]!, 10);
    if (id > maxId) {
      maxId = id;
    }
  }
  return maxId;
}

export const EMPTY_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

export function headerFooterFilename(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `word/${target}`;
}

/**
 * The relationships part for a header/footer. A part at `<dir>/<name>` keeps its
 * rels at `<dir>/_rels/<name>.rels` — e.g. `word/headers/header1.xml` ->
 * `word/headers/_rels/header1.xml.rels`, not a flattened `word/_rels/...`.
 */
export function headerFooterRelsPath(target: string): string {
  const partPath = headerFooterFilename(target);
  const lastSlash = partPath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : partPath.slice(0, lastSlash);
  const name = lastSlash === -1 ? partPath : partPath.slice(lastSlash + 1);
  return `${directory ? `${directory}/` : ""}_rels/${name}.rels`;
}

/**
 * Express an absolute package path as a relationship target relative to the
 * part at `partPath`. e.g. media `word/media/image1.png` for a part at
 * `word/headers/header2.xml` -> `../media/image1.png` (and `media/image1.png`
 * for a part at the `word/` root). The inverse of `resolveRelativePath`.
 */
export function relativeTargetForPart(partPath: string, absoluteTarget: string): string {
  const lastSlash = partPath.lastIndexOf("/");
  const fromDir = lastSlash === -1 ? [] : partPath.slice(0, lastSlash).split("/");
  const to = absoluteTarget.split("/");
  let shared = 0;
  while (shared < fromDir.length && shared < to.length - 1 && fromDir[shared] === to[shared]) {
    shared += 1;
  }
  return `${"../".repeat(fromDir.length - shared)}${to.slice(shared).join("/")}`;
}

export async function readRelsOrStub(zip: JSZip, relsPath: string): Promise<string> {
  const file = zip.file(relsPath);
  const xml = file ? await file.async("text") : EMPTY_RELS_XML;
  return xml.replace(
    /<Relationships(?<attrs>[^>]*)\/>/u,
    "<Relationships$<attrs>></Relationships>",
  );
}

/**
 * Get content type for a file extension
 */
export function getContentTypeForExtension(extension: string, mimeType: string): string {
  // Use provided mime type or fall back to common types
  if (mimeType) {
    return mimeType;
  }

  const contentTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    webp: "image/webp",
    wmf: "image/x-wmf",
    emf: "image/x-emf",
  };

  return contentTypes[extension] || "application/octet-stream";
}

/** Read a packaging file, apply a pure transform, and write it back if it changed. */
export async function transformPackagingFile(
  zip: JSZip,
  path: string,
  transform: (xml: string) => string,
  compressionLevel: number,
): Promise<void> {
  const file = zip.file(path);
  if (!file) {
    return;
  }
  const xml = await file.async("text");
  const next = transform(xml);
  if (next !== xml) {
    zip.file(path, next, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }
}

export function findZipEntryCaseInsensitive(
  zip: JSZip,
  lowerPath: string,
): JSZip.JSZipObject | null {
  const direct = zip.file(lowerPath);
  if (direct) {
    return direct;
  }
  for (const [path, file] of Object.entries(zip.files)) {
    if (!file.dir && path.toLowerCase() === lowerPath) {
      return file;
    }
  }
  return null;
}
