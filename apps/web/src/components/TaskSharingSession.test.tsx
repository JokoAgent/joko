// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { createTaskSharingGateway, type OrchestratorGateway } from "../gateway.js";
import { LocalState } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import { TaskSharingSession } from "./TaskSharingSession.js";

let renderedController: AppController | undefined;
vi.mock("./SessionPane.js", () => ({ SessionPane: ({ controller }: { controller: AppController }) => {
  renderedController = controller;
  return <p>{controller.state.snapshot.sessions[0]?.id}</p>;
} }));
vi.mock("./TaskSharingRuntimeControls.js", () => ({ TaskSharingRuntimeControls: () => null }));
vi.mock("./TaskSharingTaskTools.js", () => ({ TaskSharingTaskTools: () => null }));
vi.mock("../gateway.js", () => ({ createTaskSharingGateway: vi.fn() }));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; renderedController = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
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
