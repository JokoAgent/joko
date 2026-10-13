import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import type { ProviderModel } from "@joko/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelWorkingContextCoordinator, type ModelRouteTarget, type ModelWorkingContextRoute } from "./model-working-context.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const target = { backendId: "one", providerId: "provider", modelId: "model-one" };
const related = { backendId: "two", providerId: "provider", modelId: "model-two" };
const third = { backendId: "three", providerId: "provider", modelId: "model-three" };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "joko-working-context-")), store = new OperationalStore(join(directory, "state.sqlite"));
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let owner: { ownerId: string; generation: number } | undefined = { ownerId: "node", generation: 1 };
  const model: ProviderModel = { providerId: "provider", modelId: "model-one", displayName: "Model", api: "openai-responses", contextWindow: 128000,
    maxOutputTokens: 10000, supportsImages: false, thinkingLevels: ["low", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const routes = new Map<string, ModelWorkingContextRoute>([target, related, third].map((item, index) => [item.backendId, {
    model: { ...model, modelId: item.modelId, contextWindow: 128000 + index * 1000 }, catalogRevision: 1n,
    instanceGeneration: 1, supported: true, available: true }]));
  const refresh = vi.fn(async (_targets: readonly ModelRouteTarget[], assertCurrent: () => void) => { assertCurrent(); });
  const coordinator = new ModelWorkingContextCoordinator({ store, currentOwner: () => owner,
    resolveRoute: item => routes.get(item.backendId), refresh });
  const edit = async (item: ModelRouteTarget, limit?: number, relatedTargets?: readonly ModelRouteTarget[]) => {
    const query = { target: item, relatedTargets }, observation = await coordinator.read(query);
    return coordinator.set({ ...query, limit, operationId: "edit", expectedRevision: observation.revision, expectedSourceRevision: observation.sourceRevision });
  };
  return { coordinator, store, routes, refresh, edit, retire: (value: typeof owner) => { owner = value; } };
}
describe("ModelWorkingContextCoordinator", () => {
  it("writes three exact routes atomically above capacity, preserves declared capacity and compares nullable overrides", async () => {
    const fixture = setup();
    const initial = await fixture.coordinator.read({ target, relatedTargets: [related] });
    expect(initial).toMatchObject({ mixed: false, customized: false }); expect(initial.limitTokens).toBeUndefined();
    const result = await fixture.edit(target, 256000, [related]);
    expect(result).toMatchObject({ limitTokens: 256000, defaultContextWindowTokens: 128000, effectiveContextWindowTokens: 256000, mixed: false, customized: true });
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.resolve(related)).toBe(256000); expect(fixture.routes.get("one")?.model.contextWindow).toBe(128000);
    expect(await fixture.coordinator.read({ target, relatedTargets: [third] })).toMatchObject({ mixed: true });
    await fixture.edit(target, 100_000_000, [related, third]);
    expect(fixture.coordinator.resolve(third)).toBe(100_000_000);
  });
  it("reads and truly resets a removed override while a new Set requires every current exact catalog member", async () => {
    const fixture = setup(); await fixture.edit(target, 64000); fixture.routes.delete("one");
    expect(await fixture.coordinator.read({ target })).toMatchObject({ limitTokens: 64000, canConfigure: false, blockedReason: "model_unavailable" });
    await expect(fixture.edit(target, 32000)).rejects.toMatchObject({ reason: "unsupported" });
    const result = await fixture.edit(target);
    expect(result).toMatchObject({ customized: false }); expect(result.limitTokens).toBeUndefined();
    expect(fixture.store.getSetting<{ entries: unknown[] }>("service", "node", "settings.model_working_context").value.entries).toEqual([]);
  });
  it("rejects stale setting and catalog observations and same-provider duplicate Backend targets before mutation", async () => {
    const fixture = setup(), observation = await fixture.coordinator.read({ target });
    await fixture.edit(related, 64000);
    await expect(fixture.coordinator.set({ target, limit: 64000, operationId: "stale", expectedRevision: observation.revision, expectedSourceRevision: observation.sourceRevision })).rejects.toMatchObject({ reason: "conflict" });
    const fresh = await fixture.coordinator.read({ target }); fixture.routes.set("one", { ...fixture.routes.get("one")!, catalogRevision: 2n });
    await expect(fixture.coordinator.set({ target, limit: 64000, operationId: "source", expectedRevision: fresh.revision, expectedSourceRevision: fresh.sourceRevision })).rejects.toMatchObject({ reason: "conflict" });
    await expect(fixture.coordinator.read({ target, relatedTargets: [{ ...target, modelId: "different" }] })).rejects.toMatchObject({ reason: "invalid" });
    await expect(fixture.edit(target, 999)).rejects.toMatchObject({ reason: "invalid" });
  });
  it("rolls back only this edit's still-owned keys and preserves a newer same-value ABA edit and unrelated writes", async () => {
    const fixture = setup(); await fixture.edit(target, 32000); await fixture.edit(related, 32000);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    fixture.refresh.mockImplementationOnce(async () => { await wait; throw new Error("internal path must never escape"); });
    const first = fixture.edit(target, 64000, [related]);
    await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(3));
    await fixture.edit(target, 64000); await fixture.edit(third, 96000); release();
    await expect(first).rejects.toMatchObject({ reason: "refresh_failed" });
    expect(fixture.coordinator.resolve(target)).toBe(64000); expect(fixture.coordinator.resolve(related)).toBe(32000); expect(fixture.coordinator.resolve(third)).toBe(96000);
  });
  it("restores the captured old owner's edit without refreshing or touching a replacement owner", async () => {
    const fixture = setup(); await fixture.edit(target, 32000);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    fixture.refresh.mockImplementationOnce(async () => { await wait; });
    const pending = fixture.edit(target, 64000); await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(2));
    fixture.retire({ ownerId: "other", generation: 2 }); await fixture.edit(target, 96000); release();
    await expect(pending).rejects.toMatchObject({ reason: "owner_changed" });
    expect(fixture.coordinator.resolve(target)).toBe(96000);
    fixture.retire({ ownerId: "node", generation: 1 }); expect(fixture.coordinator.resolve(target)).toBe(32000);
  });
  it("cancels a pending apply, restores the actual setting and rejects malformed v1 data", async () => {
    const fixture = setup(), observation = await fixture.coordinator.read({ target }), controller = new AbortController();
    fixture.refresh.mockImplementationOnce(async () => { controller.abort(); });
    await expect(fixture.coordinator.set({ target, limit: 64000, operationId: "cancel", expectedRevision: observation.revision,
      expectedSourceRevision: observation.sourceRevision }, controller.signal)).rejects.toMatchObject({ reason: "cancelled" });
    expect(await fixture.coordinator.read({ target })).toMatchObject({ customized: false, effectiveContextWindowTokens: 128000 });
    fixture.store.setSetting("service", "node", "settings.model_working_context", { format: 0, entries: [] });
    await expect(fixture.coordinator.read({ target })).rejects.toMatchObject({ reason: "invalid" });
  });
  it("keeps the 4096-entry ceiling without blocking a no-op Reset and accepts a bounded long operation identity", async () => {
    const fixture = setup();
    const entries = Array.from({ length: 4096 }, (_, index) => ({ target: { backendId: `backend-${index}`, providerId: "provider", modelId: "model" }, overrideTokens: 64000, lastEditId: `edit-${index}` }));
    fixture.store.setSetting("service", "node", "settings.model_working_context", { format: 1, entries });
    await fixture.edit(target); expect(fixture.store.getSetting<{ entries: unknown[] }>("service", "node", "settings.model_working_context").value.entries).toHaveLength(4096);
    await expect(fixture.edit(target, 64000)).rejects.toMatchObject({ reason: "invalid" });
    const existing = entries[0]!.target; fixture.routes.set(existing.backendId, { ...fixture.routes.get("one")!, model: { ...fixture.routes.get("one")!.model, modelId: existing.modelId } });
    const observed = await fixture.coordinator.read({ target: existing });
    await fixture.coordinator.set({ target: existing, operationId: "x".repeat(256), expectedRevision: observed.revision, expectedSourceRevision: observed.sourceRevision, limit: 96000 });
    expect((await fixture.coordinator.read({ target: existing })).limitTokens).toBe(96000);
  });
  it("restores an actual reset's removed override after failure without overwriting an independent edit", async () => {
    const fixture = setup(); await fixture.edit(target, 32000);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    fixture.refresh.mockImplementationOnce(async () => { await wait; throw new Error("Native reset did not confirm"); });
    const pending = fixture.edit(target); await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(2));
    expect((await fixture.coordinator.read({ target })).customized).toBe(false); await fixture.edit(related, 96000); release();
    await expect(pending).rejects.toMatchObject({ reason: "refresh_failed" });
    expect(fixture.coordinator.resolve(target)).toBe(32000); expect(fixture.coordinator.resolve(related)).toBe(96000);
  });
});
