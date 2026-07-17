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
  type FolioResolvedReviewedView,
} from "./ai-edits/headless";
import type { FolioAIEditSkippedOperation } from "./ai-edits/types";
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

/** Deterministic per-story key (handles are small flat objects). */
const storyKey = (handle: object): string => JSON.stringify(handle, Object.keys(handle).sort());

/** Per-story joined block texts of a reviewer at a view. */
const storyViewTexts = (
  reviewer: FolioDocxReviewer,
  view: FolioResolvedReviewedView,
): Map<string, string> => {
  const texts = new Map<string, string>();
  for (const { handle } of reviewer.listStories()) {
    const story = reviewer.readReviewedStory({ story: handle, view });
    if (story) {
      texts.set(storyKey(handle), story.snapshot.blocks.map(({ text }) => text).join("\n"));
    }
  }
  return texts;
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
  baseTexts: Map<string, string>;
  revisedTexts: Map<string, string>;
  exemptKeys: ReadonlySet<string>;
};

/**
 * The engine-independent self-check: the output's reject-all ("original")
 * view must reproduce the base story texts and its accept-all ("final") view
 * the revised story texts. Judged through `FolioDocxReviewer`, never through
 * the engine's own accept/reject. Returns a mismatch description, or `null`.
 */
const verifyRedlineBuffer = async ({
  buffer,
  baseTexts,
  revisedTexts,
  exemptKeys,
}: VerifyRedlineBufferOptions): Promise<string | null> => {
  const output = await FolioDocxReviewer.fromBuffer(buffer);
  const originalTexts = storyViewTexts(output, "original");
  const finalTexts = storyViewTexts(output, "final");
  for (const [key, text] of baseTexts) {
    if (exemptKeys.has(key)) {
      continue;
    }
    if (originalTexts.get(key) !== text) {
      return `reject-all view diverges from the base document for story ${key}`;
    }
  }
  for (const [key, text] of revisedTexts) {
    if (exemptKeys.has(key)) {
      continue;
    }
    if (finalTexts.get(key) !== text) {
      return `accept-all view diverges from the revised document for story ${key}`;
    }
  }
  return null;
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
  const baseTexts = storyViewTexts(baseInput.reviewer, "final");
  const revisedTexts = storyViewTexts(revisedInput.reviewer, "final");

  const attempts: RedlineEngineAttempt[] = [];
  for (const engine of engines) {
    let compared;
    try {
      compared = await engine.compare(baseInput.buffer, revisedInput.buffer, { author });
    } catch (error) {
      attempts.push({ engine: engine.name, phase: "compare", message: String(error) });
      continue;
    }

    const exemptKeys = new Set<string>();
    for (const entry of compared.unprocessedStories ?? []) {
      if (entry.baseStory) {
        exemptKeys.add(storyKey(entry.baseStory));
      }
      if (entry.revisedStory) {
        exemptKeys.add(storyKey(entry.revisedStory));
      }
    }
    const mismatch = await verifyRedlineBuffer({
      buffer: compared.buffer,
      baseTexts,
      revisedTexts,
      exemptKeys,
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
