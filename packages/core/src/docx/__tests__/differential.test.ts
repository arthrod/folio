/**
 * Differential parser testing (folio vs python-docx).
 *
 * Projects folio's parse of every corpus fixture into a structural shape and
 * asserts it matches the same projection taken from python-docx — locking in
 * parse parity across the whole suite, not just a single smoke fixture.
 *
 * python-docx is an optional host dependency (`pip install python-docx`). When
 * it is missing the suite SKIPS locally so `bun test` stays runnable without
 * Python; CI installs python-docx and sets `DIFFERENTIAL_REQUIRED=1`, which
 * turns a missing dependency into a failure so the gate cannot silently pass.
 * See `packages/core/scripts/differential/README.md`.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { runDifferential } from "../../../scripts/differential/diff";

const REQUIRED = process.env.DIFFERENTIAL_REQUIRED === "1";

// The corpus: the parser fixtures plus the visual fixtures (repo root).
const FIXTURE_DIRS = [
  path.join(import.meta.dir, "__fixtures__"),
  path.resolve(import.meta.dir, "../../../../../tests/visual/fixtures"),
];

const fixtures = FIXTURE_DIRS.flatMap((dir) => [
  ...new Glob("**/*.docx").scanSync({ cwd: dir, absolute: true }),
]).sort();

const isPythonDocxAvailable = (): boolean => {
  const result = spawnSync("python3", ["-c", "import docx"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return !result.error && result.status === 0;
};

describe("differential parser harness (folio vs python-docx)", () => {
  if (!isPythonDocxAvailable()) {
    const message =
      "python-docx not installed; see scripts/differential/README.md";
    // Locally a missing optional dependency skips; in CI (DIFFERENTIAL_REQUIRED)
    // it fails so the parity gate cannot silently pass.
    if (REQUIRED) {
      test("python-docx is required when DIFFERENTIAL_REQUIRED=1", () => {
        throw new Error(message);
      });
    } else {
      test.skip(message, () => {});
    }
    return;
  }

  test("corpus is non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    const name = path.basename(fixture);
    test(`structural projection matches python-docx: ${name}`, async () => {
      const result = await runDifferential(fixture);
      if (!result.ok) {
        if (result.reason === "infra") {
          throw new Error(`harness infrastructure failure: ${result.message}`);
        }
        throw new Error(
          `unexpected divergence on ${name}:\n${JSON.stringify(result.divergences, null, 2)}\n\nfolio: ${JSON.stringify(result.folio, null, 2)}\nreference: ${JSON.stringify(result.reference, null, 2)}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});
