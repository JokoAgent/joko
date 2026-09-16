import type { JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { forwardRef, useEffect, useImperativeHandle, useRef, type JSX } from "react";
import { composerDocumentIsEmpty, normalizeComposerDocument } from "../composer-quote-document.js";
import { composerDocumentContainsList } from "../composer-list-document.js";
import { clipboardAttachmentFiles } from "./composer-clipboard.js";
import { ComposerQuoteNode } from "./ComposerQuoteNode.js";
import {
  applyComposerPastedTextEdit,
  ComposerPastedTextNode,
  replaceComposerPastedTextWithPlainText,
  type ComposerPastedTextAttrs
} from "./ComposerPastedTextNode.js";
import {
  COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT,
  composerPathRelativeToWorkingDirectory,
  countComposerPasteLines,
  htmlCarriesComposerAtomMarkup,
  isComposerLongPaste,
  segmentComposerPaste,
  type ComposerPasteSegment
} from "./composer-paste-pipeline.js";
import { ComposerRouteReferenceNode, type ComposerRouteReferenceAttrs } from "./ComposerRouteReferenceNode.js";
import {
  resolveComposerRouteReferences,
  seedComposerRouteReference,
  type ComposerRouteReferenceResolver,
  type PendingComposerRouteReferenceResolution
} from "./composer-route-reference-resolution.js";
import { hasComposerInternalDrop, type ComposerInternalDropInsertion } from "./composer-internal-drop.js";
import { resolveComposerBlankFocusIntent } from "./composer-blank-focus.js";
import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
  handleStructuredListBackspace,
  handleStructuredListBreak,
  isTopLevelBlockSelection,
  isTrailingEmptyTopLevelParagraph,
  promoteTrailingPlainListParagraph
} from "./composer-list-nodes.js";
import { plainTextToComposerDocument } from "../composer-quote-document.js";
import { ComposerCjkPunctuationDecoration } from "./composer-cjk-punctuation.js";
import { createComposerMentionTransactionMapper, type ComposerMentionRangeMapper } from "../composer-mention-transaction.js";
import {
  clearComposerInternalDropCaret,
  clearComposerInternalDropCaretOn,
  ComposerInternalDropCaret,
  composerInternalDropCaretPosition,
  setComposerInternalDropCaret
} from "./composer-internal-drop-caret.js";
import {
  composerListNormalizationIsSkipped,
  skipComposerListNormalization
} from "./composer-list-normalization.js";

interface ComposerListNormalizationFence {
  compositionRepairGeneration: number;
  historyMicrotaskGeneration: number;
  historySuppressed: boolean;
}

export type ComposerRouteReferenceDropAction =
  | { readonly kind: "start" }
  | { readonly kind: "move"; readonly clientX: number; readonly clientY: number }
  | { readonly kind: "commit"; readonly clientX: number; readonly clientY: number; readonly insertion: ComposerInternalDropInsertion }
  | { readonly kind: "cancel" };

export interface ComposerRichTextEditorHandle {
  readonly focus: (position?: "start" | "end") => void;
  readonly focusFromBlankSurface: () => void;
  readonly editPastedText: (nodePosition: number, expectedText: string, nextText: string, display: string) => boolean;
  readonly insertRouteReference: (insertion: ComposerInternalDropInsertion) => boolean;
  readonly routeReferenceDrop: (action: ComposerRouteReferenceDropAction) => boolean;
}

export const ComposerRichTextEditor = forwardRef<ComposerRichTextEditorHandle, {
  readonly document: JSONContent;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onDocumentChange: (document: JSONContent, isComposing: boolean, rangeMapper: ComposerMentionRangeMapper) => void;
  readonly onKeyDown: (event: KeyboardEvent, document: JSONContent) => boolean;
  readonly onClipboardFiles: (files: readonly File[]) => void;
  readonly pastedTextLabel: (lines: number) => string;
  readonly onPastedTextOpen: (target: { readonly nodePosition: number; readonly text: string }) => void;
  readonly workingDirectory?: string;
  readonly knownWorkspacePaths?: readonly string[];
  readonly resolveRouteReference?: ComposerRouteReferenceResolver;
}>(function ComposerRichTextEditor({ document, editable, disabled, placeholder, onDocumentChange, onKeyDown, onClipboardFiles, pastedTextLabel, onPastedTextOpen, workingDirectory, knownWorkspacePaths = [], resolveRouteReference }, forwardedRef): JSX.Element {
  const pasteRuntimeRef = useRef({ editable, disabled, onClipboardFiles, pastedTextLabel, workingDirectory, knownWorkspacePaths, resolveRouteReference });
  const pendingMentionTransactionsRef = useRef<readonly Transaction[]>([]);
  const listNormalizationFenceRef = useRef<ComposerListNormalizationFence>({
    compositionRepairGeneration: 0,
    historyMicrotaskGeneration: 0,
    historySuppressed: false
  });
  pasteRuntimeRef.current = { editable, disabled, onClipboardFiles, pastedTextLabel, workingDirectory, knownWorkspacePaths, resolveRouteReference };
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editable: editable && !disabled,
    content: normalizeComposerDocument(document),
    extensions: [Document, Paragraph, Text, ComposerListItem, ComposerBulletList, ComposerOrderedList, HardBreak, History, ComposerQuoteNode, ComposerPastedTextNode, ComposerRouteReferenceNode, ComposerCjkPunctuationDecoration, ComposerInternalDropCaret],
    editorProps: {
      attributes: {
        class: "composer-rich-editor__content",
        "data-placeholder": placeholder,
        "aria-label": placeholder
      },
      handleKeyDown: (view, event) => {
        if (onKeyDown(event, view.state.doc.toJSON())) return true;
        if (event.isComposing) return false;
        if (event.key === "Enter" && handleStructuredListBreak(view)) {
          event.preventDefault();
          return true;
        }
        if (event.key === "Backspace" && handleStructuredListBackspace(view)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleClickOn: (_view, _position, node, nodePosition, _event, direct) => {
        if (!direct || node.type.name !== ComposerPastedTextNode.name) return false;
        onPastedTextOpen({ nodePosition, text: (node.attrs as ComposerPastedTextAttrs).text });
        return true;
      },
      handleDrop: (_view, event) => {
        if (event.dataTransfer === null || !hasComposerInternalDrop(event.dataTransfer)) return false;
        // The outer composer owns private in-app drops. Consume the native
        // editor fallback so its text/plain payload is not inserted as well.
        event.preventDefault();
        return true;
      },
      handleDOMEvents: {
        compositionend: (view) => {
          const repairGeneration = listNormalizationFenceRef.current.compositionRepairGeneration;
          const normalizationSuppressedAtCompositionEnd = listNormalizationFenceRef.current.historySuppressed;
          view.dom.ownerDocument.defaultView?.setTimeout(() => {
            if (normalizationSuppressedAtCompositionEnd || view.isDestroyed || view.composing
              || listNormalizationFenceRef.current.compositionRepairGeneration !== repairGeneration
              || listNormalizationFenceRef.current.historySuppressed) return;
            promoteTrailingPlainListParagraph(view);
          }, 0);
          return false;
        }
      },
      handlePaste: (view, event) => {
        const runtime = pasteRuntimeRef.current;
        if (!runtime.editable || runtime.disabled) return true;
        if (event.clipboardData === null) return false;
        const files = clipboardAttachmentFiles(event.clipboardData);
        if (files.length > 0) {
          event.preventDefault();
          runtime.onClipboardFiles(files);
          return true;
        }
        const html = event.clipboardData.getData("text/html");
        if (html !== "" && htmlCarriesComposerAtomMarkup(html)) return false;
        const text = event.clipboardData.getData("text/plain");
        if (text === "") return false;
        if (isComposerLongPaste(text)) {
          event.preventDefault();
          const node = view.state.schema.nodes[ComposerPastedTextNode.name]?.create({
            text,
            display: runtime.pastedTextLabel(countComposerPasteLines(text))
          });
          if (node === undefined) return false;
          view.dispatch(skipComposerListNormalization(view.state.tr.replaceSelectionWith(node)).scrollIntoView());
          return true;
        }
        const segments = segmentComposerPaste(text, { workingDirectory: runtime.workingDirectory });
        if (segments !== null) {
          const insertion = composerPasteNodes(view.state.schema, segments, runtime.workingDirectory, new Set(runtime.knownWorkspacePaths));
          if (insertion !== undefined) {
            event.preventDefault();
            view.dispatch(skipComposerListNormalization(
              view.state.tr.replaceSelection(new Slice(Fragment.from(insertion.nodes), 0, 0))
            ).scrollIntoView());
            resolveComposerRouteReferences(view, insertion.pending, runtime.resolveRouteReference);
            return true;
          }
        }
        const normalizedPaste = plainTextToComposerDocument(text);
        const trailingEmpty = isTrailingEmptyTopLevelParagraph(view);
        const blockSelection = isTopLevelBlockSelection(view);
        if (!composerDocumentContainsList(normalizedPaste) || (!trailingEmpty && !blockSelection)) return false;
        event.preventDefault();
        const { state } = view;
        const replacement = (normalizedPaste.content ?? []).map((node) => state.schema.nodeFromJSON(node));
        const fragment = Fragment.from(replacement);
        const transaction = trailingEmpty
          ? state.tr.replaceWith(state.selection.$from.before(1), state.selection.$from.before(1) + state.selection.$from.parent.nodeSize, fragment)
          : state.tr.replaceSelection(new Slice(fragment, 0, 0));
        if (trailingEmpty) transaction.setSelection(TextSelection.atEnd(transaction.doc));
        view.dispatch(transaction.scrollIntoView());
        return true;
      }
    },
    onCreate: ({ editor: activeEditor }) => setEditorEmptyAttribute(activeEditor.view.dom, activeEditor.getJSON()),
    onTransaction: ({ editor: activeEditor, transaction, appendedTransactions }) => {
      const documentTransactions = [transaction, ...appendedTransactions].filter((entry) => entry.docChanged);
      if (documentTransactions.length === 0) return;
      if (transaction.getMeta("preventUpdate")) {
        listNormalizationFenceRef.current.compositionRepairGeneration += 1;
        return;
      }
      // List promotion dispatches another update synchronously. Its mapping
      // starts after this transaction, while the parent still owns the old ranges.
      pendingMentionTransactionsRef.current = [...pendingMentionTransactionsRef.current, transaction, ...appendedTransactions];
      const historyChange = documentTransactions.some((entry) => isHistoryTransaction(entry));
      if (historyChange) suppressComposerListNormalizationThroughOwnerMicrotask(activeEditor.view, listNormalizationFenceRef.current);
      const normalizationSkipped = documentTransactions.some((entry) => composerListNormalizationIsSkipped(entry));
      if (historyChange || normalizationSkipped) listNormalizationFenceRef.current.compositionRepairGeneration += 1;
      if (!normalizationSkipped && !listNormalizationFenceRef.current.historySuppressed
        && !historyChange && !activeEditor.view.composing && promoteTrailingPlainListParagraph(activeEditor.view)) return;
      const next = normalizeComposerDocument(activeEditor.getJSON());
      const rangeMapper = createComposerMentionTransactionMapper(pendingMentionTransactionsRef.current);
      pendingMentionTransactionsRef.current = [];
      setEditorEmptyAttribute(activeEditor.view.dom, next);
      onDocumentChange(next, activeEditor.view.composing, rangeMapper);
    }
  });

  useImperativeHandle(forwardedRef, () => ({
    focus: (position = "end") => { editor?.commands.focus(position); },
    focusFromBlankSurface: () => {
      if (editor === null) return;
      const intent = resolveComposerBlankFocusIntent({
        isDestroyed: editor.isDestroyed,
        isEditable: editor.isEditable,
        isFocused: editor.isFocused,
        caretAtDocStart: editor.state.selection.empty && editor.state.selection.from === TextSelection.atStart(editor.state.doc).from
      });
      if (intent === "keep-caret") editor.commands.focus();
      else if (intent === "doc-end") editor.commands.focus("end");
    },
    insertRouteReference: (insertion) => {
      if (editor === null || editor.isDestroyed || !pasteRuntimeRef.current.editable || pasteRuntimeRef.current.disabled) return false;
      return insertComposerRouteReference(editor.view, insertion, editor.state.selection.from, pasteRuntimeRef.current.resolveRouteReference, true);
    },
    routeReferenceDrop: (action) => {
      if (editor === null || editor.isDestroyed) return false;
      if (action.kind === "cancel") {
        clearComposerInternalDropCaret(editor.view);
        return true;
      }
      if (!pasteRuntimeRef.current.editable || pasteRuntimeRef.current.disabled || !editor.isEditable) {
        clearComposerInternalDropCaret(editor.view);
        return false;
      }
      if (action.kind === "start") {
        if (composerInternalDropCaretPosition(editor.state) !== undefined) return true;
        const position = composerRouteReferenceInsertionPosition(editor.state, editor.state.selection.from);
        if (position === undefined) return false;
        setComposerInternalDropCaret(editor.view, position);
        return true;
      }
      const fallbackPosition = composerInternalDropCaretPosition(editor.state);
      if (fallbackPosition === undefined) return false;
      const coordinatePosition = composerRouteReferencePositionAtCoordinates(editor.view, action.clientX, action.clientY);
      if (action.kind === "move") {
        if (coordinatePosition !== undefined && coordinatePosition !== fallbackPosition) {
          setComposerInternalDropCaret(editor.view, coordinatePosition);
        }
        return true;
      }
      const position = coordinatePosition ?? fallbackPosition;
      return insertComposerRouteReference(editor.view, action.insertion, position, pasteRuntimeRef.current.resolveRouteReference);
    },
    editPastedText: (nodePosition, expectedText, nextText, display) => {
      if (editor === null) return false;
      if (nextText.length > COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT) {
        return replaceComposerPastedTextWithPlainText(editor, nodePosition, expectedText, nextText);
      }
      return applyComposerPastedTextEdit(editor, nodePosition, expectedText, nextText === "" ? null : { text: nextText, display });
    }
  }), [editor]);

  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.setEditable(editable && !disabled);
    if (!editable || disabled) clearComposerInternalDropCaret(editor.view);
  }, [disabled, editable, editor]);

  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    const normalized = normalizeComposerDocument(document);
    // Compare canonical documents because TipTap eagerly materializes nullable
    // schema defaults (for example sourceEventId: null). Comparing raw JSON
    // would setContent after every keystroke and move the caret around atoms.
    if (JSON.stringify(normalizeComposerDocument(editor.getJSON())) === JSON.stringify(normalized)) return;
    pendingMentionTransactionsRef.current = [];
    editor.commands.setContent(normalized, { emitUpdate: false });
    setEditorEmptyAttribute(editor.view.dom, normalized);
  }, [document, editor]);

  return (
    <EditorContent
      editor={editor}
      className="composer-rich-editor"
      data-composer-editor="true"
      data-disabled={disabled ? "true" : undefined}
    />
  );
});

function composerRouteReferenceInsertionPosition(state: EditorState, requestedPosition: number): number | undefined {
  const routeType = state.schema.nodes[ComposerRouteReferenceNode.name];
  if (routeType === undefined || !Number.isFinite(requestedPosition)) return undefined;
  const boundedPosition = Math.max(0, Math.min(Math.trunc(requestedPosition), state.doc.content.size));
  return insertPoint(state.doc, boundedPosition, routeType) ?? undefined;
}

function composerRouteReferencePositionAtCoordinates(view: EditorView, clientX: number, clientY: number): number | undefined {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return undefined;
  try {
    const coordinates = view.posAtCoords({ left: clientX, top: clientY });
    return coordinates === null
      ? undefined
      : composerRouteReferenceInsertionPosition(view.state, coordinates.pos);
  } catch {
    return undefined;
  }
}

function insertComposerRouteReference(
  view: EditorView,
  insertion: ComposerInternalDropInsertion,
  requestedPosition: number,
  resolver: ComposerRouteReferenceResolver | undefined,
  replaceSelection = false
): boolean {
  if (view.isDestroyed) return false;
  const routeType = view.state.schema.nodes[ComposerRouteReferenceNode.name];
  const position = replaceSelection
    ? view.state.selection.from
    : composerRouteReferenceInsertionPosition(view.state, requestedPosition);
  if (routeType === undefined || position === undefined) {
    clearComposerInternalDropCaret(view);
    return false;
  }
  try {
    const node = routeType.create(insertion.attrs);
    const transaction = skipComposerListNormalization(view.state.tr);
    if (replaceSelection) {
      transaction.replaceSelectionWith(node);
    } else {
      transaction.insert(position, node);
      transaction.setSelection(Selection.near(transaction.doc.resolve(position + node.nodeSize), 1));
    }
    clearComposerInternalDropCaretOn(transaction);
    view.dispatch(transaction.scrollIntoView());
  } catch {
    clearComposerInternalDropCaret(view);
    return false;
  }
  if (insertion.pending !== undefined) {
    try {
      resolveComposerRouteReferences(view, [insertion.pending], resolver);
    } catch {
      // Enrichment failure must not undo or duplicate the committed atom.
    }
  }
  try { view.focus(); } catch { /* The committed document remains authoritative if its DOM retires. */ }
  return true;
}

function suppressComposerListNormalizationThroughOwnerMicrotask(
  view: EditorView,
  fence: ComposerListNormalizationFence
): void {
  const ownerWindow = view.dom.ownerDocument.defaultView;
  if (ownerWindow === null) return;
  const generation = fence.historyMicrotaskGeneration + 1;
  fence.historyMicrotaskGeneration = generation;
  fence.historySuppressed = true;
  ownerWindow.queueMicrotask(() => {
    if (fence.historyMicrotaskGeneration === generation) fence.historySuppressed = false;
  });
}

function setEditorEmptyAttribute(element: HTMLElement, document: JSONContent): void {
  element.dataset["empty"] = composerDocumentIsEmpty(document) ? "true" : "false";
}

function composerPasteNodes(
  schema: Parameters<typeof Fragment.fromJSON>[0],
  segments: readonly ComposerPasteSegment[],
  workingDirectory: string | undefined,
  knownWorkspacePaths: ReadonlySet<string>
): { readonly nodes: readonly import("@tiptap/pm/model").Node[]; readonly pending: readonly PendingComposerRouteReferenceResolution[] } | undefined {
  const routeType = schema.nodes[ComposerRouteReferenceNode.name];
  const hardBreak = schema.nodes["hardBreak"];
  if (routeType === undefined || hardBreak === undefined) return undefined;
  const nodes: import("@tiptap/pm/model").Node[] = [];
  const pending: PendingComposerRouteReferenceResolution[] = [];
  const appendText = (value: string): void => {
    value.replace(/\r\n?/gu, "\n").split("\n").forEach((line, index) => {
      if (index > 0) nodes.push(hardBreak.create());
      if (line !== "") nodes.push(schema.text(line));
    });
  };
  for (const segment of segments) {
    if (segment.kind === "text") {
      appendText(segment.text);
      continue;
    }
    if (segment.kind === "path") {
      if (workingDirectory === undefined || workingDirectory === "") {
        appendText(segment.path);
        continue;
      }
      const relative = composerPathRelativeToWorkingDirectory(segment.path, workingDirectory);
      if (!knownWorkspacePaths.has(relative)) {
        appendText(segment.path);
        continue;
      }
      nodes.push(routeType.create({ kind: "path", display: relative, serialized: `@${relative}`, reference: relative } satisfies ComposerRouteReferenceAttrs));
      continue;
    }
    const seeded = seedComposerRouteReference(segment);
    nodes.push(routeType.create(seeded.attrs));
    if (seeded.pending !== undefined) pending.push(seeded.pending);
  }
  return nodes.length === 0 ? undefined : { nodes, pending };
}
