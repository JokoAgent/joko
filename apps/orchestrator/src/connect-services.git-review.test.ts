import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "connection-git-review",
  name: "Git Review tests",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

function context(): unknown {
  return { requestHeader: new Headers({ authorization: "Bearer review-test" }), signal: new AbortController().signal };
}

function completedRecord(id: string, kind: string, body: unknown, response: unknown): OperationRecord<unknown> {
  return {
    id,
    connectionId: connection.id,
    kind,
    body,
    bodyHash: operationBodyHash(body),
    completionMode: "external_effect",
    status: "completed",
    response,
    createdAt: 1,
    updatedAt: 2,
    revision: 1n
  };
}

function application(input: {
  readonly workspaces: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly trace?: string[];
  readonly ingestBytes?: (bytes: Uint8Array, options?: object) => Promise<object>;
  readonly sessions?: readonly object[];
  readonly activeRuns?: (sessionId: string) => readonly object[];
  readonly queueItems?: (sessionId: string) => readonly object[];
  readonly onClaim?: () => void;
}): OrchestratorApplication {
  const trace = input.trace ?? [];
  const capabilities = input.capabilities ?? [
    "workspace.diff",
    "workspace.diff.sources",
    "workspace.diff.image_preview",
    "workspace.diff.commit",
    "workspace.diff.push"
  ];
  const store = {
    findOperation: () => undefined,
    listTargets: () => [{ descriptor: { id: "target-review", backendId: "backend-review" }, metadata: { workspaceId: "workspace-review" } }],
    getBackend: () => ({ descriptor: { capabilities: new Map(capabilities.map((key) => [key, { key, supported: true }])) } }),
    listSessions: () => input.sessions ?? [],
    listRuns: ({ sessionId }: { readonly sessionId: string }) => input.activeRuns?.(sessionId) ?? [],
    listQueueItems: ({ sessionId }: { readonly sessionId: string }) => input.queueItems?.(sessionId) ?? []
  };
  const sessionHost = {
    mutate: async (mutation: { operationId: string; kind: string; body: unknown; effect?: () => Promise<void>; commit: (value: object) => unknown }) => {
      trace.push("claimed");
      input.onClaim?.();
      await mutation.effect?.();
      const value = mutation.commit(store);
      return { replayed: false, value, operation: completedRecord(mutation.operationId, mutation.kind, mutation.body, value) };
    }
  };
  const ingestBytes = input.ingestBytes ?? (async (bytes: Uint8Array, options?: object) => ({
    id: "blob-review",
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteLength: bytes.byteLength,
    mimeType: (options as { mimeType?: string } | undefined)?.mimeType ?? "application/octet-stream",
    fileName: (options as { fileName?: string } | undefined)?.fileName,
    storagePath: "registered-artifact",
    createdAt: 1,
    expiresAt: (options as { expiresAt?: number } | undefined)?.expiresAt
  }));
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    artifacts: { ingestBytes },
    blobTransfers: {},
    artifactRepository: {},
    workspaces: input.workspaces,
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

describe("Connect Git Review contracts", () => {
  it("keeps commit, branch, staged, and unstaged sources typed and rejects change-set sources as Git layers", async () => {
    const gitReviewDiff = vi.fn(async () => ({
      index: "",
      workingTree: "",
      comparison: "diff --git \"a/space name.txt\" \"b/space name.txt\"\n--- \"a/space name.txt\"\n+++ \"b/space name.txt\"\n@@ -1 +1 @@\n-a\n+b\n",
      repositoryRevision: "repo-fence",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      mergeBaseRevision: "a".repeat(40),
      source: "commit" as const,
      sourceRevision: "b".repeat(40)
    }));
    const services = createConnectServices(application({ workspaces: { gitReviewDiff } }));
    const response = await services.workspace.getWorkspaceDiff(create(contract.GetWorkspaceDiffRequestSchema, {
      workspaceId: "workspace-review",
      source: contract.GitDiffSource.COMMIT,
      sourceRevision: "HEAD"
    }), context() as never);
    expect(response.diff).toMatchObject({
      source: contract.GitDiffSource.COMMIT,
      sourceRevision: "b".repeat(40),
      repositoryRevision: "repo-fence"
    });
    expect(response.diff?.files?.[0]?.source).toBe(contract.GitDiffSource.COMMIT);
    expect(response.diff?.files?.[0]?.relativePath).toBe("space name.txt");
    expect(gitReviewDiff).toHaveBeenCalledWith("workspace-review", expect.objectContaining({ source: "commit", sourceRevision: "HEAD" }));

    await expect(services.workspace.getWorkspaceDiff(create(contract.GetWorkspaceDiffRequestSchema, {
      workspaceId: "workspace-review",
      source: contract.GitDiffSource.LAST_TURN
    }), context() as never)).rejects.toMatchObject({ code: Code.FailedPrecondition } satisfies Partial<ConnectError>);
  });

  it("returns a typed warning when a missing branch base safely falls back", async () => {
    const gitReviewDiff = vi.fn(async () => ({
      index: "",
      workingTree: "",
      comparison: "",
      repositoryRevision: "branch-fence",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      mergeBaseRevision: "a".repeat(40),
      source: "branch" as const,
      sourceRevision: "a".repeat(40),
      requestedBaseRef: "missing-base",
      resolvedBaseRef: "main",
      branchBaseWarning: {
        kind: "requested_base_missing" as const,
        requestedBaseRef: "missing-base",
        resolvedBaseRef: "main"
      }
    }));
    const services = createConnectServices(application({ workspaces: { gitReviewDiff } }));
    const response = await services.workspace.getWorkspaceDiff(create(contract.GetWorkspaceDiffRequestSchema, {
      workspaceId: "workspace-review",
      source: contract.GitDiffSource.BRANCH,
      sourceRevision: "missing-base"
    }), context() as never);

    expect(response.diff).toMatchObject({
      sourceRevision: "a".repeat(40),
      requestedBaseRef: "missing-base",
      resolvedBaseRef: "main",
      branchBaseWarning: {
        code: contract.WorkspaceBranchBaseWarningCode.REQUESTED_BASE_MISSING,
        requestedBaseRef: "missing-base",
        resolvedBaseRef: "main"
      }
    });
  });

  it("materializes raster bytes as a registered expiring INLINE BlobRef", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ingestBytes = vi.fn(async (value: Uint8Array, options?: object) => ({
      id: "blob-image",
      sha256: `sha256:${createHash("sha256").update(value).digest("hex")}`,
      byteLength: value.byteLength,
      mimeType: "image/png",
      fileName: (options as { fileName?: string }).fileName,
      storagePath: "registered-image",
      createdAt: 10,
      expiresAt: (options as { expiresAt?: number }).expiresAt
    }));
    const readGitDiffImage = vi.fn(async () => ({
      oldImage: { present: false, tooLarge: false },
      newImage: { present: true, tooLarge: false, path: "assets/photo.png", mediaType: "image/png", bytes },
      repositoryRevision: "image-fence"
    }));
    const services = createConnectServices(application({ workspaces: { readGitDiffImage }, ingestBytes }));
    const response = await services.workspace.readWorkspaceDiffImage(create(contract.ReadWorkspaceDiffImageRequestSchema, {
      workspaceId: "workspace-review",
      relativePath: "assets/photo.png",
      source: contract.GitDiffSource.UNSTAGED,
      expectedRepositoryRevision: "image-fence"
    }), context() as never);

    expect(ingestBytes).toHaveBeenCalledWith(bytes, expect.objectContaining({ fileName: "photo.png", mimeType: "image/png" }));
    expect(response.newImage?.image?.blob).toMatchObject({
      blobId: "blob-image",
      mediaType: "image/png",
      disposition: contract.BlobDisposition.INLINE
    });
    expect(response.newImage?.image?.blob?.fileName).not.toContain("assets/");
  });

  it("redacts unexpected backend details from public Review errors", async () => {
    const readGitDiffImage = vi.fn(async () => {
      throw new Error("SECRET_IMAGE_BODY C:\\private\\workspace token@example.test");
    });
    const services = createConnectServices(application({ workspaces: { readGitDiffImage } }));
    await expect(services.workspace.readWorkspaceDiffImage(create(contract.ReadWorkspaceDiffImageRequestSchema, {
      workspaceId: "workspace-review",
      relativePath: "photo.png",
      source: contract.GitDiffSource.UNSTAGED,
      expectedRepositoryRevision: "image-fence"
    }), context() as never)).rejects.toMatchObject({
      code: Code.Internal,
      rawMessage: "Workspace Git operation failed."
    } satisfies Partial<ConnectError>);
  });

  it("persists the operation claim before commit/push effects and returns durable NEEDS_FORCE data", async () => {
    const trace: string[] = [];
    const commitGitReview = vi.fn(async () => {
      trace.push("commit-effect");
      return { previousRepositoryRevision: "old", repositoryRevision: "new", headRevision: "a".repeat(40) };
    });
    const pushGitReview = vi.fn(async () => {
      trace.push("push-effect");
      return {
        kind: "needs_force" as const,
        repositoryRevision: "repo-fence",
        headRevision: "a".repeat(40),
        remote: "origin",
        remoteRef: "refs/heads/topic",
        remoteOid: "b".repeat(40),
        ahead: 2,
        behind: 1
      };
    });
    const services = createConnectServices(application({ workspaces: { commitGitReview, pushGitReview }, trace }));
    const commitMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "commitWorkspaceDiff",
        value: create(contract.CommitWorkspaceDiffMutationSchema, {
          workspaceId: "workspace-review",
          message: "Commit body",
          expectedRepositoryRevision: "repo-fence"
        })
      }
    });
    await services.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-review-commit",
      connectionId: connection.id,
      mutation: commitMutation
    }), context() as never);
    expect(trace.slice(0, 2)).toEqual(["claimed", "commit-effect"]);

    const pushMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "pushWorkspaceBranch",
        value: create(contract.PushWorkspaceBranchMutationSchema, {
          workspaceId: "workspace-review",
          remote: "origin",
          remoteRef: "refs/heads/topic",
          expectedRepositoryRevision: "repo-fence",
          expectedHeadRevision: "a".repeat(40)
        })
      }
    });
    const response = await services.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-review-push",
      connectionId: connection.id,
      mutation: pushMutation
    }), context() as never);
    expect(trace.slice(2)).toEqual(["claimed", "push-effect"]);
    expect(response.operation?.result?.payload).toMatchObject({
      case: "workspaceGitPush",
      value: {
        outcome: contract.WorkspaceGitPushOutcome.NEEDS_FORCE,
        remoteOid: "b".repeat(40),
        ahead: 2,
        behind: 1
      }
    });

    const confirmedPushMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "pushWorkspaceBranch",
        value: create(contract.PushWorkspaceBranchMutationSchema, {
          workspaceId: "workspace-review",
          remote: "origin",
          remoteRef: "refs/heads/topic",
          expectedRepositoryRevision: "repo-fence",
          expectedHeadRevision: "a".repeat(40),
          confirmForceWithLease: true,
          expectedRemoteOid: "b".repeat(40)
        })
      }
    });
    await services.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-review-push-confirmed",
      connectionId: connection.id,
      mutation: confirmedPushMutation
    }), context() as never);
    expect(pushGitReview).toHaveBeenLastCalledWith("workspace-review", expect.objectContaining({
      confirmForceWithLease: true,
      expectedRemoteOid: "b".repeat(40)
    }));
  });

  it("blocks Git mutations for durable active or queued work on any task bound to the workspace Target", async () => {
    const commitGitReview = vi.fn(async () => ({
      previousRepositoryRevision: "old",
      repositoryRevision: "new",
      headRevision: "a".repeat(40)
    }));
    const mutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "commitWorkspaceDiff",
        value: create(contract.CommitWorkspaceDiffMutationSchema, {
          workspaceId: "workspace-review",
          message: "Safe commit",
          expectedRepositoryRevision: "repo-fence"
        })
      }
    });
    const sessions = [{ descriptor: { id: "session-other", targetId: "target-review" } }];

    const activeServices = createConnectServices(application({
      workspaces: { commitGitReview },
      sessions,
      activeRuns: () => [{ descriptor: { id: "run-active", state: "running" } }]
    }));
    await expect(activeServices.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-review-active-block",
      connectionId: connection.id,
      mutation
    }), context() as never)).rejects.toMatchObject({ code: Code.FailedPrecondition } satisfies Partial<ConnectError>);

    const queuedServices = createConnectServices(application({
      workspaces: { commitGitReview },
      sessions,
      queueItems: () => [{ id: "queue-pending", state: "accepted" }]
    }));
    await expect(queuedServices.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-review-queue-block",
      connectionId: connection.id,
      mutation
    }), context() as never)).rejects.toMatchObject({ code: Code.FailedPrecondition } satisfies Partial<ConnectError>);
    expect(commitGitReview).not.toHaveBeenCalled();
  });

  it("rechecks workspace activity after the durable operation claim and before the Git effect", async () => {
    let busy = false;
    const trace: string[] = [];
    const commitGitReview = vi.fn();
    const services = createConnectServices(application({
      workspaces: { commitGitReview },
      trace,
      sessions: [{ descriptor: { id: "session-other", targetId: "target-review" } }],
      activeRuns: () => busy ? [{ descriptor: { id: "run-raced", state: "running" } }] : [],
      onClaim: () => { busy = true; }
    }));
    const mutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "commitWorkspaceDiff",
        value: create(contract.CommitWorkspaceDiffMutationSchema, {
          workspaceId: "workspace-review",
          message: "Safe commit",
          expectedRepositoryRevision: "repo-fence"
        })
      }
    });
    await expect(services.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-review-raced-block",
      connectionId: connection.id,
      mutation
    }), context() as never)).rejects.toMatchObject({ code: Code.FailedPrecondition } satisfies Partial<ConnectError>);
    expect(trace).toEqual(["claimed"]);
    expect(commitGitReview).not.toHaveBeenCalled();
  });
});
