import { create, toBinary } from "@bufbuild/protobuf";
import {
  CapabilitySupport, ConnectionSchema, ConnectionState, DeviceKind, DeviceSchema, OperationSchema,
  EventCursorSchema, EventSchema, MessageRole, OperationMutationSchema, OperationState, SessionState, SnapshotSchema, TargetState, capabilityNames
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileClient, type MobileStorage, type PendingOperation } from "./mobile-client";
import { normalizeNodeOrigin, type MobileNetwork, type PairedCredential } from "./network";
import type { Event } from "@joko/contracts";
import { timelineRows } from "./timeline";

const credential: PairedCredential = {
  origin: "http://192.168.1.20:4318", serverId: "node-1", connectionId: "mobile-connection",
  deviceId: "mobile-device", displayName: "Phone", authKey: "private-key"
};
const node = { serverId: "node-1", displayName: "Joko", pairingEnabled: true };
const snapshot = create(SnapshotSchema, {
  generation: 1n, resumeCursor: { opaqueToken: "cursor-10", sequence: 10n, generation: 1n },
  server: { serverId: node.serverId, displayName: node.displayName, apiVersion: "1" },
  backends: [{ backendId: "backend", displayName: "Backend", capabilities: {
    capabilities: [{ name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }]
  } }],
  targets: [{ targetId: "target", backendId: "backend", displayName: "Project", state: TargetState.ACTIVE,
    version: { revision: { value: 3n } } }],
  sessions: [{ sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task", state: SessionState.IDLE,
    nativeBinding: { runtimeGeneration: 8n } }]
});
const connection = create(ConnectionSchema, { connectionId: credential.connectionId, deviceId: credential.deviceId, state: ConnectionState.CONNECTED });
const device = create(DeviceSchema, { deviceId: credential.deviceId, kind: DeviceKind.MOBILE });

function memoryStorage(saved?: PairedCredential, automatic = saved !== undefined) {
  let key = saved;
  let automaticEntry = automatic;
  let pending: PendingOperation[] = [];
  let selection: string | undefined = saved ? "session" : undefined;
  const storage: MobileStorage = {
    loadCredential: vi.fn(async () => key), saveCredential: vi.fn(async (value) => { key = value; }),
    clearCredential: vi.fn(async () => { key = undefined; }),
    loadAutomaticEntry: vi.fn(async () => automaticEntry),
    saveAutomaticEntry: vi.fn(async (enabled) => { automaticEntry = enabled; }),
    loadPending: vi.fn(async () => pending), savePending: vi.fn(async (items) => { pending = [...items]; }),
    loadSelection: vi.fn(async () => selection), saveSelection: vi.fn(async (id) => { selection = id; })
  };
  return { storage, key: () => key, automatic: () => automaticEntry, pending: () => pending };
}

function fakeNetwork(): MobileNetwork {
  return {
    inspect: vi.fn(async () => node),
    requestPairing: vi.fn(async () => ({ challengeId: "challenge", identity: node })),
    completePairing: vi.fn(async () => ({ credential, identity: node })),
    readOwner: vi.fn(async () => ({ connection, device, snapshot })),
    readSession: vi.fn(async () => snapshot),
    readHistory: vi.fn(async () => ({ events: [], before: undefined })),
    readAround: vi.fn(async () => []),
    streamOwner: vi.fn(async function* (_credential, _after, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    prepareTarget: vi.fn(async () => undefined),
    submit: vi.fn(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      return create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
      });
    }),
    getOperation: vi.fn(async () => undefined)
  };
}

function event(id: string, sequence: bigint, sessionId = "session"): Event {
  return create(EventSchema, { eventId: id, identity: { sessionId },
    cursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 1n },
    payload: { kind: { case: "statusStream", value: { label: id } } } });
}

function eventFeed(network: MobileNetwork) {
  const queued: Event[] = [];
  let wake: (() => void) | undefined;
  network.streamOwner = vi.fn(async function* (_credential, _after, signal) {
    while (!signal.aborted) {
      if (!queued.length) await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
      if (signal.aborted) return;
      const next = queued.shift();
      if (next) yield next;
    }
  });
  return (item: Event) => { queued.push(item); wake?.(); wake = undefined; };
}

const clients: MobileClient[] = [];
function client(network: MobileNetwork, storage: MobileStorage) {
  const instance = new MobileClient(network, storage, () => "operation-1", "android");
  clients.push(instance);
  return instance;
}
afterEach(() => { for (const item of clients.splice(0)) item.dispose(); });

describe("native mobile connection and operation ownership", () => {
  it("rejects public cleartext origins and never places credentials in an origin", () => {
    expect(normalizeNodeOrigin("http://192.168.1.20:4318/")).toBe("http://192.168.1.20:4318");
    expect(() => normalizeNodeOrigin("http://example.com")).toThrow(/private-network/);
    expect(() => normalizeNodeOrigin("https://user:secret@example.com")).toThrow(/without credentials/);
    expect(() => normalizeNodeOrigin("https://example.com/path")).toThrow(/only the Joko node origin/);
  });

  it("probes identity anonymously before a credentialed read and clears a drifted pairing", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    expect(network.inspect).toHaveBeenCalledBefore(network.readOwner as ReturnType<typeof vi.fn>);
    expect(app.state.status).toBe("connected");
    vi.mocked(network.inspect).mockResolvedValueOnce({ ...node, serverId: "other-node" });
    await app.refresh();
    expect(app.state.status).toBe("revoked");
    expect(saved.key()).toBeUndefined();
    expect(app.state.owner).toBeUndefined();
  });

  it("keeps a saved mobile node on the connection surface until the user opts into this launch", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    await app.start();
    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved).toMatchObject({
      connectionId: credential.connectionId,
      origin: credential.origin,
      automatic: false
    });
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();

    app.setForeground(false);
    app.setForeground(true);
    await Promise.resolve();
    expect(app.state.status).toBe("unpaired");
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();

    await app.connectSaved(true);
    expect(app.state.status).toBe("connected");
    expect(app.state.saved?.automatic).toBe(true);
    expect(saved.automatic()).toBe(true);
    expect(network.inspect).toHaveBeenCalledBefore(network.readOwner as ReturnType<typeof vi.fn>);

    await app.disableAutomaticEntry();
    expect(app.state.status).toBe("connected");
    expect(app.state.saved?.automatic).toBe(false);
    expect(saved.automatic()).toBe(false);
  });

  it("restarts interrupted storage initialization when a background launch becomes active", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    app.setForeground(false);

    await app.start();
    expect(app.state.status).toBe("starting");
    expect(network.inspect).not.toHaveBeenCalled();

    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("unpaired"));
    expect(app.state.saved).toMatchObject({ connectionId: credential.connectionId, automatic: false });
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();
  });

  it("does not persist a cancelled pairing or a mismatched device identity", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");
    let resolve!: (result: { credential: PairedCredential; identity: typeof node }) => void;
    vi.mocked(network.completePairing).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = app.pair(credential.origin, "123456", "Phone");
    app.cancel();
    resolve({ credential, identity: node });
    await pending;
    expect(saved.storage.saveCredential).not.toHaveBeenCalled();

    await app.requestPairing(credential.origin, "Phone");
    vi.mocked(network.readOwner).mockResolvedValueOnce({ connection: create(ConnectionSchema, { ...connection, deviceId: "other" }), device, snapshot });
    await expect(app.pair(credential.origin, "123456", "Phone")).rejects.toThrow();
    expect(saved.storage.saveCredential).not.toHaveBeenCalled();
  });

  it("keeps an unknown send receipt across restart and never repeats the mutation under another ID", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    expect(await app.send("hello")).toBe(false);
    expect(saved.pending()).toMatchObject([{ operationId: "operation-1", kind: "send", sessionId: "session", state: "unknown" }]);
    expect(network.submit).toHaveBeenCalledOnce();
    await expect(app.send("hello")).rejects.toThrow(/unknown result/);
    await app.refresh();
    expect(network.submit).toHaveBeenCalledOnce();
    expect(saved.pending()).toHaveLength(1);
    app.dispose();

    const restored = client(network, saved.storage);
    vi.mocked(network.getOperation).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1", connectionId: credential.connectionId, state: OperationState.SUCCEEDED
    }));
    await restored.start();
    expect(restored.state.status).toBe("connected");
    expect(saved.pending()).toHaveLength(0);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("requires an authenticated authoritative absence before an explicit unknown receipt is cleared", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    await app.send("hello");
    vi.mocked(network.getOperation).mockRejectedValueOnce(new Error("offline"));
    await expect(app.dismissUnconfirmed("operation-1")).rejects.toThrow("offline");
    expect(saved.pending()).toHaveLength(1);
    await app.dismissUnconfirmed("operation-1");
    expect(saved.pending()).toHaveLength(0);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("admits only one user mutation while its receipt is being persisted", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let release!: () => void;
    vi.mocked(saved.storage.savePending).mockImplementationOnce(() => new Promise<void>((done) => { release = done; }));
    const first = app.send("one message");
    await expect(app.send("one message")).rejects.toThrow(/unknown result|already being submitted/);
    expect(network.submit).not.toHaveBeenCalled();
    release();
    expect(await first).toBe(true);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("retains an unsent operation warning when the app backgrounds during receipt persistence", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let release!: () => void;
    const original = saved.storage.savePending;
    vi.mocked(saved.storage.savePending).mockImplementationOnce(async (items) => {
      await new Promise<void>((done) => { release = done; });
      await original(items);
    });
    const sending = app.send("one message");
    await vi.waitFor(() => expect(saved.storage.savePending).toHaveBeenCalledOnce());
    app.setForeground(false);
    release();
    expect(await sending).toBe(false);
    expect(network.submit).not.toHaveBeenCalled();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
    expect(app.state.pending).toMatchObject([{ operationId: "operation-1", state: "unknown" }]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "operation-1", expect.any(AbortSignal));
  });

  it("prepares the exact target revision and fences a new task and text input to durable generations", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.create("target", "Work");
    expect(network.prepareTarget).toHaveBeenCalledWith(credential, snapshot.targets[0], expect.any(AbortSignal));
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "target" }, expectedRevision: { value: 3n } }],
      payload: { case: "createSession", value: { backendId: "backend", targetId: "target", displayName: "Work" } }
    });
    expect(await app.send("hello")).toBe(true);
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "session" }, expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { sessionId: "session", input: { parts: [{ content: { case: "text", value: "hello" } }] } } }
    });
  });

  it("retires a late task navigation read in the background and restores the selected task on foreground", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    await app.select(undefined);
    let resolve!: (value: typeof snapshot) => void;
    vi.mocked(network.readSession).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const selecting = app.select("session");
    await vi.waitFor(() => expect(network.readSession).toHaveBeenCalledTimes(2));
    app.setForeground(false);
    resolve(snapshot);
    await selecting;
    expect(app.state.detail).toBeUndefined();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.detail?.sessions[0]?.sessionId).toBe("session"));
    expect(app.state.status).toBe("connected");
  });

  it("uses authoritative final message blocks over transient text and preserves other activity", () => {
    const events = [
      create(EventSchema, { eventId: "start", cursor: { sequence: 1n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "message", role: MessageRole.ASSISTANT
      } } } }),
      create(EventSchema, { eventId: "delta", cursor: { sequence: 2n }, payload: { kind: { case: "textDelta", value: {
        messageId: "message", delta: "partial"
      } } } }),
      create(EventSchema, { eventId: "done", cursor: { sequence: 3n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "final" } }]
      } } } }),
      create(EventSchema, { eventId: "status", cursor: { sequence: 4n }, payload: { kind: { case: "runAborted", value: { runId: "run" } } } })
    ];
    expect(timelineRows([...events, events[2]!])).toMatchObject([
      { id: "message", label: "Assistant", text: "final" },
      { id: "status", label: "Activity", text: "run Aborted" }
    ]);
  });

  it("anchors an exact session event and pages backward without mixing the latest window", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e6", 6n), event("e7", 7n), event("e8", 8n)]);
    await app.around("e7");
    expect(network.readAround).toHaveBeenCalledWith(credential, "session", "e7", expect.any(AbortSignal));
    expect(app.state.window?.map((item) => item.eventId)).toEqual(["e6", "e7", "e8"]);
    vi.mocked(network.readHistory).mockResolvedValueOnce({ events: [event("e4", 4n), event("e5", 5n)],
      before: event("e4", 4n).cursor });
    await app.older();
    expect(network.readHistory).toHaveBeenCalledWith(credential, "session", event("e6", 6n).cursor, expect.any(AbortSignal));
    expect(app.state.window?.map((item) => item.eventId)).toEqual(["e4", "e5", "e6", "e7", "e8"]);
    vi.mocked(network.readHistory).mockResolvedValueOnce({ events: [event("e3", 3n)], before: event("e4", 4n).cursor });
    await expect(app.older()).rejects.toThrow(/cyclic/);
    app.latest();
    expect(app.state.window).toBeUndefined();
  });

  it("retires an in-flight historic page when returning to the latest window", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    let release!: (page: { events: Event[]; before?: Event["cursor"] }) => void;
    vi.mocked(network.readHistory).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const oldPage = app.older();
    app.latest();
    release({ events: [event("e5", 5n)], before: event("e5", 5n).cursor });
    await oldPage;
    expect(app.state.window).toBeUndefined();
    expect(app.state.older).toHaveLength(0);
  });

  it("rejects another task in an anchor and retires an old page after a background transition", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("foreign", 7n, "another-session")]);
    await expect(app.around("foreign")).rejects.toThrow(/mismatched/);
    let resolve!: (events: Event[]) => void;
    vi.mocked(network.readAround).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const anchor = app.around("e7");
    app.setForeground(false);
    resolve([event("e7", 7n)]);
    await anchor;
    expect(app.state.window).toBeUndefined();
    expect(app.state.liveStatus).toBe("paused");
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
    expect(network.inspect).toHaveBeenCalledTimes(3);
  });

  it("merges only contiguous selected-task events and restores authoritative projections across gaps", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    expect(app.state.liveStatus).toBe("verifying");
    emit(event("eleven", 11n));
    await vi.waitFor(() => expect(app.state.live.map((item) => item.eventId)).toEqual(["eleven"]));
    expect(app.state.liveStatus).toBe("streaming");
    emit(event("eleven-duplicate", 11n));
    emit(event("foreign", 12n, "another-session"));
    await vi.waitFor(() => expect(app.state.live).toHaveLength(1));
    emit(event("gap", 14n));
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledTimes(2));
    expect(app.state.live).toHaveLength(0);
    expect(vi.mocked(network.streamOwner).mock.calls[0]?.[1]).toMatchObject({ sequence: 10n, generation: 1n });
  });

  it("replaces transient message deltas with final Snapshot content without replaying the input", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const started = create(EventSchema, { eventId: "start", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }, payload: { kind: { case: "messageStarted", value: {
      messageId: "assistant-message", role: MessageRole.ASSISTANT
    } } } });
    const delta = create(EventSchema, { eventId: "delta", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-12", sequence: 12n, generation: 1n }, payload: { kind: { case: "textDelta", value: {
      messageId: "assistant-message", delta: "partial"
    } } } });
    const completed = create(EventSchema, { eventId: "completed", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-13", sequence: 13n, generation: 1n }, payload: { kind: { case: "messageCompleted", value: {
      messageId: "assistant-message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "final" } }]
    } } } });
    const current = create(SnapshotSchema, { ...snapshot,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "cursor-13", sequence: 13n, generation: 1n }), timeline: [started, delta, completed] });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: current });
    vi.mocked(network.readSession).mockResolvedValue(current);
    emit(started); emit(delta); emit(completed);
    await vi.waitFor(() => expect(app.state.detail?.timeline.map((item) => item.eventId)).toEqual(["start", "delta", "completed"]));
    expect(app.state.live).toHaveLength(0);
    expect(timelineRows([...(app.state.detail?.timeline ?? []), ...app.state.live])).toMatchObject([
      { id: "assistant-message", text: "final", eventId: "start" }
    ]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("releases the previous stream in background and resumes from a fresh generation without retaining history", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    const firstSignal = vi.mocked(network.streamOwner).mock.calls[0]?.[2];
    app.setForeground(false);
    expect(firstSignal?.aborted).toBe(true);
    expect(app.state.window).toBeUndefined();
    expect(app.state.older).toHaveLength(0);
    const restarted = create(SnapshotSchema, { ...snapshot, generation: 2n,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "generation-2", sequence: 1n, generation: 2n }), timeline: [] });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: restarted });
    vi.mocked(network.readSession).mockResolvedValue(restarted);
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.owner?.generation).toBe(2n));
    expect(app.state.window).toBeUndefined();
    expect(app.state.live).toHaveLength(0);
    expect(vi.mocked(network.streamOwner).mock.calls[1]?.[1]).toMatchObject({ generation: 2n, sequence: 1n });
    emit(event("old", 11n));
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledTimes(3));
    expect(app.state.live).toHaveLength(0);
  });

  it("drops a historic window when a contiguous event changes its visible history", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    emit(create(EventSchema, { eventId: "deleted", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }, payload: { kind: { case: "messageDeleted", value: {
      productSessionId: "session", requestedEventId: "e7", deletedEventIds: ["e7"]
    } } } }));
    await vi.waitFor(() => expect(app.state.window).toBeUndefined());
    expect(app.state.older).toHaveLength(0);
  });

  it("exposes a degraded polling state when the native stream fails without treating it as live", async () => {
    const network = fakeNetwork();
    network.streamOwner = vi.fn(async function* () { throw new Error("stream transport unavailable"); });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await vi.waitFor(() => expect(app.state.liveStatus).toBe("polling"));
    expect(app.state.status).toBe("connected");
    expect(app.state.live).toHaveLength(0);
  });
});
