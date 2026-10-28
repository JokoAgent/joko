// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { PartnerAutonomySettingsSchema, PartnerTodoSchema, ListPartnerTodosResponseSchema, ListPartnerHomeTargetsResponseSchema, type PartnerAutonomyApi, type PartnerHomeApi } from "@joko/contracts";
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
  const todo = create(PartnerTodoSchema, { id: "todo:review", revision: 1n, title: "Review report", outcome: "A reviewed report", status: "open", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  const api: PartnerAutonomyApi = { ownerKey: "original-owner", newOperationId: () => "original-operation", settings: vi.fn(async () => create(PartnerAutonomySettingsSchema, { revision: { value: 1n }, customized: false })),
    save: vi.fn(), glance: vi.fn(), todos: vi.fn(async (_partnerId, view) => create(ListPartnerTodosResponseSchema, { partnerId: "partner", partnerRevision: { value: 1n }, items: view === "open" ? [todo] : [], total: view === "open" ? 1 : 0 })), updateTodo: vi.fn(), outputs: vi.fn(async () => []) };
  const close = vi.fn(), quote = vi.fn(), homeSettings = vi.fn(), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = async (visible = true) => { await act(async () => { root!.render(<MobilePartnerGlanceSheet api={api} homeApi={homeApi} partnerId="partner" name="Ada" visible={visible} engaged
    colors={{ background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#ffe" }} locale="en"
    onClose={close} onQuote={quote} onOpenTask={() => undefined} onHomeSettings={homeSettings} />); }); };
  await render(); return { api, close, quote, render, todo, homeSettings };
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
  it("quotes only after its native sheet closes and exposes only delete in the long-press menu", async () => {
    const f = await fixture(); await act(async () => button("Discuss this affair: Review report").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    const actions = native.alert.mock.calls.at(-1)![2] as Array<{ text: string }>;
    expect(actions.map(action => action.text)).toEqual(["Cancel", "Delete"]); expect(f.api.updateTodo).not.toHaveBeenCalled();
    await act(async () => button("Discuss this affair: Review report").click()); expect(f.close).toHaveBeenCalledOnce(); expect(f.quote).not.toHaveBeenCalled();
    await f.render(false); await act(async () => native.dismiss?.()); expect(f.quote).toHaveBeenCalledWith(f.todo);
  });
  it("retires an old allowance confirmation after entering the background", async () => {
    const f = await fixture(); await act(async () => button("Start following up").click());
    const accept = (native.alert.mock.calls.at(-1)![2] as Array<{ onPress?: () => void }>)[1]!.onPress!;
    await act(async () => { native.state = "background"; for (const callback of native.listeners) callback("background"); accept(); });
    expect(f.api.save).not.toHaveBeenCalled();
  });
});
