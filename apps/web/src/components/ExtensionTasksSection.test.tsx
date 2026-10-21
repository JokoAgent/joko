// @vitest-environment jsdom
import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ExtensionTaskPreferencesSchema, ExtensionTaskServiceGetPreferencesResponseSchema,
  ExtensionTaskServiceUpdatePreferencesResponseSchema, ExtensionTaskServiceListBackgroundTasksResponseSchema,
  ExtensionTaskServiceRevealTaskResponseSchema, ExtensionTaskServiceRetryWriteAccessResponseSchema, ExtensionTaskWriteRequestSchema, PermissionMode, RevisionSchema } from "@joko/contracts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionTaskApi } from "../model.js";
import { translate } from "../i18n.js";
import { ExtensionTasksSection } from "./ExtensionTasksSection.js";

const roots: Root[] = [];
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });
const preferences = () => create(ExtensionTaskPreferencesSchema, { extensionId: "plugin", revision: { value: 1n }, showPreferences: true,
  tasksAvailable: true, targetId: "approved-directory", permissionMode: PermissionMode.AUTO,
  model: { backendId: "runtime", providerId: "provider", modelId: "answer", effort: "low", fastMode: false },
  models: [{ name: "Answer", route: { backendId: "runtime", providerId: "provider", modelId: "answer", fastMode: false }, efforts: ["low", "high"], supportsFastMode: false }],
  directories: [{ targetId: "approved-directory", name: "Approved project", backendId: "runtime" }] });
async function render(patch: Partial<ExtensionTaskApi> = {}) {
  const state = preferences(), api: ExtensionTaskApi = {
    getPreferences: vi.fn(async () => create(ExtensionTaskServiceGetPreferencesResponseSchema, { preferences: state })),
    updatePreferences: vi.fn(async () => create(ExtensionTaskServiceUpdatePreferencesResponseSchema, { preferences: state })),
    listBackgroundTasks: vi.fn(async () => create(ExtensionTaskServiceListBackgroundTasksResponseSchema)),
    revealTask: vi.fn(async () => create(ExtensionTaskServiceRevealTaskResponseSchema, { taskId: "background" })),
    retryWriteAccess: vi.fn(async () => create(ExtensionTaskServiceRetryWriteAccessResponseSchema, { granted: true, preferences: state })), ...patch };
  const controller = { extensionTaskApi: () => api, navigate: vi.fn(), refresh: vi.fn(async () => {}) } as unknown as AppController;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const view: JSX.Element = <ExtensionTasksSection controller={controller} extension={{ id: "plugin", revision: 1n, permissions: [] } as unknown as ExtensionCatalogEntryView}
    disabled={false} t={(key, values) => translate("en", key, values)} />;
  await act(async () => root.render(view)); return { root, container, controller, api };
}
it("clears the model while preserving the approved directory and permission, retaining a failed draft", async () => {
  let failed = true;
  const update = vi.fn<ExtensionTaskApi["updatePreferences"]>(async () => {
    if (failed) throw new Error("Unavailable"); return create(ExtensionTaskServiceUpdatePreferencesResponseSchema, { preferences: { ...preferences(), model: undefined, revision: create(RevisionSchema, { value: 2n }) } });
  });
  const f = await render({ updatePreferences: update });
  await act(async () => { const select = f.container.querySelector("select")!; select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const submit = () => f.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await act(async () => { submit(); });
  expect(f.container.querySelector("[role=alert]")).not.toBeNull(); expect(f.container.querySelector("select")!.value).toBe("");
  expect(update.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: { value: 1n }, targetId: "approved-directory", permissionMode: PermissionMode.AUTO });
  expect(update.mock.calls[0]?.[0].model).toBeUndefined();
  failed = false; await act(async () => { submit(); }); expect(update).toHaveBeenCalledTimes(2); expect(f.container.querySelector("[role=alert]")).toBeNull();
});
it("keeps background recovery available when the preferences form is opted out", async () => {
  const f = await render({ getPreferences: async () => create(ExtensionTaskServiceGetPreferencesResponseSchema, { preferences: { ...preferences(), showPreferences: false } }),
    listBackgroundTasks: async () => create(ExtensionTaskServiceListBackgroundTasksResponseSchema, { tasks: [{ taskId: "background", title: "Background review" }] }) });
  expect(f.container.querySelector("form")).toBeNull(); expect(f.container.textContent).toContain("Background review");
  const actions = [...f.container.querySelectorAll("button")];
  await act(async () => { actions.find(button => button.textContent === translate("en", "extensions.tasks.open"))!.click(); });
  expect(f.controller.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "background" });
  await act(async () => { actions.find(button => button.textContent === translate("en", "extensions.tasks.reveal"))!.click(); });
  expect(f.api.revealTask).toHaveBeenCalledWith({ extensionId: "plugin", taskId: "background" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
it("aborts pending writes with the original preference surface lifetime", async () => {
  let signal!: AbortSignal;
  const f = await render({ updatePreferences: async (_request, options) => { signal = options!.signal!; return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Retired")), { once: true })); } });
  await act(async () => { f.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(signal.aborted).toBe(false); await act(async () => f.root.unmount()); roots.splice(roots.indexOf(f.root), 1); expect(signal.aborted).toBe(true);
});
it("keeps explicit permission recovery available after preference opt-out and sends only the selected task identity", async () => {
  const f = await render({ getPreferences: async () => create(ExtensionTaskServiceGetPreferencesResponseSchema, { preferences: { ...preferences(), showPreferences: false,
    writeRequests: [create(ExtensionTaskWriteRequestSchema, { taskId: "task-write", title: "Draft", mode: PermissionMode.ACCEPT_EDITS })] } }) });
  expect(f.container.querySelector("form")).toBeNull();
  const button = [...f.container.querySelectorAll("button")].find(value => value.textContent === translate("en", "extensions.tasks.retryPermission"))!;
  await act(async () => button.click());
  expect(f.api.retryWriteAccess).toHaveBeenCalledWith({ extensionId: "plugin", taskId: "task-write" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
