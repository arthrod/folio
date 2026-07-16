/**
 * Focused unit tests for the jubarte save orchestrator: the paraId/textId
 * re-stamp pass (must never corrupt on count mismatch), the no-buffer
 * contract, `createDocxWithJubarte`, `RepackOptions` honoring, and the
 * package fidelity gate. The cross-engine model parity lives in
 * saveDocx.parity.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import type { Document } from "../../../types/document";
import { parseDocx } from "../../parser";
import type { ParseOptions } from "../../parser";
import { repackDocx } from "../../rezip";
import {
  createDocxWithJubarte,
  DocxPackageFidelityError,
  repackDocxWithJubarte,
  stampParagraphTags,
} from "../saveDocx";
import { countParagraphTags, type ParagraphTagExpectation } from "../toAst";

const PARSE_OPTIONS: ParseOptions = {
  preloadFonts: false,
  parseHeadersFooters: true,
  parseNotes: true,
  detectVariables: true,
};

const SAMPLE_PATH = join(import.meta.dir, "../../../../../../tests/visual/fixtures/sample.docx");

function loadSample(): ArrayBuffer {
  const raw = readFileSync(SAMPLE_PATH);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

describe("countParagraphTags", () => {
  test("counts open, self-closing, and attributed tags", () => {
    expect(countParagraphTags('<w:p></w:p><w:p/><w:p w14:paraId="AA"></w:p>')).toBe(3);
  });

  test("does not match prefix-colliding tags", () => {
    expect(countParagraphTags('<w:pPr></w:pPr><w:pict/><w:pStyle w:val="x"/>')).toBe(0);
  });
});

describe("stampParagraphTags", () => {
  test("stamps paraId and textId on typed tags in document order", () => {
    const xml = "<w:body><w:p><w:r/></w:p><w:p></w:p></w:body>";
    const tags: ParagraphTagExpectation[] = [
      { kind: "typed", paraId: "11111111", textId: "22222222" },
      { kind: "typed", paraId: "33333333" },
    ];
    expect(stampParagraphTags(xml, tags)).toBe(
      '<w:body><w:p w14:paraId="11111111" w14:textId="22222222"><w:r/></w:p>' +
        '<w:p w14:paraId="33333333"></w:p></w:body>',
    );
  });

  test("skips opaque-carrier tags untouched", () => {
    // Middle <w:p> came out of a verbatim carrier and already has its id.
    const xml = '<w:p></w:p><w:p w14:paraId="FFFFFFFF"></w:p><w:p></w:p>';
    const tags: ParagraphTagExpectation[] = [
      { kind: "typed", paraId: "AAAAAAAA" },
      { kind: "opaque", count: 1 },
      { kind: "typed", paraId: "BBBBBBBB" },
    ];
    expect(stampParagraphTags(xml, tags)).toBe(
      '<w:p w14:paraId="AAAAAAAA"></w:p><w:p w14:paraId="FFFFFFFF"></w:p>' +
        '<w:p w14:paraId="BBBBBBBB"></w:p>',
    );
  });

  test("stamps self-closing placeholders", () => {
    const tags: ParagraphTagExpectation[] = [{ kind: "typed", paraId: "ABCD1234" }];
    expect(stampParagraphTags("<w:tc><w:p/></w:tc>", tags)).toBe(
      '<w:tc><w:p w14:paraId="ABCD1234"/></w:tc>',
    );
  });

  test("leaves typed tags without ids untouched", () => {
    const tags: ParagraphTagExpectation[] = [{ kind: "typed" }];
    expect(stampParagraphTags("<w:p></w:p>", tags)).toBe("<w:p></w:p>");
  });

  test("returns null on tag-count mismatch (never corrupt)", () => {
    const tags: ParagraphTagExpectation[] = [
      { kind: "typed", paraId: "AAAAAAAA" },
      { kind: "typed", paraId: "BBBBBBBB" },
    ];
    expect(stampParagraphTags("<w:p></w:p>", tags)).toBeNull();
    expect(stampParagraphTags("<w:p/><w:p/><w:p/>", tags)).toBeNull();
  });
});

describe("repackDocxWithJubarte contract", () => {
  test("requires an original buffer", async () => {
    const doc = { package: { document: { content: [] } } } as unknown as Document;
    await expect(repackDocxWithJubarte(doc)).rejects.toThrow(
      "Cannot repack document: no original buffer for round-trip",
    );
  });

  test("throws DocxPackageFidelityError when the model drops header references", async () => {
    const doc = await parseDocx(loadSample(), PARSE_OPTIONS);
    // Model still carries the parsed header PART but the section no longer
    // references it — the serialized document.xml would silently drop the
    // reference. Legacy repackDocx refuses this; the jubarte save must too.
    expect(doc.package.headers?.size ?? 0).toBeGreaterThan(0);
    const finalProps = doc.package.document.finalSectionProperties;
    expect(finalProps?.headerReferences?.length ?? 0).toBeGreaterThan(0);
    delete finalProps!.headerReferences;
    for (const block of doc.package.document.content) {
      if (block.type === "paragraph" && block.sectionProperties) {
        delete block.sectionProperties.headerReferences;
      }
    }
    await expect(repackDocxWithJubarte(doc)).rejects.toThrow(DocxPackageFidelityError);
  });
});

describe("RepackOptions", () => {
  test("updateModifiedDate=false leaves docProps/core.xml byte-identical", async () => {
    const buffer = loadSample();
    const originalCore = await (
      await JSZip.loadAsync(buffer.slice(0))
    )
      .file("docProps/core.xml")!
      .async("text");
    const doc = await parseDocx(buffer, PARSE_OPTIONS);
    const saved = await repackDocxWithJubarte(doc, { updateModifiedDate: false });
    const savedCore = await (await JSZip.loadAsync(saved)).file("docProps/core.xml")!.async("text");
    expect(savedCore).toBe(originalCore);
  });

  test("updateModifiedDate/modifiedBy produce the same core.xml as the legacy save", async () => {
    // NOTE: sample.docx carries a SELF-CLOSING `<cp:lastModifiedBy/>`, which
    // the legacy `updateCoreProperties` regex does not rewrite — the port
    // must reproduce that quirk, so this asserts legacy-vs-jubarte equality
    // (timestamps normalized), not an absolute expectation.
    const options = { updateModifiedDate: true, modifiedBy: "Jubarte Test Bot" };
    const [docLegacy, docJubarte] = await Promise.all([
      parseDocx(loadSample(), PARSE_OPTIONS),
      parseDocx(loadSample(), PARSE_OPTIONS),
    ]);
    const legacySaved = await repackDocx(docLegacy, options);
    const jubarteSaved = await repackDocxWithJubarte(docJubarte, options);
    const core = async (buffer: ArrayBuffer): Promise<string> =>
      (await (await JSZip.loadAsync(buffer)).file("docProps/core.xml")!.async("text")).replace(
        /<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/u,
        "<dcterms:modified>NORMALIZED</dcterms:modified>",
      );
    const jubarteCore = await core(jubarteSaved);
    expect(jubarteCore).toBe(await core(legacySaved));
    expect(jubarteCore).toContain("<dcterms:modified>NORMALIZED</dcterms:modified>");
  });

  test("compressionLevel is honored on the final zip", async () => {
    const doc0 = await parseDocx(loadSample(), PARSE_OPTIONS);
    const doc9 = await parseDocx(loadSample(), PARSE_OPTIONS);
    const stored = await repackDocxWithJubarte(doc0, {
      compressionLevel: 0,
      updateModifiedDate: false,
    });
    const compressed = await repackDocxWithJubarte(doc9, {
      compressionLevel: 9,
      updateModifiedDate: false,
    });
    expect(stored.byteLength).toBeGreaterThan(compressed.byteLength);
    // Both stay valid packages.
    expect((await JSZip.loadAsync(stored)).file("word/document.xml")).not.toBeNull();
    expect((await JSZip.loadAsync(compressed)).file("word/document.xml")).not.toBeNull();
  });
});

describe("createDocxWithJubarte", () => {
  // A model without `finalSectionProperties` is refused by BOTH saves: the
  // empty scaffold carries a `<w:sectPr>`, so a serialization without one
  // trips the package fidelity gate (verified against legacy `createDocx`).
  // The section properties below keep the model createable, mirroring what
  // the editor always supplies.
  const newDocumentModel = (): Document =>
    ({
      package: {
        document: {
          content: [
            {
              type: "paragraph" as const,
              paraId: "1234ABCD",
              content: [
                {
                  type: "run" as const,
                  formatting: { bold: true },
                  content: [{ type: "text" as const, text: "Hello jubarte" }],
                },
              ],
            },
          ],
          finalSectionProperties: {},
        },
      },
    }) as unknown as Document;

  test("creates a parseable DOCX from a model without an original buffer", async () => {
    const buffer = await createDocxWithJubarte(newDocumentModel());
    const reparsed = await parseDocx(buffer, { preloadFonts: false });
    const paragraph = reparsed.package.document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      throw new Error("unreachable");
    }
    expect(paragraph.paraId).toBe("1234ABCD");
    const run = paragraph.content[0];
    expect(run?.type).toBe("run");
    if (run?.type !== "run") {
      throw new Error("unreachable");
    }
    expect(run.formatting?.bold).toBe(true);
    expect(run.content[0]).toEqual({ type: "text", text: "Hello jubarte" });
  });

  test("reparses to the same model as the legacy createDocx", async () => {
    const { createDocx } = await import("../../rezip");
    const legacyBuffer = await createDocx(newDocumentModel());
    const jubarteBuffer = await createDocxWithJubarte(newDocumentModel());
    const { diffDocuments } = await import("./parityDiff");
    const [legacyReparsed, jubarteReparsed] = await Promise.all([
      parseDocx(legacyBuffer, { preloadFonts: false }),
      parseDocx(jubarteBuffer, { preloadFonts: false }),
    ]);
    expect(diffDocuments(legacyReparsed, jubarteReparsed)).toEqual([]);
  });
});
