import { createServer, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createPiHostedExecutor, type PiHostedExecutorConfiguration } from "./hosted-executor.js";
import { MANAGED_HOSTED_EXECUTOR_RUNTIME_SOURCE } from "./hosted-executor-runtime.js";
import { createPiAdapter } from "./adapter.js";
import type { AdapterContext, EventPayload, TargetDescriptor } from "@joko/core";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-pi-tools-")), origin = join(root, "task-node"), agent = join(root, "agent-node");
  await mkdir(origin); await mkdir(agent);
  const bearer = "a".repeat(43), requests: { callId: string; requestId: string; operation: string }[] = [], executions: string[] = [];
  let reject = false;
  let modelResponse: ((body: Record<string, unknown>, response: ServerResponse) => void) | undefined;
  let wait: Promise<void> | undefined;
  const localPath = (value: unknown) => {
    if (typeof value !== "string") throw new Error("Invalid path.");
    const suffix = relative(agent, value);
    if (suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("Outside fixture root.");
    return resolve(origin, suffix);
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/v1/chat/completions") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (!modelResponse) throw new Error("Unexpected model request.");
        modelResponse(JSON.parse(Buffer.concat(chunks).toString()), response); return;
      }
      expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
      expect(request.url).toBe("/bound/execute");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { format: number; callId: string; requestId: string; operation: string; payload: Record<string, any> };
      expect(body.format).toBe(1); requests.push(body);
      if (wait) await wait;
      if (reject) { response.writeHead(403); response.end(JSON.stringify({ format: 1, ok: false, error: { code: "ACCESS_REVOKED", message: bearer } })); return; }
      const payload = body.payload; let value: Record<string, unknown> = {};
      switch (body.operation) {
        case "tool.begin": case "tool.end": break;
        case "fs.access": await access(localPath(payload.path)); break;
        case "fs.read": value = { data: (await readFile(localPath(payload.path))).toString("base64") }; break;
        case "fs.write": await writeFile(localPath(payload.path), Buffer.from(payload.data, "base64")); break;
        case "fs.mkdir": await mkdir(localPath(payload.path), { recursive: true }); break;
        case "fs.mime": value = { mime: null }; break;
        case "fs.stat": { const info = await stat(localPath(payload.path)); value = { type: info.isDirectory() ? "directory" : "file" }; break; }
        case "fs.readdir": value = { entries: await readdir(localPath(payload.path)) }; break;
        case "fs.glob": value = { paths: (await readdir(localPath(payload.cwd))).filter(name => name.endsWith(".txt")) }; break;
        case "pi.grep": value = { text: `same.txt:1:${await readFile(join(origin, "same.txt"), "utf8")}`, details: {} }; break;
        case "exec.run": {
          const result = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: localPath(payload.cwd) });
          executions.push(result.stdout); value = { output: Buffer.from(result.stdout.replace(origin, agent)).toString("base64"), exitCode: 0 }; break;
        }
        default: throw new Error("Unexpected executor operation.");
      }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ format: 1, ok: true, value }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ format: 1, ok: false, error: { code: "EXECUTOR_FAILED" } })); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const configuration: PiHostedExecutorConfiguration = { format: 1, endpoint: `http://127.0.0.1:${address.port}/bound`, bearer, root: agent, platform: process.platform as "win32" | "linux" | "darwin", shell: "fixture", trust: "owner" };
  return { root, origin, agent, configuration, requests, executions, modelEndpoint: `http://127.0.0.1:${address.port}/v1`,
    respond: (callback: NonNullable<typeof modelResponse>) => { modelResponse = callback; },
    reject: () => { reject = true; }, hold: (value: Promise<void>) => { wait = value; } };
}
const context = {} as ExtensionContext;

it("runs published SDK file, search and shell tools on the task node through the generated companion", async () => {
  const f = await fixture();
  await writeFile(join(f.origin, "same.txt"), "origin contents\n"); await writeFile(join(f.agent, "same.txt"), "agent private contents\n");
  const runtime = join(f.root, "hosted-runtime.mjs"); await writeFile(runtime, MANAGED_HOSTED_EXECUTOR_RUNTIME_SOURCE, { mode: 0o600 });
  const module = await import(pathToFileURL(runtime).href) as { createPiHostedExecutor: typeof createPiHostedExecutor };
  const executor = module.createPiHostedExecutor(sdk, f.configuration);
  const read = await executor.createTools("read-one").read.execute("read-one", { path: "same.txt" }, undefined, undefined, context);
  expect(read.content).toContainEqual({ type: "text", text: "origin contents\n" });
  await executor.createTools("write-one").write.execute("write-one", { path: "created.txt", content: "alpha\n" }, undefined, undefined, context);
  await executor.createTools("edit-one").edit.execute("edit-one", { path: "created.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined, context);
  expect(await readFile(join(f.origin, "created.txt"), "utf8")).toBe("beta\n");
  await expect(stat(join(f.agent, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await executor.createTools("list-one").ls.execute("list-one", {}, undefined, undefined, context)).content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("created.txt") }));
  expect((await executor.createTools("find-one").find.execute("find-one", { pattern: "*.txt" }, undefined, undefined, context)).content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("same.txt") }));
  expect((await executor.createTools("grep-one").grep.execute("grep-one", { pattern: "origin" }, undefined, undefined, context)).content[0]).toMatchObject({ text: expect.stringContaining("origin contents") });
  await executor.createTools("command-one").bash.execute("command-one", { command: "probe task cwd" }, undefined, undefined, context);
  expect(f.executions).toEqual([f.origin]);
  expect(new Set(f.requests.map(request => request.requestId)).size).toBe(f.requests.length);
  expect(await readFile(join(f.agent, "same.txt"), "utf8")).toContain("agent private");
});

it("cancels the original HTTP operation and never falls back to the Agent node's local file", async () => {
  const f = await fixture(), executor = createPiHostedExecutor(sdk, f.configuration);
  await writeFile(join(f.agent, "same.txt"), "must not escape the Agent home");
  f.reject();
  await expect(executor.createTools("revoked").read.execute("revoked", { path: "same.txt" }, undefined, undefined, context)).rejects.toThrow("task executor rejected");
  const abort = new AbortController(); abort.abort();
  const count = f.requests.length;
  await expect(executor.createTools("cancelled", abort.signal).read.execute("cancelled", { path: "same.txt" }, abort.signal, undefined, context)).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});

it("loads the hosted bridge in an actual native Agent and keeps guest execution, credentials and model selection isolated", { timeout: 45_000 }, async () => {
  const f = await fixture(), home = join(f.root, "managed-home"), guestHome = f.root;
  await writeFile(join(f.origin, "same.txt"), "task-origin read\n");
  await writeFile(join(f.agent, "same.txt"), "provider-owner private file\n");
  const requests: Record<string, unknown>[] = [], events: EventPayload[] = [];
  let settle!: () => void;
  const done = new Promise<void>(resolveDone => { settle = resolveDone; });
  f.respond((body, response) => {
    requests.push(body);
    const call = requests.length === 1 ? { name: "read", arguments: { path: "same.txt" } }
      : requests.length === 2 ? { name: "write", arguments: { path: "remote-created.txt", content: "written on task node\n" } } : undefined;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: "hosted-turn", object: "chat.completion.chunk", created: 1,
      model: "remote-model", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    send(call ? { role: "assistant", tool_calls: [{ index: 0, id: `hosted-call-${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: "Remote execution completed." }, null);
    send({}, call ? "tool_calls" : "stop"); response.end("data: [DONE]\n\n");
  });
  let current = true;
  const target: TargetDescriptor = { id: "hosted-private-target", backendId: "pi", displayName: "Hosted Agent",
    workspaceRoot: f.agent, managed: true, trusted: true };
  const context: AdapterContext = { sessionId: "hosted-private-session", generation: 1, target, signal: new AbortController().signal,
    hostedExecution: { trust: "guest", guestHome, providerId: "shared", modelIds: ["remote-model"],
      source: { sessionId: "original-session", targetId: "original-target", generation: 3 },
      workspace: { root: f.agent, additionalRoots: [], platform: f.configuration.platform, shell: "origin shell", isGitRepository: false,
        personalInstructions: "Use the task owner's origin instructions." },
      channel: { endpoint: f.configuration.endpoint, bearer: f.configuration.bearer },
      assertCurrent: () => { if (!current) throw new Error("Sharing revoked."); } },
    emit: async event => { events.push(event); if (event.type === "done") settle(); },
    requestInteraction: async () => { throw new Error("Host-local permission must not authorize a task-origin operation."); },
    artifactCapacityBytes: 256 * 1024 * 1024, storeArtifact: async () => { throw new Error("No test Artifact expected."); } };
  const noHostContext = () => { throw new Error("Foreign target must not read this computer's project state."); };
  const adapter = createPiAdapter({ agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false,
    appendSystemPrompt: "PROVIDER_OWNER_PRIVATE_INSTRUCTIONS",
    resolveTargetResources: noHostContext, resolveNativeSkills: noHostContext, resolveProjectExtensionExclusions: noHostContext,
    resolveMakerMemoryPrompt: noHostContext, resolveMcpBridge: noHostContext,
    providers: ["shared", "unshared"].map(id => ({ id, baseUrl: f.modelEndpoint, api: "openai-completions" as const,
      apiKeyEnv: id === "shared" ? "SHARED_PROVIDER_KEY" : "OTHER_PROVIDER_KEY",
      models: [{ id: "remote-model", contextWindow: 32_768, maxTokens: 1_024 }, { id: "unshared-model", contextWindow: 32_768, maxTokens: 1_024 }] })),
    environment: { SHARED_PROVIDER_KEY: "shared-private-credential", OTHER_PROVIDER_KEY: "unshared-private-credential" },
    settings: { compaction: { enabled: false }, retry: { enabled: false } } });
  try {
    const binding = await adapter.createSession({ target, providerId: "shared", modelId: "remote-model", permissionMode: "ask", fastMode: false }, context);
    const attached = { ...context, binding };
    await adapter.send({ text: "Read and update the original task workspace.", images: [], files: [], mentions: [], disposition: "prompt" }, attached);
    await Promise.race([done, new Promise<never>((_, rejectDone) => { const timer = setTimeout(() => rejectDone(new Error("Hosted native Agent did not settle.")), 20_000); timer.unref(); })]);
    expect(events.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1])).toContain("task-origin read");
    expect(JSON.stringify(requests)).not.toContain("provider-owner private");
    expect(JSON.stringify(requests)).not.toContain("PROVIDER_OWNER_PRIVATE_INSTRUCTIONS");
    expect(JSON.stringify(requests)).toContain("task owner's origin instructions");
    expect(await readFile(join(f.origin, "remote-created.txt"), "utf8")).toBe("written on task node\n");
    await expect(stat(join(f.agent, "remote-created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.setModel("unshared", "remote-model", attached)).rejects.toThrow("does not allow");
    await expect(adapter.setModel("shared", "unshared-model", attached)).rejects.toThrow("does not allow");
    const shell = await adapter.executeUserShell({ command: "task-origin-shell", excludeFromContext: true }, attached);
    expect(shell.output).toContain(f.agent);
    expect(f.executions).toEqual([f.origin]);
    expect(JSON.stringify(events)).not.toContain(f.configuration.bearer);
    expect(JSON.stringify(events)).not.toContain("private-credential");
    current = false;
    await expect(adapter.setName("revoked", attached)).rejects.toThrow("Sharing revoked");
  } finally { await adapter.dispose(); }
});
