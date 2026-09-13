import type { WorkspaceChangeSetProjection } from "./events.js";
import type { UnixMillis } from "./types.js";

/** A file authoritatively observed as newly created during one captured turn. */
export interface GeneratedWorkspaceFileProjection {
  readonly relativePath: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly modifiedAt: UnixMillis;
  readonly opaqueRevision: string;
}

/**
 * Project a fail-closed generated-file list from an authoritative workspace
 * change set. Updated, deleted, incomplete, and path-escaping records never
 * become generated files.
 */
export function projectGeneratedWorkspaceFiles(
  changeSet: WorkspaceChangeSetProjection
): readonly GeneratedWorkspaceFileProjection[] {
  if (!changeSet.completeBaseline) return [];
  const seen = new Set<string>();
  const generated: GeneratedWorkspaceFileProjection[] = [];
  for (const change of changeSet.changes) {
    if (change.kind !== "created" || change.afterRevision === undefined) continue;
    const relativePath = normalizedWorkspaceRelativePath(change.relativePath);
    if (relativePath === undefined || seen.has(relativePath)) continue;
    seen.add(relativePath);
    generated.push({
      relativePath,
      displayName: relativePath.split("/").at(-1) ?? relativePath,
      byteSize: change.afterRevision.byteSize,
      modifiedAt: change.afterRevision.modifiedAt,
      opaqueRevision: change.afterRevision.opaqueRevision
    });
  }
  return generated;
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
