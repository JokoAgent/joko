import { create, type MessageInitShape } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { operationBodyHash, OperationalStore, type OperationRecord } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("Device control Connect surface", () => {
  it("keeps control ineffective until the authenticated target and controller both consent", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const controller = store.createConnection({
      id: "connection-controller",
      deviceId: "device-controller",
      device: { name: "Controller", kind: "desktop", platform: "windows" },
      name: "Controller",
      authKeyDigest: "controller-digest"
    });
    const target = store.createConnection({
      id: "connection-target",
      deviceId: "device-target",
      device: { name: "Target", kind: "desktop", platform: "darwin" },
      name: "Target",
      authKeyDigest: "target-digest"
    });
    store.touchConnection(controller.id, Date.now());
    store.touchConnection(target.id, Date.now());

    let authenticated = controller;
    const services = createConnectServices(stubApplication(store, {
      authenticate: () => authenticated,
      pairingEnabled: false,
      onRevoked: () => () => undefined
    }));

    const outbound = await submit(services, "operation-outbound", {
      case: "setDeviceControlTargetEnabled",
      value: { targetDeviceId: target.deviceId, enabled: true }
    });
    expect(outbound.result?.payload.case).toBe("deviceControlRelation");
    expect(outbound.result?.payload.value).toMatchObject({
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      outboundEnabled: true,
      inboundAllowed: true,
      effective: false
    });

    authenticated = target;
    await submit(services, "operation-target-opt-in", {
      case: "setDeviceRemoteControlEnabled",
      value: { enabled: true }
    });
    const enabledRelations = await invoke<contract.ListDeviceControlRelationsResponse>(
      services.connection.listDeviceControlRelations,
      { deviceId: target.deviceId }
    );
    expect(enabledRelations.relations[0]?.effective).toBe(true);

    const denied = await submit(services, "operation-inbound-deny", {
      case: "setDeviceControllerAllowed",
      value: { controllerDeviceId: controller.deviceId, allowed: false }
    });
    expect(denied.result?.payload.value).toMatchObject({ inboundAllowed: false, effective: false });

    const devices = await invoke<contract.ListDevicesResponse>(services.connection.listDevices, {});
    expect(devices.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: controller.deviceId, presence: contract.DevicePresenceState.ONLINE }),
      expect.objectContaining({
        deviceId: target.deviceId,
        remoteControlEnabled: true,
        presence: contract.DevicePresenceState.ONLINE
      })
    ]));
  });

  it("binds the global opt-in to the authenticated Device", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const web = store.createConnection({
      id: "connection-web",
      deviceId: "device-web",
      device: { name: "Browser", kind: "web", platform: "web" },
      name: "Browser",
      authKeyDigest: "web-digest"
    });
    const services = createConnectServices(stubApplication(store, {
      authenticate: () => web,
      pairingEnabled: false,
      onRevoked: () => () => undefined
    }));

    await expect(submit(services, "operation-web-opt-in", {
      case: "setDeviceRemoteControlEnabled",
      value: { enabled: true }
    })).rejects.toThrow(/Desktop or service Device/u);
    expect(store.getDevice(web.deviceId).remoteControlEnabled).toBe(false);
  });
});

function stubApplication(store: OperationalStore, connections: object): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections,
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: immediateHost(store),
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

function immediateHost(store: OperationalStore): object {
  return {
    mutate: async (input: {
      operationId: string;
      connection: { id: string };
      kind: string;
      body: unknown;
      commit: (store: OperationalStore) => unknown;
    }) => {
      const value = input.commit(store);
      const operation: OperationRecord<unknown> = {
        id: input.operationId,
        connectionId: input.connection.id,
        kind: input.kind,
        body: input.body,
        bodyHash: operationBodyHash(input.body),
        completionMode: "transactional",
        status: "completed",
        response: value,
        createdAt: 1,
        updatedAt: 2,
        revision: 1n
      };
      return { replayed: false, value, operation };
    }
  };
}

async function submit(
  services: ReturnType<typeof createConnectServices>,
  operationId: string,
  payload: NonNullable<MessageInitShape<typeof contract.OperationMutationSchema>["payload"]>
): Promise<contract.Operation> {
  const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
    operationId,
    connectionId: "",
    mutation: create(contract.OperationMutationSchema, { payload })
  });
  if (response.operation === undefined) throw new Error("Operation response is missing.");
  return response.operation;
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T> | T)(request, {
    requestHeader: new Headers({ authorization: "Bearer test" }),
    signal: new AbortController().signal
  });
}
