import { describe, expect, it } from "bun:test";

import {
  DEFAULT_LAYOUT_POLICIES,
  LETTER_PAGE_PX,
  createLayoutInputFromOptions,
  defaultPremirrorOptions,
  pageSpecForPreset,
} from "./index";

describe("@premirror/core", () => {
  it("resolves page presets", () => {
    const letter = pageSpecForPreset("letter");
    const a4 = pageSpecForPreset("a4");
    expect(letter.widthPx).toBe(LETTER_PAGE_PX.widthPx);
    expect(a4.widthPx).not.toBe(letter.widthPx);
  });

  it("creates default options", () => {
    const options = defaultPremirrorOptions();
    expect(options.page.widthPx).toBeGreaterThan(0);
    expect(options.typography.defaultLineHeightPx).toBeGreaterThan(0);
    expect(options.policies?.slotSelectionPolicy).toBe("single_slot_flow");
  });

  it("merges layout input policies with defaults", () => {
    const options = defaultPremirrorOptions({
      policies: { keepWithNextEnabled: false },
    });
    const input = createLayoutInputFromOptions(options);
    expect(input.policies.keepWithNextEnabled).toBe(false);
    expect(input.policies.widowLinesMin).toBe(DEFAULT_LAYOUT_POLICIES.widowLinesMin);
  });
});

describe("defaultPremirrorOptions policies merge (PR #110 review)", () => {
  it("retains unspecified policy defaults when a partial policies override is given", () => {
    const options = defaultPremirrorOptions({ policies: { keepWithNextEnabled: false } });
    expect(options.policies.keepWithNextEnabled).toBe(false);
    expect(options.policies.widowLinesMin).toBe(DEFAULT_LAYOUT_POLICIES.widowLinesMin);
    expect(options.policies.orphanLinesMin).toBe(DEFAULT_LAYOUT_POLICIES.orphanLinesMin);
    expect(options.policies.minSlotWidthPx).toBe(DEFAULT_LAYOUT_POLICIES.minSlotWidthPx);
  });
});
