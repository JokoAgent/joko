import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, StaleGenerationError, StoreError } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("durable usage ledger", () => {
  it("deduplicates cumulative observations across restarts and attributes only new deltas", () => {
    const fixture = createFixture();
    const first = fixture.store.recordUsageObservation(observation({
      measuredAt: Date.UTC(2026, 7, 23, 12),
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125
    }));
    expect(first).toMatchObject({ changed: true, inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(first.costMicros).toBe(350);
    expect(fixture.store.recordUsageObservation(observation({
      measuredAt: Date.UTC(2026, 7, 23, 12, 1),
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125
    })).changed).toBe(false);

    fixture.reopen();
    const later = fixture.store.recordUsageObservation(observation({
      measuredAt: Date.UTC(2026, 7, 24, 1),
      inputTokens: 150,
      outputTokens: 40,
      totalTokens: 190
    }));
    expect(later).toMatchObject({ inputTokens: 50, outputTokens: 15, totalTokens: 65, day: "2026-08-24" });
    expect(later.costMicros).toBe(190);

    const rows = fixture.store.listUsageLedger({ ownerId: "owner-a" });
    expect(rows.map((row) => ({ day: row.day, input: row.inputTokens, output: row.outputTokens, cost: row.costMicros }))).toEqual([
      { day: "2026-08-23", input: 100, output: 25, cost: 350 },
      { day: "2026-08-24", input: 50, output: 15, cost: 190 }
    ]);
    expect(fixture.store.listUsageLedger({ ownerId: "owner-b" })).toEqual([]);
  });

  it("deduplicates independent cumulative sources without colliding with the Session runtime cursor", () => {
    const fixture = createFixture();
    fixture.store.recordUsageObservation(observation({
      inputTokens: 100,
      totalTokens: 100
    }));
    const child = observation({
      sourceId: "delegated-run:worker-a",
      providerId: "provider-child",
      modelId: "model-child",
      inputTokens: 40,
      totalTokens: 40,
      reportedCostMicros: 400,
      costRates: undefined
    });
    expect(fixture.store.recordUsageObservation(child)).toMatchObject({
      changed: true,
      inputTokens: 40,
      totalTokens: 40,
      costMicros: 400
    });
    expect(fixture.store.recordUsageObservation(child).changed).toBe(false);

    fixture.reopen();
    expect(fixture.store.recordUsageObservation({
      ...child,
      measuredAt: child.measuredAt + 1,
      inputTokens: 55,
      totalTokens: 55,
      reportedCostMicros: 550
    })).toMatchObject({ changed: true, inputTokens: 15, totalTokens: 15, costMicros: 150 });
    expect(fixture.store.recordUsageObservation(observation({
      measuredAt: child.measuredAt + 2,
      inputTokens: 100,
      totalTokens: 100
    })).changed).toBe(false);

    expect(fixture.store.listUsageLedger({ ownerId: "owner-a", providerId: "provider-child" }))
      .toEqual([expect.objectContaining({ inputTokens: 55, totalTokens: 55, costMicros: 550 })]);
    expect(fixture.store.summarizeUsageLedger({ ownerId: "owner-a" }))
      .toMatchObject({ inputTokens: 155, totalTokens: 155 });
  });

  it("ignores out-of-order cumulative observations and rejects conflicting equal-time payloads", () => {
    const fixture = createFixture();
    const newer = observation({
      measuredAt: 2_000,
      inputTokens: 100,
      totalTokens: 100,
      reportedCostMicros: 100_000,
      costRates: undefined
    });
    expect(fixture.store.recordUsageObservation(newer)).toMatchObject({
      changed: true,
      inputTokens: 100,
      totalTokens: 100,
      costMicros: 100_000
    });
    expect(fixture.store.recordUsageObservation({
      ...newer,
      measuredAt: 1_000,
      inputTokens: 50,
      totalTokens: 50,
      reportedCostMicros: 50_000
    })).toMatchObject({ changed: false, inputTokens: 0, totalTokens: 0, costMicros: 0 });
    expect(fixture.store.recordUsageObservation(newer).changed).toBe(false);
    expect(() => fixture.store.recordUsageObservation({
      ...newer,
      inputTokens: 101,
      totalTokens: 101
    })).toThrow(StoreError);

    expect(fixture.store.summarizeUsageLedger({ ownerId: "owner-a" })).toMatchObject({
      inputTokens: 100,
      totalTokens: 100,
      costMicros: 100_000
    });
  });

  it("survives generation/model changes without recounting a cumulative prefix and handles rollback", () => {
    const fixture = createFixture();
    fixture.store.recordUsageObservation(observation({
      measuredAt: Date.UTC(2026, 7, 23),
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100
    }));
    const session = fixture.store.getSession("session-1");
    fixture.store.updateSession("session-1", {
      binding: { ...session.descriptor.binding, generation: 1 },
      providerId: "provider-b",
      modelId: "model-b"
    }, session.revision, Date.UTC(2026, 7, 24));

    const handoff = fixture.store.recordUsageObservation(observation({
      generation: 1,
      providerId: "provider-b",
      modelId: "model-b",
      measuredAt: Date.UTC(2026, 7, 24, 1),
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100
    }));
    expect(handoff.changed).toBe(false);
    const rollback = fixture.store.recordUsageObservation(observation({
      generation: 1,
      providerId: "provider-b",
      modelId: "model-b",
      measuredAt: Date.UTC(2026, 7, 24, 2),
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      reportedCostMicros: 45,
      costRates: undefined
    }));
    expect(rollback).toMatchObject({ changed: true, inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    // An authoritative cost appearing after an estimated prefix is baselined,
    // not added in full a second time.
    expect(rollback.costMicros).toBe(0);
    expect(rollback.costComplete).toBe(false);

    const next = fixture.store.recordUsageObservation(observation({
      generation: 1,
      providerId: "provider-b",
      modelId: "model-b",
      measuredAt: Date.UTC(2026, 7, 24, 3),
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      reportedCostMicros: 75,
      costRates: undefined
    }));
    expect(next.costMicros).toBe(30);
    expect(next.estimated).toBe(false);

    const rows = fixture.store.listUsageLedger({ ownerId: "owner-a", providerId: "provider-b" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ generation: 1, modelId: "model-b", inputTokens: 20, outputTokens: 5, totalTokens: 25, costMicros: 30, costComplete: false });
    expect(fixture.store.summarizeUsageLedger({ ownerId: "owner-a" })).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      costComplete: false
    });
  });

  it("rejects stale generations and keeps unknown pricing explicit", () => {
    const fixture = createFixture();
    expect(() => fixture.store.recordUsageObservation(observation({ generation: 1 }))).toThrow(StaleGenerationError);
    const result = fixture.store.recordUsageObservation(observation({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      costRates: undefined
    }));
    expect(result).toMatchObject({ changed: true, costMicros: 0, costComplete: false, estimated: true });
    expect(fixture.store.listUsageLedger({ ownerId: "owner-a" })[0]).toMatchObject({
      costMicros: 0,
      costComplete: false,
      estimated: true,
      currencyCode: "USD"
    });
  });

  it("keeps exact Backend/Provider/model price overrides isolated and restorable", () => {
    const fixture = createFixture();
    const saved = fixture.store.upsertModelPriceOverride({
      ownerId: "owner-a",
      backendId: "backend-a",
      providerId: "provider-a",
      modelId: "model-a",
      currencyCode: "CNY",
      inputCostMicrosPerMillion: 7_500_000,
      outputCostMicrosPerMillion: 21_000_000,
      cacheReadCostMicrosPerMillion: 750_000,
      updatedAt: 42
    });
    expect(saved).toMatchObject({
      ownerId: "owner-a",
      backendId: "backend-a",
      providerId: "provider-a",
      modelId: "model-a",
      currencyCode: "CNY",
      cacheReadCostMicrosPerMillion: 750_000,
      updatedAt: 42
    });
    expect(saved).not.toHaveProperty("cacheWriteCostMicrosPerMillion");
    fixture.store.upsertModelPriceOverride({
      ownerId: "owner-a",
      backendId: "backend-b",
      providerId: "provider-a",
      modelId: "model-a",
      currencyCode: "USD",
      inputCostMicrosPerMillion: 1_000_000,
      outputCostMicrosPerMillion: 2_000_000,
      updatedAt: 43
    });
    expect(fixture.store.findModelPriceOverride("owner-b", "backend-a", "provider-a", "model-a"))
      .toBeUndefined();
    expect(fixture.store.findModelPriceOverride("owner-a", "backend-c", "provider-a", "model-a"))
      .toBeUndefined();
    expect(fixture.store.findModelPriceOverride("owner-a", "backend-a", "provider-a", "model-b"))
      .toBeUndefined();

    fixture.reopen();
    expect(fixture.store.findModelPriceOverride("owner-a", "backend-a", "provider-a", "model-a"))
      .toMatchObject({ currencyCode: "CNY", inputCostMicrosPerMillion: 7_500_000 });
    expect(fixture.store.findModelPriceOverride("owner-a", "backend-b", "provider-a", "model-a"))
      .toMatchObject({ currencyCode: "USD", inputCostMicrosPerMillion: 1_000_000 });
    expect(fixture.store.deleteModelPriceOverride("owner-a", "backend-a", "provider-a", "model-a"))
      .toBe(true);
    expect(fixture.store.deleteModelPriceOverride("owner-a", "backend-a", "provider-a", "model-a"))
      .toBe(false);
    expect(fixture.store.listModelPriceOverrides("owner-a")).toHaveLength(1);
  });
});

function observation(overrides: Partial<Parameters<OperationalStore["recordUsageObservation"]>[0]> = {}) {
  return {
    ownerId: "owner-a",
    sessionId: "session-1",
    sourceId: "session-runtime",
    generation: 0,
    backendId: "backend-a",
    providerId: "provider-a",
    modelId: "model-a",
    measuredAt: Date.UTC(2026, 7, 23),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costRates: {
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 6_000_000,
      cacheReadMicrosPerMillion: 200_000,
      cacheWriteMicrosPerMillion: 2_000_000
    },
    ...overrides
  };
}

function createFixture(): { readonly store: OperationalStore; reopen(): OperationalStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-usage-ledger-"));
  const filePath = path.join(directory, "operational.sqlite");
  let store = new OperationalStore(filePath);
  store.upsertBackend({
    id: "backend-a",
    displayName: "Backend",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-a",
    backendId: "backend-a",
    displayName: "Project",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "session-1",
    backendId: "backend-a",
    targetId: "target-a",
    title: "Task",
    binding: { opaqueRef: "native/task.jsonl", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    providerId: "provider-a",
    modelId: "model-a",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  cleanups.push(() => {
    try { store.close(); } catch { /* already closed by reopen */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    reopen() {
      store.close();
      store = new OperationalStore(filePath);
      return store;
    }
  };
}
