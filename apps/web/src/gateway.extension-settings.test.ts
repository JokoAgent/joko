// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { ExtensionCatalogSource, ExtensionInstallState, ExtensionSetupState, OperationState, type ExtensionSettingsHost } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import { extensionSettingsProfilePin, parsePendingExtensionSettingsOperation, type PendingExtensionSettingsOperation } from "./extension-settings-operation.js";

async function fixture(operationCall?: (method: string, input: any) => Promise<Record<string, unknown>>) {
  const owner = { resourceId: "resource", resourceVersion: { value: 2n }, discoveredRevision: `sha256:${"a".repeat(64)}` };
  const surface = { surfaceId: `extension_surface_${"a".repeat(32)}`, extensionId: `extension_${"b".repeat(32)}`, owner,
    backendId: "native", backendRevision: { value: 3n }, backendGeneration: 1n, expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 180), nanos: 0 },
    endpoint: `/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"c".repeat(64)}/index.html`, settings: true };
  const entry = { extensionId: surface.extensionId, revision: { value: 4n }, owner: { kind: { case: "resource", value: owner } }, name: "Disabled plugin",
    source: ExtensionCatalogSource.LOCAL, installed: true, enabled: false, installState: ExtensionInstallState.INSTALLED, settings: { height: 480 },
    setup: { revision: { value: 1n }, state: ExtensionSetupState.REQUIRED } };
  const calls: Array<{ method: string; input: unknown }> = [];
  const transport = { unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
    calls.push({ method: method.localName, input });
    const value = operationCall && ["submitOperation", "getOperation"].includes(method.localName) ? await operationCall(method.localName, input)
      : method.localName === "getSnapshot" ? { snapshot: {} }
      : method.localName === "openExtensionSettings" || method.localName === "getExtensionMainViewSurface" ? { surface }
        : method.localName === "getExtension" ? { extension: entry } : method.localName === "closeExtensionMainView" ? { closed: true }
          : method.localName === "getExtensionSettingsRoutingData" ? { routingData: { revision: "0", dataJson: "{}" } } : {};
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: create(method.output, value) };
  }), stream: vi.fn() } as unknown as Transport;
  const profile = { id: "profile", deviceId: "device", name: "Desktop", serverId: "server", origin: "http://127.0.0.1:4318" };
  const gateway = createOrchestratorGateway(profile, "original-auth", {}, () => transport);
  await gateway.connect({ snapshotOnly: true });
  return { gateway, calls, surface, entry, profile, settingsApi: () => {
    const api = gateway.extensionSettingsApi?.();
    if (!api) throw new Error("The fixture must provide the original plugin settings API.");
    return api;
  } };
}
const host: ExtensionSettingsHost = { confirm: async () => true, authorize: async () => ({ state: "state" }), openLibrary: async () => undefined };

it("opens author settings for a disabled, incomplete installation and pins every call to its original surface purpose", async () => {
  const f = await fixture();
  try {
    const api = f.settingsApi(), signal = new AbortController().signal;
    const surface = await api.open(f.entry.extensionId, 4n, signal);
    expect(surface.purpose).toBe("settings");
    expect(f.calls.find(call => call.method === "openExtensionSettings")?.input).toMatchObject({ extensionId: f.entry.extensionId, expectedRevision: { value: 4n }, mobile: false });
    await expect(api.call(surface, { kind: "routing.get" }, host, signal)).resolves.toEqual({ revision: "0", dataJson: "{}" });
    f.surface.settings = false;
    await expect(api.call(surface, { kind: "routing.get" }, host, signal)).rejects.toThrow("surface changed");
    expect(f.calls.filter(call => call.method === "getExtensionSettingsRoutingData")).toHaveLength(1);
  } finally { f.gateway.disconnect(); }
});

it("cannot accept delayed consent or send a credential mutation after the original connection closes", async () => {
  const f = await fixture(); let accept!: (accepted: boolean) => void;
  try {
    const api = f.settingsApi(), signal = new AbortController().signal, surface = await api.open(f.entry.extensionId, 4n, signal);
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const saving = api.call(surface, { kind: "secret.clear", fieldId: "network-secret:token" }, { ...host, confirm }, signal);
    const failed = expect(saving).rejects.toThrow();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce()); f.gateway.disconnect(); accept(true); await failed;
    expect(f.calls.filter(call => call.method === "submitOperation")).toEqual([]);
    // Cleanup uses the captured original transport, even after its live owner retired.
    await expect(api.close(surface.id)).resolves.toBe(true);
    expect(f.calls.filter(call => call.method === "closeExtensionMainView")).toMatchObject([{ input: { surfaceId: surface.id } }]);
  } finally { f.gateway.disconnect(); }
});

it("awaits the durable receipt identity before dispatch and only queries an uncertain settings operation", async () => {
  let original: any, recovered = false, retained: PendingExtensionSettingsOperation | undefined, release!: () => void;
  const disk = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (method, request) => {
    if (method === "submitOperation") { original = request; throw new ConnectError("lost original response", Code.Unavailable); }
    if (!recovered) throw new ConnectError("original receipt is not yet visible", Code.NotFound);
    return { operation: { operationId: original.operationId, connectionId: "profile", mutation: original.mutation,
      state: OperationState.SUCCEEDED, result: { payload: { case: "acknowledgement", value: { accepted: true } } } } };
  });
  try {
    const api = f.settingsApi(), signal = new AbortController().signal, surface = await api.open(f.entry.extensionId, 4n, signal);
    const observer = vi.fn(async (record: PendingExtensionSettingsOperation) => { retained = record; await disk; });
    const writing = api.call(surface, { kind: "routing.set", revision: "0", dataJson: '{"privateValue":"not-a-journal-field"}' }, host, signal, observer);
    const failed = expect(writing).rejects.toThrow();
    await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce());
    expect(f.calls.filter(call => call.method === "submitOperation")).toEqual([]);
    release(); await failed;
    expect(f.calls.filter(call => call.method === "submitOperation")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "getOperation")).toMatchObject([{ input: { operationId: retained!.operationId } }]);
    expect(JSON.stringify(retained)).not.toContain("privateValue"); expect(JSON.stringify(retained)).not.toContain("dataJson");
    expect(retained).toMatchObject({ kind: "setExtensionSettingsRoutingData", extensionId: f.entry.extensionId, resourceId: "resource",
      resourceRevision: "2", expectedRevision: "4", profile: extensionSettingsProfilePin(f.profile) });
    await api.close(surface.id); recovered = true;
    await expect(f.settingsApi().readOperation!(retained!, signal)).resolves.toEqual({ state: "succeeded" });
    expect(f.calls.filter(call => call.method === "submitOperation")).toHaveLength(1);
  } finally { release(); f.gateway.disconnect(); }
});

it("confirms a terminal settings acknowledgement once even when the original submit observes it twice", async () => {
  const f = await fixture(async (_method, input) => ({ operation: { operationId: input.operationId, connectionId: "profile", mutation: input.mutation,
    state: OperationState.SUCCEEDED, result: { payload: { case: "acknowledgement", value: { accepted: true } } } } }));
  try {
    const api = f.settingsApi(), signal = new AbortController().signal, surface = await api.open(f.entry.extensionId, 4n, signal);
    const observed: Array<string | undefined> = [];
    await expect(api.call(surface, { kind: "routing.set", revision: "0", dataJson: "{}" }, host, signal,
      async (_record, receipt) => { observed.push(receipt?.state); })).resolves.toEqual({ revision: "0", dataJson: "{}" });
    expect(observed).toEqual([undefined, "succeeded"]); expect(f.calls.filter(call => call.method === "submitOperation")).toHaveLength(1);
  } finally { f.gateway.disconnect(); }
});

it.each(["operation", "connection", "kind", "extension", "revision"])("rejects a cold receipt whose original %s changed", async changed => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture(async () => ({ operation: { operationId: changed === "operation" ? "22222222-2222-4222-8222-222222222222" : operationId,
    connectionId: changed === "connection" ? "other-profile" : "profile", state: OperationState.SUCCEEDED,
    mutation: { payload: { case: changed === "kind" ? "completeExtensionSetup" : "setExtensionSettingsRoutingData", value: {
      extensionId: changed === "extension" ? "other-extension" : `extension_${"b".repeat(32)}`, expectedRevision: { value: changed === "revision" ? 5n : 4n }
    } } }, result: { payload: { case: "acknowledgement", value: { accepted: true } } } } }));
  try {
    const record = parsePendingExtensionSettingsOperation({ operationId, kind: "setExtensionSettingsRoutingData", extensionId: f.entry.extensionId,
      resourceId: "resource", resourceRevision: "2", discoveredRevision: `sha256:${"a".repeat(64)}`, expectedRevision: "4", profile: extensionSettingsProfilePin(f.profile) });
    await expect(f.settingsApi().readOperation!(record, new AbortController().signal)).rejects.toThrow(/original|receipt/u);
    expect(f.calls.filter(call => call.method === "submitOperation")).toEqual([]);
  } finally { f.gateway.disconnect(); }
});

it("can query an old immutable receipt after reinstalling the same extension while refusing an old surface's write to that new installation", async () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture(async () => ({ operation: { operationId, connectionId: "profile", state: OperationState.SUCCEEDED,
    mutation: { payload: { case: "setExtensionSettingsRoutingData", value: { extensionId: `extension_${"b".repeat(32)}`, expectedRevision: { value: 4n } } } },
    result: { payload: { case: "acknowledgement", value: { accepted: true } } } } }));
  try {
    const api = f.settingsApi(), signal = new AbortController().signal, oldSurface = await api.open(f.entry.extensionId, 4n, signal);
    const original = parsePendingExtensionSettingsOperation({ operationId, kind: "setExtensionSettingsRoutingData", extensionId: f.entry.extensionId,
      resourceId: "resource", resourceRevision: "2", discoveredRevision: `sha256:${"a".repeat(64)}`, expectedRevision: "4", profile: extensionSettingsProfilePin(f.profile) });
    f.entry.revision.value = 8n; f.entry.owner.kind.value.resourceVersion.value = 3n; f.entry.owner.kind.value.discoveredRevision = `sha256:${"d".repeat(64)}`;
    await expect(api.readOperation!(original, signal)).resolves.toEqual({ state: "succeeded" });
    await expect(api.call(oldSurface, { kind: "routing.set", revision: "0", dataJson: "{}" }, host, signal, async () => undefined)).rejects.toThrow(/surface changed|installation changed/u);
    expect(f.calls.filter(call => call.method === "submitOperation")).toEqual([]);
  } finally { f.gateway.disconnect(); }
});

it("reports completion of an expired original directory deposit without returning its token or issuing another selection", async () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const f = await fixture(async () => ({ operation: { operationId, connectionId: "profile", state: OperationState.SUCCEEDED,
    mutation: { payload: { case: "pickExtensionDirectory", value: { extensionId: `extension_${"b".repeat(32)}`, expectedRevision: { value: 4n }, pickerId: "expired-picker", entryId: "original-entry" } } },
    result: { payload: { case: "pickedDirectory", value: { token: "expired-private-token", fileCount: 1, totalBytes: 1n, relativePaths: ["report.txt"], expiresAt: { seconds: 1n } } } } } }));
  try {
    const record = parsePendingExtensionSettingsOperation({ operationId, kind: "pickExtensionDirectory", extensionId: f.entry.extensionId,
      resourceId: "resource", resourceRevision: "2", discoveredRevision: `sha256:${"a".repeat(64)}`, expectedRevision: "4", profile: extensionSettingsProfilePin(f.profile) });
    await expect(f.settingsApi().readOperation!(record, new AbortController().signal)).resolves.toEqual({ state: "succeeded" });
    expect(f.calls.some(call => call.method === "submitOperation" || call.method === "openExtensionDirectoryPicker")).toBe(false);
  } finally { f.gateway.disconnect(); }
});
