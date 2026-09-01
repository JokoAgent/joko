import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { link, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, posix as remotePath } from "node:path";
import { PassThrough } from "node:stream";

import {
  MANAGED_SUBAGENT_NODE_ENV,
  MANAGED_SUBAGENT_RUNNER_FILE_NAME,
  type PiProcessHandle,
  type PiProcessSpec
} from "@joko/adapter-pi";
import type {
  RemoteDirectoryEntry,
  RemoteFileReadRequest,
  RemoteFileStat,
  RemoteFileTransportPort,
  RemoteFileWriteRequest,
  RemoteProcessHandle,
  RemoteProcessStartRequest,
  RemoteSshTransportLease
} from "@joko/remote-ssh";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteHostRegistry } from "./remote-host-registry.js";
import { REMOTE_PI_BROKER_SOURCE_SHA256 } from "./remote-pi-broker-source.js";
import { RemotePiProcessFactory } from "./remote-pi-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RemotePiProcessFactory", () => {
  it("installs the broker, sends secrets only in its bounded bootstrap, maps paths, and retains attachable state", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-"));
    temporaryDirectories.push(fixture);
    const runtime = join(fixture, "runtime");
    const agentHome = join(fixture, "agent-home");
    const sessions = join(agentHome, "sessions");
    const managedRunRoot = join(agentHome, "subagent-runs");
    await mkdir(runtime, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await mkdir(managedRunRoot, { recursive: true });
    const control = join(runtime, "control.json");
    const descriptor = join(runtime, "mcp.json");
    const cli = join(fixture, "pi-cli.mjs");
    const managedSupport = join(runtime, "managed-support");
    const managedExtension = join(managedSupport, "joko-managed-subagent.ts");
    const managedRunner = join(managedSupport, MANAGED_SUBAGENT_RUNNER_FILE_NAME);
    await mkdir(managedSupport, { recursive: true });
    await Promise.all([
      writeFile(control, JSON.stringify({ generation: 1 }), { mode: 0o600 }),
      writeFile(descriptor, JSON.stringify({ endpoint: "http://127.0.0.1:39471/rpc" }), { mode: 0o600 }),
      writeFile(cli, "export {};", { mode: 0o600 }),
      writeFile(managedExtension, "export const extension = true;\n", { mode: 0o600 }),
      writeFile(managedRunner, "module.exports = { runner: true };\n", { mode: 0o600 })
    ]);

    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    let releaseAuthorityCommit!: () => void;
    const authorityCommitGate = new Promise<void>((resolveCommit) => {
      releaseAuthorityCommit = resolveCommit;
    });
    const remoteProcess = new ManualRemoteProcess({ authorityCommitGate });
    const managedStoreOperations: Record<string, unknown>[] = [];
    let processRequest: RemoteProcessStartRequest | undefined;
    let forwardClosed = false;
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: true
      },
      files,
      processes: {
        open: async (request) => {
          if (request.args[1] === "store") {
            return new ManagedStoreRemoteProcess(managedStoreOperations);
          }
          processRequest = request;
          return remoteProcess;
        }
      },
      forwarding: {
        open: async () => { throw new Error("Direct forwarding was not expected."); },
        listen: async (request) => {
          expect(request).toMatchObject({ localDestinationHost: "127.0.0.1", localDestinationPort: 39471 });
          return {
            remoteHost: "127.0.0.1",
            remotePort: 41234,
            close: async () => { forwardClosed = true; }
          };
        }
      }
    };
    const scopes: Array<readonly [string, string]> = [];
    const registry = {
      list: () => [{ id: "host-a" }],
      transports: async (targetId: string, hostId: string) => {
        scopes.push([targetId, hostId]);
        return { host: {}, lease };
      }
    } as unknown as RemoteHostRegistry;
    const authorityRoot = join(fixture, "authority");
    const factory = new RemotePiProcessFactory({ registry, authorityRoot });
    const secret = "runtime-only-provider-secret";
    const nativeAuthReservationToken = "r".repeat(43);
    const productSessionId = "11111111-1111-4111-8111-111111111111";
    const recoveryIdentity = createHash("sha256")
      .update([productSessionId, "target-a", "host-a"].join("\0"))
      .digest("hex");
    const spec: PiProcessSpec = {
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--extension", managedExtension],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: recoveryIdentity,
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "bridge-token-a",
        JOKO_PI_CONTROL_FILE: control,
        JOKO_PI_MCP_DESCRIPTOR_FILE: descriptor,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        JOKO_PI_SUBAGENT_RUN_ROOT: managedRunRoot,
        JOKO_PI_PRODUCT_SESSION_ID: productSessionId,
        [MANAGED_SUBAGENT_NODE_ENV]: process.execPath,
        JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: nativeAuthReservationToken,
        PROVIDER_RUNTIME_KEY: secret
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    };

    let factoryResolved = false;
    const creating = Promise.resolve(factory.create(spec)).then((value: PiProcessHandle) => {
      factoryResolved = true;
      return value;
    });
    await waitUntil(() => remoteProcess.authorityCommits.length === 1);
    expect(factoryResolved).toBe(false);
    const [provisionalAuthorityFile] = await readdir(authorityRoot);
    expect(provisionalAuthorityFile).toMatch(/^[a-f0-9]{32}\.json$/u);
    const provisionalAuthority = JSON.parse(
      await readFile(join(authorityRoot, provisionalAuthorityFile!), "utf8")
    ) as Record<string, any>;
    expect(remoteProcess.authorityCommits[0]).toMatchObject({
      format: 1,
      identity: provisionalAuthority.authority.identity,
      epoch: provisionalAuthority.authority.epoch,
      authorityDigest: createHash("sha256")
        .update(JSON.stringify(provisionalAuthority.authority))
        .digest("hex"),
      attestation: provisionalAuthority.authority.attestation
    });
    releaseAuthorityCommit();
    const mapped = await creating;
    expect(scopes).toEqual([["target-a", "host-a"]]);
    expect(processRequest).toMatchObject({ executable: "node", cwd: "/home/maker" });
    expect(processRequest?.args).toEqual([
      `/home/maker/.joko/pi-broker/broker-${REMOTE_PI_BROKER_SOURCE_SHA256}.mjs`,
      "bridge",
      "/home/maker/.joko/pi-broker",
      expect.stringMatching(/^[a-f0-9]{32}$/u),
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.stringMatching(/^[a-f0-9-]{36}$/u)
    ]);
    expect(processRequest?.env).toEqual({ JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 });
    const bootstrap = JSON.parse(remoteProcess.input[0]!.toString("utf8")) as {
      executable: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      relay: { port: number; descriptorPath: string; descriptor: Record<string, unknown> };
      authority: { trustedRunnerScriptSha256: string };
      currentNativeAuthReservationToken: string;
    };
    expect(bootstrap).toMatchObject({ executable: "node", cwd: "/workspace" });
    expect(bootstrap.args[0]).toMatch(/^\/home\/maker\/\.joko\/runtime\/[a-f0-9]{32}\/assets\//u);
    expect(bootstrap.env.PROVIDER_RUNTIME_KEY).toBe(secret);
    expect(bootstrap.env[MANAGED_SUBAGENT_NODE_ENV]).toBe("<joko-broker-node-executable>");
    expect(bootstrap.env.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN)
      .toBe("<joko-broker-native-auth-reservation>");
    expect(bootstrap.currentNativeAuthReservationToken).toBe(nativeAuthReservationToken);
    const remoteManagedRunRoot = bootstrap.env.JOKO_PI_SUBAGENT_RUN_ROOT!;
    expect(remoteManagedRunRoot).toMatch(
      /^\/home\/maker\/\.joko\/subagent-runs\/[a-f0-9]{32}$/u
    );
    expect(remoteManagedRunRoot).not.toContain("/runtime/");
    expect(files.has(remoteManagedRunRoot)).toBe(true);
    expect(bootstrap.authority.trustedRunnerScriptSha256).toBe(
      createHash("sha256").update("module.exports = { runner: true };\n").digest("hex")
    );
    const remoteExtension = bootstrap.args[bootstrap.args.indexOf("--extension") + 1]!;
    expect(files.text(remotePath.join(remotePath.dirname(remoteExtension), MANAGED_SUBAGENT_RUNNER_FILE_NAME)))
      .toBe("module.exports = { runner: true };\n");
    expect(bootstrap.relay).toMatchObject({ port: 41234 });
    expect(bootstrap.relay.descriptor).toMatchObject({ endpoint: "http://127.0.0.1:41234/rpc" });
    expect(files.text(`/home/maker/.joko/pi-broker/broker-${REMOTE_PI_BROKER_SOURCE_SHA256}.mjs`)).not.toContain(secret);
    expect(files.allText()).not.toContain(secret);
    expect(files.allText()).not.toContain(nativeAuthReservationToken);

    const remoteControl = bootstrap.env.JOKO_PI_CONTROL_FILE!;
    mapped.stdin.write(`${JSON.stringify({ control })}\n`);
    await waitUntil(() => remoteProcess.input.some((entry, index) => index > 0 && decodeTestFrame(entry).type === 1));
    const inbound = remoteProcess.input.find((entry, index) => index > 0 && decodeTestFrame(entry).type === 1)!;
    expect(JSON.parse(decodeTestFrame(inbound).content.toString("utf8"))).toEqual({ control: remoteControl });

    const remoteSessions = bootstrap.env.PI_CODING_AGENT_SESSION_DIR!;
    await files.write({
      path: remotePath.join(remoteSessions, "session-a.jsonl"),
      content: Buffer.from('{"type":"message"}\n'),
      mode: 0o600,
      createParents: true
    });
    const output = once(mapped.stdout, "data");
    remoteProcess.stdout.write(testFrame(2, 1, Buffer.from(`${JSON.stringify({ sessionFile: remotePath.join(remoteSessions, "session-a.jsonl") })}\n`)));
    expect(JSON.parse(String((await output)[0]))).toEqual({ sessionFile: join(sessions, "session-a.jsonl") });
    remoteProcess.stdout.write(testFrame(4, 2, terminalContent(0, null)));
    remoteProcess.stdout.end();
    remoteProcess.stderr.end();

    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      mapped.once("exit", (code, signal) => resolve([code, signal]));
    });
    remoteProcess.complete(0);
    expect(await exited).toEqual([0, null]);
    expect(await readFile(join(sessions, "session-a.jsonl"), "utf8")).toBe('{"type":"message"}\n');
    expect(forwardClosed).toBe(true);
    expect(files.has(remoteControl)).toBe(true);

    const sessionKey = createHash("sha256").update(productSessionId).digest("hex").slice(0, 40);
    const store = await factory.storeFor({
      sessionId: productSessionId,
      targetId: "target-a",
      bindingOpaqueRef: join(sessions, "session-a.jsonl"),
      generation: 1
    });
    expect(store).toBeDefined();
    const scan = await store!.scan({ sessionId: productSessionId, sessionKey, limitBytes: 256 * 1024 });
    expect(scan).toMatchObject({ unchanged: false, retryAfterMs: 1_000 });
    expect(scan.runs).toHaveLength(1);
    expect(scan.runs[0]).toMatchObject({ resumeSafe: true, controlSafe: true });
    const tail = await store!.readTail({
      sessionId: productSessionId,
      runId: scan.runs[0]!.runId,
      runnerInstanceId: scan.runs[0]!.runnerInstanceId,
      artifactRevision: scan.runs[0]!.transcriptRevision,
      pathKind: "transcript",
      offset: 0,
      maxBytes: 1024
    });
    expect(Buffer.from(tail.content).toString("utf8")).toBe("entry\n");
    await store!.writeControl({
      sessionId: productSessionId,
      runId: scan.runs[0]!.runId,
      runnerInstanceId: scan.runs[0]!.runnerInstanceId,
      launchToken: scan.runs[0]!.launchToken,
      runnerScriptSha256: scan.runs[0]!.runnerScriptSha256,
      expectedControlRevision: scan.runs[0]!.controlRevision,
      kind: "control",
      value: { format: 1, action: "stop" }
    });
    await store!.dispose();

    const restartedFactory = new RemotePiProcessFactory({ registry, authorityRoot });
    const rediscovered = await restartedFactory.storeFor({
      sessionId: productSessionId,
      targetId: "target-a",
      bindingOpaqueRef: join(sessions, "session-a.jsonl"),
      generation: 2
    });
    expect(rediscovered).toBeDefined();
    expect(await rediscovered!.scan({
      sessionId: productSessionId,
      sessionKey,
      afterRevision: scan.revision,
      limitBytes: 256 * 1024
    })).toMatchObject({ revision: scan.revision, unchanged: true, runs: [] });
    const removal = await rediscovered!.stopAndRemoveSession({
      sessionId: productSessionId,
      sessionKey,
      timeoutMs: 5_000
    });
    expect(removal).toEqual({
      terminalRunIds: [MANAGED_STORE_RUN_ID],
      removed: true,
      deletionReceipt: MANAGED_STORE_DELETION_RECEIPT
    });
    await rediscovered!.finalizeDeletion({
      sessionId: productSessionId,
      sessionKey,
      deletionReceipt: MANAGED_STORE_DELETION_RECEIPT
    });
    const initiallyFinalizedAuthority = JSON.parse(
      await readFile(join(authorityRoot, provisionalAuthorityFile!), "utf8")
    ) as Record<string, any>;
    const finalizedFactory = new RemotePiProcessFactory({ registry, authorityRoot });
    const finalizedStore = await finalizedFactory.storeFor({
      sessionId: productSessionId,
      targetId: "target-a",
      bindingOpaqueRef: join(sessions, "session-a.jsonl"),
      generation: 2
    });
    expect(finalizedStore).toBeDefined();
    await finalizedStore!.finalizeDeletion({
      sessionId: productSessionId,
      sessionKey,
      deletionReceipt: MANAGED_STORE_DELETION_RECEIPT
    });
    const finalizedAuthority = JSON.parse(
      await readFile(join(authorityRoot, provisionalAuthorityFile!), "utf8")
    ) as Record<string, any>;
    expect(finalizedAuthority.deletion).toMatchObject({
      format: 1,
      receipt: MANAGED_STORE_DELETION_RECEIPT,
      finalizedAt: initiallyFinalizedAuthority.deletion.finalizedAt
    });
    expect(finalizedAuthority).not.toHaveProperty("currentBearer");
    expect(JSON.stringify(finalizedAuthority)).not.toContain(nativeAuthReservationToken);
    expect(managedStoreOperations.map((value) => value.operation)).toEqual([
      "scan", "read-tail", "write-control", "scan", "stop-remove-session",
      "finalize-deletion", "finalize-deletion"
    ]);
    expect(managedStoreOperations.every((value) =>
      value.action === "managed-store" && value.identity === provisionalAuthority.authority.identity
      && (value.authority as Record<string, unknown>).attestation === provisionalAuthority.authority.attestation
    )).toBe(true);
    expect(JSON.stringify(managedStoreOperations)).not.toContain(secret);
    expect(JSON.stringify(managedStoreOperations)).not.toContain("bridge-token-a");
  });

  it("fails closed when process, file, or forwarding capabilities are absent", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-capabilities-"));
    temporaryDirectories.push(fixture);
    const registry = {
      transports: async () => ({
        host: {},
        lease: {
          capabilities: {
            commandExecution: true,
            processStreaming: false,
            fileTransfer: false,
            tcpForwarding: false
          }
        }
      })
    } as unknown as RemoteHostRegistry;
    const factory = new RemotePiProcessFactory({ registry, authorityRoot: join(fixture, "authority") });
    await expect(factory.validate("target-a", "host-a", "/workspace")).rejects.toThrow("file transport is unavailable");
  });

  it("stages immutable snapshots when local launch assets and a resumed session mutate during transfer", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-snapshot-"));
    temporaryDirectories.push(fixture);
    const runtime = join(fixture, "runtime");
    const sessions = join(fixture, "sessions");
    await Promise.all([mkdir(runtime, { recursive: true }), mkdir(sessions, { recursive: true })]);
    const control = join(runtime, "control.json");
    const cli = join(fixture, "pi-cli.mjs");
    const nativeSession = join(sessions, "native.jsonl");
    await Promise.all([
      writeFile(control, JSON.stringify({ generation: 1 }), { mode: 0o600 }),
      writeFile(cli, "export const snapshot = 'original';\n", { mode: 0o600 }),
      writeFile(nativeSession, '{"type":"session","snapshot":"original"}\n', { mode: 0o600 })
    ]);
    let mutated = false;
    const files = new PiMemoryRemoteFiles(async (request) => {
      if (mutated || !request.path.endsWith("pi-cli.mjs")) return;
      mutated = true;
      await Promise.all([
        writeFile(cli, "export const snapshot = 'mutated';\n", { mode: 0o600 }),
        writeFile(nativeSession, '{"type":"session","snapshot":"mutated"}\n', { mode: 0o600 })
      ]);
    });
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const bridge = new ManualRemoteProcess();
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: false
      },
      files,
      processes: { open: async () => bridge }
    };
    const registry = {
      transports: async () => ({ host: {}, lease })
    } as unknown as RemoteHostRegistry;
    const mapped = await new RemotePiProcessFactory({
      registry,
      authorityRoot: join(fixture, "authority")
    }).create({
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--session", nativeSession],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: "b".repeat(64),
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "bridge-token-a",
        JOKO_PI_CONTROL_FILE: control,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });
    const bootstrap = JSON.parse(bridge.input[0]!.toString("utf8")) as Record<string, any>;
    const sessionIndex = bootstrap.args.indexOf("--session");
    expect(mutated).toBe(true);
    expect(files.text(bootstrap.args[0])).toBe("export const snapshot = 'original';\n");
    expect(files.text(bootstrap.args[sessionIndex + 1])).toBe(
      '{"type":"session","snapshot":"original"}\n'
    );
    expect(files.readPaths).toContain(bootstrap.args[0]);
    expect(files.readPaths).toContain(bootstrap.args[sessionIndex + 1]);
    expect(await readFile(cli, "utf8")).toContain("mutated");
    expect(await readFile(nativeSession, "utf8")).toContain("mutated");

    const terminal = new Promise<void>((resolveExit) => mapped.once("exit", () => resolveExit()));
    bridge.stdout.write(testFrame(4, 1, terminalContent(0, null)));
    bridge.complete(0);
    await terminal;
  });

  it("reattaches after an unexpected SSH bridge exit and publishes the remote terminal once", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-reconnect-"));
    temporaryDirectories.push(fixture);
    const runtime = join(fixture, "runtime");
    const sessions = join(fixture, "sessions");
    await mkdir(runtime, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const control = join(runtime, "control.json");
    const descriptor = join(runtime, "mcp.json");
    const cli = join(fixture, "pi-cli.mjs");
    await writeFile(control, JSON.stringify({ generation: 1 }), { mode: 0o600 });
    await writeFile(descriptor, JSON.stringify({ endpoint: "http://127.0.0.1:39471/rpc" }), { mode: 0o600 });
    await writeFile(cli, "export {};", { mode: 0o600 });

    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const bridges = [new ManualRemoteProcess(), new ManualRemoteProcess()];
    const requests: RemoteProcessStartRequest[] = [];
    let transportCall = 0;
    let forwardCloseCount = 0;
    const leaseFor = (bridge: ManualRemoteProcess): RemoteSshTransportLease => ({
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: true
      },
      files,
      processes: {
        open: async (request) => {
          requests.push(request);
          return bridge;
        }
      },
      forwarding: {
        open: async () => { throw new Error("Direct forwarding was not expected."); },
        listen: async () => ({
          remoteHost: "127.0.0.1",
          remotePort: 41_000 + transportCall,
          close: async () => { forwardCloseCount += 1; }
        })
      }
    });
    const registry = {
      transports: async () => {
        const index = Math.min(transportCall, bridges.length - 1);
        transportCall += 1;
        return { host: {}, lease: leaseFor(bridges[index]!) };
      }
    } as unknown as RemoteHostRegistry;
    const factory = new RemotePiProcessFactory({ registry, authorityRoot: join(fixture, "authority") });
    const mapped = await factory.create({
      command: process.execPath,
      args: [cli, "--mode", "rpc"],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: "b".repeat(64),
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "bridge-token-a",
        JOKO_PI_CONTROL_FILE: control,
        JOKO_PI_MCP_DESCRIPTOR_FILE: descriptor,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });

    const output: string[] = [];
    mapped.stdout.on("data", (chunk: Buffer | string) => output.push(String(chunk)));
    bridges[0]!.stdout.write(testFrame(2, 1, Buffer.from('{"phase":"before"}\n')));
    const splitLine = Buffer.from('{"phase":"半line"}\n', "utf8");
    const splitAt = splitLine.indexOf(Buffer.from("半", "utf8")) + 1;
    bridges[0]!.stdout.write(testFrame(2, 2, splitLine.subarray(0, splitAt)));
    mapped.stdin.write('{"type":"uncertain"}\n');
    await waitUntil(() => bridges[0]!.input.some((entry, index) => index > 0 && decodeTestFrame(entry).type === 1));
    const uncertainFirst = bridges[0]!.input.find((entry, index) => index > 0 && decodeTestFrame(entry).type === 1)!;
    bridges[0]!.complete(75);
    await waitUntil(() => bridges[1]!.input.length > 0);
    const firstBootstrap = JSON.parse(bridges[0]!.input[0]!.toString("utf8")) as {
      launchHash: string;
      relay: { port: number };
    };
    const secondBootstrap = JSON.parse(bridges[1]!.input[0]!.toString("utf8")) as {
      launchHash: string;
      relay: { port: number };
    };
    expect(secondBootstrap.launchHash).toBe(firstBootstrap.launchHash);
    expect(secondBootstrap.relay.port).not.toBe(firstBootstrap.relay.port);

    await waitUntil(() => bridges[1]!.input.some((entry, index) => index > 0 && decodeTestFrame(entry).type === 1));
    const uncertainReplay = bridges[1]!.input.find((entry, index) => index > 0 && decodeTestFrame(entry).type === 1)!;
    expect(decodeTestFrame(uncertainReplay)).toEqual(decodeTestFrame(uncertainFirst));
    bridges[1]!.stdout.write(testFrame(2, 1, Buffer.from('{"phase":"before"}\n')));
    bridges[1]!.stdout.write(testFrame(2, 2, splitLine.subarray(0, splitAt)));
    bridges[1]!.stdout.write(testFrame(7, 1));
    bridges[1]!.stdout.write(testFrame(2, 3, splitLine.subarray(splitAt)));
    mapped.stdin.write('{"type":"continue"}\n');
    await waitUntil(() => bridges[1]!.input.filter((entry, index) => index > 0 && decodeTestFrame(entry).type === 1).length > 1);
    const continued = bridges[1]!.input.filter((entry, index) => index > 0 && decodeTestFrame(entry).type === 1).at(-1)!;
    expect(decodeTestFrame(continued).content.toString("utf8")).toBe('{"type":"continue"}\n');
    bridges[1]!.stdout.write(testFrame(7, 2));

    let exits = 0;
    const terminal = new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
      mapped.on("exit", (code, signal) => {
        exits += 1;
        resolveExit([code, signal]);
      });
    });
    bridges[1]!.stdout.write(testFrame(4, 4, terminalContent(0, null)));
    bridges[1]!.complete(0);
    expect(await terminal).toEqual([0, null]);
    await new Promise((resolveWait) => setImmediate(resolveWait));
    expect(exits).toBe(1);
    expect(output.join("").match(/"phase":"before"/gu)).toHaveLength(1);
    expect(output.join("")).toContain('"phase":"半line"');
    expect(requests).toHaveLength(2);
    expect(forwardCloseCount).toBe(2);
  });

  it("recovers one attested child across service factories without replaying consumed output or input", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-service-recovery-"));
    temporaryDirectories.push(fixture);
    const runtimeOne = join(fixture, "runtime-one");
    const runtimeTwo = join(fixture, "runtime-two");
    const agentHomeOne = join(runtimeOne, "agent-home");
    const agentHomeTwo = join(runtimeTwo, "agent-home");
    const sessions = join(fixture, "sessions");
    await Promise.all([
      mkdir(agentHomeOne, { recursive: true }),
      mkdir(agentHomeTwo, { recursive: true }),
      mkdir(sessions, { recursive: true })
    ]);
    const controlOne = join(runtimeOne, "control.json");
    const controlTwo = join(runtimeTwo, "control.json");
    const cli = join(fixture, "pi-cli.mjs");
    const nativeSession = join(sessions, "native.jsonl");
    await Promise.all([
      writeFile(controlOne, JSON.stringify({ generation: 1 }), { mode: 0o600 }),
      writeFile(controlTwo, JSON.stringify({ generation: 2 }), { mode: 0o600 }),
      writeFile(cli, "export {};", { mode: 0o600 }),
      writeFile(nativeSession, '{"type":"session"}\n', { mode: 0o600 }),
      ...[agentHomeOne, agentHomeTwo].flatMap((agentHome) => [
        writeFile(join(agentHome, "models.json"), '{"providers":[]}\n', { mode: 0o600 }),
        writeFile(join(agentHome, "settings.json"), '{"theme":"dark"}\n', { mode: 0o600 })
      ])
    ]);

    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const firstBridge = new ManualRemoteProcess({ clockOffsetMs: 6 * 60 * 60 * 1_000 });
    const secondBridge = new ManualRemoteProcess({
      inputAcknowledged: 1,
      outputSequence: 2,
      recoveryOutputHighWater: 2,
      clockOffsetMs: -6 * 60 * 60 * 1_000
    });
    const bridges = [firstBridge, secondBridge];
    const requests: RemoteProcessStartRequest[] = [];
    let opened = 0;
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: false
      },
      files,
      processes: {
        open: async (request) => {
          requests.push(request);
          return bridges[Math.min(opened++, bridges.length - 1)]!;
        }
      }
    };
    const registry = {
      transports: async () => ({ host: {}, lease })
    } as unknown as RemoteHostRegistry;
    const authorityRoot = join(fixture, "authority");
    const recoveryIdentity = "b".repeat(64);
    const first = await new RemotePiProcessFactory({ registry, authorityRoot }).create({
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--session-dir", sessions, "--session-id", "native-g1"],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: recoveryIdentity,
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "service-bearer-one",
        JOKO_PI_CONTROL_FILE: controlOne,
        PI_CODING_AGENT_DIR: agentHomeOne,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });
    const firstOutput = once(first.stdout, "data");
    firstBridge.stdout.write(testFrame(2, 1, Buffer.from('{"phase":"consumed"}\n')));
    expect(String((await firstOutput)[0])).toContain('"phase":"consumed"');
    await waitUntil(() => firstBridge.input.some((entry, index) =>
      index > 0 && decodeTestFrame(entry).type === 6 && decodeTestFrame(entry).sequence === 1));
    first.stdin.write('{"type":"first-input"}\n');
    await waitUntil(() => firstBridge.input.some((entry, index) =>
      index > 0 && decodeTestFrame(entry).type === 1));
    firstBridge.stdout.write(testFrame(7, 1));
    await writeFile(nativeSession, '{"type":"session"}\n{"type":"message"}\n', { mode: 0o600 });

    const secondSpec: PiProcessSpec = {
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--session-dir", sessions, "--session", nativeSession],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "f".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: recoveryIdentity,
        JOKO_PI_GENERATION: "2",
        JOKO_PI_MCP_TOKEN: "service-bearer-two",
        JOKO_PI_CONTROL_FILE: controlTwo,
        PI_CODING_AGENT_DIR: agentHomeTwo,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    };
    const [authorityFile] = await readdir(authorityRoot);
    const authorityLink = join(fixture, "linked-authority.json");
    await link(join(authorityRoot, authorityFile!), authorityLink);
    await expect(
      new RemotePiProcessFactory({ registry, authorityRoot }).create(secondSpec)
    ).rejects.toThrow("not a regular file");
    await unlink(authorityLink);
    const authorityPath = join(authorityRoot, authorityFile!);
    const clockRollbackRecord = JSON.parse(await readFile(authorityPath, "utf8")) as Record<string, unknown>;
    clockRollbackRecord.updatedAt = Date.now() + 6 * 60 * 60 * 1_000;
    await writeFile(authorityPath, `${JSON.stringify(clockRollbackRecord)}\n`, { mode: 0o600 });

    const second = await new RemotePiProcessFactory({ registry, authorityRoot }).create(secondSpec);
    expect((second as { readonly serviceRecovery?: unknown }).serviceRecovery).toEqual({ required: true });
    const firstBootstrap = JSON.parse(firstBridge.input[0]!.toString("utf8")) as Record<string, any>;
    const secondBootstrap = JSON.parse(secondBridge.input[0]!.toString("utf8")) as Record<string, any>;
    expect(requests[1]?.args[3]).toBe(requests[0]?.args[3]);
    expect(secondBootstrap.authority.compatibilityHash).toBe(firstBootstrap.authority.compatibilityHash);
    expect(secondBootstrap.authority.candidateProcessLaunchHash)
      .not.toBe(firstBootstrap.authority.candidateProcessLaunchHash);
    expect(secondBootstrap.authority.recovery.childProcessLaunchHash)
      .toBe(firstBootstrap.authority.candidateProcessLaunchHash);
    expect(secondBootstrap.authority.recovery.startedAt).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1_000);
    expect(secondBootstrap.env.JOKO_PI_MCP_TOKEN).toBe("service-bearer-two");

    const recoveredOutput: string[] = [];
    second.stdout.on("data", (chunk: Buffer | string) => recoveredOutput.push(String(chunk)));
    secondBridge.stdout.write(testFrame(2, 1, Buffer.from('{"phase":"consumed"}\n')));
    secondBridge.stdout.write(testFrame(2, 2, Buffer.from('{"type":"response","id":"old"}\n')));
    secondBridge.stdout.write(testFrame(2, 3, Buffer.from('{"phase":"current"}\n')));
    await waitUntil(() => recoveredOutput.join("").includes('"phase":"current"'));
    await waitUntil(() => secondBridge.input.some((entry, index) =>
      index > 0 && decodeTestFrame(entry).type === 6 && decodeTestFrame(entry).sequence === 3));
    expect(recoveredOutput.join("")).not.toContain('"phase":"consumed"');
    expect(recoveredOutput.join("")).not.toContain('"id":"old"');
    second.stdin.write('{"type":"next-input"}\n');
    await waitUntil(() => secondBridge.input.some((entry, index) =>
      index > 0 && decodeTestFrame(entry).type === 1));
    const nextInput = secondBridge.input.find((entry, index) => index > 0 && decodeTestFrame(entry).type === 1)!;
    expect(decodeTestFrame(nextInput).sequence).toBe(2);

    const authorityFiles = await readdir(authorityRoot);
    expect(authorityFiles).toHaveLength(1);
    const authorityText = await readFile(join(authorityRoot, authorityFiles[0]!), "utf8");
    expect(authorityText).not.toContain("service-bearer-one");
    expect(authorityText).not.toContain("service-bearer-two");
    const persistedAuthority = JSON.parse(authorityText) as Record<string, any>;
    expect(persistedAuthority).toMatchObject({
      authority: {
        pid: 4242,
        processStartIdentity: "c".repeat(64),
        childProcessLaunchHash: firstBootstrap.authority.candidateProcessLaunchHash,
        runtimeGeneration: 2,
        epoch: 2,
        issuedAt: expect.any(Number)
      },
      outputCursor: 3
    });
    expect(persistedAuthority.authority.issuedAt).toBeLessThan(Date.now() - 5 * 60 * 60 * 1_000);

    let exits = 0;
    const terminal = new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
      second.on("exit", (code, signal) => {
        exits += 1;
        resolveExit([code, signal]);
      });
    });
    secondBridge.stdout.write(testFrame(4, 4, terminalContent(0, null)));
    secondBridge.complete(0);
    expect(await terminal).toEqual([0, null]);
    expect(exits).toBe(1);
    const firstTerminal = new Promise<void>((resolveExit) => {
      first.once("exit", () => resolveExit());
    });
    firstBridge.stdout.write(testFrame(4, 2, terminalContent(0, null)));
    firstBridge.complete(0);
    await firstTerminal;
  });

  it("replaces a verified absent child once without sending a stale kill", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-absent-child-"));
    temporaryDirectories.push(fixture);
    const runtimeOne = join(fixture, "runtime-one");
    const runtimeTwo = join(fixture, "runtime-two");
    const sessions = join(fixture, "sessions");
    await Promise.all([
      mkdir(runtimeOne, { recursive: true }),
      mkdir(runtimeTwo, { recursive: true }),
      mkdir(sessions, { recursive: true })
    ]);
    const controlOne = join(runtimeOne, "control.json");
    const controlTwo = join(runtimeTwo, "control.json");
    const cli = join(fixture, "pi-cli.mjs");
    const nativeSession = join(sessions, "native.jsonl");
    await Promise.all([
      writeFile(controlOne, JSON.stringify({ generation: 1 }), { mode: 0o600 }),
      writeFile(controlTwo, JSON.stringify({ generation: 2 }), { mode: 0o600 }),
      writeFile(cli, "export {};", { mode: 0o600 }),
      writeFile(nativeSession, '{"type":"session"}\n', { mode: 0o600 })
    ]);

    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const initialBridge = new ManualRemoteProcess();
    const absentBridge = new ManualRemoteProcess({ recoveryRejection: "child_absent" });
    const freshBridge = new ManualRemoteProcess();
    const bridges = [initialBridge, absentBridge, freshBridge];
    const requests: RemoteProcessStartRequest[] = [];
    let bridgeIndex = 0;
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: false
      },
      files,
      processes: {
        open: async (request) => {
          requests.push(request);
          if (request.args[1] === "kill") throw new Error("A stale child must not receive a kill request.");
          return bridges[bridgeIndex++]!;
        }
      }
    };
    const registry = {
      transports: async () => ({ host: {}, lease })
    } as unknown as RemoteHostRegistry;
    const authorityRoot = join(fixture, "authority");
    const recoveryIdentity = "b".repeat(64);
    const first = await new RemotePiProcessFactory({ registry, authorityRoot }).create({
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--session-id", "native-g1"],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: recoveryIdentity,
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "service-bearer-one",
        JOKO_PI_CONTROL_FILE: controlOne,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });

    const second = await new RemotePiProcessFactory({ registry, authorityRoot }).create({
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--session", nativeSession],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "f".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: recoveryIdentity,
        JOKO_PI_GENERATION: "2",
        JOKO_PI_MCP_TOKEN: "service-bearer-two",
        JOKO_PI_CONTROL_FILE: controlTwo,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });
    expect(bridgeIndex).toBe(3);
    expect(requests.filter((request) => request.args[1] === "kill")).toHaveLength(0);
    const rejected = JSON.parse(absentBridge.input[0]!.toString("utf8")) as Record<string, any>;
    const fresh = JSON.parse(freshBridge.input[0]!.toString("utf8")) as Record<string, any>;
    expect(rejected.authority.recovery).toMatchObject({ runtimeGeneration: 1, pid: 4242 });
    expect(fresh.authority).not.toHaveProperty("recovery");
    const [authorityFile] = await readdir(authorityRoot);
    expect(JSON.parse(await readFile(join(authorityRoot, authorityFile!), "utf8"))).toMatchObject({
      authority: { runtimeGeneration: 2, epoch: 1, pid: 4242 }
    });

    const firstTerminal = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    initialBridge.stdout.write(testFrame(4, 1, terminalContent(0, null)));
    initialBridge.complete(0);
    await firstTerminal;
    const secondTerminal = new Promise<void>((resolveExit) => second.once("exit", () => resolveExit()));
    freshBridge.stdout.write(testFrame(4, 1, terminalContent(0, null)));
    freshBridge.complete(0);
    await secondTerminal;
  });

  it("orders a verified restart when an otherwise stable absolute launch resource changes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-resource-restart-"));
    temporaryDirectories.push(fixture);
    const runtimeOne = join(fixture, "runtime-one");
    const runtimeTwo = join(fixture, "runtime-two");
    const sessions = join(fixture, "sessions");
    await Promise.all([
      mkdir(runtimeOne, { recursive: true }),
      mkdir(runtimeTwo, { recursive: true }),
      mkdir(sessions, { recursive: true })
    ]);
    const controlOne = join(runtimeOne, "control.json");
    const controlTwo = join(runtimeTwo, "control.json");
    const resourceOne = join(runtimeOne, "launch-resource.json");
    const resourceTwo = join(runtimeTwo, "launch-resource.json");
    const cli = join(fixture, "pi-cli.mjs");
    await Promise.all([
      writeFile(controlOne, JSON.stringify({ generation: 1 }), { mode: 0o600 }),
      writeFile(controlTwo, JSON.stringify({ generation: 2 }), { mode: 0o600 }),
      writeFile(resourceOne, '{"shape":"one"}\n', { mode: 0o600 }),
      writeFile(resourceTwo, '{"shape":"two"}\n', { mode: 0o600 }),
      writeFile(cli, "export {};", { mode: 0o600 })
    ]);

    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const initialBridge = new ManualRemoteProcess();
    const mismatchBridge = new ManualRemoteProcess({ recoveryRejection: "launch_mismatch" });
    const killRequest = new ManualRemoteProcess();
    const freshBridge = new ManualRemoteProcess();
    const bridges = [initialBridge, mismatchBridge, freshBridge];
    const requests: RemoteProcessStartRequest[] = [];
    let bridgeIndex = 0;
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: false
      },
      files,
      processes: {
        open: async (request) => {
          requests.push(request);
          return request.args[1] === "kill" ? killRequest : bridges[bridgeIndex++]!;
        }
      }
    };
    const registry = {
      transports: async () => ({ host: {}, lease })
    } as unknown as RemoteHostRegistry;
    const authorityRoot = join(fixture, "authority");
    const recoveryIdentity = "b".repeat(64);
    const spec = (generation: number, control: string, resource: string): PiProcessSpec => ({
      command: process.execPath,
      args: [cli, "--mode", "rpc", "--launch-resource", resource],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: (generation === 1 ? "a" : "f").repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: recoveryIdentity,
        JOKO_PI_GENERATION: String(generation),
        JOKO_PI_MCP_TOKEN: `service-bearer-${generation}`,
        JOKO_PI_CONTROL_FILE: control,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });

    const first = await new RemotePiProcessFactory({ registry, authorityRoot })
      .create(spec(1, controlOne, resourceOne));
    const second = await new RemotePiProcessFactory({ registry, authorityRoot })
      .create(spec(2, controlTwo, resourceTwo));
    const initial = JSON.parse(initialBridge.input[0]!.toString("utf8")) as Record<string, any>;
    const rejected = JSON.parse(mismatchBridge.input[0]!.toString("utf8")) as Record<string, any>;
    const fresh = JSON.parse(freshBridge.input[0]!.toString("utf8")) as Record<string, any>;
    expect(initial.authority.compatibilityHash).not.toBe(rejected.authority.compatibilityHash);
    expect(JSON.parse(killRequest.input[0]!.toString("utf8"))).toMatchObject({
      action: "kill",
      authority: { compatibilityHash: initial.authority.compatibilityHash }
    });
    expect(fresh.authority).not.toHaveProperty("recovery");
    expect(files.text(fresh.args[fresh.args.indexOf("--launch-resource") + 1]))
      .toBe('{"shape":"two"}\n');
    expect(bridgeIndex).toBe(3);
    expect(requests.filter((request) => request.args[1] === "kill")).toHaveLength(1);

    const firstTerminal = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    initialBridge.stdout.write(testFrame(4, 1, terminalContent(0, null)));
    initialBridge.complete(0);
    await firstTerminal;
    const secondTerminal = new Promise<void>((resolveExit) => second.once("exit", () => resolveExit()));
    freshBridge.stdout.write(testFrame(4, 1, terminalContent(0, null)));
    freshBridge.complete(0);
    await secondTerminal;
  });

  it("routes explicit termination to the broker-owned child identity", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-kill-"));
    temporaryDirectories.push(fixture);
    const runtime = join(fixture, "runtime");
    const sessions = join(fixture, "sessions");
    await mkdir(runtime, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const control = join(runtime, "control.json");
    const cli = join(fixture, "pi-cli.mjs");
    await writeFile(control, JSON.stringify({ generation: 1 }), { mode: 0o600 });
    await writeFile(cli, "export {};", { mode: 0o600 });
    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const bridge = new SignalOnlyRemoteProcess();
    const auxiliary = new ManualRemoteProcess();
    const requests: RemoteProcessStartRequest[] = [];
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: false
      },
      files,
      processes: {
        open: async (request) => {
          requests.push(request);
          return request.args[1] === "kill" ? auxiliary : bridge;
        }
      }
    };
    const registry = {
      transports: async () => ({ host: {}, lease })
    } as unknown as RemoteHostRegistry;
    const mapped = await new RemotePiProcessFactory({ registry, authorityRoot: join(fixture, "authority") }).create({
      command: process.execPath,
      args: [cli, "--mode", "rpc"],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: "b".repeat(64),
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "bridge-token-a",
        JOKO_PI_CONTROL_FILE: control,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });
    expect(mapped.kill("SIGKILL")).toBe(true);
    await waitUntil(() => requests.length === 2);
    expect(requests[1]?.args.slice(1)).toEqual([
      "kill",
      "/home/maker/.joko/pi-broker"
    ]);
    expect(JSON.parse(auxiliary.input[0]!.toString("utf8"))).toMatchObject({
      action: "kill",
      signal: "SIGKILL",
      identity: expect.stringMatching(/^[a-f0-9]{32}$/u),
      authority: { processStartIdentity: "c".repeat(64) }
    });
    expect(bridge.signals).toEqual(["SIGKILL"]);
    const terminal = new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
      mapped.once("exit", (code, signal) => resolveExit([code, signal]));
    });
    bridge.stdout.write(testFrame(4, 1, terminalContent(null, "SIGKILL")));
    bridge.complete(null, "SIGKILL");
    expect(await terminal).toEqual([null, "SIGKILL"]);
  });

  it.each([
    ["an output sequence gap", () => testFrame(2, 2, Buffer.from("skipped\n"))],
    ["a forged input acknowledgement", () => testFrame(7, 1)],
    ["an oversized frame declaration", () => oversizedTestFrameHeader()]
  ])("fails the attachment closed on %s", async (_label, maliciousFrame) => {
    const fixture = await mkdtemp(join(tmpdir(), "joko-remote-pi-invalid-frame-"));
    temporaryDirectories.push(fixture);
    const runtime = join(fixture, "runtime");
    const sessions = join(fixture, "sessions");
    await mkdir(runtime, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const control = join(runtime, "control.json");
    const cli = join(fixture, "pi-cli.mjs");
    await writeFile(control, JSON.stringify({ generation: 1 }), { mode: 0o600 });
    await writeFile(cli, "export {};", { mode: 0o600 });
    const files = new PiMemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.mkdir("/home/maker", { recursive: true });
    const first = new SignalOnlyRemoteProcess();
    const auxiliary = new ManualRemoteProcess();
    let transportCall = 0;
    const registry = {
      transports: async () => {
        transportCall += 1;
        return {
          host: {},
          lease: {
            capabilities: {
              commandExecution: true,
              processStreaming: true,
              fileTransfer: true,
              tcpForwarding: false
            },
            files,
            processes: {
              open: async (request) => request.args[1] === "kill" ? auxiliary : first
            }
          } satisfies RemoteSshTransportLease
        };
      }
    } as unknown as RemoteHostRegistry;
    const mapped = await new RemotePiProcessFactory({ registry, authorityRoot: join(fixture, "authority") }).create({
      command: process.execPath,
      args: [cli, "--mode", "rpc"],
      cwd: "/workspace",
      env: {
        JOKO_PI_TARGET_ID: "target-a",
        JOKO_PI_SPAWN_IDENTITY: "a".repeat(64),
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: "b".repeat(64),
        JOKO_PI_GENERATION: "1",
        JOKO_PI_MCP_TOKEN: "bridge-token-a",
        JOKO_PI_CONTROL_FILE: control,
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" }
    });
    const terminal = new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) => {
      mapped.once("exit", (code, signal) => resolveExit([code, signal]));
    });
    first.stdout.write(maliciousFrame());
    expect(await terminal).toEqual([1, null]);
    expect(first.signals).toContain("SIGKILL");
    expect(transportCall).toBe(1);
  });
});

function terminalContent(code: number | null, signal: NodeJS.Signals | null): Buffer {
  return Buffer.from(JSON.stringify({ code, signal }), "utf8");
}

function testFrame(type: number, sequence: number, content: Uint8Array = Buffer.alloc(0)): Buffer {
  const acceptedContent = Buffer.from(content);
  const frame = Buffer.allocUnsafe(13 + acceptedContent.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(acceptedContent.byteLength + 8, 1);
  frame.writeBigUInt64BE(BigInt(sequence), 5);
  acceptedContent.copy(frame, 13);
  return frame;
}

function testControlFrame(type: number, value: unknown): Buffer {
  const content = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(5 + content.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(content.byteLength, 1);
  content.copy(frame, 5);
  return frame;
}

function decodeTestFrame(frame: Buffer): { readonly type: number; readonly sequence: number; readonly content: Buffer } {
  const length = frame.readUInt32BE(1);
  if (frame.byteLength !== length + 5 || length < 8) throw new Error("Invalid test frame.");
  return {
    type: frame.readUInt8(0),
    sequence: Number(frame.readBigUInt64BE(5)),
    content: frame.subarray(13)
  };
}

function oversizedTestFrameHeader(): Buffer {
  const frame = Buffer.alloc(5);
  frame.writeUInt8(2, 0);
  frame.writeUInt32BE(64 * 1024 * 1024 + 1, 1);
  return frame;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for remote bridge state.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

type PiMemoryEntry =
  | { kind: "directory"; mode: number; modifiedAt: number }
  | { kind: "file"; mode: number; modifiedAt: number; content: Buffer };

const MANAGED_STORE_RUN_ID = "22222222-2222-4222-8222-222222222222";
const MANAGED_STORE_RUNNER_ID = "33333333-3333-4333-8333-333333333333";
const MANAGED_STORE_LAUNCH_TOKEN = "44444444-4444-4444-8444-444444444444";
const MANAGED_STORE_SCRIPT_HASH = "5".repeat(64);
const MANAGED_STORE_RUN_REVISION = "6".repeat(64);
const MANAGED_STORE_REVISION = "7".repeat(64);
const MANAGED_STORE_DELETION_RECEIPT = "9".repeat(64);

class ManagedStoreRemoteProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #pending = Buffer.alloc(0);

  constructor(readonly operations: Record<string, unknown>[]) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
      const newline = this.#pending.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(this.#pending.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      this.operations.push(request);
      const operation = request.operation;
      let response: Record<string, unknown>;
      if (operation === "scan") {
        const identity = {
          runId: MANAGED_STORE_RUN_ID,
          runnerInstanceId: MANAGED_STORE_RUNNER_ID,
          launchToken: MANAGED_STORE_LAUNCH_TOKEN,
          runnerScriptSha256: MANAGED_STORE_SCRIPT_HASH
        };
        response = {
          ok: true,
          authorityVerified: true,
          revision: MANAGED_STORE_REVISION,
          unchanged: request.afterRevision === MANAGED_STORE_REVISION,
          retryAfterMs: 1_000,
          runs: request.afterRevision === MANAGED_STORE_REVISION ? [] : [{
            ...identity,
            revision: MANAGED_STORE_RUN_REVISION,
            controlRevision: MANAGED_STORE_RUN_REVISION,
            transcriptRevision: MANAGED_STORE_RUN_REVISION,
            resultRevision: MANAGED_STORE_RUN_REVISION,
            config: { ...identity },
            status: { ...identity },
            owner: { ...identity },
            transcriptBytes: 6,
            resultBytes: 0,
            resumeSafe: true,
            controlSafe: true
          }]
        };
      } else if (operation === "read-tail") {
        response = {
          ok: true,
          authorityVerified: true,
          artifactRevision: MANAGED_STORE_RUN_REVISION,
          offset: 0,
          nextOffset: 6,
          eof: true,
          content: Buffer.from("entry\n").toString("base64")
        };
      } else if (operation === "write-control") {
        response = {
          ok: true,
          authorityVerified: true,
          controlRevision: MANAGED_STORE_RUN_REVISION,
          receipt: "8".repeat(64)
        };
      } else if (operation === "stop-remove-session") {
        response = {
          ok: true,
          authorityVerified: true,
          terminalRunIds: [MANAGED_STORE_RUN_ID],
          removed: true,
          deletionReceipt: MANAGED_STORE_DELETION_RECEIPT
        };
      } else if (operation === "finalize-deletion") {
        response = {
          ok: true,
          authorityVerified: true,
          finalized: true,
          deletionReceipt: MANAGED_STORE_DELETION_RECEIPT
        };
      } else {
        response = { ok: false };
      }
      this.stdout.end(`${JSON.stringify(response)}\n`);
      this.stderr.end();
      queueMicrotask(() => this.complete(0));
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.complete(null, signal === "SIGTERM" ? "SIGTERM" : "SIGKILL");
    return true;
  }

  private complete(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

class PiMemoryRemoteFiles implements RemoteFileTransportPort {
  readonly #entries = new Map<string, PiMemoryEntry>();
  readonly readPaths: string[] = [];
  #clock = 1;

  constructor(
    readonly beforeWrite?: (request: RemoteFileWriteRequest) => void | Promise<void>
  ) {}

  async realpath(path: string): Promise<string> {
    const accepted = path === "." ? "/home/maker" : normalizeRemote(path);
    this.require(accepted);
    return accepted;
  }

  async stat(path: string): Promise<RemoteFileStat> {
    const entry = this.require(normalizeRemote(path));
    return {
      kind: entry.kind,
      size: entry.kind === "file" ? entry.content.byteLength : 0,
      modifiedAt: entry.modifiedAt,
      mode: entry.mode
    };
  }

  async list(path: string): Promise<readonly RemoteDirectoryEntry[]> {
    const parent = normalizeRemote(path);
    if (this.require(parent).kind !== "directory") throw new Error("Not a directory.");
    const prefix = `${parent}/`;
    return [...this.#entries]
      .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map(([candidate, entry]) => ({ name: candidate.slice(prefix.length), kind: entry.kind }));
  }

  async read(request: RemoteFileReadRequest): Promise<Uint8Array> {
    const path = normalizeRemote(request.path);
    this.readPaths.push(path);
    const entry = this.require(path);
    if (entry.kind !== "file" || entry.content.byteLength > request.maximumBytes) throw new Error("Read failed.");
    return Buffer.from(entry.content);
  }

  async write(request: RemoteFileWriteRequest): Promise<void> {
    await this.beforeWrite?.(request);
    const accepted = normalizeRemote(request.path);
    if (request.createParents === true) await this.mkdir(remotePath.dirname(accepted), { recursive: true });
    this.#entries.set(accepted, {
      kind: "file",
      mode: request.mode ?? 0o600,
      modifiedAt: this.#clock++,
      content: Buffer.from(request.content)
    });
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<void> {
    const accepted = normalizeRemote(path);
    if (this.#entries.has(accepted)) return;
    const parent = remotePath.dirname(accepted);
    if (parent !== accepted && !this.#entries.has(parent)) {
      if (options?.recursive !== true) throw new Error("Parent is missing.");
      await this.mkdir(parent, options);
    }
    this.#entries.set(accepted, { kind: "directory", mode: options?.mode ?? 0o700, modifiedAt: this.#clock++ });
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const source = normalizeRemote(sourcePath);
    const destination = normalizeRemote(destinationPath);
    const entry = this.require(source);
    this.#entries.delete(source);
    this.#entries.set(destination, entry);
  }

  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const accepted = normalizeRemote(path);
    if (options?.recursive === true) {
      for (const candidate of [...this.#entries.keys()]) {
        if (candidate === accepted || candidate.startsWith(`${accepted}/`)) this.#entries.delete(candidate);
      }
      return;
    }
    this.#entries.delete(accepted);
  }

  text(path: string): string {
    const entry = this.require(normalizeRemote(path));
    if (entry.kind !== "file") throw new Error("Not a file.");
    return entry.content.toString("utf8");
  }

  allText(): string {
    return [...this.#entries.values()]
      .filter((entry): entry is Extract<PiMemoryEntry, { kind: "file" }> => entry.kind === "file")
      .map((entry) => entry.content.toString("utf8"))
      .join("\n");
  }

  has(path: string): boolean {
    return this.#entries.has(normalizeRemote(path));
  }

  private require(path: string): PiMemoryEntry {
    const entry = this.#entries.get(path);
    if (entry === undefined) throw new Error(`Remote path is missing: ${path}`);
    return entry;
  }
}

class ManualRemoteProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly input: Buffer[] = [];
  readonly authorityCommits: Record<string, unknown>[] = [];
  #controlPending = Buffer.alloc(0);
  #bootstrapped = false;
  #authorityCommitPending = Buffer.alloc(0);
  #awaitingAuthorityCommit = false;
  #authorityCommitEpoch = 0;
  #authorityCommitDigest = "";
  readonly #authorityCommitGate: Promise<void> | undefined;
  readonly #authorityState: {
    readonly inputAcknowledged: number;
    readonly outputSequence?: number;
    readonly recoveryOutputHighWater?: number;
  };

  constructor(authorityState: {
    readonly inputAcknowledged?: number;
    readonly outputSequence?: number;
    readonly recoveryOutputHighWater?: number;
    readonly recoveryRejection?: "child_absent" | "launch_mismatch";
    readonly clockOffsetMs?: number;
    readonly authorityCommitGate?: Promise<void>;
  } = {}) {
    super();
    this.#authorityCommitGate = authorityState.authorityCommitGate;
    this.#authorityState = {
      inputAcknowledged: authorityState.inputAcknowledged ?? 0,
      ...(authorityState.outputSequence === undefined ? {} : { outputSequence: authorityState.outputSequence }),
      ...(authorityState.recoveryOutputHighWater === undefined
        ? {}
        : { recoveryOutputHighWater: authorityState.recoveryOutputHighWater })
    };
    this.stdin.on("data", (chunk: Buffer | string) => {
      const content = Buffer.from(chunk);
      if (this.#bootstrapped) {
        this.#consumePostBootstrapInput(content);
        return;
      }
      this.input.push(content);
      this.#controlPending = Buffer.concat([this.#controlPending, content]);
      const newline = this.#controlPending.indexOf(0x0a);
      if (newline < 0) return;
      const value = JSON.parse(this.#controlPending.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      this.#bootstrapped = true;
      if (value.action === "kill") {
        queueMicrotask(() => this.complete(0));
        return;
      }
      if (value.action !== "ensure") return;
      const requested = value.authority as Record<string, unknown>;
      const recovery = requested.recovery as Record<string, unknown> | undefined;
      const generation = Number(requested.runtimeGeneration);
      const outputCursor = Number(value.outputCursor ?? 0);
      const recovering = recovery !== undefined && generation === Number(recovery.runtimeGeneration) + 1;
      if (recovering && authorityState.recoveryRejection !== undefined) {
        this.stdout.write(testControlFrame(8, {
          ok: false,
          recoveryRejected: true,
          authorityVerified: true,
          reason: authorityState.recoveryRejection
        }));
        return;
      }
      const authority = recovery === undefined ? {
        format: 1,
        targetId: requested.targetId,
        hostId: requested.hostId,
        recoveryIdentity: requested.recoveryIdentity,
        spawnIdentity: requested.spawnIdentity,
        runtimeGeneration: generation,
        compatibilityHash: requested.compatibilityHash,
        childProcessLaunchHash: requested.candidateProcessLaunchHash,
        trustedRunnerScriptSha256: requested.trustedRunnerScriptSha256,
        identity: value.identity,
        launchHash: value.launchHash,
        pid: 4242,
        processStartIdentity: "c".repeat(64),
        startedAt: Date.now() + (authorityState.clockOffsetMs ?? 0) - 1_000,
        epoch: 1,
        issuedAt: Date.now() + (authorityState.clockOffsetMs ?? 0),
        attestation: "d".repeat(64)
      } : {
        ...recovery,
        spawnIdentity: requested.spawnIdentity,
        runtimeGeneration: generation,
        epoch: Number(recovery.epoch) + (recovering ? 1 : 0),
        issuedAt: recovering
          ? Date.now() + (authorityState.clockOffsetMs ?? 0)
          : recovery.issuedAt,
        attestation: recovering ? "e".repeat(64) : recovery.attestation
      };
      const authorityDigest = createHash("sha256").update(JSON.stringify(authority)).digest("hex");
      this.#awaitingAuthorityCommit = true;
      this.#authorityCommitEpoch = Number(authority.epoch);
      this.#authorityCommitDigest = authorityDigest;
      this.stdout.write(testControlFrame(8, {
        ok: true,
        authority,
        state: {
          inputAcknowledged: this.#authorityState.inputAcknowledged,
          outputAcknowledged: outputCursor,
          outputSequence: this.#authorityState.outputSequence ?? outputCursor,
          authorityCommitRequired: true,
          authorityDigest,
          ...(recovering ? {
            recoveryOutputHighWater: this.#authorityState.recoveryOutputHighWater ?? outputCursor
          } : {})
        }
      }));
    });
  }

  #consumePostBootstrapInput(content: Buffer): void {
    if (!this.#awaitingAuthorityCommit) {
      this.input.push(content);
      return;
    }
    this.#authorityCommitPending = Buffer.concat([this.#authorityCommitPending, content]);
    if (this.#authorityCommitPending.byteLength < 5) return;
    const type = this.#authorityCommitPending.readUInt8(0);
    const length = this.#authorityCommitPending.readUInt32BE(1);
    if (type !== 9 || length > 64 * 1024) throw new Error("Invalid authority commit test frame.");
    if (this.#authorityCommitPending.byteLength < length + 5) return;
    const commit = JSON.parse(
      this.#authorityCommitPending.subarray(5, length + 5).toString("utf8")
    ) as Record<string, unknown>;
    if (
      commit.format !== 1 || commit.epoch !== this.#authorityCommitEpoch ||
      commit.authorityDigest !== this.#authorityCommitDigest
    ) throw new Error("Invalid authority commit test envelope.");
    this.authorityCommits.push(commit);
    this.#awaitingAuthorityCommit = false;
    const tail = this.#authorityCommitPending.subarray(length + 5);
    this.#authorityCommitPending = Buffer.alloc(0);
    const acknowledge = (): void => {
      this.stdout.write(testControlFrame(10, {
        ok: true,
        epoch: this.#authorityCommitEpoch,
        authorityDigest: this.#authorityCommitDigest
      }));
      if (tail.byteLength > 0) this.input.push(tail);
    };
    if (this.#authorityCommitGate === undefined) acknowledge();
    else void this.#authorityCommitGate.then(acknowledge);
  }

  kill(): boolean {
    this.complete(-1, "SIGKILL");
    return true;
  }

  complete(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

class SignalOnlyRemoteProcess extends ManualRemoteProcess {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

function normalizeRemote(value: string): string {
  if (!value.startsWith("/")) throw new Error("Remote path must be absolute.");
  const normalized = remotePath.normalize(value);
  if (normalized.includes("/../") || normalized.endsWith("/..")) throw new Error("Unsafe remote path.");
  return normalized;
}
