// PORT (jubarte save path): package-maintenance passes lifted from
// docx/rezip.ts — comment part packaging transforms, in-memory header/footer
// materialization, and picture-watermark rId rebinding. rezip.ts imports the
// legacy serializer tree at module level, so these are ported rather than
// imported; behavior is identical.
// Deleted together with docx/rezip.ts when the legacy save is removed.

import type JSZip from "jszip";

import type { HeaderFooter } from "../../../types/content";
import type { Document, Watermark } from "../../../types/document";
import { parseRelationships, RELATIONSHIP_TYPES, resolveRelativePath } from "../../relsParser";
import { escapeXml } from "./xmlUtils";
import {
  EMPTY_RELS_XML,
  findMaxRId,
  headerFooterFilename,
  headerFooterRelsPath,
  readRelsOrStub,
  relativeTargetForPart,
} from "./relsUtils";

// ============================================================================
// COMMENT PACKAGING TRANSFORMS
// ============================================================================

export const COMMENTS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

export const COMMENTS_EXTENDED_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml";

export const COMMENTS_EXTENDED_PART = "word/commentsExtended.xml";
export const COMMENTS_EXTENDED_PART_LOWER = "word/commentsextended.xml";

export function addCommentsExtendedOverride(contentTypesXml: string): string {
  if (contentTypesXml.toLowerCase().includes("/word/commentsextended.xml")) {
    return contentTypesXml;
  }
  return contentTypesXml.replace(
    "</Types>",
    `<Override PartName="/word/commentsExtended.xml" ContentType="${COMMENTS_EXTENDED_CONTENT_TYPE}"/></Types>`,
  );
}

export function removeCommentsExtendedOverride(contentTypesXml: string): string {
  return contentTypesXml.replace(/<Override\b[^>]*commentsExtended\.xml[^>]*\/>/giu, "");
}

export function addCommentsExtendedRelationship(relsXml: string): string {
  if (relsXml.toLowerCase().includes("commentsextended.xml")) {
    return relsXml;
  }
  const newRId = `rId${findMaxRId(relsXml) + 1}`;
  return relsXml.replace(
    "</Relationships>",
    `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.commentsExtended}" Target="commentsExtended.xml"/></Relationships>`,
  );
}

export function removeCommentsExtendedRelationship(relsXml: string): string {
  return relsXml.replace(/<Relationship\b[^>]*commentsExtended\.xml[^>]*\/>/giu, "");
}

/**
 * Ensure [Content_Types].xml contains an Override for word/comments.xml.
 * If the document already had comments, this is a no-op.
 */
export async function ensureCommentsContentType(
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) {
    return;
  }

  let ctXml = await ctFile.async("text");
  if (ctXml.includes("/word/comments.xml")) {
    return;
  }

  // Insert before closing </Types>
  ctXml = ctXml.replace(
    "</Types>",
    `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`,
  );
  zip.file("[Content_Types].xml", ctXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Ensure word/_rels/document.xml.rels contains a Relationship for comments.xml.
 * If the document already had comments, this is a no-op.
 */
export async function ensureCommentsRelationship(
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  if (!relsFile) {
    return;
  }

  let relsXml = await relsFile.async("text");
  if (relsXml.includes("comments.xml")) {
    return;
  }

  // Generate a unique rId
  const newRId = `rId${findMaxRId(relsXml) + 1}`;

  relsXml = relsXml.replace(
    "</Relationships>",
    `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.comments}" Target="comments.xml"/></Relationships>`,
  );
  zip.file(relsPath, relsXml, {
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}

// ============================================================================
// HEADER/FOOTER MATERIALIZATION
// ============================================================================

const HEADER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const FOOTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";

/**
 * A header/footer is "unmaterialized" when it lives in the package map but its
 * rId has no resolvable relationship in `document.xml.rels` — i.e. it was
 * created in memory (header editor, watermark coverage) and still lacks a part,
 * relationship, and `[Content_Types]` entry.
 */
export function hasUnmaterializedHeaderFooterPart(doc: Document): boolean {
  const rels = doc.package.relationships;
  const hasNew = (map: Map<string, HeaderFooter> | undefined, type: string): boolean => {
    if (!map) {
      return false;
    }
    for (const rId of map.keys()) {
      const rel = rels?.get(rId);
      if (!rel || rel.type !== type || !rel.target) {
        return true;
      }
    }
    return false;
  };
  return (
    hasNew(doc.package.headers, RELATIONSHIP_TYPES.header) ||
    hasNew(doc.package.footers, RELATIONSHIP_TYPES.footer)
  );
}

function findMaxHeaderFooterNum(zip: JSZip, prefix: "header" | "footer"): number {
  let max = 0;
  const pattern = new RegExp(`^word/${prefix}(\\d+)\\.xml$`, "u");
  zip.forEach((relativePath) => {
    const m = pattern.exec(relativePath);
    if (m) {
      // SAFETY: capture group [1] always present when the regex matches.
      const num = Number.parseInt(m[1]!, 10);
      if (num > max) {
        max = num;
      }
    }
  });
  return max;
}

/**
 * Materialize header/footer parts created in memory (rId present in the package
 * map, absent from `document.xml.rels`). For each: mint a `word/<prefix>N.xml`
 * target, add a document relationship under the *existing* rId (a valid NCName,
 * so the section's `<w:headerReference r:id>` keeps resolving without rewriting
 * document.xml), and a `[Content_Types].xml` Override. The part body is written
 * afterwards by the header/footer emission pass, which can now resolve the new
 * relationship.
 */
export async function materializeNewHeaderFooterParts(
  doc: Document,
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const rels = doc.package.relationships;
  if (!rels) {
    return;
  }
  // Cheap guard so the common repack (no in-memory parts) skips the zip scans
  // and rels walk below.
  if (!hasUnmaterializedHeaderFooterPart(doc)) {
    return;
  }

  const relEntries: string[] = [];
  const overrides: string[] = [];
  let maxHeaderNum = findMaxHeaderFooterNum(zip, "header");
  let maxFooterNum = findMaxHeaderFooterNum(zip, "footer");
  // Seed the rId counter above every numeric id already in use — in the
  // relationship map AND as a header/footer map key — so a freshly minted id
  // can never collide with another (possibly not-yet-materialized) part.
  let maxRId = 0;
  const considerNumericRId = (id: string): void => {
    const match = /^rId(?<num>\d+)$/u.exec(id);
    if (match) {
      // SAFETY: named group `num` always present when the regex matches.
      const n = Number.parseInt(match.groups!["num"]!, 10);
      if (n > maxRId) {
        maxRId = n;
      }
    }
  };
  for (const id of rels.keys()) {
    considerNumericRId(id);
  }
  for (const id of doc.package.headers?.keys() ?? []) {
    considerNumericRId(id);
  }
  for (const id of doc.package.footers?.keys() ?? []) {
    considerNumericRId(id);
  }

  const remapRefs = (refs: { rId: string }[] | undefined, oldRId: string, newRId: string): void => {
    for (const ref of refs ?? []) {
      if (ref.rId === oldRId) {
        ref.rId = newRId;
      }
    }
  };

  const materialize = (
    map: Map<string, HeaderFooter> | undefined,
    relType: string,
    prefix: "header" | "footer",
    contentType: string,
    isHeader: boolean,
  ): void => {
    if (!map) {
      return;
    }
    for (const rId of [...map.keys()]) {
      const existing = rels.get(rId);
      if (existing && existing.type === relType && existing.target) {
        continue; // Already a materialized part of this kind.
      }
      // When the id is already taken by an unrelated relationship, mint a fresh
      // one and re-point the section references — reusing it would duplicate the
      // id or resolve the header reference to the wrong (non-header) target.
      let effectiveRId = rId;
      if (existing) {
        effectiveRId = `rId${++maxRId}`;
        const headerFooter = map.get(rId);
        if (headerFooter) {
          map.delete(rId);
          map.set(effectiveRId, headerFooter);
        }
        for (const block of doc.package.document.content) {
          if (block.type === "paragraph") {
            remapRefs(
              isHeader
                ? block.sectionProperties?.headerReferences
                : block.sectionProperties?.footerReferences,
              rId,
              effectiveRId,
            );
          }
        }
        const finalProps = doc.package.document.finalSectionProperties;
        remapRefs(
          isHeader ? finalProps?.headerReferences : finalProps?.footerReferences,
          rId,
          effectiveRId,
        );
      }
      const num = prefix === "header" ? ++maxHeaderNum : ++maxFooterNum;
      const filename = `${prefix}${num}.xml`;
      rels.set(effectiveRId, {
        id: effectiveRId,
        type: relType,
        target: filename,
      });
      relEntries.push(
        `<Relationship Id="${escapeXml(effectiveRId)}" Type="${relType}" Target="${filename}"/>`,
      );
      overrides.push(`<Override PartName="/word/${filename}" ContentType="${contentType}"/>`);
    }
  };

  materialize(doc.package.headers, RELATIONSHIP_TYPES.header, "header", HEADER_CONTENT_TYPE, true);
  materialize(doc.package.footers, RELATIONSHIP_TYPES.footer, "footer", FOOTER_CONTENT_TYPE, false);

  if (relEntries.length === 0) {
    return;
  }

  const compressionOptions = { level: compressionLevel };
  const relsPath = "word/_rels/document.xml.rels";
  const relsXml = await readRelsOrStub(zip, relsPath);
  zip.file(
    relsPath,
    relsXml.replace("</Relationships>", `${relEntries.join("")}</Relationships>`),
    { compression: "DEFLATE", compressionOptions },
  );

  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ctXml = await ctFile.async("text");
    const missing = overrides.filter((override) => {
      const partName = /PartName="(?<partName>[^"]+)"/u.exec(override)?.groups?.["partName"];
      return partName ? !ctXml.includes(`PartName="${partName}"`) : true;
    });
    if (missing.length > 0) {
      ctXml = ctXml.replace("</Types>", `${missing.join("")}</Types>`);
      zip.file("[Content_Types].xml", ctXml, {
        compression: "DEFLATE",
        compressionOptions,
      });
    }
  }
}

// ============================================================================
// PICTURE-WATERMARK rId REBINDING
// ============================================================================

/**
 * Rebind each picture watermark's `imageRId` so it resolves in its own header
 * part's rels. A watermark propagated across headers (or onto a header created
 * by coverage) carries the source header's rId, which is meaningless in a
 * sibling header's `word/_rels/header*.xml.rels`. Per header: keep the rId if
 * it already resolves; otherwise reuse an existing relationship to the same
 * media target, or mint a new one. The media bytes are shared (preserved from
 * the source), so no new media part is written. Raw-replay watermarks are
 * byte-exact and skipped.
 */
export async function rebindWatermarkRelIds(
  doc: Document,
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  const rels = doc.package.relationships;
  const headers = doc.package.headers;
  if (!rels || !headers) {
    return;
  }

  type PendingHeader = {
    watermark: Extract<Watermark, { kind: "picture" }>;
    relsPath: string;
    partPath: string;
  };
  const pending: PendingHeader[] = [];
  for (const [rId, hf] of headers) {
    const watermark = hf.watermark;
    if (!watermark || watermark.kind !== "picture" || hf.rawWatermarkXml) {
      continue;
    }
    const rel = rels.get(rId);
    if (!rel?.target) {
      continue;
    }
    pending.push({
      watermark,
      relsPath: headerFooterRelsPath(rel.target),
      partPath: headerFooterFilename(rel.target),
    });
  }
  if (pending.length === 0) {
    return;
  }

  // Read every header's rels (keyed by path), not only the ones being rebound:
  // the canonical image may live in a header whose own watermark is raw-replayed
  // (not pending). `document.xml.rels` is excluded — header rIds and body rIds
  // both start at rId1, so it could resolve a watermark to an unrelated body
  // image sharing the rId.
  const relsXmlByPath = new Map<string, string>();
  const headerRelsPaths = new Set<string>(pending.map((p) => p.relsPath));
  for (const rel of rels.values()) {
    if (rel.type === RELATIONSHIP_TYPES.header && rel.target) {
      headerRelsPaths.add(headerFooterRelsPath(rel.target));
    }
  }
  for (const relsPath of headerRelsPaths) {
    // oxlint-disable-next-line no-await-in-loop -- sequential rels reads populate the shared relsXmlByPath map keyed by path
    relsXmlByPath.set(relsPath, await readRelsOrStub(zip, relsPath));
  }

  // The canonical image a watermark points at: an embedded media part (as a
  // package-absolute path) or an external (linked) URL.
  type CanonicalImage = { mode: "internal"; absolute: string } | { mode: "external"; url: string };

  const relImage = (
    rel: { type: string; target?: string; targetMode?: string } | undefined,
    relsPath: string,
  ): CanonicalImage | undefined => {
    if (rel?.type !== RELATIONSHIP_TYPES.image || !rel.target) {
      return undefined;
    }
    return rel.targetMode === "External"
      ? { mode: "external", url: rel.target }
      : {
          mode: "internal",
          absolute: resolveRelativePath(relsPath, rel.target),
        };
  };

  const sameImage = (a: CanonicalImage, b: CanonicalImage): boolean =>
    a.mode === "internal" && b.mode === "internal"
      ? a.absolute === b.absolute
      : a.mode === "external" && b.mode === "external" && a.url === b.url;

  // The source header is the one whose own rels maps the rId to an image.
  const resolveCanonical = (imageRId: string): CanonicalImage | undefined => {
    for (const [relsPath, xml] of relsXmlByPath) {
      const canonical = relImage(parseRelationships(xml).get(imageRId), relsPath);
      if (canonical) {
        return canonical;
      }
    }
    return undefined;
  };

  const changedPaths = new Set<string>();
  for (const { watermark, relsPath, partPath } of pending) {
    // Anchored at parse time (imageTarget, embedded or external); fall back to
    // a scan only for watermarks built without a parsed source.
    let canonical: CanonicalImage | undefined;
    if (watermark.imageTarget !== undefined) {
      canonical = watermark.imageTargetExternal
        ? { mode: "external", url: watermark.imageTarget }
        : { mode: "internal", absolute: watermark.imageTarget };
    } else {
      canonical = resolveCanonical(watermark.imageRId);
    }
    if (!canonical) {
      continue; // Orphaned rId with no embedded media anywhere — cannot invent.
    }

    const relsXml = relsXmlByPath.get(relsPath) ?? EMPTY_RELS_XML;
    const localRels = parseRelationships(relsXml);
    const local = relImage(localRels.get(watermark.imageRId), relsPath);
    if (local && sameImage(local, canonical)) {
      // Already resolves to the canonical image. (A local rId resolving to a
      // *different* image — header rIds repeat across parts — must still be
      // rebound.)
      continue;
    }

    // Reuse an existing relationship to the same image, else mint one. An
    // external image keeps its URL and TargetMode="External".
    let resolvedRId: string | undefined;
    for (const [id, rel] of localRels) {
      const image = relImage(rel, relsPath);
      if (image && sameImage(image, canonical)) {
        resolvedRId = id;
        break;
      }
    }
    if (!resolvedRId) {
      resolvedRId = `rId${findMaxRId(relsXml) + 1}`;
      const relXml =
        canonical.mode === "external"
          ? `<Relationship Id="${resolvedRId}" Type="${RELATIONSHIP_TYPES.image}" Target="${escapeXml(canonical.url)}" TargetMode="External"/>`
          : `<Relationship Id="${resolvedRId}" Type="${RELATIONSHIP_TYPES.image}" Target="${escapeXml(relativeTargetForPart(partPath, canonical.absolute))}"/>`;
      relsXmlByPath.set(relsPath, relsXml.replace("</Relationships>", `${relXml}</Relationships>`));
      changedPaths.add(relsPath);
    }
    watermark.imageRId = resolvedRId;
  }

  const compressionOptions = { level: compressionLevel };
  for (const path of changedPaths) {
    const xml = relsXmlByPath.get(path);
    if (xml) {
      zip.file(path, xml, { compression: "DEFLATE", compressionOptions });
    }
  }
}
