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

  it("does not write when only the editor's line-ending representation differs", () => {
    expect(workspaceFileEditorDirty(baseline, "first\nsecond\n")).toBe(false);
    expect(prepareWorkspaceFileSave(baseline, "first\nsecond\n")).toBeUndefined();
  });

  it("builds a revision-fenced save and advances the baseline after success", () => {
    expect(prepareWorkspaceFileSave(baseline, "first\nchanged\n")).toEqual({
      path: baseline.path,
      text: "first\r\nchanged\r\n",
      expectedRevision: baseline.revision
    });
    expect(applyWorkspaceFileSave(baseline, "first\nchanged\n", "sha256:after:16")).toEqual({
      path: baseline.path,
      text: "first\r\nchanged\r\n",
      revision: "sha256:after:16"
    });
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
