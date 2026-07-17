// Headless dogfood of the redline3 3-column page with the ~200-page samples.
// Measures the in-browser compare time + confirms pretext renders the result.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? "/Users/arthrod/.claude/jobs/2658d635/tmp";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${BASE}/redline3.html`, { waitUntil: "domcontentloaded", timeout: 45000 });
const flags = await page.evaluate(() => globalThis.__folioFeatureFlags ?? null);

// Kick off the ~200-page sample compare and time it.
await page.waitForSelector('[data-testid="load-samples"]', { timeout: 30000 });
const t0 = Date.now();
await page.click('[data-testid="load-samples"]');

// Wait for the redline state to appear (revision count populated).
let revisions = null;
let engine = null;
try {
  await page.waitForSelector('[data-testid="revision-count"]', { timeout: 180000 });
  revisions = await page.textContent('[data-testid="revision-count"]');
  engine = await page.textContent('[data-testid="engine"]');
} catch (e) {
  errors.push(`compare wait failed: ${String(e)}`);
}
const compareMs = Date.now() - t0;

const compareDoneMs = compareMs;

// Wait for the editor to lay out pages, timing first-paint of the redline.
let pages = 0;
try {
  await page.waitForSelector(".layout-page", { timeout: 90000 });
  pages = await page.$$eval(".layout-page", (els) => els.length);
} catch (e) {
  errors.push(`render wait failed: ${String(e)}`);
}
const firstRenderMs = Date.now() - t0;
const status = await page.textContent('[data-testid="status"]').catch(() => null);

try {
  await page.screenshot({ path: `${OUT}/redline3-samples.png`, timeout: 15000 });
} catch (e) {
  errors.push(`screenshot skipped: ${String(e)}`);
}
await browser.close();
console.log(
  JSON.stringify(
    { flags, engine, revisions, pages, compareDoneMs, firstRenderMs, status, errors },
    null,
    2,
  ),
);
