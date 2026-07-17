/**
 * The redline engine port: folio-core's compare seam as one narrow interface
 * with swappable adapters (plugin-style). This module is the **contract only**
 * — the port shape, the revision/result types, and the exhausted-ladder error.
 * Concrete adapters live in their own modules
 * (`./redline-engine-story`, `./redline-engine-jubarte`) and the orchestrator
 * in `./redline`, so the contract never depends on any engine implementation.
 *
 * Engines are byte transformers — DOCX in, DOCX out — so no engine type ever
 * reaches folio's public API surface, and no engine package becomes a
 * dependency of folio-core: adapters wrap modules the caller injects.
 *
 * The orchestrator (`generateRedlineDocx`) walks an ordered engine ladder:
 * compare → engine-independent self-check → revision enumeration; an engine
 * that throws or produces an unverifiable buffer is skipped, and a fully
 * failed ladder raises `RedlineEngineExhaustedError` — never an unverified
 * buffer.
 */

import { TaggedError } from "better-result";

import type { FolioDocumentStoryHandle } from "./ai-edits/headless";
import type { FolioAIEditSkippedOperation } from "./ai-edits/types";

/** Revision kinds enumerated from a redline package. */
export type RedlineRevisionType = "Inserted" | "Deleted" | "Moved" | "FormatChanged";

/**
 * One tracked revision in a redline package — the same object shape as the
 * jubarte CLI's `revisions --json` lines and the wasm `getRevisions` export.
 */
export type RedlineRevision = {
  type: RedlineRevisionType;
  author: string;
  date: string;
  part: string;
  moveGroupId: number | null;
  isMoveSource: boolean | null;
  formatChange: { changedProperties: string[] } | null;
  text: string;
};

/** A package part the story engine could not represent as story-scoped edits. */
export type GenerateRedlineUnprocessedStory = {
  baseStory: FolioDocumentStoryHandle | null;
  revisedStory: FolioDocumentStoryHandle | null;
  reason: "missing-base-story" | "missing-revised-story";
};

export type RedlineCompareOptions = {
  /** Author recorded on the generated tracked changes. */
  author: string;
};

export type RedlineCompareResult = {
  /** The redline package: the base with differences as tracked changes. */
  buffer: ArrayBuffer;
  /** Story-engine coverage gaps; package-level engines omit these. */
  skipped?: FolioAIEditSkippedOperation[];
  unprocessedStories?: GenerateRedlineUnprocessedStory[];
};

/** The port every compare backend implements. */
export type RedlineEngine = {
  /** Stable adapter identifier, recorded on results and error attempts. */
  name: string;
  compare(
    base: ArrayBuffer,
    revised: ArrayBuffer,
    options: RedlineCompareOptions,
  ): Promise<RedlineCompareResult>;
  acceptAll(docx: ArrayBuffer): Promise<ArrayBuffer>;
  rejectAll(docx: ArrayBuffer): Promise<ArrayBuffer>;
  getRevisions(docx: ArrayBuffer): Promise<RedlineRevision[]>;
};

/** One failed rung of the engine ladder. */
export type RedlineEngineAttempt = {
  engine: string;
  phase: "compare" | "self-check" | "revisions";
  message: string;
};

/** Raised when every engine in the ladder failed; carries the attempt log. */
export class RedlineEngineExhaustedError extends TaggedError("RedlineEngineExhaustedError")<{
  message: string;
  attempts: RedlineEngineAttempt[];
}>() {}
