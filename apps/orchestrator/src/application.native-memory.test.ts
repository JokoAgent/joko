import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as codex from "@joko/adapter-codex";
import { FakeCodexAppServer, type ScriptedRpcTransport } from "@joko/adapter-codex/testing";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { OperationService, SettingsService } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorApplication } from "./application.js";
import type { OrchestratorConfig } from "./config.js";
import { createPublicServer } from "./server.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Application native-memory adoption", () => {
  it("keeps accepted work alive and resumes the same thread after a failed then retried idle memory replacement", async () => {
    const setup = await fixture();
    const { application, fake, operations, settings, connection } = setup;
    await setup.memory("use-native-memory", { makerEnabled: false });
    const sessionId = await setup.createSession("original-task");
    const original = application.store.getSession(sessionId).descriptor.binding;
    const nativeId = original.nativeSessionId!;
    const originalBackend = application.store.getBackend("codex").descriptor.instanceGeneration;
    const originalTransport = fake.transport!;
    const waitingSessionId = await setup.createSession("waiting-task");
    const waitingNativeId = application.store.getSession(waitingSessionId).descriptor.binding.nativeSessionId!;
    expect(fake.memoryEnabledForThread(nativeId)).toBe(true);
    const first = application.sessionHost.enqueueInput({ operationId: "accepted-memory-work", sessionId, connection,
      prompt: { text: "Finish this work first", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    await vi.waitFor(() => expect(application.store.getRun(first.runId).descriptor.state).toBe("running"));
    const beforeSet = setup.featureWrites();
    const update = await setup.memory("enable-shared-memory", { makerEnabled: true });
    expect(update.operation?.error).toBeUndefined();
    expect(application.makerMemory!.settings().makerEnabled).toBe(true);
    expect(application.nativeMemoryRestartPending("codex")).toBe(true);
    expect(application.store.getRun(first.runId).descriptor.state).toBe("running");
    expect(originalTransport.running).toBe(true);
    expect(originalTransport.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(0);
    const pending = (await settings.getSettings({})).settings?.memory?.backends.find(row => row.backendId === "codex");
    expect(pending?.reason).toBe("Live native memory confirmation is pending.");
    expect(setup.featureWrites()).toBe(beforeSet);

    // Both owners share the idle coordinator. Reverting only smart routing
    // must not release the independently saved memory change.
    const changeSmartRouting = async (enabled: boolean, operationId: string) => {
      const before = application.subagentModels!.snapshot().find(row => row.backendId === "codex")!;
      const response = await operations.submitOperation({ operationId, connectionId: connection.id,
        mutation: { payload: { case: "updateSubagentModelSettings", value: {
          backendId: "codex", smartRoutingEnabled: enabled, expectedRevision: { value: before.revision }
        } } } });
      expect(response.operation?.error).toBeUndefined();
    };
    await changeSmartRouting(true, "enable-smart-routing");
    expect(application.subagentModels!.snapshot().find(row => row.backendId === "codex")?.smartRoutingRestartPending).toBe(true);
    await changeSmartRouting(false, "restore-smart-routing");
    expect(application.subagentModels!.snapshot().find(row => row.backendId === "codex")?.smartRoutingRestartPending).toBe(false);
    expect(application.nativeMemoryRestartPending("codex")).toBe(true);

    const second = application.sessionHost.enqueueInput({ operationId: "queued-memory-work", sessionId: waitingSessionId, connection,
      prompt: { text: "Use the new setting", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    application.sessionHost.requestQueueDrain(waitingSessionId);
    expect(application.store.getQueueItem(second.queueItemId).state).toBe("accepted");
    expect(originalTransport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    const replay = await setup.memory("enable-shared-memory", { makerEnabled: true });
    expect(replay.operation?.id).toBe(update.operation?.id);
    expect(setup.featureWrites()).toBe(beforeSet);

    const candidatesBefore = setup.candidateAttempts();
    setup.rejectNextCandidate();
    await fake.completeTurn(nativeId, "The accepted work completed");
    await vi.waitFor(() => expect(setup.candidateAttempts()).toBe(candidatesBefore + 1));
    await vi.waitFor(() => expect(application.sessionHost.canReplaceBackendInstance("codex")).toBe(true));
    const failed = (await settings.getSettings({})).settings?.memory?.backends.find(row => row.backendId === "codex");
    expect(failed?.reason).toBe("Live native memory confirmation is pending.");
    expect(application.nativeMemoryRestartPending("codex")).toBe(true);
    expect(originalTransport.running).toBe(true);
    expect(application.store.getQueueItem(second.queueItemId).state).toBe("accepted");
    expect(setup.featureWrites()).toBe(beforeSet);
    await application.refreshNativeMemory("codex");
    await vi.waitFor(() => {
      expect(application.nativeMemoryRestartPending("codex")).toBe(false);
      expect(application.store.getRun(second.runId).descriptor.state).toBe("running");
    }, { timeout: 10_000 });
    const resumed = application.store.getSession(sessionId).descriptor.binding;
    expect(resumed.nativeSessionId).toBe(nativeId);
    expect(resumed.opaqueRef).toBe(original.opaqueRef);
    expect(resumed.generation).toBeGreaterThan(original.generation);
    // The failed candidate reserves its generation without publishing it.
    expect(application.store.getBackend("codex").descriptor.instanceGeneration).toBe(originalBackend + 2);
    expect(originalTransport.running).toBe(false);
    expect(fake.memoryEnabledForThread(nativeId)).toBe(false);
    expect(fake.memoryEnabledForThread(waitingNativeId)).toBe(false);
    expect(fake.transport!.requests.filter(request => request.method === "thread/start")).toHaveLength(0);
    expect(fake.transport!.requests.some(request => request.method === "thread/resume")).toBe(true);
    expect(application.store.getRun(first.runId).descriptor.state).toBe("completed");
    const applied = (await settings.getSettings({})).settings?.memory?.backends.find(row => row.backendId === "codex");
    expect(applied).toMatchObject({ enabled: false, reason: "" });
    const appliedWrites = setup.featureWrites();
    await setup.memory("enable-shared-memory", { makerEnabled: true });
    expect(application.nativeMemoryRestartPending("codex")).toBe(false);
    expect(setup.featureWrites()).toBe(appliedWrites);
    expect(application.store.getBackend("codex").descriptor.instanceGeneration).toBe(originalBackend + 2);
    await fake.completeTurn(waitingNativeId);
  }, 60_000);

  it.each(["inactive", "initialization_failure", "configuration_mismatch", "unavailable"] as const)(
    "allows a cold %s generation to apply the durable preference before its first thread without a replacement hold",
    async boundary => {
      const setup = await fixture(boundary);
      const { application, fake, settings, connection } = setup;
      const backendGeneration = application.store.getBackend("codex").descriptor.instanceGeneration;
      expect(application.nativeMemoryRestartPending("codex")).toBe(false);
      if (boundary === "inactive") await fake.transport!.exit(false);
      if (boundary === "unavailable") {
        expect(application.store.getBackend("codex").descriptor.health).toBe("unavailable");
        await application.refreshBackendDescriptor("codex");
      }
      const beforeStatus = setup.featureWrites();
      await settings.getSettings({});
      expect(setup.featureWrites()).toBe(beforeStatus);
      expect(application.nativeMemoryRestartPending("codex")).toBe(false);
      const sessionId = await setup.createSession(`cold-${boundary}`);
      const nativeId = application.store.getSession(sessionId).descriptor.binding.nativeSessionId!;
      expect(fake.memoryEnabledForThread(nativeId)).toBe(false);
      const requests = fake.transport!.requests;
      expect(requests.findIndex(request => request.method === "experimentalFeature/enablement/set"))
        .toBeLessThan(requests.findIndex(request => request.method === "thread/start"));
      const run = application.sessionHost.enqueueInput({ operationId: `dispatch-${boundary}`, sessionId, connection,
        prompt: { text: "A cold task can dispatch", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
      await vi.waitFor(() => expect(application.store.getRun(run.runId).descriptor.state).toBe("running"));
      expect(application.nativeMemoryRestartPending("codex")).toBe(false);
      expect(application.store.getBackend("codex").descriptor.instanceGeneration).toBe(backendGeneration);
      await fake.completeTurn(nativeId);
    }, 60_000
  );
});

async function fixture(boundary?: "inactive" | "initialization_failure" | "configuration_mismatch" | "unavailable") {
  const root = await mkdtemp(join(tmpdir(), "joko-application-native-memory-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const workspace = join(root, "workspace"), dataDirectory = join(root, "data"), profile = join(root, "codex");
  await mkdir(workspace); await mkdir(profile);
  vi.stubEnv("CODEX_HOME", profile);
  const fake = new FakeCodexAppServer();
  if (boundary === "initialization_failure") fake.failNextNativeMemoryEnablement = true;
  if (boundary === "configuration_mismatch") fake.nextNativeMemoryStatusResponse = { config: { features: { memories: true } } };
  const transports: ScriptedRpcTransport[] = [];
  let failStartup = boundary === "unavailable";
  let rejectNextCandidate = false, candidateAttempts = 0;
  vi.spyOn(codex, "createCodexAdapter").mockImplementation(options => {
    candidateAttempts++;
    if (rejectNextCandidate) { rejectNextCandidate = false; throw new Error("Controlled replacement candidate failure."); }
    return new codex.CodexBackendAdapter({
    ...options,
    profileDirectory: profile,
    nativeExecution: { openExecServer: async () => ({
      execServerUrl: "ws://127.0.0.1:43123/ws/exec-server", authBearerToken: "x".repeat(43),
      assertCurrent: () => undefined, close: async () => undefined
    }) },
    appServer: { ...options.appServer, transportFactory: () => {
      if (failStartup) { failStartup = false; throw new codex.TransportFault("spawn_failed", "Controlled unavailable installation."); }
      // Each process starts from native defaults; saved threads are retained,
      // while the fake's per-thread config is recaptured only on cold resume.
      fake.nativeMemoryEnabled = true;
      const transport = fake.createTransport(); transports.push(transport); return transport;
    } }
    });
  });
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4327,
    publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4327",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"),
    allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false, voiceDictionaryLanDiscoveryEnabled: false,
    codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "native-memory-workspace", root: workspace, displayName: "Native memory", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web-build"), corsOrigins: []
  };
  const application = await createOrchestratorApplication(config);
  cleanups.push(() => application.close());
  const server = await createPublicServer(application);
  cleanups.push(() => server.close());
  server.log.level = "silent";
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const challenge = application.connections.issuePairing("Native memory owner");
  const paired = application.connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Native memory owner" });
  const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", defaultTimeoutMs: 20_000,
    interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
  const operations = createClient(OperationService, transport), settings = createClient(SettingsService, transport);
  return {
    application, fake, operations, settings, connection: paired.connection,
    candidateAttempts: () => candidateAttempts,
    rejectNextCandidate: () => { rejectNextCandidate = true; },
    featureWrites: () => transports.reduce((total, item) => total + item.requests.filter(request => request.method === "experimentalFeature/enablement/set").length, 0),
    memory: (operationId: string, patch: { makerEnabled?: boolean; backendId?: string; backendEnabled?: boolean }) =>
      operations.submitOperation({ operationId, connectionId: paired.connection.id,
        mutation: { payload: { case: "updateMemorySettings", value: { patch } } } }),
    createSession: async (operationId: string) => (await application.sessionHost.createSession({ operationId,
      connection: paired.connection, targetId: `${config.workspace.id}:codex`, title: operationId,
      providerId: "openai", modelId: "gpt-test", permissionMode: "ask", fastMode: false, planMode: false })).value.sessionId
  };
}
