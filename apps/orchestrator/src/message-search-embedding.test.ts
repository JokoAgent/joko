import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageSearchEmbeddingCoordinator } from "./message-search-embedding.js";

const stores: OperationalStore[] = [];
const EMBEDDING_GENERATION_ID = "embedding-generation-1";

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
});

describe("MessageSearchEmbeddingCoordinator", () => {
  it("enables indexing by default while still requiring an explicit Provider route", async () => {
    const store = fixtureStore();
    const fetch = successfulFetch();
    const coordinator = new MessageSearchEmbeddingCoordinator({
      store,
      providers: embeddingProviders(),
      fetch,
      setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
    });

    coordinator.start();
    appendMessage(store, "event-default-on", "session-a", 10, "default semantic indexing");
    await coordinator.drain();

    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: true, pendingCount: 0, doneCount: 1 }));
    expect(fetch).toHaveBeenCalledOnce();
    await coordinator.stop();
  });

  it("establishes the first-enable cutoff only when an eligible Provider route appears", async () => {
    const store = fixtureStore();
    const fetch = successfulFetch();
    let routeAvailable = false;
    const coordinator = new MessageSearchEmbeddingCoordinator({
      store,
      providers: {
        resolveOpenAiEmbeddingRoute: () => routeAvailable ? embeddingProviders().resolveOpenAiEmbeddingRoute() : undefined
      },
      fetch,
      setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
    });

    coordinator.start();
    expect(coordinator.configuredEnabled()).toBe(true);
    expect(coordinator.status().enabled).toBe(false);
    appendMessage(store, "event-before-route", "session-a", 10, "must stay before the availability cutoff");
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: false, pendingCount: 0, doneCount: 0 }));
    expect(fetch).not.toHaveBeenCalled();

    routeAvailable = true;
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: true, pendingCount: 0, doneCount: 0 }));
    appendMessage(store, "event-after-route", "session-a", 20, "eligible after the availability cutoff");
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: true, pendingCount: 0, doneCount: 1 }));
    expect(fetch).toHaveBeenCalledOnce();

    appendMessage(store, "event-accepted-before-loss", "session-a", 30, "accepted before capability loss");
    routeAvailable = false;
    coordinator.reconcileAvailability();
    expect(coordinator.configuredEnabled()).toBe(true);
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: false, pendingCount: 1, doneCount: 1 }));
    appendMessage(store, "event-during-loss", "session-a", 40, "must stay outside the index");
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: false, pendingCount: 1, doneCount: 1 }));
    expect(fetch).toHaveBeenCalledOnce();

    routeAvailable = true;
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: true, pendingCount: 0, doneCount: 2 }));
    appendMessage(store, "event-after-restore", "session-a", 50, "eligible after capability restoration");
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: true, pendingCount: 0, doneCount: 3 }));
    expect(fetch).toHaveBeenCalledTimes(3);
    await coordinator.stop();
  });

  it("embeds durable jobs, sends credentials only in-memory, and serves a real query vector", async () => {
    const store = fixtureStore();
    const calls: Array<{ readonly authorization?: string; readonly redirect?: RequestRedirect; readonly body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { readonly input: readonly string[] };
      calls.push({
        ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization")! }),
        ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
        body
      });
      return new Response(JSON.stringify({
        object: "list",
        model: "voyage/voyage-4",
        data: body.input.map((_text, index) => ({
          object: "embedding",
          index,
          embedding: vector(index === 0 ? 0 : 1)
        }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const coordinator = coordinatorFor(store, fetch);
    coordinator.start();
    appendMessage(store, "event-a", "session-a", 10, "release readiness");
    appendMessage(store, "event-b", "session-b", 20, "dessert recipe");
    await coordinator.drain();

    expect(coordinator.status()).toEqual(expect.objectContaining({ doneCount: 2, pendingCount: 0 }));
    const query = await coordinator.embedQuery("deployment guidance", "hybrid");
    expect(query.semantic).toEqual(expect.objectContaining({
      providerGenerationId: EMBEDDING_GENERATION_ID,
      modelId: "voyage/voyage-4",
      queryEmbedding: expect.arrayContaining([1])
    }));
    expect(calls.every((call) => call.authorization === "Bearer super-secret-key")).toBe(true);
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
    expect(calls.map((call) => call.body["input_type"])).toEqual(["document", "query"]);
    expect(JSON.stringify(coordinator.status())).not.toContain("super-secret-key");
    await coordinator.stop();
  });

  it("falls back to keyword search with a stable public reason on Provider failure", async () => {
    const store = fixtureStore();
    const coordinator = coordinatorFor(store, vi.fn(async () => new Response("do not expose upstream body", {
      status: 401
    })) as typeof globalThis.fetch);
    coordinator.start();
    appendMessage(store, "event-a", "session-a", 10, "release readiness");
    await coordinator.drain();
    // Install one valid vector so query embedding reaches the failing route.
    const [job] = store.claimMessageEmbeddingJobs(1, Date.now() + 60_000);
    if (job !== undefined) {
      store.completeMessageEmbeddingJob(
        job.eventCursor,
        job.claimToken,
        "embedding-provider",
        EMBEDDING_GENERATION_ID,
        "voyage/voyage-4",
        vector(0)
      );
    }

    const result = await coordinator.embedQuery("deployment guidance", "hybrid");
    expect(result.semantic).toBeUndefined();
    expect(result.skipReason).toBe("The embedding Provider is not authenticated; keyword search was used.");
    expect(result.skipReason).not.toContain("upstream body");
    await coordinator.stop();
  });

  it("accepts an omitted upstream model identity as the requested alias", async () => {
    const store = fixtureStore();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly input: readonly string[] };
      return new Response(JSON.stringify({
        object: "list",
        data: body.input.map((_text, index) => ({ index, embedding: vector(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const coordinator = coordinatorFor(store, fetch);
    coordinator.start();
    appendMessage(store, "event-no-model", "session-a", 10, "response without model metadata");
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({
      modelId: "voyage/voyage-4",
      doneCount: 1
    }));
    expect((await coordinator.embedQuery("model fallback", "hybrid")).semantic)
      .toEqual(expect.objectContaining({ modelId: "voyage/voyage-4" }));
    await coordinator.stop();
  });

  it("rebuilds the index when an upstream alias resolves to a new actual model", async () => {
    const store = fixtureStore();
    let upstreamModel = "voyage/voyage-4-20250101";
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly input: readonly string[] };
      return new Response(JSON.stringify({
        object: "list",
        model: upstreamModel,
        data: body.input.map((_text, index) => ({ index, embedding: vector(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const coordinator = coordinatorFor(store, fetch);
    coordinator.start();
    appendMessage(store, "event-versioned-model", "session-a", 10, "versioned model vector");

    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({
      modelId: upstreamModel,
      pendingCount: 1,
      doneCount: 0
    }));
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ pendingCount: 0, doneCount: 1 }));
    expect((await coordinator.embedQuery("first actual model", "hybrid")).semantic)
      .toEqual(expect.objectContaining({ modelId: upstreamModel }));

    upstreamModel = "voyage/voyage-4-20260801";
    const changed = await coordinator.embedQuery("detect changed actual model", "hybrid");
    expect(changed.semantic).toBeUndefined();
    expect(changed.skipReason).toMatch(/index is rebuilding/u);
    expect(coordinator.status()).toEqual(expect.objectContaining({
      modelId: upstreamModel,
      pendingCount: 1,
      doneCount: 0
    }));
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ pendingCount: 0, doneCount: 1 }));
    await coordinator.stop();
  });

  it("honors the durable disabled setting across restart and never dispatches new content", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.message_search", { semanticIndexEnabled: false });
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const coordinator = coordinatorFor(store, fetch);
    coordinator.start();
    expect(coordinator.configuredEnabled()).toBe(false);
    appendMessage(store, "event-disabled", "session-a", 10, "must remain local");
    await coordinator.drain();

    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: false, pendingCount: 0 }));
    expect(fetch).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("drains accepted work after disable but never backfills messages created while disabled", async () => {
    const store = fixtureStore();
    const fetch = successfulFetch();
    const coordinator = coordinatorFor(store, fetch);
    coordinator.start();
    appendMessage(store, "event-accepted", "session-a", 10, "accepted before disable");
    coordinator.setEnabled(false);
    appendMessage(store, "event-disabled", "session-a", 20, "created while disabled");
    await coordinator.drain();

    expect(coordinator.status()).toEqual(expect.objectContaining({ enabled: false, pendingCount: 0, doneCount: 1 }));
    expect(fetch).toHaveBeenCalledOnce();
    await coordinator.stop();
  });

  it("recovers a lease after an early restart and rejects the stale claimant", async () => {
    const store = fixtureStore();
    store.setMessageEmbeddingEnabled(true);
    appendMessage(store, "event-crashed", "session-a", 10, "recover after lease expiry");
    const [stale] = store.claimMessageEmbeddingJobs(1, 100);
    let now = 5_000;
    const fetch = successfulFetch();
    const coordinator = new MessageSearchEmbeddingCoordinator({
      store,
      providers: embeddingProviders(),
      fetch,
      now: () => now,
      setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
    });
    coordinator.start();
    await coordinator.drain();
    expect(fetch).not.toHaveBeenCalled();

    now = 60_100;
    await coordinator.drain();
    expect(fetch).toHaveBeenCalledOnce();
    expect(coordinator.status()).toEqual(expect.objectContaining({ runningCount: 0, doneCount: 1 }));
    expect(() => store.completeMessageEmbeddingJob(
      stale!.eventCursor,
      stale!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      vector(0)
    )).toThrow(/not running/u);
    await coordinator.stop();
  });

  it("terminalizes unembeddable rows without requiring or calling a Provider", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.message_search", { semanticIndexEnabled: true });
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const coordinator = new MessageSearchEmbeddingCoordinator({
      store,
      providers: { resolveOpenAiEmbeddingRoute: () => undefined },
      fetch,
      setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
    });
    coordinator.start();
    appendMessage(store, "event-too-large", "session-a", 10, "x".repeat(31 * 1024));
    store.appendEvent({
      id: "event-no-text",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 20,
      traceId: "embedding-test:no-text",
      payload: { type: "message_complete", role: "assistant", blocks: [] }
    });
    await coordinator.drain();
    expect(coordinator.status()).toEqual(expect.objectContaining({ pendingCount: 0, runningCount: 0 }));
    expect(fetch).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("rejects a remote plaintext embedding endpoint before any header or body is dispatched", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.message_search", { semanticIndexEnabled: true });
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const coordinator = new MessageSearchEmbeddingCoordinator({
      store,
      providers: {
        resolveOpenAiEmbeddingRoute: () => ({
          providerId: "embedding-provider",
          generationId: EMBEDDING_GENERATION_ID,
          modelId: "voyage/voyage-4",
          endpoint: "http://embedding.example/v1/embeddings",
          headers: { "x-api-key": "must-not-leak" }
        })
      },
      fetch,
      setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
    });
    coordinator.start();
    appendMessage(store, "event-unsafe", "session-a", 10, "private chat content");
    await coordinator.drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(coordinator.status()).toEqual(expect.objectContaining({ pendingCount: 1, doneCount: 0 }));
    await coordinator.stop();
  });
});

function coordinatorFor(store: OperationalStore, fetch: typeof globalThis.fetch): MessageSearchEmbeddingCoordinator {
  if (store.findSetting("service", "orchestrator", "settings.message_search") === undefined) {
    store.setSetting("service", "orchestrator", "settings.message_search", { semanticIndexEnabled: true });
  }
  return new MessageSearchEmbeddingCoordinator({
    store,
    providers: embeddingProviders(),
    fetch,
    setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
  });
}

function embeddingProviders() {
  return {
    resolveOpenAiEmbeddingRoute: () => ({
      providerId: "embedding-provider",
      generationId: EMBEDDING_GENERATION_ID,
      modelId: "voyage/voyage-4",
      endpoint: "https://embedding.example/v1/embeddings",
      authorization: "Bearer super-secret-key",
      headers: {}
    })
  };
}

function successfulFetch(): typeof globalThis.fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { readonly input: readonly string[] };
    return new Response(JSON.stringify({
      object: "list",
      model: "voyage/voyage-4",
      data: body.input.map((_text, index) => ({ object: "embedding", index, embedding: vector(0) }))
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

function fixtureStore(): OperationalStore {
  const store = new OperationalStore(":memory:");
  stores.push(store);
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const target of ["a", "b"] as const) {
    store.upsertTarget({
      id: `target-${target}`,
      backendId: "pi",
      displayName: `target-${target}`,
      workspaceRoot: `D:/workspace-${target}`,
      managed: false,
      trusted: true
    });
    store.createSession({
      id: `session-${target}`,
      backendId: "pi",
      targetId: `target-${target}`,
      title: `session-${target}`,
      binding: { opaqueRef: `session-${target}.jsonl`, generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
  }
  return store;
}

function appendMessage(
  store: OperationalStore,
  id: string,
  sessionId: "session-a" | "session-b",
  emittedAt: number,
  text: string
): void {
  store.appendEvent({
    id,
    backendId: "pi",
    targetId: sessionId === "session-a" ? "target-a" : "target-b",
    sessionId,
    generation: 0,
    emittedAt,
    traceId: `embedding-test:${id}`,
    payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] }
  });
}

function vector(axis: 0 | 1): number[] {
  return Array.from({ length: 1024 }, (_, index) => index === axis ? 1 : 0);
}
