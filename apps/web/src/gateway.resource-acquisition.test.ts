import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  ManagedResourceSchema,
  OperationState,
  ResourceAcquisitionKind,
  ResourceKind,
  ResourceScope,
  ResourceState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import type { ResourceDraft } from "./model.js";

describe("managed resource acquisition gateway", () => {
  it("preserves opaque remote project origins and independent same-name approval and loaded states", () => {
    const remote = create(ManagedResourceSchema, {
      resourceId: "resource-remote-one", backendId: "owner", targetId: "registered-project",
      kind: ResourceKind.SKILL, name: "Review", state: ResourceState.AWAITING_APPROVAL,
      discoveredRevision: "sha256:captured-tree",
      source: { scope: ResourceScope.PROJECT, acquisitionKind: ResourceAcquisitionKind.REMOTE_PROJECT,
        sourceDisplay: "review", sourceIdentity: "remote-source:one" }
    });
    const result = mapSnapshot(create(SnapshotSchema, { resources: [remote,
      { ...remote, resourceId: "resource-remote-two", state: ResourceState.LOADED, enabled: true,
        source: { ...remote.source!, sourceIdentity: "remote-source:two" } },
      { ...remote, resourceId: "resource-service-local",
        source: { ...remote.source!, acquisitionKind: ResourceAcquisitionKind.LOCAL, sourceDisplay: "service-node-directory" } }
    ] }));
    expect(result.resources).toMatchObject([
      { id: "resource-remote-one", sourceKind: "remoteProject", sourceIdentity: "remote-source:one", state: "awaitingApproval", enabled: false },
      { id: "resource-remote-two", sourceKind: "remoteProject", sourceIdentity: "remote-source:two", state: "loaded", enabled: true },
      { id: "resource-service-local", sourceKind: "local", source: "service-node-directory" }
    ]);
  });

  it.each(["path", "scope", "target", "identity", "unknown-kind"] as const)("rejects unsafe remote project output: %s", (problem) => {
    const remote = create(ManagedResourceSchema, {
      resourceId: "resource-remote", backendId: "owner", targetId: problem === "target" ? "" : "project",
      kind: ResourceKind.SKILL, name: "Review", state: ResourceState.AWAITING_APPROVAL,
      discoveredRevision: "sha256:captured",
      source: { scope: problem === "scope" ? ResourceScope.GLOBAL : ResourceScope.PROJECT,
        acquisitionKind: problem === "unknown-kind" ? 99 as ResourceAcquisitionKind : ResourceAcquisitionKind.REMOTE_PROJECT,
        sourceDisplay: problem === "path" ? "/home/private/project/.agents/skills/review" : "review",
        sourceIdentity: problem === "identity" ? "" : "remote-source:one" }
    });
    expect(() => mapSnapshot(create(SnapshotSchema, { resources: [remote] }))).toThrow(/source is invalid|kind is invalid/u);
  });

  it("rejects remote project acquisition input before dispatch while preserving service-node local input", async () => {
    const submitted: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret", {}, () => operationTransport(submitted)
    );
    await gateway.connect();
    await expect(gateway.addResource({ backendId: "owner", targetId: "project", kind: "skill", scope: "project",
      name: "Review", version: "", source: { kind: "remoteProject", serverPath: "/remote/private" }
    } as unknown as ResourceDraft)).rejects.toThrow("source is invalid");
    expect(submitted).toEqual([]);
    gateway.disconnect();
  });

  it("encodes local, npm, and Git drafts as typed acquisition oneofs", async () => {
    const submitted: any[] = [];
    const transport = operationTransport(submitted);
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const drafts: readonly ResourceDraft[] = [
      {
        backendId: "backend",
        kind: "skill",
        scope: "managed",
        source: { kind: "local", serverPath: "D:\\pi-resources\\skill" },
        name: "Local skill",
        version: ""
      },
      {
        backendId: "backend",
        kind: "package",
        scope: "global",
        source: { kind: "npm", packageName: "@joko/example", versionSpec: "^1.2.0" },
        name: "Npm package",
        version: "1.2.0"
      },
      {
        backendId: "backend",
        kind: "package",
        scope: "user",
        source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "main", subdirectory: "packages/agent" },
        name: "Git package",
        version: ""
      }
    ];
    for (const draft of drafts) await gateway.addResource(draft);

    expect(submitted.map((payload) => payload.case)).toEqual(["addResource", "addResource", "addResource"]);
    expect(submitted[0]?.value).toMatchObject({
      backendId: "backend",
      acquisition: { source: { case: "local", value: { serverPath: "D:\\pi-resources\\skill" } } }
    });
    expect(submitted[1]?.value).toMatchObject({
      name: "Npm package",
      version: "1.2.0",
      acquisition: { source: { case: "npm", value: { packageName: "@joko/example", versionSpec: "^1.2.0" } } }
    });
    expect(submitted[2]?.value).toMatchObject({
      acquisition: { source: { case: "git", value: { repositoryUrl: "https://example.test/org/repo.git", ref: "main", subdirectory: "packages/agent" } } }
    });
    for (const payload of submitted) expect(payload.value).not.toHaveProperty("serverPath");
    gateway.disconnect();
  });

  it("rejects a remote source for a non-package resource before submission", async () => {
    const submitted: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(submitted)
    );
    await gateway.connect();

    await expect(gateway.addResource({
      backendId: "backend",
      kind: "skill",
      scope: "managed",
      source: { kind: "npm", packageName: "example", versionSpec: "" },
      name: "",
      version: ""
    })).rejects.toThrow("source is invalid");
    expect(submitted).toEqual([]);
    gateway.disconnect();
  });

  it("submits the exact resource revision selected by the caller", async () => {
    const submitted: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(submitted)
    );
    await gateway.connect();

    await gateway.approveResource("resource-one", "sha256:selected-revision");

    expect(submitted).toMatchObject([{
      case: "approveResource",
      value: {
        resourceId: "resource-one",
        discoveredRevision: "sha256:selected-revision"
      }
    }]);
    gateway.disconnect();
  });
});

function operationTransport(submitted: any[]): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
        }));
      }
      if (method.localName === "listManagedModelRuntimes") {
        return response(method, create(ListManagedModelRuntimesResponseSchema, {}));
      }
      if (method.localName === "submitOperation") {
        submitted.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
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
