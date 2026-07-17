/**
 * Faithful self-check medium for the redline orchestrator.
 *
 * The default self-check (`./redline`) reads text through `FolioDocxReviewer`
 * (folio's `parseDocx` → model → ProseMirror chain). That chain is an editorial
 * projection: it silently drops OOXML it does not model (observed: a deleted
 * hyperlink inside a table cell), so a byte-faithful engine's output fails
 * verification and the ladder falls back off it — a false negative.
 *
 * This module reuses folio's own **XML-direct** extractor,
 * `docx/server/extractDocxText`, which reads `word/document.xml` (and the
 * header/footer parts) straight from the package — no editorial model, nothing
 * dropped. The compare engine's own byte-faithful accept/reject (rust, via the
 * port) materializes the accept-all / reject-all packages; this module only
 * decides whether their extracted text reproduces the revised / base documents.
 *
 * Nothing here parses OOXML by hand: extraction is `extractDocxText`, the only
 * logic added is the comparison policy (main story exact modulo blank-line
 * placement; header/footer by content containment, since their part ids are not
 * stable across packages).
 */

import { extractDocxText, type ExtractedDocxText } from "./docx/server/extractDocxText";

/** Header/footer roles compared by containment (their ids are package-local). */
type SecondaryStorySource = "header" | "footer";

/**
 * A package's comparable text, partitioned like the folio self-check: the body
 * (main story) is singular and matched exactly; header/footer stories carry
 * only package-local ids, so they are matched as non-empty text sets per source
 * (containment).
 */
export type ComparableDocxContent = {
  mainText: string;
  secondaryByType: Map<SecondaryStorySource, string[]>;
};

/** Project folio's `extractDocxText` output into comparable per-story text. */
export const toComparableDocxContent = (extracted: ExtractedDocxText): ComparableDocxContent => {
  const bodyLines: string[] = [];
  const secondaryByType = new Map<SecondaryStorySource, string[]>();
  for (const paragraph of extracted.paragraphs) {
    if (paragraph.text.length === 0) {
      continue;
    }
    if (paragraph.source === "body") {
      bodyLines.push(paragraph.text);
      continue;
    }
    const list = secondaryByType.get(paragraph.source) ?? [];
    list.push(paragraph.text);
    secondaryByType.set(paragraph.source, list);
  }
  return { mainText: bodyLines.join("\n"), secondaryByType };
};

/** Extract a `.docx` package's comparable content via folio's XML-direct reader. */
export const extractComparableDocxContent = async (
  docx: ArrayBuffer,
): Promise<ComparableDocxContent> => toComparableDocxContent(await extractDocxText(docx));

/** Every non-empty expected secondary text must appear in the actual set. */
const secondaryTextsReproduced = (
  expected: ComparableDocxContent,
  actual: ComparableDocxContent,
  label: string,
): string | null => {
  for (const [source, texts] of expected.secondaryByType) {
    const actualSet = new Set(actual.secondaryByType.get(source) ?? []);
    for (const text of texts) {
      if (!actualSet.has(text)) {
        return `${label} view drops a ${source} story`;
      }
    }
  }
  return null;
};

export type CompareLosslessOptions = {
  /** Comparable content of `engine.acceptAll(redline)`. */
  accepted: ComparableDocxContent;
  /** Comparable content of `engine.rejectAll(redline)`. */
  rejected: ComparableDocxContent;
  /** Comparable content of the resolved base document. */
  base: ComparableDocxContent;
  /** Comparable content of the resolved revised document. */
  revised: ComparableDocxContent;
};

/**
 * The self-check: the redline's accept-all view must reproduce the revised
 * document and its reject-all view the base document, judged on folio's
 * XML-direct text. Body exact; header/footer by containment. Returns a mismatch
 * description, or `null` when the buffer verifies.
 */
export const compareLossless = ({
  accepted,
  rejected,
  base,
  revised,
}: CompareLosslessOptions): string | null => {
  if (accepted.mainText !== revised.mainText) {
    return "accept-all main story diverges from the revised document";
  }
  if (rejected.mainText !== base.mainText) {
    return "reject-all main story diverges from the base document";
  }
  return (
    secondaryTextsReproduced(revised, accepted, "accept-all") ??
    secondaryTextsReproduced(base, rejected, "reject-all")
  );
};
