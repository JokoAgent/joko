// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { PartnerWorkbenchRoutineSchema, RoutineRunStatus, ListPartnerRoutinesResponseSchema, type PartnerRoutineApi } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { emptySnapshot, type PartnerProfileView, type PartnerWorkbenchView, type PartnerWorkbenchTaskView, type SessionView } from "../model.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { translate } from "../i18n.js";
import type { PartnerConversationView } from "./PartnerConversation.js";
import { PartnerWorkbench, type PartnerWorkbenchDrafts } from "./PartnerWorkbench.js";
import { Inspector } from "./Inspector.js";
import type { Translator } from "./types.js";

const context = vi.hoisted(() => ({ current: undefined as PartnerConversationView | undefined }));
vi.mock("./PartnerConversation.js", () => ({ usePartnerConversation: () => context.current }));
vi.mock("sortablejs", () => ({ default: { create: () => ({ destroy: () => undefined, option: () => undefined }) } }));
const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.spyOn(document, "hasFocus").mockReturnValue(true); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); localStorage.clear(); context.current = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("grants the selected project before sending a plain human Queue message and keeps a failed handover for retry", async () => {
  const f = fixture(false);
  f.app.send.mockRejectedValueOnce(new Error("Queue unavailable"));
  const ui = await mount(f);
  await input(ui.host.querySelector("input")!, "D:/project");
  await click(button(ui.host, t("workbench.handOverAction")));
  expect(f.app.addPartnerWorkbenchProject).toHaveBeenCalledOnce();
  expect(f.app.send).toHaveBeenCalledWith("canonical", expect.objectContaining({ text: expect.stringContaining("D:/project"), attachments: [], deliveryMode: "prompt" }), { expectedGeneration: 1n });
  expect(f.app.send.mock.invocationCallOrder[0]).toBeGreaterThan(f.app.addPartnerWorkbenchProject.mock.invocationCallOrder[0]!);
  expect(f.drafts.messages.has("handover:D:/project")).toBe(true);
  expect(ui.host.textContent).toContain("Queue unavailable");
  await click(button(required(ui.host.querySelector(".partner-workbench__judgment")), t("common.retry")));
  expect(f.app.addPartnerWorkbenchProject).toHaveBeenCalledOnce(); expect(f.app.send).toHaveBeenCalledTimes(2);
  expect(f.drafts.messages.size).toBe(0);
});

it("keeps task detail inside the panel, preserves a failed direction, and reopens it with the same draft", async () => {
  const f = fixture(); const ui = await mount(f, "task:one");
  expect(ui.host.textContent).toContain("Original purpose"); expect(f.app.navigate).not.toHaveBeenCalled();
  await input(required(ui.host.querySelector("textarea")), "Finish this carefully");
  f.app.send.mockRejectedValueOnce(new Error("Queue unavailable"));
  await click(button(ui.host, t("workbench.sendDirection")));
  expect(f.drafts.messages.get("task:one")).toBe("Finish this carefully");
  expect(ui.host.querySelector("textarea")?.value).toBe("Finish this carefully");
  await ui.render(false, "task:one"); await ui.render(true, "task:one");
  expect(ui.host.querySelector("textarea")?.value).toBe("Finish this carefully");
  await click(button(ui.host, t("workbench.sendDirection")));
  expect(f.drafts.messages.has("task:one")).toBe(false);
  expect(ui.host.querySelector("textarea")?.value).toBe("");
  expect(f.view.tasks[0]?.state).toBe("stopped");
});

it("shows current work notes and pull requests, limits completed work, and follows up only where a decision is needed", async () => {
  const f = fixture(); const base = f.view.tasks[0]!;
  f.app.getPartnerWorkbench.mockResolvedValue({ ...f.view, tasks: [
    { ...base, id: "running", title: "Live work", state: "running", group: "running", startedAt: Date.now() - 90_000 },
    { ...base, id: "queued", title: "Queued work", state: "queued", group: "todo" },
    { ...base, id: "failed", title: "Blocked work", stopReason: "failed", judgment: { taskId: "failed", project: base.project, title: "Blocked work", verdict: "unfinished", next: "Choose a direction", updatedAt: 1_000 },
      pullRequest: { key: "code.example/acme/work#42", host: "code.example", repositoryOwner: "acme", repositoryName: "work", number: 42, webUrl: "https://code.example/acme/work/pull/42",
        projection: { state: "merged", draft: false, title: "Change", headBranch: "topic", observedAt: 1_000 } } },
    ...Array.from({ length: 35 }, (_, index): PartnerWorkbenchTaskView => ({ ...base, id: `done:${index}`, title: `Finished ${index}`, state: "done", group: "done", updatedAt: index }))
  ] });
  const ui = await mount(f);
  const running = required(ui.host.querySelector('[aria-label="In progress"]'));
  expect(running.textContent).toContain("Running · 1:30"); expect(running.querySelector("button.button")).toBeNull();
  expect(ui.host.textContent).not.toContain("Original purpose");
  const waiting = required(ui.host.querySelector('[aria-label="Waiting for you"]'));
  expect(waiting.textContent).toContain("Failed · Choose a direction"); expect(waiting.textContent).toContain("#42"); expect(waiting.textContent).toContain("Merged");
  const done = required(ui.host.querySelector('[aria-label="Done"]'));
  expect(done.querySelectorAll(".partner-workbench__task")).toHaveLength(0);
  await click(required(done.querySelector("button.partner-workbench__group-heading")));
  expect(done.querySelectorAll(".partner-workbench__task")).toHaveLength(30);
  expect(done.textContent).toContain("5 earlier completed items"); expect(done.textContent).toContain("Finished 34"); expect(done.textContent).not.toContain("Finished 0");
  expect(done.querySelector("button.button")).toBeNull();
  await click(required(waiting.querySelector("button.button")));
  expect(f.app.send).toHaveBeenCalledOnce(); expect(waiting.querySelector("button.button")?.hasAttribute("disabled")).toBe(true);
  Object.assign(f.session, { state: "running" }); await ui.render(true);
  expect(waiting.querySelector("button.button")?.hasAttribute("disabled")).toBe(false);
  const reads = f.app.getPartnerWorkbench.mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(160); await settle(); });
  expect(f.app.getPartnerWorkbench.mock.calls.length).toBeGreaterThan(reads);
  await ui.render(false); const inactiveReads = f.app.getPartnerWorkbench.mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(60_160); await settle(); });
  expect(f.app.getPartnerWorkbench).toHaveBeenCalledTimes(inactiveReads);
});

it("opens the same pull request from detail and sends Enter without submitting IME confirmation", async () => {
  const f = fixture(); const task = { ...f.view.tasks[0]!, pullRequest: { key: "code.example/acme/work#42", host: "code.example", repositoryOwner: "acme", repositoryName: "work", number: 42, webUrl: "https://code.example/acme/work/pull/42" } };
  f.app.getPartnerWorkbench.mockResolvedValue({ ...f.view, tasks: [task] });
  f.app.getPartnerWorkbenchDetail.mockResolvedValue({ task, transcript: [], truncated: false, artifacts: [] });
  const resolve = vi.fn(async () => ({ kind: "https", value: task.pullRequest.webUrl })); const open = vi.fn(async () => undefined);
  Object.assign(f.app, { resolvePartnerWorkbenchReference: resolve, openHttpLink: open });
  const ui = await mount(f, task.id);
  await click(required(ui.host.querySelector(".partner-workbench__pr-link")));
  expect(resolve).toHaveBeenCalledWith(f.view.owner, task.pullRequest.webUrl, expect.any(AbortSignal));
  expect(open).toHaveBeenCalledWith(task.pullRequest.webUrl, expect.objectContaining({ sessionId: "canonical", action: { ownerDocument: document, signal: expect.any(AbortSignal) } }));
  const draft = required(ui.host.querySelector("textarea")); await input(draft, "Finish the review");
  await act(async () => { draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); await settle(); });
  expect(f.app.send).not.toHaveBeenCalled(); expect(draft.value).toBe("Finish the review");
  await act(async () => { draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); await settle(); });
  expect(f.app.send).not.toHaveBeenCalled();
  await act(async () => { draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await settle(); });
  expect(f.app.send).toHaveBeenCalledOnce(); expect(draft.value).toBe("");
});

it("aborts a pending grant when its document retires and never sends the late human message", async () => {
  const f = fixture(false); const pending = deferred<PartnerWorkbenchView & { acceptedProject: string }>();
  f.app.addPartnerWorkbenchProject.mockImplementation(() => pending.promise);
  const ui = await mount(f); await input(ui.host.querySelector("input")!, "D:/project");
  await click(button(ui.host, t("workbench.handOverAction")));
  const signal = f.app.addPartnerWorkbenchProject.mock.calls[0]?.[3];
  await act(async () => { window.dispatchEvent(new Event("pagehide")); pending.resolve({ ...f.view, acceptedProject: "D:/project" }); await settle(); });
  expect(signal?.aborted).toBe(true); expect(f.app.send).not.toHaveBeenCalled();
});

it("opens owned routine settings from an empty workbench in its actual document and suspends hidden edits without losing the draft", async () => {
  const f = fixture(false);
  const routine = create(PartnerWorkbenchRoutineSchema, { id: "standing", enabled: true,
    triggers: [{ id: "time", kind: { case: "interval", value: { intervalMs: 3_600_000n } } }],
    lastRunStatus: RoutineRunStatus.FAILED, lastRunSummary: "Check failed" });
  f.app.getPartnerWorkbench.mockResolvedValue({ ...f.view, tasks: [
    { ...f.view.tasks[0], id: "routine:standing", kind: "automation", project: "", title: "Standing review", state: "running", group: "running", updatedAt: 1000, sourceLabel: "Routine", ownedBackground: false, unread: false, digest: { purpose: null, recent: [] }, routine },
    { id: "routine:failed", kind: "automation", project: "", title: "Failed review", state: "automation", group: "done", updatedAt: 1000, sourceLabel: "Routine", ownedBackground: false, unread: false, digest: { purpose: null, recent: [] }, routine: { ...routine, id: "failed" } },
    { id: "routine:disabled", kind: "automation", project: "", title: "Disabled review", state: "stopped", group: "done", updatedAt: 1000, sourceLabel: "Routine", ownedBackground: false, unread: false, digest: { purpose: null, recent: [] }, routine: { ...routine, id: "disabled", enabled: false } }
  ] });
  const frame = document.body.appendChild(document.createElement("iframe"));
  const ownerDocument = required(frame.contentDocument); const ownerWindow = required(frame.contentWindow);
  vi.spyOn(ownerDocument, "visibilityState", "get").mockReturnValue("visible");
  const ui = await mount(f, undefined, ownerDocument);
  expect(ui.host.textContent).toContain("Every 1 hours");
  await click(required(ui.host.querySelector<HTMLButtonElement>("button.partner-workbench__group-heading")));
  expect(ui.host.textContent).toContain("Last run did not complete · Check failed");
  expect(ui.host.textContent).toContain("Disabled");
  await click(required(ui.host.querySelector<HTMLButtonElement>(".partner-workbench__task")));
  expect(f.app.partnerRoutineApi).toHaveBeenCalledWith("partner", f.conversation.ownerKey);
  expect(f.routineApi.list).toHaveBeenCalledOnce(); expect(f.app.navigate).not.toHaveBeenCalled(); expect(f.app.send).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const dialog = required(ownerDocument.querySelector('[role="dialog"]'));
  const name = required(dialog.querySelector<HTMLInputElement>("fieldset input"));
  await input(name, "Keep my draft");
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await settle(); });
  expect(name.closest("fieldset")?.disabled).toBe(false);
  await act(async () => { ownerWindow.dispatchEvent(new Event("pagehide")); await settle(); });
  expect(name.closest("fieldset")?.disabled).toBe(true); expect(name.value).toBe("Keep my draft");
  await act(async () => { ownerWindow.dispatchEvent(new Event("pageshow")); await settle(); });
  expect(name.value).toBe("Keep my draft"); expect(dialog.textContent).toContain("Refresh to use the current Partner");
  expect(f.routineApi.save).not.toHaveBeenCalled();
});

it("hides retained transcript and actions after a project grant is withdrawn while keeping its unsent draft", async () => {
  const f = fixture(); const ui = await mount(f, "task:one");
  await input(required(ui.host.querySelector("textarea")), "Unsent direction");
  f.app.getPartnerWorkbench.mockResolvedValue({ ...f.view, revision: 2n, projects: [], tasks: [] });
  f.app.state.snapshot = { ...f.app.state.snapshot, cursor: 1n };
  await ui.render(true, "task:one");
  expect(ui.host.textContent).not.toContain("Original purpose");
  expect(ui.host.querySelector("textarea")).toBeNull();
  expect(f.drafts.messages.get("task:one")).toBe("Unsent direction");
});

it("opens the Inspector singleton once, hides it from Add, and preserves selection and draft through explicit close and reopen", async () => {
  const f = fixture(); context.current = f.conversation;
  const host = document.body.appendChild(document.createElement("main")); const root = createRoot(host); roots.push(root);
  const render = async () => { await act(async () => { root.render(<Inspector controller={f.app as unknown as AppController} snapshot={f.app.state.snapshot} session={f.session} timeline={[]} open t={t} runAction={(_key, action) => { void action(); }} onClose={vi.fn()} onSelectionQuote={vi.fn()} />); await settle(); }); await act(async () => { await vi.advanceTimersByTimeAsync(160); await settle(); }); };
  await render(); expect(context.current.openWorkbench).toHaveBeenCalledOnce();
  expect(host.querySelectorAll("[data-tab-kind='workbench']")).toHaveLength(1);
  await click(required(host.querySelector(".partner-workbench__task")));
  await input(required(host.querySelector<HTMLTextAreaElement>(".partner-workbench textarea")), "Saved direction");
  await click(required(host.querySelector("#inspector-tab-workbench")?.parentElement?.querySelector(".inspector-tab__close")));
  expect(host.querySelector("[data-tab-kind='workbench']")).toBeNull();
  await render(); expect(context.current.openWorkbench).toHaveBeenCalledOnce();
  await click(required(host.querySelector(`button[aria-label='${t("inspector.addTab")}']`)));
  expect([...host.querySelectorAll("[role='menuitem']")].some((item) => item.textContent === t("workbench.title"))).toBe(false);
  context.current = { ...f.conversation, workbenchRequest: 1 }; await render();
  expect(host.querySelectorAll("[data-tab-kind='workbench']")).toHaveLength(1);
  expect(host.querySelector<HTMLTextAreaElement>(".partner-workbench textarea")?.value).toBe("Saved direction");
});

function fixture(granted = true) {
  const session: SessionView = { id: "canonical", backendId: "backend", targetId: "home", name: "Partner", state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1_000 };
  const partner = { id: "partner", profileVersion: 2n, displayName: "Aster" } as PartnerProfileView;
  const task: PartnerWorkbenchTaskView = { id: "task:one", kind: "session", sessionId: "original", project: "D:/project", title: "Draft", state: "stopped", group: "waiting", updatedAt: 1_000, sourceLabel: "Task", ownedBackground: false, unread: false, digest: { purpose: "Original purpose", recent: [] } };
  let view: PartnerWorkbenchView = { owner: { partnerId: partner.id, profileVersion: partner.profileVersion, sessionId: session.id, sessionGeneration: session.generation, targetId: session.targetId }, revision: 1n,
    projects: granted ? [{ path: "D:/project", name: "project", addedAt: 1_000, exists: true }] : [], judgments: [], projectOptions: [], tasks: granted ? [task] : [], candidates: [], briefs: [], outputs: [], olderCount: 0, truncated: false, unavailableSources: [] };
  const snapshot = { ...emptySnapshot(), sessions: [session] };
  const routineApi: PartnerRoutineApi = { ownerKey: "profile/server/canonical/1", newRequestId: () => "workbench-routine-request",
    list: vi.fn(async () => create(ListPartnerRoutinesResponseSchema, { partnerId: "partner", partnerRevision: { value: 2n }, writable: true })),
    save: vi.fn(), run: vi.fn(), remove: vi.fn(), history: vi.fn(), lookup: vi.fn(), retire: vi.fn() };
  const app = { state: { ready: true, connectionState: "connected", route: { kind: "session", sessionId: session.id }, activeProfile: { id: "profile", serverId: "server", deviceId: "device", origin: "http://127.0.0.1" }, snapshot, preferences: DEFAULT_UI_PREFERENCES, effectiveLocale: "en" },
    partnerRoutineApi: vi.fn(() => routineApi),
    getPartnerWorkbench: vi.fn(async () => view), getPartnerWorkbenchDetail: vi.fn(async () => ({ task, transcript: [{ role: "user", text: "Original purpose", at: 1_000 }], truncated: false, artifacts: [] })),
    addPartnerWorkbenchProject: vi.fn(async (_owner: PartnerWorkbenchView["owner"], _revision: bigint, _path: string, _signal?: AbortSignal) => { view = { ...view, revision: view.revision + 1n, projects: [{ path: "D:/project", name: "project", addedAt: 1_000, exists: true }] }; return { ...view, acceptedProject: "D:/project" }; }),
    send: vi.fn(async (_sessionId: string, _draft: unknown, _options: unknown) => undefined), navigate: vi.fn(), releaseArtifactUrl: vi.fn() };
  const conversation: PartnerConversationView = { sessionId: session.id, ownerKey: "profile/server/canonical/1", kind: "partner", partner, confirmed: true, editable: true, failed: false, connected: true, readFailed: false, readRetry: 0,
    acknowledge: vi.fn(), retryRead: vi.fn(), refresh: vi.fn(), openSettings: vi.fn(), openPrivateThread: vi.fn(), workbenchAvailable: true, workbenchOpenFailed: false, openWorkbench: vi.fn() };
  const drafts: PartnerWorkbenchDrafts = { messages: new Map() };
  return { app, session, conversation, drafts, routineApi, get view() { return view; } };
}
async function mount(f: ReturnType<typeof fixture>, selectedTaskId?: string, ownerDocument: Document = document) {
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("main")); const root = createRoot(host); roots.push(root);
  const render = async (active: boolean, selected = selectedTaskId) => { await act(async () => { root.render(<PartnerWorkbench controller={f.app as unknown as AppController} session={f.session} conversation={f.conversation} active={active} ownerDocument={ownerDocument} selectedTaskId={selected} onSelectTask={vi.fn()} onSelectProject={vi.fn()} drafts={f.drafts} t={t} />); await settle(); }); await act(async () => { await vi.advanceTimersByTimeAsync(160); await settle(); }); };
  await render(true); return { host, render };
}
function button(host: Element, label: string): HTMLButtonElement { return required([...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)); }
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error("Expected workbench element"); return value; }
async function click(element: Element) { await act(async () => { (element as HTMLElement).click(); await settle(); }); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await settle(); }); }
async function settle() { for (let index = 0; index < 6; index++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve }; }
