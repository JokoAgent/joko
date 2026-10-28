// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "./model.js";
import { bindExtensionViewClose, registerExtensionPageClose, requestExtensionNavigationLeave } from "./extension-view-lifecycle.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const profile: ConnectionProfile = { id: "profile", serverId: "node", deviceId: "device", name: "Node", origin: "https://node.test", endpointPublicKey: "ed25519:pin" };
describe("Extension view user close", () => {
  it("accepts a veto only from the exact sandbox frame and current close request", async () => {
    const frame = document.body.appendChild(document.createElement("iframe")), source = frame.contentWindow!;
    const post = vi.spyOn(source, "postMessage"); let current = true;
    const bridge = bindExtensionViewClose(frame, () => current);
    const reply = (data: unknown, origin = "null", sender = source): void => { window.dispatchEvent(new MessageEvent("message", { origin, source: sender, data })); };
    reply({ type: "joko:extension-close-ready", version: 1 });
    const pending = bridge.close(), message = post.mock.calls.at(-1)![0] as { id: string };
    reply({ type: "joko:extension-close-result", version: 1, id: message.id, allowed: true }, "https://attacker.test");
    reply({ type: "joko:extension-close-result", version: 1, id: "close_stale", allowed: true });
    reply({ type: "joko:extension-close-result", version: 1, id: message.id, allowed: false });
    await expect(pending).resolves.toBe(false);
    const accepted = bridge.close(), next = post.mock.calls.at(-1)![0] as { id: string };
    reply({ type: "joko:extension-close-result", version: 1, id: next.id, allowed: true });
    await expect(accepted).resolves.toBe(true);
    current = false; await expect(bridge.close()).resolves.toBe(false); bridge.dispose();
  });
  it("does not close on an unanswered handler or on frame retirement", async () => {
    vi.useFakeTimers();
    const frame = document.body.appendChild(document.createElement("iframe"));
    const bridge = bindExtensionViewClose(frame, () => true);
    window.dispatchEvent(new MessageEvent("message", { origin: "null", source: frame.contentWindow, data: { type: "joko:extension-close-ready", version: 1 } }));
    const pending = bridge.close(); await vi.advanceTimersByTimeAsync(10_000); await expect(pending).resolves.toBe(false);
    const retired = bridge.close(); bridge.dispose(); await expect(retired).resolves.toBe(false);
  });
  it("binds navigation to the original profile and page registration, including cancellation", async () => {
    const route = { kind: "extensionMainView" as const, extensionId: "extension" }, next = { kind: "session" as const };
    let finish!: (value: boolean) => void;
    const old = registerExtensionPageClose(profile, route.extensionId, () => new Promise(resolve => { finish = resolve; }));
    const pending = requestExtensionNavigationLeave(profile, route, next, new AbortController().signal)!;
    const replacement = registerExtensionPageClose(profile, route.extensionId, async () => true);
    old(); finish(true); await expect(pending).resolves.toBe(false);
    await expect(requestExtensionNavigationLeave(profile, route, next, new AbortController().signal)).resolves.toBe(true);
    expect(requestExtensionNavigationLeave({ ...profile, endpointPublicKey: "replacement" }, route, next, new AbortController().signal)).toBeUndefined();
    replacement();
    const unregister = registerExtensionPageClose(profile, route.extensionId, () => new Promise(() => undefined));
    const abort = new AbortController(), cancelled = requestExtensionNavigationLeave(profile, route, next, abort.signal); abort.abort();
    await expect(cancelled).resolves.toBe(false); unregister();
  });
});
