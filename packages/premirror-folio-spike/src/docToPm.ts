/**
 * Text-only mapping from the eigen DOCX model to a ProseMirror doc for the
 * single-contenteditable spike (plan Phase 3). Paragraph runs become text
 * with strong/em marks; every other block kind is skipped and reported.
 * Explicit non-goals (plan): tables, images, headers/footers, footnotes,
 * columns, floats.
 */

import type { Document } from "@stll/folio-core";
import type { Node as PmNode, Schema } from "prosemirror-model";

type AnyBlock = { type?: string; content?: unknown[] };
type AnyRun = {
  type?: string;
  formatting?: { bold?: boolean; italic?: boolean };
  content?: Array<{ type?: string; text?: string }>;
};

export function docToPmDoc(
  document: Document,
  schema: Schema,
): { doc: PmNode; skippedBlocks: string[] } {
  const body = (document as unknown as { package: { document: { content: AnyBlock[] } } }).package
    .document.content;

  const skippedBlocks: string[] = [];
  const paragraphs: PmNode[] = [];

  for (const block of body) {
    if (block.type !== "paragraph") {
      skippedBlocks.push(block.type ?? "unknown");
      continue;
    }
    const inline: PmNode[] = [];
    for (const item of (block.content ?? []) as AnyRun[]) {
      if (item.type !== "run") continue;
      const marks = [
        ...(item.formatting?.bold ? [schema.marks.strong!.create()] : []),
        ...(item.formatting?.italic ? [schema.marks.em!.create()] : []),
      ];
      for (const piece of item.content ?? []) {
        if (piece.type === "text" && piece.text) {
          inline.push(schema.text(piece.text, marks));
        }
      }
    }
    paragraphs.push(schema.nodes.paragraph!.create(null, inline));
  }

  if (paragraphs.length === 0) {
    paragraphs.push(schema.nodes.paragraph!.create());
  }

  return { doc: schema.nodes.doc!.create(null, paragraphs), skippedBlocks };
}
