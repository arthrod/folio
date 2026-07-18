import { describe, expect, it } from "bun:test";

import type { SegmentFitEngineLike } from "@stll/premirror-core";
import { defaultPremirrorOptions } from "@stll/premirror-core";
import { Schema } from "prosemirror-model";
import { AllSelection, EditorState } from "prosemirror-state";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

import { createPremirror, premirrorInvalidationKey } from "./index";

/**
 * `measureSnapshotImpl` measures through the injected `SegmentFitEngineLike`
 * (E-4 unification; see UPSTREAM.md). Tests below cover the engine success
 * path, the throwing-engine fallback, and the absent-engine fallback by
 * injecting deterministic fakes through `PremirrorOptions.engine` — no module
 * mocking involved.
 */

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

  it("measures using the injected engine's line width when measurement succeeds", () => {
    // Inject a deterministic engine, as the bridge would in production.
    // Exercises the `firstLine.width` success branch (formerly the
    // pretext-module success path, then covered by mocking the module
    // boundary; the seam makes plain injection sufficient).
    const engine: SegmentFitEngineLike = {
      prepare: (text: string) => ({ text }),
      fitLine: (prepared) => {
        const { text } = prepared as { text: string };
        return {
          endChar: text.length,
          width: text.length * 50,
          cursor: null,
        };
      },
    };

    const runtime = createPremirror(defaultPremirrorOptions({ engine }));
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

  it("falls back to deterministic width when engine measurement throws", () => {
    // Prior/baseline behavior: when the engine is unavailable (throws),
    // measureSnapshotImpl must still produce a stable, deterministic width
    // and mark the measurement as a fallback rather than propagating.
    const engine: SegmentFitEngineLike = {
      prepare: () => {
        throw new Error("engine unavailable");
      },
      fitLine: () => null,
    };

    const runtime = createPremirror(defaultPremirrorOptions({ engine }));
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

describe("segment-fit engine injection (E-4 unification)", () => {
  it("uses the deterministic fallback marker when no engine is injected", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("NoEngine")])]),
      plugins: runtime.plugins,
    });
    const measured = runtime.measureSnapshot(runtime.toSnapshot(state));
    const firstKey = Object.keys(measured.measuredRuns)[0];
    expect(firstKey).toBeDefined();
    expect(measured.measuredRuns[firstKey!]?.widthPx).toBe(56);
    expect(measured.measuredRuns[firstKey!]?.prepared).toMatchObject({
      kind: "premirror-measurement-fallback",
    });
  });
});
