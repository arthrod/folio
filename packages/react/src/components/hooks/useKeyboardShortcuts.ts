import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  classifyEditorKeydown,
  deleteSelectedTable,
  isFocusInInputLike,
  isMacPlatform,
} from "@stll/folio-core/managers/editorShortcuts";
import type { PagedEditorRef } from "../../paged-editor/PagedEditor";
import type { UseFindReplaceReturn } from "../dialogs/useFindReplace";

export type UseKeyboardShortcutsArgs = {
  pagedEditorRef: RefObject<PagedEditorRef | null>;
  findReplace: UseFindReplaceReturn;
  tableSelection: {
    state: { tableIndex: number | null };
    handleAction: (action: "deleteTable") => void;
  };
  /** Triggered on Cmd/Ctrl+P. */
  onDirectPrint: () => void;
};

/**
 * Document-level keyboard shortcuts:
 *  - Cmd/Ctrl+F → open find dialog with selected text
 *  - Cmd/Ctrl+H → open replace dialog
 *  - Cmd/Ctrl+P → trigger the custom print path (intercepts the OS dialog)
 *  - Delete/Backspace → delete the currently selected table when nothing else
 *    is selected (works with both ProseMirror `CellSelection` whole-table
 *    selections and the layout-overlay table selection). Suppressed when
 *    focus is in a non-editor input/textarea/contenteditable to avoid
 *    deleting tables while the user is typing in a sidebar or dialog.
 *
 * Thin React binding: the classification, platform/input predicates, and
 * whole-table deletion check live in `@stll/folio-core`; this hook owns only
 * the listener lifecycle, ref freshness, and the host-callback dispatch.
 */
export function useKeyboardShortcuts({
  pagedEditorRef,
  findReplace,
  tableSelection,
  onDirectPrint,
}: UseKeyboardShortcutsArgs): void {
  // Keep callbacks fresh without re-attaching the global listener on every
  // change to `findReplace.state` (which updates on every search keystroke).
  const callbacksRef = useRef({ findReplace, tableSelection, onDirectPrint });
  callbacksRef.current = { findReplace, tableSelection, onDirectPrint };

  useEffect(() => {
    const openFindFromSelection = () => {
      const selection = window.getSelection();
      const selectedText = selection && !selection.isCollapsed ? selection.toString() : "";
      callbacksRef.current.findReplace.openFind(selectedText);
    };

    const handleDeleteSelectedTable = (e: KeyboardEvent) => {
      const view = pagedEditorRef.current?.getView();
      if (view && deleteSelectedTable(view.state, view.dispatch)) {
        e.preventDefault();
        return;
      }
      if (callbacksRef.current.tableSelection.state.tableIndex !== null) {
        e.preventDefault();
        callbacksRef.current.tableSelection.handleAction("deleteTable");
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const editorDom = pagedEditorRef.current?.getView()?.dom;
      const intent = classifyEditorKeydown(e, {
        isMac: isMacPlatform(),
        isInputLike: isFocusInInputLike(e.target, editorDom),
      });

      switch (intent.type) {
        case "deleteSelectedTable":
          handleDeleteSelectedTable(e);
          return;
        case "openFind":
          e.preventDefault();
          openFindFromSelection();
          return;
        case "print":
          e.preventDefault();
          callbacksRef.current.onDirectPrint();
          return;
        case "none":
          return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [pagedEditorRef]);
}
