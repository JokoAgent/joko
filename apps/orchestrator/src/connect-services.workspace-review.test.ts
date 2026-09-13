import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "connection-review",
  name: "Review tests",
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

function application(capabilities: readonly string[], applyGitDiff: (workspaceId: string, input: unknown) => Promise<string>): OrchestratorApplication {
  const store = {
    findOperation: () => undefined,
    listTargets: () => [{ descriptor: { id: "target-review", backendId: "backend-review" }, metadata: { workspaceId: "workspace-review" } }],
    listSessions: () => [],
    listRuns: () => [],
    listQueueItems: () => [],
    getBackend: () => ({ descriptor: { capabilities: new Map(capabilities.map((key) => [key, { key, supported: true }])) } })
  };
  const sessionHost = {
    mutate: async (input: { operationId: string; kind: string; body: unknown; effect?: () => Promise<void>; commit: (value: object) => unknown }) => {
      await input.effect?.();
      const value = input.commit(store);
      return { replayed: false, value, operation: completedRecord(input.operationId, input.kind, input.body, value) };
    }
  };
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: { applyGitDiff },
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

async function submit(app: OrchestratorApplication, value: contract.ApplyWorkspaceDiffHunkMutation): Promise<contract.SubmitOperationResponse> {
  const services = createConnectServices(app);
  return (services.operation.submitOperation as (request: unknown, handlerContext: unknown) => Promise<contract.SubmitOperationResponse>)({
    operationId: `operation-${value.action}-${value.confirmRevert}`,
    connectionId: connection.id,
    mutation: create(contract.OperationMutationSchema, {
      payload: { case: "applyWorkspaceDiffHunk", value }
    })
  }, context());
}

describe("Connect workspace Review mutations", () => {
  it("passes a typed revision-fenced stage request only when its capability is supported", async () => {
    const applyGitDiff = vi.fn(async () => "next-revision");
    const value = create(contract.ApplyWorkspaceDiffHunkMutationSchema, {
      workspaceId: "workspace-review",
      action: contract.WorkspaceDiffAction.STAGE,
      source: contract.GitDiffSource.UNSTAGED,
      target: contract.WorkspaceDiffTarget.HUNK,
      relativePath: "src/review.ts",
      hunkIndex: 2,
      expectedRepositoryRevision: "fence",
      ignoreWhitespace: true
    });
    const response = await submit(application(["workspace.diff.stage"], applyGitDiff), value);
    expect(response.operation?.result?.payload.case).toBe("acknowledgement");
    expect(applyGitDiff).toHaveBeenCalledWith("workspace-review", {
      action: "stage",
      source: "unstaged",
      target: "hunk",
      path: "src/review.ts",
      hunkIndex: 2,
      expectedRepositoryRevision: "fence",
      ignoreWhitespace: true,
      confirmRevert: false
    });
  });

  it("fails closed when revert is not explicitly confirmed", async () => {
    const applyGitDiff = vi.fn(async () => "next-revision");
    const value = create(contract.ApplyWorkspaceDiffHunkMutationSchema, {
      workspaceId: "workspace-review",
      action: contract.WorkspaceDiffAction.REVERT,
      source: contract.GitDiffSource.UNSTAGED,
      target: contract.WorkspaceDiffTarget.FILE,
      relativePath: "src/review.ts",
      expectedRepositoryRevision: "fence",
      confirmRevert: false
    });
    await expect(submit(application(["workspace.diff.revert"], applyGitDiff), value)).rejects.toMatchObject({
      code: Code.FailedPrecondition
    } satisfies Partial<ConnectError>);
    expect(applyGitDiff).not.toHaveBeenCalled();
  });

  it("does not dispatch a write when the Backend capability is absent", async () => {
    const applyGitDiff = vi.fn(async () => "next-revision");
    const value = create(contract.ApplyWorkspaceDiffHunkMutationSchema, {
      workspaceId: "workspace-review",
      action: contract.WorkspaceDiffAction.UNSTAGE,
      source: contract.GitDiffSource.STAGED,
      target: contract.WorkspaceDiffTarget.FILE,
      relativePath: "src/review.ts",
      expectedRepositoryRevision: "fence"
    });
    const response = await submit(application([], applyGitDiff), value);
    expect(response.operation?.state).toBe(contract.OperationState.FAILED);
    expect(response.operation?.error?.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(response.operation?.error?.message).toContain("workspace.diff.unstage");
    expect(applyGitDiff).not.toHaveBeenCalled();
  });
});
