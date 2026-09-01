import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CapabilitySupport,
  CreateRemoteHostResponseSchema,
  GetRemoteHostCapabilitiesResponseSchema,
  GetSnapshotResponseSchema,
  ListRemoteHostsResponseSchema,
  OperationState,
  RemoteHostAuthenticationMode,
  RemoteHostCapabilityKind,
  RemoteHostFailureCode,
  RemoteHostSource,
  RemoteHostStatus,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  TestRemoteHostConnectionResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";

describe("Remote Host gateway", () => {
  it("uses generated contracts for capability, CRUD, status, TOFU, and remote workspace binding", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    let snapshot: AppSnapshot | undefined;
    const transport = remoteTransport((method, input) => {
      requests.push({ method, input });
      if (method === "getRemoteHostCapabilities") {
        return create(GetRemoteHostCapabilitiesResponseSchema, {
          capabilities: [
            RemoteHostCapabilityKind.CATALOG,
            RemoteHostCapabilityKind.MANAGEMENT,
            RemoteHostCapabilityKind.CONNECTION_TEST,
            RemoteHostCapabilityKind.PROCESS_STREAMING,
            RemoteHostCapabilityKind.FILE_TRANSFER,
            RemoteHostCapabilityKind.TCP_FORWARDING
          ].map((kind) => ({ kind, name: `capability-${kind}`, support: CapabilitySupport.SUPPORTED }))
        });
      }
      if (method === "listRemoteHosts") {
        return create(ListRemoteHostsResponseSchema, { hosts: [host()], page: { totalSize: 1n } });
      }
      if (method === "createRemoteHost") return create(CreateRemoteHostResponseSchema, { host: host() });
      if (method === "testRemoteHostConnection") {
        return create(TestRemoteHostConnectionResponseSchema, { result: { outcome: 1, host: host() } });
      }
      if (method === "submitOperation") {
        return create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED
          }
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-connection", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      { onSnapshot: (value) => { snapshot = value; } },
      () => transport
    );
    await gateway.connect();

    expect(snapshot?.targets[0]?.remoteWorkspace).toEqual({
      hostId: "build-box",
      workspaceRoot: "/srv/project"
    });
    await expect(gateway.getRemoteHostCapabilities("target-one")).resolves.toMatchObject({
      catalog: true,
      management: true,
      connectionTest: true,
      processStreaming: true,
      fileTransfer: true,
      tcpForwarding: true,
      connectionControl: false,
      commandExecution: false
    });
    await expect(gateway.listRemoteHosts("target-one")).resolves.toEqual([{
      targetId: "target-one",
      id: "build-box",
      hostname: "build.internal",
      port: 22,
      user: "joko",
      source: "manual",
      authentication: "privateKey",
      credentialReferenceId: "ssh-key-reference",
      trust: {
        algorithm: "ssh-ed25519",
        sha256Fingerprint: "SHA256:public-fingerprint",
        pinnedAt: 10_000
      },
      status: {
        state: "failed",
        changedAt: 11_000,
        failure: { code: "hostKeyChanged", retryable: false }
      },
      revision: 4n
    }]);
    await gateway.createRemoteHost("target-one", {
      id: "build-box",
      hostname: "build.internal",
      port: 22,
      user: "joko",
      authentication: "privateKey",
      credentialReferenceId: "ssh-key-reference"
    });
    await gateway.testRemoteHostConnection("target-one", "build-box", 4n);
    await gateway.updateTarget("target-one", {
      workspaceLocation: { kind: "remote", hostId: "build-box", workspaceRoot: "  /srv/project  " }
    });

    expect(requests.find((request) => request.method === "listRemoteHosts")?.input).toEqual({
      targetId: "target-one",
      page: { pageSize: 500, pageToken: "" }
    });
    const createInput = requests.find((request) => request.method === "createRemoteHost")?.input;
    expect(createInput).toMatchObject({
      targetId: "target-one",
      hostId: "build-box",
      authenticationMode: RemoteHostAuthenticationMode.PRIVATE_KEY,
      credentialReferenceId: "ssh-key-reference"
    });
    expect(JSON.stringify(createInput)).not.toContain("PRIVATE KEY");
    expect(requests.find((request) => request.method === "testRemoteHostConnection")?.input).toEqual({
      targetId: "target-one",
      hostId: "build-box",
      expectedRevision: { value: 4n }
    });
    expect(requests.find((request) => request.method === "submitOperation")?.input.mutation.payload).toMatchObject({
      case: "updateTarget",
      value: {
        targetId: "target-one",
        workspaceLocationUpdate: {
          case: "remoteWorkspace",
          value: { hostId: "build-box", workspaceRootDisplay: "/srv/project" }
        }
      }
    });
    gateway.disconnect();
  });

  it("fails closed on an incomplete private-key projection", async () => {
    const transport = remoteTransport((method) => {
      if (method === "listRemoteHosts") {
        return create(ListRemoteHostsResponseSchema, {
          hosts: [host({ credentialReferenceId: undefined })],
          page: { totalSize: 1n }
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-malformed", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => transport
    );
    await gateway.connect();
    await expect(gateway.listRemoteHosts("target-one")).rejects.toThrow("inconsistent Remote Host authentication");
    gateway.disconnect();
  });

  it("collects every Remote Host page and rejects a cyclic cursor without publishing a partial catalog", async () => {
    const pageTokens: string[] = [];
    const transport = remoteTransport((method, input) => {
      if (method !== "listRemoteHosts") throw new Error(`Unexpected method: ${method}`);
      pageTokens.push(input.page.pageToken);
      return input.page.pageToken === ""
        ? create(ListRemoteHostsResponseSchema, {
            hosts: [host({ hostId: "build-a", hostname: "a.internal" })],
            page: { nextPageToken: "page-2", totalSize: 2n }
          })
        : create(ListRemoteHostsResponseSchema, {
            hosts: [host({ hostId: "build-b", hostname: "b.internal" })],
            page: { totalSize: 2n }
          });
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-pages", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.listRemoteHosts("target-one")).resolves.toMatchObject([
      { id: "build-a" },
      { id: "build-b" }
    ]);
    expect(pageTokens).toEqual(["", "page-2"]);
    gateway.disconnect();

    let calls = 0;
    const cyclicGateway = createOrchestratorGateway(
      { id: "remote-cycle", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => remoteTransport((method) => {
        if (method !== "listRemoteHosts") throw new Error(`Unexpected method: ${method}`);
        calls += 1;
        return create(ListRemoteHostsResponseSchema, {
          hosts: [host()],
          page: { nextPageToken: "loop", totalSize: 2n }
        });
      })
    );
    await cyclicGateway.connect();
    await expect(cyclicGateway.listRemoteHosts("target-one")).rejects.toThrow("cyclic Remote Host catalog page token");
    expect(calls).toBe(2);
    cyclicGateway.disconnect();
  });
});

function remoteTransport(handler: (method: string, input: any) => unknown): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            targets: [{
              targetId: "target-one",
              backendId: "pi",
              displayName: "Project",
              workspaceId: "workspace-one",
              remoteWorkspace: { hostId: "build-box", workspaceRootDisplay: "/srv/project" }
            }]
          })
        }));
      }
      return response(method, handler(method.localName, input));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function host(patch: Record<string, unknown> = {}): any {
  return {
    targetId: "target-one",
    hostId: "build-box",
    hostname: "build.internal",
    port: 22,
    user: "joko",
    source: RemoteHostSource.MANUAL,
    authenticationMode: RemoteHostAuthenticationMode.PRIVATE_KEY,
    credentialReferenceId: "ssh-key-reference",
    trust: {
      algorithm: "ssh-ed25519",
      sha256Fingerprint: "SHA256:public-fingerprint",
      pinnedAt: { seconds: 10n, nanos: 0 }
    },
    status: {
      state: RemoteHostStatus.FAILED,
      changedAt: { seconds: 11n, nanos: 0 },
      failure: { code: RemoteHostFailureCode.HOST_KEY_CHANGED, retryable: false }
    },
    revision: { value: 4n },
    ...patch
  };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
