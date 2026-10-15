import { PersonalDevelopmentError, type DevelopmentState, type PersonalDevelopmentOwner } from "@joko/personal-development";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalDevelopmentSettingsEnvironment } from "./personal-development-settings-environment.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const store = new OperationalStore(":memory:"); cleanups.push(() => store.close());
  let state: DevelopmentState = { format: 1, generation: 1, environment: { status: "unchecked", checks: [] }, source: { status: "missing" }, tasks: {}, history: [],
    versions: { selected: "original", switching: false }, operations: {} };
  const listeners = new Set<(state: DevelopmentState) => void>();
  const publish = () => { for (const listener of listeners) listener(state); };
  let finishTools: (() => void) | undefined;
  const check = vi.fn(async ({ operationId }: { operationId: string }) => {
    state = { ...state, environment: { status: "preparing", checks: [{ id: "git", status: "downloading", source: "managed", progress: { loaded: 25, total: 100, percent: 25 } }] },
      operations: { ...state.operations, [operationId]: { id: operationId, inputHash: "private", kind: "environment-prepare", status: "running", stage: "installing:git", startedAt: 1 } } };
    publish(); await new Promise<void>(resolve => { finishTools = resolve; });
    state = { ...state, environment: { status: "ready", checks: (["git", "gitLfs", "node", "pnpm", "python"] as const).map(id => ({ id, status: "ready", version: "1", executable: "D:/private/tool", source: "managed" })) },
      operations: { ...state.operations, [operationId]: { ...state.operations[operationId]!, status: "succeeded", stage: "completed", finishedAt: 2 } } };
    publish(); return { operationId, value: state.environment.checks, replayed: false };
  });
  const cancel = vi.fn(() => true), assertAvailable = vi.fn();
  const owner = { snapshot: () => state, checkEnvironment: check, prepareEnvironment: check, cancel,
    subscribe: (listener: (state: DevelopmentState) => void) => { listeners.add(listener); listener(state); return () => listeners.delete(listener); } } as unknown as PersonalDevelopmentOwner;
  let finishNative: (() => void) | undefined;
  const native = vi.fn(async (signal: AbortSignal) => { await new Promise<void>(resolve => { finishNative = resolve; }); signal.throwIfAborted(); return { id: "native", status: "ready" as const }; });
  const storage = vi.fn(async () => ({ id: "storage", status: "ready" as const, freeGiB: 100 }));
  const options = { store, ownerId: "local-owner", owner, assertAvailable, platform: "win32", arch: "x64",
    prerequisites: { platform: () => ({ id: "platform", status: "ready" as const }), native, storage } };
  const environment = new PersonalDevelopmentSettingsEnvironment(options); environment.initialize(); cleanups.push(async () => { finishTools?.(); finishNative?.(); await environment.dispose(); });
  return { environment, options, store, check, native, storage, cancel, finishTools: () => finishTools!(), finishNative: () => finishNative!() };
}
describe("full Settings environment jobs", () => {
  it("admits once, preserves real managed download progress and stays running until native and storage finish without a Session", async () => {
    const f = fixture(), input = { operationId: "prepare-settings", mode: "prepare" as const };
    expect(f.environment.run(input)).toBe(input.operationId); expect(f.check).not.toHaveBeenCalled();
    expect(f.environment.run(input)).toBe(input.operationId);
    await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
    expect(f.environment.snapshot()).toMatchObject({ status: "preparing", checks: expect.arrayContaining([
      { id: "git", status: "downloading", source: "managed", progress: { loaded: 25, total: 100, percent: 25 } }
    ]), operation: { kind: "settings-environment-prepare", status: "running" } });
    expect(() => f.environment.run({ operationId: "other-check", mode: "check" })).toThrow(PersonalDevelopmentError);
    f.finishTools(); await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce());
    expect(f.environment.snapshot()).toMatchObject({ status: "preparing", operation: { status: "running", stage: "native" } });
    f.finishNative(); await vi.waitFor(() => expect(f.environment.snapshot()?.status).toBe("ready"));
    expect(f.environment.snapshot()?.checks).toHaveLength(8); expect(f.storage).toHaveBeenCalledOnce();
    expect(f.store.listSessions()).toEqual([]); expect(JSON.stringify(f.environment.snapshot())).not.toContain("private/tool");
    expect(f.environment.run(input)).toBe(input.operationId); expect(f.check).toHaveBeenCalledOnce();
    const recovered = new PersonalDevelopmentSettingsEnvironment(f.options); recovered.initialize(); cleanups.push(() => recovered.dispose());
    expect(recovered.snapshot()).toEqual(f.environment.snapshot());
  });
  it("keeps cancellation pending until the exact native probe settles and marks interrupted startup unknown", async () => {
    const f = fixture(); f.environment.run({ operationId: "check-settings", mode: "check" });
    await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce()); f.finishTools(); await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce());
    expect(f.environment.cancel("check-settings")).toBe(true); expect(f.environment.snapshot()?.operation?.status).toBe("running");
    f.finishNative(); await vi.waitFor(() => expect(f.environment.snapshot()?.status).toBe("cancelled")); expect(f.storage).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledWith("check-settings");
    const current = f.store.findSetting("service", "personal-development-settings-environment", "local-owner")!.value as Record<string, unknown>;
    f.store.setSetting("service", "personal-development-settings-environment", "local-owner", { ...current,
      environment: { ...f.environment.snapshot()!, status: "checking", operation: { ...f.environment.snapshot()!.operation!, status: "running" } } });
    const recovered = new PersonalDevelopmentSettingsEnvironment(f.options); recovered.initialize(); cleanups.push(() => recovered.dispose());
    expect(recovered.snapshot()).toMatchObject({ status: "unknown", operation: { status: "unknown", error: "PROCESS_UNKNOWN" } });
    expect(f.check).toHaveBeenCalledOnce();
  });
});
