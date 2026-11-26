// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { GetPartnerGlanceResponseSchema, ListPartnerHomeTargetsResponseSchema, type PartnerAutonomyApi, type PartnerHomeApi } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerGlanceSheet } from "./MobilePartnerGlanceSheet";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(value: string) => void>(), alert: vi.fn(), dismiss: undefined as (() => void) | undefined }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress, onLongPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void; onLongPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress, onContextMenu: onLongPress }, children);
  return { Alert: { alert: native.alert }, Platform: { OS: "ios" }, AppState: { get currentState() { return native.state; },
    addEventListener: (_event: string, callback: (value: string) => void) => { native.listeners.add(callback); return { remove: () => native.listeners.delete(callback) }; } },
    Modal: ({ visible, children, onDismiss }: { visible: boolean; children?: ReactNode; onDismiss?: () => void }) => { native.dismiss = onDismiss; return visible ? React.createElement("div", {}, children) : null; },
    Text: element("span"), View: element("div"), ScrollView: element("div"), Pressable: element("button"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Switch: ({ value, onValueChange, accessibilityLabel, disabled }: { value: boolean; onValueChange: (value: boolean) => void; accessibilityLabel: string; disabled: boolean }) =>
      React.createElement("input", { type: "checkbox", checked: value, disabled, "aria-label": accessibilityLabel, onChange: () => onValueChange(!value) }) };
});
vi.mock("react-native-safe-area-context", async () => { const React = await import("react"); return { SafeAreaView: ({ children }: { children?: ReactNode }) => React.createElement("div", {}, children) }; });
let root: Root | undefined;
beforeEach(() => { native.state = "active"; native.alert.mockReset(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; native.listeners.clear(); native.dismiss = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function fixture(homeApi?: PartnerHomeApi) {
  const api: PartnerAutonomyApi = { ownerKey: "original-owner", glance: vi.fn(async () => create(GetPartnerGlanceResponseSchema,
    { rows: [{ sessionId: "task-1", title: "Original review", online: true }] })), outputs: vi.fn(async () => []) };
  const close = vi.fn(), openTask = vi.fn(), homeSettings = vi.fn(), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = async (visible = true) => { await act(async () => { root!.render(<MobilePartnerGlanceSheet api={api} homeApi={homeApi} partnerId="partner" name="Ada" visible={visible}
    colors={{ background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#ffe" }} locale="en"
    onClose={close} onOpenTask={openTask} onHomeSettings={homeSettings} />); }); };
  await render(); return { api, close, openTask, render, homeSettings };
}
function button(label: string): HTMLButtonElement { const value = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === label || item.getAttribute("aria-label") === label); expect(value).toBeDefined(); return value!; }
describe("native Partner glance", () => {
  it("shows the actual home computer and opens the original switch sheet only after native dismissal", async () => {
    const homeApi = { ownerKey: "original-owner", list: vi.fn(async () => create(ListPartnerHomeTargetsResponseSchema, {
      home: { deviceId: "desktop", deviceName: "Actual desktop", available: true }, targets: [{ deviceName: "Another computer", available: true }] })) } as unknown as PartnerHomeApi;
    const f = await fixture(homeApi); expect(document.body.textContent).toContain("Actual desktop"); expect(document.body.textContent).toContain("Online"); expect(document.body.textContent).not.toContain("Another computer");
    await act(async () => { button("Change main computer").click(); }); expect(f.close).toHaveBeenCalledOnce(); expect(f.homeSettings).not.toHaveBeenCalled();
    await f.render(false); await act(async () => { native.dismiss?.(); }); expect(f.homeSettings).toHaveBeenCalledOnce();
  });
  it("reads the original tasks again after foregrounding and opens one after dismissal", async () => {
    const f = await fixture();
    const first = vi.mocked(f.api.glance).mock.calls[0]![1];
    const changeState = (value: string) => act(async () => { native.state = value; for (const callback of native.listeners) callback(value); });
    await changeState("background");
    expect(first.aborted).toBe(true);
    await changeState("active");
    expect(f.api.glance).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toMatch(/daily todo|start following up/iu);
    await act(async () => button("Original review").click());
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.openTask).not.toHaveBeenCalled();
    await f.render(false);
    await act(async () => native.dismiss?.());
    expect(f.openTask).toHaveBeenCalledExactlyOnceWith("task-1");
  });
});
