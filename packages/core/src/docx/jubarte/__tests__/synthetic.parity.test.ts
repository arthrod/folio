/**
 * Synthetic parity stress cases for constructs the fixture corpus lacks:
 * multi-row vertical merges with gridSpan, OMML math (inline + block-level
 * oMathPara), smartTag wrappers, break/hyphen run content, and a VML text
 * watermark header. Each builds a minimal DOCX in memory and deep-compares
 * the legacy and jubarte-backed parses, like the fixture harness.
 */

import { expect, test } from "bun:test";
import JSZip from "jszip";

import { parseDocx } from "../../parser";
import type { ParseOptions } from "../../parser";
import { parseDocxWithJubarte } from "../parseDocx";
import { diffDocuments } from "./parityDiff";

const PARSE_OPTIONS: ParseOptions = {
  preloadFonts: false,
  parseHeadersFooters: true,
  parseNotes: true,
  detectVariables: true,
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

type SyntheticPackage = {
  documentXml: string;
  documentRelsXml?: string;
  headerXml?: string;
};

async function assertParity({ documentXml, documentRelsXml, headerXml }: SyntheticPackage): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", documentXml);
  if (documentRelsXml) {
    zip.file("word/_rels/document.xml.rels", documentRelsXml);
  }
  if (headerXml) {
    zip.file("word/header1.xml", headerXml);
  }
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const legacy = await parseDocx(buffer.slice(0), PARSE_OPTIONS);
  const viaJubarte = await parseDocxWithJubarte(buffer.slice(0), PARSE_OPTIONS);
  const diffs = diffDocuments(legacy, viaJubarte);
  if (diffs.length > 0) {
    console.error(`\n[synthetic parity] ${diffs.length}+ differences:`);
    for (const diff of diffs.slice(0, 30)) {
      console.error(`  ${diff}`);
    }
  }
  expect(diffs).toEqual([]);
}

const cell = (text: string, tcPr = ""): string =>
  `<w:tc><w:tcPr>${tcPr}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

test("vertical merges with gridSpan re-expand identically", async () => {
  await assertParity({
    documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:tbl>
<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>
<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
<w:tr>${cell("a1", '<w:vMerge w:val="restart"/>')}${cell("b1")}${cell("wide1", '<w:gridSpan w:val="2"/>')}</w:tr>
<w:tr>${cell("a2", "<w:vMerge/>")}${cell("b2")}${cell("c2", '<w:vMerge w:val="restart"/><w:gridSpan w:val="2"/>')}</w:tr>
<w:tr>${cell("a3", "<w:vMerge/>")}${cell("b3")}${cell("c3", '<w:vMerge/><w:gridSpan w:val="2"/>')}</w:tr>
<w:tr>${cell("a4")}${cell("b4")}${cell("c4")}${cell("d4")}</w:tr>
</w:tbl>
<w:p><w:r><w:t>after</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body></w:document>`,
  });
});

test("math, smartTag, and break/hyphen run content parse identically", async () => {
  await assertParity({
    documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
<w:body>
<w:p w14:paraId="1A2B3C4D" w14:textId="0F0F0F0F"><w:r><w:t>before </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath><w:r><w:t xml:space="preserve"> mid </w:t></w:r></w:p>
<m:oMathPara><m:oMath><m:r><m:t>y=z</m:t></m:r></m:oMath></m:oMathPara>
<w:p><w:smartTag w:uri="urn:x" w:element="date"><w:smartTagPr><w:attr w:name="day" w:val="1"/></w:smartTagPr><w:r><w:t>tagged</w:t></w:r></w:smartTag><w:r><w:t>tail</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:softHyphen/><w:noBreakHyphen/><w:tab/><w:br w:type="page"/><w:t>end</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body></w:document>`,
  });
});

test("VML text watermark header parses identically", async () => {
  await assertParity({
    documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rId4"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body></w:document>`,
    documentRelsXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`,
    headerXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:pict><v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:path textpathok="t" o:connecttype="custom"/><v:textpath on="t" fitshape="t"/></v:shapetype><v:shape id="PowerPlusWaterMarkObject357831064" o:spid="_x0000_s2049" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:412.4pt;height:247.45pt;rotation:315;z-index:-251658752" o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"/></v:shape></w:pict></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t>Visible header text</w:t></w:r></w:p>
</w:hdr>`,
  });
});
