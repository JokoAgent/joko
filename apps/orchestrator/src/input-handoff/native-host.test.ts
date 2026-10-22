import { randomBytes, randomUUID } from "node:crypto";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionManager } from "../connection-manager.js";
import { NativeInputHandoffHost } from "./native-host.js";
import { isHumanDesktopInputActive } from "./input-ownership.js";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture() {
  const store = new OperationalStore(":memory:"), connections = new ConnectionManager(store), privateKey = randomBytes(32).toString("base64url");
  const desktop = connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(), defaultDeviceName: "Main", platform: "darwin", appVersion: "0.1.0", desktopHostAuthKey: privateKey });
  connections.confirmTrustedDesktopConnection(desktop.connection.id, desktop.authKey);
  const host = new NativeInputHandoffHost(connections), client = createClient(contract.DesktopInputHandoffHostService,
    createRouterTransport(router => router.service(contract.DesktopInputHandoffHostService, host.service())));
  const headers = { authorization: `Bearer ${desktop.authKey}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${privateKey}` };
  const instance = randomUUID(), registration = { hostInstanceId: instance, platform: "darwin", processId: 77 };
  cleanup.push(() => { host.close(); store.close(); });
  return { host, client, headers, desktop, connections, registration };
}

it("requires both current Main proofs and dispatches each private native effect only once", async () => {
  const f = fixture(); expect(f.host.currentDeviceId()).toBeNull(); expect(f.host.createDriver(() => {})).toBeNull();
  await expect(f.client.registerNativeInputHandoffHost(f.registration, { headers: { authorization: f.headers.authorization } })).rejects.toBeDefined();
  await expect(f.client.registerNativeInputHandoffHost(f.registration, { headers: { ...f.headers, [DESKTOP_HOST_AUTHORIZATION_HEADER]: "Bearer wrong" } })).rejects.toBeDefined();
  const { hostGeneration } = await f.client.registerNativeInputHandoffHost(f.registration, { headers: f.headers }), scope = { hostInstanceId: f.registration.hostInstanceId, hostGeneration };
  expect(f.host.currentDeviceId()).toBe(f.desktop.connection.deviceId);
  const native = f.host.createDriver(() => {})!, pending = native.driver.permission();
  const command = (await f.client.pollNativeInputHandoffCommand(scope, { headers: f.headers })).command!;
  expect(command.method).toBe(contract.NativeInputHandoffMethod.PERMISSION);
  expect((await f.client.admitNativeInputHandoffCommand({ ...scope, commandId: command.commandId }, { headers: f.headers })).current).toBe(true);
  const completed = { ...scope, commandId: command.commandId, success: true, payload: Buffer.from(JSON.stringify("granted")) };
  expect((await f.client.completeNativeInputHandoffCommand(completed, { headers: f.headers })).accepted).toBe(true);
  await expect(pending).resolves.toBe("granted");
  expect((await f.client.completeNativeInputHandoffCommand(completed, { headers: f.headers })).accepted).toBe(true);
  expect((await f.client.admitNativeInputHandoffCommand({ ...scope, commandId: command.commandId }, { headers: f.headers })).current).toBe(false);
  f.connections.revoke(f.desktop.connection.id); expect(f.host.currentDeviceId()).toBeNull(); expect(f.host.createDriver(() => {})).toBeNull();
});

it("retires an old Main mailbox without allowing its late completion to touch the new generation", async () => {
  const f = fixture();
  const first = await f.client.registerNativeInputHandoffHost(f.registration, { headers: f.headers }), scope = { hostInstanceId: f.registration.hostInstanceId, hostGeneration: first.hostGeneration };
  const oldDriver = f.host.createDriver(() => {})!, pending = oldDriver.driver.permission(), rejected = expect(pending).rejects.toThrow("unavailable");
  const command = (await f.client.pollNativeInputHandoffCommand(scope, { headers: f.headers })).command!;
  const replacement = { ...f.registration, hostInstanceId: randomUUID(), processId: 78 };
  const next = await f.client.registerNativeInputHandoffHost(replacement, { headers: f.headers }); await rejected;
  expect(next.hostGeneration).toBeGreaterThan(first.hostGeneration);
  await expect(f.client.completeNativeInputHandoffCommand({ ...scope, commandId: command.commandId, success: true, payload: Buffer.from('"granted"') }, { headers: f.headers })).rejects.toBeDefined();
  expect(() => oldDriver.driver.permission()).toThrow();
  const newDriver = f.host.createDriver(() => {})!, value = newDriver.driver.permission(), newScope = { hostInstanceId: replacement.hostInstanceId, hostGeneration: next.hostGeneration };
  const fresh = (await f.client.pollNativeInputHandoffCommand(newScope, { headers: f.headers })).command!;
  expect(fresh.commandId).not.toBe(command.commandId);
  await f.client.completeNativeInputHandoffCommand({ ...newScope, commandId: fresh.commandId, success: true, payload: Buffer.from('"granted"') }, { headers: f.headers });
  await expect(value).resolves.toBe("granted");
});

it("checks the Source's exact live request before a human batch and releases it only on Main acknowledgement", async () => {
  const f = fixture(), controllerDeviceId = "controller", requestId = "request";
  const live = { liveWindow: vi.fn(async () => null), isLiveViewCurrent: vi.fn((request: string, controller: string, window: number, pid: number) => request === requestId && controller === controllerDeviceId && window === 91 && pid === 80), liveViewEnded: vi.fn() };
  f.host.setLiveHandoffPort(live);
  const { hostGeneration } = await f.client.registerNativeInputHandoffHost(f.registration, { headers: f.headers });
  const window = { hostInstanceId: f.registration.hostInstanceId, hostGeneration, requestId, controllerDeviceId, windowId: 91, processId: 80 }, inputOwnerId = randomUUID();
  const gestureState = Buffer.from(JSON.stringify([{ kind: "text", text: "" }]));
  await expect(f.client.beginNativeInputHandoffInput({ window: { ...window, windowId: 92 }, inputOwnerId, gestureState }, { headers: f.headers })).rejects.toBeDefined();
  expect(isHumanDesktopInputActive()).toBe(false);
  const admitted = await f.client.beginNativeInputHandoffInput({ window, inputOwnerId, gestureState }, { headers: f.headers }); expect(isHumanDesktopInputActive()).toBe(true);
  await f.client.finishNativeInputHandoffInput({ window, inputOwnerId, inputBatchId: admitted.inputBatchId, closed: true }, { headers: f.headers });
  expect(isHumanDesktopInputActive()).toBe(false);
  await f.client.endNativeInputHandoffWindow(window, { headers: f.headers }); expect(live.liveViewEnded).toHaveBeenCalledWith(requestId, controllerDeviceId);
});
