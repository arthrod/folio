import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * ONE-pretext-surface invariant (E-4 unification): `@stll/premirror-bridge` is
 * the only workspace package allowed to reference the pretext package (the
 * `@chenglou` scope one this guard scans for; the specifier is spelled split
 * below so the guard cannot match its own prose either). The premirror
 * packages consume an injected `SegmentFitEngineLike` instead. Crude,
 * dependency-free string scan of this package's own src so a reintroduced
 * import fails the suite, not a code review. The needle is split so this guard
 * does not match itself.
 */
const FORBIDDEN_SPECIFIER = ["@chenglou", "pretext"].join("/");
const GUARD_FILE = "one-pretext-surface.test.ts";

describe("one-pretext-surface guard", () => {
  it("no src file references the pretext package", () => {
    const srcDir = new URL(".", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const rel of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: srcDir })) {
      if (rel.endsWith(GUARD_FILE)) continue;
      const content = readFileSync(`${srcDir}${rel}`, "utf8");
      if (content.includes(FORBIDDEN_SPECIFIER)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
