import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import { acceptAllChanges, acceptChange, rejectAllChanges, rejectChange } from "./comments";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      attrs: { pPrMark: { default: null } },
    },
    text: { marks: "_" },
  },
  marks: {
    insertion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      excludes: "",
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      excludes: "",
      toDOM: () => ["del", 0],
    },
  },
});

const dispatcher = (state: EditorState) => {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
};

const insMark = (info: { id: number; author?: string }) => ({
  kind: "ins" as const,
  info: { id: info.id, author: info.author ?? "Alice" },
});

const delMark = (info: { id: number; author?: string }) => ({
  kind: "del" as const,
  info: { id: info.id, author: info.author ?? "Alice" },
});

// Table-bearing schema for the paragraph-before-table join cases. Node names
// match the ones `resolveChange` special-cases ("table", "tableRow",
// "tableCell").
const tableSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      attrs: { pPrMark: { default: null } },
    },
    table: { content: "tableRow+", group: "block" },
    tableRow: {
      content: "tableCell+",
      attrs: { trIns: { default: null }, trDel: { default: null } },
    },
    tableCell: { content: "block+", attrs: { cellMarker: { default: null } } },
    text: { marks: "_" },
  },
  marks: {
    insertion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      excludes: "",
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      excludes: "",
      toDOM: () => ["del", 0],
    },
  },
});

/** doc: [plain paragraph, <markedParagraph>, 2×2 table] */
const tableDoc = (markedParagraph: ReturnType<typeof tableSchema.node>) =>
  tableSchema.node("doc", null, [
    tableSchema.node("paragraph", null, tableSchema.text("before")),
    markedParagraph,
    tableSchema.node("table", null, [
      tableSchema.node("tableRow", null, [
        tableSchema.node("tableCell", null, [
          tableSchema.node("paragraph", null, tableSchema.text("headerA")),
        ]),
        tableSchema.node("tableCell", null, [
          tableSchema.node("paragraph", null, tableSchema.text("headerB")),
        ]),
      ]),
      tableSchema.node("tableRow", null, [
        tableSchema.node("tableCell", null, [
          tableSchema.node("paragraph", null, tableSchema.text("r1c1")),
        ]),
        tableSchema.node("tableCell", null, [
          tableSchema.node("paragraph", null, tableSchema.text("r1c2")),
        ]),
      ]),
    ]),
  ]);

const twoParagraphs = (firstPPrMark: unknown) =>
  EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", { pPrMark: firstPPrMark }, schema.text("first")),
      schema.node("paragraph", null, schema.text("second")),
    ]),
  });

describe("pPrMark accept / reject — paragraph-mark resolution", () => {
  test("accept clears pPrMark.kind = 'ins' (the paragraph break stays)", () => {
    const view = dispatcher(twoParagraphs(insMark({ id: 1 })));
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
    expect(view.state.doc.child(0).textContent).toBe("first");
    expect(view.state.doc.child(1).textContent).toBe("second");
  });

  test("reject of pPrMark.kind = 'ins' joins this paragraph with the next", () => {
    const view = dispatcher(twoParagraphs(insMark({ id: 1 })));
    rejectAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });

  test("accept of pPrMark.kind = 'del' joins this paragraph with the next", () => {
    const view = dispatcher(twoParagraphs(delMark({ id: 1 })));
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });

  test("reject clears pPrMark.kind = 'del' (the paragraph break stays)", () => {
    const view = dispatcher(twoParagraphs(delMark({ id: 1 })));
    rejectAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
    expect(view.state.doc.child(0).textContent).toBe("first");
    expect(view.state.doc.child(1).textContent).toBe("second");
  });

  test("range-scoped acceptChange ignores paragraphs outside the range", () => {
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", { pPrMark: insMark({ id: 1 }) }, schema.text("p1")),
        schema.node("paragraph", { pPrMark: insMark({ id: 2 }) }, schema.text("p2")),
        schema.node("paragraph", null, schema.text("p3")),
      ]),
    });
    const view = dispatcher(state);

    // Range covers only the first paragraph, including its closing boundary.
    acceptChange(0, 4)(view.state, view.dispatch);

    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
    expect(view.state.doc.child(1).attrs["pPrMark"]).toEqual(insMark({ id: 2 }));
  });

  test("range-scoped acceptChange keeps pPrMark when only inline text is selected", () => {
    const insertion = schema.marks["insertion"]!;
    const pPrMark = insMark({ id: 1 });
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", { pPrMark }, [
          schema.text("a"),
          schema.text("b", [
            insertion.create({
              revisionId: 2,
              author: "Alice",
              date: "2026-05-01",
            }),
          ]),
        ]),
        schema.node("paragraph", null, schema.text("next")),
      ]),
    });
    const view = dispatcher(state);

    acceptChange(2, 3)(view.state, view.dispatch);

    let hasInsertion = false;
    view.state.doc.child(0).descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type === insertion)) {
        hasInsertion = true;
      }
    });
    expect(hasInsertion).toBe(false);
    expect(view.state.doc.child(0).attrs["pPrMark"]).toEqual(pPrMark);
    expect(view.state.doc.childCount).toBe(2);
  });

  test("acceptAll on a doc-terminal pPrMark='del' leaves the marker (no next sibling)", () => {
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("first")),
        schema.node("paragraph", { pPrMark: delMark({ id: 1 }) }, schema.text("last")),
      ]),
    });
    const view = dispatcher(state);
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).attrs["pPrMark"]).toEqual(delMark({ id: 1 }));
  });

  test("acceptAll on pPrMark='del' before a table removes the paragraph and keeps every row", () => {
    // jubarte (and Word) mark a fully-deleted paragraph before a table with a
    // deleted paragraph mark. Accepting must drop the paragraph and leave the
    // table untouched. Since prosemirror-transform 1.8, `tr.join` applies
    // destructive `clearIncompatible` steps BEFORE failing on the
    // paragraph|table boundary, so an unguarded join half-applies and eats the
    // table's rows.
    const view = dispatcher(
      EditorState.create({
        schema: tableSchema,
        doc: tableDoc(tableSchema.node("paragraph", { pPrMark: delMark({ id: 1 }) })),
      }),
    );
    acceptAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(2);
    const table = view.state.doc.child(1);
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(2);
    expect(table.textContent).toBe("headerAheaderBr1c1r1c2");
  });

  test("acceptAll on a non-empty pPrMark='del' before a table keeps paragraph text and rows", () => {
    const view = dispatcher(
      EditorState.create({
        schema: tableSchema,
        doc: tableDoc(
          tableSchema.node(
            "paragraph",
            { pPrMark: delMark({ id: 1 }) },
            tableSchema.text("kept"),
          ),
        ),
      }),
    );
    acceptAllChanges()(view.state, view.dispatch);

    // The paragraph cannot merge into the table; nothing may be destroyed.
    expect(view.state.doc.textContent).toBe("beforekeptheaderAheaderBr1c1r1c2");
    expect(view.state.doc.child(2).childCount).toBe(2);
  });

  test("rejectAll on a cell-terminal pPrMark='ins' leaves the cell intact (no sibling to join)", () => {
    // The paragraph is the LAST child of a table cell: joinPos points at the
    // cell's closing token, not a sibling. An unguarded `tr.join` throws a
    // TypeError from inside prosemirror-transform.
    const cellParagraph = tableSchema.node(
      "paragraph",
      { pPrMark: insMark({ id: 1 }) },
      tableSchema.text("cell"),
    );
    const doc = tableSchema.node("doc", null, [
      tableSchema.node("table", null, [
        tableSchema.node("tableRow", null, [
          tableSchema.node("tableCell", null, [cellParagraph]),
          tableSchema.node("tableCell", null, [
            tableSchema.node("paragraph", null, tableSchema.text("other")),
          ]),
        ]),
      ]),
    ]);
    const view = dispatcher(EditorState.create({ schema: tableSchema, doc }));
    rejectAllChanges()(view.state, view.dispatch);

    expect(view.state.doc.textContent).toBe("cellother");
  });

  test("rejectChange + inline insertion on same paragraph resolves both", () => {
    const insertion = schema.marks["insertion"]!;
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", { pPrMark: insMark({ id: 1 }) }, [
          schema.text("kept "),
          schema.text("inserted", [
            insertion.create({
              revisionId: 1,
              author: "Alice",
              date: "2026-05-01",
            }),
          ]),
        ]),
        schema.node("paragraph", null, schema.text("next")),
      ]),
    });
    const view = dispatcher(state);

    rejectChange(0, view.state.doc.content.size)(view.state, view.dispatch);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("kept next");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });
});
