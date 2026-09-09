import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInferenceRoute } from "./credential-manager.js";
import { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import { createModelRouteCatalog, type ModelRouteCatalog, type requestManagedTextInference } from "./personalization-inference.js";
import { SessionNavigationCoordinator } from "./session-navigation-coordinator.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
});

describe("SessionNavigationCoordinator", () => {
  it("publishes the placeholder durably and never overwrites a concurrent manual rename", async () => {
    const store = fixtureStore();
    const generated = deferred<string>();
    const infer = vi.fn(() => generated.promise);
    const coordinator = new SessionNavigationCoordinator({
      store,
      auxiliary: auxiliaryRouting(store, infer)
    });
    const observed: string[] = [];
    store.subscribe((event) => {
      if (event.payload.type === "session_changed") observed.push(store.getSession(event.sessionId).descriptor.title);
    });

    coordinator.observeAcceptedPrompt("session-a", prompt("Investigate the failing deployment and repair the release workflow"));
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.titleSource).toBe("placeholder"));
    expect(store.getSession("session-a").descriptor.title).toBe("Investigate the failing deployment and r");
    expect(observed.at(-1)).toBe("Investigate the failing deployment and r");

    store.updateSession("session-a", { title: "Owner title" });
    generated.resolve("Generated title");
    await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSession("session-a").descriptor).toMatchObject({
      title: "Owner title",
      titleSource: "manual"
    });
    coordinator.dispose();
  });

  it("uses an attachment-only placeholder without paid inference and lets later text advance it", async () => {
    const store = fixtureStore();
    const infer = vi.fn(async () => "Readable title");
    const coordinator = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryRouting(store, infer) });

    coordinator.observeAcceptedPrompt("session-a", {
      ...prompt(""),
      images: [{
        alt: "release diagram",
        blob: { id: "image-a", sha256: "a".repeat(64), byteLength: 10, mimeType: "image/png" }
      }]
    });
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.titleSource).toBe("attachment"));
    expect(store.getSession("session-a").descriptor.title).toBe("release diagram");
    expect(infer).not.toHaveBeenCalled();

    coordinator.observeAcceptedPrompt("session-a", prompt("Repair the release workflow"));
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.title).toBe("Readable title"));
    expect(store.getSession("session-a").descriptor.titleSource).toBe("automatic");
    coordinator.dispose();
  });

  it("paginates recent material beyond four thousand non-message Events", { timeout: 20_000 }, async () => {
    const store = fixtureStore();
    appendMessage(store, "opening", "user", "Opening requirement", 10);
    store.transaction((transactionStore) => {
      for (let index = 0; index < 4_200; index += 1) {
        transactionStore.appendEvent({
          id: `status-${index}`,
          backendId: "pi",
          targetId: "target-a",
          sessionId: "session-a",
          generation: 0,
          emittedAt: 20 + index,
          traceId: `status:${index}`,
          payload: { type: "status", key: `status-${index}` }
        });
      }
    });
    appendMessage(store, "recent", "assistant", "Latest result", 5_000);
    const infer = vi.fn(async (input: { readonly user: string }) => {
      expect(input.user).toContain("Opening requirement");
      expect(input.user).toContain("Latest result");
      return "Title\nExplanation";
    });
    const coordinator = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryRouting(store, infer) });

    await expect(coordinator.suggestTitle("session-a", "en")).resolves.toEqual({
      title: "",
      status: "generation_failed"
    });
    coordinator.dispose();
  });

  it("refreshes every pinned task when navigation starts", { timeout: 10_000 }, async () => {
    const store = fixtureStore();
    store.updateSession("session-a", { pinned: true });
    appendMessage(store, "pinned-message-0", "user", "Pinned requirement 0", 10);
    for (let index = 1; index < 21; index += 1) {
      store.createSession({
        id: `session-pinned-${index}`,
        backendId: "pi",
        targetId: "target-a",
        title: `Pinned ${index}`,
        binding: { opaqueRef: `session-pinned-${index}.jsonl`, generation: 0 },
        pinned: true,
        archived: false,
        permissionMode: "ask",
        planMode: false,
        fastMode: false,
        providerId: "provider-a",
        modelId: "model-a",
        createdAt: index + 1,
        updatedAt: index + 1
      });
      appendMessage(
        store,
        `pinned-message-${index}`,
        "user",
        `Pinned requirement ${index}`,
        index + 10,
        `session-pinned-${index}`
      );
    }
    const infer = vi.fn(async () => "Pinned summary");
    const coordinator = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryRouting(store, infer) });

    coordinator.start();

    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(21));
    coordinator.dispose();
  });

  it("refreshes pinned summaries, rejects stale material, and clears on unpin", async () => {
    const store = fixtureStore();
    store.updateSession("session-a", { pinned: true });
    appendMessage(store, "user-1", "user", "Repair deployment", 10);
    appendMessage(store, "assistant-1", "assistant", "Release workflow repaired", 11);
    const delayedSummary = deferred<string>();
    const responses = [Promise.resolve("Release repaired"), delayedSummary.promise] as const;
    let call = 0;
    const infer = vi.fn(() => responses[call++]!);
    const coordinator = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryRouting(store, infer), now: () => 100 });

    coordinator.refreshSummary("session-a", true);
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.summary).toBe("Release repaired"));

    coordinator.refreshSummary("session-a", true);
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
    appendMessage(store, "user-2", "user", "A newer request", 12);
    delayedSummary.resolve("Stale summary");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSession("session-a").descriptor.summary).toBe("Release repaired");

    store.updateSession("session-a", { pinned: false });
    expect(store.getSession("session-a").descriptor.summary).toBeUndefined();
    coordinator.dispose();
  });

  it("redacts credentials before Provider dispatch and before durable navigation text", async () => {
    const store = fixtureStore();
    const infer = vi.fn(async (input: { readonly user: string }) => {
      expect(input.user).not.toContain("secret-value");
      return "Safe title";
    });
    const coordinator = new SessionNavigationCoordinator({
      store,
      auxiliary: auxiliaryRouting(store, infer),
      credentials: { redactText: (value) => value.replaceAll("secret-value", "[redacted]") }
    });

    coordinator.observeAcceptedPrompt("session-a", prompt("Inspect secret-value deployment"));
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.title).toBe("Safe title"));
    expect(JSON.stringify(store.listEvents({ sessionId: "session-a" }).map((event) => event.payload))).not.toContain("secret-value");
    coordinator.dispose();
  });

  it("excludes service-owned continuation prompts from generated navigation text", async () => {
    const store = fixtureStore();
    store.updateSession("session-a", { pinned: true });
    appendMessage(store, "visible-user", "user", "Repair the release", 10);
    store.appendEvent({
      id: "internal-continuation",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 11,
      traceId: "navigation:internal-continuation",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Internal continuation must stay hidden" }],
        automaticContinuation: { recoveryId: "navigation-recovery" }
      }
    });
    appendMessage(store, "visible-assistant", "assistant", "Release repaired", 12);
    const infer = vi.fn(async (input: { readonly user: string }) => {
      expect(input.user).toContain("Repair the release");
      expect(input.user).toContain("Release repaired");
      expect(input.user).not.toContain("Internal continuation must stay hidden");
      return "Release repaired";
    });
    const coordinator = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryRouting(store, infer), now: () => 13 });

    coordinator.refreshSummary("session-a", true);
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.summary).toBe("Release repaired"));
    coordinator.dispose();
  });

  it("uses the auxiliary route for native Sessions without borrowing their inference credentials", async () => {
    const store = fixtureStore();
    appendMessage(store, "native-user", "user", "Keep this task on the native Backend", 10);
    store.updateSession("session-a", { pinned: true });
    const infer = vi.fn(async (input: Parameters<typeof requestManagedTextInference>[0]) => {
      expect(input.route).toMatchObject({ backendId: "managed-backend" });
      return "Auxiliary title";
    });
    const routes = modelRouteCatalog(store, [route("managed-backend")], [
      { backendId: "pi", managedCatalog: false },
      { backendId: "managed-backend", managedCatalog: true }
    ]);
    expect(routes.list()).toEqual([
      expect.objectContaining({ backendId: "managed-backend", credentialRoute: true }),
      expect.objectContaining({ backendId: "pi", credentialRoute: false })
    ]);
    const coordinator = new SessionNavigationCoordinator({
      store,
      auxiliary: auxiliaryRouting(store, infer, routes),
      now: () => 13
    });

    await expect(coordinator.suggestTitle("session-a", "en")).resolves.toEqual({
      title: "Auxiliary title",
      status: "ok"
    });
    coordinator.observeAcceptedPrompt("session-a", prompt("Do not cross the Backend boundary"));
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor).toMatchObject({
      title: "Auxiliary title",
      titleSource: "automatic"
    }));
    coordinator.refreshSummary("session-a", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(infer).toHaveBeenCalledTimes(3);
    expect(store.getSession("session-a").descriptor.summary).toBe("Auxiliary title");
    coordinator.dispose();
  });

  it("validates every title and summary candidate before using the configured fallback", async () => {
    const store = fixtureStore();
    appendMessage(store, "fallback-user", "user", "Repair the release", 10);
    store.updateSession("session-a", { pinned: true });
    const routes = modelRouteCatalog(store, [route("primary"), route("secondary")], [
      { backendId: "primary", managedCatalog: true },
      { backendId: "secondary", managedCatalog: true }
    ]);
    const infer = vi.fn(async (input: Parameters<typeof requestManagedTextInference>[0]) =>
      "backendId" in input.route && input.route.backendId === "primary" ? "Title: invalid" : "Good result"
    );
    const auxiliary = auxiliaryRouting(store, infer, routes);
    auxiliary.replace([
      { backendId: "primary", providerId: "provider-a", modelId: "model-a" },
      { backendId: "secondary", providerId: "provider-a", modelId: "model-a" }
    ], 0n);
    const coordinator = new SessionNavigationCoordinator({ store, auxiliary, now: () => 13 });

    await expect(coordinator.suggestTitle("session-a", "en")).resolves.toEqual({ title: "Good result", status: "ok" });
    coordinator.observeAcceptedPrompt("session-a", prompt("Repair the release"));
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.title).toBe("Good result"));
    coordinator.refreshSummary("session-a");
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.summary).toBe("Good result"));
    expect(infer.mock.calls.map(([input]) => "backendId" in input.route ? input.route.backendId : undefined))
      .toEqual(["primary", "secondary", "primary", "secondary", "primary", "secondary"]);
    coordinator.dispose();
  });

  it.each(["automatic title", "title suggestion", "summary"] as const)(
    "does not publish an old %s after auxiliary settings change",
    async (consumer) => {
      const store = fixtureStore();
      appendMessage(store, "pending-user", "user", "Repair the release", 10);
      store.updateSession("session-a", { pinned: true });
      const delayed = deferred<string>();
      const infer = vi.fn(() => delayed.promise);
      const auxiliary = auxiliaryRouting(store, infer);
      const coordinator = new SessionNavigationCoordinator({ store, auxiliary, now: () => 13 });
      let suggestion: Promise<unknown> | undefined;
      if (consumer === "automatic title") coordinator.observeAcceptedPrompt("session-a", prompt("Repair the release"));
      else if (consumer === "summary") coordinator.refreshSummary("session-a");
      else suggestion = coordinator.suggestTitle("session-a", "en");
      await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());

      auxiliary.replace([], 0n);
      auxiliary.invalidate();
      delayed.resolve("Outdated result");
      if (suggestion !== undefined) await expect(suggestion).resolves.toEqual({ title: "", status: "generation_failed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.getSession("session-a").descriptor.summary).toBeUndefined();
      expect(store.getSession("session-a").descriptor.title).not.toBe("Outdated result");
      if (consumer === "automatic title") expect(store.getSession("session-a").descriptor.titleSource).toBe("placeholder");
      expect(infer).toHaveBeenCalledOnce();
      coordinator.dispose();
    }
  );

  it.each(["generation", "material", "locale", "dispose", "caller cancellation"] as const)(
    "discards a title suggestion after its %s changes",
    async (fence) => {
      const store = fixtureStore();
      appendMessage(store, "suggestion-user", "user", "Repair the release", 10);
      const delayed = deferred<string>();
      const infer = vi.fn(() => delayed.promise);
      const coordinator = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryRouting(store, infer) });
      const caller = new AbortController();
      const pending = coordinator.suggestTitle("session-a", "en", caller.signal);
      await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());
      if (fence === "generation") {
        const current = store.getSession("session-a");
        store.updateSession("session-a", { binding: { ...current.descriptor.binding, generation: 1 } }, current.revision);
      } else if (fence === "material") appendMessage(store, "suggestion-new-user", "user", "A new task", 11);
      else if (fence === "locale") store.setSetting("service", "orchestrator", "settings.appearance", { locale: "zh" });
      else if (fence === "dispose") coordinator.dispose();
      else caller.abort();
      delayed.resolve("Outdated title");
      await expect(pending).resolves.toEqual({ title: "", status: "generation_failed" });
      coordinator.dispose();
    }
  );

  it.each(["auxiliary revision", "generation", "locale"] as const)(
    "does not redirect an accepted automatic title after %s changes before its first continuation",
    async (fence) => {
      const store = fixtureStore();
      const infer = vi.fn(async () => "Stale title");
      const auxiliary = auxiliaryRouting(store, infer);
      const coordinator = new SessionNavigationCoordinator({ store, auxiliary });
      coordinator.observeAcceptedPrompt("session-a", prompt("Original request"));
      if (fence === "auxiliary revision") auxiliary.replace([], 0n);
      else if (fence === "locale") store.setSetting("service", "orchestrator", "settings.appearance", { locale: "zh" });
      else {
        const current = store.getSession("session-a");
        store.updateSession("session-a", { binding: { ...current.descriptor.binding, generation: 1 } }, current.revision);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(infer).not.toHaveBeenCalled();
      expect(store.getSession("session-a").descriptor.title).toBe("New task");
      coordinator.dispose();
    }
  );
});

function auxiliaryRouting(
  store: OperationalStore,
  infer: typeof requestManagedTextInference,
  routes: ModelRouteCatalog = modelRouteCatalog(store, [route("pi")])
): AuxiliaryTextRouting {
  return new AuxiliaryTextRouting({
    store, routes, infer,
    providers: {
      generation: 0,
      describeInferenceRoute: (backendId, providerId, modelId) => routes.list()
        .some((candidate) => candidate.backendId === backendId && candidate.providerId === providerId && candidate.modelId === modelId && candidate.credentialRoute)
        ? { generationId: "provider-generation" } : undefined
    }
  });
}

function fixtureStore(): OperationalStore {
  const store = new OperationalStore(":memory:");
  stores.push(store);
  const capabilities = new Map([
    "session.auto_title",
    "session.ai_rename",
    "session.summary"
  ].map((key) => [key, { key, supported: true }]));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities,
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-a",
    backendId: "pi",
    displayName: "Target",
    workspaceRoot: "D:/workspace-a",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "session-a",
    backendId: "pi",
    targetId: "target-a",
    title: "New task",
    binding: { opaqueRef: "session-a.jsonl", generation: 0 },
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
  return store;
}

function prompt(text: string) {
  return { text, images: [], files: [], mentions: [], disposition: "prompt" as const };
}

function appendMessage(
  store: OperationalStore,
  id: string,
  role: "user" | "assistant",
  text: string,
  emittedAt: number,
  sessionId = "session-a"
): void {
  store.appendEvent({
    id,
    backendId: "pi",
    targetId: "target-a",
    sessionId,
    generation: 0,
    emittedAt,
    traceId: `message:${id}`,
    payload: { type: "message_complete", role, blocks: [{ kind: "text", text }] }
  });
}

function route(backendId: string): ProviderInferenceRoute {
  return {
    backendId,
    providerId: "provider-a",
    generationId: "provider-generation",
    modelId: "model-a",
    api: "openai-completions",
    baseUrl: "https://provider.invalid/v1",
    headers: {},
    supportsImages: false
  };
}

function modelRouteCatalog(
  store: OperationalStore,
  inferenceRoutes: readonly ProviderInferenceRoute[],
  backends: readonly { readonly backendId: string; readonly managedCatalog: boolean }[] = [
    { backendId: "pi", managedCatalog: true }
  ]
): ModelRouteCatalog {
  const catalogModel = inferenceRoutes[0]!;
  for (const { backendId, managedCatalog } of backends) {
    const existing = store.listBackends().find((record) => record.descriptor.id === backendId)?.descriptor;
    store.upsertBackend({
      id: backendId,
      adapterKind: existing?.adapterKind ?? "fixture",
      instanceGeneration: existing?.instanceGeneration ?? 0,
      displayName: existing?.displayName ?? backendId,
      version: existing?.version ?? "test",
      health: existing?.health ?? "healthy",
      installationState: existing?.installationState ?? "installed",
      authenticationState: existing?.authenticationState ?? "authenticated",
      capabilities: new Map([
        ...(existing?.capabilities ?? []),
        ...(managedCatalog ? [[
          "provider.managed_catalog",
          { key: "provider.managed_catalog", supported: true }
        ] as const] : [])
      ]),
      models: [{
        providerId: catalogModel.providerId,
        modelId: catalogModel.modelId,
        displayName: catalogModel.modelId,
        api: catalogModel.api,
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        supportsImages: catalogModel.supportsImages,
        thinkingLevels: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      tools: existing?.tools ?? [],
      diagnostics: existing?.diagnostics ?? []
    });
  }
  return createModelRouteCatalog(store, {
    hasInferenceModel: (backendId, providerId, modelId) => inferenceRoutes.some((candidate) =>
      candidate.backendId === backendId && candidate.providerId === providerId && candidate.modelId === modelId),
    resolveInferenceRoute: (backendId, providerId, modelId) => inferenceRoutes.find((candidate) =>
      candidate.backendId === backendId && candidate.providerId === providerId && candidate.modelId === modelId)
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
