/**
 * A `<w:del>` (or `<w:ins>`) that wraps a complex field — the shape Word
 * writes for a tracked-deleted HYPERLINK or DATE field — must keep its
 * tracked change through parse → serialize and through the ProseMirror
 * round-trip. Losing it resurrects deleted text as accepted content
 * (corpus files file_131/27/53/6/74/100/115/185/196).
 */

import { describe, expect, test } from "bun:test";

import { fromProseDoc } from "../prosemirror/conversion/fromProseDoc";
import { toProseDoc } from "../prosemirror/conversion/toProseDoc";
import type { ComplexField, Paragraph } from "../types/content";
import { parseParagraph } from "./paragraphParser";
import { serializeParagraph } from "./serializer/paragraphSerializer";
import type { XmlElement } from "./xmlParser";
import { parseXmlDocument } from "./xmlParser";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// Mirrors the corpus fixture (file_131 "Open source"): the whole complex
// HYPERLINK field — fldChar begin / delInstrText / separate / result run
// with delText / end — sits inside one <w:del>.
const DELETED_HYPERLINK_FIELD = `
  <w:p xmlns:w="${W_NS}">
    <w:del w:id="11" w:author="Reviewer" w:date="2026-07-10T12:00:00Z">
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:delInstrText xml:space="preserve"> HYPERLINK "https://opensource.org/" </w:delInstrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:delText>Open source</w:delText></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:del>
  </w:p>
`;

// file_100-shaped: a tracked-INSERTED DATE field (plain instrText / w:t).
const INSERTED_DATE_FIELD = `
  <w:p xmlns:w="${W_NS}">
    <w:ins w:id="21" w:author="Reviewer" w:date="2026-07-10T12:00:00Z">
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> DATE \\@ "dddd, MMMM d, yyyy" </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:t>Friday, July 10, 2026</w:t></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:ins>
  </w:p>
`;

function parseParagraphXml(xml: string): Paragraph {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
}

function findComplexField(paragraph: Paragraph): ComplexField {
  const field = paragraph.content.find(
    (content): content is ComplexField => content.type === "complexField",
  );
  expect(field).toBeDefined();
  if (!field) {
    throw new Error("Paragraph has no complexField");
  }
  return field;
}

function asDocument(paragraphs: Paragraph[]): never {
  return {
    package: {
      document: {
        content: paragraphs,
        finalSectionProperties: {},
      },
    },
  } as never;
}

describe("tracked-deleted complex field", () => {
  test("parse keeps the deletion on the assembled field", () => {
    const paragraph = parseParagraphXml(DELETED_HYPERLINK_FIELD);

    // The field must be the paragraph's only content: no bare (accepted)
    // field escaping the wrapper, and no stray empty deletion wrapper left
    // behind (which would multiply on every round-trip).
    expect(paragraph.content).toHaveLength(1);
    const field = findComplexField(paragraph);
    expect(field.instruction).toContain("HYPERLINK");
    expect(field.trackedChange?.kind).toBe("deletion");
    expect(field.trackedChange?.info.id).toBe(11);
    expect(field.trackedChange?.info.author).toBe("Reviewer");
    expect(field.trackedChange?.info.date).toBe("2026-07-10T12:00:00Z");
  });

  test("serialize emits the field inside w:del with delText/delInstrText", () => {
    const xml = serializeParagraph(parseParagraphXml(DELETED_HYPERLINK_FIELD));

    // Deleted text must NOT resurrect as plain accepted text.
    expect(xml).not.toContain("<w:t>Open source");
    expect(xml).toContain("<w:delText>Open source</w:delText>");
    expect(xml).toContain("<w:delInstrText");
    // The whole field must sit inside a <w:del> carrying the revision info.
    expect(xml).toMatch(/<w:del [^>]*w:author="Reviewer"[^>]*>[\s\S]*Open source[\s\S]*?<\/w:del>/);
  });

  test("the deletion survives the ProseMirror round-trip", () => {
    const paragraph = parseParagraphXml(DELETED_HYPERLINK_FIELD);
    const roundtripped = fromProseDoc(toProseDoc(asDocument([paragraph])));
    const after = roundtripped.package.document.content[0] as Paragraph;

    // The field itself must survive (not be dropped by the tracked-change
    // conversion), and it must still be deleted.
    const field = findComplexField(after);
    expect(field.instruction).toContain("HYPERLINK");
    expect(field.trackedChange?.kind).toBe("deletion");
    expect(field.trackedChange?.info.author).toBe("Reviewer");

    const xml = serializeParagraph(after);
    expect(xml).not.toContain("<w:t>Open source");
    expect(xml).toMatch(/<w:del [^>]*>[\s\S]*<w:delText>Open source<\/w:delText>[\s\S]*?<\/w:del>/);
  });
});

describe("tracked-inserted complex field", () => {
  test("parse keeps the insertion on the assembled field", () => {
    const paragraph = parseParagraphXml(INSERTED_DATE_FIELD);

    expect(paragraph.content).toHaveLength(1);
    const field = findComplexField(paragraph);
    expect(field.fieldType).toBe("DATE");
    expect(field.trackedChange?.kind).toBe("insertion");
    expect(field.trackedChange?.info.id).toBe(21);
  });

  test("serialize wraps the field in w:ins without delText rewriting", () => {
    const xml = serializeParagraph(parseParagraphXml(INSERTED_DATE_FIELD));

    // Inserted (not deleted) field: result stays w:t, instruction stays
    // instrText — but the whole field is wrapped in <w:ins>.
    expect(xml).toContain("<w:t>Friday, July 10, 2026</w:t>");
    expect(xml).not.toContain("delText");
    expect(xml).not.toContain("delInstrText");
    expect(xml).toMatch(
      /<w:ins [^>]*w:author="Reviewer"[^>]*>[\s\S]*Friday, July 10, 2026[\s\S]*?<\/w:ins>/,
    );
  });

  test("the insertion survives the ProseMirror round-trip", () => {
    const paragraph = parseParagraphXml(INSERTED_DATE_FIELD);
    const roundtripped = fromProseDoc(toProseDoc(asDocument([paragraph])));
    const after = roundtripped.package.document.content[0] as Paragraph;

    const field = findComplexField(after);
    expect(field.trackedChange?.kind).toBe("insertion");

    const xml = serializeParagraph(after);
    expect(xml).toMatch(/<w:ins [^>]*>[\s\S]*Friday, July 10, 2026[\s\S]*?<\/w:ins>/);
  });
});
