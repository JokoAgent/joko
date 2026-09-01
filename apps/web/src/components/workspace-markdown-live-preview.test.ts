import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  classifyWorkspaceMarkdownLine,
  computeWorkspaceMarkdownFenceLines,
  inlineMarkdownMarkerRanges,
  mutateWorkspaceMarkdownTable,
  parseWorkspaceMarkdownTable,
  renderedOffsetToSourceOffset,
  serializeWorkspaceMarkdownTable,
  sourceOffsetToRenderedOffset,
  toggleWorkspaceMarkdownStrongText,
  workspaceMarkdownSlashTableInsertion,
  workspaceMarkdownTableCellBreak,
  workspaceMarkdownTableInsertion,
  workspaceMarkdownTableShortcutAction
} from "./workspace-markdown-live-preview.js";

describe("workspace Markdown live preview", () => {
  it("classifies line chrome while retaining exact source offsets", () => {
    expect(classifyWorkspaceMarkdownLine("## Heading")).toMatchObject({ kind: "heading", level: 2, prefixFrom: 0, prefixTo: 3 });
    expect(classifyWorkspaceMarkdownLine("  - item")).toMatchObject({ kind: "bullet", prefixFrom: 2, prefixTo: 4 });
    expect(classifyWorkspaceMarkdownLine("1. ordered")).toMatchObject({ kind: "ordered", marker: "1. ", prefixTo: 3 });
    expect(classifyWorkspaceMarkdownLine("- [x] done")).toMatchObject({ kind: "task", marker: "checked", prefixTo: 6 });
    expect(classifyWorkspaceMarkdownLine("> quote")).toMatchObject({ kind: "quote", prefixTo: 2 });
    expect(classifyWorkspaceMarkdownLine("---")).toMatchObject({ kind: "horizontal-rule", prefixFrom: 0, prefixTo: 3 });
  });

  it("conceals paired inline markers without overlapping strong and emphasis", () => {
    expect(inlineMarkdownMarkerRanges("**bold** and `code` and _em_")).toEqual([
      { from: 0, to: 2 },
      { from: 6, to: 8 },
      { from: 13, to: 14 },
      { from: 18, to: 19 },
      { from: 24, to: 25 },
      { from: 27, to: 28 }
    ]);
  });

  it("marks closed fence rows and leaves an unfinished fence conservative", () => {
    expect([...computeWorkspaceMarkdownFenceLines(Text.of(["```ts", "- source", "```"]))]).toEqual([
      [1, "first"],
      [2, "body"],
      [3, "last"]
    ]);
    expect([...computeWorkspaceMarkdownFenceLines(Text.of(["before", "```", "unfinished"]))]).toEqual([]);
  });
});

describe("workspace Markdown table model", () => {
  const source = "| Name | Value |\n| :--- | ---: |\n| one | two |";

  it("parses alignment and serializes a source-preserving table model", () => {
    const table = parseWorkspaceMarkdownTable(source);
    expect(table).not.toBeNull();
    expect(table?.header).toEqual(["Name", "Value"]);
    expect(table?.alignments).toEqual(["left", "right"]);
    expect(table?.rows).toEqual([["one", "two"]]);
    expect(serializeWorkspaceMarkdownTable(table!)).toBe("| Name | Value |\n| :--- | ----: |\n| one  | two   |");
  });

  it("supports every row and column structure action with a two-column floor", () => {
    const table = parseWorkspaceMarkdownTable(source)!;
    expect(mutateWorkspaceMarkdownTable(table, "add-row-above", 1, 0)?.rows).toEqual([["", ""], ["one", "two"]]);
    expect(mutateWorkspaceMarkdownTable(table, "add-row-below", 1, 0)?.rows).toEqual([["one", "two"], ["", ""]]);
    expect(mutateWorkspaceMarkdownTable(table, "delete-row", 1, 0)?.rows).toEqual([]);
    expect(mutateWorkspaceMarkdownTable(table, "delete-row", 0, 0)).toBeNull();

    const withLeft = mutateWorkspaceMarkdownTable(table, "add-column-left", 1, 1)!;
    expect(withLeft.header).toEqual(["Name", "", "Value"]);
    const withRight = mutateWorkspaceMarkdownTable(table, "add-column-right", 1, 0)!;
    expect(withRight.header).toEqual(["Name", "", "Value"]);
    expect(mutateWorkspaceMarkdownTable(table, "delete-column", 1, 0)).toBeNull();
    expect(mutateWorkspaceMarkdownTable(withRight, "delete-column", 1, 1)?.header).toEqual(["Name", "Value"]);
  });

  it("inserts the default table by replacing an empty line or appending after text", () => {
    const emptyLine = workspaceMarkdownTableInsertion("before\n\nafter", 7);
    expect(emptyLine.from).toBe(7);
    expect(emptyLine.to).toBe(7);
    expect(emptyLine.insert).toContain("| Header 1 | Header 2 |");

    const afterText = workspaceMarkdownTableInsertion("before", 3);
    expect(afterText).toMatchObject({ from: 6, to: 6 });
    expect(afterText.insert.startsWith("\n| Header 1")).toBe(true);
  });

  it("only expands a sole /table line on Enter and keeps neighboring tables separated", () => {
    expect(workspaceMarkdownSlashTableInsertion("before\n/table\nafter", 10)).toMatchObject({
      from: 7,
      to: 13
    });
    expect(workspaceMarkdownSlashTableInsertion("before /table", 12)).toBeNull();
    expect(workspaceMarkdownSlashTableInsertion("/table later", 2)).toBeNull();
    expect(workspaceMarkdownTableInsertion("| a | b |\n\n| c | d |", 10).insert).toMatch(/^\n\| Header 1[\s\S]*\n$/u);
  });

  it("retains source widths for deterministic column resize serialization", () => {
    const table = parseWorkspaceMarkdownTable("| A | Description |\n| --- | -------: |\n| x | long value |")!;
    expect(table.sourceWidths).toEqual([5, 10]);
    expect(serializeWorkspaceMarkdownTable(table, [5, 14])).toContain("| A     | Description    |");
    expect(table.headerSources?.[0]).toEqual({ from: 2, to: 3 });
  });
});

describe("workspace Markdown inline table editing", () => {
  it("uses the platform-specific primary modifier for cell shortcuts", () => {
    const key = (overrides: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {}) => ({
      key: "b",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides
    });
    expect(workspaceMarkdownTableShortcutAction(key({ metaKey: true }), true)).toBe("bold");
    expect(workspaceMarkdownTableShortcutAction(key({ ctrlKey: true }), true)).toBeUndefined();
    expect(workspaceMarkdownTableShortcutAction(key({ ctrlKey: true }), false)).toBe("bold");
    expect(workspaceMarkdownTableShortcutAction(key({ metaKey: true }), false)).toBeUndefined();
    expect(workspaceMarkdownTableShortcutAction(key({ key: "z", metaKey: true, shiftKey: true }), true)).toBe("redo");
    expect(workspaceMarkdownTableShortcutAction(key({ key: "y", ctrlKey: true }), false)).toBe("redo");
    expect(workspaceMarkdownTableShortcutAction(key({ key: "Enter", metaKey: true }), true)).toBe("break");
    expect(workspaceMarkdownTableShortcutAction(key({ key: "Enter", shiftKey: true }), false)).toBe("break");
  });

  it("maps concealed and revealed strong/code offsets without moving the caret", () => {
    const strong = "**bold**";
    expect(sourceOffsetToRenderedOffset(strong, 4, [])).toBe(2);
    expect(renderedOffsetToSourceOffset(strong, 2, [])).toBe(4);
    expect(sourceOffsetToRenderedOffset(strong, 8, [{ from: 0, to: 8 }])).toBe(8);
    expect(renderedOffsetToSourceOffset("a<br>z", 2, [])).toBe(5);
    expect(sourceOffsetToRenderedOffset("a<br>z", 5, [])).toBe(2);
  });

  it("toggles Mod+B around a selection, current word, existing strong range, or empty caret", () => {
    expect(toggleWorkspaceMarkdownStrongText("one two", 4, 7)).toEqual({ text: "one **two**", from: 6, to: 9 });
    expect(toggleWorkspaceMarkdownStrongText("one two", 5, 5)).toEqual({ text: "one **two**", from: 6, to: 9 });
    expect(toggleWorkspaceMarkdownStrongText("one **two**", 7, 7)).toEqual({ text: "one two", from: 5, to: 5 });
    expect(toggleWorkspaceMarkdownStrongText(" ", 1, 1)).toEqual({ text: " ****", from: 3, to: 3 });
  });

  it("serializes a table soft break as one Markdown <br> token", () => {
    expect(workspaceMarkdownTableCellBreak("before selected after", 7, 15)).toEqual({
      text: "before <br> after",
      offset: 11
    });
  });
});
