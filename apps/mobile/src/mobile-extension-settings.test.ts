// @vitest-environment jsdom
import { createRequire } from "node:module";
import { EXTENSION_SETTINGS_SDK_SOURCE, type ExtensionSettingsCall } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileExtensionSettingsBridge, mobileExtensionSettingsBootstrap } from "./mobile-extension-settings";
import type { MobileExtensionMainViewSurface, MobileExtensionTransport } from "./mobile-extensions";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const surface: MobileExtensionMainViewSurface = {
  surfaceId: `extension_surface_${"1".repeat(32)}`, extensionId: `extension_${"2".repeat(32)}`,
  owner: { kind: "resource", resourceId: "resource-mail", discoveredRevision: `sha256:${"a".repeat(64)}`, resourceRevision: 5n },
  backendId: "backend-mail", backendRevision: 7n, backendGeneration: 4,
  purpose: "settings", mobileSettings: true, expiresAt: Date.now() + 60_000,
  url: `https://node.example/v1/extensions/main-views/extension_surface_${"1".repeat(32)}/${"b".repeat(64)}/index.html`
};
const frameId = `${surface.surfaceId}:0`, documentUrl = "http://127.0.0.1:4411/index.html";
const bridges: MobileExtensionSettingsBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); vi.useRealTimers(); });

function harness() {
  let current = true, foreground = true;
  const replies: string[] = [];
  const call = vi.fn<NonNullable<MobileExtensionTransport["callSettings"]>>(async () => ({ context: { locale: "en" } }));
  const options = { surface, frameId, documentUrl, transport: { callSettings: call } as unknown as MobileExtensionTransport,
    host: { confirm: vi.fn(async () => false), authorize: vi.fn(async () => { throw new Error("unused"); }), openLibrary: vi.fn(async () => undefined) },
    current: () => current, foreground: () => foreground, send: (message: string) => { replies.push(message); } };
  const bridge = new MobileExtensionSettingsBridge(options); bridges.push(bridge);
  const send = (id: string, command: ExtensionSettingsCall = { kind: "context.get" }, extra: Record<string, unknown> = {}, url = documentUrl) => bridge.receive(
    JSON.stringify({ frameId, surfaceId: surface.surfaceId, request: { type: "joko:extension-settings-request", version: 1, id, command }, ...extra }), url);
  return { bridge, options, call, replies, send, retire: () => { current = false; }, background: () => { foreground = false; } };
}

async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

describe("Mobile author settings document bridge", () => {
  it("requires the original frame, surface, logical document and foreground occurrence", async () => {
    const active = harness();
    active.send("old-frame", undefined, { frameId: `${surface.surfaceId}:previous` });
    active.send("other-surface", undefined, { surfaceId: `extension_surface_${"3".repeat(32)}` });
    active.send("extra-authority", undefined, { connectionId: "other-node" });
    active.send("other-url", undefined, {}, "http://127.0.0.1:4412/index.html");
    active.send("other-file", undefined, {}, documentUrl.replace("index.html", "other.html"));
    await settle(); expect(active.call).not.toHaveBeenCalled();
    active.send("current", { kind: "context.get" }, {}, `${documentUrl}#view`); await settle();
    expect(active.call).toHaveBeenCalledExactlyOnceWith(surface, { kind: "context.get" }, active.options.host, expect.any(AbortSignal));
    expect(JSON.parse(active.replies[0]!)).toMatchObject({ frameId, surfaceId: surface.surfaceId,
      response: { id: "current", ok: true, result: { context: { locale: "en" } } } });
    active.send("current"); active.background(); active.send("background"); await settle(); expect(active.call).toHaveBeenCalledOnce();
  });

  it("cancels a retired document and never delivers its late result to its replacement", async () => {
    const active = harness(); let finish!: (value: unknown) => void;
    active.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    active.send("original", { kind: "routing.get" }); await settle();
    const signal = active.call.mock.calls[0]![3]; active.retire(); active.bridge.dispose();
    expect(signal.aborted).toBe(true); finish({ revision: "7", dataJson: "{}" }); await settle();
    expect(active.replies).toEqual([]); active.send("after-close"); await settle(); expect(active.call).toHaveBeenCalledOnce();
  });

  it("faults an unknown dispatched mutation, suppresses the queued effect and ignores its late success", async () => {
    vi.useFakeTimers(); const active = harness(); let finish!: (value: unknown) => void;
    active.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    active.send("mutation", { kind: "routing.set", revision: "7", dataJson: '{"selected":"mail"}' }); await settle();
    active.send("queued", { kind: "secret.clear", fieldId: "token" }); await settle();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(active.call).toHaveBeenCalledOnce(); expect(active.call.mock.calls[0]![3].aborted).toBe(true);
    active.send("retry", { kind: "routing.set", revision: "7", dataJson: "{}" }); await settle();
    finish({ revision: "8", dataJson: "{}" }); await settle();
    expect(active.call).toHaveBeenCalledOnce();
    expect(active.replies.map(value => JSON.parse(value).response)).toEqual([
      expect.objectContaining({ id: "mutation", ok: false }), expect.objectContaining({ id: "queued", ok: false }),
      expect.objectContaining({ id: "retry", ok: false })
    ]);
    expect(active.replies.filter(value => JSON.parse(value).response.id === "mutation")).toHaveLength(1);
  });

  it("allows a failed native context read to be retried without authorizing an effect", async () => {
    const active = harness(); active.call.mockRejectedValueOnce(new Error("temporary read failure"));
    active.send("first"); await settle(); active.send("second"); await settle();
    expect(active.call).toHaveBeenCalledTimes(2);
    expect(active.replies.map(value => JSON.parse(value).response.ok)).toEqual([false, true]);
  });

  it("keeps a directory choice alive for its picker lifetime and sends the complete bounded deposit", async () => {
    vi.useFakeTimers(); const active = harness(); let finish!: (value: unknown) => void;
    active.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    active.send("directory", { kind: "directory.pick", title: "Import reports" }); await settle();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(active.call.mock.calls[0]![3].aborted).toBe(false);
    const paths = Array.from({ length: 500 }, (_value, index) => `${"a".repeat(480)}-${index}.txt`);
    finish({ name: "Reports", dir_deposit: { token: "original-deposit", file_count: paths.length, total_bytes: 12, rel_paths: paths } }); await settle();
    expect(active.replies).toHaveLength(1); expect(new TextEncoder().encode(active.replies[0]!).byteLength).toBeGreaterThan(192 * 1024);
    expect(JSON.parse(active.replies[0]!).response.result.dir_deposit.rel_paths).toEqual(paths);
  });

  it("keeps the smaller response budget for other commands and rejects an oversized directory response without truncation", async () => {
    for (const [id, command, length] of [["routing", { kind: "routing.get" }, 200 * 1024], ["directory", { kind: "directory.pick" }, 4 * 1024 ** 2]] as const) {
      const active = harness(); active.call.mockResolvedValueOnce({ data: "x".repeat(length) });
      active.send(id, command); await settle();
      expect(active.replies).toEqual([]);
      active.send(`${id}-next`); await settle(); expect(active.call).toHaveBeenCalledOnce();
      expect(JSON.parse(active.replies[0]!).response).toMatchObject({ id: `${id}-next`, ok: false });
    }
  });

  it("connects the exact shipped SDK through native bootstrap readiness once and rejects foreign responses", async () => {
    const active = harness(), hostWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const dom = new JSDOM("<!doctype html>", { url: documentUrl, runScripts: "outside-only" });
    const page = dom.window as Window & typeof globalThis;
    Object.assign(page, { TextEncoder, Response });
    Object.defineProperty(page, "ReactNativeWebView", { configurable: true, value: { postMessage: vi.fn((raw: string) => active.bridge.receive(raw, documentUrl)) } });
    page.fetch = vi.fn(async () => new Response("unavailable"));
    page.postMessage = ((data: unknown) => page.dispatchEvent(new page.MessageEvent("message", { source: page, origin: page.location.origin, data }))) as typeof page.postMessage;
    const native = (page as unknown as { ReactNativeWebView: { postMessage: ReturnType<typeof vi.fn> } }).ReactNativeWebView;
    const delivered: string[] = [];
    active.options.send = (raw: string) => {
      delivered.push(raw); page.dispatchEvent(new page.MessageEvent("message", { data: raw }));
      page.document.dispatchEvent(new page.MessageEvent("message", { data: raw }));
    };
    try {
      page.eval(EXTENSION_SETTINGS_SDK_SOURCE);
      expect(Object.getOwnPropertyDescriptor(page, "WebSocket")?.configurable).toBe(false);
      expect(() => page.WebSocket).toThrow("Ambient settings capability is unavailable.");
      expect(Object.getOwnPropertyDescriptor(globalThis, "WebSocket")).toEqual(hostWebSocket);
      const sdk = (page as unknown as { joko: { settings(call: ExtensionSettingsCall): Promise<unknown> } }).joko;
      const pending = sdk.settings({ kind: "context.get" }); expect(native.postMessage).not.toHaveBeenCalled();
      const bootstrap = mobileExtensionSettingsBootstrap(frameId, surface.surfaceId); page.eval(bootstrap); page.eval(bootstrap);
      await expect(pending).resolves.toEqual({ context: { locale: "en" } }); expect(native.postMessage).toHaveBeenCalledOnce();
      const original = JSON.parse(delivered[0]!);
      page.dispatchEvent(new page.MessageEvent("message", { data: JSON.stringify({ ...original, frameId: "retired-frame" }) }));
      page.dispatchEvent(new page.MessageEvent("message", { data: JSON.stringify(original) }));
      expect(active.call).toHaveBeenCalledOnce();
      const paths = Array.from({ length: 500 }, (_value, index) => `${"r".repeat(480)}-${index}.txt`);
      active.call.mockResolvedValueOnce({ name: "Reports", dir_deposit: { token: "sdk-deposit", file_count: 500, total_bytes: 12, rel_paths: paths } });
      await expect(sdk.settings({ kind: "directory.pick" })).resolves.toEqual({ name: "Reports", dir_deposit: {
        token: "sdk-deposit", file_count: 500, total_bytes: 12, rel_paths: paths } });
      expect(delivered).toHaveLength(2); expect(new TextEncoder().encode(delivered[1]!).byteLength).toBeGreaterThan(192 * 1024);
      page.dispatchEvent(new page.Event("pagehide"));
      await expect(sdk.settings({ kind: "routing.get" })).rejects.toThrow(/closed|unavailable/u);
      expect(native.postMessage).toHaveBeenCalledTimes(2);
    } finally {
      dom.window.close();
      expect(Object.getOwnPropertyDescriptor(globalThis, "WebSocket")).toEqual(hostWebSocket);
    }
  });
});
