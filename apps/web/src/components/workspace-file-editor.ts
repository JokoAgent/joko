import { Code, ConnectError } from "@connectrpc/connect";
import { diffArrays } from "diff";

import type { WorkspaceFilePreviewView } from "../model.js";

export interface WorkspaceFileEditorBaseline {
  readonly path: string;
  readonly text: string;
  readonly revision: string;
}

/** In-memory buffer owned by the current Files route across a connection rebuild. */
export interface WorkspaceFileReconnectDraft {
  current: { readonly baseline: WorkspaceFileEditorBaseline; readonly editorText: string } | undefined;
}

export interface WorkspaceFileSaveDraft {
  readonly path: string;
  readonly text: string;
  readonly expectedRevision: string;
}

export interface WorkspaceFileSaveSuccess {
  readonly baseline: WorkspaceFileEditorBaseline;
  readonly editorText: string;
}

export type WorkspaceExternalFileUpdate =
  | {
      readonly kind: "unchanged";
      readonly baseline: WorkspaceFileEditorBaseline;
      readonly editorText: string;
    }
  | {
      readonly kind: "reloaded";
      readonly baseline: WorkspaceFileEditorBaseline;
      readonly editorText: string;
    }
  | {
      readonly kind: "conflict";
      readonly baseline: WorkspaceFileEditorBaseline;
      readonly editorText: string;
      readonly incoming: WorkspaceFileEditorBaseline;
    };

/** CodeMirror represents every document with LF line endings. */
export function normalizeWorkspaceEditorText(value: string): string {
  return value.replace(/\r\n|\r/gu, "\n");
}

/** Match edited lines to the baseline so surviving lines keep their terminators. */
export function restoreWorkspaceLineEndings(editorText: string, originalText: string): string {
  const normalized = normalizeWorkspaceEditorText(editorText);
  const endings = originalText.match(/\r\n|\r|\n/gu) ?? [];
  const first = endings[0] ?? "\n";
  if (endings.every(ending => ending === first)) return normalized.replace(/\n/gu, first);

  const lines = normalized.split("\n");
  const restored: string[] = [];
  let oldIndex = 0, replaced = 0;
  for (const change of diffArrays(normalizeWorkspaceEditorText(originalText).split("\n"), lines)) {
    if (change.removed) {
      replaced = change.count;
      oldIndex += replaced;
      continue;
    }
    for (const [offset, line] of change.value.entries()) {
      // Replacements inherit the corresponding old endings. Insertions use the nearest preceding one.
      const index = change.added ? Math.min(oldIndex - 1, oldIndex - replaced + offset) : oldIndex + offset;
      let ending = endings[Math.max(0, index)] ?? endings.at(-1)!;
      // An empty LF line after a bare CR needs its own terminator when the file is read back.
      if (line === "" && ending === "\n" && restored.at(-1)?.endsWith("\r")) ending = "\r\n";
      restored.push(restored.length + 1 === lines.length ? line : line + ending);
    }
    if (!change.added) oldIndex += change.count;
    replaced = 0;
  }
  return restored.join("");
}

export function workspaceFileEditorDirty(
  baseline: Pick<WorkspaceFileEditorBaseline, "text">,
  editorText: string
): boolean {
  return normalizeWorkspaceEditorText(baseline.text) !== normalizeWorkspaceEditorText(editorText);
}

export function prepareWorkspaceFileSave(
  baseline: WorkspaceFileEditorBaseline,
  editorText: string
): WorkspaceFileSaveDraft | undefined {
  if (!workspaceFileEditorDirty(baseline, editorText)) return undefined;
  return {
    path: baseline.path,
    text: restoreWorkspaceLineEndings(editorText, baseline.text),
    expectedRevision: baseline.revision
  };
}

export function applyWorkspaceFileSave(
  baseline: WorkspaceFileEditorBaseline,
  editorText: string,
  revision: string
): WorkspaceFileEditorBaseline {
  return {
    path: baseline.path,
    text: restoreWorkspaceLineEndings(editorText, baseline.text),
    revision
  };
}

/**
 * Advances the disk baseline without discarding keystrokes entered while the
 * write was in flight. When the buffer still matches the submitted document,
 * the server's exact persisted representation becomes the editor value;
 * otherwise the newer local buffer remains dirty against the new revision.
 */
export function reconcileWorkspaceFileSaveSuccess(
  baseline: WorkspaceFileEditorBaseline,
  submittedEditorText: string,
  currentEditorText: string,
  revision: string,
  persistedText?: string
): WorkspaceFileSaveSuccess {
  const savedBaseline = persistedText === undefined
    ? applyWorkspaceFileSave(baseline, submittedEditorText, revision)
    : { path: baseline.path, text: persistedText, revision };
  const submittedUnchanged = normalizeWorkspaceEditorText(currentEditorText)
    === normalizeWorkspaceEditorText(submittedEditorText);
  return {
    baseline: savedBaseline,
    editorText: submittedUnchanged
      ? normalizeWorkspaceEditorText(savedBaseline.text)
      : currentEditorText
  };
}

/**
 * A watcher refresh may replace a clean editor, but it must never overwrite a
 * dirty document. A changed revision while dirty is surfaced as a conflict and
 * keeps both the user's buffer and the newly observed disk snapshot.
 */
export function reconcileWorkspaceExternalFileUpdate(
  baseline: WorkspaceFileEditorBaseline,
  editorText: string,
  incoming: WorkspaceFileEditorBaseline
): WorkspaceExternalFileUpdate {
  if (baseline.path !== incoming.path) {
    return { kind: "reloaded", baseline: incoming, editorText: incoming.text };
  }
  if (baseline.revision === incoming.revision) {
    return { kind: "unchanged", baseline, editorText };
  }
  if (workspaceFileEditorDirty(baseline, editorText)) {
    return { kind: "conflict", baseline, editorText, incoming };
  }
  return { kind: "reloaded", baseline: incoming, editorText: incoming.text };
}

export function isWorkspaceFileStaleError(error: unknown): boolean {
  if (error instanceof ConnectError) return error.code === Code.Aborted;
  if (typeof error !== "object" || error === null) return false;
  const record = error as { readonly code?: unknown; readonly rawMessage?: unknown; readonly message?: unknown };
  if (record.code === "WORKSPACE_TEXT_FILE_STALE") return true;
  const message = typeof record.rawMessage === "string"
    ? record.rawMessage
    : typeof record.message === "string" ? record.message : "";
  return /WORKSPACE_TEXT_FILE_STALE|revision changed|stale/iu.test(message);
}
export function isEditableWorkspaceConflict(preview: WorkspaceFilePreviewView, path: string): boolean {
  return preview.path === path && preview.kind === "text" && !preview.truncated
    && preview.revision !== undefined && preview.text !== undefined;
}
