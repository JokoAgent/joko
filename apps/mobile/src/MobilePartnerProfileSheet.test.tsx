// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
const photo = vi.hoisted(() => ({ pick: vi.fn() }));
const native = vi.hoisted(() => ({ state: "active", platform: "android", dismiss: undefined as (() => void) | undefined, listeners: new Set<(state: string) => void>() }));
vi.mock("./mobile-partner-avatar", async (original) => ({ ...await original<typeof import("./mobile-partner-avatar")>(), pickMobilePartnerPhoto: photo.pick }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { Platform: { get OS() { return native.platform; } }, Alert: { alert: alerts.alert }, AppState: { get currentState() { return native.state; },
    addEventListener: (_event: string, listener: (state: string) => void) => { native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } },
    ActivityIndicator: () => null, Image: () => React.createElement("img"),
    FlatList: ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: { data: readonly unknown[]; renderItem: (value: { item: unknown }) => ReactNode; ListHeaderComponent: ReactNode; ListFooterComponent?: ReactNode; ListEmptyComponent?: ReactNode }) => React.createElement("div", {}, ListHeaderComponent,
      ...data.map((item, index) => React.createElement("div", { key: index }, renderItem({ item }))), data.length === 0 ? ListEmptyComponent : null, ListFooterComponent),
    Modal: ({ visible, children, onDismiss }: { visible: boolean; children: ReactNode; onDismiss?: () => void }) => { native.dismiss = onDismiss; return visible ? children : null; },
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
  close.mockReset(); saved.mockReset(); alerts.alert.mockReset(); photo.pick.mockReset(); native.state = "active"; native.platform = "android"; native.dismiss = undefined; native.listeners.clear(); });

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
    await render(active, undefined, undefined, profilePartner, factory); await press("Saved memories");
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
    await editor.refresh(); expect(native.listeners.size).toBe(0); expect(container.querySelector('input[aria-label="Search memories"]')).toBeNull();
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
    await render(active, undefined, factory); await press("Routines");
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
    await editor.refresh(); expect(api.list).toHaveBeenCalledOnce(); expect(native.listeners.size).toBe(0);
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
