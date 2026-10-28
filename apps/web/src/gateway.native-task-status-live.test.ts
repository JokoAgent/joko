// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { CompactionState, EventSchema, GetSnapshotResponseSchema, SnapshotSchema, StreamEventsResponseSchema, RunState, SessionState } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";
import { resolveActiveCompaction } from "./components/compaction-status-behavior.js";

afterEach(() => vi.useRealTimers());
const profile = { id: "owner", deviceId: "device", serverId: "node", name: "Node", origin: "https://node.example" };
const ownerSnapshot = (cursor: bigint) => create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
  generation: 1n, resumeCursor: { generation: 1n, sequence: cursor }
}) });
function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

it("never promotes a snapshot-only probe to a live task-status source", async () => {
  const live = vi.fn(), snapshot = vi.fn();
  const transport = { unary: async (method: any) => response(method, ownerSnapshot(1n)), stream: vi.fn() } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: snapshot, onLiveSnapshot: live }, () => transport);
  await gateway.connect({ snapshotOnly: true });
  expect(snapshot).toHaveBeenCalledOnce(); expect(live.mock.calls.every(([value]) => value === undefined)).toBe(true);
  expect(transport.stream).not.toHaveBeenCalled(); gateway.disconnect();
});

it("withdraws an interrupted source and requires a fresh authenticated owner snapshot before restoring it", async () => {
  vi.useFakeTimers();
  const observed: Array<AppSnapshot | undefined> = [];
  let reads = 0, streams = 0;
  let finishRefresh!: (value: ReturnType<typeof ownerSnapshot>) => void;
  let acceptStream!: () => void;
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, reads === 1 ? ownerSnapshot(1n) : await new Promise<ReturnType<typeof ownerSnapshot>>(resolve => { finishRefresh = resolve; }));
    },
    stream: async (method: any) => {
      streams += 1;
      return response(method, streams === 1 ? { async *[Symbol.asyncIterator]() { throw new ConnectError("offline", Code.Unavailable); } }
        : { async *[Symbol.asyncIterator]() {
          await new Promise<void>(resolve => { acceptStream = resolve; });
          yield create(StreamEventsResponseSchema);
          await new Promise<never>(() => undefined);
        } }, true);
    }
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onLiveSnapshot: value => observed.push(value) }, () => transport);
  try {
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(observed.filter(Boolean).map(value => value!.cursor)).toEqual([1n]); expect(observed.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(350);
    expect(reads).toBe(2); expect(streams).toBe(1); expect(observed.at(-1)).toBeUndefined();
    finishRefresh(ownerSnapshot(2n)); await vi.advanceTimersByTimeAsync(0);
    expect(streams).toBe(2); expect(observed.at(-1)).toBeUndefined();
    expect(observed.filter(Boolean).map(value => value!.cursor)).toEqual([1n]);
    acceptStream(); await vi.advanceTimersByTimeAsync(0);
    expect(observed.filter(Boolean).map(value => value!.cursor)).toEqual([1n, 2n]);
  } finally { gateway.disconnect(); }
});

it("refreshes durable activity before exposing an incomplete terminal Run delta to the native mirror", async () => {
  const native: bigint[] = [], ordinary: bigint[] = [];
  let reads = 0, finishRefresh!: (value: ReturnType<typeof ownerSnapshot>) => void;
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, reads === 1 ? ownerSnapshot(0n) : await new Promise<ReturnType<typeof ownerSnapshot>>(resolve => { finishRefresh = resolve; }));
    },
    stream: async (method: any) => response(method, { async *[Symbol.asyncIterator]() {
      yield { event: create(EventSchema, { eventId: "completed-run", cursor: { generation: 1n, sequence: 1n },
        payload: { kind: { case: "runChanged", value: { run: { runId: "current", sessionId: "task", state: RunState.SUCCEEDED } } } } }) };
      await new Promise<never>(() => undefined);
    } }, true)
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: value => ordinary.push(value.cursor),
    onLiveSnapshot: value => { if (value) native.push(value.cursor); } }, () => transport);
  try {
    await gateway.connect(); await vi.waitFor(() => expect(reads).toBe(2));
    expect(ordinary).toEqual([0n, 1n]); expect(native).toEqual([0n]);
    finishRefresh(ownerSnapshot(1n)); await vi.waitFor(() => expect(native).toEqual([0n, 1n]));
  } finally { gateway.disconnect(); }
});

const compactingOwnerSnapshot = (cursor: bigint, compacting?: boolean, generation = 4n, opaqueReference = "native:task", state = SessionState.RUNNING) =>
  create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
    generation: 1n, resumeCursor: { generation: 1n, sequence: cursor }, sessions: [{
      sessionId: "task", backendId: "pi", targetId: "target", state,
      location: { kind: { case: "serviceNode", value: {} } },
      nativeBinding: { backendId: "pi", opaqueReference, runtimeGeneration: generation, runtimeAttached: true },
      ...(compacting === undefined ? {} : { contextState: { compacting } })
    }]
  }) });
const overflowEvent = (sequence: bigint, state: CompactionState, compactionId = "original-overflow") => create(EventSchema, {
  eventId: `overflow:${sequence}`, cursor: { generation: 1n, sequence },
  identity: { backendId: "pi", targetId: "target", sessionId: "task", generation: 4n },
  payload: { kind: { case: "compactionChanged", value: { compactionId, state, reason: "overflow", automatic: true } } }
});
const activityEvent = create(EventSchema, { eventId: "before-overflow", cursor: { generation: 1n, sequence: 1n },
  payload: { kind: { case: "runChanged", value: { run: { runId: "current", sessionId: "task", state: RunState.RUNNING } } } } });
const nativeHistoryEvent = create(EventSchema, { eventId: "native-prefix-before-overflow", cursor: { generation: 1n, sequence: 1n },
  identity: { backendId: "pi", targetId: "target", sessionId: "task", generation: 4n },
  payload: { kind: { case: "nativeSessionChanged", value: { productSessionId: "task", opaqueNativeReference: "native:task" } } } });

it.each([
  { terminalState: CompactionState.COMPLETED, primaryUi: true },
  { terminalState: CompactionState.FAILED, primaryUi: true },
  { terminalState: CompactionState.COMPLETED, primaryUi: false },
  { terminalState: CompactionState.FAILED, primaryUi: false }
])("retains the original live overflow and terminal $terminalState after the primaryUi=$primaryUi catalog omits its native observation", async ({ terminalState, primaryUi }) => {
  let reads = 0, latest: AppSnapshot | undefined, releaseTerminal!: () => void;
  let finishRefresh!: (value: ReturnType<typeof compactingOwnerSnapshot>) => void;
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, reads === 1 ? compactingOwnerSnapshot(0n, false)
        : await new Promise<ReturnType<typeof compactingOwnerSnapshot>>(resolve => { finishRefresh = resolve; }));
    },
    stream: async (method: any) => response(method, { async *[Symbol.asyncIterator]() {
      yield { event: primaryUi ? nativeHistoryEvent : activityEvent };
      yield { event: overflowEvent(2n, CompactionState.STARTED) };
      await new Promise<void>(resolve => { releaseTerminal = resolve; });
      yield { event: overflowEvent(3n, terminalState) };
      await new Promise<never>(() => undefined);
    } }, true)
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: value => { latest = value; },
    ...(primaryUi ? {} : { onLiveSnapshot: () => undefined }) }, () => transport);
  try {
    await gateway.connect(); await vi.waitFor(() => expect(reads).toBe(2));
    // The native observation is unknown while the held summary is running.
    // The catalog contains neither buffered lifecycle row.
    finishRefresh(compactingOwnerSnapshot(3n));
    await vi.waitFor(() => expect(resolveActiveCompaction(latest?.timelineBySession.get("task") ?? [], latest?.sessions[0]?.compacting))
      .toMatchObject({ compactionId: "original-overflow", reason: "overflow", automatic: true }));
    expect(latest?.cursor).toBe(3n); expect(latest?.sessions[0]?.compacting).toBe(true);
    releaseTerminal();
    await vi.waitFor(() => expect(latest?.timelineBySession.get("task")?.[0]?.compaction?.state)
      .toBe(terminalState === CompactionState.COMPLETED ? "completed" : "failed"));
    expect(latest?.cursor).toBe(3n); expect(latest?.sessions[0]?.compacting).toBe(false);
    expect(resolveActiveCompaction(latest?.timelineBySession.get("task") ?? [], latest?.sessions[0]?.compacting)).toBeUndefined();
    expect(latest?.timelineBySession.get("task")).toHaveLength(1); expect(reads).toBe(2);
  } finally { gateway.disconnect(); }
});

it.each([CompactionState.COMPLETED, CompactionState.FAILED])("retains old terminal %s without closing the newer inspected compaction on the same native binding", async firstTerminal => {
  let reads = 0, latest: AppSnapshot | undefined;
  let finishRefresh!: (value: ReturnType<typeof compactingOwnerSnapshot>) => void;
  let deliverSecondStart!: () => void, deliverSecondTerminal!: () => void;
  const catalogFlags: Array<boolean | undefined> = [];
  const firstStart = overflowEvent(2n, CompactionState.STARTED, "overflow-A");
  const firstEnd = overflowEvent(3n, firstTerminal, "overflow-A");
  const secondStart = overflowEvent(4n, CompactionState.STARTED, "overflow-B");
  const secondEnd = overflowEvent(5n, CompactionState.COMPLETED, "overflow-B");
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, reads === 1 ? compactingOwnerSnapshot(0n, false)
        : await new Promise<ReturnType<typeof compactingOwnerSnapshot>>(resolve => { finishRefresh = resolve; }));
    },
    stream: async (method: any) => response(method, { async *[Symbol.asyncIterator]() {
      yield { event: nativeHistoryEvent };
      yield { event: firstStart };
      yield { event: firstEnd };
      await new Promise<void>(resolve => { deliverSecondStart = resolve; });
      yield { event: secondStart };
      await new Promise<void>(resolve => { deliverSecondTerminal = resolve; });
      yield { event: secondEnd };
      await new Promise<never>(() => undefined);
    } }, true)
  } as unknown as Transport;
  // This is the primary UI Gateway: no native mirror callback manufactures
  // the authoritative refresh after the original native-history marker.
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: value => {
    latest = value;
    if (value.cursor === 4n) catalogFlags.push(value.sessions[0]?.compacting);
  } }, () => transport);
  try {
    await gateway.connect(); await vi.waitFor(() => expect(reads).toBe(2));
    // The durable server order is START(A), END(A), START(B). Its inspected
    // snapshot already proves B is active, before the stream has delivered A.
    finishRefresh(compactingOwnerSnapshot(4n, true));
    await vi.waitFor(() => expect(latest?.timelineBySession.get("task")?.[0]?.compaction).toMatchObject({
      id: "overflow-A", state: firstTerminal === CompactionState.COMPLETED ? "completed" : "failed"
    }));
    expect(latest?.cursor).toBe(4n); expect(latest?.sessions[0]?.compacting).toBe(true);
    expect(resolveActiveCompaction(latest?.timelineBySession.get("task") ?? [], latest?.sessions[0]?.compacting)).toBeDefined();
    deliverSecondStart();
    await vi.waitFor(() => expect(resolveActiveCompaction(latest?.timelineBySession.get("task") ?? [], latest?.sessions[0]?.compacting))
      .toMatchObject({ compactionId: "overflow-B", reason: "overflow", automatic: true }));
    expect(latest?.timelineBySession.get("task")?.map(item => item.compaction?.id)).toEqual(["overflow-A", "overflow-B"]);
    expect(catalogFlags.length).toBeGreaterThan(0); expect(catalogFlags.every(value => value === true)).toBe(true);
    // B's real terminal is newer than the catalog watermark and must still
    // follow the normal event path, closing its own current lifecycle.
    deliverSecondTerminal();
    await vi.waitFor(() => expect(latest?.cursor).toBe(5n));
    expect(latest?.sessions[0]?.compacting).toBe(false);
    expect(latest?.timelineBySession.get("task")?.map(item => item.compaction && ({ id: item.compaction.id, state: item.compaction.state })))
      .toEqual([{ id: "overflow-A", state: firstTerminal === CompactionState.COMPLETED ? "completed" : "failed" },
        { id: "overflow-B", state: "completed" }]);
    expect(resolveActiveCompaction(latest?.timelineBySession.get("task") ?? [], latest?.sessions[0]?.compacting)).toBeUndefined();
    expect(reads).toBe(2);
  } finally { gateway.disconnect(); deliverSecondStart?.(); deliverSecondTerminal?.(); }
});

it.each([
  { reason: "an authoritative completed observation", compacting: false, generation: 4n, opaqueReference: "native:task", state: SessionState.RUNNING, gap: false },
  { reason: "a replaced runtime generation", compacting: undefined, generation: 5n, opaqueReference: "native:task", state: SessionState.RUNNING, gap: false },
  { reason: "a replaced native binding", compacting: undefined, generation: 4n, opaqueReference: "native:replacement", state: SessionState.RUNNING, gap: false },
  { reason: "a retired native task", compacting: undefined, generation: 4n, opaqueReference: "native:task", state: SessionState.CLOSED, gap: false },
  { reason: "a gap in the original stream", compacting: undefined, generation: 4n, opaqueReference: "native:task", state: SessionState.RUNNING, gap: true }
])("does not revive a buffered overflow after $reason", async ({ compacting, generation, opaqueReference, state, gap }) => {
  let reads = 0, latest: AppSnapshot | undefined, bufferedDelivered = false;
  let finishRefresh!: (value: ReturnType<typeof compactingOwnerSnapshot>) => void;
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, reads === 1 ? compactingOwnerSnapshot(0n, false)
        : await new Promise<ReturnType<typeof compactingOwnerSnapshot>>(resolve => { finishRefresh = resolve; }));
    },
    stream: async (method: any) => response(method, { async *[Symbol.asyncIterator]() {
      yield { event: nativeHistoryEvent };
      yield { event: overflowEvent(gap ? 3n : 2n, CompactionState.STARTED) };
      bufferedDelivered = true;
      await new Promise<never>(() => undefined);
    } }, true)
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: value => { latest = value; } }, () => transport);
  try {
    await gateway.connect(); await vi.waitFor(() => expect(reads).toBe(2));
    finishRefresh(compactingOwnerSnapshot(3n, compacting, generation, opaqueReference, state));
    await vi.waitFor(() => expect(bufferedDelivered).toBe(true));
    expect(latest?.cursor).toBe(3n);
    expect(resolveActiveCompaction(latest?.timelineBySession.get("task") ?? [], latest?.sessions[0]?.compacting)).toBeUndefined();
    if (compacting === false) expect(latest?.sessions[0]?.compacting).toBe(false);
    else expect(latest?.timelineBySession.get("task") ?? []).toEqual([]);
    expect(reads).toBe(2);
  } finally { gateway.disconnect(); }
});

it("does not apply a buffered lifecycle after its original Gateway has disconnected", async () => {
  let reads = 0, retired = false, bufferedDelivered = false, deliverBuffered!: () => void;
  let streamSignal: AbortSignal | undefined;
  let closeStream: (() => Promise<void>) | undefined;
  const ordinary = vi.fn();
  const transport = {
    unary: async (method: any) => response(method, compactingOwnerSnapshot(reads++ === 0 ? 0n : 2n)),
    stream: async (method: any, signal: AbortSignal) => {
      streamSignal = signal;
      const messages = (async function* () {
        try {
          yield { event: nativeHistoryEvent };
          await new Promise<void>(resolve => { deliverBuffered = resolve; });
          bufferedDelivered = true;
          yield { event: overflowEvent(2n, CompactionState.STARTED) };
        } finally { retired = true; signal.removeEventListener("abort", retire); }
      })();
      // Connect deliberately omits return/throw from the client iterator.
      // The transport owns cancellation; queue its close behind the pending
      // buffered response so the Gateway must still reject that late event.
      let retirement: Promise<void> | undefined;
      const close = () => retirement ??= messages.return(undefined).then(() => undefined)
        .finally(() => signal.removeEventListener("abort", retire));
      // Observe rejection immediately; the test's final cleanup awaits the
      // same promise so a failed transport retirement still fails the test.
      function retire(): void { void close().catch(() => undefined); }
      closeStream = close;
      signal.addEventListener("abort", retire, { once: true });
      return response(method, messages, true);
    }
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: ordinary }, () => transport);
  try {
    await gateway.connect(); await vi.waitFor(() => expect(deliverBuffered).toBeTypeOf("function"));
    expect(streamSignal?.aborted).toBe(false);
    gateway.disconnect(); const count = ordinary.mock.calls.length;
    expect(streamSignal?.aborted).toBe(true);
    deliverBuffered();
    await vi.waitFor(() => expect(retired).toBe(true));
    expect(bufferedDelivered).toBe(true);
    expect(ordinary).toHaveBeenCalledTimes(count);
  } finally { gateway.disconnect(); deliverBuffered?.(); await closeStream?.(); }
});

it("does not retain the previous stream's buffered lifecycle when a new stream starts after its authoritative snapshot", async () => {
  vi.useFakeTimers();
  let reads = 0, streams = 0, replayed = false, latest: AppSnapshot | undefined;
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, compactingOwnerSnapshot(reads === 1 ? 0n : 2n, reads === 2 ? undefined : false));
    },
    stream: async (method: any) => {
      streams += 1;
      return response(method, streams === 1 ? { async *[Symbol.asyncIterator]() {
        yield { event: activityEvent };
        throw new ConnectError("The original stream ended", Code.Unavailable);
      } } : { async *[Symbol.asyncIterator]() {
        yield { event: overflowEvent(2n, CompactionState.STARTED) };
        replayed = true;
        await new Promise<never>(() => undefined);
      } }, true);
    }
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onSnapshot: value => { latest = value; }, onLiveSnapshot: () => undefined }, () => transport);
  try {
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(2); expect(streams).toBe(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(reads).toBe(3); expect(streams).toBe(2); expect(replayed).toBe(true);
    expect(latest?.cursor).toBe(2n); expect(latest?.sessions[0]?.compacting).toBe(false);
    expect(latest?.timelineBySession.get("task") ?? []).toEqual([]);
  } finally { gateway.disconnect(); }
});
