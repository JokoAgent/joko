import { describe, expect, it, vi } from "vitest";
import type { RoutineInput, RoutineState } from "@joko/core";
import { RoutineEngine, type RoutineEngineDeps } from "./partner-routine-engine.js";

const definition: RoutineInput = { name: "Daily review", prompt: "Review changes.", enabled: true, silentWhenIdle: false,
  triggers: [{ id: "interval", kind: "interval", intervalMs: 60000 }, { id: "event", kind: "event", sourceId: "extension:calendar", eventType: "changed", filters: [{ field: "scope", operator: "equals", value: "home" }] }] };
function fixture(execute: RoutineEngineDeps["execute"] = async () => ({}), initial: RoutineState | null = null) {
  let saved = initial; let now = 100000; let serial = 0;
  const save = vi.fn(async (state: RoutineState) => { saved = structuredClone(state); });
  const call = vi.fn(execute); const error = vi.fn();
  const deps = { load: async () => structuredClone(saved), save, execute: call, now: () => now, id: () => `identity-${++serial}`, changed: () => undefined, onError: error };
  const engine = new RoutineEngine(deps);
  return { engine, deps, save, call, error, saved: () => saved!, advance: (amount: number) => { now += amount; } };
}
async function idle(): Promise<void> { for (let i = 0; i < 30; i++) await Promise.resolve(); }
describe("durable routine admission", () => {
  it('lets built-in routines retain model and context choices while protecting their host instructions', async () => {
    const f = fixture(); await f.engine.start();
    const initial = await f.engine.ensureBuiltin('partner-one', definition, 'builtin-follow-up', 1);
    const modelOverride = { backendId: 'pi', providerId: 'test', modelId: 'model', effort: 'high', fastMode: false } as const;
    const edited = await f.engine.put('partner-one', { ...definition, sessionMode: 'fresh', modelOverride }, initial!.id, initial!.revision);
    await expect(f.engine.put('partner-one', { ...edited, prompt: 'Replace host instructions' }, edited.id, edited.revision)).rejects.toThrow('instructions');
    const ensured = await f.engine.ensureBuiltin('partner-one', definition, initial!.id, 1);
    expect(ensured).toMatchObject({ prompt: definition.prompt, sessionMode: 'fresh', modelOverride });
    await f.engine.stop();
  });
  it("commits a running receipt before effects, coalesces matching triggers, deduplicates publications and keeps one lane", async () => {
    let finish!: () => void;
    const f = fixture(async () => { expect(f.saved().runs.find(run => run.status === "running")).toBeDefined(); await new Promise<void>(resolve => { finish = resolve; }); return {}; });
    await f.engine.start(); const routine = await f.engine.createOnce("partner-one", definition, "routine-creation-stable");
    f.engine.registerSource({ id: "extension:calendar", name: "Calendar", events: [{ type: "changed", name: "Changed", fields: ["scope"] }], status: "listening" });
    const event = { id: "event-one", type: "changed", occurredAt: 100000, data: { scope: "home" } };
    expect(await f.engine.publish("extension:calendar", event)).toEqual({ accepted: 1, duplicate: false }); await idle(); expect(f.call).toHaveBeenCalledOnce();
    expect(await f.engine.publish("extension:calendar", event)).toEqual({ accepted: 0, duplicate: true });
    await f.engine.publish("extension:calendar", { ...event, id: "event-outside", data: { scope: "outside" } });
    await f.engine.publish("extension:calendar", { ...event, id: "event-self", originRoutineId: routine.id });
    await f.engine.publish("extension:calendar", { ...event, id: "event-two" }); f.advance(60000); await f.engine.tick(); await idle();
    const queued = f.engine.history(routine.id).filter(run => run.status === "queued");
    expect(queued).toHaveLength(1); expect(queued[0]?.triggerIds.sort()).toEqual(["event", "interval"]); expect(queued[0]?.events).toHaveLength(1); expect(f.call).toHaveBeenCalledOnce();
    const paused = f.engine.setPartnerPaused("partner-one", true); finish(); await paused; await idle(); await f.engine.stop();
    expect(f.engine.history(routine.id).some(run => run.status === "queued")).toBe(false); expect(f.engine.list()[0]?.enabled).toBe(true);
  });
  it("retries terminal persistence without replaying the effect and interrupts ambiguous restart receipts", async () => {
    const f = fixture(); await f.engine.start(); const routine = await f.engine.createOnce("partner-one", definition, "creation-terminal-save");
    let rejectTerminal = true;
    f.save.mockImplementation(async state => { if (rejectTerminal && state.runs.some(run => run.status === "success")) throw new Error("Disk unavailable"); f.deps.load = async () => structuredClone(state); });
    await f.engine.runNow("partner-one", routine.id, routine.revision, "run-stable-terminal"); await idle();
    expect(f.call).toHaveBeenCalledOnce(); expect(f.engine.history(routine.id)[0]?.status).toBe("running");
    rejectTerminal = false; f.advance(30001); await f.engine.tick(); await idle(); expect(f.call).toHaveBeenCalledOnce(); expect(f.engine.history(routine.id)[0]?.status).toBe("success");
    const saved = structuredClone(await f.deps.load())!; saved.runs[0]!.status = "running";
    const reopened = fixture(undefined, saved); await reopened.engine.start(); await idle(); expect(reopened.call).not.toHaveBeenCalled(); expect(reopened.engine.history(routine.id)[0]?.status).toBe("interrupted");
    await f.engine.stop(); await reopened.engine.stop();
  });
  it("keeps disabled preferences across lifecycle suspension and retires an absent creation before a delayed write", async () => {
    const f = fixture(); await f.engine.start();
    const on = await f.engine.createOnce("partner-one", definition, "creation-lifecycle-on");
    const off = await f.engine.createOnce("partner-one", { ...definition, enabled: false }, "creation-lifecycle-off");
    expect(f.engine.nextRunAt(on.id)).toEqual(expect.any(Number)); expect(f.engine.nextRunAt(off.id)).toBeUndefined();
    await f.engine.setPartnerPaused("partner-one", true); f.advance(120000); await f.engine.tick(); expect(f.call).not.toHaveBeenCalled();
    expect(f.engine.nextRunAt(on.id)).toBeUndefined();
    await f.engine.setPartnerPaused("partner-one", false); expect(f.engine.list().map(item => [item.id, item.enabled])).toEqual([[on.id, true], [off.id, false]]);
    expect(f.engine.nextRunAt(on.id)).toEqual(expect.any(Number)); expect(f.engine.nextRunAt(off.id)).toBeUndefined();
    await f.engine.retireCreation("partner-one", "creation-never-dispatched");
    await expect(f.engine.createOnce("partner-one", definition, "creation-never-dispatched")).rejects.toThrow();
    await expect(f.engine.remove("partner-one", on.id, async () => { throw new Error("Cleanup unavailable"); }, on.revision)).rejects.toThrow("Cleanup unavailable");
    const disabled = f.engine.list().find(item => item.id === on.id)!; expect(disabled.enabled).toBe(false);
    await f.engine.remove("partner-one", on.id, async () => undefined, disabled.revision); expect(f.engine.isRetired(on.id)).toBe(true);
    await expect(f.engine.createOnce("partner-one", definition, on.id)).rejects.toThrow(); await f.engine.stop();
  });
  it("rejects persistence failures before Queue admission and recovers the same request without another run", async () => {
    const f = fixture(); await f.engine.start(); const routine = await f.engine.createOnce("partner-one", definition, "creation-pre-dispatch");
    f.save.mockRejectedValueOnce(new Error("Write failed")); await expect(f.engine.runNow("partner-one", routine.id, 1, "stable-manual-request")).rejects.toThrow("Write failed");
    await idle(); expect(f.call).not.toHaveBeenCalled(); expect(f.engine.history(routine.id)).toEqual([]);
    await f.engine.runNow("partner-one", routine.id, 1, "stable-manual-request"); await idle(); await f.engine.runNow("partner-one", routine.id, 1, "stable-manual-request"); await idle();
    expect(f.call).toHaveBeenCalledOnce(); await f.engine.stop();
  });
});
