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
  });
});
