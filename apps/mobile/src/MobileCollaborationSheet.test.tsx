// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { CollaborationGoalTreeSchema, CollaborationGoalStatus, CollaborationWorkerStatus, PermissionMode } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileCollaborationApi, MobileCollaborationView } from "./mobile-collaboration";
import { Platform } from "react-native";
vi.mock("./MobileCollaborationNativeSheet", () => import("./MobileCollaborationNativeSheet.ios"));
vi.mock("@expo/ui", () => ({ Host: ({ children }: { children: ReactNode }) => children }));
vi.mock("@expo/ui/swift-ui/modifiers", () => Object.fromEntries([
  "accessibilityLabel", "buttonStyle", "disabled", "font", "foregroundStyle", "frame", "lineLimit",
  "onLongPressGesture", "pickerStyle", "presentationDragIndicator", "tag"
].map(key => [key, (value: unknown) => value])));
vi.mock("@expo/ui/swift-ui", async () => {
  const React = await import("react");
  const content = ({ children }: { children: ReactNode }) => children;
  return { BottomSheet: content, Form: content, Group: content, Section: content, Text: content,
    ProgressView: () => null, TextField: () => null, useNativeState: () => ({ set() {} }),
    Button: ({ label, onPress, modifiers }: { label: string; onPress: () => void; modifiers: unknown[] }) =>
      React.createElement("button", { "aria-label": label, onClick: onPress, disabled: modifiers.includes(true) }, label),
    Picker: ({ label, selection, onSelectionChange, children }: { label: string; selection: string; onSelectionChange: (v: string) => void; children: ReactNode }) =>
      React.createElement("select", { "aria-label": label, value: selection, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onSelectionChange(e.target.value) },
        React.Children.map(children, child => React.isValidElement<{ modifiers: string[]; children: ReactNode }>(child)
          ? React.createElement("option", { value: child.props.modifiers[0] }, child.props.children) : null))
  };
});
vi.mock("react-native", () => ({
  Platform: { get OS() { return "android"; } }, StyleSheet: { create: (value: unknown) => value },
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? createElement("div", null, children) : null,
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children), ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Switch: () => null,
  TextInput: ({ value, onChangeText, editable, accessibilityLabel }: { value: string; onChangeText: (value: string) => void; editable: boolean; accessibilityLabel: string }) =>
    createElement("textarea", { value, disabled: !editable, "aria-label": accessibilityLabel, onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
  Pressable: ({ children, onPress, onLongPress, disabled, accessibilityLabel }: { children: ReactNode; onPress?: () => void; onLongPress?: () => void; disabled: boolean; accessibilityLabel?: string }) =>
    createElement("button", { onClick: onPress, onContextMenu: onLongPress, disabled, "aria-label": accessibilityLabel }, children)
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("./MobileKeyboardAvoidingView", () => ({ MobileKeyboardAvoidingView: ({ children }: { children: ReactNode }) => createElement("div", null, children), useMobileKeyboardState: () => ({ shown: false, height: 0 }) }));
import { MobileCollaborationSheet } from "./MobileCollaborationSheet";
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#f80", negative: "#c00", brandBackground: "#ffe" };
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
function api(view: MobileCollaborationView = { role: "ordinary" }, ownerKey = "owner"): MobileCollaborationApi {
  return { ownerKey, sessionId: "task", generation: 7n, profileId: "profile", writable: true, initialTargetId: "target",
    targets: [{ id: "target", name: "Project", backendId: "backend", backendName: "Backend", models: [], permissionModes: [PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS], canSetEffort: false, canSetFastMode: false }],
    restore: vi.fn(async () => undefined), load: vi.fn(async () => view), enable: vi.fn(async (): Promise<MobileCollaborationView> => ({ role: "lead" })), create: vi.fn(), archive: vi.fn(async () => view), end: vi.fn(), openWorker: vi.fn(), openLead: vi.fn(), resolveReport: vi.fn() };
}
async function render(value: MobileCollaborationApi) { await act(async () => root.render(createElement(MobileCollaborationSheet, { visible: true, api: value, colors, locale: "en", disabled: false, onClose() {} }))); }
async function press(label: string) { const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(value => value.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined(); await act(async () => button!.click()); }
describe("mobile collaboration native form controller", () => {
  it.each(["android", "ios"] as const)("submits Ultrafast on %s for a worker route that has no ordinary Fast tier", async platform => {
    vi.spyOn(Platform, "OS", "get").mockReturnValue(platform);
    const value = api();
    const route = { key: "chosen", backendId: "backend", providerId: "provider", providerName: "Provider", modelId: "chosen",
      displayName: "Chosen", family: "", contextWindowTokens: 0n, maximumOutputTokens: 0n, efforts: [], supportsFastMode: false, supportsUltrafastMode: true };
    await render({ ...value, targets: [{ ...value.targets[0]!, canSetFastMode: true, models: [route] }] });
    if (platform === "ios") {
      const select = (label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      const choose = async (label: string, key: string) => act(() => { const picker = select(label); picker.value = key; picker.dispatchEvent(new Event("change", { bubbles: true })); });
      await choose("Model", "chosen");
      expect(Array.from(select("Speed").options, option => [option.value, option.text])).toEqual([["false", "Standard"], ["ultrafast", "Ultrafast"]]);
      await choose("Speed", "ultrafast");
    } else {
      await press("Backend default"); await press("Provider · Chosen"); await press("Ultrafast");
      expect(host.querySelector('[aria-label="Fast"]')).toBeNull();
    }
    await press("Enable collaboration");
    expect(value.enable).toHaveBeenCalledWith(expect.objectContaining({ model: { providerId: "provider", modelId: "chosen", fastMode: "ultrafast" } }), expect.any(AbortSignal));
  });

  it("creates a waiting worker only after explicit full-permission confirmation and keeps the form after partial enable failure", async () => {
    const value = api(); vi.mocked(value.enable).mockRejectedValueOnce(new Error("Worker creation was not confirmed")); await render(value);
    await press("Allow safe actions"); await press("Full access"); await press("Enable collaboration");
    expect(value.enable).not.toHaveBeenCalled(); expect(host.textContent).toContain("Allow full permissions?");
    await press("Confirm"); expect(host.textContent).toContain("Worker creation was not confirmed");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    await press("Enable collaboration"); await press("Confirm");
    expect(value.enable).toHaveBeenLastCalledWith({ role: "developer", targetId: "target", initialTask: "", permissionMode: PermissionMode.BYPASS_PERMISSIONS }, expect.any(AbortSignal));
    expect(value.enable).toHaveBeenCalledTimes(2);
  });
  it.each([0, 20])("shows worker capacity with idle release %i, opens the original worker, and confirms archive", async idleRelease => {
    const tree = create(CollaborationGoalTreeSchema, { goal: { goalId: "goal", status: CollaborationGoalStatus.ACTIVE }, workers: [{ workerId: "worker", sessionId: "worker-task", label: "reviewer", role: "reviewer", status: CollaborationWorkerStatus.COMPLETED }] });
    const view: MobileCollaborationView = { role: "lead", tree, settings: { $typeName: "joko.v1.CollaborationSettings", workerSoftLimit: 4, workerHardLimit: 12, workerIdleReleaseMinutes: idleRelease, customized: false } };
    const value = api(view); await render(value); expect(host.textContent).toContain("hard limit 12");
    expect(host.textContent).toContain(idleRelease === 0 ? "idle release off" : "idle release 20 min");
    await press("reviewer · Complete"); expect(value.openWorker).toHaveBeenCalledWith(view, tree.workers[0], expect.any(AbortSignal));
    await press("Archive worker · reviewer"); expect(value.archive).not.toHaveBeenCalled(); await press("Confirm");
    expect(value.archive).toHaveBeenCalledWith(view, tree.workers[0], expect.any(AbortSignal));
  });
  it("keeps worker control limited to return-lead and self-archive and rejects a late old-owner form", async () => {
    const tree = create(CollaborationGoalTreeSchema, { goal: { leadSessionId: "lead" }, workers: [{ workerId: "self", sessionId: "task", label: "self", status: CollaborationWorkerStatus.IDLE }] });
    const value = api({ role: "worker", tree, self: tree.workers[0] }); await render(value);
    expect(host.textContent).toContain("read-only"); expect(host.querySelector("textarea")).toBeNull();
    await press("Return to lead"); expect(value.openLead).toHaveBeenCalledOnce(); expect(value.create).not.toHaveBeenCalled();
    const pending = api(); let complete: (value: MobileCollaborationView) => void = () => {};
    vi.mocked(pending.load).mockImplementation(() => new Promise(resolve => { complete = resolve; })); await render(pending);
    const replacement = api({ role: "worker", tree, self: tree.workers[0] }, "replacement"); await render(replacement);
    await act(async () => complete({ role: "ordinary" })); expect(host.querySelector("textarea")).toBeNull();
  });
  it("does not let a poll that started before archive resurrect the worker", async () => {
    vi.useFakeTimers();
    const tree = create(CollaborationGoalTreeSchema, { workers: [{ workerId: "worker", sessionId: "worker-task", label: "reviewer", status: CollaborationWorkerStatus.COMPLETED }] });
    const shown: MobileCollaborationView = { role: "lead", tree }, value = api(shown);
    let complete: (value: MobileCollaborationView) => void = () => {};
    vi.mocked(value.load).mockResolvedValueOnce(shown).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    vi.mocked(value.archive).mockResolvedValue({ role: "lead", tree: create(CollaborationGoalTreeSchema, {}) });
    await render(value); await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await press("Archive worker · reviewer"); await press("Confirm");
    expect(host.textContent).not.toContain("reviewer · Complete");
    await act(async () => complete(shown)); expect(host.textContent).not.toContain("reviewer · Complete");
  });
});
