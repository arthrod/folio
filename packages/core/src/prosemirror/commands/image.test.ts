import { describe, expect, test } from "bun:test";

import { computeImageTransform, constrainImageSize, resolveImageWrap } from "./image";

describe("resolveImageWrap", () => {
  test("inline keeps the image in the text flow", () => {
    expect(resolveImageWrap("inline")).toEqual({
      wrapType: "inline",
      displayMode: "inline",
      cssFloat: undefined,
    });
  });

  test("square/tight/through float left", () => {
    for (const wrapType of ["square", "tight", "through"] as const) {
      expect(resolveImageWrap(wrapType)).toEqual({
        wrapType,
        displayMode: "float",
        cssFloat: "left",
      });
    }
  });

  test("wrapLeft and wrapRight map to a square float on the opposite side", () => {
    expect(resolveImageWrap("wrapLeft")).toEqual({
      wrapType: "square",
      displayMode: "float",
      cssFloat: "right",
    });
    expect(resolveImageWrap("wrapRight")).toEqual({
      wrapType: "square",
      displayMode: "float",
      cssFloat: "left",
    });
  });

  test("behind/inFront float with no css float", () => {
    expect(resolveImageWrap("behind")).toEqual({
      wrapType: "behind",
      displayMode: "float",
      cssFloat: "none",
    });
  });

  test("unknown wrap modes are rejected", () => {
    expect(resolveImageWrap("nope")).toBeNull();
  });
});

describe("computeImageTransform", () => {
  test("rotate wraps within 0..359 degrees", () => {
    expect(computeImageTransform("rotate(180deg)", "rotateCW")).toBe("rotate(270deg)");
    expect(computeImageTransform("", "rotateCCW")).toBe("rotate(270deg)");
  });

  test("rotating back to 0 degrees drops the transform", () => {
    expect(computeImageTransform("rotate(270deg)", "rotateCW")).toBeUndefined();
  });

  test("flips toggle and combine with rotation", () => {
    expect(computeImageTransform("", "flipH")).toBe("scaleX(-1)");
    expect(computeImageTransform("scaleX(-1)", "flipH")).toBeUndefined();
    expect(computeImageTransform("rotate(90deg) scaleX(-1)", "flipV")).toBe(
      "rotate(90deg) scaleX(-1) scaleY(-1)",
    );
  });
});

describe("constrainImageSize", () => {
  test("leaves images within the max width untouched", () => {
    expect(constrainImageSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  test("scales down oversized images preserving aspect ratio", () => {
    expect(constrainImageSize(1224, 612)).toEqual({ width: 612, height: 306 });
  });
});
