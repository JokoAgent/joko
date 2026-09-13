import { describe, expect, it } from "vitest";

import {
  SessionRuntimeControlRegistry,
  pickSessionRuntimeFallback,
  resolveCompatibleSessionRuntimeAxisPatch,
  resolveSessionRuntimeProfile,
  type SessionRuntimeProfile
} from "./session-runtime-control.js";

const baseline: SessionRuntimeProfile = {
  backendId: "pi",
  providerId: "provider-a",
  modelId: "reasoner",
  effort: "medium",
  fastMode: false
};

const models = [
  {
    providerId: "provider-a", modelId: "reasoner", displayName: "Reasoner", api: "test",
    contextWindow: 1, maxOutputTokens: 1, supportsImages: false, supportsFastMode: true,
    thinkingLevels: ["low", "medium", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    providerId: "provider-b", modelId: "reasoner", displayName: "Reasoner B", api: "test",
    contextWindow: 1, maxOutputTokens: 1, supportsImages: false,
    thinkingLevels: ["low", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
] as const;

describe("session runtime control", () => {
  it("keeps baseline, effective, pending, and generation as separate volatile layers", () => {
    const registry = new SessionRuntimeControlRegistry();
    expect(registry.snapshot("task", baseline)).toMatchObject({ generation: 0, baseline, effective: baseline });

    const next = { ...baseline, providerId: "provider-b", effort: "high" };
    registry.acceptDeferred("task", "agent", next, baseline);
    expect(registry.snapshot("task", baseline)).toMatchObject({
      generation: 1,
      effective: baseline,
      pending: { generation: 1, source: "agent", profile: next }
    });
    expect(registry.settlePending("task", 1)).toBe(true);
    expect(registry.snapshot("task", baseline)).toMatchObject({ generation: 1, effective: next });
  });

  it("makes a complete user selection invalidate stale CAS and clear temporary state", () => {
    const registry = new SessionRuntimeControlRegistry();
    registry.acceptApplied("task", "agent", { ...baseline, effort: "high" }, baseline);
    expect(registry.recordUserSelection("task")).toBe(2);
    expect(registry.generationMatches("task", 1)).toBe(false);
    expect(registry.snapshot("task", baseline)).toMatchObject({ generation: 2, effective: baseline });
  });

  it("resolves only catalogued same-backend routes and reconciles unsupported axes", () => {
    expect(resolveSessionRuntimeProfile({
      baseline,
      current: baseline,
      patch: { providerId: "provider-b" },
      models,
      fastModeSupported: true
    })).toEqual({ ...baseline, providerId: "provider-b", effort: "low" });
    expect(resolveSessionRuntimeProfile({
      baseline,
      current: baseline,
      patch: { providerId: "missing" },
      models,
      fastModeSupported: true
    })).toBeUndefined();
    expect(resolveSessionRuntimeProfile({
      baseline,
      current: baseline,
      patch: { providerId: "provider-b", fastMode: true },
      models,
      fastModeSupported: true
    })).toBeUndefined();
  });

  it("keeps an accepted pending route when an axis-only mutation lands", () => {
    const registry = new SessionRuntimeControlRegistry();
    const pending = { ...baseline, providerId: "provider-b", effort: "high" };
    registry.acceptDeferred("task", "agent", pending, baseline);

    registry.acceptAppliedAxis(
      "task",
      "agent",
      { ...baseline, effort: "high" },
      { ...pending, effort: "low" }
    );

    expect(registry.snapshot("task", baseline)).toMatchObject({
      generation: 2,
      effective: { ...baseline, effort: "high" },
      pending: {
        generation: 2,
        source: "agent",
        profile: { ...pending, effort: "low" }
      }
    });
  });

  it("normalizes an axis patch independently for a different pending model", () => {
    expect(resolveCompatibleSessionRuntimeAxisPatch({
      profile: { ...baseline, providerId: "provider-b", effort: "low" },
      patch: { effort: "medium", fastMode: true },
      models,
      fastModeSupported: true
    })).toEqual({ effort: "low", fastMode: false });
  });

  it("orders fallback by the same model, then the explicit Backend default, without loops", () => {
    const allModels = [...models, {
      providerId: "provider-c", modelId: "default", displayName: "Default", api: "test",
      contextWindow: 1, maxOutputTokens: 1, supportsImages: false, supportsFastMode: true,
      thinkingLevels: ["medium"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }] as const;
    expect(pickSessionRuntimeFallback({
      current: baseline,
      models: allModels,
      availableProviderIds: new Set(["provider-b", "provider-c"]),
      explicitDefault: { providerId: "provider-c", modelId: "default" },
      visitedRoutes: [],
      currentHop: 0,
      maxHops: 2,
      fastModeSupported: true
    })).toMatchObject({ providerId: "provider-b", modelId: "reasoner" });
    expect(pickSessionRuntimeFallback({
      current: baseline,
      models: allModels,
      availableProviderIds: new Set(["provider-b", "provider-c"]),
      explicitDefault: { providerId: "provider-c", modelId: "default" },
      visitedRoutes: ["provider-b\0reasoner"],
      currentHop: 1,
      maxHops: 2,
      fastModeSupported: true
    })).toMatchObject({ providerId: "provider-c", modelId: "default" });
    expect(pickSessionRuntimeFallback({
      current: baseline,
      models: allModels,
      availableProviderIds: new Set(["provider-b", "provider-c"]),
      explicitDefault: { providerId: "provider-c", modelId: "default" },
      visitedRoutes: [],
      currentHop: 2,
      maxHops: 2,
      fastModeSupported: true
    })).toBeUndefined();
  });
});
