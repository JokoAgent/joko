// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "./controller.js";
import type { CollaborationGoalTreeView, CollaborationGoalView, InteractionView, SessionAttentionView, SessionView } from "./model.js";
import type { DedicatedHardwareTaskCatalog } from "./dedicated-hardware.js";
import { foldDedicatedHardwareCollaborationActivity, useDedicatedHardwareCollaborationCatalog,
  type DedicatedHardwareCollaborationSource } from "./dedicated-hardware-collaboration.js";

const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("dedicated hardware collaboration activity", () => {
  it("folds only the strongest actual worker relation at exact lead and worker generations", () => {
    const lead = session("lead", "idle");
    const running = session("running", "running");
    const stale = { ...session("stale", "error"), generation: 2n };
    const source = catalog([lead]);
    const relations = [{ lead: { sessionId: lead.id, sessionGeneration: "1" }, workers: [
      { sessionId: running.id, sessionGeneration: "1" }, { sessionId: stale.id, sessionGeneration: "1" }
    ] }];
    const folded = foldDedicatedHardwareCollaborationActivity(source, relations, [lead, running, stale], []);
    expect(folded.tasks[0]?.activity).toEqual({ phase: "running", attention: false });
    expect(folded.tasks[0]?.sessionId).toBe("lead");
    expect(foldDedicatedHardwareCollaborationActivity(source, relations, [lead, { ...running, archived: true }, stale], [])).toBe(source);
    expect(foldDedicatedHardwareCollaborationActivity(source, relations, [{ ...lead, generation: 2n }, running], [])).toBe(source);
    const waiting = question(running);
    expect(foldDedicatedHardwareCollaborationActivity(source, relations, [lead, running], [waiting]).tasks[0]?.activity)
      .toEqual({ phase: "needs-interaction", attention: false });
  });

  it("reuses relation queries for live activity and immediately rejects a changed worker generation", async () => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "running");
    const list = vi.fn(async () => [goal(lead)]);
    const get = vi.fn(async () => tree(lead, worker));
    const initial = owner([lead, worker], list, get);
    let state = initial.state;
    const controller = { ...initial, get state() { return state; } };
    let value: DedicatedHardwareTaskCatalog | undefined;
    const root = await mount(<Harness controller={controller} source={catalog([lead])} receive={(next) => { value = next; }} />);
    expect(value?.tasks[0]?.activity.phase).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(value?.tasks[0]?.activity.phase).toBe("running");
    const interaction = question(worker);
    state = { ...state, snapshot: { ...state.snapshot, interactions: [interaction] } };
    await act(async () => root.render(<Harness controller={controller} source={{ ...catalog([lead]), snapshotRevision: "2" }} receive={(next) => { value = next; }} />));
    expect(value?.tasks[0]?.activity.phase).toBe("needs-interaction");
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    state = { ...state, snapshot: { ...state.snapshot, sessions: [lead, { ...worker, generation: 2n }] } };
    await act(async () => root.render(<Harness controller={controller} source={catalog([lead])} receive={(next) => { value = next; }} />));
    expect(value?.tasks[0]?.activity.phase).toBeNull();
  });

  it.each([
    { change: "phase", expected: "running" },
    { change: "interaction", expected: "needs-interaction" },
    { change: "interaction-identity", expected: "needs-interaction" },
    { change: "attention", expected: "completed" }
  ] as const)("refreshes a new worker relation after a same-scope $change change within 250 ms", async ({ change, expected }) => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "idle");
    let available = false;
    const list = vi.fn(async () => available ? [goal(lead)] : []);
    const get = vi.fn(async () => tree(lead, worker));
    const initial = owner([lead, worker], list, get);
    let state = change === "interaction-identity"
      ? { ...initial.state, snapshot: { ...initial.state.snapshot, interactions: [question(worker)] } } : initial.state;
    const controller = { ...initial, get state() { return state; } };
    let value: DedicatedHardwareTaskCatalog | undefined;
    const receive = (next: DedicatedHardwareTaskCatalog | undefined) => { value = next; };
    const root = await mount(<Harness controller={controller} source={catalog([lead])} receive={receive} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(value?.tasks[0]?.activity.phase).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();

    available = true;
    const changed = change === "phase" ? { ...worker, state: "running" as const }
      : change === "attention" ? { ...worker, attention: unreadAttention("done") } : worker;
    state = { ...state, snapshot: { ...state.snapshot, sessions: [lead, changed],
      interactions: change === "interaction" ? [question(worker)]
        : change === "interaction-identity" ? [{ ...question(worker), id: "replacement-question" }] : [] } };
    await act(async () => root.render(<Harness controller={controller} source={catalog([lead])} receive={receive} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(value?.tasks[0]?.activity.phase).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(value?.tasks[0]?.activity.phase).toBe(expected);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not query for ordinary facade snapshots, titles, revisions, stale interactions or folded output", async () => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "running");
    const list = vi.fn(async () => [goal(lead)]);
    const get = vi.fn(async () => tree(lead, worker));
    const initial = owner([lead, worker], list, get);
    let state = initial.state;
    const controller = { ...initial, get state() { return state; } };
    let value: DedicatedHardwareTaskCatalog | undefined;
    const receive = (next: DedicatedHardwareTaskCatalog | undefined) => { value = next; };
    const root = await mount(<Harness controller={controller} source={catalog([lead])} receive={receive} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(value?.tasks[0]?.activity.phase).toBe("running");
    const renamed = { ...lead, name: "Renamed lead", updatedAt: 123 };
    state = { ...state, snapshot: { ...state.snapshot, sessions: [renamed, { ...worker }],
      interactions: [{ ...question(worker), generation: 2n }, question(session("missing", "idle"))] } };
    await act(async () => root.render(<Harness controller={controller} source={{ ...catalog([renamed]), snapshotRevision: "2" }} receive={receive} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(value?.tasks[0]?.title).toBe("Renamed lead");
    expect(value?.tasks[0]?.activity.phase).toBe("running");
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("coalesces an in-flight activity burst into one immediate follow-up with the latest worker generation", async () => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "idle");
    let resolve: ((value: CollaborationGoalTreeView) => void) | undefined;
    let currentWorker = worker;
    const list = vi.fn(async () => [goal(lead)]);
    let requests = 0;
    const get = vi.fn(() => ++requests === 1
      ? new Promise<CollaborationGoalTreeView>((done) => { resolve = done; }) : Promise.resolve(tree(lead, currentWorker)));
    const initial = owner([lead, worker], list, get);
    let state = initial.state;
    const controller = { ...initial, get state() { return state; } };
    let value: DedicatedHardwareTaskCatalog | undefined;
    const receive = (next: DedicatedHardwareTaskCatalog | undefined) => { value = next; };
    const root = await mount(<Harness controller={controller} source={catalog([lead])} receive={receive} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(get).toHaveBeenCalledTimes(1);
    currentWorker = { ...worker, state: "running" };
    state = { ...state, snapshot: { ...state.snapshot, sessions: [lead, currentWorker] } };
    await act(async () => root.render(<Harness controller={controller} source={catalog([lead])} receive={receive} />));
    state = { ...state, snapshot: { ...state.snapshot, interactions: [question(currentWorker)] } };
    await act(async () => root.render(<Harness controller={controller} source={{ ...catalog([lead]), snapshotRevision: "2" }} receive={receive} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    currentWorker = { ...worker, generation: 3n, state: "error", attention: unreadAttention("error") };
    state = { ...state, snapshot: { ...state.snapshot, sessions: [lead, currentWorker], interactions: [] } };
    await act(async () => root.render(<Harness controller={controller} source={{ ...catalog([lead]), snapshotRevision: "3" }} receive={receive} />));
    await act(async () => { resolve?.(tree(lead, worker)); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(value?.tasks[0]?.activity).toEqual({ phase: "error", attention: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("retires a queued activity refresh and drops late relationship results after pagehide", async () => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "running");
    let resolve: ((value: CollaborationGoalTreeView) => void) | undefined;
    const get = vi.fn(() => new Promise<CollaborationGoalTreeView>((done) => { resolve = done; }));
    const list = vi.fn(async () => [goal(lead)]);
    const initial = owner([lead, { ...worker, state: "idle" }], list, get);
    let state = initial.state;
    const controller = { ...initial, get state() { return state; } };
    let value: DedicatedHardwareTaskCatalog | undefined;
    const receive = (next: DedicatedHardwareTaskCatalog | undefined) => { value = next; };
    const root = await mount(<Harness controller={controller} source={catalog([lead])} receive={receive} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    state = { ...state, snapshot: { ...state.snapshot, sessions: [lead, worker] } };
    await act(async () => root.render(<Harness controller={controller} source={catalog([lead])} receive={receive} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); resolve?.(tree(lead, worker)); });
    expect(value?.tasks[0]?.activity.phase).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rotates the per-round RPC budget across all visible leads", async () => {
    vi.useFakeTimers();
    const leads = Array.from({ length: 100 }, (_, index) => session(`lead-${index}`, "idle"));
    const seen = new Set<string>();
    const list = vi.fn(async (id: string) => { seen.add(id); return [goal(leads.find((lead) => lead.id === id)!)]; });
    const get = vi.fn(async (_id: string, leadId: string) => ({ goal: goal(leads.find((lead) => lead.id === leadId)!), workers: [], queue: [] }));
    const controller = owner(leads, list, get);
    await mount(<Harness controller={controller} source={catalog(leads)} receive={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(list.mock.calls.length + get.mock.calls.length).toBe(128);
    expect(seen.size).toBe(64);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(list.mock.calls.length + get.mock.calls.length).toBe(256);
    expect(seen.size).toBe(100);
  });

  it("advances by actually attempted leads when the round deadline aborts slow queries", async () => {
    vi.useFakeTimers();
    const leads = Array.from({ length: 64 }, (_, index) => session(`lead-${String(index).padStart(2, "0")}`, "idle"));
    const list = vi.fn((_id: string) => new Promise<readonly CollaborationGoalView[]>(() => undefined));
    await mount(<Harness controller={owner(leads, list, vi.fn(async () => tree(leads[0]!, leads[1]!)))} source={catalog(leads)} receive={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(list.mock.calls.map(([id]) => id)).toEqual(leads.slice(0, 4).map((lead) => lead.id));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(list.mock.calls.map(([id]) => id)).toEqual(leads.slice(0, 8).map((lead) => lead.id));
  });

  it("retires an old source instance even when all connection identities are unchanged", async () => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "running");
    let resolve: ((value: CollaborationGoalTreeView) => void) | undefined;
    const old = owner([lead, worker], vi.fn(async () => [goal(lead)]), vi.fn(() =>
      new Promise<CollaborationGoalTreeView>((done) => { resolve = done; })));
    let value: DedicatedHardwareTaskCatalog | undefined;
    const receive = (next: DedicatedHardwareTaskCatalog | undefined) => { value = next; };
    const root = await mount(<Harness controller={old} source={catalog([lead])} receive={receive} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const replacement = owner([lead, worker], vi.fn(async () => []), vi.fn(async () => tree(lead, worker)));
    await act(async () => {
      root.render(<Harness controller={replacement} source={catalog([lead])} receive={receive} />);
      resolve?.(tree(lead, worker));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(value?.tasks[0]?.activity.phase).toBeNull();
    expect(replacement.getCollaborationGoal).not.toHaveBeenCalled();
  });

  it("removes a cached relation as soon as the listed goal revision changes", async () => {
    vi.useFakeTimers();
    const lead = session("lead", "idle");
    const worker = session("worker", "running");
    let revision = 1n;
    const list = vi.fn(async () => [{ ...goal(lead), revision }]);
    const get = vi.fn(() => revision === 1n ? Promise.resolve(tree(lead, worker))
      : new Promise<CollaborationGoalTreeView>(() => undefined));
    let value: DedicatedHardwareTaskCatalog | undefined;
    await mount(<Harness controller={owner([lead, worker], list, get)} source={catalog([lead])} receive={(next) => { value = next; }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(value?.tasks[0]?.activity.phase).toBe("running");
    revision = 2n;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(value?.tasks[0]?.activity.phase).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

function Harness({ controller, source, receive }: { readonly controller: DedicatedHardwareCollaborationSource; readonly source: DedicatedHardwareTaskCatalog;
  readonly receive: (value: DedicatedHardwareTaskCatalog | undefined) => void }) {
  const value = useDedicatedHardwareCollaborationCatalog(controller, source);
  useEffect(() => receive(value), [receive, value]);
  return null;
}

async function mount(node: React.ReactNode): Promise<Root> {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => root.render(node));
  return root;
}

function session(id: string, state: SessionView["state"]): SessionView {
  return { id, backendId: "backend", targetId: "target", name: id, state, generation: 1n, pinned: false, archived: false,
    fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 0 };
}

function question(session: SessionView): InteractionView {
  return { id: "question", sessionId: session.id, generation: session.generation, kind: "question",
    title: "Question", message: "", options: [], fields: [], planSteps: [], createdAt: 0 };
}

function unreadAttention(kind: SessionAttentionView["kind"]): SessionAttentionView {
  const cursor = { opaqueToken: "cursor", sequence: 1n, generation: 1n };
  return { kind, unread: true, subjectCursor: cursor, attentionCursor: cursor, readThroughCursor: cursor, updatedAt: 0 };
}

function catalog(sessions: readonly SessionView[]): DedicatedHardwareTaskCatalog {
  return { version: 1, profileId: "profile", serverId: "server", connectionGeneration: "1", snapshotRevision: "1",
    tasks: sessions.map((session, index) => ({ sessionId: session.id, sessionGeneration: session.generation.toString(), targetId: session.targetId,
      title: session.name, pinned: false, userSendAt: null, sidebarOrder: index, catalogEligible: true, priorityRank: null,
      activity: { phase: null, attention: false } })) };
}

function goal(lead: SessionView): CollaborationGoalView {
  return { id: `goal-${lead.id}`, revision: 1n, leadId: "lead-id", leadSessionId: lead.id, backendId: lead.backendId,
    targetId: lead.targetId, sessionGeneration: lead.generation, backendInstanceGeneration: 1n, title: "Goal", objective: "",
    status: "active", createdAt: 0, updatedAt: 0 };
}

function tree(lead: SessionView, worker: SessionView): CollaborationGoalTreeView {
  return { goal: goal(lead), workers: [{ id: "worker-id", revision: 1n, goalId: goal(lead).id, sessionId: worker.id,
    sessionGeneration: worker.generation, backendInstanceGeneration: 1n,
    route: { backendId: worker.backendId, targetId: worker.targetId, fastMode: false, permissionMode: "ask", planMode: false },
    label: "Worker", role: "", assignment: "", status: "running", focused: false, runtimeReleased: false,
    softLimitWarning: false, createdAt: 0, updatedAt: 0 }], queue: [] };
}

function owner(sessions: readonly SessionView[], list: AppController["listCollaborationGoals"], get: AppController["getCollaborationGoal"]): DedicatedHardwareCollaborationSource {
  return { state: { ready: true, connectionState: "connected", connectionGeneration: 1, activeProfile: { id: "profile", serverId: "server" },
    snapshot: { generation: 1n, sessions, interactions: [] } }, listCollaborationGoals: list, getCollaborationGoal: get };
}
