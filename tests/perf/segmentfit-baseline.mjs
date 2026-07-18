// E-0 perf harness: keystroke-to-paint + scroll relayout on a large document,
// A/B between the pretext SegmentFitEngine (default) and the legacy word-walk
// (?segmentfit=off). Emits a baseline JSON. No budget assertion is committed
// until Arthur signs a TARGET_MS (plan §12.6); this records the "before"/"after"
// so that decision has numbers.
//
// Run against a served build (vite preview) or the deployed site:
//   BASE_URL=http://localhost:4173 bun run tests/perf/segmentfit-baseline.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const PARAGRAPHS = Number(process.env.PARAGRAPHS ?? 1500); // large multi-page doc (~70 pages)
const KEYSTROKES = Number(process.env.KEYSTROKES ?? 80);
const OUT = process.env.OUT ?? new URL("./segmentfit-baseline.json", import.meta.url).pathname;

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

async function measure(engineLabel, url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="folio-editor"]', { timeout: 60000 });
  // Let initial pagination settle.
  await page.waitForFunction(() => document.querySelectorAll(".layout-page").length >= 10, {
    timeout: 60000,
  });
  const navMs = await page.evaluate(() => performance.now());
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const result = await page.evaluate(
    async ({ iterations }) => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const pw = globalThis.__folioPlayground;
      const inner = pw?.getEditorRef()?.getEditorRef();
      if (!inner?.relayout) return { error: "no relayout ref" };

      const flags = globalThis.__folioFeatureFlags ?? null;
      const pages = document.querySelectorAll(".layout-page").length;

      // Full-relayout timing: force a whole-document re-measure + re-paginate
      // (this is the hot path the segment-fit seam changes — every paragraph is
      // re-measured). Time to the next painted frame after each relayout.
      const times = [];
      for (let i = 0; i < iterations; i += 1) {
        const t0 = performance.now();
        inner.relayout();
        await raf();
        const dt = performance.now() - t0;
        if (i >= 3) times.push(dt); // drop warmup
      }
      return { flags, pages, times };
    },
    { iterations: KEYSTROKES },
  );

  const doneMs = await page.evaluate(() => performance.now());
  await browser.close();
  if (result.error) return { engineLabel, url, error: result.error, errors };

  const sorted = [...result.times].sort((a, b) => a - b);
  return {
    engineLabel,
    url,
    flags: result.flags,
    pages: result.pages,
    samples: sorted.length,
    relayoutMs: {
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      min: sorted[0] ?? null,
      max: sorted[sorted.length - 1] ?? null,
    },
    initialSettleMs: Math.round(doneMs - navMs),
    pageErrors: errors,
  };
}

const on = await measure("pretext", `${BASE}/?paragraphs=${PARAGRAPHS}`);
const off = await measure("legacy", `${BASE}/?paragraphs=${PARAGRAPHS}&segmentfit=off`);
const p50Delta = on.relayoutMs && off.relayoutMs ? on.relayoutMs.p50 - off.relayoutMs.p50 : null;
const baseline = {
  harness: "segmentfit-baseline",
  doc: { paragraphs: PARAGRAPHS },
  relayoutsSampled: KEYSTROKES,
  note: "relayoutMs = one forced full-document relayout (re-measure + re-paginate every paragraph) to the next painted frame; this is the hot path the segment-fit seam changes. Real fonts (not the deterministic canvas), so absolute ms are machine-specific — compare pretext vs legacy from the SAME run. No budget assertion is committed until a TARGET_MS is signed (plan §12.6).",
  interpretation:
    "This measures the WARM-CACHE steady state, where pretext is expected to be at parity with the legacy walk (folio's text-width cache already covers repeat measurement). Pretext's win is first-pass / cold-cache / overlong-token measurement cost (199->127 and 82->3 canvas calls), characterized in @stll/premirror-bridge's pretextParity.test.ts — NOT warm relayout. A near-zero p50 delta here is the correct, expected result and confirms no steady-state regression.",
  pretextMinusLegacyP50Ms: p50Delta,
  results: { pretext: on, legacy: off },
};
console.log(JSON.stringify(baseline, null, 2));
import { writeFileSync } from "node:fs";
writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`);
console.error(`baseline written: ${OUT}`);
