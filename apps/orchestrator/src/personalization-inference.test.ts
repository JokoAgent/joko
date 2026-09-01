import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderCatalogManager, ProviderInferenceRoute } from "./credential-manager.js";
import { createModelRouteCatalog, PromptPredictionService, VisionBridgeCoordinator, type VisionBridgeCoordinatorOptions } from "./personalization-inference.js";

const stores: OperationalStore[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of tempRoots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("VisionBridgeCoordinator", () => {
  it("keeps Backend identity when two Backend instances expose the same Provider model", () => {
    const store = fixtureStore();
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "same-model", input: ["text"] }])
    ]), undefined, undefined, undefined, ["backend-a", "backend-b"]);

    expect(vision.state().targetModels).toEqual([
      { backendId: "backend-a", providerId: "provider-a", modelId: "same-model" },
      { backendId: "backend-b", providerId: "provider-a", modelId: "same-model" }
    ]);
  });

  it("isolates cached descriptions across focus text that diverges after 512 characters", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "text-model" }],
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    let responseIndex = 0;
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: `description-${++responseIndex}` } }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "text-model", input: ["text"] }]),
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute()), fetch);
    const shared = "x".repeat(600);
    const image = { blob: { id: "focus-cache", sha256: "f".repeat(64), byteLength: 12, mimeType: "image/png" } };
    const transform = (text: string) => vision.transform({
      backendId: "pi", providerId: "provider-a", modelId: "text-model", text, images: [image]
    });

    await expect(transform(`${shared} first suffix`)).resolves.toMatchObject({ descriptions: ["description-1"] });
    await expect(transform(`${shared} second suffix`)).resolves.toMatchObject({ descriptions: ["description-2"] });
    await expect(transform(`${shared} first suffix`)).resolves.toMatchObject({ descriptions: ["description-1"] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bridges only the exact Backend+Provider+Model target and never dispatches after abort", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "same-model" }],
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "A factual image description." } }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "same-model", input: ["text"] }]),
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute()), fetch, undefined, undefined, ["pi", "backend-b"]);
    const image = { blob: { id: "blob-1", sha256: "a".repeat(64), byteLength: 12, mimeType: "image/png" } };

    await expect(vision.transform({ backendId: "backend-b", providerId: "provider-a", modelId: "same-model", text: "", images: [image] }))
      .resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();

    await expect(vision.transform({ backendId: "pi", providerId: "provider-a", modelId: "same-model", text: "focus", images: [image] }))
      .resolves.toMatchObject({ descriptions: ["A factual image description."], unavailableCount: 0 });
    expect(fetch).toHaveBeenCalledOnce();

    const aborted = new AbortController();
    aborted.abort();
    await expect(vision.transform({
      backendId: "pi",
      providerId: "provider-a",
      modelId: "same-model",
      text: "must not dispatch",
      images: [image],
      signal: aborted.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("replaces total analysis failure with an explicit non-hallucination placeholder", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "text-model" }],
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    const fetch = vi.fn(async () => new Response("upstream payload must not leak", { status: 503 })) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "text-model", input: ["text"] }]),
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute()), fetch);
    const result = await vision.transform({
      backendId: "pi",
      providerId: "provider-a",
      modelId: "text-model",
      text: "",
      images: [{ blob: { id: "blob-1", sha256: "b".repeat(64), byteLength: 12, mimeType: "image/png" } }]
    });

    expect(result?.unavailableCount).toBe(1);
    expect(result?.descriptions[0]).toContain("Do not infer or invent");
    expect(JSON.stringify(store.findSetting("service", "orchestrator", "settings.vision_bridge")?.value)).not.toContain("secret-key");
  });

  it("sniffs Layer-B image bytes, rejects spoofed/oversized content, and emits the actual JPEG media type", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "text-model" }],
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "JPEG description." } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const fetch = fetchMock as unknown as typeof globalThis.fetch;
    const providers = providerCatalog([
      provider("provider-a", [{ id: "text-model", input: ["text"] }]),
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute());
    const input = (id: string, byteLength: number) => ({
      backendId: "pi",
      providerId: "provider-a",
      modelId: "text-model",
      text: "",
      images: [{ blob: { id, sha256: id.padEnd(64, "e").slice(0, 64), byteLength, mimeType: "image/png" } }]
    });
    const spoofed = coordinator(store, providers, fetch, undefined, async () => ({
      data: new TextEncoder().encode("not-an-image"),
      mimeType: "image/png"
    }));
    await expect(spoofed.transform(input("spoof", 12))).resolves.toMatchObject({ unavailableCount: 1 });
    expect(fetch).not.toHaveBeenCalled();

    const oversized = coordinator(store, providers, fetch, undefined, async () => ({
      data: new Uint8Array(15 * 1024 * 1024 + 1),
      mimeType: "image/png"
    }));
    await expect(oversized.transform(input("oversize", 12))).resolves.toMatchObject({ unavailableCount: 1 });
    expect(fetch).not.toHaveBeenCalled();

    const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const jpeg = coordinator(store, providers, fetch, undefined, async () => ({
      data: jpegBytes,
      mimeType: "image/png"
    }));
    await expect(jpeg.transform(input("jpeg", jpegBytes.byteLength))).resolves.toMatchObject({
      descriptions: ["JPEG description."],
      unavailableCount: 0
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as {
      readonly messages: readonly { readonly content: unknown }[];
    };
    expect(JSON.stringify(body.messages)).toContain("data:image/jpeg;base64,");
  });

  it("uses a distinct Provider+Model fallback only after the primary route fails", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "text-model" }],
      primary: { backendId: "pi", providerId: "vision-primary", modelId: "primary-model" },
      fallback: { backendId: "pi", providerId: "vision-fallback", modelId: "fallback-model" }
    });
    const routes = [
      inferenceRoute({ providerId: "vision-primary", modelId: "primary-model", generationId: "primary-generation" }),
      inferenceRoute({ providerId: "vision-fallback", modelId: "fallback-model", generationId: "fallback-generation" })
    ];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly model: string };
      return body.model === "primary-model"
        ? new Response("primary unavailable", { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "Fallback description." } }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
    }) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "text-model", input: ["text"] }]),
      provider("vision-primary", [{ id: "primary-model", input: ["text", "image"] }]),
      provider("vision-fallback", [{ id: "fallback-model", input: ["text", "image"] }])
    ], routes), fetch);

    await expect(vision.transform({
      backendId: "pi",
      providerId: "provider-a",
      modelId: "text-model",
      text: "",
      images: [{ blob: { id: "blob-fallback", sha256: "c".repeat(64), byteLength: 12, mimeType: "image/png" } }]
    })).resolves.toEqual({ descriptions: ["Fallback description."], usedFallback: true, unavailableCount: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("limits all live Vision inference, including tool calls, to two concurrent requests", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "text-model" }],
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fetch = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "description" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "text-model", input: ["text"] }]),
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute()), fetch);
    const pending = vision.transform({
      backendId: "pi",
      providerId: "provider-a",
      modelId: "text-model",
      text: "",
      images: Array.from({ length: 3 }, (_, index) => ({
        blob: {
          id: `blob-${index}`,
          sha256: String(index + 1).repeat(64),
          byteLength: 12,
          mimeType: "image/png"
        }
      }))
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    for (const release of releases.splice(0)) release();
    await expect(pending).resolves.toMatchObject({ unavailableCount: 0 });
    expect(maximumActive).toBe(2);
  });

  it("enforces the production request budget through an aborting timeout signal", async () => {
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [{ backendId: "pi", providerId: "provider-a", modelId: "text-model" }],
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
      })) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("provider-a", [{ id: "text-model", input: ["text"] }]),
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute()), fetch, 5);

    await expect(vision.transform({
      backendId: "pi",
      providerId: "provider-a",
      modelId: "text-model",
      text: "",
      images: [{ blob: { id: "blob-timeout", sha256: "d".repeat(64), byteLength: 12, mimeType: "image/png" } }]
    })).resolves.toMatchObject({ unavailableCount: 1, usedFallback: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps Layer-C image paths inside approved canonical roots and rejects non-image bytes before dispatch", async () => {
    const approvedRoot = await temporaryRoot("joko-vision-approved-");
    const outsideRoot = await temporaryRoot("joko-vision-outside-");
    const approvedImage = join(approvedRoot, "approved.png");
    const outsideImage = join(outsideRoot, "outside.png");
    const notImage = join(approvedRoot, "not-image.txt");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    await writeFile(approvedImage, png);
    await writeFile(outsideImage, png);
    await writeFile(notImage, "definitely not an image");
    const store = fixtureStore();
    store.setSetting("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      primary: { backendId: "pi", providerId: "vision-provider", modelId: "vision-model" }
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Approved file description." } }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const vision = coordinator(store, providerCatalog([
      provider("vision-provider", [{ id: "vision-model", input: ["text", "image"] }])
    ], inferenceRoute()), fetch);

    await expect(vision.describeFile({ path: approvedImage, focus: "", allowedRoots: [approvedRoot] }))
      .resolves.toBe("Approved file description.");
    await expect(vision.describeFile({ path: outsideImage, focus: "", allowedRoots: [approvedRoot] }))
      .rejects.toMatchObject({ message: "IMAGE_UNAVAILABLE" });
    await expect(vision.describeFile({ path: notImage, focus: "", allowedRoots: [approvedRoot] }))
      .rejects.toMatchObject({ message: "IMAGE_UNAVAILABLE" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(vision.describeFile({ path: approvedImage, focus: "", allowedRoots: [approvedRoot], signal: aborted.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("PromptPredictionService", () => {
  it("predicts only from a completed, exactly fenced Session and keeps the result ephemeral", async () => {
    const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
    appendMessage(store, "event-user", "user", "Please finish the tests.", 10);
    appendMessage(store, "event-assistant", "assistant", "The implementation is ready.", 20);
    appendDone(store, "completed", 30);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Run the focused tests." } }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const prediction = new PromptPredictionService({
      store,
      routes: predictionRoutes(store),
      fetch
    });
    const session = store.getSession("session-a").descriptor;

    await expect(prediction.predict({
      sessionId: "session-a",
      expectedLastActivityAt: session.updatedAt,
      expectedGeneration: session.binding.generation,
      locale: "en"
    })).resolves.toBe("Run the focused tests.");
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.listEvents({ sessionId: "session-a", limit: 100 }).map((event) => event.payload)))
      .not.toContain("Run the focused tests.");

    await expect(prediction.predict({
      sessionId: "session-a",
      expectedLastActivityAt: session.updatedAt,
      expectedGeneration: session.binding.generation + 1,
      locale: "en"
    })).resolves.toBe("");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not route a native Backend Session through a managed Backend with the same Provider and model IDs", async () => {
    const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
    appendMessage(store, "event-user", "user", "Keep this conversation on its native Backend.", 10);
    appendMessage(store, "event-assistant", "assistant", "The native result is complete.", 20);
    appendDone(store, "completed", 30);
    const providers = providerCatalog([provider("provider-a", [{ id: "text-model", input: ["text"] }])], {
      ...inferenceRoute(),
      providerId: "provider-a",
      modelId: "text-model",
      supportsImages: false
    });
    configureModelBackend(store, providers, "pi", false);
    configureModelBackend(store, providers, "managed-backend", true);
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const prediction = new PromptPredictionService({
      store,
      routes: createModelRouteCatalog(store, providers),
      fetch
    });
    const session = store.getSession("session-a").descriptor;

    expect(prediction.state().available).toBe(true);
    await expect(prediction.predict({
      sessionId: session.id,
      expectedLastActivityAt: session.updatedAt,
      expectedGeneration: session.binding.generation,
      locale: "en"
    })).resolves.toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finds the latest conversation and terminal outcome beyond every fixed event window", async () => {
    const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
    appendMessage(store, "event-user", "user", "Use the newest durable context.", 10);
    appendMessage(store, "event-assistant", "assistant", "The long Session is ready.", 20);
    appendDone(store, "completed", 30);
    store.appendEvent({
      id: "event-filler",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 40,
      traceId: "prediction:filler",
      payload: { type: "status", key: "filler", text: "filler" }
    });
    const persisted = store.listEvents({ sessionId: "session-a", limit: 10 });
    const user = persisted.find((event) => event.id === "event-user")!;
    const assistant = persisted.find((event) => event.id === "event-assistant")!;
    const done = persisted.find((event) => event.payload.type === "done")!;
    const filler = persisted.find((event) => event.id === "event-filler")!;
    const virtual: ReturnType<OperationalStore["listEvents"]> = [
      ...Array.from({ length: 10_001 }, (_, index) => ({
        ...filler,
        id: `before-${index}`,
        globalCursor: BigInt(index + 1)
      })),
      { ...user, globalCursor: 10_002n },
      { ...assistant, globalCursor: 10_003n },
      { ...done, globalCursor: 10_004n },
      ...Array.from({ length: 10_001 }, (_, index) => ({
        ...filler,
        id: `after-${index}`,
        globalCursor: BigInt(10_005 + index)
      }))
    ];
    vi.spyOn(store, "listEvents").mockImplementation((query = {}) => {
      const rows = virtual
        .filter((event) => query.sessionId === undefined || event.sessionId === query.sessionId)
        .filter((event) => query.afterCursor === undefined || event.globalCursor > query.afterCursor)
        .filter((event) => query.beforeCursor === undefined || event.globalCursor < query.beforeCursor)
        .sort((left, right) => query.order === "desc"
          ? Number(right.globalCursor - left.globalCursor)
          : Number(left.globalCursor - right.globalCursor));
      return rows.slice(0, query.limit ?? 1_000);
    });
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("Use the newest durable context.");
      return new Response(JSON.stringify({ choices: [{ message: { content: "Continue from the latest state." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof globalThis.fetch;
    const prediction = predictionService(store, fetch);
    const session = store.getSession("session-a").descriptor;

    await expect(prediction.predict({
      sessionId: "session-a",
      expectedLastActivityAt: session.updatedAt,
      expectedGeneration: session.binding.generation,
      locale: "en"
    })).resolves.toBe("Continue from the latest state.");
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.listEvents).toHaveBeenCalledWith(expect.objectContaining({ order: "desc", beforeCursor: expect.any(BigInt) }));
  });

  it("does not dispatch after an aborted or failed terminal outcome", async () => {
    const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
    appendMessage(store, "event-user", "user", "Try something.", 10);
    appendDone(store, "failed", 20);
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const prediction = new PromptPredictionService({
      store,
      routes: predictionRoutes(store),
      fetch
    });
    const session = store.getSession("session-a").descriptor;

    await expect(prediction.predict({
      sessionId: "session-a",
      expectedLastActivityAt: session.updatedAt,
      expectedGeneration: session.binding.generation,
      locale: "en"
    })).resolves.toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["active run", "queued input", "background task"] as const)(
    "fences prediction while the Session has an %s",
    async (fence) => {
      const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
      appendMessage(store, "event-user", "user", "Please finish the tests.", 10);
      appendMessage(store, "event-assistant", "assistant", "The implementation is ready.", 20);
      appendDone(store, "completed", 30);
      if (fence === "active run") {
        store.createRun({ id: "run-active", sessionId: "session-a", source: "user", state: "running", createdAt: 40 });
      } else if (fence === "queued input") {
        store.createRun({ id: "run-queued-owner", sessionId: "session-a", source: "user", state: "completed", createdAt: 40, endedAt: 40 });
        store.createAttempt({
          id: "attempt-queued-owner",
          runId: "run-queued-owner",
          ordinal: 1,
          generation: store.getSession("session-a").descriptor.binding.generation,
          startedAt: 40,
          endedAt: 40
        });
        store.runOperation({ id: "operation-queued", kind: "prompt", body: { text: "queued" } }, (transaction) => {
          transaction.enqueueQueueItem({
            id: "queue-accepted",
            sessionId: "session-a",
            runId: "run-queued-owner",
            attemptId: "attempt-queued-owner",
            operationId: "operation-queued",
            disposition: "prompt",
            body: { text: "queued", images: [], files: [], mentions: [], disposition: "prompt" },
            createdAt: 41
          });
          return { accepted: true };
        });
      } else {
        store.appendEvent({
          id: "event-background",
          backendId: "pi",
          targetId: "target-a",
          sessionId: "session-a",
          generation: 0,
          emittedAt: 40,
          traceId: "prediction:background",
          payload: { type: "background_task", taskId: "task-a", title: "Background task", state: "running" }
        });
      }
      const fetch = vi.fn() as unknown as typeof globalThis.fetch;
      const prediction = predictionService(store, fetch);
      const session = store.getSession("session-a").descriptor;

      await expect(prediction.predict({
        sessionId: "session-a",
        expectedLastActivityAt: session.updatedAt,
        expectedGeneration: session.binding.generation,
        locale: "en"
      })).resolves.toBe("");
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("does not infer during background work and dispatches exactly once after its terminal edge", async () => {
    const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
    appendMessage(store, "event-user", "user", "Please finish the tests.", 10);
    appendMessage(store, "event-assistant", "assistant", "The implementation is ready.", 20);
    appendDone(store, "completed", 30);
    store.appendEvent({
      id: "event-background-running",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 40,
      traceId: "prediction:background:running",
      payload: { type: "background_task", taskId: "task-a", title: "Background task", state: "running" }
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Run the focused tests." } }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const prediction = predictionService(store, fetch);
    const session = store.getSession("session-a").descriptor;
    const input = {
      sessionId: "session-a",
      expectedLastActivityAt: session.updatedAt,
      expectedGeneration: session.binding.generation,
      locale: "en"
    } as const;

    await expect(prediction.predict(input)).resolves.toBe("");
    expect(fetch).not.toHaveBeenCalled();

    store.appendEvent({
      id: "event-background-completed",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 41,
      traceId: "prediction:background:completed",
      payload: { type: "background_task", taskId: "task-a", title: "Background task", state: "completed" }
    });
    await expect(prediction.predict(input)).resolves.toBe("Run the focused tests.");
    await expect(prediction.predict(input)).resolves.toBe("Run the focused tests.");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["updatedAt", "generation"] as const)(
    "drops an in-flight result when the Session %s fence changes",
    async (fence) => {
      const store = fixtureStore({ providerId: "provider-a", modelId: "text-model" });
      appendMessage(store, "event-user", "user", "Please finish the tests.", 10);
      appendMessage(store, "event-assistant", "assistant", "The implementation is ready.", 20);
      appendDone(store, "completed", 30);
      const response = deferred<Response>();
      const fetchMock = vi.fn(() => response.promise);
      const prediction = predictionService(store, fetchMock as unknown as typeof globalThis.fetch);
      const before = store.getSession("session-a");
      const pending = prediction.predict({
        sessionId: "session-a",
        expectedLastActivityAt: before.descriptor.updatedAt,
        expectedGeneration: before.descriptor.binding.generation,
        locale: "en"
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      if (fence === "updatedAt") {
        store.updateSession("session-a", { title: before.descriptor.title }, before.revision, before.descriptor.updatedAt + 1);
      } else {
        store.updateSession("session-a", {
          binding: { ...before.descriptor.binding, generation: before.descriptor.binding.generation + 1 }
        }, before.revision, before.descriptor.updatedAt);
      }
      response.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "This result is stale." } }]
      }), { status: 200, headers: { "content-type": "application/json" } }));

      await expect(pending).resolves.toBe("");
      expect(JSON.stringify(store.listEvents({ sessionId: "session-a", limit: 100 }).map((event) => event.payload)))
        .not.toContain("This result is stale.");
    }
  );
});

function coordinator(
  store: OperationalStore,
  providers: Pick<ProviderCatalogManager, "list" | "hasInferenceModel" | "resolveInferenceRoute">,
  fetch?: typeof globalThis.fetch,
  requestTimeoutMs?: number,
  readBlob: VisionBridgeCoordinatorOptions["readBlob"] = async () => ({
    data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]),
    mimeType: "image/png"
  }),
  backendIds: readonly string[] = ["pi"]
): VisionBridgeCoordinator {
  configureModelBackends(store, providers, backendIds);
  return new VisionBridgeCoordinator({
    store,
    routes: createModelRouteCatalog(store, providers),
    readBlob,
    ...(fetch === undefined ? {} : { fetch }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs })
  });
}

function predictionService(store: OperationalStore, fetch: typeof globalThis.fetch): PromptPredictionService {
  return new PromptPredictionService({
    store,
    routes: predictionRoutes(store),
    fetch
  });
}

function predictionRoutes(store: OperationalStore) {
  const providers = providerCatalog([provider("provider-a", [{ id: "text-model", input: ["text"] }])], {
    ...inferenceRoute(),
    providerId: "provider-a",
    modelId: "text-model",
    supportsImages: false
  });
  configureModelBackends(store, providers, ["pi"]);
  return createModelRouteCatalog(store, providers);
}

function provider(id: string, models: readonly { readonly id: string; readonly input: readonly string[] }[]): unknown {
  return {
    provider: { id, models },
    displayName: id,
    enabled: true,
    authenticationState: "authenticated"
  };
}

function providerCatalog(
  descriptors: readonly unknown[],
  route?: ProviderInferenceRoute | readonly ProviderInferenceRoute[]
): Pick<ProviderCatalogManager, "list" | "hasInferenceModel" | "resolveInferenceRoute"> {
  const catalog = descriptors as ReturnType<ProviderCatalogManager["list"]>;
  const routes: readonly ProviderInferenceRoute[] = route === undefined
    ? []
    : "providerId" in route
      ? [route]
      : route;
  return {
    list: () => catalog,
    hasInferenceModel: (providerId, modelId, options) => catalog.some((descriptor) =>
      descriptor.provider.id === providerId && descriptor.provider.models.some((model) =>
        model.id === modelId && (options?.requireImages !== true || model.input?.includes("image") === true)
      )
    ),
    resolveInferenceRoute: (providerId, modelId, options) => routes.find((candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId &&
      (options?.requireImages !== true || candidate.supportsImages)
    )
  };
}

function configureModelBackends(
  store: OperationalStore,
  providers: Pick<ProviderCatalogManager, "list">,
  backendIds: readonly string[]
): void {
  for (const backendId of backendIds) configureModelBackend(store, providers, backendId, true);
}

function configureModelBackend(
  store: OperationalStore,
  providers: Pick<ProviderCatalogManager, "list">,
  backendId: string,
  managedCatalog: boolean
): void {
  const models = providers.list().flatMap((descriptor) => descriptor.provider.models.map((model) => ({
    providerId: descriptor.provider.id,
    modelId: model.id,
    displayName: model.name ?? model.id,
    api: model.api ?? descriptor.provider.api ?? "openai-completions",
    contextWindow: model.contextWindow ?? 128_000,
    maxOutputTokens: model.maxTokens ?? 16_384,
    supportsImages: model.input?.includes("image") === true,
    thinkingLevels: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  })));
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
        { key: "provider.managed_catalog", supported: true, options: [] }
      ] as const] : [])
    ]),
    models,
    tools: existing?.tools ?? [],
    diagnostics: existing?.diagnostics ?? []
  });
}

function inferenceRoute(overrides: Partial<ProviderInferenceRoute> = {}): ProviderInferenceRoute {
  return {
    providerId: "vision-provider",
    generationId: "generation-1",
    modelId: "vision-model",
    api: "openai-completions",
    baseUrl: "https://provider.invalid/v1",
    authorization: "Bearer secret-key",
    headers: {},
    supportsImages: true,
    ...overrides
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function fixtureStore(model?: { readonly providerId: string; readonly modelId: string }): OperationalStore {
  const store = new OperationalStore(":memory:");
  stores.push(store);
  store.upsertBackend({
    id: "pi", adapterKind: "fixture", instanceGeneration: 0,
    displayName: "Pi", version: "test", health: "healthy",
    installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({
    id: "target-a", backendId: "pi", displayName: "target-a", workspaceRoot: "D:/workspace-a",
    managed: false, trusted: true
  });
  store.createSession({
    id: "session-a", backendId: "pi", targetId: "target-a", title: "session-a",
    binding: { opaqueRef: "session-a.jsonl", generation: 0 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false,
    ...(model === undefined ? {} : model), createdAt: 1, updatedAt: 1
  });
  return store;
}

function appendMessage(store: OperationalStore, id: string, role: "user" | "assistant", text: string, emittedAt: number): void {
  store.appendEvent({
    id, backendId: "pi", targetId: "target-a", sessionId: "session-a", generation: 0,
    emittedAt, traceId: `prediction:${id}`,
    payload: { type: "message_complete", role, blocks: [{ kind: "text", text }] }
  });
}

function appendDone(store: OperationalStore, outcome: "completed" | "failed", emittedAt: number): void {
  store.appendEvent({
    id: `event-done-${outcome}`, backendId: "pi", targetId: "target-a", sessionId: "session-a", generation: 0,
    emittedAt, traceId: `prediction:${outcome}`, payload: { type: "done", outcome }
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
