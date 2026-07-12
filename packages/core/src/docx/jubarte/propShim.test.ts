import { describe, expect, test } from "bun:test";

import type { XmlElement } from "../xmlParser";
import {
  astPropsToContainerElement,
  astPropToXmlElement,
  containerElementToAstProps,
  xmlElementToAstProp,
} from "./propShim";
import type { AstRunProp } from "./types";

describe("propShim", () => {
  const spacing: AstRunProp = {
    name: "w:spacing",
    attrs: { "w:before": "240", "w:after": "120", "w:line": "360", "w:lineRule": "auto" },
  };
  const numPr: AstRunProp = {
    name: "w:numPr",
    attrs: {},
    children: [
      { name: "w:ilvl", attrs: { "w:val": "1" } },
      { name: "w:numId", attrs: { "w:val": "3" } },
    ],
  };

  test("astPropToXmlElement maps name/attrs/children recursively", () => {
    const el = astPropToXmlElement(numPr);
    expect(el.type).toBe("element");
    expect(el.name).toBe("w:numPr");
    expect(el.attributes).toBeUndefined();
    expect(el.elements).toHaveLength(2);
    expect(el.elements?.[0]?.name).toBe("w:ilvl");
    expect(el.elements?.[0]?.attributes).toEqual({ "w:val": "1" });
  });

  test("astPropsToContainerElement wraps props as a pPr container", () => {
    const container = astPropsToContainerElement("w:pPr", [spacing, numPr]);
    expect(container?.name).toBe("w:pPr");
    expect(container?.elements).toHaveLength(2);
    expect(container?.elements?.[0]?.attributes?.["w:before"]).toBe("240");
  });

  test("astPropsToContainerElement returns null for empty input", () => {
    expect(astPropsToContainerElement("w:pPr", null)).toBeNull();
    expect(astPropsToContainerElement("w:pPr", [])).toBeNull();
  });

  test("round-trips XmlElements to props and back", () => {
    const container = astPropsToContainerElement("w:rPr", [spacing, numPr]);
    const props = containerElementToAstProps(container);
    expect(props).toEqual([spacing, numPr]);
  });

  test("xmlElementToAstProp stringifies numeric attributes and skips non-elements", () => {
    const el: XmlElement = {
      type: "element",
      name: "w:sz",
      attributes: { "w:val": 24 },
    };
    expect(xmlElementToAstProp(el)).toEqual({ name: "w:sz", attrs: { "w:val": "24" } });
    expect(xmlElementToAstProp({ type: "text", text: "x" })).toBeNull();
  });
});
