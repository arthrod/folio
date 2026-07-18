// Statistical benchmark for the redline3 family, driven by dissertation-derived
// fixtures instead of the single small Services pair.
//
// Method:
//   - Fixtures: N aligned slice pairs cut from the dissertation documents at
//     matched-paragraph decile boundaries (~1.1k paragraphs / ~6.5 MB each),
//     generated offline; the native pages additionally get a per-slice redline
//     precomputed by the native jubarte CLI (matching their by-design
//     server-side-precompute behavior).
//   - Delivery: Playwright route interception rewrites the `example-0` preset
//     fetches (pair1-{a,b,redline}.docx) to the slice files, so every page in
//     the matrix — including the Vue tier, which has no upload inputs — runs
//     the same fixture through its normal preset path.
//   - Sampling: REPS full sweeps over (page × fixture), one fresh browser
//     context per run (fresh renderer, cold caches), sequential to avoid
//     cross-run CPU/memory contamination. Heap is sampled twice at each
//     checkpoint: raw, then after a forced GC (HeapProfiler.collectGarbage)
//     so retained memory is separable from allocation noise.
//   - Output: one JSONL row per run (survives interruption) plus aggregated
//     mean/sd/min/median/max per page and per page×fixture.
//
// Usage:
//   node bench-redline3-stats.mjs
//   SLICES_DIR=... REPS=3 BASE_URL=... OUT_DIR=... node bench-redline3-stats.mjs
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "https://folio-redline.cicero-im.workers.dev";
const PAGES = (
  process.env.PAGES ??
  "/redline3,/redline3-view,/redline3-ts,/redline3-native,/redline3-vue,/redline3-vue-ts,/redline3-vue-native"
).split(",");
const SLICES_DIR = path.resolve(process.env.SLICES_DIR ?? "bench-fixtures/dissertacao-slices");
const FIXTURES = (process.env.FIXTURES ?? "slice0,slice1,slice2,slice3,slice4,slice5,slice6,slice7,slice8,slice9").split(",");
const REPS = Number(process.env.REPS ?? 3);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 300000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 2500);
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? "bench-results");

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runsPath = path.join(OUT_DIR, `redline3-stats-${stamp}.jsonl`);
const summaryPath = path.join(OUT_DIR, `redline3-stats-${stamp}.summary.json`);

const MB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

const getMetrics = async (cdp) =>
  Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

const runOnce = async (browser, pagePath, fixture, rep) => {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await context.newPage();
  const row = { pagePath, fixture, rep, startedAt: new Date().toISOString() };
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 200)));
  page.on("crash", () => pageErrors.push("PAGE CRASHED"));
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");

    await page.route("**/redline3/pair1-a.docx", (r) => r.fulfill({ path: path.join(SLICES_DIR, `${fixture}-a.docx`) }));
    await page.route("**/redline3/pair1-b.docx", (r) => r.fulfill({ path: path.join(SLICES_DIR, `${fixture}-b.docx`) }));
    await page.route("**/redline3/pair1-redline.docx", (r) =>
      r.fulfill({ path: path.join(SLICES_DIR, `${fixture}-redline.docx`) }),
    );

    const t0 = Date.now();
    await page.goto(`${BASE}${pagePath}`, { waitUntil: "load", timeout: 120000 });
    row.loadWallMs = Date.now() - t0;
    const nav = await page.evaluate(() => {
      const fcp = performance.getEntriesByName("first-contentful-paint").at(0)?.startTime ?? null;
      const entry = performance.getEntriesByType("navigation").at(0);
      return {
        fcpMs: fcp === null ? null : Math.round(fcp),
        domContentLoadedMs: entry ? Math.round(entry.domContentLoadedEventEnd) : null,
        loadEventMs: entry ? Math.round(entry.loadEventEnd) : null,
        transferKB: entry ? Math.round(entry.transferSize / 1024) : null,
      };
    });
    Object.assign(row, nav);

    const atLoad = await getMetrics(cdp);
    row.heapAtLoadMB = MB(atLoad.JSHeapUsedSize ?? 0);
    await cdp.send("HeapProfiler.collectGarbage");
    row.heapAtLoadGcMB = MB((await getMetrics(cdp)).JSHeapUsedSize ?? 0);

    await page.click('[data-testid="example-0"]', { timeout: 30000 });
    const t1 = Date.now();
    const deadline = t1 + RUN_TIMEOUT_MS;
    // The TS engine can die without reaching either terminal element (silent
    // abort mid-compare); the wait then throws early while the page stays
    // alive and idle. Poll in short windows; when the page is RESPONSIVE
    // (status reads succeed) but the status footer stays unchanged for
    // HUNG_AFTER_MS, declare the run hung. While the main thread is blocked
    // (status reads time out — a live sync compare), only the overall
    // deadline applies.
    const HUNG_AFTER_MS = 90000;
    let lastStatus = null;
    let lastStatusChange = null;
    let terminal = null;
    while (Date.now() < deadline && !terminal) {
      try {
        await page.waitForFunction(
          () => {
            const count = document.querySelector('[data-testid="revision-count"]');
            if (count && /^\d+$/.test(count.textContent.trim())) return true;
            return document.querySelector('[data-testid="engine-failure"]') !== null;
          },
          undefined,
          // Options are the THIRD parameter of waitForFunction; passing them
          // second makes Playwright treat them as `arg` and silently keep the
          // default 30 s timeout.
          { timeout: Math.max(1000, Math.min(15000, deadline - Date.now())) },
        );
        terminal = "reached";
      } catch (error) {
        if (page.isClosed()) {
          terminal = "closed";
          break;
        }
        if (!String(error).includes("Timeout")) {
          row.waitError = row.waitError ?? String(error).split("\n")[0].slice(0, 200);
        }
        const status = await page
          .textContent('[data-testid="status"]', { timeout: 5000 })
          .catch(() => null);
        if (status === null) {
          continue; // main thread blocked: engine still crunching
        }
        if (status !== lastStatus) {
          lastStatus = status;
          lastStatusChange = Date.now();
        } else if (lastStatusChange !== null && Date.now() - lastStatusChange > HUNG_AFTER_MS) {
          terminal = "hung";
        }
      }
    }
    row.redlineWallMs = Date.now() - t1;
    const failureEl = page.isClosed() ? null : await page.$('[data-testid="engine-failure"]');
    const countText = page.isClosed()
      ? null
      : await page.textContent('[data-testid="revision-count"]', { timeout: 2000 }).catch(() => null);
    if (failureEl) {
      row.outcome = "failure-banner";
      row.failure = (await page.textContent('[data-testid="engine-failure"]'))?.slice(0, 300) ?? null;
    } else if (countText && /^\d+$/.test(countText.trim())) {
      row.outcome = "ok";
      row.revisions = Number(countText.trim());
    } else {
      row.outcome = terminal === "hung" ? "hung" : terminal === "closed" ? "crashed" : "timeout";
      row.statusAtEnd = lastStatus?.slice(0, 200) ?? null;
    }

    // Post-terminal metrics go through the renderer; if the run timed out
    // with the main thread still blocked they would hang the whole bench, so
    // race the section against a guard.
    const postMetrics = (async () => {
      // Engine-reported compare time: React pages expose it via the debug
      // hook; both tiers also print "… in X.X s" in the status footer.
      row.engineMs = await page.evaluate(() => {
        const state = globalThis.__redline3?.getState?.();
        if (state && typeof state.elapsedMs === "number") return Math.round(state.elapsedMs);
        const status = document.querySelector('[data-testid="status"]')?.textContent ?? "";
        const match = status.match(/in (\d+(?:\.\d+)?) s/);
        return match ? Math.round(Number(match[1]) * 1000) : null;
      });

      await page.waitForTimeout(SETTLE_MS);
      const after = await getMetrics(cdp);
      row.heapAfterMB = MB(after.JSHeapUsedSize ?? 0);
      row.heapTotalAfterMB = MB(after.JSHeapTotalSize ?? 0);
      row.domNodes = after.Nodes ?? null;
      row.layoutMs = Math.round((after.LayoutDuration ?? 0) * 1000);
      row.styleMs = Math.round((after.RecalcStyleDuration ?? 0) * 1000);
      row.scriptMs = Math.round((after.ScriptDuration ?? 0) * 1000);
      await cdp.send("HeapProfiler.collectGarbage");
      row.heapAfterGcMB = MB((await getMetrics(cdp)).JSHeapUsedSize ?? 0);
      return "done";
    })();
    let guardTimer;
    const guard = new Promise((resolve) => {
      guardTimer = setTimeout(() => resolve("blocked"), SETTLE_MS + 30000);
    });
    const raced = await Promise.race([
      postMetrics.catch((error) => {
        row.postMetricsError = String(error).slice(0, 200);
        return "failed";
      }),
      guard,
    ]);
    clearTimeout(guardTimer);
    if (raced === "blocked") {
      row.postMetrics = "skipped-renderer-blocked";
      postMetrics.catch(() => {});
    }
  } catch (error) {
    row.outcome = row.outcome ?? "error";
    row.error = String(error).slice(0, 300);
  } finally {
    if (pageErrors.length > 0) row.pageErrors = pageErrors.slice(0, 3);
    await context.close().catch(() => {});
  }
  return row;
};

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const stats = (values) => {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const sd = nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)) : 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const round = (v) => Math.round(v * 10) / 10;
  return {
    n: nums.length,
    mean: round(mean),
    sd: round(sd),
    min: round(sorted[0]),
    median: round(quantile(sorted, 0.5)),
    max: round(sorted[sorted.length - 1]),
  };
};

const METRIC_KEYS = [
  "loadWallMs",
  "fcpMs",
  "redlineWallMs",
  "engineMs",
  "heapAtLoadMB",
  "heapAtLoadGcMB",
  "heapAfterMB",
  "heapAfterGcMB",
  "heapTotalAfterMB",
  "domNodes",
  "layoutMs",
  "styleMs",
  "scriptMs",
  "revisions",
] ;

const aggregate = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const [key, group] of groups) {
    const outcomes = {};
    for (const row of group) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    out[key] = { runs: group.length, outcomes };
    for (const metric of METRIC_KEYS) {
      const s = stats(group.map((row) => row[metric]));
      if (s) out[key][metric] = s;
    }
  }
  return out;
};

// --- main -------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(path.join(SLICES_DIR, "manifest.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
const rows = [];
const total = REPS * PAGES.length * FIXTURES.length;
let done = 0;

for (let rep = 0; rep < REPS; rep++) {
  for (const pagePath of PAGES) {
    for (const fixture of FIXTURES) {
      const row = await runOnce(browser, pagePath, fixture, rep);
      rows.push(row);
      appendFileSync(runsPath, `${JSON.stringify(row)}\n`);
      done += 1;
      console.error(
        `[${done}/${total}] rep${rep} ${pagePath} ${fixture}: ${row.outcome ?? "?"} ` +
          `redline=${row.redlineWallMs ?? "-"}ms engine=${row.engineMs ?? "-"}ms heapAfter=${row.heapAfterMB ?? "-"}MB`,
      );
    }
  }
}
await browser.close();

const summary = {
  base: BASE,
  reps: REPS,
  fixtures: manifest,
  runsFile: runsPath,
  perPage: aggregate(rows, (row) => row.pagePath),
  perPageFixture: aggregate(rows, (row) => `${row.pagePath} ${row.fixture}`),
};
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.perPage, null, 2));
console.error(`\nruns:    ${runsPath}\nsummary: ${summaryPath}`);
