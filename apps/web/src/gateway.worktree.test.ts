import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListTargetWorktreeSourcesResponseSchema,
  OperationState,
  ProbeTargetWorktreeResponseSchema,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  WorktreeEligibility
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("isolated-workspace gateway", () => {
  it("probes and completely pages only the exact selected Target", async () => {
    const requests: Array<{ readonly method: string; readonly input: unknown }> = [];
    const transport = transportWithSnapshot(async (method, input) => {
      requests.push({ method: method.localName, input });
      if (method.localName === "probeTargetWorktree") {
        return response(method, create(ProbeTargetWorktreeResponseSchema, {
          targetId: "target-1",
          eligibility: WorktreeEligibility.ELIGIBLE,
          repositoryRootDisplay: "D:\\workspace",
          currentBranch: "main",
          headCommit: "0123456789abcdef",
          canRefreshRemote: true
        }));
      }
      if (method.localName === "listTargetWorktreeSources") {
        return response(method, create(ListTargetWorktreeSourcesResponseSchema, input.page?.pageToken === ""
          ? {
              sources: [{ ref: "refs/heads/main", commit: "0123456789abcdef", displayName: "main", current: true }],
              page: { nextPageToken: "source-page-2", totalSize: 2n }
            }
          : {
              sources: [{ ref: "refs/remotes/origin/release", commit: "fedcba9876543210", displayName: "origin/release", remote: true }],
              page: { totalSize: 2n }
            }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    });
    const gateway = createOrchestratorGateway(profile("worktree-query"), "secret", {}, () => transport);
    await gateway.connect();
    requests.length = 0;

    await expect(gateway.probeTargetWorktree("target-1")).resolves.toEqual({
      targetId: "target-1",
      eligibility: "eligible",
      repositoryRoot: "D:\\workspace",
      currentBranch: "main",
      headCommit: "0123456789abcdef",
      canRefreshRemote: true
    });
    await expect(gateway.listTargetWorktreeSources("target-1")).resolves.toEqual([
      { ref: "refs/heads/main", commit: "0123456789abcdef", name: "main", remote: false, current: true },
      { ref: "refs/remotes/origin/release", commit: "fedcba9876543210", name: "origin/release", remote: true, current: false }
    ]);
    expect(requests).toEqual([
      { method: "probeTargetWorktree", input: { targetId: "target-1" } },
      { method: "listTargetWorktreeSources", input: { targetId: "target-1", page: { pageSize: 500, pageToken: "" } } },
      { method: "listTargetWorktreeSources", input: { targetId: "target-1", page: { pageSize: 500, pageToken: "source-page-2" } } }
    ]);
    gateway.disconnect();
  });

  it("submits one fresh-task isolation intent and never silently attaches it to native history", async () => {
    const payloads: any[] = [];
    const transport = transportWithSnapshot(async (method, input) => {
      if (method.localName !== "submitOperation") throw new Error(`Unexpected method: ${method.localName}`);
      payloads.push(input.mutation?.payload);
      return response(method, create(SubmitOperationResponseSchema, {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED,
          result: {
            payload: {
              case: "session",
              value: { sessionId: "session-isolated", backendId: "pi", targetId: "target-1", displayName: "Isolated" }
            }
          }
        }
      }));
    });
    const gateway = createOrchestratorGateway(profile("worktree-create"), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.createSession({
      targetId: "target-1",
      name: "Isolated",
      nativeStart: { kind: "fresh" },
      providerId: "",
      modelId: "",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      worktree: { sourceRef: "refs/remotes/origin/release", refreshRemote: true }
    })).resolves.toBe("session-isolated");
    expect(payloads[0]).toMatchObject({
      case: "createSession",
      value: {
        targetId: "target-1",
        useWorktree: true,
        worktreeSourceRef: "refs/remotes/origin/release",
        refreshWorktreeRemote: true
      }
    });

    await expect(gateway.createSession({
      targetId: "target-1",
      name: "Existing",
      nativeStart: { kind: "attach", reference: "native-existing" },
      providerId: "",
      modelId: "",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      worktree: { refreshRemote: false }
    })).rejects.toThrow("requires a fresh task");
    expect(payloads).toHaveLength(1);
    gateway.disconnect();
  });
});

function profile(id: string) {
  return { id, deviceId: `device-${id}`, serverId: `server-${id}`, name: "Browser", origin: "https://orchestrator.example" } as const;
}

function transportWithSnapshot(
  handler: (method: any, input: any) => Promise<any>
): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            targets: [{ targetId: "target-1", backendId: "pi", displayName: "Workspace", workspaceId: "workspace-1" }]
          })
        }));
      }
      return handler(method, input);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
