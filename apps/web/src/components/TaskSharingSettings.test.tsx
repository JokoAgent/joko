// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { buildTaskShareInvitation, JoinedTaskShareSchema, TaskShareSchema, type TaskSharingApi } from "@joko/contracts";
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
const invitation = buildTaskShareInvitation({ hostOrigin: "https://host.example", hostServerId: "host", shareId: "share", shareGeneration: 1n, inviteSecret: "a".repeat(48) });
async function fixture(options: { readonly sessionId?: string; readonly invitation?: string; readonly pending?: PendingTaskSharingAction } = {}) {
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
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
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
    f.api.lookupAction.mockResolvedValue({ operationId: action.operationId, kind: "invite", status: "applied", failedShareIds: [] });
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
  });
});
