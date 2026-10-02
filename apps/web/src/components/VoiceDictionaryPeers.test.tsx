// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VoiceDictionaryPeerApi, VoiceDictionaryPeerStatusView } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import { dictionaryWatchFixture } from "../voice-dictionary.test-support.js";
import { VoiceDictionaryPeers } from "./VoiceDictionaryPeers.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(document, "visibilityState"); });

function status(patch: Partial<VoiceDictionaryPeerStatusView> = {}): VoiceDictionaryPeerStatusView {
  return { available: true, configurationRevision: 5n, nodeId: "node-self", fingerprint: "a".repeat(64), enabled: true, phase: "waiting", peers: [],
    candidates: [{ nodeId: "node-peer", displayName: "Peer computer", fingerprint: "b".repeat(64), seenAt: 1_000, granted: false, keyChanged: false }], ...patch };
}
function fixture() {
  let value = status();
  const updates = dictionaryWatchFixture<VoiceDictionaryPeerStatusView>();
  const api = { getVoiceInputDictionaryPeerStatus: vi.fn(async () => value), grantVoiceInputDictionaryPeer: vi.fn(async () => value),
    watchVoiceInputDictionaryPeerStatus: vi.fn(updates.watch),
    revokeVoiceInputDictionaryPeer: vi.fn(async () => value), syncVoiceInputDictionaryNow: vi.fn(async () => value),
    configureVoiceInputDictionaryListener: vi.fn(async () => value), getVoiceInputDictionaryPeerInvitation: vi.fn(async () => invitation("node-self", "a")),
    grantVoiceInputDictionaryDirectPeer: vi.fn(async (_revision: bigint, _invitation: string, _fingerprint: string, _signal?: AbortSignal) => value), clearVoiceInputDictionaryPeerRoute: vi.fn(async () => value) };
  return { api, updates, set: (next: VoiceDictionaryPeerStatusView) => { value = next; } };
}
const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
async function render(api: VoiceDictionaryPeerApi, enabled = true): Promise<void> { await act(async () => root.render(<VoiceDictionaryPeers api={api} t={t} enabled={enabled} />)); }
function button(text: string): HTMLButtonElement { return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!; }
async function click(text: string): Promise<void> { await act(async () => button(text).click()); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
function invitation(nodeId = "node-peer", fingerprint = "b") { return JSON.stringify({ version: 1, nodeId, displayName: "Direct peer",
  publicKey: "MCowBQYDK2VuAyEA" + "A".repeat(43) + "=", fingerprint: fingerprint.repeat(64), host: "peer.example", port: 43_121 }); }
async function fill(label: string, value: string): Promise<void> {
  const field = [...container.querySelectorAll("label")].find((item) => item.textContent === label)!.querySelector("input,textarea")!;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("dictionary sharing settings", () => {
  it("keeps the listener draft revision, exports a selectable invitation and clears only the saved route", async () => {
    const f = fixture(); f.set(status({ listener: { listenPort: 43_121, host: "peer.example", port: 43_121 }, peers: [
      { peerId: "node-peer", revision: 3n, displayName: "Peer", fingerprint: "b".repeat(64), online: false, grantedAt: 1_000, route: { host: "peer.example", port: 43_121 } }
    ], candidates: [] }));
    await render(f.api);
    expect(container.textContent).toContain("Saved address: peer.example:43121");
    expect(container.textContent).toContain("Offline");
    await fill("Reachable host", "updated.example");
    await act(async () => f.updates.push(status({ configurationRevision: 6n, listener: { listenPort: 43_121, host: "peer.example", port: 43_121 } })));
    expect(button("Save listening address").disabled).toBe(true);
    expect((container.querySelectorAll("input")[1] as HTMLInputElement).value).toBe("updated.example");
    await click("Review current listening address");
    await fill("Reachable host", "peer.example");
    f.set(status({ configurationRevision: 7n, listener: { listenPort: 43_121, host: "peer.example", port: 43_121 }, peers: [
      { peerId: "node-peer", revision: 3n, displayName: "Peer", fingerprint: "b".repeat(64), online: false, grantedAt: 1_000, route: { host: "peer.example", port: 43_121 } }
    ], candidates: [] }));
    await click("Save listening address");
    expect(f.api.configureVoiceInputDictionaryListener).toHaveBeenCalledWith(6n, { listenPort: 43_121, host: "peer.example", port: 43_121 }, expect.any(AbortSignal));
    await click("Show this node’s invitation");
    expect(container.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value).toBe(invitation("node-self", "a"));
    await click("Remove saved peer address");
    expect(f.api.clearVoiceInputDictionaryPeerRoute).toHaveBeenCalledExactlyOnceWith(7n, "node-peer", expect.any(AbortSignal));
    expect(f.api.revokeVoiceInputDictionaryPeer).not.toHaveBeenCalled();
  });
  it("previews a direct invitation and freezes the exact bytes, fingerprint and configuration through live changes", async () => {
    const f = fixture(); await render(f.api);
    await fill("Other node’s invitation", invitation()); await click("Review invitation and fingerprint");
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain("b".repeat(64));
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain("peer.example:43121");
    await act(async () => f.updates.push(status({ configurationRevision: 6n })));
    expect(button("Confirm").disabled).toBe(true); expect(f.api.grantVoiceInputDictionaryDirectPeer).not.toHaveBeenCalled();
    await click("Cancel"); await click("Review invitation and fingerprint");
    const gate = deferred<VoiceDictionaryPeerStatusView>(); f.api.grantVoiceInputDictionaryDirectPeer.mockImplementationOnce(() => gate.promise);
    await click("Confirm");
    expect(f.api.grantVoiceInputDictionaryDirectPeer).toHaveBeenCalledExactlyOnceWith(6n, invitation(), "b".repeat(64), expect.any(AbortSignal));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(f.api.grantVoiceInputDictionaryDirectPeer.mock.calls[0]![3]!.aborted).toBe(true);
    await act(async () => gate.resolve(status({ configurationRevision: 7n })));
    expect(container.textContent).not.toContain("The sharing request completed.");
  });
  it("keeps live authority and equal-revision metadata ahead of late RPCs, and reconnects explicitly after disconnect", async () => {
    const f = fixture();
    const read = deferred<VoiceDictionaryPeerStatusView>();
    f.api.getVoiceInputDictionaryPeerStatus.mockImplementationOnce(() => read.promise);
    await render(f.api);
    await act(async () => f.updates.push(status({ configurationRevision: 6n, phase: "syncing" })));
    await act(async () => read.resolve(status()));
    expect(container.textContent).toContain(t("settings.voicePeers.syncing"));
    await click("Authorize dictionary sharing");
    await act(async () => f.updates.push(status({ configurationRevision: 7n })));
    expect(button("Confirm").disabled).toBe(true);
    expect(f.api.grantVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    await click("Cancel");
    const mutation = deferred<VoiceDictionaryPeerStatusView>();
    f.api.syncVoiceInputDictionaryNow.mockImplementationOnce(() => mutation.promise);
    await click("Sync now");
    expect(f.api.syncVoiceInputDictionaryNow).toHaveBeenCalledExactlyOnceWith(7n, undefined, expect.any(AbortSignal));
    await act(async () => f.updates.push(status({ configurationRevision: 7n, phase: "syncing" })));
    await act(async () => mutation.resolve(status({ configurationRevision: 7n })));
    expect(container.textContent).toContain(t("settings.voicePeers.syncing"));
    await act(async () => f.updates.end());
    expect(button("Sync now").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    f.set(status({ configurationRevision: 7n }));
    await click(t("settings.voicePeers.refresh"));
    expect(f.api.watchVoiceInputDictionaryPeerStatus).toHaveBeenCalledTimes(2);
    expect(button("Sync now").disabled).toBe(true);
    await act(async () => f.updates.push(status({ configurationRevision: 7n })));
    expect(button("Sync now").disabled).toBe(false);
  });
  it("requires the full fingerprint confirmation, freezes revisions, and waits for a single grant before publishing", async () => {
    const f = fixture(); await render(f.api);
    await click("Authorize dictionary sharing");
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain("b".repeat(64));
    expect(document.activeElement).toBe(button("Confirm"));
    await click("Cancel"); expect(f.api.grantVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    await click("Authorize dictionary sharing");
    const gate = deferred<VoiceDictionaryPeerStatusView>(); f.api.grantVoiceInputDictionaryPeer.mockImplementationOnce(() => gate.promise);
    await click("Confirm"); await click("Confirm");
    expect(f.api.grantVoiceInputDictionaryPeer).toHaveBeenCalledExactlyOnceWith(5n, "node-peer", "b".repeat(64), expect.any(AbortSignal));
    expect(button("Confirm").disabled).toBe(true);
    const committed = status({ configurationRevision: 6n, candidates: [], peers: [{ peerId: "node-peer", revision: 6n, displayName: "Peer computer", fingerprint: "b".repeat(64), online: false, grantedAt: 1_000 }] });
    f.set(committed); await act(async () => gate.resolve(committed));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(button("Revoke dictionary access")).toBeDefined();
    await click("Revoke dictionary access"); await click("Confirm");
    expect(f.api.revokeVoiceInputDictionaryPeer).toHaveBeenCalledWith("node-peer", 6n, expect.any(AbortSignal));
  });
  it("refreshes a conflict without replay or silently replacing the confirmed identity", async () => {
    const f = fixture(); await render(f.api); await click("Authorize dictionary sharing");
    f.set(status({ configurationRevision: 6n }));
    f.api.grantVoiceInputDictionaryPeer.mockRejectedValueOnce(new Error("Revision changed."));
    await click("Confirm");
    expect(f.api.grantVoiceInputDictionaryPeer).toHaveBeenCalledOnce();
    expect(button("Confirm").disabled).toBe(true);
    expect(container.textContent).toContain("The identity or authorization changed.");
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
  });
  it("retires a pending grant and its feedback on a new owner or a background/resume occurrence", async () => {
    const first = fixture(); const second = fixture();
    await render(first.api); await click("Authorize dictionary sharing");
    const gate = deferred<VoiceDictionaryPeerStatusView>(); first.api.grantVoiceInputDictionaryPeer.mockImplementationOnce(() => gate.promise);
    await click("Confirm");
    await render(second.api); await act(async () => gate.resolve(status()));
    expect(container.textContent).not.toContain("The sharing request completed.");
    expect(second.api.grantVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    await click("Authorize dictionary sharing");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(second.api.grantVoiceInputDictionaryPeer).not.toHaveBeenCalled();
  });
  it("keeps revocation available while disabled and blocks silent key replacement", async () => {
    const f = fixture(); f.set(status({ enabled: false, phase: "off", peers: [{ peerId: "node-peer", revision: 3n, displayName: "Peer", fingerprint: "c".repeat(64), online: false, grantedAt: 1_000 }],
      candidates: [{ nodeId: "node-peer", displayName: "Peer", fingerprint: "b".repeat(64), seenAt: 1_000, granted: false, keyChanged: true }] }));
    await render(f.api, false);
    expect(button("Sync now").disabled).toBe(true); expect(button("Authorize dictionary sharing").disabled).toBe(true);
    expect(button("Revoke dictionary access").disabled).toBe(false);
    expect(container.textContent).toContain("Identity changed.");
  });
});
