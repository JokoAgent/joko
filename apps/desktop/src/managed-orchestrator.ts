import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  DESKTOP_BOOTSTRAP_MAX_TTL_MS,
  DesktopBootstrapFrameDecoder,
  createDesktopBootstrapCommit,
  createDesktopBootstrapRequest,
  decodeDesktopBootstrapCommittedPayload,
  decodeDesktopBootstrapResponsePayload,
  encodeDesktopBootstrapCommitFrame,
  encodeDesktopBootstrapRequestFrame,
  verifyDesktopBootstrapCommitted,
  verifyDesktopBootstrapResponse,
  type DesktopBootstrapCommit,
  type DesktopBootstrapCommitted,
  type DesktopBootstrapRequest,
  type DesktopBootstrapResponse
} from "@joko/contracts/desktop-bootstrap";
import {
  MANAGED_OUTBOUND_PROXY_ENVIRONMENT_KEYS,
  MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV,
  MANAGED_OUTBOUND_PROXY_TARGETS,
  decodeManagedOutboundProxySnapshot,
  encodeManagedOutboundProxySnapshot,
  hasManagedOutboundProxyEnvironment,
  type ManagedOutboundProxyVerdict
} from "@joko/contracts/managed-outbound-proxy";

import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./secure-files.js";

export const MANAGED_ORCHESTRATOR_PUBLIC_PORT = 4318;
export const MANAGED_ORCHESTRATOR_INTERNAL_PORT = 4317;
export const MANAGED_ORCHESTRATOR_START_TIMEOUT_MS = DESKTOP_BOOTSTRAP_MAX_TTL_MS;
const MANAGED_OUTBOUND_PROXY_RESOLVE_TIMEOUT_MS = 2_000;
const MANAGED_ORCHESTRATOR_TERMINATION_CONFIRMATION_TIMEOUT_MS = 5_000;

export interface ManagedOrchestratorConnection {
  /** The Web connection profile ID is always the current durable Connection ID. */
  readonly profileId: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
}

export interface ManagedOrchestratorRuntime {
  readonly connection: ManagedOrchestratorConnection;
  /** One-shot move into safeStorage or main-process volatile memory. */
  readonly takeAuthKey: () => string;
  readonly processId?: number;
  /** Complete only after safeStorage and managed profile metadata are durable. */
  readonly commit: () => Promise<void>;
  /** Release bootstrap pipes and unref the daemon without stopping workloads. */
  readonly release: () => void;
  /** Explicit service-management/test cleanup, including bundled Desktop tray exit. */
  readonly stop: () => Promise<void>;
}

export type ManagedOrchestratorProbeResult =
  | "authenticated"
  | "absent"
  | "serviceUnavailable"
  | "identityConflict"
  | "credentialUnavailable"
  | "credentialRejected";

export type ManagedOrchestratorAdoptionResult =
  | "verified"
  | "serviceUnavailable"
  | "identityConflict"
  | "credentialUnavailable"
  | "credentialRejected"
  | "connectionMismatch";

/**
 * A service-unavailable saved endpoint may be respawned only after Desktop has
 * itself confirmed the owned child stopped (for example, a failed update apply).
 * An absent endpoint remains the normal crash-recovery bootstrap path.
 */
export function canRespawnManagedOrchestratorAfterProbe(
  probe: ManagedOrchestratorProbeResult,
  controlledStopConfirmed: boolean
): boolean {
  return probe === "absent" || (probe === "serviceUnavailable" && controlledStopConfirmed);
}

export class ManagedOrchestratorAuthorizationUnavailableError extends Error {
  constructor() {
    super("The saved managed Orchestrator authorization is unavailable.");
    this.name = "ManagedOrchestratorAuthorizationUnavailableError";
  }
}

interface SpawnedManagedOrchestrator {
  readonly child: ChildProcess;
  readonly requestPipe: Writable;
  readonly responsePipe: Readable;
}

export interface StartManagedOrchestratorOptions {
  readonly orchestratorEntryPath: string;
  readonly dataDirectory: string;
  readonly workspaceRoot: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly appVersion: string;
  readonly platform?: string;
  readonly parentPid?: number;
  readonly publicPort?: number;
  readonly internalPort?: number;
  readonly executablePath?: string;
  /** Trusted development-only ESM import hook, resolved by the Desktop host. */
  readonly nodeImportPath?: string;
  /** Electron-owned resource root; never accepted through the child environment allowlist. */
  readonly resourcesDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly ephemeral?: boolean;
  readonly previousConnection?: {
    readonly connectionId: string;
    readonly authKey: string;
  };
  readonly spawnChild?: (executable: string, args: readonly string[], options: SpawnOptions) => SpawnedManagedOrchestrator;
}

export async function loadOrCreateManagedOrchestratorDeviceId(path: string): Promise<string> {
  const existing = await readPrivateFile(path);
  if (existing !== undefined) {
    const value = decodeUuid(existing);
    existing.fill(0);
    return value;
  }
  const deviceId = randomUUID();
  await persistManagedOrchestratorDeviceId(path, deviceId);
  return deviceId;
}

export async function persistManagedOrchestratorDeviceId(path: string, deviceId: string): Promise<void> {
  const normalized = normalizedUuid(deviceId);
  const bytes = Buffer.from(`${normalized}\n`, "utf8");
  try {
    await atomicWritePrivateFile(path, bytes);
  } finally {
    bytes.fill(0);
  }
}

/** Reserve an available pair immediately before spawning the child service. */
export async function selectManagedOrchestratorPorts(): Promise<{
  readonly publicPort: number;
  readonly internalPort: number;
}> {
  const publicPort = await selectLoopbackPort(MANAGED_ORCHESTRATOR_PUBLIC_PORT);
  const internalPort = await selectLoopbackPort(
    MANAGED_ORCHESTRATOR_INTERNAL_PORT === publicPort ? 0 : MANAGED_ORCHESTRATOR_INTERNAL_PORT,
    new Set([publicPort])
  );
  return { publicPort, internalPort };
}

export async function startManagedOrchestrator(options: StartManagedOrchestratorOptions): Promise<ManagedOrchestratorRuntime> {
  const entryPath = resolve(options.orchestratorEntryPath);
  const dataDirectory = resolve(options.dataDirectory);
  const workspaceRoot = resolve(options.workspaceRoot);
  const resourcesDirectory = options.resourcesDirectory === undefined
    ? undefined
    : resolve(options.resourcesDirectory);
  const nodeImportPath = options.nodeImportPath === undefined
    ? undefined
    : resolve(options.nodeImportPath);
  if (!isAbsolute(options.orchestratorEntryPath) || entryPath !== options.orchestratorEntryPath) throw startupUnavailable();
  if (resourcesDirectory !== undefined &&
    (!isAbsolute(options.resourcesDirectory!) || resourcesDirectory !== options.resourcesDirectory)) {
    throw startupUnavailable();
  }
  await assertRegularEntry(entryPath);
  if (nodeImportPath !== undefined) {
    if (!isAbsolute(options.nodeImportPath!) || nodeImportPath !== options.nodeImportPath) throw startupUnavailable();
    await assertRegularEntry(nodeImportPath);
  }
  await ensurePrivateDirectory(dataDirectory);
  const publicPort = validPort(options.publicPort ?? MANAGED_ORCHESTRATOR_PUBLIC_PORT);
  const internalPort = validPort(options.internalPort ?? MANAGED_ORCHESTRATOR_INTERNAL_PORT);
  if (publicPort === internalPort) throw startupUnavailable();
  const parentPid = validPid(options.parentPid ?? process.pid);
  const now = options.now ?? Date.now;
  const request = createDesktopBootstrapRequest({
    parentPid,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    platform: options.platform ?? process.platform,
    appVersion: options.appVersion,
    ttlMs: MANAGED_ORCHESTRATOR_START_TIMEOUT_MS,
    ...(options.previousConnection === undefined ? {} : { previousConnection: options.previousConnection })
  }, { now });
  const origin = `http://127.0.0.1:${publicPort}`;
  const executable = options.executablePath ?? process.execPath;
  const environment: NodeJS.ProcessEnv = {
    ...managedOrchestratorEnvironment(options.environment ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
    JOKO_DATA_DIR: dataDirectory,
    JOKO_HOST: "127.0.0.1",
    JOKO_PORT: String(publicPort),
    JOKO_INTERNAL_PORT: String(internalPort),
    JOKO_PUBLIC_ORIGIN: origin,
    JOKO_ALLOW_INSECURE_LOOPBACK: "1",
    JOKO_ALLOW_INSECURE_LAN: "0",
    JOKO_LAN_DISCOVERY: "0",
    JOKO_WORKSPACE_ROOT: workspaceRoot,
    JOKO_WORKSPACE_NAME: "Local workspace",
    JOKO_WORKSPACE_TRUSTED: "0",
    ...(resourcesDirectory === undefined ? {} : { JOKO_DESKTOP_RESOURCES_PATH: resourcesDirectory }),
    // The managed child is an API service. It must not accidentally publish a
    // second copy of the Desktop Web bundle from a process working directory.
    JOKO_WEB_DIR: resolve(dataDirectory, "no-public-web")
  };
  const hostedArgument = options.ephemeral === true ? "--desktop-hosted-ephemeral" : "--desktop-hosted";
  const nodeArguments = nodeImportPath === undefined
    ? []
    : ["--import", pathToFileURL(nodeImportPath).href];
  const spawned = (options.spawnChild ?? spawnManagedOrchestratorChild)(executable, [...nodeArguments, entryPath, hostedArgument], {
    cwd: dataDirectory,
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true
  });
  const { child, requestPipe, responsePipe } = spawned;
  let started = false;
  try {
    const responsePromise = receiveResponse(responsePipe, child, MANAGED_ORCHESTRATOR_START_TIMEOUT_MS);
    await sendRequest(requestPipe, request);
    const response = await responsePromise;
    verifyDesktopBootstrapResponse(request, response, { now });
    if (response.origin !== origin) throw startupUnavailable();
    let pendingAuthKey: string | undefined = response.authKey;
    let committed = false;
    let committing: Promise<void> | undefined;
    started = true;
    const processControl = createProcessControl(child, requestPipe, responsePipe);
    return {
      connection: {
        profileId: response.connectionId,
        deviceId: response.deviceId,
        serverId: response.serverId,
        name: "Local Joko",
        origin: response.origin
      },
      takeAuthKey: () => {
        const authKey = pendingAuthKey;
        if (authKey === undefined) throw new Error("The managed Orchestrator credential was already consumed.");
        pendingAuthKey = undefined;
        return authKey;
      },
      commit: () => {
        committing ??= (async () => {
          const confirmationPromise = receiveCommitted(responsePipe, child, MANAGED_ORCHESTRATOR_START_TIMEOUT_MS);
          const commit = createDesktopBootstrapCommit(request, response, { now });
          await sendCommit(requestPipe, commit);
          const confirmation = await confirmationPromise;
          verifyDesktopBootstrapCommitted(request, response, confirmation, { now });
          committed = true;
        })();
        return committing;
      },
      ...(child.pid === undefined ? {} : { processId: child.pid }),
      release: () => {
        if (!committed) throw new Error("The managed Orchestrator bootstrap was not durably committed.");
        processControl.release();
      },
      stop: processControl.stop
    };
  } catch {
    throw startupUnavailable();
  } finally {
    if (!started) {
      responsePipe.destroy();
      requestPipe.destroy();
      await terminateManagedOrchestratorChild(child, 1_000);
    }
  }
}

/** Verify public identity before ever retrieving or sending the saved bearer. */
export async function probeManagedOrchestratorConnection(options: {
  readonly connection: ManagedOrchestratorConnection;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
}): Promise<ManagedOrchestratorProbeResult> {
  const fetchImpl = options.fetch ?? fetch;
  const identity = await connectJson(fetchImpl, options.connection.origin, "joko.v1.ConnectionService/GetServerInfo");
  if (identity.kind === "absent") return "absent";
  if (identity.kind === "indeterminate") return "serviceUnavailable";
  if (identity.status !== 200 || !isRecord(identity.body) ||
    !isRecord(identity.body["server"]) ||
    identity.body["server"]["serverId"] !== options.connection.serverId) return "identityConflict";
  let authKey: string | undefined;
  try {
    authKey = await options.readAuthKey(options.connection.profileId);
  } catch {
    return "credentialUnavailable";
  }
  if (authKey === undefined) return "credentialUnavailable";
  const authenticated = await connectJson(
    fetchImpl,
    options.connection.origin,
    "joko.v1.ConnectionService/ListConnections",
    authKey
  );
  if (authenticated.kind !== "response") return "serviceUnavailable";
  if (authenticated.status === 200) return "authenticated";
  if (authenticated.status === 401 || authenticated.status === 403) return "credentialRejected";
  return "serviceUnavailable";
}

/** Verify a freshly owner-paired Connection before it becomes Desktop's new
 * managed identity. The bearer is retrieved only after the public stable-ID
 * fence, and the authenticated catalog must contain the exact Connection and
 * Device returned by pairing. */
export async function verifyManagedOrchestratorAdoption(options: {
  readonly expectedServerId: string;
  readonly connection: ManagedOrchestratorConnection;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
}): Promise<ManagedOrchestratorAdoptionResult> {
  if (options.connection.serverId !== options.expectedServerId) return "identityConflict";
  const fetchImpl = options.fetch ?? fetch;
  const identity = await connectJson(fetchImpl, options.connection.origin, "joko.v1.ConnectionService/GetServerInfo");
  if (identity.kind !== "response") return "serviceUnavailable";
  if (identity.status !== 200 || !isRecord(identity.body) || !isRecord(identity.body["server"]) ||
    identity.body["server"]["serverId"] !== options.expectedServerId) return "identityConflict";
  let authKey: string | undefined;
  try {
    authKey = await options.readAuthKey(options.connection.profileId);
  } catch {
    return "credentialUnavailable";
  }
  if (authKey === undefined) return "credentialUnavailable";
  const authenticated = await connectJson(
    fetchImpl,
    options.connection.origin,
    "joko.v1.ConnectionService/ListConnections",
    authKey
  );
  if (authenticated.kind !== "response") return "serviceUnavailable";
  if (authenticated.status === 401 || authenticated.status === 403) return "credentialRejected";
  if (authenticated.status !== 200 || !isRecord(authenticated.body) || !Array.isArray(authenticated.body["connections"])) {
    return "serviceUnavailable";
  }
  const matched = authenticated.body["connections"].some((value) => isRecord(value) &&
    value["connectionId"] === options.connection.profileId &&
    value["deviceId"] === options.connection.deviceId &&
    (value["state"] === 2 || value["state"] === "CONNECTION_STATE_CONNECTED"));
  return matched ? "verified" : "connectionMismatch";
}

/**
 * A previously managed installation may respawn only while its saved bearer
 * still exists. Durable Orchestrator state independently rejects revoked-only
 * Devices, so deleting the credential alone cannot silently mint a new
 * authority when the old endpoint is offline. The separate verified logout
 * lifecycle retires this metadata only after server-side revocation.
 */
export async function startManagedOrchestratorWithAuthorizationFence<T>(options: {
  readonly previous?: ManagedOrchestratorConnection;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly start: (previousConnection?: { readonly connectionId: string; readonly authKey: string }) => Promise<T>;
}): Promise<T> {
  let previousConnection: { readonly connectionId: string; readonly authKey: string } | undefined;
  if (options.previous !== undefined) {
    const existingAuthKey = await options.readAuthKey(options.previous.profileId);
    if (existingAuthKey === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(existingAuthKey)) {
      throw new ManagedOrchestratorAuthorizationUnavailableError();
    }
    previousConnection = { connectionId: options.previous.profileId, authKey: existingAuthKey };
  }
  return options.start(previousConnection);
}

/**
 * Retires Desktop's restart authority only after the renderer has completed an
 * explicit server-side logout. Metadata is removed before the now-revoked
 * bearer so a crash can at worst leave an unreachable stale secret; it can
 * never leave saved authority pointing at a missing credential.
 */
export async function completeManagedOrchestratorLogout(options: {
  readonly expected: ManagedOrchestratorConnection;
  readonly readSavedConnection: () => Promise<ManagedOrchestratorConnection | undefined>;
  readonly deleteSavedConnection: () => Promise<void>;
  readonly deleteCredential: (profileId: string) => Promise<void>;
  readonly onCredentialCleanupFailure?: (error: unknown) => void;
}): Promise<void> {
  const saved = await options.readSavedConnection();
  if (saved === undefined || !sameManagedConnection(saved, options.expected)) {
    throw new Error("Managed Orchestrator logout no longer matches the saved restart authority.");
  }
  await options.deleteSavedConnection();
  try {
    await options.deleteCredential(options.expected.profileId);
  } catch (error) {
    options.onCredentialCleanupFailure?.(error);
  }
}

export async function completeVerifiedManagedOrchestratorLogout(options: {
  readonly verifyRevocation: () => Promise<ManagedOrchestratorProbeResult>;
  readonly completion: Parameters<typeof completeManagedOrchestratorLogout>[0];
}): Promise<void> {
  const result = await options.verifyRevocation();
  if (result !== "credentialRejected") {
    throw new Error(`Managed Orchestrator logout was not durably verified: ${result}.`);
  }
  await completeManagedOrchestratorLogout(options.completion);
}

/**
 * Promote an owner-paired recovery Connection only by rotating it through the
 * private Desktop bootstrap. The ordinary paired bearer is proof for that
 * launch, never the managed authority persisted for the renderer.
 */
export async function commitVerifiedManagedOrchestratorAdoption(options: {
  readonly candidate: ManagedOrchestratorConnection;
  readonly previousDeviceId: string;
  readonly stopCurrentRuntime: () => Promise<void>;
  readonly startWithCandidateProof: (candidate: ManagedOrchestratorConnection) => Promise<ManagedOrchestratorRuntime>;
  readonly persistDeviceId: (deviceId: string) => Promise<void>;
  readonly restorePreviousDeviceId: (deviceId: string) => Promise<void>;
  readonly restorePreviousConnection: () => Promise<void>;
  readonly storeCredential: (profileId: string, authKey: string) => Promise<void>;
  readonly persistConnection: (connection: ManagedOrchestratorConnection) => Promise<void>;
  readonly deleteCredential: (profileId: string) => Promise<void>;
  readonly onStaleCredentialCleanupFailure?: (error: unknown) => void;
}): Promise<ManagedOrchestratorRuntime> {
  let runtime: ManagedOrchestratorRuntime | undefined;
  let authKey: string | undefined;
  let connectionPersisted = false;
  try {
    await options.stopCurrentRuntime();
    runtime = await options.startWithCandidateProof(options.candidate);
    if (runtime.connection.profileId === options.candidate.profileId ||
      runtime.connection.deviceId !== options.candidate.deviceId ||
      runtime.connection.serverId !== options.candidate.serverId) {
      throw new Error("Managed Orchestrator recovery bootstrap returned the wrong authority.");
    }
    authKey = runtime.takeAuthKey();
    await options.persistDeviceId(runtime.connection.deviceId);
    await options.storeCredential(runtime.connection.profileId, authKey);
    await options.persistConnection(runtime.connection);
    connectionPersisted = true;
    await runtime.commit();
    await options.deleteCredential(options.candidate.profileId).catch((error) => {
      options.onStaleCredentialCleanupFailure?.(error);
    });
    return runtime;
  } catch (error) {
    if (!connectionPersisted && runtime !== undefined) {
      // Private-file writes can fail after their atomic rename has already
      // become visible. Clean both possible outputs unconditionally so the
      // rollback cannot leave an uncommitted authority on disk.
      await options.deleteCredential(runtime.connection.profileId).catch(() => undefined);
      await options.restorePreviousConnection().catch(() => undefined);
      await options.restorePreviousDeviceId(options.previousDeviceId).catch(() => undefined);
    }
    if (runtime !== undefined) await runtime.stop().catch(() => undefined);
    throw error;
  } finally {
    authKey = undefined;
  }
}

function sameManagedConnection(left: ManagedOrchestratorConnection, right: ManagedOrchestratorConnection): boolean {
  return left.profileId === right.profileId &&
    left.deviceId === right.deviceId &&
    left.serverId === right.serverId &&
    left.name === right.name &&
    left.origin === right.origin;
}

export function resolveManagedOrchestratorEntry(
  sourceDirectory: string,
  options: {
    readonly packaged?: boolean;
    readonly resourcesPath?: string;
    readonly developmentWorkspace?: boolean;
  } = {}
): string {
  const directory = resolve(sourceDirectory);
  if (!isAbsolute(sourceDirectory) || directory !== sourceDirectory) throw startupUnavailable();
  if (options.packaged === true) {
    if (options.resourcesPath === undefined || !isAbsolute(options.resourcesPath) ||
      resolve(options.resourcesPath) !== options.resourcesPath) throw startupUnavailable();
    // Production never walks out of Electron's immutable resources directory
    // into a developer checkout or an ancestor node_modules tree.
    return resolve(options.resourcesPath, "orchestrator-runtime", "dist", "main.js");
  }
  if (options.developmentWorkspace === true) {
    // The trusted development import hook resolves workspace TypeScript
    // exports while this entry always comes from the build prepared above.
    return resolve(directory, "..", "..", "orchestrator", "dist", "main.js");
  }
  return resolve(directory, "orchestrator-runtime", "dist", "main.js");
}

/**
 * Pass only OS process-launch necessities and explicitly audited runtime
 * settings. Authenticated proxy URLs are volatile launch inputs only; provider
 * credentials still enter through Orchestrator's credential channel.
 */
export function managedOrchestratorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramData",
    "PROGRAMFILES", "ProgramFiles", "PROGRAMFILES(X86)", "ProgramFiles(x86)", "PROGRAMW6432", "ProgramW6432",
    "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SystemDrive", "USERNAME",
    "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "XDG_SESSION_TYPE", "SSH_AUTH_SOCK",
    "PLAYWRIGHT_BROWSERS_PATH",
    "JOKO_PI_EXECUTABLE", "JOKO_PI_PROVIDERS_FILE", "JOKO_PI_SETTINGS_FILE",
    "JOKO_CODEX_EXECUTABLE", "JOKO_CLAUDE_CODE_EXECUTABLE",
    "JOKO_BROWSER_EXECUTABLE", "JOKO_BROWSER_HEADLESS", "JOKO_BROWSER_ENABLED",
    "JOKO_ANDROID_ADB_PATH", "ANDROID_HOME", "ANDROID_SDK_ROOT",
    "JOKO_COMPUTER_DRIVER_EXECUTABLE", "JOKO_LOG_LEVEL"
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(name)) environment[name] = value;
  }
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const) {
    const value = boundedManagedAbsolutePath(source[name]);
    if (value !== undefined) environment[name] = value;
  }
  const codexProfile = boundedManagedText(source["CODEX_PROFILE"], 256);
  if (codexProfile !== undefined) environment["CODEX_PROFILE"] = codexProfile;
  const adbServerPort = source["ANDROID_ADB_SERVER_PORT"];
  if (typeof adbServerPort === "string" && /^\d{1,5}$/u.test(adbServerPort)) {
    const parsed = Number(adbServerPort);
    if (parsed >= 1 && parsed <= 65_535) environment["ANDROID_ADB_SERVER_PORT"] = String(parsed);
  }
  for (const name of MANAGED_OUTBOUND_PROXY_ENVIRONMENT_KEYS) {
    const value = validManagedEnvironmentProxy(name, source[name]);
    if (value !== undefined) environment[name] = value;
  }
  for (const name of ["NO_PROXY", "no_proxy"] as const) {
    const value = boundedManagedNoProxy(source[name]);
    if (value !== undefined) environment[name] = value;
  }
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const value = boundedManagedOutboundToken(source[name]);
    if (value !== undefined) environment[name] = value;
  }
  const snapshot = decodeManagedOutboundProxySnapshot(source[MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]);
  if (snapshot !== undefined) {
    const encoded = encodeManagedOutboundProxySnapshot(snapshot.routes);
    if (encoded !== undefined) environment[MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV] = encoded;
  }
  return environment;
}

export type ManagedOrchestratorSystemProxyResolver = (
  upstreamUrl: string
) => Promise<string> | string;

/** Resolve a bounded launch snapshot without putting proxy decisions on the bootstrap pipe. */
export async function managedOrchestratorOutboundProxySnapshotEnvironment(
  source: NodeJS.ProcessEnv,
  resolveSystemProxy: ManagedOrchestratorSystemProxyResolver
): Promise<NodeJS.ProcessEnv> {
  if (hasManagedOutboundProxyEnvironment(source)) return {};
  const entries = await Promise.all(MANAGED_OUTBOUND_PROXY_TARGETS.map(async (target) => [
    target.id,
    await resolveManagedSystemProxy(target.probeUrl, resolveSystemProxy)
  ] as const));
  const routes: Record<string, ManagedOutboundProxyVerdict | undefined> = {};
  for (const [id, verdict] of entries) routes[id] = verdict;
  const encoded = encodeManagedOutboundProxySnapshot(routes);
  return encoded === undefined ? {} : { [MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]: encoded };
}

/** Parse bounded Chromium HTTP/SOCKS5/DIRECT results for the private launch snapshot. */
export function parseManagedChromiumProxyResult(
  result: string
): ManagedOutboundProxyVerdict | undefined {
  if (result.length > 64 * 1024 || /[\0\r\n]/u.test(result)) return undefined;
  let socks5Fallback: string | undefined;
  for (const rawEntry of result.split(";")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const separator = entry.indexOf(" ");
    const kind = (separator < 0 ? entry : entry.slice(0, separator)).toUpperCase();
    if (kind === "DIRECT") return socks5Fallback ?? null;
    if (separator < 0) continue;
    const hostPort = entry.slice(separator + 1).trim();
    if (kind === "PROXY" || kind === "HTTP") {
      const proxy = managedSystemProxy(hostPort, "http:");
      if (proxy !== undefined) return proxy;
      continue;
    }
    if (kind === "SOCKS5") {
      socks5Fallback ??= managedSystemProxy(hostPort, "socks5:");
    }
  }
  return socks5Fallback ?? null;
}

async function resolveManagedSystemProxy(
  upstreamUrl: string,
  resolveSystemProxy: ManagedOrchestratorSystemProxyResolver
): Promise<ManagedOutboundProxyVerdict | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolvePromise) => {
      timer = setTimeout(resolvePromise, MANAGED_OUTBOUND_PROXY_RESOLVE_TIMEOUT_MS, undefined);
      timer.unref?.();
    });
    const result = await Promise.race([
      Promise.resolve().then(() => resolveSystemProxy(upstreamUrl)),
      timeout
    ]);
    return typeof result === "string" ? parseManagedChromiumProxyResult(result) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function managedSystemProxy(hostPort: string, protocol: "http:" | "socks5:"): string | undefined {
  if (hostPort === "" || hostPort.length > 2_048 || /[\0\r\n\s]/u.test(hostPort)) return undefined;
  try {
    const proxy = new URL(`${protocol}//${hostPort}`);
    const port = proxy.port === "" ? (protocol === "http:" ? 80 : 1080) : Number(proxy.port);
    if (
      proxy.protocol !== protocol
      || proxy.hostname === ""
      || proxy.username !== ""
      || proxy.password !== ""
      || proxy.pathname !== (protocol === "http:" ? "/" : "")
      || proxy.search !== ""
      || proxy.hash !== ""
      || !Number.isSafeInteger(port)
      || port < 1
      || port > 65_535
    ) return undefined;
    return proxy.toString();
  } catch {
    return undefined;
  }
}

function validManagedEnvironmentProxy(
  name: (typeof MANAGED_OUTBOUND_PROXY_ENVIRONMENT_KEYS)[number],
  value: string | undefined
): string | undefined {
  if (value === undefined || value === "" || value.length > 16 * 1024 || /[\0\r\n]/u.test(value)) {
    return undefined;
  }
  try {
    const proxy = new URL(value);
    const allowed = ["http:", "https:", "socks5:", "socks5h:"];
    return allowed.includes(proxy.protocol) ? proxy.toString() : undefined;
  } catch {
    return undefined;
  }
}

function boundedManagedNoProxy(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" && value.length <= 16 * 1024 && !/[\0\r\n]/u.test(value)
    ? value
    : undefined;
}

function boundedManagedOutboundToken(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" && value.length <= 4_096 && !/[\0\r\n\s]/u.test(value)
    ? value
    : undefined;
}

function boundedManagedAbsolutePath(value: string | undefined): string | undefined {
  if (
    value === undefined
    || value === ""
    || value.length > 32_768
    || /[\0\r\n]/u.test(value)
    || !isAbsolute(value)
  ) return undefined;
  return resolve(value);
}

function boundedManagedText(value: string | undefined, maximumCharacters: number): string | undefined {
  return value !== undefined
    && value !== ""
    && value.length <= maximumCharacters
    && !/[\0\r\n]/u.test(value)
    ? value
    : undefined;
}

function spawnManagedOrchestratorChild(
  executable: string,
  args: readonly string[],
  options: SpawnOptions
): SpawnedManagedOrchestrator {
  const child = spawn(executable, args, options);
  const requestPipe = child.stdio[3];
  const responsePipe = child.stdio[4];
  if (!isWritable(requestPipe) || !isReadable(responsePipe)) {
    child.kill();
    throw startupUnavailable();
  }
  return { child, requestPipe, responsePipe };
}

async function connectJson(
  fetchImpl: typeof fetch,
  origin: string,
  method: string,
  authKey?: string
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "response"; readonly status: number; readonly body?: unknown }
  | { readonly kind: "indeterminate" }
> {
  try {
    const response = await fetchImpl(`${origin}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        ...(authKey === undefined ? {} : { authorization: `Bearer ${authKey}` })
      },
      body: "{}",
      signal: AbortSignal.timeout(2_000)
    });
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    return { kind: "response", status: response.status, ...(body === undefined ? {} : { body }) };
  } catch (error) {
    return connectionRefused(error) ? { kind: "absent" } : { kind: "indeterminate" };
  }
}

function connectionRefused(value: unknown): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && ["ECONNREFUSED", "ENOENT"].includes(String(current.code))) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sendRequest(output: Writable, request: DesktopBootstrapRequest): Promise<void> {
  const frame = Buffer.from(encodeDesktopBootstrapRequestFrame(request));
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (): void => reject(startupUnavailable());
      output.once("error", onError);
      output.write(frame, (error) => {
        output.off("error", onError);
        if (error === null || error === undefined) resolvePromise(); else reject(startupUnavailable());
      });
    });
  } finally {
    frame.fill(0);
  }
}

function receiveResponse(
  input: Readable,
  child: ChildProcess,
  timeoutMs: number
): Promise<DesktopBootstrapResponse> {
  return new Promise<DesktopBootstrapResponse>((resolvePromise, reject) => {
    const decoder = new DesktopBootstrapFrameDecoder();
    let settled = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("error", onFailure);
      input.off("end", onEnd);
      child.off("error", onFailure);
      child.off("exit", onExit);
    };
    const finish = (response?: DesktopBootstrapResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (response === undefined) reject(startupUnavailable()); else resolvePromise(response);
    };
    const onFailure = (): void => finish();
    const onEnd = (): void => finish();
    const onExit = (): void => finish();
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      let payload: Uint8Array | undefined;
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        [payload] = decoder.push(bytes);
        if (payload === undefined) return;
        decoder.finish();
        finish(decodeDesktopBootstrapResponsePayload(payload));
      } catch {
        finish();
      } finally {
        payload?.fill(0);
      }
    };
    input.on("data", onData);
    input.once("error", onFailure);
    input.once("end", onEnd);
    child.once("error", onFailure);
    child.once("exit", onExit);
  });
}

function sendCommit(output: Writable, commit: DesktopBootstrapCommit): Promise<void> {
  const frame = Buffer.from(encodeDesktopBootstrapCommitFrame(commit));
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (): void => reject(startupUnavailable());
    output.once("error", onError);
    output.write(frame, (error) => {
      output.off("error", onError);
      frame.fill(0);
      if (error === null || error === undefined) resolvePromise(); else reject(startupUnavailable());
    });
  }).finally(() => frame.fill(0));
}

function receiveCommitted(
  input: Readable,
  child: ChildProcess,
  timeoutMs: number
): Promise<DesktopBootstrapCommitted> {
  return new Promise<DesktopBootstrapCommitted>((resolvePromise, reject) => {
    const decoder = new DesktopBootstrapFrameDecoder();
    let settled = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("error", onFailure);
      input.off("end", onFailure);
      child.off("error", onFailure);
      child.off("exit", onFailure);
    };
    const finish = (committed?: DesktopBootstrapCommitted): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (committed === undefined) reject(startupUnavailable()); else resolvePromise(committed);
    };
    const onFailure = (): void => finish();
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      let payload: Uint8Array | undefined;
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        [payload] = decoder.push(bytes);
        if (payload === undefined) return;
        decoder.finish();
        finish(decodeDesktopBootstrapCommittedPayload(payload));
      } catch {
        finish();
      } finally {
        payload?.fill(0);
      }
    };
    input.on("data", onData);
    input.once("error", onFailure);
    input.once("end", onFailure);
    child.once("error", onFailure);
    child.once("exit", onFailure);
  });
}

function createProcessControl(child: ChildProcess, requestPipe: Writable, responsePipe: Readable): {
  readonly release: () => void;
  readonly stop: () => Promise<void>;
} {
  let stopping: Promise<void> | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    requestPipe.destroy();
    responsePipe.destroy();
    child.unref();
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      requestPipe.destroy();
      responsePipe.destroy();
      await terminateManagedOrchestratorChild(child, released ? 0 : 5_000);
    })();
    return stopping;
  };
  return { release, stop };
}

async function terminateManagedOrchestratorChild(child: ChildProcess, gracefulMs: number): Promise<void> {
  if (childExited(child)) return;
  if (gracefulMs > 0 && await waitForChildExit(child, gracefulMs)) return;
  try { child.kill("SIGTERM"); } catch { /* continue to the confirmed force phase */ }
  if (await waitForChildExit(child, MANAGED_ORCHESTRATOR_TERMINATION_CONFIRMATION_TIMEOUT_MS)) return;
  try { child.kill("SIGKILL"); } catch { /* the final observed-exit fence remains authoritative */ }
  if (await waitForChildExit(child, MANAGED_ORCHESTRATOR_TERMINATION_CONFIRMATION_TIMEOUT_MS)) return;
  throw shutdownUnavailable();
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(exited || childExited(child));
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    if (childExited(child)) finish(true);
  });
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function selectLoopbackPort(preferred: number, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  const candidate = excluded.has(preferred) ? 0 : preferred;
  try {
    return await bindAvailablePort(candidate);
  } catch {
    if (candidate === 0) throw startupUnavailable();
    const selected = await bindAvailablePort(0);
    if (excluded.has(selected)) throw startupUnavailable();
    return selected;
  }
}

function bindAvailablePort(port: number): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      const selected = typeof address === "object" && address !== null ? address.port : undefined;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else if (selected === undefined) reject(startupUnavailable());
        else resolvePromise(selected);
      });
    });
  });
}

async function assertRegularEntry(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(path), path)) throw startupUnavailable();
  } catch {
    throw startupUnavailable();
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function decodeUuid(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("The managed Orchestrator Device identity is invalid.");
  }
  return normalizedUuid(value);
}

function normalizedUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("The managed Orchestrator Device identity is invalid.");
  }
  return value.toLowerCase();
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw startupUnavailable();
  return value;
}

function validPid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) throw startupUnavailable();
  return value;
}

function isWritable(value: unknown): value is Writable {
  return typeof value === "object" && value !== null && "write" in value && typeof value.write === "function";
}

function isReadable(value: unknown): value is Readable {
  return typeof value === "object" && value !== null && "on" in value && typeof value.on === "function";
}

function startupUnavailable(): Error {
  return new Error("The managed local Orchestrator service could not start securely.");
}

function shutdownUnavailable(): Error {
  return new Error("The managed local Orchestrator service did not stop after termination.");
}
