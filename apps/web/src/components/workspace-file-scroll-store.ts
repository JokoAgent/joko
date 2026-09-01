export interface WorkspaceFileScrollAnchor {
  readonly top: number;
  readonly line: number | null;
  readonly offset: number | null;
}

const anchors = new Map<string, WorkspaceFileScrollAnchor>();

/** Session-only, workspace-qualified scroll memory for the file body. */
export function loadWorkspaceFileScroll(key: string): WorkspaceFileScrollAnchor | undefined {
  return anchors.get(key);
}

export function saveWorkspaceFileScroll(key: string, anchor: WorkspaceFileScrollAnchor): void {
  anchors.set(key, anchor);
}

export function clearAllWorkspaceFileScrollForTests(): void {
  anchors.clear();
}
