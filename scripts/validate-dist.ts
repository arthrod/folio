#!/usr/bin/env bun
// Clean-room validation that the *published* shape of `@stll/folio` works.
//
// It builds the package, transforms its package.json to the dist shape exactly
// like the publish workflow (`prepare-publish.ts`), packs a tarball with
// `bun pm pack` (which rewrites `workspace:` / `catalog:` protocols to concrete
// versions), then installs that tarball into a throwaway project OUTSIDE the
// monorepo and runs four checks against it:
//
//   1. Runtime  — ESM `import` of `.`, `/core`, `/markdown`, `/server` loads and
//                 exposes the expected exports.
//   2. Types    — a `.ts` consumer importing from every subpath typechecks under
//                 both `moduleResolution: node16` and `bundler`.
//   3. CSS      — `dist/editor.css` exists, is non-trivial, parses as valid CSS,
//                 carries the bundled rules, and preserves `@fontsource`
//                 `@import`s (not inlined).
//   4. External — React / react-dom / ProseMirror are not bundled into the JS.
//
// Exits non-zero on any failure. Run via `bun run validate-dist`.

import { panic } from "better-result";
import { $ } from "bun";
import { transform } from "lightningcss";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dir, "..");
const prepareScript = path.join(pkgDir, "scripts", "prepare-publish.ts");
const tscBin = path.join(pkgDir, "node_modules", ".bin", "tsc");

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
const record = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};

// 1. Build, transform package.json (reversibly), pack a tarball.
console.log("→ building @stll/folio");
await $`bun run build`.cwd(pkgDir).quiet();

const pkgJsonPath = path.join(pkgDir, "package.json");
const originalPkgJson = await readFile(pkgJsonPath, "utf-8");
const packDir = await mkdtemp(path.join(tmpdir(), "folio-pack-"));
const consumerDir = await mkdtemp(path.join(tmpdir(), "folio-consumer-"));

try {
  console.log("→ transforming package.json to dist shape");
  await $`bun ${prepareScript} ${pkgDir}`.quiet();
  console.log("→ packing tarball");
  await $`bun pm pack --destination ${packDir}`.cwd(pkgDir).quiet();
} finally {
  // Always restore the in-repo source-shape package.json.
  await writeFile(pkgJsonPath, originalPkgJson);
}

const tgz = (await readdir(packDir)).find((f) => f.endsWith(".tgz"));
const tarball = tgz
  ? path.join(packDir, tgz)
  : panic("validate-dist: bun pm pack produced no tarball");

// 2. Install the tarball into a clean consumer project (outside the monorepo so
//    no workspace/catalog resolution leaks in).
console.log(`→ installing tarball into ${consumerDir}`);
await writeFile(
  path.join(consumerDir, "package.json"),
  `${JSON.stringify(
    {
      name: "folio-dist-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
    },
    null,
    2,
  )}\n`,
);
await $`bun add ${tarball} react@^19 react-dom@^19 use-intl@^4 @types/react@^19 @types/react-dom@^19`
  .cwd(consumerDir)
  .quiet();

const installedDir = path.join(consumerDir, "node_modules", "@stll", "folio");
const installedDist = path.join(installedDir, "dist");

// --- Check 1: runtime ESM import of every subpath -------------------------
const runtimeExpect: Record<string, string[]> = {
  "@stll/folio": [
    "DocxEditor",
    "FolioUIProvider",
    "FormattingBar",
    "createDocx",
  ],
  "@stll/folio/core": [
    "createEmptyDocument",
    "applySuggestions",
    "fromMarkdown",
  ],
  "@stll/folio/markdown": ["toMarkdown", "fromMarkdown", "toMarkdownResult"],
  "@stll/folio/server": ["deriveBlockId", "createEmptyDocument", "createDocx"],
};
const runtimeScript = `
const expect = ${JSON.stringify(runtimeExpect)};
let failed = false;
for (const [spec, names] of Object.entries(expect)) {
  try {
    const mod = await import(spec);
    const missing = names.filter((n) => !(n in mod));
    if (missing.length) { failed = true; console.error("missing from " + spec + ": " + missing.join(", ")); }
  } catch (err) { failed = true; console.error("import threw for " + spec + ": " + (err?.message ?? err)); }
}
process.exit(failed ? 1 : 0);
`;
const runtimeFile = path.join(consumerDir, "runtime-check.mjs");
await writeFile(runtimeFile, runtimeScript);
const runtime = await $`node ${runtimeFile}`.cwd(consumerDir).nothrow().quiet();
record(
  "runtime: ESM import of all 4 subpaths",
  runtime.exitCode === 0,
  runtime.exitCode === 0
    ? "all subpaths load with expected exports"
    : runtime.stderr.toString().trim() || "non-zero exit",
);

// --- Check 2: types resolve under node16 AND bundler ----------------------
const consumerTs = `
import { DocxEditor, FolioUIProvider, type DocxEditorProps } from "@stll/folio";
import { createEmptyDocument, type Document } from "@stll/folio/core";
import { fromMarkdown, toMarkdown, type MarkdownOptions } from "@stll/folio/markdown";
import { deriveBlockId, type FolioBlockId } from "@stll/folio/server";

export const used = [DocxEditor, FolioUIProvider, createEmptyDocument, fromMarkdown, toMarkdown, deriveBlockId];
export type Surface = [DocxEditorProps, Document, MarkdownOptions, FolioBlockId];
`;
await writeFile(path.join(consumerDir, "consumer.ts"), consumerTs);

const baseCompilerOptions = {
  target: "es2022",
  jsx: "react-jsx",
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  lib: ["es2022", "dom", "dom.iterable"],
};
const tsconfigs: Record<string, { module: string; moduleResolution: string }> =
  {
    node16: { module: "node16", moduleResolution: "node16" },
    bundler: { module: "preserve", moduleResolution: "bundler" },
  };
const typeChecks = await Promise.all(
  Object.entries(tsconfigs).map(async ([mode, opts]) => {
    const file = path.join(consumerDir, `tsconfig.${mode}.json`);
    await writeFile(
      file,
      `${JSON.stringify(
        {
          compilerOptions: { ...baseCompilerOptions, ...opts },
          files: ["consumer.ts"],
        },
        null,
        2,
      )}\n`,
    );
    const tc = await $`${tscBin} -p ${file}`.cwd(consumerDir).nothrow().quiet();
    return { mode, tc };
  }),
);
for (const { mode, tc } of typeChecks) {
  record(
    `types: tsc --noEmit (moduleResolution: ${mode})`,
    tc.exitCode === 0,
    tc.exitCode === 0
      ? "consumer typechecks against published .d.ts"
      : `${tc.stdout.toString().trim()}${tc.stderr.toString().trim()}`.slice(
          0,
          400,
        ),
  );
}

// --- Check 3: bundled stylesheet ------------------------------------------
const cssPath = path.join(installedDist, "editor.css");
if (!existsSync(cssPath)) {
  record("css: dist/editor.css present", false, "missing from tarball");
} else {
  const css = await readFile(cssPath, "utf-8");
  const fontImports =
    css.match(/@import\s+["']@fontsource\/[^"']+["']/gu) ?? [];
  const requiredRules = [
    ".folio-root",
    ".ProseMirror",
    ".prosemirror-editor-wrapper",
    ".folio-ai-host",
    ".folio-default-button",
  ];
  const missingRules = requiredRules.filter((r) => !css.includes(r));
  // @fontsource must stay a bare @import, never inlined as font data.
  const fontsourceInlined =
    /url\([^)]*@fontsource/u.test(css) || /url\(["']?data:font/u.test(css);

  let parses = true;
  let parseDetail = "";
  try {
    transform({
      filename: "editor.css",
      code: Buffer.from(css),
      minify: false,
    });
  } catch (error) {
    parses = false;
    parseDetail = error instanceof Error ? error.message : String(error);
  }

  const ok =
    css.length > 10_000 &&
    parses &&
    missingRules.length === 0 &&
    fontImports.length >= 20 &&
    !fontsourceInlined;
  const detail = ok
    ? `${(css.length / 1024).toFixed(1)} kB, ${fontImports.length} @fontsource imports preserved, all bundled rules present`
    : [
        css.length <= 10_000 && `too small (${css.length}B)`,
        !parses && `invalid CSS: ${parseDetail}`,
        missingRules.length > 0 && `missing rules: ${missingRules.join(", ")}`,
        fontImports.length < 20 &&
          `only ${fontImports.length} @fontsource imports`,
        fontsourceInlined && "@fontsource appears inlined as font data",
      ]
        .filter(Boolean)
        .join("; ");
  record("css: bundled, valid, @fontsource preserved", ok, detail);
}

// --- Check 4: peers not bundled into the JS -------------------------------
const jsFiles = (await readdir(installedDist)).filter((f) => f.endsWith(".js"));
const allJs = (
  await Promise.all(
    jsFiles.map(
      async (f) => await readFile(path.join(installedDist, f), "utf-8"),
    ),
  )
).join("\n");
// Tell-tale internals that only exist if the dep's source were bundled.
const bundledSentinels = [
  "react-stack-bottom-frame",
  "__SECRET_INTERNALS_DO_NOT_USE",
  "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED",
];
const leaked = bundledSentinels.filter((s) => allJs.includes(s));
// Each peer must appear only as an external import specifier.
const expectedExternals = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "prosemirror-view",
  "prosemirror-state",
];
const notExternalized = expectedExternals.filter(
  (p) =>
    !new RegExp(`from\\s*["']${p.replace(/\//gu, "\\/")}["']`, "u").test(allJs),
);
const dataFontInlined = /["']data:font|["']data:application\/font/u.test(allJs);
const externalOk =
  leaked.length === 0 && notExternalized.length === 0 && !dataFontInlined;
record(
  "external: React / ProseMirror not bundled into JS",
  externalOk,
  externalOk
    ? `${expectedExternals.length} peers imported externally; no bundled internals`
    : [
        leaked.length > 0 && `bundled internals found: ${leaked.join(", ")}`,
        notExternalized.length > 0 &&
          `not imported as external: ${notExternalized.join(", ")}`,
        dataFontInlined && "font data inlined in JS",
      ]
        .filter(Boolean)
        .join("; "),
);

// --- Summary ---------------------------------------------------------------
await rm(packDir, { recursive: true, force: true });
await rm(consumerDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "✓" : "✗"} ${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length > 0) {
  process.exit(1);
}
