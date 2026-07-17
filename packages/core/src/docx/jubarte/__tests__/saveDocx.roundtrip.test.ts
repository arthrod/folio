/**
 * Save-side roundtrip suites for the jubarte engine (converted from the
 * legacy-vs-jubarte parity harness once `repackDocx` became the jubarte
 * save itself; the legacy string-serializer path is deleted).
 *
 * Suites:
 *  - "save determinism": two fresh parse+save cycles of the same fixture
 *    must reparse to identical models (folio's ids are deterministic; no
 *    normalization is applied or needed).
 *  - "save roundtrip (plain)": zip well-formedness, part-name-set
 *    stability across save cycles (catches part drift such as minted
 *    sidecars), and the second-save model fixed point (the first save may
 *    normalize once: root namespaces, numbering-level w:ind
 *    materialization; a settled document must then be a fixed point).
 *  - "save roundtrip (mutation)": a model edit (append " EDITED" to the
 *    first non-empty text run) must survive save + reparse, and the edited
 *    document must still settle to a fixed point.
 *
 * Run from packages/core (or the repo root) so bunfig.toml preloads the
 * canvas MeasureProvider: `bun test src/docx/jubarte`.
 *
 * NOTE: each save call gets a FRESH parse — repackDocx mutates the model
 * (new rIds, reply-thread markers, threaded-comment paraIds).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import type { BlockContent, Document } from "../../../types/document";
import { parseDocx } from "../../parser";
import type { ParseOptions } from "../../parser";
import { repackDocx } from "../../rezip";
import { diffDocuments } from "./parityDiff";

const CORPUS_DIR = join(import.meta.dir, "../../__tests__/__fixtures__/corpus");
const REGRESSIONS_DIR = join(import.meta.dir, "../../__tests__/__fixtures__/regressions");
const VISUAL_DIR = join(import.meta.dir, "../../../../../../tests/visual/fixtures");
// Sibling-repo review corpus (tracked changes / comments); skipped silently
// when the eigenport checkout is absent.
const REVIEW_DIR = "/Users/arthrod/temp/T/folio_eigen/eigenport/review-fixtures";

const FIXTURE_PATHS: { name: string; path: string }[] = [
  // Tracked-changes / comments review corpus.
  { name: "01-comments-flat.docx", path: join(REVIEW_DIR, "01-comments-flat.docx") },
  {
    name: "02-comment-spanning-paragraphs.docx",
    path: join(REVIEW_DIR, "02-comment-spanning-paragraphs.docx"),
  },
  { name: "03-threaded-comments.docx", path: join(REVIEW_DIR, "03-threaded-comments.docx") },
  { name: "04-insertions.docx", path: join(REVIEW_DIR, "04-insertions.docx") },
  { name: "05-deletions.docx", path: join(REVIEW_DIR, "05-deletions.docx") },
  { name: "06-moves.docx", path: join(REVIEW_DIR, "06-moves.docx") },
  { name: "07-format-changes.docx", path: join(REVIEW_DIR, "07-format-changes.docx") },
  { name: "08-kitchen-sink.docx", path: join(REVIEW_DIR, "08-kitchen-sink.docx") },
  // folio visual fixtures (real-world documents: headers/footers, notes,
  // numbering, images, section properties).
  { name: "sample.docx", path: join(VISUAL_DIR, "sample.docx") },
  { name: "docx-editor-demo.docx", path: join(VISUAL_DIR, "docx-editor-demo.docx") },
  { name: "podily-bps.docx", path: join(VISUAL_DIR, "podily-bps.docx") },
  // SDT-heavy corpus picks (block + inline + nested + range-marker siblings).
  { name: "block-sdt-richtext.docx", path: join(CORPUS_DIR, "block-sdt-richtext.docx") },
  { name: "nested-block-sdt.docx", path: join(CORPUS_DIR, "nested-block-sdt.docx") },
  { name: "inline-sdt-checkbox.docx", path: join(CORPUS_DIR, "inline-sdt-checkbox.docx") },
  { name: "inline-sdt-dropdown.docx", path: join(CORPUS_DIR, "inline-sdt-dropdown.docx") },
  { name: "repeating-section.docx", path: join(CORPUS_DIR, "repeating-section.docx") },
  {
    name: "extraspec-commentrange-sibling.docx",
    path: join(CORPUS_DIR, "extraspec-commentrange-sibling.docx"),
  },
  // Save-path regressions.
  { name: "repack-image-count.docx", path: join(REGRESSIONS_DIR, "repack-image-count.docx") },
  {
    name: "repack-paragraph-sectpr.docx",
    path: join(REGRESSIONS_DIR, "repack-paragraph-sectpr.docx"),
  },
  // Sibling-repo e2e fixtures with CONTENT footnotes/endnotes — the only
  // fixtures that exercise jubarte's note-sidecar regeneration and the
  // per-note paraId re-stamp (the review/visual corpus has separator-only
  // note parts, which the model does not retain).
  {
    name: "footnote-bottom-overflow.docx",
    path: "/Users/arthrod/temp/T/folio_eigen/eigenport/e2e/fixtures/footnote-bottom-overflow.docx",
  },
  {
    name: "endnotes-tracked-changes.docx",
    path: "/Users/arthrod/temp/T/folio_eigen/eigenport/e2e/fixtures/endnotes-tracked-changes.docx",
  },
];

const PARSE_OPTIONS: ParseOptions = {
  preloadFonts: false,
  parseHeadersFooters: true,
  parseNotes: true,
  detectVariables: true,
};

type Fixture = { name: string; buffer: ArrayBuffer };

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const { name, path } of FIXTURE_PATHS) {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      // Fixture unavailable in this checkout — skip silently (mirrors the
      // parse harness policy for the sibling-repo corpus).
      continue;
    }
    fixtures.push({
      name,
      buffer: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    });
  }
  return fixtures;
}

const FIXTURES = loadFixtures();

const parse = (fixture: Fixture): Promise<Document> =>
  parseDocx(fixture.buffer.slice(0), PARSE_OPTIONS);

const reparse = (saved: ArrayBuffer): Promise<Document> => parseDocx(saved, PARSE_OPTIONS);

/**
 * Append " EDITED" to the first non-empty text run in the body (descending
 * into table cells). Returns true when a run was mutated — must be
 * deterministic so both sides receive the identical edit.
 */
function mutateFirstTextRun(doc: Document): boolean {
  return mutateBlocks(doc.package.document.content);
}

function mutateBlocks(blocks: BlockContent[]): boolean {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const item of block.content) {
        if (item.type !== "run") {
          continue;
        }
        for (const content of item.content) {
          if (content.type === "text" && content.text.trim().length > 0) {
            content.text = `${content.text} EDITED`;
            return true;
          }
        }
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (mutateBlocks(cell.content)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** All body text (paragraph runs, descending into tables and hyperlinks). */
function collectBodyText(doc: Document): string {
  const runText = (run: { content: { type: string; text?: string }[] }): string => {
    let text = "";
    for (const content of run.content) {
      if (content.type === "text" && typeof content.text === "string") {
        text += content.text;
      }
    }
    return text;
  };
  const collect = (blocks: BlockContent[]): string => {
    let text = "";
    for (const block of blocks) {
      if (block.type === "paragraph") {
        for (const item of block.content) {
          if (item.type === "run") {
            text += runText(item);
          } else if (item.type === "hyperlink") {
            for (const child of item.children) {
              if (child.type === "run") {
                text += runText(child);
              }
            }
          }
        }
      } else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            text += collect(cell.content);
          }
        }
      }
    }
    return text;
  };
  return collect(doc.package.document.content);
}

function reportDiffs(label: string, diffs: string[]): void {
  if (diffs.length === 0) {
    return;
  }
  console.error(`\n[save-parity:${label}] ${diffs.length}+ differences:`);
  for (const diff of diffs.slice(0, 40)) {
    console.error(`  ${diff}`);
  }
}

describe("save determinism", () => {
  for (const fixture of FIXTURES) {
    test(
      fixture.name,
      async () => {
        const [docA, docB] = await Promise.all([parse(fixture), parse(fixture)]);
        const [savedA, savedB] = [await repackDocx(docA), await repackDocx(docB)];
        const [reparsedA, reparsedB] = await Promise.all([reparse(savedA), reparse(savedB)]);
        const diffs = diffDocuments(reparsedA, reparsedB);
        reportDiffs(`determinism:${fixture.name}`, diffs);
        expect(diffs).toEqual([]);
      },
      60_000,
    );
  }
});

describe("save roundtrip (plain)", () => {
  for (const fixture of FIXTURES) {
    test(
      fixture.name,
      async () => {
        const doc = await parse(fixture);
        const firstSaved = await repackDocx(doc);

        // Zip well-formedness of the saved output.
        const firstZip = await JSZip.loadAsync(firstSaved);
        const documentEntry = firstZip.file("word/document.xml");
        expect(documentEntry).not.toBeNull();
        expect((await documentEntry!.async("text")).includes("<w:body")).toBe(true);

        // Second save cycle: the model must have settled after one save
        // (first-save normalizations: canonical root namespaces,
        // numbering-level w:ind materialization) and the part-name set must
        // be stable (catches per-save part drift such as duplicated media
        // or minted comment sidecars).
        const firstReparsed = await reparse(firstSaved);
        const secondSaved = await repackDocx(await reparse(firstSaved));
        const secondReparsed = await reparse(secondSaved);

        const partNames = (z: JSZip): string[] =>
          Object.keys(z.files)
            .filter((key) => !z.files[key]!.dir)
            .toSorted();
        const secondZip = await JSZip.loadAsync(secondSaved);
        expect(partNames(secondZip)).toEqual(partNames(firstZip));

        const diffs = diffDocuments(firstReparsed, secondReparsed);
        reportDiffs(`plain:${fixture.name}`, diffs);
        expect(diffs).toEqual([]);
      },
      120_000,
    );
  }
});

/**
 * Separator-kind notes (`separator` / `continuationSeparator` /
 * `continuationNotice`) are dropped from the model at parse time, so the
 * reparse diff CANNOT see them. Compare the saved note parts against the
 * ORIGINAL fixture parts: the saved output must keep the same multiset of
 * separator note types (jubarte's sidecar writer drops
 * `continuationNotice`; the save orchestrator splices it back).
 */
describe("note separator fidelity (part-level)", () => {
  const separatorTypes = (xml: string | null): string[] =>
    xml === null
      ? []
      : [...xml.matchAll(/<w:(?:footnote|endnote)\b[^>]*w:type="(?<type>[^"]+)"/gu)]
          .map((m) => m.groups!["type"]!)
          .toSorted();

  const partText = async (buffer: ArrayBuffer, path: string): Promise<string | null> => {
    const zip = await JSZip.loadAsync(buffer);
    const file = zip.file(path);
    return file ? file.async("text") : null;
  };

  for (const fixture of FIXTURES) {
    test(
      fixture.name,
      async () => {
        const doc = await parse(fixture);
        const saved = await repackDocx(doc);
        for (const path of ["word/footnotes.xml", "word/endnotes.xml"]) {
          // oxlint-disable-next-line no-await-in-loop -- two sequential part reads
          const originalTypes = separatorTypes(await partText(fixture.buffer.slice(0), path));
          // oxlint-disable-next-line no-await-in-loop -- see above
          const savedTypes = separatorTypes(await partText(saved, path));
          expect(savedTypes).toEqual(originalTypes);
        }
      },
      120_000,
    );
  }
});

/**
 * Editor-created content: new data-URL images and rId-less hyperlinks go
 * through the ported `processNewImages`/`processNewHyperlinks` pre-passes
 * (media part + relationship written into the package graph through the
 * shim — this also proves jubarte's writer preserves shim-written `.rels`
 * part text); an in-memory header/footer (rId with no relationship) goes
 * through the ported materialization pass. No disk fixture carries these,
 * so they are synthesized onto sample.docx.
 */
describe("save roundtrip (editor-created content)", () => {
  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const sampleFixture = FIXTURES.find((fixture) => fixture.name === "sample.docx");

  const addNewImageAndHyperlink = (doc: Document): void => {
    const paragraph = doc.package.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") {
      throw new Error("sample.docx must contain a paragraph");
    }
    paragraph.content.push({
      type: "run",
      content: [
        {
          type: "drawing",
          image: { src: TINY_PNG, size: { width: 10, height: 10 }, wrap: { type: "inline" } },
        },
      ],
    } as (typeof paragraph.content)[number]);
    paragraph.content.push({
      type: "hyperlink",
      href: "https://example.com/new",
      children: [{ type: "run", content: [{ type: "text", text: "new link" }] }],
    } as (typeof paragraph.content)[number]);
  };

  const addUnmaterializedFooter = (doc: Document): void => {
    doc.package.footers ??= new Map();
    doc.package.footers.set("rId9001", {
      type: "footer",
      hdrFtrType: "default",
      content: [
        {
          type: "paragraph",
          content: [{ type: "run", content: [{ type: "text", text: "New footer text" }] }],
        },
      ],
    });
    const finalProps = doc.package.document.finalSectionProperties;
    if (!finalProps) {
      throw new Error("sample.docx must carry finalSectionProperties");
    }
    finalProps.footerReferences = [
      ...(finalProps.footerReferences ?? []),
      { type: "default", rId: "rId9001" },
    ];
  };

  test(
    "new image + new hyperlink",
    async () => {
      if (!sampleFixture) {
        throw new Error("sample.docx fixture missing");
      }
      const doc = await parse(sampleFixture);
      const originalMediaCount = doc.package.media?.size ?? 0;
      addNewImageAndHyperlink(doc);
      const saved = await repackDocx(doc);

      const reparsed = await reparse(saved);
      expect(collectBodyText(reparsed)).toContain("new link");
      // The data-URL image was registered as a real media part.
      expect(reparsed.package.media?.size ?? 0).toBeGreaterThan(originalMediaCount);

      // Settled fixed point still holds with the new content.
      const secondReparsed = await reparse(await repackDocx(await reparse(saved)));
      const diffs = diffDocuments(reparsed, secondReparsed);
      reportDiffs("editor:new image + new hyperlink", diffs);
      expect(diffs).toEqual([]);
    },
    120_000,
  );

  test(
    "unmaterialized footer",
    async () => {
      if (!sampleFixture) {
        throw new Error("sample.docx fixture missing");
      }
      const doc = await parse(sampleFixture);
      addUnmaterializedFooter(doc);
      const saved = await repackDocx(doc);

      const zip = await JSZip.loadAsync(saved);
      expect(Object.keys(zip.files).some((f) => /^word\/footer\d+\.xml$/u.test(f))).toBe(true);
      const reparsed = await reparse(saved);
      const footerTexts = [...(reparsed.package.footers?.values() ?? [])].map((footer) =>
        JSON.stringify(footer.content),
      );
      expect(footerTexts.some((text) => text.includes("New footer text"))).toBe(true);
    },
    120_000,
  );
});

describe("save roundtrip (mutation)", () => {
  for (const fixture of FIXTURES) {
    test(
      fixture.name,
      async () => {
        const doc = await parse(fixture);
        const mutated = mutateFirstTextRun(doc);
        const saved = await repackDocx(doc);
        const reparsed = await reparse(saved);

        // The edit must survive save + reparse.
        if (mutated) {
          expect(collectBodyText(reparsed)).toContain(" EDITED");
        }

        // The edited document still settles to a fixed point.
        const secondReparsed = await reparse(await repackDocx(await reparse(saved)));
        const diffs = diffDocuments(reparsed, secondReparsed);
        reportDiffs(`mutation:${fixture.name}`, diffs);
        expect(diffs).toEqual([]);
      },
      120_000,
    );
  }
});
