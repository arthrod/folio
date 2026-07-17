/**
 * Jubarte AST node types, derived structurally from the exported
 * `AstPackage` root. The dist entry points export the package/root types but
 * not the individual node types, so we extract them via indexed access —
 * this stays sound against the actual build we depend on.
 */

import type { AstPackage } from "@arthrod/jubarte";

export type { AstPackage };

export type AstDocument = AstPackage["document"];
export type AstDocumentElement = AstDocument["children"][number];
export type AstComment = AstDocument["comments"][number];
export type AstNote = AstDocument["notes"][number];

export type AstPackageGraph = AstPackage["package"];
export type AstPackagePart = AstPackageGraph["parts"][string];
export type AstRelationship = AstPackageGraph["relationships"][string][number];

export type AstParagraph = Extract<AstDocumentElement, { type: "paragraph" }>;
export type AstRun = Extract<AstDocumentElement, { type: "run" }>;
export type AstText = Extract<AstDocumentElement, { type: "text" }>;
export type AstImage = Extract<AstDocumentElement, { type: "image" }>;
export type AstDrawing = Extract<AstDocumentElement, { type: "drawing" }>;
export type AstTable = Extract<AstDocumentElement, { type: "table" }>;
export type AstTableRow = Extract<AstDocumentElement, { type: "tableRow" }>;
export type AstTableCell = Extract<AstDocumentElement, { type: "tableCell" }>;
export type AstHyperlink = Extract<AstDocumentElement, { type: "hyperlink" }>;
export type AstBookmarkStart = Extract<AstDocumentElement, { type: "bookmarkStart" }>;
export type AstBookmarkEnd = Extract<AstDocumentElement, { type: "bookmarkEnd" }>;
export type AstInserted = Extract<AstDocumentElement, { type: "inserted" }>;
export type AstDeleted = Extract<AstDocumentElement, { type: "deleted" }>;
export type AstMoveFrom = Extract<AstDocumentElement, { type: "moveFrom" }>;
export type AstMoveTo = Extract<AstDocumentElement, { type: "moveTo" }>;
export type AstFieldChar = Extract<AstDocumentElement, { type: "fieldChar" }>;
export type AstFieldInstruction = Extract<AstDocumentElement, { type: "fieldInstruction" }>;
export type AstSimpleField = Extract<AstDocumentElement, { type: "simpleField" }>;
export type AstBreak = Extract<AstDocumentElement, { type: "break" }>;
export type AstTab = Extract<AstDocumentElement, { type: "tab" }>;
export type AstNoteReference = Extract<AstDocumentElement, { type: "noteReference" }>;
export type AstCommentReference = Extract<AstDocumentElement, { type: "commentReference" }>;
export type AstCommentRangeStart = Extract<AstDocumentElement, { type: "commentRangeStart" }>;
export type AstCommentRangeEnd = Extract<AstDocumentElement, { type: "commentRangeEnd" }>;
export type AstSdt = Extract<AstDocumentElement, { type: "sdt" }>;
export type AstMathBlock = Extract<AstDocumentElement, { type: "mathBlock" }>;
export type AstAlternateContent = Extract<AstDocumentElement, { type: "alternateContent" }>;
export type AstSmartTag = Extract<AstDocumentElement, { type: "smartTag" }>;
export type AstOpaqueElement = Extract<AstDocumentElement, { type: "opaqueElement" }>;

/** The `{name, attrs, children}` property node used for ppr/rpr/tblpr/…. */
export type AstRunProp = NonNullable<AstParagraph["ppr"]>[number];
