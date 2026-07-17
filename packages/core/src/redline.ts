/**
 * Compare two `.docx` buffers and produce a third buffer whose text
 * differences are represented as tracked changes.
 *
 * `generateRedlineDocx` is the **orchestrator**: it resolves input views once,
 * walks an ordered ladder of `RedlineEngine` adapters (contract in
 * `./redline-engine`; adapters in `./redline-engine-story` and
 * `./redline-engine-jubarte`), runs an engine-independent self-check on every
 * engine's output (the output's reject-all view must equal the base, its
 * accept-all view the revised document, judged through `FolioDocxReviewer`),
 * and raises a typed error when the whole ladder fails — an unverified buffer
 * is never returned. It holds no engine implementation of its own.
 *
 * The default ladder is the story engine; package-level engines (jubarte
 * wasm) are injected by the caller via `options.engines`.
 */

import { TaggedError } from "better-result";

import {
  FolioDocxReviewer,
  isFolioResolvedReviewedView,
  type FolioDocumentStoryHandle,
  type FolioResolvedReviewedView,
} from "./ai-edits/headless";
import type { FolioAIEditSkippedOperation, FolioAIEditSnapshot } from "./ai-edits/types";
import {
  resolveFolioDocumentPrivacyTransforms,
  rewriteDocxMetadataPrivacy,
  type FolioDocumentPrivacyOptions,
  type FolioDocumentPrivacyReport,
} from "./docx/metadataPrivacy";
import {
  RedlineEngineExhaustedError,
  type GenerateRedlineUnprocessedStory,
  type RedlineEngine,
  type RedlineEngineAttempt,
  type RedlineRevision,
} from "./redline-engine";
import { storyRedlineEngine } from "./redline-engine-story";

export type { GenerateRedlineUnprocessedStory } from "./redline-engine";

/** Options for {@link generateRedlineDocx}. */
export type GenerateRedlineDocxOptions = {
  /** Author recorded on the generated tracked changes. (default: `"folio compare"`) */
  author?: string;
  /** Resolved base input state. (default: `"final"`) */
  baseView?: FolioResolvedReviewedView;
  /** Resolved revised input state. (default: `"final"`) */
  revisedView?: FolioResolvedReviewedView;
  /** Optional output-only package-metadata privacy transforms. */
  privacy?: FolioDocumentPrivacyOptions;
  /**
   * Ordered engine ladder. The first engine whose output passes the
   * self-check wins. (default: the story-based engine)
   */
  engines?: RedlineEngine[];
};

export class InvalidGenerateRedlineDocxOptionsError extends TaggedError(
  "InvalidGenerateRedlineDocxOptionsError",
)<{
  message: string;
  option: "baseView" | "revisedView";
  receivedValue: unknown;
}>() {}

/** Result of {@link generateRedlineDocx}. */
export type GenerateRedlineDocxResult = {
  /** The base package with generated tracked changes. */
  buffer: ArrayBuffer;
  /** Tracked revisions enumerated from the produced buffer. */
  revisions: RedlineRevision[];
  /** Name of the engine that produced (and passed verification for) the buffer. */
  engine: string;
  /**
   * @deprecated Only the story engine reports skipped operations; package-level
   * engines always return `[]`. Scheduled for removal at the next major.
   */
  skipped: FolioAIEditSkippedOperation[];
  /**
   * @deprecated Only the story engine reports unprocessed parts; package-level
   * engines always return `[]`. Scheduled for removal at the next major.
   */
  unprocessedStories: GenerateRedlineUnprocessedStory[];
  /** Privacy transforms applied to the generated package. */
  privacyReport: FolioDocumentPrivacyReport;
};

const resolveInputView = (
  value: unknown,
  option: "baseView" | "revisedView",
): FolioResolvedReviewedView => {
  if (value === undefined) {
    return "final";
  }
  if (!isFolioResolvedReviewedView(value)) {
    throw new InvalidGenerateRedlineDocxOptionsError({
      message: `${option} must be original or final.`,
      option,
      receivedValue: value,
    });
  }
  return value;
};

/**
 * A reviewer's story texts at one view, partitioned for the self-check.
 *
 * The main story is singular and stably identified, so it is compared
 * exactly. Header/footer/footnote/endnote stories are identified only by a
 * document-local relationship id / note id (see `FolioDocumentStoryHandle`),
 * which is NOT stable across the base, revised, and output packages — so they
 * are compared as non-empty text sets per type (containment), never keyed by
 * that unstable id. Empty secondary stories (blank headers, doc-id-stamp-only
 * footers folio does not surface as text) carry no signal and are dropped.
 */
type StoryTexts = {
  mainText: string;
  secondaryByType: Map<FolioDocumentStoryHandle["type"], string[]>;
};

const joinBlocks = (story: { snapshot: FolioAIEditSnapshot }): string =>
  story.snapshot.blocks.map(({ text }) => text).join("\n");

const collectStoryTexts = (
  reviewer: FolioDocxReviewer,
  view: FolioResolvedReviewedView,
): StoryTexts => {
  let mainText = "";
  const secondaryByType = new Map<FolioDocumentStoryHandle["type"], string[]>();
  for (const { handle } of reviewer.listStories()) {
    const story = reviewer.readReviewedStory({ story: handle, view });
    if (!story) {
      continue;
    }
    const text = joinBlocks(story);
    if (handle.type === "main") {
      mainText = text;
      continue;
    }
    if (text.trim().length === 0) {
      continue;
    }
    const list = secondaryByType.get(handle.type) ?? [];
    list.push(text);
    secondaryByType.set(handle.type, list);
  }
  return { mainText, secondaryByType };
};

/** Final-view text of a single story handle (for unprocessed-story exemption). */
const resolveHandleText = (
  reviewer: FolioDocxReviewer,
  handle: FolioDocumentStoryHandle,
): string => {
  const story = reviewer.readReviewedStory({ story: handle, view: "final" });
  return story ? joinBlocks(story) : "";
};

type ResolvedRedlineInput = {
  /** Bytes fed to the engines: raw when clean, view-materialized otherwise. */
  buffer: ArrayBuffer;
  /** Reviewer over `buffer`, the self-check reference. */
  reviewer: FolioDocxReviewer;
};

/**
 * Resolve an input to its requested view once, for every engine uniformly.
 * Clean inputs pass through untouched so byte-level engines see the pristine
 * package. (Known limit: pending note-body changes are invisible to
 * `getChanges`/`acceptAll`, matching the reviewer's documented body scope.)
 */
const resolveRedlineInput = async (
  buffer: ArrayBuffer,
  view: FolioResolvedReviewedView,
): Promise<ResolvedRedlineInput> => {
  const reviewer = await FolioDocxReviewer.fromBuffer(buffer);
  if (reviewer.getChanges().length === 0) {
    return { buffer, reviewer };
  }
  if (view === "original") {
    reviewer.rejectAll();
  } else {
    reviewer.acceptAll();
  }
  return { buffer: await reviewer.toBuffer(), reviewer };
};

type VerifyRedlineBufferOptions = {
  buffer: ArrayBuffer;
  baseTexts: StoryTexts;
  revisedTexts: StoryTexts;
  /** Final-view texts of stories the engine reported as processed on one side only. */
  exemptBaseTexts: ReadonlySet<string>;
  exemptRevisedTexts: ReadonlySet<string>;
};

/** Every non-empty expected secondary text must appear in the actual set. */
const secondaryTextsReproduced = (
  expected: StoryTexts,
  actual: StoryTexts,
  exempt: ReadonlySet<string>,
  label: string,
): string | null => {
  for (const [type, texts] of expected.secondaryByType) {
    const actualSet = new Set(actual.secondaryByType.get(type) ?? []);
    for (const text of texts) {
      if (exempt.has(text) || actualSet.has(text)) {
        continue;
      }
      return `${label} view drops a ${type} story`;
    }
  }
  return null;
};

/**
 * The engine-independent self-check: the output's reject-all ("original")
 * view must reproduce the base document and its accept-all ("final") view the
 * revised document, judged through `FolioDocxReviewer` (never the engine's own
 * accept/reject). The main story is matched exactly; secondary stories by
 * non-empty-text containment (relationship ids are not stable across
 * packages). Returns a mismatch description, or `null`.
 */
const verifyRedlineBuffer = async ({
  buffer,
  baseTexts,
  revisedTexts,
  exemptBaseTexts,
  exemptRevisedTexts,
}: VerifyRedlineBufferOptions): Promise<string | null> => {
  const output = await FolioDocxReviewer.fromBuffer(buffer);
  const rejected = collectStoryTexts(output, "original");
  const accepted = collectStoryTexts(output, "final");
  if (accepted.mainText !== revisedTexts.mainText) {
    return "accept-all main story diverges from the revised document";
  }
  if (rejected.mainText !== baseTexts.mainText) {
    return "reject-all main story diverges from the base document";
  }
  return (
    secondaryTextsReproduced(revisedTexts, accepted, exemptRevisedTexts, "accept-all") ??
    secondaryTextsReproduced(baseTexts, rejected, exemptBaseTexts, "reject-all")
  );
};

/**
 * Compare two buffers and return tracked changes for every matched editable
 * story, produced by the first engine in the ladder whose output verifies.
 */
export const generateRedlineDocx = async (
  base: ArrayBuffer,
  revised: ArrayBuffer,
  options: GenerateRedlineDocxOptions = {},
): Promise<GenerateRedlineDocxResult> => {
  const baseView = resolveInputView(options.baseView, "baseView");
  const revisedView = resolveInputView(options.revisedView, "revisedView");
  const author = options.author ?? "folio compare";
  const privacyTransforms = resolveFolioDocumentPrivacyTransforms(
    options.privacy?.transforms ?? [],
  );
  const engines = options.engines ?? [storyRedlineEngine];

  const [baseInput, revisedInput] = await Promise.all([
    resolveRedlineInput(base, baseView),
    resolveRedlineInput(revised, revisedView),
  ]);
  const baseTexts = collectStoryTexts(baseInput.reviewer, "final");
  const revisedTexts = collectStoryTexts(revisedInput.reviewer, "final");

  const attempts: RedlineEngineAttempt[] = [];
  for (const engine of engines) {
    let compared;
    try {
      compared = await engine.compare(baseInput.buffer, revisedInput.buffer, { author });
    } catch (error) {
      attempts.push({ engine: engine.name, phase: "compare", message: String(error) });
      continue;
    }

    // Stories the engine reported as present on only one side are not required
    // to round-trip; exempt them by their resolved text.
    const exemptBaseTexts = new Set<string>();
    const exemptRevisedTexts = new Set<string>();
    for (const entry of compared.unprocessedStories ?? []) {
      if (entry.baseStory) {
        exemptBaseTexts.add(resolveHandleText(baseInput.reviewer, entry.baseStory));
      }
      if (entry.revisedStory) {
        exemptRevisedTexts.add(resolveHandleText(revisedInput.reviewer, entry.revisedStory));
      }
    }
    const mismatch = await verifyRedlineBuffer({
      buffer: compared.buffer,
      baseTexts,
      revisedTexts,
      exemptBaseTexts,
      exemptRevisedTexts,
    });
    if (mismatch !== null) {
      attempts.push({ engine: engine.name, phase: "self-check", message: mismatch });
      continue;
    }

    let revisions: RedlineRevision[];
    try {
      revisions = await engine.getRevisions(compared.buffer);
    } catch (error) {
      attempts.push({ engine: engine.name, phase: "revisions", message: String(error) });
      continue;
    }

    const privacyResult =
      privacyTransforms.length === 0
        ? {
            buffer: compared.buffer,
            privacyReport: { appliedTransforms: [], removedMetadataProperties: [] },
          }
        : await rewriteDocxMetadataPrivacy(compared.buffer, { transforms: privacyTransforms });
    return {
      buffer: privacyResult.buffer,
      revisions,
      engine: engine.name,
      skipped: compared.skipped ?? [],
      unprocessedStories: compared.unprocessedStories ?? [],
      privacyReport: privacyResult.privacyReport,
    };
  }

  throw new RedlineEngineExhaustedError({
    message: `every redline engine failed (${attempts.length} attempt(s))`,
    attempts,
  });
};
