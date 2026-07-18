import { afterEach, describe, expect, it, mock } from "bun:test";

import { defaultPremirrorOptions } from "@stll/premirror-core";
import { Schema } from "prosemirror-model";
import { AllSelection, EditorState } from "prosemirror-state";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

import { createPremirror, premirrorInvalidationKey } from "./index";

/**
 * `@chenglou/pretext` resolves to the deterministic local stub under `bun test`
 * (see UPSTREAM.md), so `measureSnapshotImpl`'s real-measurement success path
 * and its throw/catch fallback path are never exercised by the tests above
 * (the stub always returns `null` without throwing). We mock the module
 * boundary (transport layer) to cover both paths explicitly, without
 * patching the pretext stub's exported functions directly.
 */
function restorePretextStub(): void {
  mock.module("@chenglou/pretext", () => ({
    prepareWithSegments: () => ({}),
    layoutNextLine: () => null,
  }));
}

afterEach(() => {
  restorePretextStub();
});

const paragraphSpec = basicSchema.spec.nodes.get("paragraph");

if (!paragraphSpec) {
  throw new Error("Missing paragraph spec");
}

const schema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes.update("paragraph", {
      ...paragraphSpec,
      attrs: {
        ...paragraphSpec.attrs,
        manualPageBreakBefore: { default: false },
      },
    }),
    "paragraph block*",
    "block",
  ),
  marks: basicSchema.spec.marks,
});

describe("@premirror/prosemirror-adapter", () => {
  it("extracts snapshot blocks and marks", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const strong = schema.marks.strong;
    if (!strong) throw new Error("Missing strong mark");
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("Hello ", []),
          schema.text("bold", [strong.create()]),
        ]),
      ]),
      plugins: runtime.plugins,
    });

    const snapshot = runtime.toSnapshot(state);
    expect(snapshot.blocks.length).toBe(1);
    expect(snapshot.blocks[0]?.runs.length).toBeGreaterThanOrEqual(2);
  });

  it("measures snapshot runs", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Measure me")])]),
      plugins: runtime.plugins,
    });
    const measured = runtime.measureSnapshot(runtime.toSnapshot(state));
    const firstKey = Object.keys(measured.measuredRuns)[0];
    expect(firstKey).toBeDefined();
    expect(measured.measuredRuns[firstKey!]?.widthPx).toBeGreaterThanOrEqual(0);
  });

  it("insertPageBreak command dispatches a transaction", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("One")])]),
      plugins: runtime.plugins,
    });

    let nextState: EditorState | undefined;
    const didRun = runtime.commands.insertPageBreak(state, (tr) => {
      nextState = state.apply(tr);
    });

    expect(didRun).toBe(true);
    expect(nextState).toBeDefined();
    if (!nextState) return;
    expect(nextState.doc.childCount).toBeGreaterThanOrEqual(2);
  });

  it("tracks invalidation range on doc change", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("abc")])]),
      plugins: runtime.plugins,
    });
    const tr = state.tr.insertText("x", 2);
    const next = state.apply(tr);
    const inval = premirrorInvalidationKey.getState(next) ?? null;
    expect(inval).not.toBeNull();
    expect(runtime.getInvalidationRange(next)).toEqual(inval);
  });

  it("measures using the real pretext line width when measurement succeeds (upstream pretext path)", () => {
    // Simulate the real @chenglou/pretext package succeeding, as it would in
    // production (Vite aliases to the real package; only `bun test` resolves
    // the deterministic stub via tsconfig paths). Mocking the module
    // boundary here exercises the `firstLine.width` success branch that the
    // stub can never produce.
    mock.module("@chenglou/pretext", () => ({
      prepareWithSegments: (text: string) => ({ text }),
      layoutNextLine: (prepared: unknown) => {
        const { text } = prepared as { text: string };
        return {
          text,
          width: text.length * 50,
          end: { segmentIndex: 0, graphemeIndex: text.length },
        };
      },
    }));

    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Hi")])]),
      plugins: runtime.plugins,
    });
    const measured = runtime.measureSnapshot(runtime.toSnapshot(state));
    const firstKey = Object.keys(measured.measuredRuns)[0];
    expect(firstKey).toBeDefined();
    expect(measured.measuredRuns[firstKey!]?.widthPx).toBe(100);
  });

  it("falls back to deterministic width when pretext measurement throws", () => {
    // Prior/baseline behavior: when pretext itself is unavailable (throws),
    // measureSnapshotImpl must still produce a stable, deterministic width
    // and mark the measurement as a fallback rather than propagating.
    mock.module("@chenglou/pretext", () => ({
      prepareWithSegments: () => {
        throw new Error("pretext unavailable");
      },
      layoutNextLine: () => null,
    }));

    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Yo")])]),
      plugins: runtime.plugins,
    });
    const measured = runtime.measureSnapshot(runtime.toSnapshot(state));
    const firstKey = Object.keys(measured.measuredRuns)[0];
    expect(firstKey).toBeDefined();
    expect(measured.measuredRuns[firstKey!]?.widthPx).toBe(14);
    expect(measured.measuredRuns[firstKey!]?.prepared).toMatchObject({
      kind: "premirror-measurement-fallback",
    });
  });
});

describe("insertPageBreak at document root (PR #110 review)", () => {
  it("does not throw for a depth-0 selection (e.g. AllSelection)", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("one")])]);
    let state = EditorState.create({ schema, doc, plugins: runtime.plugins });
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(state.selection.$from.depth).toBe(0);
    let applied: EditorState | null = null;
    expect(() => {
      runtime.commands.insertPageBreak(state, (tr) => {
        applied = state.apply(tr);
      });
    }).not.toThrow();
    expect(applied).not.toBeNull();
  });
});
