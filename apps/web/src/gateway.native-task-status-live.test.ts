// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { EventSchema, GetSnapshotResponseSchema, SnapshotSchema, RunState } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";

afterEach(() => vi.useRealTimers());
const profile = { id: "owner", deviceId: "device", serverId: "node", name: "Node", origin: "https://node.example" };
const ownerSnapshot = (cursor: bigint) => create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
  generation: 1n, resumeCursor: { generation: 1n, sequence: cursor }
}) });
function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
async function* idle(): AsyncIterable<never> { await new Promise<never>(() => undefined); }

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
  const transport = {
    unary: async (method: any) => {
      if (method.localName !== "getSnapshot") throw new Error("Unsupported fixture method");
      reads += 1;
      return response(method, reads === 1 ? ownerSnapshot(1n) : await new Promise<ReturnType<typeof ownerSnapshot>>(resolve => { finishRefresh = resolve; }));
    },
    stream: async (method: any) => {
      streams += 1;
      return response(method, streams === 1 ? { async *[Symbol.asyncIterator]() { throw new ConnectError("offline", Code.Unavailable); } } : idle(), true);
    }
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(profile, "fixture-auth", { onLiveSnapshot: value => observed.push(value) }, () => transport);
  try {
    await gateway.connect(); await vi.advanceTimersByTimeAsync(0);
    expect(observed.filter(Boolean).map(value => value!.cursor)).toEqual([1n]); expect(observed.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(350);
    expect(reads).toBe(2); expect(streams).toBe(1); expect(observed.at(-1)).toBeUndefined();
    finishRefresh(ownerSnapshot(2n)); await vi.advanceTimersByTimeAsync(0);
    expect(observed.filter(Boolean).map(value => value!.cursor)).toEqual([1n, 2n]); expect(streams).toBe(2);
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
