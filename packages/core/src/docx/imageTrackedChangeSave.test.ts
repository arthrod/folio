/**
 * Save-path coverage for a picture that is itself a tracked change.
 *
 * The save collects new image media so a freshly inserted picture's bytes
 * land in `word/media` and a rId is allocated. A tracked picture lives inside
 * an `<w:ins>` / `<w:del>` / `<w:moveFrom>` / `<w:moveTo>` wrapper; without
 * the wrapper-descent fix in the new-image collector, the freshly tracked
 * image is skipped, the rels file references no media for it, and Word
 * renders a broken image. Port of eigenpal docx-editor #641 reviewer-fix
 * commit, asserted through the jubarte-backed save (the legacy selective
 * patcher used the same wrapper-descent gate to bail to the full repack).
 */

import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { Insertion, Paragraph } from "../types/document";
import { createEmptyDocx, repackDocx } from "./rezip";
import { parseDocx } from "./parser";
import { attemptSelectiveSave } from "./selectiveSave";

// 1x1 transparent PNG (valid image bytes, so the media write is realistic).
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SYNTHETIC_RID = "rId_img_123";

function trackedNewImageParagraph(rId?: string): Paragraph {
  const insertion: Insertion = {
    type: "insertion",
    info: {
      id: 99,
      author: "Reviewer",
      date: "2026-05-30T00:00:00Z",
    },
    content: [
      {
        type: "run",
        content: [
          {
            type: "drawing",
            image: {
              type: "image",
              // No rId or a synthetic editor rId means this is a fresh image
              // needing media write.
              ...(rId !== undefined ? { rId } : {}),
              src: PNG_DATA_URL,
              size: { width: 914_400, height: 457_200 },
              wrap: { type: "inline" },
            },
          },
        ],
      },
    ],
  };
  return { type: "paragraph", content: [insertion] };
}

async function saveWithTrackedImage(
  paragraph: Paragraph,
): Promise<{ zip: JSZip; documentXml: string }> {
  const baseline = await createEmptyDocx();
  const doc = await parseDocx(baseline, { preloadFonts: false });
  doc.package.document.content.push(paragraph);

  const saved = await attemptSelectiveSave(doc, baseline, {
    changedParaIds: new Set(),
    structuralChange: false,
    hasUntrackedChanges: false,
  });
  expect(saved).not.toBeNull();

  const zip = await JSZip.loadAsync(saved!);
  const documentXml = (await zip.file("word/document.xml")?.async("text")) ?? "";
  return { zip, documentXml };
}

function expectImageMaterialized(zip: JSZip, documentXml: string): void {
  // Media bytes landed in the package…
  const mediaEntries = Object.keys(zip.files).filter((p) => /^word\/media\/image\d+\./u.test(p));
  expect(mediaEntries.length).toBeGreaterThan(0);
  // …the document references a real (non-synthetic) rId for the drawing…
  expect(documentXml).toContain("r:embed=");
  expect(documentXml).not.toContain(SYNTHETIC_RID);
  // …and the tracked wrapper survived around it.
  expect(documentXml).toMatch(/<w:(?:ins|del)\b/u);
}

describe("save writes media for a tracked-new image (eigenpal #641)", () => {
  test("insertion-wrapped new picture gets media + relationship", async () => {
    const { zip, documentXml } = await saveWithTrackedImage(trackedNewImageParagraph());
    expectImageMaterialized(zip, documentXml);
    const rels = await zip.file("word/_rels/document.xml.rels")?.async("text");
    expect(rels).toContain("media/image");
  });

  test("tracked image with a synthetic editor rId is re-keyed to a real rId", async () => {
    const { zip, documentXml } = await saveWithTrackedImage(
      trackedNewImageParagraph(SYNTHETIC_RID),
    );
    expectImageMaterialized(zip, documentXml);
  });

  test("tracked-DELETED new image (deletion wrapper variant) still gets media", async () => {
    const para: Paragraph = {
      type: "paragraph",
      content: [
        {
          type: "deletion",
          info: {
            id: 100,
            author: "Reviewer",
            date: "2026-05-30T00:00:00Z",
          },
          content: [
            {
              type: "run",
              content: [
                {
                  type: "drawing",
                  image: {
                    type: "image",
                    src: PNG_DATA_URL,
                    size: { width: 914_400, height: 457_200 },
                    wrap: { type: "inline" },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const { zip, documentXml } = await saveWithTrackedImage(para);
    expectImageMaterialized(zip, documentXml);
  });

  test("a text-only insertion wrapper allocates no media", async () => {
    // Baseline guard: the wrapper descent must not over-fire. A paragraph
    // that contains only text in an insertion wrapper has no new media.
    const para: Paragraph = {
      type: "paragraph",
      content: [
        {
          type: "insertion",
          info: {
            id: 101,
            author: "Reviewer",
            date: "2026-05-30T00:00:00Z",
          },
          content: [
            {
              type: "run",
              content: [{ type: "text", text: "added" }],
            },
          ],
        },
      ],
    };
    const baseline = await createEmptyDocx();
    const doc = await parseDocx(baseline, { preloadFonts: false });
    doc.package.document.content.push(para);

    const saved = await repackDocx(doc);
    const zip = await JSZip.loadAsync(saved);
    const mediaEntries = Object.keys(zip.files).filter((p) => p.startsWith("word/media/"));
    expect(mediaEntries).toHaveLength(0);
    const documentXml = await zip.file("word/document.xml")?.async("text");
    expect(documentXml).toContain("added");
  });
});
