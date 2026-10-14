// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerProfileSheet } from "./MobilePartnerProfileSheet";
import type { MobilePartnerProfileSnapshot, MobilePartnerProfileTransport } from "./mobile-partner-profile";
import { profilePartner, profileSnapshot } from "./test/mobile-partner-profile";
import { PartnerRoutineEditor, RoutineCreationReceipts, ListPartnerRoutinesResponseSchema,
  ListPartnerRoutineRunsResponseSchema, GetPartnerRoutineCreationResponseSchema, RetirePartnerRoutineCreationResponseSchema,
  type PartnerRoutineApi, type PartnerResumeEditor, PartnerMemoryEditor, type PartnerMemoryApi, type MemoryCatalog, type MemoryDetail } from "@joko/contracts";
import { create } from "@bufbuild/protobuf";
import { PartnerConnectionsEditor, type PartnerConnectionsApi, type ConnectionsDetail } from "@joko/contracts";
import { PartnerSkillsEditor, type PartnerSkillsApi, type PersonalSkillDetail } from "@joko/contracts";
import type { MobilePartnerTaskOutput, MobilePartnerTaskOutputs } from "./mobile-partner-task-outputs";
import { mobileMessage } from "./mobile-messages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
const photo = vi.hoisted(() => ({ pick: vi.fn() }));
const native = vi.hoisted(() => ({ state: "active", platform: "android", dismiss: undefined as (() => void) | undefined,
  requestClose: undefined as (() => void) | undefined, listeners: new Set<(state: string) => void>() }));
vi.mock("./mobile-partner-avatar", async (original) => ({ ...await original<typeof import("./mobile-partner-avatar")>(), pickMobilePartnerPhoto: photo.pick }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress, style, testID, selectable }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
    style?: React.CSSProperties | readonly React.CSSProperties[]; testID?: string; selectable?: boolean;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress,
    style: Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style, "data-testid": testID,
    "data-selectable": selectable ? "true" : undefined }, children);
  return { Platform: { get OS() { return native.platform; } }, Alert: { alert: alerts.alert }, AppState: { get currentState() { return native.state; },
    addEventListener: (_event: string, listener: (state: string) => void) => { native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } },
    ActivityIndicator: () => null, Image: () => React.createElement("img"),
    FlatList: ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: { data: readonly unknown[]; renderItem: (value: { item: unknown }) => ReactNode; ListHeaderComponent: ReactNode; ListFooterComponent?: ReactNode; ListEmptyComponent?: ReactNode }) => React.createElement("div", {}, ListHeaderComponent,
      ...data.map((item, index) => React.createElement("div", { key: index }, renderItem({ item }))), data.length === 0 ? ListEmptyComponent : null, ListFooterComponent),
    Modal: ({ visible, children, onDismiss, onRequestClose }: { visible: boolean; children: ReactNode; onDismiss?: () => void; onRequestClose?: () => void }) => {
      native.dismiss = onDismiss; native.requestClose = onRequestClose; return visible ? children : null; },
    Pressable: element("button"), ScrollView: element("div"), Text: element("span"), View: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Switch: ({ value, disabled, accessibilityLabel, onValueChange }: { value: boolean; disabled?: boolean;
      accessibilityLabel: string; onValueChange: (value: boolean) => void }) => React.createElement("input", {
      type: "checkbox", checked: value, disabled, "aria-label": accessibilityLabel, onChange: () => onValueChange(!value)
    }),
    TextInput: ({ value, editable, accessibilityLabel, onChangeText, multiline }: { value: string; editable: boolean;
      accessibilityLabel: string; onChangeText: (value: string) => void; multiline?: boolean }) => React.createElement(multiline ? "textarea" : "input", {
      value, disabled: !editable, "aria-label": accessibilityLabel, onChange: () => undefined,
      onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value)
    }) };
});
vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return { SafeAreaView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
vi.mock("./MobileKeyboardAvoidingView", async () => {
  const React = await import("react");
  return { MobileKeyboardAvoidingView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
    useMobileKeyboardState: () => ({ height: 0, visible: false }) };
});

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
let root: Root; let container: HTMLDivElement;
const close = vi.fn(); const saved = vi.fn();
const transport = (ownerKey = "owner"): MobilePartnerProfileTransport => ({ ownerKey,
  load: vi.fn(async () => ({ ...profileSnapshot, ownerKey })),
  save: vi.fn(async (_snapshot, draft) => ({ ...profilePartner, ...draft, revision: 3n, profileVersion: 4n })) });
async function render(active?: MobilePartnerProfileTransport, resumeFactory?: (partner: typeof profilePartner) => PartnerResumeEditor | undefined,
  routineFactory?: (partnerId: string, ownerKey: string) => PartnerRoutineEditor | undefined, partner = profilePartner,
  memoryFactory?: (partner: typeof profilePartner, ownerKey: string) => PartnerMemoryEditor | undefined,
  connectionsFactory?: (partner: typeof profilePartner, ownerKey: string) => PartnerConnectionsEditor | undefined,
  skillsFactory?: (partner: typeof profilePartner, ownerKey: string) => PartnerSkillsEditor | undefined) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(createElement(MobilePartnerProfileSheet, { visible: true, partner,
    transport: active, resumeFactory, routineFactory, memoryFactory, connectionsFactory, skillsFactory, colors, locale: "en", onClose: close, onSaved: saved })));
}
async function press(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function editName(name: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  await act(async () => { input.value = name; input.dispatchEvent(new Event("input", { bubbles: true })); });
}
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); root = undefined as unknown as Root;
  close.mockReset(); saved.mockReset(); alerts.alert.mockReset(); photo.pick.mockReset(); native.state = "active"; native.platform = "android";
  native.dismiss = undefined; native.requestClose = undefined; native.listeners.clear(); vi.unstubAllGlobals(); });

const outputRow: MobilePartnerTaskOutput = { kind: "session-task", id: "independent-task", parentSessionId: "session", sessionId: "source-session",
  execution: 1, revision: 3n, runIds: ["run-1"], title: "Updated report", readiness: "ready",
  files: [{ path: "reports/summary.md", status: "modified" }, { path: "reports/new.md", status: "added" }, { path: "reports/renamed.md", status: "renamed" }], truncated: true };
const outputCatalog = (rows: readonly MobilePartnerTaskOutput[] = [outputRow], truncated = false): MobilePartnerTaskOutputs => ({ partnerId: profilePartner.partnerId, rows, truncated });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject };
}
async function drawOutputs(active: MobilePartnerProfileTransport, options: Partial<ComponentProps<typeof MobilePartnerProfileSheet>> = {}) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(createElement(MobilePartnerProfileSheet, { visible: true, partner: profilePartner,
    transport: active, colors, locale: "en", onClose: close, onSaved: saved, ...options })));
}

describe("Mobile Partner outputs", () => {
  it.each(["android", "ios"])("submits full access only after current explicit risk confirmation on %s", async platform => {
    native.platform = platform; const active = transport();
    vi.mocked(active.load).mockResolvedValue({ ...profileSnapshot, permissionModes: ["ask", "auto", "bypassPermissions"] });
    await render(active); await press("Full access"); await press("Save Partner");
    expect(active.save).not.toHaveBeenCalled();
    const [title, body, buttons] = alerts.alert.mock.calls.at(-1)!;
    expect(title).toBe("Full access removes approval prompts"); expect(body).toContain("not an OS sandbox");
    expect(body).toContain("credentials"); expect(body).toContain("extra directories");
    await act(async () => buttons[0].onPress()); await act(async () => buttons[1].onPress()); expect(active.save).not.toHaveBeenCalled();
    await press("Save Partner"); const staleDraft = alerts.alert.mock.calls.at(-1)![2][1].onPress;
    await editName("New draft"); await act(async () => staleDraft()); expect(active.save).not.toHaveBeenCalled();
    await press("Save Partner"); const staleForeground = alerts.alert.mock.calls.at(-1)![2][1].onPress;
    await act(() => { native.state = "background"; for (const listener of native.listeners) listener("background"); });
    await act(() => { native.state = "active"; for (const listener of native.listeners) listener("active"); });
    await act(async () => staleForeground()); expect(active.save).not.toHaveBeenCalled();
    await press("Save Partner"); await act(async () => alerts.alert.mock.calls.at(-1)![2][1].onPress());
    expect(active.save).toHaveBeenCalledOnce(); expect(vi.mocked(active.save).mock.calls[0]![1]).toMatchObject({
      displayName: "New draft", capabilities: { permissionMode: "bypassPermissions" } });
  });

  it("retires full-access confirmation on profile owner, baseline and offline changes", async () => {
    const active = transport(); vi.mocked(active.load).mockResolvedValue({ ...profileSnapshot, permissionModes: ["ask", "auto", "bypassPermissions"] });
    await drawOutputs(active); await press("Full access"); await press("Save Partner");
    const offline = alerts.alert.mock.calls.at(-1)![2][1].onPress;
    await drawOutputs(active, { online: false }); await drawOutputs(active); await act(async () => offline()); expect(active.save).not.toHaveBeenCalled();
    await press("Save Partner"); const baseline = alerts.alert.mock.calls.at(-1)![2][1].onPress;
    await drawOutputs(active, { partner: { ...profilePartner, revision: profilePartner.revision + 1n } });
    await act(async () => baseline()); expect(active.save).not.toHaveBeenCalled();
    await drawOutputs(active); await press("Save Partner"); const owner = alerts.alert.mock.calls.at(-1)![2][1].onPress;
    await drawOutputs(transport("replacement-owner")); await act(async () => owner()); expect(active.save).not.toHaveBeenCalled();
  });
  it.each(["android", "ios"])("renders selectable output metadata in five languages on %s and preserves the parent draft", async platform => {
    native.platform = platform; const active = transport(), read = deferred<MobilePartnerTaskOutputs>();
    active.listOutputs = vi.fn(() => read.promise); active.openOutputTask = vi.fn(async () => undefined);
    await drawOutputs(active); await editName("Unsubmitted name"); await press("Outputs");
    expect(container.textContent).toContain(mobileMessage("en", "partnerOutputs.loading"));
    await act(async () => read.resolve(outputCatalog([outputRow,
      { ...outputRow, id: "pending-task", title: "Pending report", readiness: "pending", files: [], truncated: false },
      { ...outputRow, id: "unavailable-task", title: "Unavailable report", readiness: "unavailable", files: [], truncated: false }], true)));
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"] as const) {
      await drawOutputs(active, { locale });
      for (const key of ["title", "pending", "unavailable", "filesTruncated", "rowsTruncated", "added", "modified", "renamed"] as const) {
        expect(container.textContent).toContain(mobileMessage(locale, `partnerOutputs.${key}`));
      }
      expect(Array.from(container.querySelectorAll('[data-selectable="true"]')).map(node => node.textContent)).toContain("reports/summary.md");
      const source = container.querySelector<HTMLButtonElement>(`button[aria-label="${mobileMessage(locale, "partnerOutputs.openSource")}"]`)!;
      expect(source.disabled).toBe(false); expect(source.style.minHeight).toBe("44px"); expect(source.style.backgroundColor).toBe("rgb(255, 255, 255)");
    }
    expect(active.listOutputs).toHaveBeenCalledOnce(); await drawOutputs(active);
    if (platform === "android") await act(() => native.requestClose?.());
    else await press(mobileMessage("en", "common.backTo", { label: mobileMessage("en", "partnerProfile.title") }));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Unsubmitted name");
    expect(close).not.toHaveBeenCalled(); expect(active.save).not.toHaveBeenCalled();
  });

  it("distinguishes loading, failure, ready empty and pending, and keeps the output draft through offline reconnecting", async () => {
    const active = transport(); active.listOutputs = vi.fn(async () => { throw new Error("private failure"); }); active.openOutputTask = vi.fn(async () => undefined);
    await drawOutputs(active); await editName("Retained draft"); await press("Outputs"); expect(container.textContent).toContain(mobileMessage("en", "partnerOutputs.failed"));
    expect(container.textContent).not.toContain("private failure");
    const read = deferred<MobilePartnerTaskOutputs>(); vi.mocked(active.listOutputs).mockImplementationOnce(() => read.promise);
    await press("Retry"); expect(container.textContent).toContain(mobileMessage("en", "partnerOutputs.loading"));
    await act(async () => read.resolve(outputCatalog([]))); expect(container.textContent).toContain(mobileMessage("en", "partnerOutputs.empty"));
    vi.mocked(active.listOutputs).mockResolvedValueOnce(outputCatalog([{ ...outputRow, readiness: "pending", files: [] }]));
    await press("Refresh outputs"); expect(container.textContent).toContain(mobileMessage("en", "partnerOutputs.pending"));
    expect(container.textContent).not.toContain(mobileMessage("en", "partnerOutputs.empty"));
    vi.mocked(active.listOutputs).mockResolvedValueOnce(outputCatalog()); await press("Refresh outputs");
    await drawOutputs(active, { online: false }); expect(container.textContent).toContain(mobileMessage("en", "partnerOutputs.offline"));
    expect(container.textContent).toContain("reports/summary.md");
    for (const label of ["Refresh outputs", "Open source task"]) expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled).toBe(true);
    await press("Refresh outputs"); await press("Open source task"); expect(active.listOutputs).toHaveBeenCalledTimes(4); expect(active.openOutputTask).not.toHaveBeenCalled();
    await drawOutputs(active, { online: false }); expect(container.textContent).toContain("reports/summary.md");
    vi.mocked(active.listOutputs).mockResolvedValueOnce(outputCatalog()); await drawOutputs(active);
    expect(active.listOutputs).toHaveBeenCalledTimes(5); expect(container.querySelector<HTMLButtonElement>('button[aria-label="Open source task"]')?.disabled).toBe(false);
    await press(mobileMessage("en", "common.backTo", { label: mobileMessage("en", "partnerProfile.title") }));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Retained draft"); expect(active.save).not.toHaveBeenCalled();
  });

  it.each(["android", "ios"])("opens the source only after dirty confirmation and actual %s closing, and exposes a closed navigation failure", async platform => {
    native.platform = platform; const active = transport(), opening = deferred<void>(), errors = vi.fn();
    active.listOutputs = vi.fn(async () => outputCatalog()); active.openOutputTask = vi.fn(() => opening.promise);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; }); vi.stubGlobal("cancelAnimationFrame", () => undefined);
    function Fixture() {
      const [visible, setVisible] = useState(true), [error, setError] = useState("");
      return createElement("div", {}, createElement(MobilePartnerProfileSheet, { visible, partner: profilePartner, transport: active,
        colors, locale: "en", onSaved: saved, onClose: () => { close(); setVisible(false); },
        onOpenOutputError: message => { errors(message); setError(message); } }), error && createElement("div", { role: "alert" }, error));
    }
    await drawOutputs(active); await act(async () => root.render(createElement(Fixture)));
    await editName("Dirty name"); await press("Outputs"); await press("Open source task");
    expect(alerts.alert).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(active.openOutputTask).not.toHaveBeenCalled();
    await act(async () => alerts.alert.mock.calls.at(-1)![2][1].onPress()); expect(close).toHaveBeenCalledOnce(); expect(active.openOutputTask).not.toHaveBeenCalled();
    if (platform === "ios") await act(() => native.dismiss?.()); else await act(() => frame?.(0));
    expect(active.openOutputTask).toHaveBeenCalledOnce(); const request = vi.mocked(active.openOutputTask).mock.calls[0]![2];
    expect(request.aborted).toBe(false); expect(active.openOutputTask).toHaveBeenCalledWith(expect.objectContaining({ partner: profilePartner }), outputRow, request);
    await act(async () => opening.reject(new Error("private source failure")));
    expect(errors).toHaveBeenCalledWith(mobileMessage("en", "partnerOutputs.openFailed"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(mobileMessage("en", "partnerOutputs.openFailed"));
    expect(container.textContent).not.toContain("private source failure");
  });

  it.each(["owner", "offline", "background", "unmount"])("retires an output handoff before dismissal after %s", async boundary => {
    native.platform = "ios"; const active = transport(); active.listOutputs = vi.fn(async () => outputCatalog()); active.openOutputTask = vi.fn(async () => undefined);
    await drawOutputs(active); await press("Outputs"); await press("Open source task"); await drawOutputs(active, { visible: false });
    const dismiss = native.dismiss;
    if (boundary === "owner") await drawOutputs(transport("next-owner"), { visible: false });
    if (boundary === "offline") await drawOutputs(active, { visible: false, online: false });
    if (boundary === "background") await act(() => { native.state = "background"; for (const listener of native.listeners) listener(native.state); });
    if (boundary === "unmount") await act(() => root.render(null));
    await act(() => dismiss?.()); expect(active.openOutputTask).not.toHaveBeenCalled();
  });

  it("discards late output reads after background or source owner retirement", async () => {
    const active = transport(), first = deferred<MobilePartnerTaskOutputs>(), second = deferred<MobilePartnerTaskOutputs>();
    active.listOutputs = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise); active.openOutputTask = vi.fn(async () => undefined);
    await drawOutputs(active); await press("Outputs");
    const firstSignal = vi.mocked(active.listOutputs).mock.calls[0]![1];
    await act(() => { native.state = "background"; for (const listener of native.listeners) listener(native.state); });
    expect(firstSignal.aborted).toBe(true); await act(async () => first.resolve(outputCatalog())); expect(container.textContent).not.toContain("reports/summary.md");
    await act(() => { native.state = "active"; for (const listener of native.listeners) listener(native.state); });
    expect(active.listOutputs).toHaveBeenCalledTimes(2); const secondSignal = vi.mocked(active.listOutputs).mock.calls[1]![1];
    await drawOutputs(transport("next-owner")); expect(secondSignal.aborted).toBe(true);
    await act(async () => second.resolve(outputCatalog())); expect(container.textContent).not.toContain("reports/summary.md"); expect(active.openOutputTask).not.toHaveBeenCalled();
  });
});

describe("MobilePartnerProfileSheet", () => {
  it.each(["android", "ios"])("hands conversation search over after its %s profile closes and retires an old owner", async (platform) => {
    native.platform = platform;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; }); vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const active = transport(), search = vi.fn();
    const draw = async (visible: boolean, current = active) => { await act(() => root.render(createElement(MobilePartnerProfileSheet, {
      visible, partner: profilePartner, transport: current, colors, locale: "en", onClose: close, onSaved: saved, onSearch: search
    }))); };
    await render(active); await draw(true); await press("Search conversation"); expect(close).toHaveBeenCalledOnce(); expect(search).not.toHaveBeenCalled();
    await draw(false); if (platform === "ios") { expect(search).not.toHaveBeenCalled(); await act(() => native.dismiss?.()); } expect(search).toHaveBeenCalledOnce();
    await draw(true); await press("Search conversation"); await draw(false, transport("new-owner")); if (platform === "ios") await act(() => native.dismiss?.()); expect(search).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("edits an introduction independently in the actual profile and saves its current owner", async () => {
    const active = transport(); await render(active);
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Introduction"]')!;
    expect(input).toBeTruthy(); await act(async () => { input.value = "Updated mobile introduction"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await press("Save Partner");
    expect(active.save).toHaveBeenCalledOnce(); expect(active.save).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ description: "Updated mobile introduction", identitySource: profilePartner.identitySource }), expect.any(AbortSignal));
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ description: "Updated mobile introduction" }));
  });

  it("selects a primary on another Backend in the actual profile and retains the configured fallback", async () => {
    const first = profilePartner.capabilities.modelChain[0]!, backup = { ...first, providerId: "beta", modelId: "b" };
    let current = { ...profilePartner, capabilities: { ...profilePartner.capabilities, modelChain: [first, backup] } };
    const axes = profileSnapshot.models.map(model => ({ ...model, canSwitchModel: true, canSetEffort: true, canSetFastMode: true,
      canSetPlanMode: true, permissionModes: ["ask", "auto"] as const }));
    const other = { ...axes[0]!, backendId: "other-runtime", backendName: "Other runtime", canSetPlanMode: false, permissionModes: ["ask"] as const };
    const active = transport();
    active.load = vi.fn(async () => ({ ...profileSnapshot, partner: current, models: [...axes, other], taskModels: [...axes, other] }));
    active.save = vi.fn(async (_snapshot, draft) => current = { ...current, ...draft, revision: current.revision + 1n, profileVersion: current.profileVersion + 1n });
    await render(active, undefined, undefined, current);
    await press("backend · Alpha · Alpha Provider");
    await press("Other runtime · Alpha · Alpha Provider");
    await press("Save Partner");
    expect(active.save).toHaveBeenCalledOnce();
    expect(current.capabilities).toEqual({ ...profilePartner.capabilities, modelChain: [{ ...first, backendId: "other-runtime" }, backup] });
  });

  it("shows an independent task, applies a confirmed pause and opens the same task", async () => {
    let task: import("@joko/contracts").PartnerSessionTaskView = { id: "task:independent", partnerId: profilePartner.partnerId, sessionId: "independent-session", title: "Prepare report",
      status: "running", control: "active", revision: 2n, deadlineAt: 2_000_000, result: "", error: "" };
    const active = transport(); active.load = vi.fn(async () => ({ ...profileSnapshot, tasks: [task] }));
    active.controlTask = vi.fn(async (_snapshot, _task, action) => { task = { ...task, revision: task.revision + 1n, status: "waiting", control: action === "pause" ? "paused" : "active" }; });
    active.openTask = vi.fn(async () => undefined);
    await render(active); expect(container.textContent).toContain("Prepare report"); await press("Pause");
    expect(active.controlTask).toHaveBeenCalledWith(expect.objectContaining({ partner: profilePartner }), expect.objectContaining({ id: task.id }), "pause", expect.any(AbortSignal));
    expect(container.textContent).toContain("Paused"); await press("Open task");
    expect(active.openTask).toHaveBeenCalledWith(expect.objectContaining({ partner: profilePartner }), expect.objectContaining({ sessionId: "independent-session" }), expect.any(AbortSignal));
  });
  it("selects one independent task model through the actual profile and restores primary inheritance", async () => {
    const model = { ...profileSnapshot.models[1]!, backendId: "task-backend", modelId: "task-model", displayName: "Task Model",
      canSetEffort: true, canSetFastMode: true, canSetPlanMode: true, permissionModes: ["ask", "auto"] as const };
    const active = transport(); let current: typeof profilePartner = { ...profilePartner, usesDirectoryDefaults: true };
    active.load = vi.fn(async () => ({ ...profileSnapshot, partner: current, taskModels: [model] }));
    active.save = vi.fn(async (_snapshot, draft) => current = { ...current, ...draft, taskModelOverride: draft.taskModelOverride, revision: current.revision + 1n, profileVersion: current.profileVersion + 1n });
    await render(active); const choose = container.querySelector<HTMLButtonElement>('button[aria-label^="Choose task model:"]')!;
    await act(async () => choose.click()); await press("Task model: Task Model · Beta Provider");
    await press("Save Partner"); expect(active.save).toHaveBeenCalledOnce();
    expect(current.capabilities).toEqual(profilePartner.capabilities);
    expect(current.taskModelOverride).toMatchObject({ backendId: "task-backend", modelId: "task-model", effort: "low", fastMode: false });
    await act(async () => root.render(null)); await render(active, undefined, undefined, current);
    await press("Use primary model"); await press("Save Partner");
    expect(active.save).toHaveBeenCalledTimes(2); expect(current.taskModelOverride).toBeUndefined();
  });

  it("opens actual personal skills, edits and confirms deletion while protecting the Task profile", async () => {
    const active = transport("node\u001ftask-session"), owner = { partnerId: profilePartner.partnerId, homeTargetId: profilePartner.homeTargetId,
      canonicalSessionId: profilePartner.canonicalSessionId!, revision: profilePartner.revision, readOnly: false };
    let entry: PersonalSkillDetail | undefined = { owner, summary: { id: "skill", slug: "report", name: "Reports", description: "Create reports", updatedAt: "2026-10-12", enabled: true,
      revision: 4n, contentRevision: `sha256:${"a".repeat(64)}` }, name: "Reports", description: "Create reports", body: "Use templates.", bodyBytes: 14n, readOnly: false };
    const api: PartnerSkillsApi = { ownerKey: active.ownerKey, list: vi.fn(async () => ({ owner, skills: entry ? [entry.summary] : [], total: entry ? 1 : 0 })),
      read: vi.fn(async () => entry), save: vi.fn(async (base, draft) => entry = { ...base, ...draft, summary: { ...base.summary, revision: base.summary.revision + 1n } }),
      remove: vi.fn(async () => { entry = undefined; }) };
    let editor!: PartnerSkillsEditor; const factory = vi.fn(() => editor = new PartnerSkillsEditor(api, owner));
    await render(active, undefined, undefined, profilePartner, undefined, undefined, factory); await press("Personal skills");
    expect(factory).toHaveBeenCalledWith(profilePartner, active.ownerKey);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Save Partner"]')!.disabled).toBe(true);
    await press("Reports"); await press("Edit"); const body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')!;
    await act(async () => { body.value = "Keep the full template."; body.dispatchEvent(new Event("input", { bubbles: true })); }); await press("Save");
    expect(api.save).toHaveBeenCalledOnce(); expect(entry!.body).toBe("Keep the full template.");
    await act(async () => { native.state = "background"; for (const listener of native.listeners) listener(native.state); }); expect(editor.editable).toBe(false);
    await act(async () => { native.state = "active"; for (const listener of native.listeners) listener(native.state); }); expect(editor.editable).toBe(true);
    await press("Back"); await press("Reports"); await press("Delete"); expect(api.remove).not.toHaveBeenCalled();
    await act(async () => alerts.alert.mock.calls.at(-1)![2][1].onPress()); expect(api.remove).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("No matching skills.");
    await render(transport("next-task"), undefined, undefined, profilePartner, undefined, undefined, factory);
    await editor.refresh(); expect(api.save).toHaveBeenCalledOnce(); expect(api.remove).toHaveBeenCalledOnce();
  });

  it("adds and saves the fourth and fifth routes through the actual profile form, then removes a backup", async () => {
    const models = Array.from({ length: 6 }, (_, index) => ({ ...profileSnapshot.models[0]!, key: `route-${index}`, modelId: `model-${index}`, displayName: `Model ${index + 1}` }));
    const modelChain = models.slice(0, 3).map(model => ({ ...profilePartner.capabilities.modelChain[0]!, modelId: model.modelId }));
    const partner = { ...profilePartner, capabilities: { ...profilePartner.capabilities, modelChain } };
    const active = transport(); vi.mocked(active.load).mockResolvedValue({ ...profileSnapshot, partner, models });
    await render(active, undefined, undefined, partner);
    await press("Add fallback model"); await press("Add fallback model");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Add fallback model"]')!.disabled).toBe(true);
    await press("Save Partner");
    expect(active.save).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ capabilities: expect.objectContaining({
      modelChain: expect.arrayContaining([expect.objectContaining({ modelId: "model-3" }), expect.objectContaining({ modelId: "model-4" })])
    }) }), expect.any(AbortSignal));
    expect(vi.mocked(active.save).mock.calls[0]![1].capabilities.modelChain).toHaveLength(5);
    await press("Remove model 5"); expect(container.querySelector<HTMLButtonElement>('button[aria-label="Add fallback model"]')!.disabled).toBe(false);
    await press("Save Partner"); expect(vi.mocked(active.save).mock.calls[1]![1].capabilities.modelChain).toHaveLength(4);
  });

  it("opens actual Partner connections under the Task owner, saves selections and retires on owner change", async () => {
    const active = transport("node\u001ftask-session");
    const owner = { partnerId: profilePartner.partnerId, homeTargetId: profilePartner.homeTargetId, canonicalSessionId: profilePartner.canonicalSessionId!, revision: profilePartner.revision, readOnly: false };
    let current: ConnectionsDetail = { owner, catalogRevision: "a".repeat(64), entries: [{ kind: "mcp", id: "server", name: "Server", available: true, inherited: true },
      { kind: "skills", id: "shared-report", name: "Shared report", available: true, inherited: false },
      { kind: "skills", id: "personal-report", name: "Learned report", personal: true, available: true, inherited: false }],
      mcp: { mode: "inherit", ids: [] }, toolsets: { mode: "inherit", ids: [] }, skills: { mode: "allowlist", ids: [] } };
    const api: PartnerConnectionsApi = { ownerKey: active.ownerKey, read: vi.fn(async () => current),
      save: vi.fn(async (_base, draft) => current = { ...current, ...draft, revision: (current.revision ?? 0n) + 1n }) };
    let editor!: PartnerConnectionsEditor; const factory = vi.fn(() => editor = new PartnerConnectionsEditor(api, owner));
    await render(active, undefined, undefined, profilePartner, undefined, factory); await press("Skills & Connections");
    expect(factory).toHaveBeenCalledWith(profilePartner, active.ownerKey); expect(container.querySelector<HTMLButtonElement>('button[aria-label="Save Partner"]')!.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Server"]')!.click()); await press("Save");
    expect(current.mcp).toEqual({ mode: "allowlist", ids: [] }); expect(api.save).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Learned report"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Learned report"]')!.checked).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Shared report"]')!.click()); await press("Save");
    expect(current.skills).toEqual({ mode: "allowlist", ids: ["shared-report"] }); expect(api.save).toHaveBeenCalledTimes(2);
    await act(async () => { native.state = "background"; for (const listener of native.listeners) listener(native.state); }); expect(editor.editable).toBe(false);
    await act(async () => { native.state = "active"; for (const listener of native.listeners) listener(native.state); }); expect(editor.state.requiresRefresh).toBe(true);
    await press("Refresh"); expect(editor.editable).toBe(true);
    await render(transport("next-task"), undefined, undefined, profilePartner, undefined, factory); expect(container.querySelector('input[aria-label="Server"]')).toBeNull();
    await editor.refresh(); expect(api.save).toHaveBeenCalledTimes(2);
  });
  it("opens actual saved memories, edits and confirms deletion while protecting the parent profile", async () => {
    const active = transport("node\u001ftask-session");
    const owner = { partnerId: profilePartner.partnerId, homeTargetId: profilePartner.homeTargetId,
      canonicalSessionId: profilePartner.canonicalSessionId!, revision: profilePartner.revision, readOnly: false, memoryEnabled: true };
    let entry: MemoryDetail | undefined = { owner, id: "memory", kind: "user", title: "Plain language", preview: "Use short sentences.", body: "Use short sentences.", updatedAt: 2000, revision: 4n };
    let editor!: PartnerMemoryEditor;
    const api: PartnerMemoryApi = { ownerKey: active.ownerKey, list: vi.fn(async (): Promise<MemoryCatalog> => ({ owner, groups: [{ kind: "user", count: entry ? 1 : 0, entries: entry ? [entry] : [] }], truncated: false })),
      read: vi.fn(async () => ({ owner, entry })), save: vi.fn(async (base, draft) => entry = { ...base, ...draft, revision: base.revision + 1n }),
      remove: vi.fn(async () => { entry = undefined; }), preferences: vi.fn(async () => ({ owner, enabled: owner.memoryEnabled, userContext: "", revision: 5n })),
      savePreferences: vi.fn(async (base, patch) => { owner.memoryEnabled = patch.enabled ?? base.enabled; return { ...base, ...patch, owner, revision: 6n }; }) };
    const factory = vi.fn(() => editor = new PartnerMemoryEditor(api, owner));
    await render(active, undefined, undefined, profilePartner, factory);
    const parentListenerCount = native.listeners.size;
    await press("Saved memories");
    expect(factory).toHaveBeenCalledWith(profilePartner, active.ownerKey);
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')).at(-1)!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Save Partner"]')!.disabled).toBe(true);
    await press("Plain language"); await press("Edit");
    const body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Content"]')!;
    await act(async () => { body.value = "Keep clear headings."; body.dispatchEvent(new Event("input", { bubbles: true })); });
    await press("Done"); expect(api.save).toHaveBeenCalledOnce(); expect(entry?.body).toBe("Keep clear headings.");
    await press("Delete memory"); expect(api.remove).not.toHaveBeenCalled();
    await act(async () => alerts.alert.mock.calls.at(-1)![2][1].onPress()); expect(api.remove).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("No saved memories.");
    await press("Memory settings");
    const user = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="What you know about me"]')!;
    await act(async () => { user.value = "Complete personal context."; user.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Remember things about me"]')!.click());
    await press("Done"); expect(api.savePreferences).toHaveBeenCalledWith(expect.any(Object), { enabled: false, userContext: "Complete personal context." }, expect.any(AbortSignal));
    await render(transport("next-task"), undefined, undefined, profilePartner, factory);
    await editor.refresh(); expect(native.listeners.size).toBe(parentListenerCount); expect(container.querySelector('input[aria-label="Search memories"]')).toBeNull();
    act(() => root.unmount()); root = undefined as unknown as Root; expect(native.listeners.size).toBe(0);
  });
  it.each(["task", "partner"] as const)("opens the actual routine sheet under the Task owner, protects the parent and retires it on %s change", async (change) => {
    const active = transport("node\u001ftask-session"); let editor!: PartnerRoutineEditor; let api!: PartnerRoutineApi;
    const factory = vi.fn((partnerId: string, ownerKey: string) => {
      api = { ownerKey, newRequestId: () => "routine-mounted-request-001", list: vi.fn(async () => create(ListPartnerRoutinesResponseSchema,
        { partnerId, partnerRevision: { value: 2n }, writable: true })), save: vi.fn(), run: vi.fn(), remove: vi.fn(),
        history: vi.fn(async () => create(ListPartnerRoutineRunsResponseSchema)), lookup: vi.fn(async () => create(GetPartnerRoutineCreationResponseSchema)),
        retire: vi.fn(async () => create(RetirePartnerRoutineCreationResponseSchema)) };
      return editor = new PartnerRoutineEditor(api, new RoutineCreationReceipts({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, "node"), partnerId);
    });
    await render(active, undefined, factory);
    const parentListenerCount = native.listeners.size;
    await press("Routines");
    expect(factory).toHaveBeenCalledWith(profilePartner.partnerId, active.ownerKey); expect(api.list).toHaveBeenCalledOnce();
    expect(container.querySelector('button[aria-label="New routine"]')).toBeTruthy();
    const parentClose = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')).at(-1)!;
    expect(parentClose.disabled).toBe(true); await act(async () => parentClose.click()); expect(close).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Save Partner"]')?.disabled).toBe(true);
    expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[aria-label="Name"]')).at(-1)?.disabled).toBe(true);
    const nextPartner = change === "partner" ? { ...profilePartner, partnerId: "partner-b" } : profilePartner;
    const next = transport(change === "task" ? "node\u001ftask-next" : active.ownerKey);
    vi.mocked(next.load).mockResolvedValue({ ...profileSnapshot, ownerKey: next.ownerKey, partner: nextPartner });
    await render(next, undefined, factory, nextPartner); expect(container.querySelector('button[aria-label="New routine"]')).toBeNull();
    await editor.refresh(); expect(api.list).toHaveBeenCalledOnce(); expect(native.listeners.size).toBe(parentListenerCount);
    act(() => root.unmount()); root = undefined as unknown as Root; expect(native.listeners.size).toBe(0);
  });
  it("offers resume from paused settings and blocks its confirmation while a profile draft is dirty", async () => {
    const active = transport(); const paused = { ...profilePartner, lifecycle: "paused" as const, pauseCleanupPending: false };
    vi.mocked(active.load).mockResolvedValue({ ...profileSnapshot, ownerKey: active.ownerKey, partner: paused });
    const factory = vi.fn(() => undefined); await render(active, factory);
    const resume = container.querySelector<HTMLButtonElement>('button[aria-label="Resume partner"]')!; expect(resume.disabled).toBe(false);
    await editName("Unsaved paused profile"); expect(resume.disabled).toBe(true); await press("Resume partner"); expect(factory).not.toHaveBeenCalled();
  });
  it("blocks saving while preparing, preserves cancelled selection and saves the accepted user photo", async () => {
    const active = transport(); await render(active); photo.pick.mockResolvedValueOnce(undefined);
    await press("Choose a photo"); await press("Save Partner"); expect(active.save).not.toHaveBeenCalled();
    let finish!: (value: { readonly base64: string }) => void;
    photo.pick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await press("Choose a photo"); await press("Save Partner"); expect(active.save).not.toHaveBeenCalled();
    await act(async () => finish({ base64: "/9j/2w==" })); await press("Save Partner");
    expect(vi.mocked(active.save).mock.calls[0]?.[1].avatar).toEqual({ base64: "/9j/2w==" });
  });

  it("does not adopt a photo prepared for a retired profile owner and makes picker failure retryable", async () => {
    const old = transport("old"); await render(old); let finish!: (value: { readonly base64: string }) => void;
    photo.pick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await press("Choose a photo"); const active = transport(); await render(active); await act(async () => finish({ base64: "/9j/2w==" }));
    await press("Save Partner"); expect(active.save).not.toHaveBeenCalled();
    photo.pick.mockRejectedValueOnce(new Error("Picker failed")); await press("Choose a photo");
    expect(container.textContent).toContain("Could not prepare this photo");
    photo.pick.mockResolvedValueOnce(undefined); await press("Choose a photo");
    expect(container.textContent).not.toContain("Could not prepare this photo");
  });

  it("edits a complete profile draft and assigns an advertised effort to a fallback model", async () => {
    const active = transport(); await render(active);
    await editName("Ada Two"); await press("Add fallback model"); await press("Save Partner");
    expect(active.save).toHaveBeenCalledOnce();
    expect(vi.mocked(active.save).mock.calls[0]![1]).toMatchObject({ displayName: "Ada Two", capabilities: {
      modelChain: [{ providerId: "alpha", modelId: "a", effort: "low" }, { providerId: "beta", modelId: "b", effort: "low" }]
    } });
    expect(saved).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it("preserves an unconfirmed save draft, forbids resending and refreshes only on explicit discard", async () => {
    const active = transport(); vi.mocked(active.save).mockRejectedValueOnce(new Error("transport lost"));
    await render(active); await editName("Ada Two"); await press("Save Partner");
    expect(container.textContent).toContain("your draft is still here");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Ada Two");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Save Partner"]')?.disabled).toBe(true);
    await press("Save Partner"); expect(active.save).toHaveBeenCalledOnce();
    await press("Refresh and discard draft");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Ada");
  });

  it("retires old owner reads and offers a deliberate discard when closing a dirty draft", async () => {
    const old = transport("old"); let finish!: (value: MobilePartnerProfileSnapshot) => void;
    vi.mocked(old.load).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old); const active = transport(); await render(active);
    await act(async () => finish({ ...profileSnapshot, ownerKey: "old", partner: { ...profilePartner, displayName: "Old" } }));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Ada");
    await editName("Dirty"); await press("Close");
    expect(close).not.toHaveBeenCalled(); expect(alerts.alert).toHaveBeenCalledOnce();
    await render(undefined); expect(container.textContent).toContain("Reconnect to edit this Partner");
    expect(container.querySelector('input[aria-label="Name"]')).toBeNull();
  });
});
