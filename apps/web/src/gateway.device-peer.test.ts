import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  DeviceKind,
  DevicePeerCapabilityKind,
  DevicePeerDirectoryAvailability,
  DevicePeerDirectoryKind,
  DevicePresenceState,
  GetSnapshotResponseSchema,
  InspectDevicePeerDirectoryResponseSchema,
  ListDevicePeerDirectoriesResponseSchema,
  ListDevicePeerRecentDirectoriesResponseSchema,
  ListDevicePeersResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import type { DevicePeerRouteIdentityView } from "./model.js";

const ROUTE: DevicePeerRouteIdentityView = {
  targetDeviceId: "peer-device",
  relationId: "relation-one",
  targetDeviceRevision: 7n,
  relationRevision: 0n,
  routeGeneration: 11n
};

describe("Device peer project gateway", () => {
  it("keeps the exact route through catalog, recent, browse, inspect, and target creation", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const gateway = createOrchestratorGateway(
      { id: "peer-project", deviceId: "controller-device", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", {}, () => peerTransport((method, input) => {
        requests.push({ method, input });
        if (method === "listDevicePeers") {
          return create(ListDevicePeersResponseSchema, { peers: [{
            route: routeMessage(), displayName: "Studio PC", kind: DeviceKind.DESKTOP,
            platform: "win32", presence: DevicePresenceState.ONLINE,
            capabilities: [DevicePeerCapabilityKind.FILES, DevicePeerCapabilityKind.PROCESS]
          }] });
        }
        if (method === "listDevicePeerRecentDirectories") {
          return create(ListDevicePeerRecentDirectoriesResponseSchema, {
            peer: routeMessage(),
            directories: [{
              name: "repo", path: "C:\\work\\repo",
              availability: DevicePeerDirectoryAvailability.EXISTS,
              lastUsedAt: { seconds: 123n, nanos: 456_000_000 }
            }]
          });
        }
        if (method === "listDevicePeerDirectories") {
          return create(ListDevicePeerDirectoriesResponseSchema, {
            peer: routeMessage(), path: "C:\\Users\\maker", parentPath: "C:\\Users",
            directories: [{ name: "repo", path: "C:\\Users\\maker\\repo" }]
          });
        }
        if (method === "inspectDevicePeerDirectory") {
          return create(InspectDevicePeerDirectoryResponseSchema, {
            peer: routeMessage(), path: "C:\\work\\new", kind: DevicePeerDirectoryKind.MISSING
          });
        }
        if (method === "submitOperation") {
          return create(SubmitOperationResponseSchema, { operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "target", value: { targetId: "peer-target" } } }
          } });
        }
        throw new Error(`Unexpected method: ${method}`);
      })
    );
    await gateway.connect();

    await expect(gateway.listDevicePeers()).resolves.toEqual([{
      route: ROUTE, name: "Studio PC", kind: "desktop", platform: "win32", capabilities: ["files", "process"]
    }]);
    await expect(gateway.listDevicePeerRecentDirectories(ROUTE)).resolves.toEqual([{
      name: "repo", path: "C:\\work\\repo", availability: "exists", lastUsedAt: 123_456
    }]);
    await expect(gateway.listDevicePeerDirectories(ROUTE, "")).resolves.toEqual({
      peer: ROUTE, path: "C:\\Users\\maker", parentPath: "C:\\Users",
      directories: [{ name: "repo", path: "C:\\Users\\maker\\repo" }], truncated: false
    });
    await expect(gateway.inspectDevicePeerDirectory(ROUTE, "C:\\work\\new")).resolves.toEqual({
      peer: ROUTE, path: "C:\\work\\new", kind: "missing"
    });
    await expect(gateway.createDevicePeerTarget({
      backendId: "pi", name: "  Peer project  ", peer: ROUTE,
      workspacePath: "C:\\work\\new", createIfMissing: true
    })).resolves.toBe("peer-target");

    const expectedPeer = routeMessage();
    expect(requests.find(({ method }) => method === "listDevicePeerRecentDirectories")?.input).toEqual({
      peer: expectedPeer, page: { pageSize: 200, pageToken: "" }
    });
    expect(requests.find(({ method }) => method === "listDevicePeerDirectories")?.input).toEqual({
      peer: expectedPeer, path: ""
    });
    expect(requests.find(({ method }) => method === "inspectDevicePeerDirectory")?.input).toEqual({
      peer: expectedPeer, path: "C:\\work\\new"
    });
    expect(requests.find(({ method }) => method === "submitOperation")?.input.mutation).toMatchObject({
      payload: { case: "createDevicePeerTarget", value: {
        backendId: "pi", displayName: "Peer project", peer: expectedPeer,
        workspacePath: "C:\\work\\new", createIfMissing: true
      } }
    });
    gateway.disconnect();
  });

  it("rejects an asynchronous result after any exact route component advances", async () => {
    let routeGeneration = ROUTE.routeGeneration;
    const gateway = createOrchestratorGateway(
      { id: "peer-fence", deviceId: "controller-device", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", {}, () => peerTransport((method) => {
        if (method !== "inspectDevicePeerDirectory") throw new Error(`Unexpected method: ${method}`);
        return create(InspectDevicePeerDirectoryResponseSchema, {
          peer: routeMessage({ routeGeneration }), path: "C:\\work\\repo", kind: DevicePeerDirectoryKind.DIRECTORY
        });
      })
    );
    await gateway.connect();

    await expect(gateway.inspectDevicePeerDirectory(ROUTE, "C:\\work\\repo")).resolves.toMatchObject({ kind: "directory" });
    routeGeneration += 1n;
    await expect(gateway.inspectDevicePeerDirectory(ROUTE, "C:\\work\\repo"))
      .rejects.toThrow("another Device peer route or path");
    gateway.disconnect();
  });

  it("maps a host-native Device project location without persisting live route authority", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, { targets: [{
      targetId: "target-one", backendId: "pi", workspaceId: "workspace-one",
      version: { revision: { value: 3n } },
      location: { kind: { case: "devicePeer", value: {
        controllerDeviceId: "controller-device", targetDeviceId: "peer-device",
        workspaceRootDisplay: "C:\\work\\repo"
      } } }
    }] }));
    expect(snapshot.targets[0]?.remoteWorkspace).toEqual({
      kind: "device_peer", controllerDeviceId: "controller-device",
      targetDeviceId: "peer-device", workspaceRoot: "C:\\work\\repo"
    });
  });
});

function routeMessage(patch: Partial<DevicePeerRouteIdentityView> = {}): any {
  const route = { ...ROUTE, ...patch };
  return {
    targetDeviceId: route.targetDeviceId,
    relationId: route.relationId,
    targetDeviceRevision: { value: route.targetDeviceRevision },
    relationRevision: { value: route.relationRevision },
    routeGeneration: route.routeGeneration
  };
}

function peerTransport(handler: (method: string, input: any) => unknown): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
        }));
      }
      return response(method, await handler(method.localName, input));
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
