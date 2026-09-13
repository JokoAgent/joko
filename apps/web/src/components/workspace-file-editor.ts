export interface WorkspaceFileEditorBaseline {
  readonly path: string;
  readonly text: string;
  readonly revision: string;
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

/**
 * Preserve CRLF when the file was originally CRLF. The editor's LF
 * document is converted only at the persistence boundary so a no-op save does
 * not turn the whole file into a Git diff on Windows.
 */
export function restoreWorkspaceLineEndings(editorText: string, originalText: string): string {
  const normalized = normalizeWorkspaceEditorText(editorText);
  return originalText.includes("\r\n") ? normalized.replace(/\n/gu, "\r\n") : normalized;
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
  if (typeof error !== "object" || error === null) return false;
  const record = error as { readonly code?: unknown; readonly rawMessage?: unknown; readonly message?: unknown };
  if (record.code === "WORKSPACE_TEXT_FILE_STALE") return true;
  const message = typeof record.rawMessage === "string"
    ? record.rawMessage
    : typeof record.message === "string" ? record.message : "";
  return /WORKSPACE_TEXT_FILE_STALE|revision changed|stale/iu.test(message);
}
