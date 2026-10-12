// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AppDefaultModelRouteValue } from "@joko/contracts";
import { emptySnapshot, type AppSnapshot } from "./model.js";
import type { AppDefaultModelUiPort } from "./app-default-model-ui.js";
import { startAppDefaultModelBridge } from "./app-default-model-bridge.js";
import { readAppDefaultModelPreference, setAppDefaultModelPreference } from "./app-default-model-preferences.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });
const primary = { backendId: "backend", providerId: "provider", modelId: "primary", effort: "low", fastMode: true };
const requested = { ...primary, modelId: "requested", effort: "high", fastMode: false };
it("confirms the persisted UI selection once and retains explicit false Fast tuning", async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.sync).toHaveBeenCalled());
  f.push("confirmed"); await vi.waitFor(() => expect(f.receipts).toEqual(["confirmed"]));
  expect(readAppDefaultModelPreference("node")).toMatchObject({ current: requested, tuning: expect.arrayContaining([requested]) });
  expect(f.sync.mock.calls.find(call => call[1].confirmedRequestId)?.[1].current).toEqual(requested);
});
it("does not acknowledge an expired, changed-owner, conflicting, or unpersisted UI request", async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.sync).toHaveBeenCalled());
  f.claim.mockImplementationOnce(async () => { f.advance(5_001); return { remainingMs: 4_000, expected: primary, requested }; });
  f.push("expired"); await vi.waitFor(() => expect(f.claim).toHaveBeenCalledTimes(1)); await vi.waitFor(() => expect(f.sync.mock.calls.length).toBeGreaterThan(1));
  expect(readAppDefaultModelPreference("node").current).toEqual(primary);
  f.claim.mockImplementationOnce(async () => { setAppDefaultModelPreference("node", { ...primary, modelId: "manual" }); return { remainingMs: 4_000, expected: primary, requested }; });
  f.push("conflict"); await vi.waitFor(() => expect(f.sync).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ current: expect.objectContaining({ modelId: "manual" }) }), expect.any(AbortSignal)));
  setAppDefaultModelPreference("node", primary);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  f.push("unpersisted"); await vi.waitFor(() => expect(f.claim).toHaveBeenCalledTimes(3)); await vi.waitFor(() => expect(write).toHaveBeenCalled()); write.mockRestore();
  f.claim.mockImplementationOnce(async () => { f.changeOwner(); return { remainingMs: 4_000, expected: primary, requested }; });
  f.push("changed-owner"); await vi.waitFor(() => expect(f.claim).toHaveBeenCalledTimes(4));
  expect(f.receipts).toEqual([]); expect(readAppDefaultModelPreference("node").current).toEqual(primary);
});
function fixture() {
  window.localStorage.clear(); setAppDefaultModelPreference("node", primary);
  const abort = new AbortController(), messages: { ready: boolean; requestId: string }[] = [{ ready: true, requestId: "" }];
  let wake: (() => void) | undefined, now = 0, active = true;
  const receipts: string[] = [];
  const sync = vi.fn<AppDefaultModelUiPort["syncAppDefaultModel"]>(async (_owner, mirror) => { if (mirror.confirmedRequestId) receipts.push(mirror.confirmedRequestId); return true; });
  const claim = vi.fn<AppDefaultModelUiPort["claimAppDefaultModel"]>(async () => ({ remainingMs: 4_000, expected: primary, requested }));
  const port: AppDefaultModelUiPort = { syncAppDefaultModel: sync, claimAppDefaultModel: claim,
    watchAppDefaultModel: async function* (_id, signal) {
      const stop = () => wake?.(); signal.addEventListener("abort", stop, { once: true });
      try { while (!signal.aborted) { if (!messages.length) await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; if (signal.aborted) break; yield messages.shift()!; } }
      finally { signal.removeEventListener("abort", stop); }
    }
  };
  const snapshot: AppSnapshot = { ...emptySnapshot(), backends: [{ id: primary.backendId, name: "Backend", version: "1", health: "healthy", capabilities: new Map(
    ["model.effort", "model.fast_mode"].map(name => [name, { name, supported: true, options: [] }])) }],
    models: [primary, requested].map(route => ({ ...route, providerName: "Provider", name: route.modelId, available: true, supportsFast: true, supportsImages: false,
      inputModalities: ["text"], outputModalities: ["text"], efforts: ["low", "high"], contextWindow: 1, maximumOutputTokens: 1, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" })) };
  const bridge = startAppDefaultModelBridge(port, "node", { signal: abort.signal, assertCurrent: () => { if (!active) throw new Error("Owner changed"); }, snapshot: () => snapshot, now: () => now });
  cleanups.push(async () => { abort.abort(); await bridge.task.catch(() => undefined); });
  return { sync, claim, receipts, push(id: string) { messages.push({ ready: false, requestId: id }); wake?.(); }, advance(ms: number) { now += ms; }, changeOwner() { active = false; } };
}
