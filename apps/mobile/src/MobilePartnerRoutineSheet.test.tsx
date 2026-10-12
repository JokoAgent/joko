// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { PartnerRoutineEditor, RoutineCreationReceipts, ListPartnerRoutinesResponseSchema, PartnerRoutineSchema,
  ListPartnerRoutineRunsResponseSchema, GetPartnerRoutineCreationResponseSchema, RetirePartnerRoutineCreationResponseSchema,
  RoutineSourceStatus, type PartnerRoutineApi } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerRoutineSheet } from "./MobilePartnerRoutineSheet";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(value: string) => void>(), alert: vi.fn() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { Alert: { alert: native.alert }, AppState: { get currentState() { return native.state; },
    addEventListener: (_event: string, listener: (value: string) => void) => { native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } },
    ActivityIndicator: () => null, Modal: ({ children, allowSwipeDismissal }: { children: ReactNode; allowSwipeDismissal: boolean }) => React.createElement("div", { "data-swipe": String(allowSwipeDismissal) }, children),
    Pressable: element("button"), ScrollView: element("div"), Text: element("span"), View: element("div"), StyleSheet: { create: <T,>(value: T) => value },
    Switch: ({ value, disabled, accessibilityLabel, onValueChange }: { value: boolean; disabled?: boolean; accessibilityLabel: string; onValueChange: (value: boolean) => void }) => React.createElement("input", {
      type: "checkbox", checked: value, disabled, "aria-label": accessibilityLabel, onChange: () => onValueChange(!value) }),
    TextInput: ({ value, editable, accessibilityLabel, onChangeText, multiline }: { value: string; editable: boolean; accessibilityLabel: string; onChangeText: (value: string) => void; multiline?: boolean }) => React.createElement(multiline ? "textarea" : "input", {
      value, disabled: !editable, "aria-label": accessibilityLabel, onChange: () => undefined, onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value) }) };
});
vi.mock("react-native-safe-area-context", async () => { const React = await import("react");
  return { SafeAreaView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }; });
vi.mock("./MobileKeyboardAvoidingView", async () => { const React = await import("react");
  return { MobileKeyboardAvoidingView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children), useMobileKeyboardState: () => ({ height: 0, visible: false }) }; });

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
let root: Root | undefined; let host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); native.state = "active"; native.alert.mockReset(); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); native.listeners.clear(); vi.unstubAllGlobals(); localStorage.clear(); });
async function fixture() {
  let catalog = create(ListPartnerRoutinesResponseSchema, { partnerId: "partner", partnerRevision: { value: 2n }, writable: true,
    sources: [{ id: "extension:watcher", name: "Watcher", status: RoutineSourceStatus.LISTENING, events: [{ type: "change", name: "Change", fields: ["path"] }] }] });
  let counter = 0;
  const api: PartnerRoutineApi = { ownerKey: "owner", newRequestId: () => `routine-request-${++counter}`, list: vi.fn(async () => catalog),
    save: vi.fn(async (_revision, definition) => { const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition }); catalog = { ...catalog, routines: [routine] }; return routine; }),
    run: vi.fn(async () => {}), remove: vi.fn(async () => {}), history: vi.fn(async () => create(ListPartnerRoutineRunsResponseSchema)),
    lookup: vi.fn(async () => create(GetPartnerRoutineCreationResponseSchema)), retire: vi.fn(async () => create(RetirePartnerRoutineCreationResponseSchema)) };
  const editor = new PartnerRoutineEditor(api, new RoutineCreationReceipts(localStorage, "server-profile-device"), "partner"); const close = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(MobilePartnerRoutineSheet, { editor, colors, locale: "en", onClose: close })));
  return { api, editor, close };
}
function button(label: string) { const value = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(item => item.getAttribute("aria-label") === label); expect(value, label).toBeTruthy(); return value!; }
async function press(label: string) { await act(async () => button(label).click()); }
function input(label: string) { const value = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"],textarea[aria-label="${label}"]`); expect(value, label).toBeTruthy(); return value!; }
async function fill(label: string, value: string) { await act(async () => { input(label).value = value; input(label).dispatchEvent(new Event("input", { bubbles: true })); }); }
async function foreground(value: string) { await act(async () => { native.state = value; native.listeners.forEach(listener => listener(value)); }); }

describe("native Partner routine settings", () => {
  it("creates OR event conditions using installed source declarations and guards deletion with confirmation", async () => {
    const f = await fixture(); await fill("Name", "Review"); await fill("Instructions", "Inspect changes"); await press("+ Event");
    await press("Watcher · Listening"); await press("Change"); await press("Add filter"); await press("path"); await fill("Value", ".ts"); await press("Save");
    expect(f.api.save).toHaveBeenCalledOnce(); expect(vi.mocked(f.api.save).mock.calls[0]![1].triggers).toHaveLength(2);
    expect(vi.mocked(f.api.save).mock.calls[0]![1].triggers[1]?.kind).toMatchObject({ case: "event", value: { sourceId: "extension:watcher", eventType: "change", filters: [{ field: "path", value: ".ts" }] } });
    expect(host.querySelector('[data-swipe="false"]')).toBeTruthy(); await press("Run now"); expect(f.api.run).toHaveBeenCalledOnce();
    await press("Delete routine"); expect(f.api.remove).not.toHaveBeenCalled();
    const confirmation = native.alert.mock.calls[0]![2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => confirmation.find(item => item.text === "Confirm")!.onPress!()); expect(f.api.remove).toHaveBeenCalledOnce();
  });
  it("preserves dirty input on backgrounding, blocks writes on return and requires explicit discard before refreshing", async () => {
    const f = await fixture(); await fill("Name", "Unsaved"); await press("Close"); expect(f.close).not.toHaveBeenCalled(); expect(native.alert).toHaveBeenCalledOnce();
    await foreground("background"); expect(input("Name").disabled).toBe(true); await foreground("active");
    expect(input("Name").value).toBe("Unsaved"); expect(input("Name").disabled).toBe(true); expect(f.api.list).toHaveBeenCalledOnce();
    await press("Refresh"); const confirmation = native.alert.mock.calls.at(-1)![2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => confirmation.find(item => item.text === "Confirm")!.onPress!()); expect(f.api.list).toHaveBeenCalledTimes(2);
    expect(input("Name").value).toBe(""); expect(input("Name").disabled).toBe(false); expect(f.api.save).not.toHaveBeenCalled();
  });
});
