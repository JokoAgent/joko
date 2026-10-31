// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { buildTaskShareInvitation, createTaskSharingApi, GetTaskSharingActionReceiptResponseSchema, JoinedTaskShareSchema, TaskShareSchema, type TaskSharingApi, type TaskSharingRpc } from "@joko/contracts";
import { translate } from "../i18n.js";
import type { AppController } from "../controller.js";
import { LocalState } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import type { PendingTaskSharingAction } from "../task-sharing.js";
import { TaskSharingNavigation, TaskSharingSettings } from "./TaskSharingSettings.js";

let root: Root | undefined;
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
const share = create(TaskShareSchema, { shareId: "share", shareGeneration: 1n, sessionId: "task", hostServerId: "host", hostOrigin: "https://host.example", title: "Shared task", status: "active" });
const joined = create(JoinedTaskShareSchema, { joinId: "joined", status: "active", share, member: { memberId: "member", memberGeneration: 1n, status: "active", displayName: "Guest" } });
const invitation = buildTaskShareInvitation({ hostOrigin: "https://host.example", hostServerId: "host", endpointPublicKey: `ed25519:${"a".repeat(64)}`, shareId: "share", shareGeneration: 1n, inviteSecret: "a".repeat(48) });
async function fixture(options: { readonly sessionId?: string; readonly invitation?: string; readonly pending?: PendingTaskSharingAction; readonly ownerDocument?: Document } = {}) {
  const pending = new Map<string, PendingTaskSharingAction>(); if (options.pending) pending.set(options.pending.operationId, options.pending);
  const local = { taskSharingActions: vi.fn(async () => [...pending.values()]),
    saveTaskSharingAction: vi.fn(async (_owner: string, action: PendingTaskSharingAction) => { pending.set(action.operationId, action); }),
    finishTaskSharingAction: vi.fn(async (_owner: string, id: string) => { pending.delete(id); }) };
  vi.spyOn(LocalState, "open").mockResolvedValue(local as unknown as LocalState);
  const api = { list: vi.fn().mockResolvedValue({ owned: [], joined: [], intents: [] }),
    create: vi.fn().mockResolvedValue({ share }), invite: vi.fn().mockResolvedValue({ invitation, share }),
    preview: vi.fn().mockResolvedValue({ share }), join: vi.fn().mockResolvedValue({ intent: { joined, status: "joined" } }),
    lookupJoin: vi.fn().mockResolvedValue({ intent: { joined, status: "joined" } }),
    lookupAction: vi.fn(), endAll: vi.fn(), end: vi.fn().mockResolvedValue({ share: { ...share, status: "ended" } }), leave: vi.fn(), remove: vi.fn() };
  const controller = { taskSharing: api, state: { snapshot: emptySnapshot(), activeProfile: { id: "home", serverId: "home-server" }, connectionGeneration: 1, route: { kind: "settings" } }, navigate: vi.fn() } as unknown as AppController;
  const documentOwner = options.ownerDocument ?? document;
  const host = documentOwner.body.appendChild(documentOwner.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(<TaskSharingSettings controller={controller} t={key => key} sessionId={options.sessionId} initialInvitation={options.invitation} />));
  return { api, local, pending, controller, host };
}
async function click(element: HTMLElement): Promise<void> { await act(async () => { element.click(); }); }
function button(host: ParentNode, label: string): HTMLButtonElement { const value = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); if (!value) throw new Error(`Missing button: ${label}`); return value; }
async function input(element: HTMLInputElement, value: string): Promise<void> { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
describe("Task Sharing management", () => {
  it("offers an explicit reconnect from Settings and Sidebar without treating temporary disconnect as revocation", async () => {
    const f = await fixture();
    f.api.list.mockResolvedValue({ owned: [], joined: [{ ...joined, status: "disconnected" }, { ...joined, joinId: "revoked", status: "revoked" }], intents: [] });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click(button(f.host, "taskSharing.joined"));
    const reconnect = f.host.querySelector<HTMLButtonElement>("[data-task-sharing-open][data-join-id='joined']")!;
    expect(reconnect.disabled).toBe(false); expect(reconnect.textContent).toBe("connection.reconnect");
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-open][data-join-id='revoked']")?.disabled).toBe(true);
    await click(reconnect); expect(f.controller.navigate).toHaveBeenCalledWith({ kind: "sharedTask", profileId: "home", joinId: "joined" });
    await act(async () => root!.render(<TaskSharingNavigation controller={f.controller} t={key => key} onClose={vi.fn()} />));
    expect(f.host.querySelectorAll("button")).toHaveLength(1); expect(f.host.textContent).toContain("connection.reconnect");
    await click(f.host.querySelector("button")!);
    expect(f.controller.navigate).toHaveBeenCalledTimes(2);
    expect(f.api.join).not.toHaveBeenCalled();
  });
  it("starts sharing from the real host task and copies an explicit invitation", async () => {
    const f = await fixture({ sessionId: "task" });
    f.api.list.mockResolvedValue({ owned: [share], joined: [], intents: [] });
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    expect(f.api.create).toHaveBeenCalledWith(expect.any(String), "task", expect.any(AbortSignal));
    expect(f.pending.size).toBe(0);
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-invite]")!);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(invitation);
    expect(f.host.textContent).toContain("taskSharing.invitationCopied"); expect(f.pending.size).toBe(0);
  });
  it("copies an invitation in the clicked task document instead of the renderer's global document", async () => {
    const iframe = document.body.appendChild(document.createElement("iframe")), ownerDocument = iframe.contentDocument!;
    const f = await fixture({ sessionId: "task", ownerDocument });
    f.api.list.mockResolvedValue({ owned: [share], joined: [], intents: [] });
    const mainCopy = vi.fn().mockRejectedValue(new Error("The global document is not the task owner."));
    const ownerCopy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mainCopy } });
    Object.defineProperty(ownerDocument.defaultView!.navigator, "clipboard", { configurable: true, value: { writeText: ownerCopy } });
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-invite]")!);
    expect(ownerCopy).toHaveBeenCalledExactlyOnceWith(invitation); expect(mainCopy).not.toHaveBeenCalled();
    expect(f.host.textContent).toContain("taskSharing.invitationCopied"); expect(f.pending.size).toBe(0);
  });
  it("keeps a completed invitation separate from a failed clipboard effect and requires an explicit new attempt", async () => {
    const f = await fixture({ sessionId: "task" });
    f.api.list.mockResolvedValue({ owned: [share], joined: [], intents: [] });
    const writeText = vi.fn().mockRejectedValueOnce(new DOMException("clipboard denied", "NotAllowedError")).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-invite]")!);
    expect(f.api.invite).toHaveBeenCalledOnce(); expect(f.pending.size).toBe(0);
    expect(f.host.textContent).toContain("taskSharing.invitationCopyFailed");
    expect(f.host.textContent).not.toContain("taskSharing.unknown");
    expect(f.host.textContent).not.toContain("clipboard denied");
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-invite]")?.disabled).toBe(false);
    expect(f.api.lookupAction).not.toHaveBeenCalled();
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-invite]")!);
    expect(f.api.invite).toHaveBeenCalledTimes(2);
    expect(f.api.invite.mock.calls[0]![0]).not.toEqual(f.api.invite.mock.calls[1]![0]);
    expect(f.host.textContent).toContain("taskSharing.invitationCopied"); expect(f.pending.size).toBe(0);
  });
  it("keeps the original invitation fenced when its remote result is unknown", async () => {
    const f = await fixture({ sessionId: "task" });
    f.api.list.mockResolvedValue({ owned: [share], joined: [], intents: [] });
    const writeText = vi.fn(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    f.api.invite.mockRejectedValue(new ConnectError("offline", Code.Unavailable));
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-invite]")!);
    expect(f.pending.size).toBe(1); expect(writeText).not.toHaveBeenCalled();
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-invite]")?.disabled).toBe(true);
    f.api.lookupAction.mockResolvedValue({ status: "applied", kind: "task_share_invite", failedShareIds: [] });
    await click(button(f.host, "taskSharing.check"));
    expect(f.api.lookupAction).toHaveBeenCalledWith(f.api.invite.mock.calls[0]![0], expect.any(AbortSignal));
    expect(f.api.invite).toHaveBeenCalledOnce(); expect(writeText).not.toHaveBeenCalled();
    expect(f.pending.size).toBe(0); expect(f.host.textContent).toContain("taskSharing.invitationLost");
  });
  it("retains the exact pending invitation when recording completion fails before clipboard dispatch", async () => {
    const f = await fixture({ sessionId: "task" });
    f.api.list.mockResolvedValue({ owned: [share], joined: [], intents: [] });
    const writeText = vi.fn(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    f.local.finishTaskSharingAction.mockRejectedValueOnce(new Error("local completion unavailable"));
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-invite]")!);
    expect(f.pending.size).toBe(1); expect(writeText).not.toHaveBeenCalled();
    expect([...f.pending.values()]).toEqual([{ kind: "invite", operationId: f.api.invite.mock.calls[0]![0] }]);
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-invite]")?.disabled).toBe(true);
  });
  it("preflights before joining and cleans the exact journal after immediate successful navigation unmount", async () => {
    const f = await fixture({ invitation });
    await input(f.host.querySelector<HTMLInputElement>("[data-task-sharing-name]")!, "Guest");
    await act(async () => { f.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(f.api.preview).toHaveBeenCalledOnce(); expect(f.api.join).not.toHaveBeenCalled();
    vi.mocked(f.controller.navigate).mockImplementation(() => { root!.unmount(); root = undefined; });
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-join]")!);
    expect(f.api.join).toHaveBeenCalledWith(expect.any(String), invitation, "Guest", expect.any(AbortSignal));
    expect(f.local.saveTaskSharingAction).toHaveBeenCalledOnce(); expect(f.local.finishTaskSharingAction).toHaveBeenCalledOnce();
    expect(f.pending.size).toBe(0);
  });
  it("recovers the original unknown action by receipt without generating another invitation", async () => {
    const action = { kind: "invite" as const, operationId: "00000000-0000-4000-8000-000000000001" };
    const f = await fixture({ sessionId: "task", pending: action });
    const rpc = { getTaskSharingActionReceipt: vi.fn(async () => create(GetTaskSharingActionReceiptResponseSchema, { receipt: { operationId: action.operationId, kind: "task_share_invite", status: "applied" } })) };
    const contractApi = createTaskSharingApi({ rpc: rpc as unknown as TaskSharingRpc, assertCurrent: signal => signal.throwIfAborted() });
    f.api.lookupAction.mockImplementation((id, signal) => contractApi.lookupAction(id, signal));
    await click(button(f.host, "taskSharing.check"));
    expect(f.api.lookupAction).toHaveBeenCalledExactlyOnceWith(action.operationId, expect.any(AbortSignal));
    expect(f.api.invite).not.toHaveBeenCalled(); expect(f.pending.size).toBe(0);
    expect(f.host.textContent).toContain("taskSharing.invitationLost");
  });
  it("preserves partial close-all results and does not retry failed effects automatically", async () => {
    const f = await fixture(); f.api.list.mockResolvedValue({ owned: [share], joined: [], intents: [] });
    await act(async () => window.dispatchEvent(new Event("focus")));
    f.api.endAll.mockResolvedValue({ endedShareIds: [], failedShareIds: [share.shareId] });
    await click(button(f.host, "taskSharing.endAll")); await click(document.querySelector<HTMLElement>("[data-task-sharing-confirm]")!);
    expect(f.api.endAll).toHaveBeenCalledOnce(); expect(f.host.textContent).toContain("taskSharing.partial"); expect(f.pending.size).toBe(0);
  });
  it("keeps an uncertain submitted effect fenced across remount instead of resubmitting", async () => {
    const f = await fixture({ sessionId: "task" }); f.api.create.mockRejectedValue(new ConnectError("offline", Code.Unavailable));
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    expect(f.api.create).toHaveBeenCalledOnce(); expect(f.pending.size).toBe(1);
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-start]")?.disabled).toBe(true);
    f.api.lookupAction.mockRejectedValue(new ConnectError("still offline", Code.Unavailable));
    await click(button(f.host, "taskSharing.check"));
    expect(f.api.create).toHaveBeenCalledOnce(); expect(f.pending.size).toBe(1);
    await act(async () => root!.unmount()); root = createRoot(f.host);
    await act(async () => root!.render(<TaskSharingSettings controller={f.controller} t={key => key} sessionId="task" />));
    f.api.lookupAction.mockRejectedValue(new ConnectError("not admitted", Code.NotFound));
    await click(button(f.host, "taskSharing.check"));
    expect(f.pending.size).toBe(0);
    expect(f.host.textContent).toContain("taskSharing.notAdmitted");
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-start]")?.disabled).toBe(false);
    expect(f.api.create).toHaveBeenCalledOnce();
  });
  it("removes a definite preflight rejection without retaining a blocked operation", async () => {
    const f = await fixture({ sessionId: "task" }); f.api.create.mockRejectedValue(new ConnectError("rejected", Code.FailedPrecondition));
    await click(f.host.querySelector<HTMLElement>("[data-task-sharing-start]")!);
    expect(f.pending.size).toBe(0);
    expect(f.host.querySelector<HTMLButtonElement>("[data-task-sharing-start]")?.disabled).toBe(false);
    expect(f.host.textContent).not.toContain("taskSharing.unknown");
  });
  it("clears an unadmitted join intent and does not submit it during receipt recovery", async () => {
    const action = { kind: "join" as const, operationId: "unadmitted-join" }, f = await fixture({ pending: action });
    f.api.lookupJoin.mockRejectedValue(new ConnectError("not admitted", Code.NotFound));
    await click(button(f.host, "taskSharing.check"));
    expect(f.api.lookupJoin).toHaveBeenCalledExactlyOnceWith(action.operationId, expect.any(AbortSignal));
    expect(f.pending.size).toBe(0); expect(f.api.join).not.toHaveBeenCalled();
  });
  it("shows each dangerous operation's task, member, or affected task count", async () => {
    const f = await fixture(); f.api.list.mockResolvedValue({ owned: [{ ...share, members: [joined.member!] }], joined: [joined], intents: [] });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => root!.render(<TaskSharingSettings controller={f.controller} t={(key, values) => translate("en", key, values)} />));
    await click(button(f.host, "Remove participant"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Guest");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Shared task");
    await click(button(document, "Cancel"));
    await click(button(f.host, "End all sharing"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("all 1 tasks");
    expect(document.querySelector('[role="dialog"] li')?.textContent).toBe("Shared task");
  });
  it("moves shared task tabs with arrows, Home, and End and associates the selected panel", async () => {
    const f = await fixture(), tabs = [...f.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.classList.contains("button--primary")).toBe(true);
    expect(f.host.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(tabs[1]!.id);
    await act(async () => tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
  });
});
