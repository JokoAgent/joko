import { createHash } from "node:crypto";

export const REMOTE_PI_BROKER_PROTOCOL_VERSION = 1;
export const REMOTE_PI_BROKER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const VERSION = ${REMOTE_PI_BROKER_PROTOCOL_VERSION};
const SOURCE_HASH = process.env.JOKO_REMOTE_BROKER_SOURCE_HASH || "";
const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_ARGS = 512;
const MAX_ENV = 512;
const MAX_TEXT_BYTES = 256 * 1024;
const START_TIMEOUT_MS = 10_000;
const OWNER_CONTROL_TIMEOUT_MS = 10_000;
const AUTHORITY_COMMIT_TIMEOUT_MS = 10_000;
const TERMINAL_RETENTION_MS = 5 * 60_000;
const RELAY_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_RELAY_CONNECTIONS = 64;
const MAX_PENDING_CONTROL_CONNECTIONS = 16;
const MAX_NATIVE_AUTH_GENERATION_FENCES = 4096;
const MAX_NATIVE_AUTH_RESERVATIONS = 4096;
const NATIVE_AUTH_GENERATION_FENCE_IDLE_MS = 60_000;
const MAX_LINUX_UNIX_SOCKET_PATH_BYTES = 107;
const MAX_MANAGED_ARTIFACT_SNAPSHOTS = 4096;
const MAX_MANAGED_ARTIFACT_SNAPSHOT_CHUNKS = 32 * 1024;
const MANAGED_ARTIFACT_CHUNK_BYTES = 256 * 1024;
const MANAGED_ARTIFACT_SNAPSHOT_TTL_MS = 15 * 60_000;
const MANAGED_DELETION_RECEIPT_TTL_MS = 24 * 60 * 60_000;
const MAX_MANAGED_RUNS = 256;
const DISABLED_MANAGED_RUNNER_DIGEST = "0".repeat(64);
const FRAME_STDIN = 1;
const FRAME_STDOUT = 2;
const FRAME_STDERR = 3;
const FRAME_EXIT = 4;
const FRAME_KILL = 5;
const FRAME_OUTPUT_ACK = 6;
const FRAME_INPUT_ACK = 7;
const FRAME_AUTHORITY = 8;
const FRAME_AUTHORITY_COMMIT = 9;
const FRAME_AUTHORITY_COMMIT_ACK = 10;

function fail() { throw new Error("Remote runtime broker rejected an unsafe request."); }
function boundedText(value, maximum = MAX_TEXT_BYTES, empty = false) {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.includes("\0") || Buffer.byteLength(value) > maximum) fail();
  return value;
}
function identity(value) {
  boundedText(value, 64);
  if (!/^[a-f0-9]{32}$/.test(value)) fail();
  return value;
}
function launchHash(value) {
  boundedText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function bearer(value) {
  const accepted = boundedText(value, 4096);
  if (!/^[A-Za-z0-9_-]{32,4096}$/.test(accepted)) fail();
  return accepted;
}
function nativeAuthReservationToken(value) {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  if (Buffer.from(value, "base64url").byteLength !== 32 || Buffer.from(value, "base64url").toString("base64url") !== value) fail();
  return value;
}
function exactSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
function signalName(value) {
  return value === "SIGKILL" ? "SIGKILL" : "SIGTERM";
}
function contained(parent, child) {
  const childPath = relative(parent, child);
  return childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath);
}
async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
  await chmod(path, 0o700);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) fail();
  return canonical;
}
async function atomicJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
async function acquireProcessLock(lockPath, value) {
  await privateDirectory(dirname(lockPath));
  const temporary = lockPath + "." + randomUUID() + ".tmp";
  await mkdir(temporary, { mode: 0o700 });
  try {
    await privateDirectory(temporary);
    await atomicJson(join(temporary, "owner.json"), value);
    try {
      await rename(temporary, lockPath);
      return true;
    } catch (error) {
      if (error && ["EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
      throw error;
    }
  } finally {
    await privateDirectory(temporary).then(() => rm(temporary, { recursive: true })).catch(() => undefined);
  }
}
async function releaseProcessLock(lockPath, expectedPid) {
  await privateDirectory(lockPath);
  const content = await privateRegularFile(join(lockPath, "owner.json"), 4096);
  const value = JSON.parse(content.toString("utf8"));
  if (!value || value.version !== VERSION || value.sourceHash !== SOURCE_HASH || value.pid !== expectedPid) fail();
  await rm(lockPath, { recursive: true });
}
async function processMatches(pid, mode, root) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const commandLine = await readFile("/proc/" + pid + "/cmdline");
    if (commandLine.byteLength > 64 * 1024) return true;
    const fields = commandLine.toString("utf8").split("\0");
    return fields.includes(resolve(process.argv[1])) && fields.includes(mode) && fields.includes(root);
  } catch {
    // Without a trustworthy process-start identity, preserve the lock. PID
    // reuse must never authorize destructive recovery.
    return true;
  }
}
async function reclaimStaleLock(lockPath, mode, root) {
  let owner;
  try {
    await privateDirectory(lockPath);
    const content = await privateRegularFile(join(lockPath, "owner.json"), 4096);
    if (content.byteLength > 4096) return false;
    owner = JSON.parse(content.toString("utf8"));
  } catch { return false; }
  if (!owner || owner.version !== VERSION || owner.sourceHash !== SOURCE_HASH || !Number.isSafeInteger(owner.startedAt)) return false;
  if (await processMatches(owner.pid, mode, root)) return false;
  const info = await lstat(lockPath).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return false;
  await rm(lockPath, { recursive: true });
  return true;
}
function encodeFrame(type, content = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(content)) content = Buffer.from(content);
  if (content.byteLength > MAX_FRAME_BYTES) fail();
  const frame = Buffer.allocUnsafe(5 + content.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(content.byteLength, 1);
  content.copy(frame, 5);
  return frame;
}
function encodeSequencedFrame(type, sequence, content = Buffer.alloc(0)) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail();
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(sequence));
  return encodeFrame(type, Buffer.concat([prefix, content]));
}
function decodeSequencedContent(content) {
  if (content.byteLength < 8) fail();
  const value = content.readBigUInt64BE(0);
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return { sequence: Number(value), content: content.subarray(8) };
}
function frameDecoder(onFrame) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    if (pending.byteLength > MAX_FRAME_BYTES + 5) fail();
    while (pending.byteLength >= 5) {
      const length = pending.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) fail();
      if (pending.byteLength < length + 5) return;
      const type = pending.readUInt8(0);
      const content = pending.subarray(5, length + 5);
      pending = pending.subarray(length + 5);
      onFrame(type, content);
    }
  };
}
function readControlLine(stream) {
  return new Promise((resolveValue, rejectValue) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => {
      stream.off("data", data);
      stream.off("error", reject);
      stream.off("end", ended);
      stream.off("close", ended);
    };
    const reject = () => { cleanup(); rejectValue(new Error("Remote runtime broker control channel failed.")); };
    const ended = () => reject();
    const data = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.byteLength > MAX_CONTROL_BYTES) return reject();
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      const tail = pending.subarray(newline + 1);
      cleanup();
      try { resolveValue({ value: JSON.parse(pending.subarray(0, newline).toString("utf8")), tail }); }
      catch { reject(); }
    };
    if (stream.destroyed || stream.readableEnded) return reject();
    stream.on("data", data);
    stream.once("error", reject);
    stream.once("end", ended);
    stream.once("close", ended);
  });
}
function readBoundedFrame(stream, initial = Buffer.alloc(0), maximum = 64 * 1024) {
  return new Promise((resolveValue, rejectValue) => {
    let pending = Buffer.from(initial);
    const cleanup = () => {
      stream.off("data", data);
      stream.off("error", reject);
      stream.off("end", ended);
      stream.off("close", ended);
    };
    const reject = () => { cleanup(); rejectValue(new Error("Remote runtime broker frame channel failed.")); };
    const ended = () => reject();
    const inspect = () => {
      if (pending.byteLength < 5) return false;
      const length = pending.readUInt32BE(1);
      if (length > maximum) return reject();
      if (pending.byteLength < length + 5) return false;
      const result = {
        type: pending.readUInt8(0),
        content: pending.subarray(5, length + 5),
        tail: pending.subarray(length + 5)
      };
      cleanup();
      resolveValue(result);
      return true;
    };
    const data = (chunk) => {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      if (pending.byteLength > maximum + 5) return reject();
      inspect();
    };
    if (pending.byteLength > maximum + 5) return reject();
    if (inspect()) return;
    if (stream.destroyed || stream.readableEnded) return reject();
    stream.on("data", data);
    stream.once("error", reject);
    stream.once("end", ended);
    stream.once("close", ended);
    stream.resume();
  });
}
function writeControl(stream, value) {
  const content = Buffer.from(JSON.stringify(value) + "\n");
  if (content.byteLength > MAX_CONTROL_BYTES) fail();
  stream.write(content);
}
function normalizeRelay(value, runtimeRoot) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) fail();
  const descriptorPath = resolve(boundedText(value.descriptorPath, 4096));
  if (!contained(runtimeRoot, descriptorPath) || !value.descriptor || typeof value.descriptor !== "object" || Array.isArray(value.descriptor)) fail();
  return { port: value.port, descriptorPath, descriptor: value.descriptor };
}
function normalizeRecovery(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || value.format !== 1) fail();
  const record = {
    format: 1,
    targetId: boundedText(value.targetId, 512),
    hostId: boundedText(value.hostId, 512),
    recoveryIdentity: launchHash(value.recoveryIdentity),
    spawnIdentity: launchHash(value.spawnIdentity),
    runtimeGeneration: Number.isSafeInteger(value.runtimeGeneration) && value.runtimeGeneration >= 0 ? value.runtimeGeneration : fail(),
    compatibilityHash: launchHash(value.compatibilityHash),
    trustedRunnerScriptSha256: launchHash(value.trustedRunnerScriptSha256),
    identity: identity(value.identity),
    launchHash: launchHash(value.launchHash),
    childProcessLaunchHash: launchHash(value.childProcessLaunchHash),
    pid: Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : fail(),
    processStartIdentity: launchHash(value.processStartIdentity),
    startedAt: Number.isSafeInteger(value.startedAt) && value.startedAt > 0 ? value.startedAt : fail(),
    epoch: Number.isSafeInteger(value.epoch) && value.epoch > 0 ? value.epoch : fail(),
    issuedAt: Number.isSafeInteger(value.issuedAt) && value.issuedAt > 0 ? value.issuedAt : fail(),
    attestation: launchHash(value.attestation)
  };
  return record;
}
function normalizeAuthority(value, processLaunchHash) {
  if (!value || typeof value !== "object" || value.format !== 1) fail();
  const declaredProcessLaunchHash = launchHash(value.candidateProcessLaunchHash);
  if (declaredProcessLaunchHash !== processLaunchHash) fail();
  return {
    format: 1,
    targetId: boundedText(value.targetId, 512),
    hostId: boundedText(value.hostId, 512),
    recoveryIdentity: launchHash(value.recoveryIdentity),
    spawnIdentity: launchHash(value.spawnIdentity),
    runtimeGeneration: Number.isSafeInteger(value.runtimeGeneration) && value.runtimeGeneration >= 0 ? value.runtimeGeneration : fail(),
    compatibilityHash: launchHash(value.compatibilityHash),
    trustedRunnerScriptSha256: launchHash(value.trustedRunnerScriptSha256),
    candidateProcessLaunchHash: processLaunchHash,
    recovery: normalizeRecovery(value.recovery)
  };
}
function normalizeEnsure(value, managedRoot) {
  if (!value || typeof value !== "object" || value.action !== "ensure" || value.version !== VERSION) fail();
  const sessionIdentity = identity(value.identity);
  const hostLaunchHash = launchHash(value.launchHash);
  const executable = boundedText(value.executable);
  if (!Array.isArray(value.args) || value.args.length > MAX_ARGS) fail();
  const args = value.args.map((entry) => boundedText(entry, MAX_TEXT_BYTES, true));
  const cwd = resolve(boundedText(value.cwd, 4096));
  if (!isAbsolute(value.cwd)) fail();
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) fail();
  const entries = Object.entries(value.env);
  if (entries.length > MAX_ENV) fail();
  const env = {};
  const declaredEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) {
    const inherited = process.env[name];
    if (typeof inherited === "string") env[name] = boundedText(inherited, MAX_TEXT_BYTES, true);
  }
  let envBytes = 0;
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) fail();
    const accepted = boundedText(entry, MAX_TEXT_BYTES, true);
    envBytes += Buffer.byteLength(name) + Buffer.byteLength(accepted);
    if (envBytes > MAX_CONTROL_BYTES) fail();
    env[name] = accepted;
    declaredEnv[name] = accepted;
  }
  const runtimeRoot = resolve(boundedText(value.runtimeRoot, 4096));
  const productRoot = dirname(managedRoot);
  if (!contained(productRoot, runtimeRoot)) fail();
  const relay = normalizeRelay(value.relay, runtimeRoot);
  const currentBearer = bearer(env.JOKO_PI_MCP_TOKEN);
  const currentNativeAuthReservationToken = value.currentNativeAuthReservationToken === undefined
    ? undefined
    : nativeAuthReservationToken(value.currentNativeAuthReservationToken);
  const processEnvironment = {
    ...declaredEnv,
    JOKO_PI_MCP_TOKEN: "<joko-broker-managed-bearer>",
    ...(declaredEnv.JOKO_PI_GENERATION === undefined ? {} : { JOKO_PI_GENERATION: "<joko-broker-runtime-generation>" }),
    ...(declaredEnv.JOKO_PI_SPAWN_IDENTITY === undefined ? {} : { JOKO_PI_SPAWN_IDENTITY: "<joko-broker-spawn-identity>" }),
    ...(declaredEnv.JOKO_PI_SUBAGENT_NODE_EXECUTABLE === undefined
      ? {}
      : { JOKO_PI_SUBAGENT_NODE_EXECUTABLE: "<joko-broker-node-executable>" }),
    ...(declaredEnv.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN === undefined
      ? {}
      : { JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: "<joko-broker-native-auth-reservation>" })
  };
  const environment = Object.entries(processEnvironment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const processLaunchHash = createHash("sha256").update(JSON.stringify({ command: executable, args, cwd, environment })).digest("hex");
  const authority = normalizeAuthority(value.authority, processLaunchHash);
  const managedEnvironment = [
    declaredEnv.JOKO_PI_SUBAGENT_RUN_ROOT,
    declaredEnv.JOKO_PI_PRODUCT_SESSION_ID,
    declaredEnv.JOKO_PI_SUBAGENT_NODE_EXECUTABLE
  ];
  const managedEnabled = managedEnvironment.every((entry) => entry !== undefined);
  if (
    managedEnvironment.some((entry) => entry !== undefined) !== managedEnabled
    || managedEnabled && (
      !isAbsolute(declaredEnv.JOKO_PI_SUBAGENT_RUN_ROOT)
      || resolve(declaredEnv.JOKO_PI_SUBAGENT_RUN_ROOT) !== declaredEnv.JOKO_PI_SUBAGENT_RUN_ROOT
      || boundedText(declaredEnv.JOKO_PI_PRODUCT_SESSION_ID, 512) !== declaredEnv.JOKO_PI_PRODUCT_SESSION_ID
      || authority.trustedRunnerScriptSha256 === DISABLED_MANAGED_RUNNER_DIGEST
    )
    || !managedEnabled && currentNativeAuthReservationToken !== undefined
    || !managedEnabled && authority.trustedRunnerScriptSha256 !== DISABLED_MANAGED_RUNNER_DIGEST
  ) fail();
  if (
    declaredEnv.JOKO_PI_SPAWN_IDENTITY !== authority.spawnIdentity
    || declaredEnv.JOKO_PI_GENERATION !== String(authority.runtimeGeneration)
    || declaredEnv.JOKO_PI_SUBAGENT_NODE_EXECUTABLE !== undefined
      && declaredEnv.JOKO_PI_SUBAGENT_NODE_EXECUTABLE !== "<joko-broker-node-executable>"
    || (declaredEnv.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN === undefined)
      !== (currentNativeAuthReservationToken === undefined)
    || declaredEnv.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN !== undefined
      && declaredEnv.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN !== "<joko-broker-native-auth-reservation>"
  ) fail();
  const outputCursor = value.outputCursor === undefined ? 0 : value.outputCursor;
  if (!Number.isSafeInteger(outputCursor) || outputCursor < 0) fail();
  const effectiveLaunchHash = createHash("sha256").update(JSON.stringify({ hostLaunchHash, executable, args, cwd, environment })).digest("hex");
  return {
    identity: sessionIdentity,
    launchHash: effectiveLaunchHash,
    childProcessLaunchHash: processLaunchHash,
    executable,
    args,
    cwd,
    env,
    currentBearer,
    currentNativeAuthReservationToken,
    managedEnabled,
    authority,
    outputCursor,
    runtimeRoot,
    relay
  };
}
function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
}
function decimalIdentity(value) {
  boundedText(value, 64);
  if (!/^[0-9]+$/.test(value)) fail();
  return value;
}
function storedFingerprint(value) {
  if (!value || typeof value !== "object") fail();
  return {
    pid: positiveInteger(value.pid),
    startTicks: decimalIdentity(value.startTicks),
    commandHash: launchHash(value.commandHash),
    executableHash: launchHash(value.executableHash)
  };
}
function fingerprintsMatch(left, right) {
  return left !== undefined && left.pid === right.pid && left.startTicks === right.startTicks
    && left.commandHash === right.commandHash && left.executableHash === right.executableHash;
}
function fingerprintIdentity(value) {
  return createHash("sha256").update(JSON.stringify({
    pid: value.pid,
    startTicks: value.startTicks,
    commandHash: value.commandHash,
    executableHash: value.executableHash
  })).digest("hex");
}
async function processFingerprint(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const processInfo = await lstat("/proc/" + pid);
    const processStat = await readFile("/proc/" + pid + "/stat");
    const commandLine = await readFile("/proc/" + pid + "/cmdline");
    if (processStat.byteLength > 16 * 1024 || commandLine.byteLength === 0 || commandLine.byteLength > 64 * 1024) return undefined;
    const statText = processStat.toString("utf8");
    const close = statText.lastIndexOf(")");
    if (close < 1) return undefined;
    const fields = statText.slice(close + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^[0-9]+$/.test(startTicks)) return undefined;
    const executable = await realpath("/proc/" + pid + "/exe");
    const args = commandLine.toString("utf8").split("\0");
    if (args[args.length - 1] === "") args.pop();
    if (args.length === 0 || args.some((entry) => entry.includes("\0"))) return undefined;
    return {
      pid,
      startTicks,
      commandHash: createHash("sha256").update(commandLine).digest("hex"),
      executableHash: createHash("sha256").update(executable).digest("hex"),
      executable,
      uid: processInfo.uid,
      args
    };
  } catch {
    return undefined;
  }
}
async function processHasSpawnIdentity(pid, expected) {
  try {
    const content = await readFile("/proc/" + pid + "/environ");
    if (content.byteLength > 2 * 1024 * 1024) return false;
    return content.toString("utf8").split("\0").includes("JOKO_PI_SPAWN_IDENTITY=" + expected);
  } catch {
    return false;
  }
}
async function bootstrapChildMatches(fingerprint, record) {
  if (
    fingerprint === undefined || fingerprint.uid !== process.getuid?.()
    || fingerprint.commandHash !== record.childCommandHash
    || fingerprint.executableHash !== record.childExecutableHash
  ) return false;
  try {
    const cwd = await realpath("/proc/" + fingerprint.pid + "/cwd");
    return digestBytes(Buffer.from(cwd)) === record.childCwdHash
      && await processHasSpawnIdentity(fingerprint.pid, record.spawnIdentity);
  } catch {
    return false;
  }
}
async function bootstrapOwnerProcess(root, record) {
  const expected = [
    resolve(process.execPath), resolve(process.argv[1]), "owner", root,
    record.identity, record.ownerLaunchHash, record.ownerIdentity
  ];
  if (record.owner !== undefined) {
    const current = await processFingerprint(record.owner.pid);
    if (current === undefined) return undefined;
    if (
      !fingerprintsMatch(current, record.owner) || current.uid !== process.getuid?.()
      || current.args.length !== expected.length
      || !current.args.every((entry, index) => entry === expected[index])
    ) return undefined;
    return current;
  }
  let found;
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const candidate = await processFingerprint(Number(entry));
    if (
      candidate?.uid === process.getuid?.() && candidate.args.length === expected.length
      && candidate.args.every((value, index) => value === expected[index])
    ) {
      if (found !== undefined) fail();
      found = candidate;
    }
  }
  return found;
}
async function bootstrapChildProcess(record) {
  if (record.child !== undefined) {
    const current = await processFingerprint(record.child.pid);
    if (current === undefined) return undefined;
    if (!fingerprintsMatch(current, record.child) || !(await bootstrapChildMatches(current, record))) fail();
    return current;
  }
  let found;
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const candidate = await processFingerprint(Number(entry));
    if (await bootstrapChildMatches(candidate, record)) {
      if (found !== undefined) fail();
      found = candidate;
    }
  }
  return found;
}
async function waitForFingerprint(pid, deadline = Date.now() + START_TIMEOUT_MS) {
  while (Date.now() < deadline) {
    const value = await processFingerprint(pid);
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  fail();
}
async function stopExactProcess(fingerprint, requestedSignal = "SIGTERM") {
  let current = await processFingerprint(fingerprint.pid);
  if (current === undefined) return true;
  if (!fingerprintsMatch(current, fingerprint)) return false;
  try { process.kill(fingerprint.pid, signalName(requestedSignal)); } catch {}
  if (requestedSignal !== "SIGKILL") {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      current = await processFingerprint(fingerprint.pid);
      if (current === undefined || !fingerprintsMatch(current, fingerprint)) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    current = await processFingerprint(fingerprint.pid);
    if (fingerprintsMatch(current, fingerprint)) {
      try { process.kill(fingerprint.pid, "SIGKILL"); } catch {}
    }
  }
  while (fingerprintsMatch(await processFingerprint(fingerprint.pid), fingerprint)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return true;
}
async function closeListeningServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolveClose) => {
    try { server.close(() => resolveClose()); } catch { resolveClose(); }
  });
}
function sameOwner(info) {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}
async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !sameOwner(info)) fail();
  if (await realpath(path) !== resolve(path)) fail();
  return resolve(path);
}
function sameRegularFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
async function privateRegularFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [before, pathBefore, canonicalBefore] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
    if (
      !before.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()
      || !sameRegularFileSnapshot(before, pathBefore) || before.nlink !== 1
      || (before.mode & 0o077) !== 0 || !sameOwner(before) || before.size > maximumBytes
      || canonicalBefore !== resolve(path)
    ) fail();
    const content = await handle.readFile();
    const [after, pathAfter, canonicalAfter] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
    if (
      !after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || !sameRegularFileSnapshot(before, after)
      || !sameRegularFileSnapshot(pathBefore, pathAfter)
      || !sameRegularFileSnapshot(after, pathAfter)
      || after.nlink !== 1 || (after.mode & 0o077) !== 0 || !sameOwner(after)
      || after.size > maximumBytes || content.byteLength !== after.size
      || canonicalAfter !== canonicalBefore || canonicalAfter !== resolve(path)
    ) fail();
    return content;
  } finally {
    await handle.close();
  }
}
function safePrivateRegularSnapshot(info, pathInfo, canonical, path, maximumBytes) {
  if (
    !info.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink()
    || !sameRegularFileSnapshot(info, pathInfo) || info.nlink !== 1
    || (info.mode & 0o077) !== 0 || !sameOwner(info) || info.size > maximumBytes
    || canonical !== resolve(path)
  ) fail();
}
async function privateRegularFileSlice(path, maximumFileBytes, offset, maximumReadBytes) {
  if (
    !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(maximumReadBytes) || maximumReadBytes < 0
  ) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [before, pathBefore, canonicalBefore] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
    safePrivateRegularSnapshot(before, pathBefore, canonicalBefore, path, maximumFileBytes);
    if (offset > before.size) fail();
    const length = Math.min(maximumReadBytes, before.size - offset);
    const content = Buffer.allocUnsafe(length);
    const result = length === 0 ? { bytesRead: 0 } : await handle.read(content, 0, length, offset);
    if (result.bytesRead !== length) fail();
    const [after, pathAfter, canonicalAfter] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
    safePrivateRegularSnapshot(after, pathAfter, canonicalAfter, path, maximumFileBytes);
    if (
      !sameRegularFileSnapshot(before, after)
      || !sameRegularFileSnapshot(pathBefore, pathAfter)
      || canonicalAfter !== canonicalBefore
    ) fail();
    return { content, size: after.size };
  } finally {
    await handle.close();
  }
}
async function privateRegularFileSize(path, maximumFileBytes) {
  const snapshot = await privateRegularFileSlice(path, maximumFileBytes, 0, 0);
  return snapshot.size;
}
async function privateRegularFileSnapshot(path, maximumFileBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [before, pathBefore, canonicalBefore] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
    safePrivateRegularSnapshot(before, pathBefore, canonicalBefore, path, maximumFileBytes);
    const chunkDigests = [];
    for (let position = 0; position < before.size; position += MANAGED_ARTIFACT_CHUNK_BYTES) {
      const length = Math.min(MANAGED_ARTIFACT_CHUNK_BYTES, before.size - position);
      const content = Buffer.allocUnsafe(length);
      let consumed = 0;
      while (consumed < length) {
        const result = await handle.read(content, consumed, length - consumed, position + consumed);
        if (result.bytesRead < 1) fail();
        consumed += result.bytesRead;
      }
      chunkDigests.push(digestBytes(content));
    }
    const contentManifestDigest = digestBytes(Buffer.from(JSON.stringify([
      "joko.managed-store.artifact-prefix.v1",
      before.size,
      MANAGED_ARTIFACT_CHUNK_BYTES,
      ...chunkDigests
    ])));
    const [after, pathAfter, canonicalAfter] = await Promise.all([handle.stat(), lstat(path), realpath(path)]);
    safePrivateRegularSnapshot(after, pathAfter, canonicalAfter, path, maximumFileBytes);
    if (
      !sameRegularFileSnapshot(before, after)
      || !sameRegularFileSnapshot(pathBefore, pathAfter)
      || canonicalAfter !== canonicalBefore
    ) fail();
    return {
      present: true,
      path: resolve(path),
      maximumFileBytes,
      dev: after.dev,
      ino: after.ino,
      nlink: after.nlink,
      mode: after.mode,
      uid: after.uid,
      gid: after.gid,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      chunkDigests,
      contentManifestDigest
    };
  } finally {
    await handle.close();
  }
}
async function privateSocket(path) {
  const info = await lstat(path);
  if (!info.isSocket() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !sameOwner(info)) fail();
  if (await realpath(path) !== resolve(path)) fail();
}
function sessionPaths(root, sessionIdentity) {
  const sessionsRoot = resolve(join(root, "sessions"));
  const sessionRoot = resolve(join(sessionsRoot, sessionIdentity));
  const tombstonePath = resolve(join(sessionsRoot, sessionIdentity + ".tombstone.json"));
  if (!contained(sessionsRoot, sessionRoot) || !contained(sessionsRoot, tombstonePath)) fail();
  return {
    sessionsRoot,
    sessionRoot,
    metadataPath: join(sessionRoot, "owner.json"),
    bootstrapPath: join(sessionRoot, "bootstrap.json"),
    reapedPath: join(sessionRoot, "reaped.json"),
    tombstonePath,
    socketPath: unixSocketPath(sessionRoot, "data"),
    controlSocketPath: unixSocketPath(sessionRoot, "ctl")
  };
}
function unixSocketPath(parent, name) {
  const path = join(parent, name);
  if (process.platform === "linux" && Buffer.byteLength(path) > MAX_LINUX_UNIX_SOCKET_PATH_BYTES) fail();
  return path;
}
function bootstrapRecord(value, expectedIdentity) {
  if (!value || typeof value !== "object" || value.version !== VERSION || value.sourceHash !== SOURCE_HASH) fail();
  if (identity(value.identity) !== expectedIdentity) fail();
  return {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: expectedIdentity,
    launchHash: launchHash(value.launchHash),
    ownerLaunchHash: value.ownerLaunchHash === undefined
      ? launchHash(value.launchHash)
      : launchHash(value.ownerLaunchHash),
    ownerIdentity: launchHash(value.ownerIdentity),
    spawnIdentity: launchHash(value.spawnIdentity),
    childCommandHash: launchHash(value.childCommandHash),
    childExecutableHash: launchHash(value.childExecutableHash),
    childCwdHash: launchHash(value.childCwdHash),
    createdAt: positiveInteger(value.createdAt),
    owner: value.owner === undefined ? undefined : storedFingerprint(value.owner),
    child: value.child === undefined ? undefined : storedFingerprint(value.child)
  };
}
async function readBootstrapRecord(paths, expectedIdentity) {
  await privateDirectory(paths.sessionsRoot);
  await privateDirectory(paths.sessionRoot);
  const content = await privateRegularFile(paths.bootstrapPath, 16 * 1024);
  try { return bootstrapRecord(JSON.parse(content.toString("utf8")), expectedIdentity); }
  catch { fail(); }
}
function storedAuthorityFence(value) {
  if (!value || typeof value !== "object") fail();
  return {
    authorityDigest: launchHash(value.authorityDigest),
    launchHash: launchHash(value.launchHash),
    childProcessLaunchHash: launchHash(value.childProcessLaunchHash),
    trustedRunnerScriptSha256: launchHash(value.trustedRunnerScriptSha256),
    recoveryIdentity: launchHash(value.recoveryIdentity),
    childIdentity: launchHash(value.childIdentity)
  };
}
function authorityFence(authority) {
  return {
    authorityDigest: createHash("sha256").update(JSON.stringify(authority)).digest("hex"),
    launchHash: authority.launchHash,
    childProcessLaunchHash: authority.childProcessLaunchHash,
    trustedRunnerScriptSha256: authority.trustedRunnerScriptSha256,
    recoveryIdentity: authority.recoveryIdentity,
    childIdentity: authority.processStartIdentity
  };
}
function ownerRecord(value, expectedIdentity) {
  if (!value || typeof value !== "object" || value.version !== VERSION || value.sourceHash !== SOURCE_HASH) fail();
  if (identity(value.identity) !== expectedIdentity) fail();
  const record = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: expectedIdentity,
    launchHash: launchHash(value.launchHash),
    ownerLaunchHash: value.ownerLaunchHash === undefined
      ? launchHash(value.launchHash)
      : launchHash(value.ownerLaunchHash),
    childProcessLaunchHash: launchHash(value.childProcessLaunchHash),
    compatibilityHash: launchHash(value.compatibilityHash),
    trustedRunnerScriptSha256: launchHash(value.trustedRunnerScriptSha256),
    recoveryIdentity: launchHash(value.recoveryIdentity),
    ownerIdentity: launchHash(value.ownerIdentity),
    runtimeRoot: resolve(boundedText(value.runtimeRoot, 4096)),
    managedEnabled: value.managedEnabled === true
      ? true
      : value.managedEnabled === false
        ? false
        : fail(),
    managedRunRoot: value.managedRunRoot === undefined
      ? undefined
      : resolve(boundedText(value.managedRunRoot, 4096)),
    productSessionId: value.productSessionId === undefined
      ? undefined
      : boundedText(value.productSessionId, 512),
    childGeneration: Number.isSafeInteger(value.childGeneration) && value.childGeneration >= 0
      ? value.childGeneration
      : fail(),
    nodeExecutable: resolve(boundedText(value.nodeExecutable, 4096)),
    startedAt: positiveInteger(value.startedAt),
    authorityEpoch: positiveInteger(value.authorityEpoch),
    authorityDigest: launchHash(value.authorityDigest),
    committedAuthorityDigest: value.committedAuthorityDigest === undefined
      ? undefined
      : launchHash(value.committedAuthorityDigest),
    committedAuthorityFence: value.committedAuthorityFence === undefined
      ? undefined
      : storedAuthorityFence(value.committedAuthorityFence),
    owner: storedFingerprint(value.owner),
    child: storedFingerprint(value.child),
    janitor: storedFingerprint(value.janitor),
    managedRemoval: value.managedRemoval === undefined
      ? undefined
      : managedRemovalRecord(value.managedRemoval)
  };
  if (
    (record.committedAuthorityDigest === undefined) !== (record.committedAuthorityFence === undefined)
    || record.committedAuthorityFence !== undefined
      && record.committedAuthorityFence.authorityDigest !== record.committedAuthorityDigest
    || record.managedEnabled !== (record.managedRunRoot !== undefined && record.productSessionId !== undefined)
  ) fail();
  return record;
}
async function readOwnerRecord(paths, expectedIdentity) {
  await privateDirectory(paths.sessionsRoot);
  await privateDirectory(paths.sessionRoot);
  const content = await privateRegularFile(paths.metadataPath, 64 * 1024);
  let value;
  try { value = JSON.parse(content.toString("utf8")); } catch { fail(); }
  const record = ownerRecord(value, expectedIdentity);
  const productRoot = dirname(dirname(paths.sessionsRoot));
  if (
    !contained(productRoot, record.runtimeRoot)
    || record.managedEnabled && !isAbsolute(record.managedRunRoot)
    || !isAbsolute(record.nodeExecutable)
  ) fail();
  return record;
}
function ownerMetadata(
  session,
  authority = currentAuthority(session),
  committedAuthority = session.committedAuthority
) {
  return {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: session.identity,
    launchHash: session.launchHash,
    ownerLaunchHash: session.ownerLaunchHash,
    childProcessLaunchHash: authority.childProcessLaunchHash,
    compatibilityHash: session.authority.compatibilityHash,
    trustedRunnerScriptSha256: session.authority.trustedRunnerScriptSha256,
    recoveryIdentity: session.authority.recoveryIdentity,
    ownerIdentity: session.ownerIdentity,
    runtimeRoot: session.runtimeRoot,
    managedEnabled: session.managedEnabled,
    ...(session.managedEnabled ? {
      managedRunRoot: session.env.JOKO_PI_SUBAGENT_RUN_ROOT,
      productSessionId: session.env.JOKO_PI_PRODUCT_SESSION_ID
    } : {}),
    childGeneration: session.childGeneration,
    nodeExecutable: session.nodeExecutable,
    startedAt: session.startedAt,
    authorityEpoch: authority.epoch,
    authorityDigest: createHash("sha256").update(JSON.stringify(authority)).digest("hex"),
    ...(committedAuthority === undefined ? {} : {
      committedAuthorityDigest: createHash("sha256")
        .update(JSON.stringify(committedAuthority))
        .digest("hex"),
      committedAuthorityFence: authorityFence(committedAuthority)
    }),
    owner: session.ownerFingerprint,
    child: session.childFingerprint,
    janitor: session.janitorFingerprint,
    ...(session.managedRemoval === undefined ? {} : { managedRemoval: session.managedRemoval })
  };
}
function authorityBody(session, values = {}) {
  return {
    format: 1,
    targetId: values.targetId === undefined ? session.authority.targetId : values.targetId,
    hostId: values.hostId === undefined ? session.authority.hostId : values.hostId,
    recoveryIdentity: values.recoveryIdentity === undefined ? session.authority.recoveryIdentity : values.recoveryIdentity,
    spawnIdentity: values.spawnIdentity === undefined ? session.authority.spawnIdentity : values.spawnIdentity,
    runtimeGeneration: values.runtimeGeneration === undefined ? session.authority.runtimeGeneration : values.runtimeGeneration,
    compatibilityHash: values.compatibilityHash === undefined ? session.authority.compatibilityHash : values.compatibilityHash,
    trustedRunnerScriptSha256: values.trustedRunnerScriptSha256 === undefined
      ? session.authority.trustedRunnerScriptSha256
      : values.trustedRunnerScriptSha256,
    identity: session.identity,
    launchHash: session.launchHash,
    childProcessLaunchHash: session.childProcessLaunchHash,
    pid: session.childFingerprint.pid,
    processStartIdentity: fingerprintIdentity(session.childFingerprint),
    startedAt: session.startedAt,
    epoch: values.epoch === undefined ? session.authorityEpoch : values.epoch,
    issuedAt: values.issuedAt === undefined ? session.authorityIssuedAt : values.issuedAt
  };
}
function attestAuthority(session, body) {
  return createHmac("sha256", session.recoveryKey).update(JSON.stringify(body)).digest("hex");
}
function currentAuthority(session, values = {}) {
  const body = authorityBody(session, values);
  return { ...body, attestation: attestAuthority(session, body) };
}
function sameAuthority(left, right) {
  if (left === undefined || right === undefined) return false;
  for (const name of [
    "format", "targetId", "hostId", "recoveryIdentity", "spawnIdentity", "runtimeGeneration",
    "compatibilityHash", "trustedRunnerScriptSha256", "identity", "launchHash", "childProcessLaunchHash", "pid",
    "processStartIdentity", "startedAt", "epoch", "issuedAt", "attestation"
  ]) {
    if (left[name] !== right[name]) return false;
  }
  return true;
}
function verifyRecovery(session, recovery) {
  if (recovery === undefined) return { valid: false, authorityVerified: false, reason: "invalid" };
  const body = { ...recovery };
  delete body.attestation;
  const expected = attestAuthority(session, body);
  if (!exactSecret(expected, recovery.attestation)) return { valid: false, authorityVerified: false, reason: "invalid" };
  const current = currentAuthority(session);
  if (sameAuthority(recovery, current)) return { valid: true, authorityVerified: true, source: "provisional" };
  if (sameAuthority(recovery, session.committedAuthority)) {
    return { valid: true, authorityVerified: true, source: "committed" };
  }
  return { valid: false, authorityVerified: false, reason: "invalid" };
}
function verifyManagedRemovalRecovery(session, recovery) {
  if (recovery === undefined || session.managedRemoval === undefined) return false;
  const body = { ...recovery };
  delete body.attestation;
  if (!exactSecret(attestAuthority(session, body), recovery.attestation)) return false;
  return verifiesStoredAuthorityFence(recovery, session.managedRemoval.authorityFence);
}
function authorityScopeMatches(session, next) {
  return next.targetId === session.authority.targetId
    && next.hostId === session.authority.hostId
    && next.recoveryIdentity === session.authority.recoveryIdentity
    && next.compatibilityHash === session.authority.compatibilityHash
    && next.trustedRunnerScriptSha256 === session.authority.trustedRunnerScriptSha256;
}
async function ownerControl(path, request) {
  await privateSocket(path);
  const socket = createConnection(path);
  socket.setTimeout(OWNER_CONTROL_TIMEOUT_MS, () => socket.destroy());
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  writeControl(socket, request);
  const response = await readControlLine(socket);
  socket.end();
  if (!response.value || response.value.ok !== true) fail();
  return response.value;
}
function exactOwnerCommand(fingerprint, root, record) {
  const expected = [
    resolve(process.execPath),
    resolve(process.argv[1]),
    "owner",
    root,
    record.identity,
    record.ownerLaunchHash,
    record.ownerIdentity
  ];
  return fingerprint.args.length === expected.length && fingerprint.args.every((entry, index) => entry === expected[index]);
}
function exactChildCommand(fingerprint, request, executable = request.executable) {
  const expected = [executable, ...request.args];
  return fingerprint.args.length === expected.length && fingerprint.args.every((entry, index) => entry === expected[index]);
}
function exactJanitorCommand(fingerprint, root, record) {
  const expected = [resolve(process.execPath), ...janitorArguments(root, record)];
  return fingerprint.args.length === expected.length
    && fingerprint.args.every((entry, index) => entry === expected[index]);
}
async function inspectLiveOwner(root, sessionIdentity) {
  const paths = sessionPaths(root, sessionIdentity);
  const record = await readOwnerRecord(paths, sessionIdentity);
  await privateSocket(paths.socketPath);
  await privateSocket(paths.controlSocketPath);
  const owner = await processFingerprint(record.owner.pid);
  if (!fingerprintsMatch(owner, record.owner) || !exactOwnerCommand(owner, root, record)) fail();
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const challenge = randomBytes(32).toString("hex");
    const status = await ownerControl(paths.controlSocketPath, { action: "inspect", version: VERSION, challenge });
    if (
      status.challenge !== challenge || status.identity !== record.identity
      || status.launchHash !== record.launchHash || status.ownerIdentity !== record.ownerIdentity
      || typeof status.terminal !== "boolean"
    ) fail();
    const authority = normalizeRecovery(status.authority);
    const committedAuthority = normalizeRecovery(status.committedAuthority);
    if (
      authority === undefined || authority.epoch !== record.authorityEpoch
      || createHash("sha256").update(JSON.stringify(authority)).digest("hex") !== record.authorityDigest
      || (record.committedAuthorityDigest === undefined) !== (committedAuthority === undefined)
      || committedAuthority !== undefined
        && createHash("sha256").update(JSON.stringify(committedAuthority)).digest("hex") !== record.committedAuthorityDigest
    ) fail();
    const janitor = await processFingerprint(record.janitor.pid);
    if (!fingerprintsMatch(janitor, record.janitor) || !exactJanitorCommand(janitor, root, record)) fail();
    if (!status.terminal) {
      const child = await processFingerprint(record.child.pid);
      if (child === undefined && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        continue;
      }
      if (!fingerprintsMatch(child, record.child)) fail();
    }
    return { paths, record, status, authority, committedAuthority };
  }
}
async function writeReaped(paths, record) {
  await privateDirectory(paths.sessionRoot);
  await atomicJson(paths.reapedPath, {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: record.identity,
    ownerIdentity: record.ownerIdentity,
    childIdentity: fingerprintIdentity(record.child),
    reapedAt: Date.now()
  });
}
async function validReaped(paths, record) {
  try {
    const content = await privateRegularFile(paths.reapedPath, 4096);
    const value = JSON.parse(content.toString("utf8"));
    return value && value.version === VERSION && value.sourceHash === SOURCE_HASH
      && value.identity === record.identity && value.ownerIdentity === record.ownerIdentity
      && value.childIdentity === fingerprintIdentity(record.child)
      && Number.isSafeInteger(value.reapedAt) && value.reapedAt > 0;
  } catch {
    return false;
  }
}
function managedRemovalRecord(value) {
  if (!value || typeof value !== "object" || value.format !== 1) fail();
  const sessionId = boundedText(value.sessionId, 512);
  const sessionKey = boundedText(value.sessionKey, 40);
  if (!/^[a-f0-9]{40}$/.test(sessionKey)) fail();
  if (!Array.isArray(value.terminalRunIds) || value.terminalRunIds.length > MAX_MANAGED_RUNS) fail();
  const terminalRunIds = value.terminalRunIds.map((runId) => exactUuid(runId) ? runId : fail());
  if (new Set(terminalRunIds).size !== terminalRunIds.length) fail();
  terminalRunIds.sort();
  const removedAt = positiveInteger(value.removedAt);
  const expiresAt = positiveInteger(value.expiresAt);
  if (expiresAt <= removedAt) fail();
  return {
    format: 1,
    sessionId,
    sessionKey,
    authorityDigest: launchHash(value.authorityDigest),
    authorityFence: storedAuthorityFence(value.authorityFence),
    deletionReceipt: launchHash(value.deletionReceipt),
    terminalRunIds,
    removedAt,
    expiresAt,
    finalizedAt: value.finalizedAt === undefined ? undefined : positiveInteger(value.finalizedAt)
  };
}
function verifiesStoredAuthorityFence(recovery, fence) {
  if (recovery === undefined || fence === undefined) return false;
  return createHash("sha256").update(JSON.stringify(recovery)).digest("hex") === fence.authorityDigest
    && recovery.recoveryIdentity === fence.recoveryIdentity
    && recovery.launchHash === fence.launchHash
    && recovery.childProcessLaunchHash === fence.childProcessLaunchHash
    && recovery.trustedRunnerScriptSha256 === fence.trustedRunnerScriptSha256
    && recovery.processStartIdentity === fence.childIdentity;
}
function tombstoneRecord(value, expectedIdentity) {
  if (!value || typeof value !== "object" || value.version !== VERSION || value.sourceHash !== SOURCE_HASH) fail();
  if (identity(value.identity) !== expectedIdentity) fail();
  const record = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: expectedIdentity,
    ownerIdentity: launchHash(value.ownerIdentity),
    launchHash: launchHash(value.launchHash),
    childProcessLaunchHash: launchHash(value.childProcessLaunchHash),
    trustedRunnerScriptSha256: launchHash(value.trustedRunnerScriptSha256),
    recoveryIdentity: launchHash(value.recoveryIdentity),
    childIdentity: launchHash(value.childIdentity),
    authorityDigest: launchHash(value.authorityDigest),
    committedAuthorityDigest: value.committedAuthorityDigest === undefined
      ? undefined
      : launchHash(value.committedAuthorityDigest),
    committedAuthorityFence: value.committedAuthorityFence === undefined
      ? undefined
      : storedAuthorityFence(value.committedAuthorityFence),
    reapedAt: positiveInteger(value.reapedAt),
    managedRemoval: value.managedRemoval === undefined
      ? undefined
      : managedRemovalRecord(value.managedRemoval)
  };
  if (
    (record.committedAuthorityDigest === undefined) !== (record.committedAuthorityFence === undefined)
    || record.committedAuthorityFence !== undefined
      && record.committedAuthorityFence.authorityDigest !== record.committedAuthorityDigest
    ||
    record.managedRemoval !== undefined
    && record.managedRemoval.authorityDigest !== record.managedRemoval.authorityFence.authorityDigest
  ) fail();
  return record;
}
async function persistTombstone(paths, value) {
  await privateDirectory(paths.sessionsRoot);
  await atomicJson(paths.tombstonePath, {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: value.identity,
    ownerIdentity: value.ownerIdentity,
    launchHash: value.launchHash,
    childProcessLaunchHash: value.childProcessLaunchHash,
    trustedRunnerScriptSha256: value.trustedRunnerScriptSha256,
    recoveryIdentity: value.recoveryIdentity,
    childIdentity: value.childIdentity,
    authorityDigest: value.authorityDigest,
    ...(value.committedAuthorityDigest === undefined ? {} : {
      committedAuthorityDigest: value.committedAuthorityDigest
    }),
    ...(value.committedAuthorityFence === undefined ? {} : {
      committedAuthorityFence: value.committedAuthorityFence
    }),
    reapedAt: value.reapedAt,
    ...(value.managedRemoval === undefined ? {} : { managedRemoval: value.managedRemoval })
  });
}
async function writeTombstone(paths, record) {
  return persistTombstone(paths, {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: record.identity,
    ownerIdentity: record.ownerIdentity,
    launchHash: record.launchHash,
    childProcessLaunchHash: record.childProcessLaunchHash,
    trustedRunnerScriptSha256: record.trustedRunnerScriptSha256,
    recoveryIdentity: record.recoveryIdentity,
    childIdentity: fingerprintIdentity(record.child),
    authorityDigest: record.authorityDigest,
    committedAuthorityDigest: record.committedAuthorityDigest,
    committedAuthorityFence: record.committedAuthorityFence,
    reapedAt: Date.now(),
    managedRemoval: record.managedRemoval
  });
}
async function readTombstone(paths, expectedIdentity) {
  try {
    await privateDirectory(paths.sessionsRoot);
    const content = await privateRegularFile(paths.tombstonePath, 64 * 1024);
    return tombstoneRecord(JSON.parse(content.toString("utf8")), expectedIdentity);
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
function verifiesAbsentAuthority(tombstone, recovery) {
  if (recovery === undefined) return false;
  if (recovery.identity !== tombstone.identity) return false;
  const digest = createHash("sha256").update(JSON.stringify(recovery)).digest("hex");
  const fence = digest === tombstone.authorityDigest
    ? tombstone
    : digest === tombstone.committedAuthorityDigest
      ? tombstone.committedAuthorityFence
      : undefined;
  return verifiesStoredAuthorityFence(recovery, fence);
}
async function absentAuthorityResult(paths, request) {
  const tombstone = await readTombstone(paths, request.identity);
  if (tombstone === undefined) {
    return request.authority.recovery === undefined
      ? undefined
      : { recoveryRejected: true, authorityVerified: false, reason: "invalid" };
  }
  if (request.authority.recovery !== undefined) {
    return verifiesAbsentAuthority(tombstone, request.authority.recovery)
      ? { recoveryRejected: true, authorityVerified: true, reason: "child_absent" }
      : { recoveryRejected: true, authorityVerified: false, reason: "invalid" };
  }
  await privateRegularFile(paths.tombstonePath, 64 * 1024);
  await rm(paths.tombstonePath);
  return undefined;
}
async function managedRemovalTombstoneResult(paths, value, expectedIdentity) {
  const tombstone = await readTombstone(paths, expectedIdentity);
  const recovery = normalizeRecovery(value.authority);
  if (
    tombstone === undefined || recovery === undefined || tombstone.managedRemoval === undefined
    || !verifiesStoredAuthorityFence(recovery, tombstone.managedRemoval.authorityFence)
  ) fail();
  const removal = managedRemovalRecord(tombstone.managedRemoval);
  const presentedDigest = createHash("sha256").update(JSON.stringify(recovery)).digest("hex");
  if (
    presentedDigest !== removal.authorityDigest || Date.now() > removal.expiresAt
    || boundedText(value.sessionId, 512) !== removal.sessionId
    || boundedText(value.sessionKey, 40) !== removal.sessionKey
  ) fail();
  if (value.operation === "stop-remove-session") {
    const timeoutMs = value.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) fail();
    return {
      ok: true,
      authorityVerified: true,
      terminalRunIds: removal.terminalRunIds,
      removed: true,
      deletionReceipt: removal.deletionReceipt
    };
  }
  if (
    value.operation !== "finalize-deletion"
    || launchHash(value.deletionReceipt) !== removal.deletionReceipt
  ) fail();
  const finalizedRemoval = removal.finalizedAt === undefined
    ? managedRemovalRecord({ ...removal, finalizedAt: Date.now() })
    : removal;
  if (removal.finalizedAt === undefined) {
    await persistTombstone(paths, { ...tombstone, managedRemoval: finalizedRemoval });
  }
  return {
    ok: true,
    authorityVerified: true,
    finalized: true,
    deletionReceipt: removal.deletionReceipt
  };
}
function janitorArguments(root, record) {
  return [
    process.argv[1], "janitor", root, record.identity, record.launchHash, record.ownerIdentity,
    String(record.owner.pid), record.owner.startTicks, record.owner.commandHash, record.owner.executableHash,
    String(record.child.pid), record.child.startTicks, record.child.commandHash, record.child.executableHash,
    record.managedEnabled ? "1" : "0",
    record.managedRunRoot || "", record.productSessionId || "",
    String(record.childGeneration), record.nodeExecutable,
    record.trustedRunnerScriptSha256
  ];
}
function safeDaemonEnvironment() {
  const environment = { JOKO_REMOTE_BROKER_SOURCE_HASH: SOURCE_HASH };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return environment;
}
async function spawnRecoveryJanitor(root, paths, record) {
  const janitor = spawn(process.execPath, janitorArguments(root, record), {
    detached: true,
    stdio: "ignore",
    env: safeDaemonEnvironment()
  });
  janitor.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const child = await processFingerprint(record.child.pid);
    if (!fingerprintsMatch(child, record.child)) {
      if (await validReaped(paths, record)) return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  fail();
}
async function cleanupReapedSession(paths, record) {
  if (!(await validReaped(paths, record))) fail();
  const owner = await processFingerprint(record.owner.pid);
  const child = await processFingerprint(record.child.pid);
  if (fingerprintsMatch(owner, record.owner) || fingerprintsMatch(child, record.child)) fail();
  await writeTombstone(paths, record);
  await privateDirectory(paths.sessionRoot);
  await rm(paths.sessionRoot, { recursive: true });
}
async function removeManagedRuntime(root, runtimeRoot) {
  if (!contained(dirname(root), runtimeRoot)) fail();
  const info = await lstat(runtimeRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || !sameOwner(info)) fail();
  if (await realpath(runtimeRoot) !== resolve(runtimeRoot)) fail();
  await rm(runtimeRoot, { recursive: true });
}
async function recoverDeadOwner(root, sessionIdentity) {
  const paths = sessionPaths(root, sessionIdentity);
  let record;
  try {
    record = await readOwnerRecord(paths, sessionIdentity);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  const owner = await processFingerprint(record.owner.pid);
  if (fingerprintsMatch(owner, record.owner)) return false;
  let bootstrap;
  try {
    bootstrap = await readBootstrapRecord(paths, sessionIdentity);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (bootstrap !== undefined) {
    if (
      bootstrap.ownerIdentity !== record.ownerIdentity
      || bootstrap.ownerLaunchHash !== record.ownerLaunchHash
      || await bootstrapOwnerProcess(root, bootstrap) !== undefined
    ) fail();
    const pendingChild = await bootstrapChildProcess(bootstrap);
    if (
      pendingChild !== undefined && !fingerprintsMatch(pendingChild, record.child)
      && !(await stopExactProcess(pendingChild, "SIGTERM"))
    ) fail();
  }
  const observedChild = await processFingerprint(record.child.pid);
  const child = fingerprintsMatch(observedChild, record.child) ? observedChild : undefined;
  if (child !== undefined) await spawnRecoveryJanitor(root, paths, record);
  else if (!(await validReaped(paths, record))) await writeReaped(paths, record);
  await reapManagedRunnersAfterOwnerLoss(record);
  await cleanupReapedSession(paths, record);
  return true;
}
async function spawnBootstrapReaper(root, record, child) {
  const reaper = spawn(process.execPath, [
    process.argv[1], "bootstrap-reaper", root, record.identity, record.launchHash, record.ownerIdentity,
    String(child.pid), child.startTicks, child.commandHash, child.executableHash
  ], { detached: true, stdio: "ignore", env: safeDaemonEnvironment() });
  reaper.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await processFingerprint(child.pid);
    if (current === undefined) return;
    if (!fingerprintsMatch(current, child)) fail();
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  fail();
}
async function spawnBootstrapSentinel(root, record) {
  const sentinel = spawn(process.execPath, [
    process.argv[1], "bootstrap-sentinel", root, record.identity, record.launchHash, record.ownerIdentity
  ], { detached: true, stdio: "ignore", env: safeDaemonEnvironment() });
  sentinel.unref();
  const fingerprint = await waitForFingerprint(sentinel.pid);
  return {
    pid: fingerprint.pid,
    startTicks: fingerprint.startTicks,
    commandHash: fingerprint.commandHash,
    executableHash: fingerprint.executableHash
  };
}
async function runBootstrapSentinel(root, expectedIdentity, expectedHash, expectedOwnerIdentity) {
  const canonicalRoot = await secureDirectory(root);
  if (process.platform !== "linux") fail();
  const paths = sessionPaths(canonicalRoot, expectedIdentity);
  for (;;) {
    const record = await readBootstrapRecord(paths, expectedIdentity);
    if (record.launchHash !== expectedHash || record.ownerIdentity !== expectedOwnerIdentity) fail();
    const owner = await bootstrapOwnerProcess(canonicalRoot, record);
    const child = await bootstrapChildProcess(record);
    if (owner !== undefined) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      continue;
    }
    if (child !== undefined) {
      if (!(await stopExactProcess(child, "SIGTERM"))) fail();
      return;
    }
    if (Date.now() >= record.createdAt + START_TIMEOUT_MS) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
async function recoverIncompleteBootstrap(root, sessionIdentity) {
  const paths = sessionPaths(root, sessionIdentity);
  let record;
  try {
    record = await readBootstrapRecord(paths, sessionIdentity);
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const live = await inspectLiveOwner(root, sessionIdentity);
      if (live.record.ownerIdentity !== record.ownerIdentity) fail();
      return { live };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        const ownerPath = await lstat(paths.metadataPath).catch(() => undefined);
        if (ownerPath !== undefined) throw error;
      }
    }
    const owner = await bootstrapOwnerProcess(root, record);
    if (owner !== undefined) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      continue;
    }
    const child = await bootstrapChildProcess(record);
    if (child !== undefined) await spawnBootstrapReaper(root, record, child);
    if (await bootstrapOwnerProcess(root, record) !== undefined) fail();
    await privateDirectory(paths.sessionRoot);
    await privateRegularFile(paths.bootstrapPath, 16 * 1024);
    await rm(paths.sessionRoot, { recursive: true });
    return { recovered: true };
  }
  fail();
}
function parseRelayRequest(header) {
  const lines = header.split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine) fail();
  const match = /^(POST) (\/internal\/(?:mcp|pi-native-auth)) HTTP\/1\.1$/.exec(requestLine);
  if (!match) fail();
  const headers = [];
  let authorization;
  let generation;
  let nativeAuthReservation;
  let contentLength;
  let contentType;
  for (const line of lines) {
    if (line === "") continue;
    if (/^[ \t]/.test(line)) fail();
    const separator = line.indexOf(":");
    if (separator < 1) fail();
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_|~0-9a-z]+$/.test(name) || /[\r\n\0]/.test(value)) fail();
    if (name === "authorization") {
      if (authorization !== undefined) fail();
      authorization = value;
    } else if (name === "x-joko-pi-generation") {
      if (generation !== undefined) fail();
      generation = value;
    } else if (name === "x-joko-pi-native-auth-reservation") {
      if (nativeAuthReservation !== undefined) fail();
      nativeAuthReservation = nativeAuthReservationToken(value);
    } else if (name === "content-length") {
      if (contentLength !== undefined || !/^[0-9]+$/.test(value)) fail();
      contentLength = Number(value);
    } else if (name === "content-type") {
      if (contentType !== undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)) fail();
      contentType = value;
      headers.push([name, value]);
    } else if (["transfer-encoding", "content-encoding", "expect", "te", "trailer", "upgrade"].includes(name)) {
      fail();
    } else if (name !== "connection" && name !== "proxy-connection") {
      headers.push([name, value]);
    }
  }
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_HTTP_BODY_BYTES) fail();
  if (authorization === undefined || generation === undefined || contentType === undefined || headers.length > 128) fail();
  return { path: match[2], headers, authorization, generation, nativeAuthReservation, contentLength };
}
function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
function exactUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function exactBase64Url(value, length) {
  return typeof value === "string" && value.length === length
    && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}
function exactEd25519PublicKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(value)) fail();
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.byteLength !== 44 || bytes.toString("hex", 0, 12) !== "302a300506032b6570032100"
    || bytes.toString("base64url") !== value
  ) fail();
  return value;
}
function normalizedRunnerProof(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "format,nonce,reservationId,runnerPid,signature"
    || value.format !== 1 || !exactUuid(value.reservationId)
    || !Number.isSafeInteger(value.runnerPid) || value.runnerPid < 1
    || !exactBase64Url(value.nonce, 43) || !exactBase64Url(value.signature, 86)
  ) fail();
  return value;
}
function nativeAuthScope(session, value) {
  const productSessionId = boundedText(session.env.JOKO_PI_PRODUCT_SESSION_ID, 512);
  const targetId = boundedText(value.targetId, 512);
  const providerId = boundedText(value.providerId, 128);
  if (
    value.sessionId !== productSessionId || targetId !== session.authority.targetId
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)
    || !Number.isSafeInteger(value.catalogGeneration) || value.catalogGeneration < 0
    || !exactUuid(value.runId) || !exactUuid(value.runnerFence)
    || !Number.isSafeInteger(value.runnerProductGeneration) || value.runnerProductGeneration < 0
    || value.runnerProductGeneration > session.childGeneration
  ) fail();
  return digestBytes(Buffer.from(JSON.stringify([
    productSessionId,
    targetId,
    providerId,
    value.catalogGeneration,
    value.runId,
    value.runnerFence,
    value.runnerProductGeneration
  ])));
}
function purgeNativeAuthState(session, now = performance.now()) {
  for (const [candidateFence, candidate] of session.nativeAuthGenerations) {
    if (now - candidate.lastSeen > NATIVE_AUTH_GENERATION_FENCE_IDLE_MS) {
      session.nativeAuthGenerations.delete(candidateFence);
    }
  }
  for (const [reservationId, reservation] of session.nativeAuthReservations) {
    if (reservation.deadline <= now) session.nativeAuthReservations.delete(reservationId);
  }
}
function hasNativeAuthReferences(session) {
  purgeNativeAuthState(session);
  return session.nativeAuthGenerations.size > 0 || session.nativeAuthReservations.size > 0;
}
async function trustedExecutable(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) fail();
  return path;
}
async function managedChildExecutable(value) {
  const nodeExecutable = await trustedExecutable(await realpath(process.execPath));
  if (value === "node") return nodeExecutable;
  if (!isAbsolute(value)) fail();
  const executable = await trustedExecutable(await realpath(value));
  if (executable !== value) fail();
  return executable;
}
async function remoteRunnerAttestation(session, value, action, routeGeneration, runnerPid, currentBearer) {
  if (process.platform !== "linux") fail();
  const productSessionId = boundedText(session.env.JOKO_PI_PRODUCT_SESSION_ID, 512);
  const targetId = boundedText(value.targetId, 512);
  const providerId = boundedText(value.providerId, 128);
  const catalogGeneration = value.catalogGeneration;
  if (
    value.sessionId !== productSessionId || targetId !== session.authority.targetId
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)
    || !Number.isSafeInteger(catalogGeneration) || catalogGeneration < 0
    || !Number.isSafeInteger(runnerPid) || runnerPid < 1
  ) fail();
  const configuredRoot = boundedText(session.env.JOKO_PI_SUBAGENT_RUN_ROOT, 4096);
  if (!isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot) fail();
  const runRoot = await privateDirectory(configuredRoot);
  const sessionRoot = resolve(join(runRoot, digestBytes(Buffer.from(productSessionId)).slice(0, 40)));
  const runDirectory = resolve(join(sessionRoot, value.runId));
  if (!contained(runRoot, sessionRoot) || !contained(sessionRoot, runDirectory)) fail();
  await privateDirectory(sessionRoot);
  await privateDirectory(runDirectory);
  const configPath = join(runDirectory, "config.json");
  const statusPath = join(runDirectory, "status.json");
  const ownerPath = join(runDirectory, "owner.json");
  const claimPath = join(runDirectory, "runner.claim.json");
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const [configBytes, statusBytes, ownerBytes, claimBytes, scriptBytes] = await Promise.all([
    privateRegularFile(configPath, 512 * 1024),
    privateRegularFile(statusPath, 512 * 1024),
    privateRegularFile(ownerPath, 512 * 1024),
    privateRegularFile(claimPath, 64 * 1024),
    privateRegularFile(runnerScript, 512 * 1024)
  ]);
  let config;
  let status;
  let owner;
  let claim;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
    status = JSON.parse(statusBytes.toString("utf8"));
    owner = JSON.parse(ownerBytes.toString("utf8"));
    claim = JSON.parse(claimBytes.toString("utf8"));
  } catch { fail(); }
  const runnerScriptDigest = digestBytes(scriptBytes);
  const launchToken = config?.launchToken;
  const taskId = config?.taskId;
  if (
    !exactUuid(value.runId) || !exactUuid(value.runnerFence) || !exactUuid(launchToken)
    || runnerScriptDigest !== session.authority.trustedRunnerScriptSha256
    || !config || config.format !== 1 || config.runId !== value.runId
    || config.runDir !== runDirectory || config.runnerScript !== runnerScript
    || config.runnerScriptSha256 !== runnerScriptDigest || config.productSessionId !== productSessionId
    || config.productGeneration !== value.runnerProductGeneration || config.nativeAuthRequired !== true
    || !config.route || config.route.provider !== providerId
    || !status || status.format !== 1 || status.runId !== value.runId || status.launchToken !== launchToken
    || status.productSessionId !== productSessionId || status.taskId !== taskId
    || status.runnerScript !== runnerScript || status.runnerScriptSha256 !== runnerScriptDigest
    || status.state !== "running" || status.runnerPid !== runnerPid || status.runnerInstanceId !== value.runnerFence
    || !owner || owner.format !== 1 || owner.runId !== value.runId || owner.launchToken !== launchToken
    || owner.productSessionId !== productSessionId || owner.taskId !== taskId
    || owner.runnerScript !== runnerScript || owner.runnerScriptSha256 !== runnerScriptDigest
    || owner.state !== "running" || owner.runnerPid !== runnerPid || owner.runnerInstanceId !== value.runnerFence
    || !claim || claim.format !== 1 || claim.runId !== value.runId || claim.launchToken !== launchToken
    || claim.runnerScriptSha256 !== runnerScriptDigest || claim.runnerPid !== runnerPid
    || claim.runnerInstanceId !== value.runnerFence
  ) fail();
  const nodeExecutable = session.nodeExecutable;
  const fingerprint = await processFingerprint(runnerPid);
  const expectedArgs = [nodeExecutable, runnerScript, configPath];
  if (
    fingerprint === undefined || fingerprint.uid !== process.getuid?.() || fingerprint.executable !== nodeExecutable
    || fingerprint.args.length !== expectedArgs.length
    || !fingerprint.args.every((entry, index) => entry === expectedArgs[index])
  ) fail();
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!exactUuid(bootId)) fail();
  const confirmed = await processFingerprint(runnerPid);
  if (!fingerprintsMatch(confirmed, fingerprint) || confirmed.executable !== nodeExecutable) fail();
  const processIdentity = digestBytes(Buffer.from(JSON.stringify([
    "linux", bootId, runnerPid, fingerprint.startTicks, nodeExecutable
  ])));
  const bindingDigest = digestBytes(Buffer.from(JSON.stringify([
    "joko.pi-native-auth.remote-runner.binding.v1",
    productSessionId,
    targetId,
    providerId,
    catalogGeneration,
    value.runId,
    value.runnerFence,
    value.runnerProductGeneration
  ])));
  const runRootDigest = digestBytes(Buffer.from(runDirectory));
  const configDigest = digestBytes(configBytes);
  const statusDigest = digestBytes(statusBytes);
  const ownerDigest = digestBytes(ownerBytes);
  const claimDigest = digestBytes(claimBytes);
  const issuedAt = Date.now();
  const nonce = randomBytes(32).toString("base64url");
  const message = JSON.stringify([
    "joko.pi-native-auth.remote-runner.attestation.v1",
    action,
    productSessionId,
    targetId,
    providerId,
    catalogGeneration,
    routeGeneration,
    value.runnerProductGeneration,
    value.runId,
    value.runnerFence,
    bindingDigest,
    runnerPid,
    processIdentity,
    runRootDigest,
    runnerScriptDigest,
    configDigest,
    statusDigest,
    ownerDigest,
    claimDigest,
    issuedAt,
    nonce
  ]);
  return {
    format: 1,
    action,
    issuedAt,
    nonce,
    bindingDigest,
    runnerPid,
    processIdentity,
    runRootDigest,
    runnerScriptDigest,
    configDigest,
    statusDigest,
    ownerDigest,
    claimDigest,
    mac: createHmac("sha256", currentBearer).update(message).digest("base64url")
  };
}
async function optionalPrivateRegularFile(path, maximumBytes) {
  try { return await privateRegularFile(path, maximumBytes); }
  catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function optionalPrivateRegularFileSize(path, maximumBytes) {
  try { return await privateRegularFileSize(path, maximumBytes); }
  catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
}
async function optionalPrivateRegularFileSnapshot(path, maximumBytes) {
  try { return await privateRegularFileSnapshot(path, maximumBytes); }
  catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        present: false,
        path: resolve(path),
        maximumFileBytes: maximumBytes,
        size: 0,
        chunkDigests: [],
        contentManifestDigest: digestBytes(Buffer.from(JSON.stringify([
          "joko.managed-store.artifact-prefix.v1",
          0,
          MANAGED_ARTIFACT_CHUNK_BYTES
        ])))
      };
    }
    throw error;
  }
}
function parsedPrivateRecord(content) {
  let value;
  try { value = JSON.parse(content.toString("utf8")); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}
function projectedRecord(value, names) {
  const projected = {};
  for (const name of names) {
    if (value[name] !== undefined) projected[name] = structuredClone(value[name]);
  }
  return projected;
}
const MANAGED_CONFIG_FIELDS = [
  "format", "runId", "launchToken", "runnerScriptSha256", "runnerInstanceId",
  "nativeAuthReservationId", "nativeAuthServiceGeneration", "runnerPublicKeyDigest",
  "productSessionId", "productGeneration", "parentTaskId", "taskId", "childId", "agentName",
  "title", "task", "route", "model", "effort", "toolClass", "readOnly", "nativeAuthRequired",
  "background", "contextMode", "timeoutMs", "turnCount", "createdAt", "nativeSessionId"
];
const MANAGED_STATUS_FIELDS = [
  "format", "runId", "launchToken", "productSessionId", "parentTaskId", "taskId", "childId",
  "agentName", "title", "task", "model", "effort", "toolClass", "readOnly", "contextMode",
  "background", "state", "summary", "error", "createdAt", "startedAt", "endedAt", "heartbeatAt",
  "runnerPid", "runnerInstanceId", "runnerScriptSha256", "nativeAuthReservationId",
  "runnerPublicKeyDigest", "nativeSessionId", "usage", "toolUses", "durationMs", "turnCount",
  "pendingMessageCount", "progressRatio", "lastControl", "pendingApproval", "lastApprovalControl"
];
const MANAGED_OWNER_FIELDS = [
  "format", "runId", "launchToken", "productSessionId", "taskId", "runnerScriptSha256",
  "runnerInstanceId", "nativeAuthReservationId", "runnerPublicKeyDigest", "state", "createdAt",
  "runnerPid", "startedAt"
];
const MANAGED_CLAIM_FIELDS = [
  "format", "runId", "launchToken", "runnerPid", "runnerInstanceId", "runnerScriptSha256",
  "nativeAuthReservationId", "runnerPublicKeyDigest", "claimedAt"
];
function managedSessionLayout(session, sessionId, sessionKey) {
  const expectedSessionId = boundedText(session.env.JOKO_PI_PRODUCT_SESSION_ID, 512);
  if (boundedText(sessionId, 512) !== expectedSessionId) fail();
  const expectedKey = digestBytes(Buffer.from(expectedSessionId)).slice(0, 40);
  if (sessionKey !== undefined && sessionKey !== expectedKey) fail();
  const configuredRoot = boundedText(session.env.JOKO_PI_SUBAGENT_RUN_ROOT, 4096);
  if (!isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot) fail();
  const runRoot = resolve(configuredRoot);
  const sessionRoot = resolve(join(runRoot, expectedKey));
  if (!contained(runRoot, sessionRoot)) fail();
  return { sessionId: expectedSessionId, sessionKey: expectedKey, runRoot, sessionRoot };
}
function assertManagedResponseSecretFree(session, value) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    session.stableBearer,
    session.currentBearer,
    session.stableNativeAuthReservationToken,
    session.currentNativeAuthReservationToken,
    session.recoveryKey
  ]) {
    if (typeof secret === "string" && secret.length > 0 && serialized.includes(secret)) fail();
  }
  return value;
}
async function managedResumeSafety(layout, config, status, runId) {
  const candidate = status.nativeSessionPath;
  if (typeof candidate !== "string" || !isAbsolute(candidate) || resolve(candidate) !== candidate) return false;
  if (!exactUuid(status.nativeSessionId) || !contained(layout.sessionRoot, candidate)) return false;
  const segments = relative(layout.sessionRoot, candidate).split(/[\\/]/);
  if (
    segments.length !== 3 || !exactUuid(segments[0]) || segments[1] !== "sessions"
    || !(segments[2] === status.nativeSessionId + ".jsonl"
      || segments[2].endsWith("_" + status.nativeSessionId + ".jsonl"))
  ) return false;
  if (config.resumeSessionPath !== undefined && segments[0] === runId) return false;
  try {
    await privateRegularFileSize(candidate, 256 * 1024 * 1024);
    return true;
  } catch {
    return false;
  }
}
async function inspectManagedRun(session, sessionId, runId) {
  if (!exactUuid(runId)) fail();
  const layout = managedSessionLayout(session, sessionId);
  await privateDirectory(layout.runRoot);
  await privateDirectory(layout.sessionRoot);
  const runDirectory = resolve(join(layout.sessionRoot, runId));
  if (!contained(layout.sessionRoot, runDirectory)) fail();
  await privateDirectory(runDirectory);
  const configPath = join(runDirectory, "config.json");
  const statusPath = join(runDirectory, "status.json");
  const ownerPath = join(runDirectory, "owner.json");
  const claimPath = join(runDirectory, "runner.claim.json");
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const [
    configBytes,
    statusBytes,
    ownerBytes,
    claimBytes,
    scriptBytes,
    controlBytes,
    approvalControlBytes,
    transcriptSnapshot,
    resultSnapshot
  ] = await Promise.all([
    privateRegularFile(configPath, 512 * 1024),
    privateRegularFile(statusPath, 512 * 1024),
    privateRegularFile(ownerPath, 512 * 1024),
    optionalPrivateRegularFile(claimPath, 64 * 1024),
    privateRegularFile(runnerScript, 512 * 1024),
    optionalPrivateRegularFile(join(runDirectory, "control.json"), 64 * 1024),
    optionalPrivateRegularFile(join(runDirectory, "approval-control.json"), 64 * 1024),
    optionalPrivateRegularFileSnapshot(join(runDirectory, "transcript.jsonl"), 50 * 1024 * 1024),
    optionalPrivateRegularFileSnapshot(join(runDirectory, "result.json"), 512 * 1024)
  ]);
  const config = parsedPrivateRecord(configBytes);
  const status = parsedPrivateRecord(statusBytes);
  const owner = parsedPrivateRecord(ownerBytes);
  const claim = claimBytes === undefined ? undefined : parsedPrivateRecord(claimBytes);
  const runnerScriptSha256 = digestBytes(scriptBytes);
  const runnerInstanceId = config.runnerInstanceId;
  const launchToken = config.launchToken;
  const terminal = ["completed", "failed", "aborted"].includes(status.state);
  if (
    config.format !== 1 || config.runId !== runId || config.runDir !== runDirectory
    || config.runnerScript !== runnerScript || config.runnerScriptSha256 !== runnerScriptSha256
    || runnerScriptSha256 !== session.authority.trustedRunnerScriptSha256
    || config.productSessionId !== layout.sessionId
    || !Number.isSafeInteger(config.productGeneration) || config.productGeneration < 0
    || config.productGeneration > session.childGeneration
    || !exactUuid(runnerInstanceId) || !exactUuid(launchToken)
    || status.format !== 1 || status.runId !== runId || status.launchToken !== launchToken
    || status.productSessionId !== layout.sessionId || status.runnerInstanceId !== runnerInstanceId
    || status.runnerScript !== runnerScript || status.runnerScriptSha256 !== runnerScriptSha256
    || !["queued", "running", "completed", "failed", "aborted"].includes(status.state)
    || !Number.isSafeInteger(status.runnerPid) || status.runnerPid < 0
    || owner.format !== 1 || owner.runId !== runId || owner.launchToken !== launchToken
    || owner.productSessionId !== layout.sessionId || owner.runnerInstanceId !== runnerInstanceId
    || owner.runnerScript !== runnerScript || owner.runnerScriptSha256 !== runnerScriptSha256
    || !["reserved", "running"].includes(owner.state)
  ) fail();
  if (config.nativeAuthRequired === true) {
    if (
      !exactUuid(config.nativeAuthReservationId)
      || !Number.isSafeInteger(config.nativeAuthServiceGeneration) || config.nativeAuthServiceGeneration < 0
      || digestBytes(Buffer.from(exactEd25519PublicKey(config.runnerPublicKey))) !== config.runnerPublicKeyDigest
      || !launchHash(config.runnerPublicKeyDigest)
      || owner.nativeAuthReservationId !== config.nativeAuthReservationId
      || owner.runnerPublicKeyDigest !== config.runnerPublicKeyDigest
      || status.nativeAuthReservationId !== config.nativeAuthReservationId
      || status.runnerPublicKeyDigest !== config.runnerPublicKeyDigest
    ) fail();
  }
  let processIdentity = "absent";
  let runnerFingerprint;
  if (status.runnerPid > 0) {
    const candidate = await processFingerprint(status.runnerPid);
    if (candidate !== undefined) {
      const expectedArgs = [session.nodeExecutable, runnerScript, configPath];
      if (
        candidate.uid !== process.getuid?.() || candidate.executable !== session.nodeExecutable
        || candidate.args.length !== expectedArgs.length
        || !candidate.args.every((entry, index) => entry === expectedArgs[index])
      ) fail();
      const confirmed = await processFingerprint(status.runnerPid);
      if (!fingerprintsMatch(confirmed, candidate)) fail();
      runnerFingerprint = candidate;
      processIdentity = digestBytes(Buffer.from(JSON.stringify([
        candidate.pid, candidate.startTicks, candidate.commandHash, candidate.executableHash
      ])));
    } else if (!terminal) {
      fail();
    }
  } else if (status.state === "running") {
    fail();
  }
  if (runnerFingerprint !== undefined) {
    if (
      !claim || claim.format !== 1 || claim.runId !== runId || claim.launchToken !== launchToken
      || claim.runnerPid !== runnerFingerprint.pid || claim.runnerInstanceId !== runnerInstanceId
      || claim.runnerScriptSha256 !== runnerScriptSha256 || owner.state !== "running"
      || owner.runnerPid !== runnerFingerprint.pid
      || config.nativeAuthRequired === true && (
        claim.nativeAuthReservationId !== config.nativeAuthReservationId
        || claim.runnerPublicKeyDigest !== config.runnerPublicKeyDigest
      )
    ) fail();
  } else if (claim !== undefined && !terminal && status.runnerPid !== 0) {
    fail();
  }
  const resumeSafe = await managedResumeSafety(layout, config, status, runId);
  const runningControlSafe = status.state === "running" && runnerFingerprint !== undefined
    && Number.isFinite(status.heartbeatAt) && status.heartbeatAt <= Date.now() + 2_000
    && Date.now() - status.heartbeatAt <= 15_000;
  const queuedControlSafe = status.state === "queued" && status.runnerPid === 0
    && runnerFingerprint === undefined && claim === undefined && owner.state === "reserved";
  const controlSafe = runningControlSafe || queuedControlSafe;
  const controlRevision = digestBytes(Buffer.from(JSON.stringify([
    "joko.managed-store.control.v1",
    runId,
    digestBytes(configBytes),
    digestBytes(ownerBytes),
    claimBytes === undefined ? "absent" : digestBytes(claimBytes),
    runnerScriptSha256,
    processIdentity,
    status.state,
    status.runnerPid,
    status.pendingMessageCount,
    status.pendingApproval,
    status.lastControl,
    status.lastApprovalControl,
    controlBytes === undefined ? "absent" : digestBytes(controlBytes),
    approvalControlBytes === undefined ? "absent" : digestBytes(approvalControlBytes)
  ])));
  const transcriptBytes = transcriptSnapshot.size;
  const resultBytes = resultSnapshot.size;
  const revision = digestBytes(Buffer.from(JSON.stringify([
    runId,
    digestBytes(configBytes),
    digestBytes(statusBytes),
    digestBytes(ownerBytes),
    claimBytes === undefined ? "absent" : digestBytes(claimBytes),
    runnerScriptSha256,
    controlBytes === undefined ? "absent" : digestBytes(controlBytes),
    approvalControlBytes === undefined ? "absent" : digestBytes(approvalControlBytes),
    transcriptBytes,
    resultBytes,
    processIdentity,
    resumeSafe,
    controlSafe
  ])));
  return {
    runId,
    runnerInstanceId,
    launchToken,
    runnerScriptSha256,
    revision,
    config: projectedRecord(config, MANAGED_CONFIG_FIELDS),
    status: projectedRecord(status, MANAGED_STATUS_FIELDS),
    owner: projectedRecord(owner, MANAGED_OWNER_FIELDS),
    ...(claim === undefined ? {} : { claim: projectedRecord(claim, MANAGED_CLAIM_FIELDS) }),
    transcriptBytes,
    resultBytes,
    resumeSafe,
    controlSafe,
    controlRevision,
    runDirectory,
    configPath,
    statusRecord: status,
    transcriptSnapshot,
    resultSnapshot,
    runnerFingerprint,
    terminal
  };
}
function publicManagedSnapshot(snapshot) {
  const {
    runDirectory,
    configPath,
    statusRecord,
    transcriptSnapshot,
    resultSnapshot,
    runnerFingerprint,
    terminal,
    ...value
  } = snapshot;
  return value;
}
function purgeManagedArtifactSnapshots(session, now = performance.now()) {
  for (const [revision, snapshot] of session.managedArtifactSnapshots) {
    if (snapshot.deadline <= now) {
      session.managedArtifactSnapshots.delete(revision);
      session.managedArtifactSnapshotChunks -= snapshot.chunkDigests.length;
    }
  }
}
function managedArtifactRevision(session, run, kind, artifact) {
  purgeManagedArtifactSnapshots(session);
  const identityParts = artifact.present
    ? [artifact.dev, artifact.ino, artifact.nlink, artifact.mode, artifact.uid, artifact.gid,
        artifact.size, artifact.mtimeMs, artifact.ctimeMs, artifact.contentManifestDigest]
    : ["absent", artifact.contentManifestDigest];
  const revision = createHmac("sha256", session.recoveryKey).update(JSON.stringify([
    "joko.managed-store.artifact-snapshot.v1",
    session.identity,
    run.runId,
    run.runnerInstanceId,
    kind,
    ...identityParts
  ])).digest("hex");
  const existing = session.managedArtifactSnapshots.get(revision);
  if (existing !== undefined) {
    existing.deadline = performance.now() + MANAGED_ARTIFACT_SNAPSHOT_TTL_MS;
    return revision;
  }
  if (
    session.managedArtifactSnapshots.size >= MAX_MANAGED_ARTIFACT_SNAPSHOTS
    || session.managedArtifactSnapshotChunks + artifact.chunkDigests.length
      > MAX_MANAGED_ARTIFACT_SNAPSHOT_CHUNKS
  ) fail();
  session.managedArtifactSnapshotChunks += artifact.chunkDigests.length;
  session.managedArtifactSnapshots.set(revision, {
    revision,
    sessionId: run.config.productSessionId,
    runId: run.runId,
    runnerInstanceId: run.runnerInstanceId,
    kind,
    ...artifact,
    deadline: performance.now() + MANAGED_ARTIFACT_SNAPSHOT_TTL_MS
  });
  return revision;
}
function attachManagedArtifactRevisions(session, snapshot) {
  snapshot.transcriptRevision = managedArtifactRevision(session, snapshot, "transcript", snapshot.transcriptSnapshot);
  snapshot.resultRevision = managedArtifactRevision(session, snapshot, "result", snapshot.resultSnapshot);
  return snapshot;
}
function sameOpenFileIdentity(info, snapshot) {
  return info.dev === snapshot.dev && info.ino === snapshot.ino && info.nlink === snapshot.nlink
    && info.mode === snapshot.mode && info.uid === snapshot.uid && info.gid === snapshot.gid;
}
async function readManagedArtifactSnapshot(snapshot, offset, maximumReadBytes) {
  if (!snapshot.present) return { content: Buffer.alloc(0), size: 0 };
  const handle = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [before, pathBefore, canonicalBefore] = await Promise.all([
      handle.stat(), lstat(snapshot.path), realpath(snapshot.path)
    ]);
    if (
      !before.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()
      || !sameOpenFileIdentity(before, snapshot) || !sameOpenFileIdentity(pathBefore, snapshot)
      || before.nlink !== 1 || (before.mode & 0o077) !== 0 || !sameOwner(before)
      || before.size < snapshot.size || before.size > snapshot.maximumFileBytes
      || canonicalBefore !== resolve(snapshot.path) || offset > snapshot.size
    ) fail();
    const length = Math.min(maximumReadBytes, snapshot.size - offset);
    const content = Buffer.allocUnsafe(length);
    const firstChunk = Math.floor(offset / MANAGED_ARTIFACT_CHUNK_BYTES);
    const lastChunk = length === 0
      ? firstChunk - 1
      : Math.floor((offset + length - 1) / MANAGED_ARTIFACT_CHUNK_BYTES);
    let copied = 0;
    for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
      const chunkOffset = chunkIndex * MANAGED_ARTIFACT_CHUNK_BYTES;
      const chunkLength = Math.min(MANAGED_ARTIFACT_CHUNK_BYTES, snapshot.size - chunkOffset);
      const chunk = Buffer.allocUnsafe(chunkLength);
      let consumed = 0;
      while (consumed < chunkLength) {
        const result = await handle.read(chunk, consumed, chunkLength - consumed, chunkOffset + consumed);
        if (result.bytesRead < 1) fail();
        consumed += result.bytesRead;
      }
      if (digestBytes(chunk) !== snapshot.chunkDigests[chunkIndex]) fail();
      const copyStart = Math.max(offset, chunkOffset) - chunkOffset;
      const copyEnd = Math.min(offset + length, chunkOffset + chunkLength) - chunkOffset;
      if (copyEnd > copyStart) {
        chunk.copy(content, copied, copyStart, copyEnd);
        copied += copyEnd - copyStart;
      }
    }
    if (copied !== length) fail();
    const [after, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat(), lstat(snapshot.path), realpath(snapshot.path)
    ]);
    if (
      !after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || !sameOpenFileIdentity(after, snapshot) || !sameOpenFileIdentity(pathAfter, snapshot)
      || after.nlink !== 1 || (after.mode & 0o077) !== 0 || !sameOwner(after)
      || after.size < snapshot.size || after.size > snapshot.maximumFileBytes
      || canonicalAfter !== canonicalBefore || canonicalAfter !== resolve(snapshot.path)
    ) fail();
    return { content, size: snapshot.size };
  } finally {
    await handle.close();
  }
}
async function scanManagedRuns(session, value) {
  const layout = managedSessionLayout(session, value.sessionId, value.sessionKey);
  const limitBytes = value.limitBytes;
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 1024 * 1024) fail();
  const afterRevision = value.afterRevision === undefined ? undefined : launchHash(value.afterRevision);
  await privateDirectory(layout.runRoot);
  let entries;
  try {
    await privateDirectory(layout.sessionRoot);
    entries = await readdir(layout.sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    entries = [];
  }
  if (entries.length > MAX_MANAGED_RUNS) fail();
  const runIds = [];
  for (const entry of entries) {
    if (entry.name === "slots" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !exactUuid(entry.name)) fail();
    runIds.push(entry.name);
  }
  runIds.sort();
  const snapshots = [];
  for (const runId of runIds) {
    snapshots.push(attachManagedArtifactRevisions(
      session,
      await inspectManagedRun(session, layout.sessionId, runId)
    ));
  }
  const revision = digestBytes(Buffer.from(JSON.stringify([
    layout.sessionId,
    ...snapshots.map((snapshot) => [snapshot.runId, snapshot.revision])
  ])));
  const unchanged = afterRevision === revision;
  const runs = unchanged ? [] : snapshots.map(publicManagedSnapshot);
  const response = assertManagedResponseSecretFree(session, {
    ok: true,
    revision,
    unchanged,
    retryAfterMs: 1_000,
    runs
  });
  if (Buffer.byteLength(JSON.stringify(response)) > Math.min(MAX_CONTROL_BYTES - 4096, limitBytes)) fail();
  return response;
}
async function readManagedTail(session, value) {
  if (!["transcript", "result"].includes(value.pathKind)) fail();
  const artifactRevision = launchHash(value.artifactRevision);
  purgeManagedArtifactSnapshots(session);
  const artifact = session.managedArtifactSnapshots.get(artifactRevision);
  if (
    artifact === undefined || artifact.kind !== value.pathKind || artifact.runId !== value.runId
    || artifact.runnerInstanceId !== value.runnerInstanceId || artifact.sessionId !== value.sessionId
  ) fail();
  managedSessionLayout(session, value.sessionId);
  const offset = value.offset;
  const maximum = value.maxBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024) fail();
  const result = await readManagedArtifactSnapshot(artifact, offset, maximum);
  artifact.deadline = performance.now() + MANAGED_ARTIFACT_SNAPSHOT_TTL_MS;
  const response = {
    ok: true,
    artifactRevision,
    offset,
    nextOffset: offset + result.content.byteLength,
    eof: offset + result.content.byteLength >= result.size,
    content: result.content.toString("base64")
  };
  return assertManagedResponseSecretFree(session, response);
}
function validateManagedControlValue(snapshot, sessionId, kind, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== 1) fail();
  if (
    value.seq !== undefined || !exactUuid(value.requestId)
    || value.runId !== snapshot.runId || value.launchToken !== snapshot.launchToken
    || value.productSessionId !== sessionId || value.productGeneration !== snapshot.config.productGeneration
    || value.taskId !== snapshot.config.taskId || !Number.isFinite(value.requestedAt)
  ) fail();
  if (kind === "control") {
    if (!["stop", "steer", "follow_up"].includes(value.action)) fail();
    if (value.action === "stop") {
      if (value.message !== undefined) fail();
    } else if (typeof value.message !== "string" || value.message.length < 1 || value.message.length > 32_000) fail();
  } else {
    const pendingApproval = snapshot.status.pendingApproval;
    if (
      value.action !== "approval" || value.childId !== snapshot.config.childId
      || !pendingApproval || typeof pendingApproval !== "object" || Array.isArray(pendingApproval)
      || pendingApproval.id !== value.approvalId || pendingApproval.childId !== value.childId
      || typeof value.approvalId !== "string" || value.approvalId.length < 1 || value.approvalId.length > 512
      || !(value.confirmed === true || value.confirmed === false || typeof value.value === "string" || value.cancelled === true)
      || typeof value.value === "string" && value.value.length > 1024
    ) fail();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) fail();
  return structuredClone(value);
}
async function previousManagedControlSequence(snapshot, sessionId, kind) {
  const path = join(snapshot.runDirectory, kind === "control" ? "control.json" : "approval-control.json");
  let bytes;
  try { bytes = await privateRegularFile(path, 64 * 1024); }
  catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
  const record = parsedPrivateRecord(bytes);
  if (
    !Number.isSafeInteger(record.seq) || record.seq < 1 || record.format !== 1
    || !exactUuid(record.requestId) || record.runId !== snapshot.runId
    || record.launchToken !== snapshot.launchToken || record.productSessionId !== sessionId
    || record.productGeneration !== snapshot.config.productGeneration
    || record.taskId !== snapshot.config.taskId || !Number.isFinite(record.requestedAt)
    || kind === "control" && !["stop", "steer", "follow_up"].includes(record.action)
    || kind === "approval" && record.action !== "approval"
  ) fail();
  return record.seq;
}
async function writeManagedControl(session, value) {
  const snapshot = await inspectManagedRun(session, value.sessionId, value.runId);
  if (
    !snapshot.controlSafe
    ||
    value.runnerInstanceId !== snapshot.runnerInstanceId || value.launchToken !== snapshot.launchToken
    || value.runnerScriptSha256 !== snapshot.runnerScriptSha256
    || launchHash(value.expectedControlRevision) !== snapshot.controlRevision
    || !["control", "approval"].includes(value.kind)
  ) fail();
  const requestedControl = validateManagedControlValue(snapshot, value.sessionId, value.kind, value.value);
  const previousSequence = await previousManagedControlSequence(
    snapshot,
    value.sessionId,
    value.kind
  );
  const confirmed = await inspectManagedRun(session, value.sessionId, value.runId);
  if (!confirmed.controlSafe || confirmed.controlRevision !== snapshot.controlRevision) fail();
  const control = {
    ...requestedControl,
    seq: Math.max(previousSequence + 1, Date.now())
  };
  await atomicJson(join(snapshot.runDirectory, value.kind === "control" ? "control.json" : "approval-control.json"), control);
  const refreshed = await inspectManagedRun(session, value.sessionId, value.runId);
  const receipt = digestBytes(Buffer.from(JSON.stringify([
    value.kind,
    snapshot.controlRevision,
    refreshed.controlRevision,
    control.requestId
  ])));
  return assertManagedResponseSecretFree(session, {
    ok: true,
    controlRevision: refreshed.controlRevision,
    receipt
  });
}
async function completeManagedRemoval(session, layout, terminalRunIds) {
  if (session.managedRemoval !== undefined) {
    const previous = managedRemovalRecord(session.managedRemoval);
    if (previous.sessionId !== layout.sessionId || previous.sessionKey !== layout.sessionKey) fail();
    return assertManagedResponseSecretFree(session, {
      ok: true,
      terminalRunIds: previous.terminalRunIds,
      removed: true,
      deletionReceipt: previous.deletionReceipt
    });
  }
  const removedAt = Date.now();
  const removalAuthority = currentAuthority(session);
  const removalAuthorityFence = authorityFence(removalAuthority);
  const authorityDigest = removalAuthorityFence.authorityDigest;
  const exactTerminalRunIds = [...terminalRunIds].sort();
  const deletionReceipt = createHmac("sha256", session.recoveryKey).update(JSON.stringify([
    "joko.managed-store.deletion.v1",
    session.identity,
    authorityDigest,
    layout.sessionId,
    layout.sessionKey,
    exactTerminalRunIds,
    removedAt
  ])).digest("hex");
  session.managedRemoval = managedRemovalRecord({
    format: 1,
    sessionId: layout.sessionId,
    sessionKey: layout.sessionKey,
    authorityDigest,
    authorityFence: removalAuthorityFence,
    deletionReceipt,
    terminalRunIds: exactTerminalRunIds,
    removedAt,
    expiresAt: removedAt + MANAGED_DELETION_RECEIPT_TTL_MS
  });
  await atomicJson(session.metadataPath, ownerMetadata(session));
  return assertManagedResponseSecretFree(session, {
    ok: true,
    terminalRunIds: exactTerminalRunIds,
    removed: true,
    deletionReceipt
  });
}
async function markManagedRunStopped(snapshot, summary) {
  const statusPath = join(snapshot.runDirectory, "status.json");
  const current = parsedPrivateRecord(await privateRegularFile(statusPath, 512 * 1024));
  if (
    current.runId !== snapshot.runId || current.launchToken !== snapshot.launchToken
    || current.runnerInstanceId !== snapshot.runnerInstanceId
    || current.runnerScriptSha256 !== snapshot.runnerScriptSha256
  ) fail();
  if (!["completed", "failed", "aborted"].includes(current.state)) {
    const endedAt = Date.now();
    await atomicJson(statusPath, {
      ...current,
      state: "aborted",
      summary,
      endedAt,
      heartbeatAt: endedAt
    });
  }
  const claimPath = join(snapshot.runDirectory, "runner.claim.json");
  try {
    await privateRegularFile(claimPath, 64 * 1024);
    await rm(claimPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
async function finalizeManagedDeletion(session, value) {
  const layout = managedSessionLayout(session, value.sessionId, value.sessionKey);
  const removal = session.managedRemoval === undefined
    ? undefined
    : managedRemovalRecord(session.managedRemoval);
  if (
    removal === undefined || removal.sessionId !== layout.sessionId || removal.sessionKey !== layout.sessionKey
    || removal.deletionReceipt !== launchHash(value.deletionReceipt) || Date.now() > removal.expiresAt
  ) fail();
  if (removal.finalizedAt === undefined) {
    session.managedRemoval = managedRemovalRecord({ ...removal, finalizedAt: Date.now() });
    await atomicJson(session.metadataPath, ownerMetadata(session));
  }
  return assertManagedResponseSecretFree(session, {
    ok: true,
    finalized: true,
    deletionReceipt: removal.deletionReceipt
  });
}
async function stopAndRemoveManagedSession(session, value) {
  const layout = managedSessionLayout(session, value.sessionId, value.sessionKey);
  if (session.managedRemoval !== undefined) {
    return completeManagedRemoval(session, layout, session.managedRemoval.terminalRunIds);
  }
  const timeoutMs = value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) fail();
  await privateDirectory(layout.runRoot);
  try { await privateDirectory(layout.sessionRoot); }
  catch (error) {
    if (error && error.code === "ENOENT") return completeManagedRemoval(session, layout, []);
    throw error;
  }
  const entries = await readdir(layout.sessionRoot, { withFileTypes: true });
  if (entries.length > MAX_MANAGED_RUNS) fail();
  const snapshots = [];
  for (const entry of entries) {
    if (entry.name === "slots" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !exactUuid(entry.name)) fail();
    snapshots.push(await inspectManagedRun(session, layout.sessionId, entry.name));
  }
  snapshots.sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0);
  for (const snapshot of snapshots) {
    if (snapshot.terminal && snapshot.runnerFingerprint === undefined) continue;
    let previousSequence = 0;
    try {
      const previous = parsedPrivateRecord(await privateRegularFile(join(snapshot.runDirectory, "control.json"), 64 * 1024));
      if (Number.isSafeInteger(previous.seq) && previous.seq > 0) previousSequence = previous.seq;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await atomicJson(join(snapshot.runDirectory, "control.json"), {
      format: 1,
      seq: Math.max(previousSequence + 1, Date.now()),
      requestId: randomUUID(),
      runId: snapshot.runId,
      launchToken: snapshot.launchToken,
      productSessionId: layout.sessionId,
      productGeneration: snapshot.config.productGeneration,
      taskId: snapshot.config.taskId,
      action: "stop",
      requestedAt: Date.now()
    });
  }
  const deadline = performance.now() + timeoutMs;
  const terminalRunIds = new Set();
  while (performance.now() < deadline) {
    for (const original of snapshots) {
      if (terminalRunIds.has(original.runId)) continue;
      try {
        const current = await inspectManagedRun(session, layout.sessionId, original.runId);
        if (current.terminal && current.runnerFingerprint === undefined) terminalRunIds.add(original.runId);
      } catch {
        if (original.runnerFingerprint === undefined) continue;
        const processNow = await processFingerprint(original.runnerFingerprint.pid);
        if (processNow === undefined) terminalRunIds.add(original.runId);
        else if (!fingerprintsMatch(processNow, original.runnerFingerprint)) fail();
      }
    }
    if (terminalRunIds.size === snapshots.length) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (terminalRunIds.size !== snapshots.length) {
    for (const snapshot of snapshots) {
      if (terminalRunIds.has(snapshot.runId) || snapshot.runnerFingerprint === undefined) continue;
      const current = await processFingerprint(snapshot.runnerFingerprint.pid);
      if (current === undefined) {
        terminalRunIds.add(snapshot.runId);
      } else if (!fingerprintsMatch(current, snapshot.runnerFingerprint)) {
        fail();
      } else if (await stopExactProcess(snapshot.runnerFingerprint, "SIGKILL")) {
        terminalRunIds.add(snapshot.runId);
      }
    }
  }
  for (const snapshot of snapshots) {
    if (terminalRunIds.has(snapshot.runId) && !snapshot.terminal) {
      await markManagedRunStopped(snapshot, "durable runner stopped by remote session deletion");
    }
  }
  purgeNativeAuthState(session);
  if (
    terminalRunIds.size !== snapshots.length
    || session.nativeAuthGenerations.size > 0 || session.nativeAuthReservations.size > 0
  ) {
    return assertManagedResponseSecretFree(session, {
      ok: true,
      terminalRunIds: [...terminalRunIds].sort(),
      removed: false
    });
  }
  await privateDirectory(layout.sessionRoot);
  await rm(layout.sessionRoot, { recursive: true });
  const authRoot = resolve(join(dirname(layout.runRoot), "subagent-native-auth"));
  const authSessionRoot = resolve(join(authRoot, layout.sessionKey));
  if (!contained(authRoot, authSessionRoot)) fail();
  try {
    await privateDirectory(authRoot);
    await privateDirectory(authSessionRoot);
    await rm(authSessionRoot, { recursive: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return completeManagedRemoval(session, layout, [...terminalRunIds]);
}
async function managedStoreOperation(session, value) {
  if (value.operation === "scan") return scanManagedRuns(session, value);
  if (value.operation === "read-tail") return readManagedTail(session, value);
  if (value.operation === "write-control") return writeManagedControl(session, value);
  if (value.operation === "stop-remove-session") return stopAndRemoveManagedSession(session, value);
  if (value.operation === "finalize-deletion") return finalizeManagedDeletion(session, value);
  fail();
}
async function hasManagedRunArtifacts(session) {
  if (!session.managedEnabled) return false;
  const layout = managedSessionLayout(session, session.env.JOKO_PI_PRODUCT_SESSION_ID);
  try {
    await privateDirectory(layout.runRoot);
    await privateDirectory(layout.sessionRoot);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  const entries = await readdir(layout.sessionRoot, { withFileTypes: true });
  if (entries.length > MAX_MANAGED_RUNS) fail();
  let found = false;
  for (const entry of entries) {
    if (entry.name === "slots" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !exactUuid(entry.name)) fail();
    await inspectManagedRun(session, layout.sessionId, entry.name);
    found = true;
  }
  return found;
}
async function rewrittenRelayRequest(parsed, body, session, relayAuthority) {
  if (!exactSecret(parsed.authorization, "Bearer " + session.stableBearer)) fail();
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  let routeGeneration = relayAuthority.generation;
  let releaseFence;
  let acquireFence;
  let acquireRecord;
  let touchFence;
  let existingFence;
  let nativeAction;
  let reserveRequest;
  let durableRequest = false;
  let outboundGeneration = routeGeneration;
  if (parsed.path === "/internal/mcp") {
    if (
      parsed.nativeAuthReservation !== undefined
      || String(session.childGeneration) !== parsed.generation
      || !Number.isSafeInteger(value.generation) || value.generation !== session.childGeneration
    ) fail();
    value.generation = routeGeneration;
  } else {
    delete value.remoteRunnerAttestation;
    if (value.currentRouteGeneration !== undefined) fail();
    if (
      !["reserve", "acquire", "validate", "release"].includes(value.action)
      || !Number.isSafeInteger(value.generation) || value.generation < 0
      || String(value.generation) !== parsed.generation
    ) fail();
    const scopeDigest = nativeAuthScope(session, value);
    nativeAction = value.action;
    if (value.action === "reserve") {
      if (
        session.stableNativeAuthReservationToken === undefined
        || relayAuthority.nativeAuthReservationToken === undefined
        || parsed.nativeAuthReservation === undefined
        || !exactSecret(parsed.nativeAuthReservation, session.stableNativeAuthReservationToken)
        || session.terminal || value.generation !== session.childGeneration
        || value.recovery !== undefined || value.recoveryProof !== undefined
        || value.runnerProof !== undefined || value.credential !== undefined
        || !value.runnerRegistration || typeof value.runnerRegistration !== "object"
        || Array.isArray(value.runnerRegistration)
        || Object.keys(value.runnerRegistration).sort().join(",") !== "format,publicKey"
        || value.runnerRegistration.format !== 1
      ) fail();
      const publicKey = exactEd25519PublicKey(value.runnerRegistration.publicKey);
      value.currentRouteGeneration = relayAuthority.generation;
      reserveRequest = {
        scopeDigest,
        publicKey,
        serviceGeneration: relayAuthority.generation,
        runId: value.runId,
        runnerFence: value.runnerFence
      };
    } else {
      if (parsed.nativeAuthReservation !== undefined || value.runnerRegistration !== undefined) fail();
      const durable = value.action === "acquire"
        ? value.recovery !== undefined || value.runnerProof !== undefined
        : value.recoveryProof !== undefined || value.runnerProof !== undefined;
      if (!durable) {
        if (
          session.terminal || value.recovery !== undefined || value.recoveryProof !== undefined
          || value.runnerProof !== undefined
          || value.runnerProductGeneration !== undefined
            && value.runnerProductGeneration !== session.childGeneration
        ) fail();
        if (value.generation !== session.childGeneration) fail();
        value.generation = relayAuthority.generation;
      } else {
        durableRequest = true;
        const proof = normalizedRunnerProof(value.runnerProof);
        const fence = value.runId + ":" + value.runnerFence;
        const now = performance.now();
        purgeNativeAuthState(session, now);
        let runnerPid;
        if (value.action === "acquire") {
          if (
            value.recoveryProof !== undefined
            || !value.recovery || typeof value.recovery !== "object" || Array.isArray(value.recovery)
            || !Number.isSafeInteger(value.recovery.runnerPid) || value.recovery.runnerPid < 1
            || proof.runnerPid !== value.recovery.runnerPid
          ) fail();
          runnerPid = value.recovery.runnerPid;
          existingFence = session.nativeAuthGenerations.get(fence);
          if (existingFence === undefined) {
            const reservation = session.nativeAuthReservations.get(proof.reservationId);
            if (
              reservation === undefined || reservation.scopeDigest !== scopeDigest
              || reservation.serviceGeneration !== value.generation
            ) fail();
            if (session.nativeAuthGenerations.size >= MAX_NATIVE_AUTH_GENERATION_FENCES) fail();
            acquireFence = fence;
          }
        } else {
          if (
            value.recovery !== undefined || !exactBase64Url(value.recoveryProof, 43)
          ) fail();
          existingFence = session.nativeAuthGenerations.get(fence);
          if (!existingFence) fail();
          runnerPid = existingFence.runnerPid;
          if (
            proof.runnerPid !== runnerPid || proof.reservationId !== existingFence.reservationId
            || value.generation !== existingFence.generation
          ) fail();
          if (value.action === "release") releaseFence = fence;
        }
        if (existingFence !== undefined) {
          routeGeneration = existingFence.generation;
          if (
            value.generation !== existingFence.generation || proof.reservationId !== existingFence.reservationId
            || proof.runnerPid !== existingFence.runnerPid || scopeDigest !== existingFence.scopeDigest
          ) fail();
        } else {
          routeGeneration = value.generation;
        }
        outboundGeneration = routeGeneration;
        const attestation = process.platform === "linux"
          ? await remoteRunnerAttestation(
              session,
              value,
              value.action,
              routeGeneration,
              runnerPid,
              relayAuthority.bearer
            )
          : undefined;
        const fenceRecord = {
          generation: routeGeneration,
          reservationId: proof.reservationId,
          scopeDigest,
          runnerPid,
          ...(attestation === undefined ? {} : {
            bindingDigest: attestation.bindingDigest,
            processIdentity: attestation.processIdentity,
            runRootDigest: attestation.runRootDigest,
            runnerScriptDigest: attestation.runnerScriptDigest,
            configDigest: attestation.configDigest,
            ownerDigest: attestation.ownerDigest,
            claimDigest: attestation.claimDigest
          }),
          lastSeen: now
        };
        if (existingFence !== undefined) {
          for (const name of Object.keys(fenceRecord).filter((name) => name !== "lastSeen")) {
            if (existingFence[name] !== fenceRecord[name]) fail();
          }
          if (value.action !== "release") touchFence = fence;
        }
        if (attestation !== undefined) value.remoteRunnerAttestation = attestation;
        if (acquireFence !== undefined) acquireRecord = fenceRecord;
      }
    }
  }
  const content = Buffer.from(JSON.stringify(value));
  if (content.byteLength > MAX_HTTP_BODY_BYTES) fail();
  const lines = [
    "POST " + parsed.path + " HTTP/1.1",
    ...parsed.headers.map(([name, entry]) => name + ": " + entry),
    "authorization: Bearer " + relayAuthority.bearer,
    "x-joko-pi-generation: " + outboundGeneration,
    ...(nativeAction === "reserve"
      ? ["x-joko-pi-native-auth-reservation: " + relayAuthority.nativeAuthReservationToken]
      : []),
    "content-length: " + content.byteLength,
    "connection: close",
    "",
    ""
  ];
  return {
    request: Buffer.concat([Buffer.from(lines.join("\r\n")), content]),
    releaseFence,
    acquireFence,
    acquireRecord,
    touchFence,
    nativeAction,
    reserveRequest,
    durableRequest
  };
}
function successfulNativeAuthResponse(response, action) {
  const boundary = response.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 64 * 1024) return undefined;
  const lines = response.subarray(0, boundary).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.1 ([0-9]{3})(?: |$)/.exec(lines.shift() || "");
  if (!status || Number(status[1]) < 200 || Number(status[1]) > 299) return undefined;
  let contentLength;
  let contentType;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) return undefined;
    const separator = line.indexOf(":");
    if (separator < 1) return undefined;
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "content-length") {
      if (contentLength !== undefined || !/^[0-9]+$/.test(value)) return undefined;
      contentLength = Number(value);
    } else if (name === "content-type") {
      if (contentType !== undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)) return undefined;
      contentType = value;
    } else if (name === "transfer-encoding" || name === "content-encoding") {
      return undefined;
    }
  }
  const body = response.subarray(boundary + 4);
  if (
    !Number.isSafeInteger(contentLength) || contentLength !== body.byteLength
    || contentLength > 4 * 1024 * 1024 || contentType === undefined
  ) return undefined;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value) || value.expiresAt !== undefined) return undefined;
    if (action === "reserve") {
      return value.reserved === true && exactUuid(value.reservationId)
        && Number.isSafeInteger(value.serviceGeneration) && value.serviceGeneration >= 0
        && Number.isSafeInteger(value.validForMs) && value.validForMs >= 1 && value.validForMs <= 60_000
        ? value
        : undefined;
    }
    return typeof value.active === "boolean"
      && (value.active === false
        || Number.isSafeInteger(value.validForMs) && value.validForMs >= 1 && value.validForMs <= 60_000)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
function relayConnection(session, incoming, connections) {
  if (
    session.rotating || session.terminal && !hasNativeAuthReferences(session)
    || connections.size >= MAX_RELAY_CONNECTIONS
  ) return incoming.destroy();
  connections.add(incoming);
  incoming.setTimeout(RELAY_IDLE_TIMEOUT_MS, () => incoming.destroy());
  let pending = Buffer.alloc(0);
  let parsed;
  let upstream;
  const reject = () => {
    incoming.destroy();
    upstream?.destroy();
  };
  const data = async (chunk) => {
    try {
      pending = Buffer.concat([pending, chunk]);
      if (parsed === undefined) {
        const boundary = pending.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (pending.byteLength > 64 * 1024) fail();
          return;
        }
        if (boundary > 64 * 1024) fail();
        parsed = parseRelayRequest(pending.subarray(0, boundary).toString("latin1"));
        pending = pending.subarray(boundary + 4);
      }
      if (pending.byteLength > parsed.contentLength) fail();
      if (pending.byteLength !== parsed.contentLength) return;
      incoming.off("data", data);
      const relayAuthority = {
        epoch: session.authorityEpoch,
        generation: session.authority.runtimeGeneration,
        bearer: session.currentBearer,
        nativeAuthReservationToken: session.currentNativeAuthReservationToken,
        targetPort: session.relayTargetPort
      };
      const rewritten = await rewrittenRelayRequest(parsed, pending, session, relayAuthority);
      if (
        incoming.destroyed || session.rotating || session.terminal && rewritten.durableRequest !== true
        || session.authorityEpoch !== relayAuthority.epoch
        || session.authority.runtimeGeneration !== relayAuthority.generation
        || session.relayTargetPort !== relayAuthority.targetPort
        || !exactSecret(session.currentBearer, relayAuthority.bearer)
        || (session.currentNativeAuthReservationToken === undefined)
          !== (relayAuthority.nativeAuthReservationToken === undefined)
        || session.currentNativeAuthReservationToken !== undefined
          && !exactSecret(
            session.currentNativeAuthReservationToken,
            relayAuthority.nativeAuthReservationToken
          )
      ) fail();
      if (rewritten.acquireFence !== undefined) {
        if (
          session.nativeAuthGenerations.get(rewritten.acquireFence) === undefined
          && session.nativeAuthGenerations.size >= MAX_NATIVE_AUTH_GENERATION_FENCES
        ) fail();
        session.nativeAuthGenerations.set(rewritten.acquireFence, rewritten.acquireRecord);
        session.nativeAuthReservations.delete(rewritten.acquireRecord.reservationId);
      }
      if (rewritten.touchFence !== undefined) {
        const fence = session.nativeAuthGenerations.get(rewritten.touchFence);
        if (fence === undefined) fail();
        fence.lastSeen = performance.now();
      }
      upstream = createConnection({ host: "127.0.0.1", port: relayAuthority.targetPort });
      upstream.setTimeout(RELAY_IDLE_TIMEOUT_MS, () => upstream.destroy());
      upstream.once("connect", () => upstream.end(rewritten.request));
      upstream.once("error", reject);
      let upstreamEnded = false;
      let responseBytes = 0;
      const nativeResponse = [];
      upstream.on("data", (chunk) => {
        responseBytes += chunk.byteLength;
        if (
          responseBytes > MAX_FRAME_BYTES
          || rewritten.nativeAction !== undefined && responseBytes > 4 * 1024 * 1024 + 64 * 1024
        ) return reject();
        if (rewritten.nativeAction !== undefined) {
          nativeResponse.push(Buffer.from(chunk));
        } else if (!incoming.write(chunk)) {
          upstream.pause();
          incoming.once("drain", () => upstream.resume());
        }
      });
      upstream.once("end", () => {
        upstreamEnded = true;
        const responseBytes = Buffer.concat(nativeResponse);
        if (rewritten.nativeAction !== undefined) {
          const response = successfulNativeAuthResponse(responseBytes, rewritten.nativeAction);
          if (response !== undefined && rewritten.reserveRequest !== undefined) {
            if (
              response.serviceGeneration === rewritten.reserveRequest.serviceGeneration
              && session.nativeAuthReservations.size < MAX_NATIVE_AUTH_RESERVATIONS
            ) {
              session.nativeAuthReservations.set(response.reservationId, {
                ...rewritten.reserveRequest,
                deadline: performance.now() + response.validForMs
              });
            } else return reject();
          } else if (response !== undefined && rewritten.releaseFence !== undefined && response.active === false) {
            session.nativeAuthGenerations.delete(rewritten.releaseFence);
          } else if (response !== undefined && response.active === true) {
            const fenceName = rewritten.acquireFence ?? rewritten.touchFence;
            const fence = fenceName === undefined ? undefined : session.nativeAuthGenerations.get(fenceName);
            if (fence !== undefined) fence.lastSeen = performance.now();
          }
          if (session.terminal) session.scheduleTerminalCleanup?.();
          if (!incoming.write(responseBytes)) return incoming.once("drain", () => incoming.end());
        }
        incoming.end();
      });
      upstream.once("close", () => {
        if (!upstreamEnded) reject();
      });
    } catch {
      reject();
    }
  };
  incoming.on("data", data);
  incoming.once("error", reject);
  incoming.once("close", () => {
    connections.delete(incoming);
    upstream?.destroy();
  });
}
async function prepareRelay(session, relay) {
  if (!relay) return undefined;
  const descriptor = structuredClone(relay.descriptor);
  const endpoint = new URL(String(descriptor.endpoint || ""));
  if (
    endpoint.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== "/internal/mcp" || endpoint.search || endpoint.hash
    || Number(endpoint.port || 80) !== relay.port
  ) fail();
  endpoint.hostname = "127.0.0.1";
  endpoint.port = String(session.relayPort);
  descriptor.endpoint = endpoint.toString();
  descriptor.generation = session.childGeneration;
  if (descriptor.nativeAuthLease !== undefined) {
    if (!descriptor.nativeAuthLease || typeof descriptor.nativeAuthLease !== "object" || Array.isArray(descriptor.nativeAuthLease)) fail();
    const nativeEndpoint = new URL(String(descriptor.nativeAuthLease.endpoint || ""));
    if (
      nativeEndpoint.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(nativeEndpoint.hostname)
      || nativeEndpoint.username || nativeEndpoint.password || nativeEndpoint.pathname !== "/internal/pi-native-auth"
      || nativeEndpoint.search || nativeEndpoint.hash
      || Number(nativeEndpoint.port || 80) !== relay.port
    ) fail();
    nativeEndpoint.hostname = "127.0.0.1";
    nativeEndpoint.port = String(session.relayPort);
    descriptor.nativeAuthLease.endpoint = nativeEndpoint.toString();
  }
  await mkdir(dirname(relay.descriptorPath), { recursive: true, mode: 0o700 });
  await privateDirectory(dirname(relay.descriptorPath));
  await atomicJson(relay.descriptorPath, descriptor);
  return relay.port;
}
function appendOutput(session, type, content) {
  const sequence = ++session.outputSequence;
  const frame = encodeSequencedFrame(type, sequence, content);
  if (session.replayTruncated && type !== FRAME_EXIT) {
    const placeholder = encodeSequencedFrame(FRAME_STDERR, sequence);
    session.replay.push({ sequence, frame: placeholder });
    session.replayBytes += placeholder.byteLength;
    if (session.attached && !session.attached.destroyed && !session.attached.write(frame)) {
      session.child.stdout.pause();
      session.child.stderr.pause();
      session.attached.once("drain", () => {
        session.child.stdout.resume();
        session.child.stderr.resume();
      });
    }
    return sequence;
  }
  session.replay.push({ sequence, frame });
  session.replayBytes += frame.byteLength;
  let marker;
  if (session.replayBytes > MAX_REPLAY_BYTES && !session.replayTruncated) {
    session.replayTruncated = true;
    session.replay = session.replay.map((entry) => ({
      sequence: entry.sequence,
      frame: encodeSequencedFrame(FRAME_STDERR, entry.sequence)
    }));
    session.replayBytes = session.replay.reduce((total, entry) => total + entry.frame.byteLength, 0);
    const markerSequence = ++session.outputSequence;
    marker = encodeSequencedFrame(FRAME_STDERR, markerSequence, Buffer.from("[joko remote replay truncated]\n"));
    session.replay.push({ sequence: markerSequence, frame: marker });
    session.replayBytes += marker.byteLength;
    if (!session.replayStopStarted) {
      session.replayStopStarted = true;
      void stopExactProcess(session.childFingerprint, "SIGKILL").catch(() => { process.exitCode = 1; });
    }
  }
  if (session.attached && !session.attached.destroyed) {
    let writable = session.attached.write(frame);
    if (marker !== undefined) writable = session.attached.write(marker) && writable;
    if (writable) return sequence;
    session.child.stdout.pause();
    session.child.stderr.pause();
    session.attached.once("drain", () => {
      session.child.stdout.resume();
      session.child.stderr.resume();
    });
  }
  return sequence;
}
function appendStdout(session, content) {
  if (session.discardStdoutUntilLf) {
    const boundary = content.indexOf(10);
    if (boundary < 0) return;
    session.discardStdoutUntilLf = false;
    content = content.subarray(boundary + 1);
    session.stdoutAtLineBoundary = true;
    if (content.byteLength === 0) return;
  }
  session.stdoutAtLineBoundary = content.byteLength === 0
    ? session.stdoutAtLineBoundary
    : content[content.byteLength - 1] === 10;
  appendOutput(session, FRAME_STDOUT, content);
}
function secretRedactor(secrets, emit) {
  const patterns = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .map((secret) => Buffer.from(secret));
  if (patterns.length === 0) fail();
  const replacement = Buffer.from("[redacted]");
  let pending = Buffer.alloc(0);
  const drain = (final) => {
    const output = [];
    for (;;) {
      let match = -1;
      let matchedPattern;
      for (const pattern of patterns) {
        const candidate = pending.indexOf(pattern);
        if (candidate >= 0 && (match < 0 || candidate < match)) {
          match = candidate;
          matchedPattern = pattern;
        }
      }
      if (match < 0 || matchedPattern === undefined) break;
      if (match > 0) output.push(pending.subarray(0, match));
      output.push(replacement);
      pending = pending.subarray(match + matchedPattern.byteLength);
    }
    let heldBytes = 0;
    if (!final) {
      for (const pattern of patterns) {
        for (let length = Math.min(pattern.byteLength - 1, pending.byteLength); length > heldBytes; length -= 1) {
          if (pending.subarray(pending.byteLength - length).equals(pattern.subarray(0, length))) {
            heldBytes = length;
            break;
          }
        }
      }
    }
    const safeBytes = pending.byteLength - heldBytes;
    if (safeBytes > 0) output.push(pending.subarray(0, safeBytes));
    pending = pending.subarray(safeBytes);
    if (output.length > 0) emit(output.length === 1 ? output[0] : Buffer.concat(output));
  };
  return {
    write(content) {
      pending = pending.byteLength === 0 ? Buffer.from(content) : Buffer.concat([pending, content]);
      drain(false);
    },
    end() { drain(true); }
  };
}
function acknowledgeOutput(session, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < session.outputAcknowledged || sequence > session.outputSequence) fail();
  session.outputAcknowledged = sequence;
  while (session.replay[0] && session.replay[0].sequence <= sequence) {
    session.replayBytes -= session.replay.shift().frame.byteLength;
  }
}
async function spawnSessionJanitor(session, root) {
  const record = {
    identity: session.identity,
    launchHash: session.launchHash,
    ownerIdentity: session.ownerIdentity,
    owner: session.ownerFingerprint,
    child: session.childFingerprint,
    managedEnabled: session.managedEnabled,
    managedRunRoot: session.managedEnabled ? session.env.JOKO_PI_SUBAGENT_RUN_ROOT : undefined,
    productSessionId: session.managedEnabled ? session.env.JOKO_PI_PRODUCT_SESSION_ID : undefined,
    childGeneration: session.childGeneration,
    nodeExecutable: session.nodeExecutable,
    trustedRunnerScriptSha256: session.authority.trustedRunnerScriptSha256
  };
  const janitor = spawn(process.execPath, janitorArguments(root, record), {
    detached: true,
    stdio: "ignore",
    env: safeDaemonEnvironment()
  });
  janitor.unref();
  const fingerprint = await waitForFingerprint(janitor.pid);
  session.janitor = janitor;
  session.janitorFingerprint = {
    pid: fingerprint.pid,
    startTicks: fingerprint.startTicks,
    commandHash: fingerprint.commandHash,
    executableHash: fingerprint.executableHash
  };
}
async function runSessionOwner(root, request, ownerIdentity) {
  const paths = sessionPaths(root, request.identity);
  await privateDirectory(paths.sessionsRoot);
  await privateDirectory(paths.sessionRoot);
  const bootstrapMarker = await readBootstrapRecord(paths, request.identity);
  if (
    bootstrapMarker.launchHash !== request.launchHash || bootstrapMarker.ownerIdentity !== ownerIdentity
    || bootstrapMarker.spawnIdentity !== request.authority.spawnIdentity
  ) fail();
  const relayConnections = new Set();
  let session;
  let child;
  let childFingerprintFull;
  let bootstrapSentinelFingerprint;
  let closeOwner;
  let terminate;
  let bindChild;
  let controlTail = Promise.resolve();
  let acceptControlSocket;
  const pendingControlSockets = [];
  const relayServer = createServer((incoming) => {
    if (!session) return incoming.destroy();
    relayConnection(session, incoming, relayConnections);
  });
  const socketServer = createServer();
  const controlServer = createServer((socket) => {
    if (acceptControlSocket === undefined) {
      if (pendingControlSockets.length >= MAX_PENDING_CONTROL_CONNECTIONS) return socket.destroy();
      pendingControlSockets.push(socket);
      socket.once("close", () => {
        const index = pendingControlSockets.indexOf(socket);
        if (index >= 0) pendingControlSockets.splice(index, 1);
      });
      return;
    }
    acceptControlSocket(socket);
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      relayServer.once("error", rejectListen);
      relayServer.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
    });
    const relayAddress = relayServer.address();
    if (!relayAddress || typeof relayAddress === "string") fail();
    await new Promise((resolveListen, rejectListen) => {
      socketServer.once("error", rejectListen);
      socketServer.listen(paths.socketPath, resolveListen);
    });
    await chmod(paths.socketPath, 0o600);
    await new Promise((resolveListen, rejectListen) => {
      controlServer.once("error", rejectListen);
      controlServer.listen(paths.controlSocketPath, resolveListen);
    });
    await chmod(paths.controlSocketPath, 0o600);
    const ownerFingerprintFull = await waitForFingerprint(process.pid);
    const ownerFingerprint = {
      pid: ownerFingerprintFull.pid,
      startTicks: ownerFingerprintFull.startTicks,
      commandHash: ownerFingerprintFull.commandHash,
      executableHash: ownerFingerprintFull.executableHash
    };
    await atomicJson(paths.bootstrapPath, {
      ...bootstrapMarker,
      owner: ownerFingerprint
    });
    bootstrapSentinelFingerprint = await spawnBootstrapSentinel(root, {
      ...bootstrapMarker,
      owner: ownerFingerprint
    });
    const nodeExecutable = await trustedExecutable(await realpath(process.execPath));
    const childExecutable = await managedChildExecutable(request.executable);
    const stableBearer = randomBytes(32).toString("base64url");
    const stableNativeAuthReservationToken = request.currentNativeAuthReservationToken === undefined
      ? undefined
      : randomBytes(32).toString("base64url");
    const recoveryKey = randomBytes(32);
    const childEnvironment = {
      ...request.env,
      JOKO_PI_MCP_TOKEN: stableBearer,
      ...(stableNativeAuthReservationToken === undefined
        ? {}
        : { JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: stableNativeAuthReservationToken }),
      ...(request.env.JOKO_PI_SUBAGENT_NODE_EXECUTABLE === undefined
        ? {}
        : { JOKO_PI_SUBAGENT_NODE_EXECUTABLE: nodeExecutable })
    };
    child = spawn(childExecutable, request.args, {
      cwd: request.cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const childSpawn = new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    const childExit = new Promise((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    await childSpawn;
    childFingerprintFull = await waitForFingerprint(child.pid);
    if (!(await bootstrapChildMatches(childFingerprintFull, bootstrapMarker))) fail();
    const startedAt = Date.now();
    session = {
      ...request,
      ...paths,
      ownerIdentity,
      ownerLaunchHash: request.launchHash,
      ownerFingerprint,
      childFingerprint: {
        pid: childFingerprintFull.pid,
        startTicks: childFingerprintFull.startTicks,
        commandHash: childFingerprintFull.commandHash,
        executableHash: childFingerprintFull.executableHash
      },
      child,
      childExecutable,
      stableBearer,
      stableNativeAuthReservationToken,
      recoveryKey,
      nodeExecutable,
      currentBearer: request.currentBearer,
      currentNativeAuthReservationToken: request.currentNativeAuthReservationToken,
      childGeneration: request.authority.runtimeGeneration,
      authority: { ...request.authority },
      authorityEpoch: 1,
      authorityIssuedAt: startedAt,
      committedAuthority: undefined,
      relayServer,
      relayPort: relayAddress.port,
      relayTargetPort: undefined,
      socketServer,
      controlServer,
      attached: undefined,
      replay: [],
      replayBytes: 0,
      replayTruncated: false,
      replayStopStarted: false,
      outputSequence: 0,
      outputAcknowledged: 0,
      inputAcknowledged: 0,
      inputTail: Promise.resolve(),
      nativeAuthGenerations: new Map(),
      nativeAuthReservations: new Map(),
      managedArtifactSnapshots: new Map(),
      managedArtifactSnapshotChunks: 0,
      managedRemoval: undefined,
      childLaunchSerial: 0,
      stdoutAtLineBoundary: true,
      discardStdoutUntilLf: false,
      terminal: false,
      terminalSequence: undefined,
      terminalPromise: undefined,
      resolveTerminal: undefined,
      terminalRetentionUntil: undefined,
      scheduleTerminalCleanup: undefined,
      cleanupTimer: undefined,
      commitTimer: undefined,
      rotating: true,
      closing: false,
      committed: false,
      startedAt
    };
    session.terminalPromise = new Promise((resolveTerminal) => { session.resolveTerminal = resolveTerminal; });
    closeOwner = async (removeRuntime) => {
      if (session.closing) return;
      session.closing = true;
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.commitTimer) clearTimeout(session.commitTimer);
      session.attached?.destroy();
      for (const connection of relayConnections) connection.destroy();
      if (!session.terminal && !(await stopExactProcess(session.childFingerprint, "SIGTERM"))) fail();
      if (
        session.janitorFingerprint !== undefined
        && !(await stopExactProcess(session.janitorFingerprint, "SIGTERM"))
      ) fail();
      await Promise.all([
        closeListeningServer(socketServer),
        closeListeningServer(controlServer),
        closeListeningServer(relayServer)
      ]);
      if (session.committed) {
        const currentChild = await processFingerprint(session.childFingerprint.pid);
        if (fingerprintsMatch(currentChild, session.childFingerprint)) fail();
        await writeTombstone(paths, ownerRecord(ownerMetadata(session), session.identity));
      }
      await privateDirectory(paths.sessionRoot);
      await rm(paths.sessionRoot, { recursive: true });
      if (removeRuntime) await removeManagedRuntime(root, session.runtimeRoot).catch(() => undefined);
    };
    terminate = async (requestedSignal = "SIGTERM") => {
      if (session.terminal) return;
      if (!(await stopExactProcess(session.childFingerprint, signalName(requestedSignal)))) fail();
    };
    session.scheduleTerminalCleanup = (delay = 0) => {
      if (!session.terminal || session.closing) return;
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      session.cleanupTimer = setTimeout(() => {
        void (async () => {
          let hasManagedRuns = true;
          try { hasManagedRuns = await hasManagedRunArtifacts(session); } catch {}
          if (hasNativeAuthReferences(session) || hasManagedRuns) {
            return session.scheduleTerminalCleanup(1_000);
          }
          const remaining = session.terminalRetentionUntil - performance.now();
          if (remaining > 0) return session.scheduleTerminalCleanup(remaining);
          await closeOwner(true);
        })().catch(() => { session.scheduleTerminalCleanup(1_000); });
      }, delay);
      session.cleanupTimer.unref?.();
    };
    bindChild = (nextChild, exit, outputSecrets) => {
      child = nextChild;
      session.child = nextChild;
      const launchSerial = ++session.childLaunchSerial;
      const stdout = secretRedactor(outputSecrets, (content) => appendStdout(session, content));
      const stderr = secretRedactor(outputSecrets, (content) => appendOutput(session, FRAME_STDERR, content));
      nextChild.stdout.on("data", (chunk) => stdout.write(Buffer.from(chunk)));
      nextChild.stdout.once("end", () => stdout.end());
      nextChild.stderr.on("data", (chunk) => stderr.write(Buffer.from(chunk)));
      nextChild.stderr.once("end", () => stderr.end());
      nextChild.once("error", () => undefined);
      void exit.then(({ code, signal }) => {
        if (launchSerial !== session.childLaunchSerial || session.closing) return;
      session.terminal = true;
      session.terminalRetentionUntil = performance.now() + TERMINAL_RETENTION_MS;
      session.terminalSequence = appendOutput(session, FRAME_EXIT, Buffer.from(JSON.stringify({
        code: Number.isSafeInteger(code) ? code : null,
        signal: typeof signal === "string" ? signal : null
      })));
      session.resolveTerminal();
      session.scheduleTerminalCleanup();
      });
    };
    bindChild(child, childExit, [
      stableBearer,
      stableNativeAuthReservationToken,
      request.currentBearer,
      request.currentNativeAuthReservationToken
    ]);
    process.once("SIGTERM", () => { void terminate("SIGTERM"); });
    process.once("SIGHUP", () => undefined);
    await atomicJson(paths.bootstrapPath, {
      ...bootstrapMarker,
      owner: session.ownerFingerprint,
      child: session.childFingerprint
    });
    await spawnSessionJanitor(session, root);
    session.relayTargetPort = await prepareRelay(session, request.relay);
    if (!Number.isSafeInteger(session.relayTargetPort)) fail();
    await atomicJson(paths.metadataPath, ownerMetadata(session));
    await stopExactProcess(bootstrapSentinelFingerprint, "SIGTERM");
    bootstrapSentinelFingerprint = undefined;
    await privateRegularFile(paths.bootstrapPath, 16 * 1024);
    await rm(paths.bootstrapPath);
    session.committed = true;
    session.rotating = false;
    session.commitTimer = setTimeout(() => {
      controlTail = controlTail.catch(() => undefined).then(async () => {
        if (session.committedAuthority !== undefined || session.closing) return;
        await terminate("SIGTERM");
        await session.terminalPromise;
        await closeOwner(false);
      }).catch(() => { process.exitCode = 1; });
    }, AUTHORITY_COMMIT_TIMEOUT_MS);
    session.commitTimer.unref?.();
  } catch (error) {
    if (session !== undefined) {
      session.closing = true;
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      session.attached?.destroy();
    }
    for (const socket of pendingControlSockets.splice(0)) socket.destroy();
    for (const connection of relayConnections) connection.destroy();
    await Promise.all([
      closeListeningServer(socketServer),
      closeListeningServer(controlServer),
      closeListeningServer(relayServer)
    ]);
    let exactChild = childFingerprintFull;
    if (exactChild === undefined && child?.pid !== undefined) {
      const candidate = await processFingerprint(child.pid);
      if (candidate !== undefined && exactChildCommand(candidate, request, await managedChildExecutable(request.executable))) {
        exactChild = candidate;
      }
      else if (candidate !== undefined) throw error;
    }
    if (exactChild !== undefined && !(await stopExactProcess(exactChild, "SIGTERM"))) throw error;
    if (
      session?.janitorFingerprint !== undefined
      && !(await stopExactProcess(session.janitorFingerprint, "SIGTERM"))
    ) throw error;
    if (
      bootstrapSentinelFingerprint !== undefined
    ) await stopExactProcess(bootstrapSentinelFingerprint, "SIGTERM");
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    await privateDirectory(paths.sessionRoot).then(() => rm(paths.sessionRoot, { recursive: true })).catch(() => undefined);
    throw error;
  }

  const relaunchTerminalChild = async (
    replacement,
    nextAuthority,
    verification,
    nextBearer,
    nextNativeAuthReservationToken
  ) => {
    if (!session.terminal || session.closing || session.rotating) fail();
    if (
      replacement.identity !== session.identity
      || replacement.authority.targetId !== session.authority.targetId
      || replacement.authority.hostId !== session.authority.hostId
      || replacement.authority.recoveryIdentity !== session.authority.recoveryIdentity
      || replacement.authority.compatibilityHash !== session.authority.compatibilityHash
      || replacement.authority.trustedRunnerScriptSha256 !== session.authority.trustedRunnerScriptSha256
      || replacement.authority.runtimeGeneration !== session.authority.runtimeGeneration + 1
      || replacement.managedEnabled !== session.managedEnabled
      || replacement.env.JOKO_PI_SUBAGENT_RUN_ROOT !== session.env.JOKO_PI_SUBAGENT_RUN_ROOT
      || replacement.env.JOKO_PI_PRODUCT_SESSION_ID !== session.env.JOKO_PI_PRODUCT_SESSION_ID
      || !exactSecret(replacement.currentBearer, nextBearer)
      || (replacement.currentNativeAuthReservationToken === undefined)
        !== (nextNativeAuthReservationToken === undefined)
      || replacement.currentNativeAuthReservationToken !== undefined
        && !exactSecret(replacement.currentNativeAuthReservationToken, nextNativeAuthReservationToken)
    ) fail();
    session.rotating = true;
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = undefined;
    }
    session.attached?.destroy();
    session.attached = undefined;
    for (const connection of relayConnections) connection.destroy();
    await session.inputTail;
    const recoveryOutputHighWater = session.outputSequence;
    const replacementExecutable = await managedChildExecutable(replacement.executable);
    const replacementCwd = await realpath(replacement.cwd);
    if (replacementCwd !== replacement.cwd) fail();
    const replacementMarker = {
      version: VERSION,
      sourceHash: SOURCE_HASH,
      identity: session.identity,
      launchHash: replacement.launchHash,
      ownerLaunchHash: session.ownerLaunchHash,
      ownerIdentity: session.ownerIdentity,
      spawnIdentity: replacement.authority.spawnIdentity,
      childCommandHash: digestBytes(Buffer.from([
        replacementExecutable,
        ...replacement.args
      ].join("\0") + "\0")),
      childExecutableHash: digestBytes(Buffer.from(replacementExecutable)),
      childCwdHash: digestBytes(Buffer.from(replacementCwd)),
      createdAt: Date.now(),
      owner: session.ownerFingerprint
    };
    await atomicJson(paths.bootstrapPath, replacementMarker);
    let replacementChild;
    let replacementFingerprint;
    let candidateSession;
    let replacementSentinelFingerprint;
    const previousJanitorFingerprint = session.janitorFingerprint;
    try {
      replacementSentinelFingerprint = await spawnBootstrapSentinel(root, replacementMarker);
      const replacementEnvironment = {
        ...replacement.env,
        JOKO_PI_MCP_TOKEN: session.stableBearer,
        ...(session.stableNativeAuthReservationToken === undefined
          ? {}
          : { JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: session.stableNativeAuthReservationToken }),
        ...(replacement.env.JOKO_PI_SUBAGENT_NODE_EXECUTABLE === undefined
          ? {}
          : { JOKO_PI_SUBAGENT_NODE_EXECUTABLE: session.nodeExecutable })
      };
      replacementChild = spawn(replacementExecutable, replacement.args, {
        cwd: replacement.cwd,
        env: replacementEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const replacementSpawn = new Promise((resolveSpawn, rejectSpawn) => {
        replacementChild.once("spawn", resolveSpawn);
        replacementChild.once("error", rejectSpawn);
      });
      const replacementExit = new Promise((resolveExit) => {
        replacementChild.once("close", (code, signal) => resolveExit({ code, signal }));
      });
      await replacementSpawn;
      const replacementFingerprintFull = await waitForFingerprint(replacementChild.pid);
      if (!(await bootstrapChildMatches(replacementFingerprintFull, replacementMarker))) fail();
      replacementFingerprint = {
        pid: replacementFingerprintFull.pid,
        startTicks: replacementFingerprintFull.startTicks,
        commandHash: replacementFingerprintFull.commandHash,
        executableHash: replacementFingerprintFull.executableHash
      };
      await atomicJson(paths.bootstrapPath, {
        ...replacementMarker,
        child: replacementFingerprint
      });
      const issuedAt = Date.now();
      const nextCommittedAuthority = verification.source === "provisional"
        ? currentAuthority(session)
        : session.committedAuthority;
      candidateSession = {
        ...session,
        ...replacement,
        ownerLaunchHash: session.ownerLaunchHash,
        ownerIdentity: session.ownerIdentity,
        ownerFingerprint: session.ownerFingerprint,
        child: replacementChild,
        childFingerprint: replacementFingerprint,
        childExecutable: replacementExecutable,
        stableBearer: session.stableBearer,
        stableNativeAuthReservationToken: session.stableNativeAuthReservationToken,
        recoveryKey: session.recoveryKey,
        nodeExecutable: session.nodeExecutable,
        currentBearer: nextBearer,
        currentNativeAuthReservationToken: nextNativeAuthReservationToken,
        childGeneration: nextAuthority.runtimeGeneration,
        authority: { ...nextAuthority, recovery: undefined },
        authorityEpoch: session.authorityEpoch + 1,
        authorityIssuedAt: issuedAt,
        committedAuthority: nextCommittedAuthority,
        relayServer: session.relayServer,
        relayPort: session.relayPort,
        socketServer: session.socketServer,
        controlServer: session.controlServer,
        attached: undefined,
        stdoutAtLineBoundary: true,
        discardStdoutUntilLf: false,
        replayTruncated: false,
        replayStopStarted: false,
        terminal: false,
        terminalSequence: undefined,
        terminalRetentionUntil: undefined,
        cleanupTimer: undefined,
        rotating: true,
        closing: false,
        committed: true,
        startedAt: issuedAt
      };
      await spawnSessionJanitor(candidateSession, root);
      candidateSession.relayTargetPort = await prepareRelay(candidateSession, replacement.relay);
      if (!Number.isSafeInteger(candidateSession.relayTargetPort)) fail();
      const nextEnvelope = currentAuthority(candidateSession);
      await atomicJson(
        paths.metadataPath,
        ownerMetadata(candidateSession, nextEnvelope, nextCommittedAuthority)
      );
      await stopExactProcess(replacementSentinelFingerprint, "SIGTERM");
      replacementSentinelFingerprint = undefined;
      Object.assign(session, candidateSession);
      session.terminalPromise = new Promise((resolveTerminal) => {
        session.resolveTerminal = resolveTerminal;
      });
      bindChild(replacementChild, replacementExit, [
        session.stableBearer,
        session.stableNativeAuthReservationToken,
        nextBearer,
        nextNativeAuthReservationToken
      ]);
      session.rotating = false;
      await stopExactProcess(previousJanitorFingerprint, "SIGTERM");
      void privateRegularFile(paths.bootstrapPath, 16 * 1024)
        .then(() => rm(paths.bootstrapPath))
        .catch(() => undefined);
      return recoveryOutputHighWater;
    } catch (error) {
      if (
        replacementSentinelFingerprint !== undefined
      ) await stopExactProcess(replacementSentinelFingerprint, "SIGTERM");
      if (
        candidateSession?.janitorFingerprint !== undefined
        && !(await stopExactProcess(candidateSession.janitorFingerprint, "SIGTERM"))
      ) fail();
      if (replacementFingerprint !== undefined) {
        if (!(await stopExactProcess(replacementFingerprint, "SIGTERM"))) fail();
      } else if (replacementChild?.pid !== undefined) {
        const candidate = await processFingerprint(replacementChild.pid);
        if (candidate !== undefined) {
          if (!exactChildCommand(candidate, replacement, replacementExecutable)) fail();
          if (!(await stopExactProcess(candidate, "SIGTERM"))) fail();
        }
      }
      replacementChild?.stdin?.destroy();
      replacementChild?.stdout?.destroy();
      replacementChild?.stderr?.destroy();
      await privateRegularFile(paths.bootstrapPath, 16 * 1024)
        .then(() => rm(paths.bootstrapPath))
        .catch(() => undefined);
      await prepareRelay(session, session.relay).catch(() => undefined);
      session.rotating = false;
      session.scheduleTerminalCleanup();
      throw error;
    }
  };

  socketServer.on("connection", (socket) => {
    if (session.rotating || session.closing) return socket.destroy();
    session.attached?.destroy();
    session.attached = socket;
    for (const entry of session.replay) socket.write(entry.frame);
    const decode = frameDecoder((type, content) => {
      if (type === FRAME_STDIN && !session.terminal) {
        const frame = decodeSequencedContent(content);
        session.inputTail = session.inputTail.then(async () => {
          if (frame.sequence <= session.inputAcknowledged) {
            socket.write(encodeSequencedFrame(FRAME_INPUT_ACK, session.inputAcknowledged));
            return;
          }
          if (frame.sequence !== session.inputAcknowledged + 1) fail();
          await new Promise((resolveWrite, rejectWrite) => {
            child.stdin.write(frame.content, (error) => error ? rejectWrite(error) : resolveWrite());
          });
          session.inputAcknowledged = frame.sequence;
          if (session.attached === socket && !socket.destroyed) socket.write(encodeSequencedFrame(FRAME_INPUT_ACK, frame.sequence));
        }).catch(() => {
          socket.destroy();
          void terminate("SIGTERM");
        });
      } else if (type === FRAME_OUTPUT_ACK) {
        acknowledgeOutput(session, decodeSequencedContent(content).sequence);
      } else if (type === FRAME_KILL) {
        void terminate(content.toString("ascii"));
      } else {
        fail();
      }
    });
    socket.on("data", (chunk) => {
      try { decode(chunk); } catch { socket.destroy(); }
    });
    const detach = () => {
      if (session.attached === socket) session.attached = undefined;
      child.stdout.resume();
      child.stderr.resume();
    };
    socket.once("close", detach);
    socket.once("error", detach);
  });

  acceptControlSocket = (socket) => {
    socket.setTimeout(OWNER_CONTROL_TIMEOUT_MS, () => socket.destroy());
    void readControlLine(socket).then(({ value }) => {
      controlTail = controlTail.catch(() => undefined).then(async () => {
        if (!value || typeof value !== "object" || value.version !== VERSION) fail();
        if (value.action === "inspect") {
          const challenge = boundedText(value.challenge, 64);
          if (!/^[a-f0-9]{64}$/.test(challenge)) fail();
          return {
            ok: true,
            challenge,
            identity: session.identity,
            launchHash: session.launchHash,
            ownerIdentity: session.ownerIdentity,
            terminal: session.terminal,
            authority: currentAuthority(session),
            committedAuthority: session.committedAuthority
          };
        }
        if (value.action === "configure") {
          const nextAuthority = normalizeAuthority(value.authority, launchHash(value.authority.candidateProcessLaunchHash));
          const nextBearer = bearer(value.currentBearer);
          const nextNativeAuthReservationToken = value.currentNativeAuthReservationToken === undefined
            ? undefined
            : nativeAuthReservationToken(value.currentNativeAuthReservationToken);
          const replacement = value.replacement === undefined
            ? undefined
            : normalizeEnsure(value.replacement, root);
          if (
            replacement !== undefined
            && (
              replacement.identity !== session.identity
              || replacement.authority.candidateProcessLaunchHash
                !== nextAuthority.candidateProcessLaunchHash
              || replacement.authority.runtimeGeneration !== nextAuthority.runtimeGeneration
              || replacement.authority.spawnIdentity !== nextAuthority.spawnIdentity
              || replacement.authority.compatibilityHash !== nextAuthority.compatibilityHash
              || replacement.authority.recoveryIdentity !== nextAuthority.recoveryIdentity
              || !exactSecret(replacement.currentBearer, nextBearer)
            )
          ) fail();
          const nextCursor = value.outputCursor;
          if (!Number.isSafeInteger(nextCursor) || nextCursor < 0 || nextCursor > session.outputSequence) fail();
          if (!authorityScopeMatches(session, nextAuthority)) {
            return { ok: true, recoveryRejected: true, authorityVerified: false, reason: "invalid" };
          }
          const sameGeneration = nextAuthority.runtimeGeneration === session.authority.runtimeGeneration;
          const sameBearer = exactSecret(nextBearer, session.currentBearer);
          const sameNativeAuthReservationToken =
            (nextNativeAuthReservationToken === undefined)
              === (session.currentNativeAuthReservationToken === undefined)
            && (nextNativeAuthReservationToken === undefined
              || exactSecret(nextNativeAuthReservationToken, session.currentNativeAuthReservationToken));
          if (
            (session.stableNativeAuthReservationToken === undefined)
              !== (nextNativeAuthReservationToken === undefined)
          ) {
            return { ok: true, recoveryRejected: true, authorityVerified: false, reason: "invalid" };
          }
          let recoveryOutputHighWater;
          if (!sameGeneration || !sameBearer || !sameNativeAuthReservationToken) {
            const verification = verifyRecovery(session, nextAuthority.recovery);
            if (!verification.valid) return { ok: true, recoveryRejected: true, ...verification };
            if (nextAuthority.runtimeGeneration !== session.authority.runtimeGeneration + 1) {
              return { ok: true, recoveryRejected: true, authorityVerified: true, reason: "launch_mismatch" };
            }
            if (session.terminal) {
              if (replacement === undefined) fail();
              recoveryOutputHighWater = await relaunchTerminalChild(
                replacement,
                nextAuthority,
                verification,
                nextBearer,
                nextNativeAuthReservationToken
              );
            } else {
            session.rotating = true;
            session.attached?.destroy();
            session.attached = undefined;
            for (const connection of relayConnections) connection.destroy();
            await session.inputTail;
            recoveryOutputHighWater = session.outputSequence;
            session.discardStdoutUntilLf = !session.stdoutAtLineBoundary;
            const relayTargetPort = await prepareRelay(session, normalizeRelay(value.relay, session.runtimeRoot));
            const issuedAt = Date.now();
            const values = {
              targetId: nextAuthority.targetId,
              hostId: nextAuthority.hostId,
              recoveryIdentity: nextAuthority.recoveryIdentity,
              spawnIdentity: nextAuthority.spawnIdentity,
              runtimeGeneration: nextAuthority.runtimeGeneration,
              compatibilityHash: nextAuthority.compatibilityHash,
              epoch: session.authorityEpoch + 1,
              issuedAt
            };
            const nextEnvelope = currentAuthority(session, values);
            const nextCommittedAuthority = verification.source === "provisional"
              ? currentAuthority(session)
              : session.committedAuthority;
            await atomicJson(paths.metadataPath, ownerMetadata(session, nextEnvelope, nextCommittedAuthority));
            session.currentBearer = nextBearer;
            session.currentNativeAuthReservationToken = nextNativeAuthReservationToken;
            session.relayTargetPort = relayTargetPort;
            session.authority = { ...nextAuthority, recovery: undefined };
            session.authorityEpoch = values.epoch;
            session.authorityIssuedAt = values.issuedAt;
            session.committedAuthority = nextCommittedAuthority;
            session.rotating = false;
            }
          } else {
            const relayTargetPort = await prepareRelay(session, normalizeRelay(value.relay, session.runtimeRoot));
            session.relayTargetPort = relayTargetPort;
            await session.inputTail;
          }
          if (nextCursor > session.outputAcknowledged) acknowledgeOutput(session, nextCursor);
          const authority = currentAuthority(session);
          const authorityDigest = createHash("sha256").update(JSON.stringify(authority)).digest("hex");
          return {
            ok: true,
            socketPath: paths.socketPath,
            relayPort: session.relayPort,
            authority,
            state: {
              inputAcknowledged: session.inputAcknowledged,
              outputAcknowledged: session.outputAcknowledged,
              outputSequence: session.outputSequence,
              authorityCommitRequired: true,
              authorityDigest,
              ...(recoveryOutputHighWater === undefined ? {} : { recoveryOutputHighWater })
            }
          };
        }
        if (value.action === "commit-authority") {
          if (value.format !== 1 || identity(value.identity) !== session.identity) fail();
          const epoch = positiveInteger(value.epoch);
          const authorityDigest = launchHash(value.authorityDigest);
          const attestation = launchHash(value.attestation);
          const authority = currentAuthority(session);
          const expectedDigest = createHash("sha256").update(JSON.stringify(authority)).digest("hex");
          if (
            epoch !== authority.epoch || authorityDigest !== expectedDigest
            || !exactSecret(attestation, authority.attestation)
          ) fail();
          if (!sameAuthority(session.committedAuthority, authority)) {
            await atomicJson(paths.metadataPath, ownerMetadata(session, authority, authority));
            session.committedAuthority = authority;
          }
          if (session.commitTimer) {
            clearTimeout(session.commitTimer);
            session.commitTimer = undefined;
          }
          return { ok: true, epoch, authorityDigest };
        }
        if (value.action === "abandon-authority") {
          if (value.format !== 1 || identity(value.identity) !== session.identity) fail();
          const authority = currentAuthority(session);
          const authorityDigest = createHash("sha256").update(JSON.stringify(authority)).digest("hex");
          if (
            positiveInteger(value.epoch) !== authority.epoch
            || launchHash(value.authorityDigest) !== authorityDigest
            || !exactSecret(launchHash(value.attestation), authority.attestation)
            || session.committedAuthority !== undefined
          ) fail();
          await terminate("SIGTERM");
          await session.terminalPromise;
          return { ok: true, abandoned: true, retire: true };
        }
        if (value.action === "verify-replacement") {
          const recovery = normalizeRecovery(value.recovery);
          const verification = verifyRecovery(session, recovery);
          return {
            ok: true,
            recoveryRejected: true,
            ...verification,
            reason: verification.valid ? "launch_mismatch" : verification.reason
          };
        }
        if (value.action === "kill") {
          const recovery = normalizeRecovery(value.authority);
          const verification = verifyRecovery(session, recovery);
          if (!verification.valid) return { ok: true, found: true, killed: false, ...verification };
          let managedRuns = true;
          try { managedRuns = await hasManagedRunArtifacts(session); } catch {}
          if (managedRuns || hasNativeAuthReferences(session)) {
            return {
              ok: true,
              found: true,
              killed: false,
              authorityVerified: true,
              reason: "active_runs"
            };
          }
          await terminate(signalName(value.signal));
          await session.terminalPromise;
          return { ok: true, found: true, killed: true, authorityVerified: true, retire: true };
        }
        if (value.action === "managed-store") {
          if (value.format !== 1 || identity(value.identity) !== session.identity) fail();
          if (!session.managedEnabled) fail();
          const recovery = normalizeRecovery(value.authority);
          const verification = verifyRecovery(session, recovery);
          if (!verification.valid && !verifyManagedRemovalRecovery(session, recovery)) fail();
          const result = await managedStoreOperation(session, value);
          return {
            ...result,
            authorityVerified: true,
            ...((result.removed === true || result.finalized === true) && session.terminal ? { retire: true } : {})
          };
        }
        if (value.action === "stop") {
          await terminate("SIGTERM");
          await session.terminalPromise;
          await closeOwner(false);
          return { ok: true };
        }
        fail();
      });
      return controlTail;
    }).then((response) => {
      const retire = response.retire === true;
      if (retire) delete response.retire;
      writeControl(socket, response);
      socket.end(() => {
        if (retire) void closeOwner(false);
      });
    }).catch(() => {
      if (socket.destroyed) return;
      writeControl(socket, { ok: false });
      socket.end();
    });
  };
  for (const socket of pendingControlSockets.splice(0)) {
    if (!socket.destroyed) acceptControlSocket(socket);
  }

}
async function runOwner(managedRoot, expectedIdentity, expectedHash, expectedOwnerIdentity) {
  const root = await secureDirectory(managedRoot);
  const paths = sessionPaths(root, expectedIdentity);
  await privateDirectory(paths.sessionsRoot);
  await privateDirectory(paths.sessionRoot);
  const bootstrap = await readControlLine(process.stdin);
  if (bootstrap.tail.byteLength !== 0) fail();
  const request = normalizeEnsure(bootstrap.value, root);
  if (request.identity !== expectedIdentity || request.launchHash !== expectedHash) fail();
  process.stdin.pause();
  return runSessionOwner(root, request, expectedOwnerIdentity);
}
async function reapManagedRunnersAfterOwnerLoss(record) {
  if (!record.managedEnabled) return;
  const runRoot = await privateDirectory(record.managedRunRoot);
  const nodeExecutable = await trustedExecutable(record.nodeExecutable);
  const fakeSession = {
    env: {
      JOKO_PI_SUBAGENT_RUN_ROOT: runRoot,
      JOKO_PI_PRODUCT_SESSION_ID: record.productSessionId
    },
    authority: { trustedRunnerScriptSha256: record.trustedRunnerScriptSha256 },
    childGeneration: record.childGeneration,
    nodeExecutable,
    stableBearer: "",
    currentBearer: "",
    recoveryKey: ""
  };
  const layout = managedSessionLayout(fakeSession, record.productSessionId);
  let entries;
  try {
    await privateDirectory(layout.sessionRoot);
    entries = await readdir(layout.sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length > MAX_MANAGED_RUNS) fail();
  for (const entry of entries) {
    if (entry.name === "slots" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !exactUuid(entry.name)) fail();
    const snapshot = await inspectManagedRun(fakeSession, record.productSessionId, entry.name);
    if (
      snapshot.runnerFingerprint !== undefined
      && !(await stopExactProcess(snapshot.runnerFingerprint, "SIGTERM"))
    ) fail();
    if (snapshot.runnerFingerprint !== undefined) {
      await markManagedRunStopped(snapshot, "durable runner stopped after broker owner loss");
    }
  }
}
async function runJanitor(root, expectedIdentity, expectedHash, expectedOwnerIdentity, values) {
  const canonicalRoot = await secureDirectory(root);
  if (process.platform !== "linux" || values.length !== 14) fail();
  const paths = sessionPaths(canonicalRoot, expectedIdentity);
  const owner = {
    pid: positiveInteger(Number(values[0])),
    startTicks: decimalIdentity(values[1]),
    commandHash: launchHash(values[2]),
    executableHash: launchHash(values[3])
  };
  const child = {
    pid: positiveInteger(Number(values[4])),
    startTicks: decimalIdentity(values[5]),
    commandHash: launchHash(values[6]),
    executableHash: launchHash(values[7])
  };
  const record = {
    identity: expectedIdentity,
    launchHash: expectedHash,
    ownerIdentity: expectedOwnerIdentity,
    owner,
    child,
    managedEnabled: values[8] === "1" ? true : values[8] === "0" ? false : fail(),
    managedRunRoot: values[8] === "1" ? resolve(boundedText(values[9], 4096)) : undefined,
    productSessionId: values[8] === "1" ? boundedText(values[10], 512) : undefined,
    childGeneration: Number(values[11]),
    nodeExecutable: resolve(boundedText(values[12], 4096)),
    trustedRunnerScriptSha256: launchHash(values[13])
  };
  if (
    !Number.isSafeInteger(record.childGeneration) || record.childGeneration < 0
    || !isAbsolute(values[12])
    || record.managedEnabled && !isAbsolute(values[9])
    || !record.managedEnabled && (values[9] !== "" || values[10] !== "")
  ) fail();
  const finishOwnerLoss = async () => {
    await reapManagedRunnersAfterOwnerLoss(record);
    return writeReaped(paths, record);
  };
  let childReaped = false;
  for (;;) {
    const currentOwner = await processFingerprint(owner.pid);
    const currentChild = await processFingerprint(child.pid);
    if (fingerprintsMatch(currentOwner, owner)) {
      if (currentChild === undefined || !fingerprintsMatch(currentChild, child)) {
        if (!childReaped) {
          await writeReaped(paths, record);
          childReaped = true;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      continue;
    }
    if (currentChild === undefined) return finishOwnerLoss();
    if (!fingerprintsMatch(currentChild, child)) return;
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const candidate = await processFingerprint(child.pid);
      if (candidate === undefined) return finishOwnerLoss();
      if (!fingerprintsMatch(candidate, child)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const candidate = await processFingerprint(child.pid);
    if (fingerprintsMatch(candidate, child)) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    while (fingerprintsMatch(await processFingerprint(child.pid), child)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    return finishOwnerLoss();
  }
}
async function runBootstrapReaper(root, expectedIdentity, expectedHash, expectedOwnerIdentity, values) {
  const canonicalRoot = await secureDirectory(root);
  if (process.platform !== "linux" || values.length !== 4) fail();
  const paths = sessionPaths(canonicalRoot, expectedIdentity);
  const record = await readBootstrapRecord(paths, expectedIdentity);
  if (record.launchHash !== expectedHash || record.ownerIdentity !== expectedOwnerIdentity) fail();
  const child = {
    pid: positiveInteger(Number(values[0])),
    startTicks: decimalIdentity(values[1]),
    commandHash: launchHash(values[2]),
    executableHash: launchHash(values[3])
  };
  if (record.child !== undefined && !fingerprintsMatch(record.child, child)) fail();
  const current = await processFingerprint(child.pid);
  if (current === undefined) return;
  if (!fingerprintsMatch(current, child) || !(await bootstrapChildMatches(current, record))) fail();
  if (!(await stopExactProcess(child, "SIGTERM"))) fail();
}
async function spawnOwner(root, request, rawRequest) {
  if (process.platform !== "linux") {
    throw new Error("Remote Pi crash recovery requires Linux process identity.");
  }
  const paths = sessionPaths(root, request.identity);
  await mkdir(paths.sessionRoot, { mode: 0o700 });
  await privateDirectory(paths.sessionRoot);
  const ownerIdentity = randomBytes(32).toString("hex");
  const childExecutable = await managedChildExecutable(request.executable);
  const childCwd = await realpath(request.cwd);
  if (childCwd !== request.cwd) fail();
  const marker = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    identity: request.identity,
    launchHash: request.launchHash,
    ownerLaunchHash: request.launchHash,
    ownerIdentity,
    spawnIdentity: request.authority.spawnIdentity,
    childCommandHash: digestBytes(Buffer.from([childExecutable, ...request.args].join("\0") + "\0")),
    childExecutableHash: digestBytes(Buffer.from(childExecutable)),
    childCwdHash: digestBytes(Buffer.from(childCwd)),
    createdAt: Date.now()
  };
  await atomicJson(paths.bootstrapPath, marker);
  let owner;
  try {
    owner = spawn(process.execPath, [
      process.argv[1], "owner", root, request.identity, request.launchHash, ownerIdentity
    ], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: safeDaemonEnvironment()
    });
  } catch (error) {
    await privateDirectory(paths.sessionRoot).then(() => rm(paths.sessionRoot, { recursive: true })).catch(() => undefined);
    throw error;
  }
  owner.once("error", () => undefined);
  writeControl(owner.stdin, rawRequest);
  owner.stdin.end();
  owner.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const live = await inspectLiveOwner(root, request.identity);
      if (live.record.ownerIdentity !== ownerIdentity) fail();
      return live;
    } catch {
      if (owner.exitCode !== null || owner.signalCode !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try { owner.kill("SIGKILL"); } catch {}
  await privateDirectory(paths.sessionRoot).then(() => rm(paths.sessionRoot, { recursive: true })).catch(() => undefined);
  fail();
}
async function runDaemon(managedRoot) {
  const root = await secureDirectory(managedRoot);
  const managerSocket = unixSocketPath(root, "broker.sock");
  const daemonLock = join(root, "daemon.lock");
  const daemonOwner = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    pid: process.pid,
    startedAt: Date.now()
  };
  if (!(await acquireProcessLock(daemonLock, daemonOwner))) {
    if (!(await reclaimStaleLock(daemonLock, "daemon", root)) || !(await acquireProcessLock(daemonLock, daemonOwner))) fail();
  }
  await secureDirectory(join(root, "sessions"));
  try {
    const info = await lstat(managerSocket);
    if (!info.isSocket() || info.isSymbolicLink()) fail();
    await rm(managerSocket);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const operations = new Map();
  const serialize = (key, operation) => {
    const previous = operations.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation).finally(() => {
      if (operations.get(key) === current) operations.delete(key);
    });
    operations.set(key, current);
    return current;
  };
  const ensure = (request, rawRequest) => serialize(request.identity, async () => {
    const launch = async () => {
      const launched = await spawnOwner(root, request, rawRequest);
      const configured = await ownerControl(launched.paths.controlSocketPath, {
        action: "configure",
        version: VERSION,
        authority: request.authority,
        currentBearer: request.currentBearer,
        currentNativeAuthReservationToken: request.currentNativeAuthReservationToken,
        relay: request.relay,
        outputCursor: request.outputCursor,
        replacement: rawRequest
      });
      return { ...configured, reattached: false };
    };
    let live;
    try {
      live = await inspectLiveOwner(root, request.identity);
    } catch (error) {
      const recovered = await recoverDeadOwner(root, request.identity);
      const paths = sessionPaths(root, request.identity);
      if (recovered) {
        const absent = await absentAuthorityResult(paths, request);
        return absent === undefined ? launch() : absent;
      }
      const incomplete = await recoverIncompleteBootstrap(root, request.identity);
      if (incomplete?.live !== undefined) {
        live = incomplete.live;
      } else if (incomplete?.recovered === true) {
        const absent = await absentAuthorityResult(paths, request);
        return absent === undefined ? launch() : absent;
      }
      if (live === undefined) {
        try {
          await lstat(paths.sessionRoot);
        } catch (missing) {
          if (missing && missing.code === "ENOENT") {
            const absent = await absentAuthorityResult(paths, request);
            return absent === undefined ? launch() : absent;
          }
          throw missing;
        }
        throw error;
      }
    }
    if (live.record.compatibilityHash !== request.authority.compatibilityHash) {
      const verification = await ownerControl(live.paths.controlSocketPath, {
        action: "verify-replacement",
        version: VERSION,
        recovery: request.authority.recovery
      });
      return {
        recoveryRejected: true,
        authorityVerified: verification.authorityVerified === true,
        reason: verification.reason || "launch_mismatch"
      };
    }
    const configured = await ownerControl(live.paths.controlSocketPath, {
      action: "configure",
      version: VERSION,
      authority: request.authority,
      currentBearer: request.currentBearer,
      currentNativeAuthReservationToken: request.currentNativeAuthReservationToken,
      relay: request.relay,
      outputCursor: request.outputCursor,
      replacement: rawRequest
    });
    return { ...configured, reattached: true };
  });
  const manager = createServer((socket) => {
    socket.setTimeout(30_000, () => socket.destroy());
    void readControlLine(socket).then(async ({ value }) => {
      if (value && value.action === "hello") {
        writeControl(socket, { ok: true, version: VERSION, sourceHash: SOURCE_HASH });
        return socket.end();
      }
      if (value && value.action === "kill") {
        const key = identity(value.identity);
        const result = await serialize(key, async () => {
          const live = await inspectLiveOwner(root, key);
          const killed = await ownerControl(live.paths.controlSocketPath, {
            action: "kill",
            version: VERSION,
            signal: signalName(value.signal),
            authority: normalizeRecovery(value.authority)
          });
          if (killed.killed === true) {
            const deadline = Date.now() + START_TIMEOUT_MS;
            while (Date.now() < deadline) {
              try {
                await lstat(live.paths.sessionRoot);
              } catch (error) {
                if (error && error.code === "ENOENT") return killed;
                throw error;
              }
              await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            }
            fail();
          }
          return killed;
        });
        writeControl(socket, { ok: true, ...result });
        return socket.end();
      }
      if (value && value.action === "managed-store") {
        const key = identity(value.identity);
        const result = await serialize(key, async () => {
          let live;
          try {
            live = await inspectLiveOwner(root, key);
          } catch {
            await recoverDeadOwner(root, key).catch(() => false);
            return managedRemovalTombstoneResult(sessionPaths(root, key), value, key);
          }
          return ownerControl(live.paths.controlSocketPath, {
            ...value,
            action: "managed-store",
            version: VERSION,
            format: 1,
            identity: key,
            authority: normalizeRecovery(value.authority)
          });
        });
        writeControl(socket, { ok: true, ...result });
        return socket.end();
      }
      if (value && ["commit-authority", "abandon-authority"].includes(value.action)) {
        const key = identity(value.identity);
        const result = await serialize(key, async () => {
          const live = await inspectLiveOwner(root, key);
          const controlled = await ownerControl(live.paths.controlSocketPath, {
            action: value.action,
            version: VERSION,
            format: value.format,
            identity: key,
            epoch: value.epoch,
            authorityDigest: value.authorityDigest,
            attestation: value.attestation
          });
          if (value.action === "abandon-authority" && controlled.abandoned === true) {
            const deadline = Date.now() + START_TIMEOUT_MS;
            while (Date.now() < deadline) {
              try { await lstat(live.paths.sessionRoot); }
              catch (error) {
                if (error && error.code === "ENOENT") return controlled;
                throw error;
              }
              await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            }
            fail();
          }
          return controlled;
        });
        writeControl(socket, { ok: true, ...result });
        return socket.end();
      }
      const request = normalizeEnsure(value, root);
      const result = await ensure(request, value);
      writeControl(socket, { ok: true, ...result });
      socket.end();
    }).catch(() => {
      writeControl(socket, { ok: false });
      socket.end();
    });
  });
  manager.maxConnections = 128;
  await new Promise((resolveListen, rejectListen) => {
    manager.once("error", rejectListen);
    manager.listen(managerSocket, resolveListen);
  });
  await chmod(managerSocket, 0o600);
  await atomicJson(join(root, "broker.json"), {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    pid: process.pid,
    socket: managerSocket,
    startedAt: Date.now()
  });
  const release = () => {
    void rm(managerSocket, { force: true });
    void releaseProcessLock(daemonLock, process.pid).catch(() => undefined);
  };
  process.once("exit", release);
}

async function connectManager(root, recoveryAttempt = 0) {
  const socketPath = unixSocketPath(root, "broker.sock");
  const connect = () => new Promise((resolveConnect, rejectConnect) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolveConnect(socket));
    socket.once("error", rejectConnect);
  });
  try { return await connect(); } catch {}
  const lockPath = join(root, "start.lock");
  await secureDirectory(root);
  let ownsLock = false;
  try {
    const startOwner = { version: VERSION, sourceHash: SOURCE_HASH, pid: process.pid, startedAt: Date.now() };
    ownsLock = await acquireProcessLock(lockPath, startOwner);
    if (!ownsLock && recoveryAttempt < 1 && await reclaimStaleLock(lockPath, "bridge", root)) {
      return connectManager(root, recoveryAttempt + 1);
    }
    if (ownsLock) {
      const daemonEnvironment = { JOKO_REMOTE_BROKER_SOURCE_HASH: SOURCE_HASH };
      for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) {
        if (typeof process.env[name] === "string") daemonEnvironment[name] = process.env[name];
      }
      const child = spawn(process.execPath, [process.argv[1], "daemon", root], { detached: true, stdio: "ignore", env: daemonEnvironment });
      child.unref();
    }
  } catch (error) {
    throw error;
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try { return await connect(); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
    }
    throw new Error("Remote runtime broker did not become ready.");
  } finally {
    if (ownsLock) await releaseProcessLock(lockPath, process.pid).catch(() => undefined);
  }
}

async function requestManager(root, request) {
  const socket = await connectManager(root);
  writeControl(socket, request);
  const response = await readControlLine(socket);
  socket.end();
  if (!response.value || response.value.ok !== true) fail();
  return response.value;
}

async function runBridge(root, expectedIdentity, expectedHash, terminalFence) {
  boundedText(terminalFence, 64);
  if (!/^[a-f0-9-]{36}$/.test(terminalFence)) fail();
  const bootstrap = await readControlLine(process.stdin);
  if (!bootstrap.value || bootstrap.value.identity !== expectedIdentity || bootstrap.value.launchHash !== expectedHash) fail();
  const response = await requestManager(root, bootstrap.value);
  const authorityPayload = response.recoveryRejected === true
    ? {
        ok: false,
        recoveryRejected: true,
        authorityVerified: response.authorityVerified === true,
        reason: ["launch_mismatch", "child_absent", "expired", "invalid"].includes(response.reason) ? response.reason : "invalid"
      }
    : { ok: true, authority: response.authority, state: response.state };
  const authorityContent = Buffer.from(JSON.stringify(authorityPayload));
  if (authorityContent.byteLength > 64 * 1024) fail();
  process.stdout.write(encodeFrame(FRAME_AUTHORITY, authorityContent));
  if (response.recoveryRejected === true) {
    process.stdin.pause();
    process.exitCode = 76;
    return;
  }
  if (!response.authority || !response.state) fail();
  let attachmentTail = bootstrap.tail;
  let authorityCommitAcknowledgement;
  if (response.state.authorityCommitRequired === true) {
    let commitFrame;
    try {
      commitFrame = await readBoundedFrame(process.stdin, attachmentTail);
    } catch (error) {
      await requestManager(root, {
        action: "abandon-authority",
        version: VERSION,
        format: 1,
        identity: response.authority.identity,
        epoch: response.authority.epoch,
        authorityDigest: response.state.authorityDigest,
        attestation: response.authority.attestation
      }).catch(() => undefined);
      throw error;
    }
    if (commitFrame.type !== FRAME_AUTHORITY_COMMIT) fail();
    let commit;
    try { commit = JSON.parse(commitFrame.content.toString("utf8")); } catch { fail(); }
    if (!commit || typeof commit !== "object" || commit.format !== 1) fail();
    const committed = await requestManager(root, {
      action: "commit-authority",
      version: VERSION,
      format: 1,
      identity: identity(commit.identity) === expectedIdentity ? expectedIdentity : fail(),
      epoch: positiveInteger(commit.epoch),
      authorityDigest: launchHash(commit.authorityDigest),
      attestation: launchHash(commit.attestation)
    });
    if (
      committed.epoch !== response.authority.epoch
      || committed.authorityDigest !== response.state.authorityDigest
    ) fail();
    const acknowledgement = Buffer.from(JSON.stringify({
      ok: true,
      epoch: committed.epoch,
      authorityDigest: committed.authorityDigest
    }));
    authorityCommitAcknowledgement = encodeFrame(FRAME_AUTHORITY_COMMIT_ACK, acknowledgement);
    attachmentTail = commitFrame.tail;
  }
  const session = createConnection(response.socketPath);
  session.pause();
  await new Promise((resolveConnect, rejectConnect) => { session.once("connect", resolveConnect); session.once("error", rejectConnect); });
  let terminalSequence;
  const inputDecode = frameDecoder((type, content) => {
    if (![FRAME_STDIN, FRAME_OUTPUT_ACK, FRAME_KILL].includes(type)) fail();
    if (!session.write(encodeFrame(type, content))) process.stdin.pause();
    if (type === FRAME_OUTPUT_ACK && terminalSequence !== undefined) {
      const acknowledgement = decodeSequencedContent(content).sequence;
      if (acknowledgement >= terminalSequence) session.end();
    }
  });
  if (attachmentTail.byteLength > 0) inputDecode(attachmentTail);
  const decode = frameDecoder((type, content) => {
    if (![FRAME_STDOUT, FRAME_STDERR, FRAME_EXIT, FRAME_INPUT_ACK].includes(type)) fail();
    if (!process.stdout.write(encodeFrame(type, content))) {
      session.pause();
      process.stdout.once("drain", () => session.resume());
    }
    if (type === FRAME_EXIT) {
      const terminalFrame = decodeSequencedContent(content);
      terminalSequence = terminalFrame.sequence;
      const terminalContent = terminalFrame.content;
      let terminal = { code: 1, signal: null };
      try { terminal = JSON.parse(terminalContent.toString("utf8")); } catch {}
      process.exitCode = Number.isSafeInteger(terminal.code) ? Math.max(0, Math.min(255, terminal.code)) : 1;
    }
  });
  session.once("error", () => { process.exitCode = 75; });
  session.once("close", () => {
    process.stdin.pause();
    if (terminalSequence === undefined) process.exitCode = 75;
  });
  process.stdin.on("data", (chunk) => { try { inputDecode(chunk); } catch { session.destroy(); process.exitCode = 1; } });
  session.on("drain", () => process.stdin.resume());
  process.stdin.once("end", () => {
    const timer = setTimeout(() => session.end(), 10_000);
    timer.unref?.();
  });
  process.once("SIGTERM", () => session.write(encodeFrame(FRAME_KILL, Buffer.from("SIGTERM"))));
  process.once("SIGHUP", () => session.end());
  session.on("data", (chunk) => { try { decode(chunk); } catch { session.destroy(); process.exitCode = 1; } });
  if (
    authorityCommitAcknowledgement === undefined
    || process.stdout.write(authorityCommitAcknowledgement)
  ) {
    session.resume();
  } else {
    process.stdout.once("drain", () => session.resume());
  }
}

async function main() {
  launchHash(SOURCE_HASH);
  const mode = process.argv[2];
  const rootArgument = boundedText(process.argv[3], 4096);
  if (!isAbsolute(rootArgument) || resolve(rootArgument) !== rootArgument) fail();
  const root = await secureDirectory(rootArgument);
  if (mode === "daemon") return runDaemon(root);
  if (mode === "owner") {
    return runOwner(root, identity(process.argv[4]), launchHash(process.argv[5]), launchHash(process.argv[6]));
  }
  if (mode === "janitor") {
    if (process.argv.length !== 21) fail();
    return runJanitor(
      root,
      identity(process.argv[4]),
      launchHash(process.argv[5]),
      launchHash(process.argv[6]),
      process.argv.slice(7)
    );
  }
  if (mode === "bootstrap-reaper") {
    if (process.argv.length !== 11) fail();
    return runBootstrapReaper(
      root,
      identity(process.argv[4]),
      launchHash(process.argv[5]),
      launchHash(process.argv[6]),
      process.argv.slice(7)
    );
  }
  if (mode === "bootstrap-sentinel") {
    if (process.argv.length !== 7) fail();
    return runBootstrapSentinel(
      root,
      identity(process.argv[4]),
      launchHash(process.argv[5]),
      launchHash(process.argv[6])
    );
  }
  if (mode === "bridge") return runBridge(root, identity(process.argv[4]), launchHash(process.argv[5]), process.argv[6]);
  if (mode === "kill") {
    const bootstrap = await readControlLine(process.stdin);
    if (bootstrap.tail.byteLength !== 0 || !bootstrap.value || bootstrap.value.action !== "kill" || bootstrap.value.version !== VERSION) fail();
    const response = await requestManager(root, {
      action: "kill",
      version: VERSION,
      identity: identity(bootstrap.value.identity),
      signal: signalName(bootstrap.value.signal),
      authority: normalizeRecovery(bootstrap.value.authority)
    });
    if (response.killed !== true || response.authorityVerified !== true) fail();
    return;
  }
  if (mode === "store") {
    const bootstrap = await readControlLine(process.stdin);
    if (
      bootstrap.tail.byteLength !== 0 || !bootstrap.value
      || bootstrap.value.action !== "managed-store" || bootstrap.value.version !== VERSION
      || bootstrap.value.format !== 1
    ) fail();
    const response = await requestManager(root, {
      ...bootstrap.value,
      action: "managed-store",
      version: VERSION,
      format: 1,
      identity: identity(bootstrap.value.identity),
      authority: normalizeRecovery(bootstrap.value.authority)
    });
    if (response.authorityVerified !== true) fail();
    const content = JSON.stringify(response);
    if (Buffer.byteLength(content) > MAX_CONTROL_BYTES) fail();
    process.stdout.write(content + "\n");
    return;
  }
  fail();
}
main().catch(() => process.exit(1));
`;

export const REMOTE_PI_BROKER_SOURCE_SHA256 = createHash("sha256")
  .update(REMOTE_PI_BROKER_SOURCE)
  .digest("hex");

export function remotePiLaunchHash(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): string {
  const environment = Object.entries(input.env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256")
    .update(JSON.stringify({ command: input.command, args: input.args, cwd: input.cwd, environment }))
    .digest("hex");
}
