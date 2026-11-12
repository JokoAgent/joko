import { FileChangeKind, type WorkspaceChangeSet } from "@joko/contracts";

import type { TimelineDocumentFileView, TimelineGeneratedFileView, TimelineItemView } from "./model.js";

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

/** Group verified document deliveries by their original Run and exact workspace path. */
export function projectDocumentFiles(items: readonly TimelineItemView[]): readonly TimelineItemView[] {
  interface RunDocuments {
    anchor: TimelineItemView;
    diffAnchor?: TimelineItemView;
    files: Map<string, { readonly sequence: bigint; readonly file: TimelineDocumentFileView }>;
    workspaces: Set<string>;
    sourceIds: Set<string>;
  }
  const runs = new Map<string, RunDocuments>();
  const receipts = new Map<string, string>();
  const pathKey = (workspaceId: string, path: string): string => JSON.stringify([workspaceId, path]);
  const receiptKey = (operationId: string, blobId: string): string => JSON.stringify([operationId, blobId]);

  for (const item of items) {
    const { documentFile: file, artifactOperationId: operationId, runId } = item;
    if (file === undefined || operationId === undefined || runId === undefined) continue;
    const run: RunDocuments = runs.get(runId) ?? { anchor: item, files: new Map(), workspaces: new Set(), sourceIds: new Set() };
    runs.set(runId, run);
    run.sourceIds.add(item.id);
    run.workspaces.add(file.workspaceId);
    receipts.set(receiptKey(operationId, file.artifact.blobId), runId);
    if (item.sequence < run.anchor.sequence) run.anchor = item;
    const key = pathKey(file.workspaceId, file.relativePath);
    const previous = run.files.get(key);
    if (previous === undefined || previous.sequence < item.sequence) run.files.set(key, { sequence: item.sequence, file });
  }
  if (runs.size === 0) return items;

  const absorbed = new Set<string>();
  for (const item of items) {
    const run = item.runId === undefined ? undefined : runs.get(item.runId);
    if (run !== undefined && item.workspaceDiff !== undefined && run.workspaces.has(item.workspaceDiff.workspaceId)
      && (run.diffAnchor === undefined || item.sequence > run.diffAnchor.sequence)) run.diffAnchor = item;
    if (item.artifact === undefined || item.artifactOperationId === undefined) continue;
    const runId = receipts.get(receiptKey(item.artifactOperationId, item.artifact.blobId));
    if (runId === undefined) continue;
    absorbed.add(item.id);
    runs.get(runId)?.sourceIds.add(item.id);
  }
  return items.flatMap(item => {
    if (absorbed.has(item.id)) return [];
    const run = item.runId === undefined ? undefined : runs.get(item.runId);
    if (run === undefined) return [item];
    const anchor = run.diffAnchor ?? run.anchor;
    if (item.documentFile !== undefined && item !== anchor) return [];
    const diff = item.workspaceDiff;
    const generatedFiles = diff?.generatedFiles.filter(file => !run.files.has(pathKey(diff.workspaceId, file.relativePath)));
    const projected = generatedFiles === undefined || diff === undefined || generatedFiles.length === diff.generatedFiles.length
      ? item : { ...item, workspaceDiff: { ...diff, generatedFiles } };
    return [item !== anchor ? projected : { ...projected,
      documentFileSourceIds: [...new Set([item.id, ...run.sourceIds])], documentFiles: [...run.files.values()].map(entry => entry.file)
    }];
  });
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
