// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobilePartnerRestartTransport } from "./mobile-partner-restart";
import { MobilePartnerRestartPanel } from "./MobilePartnerRestartPanel";
import { profilePartner } from "./test/mobile-partner-profile";

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, disabled, onClick: onPress }, children);
  return { ActivityIndicator: () => null, View: element("div"), Text: element("span"), Pressable: element("button") };
});
const roots: Root[] = [];
const colors = { background: "white", surface: "white", ink: "black", muted: "gray", border: "gray", accent: "orange", negative: "red", brandBackground: "orange" };
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function button(text: string): HTMLButtonElement {
  const value = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === text);
  if (!value) throw new Error(`Missing ${text}`); return value;
}
async function settle(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
async function mount(transport: MobilePartnerRestartTransport, onChanged = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  const render = (next = transport) => <MobilePartnerRestartPanel transport={next} partner={profilePartner} colors={colors} locale="en" onChanged={onChanged} />;
  await act(async () => { root.render(render()); await settle(); }); return { root, render, onChanged };
}
async function confirm(): Promise<void> {
  await act(async () => { button("Restart Partner").click(); await settle(); });
  await act(async () => { button("Restart Partner").click(); await settle(); });
}
function transport(): MobilePartnerRestartTransport {
  return { ownerKey: "node-one", newRequestId: () => "restart-native-intent", listRequests: vi.fn(async () => []),
    controls: vi.fn(async () => ({ revision: profilePartner.revision, available: true })),
    restart: vi.fn(async (requestId, partner) => ({ requestId, partnerId: partner.partnerId, phase: "ready" as const, runtimeClosePending: false, createdAt: 1, updatedAt: 2 })),
    read: vi.fn(async () => ({ retired: false })), retire: vi.fn(async () => ({ retired: true })), retry: vi.fn() };
}
describe("Mobile Partner restart", () => {
  it("requires Host controls and explicit confirmation, then shows the next-input boundary", async () => {
    const active = transport(); const view = await mount(active);
    await act(async () => { button("Restart Partner").click(); await settle(); }); expect(document.querySelector("input")).toBeNull();
    await act(async () => { button("Cancel").click(); await settle(); }); expect(active.restart).not.toHaveBeenCalled();
    await confirm(); expect(active.restart).toHaveBeenCalledExactlyOnceWith("restart-native-intent", profilePartner, expect.any(AbortSignal));
    expect(view.onChanged).toHaveBeenCalledWith(expect.objectContaining({ phase: "ready" })); expect(document.body.textContent).toContain("your next message");
  });
  it("refreshes failed controls before allowing a restart", async () => {
    const active = transport(); active.controls = vi.fn().mockRejectedValueOnce(new Error("Read failed")).mockResolvedValue({ revision: profilePartner.revision, available: true });
    await mount(active); expect(button("Restart Partner").disabled).toBe(true); expect(document.body.textContent).toContain("could not be loaded");
    await act(async () => { button("Retry").click(); await settle(); }); expect(button("Restart Partner").disabled).toBe(false);
    expect(active.restart).not.toHaveBeenCalled();
  });
  it("recovers an unknown restart by querying or retiring it without another dispatch", async () => {
    const active = transport(); active.restart = vi.fn(async () => { throw new Error("Lost response"); }); await mount(active); await confirm();
    expect(active.restart).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("outcome is unknown");
    await act(async () => { button("Check restart result").click(); await settle(); }); expect(active.read).toHaveBeenCalledOnce();
    await act(async () => { button("Cancel unsent request").click(); await settle(); }); expect(active.retire).toHaveBeenCalledOnce(); expect(active.restart).toHaveBeenCalledOnce();
  });
  it("aborts an old owner and ignores a late restart result after a node switch", async () => {
    const active = transport(); let finish!: (value: Awaited<ReturnType<typeof active.restart>>) => void; let signal!: AbortSignal;
    active.restart = vi.fn((_id, _partner, expected) => { signal = expected; return new Promise<Awaited<ReturnType<typeof active.restart>>>((resolve) => { finish = resolve; }); });
    const view = await mount(active); await confirm(); const next = { ...transport(), ownerKey: "node-two" };
    await act(async () => { view.root.render(view.render(next)); await settle(); }); expect(signal.aborted).toBe(true);
    await act(async () => { finish({ requestId: "restart-native-intent", partnerId: profilePartner.partnerId, phase: "ready", runtimeClosePending: false, createdAt: 1, updatedAt: 2 }); await settle(); });
    expect(view.onChanged).not.toHaveBeenCalled(); expect(next.restart).not.toHaveBeenCalled();
  });
});
