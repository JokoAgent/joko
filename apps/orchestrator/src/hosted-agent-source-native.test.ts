import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { createPiAdapter } from "@joko/adapter-pi";
import { HostedAgentSourceAdapter } from "@joko/adapter-hosted";
import type { AdapterContext, BackendDescriptor, Capability } from "@joko/core";
import { HostedAgentService } from "@joko/contracts";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { SessionHost } from "./session-host.js";
import { HostedAgentHost } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { createHostedAgentSourceController } from "./hosted-agent-source-controller.js";

it("runs a native Source child against original files, exposes native commands, resumes its exact child and rewinds the opaque native owner", { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-native-"))), workspace = join(root, "source-workspace"), nativeRoot = join(root, "native-node");
  await mkdir(workspace); await mkdir(nativeRoot); await writeFile(join(workspace, "proof.txt"), "SOURCE_CHILD_FILE_BYTES");
  let parentRequests = 0, childRequests = 0, childReads = 0;
  const childResults: string[] = [], lifecycle: string[] = [], nativeFailures: string[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parent = body.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === "subagent");
    const messages = body.messages as { role: string; content?: unknown }[];
    if (parent) {
      parentRequests++;
      if (parentRequests === 1) respond(response, "subagent", { agent: "scout", task: "Read proof.txt and report its original bytes.", background: true, timeoutSeconds: 30 });
      else respond(response, undefined, "SOURCE_PARENT_DONE");
    } else {
      childRequests++;
      const latestUser = messages.findLastIndex(message => message.role === "user");
      const tool = messages.slice(latestUser + 1).find(message => message.role === "tool");
      if (!tool) respond(response, "read", { path: "proof.txt" }, `child-read-${childRequests}`);
      else { childResults.push(JSON.stringify(tool)); if (JSON.stringify(tool).includes("SOURCE_CHILD_FILE_BYTES")) childReads++; respond(response, undefined, "SOURCE_CHILD_DONE"); }
    }
  });
  await new Promise<void>(ready => model.listen(0, "127.0.0.1", ready));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("Missing controlled model listener.");
  const nativeDatabase = new OperationalStore(join(root, "native.sqlite")), sourceDatabase = new OperationalStore(join(root, "source.sqlite"));
  const slots = new HostedAgentSessionSlots(), nativeStore = new HostedAgentStore(nativeDatabase);
  const principal = { id: "source-owner", deviceId: "source-device", trust: "owner" as const, assertCurrent: () => {} };
  const nativeHost = new HostedAgentHost({ authorize: () => ({ root: nativeRoot, store: nativeStore, slots, artifactCapacityBytes: 1024 * 1024,
    modelIds: ["native-model"], assertCurrent: () => {}, assertModelAllowed: (providerId, modelId) => {
      if (providerId !== "provider" || modelId !== "native-model") throw new Error("The original model source changed.");
    }, createAdapter: async ({ home }) => { const adapter = createPiAdapter({ agentHome: home, sessionRoot: home,
      includeManagedSubagentTools: context => context.hostedExecution?.workspace.subagentsEnabled === true,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      providers: [{ id: "provider", api: "openai-completions", keyless: true, baseUrl: `http://127.0.0.1:${address.port}/v1`,
        models: [{ id: "native-model", contextWindow: 32768, maxTokens: 1024 }] }] });
      const navigate = adapter.navigateTree.bind(adapter);
      adapter.navigateTree = async (...args) => { try { return await navigate(...args); } catch (error) { nativeFailures.push(`${String(error)}; cause: ${String((error as Error).cause)}`); throw error; } };
      return adapter;
    } }) });
  const client = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => router.service(HostedAgentService,
    createHostedAgentConnectService({ host: nativeHost, authenticate: () => principal })))), principal.assertCurrent);
  const poller = new HostedAgentPoller(client), sourceId = "native-source";
  const capabilities: Capability[] = ["session.resume", "session.detach", "session.tree", "session.rewind", "session.rewind_to_start", "turn.stream", "turn.abort", "turn.follow_up",
    "input.text", "model.list", "model.switch", "context.usage", "runtime.commands", "subagents.list", "subagents.detail", "subagents.transcript", "subagents.stop", "subagents.resume"].map(key => ({ key, supported: true }));
  capabilities.push({ key: "permission.modes", supported: true, options: ["ask", "bypassPermissions"] });
  const descriptor: BackendDescriptor = { id: sourceId, adapterKind: "hosted", instanceGeneration: 1, displayName: "Native Source", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(capabilities.map(value => [value.key, value])),
    models: [{ providerId: "provider", modelId: "native-model", displayName: "Native model", api: "openai-completions", contextWindow: 32768, maxOutputTokens: 1024,
      supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], tools: [], diagnostics: [] };
  const assertContext = (context: AdapterContext) => { if (context.target.workspaceRoot !== workspace) throw new Error("The original Source workspace changed."); };
  const source = new HostedAgentSourceAdapter({ id: sourceId, source: { controllerDeviceId: principal.deviceId, targetDeviceId: "native-device", backendId: "pi" },
    describe: () => descriptor, assertContext, commands: () => [], workspace: () => ({ platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false, subagentsEnabled: true }),
    readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }), capture: async runId => { lifecycle.push(`open:${runId}`); return { client, assertCurrent: principal.assertCurrent,
      close: () => { lifecycle.push(`close:${runId}`); return client.close(runId, new AbortController().signal); }, createController: input => {
        const controller = createHostedAgentSourceController({ ...input, poller,
        temporaryRoot: join(root, "incoming"), assertContext, assertCurrent: principal.assertCurrent,
        readPolicy: () => ({ revision: "source-policy", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: true }) });
        return { ...controller, start: async () => { try { await controller.start(); } catch (error) { lifecycle.push(`pump-failed:${String(error)}`); throw error; } } };
      } }; } });
  const registry = new BackendInstanceRegistry(sourceDatabase), artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(sourceDatabase), ingestRoots: [root] });
  let host: SessionHost | undefined;
  try {
    await artifacts.initialize(); await registry.provision([{ instanceId: sourceId, adapterKind: "hosted", displayName: descriptor.displayName, create: () => source }]);
    host = new SessionHost(sourceDatabase, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
    await host.initialize(); await host.registerTarget({ id: "source-target", backendId: sourceId, displayName: "Original files", workspaceRoot: workspace, trusted: true, managed: true });
    const connection = sourceDatabase.createConnection({ id: "owner", name: "Original owner", authKeyDigest: "owner-digest" });
    const sessionId = (await host.createSession({ operationId: "create-task", connection, targetId: "source-target", providerId: "provider", modelId: "native-model",
      title: "Native Source child", permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    const binding = sourceDatabase.getSession(sessionId).descriptor.binding;
    expect((await host.getCommands(sessionId)).find(command => command.name === "subagents")).toMatchObject({ source: "extension", loaded: true });
    expect(JSON.stringify(await host.getCommands(sessionId))).not.toContain(nativeRoot);
    const item = host.enqueueInput({ operationId: "source-parent", sessionId, connection, prompt: { text: "Launch one background scout.", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    host.requestQueueDrain(sessionId);
    await vi.waitFor(() => expect(sourceDatabase.getQueueItem(item.queueItemId).state).toBe("completed"), { timeout: 30_000 });
    await vi.waitFor(() => expect(sourceDatabase.listSubagentRuns({ sessionId }).runs.some(run => run.state === "completed")).toBe(true), { timeout: 30_000 });
    const child = sourceDatabase.listSubagentRuns({ sessionId }).runs.find(run => run.state === "completed")!;
    expect(child).toMatchObject({ sessionId, returnedResult: "SOURCE_CHILD_DONE" });
    expect(childReads).toBe(1);
    const liveBeforeControl = [...lifecycle];
    await host.mutate({ operationId: "resume-source-child", connection, kind: "controlSubagent", body: { sessionId, runId: child.id, action: "resume" },
      effect: () => host!.controlSubagent(sessionId, { runId: child.id, action: "resume", message: "Read proof.txt once more and report its bytes." }, "resume-source-child"),
      commit: () => ({ accepted: true }) });
    expect(lifecycle).toEqual(liveBeforeControl);
    await vi.waitFor(() => { expect(lifecycle).toEqual(liveBeforeControl); expect({ childRequests, parentRequests, childResults }).toMatchObject({ childRequests: 4, parentRequests: 2 }); }, { timeout: 15_000 });
    expect(childResults[1]).toContain("SOURCE_CHILD_FILE_BYTES"); expect(childReads).toBe(2);
    await vi.waitFor(() => expect(sourceDatabase.listSubagentRuns({ sessionId }).runs.find(run => run.id === child.id)?.state).toBe("completed"), { timeout: 30_000 });
    await vi.waitFor(async () => {
      expect(await host!.inspect(sessionId)).toMatchObject({ streaming: false, compacting: false, pendingMessages: 0 });
      // Native completion arrives before the Source queue and background
      // projections settle. Navigation must wait for both owners to be idle.
      expect(host!.inspectRuntimeActivity()).toEqual([]);
    }, { timeout: 10_000 });
    expect((await host.navigateTree(sessionId, { kind: "session_start" }, false, undefined, binding.generation,
      { connection, operationId: "rewind-source", protocol: { kind: "internal" } }).catch(error => {
        throw new Error(JSON.stringify({ error: String(error), storedError: error.storedError, nativeFailures }));
      })).value.accepted).toBe(true);
    expect(sourceDatabase.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(JSON.stringify(await host.getTree(sessionId))).not.toMatch(/"role":"(?:user|assistant)"/u);
    expect(nativeStore.list()[0]?.binding?.generation).toBe(2);
    expect(nativeDatabase.listSettingsByKeyPrefix("service", "native-hosted-navigation.v1", "")).toEqual([]);
    expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe("SOURCE_CHILD_FILE_BYTES");
    expect(parentRequests).toBe(2); expect(childRequests).toBe(4);
  } finally {
    await host?.dispose(); await source.dispose(); await poller.close(); await nativeHost.dispose(); nativeDatabase.close(); sourceDatabase.close();
    model.closeAllConnections(); await new Promise<void>(closed => model.close(() => closed()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

function respond(response: ServerResponse, name: string | undefined, value: Record<string, unknown> | string, id = "source-child-launch"): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ id: "controlled-source-native", object: "chat.completion.chunk", created: 1, model: "native-model", choices: [{ index: 0,
    delta: name ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(value) } }] } : { role: "assistant", content: value },
    finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}
