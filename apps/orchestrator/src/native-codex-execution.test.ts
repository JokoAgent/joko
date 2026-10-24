import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { CodexNativeExecutionInput, CodexNativeProcess } from "@joko/adapter-codex";
import type { AdapterContext, OrderedPolicyRule, PolicySnapshot, SessionDescriptor, TargetDescriptor } from "@joko/core";
import type { RemoteFileTransportPort, RemoteForwardingTransportPort } from "@joko/remote-ssh";
import { NotFoundError } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createNativeCodexExecution } from "./native-codex-execution.js";
import { reviewNativeToolPolicy } from "./native-tool-policy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const rule = (subjectKind: OrderedPolicyRule["subjectKind"], extra: Partial<OrderedPolicyRule> = {}): OrderedPolicyRule => ({
  id: subjectKind, subjectKind, effect: "deny", ceiling: "critical", priority: 0, order: 0, ...extra
});

describe("ordinary Codex native execution authority", () => {
  it("blocks automatic native reads, writes and commands before child stdin while preserving unrelated native paths and bytes", async () => {
    const f = await fixture();
    f.rules = [rule("file_read", { workspaceRelativePathPrefix: "private" }), rule("file_write", { workspaceRelativePathPrefix: "private" }), rule("command")];
    for (const [method, params] of [
      ["fs/readFile", { path: f.uri("private/a") }],
      ["fs/writeFile", { path: f.uri("private/a"), dataBase64: "YWJj" }],
      ["process/start", { processId: "denied", argv: ["pwd"], cwd: f.uri("") }]
    ] as const) expect((await f.call(method, params)).error).toMatchObject({ code: -32001 });
    expect(f.child.received).toEqual([]);
    const payload = Buffer.from(`literal path ${f.root}/private/a`).toString("base64");
    await f.call("fs/writeFile", { path: f.uri("public/a"), dataBase64: payload });
    expect(f.child.received).toEqual([expect.objectContaining({ method: "fs/writeFile", params: { path: f.uri("public/a"), dataBase64: payload } })]);
    expect(f.interact).not.toHaveBeenCalled();
  });

  it("checks recursive copy source and destination subtrees, and recursive deletion", async () => {
    const f = await fixture();
    f.rules = [rule("file_read", { workspaceRelativePathPrefix: "source/private" })];
    expect((await f.call("fs/copy", { sourcePath: f.uri("source"), destinationPath: f.uri("destination"), recursive: true })).error).toBeDefined();
    f.rules = [rule("file_write", { workspaceRelativePathPrefix: "destination/private" })];
    expect((await f.call("fs/copy", { sourcePath: f.uri("source"), destinationPath: f.uri("destination"), recursive: true })).error).toBeDefined();
    expect((await f.call("fs/remove", { path: f.uri("destination"), recursive: true })).error).toBeDefined();
    expect(f.child.received).toEqual([]);
  });

  it.each(["policy", "turn"] as const)("does not reuse an open native file handle after its %s owner changes", async kind => {
    const f = await fixture();
    await f.call("fs/open", { handleId: "file-a", path: f.uri("private.txt") });
    await f.call("fs/readBlock", { handleId: "file-a", offset: 0, len: 10 });
    expect(f.child.received).toHaveLength(2);
    if (kind === "policy") { f.rules = [rule("file_read")]; f.revision++; }
    else f.current = { ...f.current, operationId: "next-turn" };
    await expect(f.call("fs/readBlock", { handleId: "file-a", offset: 10, len: 10 })).rejects.toThrow();
    expect(f.child.received).toHaveLength(2);
  });

  it("rejects an unknown native file handle before child stdin", async () => {
    const f = await fixture();
    await expect(f.call("fs/readBlock", { handleId: "unknown", offset: 0, len: 10 })).rejects.toThrow();
    expect(f.child.received).toEqual([]);
  });

  it("routes native capability discovery through tree reads and native HTTP through network policy", async () => {
    const f = await fixture();
    f.rules = [rule("file_read", { workspaceRelativePathPrefix: "private" }), rule("network")];
    expect((await f.call("capabilityRoots/discoverV1", { roots: [{ id: "project", path: f.uri("") }] })).error).toBeDefined();
    expect((await f.call("http/request", { method: "GET", url: "https://example.test/tools", headers: [], requestId: "request-a", streamResponse: false })).error).toBeDefined();
    expect(f.child.received).toEqual([]);
  });

  it("passes sibling read denials into the actual native recursive request sandbox", async () => {
    const f = await fixture({ remote: "posix" });
    f.rules = [rule("file_read", { workspaceRelativePathPrefix: "private" })];
    expect((await f.call("fs/walk", { path: f.uri("public"), options: { followDirectorySymlinks: true } })).error).toBeUndefined();
    expect(f.child.received[0]).toMatchObject({ method: "fs/walk", params: { path: f.uri("public"), sandbox: { permissions: {
      type: "managed", file_system: { type: "restricted", entries: expect.arrayContaining([{ path: { type: "path", path: f.uri("private") }, access: "deny" }]) }
    } } } });
  });

  it("does not load ambient executor configuration or inject ambient environment credentials into HTTP", async () => {
    const f = await fixture();
    expect((await f.call("environmentConfig/read", { cwd: f.uri(""), configPaths: [["mcp_servers"]], requirementsPaths: [["mcp_servers"]] })).error).toBeDefined();
    expect((await f.call("http/request", { method: "GET", url: "https://example.test/tools", headers: [{ name: "Authorization", value: "Bearer ", valueEnvVar: "UNRELATED_SECRET" }],
      requestId: "request-a", streamResponse: false })).error).toBeDefined();
    expect(f.child.received).toEqual([]);
    await f.call("http/request", { method: "GET", url: "https://example.test/tools", headers: [], requestId: "explicit-request", streamResponse: false, redirectPolicy: "follow" });
    expect(f.child.received).toEqual([expect.objectContaining({ method: "http/request", params: expect.objectContaining({ redirectPolicy: "stop" }) })]);
  });

  it.each(["policy", "turn", "target", "signal"] as const)("does not dispatch an approved primitive after its %s changes during permission", async kind => {
    const f = await fixture();
    f.rules = [rule("file_write", { effect: "ask" })];
    let grant!: () => void;
    f.interact.mockImplementationOnce(async () => { await new Promise<void>(resolve => { grant = resolve; }); return { kind: "selected", value: "allow_once" }; });
    const result = f.call("fs/writeFile", { path: f.uri("new.txt"), dataBase64: "YWJj" }).catch(() => ({ error: true }));
    await expect.poll(() => f.interact.mock.calls.length).toBe(1);
    if (kind === "policy") f.revision++;
    if (kind === "turn") f.current = { ...f.current, operationId: "another-turn" };
    if (kind === "target") f.targetRevision++;
    if (kind === "signal") f.turn.abort();
    grant();
    expect((await result).error).toBeDefined();
    expect(f.child.received).toEqual([]);
  });

  it("uses the current turn policy, asks only on that owner, and fences deleted Sessions", async () => {
    const f = await fixture();
    f.current = { ...f.current, operationId: "later-turn" };
    f.rules = [rule("file_write", { effect: "ask" })];
    expect((await f.call("fs/writeFile", { path: f.uri("allowed.txt"), dataBase64: "YQ==" })).error).toBeUndefined();
    expect(f.interact).toHaveBeenCalledTimes(1);
    f.present = false;
    await expect(f.call("fs/readFile", { path: f.uri("allowed.txt") })).rejects.toThrow();
    expect(f.child.received).toHaveLength(1);
  });

  it("captures the original owner before wire delivery queues, so an old message cannot borrow the next turn", async () => {
    const f = await fixture();
    f.rules = [rule("file_write", { effect: "ask" })];
    let grant!: () => void;
    f.interact.mockImplementationOnce(async () => { await new Promise<void>(resolve => { grant = resolve; }); return { kind: "selected", value: "allow_once" }; });
    const first = f.call("fs/writeFile", { path: f.uri("first.txt"), dataBase64: "YQ==" }).catch(() => ({ error: true }));
    await expect.poll(() => f.interact.mock.calls.length).toBe(1);
    const captures = f.capture.mock.calls.length;
    const queued = f.call("fs/writeFile", { path: f.uri("queued.txt"), dataBase64: "Yg==" }).catch(() => ({ error: true }));
    await expect.poll(() => f.capture.mock.calls.length).toBeGreaterThan(captures);
    f.current = { ...f.current, operationId: "next-turn" };
    grant();
    const results = await Promise.all([first, queued]);
    expect(results.every(result => result.error !== undefined)).toBe(true);
    expect(f.child.received).toEqual([]);
    expect(f.interact).toHaveBeenCalledTimes(1);
  });

  it("does not deliver a delayed native file response after its policy is revoked", async () => {
    const f = await fixture();
    f.child.hold = true;
    const result = f.call("fs/readFile", { path: f.uri("private.txt") }).catch(() => ({ error: true }));
    await expect.poll(() => f.child.received.length).toBe(1);
    f.revision++;
    f.child.respond(f.child.received[0]!);
    expect((await result).error).toBeDefined();
    expect(f.child.signalCode).toBe("SIGTERM");
  });

  it("allows policy-checked initialization reads but never initialization writes, commands or interactive grants", async () => {
    const f = await fixture({ provisional: true });
    expect((await f.call("fs/readFile", { path: f.uri("AGENTS.md") })).error).toBeUndefined();
    expect((await f.call("fs/writeFile", { path: f.uri("early.txt"), dataBase64: "YQ==" })).error).toBeDefined();
    expect((await f.call("process/start", { processId: "early", argv: ["pwd"], cwd: f.uri("") })).error).toBeDefined();
    f.rules = [rule("file_read", { effect: "ask" })];
    expect((await f.call("fs/readFile", { path: f.uri("AGENTS.md") })).error).toBeDefined();
    expect(f.interact).not.toHaveBeenCalled();
    expect(f.child.received).toHaveLength(1);
  });

  it("keeps the registered Target revision while accepting a Host-selected runtime Backend", async () => {
    const f = await fixture({ registeredBackend: "group-default" });
    expect((await f.call("fs/readFile", { path: f.uri("AGENTS.md") })).error).toBeUndefined();
    f.targetRevision++;
    await expect(f.call("fs/readFile", { path: f.uri("AGENTS.md") })).rejects.toThrow();
    expect(f.child.received).toHaveLength(1);
  });

  it("limits a pending handoff to reads on its exact original Session row, adopts once and never downgrades", async () => {
    const f = await fixture({ handoff: true });
    expect((await f.call("fs/readFile", { path: f.uri("AGENTS.md") })).error).toBeUndefined();
    expect((await f.call("fs/writeFile", { path: f.uri("early.txt"), dataBase64: "YQ==" })).error).toBeDefined();
    f.adopted = true; f.sessionRevision++;
    expect((await f.call("fs/writeFile", { path: f.uri("adopted.txt"), dataBase64: "YQ==" })).error).toBeUndefined();
    f.adopted = false;
    await expect(f.call("fs/readFile", { path: f.uri("AGENTS.md") })).rejects.toThrow();
    expect(f.child.received).toHaveLength(2);
  });

  it("rejects a changed original row while a handoff is still provisional", async () => {
    const f = await fixture({ handoff: true });
    f.sessionRevision++;
    await expect(f.call("fs/readFile", { path: f.uri("AGENTS.md") })).rejects.toThrow();
    expect(f.child.received).toEqual([]);
  });

  it("allows preparation reads but keeps an idle task from starting new effects or obtaining a grant", async () => {
    const f = await fixture();
    f.activeTurn = false;
    expect((await f.call("fs/readFile", { path: f.uri("AGENTS.md") })).error).toBeUndefined();
    expect((await f.call("fs/writeFile", { path: f.uri("idle.txt"), dataBase64: "YQ==" })).error).toBeDefined();
    f.rules = [rule("file_read", { effect: "ask" })];
    expect((await f.call("fs/readFile", { path: f.uri("AGENTS.md") })).error).toBeDefined();
    expect(f.interact).not.toHaveBeenCalled();
    f.rules = []; f.activeTurn = true;
    expect((await f.call("fs/writeFile", { path: f.uri("active.txt"), dataBase64: "YQ==" })).error).toBeUndefined();
    expect(f.child.received).toHaveLength(2);
  });

  it("retains the original cleanup owner and retries an unconfirmed child retirement", async () => {
    const f = await fixture();
    await f.call("fs/readFile", { path: f.uri("AGENTS.md") });
    f.child.failNextKill = true;
    await expect(f.lease.close()).rejects.toThrow("cleanup is unconfirmed");
    expect(f.child.signalCode).toBeNull();
    await f.lease.close();
    expect(f.child.signalCode).toBe("SIGTERM");
  });

  it.each(["posix", "win32"] as const)("keeps %s remote execution on the captured transport and canonicalizes denied aliases", async pathStyle => {
    const f = await fixture({ remote: pathStyle });
    f.rules = [rule("file_read", { workspaceRelativePathPrefix: "private" })];
    expect((await f.call("fs/readFile", { path: f.uri("alias/a") })).error).toBeDefined();
    expect(f.realpath).toHaveBeenCalled();
    expect(f.child.received).toEqual([]);
    await f.call("fs/readFile", { path: f.uri("public/a") });
    expect(f.child.received[0]).toMatchObject({ params: { path: f.uri("public/a") } });
    expect(f.listen).toHaveBeenCalledWith(expect.objectContaining({ remoteListenHost: "127.0.0.1", localDestinationHost: "127.0.0.1" }));
    expect(f.open).toHaveBeenCalledTimes(1);
    f.transportCurrent = false;
    await expect(f.call("fs/readFile", { path: f.uri("public/b") })).rejects.toThrow();
    expect(f.child.received).toHaveLength(1);
    await f.lease.close();
    expect(f.forwardClose).toHaveBeenCalledTimes(1);
    expect(f.child.signalCode).toBe("SIGTERM");
  });
});

async function fixture(input: { remote?: "posix" | "win32"; provisional?: boolean; handoff?: boolean; registeredBackend?: string } = {}) {
  const pathStyle = input.remote ?? (process.platform === "win32" ? "win32" : "posix");
  const root = pathStyle === "win32" ? "C:\\project" : "/project";
  const remoteWorkspace = input.remote ? { kind: "ssh" as const, hostTargetId: "host-target", hostId: "host", workspaceRoot: root } : undefined;
  const target: TargetDescriptor = { id: "project", backendId: "codex", workspaceRoot: root, trusted: true, managed: false, displayName: "Project",
    ...(remoteWorkspace ? { remoteWorkspace } : {}) };
  const child = new NativeProcess();
  const turn = new AbortController(), interact = vi.fn<AdapterContext["requestInteraction"]>(async () => ({ kind: "selected", value: "allow_once" }));
  const state = { rules: [] as readonly OrderedPolicyRule[], revision: 1, targetRevision: 1n, present: !input.provisional, transportCurrent: true,
    adopted: !input.handoff, sessionRevision: 1n, activeTurn: true, current: undefined as unknown as AdapterContext };
  const currentSnapshot = (): PolicySnapshot => ({ generation: String(state.revision), backendId: target.backendId, targetId: target.id, workspaceRoot: root, rules: state.rules });
  const authority = {
    required: false, capture: vi.fn(() => String(state.revision)),
    snapshot: currentSnapshot,
    assertCurrent: (expected?: string) => { if (expected !== undefined && expected !== String(state.revision)) throw new Error("Policy changed."); },
    review: async (request: Parameters<typeof reviewNativeToolPolicy>[1]) => {
      return reviewNativeToolPolicy(currentSnapshot(), request, { pathStyle, remote: !!input.remote });
    }
  };
  state.current = { sessionId: "task", generation: input.handoff ? 2 : 1, backendInstanceGeneration: 3, target, signal: turn.signal,
    emit: async () => undefined, requestInteraction: interact, artifactCapacityBytes: 1024,
    storeArtifact: async () => { throw new Error("Unexpected Artifact."); }, nativeToolAuthorization: authority };
  const original = state.current;
  const store = { getTarget: () => ({ descriptor: { ...target, backendId: input.registeredBackend ?? target.backendId }, metadata: {}, createdAt: 1, updatedAt: 1, revision: state.targetRevision }),
    getSession: () => {
      if (!state.present) throw new NotFoundError("Session", "task");
      return { descriptor: { id: "task", targetId: target.id, backendId: state.adopted ? target.backendId : "previous-backend",
        binding: { opaqueRef: "native", generation: state.adopted ? original.generation : 1 } } as SessionDescriptor, revision: state.sessionRevision };
    } };
  const realpath = vi.fn(async (path: string) => path.replace(/([\\/])alias([\\/])/u, "$1private$2"));
  const forwardClose = vi.fn(async () => undefined);
  const listen = vi.fn<RemoteForwardingTransportPort["listen"]>(async request => ({ remoteHost: "127.0.0.1", remotePort: request.localDestinationPort, close: forwardClose }));
  const assertTransport = () => { if (!state.transportCurrent) throw new Error("Remote transport changed."); };
  const workspace = vi.fn(async () => ({ kind: "ssh" as const, binding: remoteWorkspace!, executionIdentity: "machine", authorityIdentity: "transport:1", pathStyle,
    files: { realpath } as unknown as RemoteFileTransportPort, processes: { open: async () => child }, forwarding: { listen, open: async () => { throw new Error("Unexpected forward."); } },
    assertCurrent: assertTransport, assertFilesCurrent: assertTransport, assertForwardingCurrent: assertTransport }));
  const open = vi.fn(async () => child);
  const factory = createNativeCodexExecution({ store, remoteExecution: { workspace }, executable: "unreachable-codex" });
  const execution: CodexNativeExecutionInput = { context: original, workspaceRoot: root, pathStyle, remote: !!input.remote,
    assertCurrent: () => undefined, currentContext: () => state.current, hasActiveTurn: () => state.activeTurn, openExecServerProcess: open };
  const lease = await factory.openExecServer(execution);
  cleanups.push(() => lease.close());
  const socket = new WebSocket(lease.execServerUrl, { headers: { authorization: "Bearer " + lease.authBearerToken } });
  cleanups.push(async () => { socket.terminate(); });
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  socket.on("message", data => {
    const response = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = pending.get(response.id as number); if (waiter) { pending.delete(response.id as number); waiter.resolve(response); }
  });
  socket.on("error", () => { for (const waiter of pending.values()) waiter.reject(new Error("Native socket failed.")); pending.clear(); });
  socket.on("close", () => { for (const waiter of pending.values()) waiter.reject(new Error("Native socket closed.")); pending.clear(); });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let nextId = 0;
  const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("Native response timed out.")); }, 5_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const uri = (suffix: string) => input.remote
    ? `file:///${pathStyle === "win32" ? "C:/project" : "project"}${suffix ? "/" + suffix : ""}`
    : pathToFileURL(root + (suffix ? "/" + suffix : "")).href;
  return Object.assign(state, { root, child, turn, interact, realpath, listen, forwardClose, open, lease, call, uri, capture: authority.capture });
}

class NativeProcess extends EventEmitter implements CodexNativeProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Record<string, unknown>[] = [];
  hold = false;
  failNextKill = false;
  readonly stdin = new Writable({ write: (data, _encoding, callback) => {
    const record = JSON.parse(Buffer.from(data).toString()) as Record<string, unknown>;
    this.received.push(record);
    if (!this.hold) this.respond(record);
    callback();
  } });
  readonly pid = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  respond(record: Record<string, unknown>): void { this.stdout.write(JSON.stringify({ id: record.id, result: {} }) + "\n"); }
  kill(): boolean {
    if (this.failNextKill) { this.failNextKill = false; throw new Error("Child retirement is unconfirmed."); }
    if (this.signalCode !== null) return false;
    this.signalCode = "SIGTERM"; this.stdout.end(); this.stderr.end(); this.emit("exit", null, "SIGTERM"); return true;
  }
}
