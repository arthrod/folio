/**
 * Compare two `.docx` buffers and produce a third buffer whose text
 * differences are represented as tracked changes.
 *
 * `generateRedlineDocx` orchestrates an ordered ladder of `RedlineEngine`
 * adapters (see `./redline-engine`): input views are resolved once here,
 * every engine's output passes an engine-independent self-check (the
 * output's reject-all view must equal the base, its accept-all view the
 * revised document, judged through `FolioDocxReviewer`), and a fully failed
 * ladder raises a typed error — an unverified buffer is never returned.
 *
 * The default ladder is the story-based engine below; package-level engines
 * (jubarte wasm) are injected by the caller via `options.engines`.
 */

import { panic, TaggedError } from "better-result";

import {
  FolioDocxReviewer,
  isFolioResolvedReviewedView,
  type FolioResolvedReviewedView,
} from "./ai-edits/headless";
import type {
  FolioAIBlock,
  FolioAIEditOperation,
  FolioAIEditSkippedOperation,
  FolioAIEditSnapshot,
} from "./ai-edits/types";
import { FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION } from "./document-operations";
import { pairFolioDocumentStories } from "./document-stories";
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
import { alignFolioBlocks, type FolioAlignedBlockEvent } from "./version-comparison";

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

const nextBaseBlockIdByIndex = (events: readonly FolioAlignedBlockEvent[]): (string | null)[] => {
  const nextIds = Array.from<string | null>({ length: events.length });
  let nextId: string | null = null;
  for (let index = events.length - 1; index >= 0; index--) {
    nextIds[index] = nextId;
    const event = events[index];
    if (event?.type === "pair") {
      nextId = event.baseBlock.id;
    } else if (event?.type === "baseOnly") {
      nextId = event.block.id;
    }
  }
  return nextIds;
};

type BuildRedlineOperationsOptions = {
  baseSnapshot: FolioAIEditSnapshot;
  revisedBlocks: readonly FolioAIBlock[];
  nextOperationId: () => string;
};

const buildRedlineOperations = ({
  baseSnapshot,
  revisedBlocks,
  nextOperationId,
}: BuildRedlineOperationsOptions): FolioAIEditOperation[] => {
  const events = alignFolioBlocks(baseSnapshot.blocks, revisedBlocks);
  const anchorIds = nextBaseBlockIdByIndex(events);
  const operations: FolioAIEditOperation[] = [];
  const trailingAdditions: { text: string; styleId?: string }[] = [];
  const lastBaseBlockId = baseSnapshot.blocks.at(-1)?.id ?? null;

  events.forEach((event, eventIndex) => {
    if (event.type === "pair") {
      if (event.baseBlock.text !== event.revisedBlock.text) {
        operations.push({
          id: nextOperationId(),
          type: "replaceBlock",
          blockId: event.baseBlock.id,
          text: event.revisedBlock.text,
        });
      }
      return;
    }
    if (event.type === "baseOnly") {
      operations.push({
        id: nextOperationId(),
        type: "deleteBlock",
        blockId: event.block.id,
      });
      return;
    }
    const anchorId = anchorIds[eventIndex] ?? null;
    if (anchorId === null) {
      trailingAdditions.push({
        text: event.block.text,
        ...(event.block.styleId !== undefined && { styleId: event.block.styleId }),
      });
      return;
    }
    operations.push({
      id: nextOperationId(),
      type: "insertBeforeBlock",
      blockId: anchorId,
      text: event.block.text,
      ...(event.block.styleId !== undefined && { styleId: event.block.styleId }),
    });
  });

  if (lastBaseBlockId === null && baseSnapshot.emptyDocumentAnchorId !== undefined) {
    const firstAddition = trailingAdditions.shift();
    if (firstAddition !== undefined) {
      operations.push({
        id: nextOperationId(),
        type: "replaceBlock",
        blockId: baseSnapshot.emptyDocumentAnchorId,
        text: firstAddition.text,
        ...(firstAddition.styleId !== undefined && { styleId: firstAddition.styleId }),
      });
    }
  }

  for (const addition of trailingAdditions) {
    operations.push({
      id: nextOperationId(),
      type: "insertAfterBlock",
      blockId: lastBaseBlockId ?? baseSnapshot.emptyDocumentAnchorId ?? "redline-unanchored",
      text: addition.text,
      ...(addition.styleId !== undefined && { styleId: addition.styleId }),
    });
  }

  return operations;
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
 * The incumbent story-based comparer as a `RedlineEngine` adapter: pairs
 * editable stories, aligns blocks, and applies tracked-change operations to
 * the base package. Stays the default engine (and a CI identity judge) until
 * a package-level engine ships as the published default.
 *
 * Deprecated-surface caveats: revision enumeration is body-scoped
 * (`getChanges` does not walk note bodies), and package parts present on
 * only one side are reported through `unprocessedStories`, not compared.
 * Inputs are expected view-resolved (the orchestrator does this).
 */
export const storyRedlineEngine: RedlineEngine = {
  name: "folio-story",
  compare: async (base, revised, { author }) => {
    const [baseReviewer, revisedReviewer] = await Promise.all([
      FolioDocxReviewer.fromBuffer(base, { author }),
      FolioDocxReviewer.fromBuffer(revised),
    ]);
    const baseStories = baseReviewer.listStories().map(({ handle }) => handle);
    const revisedStories = revisedReviewer.listStories().map(({ handle }) => handle);
    for (const story of baseStories) {
      if (!baseReviewer.resolveReviewedStory({ story, view: "final" })) {
        panic("A listed base story could not be resolved");
      }
    }

    const skipped: FolioAIEditSkippedOperation[] = [];
    const unprocessedStories: GenerateRedlineUnprocessedStory[] = [];
    let operationSequence = 0;
    const nextOperationId = () => `redline-${++operationSequence}`;

    for (const pair of pairFolioDocumentStories(baseStories, revisedStories)) {
      if (!pair.baseStory) {
        unprocessedStories.push({
          ...pair,
          reason: "missing-base-story",
        });
        continue;
      }
      if (!pair.revisedStory) {
        unprocessedStories.push({
          ...pair,
          reason: "missing-revised-story",
        });
        continue;
      }
      const baseSnapshot = baseReviewer.snapshotStory(pair.baseStory);
      const revisedSnapshot = revisedReviewer.readReviewedStory({
        story: pair.revisedStory,
        view: "final",
      })?.snapshot;
      if (!baseSnapshot || !revisedSnapshot) {
        panic("A matched document story could not be read");
      }
      const operations = buildRedlineOperations({
        baseSnapshot,
        revisedBlocks: revisedSnapshot.blocks,
        nextOperationId,
      });
      if (operations.length === 0) {
        continue;
      }
      const result = baseReviewer.applyDocumentOperationsToStory({
        story: pair.baseStory,
        snapshot: baseSnapshot,
        batch: {
          version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
          mode: "tracked-changes",
          operations,
        },
      });
      skipped.push(...result.skipped);
    }

    return {
      buffer: await baseReviewer.toBuffer(),
      skipped,
      unprocessedStories,
    };
  },
  acceptAll: async (docx) => {
    const reviewer = await FolioDocxReviewer.fromBuffer(docx);
    reviewer.acceptAll();
    return reviewer.toBuffer();
  },
  rejectAll: async (docx) => {
    const reviewer = await FolioDocxReviewer.fromBuffer(docx);
    reviewer.rejectAll();
    return reviewer.toBuffer();
  },
  getRevisions: async (docx) => {
    const reviewer = await FolioDocxReviewer.fromBuffer(docx);
    return reviewer.getChanges().map((change) => ({
      type: change.type === "insertion" ? ("Inserted" as const) : ("Deleted" as const),
      author: change.author,
      date: change.date ?? "",
      part: "word/document.xml",
      moveGroupId: null,
      isMoveSource: null,
      formatChange: null,
      text: change.text,
    }));
  },
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
