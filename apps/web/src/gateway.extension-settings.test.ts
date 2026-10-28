// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { ExtensionInstallState, ExtensionSetupState, type ExtensionSettingsHost } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

async function fixture() {
  const owner = { resourceId: "resource", resourceVersion: { value: 2n }, discoveredRevision: `sha256:${"a".repeat(64)}` };
  const surface = { surfaceId: `extension_surface_${"a".repeat(32)}`, extensionId: `extension_${"b".repeat(32)}`, owner,
    backendId: "native", backendRevision: { value: 3n }, backendGeneration: 1n, expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 180), nanos: 0 },
    endpoint: `/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"c".repeat(64)}/index.html`, settings: true };
  const entry = { extensionId: surface.extensionId, revision: { value: 4n }, owner: { kind: { case: "resource", value: owner } }, name: "Disabled plugin",
    installed: true, enabled: false, installState: ExtensionInstallState.INSTALLED, settings: { height: 480 },
    setup: { revision: { value: 1n }, state: ExtensionSetupState.REQUIRED } };
  const calls: Array<{ method: string; input: unknown }> = [];
  const transport = { unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
    calls.push({ method: method.localName, input });
    const value = method.localName === "getSnapshot" ? { snapshot: {} }
      : method.localName === "openExtensionSettings" || method.localName === "getExtensionMainViewSurface" ? { surface }
        : method.localName === "getExtension" ? { extension: entry } : method.localName === "closeExtensionMainView" ? { closed: true }
          : method.localName === "getExtensionSettingsRoutingData" ? { routingData: { revision: "0", dataJson: "{}" } } : {};
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: create(method.output, value) };
  }), stream: vi.fn() } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "profile", deviceId: "device", name: "Desktop", serverId: "server", origin: "http://127.0.0.1:4318" }, "original-auth", {}, () => transport);
  await gateway.connect({ snapshotOnly: true });
  return { gateway, calls, surface, entry };
}
const host: ExtensionSettingsHost = { confirm: async () => true, authorize: async () => ({ state: "state" }), openLibrary: async () => undefined };

it("opens author settings for a disabled, incomplete installation and pins every call to its original surface purpose", async () => {
  const f = await fixture();
  try {
    const api = f.gateway.extensionSettingsApi()!, signal = new AbortController().signal;
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
    const api = f.gateway.extensionSettingsApi()!, signal = new AbortController().signal, surface = await api.open(f.entry.extensionId, 4n, signal);
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
