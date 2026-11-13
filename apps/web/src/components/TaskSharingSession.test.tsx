// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createTaskSharingApi, GetTaskSharingActionReceiptResponseSchema, ListTaskSharesResponseSchema, type TaskSharingRpc } from "@joko/contracts";
import type { AppController, AppRoute } from "../controller.js";
import { openJoinedTask } from "../task-sharing.js";
import { createTaskSharingGateway, type GatewayCallbacks, type OrchestratorGateway } from "../gateway.js";
import { LocalState } from "../local-state.js";
import { emptySnapshot, type TimelineHistoryPageView, type TimelineItemView } from "../model.js";
import { TaskSharingSession } from "./TaskSharingSession.js";

let renderedController: AppController | undefined;
vi.mock("./SessionPane.js", () => ({ SessionPane: ({ controller, onArchive, timeline, timelineHasEarlier, timelineHistoryLoading, onLoadEarlierTimeline }: {
  controller: AppController; onArchive: () => void; timeline: readonly TimelineItemView[]; timelineHasEarlier: boolean;
  timelineHistoryLoading: boolean; onLoadEarlierTimeline: () => Promise<void>;
}) => {
  renderedController = controller;
  return <><p>{controller.state.snapshot.sessions[0]?.id}</p><button data-leave onClick={onArchive}>Leave</button>
    {timeline.map(item => <p key={item.id}>{item.text}</p>)}
    {timelineHasEarlier && <button data-earlier disabled={timelineHistoryLoading} onClick={() => { void onLoadEarlierTimeline(); }}>Earlier</button>}
    {timelineHistoryLoading && <p data-history-loading />}</>;
} }));
vi.mock("./TaskSharingRuntimeControls.js", () => ({ TaskSharingRuntimeControls: () => null }));
vi.mock("./TaskSharingTaskTools.js", () => ({ TaskSharingTaskTools: () => null }));
vi.mock("../gateway.js", () => ({ createTaskSharingGateway: vi.fn() }));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; renderedController = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("accepts an actual leave receipt kind through the contract API and clears the original operation", async () => {
  const f = await mountPendingLeave();
  await act(async () => { f.host.querySelector<HTMLButtonElement>("[data-leave]")!.click(); });
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-task-sharing-confirm]")!.click(); await f.pending(); });
  expect(f.receipt).toHaveBeenCalledExactlyOnceWith({ operationId: "original-leave" }, { signal: expect.any(AbortSignal) });
  expect(f.finish).toHaveBeenCalledWith(JSON.stringify(["guest-leave", "home-server", "home", "joined"]), "original-leave");
  expect(f.navigate).toHaveBeenCalled();
  expect(f.leave).not.toHaveBeenCalled();
});

it("clears an unadmitted leave without resubmitting or navigating away", async () => {
  const f = await mountPendingLeave(); f.receipt.mockRejectedValueOnce(new ConnectError("not admitted", Code.NotFound));
  await act(async () => f.host.querySelector<HTMLButtonElement>("[data-leave]")!.click());
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-task-sharing-confirm]")!.click(); await f.pending(); });
  expect(f.finish).toHaveBeenCalledOnce();
  expect(f.host.textContent).toContain("taskSharing.notAdmitted");
  expect(f.navigate).not.toHaveBeenCalled(); expect(f.leave).not.toHaveBeenCalled();
});

it("returns to the original task once when gateway retirement races the applied leave receipt", async () => {
  const f = await mountPendingLeave(true);
  f.finish.mockImplementationOnce(async () => { await f.invalidate(); return undefined; });
  await act(async () => f.host.querySelector<HTMLButtonElement>("[data-leave]")!.click());
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-task-sharing-confirm]")!.click(); await f.pending(); });
  expect(f.finish).toHaveBeenCalledOnce(); expect(f.receipt).toHaveBeenCalledOnce();
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", profileId: "home", sessionId: "original-task" });
  expect(f.leave).not.toHaveBeenCalled();
});

async function mountPendingLeave(rememberRoute = false, loadSessionTimelinePage = vi.fn<OrchestratorGateway["loadSessionTimelinePage"]>().mockResolvedValue({ items: [] })) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const joined = { joinId: "joined", status: "active", share: { hostServerId: "host", shareId: "share", sessionId: "remote-task", shareGeneration: 1n, status: "active" },
    member: { memberId: "member", memberGeneration: 1n, status: "active" } };
  const receipt = vi.fn(async () => create(GetTaskSharingActionReceiptResponseSchema, { receipt: { operationId: "original-leave", kind: "task_share_leave", status: "applied", joined } }));
  const leave = vi.fn();
  const api = createTaskSharingApi({ rpc: { listTaskShares: async () => create(ListTaskSharesResponseSchema, { joined: [joined] }), getTaskSharingActionReceipt: receipt, leaveTaskShare: leave } as unknown as TaskSharingRpc,
    assertCurrent: signal => signal.throwIfAborted() });
  const navigate = vi.fn(), home = { taskSharing: api, navigate, state: { snapshot: emptySnapshot(), connectionState: "connected", connectionGeneration: 1,
    activeProfile: { id: "home", serverId: "home-server", origin: "https://home.test" }, profiles: [], route: { kind: "sharedTask", joinId: "joined", profileId: "home" } } } as unknown as AppController;
  if (rememberRoute) {
    const state = home.state as { route: AppRoute };
    state.route = { kind: "session", profileId: "home", sessionId: "original-task" };
    openJoinedTask(home, "joined"); state.route = { kind: "sharedTask", joinId: "joined", profileId: "home" }; navigate.mockClear();
  }
  const finish = vi.fn(async () => undefined);
  vi.spyOn(LocalState, "open").mockResolvedValue({ taskSharingActions: async () => [{ operationId: "original-leave", kind: "leave" }], finishTaskSharingAction: finish } as unknown as LocalState);
  const snapshot = { ...emptySnapshot(), sessions: [{ id: "remote-task", generation: 1n }] } as unknown as ReturnType<typeof emptySnapshot>;
  let invalidate: () => void | Promise<void> = () => undefined;
  let publish!: NonNullable<GatewayCallbacks["onSnapshot"]>;
  vi.mocked(createTaskSharingGateway).mockImplementation((_profile, listener) => {
    publish = listener.onSnapshot!;
    invalidate = () => listener.onAuthenticationInvalidated?.(Object.assign(new Error("Guest membership retired."), { offline: false })); return {
    connect: async () => { publish(snapshot, true); listener.onState?.("connected"); }, loadSessionTimelinePage, disconnect: vi.fn()
    } as unknown as OrchestratorGateway;
  });
  let pending: Promise<unknown> = Promise.resolve();
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(<TaskSharingSession controller={home} joinId="joined" profileId="home" t={key => key}
    runAction={(_key, work) => { pending = work(); }} onOpenNavigation={() => undefined} />));
  return { host, receipt, finish, leave, navigate, snapshot, publish, pending: () => pending, invalidate: () => invalidate() };
}

it("keeps paged shared history on ordinary updates and reloads a first page after an authoritative retirement", async () => {
  const first = { opaqueToken: "first", generation: 1n, sequence: 210n };
  const older = { opaqueToken: "older", generation: 1n, sequence: 12n };
  const restarted = { opaqueToken: "restarted", generation: 1n, sequence: 211n };
  const item = (id: string, sequence: bigint): TimelineItemView => ({ id, sequence, text: id, kind: "user", createdAt: 1 });
  let completeStale!: (page: TimelineHistoryPageView) => void;
  let completeCurrent!: (page: TimelineHistoryPageView) => void;
  const load = vi.fn<OrchestratorGateway["loadSessionTimelinePage"]>()
    .mockResolvedValueOnce({ items: [item("first page", 210n)], nextBeforeCursor: first })
    .mockResolvedValueOnce({ items: [item("older page", 12n)], nextBeforeCursor: older })
    .mockImplementationOnce(() => new Promise(resolve => { completeStale = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { completeCurrent = resolve; }))
    .mockResolvedValueOnce({ items: [item("new older page", 13n)] });
  const f = await mountPendingLeave(false, load);
  const earlier = () => f.host.querySelector<HTMLButtonElement>("[data-earlier]");
  await act(async () => earlier()!.click());
  expect(f.host.textContent).toContain("older page");
  await act(async () => f.publish({ ...f.snapshot, cursor: 214n }));
  expect(f.host.textContent).toContain("older page");
  expect(load.mock.calls).toEqual([["remote-task", undefined], ["remote-task", first]]);
  await act(async () => earlier()!.click());
  const retired = { ...f.snapshot, cursor: 216n, timelineHistoryRevisionBySession: new Map([["remote-task", 216n]]) };
  await act(async () => f.publish(retired));
  expect(f.host.textContent).not.toContain("older page");
  expect(earlier()).toBeNull();
  expect(load).toHaveBeenCalledTimes(3);
  await act(async () => f.publish(retired, true));
  expect(load.mock.calls.at(-1)).toEqual(["remote-task", undefined]);
  await act(async () => completeStale({ items: [item("retired result", 10n)] }));
  expect(f.host.textContent).not.toContain("retired result");
  expect(f.host.querySelector("[data-history-loading]")).not.toBeNull();
  await act(async () => completeCurrent({ items: [item("new first page", 211n)], nextBeforeCursor: restarted }));
  expect(f.host.textContent).toContain("new first page");
  await act(async () => earlier()!.click());
  expect(load.mock.calls.at(-1)).toEqual(["remote-task", restarted]);
  expect(f.host.textContent).toContain("new older page");
  expect(earlier()).toBeNull();
});

it("keeps the retiring shared view readable during teardown while fencing its actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const snapshot = { ...emptySnapshot(), sessions: [{ id: "remote-task", generation: 1n }] } as unknown as ReturnType<typeof emptySnapshot>;
  const api = { list: vi.fn().mockResolvedValue({ joined: [{ joinId: "joined", status: "active",
    share: { hostServerId: "host", shareId: "share", sessionId: "remote-task", shareGeneration: 1n, status: "active" },
    member: { memberId: "member", memberGeneration: 1n, status: "active" } }] }) };
  const home = { taskSharing: api, state: { snapshot: emptySnapshot(), connectionState: "connected", connectionGeneration: 1,
    activeProfile: { id: "home", serverId: "home-server", origin: "https://home.test" }, profiles: [],
    route: { kind: "sharedTask", joinId: "joined", profileId: "home" } } } as unknown as AppController;
  vi.spyOn(LocalState, "open").mockResolvedValue({ taskSharingActions: async () => [] } as unknown as LocalState);
  const send = vi.fn(), disconnect = vi.fn();
  vi.mocked(createTaskSharingGateway).mockImplementation((_profile, listener) => ({
    connect: async () => { listener.onSnapshot?.(snapshot, true); listener.onState?.("connected"); },
    loadSessionTimelinePage: async () => ({ items: [] }), disconnect, send
  }) as unknown as OrchestratorGateway);
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => { root!.render(<TaskSharingSession controller={home} joinId="joined" profileId="home"
    t={key => key} runAction={() => undefined} onOpenNavigation={() => undefined} />); });
  expect(host.textContent).toContain("remote-task");
  const retiring = renderedController!;
  await act(async () => root!.unmount()); root = undefined;
  expect(disconnect).toHaveBeenCalledOnce();
  expect(retiring.state.snapshot.sessions).toEqual(snapshot.sessions);
  expect(retiring.state.sessionAccess).toMatchObject({ role: "guest", memberId: "member" });
  expect(() => retiring.send("remote-task", { text: "late" } as never, { expectedGeneration: 1n })).toThrow("source changed");
  expect(send).not.toHaveBeenCalled();
});
