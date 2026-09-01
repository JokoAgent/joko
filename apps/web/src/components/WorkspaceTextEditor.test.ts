import { describe, expect, it } from "vitest";
import {
  WORKSPACE_LARGE_DOCUMENT_CHARS,
  clampEditorLine,
  workspaceEditorChrome,
  workspaceEditorDegradation,
  workspaceEditorLanguageId,
  workspaceEditorSelection
} from "./WorkspaceTextEditor.js";

describe("WorkspaceTextEditor helpers", () => {
  it.each([
    ["src/App.tsx", undefined, "tsx"],
    ["src/main.rs", "text", "rust"],
    ["schema.sql", undefined, "sql"],
    ["config", "yaml", "yaml"],
    ["Makefile", undefined, "makefile"],
    ["Dockerfile", undefined, "dockerfile"],
    ["docs/guide.markdown", undefined, "markdown"],
    ["scripts/build.ps1", undefined, "powershell"],
    ["schema/message.proto", undefined, "protobuf"],
    ["ui/Card.vue", undefined, "xml"],
    ["ui/Card.svelte", undefined, "xml"],
    ["styles/theme.sass", undefined, "css"],
    ["schema/query.graphql", undefined, "graphql"],
    ["schema/query.gql", undefined, "graphql"],
    ["build/rules.mk", undefined, "makefile"],
    ["scripts/build.sc", undefined, "scala"]
  ])("selects the editor language for %s", (path, language, expected) => {
    expect(workspaceEditorLanguageId(path, language)).toBe(expected);
  });

  it("selects code, Markdown, and plain visual chrome", () => {
    expect(workspaceEditorChrome("typescript")).toBe("code");
    expect(workspaceEditorChrome("markdown")).toBe("markdown");
    expect(workspaceEditorChrome("text")).toBe("plain");
    expect(workspaceEditorChrome(undefined)).toBe("plain");
  });

  it("only disables highlighting and long-line wrapping at large-document thresholds", () => {
    expect(workspaceEditorDegradation("x".repeat(WORKSPACE_LARGE_DOCUMENT_CHARS))).toEqual({
      largeDocument: false,
      longLine: false
    });
    expect(workspaceEditorDegradation(`x\n${"y".repeat(WORKSPACE_LARGE_DOCUMENT_CHARS)}`)).toEqual({
      largeDocument: true,
      longLine: true
    });
    expect(workspaceEditorDegradation(`${"short\n".repeat(44_000)}`)).toEqual({
      largeDocument: true,
      longLine: false
    });
  });

  it("returns source offsets and a closed line range for forward and reverse selections", () => {
    const text = "one\ntwo\nthree\n";
    expect(workspaceEditorSelection(text, 1, 8)).toEqual({
      from: 1,
      to: 8,
      text: "ne\ntwo",
      startLine: 1,
      endLine: 2
    });
    expect(workspaceEditorSelection(text, 8, 1)).toEqual(workspaceEditorSelection(text, 1, 8));
  });

  it("rejects collapsed and whitespace-only selections", () => {
    expect(workspaceEditorSelection("abc", 1, 1)).toBeUndefined();
    expect(workspaceEditorSelection("a  b", 1, 3)).toBeUndefined();
  });

  it("uses the file-quote normalization for outer newlines and indentation", () => {
    const text = "before\n\n    first\n      second\n\nafter";
    expect(workspaceEditorSelection(text, 6, text.indexOf("after"))).toEqual({
      from: 6,
      to: text.indexOf("after"),
      text: "    first\n      second",
      startLine: 3,
      endLine: 4
    });
  });

  it("clamps one-shot line jumps to the current CodeMirror document", () => {
    expect(clampEditorLine(12, -4)).toBe(1);
    expect(clampEditorLine(12, 8.9)).toBe(8);
    expect(clampEditorLine(12, 99)).toBe(12);
    expect(clampEditorLine(0, Number.NaN)).toBe(1);
  });
});
