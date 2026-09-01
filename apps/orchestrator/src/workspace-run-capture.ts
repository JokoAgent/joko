import { createHash, randomUUID } from "node:crypto";

import type {
  TargetDescriptor,
  WorkspaceChangeSetProjection,
  WorkspaceDescriptorProjection,
  WorkspaceDiffProjection,
  WorkspaceEntryProjection,
  WorkspaceFileRevisionProjection,
  WorkspaceGitFileStatusProjection,
  WorkspaceGitProjection
} from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { GitSafetyCoordinator } from "@joko/git-safety";

import type { WorkspaceRunCapture } from "./session-host.js";
import type { SnapshotFile, WorkspaceChangeSetRecord, WorkspaceChangeSetService } from "./workspace-change-set.js";
import type { GitState, WorkspaceService } from "./workspace-service.js";

interface RunCaptureReference {
  readonly baselineId: string;
  readonly changeSetId: string;
  readonly workspaceId: string;
  readonly dialogueEntryId?: string;
}

export class DurableWorkspaceRunCapture implements WorkspaceRunCapture {
  readonly #store: OperationalStore;
  readonly #changes: WorkspaceChangeSetService;
  readonly #workspaceService: WorkspaceService | undefined;
  readonly #gitSafety: GitSafetyCoordinator | undefined;

  constructor(
    store: OperationalStore,
    changes: WorkspaceChangeSetService,
    workspaceService?: WorkspaceService,
    gitSafety?: GitSafetyCoordinator
  ) {
    this.#store = store;
    this.#changes = changes;
    this.#workspaceService = workspaceService;
    this.#gitSafety = gitSafety;
  }

  async captureBeforeRun(input: { readonly sessionId: string; readonly runId: string; readonly target: TargetDescriptor; readonly nativeLeafId?: string }): Promise<void> {
    if (input.target.remoteWorkspace === undefined) {
      await this.#gitSafety?.onTurnStart({
        sessionId: input.sessionId,
        runId: input.runId,
        workspaceRoot: input.target.workspaceRoot
      }).catch(() => undefined);
    }
    if (this.reference(input.sessionId, input.runId) !== undefined) return;
    const workspaceId = workspaceIdFor(this.#store, input.target, input.sessionId);
    const baseline = await this.#changes.captureBaseline(workspaceId, input.target.workspaceRoot, input.nativeLeafId);
    this.#store.setSetting("session", input.sessionId, referenceKey(input.runId), {
      baselineId: baseline.id,
      changeSetId: stableChangeSetId(input.runId),
      workspaceId,
      ...(input.nativeLeafId === undefined ? {} : { dialogueEntryId: input.nativeLeafId })
    } satisfies RunCaptureReference);
  }

  async captureAfterRun(input: { readonly sessionId: string; readonly runId: string; readonly target: TargetDescriptor }): Promise<void> {
    if (input.target.remoteWorkspace === undefined) {
      await this.#gitSafety?.onTurnSettled({
        sessionId: input.sessionId,
        runId: input.runId,
        workspaceRoot: input.target.workspaceRoot
      }).catch(() => undefined);
    }
    const reference = this.reference(input.sessionId, input.runId);
    if (reference === undefined) return;
    let changeSet = await this.#changes.getChangeSet(reference.changeSetId);
    changeSet ??= await this.#changes.captureChangeSet(reference.baselineId, input.sessionId, input.runId, reference.changeSetId);
    if (this.#store.hasVisibleWorkspaceDiff(input.sessionId, changeSet.id)) return;
    const session = this.#store.getSession(input.sessionId);
    const target = this.#store.getTarget(session.descriptor.targetId);
    const git = await this.captureGitProjection(reference.workspaceId);
    this.#store.transaction((store) => {
      if (store.hasVisibleWorkspaceDiff(input.sessionId, changeSet.id)) return;
      store.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId: input.sessionId,
        runId: input.runId,
        generation: session.descriptor.binding.generation,
        traceId: randomUUID(),
        payload: {
          type: "workspace_diff",
          changeSetId: changeSet.id,
          summary: `${changeSet.changes.length} workspace file${changeSet.changes.length === 1 ? "" : "s"} changed`,
          changeSet: projectChangeSet(changeSet),
          diff: projectDiff(changeSet),
          workspace: {
            workspaceId: reference.workspaceId,
            targetId: target.descriptor.id,
            displayName: target.descriptor.displayName,
            kind: target.descriptor.managed ? "managed_dialogue" : "user_project",
            serverPathDisplay: "",
            trusted: target.descriptor.trusted,
            ...(git === undefined ? {} : { git }),
            revision: target.revision.toString(10),
            generation: String(session.descriptor.binding.generation),
            updatedAt: target.updatedAt
          } satisfies WorkspaceDescriptorProjection,
          entriesRevision: store.health().revision.toString(10),
          upsertedEntries: projectUpsertedEntries(changeSet),
          removedRelativePaths: changeSet.changes
            .filter((change) => change.kind === "deleted")
            .map((change) => change.path)
        }
      });
    });
  }

  abortRun(input: { readonly sessionId: string; readonly runId: string }): void {
    this.#gitSafety?.abortTurn(input);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#gitSafety?.closeSession(sessionId);
  }

  private async captureGitProjection(workspaceId: string): Promise<WorkspaceGitProjection | undefined> {
    if (this.#workspaceService === undefined) return undefined;
    try {
      return projectGit(await this.#workspaceService.gitState(workspaceId));
    } catch {
      // The durable file delta remains authoritative when Git is unavailable.
      return undefined;
    }
  }

  private reference(sessionId: string, runId: string): RunCaptureReference | undefined {
    return this.#store.findSetting<RunCaptureReference>("session", sessionId, referenceKey(runId))?.value;
  }
}

function projectChangeSet(changeSet: WorkspaceChangeSetRecord): WorkspaceChangeSetProjection {
  return {
    changeSetId: changeSet.id,
    workspaceId: changeSet.workspaceId,
    sessionId: changeSet.sessionId,
    runId: changeSet.runId,
    turnId: changeSet.runId,
    baselineId: changeSet.baselineId,
    changes: changeSet.changes.map((change) => ({
      relativePath: change.path,
      kind: change.kind,
      ...(change.before === undefined ? {} : { beforeRevision: projectFileRevision(change.before) }),
      ...(change.after === undefined ? {} : { afterRevision: projectFileRevision(change.after) })
    })),
    completeBaseline: changeSet.complete,
    gaps: changeSet.gaps.map((gap) => redactWorkspaceRoot(gap, changeSet.workspaceRoot)),
    capturedAt: changeSet.capturedAt
  };
}

function projectDiff(changeSet: WorkspaceChangeSetRecord): WorkspaceDiffProjection {
  return {
    workspaceId: changeSet.workspaceId,
    files: changeSet.changes.map((change) => ({
      relativePath: change.path,
      status: change.kind === "created" ? "added" : change.kind === "deleted" ? "deleted" : "modified",
      binary: false
    })),
    // Run events intentionally carry metadata-only diffs; file content remains
    // behind the authenticated workspace/blob APIs.
    truncated: changeSet.changes.length > 0 || !changeSet.complete
  };
}

function projectUpsertedEntries(changeSet: WorkspaceChangeSetRecord): readonly WorkspaceEntryProjection[] {
  return changeSet.changes.flatMap((change) => {
    if (change.after === undefined) return [];
    const path = change.path.replace(/\\/gu, "/");
    return [{
      workspaceId: changeSet.workspaceId,
      relativePath: path,
      displayName: path.split("/").at(-1) ?? path,
      kind: "regular" as const,
      revision: projectFileRevision(change.after),
      generated: isGeneratedPath(path),
      ignored: false,
      hidden: path.split("/").some((part) => part.startsWith(".")),
      mediaType: mediaTypeForPath(path)
    }];
  });
}

function projectFileRevision(file: SnapshotFile): WorkspaceFileRevisionProjection {
  return {
    sha256Hex: file.sha256,
    byteSize: file.byteLength,
    modifiedAt: Math.trunc(file.modifiedAt),
    opaqueRevision: `${file.sha256}:${file.byteLength}:${Math.trunc(file.modifiedAt)}`
  };
}

function projectGit(state: GitState): WorkspaceGitProjection {
  return {
    repository: state.repository,
    ...(state.branch === undefined ? {} : { branchName: state.branch }),
    ...(state.head === undefined ? {} : { headCommit: state.head }),
    detachedHead: state.repository && state.branch === undefined,
    dirty: state.dirty,
    operationInProgress: false,
    changes: state.changes.map((change) => ({
      relativePath: change.path.replace(/\\/gu, "/"),
      ...(change.originalPath === undefined ? {} : { oldRelativePath: change.originalPath.replace(/\\/gu, "/") }),
      indexStatus: gitStatus(change.index),
      workingTreeStatus: gitStatus(change.worktree),
      binary: false
    }))
  };
}

function gitStatus(code: string): WorkspaceGitFileStatusProjection {
  switch (code) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "?": return "untracked";
    case "!": return "ignored";
    case "U": return "conflicted";
    case " ": return "unmodified";
    default: return "unspecified";
  }
}

function redactWorkspaceRoot(value: string, workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return value.replace(/\\/gu, "/").split(normalizedRoot).join("[workspace]");
}

function isGeneratedPath(path: string): boolean {
  return path.split("/").some((part) => ["node_modules", "dist", "build", ".git", ".next", "coverage"].includes(part));
}

function mediaTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (/\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cc|cpp|h|hpp|yaml|yml|toml|xml|svg)$/u.test(lower)) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  if (/\.jpe?g$/u.test(lower)) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function referenceKey(runId: string): string {
  return `workspace_capture.${runId}`;
}

function stableChangeSetId(runId: string): string {
  return `change-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

function workspaceIdFor(store: OperationalStore, target: TargetDescriptor, sessionId: string): string {
  const isolated = store.getSession(sessionId).descriptor.worktree;
  if (isolated !== undefined) return isolated.workspaceId;
  const metadata = store.getTarget(target.id).metadata;
  if (isRecord(metadata) && typeof metadata["workspaceId"] === "string" && metadata["workspaceId"].trim() !== "") {
    return metadata["workspaceId"];
  }
  return target.id;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
