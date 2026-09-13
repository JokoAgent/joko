import { OperationalStore, RevisionConflictError } from "@joko/store";
import { create } from "@bufbuild/protobuf";
import { BackendModelAccessUpdateSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUXILIARY_TEXT_SETTING_KEY, AuxiliaryTextRouting, type AuxiliaryTextRunOptions } from "./auxiliary-text-routing.js";
import { writeBackendModelAccess } from "./backend-model-access.js";
import { createModelRouteCatalog, type ModelRouteRef, type ManagedTextInferenceInput } from "./personalization-inference.js";

const resources: { store: OperationalStore; routing: AuxiliaryTextRouting }[] = [];
afterEach(() => {
  for (const { store, routing } of resources.splice(0)) { routing.dispose(); store.close(); }
  vi.restoreAllMocks();
});

describe("AuxiliaryTextRouting", () => {
  it("uses explicit backend defaults then stable exact routes without creating a stored override", () => {
    const fixture = setup();
    const { store, routing } = fixture;
    store.setSetting("service", "orchestrator", "settings.backend.backend-a", {
      defaultModel: { model: { providerId: "provider-a", modelId: "model-c" }, effortId: "", fastMode: false }
    });
    expect(routing.snapshot().automaticModels).toEqual([ref("c"), ref("a"), ref("b")]);
    expect(store.findSetting("service", "orchestrator", AUXILIARY_TEXT_SETTING_KEY)).toBeUndefined();
    const plan = routing.capture();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.models)).toBe(true);
    expect(Object.isFrozen(plan.models[0])).toBe(true);
    expect(plan.models).toEqual([ref("c"), ref("a"), ref("b")]);
    expect(routing.isCurrent({ ...plan })).toBe(false);
    expect(JSON.stringify(routing.snapshot(), bigintJson)).not.toContain("private-credential-generation");
  });

  it("compares revisions atomically and keeps reset revisions while preserving already observed postcommit plans", () => {
    const { store, routing } = setup();
    const initial = routing.capture();
    store.transaction(() => routing.replace([ref("b")], 0n));
    const saved = routing.snapshot();
    const current = routing.capture();
    routing.invalidate();
    expect(routing.isCurrent(current)).toBe(true);
    expect(routing.isCurrent(initial)).toBe(false);
    expect(() => store.transaction(() => routing.replace([ref("c")], 0n))).toThrow(RevisionConflictError);
    expect(() => store.transaction(() => { routing.replace([ref("c")], saved.revision); throw new Error("rollback"); })).toThrow("rollback");
    expect(routing.isCurrent(current)).toBe(true);
    store.transaction(() => routing.replace([], saved.revision));
    expect(routing.snapshot()).toMatchObject({ models: [] });
    expect(routing.snapshot().revision).toBeGreaterThan(saved.revision);
    expect(() => store.transaction(() => routing.replace([ref("c")], 0n))).toThrow(RevisionConflictError);
    expect(store.findSetting("service", "orchestrator", AUXILIARY_TEXT_SETTING_KEY)?.value).toEqual({ models: [] });
  });

  it("rejects malformed or duplicate choices and fails closed on malformed current storage", async () => {
    const { store, routing, infer } = setup();
    for (const models of [[ref("a"), ref("a")], [ref("a"), ref("b"), ref("c"), ref("d")], [ref("missing")], [{ ...ref("a"), backendId: " backend-a" }]]) {
      expect(() => store.transaction(() => routing.replace(models, 0n))).toThrow(RangeError);
    }
    store.setSetting("service", "orchestrator", AUXILIARY_TEXT_SETTING_KEY, { models: [ref("a")], unexpected: true });
    expect(routing.snapshot()).toMatchObject({ available: false, unavailableReason: "Auxiliary text settings are invalid." });
    await expect(routing.run(routing.capture(), request())).resolves.toEqual({ status: "unavailable" });
    expect(infer).not.toHaveBeenCalled();
    const revision = routing.snapshot().revision;
    store.transaction(() => routing.replace([ref("b")], revision));
    expect(routing.snapshot()).toMatchObject({ models: [ref("b")], available: true });
  });

  it("exhausts only the ordered custom chain and validates each response before selecting a winner", async () => {
    const { store, routing, infer } = setup();
    store.transaction(() => routing.replace([ref("c"), ref("b"), ref("d")], 0n));
    infer.mockResolvedValueOnce("malformed").mockRejectedValueOnce(new Error("private provider failure")).mockResolvedValueOnce("valid result");
    await expect(routing.run(routing.capture(), request())).resolves.toEqual({ status: "ok", text: "valid result" });
    expect(infer.mock.calls.map(([input]) => input.route.modelId)).toEqual(["model-c", "model-b", "model-d"]);
    infer.mockClear().mockResolvedValue("malformed");
    await expect(routing.run(routing.capture(), request())).resolves.toEqual({ status: "exhausted" });
    expect(infer.mock.calls.map(([input]) => input.route.modelId)).toEqual(["model-c", "model-b", "model-d"]);
  });

  it("keeps unavailable selected identities visible but never dispatches disabled routes", async () => {
    const { store, routing, infer } = setup();
    store.transaction(() => routing.replace([ref("b"), ref("c")], 0n));
    store.setSetting("service", "orchestrator", "settings.model_access.backend-a", {
      disabledProviderIds: [], disabledModels: [{ providerId: "provider-a", modelId: "model-b" }]
    });
    expect(routing.snapshot().options.find((option) => option.route.modelId === "model-b")).toMatchObject({ available: false });
    await expect(routing.run(routing.capture(), request())).resolves.toMatchObject({ status: "ok" });
    expect(infer.mock.calls.map(([input]) => input.route.modelId)).toEqual(["model-c"]);
    store.setSetting("service", "orchestrator", "settings.backend.backend-a", { enabled: false });
    infer.mockClear();
    await expect(routing.run(routing.capture(), request())).resolves.toEqual({ status: "unavailable" });
    expect(infer).not.toHaveBeenCalled();
    const snapshot = routing.snapshot();
    store.transaction(() => routing.replace([ref("b")], snapshot.revision));
    expect(routing.snapshot().models).toEqual([ref("b")]);
  });

  it.each(["signal", "dispose", "config", "provider", "credential", "access", "owner"] as const)(
    "retires an in-flight result across %s without attempting a fallback", async (boundary) => {
      const fixture = setup();
      const { store, routing, infer } = fixture;
      store.transaction(() => routing.replace([ref("a"), ref("b")], 0n));
      const first = deferred<string>();
      infer.mockReturnValueOnce(first.promise);
      const cancellation = new AbortController();
      let current = true;
      const plan = routing.capture();
      const pending = routing.run(plan, { ...request(), signal: cancellation.signal, stillCurrent: () => current });
      expect(infer).toHaveBeenCalledOnce();
      if (boundary === "signal") cancellation.abort();
      else if (boundary === "dispose") routing.dispose();
      else if (boundary === "config") {
        store.transaction(() => routing.replace([], routing.snapshot().revision));
        store.transaction(() => routing.replace([ref("a"), ref("b")], routing.snapshot().revision));
        routing.invalidate();
      } else if (boundary === "provider") { fixture.generation += 1; routing.invalidate(); }
      else if (boundary === "credential") { fixture.credentialGeneration += 1; routing.invalidate(); }
      else if (boundary === "access") {
        store.setSetting("service", "orchestrator", "settings.model_access.backend-a", { disabledProviderIds: ["provider-a"], disabledModels: [] });
        store.setSetting("service", "orchestrator", "settings.model_access.backend-a", { disabledProviderIds: [], disabledModels: [] });
        routing.invalidate();
      } else current = false;
      first.resolve("valid late result");
      await expect(pending).resolves.toEqual({ status: boundary === "signal" || boundary === "dispose" ? "cancelled" : "stale" });
      expect(infer).toHaveBeenCalledOnce();
    }
  );

  it.each([1_000, 300_000])("bounds attempts and the full chain for a %i ms caller even when inference ignores cancellation", async (timeoutMs) => {
    const timeouts: { milliseconds: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      timeouts.push({ milliseconds, controller });
      return controller.signal;
    });
    const { store, routing, infer } = setup();
    store.transaction(() => routing.replace([ref("a"), ref("b"), ref("c")], 0n));
    infer.mockReturnValue(new Promise<string>(() => undefined));
    const pending = routing.run(routing.capture(), { ...request(), timeoutMs });
    expect(timeouts.map((timeout) => timeout.milliseconds)).toEqual([60_000, Math.min(timeoutMs, 20_000)]);
    expect(infer.mock.calls[0]![0].timeoutMs).toBe(Math.min(timeoutMs, 20_000));
    timeouts[1]!.controller.abort();
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
    timeouts[0]!.controller.abort();
    await expect(pending).resolves.toEqual({ status: "exhausted" });
    expect(infer).toHaveBeenCalledTimes(2);
  });

  it("does not retire a fresh flight when postcommit invalidation observes the same configuration", async () => {
    const { store, routing, infer } = setup();
    store.transaction(() => routing.replace([ref("b")], 0n));
    const fresh = routing.capture();
    const result = deferred<string>();
    infer.mockReturnValueOnce(result.promise);
    const pending = routing.run(fresh, request());
    routing.invalidate();
    expect(infer.mock.calls[0]![0].signal?.aborted).toBe(false);
    result.resolve("valid current result");
    await expect(pending).resolves.toMatchObject({ status: "ok" });
  });

  it("keeps an unobserved disable and restore retired through the durable access revision", () => {
    const { store, routing } = setup();
    const plan = routing.capture();
    store.runOperation({ id: "disable-model", kind: "updateBackendSettings", body: { enabled: false } }, (transaction) => {
      writeBackendModelAccess(transaction, "backend-a", create(BackendModelAccessUpdateSchema, { providerId: "provider-a", enabled: false }));
      return { accepted: true };
    });
    store.runOperation({ id: "enable-model", kind: "updateBackendSettings", body: { enabled: true } }, (transaction) => {
      writeBackendModelAccess(transaction, "backend-a", create(BackendModelAccessUpdateSchema, { providerId: "provider-a", enabled: true }));
      return { accepted: true };
    });
    expect(routing.snapshot().automaticModels).toEqual(plan.models);
    expect(routing.isCurrent(plan)).toBe(false);
    expect(store.findSetting("service", "orchestrator", "settings.model_access.backend-a")?.value).toMatchObject({
      disabledProviderIds: [], disabledModels: []
    });
  });
});

function setup() {
  const store = new OperationalStore(":memory:");
  const fixture = { generation: 1, credentialGeneration: 1 };
  store.upsertBackend({
    id: "backend-a", adapterKind: "fixture", instanceGeneration: 1, displayName: "Backend",
    version: "test", health: "healthy", installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
    models: ["a", "b", "c", "d"].map((id) => ({
      providerId: "provider-a", modelId: `model-${id}`, displayName: id, api: "openai-completions",
      contextWindow: 8192, maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })), tools: [], diagnostics: []
  });
  const providers = {
    get generation() { return fixture.generation; },
    hasInferenceModel: () => true,
    describeInferenceRoute: () => ({ generationId: `private-credential-generation-${fixture.credentialGeneration}` }),
    resolveInferenceRoute: (backendId: string, providerId: string, modelId: string) => ({
      backendId, providerId, modelId, generationId: "config-generation", baseUrl: "https://provider.invalid/v1",
      api: "openai-completions" as const, headers: {}, supportsImages: false
    })
  };
  const infer = vi.fn(async (_input: ManagedTextInferenceInput) => "valid result");
  const routing = new AuxiliaryTextRouting({ store, routes: createModelRouteCatalog(store, providers), providers, infer });
  resources.push({ store, routing });
  return Object.assign(fixture, { store, routing, infer });
}

function ref(suffix: string): ModelRouteRef {
  return { backendId: "backend-a", providerId: "provider-a", modelId: `model-${suffix}` };
}

function request(): AuxiliaryTextRunOptions {
  return { system: "Generate one line.", user: "Context", maxTokens: 64, timeoutMs: 20_000,
    validate: (raw) => raw.startsWith("valid") ? raw : undefined };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((accept) => { resolve = accept; }), resolve: (value) => resolve(value) };
}

function bigintJson(_key: string, value: unknown): unknown { return typeof value === "bigint" ? value.toString() : value; }
