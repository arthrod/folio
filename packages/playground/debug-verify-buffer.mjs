// Probe 3: put an ALREADY-PRODUCED redline docx through the exact judgment the
// orchestrator's self-check applies (FolioDocxReviewer views vs base/revised).
import { readFile } from "node:fs/promises";

import { FolioDocxReviewer } from "@stll/folio-core/server";

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const storyMainText = async (buffer, view) => {
  const reviewer = await FolioDocxReviewer.fromBuffer(buffer);
  for (const { handle } of reviewer.listStories()) {
    if (handle.type !== "main") continue;
    const story = reviewer.readReviewedStory({ story: handle, view });
    return story ? story.snapshot.blocks.map(({ text }) => text).join("\n") : "";
  }
  return "";
};

const firstDiff = (x, y) => {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
  return x.length === y.length ? -1 : n;
};

const report = (label, expected, actual) => {
  const i = firstDiff(expected, actual);
  if (i === -1) {
    console.log(`${label}: MATCH (${expected.length} chars)`);
    return;
  }
  const ctx = 120;
  console.log(
    `${label}: DIVERGES at char ${i} (expected ${expected.length} chars, actual ${actual.length})`,
  );
  console.log(`  expected …${JSON.stringify(expected.slice(Math.max(0, i - ctx), i + ctx))}…`);
  console.log(`  actual   …${JSON.stringify(actual.slice(Math.max(0, i - ctx), i + ctx))}…`);
};

const [aPath, bPath, redlinePath] = process.argv.slice(2);
const [a, b, r] = await Promise.all([readFile(aPath), readFile(bPath), readFile(redlinePath)]);

const revisedText = await storyMainText(toArrayBuffer(b), "final");
const baseText = await storyMainText(toArrayBuffer(a), "final");
const acceptedText = await storyMainText(toArrayBuffer(r), "final");
const rejectedText = await storyMainText(toArrayBuffer(r), "original");

report("accept-all vs revised", revisedText, acceptedText);
report("reject-all vs base   ", baseText, rejectedText);
