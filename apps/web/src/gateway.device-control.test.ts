import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  DeviceKind,
  DevicePresenceState,
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";

describe("device control gateway", () => {
  it("maps device presence, receive consent, and directed relation versions", () => {
    const projected = mapSnapshot(create(SnapshotSchema, {
      devices: [
        {
          deviceId: "desk",
          displayName: "Desk",
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
          kind: DeviceKind.WEB,
          platform: "web",
          appVersion: "1.0.0",
          remoteControlEnabled: false,
          presence: DevicePresenceState.OFFLINE
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
        kind: "web",
        platform: "web",
        appVersion: "1.0.0",
        revoked: false,
        remoteControlEnabled: false,
        presence: "offline"
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
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(payloads)
    );
    await gateway.connect();

    await gateway.renameDevice("desk", "  Main desk  ");
    await gateway.setDeviceRemoteControlEnabled(true);
    await gateway.setDeviceControlTargetEnabled("build-node", false);
    await gateway.setDeviceControllerAllowed("browser", false);

    expect(payloads).toEqual([
      expect.objectContaining({
        case: "renameDevice",
        value: expect.objectContaining({ deviceId: "desk", displayName: "Main desk" })
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
    gateway.disconnect();
  });
});

function operationTransport(payloads: any[]): Transport {
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
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED
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
