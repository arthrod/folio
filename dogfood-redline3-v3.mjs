// Dogfood of redline3 v3 (jubarte × folio, arthur-astro design, NO fallback):
//  1. example pair  → WAITS for the live jubarte-wasm redline (engine must be jubarte-wasm)
//  2. giant pair    → WAITS for the live jubarte-wasm redline on ~200pp
//  3. dissertation  → WAITS for the precomputed native redline + wasm revision enumeration
// Any engine-failure banner or non-jubarte engine label is a hard failure.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? "/Users/arthrod/.claude/jobs/2658d635/tmp";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const failBanner = async () => {
  const banner = await page.$('[data-testid="engine-failure"]');
  return banner ? await banner.textContent() : null;
};

const waitForRedline = async (label, timeout) => {
  const t0 = Date.now();
  await page.waitForSelector('[data-testid="revision-count"]', { timeout });
  const revisions = (await page.textContent('[data-testid="revision-count"]')).trim();
  const engine = (await page.textContent('[data-testid="engine"]')).trim();
  // The redline pane must actually render pages — wait for layout.
  await page.waitForFunction(
    () => document.querySelectorAll(".r3-result .layout-page").length >= 1,
    { timeout },
  );
  const resultPages = await page.$$eval(".r3-result .layout-page", (els) => els.length);
  const paneCounts = await page.$$eval(".r3-pane", (panes) =>
    panes.map((p) => p.querySelectorAll(".layout-page").length),
  );
  return {
    label,
    engine,
    revisions: Number(revisions),
    resultPages,
    aPages: paneCounts[0] ?? 0,
    bPages: paneCounts[1] ?? 0,
    ms: Date.now() - t0,
  };
};

const results = [];
await page.goto(`${BASE}/redline3`, { waitUntil: "domcontentloaded", timeout: 60000 });

// 1 — example pair, live wasm.
await page.click('[data-testid="example-0"]');
results.push(await waitForRedline("example-0 (Services)", 180000));
if (await failBanner()) throw new Error(`example-0 failure banner: ${await failBanner()}`);
await page.screenshot({ path: `${OUT}/r3v3-example.png` });

// 2 — giant pair, live wasm on ~200 pages. WAIT for it, however long.
await page.click('[data-testid="clear"]');
await page.click('[data-testid="giant-0"]');
results.push(await waitForRedline("giant-0 (~200pp Services)", 420000));
if (await failBanner()) throw new Error(`giant-0 failure banner: ${await failBanner()}`);
await page.screenshot({ path: `${OUT}/r3v3-giant.png` });

// 3 — dissertation: ~32 MB of docx + native-precomputed redline. WAIT.
await page.click('[data-testid="clear"]');
await page.click('[data-testid="dissertation"]');
results.push(await waitForRedline("dissertation (~1000pp)", 900000));
if (await failBanner()) throw new Error(`dissertation failure banner: ${await failBanner()}`);
await page.screenshot({ path: `${OUT}/r3v3-dissertation.png` });

const status = await page.textContent('[data-testid="status"]').catch(() => null);
await browser.close();

const verdicts = results.map((r) => ({
  ...r,
  ok:
    r.revisions > 0 &&
    r.resultPages >= 1 &&
    (r.label.startsWith("dissertation")
      ? r.engine.includes("jubarte-native")
      : r.engine === "jubarte-wasm"),
}));
console.log(JSON.stringify({ verdicts, status, errors: errors.slice(0, 12) }, null, 2));
if (!verdicts.every((v) => v.ok)) {
  process.exit(1);
}
