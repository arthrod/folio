/**
 * The "monolith" experiment: aggregate a redline's tracked changes into
 * paragraph-level blocks instead of per-paragraph word interleaving.
 *
 * Every top-level body paragraph that carries revisions is rewritten as a
 * fully-DELETED copy of its original text followed by a fully-INSERTED copy of
 * its final text (Word's whole-paragraph revision convention: content wrapped
 * in one `w:del`/`w:ins`, paragraph mark marked via `pPr/rPr/del|ins`).
 * Consecutive modified paragraphs merge into one deleted block followed by one
 * inserted block — the monolith.
 *
 * View-preserving: the accepted view drops every deleted paragraph (content
 * gone + deleted mark joins it away) and keeps the inserted finals; the
 * rejected view restores the original paragraphs and joins away the inserted
 * ones. Table interiors and the document-terminal paragraph keep their
 * word-level diffs (cell structure must survive, and a doc-terminal deleted
 * mark has no join target).
 */

import JSZip from "jszip";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCUMENT_PART = "word/document.xml";

export type MonolithResult = {
  buffer: ArrayBuffer;
  /** Revision elements (w:ins + w:del) before aggregation. */
  elementsBefore: number;
  /** Revision elements after aggregation. */
  elementsAfter: number;
};

type RevisionAttrs = { author: string; date: string };

const isW = (node: Node, localName: string): node is Element =>
  node.nodeType === Node.ELEMENT_NODE &&
  (node as Element).namespaceURI === W_NS &&
  (node as Element).localName === localName;

const directChild = (parent: Element, localName: string): Element | null => {
  for (const child of Array.from(parent.childNodes)) {
    if (isW(child, localName)) {
      return child;
    }
  }
  return null;
};

const paragraphMark = (paragraph: Element): "ins" | "del" | null => {
  const pPr = directChild(paragraph, "pPr");
  const rPr = pPr ? directChild(pPr, "rPr") : null;
  if (!rPr) {
    return null;
  }
  if (directChild(rPr, "ins")) {
    return "ins";
  }
  if (directChild(rPr, "del")) {
    return "del";
  }
  return null;
};

/**
 * A paragraph joins a monolith cluster when it is revision-bearing AND
 * self-contained. A paragraph whose MARK is deleted/inserted but which still
 * carries content belonging to the other side (kept runs merge into a
 * neighbour when the mark resolves) cannot be split into del/ins copies
 * without changing a resolved view — leave those word-diffed.
 */
const isAggregatable = (paragraph: Element): boolean => {
  const mark = paragraphMark(paragraph);
  let hasInline = false;
  for (const child of Array.from(paragraph.childNodes)) {
    if (isW(child, "ins") || isW(child, "del")) {
      hasInline = true;
      if (mark === "del" && isW(child, "ins")) {
        return false;
      }
      if (mark === "ins" && isW(child, "del")) {
        return false;
      }
      continue;
    }
    if (isW(child, "r") && mark !== null) {
      // Kept run inside a mark-revised paragraph: it belongs to the other
      // side's neighbour after the mark resolves.
      return false;
    }
  }
  return mark !== null || hasInline;
};

const hasText = (paragraph: Element, selector: "t" | "delText"): boolean =>
  paragraph.getElementsByTagNameNS(W_NS, selector).length > 0;

export const aggregateMonolith = async (redline: ArrayBuffer): Promise<MonolithResult> => {
  const zip = await JSZip.loadAsync(redline);
  const part = zip.file(DOCUMENT_PART);
  if (!part) {
    throw new Error(`monolith: ${DOCUMENT_PART} missing from the redline package`);
  }
  const xml = await part.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("monolith: document.xml failed to parse");
  }

  const body = doc.getElementsByTagNameNS(W_NS, "body").item(0);
  if (!body) {
    throw new Error("monolith: w:body missing");
  }

  // Reuse an existing revision's author/date for the wrappers we mint; ids
  // continue past the current maximum.
  const someRevision =
    doc.getElementsByTagNameNS(W_NS, "ins").item(0) ??
    doc.getElementsByTagNameNS(W_NS, "del").item(0);
  const attrs: RevisionAttrs = {
    author: someRevision?.getAttributeNS(W_NS, "author") ?? "Jubarte",
    date: someRevision?.getAttributeNS(W_NS, "date") ?? "2026-01-01T00:00:00Z",
  };
  let nextId =
    Math.max(
      0,
      ...[
        ...Array.from(doc.getElementsByTagNameNS(W_NS, "ins")),
        ...Array.from(doc.getElementsByTagNameNS(W_NS, "del")),
      ].map((el) => Number(el.getAttributeNS(W_NS, "id")) || 0),
    ) + 1;

  const makeRevisionElement = (kind: "ins" | "del"): Element => {
    const el = doc.createElementNS(W_NS, `w:${kind}`);
    el.setAttributeNS(W_NS, "w:id", String(nextId));
    nextId += 1;
    el.setAttributeNS(W_NS, "w:author", attrs.author);
    el.setAttributeNS(W_NS, "w:date", attrs.date);
    return el;
  };

  const setMark = (paragraph: Element, kind: "ins" | "del"): void => {
    let pPr = directChild(paragraph, "pPr");
    if (!pPr) {
      pPr = doc.createElementNS(W_NS, "w:pPr");
      paragraph.insertBefore(pPr, paragraph.firstChild);
    }
    let rPr = directChild(pPr, "rPr");
    if (!rPr) {
      rPr = doc.createElementNS(W_NS, "w:rPr");
      const sectPr = directChild(pPr, "sectPr");
      pPr.insertBefore(rPr, sectPr);
    }
    for (const existing of ["ins", "del"]) {
      const el = directChild(rPr, existing);
      if (el) {
        rPr.removeChild(el);
      }
    }
    rPr.insertBefore(makeRevisionElement(kind), rPr.firstChild);
  };

  const toDelText = (root: Element): void => {
    for (const t of Array.from(root.getElementsByTagNameNS(W_NS, "t"))) {
      const delText = doc.createElementNS(W_NS, "w:delText");
      for (const attr of Array.from(t.attributes)) {
        delText.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      }
      while (t.firstChild) {
        delText.appendChild(t.firstChild);
      }
      t.parentNode?.replaceChild(delText, t);
    }
  };

  /**
   * Rebuild `paragraph` with one revision wrapper holding its whole
   * side-specific content: kind "del" keeps original text (kept runs + w:del
   * content, converted to delText); kind "ins" keeps final text (kept runs +
   * w:ins content). Returns null when that side has no content.
   */
  const buildSide = (paragraph: Element, kind: "ins" | "del"): Element | null => {
    if (paragraphMark(paragraph) === (kind === "del" ? "ins" : "del")) {
      // A fully-inserted paragraph has no original; a fully-deleted one has
      // no final.
      return null;
    }
    const fresh = doc.createElementNS(W_NS, "w:p");
    const pPr = directChild(paragraph, "pPr");
    if (pPr) {
      fresh.appendChild(pPr.cloneNode(true));
    }
    const wrapper = makeRevisionElement(kind);
    for (const child of Array.from(paragraph.childNodes)) {
      if (isW(child, "r")) {
        wrapper.appendChild(child.cloneNode(true));
        continue;
      }
      if (isW(child, kind === "del" ? "del" : "ins")) {
        // Same-side revision content: unwrap into the monolith wrapper.
        for (const inner of Array.from(child.childNodes)) {
          wrapper.appendChild(inner.cloneNode(true));
        }
      }
      // Opposite-side revisions and non-run furniture are dropped from the
      // rebuilt side.
    }
    if (kind === "del") {
      toDelText(wrapper);
    }
    if (!hasText(wrapper, kind === "del" ? "delText" : "t")) {
      return null;
    }
    fresh.appendChild(wrapper);
    setMark(fresh, kind);
    return fresh;
  };

  const buildDeletedOriginal = (paragraph: Element): Element | null => buildSide(paragraph, "del");
  const buildInsertedFinal = (paragraph: Element): Element | null => buildSide(paragraph, "ins");

  const countRevisionElements = (): number =>
    doc.getElementsByTagNameNS(W_NS, "ins").length + doc.getElementsByTagNameNS(W_NS, "del").length;
  const elementsBefore = countRevisionElements();

  // Top-level body paragraphs only; leave the terminal one word-diffed (a
  // doc-terminal deleted mark has no join target on accept).
  const children = Array.from(body.childNodes).filter((node): node is Element => isW(node, "p"));
  const lastParagraph = children.at(-1) ?? null;

  let cluster: Element[] = [];
  const clusters: Element[][] = [];
  for (const node of Array.from(body.childNodes)) {
    if (isW(node, "p") && node !== lastParagraph && isAggregatable(node)) {
      cluster.push(node);
      continue;
    }
    if (cluster.length > 0) {
      clusters.push(cluster);
      cluster = [];
    }
  }
  if (cluster.length > 0) {
    clusters.push(cluster);
  }

  for (const group of clusters) {
    const anchor = group.at(0);
    if (!anchor) {
      continue;
    }
    const deleted = group
      .map((paragraph) => buildDeletedOriginal(paragraph))
      .filter((paragraph): paragraph is Element => paragraph !== null);
    const inserted = group
      .map((paragraph) => buildInsertedFinal(paragraph))
      .filter((paragraph): paragraph is Element => paragraph !== null);
    for (const paragraph of [...deleted, ...inserted]) {
      body.insertBefore(paragraph, anchor);
    }
    for (const paragraph of group) {
      body.removeChild(paragraph);
    }
  }

  const elementsAfter = countRevisionElements();

  const declaration = xml.startsWith("<?xml") ? `${xml.slice(0, xml.indexOf("?>") + 2)}\n` : "";
  const serialized = declaration + new XMLSerializer().serializeToString(doc);
  zip.file(DOCUMENT_PART, serialized);
  const buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return { buffer, elementsBefore, elementsAfter };
};
