import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { RunPersonalDevelopmentActionResponseSchema, GetPersonalDevelopmentStateResponseSchema,
  ControlPersonalDevelopmentTaskResponseSchema, StartPersonalDevelopmentTaskResponseSchema, StartPersonalDevelopmentDoctorResponseSchema, ControlPersonalDevelopmentDoctorResponseSchema,
  PersonalDevelopmentStateSchema, PersonalDevelopmentDoctorRunSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalDevelopmentGateway } from "./personal-development-gateway.js";

describe("personal development generated gateway", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    [{}, false, false], [{ fastMode: true }, true, false], [{ ultrafastMode: true }, false, true]
  ] as const)("preserves optional generated speed flags on both task and doctor requests: %s", async (speed, fastMode, ultrafastMode) => {
    const requests: Array<{ method: string; input: unknown }> = [];
    const transport = { unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.name, input });
      return method.name === "StartPersonalDevelopmentTask"
        ? response(method, create(StartPersonalDevelopmentTaskResponseSchema, { operationId: input.operationId, taskId: "task" }))
        : response(method, create(StartPersonalDevelopmentDoctorResponseSchema, { operationId: input.operationId, report: { runId: "doctor", mode: input.mode } }));
    }) } as unknown as Transport;
    const gateway = createPersonalDevelopmentGateway(transport, new AbortController().signal);
    await gateway.startPersonalDevelopmentTask(speed, "original-task-request");
    await gateway.startPersonalDevelopmentDoctor({ ...speed, mode: "check" }, "original-doctor-request");
    expect(requests).toEqual([
      { method: "StartPersonalDevelopmentTask", input: expect.objectContaining({ operationId: "original-task-request", fastMode, ultrafastMode }) },
      { method: "StartPersonalDevelopmentDoctor", input: expect.objectContaining({ operationId: "original-doctor-request", fastMode, ultrafastMode }) }
    ]);
    await expect(gateway.startPersonalDevelopmentDoctor({ mode: "check", fastMode: true, ultrafastMode: true }, "conflicting-request")).rejects.toThrow("Conflicting");
    expect(requests).toHaveLength(2);
  });

  it("consumes concrete generated replies and observes through finite Get requests", async () => {
    const methods: string[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        methods.push(method.name);
        switch (method.name) {
          case "GetPersonalDevelopmentState": return response(method, create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state() }));
          case "RunPersonalDevelopmentAction": return response(method, create(RunPersonalDevelopmentActionResponseSchema, { operationId: input.operationId, state: state() }));
          case "ControlPersonalDevelopmentTask": return response(method, create(ControlPersonalDevelopmentTaskResponseSchema, { operationId: input.operationId, state: state() }));
          case "StartPersonalDevelopmentDoctor": return response(method, create(StartPersonalDevelopmentDoctorResponseSchema, { operationId: input.operationId, report: { runId: "doctor-run", mode: input.mode } }));
          case "ControlPersonalDevelopmentDoctor": return response(method, create(ControlPersonalDevelopmentDoctorResponseSchema, { operationId: input.operationId, report: { runId: input.runId, mode: "check" } }));
          default: throw new Error(`Unexpected RPC ${method.name}`);
        }
      }),
      stream: vi.fn()
    } as unknown as Transport;
    const gateway = createPersonalDevelopmentGateway(transport, new AbortController().signal), update = vi.fn();
    await expect(gateway.getPersonalDevelopment()).resolves.toMatchObject({ available: true, state: { generation: 1n } });
    const observation = new AbortController();
    await gateway.watchPersonalDevelopment(0n, value => { update(value); observation.abort(); }, observation.signal);
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ available: true, state: expect.objectContaining({ generation: 1n }) }));
    await expect(gateway.runPersonalDevelopmentAction({ case: "cancel", value: { operationId: "build" } }, "cancel-request")).resolves.toMatchObject({ generation: 1n });
    await expect(gateway.controlPersonalDevelopmentTask("task", "end", "", "end-request")).resolves.toMatchObject({ generation: 1n });
    await expect(gateway.startPersonalDevelopmentDoctor({ mode: "check", permissionMode: "ask" }, "start-report")).resolves.toMatchObject({ runId: "doctor-run" });
    await expect(gateway.controlPersonalDevelopmentDoctor("doctor-run", "cancel", "cancel-report")).resolves.toMatchObject({ runId: "doctor-run" });
    expect(methods).toEqual(["GetPersonalDevelopmentState", "GetPersonalDevelopmentState", "RunPersonalDevelopmentAction",
      "ControlPersonalDevelopmentTask", "StartPersonalDevelopmentDoctor", "ControlPersonalDevelopmentDoctor"]);
    expect(transport.stream).not.toHaveBeenCalled();
  });

  it("discovers reports after an empty snapshot, rejects older generations and retires unavailable observations", async () => {
    vi.useFakeTimers();
    let current = create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state(1n) });
    const unary = vi.fn(async (method: any) => response(method, current));
    const transport = { unary, stream: vi.fn() } as unknown as Transport;
    const scope = new AbortController(), update = vi.fn();
    const watch = createPersonalDevelopmentGateway(transport, scope.signal).watchPersonalDevelopment(0n, update, scope.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.objectContaining({ generation: 1n, doctorRuns: [] }) }));
    const later = state(2n); later.doctorRuns = [create(PersonalDevelopmentDoctorRunSchema, { runId: "new-report", mode: "check" })];
    current = create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: later });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.objectContaining({ generation: 2n, doctorRuns: [expect.objectContaining({ runId: "new-report" })] }) }));
    current = create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state(1n) });
    await vi.advanceTimersByTimeAsync(1_000); expect(update).toHaveBeenCalledTimes(2);
    current = create(GetPersonalDevelopmentStateResponseSchema, { available: false, unavailableReason: "native-host-unavailable" });
    await vi.advanceTimersByTimeAsync(1_000); await watch;
    expect(update).toHaveBeenLastCalledWith({ available: false, unavailableReason: "native-host-unavailable", state: undefined });
    const reads = unary.mock.calls.length; await vi.advanceTimersByTimeAsync(5_000);
    expect(unary).toHaveBeenCalledTimes(reads); expect(transport.stream).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only one bounded read at a time and ignores an expired read's late answer", async () => {
    vi.useFakeTimers();
    const first = deferred<any>(); let reads = 0, active = 0, maximumActive = 0, firstSignal: AbortSignal | undefined;
    const unary = vi.fn((method: any, signal: AbortSignal) => {
      reads++; active++; maximumActive = Math.max(maximumActive, active);
      let live = true; const release = () => { if (live) { live = false; active--; } };
      signal.addEventListener("abort", release, { once: true });
      if (reads === 1) { firstSignal = signal; return first.promise.then(value => { release(); return response(method, value); }); }
      release(); return Promise.resolve(response(method, create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state(2n) })));
    });
    const transport = { unary } as unknown as Transport, scope = new AbortController(), update = vi.fn();
    const watch = createPersonalDevelopmentGateway(transport, scope.signal).watchPersonalDevelopment(0n, update, scope.signal);
    await vi.advanceTimersByTimeAsync(4_999); expect(unary).toHaveBeenCalledOnce(); expect(firstSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(firstSignal?.aborted).toBe(true); expect(unary).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999); expect(unary).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(unary).toHaveBeenCalledTimes(2); expect(maximumActive).toBe(1);
    first.resolve(create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state(99n) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: expect.objectContaining({ generation: 2n }) }));
    scope.abort(); await watch; expect(vi.getTimerCount()).toBe(0);
  });

  it("seeds and wakes only same-transport observations after a verified write receipt", async () => {
    vi.useFakeTimers();
    let generation = 1n, receipt = "action-request";
    const unary = vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.name === "GetPersonalDevelopmentState") return response(method, create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state(generation) }));
      if (method.name === "StartPersonalDevelopmentDoctor") return response(method, create(StartPersonalDevelopmentDoctorResponseSchema, { operationId: input.operationId, report: { runId: "doctor", mode: input.mode } }));
      return response(method, create(RunPersonalDevelopmentActionResponseSchema, { operationId: receipt, state: state(generation) }));
    });
    const transport = { unary } as unknown as Transport, scope = new AbortController(), update = vi.fn();
    const observed = createPersonalDevelopmentGateway(transport, scope.signal);
    const watch = observed.watchPersonalDevelopment(0n, update, scope.signal); await vi.advanceTimersByTimeAsync(0);
    const reads = () => unary.mock.calls.filter(call => call[0].name === "GetPersonalDevelopmentState").length;
    const action = { case: "cancel", value: { operationId: "job" } } as const;
    generation = 2n;
    await createPersonalDevelopmentGateway({ unary } as unknown as Transport, scope.signal).runPersonalDevelopmentAction(action, receipt);
    expect(reads()).toBe(1); expect(update).toHaveBeenCalledTimes(1);
    await createPersonalDevelopmentGateway(transport, scope.signal).runPersonalDevelopmentAction(action, receipt);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(2); expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.objectContaining({ generation: 2n }) }));
    generation = 3n; receipt = "another-request";
    await expect(observed.runPersonalDevelopmentAction(action, "action-request")).rejects.toThrow("another action");
    expect(reads()).toBe(2); expect(update).toHaveBeenCalledTimes(2);
    await observed.startPersonalDevelopmentDoctor({ mode: "check" }, "doctor-request"); await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(3); expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.objectContaining({ generation: 3n }) }));
    scope.abort(); await watch; expect(vi.getTimerCount()).toBe(0);
  });

  it("retires page-hidden and replaced owners, clears timers and refuses late reads or receipt wakes", async () => {
    vi.useFakeTimers(); const page = new EventTarget(); vi.stubGlobal("window", page);
    const pending = deferred<any>(); let readSignal: AbortSignal | undefined;
    const unary = vi.fn((method: any, signal: AbortSignal, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.name === "GetPersonalDevelopmentState") { readSignal = signal; return pending.promise.then(value => response(method, value)); }
      return Promise.resolve(response(method, create(RunPersonalDevelopmentActionResponseSchema, { operationId: input.operationId, state: state(2n) })));
    });
    const transport = { unary } as unknown as Transport, owner = new AbortController(), update = vi.fn();
    const gateway = createPersonalDevelopmentGateway(transport, owner.signal);
    const watch = gateway.watchPersonalDevelopment(0n, update, new AbortController().signal); await vi.advanceTimersByTimeAsync(0);
    page.dispatchEvent(new Event("pagehide")); await watch;
    expect(readSignal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state(9n) })); await vi.advanceTimersByTimeAsync(0);
    await gateway.runPersonalDevelopmentAction({ case: "cancel", value: { operationId: "job" } }, "after-pagehide");
    expect(update).not.toHaveBeenCalled(); expect(unary.mock.calls.filter(call => call[0].name === "GetPersonalDevelopmentState")).toHaveLength(1);
    const next = gateway.watchPersonalDevelopment(0n, update, new AbortController().signal); await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledOnce(); owner.abort(); await next;
    await vi.advanceTimersByTimeAsync(5_000); expect(vi.getTimerCount()).toBe(0); expect(update).toHaveBeenCalledOnce();
  });

  it("keeps the caller's immutable action identity and refuses another action's receipt", async () => {
    const calls: unknown[] = [];
    let receipt = "action-1";
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: unknown) => {
        calls.push(input);
        return response(method, create(RunPersonalDevelopmentActionResponseSchema, { operationId: receipt, state: state() }));
      })
    } as unknown as Transport;
    const gateway = createPersonalDevelopmentGateway(transport, new AbortController().signal);
    const action = { case: "cancel", value: { operationId: "build-1" } } as const;
    await expect(gateway.runPersonalDevelopmentAction(action, "action-1")).resolves.toMatchObject({ generation: 1n });
    expect(calls).toEqual([{ operationId: "action-1", action }]);
    receipt = "build-1";
    await expect(gateway.runPersonalDevelopmentAction(action, "action-1")).rejects.toThrow("another action");
  });

  it("retires a late generated reply after the managed connection changes", async () => {
    let finish!: (value: unknown) => void;
    const transport = { unary: vi.fn((method: any) => new Promise(resolve => {
      finish = () => resolve(response(method, create(GetPersonalDevelopmentStateResponseSchema, { available: true, state: state() })));
    })) } as unknown as Transport;
    const owner = new AbortController(), gateway = createPersonalDevelopmentGateway(transport, owner.signal);
    const pending = gateway.getPersonalDevelopment();
    owner.abort(); finish(undefined);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

function state(generation = 1n) { return create(PersonalDevelopmentStateSchema, { generation, environment: { status: "ready" }, source: { status: "ready" }, versions: { selected: "original" } }); }
function response(method: any, message: { readonly $typeName: string }): any {
  expect(message.$typeName).toBe(method.output.typeName);
  return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
