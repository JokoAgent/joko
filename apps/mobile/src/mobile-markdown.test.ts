import { describe, expect, it } from "vitest";
import { groupMobileMarkdownSelectableBlocks, parseMobileMarkdown, parseMobileMarkdownIncremental } from "./mobile-markdown";
import { mobileCodeHighlight } from "./mobile-code-highlight";

describe("mobile Markdown presentation", () => {
  it("reuses completed streaming blocks while preserving code, CJK link boundaries and structured content", () => {
    const prefix = "# 标题\n\n**重点** 与 https://example.test/path（说明）。\n\n";
    const first = parseMobileMarkdownIncremental(prefix, null);
    const appended = parseMobileMarkdownIncremental(prefix + "- [x] 已完成\n\n| 字段 | 值 |\n| --- | --- |\n| 名称 | `Joko` |\n\n```ts\nconst text = '<tag>&';\n```\n\n\\[x^2 + y^2\\]\n\n```mermaid\ngraph TD; A-->B\n```", first);
    expect(appended.incremental).toBe(true);
    expect(appended.blocks[0]).toBe(first.blocks[0]);
    expect(appended.blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list_item", "table", "code", "math", "mermaid"]);
    const paragraph = appended.blocks[1];
    expect(paragraph?.type === "paragraph" && paragraph.inlines).toEqual(expect.arrayContaining([
      { type: "strong", text: "重点" },
      { type: "link", text: "https://example.test/path", url: "https://example.test/path" }
    ]));
    expect(appended.blocks.find((block) => block.type === "code")).toMatchObject({ text: "const text = '<tag>&';", language: "ts" });
    const edited = parseMobileMarkdownIncremental("Changed\n\n" + prefix, appended);
    expect(edited.incremental).toBe(false);
    expect(edited.blocks[0]).not.toBe(first.blocks[0]);
  });

  it("keeps exact source through syntax highlighting and bounds selectable text runs without dropping text", () => {
    const code = 'const message = "<script>&雪"; // original\n';
    const runs = mobileCodeHighlight(code, "typescript");
    expect(runs.map((run) => run.text).join("")).toBe(code);
    expect(runs.some((run) => run.kind?.includes("keyword"))).toBe(true);
    expect(mobileCodeHighlight(code, "unknown-language")).toEqual([{ text: code }]);
    const blocks = parseMobileMarkdown(Array.from({ length: 80 }, (_, index) => `段落 ${index}`).join("\n\n"));
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunBlocks: 10, maxTextRunUtf16Length: 100 });
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flatMap((group) => group.type === "text_run" ? group.blocks : [group.block])).toHaveLength(80);
    expect(parseMobileMarkdown("[Read](javascript:alert(1)) ![no](file:///private/key)")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]));
  });
});
