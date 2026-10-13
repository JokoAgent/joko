import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { AppServerHost, CodexBackendAdapter } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import type { RemoteFileTransportPort, RemoteFileStat, RemoteProcessHandle, RemoteProcessTransportPort, RemoteProcessStartRequest } from "@joko/remote-ssh";
import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import type { OrchestratorApplication } from "./application.js";
import { ConnectionManager } from "./connection-manager.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";
import { RemoteCodexRuntimeResolver } from "./remote-codex-read-runtime.js";
import { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { RemoteSkillSourceOwner } from "./remote-skill-source.js";
import { PiResourceManager } from "./resource-manager.js";
import { createPublicServer } from "./server.js";
import { SessionHost } from "./session-host.js";
import { mkdtemp } from "./test-paths.js";

const serialize = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const profile = "/home/test/.joko/runtime/v1/codex-home";

describe("registered remote project Skill input composition", () => {
  it("approves a complete remote project package through authenticated operations and dispatches its exact native mount after durable Queue admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-skill-chain-"));
    const database = join(root, "store.db");
    const store = new OperationalStore(database);
    const files = new MemorySkillFiles();
    const privateBody = "PRIVATE_REMOTE_SKILL_FULL_PACKAGE_BODY";
    await files.mkdir("/srv/project/.agents/skills/Public-report/assets", { recursive: true });
    await files.mkdir(profile, { recursive: true });
    await files.write({ path: "/srv/project/.agents/skills/Public-report/SKILL.md", content: Buffer.from(`---\nname: native-report\ndescription: Remote full package\n---\n${privateBody}\n`) });
    await files.write({ path: "/srv/project/.agents/skills/Public-report/assets/template.bin", content: Buffer.from([0, 255, 8, 12]) });
    const daemon = new RemoteSkillDaemon();
    let leaseCurrent = true;
    const assertLease = (): void => { if (!leaseCurrent) throw new Error("The original SSH lease changed."); };
    const capture = async (): Promise<Awaited<ReturnType<RemoteHostRegistry["captureProcessAuthority"]>>> => ({ host: {
      ownerId: "owner", targetId: "remote-target", id: "ssh-host", hostname: "host.example", port: 22, user: "test",
      revision: 1n, source: "manual", authenticationMode: "system_agent", autoConnect: false, autoConnectRevision: 1n,
      createdAt: 1, updatedAt: 1, status: { state: "ready", changedAt: 1 },
      trust: { algorithm: "ssh-ed25519", fingerprint: "SHA256:approved-host", pinnedAt: 1 } },
      hostRevision: 1n, leaseGeneration: 1, lease: { capabilities: { fileTransfer: true, processStreaming: true, tcpForwarding: false,
        commandExecution: false, interactiveTerminal: false }, files, processes: daemon },
      assertCurrent: assertLease, assertFilesCurrent: assertLease, assertForwardingCurrent: assertLease });
    const router = new RemoteExecutionRouter({ hosts: { captureProcessAuthority: capture, captureTransportAuthority: capture }, peers: {} as DevicePeerOwner });
    const workspaces = new RemoteWorkspaceService(router);
    const sourceOwner = new RemoteSkillSourceOwner({ store, managedRoot: join(root, "source-generations"),
      captureSkillSourceAuthority: (workspaceId, signal) => workspaces.captureSkillSourceAuthority(workspaceId, signal) });
    const resources = new PiResourceManager({ store, managedRoot: join(root, "resources"), remoteProjectSkills: sourceOwner });
    const resolver = new RemoteCodexRuntimeResolver({ store, remoteExecution: router, nativeSkillJournalRoot: join(root, "mount-journals"),
      captureSkillSourceAuthority: (workspaceId, signal) => workspaces.captureSkillSourceAuthority(workspaceId, signal) });
    const localCatalog = new FakeCodexAppServer();
    const localHost = new AppServerHost({ transportFactory: () => localCatalog.createTransport() });
    const adapter: CodexBackendAdapter = new CodexBackendAdapter({ id: "remote-native-backend", instanceGeneration: 1, host: localHost, profileDirectory: join(root, "local-profile"),
      remoteRuntimes: resolver, resolveNativeSkills: (context, signal) => resources.runtimeSkillSnapshot(adapter.id, context.target.id, signal, undefined, context) });
    const descriptor = await adapter.describe();
    const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
    await artifacts.initialize();
    const host = new SessionHost(store, artifacts, [adapter], { backendDescriptors: [descriptor] });
    const connections = new ConnectionManager(store);
    const challenge = connections.issuePairing("Remote Skill client");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Remote Skill client" });
    let sessionId = "", resourceId = "", mountedPath = "", queueId = "";
    let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
    try {
      await host.initialize(); await resources.initialize();
      const binding = { kind: "ssh" as const, hostTargetId: "remote-target", hostId: "ssh-host", workspaceRoot: "/srv/project" };
      const target = { id: "remote-target", backendId: adapter.id, displayName: "Remote project", workspaceRoot: root,
        managed: false, trusted: true, remoteWorkspace: binding };
      store.upsertTarget(target, { workspaceId: "remote-workspace" });
      await workspaces.register({ id: "remote-workspace", root: binding.workspaceRoot, displayName: "Remote project", trusted: true,
        remote: { targetId: "remote-target", binding } });
      await resolver.resolve(target);
      await host.registerTarget(target, { workspaceId: "remote-workspace" });
      server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false,
        corsOrigins: [], webDirectory: join(root, "no-web"), dataDirectory: root }, store, connections, sessionHost: host,
        piResources: resources, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {}, workspaceChanges: {}, scheduler: {},
        adapters: [adapter], browserActivity: [], restartBackend: async () => undefined } as unknown as OrchestratorApplication);
      server.log.level = "silent";
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => {
        request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request);
      }] });
      const operations = createClient(contract.OperationService, transport);
      const catalogClient = createClient(contract.PiService, transport);
      const sessions = createClient(contract.SessionService, transport);
      await operations.submitOperation({ operationId: "discover-remote-project", connectionId: paired.connection.id,
        mutation: { payload: { case: "discoverProjectResources", value: { targetId: "remote-target" } } } });
      const pending = await catalogClient.listPiResources({ backendId: adapter.id, targetId: "remote-target" });
      expect(pending.resources).toHaveLength(1);
      const discovered = pending.resources[0]!; resourceId = discovered.resourceId;
      expect(discovered).toMatchObject({ source: { scope: contract.ResourceScope.PROJECT, acquisitionKind: contract.ResourceAcquisitionKind.REMOTE_PROJECT,
        sourceDisplay: "Public-report" }, state: contract.ResourceState.AWAITING_APPROVAL, enabled: false });
      expect(discovered.source?.sourceIdentity).toMatch(/^sha256:/u);
      expect(serialize(pending)).not.toContain("/srv/project");
      expect(serialize(pending)).not.toContain(privateBody);
      await operations.submitOperation({ operationId: "approve-remote-project", connectionId: paired.connection.id,
        mutation: { payload: { case: "approveResource", value: { resourceId, discoveredRevision: discovered.discoveredRevision } } } });
      await operations.submitOperation({ operationId: "enable-remote-project", connectionId: paired.connection.id,
        mutation: { payload: { case: "setResourceEnabled", value: { resourceId, enabled: true } } } });
      daemon.fake.seedThread(binding.workspaceRoot);
      const nativeReference = (await adapter.listNativeSessions(target))[0]!.nativeReference;
      sessionId = (await host.createSession({ operationId: "create-remote-skill-task", connection: paired.connection,
        targetId: "remote-target", title: "Remote approved Skill", providerId: "openai", modelId: "gpt-test",
        nativeStart: { kind: "attach", nativeReference },
        fastMode: false, permissionMode: "ask", planMode: false }).catch((error: unknown) => {
          throw new Error(serialize(store.getOperation("create-remote-skill-task").error), { cause: error });
        })).value.sessionId;
      const loaded = (await sessions.listSessionResources({ sessionId })).resources[0]!;
      expect(loaded).toMatchObject({ resourceId, name: "Public-report", kind: contract.ResourceKind.SKILL });
      mountedPath = daemon.mountPaths[0]!;
      expect(mountedPath).toMatch(/^\/home\/test\/\.joko\/runtime\/v1\/codex-home\/\.joko-approved-skills\//u);
      expect(await files.read({ path: posix.join(posix.dirname(mountedPath), "assets/template.bin"), maximumBytes: 4 })).toEqual(Buffer.from([0, 255, 8, 12]));
      expect((await sessions.listRuntimeCommands({ sessionId })).commands).toEqual([]);
      const nativeStart = daemon.messages.find(message => message.method === "thread/resume")!;
      expect(serialize(nativeStart.params)).toContain('"skills.config"');
      expect(serialize(nativeStart.params)).toContain('"enabled":false');
      await expect(createClient(contract.SessionService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
        .listSessionResources({ sessionId })).rejects.toMatchObject({ code: Code.Unauthenticated });
      daemon.beforeTurnWrite = () => {
        const queue = store.listQueueItems({ sessionId, limit: 10 })[0]!;
        expect(queue.state).toBe("dispatching"); expect(queue.runId).toBeDefined();
        expect(store.getRun(queue.runId!).descriptor.activeAttemptId).toBeDefined(); queueId = queue.id;
      };
      await operations.submitOperation({ operationId: "send-remote-approved-skill", connectionId: paired.connection.id,
        mutation: { preconditions: [{ entity: { kind: contract.EntityKind.SESSION, id: sessionId }, expectedGeneration: loaded.runtimeGeneration }],
          payload: { case: "sendInput", value: { sessionId, deliveryMode: contract.QueueDeliveryMode.PROMPT,
            input: { parts: [{ content: { case: "text", value: "Use @Public-report" } }, { content: { case: "resourceMention", value: {
              resourceId, displayText: "@Public-report", discoveredRevision: loaded.discoveredRevision, resourceVersion: loaded.resourceVersion,
              runtimeGeneration: loaded.runtimeGeneration } } }], mentionRanges: [{ start: 4, end: 18, mentionIndex: 0 }] } } } } });
      await expect.poll(() => daemon.messages.filter(message => message.method === "turn/start").length, { timeout: 10_000 }).toBe(1);
      expect(queueId).not.toBe("");
      expect(daemon.messages.find(message => message.method === "turn/start")!.params).toMatchObject({
        input: expect.arrayContaining([{ type: "skill", name: "native-report", path: mountedPath }]) });
      const queue = store.getQueueItem(queueId);
      expect(queue.body.mentions[0]).toMatchObject({ kind: "resource", reference: resourceId, discoveredRevision: loaded.discoveredRevision,
        resourceVersion: loaded.resourceVersion.toString(), runtimeGeneration: Number(loaded.runtimeGeneration) });
      for (const publicValue of [loaded, queue, store.listEvents({ sessionId }), store.getSession(sessionId)]) {
        expect(serialize(publicValue)).not.toContain(privateBody); expect(serialize(publicValue)).not.toContain(mountedPath);
      }
      await daemon.fake.completeTurn(store.getSession(sessionId).descriptor.binding.nativeSessionId!);
      await expect.poll(() => store.getQueueItem(queueId).state, { timeout: 10_000 }).toBe("completed");
    } finally {
      await server?.close(); await host.dispose(); await adapter.dispose(); await resolver.shutdown(); await workspaces.close();
      await localHost.shutdown();
      leaseCurrent = false; store.close();
    }
    const reopened = new OperationalStore(database);
    try {
      expect(reopened.getQueueItem(queueId).state).toBe("completed");
      expect(reopened.getQueueItem(queueId).body.mentions[0]?.reference).toBe(resourceId);
      expect(serialize(reopened.listEvents({ sessionId }))).not.toContain(mountedPath);
    } finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
  });
});

class MemorySkillFiles implements RemoteFileTransportPort {
  readonly entries = new Map<string, { kind: "file" | "directory"; content: Buffer; mode: number; modifiedAt: number }>([["/", { kind: "directory", content: Buffer.alloc(0), mode: 0o700, modifiedAt: 1 }]]);
  #clock = 1;
  #entry(path: string) { const entry = this.entries.get(path); if (entry === undefined) throw Object.assign(new Error("Missing fixture entry"), { code: "ENOENT" }); return entry; }
  async realpath(path: string): Promise<string> { this.#entry(path); return posix.normalize(path); }
  async stat(path: string): Promise<RemoteFileStat> { const entry = this.#entry(path); return { kind: entry.kind, size: entry.content.length, mode: entry.mode, modifiedAt: entry.modifiedAt }; }
  async list(path: string) { this.#entry(path); return [...this.entries].filter(([key]) => key !== path && posix.dirname(key) === path).map(([key, value]) => ({ name: posix.basename(key), kind: value.kind })); }
  async read(request: Parameters<RemoteFileTransportPort["read"]>[0]) { const entry = this.#entry(request.path); if (entry.kind !== "file" || entry.content.length > request.maximumBytes) throw new Error("Invalid fixture read"); return Buffer.from(entry.content); }
  async write(request: Parameters<RemoteFileTransportPort["write"]>[0]) { this.#entry(posix.dirname(request.path)); this.entries.set(request.path, { kind: "file", content: Buffer.from(request.content), mode: request.mode ?? 0o600, modifiedAt: ++this.#clock }); }
  async mkdir(path: string, options?: Parameters<RemoteFileTransportPort["mkdir"]>[1]) { if (this.entries.has(path)) { if (options?.recursive) return; throw Object.assign(new Error("Existing fixture directory"), { code: "EEXIST" }); } if (options?.recursive && !this.entries.has(posix.dirname(path))) await this.mkdir(posix.dirname(path), options); this.#entry(posix.dirname(path)); this.entries.set(path, { kind: "directory", content: Buffer.alloc(0), mode: options?.mode ?? 0o700, modifiedAt: ++this.#clock }); }
  async rename(source: string, destination: string) { this.entries.set(destination, this.#entry(source)); this.entries.delete(source); }
  async remove(path: string) { this.#entry(path); for (const key of this.entries.keys()) if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key); }
}

class RemoteSkillDaemon implements RemoteProcessTransportPort {
  readonly fake = new FakeCodexAppServer();
  readonly messages: { method: string; params?: Record<string, unknown> }[] = [];
  readonly mountPaths: string[] = [];
  beforeTurnWrite?: () => void;
  constructor() { this.fake.codexHome = profile; this.fake.userAgent = "codex-cli/0.159.2 (linux; x86_64) joko/0.1.0";
    this.fake.reviewConfig = { skills: { config: [{ path: "/home/test/.agents/skills/ambient/SKILL.md", enabled: true }] } }; }
  async open(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle> {
    if (request.executable === "/bin/sh") {
      const process = new SkillProcess(); setImmediate(() => { process.stdout.write([request.cwd, profile, `${profile}/packages/standalone/current/codex`, "codex-cli 0.159.2", "ready", ""].join("\0")); process.finish(); }); return process;
    }
    if (request.args.join(" ") === "app-server daemon version") {
      const process = new SkillProcess(); setImmediate(() => { process.stdout.write(JSON.stringify({ socketPath: `${profile}/app-server-control/app-server-control.sock` })); process.finish(); }); return process;
    }
    if (!request.args.join(" ").startsWith("app-server proxy --sock ")) throw new Error("Unexpected fixture process");
    const transport = this.fake.createTransport();
    const process = new SkillProcess(async chunk => {
      const text = chunk.toString("ascii");
      if (text.startsWith("GET / HTTP/1.1\r\n")) {
        const key = /\r\nSec-WebSocket-Key: ([^\r\n]+)\r\n/iu.exec(text)![1]!;
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        process.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); return;
      }
      const frame = clientPayload(chunk);
      if (frame.opcode === 8) { process.stdout.write(serverFrame(8, Buffer.alloc(0))); process.finish(); return; }
      const message = JSON.parse(frame.payload.toString()) as { method: string; params?: Record<string, unknown>; id?: number };
      this.messages.push(message);
      if (message.id === undefined) return;
      if (message.method === "thread/start" || message.method === "thread/resume") {
        const config = message.params?.["config"] as Record<string, unknown> | undefined;
        for (const entry of (config?.["skills.config"] ?? []) as { path: string; enabled: boolean }[]) {
          if (entry.enabled) { this.mountPaths.push(entry.path); this.fake.reviewSkills.push({ name: "native-report", path: entry.path, enabled: true }); }
        }
      }
      if (message.method === "turn/start") this.beforeTurnWrite?.();
      const result = await transport.request(message.method, message.params as Parameters<typeof transport.request>[1]);
      process.stdout.write(serverFrame(1, Buffer.from(JSON.stringify({ id: message.id, result }))));
    });
    await transport.start({ onNotification: notification => { process.stdout.write(serverFrame(1, Buffer.from(JSON.stringify(notification)))); },
      onRequest: () => { throw new Error("No server request expected."); }, onExit: () => undefined });
    return process;
  }
}
class SkillProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); readonly stdin: Writable;
  readonly pid = undefined; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  constructor(input?: (chunk: Buffer) => Promise<void>) { super(); this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
    void Promise.resolve(input?.(Buffer.from(chunk))).then(() => callback(), error => callback(error as Error));
  }, final: callback => { if (input !== undefined) this.finish(); callback(); } }); }
  kill(signal: NodeJS.Signals | number = "SIGTERM") { if (this.exitCode !== null) return false; this.signalCode = typeof signal === "string" ? signal : "SIGTERM"; this.finish(); return true; }
  finish() { if (this.exitCode !== null) return; this.exitCode = 0; this.stdout.end(); this.stderr.end(); this.emit("exit", this.exitCode, this.signalCode); }
}
function clientPayload(frame: Buffer) {
  let length = frame[1]! & 127, offset = 2;
  if (length === 126) { length = frame.readUInt16BE(offset); offset += 2; }
  else if (length === 127) { length = Number(frame.readBigUInt64BE(offset)); offset += 8; }
  const mask = frame.subarray(offset, offset + 4); offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
  return { opcode: frame[0]! & 15, payload };
}
function serverFrame(opcode: number, payload: Buffer) {
  const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + payload.length); frame[0] = 128 | opcode;
  if (extended === 0) frame[1] = payload.length;
  else if (extended === 2) { frame[1] = 126; frame.writeUInt16BE(payload.length, 2); }
  else { frame[1] = 127; frame.writeBigUInt64BE(BigInt(payload.length), 2); }
  payload.copy(frame, 2 + extended); return frame;
}
