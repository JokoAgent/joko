import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  GetWorkspaceDiffResponseSchema,
  GitDiffSource,
  OperationState,
  ReadWorkspaceDiffFileResponseSchema,
  ReadWorkspaceDiffImageResponseSchema,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  WorkspaceBranchBaseWarningCode,
  WorkspaceDiffTarget,
  WorkspaceGitPushOutcome
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("exact Git Review gateway", () => {
  it("round-trips exact source, repository/source/merge fences, text, and authenticated image refs", async () => {
    const transport = transportFor(async (method, input) => {
      if (method.localName === "getWorkspaceDiff") {
        expect(input).toMatchObject({
          workspaceId: "workspace-1",
          source: GitDiffSource.BRANCH,
          sourceRevision: "origin/main",
          expectedRepositoryRevision: "repo-before",
          expectedMergeBaseRevision: "merge-before",
          ignoreWhitespace: true
        });
        return response(method, create(GetWorkspaceDiffResponseSchema, { diff: {
          workspaceId: "workspace-1",
          source: GitDiffSource.BRANCH,
          sourceRevision: "b".repeat(40),
          requestedBaseRef: "origin/main",
          resolvedBaseRef: "origin/trunk",
          branchBaseWarning: {
            code: WorkspaceBranchBaseWarningCode.REQUESTED_BASE_MISSING,
            requestedBaseRef: "origin/main",
            resolvedBaseRef: "origin/trunk"
          },
          repositoryRevision: "repo-1",
          mergeBaseRevision: "merge-1",
          headRevision: "h".repeat(40),
          files: [{ relativePath: "docs/readme.md", source: GitDiffSource.BRANCH, binary: false }]
        } }));
      }
      if (method.localName === "readWorkspaceDiffFile") {
        expect(input).toMatchObject({
          source: GitDiffSource.BRANCH,
          sourceRevision: "b".repeat(40),
          expectedRepositoryRevision: "repo-1",
          expectedMergeBaseRevision: "merge-1"
        });
        return response(method, create(ReadWorkspaceDiffFileResponseSchema, {
          text: { utf8Text: "# Review\n", languageId: "markdown" },
          repositoryRevision: "repo-1",
          mergeBaseRevision: "merge-1"
        }));
      }
      if (method.localName === "readWorkspaceDiffImage") {
        expect(input).toMatchObject({
          source: GitDiffSource.BRANCH,
          sourceRevision: "b".repeat(40),
          expectedRepositoryRevision: "repo-1",
          expectedMergeBaseRevision: "merge-1"
        });
        return response(method, create(ReadWorkspaceDiffImageResponseSchema, {
          oldImage: { present: true, image: { blob: { blobId: "old-image", mediaType: "image/png" } } },
          newImage: { present: true, image: { blob: { blobId: "new-image", mediaType: "image/png" } } },
          repositoryRevision: "repo-1",
          mergeBaseRevision: "merge-1",
          maximumBytes: 4_194_304n
        }));
      }
      throw new Error(`Unexpected RPC ${method.localName}`);
    });
    const gateway = await connectedGateway(transport);
    const diff = await gateway.getWorkspaceDiff("workspace-1", {
      source: "branch",
      sourceRevision: "origin/main",
      expectedRepositoryRevision: "repo-before",
      expectedMergeBaseRevision: "merge-before",
      ignoreWhitespace: true
    });
    expect(diff).toMatchObject({
      source: "branch",
      sourceRevision: "b".repeat(40),
      requestedBaseRef: "origin/main",
      resolvedBaseRef: "origin/trunk",
      branchBaseWarning: {
        code: "requestedBaseMissing",
        requestedBaseRef: "origin/main",
        resolvedBaseRef: "origin/trunk"
      },
      repositoryRevision: "repo-1",
      mergeBaseRevision: "merge-1"
    });
    const file = diff.files[0]!;
    await expect(gateway.readWorkspaceDiffFile("workspace-1", file, diff)).resolves.toMatchObject({ text: "# Review\n" });
    await expect(gateway.readWorkspaceDiffImage("workspace-1", { ...file, path: "image.png", binary: true }, diff)).resolves.toMatchObject({
      oldImage: { blobId: "old-image" },
      newImage: { blobId: "new-image" },
      maximumBytes: 4_194_304
    });
    gateway.disconnect();
  });

  it("submits file mutations, commit, and two-stage force-with-lease under distinct operation IDs", async () => {
    const operationIds: string[] = [];
    let pushes = 0;
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "submitOperation") throw new Error(`Unexpected RPC ${method.localName}`);
      operationIds.push(input.operationId);
      const mutation = input.mutation?.payload;
      if (mutation?.case === "applyWorkspaceDiffHunk") {
        expect(mutation.value).toMatchObject({ source: GitDiffSource.UNSTAGED, target: WorkspaceDiffTarget.FILE, expectedRepositoryRevision: "repo-1", confirmRevert: true });
        return operationResponse(method, input.operationId);
      }
      if (mutation?.case === "commitWorkspaceDiff") {
        expect(mutation.value).toMatchObject({ message: "review commit", includeUnstaged: true, expectedRepositoryRevision: "repo-2" });
        return operationResponse(method, input.operationId);
      }
      if (mutation?.case === "pushWorkspaceBranch") {
        pushes += 1;
        expect(mutation.value.remote).toBe("origin");
        expect(mutation.value.remoteRef).toBe("refs/heads/feature/review");
        if (pushes === 1) {
          expect(mutation.value).toMatchObject({ confirmForceWithLease: false, expectedRemoteOid: "" });
          return operationResponse(method, input.operationId, WorkspaceGitPushOutcome.NEEDS_FORCE);
        }
        expect(mutation.value).toMatchObject({ confirmForceWithLease: true, expectedRemoteOid: "remote-oid" });
        return operationResponse(method, input.operationId, WorkspaceGitPushOutcome.PUSHED);
      }
      throw new Error(`Unexpected mutation ${mutation?.case}`);
    });
    const gateway = await connectedGateway(transport);
    await gateway.applyWorkspaceDiffHunk("workspace-1", {
      action: "revert", source: "unstaged", target: "file", path: "src/a.ts", expectedRepositoryRevision: "repo-1", ignoreWhitespace: false, confirmRevert: true
    });
    await gateway.commitWorkspaceDiff("workspace-1", { message: "review commit", includeUnstaged: true, expectedRepositoryRevision: "repo-2" });
    const first = await gateway.pushWorkspaceBranch("workspace-1", {
      remote: "origin", remoteRef: "refs/heads/feature/review", expectedRepositoryRevision: "repo-3", expectedHeadRevision: "head-3", confirmForceWithLease: false
    });
    expect(first).toMatchObject({ outcome: "needsForce", remoteOid: "remote-oid", ahead: 2, behind: 1 });
    await expect(gateway.pushWorkspaceBranch("workspace-1", {
      remote: "origin", remoteRef: "refs/heads/feature/review", expectedRepositoryRevision: "repo-4", expectedHeadRevision: "head-4", confirmForceWithLease: true, expectedRemoteOid: first.remoteOid
    })).resolves.toMatchObject({ outcome: "pushed" });
    expect(new Set(operationIds).size).toBe(4);
    expect(operationIds.every((id) => id.length > 0)).toBe(true);
    gateway.disconnect();
  });
});

async function connectedGateway(transport: Transport) {
  const gateway = createOrchestratorGateway({ id: "connection-review", deviceId: "device-test", name: "Review", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
  await gateway.connect();
  return gateway;
}

function transportFor(handler: (method: any, input: any) => Promise<any>): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
      return handler(method, input);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function operationResponse(method: any, operationId: string, pushOutcome?: WorkspaceGitPushOutcome): any {
  return response(method, create(SubmitOperationResponseSchema, { operation: {
    operationId,
    state: OperationState.SUCCEEDED,
    ...(pushOutcome === undefined ? {} : { result: { payload: { case: "workspaceGitPush", value: {
      outcome: pushOutcome,
      remote: "origin",
      remoteRef: "refs/heads/feature/review",
      remoteOid: pushOutcome === WorkspaceGitPushOutcome.NEEDS_FORCE ? "remote-oid" : "",
      ahead: 2,
      behind: 1,
      repositoryRevision: "repo-result",
      headRevision: "head-result"
    } } } })
  } }));
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
