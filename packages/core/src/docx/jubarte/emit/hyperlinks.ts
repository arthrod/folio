// PORT (jubarte save path): new-hyperlink processing lifted from
// docx/rezip.ts (collectHyperlinksWithoutRId / processNewHyperlinks).
// rezip.ts imports the legacy serializer tree at module level, so these are
// ported rather than imported; behavior is identical.
// Deleted together with docx/rezip.ts when the legacy save is removed.

import type JSZip from "jszip";

import type { BlockContent, Hyperlink } from "../../../types/content";
import { RELATIONSHIP_TYPES } from "../../relsParser";
import { escapeXml } from "./xmlUtils";
import { findMaxRId } from "./relsUtils";

/**
 * Collect all hyperlinks that have an href but no rId from block content.
 * These are newly created hyperlinks that need relationship entries.
 */
export function collectHyperlinksWithoutRId(blocks: BlockContent[]): Hyperlink[] {
  const hyperlinks: Hyperlink[] = [];

  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (item.type === "hyperlink" && item.href && !item.rId && !item.anchor) {
          hyperlinks.push(item);
        }
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          hyperlinks.push(...collectHyperlinksWithoutRId(cell.content));
        }
      }
    }
  }

  return hyperlinks;
}

/**
 * Process newly created hyperlinks: assign rIds and add relationship entries.
 * Mutates the hyperlinks' rId fields in-place.
 */
export async function processNewHyperlinks(
  newHyperlinks: Hyperlink[],
  zip: JSZip,
  compressionLevel: number,
): Promise<void> {
  if (newHyperlinks.length === 0) {
    return;
  }

  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  if (!relsFile) {
    return;
  }
  let relsXml = await relsFile.async("text");

  let maxId = findMaxRId(relsXml);
  const relEntries: string[] = [];

  for (const hyperlink of newHyperlinks) {
    maxId++;
    const newRId = `rId${maxId}`;

    if (!hyperlink.href) {
      continue;
    }
    relEntries.push(
      `<Relationship Id="${newRId}" Type="${RELATIONSHIP_TYPES.hyperlink}" Target="${escapeXml(hyperlink.href)}" TargetMode="External"/>`,
    );

    // Rewrite the hyperlink's rId so the serializer outputs the correct reference
    hyperlink.rId = newRId;
  }

  if (relEntries.length > 0) {
    relsXml = relsXml.replace("</Relationships>", `${relEntries.join("")}</Relationships>`);
    zip.file(relsPath, relsXml, {
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }
}
