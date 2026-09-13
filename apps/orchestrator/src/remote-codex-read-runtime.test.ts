import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { TargetDescriptor } from "@joko/core";
import type {
  RemoteProcessHandle,
  RemoteProcessStartRequest,
  RemoteProcessTransportPort,
  RemoteForwardingTransportPort,
  RemoteSshTransportLease
} from "@joko/remote-ssh";
import type { RemoteHostRecord, StoredTarget } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteCodexRuntimeResolver } from "./remote-codex-read-runtime.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";
import type { RemoteCodexMcpBridgeManager } from "./remote-codex-mcp-bridge.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("RemoteCodexRuntimeResolver", () => {
  it("uses the fixed isolated runtime, bootstraps the daemon, and carries JSON-RPC over its bounded WebSocket proxy", async () => {
    const fixture = createFixture({ daemonInitiallyReady: false });
    cleanups.push(() => fixture.resolver.forceShutdown());

    const runtime = await fixture.resolver.resolve(fixture.target);
    expect(runtime.workspaceRoot).toBe("/srv/project-real");
    expect(runtime.profileKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(runtime.executionDomain).not.toContain("private-fixture-secret");
    expect(fixture.processes.requests[0]).toMatchObject({
      executable: "/bin/sh",
      cwd: "/srv/project",
      args: ["-lc", expect.stringContaining("packages/standalone/current/codex")]
    });

    const generation = await runtime.host.ensureStarted();
    expect(runtime.host.isActiveGeneration(generation)).toBe(true);
    await expect(runtime.host.request("thread/list", {
      cwd: "/srv/project-real",
      limit: 100,
      useStateDbOnly: true
    })).resolves.toMatchObject({ value: { data: [], nextCursor: null } });
    const invocations = fixture.processes.requests.map((request) => request.args.join(" "));
    expect(invocations).toEqual([
      expect.stringContaining("packages/standalone/current/codex"),
      "app-server daemon version",
      "app-server daemon bootstrap --remote-control",
      "app-server daemon version",
      "app-server proxy --sock /home/test/.joko/runtime/v1/codex-home/app-server-control/app-server-control.sock"
    ]);
    for (const request of fixture.processes.requests.slice(1)) {
      expect(request).toMatchObject({
        executable: "/home/test/.joko/runtime/v1/codex-home/packages/standalone/current/codex",
        cwd: "/srv/project-real",
        env: { CODEX_HOME: "/home/test/.joko/runtime/v1/codex-home" }
      });
    }
    expect(fixture.processes.clientMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/list"
    ]);

    const cached = await fixture.resolver.resolve(fixture.target);
    expect(cached).toBe(runtime);
    expect(fixture.capture).toHaveBeenCalledOnce();
  });

  it("fences exact Target and SSH authority revisions and never surfaces remote stderr", async () => {
    const fixture = createFixture({ probeVersion: "codex-cli 9.9.9", stderr: "private-fixture-secret" });
    cleanups.push(() => fixture.resolver.forceShutdown());
    const failure = await fixture.resolver.resolve(fixture.target).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain("private-fixture-secret");
    expect(fixture.processes.requests).toHaveLength(1);

    const valid = createFixture({});
    cleanups.push(() => valid.resolver.forceShutdown());
    const runtime = await valid.resolver.resolve(valid.target);
    runtime.assertCurrent();
    valid.stored = { ...valid.stored, revision: valid.stored.revision + 1n };
    expect(() => runtime.assertCurrent()).toThrow("Target authority changed");

    const sshDrift = createFixture({});
    cleanups.push(() => sshDrift.resolver.forceShutdown());
    const sshRuntime = await sshDrift.resolver.resolve(sshDrift.target);
    sshDrift.authorityCurrent = false;
    expect(() => sshRuntime.assertCurrent()).toThrow("SSH authority changed");
  });

  it("rejects authority drift before a mutation write and marks a post-write disconnect uncertain", async () => {
    const stale = createFixture({});
    cleanups.push(() => stale.resolver.forceShutdown());
    const staleRuntime = await stale.resolver.resolve(stale.target);
    await staleRuntime.host.ensureStarted();
    stale.authorityCurrent = false;
    await expect(staleRuntime.host.request("turn/start", { threadId: "thread-one", input: [] }, {
      mutation: true,
      beforeDispatch: staleRuntime.assertCurrent
    })).rejects.toThrow("SSH authority changed");
    expect(stale.processes.clientMessages.map((message) => message.method)).not.toContain("turn/start");

    const disconnected = createFixture({ disconnectOnMethod: "turn/start" });
    cleanups.push(() => disconnected.resolver.forceShutdown());
    const disconnectedRuntime = await disconnected.resolver.resolve(disconnected.target);
    await disconnectedRuntime.host.ensureStarted();
    await expect(disconnectedRuntime.host.request("turn/start", { threadId: "thread-one", input: [] }, {
      mutation: true,
      beforeDispatch: disconnectedRuntime.assertCurrent
    })).rejects.toMatchObject({ stateMayHaveChanged: true });
    expect(disconnected.processes.clientMessages.filter((message) => message.method === "turn/start")).toHaveLength(1);
  });

  it("opens and retires MCP routes through the forwarding capability captured with the app-server process", async () => {
    const released = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined);
    const open = vi.fn(async (authority, input) => {
      authority.assertCurrent();
      authority.assertForwardingCurrent();
      expect(authority.forwarding).toBeDefined();
      expect(input).toMatchObject({ sessionId: "session-one", targetId: "target-codex", generation: 2, threadId: "thread-one" });
      return { routes: [], assertCurrent: authority.assertCurrent, release: released };
    });
    const fixture = createFixture({ mcpBridge: { open, shutdown } });
    cleanups.push(() => fixture.resolver.forceShutdown());
    const runtime = await fixture.resolver.resolve(fixture.target);
    const bridge = await runtime.openMcpBridge!({
      sessionId: "session-one", targetId: fixture.target.id, generation: 2, threadId: "thread-one",
      assertSessionCurrent: () => undefined,
      beginToolCall: () => { throw new Error("No call expected."); }
    });
    expect(open).toHaveBeenCalledOnce();
    fixture.authorityCurrent = false;
    expect(() => bridge.assertCurrent()).toThrow("SSH authority changed");
    await fixture.resolver.forceShutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

interface FixtureOptions {
  readonly daemonInitiallyReady?: boolean;
  readonly probeVersion?: string;
  readonly stderr?: string;
  readonly disconnectOnMethod?: string;
  readonly mcpBridge?: Pick<RemoteCodexMcpBridgeManager, "open" | "shutdown">;
}

function createFixture(options: FixtureOptions) {
  const target: TargetDescriptor = {
    id: "target-codex",
    backendId: "codex",
    displayName: "Remote Codex",
    workspaceRoot: "D:\\service-owned-placeholder",
    managed: false,
    trusted: true,
    remoteWorkspace: { hostId: "host-a", workspaceRoot: "/srv/project" }
  };
  const host: RemoteHostRecord = {
    ownerId: "owner-a",
    targetId: target.id,
    id: "host-a",
    hostname: "host.example",
    port: 22,
    user: "test",
    source: "manual",
    authenticationMode: "system_agent",
    trust: { algorithm: "ssh-ed25519", fingerprint: "SHA256:pinned-host", pinnedAt: 1 },
    status: { state: "ready", changedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
    revision: 7n
  };
  const processes = new FakeRemoteProcesses(options);
  const forwarding: RemoteForwardingTransportPort = {
    open: async () => { throw new Error("Unexpected forwarding stream."); },
    listen: async () => { throw new Error("Unexpected reverse-forward listener."); }
  };
  const lease: RemoteSshTransportLease = {
    capabilities: {
      commandExecution: true,
      processStreaming: true,
      interactiveTerminal: true,
      fileTransfer: true,
      tcpForwarding: true
    },
    processes,
    forwarding
  };
  const fixture = {
    target,
    host,
    processes,
    stored: {
      descriptor: target,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      revision: 11n
    } satisfies StoredTarget,
    authorityCurrent: true,
    capture: vi.fn()
  };
  fixture.capture.mockImplementation(async () => ({
    host,
    hostRevision: host.revision,
    leaseGeneration: 3,
    lease,
    assertCurrent: () => { if (!fixture.authorityCurrent) throw new Error("SSH authority changed"); },
    assertForwardingCurrent: () => { if (!fixture.authorityCurrent) throw new Error("SSH forwarding authority changed"); }
  }));
  const resolver = new RemoteCodexRuntimeResolver({
    store: { getTarget: () => fixture.stored },
    registry: { captureProcessAuthority: fixture.capture } as unknown as Pick<RemoteHostRegistry, "captureProcessAuthority">,
    ...(options.mcpBridge === undefined ? {} : { mcpBridge: options.mcpBridge })
  });
  return Object.assign(fixture, { resolver });
}

class FakeRemoteProcesses implements RemoteProcessTransportPort {
  readonly requests: RemoteProcessStartRequest[] = [];
  readonly clientMessages: Array<{ readonly method: string; readonly id?: number }> = [];
  #daemonReady: boolean;
  readonly #probeVersion: string;
  readonly #stderr: string;
  readonly #disconnectOnMethod: string | undefined;

  constructor(options: FixtureOptions) {
    this.#daemonReady = options.daemonInitiallyReady ?? true;
    this.#probeVersion = options.probeVersion ?? "codex-cli 0.153.4";
    this.#stderr = options.stderr ?? "";
    this.#disconnectOnMethod = options.disconnectOnMethod;
  }

  async open(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle> {
    this.requests.push({
      ...request,
      args: [...request.args],
      ...(request.env === undefined ? {} : { env: { ...request.env } })
    });
    if (request.executable === "/bin/sh") {
      const processHandle = new FakeRemoteProcess();
      setImmediate(() => {
        if (this.#stderr.length > 0) processHandle.stderr.write(this.#stderr);
        processHandle.stdout.write(Buffer.from([
          "/srv/project-real",
          "/home/test/.joko/runtime/v1/codex-home",
          "/home/test/.joko/runtime/v1/codex-home/packages/standalone/current/codex",
          this.#probeVersion,
          ""
        ].join("\0"), "utf8"));
        processHandle.finish(0);
      });
      return processHandle;
    }
    const command = request.args.join(" ");
    if (command === "app-server daemon version") {
      const processHandle = new FakeRemoteProcess();
      setImmediate(() => {
        if (!this.#daemonReady) {
          if (this.#stderr.length > 0) processHandle.stderr.write(this.#stderr);
          processHandle.finish(1);
          return;
        }
        processHandle.stdout.write(JSON.stringify({
          socketPath: "/home/test/.joko/runtime/v1/codex-home/app-server-control/app-server-control.sock"
        }));
        processHandle.finish(0);
      });
      return processHandle;
    }
    if (command === "app-server daemon bootstrap --remote-control") {
      const processHandle = new FakeRemoteProcess();
      setImmediate(() => {
        this.#daemonReady = true;
        processHandle.finish(0);
      });
      return processHandle;
    }
    if (command.startsWith("app-server proxy --sock ")) {
      return new FakeRemoteProcess((chunk, processHandle) => this.#acceptProxyInput(chunk, processHandle), true);
    }
    throw new Error("unexpected remote process fixture request");
  }

  #acceptProxyInput(chunk: Buffer, processHandle: FakeRemoteProcess): void {
    const text = chunk.toString("ascii");
    if (text.startsWith("GET / HTTP/1.1\r\n")) {
      const key = /\r\nSec-WebSocket-Key: ([^\r\n]+)\r\n/iu.exec(text)?.[1];
      if (key === undefined) throw new Error("missing fixture WebSocket key");
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
        .digest("base64");
      processHandle.stdout.write(Buffer.from([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n"), "ascii"));
      return;
    }
    const frame = readClientFrame(chunk);
    if (frame.opcode === 0x8) {
      processHandle.stdout.write(serverFrame(0x8, Buffer.alloc(0)));
      processHandle.finish(0);
      return;
    }
    if (frame.opcode !== 0x1) throw new Error("unexpected fixture WebSocket opcode");
    const message = JSON.parse(frame.payload.toString("utf8")) as { readonly method: string; readonly id?: number };
    this.clientMessages.push(message);
    if (message.id === undefined) return;
    if (message.method === this.#disconnectOnMethod) {
      processHandle.finish(1);
      return;
    }
    const result = message.method === "initialize"
      ? {
          userAgent: "codex-cli/0.153.4 (linux; x86_64) joko/0.1.0",
          codexHome: "/home/test/.joko/runtime/v1/codex-home",
          platformFamily: "unix",
          platformOs: "linux"
        }
      : message.method === "thread/list"
        ? { data: [], nextCursor: null, backwardsCursor: null }
        : {};
    processHandle.stdout.write(serverFrame(0x1, Buffer.from(JSON.stringify({ id: message.id, result }), "utf8")));
  }
}

class FakeRemoteProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #finished = false;

  constructor(onInput?: (chunk: Buffer, processHandle: FakeRemoteProcess) => void, finishOnEnd = false) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          onInput?.(Buffer.from(chunk), this);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
      final: (callback) => {
        if (finishOnEnd) queueMicrotask(() => this.finish(this.exitCode ?? 0));
        callback();
      }
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#finished) return false;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    this.finish(null);
    return true;
  }

  finish(code: number | null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

function readClientFrame(frame: Buffer): { readonly opcode: number; readonly payload: Buffer } {
  const opcode = frame[0]! & 0x0f;
  let length = frame[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(offset));
    offset += 8;
  }
  expect((frame[1]! & 0x80) !== 0).toBe(true);
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  for (let index = 0; index < payload.byteLength; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!;
  return { opcode, payload };
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const extended = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + payload.byteLength);
  frame[0] = 0x80 | opcode;
  if (extended === 0) frame[1] = payload.byteLength;
  else if (extended === 2) {
    frame[1] = 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  payload.copy(frame, 2 + extended);
  return frame;
}
