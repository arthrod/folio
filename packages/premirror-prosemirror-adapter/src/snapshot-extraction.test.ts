import { describe, expect, it } from "bun:test";

import type { BlockSnapshot } from "@stll/premirror-core";
import { defaultPremirrorOptions } from "@stll/premirror-core";
import { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

import { createPremirror } from "./index";

/**
 * Snapshot-extraction coverage for the adapter: list items, blockquotes,
 * headings, nesting, hard breaks, empty blocks, mark resolution, and the
 * no-op invalidation path — the block walkers the paragraph-only tests never
 * reach. No segment-fit engine is injected (E-4 unification): measurement
 * takes the deterministic fallback, which extraction does not depend on.
 */

const paragraphSpec = basicSchema.spec.nodes.get("paragraph");
if (!paragraphSpec) throw new Error("Missing paragraph spec");

const schema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes.update("paragraph", {
      ...paragraphSpec,
      attrs: { ...paragraphSpec.attrs, manualPageBreakBefore: { default: false } },
    }),
    "paragraph block*",
    "block",
  ),
  marks: basicSchema.spec.marks,
});

function node(name: string, attrs: Record<string, unknown> | null, content?: PMNode[] | PMNode) {
  return schema.node(name, attrs, content as PMNode[] | undefined);
}
function para(text: string) {
  return node("paragraph", null, [schema.text(text)]);
}
function extract(doc: PMNode): BlockSnapshot[] {
  const runtime = createPremirror(defaultPremirrorOptions());
  const state = EditorState.create({ schema, doc, plugins: runtime.plugins });
  return runtime.toSnapshot(state).blocks;
}
function docOf(...content: PMNode[]): PMNode {
  return node("doc", null, content);
}

describe("adapter list extraction", () => {
  it("marks bullet-list paragraphs with listItem/listDepth and orderedList=false", () => {
    const blocks = extract(
      docOf(node("bullet_list", null, [node("list_item", null, [para("first")])])),
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[0]?.attrs).toMatchObject({ listItem: true, listDepth: 1, orderedList: false });
  });

  it("marks ordered-list paragraphs with orderedList=true", () => {
    const blocks = extract(
      docOf(node("ordered_list", null, [node("list_item", null, [para("n1")])])),
    );
    expect(blocks[0]?.attrs).toMatchObject({ orderedList: true, listDepth: 1 });
  });

  it("increments listDepth for a nested list", () => {
    const blocks = extract(
      docOf(
        node("bullet_list", null, [
          node("list_item", null, [
            para("outer"),
            node("bullet_list", null, [node("list_item", null, [para("inner")])]),
          ]),
        ]),
      ),
    );
    const inner = blocks.find((b) => b.runs.some((r) => r.text === "inner"));
    expect(inner?.attrs.listDepth).toBe(2);
  });

  it("flattens a heading inside a list item", () => {
    // list_item content is `paragraph block*`, so a leading paragraph is
    // required before the heading block.
    const blocks = extract(
      docOf(
        node("bullet_list", null, [
          node("list_item", null, [
            para("lead"),
            node("heading", { level: 2 }, [schema.text("H")]),
          ]),
        ]),
      ),
    );
    const heading = blocks.find((b) => b.type === "heading");
    expect(heading).toBeDefined();
    expect(heading?.attrs).toMatchObject({ listItem: true });
  });
});

describe("adapter blockquote extraction", () => {
  it("tags blockquote paragraphs with type blockquote and inBlockquote", () => {
    const blocks = extract(docOf(node("blockquote", null, [para("quoted")])));
    expect(blocks[0]?.type).toBe("blockquote");
    expect(blocks[0]?.attrs).toMatchObject({ inBlockquote: true });
  });

  it("tags a heading inside a blockquote as a heading with inBlockquote", () => {
    const blocks = extract(
      docOf(node("blockquote", null, [node("heading", { level: 1 }, [schema.text("Title")])])),
    );
    expect(blocks[0]?.type).toBe("heading");
    expect(blocks[0]?.attrs).toMatchObject({ inBlockquote: true });
  });

  it("walks a nested blockquote", () => {
    const blocks = extract(
      docOf(node("blockquote", null, [node("blockquote", null, [para("deep")])])),
    );
    expect(blocks[0]?.runs.some((r) => r.text === "deep")).toBe(true);
    expect(blocks[0]?.attrs).toMatchObject({ inBlockquote: true });
  });

  it("walks a list nested inside a blockquote", () => {
    const blocks = extract(
      docOf(
        node("blockquote", null, [
          node("bullet_list", null, [node("list_item", null, [para("bq-item")])]),
        ]),
      ),
    );
    // The list is walked with inBlockquote context; the leaf paragraph carries
    // the list attrs (inBlockquote is only threaded into further nested lists).
    const item = blocks.find((b) => b.runs.some((r) => r.text === "bq-item"));
    expect(item?.attrs).toMatchObject({ listItem: true, listDepth: 1 });
  });

  it("flattens a blockquote nested inside a list item", () => {
    const blocks = extract(
      docOf(
        node("bullet_list", null, [
          node("list_item", null, [para("lead"), node("blockquote", null, [para("li-quote")])]),
        ]),
      ),
    );
    const quoted = blocks.find((b) => b.runs.some((r) => r.text === "li-quote"));
    expect(quoted?.type).toBe("blockquote");
    expect(quoted?.attrs).toMatchObject({ listFlattened: true });
  });
});

describe("adapter top-level and inline extraction", () => {
  it("extracts a top-level heading", () => {
    const blocks = extract(docOf(node("heading", { level: 3 }, [schema.text("Top")])));
    expect(blocks[0]?.type).toBe("heading");
  });

  it("skips unsupported top-level blocks (horizontal rule)", () => {
    const blocks = extract(docOf(para("kept"), node("horizontal_rule", null)));
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.runs[0]?.text).toBe("kept");
  });

  it("emits a newline run for a hard break", () => {
    const blocks = extract(
      docOf(
        node("paragraph", null, [schema.text("a"), node("hard_break", null), schema.text("b")]),
      ),
    );
    const texts = blocks[0]?.runs.map((r) => r.text) ?? [];
    expect(texts).toContain("\n");
    expect(texts).toContain("a");
    expect(texts).toContain("b");
  });

  it("emits a single empty run for an empty paragraph", () => {
    const blocks = extract(docOf(node("paragraph", null)));
    expect(blocks[0]?.runs.length).toBe(1);
    expect(blocks[0]?.runs[0]?.text).toBe("");
  });

  it("resolves em, code, and link marks into distinct runs", () => {
    const em = schema.marks.em;
    const code = schema.marks.code;
    const link = schema.marks.link;
    if (!em || !code || !link) throw new Error("Missing marks");
    const blocks = extract(
      docOf(
        node("paragraph", null, [
          schema.text("i", [em.create()]),
          schema.text("c", [code.create()]),
          schema.text("l", [link.create({ href: "https://example.com" })]),
        ]),
      ),
    );
    const runs = blocks[0]?.runs ?? [];
    expect(runs.some((r) => r.marks.em === true)).toBe(true);
    expect(runs.some((r) => r.marks.code === true)).toBe(true);
    expect(runs.some((r) => r.marks.linkHref === "https://example.com")).toBe(true);
  });
});

describe("adapter invalidation", () => {
  it("reports no invalidation range for a pristine state", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: docOf(para("unchanged")),
      plugins: runtime.plugins,
    });
    expect(runtime.getInvalidationRange(state)).toBeNull();
  });

  it("reports no invalidation range for a selection-only transaction", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    let state = EditorState.create({
      schema,
      doc: docOf(para("select me")),
      plugins: runtime.plugins,
    });
    // A selection change does not touch the doc, so no range is derived.
    state = state.apply(state.tr.setSelection(state.selection));
    expect(runtime.getInvalidationRange(state)).toBeNull();
  });
});
