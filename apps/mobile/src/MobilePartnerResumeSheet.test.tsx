// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartnerResumeEditor, type PartnerResumeProfile } from "@joko/contracts";
import { MobilePartnerResumeSheet } from "./MobilePartnerResumeSheet";
const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(value: string) => void>() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (value: string) => void) => {
    native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } }, ActivityIndicator: () => null,
    Modal: ({ children, allowSwipeDismissal }: { children: ReactNode; allowSwipeDismissal: boolean }) => React.createElement("div", { "data-swipe": String(allowSwipeDismissal) }, children),
    Pressable: element("button"), ScrollView: element("div"), Text: element("span"), View: element("div"), StyleSheet: { create: <T,>(value: T) => value } };
});
vi.mock("react-native-safe-area-context", async () => { const React = await import("react");
  return { SafeAreaView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children) }; });
let root: Root; let host: HTMLDivElement;
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
const initial: PartnerResumeProfile = { partnerId: "partner", revision: 1n, profileVersion: 1n, displayName: "Reviewer", homeTargetId: "home", canonicalSessionId: "canonical", backendId: "backend",
  lifecycle: "paused", initializationState: "ready", pauseCleanupPending: false };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); native.state = "active"; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); native.listeners.clear(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const button = (name: string) => { const value = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`); if (!value) throw new Error(`Missing ${name}`); return value; };
function fixture() { let profile = initial;
  const api = { ownerKey: "node-owner", read: vi.fn(async () => profile), resume: vi.fn(async (selected: PartnerResumeProfile) => profile = { ...selected, revision: selected.revision + 1n, lifecycle: "active" as const, pauseCleanupPending: undefined }) };
  return { api, editor: new PartnerResumeEditor(api, initial), profile: (value: PartnerResumeProfile) => { profile = value; } };
}
it("confirms native resume, blocks closing while pending and displays the verified result", async () => {
  const f = fixture(); const changed = vi.fn(); const close = vi.fn(); let finish!: () => void; const original = f.api.resume.getMockImplementation()!;
  f.api.resume.mockImplementation(async selected => { await new Promise<void>(resolve => { finish = resolve; }); return original(selected); });
  await act(async () => { root.render(createElement(MobilePartnerResumeSheet, { editor: f.editor, colors, locale: "en", onClose: close, onChanged: changed })); await settle(); });
  expect(host.textContent).toContain("manually stay paused"); expect(f.api.resume).not.toHaveBeenCalled(); expect(host.querySelector('[data-swipe="false"]')).not.toBeNull();
  await act(async () => { button("Resume partner").click(); await settle(); }); expect(button("Close").disabled).toBe(true); expect(changed).not.toHaveBeenCalled();
  await act(async () => { finish(); await settle(); }); expect(changed).toHaveBeenCalledOnce(); expect(host.textContent).toContain("Partner resumed");
  await act(async () => { button("Close").click(); }); expect(close).toHaveBeenCalledOnce();
});
it("retires background results and performs a fresh read on return without replaying a resume", async () => {
  const f = fixture(); let finish!: () => void; const original = f.api.resume.getMockImplementation()!; const changed = vi.fn();
  f.api.resume.mockImplementation(async selected => { await new Promise<void>(resolve => { finish = resolve; }); return original(selected); });
  await act(async () => { root.render(createElement(MobilePartnerResumeSheet, { editor: f.editor, colors, locale: "en", onClose: vi.fn(), onChanged: changed })); await settle(); });
  await act(async () => { button("Resume partner").click(); await settle(); });
  await act(async () => { native.state = "background"; for (const listener of native.listeners) listener(native.state); finish(); await settle(); });
  expect(changed).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("Reviewer"); expect(button("Resume partner").disabled).toBe(true);
  await act(async () => { native.state = "active"; for (const listener of native.listeners) listener(native.state); await settle(); });
  expect(changed).toHaveBeenCalledOnce(); expect(f.api.resume).toHaveBeenCalledOnce(); expect(host.textContent).toContain("Partner resumed");
});
