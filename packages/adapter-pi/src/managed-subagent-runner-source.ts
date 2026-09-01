/*
 * The generated runner is intentionally dependency-free. It executes outside
 * the parent Pi runtime, owns only the child process it spawned, and exchanges
 * bounded state through a private atomic-file protocol.
 */

export const MANAGED_SUBAGENT_RUNNER_FILE_NAME = "joko-managed-subagent-runner.cjs";

export const MANAGED_SUBAGENT_RUNNER_SOURCE = String.raw`"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FORMAT = 1;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
const MAX_POLICY_DECISION_TITLE_BYTES = 9 * 1024;
const HEARTBEAT_MS = 2000;
const NATIVE_AUTH_VALIDATE_INTERVAL_MS = 5000;
const NATIVE_AUTH_REQUEST_TIMEOUT_MS = 5000;
const NATIVE_AUTH_ACQUIRE_RETRY_WINDOW_MS = 15000;
const NATIVE_AUTH_RETRY_INITIAL_MS = 50;
const NATIVE_AUTH_RETRY_MAX_MS = 500;
const MAX_NATIVE_AUTH_BYTES = 4 * 1024 * 1024;
const CONTROL_POLL_MS = 200;
const RPC_TIMEOUT_MS = 5000;
const EXIT_GRACE_MS = 2000;
const MAX_CHILD_SLOTS = 4;
const CREDENTIAL_NAMES_ENV = "JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES";
const SECRET_NAMES_ENV = "JOKO_PI_SECRET_ENV_NAMES";
const MCP_TOKEN_ENV = "JOKO_PI_MCP_TOKEN";
const NATIVE_AUTH_ENDPOINT_ENV = "JOKO_PI_NATIVE_AUTH_ENDPOINT";
const NATIVE_AUTH_CATALOG_GENERATION_ENV = "JOKO_PI_NATIVE_AUTH_CATALOG_GENERATION";
const NATIVE_AUTH_TARGET_ENV = "JOKO_PI_NATIVE_AUTH_TARGET_ID";
const NATIVE_AUTH_SESSION_ENV = "JOKO_PI_NATIVE_AUTH_PRODUCT_SESSION_ID";
const NATIVE_AUTH_GENERATION_ENV = "JOKO_PI_NATIVE_AUTH_PRODUCT_GENERATION";
const DEPTH_ENV = "JOKO_PI_SUBAGENT_DEPTH";
const PARENT_PID_ENV = "JOKO_PI_SUBAGENT_PARENT_PID";
const SAFE_ENV_NAMES = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "VITEST_MAX_FORKS", "VITEST_MAX_THREADS", "CARGO_BUILD_JOBS", "MAKEFLAGS"
];

function fail(message) {
  try { process.stderr.write("[joko-managed-runner] " + String(message).slice(0, 2000) + "\n"); } catch (_) {}
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isContained(root, candidate) {
  const suffix = path.relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + path.sep) && !path.isAbsolute(suffix));
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function exactArgument(args, name, expected) {
  let observed;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    if (observed !== undefined || index + 1 >= args.length) return false;
    observed = args[index + 1];
  }
  return observed === expected;
}

function boundedFile(file, maximum) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error("unsafe or oversized runner file");
  const canonical = fs.realpathSync(file);
  if (!samePath(canonical, path.resolve(file))) throw new Error("runner file path alias denied");
  return canonical;
}

function readJson(file, maximum) {
  boundedFile(file, maximum || MAX_JSON_BYTES);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWriteText(file, text) {
  const parent = path.dirname(file);
  const canonicalParent = fs.realpathSync(parent);
  if (!samePath(canonicalParent, parent)) throw new Error("atomic write parent path alias denied");
  const temporary = file + ".tmp-" + process.pid + "-" + randomUUID();
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(temporary, 0o600);
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      if (!error || !["EACCES", "EPERM", "EBUSY"].includes(error.code)) break;
      const until = Date.now() + Math.min(100, 10 + attempt * 10);
      while (Date.now() < until) {}
    }
  }
  try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  throw lastError || new Error("atomic write failed");
}

function atomicWriteJson(file, value) {
  atomicWriteText(file, JSON.stringify(value) + "\n");
}

function readNameList(name) {
  try {
    const value = JSON.parse(process.env[name] || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(function (entry) {
      return typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(entry);
    });
  } catch (_) {
    return [];
  }
}

function redactor(additionalValues) {
  const values = additionalValues || [];
  for (const name of readNameList(CREDENTIAL_NAMES_ENV)) {
    const value = process.env[name];
    if (typeof value === "string" && value.length >= 4) values.push(value);
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    const value = process.env[name];
    if (typeof value !== "string" || value.length < 4) continue;
    values.push(value);
    try {
      const parsed = new URL(value);
      if (parsed.username.length >= 4) values.push(decodeURIComponent(parsed.username));
      if (parsed.password.length >= 4) values.push(decodeURIComponent(parsed.password));
    } catch (_) {}
  }
  return function redact(input) {
    let text = typeof input === "string" ? input : String(input || "");
    for (const value of values) text = text.split(value).join("[REDACTED]");
    text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]");
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/giu, "Bearer [REDACTED]");
    return text;
  };
}

// Capture inherited credentials before main can scrub its environment. The
// handler is replaced with main's richer redactor once native-auth values are
// available, so even failures outside the normal lifecycle stay log-safe.
let redactFailure = redactor([]);

function collectCredentialValues(value, key, output) {
  if (Array.isArray(value)) {
    for (const entry of value) collectCredentialValues(entry, key, output);
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length >= 4 && /token|secret|key|password|credential|auth|access|refresh/i.test(key || "")) {
      output.push(value);
    }
    return;
  }
  for (const name of Object.keys(value)) collectCredentialValues(value[name], name, output);
}

function readRunnerPrivateKey(config) {
  if (config.nativeAuthRequired !== true) return undefined;
  let bytes;
  try {
    bytes = fs.readFileSync(3);
  } finally {
    try { fs.closeSync(3); } catch (_) {}
  }
  try {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength < 32 || bytes.byteLength > 256) {
      throw new Error("native runner launch key is unavailable");
    }
    const privateKey = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("native runner launch key is invalid");
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
    if (publicKey !== config.runnerPublicKey
        || createHash("sha256").update(publicKey).digest("hex") !== config.runnerPublicKeyDigest) {
      throw new Error("native runner launch key is mismatched");
    }
    return privateKey;
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

function nativeAuthConfiguration(config, runnerFence, runnerPrivateKey) {
  if (config.nativeAuthRequired !== true) return undefined;
  const endpointValue = process.env[NATIVE_AUTH_ENDPOINT_ENV];
  const token = process.env[MCP_TOKEN_ENV];
  const catalogGeneration = Number.parseInt(process.env[NATIVE_AUTH_CATALOG_GENERATION_ENV] || "-1", 10);
  const environmentProductGeneration = Number.parseInt(process.env[NATIVE_AUTH_GENERATION_ENV] || "-1", 10);
  if (
    typeof endpointValue !== "string" || typeof token !== "string" || token.length < 32
    || process.env[NATIVE_AUTH_SESSION_ENV] !== config.productSessionId
    || process.env[NATIVE_AUTH_TARGET_ENV] === undefined
    || environmentProductGeneration !== config.productGeneration
    || !Number.isSafeInteger(catalogGeneration) || catalogGeneration < 0
    || !config.route || typeof config.route.provider !== "string"
    || !runnerPrivateKey || !isUuid(config.nativeAuthReservationId)
    || !Number.isSafeInteger(config.nativeAuthServiceGeneration) || config.nativeAuthServiceGeneration < 0
  ) throw new Error("native credential lease channel is unavailable");
  let endpoint;
  try { endpoint = new URL(endpointValue); } catch (_) { throw new Error("native credential lease channel is unavailable"); }
  const host = endpoint.hostname.toLowerCase();
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !["127.0.0.1", "::1", "localhost"].includes(host)
  ) throw new Error("native credential lease channel is unavailable");
  return {
    endpoint: endpoint.toString(),
    token: token,
    targetId: process.env[NATIVE_AUTH_TARGET_ENV],
    catalogGeneration: catalogGeneration,
    providerId: config.route.provider,
    runId: config.runId,
    runnerFence: runnerFence,
    productSessionId: config.productSessionId,
    productGeneration: config.productGeneration,
    serviceGeneration: config.nativeAuthServiceGeneration,
    reservationId: config.nativeAuthReservationId,
    privateKey: runnerPrivateKey,
    deadline: 0
  };
}

async function nativeAuthRequest(lease, action, credential) {
  if (!lease) return { active: false };
  const retryDeadline = action === "acquire"
    ? performance.now() + NATIVE_AUTH_ACQUIRE_RETRY_WINDOW_MS
    : lease.deadline;
  let delay = NATIVE_AUTH_RETRY_INITIAL_MS;
  while (true) {
    if (performance.now() >= retryDeadline) {
      throw new Error("native credential lease is invalid, expired, or revoked");
    }
    try {
      return await nativeAuthRequestOnce(lease, action, credential, retryDeadline);
    } catch (failure) {
      if (!failure || failure.transient !== true || performance.now() >= retryDeadline) {
        throw new Error("native credential lease is invalid, expired, or revoked");
      }
      const remaining = retryDeadline - performance.now();
      if (remaining <= 0) throw new Error("native credential lease is invalid, expired, or revoked");
      await new Promise(function (resolve) { setTimeout(resolve, Math.min(delay, remaining)); });
      delay = Math.min(NATIVE_AUTH_RETRY_MAX_MS, delay * 2);
    }
  }
}

async function nativeAuthRequestOnce(lease, action, credential, retryDeadline) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(NATIVE_AUTH_REQUEST_TIMEOUT_MS, retryDeadline - performance.now()));
  const timeout = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const nonce = randomBytes(32).toString("base64url");
    const credentialDigest = createHash("sha256").update(
      credential === undefined ? "" : JSON.stringify(credential)
    ).digest("hex");
    const message = JSON.stringify([
      "joko.pi-native-auth.runner-proof.v1",
      action,
      lease.reservationId,
      lease.productSessionId,
      lease.targetId,
      lease.serviceGeneration,
      lease.productGeneration,
      lease.providerId,
      lease.catalogGeneration,
      lease.runId,
      lease.runnerFence,
      process.pid,
      lease.recoveryProof || "",
      credentialDigest,
      nonce
    ]);
    const runnerProof = {
      format: 1,
      reservationId: lease.reservationId,
      runnerPid: process.pid,
      nonce: nonce,
      signature: sign(null, Buffer.from(message, "utf8"), lease.privateKey).toString("base64url")
    };
    const response = await fetch(lease.endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: "Bearer " + lease.token,
        "content-type": "application/json",
        "x-joko-pi-generation": String(lease.serviceGeneration)
      },
      body: JSON.stringify({
        action: action,
        generation: lease.serviceGeneration,
        runnerProductGeneration: lease.productGeneration,
        sessionId: lease.productSessionId,
        targetId: lease.targetId,
        providerId: lease.providerId,
        catalogGeneration: lease.catalogGeneration,
        runId: lease.runId,
        runnerFence: lease.runnerFence,
        ...(action === "acquire" ? { recovery: { runnerPid: process.pid } } : {}),
        ...(lease.recoveryProof === undefined ? {} : { recoveryProof: lease.recoveryProof }),
        runnerProof: runnerProof,
        ...(credential === undefined ? {} : { credential: credential })
      })
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_NATIVE_AUTH_BYTES) throw nativeAuthFailure(false);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_NATIVE_AUTH_BYTES) throw nativeAuthFailure(false);
    if (!response.ok) throw nativeAuthFailure(response.status >= 500 && response.status <= 599);
    let body;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (_) { throw nativeAuthFailure(false); }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.active !== "boolean") throw nativeAuthFailure(false);
    if (action === "acquire") {
      if (typeof body.recoveryProof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryProof)) {
        throw nativeAuthFailure(false);
      }
    }
    if ((action === "acquire" || action === "validate") && body.active === true) {
      if (!Number.isSafeInteger(body.validForMs) || body.validForMs < 1 || body.validForMs > 60000) {
        throw nativeAuthFailure(false);
      }
      lease.deadline = performance.now() + body.validForMs;
    }
    if (action === "acquire") lease.recoveryProof = body.recoveryProof;
    return body;
  } catch (failure) {
    if (failure && failure.transient !== undefined) throw failure;
    throw nativeAuthFailure(true);
  } finally {
    clearTimeout(timeout);
  }
}

function nativeAuthFailure(transient) {
  const failure = new Error("native credential lease request failed");
  failure.transient = transient === true;
  return failure;
}

function installNativeAuth(config, lease, credential, redactionValues) {
  if (!lease || !credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new Error("native credential lease did not return a Provider credential");
  }
  collectCredentialValues(credential, "credential", redactionValues);
  const authPath = path.join(config.childHome, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ [lease.providerId]: credential }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(authPath, 0o600);
  return {
    authPath: authPath,
    initialDigest: createHash("sha256").update(JSON.stringify(credential)).digest("hex"),
    observedDigest: createHash("sha256").update(JSON.stringify(credential)).digest("hex")
  };
}

function removeNativeAuthSnapshot(authPath) {
  if (!authPath) return;
  try { fs.rmSync(authPath, { force: true }); } catch (_) {}
}

function refreshNativeCredentialRedaction(lease, installed, redactionValues) {
  if (!lease || !installed) return undefined;
  const value = readJson(installed.authPath, MAX_NATIVE_AUTH_BYTES);
  const credential = value && typeof value === "object" && !Array.isArray(value) ? value[lease.providerId] : undefined;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new Error("native credential snapshot no longer contains the leased Provider");
  }
  const digest = createHash("sha256").update(JSON.stringify(credential)).digest("hex");
  if (digest !== installed.observedDigest) {
    collectCredentialValues(credential, "credential", redactionValues);
    installed.observedDigest = digest;
  }
  return { credential: credential, digest: digest };
}

function changedNativeCredential(config, lease, installed, redactionValues) {
  const current = refreshNativeCredentialRedaction(lease, installed, redactionValues);
  if (!current) return undefined;
  return current.digest === installed.initialDigest ? undefined : current.credential;
}

function sanitizedClone(value, redact) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, function (_key, entry) {
    return typeof entry === "string" ? redact(entry) : entry;
  }));
}

function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.byteLength <= maximum) return String(value);
  if (maximum < 4) return "";
  return bytes.subarray(0, maximum - 3).toString("utf8").replace(/\uFFFD$/u, "") + "…";
}

function sanitizeNativeSession(file, allowedRoot, resumeFile, redact) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("native child session path unavailable for credential scrubbing");
  const resolved = path.resolve(file);
  if (!isContained(allowedRoot, resolved) && !(resumeFile && samePath(resolved, resumeFile))) {
    throw new Error("native child session escaped credential scrubbing scope");
  }
  const info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024 || !samePath(fs.realpathSync(resolved), resolved)) {
    throw new Error("native child session is linked, oversized, or unavailable for credential scrubbing");
  }
  const source = fs.readFileSync(resolved, "utf8");
  const output = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    output.push(JSON.stringify(sanitizedClone(JSON.parse(line), redact)));
  }
  atomicWriteText(resolved, output.join("\n") + (output.length ? "\n" : ""));
}

function terminateOwnedTree(child, force) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (process.platform === "win32" && typeof child.pid === "number") {
      const args = ["/PID", String(child.pid), "/T"];
      if (force) args.push("/F");
      const outcome = spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
      if (outcome.error || outcome.status !== 0) child.kill(signal);
      return;
    }
    if (typeof child.pid === "number") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (_) {
    try { child.kill(signal); } catch (_) {}
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && error.code === "EPERM"; }
}

function tryAcquireChildSlot(slotRoot, config, runnerInstanceId) {
  for (let index = 0; index < MAX_CHILD_SLOTS; index += 1) {
    const file = path.join(slotRoot, "slot-" + String(index) + ".json");
    const claim = {
      format: FORMAT,
      runId: config.runId,
      launchToken: config.launchToken,
      runnerPid: process.pid,
      runnerInstanceId: runnerInstanceId,
      claimedAt: Date.now()
    };
    try {
      fs.writeFileSync(file, JSON.stringify(claim) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.chmodSync(file, 0o600);
      return file;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    let existing;
    try { existing = readJson(file, 64 * 1024); }
    catch (_) { continue; }
    if (!existing || existing.format !== FORMAT || !isUuid(existing.runId) || !isUuid(existing.launchToken)) continue;
    if (processIsAlive(existing.runnerPid)) continue;
    try {
      const quarantine = file + ".stale-" + randomUUID();
      fs.renameSync(file, quarantine);
      fs.rmSync(quarantine, { force: true });
      index -= 1;
    } catch (_) {}
  }
  return undefined;
}

function releaseChildSlot(file, config, runnerInstanceId) {
  if (!file) return;
  try {
    const claim = readJson(file, 64 * 1024);
    if (
      claim && claim.format === FORMAT && claim.runId === config.runId && claim.launchToken === config.launchToken
      && claim.runnerPid === process.pid && claim.runnerInstanceId === runnerInstanceId
    ) fs.rmSync(file, { force: true });
  } catch (_) {}
}

function assistantText(message, redact) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter(function (block) {
    return block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
  }).map(function (block) { return redact(block.text); }).join("");
}

function usageFromStats(value) {
  const source = value && typeof value === "object" && value.tokens && typeof value.tokens === "object" ? value.tokens : {};
  const number = function (entry) { return typeof entry === "number" && Number.isFinite(entry) && entry >= 0 ? entry : 0; };
  const inputTokens = number(source.input);
  const outputTokens = number(source.output);
  const cacheReadTokens = number(source.cacheRead);
  const cacheWriteTokens = number(source.cacheWrite);
  return {
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens,
    totalTokens: number(source.total) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: number(value && value.cost)
  };
}

function lineReader(onLine) {
  let buffer = "";
  return function (chunk) {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  };
}

async function main() {
  const configPath = process.argv[2];
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) throw new Error("absolute runner config path required");
  const runDir = path.dirname(path.resolve(configPath));
  if (!isUuid(path.basename(runDir)) || !samePath(fs.realpathSync(runDir), runDir)) throw new Error("invalid runner directory");
  if (!samePath(path.join(runDir, "config.json"), path.resolve(configPath))) throw new Error("runner config escaped its run directory");
  const config = readJson(configPath);
  const owner = readJson(path.join(runDir, "owner.json"));
  const statusPath = path.join(runDir, "status.json");
  const initialStatus = readJson(statusPath);
  const script = boundedFile(process.argv[1], MAX_JSON_BYTES);
  const runnerScriptSha256 = createHash("sha256").update(fs.readFileSync(script)).digest("hex");
  if (
    !config || config.format !== FORMAT || config.runId !== path.basename(runDir) || !isUuid(config.runId)
    || !isUuid(config.launchToken) || config.runnerScript !== script || config.runDir !== runDir
    || config.runnerScriptSha256 !== runnerScriptSha256
    || !owner || owner.format !== FORMAT || owner.runId !== config.runId || owner.launchToken !== config.launchToken
    || owner.productSessionId !== config.productSessionId || owner.taskId !== config.taskId || owner.runnerScript !== script
    || owner.runnerScriptSha256 !== runnerScriptSha256
    || owner.state !== "reserved"
    || config.childId !== config.taskId + ":child" || typeof config.title !== "string" || config.title.length < 1
    || config.title.length > 120 || typeof config.readOnly !== "boolean" || typeof config.nativeAuthRequired !== "boolean"
    || typeof config.background !== "boolean"
    || !initialStatus || initialStatus.format !== FORMAT || initialStatus.runId !== config.runId
    || initialStatus.launchToken !== config.launchToken || initialStatus.productSessionId !== config.productSessionId
    || initialStatus.taskId !== config.taskId || initialStatus.runnerScript !== script
    || initialStatus.runnerScriptSha256 !== runnerScriptSha256
    || initialStatus.state !== "queued" || initialStatus.runnerPid !== 0
    || !isUuid(config.runnerInstanceId) || initialStatus.runnerInstanceId !== config.runnerInstanceId
    || owner.runnerInstanceId !== config.runnerInstanceId
    || (config.nativeAuthRequired === true
      ? !isUuid(config.nativeAuthReservationId)
        || !Number.isSafeInteger(config.nativeAuthServiceGeneration) || config.nativeAuthServiceGeneration < 0
        || typeof config.runnerPublicKey !== "string" || config.runnerPublicKey.length < 40 || config.runnerPublicKey.length > 128
        || !/^[0-9a-f]{64}$/.test(config.runnerPublicKeyDigest)
        || createHash("sha256").update(config.runnerPublicKey).digest("hex") !== config.runnerPublicKeyDigest
        || owner.nativeAuthReservationId !== config.nativeAuthReservationId
        || owner.runnerPublicKeyDigest !== config.runnerPublicKeyDigest
        || initialStatus.nativeAuthReservationId !== config.nativeAuthReservationId
        || initialStatus.runnerPublicKeyDigest !== config.runnerPublicKeyDigest
      : config.nativeAuthReservationId !== undefined || config.nativeAuthServiceGeneration !== undefined
        || config.runnerPublicKey !== undefined || config.runnerPublicKeyDigest !== undefined)
  ) throw new Error("runner ownership manifest mismatch");
  const sessionDir = path.dirname(runDir);
  const expectedRuntimeDir = path.join(runDir, "runtime");
  const expectedTemporaryPath = path.join(runDir, "temporary");
  const expectedAuthRoot = path.join(path.dirname(path.dirname(sessionDir)), "subagent-native-auth");
  const expectedAuthSessionDir = path.join(expectedAuthRoot, path.basename(sessionDir));
  const expectedChildHome = path.join(expectedAuthSessionDir, config.runId);
  const expectedChildSessionDir = path.join(runDir, "sessions");
  const expectedSlotRoot = path.join(sessionDir, "slots");
  const expectedTranscriptPath = path.join(runDir, "transcript.jsonl");
  const expectedRuntimeControlPath = path.join(expectedRuntimeDir, "control.json");
  const expectedRetryControlPath = path.join(expectedRuntimeDir, "retry-control.json");
  if (
    config.childHome !== expectedChildHome || config.childSessionDir !== expectedChildSessionDir
    || config.temporaryPath !== expectedTemporaryPath || config.slotRoot !== expectedSlotRoot
    || config.transcriptPath !== expectedTranscriptPath || config.runtimeControlPath !== expectedRuntimeControlPath
    || config.retryControlPath !== expectedRetryControlPath
  ) throw new Error("runner private layout mismatch");
  for (const directory of [expectedChildHome, expectedChildSessionDir, expectedRuntimeDir, expectedTemporaryPath, expectedSlotRoot]) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) {
      throw new Error("runner private directory is unsafe");
    }
  }
  boundedFile(expectedTranscriptPath, MAX_TRANSCRIPT_BYTES);
  boundedFile(expectedRuntimeControlPath, MAX_JSON_BYTES);
  boundedFile(expectedRetryControlPath, MAX_JSON_BYTES);
  if (
    !config.child || !path.isAbsolute(config.child.command) || !Array.isArray(config.child.args)
    || config.child.args.length > 128 || config.child.args.some(function (value) { return typeof value !== "string" || value.length > 20000; })
  ) throw new Error("invalid child launch snapshot");
  const childCommandInfo = fs.lstatSync(config.child.command);
  if (!childCommandInfo.isFile() || childCommandInfo.isSymbolicLink() || !samePath(fs.realpathSync(config.child.command), config.child.command)) {
    throw new Error("child launch executable is unsafe");
  }
  if (!exactArgument(config.child.args, "--session-dir", expectedChildSessionDir)) throw new Error("child session directory argument mismatch");
  if (!isUuid(config.nativeSessionId)) throw new Error("native child session identity is invalid");
  if (config.resumeSessionPath) {
    const resumed = path.resolve(config.resumeSessionPath);
    const segments = path.relative(sessionDir, resumed).split(path.sep);
    const resumedFileName = segments[2] || "";
    const exactSessionFileName = config.nativeSessionId + ".jsonl";
    const timestampedSessionSuffix = "_" + exactSessionFileName;
    if (
      !path.isAbsolute(config.resumeSessionPath) || !isContained(sessionDir, resumed) || segments.length !== 3
      || !isUuid(segments[0]) || segments[0] === config.runId || segments[1] !== "sessions"
      || (resumedFileName !== exactSessionFileName && !resumedFileName.endsWith(timestampedSessionSuffix))
      || !samePath(fs.realpathSync(resumed), resumed)
      || config.child.args.includes("--session-id")
      || !exactArgument(config.child.args, "--session", resumed)
    ) throw new Error("resume session identity mismatch");
    const resumeInfo = fs.lstatSync(resumed);
    if (!resumeInfo.isFile() || resumeInfo.isSymbolicLink() || resumeInfo.size > 256 * 1024 * 1024) {
      throw new Error("resume session is unsafe");
    }
  } else if (config.child.args.includes("--session") || !exactArgument(config.child.args, "--session-id", config.nativeSessionId)) {
    throw new Error("new child session identity mismatch");
  }
  const workspaceInfo = path.isAbsolute(config.workspaceRoot) ? fs.lstatSync(config.workspaceRoot) : undefined;
  if (!workspaceInfo || !workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()
      || !samePath(fs.realpathSync(config.workspaceRoot), config.workspaceRoot)) {
    throw new Error("child workspace identity mismatch");
  }
  if (config.initialMessage && (typeof config.initialMessage !== "string" || config.initialMessage.length > 70000)) throw new Error("invalid initial message");

  const runnerPrivateKey = readRunnerPrivateKey(config);
  const runnerInstanceId = config.runnerInstanceId;
  const claimPath = path.join(runDir, "runner.claim.json");
  fs.writeFileSync(claimPath, JSON.stringify({
    format: FORMAT,
    runId: config.runId,
    launchToken: config.launchToken,
    runnerPid: process.pid,
    runnerInstanceId: runnerInstanceId,
    runnerScriptSha256: runnerScriptSha256,
    ...(config.nativeAuthRequired ? {
      nativeAuthReservationId: config.nativeAuthReservationId,
      runnerPublicKeyDigest: config.runnerPublicKeyDigest
    } : {}),
    claimedAt: Date.now()
  }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(claimPath, 0o600);

  atomicWriteJson(configPath, {
    format: config.format,
    runId: config.runId,
    launchToken: config.launchToken,
    runDir: config.runDir,
    runnerScript: config.runnerScript,
    runnerScriptSha256: config.runnerScriptSha256,
    runnerInstanceId: config.runnerInstanceId,
    ...(config.nativeAuthRequired ? {
      nativeAuthReservationId: config.nativeAuthReservationId,
      nativeAuthServiceGeneration: config.nativeAuthServiceGeneration,
      runnerPublicKey: config.runnerPublicKey,
      runnerPublicKeyDigest: config.runnerPublicKeyDigest
    } : {}),
    productSessionId: config.productSessionId,
    productGeneration: config.productGeneration,
    parentTaskId: config.parentTaskId,
    taskId: config.taskId,
    childId: config.childId,
    agentName: config.agentName,
    title: config.title,
    task: config.task,
    route: config.route,
    model: config.model,
    effort: config.effort,
    toolClass: config.toolClass,
    readOnly: config.readOnly,
    nativeAuthRequired: config.nativeAuthRequired,
    background: config.background === true,
    contextMode: config.contextMode,
    productGeneration: config.productGeneration,
    parentTaskId: config.parentTaskId,
    taskId: config.taskId,
    agentName: config.agentName,
    task: config.task,
    route: config.route,
    model: config.model,
    effort: config.effort,
    toolClass: config.toolClass,
    timeoutMs: config.timeoutMs,
    turnCount: config.turnCount,
    createdAt: config.createdAt,
    workspaceRoot: config.workspaceRoot,
    slotRoot: config.slotRoot,
    childHome: config.childHome,
    childSessionDir: config.childSessionDir,
    nativeSessionId: config.nativeSessionId,
    resumeSessionPath: config.resumeSessionPath,
    runtimeControlPath: config.runtimeControlPath,
    retryControlPath: config.retryControlPath,
    temporaryPath: config.temporaryPath,
    transcriptPath: config.transcriptPath
  });

  const nativeCredentialRedactionValues = [];
  const redact = redactor(nativeCredentialRedactionValues);
  redactFailure = redact;
  const nativeLease = nativeAuthConfiguration(config, runnerInstanceId, runnerPrivateKey);
  if (nativeLease) nativeCredentialRedactionValues.push(nativeLease.token);
  const credentialNames = readNameList(CREDENTIAL_NAMES_ENV);
  const secretNames = readNameList(SECRET_NAMES_ENV);
  const childEnv = {};
  for (const name of SAFE_ENV_NAMES) if (typeof process.env[name] === "string") childEnv[name] = process.env[name];
  for (const name of credentialNames) if (typeof process.env[name] === "string") childEnv[name] = process.env[name];
  childEnv[SECRET_NAMES_ENV] = JSON.stringify(secretNames);
  childEnv["PI_CODING_AGENT_DIR"] = config.childHome;
  childEnv["PI_CODING_AGENT_SESSION_DIR"] = config.childSessionDir;
  childEnv["PI_SKIP_VERSION_CHECK"] = "1";
  childEnv["JOKO_PI_CONTROL_FILE"] = config.runtimeControlPath;
  childEnv["JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE"] = config.retryControlPath;
  childEnv["JOKO_PI_WORKSPACE_ROOT"] = config.workspaceRoot;
  childEnv["JOKO_PI_GENERATION"] = String(config.productGeneration);
  childEnv[DEPTH_ENV] = "1";
  childEnv[PARENT_PID_ENV] = String(process.pid);
  childEnv["TEMP"] = config.temporaryPath;
  childEnv["TMP"] = config.temporaryPath;
  childEnv["TMPDIR"] = config.temporaryPath;
  for (const name of credentialNames) delete process.env[name];
  delete process.env[CREDENTIAL_NAMES_ENV];
  delete process.env[SECRET_NAMES_ENV];

  const resultPath = path.join(runDir, "result.json");
  const controlPath = path.join(runDir, "control.json");
  const approvalControlPath = path.join(runDir, "approval-control.json");
  const startedAt = Date.now();
  atomicWriteJson(path.join(runDir, "owner.json"), Object.assign({}, owner, {
    state: "running",
    runnerPid: process.pid,
    runnerInstanceId: runnerInstanceId,
    startedAt: startedAt
  }));
  let state = "queued";
  let summary = "queued";
  let endedAt;
  let error;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
  let toolUses = 0;
  let pendingMessageCount = 0;
  let childSessionId = config.nativeSessionId;
  let childSessionPath = config.resumeSessionPath;
  let latestAssistant;
  let transcriptBytes = 0;
  let transcriptTruncated = false;
  let lastControlSeq = 0;
  let lastControl;
  let lastApprovalControl;
  let pendingApproval;
  let handledApprovalRequestId;
  let abortReason;
  let nativeLeaseFailure = false;
  let nativeLeaseAcquired = false;
  let nativeLeaseInstalled;
  let nativeLeaseTimer;
  let nativeLeaseBusy = false;
  let child;
  let childClosed = false;
  let abortForceTimer;
  let stderr = "";
  let nextRpcId = 1;
  let settledResolve;
  let settled = new Promise(function (resolve) { settledResolve = resolve; });
  const pending = new Map();
  let expectedQueue;

  function statusPayload() {
    return {
      format: FORMAT,
      runId: config.runId,
      launchToken: config.launchToken,
      productSessionId: config.productSessionId,
      parentTaskId: config.parentTaskId,
      taskId: config.taskId,
      childId: config.childId,
      agentName: config.agentName,
      title: truncateUtf8(redact(config.title || config.agentName + " subagent"), 120),
      task: truncateUtf8(redact(config.task), 32000),
      model: config.model,
      effort: config.effort,
      toolClass: config.toolClass,
      readOnly: config.readOnly !== false,
      contextMode: config.contextMode === "fork" ? "fork" : "fresh",
      background: config.background === true,
      state: state,
      summary: truncateUtf8(redact(summary), 8192),
      error: error ? truncateUtf8(redact(error), 8192) : undefined,
      createdAt: config.createdAt,
      startedAt: startedAt,
      endedAt: endedAt,
      heartbeatAt: Date.now(),
      runnerPid: process.pid,
      runnerInstanceId: runnerInstanceId,
      runnerScript: script,
      runnerScriptSha256: runnerScriptSha256,
      ...(config.nativeAuthRequired ? {
        nativeAuthReservationId: config.nativeAuthReservationId,
        runnerPublicKeyDigest: config.runnerPublicKeyDigest
      } : {}),
      nativeSessionId: childSessionId,
      nativeSessionPath: childSessionPath,
      usage: usage,
      toolUses: toolUses,
      durationMs: Math.max(0, (endedAt || Date.now()) - startedAt),
      turnCount: config.turnCount,
      pendingMessageCount: pendingMessageCount,
      progressRatio: state === "completed" ? 1 : undefined,
      transcriptPath: config.transcriptPath,
      resultPath: endedAt ? resultPath : undefined,
      lastControl: lastControl,
      pendingApproval: pendingApproval,
      lastApprovalControl: lastApprovalControl
    };
  }

  function flushStatus() {
    atomicWriteJson(statusPath, statusPayload());
  }

  function appendTranscript(record) {
    if (transcriptTruncated) return;
    const line = JSON.stringify(sanitizedClone(record, redact)) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) {
      const marker = JSON.stringify({ type: "joko.subagent.transcript_truncated", at: Date.now() }) + "\n";
      if (transcriptBytes + Buffer.byteLength(marker, "utf8") <= MAX_TRANSCRIPT_BYTES) {
        fs.appendFileSync(config.transcriptPath, marker, { encoding: "utf8", mode: 0o600 });
      }
      transcriptTruncated = true;
      return;
    }
    fs.appendFileSync(config.transcriptPath, line, { encoding: "utf8", mode: 0o600 });
    transcriptBytes += bytes;
  }

  function rejectPending(reason) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    pending.clear();
  }

  function sendRpc(command, timeout) {
    if (!child || childClosed) return Promise.reject(new Error("child RPC unavailable"));
    const id = "joko-runner-" + String(nextRpcId++);
    const payload = Object.assign({ id: id }, command);
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("child " + command.type + " response timed out"));
      }, timeout || RPC_TIMEOUT_MS);
      pending.set(id, { command: command.type, resolve: resolve, reject: reject, timer: timer });
      try { child.stdin.write(JSON.stringify(payload) + "\n"); }
      catch (failure) {
        clearTimeout(timer);
        pending.delete(id);
        reject(failure);
      }
    });
  }

  function sendNotification(payload) {
    if (!child || childClosed) return false;
    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
      return true;
    } catch (_) {
      return false;
    }
  }

  function boundedApproval(event) {
    const id = typeof event.id === "string" ? event.id : "";
    const method = typeof event.method === "string" ? event.method : "";
    if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
    const rawTitle = redact(typeof event.title === "string" ? event.title : "");
    const title = truncateUtf8(
      rawTitle,
      method === "input" && rawTitle.startsWith("joko:policy-decision/v1/")
        ? MAX_POLICY_DECISION_TITLE_BYTES
        : 1024
    );
    if (method === "confirm" && title.startsWith("joko:permission:")) {
      return {
        id: id,
        childId: config.childId,
        method: method,
        title: title,
        message: truncateUtf8(redact(typeof event.message === "string" ? event.message : ""), 8192),
        requestedAt: Date.now()
      };
    }
    if (method === "input" && (title.startsWith("joko:command-gate/v1/") || title.startsWith("joko:policy-decision/v1/"))) {
      return {
        id: id,
        childId: config.childId,
        method: method,
        title: title,
        placeholder: truncateUtf8(redact(typeof event.placeholder === "string" ? event.placeholder : ""), 1024),
        requestedAt: Date.now()
      };
    }
    return { id: id, method: method, unsupported: true };
  }

  function safeTranscriptEvent(event) {
    const type = typeof event.type === "string" ? truncateUtf8(redact(event.type), 256) : "unknown";
    if (type.startsWith("tool_execution_")) {
      return {
        type: type,
        toolName: typeof event.toolName === "string" ? truncateUtf8(redact(event.toolName), 256) : undefined,
        toolCallId: typeof event.toolCallId === "string" ? truncateUtf8(redact(event.toolCallId), 512) : undefined,
        isError: event.isError === true,
        timestamp: Number.isSafeInteger(event.timestamp) ? event.timestamp : Date.now()
      };
    }
    if (type.startsWith("message_") && event.message && typeof event.message === "object") {
      const text = Array.isArray(event.message.content) ? event.message.content.filter(function (block) {
        return block && block.type === "text" && typeof block.text === "string";
      }).map(function (block) { return { type: "text", text: truncateUtf8(redact(block.text), 256 * 1024) }; }) : [];
      return {
        type: type,
        message: {
          role: event.message.role === "user" ? "user" : "assistant",
          content: text,
          stopReason: typeof event.message.stopReason === "string" ? truncateUtf8(redact(event.message.stopReason), 64) : undefined,
          errorMessage: typeof event.message.errorMessage === "string" ? truncateUtf8(redact(event.message.errorMessage), 4096) : undefined
        },
        timestamp: Number.isSafeInteger(event.timestamp) ? event.timestamp : Date.now()
      };
    }
    return {
      type: type,
      timestamp: Number.isSafeInteger(event.timestamp) ? event.timestamp : Date.now()
    };
  }

  function handleLine(line) {
    try { refreshNativeCredentialRedaction(nativeLease, nativeLeaseInstalled, nativeCredentialRedactionValues); }
    catch (_) {
      nativeLeaseFailure = true;
      abortReason = "credential snapshot verification failed";
      terminateOwnedTree(child, false);
      settledResolve({ closed: true, error: abortReason });
      return;
    }
    let event;
    try { event = JSON.parse(line); } catch (_) { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "response" && typeof event.id === "string") {
      const item = pending.get(event.id);
      if (!item) return;
      pending.delete(event.id);
      clearTimeout(item.timer);
      if (event.command !== item.command) item.reject(new Error("child response command mismatch"));
      else if (event.success !== true) item.reject(new Error(redact(event.error || (item.command + " failed"))));
      else item.resolve(event.data);
      return;
    }
    if (event.type === "extension_ui_request") {
      const approval = boundedApproval(event);
      if (!approval) return;
      if (approval.unsupported) {
        sendNotification({ type: "extension_ui_response", id: approval.id, cancelled: true });
        return;
      }
      if (pendingApproval && pendingApproval.id !== approval.id) {
        sendNotification({ type: "extension_ui_response", id: approval.id, cancelled: true });
        return;
      }
      pendingApproval = approval;
      appendTranscript({
        type: "joko.subagent.approval_requested",
        approvalId: approval.id,
        method: approval.method,
        title: approval.title,
        at: approval.requestedAt
      });
      flushStatus();
      return;
    }
    appendTranscript(safeTranscriptEvent(event));
    if (event.type === "tool_execution_start") toolUses += 1;
    if (event.type === "message_end" && event.message && event.message.role === "assistant") latestAssistant = sanitizedClone(event.message, redact);
    if (event.type === "queue_update" && expectedQueue) {
      const values = expectedQueue.action === "steer" ? event.steering : event.followUp;
      if (Array.isArray(values) && values.includes(expectedQueue.message)) expectedQueue.observed = true;
    }
    if (event.type === "agent_settled") settledResolve({ closed: false });
  }

  function closeChild() {
    if (!child || childClosed) return Promise.resolve();
    try { child.stdin.end(); } catch (_) {}
    const timer = setTimeout(function () { terminateOwnedTree(child, true); }, EXIT_GRACE_MS);
    return new Promise(function (resolve) {
      if (childClosed) {
        clearTimeout(timer);
        resolve();
        return;
      }
      child.once("close", function () {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function applyControl(control) {
    if (
      !control || control.format !== FORMAT || !Number.isSafeInteger(control.seq) || control.seq <= lastControlSeq
      || control.runId !== config.runId || control.launchToken !== config.launchToken
      || control.productSessionId !== config.productSessionId || control.taskId !== config.taskId
      || !isUuid(control.requestId)
    ) return;
    lastControlSeq = control.seq;
    const receipt = { requestId: control.requestId, action: control.action, accepted: false, observedAt: Date.now() };
    try {
      if (control.action === "stop") {
        abortReason = "cancelled";
        if (child) {
          const ownedChild = child;
          abortForceTimer = setTimeout(function () {
            if (!endedAt && !childClosed) terminateOwnedTree(ownedChild, true);
          }, EXIT_GRACE_MS);
          await sendRpc({ type: "abort" }, RPC_TIMEOUT_MS + EXIT_GRACE_MS);
        }
        else settledResolve({ closed: false });
        receipt.accepted = true;
      } else if (control.action === "steer" || control.action === "follow_up") {
        if (state !== "running" || typeof control.message !== "string" || control.message.length < 1 || control.message.length > 32000) {
          throw new Error("control requires a live run and bounded message");
        }
        expectedQueue = { action: control.action, message: control.message, observed: false };
        await sendRpc({ type: control.action === "steer" ? "steer" : "follow_up", message: control.message });
        const until = Date.now() + 750;
        while (!expectedQueue.observed && Date.now() < until && state === "running") {
          await new Promise(function (resolve) { setTimeout(resolve, 25); });
        }
        if (!expectedQueue.observed) throw new Error("child queue acknowledgement was not observed");
        expectedQueue = undefined;
        receipt.accepted = true;
      } else {
        throw new Error("unsupported control action");
      }
    } catch (failure) {
      expectedQueue = undefined;
      receipt.error = truncateUtf8(redact(failure && failure.message ? failure.message : failure), 2000);
    }
    if (receipt.accepted) appendTranscript({
      type: "joko.subagent.control",
      action: control.action,
      message: typeof control.message === "string" ? redact(control.message) : undefined,
      at: Date.now()
    });
    lastControl = receipt;
    flushStatus();
  }

  function stopControlWaiting() {
    try {
      const candidate = readJson(controlPath, 64 * 1024);
      return candidate && candidate.action === "stop" && Number.isSafeInteger(candidate.seq)
        && candidate.seq > lastControlSeq && candidate.runId === config.runId
        && candidate.launchToken === config.launchToken && candidate.productSessionId === config.productSessionId
        && candidate.taskId === config.taskId;
    } catch (_) {
      return false;
    }
  }

  async function applyApprovalControl(control) {
    if (
      !control || control.format !== FORMAT || control.action !== "approval" || !isUuid(control.requestId)
      || control.requestId === handledApprovalRequestId || control.runId !== config.runId
      || control.launchToken !== config.launchToken || control.productSessionId !== config.productSessionId
      || control.productGeneration !== config.productGeneration || control.taskId !== config.taskId
      || control.childId !== config.childId || typeof control.approvalId !== "string"
    ) return;
    handledApprovalRequestId = control.requestId;
    const receipt = { requestId: control.requestId, action: "approval", accepted: false, observedAt: Date.now() };
    try {
      if (abortReason || state !== "running" || stopControlWaiting()) throw new Error("approval denied because the child is stopping");
      if (!pendingApproval || pendingApproval.id !== control.approvalId || pendingApproval.childId !== control.childId) {
        throw new Error("approval request is no longer pending");
      }
      let response;
      if (pendingApproval.method === "confirm") {
        response = {
          type: "extension_ui_response",
          id: pendingApproval.id,
          confirmed: control.confirmed === true
        };
      } else if (pendingApproval.method === "input" && typeof control.value === "string" && control.value.length <= 1024) {
        response = { type: "extension_ui_response", id: pendingApproval.id, value: control.value };
      } else {
        response = { type: "extension_ui_response", id: pendingApproval.id, cancelled: true };
      }
      if (!sendNotification(response)) throw new Error("child approval response could not be delivered");
      appendTranscript({
        type: "joko.subagent.approval_decision",
        approvalId: pendingApproval.id,
        confirmed: response.confirmed === true,
        cancelled: response.cancelled === true,
        at: Date.now()
      });
      pendingApproval = undefined;
      receipt.accepted = true;
    } catch (failure) {
      receipt.error = truncateUtf8(redact(failure && failure.message ? failure.message : failure), 2000);
    }
    lastApprovalControl = receipt;
    flushStatus();
  }

  let controlBusy = false;
  const controlTimer = setInterval(function () {
    if (controlBusy || endedAt) return;
    controlBusy = true;
    Promise.resolve().then(function () {
      let control;
      let approvalControl;
      try { control = readJson(controlPath, 64 * 1024); } catch (failure) {
        if (!failure || failure.code !== "ENOENT") return;
      }
      try { approvalControl = readJson(approvalControlPath, 64 * 1024); } catch (failure) {
        if (!failure || failure.code !== "ENOENT") return;
      }
      if (control && control.action === "stop") {
        return applyControl(control).then(function () { return applyApprovalControl(approvalControl); });
      }
      const controlAt = control && Number.isFinite(control.requestedAt) ? control.requestedAt : Number.MAX_SAFE_INTEGER;
      const approvalAt = approvalControl && Number.isFinite(approvalControl.requestedAt) ? approvalControl.requestedAt : Number.MAX_SAFE_INTEGER;
      return controlAt <= approvalAt
        ? applyControl(control).then(function () { return applyApprovalControl(approvalControl); })
        : applyApprovalControl(approvalControl).then(function () { return applyControl(control); });
    }).catch(function (failure) {
      fail("control processing failed: " + redact(failure && failure.message ? failure.message : failure));
    }).finally(function () { controlBusy = false; });
  }, CONTROL_POLL_MS);
  const heartbeatTimer = setInterval(function () {
    if (endedAt) return;
    try { flushStatus(); } catch (failure) { fail("status heartbeat failed: " + redact(failure)); }
  }, HEARTBEAT_MS);

  let resultText = "";
  let childSlot;
  try {
    flushStatus();
    const slotDeadline = startedAt + config.timeoutMs;
    while (!childSlot && !abortReason) {
      childSlot = tryAcquireChildSlot(config.slotRoot, config, runnerInstanceId);
      if (childSlot) break;
      if (Date.now() >= slotDeadline) {
        abortReason = "timeout";
        break;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
    if (abortReason) throw new Error(abortReason === "timeout" ? "subagent timed out while queued" : "subagent aborted while queued");
    state = "running";
    summary = "running";
    flushStatus();
    if (nativeLease) {
      const acquired = await nativeAuthRequest(nativeLease, "acquire");
      if (acquired.active !== true) throw new Error("native credential lease is invalid, expired, or revoked");
      nativeCredentialRedactionValues.push(nativeLease.recoveryProof);
      nativeLeaseAcquired = true;
      nativeLeaseInstalled = installNativeAuth(config, nativeLease, acquired.credential, nativeCredentialRedactionValues);
    }
    const launch = config.child;
    child = spawn(launch.command, launch.args, {
      cwd: config.workspaceRoot,
      env: childEnv,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.on("error", function () {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", lineReader(handleLine));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", function (chunk) {
      try { refreshNativeCredentialRedaction(nativeLease, nativeLeaseInstalled, nativeCredentialRedactionValues); }
      catch (_) {
        nativeLeaseFailure = true;
        abortReason = "credential snapshot verification failed";
        terminateOwnedTree(child, false);
        return;
      }
      if (stderr.length < 4096) stderr += redact(String(chunk));
    });
    child.on("error", function (failure) {
      error = "child process error: " + redact(failure && failure.message ? failure.message : failure);
      rejectPending(error);
      settledResolve({ closed: true, error: error });
    });
    child.on("close", function (code) {
      childClosed = true;
      const closeError = error || stderr || "child exited with code " + String(code);
      rejectPending(closeError);
      settledResolve({ closed: true, error: closeError });
    });
    const initial = await sendRpc({ type: "get_state" });
    if (!initial || initial.sessionId !== config.nativeSessionId || initial.isStreaming !== false) {
      throw new Error("child returned invalid initial state");
    }
    childSessionId = initial.sessionId;
    pendingMessageCount = typeof initial.pendingMessageCount === "number" ? initial.pendingMessageCount : 0;
    if (nativeLease && nativeLeaseAcquired) {
      nativeLeaseTimer = setInterval(function () {
        if (nativeLeaseBusy || endedAt || nativeLeaseFailure) return;
        nativeLeaseBusy = true;
        void nativeAuthRequest(nativeLease, "validate").then(function (result) {
          if (result.active !== true) throw new Error("native credential lease is invalid, expired, or revoked");
        }).catch(function () {
          nativeLeaseFailure = true;
          abortReason = "credential lease revoked";
          void sendRpc({ type: "abort" }, RPC_TIMEOUT_MS + EXIT_GRACE_MS).catch(function () { terminateOwnedTree(child, false); });
        }).finally(function () { nativeLeaseBusy = false; });
      }, NATIVE_AUTH_VALIDATE_INTERVAL_MS);
      if (nativeLeaseTimer && typeof nativeLeaseTimer.unref === "function") nativeLeaseTimer.unref();
    }
    appendTranscript({ type: "joko.subagent.parent", message: redact(config.initialMessage), at: Date.now() });
    flushStatus();
    await sendRpc({ type: "prompt", message: config.initialMessage });
    const remainingTimeout = Math.max(1, startedAt + config.timeoutMs - Date.now());
    const timeoutTimer = setTimeout(function () {
      abortReason = "timeout";
      void sendRpc({ type: "abort" }, RPC_TIMEOUT_MS + EXIT_GRACE_MS).catch(function () { terminateOwnedTree(child, false); });
    }, remainingTimeout);
    const outcome = await settled;
    clearTimeout(timeoutTimer);
    if (outcome && outcome.closed && !abortReason) throw new Error(outcome.error || "child closed before settlement");

    if (!childClosed) {
      const values = await Promise.all([
        sendRpc({ type: "get_state" }),
        sendRpc({ type: "get_messages" }),
        sendRpc({ type: "get_session_stats" })
      ]);
      const finalState = values[0];
      const messages = values[1];
      const stats = values[2];
      if (!finalState || finalState.sessionId !== childSessionId || finalState.isStreaming !== false) throw new Error("child final state mismatch");
      if (!messages || !Array.isArray(messages.messages) || !stats || stats.sessionId !== childSessionId) throw new Error("child final snapshot invalid");
      pendingMessageCount = typeof finalState.pendingMessageCount === "number" ? finalState.pendingMessageCount : 0;
      if (typeof finalState.sessionFile === "string" && path.isAbsolute(finalState.sessionFile)) {
        const candidate = path.resolve(finalState.sessionFile);
        if (!isContained(config.childSessionDir, candidate) && !(config.resumeSessionPath && samePath(candidate, config.resumeSessionPath))) {
          throw new Error("child session file escaped durable session storage");
        }
        childSessionPath = candidate;
      }
      usage = usageFromStats(stats);
      if (typeof stats.toolCalls === "number" && Number.isFinite(stats.toolCalls) && stats.toolCalls >= 0) toolUses = stats.toolCalls;
      for (let index = messages.messages.length - 1; index >= 0; index -= 1) {
        const message = messages.messages[index];
        if (message && message.role === "assistant") { latestAssistant = sanitizedClone(message, redact); break; }
      }
    }

    resultText = assistantText(latestAssistant, redact).trim();
    const stopReason = latestAssistant && typeof latestAssistant.stopReason === "string" ? latestAssistant.stopReason : "";
    const assistantError = latestAssistant && typeof latestAssistant.errorMessage === "string" ? redact(latestAssistant.errorMessage) : "";
    if (nativeLeaseFailure) {
      state = "failed";
      summary = "native credential lease was revoked";
      error = summary;
    } else if (abortReason || stopReason === "aborted") {
      state = "aborted";
      summary = resultText || (abortReason === "timeout" ? "subagent timed out" : "subagent aborted");
    } else if (!latestAssistant || stopReason === "error") {
      state = "failed";
      summary = resultText || assistantError || "subagent produced no successful assistant result";
      error = summary;
    } else {
      state = "completed";
      summary = resultText || "(subagent produced no output)";
    }
  } catch (failure) {
    state = nativeLeaseFailure ? "failed" : abortReason ? "aborted" : "failed";
    summary = nativeLeaseFailure ? "native credential lease was revoked"
      : abortReason === "timeout" ? "subagent timed out" : abortReason ? "subagent aborted" : redact(failure && failure.message ? failure.message : failure);
    error = state === "failed" ? summary : undefined;
    terminateOwnedTree(child, false);
  } finally {
    clearInterval(controlTimer);
    clearInterval(heartbeatTimer);
    if (nativeLeaseTimer) clearInterval(nativeLeaseTimer);
    await closeChild();
    if (abortForceTimer) clearTimeout(abortForceTimer);
    if (nativeLease && nativeLeaseAcquired) {
      let changedCredential;
      try { changedCredential = changedNativeCredential(config, nativeLease, nativeLeaseInstalled, nativeCredentialRedactionValues); }
      catch (_) {
        state = "failed";
        summary = "native credential refresh could not be verified";
        error = summary;
      } finally {
        removeNativeAuthSnapshot(nativeLeaseInstalled && nativeLeaseInstalled.authPath);
      }
      try { await nativeAuthRequest(nativeLease, "release", changedCredential); }
      catch (_) {
        // Once the private auth snapshot is deleted, an unchanged credential
        // carries nothing that must be persisted. A transient terminal ACK
        // outage must not turn a successful Run into failure. A changed OAuth
        // credential, however, must never be silently discarded at expiry.
        if (changedCredential !== undefined && !nativeLeaseFailure) {
          state = "failed";
          summary = "native credential lease release failed";
          error = summary;
        }
      }
    }
    if (childSessionPath) {
      try {
        sanitizeNativeSession(childSessionPath, config.childSessionDir, config.resumeSessionPath, redact);
      } catch (failure) {
        try { fs.rmSync(childSessionPath, { force: true }); } catch (_) {}
        childSessionPath = undefined;
        state = "failed";
        summary = "native child session credential scrubbing failed; the unsafe session was removed";
        error = summary + ": " + truncateUtf8(redact(failure && failure.message ? failure.message : failure), 1000);
      }
    }
    releaseChildSlot(childSlot, config, runnerInstanceId);
    endedAt = Date.now();
    const boundedResult = truncateUtf8(resultText || summary, MAX_RESULT_BYTES - 4096);
    try {
      atomicWriteJson(resultPath, {
        format: FORMAT,
        runId: config.runId,
        launchToken: config.launchToken,
        taskId: config.taskId,
        state: state,
        result: boundedResult,
        truncated: Buffer.byteLength(resultText || summary, "utf8") > Buffer.byteLength(boundedResult, "utf8"),
        usage: usage,
        toolUses: toolUses,
        durationMs: Math.max(0, endedAt - startedAt)
      });
    } catch (failure) { fail("result write failed: " + redact(failure)); }
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try { flushStatus(); break; }
        catch (failure) {
          if (attempt === 11) throw failure;
          await new Promise(function (resolve) { setTimeout(resolve, 100); });
        }
      }
    } catch (failure) { fail("terminal status write failed: " + redact(failure)); }
    try { fs.rmSync(config.temporaryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); } catch (_) {}
    try { fs.rmSync(config.childHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); } catch (_) {}
    try { fs.rmdirSync(path.dirname(config.childHome)); } catch (_) {}
    try { fs.rmdirSync(path.dirname(path.dirname(config.childHome))); } catch (_) {}
  }
}

main().catch(function (error) {
  fail(redactFailure(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
`;
