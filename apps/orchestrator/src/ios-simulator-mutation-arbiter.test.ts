import { describe, expect, it, vi } from "vitest";
import { SimulatorMutationArbiter, SimulatorMutationArbitrationError
} from "./ios-simulator-mutation-arbiter.js";

const scope = { sessionId: "session", targetId: "target", generation: 1 };
const route = { instanceId: "instance", generation: 2, leaseId: "lease" };

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(next => { resolve = next; }), resolve };
}

describe("SimulatorMutationArbiter", () => {
  it("serializes Agent mutations and exposes their exact process-local state", async () => {
    const requireRoute = vi.fn();
    const arbiter = new SimulatorMutationArbiter({ requireRoute } as never);
    const gate = deferred<string>();
    const first = arbiter.runAgent(scope, route, async () => gate.promise);
    await vi.waitFor(() => expect(arbiter.state(scope, route)).toMatchObject({
      activeSource: "agent", queuedAgentMutations: 0, agentPaused: false
    }));
    const secondTask = vi.fn(async () => "second");
    const second = arbiter.runAgent(scope, route, secondTask);
    expect(arbiter.state(scope, route)).toMatchObject({
      activeSource: "agent", queuedAgentMutations: 1, takeoverPending: false
    });
    expect(secondTask).not.toHaveBeenCalled();
    gate.resolve("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(arbiter.state(scope, route)).toMatchObject({
      activeSource: null, lastSource: "agent", queuedAgentMutations: 0
    });
  });

  it("takes control, cancels active and queued Agent work, then permits only user work", async () => {
    const started = deferred<void>();
    const arbiter = new SimulatorMutationArbiter({ requireRoute: vi.fn() } as never);
    const active = arbiter.runAgent(scope, route, async signal => {
      signal.addEventListener("abort", () => started.resolve(), { once: true });
      await started.promise;
      signal.throwIfAborted();
      return "active";
    });
    await vi.waitFor(() => expect(arbiter.state(scope, route).activeSource).toBe("agent"));
    const queuedTask = vi.fn(async () => "queued");
    const queued = arbiter.runAgent(scope, route, queuedTask);
    await expect(arbiter.runUser(scope, route, async () => "blocked"))
      .rejects.toMatchObject({ code: "DEVICE_BUSY" });
    expect(arbiter.takeover(scope, route)).toMatchObject({
      agentPaused: true, takeoverPending: true, queuedAgentMutations: 1
    });
    let earlyResume: unknown;
    try { arbiter.resume(scope, route); } catch (error) { earlyResume = error; }
    expect(earlyResume).toMatchObject({ code: "DEVICE_BUSY" });
    await expect(active).rejects.toThrow();
    await expect(queued).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    expect(queuedTask).not.toHaveBeenCalled();
    expect(arbiter.state(scope, route)).toMatchObject({
      agentPaused: true, takeoverPending: false, activeSource: null, queuedAgentMutations: 0
    });
    await expect(arbiter.runUser(scope, route, async () => "user")).resolves.toBe("user");
    await expect(arbiter.runAgent(scope, route, async () => "blocked"))
      .rejects.toMatchObject({ code: "AGENT_MUTATION_PAUSED" });
    expect(arbiter.resume(scope, route).agentPaused).toBe(false);
    await expect(arbiter.runAgent(scope, route, async () => "agent")).resolves.toBe("agent");
  });

  it("validates the exact route before state changes and releases a live user touch at Agent start", async () => {
    const onAgentMutationStart = vi.fn();
    const requireRoute = vi.fn()
      .mockImplementationOnce(() => { throw new Error("stale route"); });
    const arbiter = new SimulatorMutationArbiter({ requireRoute } as never,
      { onAgentMutationStart });
    await expect(arbiter.runAgent(scope, route, async () => undefined)).rejects.toThrow("stale route");
    expect(onAgentMutationStart).not.toHaveBeenCalled();
    await expect(arbiter.runAgent(scope, route, async () => "ok")).resolves.toBe("ok");
    expect(onAgentMutationStart).toHaveBeenCalledWith("instance");
  });

  it("preserves an owning coordinator's unknown outcome when takeover aborts its signal", async () => {
    const arbiter = new SimulatorMutationArbiter({ requireRoute: vi.fn() } as never);
    const active = arbiter.runAgent(scope, route, async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new SimulatorMutationArbitrationError("SIMULATOR_HOST_CLOSED", "effect outcome unknown");
    });
    await vi.waitFor(() => expect(arbiter.state(scope, route).activeSource).toBe("agent"));
    arbiter.takeover(scope, route);
    await expect(active).rejects.toMatchObject({
      code: "SIMULATOR_HOST_CLOSED", message: "effect outcome unknown"
    });
  });

  it("preserves an owning coordinator's confirmed result when takeover arrives after admission", async () => {
    const arbiter = new SimulatorMutationArbiter({ requireRoute: vi.fn() } as never);
    const active = arbiter.runAgent(scope, route, async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "confirmed";
    });
    await vi.waitFor(() => expect(arbiter.state(scope, route).activeSource).toBe("agent"));
    arbiter.takeover(scope, route);
    await expect(active).resolves.toBe("confirmed");
    expect(arbiter.state(scope, route)).toMatchObject({
      activeSource: null, lastSource: "agent", agentPaused: true, takeoverPending: false
    });
  });
});
