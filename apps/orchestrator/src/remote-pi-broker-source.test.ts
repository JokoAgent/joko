import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  REMOTE_PI_BROKER_PROTOCOL_VERSION,
  REMOTE_PI_BROKER_SOURCE,
  REMOTE_PI_BROKER_SOURCE_SHA256,
  remotePiLaunchHash
} from "./remote-pi-broker-source.js";

const FRAME_STDIN = 1;
const FRAME_STDOUT = 2;
const FRAME_STDERR = 3;
const FRAME_EXIT = 4;
const FRAME_OUTPUT_ACK = 6;
const FRAME_INPUT_ACK = 7;
const FRAME_AUTHORITY = 8;
const FRAME_AUTHORITY_COMMIT = 9;
const FRAME_AUTHORITY_COMMIT_ACK = 10;
const RUNNER_SOURCE = "setInterval(() => undefined, 1000);\n";

interface BrokerFrame {
  readonly type: number;
  readonly content: Buffer;
}

class FrameReader {
  readonly #iterator: AsyncIterator<Buffer | string>;
  #pending = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.#iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  }

  async next(): Promise<BrokerFrame> {
    while (this.#pending.byteLength < 5) await this.#read();
    const length = this.#pending.readUInt32BE(1);
    while (this.#pending.byteLength < length + 5) await this.#read();
    const frame = { type: this.#pending.readUInt8(0), content: this.#pending.subarray(5, length + 5) };
    this.#pending = this.#pending.subarray(length + 5);
    return frame;
  }

  async #read(): Promise<void> {
    const next = await this.#iterator.next();
    if (next.done) throw new Error("Broker frame stream ended unexpectedly.");
    this.#pending = Buffer.concat([
      this.#pending,
      typeof next.value === "string" ? Buffer.from(next.value) : next.value
    ]);
  }
}

function frame(type: number, content = Buffer.alloc(0)): Buffer {
  const value = Buffer.allocUnsafe(5 + content.byteLength);
  value.writeUInt8(type, 0);
  value.writeUInt32BE(content.byteLength, 1);
  content.copy(value, 5);
  return value;
}

function sequencedFrame(type: number, sequence: number, content = Buffer.alloc(0)): Buffer {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(sequence));
  return frame(type, Buffer.concat([prefix, content]));
}

function sequenced(frameValue: BrokerFrame): { readonly sequence: number; readonly content: Buffer } {
  return {
    sequence: Number(frameValue.content.readBigUInt64BE(0)),
    content: frameValue.content.subarray(8)
  };
}

async function nextFrameOfType(reader: FrameReader, type: number): Promise<BrokerFrame> {
  for (;;) {
    const value = await reader.next();
    if (value.type === type) return value;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function nativeReservationToken(generation: number): string {
  return createHash("sha256").update(`native-auth-reservation-${generation}`).digest("base64url");
}

interface AuthorityEnvelope extends Record<string, unknown> {
  readonly format: 1;
  readonly identity: string;
  readonly epoch: number;
  readonly childProcessLaunchHash: string;
  readonly attestation: string;
}

interface AuthorityState {
  readonly inputAcknowledged: number;
  readonly outputAcknowledged: number;
  readonly outputSequence: number;
  readonly recoveryOutputHighWater?: number;
  readonly authorityCommitRequired: boolean;
  readonly authorityDigest: string;
}

interface BrokerBootstrap extends Record<string, unknown> {
  readonly identity: string;
  readonly launchHash: string;
  readonly authority: Record<string, unknown>;
}

interface BrokerFixture {
  readonly root: string;
  readonly managedRoot: string;
  readonly runtimeRoot: string;
  readonly descriptorPath: string;
  readonly sourcePath: string;
  readonly childPath: string;
  readonly runRoot: string;
  readonly productSessionId: string;
  readonly trustedRunnerScriptSha256: string;
  readonly identity: string;
  readonly recoveryIdentity: string;
  readonly compatibilityHash: string;
}

async function brokerFixture(source = REMOTE_PI_BROKER_SOURCE): Promise<BrokerFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-broker-"));
  const managedRoot = join(root, ".joko", "pi-broker");
  const identity = digest("durable-broker-identity").slice(0, 32);
  const runtimeRoot = join(root, ".joko", "runtime", identity);
  const descriptorPath = join(runtimeRoot, "mcp.json");
  const sourcePath = join(managedRoot, "broker.mjs");
  const childPath = join(root, "child.mjs");
  const runRoot = join(root, ".joko", "subagent-runs");
  const productSessionId = "product-session-test";
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await writeFile(sourcePath, source, { mode: 0o600 });
  await writeFile(childPath, String.raw`
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createInterface } from "node:readline";
const descriptorPath = process.env.JOKO_PI_MCP_DESCRIPTOR_FILE;
const stableBearer = process.env.JOKO_PI_MCP_TOKEN;
const stableNativeAuthReservationToken = process.env.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN;
const generation = Number(process.env.JOKO_PI_GENERATION);
const nativeProofs = new Map();
const nativeReservations = new Map();
const nativeRunnerPids = new Map();
const isolateCiHttpConnections = process.env.JOKO_TEST_HTTP_CONNECTION_ISOLATION === "1";
const ciHttpRequestOptions = isolateCiHttpConnections ? { agent: false } : {};
function guardCiHttpResponse(incoming, rejectValue) {
  if (!isolateCiHttpConnections) return;
  const rejectIncomplete = () => {
    if (!incoming.complete) rejectValue(new Error("CI HTTP fixture response ended before completion."));
  };
  incoming.once("aborted", rejectIncomplete);
  incoming.once("error", rejectValue);
  incoming.once("close", rejectIncomplete);
}
function guardCiHttpRequest(outgoing) {
  if (!isolateCiHttpConnections) return;
  outgoing.setTimeout(10_000, () => {
    outgoing.destroy(new Error("CI HTTP fixture request timed out."));
  });
}
async function call() {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const body = Buffer.from(JSON.stringify({ generation, operation: "probe" }));
  const endpoint = new URL(descriptor.endpoint);
  const response = await new Promise((resolveValue, rejectValue) => {
    const outgoing = request(endpoint, {
      method: "POST",
      ...ciHttpRequestOptions,
      headers: {
        authorization: "Bearer " + stableBearer,
        "x-joko-pi-generation": String(generation),
        "content-type": "application/json",
        "content-length": String(body.byteLength)
      }
    }, (incoming) => {
      guardCiHttpResponse(incoming, rejectValue);
      let value = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { value += chunk; });
      incoming.on("end", () => resolveValue(value));
    });
    guardCiHttpRequest(outgoing);
    outgoing.once("error", rejectValue);
    outgoing.end(body);
  });
  process.stdout.write("response:" + response + "\n");
}
async function callNative(action, runId, runnerFence, runnerPid) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const fence = runId + ":" + runnerFence;
  const reservation = nativeReservations.get(fence);
  if (!reservation) throw new Error("runner reservation is unavailable");
  const exactRunnerPid = action === "acquire" ? Number(runnerPid) : nativeRunnerPids.get(fence);
  const body = Buffer.from(JSON.stringify({
    action,
    generation: reservation.serviceGeneration,
    runnerProductGeneration: generation,
    sessionId: process.env.JOKO_PI_PRODUCT_SESSION_ID,
    targetId: "target-test",
    providerId: "provider-test",
    catalogGeneration: 1,
    runId,
    runnerFence,
    ...(action === "acquire" ? { recovery: { runnerPid: exactRunnerPid } } : {}),
    ...(action === "acquire" || nativeProofs.get(fence) === undefined
      ? {}
      : { recoveryProof: nativeProofs.get(fence) }),
    runnerProof: {
      format: 1,
      reservationId: reservation.reservationId,
      runnerPid: exactRunnerPid,
      nonce: Buffer.alloc(32, 0x6e).toString("base64url"),
      signature: Buffer.alloc(64, 0x73).toString("base64url")
    }
  }));
  const endpoint = new URL(descriptor.nativeAuthLease.endpoint);
  const result = await new Promise((resolveValue, rejectValue) => {
    const outgoing = request(endpoint, {
      method: "POST",
      ...ciHttpRequestOptions,
      headers: {
        authorization: "Bearer " + stableBearer,
        "x-joko-pi-generation": String(reservation.serviceGeneration),
        "content-type": "application/json",
        "content-length": String(body.byteLength)
      }
    }, (incoming) => {
      guardCiHttpResponse(incoming, rejectValue);
      let content = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { content += chunk; });
      incoming.on("end", () => resolveValue({ status: incoming.statusCode, content }));
    });
    guardCiHttpRequest(outgoing);
    outgoing.once("error", rejectValue);
    outgoing.end(body);
  });
  let response;
  try { response = JSON.parse(result.content); } catch {}
  if (action === "acquire" && typeof response?.recoveryProof === "string") {
    nativeProofs.set(fence, response.recoveryProof);
    nativeRunnerPids.set(fence, exactRunnerPid);
  }
  if (action === "release" && result.status >= 200 && result.status < 300 && response?.active === false) {
    nativeProofs.delete(fence);
    nativeRunnerPids.delete(fence);
  }
  process.stdout.write("native:" + action + ":" + result.status + "\n");
}
async function reserveNative(runId, runnerFence) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const fence = runId + ":" + runnerFence;
  const body = Buffer.from(JSON.stringify({
    action: "reserve",
    generation,
    runnerProductGeneration: generation,
    sessionId: process.env.JOKO_PI_PRODUCT_SESSION_ID,
    targetId: "target-test",
    providerId: "provider-test",
    catalogGeneration: 1,
    runId,
    runnerFence,
    runnerRegistration: {
      format: 1,
      publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    }
  }));
  const endpoint = new URL(descriptor.nativeAuthLease.endpoint);
  const result = await new Promise((resolveValue, rejectValue) => {
    const outgoing = request(endpoint, {
      method: "POST",
      ...ciHttpRequestOptions,
      headers: {
        authorization: "Bearer " + stableBearer,
        "x-joko-pi-generation": String(generation),
        "x-joko-pi-native-auth-reservation": stableNativeAuthReservationToken,
        "content-type": "application/json",
        "content-length": String(body.byteLength)
      }
    }, (incoming) => {
      guardCiHttpResponse(incoming, rejectValue);
      let content = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { content += chunk; });
      incoming.on("end", () => resolveValue({ status: incoming.statusCode, content }));
    });
    guardCiHttpRequest(outgoing);
    outgoing.once("error", rejectValue);
    outgoing.end(body);
  });
  let response;
  try { response = JSON.parse(result.content); } catch {}
  if (result.status >= 200 && result.status < 300 && response?.reserved === true) {
    nativeReservations.set(fence, response);
  }
  process.stdout.write("reserve:" + result.status + "\n");
}
async function callForeground(action, runId, runnerFence) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const body = Buffer.from(JSON.stringify({
    action,
    generation,
    runnerProductGeneration: generation,
    sessionId: process.env.JOKO_PI_PRODUCT_SESSION_ID,
    targetId: "target-test",
    providerId: "provider-test",
    catalogGeneration: 1,
    runId,
    runnerFence
  }));
  const endpoint = new URL(descriptor.nativeAuthLease.endpoint);
  const status = await new Promise((resolveValue, rejectValue) => {
    const outgoing = request(endpoint, {
      method: "POST",
      ...ciHttpRequestOptions,
      headers: {
        authorization: "Bearer " + stableBearer,
        "x-joko-pi-generation": String(generation),
        "content-type": "application/json",
        "content-length": String(body.byteLength)
      }
    }, (incoming) => {
      guardCiHttpResponse(incoming, rejectValue);
      incoming.resume();
      incoming.on("end", () => resolveValue(incoming.statusCode));
    });
    guardCiHttpRequest(outgoing);
    outgoing.once("error", rejectValue);
    outgoing.end(body);
  });
  process.stdout.write("foreground:" + action + ":" + status + "\n");
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line === "call") void call();
  else if (line === "node") process.stdout.write("node:" + process.env.JOKO_PI_SUBAGENT_NODE_EXECUTABLE + "\n");
  else if (line === "leak") {
    process.stdout.write(stableBearer.slice(0, 17));
    setImmediate(() => process.stdout.write(stableBearer.slice(17) + "\n"));
  }
  else if (line === "prefix") process.stdout.write('{"type":"stale"');
  else if (line === "suffix") process.stdout.write('}\n{"type":"fresh"}\n');
  else if (line === "flood") {
    for (let index = 0; index < 24; index += 1) process.stdout.write("x".repeat(256 * 1024));
  }
  else if (line === "exit") process.exit(0);
  else if (line.startsWith("native|")) {
    const fields = line.split("|");
    void callNative(fields[1], fields[2], fields[3], fields[4]).catch(() => {
      process.stdout.write("native:" + fields[1] + ":error\n");
    });
  } else if (line.startsWith("reserve|")) {
    const fields = line.split("|");
    void reserveNative(fields[1], fields[2]).catch(() => {
      process.stdout.write("reserve:error\n");
    });
  } else if (line.startsWith("foreground|")) {
    const fields = line.split("|");
    void callForeground(fields[1], fields[2], fields[3]).catch(() => {
      process.stdout.write("foreground:" + fields[1] + ":error\n");
    });
  }
});
`, { mode: 0o600 });
  return {
    root,
    managedRoot,
    runtimeRoot,
    descriptorPath,
    sourcePath,
    childPath,
    runRoot,
    productSessionId,
    trustedRunnerScriptSha256: digest(RUNNER_SOURCE),
    identity,
    recoveryIdentity: digest("durable-recovery-identity"),
    compatibilityHash: digest("compatible-static-launch")
  };
}

function bootstrap(
  fixture: BrokerFixture,
  generation: number,
  currentBearer: string,
  relayPort: number,
  recovery?: AuthorityEnvelope,
  outputCursor = 0
): BrokerBootstrap {
  const spawnIdentity = digest(`spawn-${generation}`);
  const currentNativeAuthReservationToken = nativeReservationToken(generation);
  const env = {
    JOKO_PI_MCP_TOKEN: currentBearer,
    JOKO_PI_GENERATION: String(generation),
    JOKO_PI_SPAWN_IDENTITY: spawnIdentity,
    JOKO_PI_MCP_DESCRIPTOR_FILE: fixture.descriptorPath,
    JOKO_PI_PRODUCT_SESSION_ID: fixture.productSessionId,
    JOKO_PI_SUBAGENT_RUN_ROOT: fixture.runRoot,
    JOKO_PI_SUBAGENT_NODE_EXECUTABLE: "<joko-broker-node-executable>",
    JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: "<joko-broker-native-auth-reservation>",
    ...(process.env.GITHUB_ACTIONS === "true"
      ? { JOKO_TEST_HTTP_CONNECTION_ISOLATION: "1" }
      : {})
  };
  const shape = {
    command: process.execPath,
    args: [fixture.childPath],
    cwd: fixture.root,
    env
  };
  const candidateProcessLaunchHash = remotePiLaunchHash({
    ...shape,
    env: {
      ...env,
      JOKO_PI_MCP_TOKEN: "<joko-broker-managed-bearer>",
      JOKO_PI_GENERATION: "<joko-broker-runtime-generation>",
      JOKO_PI_SPAWN_IDENTITY: "<joko-broker-spawn-identity>",
      JOKO_PI_SUBAGENT_NODE_EXECUTABLE: "<joko-broker-node-executable>",
      JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: "<joko-broker-native-auth-reservation>"
    }
  });
  return {
    action: "ensure",
    version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
    identity: fixture.identity,
    launchHash: remotePiLaunchHash(shape),
    executable: process.execPath,
    args: shape.args,
    cwd: shape.cwd,
    env,
    runtimeRoot: fixture.runtimeRoot,
    currentNativeAuthReservationToken,
    outputCursor,
    authority: {
      format: 1,
      targetId: "target-test",
      hostId: "host-test",
      recoveryIdentity: fixture.recoveryIdentity,
      spawnIdentity,
      runtimeGeneration: generation,
      compatibilityHash: fixture.compatibilityHash,
      trustedRunnerScriptSha256: fixture.trustedRunnerScriptSha256,
      candidateProcessLaunchHash,
      ...(recovery === undefined ? {} : { recovery })
    },
    relay: {
      port: relayPort,
      descriptorPath: fixture.descriptorPath,
      descriptor: {
        endpoint: `http://127.0.0.1:${relayPort}/internal/mcp`,
        generation,
        sessionId: "session-test",
        targetId: "target-test",
        tools: [],
        nativeAuthLease: {
          endpoint: `http://127.0.0.1:${relayPort}/internal/pi-native-auth`,
          catalogGeneration: 1,
          providerIds: ["provider-test"],
          authenticatedProviderIds: ["provider-test"]
        }
      }
    }
  };
}

function nonManagedBootstrap(
  fixture: BrokerFixture,
  generation: number,
  currentBearer: string,
  relayPort: number
): BrokerBootstrap {
  const value = bootstrap(fixture, generation, currentBearer, relayPort);
  const env = { ...(value["env"] as Record<string, string>) };
  delete env.JOKO_PI_SUBAGENT_RUN_ROOT;
  delete env.JOKO_PI_PRODUCT_SESSION_ID;
  delete env.JOKO_PI_SUBAGENT_NODE_EXECUTABLE;
  delete env.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN;
  const shape = {
    command: process.execPath,
    args: [fixture.childPath],
    cwd: fixture.root,
    env
  };
  const normalizedEnvironment = {
    ...env,
    JOKO_PI_MCP_TOKEN: "<joko-broker-managed-bearer>",
    JOKO_PI_GENERATION: "<joko-broker-runtime-generation>",
    JOKO_PI_SPAWN_IDENTITY: "<joko-broker-spawn-identity>"
  };
  const authority = value.authority as Record<string, unknown>;
  return {
    ...value,
    launchHash: remotePiLaunchHash(shape),
    env,
    currentNativeAuthReservationToken: undefined,
    authority: {
      ...authority,
      trustedRunnerScriptSha256: "0".repeat(64),
      candidateProcessLaunchHash: remotePiLaunchHash({ ...shape, env: normalizedEnvironment })
    }
  };
}

async function startBridge(
  fixture: BrokerFixture,
  value: BrokerBootstrap,
  commitAuthority = true
): Promise<{
  readonly process: ChildProcessWithoutNullStreams;
  readonly reader: FrameReader;
  readonly authority: AuthorityEnvelope;
  readonly state: AuthorityState;
}> {
  const child = spawn(process.execPath, [
    fixture.sourcePath,
    "bridge",
    fixture.managedRoot,
    fixture.identity,
    value.launchHash,
    randomUUID()
  ], {
    env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.write(`${JSON.stringify(value)}\n`);
  const reader = new FrameReader(child.stdout);
  const control = await nextFrameOfType(reader, FRAME_AUTHORITY);
  const declaredEnvironment = value["env"] as Record<string, string> | undefined;
  const currentBearer = declaredEnvironment?.["JOKO_PI_MCP_TOKEN"];
  if (currentBearer !== undefined) expect(control.content.toString("utf8")).not.toContain(currentBearer);
  const currentNativeAuthReservationToken = value["currentNativeAuthReservationToken"];
  if (typeof currentNativeAuthReservationToken === "string") {
    expect(control.content.toString("utf8")).not.toContain(currentNativeAuthReservationToken);
  }
  const parsed = JSON.parse(control.content.toString("utf8")) as {
    readonly ok: boolean;
    readonly authority: AuthorityEnvelope;
    readonly state: AuthorityState;
  };
  expect(parsed.ok).toBe(true);
  expect(parsed.state.authorityDigest).toBe(digest(JSON.stringify(parsed.authority)));
  if (parsed.state.authorityCommitRequired && commitAuthority) {
    child.stdin.write(frame(FRAME_AUTHORITY_COMMIT, Buffer.from(JSON.stringify({
      format: 1,
      identity: parsed.authority.identity,
      epoch: parsed.authority.epoch,
      authorityDigest: parsed.state.authorityDigest,
      attestation: parsed.authority.attestation
    }))));
    const committed = JSON.parse((await nextFrameOfType(reader, FRAME_AUTHORITY_COMMIT_ACK)).content.toString("utf8")) as {
      readonly ok: boolean;
      readonly epoch: number;
      readonly authorityDigest: string;
    };
    expect(committed).toEqual({
      ok: true,
      epoch: parsed.authority.epoch,
      authorityDigest: parsed.state.authorityDigest
    });
  }
  return { process: child, reader, authority: parsed.authority, state: parsed.state };
}

async function startRejectedBridge(
  fixture: BrokerFixture,
  value: BrokerBootstrap
): Promise<{ readonly authorityVerified: boolean; readonly reason: string }> {
  const child = spawn(process.execPath, [
    fixture.sourcePath,
    "bridge",
    fixture.managedRoot,
    fixture.identity,
    value.launchHash,
    randomUUID()
  ], {
    env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(`${JSON.stringify(value)}\n`);
  const control = await nextFrameOfType(new FrameReader(child.stdout), FRAME_AUTHORITY);
  const parsed = JSON.parse(control.content.toString("utf8")) as {
    readonly ok: boolean;
    readonly authorityVerified: boolean;
    readonly reason: string;
  };
  expect(parsed.ok).toBe(false);
  child.stderr.resume();
  expect(await processExit(child)).toBe(76);
  return parsed;
}

async function processExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

async function processExitWithin(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Broker process did not exit after a fatal bootstrap rejection."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function exactKill(pid: number, mode: "daemon" | "owner", sourcePath: string): Promise<void> {
  const fields = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  expect(fields).toContain(sourcePath);
  expect(fields).toContain(mode);
  process.kill(pid, "SIGKILL");
  await waitUntil(async () => {
    try { await readFile(`/proc/${pid}/stat`); return false; } catch { return true; }
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for broker fault recovery.");
}

async function upstream(): Promise<{
  readonly server: Server;
  readonly port: number;
  readonly request: Promise<{ readonly authorization: string; readonly generation: string; readonly body: Record<string, unknown> }>;
}> {
  let resolveRequest!: (value: { readonly authorization: string; readonly generation: string; readonly body: Record<string, unknown> }) => void;
  const captured = new Promise<{ readonly authorization: string; readonly generation: string; readonly body: Record<string, unknown> }>((resolveValue) => {
    resolveRequest = resolveValue;
  });
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      resolveRequest({
        authorization: String(request.headers.authorization ?? ""),
        generation: String(request.headers["x-joko-pi-generation"] ?? ""),
        body: JSON.parse(body) as Record<string, unknown>
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test upstream did not bind TCP.");
  return { server, port: address.port, request: captured };
}

interface NativeCapture {
  readonly authorization: string;
  readonly generation: string;
  readonly nativeAuthReservation: string;
  readonly body: Record<string, unknown>;
}

async function nativeUpstream(plans: readonly ({
  readonly status: number;
  readonly body?: Record<string, unknown>;
  readonly drop?: boolean;
})[]): Promise<{
  readonly server: Server;
  readonly port: number;
  readonly captures: NativeCapture[];
}> {
  const captures: NativeCapture[] = [];
  const queue = [...plans];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captures.push({
        authorization: String(request.headers.authorization ?? ""),
        generation: String(request.headers["x-joko-pi-generation"] ?? ""),
        nativeAuthReservation: String(request.headers["x-joko-pi-native-auth-reservation"] ?? ""),
        body: JSON.parse(body) as Record<string, unknown>
      });
      const plan = queue.shift() ?? { status: 500, body: { active: false } };
      if (plan.drop === true) {
        return process.env.GITHUB_ACTIONS === "true"
          ? request.socket.resetAndDestroy()
          : request.socket.destroy();
      }
      const content = Buffer.from(JSON.stringify(plan.body ?? { active: false }));
      response.statusCode = plan.status;
      response.setHeader("content-type", "application/json");
      response.setHeader("content-length", String(content.byteLength));
      response.setHeader("connection", "close");
      response.end(content);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test native upstream did not bind TCP.");
  return { server, port: address.port, captures };
}

async function capturedNative(
  target: { readonly captures: readonly NativeCapture[] },
  index: number
): Promise<NativeCapture> {
  await waitUntil(() => target.captures.length > index);
  return target.captures[index]!;
}

async function remoteRunnerFixture(
  fixture: BrokerFixture,
  productGeneration: number,
  nativeAuthRequired = true
): Promise<{
  readonly process: ChildProcessWithoutNullStreams;
  readonly runId: string;
  readonly runnerFence: string;
  readonly launchToken: string;
  readonly runDirectory: string;
}> {
  const runId = randomUUID();
  const runnerFence = randomUUID();
  const launchToken = randomUUID();
  const nativeAuthReservationId = randomUUID();
  const runnerPublicKey = "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const runnerPublicKeyDigest = digest(runnerPublicKey);
  const taskId = "remote-runner-task";
  const childId = "remote-child-id";
  const sessionRoot = join(fixture.runRoot, digest(fixture.productSessionId).slice(0, 40));
  const runDirectory = join(sessionRoot, runId);
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const configPath = join(runDirectory, "config.json");
  const nativeSessionId = randomUUID();
  const nativeSessionDirectory = join(runDirectory, "sessions");
  const nativeSessionPath = join(nativeSessionDirectory, `${nativeSessionId}.jsonl`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await mkdir(nativeSessionDirectory, { mode: 0o700 });
  await chmod(sessionRoot, 0o700);
  await chmod(runDirectory, 0o700);
  await writeFile(runnerScript, RUNNER_SOURCE, { mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify({
    format: 1,
    runId,
    launchToken,
    runDir: runDirectory,
    runnerScript,
    runnerScriptSha256: fixture.trustedRunnerScriptSha256,
    runnerInstanceId: runnerFence,
    ...(nativeAuthRequired ? {
      nativeAuthReservationId,
      nativeAuthServiceGeneration: productGeneration,
      runnerPublicKey,
      runnerPublicKeyDigest
    } : {}),
    productSessionId: fixture.productSessionId,
    productGeneration,
    taskId,
    childId,
    nativeSessionId,
    nativeAuthRequired,
    route: { provider: "provider-test" }
  })}\n`, { mode: 0o600 });
  const nodeExecutable = await realpath(process.execPath);
  const child = spawn(nodeExecutable, [runnerScript, configPath], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  const runnerPid = child.pid;
  if (runnerPid === undefined) throw new Error("Test runner did not expose a PID.");
  const common = {
    format: 1,
    runId,
    launchToken,
    productSessionId: fixture.productSessionId,
    taskId,
    childId,
    runnerScript,
    runnerScriptSha256: fixture.trustedRunnerScriptSha256,
    ...(nativeAuthRequired ? { nativeAuthReservationId, runnerPublicKeyDigest } : {}),
    state: "running",
    heartbeatAt: Date.now(),
    pendingApproval: {
      id: "approval-test",
      childId,
      method: "confirm",
      requestedAt: Date.now()
    },
    nativeSessionId,
    nativeSessionPath,
    runnerPid,
    runnerInstanceId: runnerFence
  };
  await Promise.all([
    writeFile(join(runDirectory, "status.json"), `${JSON.stringify(common)}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "owner.json"), `${JSON.stringify(common)}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "runner.claim.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      runnerPid,
      runnerInstanceId: runnerFence,
      runnerScriptSha256: fixture.trustedRunnerScriptSha256,
      ...(nativeAuthRequired ? { nativeAuthReservationId, runnerPublicKeyDigest } : {})
    })}\n`, { mode: 0o600 })
  ]);
  await Promise.all([
    writeFile(join(runDirectory, "transcript.jsonl"), '{"type":"runner-ready"}\n', { mode: 0o600 }),
    writeFile(nativeSessionPath, '{"type":"session"}\n', { mode: 0o600 })
  ]);
  await waitUntil(async () => {
    try {
      const fields = (await readFile(`/proc/${runnerPid}/cmdline`))
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry !== "");
      return fields.length === 3
        && fields[0] === nodeExecutable
        && fields[1] === runnerScript
        && fields[2] === configPath;
    } catch {
      return false;
    }
  });
  return { process: child, runId, runnerFence, launchToken, runDirectory };
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  server.closeAllConnections();
  await closed;
}

async function brokerMetadata(fixture: BrokerFixture): Promise<{
  readonly owner: { readonly pid: number };
  readonly child: { readonly pid: number };
  readonly janitor: { readonly pid: number };
}> {
  return JSON.parse(await readFile(
    join(fixture.managedRoot, "sessions", fixture.identity, "owner.json"),
    "utf8"
  )) as {
    readonly owner: { readonly pid: number };
    readonly child: { readonly pid: number };
    readonly janitor: { readonly pid: number };
  };
}

async function managerPid(fixture: BrokerFixture): Promise<number> {
  return (JSON.parse(await readFile(join(fixture.managedRoot, "broker.json"), "utf8")) as { readonly pid: number }).pid;
}

async function processHasArgument(argument: string): Promise<boolean> {
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    try {
      const fields = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      if (fields.includes(argument)) return true;
    } catch {
      // The process may exit while /proc is enumerated.
    }
  }
  return false;
}

async function authorityKill(fixture: BrokerFixture, authority: AuthorityEnvelope): Promise<void> {
  const child = spawn(process.execPath, [fixture.sourcePath, "kill", fixture.managedRoot], {
    env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(`${JSON.stringify({
    action: "kill",
    version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
    identity: fixture.identity,
    signal: "SIGTERM",
    authority
  })}\n`);
  child.stdout.resume();
  child.stderr.resume();
  expect(await processExit(child)).toBe(0);
}

async function managedStoreRequest(
  fixture: BrokerFixture,
  authority: AuthorityEnvelope,
  operation: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [fixture.sourcePath, "store", fixture.managedRoot], {
    env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.resume();
  child.stdin.end(`${JSON.stringify({
    action: "managed-store",
    version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
    format: 1,
    identity: fixture.identity,
    authority,
    ...operation
  })}\n`);
  expect(await processExit(child)).toBe(0);
  return JSON.parse(output) as Record<string, unknown>;
}

async function managedStoreRejected(
  fixture: BrokerFixture,
  authority: AuthorityEnvelope,
  operation: Readonly<Record<string, unknown>>
): Promise<void> {
  const child = spawn(process.execPath, [fixture.sourcePath, "store", fixture.managedRoot], {
    env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(`${JSON.stringify({
    action: "managed-store",
    version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
    format: 1,
    identity: fixture.identity,
    authority,
    ...operation
  })}\n`);
  child.stdout.resume();
  child.stderr.resume();
  expect(await processExit(child)).not.toBe(0);
}

describe("remote Pi broker source", () => {
  it("is versioned, hash-addressed, and valid standalone ESM", () => {
    expect(REMOTE_PI_BROKER_PROTOCOL_VERSION).toBe(1);
    expect(createHash("sha256").update(REMOTE_PI_BROKER_SOURCE).digest("hex"))
      .toBe(REMOTE_PI_BROKER_SOURCE_SHA256);
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: REMOTE_PI_BROKER_SOURCE,
      encoding: "utf8"
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("exits a fatal bootstrap rejection while controller stdin remains open", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-broker-fatal-bootstrap-"));
    const sourcePath = join(root, "broker.mjs");
    await writeFile(sourcePath, REMOTE_PI_BROKER_SOURCE, { mode: 0o600 });
    const child = spawn(process.execPath, [
      sourcePath,
      "bridge",
      root,
      "0".repeat(32),
      "0".repeat(64),
      randomUUID()
    ], {
      env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: "invalid" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.resume();
    child.stderr.resume();
    try {
      expect(await processExitWithin(child, 2_000)).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 5_000);

  it("hashes the complete launch shape canonically without exposing it", () => {
    const base = {
      command: "node",
      args: ["/managed/entry.mjs", "--mode", "rpc"],
      cwd: "/workspace",
      env: { Z_VALUE: "last", A_SECRET: "opaque-runtime-value" }
    } as const;
    const expected = remotePiLaunchHash(base);
    expect(remotePiLaunchHash({ ...base, env: { A_SECRET: "opaque-runtime-value", Z_VALUE: "last" } })).toBe(expected);
    expect(remotePiLaunchHash({ ...base, command: "nodejs" })).not.toBe(expected);
    expect(remotePiLaunchHash({ ...base, args: [...base.args, "extra"] })).not.toBe(expected);
    expect(remotePiLaunchHash({ ...base, cwd: "/other" })).not.toBe(expected);
    expect(remotePiLaunchHash({ ...base, env: { ...base.env, A_SECRET: "rotated" } })).not.toBe(expected);
    expect(expected).toMatch(/^[a-f0-9]{64}$/u);
    expect(expected).not.toContain("opaque-runtime-value");
  });

  it.runIf(process.platform === "linux")(
    "rejects a regular file changed or replaced while its bytes are being read",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "joko-broker-read-race-"));
      const harnessPath = join(fixtureRoot, "read-race.mjs");
      const targetPath = join(fixtureRoot, "metadata.json");
      const pausePoint = "    const content = await handle.readFile();";
      const harnessSource = REMOTE_PI_BROKER_SOURCE
        .replace(pausePoint, `${pausePoint}\n    process.send?.("ready");\n    await new Promise((resume) => process.once("message", resume));\n    process.disconnect?.();`)
        .replace(
          "main().catch(() => process.exit(1));",
          "privateRegularFile(process.argv[2], 4096).then(() => { process.exitCode = 0; }, () => { process.exitCode = 91; });"
        );
      expect(harnessSource).not.toBe(REMOTE_PI_BROKER_SOURCE);
      await writeFile(harnessPath, harnessSource, { mode: 0o600 });

      const runMutation = async (mutate: () => Promise<void>): Promise<void> => {
        await writeFile(targetPath, "a".repeat(2048), { mode: 0o600 });
        const child = spawn(process.execPath, [harnessPath, targetPath], {
          stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
        child.stderr?.resume();
        const ready = await Promise.race([
          once(child, "message"),
          processExit(child).then((code) => { throw new Error(`read-race harness exited before pause: ${code}`); })
        ]);
        expect(ready[0]).toBe("ready");
        await mutate();
        child.send("continue");
        expect(await processExit(child)).toBe(91);
      };

      try {
        await runMutation(async () => {
          await writeFile(targetPath, "b".repeat(2048), { mode: 0o600 });
        });
        await runMutation(async () => {
          const displacedPath = `${targetPath}.displaced`;
          await rename(targetPath, displacedPath);
          await writeFile(targetPath, "a".repeat(2048), { mode: 0o600 });
          await rm(displacedPath);
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    15_000
  );

  it.runIf(process.platform === "linux")(
    "keeps the exact child and replay alive across manager crash, then rotates relay authority",
    async () => {
      const fixture = await brokerFixture();
      const firstUpstream = await upstream();
      const currentBearerOne = "orchestrator-current-bearer-one-000000000000";
      const currentBearerTwo = "orchestrator-current-bearer-two-000000000000";
      let firstBridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let secondBridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let secondUpstream: Awaited<ReturnType<typeof upstream>> | undefined;
      let finalAuthority: AuthorityEnvelope | undefined;
      try {
        const firstBootstrap = bootstrap(fixture, 1, currentBearerOne, firstUpstream.port);
        firstBridge = await startBridge(fixture, firstBootstrap);
        firstBridge.process.stdin.write(sequencedFrame(FRAME_STDIN, 1, Buffer.from("call\n")));
        const firstOutput = sequenced(await nextFrameOfType(firstBridge.reader, FRAME_STDOUT));
        expect(firstOutput.content.toString("utf8")).toContain("response:");
        expect(await firstUpstream.request).toEqual({
          authorization: `Bearer ${currentBearerOne}`,
          generation: "1",
          body: { generation: 1, operation: "probe" }
        });
        firstBridge.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, firstOutput.sequence));
        firstBridge.process.stdin.write(sequencedFrame(FRAME_STDIN, 2, Buffer.from("node\n")));
        const nodeOutput = sequenced(await nextFrameOfType(firstBridge.reader, FRAME_STDOUT));
        expect(nodeOutput.content.toString("utf8")).toBe(`node:${await realpath(process.execPath)}\n`);
        firstBridge.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, nodeOutput.sequence));
        firstBridge.process.stdin.write(sequencedFrame(FRAME_STDIN, 3, Buffer.from("leak\n")));
        const redactedOutput = sequenced(await nextFrameOfType(firstBridge.reader, FRAME_STDOUT));
        expect(redactedOutput.content.toString("utf8")).toBe("[redacted]\n");
        firstBridge.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, redactedOutput.sequence));
        firstBridge.process.stdin.write(sequencedFrame(FRAME_STDIN, 4, Buffer.from("prefix\n")));
        const prefixOutput = sequenced(await nextFrameOfType(firstBridge.reader, FRAME_STDOUT));
        expect(prefixOutput.content.toString("utf8")).toBe('{"type":"stale"');
        firstBridge.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, prefixOutput.sequence));
        firstBridge.process.kill("SIGKILL");
        await processExit(firstBridge.process);

        const oldManager = await managerPid(fixture);
        await exactKill(oldManager, "daemon", fixture.sourcePath);
        secondUpstream = await upstream();
        const secondBootstrap = bootstrap(
          fixture,
          2,
          currentBearerTwo,
          secondUpstream.port,
          firstBridge.authority,
          prefixOutput.sequence
        );
        secondBridge = await startBridge(fixture, secondBootstrap);
        finalAuthority = secondBridge.authority;
        expect(secondBridge.authority.epoch).toBe(firstBridge.authority.epoch + 1);
        expect(secondBridge.authority.childProcessLaunchHash).toBe(firstBridge.authority.childProcessLaunchHash);
        expect(secondBridge.state.recoveryOutputHighWater).toBeGreaterThanOrEqual(prefixOutput.sequence);
        const nextInput = secondBridge.state.inputAcknowledged + 1;
        secondBridge.process.stdin.write(sequencedFrame(FRAME_STDIN, nextInput, Buffer.from("suffix\n")));
        const recoveredRecord = sequenced(await nextFrameOfType(secondBridge.reader, FRAME_STDOUT));
        expect(recoveredRecord.content.toString("utf8")).toBe('{"type":"fresh"}\n');
        secondBridge.process.stdin.write(sequencedFrame(FRAME_STDIN, nextInput + 1, Buffer.from("call\n")));
        const secondOutput = sequenced(await nextFrameOfType(secondBridge.reader, FRAME_STDOUT));
        expect(secondOutput.sequence).toBeGreaterThan(recoveredRecord.sequence);
        expect(await secondUpstream.request).toEqual({
          authorization: `Bearer ${currentBearerTwo}`,
          generation: "2",
          body: { generation: 2, operation: "probe" }
        });

        const sessionRoot = join(fixture.managedRoot, "sessions", fixture.identity);
        for (const path of [
          join(sessionRoot, "owner.json"),
          join(fixture.managedRoot, "broker.json"),
          fixture.descriptorPath
        ]) {
          const content = await readFile(path, "utf8");
          expect(content).not.toContain(currentBearerOne);
          expect(content).not.toContain(currentBearerTwo);
          expect(content).not.toContain(nativeReservationToken(1));
          expect(content).not.toContain(nativeReservationToken(2));
        }
        expect((JSON.parse(await readFile(fixture.descriptorPath, "utf8")) as { generation: number }).generation).toBe(1);
        await authorityKill(fixture, secondBridge.authority);
        await waitUntil(async () => {
          try { await lstat(sessionRoot); return false; } catch { return true; }
        });
        finalAuthority = undefined;
      } finally {
        if (finalAuthority !== undefined) await authorityKill(fixture, finalAuthority).catch(() => undefined);
        if (firstBridge?.process.exitCode === null) firstBridge.process.kill("SIGKILL");
        if (secondBridge?.process.exitCode === null) secondBridge.process.kill("SIGKILL");
        await closeServer(firstUpstream.server);
        if (secondUpstream !== undefined) await closeServer(secondUpstream.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "replays only sequence-preserving non-stdout placeholders after a partial-line overflow",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let first: Awaited<ReturnType<typeof startBridge>> | undefined;
      let second: Awaited<ReturnType<typeof startBridge>> | undefined;
      let finalAuthority: AuthorityEnvelope | undefined;
      try {
        const value = bootstrap(fixture, 1, "replay-overflow-bearer-00000000000", target.port);
        first = await startBridge(fixture, value);
        first.process.stdin.write(sequencedFrame(FRAME_STDIN, 1, Buffer.from("flood\n")));
        const truncation = sequenced(await nextFrameOfType(first.reader, FRAME_STDERR));
        expect(truncation.content.toString("utf8")).toBe("[joko remote replay truncated]\n");
        first.process.kill("SIGKILL");
        await processExit(first.process);
        await waitUntil(async () => {
          const metadata = await brokerMetadata(fixture);
          try { await readFile(`/proc/${metadata.child.pid}/stat`); return false; } catch { return true; }
        });
        second = await startBridge(fixture, {
          ...value,
          authority: { ...value.authority, recovery: first.authority }
        });
        finalAuthority = second.authority;
        let expectedSequence = 1;
        for (;;) {
          const output = await second.reader.next();
          if (![FRAME_STDERR, FRAME_EXIT].includes(output.type)) continue;
          const decoded = sequenced(output);
          expect(decoded.sequence).toBe(expectedSequence);
          expectedSequence += 1;
          if (output.type === FRAME_STDERR) {
            expect(decoded.content.toString("utf8")).not.toContain("x");
          } else {
            break;
          }
        }
        await authorityKill(fixture, second.authority);
        finalAuthority = undefined;
      } finally {
        if (finalAuthority !== undefined) await authorityKill(fixture, finalAuthority).catch(() => undefined);
        first?.process.kill("SIGKILL");
        second?.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    45_000
  );

  it.runIf(process.platform === "linux")(
    "starts and retires a profile without managed-subagent runtime fields",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      try {
        bridge = await startBridge(fixture, nonManagedBootstrap(
          fixture,
          1,
          "non-managed-profile-bearer-0000000000",
          target.port
        ));
        expect((await brokerMetadata(fixture)).child.pid).toBeGreaterThan(0);
        await authorityKill(fixture, bridge.authority);
        bridge = undefined;
      } finally {
        if (bridge !== undefined) await authorityKill(fixture, bridge.authority).catch(() => undefined);
        bridge?.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    20_000
  );

  it.runIf(process.platform === "linux")(
    "retires a fresh child when the first provisional authority is not committed",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let provisional: Awaited<ReturnType<typeof startBridge>> | undefined;
      let replacement: Awaited<ReturnType<typeof startBridge>> | undefined;
      try {
        const value = bootstrap(fixture, 1, "first-provisional-bearer-000000000", target.port);
        provisional = await startBridge(fixture, value, false);
        const initial = await brokerMetadata(fixture);
        provisional.process.kill("SIGKILL");
        expect(await processExit(provisional.process)).not.toBe(0);
        await waitUntil(async () => {
          try { await lstat(join(fixture.managedRoot, "sessions", fixture.identity)); return false; }
          catch { return true; }
        }, 20_000);
        await expect(readFile(`/proc/${initial.child.pid}/stat`)).rejects.toThrow();

        replacement = await startBridge(fixture, value);
        expect((await brokerMetadata(fixture)).child.pid).not.toBe(initial.child.pid);
        await authorityKill(fixture, replacement.authority);
        replacement = undefined;
      } finally {
        provisional?.process.kill("SIGKILL");
        if (replacement !== undefined) await authorityKill(fixture, replacement.authority).catch(() => undefined);
        replacement?.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "keeps the committed authority valid if rotation dies before host persistence",
    async () => {
      const fixture = await brokerFixture();
      const firstTarget = await upstream();
      const secondTarget = await upstream();
      let first: Awaited<ReturnType<typeof startBridge>> | undefined;
      let provisional: Awaited<ReturnType<typeof startBridge>> | undefined;
      try {
        const firstValue = bootstrap(fixture, 1, "rotation-committed-bearer-0000000", firstTarget.port);
        first = await startBridge(fixture, firstValue);
        first.process.kill("SIGKILL");
        await processExit(first.process);
        const secondValue = bootstrap(
          fixture,
          2,
          "rotation-provisional-bearer-000000",
          secondTarget.port,
          first.authority
        );
        provisional = await startBridge(fixture, secondValue, false);
        const metadata = await brokerMetadata(fixture);
        provisional.process.kill("SIGKILL");
        await processExit(provisional.process);
        await exactKill(metadata.owner.pid, "owner", fixture.sourcePath);
        await waitUntil(async () => {
          try { await readFile(`/proc/${metadata.child.pid}/stat`); return false; } catch { return true; }
        });
        const result = await startRejectedBridge(fixture, secondValue);
        expect(result).toEqual({
          ok: false,
          recoveryRejected: true,
          authorityVerified: true,
          reason: "child_absent"
        });
        await expect(lstat(join(fixture.managedRoot, "sessions", fixture.identity))).rejects.toThrow();
      } finally {
        first?.process.kill("SIGKILL");
        provisional?.process.kill("SIGKILL");
        await closeServer(firstTarget.server);
        await closeServer(secondTarget.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    40_000
  );

  it.runIf(process.platform === "linux")(
    "uses the independent janitor to stop the exact child after owner SIGKILL",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let replacement: Awaited<ReturnType<typeof startBridge>> | undefined;
      let durableRunner: Awaited<ReturnType<typeof remoteRunnerFixture>> | undefined;
      let finalAuthority: AuthorityEnvelope | undefined;
      try {
        const value = bootstrap(fixture, 1, "owner-crash-bearer-0000000000000000", target.port);
        bridge = await startBridge(fixture, value);
        finalAuthority = bridge.authority;
        durableRunner = await remoteRunnerFixture(fixture, 1);
        const metadata = await brokerMetadata(fixture);
        bridge.process.kill("SIGKILL");
        await processExit(bridge.process);
        await exactKill(metadata.owner.pid, "owner", fixture.sourcePath);
        await waitUntil(async () => {
          try { await readFile(`/proc/${metadata.child.pid}/stat`); return false; } catch { return true; }
        });
        await waitUntil(async () => {
          try { await readFile(`/proc/${durableRunner!.process.pid!}/stat`); return false; } catch { return true; }
        });
        await waitUntil(async () => {
          try {
            await readFile(join(fixture.managedRoot, "sessions", fixture.identity, "reaped.json"));
            return true;
          } catch {
            return false;
          }
        });

        const staleAuthority = await startRejectedBridge(fixture, {
          ...value,
          authority: { ...value.authority, recovery: bridge.authority }
        });
        expect(staleAuthority).toEqual({
          ok: false,
          recoveryRejected: true,
          authorityVerified: true,
          reason: "child_absent"
        });
        await expect(lstat(join(fixture.managedRoot, "sessions", fixture.identity))).rejects.toThrow();

        replacement = await startBridge(fixture, value);
        finalAuthority = replacement.authority;
        const replacementMetadata = await brokerMetadata(fixture);
        expect(replacementMetadata.child.pid).not.toBe(metadata.child.pid);
        const removed = await managedStoreRequest(fixture, replacement.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey: digest(fixture.productSessionId).slice(0, 40),
          timeoutMs: 100
        });
        expect(removed).toMatchObject({ removed: true, terminalRunIds: [durableRunner.runId] });
        await authorityKill(fixture, replacement.authority);
        finalAuthority = undefined;
      } finally {
        if (finalAuthority !== undefined) await authorityKill(fixture, finalAuthority).catch(() => undefined);
        if (bridge?.process.exitCode === null) bridge.process.kill("SIGKILL");
        if (replacement?.process.exitCode === null) replacement.process.kill("SIGKILL");
        if (durableRunner?.process.exitCode === null) durableRunner.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "stops a verified incompatible child and immediately spawns one replacement",
    async () => {
      const fixture = await brokerFixture();
      const firstTarget = await upstream();
      const secondTarget = await upstream();
      let first: Awaited<ReturnType<typeof startBridge>> | undefined;
      let replacement: Awaited<ReturnType<typeof startBridge>> | undefined;
      try {
        const initial = bootstrap(fixture, 1, "incompatible-old-bearer-0000000000", firstTarget.port);
        first = await startBridge(fixture, initial);
        const oldMetadata = await brokerMetadata(fixture);
        first.process.kill("SIGKILL");
        await processExit(first.process);
        const incompatibleHash = digest("incompatible-static-launch");
        const candidate = bootstrap(fixture, 2, "incompatible-new-bearer-0000000000", secondTarget.port);
        const rejected = await startRejectedBridge(fixture, {
          ...candidate,
          authority: {
            ...candidate.authority,
            compatibilityHash: incompatibleHash,
            recovery: first.authority
          }
        });
        expect(rejected).toEqual({
          ok: false,
          recoveryRejected: true,
          authorityVerified: true,
          reason: "launch_mismatch"
        });
        await authorityKill(fixture, first.authority);
        replacement = await startBridge(fixture, {
          ...candidate,
          authority: { ...candidate.authority, compatibilityHash: incompatibleHash }
        });
        const newMetadata = await brokerMetadata(fixture);
        expect(newMetadata.child.pid).not.toBe(oldMetadata.child.pid);
        await authorityKill(fixture, replacement.authority);
        replacement = undefined;
      } finally {
        if (replacement !== undefined) await authorityKill(fixture, replacement.authority).catch(() => undefined);
        if (first?.process.exitCode === null) first.process.kill("SIGKILL");
        if (replacement?.process.exitCode === null) replacement.process.kill("SIGKILL");
        await closeServer(firstTarget.server);
        await closeServer(secondTarget.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "keeps terminal-owner store authority until non-native durable runs are explicitly removed",
    async () => {
      const shortRetentionSource = REMOTE_PI_BROKER_SOURCE.replace(
        "const TERMINAL_RETENTION_MS = 5 * 60_000;",
        "const TERMINAL_RETENTION_MS = 200;"
      );
      expect(shortRetentionSource).not.toBe(REMOTE_PI_BROKER_SOURCE);
      const fixture = await brokerFixture(shortRetentionSource);
      const target = await upstream();
      const currentBearer = "store-current-bearer-000000000000000";
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let runner: Awaited<ReturnType<typeof remoteRunnerFixture>> | undefined;
      try {
        bridge = await startBridge(fixture, bootstrap(fixture, 1, currentBearer, target.port));
        runner = await remoteRunnerFixture(fixture, 1, false);
        bridge.process.stdin.write(sequencedFrame(
          FRAME_STDIN,
          bridge.state.inputAcknowledged + 1,
          Buffer.from("exit\n")
        ));
        const terminal = sequenced(await nextFrameOfType(bridge.reader, FRAME_EXIT));
        bridge.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, terminal.sequence));
        await processExit(bridge.process);
        await new Promise((resolveWait) => setTimeout(resolveWait, 600));
        expect((await brokerMetadata(fixture)).owner.pid).toBeGreaterThan(0);
        const transcriptText = '{"type":"runner-ready"}\n'
          + '{"type":"chunk","value":"' + "x".repeat(300_000) + '"}\n';
        await writeFile(join(runner.runDirectory, "transcript.jsonl"), transcriptText, { mode: 0o600 });

        const sessionKey = digest(fixture.productSessionId).slice(0, 40);
        const scanned = await managedStoreRequest(fixture, bridge.authority, {
          operation: "scan",
          sessionId: fixture.productSessionId,
          sessionKey,
          limitBytes: 1024 * 1024
        });
        expect(scanned["ok"]).toBe(true);
        expect(scanned["authorityVerified"]).toBe(true);
        expect(scanned["unchanged"]).toBe(false);
        expect(scanned["retryAfterMs"]).toBe(1_000);
        const runs = scanned["runs"] as Array<Record<string, unknown>>;
        expect(runs).toHaveLength(1);
        expect(runs[0]?.["runId"]).toBe(runner.runId);
        expect(runs[0]?.["resumeSafe"]).toBe(true);
        expect(runs[0]?.["controlSafe"]).toBe(true);
        expect(JSON.stringify(scanned)).not.toContain(currentBearer);
        expect(JSON.stringify(scanned)).not.toContain("joko-broker-stable-bearer");

        const transcriptRevision = String(runs[0]?.["transcriptRevision"]);
        const controlRevision = String(runs[0]?.["controlRevision"]);
        let offset = 0;
        let downloaded = Buffer.alloc(0);
        for (let chunkIndex = 0; ; chunkIndex += 1) {
          const tail = await managedStoreRequest(fixture, bridge.authority, {
            operation: "read-tail",
            sessionId: fixture.productSessionId,
            runId: runner.runId,
            runnerInstanceId: runner.runnerFence,
            artifactRevision: transcriptRevision,
            pathKind: "transcript",
            offset,
            maxBytes: 64 * 1024
          });
          const content = Buffer.from(String(tail["content"]), "base64");
          downloaded = Buffer.concat([downloaded, content]);
          offset = Number(tail["nextOffset"]);
          if (chunkIndex === 0) {
            const statusPath = join(runner.runDirectory, "status.json");
            const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
            await writeFile(statusPath, `${JSON.stringify({ ...status, heartbeatAt: Date.now() })}\n`, { mode: 0o600 });
            await writeFile(
              join(runner.runDirectory, "transcript.jsonl"),
              '{"type":"appended-after-snapshot"}\n',
              { flag: "a" }
            );
          }
          if (tail["eof"] === true) break;
        }
        expect(downloaded.toString("utf8")).toBe(transcriptText);
        const transcriptPath = join(runner.runDirectory, "transcript.jsonl");
        const transcriptBeforeRewrite = await lstat(transcriptPath);
        const transcriptHandle = await open(transcriptPath, "r+");
        try {
          await transcriptHandle.truncate(0);
          await transcriptHandle.writeFile(Buffer.alloc(Buffer.byteLength(transcriptText), 0x7a));
        } finally {
          await transcriptHandle.close();
        }
        expect((await lstat(transcriptPath)).ino).toBe(transcriptBeforeRewrite.ino);
        await managedStoreRejected(fixture, bridge.authority, {
          operation: "read-tail",
          sessionId: fixture.productSessionId,
          runId: runner.runId,
          runnerInstanceId: runner.runnerFence,
          artifactRevision: transcriptRevision,
          pathKind: "transcript",
          offset: 0,
          maxBytes: 64 * 1024
        });

        const controlled = await managedStoreRequest(fixture, bridge.authority, {
          operation: "write-control",
          sessionId: fixture.productSessionId,
          runId: runner.runId,
          runnerInstanceId: runner.runnerFence,
          launchToken: runner.launchToken,
          runnerScriptSha256: fixture.trustedRunnerScriptSha256,
          expectedControlRevision: controlRevision,
          kind: "control",
          value: {
            format: 1,
            requestId: randomUUID(),
            runId: runner.runId,
            launchToken: runner.launchToken,
            productSessionId: fixture.productSessionId,
            productGeneration: 1,
            taskId: "remote-runner-task",
            action: "steer",
            message: "continue safely",
            requestedAt: Date.now()
          }
        });
        expect(controlled["receipt"]).toMatch(/^[a-f0-9]{64}$/u);
        expect(controlled["controlRevision"]).not.toBe(controlRevision);
        const firstControl = JSON.parse(await readFile(join(runner.runDirectory, "control.json"), "utf8")) as {
          seq: number;
        };
        const controlledAgain = await managedStoreRequest(fixture, bridge.authority, {
          operation: "write-control",
          sessionId: fixture.productSessionId,
          runId: runner.runId,
          runnerInstanceId: runner.runnerFence,
          launchToken: runner.launchToken,
          runnerScriptSha256: fixture.trustedRunnerScriptSha256,
          expectedControlRevision: controlled["controlRevision"],
          kind: "control",
          value: {
            format: 1,
            requestId: randomUUID(),
            runId: runner.runId,
            launchToken: runner.launchToken,
            productSessionId: fixture.productSessionId,
            productGeneration: 1,
            taskId: "remote-runner-task",
            action: "follow_up",
            message: "second control",
            requestedAt: Date.now()
          }
        });
        const secondControl = JSON.parse(await readFile(join(runner.runDirectory, "control.json"), "utf8")) as {
          seq: number;
        };
        expect(secondControl.seq).toBeGreaterThan(firstControl.seq);
        const approved = await managedStoreRequest(fixture, bridge.authority, {
          operation: "write-control",
          sessionId: fixture.productSessionId,
          runId: runner.runId,
          runnerInstanceId: runner.runnerFence,
          launchToken: runner.launchToken,
          runnerScriptSha256: fixture.trustedRunnerScriptSha256,
          expectedControlRevision: controlledAgain["controlRevision"],
          kind: "approval",
          value: {
            format: 1,
            requestId: randomUUID(),
            runId: runner.runId,
            launchToken: runner.launchToken,
            productSessionId: fixture.productSessionId,
            productGeneration: 1,
            taskId: "remote-runner-task",
            childId: "remote-child-id",
            action: "approval",
            approvalId: "approval-test",
            confirmed: true,
            requestedAt: Date.now()
          }
        });
        expect(approved["controlRevision"]).not.toBe(controlledAgain["controlRevision"]);
        expect(JSON.parse(await readFile(join(runner.runDirectory, "approval-control.json"), "utf8")))
          .toMatchObject({ action: "approval", approvalId: "approval-test" });
        const staleStatusPath = join(runner.runDirectory, "status.json");
        const freshStatus = JSON.parse(await readFile(staleStatusPath, "utf8")) as Record<string, unknown>;
        await writeFile(staleStatusPath, `${JSON.stringify({
          ...freshStatus,
          heartbeatAt: Date.now() - 60_000
        })}\n`, { mode: 0o600 });
        await managedStoreRejected(fixture, bridge.authority, {
          operation: "write-control",
          sessionId: fixture.productSessionId,
          runId: runner.runId,
          runnerInstanceId: runner.runnerFence,
          launchToken: runner.launchToken,
          runnerScriptSha256: fixture.trustedRunnerScriptSha256,
          expectedControlRevision: approved["controlRevision"],
          kind: "control",
          value: {
            format: 1,
            requestId: randomUUID(),
            runId: runner.runId,
            launchToken: runner.launchToken,
            productSessionId: fixture.productSessionId,
            productGeneration: 1,
            taskId: "remote-runner-task",
            action: "stop",
            requestedAt: Date.now()
          }
        });
        await writeFile(staleStatusPath, `${JSON.stringify({
          ...freshStatus,
          heartbeatAt: Date.now()
        })}\n`, { mode: 0o600 });

        const removed = await managedStoreRequest(fixture, bridge.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey,
          timeoutMs: 100
        });
        expect(removed).toMatchObject({ ok: true, authorityVerified: true, removed: true });
        expect(removed["terminalRunIds"]).toEqual([runner.runId]);
        expect(removed["deletionReceipt"]).toMatch(/^[a-f0-9]{64}$/u);
        await waitUntil(async () => {
          try { await lstat(join(fixture.managedRoot, "sessions", fixture.identity)); return false; }
          catch { return true; }
        });
        await waitUntil(async () => {
          try { await readFile(`/proc/${runner!.process.pid!}/stat`); return false; }
          catch { return true; }
        });
        const repeated = await managedStoreRequest(fixture, bridge.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey,
          timeoutMs: 100
        });
        expect(repeated["deletionReceipt"]).toBe(removed["deletionReceipt"]);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const finalized = await managedStoreRequest(fixture, bridge.authority, {
            operation: "finalize-deletion",
            sessionId: fixture.productSessionId,
            sessionKey,
            deletionReceipt: removed["deletionReceipt"]
          });
          expect(finalized).toMatchObject({
            ok: true,
            authorityVerified: true,
            finalized: true,
            deletionReceipt: removed["deletionReceipt"]
          });
        }
      } finally {
        if (bridge?.process.exitCode === null) bridge.process.kill("SIGKILL");
        if (runner?.process.exitCode === null) runner.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "relaunches a terminal main child without dropping an active durable runner",
    async () => {
      const fixture = await brokerFixture();
      const firstTarget = await upstream();
      const secondTarget = await upstream();
      let first: Awaited<ReturnType<typeof startBridge>> | undefined;
      let second: Awaited<ReturnType<typeof startBridge>> | undefined;
      let runner: Awaited<ReturnType<typeof remoteRunnerFixture>> | undefined;
      try {
        first = await startBridge(
          fixture,
          bootstrap(fixture, 1, "terminal-handoff-old-bearer-00000000", firstTarget.port)
        );
        runner = await remoteRunnerFixture(fixture, 1, false);
        const originalMetadata = await brokerMetadata(fixture);
        first.process.stdin.write(sequencedFrame(
          FRAME_STDIN,
          first.state.inputAcknowledged + 1,
          Buffer.from("exit\n")
        ));
        const firstExit = sequenced(await nextFrameOfType(first.reader, FRAME_EXIT));
        first.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, firstExit.sequence));
        await processExit(first.process);

        second = await startBridge(fixture, bootstrap(
          fixture,
          2,
          "terminal-handoff-new-bearer-00000000",
          secondTarget.port,
          first.authority,
          firstExit.sequence
        ));
        const replacementMetadata = await brokerMetadata(fixture);
        expect(replacementMetadata.owner.pid).toBe(originalMetadata.owner.pid);
        expect(replacementMetadata.child.pid).not.toBe(originalMetadata.child.pid);
        expect(second.authority["pid"]).toBe(replacementMetadata.child.pid);
        expect(second.state.recoveryOutputHighWater).toBeGreaterThanOrEqual(firstExit.sequence);

        second.process.stdin.write(sequencedFrame(
          FRAME_STDIN,
          second.state.inputAcknowledged + 1,
          Buffer.from("call\n")
        ));
        const response = sequenced(await nextFrameOfType(second.reader, FRAME_STDOUT));
        expect(response.content.toString("utf8")).toContain("response:");
        expect(await secondTarget.request).toMatchObject({
          authorization: "Bearer terminal-handoff-new-bearer-00000000",
          generation: "2",
          body: { generation: 2, operation: "probe" }
        });
        second.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, response.sequence));

        const sessionKey = digest(fixture.productSessionId).slice(0, 40);
        const scan = await managedStoreRequest(fixture, second.authority, {
          operation: "scan",
          sessionId: fixture.productSessionId,
          sessionKey,
          limitBytes: 1024 * 1024
        });
        expect((scan["runs"] as Array<Record<string, unknown>>).map((run) => run["runId"]))
          .toEqual([runner.runId]);

        second.process.stdin.write(sequencedFrame(
          FRAME_STDIN,
          second.state.inputAcknowledged + 2,
          Buffer.from("exit\n")
        ));
        const secondExit = sequenced(await nextFrameOfType(second.reader, FRAME_EXIT));
        second.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, secondExit.sequence));
        await processExit(second.process);
        const removed = await managedStoreRequest(fixture, second.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey,
          timeoutMs: 100
        });
        expect(removed).toMatchObject({
          ok: true,
          authorityVerified: true,
          removed: true,
          terminalRunIds: [runner.runId]
        });
        await waitUntil(async () => {
          try { await lstat(join(fixture.managedRoot, "sessions", fixture.identity)); return false; }
          catch { return true; }
        });
      } finally {
        if (first?.process.exitCode === null) first.process.kill("SIGKILL");
        if (second?.process.exitCode === null) second.process.kill("SIGKILL");
        if (runner?.process.exitCode === null) runner.process.kill("SIGKILL");
        await closeServer(firstTarget.server);
        await closeServer(secondTarget.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "keeps an unfinalized deletion receipt usable across authority rotation and terminal handoff",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let first: Awaited<ReturnType<typeof startBridge>> | undefined;
      let second: Awaited<ReturnType<typeof startBridge>> | undefined;
      let third: Awaited<ReturnType<typeof startBridge>> | undefined;
      let runner: Awaited<ReturnType<typeof remoteRunnerFixture>> | undefined;
      try {
        first = await startBridge(
          fixture,
          bootstrap(fixture, 1, "removal-handoff-first-bearer-000000", target.port)
        );
        runner = await remoteRunnerFixture(fixture, 1, false);
        const sessionKey = digest(fixture.productSessionId).slice(0, 40);
        const initialRemoval = await managedStoreRequest(fixture, first.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey,
          timeoutMs: 100
        });
        const deletionReceipt = String(initialRemoval["deletionReceipt"]);
        expect(deletionReceipt).toMatch(/^[a-f0-9]{64}$/u);

        second = await startBridge(fixture, bootstrap(
          fixture,
          2,
          "removal-handoff-second-bearer-00000",
          target.port,
          first.authority
        ));
        const retriedAfterRotation = await managedStoreRequest(fixture, first.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey,
          timeoutMs: 100
        });
        expect(retriedAfterRotation["deletionReceipt"]).toBe(deletionReceipt);

        second.process.stdin.write(sequencedFrame(
          FRAME_STDIN,
          second.state.inputAcknowledged + 1,
          Buffer.from("exit\n")
        ));
        const terminal = sequenced(await nextFrameOfType(second.reader, FRAME_EXIT));
        second.process.stdin.write(sequencedFrame(FRAME_OUTPUT_ACK, terminal.sequence));
        await processExit(second.process);
        third = await startBridge(fixture, bootstrap(
          fixture,
          3,
          "removal-handoff-third-bearer-000000",
          target.port,
          second.authority,
          terminal.sequence
        ));
        const retriedAfterHandoff = await managedStoreRequest(fixture, first.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey,
          timeoutMs: 100
        });
        expect(retriedAfterHandoff["deletionReceipt"]).toBe(deletionReceipt);
        const finalized = await managedStoreRequest(fixture, first.authority, {
          operation: "finalize-deletion",
          sessionId: fixture.productSessionId,
          sessionKey,
          deletionReceipt
        });
        expect(finalized).toMatchObject({
          ok: true,
          authorityVerified: true,
          finalized: true,
          deletionReceipt
        });
        await authorityKill(fixture, third.authority);
        third = undefined;
      } finally {
        if (third !== undefined) await authorityKill(fixture, third.authority).catch(() => undefined);
        if (first?.process.exitCode === null) first.process.kill("SIGKILL");
        if (second?.process.exitCode === null) second.process.kill("SIGKILL");
        if (third?.process.exitCode === null) third.process.kill("SIGKILL");
        if (runner?.process.exitCode === null) runner.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    40_000
  );

  it.runIf(process.platform === "linux")(
    "attests remote runners and preserves native-auth acquire generations across rotation and retries",
    async () => {
      const fixture = await brokerFixture();
      const firstRecoveryProof = Buffer.alloc(32, 0x70).toString("base64url");
      const secondRecoveryProof = Buffer.alloc(32, 0x71).toString("base64url");
      const firstTarget = await nativeUpstream([
        {
          status: 200,
          body: { reserved: true, reservationId: randomUUID(), serviceGeneration: 1, validForMs: 15_000 }
        },
        {
          status: 200,
          body: { active: true, validForMs: 15_000, recoveryProof: firstRecoveryProof }
        }
      ]);
      const secondTarget = await nativeUpstream([
        { status: 200, body: { active: true, validForMs: 15_000 } },
        { status: 500, body: { active: true, validForMs: 15_000 } },
        { status: 200, body: { active: false } },
        {
          status: 200,
          body: { reserved: true, reservationId: randomUUID(), serviceGeneration: 2, validForMs: 15_000 }
        },
        { status: 503, drop: true },
        {
          status: 200,
          body: { active: true, validForMs: 15_000, recoveryProof: secondRecoveryProof }
        },
        { status: 200, body: { active: true, validForMs: 15_000 } },
        { status: 200, body: { active: true, validForMs: 15_000, credential: { token: "opaque" } } },
        { status: 200, body: { active: true, validForMs: 15_000 } },
        { status: 200, body: { active: false } },
        { status: 200, body: { active: false } }
      ]);
      const firstRunner = await remoteRunnerFixture(fixture, 1);
      const secondRunner = await remoteRunnerFixture(fixture, 1);
      const bearerOne = "native-current-bearer-one-000000000";
      const bearerTwo = "native-current-bearer-two-000000000";
      let first: Awaited<ReturnType<typeof startBridge>> | undefined;
      let second: Awaited<ReturnType<typeof startBridge>> | undefined;
      let finalAuthority: AuthorityEnvelope | undefined;
      try {
        first = await startBridge(fixture, bootstrap(fixture, 1, bearerOne, firstTarget.port));
        let inputSequence = first.state.inputAcknowledged;
        let outputHighWater = first.state.outputSequence;
        const acknowledgeOutput = async (
          bridge: Awaited<ReturnType<typeof startBridge>>,
          sequence: number
        ): Promise<void> => {
          await new Promise<void>((resolveWrite, rejectWrite) => {
            bridge.process.stdin.write(
              sequencedFrame(FRAME_OUTPUT_ACK, sequence),
              (error) => error ? rejectWrite(error) : resolveWrite()
            );
          });
        };
        const readStdout = async (
          bridge: Awaited<ReturnType<typeof startBridge>>
        ): Promise<{ readonly sequence: number; readonly content: Buffer }> => {
          for (;;) {
            const output = sequenced(await nextFrameOfType(bridge.reader, FRAME_STDOUT));
            await acknowledgeOutput(bridge, output.sequence);
            if (output.sequence <= outputHighWater) continue;
            outputHighWater = output.sequence;
            return output;
          }
        };
        const invoke = async (
          bridge: Awaited<ReturnType<typeof startBridge>>,
          action: string,
          runner: Awaited<ReturnType<typeof remoteRunnerFixture>>,
          pid = runner.process.pid
        ): Promise<string> => {
          inputSequence += 1;
          bridge.process.stdin.write(sequencedFrame(
            FRAME_STDIN,
            inputSequence,
            Buffer.from(`native|${action}|${runner.runId}|${runner.runnerFence}|${pid}\n`)
          ));
          return (await readStdout(bridge)).content.toString("utf8");
        };
        const reserve = async (
          bridge: Awaited<ReturnType<typeof startBridge>>,
          runner: Awaited<ReturnType<typeof remoteRunnerFixture>>
        ): Promise<string> => {
          inputSequence += 1;
          bridge.process.stdin.write(sequencedFrame(
            FRAME_STDIN,
            inputSequence,
            Buffer.from(`reserve|${runner.runId}|${runner.runnerFence}\n`)
          ));
          return (await readStdout(bridge)).content.toString("utf8");
        };
        expect(await reserve(first, firstRunner)).toContain("reserve:200");
        expect(await invoke(first, "acquire", firstRunner)).toContain("native:acquire:200");
        const reserved = await capturedNative(firstTarget, 0);
        expect(reserved.body["generation"]).toBe(1);
        expect(reserved.body["currentRouteGeneration"]).toBe(1);
        expect(reserved.body["remoteRunnerAttestation"]).toBeUndefined();
        expect(reserved.nativeAuthReservation).toBe(nativeReservationToken(1));
        const acquired = await capturedNative(firstTarget, 1);
        expect(acquired.authorization).toBe(`Bearer ${bearerOne}`);
        expect(acquired.generation).toBe("1");
        expect(acquired.body["generation"]).toBe(1);
        expect(acquired.body["runnerProductGeneration"]).toBe(1);
        expect(acquired.nativeAuthReservation).toBe("");
        const firstAttestation = acquired.body["remoteRunnerAttestation"] as Record<string, unknown>;
        expect(firstAttestation["action"]).toBe("acquire");
        const bindingMessage = JSON.stringify([
          "joko.pi-native-auth.remote-runner.attestation.v1",
          "acquire",
          acquired.body["sessionId"],
          acquired.body["targetId"],
          acquired.body["providerId"],
          acquired.body["catalogGeneration"],
          acquired.body["generation"],
          acquired.body["runnerProductGeneration"],
          acquired.body["runId"],
          acquired.body["runnerFence"],
          firstAttestation["bindingDigest"],
          firstAttestation["runnerPid"],
          firstAttestation["processIdentity"],
          firstAttestation["runRootDigest"],
          firstAttestation["runnerScriptDigest"],
          firstAttestation["configDigest"],
          firstAttestation["statusDigest"],
          firstAttestation["ownerDigest"],
          firstAttestation["claimDigest"],
          firstAttestation["issuedAt"],
          firstAttestation["nonce"]
        ]);
        expect(firstAttestation["mac"]).toBe(
          createHmac("sha256", bearerOne).update(bindingMessage).digest("base64url")
        );

        expect(await invoke(first, "acquire", firstRunner, process.pid)).toContain("native:acquire:error");
        expect(firstTarget.captures).toHaveLength(2);
        first.process.kill("SIGKILL");
        await processExit(first.process);

        second = await startBridge(
          fixture,
          bootstrap(fixture, 2, bearerTwo, secondTarget.port, first.authority)
        );
        finalAuthority = second.authority;
        inputSequence = second.state.inputAcknowledged;
        outputHighWater = second.state.outputSequence;
        expect(await invoke(second, "validate", firstRunner)).toContain("native:validate:200");
        expect(await invoke(second, "release", firstRunner)).toContain("native:release:500");
        expect(await invoke(second, "release", firstRunner)).toContain("native:release:200");
        expect(await reserve(second, secondRunner)).toContain("reserve:200");
        expect(await invoke(second, "acquire", secondRunner)).toContain("native:acquire:error");
        expect(await invoke(second, "acquire", secondRunner)).toContain("native:acquire:200");
        expect(await invoke(second, "validate", secondRunner)).toContain("native:validate:200");
        const foregroundRunId = randomUUID();
        const foregroundFence = randomUUID();
        for (const action of ["acquire", "validate", "release"] as const) {
          inputSequence += 1;
          second.process.stdin.write(sequencedFrame(
            FRAME_STDIN,
            inputSequence,
            Buffer.from(`foreground|${action}|${foregroundRunId}|${foregroundFence}\n`)
          ));
          expect((await readStdout(second)).content.toString("utf8"))
            .toContain(`foreground:${action}:200`);
        }

        for (const index of [0, 1, 2]) {
          const capture = await capturedNative(secondTarget, index);
          expect(capture.authorization).toBe(`Bearer ${bearerTwo}`);
          expect(capture.generation).toBe("1");
          expect(capture.body["generation"]).toBe(1);
          expect(capture.body["runnerProductGeneration"]).toBe(1);
          expect((capture.body["remoteRunnerAttestation"] as Record<string, unknown>)["runnerPid"])
            .toBe(firstRunner.process.pid);
        }
        const secondReservation = await capturedNative(secondTarget, 3);
        expect(secondReservation.generation).toBe("2");
        expect(secondReservation.body["generation"]).toBe(1);
        expect(secondReservation.body["currentRouteGeneration"]).toBe(2);
        expect(secondReservation.body["remoteRunnerAttestation"]).toBeUndefined();
        expect(secondReservation.nativeAuthReservation).toBe(nativeReservationToken(2));
        for (const index of [4, 5, 6]) {
          const capture = await capturedNative(secondTarget, index);
          expect(capture.authorization).toBe(`Bearer ${bearerTwo}`);
          expect(capture.generation).toBe("2");
          expect(capture.body["generation"]).toBe(2);
          expect(capture.body["runnerProductGeneration"]).toBe(1);
          expect(capture.nativeAuthReservation).toBe("");
          expect((capture.body["remoteRunnerAttestation"] as Record<string, unknown>)["runnerPid"])
            .toBe(secondRunner.process.pid);
        }
        for (const index of [7, 8, 9]) {
          const capture = await capturedNative(secondTarget, index);
          expect(capture.authorization).toBe(`Bearer ${bearerTwo}`);
          expect(capture.generation).toBe("2");
          expect(capture.body["generation"]).toBe(2);
          expect(capture.body["runnerProductGeneration"]).toBe(1);
          expect(capture.body["remoteRunnerAttestation"]).toBeUndefined();
          expect(capture.body["recovery"]).toBeUndefined();
          expect(capture.body["recoveryProof"]).toBeUndefined();
        }
        expect(await invoke(second, "release", secondRunner)).toContain("native:release:200");
        const releasedSecond = await capturedNative(secondTarget, 10);
        expect(releasedSecond.generation).toBe("2");
        expect(releasedSecond.body["generation"]).toBe(2);
        expect(releasedSecond.body["remoteRunnerAttestation"]).toBeDefined();
        const removed = await managedStoreRequest(fixture, second.authority, {
          operation: "stop-remove-session",
          sessionId: fixture.productSessionId,
          sessionKey: digest(fixture.productSessionId).slice(0, 40),
          timeoutMs: 100
        });
        expect(removed).toMatchObject({ removed: true });
        await authorityKill(fixture, second.authority);
        finalAuthority = undefined;
      } finally {
        if (finalAuthority !== undefined) await authorityKill(fixture, finalAuthority).catch(() => undefined);
        first?.process.kill("SIGKILL");
        second?.process.kill("SIGKILL");
        firstRunner.process.kill("SIGKILL");
        secondRunner.process.kill("SIGKILL");
        await closeServer(firstTarget.server);
        await closeServer(secondTarget.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.runIf(process.platform === "linux")(
    "keeps exact queued reservations remotely controllable without trusting a client sequence",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let runner: Awaited<ReturnType<typeof remoteRunnerFixture>> | undefined;
      try {
        bridge = await startBridge(
          fixture,
          bootstrap(fixture, 1, "queued-control-bearer-0000000000000", target.port)
        );
        runner = await remoteRunnerFixture(fixture, 1, false);
        runner.process.kill("SIGKILL");
        await processExit(runner.process);
        const statusPath = join(runner.runDirectory, "status.json");
        const ownerPath = join(runner.runDirectory, "owner.json");
        const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
        await writeFile(statusPath, `${JSON.stringify({
          ...status,
          state: "queued",
          runnerPid: 0,
          heartbeatAt: Date.now()
        })}\n`, { mode: 0o600 });
        await writeFile(ownerPath, `${JSON.stringify({
          ...owner,
          state: "reserved",
          runnerPid: 0
        })}\n`, { mode: 0o600 });
        await rm(join(runner.runDirectory, "runner.claim.json"));

        const sessionKey = digest(fixture.productSessionId).slice(0, 40);
        const scanned = await managedStoreRequest(fixture, bridge.authority, {
          operation: "scan",
          sessionId: fixture.productSessionId,
          sessionKey,
          limitBytes: 1024 * 1024
        });
        const runs = scanned["runs"] as Array<Record<string, unknown>>;
        expect(runs[0]?.["controlSafe"]).toBe(true);
        await managedStoreRequest(fixture, bridge.authority, {
          operation: "write-control",
          sessionId: fixture.productSessionId,
          runId: runner.runId,
          runnerInstanceId: runner.runnerFence,
          launchToken: runner.launchToken,
          runnerScriptSha256: fixture.trustedRunnerScriptSha256,
          expectedControlRevision: runs[0]?.["controlRevision"],
          kind: "control",
          value: {
            format: 1,
            requestId: randomUUID(),
            runId: runner.runId,
            launchToken: runner.launchToken,
            productSessionId: fixture.productSessionId,
            productGeneration: 1,
            taskId: "remote-runner-task",
            action: "stop",
            requestedAt: Date.now()
          }
        });
        const written = JSON.parse(await readFile(join(runner.runDirectory, "control.json"), "utf8")) as {
          seq: number;
        };
        expect(written.seq).toBeGreaterThan(0);
        await rm(join(fixture.runRoot, sessionKey), { recursive: true });
        await authorityKill(fixture, bridge.authority);
        bridge = undefined;
      } finally {
        if (bridge !== undefined) await authorityKill(fixture, bridge.authority).catch(() => undefined);
        if (bridge?.process.exitCode === null) bridge.process.kill("SIGKILL");
        if (runner?.process.exitCode === null) runner.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "reclaims an exact manager bootstrap marker left before owner spawn",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      let orphan: ChildProcessWithoutNullStreams | undefined;
      try {
        const value = bootstrap(fixture, 1, "manager-bootstrap-bearer-0000000000", target.port);
        const declared = value["env"] as Record<string, string>;
        const processEnvironment = {
          ...declared,
          JOKO_PI_MCP_TOKEN: "<joko-broker-managed-bearer>",
          JOKO_PI_GENERATION: "<joko-broker-runtime-generation>",
          JOKO_PI_SPAWN_IDENTITY: "<joko-broker-spawn-identity>",
          JOKO_PI_SUBAGENT_NODE_EXECUTABLE: "<joko-broker-node-executable>"
        };
        const environment = Object.entries(processEnvironment)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        const executable = String(value["executable"]);
        const args = value["args"] as readonly string[];
        const cwd = String(value["cwd"]);
        orphan = spawn(process.execPath, args, {
          cwd,
          env: {
            ...process.env,
            JOKO_PI_SPAWN_IDENTITY: String((value.authority as Record<string, unknown>)["spawnIdentity"])
          },
          stdio: ["pipe", "pipe", "pipe"]
        });
        await new Promise<void>((resolveSpawn, rejectSpawn) => {
          orphan!.once("spawn", resolveSpawn);
          orphan!.once("error", rejectSpawn);
        });
        const orphanPid = orphan.pid;
        const effectiveLaunchHash = digest(JSON.stringify({
          hostLaunchHash: value.launchHash,
          executable,
          args,
          cwd,
          environment
        }));
        const sessionRoot = join(fixture.managedRoot, "sessions", fixture.identity);
        await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
        await writeFile(join(sessionRoot, "bootstrap.json"), JSON.stringify({
          version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
          sourceHash: REMOTE_PI_BROKER_SOURCE_SHA256,
          identity: fixture.identity,
          launchHash: effectiveLaunchHash,
          ownerIdentity: digest(randomUUID()),
          spawnIdentity: (value.authority as Record<string, unknown>)["spawnIdentity"],
          childCommandHash: digest([await realpath(process.execPath), ...args].join("\0") + "\0"),
          childExecutableHash: digest(await realpath(process.execPath)),
          childCwdHash: digest(await realpath(cwd)),
          createdAt: Date.now()
        }), { mode: 0o600 });

        bridge = await startBridge(fixture, value);
        const metadata = await brokerMetadata(fixture);
        expect(await processExit(orphan)).not.toBe(0);
        expect(metadata.child.pid).not.toBe(orphanPid);
        expect(() => process.kill(metadata.child.pid, 0)).not.toThrow();
        await expect(lstat(join(sessionRoot, "bootstrap.json"))).rejects.toThrow();
        await authorityKill(fixture, bridge.authority);
        bridge = undefined;
      } finally {
        if (bridge !== undefined) await authorityKill(fixture, bridge.authority).catch(() => undefined);
        bridge?.process.kill("SIGKILL");
        orphan?.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "rolls back the exact child when owner bootstrap fails before metadata commit",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      const nonce = `joko-bootstrap-fault-${randomUUID()}`;
      let bridge: ChildProcessWithoutNullStreams | undefined;
      try {
        const base = bootstrap(fixture, 1, "bootstrap-fault-bearer-000000000000", target.port);
        const env = base["env"] as Record<string, string>;
        const args = [fixture.childPath, nonce];
        const shape = { command: process.execPath, args, cwd: fixture.root, env };
        const candidateProcessLaunchHash = remotePiLaunchHash({
          ...shape,
          env: {
            ...env,
            JOKO_PI_MCP_TOKEN: "<joko-broker-managed-bearer>",
            JOKO_PI_GENERATION: "<joko-broker-runtime-generation>",
            JOKO_PI_SPAWN_IDENTITY: "<joko-broker-spawn-identity>",
            JOKO_PI_SUBAGENT_NODE_EXECUTABLE: "<joko-broker-node-executable>"
          }
        });
        const relay = base["relay"] as { readonly descriptor: Record<string, unknown> };
        const value: BrokerBootstrap = {
          ...base,
          args,
          launchHash: remotePiLaunchHash(shape),
          authority: { ...base.authority, candidateProcessLaunchHash },
          relay: {
            ...relay,
            descriptor: {
              ...relay.descriptor,
              endpoint: `https://127.0.0.1:${target.port}/internal/mcp`
            }
          }
        };
        bridge = spawn(process.execPath, [
          fixture.sourcePath,
          "bridge",
          fixture.managedRoot,
          fixture.identity,
          value.launchHash,
          randomUUID()
        ], {
          env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
          stdio: ["pipe", "pipe", "pipe"]
        });
        bridge.stdin.end(`${JSON.stringify(value)}\n`);
        bridge.stdout.resume();
        bridge.stderr.resume();
        expect(await processExit(bridge)).not.toBe(0);
        await waitUntil(async () => !(await processHasArgument(nonce)));
        await expect(lstat(join(fixture.managedRoot, "sessions", fixture.identity))).rejects.toThrow();
      } finally {
        if (bridge?.exitCode === null) bridge.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it.runIf(process.platform === "linux")(
    "fails closed on permissions, symlinks, forged metadata, and PID reuse",
    async () => {
      const fixture = await brokerFixture();
      const target = await upstream();
      let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
      const metadataPath = join(fixture.managedRoot, "sessions", fixture.identity, "owner.json");
      let original = "";
      try {
        const value = bootstrap(fixture, 1, "metadata-canary-bearer-000000000000", target.port);
        bridge = await startBridge(fixture, value);
        original = await readFile(metadataPath, "utf8");
        const attemptRejected = async (): Promise<void> => {
          const candidate = spawn(process.execPath, [
            fixture.sourcePath,
            "bridge",
            fixture.managedRoot,
            fixture.identity,
            value.launchHash,
            randomUUID()
          ], {
            env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
            stdio: ["pipe", "pipe", "pipe"]
          });
          candidate.stdin.end(`${JSON.stringify({ ...value, authority: { ...value.authority, recovery: bridge!.authority } })}\n`);
          candidate.stdout.resume();
          candidate.stderr.resume();
          expect(await processExit(candidate)).not.toBe(0);
        };

        await chmod(metadataPath, 0o644);
        await attemptRejected();
        await chmod(metadataPath, 0o600);

        const hardlinkPath = `${metadataPath}.hardlink`;
        await link(metadataPath, hardlinkPath);
        await attemptRejected();
        await rm(hardlinkPath);

        const backup = `${metadataPath}.safe`;
        await rename(metadataPath, backup);
        await symlink(backup, metadataPath);
        await attemptRejected();
        await rm(metadataPath);
        await rename(backup, metadataPath);

        const forged = JSON.parse(original) as { child: { pid: number } };
        forged.child.pid = process.pid;
        await writeFile(metadataPath, JSON.stringify(forged), { mode: 0o600 });
        await attemptRejected();
        expect(() => process.kill(process.pid, 0)).not.toThrow();
        await writeFile(metadataPath, original, { mode: 0o600 });
        const live = await brokerMetadata(fixture);
        expect(() => process.kill(live.child.pid, 0)).not.toThrow();

        const linkedRoot = join(fixture.root, "linked-broker-root");
        await symlink(fixture.managedRoot, linkedRoot, "dir");
        const linked = spawn(process.execPath, [
          fixture.sourcePath,
          "bridge",
          linkedRoot,
          fixture.identity,
          value.launchHash,
          randomUUID()
        ], {
          env: { ...process.env, JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 },
          stdio: ["pipe", "pipe", "pipe"]
        });
        linked.stdin.end(`${JSON.stringify({
          ...value,
          authority: { ...value.authority, recovery: bridge.authority }
        })}\n`);
        linked.stdout.resume();
        linked.stderr.resume();
        expect(await processExit(linked)).not.toBe(0);
        await rm(linkedRoot);
        expect(() => process.kill(live.child.pid, 0)).not.toThrow();
        await authorityKill(fixture, bridge.authority);
      } finally {
        if (original !== "") {
          await rm(metadataPath, { force: true }).catch(() => undefined);
          await writeFile(metadataPath, original, { mode: 0o600 }).catch(() => undefined);
        }
        if (bridge !== undefined) await authorityKill(fixture, bridge.authority).catch(() => undefined);
        if (bridge?.process.exitCode === null) bridge.process.kill("SIGKILL");
        await closeServer(target.server);
        try { await exactKill(await managerPid(fixture), "daemon", fixture.sourcePath); } catch { /* already stopped */ }
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
