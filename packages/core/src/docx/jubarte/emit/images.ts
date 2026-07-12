// PORT (jubarte save path): new-image processing lifted from docx/rezip.ts
// (collectImageParts / collectNewImages / processNewImages and their
// helpers). rezip.ts imports the legacy serializer tree at module level, so
// these are ported rather than imported; behavior is identical.
// Deleted together with docx/rezip.ts when the legacy save is removed.

import { panic } from "better-result";
import type JSZip from "jszip";

import type { BlockContent, HeaderFooter, Image } from "../../../types/content";
import type { Document } from "../../../types/document";
import { RELATIONSHIP_TYPES } from "../../relsParser";
import { escapeXml } from "./xmlUtils";
import {
  findMaxRId,
  getContentTypeForExtension,
  headerFooterRelsPath,
  readRelsOrStub,
  relativeTargetForPart,
} from "./relsUtils";

export type DocxPart = {
  relsPath: string;
  blocks: BlockContent[];
};

export function collectImageParts(doc: Document): DocxPart[] {
  const parts: DocxPart[] = [
    {
      relsPath: "word/_rels/document.xml.rels",
      blocks: doc.package.document.content,
    },
  ];
  const rels = doc.package.relationships;
  if (!rels) {
    return parts;
  }

  const addHeaderFooterParts = (map: Map<string, HeaderFooter> | undefined, type: string) => {
    if (!map) {
      return;
    }
    for (const [rId, headerFooter] of map.entries()) {
      const rel = rels.get(rId);
      if (!rel || rel.type !== type || !rel.target) {
        continue;
      }
      parts.push({
        relsPath: headerFooterRelsPath(rel.target),
        blocks: headerFooter.content,
      });
    }
  };

  addHeaderFooterParts(doc.package.headers, RELATIONSHIP_TYPES.header);
  addHeaderFooterParts(doc.package.footers, RELATIONSHIP_TYPES.footer);

  return parts;
}

function findMaxImageNum(zip: JSZip): number {
  let maxImageNum = 0;
  zip.forEach((relativePath) => {
    const m = /^word\/media\/image(?<num>\d+)\./u.exec(relativePath);
    if (m) {
      // SAFETY: named group `num` always present when regex matches
      const num = Number.parseInt(m.groups!["num"]!, 10);
      if (num > maxImageNum) {
        maxImageNum = num;
      }
    }
  });
  return maxImageNum;
}

async function registerImageExtensions(
  zip: JSZip,
  extensions: Set<string>,
  compressionLevel: number,
): Promise<void> {
  if (extensions.size === 0) {
    return;
  }
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) {
    return;
  }

  let ctXml = await ctFile.async("text");
  let changed = false;
  for (const ext of extensions) {
    if (ctXml.includes(`Extension="${ext}"`)) {
      continue;
    }
    const contentType = getContentTypeForExtension(ext, "");
    ctXml = ctXml.replace(
      "</Types>",
      `<Default Extension="${ext}" ContentType="${contentType}"/></Types>`,
    );
    changed = true;
  }

  if (!changed) {
    return;
  }
  zip.file("[Content_Types].xml", ctXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Collect all newly inserted images with data-URL src from the document content.
 * Existing DOCX images may also have a resolved data URL for preview; those must
 * continue to reference their original media part. Editor-created images use a
 * synthetic rId until they are assigned a real DOCX relationship here.
 */
const SYNTHETIC_IMAGE_RID_PREFIX = "rId_img_";

const isNewDataUrlImage = (image: Image) =>
  image.src?.startsWith("data:") &&
  (!image.rId || image.rId.startsWith(SYNTHETIC_IMAGE_RID_PREFIX));

function collectNewImages(blocks: BlockContent[]): Image[] {
  const images: Image[] = [];

  const collectFromRun = (run: { content: { type: string; image?: Image }[] }): void => {
    for (const c of run.content) {
      if (c.type === "drawing" && c.image && isNewDataUrlImage(c.image)) {
        images.push(c.image);
      }
    }
  };

  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (item.type === "run") {
          collectFromRun(item);
        } else if (
          // A picture inserted/deleted/moved under track changes lives inside
          // an ins/del/moveFrom/moveTo wrapper. Descend so its media part
          // still gets written. eigenpal #641.
          item.type === "insertion" ||
          item.type === "deletion" ||
          item.type === "moveFrom" ||
          item.type === "moveTo"
        ) {
          for (const sub of item.content) {
            if (sub.type === "run") {
              collectFromRun(sub);
            }
          }
        }
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          images.push(...collectNewImages(cell.content));
        }
      }
    }
  }

  return images;
}

/** Map MIME type to file extension (inverse of getContentTypeForExtension) */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * Decode a data URL to binary ArrayBuffer and file extension.
 */
function decodeDataUrl(dataUrl: string): {
  data: ArrayBuffer;
  extension: string;
} {
  const match = /^data:(?<mime>[^;]+);base64,(?<data>.+)$/u.exec(dataUrl);
  if (!match) {
    panic("Invalid data URL");
  }

  // SAFETY: named groups `mime` and `data` always present when regex matches
  const binary = atob(match.groups!["data"]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }

  return {
    data: bytes.buffer,
    extension: MIME_TO_EXT[match.groups!["mime"]!] ?? "png",
  };
}

/**
 * Process newly inserted images: add binary data to ZIP, create relationships,
 * update content types, and rewrite rIds in the document model so the serializer
 * outputs correct references.
 *
 * Mutates the images' rId fields in-place.
 */
export async function processNewImages(
  parts: DocxPart[],
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  let maxImageNum = findMaxImageNum(zip);
  const extensionsAdded = new Set<string>();

  for (const { relsPath, blocks } of parts) {
    const newImages = collectNewImages(blocks);
    if (newImages.length === 0) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- each part's rels feed shared maxImageNum/maxId counters that must advance sequentially
    const relsXml = await readRelsOrStub(zip, relsPath);
    let maxId = findMaxRId(relsXml);
    const relEntries: string[] = [];
    // The part owning these rels (e.g. word/headers/header1.xml). Relationship
    // targets are resolved relative to it, so a subdirectory header needs
    // `../media/...` rather than `media/...`.
    const partPath = relsPath.replace("/_rels/", "/").replace(/\.rels$/u, "");

    for (const image of newImages) {
      if (!image.src) {
        continue;
      }
      const { data, extension } = decodeDataUrl(image.src);

      maxImageNum++;
      maxId++;
      const mediaFilename = `image${maxImageNum}.${extension}`;
      const mediaPath = `word/media/${mediaFilename}`;
      const newRId = `rId${maxId}`;

      // Add binary to ZIP
      zip.file(mediaPath, data, {
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });

      // Build relationship entry (target relative to the owning part).
      relEntries.push(
        `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.image}" Target="${escapeXml(relativeTargetForPart(partPath, mediaPath))}"/>`,
      );

      extensionsAdded.add(extension);

      // Rewrite the image's rId so the serializer outputs the correct reference
      image.rId = newRId;
    }

    if (relEntries.length > 0) {
      const updatedRelsXml = relsXml.replace(
        "</Relationships>",
        `${relEntries.join("")}</Relationships>`,
      );
      zip.file(relsPath, updatedRelsXml, {
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });
    }
  }

  await registerImageExtensions(zip, extensionsAdded, compressionLevel);
}
