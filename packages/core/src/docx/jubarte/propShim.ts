/**
 * Property-tree shim between jubarte's AST property nodes and folio's
 * XmlElement shape (docx/xmlParser.ts, fast-xml-parser-based) that the core
 * interpreters consume.
 *
 * Jubarte captures every `<w:pPr>`/`<w:rPr>`/`<w:tblPr>`/… child as a typed
 * `AstRunProp { name, attrs, children }` tree (source order, full attribute
 * maps). The core's property interpreters (paragraphParser, runParser,
 * tableParser, sectionParser, …) consume `XmlElement` trees. The two shapes
 * are isomorphic; these converters let the interpreters run unchanged on
 * jubarte-parsed documents, and let model serialization emit jubarte property
 * trees instead of XML strings.
 */

import type { XmlElement } from "../xmlParser";
import type { AstRunProp } from "./types";

/** Convert a single jubarte property node into an XmlElement. */
export function astPropToXmlElement(prop: AstRunProp): XmlElement {
  const element: XmlElement = {
    type: "element",
    name: prop.name,
  };
  if (prop.attrs && Object.keys(prop.attrs).length > 0) {
    element.attributes = { ...prop.attrs };
  }
  if (prop.children && prop.children.length > 0) {
    element.elements = prop.children.map(astPropToXmlElement);
  }
  return element;
}

/**
 * Wrap a jubarte property list as a synthetic container element (e.g. a
 * `w:pPr` holding the paragraph's property children) so container-consuming
 * interpreters can walk it with findChild/findChildren.
 */
export function astPropsToContainerElement(
  containerName: string,
  props: readonly AstRunProp[] | null | undefined,
): XmlElement | null {
  if (!props || props.length === 0) {
    return null;
  }
  return {
    type: "element",
    name: containerName,
    elements: props.map(astPropToXmlElement),
  };
}

/** Convert an XmlElement into a jubarte property node. */
export function xmlElementToAstProp(element: XmlElement): AstRunProp | null {
  if (element.type !== "element" || !element.name) {
    return null;
  }
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.attributes ?? {})) {
    if (value !== undefined) {
      attrs[key] = String(value);
    }
  }
  const children = (element.elements ?? [])
    .map(xmlElementToAstProp)
    .filter((child): child is AstRunProp => child !== null);
  const prop: AstRunProp = { name: element.name, attrs };
  if (children.length > 0) {
    prop.children = children;
  }
  return prop;
}

/**
 * Convert the children of an XmlElement container (e.g. a built `w:pPr`)
 * into a jubarte property list.
 */
export function containerElementToAstProps(
  container: XmlElement | null | undefined,
): AstRunProp[] | null {
  if (!container?.elements?.length) {
    return null;
  }
  const props = container.elements
    .map(xmlElementToAstProp)
    .filter((prop): prop is AstRunProp => prop !== null);
  return props.length > 0 ? props : null;
}
