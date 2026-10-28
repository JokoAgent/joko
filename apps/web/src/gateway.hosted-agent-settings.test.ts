import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, SnapshotSchema, type HostedAgentSettings, type UpdateHostedAgentSettingsRequest } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

const settings = { revision: 4n, remoteControlEnabled: false, idleReleaseMinutes: 0, providers: [{ backendId: "native-a", providerId: "account-a", enabled: true }],
  limits: { perDevice: 16, total: 64 }, limitsOverridden: false, usage: { total: 3, devices: 2, maximumDevice: 2 } };
function fixture(handler: (method: string, input: any, signal?: AbortSignal) => unknown | Promise<unknown>) {
  const transport = { unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
    const result = method.localName === "getSnapshot" ? create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n } }) }) : method.parent.typeName === "joko.v1.HostedAgentService"
      ? create(method.output, await handler(method.localName, input, signal) as any) : (() => { throw new Error("Optional service unavailable."); })();
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: result };
  }), stream: vi.fn() } as unknown as Transport;
  return createOrchestratorGateway({ id: "owner", deviceId: "original-device", serverId: "owner-node", name: "Node", origin: "https://node.invalid" }, "test-key", {}, () => transport);
}
it("uses the generated owner service with exact Provider identities, CAS and truthful usage while retaining paused choices", async () => {
  const updates: UpdateHostedAgentSettingsRequest[] = [];
  const gateway = fixture((method, input) => method === "getHostedAgentCatalog" ? { format: 1, remoteControlEnabled: false, backends: [{ backendId: "native-a", displayName: "Native A",
    providers: [{ providerId: "account-a", displayName: "Account", connected: true, remoteInvocationEnabled: true, models: [{ backendId: "native-a", key: { providerId: "account-a", modelId: "model-a" } }] }] }] }
    : method === "getHostedAgentSettings" ? { settings } : (updates.push(input), { settings: { ...settings, revision: 5n } }));
  await gateway.connect({ snapshotOnly: true });
  try {
    expect(await gateway.getHostedAgentSettings()).toEqual(settings);
    expect(await gateway.getHostedAgentCatalog()).toEqual({ backends: [{ backendId: "native-a", displayName: "Native A", providers: [
      { providerId: "account-a", displayName: "Account", connected: true, modelCount: 1, models: [{ id: "model-a", name: "model-a" }] }] }] });
    await gateway.updateHostedAgentSettings({ kind: "provider", backendId: "native-a", providerId: "account-a", enabled: false }, 4n);
    await gateway.updateHostedAgentSettings({ kind: "limits", perDevice: 1, total: 2 }, 5n);
    await gateway.updateHostedAgentSettings({ kind: "resetLimits" }, 5n);
    expect(updates[0]).toMatchObject({ expectedRevision: 4n, update: { case: "provider", value: { backendId: "native-a", providerId: "account-a", enabled: false } } });
    expect(updates[1]?.update).toMatchObject({ case: "limits", value: { perDevice: 1, total: 2 } }); expect(updates[2]?.update.case).toBe("resetLimits");
    for (const limit of [0, 1001, 1.5]) await expect(gateway.updateHostedAgentSettings({ kind: "limits", perDevice: limit, total: 64 }, 5n)).rejects.toThrow("integers");
    expect(updates).toHaveLength(3);
  } finally { gateway.disconnect(); }
});

it("keeps CAS conflicts explicit and refuses malformed or foreign native catalog state", async () => {
  let foreign = true;
  const gateway = fixture(method => {
    if (method === "updateHostedAgentSettings") throw new ConnectError("Settings changed.", Code.Aborted);
    if (method === "getHostedAgentSettings") return { settings: { ...settings, limits: { perDevice: 0, total: 64 } } };
    return { format: 1, backends: [{ backendId: "native-a", providers: [{ providerId: "account-a", models: [
      { backendId: foreign ? "another-node-runtime" : "native-a", key: { providerId: "account-a", modelId: "model-a" } }] }] }] };
  });
  await gateway.connect({ snapshotOnly: true });
  try {
    await expect(gateway.updateHostedAgentSettings({ kind: "remoteControl", enabled: true }, 4n)).rejects.toMatchObject({ code: Code.Aborted });
    await expect(gateway.getHostedAgentCatalog()).rejects.toThrow("ownership changed"); foreign = false;
    expect((await gateway.getHostedAgentCatalog()).backends[0]?.backendId).toBe("native-a");
    await expect(gateway.getHostedAgentSettings()).rejects.toThrow("Invalid hosted Agent settings");
  } finally { gateway.disconnect(); }
});

it("rejects a late settings write after its original connection is retired", async () => {
  let finish!: () => void, signal: AbortSignal | undefined;
  const gateway = fixture(async (_method, _input, requestSignal) => { signal = requestSignal; await new Promise<void>(resolve => { finish = resolve; }); return { settings }; });
  await gateway.connect({ snapshotOnly: true });
  const writing = gateway.updateHostedAgentSettings({ kind: "remoteControl", enabled: true }, 4n);
  const assertion = expect(writing).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function")); gateway.disconnect(); expect(signal?.aborted).toBe(true); finish(); await assertion;
});
