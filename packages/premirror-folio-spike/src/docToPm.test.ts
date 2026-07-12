import { describe, expect, it } from "bun:test";

import type { Document } from "@stll/folio-core";

import { docToPmDoc } from "./docToPm";
import { spikeSchema } from "./schema";

function minimalDocument(): Document {
  return {
    package: {
      document: {
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "run",
                formatting: { bold: true },
                content: [{ type: "text", text: "Bold intro. " }],
              },
              {
                type: "run",
                content: [{ type: "text", text: "Plain tail." }],
              },
            ],
          },
          {
            type: "table",
          },
          {
            type: "paragraph",
            content: [
              {
                type: "run",
                formatting: { italic: true },
                content: [{ type: "text", text: "Second paragraph." }],
              },
            ],
          },
        ],
      },
    },
  } as unknown as Document;
}

describe("docToPmDoc", () => {
  it("maps paragraphs and bold/italic runs, skipping non-paragraph blocks", () => {
    const { doc, skippedBlocks } = docToPmDoc(minimalDocument(), spikeSchema);

    expect(doc.childCount).toBe(2);
    expect(skippedBlocks).toEqual(["table"]);

    const p1 = doc.child(0);
    expect(p1.type.name).toBe("paragraph");
    expect(p1.textContent).toBe("Bold intro. Plain tail.");
    const firstText = p1.firstChild!;
    expect(firstText.marks.some((m) => m.type.name === "strong")).toBe(true);

    const p2 = doc.child(1);
    expect(p2.textContent).toBe("Second paragraph.");
    expect(p2.firstChild!.marks.some((m) => m.type.name === "em")).toBe(true);
  });

  it("renders an empty document as a single empty paragraph", () => {
    const empty = {
      package: { document: { content: [] } },
    } as unknown as Document;
    const { doc } = docToPmDoc(empty, spikeSchema);
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("paragraph");
  });
});

describe("hyperlink and tab/break content (PR #3 review)", () => {
  it("keeps hyperlink child-run text and maps tab/break content", () => {
    const document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                { type: "run", content: [{ type: "text", text: "See " }] },
                {
                  type: "hyperlink",
                  href: "https://example.com",
                  children: [{ type: "run", content: [{ type: "text", text: "the docs" }] }],
                },
                {
                  type: "run",
                  content: [
                    { type: "tab" },
                    { type: "text", text: "after" },
                    { type: "break", breakType: "textWrapping" },
                    { type: "text", text: "wrap" },
                  ],
                },
              ],
            },
          ],
        },
      },
    } as unknown as Document;
    const { doc } = docToPmDoc(document, spikeSchema);
    expect(doc.child(0).textContent).toBe("See the docs\tafter wrap");
  });
});
