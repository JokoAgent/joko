// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobilePartnerDeletionTransport } from "./mobile-partner-deletion";
import { MobilePartnerDeletionPanel } from "./MobilePartnerDeletionPanel";
import { profilePartner } from "./test/mobile-partner-profile";

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, disabled, onClick: onPress }, children);
  return { ActivityIndicator: () => null, View: element("div"), Text: element("span"), Pressable: element("button"),
    TextInput: ({ value, editable, accessibilityLabel, onChangeText }: { value: string; editable: boolean; accessibilityLabel: string; onChangeText: (value: string) => void }) => React.createElement("input", {
      value, disabled: !editable, "aria-label": accessibilityLabel, onChange: () => undefined,
      onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value)
    }) };
});
const roots: Root[] = [];
const colors = { background: "white", surface: "white", ink: "black", muted: "gray", border: "gray", accent: "orange", negative: "red", brandBackground: "orange" };
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function button(text: string): HTMLButtonElement {
  const value = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === text);
  if (!value) throw new Error(`Missing ${text}`); return value;
}
async function settle(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
async function mount(transport: MobilePartnerDeletionTransport, onChanged = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  const render = (next = transport) => <MobilePartnerDeletionPanel transport={next} partner={profilePartner} colors={colors} locale="en" onChanged={onChanged} />;
  await act(async () => { root.render(render()); await settle(); }); return { root, render, onChanged };
}
async function confirm(): Promise<void> {
  await act(async () => { button("Delete Partner").click(); await settle(); });
  const input = document.querySelector<HTMLInputElement>("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, profilePartner.displayName);
    input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("Delete Partner").click(); await settle(); });
}
function transport(): MobilePartnerDeletionTransport {
  return { ownerKey: "node-one", newRequestId: () => "deletion-native-intent", listRequests: vi.fn(async () => []),
    delete: vi.fn(async (requestId, partner) => ({ requestId, partnerId: partner.partnerId, phase: "completed" as const, createdAt: 1, updatedAt: 2 })),
    read: vi.fn(async () => ({ retired: false })), retire: vi.fn(async () => ({ retired: true })), retry: vi.fn() };
}
describe("Mobile Partner deletion", () => {
  it("requires a full-name confirmation and closes only on a confirmed result", async () => {
    const active = transport(); const view = await mount(active);
    await act(async () => { button("Delete Partner").click(); await settle(); });
    expect(button("Delete Partner").disabled).toBe(true);
    await act(async () => { button("Cancel").click(); await settle(); }); expect(active.delete).not.toHaveBeenCalled();
    await confirm(); expect(active.delete).toHaveBeenCalledWith("deletion-native-intent", profilePartner, profilePartner.displayName, expect.any(AbortSignal));
    expect(view.onChanged).toHaveBeenCalledWith(expect.objectContaining({ phase: "completed" }));
  });
  it("recovers unknown requests by querying or retiring them without another destructive dispatch", async () => {
    const active = transport(); active.delete = vi.fn(async () => { throw new Error("Lost response"); }); await mount(active);
    await confirm(); expect(active.delete).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("outcome is unknown");
    await act(async () => { button("Check deletion result").click(); await settle(); }); expect(active.read).toHaveBeenCalledOnce();
    await act(async () => { button("Cancel unsent request").click(); await settle(); }); expect(active.retire).toHaveBeenCalledOnce(); expect(active.delete).toHaveBeenCalledOnce();
  });
  it("aborts an old owner and ignores a late deletion result after a node switch", async () => {
    const active = transport(); let finish!: (value: Awaited<ReturnType<typeof active.delete>>) => void; let signal!: AbortSignal;
    active.delete = vi.fn((_id, _partner, _name, expected) => { signal = expected; return new Promise<Awaited<ReturnType<typeof active.delete>>>((resolve) => { finish = resolve; }); });
    const view = await mount(active); await confirm(); const next = { ...transport(), ownerKey: "node-two" };
    await act(async () => { view.root.render(view.render(next)); await settle(); }); expect(signal.aborted).toBe(true);
    await act(async () => { finish({ requestId: "deletion-native-intent", partnerId: profilePartner.partnerId, phase: "completed", createdAt: 1, updatedAt: 2 }); await settle(); });
    expect(view.onChanged).not.toHaveBeenCalled(); expect(next.delete).not.toHaveBeenCalled();
  });
});
