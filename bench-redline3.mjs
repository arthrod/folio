// Performance snapshot for the redline3 family: per page, capture
//   load    — navigation timings (DOMContentLoaded, load event) + FCP/LCP
//   render  — layout/style/script durations from the CDP Performance domain,
//             plus the app-level redline wall time where a live engine runs
//   memory  — JS heap (used/total) after load and again after the redline
// Tools: Playwright + Chrome DevTools Protocol Performance.getMetrics.
// (Run Lighthouse separately for scored vitals: bun x lighthouse <url>.)
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "https://folio-redline.cicero-im.workers.dev";
const PAGES = (process.env.PAGES ?? "/redline3,/redline3-view,/redline3-ts,/redline3-native,/redline3-vue,/redline3-vue-ts,/redline3-vue-native").split(",");

const MB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

const browser = await chromium.launch({ headless: true });
const rows = [];

for (const path of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const t0 = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 120000 });
  const loadMs = Date.now() - t0;

  const paints = await page.evaluate(() => {
    const fcp = performance.getEntriesByName("first-contentful-paint").at(0)?.startTime ?? null;
    const nav = performance.getEntriesByType("navigation").at(0);
    return {
      fcp,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
      loadEvent: nav?.loadEventEnd ?? null,
      transferKB: nav ? Math.round(nav.transferSize / 1024) : null,
    };
  });
  const metricsAfterLoad = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
  );

  // Drive the example pair and wait for this page's terminal state.
  let redlineMs = null;
  let terminal = "-";
  await page.click('[data-testid="example-0"]', { timeout: 30000 });
  const tRun = Date.now();
  try {
    await page.waitForFunction(
      () => {
        const count = document.querySelector('[data-testid="revision-count"]');
        if (count && /^\d+$/.test(count.textContent.trim())) return true;
        return document.querySelector('[data-testid="engine-failure"]') !== null;
      },
      { timeout: 240000 },
    );
    redlineMs = Date.now() - tRun;
    terminal = (await page.$('[data-testid="engine-failure"]'))
      ? "failure-banner"
      : `${(await page.textContent('[data-testid="revision-count"]')).trim()} revs`;
    // Let rendering settle before the post-redline snapshot.
    await page.waitForTimeout(3000);
  } catch {
    terminal = "timeout";
  }
  const metricsAfterRun = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
  );

  rows.push({
    path,
    load: {
      wallMs: loadMs,
      domContentLoadedMs: Math.round(paints.domContentLoaded ?? -1),
      loadEventMs: Math.round(paints.loadEvent ?? -1),
      fcpMs: paints.fcp === null ? null : Math.round(paints.fcp),
      transferKB: paints.transferKB,
    },
    render: {
      redlineWallMs: redlineMs,
      terminal,
      layoutMs: Math.round((metricsAfterRun.LayoutDuration ?? 0) * 1000),
      styleMs: Math.round((metricsAfterRun.RecalcStyleDuration ?? 0) * 1000),
      scriptMs: Math.round((metricsAfterRun.ScriptDuration ?? 0) * 1000),
    },
    memoryMB: {
      heapUsedAfterLoad: MB(metricsAfterLoad.JSHeapUsedSize ?? 0),
      heapUsedAfterRedline: MB(metricsAfterRun.JSHeapUsedSize ?? 0),
      heapTotalAfterRedline: MB(metricsAfterRun.JSHeapTotalSize ?? 0),
      domNodes: metricsAfterRun.Nodes ?? null,
    },
  });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(rows, null, 2));
