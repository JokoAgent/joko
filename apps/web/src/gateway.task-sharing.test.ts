import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActorKind, GitSafetyMode, JoinedTaskShareSchema, OperationState, SessionState, EventSchema, EventCursorSchema, MessageRole,
  SnapshotSchema, TaskShareSnapshotSchema, TaskShareMethod, taskShareMethodDescriptor, type TaskSharingApi
} from "@joko/contracts";
import { createTaskSharingGateway, type GatewayCallbacks, type OrchestratorGateway } from "./gateway.js";
import { createJoinedTaskPort } from "./task-sharing-api.js";
import type { AppSnapshot } from "./model.js";

const gateways: OrchestratorGateway[] = [];
afterEach(() => { for (const gateway of gateways.splice(0)) gateway.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const joined = create(JoinedTaskShareSchema, { joinId: "joined", status: "active", share: { shareId: "share", shareGeneration: 2n, sessionId: "task", hostServerId: "host", hostOrigin: "https://host.example", status: "active" }, member: { memberId: "member", memberGeneration: 3n, displayName: "Guest", status: "active" } });
function fixture(initial: readonly string[] = [], status = "active", callbacks: GatewayCallbacks = {}) {
  const snapshot = create(SnapshotSchema, { server: { serverId: "host" }, generation: 1n, resumeCursor: { generation: 1n, sequence: 0n },
    scope: { kind: { case: "session", value: { sessionId: "task" } } },
    sessions: [{ sessionId: "task", backendId: "backend", state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 1n }, version: { generation: 1n, revision: { value: 1n } }, location: { kind: { case: "serviceNode", value: {} } } }],
  });
  let submitFailure = true, lookup: "offline" | "absent" | "receipt" | "foreign" = "offline";
  const operations = new Set(initial);
  const journal = { pending: vi.fn(async () => [...operations]), begin: vi.fn(async (id: string) => { operations.add(id); }), finish: vi.fn(async (id: string) => { operations.delete(id); }) };
  const fresh = create(TaskShareSnapshotSchema, { share: joined.share, member: joined.member, snapshot });
  const api = { snapshot: vi.fn().mockResolvedValue(fresh),
    events: vi.fn(), invoke: vi.fn(async (_joinId, method: TaskShareMethod, input: { operationId?: string }) => {
      const descriptor = taskShareMethodDescriptor(method);
      if (method === TaskShareMethod.GET_RUNTIME_CONTROL) return create(descriptor.output, { control: { generation: 1n } } as never);
      if (method === TaskShareMethod.SUBMIT_OPERATION && submitFailure) throw new ConnectError("Response lost", Code.Unavailable);
      if (method === TaskShareMethod.GET_OPERATION && lookup === "offline") throw new ConnectError("Offline", Code.Unavailable);
      if (method === TaskShareMethod.GET_OPERATION && lookup === "absent") throw new ConnectError("Not admitted", Code.NotFound);
      return create(descriptor.output, { operation: { operationId: input.operationId, connectionId: "", state: OperationState.SUCCEEDED,
        actor: { kind: ActorKind.TASK_PARTICIPANT, id: "member" }, sharedTaskAuthor: { shareId: "share", shareGeneration: 2n, sessionId: "task", memberId: "member", memberGeneration: lookup === "foreign" ? 4n : 3n, displayName: "Guest" } } } as never);
    }) } as unknown as TaskSharingApi;
  const gateway = createTaskSharingGateway({ id: "home", deviceId: "device", serverId: "home-server", name: "Home", origin: "https://home.example" }, callbacks, createJoinedTaskPort(api, create(JoinedTaskShareSchema, { ...joined, status }), new AbortController().signal, journal));
  gateways.push(gateway);
  return { gateway, api, journal, operations, fresh, setLookup: (value: typeof lookup) => { lookup = value; }, allowSubmit: () => { submitFailure = false; } };
}
describe("guest gateway operation recovery", () => {
  it("projects the Host's canonical author after a finite batch requires a history snapshot refresh, without resending input", async () => {
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const seen: AppSnapshot[] = [], f = fixture([], "active", { onSnapshot: snapshot => { seen.push(snapshot); } });
    let publish!: (batch: Awaited<ReturnType<TaskSharingApi["events"]>>) => void;
    vi.mocked(f.api.events).mockImplementationOnce(() => new Promise(resolve => { publish = resolve; })).mockResolvedValue({ events: [], generation: 1n, resyncRequired: false } as never);
    f.allowSubmit(); await f.gateway.connect();
    await f.gateway.send("task", { text: "Guest input", deliveryMode: "prompt", attachments: [], mentions: [] }, { expectedGeneration: 1n });
    const author = { shareId: "share", shareGeneration: 2n, sessionId: "task", memberId: "member", memberGeneration: 3n, displayName: "Guest" };
    const live = create(EventSchema, { eventId: "live", identity: { sessionId: "task", generation: 1n }, cursor: { generation: 1n, sequence: 11n },
      payload: { kind: { case: "messageStarted", value: { messageId: "live-message", role: MessageRole.USER, userInputAccepted: true, sharedTaskAuthor: author, userInput: { parts: [{ content: { case: "text", value: "Guest input" } }] } } } } });
    f.fresh.snapshot!.timeline = [create(EventSchema, { eventId: "canonical", identity: { sessionId: "task", generation: 1n }, cursor: { generation: 1n, sequence: 21n },
      payload: { kind: { case: "messageStarted", value: { messageId: "native-user", nativeIdentity: { entryId: "native-user" }, role: MessageRole.USER, sharedTaskAuthor: author,
        userInput: { parts: [{ content: { case: "text", value: "Guest input" } }] } } } } }),
      create(EventSchema, { eventId: "reply", identity: { sessionId: "task", generation: 1n }, cursor: { generation: 1n, sequence: 23n },
        payload: { kind: { case: "messageCompleted", value: { messageId: "native-reply", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "Host reply" } }] } } } })];
    f.fresh.snapshot!.resumeCursor = create(EventCursorSchema, { generation: 1n, sequence: 23n });
    publish({ events: [live], generation: 1n, resyncRequired: false, resumeCursor: create(EventCursorSchema, { generation: 1n, sequence: 23n }) } as never);
    await vi.waitFor(() => expect(seen.at(-1)?.timelineBySession.get("task")?.find(item => item.id === "native-user")).toMatchObject({ text: "Guest input", sharedTaskAuthor: author }));
    expect(seen.at(-1)?.timelineBySession.get("task")?.find(item => item.messageId === "native-reply" && item.kind === "assistant")?.text).toBe("Host reply");
    expect(vi.mocked(f.api.invoke).mock.calls.filter(call => call[1] === TaskShareMethod.SUBMIT_OPERATION)).toHaveLength(1);
    f.gateway.disconnect();
  });
  it("admits a disconnected directory entry only after a fresh authenticated snapshot, without replaying a write", async () => {
    const f = fixture([], "disconnected"); let resolve!: (state: typeof f.fresh) => void;
    vi.mocked(f.api.snapshot).mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const connecting = f.gateway.connect({ snapshotOnly: true });
    await expect(f.gateway.setSharedTaskRuntime("task", { effort: "xhigh" })).rejects.toThrow("unavailable");
    expect(f.api.invoke).not.toHaveBeenCalled(); expect(f.journal.begin).not.toHaveBeenCalled();
    resolve(f.fresh); await connecting;
    expect(f.api.invoke).not.toHaveBeenCalled();
    f.allowSubmit(); f.setLookup("receipt"); await f.gateway.setSharedTaskRuntime("task", { effort: "xhigh" });
    expect(vi.mocked(f.api.invoke).mock.calls.filter(call => call[1] === TaskShareMethod.SUBMIT_OPERATION)).toHaveLength(1);
    const failed = fixture([], "disconnected"); vi.mocked(failed.api.snapshot).mockRejectedValueOnce(new ConnectError("Offline", Code.Unavailable));
    await expect(failed.gateway.connect({ snapshotOnly: true })).rejects.toMatchObject({ offline: true, cause: { code: Code.Unavailable } });
    await expect(failed.gateway.setSharedTaskRuntime("task", { effort: "off" })).rejects.toThrow("unavailable");
    expect(failed.api.invoke).not.toHaveBeenCalled(); expect(failed.journal.begin).not.toHaveBeenCalled();
  });
  it("observes finite batches with one flight and no reads while the document is hidden", async () => {
    vi.useFakeTimers(); const document = { visibilityState: "visible" }; vi.stubGlobal("document", document);
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const f = fixture();
    vi.mocked(f.api.events).mockResolvedValue({ generation: 1n, events: [], resyncRequired: false, resumeCursor: { generation: 1n, sequence: 0n } } as never);
    await f.gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(f.api.events).toHaveBeenCalledOnce();
    document.visibilityState = "hidden"; await vi.advanceTimersByTimeAsync(10_000);
    expect(f.api.events).toHaveBeenCalledOnce();
    document.visibilityState = "visible"; await vi.advanceTimersByTimeAsync(500);
    expect(f.api.events).toHaveBeenCalledTimes(2);
    f.gateway.disconnect(); await vi.advanceTimersByTimeAsync(10_000); expect(f.api.events).toHaveBeenCalledTimes(2);
  });
  it("retains a finite-batch retry failure until the current guest request succeeds, including an empty batch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const states: string[] = [], errors: string[] = [];
    const f = fixture([], "active", { onState: state => states.push(state), onError: error => errors.push(error.message) });
    let reopen!: (batch: Awaited<ReturnType<TaskSharingApi["events"]>>) => void;
    vi.mocked(f.api.events).mockRejectedValueOnce(new ConnectError("Guest events offline", Code.Unavailable))
      .mockImplementationOnce(() => new Promise(resolve => { reopen = resolve; }));
    await f.gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    const established = states.filter(state => state === "connected").length;
    expect(states.at(-1)).toBe("offline");
    await vi.advanceTimersByTimeAsync(350);
    expect(f.api.events).toHaveBeenCalledTimes(2); expect(states.at(-1)).toBe("offline");
    expect(errors.at(-1)).toBe("Guest events offline");
    expect(states.filter(state => state === "connected")).toHaveLength(established);
    reopen({ generation: 1n, events: [], resyncRequired: false, resumeCursor: create(EventCursorSchema, { generation: 1n, sequence: 0n }) } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("connected");
    expect(states.filter(state => state === "connected")).toHaveLength(established + 1);
    f.gateway.disconnect(); await vi.advanceTimersByTimeAsync(0);
  });
  it("does not resubmit an uncertain guest mutation, fences later writes and only clears authenticated absence", async () => {
    const f = fixture(); await f.gateway.connect({ snapshotOnly: true });
    await expect(f.gateway.setSharedTaskRuntime("task", { effort: "xhigh" })).rejects.toMatchObject({ code: Code.Unavailable });
    expect(vi.mocked(f.api.invoke).mock.calls.filter(call => call[1] === TaskShareMethod.SUBMIT_OPERATION)).toHaveLength(1);
    expect(f.operations.size).toBe(1);
    await expect(f.gateway.setSharedTaskRuntime("task", { effort: "off" })).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    f.setLookup("foreign"); await expect(f.gateway.recoverSharedTaskOperations()).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(f.operations.size).toBe(1);
    f.setLookup("absent"); await f.gateway.recoverSharedTaskOperations(); expect(f.operations.size).toBe(0);
    expect(vi.mocked(f.api.invoke).mock.calls.filter(call => call[1] === TaskShareMethod.SUBMIT_OPERATION)).toHaveLength(1);
    f.allowSubmit(); f.setLookup("receipt"); await f.gateway.setSharedTaskRuntime("task", { effort: "off" });
    expect(vi.mocked(f.api.invoke).mock.calls.filter(call => call[1] === TaskShareMethod.SUBMIT_OPERATION)).toHaveLength(2);
    expect(f.operations.size).toBe(0);
  });
  it("restores pending ids before opening mutation admission and reconciles by exact original read", async () => {
    const f = fixture(["00000000-0000-4000-8000-000000000001"]); f.setLookup("receipt");
    await f.gateway.connect({ snapshotOnly: true });
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith("00000000-0000-4000-8000-000000000001");
    expect(vi.mocked(f.api.invoke).mock.calls.map(call => call[1])).toEqual([TaskShareMethod.GET_OPERATION]);
    expect(f.operations.size).toBe(0);
  });
});
