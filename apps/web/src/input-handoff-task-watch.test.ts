import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { watchInputHandoffTasks } from "./input-handoff-task-watch.js";

it("publishes only current owner metadata and clears it on a later read failure", async () => {
  vi.useFakeTimers(); const lifetime = new AbortController(), changed = vi.fn(); let failure = false;
  const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, { listInputHandoffTasks: () => {
    if (failure) throw new Error("Disconnected");
    return create(contract.ListInputHandoffTasksResponseSchema, { tasks: [{ sessionId: "task", requestId: "request", generation: 2n, stepNumber: 1 }] });
  } }));
  const stop = watchInputHandoffTasks({ transport, signal: lifetime.signal, changed, isCurrent: () => true, ownerKey: () => "same-owner" });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ sessionId: "task", requestId: "request", generation: 2, stepNumber: 1 }]);
    failure = true; await vi.advanceTimersByTimeAsync(2_000);
    expect(changed).toHaveBeenLastCalledWith([]);
    stop(); await vi.advanceTimersByTimeAsync(4_000); expect(changed).toHaveBeenCalledTimes(2);
  } finally { stop(); vi.useRealTimers(); }
});

it("discards a response for a replaced native generation and stops on connection retirement", async () => {
  vi.useFakeTimers(); let owner = "generation-one", resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; }), changed = vi.fn(), lifetime = new AbortController();
  const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, { listInputHandoffTasks: async () => {
    await pending; return create(contract.ListInputHandoffTasksResponseSchema, { tasks: [{ sessionId: "task", requestId: "request", generation: 1n, stepNumber: 1 }] });
  } }));
  const stop = watchInputHandoffTasks({ transport, signal: lifetime.signal, changed, isCurrent: () => !lifetime.signal.aborted, ownerKey: () => owner });
  try {
    await vi.advanceTimersByTimeAsync(0); owner = "generation-two"; resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled(); lifetime.abort(); await vi.advanceTimersByTimeAsync(4_000); expect(changed).not.toHaveBeenCalled();
  } finally { stop(); vi.useRealTimers(); }
});
