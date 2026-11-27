import { describe, expect, it } from "vitest";
import {
  applyWorkspaceFileSave,
  isWorkspaceFileStaleError,
  normalizeWorkspaceEditorText,
  prepareWorkspaceFileSave,
  reconcileWorkspaceFileSaveSuccess,
  reconcileWorkspaceExternalFileUpdate,
  restoreWorkspaceLineEndings,
  workspaceFileEditorDirty
} from "./workspace-file-editor.js";

const baseline = {
  path: "src/example.ts",
  text: "first\r\nsecond\r\n",
  revision: "sha256:before:15"
} as const;

describe("workspace file editor state", () => {
  it("normalizes editor text while preserving an existing CRLF convention on save", () => {
    expect(normalizeWorkspaceEditorText("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(restoreWorkspaceLineEndings("first\nchanged\n", baseline.text)).toBe("first\r\nchanged\r\n");
    expect(restoreWorkspaceLineEndings("first\r\nchanged\r\n", "first\nsecond\n")).toBe("first\nchanged\n");
  });

  it("retains each surviving CRLF, LF and CR through replacements, insertions and deletions", () => {
    const text = "one\r\ntwo\nthree\rfour\n";
    const save = (edited: string) => prepareWorkspaceFileSave({ ...baseline, text }, edited)?.text;
    expect(save("ONE\ntwo\nthree\nfour\n")).toBe("ONE\r\ntwo\nthree\rfour\n");
    expect(save("one\ninserted\ntwo\nTHREE\nfour\n")).toBe("one\r\ninserted\r\ntwo\nTHREE\rfour\n");
    expect(save("two\nthree\nfour")).toBe("two\nthree\rfour");
    expect(restoreWorkspaceLineEndings("a\nb\nc", "a\rb\rc")).toBe("a\rb\rc");
  });

  it("does not write when only the editor's line-ending representation differs", () => {
    expect(workspaceFileEditorDirty(baseline, "first\nsecond\n")).toBe(false);
    expect(prepareWorkspaceFileSave(baseline, "first\nsecond\n")).toBeUndefined();
  });

  it("builds a revision-fenced save and advances the baseline after success", () => {
    expect(prepareWorkspaceFileSave(baseline, "first\nchanged\n")).toEqual({
      path: baseline.path,
      text: "first\r\nchanged\r\n",
      expectedRevision: baseline.revision, operationId: expect.any(String)
    });
    expect(applyWorkspaceFileSave(baseline, "first\nchanged\n", "sha256:after:16")).toEqual({
      path: baseline.path,
      text: "first\r\nchanged\r\n",
      revision: "sha256:after:16"
    });
  });

  it("reuses the operation only for the exact pending editor save", () => {
    const first = prepareWorkspaceFileSave(baseline, "edit")!;
    expect(prepareWorkspaceFileSave(baseline, "edit", first)).toBe(first);
    expect(prepareWorkspaceFileSave(baseline, "later", first)?.operationId).not.toBe(first.operationId);
    expect(prepareWorkspaceFileSave({ ...baseline, revision: "new" }, "edit", first)?.operationId).not.toBe(first.operationId);
  });

  it("advances the saved revision without losing edits typed while the write is in flight", () => {
    expect(reconcileWorkspaceFileSaveSuccess(
      baseline,
      "first\nsubmitted\n",
      "first\nsubmitted and kept typing\n",
      "sha256:submitted:23"
    )).toEqual({
      baseline: {
        path: baseline.path,
        text: "first\r\nsubmitted\r\n",
        revision: "sha256:submitted:23"
      },
      editorText: "first\nsubmitted and kept typing\n"
    });
    expect(reconcileWorkspaceFileSaveSuccess(
      baseline,
      "first\nsubmitted\n",
      "first\nsubmitted\n",
      "sha256:canonical:22",
      "first\r\ncanonical\r\n"
    )).toEqual({
      baseline: {
        path: baseline.path,
        text: "first\r\ncanonical\r\n",
        revision: "sha256:canonical:22"
      },
      editorText: "first\ncanonical\n"
    });
  });

  it("reloads clean buffers but retains dirty buffers when disk revision changes", () => {
    const incoming = { ...baseline, text: "external\n", revision: "sha256:external:9" };
    expect(reconcileWorkspaceExternalFileUpdate(baseline, "first\nsecond\n", incoming)).toEqual({
      kind: "reloaded",
      baseline: incoming,
      editorText: incoming.text
    });
    expect(reconcileWorkspaceExternalFileUpdate(baseline, "my edits\n", incoming)).toEqual({
      kind: "conflict",
      baseline,
      editorText: "my edits\n",
      incoming
    });
  });

  it("treats a different selected path as a fresh document", () => {
    const incoming = { path: "README.md", text: "# Readme\n", revision: "sha256:readme:9" };
    expect(reconcileWorkspaceExternalFileUpdate(baseline, "my edits\n", incoming)).toEqual({
      kind: "reloaded",
      baseline: incoming,
      editorText: incoming.text
    });
  });

  it("recognizes stable stale-write errors without classifying unrelated failures", () => {
    expect(isWorkspaceFileStaleError({ code: "WORKSPACE_TEXT_FILE_STALE" })).toBe(true);
    expect(isWorkspaceFileStaleError(new Error("Workspace file revision changed."))).toBe(true);
    expect(isWorkspaceFileStaleError(new Error("network unavailable"))).toBe(false);
  });
});
