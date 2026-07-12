/**
 * Invariants on the emitted `word/document.xml` (successor to the deleted
 * string-serializer suite `serializer/documentSerializer.test.ts`, asserting
 * through the jubarte-backed save instead of the legacy `serializeDocument`).
 */

import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { createEmptyDocument } from "../../utils/createDocument";
import { createDocx } from "../rezip";

async function documentXmlOf(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) {
    throw new Error("saved DOCX has no word/document.xml");
  }
  return file.async("text");
}

// Issue #417 (eigenpal): integer-typed twip attributes (page size, margins,
// columns, borders, line numbers) must never appear as fractional values in
// the XML, or Microsoft Word rejects the file as corrupt. Callers commonly
// compute twips as `inches * 1440`, which produces drift like
// `0.7 * 1440 === 1008.0000000000001`.
const ANY_DECIMAL_IN_TWIPS_ATTR =
  /w:(?:top|right|bottom|left|header|footer|gutter|w|h|sz|space|num|countBy|start|distance)="-?\d+\.\d+"/u;

describe("document section properties are integer-only (issue #417)", () => {
  test("createEmptyDocument with fractional inches produces no float twips", async () => {
    const doc = createEmptyDocument({
      pageWidth: 8.5 * 1440,
      pageHeight: 11 * 1440,
      marginTop: 0.7 * 1440,
      marginBottom: 0.5 * 1440,
      marginLeft: 1.25 * 1440,
      marginRight: 1.25 * 1440,
    });

    const xml = await documentXmlOf(await createDocx(doc));

    expect(xml).not.toMatch(ANY_DECIMAL_IN_TWIPS_ATTR);
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"');
    expect(xml).toContain('w:top="1008"');
    expect(xml).toContain('w:bottom="720"');
    expect(xml).toContain('w:left="1800"');
    expect(xml).toContain('w:right="1800"');
  });

  test("document root declares the full namespace set needed by raw-replay paths", async () => {
    // The parser preserves unmodeled OOXML children (data hashes, cex /
    // cid extensions) inside `rawPropertiesXml`. A canonical
    // `<w:sdtPr>` with a `<w16sdtdh:dataHash>` would replay an
    // undeclared prefix if the document root only declares the minimal
    // set — Word would refuse to open the file. Pin every w16* prefix
    // here so the regression can't drift.
    const xml = await documentXmlOf(await createDocx(createEmptyDocument()));
    for (const prefix of ["w14", "w15", "w16", "w16cex", "w16cid", "w16sdtdh", "w16se"]) {
      expect(xml).toContain(`xmlns:${prefix}="`);
    }
  });

  test("save-side defense catches drift even if the model carries floats", async () => {
    // Bypass the createEmptyDocument input guard by mutating the model
    // directly — proves the emitter's intAttr() defense works on its own.
    const doc = createEmptyDocument();
    const sectionProps = doc.package.document.finalSectionProperties;
    if (!sectionProps) {
      throw new Error("expected finalSectionProperties on empty document");
    }
    sectionProps.marginTop = 1008.0000000000001;
    sectionProps.marginLeft = 1800.0000001;

    const xml = await documentXmlOf(await createDocx(doc));

    expect(xml).not.toMatch(ANY_DECIMAL_IN_TWIPS_ATTR);
    expect(xml).toContain('w:top="1008"');
    expect(xml).toContain('w:left="1800"');
  });
});
