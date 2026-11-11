// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { readSelectionInStream } from "./SelectionQuoteButton.js";
import {
  normalizeWorkspaceFileSource,
  WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS,
  workspaceFileQuoteFromOffsets
} from "./workspace-file-selection.js";
import { DEFAULT_WORKSPACE_MARKDOWN_TABLE_LABELS, workspaceMarkdownLivePreviewExtensions } from "./workspace-markdown-live-preview.js";

describe("workspace file selection quotes", () => {
  it.each([false, true])("quotes a live table selection independently of the source selection (readOnly=%s)", (readOnly) => {
    const source = "  OLD\n\n| Name | Value |\n| --- | --- |\n| Actual CELL | one |";
    const container = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({ parent: container, state: EditorState.create({
      doc: source,
      extensions: [
        ...workspaceMarkdownLivePreviewExtensions(DEFAULT_WORKSPACE_MARKDOWN_TABLE_LABELS),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)
      ]
    }) });
    const selection = window.getSelection()!;
    const selectText = (node: Node, anchor: number, head: number): void => {
      selection.setBaseAndExtent(node, anchor, node, head);
      Object.defineProperty(selection.getRangeAt(0), "getClientRects", { value: () => [new DOMRect(160, 120, 38, 16)] });
    };
    const sourceSelection = () => {
      const { anchor, head } = view.state.selection.main;
      return workspaceFileQuoteFromOffsets(view.state.doc.toString(), anchor, head);
    };
    const options = {
      sourcePath: "docs/table.md",
      getQuoteText: () => sourceSelection()?.text ?? null,
      getQuoteMetadata: () => {
        const quote = sourceSelection();
        return quote === undefined ? null : { startLine: quote.startLine, endLine: quote.endLine };
      }
    };
    try {
      const cellText = container.querySelector("tbody td")!.firstChild!;
      expect(cellText.textContent).toBe("Actual CELL");
      const expected = { kind: "file", sessionId: "task", sourcePath: "docs/table.md", text: "CELL" };
      expect(sourceSelection()).toBeUndefined();
      selectText(cellText, 7, 11);
      expect(readSelectionInStream("task", container, false, options)?.quote).toMatchObject(expected);

      view.dispatch({ selection: { anchor: 0, head: 5 } });
      expect(sourceSelection()?.text).toBe("  OLD");
      selectText(cellText, 11, 7);
      const quote = readSelectionInStream("task", container, true, options)?.quote;
      expect(quote).toMatchObject(expected);
      expect(quote).not.toHaveProperty("startLine");
      expect(quote).not.toHaveProperty("endLine");
      expect(readSelectionInStream("task", document.createElement("div"), false, options)).toBeUndefined();

      const sourceText = container.querySelector(".cm-line")!.firstChild!;
      selectText(sourceText, 2, 5);
      expect(readSelectionInStream("task", container, false, options)?.quote)
        .toMatchObject({ ...expected, text: "  OLD", startLine: 1, endLine: 1 });
    } finally {
      selection.removeAllRanges();
      view.destroy();
      container.remove();
    }
  });

  it("preserves indentation and internal blank lines with a closed line range", () => {
    const source = "before\n    first\n\n      third\nafter";
    const start = source.indexOf("    first");
    const end = source.indexOf("\nafter");
    expect(workspaceFileQuoteFromOffsets(source, start, end)).toEqual({
      text: "    first\n\n      third",
      startLine: 2,
      endLine: 4
    });
  });

  it("handles reverse selections and removes only outer newlines", () => {
    const source = "zero\n\n  one\n two\n\nlast";
    const start = source.indexOf("\n\n  one");
    const end = source.lastIndexOf("\nlast") + 1;
    expect(workspaceFileQuoteFromOffsets(source, end, start)).toEqual({
      text: "  one\n two",
      startLine: 3,
      endLine: 4
    });
  });

  it("attributes a selection ending at the next line's column zero to the preceding line", () => {
    const source = "alpha\nbeta\ngamma";
    expect(workspaceFileQuoteFromOffsets(source, 0, source.indexOf("beta"))).toEqual({
      text: "alpha",
      startLine: 1,
      endLine: 1
    });
  });

  it("rejects newline-only, whitespace-only, collapsed, and invalid offsets", () => {
    expect(workspaceFileQuoteFromOffsets("a\n\nb", 1, 3)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("a   b", 1, 4)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("text", 2, 2)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("text", -1, 2)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("text", 0, 8)).toBeUndefined();
  });

  it("normalizes CRLF before applying DOM-equivalent UTF-16 offsets", () => {
    const source = normalizeWorkspaceFileSource("first\r\nsecond\rthird");
    expect(source).toBe("first\nsecond\nthird");
    expect(workspaceFileQuoteFromOffsets(source, 6, 12)).toEqual({
      text: "second",
      startLine: 2,
      endLine: 2
    });
  });

  it("truncates only the visible text while preserving the complete selection range", () => {
    const source = `${"x".repeat(WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS + 20)}\nlast`;
    const quote = workspaceFileQuoteFromOffsets(source, 0, source.length);
    expect(quote?.text).toBe(`${"x".repeat(WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS)}…`);
    expect(quote?.startLine).toBe(1);
    expect(quote?.endLine).toBe(2);
  });
});
