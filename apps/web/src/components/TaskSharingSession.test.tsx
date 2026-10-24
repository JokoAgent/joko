// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createTaskSharingApi, GetTaskSharingActionReceiptResponseSchema, ListTaskSharesResponseSchema, type TaskSharingRpc } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { createTaskSharingGateway, type OrchestratorGateway } from "../gateway.js";
import { LocalState } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import { TaskSharingSession } from "./TaskSharingSession.js";

let renderedController: AppController | undefined;
vi.mock("./SessionPane.js", () => ({ SessionPane: ({ controller, onArchive }: { controller: AppController; onArchive: () => void }) => {
  renderedController = controller;
  return <><p>{controller.state.snapshot.sessions[0]?.id}</p><button data-leave onClick={onArchive}>Leave</button></>;
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

async function mountPendingLeave() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const joined = { joinId: "joined", status: "active", share: { hostServerId: "host", shareId: "share", sessionId: "remote-task", shareGeneration: 1n, status: "active" },
    member: { memberId: "member", memberGeneration: 1n, status: "active" } };
  const receipt = vi.fn(async () => create(GetTaskSharingActionReceiptResponseSchema, { receipt: { operationId: "original-leave", kind: "task_share_leave", status: "applied", joined } }));
  const leave = vi.fn();
  const api = createTaskSharingApi({ rpc: { listTaskShares: async () => create(ListTaskSharesResponseSchema, { joined: [joined] }), getTaskSharingActionReceipt: receipt, leaveTaskShare: leave } as unknown as TaskSharingRpc,
    assertCurrent: signal => signal.throwIfAborted() });
  const navigate = vi.fn(), home = { taskSharing: api, navigate, state: { snapshot: emptySnapshot(), connectionState: "connected", connectionGeneration: 1,
    activeProfile: { id: "home", serverId: "home-server", origin: "https://home.test" }, profiles: [], route: { kind: "sharedTask", joinId: "joined", profileId: "home" } } } as unknown as AppController;
  const finish = vi.fn(async () => undefined);
  vi.spyOn(LocalState, "open").mockResolvedValue({ taskSharingActions: async () => [{ operationId: "original-leave", kind: "leave" }], finishTaskSharingAction: finish } as unknown as LocalState);
  const snapshot = { ...emptySnapshot(), sessions: [{ id: "remote-task", generation: 1n }] } as unknown as ReturnType<typeof emptySnapshot>;
  vi.mocked(createTaskSharingGateway).mockImplementation((_profile, listener) => ({
    connect: async () => { listener.onSnapshot?.(snapshot); listener.onState?.("connected"); }, loadSessionTimelinePage: async () => ({ items: [] }), disconnect: vi.fn()
  }) as unknown as OrchestratorGateway);
  let pending: Promise<unknown> = Promise.resolve();
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(<TaskSharingSession controller={home} joinId="joined" profileId="home" t={key => key}
    runAction={(_key, work) => { pending = work(); }} onOpenNavigation={() => undefined} />));
  return { host, receipt, finish, leave, navigate, pending: () => pending };
}

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
    connect: async () => { listener.onSnapshot?.(snapshot); listener.onState?.("connected"); },
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
