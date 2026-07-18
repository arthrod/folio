import { describe, expect, test } from "bun:test";

import type { Paragraph, SimpleField } from "../../types/document";
import { serializeParagraph } from "./paragraphSerializer";

/**
 * Field-level deletion path (`wrapFieldTrackedChange`) must be drawing-aware:
 * the blanket `<w:t>` → `<w:delText>` regex rewrites ALL `<w:t>` in the
 * serialized field, including `<w:t>` nested inside a `<w:drawing>` /
 * `<w:pict>` → `<w:txbxContent>` subtree. That textbox text belongs to a
 * nested document and must stay `<w:t>`; only the field's own result text
 * should become `<w:delText>`.
 */
describe("field-level deletion — textbox integrity", () => {
  test("deleted field keeps txbxContent <w:t> while rewriting result text", () => {
    const field: SimpleField = {
      type: "simpleField",
      instruction: "PAGE \\* MERGEFORMAT",
      fieldType: "PAGE",
      content: [
        {
          type: "run",
          content: [{ type: "text", text: "1" }],
        },
        {
          type: "run",
          content: [
            {
              type: "shape",
              shape: {
                type: "shape",
                shapeType: "textBox",
                size: { width: 914_400, height: 457_200 },
                textBody: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "run",
                          content: [{ type: "text", text: "box label" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
      trackedChange: {
        kind: "deletion",
        info: { id: 5, author: "Reviewer", date: "2026-07-10T00:00:00Z" },
      },
    };

    const paragraph: Paragraph = { type: "paragraph", content: [field] };
    const xml = serializeParagraph(paragraph);

    // The field's own result text ("1") must be rewritten to delText.
    expect(xml).toContain("<w:delText");
    expect(xml).toContain("1</w:delText>");

    // The textbox's text ("box label") must stay as <w:t>.
    expect(xml).toContain("<wps:txbx><w:txbxContent>");
    expect(xml).toContain("box label</w:t>");
    expect(xml).not.toContain("box label</w:delText>");
  });
});
