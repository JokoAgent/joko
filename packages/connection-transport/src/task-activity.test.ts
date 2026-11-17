import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { TaskActivityStateSchema, type TaskActivityState } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { followTaskActivity, type TaskActivityPort } from "./task-activity.js";
afterEach(() => vi.useRealTimers());

it("clears a lost stream, restores the same revision on reconnect, and never replays a mutation", async () => {
  vi.useFakeTimers(); const abort = new AbortController(), changes: Array<TaskActivityState | undefined> = [];
  const value = create(TaskActivityStateSchema, { generation: 4n, revision: 7n, activeDevices: [{ deviceId: "phone", displayName: "Phone" }] });
  const port: TaskActivityPort = { revoke: vi.fn(async () => {}), watch: vi.fn(async function* () { yield value; throw new Error("Connection lost"); }) };
  const running = followTaskActivity(port, ["task"], 4n, abort.signal, state => changes.push(state));
  await vi.advanceTimersByTimeAsync(0); expect(changes).toEqual([value, undefined]);
  await vi.advanceTimersByTimeAsync(350); expect(changes).toEqual([value, undefined, value, undefined]);
  abort.abort(); await running; await vi.advanceTimersByTimeAsync(5_000);
  expect(port.watch).toHaveBeenCalledTimes(2); expect(port.revoke).not.toHaveBeenCalled();
});

it("rejects a different service generation and retires a permanently unauthorized observer", async () => {
  vi.useFakeTimers(); const abort = new AbortController(), changes: Array<TaskActivityState | undefined> = [];
  let attempt = 0;
  const port: TaskActivityPort = { revoke: vi.fn(async () => {}), watch: async function* () {
    if (attempt++ === 0) yield create(TaskActivityStateSchema, { generation: 5n, revision: 99n, activeDevices: [{ deviceId: "old", displayName: "Old" }] });
    else throw new ConnectError("Revoked", Code.Unauthenticated);
  } };
  const running = followTaskActivity(port, [], 4n, abort.signal, state => changes.push(state));
  await vi.advanceTimersByTimeAsync(350); await running;
  expect(changes).toEqual([undefined, undefined]); expect(attempt).toBe(2); expect(port.revoke).not.toHaveBeenCalled();
});
