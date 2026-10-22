import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import { createInputHandoffConnectService } from "./input-handoff-connect-service.js";
import { InputHandoffCoordinator, presentationDigest } from "./input-handoff/coordinator.js";
import type { NativeInputHandoffHost } from "./input-handoff/native-host.js";
import { fakeDesktop } from "./input-handoff/__tests__/fakeDesktop.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-handoff-owner-")), store = new OperationalStore(":memory:");
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const connections = new ConnectionManager(store);
  const connect = () => { const value = connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(),
    defaultDeviceName: "Owner", platform: "win32", appVersion: "0.1.0", desktopHostAuthKey: randomBytes(32).toString("base64url") });
    connections.confirmTrustedDesktopConnection(value.connection.id, value.authKey); return value; };
  const owner = connect(), other = connect(), desktop = fakeDesktop({ live: true });
  let current = true, nativeDeviceId: string | null = "original-main";
  const continuation = vi.fn(async () => {});
  const coordinator = new InputHandoffCoordinator({ credentials, native: { createDriver: () => ({ driver: desktop.driver, hostPid: 1 }) },
    captureScope: identity => ({ ...identity, assertCurrent: () => { if (!current) throw new Error("The task changed."); } }),
    isDisabledForSession: async () => false, continueAgent: continuation, liveViewAvailable: () => true, askpass: { platform: "win32" } });
  const peer = { targetDeviceId: "original-main", targetDeviceRevision: 2n, relationId: "current-owner-relation", relationRevision: 3n, routeGeneration: 4 };
  const capture = vi.fn(() => ({ assertCurrent: () => { if (!current) throw new Error("The route changed."); } }));
  const peers = { listForCapabilities: () => [peer, { ...peer, targetDeviceId: "another-computer" }], capture } as unknown as DevicePeerOwner;
  const native = { currentDeviceId: () => nativeDeviceId } as unknown as NativeInputHandoffHost;
  const client = createClient(contract.InputHandoffService, createRouterTransport(({ service }) => service(contract.InputHandoffService,
    createInputHandoffConnectService({ coordinator, connections, peers, native }))));
  const headers = { authorization: `Bearer ${owner.authKey}` }, otherHeaders = { authorization: `Bearer ${other.authKey}` };
  const started = await coordinator.start({ sessionId: "task", targetId: "workspace", generation: 1 }, { purpose: "Sign in", target: { app: "Example" } });
  expect(started.ok).toBe(true);
  await vi.waitFor(() => expect(coordinator.list("task")[0]?.phase).toBe("ready"));
  const step = () => coordinator.list("task")[0]!;
  return { store, credentials, coordinator, client, connections, owner, headers, otherHeaders, continuation, capture, desktop, step,
    invalidate: () => { current = false; }, noNative: () => { nativeDeviceId = null; },
    close: async () => { await coordinator.close(); store.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test directory."); await rm(root, { recursive: true, force: true }); } };
}

it("binds a one-use private submission to the current owner and original presentation without storing values", async () => {
  const f = await fixture();
  try {
    await expect(f.client.listInputHandoffs({ sessionId: "task" }, { headers: { authorization: "ProviderShareGuest synthetic" } })).rejects.toBeDefined();
    const state = f.step(), field = state.controls.find(value => value.kind === "text")!;
    const tasks = await f.client.listInputHandoffTasks({}, { headers: f.headers });
    expect(tasks.tasks).toMatchObject([{ sessionId: "task", requestId: state.requestId, generation: 1n, stepNumber: 1 }]);
    expect(Object.keys(tasks.tasks[0]!).sort()).toEqual(["$typeName", "generation", "requestId", "sessionId", "stepNumber"]);
    const ticket = (await f.client.beginInputHandoffSubmission({ requestId: state.requestId, expectedRevision: BigInt(state.revision), presentationSha256: presentationDigest(state) }, { headers: f.headers })).ticket!;
    const submission = { expectedRevision: state.revision, values: { [field.id]: "synthetic-private-value" }, action: { kind: "submit" } };
    f.credentials.upload(ticket.ticketId, JSON.stringify(submission), f.owner.connection.id);
    const request = { requestId: state.requestId, expectedRevision: BigInt(state.revision), credentialUploadTicketId: ticket.ticketId };
    expect((await f.client.submitInputHandoff(request, { headers: f.otherHeaders })).accepted).toBe(false);
    expect((await f.client.submitInputHandoff(request, { headers: f.headers })).accepted).toBe(true);
    expect((await f.client.submitInputHandoff(request, { headers: f.headers })).accepted).toBe(false);
    expect(f.desktop.acts.some(value => value.kind === "text" && value.value === "synthetic-private-value")).toBe(true);
    expect(JSON.stringify(f.coordinator.list("task"))).not.toContain("synthetic-private-value");
    expect(f.credentials.list()).toEqual([]);
    await f.client.decideInputHandoff({ requestId: state.requestId, expectedRevision: BigInt(f.step().revision), decision: contract.InputHandoffDecisionKind.CANCEL }, { headers: f.headers });
    expect(f.continuation).toHaveBeenCalledOnce(); expect(JSON.stringify(f.continuation.mock.calls)).not.toContain("synthetic-private-value");
  } finally { await f.close(); }
});

it("resolves only the committed original Main peer and rejects stale task and owner authorities", async () => {
  const f = await fixture();
  try {
    const state = f.step(), request = { requestId: state.requestId, expectedRevision: BigInt(state.revision), presentationSha256: presentationDigest(state) };
    const result = await f.client.openInputHandoffLiveView(request, { headers: f.headers });
    expect(result.peer?.targetDeviceId).toBe("original-main"); expect(result.requestId).toBe(state.requestId);
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.owner.connection.id }), expect.objectContaining({ targetDeviceId: "original-main" }), ["remote_desktop"]);
    f.noNative(); expect((await f.client.listInputHandoffs({ sessionId: "task" }, { headers: f.headers })).states[0]?.liveView).toBe(false);
    await expect(f.client.openInputHandoffLiveView(request, { headers: f.headers })).rejects.toBeDefined();
    f.invalidate(); await expect(f.client.beginInputHandoffSubmission(request, { headers: f.headers })).rejects.toBeDefined();
    f.connections.revoke(f.owner.connection.id); await expect(f.client.listInputHandoffs({ sessionId: "task" }, { headers: f.headers })).rejects.toBeDefined();
  } finally { await f.close(); }
});
