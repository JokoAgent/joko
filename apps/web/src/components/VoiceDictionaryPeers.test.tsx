// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VoiceDictionaryPeerApi, VoiceDictionaryPeerStatusView } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
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
  const api = { getVoiceInputDictionaryPeerStatus: vi.fn(async () => value), grantVoiceInputDictionaryPeer: vi.fn(async () => value),
    revokeVoiceInputDictionaryPeer: vi.fn(async () => value), syncVoiceInputDictionaryNow: vi.fn(async () => value) };
  return { api, set: (next: VoiceDictionaryPeerStatusView) => { value = next; } };
}
const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
async function render(api: VoiceDictionaryPeerApi, enabled = true): Promise<void> { await act(async () => root.render(<VoiceDictionaryPeers api={api} t={t} enabled={enabled} />)); }
function button(text: string): HTMLButtonElement { return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!; }
async function click(text: string): Promise<void> { await act(async () => button(text).click()); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) }; }

describe("dictionary sharing settings", () => {
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
