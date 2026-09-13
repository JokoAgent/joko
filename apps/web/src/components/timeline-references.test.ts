import { unicodeCorpus } from "../i18n/test-corpus.js";
import { describe, expect, it } from "vitest";
import { parseSentMessageReferences, resolveSentSessionMention, resolveTimelineReference, resolveSentWorkspaceMention, sentInputMentionSegments, validSentInputMentionRanges } from "./timeline-references.js";
import type { TimelineInputMentionView } from "../model.js";

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

  it("keeps untyped file spellings plain while preserving authored Markdown and URLs", () => {
    const segments = parseSentMessageReferences(
      'See [the task](#/tasks/task-2), https://example.test/x, @src/main.ts and @"docs/a b.md", but @owner stays text.',
      "task-1"
    );
    expect(segments.filter((segment) => segment.kind === "reference").map((segment) => segment.target.kind)).toEqual([
      "session",
      "external"
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
      "https://example.test/search?q=(word)", "https://example.test/Guns_N'_Roses"
    ]);
    const escaped = parseSentMessageReferences(String.raw`[parentheses](https://example.test/a\(b\)) [semicolon](https://example.test/path\;) [letters](https://example.test/f\oo)`, "task-1");
    expect(escaped.filter((segment) => segment.kind === "reference").map((segment) => segment.target.href)).toEqual([
      "https://example.test/a(b)", "https://example.test/path;", "https://example.test/f/oo"
    ]);
    const nested = "https://example.test/(".repeat(100);
    expect(parseSentMessageReferences(nested, "task-1")).toEqual([{ kind: "text", text: nested }]);
  });

  it("routes an accepted typed task mention only to a different exact task", () => {
    const mention = { kind: "session", sessionId: "task/earlier", displayText: "Earlier" } as const;
    expect(resolveSentSessionMention(mention, "current")).toEqual({
      kind: "session", href: "#/tasks/task%2Fearlier", sessionId: "task/earlier"
    });
    expect(resolveSentSessionMention({ ...mention, sessionId: "current" }, "current")).toBeUndefined();
    expect(resolveSentSessionMention({ ...mention, sessionId: " task" }, "current")).toBeUndefined();
  });

  it("binds equal spellings by their explicit UTF-16 positions and fails closed on invalid ranges", () => {
    const text = "😀 @report.txt @report.txt @report.txt";
    const mentions: readonly TimelineInputMentionView[] = [
      { kind: "workspace", workspaceId: "w", relativePath: "report.txt", displayText: "report.txt", directory: false },
      { kind: "artifact", sourceSessionId: "source-task", artifactId: "report-two", displayText: "report.txt" }
    ];
    const ranges = [{ start: 3, end: 14, mentionIndex: 1 }, { start: 15, end: 26, mentionIndex: 0 }];
    const segments = sentInputMentionSegments(text, mentions, ranges);
    expect(segments.filter((segment) => segment.kind === "mention").map((segment) => segment.mention)).toEqual([mentions[1], mentions[0]]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments.at(-1)).toEqual({ kind: "text", text: " @report.txt" });
    for (const invalid of [[{ start: 1, end: 14, mentionIndex: 0 }], [{ start: 3, end: 14, mentionIndex: 2 }],
      [ranges[0]!, { start: 13, end: 26, mentionIndex: 0 }], [{ start: 3, end: 100, mentionIndex: 0 }], [ranges[1]!, ranges[0]!]]) {
      expect(validSentInputMentionRanges(text, mentions, invalid)).toBeUndefined();
      expect(sentInputMentionSegments(text, mentions, invalid)).toEqual([{ kind: "text", text }]);
    }
    expect(sentInputMentionSegments(text, mentions, [])).toEqual([{ kind: "text", text }]);
    expect(resolveSentWorkspaceMention(mentions[0] as Extract<TimelineInputMentionView, { kind: "workspace" }>, "task", "w"))
      .toMatchObject({ kind: "workspace", path: "report.txt", href: "#/files/task?file=report.txt" });
    expect(resolveSentWorkspaceMention(mentions[0] as Extract<TimelineInputMentionView, { kind: "workspace" }>, "task", "other")).toBeUndefined();
    expect(resolveSentWorkspaceMention({ ...mentions[0], lineRange: { startLine: 2, endLine: 4 } } as Extract<TimelineInputMentionView, { kind: "workspace" }>, "task", "w"))
      .toMatchObject({ href: "#/files/task?file=report.txt&line=2", line: 2 });
    for (const invalid of [{ startLine: 0, endLine: 1 }, { startLine: 4, endLine: 2 }]) {
      expect(resolveSentWorkspaceMention({ ...mentions[0], lineRange: invalid } as Extract<TimelineInputMentionView, { kind: "workspace" }>, "task", "w")).toBeUndefined();
    }
    expect(resolveSentWorkspaceMention({ ...mentions[0], directory: true, lineRange: { startLine: 1, endLine: 1 } } as Extract<TimelineInputMentionView, { kind: "workspace" }>, "task", "w")).toBeUndefined();
  });
});
