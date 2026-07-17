// Headless dogfood of the DEPLOYED pretext redline editor (folio-redline.pages.dev).
// A/B: pretext ON (default) vs ?segmentfit=off. Verifies the flag, renders the
// built-in demo through the full folio editor, counts laid-out pages, captures
// console/page errors, and screenshots both. Run: bun run dogfood-pretext.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.DOGFOOD_URL ?? "https://folio-redline.pages.dev/redline.html";
const OUT = process.env.DOGFOOD_OUT ?? "/Users/arthrod/.claude/jobs/2658d635/tmp";

async function run(label, url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Flag state as wired by redline/main.tsx.
  const flags = await page.evaluate(() => globalThis.__folioFeatureFlags ?? null);

  // Load the built-in demo → compare (jubarte-wasm) → render in the folio editor.
  await page.waitForSelector('[data-testid="load-demo"]', { timeout: 30000 });
  await page.click('[data-testid="load-demo"]');

  // The editor lays out pages once the compared buffer is shown.
  let pages = 0;
  let engine = null;
  let revisions = null;
  try {
    await page.waitForSelector(".layout-page", { timeout: 45000 });
    pages = await page.$$eval(".layout-page", (els) => els.length);
    engine = await page.textContent('[data-testid="engine"]').catch(() => null);
    revisions = await page.textContent('[data-testid="revision-count"]').catch(() => null);
  } catch (e) {
    errors.push(`render wait failed: ${String(e)}`);
  }

  // Best-effort: did the pretext engine actually prepare any text? (cache grows
  // only when the seam ran). Exposed if the bundle kept the symbol; harmless if not.
  const shot = `${OUT}/dogfood-${label}.png`;
  await page.screenshot({ path: shot, fullPage: false });
  await browser.close();
  return { label, url, flags, pages, engine, revisions, errors };
}

const on = await run("pretext-on", BASE);
const off = await run("pretext-off", `${BASE}?segmentfit=off`);
console.log(JSON.stringify({ on, off }, null, 2));
