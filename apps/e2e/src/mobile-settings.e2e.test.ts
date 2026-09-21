import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import {
  DeviceKind,
  EntityKind,
  EntityRefSchema,
  OperationMutationSchema,
  OperationPreconditionSchema,
  OperationState,
  RenameDeviceMutationSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import { submit } from "./operations.js";

describe("Mobile Settings product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("renames the authenticated mobile Device through HTTP, the Operation host, and SQLite with exact revision control", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko Settings phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    });
    const challengeId = begun.challenge?.challengeId;
    if (!challengeId) throw new Error("The mobile Settings fixture did not return a pairing challenge.");
    const paired = (await fixture.anonymous.connection.completePairing({
      challengeId,
      humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Joko Settings phone",
      deviceKind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0"
    })).result;
    if (!paired?.authKey || !paired.connection?.connectionId || !paired.device?.deviceId) {
      throw new Error("The mobile Settings fixture did not pair.");
    }
    const clients = fixture.clients(paired.authKey);
    const connectionId = paired.connection.connectionId;
    const deviceId = paired.device.deviceId;
    const before = (await clients.event.getSnapshot({
      scope: { kind: { case: "owner", value: {} } }
    })).snapshot;
    const current = before?.devices.find((device) => device.deviceId === deviceId);
    const revision = current?.version?.revision;
    expect(current).toMatchObject({
      displayName: "Joko Settings phone",
      kind: DeviceKind.MOBILE,
      platform: "android",
      appVersion: "0.1.0",
      revoked: false,
      connectionIds: [connectionId]
    });
    expect(revision?.value).toBeGreaterThan(0n);

    const operationId = randomUUID();
    const mutation = create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
        expectedRevision: revision
      })],
      payload: { case: "renameDevice", value: create(RenameDeviceMutationSchema, {
        deviceId,
        displayName: "Field phone"
      }) }
    });
    const renamed = await submit(clients.operation, connectionId, mutation, operationId);
    expect(renamed.state).toBe(OperationState.SUCCEEDED);
    expect(renamed.result?.payload).toMatchObject({
      case: "device",
      value: { deviceId, displayName: "Field phone", kind: DeviceKind.MOBILE }
    });

    const durable = (await clients.operation.getOperation({ operationId })).operation;
    expect(durable).toMatchObject({
      operationId,
      connectionId,
      state: OperationState.SUCCEEDED,
      mutation: {
        preconditions: [{ entity: { kind: EntityKind.DEVICE, id: deviceId }, expectedRevision: revision }],
        payload: { case: "renameDevice", value: { deviceId, displayName: "Field phone" } }
      }
    });
    expect(fixture.application.store.getDevice(deviceId)).toMatchObject({ name: "Field phone", state: "active" });

    const after = (await clients.event.getSnapshot({
      scope: { kind: { case: "owner", value: {} } }
    })).snapshot;
    const refreshed = after?.devices.find((device) => device.deviceId === deviceId);
    expect(refreshed?.displayName).toBe("Field phone");
    expect(refreshed?.version?.revision?.value).toBeGreaterThan(revision!.value);

    await expect(submit(clients.operation, connectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
        expectedRevision: revision
      })],
      payload: { case: "renameDevice", value: create(RenameDeviceMutationSchema, {
        deviceId,
        displayName: "Stale overwrite"
      }) }
    }))).rejects.toThrow(/Revision precondition failed/);
    expect(fixture.application.store.getDevice(deviceId).name).toBe("Field phone");
  });
});
