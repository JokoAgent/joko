import type { WorkspaceFileDiffView } from "../model.js";

export interface InspectorTurnReviewRequest {
  readonly kind: "turn-review";
  readonly requestId: number;
  readonly sessionId: string;
  readonly changeSetId: string;
  readonly selectedPath?: string;
}

export function createInspectorTurnReviewRequest(
  requestId: number,
  sessionId: string,
  changeSetId: string,
  selectedPath?: string
): InspectorTurnReviewRequest {
  return {
    kind: "turn-review",
    requestId,
    sessionId,
    changeSetId,
    ...(selectedPath === undefined ? {} : { selectedPath })
  };
}

export function selectedTurnReviewFile(
  files: readonly WorkspaceFileDiffView[],
  selectedPath: string | undefined
): WorkspaceFileDiffView | undefined {
  if (selectedPath === undefined) return files[0];
  const normalized = normalizePath(selectedPath);
  return files.find((file) => normalizePath(file.path) === normalized || normalizePath(file.oldPath ?? "") === normalized)
    ?? files[0];
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}
