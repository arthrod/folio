/**
 * The story-based comparer as a `RedlineEngine` adapter.
 *
 * This is folio's incumbent redline generator: it pairs editable stories,
 * aligns blocks, and applies tracked-change operations to the base package.
 * It stays the default engine (and doubles as a CI identity judge and the
 * fallback rung) until a package-level engine ships as the published default.
 *
 * Deprecated-surface caveats it carries through the port: revision
 * enumeration is body-scoped (`getChanges` does not walk note bodies), and
 * package parts present on only one side are reported through
 * `unprocessedStories`, not compared. Inputs are expected view-resolved (the
 * orchestrator does this).
 */

import { panic } from "better-result";

import { FolioDocxReviewer } from "./ai-edits/headless";
import type {
  FolioAIBlock,
  FolioAIEditOperation,
  FolioAIEditSkippedOperation,
  FolioAIEditSnapshot,
} from "./ai-edits/types";
import { FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION } from "./document-operations";
import { pairFolioDocumentStories } from "./document-stories";
import type { GenerateRedlineUnprocessedStory, RedlineEngine } from "./redline-engine";
import { alignFolioBlocks, type FolioAlignedBlockEvent } from "./version-comparison";

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

/** The incumbent story-based comparer, wrapped as a `RedlineEngine`. */
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
