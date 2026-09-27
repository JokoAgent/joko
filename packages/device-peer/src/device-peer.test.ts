import { describe, expect, it } from "vitest";

import {
  DEVICE_PEER_PROTOCOL_VERSION,
  DevicePeerRouteRegistry,
  createInProcessDevicePeerHarness,
  type DevicePeerAgentOutcome,
  type DevicePeerMultiplexEvent,
  type DevicePeerRouteTransport,
  type RegisteredDevicePeerClaim
} from "./index.js";

describe("current-v1 device peer route ownership", () => {
  it("starts independent process registries from distinct injectable route-generation seeds", () => {
    const first = new DevicePeerRouteRegistry({ generationSeed: 100_001 });
    const second = new DevicePeerRouteRegistry({ generationSeed: 200_001 });

    expect(first.registerRoute("target-a", harness("target-a", ["files", "process"]).transport).routeGeneration)
      .toBe(100_001);
    expect(second.registerRoute("target-a", harness("target-a", ["files", "process"]).transport).routeGeneration)
      .toBe(200_001);
  });

  it("binds exact authenticated Devices, advances generations, and filters capability leases", () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const first = harness("target-a", ["files", "process"]);

    expect(() => registry.registerRoute("target-b", first.transport)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" })
    );
    const firstLease = registry.registerRoute("target-a", first.transport);
    expect(firstLease).toEqual({
      protocolVersion: 1,
      kind: "route_accepted",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      capabilities: ["files", "process"]
    });
    expect(registry.listRoutes(["files", "process"])).toEqual([firstLease]);
    expect(registry.listRoutes(["terminal"])).toEqual([]);

    const second = harness("target-a", ["files", "process", "terminal", "forwarding"]);
    const secondLease = registry.registerRoute("target-a", second.transport);
    expect(secondLease.routeGeneration).toBe(2);
    expect(first.retirements).toEqual([
      expect.objectContaining({ targetDeviceId: "target-a", routeGeneration: 1, reason: "replaced" })
    ]);
    expect(registry.getRoute("target-a")).toBe(secondLease);
    expect(registry.listRoutes(["files", "process", "terminal"])).toEqual([secondLease]);
    expect(registry.retireRoute(firstLease, "connection_closed")).toBe(false);
  });

  it("keeps a deferred route invisible and preserves the live generation until activation", () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const live = harness("target-a", ["files", "process"]);
    const liveLease = registry.registerRoute("target-a", live.transport);
    const pending = harness("target-a", ["files", "process"]);
    const pendingLease = registry.registerRoute(
      "target-a",
      pending.transport,
      { deferredActivation: true }
    );

    expect(pendingLease.routeGeneration).toBe(2);
    expect(registry.getRoute("target-a")).toBe(liveLease);
    expect(registry.listRoutes()).toEqual([liveLease]);
    expect(live.retirements).toEqual([]);
    expect(() => registry.registerClaim({
      requestId: "pending-command",
      targetDeviceId: "target-a",
      routeGeneration: pendingLease.routeGeneration,
      capability: "files",
      effectKind: "read_only",
      action: "files.stat",
      payload: { path: "/workspace" }
    })).toThrowError(expect.objectContaining({ code: "route_unavailable" }));

    expect(registry.activateRoute(pendingLease)).toBe(pendingLease);
    expect(registry.getRoute("target-a")).toBe(pendingLease);
    expect(live.retirements).toEqual([
      expect.objectContaining({ routeGeneration: 1, reason: "replaced" })
    ]);
  });

  it("requires an exact registered claim before one-shot dispatch and never re-dispatches a terminal claim", async () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const target = harness("target-a", ["files", "process"]);
    const lease = registry.registerRoute("target-a", target.transport);
    const forged = {
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "claim",
      requestId: "unregistered",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      capability: "files",
      effectKind: "read_only",
      action: "files.stat",
      payload: { path: "/workspace" }
    } as RegisteredDevicePeerClaim;
    expect(() => registry.dispatch(forged)).toThrowError(
      expect.objectContaining({ code: "unregistered_claim" })
    );

    const claim = registry.registerClaim({
      requestId: "read-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      capability: "files",
      effectKind: "read_only",
      action: "files.stat",
      payload: { path: "/workspace" }
    });
    expect(claim).toMatchObject({ requestId: "read-1", targetDeviceId: "target-a", routeGeneration: 1 });
    expect(() => registry.registerClaim({ ...claim, payload: { path: "/other" } })).toThrowError(
      expect.objectContaining({ code: "claim_conflict" })
    );

    const firstResult = await registry.dispatch(claim);
    const replay = await registry.dispatch(claim);
    expect(firstResult).toEqual({
      protocolVersion: 1,
      kind: "response",
      requestId: "read-1",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      outcome: "completed",
      value: { action: "files.stat" }
    });
    expect(replay).toBe(firstResult);
    expect(target.acceptedRequests).toHaveLength(1);

    expect(() => registry.registerClaim({
      requestId: "terminal-without-capability",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      capability: "terminal",
      effectKind: "side_effect",
      action: "terminal.open",
      payload: {}
    })).toThrowError(expect.objectContaining({ code: "capability_unavailable" }));
  });

  it("classifies accepted side effects with lost authority or receipts as unknown and never replays them", async () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    let effects = 0;
    const target = createInProcessDevicePeerHarness({
      targetDeviceId: "target-a",
      capabilities: ["files", "process"],
      agent: {
        async handle(frame) {
          effects += 1;
          return { outcome: "completed", value: { action: frame.action } };
        }
      }
    });
    const lease = registry.registerRoute("target-a", target.transport);
    const claim = registry.registerClaim({
      requestId: "mkdir-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      capability: "files",
      effectKind: "side_effect",
      action: "files.mkdir",
      payload: { path: "/workspace/new" }
    });
    target.loseReceipt(claim.requestId);

    const first = await registry.dispatch(claim);
    const replay = await registry.dispatch(claim);
    expect(first).toMatchObject({
      requestId: "mkdir-1",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      outcome: "outcome_unknown",
      errorCode: "receipt_lost"
    });
    expect(replay).toBe(first);
    expect(effects).toBe(1);

    const mismatchRegistry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const mismatch = createInProcessDevicePeerHarness({
      targetDeviceId: "target-a",
      capabilities: ["files", "process"],
      agent: { async handle() { return { outcome: "completed", value: undefined }; } },
      transformResponse: (frame) => ({ ...frame, targetDeviceId: "other-target" })
    });
    const mismatchLease = mismatchRegistry.registerRoute("target-a", mismatch.transport);
    const mismatchClaim = mismatchRegistry.registerClaim({
      requestId: "process-1",
      targetDeviceId: "target-a",
      routeGeneration: mismatchLease.routeGeneration,
      capability: "process",
      effectKind: "side_effect",
      action: "process.open",
      payload: { executable: "tool", args: [], cwd: "/workspace" }
    });
    await expect(mismatchRegistry.dispatch(mismatchClaim)).resolves.toMatchObject({
      requestId: "process-1",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      outcome: "outcome_unknown",
      errorCode: "identity_mismatch"
    });
  });

  it("turns abort or replacement after agent acceptance into unknown for side effects", async () => {
    const acceptedEffect = deferred<DevicePeerAgentOutcome>();
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const target = createInProcessDevicePeerHarness({
      targetDeviceId: "target-a",
      capabilities: ["files", "process"],
      agent: { handle: async () => acceptedEffect.promise }
    });
    const lease = registry.registerRoute("target-a", target.transport);
    const claim = registry.registerClaim({
      requestId: "process-start",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      capability: "process",
      effectKind: "side_effect",
      action: "process.open",
      payload: { executable: "tool", args: [], cwd: "/workspace" }
    });
    const result = registry.dispatch(claim);
    expect(target.acceptedRequests).toHaveLength(1);

    const replacement = harness("target-a", ["files", "process"]);
    registry.registerRoute("target-a", replacement.transport);
    await expect(result).resolves.toMatchObject({
      requestId: "process-start",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      outcome: "outcome_unknown",
      errorCode: "route_retired"
    });
    expect(target.aborts).toEqual([
      expect.objectContaining({ requestId: "process-start", reason: "route_retired" })
    ]);
    acceptedEffect.resolve({ outcome: "completed", value: { processId: "late" } });
    await expect(registry.dispatch(claim)).resolves.toMatchObject({ outcome: "outcome_unknown" });

    const abortEffect = deferred<DevicePeerAgentOutcome>();
    const abortClaim = registry.registerClaim({
      requestId: "process-abort",
      targetDeviceId: "target-a",
      routeGeneration: 2,
      capability: "process",
      effectKind: "side_effect",
      action: "process.open",
      payload: { executable: "tool", args: [], cwd: "/workspace" }
    });
    const abortingTarget = replacement;
    // Replace the default handler result with a held effect through a fresh route.
    const third = createInProcessDevicePeerHarness({
      targetDeviceId: "target-a",
      capabilities: ["files", "process"],
      agent: { handle: async () => abortEffect.promise }
    });
    registry.registerRoute("target-a", third.transport);
    // The claim was fenced to generation 2 before dispatch and therefore fails without an effect.
    await expect(registry.dispatch(abortClaim)).resolves.toMatchObject({ outcome: "failed", errorCode: "route_retired" });
    expect(abortingTarget.acceptedRequests).toHaveLength(0);

    const liveAbortClaim = registry.registerClaim({
      requestId: "process-abort-live",
      targetDeviceId: "target-a",
      routeGeneration: 3,
      capability: "process",
      effectKind: "side_effect",
      action: "process.open",
      payload: { executable: "tool", args: [], cwd: "/workspace" }
    });
    const liveAbort = registry.dispatch(liveAbortClaim);
    registry.abort(liveAbortClaim);
    await expect(liveAbort).resolves.toMatchObject({ outcome: "outcome_unknown", errorCode: "caller_aborted" });
    expect(third.aborts).toEqual([
      expect.objectContaining({ requestId: "process-abort-live", reason: "caller_aborted" })
    ]);
  });

  it("fences multiplexed process and PTY events by request, generation, and sequence", async () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const first = harness("target-a", ["files", "process", "terminal"]);
    const firstLease = registry.registerRoute("target-a", first.transport);
    const firstEvents: DevicePeerMultiplexEvent[] = [];
    registry.subscribe(firstLease, (event) => firstEvents.push(event));
    const firstClaim = registry.registerClaim({
      requestId: "terminal-1",
      targetDeviceId: "target-a",
      routeGeneration: firstLease.routeGeneration,
      capability: "terminal",
      effectKind: "side_effect",
      action: "terminal.open",
      payload: { executable: "shell", args: [], cwd: "/workspace", cols: 80, rows: 24 }
    });
    await registry.dispatch(firstClaim);
    first.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "terminal-1",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      streamId: "pty-1",
      sequence: 1,
      channel: "terminal_data",
      data: "before replacement"
    });
    expect(firstEvents).toEqual([expect.objectContaining({ channel: "terminal_data", sequence: 1 })]);

    const second = harness("target-a", ["files", "process", "terminal"]);
    const secondLease = registry.registerRoute("target-a", second.transport);
    expect(firstEvents.at(-1)).toEqual(expect.objectContaining({
      kind: "route_closed",
      routeGeneration: 1,
      reason: "replaced"
    }));
    const eventCountAfterRetirement = firstEvents.length;
    first.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "terminal-1",
      targetDeviceId: "target-a",
      routeGeneration: 1,
      streamId: "pty-1",
      sequence: 2,
      channel: "terminal_data",
      data: "late old generation"
    });
    expect(firstEvents).toHaveLength(eventCountAfterRetirement);

    const secondEvents: DevicePeerMultiplexEvent[] = [];
    registry.subscribe(secondLease, (event) => secondEvents.push(event));
    const secondClaim = registry.registerClaim({
      requestId: "process-2",
      targetDeviceId: "target-a",
      routeGeneration: 2,
      capability: "process",
      effectKind: "side_effect",
      action: "process.open",
      payload: { executable: "tool", args: [], cwd: "/workspace" }
    });
    await registry.dispatch(secondClaim);
    second.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "process-2",
      targetDeviceId: "target-a",
      routeGeneration: 2,
      streamId: "process-2-stream",
      sequence: 1,
      channel: "process_stdout",
      data: new Uint8Array([111, 107])
    });
    expect(secondEvents).toEqual([expect.objectContaining({
      requestId: "process-2",
      routeGeneration: 2,
      sequence: 1,
      channel: "process_stdout"
    })]);

    second.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "process-2",
      targetDeviceId: "target-a",
      routeGeneration: 2,
      streamId: "process-2-stream",
      sequence: 3,
      channel: "process_stderr",
      data: new Uint8Array()
    });
    expect(registry.getRoute("target-a")).toBeUndefined();
    expect(secondEvents.at(-1)).toEqual(expect.objectContaining({
      kind: "route_closed",
      routeGeneration: 2,
      reason: "authority_changed"
    }));
  });

  it("keeps reverse-forward connections inside their forwarding claim and sequence", async () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const target = harness("target-a", ["files", "process", "forwarding"]);
    const lease = registry.registerRoute("target-a", target.transport);
    const events: DevicePeerMultiplexEvent[] = [];
    registry.subscribe(lease, (event) => events.push(event));
    const claim = registry.registerClaim({
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      capability: "forwarding",
      effectKind: "side_effect",
      action: "listenLoopbackForward",
      payload: { localDestinationHost: "127.0.0.1", localDestinationPort: 3000 }
    });
    await registry.dispatch(claim);
    target.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      streamId: "connection-1",
      sequence: 1,
      channel: "reverse_forward_open"
    });
    target.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      streamId: "connection-1",
      sequence: 2,
      channel: "reverse_forward_data",
      data: new Uint8Array([1, 2, 3])
    });
    target.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      streamId: "connection-1",
      sequence: 3,
      channel: "reverse_forward_close",
      errorCode: null
    });
    expect(events.map((event) => event.kind === "stream_event" ? event.channel : event.kind)).toEqual([
      "reverse_forward_open",
      "reverse_forward_data",
      "reverse_forward_close"
    ]);

    registry.suppressStreamClaim(claim);
    target.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      streamId: "connection-2",
      sequence: 1,
      channel: "reverse_forward_open"
    });
    target.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      streamId: "connection-2",
      sequence: 2,
      channel: "reverse_forward_close",
      errorCode: null
    });
    target.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "listener-1",
      targetDeviceId: "target-a",
      routeGeneration: lease.routeGeneration,
      streamId: "listener-1",
      sequence: 1,
      channel: "forward_close",
      errorCode: null
    });
    expect(registry.getRoute("target-a")).toEqual(lease);
  });

  it("rejects old or mixed frame shapes instead of accepting compatibility aliases", () => {
    const registry = new DevicePeerRouteRegistry({ generationSeed: 1 });
    const valid = harness("target-a", ["files", "process"]);
    const mixed = {
      ...valid.transport,
      hello: { ...valid.transport.hello, generation: 0 }
    } as unknown as DevicePeerRouteTransport;
    expect(() => registry.registerRoute("target-a", mixed)).toThrowError(
      expect.objectContaining({ code: "invalid_frame" })
    );
  });
});

function harness(targetDeviceId: string, capabilities: Parameters<typeof createInProcessDevicePeerHarness>[0]["capabilities"]) {
  return createInProcessDevicePeerHarness({
    targetDeviceId,
    capabilities,
    agent: {
      async handle(frame) {
        return { outcome: "completed", value: { action: frame.action } };
      }
    }
  });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable.");
      resolvePromise(value);
    }
  };
}
