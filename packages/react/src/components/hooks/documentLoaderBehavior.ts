import type { Document } from "@stll/folio-core/types/document";
import type { DocxInput } from "@stll/folio-core/utils/docxInput";

export type DocumentLoadSource =
  | {
      type: "buffer";
      buffer: DocxInput;
    }
  | {
      type: "parsed-document";
      document: Document;
    }
  | {
      type: "none";
    };

export const getDocumentLoadSource = ({
  documentBuffer,
  initialDocument,
}: {
  documentBuffer: DocxInput | null | undefined;
  initialDocument: Document | null | undefined;
}): DocumentLoadSource => {
  if (documentBuffer) {
    return { type: "buffer", buffer: documentBuffer };
  }

  if (initialDocument) {
    return { type: "parsed-document", document: initialDocument };
  }

  return { type: "none" };
};
