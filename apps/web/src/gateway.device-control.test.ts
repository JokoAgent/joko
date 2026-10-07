import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  DeviceKind,
  DevicePresenceState,
  EntityKind,
  EventSchema,
  GetOperationResponseSchema,
  GetSnapshotResponseSchema,
  OperationState,
  OperationSchema,
  type Operation,
  type OperationMutation,
  type SubmitOperationRequest,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot, projectSnapshotEvent } from "./gateway.js";

describe("device control gateway", () => {
  it("maps device presence, receive consent, and directed relation versions", () => {
    const projected = mapSnapshot(create(SnapshotSchema, {
      devices: [
        {
          deviceId: "desk",
          displayName: "Desk",
          defaultDisplayName: "System desk",
          manualDisplayName: "Desk",
          version: { revision: { value: 7n } },
          kind: DeviceKind.DESKTOP,
          platform: "win32",
          appVersion: "1.0.0",
          remoteControlEnabled: true,
          presence: DevicePresenceState.ONLINE,
          lastSeenAt: { seconds: 12n, nanos: 500_000_000 }
        },
        {
          deviceId: "browser",
          displayName: "Browser",
          defaultDisplayName: "Web Device",
          version: { revision: { value: 4n } },
          kind: DeviceKind.WEB,
          platform: "web",
          appVersion: "1.0.0",
          remoteControlEnabled: false,
          presence: DevicePresenceState.OFFLINE
        },
        {
          deviceId: "phone",
          displayName: "Phone",
          defaultDisplayName: "Phone",
          version: { revision: { value: 5n } },
          kind: DeviceKind.MOBILE,
          platform: "android",
          appVersion: "0.1.0",
          presence: DevicePresenceState.ONLINE
        }
      ],
      deviceControlRelations: [{
        relationId: "browser:desk",
        controllerDeviceId: "browser",
        targetDeviceId: "desk",
        outboundEnabled: true,
        inboundAllowed: false,
        effective: false,
        updatedAt: { seconds: 20n, nanos: 0 },
        version: { revision: { value: 9n } }
      }]
    }));

    expect(projected.devices).toEqual([
      {
        id: "desk",
        name: "Desk",
        defaultDisplayName: "System desk",
        manualDisplayName: "Desk",
        revision: 7n,
        kind: "desktop",
        platform: "win32",
        appVersion: "1.0.0",
        revoked: false,
        remoteControlEnabled: true,
        presence: "online",
        lastSeenAt: 12_500
      },
      {
        id: "browser",
        name: "Browser",
        defaultDisplayName: "Web Device",
        revision: 4n,
        kind: "web",
        platform: "web",
        appVersion: "1.0.0",
        revoked: false,
        remoteControlEnabled: false,
        presence: "offline"
      },
      {
        id: "phone",
        name: "Phone",
        defaultDisplayName: "Phone",
        revision: 5n,
        kind: "mobile",
        platform: "android",
        appVersion: "0.1.0",
        revoked: false,
        remoteControlEnabled: false,
        presence: "online"
      }
    ]);
    expect(projected.deviceControlRelations).toEqual([{
      id: "browser:desk",
      controllerDeviceId: "browser",
      targetDeviceId: "desk",
      outboundEnabled: true,
      inboundAllowed: false,
      effective: false,
      updatedAt: 20_000,
      revision: 9n
    }]);
  });

  it("submits typed mutations for identity, global opt-in, and both consent sides", async () => {
    const payloads: OperationMutation["payload"][] = [];
    const requests: SubmitOperationRequest[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(payloads, requests)
    );
    await gateway.connect();

    const renamed = await gateway.renameDevice("desk", "  Main desk  ", 7n);
    const reset = await gateway.resetDeviceName("desk", renamed.revision);
    await gateway.setDeviceRemoteControlEnabled(true);
    await gateway.setDeviceControlTargetEnabled("build-node", false);
    await gateway.setDeviceControllerAllowed("browser", false);

    expect(payloads).toEqual([
      expect.objectContaining({
        case: "renameDevice",
        value: expect.objectContaining({ deviceId: "desk", displayName: "Main desk" })
      }),
      expect.objectContaining({
        case: "resetDeviceName",
        value: expect.objectContaining({ deviceId: "desk" })
      }),
      expect.objectContaining({
        case: "setDeviceRemoteControlEnabled",
        value: expect.objectContaining({ enabled: true })
      }),
      expect.objectContaining({
        case: "setDeviceControlTargetEnabled",
        value: expect.objectContaining({ targetDeviceId: "build-node", enabled: false })
      }),
      expect.objectContaining({
        case: "setDeviceControllerAllowed",
        value: expect.objectContaining({ controllerDeviceId: "browser", allowed: false })
      })
    ]);
    expect(requests[0]?.mutation?.preconditions).toEqual([expect.objectContaining({
      entity: expect.objectContaining({ kind: EntityKind.DEVICE, id: "desk" }), expectedRevision: expect.objectContaining({ value: 7n })
    })]);
    expect(requests[1]?.mutation?.preconditions[0]?.expectedRevision?.value).toBe(8n);
    expect(renamed).toMatchObject({ id: "desk", name: "Main desk", defaultDisplayName: "System desk", manualDisplayName: "Main desk", revision: 8n });
    expect(reset).toMatchObject({ id: "desk", name: "System desk", defaultDisplayName: "System desk", revision: 9n });
    expect(reset.manualDisplayName).toBeUndefined();
    gateway.disconnect();
  });

  it("projects full Device name changes into the directory without regressing an accepted Device revision", () => {
    const initial = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n }, devices: [{
      deviceId: "desk", displayName: "Manual", defaultDisplayName: "First OS name", manualDisplayName: "Manual", version: { revision: { value: 7n } }
    }] });
    const updated = projectSnapshotEvent(initial, mapSnapshot(initial), create(EventSchema, {
      eventId: "name-source-changed", cursor: { generation: 1n, sequence: 1n }, payload: { kind: { case: "deviceChanged", value: { device: {
        deviceId: "desk", displayName: "Manual", defaultDisplayName: "New OS name", manualDisplayName: "Manual", version: { revision: { value: 8n } }
      } } } }
    }));
    expect(updated.snapshot.devices[0]).toMatchObject({ name: "Manual", defaultDisplayName: "New OS name", manualDisplayName: "Manual", revision: 8n });
    const reset = projectSnapshotEvent(updated.rawSnapshot, updated.snapshot, create(EventSchema, {
      eventId: "name-reset", cursor: { generation: 1n, sequence: 2n }, payload: { kind: { case: "deviceChanged", value: { device: {
        deviceId: "desk", displayName: "New OS name", defaultDisplayName: "New OS name", version: { revision: { value: 9n } }
      } } } }
    }));
    expect(reset.snapshot.devices[0]).toMatchObject({ name: "New OS name", defaultDisplayName: "New OS name", revision: 9n });
    expect(reset.snapshot.devices[0]?.manualDisplayName).toBeUndefined();
    const stale = projectSnapshotEvent(reset.rawSnapshot, reset.snapshot, create(EventSchema, {
      eventId: "old-device", cursor: { generation: 1n, sequence: 3n }, payload: { kind: { case: "deviceChanged", value: { device: initial.devices[0] } } }
    }));
    expect(stale.snapshot.devices).toEqual(reset.snapshot.devices);
    expect(stale.rawSnapshot.devices).toEqual(reset.rawSnapshot.devices);
    expect(stale.snapshot.cursor).toBe(3n);
  });

  it("keeps the original receipt through bounded same-id retries and reads it without sending another name effect", async () => {
    const requests: SubmitOperationRequest[] = [];
    let settled = false;
    const gateway = createOrchestratorGateway(
      { id: "uncertain-connection", deviceId: "self", name: "Local", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret", {}, () => operationTransport([], requests, {
        submit: () => { throw new ConnectError("Response lost", Code.Unavailable); },
        read: () => {
          const request = requests[0];
          if (request === undefined) throw new Error("Receipt was not submitted");
          return settled ? deviceNameOperation(request) : create(OperationSchema, {
            operationId: request.operationId, connectionId: request.connectionId, mutation: request.mutation, state: OperationState.RUNNING
          });
        }
      })
    );
    await gateway.connect();
    await expect(gateway.renameDevice("lost-device", "Manual", 7n)).rejects.toMatchObject({ code: "DEVICE_NAME_UNCONFIRMED" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.operationId).toBe(requests[1]?.operationId);
    expect(gateway.hasPendingDeviceNameUpdate("lost-device")).toBe(true);
    await expect(gateway.resetDeviceName("lost-device", 7n)).rejects.toMatchObject({ code: "DEVICE_NAME_UNCONFIRMED" });
    await expect(gateway.checkDeviceNameUpdate("lost-device")).rejects.toMatchObject({ code: "DEVICE_NAME_UNCONFIRMED" });
    settled = true;
    expect(await gateway.checkDeviceNameUpdate("lost-device")).toMatchObject({ id: "lost-device", name: "Manual", manualDisplayName: "Manual", revision: 8n });
    expect(gateway.hasPendingDeviceNameUpdate("lost-device")).toBe(false);
    expect(requests).toHaveLength(2);
    gateway.disconnect();
  });

  it.each([OperationState.FAILED, OperationState.CONFLICT])("does not resend a terminal name failure %s or keep it locked as unknown", async (state) => {
    const requests: SubmitOperationRequest[] = [];
    const gateway = createOrchestratorGateway(
      { id: `failed-${state}`, deviceId: "self", name: "Local", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret", {}, () => operationTransport([], requests, {
        submit: (request) => create(OperationSchema, {
          operationId: request.operationId, connectionId: request.connectionId, state, error: { message: "Device revision changed" }
        })
      })
    );
    await gateway.connect();
    await expect(gateway.resetDeviceName("desk", 7n)).rejects.toThrow("Device revision changed");
    expect(requests).toHaveLength(1);
    expect(gateway.hasPendingDeviceNameUpdate("desk")).toBe(false);
    gateway.disconnect();
  });

  it.each(["wrong-device", "missing-result"])("keeps an unconfirmed typed outcome locked when it is %s", async (kind) => {
    const requests: SubmitOperationRequest[] = [];
    const gateway = createOrchestratorGateway(
      { id: `typed-${kind}`, deviceId: "self", name: "Local", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret", {}, () => operationTransport([], requests, {
        submit: (request) => {
          const result = deviceNameOperation(request);
          if (kind === "missing-result") result.result = undefined;
          else if (result.result?.payload.case === "device") result.result.payload.value.deviceId = "other-device";
          return result;
        }
      })
    );
    await gateway.connect();
    await expect(gateway.resetDeviceName("desk", 7n)).rejects.toMatchObject({ code: "DEVICE_NAME_UNCONFIRMED" });
    expect(gateway.hasPendingDeviceNameUpdate("desk")).toBe(true);
    expect(requests).toHaveLength(1);
    gateway.disconnect();
  });
});

function operationTransport(payloads: OperationMutation["payload"][], requests: SubmitOperationRequest[] = [], behavior: {
  readonly submit?: (request: SubmitOperationRequest) => Operation;
  readonly read?: () => Operation;
} = {}): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n }
          })
        }));
      }
      if (method.localName === "submitOperation") {
        const request = input as SubmitOperationRequest;
        if (request.mutation === undefined) throw new Error("Mutation missing");
        payloads.push(request.mutation.payload);
        requests.push(request);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: behavior.submit?.(request) ?? deviceNameOperation(request)
        }));
      }
      if (method.localName === "getOperation" && behavior.read !== undefined) {
        return response(method, create(GetOperationResponseSchema, { operation: behavior.read() }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function deviceNameOperation(request: SubmitOperationRequest): Operation {
  const mutation = request.mutation?.payload;
  const manualDisplayName = mutation?.case === "renameDevice" ? mutation.value.displayName : undefined;
  return create(OperationSchema, {
    operationId: request.operationId, connectionId: request.connectionId, mutation: request.mutation, state: OperationState.SUCCEEDED,
    ...((mutation?.case === "renameDevice" || mutation?.case === "resetDeviceName") ? {
      result: { payload: { case: "device", value: {
        deviceId: mutation.value.deviceId, displayName: manualDisplayName ?? "System desk", defaultDisplayName: "System desk",
        ...(manualDisplayName === undefined ? {} : { manualDisplayName }),
        version: { revision: { value: (request.mutation?.preconditions[0]?.expectedRevision?.value ?? 0n) + 1n } }
      } } }
    } : {})
  });
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
