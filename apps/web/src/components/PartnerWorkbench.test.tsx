// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it("aborts a pending grant when its document retires and never sends the late human message", async () => {
  const f = fixture(false); const pending = deferred<PartnerWorkbenchView & { acceptedProject: string }>();
  f.app.addPartnerWorkbenchProject.mockImplementation(() => pending.promise);
  const ui = await mount(f); await input(ui.host.querySelector("input")!, "D:/project");
  await click(button(ui.host, t("workbench.handOverAction")));
  const signal = f.app.addPartnerWorkbenchProject.mock.calls[0]?.[3];
  await act(async () => { window.dispatchEvent(new Event("pagehide")); pending.resolve({ ...f.view, acceptedProject: "D:/project" }); await settle(); });
  expect(signal?.aborted).toBe(true); expect(f.app.send).not.toHaveBeenCalled();
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
  const app = { state: { ready: true, connectionState: "connected", route: { kind: "session", sessionId: session.id }, activeProfile: { id: "profile", serverId: "server", origin: "http://127.0.0.1" }, snapshot, preferences: DEFAULT_UI_PREFERENCES, effectiveLocale: "en" },
    getPartnerWorkbench: vi.fn(async () => view), getPartnerWorkbenchDetail: vi.fn(async () => ({ task, transcript: [{ role: "user", text: "Original purpose", at: 1_000 }], truncated: false, artifacts: [] })),
    addPartnerWorkbenchProject: vi.fn(async (_owner: PartnerWorkbenchView["owner"], _revision: bigint, _path: string, _signal?: AbortSignal) => { view = { ...view, revision: view.revision + 1n, projects: [{ path: "D:/project", name: "project", addedAt: 1_000, exists: true }] }; return { ...view, acceptedProject: "D:/project" }; }),
    send: vi.fn(async (_sessionId: string, _draft: unknown, _options: unknown) => undefined), navigate: vi.fn(), releaseArtifactUrl: vi.fn() };
  const conversation: PartnerConversationView = { sessionId: session.id, ownerKey: "profile/server/canonical/1", kind: "partner", partner, confirmed: true, editable: true, failed: false, connected: true, readFailed: false, readRetry: 0,
    acknowledge: vi.fn(), retryRead: vi.fn(), refresh: vi.fn(), openSettings: vi.fn(), openPrivateThread: vi.fn(), workbenchAvailable: true, workbenchOpenFailed: false, openWorkbench: vi.fn() };
  const drafts: PartnerWorkbenchDrafts = { messages: new Map() };
  return { app, session, conversation, drafts, get view() { return view; } };
}
async function mount(f: ReturnType<typeof fixture>, selectedTaskId?: string) {
  const host = document.body.appendChild(document.createElement("main")); const root = createRoot(host); roots.push(root);
  const render = async (active: boolean, selected = selectedTaskId) => { await act(async () => { root.render(<PartnerWorkbench controller={f.app as unknown as AppController} session={f.session} conversation={f.conversation} active={active} ownerDocument={document} selectedTaskId={selected} onSelectTask={vi.fn()} onSelectProject={vi.fn()} drafts={f.drafts} t={t} />); await settle(); }); await act(async () => { await vi.advanceTimersByTimeAsync(160); await settle(); }); };
  await render(true); return { host, render };
}
function button(host: Element, label: string): HTMLButtonElement { return required([...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)); }
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error("Expected workbench element"); return value; }
async function click(element: Element) { await act(async () => { (element as HTMLElement).click(); await settle(); }); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await settle(); }); }
async function settle() { for (let index = 0; index < 6; index++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve }; }
