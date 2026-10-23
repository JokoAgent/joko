// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type AppSnapshot, type ModelView, type NewSessionLocalDraft } from "../model.js";
import { readAppDefaultModelPreference, setAppDefaultModelPreference } from "../app-default-model-preferences.js";
import { setModelConfiguration, resetModelPickerPreferencesForTests } from "../model-picker-preferences.js";
import { NewSessionPage } from "./NewSessionPage.js";

vi.mock("./ComposerRichTextEditor.js", () => ({ ComposerRichTextEditor: forwardRef(function Editor(_props, ref) {
  useImperativeHandle(ref, () => ({ focus: vi.fn(), focusFromBlankSurface: vi.fn(), insertRouteReference: vi.fn(), routeReferenceDrop: vi.fn(), insertText: vi.fn(), editPastedText: vi.fn() }));
  return <div />;
}) }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); window.localStorage.clear(); resetModelPickerPreferencesForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not replace a newly selected project when an older model source project finishes creating", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  const snapshot: AppSnapshot = { ...emptySnapshot(), backends: ["primary", "source"].map(id => ({ id, name: id, version: "1", health: "healthy", instanceGeneration: 1,
    capabilities: new Map([...["input.text", "model.switch", "model.effort"].map(name => [name, { name, supported: true, options: [] as string[] }] as const),
      ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]]) })),
    targets: ["first", "other"].map(id => ({ id: `target-${id}`, backendId: "primary", name: id, workspaceId: `workspace-${id}`, workspaceName: id, revision: 1n, trusted: true, pinned: false, archived: false })),
    workspaces: ["first", "other"].map(id => ({ id: `workspace-${id}`, targetId: `target-${id}`, name: id, kind: "userProject", serverPath: `D:\\${id}`, trusted: true, dirty: false, entries: [] })),
    models: [model("primary", "first"), model("source", "source")] };
  let finish!: (id: string) => void;
  const save = vi.fn(async (_draft: NewSessionLocalDraft) => undefined);
  const controller = { state: { activeProfile: { id: "connection", serverId: "node", origin: "http://127.0.0.1", deviceId: "device" }, snapshot, route: { kind: "newSession" },
    connectionGeneration: 1, navigationRevision: 1, connectionState: "connected", preferences: { locale: "en", newSessionWorktreeEnabled: false } },
    readNewSessionDraft: vi.fn(async () => undefined), saveNewSessionDraft: save, prepareTargetWorkspace: vi.fn(async () => undefined), probeTargetWorktree: vi.fn(async () => ({ eligibility: "unavailable" })),
    listTargetWorktreeSources: vi.fn(async () => []), refreshProviderModels: vi.fn(async () => undefined), setNewSessionWorktreeEnabled: vi.fn(async () => undefined),
    createTarget: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })) } as unknown as AppController;
  const container = document.body.appendChild(document.createElement("div")), root = createRoot(container); roots.push(root);
  const render = (targetId: string) => <NewSessionPage controller={controller} snapshot={snapshot} initialTargetId={targetId} navigationOpen t={key => key}
    onOpenNavigation={() => undefined} onClose={() => undefined} onSubmit={vi.fn()} />;
  await act(async () => root.render(render("target-first")));
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  await act(async () => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click());
  const row = [...document.querySelectorAll<HTMLElement>(".model-picker__row")].find(element => element.textContent?.includes("Model source"))!;
  expect(row).toBeDefined(); await act(async () => row.click()); expect(controller.createTarget).toHaveBeenCalledOnce();
  await act(async () => root.render(render("target-other")));
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ selection: { kind: "target", targetId: "target-other" } })));
  await act(async () => finish("late-source-target"));
  expect(readAppDefaultModelPreference("node").current?.backendId).toBe("primary");
  expect(save).not.toHaveBeenLastCalledWith(expect.objectContaining({ selection: { kind: "target", targetId: "late-source-target" } }));
});

it("initializes a future task from exact model effort preferences only when no explicit default exists", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear(); resetModelPickerPreferencesForTests();
  setModelConfiguration("node", "primary", "provider", "first", { effort: "high" });
  const snapshot: AppSnapshot = { ...emptySnapshot(), backends: [{ id: "primary", name: "Primary", version: "1", health: "healthy", instanceGeneration: 1, capabilities: new Map([...["input.text", "model.switch", "model.effort"].map(name => [name, { name, supported: true, options: [] as string[] }] as const), ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]]) }], targets: [{ id: "target", backendId: "primary", name: "Target", workspaceId: "workspace", workspaceName: "Workspace", revision: 1n, trusted: true, pinned: false, archived: false }], models: [{ ...model("primary", "first"), metadata: { defaultEffort: "low" } }] };
  const save = vi.fn(async () => undefined);
  const controller = { state: { activeProfile: { id: "connection", serverId: "node", origin: "http://127.0.0.1", deviceId: "device" }, snapshot, route: { kind: "newSession" }, navigationRevision: 1, connectionState: "connected", preferences: { locale: "en", newSessionWorktreeEnabled: false } }, readNewSessionDraft: vi.fn(async () => undefined), saveNewSessionDraft: save, prepareTargetWorkspace: vi.fn(async () => undefined), probeTargetWorktree: vi.fn(async () => ({ eligibility: "unavailable" })), listTargetWorktreeSources: vi.fn(async () => []), refreshProviderModels: vi.fn(async () => undefined), setNewSessionWorktreeEnabled: vi.fn(async () => undefined) } as unknown as AppController;
  const container = document.body.appendChild(document.createElement("div")); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<NewSessionPage controller={controller} snapshot={snapshot} navigationOpen t={key => key} onOpenNavigation={() => undefined} onClose={() => undefined} onSubmit={vi.fn()} />));
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: "first", effort: "high" })));
  expect(readAppDefaultModelPreference("node").current).toMatchObject({ modelId: "first", effort: "high" });
});

it("uses the actual New Task picker preference for future tasks and preserves the current draft's other axes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  const snapshot: AppSnapshot = { ...emptySnapshot(), backends: ["primary", "secondary"].map(id => ({ id, name: id, version: "1", health: "healthy", instanceGeneration: 1,
    capabilities: new Map([...["input.text", "model.switch", "model.effort", "model.fast_mode", "plan_mode"].map(name => [name, { name, supported: true, options: [] as string[] }] as const),
      ["permission.modes", { name: "permission.modes", supported: true, options: ["ask", "auto"] }]
    ]) })),
    targets: ["primary", "secondary"].map(id => ({ id: `target-${id}`, backendId: id, name: id, workspaceId: `workspace-${id}`, workspaceName: id, revision: 1n, trusted: true, pinned: false, archived: false })),
    models: [model("primary", "first"), model("primary", "second"), model("secondary", "first")] };
  const draft: NewSessionLocalDraft = { selection: { kind: "target", targetId: "target-primary" }, nativeStart: { kind: "fresh" }, providerId: "provider", modelId: "first", effort: "low",
    fastMode: false, permissionMode: "auto", planMode: false, text: "Keep my input", editorDocument: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep my input" }] }] }, mentions: [], inlineMentionRanges: [], attachments: [] };
  const save = vi.fn(async (_draft: NewSessionLocalDraft) => undefined), onSubmit = vi.fn(async () => undefined);
  const makeController = (saved?: NewSessionLocalDraft) => ({ state: { activeProfile: { id: "connection", serverId: "node", origin: "http://127.0.0.1", deviceId: "device" }, snapshot, route: { kind: "newSession" }, navigationRevision: 1, connectionState: "connected", preferences: { locale: "en", newSessionWorktreeEnabled: false } },
    readNewSessionDraft: vi.fn(async () => saved), saveNewSessionDraft: save, prepareTargetWorkspace: vi.fn(async () => undefined), probeTargetWorktree: vi.fn(async () => ({ eligibility: "unavailable" })),
    listTargetWorktreeSources: vi.fn(async () => []), refreshProviderModels: vi.fn(async () => undefined), setNewSessionWorktreeEnabled: vi.fn(async () => undefined)
  } as unknown as AppController);
  const mount = async (controller: AppController) => {
    const container = document.body.appendChild(document.createElement("div")), root = createRoot(container); roots.push(root);
    await act(async () => root.render(<NewSessionPage controller={controller} snapshot={snapshot} navigationOpen t={key => key} onOpenNavigation={() => undefined} onClose={() => undefined} onSubmit={onSubmit} />));
    return { root, container };
  };
  const first = await mount(makeController(draft));
  await vi.waitFor(() => expect(first.container.querySelector(".model-picker-trigger")).not.toBeNull());
  await act(async () => first.container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click());
  const row = [...document.querySelectorAll<HTMLButtonElement>(".model-picker__row")].find(element => element.textContent?.includes("Model second"))!;
  expect(row).toBeDefined(); await act(async () => row.click());
  expect(readAppDefaultModelPreference("node").current).toMatchObject({ backendId: "primary", modelId: "second", effort: "low", fastMode: false });
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Keep my input", modelId: "second", permissionMode: "auto", planMode: false })));
  await act(async () => { setAppDefaultModelPreference("node", { backendId: "primary", providerId: "provider", modelId: "first", effort: "high", fastMode: true }); });
  expect(first.container.querySelector(".model-picker-trigger")?.textContent).toContain("Model first");
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Keep my input", effort: "high", fastMode: true, permissionMode: "auto" })));
  await act(async () => { setAppDefaultModelPreference("node", { backendId: "secondary", providerId: "provider", modelId: "first", effort: "high", fastMode: false }); });
  await act(async () => first.root.unmount()); roots.splice(roots.indexOf(first.root), 1); first.container.remove(); save.mockClear();
  const fresh = await mount(makeController());
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ selection: { kind: "target", targetId: "target-secondary" }, modelId: "first", effort: "high", fastMode: false })));
  expect(fresh.container.querySelector(".new-task-composer__meta")?.textContent).toContain("secondary");
});
function model(backendId: string, modelId: string): ModelView {
  return { backendId, providerId: "provider", providerName: "Provider", modelId, name: `Model ${modelId}`, available: true, supportsImages: false, inputModalities: ["text"], outputModalities: ["text"],
    supportsFast: true, efforts: ["low", "high"], contextWindow: 128_000, maximumOutputTokens: 8_000, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" };
}
