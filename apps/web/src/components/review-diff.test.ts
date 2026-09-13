import { describe, expect, it } from "vitest";
import type { WorkspaceDiffHunkView, WorkspaceFileDiffView } from "../model.js";
import { buildReviewDiffTree, buildReviewSplitRows, createReviewInlineDiff, filterReviewFileJumpResults, filterReviewFiles, flattenReviewDiffTree, inlineWordDiff, isPreviewableReviewImageDiff, isReviewMarkdownPath, isSafeReviewRef, moveReviewFileJumpSelection, reviewFileKey } from "./review-diff.js";

const file = (path: string, source: WorkspaceFileDiffView["source"]): WorkspaceFileDiffView => ({
  path,
  source,
  status: "modified",
  binary: false,
  text: "",
  hunks: []
});

describe("workspace Review diff helpers", () => {
  it("builds a stable source-aware changed-file tree", () => {
    const files = [file("src/z.ts", "unstaged"), file("src/a.ts", "staged"), file("README.md", "branch")];
    const tree = buildReviewDiffTree(files);
    expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(tree[0]).toMatchObject({ kind: "directory", children: [{ name: "a.ts" }, { name: "z.ts" }] });
    expect(reviewFileKey(files[1]!)).toBe("staged::src/a.ts");
  });

  it("aligns replacement blocks in split mode and preserves context", () => {
    const hunk: WorkspaceDiffHunkView = {
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 3,
      heading: "",
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "same" },
        { kind: "removed", oldLine: 2, newLine: 0, text: "old one" },
        { kind: "removed", oldLine: 3, newLine: 0, text: "old two" },
        { kind: "added", oldLine: 0, newLine: 2, text: "new one" }
      ]
    };
    expect(buildReviewSplitRows(hunk)).toMatchObject([
      { left: { text: "same" }, right: { text: "same" } },
      { left: { text: "old one" }, right: { text: "new one" } },
      { left: { text: "old two" } }
    ]);
  });

  it("marks only changed word spans without emitting HTML", () => {
    expect(inlineWordDiff("return oldValue;", "return newValue;")).toEqual({
      before: [{ text: "return ", changed: false }, { text: "oldValue", changed: true }, { text: ";", changed: false }],
      after: [{ text: "return ", changed: false }, { text: "newValue", changed: true }, { text: ";", changed: false }]
    });
  });

  it("derives word spans only for requested replacement pairs and preserves unpaired lines", () => {
    let reads = 0;
    const hunk: WorkspaceDiffHunkView = {
      oldStart: 1, oldCount: 301, newStart: 1, newCount: 300, heading: "",
      lines: [
        ...Array.from({ length: 300 }, (_, index) => [
          { kind: "removed" as const, oldLine: index + 1, newLine: 0, get text() { reads += 1; return `old value ${index}`; } },
          { kind: "added" as const, oldLine: 0, newLine: index + 1, get text() { reads += 1; return `new value ${index}`; } }
        ]).flat(),
        { kind: "removed", oldLine: 301, newLine: 0, text: "unpaired" },
        { kind: "noNewline", oldLine: 0, newLine: 0, text: "No newline at end of file" }
      ]
    };
    const inline = createReviewInlineDiff(hunk);
    expect(reads).toBe(0);
    expect(inline.get(598)).toEqual([{ text: "old", changed: true }, { text: " value 299", changed: false }]);
    expect(inline.get(599)).toEqual([{ text: "new", changed: true }, { text: " value 299", changed: false }]);
    expect(reads).toBe(2);
    expect(inline.get(600)).toBeUndefined();
    expect(inline.get(601)).toBeUndefined();
    for (let index = 0; index < 600; index += 2) inline.get(index);
    expect(inline.get(0)?.map((span) => span.text).join("")).toBe("old value 0");
  });

  it("keeps very long lines intact with bounded whole-line highlighting", () => {
    const before = "value ".repeat(20_000);
    expect(inlineWordDiff(before, before)).toEqual({
      before: [{ text: before, changed: false }], after: [{ text: before, changed: false }]
    });
    expect(inlineWordDiff(before, `${before} changed`)).toEqual({
      before: [{ text: before, changed: true }], after: [{ text: `${before} changed`, changed: true }]
    });
  });

  it("recognizes Markdown and rejects revision-expression injection", () => {
    expect(isReviewMarkdownPath("docs/guide.markdown")).toBe(true);
    expect(isReviewMarkdownPath("src/guide.ts")).toBe(false);
    expect(isSafeReviewRef("origin/main", false)).toBe(true);
    expect(isSafeReviewRef("HEAD", true)).toBe(true);
    expect(isSafeReviewRef("HEAD", false)).toBe(false);
    expect(isSafeReviewRef("main..malicious", false)).toBe(false);
  });

  it("routes only bounded raster formats to image diff preview", () => {
    expect(isPreviewableReviewImageDiff({ binary: true, path: "assets/new.PNG" })).toBe(true);
    expect(isPreviewableReviewImageDiff({ binary: true, path: "deleted.bin", oldPath: "assets/old.webp" })).toBe(true);
    expect(isPreviewableReviewImageDiff({ binary: false, path: "assets/vector.svg" })).toBe(false);
    expect(isPreviewableReviewImageDiff({ binary: true, path: "assets/vector.svg" })).toBe(false);
  });

  it("filters and caps file-jump results while retaining directory labels", () => {
    const files = [file("src/alpha.ts", "unstaged"), file("tests/alpha.test.ts", "staged"), file("README.md", "branch")];
    expect(filterReviewFiles(files, "ALPHA")).toHaveLength(2);
    expect(filterReviewFileJumpResults(files, "alpha", 1)).toMatchObject({
      results: [{ fileName: "alpha.ts", directory: "src" }],
      overflowCount: 1
    });
  });

  it("flattens only expanded tree branches and wraps keyboard selection", () => {
    const tree = buildReviewDiffTree([file("src/nested/a.ts", "unstaged"), file("src/b.ts", "unstaged")]);
    expect(flattenReviewDiffTree(tree, new Set()).map(({ node }) => node.name)).toEqual(["src", "nested", "a.ts", "b.ts"]);
    expect(flattenReviewDiffTree(tree, new Set(["src"])).map(({ node }) => node.name)).toEqual(["src"]);
    expect(moveReviewFileJumpSelection(1, 1, 2)).toBe(0);
    expect(moveReviewFileJumpSelection(0, -1, 2)).toBe(1);
    expect(moveReviewFileJumpSelection(0, 1, 0)).toBe(-1);
  });
});
