// Matrix dogfood for the redline3 family: every page loads example-0 and is
// judged against ITS OWN expected outcome:
//   - wasm pages: live jubarte-wasm redline, verified.
//   - ts pages: the HONEST failure banner (jubarte-first lossless currently
//     fails folio's reject-side self-check on table docs — known defect).
//   - native pages: precomputed jubarte-native redline.
// The react wasm page additionally exercises the monolith view (aggregation
// must reduce revision-element count and keep revisions enumerable).
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const OUT = process.env.OUT ?? "/Users/arthrod/.claude/jobs/2658d635/tmp";

const PAGES = [
  { path: "/redline3", kind: "react", expect: "wasm" },
  { path: "/redline3-view", kind: "react", expect: "wasm" },
  { path: "/redline3-ts", kind: "react", expect: "ts-failure" },
  { path: "/redline3-ts-view", kind: "react", expect: "ts-failure" },
  { path: "/redline3-native", kind: "react", expect: "native" },
  { path: "/redline3-native-view", kind: "react", expect: "native" },
  { path: "/redline3-vue", kind: "vue", expect: "wasm" },
  { path: "/redline3-vue-ts", kind: "vue", expect: "ts-failure" },
  { path: "/redline3-vue-native", kind: "vue", expect: "native" },
];

const browser = await chromium.launch({ headless: true });
const results = [];

for (const page_def of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const row = { path: page_def.path, expect: page_def.expect, ok: false, detail: "" };
  try {
    await page.goto(`${BASE}${page_def.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.click('[data-testid="example-0"]', { timeout: 30000 });

    if (page_def.expect === "ts-failure") {
      await page.waitForSelector('[data-testid="engine-failure"]', { timeout: 240000 });
      const text = await page.textContent('[data-testid="engine-failure"]');
      row.ok = text.includes("jubarte-first-lossless") && text.includes("self-check");
      row.detail = text.trim().slice(0, 160);
    } else {
      // The Vue pages render "…" while revision enumeration is in flight;
      // wait for the count to be numeric, not merely present.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="revision-count"]');
          return el !== null && /^\d+$/.test(el.textContent.trim());
        },
        { timeout: 240000 },
      );
      const revisions = Number((await page.textContent('[data-testid="revision-count"]')).trim());
      const engine = (await page.textContent('[data-testid="engine"]')).trim();
      const rendered =
        page_def.kind === "vue"
          ? await page.waitForFunction(
              () => document.querySelectorAll("iframe.r3-htmlframe").length >= 3,
              { timeout: 120000 },
            ).then(() => true)
          : await page.waitForFunction(
              () => document.querySelectorAll(".r3-result .layout-page").length >= 1,
              { timeout: 120000 },
            ).then(() => true);
      const engineOk =
        page_def.expect === "wasm" ? engine === "jubarte-wasm" : engine.includes("jubarte-native");
      row.ok = revisions > 0 && rendered && engineOk;
      row.detail = `engine=${engine} revisions=${revisions}`;

      // Monolith experiment on the main react wasm page.
      if (page_def.path === "/redline3") {
        await page.click('[data-testid="view-monolith"]');
        await page.waitForFunction(
          () => globalThis.__redline3?.getState()?.monolith != null,
          { timeout: 120000 },
        );
        const monolith = await page.evaluate(() => globalThis.__redline3.getState().monolith);
        const monolithOk =
          monolith.elementsAfter < monolith.elementsBefore && monolith.revisions > 0;
        row.detail += ` | monolith ${monolith.elementsBefore}→${monolith.elementsAfter} elements, ${monolith.revisions} revisions`;
        row.ok = row.ok && monolithOk;
        // Extract the aggregated buffer so folio's judge can verify the
        // transform preserved both resolved views (run separately below).
        const base64 = await page.evaluate(() => globalThis.__redline3.getMonolithBase64());
        if (base64) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(`${OUT}/pair1-monolith.docx`, Buffer.from(base64, "base64"));
          row.detail += " | monolith buffer saved";
        }
        await page.screenshot({ path: `${OUT}/r3m-monolith.png` });
      }
    }
    if (errors.length > 0) {
      row.detail += ` | pageerrors: ${errors.slice(0, 2).join(" ; ").slice(0, 120)}`;
    }
    await page.screenshot({ path: `${OUT}/r3m${page_def.path.replaceAll("/", "-")}.png` });
  } catch (error) {
    row.detail = String(error).slice(0, 200);
  }
  results.push(row);
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
if (!results.every((r) => r.ok)) {
  process.exit(1);
}
