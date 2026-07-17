/**
 * Document-body emission helpers for roundtrip tests.
 *
 * Thin re-export of the production jubarte emit document serializer (the
 * legacy `serializeDocument` port that also backs the save orchestrator's
 * opaque-body fallback), plus the auto-id counter reset the legacy
 * serializer performed per pass, so string-level roundtrip tests keep
 * exercising real emission with deterministic drawing/shape ids.
 */

import type { Document, DocumentBody } from "../../types/document";
import {
  serializeDocument as emitDocument,
  serializeDocumentBody as emitDocumentBody,
} from "../jubarte/emit/documentSerializer";
import { resetAutoIdCounter } from "../jubarte/emit/runSerializer";

/** Body-inner XML: all blocks followed by the final `<w:sectPr>` when present. */
export function serializeDocumentBody(body: DocumentBody): string {
  resetAutoIdCounter();
  return emitDocumentBody(body);
}

/** Full document.xml payload, shaped like the legacy `serializeDocument`. */
export function serializeDocument(doc: Document): string {
  resetAutoIdCounter();
  return emitDocument(doc);
}
