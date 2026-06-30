import type { FindResult } from "./findReplaceUtils";

export { getAdjacentFindIndex } from "@stll/folio-core/managers/FindReplaceManager";
export type { FindDirection } from "@stll/folio-core/managers/FindReplaceManager";

export type FindEnterAction = "search" | "next" | "previous";

type GetFindEnterActionOptions = {
  searchText: string;
  result: FindResult | null;
  shiftKey: boolean;
};

export function getFindEnterAction({
  searchText,
  result,
  shiftKey,
}: GetFindEnterActionOptions): FindEnterAction {
  if (!searchText.trim() || !result || result.totalCount === 0) {
    return "search";
  }

  return shiftKey ? "previous" : "next";
}
