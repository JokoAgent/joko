import type { JSONContent } from "@tiptap/core";
import {
  appendTextToComposerDocument,
  composerDocumentPlainText,
  normalizeComposerDocument,
  plainTextToComposerDocument
} from "../composer-quote-document.js";
import { insertComposerPaletteValue, type ComposerPaletteItem } from "./composer-palette.js";

export interface NewSessionPaletteInsertion {
  readonly document: JSONContent;
  readonly text: string;
}

/** Insert a command or mention without flattening lists and inline atoms. */
export function insertNewSessionPaletteDocument(
  document: unknown,
  typedTrigger: "/" | "@" | undefined,
  item: ComposerPaletteItem
): NewSessionPaletteInsertion {
  const normalized = normalizeComposerDocument(document);
  const currentText = composerDocumentPlainText(normalized);
  const nextText = insertComposerPaletteValue(currentText, typedTrigger, item);
  const nextDocument = typedTrigger !== undefined && currentText === typedTrigger
    ? plainTextToComposerDocument(nextText)
    : appendTextToComposerDocument(normalized, nextText.slice(currentText.length));
  return { document: nextDocument, text: composerDocumentPlainText(nextDocument) };
}
