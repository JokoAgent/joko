export const MANAGED_SUBAGENT_FILE_NAME = "joko-managed-subagent.ts";
export const MANAGED_SUBAGENT_TOOL_NAME = "subagent";
export const MANAGED_SUBAGENT_STATUS_TOOL_NAME = "subagent_status";
export const MANAGED_SUBAGENT_COMMAND_NAME = "subagents";
export const MANAGED_SUBAGENT_CONTROL_COMMAND_NAME = "joko-stop-background-task";
export const MANAGED_SUBAGENT_PRODUCT_SESSION_ENV = "JOKO_PI_PRODUCT_SESSION_ID";
export const MANAGED_SUBAGENT_CREDENTIAL_NAMES_ENV = "JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES";
export const MANAGED_SUBAGENT_DEPTH_ENV = "JOKO_PI_SUBAGENT_DEPTH";
export const MANAGED_SUBAGENT_PARENT_PID_ENV = "JOKO_PI_SUBAGENT_PARENT_PID";
export const MANAGED_SUBAGENT_ACTIVITY_MARKER = "__jokoSubagentActivity";
export const MANAGED_SUBAGENT_SOFT_LIMIT_ENV = "JOKO_PI_WORKER_SOFT_LIMIT";
export const MANAGED_SUBAGENT_HARD_LIMIT_ENV = "JOKO_PI_WORKER_HARD_LIMIT";
export const MANAGED_SUBAGENT_IDLE_RELEASE_ENV = "JOKO_PI_WORKER_IDLE_RELEASE_MINUTES";

/**
 * Self-contained Pi extension loaded explicitly after --no-extensions. It uses
 * only Pi's public Extension API, typebox, and Node built-ins, so it follows the
 * installed latest Pi package instead of importing a version-pinned runtime.
 */
export const MANAGED_SUBAGENT_SOURCE = String.raw`/**
 * Joko managed Pi subagent extension.
 *
 * Includes Apache-2.0 licensed portions.
 * Copyright 2026 XD Inc.
 * Generated and overwritten by Orchestrator; do not edit in Agent Home.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const TOOL_NAME = "subagent";
const STATUS_TOOL_NAME = "subagent_status";
const COMMAND_NAME = "subagents";
const CONTROL_COMMAND_NAME = "joko-stop-background-task";
const MARKER = "__jokoSubagentActivity";
const DEPTH_ENV = "JOKO_PI_SUBAGENT_DEPTH";
const PARENT_PID_ENV = "JOKO_PI_SUBAGENT_PARENT_PID";
const CREDENTIAL_NAMES_ENV = "JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES";
const SOFT_LIMIT_ENV = "JOKO_PI_WORKER_SOFT_LIMIT";
const HARD_LIMIT_ENV = "JOKO_PI_WORKER_HARD_LIMIT";
const IDLE_RELEASE_ENV = "JOKO_PI_WORKER_IDLE_RELEASE_MINUTES";
const CONFIG_HOME_ENV = "PI_CODING_AGENT_DIR";
const MCP_DESCRIPTOR_ENV = "JOKO_PI_MCP_DESCRIPTOR_FILE";
const MCP_TOKEN_ENV = "JOKO_PI_MCP_TOKEN";
const NATIVE_AUTH_RESERVATION_TOKEN_ENV = "JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN";
const NATIVE_AUTH_PROVIDER_IDS_ENV = "JOKO_PI_NATIVE_AUTH_PROVIDER_IDS";
const NATIVE_AUTHENTICATED_PROVIDER_IDS_ENV = "JOKO_PI_NATIVE_AUTHENTICATED_PROVIDER_IDS";
const PRODUCT_SESSION_ENV = "JOKO_PI_PRODUCT_SESSION_ID";
const RUN_ROOT_ENV = "JOKO_PI_SUBAGENT_RUN_ROOT";
const NODE_EXECUTABLE_ENV = "JOKO_PI_SUBAGENT_NODE_EXECUTABLE";
const RUNNER_FILE_NAME = "joko-managed-subagent-runner.cjs";
const RUN_FORMAT = 1;
const MAX_DURABLE_JSON_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024 + 4096;
const MAX_POLICY_DECISION_TITLE_CHARS = 9 * 1024;
const DURABLE_OBSERVER_INTERVAL_MS = 250;
const DURABLE_HEARTBEAT_STALE_MS = 10000;
const DURABLE_CONTROL_TIMEOUT_MS = 15000;
const NATIVE_AUTH_REQUEST_TIMEOUT_MS = 5000;
const NATIVE_AUTH_VALIDATE_INTERVAL_MS = 5000;
const MAX_NATIVE_AUTH_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 1;
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_LIVE_CHILDREN = 20;
const DEFAULT_WORKER_SOFT_LIMIT = 5;
const DEFAULT_WORKER_HARD_LIMIT = 8;
const DEFAULT_WORKER_IDLE_RELEASE_MINUTES = 0;
const MAX_WORKER_IDLE_RELEASE_MINUTES = 120;
const IDLE_RELEASE_SWEEP_MS = 5000;
const MAX_RECENT_JOBS = 64;
const MAX_TASK_CHARS = 32000;
const MAX_PARENT_CONTEXT_CHARS = 32000;
const MAX_MODEL_CHARS = 500;
const MAX_TITLE_CHARS = 120;
const MAX_TASK_ID_CHARS = 64;
const MAX_CUSTOM_ROLE_NAME_CHARS = 64;
const MAX_CUSTOM_ROLE_PROMPT_CHARS = 4000;
const MAX_CONTROL_CHARS = 32000;
const MAX_OUTPUT_CHARS = 16000;
const MAX_TOTAL_OUTPUT_CHARS = 32000;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 86400;
const PARENT_WATCHDOG_INTERVAL_MS = 2000;
const KILL_GRACE_MS = 2000;
const SETTLE_FALLBACK_MS = 5000;
const CONTROL_TIMEOUT_MS = 5000;
const SAFE_ENV_NAMES = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "VITEST_MAX_FORKS", "VITEST_MAX_THREADS", "CARGO_BUILD_JOBS", "MAKEFLAGS"
];
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CUSTOM_TOOL_CLASSES = {
  read: "read",
  search: "read,grep,find,ls"
};
const WRITE_TOOLS = "read,grep,find,ls,edit,write,bash";
const READ_ONLY_ROLE_POLICY = "This child is strictly read-only. Never edit files, run shell commands, inspect environment variables or runtime credentials, or claim that a change was applied. Do not attempt to create another child. ";
const PROFILES = {
  scout: {
    toolClass: "search",
    tools: "read,grep,find,ls",
    prompt: READ_ONLY_ROLE_POLICY + "You are a scout subagent. Investigate only the requested question. Use concise conclusions with file:line anchors and never paste long file contents."
  },
  reviewer: {
    toolClass: "search",
    tools: "read,grep,find,ls",
    prompt: READ_ONLY_ROLE_POLICY + "You are a code review subagent. Report concrete defects with file:line anchors, severity, and a failure scenario. If no real defect exists, say so plainly."
  },
  planner: {
    toolClass: "search",
    tools: "read,grep,find,ls",
    prompt: READ_ONLY_ROLE_POLICY + "You are a planning subagent. Produce a concrete ordered implementation plan with file:line evidence and risks."
  },
  worker: {
    toolClass: "write",
    tools: WRITE_TOOLS,
    readOnly: false,
    prompt: "You are an implementation worker subagent. Complete the assigned change, use the managed permission bridge for every protected operation, validate the result, and report changed files and checks. Do not attempt to create another child."
  },
  oracle: {
    toolClass: "search",
    tools: "read,grep,find,ls",
    prompt: READ_ONLY_ROLE_POLICY + "You are an oracle subagent for difficult technical decisions. Test competing explanations against repository evidence, identify tradeoffs and uncertainty, and recommend the safest conclusion with file:line anchors."
  },
  researcher: {
    toolClass: "search",
    tools: "read,grep,find,ls",
    prompt: READ_ONLY_ROLE_POLICY + "You are a research subagent. Gather and synthesize the minimum relevant repository evidence, distinguish facts from inference, and cite file:line anchors."
  },
  delegate: {
    toolClass: "search",
    tools: "read,grep,find,ls",
    prompt: READ_ONLY_ROLE_POLICY + "You are a delegation-design subagent. Decompose the assignment into independent, bounded work briefs with dependencies and acceptance checks. You cannot launch children yourself."
  }
};
for (const profile of Object.values(PROFILES)) {
  if (profile.readOnly === undefined) profile.readOnly = true;
}

const liveChildren = new Set();
const liveHomes = new Set();
const jobs = new Map();
let reservedWorkerSlots = 0;
let idleReleaseTimer;
const productSessionId = typeof process.env[PRODUCT_SESSION_ENV] === "string" ? process.env[PRODUCT_SESSION_ENV] : "";
const productGeneration = Number.parseInt(process.env.JOKO_PI_GENERATION || "-1", 10);
const configuredRunRoot = typeof process.env[RUN_ROOT_ENV] === "string" ? process.env[RUN_ROOT_ENV] : "";
const configuredNodeExecutable = typeof process.env[NODE_EXECUTABLE_ENV] === "string" ? process.env[NODE_EXECUTABLE_ENV] : "";
const workerSoftLimit = boundedEnvironmentInteger(SOFT_LIMIT_ENV, DEFAULT_WORKER_SOFT_LIMIT, 1, MAX_LIVE_CHILDREN);
const workerHardLimit = boundedEnvironmentInteger(HARD_LIMIT_ENV, DEFAULT_WORKER_HARD_LIMIT, workerSoftLimit, MAX_LIVE_CHILDREN);
const workerIdleReleaseMinutes = boundedEnvironmentInteger(
  IDLE_RELEASE_ENV,
  DEFAULT_WORKER_IDLE_RELEASE_MINUTES,
  0,
  MAX_WORKER_IDLE_RELEASE_MINUTES
);
delete process.env[PRODUCT_SESSION_ENV];
delete process.env[RUN_ROOT_ENV];
delete process.env[NODE_EXECUTABLE_ENV];
delete process.env[SOFT_LIMIT_ENV];
delete process.env[HARD_LIMIT_ENV];
delete process.env[IDLE_RELEASE_ENV];
const credentialNames = readCredentialNames();
const nativeAuthReservationToken = typeof process.env[NATIVE_AUTH_RESERVATION_TOKEN_ENV] === "string"
  && /^[A-Za-z0-9_-]{43}$/.test(process.env[NATIVE_AUTH_RESERVATION_TOKEN_ENV])
  ? process.env[NATIVE_AUTH_RESERVATION_TOKEN_ENV]
  : undefined;
delete process.env[NATIVE_AUTH_RESERVATION_TOKEN_ENV];
const inheritedCredentials = new Map();
for (const name of credentialNames) {
  if (name === NATIVE_AUTH_RESERVATION_TOKEN_ENV) continue;
  const value = process.env[name];
  if (typeof value === "string" && value.length > 0) inheritedCredentials.set(name, value);
}
const inheritedRedactionValues = Array.from(inheritedCredentials.values());
if (nativeAuthReservationToken) inheritedRedactionValues.push(nativeAuthReservationToken);
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 4) continue;
  inheritedRedactionValues.push(value);
  try {
    const parsed = new URL(value);
    if (parsed.username.length >= 4) inheritedRedactionValues.push(decodeURIComponent(parsed.username));
    if (parsed.password.length >= 4) inheritedRedactionValues.push(decodeURIComponent(parsed.password));
  } catch {
  }
}
const configuredNativeAuthProviderIds = readProviderIdSet(NATIVE_AUTH_PROVIDER_IDS_ENV);
const configuredNativeAuthenticatedProviderIds = readProviderIdSet(NATIVE_AUTHENTICATED_PROVIDER_IDS_ENV);
for (const providerId of configuredNativeAuthenticatedProviderIds) {
  if (!configuredNativeAuthProviderIds.has(providerId)) throw new Error("managed authenticated Provider snapshot escaped its catalog");
}
const nativeAuthLeaseConfiguration = readNativeAuthLeaseConfiguration();
delete process.env[NATIVE_AUTH_PROVIDER_IDS_ENV];
delete process.env[NATIVE_AUTHENTICATED_PROVIDER_IDS_ENV];
delete process.env[CREDENTIAL_NAMES_ENV];

function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const parsed = typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function readCredentialNames() {
  try {
    const value = JSON.parse(process.env[CREDENTIAL_NAMES_ENV] || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(function (name) {
      return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
    });
  } catch {
    return [];
  }
}

function readDepth() {
  const value = Number.parseInt(process.env[DEPTH_ENV] || "0", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function installParentWatchdog() {
  const parentPid = Number.parseInt(process.env[PARENT_PID_ENV] || "", 10);
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) return;
  const timer = setInterval(function () {
    let alive = true;
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      alive = !!error && error.code === "EPERM";
    }
    if (!alive) {
      clearInterval(timer);
      process.exit(0);
    }
  }, PARENT_WATCHDOG_INTERVAL_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
}

function profileNames() {
  return Object.keys(PROFILES).join(" | ");
}

function clampText(value, maximum, extraSecrets) {
  if (typeof value !== "string") return "";
  const text = redact(value.trim(), extraSecrets);
  if (text.length <= maximum) return text;
  return text.slice(0, maximum - 1) + "…";
}

function redact(value, extraSecrets) {
  let text = typeof value === "string" ? value : String(value || "");
  const values = inheritedRedactionValues.concat(extraSecrets || []);
  for (const secret of values) {
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/giu, "Bearer [REDACTED]");
  return text;
}

function isContained(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix));
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function readProviderIdSet(name) {
  let value;
  try {
    value = JSON.parse(process.env[name] || "[]");
  } catch {
    throw new Error("managed native Provider snapshot is invalid");
  }
  if (!Array.isArray(value)) throw new Error("managed native Provider snapshot is invalid");
  const result = new Set();
  for (const providerId of value) {
    if (typeof providerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId) || result.has(providerId)) {
      throw new Error("managed native Provider snapshot is invalid");
    }
    result.add(providerId);
  }
  return result;
}

function readNativeAuthLeaseConfiguration() {
  const descriptorPath = process.env[MCP_DESCRIPTOR_ENV];
  const token = inheritedCredentials.get(MCP_TOKEN_ENV);
  if (typeof descriptorPath !== "string" || !isAbsolute(descriptorPath) || typeof token !== "string" || token.length < 32) return undefined;
  let descriptor;
  try { descriptor = readPrivateJson(resolve(descriptorPath), MAX_DURABLE_JSON_BYTES); }
  catch { return undefined; }
  const lease = descriptor && descriptor.nativeAuthLease;
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) return undefined;
  if (
    descriptor.generation !== productGeneration || descriptor.sessionId !== productSessionId
    || typeof descriptor.targetId !== "string" || descriptor.targetId.length < 1
    || !Number.isSafeInteger(lease.catalogGeneration) || lease.catalogGeneration < 0
    || !Array.isArray(lease.providerIds) || !Array.isArray(lease.authenticatedProviderIds)
  ) return undefined;
  let endpoint;
  try { endpoint = new URL(lease.endpoint); } catch { return undefined; }
  const host = endpoint.hostname.toLowerCase();
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !["127.0.0.1", "::1", "localhost"].includes(host)
  ) return undefined;
  const providerIds = new Set();
  for (const providerId of lease.providerIds) {
    if (typeof providerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId) || providerIds.has(providerId)) return undefined;
    providerIds.add(providerId);
  }
  const authenticatedProviderIds = new Set();
  for (const providerId of lease.authenticatedProviderIds) {
    if (!providerIds.has(providerId) || authenticatedProviderIds.has(providerId)) return undefined;
    authenticatedProviderIds.add(providerId);
  }
  return {
    endpoint: endpoint.toString(),
    token: token,
    targetId: descriptor.targetId,
    catalogGeneration: lease.catalogGeneration,
    providerIds: providerIds,
    authenticatedProviderIds: authenticatedProviderIds
  };
}

function nativeAuthRequired(providerId) {
  if (!configuredNativeAuthProviderIds.has(providerId)) return false;
  if (!configuredNativeAuthenticatedProviderIds.has(providerId)) {
    throw new Error("selected native Provider is not authenticated in this runtime generation");
  }
  if (!nativeAuthLeaseConfiguration || !nativeAuthLeaseConfiguration.providerIds.has(providerId)
      || !nativeAuthLeaseConfiguration.authenticatedProviderIds.has(providerId)) {
    throw new Error("native credential lease channel is unavailable for the selected Provider generation");
  }
  return true;
}

async function nativeAuthLeaseRequest(action, providerId, runId, runnerFence, credential) {
  const lease = nativeAuthLeaseConfiguration;
  if (!lease) throw new Error("native credential lease channel is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, NATIVE_AUTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(lease.endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: "Bearer " + lease.token,
        "content-type": "application/json",
        "x-joko-pi-generation": String(productGeneration)
      },
      body: JSON.stringify({
        action: action,
        generation: productGeneration,
        runnerProductGeneration: productGeneration,
        sessionId: productSessionId,
        targetId: lease.targetId,
        providerId: providerId,
        catalogGeneration: lease.catalogGeneration,
        runId: runId,
        runnerFence: runnerFence,
        ...(credential === undefined ? {} : { credential: credential })
      })
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_NATIVE_AUTH_BYTES) throw new Error("native credential lease response exceeded its bound");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_NATIVE_AUTH_BYTES) throw new Error("native credential lease response exceeded its bound");
    if (!response.ok) throw new Error("native credential lease is invalid, expired, or revoked");
    let body;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("native credential lease returned an invalid response"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.active !== "boolean") {
      throw new Error("native credential lease returned an invalid response");
    }
    if (body.active === true && (!Number.isSafeInteger(body.validForMs)
        || body.validForMs < 1 || body.validForMs > 60000)) {
      throw new Error("native credential lease returned an invalid response");
    }
    return body;
  } catch {
    throw new Error("native credential lease is invalid, expired, or revoked");
  } finally {
    clearTimeout(timeout);
  }
}

async function reserveNativeAuthRunner(providerId, runId, runnerFence, publicKey) {
  const lease = nativeAuthLeaseConfiguration;
  if (!lease || !nativeAuthReservationToken) throw new Error("native credential lease channel is unavailable");
  const deadline = performance.now() + 15000;
  let delay = 50;
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, Math.max(1, Math.min(
      NATIVE_AUTH_REQUEST_TIMEOUT_MS,
      deadline - performance.now()
    )));
    try {
      const response = await fetch(lease.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: "Bearer " + lease.token,
          "content-type": "application/json",
          "x-joko-pi-generation": String(productGeneration),
          "x-joko-pi-native-auth-reservation": nativeAuthReservationToken
        },
        body: JSON.stringify({
          action: "reserve",
          generation: productGeneration,
          runnerProductGeneration: productGeneration,
          sessionId: productSessionId,
          targetId: lease.targetId,
          providerId: providerId,
          catalogGeneration: lease.catalogGeneration,
          runId: runId,
          runnerFence: runnerFence,
          runnerRegistration: { format: 1, publicKey: publicKey }
        })
      });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_NATIVE_AUTH_BYTES) throw new Error("native runner reservation is invalid");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_NATIVE_AUTH_BYTES) throw new Error("native runner reservation is invalid");
      if (!response.ok) {
        const failure = new Error("native runner reservation is invalid");
        failure.transient = response.status >= 500 && response.status <= 599;
        throw failure;
      }
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new Error("native runner reservation is invalid"); }
      if (!body || body.reserved !== true || typeof body.reservationId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(body.reservationId)
          || !Number.isSafeInteger(body.serviceGeneration) || body.serviceGeneration < 0
          || !Number.isSafeInteger(body.validForMs) || body.validForMs < 1 || body.validForMs > 60000) {
        throw new Error("native runner reservation is invalid");
      }
      return body;
    } catch (error) {
      const transient = !error || error.name === "AbortError" || error.transient === true || error instanceof TypeError;
      if (!transient || performance.now() >= deadline) throw new Error("native runner reservation is invalid");
      await new Promise(function (resolveDelay) { setTimeout(resolveDelay, Math.min(delay, deadline - performance.now())); });
      delay = Math.min(500, delay * 2);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function acquireNativeAuthLease(providerId, runId, runnerFence) {
  if (!nativeAuthRequired(providerId)) return undefined;
  const result = await nativeAuthLeaseRequest("acquire", providerId, runId, runnerFence);
  if (result.active !== true || !result.credential || typeof result.credential !== "object" || Array.isArray(result.credential)) {
    throw new Error("native credential lease did not return the selected Provider credential");
  }
  const credentialValues = [];
  collectCredentialValues(result.credential, "credential", credentialValues);
  const initialDigest = createHash("sha256").update(JSON.stringify(result.credential)).digest("hex");
  return {
    providerId: providerId,
    runId: runId,
    runnerFence: runnerFence,
    credential: result.credential,
    initialDigest: initialDigest,
    observedDigest: initialDigest,
    installed: false,
    credentialValues: credentialValues
  };
}

function installNativeAuthLease(childHome, lease) {
  if (!lease) return;
  const authPath = join(childHome, "auth.json");
  writeFileSync(authPath, JSON.stringify({ [lease.providerId]: lease.credential }) + "\n", { flag: "wx", mode: 0o600 });
  chmodSync(authPath, 0o600);
  lease.installed = true;
}

function removeInitialNativeAuthSnapshot(childHome) {
  try { rmSync(join(childHome, "auth.json"), { force: true }); } catch {}
}

async function validateNativeAuthLease(lease) {
  if (!lease) return;
  const result = await nativeAuthLeaseRequest("validate", lease.providerId, lease.runId, lease.runnerFence);
  if (result.active !== true) throw new Error("native credential lease is invalid, expired, or revoked");
}

async function releaseNativeAuthLease(lease, childHome) {
  if (!lease) return;
  let changedCredential;
  try {
    const current = refreshNativeAuthCredentialValues(lease, childHome);
    if (current && current.digest !== lease.initialDigest) changedCredential = current.credential;
  } finally {
    removeInitialNativeAuthSnapshot(childHome);
  }
  await nativeAuthLeaseRequest("release", lease.providerId, lease.runId, lease.runnerFence, changedCredential);
}

function refreshNativeAuthCredentialValues(lease, childHome) {
  if (!lease || lease.installed !== true) return undefined;
  const value = readPrivateJson(join(childHome, "auth.json"), MAX_NATIVE_AUTH_BYTES);
  const credential = value && typeof value === "object" && !Array.isArray(value) ? value[lease.providerId] : undefined;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new Error("native credential snapshot no longer contains the leased Provider");
  }
  const digest = createHash("sha256").update(JSON.stringify(credential)).digest("hex");
  if (digest !== lease.observedDigest) {
    collectCredentialValues(credential, "credential", lease.credentialValues);
    lease.observedDigest = digest;
  }
  return { credential: credential, digest: digest };
}

function gitPath(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) {
    throw new Error("subagent isolation requires a Git worktree-backed parent task");
  }
  return realpathSync(resolve(process.cwd(), result.stdout.trim()));
}

function enforceIsolation(input) {
  const isolation = input && input.isolation === "require-worktree" ? "require-worktree" : "inherit";
  if (isolation !== "require-worktree") return;
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, shell: false
  });
  if (inside.error || inside.status !== 0 || String(inside.stdout || "").trim() !== "true") {
    throw new Error("subagent isolation requires a Git worktree-backed parent task");
  }
  const gitDirectory = gitPath(["rev-parse", "--git-dir"]);
  const commonDirectory = gitPath(["rev-parse", "--git-common-dir"]);
  const worktreeRoot = gitPath(["rev-parse", "--show-toplevel"]);
  const cwd = realpathSync(process.cwd());
  if (!isContained(worktreeRoot, cwd)) throw new Error("subagent isolation could not verify the active Git worktree root");
  if (samePath(gitDirectory, commonDirectory) || !isContained(commonDirectory, gitDirectory)) {
    throw new Error("subagent isolation requires an authoritative linked Git worktree, not the primary checkout");
  }
}

function parentContextSnapshot(ctx) {
  try {
    const branch = ctx && ctx.sessionManager && typeof ctx.sessionManager.getBranch === "function"
      ? ctx.sessionManager.getBranch()
      : [];
    const sections = [];
    for (const entry of Array.isArray(branch) ? branch : []) {
      if (!entry || entry.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      const text = content.map(function (block) {
        return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
      }).join("").trim();
      if (text) sections.push(String(role).toUpperCase() + ":\n" + text);
    }
    return clampText(sections.join("\n\n"), MAX_PARENT_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

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

function copyManagedFile(parentHome, childHome, name, maximumBytes, required, credentialValues) {
  const source = join(parentHome, name);
  let before;
  try {
    before = lstatSync(source);
  } catch (error) {
    if (!required && error && error.code === "ENOENT") return;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error("unsafe managed child configuration file: " + name);
  }
  const canonical = realpathSync(source);
  if (!isContained(parentHome, canonical) || !samePath(canonical, source)) {
    throw new Error("managed child configuration path alias denied: " + name);
  }
  const bytes = readFileSync(canonical);
  const after = statSync(canonical);
  if (!after.isFile() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("managed child configuration changed while being copied: " + name);
  }
  const destination = join(childHome, name);
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(destination, 0o600);
  if (name === "auth.json") {
    try {
      collectCredentialValues(JSON.parse(bytes.toString("utf8")), "", credentialValues);
    } catch {
      throw new Error("managed child auth snapshot is invalid");
    }
  }
}

function prepareChildHome() {
  const configured = process.env[CONFIG_HOME_ENV];
  if (typeof configured !== "string" || !isAbsolute(configured)) throw new Error("managed parent Agent Home is unavailable");
  const parentHome = realpathSync(configured);
  if (!samePath(parentHome, resolve(configured))) throw new Error("managed parent Agent Home path alias denied");
  const root = join(dirname(parentHome), "subagents");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const canonicalRoot = realpathSync(root);
  if (!samePath(canonicalRoot, root)) throw new Error("managed subagent root path alias denied");
  const childHome = mkdtempSync(join(canonicalRoot, "child-"));
  chmodSync(childHome, 0o700);
  liveHomes.add(childHome);
  const credentialValues = [];
  try {
    copyManagedFile(parentHome, childHome, "models.json", 16 * 1024 * 1024, true, credentialValues);
    writeFileSync(
      join(childHome, "settings.json"),
      JSON.stringify({ defaultProjectTrust: "never", checkForUpdates: false }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 }
    );
    return { childHome: childHome, credentialValues: credentialValues };
  } catch (error) {
    liveHomes.delete(childHome);
    rmSync(childHome, { recursive: true, force: true });
    throw error;
  }
}

function cleanupHome(childHome) {
  if (!childHome) return;
  liveHomes.delete(childHome);
  try {
    rmSync(childHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch {
  }
}

function extensionPaths() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const bridge = join(directory, "joko-managed-bridge.ts");
  const subagent = join(directory, "joko-managed-subagent.ts");
  const silentEncryptedRetry = join(directory, "joko-managed-silent-encrypted-retry.ts");
  const autoReview = join(directory, "joko-managed-auto-review.mjs");
  const runner = join(directory, RUNNER_FILE_NAME);
  for (const path of [bridge, subagent, silentEncryptedRetry, autoReview, runner]) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DURABLE_JSON_BYTES || !samePath(realpathSync(path), path)) {
      throw new Error("managed extension path is unsafe: " + basename(path));
    }
  }
  return { bridge: bridge, subagent: subagent, silentEncryptedRetry: silentEncryptedRetry, autoReview: autoReview, runner: runner };
}

function childEnvironment(childHome) {
  const environment = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  for (const entry of inheritedCredentials.entries()) environment[entry[0]] = entry[1];
  for (const name of ["JOKO_PI_CONTROL_FILE", "JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE", "JOKO_PI_WORKSPACE_ROOT", "JOKO_PI_GENERATION"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  environment.JOKO_PI_SECRET_ENV_NAMES = JSON.stringify(Array.from(inheritedCredentials.keys()));
  environment.PI_CODING_AGENT_DIR = childHome;
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment[DEPTH_ENV] = String(readDepth() + 1);
  environment[PARENT_PID_ENV] = String(process.pid);
  environment.TEMP = childHome;
  environment.TMP = childHome;
  environment.TMPDIR = childHome;
  return environment;
}

function durableRunnerEnvironment() {
  const environment = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  for (const entry of inheritedCredentials.entries()) environment[entry[0]] = entry[1];
  environment[CREDENTIAL_NAMES_ENV] = JSON.stringify(Array.from(inheritedCredentials.keys()));
  environment.JOKO_PI_SECRET_ENV_NAMES = JSON.stringify(Array.from(inheritedCredentials.keys()));
  if (nativeAuthLeaseConfiguration) {
    environment.JOKO_PI_NATIVE_AUTH_ENDPOINT = nativeAuthLeaseConfiguration.endpoint;
    environment.JOKO_PI_NATIVE_AUTH_CATALOG_GENERATION = String(nativeAuthLeaseConfiguration.catalogGeneration);
    environment.JOKO_PI_NATIVE_AUTH_TARGET_ID = nativeAuthLeaseConfiguration.targetId;
    environment.JOKO_PI_NATIVE_AUTH_PRODUCT_SESSION_ID = productSessionId;
    environment.JOKO_PI_NATIVE_AUTH_PRODUCT_GENERATION = String(productGeneration);
  }
  return environment;
}

function invocation(args) {
  const script = process.argv[1];
  if (typeof script === "string" && script.length > 0 && !script.startsWith("/$bunfs/root/")) {
    try {
      const info = lstatSync(script);
      if (info.isFile() && !info.isSymbolicLink()) return { command: process.execPath, args: [script].concat(args) };
    } catch {
    }
  }
  const executable = basename(process.execPath).toLowerCase();
  if (!/^(?:node|bun)(?:\.exe)?$/.test(executable)) return { command: process.execPath, args: args };
  return { command: "pi", args: args };
}

function atomicWritePrivateJson(path, value) {
  const parent = dirname(path);
  if (!samePath(realpathSync(parent), parent)) throw new Error("managed run write parent path alias denied");
  const temporary = path + ".tmp-" + process.pid + "-" + randomUUID();
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function readPrivateJson(path, maximum) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > (maximum || MAX_DURABLE_JSON_BYTES)) {
    throw new Error("managed run file is linked, oversized, or unavailable");
  }
  const canonical = realpathSync(path);
  if (!samePath(canonical, path)) throw new Error("managed run file path alias denied");
  const bytes = readFileSync(canonical);
  const after = statSync(canonical);
  if (!after.isFile() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("managed run file changed while being read");
  }
  return JSON.parse(bytes.toString("utf8"));
}

function copyPrivateSnapshot(source, destination, maximum, required) {
  let before;
  try { before = lstatSync(source); }
  catch (error) {
    if (!required && error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) {
    throw new Error("unsafe managed durable snapshot: " + basename(source));
  }
  const canonical = realpathSync(source);
  if (!samePath(canonical, source)) throw new Error("managed durable snapshot path alias denied: " + basename(source));
  const bytes = readFileSync(canonical);
  const after = statSync(canonical);
  if (!after.isFile() || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("managed durable snapshot changed while being copied: " + basename(source));
  }
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(destination, 0o600);
  return true;
}

function ensureDurableRoot() {
  if (!productSessionId || !configuredRunRoot || !isAbsolute(configuredRunRoot) || resolve(configuredRunRoot) !== configuredRunRoot) {
    throw new Error("managed durable background storage is unavailable");
  }
  mkdirSync(configuredRunRoot, { recursive: true, mode: 0o700 });
  chmodSync(configuredRunRoot, 0o700);
  const rootInfo = lstatSync(configuredRunRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(realpathSync(configuredRunRoot), configuredRunRoot)) {
    throw new Error("managed durable background storage is unsafe");
  }
  const key = createHash("sha256").update(productSessionId).digest("hex").slice(0, 40);
  const sessionDirectory = join(configuredRunRoot, key);
  if (!isContained(configuredRunRoot, sessionDirectory)) throw new Error("managed durable session path escaped its root");
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  chmodSync(sessionDirectory, 0o700);
  const sessionInfo = lstatSync(sessionDirectory);
  if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink() || !samePath(realpathSync(sessionDirectory), sessionDirectory)) {
    throw new Error("managed durable session storage is unsafe");
  }
  return sessionDirectory;
}

function createLeasedAuthHome(sessionDirectory, runId) {
  const runRoot = dirname(sessionDirectory);
  const authRoot = join(dirname(runRoot), "subagent-native-auth");
  const authSessionDirectory = join(authRoot, basename(sessionDirectory));
  const childHome = join(authSessionDirectory, runId);
  for (const directory of [authRoot, authSessionDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(directory), directory)) {
      throw new Error("managed native auth runtime storage is unsafe");
    }
  }
  if (!isContained(authRoot, childHome)) throw new Error("managed native auth runtime path escaped its root");
  mkdirSync(childHome, { recursive: false, mode: 0o700 });
  chmodSync(childHome, 0o700);
  if (!samePath(realpathSync(childHome), childHome)) throw new Error("managed native auth runtime path alias denied");
  return childHome;
}

function validatedNodeExecutable() {
  if (!configuredNodeExecutable || !isAbsolute(configuredNodeExecutable) || resolve(configuredNodeExecutable) !== configuredNodeExecutable) {
    throw new Error("managed durable runner executable is unavailable");
  }
  const info = lstatSync(configuredNodeExecutable);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(realpathSync(configuredNodeExecutable), configuredNodeExecutable)) {
    throw new Error("managed durable runner executable is unsafe");
  }
  return configuredNodeExecutable;
}

function durableStatusOf(runDirectory) {
  const status = readPrivateJson(join(runDirectory, "status.json"), MAX_DURABLE_JSON_BYTES);
  const config = readPrivateJson(join(runDirectory, "config.json"), MAX_DURABLE_JSON_BYTES);
  const owner = readPrivateJson(join(runDirectory, "owner.json"), MAX_DURABLE_JSON_BYTES);
  let claim;
  try { claim = readPrivateJson(join(runDirectory, "runner.claim.json"), 64 * 1024); }
  catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  const runId = basename(runDirectory);
  const runnerScript = join(runDirectory, RUNNER_FILE_NAME);
  const runnerInfo = lstatSync(runnerScript);
  const runnerScriptSha256 = runnerInfo.isFile() && !runnerInfo.isSymbolicLink() && runnerInfo.size <= MAX_DURABLE_JSON_BYTES
    ? createHash("sha256").update(readFileSync(runnerScript)).digest("hex")
    : "";
  const claimValid = claim && claim.format === RUN_FORMAT && claim.runId === runId
    && claim.launchToken === config.launchToken && claim.runnerScriptSha256 === runnerScriptSha256
    && Number.isSafeInteger(claim.runnerPid) && claim.runnerPid > 0 && typeof claim.runnerInstanceId === "string";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    || !status || status.format !== RUN_FORMAT || status.runId !== runId || status.productSessionId !== productSessionId
    || !config || config.format !== RUN_FORMAT || config.runId !== runId || config.productSessionId !== productSessionId
    || !Number.isSafeInteger(config.productGeneration) || config.productGeneration < 0 || config.productGeneration > productGeneration
    || !owner || owner.format !== RUN_FORMAT || owner.runId !== runId || owner.productSessionId !== productSessionId
    || status.launchToken !== config.launchToken || owner.launchToken !== config.launchToken
    || status.taskId !== config.taskId || owner.taskId !== config.taskId
    || status.runnerScript !== runnerScript || config.runnerScript !== runnerScript || owner.runnerScript !== runnerScript
    || status.runnerScriptSha256 !== runnerScriptSha256 || config.runnerScriptSha256 !== runnerScriptSha256
    || owner.runnerScriptSha256 !== runnerScriptSha256 || !/^[0-9a-f]{64}$/i.test(runnerScriptSha256)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(config.launchToken || ""))
    || !Number.isSafeInteger(status.runnerPid) || status.runnerPid < 0
    || !(
      owner.state === "reserved" && status.runnerPid === 0
      || owner.state === "running" && (status.runnerPid === 0
        || owner.runnerPid === status.runnerPid && owner.runnerInstanceId === status.runnerInstanceId
          && claimValid && claim.runnerPid === status.runnerPid && claim.runnerInstanceId === status.runnerInstanceId)
    )
    || claim !== undefined && !claimValid
    || owner.state === "running" && status.runnerPid > 0 && !claimValid
    || !samePath(realpathSync(runnerScript), runnerScript)
  ) throw new Error("managed durable run ownership validation failed");
  return { status: status, config: config, owner: owner };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && error.code === "EPERM"; }
}

function reconcileDurableStatus(runDirectory, snapshot) {
  const status = snapshot.status;
  if (["completed", "failed", "aborted"].includes(status.state)) return { snapshot: snapshot, waiting: false };
  const heartbeat = Number.isSafeInteger(status.heartbeatAt) ? status.heartbeatAt : 0;
  if (Date.now() - heartbeat <= DURABLE_HEARTBEAT_STALE_MS) return { snapshot: snapshot, waiting: false };
  if (processIsAlive(status.runnerPid)) return { snapshot: snapshot, waiting: true };
  const failed = Object.assign({}, status, {
    state: "failed",
    summary: "durable runner exited before publishing a terminal state",
    error: "durable runner process is gone; no disk PID was signalled",
    endedAt: Date.now(),
    heartbeatAt: Date.now()
  });
  atomicWritePrivateJson(join(runDirectory, "status.json"), failed);
  return { snapshot: Object.assign({}, snapshot, { status: failed }), waiting: false };
}

function durableResult(runDirectory, status) {
  if (!["completed", "failed", "aborted"].includes(status.state)) return undefined;
  try {
    const value = readPrivateJson(join(runDirectory, "result.json"), MAX_DURABLE_JSON_BYTES);
    if (value && value.format === RUN_FORMAT && value.runId === status.runId && value.launchToken === status.launchToken && value.taskId === status.taskId) {
      return typeof value.result === "string" ? redact(value.result) : status.summary;
    }
  } catch {}
  return typeof status.summary === "string" ? redact(status.summary) : "";
}

function durableTranscript(runDirectory) {
  const transcriptPath = join(runDirectory, "transcript.jsonl");
  try {
    const info = lstatSync(transcriptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TRANSCRIPT_BYTES || !samePath(realpathSync(transcriptPath), transcriptPath)) return [];
    const bytes = readFileSync(transcriptPath);
    const tail = bytes.subarray(Math.max(0, bytes.length - 256 * 1024)).toString("utf8");
    return tail.split("\n").filter(Boolean).slice(-256).map(function (line) {
      try { return JSON.parse(line); } catch { return { type: "joko.subagent.transcript_unreadable" }; }
    });
  } catch {
    return [];
  }
}

function applyDurableSnapshot(job, runDirectory, reconciled, pi, announce, onUpdate) {
  const status = reconciled.snapshot.status;
  const previousStatus = job.status;
  const previousSummary = job.summary;
  job.status = reconciled.waiting ? "waiting" : status.state;
  job.summary = reconciled.waiting
    ? "durable runner heartbeat is stale; ownership is retained and PID signalling is withheld"
    : clampText(status.summary || status.state, 2048);
  job.result = durableResult(runDirectory, status);
  job.transcript = durableTranscript(runDirectory);
  job.toolUses = Number.isFinite(status.toolUses) && status.toolUses >= 0 ? status.toolUses : 0;
  job.usage = status.usage && typeof status.usage === "object" ? status.usage : emptyUsage();
  job.durationMs = Number.isFinite(status.durationMs) && status.durationMs >= 0 ? status.durationMs : 0;
  job.turnCount = Number.isFinite(status.turnCount) && status.turnCount >= 0 ? status.turnCount : 0;
  job.sessionId = typeof status.nativeSessionId === "string" ? status.nativeSessionId : undefined;
  job.pendingMessageCount = Number.isFinite(status.pendingMessageCount) && status.pendingMessageCount >= 0 ? status.pendingMessageCount : 0;
  job.progressRatio = status.state === "completed" ? 1 : undefined;
  job.startedAt = Number.isSafeInteger(status.startedAt) ? status.startedAt : undefined;
  job.endedAt = Number.isSafeInteger(status.endedAt) ? status.endedAt : undefined;
  job.error = terminalError(status.state, status.error || status.summary);
  if (announce && (previousStatus !== job.status || previousSummary !== job.summary)) {
    if (job.background) publishActivity(pi, job, job.status, job.summary);
    else reportUpdate(onUpdate, activityOf(job, job.status, job.summary));
  }
  if (["completed", "failed", "aborted"].includes(status.state) && !job.completionSettled) {
    job.resolveCompletion({
      text: clampText(job.result || job.summary, MAX_OUTPUT_CHARS),
      fullText: job.result || job.summary,
      isError: status.state !== "completed",
      terminal: status.state
    });
  }
}

function stopDurableObserver(job) {
  if (!job.durable || !job.durable.observer) return;
  clearInterval(job.durable.observer);
  job.durable.observer = undefined;
}

function startDurableObserver(pi, job, onUpdate) {
  stopDurableObserver(job);
  const refresh = function () {
    if (!job.durable) return;
    try {
      const reconciled = reconcileDurableStatus(job.durable.runDirectory, durableStatusOf(job.durable.runDirectory));
      applyDurableSnapshot(job, job.durable.runDirectory, reconciled, pi, true, onUpdate);
      if (["completed", "failed", "aborted"].includes(reconciled.snapshot.status.state)) stopDurableObserver(job);
    } catch (error) {
      job.status = "waiting";
      job.summary = "durable status is temporarily unreadable; ownership is retained";
      job.error = terminalError("failed", redact(error && error.message ? error.message : error));
    }
  };
  refresh();
  if (["completed", "failed", "aborted"].includes(job.status)) return;
  job.durable.observer = setInterval(refresh, DURABLE_OBSERVER_INTERVAL_MS);
  if (job.durable.observer && typeof job.durable.observer.unref === "function") job.durable.observer.unref();
}

function durableJobFromSnapshot(runDirectory, snapshot) {
  const status = snapshot.status;
  const config = snapshot.config;
  const profile = config.profile && typeof config.profile === "object" ? config.profile : PROFILES.scout;
  const route = config.route && typeof config.route === "object" ? config.route : { provider: "", model: "", effort: "off" };
  const job = {
    id: status.taskId,
    childId: typeof status.childId === "string" ? status.childId : status.taskId + ":child",
    parentTaskId: status.parentTaskId,
    agent: status.agentName,
    title: typeof status.title === "string" ? status.title : status.agentName + " subagent",
    task: status.task,
    promptTask: status.task,
    contextMode: status.contextMode === "fork" ? "fork" : "fresh",
    profile: profile,
    route: route,
    background: true,
    timeoutMs: config.timeoutMs,
    abortReason: undefined,
    status: status.state,
    summary: status.summary || status.state,
    result: undefined,
    transcript: [],
    toolUses: 0,
    observedToolUses: 0,
    usage: emptyUsage(),
    durationMs: 0,
    turnCount: 0,
    sessionId: status.nativeSessionId,
    pendingMessageCount: 0,
    controller: undefined,
    controlBusy: false,
    progressRatio: undefined,
    startedAt: status.startedAt,
    endedAt: status.endedAt,
    error: undefined,
    durable: { runDirectory: runDirectory, createdAt: status.createdAt, observer: undefined }
  };
  resetCompletion(job);
  return job;
}

function discoverDurableJobs(pi) {
  let sessionDirectory;
  try { sessionDirectory = ensureDurableRoot(); }
  catch { return; }
  const entries = readdirSync(sessionDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const runDirectory = join(sessionDirectory, entry.name);
    if (!isContained(sessionDirectory, runDirectory)) continue;
    let snapshot;
    try { snapshot = durableStatusOf(runDirectory); } catch { continue; }
    const current = jobs.get(snapshot.status.taskId);
    if (current && Number(current.durable && current.durable.createdAt || current.startedAt || 0) >= Number(snapshot.status.createdAt || 0)) continue;
    if (current) stopDurableObserver(current);
    const job = durableJobFromSnapshot(runDirectory, snapshot);
    jobs.set(job.id, job);
    applyDurableSnapshot(job, runDirectory, reconcileDurableStatus(runDirectory, snapshot), pi, false, undefined);
    publishActivity(pi, job, job.status, job.summary);
    if (!["completed", "failed", "aborted"].includes(job.status)) startDurableObserver(pi, job, undefined);
  }
  pruneJobs();
}

function durableActiveRunCount() {
  const sessionDirectory = ensureDurableRoot();
  let count = 0;
  for (const entry of readdirSync(sessionDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    try {
      const status = reconcileDurableStatus(join(sessionDirectory, entry.name), durableStatusOf(join(sessionDirectory, entry.name))).snapshot.status;
      if (!["completed", "failed", "aborted"].includes(status.state)) count += 1;
    } catch {
      count += 1;
    }
  }
  return count;
}

function liveWorkerCount() {
  return liveChildren.size + durableActiveRunCount() + reservedWorkerSlots;
}

function retainedIdleWorkerCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (["completed", "aborted", "failed"].includes(job.status)
        && job.controller && job.controller.alive === true && job.controller.retiring !== true) count += 1;
  }
  return count;
}

function availableWorkerCapacity() {
  return Math.max(0, workerHardLimit - liveWorkerCount() + retainedIdleWorkerCount());
}

function workerLimitWarning(requestedWorkers) {
  const projected = liveWorkerCount() + Math.max(0, requestedWorkers);
  if (projected < workerSoftLimit) return undefined;
  return "Worker soft limit warning: this request can raise managed worker usage to "
    + String(projected) + " (soft " + String(workerSoftLimit) + ", hard " + String(workerHardLimit) + ").";
}

function validateResumeSession(runDirectory, snapshot) {
  const status = snapshot.status;
  const config = snapshot.config;
  const sessionPath = typeof status.nativeSessionPath === "string" ? resolve(status.nativeSessionPath) : "";
  const sessionRoot = dirname(runDirectory);
  const segments = sessionPath ? relative(sessionRoot, sessionPath).split(sep) : [];
  const nativeSessionId = typeof status.nativeSessionId === "string" ? status.nativeSessionId : "";
  const sessionFileName = segments[2] || "";
  const exactSessionFileName = nativeSessionId + ".jsonl";
  const timestampedSessionSuffix = "_" + exactSessionFileName;
  const configuredResumePath = typeof config.resumeSessionPath === "string" && isAbsolute(config.resumeSessionPath)
    ? resolve(config.resumeSessionPath)
    : "";
  if (
    !sessionPath || !isAbsolute(sessionPath) || !isContained(sessionRoot, sessionPath) || segments.length !== 3
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segments[0] || "")
    || segments[1] !== "sessions"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeSessionId)
    || config.nativeSessionId !== nativeSessionId
    || (sessionFileName !== exactSessionFileName && !sessionFileName.endsWith(timestampedSessionSuffix))
    || (configuredResumePath ? !samePath(sessionPath, configuredResumePath) : segments[0] !== basename(runDirectory))
  ) {
    throw new Error("durable child native session is unavailable or escaped storage");
  }
  const sessionDirectory = dirname(sessionPath);
  const sessionDirectoryInfo = lstatSync(sessionDirectory);
  const info = lstatSync(sessionPath);
  if (
    !sessionDirectoryInfo.isDirectory() || sessionDirectoryInfo.isSymbolicLink()
    || !samePath(realpathSync(sessionDirectory), sessionDirectory)
    || !info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024
    || !samePath(realpathSync(sessionPath), sessionPath)
  ) {
    throw new Error("durable child native session is unsafe");
  }
  const claimPath = join(runDirectory, "resume.claim");
  writeFileSync(claimPath, JSON.stringify({ format: RUN_FORMAT, requestId: randomUUID(), at: Date.now() }) + "\n", {
    flag: "wx",
    mode: 0o600
  });
  return { sessionPath: sessionPath, claimPath: claimPath };
}

async function launchDurableJob(pi, job, message, resumeSessionPath, onUpdate) {
  if (!(await ensureChildCapacity())) {
    throw new Error("[WORKER_HARD_LIMIT] managed worker hard limit " + String(workerHardLimit) + " reached");
  }
  try {
    return await launchReservedDurableJob(pi, job, message, resumeSessionPath, onUpdate);
  } finally {
    reservedWorkerSlots = Math.max(0, reservedWorkerSlots - 1);
  }
}

async function launchReservedDurableJob(pi, job, message, resumeSessionPath, onUpdate) {
  const sessionDirectory = ensureDurableRoot();
  const nodeExecutable = validatedNodeExecutable();
  const parentHomeValue = process.env[CONFIG_HOME_ENV];
  if (typeof parentHomeValue !== "string" || !isAbsolute(parentHomeValue)) throw new Error("managed parent Agent Home is unavailable");
  const parentHome = realpathSync(parentHomeValue);
  if (!samePath(parentHome, resolve(parentHomeValue))) throw new Error("managed parent Agent Home path alias denied");
  const requiresNativeAuth = nativeAuthRequired(job.route.provider);
  let runnerPrivateKey;
  let runnerProcess;
  const paths = extensionPaths();
  const runId = randomUUID();
  const runnerInstanceId = randomUUID();
  const launchToken = randomUUID();
  const runDirectory = join(sessionDirectory, runId);
  mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
  chmodSync(runDirectory, 0o700);
  if (!samePath(realpathSync(runDirectory), runDirectory)) throw new Error("managed durable run path alias denied");
  const runtimeDirectory = join(runDirectory, "runtime");
  const temporaryPath = join(runDirectory, "temporary");
  const childHome = createLeasedAuthHome(sessionDirectory, runId);
  const childSessionDirectory = join(runDirectory, "sessions");
  const slotRoot = join(sessionDirectory, "slots");
  for (const directory of [runtimeDirectory, childHome, childSessionDirectory, temporaryPath, slotRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  try {
    copyPrivateSnapshot(join(parentHome, "models.json"), join(childHome, "models.json"), 16 * 1024 * 1024, true);
    copyPrivateSnapshot(join(parentHome, "settings.json"), join(childHome, "settings.json"), 4 * 1024 * 1024, true);
    const bridgePath = join(runtimeDirectory, basename(paths.bridge));
    const subagentPath = join(runtimeDirectory, basename(paths.subagent));
    const retryPath = join(runtimeDirectory, basename(paths.silentEncryptedRetry));
    const autoReviewPath = join(runtimeDirectory, basename(paths.autoReview));
    const runnerScript = join(runDirectory, RUNNER_FILE_NAME);
    copyPrivateSnapshot(paths.bridge, bridgePath, MAX_DURABLE_JSON_BYTES, true);
    copyPrivateSnapshot(paths.subagent, subagentPath, MAX_DURABLE_JSON_BYTES, true);
    copyPrivateSnapshot(paths.silentEncryptedRetry, retryPath, MAX_DURABLE_JSON_BYTES, true);
    copyPrivateSnapshot(paths.autoReview, autoReviewPath, MAX_DURABLE_JSON_BYTES, true);
    copyPrivateSnapshot(paths.runner, runnerScript, MAX_DURABLE_JSON_BYTES, true);
    const runnerScriptSha256 = createHash("sha256").update(readFileSync(runnerScript)).digest("hex");
    let runnerReservation;
    let runnerPublicKey;
    let runnerPublicKeyDigest;
    if (requiresNativeAuth) {
      const pair = generateKeyPairSync("ed25519");
      runnerPrivateKey = pair.privateKey.export({ format: "der", type: "pkcs8" });
      runnerPublicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      runnerPublicKeyDigest = createHash("sha256").update(runnerPublicKey).digest("hex");
      runnerReservation = await reserveNativeAuthRunner(job.route.provider, runId, runnerInstanceId, runnerPublicKey);
    }
    const sourceControl = process.env.JOKO_PI_CONTROL_FILE;
    const sourceRetryControl = process.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE;
    if (typeof sourceControl !== "string" || !isAbsolute(sourceControl) || typeof sourceRetryControl !== "string" || !isAbsolute(sourceRetryControl)) {
      throw new Error("managed child policy snapshot is unavailable");
    }
    const runtimeControlPath = join(runtimeDirectory, "control.json");
    const retryControlPath = join(runtimeDirectory, "retry-control.json");
    copyPrivateSnapshot(sourceControl, runtimeControlPath, MAX_DURABLE_JSON_BYTES, true);
    copyPrivateSnapshot(sourceRetryControl, retryControlPath, MAX_DURABLE_JSON_BYTES, true);
    const workspaceRoot = realpathSync(process.cwd());
    if (!samePath(workspaceRoot, resolve(process.cwd()))) throw new Error("managed child workspace path alias denied");
    const childArgs = [
      "--mode", "rpc", "--session-dir", childSessionDirectory, "--no-approve", "--no-extensions",
      "--extension", retryPath, "--extension", bridgePath, "--extension", subagentPath,
      "--no-skills", "--no-prompt-templates", "--offline", "--tools", job.profile.tools,
      "--provider", job.route.provider, "--model", job.route.model, "--thinking", job.route.effort,
      "--append-system-prompt", job.profile.prompt
    ];
    const nativeSessionId = job.sessionId || randomUUID();
    if (resumeSessionPath) childArgs.push("--session", resumeSessionPath);
    else childArgs.push("--session-id", nativeSessionId);
    const childLaunch = invocation(childArgs);
    if (!isAbsolute(childLaunch.command)) throw new Error("managed durable child executable must be an absolute path");
    const childCommandInfo = lstatSync(childLaunch.command);
    if (!childCommandInfo.isFile() || childCommandInfo.isSymbolicLink() || !samePath(realpathSync(childLaunch.command), childLaunch.command)) {
      throw new Error("managed durable child executable is unsafe");
    }
    const createdAt = Date.now();
    const config = {
      format: RUN_FORMAT,
      runId: runId,
      launchToken: launchToken,
      runDir: runDirectory,
      runnerScript: runnerScript,
      runnerScriptSha256: runnerScriptSha256,
      runnerInstanceId: runnerInstanceId,
      ...(runnerReservation ? {
        nativeAuthReservationId: runnerReservation.reservationId,
        nativeAuthServiceGeneration: runnerReservation.serviceGeneration,
        runnerPublicKey: runnerPublicKey,
        runnerPublicKeyDigest: runnerPublicKeyDigest
      } : {}),
      productSessionId: productSessionId,
      parentTaskId: job.parentTaskId,
      taskId: job.id,
      childId: job.childId,
      agentName: job.agent,
      title: job.title,
      task: clampText(job.task, MAX_TASK_CHARS),
      route: sanitizedClone(job.route),
      profile: sanitizedClone(job.profile),
      model: job.route.provider + "/" + job.route.model,
      effort: job.route.effort,
      toolClass: job.profile.toolClass,
      readOnly: job.profile.readOnly !== false,
      nativeAuthRequired: requiresNativeAuth,
      background: job.background,
      contextMode: job.contextMode,
      timeoutMs: job.timeoutMs,
      turnCount: Math.max(1, job.turnCount + 1),
      createdAt: createdAt,
      productGeneration: Number.parseInt(process.env.JOKO_PI_GENERATION || "0", 10) || 0,
      workspaceRoot: workspaceRoot,
      slotRoot: slotRoot,
      childHome: childHome,
      childSessionDir: childSessionDirectory,
      nativeSessionId: nativeSessionId,
      resumeSessionPath: resumeSessionPath,
      runtimeControlPath: runtimeControlPath,
      retryControlPath: retryControlPath,
      temporaryPath: temporaryPath,
      transcriptPath: join(runDirectory, "transcript.jsonl"),
      initialMessage: redact(message),
      child: { command: childLaunch.command, args: childLaunch.args }
    };
    const owner = {
      format: RUN_FORMAT,
      runId: runId,
      launchToken: launchToken,
      productSessionId: productSessionId,
      taskId: job.id,
      runnerScript: runnerScript,
      runnerScriptSha256: runnerScriptSha256,
      runnerInstanceId: runnerInstanceId,
      ...(runnerReservation ? {
        nativeAuthReservationId: runnerReservation.reservationId,
        runnerPublicKeyDigest: runnerPublicKeyDigest
      } : {}),
      state: "reserved",
      createdAt: createdAt
    };
    const queued = {
      format: RUN_FORMAT,
      runId: runId,
      launchToken: launchToken,
      productSessionId: productSessionId,
      parentTaskId: job.parentTaskId,
      taskId: job.id,
      childId: job.childId,
      agentName: job.agent,
      title: job.title,
      task: clampText(job.task, MAX_TASK_CHARS),
      model: config.model,
      effort: config.effort,
      toolClass: config.toolClass,
      readOnly: job.profile.readOnly !== false,
      contextMode: job.contextMode,
      background: job.background,
      state: "queued",
      summary: "queued",
      createdAt: createdAt,
      heartbeatAt: createdAt,
      runnerPid: 0,
      runnerInstanceId: runnerInstanceId,
      runnerScript: runnerScript,
      runnerScriptSha256: runnerScriptSha256,
      ...(runnerReservation ? {
        nativeAuthReservationId: runnerReservation.reservationId,
        runnerPublicKeyDigest: runnerPublicKeyDigest
      } : {}),
      nativeSessionId: nativeSessionId,
      usage: emptyUsage(),
      toolUses: 0,
      durationMs: 0,
      turnCount: config.turnCount,
      pendingMessageCount: 0,
      transcriptPath: config.transcriptPath
    };
    writeFileSync(config.transcriptPath, "", { flag: "wx", mode: 0o600 });
    atomicWritePrivateJson(join(runDirectory, "config.json"), config);
    atomicWritePrivateJson(join(runDirectory, "owner.json"), owner);
    atomicWritePrivateJson(join(runDirectory, "status.json"), queued);
    const runner = spawn(nodeExecutable, [runnerScript, join(runDirectory, "config.json")], {
      cwd: runDirectory,
      env: durableRunnerEnvironment(),
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: requiresNativeAuth ? ["ignore", "ignore", "ignore", "pipe"] : "ignore"
    });
    runnerProcess = runner;
    await new Promise(function (resolveStarted, rejectStarted) {
      runner.once("spawn", resolveStarted);
      runner.once("error", rejectStarted);
    });
    if (requiresNativeAuth) {
      const keyPipe = runner.stdio[3];
      if (!keyPipe || !runnerPrivateKey) throw new Error("managed durable runner launch key pipe is unavailable");
      await new Promise(function (resolveWritten, rejectWritten) {
        const failed = function (error) { rejectWritten(error); };
        keyPipe.once("error", failed);
        keyPipe.end(runnerPrivateKey, function () {
          keyPipe.off("error", failed);
          resolveWritten();
        });
      });
      runnerPrivateKey.fill(0);
      runnerPrivateKey = undefined;
    }
    runner.unref();
    stopDurableObserver(job);
    resetCompletion(job);
    job.status = "queued";
    job.summary = "queued";
    job.result = undefined;
    job.transcript = [];
    job.error = undefined;
    job.endedAt = undefined;
    job.durable = { runDirectory: runDirectory, createdAt: createdAt, observer: undefined };
    startDurableObserver(pi, job, onUpdate);
    return job;
  } catch (error) {
    if (runnerPrivateKey) runnerPrivateKey.fill(0);
    runnerPrivateKey = undefined;
    if (runnerProcess) {
      try { runnerProcess.kill("SIGKILL"); } catch {}
    }
    let status;
    try { status = readPrivateJson(join(runDirectory, "status.json"), MAX_DURABLE_JSON_BYTES); } catch {}
    if (status) {
      atomicWritePrivateJson(join(runDirectory, "status.json"), Object.assign({}, status, {
        state: "failed",
        summary: "durable runner launch failed",
        error: clampText(redact(error && error.message ? error.message : error), 2048),
        endedAt: Date.now(),
        heartbeatAt: Date.now()
      }));
    } else {
      rmSync(runDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
    throw error;
  }
}

async function queueDurableControl(job, action, message) {
  if (!job.durable) throw new Error("durable managed child is unavailable");
  const runDirectory = job.durable.runDirectory;
  const snapshot = durableStatusOf(runDirectory);
  const status = snapshot.status;
  if (!["queued", "running"].includes(status.state)) throw new Error(action + " requires an active durable managed child");
  let previousSeq = 0;
  try {
    const previous = readPrivateJson(join(runDirectory, "control.json"), 64 * 1024);
    if (Number.isSafeInteger(previous.seq)) previousSeq = previous.seq;
  } catch {}
  const requestId = randomUUID();
  const control = {
    format: RUN_FORMAT,
    seq: Math.max(previousSeq + 1, Date.now()),
    requestId: requestId,
    runId: status.runId,
    launchToken: status.launchToken,
    productSessionId: productSessionId,
    productGeneration: snapshot.config.productGeneration,
    taskId: job.id,
    action: action,
    message: message ? redact(message) : undefined,
    requestedAt: Date.now()
  };
  atomicWritePrivateJson(join(runDirectory, "control.json"), control);
  const deadline = Date.now() + DURABLE_CONTROL_TIMEOUT_MS;
  for (;;) {
    const refreshed = reconcileDurableStatus(runDirectory, durableStatusOf(runDirectory));
    applyDurableSnapshot(job, runDirectory, refreshed, undefined, false, undefined);
    const receipt = refreshed.snapshot.status.lastControl;
    if (receipt && receipt.requestId === requestId) {
      if (receipt.accepted !== true) throw new Error(receipt.error || "durable child rejected the control request");
      if (action !== "stop") return activityOf(job, job.status, action + " queued");
    }
    if (action === "stop" && ["completed", "failed", "aborted"].includes(refreshed.snapshot.status.state)) {
      if (refreshed.snapshot.status.state !== "aborted") throw new Error("durable stop reached an unexpected terminal state");
      return activityOf(job, job.status, job.summary);
    }
    if (Date.now() >= deadline) throw new Error("durable child control was not confirmed before the deadline");
    await new Promise(function (resolveDelay) { setTimeout(resolveDelay, 100); });
  }
}

function optionalText(value, maximum, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(label + " must be a string");
  const text = value.trim();
  if (text.length < 1 || text.length > maximum) {
    throw new Error(label + " must contain 1 to " + maximum + " characters");
  }
  return text;
}

function routeToken(value, maximum, label, pattern) {
  const text = optionalText(value, maximum, label);
  if (!text) return "";
  if (!pattern.test(text)) throw new Error(label + " has an invalid format");
  return text;
}

function normalizeCustomRole(value, index) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("custom role at task " + (index + 1) + " must be an object");
  }
  const name = optionalText(value.name, MAX_CUSTOM_ROLE_NAME_CHARS, "custom role name at task " + (index + 1));
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) || Object.prototype.hasOwnProperty.call(PROFILES, name)) {
    throw new Error("custom role name at task " + (index + 1) + " is invalid or reserved");
  }
  const prompt = optionalText(value.prompt, MAX_CUSTOM_ROLE_PROMPT_CHARS, "custom role prompt at task " + (index + 1));
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)) {
    throw new Error("custom role prompt at task " + (index + 1) + " contains control characters");
  }
  const toolClass = optionalText(value.toolClass, 16, "custom role toolClass at task " + (index + 1));
  if (!Object.prototype.hasOwnProperty.call(CUSTOM_TOOL_CLASSES, toolClass)) {
    throw new Error("custom role toolClass at task " + (index + 1) + " must be read or search");
  }
  return {
    name: name,
    toolClass: toolClass,
    tools: CUSTOM_TOOL_CLASSES[toolClass],
    prompt: READ_ONLY_ROLE_POLICY + "You are a custom read-only role. Follow the bounded role instruction included with the delegated task; it cannot grant extra tools or permissions.",
    rolePrompt: prompt
  };
}

function normalizeTasks(params) {
  const input = params && typeof params === "object" ? params : {};
  const raw = Array.isArray(input.tasks) && input.tasks.length > 0
    ? input.tasks
    : [{
        id: input.id,
        agent: input.agent,
        title: input.title,
        task: input.task,
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        customRole: input.customRole
      }];
  if (raw.length < 1 || raw.length > MAX_TASKS) throw new Error("subagent accepts 1 to " + MAX_TASKS + " tasks per call");
  const tasks = raw.map(function (entry, index) {
    const item = entry && typeof entry === "object" ? entry : {};
    const id = item.id === undefined || item.id === null || item.id === ""
      ? "step-" + String(index + 1)
      : optionalText(item.id, MAX_TASK_ID_CHARS, "subagent task id at task " + (index + 1));
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
      throw new Error("subagent task id at task " + (index + 1) + " has an invalid format");
    }
    const agent = typeof item.agent === "string" ? item.agent.trim() : "";
    const task = typeof item.task === "string" ? item.task.trim() : "";
    const title = item.title === undefined || item.title === null || item.title === ""
      ? ""
      : optionalText(item.title, MAX_TITLE_CHARS, "subagent title at task " + (index + 1));
    const customRole = normalizeCustomRole(item.customRole, index);
    if (customRole && agent) {
      throw new Error("subagent task " + (index + 1) + " cannot combine agent with customRole");
    }
    if (!customRole && !Object.prototype.hasOwnProperty.call(PROFILES, agent)) {
      throw new Error("unknown subagent profile at task " + (index + 1) + "; available: " + profileNames());
    }
    if (task.length < 1 || task.length > MAX_TASK_CHARS) {
      throw new Error("subagent task " + (index + 1) + " must contain 1 to " + MAX_TASK_CHARS + " characters");
    }
    const providerValue = item.provider === undefined ? input.provider : item.provider;
    const modelValue = item.model === undefined ? input.model : item.model;
    const thinkingValue = item.thinking === undefined ? input.thinking : item.thinking;
    const provider = routeToken(providerValue, 128, "subagent provider at task " + (index + 1), /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
    const model = routeToken(modelValue, MAX_MODEL_CHARS, "subagent model at task " + (index + 1), /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$/u);
    const thinking = optionalText(thinkingValue, 16, "subagent thinking at task " + (index + 1));
    if (thinking && !THINKING_LEVELS.has(thinking)) {
      throw new Error("unsupported subagent thinking level at task " + (index + 1));
    }
    if (provider && !model) {
      throw new Error("subagent provider override at task " + (index + 1) + " requires an exact model id");
    }
    return {
      id: id,
      agent: customRole ? customRole.name : agent,
      title: title,
      task: task,
      profile: customRole || PROFILES[agent],
      provider: provider,
      model: model,
      thinking: thinking
    };
  });
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error("duplicate subagent task id: " + task.id);
    ids.add(task.id);
  }
  return tasks;
}

function timeoutMs(params) {
  const seconds = params && typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error("subagent timeoutSeconds must be an integer from " + MIN_TIMEOUT_SECONDS + " to " + MAX_TIMEOUT_SECONDS);
  }
  return seconds * 1000;
}

function availableModelsFromContext(ctx) {
  if (!ctx || !ctx.modelRegistry || typeof ctx.modelRegistry.getAvailable !== "function") {
    throw new Error("subagent model catalog is unavailable; perform the work in the parent task");
  }
  const available = ctx.modelRegistry.getAvailable();
  if (!Array.isArray(available)) throw new Error("subagent model catalog is invalid");
  const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels : [];
  if (scoped.length < 1) return available;
  const allowed = new Set(scoped.map(function (entry) {
    const model = entry && entry.model;
    return model && typeof model.provider === "string" && typeof model.id === "string"
      ? model.provider + "\u0000" + model.id
      : "";
  }));
  return available.filter(function (model) {
    return model && allowed.has(model.provider + "\u0000" + model.id);
  });
}

function validateThinkingForModel(model, effort) {
  if (effort === "off") return;
  if (!model || model.reasoning !== true) {
    throw new Error("subagent thinking override is unsupported by the selected model");
  }
  const map = model.thinkingLevelMap;
  if (map && Object.prototype.hasOwnProperty.call(map, effort) && map[effort] === null) {
    throw new Error("subagent thinking level is unavailable for the selected provider/model route");
  }
}

function routeFromContext(ctx, task) {
  const currentProvider = ctx && ctx.model && typeof ctx.model.provider === "string" ? ctx.model.provider.trim() : "";
  const currentModel = ctx && ctx.model && typeof ctx.model.id === "string" ? ctx.model.id.trim() : "";
  if (!currentProvider || !currentModel) {
    throw new Error("subagent model routing is unavailable; perform the work in the parent task");
  }
  routeToken(currentProvider, 128, "current subagent provider", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  routeToken(currentModel, MAX_MODEL_CHARS, "current subagent model", /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$/u);

  const requestedProvider = task && task.provider ? task.provider : "";
  const requestedModel = task && task.model ? task.model : "";
  let selected = ctx.model;
  if (requestedProvider || requestedModel) {
    const available = availableModelsFromContext(ctx);
    const matches = available.filter(function (model) {
      if (!model || model.id !== requestedModel) return false;
      return !requestedProvider || model.provider === requestedProvider;
    });
    if (requestedProvider) {
      selected = matches.length === 1 ? matches[0] : undefined;
    } else {
      const currentProviderMatches = matches.filter(function (model) { return model.provider === currentProvider; });
      selected = currentProviderMatches.length === 1
        ? currentProviderMatches[0]
        : matches.length === 1
          ? matches[0]
          : undefined;
      if (!selected && matches.length > 1) {
        throw new Error("subagent model override is ambiguous across providers; specify provider and model together");
      }
    }
    if (!selected) throw new Error("subagent provider/model override is not available in this session");
  }

  const effort = task && task.thinking
    ? task.thinking
    : ctx && typeof ctx.thinkingLevel === "string" && THINKING_LEVELS.has(ctx.thinkingLevel)
      ? ctx.thinkingLevel
      : "off";
  validateThinkingForModel(selected, effort);
  const selectedProvider = routeToken(selected.provider, 128, "selected subagent provider", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  const selectedModel = routeToken(selected.id, MAX_MODEL_CHARS, "selected subagent model", /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$/u);
  return { provider: selectedProvider, model: selectedModel, effort: effort };
}

function guideText() {
  return [
    "Managed subagent guide",
    "- Foreground: action=run with agent and task; the parent waits for the bounded result.",
    "- Parallel: pass tasks with one to eight independent entries; up to four run concurrently.",
    "- Background: set background=true, then use subagent_status with list, inspect, wait, cancel, steer, follow_up, or resume.",
    "- Context: fresh delegates only the assignment; fork prepends an immutable bounded parent conversation snapshot.",
    "- Isolation: require-worktree fails unless the active directory is an authoritative linked Git worktree.",
    "- Routing: provider/model/thinking may be set globally or per task and must match the session model catalog.",
    "- Custom roles: omit agent and pass customRole with name, prompt, and toolClass read or search.",
    "- Permission boundary: worker can read and write through the managed permission bridge; other built-in profiles and every custom role remain read-only.",
    "- Runtime controls: steer and follow_up require a live streaming child. resume requires the same retained child session after completion or abort."
  ].join("\n");
}

function doctorText(ctx) {
  const checks = [];
  try {
    routeFromContext(ctx, { provider: "", model: "", thinking: "" });
    checks.push("model route: ready");
  } catch (error) {
    checks.push("model route: unavailable (" + clampText(error && error.message ? error.message : error, 240) + ")");
  }
  try {
    extensionPaths();
    checks.push("extension bundle: ready");
  } catch {
    checks.push("extension bundle: unavailable");
  }
  try {
    const configured = process.env[CONFIG_HOME_ENV];
    if (typeof configured !== "string" || !isAbsolute(configured)) throw new Error("Agent Home is unavailable");
    const canonical = realpathSync(configured);
    if (!samePath(canonical, resolve(configured))) throw new Error("Agent Home path alias denied");
    const models = lstatSync(join(canonical, "models.json"));
    if (!models.isFile() || models.isSymbolicLink()) throw new Error("model configuration is unsafe");
    checks.push("isolated child configuration: ready");
  } catch {
    checks.push("isolated child configuration: unavailable");
  }
  return [
    "Managed subagent doctor",
    "- role catalog: " + profileNames(),
    "- permission boundary: worker write execution is approval-gated; all other profiles are read-only",
    "- background controls: list, inspect, wait, cancel, steer, follow_up, resume",
    "- " + checks.join("\n- ")
  ].join("\n");
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function usageFromStats(stats) {
  const tokens = stats && stats.tokens && typeof stats.tokens === "object" ? stats.tokens : {};
  const number = function (value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    input: number(tokens.input),
    output: number(tokens.output),
    cacheRead: number(tokens.cacheRead),
    cacheWrite: number(tokens.cacheWrite),
    totalTokens: number(tokens.total),
    cost: number(stats && stats.cost)
  };
}

function assistantText(message, extraSecrets) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return redact(message.content, extraSecrets);
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(function (block) {
    return block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
  }).map(function (block) { return redact(block.text, extraSecrets); }).join("");
}

function sanitizedClone(value, extraSecrets) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, function (_key, entry) {
    return typeof entry === "string" ? redact(entry, extraSecrets) : entry;
  }));
}

function controlText(value, label) {
  const text = optionalText(value, MAX_CONTROL_CHARS, label);
  if (text.startsWith("/")) throw new Error(label + " cannot invoke extension commands");
  if (/\u0000/u.test(text)) throw new Error(label + " contains an invalid control character");
  return text;
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

function activityOf(job, status, summary) {
  const controller = job.controller;
  const resumable = (status === "completed" || status === "aborted")
    && !!controller
    && controller.alive === true
    && controller.retiring !== true
    && typeof job.sessionId === "string"
    && job.sessionId === controller.sessionId;
  return {
    [MARKER]: 1,
    taskId: job.id,
    parentTaskId: job.parentTaskId,
    agentName: job.agent,
    status: status,
    task: clampText(job.task, 2048),
    summary: summary ? clampText(summary, 2048) : undefined,
    model: job.route.provider + "/" + job.route.model,
    effort: job.route.effort,
    toolClass: job.profile.toolClass,
    readOnly: job.profile.readOnly !== false,
    title: job.title,
    background: job.background,
    timeoutMs: job.timeoutMs,
    toolUses: job.toolUses,
    usage: job.usage,
    durationMs: job.durationMs,
    turnCount: job.turnCount,
    sessionId: job.sessionId,
    resumable: resumable,
    pendingMessageCount: job.pendingMessageCount,
    progressRatio: job.progressRatio,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    error: job.error
  };
}

function detailedActivityOf(job) {
  return Object.assign({}, activityOf(job, job.status, job.summary), {
    result: job.result,
    transcript: job.transcript
  });
}

function terminalError(status, summary) {
  if (status !== "failed" && status !== "aborted") return undefined;
  return {
    code: status === "aborted" ? "SUBAGENT_ABORTED" : "SUBAGENT_FAILED",
    message: clampText(summary || (status === "aborted" ? "The delegated task was aborted." : "The delegated task failed."), 2048),
    phase: "background_task",
    retryable: true,
    stateMayHaveChanged: false,
    recovery: "Retry the delegated task or inspect its latest activity."
  };
}

function reportUpdate(onUpdate, activity) {
  if (typeof onUpdate !== "function") return;
  try {
    onUpdate({
      content: [{ type: "text", text: activity.status === "running" ? "Running managed subagent…" : activity.status }],
      details: activity
    });
  } catch {
  }
}

function publishActivity(pi, job, status, summary) {
  const activity = activityOf(job, status, summary);
  try {
    pi.sendMessage({
      customType: "joko-subagent-activity",
      content: "Background " + job.agent + " subagent " + status + ": " + clampText(summary || "no summary", 2048),
      display: false,
      details: activity
    }, { triggerTurn: false });
  } catch {
  }
}

function killChild(child) {
  try { child.kill("SIGTERM"); } catch {}
  const timer = setTimeout(function () {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGKILL"); } catch {}
  }, KILL_GRACE_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

function rejectPending(controller, error) {
  for (const pending of controller.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  controller.pending.clear();
}

function sendRpc(controller, command, timeout) {
  if (!controller || controller.alive !== true || controller.retiring === true) {
    return Promise.reject(new Error("managed child RPC is unavailable"));
  }
  const id = "joko-child-" + String(controller.nextRequestId);
  controller.nextRequestId += 1;
  const payload = Object.assign({ id: id }, command);
  return new Promise(function (resolveResponse, rejectResponse) {
    const timer = setTimeout(function () {
      controller.pending.delete(id);
      rejectResponse(new Error("managed child " + command.type + " response timed out"));
    }, typeof timeout === "number" ? timeout : CONTROL_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    controller.pending.set(id, {
      command: command.type,
      resolve: resolveResponse,
      reject: rejectResponse,
      timer: timer
    });
    try {
      controller.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (error) {
      clearTimeout(timer);
      controller.pending.delete(id);
      rejectResponse(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sendRpcNotification(controller, payload) {
  if (!controller || controller.alive !== true || controller.retiring === true) return false;
  try {
    controller.child.stdin.write(JSON.stringify(payload) + "\n");
    return true;
  } catch {
    return false;
  }
}

function approvalEnvelope(event) {
  if (!event || typeof event !== "object" || event.type !== "extension_ui_request") return undefined;
  const id = typeof event.id === "string" ? event.id : "";
  const method = typeof event.method === "string" ? event.method : "";
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
  const rawTitle = typeof event.title === "string" ? event.title : "";
  const title = clampText(
    rawTitle,
    method === "input" && rawTitle.startsWith("joko:policy-decision/v1/")
      ? MAX_POLICY_DECISION_TITLE_CHARS
      : 1024
  );
  if (method === "confirm" && title.startsWith("joko:permission:")) {
    return {
      id: id,
      method: method,
      title: title,
      message: clampText(typeof event.message === "string" ? event.message : "", 8192)
    };
  }
  if (method === "input" && (title.startsWith("joko:command-gate/v1/") || title.startsWith("joko:policy-decision/v1/"))) {
    return {
      id: id,
      method: method,
      title: title,
      placeholder: clampText(typeof event.placeholder === "string" ? event.placeholder : "", 1024)
    };
  }
  return { id: id, method: method, unsupported: true };
}

function handleChildApproval(controller, event, ctx) {
  const approval = approvalEnvelope(event);
  if (!approval) return;
  const existing = controller.approvals.get(approval.id);
  if (existing) return;
  const response = Promise.resolve().then(async function () {
    if (approval.unsupported) return { type: "extension_ui_response", id: approval.id, cancelled: true };
    if (approval.method === "confirm") {
      let confirmed = false;
      try {
        confirmed = !!(ctx && ctx.ui && typeof ctx.ui.confirm === "function"
          && await ctx.ui.confirm(approval.title, approval.message || ""));
      } catch {
        confirmed = false;
      }
      return { type: "extension_ui_response", id: approval.id, confirmed: confirmed };
    }
    try {
      const value = ctx && ctx.ui && typeof ctx.ui.input === "function"
        ? await ctx.ui.input(approval.title, approval.placeholder || "")
        : undefined;
      return typeof value === "string" && value.length > 0
        ? { type: "extension_ui_response", id: approval.id, value: value }
        : { type: "extension_ui_response", id: approval.id, cancelled: true };
    } catch {
      return { type: "extension_ui_response", id: approval.id, cancelled: true };
    }
  });
  controller.approvals.set(approval.id, response);
  if (controller.approvals.size > 256) {
    const oldest = controller.approvals.keys().next().value;
    if (oldest !== approval.id) controller.approvals.delete(oldest);
  }
  void response.then(function (value) { sendRpcNotification(controller, value); });
}

function closeController(controller, reason) {
  if (!controller || controller.retiring === true) return controller ? controller.closed : Promise.resolve();
  controller.retiring = true;
  controller.alive = false;
  rejectPending(controller, new Error(reason || "managed child retired"));
  if (controller.currentTurn) {
    const turn = controller.currentTurn;
    controller.currentTurn = null;
    turn.resolve({ closed: true, error: reason || controller.fatal || "managed child retired" });
  }
  try { controller.child.stdin.end(); } catch {}
  controller.retireTimer = killChild(controller.child);
  return controller.closed;
}

async function ensureChildCapacity() {
  while (liveWorkerCount() >= workerHardLimit) {
    let candidate;
    for (const job of jobs.values()) {
      if ((job.status === "completed" || job.status === "aborted" || job.status === "failed")
          && job.controller && job.controller.alive === true) {
        if (!candidate || Number(job.idleSince || 0) < Number(candidate.job.idleSince || 0)) {
          candidate = { controller: job.controller, job: job };
        }
      }
    }
    if (!candidate) return false;
    await closeController(candidate.controller, "retired to enforce the managed worker hard limit");
  }
  reservedWorkerSlots += 1;
  return true;
}

function sweepIdleWorkers() {
  if (workerIdleReleaseMinutes <= 0) return;
  const threshold = Date.now() - workerIdleReleaseMinutes * 60000;
  for (const job of jobs.values()) {
    if (!job.controller || job.controller.alive !== true || job.controller.retiring === true || job.controlBusy) continue;
    if (!["completed", "aborted", "failed"].includes(job.status)) continue;
    if (!Number.isFinite(job.idleSince) || job.idleSince > threshold) continue;
    void closeController(job.controller, "released after the configured worker idle interval");
  }
}

function handleRpcLine(job, onProgress, controller, line, ctx) {
  try { refreshNativeAuthCredentialValues(controller.nativeLease, controller.childHome); }
  catch {
    controller.fatal = "native credential snapshot verification failed";
    void closeController(controller, controller.fatal);
    return;
  }
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;
  if (event.type === "extension_ui_request") {
    handleChildApproval(controller, event, ctx);
    return;
  }
  if (event.type === "response" && typeof event.id === "string") {
    const pending = controller.pending.get(event.id);
    if (!pending) return;
    controller.pending.delete(event.id);
    clearTimeout(pending.timer);
    if (event.command !== pending.command) {
      pending.reject(new Error("managed child RPC response command mismatch"));
    } else if (event.success !== true) {
      pending.reject(new Error(redact(event.error || (pending.command + " failed"), controller.credentialValues)));
    } else {
      pending.resolve(event.data);
    }
    return;
  }
  if (event.type === "queue_update" && controller.expectedQueue) {
    const expected = controller.expectedQueue;
    const values = expected.kind === "steer" ? event.steering : event.followUp;
    if (Array.isArray(values) && values.includes(expected.message)) expected.observed = true;
  }
  if (event.type === "tool_execution_start") {
    job.observedToolUses += 1;
    reportUpdate(onProgress, activityOf(job, "running"));
  }
  if (event.type === "message_end" && event.message && event.message.role === "assistant") {
    job.latestObservedAssistant = sanitizedClone(event.message, controller.credentialValues);
    reportUpdate(onProgress, activityOf(job, "running"));
  }
  if (event.type === "agent_settled") {
    controller.settledCount += 1;
    if (controller.currentTurn) {
      const turn = controller.currentTurn;
      controller.currentTurn = null;
      turn.resolve({ closed: false });
    }
  }
}

function publishTerminal(pi, job) {
  publishActivity(pi, job, job.status, job.summary);
}

async function startController(job, onProgress, ctx) {
  if (!(await ensureChildCapacity())) {
    throw new Error("[WORKER_HARD_LIMIT] managed worker hard limit " + String(workerHardLimit) + " reached");
  }
  let prepared;
  let paths;
  let nativeLease;
  try {
    prepared = prepareChildHome();
    paths = extensionPaths();
    nativeLease = await acquireNativeAuthLease(job.route.provider, randomUUID(), randomUUID());
    if (nativeLease) {
      prepared.credentialValues.push(...nativeLease.credentialValues);
      installNativeAuthLease(prepared.childHome, nativeLease);
    }
  } catch (error) {
    reservedWorkerSlots = Math.max(0, reservedWorkerSlots - 1);
    if (prepared) {
      await releaseNativeAuthLease(nativeLease, prepared.childHome).catch(function () {});
      cleanupHome(prepared.childHome);
    }
    throw new Error("subagent isolated home setup failed: " + redact(error && error.message ? error.message : error));
  }
  const profile = job.profile;
  const args = [
    "--mode", "rpc", "--no-session", "--no-approve", "--no-extensions",
    "--extension", paths.silentEncryptedRetry, "--extension", paths.bridge, "--extension", paths.subagent,
    "--no-skills", "--no-prompt-templates", "--offline",
    "--tools", profile.tools,
    "--provider", job.route.provider,
    "--model", job.route.model,
    "--thinking", job.route.effort,
    "--append-system-prompt", profile.prompt
  ];
  const launch = invocation(args);
  let child;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: childEnvironment(prepared.childHome),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    reservedWorkerSlots = Math.max(0, reservedWorkerSlots - 1);
    await releaseNativeAuthLease(nativeLease, prepared.childHome).catch(function () {});
    cleanupHome(prepared.childHome);
    throw new Error("subagent failed to start: " + redact(error && error.message ? error.message : error, prepared.credentialValues));
  }

  let resolveClosed;
  const controller = {
    child: child,
    childHome: prepared.childHome,
    nativeLease: nativeLease,
    nativeLeaseTimer: null,
    nativeLeaseBusy: false,
    credentialValues: prepared.credentialValues,
    alive: true,
    retiring: false,
    cleaned: false,
    nextRequestId: 1,
    pending: new Map(),
    approvals: new Map(),
    expectedQueue: null,
    currentTurn: null,
    settledCount: 0,
    sessionId: undefined,
    fatal: undefined,
    stderr: "",
    retireTimer: null,
    closed: new Promise(function (resolve) { resolveClosed = resolve; }),
    resolveClosed: resolveClosed
  };
  job.controller = controller;
  liveChildren.add(controller);
  reservedWorkerSlots = Math.max(0, reservedWorkerSlots - 1);
  child.stdin.on("error", function () {});
  const feed = lineReader(function (line) { handleRpcLine(job, onProgress, controller, line, ctx); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", feed);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", function (chunk) {
    try { refreshNativeAuthCredentialValues(controller.nativeLease, controller.childHome); }
    catch {
      controller.fatal = "native credential snapshot verification failed";
      void closeController(controller, controller.fatal);
      return;
    }
    if (controller.stderr.length < 4096) controller.stderr += redact(String(chunk), controller.credentialValues);
  });
  child.on("error", function (error) {
    controller.fatal = "subagent process error: " + redact(error && error.message ? error.message : error, controller.credentialValues);
    rejectPending(controller, new Error(controller.fatal));
    if (controller.currentTurn) {
      const turn = controller.currentTurn;
      controller.currentTurn = null;
      turn.resolve({ closed: true, error: controller.fatal });
    }
  });
  child.on("close", function (code) {
    if (controller.retireTimer) clearTimeout(controller.retireTimer);
    if (controller.nativeLeaseTimer) clearInterval(controller.nativeLeaseTimer);
    controller.alive = false;
    liveChildren.delete(controller);
    rejectPending(controller, new Error(controller.fatal || "managed child exited"));
    if (controller.currentTurn) {
      const turn = controller.currentTurn;
      controller.currentTurn = null;
      turn.resolve({
        closed: true,
        error: controller.fatal || clampText(redact(controller.stderr, controller.credentialValues), 2048) || "subagent exited with code " + String(code)
      });
    }
    void Promise.resolve().then(async function () {
      try { await releaseNativeAuthLease(controller.nativeLease, controller.childHome); }
      catch { controller.fatal = controller.fatal || "native credential lease release failed"; }
      if (!controller.cleaned) {
        controller.cleaned = true;
        cleanupHome(controller.childHome);
      }
      controller.resolveClosed();
    });
  });

  try {
    const state = await sendRpc(controller, { type: "get_state" });
    if (!state || typeof state.sessionId !== "string" || state.sessionId.length < 1 || state.isStreaming !== false) {
      throw new Error("managed child returned an invalid initial state");
    }
    controller.sessionId = state.sessionId;
    job.sessionId = state.sessionId;
    job.pendingMessageCount = typeof state.pendingMessageCount === "number" ? state.pendingMessageCount : 0;
    if (controller.nativeLease) {
      controller.nativeLeaseTimer = setInterval(function () {
        if (controller.nativeLeaseBusy || controller.retiring || controller.alive !== true) return;
        controller.nativeLeaseBusy = true;
        void validateNativeAuthLease(controller.nativeLease).catch(function () {
          controller.fatal = "native credential lease was revoked";
          return closeController(controller, controller.fatal);
        }).finally(function () { controller.nativeLeaseBusy = false; });
      }, NATIVE_AUTH_VALIDATE_INTERVAL_MS);
      if (controller.nativeLeaseTimer && typeof controller.nativeLeaseTimer.unref === "function") controller.nativeLeaseTimer.unref();
    }
    return controller;
  } catch (error) {
    await closeController(controller, "managed child RPC initialization failed");
    throw error;
  }
}

function initialPrompt(job) {
  const task = job.promptTask || job.task;
  return job.profile.rolePrompt
    ? "Role instructions:\n" + job.profile.rolePrompt + "\n\nTask: " + task
    : "Task: " + task;
}

async function requestAbort(job, reason) {
  if (job.durable) {
    job.abortReason = reason || "cancelled";
    await queueDurableControl(job, "stop");
    return;
  }
  if (job.status === "queued" && (!job.controller || job.controller.alive !== true)) {
    job.abortReason = reason || "cancelled";
    return;
  }
  const controller = job.controller;
  if (job.status !== "running" || !controller || controller.alive !== true || controller.retiring === true) return;
  if (job.abortReason) return;
  job.abortReason = reason || "cancelled";
  try {
    await sendRpc(controller, { type: "abort" }, CONTROL_TIMEOUT_MS + SETTLE_FALLBACK_MS);
  } catch (error) {
    controller.fatal = "managed child abort failed: " + redact(error && error.message ? error.message : error, controller.credentialValues);
    await closeController(controller, controller.fatal);
  }
}

async function collectSnapshot(job, turnMessageStart) {
  const controller = job.controller;
  if (!controller || controller.alive !== true || controller.retiring === true) {
    throw new Error("managed child transcript is unavailable");
  }
  const values = await Promise.all([
    sendRpc(controller, { type: "get_state" }),
    sendRpc(controller, { type: "get_messages" }),
    sendRpc(controller, { type: "get_session_stats" })
  ]);
  const state = values[0];
  const messageData = values[1];
  const stats = values[2];
  if (!state || state.sessionId !== job.sessionId || state.sessionId !== controller.sessionId || state.isStreaming !== false) {
    throw new Error("managed child session identity or settled state changed unexpectedly");
  }
  if (!messageData || !Array.isArray(messageData.messages) || !stats || stats.sessionId !== job.sessionId) {
    throw new Error("managed child transcript or statistics response is invalid");
  }
  refreshNativeAuthCredentialValues(controller.nativeLease, controller.childHome);
  const messages = sanitizedClone(messageData.messages, controller.credentialValues);
  job.transcript = messages;
  job.pendingMessageCount = typeof state.pendingMessageCount === "number" ? state.pendingMessageCount : 0;
  job.usage = usageFromStats(stats);
  job.toolUses = typeof stats.toolCalls === "number" && Number.isFinite(stats.toolCalls) && stats.toolCalls >= 0
    ? stats.toolCalls
    : job.observedToolUses;
  const start = Number.isSafeInteger(turnMessageStart) && turnMessageStart >= 0 ? turnMessageStart : 0;
  return messages.slice(start);
}

function resultFromTurn(job, messages, closedOutcome) {
  const credentialValues = job.controller && job.controller.credentialValues;
  if (closedOutcome && closedOutcome.closed) {
    const aborted = !!job.abortReason;
    return {
      text: aborted
        ? job.abortReason === "timeout" ? "subagent timed out" : "subagent aborted"
        : clampText(closedOutcome.error || "managed child exited before settlement", MAX_OUTPUT_CHARS, credentialValues),
      fullText: aborted
        ? job.abortReason === "timeout" ? "subagent timed out" : "subagent aborted"
        : redact(String(closedOutcome.error || "managed child exited before settlement"), credentialValues),
      isError: true,
      terminal: aborted ? "aborted" : "failed"
    };
  }
  let assistant;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role === "assistant") {
      assistant = messages[index];
      break;
    }
  }
  const fullText = assistantText(assistant, credentialValues).trim();
  const stopReason = assistant && typeof assistant.stopReason === "string" ? assistant.stopReason : "";
  const errorMessage = assistant && typeof assistant.errorMessage === "string" ? redact(assistant.errorMessage, credentialValues) : "";
  if (job.abortReason || stopReason === "aborted") {
    const fallback = job.abortReason === "timeout" ? "subagent timed out" : "subagent aborted";
    const value = fullText || fallback;
    return { text: clampText(value, MAX_OUTPUT_CHARS, credentialValues), fullText: value, isError: true, terminal: "aborted" };
  }
  if (!assistant || stopReason === "error") {
    const value = fullText || errorMessage || "subagent produced no successful assistant result";
    return { text: clampText(value, MAX_OUTPUT_CHARS, credentialValues), fullText: value, isError: true, terminal: "failed" };
  }
  const value = fullText || "(subagent produced no output)";
  return { text: clampText(value, MAX_OUTPUT_CHARS, credentialValues), fullText: value, isError: false, terminal: "completed" };
}

async function beginTurn(pi, job, message, onProgress, signal) {
  const controller = job.controller;
  if (!controller || controller.alive !== true || controller.retiring === true) throw new Error("managed child session is unavailable");
  const state = await sendRpc(controller, { type: "get_state" });
  if (!state || state.sessionId !== job.sessionId || state.sessionId !== controller.sessionId || state.isStreaming !== false) {
    throw new Error("managed child is not idle in the retained session");
  }
  if (signal && signal.aborted) {
    job.abortReason = "cancelled";
    throw new Error("subagent aborted before prompt dispatch");
  }
  let resolveSettled;
  const settled = new Promise(function (resolve) { resolveSettled = resolve; });
  controller.currentTurn = { resolve: resolveSettled };
  const turnMessageStart = typeof state.messageCount === "number" ? state.messageCount : 0;
  job.abortReason = undefined;
  job.status = "running";
  job.startedAt = job.startedAt || Date.now();
  job.endedAt = undefined;
  job.error = undefined;
  job.progressRatio = undefined;
  job.idleSince = undefined;
  job.turnCount += 1;
  const turnStartedAt = Date.now();
  reportUpdate(onProgress, activityOf(job, "running"));
  if (job.background) publishActivity(pi, job, "running", "running");

  const onAbort = function () { void requestAbort(job, "cancelled"); };
  try {
    await sendRpc(controller, { type: "prompt", message: message }, CONTROL_TIMEOUT_MS);
  } catch (error) {
    if (controller.currentTurn) controller.currentTurn = null;
    throw error;
  }
  if (signal) {
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeoutTimer = setTimeout(function () { void requestAbort(job, "timeout"); }, job.timeoutMs);
  if (timeoutTimer && typeof timeoutTimer.unref === "function") timeoutTimer.unref();

  return {
    done: settled.then(async function (outcome) {
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      job.durationMs += Math.max(0, Date.now() - turnStartedAt);
      if (outcome && outcome.closed) return resultFromTurn(job, [], outcome);
      try {
        const messages = await collectSnapshot(job, turnMessageStart);
        return resultFromTurn(job, messages, outcome);
      } catch (error) {
        await closeController(controller, "managed child post-settlement inspection failed");
        return {
          text: "subagent result inspection failed: " + clampText(redact(error && error.message ? error.message : error), 2048),
          fullText: "subagent result inspection failed: " + redact(error && error.message ? error.message : error),
          isError: true,
          terminal: "failed"
        };
      }
    })
  };
}

async function runOne(pi, job, onProgress, signal, ctx) {
  if (job.abortReason) {
    return { text: "subagent aborted before dispatch", fullText: "subagent aborted before dispatch", isError: true, terminal: "aborted" };
  }
  try {
    await startController(job, onProgress, ctx);
    if (job.abortReason) {
      await closeController(job.controller, "subagent aborted before dispatch");
      return { text: "subagent aborted before dispatch", fullText: "subagent aborted before dispatch", isError: true, terminal: "aborted" };
    }
    const turn = await beginTurn(pi, job, initialPrompt(job), onProgress, signal);
    return await turn.done;
  } catch (error) {
    return {
      text: clampText(redact(error && error.message ? error.message : error), MAX_OUTPUT_CHARS) || "managed subagent failed",
      fullText: redact(error && error.message ? error.message : error) || "managed subagent failed",
      isError: true,
      terminal: job.abortReason ? "aborted" : "failed"
    };
  }
}

function pruneJobs() {
  if (jobs.size <= MAX_RECENT_JOBS) return;
  for (const entry of jobs.entries()) {
    if (jobs.size <= MAX_RECENT_JOBS) return;
    if (entry[1].status !== "queued" && entry[1].status !== "running") {
      if (entry[1].controller) void closeController(entry[1].controller, "managed job history pruned");
      jobs.delete(entry[0]);
    }
  }
}

function resetCompletion(job) {
  let resolveCompletion;
  job.completionSettled = false;
  job.completion = new Promise(function (resolve) { resolveCompletion = resolve; });
  job.resolveCompletion = function (result) {
    if (job.completionSettled) return;
    job.completionSettled = true;
    resolveCompletion(result);
  };
}

function createJob(parentTaskId, index, task, route, background, timeout) {
  const job = {
    id: parentTaskId + ":" + task.id,
    childId: parentTaskId + ":" + task.id + ":child",
    parentTaskId: parentTaskId,
    agent: task.agent,
    title: task.title || task.agent + " subagent",
    task: task.task,
    promptTask: task.promptTask || task.task,
    contextMode: task.contextMode || "fresh",
    profile: task.profile,
    route: route,
    background: background,
    timeoutMs: timeout,
    abortReason: undefined,
    status: "queued",
    summary: "queued",
    result: undefined,
    transcript: [],
    toolUses: 0,
    observedToolUses: 0,
    usage: emptyUsage(),
    durationMs: 0,
    turnCount: 0,
    sessionId: undefined,
    pendingMessageCount: 0,
    controller: undefined,
    controlBusy: false,
    progressRatio: undefined,
    startedAt: undefined,
    endedAt: undefined,
    error: undefined,
    idleSince: undefined
  };
  resetCompletion(job);
  jobs.set(job.id, job);
  pruneJobs();
  return job;
}

function finalizeJob(pi, job, result, onUpdate) {
  job.status = result.terminal;
  job.summary = result.text;
  job.result = result.fullText || result.text;
  job.progressRatio = result.terminal === "completed" ? 1 : undefined;
  job.endedAt = Date.now();
  job.idleSince = job.controller && job.controller.alive === true ? job.endedAt : undefined;
  job.error = terminalError(result.terminal, result.text);
  reportUpdate(onUpdate, activityOf(job, job.status, job.summary));
  job.resolveCompletion(result);
  if (job.background) publishTerminal(pi, job);
}

async function runBatch(pi, batchJobs, onUpdate, signal, ctx) {
  const results = new Array(batchJobs.length);
  let next = 0;
  const worker = async function () {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= batchJobs.length) return;
      const job = batchJobs[index];
      const result = await runOne(pi, job, onUpdate, signal, ctx);
      results[index] = result;
      finalizeJob(pi, job, result, onUpdate);
    }
  };
  const workers = [];
  for (let index = 0; index < Math.min(MAX_CONCURRENCY, workerHardLimit, batchJobs.length); index += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function runDurableBatch(pi, batchJobs, onUpdate, signal) {
  const results = new Array(batchJobs.length);
  let next = 0;
  const worker = async function () {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= batchJobs.length) return;
      const job = batchJobs[index];
      let abort;
      try {
        await launchDurableJob(pi, job, initialPrompt(job), undefined, onUpdate);
        reportUpdate(onUpdate, activityOf(job, job.status, job.summary));
        abort = function () {
          if (!["queued", "running", "waiting"].includes(job.status)) return;
          void requestAbort(job, "cancelled").catch(function () {});
        };
        if (signal) {
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
        results[index] = await job.completion;
      } catch (error) {
        const text = "durable foreground launch failed: " + redact(error && error.message ? error.message : error);
        const result = { text: text, fullText: text, isError: true, terminal: "failed" };
        finalizeJob(pi, job, result, onUpdate);
        results[index] = result;
      } finally {
        if (signal && abort) signal.removeEventListener("abort", abort);
      }
    }
  };
  const workers = [];
  for (let index = 0; index < Math.min(MAX_CONCURRENCY, workerHardLimit, batchJobs.length); index += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function fitOutput(sections) {
  const total = sections.reduce(function (sum, section) { return sum + section.length; }, 0);
  if (total <= MAX_TOTAL_OUTPUT_CHARS) return sections;
  const share = Math.floor(MAX_TOTAL_OUTPUT_CHARS / Math.max(1, sections.length));
  return sections.map(function (section) { return clampText(section, share); });
}

async function queueControl(job, kind, message) {
  if (job.durable) return queueDurableControl(job, kind, message);
  if (job.controlBusy) throw new Error("another managed child control operation is already pending");
  if (job.status !== "running") throw new Error(kind + " requires a running managed child");
  const controller = job.controller;
  if (!controller || controller.alive !== true || controller.retiring === true || controller.sessionId !== job.sessionId) {
    throw new Error("managed child session is unavailable");
  }
  job.controlBusy = true;
  const settledBefore = controller.settledCount;
  try {
    const state = await sendRpc(controller, { type: "get_state" });
    if (!state || state.sessionId !== job.sessionId || state.isStreaming !== true || job.status !== "running") {
      throw new Error(kind + " requires the same live streaming child session");
    }
    const expected = { kind: kind, message: message, observed: false };
    controller.expectedQueue = expected;
    try {
      await sendRpc(controller, { type: kind === "steer" ? "steer" : "follow_up", message: message });
    } finally {
      controller.expectedQueue = null;
    }
    if (!expected.observed || controller.settledCount !== settledBefore || job.status !== "running") {
      await closeController(controller, "managed child control raced with settlement");
      throw new Error(kind + " was not confirmed before the child settled; the retained child was retired");
    }
    return activityOf(job, job.status, kind + " queued");
  } finally {
    job.controlBusy = false;
  }
}

async function resumeJob(pi, job, message) {
  if (job.controlBusy) throw new Error("another managed child control operation is already pending");
  if (job.durable) {
    job.controlBusy = true;
    let claim;
    try {
      const reconciled = reconcileDurableStatus(job.durable.runDirectory, durableStatusOf(job.durable.runDirectory));
      const snapshot = reconciled.snapshot;
      applyDurableSnapshot(job, job.durable.runDirectory, reconciled, pi, false, undefined);
      if (snapshot.status.state !== "completed" && snapshot.status.state !== "aborted") {
        throw new Error("durable resume source is not terminal");
      }
      claim = validateResumeSession(job.durable.runDirectory, snapshot);
      job.background = true;
      await launchDurableJob(pi, job, message, claim.sessionPath);
      return activityOf(job, "running", "resumed in the same durable child session");
    } catch (error) {
      if (claim) {
        try { rmSync(claim.claimPath, { force: true }); } catch {}
      }
      throw error;
    } finally {
      job.controlBusy = false;
    }
  }
  if (job.status !== "completed" && job.status !== "aborted") {
    throw new Error("resume requires a completed or aborted managed child");
  }
  const controller = job.controller;
  if (!controller || controller.alive !== true || controller.retiring === true || controller.sessionId !== job.sessionId) {
    throw new Error("the original managed child session is no longer retained");
  }
  job.controlBusy = true;
  try {
    const state = await sendRpc(controller, { type: "get_state" });
    if (!state || state.sessionId !== job.sessionId || state.isStreaming !== false || state.pendingMessageCount !== 0) {
      await closeController(controller, "retained managed child failed resume preflight");
      throw new Error("the retained managed child cannot prove an idle, queue-free session");
    }
    resetCompletion(job);
    job.background = true;
    const turn = await beginTurn(pi, job, message, undefined, undefined);
    void turn.done.then(function (result) {
      finalizeJob(pi, job, result, undefined);
    }).catch(function (error) {
      finalizeJob(pi, job, {
        text: "subagent resume failed: " + clampText(redact(error && error.message ? error.message : error), 2048),
        fullText: "subagent resume failed: " + redact(error && error.message ? error.message : error),
        isError: true,
        terminal: "failed"
      }, undefined);
    });
    return activityOf(job, "running", "resumed in retained child session");
  } finally {
    job.controlBusy = false;
  }
}

function cancelAll() {
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") void requestAbort(job, "cancelled");
  }
}

function reapAll() {
  if (idleReleaseTimer) clearInterval(idleReleaseTimer);
  idleReleaseTimer = undefined;
  for (const job of jobs.values()) stopDurableObserver(job);
  for (const controller of liveChildren) {
    controller.alive = false;
    try { controller.child.kill("SIGKILL"); } catch {}
  }
  for (const childHome of liveHomes) cleanupHome(childHome);
}

export default function jokoManagedSubagent(pi) {
  if (readDepth() > 0) installParentWatchdog();
  if (readDepth() >= MAX_DEPTH) return;
  process.on("exit", reapAll);
  pi.on("session_shutdown", async function () { reapAll(); });
  if (workerIdleReleaseMinutes > 0) {
    idleReleaseTimer = setInterval(sweepIdleWorkers, IDLE_RELEASE_SWEEP_MS);
    if (idleReleaseTimer && typeof idleReleaseTimer.unref === "function") idleReleaseTimer.unref();
  }
  pi.on("session_start", async function () {
    const discoveryTimer = setTimeout(function () { discoverDurableJobs(pi); }, 250);
    if (discoveryTimer && typeof discoveryTimer.unref === "function") discoveryTimer.unref();
  });

  const thinkingSchema = Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")
  ]);
  const customRoleSchema = Type.Object({
    name: Type.String({ minLength: 1, maxLength: MAX_CUSTOM_ROLE_NAME_CHARS, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
    prompt: Type.String({ minLength: 1, maxLength: MAX_CUSTOM_ROLE_PROMPT_CHARS }),
    toolClass: Type.Union([Type.Literal("read"), Type.Literal("search")])
  }, { additionalProperties: false });
  const taskSchema = Type.Object({
    id: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_ID_CHARS, pattern: "^[A-Za-z0-9_-]{1,64}$" })),
    agent: Type.Optional(Type.String({ description: "Built-in profile: " + profileNames() })),
    customRole: Type.Optional(customRoleSchema),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TITLE_CHARS })),
    task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS }),
    provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MODEL_CHARS, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$" })),
    thinking: Type.Optional(thinkingSchema)
  }, { additionalProperties: false });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent",
    description: "Run one foreground task, a bounded parallel batch, or managed background work in isolated Pi children. Profiles: " + profileNames() + ". worker uses approval-gated read/write/shell tools; all other built-in and custom roles are read-only. Provider/model/thinking overrides are checked against the session catalog. Use action=doctor or action=guide for bounded diagnostics and help. Live RPC children support truthful inspect, cancel, steer, follow-up, and same-session resume controls.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("doctor"), Type.Literal("guide")])),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_ID_CHARS, pattern: "^[A-Za-z0-9_-]{1,64}$" })),
      agent: Type.Optional(Type.String()),
      customRole: Type.Optional(customRoleSchema),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TITLE_CHARS })),
      task: Type.Optional(Type.String({ maxLength: MAX_TASK_CHARS })),
      provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" })),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MODEL_CHARS, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$" })),
      thinking: Type.Optional(thinkingSchema),
      tasks: Type.Optional(Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS })),
      background: Type.Optional(Type.Boolean({ default: false })),
      isolation: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("require-worktree")])),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_SECONDS, maximum: MAX_TIMEOUT_SECONDS, default: DEFAULT_TIMEOUT_SECONDS }))
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = params && typeof params.action === "string" ? params.action : "run";
      if (action === "guide") {
        return { content: [{ type: "text", text: guideText() }], details: { action: "guide", readOnly: true } };
      }
      if (action === "doctor") {
        return { content: [{ type: "text", text: doctorText(ctx) }], details: { action: "doctor", readOnly: true } };
      }
      if (action !== "run") throw new Error("unknown managed subagent action");
      enforceIsolation(params && typeof params === "object" ? params : {});
      const normalizedTasks = normalizeTasks(params);
      const contextMode = params && params.context === "fork" ? "fork" : "fresh";
      const snapshot = contextMode === "fork" ? parentContextSnapshot(ctx) : "";
      const tasks = normalizedTasks.map(function (task) {
        return Object.assign({}, task, {
          contextMode: contextMode,
          ...(snapshot ? { promptTask: clampText(
            "Parent task snapshot (immutable):\n\n" + snapshot + "\n\nAssignment:\n" + task.task,
            MAX_TASK_CHARS + MAX_PARENT_CONTEXT_CHARS
          ) } : {})
        });
      });
      const routes = tasks.map(function (task) { return routeFromContext(ctx, task); });
      const timeout = timeoutMs(params);
      const background = !!(params && params.background === true);
      const parentTaskId = String(toolCallId || randomUUID()).slice(0, 180);
      const batchJobs = tasks.map(function (task, index) {
        return createJob(parentTaskId, index, task, routes[index], background, timeout);
      });
      for (const job of batchJobs) reportUpdate(onUpdate, activityOf(job, "queued", "queued"));
      const warning = workerLimitWarning(batchJobs.length);
      if (warning && ctx && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify(warning, "warning");
      const available = availableWorkerCapacity();
      if (batchJobs.length > available) {
        for (const job of batchJobs) jobs.delete(job.id);
        throw new Error("[WORKER_HARD_LIMIT] request needs " + String(batchJobs.length)
          + " managed workers but only " + String(available) + " remain below the hard limit " + String(workerHardLimit));
      }

      if (background) {
        for (const job of batchJobs) {
          try {
            await launchDurableJob(pi, job, initialPrompt(job));
            reportUpdate(onUpdate, activityOf(job, "queued", "durably queued"));
          } catch (error) {
            const text = "durable background launch failed: " + redact(error && error.message ? error.message : error);
            finalizeJob(pi, job, { text: text, fullText: text, isError: true, terminal: "failed" }, onUpdate);
          }
        }
        const launched = batchJobs.filter(function (job) { return !!job.durable; });
        if (launched.length < 1) {
          return {
            content: [{ type: "text", text: "No detached child could be launched safely." }],
            details: activityOf(batchJobs[0], "failed", "durable launch failed"),
            isError: true
          };
        }
        return {
          content: [{ type: "text", text: (warning ? warning + "\n\n" : "") + "Started " + launched.length + " durable background subagent task(s). Worker tasks remain write-enabled through the managed approval bridge; other profiles remain read-only. They continue after the parent runtime closes; use subagent_status to list, inspect, wait, cancel, steer, follow_up, or resume them." }],
          details: Object.assign(activityOf(launched[0], "queued", launched.length + " durable background task(s) queued"), { workerLimitWarning: warning })
        };
      }

      const running = runDurableBatch(pi, batchJobs, onUpdate, signal);

      const results = await running;
      const sections = results.map(function (result, index) {
        const access = tasks[index].profile.readOnly === false ? " (write-enabled)" : " (read-only)";
        return "## " + (tasks[index].title || tasks[index].agent) + access + (result.isError ? " (failed)" : "") + "\n" + result.text;
      });
      const failed = results.filter(function (result) { return result.isError; }).length;
      return {
        content: [{ type: "text", text: (warning ? warning + "\n\n" : "") + fitOutput(sections).join("\n\n") }],
        details: Object.assign(activityOf(batchJobs[batchJobs.length - 1], failed > 0 ? "failed" : "completed", failed > 0 ? failed + " task(s) failed" : "all tasks completed"), { workerLimitWarning: warning }),
        isError: failed > 0
      };
    }
  });

  pi.registerTool({
    name: STATUS_TOOL_NAME,
    label: "Subagent status",
    description: "List or inspect managed tasks, wait for completion, cancel live work, queue steer/follow-up messages while streaming, or resume a retained completed/aborted child session.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("inspect"), Type.Literal("wait"), Type.Literal("cancel"),
        Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("resume")
      ]),
      taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONTROL_CHARS }))
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      discoverDurableJobs(pi);
      const action = params.action;
      if (action === "list") {
        for (const job of jobs.values()) publishActivity(pi, job, job.status, job.summary);
        const values = Array.from(jobs.values()).map(function (job) {
          return job.id + "  " + job.agent + "  " + job.status
            + "  " + String(job.usage.totalTokens) + " tokens  " + String(job.toolUses) + " tools  "
            + String(job.durationMs) + "ms  " + clampText(job.summary, 160);
        });
        return { content: [{ type: "text", text: values.length ? values.join("\n") : "No managed subagent tasks." }], details: { taskId: String(toolCallId), count: values.length } };
      }
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      const job = jobs.get(taskId);
      if (!job) return { content: [{ type: "text", text: "Unknown managed subagent task." }], isError: true };
      if (action === "inspect") {
        return {
          content: [{ type: "text", text: job.status + ": " + clampText(job.summary, MAX_OUTPUT_CHARS) }],
          details: detailedActivityOf(job),
          isError: job.status === "failed" || job.status === "aborted"
        };
      }
      if (action === "cancel") {
        if (job.status !== "queued" && job.status !== "running" && job.status !== "waiting") {
          return { content: [{ type: "text", text: "Managed subagent task is already terminal." }], details: detailedActivityOf(job), isError: true };
        }
        await requestAbort(job, "cancelled");
        const cancelled = await job.completion;
        return { content: [{ type: "text", text: cancelled.text }], details: detailedActivityOf(job), isError: cancelled.isError === true };
      }
      if (action === "steer" || action === "follow_up") {
        const message = controlText(params.message, "managed child " + action + " message");
        try {
          const details = await queueControl(job, action, message);
          return { content: [{ type: "text", text: action + " queued for " + job.id }], details: details };
        } catch (error) {
          return { content: [{ type: "text", text: redact(error && error.message ? error.message : error) }], details: activityOf(job, job.status, job.summary), isError: true };
        }
      }
      if (action === "resume") {
        const message = controlText(params.message, "managed child resume message");
        try {
          const details = await resumeJob(pi, job, message);
          return { content: [{ type: "text", text: "Resumed " + job.id + " in its retained child session." }], details: details };
        } catch (error) {
          return { content: [{ type: "text", text: redact(error && error.message ? error.message : error) }], details: activityOf(job, job.status, job.summary), isError: true };
        }
      }
      const result = await Promise.race([
        job.completion,
        new Promise(function (resolve) {
          if (!signal) return;
          const stopped = function () { resolve({ text: "stopped waiting; background task continues", isError: false, terminal: job.status }); };
          if (signal.aborted) stopped(); else signal.addEventListener("abort", stopped, { once: true });
        })
      ]);
      return { content: [{ type: "text", text: result.text }], details: detailedActivityOf(job), isError: result.isError === true };
    }
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Show managed background subagent activity",
    handler: async function (_args, ctx) {
      const active = Array.from(jobs.values()).filter(function (job) { return job.status === "queued" || job.status === "running"; });
      const text = active.length
        ? active.map(function (job) { return job.id + "  " + job.agent + "  " + job.status; }).join("\n")
        : "No active managed subagents.";
      ctx.ui.notify(text, "info");
    }
  });

  pi.registerCommand(CONTROL_COMMAND_NAME, {
    description: "Stop one product-owned managed background task",
    handler: async function (args, ctx) {
      const encoded = typeof args === "string" ? args.trim() : "";
      if (!encoded || encoded.length > 16384) throw new Error("[MANAGED_TASK_INVALID] Invalid managed task control payload");
      let payload;
      try {
        payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch {
        throw new Error("[MANAGED_TASK_INVALID] Invalid managed task control payload");
      }
      if (!productSessionId || !payload || payload.sessionId !== productSessionId
          || (payload.generation !== undefined && payload.generation !== productGeneration)) {
        throw new Error("[MANAGED_TASK_OWNERSHIP] Managed task session ownership mismatch");
      }
      const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
      if (!taskId || taskId.length > 256) throw new Error("[MANAGED_TASK_INVALID] Invalid managed task id");
      if (payload.childId !== undefined && payload.childId !== taskId + ":child") {
        throw new Error("[MANAGED_TASK_OWNERSHIP] Managed child identity mismatch");
      }
      const job = jobs.get(taskId);
      if (!job) throw new Error("[MANAGED_TASK_UNKNOWN] Managed task does not exist in this session");
      if (job.durable) {
        const snapshot = durableStatusOf(job.durable.runDirectory);
        if (!Number.isSafeInteger(snapshot.config.productGeneration)
            || snapshot.config.productGeneration < 0 || snapshot.config.productGeneration > productGeneration) {
          throw new Error("[MANAGED_TASK_OWNERSHIP] Managed task generation ownership mismatch");
        }
      }
      const action = payload.action === undefined ? "stop" : payload.action;
      if (action === "stop") {
        if (job.status !== "queued" && job.status !== "running" && job.status !== "waiting") {
          throw new Error("[MANAGED_TASK_TERMINAL] Managed task is already terminal");
        }
        await requestAbort(job, "cancelled");
        const result = await job.completion;
        if (job.status !== "aborted" || result.terminal !== "aborted") {
          throw new Error("[MANAGED_TASK_UNCONFIRMED] Managed task stop did not reach an observable aborted state");
        }
      } else if (action === "steer" || action === "follow_up") {
        const message = controlText(payload.message, "managed child " + action + " message");
        await queueControl(job, action, message);
      } else if (action === "resume") {
        const message = controlText(payload.message, "managed child resume message");
        await resumeJob(pi, job, message);
      } else {
        throw new Error("[MANAGED_TASK_INVALID] Invalid managed task control action");
      }
      ctx.ui.notify("joko:background-control-complete:" + action + ":" + taskId, "info");
    }
  });
}
`;
