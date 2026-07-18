import { describe, expect, test } from "bun:test";

import type { Comment } from "../../types/content";
import type { HeaderFooter } from "../../types/document";
import { serializeComments } from "./commentSerializer";
import { serializeHeaderFooter } from "./headerFooterSerializer";
import { serializeEndnotes, serializeFootnotes } from "./noteSerializer";

const W16DU_NS = 'xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"';
const W16DU_IGNORABLE = "w16du";

const dateUtcInfo = { id: 1, author: "Reviewer", date: "2026-01-01T00:00:00Z", dateUtc: "2026-01-01T00:00:00Z" };

describe("w16du namespace declaration on part roots", () => {
  test("header root declares xmlns:w16du and keeps w16du:dateUtc on a tracked insertion", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [
        {
          type: "paragraph",
          formatting: {},
          content: [
            {
              type: "insertion",
              info: dateUtcInfo,
              content: [
                {
                  type: "run",
                  formatting: {},
                  content: [{ type: "text", text: "tracked" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const xml = serializeHeaderFooter(hf);
    expect(xml).toContain(W16DU_NS);
    expect(xml).toContain("w16du:dateUtc");
    expect(xml).toContain(W16DU_IGNORABLE);
  });

  test("comments root declares xmlns:w16du", () => {
    const comment: Comment = {
      id: 1,
      author: "Reviewer",
      date: "2026-01-01T00:00:00Z",
      content: [
        {
          type: "paragraph",
          formatting: {},
          content: [
            { type: "run", formatting: {}, content: [{ type: "text", text: "body" }] },
          ],
        },
      ],
    };
    const xml = serializeComments([comment]);
    expect(xml).toContain(W16DU_NS);
    expect(xml).toContain(W16DU_IGNORABLE);
  });

  test("footnotes root declares xmlns:w16du and keeps w16du:dateUtc on a tracked insertion", () => {
    const xml = serializeFootnotes([
      {
        id: 0,
        noteType: "normal",
        content: [
          {
            type: "paragraph",
            formatting: {},
            content: [
              {
                type: "insertion",
                info: dateUtcInfo,
                content: [
                  {
                    type: "run",
                    formatting: {},
                    content: [{ type: "text", text: "fn tracked" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(xml).toContain(W16DU_NS);
    expect(xml).toContain("w16du:dateUtc");
    expect(xml).toContain(W16DU_IGNORABLE);
  });

  test("endnotes root declares xmlns:w16du", () => {
    const xml = serializeEndnotes([]);
    expect(xml).toContain(W16DU_NS);
    expect(xml).toContain(W16DU_IGNORABLE);
  });
});
