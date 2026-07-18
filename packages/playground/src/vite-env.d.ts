/// <reference types="vite/client" />

// jubarte-first is bundled from SOURCE via the `jubarte-src` vite alias (its
// dist is stale vs branch HEAD). These ambient declarations type the narrow
// surface the demo consumes; the specifiers are opaque to tsc, so vite's
// alias is the only resolver involved.

declare module "jubarte-src/lossless/DocumentComparer.ts" {
  export const DocumentComparer: {
    CompareDocuments(
      originalBytes: Uint8Array,
      modifiedBytes: Uint8Array,
      authorName: string | null,
    ): Uint8Array;
    CompareDocumentsToHtmlWithOptions(
      originalBytes: Uint8Array,
      modifiedBytes: Uint8Array,
      authorName: string | null,
      renderTrackedChanges: boolean,
    ): string;
    GetRevisionsJson(comparedDocBytes: Uint8Array): string;
  };
}

declare module "jubarte-src/lossless/lib/ooxml-package-jszip.ts" {
  export function wireWmlComparerNodeAdapter(): void;
  export function acceptRevisionsDocxBytes(bytes: Uint8Array): Uint8Array;
  export function rejectRevisionsDocxBytes(bytes: Uint8Array): Uint8Array;
}

declare module "jubarte-src/lossless/FormattingAssembler.ts" {
  export function setListItemRetrieverProvider(provider: {
    RetrieveListItem: (wDoc: unknown, para: unknown, settings: unknown) => unknown;
    GetEffectiveLevel: (para: unknown) => unknown;
    GetParagraphLevel: (para: unknown) => unknown;
    ListItemInfoType: never;
    LevelNumbersType: unknown;
  }): void;
}

declare module "jubarte-src/lossless/ListItemRetriever.ts" {
  export const LevelNumbers: unknown;
  export const ListItemRetriever: {
    RetrieveListItem(wDoc: never, para: unknown, settings: never): unknown;
    GetEffectiveLevel(para: unknown): unknown;
    GetParagraphLevel(para: unknown): unknown;
    ListItemInfo: unknown;
  };
}

declare module "jubarte-src/lossless/WmlDocument.ts" {
  export class WmlDocument {
    constructor(bytes: Uint8Array);
  }
}

declare module "jubarte-src/lossless/WmlToHtmlConverter.ts" {
  import type { WmlDocument } from "jubarte-src/lossless/WmlDocument.ts";
  export class WmlToHtmlConverterSettings {
    PageTitle: string;
    CssClassPrefix: string;
    FabricateCssClasses: boolean;
    RenderTrackedChanges: boolean;
    IncludeRevisionMetadata: boolean;
    ShowDeletedContent: boolean;
    RenderMoveOperations: boolean;
    AuthorColors: Map<string, string>;
  }
  export const WmlToHtmlConverter: {
    ConvertToHtml(
      document: WmlDocument,
      settings: WmlToHtmlConverterSettings,
    ): { toString(): string };
  };
}
