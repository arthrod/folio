/**
 * Text-only mapping from the folio DOCX model to a ProseMirror doc for the
 * single-contenteditable spike. Paragraph runs (including runs inside
 * hyperlinks) become text with strong/em marks; tabs map to "\t" and
 * explicit breaks to a space (the spike schema has no hard_break — see
 * README). Every other block kind is skipped and reported. Explicit
 * non-goals: tables, images, headers/footers, footnotes, columns, floats.
 */

import type { Document } from "@stll/folio-core";
import type { Run } from "@stll/folio-core/types/content";
import type { MarkType, Node as PmNode, NodeType, Schema } from "prosemirror-model";

type SchemaPieces = {
  doc: NodeType;
  paragraph: NodeType;
  strong: MarkType;
  em: MarkType;
};

function requiredSchemaPieces(schema: Schema): SchemaPieces {
  const doc = schema.nodes.doc;
  const paragraph = schema.nodes.paragraph;
  const strong = schema.marks.strong;
  const em = schema.marks.em;
  if (!doc || !paragraph || !strong || !em) {
    throw new Error("docToPmDoc requires a schema with doc/paragraph nodes and strong/em marks");
  }
  return { doc, paragraph, strong, em };
}

function pushRunText(run: Run, schema: Schema, pieces: SchemaPieces, inline: PmNode[]): void {
  const marks = [
    ...(run.formatting?.bold ? [pieces.strong.create()] : []),
    ...(run.formatting?.italic ? [pieces.em.create()] : []),
  ];
  for (const piece of run.content) {
    if (piece.type === "text" && piece.text) {
      inline.push(schema.text(piece.text, marks));
    } else if (piece.type === "tab") {
      inline.push(schema.text("\t", marks));
    } else if (piece.type === "break") {
      // No hard_break in the text-only spike schema; keep the word gap.
      inline.push(schema.text(" ", marks));
    }
  }
}

export function docToPmDoc(
  document: Document,
  schema: Schema,
): { doc: PmNode; skippedBlocks: string[] } {
  const pieces = requiredSchemaPieces(schema);
  // The model is fully typed: BlockContent[] with discriminated `type`
  // fields — no casts needed (review finding).
  const body = document.package.document.content;

  const skippedBlocks: string[] = [];
  const paragraphs: PmNode[] = [];

  for (const block of body) {
    if (block.type !== "paragraph") {
      skippedBlocks.push(block.type);
      continue;
    }
    const inline: PmNode[] = [];
    for (const item of block.content) {
      if (item.type === "run") {
        pushRunText(item, schema, pieces, inline);
      } else if (item.type === "hyperlink") {
        // Hyperlink text is user-visible content; dropping it loses text
        // (review finding). Link marks are a non-goal for the spike.
        for (const child of item.children) {
          if (child.type === "run") {
            pushRunText(child, schema, pieces, inline);
          }
        }
      }
    }
    paragraphs.push(pieces.paragraph.create(null, inline));
  }

  if (paragraphs.length === 0) {
    paragraphs.push(pieces.paragraph.create());
  }

  return { doc: pieces.doc.create(null, paragraphs), skippedBlocks };
}
