import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { BackendModelAccessUpdateSchema } from "@joko/contracts";
import type { BackendAdapter, NativeTextInferenceInput } from "@joko/core";
import { OperationalStore } from "@joko/store";
import type { ProviderInferenceRoute } from "./credential-manager.js";
import { writeBackendModelAccess } from "./backend-model-access.js";
import { createScheduleHookScriptGenerator } from "./schedule-hook-script-installer.js";
import { requestManagedTextInference } from "./personalization-inference.js";

vi.mock("./personalization-inference.js", () => ({ requestManagedTextInference: vi.fn() }));

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.clearAllMocks(); });

const input = { backendId: "runtime", workspaceRoot: "D:/workspace", description: "Run when local checks succeed",
  providerId: "provider", modelId: "model" };

function setup() {
  const store = new OperationalStore(":memory:"); stores.push(store);
  store.upsertBackend({ id: "runtime", adapterKind: "fixture", instanceGeneration: 4, displayName: "Runtime", version: "test",
    health: "healthy", installationState: "installed", authenticationState: "authenticated", capabilities: new Map(),
    models: [], tools: [], diagnostics: [] });
  const infer = vi.fn<(request: NativeTextInferenceInput) => Promise<string>>().mockResolvedValue("process.exit(0)");
  const adapter = { id: "runtime", inferNativeText: infer } as unknown as BackendAdapter;
  let adapters = [adapter];
  const providers = { list: () => [], resolveInferenceRoute: vi.fn((): ProviderInferenceRoute | undefined => undefined) };
  const generate = createScheduleHookScriptGenerator(providers, { store, adapters: () => adapters });
  return { store, infer, providers, generate, retire: () => { adapters = []; } };
}

describe("scheduled script inference ownership", () => {
  it("pins native generation to the scheduled Backend and explicit Provider/model without borrowing a task", async () => {
    const fixture = setup();
    await expect(fixture.generate(input)).resolves.toBe("process.exit(0)");
    const request = fixture.infer.mock.calls[0]![0];
    expect(request).toMatchObject({ providerId: "provider", modelId: "model", backendInstanceGeneration: 4, timeoutMs: 60_000 });
    expect(request.user).toContain("Run when local checks succeed");
    expect(() => request.assertModelAllowed("other", "model")).toThrow("disabled or changed");
    await expect(fixture.generate({ ...input, backendId: "other-runtime" })).rejects.toThrow("cannot generate");
    expect(fixture.infer).toHaveBeenCalledTimes(1);
    expect(requestManagedTextInference).not.toHaveBeenCalled();
  });

  it("rejects disabled native models, malformed selections and retired Backends before dispatch", async () => {
    const fixture = setup();
    writeBackendModelAccess(fixture.store, "runtime", create(BackendModelAccessUpdateSchema, { providerId: "provider", modelId: "model", enabled: false }));
    await expect(fixture.generate(input)).rejects.toThrow("disabled or changed");
    await expect(fixture.generate({ backendId: "runtime", workspaceRoot: input.workspaceRoot, description: input.description,
      providerId: "provider" })).rejects.toThrow("both Provider and model");
    fixture.store.setSetting("service", "orchestrator", "settings.backend.runtime", { enabled: false });
    await expect(fixture.generate(input)).rejects.toThrow("retired");
    expect(fixture.infer).not.toHaveBeenCalled();
  });

  it("retires late native output after adapter replacement, model settings restoration, or document cancellation", async () => {
    for (const change of ["adapter", "model", "document", "abort"] as const) {
      const fixture = setup(), abort = new AbortController();
      let finish!: (text: string) => void, current = true;
      fixture.infer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = fixture.generate({ ...input, assertCurrent: () => { if (!current) throw new Error("document retired"); } }, abort.signal);
      const rejected = expect(pending).rejects.toBeDefined();
      expect(fixture.infer).toHaveBeenCalledOnce();
      if (change === "adapter") fixture.retire();
      if (change === "model") {
        writeBackendModelAccess(fixture.store, "runtime", create(BackendModelAccessUpdateSchema, { providerId: "provider", modelId: "model", enabled: false }));
        writeBackendModelAccess(fixture.store, "runtime", create(BackendModelAccessUpdateSchema, { providerId: "provider", modelId: "model", enabled: true }));
      }
      if (change === "document") current = false;
      if (change === "abort") abort.abort();
      finish("process.exit(0)");
      await rejected;
    }
  });

  it("keeps native failures on their original route and preserves automatic model selection", async () => {
    const fixture = setup(); fixture.infer.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(fixture.generate(input)).rejects.toThrow("native unavailable");
    await fixture.generate({ backendId: "runtime", workspaceRoot: input.workspaceRoot, description: input.description });
    expect(fixture.infer.mock.calls[1]![0].modelId).toBeUndefined();
    expect(requestManagedTextInference).not.toHaveBeenCalled();
  });

  it("rejects late managed output after its exact route generation changes without retrying native", async () => {
    const fixture = setup();
    let route: ProviderInferenceRoute = { backendId: "runtime", providerId: "provider", modelId: "model", generationId: "first",
      api: "openai-responses", baseUrl: "https://provider.invalid", headers: {}, supportsImages: false };
    fixture.providers.resolveInferenceRoute.mockImplementation(() => route);
    let finish!: (text: string) => void;
    vi.mocked(requestManagedTextInference).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = fixture.generate(input), rejected = expect(pending).rejects.toThrow("route changed");
    expect(requestManagedTextInference).toHaveBeenCalledOnce();
    route = { ...route, generationId: "second" }; finish("process.exit(0)");
    await rejected;
    expect(fixture.infer).not.toHaveBeenCalled();
  });
});
