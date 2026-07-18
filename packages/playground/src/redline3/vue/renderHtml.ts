/**
 * Docx → HTML rendering for the full-Vue pages, through jubarte-first's
 * lossless `WmlToHtmlConverter` (tracked changes rendered natively). The
 * output is a complete XHTML document; the panes host it in an iframe so its
 * fabricated CSS classes stay isolated from the app shell.
 */

import { setListItemRetrieverProvider } from "jubarte-src/lossless/FormattingAssembler.ts";
import { LevelNumbers, ListItemRetriever } from "jubarte-src/lossless/ListItemRetriever.ts";
import { WmlDocument } from "jubarte-src/lossless/WmlDocument.ts";
import {
  WmlToHtmlConverter,
  WmlToHtmlConverterSettings,
} from "jubarte-src/lossless/WmlToHtmlConverter.ts";

import { ensureLosslessWired } from "../engines";

// jubarte-first ships `FormattingAssembler.register.ts` as a side-effect
// module, but its package declares `sideEffects: false`, so bundlers shake the
// bare import away. Replicate the exact wiring here with used imports.
let listItemWired = false;
const ensureListItemRetrieverWired = (): void => {
  if (listItemWired) {
    return;
  }
  setListItemRetrieverProvider({
    RetrieveListItem: (wDoc, para, settings) =>
      ListItemRetriever.RetrieveListItem(wDoc as never, para, settings as never),
    GetEffectiveLevel: (para) => ListItemRetriever.GetEffectiveLevel(para),
    GetParagraphLevel: (para) => ListItemRetriever.GetParagraphLevel(para),
    ListItemInfoType: ListItemRetriever.ListItemInfo as never,
    LevelNumbersType: LevelNumbers,
  });
  listItemWired = true;
};

export const docxToHtml = (bytes: ArrayBuffer, renderTrackedChanges: boolean): string => {
  ensureLosslessWired();
  ensureListItemRetrieverWired();
  const settings = new WmlToHtmlConverterSettings();
  settings.PageTitle = "";
  settings.CssClassPrefix = "redline-";
  settings.FabricateCssClasses = true;
  settings.RenderTrackedChanges = renderTrackedChanges;
  settings.IncludeRevisionMetadata = renderTrackedChanges;
  settings.ShowDeletedContent = true;
  settings.RenderMoveOperations = true;
  if (renderTrackedChanges) {
    settings.AuthorColors = new Map([["Jubarte", "#b40000"]]);
  }
  const html = WmlToHtmlConverter.ConvertToHtml(new WmlDocument(new Uint8Array(bytes)), settings);
  return html.toString();
};
