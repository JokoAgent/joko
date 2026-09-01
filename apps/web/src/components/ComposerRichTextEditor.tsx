import type { JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
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

export interface ComposerRichTextEditorHandle {
  readonly focus: (position?: "start" | "end") => void;
  readonly focusFromBlankSurface: () => void;
  readonly editPastedText: (nodePosition: number, expectedText: string, nextText: string, display: string) => boolean;
  readonly insertRouteReference: (insertion: ComposerInternalDropInsertion) => boolean;
}

export const ComposerRichTextEditor = forwardRef<ComposerRichTextEditorHandle, {
  readonly document: JSONContent;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onDocumentChange: (document: JSONContent, isComposing: boolean) => void;
  readonly onKeyDown: (event: KeyboardEvent, document: JSONContent) => boolean;
  readonly onClipboardFiles: (files: readonly File[]) => void;
  readonly pastedTextLabel: (lines: number) => string;
  readonly onPastedTextOpen: (target: { readonly nodePosition: number; readonly text: string }) => void;
  readonly workingDirectory?: string;
  readonly knownWorkspacePaths?: readonly string[];
  readonly resolveRouteReference?: ComposerRouteReferenceResolver;
}>(function ComposerRichTextEditor({ document, editable, disabled, placeholder, onDocumentChange, onKeyDown, onClipboardFiles, pastedTextLabel, onPastedTextOpen, workingDirectory, knownWorkspacePaths = [], resolveRouteReference }, forwardedRef): JSX.Element {
  const pasteRuntimeRef = useRef({ editable, disabled, onClipboardFiles, pastedTextLabel, workingDirectory, knownWorkspacePaths, resolveRouteReference });
  pasteRuntimeRef.current = { editable, disabled, onClipboardFiles, pastedTextLabel, workingDirectory, knownWorkspacePaths, resolveRouteReference };
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editable: editable && !disabled,
    content: normalizeComposerDocument(document),
    extensions: [Document, Paragraph, Text, ComposerListItem, ComposerBulletList, ComposerOrderedList, HardBreak, History, ComposerQuoteNode, ComposerPastedTextNode, ComposerRouteReferenceNode, ComposerCjkPunctuationDecoration],
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
          window.setTimeout(() => {
            if (!view.isDestroyed && !view.composing) promoteTrailingPlainListParagraph(view);
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
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
          return true;
        }
        const segments = segmentComposerPaste(text, { workingDirectory: runtime.workingDirectory });
        if (segments !== null) {
          const insertion = composerPasteNodes(view.state.schema, segments, runtime.workingDirectory, new Set(runtime.knownWorkspacePaths));
          if (insertion !== undefined) {
            event.preventDefault();
            view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(insertion.nodes), 0, 0)).scrollIntoView());
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
    onUpdate: ({ editor: activeEditor }) => {
      if (!activeEditor.view.composing && promoteTrailingPlainListParagraph(activeEditor.view)) return;
      const next = normalizeComposerDocument(activeEditor.getJSON());
      setEditorEmptyAttribute(activeEditor.view.dom, next);
      onDocumentChange(next, activeEditor.view.composing);
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
      const routeType = editor.state.schema.nodes[ComposerRouteReferenceNode.name];
      if (routeType === undefined) return false;
      editor.view.dispatch(editor.state.tr.replaceSelectionWith(routeType.create(insertion.attrs)).scrollIntoView());
      if (insertion.pending !== undefined) {
        resolveComposerRouteReferences(editor.view, [insertion.pending], pasteRuntimeRef.current.resolveRouteReference);
      }
      editor.commands.focus();
      return true;
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
  }, [disabled, editable, editor]);

  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    const normalized = normalizeComposerDocument(document);
    // Compare canonical documents because TipTap eagerly materializes nullable
    // schema defaults (for example sourceEventId: null). Comparing raw JSON
    // would setContent after every keystroke and move the caret around atoms.
    if (JSON.stringify(normalizeComposerDocument(editor.getJSON())) === JSON.stringify(normalized)) return;
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
