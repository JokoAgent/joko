import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createPiAdapter } from "@joko/adapter-pi";
import type { AdapterContext, EventPayload, InteractionPayload, NativeSessionState, UserShellResult } from "@joko/core";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { expect, it } from "vitest";
import sharp from "sharp";
import Fastify from "fastify";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HostedAgentService } from "@joko/contracts";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import { HostedAgentController } from "./hosted-agent-controller.js";
import type { HostedAgentFrame } from "./hosted-agent-exchange.js";
import { HostedAgentRun } from "./hosted-agent-run.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentHost } from "./hosted-agent-host.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HOSTED_AGENT_WIRE_ENVELOPE_BYTES } from "./hosted-agent-wire.js";

it("routes all seven published native Pi tools and user shell through the task's executor with one approval per native write", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-tools-native-")), task = join(root, "original-task"), modelHome = join(root, "model-node");
  await mkdir(task); await mkdir(modelHome);
  await writeFile(join(modelHome, "AGENTS.md"), "PROVIDER_HOME_PRIVATE_INSTRUCTIONS\n");
  await writeFile(join(task, "owned.txt"), "task-origin bytes\n");
  await writeFile(join(task, "pixel.png"), await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer());
  await writeFile(join(task, "cwd-proof.mjs"), "process.stdout.write(process.cwd());\n");
  const questions: InteractionPayload[] = [], events: EventPayload[] = [], modelRequests: Record<string, unknown>[] = [];
  let done!: () => void; const settled = new Promise<void>(resolveDone => { done = resolveDone; });
  const artifactBytes: Buffer[] = [];
  const base: AdapterContext = { sessionId: "original-product-session", generation: 4,
    target: { id: "original-product-target", backendId: "pi", displayName: "Task", workspaceRoot: task, managed: true, trusted: true },
    signal: new AbortController().signal, emit: async event => { events.push(event); if (event.type === "done") done(); },
    requestInteraction: async question => { questions.push(question); return { kind: "selected", value: "allow_once" }; },
    artifactCapacityBytes: 64 * 1024 * 1024, storeArtifact: async (path, options) => {
      const bytes = await readFile(path); artifactBytes.push(bytes);
      return { id: `original-task-artifact-${artifactBytes.length}`, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, mimeType: options?.mimeType ?? "application/octet-stream" };
    } };
  const commandGate = createCommandConcurrencyGate({ readMaximum: () => 1 });
  const tools = [
    { name: "read", arguments: { path: "owned.txt" } },
    { name: "write", arguments: { path: "nested/out.txt", content: "alpha\n" } },
    { name: "edit", arguments: { path: "nested/out.txt", edits: [{ oldText: "alpha", newText: "beta" }] } },
    { name: "ls", arguments: { path: "nested" } },
    { name: "find", arguments: { pattern: "*.txt", path: "nested" } },
    { name: "grep", arguments: { pattern: "beta", path: "nested" } },
    { name: "bash", arguments: { command: `"${process.execPath.replace(/\\/gu, "/")}" cwd-proof.mjs`, timeout: 10 } },
    { name: "read", arguments: { path: "pixel.png" } }
  ];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    modelRequests.push(body); complete(response, tools[modelRequests.length - 1]);
  });
  await new Promise<void>(ready => model.listen(0, "127.0.0.1", ready));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("Missing test model listener.");
  const slots = new HostedAgentSessionSlots();
  const nativeDatabase = new OperationalStore(join(root, "native-host.sqlite"));
  const runOptions = { runId: "native-role-run", nativeSessionId: "retained-native-task", start: "create" as const, root: modelHome, store: new HostedAgentStore(nativeDatabase),
    source: { authorityId: "authenticated-task-peer", deviceId: "task-device", sessionId: base.sessionId, targetId: base.target.id, generation: base.generation },
    trust: "guest", backendId: "pi", providerId: "shared", modelId: "hosted-model", modelIds: ["hosted-model"],
    permissionMode: "ask", fastMode: false, slots, artifactCapacityBytes: base.artifactCapacityBytes,
    workspace: { platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false,
      contextFiles: [{ path: "AGENTS.md", content: "ORIGINAL_TASK_APPROVED_INSTRUCTIONS" }] },
    assertCurrent: () => {}, assertModelAllowed: (provider, model) => { if (provider !== "shared" || model !== "hosted-model") throw new Error("Unapproved shared model"); },
    createAdapter: ({ home }) => createPiAdapter({ agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false, commandConcurrencyGate: commandGate,
    providers: [{ id: "shared", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "PRIVATE_HOSTED_MODEL_KEY",
      models: [{ id: "hosted-model", contextWindow: 32_768, maxTokens: 1024, input: ["text", "image"] }] }], environment: { PRIVATE_HOSTED_MODEL_KEY: "provider-node-private-credential" },
    settings: { compaction: { enabled: false }, retry: { enabled: false } } }) } satisfies Parameters<typeof HostedAgentRun.create>[0];
  const principal = { id: "authenticated-task-peer", deviceId: "task-device", trust: "guest" as const, assertCurrent: () => {} };
  const host = new HostedAgentHost({ authorize: () => runOptions });
  const opening = { runId: "native-role-run", nativeSessionId: "retained-native-task", start: "create" as const, sessionId: base.sessionId, targetId: base.target.id, generation: base.generation,
    backendId: "pi", providerId: "shared", modelId: "hosted-model", permissionMode: "ask" as const, fastMode: false, workspace: runOptions.workspace };
  const firstOpen = host.open(principal, opening); expect(host.open(principal, opening)).toBe(firstOpen);
  const run = await firstOpen;
  const server = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  await server.register(fastifyConnectPlugin, { routes: router => router.service(HostedAgentService, createHostedAgentConnectService({ host,
    authenticate: context => { if (context.requestHeader.get("authorization") !== "Bearer private-test-grant") throw new ConnectError("Authentication is required.", Code.Unauthenticated); return principal; } }),
    { readMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES, writeMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES }) });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const serverAddress = server.server.address(); if (!serverAddress || typeof serverAddress === "string") throw new Error("Missing hosted service listener.");
  const client = new HostedAgentConnectClient(createClient(HostedAgentService, createConnectTransport({ httpVersion: "1.1", baseUrl: `http://127.0.0.1:${serverAddress.port}`,
    useBinaryFormat: true, readMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES, writeMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES,
    interceptors: [next => request => { request.header.set("authorization", "Bearer private-test-grant"); return next(request); }] })), principal.assertCurrent);
  expect(await client.open(opening, base.signal)).toEqual({ runId: opening.runId, virtualRoot: run.workspaceRoot });
  const poller = new HostedAgentPoller(client);
  const port = poller.attach("native-role-run");
  let resumedController: HostedAgentController | undefined;
  let resumedPort: ReturnType<HostedAgentPoller["attach"]> | undefined;
  const shadow = run.workspaceRoot; await writeFile(join(shadow, "owned.txt"), "provider owner private bytes\n");
  const source = new HostedAgentExecutor({ context: base, virtualRoot: shadow, commandConcurrencyGate: commandGate,
    readPolicy: () => ({ revision: "original-policy", permissionMode: "ask", planMode: false, approvedRoots: [], confirmCredentials: true }), assertCurrent: () => {} });
  let fences = 0;
  const observedFrames: HostedAgentFrame[] = [];
  const sourceBinding = { opaqueRef: "source-owned:retained-native-task", nativeSessionId: "retained-native-task", generation: base.generation };
  const controller = new HostedAgentController({ context: base, executor: source, temporaryRoot: join(root, "task-artifacts"), assertCurrent: () => {},
    port: { ...port, poll: async (after, signal) => { const batch = await port.poll(after, signal); observedFrames.push(...batch.frames); return batch; } }, binding: () => sourceBinding,
    persistFence: async (operationId, preparation) => {
      expect(operationId).toBe("native-prompt"); expect(preparation.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      for (const entry of preparation.nativeHistory.events) if (entry.payload.type === "native_session_changed") expect(entry.payload.opaqueRef).toBe(sourceBinding.opaqueRef);
      fences++;
    } });
  const pump = controller.start(); void pump.catch(() => {});
  try {
    expect(slots.usage("task-device").device).toBe(1);
    const command = { kind: "send" as const, input: { text: "Use the task's workspace tools.", images: [], files: [], mentions: [], disposition: "prompt" as const }, durableFence: true };
    const sent = client.call("native-role-run", "native-prompt", command, base.signal); await client.call("native-role-run", "native-prompt", command, base.signal); await sent;
    await Promise.race([settled, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Hosted native tool run did not settle")), 40_000); timer.unref(); })]);
    expect(events.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
    expect(events.filter(event => event.type === "error")).toEqual([]);
    for (const event of events) if (event.type === "native_session_changed") expect(event).toMatchObject({ opaqueRef: sourceBinding.opaqueRef, nativeSessionId: sourceBinding.nativeSessionId });
    const sourceState = controller.projectState(await client.call(opening.runId, "source-state", { kind: "state" }, base.signal) as NativeSessionState);
    expect(sourceState.binding).toEqual(sourceBinding); expect(sourceState.pi?.nativeSessionFileDisplay).toBe("");
    expect(fences).toBe(1); expect(modelRequests).toHaveLength(9);
    expect(await readFile(join(task, "nested", "out.txt"), "utf8")).toBe("beta\n");
    await expect(stat(join(shadow, "nested", "out.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(questions.filter(question => question.kind === "permission").map(question => question.toolName)).toEqual(["write", "edit", "bash"]);
    const final = JSON.stringify(modelRequests.at(-1));
    for (const expected of ["task-origin bytes", "out.txt", "beta", shadow.replace(/\\/gu, "\\\\")]) expect(final).toContain(expected);
    expect(final).not.toContain("provider owner private");
    expect(final).not.toContain("PROVIDER_HOME_PRIVATE_INSTRUCTIONS"); expect(final).toContain("ORIGINAL_TASK_APPROVED_INSTRUCTIONS");
    const shell = controller.projectResult(await client.call("native-role-run", "user-shell", { kind: "shell", input: { command: `"${process.execPath.replace(/\\/gu, "/")}" cwd-proof.mjs`, excludeFromContext: true } }, base.signal)) as UserShellResult;
    expect(shell.exitCode).toBe(0); expect(shell.output).toBe(task);
    expect(questions).toHaveLength(4); expect(commandGate.snapshot()).toEqual({ running: 0, queued: 0 });
    expect(observedFrames.filter(frame => frame.payload.kind === "event" && frame.payload.event.type === "done").map(frame => frame.payload.kind === "event" && frame.payload.operationId))
      .toEqual(["native-prompt"]);
    const toolOwners = observedFrames.filter(frame => frame.payload.kind === "request" && frame.payload.request.kind === "tool")
      .map(frame => frame.payload.kind === "request" && frame.payload.operationId);
    expect(new Set(toolOwners)).toEqual(new Set(["native-prompt", "user-shell"]));
    expect(observedFrames.filter(frame => frame.payload.kind === "request" && frame.payload.request.kind === "artifact")
      .every(frame => frame.payload.kind === "request" && frame.payload.operationId === "native-prompt")).toBe(true);
    expect(artifactBytes).toHaveLength(1); expect(artifactBytes[0]).toEqual(await readFile(join(task, "pixel.png")));
    expect(JSON.stringify(events)).toContain("original-task-artifact-1"); expect(JSON.stringify(events)).not.toContain("provider-node-private-credential");
    const record = runOptions.store.find(run.id)!;
    const uncertain = { kind: "set_name" as const, name: "must not be repeated" };
    runOptions.store.claimCall(run.id, record.leaseId, "uncertain-control", createHash("sha256").update(JSON.stringify(uncertain)).digest("hex"));
    await expect(client.call("native-role-run", "uncertain-control", uncertain, base.signal)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await client.close("native-role-run", base.signal); await controller.stop(); port.detach();
    const resumed = { ...opening, runId: "resumed-native-role-run", start: "resume" as const };
    const resumedOpen = await client.open(resumed, base.signal); expect(resumedOpen.virtualRoot).toBe(shadow);
    resumedPort = poller.attach(resumed.runId);
    resumedController = new HostedAgentController({ context: base, executor: source, binding: () => sourceBinding, temporaryRoot: join(root, "task-artifacts"), assertCurrent: () => {}, port: resumedPort });
    void resumedController.start().catch(() => {});
    await client.call(resumed.runId, "native-prompt", command, base.signal);
    await expect(client.call(resumed.runId, "uncertain-control", uncertain, base.signal)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const restored = await client.call(resumed.runId, "inspect-restored-native", { kind: "state" }, base.signal) as { binding: { nativeSessionId?: string }; streaming: boolean };
    expect(restored.binding.nativeSessionId).toBe(record.binding?.nativeSessionId); expect(restored.streaming).toBe(false);
    expect(modelRequests).toHaveLength(9); expect(slots.usage("task-device").device).toBe(1);
  } finally {
    await client.close("native-role-run", base.signal); await controller.stop(); port.detach();
    if (resumedPort) { await client.close("resumed-native-role-run", base.signal); await resumedController?.stop(); resumedPort.detach(); }
    await poller.close(); await host.dispose(); await server.close(); nativeDatabase.close(); source.dispose(); commandGate.close();
    expect(slots.usage("task-device").device).toBe(0);
    model.closeAllConnections(); await new Promise<void>(closed => model.close(() => closed()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});

function complete(response: ServerResponse, tool: { name: string; arguments: Record<string, unknown> } | undefined): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: "hosted-tool-answer", object: "chat.completion.chunk", created: 1,
    model: "hosted-model", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  // Reusing the upstream call ID deliberately exercises distinct native occurrences.
  send(tool ? { role: "assistant", tool_calls: [{ index: 0, id: "repeated-provider-call", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
    : { role: "assistant", content: "Task operations completed." }, null);
  send({}, tool ? "tool_calls" : "stop"); response.end("data: [DONE]\n\n");
}
