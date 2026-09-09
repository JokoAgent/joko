import { unicodeCorpus } from "../i18n/test-corpus.js";
import { describe, expect, it } from "vitest";
import { parseSentMessageReferences, resolveTimelineReference } from "./timeline-references.js";

describe("timeline references", () => {
  it("restores task and project deep links from sent text", () => {
    expect(resolveTimelineReference("joko://app#/tasks/task-1?message=message-2&event=event-3", "current")).toEqual({
      kind: "session",
      href: "#/tasks/task-1?message=message-2&event=event-3",
      sessionId: "task-1",
      messageId: "message-2",
      eventId: "event-3"
    });
    expect(resolveTimelineReference("#/projects/project%2Fone", "current")).toEqual({
      kind: "project",
      href: "#/projects/project%2Fone",
      projectId: "project/one"
    });
  });

  it("maps canonical local files and source lines to document mode", () => {
    expect(resolveTimelineReference("./src/main.ts#L18", "task/one")).toEqual({
      kind: "workspace",
      href: "#/files/task%2Fone?file=src%2Fmain.ts&line=18",
      path: "src/main.ts",
      directory: false,
      line: 18
    });
    expect(resolveTimelineReference("../secret.txt", "task")).toBeUndefined();
    expect(resolveTimelineReference("file:///outside.txt", "task")).toBeUndefined();
    expect(resolveTimelineReference("main.ts:18:4", "task")).toMatchObject({ kind: "workspace", path: "main.ts", line: 18, column: 4 });
    expect(resolveTimelineReference("README.md:18", "task")).toMatchObject({ kind: "workspace", path: "README.md", line: 18 });
    expect(resolveTimelineReference("C:/outside.ts:18", "task")).toBeUndefined();
    expect(resolveTimelineReference("javascript:18", "task")).toBeUndefined();
  });

  it("recovers markdown, URLs, quoted paths, and bare file mentions without turning users into paths", () => {
    const segments = parseSentMessageReferences(
      'See [the task](#/tasks/task-2), https://example.test/x, @src/main.ts and @"docs/a b.md", but @owner stays text.',
      "task-1"
    );
    expect(segments.filter((segment) => segment.kind === "reference").map((segment) => segment.target.kind)).toEqual([
      "session",
      "external",
      "workspace",
      "workspace"
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe('See the task, https://example.test/x, @src/main.ts and @"docs/a b.md", but @owner stays text.');
    const prose = unicodeCorpus.mixedMarkdownLinks;
    const links = parseSentMessageReferences(prose, "task-1");
    expect(links.filter((segment) => segment.kind === "reference").map((segment) => segment.target.href)).toEqual([
      "https://example.test/foo", "https://other.test/y", "https://example.test/search?q=[a]", "https://example.test/x;"
    ]);
    expect(links.map((segment) => segment.text).join("")).toBe(unicodeCorpus.mixedMarkdownLinkLabels);
    const authored = parseSentMessageReferences("[query](https://example.test/search?q=(word)) https://example.test/Guns_N'_Roses @\"docs/notes;.md\"", "task-1");
    expect(authored.filter((segment) => segment.kind === "reference").map((segment) => segment.target.href)).toEqual([
      "https://example.test/search?q=(word)", "https://example.test/Guns_N'_Roses", "#/files/task-1?file=docs%2Fnotes%3B.md"
    ]);
    const escaped = parseSentMessageReferences(String.raw`[parentheses](https://example.test/a\(b\)) [semicolon](https://example.test/path\;) [letters](https://example.test/f\oo)`, "task-1");
    expect(escaped.filter((segment) => segment.kind === "reference").map((segment) => segment.target.href)).toEqual([
      "https://example.test/a(b)", "https://example.test/path;", "https://example.test/f/oo"
    ]);
    const nested = "https://example.test/(".repeat(100);
    expect(parseSentMessageReferences(nested, "task-1")).toEqual([{ kind: "text", text: nested }]);
  });
});
