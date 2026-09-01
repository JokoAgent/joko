import type {
  OperationApi,
  WorkspaceChangeSetView,
  WorkspaceDiffView,
  WorkspaceFileDiffView
} from "../model.js";
import type { ReviewSourceDescriptor } from "./review-source.js";

export async function loadReviewSourceDiff(
  api: Pick<OperationApi, "getWorkspaceDiff">,
  workspaceId: string,
  descriptor: ReviewSourceDescriptor,
  changeSets: readonly WorkspaceChangeSetView[],
  ignoreWhitespace: boolean,
  expected?: WorkspaceDiffView
): Promise<WorkspaceDiffView> {
  const expectedRepositoryRevision = expected?.repositoryRevision;
  if (descriptor.kind === "unstaged" || descriptor.kind === "staged") {
    return api.getWorkspaceDiff(workspaceId, {
      source: descriptor.kind,
      ignoreWhitespace,
      ...(expectedRepositoryRevision === undefined ? {} : { expectedRepositoryRevision })
    });
  }
  if (descriptor.kind === "commit" || descriptor.kind === "branch") {
    const sourceRevision = descriptor.kind === "commit" ? descriptor.commitOid : descriptor.baseRef;
    if (descriptor.kind === "commit" && sourceRevision === null) throw new Error("A commit source is required.");
    return api.getWorkspaceDiff(workspaceId, {
      source: descriptor.kind,
      ...(sourceRevision === null ? {} : { sourceRevision }),
      ignoreWhitespace,
      ...(expectedRepositoryRevision === undefined ? {} : { expectedRepositoryRevision }),
      ...(expected?.mergeBaseRevision === undefined ? {} : { expectedMergeBaseRevision: expected.mergeBaseRevision })
    });
  }
  if (descriptor.kind === "turn-set") {
    return turnSetEvidenceDiff(changeSets, descriptor.changeSetIds);
  }
  const paths = latestTurnPaths(changeSets);
  const relativePaths = [...paths];
  const unstaged = await api.getWorkspaceDiff(workspaceId, {
    source: "unstaged",
    paths: relativePaths,
    ignoreWhitespace,
    ...(expectedRepositoryRevision === undefined ? {} : { expectedRepositoryRevision })
  });
  const staged = await api.getWorkspaceDiff(workspaceId, {
    source: "staged",
    paths: relativePaths,
    ignoreWhitespace,
    expectedRepositoryRevision: unstaged.repositoryRevision
  });
  return combineLastTurnDiff(unstaged, staged, paths);
}

export function latestTurnChangeSets(changeSets: readonly WorkspaceChangeSetView[]): readonly WorkspaceChangeSetView[] {
  const latest = [...changeSets].sort((left, right) => right.capturedAt - left.capturedAt)[0];
  if (latest === undefined) return [];
  if (latest.turnId === "") return [latest];
  return changeSets
    .filter((candidate) => candidate.turnId === latest.turnId && candidate.runId === latest.runId)
    .sort((left, right) => left.capturedAt - right.capturedAt);
}

export function latestTurnPaths(changeSets: readonly WorkspaceChangeSetView[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const changeSet of latestTurnChangeSets(changeSets)) {
    for (const change of changeSet.changes ?? []) {
      if (change.path !== "") paths.add(change.path);
      if (change.oldPath !== undefined && change.oldPath !== "") paths.add(change.oldPath);
    }
  }
  return paths;
}

export function combineLastTurnDiff(
  unstaged: WorkspaceDiffView,
  staged: WorkspaceDiffView,
  paths: ReadonlySet<string>
): WorkspaceDiffView {
  if (unstaged.repositoryRevision === "" || unstaged.repositoryRevision !== staged.repositoryRevision) {
    throw new Error("Review changed while the last-turn diff was being assembled. Refresh and retry.");
  }
  if (unstaged.headRevision !== staged.headRevision) {
    throw new Error("Review HEAD changed while the last-turn diff was being assembled. Refresh and retry.");
  }
  const files = [...unstaged.files, ...staged.files].filter((file) =>
    paths.has(file.path) || (file.oldPath !== undefined && paths.has(file.oldPath))
  );
  return {
    files,
    truncated: unstaged.truncated || staged.truncated,
    repositoryRevision: unstaged.repositoryRevision,
    source: "lastTurn",
    ...(unstaged.headRevision === undefined ? {} : { headRevision: unstaged.headRevision })
  };
}

export function turnSetEvidenceDiff(
  changeSets: readonly WorkspaceChangeSetView[],
  selectedIds: readonly string[]
): WorkspaceDiffView {
  const selected = new Set(selectedIds);
  const files: WorkspaceFileDiffView[] = [];
  for (const changeSet of changeSets) {
    if (!selected.has(changeSet.id)) continue;
    for (const [index, change] of (changeSet.changes ?? []).entries()) {
      const evidenceId = `${changeSet.id}:${index}`;
      if (change.diff !== undefined) {
        files.push({ ...change.diff, source: "turnSet", evidenceId });
        continue;
      }
      files.push({
        path: change.path,
        ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
        source: "turnSet",
        evidenceId,
        status: change.kind === "created"
          ? "untracked"
          : change.kind === "deleted" ? "deleted" : change.kind === "renamed" ? "renamed" : "modified",
        binary: false,
        text: "",
        hunks: []
      });
    }
  }
  return {
    files,
    truncated: false,
    repositoryRevision: `turn-set:${selectedIds.join(",")}`,
    source: "turnSet",
    sourceRevision: selectedIds.join(",")
  };
}
