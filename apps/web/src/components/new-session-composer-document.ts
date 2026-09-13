import type { JSONContent } from "@tiptap/core";
import {
  appendTextToComposerDocument,
  composerDocumentPlainText,
  normalizeComposerDocument,
  plainTextToComposerDocument
} from "../composer-quote-document.js";
import {
  insertComposerPaletteValue,
  replaceComposerCommandRun,
  type ComposerCommandActivation,
  type ComposerPaletteItem
} from "./composer-palette.js";
import { replaceComposerDocumentTextRange } from "./composer-inline-mention.js";

export interface NewSessionPaletteInsertion {
  readonly document: JSONContent;
  readonly text: string;
}

export interface NewSessionCommandInsertion extends NewSessionPaletteInsertion {
  readonly caret: number;
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

/** Replace an exact typed slash run without flattening the surrounding rich document. */
export function replaceNewSessionCommandDocument(
  document: unknown,
  activation: ComposerCommandActivation,
  item: ComposerPaletteItem
): NewSessionCommandInsertion | undefined {
  const normalized = normalizeComposerDocument(document);
  const currentText = composerDocumentPlainText(normalized);
  const replacement = replaceComposerCommandRun(currentText, activation, item.value);
  if (replacement === undefined) return undefined;
  const nextDocument = replaceComposerDocumentTextRange(
    normalized,
    activation.from,
    activation.to,
    replacement.replacement
  );
  if (nextDocument === undefined) return undefined;
  return {
    document: nextDocument,
    text: composerDocumentPlainText(nextDocument),
    caret: replacement.caret
  };
}
