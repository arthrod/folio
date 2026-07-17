import { describe, expect, test } from "bun:test";

import type { Hyperlink, RelationshipMap } from "../types/document";
import { resolveHyperlinkUrl } from "./hyperlinkParser";
import { parseParagraph } from "./paragraphParser";
import { parseXmlDocument, type XmlElement } from "./xmlParser";

describe("hyperlink parsing", () => {
  test("sanitizes relationship targets when resolving deferred hyperlinks", () => {
    const executableUrl = ["java", "script:alert(1)"].join("");
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      rId: "rId1",
      children: [],
    };
    const rels: RelationshipMap = new Map([
      [
        "rId1",
        {
          id: "rId1",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
          target: executableUrl,
          targetMode: "External",
        },
      ],
    ]);

    expect(resolveHyperlinkUrl(hyperlink, rels)).toBeUndefined();
    expect(hyperlink.href).toBeUndefined();
  });

  test("keeps safe relationship targets when resolving deferred hyperlinks", () => {
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      rId: "rId1",
      children: [],
    };
    const rels: RelationshipMap = new Map([
      [
        "rId1",
        {
          id: "rId1",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
          target: "https://example.com/matter",
          targetMode: "External",
        },
      ],
    ]);

    expect(resolveHyperlinkUrl(hyperlink, rels)).toBe("https://example.com/matter");
    expect(hyperlink.href).toBe("https://example.com/matter");
  });

  // Regression: a hyperlink whose display text is a tracked deletion
  // (`<w:hyperlink><w:del><w:r><w:delText>…`) hit the parser's `default: break`
  // and the linked text was silently dropped from the model — so the whole
  // deletion vanished on any reparse/save (observed: a deleted "Open source"
  // link inside a table cell disappearing from a redline's original view).
  test("retains a deletion tracked-changed inside a hyperlink", () => {
    const root = parseXmlDocument(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <w:hyperlink r:id="rId1">
          <w:del w:id="7" w:author="Reviewer" w:date="2026-02-22T10:00:00Z">
            <w:r><w:delText xml:space="preserve">Open source</w:delText></w:r>
          </w:del>
        </w:hyperlink>
      </w:p>
    `) as XmlElement | null;
    if (!root) {
      throw new Error("Failed to parse hyperlink fixture");
    }

    const paragraph = parseParagraph(root, null, null, null, null, null);
    const hyperlink = paragraph.content.find((c) => c.type === "hyperlink");
    expect(hyperlink?.type).toBe("hyperlink");
    if (hyperlink?.type !== "hyperlink") {
      return;
    }

    const deletion = hyperlink.children.find((c) => c.type === "deletion");
    expect(deletion?.type).toBe("deletion");
    if (deletion?.type !== "deletion") {
      return;
    }
    expect(deletion.info.author).toBe("Reviewer");
    expect(deletion.info.id).toBe(7);

    const run = deletion.content[0];
    expect(run?.type).toBe("run");
    if (run?.type !== "run") {
      return;
    }
    const text = run.content.map((rc) => (rc.type === "text" ? rc.text : "")).join("");
    expect(text).toBe("Open source");
  });
});
