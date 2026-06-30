/**
 * Bidi shortcut controller — framework-agnostic state machine for the
 * Ctrl/Cmd+Shift direction shortcut, split out from the plugin wiring (which
 * reaches the singleton schema) so it can be imported and unit-tested without
 * triggering schema initialization.
 *
 * The direction change is armed on the Shift keydown (while Ctrl/Cmd is held)
 * but only applied on the Shift keyup, and is cancelled if any other key is
 * pressed in between. That deferral is what keeps the shortcut from hijacking
 * longer chords that also start with Ctrl/Cmd+Shift — most importantly the redo
 * chord Ctrl/Cmd+Shift+Z: firing the direction change on the Shift keydown would
 * record a paragraph-attribute transaction that wipes the editor's redo stack
 * before the "Z" ever arrives, so redo would silently restore nothing.
 */

/** Paragraph base-direction a bidi shortcut applies. */
export type BidiDirection = "ltr" | "rtl";

/** Minimal keyboard-event shape the bidi controller reads. */
export type BidiKeyEvent = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
};

export type BidiShortcutController = {
  /** Track a keydown: arm on Ctrl/Cmd+Shift, cancel on any other key. */
  handleKeyDown: (event: BidiKeyEvent) => void;
  /** On Shift keyup, return the armed direction (and disarm), else null. */
  handleKeyUp: (event: BidiKeyEvent) => BidiDirection | null;
};

export const createBidiShortcutController = (): BidiShortcutController => {
  let armed: BidiDirection | null = null;

  return {
    handleKeyDown(event: BidiKeyEvent): void {
      if (event.key !== "Shift") {
        // A non-Shift key means the Shift was the start of a larger chord
        // (e.g. Ctrl/Cmd+Shift+Z); abandon the direction change.
        armed = null;
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) {
        armed = null;
        return;
      }
      if (event.code === "ShiftLeft") {
        armed = "ltr";
      } else if (event.code === "ShiftRight") {
        armed = "rtl";
      } else {
        armed = null;
      }
    },

    handleKeyUp(event: BidiKeyEvent): BidiDirection | null {
      if (event.key !== "Shift") {
        return null;
      }
      const direction = armed;
      armed = null;
      return direction;
    },
  };
};
