import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { Code } from "@connectrpc/connect";
import {
  RunState,
  SessionMessageSearchSemanticMode,
  SessionMessageSearchSessionStatus
} from "@joko/contracts";
import {
  CredentialManager,
  CredentialVault,
  MessageSearchEmbeddingCoordinator,
  ProviderCatalogManager
} from "@joko/orchestrator";
import type { BackendDescriptor } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  archiveMutation,
  createSessionMutation,
  queueRunIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

let fixture: OrchestratorE2eFixture | undefined;
let embeddingServer: Server | undefined;
let releaseHeldQuery: (() => void) | undefined;

class SearchFixtureAdapter extends InstrumentedFakeAdapter {
  override async describe(): Promise<BackendDescriptor> {
    const descriptor = await super.describe();
    return {
      ...descriptor,
      providers: PI_LIKE_PROFILE.models.map((model) => ({
        providerId: model.providerId,
        displayName: model.providerId,
        api: model.api,
        authenticationState: "not_required",
        loginMethods: [],
        supportsLogin: false,
        supportsLogout: false,
        supportsRefresh: false,
        supportsModelRefresh: false
      }))
    };
  }
}

afterEach(async () => {
  releaseHeldQuery?.();
  releaseHeldQuery = undefined;
  await fixture?.close();
  fixture = undefined;
  if (embeddingServer !== undefined) {
    embeddingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => embeddingServer!.close((error) => error ? reject(error) : resolve()));
    embeddingServer = undefined;
  }
});

it("searches durable Session turns through authenticated HTTP, sqlite-vec, and a generation-fenced Provider route", async () => {
  const requests: Array<{ readonly inputType: string; readonly input: readonly string[] }> = [];
  let holdNextQuery = false;
  let queryEntered!: () => void;
  const enteredQuery = new Promise<void>((resolve) => { queryEntered = resolve; });
  const heldQuery = new Promise<void>((resolve) => { releaseHeldQuery = resolve; });
  embeddingServer = createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/embeddings");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly model: string;
        readonly input: readonly string[];
        readonly input_type: string;
        readonly dimensions: number;
      };
      expect(body.model).toBe("voyage/voyage-4");
      expect(body.dimensions).toBe(1024);
      requests.push({ inputType: body.input_type, input: body.input });
      if (holdNextQuery && body.input_type === "query") {
        holdNextQuery = false;
        queryEntered();
        await heldQuery;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        model: "voyage/voyage-4",
        data: body.input.map((_text, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 1024 }, (_, axis) => axis === 0 ? 1 : 0)
        }))
      }));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => embeddingServer!.listen(0, "127.0.0.1", resolve));
  const address = embeddingServer.address();
  if (address === null || typeof address === "string") throw new Error("Embedding server has no TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const secondaryBackendId = "search-secondary";
  let providers!: ProviderCatalogManager;
  let searchIndex!: MessageSearchEmbeddingCoordinator;
  const upsertRoute = (backendId: string) => providers.upsert({
    backendId,
    credentialOrigin: "",
    provider: {
      id: "search-local",
      baseUrl,
      api: "openai-completions",
      keyless: true,
      models: [{ id: "voyage/voyage-4", name: "Voyage 4", contextWindow: 32_768, maxTokens: 4_096 }]
    },
    displayName: "Local search",
    kind: "custom_endpoint",
    credentialBindings: {},
    enabled: true,
    supportsLogin: false,
    supportsLogout: false,
    supportsRefresh: false
  });
  fixture = await OrchestratorE2eFixture.start({
    profiles: [PI_LIKE_PROFILE, { ...PI_LIKE_PROFILE, id: secondaryBackendId, displayName: "Secondary search Backend" }],
    createAdapter: (profile) => new SearchFixtureAdapter(profile),
    createAuxiliaryServices: async (store, dataDirectory) => {
      const vault = await CredentialVault.open(join(dataDirectory, "search-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(dataDirectory, "search-credentials.json") });
      await credentials.initialize();
      providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: PI_LIKE_PROFILE.id });
      providers.initialize();
      await upsertRoute(PI_LIKE_PROFILE.id);
      searchIndex = new MessageSearchEmbeddingCoordinator({ store, providers });
      searchIndex.start();
      return { providers, messageSearch: searchIndex };
    }
  });
  const { store } = fixture.application;
  expect(searchIndex.status().vectorAvailable).toBe(true);
  expect(searchIndex.status()).toMatchObject({ enabled: true, backendId: PI_LIKE_PROFILE.id, providerId: "search-local" });
  const paired = await fixture.pair();
  const sessions: string[] = [];
  for (const [backendId, text] of [[PI_LIKE_PROFILE.id, "mosaicneedle alpha"], [secondaryBackendId, "mosaicneedle beta"]] as const) {
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    sessions.push(sessionId);
    for (const turn of [1, 2]) {
      const generation = BigInt(store.getSession(sessionId).descriptor.binding.generation);
      const sent = await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, generation, `${text} turn ${turn}`));
      await waitFor(() => paired.clients.run.getRun({ runId: queueRunIdFrom(sent) }),
        (run) => run.run?.state === RunState.SUCCEEDED, `${backendId} search turn ${turn}`);
    }
  }
  await waitFor(async () => { await searchIndex.drain(); return searchIndex.status(); },
    (status) => status.doneCount === 4 && status.pendingCount === 0, "four indexed completed messages");
  expect(requests.some((request) => request.inputType === "document" && request.input.length > 0)).toBe(true);

  const search = (query: string, semanticMode: SessionMessageSearchSemanticMode, pageSize = 20, pageToken = "") =>
    paired.clients.session.searchSessionMessages({
      scope: { case: "owner", value: {} }, query, semanticMode,
      page: { pageSize, pageToken }
    });
  const first = await search("mosaicneedle", SessionMessageSearchSemanticMode.KEYWORD, 1);
  expect(first.vectorUsed).toBe(false);
  expect(first.page?.nextPageToken).not.toBe("");
  const allKeyword = [...first.matches];
  let pageToken = first.page!.nextPageToken;
  while (pageToken !== "") {
    const page = await search("mosaicneedle", SessionMessageSearchSemanticMode.KEYWORD, 1, pageToken);
    allKeyword.push(...page.matches);
    pageToken = page.page!.nextPageToken;
  }
  expect(allKeyword).toHaveLength(4);
  expect(new Set(allKeyword.map((match) => match.eventId)).size).toBe(4);
  expect(new Set(allKeyword.map((match) => match.sessionId))).toEqual(new Set(sessions));
  const filtered = await paired.clients.session.searchSessionMessages({
    scope: { case: "owner", value: {} }, query: "mosaicneedle",
    semanticMode: SessionMessageSearchSemanticMode.KEYWORD,
    filters: {
      targetIds: { values: [fixture.targetId(secondaryBackendId)] },
      sessionStatus: SessionMessageSearchSessionStatus.ACTIVE
    },
    page: { pageSize: 20 }
  });
  expect(filtered.matches).toHaveLength(2);
  expect(filtered.matches.every((match) => match.sessionId === sessions[1])).toBe(true);
  const sessionScoped = await paired.clients.session.searchSessionMessages({
    scope: { case: "sessionId", value: sessions[0]! }, query: "mosaicneedle",
    semanticMode: SessionMessageSearchSemanticMode.KEYWORD
  });
  expect(sessionScoped.matches).toHaveLength(2);
  expect(sessionScoped.matches.every((match) => match.sessionId === sessions[0])).toBe(true);
  const targetScoped = await paired.clients.session.searchSessionMessages({
    scope: { case: "targetId", value: fixture.targetId(secondaryBackendId) }, query: "mosaicneedle",
    semanticMode: SessionMessageSearchSemanticMode.KEYWORD
  });
  expect(targetScoped.matches).toHaveLength(2);
  expect(targetScoped.matches.every((match) => match.sessionId === sessions[1])).toBe(true);
  await submit(paired.clients.operation, paired.connectionId, archiveMutation(sessions[1]!, true));
  const archivedExcluded = await paired.clients.session.searchSessionMessages({
    scope: { case: "owner", value: {} }, query: "mosaicneedle",
    semanticMode: SessionMessageSearchSemanticMode.KEYWORD,
    filters: { sessionStatus: SessionMessageSearchSessionStatus.ACTIVE }
  });
  expect(archivedExcluded.matches).toHaveLength(2);
  const archivedIncluded = await paired.clients.session.searchSessionMessages({
    scope: { case: "owner", value: {} }, query: "mosaicneedle",
    semanticMode: SessionMessageSearchSemanticMode.KEYWORD,
    filters: { sessionStatus: SessionMessageSearchSessionStatus.ARCHIVED }
  });
  expect(archivedIncluded.matches).toHaveLength(2);

  const semanticOnly = await search("semantically related", SessionMessageSearchSemanticMode.HYBRID);
  expect(semanticOnly.vectorUsed).toBe(true);
  expect(semanticOnly.matches).toHaveLength(4);
  expect(semanticOnly.matches.every((match) => match.vectorRank !== undefined)).toBe(true);
  const hybrid = await search("mosaicneedle", SessionMessageSearchSemanticMode.HYBRID);
  expect(hybrid.vectorUsed).toBe(true);
  expect(hybrid.matches).toHaveLength(4);
  expect(new Set(hybrid.matches.map((match) => match.eventId)).size).toBe(4);
  expect(hybrid.matches.some((match) => match.ftsRank !== undefined && match.vectorRank !== undefined)).toBe(true);
  const firstHybridPage = await search("mosaicneedle", SessionMessageSearchSemanticMode.HYBRID, 1);
  expect(firstHybridPage.page?.nextPageToken).not.toBe("");

  const originalGeneration = searchIndex.status().providerGenerationId;
  expect(originalGeneration).toBeDefined();
  await upsertRoute(secondaryBackendId);
  await providers.deleteRuntime(PI_LIKE_PROFILE.id, "search-local", {
    expectedVersion: providers.get(PI_LIKE_PROFILE.id, "search-local").version
  });
  searchIndex.reconcileAvailability();
  expect(searchIndex.status()).toMatchObject({ enabled: false, backendId: PI_LIKE_PROFILE.id, providerId: "search-local" });
  const duringLoss = await search("mosaicneedle", SessionMessageSearchSemanticMode.HYBRID);
  expect(duringLoss.vectorUsed).toBe(false);
  expect(duringLoss.matches).toHaveLength(4);
  expect(duringLoss.vectorSkipReason).toMatch(/route/u);
  expect((await search("semantically related", SessionMessageSearchSemanticMode.HYBRID)).matches).toEqual([]);

  await upsertRoute(PI_LIKE_PROFILE.id);
  searchIndex.reconcileAvailability();
  expect(searchIndex.status().providerGenerationId).not.toBe(originalGeneration);
  expect(store.hasMessageEmbeddings("search-local", originalGeneration!, "voyage/voyage-4")).toBe(false);
  expect(searchIndex.status().pendingCount + searchIndex.status().runningCount + searchIndex.status().doneCount).toBe(4);
  await waitFor(async () => { await searchIndex.drain(); return searchIndex.status(); },
    (status) => status.doneCount === 4 && status.pendingCount === 0, "rebuilt route generation");
  expect((await search("semantically related", SessionMessageSearchSemanticMode.HYBRID)).vectorUsed).toBe(true);
  await expect(search("mosaicneedle", SessionMessageSearchSemanticMode.HYBRID, 1,
    firstHybridPage.page!.nextPageToken)).rejects.toMatchObject({ code: Code.InvalidArgument });

  holdNextQuery = true;
  const delayed = search("mosaicneedle alpha", SessionMessageSearchSemanticMode.HYBRID);
  await enteredQuery;
  await upsertRoute(PI_LIKE_PROFILE.id);
  searchIndex.reconcileAvailability();
  expect(searchIndex.status().pendingCount + searchIndex.status().runningCount + searchIndex.status().doneCount).toBe(4);
  releaseHeldQuery?.();
  releaseHeldQuery = undefined;
  const delayedFallback = await delayed;
  expect(delayedFallback.vectorUsed).toBe(false);
  expect(delayedFallback.vectorSkipReason).toMatch(/keyword search was used/u);
  expect(delayedFallback.matches).toHaveLength(4);
  expect(new Set(delayedFallback.matches.map((match) => match.sessionId))).toEqual(new Set(sessions));
  expect(searchIndex.status().providerGenerationId).not.toBe(originalGeneration);
  await waitFor(async () => { await searchIndex.drain(); return searchIndex.status(); },
    (status) => status.doneCount === 4 && status.pendingCount === 0, "latest route generation");
  expect((await search("semantically related", SessionMessageSearchSemanticMode.HYBRID)).vectorUsed).toBe(true);
  expect(requests.some((request) => request.inputType === "query")).toBe(true);
}, 40_000);
