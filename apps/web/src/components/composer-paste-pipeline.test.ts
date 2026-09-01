import { describe, expect, it } from "vitest";

import {
  COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT,
  COMPOSER_LONG_PASTE_CHARACTER_THRESHOLD,
  COMPOSER_LONG_PASTE_LINE_THRESHOLD,
  composerPathRelativeToWorkingDirectory,
  countComposerPasteLines,
  htmlCarriesComposerAtomMarkup,
  isComposerLongPaste,
  parseComposerRouteReference,
  sanitizeComposerReferenceLabel,
  segmentComposerPaste,
  serializeComposerRouteReference,
  trimComposerPathCandidate
} from "./composer-paste-pipeline.js";

describe("composer paste sizing", () => {
  it("folds bounded logs by line or character threshold without storing oversized attributes", () => {
    expect(isComposerLongPaste(Array(COMPOSER_LONG_PASTE_LINE_THRESHOLD - 1).fill("line").join("\n"))).toBe(false);
    expect(isComposerLongPaste(Array(COMPOSER_LONG_PASTE_LINE_THRESHOLD).fill("line").join("\n"))).toBe(true);
    expect(isComposerLongPaste("x".repeat(COMPOSER_LONG_PASTE_CHARACTER_THRESHOLD - 1))).toBe(false);
    expect(isComposerLongPaste("x".repeat(COMPOSER_LONG_PASTE_CHARACTER_THRESHOLD))).toBe(true);
    expect(isComposerLongPaste("x".repeat(COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT + 1))).toBe(false);
    expect(countComposerPasteLines("a\r\nb\r\n")).toBe(3);
  });

  it("recognizes the editor's own atom markup so clipboard HTML can round-trip", () => {
    expect(htmlCarriesComposerAtomMarkup('<span data-composer-pasted-text="">text</span>')).toBe(true);
    expect(htmlCarriesComposerAtomMarkup('<span data-composer-quote="">quote</span>')).toBe(true);
    expect(htmlCarriesComposerAtomMarkup('<span data-mention-chip="">file</span>')).toBe(true);
    expect(htmlCarriesComposerAtomMarkup('<a href="https://example.test">link</a>')).toBe(false);
  });
});

describe("composer route paste segmentation", () => {
  const task = "joko://app/index.html#/tasks/task%2Fone?event=event%2F9&message=entry%3A42";
  const project = "https://joko.test/app#/projects/project%2Fone";

  it("parses canonical app routes and preserves exact message anchors", () => {
    expect(parseComposerRouteReference(task)).toEqual({
      kind: "session",
      sessionId: "task/one",
      messageId: "entry:42",
      eventId: "event/9"
    });
    expect(parseComposerRouteReference("#/projects/project%2Fone")).toEqual({ kind: "project", projectId: "project/one" });
    expect(parseComposerRouteReference("https://example.test/#/settings")).toBeUndefined();
  });

  it("splits bare and markdown-labelled task/project links from prose", () => {
    expect(segmentComposerPaste(`See ${task} and [Main](${project}).`)).toEqual([
      { kind: "text", text: "See " },
      { kind: "session", href: task, label: null, sessionId: "task/one", messageId: "entry:42", eventId: "event/9" },
      { kind: "text", text: " and " },
      { kind: "project", href: project, label: "Main", projectId: "project/one" },
      { kind: "text", text: "." }
    ]);
  });

  it("keeps nested and escaped brackets in labels while serializing safe markdown", () => {
    const linked = segmentComposerPaste(`[[WIP] Fix](${task})`)?.[0];
    expect(linked).toMatchObject({ kind: "session", label: "[WIP] Fix" });
    if (linked?.kind !== "session") throw new Error("expected session segment");
    expect(serializeComposerRouteReference(linked)).toBe(`[WIP Fix](${task})`);
    expect(sanitizeComposerReferenceLabel(" [x] @src ")).toBe("x ＠src");
  });

  it("rejects malformed or unrelated routes without guessing", () => {
    expect(segmentComposerPaste("#/tasks/")).toBeNull();
    expect(segmentComposerPaste("https://example.test/#/tasks/%E0%A4%A")).toBeNull();
    expect(segmentComposerPaste("ordinary https://example.test/path")).toBeNull();
  });
});

describe("composer working-directory path candidates", () => {
  const workingDirectory = "/Users/alice/Code/App";

  it("segments only absolute candidates inside the current workspace", () => {
    expect(segmentComposerPaste(`At ${workingDirectory}/src/main.ts:12:5, not /etc/hosts`, { workingDirectory })).toEqual([
      { kind: "text", text: "At " },
      { kind: "path", path: `${workingDirectory}/src/main.ts` },
      { kind: "text", text: ":12:5, not /etc/hosts" }
    ]);
    expect(segmentComposerPaste(workingDirectory, { workingDirectory })).toBeNull();
  });

  it("supports Windows case and slash variants and normalizes relative output", () => {
    const windowsBase = "C:\\Code\\App";
    const path = "c:/code/app/src/Main.ts";
    expect(segmentComposerPaste(`See ${path}`, { workingDirectory: windowsBase })).toEqual([
      { kind: "text", text: "See " },
      { kind: "path", path }
    ]);
    expect(composerPathRelativeToWorkingDirectory("C:\\Code\\App\\src\\main.ts", windowsBase)).toBe("src/main.ts");
  });

  it("trims interleaved line suffixes, punctuation, brackets, and directory separators", () => {
    expect(trimComposerPathCandidate("/a/b.ts:12:5),")).toBe("/a/b.ts");
    expect(trimComposerPathCandidate("C:\\repo\\src\\")).toBe("C:\\repo\\src");
  });

  it("scans remaining prose around a route reference", () => {
    const task = "#/tasks/task-one";
    expect(segmentComposerPaste(`${task} changed ${workingDirectory}/README.md`, { workingDirectory })).toEqual([
      { kind: "session", href: task, label: null, sessionId: "task-one" },
      { kind: "text", text: " changed " },
      { kind: "path", path: `${workingDirectory}/README.md` }
    ]);
  });
});
