import { createClient, createRouterTransport, Code } from "@connectrpc/connect";
import { TaskActivityService, type TaskActivityState } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { ConnectionManager } from "./connection-manager.js";
import { createConnectServices } from "./connect-services.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const store = new OperationalStore(":memory:", { now: () => 1_000 }); cleanup.push(() => store.close());
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "1", health: "healthy", adapterKind: "fixture", instanceGeneration: 1,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Workspace", workspaceRoot: process.cwd(), managed: false, trusted: true });
  for (const id of ["task-a", "task-b"]) store.createSession({ id, backendId: "backend", targetId: "target", title: id,
    binding: { opaqueRef: `native/${id}`, generation: 1 }, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const connections = new ConnectionManager(store, { now: () => 1_000, maxPairingRequests: 100 });
  const application = { config: { publicOrigin: "http://127.0.0.1:4318" }, store, connections,
    artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {}, sessionHost: {}, scheduler: {}, adapters: [], browserActivity: [], close: async () => {} } as unknown as OrchestratorApplication;
  const client = (shutdown?: AbortSignal) => createClient(TaskActivityService, createRouterTransport(router =>
    router.service(TaskActivityService, createConnectServices(application, shutdown).taskActivity)));
  const pair = (id: string, kind: "desktop" | "mobile" | "web" = "web") => {
    const challenge = connections.issuePairing(id, { id, defaultName: id, kind });
    return connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: id });
  };
  const watch = (who: ReturnType<typeof pair>, ids: string[], api = client()) => {
    const abort = new AbortController(), states: TaskActivityState[] = [], errors: unknown[] = [];
    let done = false;
    const running = (async () => {
      try { for await (const response of api.watchTaskActivity({ viewedSessionIds: ids }, { signal: abort.signal, headers: { authorization: `Bearer ${who.authKey}` } })) {
        if (response.state) states.push(response.state);
      } } catch (error) { if (!abort.signal.aborted) errors.push(error); }
      finally { done = true; }
    })();
    const close = async () => { abort.abort(); await running; }; cleanup.push(close);
    return { states, errors, close, get last() { return states.at(-1); }, get done() { return done; } };
  };
  return { store, connections, client, pair, watch };
}

describe("authenticated task-page activity", () => {
  it("separates list observers from actual task pages and deduplicates independently releasable panes and connections", async () => {
    const f = fixture(), owner = f.pair("owner"), remote = f.pair("phone", "mobile"), sameDevice = f.pair("phone", "mobile");
    const observer = f.watch(owner, []); await vi.waitFor(() => expect(observer.last?.activeDevices).toEqual([]));
    const cursor = f.store.health().globalCursor;
    const first = f.watch(remote, ["task-a"]), second = f.watch(sameDevice, ["task-b"]);
    await vi.waitFor(() => expect(second.last?.activeDevices.map(d => d.deviceId)).toEqual(["phone"]));
    await vi.waitFor(() => expect(observer.last?.activeDevices.map(d => d.deviceId)).toEqual(["phone"]));
    expect(f.store.health().globalCursor).toBe(cursor);
    expect(observer.last?.generation).toBeGreaterThan(0n);
    expect(Object.keys(observer.last!.activeDevices[0]!).sort()).toEqual(["$typeName", "deviceId", "displayName"]);
    await first.close(); expect(f.connections.taskActivity.snapshot().activeDevices).toHaveLength(1);
    await second.close(); await vi.waitFor(() => expect(observer.last?.activeDevices).toEqual([]));
    expect(observer.states.map(state => state.revision)).toEqual([...observer.states.map(state => state.revision)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    expect(observer.errors).toEqual([]);
  });

  it("excludes only the committed local Desktop host and includes a separately paired Desktop", async () => {
    const f = fixture();
    const local = f.connections.issueTrustedDesktopConnection({ desktopInstanceId: "4e56f4d8-c6ee-4a17-9a89-56e059b7e592",
      desktopDeviceId: "d6a365ef-ef33-4fb7-a0f1-a02eb57fef75", defaultDeviceName: "Local Desktop", platform: "win32", appVersion: "0.1.0", desktopHostAuthKey: "h".repeat(43) });
    f.connections.confirmTrustedDesktopConnection(local.connection.id, local.authKey);
    const observer = f.watch(local, ["task-a"]); await vi.waitFor(() => expect(observer.last?.activeDevices).toEqual([]));
    const remote = f.pair("remote-desktop", "desktop"), view = f.watch(remote, ["task-b"]);
    await vi.waitFor(() => expect(view.last?.activeDevices.map(d => d.deviceId)).toEqual(["remote-desktop"]));
    await vi.waitFor(() => expect(observer.last?.activeDevices.map(d => d.deviceId)).toEqual(["remote-desktop"]));
  });

  it("updates actual Device names and closes every revoked connection without retiring another Device", async () => {
    const f = fixture(), observer = f.watch(f.pair("observer"), []), a = f.pair("a"), anotherA = f.pair("a"), b = f.pair("b");
    const av = f.watch(a, ["task-a"]), a2v = f.watch(anotherA, ["task-b"]), bv = f.watch(b, ["task-a"]);
    await vi.waitFor(() => expect(observer.last?.activeDevices).toHaveLength(2));
    f.store.renameDevice("a", "Renamed phone");
    await vi.waitFor(() => expect(observer.last?.activeDevices[0]?.displayName).toBe("Renamed phone"));
    f.connections.revokeDevice("a");
    await vi.waitFor(() => expect(observer.last?.activeDevices.map(d => d.deviceId)).toEqual(["b"]));
    await vi.waitFor(() => expect(av.done && a2v.done).toBe(true)); expect(bv.done).toBe(false);
    expect(() => f.connections.taskActivity.open(a.connection, ["task-a"])).toThrow(/revoked/u);
  });

  it("retires deleted tasks and all views on transport shutdown, while new streams observe the latest state", async () => {
    const f = fixture(), owner = f.pair("owner"), remote = f.pair("remote"), shutdown = new AbortController();
    const observer = f.watch(owner, []), view = f.watch(remote, ["task-a"], f.client(shutdown.signal));
    await vi.waitFor(() => expect(observer.last?.activeDevices).toHaveLength(1));
    f.store.updateSession("task-a", { deletedAt: 2_000 });
    await vi.waitFor(() => expect(observer.last?.activeDevices).toEqual([]));
    const next = f.watch(remote, ["task-b"], f.client(shutdown.signal));
    await vi.waitFor(() => expect(observer.last?.activeDevices).toHaveLength(1));
    shutdown.abort(); await vi.waitFor(() => expect(view.done && next.done).toBe(true));
    await vi.waitFor(() => expect(observer.last?.activeDevices).toEqual([]));
    const reconnected = f.watch(remote, []); await vi.waitFor(() => expect(reconnected.last?.activeDevices).toEqual([]));
    expect(reconnected.last!.revision).toBeGreaterThan(0n);
  });

  it("rejects unauthenticated, unknown, deleted and invalid views before publishing any lease", async () => {
    const f = fixture(), remote = f.pair("remote"), api = f.client();
    const read = async (ids: string[], authKey = remote.authKey) => {
      for await (const _ of api.watchTaskActivity({ viewedSessionIds: ids }, { headers: { authorization: `Bearer ${authKey}` } })) throw new Error("Unexpected projection");
    };
    await expect(read([], "task-share-guest-proof")).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(read(["missing"])).rejects.toMatchObject({ code: Code.NotFound });
    await expect(read(["task-a", "task-a"])).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(read(Array.from({ length: 17 }, (_, i) => `task-${i}`))).rejects.toMatchObject({ code: Code.InvalidArgument });
    f.store.updateSession("task-a", { deletedAt: 2_000 });
    await expect(read(["task-a"])).rejects.toMatchObject({ code: Code.NotFound });
    expect(f.connections.taskActivity.snapshot().activeDevices).toEqual([]);
  });
});
