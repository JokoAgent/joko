import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { HostedAgentService } from "@joko/contracts";
import { createPiAdapter } from "@joko/adapter-pi";
import { DEVICE_PEER_RUNTIME_EXECUTABLES } from "@joko/device-peer";
import { HostedAgentSourceAdapter } from "@joko/adapter-hosted";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterContext, PromptInput } from "@joko/core";
import type { RemoteFileStat, RemoteFileTransportPort, RemoteProcessHandle } from "@joko/remote-ssh";
import type { RemoteWorkspaceAuthority } from "./remote-execution-router.js";
import { HostedAgentPeerWorkspace, captureHostedAgentPeerWorkspace } from "./hosted-agent-peer-workspace.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import { HostedAgentCodexExecServerRelay } from "./hosted-agent-codex-relay.js";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { HostedAgentSourceResources } from "./hosted-agent-source-resources.js";
import { prepareSourceWorkspaceInput } from "./hosted-agent-source-input.js";
import { snapshotPeerSourceProject } from "./hosted-agent-peer-project-files.js";
import { HostedAgentHost } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { createHostedAgentSourceController } from "./hosted-agent-source-controller.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  let live = true, clock = 0;
  const data = new Map<string, { content?: Buffer; info: RemoteFileStat }>(), aliases = new Map<string, string>();
  const put = (path: string, content?: string | Buffer) => { data.set(path, { ...(content === undefined ? {} : { content: Buffer.from(content) }), info: { kind: content === undefined ? "directory" : "file", size: content === undefined ? 0 : Buffer.byteLength(content), mode: 0o600, modifiedAt: ++clock, version: String(clock) } }); };
  ["/", "/peer", "/peer/project", "/peer/tmp", "/peer/home"].forEach(path => put(path)); put("/peer/project/proof.txt", "PEER_ONLY");
  const missing = () => Object.assign(new Error("Missing peer file"), { code: "ENOENT" });
  const assert = () => { if (!live) throw new Error("Peer route revoked"); };
  const files: RemoteFileTransportPort = {
    realpath: vi.fn(async path => { assert(); const actual = aliases.get(path) ?? path; if (!data.has(actual)) throw missing(); return actual; }),
    stat: vi.fn(async path => { assert(); const value = data.get(aliases.get(path) ?? path); if (!value) throw missing(); return { ...value.info }; }),
    list: vi.fn(async path => { assert(); if (!data.has(path)) throw missing(); const prefix = path.replace(/\/$/u, "") + "/"; return [...data].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")).map(([key, value]) => ({ name: key.slice(prefix.length), kind: value.info.kind })); }),
    read: vi.fn(async request => { assert(); const value = data.get(request.path); if (!value?.content) throw missing(); if (request.expectedVersion && request.expectedVersion !== value.info.version) throw new Error("Version changed"); if (value.content.length > request.maximumBytes && !request.allowTruncated) throw new Error("Too large"); return value.content.subarray(0, request.maximumBytes); }),
    write: vi.fn(async request => { assert(); if (request.createOnly && data.has(request.path)) throw new Error("Already exists"); put(request.path, Buffer.from(request.content)); }),
    mkdir: vi.fn(async path => { assert(); if (!data.has(path)) put(path); }),
    rename: vi.fn(async () => { throw new Error("No peer rename expected"); }),
    remove: vi.fn(async (path, options) => { assert(); for (const key of data.keys()) if (key === path || options?.recursive && key.startsWith(path + "/")) data.delete(key); })
  };
  const handles: RemoteProcessHandle[] = [];
  const process = vi.fn(async (request: { executable: string; args: readonly string[]; cwd: string; signal?: AbortSignal }) => {
    assert(); const emitter = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
    const child = Object.assign(emitter, { stdin, stdout, stderr, pid: 100, exitCode: null as number | null, signalCode: null,
      kill: () => { Object.assign(child, { exitCode: 0 }); stdout.end(); stderr.end(); emitter.emit("exit", 0, null); return true; } }) as unknown as RemoteProcessHandle;
    handles.push(child);
    if (request.executable !== DEVICE_PEER_RUNTIME_EXECUTABLES.codex) setTimeout(() => {
      const output = request.executable === DEVICE_PEER_RUNTIME_EXECUTABLES.node ? JSON.stringify({ home: "/peer/home", temporary: "/peer/tmp", platform: "linux" }) : request.executable === "git" ? "true\n" : request.executable === "rg" ? "proof.txt\n" : "PEER_COMMAND\n";
      const marker = request.executable === "bash" ? /\u001eJOKO_CWD_[a-f0-9-]+:/u.exec(request.args.at(-1) ?? "")?.[0] : undefined;
      if (marker) { stdout.write(output + marker.slice(0, 12)); stdout.end(marker.slice(12) + "/peer/project\n"); } else stdout.end(output);
      stderr.end(); Object.assign(child, { exitCode: 0 }); emitter.emit("exit", 0, null);
    }, 1);
    return child;
  });
  const context: AdapterContext = { sessionId: "session", generation: 2, backendInstanceGeneration: 3,
    target: { id: "target", backendId: "source", displayName: "Peer project", workspaceRoot: "/peer/project", trusted: true, managed: false,
      remoteWorkspace: { kind: "device_peer", controllerDeviceId: "controller", targetDeviceId: "task-device", workspaceRoot: "/peer/project" } },
    signal: new AbortController().signal, emit: async () => {}, requestInteraction: vi.fn(async () => ({ kind: "confirmed" as const, confirmed: true })), storeArtifact: async () => { throw new Error("No Artifact expected"); }, artifactCapacityBytes: 1024 };
  const authority: RemoteWorkspaceAuthority = { kind: "device_peer", binding: context.target.remoteWorkspace!, pathStyle: "posix", executionIdentity: "peer-task", authorityIdentity: "peer-route-7", files, processes: { open: process },
    assertCurrent: assert, assertFilesCurrent: assert, assertForwardingCurrent: assert };
  const peer = new HostedAgentPeerWorkspace(context, authority, assert);
  let executor: HostedAgentExecutor | undefined;
  const getExecutor = () => executor ??= new HostedAgentExecutor({ context, remote: peer, virtualRoot: "/model-host/shadow", readPolicy: () => ({ revision: "policy", permissionMode: "acceptEdits", planMode: false, approvedRoots: [], confirmCredentials: false }), assertCurrent: assert });
  cleanups.push(() => { executor?.dispose(); for (const child of handles) child.kill(); });
  const counters = new Map<string, number>();
  const call = (id: string, operation: string, payload: object, effects?: Parameters<HostedAgentExecutor["execute"]>[2]) => {
    const sequence = (counters.get(id) ?? 0) + 1; counters.set(id, sequence);
    return getExecutor().execute({ format: 1, callId: id, requestId: `${id}:${sequence}`, operation, payload }, undefined, effects);
  };
  const begin = (id: string, name: string, input: object) => call(id, "tool.begin", { name, input });
  return { peer, context, authority, get executor() { return getExecutor(); }, files, process, data, aliases, put, call, begin, revoke: () => { live = false; } };
}
it("reads and writes on the exact task Device while projecting only the Model Host shadow paths", async () => {
  const f = fixture(); await f.peer.initialize();
  await f.begin("read", "read", { path: "/model-host/shadow/proof.txt" });
  const read = await f.call("read", "fs.read", { path: "/model-host/shadow/proof.txt" });
  expect(Buffer.from(String(read.data), "base64").toString()).toBe("PEER_ONLY");
  await f.begin("write", "write", { path: "/model-host/shadow/proof.txt" });
  await f.call("write", "fs.write", { path: "/model-host/shadow/proof.txt", data: Buffer.from("PEER_UPDATED").toString("base64") });
  expect(f.data.get("/peer/project/proof.txt")?.content?.toString()).toBe("PEER_UPDATED");
  expect(f.files.write).toHaveBeenCalledWith(expect.objectContaining({ path: "/peer/project/proof.txt", atomic: true }));
  expect(f.executor.workspace.resolve("/model-host/shadow/proof.txt")).toBe("/peer/project/proof.txt");
});
it("runs shell commands and Codex exec-server through the task Device process authority", async () => {
  const f = fixture(); await f.peer.initialize();
  await f.begin("bash", "bash", { cwd: "/model-host/shadow", command: "git status", timeout: 10 });
  const output = await f.call("bash", "exec.run", { cwd: "/model-host/shadow", command: "git status", timeout: 10 });
  expect(Buffer.from(String(output.output), "base64").toString()).toBe("PEER_COMMAND\n");
  expect(f.process).toHaveBeenCalledWith(expect.objectContaining({ executable: "bash", cwd: "/peer/project", args: ["-lc", "git status"] }));
  const relay = new HostedAgentCodexExecServerRelay({ codexExecutable: "unavailable-on-service-node", cwd: "/peer/project", sessionId: "session", workspace: f.executor.workspace,
    assertCurrent: () => f.peer.assertCurrent(), authorize: (actions, signal) => f.executor.authorizeNativeActions(actions, signal), openProcess: signal => f.peer.openCodex(signal) });
  const signal = new AbortController().signal;
  await relay.execute({ format: 1, callId: "native", requestId: randomUUID(), operation: "codex.exec_server", payload: { kind: "open", connectionId: "native" } }, signal);
  expect(f.process).toHaveBeenCalledWith(expect.objectContaining({ executable: DEVICE_PEER_RUNTIME_EXECUTABLES.codex, args: ["exec-server", "--listen", "stdio://"], cwd: "/peer/project" }));
  expect(f.process.mock.calls.at(-1)?.[0]).not.toHaveProperty("env"); await relay.close();
});
it("drains a short peer process that completed before its consumer attached", async () => {
  const f = fixture(), stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  stdout.end(JSON.stringify({ home: "/peer/home", temporary: "/peer/tmp", platform: "linux" })); stderr.end();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: 0, signalCode: null, kill: () => false }) as unknown as RemoteProcessHandle;
  f.process.mockResolvedValueOnce(child); await f.peer.initialize(); expect(f.peer.home).toBe("/peer/home");
});
it("keeps split native cwd markers out of streamed output and projects the returned cwd", async () => {
  const f = fixture(); await f.peer.initialize(); await f.begin("cwd", "bash", { command: "git status", cwd: "/model-host/shadow", timeout: 10 });
  const chunks: Buffer[] = [], result = await f.call("cwd", "exec.run", { command: "git status", cwd: "/model-host/shadow", timeout: 10 }, { captureCwd: true, onOutput: chunk => chunks.push(chunk) });
  expect(Buffer.concat(chunks).toString()).toBe("PEER_COMMAND\n"); expect(result.cwd).toBe("/model-host/shadow");
  expect(JSON.stringify(result)).not.toContain("/peer/project");
});
it("rejects changed file authority, an escaped symlink, and revoked peer execution without a fallback", async () => {
  const f = fixture(); await f.peer.initialize(); await f.begin("read", "read", { path: "/model-host/shadow/proof.txt" });
  f.put("/outside/secret", "OUTSIDE"); f.aliases.set("/peer/project/proof.txt", "/outside/secret");
  await expect(f.call("read", "fs.read", { path: "/model-host/shadow/proof.txt" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.files.read).not.toHaveBeenCalledWith(expect.objectContaining({ path: "/outside/secret" }));
  const before = f.process.mock.calls.length; f.revoke();
  await expect(f.call("new", "tool.begin", { name: "bash", input: { command: "git status", cwd: "/model-host/shadow" } })).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
  expect(f.process).toHaveBeenCalledTimes(before);
});
it("captures peer mentions and revalidates their original version at the durable input fence", async () => {
  const f = fixture(); await f.peer.initialize();
  const resources = new HostedAgentSourceResources(), input: PromptInput = { text: "Read it", images: [], files: [], mentions: [{ kind: "workspace_file", label: "proof", reference: "proof.txt", workspaceId: "workspace" }], disposition: "prompt" };
  const prepared = await prepareSourceWorkspaceInput(input, f.context, { shadow: "/model-host/shadow", workspaceId: "workspace", resources, assertCurrent: () => f.peer.assertCurrent(),
    capturePath: (reference, directory, stage) => f.peer.captureInput(reference, directory, "/model-host/shadow", "/unused-staging", stage) });
  expect(prepared.input.text).toContain("Path: /model-host/shadow/proof.txt"); expect(prepared.input.text).not.toContain("/peer/project");
  f.put("/peer/project/proof.txt", "CHANGED");
  await expect(prepared.commit!({} as never)).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
});
it("collects the task Device instructions and approved resources without collecting local or credential files", async () => {
  const f = fixture(); await f.peer.initialize();
  f.put("/peer/project/AGENTS.md", "PEER_GUIDANCE @guide.md @.env"); f.put("/peer/project/guide.md", "PEER_IMPORTED_GUIDE"); f.put("/peer/project/.env", "TOKEN=private");
  f.put("/peer/home/.codex"); f.put("/peer/home/.codex/AGENTS.md", "PEER_HOME_GUIDANCE");
  const files = await snapshotPeerSourceProject(f.context, f.peer, "codex");
  expect(files.map(value => value.content).join("\n")).toContain("PEER_GUIDANCE"); expect(files.map(value => value.content).join("\n")).toContain("PEER_IMPORTED_GUIDE");
  expect(files.map(value => value.content).join("\n")).toContain("PEER_HOME_GUIDANCE"); expect(files.map(value => value.content).join("\n")).not.toContain("TOKEN=private");
  expect(files.find(value => value.path === "AGENTS.md")?.content).toContain("`@.env`");
});
it("materializes only explicit read-only input/resource mounts on the peer and checks ownership before cleanup", async () => {
  const f = fixture(); await f.peer.initialize();
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-peer-resource-"))), file = join(root, "readme.md"); await writeFile(file, "APPROVED_RESOURCE");
  cleanups.push(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
  const virtual = f.peer.mountPath(file, () => f.peer.assertCurrent()); await f.peer.synchronize(f.context.signal);
  expect(f.data.get(virtual)?.content?.toString()).toBe("APPROVED_RESOURCE");
  await expect(f.peer.write(virtual, Buffer.from("changed"), f.context.signal)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  f.put(virtual, "TAMPERED"); await expect(f.peer.synchronize(f.context.signal)).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
  await f.peer.dispose(); expect(f.data.has(virtual)).toBe(false); expect(f.files.remove).toHaveBeenCalledWith(expect.stringContaining("/peer/tmp/joko-source-"), expect.objectContaining({ recursive: true }));
});
it("captures the required peer file/process authority and rejects SSH rather than executing on the service node", async () => {
  const f = fixture(), workspace = vi.fn(async () => f.authority);
  const peer = await captureHostedAgentPeerWorkspace(f.context, { workspace }, () => undefined); expect(peer.home).toBe("/peer/home");
  expect(workspace).toHaveBeenCalledWith(f.context.target.remoteWorkspace, f.context.signal);
  await expect(captureHostedAgentPeerWorkspace({ ...f.context, target: { ...f.context.target, remoteWorkspace: { kind: "ssh", hostTargetId: "host-target", hostId: "host", workspaceRoot: "/peer/project" } } }, { workspace }, () => undefined)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
it("keeps foreign path projection lexical and preserves the peer path style", () => {
  const workspace = new ExecutorWorkspace({ workingDir: "/peer/project", remote: { pathStyle: "posix", home: "/peer/home", temporary: "/peer/tmp" }, aliases: [{ from: "C:\\model\\shadow", to: "/peer/project" }] });
  workspace.setVirtualRoot("C:\\model\\shadow"); expect(workspace.resolve("C:\\model\\shadow\\src\\file.ts")).toBe("/peer/project/src/file.ts");
  expect(workspace.contains("/peer/project-x/file")).toBe(false); expect(workspace.resolve("~/docs")).toBe("/peer/home/docs");
  expect(posix.isAbsolute(workspace.resolve("src/file.ts"))).toBe(true);
});

it("runs the installed native SDK through a Source controller with the actual peer workspace tools and instructions", { timeout: 90_000 }, async () => {
  const f = fixture(); await f.peer.initialize(); f.put("/peer/project/AGENTS.md", "PEER_SDK_GUIDANCE: read the task Device's files.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-peer-source-sdk-"))), database = new OperationalStore(join(root, "model.sqlite"));
  let requests = 0; const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8")); requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = requests === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "peer-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "proof.txt" }) } }] }
      : { role: "assistant", content: "Peer completed." };
    response.end(`data: ${JSON.stringify({ id: "native-peer", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No model listener");
  const principal = { id: "original-node", deviceId: "controller", trust: "owner" as const, assertCurrent: () => f.peer.assertCurrent() };
  const native = new HostedAgentHost({ authorize: () => ({ root: join(root, "model-host"), store: new HostedAgentStore(database), slots: new HostedAgentSessionSlots(), artifactCapacityBytes: 1024 * 1024,
    modelIds: ["model"], assertCurrent: principal.assertCurrent, assertModelAllowed: (provider, model) => { if (provider !== "provider" || model !== "model") throw new Error("Wrong source model"); },
    createAdapter: async ({ home }) => createPiAdapter({ agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false,
      settings: { compaction: { enabled: false }, retry: { enabled: false } }, environment: { PEER_MODEL_KEY: "model-only-key" },
      providers: [{ id: "provider", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "PEER_MODEL_KEY", models: [{ id: "model", contextWindow: 32768, maxTokens: 1024, input: ["text"] }] }] }) }) });
  let nativeFailure: unknown; const originalOpen = native.open.bind(native);
  vi.spyOn(native, "open").mockImplementation(async (...args) => { try { return await originalOpen(...args); } catch (error) { nativeFailure = error; throw error; } });
  const client = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => router.service(HostedAgentService, createHostedAgentConnectService({ host: native, authenticate: () => principal })))), principal.assertCurrent);
  const poller = new HostedAgentPoller(client), events: unknown[] = [];
  const context: AdapterContext = { ...f.context, operationId: "peer-sdk-input", emit: async event => { events.push(event); } };
  const adapter = new HostedAgentSourceAdapter({ id: "source", source: { controllerDeviceId: "controller", targetDeviceId: "model-device", backendId: "pi" },
    describe: () => ({ id: "source", adapterKind: "hosted", instanceGeneration: 3, displayName: "Peer source", version: "1", health: "healthy", installationState: "installed", authenticationState: "not_required",
      capabilities: new Map(), models: [], tools: [], diagnostics: [] }),
    assertContext: () => f.peer.assertCurrent(), validateRemoteTarget: async () => f.peer.assertCurrent(),
    workspace: async () => ({ platform: "linux", shell: "bash", isGitRepository: false, contextFiles: await snapshotPeerSourceProject(context, f.peer, "pi") }),
    readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }), capture: async runId => ({ client, assertCurrent: principal.assertCurrent,
      close: () => client.close(runId, new AbortController().signal),
      createController: input => createHostedAgentSourceController({ ...input, poller, remote: f.peer, temporaryRoot: join(root, "incoming"),
        readPolicy: () => ({ revision: "sdk-policy", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: false }),
        assertContext: () => f.peer.assertCurrent(), assertCurrent: principal.assertCurrent }) }) });
  try {
    const binding = await adapter.createSession({ target: context.target, permissionMode: "bypassPermissions", fastMode: false, providerId: "provider", modelId: "model" }, context).catch(error => { throw nativeFailure ?? error; });
    const active = { ...context, binding };
    await adapter.sendWithDurableNativeDispatchFence({ text: "Read proof.txt on the task Device.", images: [], files: [], mentions: [], disposition: "prompt" }, active, async () => undefined);
    await vi.waitFor(async () => { expect(JSON.stringify(events)).toContain("Peer completed."); expect((await adapter.inspectSession(binding, active)).streaming).toBe(false); }, { timeout: 30_000 });
    expect(requests).toBe(2); expect(bodies[0]).toContain("PEER_SDK_GUIDANCE"); expect(bodies[1]).toContain("PEER_ONLY");
    expect(f.files.read).toHaveBeenCalledWith(expect.objectContaining({ path: "/peer/project/proof.txt" }));
    expect(bodies.join("\n")).not.toContain("/peer/project"); expect(f.data.get("/peer/project/proof.txt")?.content?.toString()).toBe("PEER_ONLY");
    await adapter.closeSession(binding, active);
  } finally {
    await adapter.dispose(); await poller.close(); await native.dispose(); database.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
