import { FileChangeKind, type WorkspaceChangeSet } from "@joko/contracts";

import type { TimelineGeneratedFileView } from "./model.js";

/** Build a safe, stable list of files proven new by a complete turn-start snapshot. */
export function projectTimelineGeneratedFiles(
  changeSet: WorkspaceChangeSet | undefined
): readonly TimelineGeneratedFileView[] {
  if (changeSet?.completeBaseline !== true) return [];
  const seen = new Set<string>();
  const files: TimelineGeneratedFileView[] = [];
  for (const change of changeSet.changes) {
    if (change.kind !== FileChangeKind.CREATED || change.afterRevision === undefined) continue;
    const relativePath = normalizedWorkspaceRelativePath(change.relativePath);
    if (relativePath === undefined || seen.has(relativePath)) continue;
    seen.add(relativePath);
    files.push({
      relativePath,
      displayName: relativePath.split("/").at(-1) ?? relativePath
    });
  }
  return files;
}

function normalizedWorkspaceRelativePath(value: string): string | undefined {
  if (
    value.length === 0
    || value.length > 4096
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return undefined;
  const normalized = value.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}
