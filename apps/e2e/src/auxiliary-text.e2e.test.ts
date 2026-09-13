import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { OperationMutationSchema, OperationState, SessionTitleSuggestionStatus, type ModelRouteRef } from "@joko/contracts";
import { AuxiliaryTextRouting, CredentialManager, CredentialVault, ProviderCatalogManager, SessionNavigationCoordinator, createModelRouteCatalog } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

let fixture: OrchestratorE2eFixture | undefined;
let inferenceServer: Server | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (inferenceServer !== undefined) {
    inferenceServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => inferenceServer!.close((error) => error ? reject(error) : resolve()));
    inferenceServer = undefined;
  }
});

it("persists an independent auxiliary chain across clients and uses its fallback through authenticated HTTP", async () => {
  const calls: string[] = [];
  inferenceServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
    calls.push(input.model);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: input.model === "primary" ? "" : "Fix file preview" } }] }));
  });
  await new Promise<void>((resolve) => inferenceServer!.listen(0, "127.0.0.1", resolve));
  const address = inferenceServer.address();
  if (address === null || typeof address === "string") throw new Error("Inference server has no TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const profile = {
    ...PI_LIKE_PROFILE,
    capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "provider.managed_catalog", supported: true }, { key: "session.ai_rename", supported: true }],
    models: [...PI_LIKE_PROFILE.models, ...["primary", "fallback"].map((modelId) => ({
      ...PI_LIKE_PROFILE.models[0]!, providerId: "auxiliary-local", modelId, displayName: modelId, api: "openai-completions"
    }))]
  };
  fixture = await OrchestratorE2eFixture.start({
    profiles: [profile],
    createAuxiliaryServices: async (store, dataDirectory) => {
      const vault = await CredentialVault.open(join(dataDirectory, "auxiliary-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(dataDirectory, "auxiliary-credentials.json") });
      await credentials.initialize();
      const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: profile.id });
      providers.initialize();
      await providers.upsert({
        backendId: profile.id, credentialOrigin: "",
        provider: { id: "auxiliary-local", baseUrl, api: "openai-completions", keyless: true,
          models: ["primary", "fallback"].map((id) => ({ id, name: id, contextWindow: 32_000, maxTokens: 4_000 })) },
        displayName: "Auxiliary local", kind: "custom_endpoint", credentialBindings: {}, enabled: true,
        supportsLogin: false, supportsLogout: false, supportsRefresh: false
      });
      const auxiliaryText = new AuxiliaryTextRouting({ store, providers, routes: createModelRouteCatalog(store, providers) });
      return { providers, auxiliaryText, sessionNavigation: new SessionNavigationCoordinator({ store, auxiliary: auxiliaryText, credentials }) };
    }
  });
  const first = await fixture.pair("First settings window");
  const second = await fixture.pair("Second settings window");
  const read = async () => (await first.clients.settings.getSettings({})).settings!.auxiliaryText!;
  const initial = await read();
  expect(initial.revision!.value).toBe(0n);
  const models = ["primary", "fallback"].map((modelId) => ({ backendId: profile.id, providerId: "auxiliary-local", modelId }));
  const mutation = (values: readonly Omit<ModelRouteRef, "$typeName">[], revision: bigint) => create(OperationMutationSchema, {
    payload: { case: "updateAuxiliaryTextSettings", value: { models: [...values], expectedRevision: { value: revision } } }
  });
  const operationId = randomUUID();
  const saved = await submit(first.clients.operation, first.connectionId, mutation(models, 0n), operationId);
  expect(saved.state).toBe(OperationState.SUCCEEDED);
  const current = await read();
  expect(current.models.map((model) => model.modelId)).toEqual(["primary", "fallback"]);
  const revision = current.revision!.value;
  await expect(submit(second.clients.operation, second.connectionId, mutation([], 0n))).rejects.toMatchObject({ code: Code.Aborted });
  await submit(first.clients.operation, first.connectionId, mutation(models, 0n), operationId);
  expect((await read()).revision!.value).toBe(revision);
  await expect(submit(first.clients.operation, first.connectionId, mutation([models[0]!, models[0]!], revision))).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect((await read()).revision!.value).toBe(revision);

  const sessionId = sessionIdFrom(await submit(first.clients.operation, first.connectionId, createSessionMutation({
    backendId: profile.id, targetId: fixture.targetId(), providerId: "test", modelId: "text"
  })));
  const session = fixture.application.store.getSession(sessionId);
  fixture.application.store.appendEvent({
    id: randomUUID(), backendId: profile.id, targetId: fixture.targetId(), sessionId,
    generation: session.descriptor.binding.generation, emittedAt: Date.now(), traceId: "auxiliary-title-material",
    payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Fix the SVG file preview in chat." }] }
  });
  const suggestion = await first.clients.session.suggestSessionTitle({ sessionId });
  expect(suggestion).toMatchObject({ title: "Fix file preview", status: SessionTitleSuggestionStatus.OK });
  expect(calls).toEqual(["primary", "fallback"]);
  expect(fixture.application.store.getSession(sessionId).descriptor).toMatchObject({ providerId: "test", modelId: "text" });
  await submit(second.clients.operation, second.connectionId, mutation([], revision));
  const reset = await read();
  expect(reset.models).toEqual([]);
  expect(reset.revision!.value).toBeGreaterThan(revision);
  await expect(submit(first.clients.operation, first.connectionId, mutation(models, revision))).rejects.toMatchObject({ code: Code.Aborted });
  expect(fixture.application.store.findSetting("service", "orchestrator", "settings.auxiliary_text")?.value).toEqual({ models: [] });
});
