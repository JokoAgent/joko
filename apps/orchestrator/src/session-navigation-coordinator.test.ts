import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInferenceRoute } from "./credential-manager.js";
import { createModelRouteCatalog, type ModelRouteCatalog } from "./personalization-inference.js";
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
      routes: modelRouteCatalog(store, route()),
      infer
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
    const coordinator = new SessionNavigationCoordinator({ store, routes: modelRouteCatalog(store, route()), infer });

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
    const coordinator = new SessionNavigationCoordinator({ store, routes: modelRouteCatalog(store, route()), infer });

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
    const coordinator = new SessionNavigationCoordinator({ store, routes: modelRouteCatalog(store, route()), infer });

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
    const coordinator = new SessionNavigationCoordinator({ store, routes: modelRouteCatalog(store, route()), infer, now: () => 100 });

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
      routes: modelRouteCatalog(store, route()),
      credentials: { redactText: (value) => value.replaceAll("secret-value", "[redacted]") },
      infer
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
    const coordinator = new SessionNavigationCoordinator({ store, routes: modelRouteCatalog(store, route()), infer, now: () => 13 });

    coordinator.refreshSummary("session-a", true);
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor.summary).toBe("Release repaired"));
    coordinator.dispose();
  });

  it("never sends native Backend navigation content to a managed route with the same Provider and model IDs", async () => {
    const store = fixtureStore();
    appendMessage(store, "native-user", "user", "Keep this task on the native Backend", 10);
    store.updateSession("session-a", { pinned: true });
    const infer = vi.fn(async () => "Must never be used");
    const routes = modelRouteCatalog(store, route(), [
      { backendId: "pi", managedCatalog: false },
      { backendId: "managed-backend", managedCatalog: true }
    ]);
    expect(routes.list()).toEqual([
      expect.objectContaining({ backendId: "managed-backend", credentialRoute: true }),
      expect.objectContaining({ backendId: "pi", credentialRoute: false })
    ]);
    const coordinator = new SessionNavigationCoordinator({
      store,
      routes,
      infer
    });

    await expect(coordinator.suggestTitle("session-a", "en")).resolves.toEqual({
      title: "",
      status: "provider_unavailable"
    });
    coordinator.observeAcceptedPrompt("session-a", prompt("Do not cross the Backend boundary"));
    await vi.waitFor(() => expect(store.getSession("session-a").descriptor).toMatchObject({
      title: "Do not cross the Backend boundary",
      titleSource: "automatic"
    }));
    coordinator.refreshSummary("session-a", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(infer).not.toHaveBeenCalled();
    expect(store.getSession("session-a").descriptor.summary).toBeUndefined();
    coordinator.dispose();
  });
});

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

function route(): ProviderInferenceRoute {
  return {
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
  inferenceRoute: ProviderInferenceRoute,
  backends: readonly { readonly backendId: string; readonly managedCatalog: boolean }[] = [
    { backendId: "pi", managedCatalog: true }
  ]
): ModelRouteCatalog {
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
        providerId: inferenceRoute.providerId,
        modelId: inferenceRoute.modelId,
        displayName: inferenceRoute.modelId,
        api: inferenceRoute.api,
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        supportsImages: inferenceRoute.supportsImages,
        thinkingLevels: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      tools: existing?.tools ?? [],
      diagnostics: existing?.diagnostics ?? []
    });
  }
  return createModelRouteCatalog(store, {
    hasInferenceModel: (providerId, modelId) =>
      providerId === inferenceRoute.providerId && modelId === inferenceRoute.modelId,
    resolveInferenceRoute: (providerId, modelId) =>
      providerId === inferenceRoute.providerId && modelId === inferenceRoute.modelId
        ? inferenceRoute
        : undefined
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
