// Editing-loop proof: load an example, TYPE into column B's live editor,
// "Redline again", and require the new redline to include the typed text as a
// tracked insertion (revision count must change or the text must appear).
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "https://folio-redline.cicero-im.workers.dev";
const OUT = process.env.OUT ?? "/Users/arthrod/.claude/jobs/2658d635/tmp";
const SENTINEL = "QUOKKA-EDIT-7";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/redline3`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.click('[data-testid="example-0"]');
await page.waitForSelector('[data-testid="revision-count"]', { timeout: 180000 });
const before = Number((await page.textContent('[data-testid="revision-count"]')).trim());

// folio's keyboard input runs through a hidden off-screen ProseMirror; the
// visible surface is the layout page. Click a text position on column B's
// first page to place the caret, then type.
const bPane = page.locator(".r3-pane").nth(1);
await bPane
  .locator(".layout-page")
  .first()
  .click({ position: { x: 300, y: 300 }, timeout: 30000 });
await page.waitForTimeout(500);
await page.keyboard.type(` ${SENTINEL} `, { delay: 20 });
await page.waitForTimeout(500);

await page.click('[data-testid="rerun"]');
// Wait for a NEW result that contains the sentinel as inserted text.
await page.waitForFunction(
  (sentinel) => {
    const result = document.querySelector(".r3-result");
    return result && result.textContent.includes(sentinel);
  },
  SENTINEL,
  { timeout: 240000 },
);
const after = Number((await page.textContent('[data-testid="revision-count"]')).trim());
const engine = (await page.textContent('[data-testid="engine"]')).trim();
await page.screenshot({ path: `${OUT}/r3v3-edit-loop.png` });
await browser.close();

console.log(JSON.stringify({ before, after, engine, errors: errors.slice(0, 6) }, null, 2));
if (engine !== "jubarte-wasm" || after === before) {
  process.exit(1);
}
