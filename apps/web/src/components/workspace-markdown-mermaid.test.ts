import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { findWorkspaceMarkdownMermaidBlocks } from "./workspace-markdown-mermaid.js";

function documentOf(...lines: string[]): Text {
  return Text.of(lines);
}

describe("workspace markdown Mermaid discovery", () => {
  it("recognizes both CommonMark fence characters and optional attributes", () => {
    const blocks = findWorkspaceMarkdownMermaidBlocks(documentOf(
      "```mermaid title=flow", "graph TD", "A-->B", "```", "", "~~~ mermaid", "sequenceDiagram", "~~~"
    ));
    expect(blocks.map((block) => block.source)).toEqual(["graph TD\nA-->B", "sequenceDiagram"]);
  });

  it("requires a matching fence character with at least the opener length", () => {
    expect(findWorkspaceMarkdownMermaidBlocks(documentOf("````mermaid", "graph TD", "```"))).toHaveLength(0);
    expect(findWorkspaceMarkdownMermaidBlocks(documentOf("````mermaid", "graph TD", "`````"))).toHaveLength(1);
    expect(findWorkspaceMarkdownMermaidBlocks(documentOf("~~~mermaid", "graph TD", "```"))).toHaveLength(0);
  });

  it("does not render Mermaid examples nested in another fenced block", () => {
    const blocks = findWorkspaceMarkdownMermaidBlocks(documentOf(
      "````markdown", "```mermaid", "graph TD", "```", "````", "```mermaid", "A-->B", "```"
    ));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.source).toBe("A-->B");
  });

  it("leaves incomplete and invalidly indented fences as source", () => {
    expect(findWorkspaceMarkdownMermaidBlocks(documentOf("```mermaid", "graph TD"))).toEqual([]);
    expect(findWorkspaceMarkdownMermaidBlocks(documentOf("    ```mermaid", "graph TD", "    ```"))).toEqual([]);
    expect(findWorkspaceMarkdownMermaidBlocks(documentOf("```mermaidx", "graph TD", "```"))).toEqual([]);
  });

  it("returns a body-only replacement range that preserves both fences", () => {
    const doc = documentOf("before", "```mermaid", "graph TD", "A-->B", "```", "after");
    const block = findWorkspaceMarkdownMermaidBlocks(doc)[0]!;
    expect(doc.sliceString(block.from, block.to)).toBe("```mermaid\ngraph TD\nA-->B\n```");
    expect(doc.sliceString(block.bodyFrom, block.bodyTo)).toBe("graph TD\nA-->B\n");
  });
});
