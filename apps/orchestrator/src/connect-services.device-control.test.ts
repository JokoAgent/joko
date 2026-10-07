import { create, type MessageInitShape } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore, type ConnectionRecord } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { ConnectionManager } from "./connection-manager.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("Device control Connect surface", () => {
  it("streams persisted Device name content to another owner and resumes the original projection", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const manager = new ConnectionManager(store);
    const observer = store.createConnection({ id: "observer", name: "Owner connection", authKeyDigest: "observer-digest",
      device: { defaultName: "Joko Browser", kind: "web" } });
    const phone = store.createConnection({ id: "phone", deviceId: "phone-device", name: "Phone connection", authKeyDigest: "phone-digest",
      device: { defaultName: "Native A", kind: "mobile" } });
    const services = createConnectServices(stubApplication(store, {
      authenticate: () => observer,
      fence: manager.fence.bind(manager),
      pairingEnabled: false,
      onRevoked: () => () => undefined
    }));
    const controller = new AbortController();
    const request = create(contract.StreamEventsRequestSchema, { scope: { kind: { case: "owner", value: {} } } });
    const stream = (services.event.streamEvents as (request: contract.StreamEventsRequest, context: unknown) =>
      AsyncGenerator<contract.StreamEventsResponse>)(request, { requestHeader: new Headers(), signal: controller.signal });
    try {
      const receiving = stream.next();
      const changed = manager.refreshDeviceNameSource(phone, "Native B");
      const first = (await receiving).value!.event!;
      expect(first.payload?.kind.case).toBe("deviceChanged");
      if (first.payload?.kind.case !== "deviceChanged") throw new Error("Device event is missing.");
      expect(first.payload.kind.value.device).toMatchObject({ deviceId: phone.deviceId, displayName: "Native B",
        defaultDisplayName: "Native B", connectionIds: [phone.id], version: { revision: { value: changed.revision } } });
      expect(first.identity).toMatchObject({ backendId: "", targetId: "", sessionId: "" });
      const naming = stream.next();
      await submit(services, "rename-stream-phone", { case: "renameDevice", value: { deviceId: phone.deviceId, displayName: "My phone" } });
      expect((await naming).value!.event!.payload?.kind.value).toMatchObject({ device: { displayName: "My phone",
        manualDisplayName: "My phone", defaultDisplayName: "Native B" } });
      const resetting = stream.next();
      await submit(services, "reset-stream-phone", { case: "resetDeviceName", value: { deviceId: phone.deviceId } });
      const reset = (await resetting).value!.event!;
      if (reset.payload?.kind.case !== "deviceChanged") throw new Error("Device reset event is missing.");
      expect(reset.payload.kind.value.device?.manualDisplayName).toBeUndefined();
      expect(reset.payload.kind.value.device?.displayName).toBe("Native B");
      const replay = (services.event.streamEvents as (request: contract.StreamEventsRequest, context: unknown) =>
        AsyncGenerator<contract.StreamEventsResponse>)(request, { requestHeader: new Headers(), signal: controller.signal });
      try {
        expect((await replay.next()).value!.event).toEqual(first);
      } finally { await replay.return(undefined as never); }
    } finally { controller.abort(); await stream.return(undefined as never); }
  });

  it("separates pairing labels from native sources and resets another Device using its latest durable default", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const manager = new ConnectionManager(store);
    const owner = store.createConnection({ id: "owner", name: "Owner connection", authKeyDigest: "owner-digest",
      device: { defaultName: "Joko Browser", kind: "web" } });
    let authenticated = owner;
    const services = createConnectServices(stubApplication(store, {
      authenticate: () => authenticated,
      requestPairing: manager.requestPairing.bind(manager),
      completePairing: manager.completePairing.bind(manager),
      openPairingWindow: manager.openPairingWindow.bind(manager),
      refreshDeviceNameSource: manager.refreshDeviceNameSource.bind(manager),
      pairingEnabled: false,
      onRevoked: () => () => undefined
    }));
    const challenge = manager.issuePairing("Local console label");
    const paired = await invoke<contract.CompletePairingResponse>(services.connection.completePairing, {
      challengeId: challenge.id, humanCode: challenge.code, deviceDisplayName: "My phone", deviceKind: contract.DeviceKind.MOBILE,
      platform: "android", appVersion: "1", deviceNameSource: { defaultDisplayName: "Native phone" }
    });
    const device = paired.result!.device!;
    expect(device).toMatchObject({ displayName: "My phone", defaultDisplayName: "Native phone", manualDisplayName: "My phone",
      kind: contract.DeviceKind.MOBILE });
    authenticated = store.getConnection(paired.result!.connection!.connectionId);
    const snapshot = await invoke<contract.GetSnapshotResponse>(services.event.getSnapshot, {
      currentDeviceNameSource: { defaultDisplayName: "Latest native phone" }
    });
    const current = snapshot.snapshot!.devices.find((item) => item.deviceId === device.deviceId)!;
    expect(current).toMatchObject({ displayName: "My phone", defaultDisplayName: "Latest native phone", manualDisplayName: "My phone" });
    await expect(submit(services, "stale-reset", { case: "resetDeviceName", value: { deviceId: device.deviceId } }, device.deviceId,
      device.version!.revision!.value)).rejects.toThrow(/Revision/u);
    authenticated = owner;
    const reset = await submit(services, "reset-phone", { case: "resetDeviceName", value: { deviceId: device.deviceId } }, device.deviceId,
      current.version!.revision!.value);
    expect(reset.result?.payload.case).toBe("device");
    expect(reset.result?.payload.value).toMatchObject({ displayName: "Latest native phone", defaultDisplayName: "Latest native phone" });
    const resetDevice = reset.result!.payload.value as contract.Device;
    expect(resetDevice.manualDisplayName).toBeUndefined();
    const replay = await submit(services, "reset-phone", { case: "resetDeviceName", value: { deviceId: device.deviceId } }, device.deviceId,
      current.version!.revision!.value);
    expect(replay.operationId).toBe(reset.operationId);
    await expect(submit(services, "blank-reset", { case: "resetDeviceName", value: { deviceId: " " } })).rejects.toThrow(/required/u);
    const listed = await invoke<contract.ListDevicesResponse>(services.connection.listDevices, {});
    expect(listed.devices.find((item) => item.deviceId === device.deviceId)).toMatchObject(resetDevice);
    const before = store.getDevice(owner.deviceId);
    await expect(invoke(services.event.getSnapshot, { currentDeviceNameSource: { defaultDisplayName: "Fake browser hostname" } }))
      .rejects.toThrow(/Mobile or Desktop/u);
    expect(store.getDevice(owner.deviceId)).toEqual(before);
    const webChallenge = manager.issuePairing("Browser");
    const web = await invoke<contract.CompletePairingResponse>(services.connection.completePairing, {
      challengeId: webChallenge.id, humanCode: webChallenge.code, deviceDisplayName: "Personal browser", deviceKind: contract.DeviceKind.WEB,
      platform: "web", appVersion: "1", deviceNameSource: { defaultDisplayName: "Ignored browser guess" }
    });
    expect(web.result!.device).toMatchObject({ defaultDisplayName: "Joko Browser", manualDisplayName: "Personal browser" });
  });

  it("keeps control ineffective until the authenticated target and controller both consent", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const controller = store.createConnection({
      id: "connection-controller",
      deviceId: "device-controller",
      device: { defaultName: "Controller", kind: "desktop", platform: "windows" },
      name: "Controller",
      authKeyDigest: "controller-digest"
    });
    const target = store.createConnection({
      id: "connection-target",
      deviceId: "device-target",
      device: { defaultName: "Target", kind: "desktop", platform: "darwin" },
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
      device: { defaultName: "Browser", kind: "web", platform: "web" },
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
      connection: ConnectionRecord;
      kind: string;
      body: unknown;
      commit: (store: OperationalStore) => unknown;
    }) => {
      return store.runAuthorizedOperation(input.connection.id, input.connection.authKeyDigest,
        { id: input.operationId, kind: input.kind, body: input.body }, input.commit);
    }
  };
}

async function submit(
  services: ReturnType<typeof createConnectServices>,
  operationId: string,
  payload: NonNullable<MessageInitShape<typeof contract.OperationMutationSchema>["payload"]>,
  deviceId?: string,
  deviceRevision?: bigint
): Promise<contract.Operation> {
  const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
    operationId,
    connectionId: "",
    mutation: create(contract.OperationMutationSchema, { payload,
      ...(deviceId === undefined ? {} : { preconditions: [{ entity: { kind: contract.EntityKind.DEVICE, id: deviceId },
        expectedRevision: { value: deviceRevision! } }] }) })
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
