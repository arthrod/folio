/**
 * Selective Save Module
 *
 * Historically this patched only the changed paragraphs into the original
 * document.xml (routing note edits to their parts, reconciling comment
 * sidecars, splicing numbering definitions), and returned null on any
 * condition it could not handle so the caller fell back to a full repack.
 *
 * The jubarte-backed writer subsumes that optimization: it byte-preserves
 * every unchanged part and regenerates only the parts the model changed, so
 * the selective path and the full repack are now the same operation.
 *
 * The two-tier caller contract is unchanged: a non-null return is the saved
 * DOCX; callers keep their full-repack fallback for a null return (which no
 * longer occurs — kept for signature compatibility).
 */

import type { Document } from "../types/document";
import { repackDocxWithJubarte } from "./jubarte/saveDocx";

export type SelectiveSaveOptions = {
  /** Changed paragraph IDs to selectively patch */
  changedParaIds: Set<string>;
  /** Whether structural changes occurred (paragraph add/delete) */
  structuralChange: boolean;
  /** Whether any changes affected paragraphs without paraId */
  hasUntrackedChanges: boolean;
  /**
   * Historical ceiling on `originalBuffer.byteLength` for the legacy
   * selective path (default: `DEFAULT_SELECTIVE_SAVE_MAX_BYTES` from
   * ./selectiveSaveFlags).
   * The jubarte writer performs selective part regeneration internally
   * without the JSZip double-buffering that motivated the cap, so the
   * option is accepted for signature compatibility but no longer bails.
   */
  maxBytes?: number;
};

/**
 * Save the document. The jubarte writer performs selective part regeneration
 * internally (byte-preserving unchanged parts), so this always saves — none
 * of the historical content-shaped bail-out conditions remain.
 *
 * The caller contract is unchanged: the saved ArrayBuffer, or null on any
 * failure (invalid model, corrupt package) so the caller falls back to the
 * full repack — which reproduces and surfaces the underlying error.
 */
export async function attemptSelectiveSave(
  doc: Document,
  _originalBuffer: ArrayBuffer,
  _options: SelectiveSaveOptions,
): Promise<ArrayBuffer | null> {
  try {
    return await repackDocxWithJubarte(doc);
  } catch {
    // Any error — fall back to full repack.
    return null;
  }
}
