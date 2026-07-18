import { describe, expect, test } from "bun:test";

import { parseParagraph } from "./paragraphParser";
import { serializeParagraph } from "./serializer/paragraphSerializer";
import { parseXmlDocument, type XmlElement } from "./xmlParser";

/**
 * Word 2021+ stamps a UTC companion timestamp on every tracked change:
 * `w:date` is local time, `w16du:dateUtc` is the same instant in UTC. Dropping
 * the UTC attribute on round-trip degrades the revision's provenance (and is a
 * measurable fidelity loss against the Word oracle on the corpus). This test
 * pins that both the run-level `<w:ins>`/`<w:del>` wrappers and the
 * paragraph-mark `<w:pPr><w:rPr><w:ins>` carry `w16du:dateUtc` through
 * parse → serialize.
 */
const parse = (xml: string): XmlElement => {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("failed to parse fixture");
  }
  return root;
};

describe("w16du:dateUtc tracked-change fidelity", () => {
  test("run-level insertion keeps its UTC companion timestamp", () => {
    const root = parse(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du">
        <w:ins w:id="67" w:author="Reviewer" w:date="2026-07-10T21:47:00Z" w16du:dateUtc="2026-07-11T01:47:00Z">
          <w:r><w:t>Lorem ipsum</w:t></w:r>
        </w:ins>
      </w:p>
    `);

    const paragraph = parseParagraph(root, null, null, null, null, null);
    const insertion = paragraph.content.find((c) => c.type === "insertion");
    expect(insertion?.type).toBe("insertion");
    if (insertion?.type !== "insertion") {
      return;
    }
    expect(insertion.info.dateUtc).toBe("2026-07-11T01:47:00Z");

    const xml = serializeParagraph(paragraph);
    expect(xml).toContain('w16du:dateUtc="2026-07-11T01:47:00Z"');
  });

  test("paragraph-mark insertion keeps its UTC companion timestamp", () => {
    const root = parse(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du">
        <w:pPr>
          <w:rPr>
            <w:ins w:id="66" w:author="Reviewer" w:date="2026-07-10T21:47:00Z" w16du:dateUtc="2026-07-11T01:47:00Z"/>
          </w:rPr>
        </w:pPr>
        <w:r><w:t>body</w:t></w:r>
      </w:p>
    `);

    const paragraph = parseParagraph(root, null, null, null, null, null);
    expect(paragraph.pPrMark?.info.dateUtc).toBe("2026-07-11T01:47:00Z");

    const xml = serializeParagraph(paragraph);
    expect(xml).toContain('w16du:dateUtc="2026-07-11T01:47:00Z"');
  });

  test("hyperlink-nested deletion keeps its UTC companion timestamp", () => {
    const root = parse(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
           xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du">
        <w:hyperlink r:id="rId1">
          <w:del w:id="99" w:author="Reviewer" w:date="2026-07-10T21:47:00Z" w16du:dateUtc="2026-07-11T01:47:00Z">
            <w:r><w:delText>old link text</w:delText></w:r>
          </w:del>
        </w:hyperlink>
      </w:p>
    `);

    const paragraph = parseParagraph(root, null, null, null, null, null);
    const hyperlink = paragraph.content.find((c) => c.type === "hyperlink");
    expect(hyperlink?.type).toBe("hyperlink");
    if (hyperlink?.type !== "hyperlink") {
      return;
    }
    const deletion = hyperlink.children.find((c) => c.type === "deletion");
    expect(deletion?.type).toBe("deletion");
    if (deletion?.type !== "deletion") {
      return;
    }
    expect(deletion.info.dateUtc).toBe("2026-07-11T01:47:00Z");

    const xml = serializeParagraph(paragraph);
    expect(xml).toContain('w16du:dateUtc="2026-07-11T01:47:00Z"');
  });
});
