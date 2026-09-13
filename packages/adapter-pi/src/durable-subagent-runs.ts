import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { piError } from "./errors.js";

const RUN_FORMAT = 1;
const MAX_STATUS_BYTES = 512 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const RUNNER_HEARTBEAT_STALE_MS = 10_000;
const PRIVATE_FILE_READ_ATTEMPTS = 8;
const PRIVATE_FILE_READ_RETRY_MS = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_KEY_PATTERN = /^[0-9a-f]{40}$/u;
const TERMINAL_STATES = new Set(["completed", "failed", "aborted"]);

interface DurableRunStatus {
  readonly format: number;
  readonly runId: string;
  readonly launchToken: string;
  readonly productSessionId: string;
  readonly taskId: string;
  readonly state: string;
  readonly runnerPid: number;
  readonly runnerInstanceId: string;
  readonly runnerScript: string;
  readonly runnerScriptSha256: string;
  readonly heartbeatAt?: number;
}

interface ValidatedDurableRun {
  readonly directory: string;
  readonly status: DurableRunStatus;
  readonly claimPid?: number;
  readonly hasRunnerClaim: boolean;
}

export interface ManagedSubagentRecoveryRunInput {
  readonly productSessionId: string;
  readonly runnerProductGeneration: number;
  readonly providerId: string;
  readonly runId: string;
  readonly runnerPid: number;
  readonly runnerInstanceId: string;
  readonly trustedRunnerScriptSha256: string;
  readonly trustedNodeExecutable: string;
  readonly inspectRunnerProcess: (pid: number) => Promise<ManagedSubagentRunnerProcessInspection | undefined>;
  /** Trusted digest from a service-side one-shot launch reservation. */
  readonly runnerPublicKeyDigest?: string;
  /** Exact reservation identifier copied into every durable ownership manifest. */
  readonly runnerReservationId?: string;
  /** The launch key is primary authority; retain exact artifacts without an OS process API. */
  readonly skipProcessInspection?: boolean;
  /** Journal validation only; never authorizes restoration of a dead runner. */
  readonly allowTerminalTransitionSource?: boolean;
}

export interface ManagedSubagentRunnerProcessInspection {
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly processIdentity: string;
}

export interface ManagedSubagentRecoveryRun {
  readonly directory: string;
  readonly runnerPid: number;
  readonly runnerInstanceId: string;
  readonly runnerScriptSha256: string;
  readonly processIdentity: string;
}

export const MANAGED_SUBAGENT_RUN_ROOT_ENV = "JOKO_PI_SUBAGENT_RUN_ROOT";
export const MANAGED_SUBAGENT_NODE_ENV = "JOKO_PI_SUBAGENT_NODE_EXECUTABLE";

export function managedSubagentRunRoot(sessionRoot: string): string {
  if (!isAbsolute(sessionRoot) || resolve(sessionRoot) !== sessionRoot) {
    throw piError("PI_SUBAGENT_ROOT_INVALID", "Managed background run storage requires a normalized absolute Pi Session Root", "provision");
  }
  return join(sessionRoot, "subagent-runs");
}

export function managedSubagentSessionKey(productSessionId: string): string {
  return createHash("sha256").update(productSessionId).digest("hex").slice(0, 40);
}

/**
 * Resolves one live managed runner from the service-owned durable root. Every
 * path component and manifest is joined from the fixed root; request data can
 * select only an exact hashed Session and UUID Run beneath it.
 */
export async function validateManagedSubagentRecoveryRun(
  root: string,
  input: ManagedSubagentRecoveryRunInput
): Promise<ManagedSubagentRecoveryRun> {
  const normalizedRoot = resolve(root);
  if (!isAbsolute(root) || normalizedRoot !== root || input.productSessionId.trim() === ""
      || !Number.isSafeInteger(input.runnerProductGeneration) || input.runnerProductGeneration < 0
      || !UUID_PATTERN.test(input.runId) || !UUID_PATTERN.test(input.runnerInstanceId)
      || !Number.isSafeInteger(input.runnerPid) || input.runnerPid < 1
      || !/^[0-9a-f]{64}$/u.test(input.trustedRunnerScriptSha256)
      || (input.runnerPublicKeyDigest !== undefined && !/^[0-9a-f]{64}$/u.test(input.runnerPublicKeyDigest))
      || (input.runnerReservationId !== undefined && !UUID_PATTERN.test(input.runnerReservationId))
      || (input.runnerPublicKeyDigest === undefined) !== (input.runnerReservationId === undefined)
      || !isAbsolute(input.trustedNodeExecutable) || resolve(input.trustedNodeExecutable) !== input.trustedNodeExecutable
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.providerId)) {
    throw piError("PI_SUBAGENT_RECOVERY_FENCE_INVALID", "Managed background recovery fence is invalid", "provision");
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw piError("PI_SUBAGENT_ROOT_UNSAFE", "Managed background run storage is not a canonical private directory", "provision");
  }
  const sessionDirectory = join(root, managedSubagentSessionKey(input.productSessionId));
  const directory = join(sessionDirectory, input.runId);
  assertContained(root, sessionDirectory);
  assertContained(sessionDirectory, directory);
  for (const candidate of [sessionDirectory, directory]) {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(candidate), candidate)) {
      throw piError("PI_SUBAGENT_RUN_DIRECTORY_UNSAFE", "Managed background recovery path is aliased or unavailable", "provision");
    }
  }

  const [statusValue, configValue, ownerValue, claimValue] = await Promise.all([
    readBoundedJson(join(directory, "status.json")),
    readBoundedJson(join(directory, "config.json")),
    readBoundedJson(join(directory, "owner.json")),
    readBoundedJson(join(directory, "runner.claim.json"))
  ]);
  if (!isDurableRunStatus(statusValue, input.runId, input.productSessionId)) {
    throw piError("PI_SUBAGENT_STATUS_INVALID", "Managed background recovery status failed exact ownership validation", "provision");
  }
  const status = statusValue;
  const statusRecord = statusValue as unknown as Record<string, unknown>;
  const runnerScript = join(directory, "joko-managed-subagent-runner.cjs");
  if (!isRunManifest(configValue, status, runnerScript) || !isRunOwnerManifest(ownerValue, status, runnerScript)
      || (input.allowTerminalTransitionSource === true
        ? status.state !== "running" && !TERMINAL_STATES.has(status.state)
        : status.state !== "running")
      || status.runnerPid !== input.runnerPid
      || status.runnerInstanceId !== input.runnerInstanceId
      || status.runnerScriptSha256 !== input.trustedRunnerScriptSha256
      || !isRunnerClaim(claimValue, status, input.trustedRunnerScriptSha256, ownerValue)) {
    throw piError("PI_SUBAGENT_RUNNER_IDENTITY_INVALID", "Managed background recovery runner fence failed exact validation", "provision");
  }
  const config = configValue as Record<string, unknown>;
  const owner = ownerValue as Record<string, unknown>;
  const claim = claimValue as Record<string, unknown>;
  const route = config["route"];
  if (config["runDir"] !== directory || config["productGeneration"] !== input.runnerProductGeneration
      || config["nativeAuthRequired"] !== true || route === null || typeof route !== "object" || Array.isArray(route)
      || (route as Record<string, unknown>)["provider"] !== input.providerId
      || (input.runnerPublicKeyDigest !== undefined
        && (config["runnerPublicKeyDigest"] !== input.runnerPublicKeyDigest
          || statusRecord["runnerPublicKeyDigest"] !== input.runnerPublicKeyDigest
          || owner["runnerPublicKeyDigest"] !== input.runnerPublicKeyDigest
          || claim["runnerPublicKeyDigest"] !== input.runnerPublicKeyDigest
          || config["nativeAuthReservationId"] !== input.runnerReservationId
          || statusRecord["nativeAuthReservationId"] !== input.runnerReservationId
          || owner["nativeAuthReservationId"] !== input.runnerReservationId
          || claim["nativeAuthReservationId"] !== input.runnerReservationId))) {
    throw piError("PI_SUBAGENT_RECOVERY_LINEAGE_INVALID", "Managed background recovery lineage is stale or mismatched", "provision");
  }
  const runnerBytes = await readBoundedPrivateFile(runnerScript, MAX_STATUS_BYTES, () =>
    piError("PI_SUBAGENT_RUNNER_IDENTITY_INVALID", "Managed background recovery runner content is unavailable", "provision"));
  const runnerScriptSha256 = createHash("sha256").update(runnerBytes).digest("hex");
  if (runnerScriptSha256 !== input.trustedRunnerScriptSha256) {
    throw piError("PI_SUBAGENT_RUNNER_IDENTITY_INVALID", "Managed background recovery runner content changed", "provision");
  }
  const trustedNodeExecutable = await realpath(input.trustedNodeExecutable);
  if (!samePath(trustedNodeExecutable, input.trustedNodeExecutable)) {
    throw piError("PI_SUBAGENT_RUNNER_PROCESS_INVALID", "Managed background recovery Node executable is aliased", "provision");
  }
  if (input.skipProcessInspection === true) {
    if (input.runnerPublicKeyDigest === undefined) {
      throw piError("PI_SUBAGENT_RUNNER_PROCESS_INVALID", "Managed background recovery launch key is unavailable", "provision");
    }
    return {
      directory,
      runnerPid: input.runnerPid,
      runnerInstanceId: input.runnerInstanceId,
      runnerScriptSha256,
      processIdentity: input.runnerPublicKeyDigest
    };
  }
  const inspection = await input.inspectRunnerProcess(input.runnerPid);
  const configPath = join(directory, "config.json");
  if (inspection === undefined || !isAbsolute(inspection.executablePath)
      || !samePath(inspection.executablePath, trustedNodeExecutable)
      || inspection.argv.length !== 3 || !samePath(resolve(inspection.argv[0] ?? ""), trustedNodeExecutable)
      || !samePath(resolve(inspection.argv[1] ?? ""), runnerScript)
      || !samePath(resolve(inspection.argv[2] ?? ""), configPath)
      || !/^[0-9a-f]{64}$/u.test(inspection.processIdentity)) {
    throw piError("PI_SUBAGENT_RUNNER_PROCESS_INVALID", "Managed background recovery runner process command is stale or mismatched", "provision");
  }
  return {
    directory,
    runnerPid: input.runnerPid,
    runnerInstanceId: input.runnerInstanceId,
    runnerScriptSha256,
    processIdentity: inspection.processIdentity
  };
}

/**
 * Startup recovery for detached-run credential homes. A home is removed only
 * after its durable status, owner manifest, runner content hash, and process
 * claim have all validated and no claimed runner process is alive.
 */
export async function reconcileManagedSubagentAuthHomes(root: string): Promise<number> {
  const normalizedRoot = resolve(root);
  if (!isAbsolute(root) || normalizedRoot !== root) {
    throw piError("PI_SUBAGENT_RECOVERY_SCOPE_INVALID", "Managed background recovery scope is invalid", "provision");
  }
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootInfo === undefined) return 0;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw piError("PI_SUBAGENT_ROOT_UNSAFE", "Managed background run storage is not a canonical private directory", "provision");
  }
  await validateManagedSubagentAuthRoot(root);
  let removed = 0;
  const sessions = await readdir(root, { withFileTypes: true });
  for (const entry of sessions) {
    if (!SESSION_KEY_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw piError("PI_SUBAGENT_SESSION_ROOT_UNSAFE", "Managed background session storage is not a canonical private directory", "provision");
    }
    const sessionDirectory = join(root, entry.name);
    assertContained(root, sessionDirectory);
    if (!samePath(await realpath(sessionDirectory), sessionDirectory)) {
      throw piError("PI_SUBAGENT_SESSION_ROOT_UNSAFE", "Managed background session storage is not a canonical private directory", "provision");
    }
    const productSessionId = await discoverProductSessionId(sessionDirectory, entry.name);
    if (productSessionId === undefined) continue;
    const runs = await reconcileDeadRunOwners(await readRunStatuses(sessionDirectory, productSessionId));
    for (const run of runs) {
      if (!TERMINAL_STATES.has(run.status.state) || !run.hasRunnerClaim || ownedRunnerIsAlive(run)) continue;
      if (await removeManagedSubagentAuthRun(root, entry.name, run.status.runId)) removed += 1;
    }
  }
  return removed;
}

/**
 * Explicit parent deletion lifecycle. It never signals a PID read from disk:
 * the independently running owner consumes the authenticated stop mailbox and
 * terminates only the child process handle it created.
 */
export async function stopAndRemoveManagedSubagentRuns(
  root: string,
  productSessionId: string,
  timeoutMs: number
): Promise<void> {
  const normalizedRoot = resolve(root);
  if (!isAbsolute(root) || normalizedRoot !== root || productSessionId.trim() === "") {
    throw piError("PI_SUBAGENT_DELETE_SCOPE_INVALID", "Managed background deletion scope is invalid", "session");
  }
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootInfo === undefined) {
    await removeManagedSubagentAuthSession(root, productSessionId);
    return;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw piError("PI_SUBAGENT_ROOT_UNSAFE", "Managed background run storage is not a canonical private directory", "session");
  }
  const sessionDirectory = join(root, managedSubagentSessionKey(productSessionId));
  assertContained(root, sessionDirectory);
  const sessionInfo = await lstat(sessionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (sessionInfo === undefined) {
    await removeManagedSubagentAuthSession(root, productSessionId);
    return;
  }
  if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink() || !samePath(await realpath(sessionDirectory), sessionDirectory)) {
    throw piError("PI_SUBAGENT_SESSION_ROOT_UNSAFE", "Managed background session storage is not a canonical private directory", "session");
  }

  const runs = await reconcileDeadRunOwners(await readRunStatuses(sessionDirectory, productSessionId));
  const active = runs.filter((entry) => !TERMINAL_STATES.has(entry.status.state));
  const requestedAt = Date.now();
  await Promise.all(active.map(async ({ directory, status }, index) => {
    const control = {
      format: RUN_FORMAT,
      seq: requestedAt * 1000 + index,
      requestId: randomUUID(),
      runId: status.runId,
      launchToken: status.launchToken,
      productSessionId,
      taskId: status.taskId,
      action: "stop",
      requestedAt
    };
    await atomicWriteJson(join(directory, "control.json"), control);
  }));

  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  for (;;) {
    const remaining = await reconcileDeadRunOwners(await readRunStatuses(sessionDirectory, productSessionId));
    const nonterminal = remaining.filter((entry) => !TERMINAL_STATES.has(entry.status.state));
    const ownersStillExiting = remaining.filter((entry) =>
      TERMINAL_STATES.has(entry.status.state) && ownedRunnerIsAlive(entry));
    if (nonterminal.length === 0 && ownersStillExiting.length === 0) break;
    if (Date.now() >= deadline) {
      throw piError(
        "PI_SUBAGENT_DELETE_STOP_UNCONFIRMED",
        "Parent deletion could not confirm that every owned background child stopped",
        "session",
        {
          retryable: true,
          recovery: "Keep the parent Session intact, inspect the managed runner health, and retry deletion. No disk PID was signalled."
        }
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  const canonicalSessionDirectory = await realpath(sessionDirectory);
  assertContained(root, canonicalSessionDirectory);
  if (!samePath(canonicalSessionDirectory, sessionDirectory)) {
    throw piError("PI_SUBAGENT_SESSION_ROOT_ALIAS_DENIED", "Managed background session storage contains a path alias", "session");
  }
  await rm(canonicalSessionDirectory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  await removeManagedSubagentAuthSession(root, productSessionId);
}

async function removeManagedSubagentAuthSession(runRoot: string, productSessionId: string): Promise<void> {
  const authRoot = join(resolve(runRoot, ".."), "subagent-native-auth");
  const authSessionDirectory = join(authRoot, managedSubagentSessionKey(productSessionId));
  assertContained(authRoot, authSessionDirectory);
  const info = await lstat(authSessionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(authSessionDirectory), authSessionDirectory)) {
    throw piError("PI_SUBAGENT_AUTH_ROOT_UNSAFE", "Managed native auth runtime storage is unsafe", "session");
  }
  await rm(authSessionDirectory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  await rmdir(authRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
  });
}

async function validateManagedSubagentAuthRoot(runRoot: string): Promise<void> {
  const authRoot = join(resolve(runRoot, ".."), "subagent-native-auth");
  const info = await lstat(authRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(authRoot), authRoot)) {
    throw piError("PI_SUBAGENT_AUTH_ROOT_UNSAFE", "Managed native auth runtime storage is unsafe", "provision");
  }
}

async function discoverProductSessionId(sessionDirectory: string, expectedSessionKey: string): Promise<string | undefined> {
  const entries = await readdir(sessionDirectory, { withFileTypes: true });
  const firstRun = entries.find((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID_PATTERN.test(entry.name));
  if (firstRun === undefined) return undefined;
  const runDirectory = join(sessionDirectory, firstRun.name);
  assertContained(sessionDirectory, runDirectory);
  const runInfo = await lstat(runDirectory);
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || !samePath(await realpath(runDirectory), runDirectory)) {
    throw piError("PI_SUBAGENT_RUN_DIRECTORY_UNSAFE", "Managed background run storage contains a path alias", "provision");
  }
  const status = await readBoundedJson(join(runDirectory, "status.json"));
  const productSessionId = status !== null && typeof status === "object" && !Array.isArray(status)
    ? (status as Record<string, unknown>)["productSessionId"]
    : undefined;
  if (typeof productSessionId !== "string" || productSessionId.trim() === ""
      || managedSubagentSessionKey(productSessionId) !== expectedSessionKey) {
    throw piError("PI_SUBAGENT_SESSION_IDENTITY_INVALID", "Managed background Session identity failed its storage fence", "provision");
  }
  return productSessionId;
}

async function removeManagedSubagentAuthRun(
  runRoot: string,
  sessionKey: string,
  runId: string
): Promise<boolean> {
  if (!SESSION_KEY_PATTERN.test(sessionKey) || !UUID_PATTERN.test(runId)) {
    throw piError("PI_SUBAGENT_AUTH_SCOPE_INVALID", "Managed native auth cleanup scope is invalid", "provision");
  }
  const authRoot = join(resolve(runRoot, ".."), "subagent-native-auth");
  const authSessionDirectory = join(authRoot, sessionKey);
  const authRunDirectory = join(authSessionDirectory, runId);
  assertContained(authRoot, authSessionDirectory);
  assertContained(authSessionDirectory, authRunDirectory);
  const rootInfo = await lstat(authRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootInfo === undefined) return false;
  const sessionInfo = await lstat(authSessionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (sessionInfo === undefined) return false;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(authRoot), authRoot)
      || !sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()
      || !samePath(await realpath(authSessionDirectory), authSessionDirectory)) {
    throw piError("PI_SUBAGENT_AUTH_ROOT_UNSAFE", "Managed native auth runtime storage is unsafe", "provision");
  }
  const runInfo = await lstat(authRunDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (runInfo === undefined) return false;
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink()
      || !samePath(await realpath(authRunDirectory), authRunDirectory)) {
    throw piError("PI_SUBAGENT_AUTH_ROOT_UNSAFE", "Managed native auth runtime storage is unsafe", "provision");
  }
  await rm(authRunDirectory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  await rmdir(authSessionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
  });
  await rmdir(authRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
  });
  return true;
}

async function readRunStatuses(
  sessionDirectory: string,
  productSessionId: string
): Promise<readonly ValidatedDurableRun[]> {
  const entries = await readdir(sessionDirectory, { withFileTypes: true });
  const values: ValidatedDurableRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_PATTERN.test(entry.name)) continue;
    const directory = join(sessionDirectory, entry.name);
    assertContained(sessionDirectory, directory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
      throw piError("PI_SUBAGENT_RUN_DIRECTORY_UNSAFE", "Managed background run storage contains a path alias", "session");
    }
    const status = await readBoundedJson(join(directory, "status.json"));
    if (!isDurableRunStatus(status, entry.name, productSessionId)) {
      throw piError("PI_SUBAGENT_STATUS_INVALID", "Managed background status failed ownership validation", "session", {
        recovery: "Quarantine the corrupt private run directory before retrying parent deletion."
      });
    }
    const config = await readBoundedJson(join(directory, "config.json"));
    const owner = await readBoundedJson(join(directory, "owner.json"));
    const claim = await readBoundedJson(join(directory, "runner.claim.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const runnerScript = join(directory, "joko-managed-subagent-runner.cjs");
    if (!isRunManifest(config, status, runnerScript) || !isRunOwnerManifest(owner, status, runnerScript)) {
      throw piError("PI_SUBAGENT_OWNER_INVALID", "Managed background owner manifest failed exact run validation", "session", {
        recovery: "Quarantine the corrupt private run directory before retrying parent deletion."
      });
    }
    const runnerBytes = await readBoundedPrivateFile(runnerScript, MAX_STATUS_BYTES, () =>
      piError("PI_SUBAGENT_RUNNER_IDENTITY_INVALID", "Managed background runner identity is unavailable", "session"));
    const runnerScriptSha256 = createHash("sha256").update(runnerBytes).digest("hex");
    if (status.runnerScriptSha256 !== runnerScriptSha256
        || !isRunnerClaim(claim, status, runnerScriptSha256, owner)) {
      throw piError("PI_SUBAGENT_RUNNER_IDENTITY_INVALID", "Managed background runner identity failed its content or process claim", "session");
    }
    values.push({
      directory,
      status,
      hasRunnerClaim: claim !== undefined,
      ...((claim !== null && typeof claim === "object" && !Array.isArray(claim)
        && Number.isSafeInteger((claim as Record<string, unknown>)["runnerPid"]))
        ? { claimPid: Number((claim as Record<string, unknown>)["runnerPid"]) }
        : {})
    });
  }
  return values;
}

async function reconcileDeadRunOwners(
  runs: readonly ValidatedDurableRun[]
): Promise<readonly ValidatedDurableRun[]> {
  return Promise.all(runs.map(async (entry) => {
    if (TERMINAL_STATES.has(entry.status.state)) {
      if (entry.hasRunnerClaim) return entry;
      return await claimAbandonedLaunch(entry)
        ? { ...entry, claimPid: 0, hasRunnerClaim: true }
        : entry;
    }
    const heartbeatAt = Number.isSafeInteger(entry.status.heartbeatAt) ? Number(entry.status.heartbeatAt) : 0;
    if (Date.now() - heartbeatAt <= RUNNER_HEARTBEAT_STALE_MS || ownedRunnerIsAlive(entry)) return entry;
    let claimedEntry = entry;
    if (!entry.hasRunnerClaim) {
      const claimed = await claimAbandonedLaunch(entry);
      if (!claimed) return entry;
      claimedEntry = { ...entry, claimPid: 0, hasRunnerClaim: true };
    }
    const failed: DurableRunStatus = {
      ...claimedEntry.status,
      state: "failed",
      heartbeatAt: Date.now()
    };
    await atomicWriteJson(join(claimedEntry.directory, "status.json"), failed, MAX_STATUS_BYTES);
    return { ...claimedEntry, status: failed };
  }));
}

async function claimAbandonedLaunch(entry: ValidatedDurableRun): Promise<boolean> {
  if (entry.status.runnerPid !== 0 || entry.hasRunnerClaim) return false;
  const claimPath = join(entry.directory, "runner.claim.json");
  const claim = {
    format: RUN_FORMAT,
    runId: entry.status.runId,
    launchToken: entry.status.launchToken,
    runnerPid: 0,
    runnerInstanceId: `orphan-gc-${entry.status.runId}`,
    runnerScriptSha256: entry.status.runnerScriptSha256,
    claimedAt: Date.now()
  };
  try {
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(claimPath, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function ownedRunnerIsAlive(entry: ValidatedDurableRun): boolean {
  const observedPid = entry.status.runnerPid > 0 ? entry.status.runnerPid : entry.claimPid;
  return processIsAlive(observedPid ?? 0);
}

async function readBoundedJson(path: string): Promise<unknown> {
  const bytes = await readBoundedPrivateFile(path, MAX_STATUS_BYTES, () =>
    piError("PI_SUBAGENT_STATUS_UNSAFE", "Managed background status is linked, oversized, or unavailable", "session"));
  return JSON.parse(bytes.toString("utf8"));
}

async function readBoundedPrivateFile(path: string, maximum: number, unsafe: () => Error): Promise<Buffer> {
  const flags = FS_CONSTANTS.O_RDONLY | (process.platform === "win32" ? 0 : FS_CONSTANTS.O_NOFOLLOW);
  for (let attempt = 0; attempt < PRIVATE_FILE_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await waitForPrivateFileReplacement();
    // Preserve ENOENT for optional private files such as runner.claim.json;
    // callers use that exact absence to distinguish an unclaimed launch.
    const before = await lstat(path);
    if (!privateFileStatIsSafe(before, maximum)) throw unsafe();
    const handle = await open(path, flags).catch(() => undefined);
    if (handle === undefined) continue;
    try {
      const opened = await handle.stat().catch(() => undefined);
      const current = await lstat(path).catch(() => undefined);
      const canonical = await realpath(path).catch(() => undefined);
      if (opened === undefined || current === undefined || canonical === undefined) continue;
      if (!privateFileStatIsSafe(current, maximum) || !samePath(canonical, path)) throw unsafe();
      // The detached owner publishes heartbeats and sanitizes its launch manifest
      // through atomic replacement. If replacement unlinks the already-open
      // inode, retry the new canonical file while still failing closed on links,
      // aliases, or an unstable final identity.
      if (!privateFileStatIsSafe(opened, maximum) || !sameOpenedFile(current, opened)) continue;
      const bytes = await handle.readFile().catch(() => undefined);
      const after = await handle.stat().catch(() => undefined);
      const finalCurrent = await lstat(path).catch(() => undefined);
      const finalCanonical = await realpath(path).catch(() => undefined);
      if (bytes === undefined || after === undefined || finalCurrent === undefined || finalCanonical === undefined) continue;
      if (!privateFileStatIsSafe(finalCurrent, maximum) || !samePath(finalCanonical, path)) throw unsafe();
      if (!sameOpenedFile(opened, after) || !sameOpenedFile(finalCurrent, after)) continue;
      if (bytes.byteLength !== opened.size || bytes.byteLength > maximum) throw unsafe();
      return bytes;
    } finally {
      await handle.close();
    }
  }
  throw unsafe();
}

async function waitForPrivateFileReplacement(): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, PRIVATE_FILE_READ_RETRY_MS));
}

function privateFileStatIsSafe(value: import("node:fs").Stats, maximum: number): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && value.size <= maximum;
}

function sameOpenedFile(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.nlink === 1 && right.nlink === 1 && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isDurableRunStatus(value: unknown, runId: string, productSessionId: string): value is DurableRunStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["format"] === RUN_FORMAT
    && record["runId"] === runId
    && UUID_PATTERN.test(String(record["launchToken"] ?? ""))
    && record["productSessionId"] === productSessionId
    && typeof record["taskId"] === "string"
    && typeof record["state"] === "string"
    && Number.isSafeInteger(record["runnerPid"])
    && (record["heartbeatAt"] === undefined || Number.isSafeInteger(record["heartbeatAt"])
      && Number(record["heartbeatAt"]) >= 0)
    && typeof record["runnerInstanceId"] === "string"
    && typeof record["runnerScript"] === "string"
    && /^[0-9a-f]{64}$/iu.test(String(record["runnerScriptSha256"] ?? ""));
}

function isRunManifest(value: unknown, status: DurableRunStatus, runnerScript: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["format"] === RUN_FORMAT
    && record["runId"] === status.runId
    && record["launchToken"] === status.launchToken
    && record["productSessionId"] === status.productSessionId
    && record["taskId"] === status.taskId
    && record["runnerScript"] === runnerScript
    && record["runnerScriptSha256"] === status.runnerScriptSha256;
}

function isRunnerClaim(
  value: unknown,
  status: DurableRunStatus,
  runnerScriptSha256: string,
  owner: unknown
): boolean {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) return false;
  const ownerRecord = owner as Record<string, unknown>;
  if (ownerRecord["state"] === "reserved" && status.runnerPid === 0) return value === undefined || (
    value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>)["runId"] === status.runId
    && (value as Record<string, unknown>)["launchToken"] === status.launchToken
    && (value as Record<string, unknown>)["runnerScriptSha256"] === runnerScriptSha256
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expectedPid = status.runnerPid > 0 ? status.runnerPid : ownerRecord["runnerPid"];
  const expectedInstanceId = status.runnerPid > 0 ? status.runnerInstanceId : ownerRecord["runnerInstanceId"];
  return record["format"] === RUN_FORMAT && record["runId"] === status.runId
    && record["launchToken"] === status.launchToken && record["runnerScriptSha256"] === runnerScriptSha256
    && record["runnerPid"] === expectedPid && record["runnerInstanceId"] === expectedInstanceId;
}

function isRunOwnerManifest(value: unknown, status: DurableRunStatus, runnerScript: string): boolean {
  if (!isRunManifest(value, status, runnerScript)) return false;
  const record = value as Record<string, unknown>;
  if (record["state"] === "reserved") return status.runnerPid === 0;
  return record["state"] === "running"
    && (status.runnerPid === 0 || (
      record["runnerPid"] === status.runnerPid
      && record["runnerInstanceId"] === status.runnerInstanceId
    ));
}

async function atomicWriteJson(path: string, value: unknown, maximumBytes = MAX_CONTROL_BYTES): Promise<void> {
  const parent = resolve(path, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parent);
  if (!samePath(canonicalParent, parent)) {
    throw piError("PI_SUBAGENT_CONTROL_PARENT_ALIAS_DENIED", "Managed background control parent contains a path alias", "session");
  }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) {
    throw piError("PI_SUBAGENT_CONTROL_TOO_LARGE", "Managed background control exceeds its private mailbox bound", "session");
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  const suffix = relative(root, candidate);
  if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) return;
  throw piError("PI_SUBAGENT_PATH_ESCAPE", "Managed background run path escaped its service-owned root", "session");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
