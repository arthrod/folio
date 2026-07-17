import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";

const paragraphSpec = basicSchema.spec.nodes.get("paragraph");
if (!paragraphSpec) {
  throw new Error("prosemirror-schema-basic no longer defines a paragraph node");
}

/**
 * Text-only spike schema: basic nodes plus Premirror pagination attrs on
 * paragraphs. Deliberately NO list nodes — docToPm maps only paragraphs, and
 * the schema should not advertise capabilities the converter cannot produce
 * (review finding).
 */
export const spikeSchema = new Schema({
  nodes: basicSchema.spec.nodes.update("paragraph", {
    ...paragraphSpec,
    attrs: {
      manualPageBreakBefore: { default: false },
    },
  }),
  marks: basicSchema.spec.marks,
});
