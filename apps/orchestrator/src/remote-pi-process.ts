import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { posix as remotePath } from "node:path";
import { PassThrough, Transform, type Readable, type TransformCallback, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  MANAGED_SUBAGENT_NODE_ENV,
  MANAGED_SUBAGENT_PRODUCT_SESSION_ENV,
  MANAGED_SUBAGENT_RUNNER_FILE_NAME,
  type PiManagedDurableRunSnapshot,
  type PiManagedDurableStore,
  type PiManagedDurableStoreRegistry,
  spawnPiProcess,
  type PiProcessFactory,
  type PiProcessHandle,
  type PiProcessSpec
} from "@joko/adapter-pi";
import type {
  RemoteFileTransportPort,
  RemoteProcessHandle,
  RemoteProcessTransportPort,
  RemoteReverseForwardHandle,
  RemoteSshTransportLease
} from "@joko/remote-ssh";

import type { RemoteHostRegistry } from "./remote-host-registry.js";
import {
  REMOTE_PI_BROKER_PROTOCOL_VERSION,
  REMOTE_PI_BROKER_SOURCE,
  REMOTE_PI_BROKER_SOURCE_SHA256,
  remotePiLaunchHash
} from "./remote-pi-broker-source.js";

const MAXIMUM_SYNC_FILES = 20_000;
const MAXIMUM_SYNC_BYTES = 128 * 1024 * 1024;
const MAXIMUM_SYNC_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_BROKER_BOOTSTRAP_BYTES = 1024 * 1024;
const MAXIMUM_AUTHORITY_BYTES = 64 * 1024;
const AUTHORITY_CONTROL_TIMEOUT_MS = 10_000;
const BROKER_KILL_TIMEOUT_MS = 10_000;
const DELETION_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_RELIABLE_INPUT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_REMOTE_FRAME_BYTES = 64 * 1024 * 1024;
const REMOTE_FRAME_STDIN = 1;
const REMOTE_FRAME_STDOUT = 2;
const REMOTE_FRAME_STDERR = 3;
const REMOTE_FRAME_EXIT = 4;
const REMOTE_FRAME_KILL = 5;
const REMOTE_FRAME_OUTPUT_ACK = 6;
const REMOTE_FRAME_INPUT_ACK = 7;
const REMOTE_FRAME_AUTHORITY = 8;
const REMOTE_FRAME_AUTHORITY_COMMIT = 9;
const REMOTE_FRAME_AUTHORITY_COMMIT_ACK = 10;
const MANAGED_BEARER_LAUNCH_MARKER = "<joko-broker-managed-bearer>";
const MANAGED_GENERATION_LAUNCH_MARKER = "<joko-broker-runtime-generation>";
const MANAGED_SPAWN_IDENTITY_LAUNCH_MARKER = "<joko-broker-spawn-identity>";
const MANAGED_NODE_EXECUTABLE_LAUNCH_MARKER = "<joko-broker-node-executable>";
const NATIVE_AUTH_RESERVATION_TOKEN_ENV = "JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN";
const NATIVE_AUTH_RESERVATION_LAUNCH_MARKER = "<joko-broker-native-auth-reservation>";

export interface RemotePiProcessFactoryOptions {
  readonly registry: RemoteHostRegistry;
  readonly localFactory?: PiProcessFactory;
  readonly authorityRoot: string;
}

interface RemoteAuthorityScope {
  readonly targetId: string;
  readonly hostId: string;
  readonly recoveryIdentity: string;
}

interface RemoteManagedStoreScope extends RemoteAuthorityScope {
  readonly sessionId: string;
  readonly identity: string;
}

interface RemoteAuthorityRequest extends RemoteAuthorityScope {
  readonly format: 1;
  readonly spawnIdentity: string;
  readonly runtimeGeneration: number;
  readonly compatibilityHash: string;
  readonly candidateProcessLaunchHash: string;
  readonly trustedRunnerScriptSha256: string;
  readonly recovery?: RemoteAuthorityEnvelope;
}

interface RemoteAuthorityEnvelope extends RemoteAuthorityScope {
  readonly format: 1;
  readonly spawnIdentity: string;
  readonly runtimeGeneration: number;
  readonly compatibilityHash: string;
  readonly childProcessLaunchHash: string;
  readonly trustedRunnerScriptSha256: string;
  readonly identity: string;
  readonly launchHash: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly startedAt: number;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly attestation: string;
}

interface RemoteAuthorityState {
  readonly inputAcknowledged: number;
  readonly outputAcknowledged: number;
  readonly outputSequence: number;
  readonly authorityCommitRequired: boolean;
  readonly authorityDigest: string;
  readonly recoveryOutputHighWater?: number;
}

interface RemoteAuthorityCommitAcknowledgement {
  readonly ok: true;
  readonly epoch: number;
  readonly authorityDigest: string;
}

interface RemoteAuthorityRecord {
  readonly format: 1;
  readonly authority: RemoteAuthorityEnvelope;
  readonly outputCursor: number;
  readonly updatedAt: number;
  readonly deletion?: {
    readonly format: 1;
    readonly receipt: string;
    readonly finalizedAt: number;
  };
}

type RemoteAuthorityControl = {
  readonly ok: true;
  readonly authority: RemoteAuthorityEnvelope;
  readonly state: RemoteAuthorityState;
} | {
  readonly ok: false;
  readonly recoveryRejected: true;
  readonly authorityVerified: boolean;
  readonly reason: string;
};

/**
 * Routes only explicitly bound Pi runtimes through an authenticated Remote
 * Process transport. Runtime resources are staged into an isolated remote
 * directory and removed after the process exits; credential references never
 * cross this boundary.
 */
export class RemotePiProcessFactory implements PiManagedDurableStoreRegistry {
  readonly #registry: RemoteHostRegistry;
  readonly #localFactory: PiProcessFactory;
  readonly #authorityStore: RemotePiAuthorityStore;
  readonly #managedStoreScopes = new Map<string, RemoteManagedStoreScope>();
  readonly #managedStores = new Map<string, PiManagedDurableStore>();

  constructor(options: RemotePiProcessFactoryOptions) {
    this.#registry = options.registry;
    this.#localFactory = options.localFactory ?? spawnPiProcess;
    this.#authorityStore = new RemotePiAuthorityStore(options.authorityRoot);
  }

  readonly create: PiProcessFactory = async (spec) => {
    if (spec.remoteWorkspace === undefined) return this.#localFactory(spec);
    return this.#createRemote(spec);
  };

  async storeFor(input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly bindingOpaqueRef: string;
    readonly generation: number;
  }): Promise<PiManagedDurableStore | undefined> {
    const sessionId = exactBoundedText(input.sessionId, 512, "managed Session identity");
    const targetId = exactBoundedText(input.targetId, 512, "managed Target identity");
    exactBoundedText(input.bindingOpaqueRef, 4_096, "managed binding identity");
    nonnegativeSafeInteger(input.generation, "managed runtime generation");
    const key = managedStoreKey(sessionId, targetId);
    let scope = this.#managedStoreScopes.get(key);
    if (scope === undefined) {
      const candidates: RemoteManagedStoreScope[] = [];
      for (const host of this.#registry.list(targetId)) {
        const recoveryIdentity = remoteRecoveryIdentity(sessionId, targetId, host.id);
        const identity = stableIdentity(targetId, host.id, recoveryIdentity);
        const authority = await this.#authorityStore.read(identity, {
          targetId,
          hostId: host.id,
          recoveryIdentity
        });
        if (authority === undefined || authority.authority.trustedRunnerScriptSha256 === "0".repeat(64)) continue;
        candidates.push({ sessionId, targetId, hostId: host.id, recoveryIdentity, identity });
      }
      if (candidates.length === 0) return undefined;
      if (candidates.length !== 1) {
        throw new Error("Remote managed durable store identity is ambiguous across hosts.");
      }
      scope = candidates[0]!;
      this.#managedStoreScopes.set(key, scope);
    }
    const currentAuthority = await this.#authorityStore.read(scope.identity, scope);
    if (currentAuthority === undefined) return undefined;
    if (input.generation < currentAuthority.authority.runtimeGeneration) {
      throw new Error("Remote managed durable store crossed its runtime generation fence.");
    }
    let store = this.#managedStores.get(key);
    if (store === undefined) {
      store = new RemotePiManagedDurableStore({
        scope,
        registry: this.#registry,
        authorityStore: this.#authorityStore
      });
      this.#managedStores.set(key, store);
    }
    return store;
  }

  async validate(targetId: string, hostId: string, workspaceRoot: string, signal?: AbortSignal): Promise<void> {
    const { lease } = await this.#registry.transports(targetId, hostId, signal);
    const files = requireFiles(lease);
    requireProcesses(lease);
    const canonical = await files.realpath(workspaceRoot, signal);
    if (canonical !== workspaceRoot) throw new Error("Remote workspace root is not canonical.");
    const info = await files.stat(canonical, signal);
    if (info.kind !== "directory") throw new Error("Remote workspace root is not a directory.");
  }

  async #createRemote(spec: PiProcessSpec): Promise<PiProcessHandle> {
    const binding = spec.remoteWorkspace!;
    const targetId = requiredEnvironment(spec.env, "JOKO_PI_TARGET_ID");
    const { lease } = await this.#registry.transports(targetId, binding.hostId);
    const files = requireFiles(lease);
    const canonicalWorkspace = await files.realpath(binding.workspaceRoot);
    if (canonicalWorkspace !== binding.workspaceRoot) throw new Error("Remote workspace root is not canonical.");
    if ((await files.stat(canonicalWorkspace)).kind !== "directory") {
      throw new Error("Remote workspace root is not a directory.");
    }

    const home = await files.realpath(".");
    const spawnIdentity = exactDigestEnvironment(spec.env, "JOKO_PI_SPAWN_IDENTITY");
    const recoveryIdentity = exactDigestEnvironment(spec.env, "JOKO_PI_REMOTE_RECOVERY_IDENTITY");
    const runtimeGeneration = exactRuntimeGeneration(spec.env);
    const currentNativeAuthReservationToken = optionalNativeAuthReservationToken(
      spec.env[NATIVE_AUTH_RESERVATION_TOKEN_ENV]
    );
    const identity = stableIdentity(targetId, binding.hostId, recoveryIdentity);
    const authorityScope: RemoteAuthorityScope = { targetId, hostId: binding.hostId, recoveryIdentity };
    let existingAuthority = await this.#authorityStore.read(identity, authorityScope);
    if (existingAuthority?.deletion !== undefined) {
      // A verified deletion receipt proves that the previous owner/child
      // lineage is retired. A new product generation must start from a fresh
      // broker launch rather than presenting the retired recovery envelope.
      await this.#authorityStore.remove(identity);
      existingAuthority = undefined;
    }
    const managedRoot = remotePath.join(home, ".joko", "pi-broker");
    const remoteRuntime = remotePath.join(home, ".joko", "runtime", identity);
    const remoteSessions = remotePath.join(home, ".joko", "sessions", stableIdentity(targetId, binding.hostId));
    const localManagedRunRoot = spec.env["JOKO_PI_SUBAGENT_RUN_ROOT"];
    const remoteManagedRunRoot = localManagedRunRoot === undefined
      ? undefined
      : remotePath.join(home, ".joko", "subagent-runs", identity);
    await provisionRemoteBroker(files, managedRoot);
    await ensureRemotePrivateDirectory(files, remoteRuntime);
    await ensureRemotePrivateDirectory(files, remoteSessions);
    if (remoteManagedRunRoot !== undefined) await ensureRemotePrivateDirectory(files, remoteManagedRunRoot);
    if (localManagedRunRoot !== undefined) {
      const productSessionId = requiredEnvironment(spec.env, MANAGED_SUBAGENT_PRODUCT_SESSION_ENV);
      if (remoteRecoveryIdentity(productSessionId, targetId, binding.hostId) !== recoveryIdentity) {
        throw new Error("Remote managed durable store crossed its recovery identity fence.");
      }
      this.#managedStoreScopes.set(managedStoreKey(productSessionId, targetId), {
        sessionId: productSessionId,
        targetId,
        hostId: binding.hostId,
        recoveryIdentity,
        identity
      });
    }

    const localSessionRoot = requiredEnvironment(spec.env, "PI_CODING_AGENT_SESSION_DIR");
    const localControl = requiredEnvironment(spec.env, "JOKO_PI_CONTROL_FILE");
    const localRuntime = dirname(localControl);
    const pathMap = new Map<string, string>([
      [resolve(localRuntime), remoteRuntime],
      [resolve(localSessionRoot), remoteSessions],
      ...(localManagedRunRoot === undefined || remoteManagedRunRoot === undefined
        ? []
        : [[resolve(localManagedRunRoot), remoteManagedRunRoot] as const])
    ]);
    const stagingPlans: RemoteStagingPlan[] = [{ local: resolve(localRuntime), remote: remoteRuntime }];
    const snapshotCache = new Map<string, Promise<LocalAssetSnapshot>>();
    const snapshotAsset = (path: string): Promise<LocalAssetSnapshot> => {
      const normalized = resolve(path);
      const existing = snapshotCache.get(normalized);
      if (existing !== undefined) return existing;
      const pending = snapshotLocalCompatibilityAsset(normalized);
      snapshotCache.set(normalized, pending);
      return pending;
    };

    const rewrittenArgs = [...spec.args];
    const compatibilityAssets: RemoteCompatibilityAsset[] = [];
    let trustedRunnerScriptSha256: string | undefined;
    let recordedManagedSupport = false;
    let stagedManagedSupport = false;
    for (let index = 0; index < rewrittenArgs.length; index += 1) {
      const value = rewrittenArgs[index];
      if (value === undefined || !isAbsolute(value)) continue;
      const role = compatibilityAssetRole(spec.command, spec.args, index);
      const isSessionSelector = spec.args[index - 1] === "--session";
      const isSessionDirectory = spec.args[index - 1] === "--session-dir"
        && resolve(value) === resolve(localSessionRoot);
      let managedSupportDirectory: string | undefined;
      let managedSupportSnapshot: LocalAssetSnapshot | undefined;
      let assetSnapshot: LocalAssetSnapshot | undefined;
      if (
        spec.env["JOKO_PI_SUBAGENT_RUN_ROOT"] !== undefined &&
        basename(value) === "joko-managed-subagent.ts"
      ) {
        managedSupportDirectory = dirname(resolve(value));
        managedSupportSnapshot = await snapshotAsset(managedSupportDirectory);
        assetSnapshot = localAssetSubsnapshot(managedSupportSnapshot, basename(value));
        trustedRunnerScriptSha256 = localAssetSingleFileSha256(localAssetSubsnapshot(
          managedSupportSnapshot,
          MANAGED_SUBAGENT_RUNNER_FILE_NAME
        ));
        if (!recordedManagedSupport) {
          compatibilityAssets.push({
            role: "managed-extension-support",
            name: safeRemoteName(basename(managedSupportDirectory)),
            digest: managedSupportSnapshot.digest
          });
          recordedManagedSupport = true;
        }
      }
      if (role !== undefined) {
        assetSnapshot ??= await snapshotAsset(value);
        compatibilityAssets.push({
          role,
          name: safeRemoteName(basename(value)),
          digest: assetSnapshot.digest
        });
      } else if (!isSessionSelector && !isSessionDirectory && managedSupportDirectory === undefined) {
        assetSnapshot ??= await snapshotAsset(value);
        compatibilityAssets.push({
          role: `arg:${index}`,
          name: safeRemoteName(basename(value)),
          digest: assetSnapshot.digest
        });
      }
      const mapped = rewriteLocalPath(value, pathMap);
      if (mapped !== value) {
        if (managedSupportDirectory !== undefined && managedSupportSnapshot !== undefined) {
          const remoteSupportDirectory = rewriteLocalPath(managedSupportDirectory, pathMap);
          if (remoteSupportDirectory === managedSupportDirectory) {
            throw new Error("Remote Pi managed runner source escaped its staged runtime tree.");
          }
          if (!stagedManagedSupport) {
            stagingPlans.push({
              local: managedSupportDirectory,
              remote: remoteSupportDirectory,
              snapshot: managedSupportSnapshot,
              replaceDirectory: true
            });
            stagedManagedSupport = true;
          }
        } else if (assetSnapshot !== undefined || isSessionSelector) {
          assetSnapshot ??= await snapshotAsset(value);
          stagingPlans.push({ local: resolve(value), remote: mapped, snapshot: assetSnapshot });
        }
        rewrittenArgs[index] = mapped;
        continue;
      }
      if (managedSupportDirectory !== undefined) {
        throw new Error("Remote Pi managed runner source escaped its staged runtime tree.");
      }
      if (assetSnapshot === undefined) {
        assetSnapshot = await snapshotAsset(value);
      }
      const remoteAsset = remotePath.join(
        remoteRuntime,
        "assets",
        `${assetSnapshot.digest}-${safeRemoteName(basename(value))}`
      );
      stagingPlans.push({ local: resolve(value), remote: remoteAsset, snapshot: assetSnapshot });
      pathMap.set(resolve(value), remoteAsset);
      rewrittenArgs[index] = remoteAsset;
    }

    const localAgentHome = spec.env["PI_CODING_AGENT_DIR"];
    if (localAgentHome !== undefined) {
      const normalizedAgentHome = resolve(localAgentHome);
      const remoteAgentHome = rewriteLocalPath(normalizedAgentHome, pathMap);
      if (
        remoteAgentHome === normalizedAgentHome ||
        remoteAgentHome !== remoteRuntime && !remoteAgentHome.startsWith(`${remoteRuntime}/`)
      ) throw new Error("Remote Pi Agent Home escaped its staged runtime tree.");
      for (const name of ["models.json", "settings.json"] as const) {
        const local = resolve(normalizedAgentHome, name);
        if (dirname(local) !== normalizedAgentHome) {
          throw new Error("Remote Pi Agent Home settings path escaped its root.");
        }
        const snapshot = await snapshotAsset(local);
        compatibilityAssets.push({ role: `agent-home:${name}`, name, digest: snapshot.digest });
        stagingPlans.push({ local, remote: remotePath.join(remoteAgentHome, name), snapshot });
      }
    }

    let commandSnapshot: LocalAssetSnapshot | undefined;
    if (isAbsolute(spec.command) && !/^(?:node|electron)(?:\.exe)?$/iu.test(basename(spec.command))) {
      commandSnapshot = await snapshotAsset(spec.command);
      compatibilityAssets.push({
        role: "command",
        name: safeRemoteName(basename(spec.command)),
        digest: commandSnapshot.digest
      });
    }

    const remoteEnvironment = rewriteRemoteEnvironment(spec.env, pathMap);
    if (spec.env["JOKO_PI_SUBAGENT_RUN_ROOT"] !== undefined && trustedRunnerScriptSha256 === undefined) {
      throw new Error("Remote Pi managed runner source is unavailable.");
    }
    const trustedRunnerDigest = trustedRunnerScriptSha256 ?? "0".repeat(64);
    const command = remoteCommand(
      spec.command,
      rewrittenArgs,
      remoteRuntime,
      pathMap,
      stagingPlans,
      commandSnapshot
    );
    const launchHash = remotePiLaunchHash({
      command,
      args: rewrittenArgs,
      cwd: canonicalWorkspace,
      env: remoteEnvironment
    });
    const candidateProcessLaunchHash = remotePiProcessLaunchHash({
      command,
      args: rewrittenArgs,
      cwd: canonicalWorkspace,
      env: remoteEnvironment
    });
    const compatibilityHash = remotePiCompatibilityHash({
      command,
      args: rewrittenArgs,
      cwd: canonicalWorkspace,
      env: remoteEnvironment,
      remoteRuntime,
      assets: compatibilityAssets
    });
    if (existingAuthority === undefined) await stageRemoteRuntime(files, stagingPlans);
    const sourcePath = remotePath.join(managedRoot, `broker-${REMOTE_PI_BROKER_SOURCE_SHA256}.mjs`);
    const openAttachment = async (selectedLease: RemoteSshTransportLease): Promise<RemoteBridgeAttachment> => {
      const selectedFiles = requireFiles(selectedLease);
      await provisionRemoteBroker(selectedFiles, managedRoot);
      await ensureRemotePrivateDirectory(selectedFiles, remoteRuntime);
      await ensureRemotePrivateDirectory(selectedFiles, remoteSessions);
      if (remoteManagedRunRoot !== undefined) {
        await ensureRemotePrivateDirectory(selectedFiles, remoteManagedRunRoot);
      }
      const previous = await this.#authorityStore.read(identity, authorityScope);
      await refreshRuntimeFiles(
        selectedFiles,
        spec.env,
        pathMap,
        previous?.authority.runtimeGeneration
      );
      const bridgeOptions: OpenRemoteBrokerBridgeOptions = {
        lease: selectedLease,
        files: selectedFiles,
        home,
        managedRoot,
        sourcePath,
        identity,
        launchHash,
        candidateProcessLaunchHash,
        trustedRunnerScriptSha256: trustedRunnerDigest,
        compatibilityHash,
        targetId,
        hostId: binding.hostId,
        recoveryIdentity,
        spawnIdentity,
        runtimeGeneration,
        command,
        args: rewrittenArgs,
        cwd: canonicalWorkspace,
        env: remoteEnvironment,
        remoteRuntime,
        localDescriptor: spec.env["JOKO_PI_MCP_DESCRIPTOR_FILE"],
        localEnvironment: spec.env,
        pathMap,
        authorityStore: this.#authorityStore,
        ...(currentNativeAuthReservationToken === undefined ? {} : { currentNativeAuthReservationToken }),
        ...(previous === undefined ? {} : { previousAuthority: previous })
      };
      try {
        return await openRemoteBrokerBridge(bridgeOptions);
      } catch (error) {
        if (
          !(error instanceof RemoteAuthorityRejectedError) ||
          error.authorityVerified !== true || previous === undefined
        ) throw error;
        if (error.reason === "launch_mismatch") {
          await requestRemoteBrokerKill({
            processes: requireProcesses(selectedLease),
            sourcePath,
            managedRoot,
            identity,
            signal: "SIGKILL",
            authority: previous.authority
          });
        } else if (error.reason !== "child_absent") throw error;
        await this.#authorityStore.remove(identity);
        await stageRemoteRuntime(selectedFiles, stagingPlans);
        await refreshRuntimeFiles(selectedFiles, spec.env, pathMap);
        const { previousAuthority: _previousAuthority, ...freshBridgeOptions } = bridgeOptions;
        return openRemoteBrokerBridge(freshBridgeOptions);
      }
    };
    const initialAttachment = await openAttachment(lease);
    return new MappedRemotePiProcess({
      initialAttachment,
      reattach: async () => {
        const next = await this.#registry.transports(targetId, binding.hostId);
        return openAttachment(next.lease);
      },
      localSessionRoot: resolve(localSessionRoot),
      localRuntime: resolve(localRuntime),
      remoteSessionRoot: remoteSessions,
      remoteRuntime,
      pathMap
    });
  }
}

class RemotePiManagedDurableStore implements PiManagedDurableStore {
  readonly #scope: RemoteManagedStoreScope;
  readonly #registry: RemoteHostRegistry;
  readonly #authorityStore: RemotePiAuthorityStore;

  constructor(options: {
    readonly scope: RemoteManagedStoreScope;
    readonly registry: RemoteHostRegistry;
    readonly authorityStore: RemotePiAuthorityStore;
  }) {
    this.#scope = options.scope;
    this.#registry = options.registry;
    this.#authorityStore = options.authorityStore;
  }

  async scan(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly afterRevision?: string;
    readonly limitBytes: number;
  }): Promise<{
    readonly revision: string;
    readonly unchanged: boolean;
    readonly retryAfterMs: number;
    readonly runs: readonly PiManagedDurableRunSnapshot[];
  }> {
    this.#assertSession(input.sessionId, input.sessionKey);
    if (!Number.isSafeInteger(input.limitBytes) || input.limitBytes < 1 || input.limitBytes > 1024 * 1024) {
      throw new Error("Remote managed durable store scan limit is invalid.");
    }
    const response = await this.#request({
      operation: "scan",
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      limitBytes: input.limitBytes,
      ...(input.afterRevision === undefined ? {} : {
        afterRevision: exactDigest(input.afterRevision, "managed store revision")
      })
    });
    assertExactKeys(response, [
      "ok", "authorityVerified", "revision", "unchanged", "retryAfterMs", "runs"
    ]);
    const unchanged = response["unchanged"];
    const retryAfterMs = positiveSafeInteger(response["retryAfterMs"], "managed store retry delay");
    if (
      response["ok"] !== true || response["authorityVerified"] !== true ||
      typeof unchanged !== "boolean" || retryAfterMs < 100 || retryAfterMs > 60_000 ||
      !Array.isArray(response["runs"]) || response["runs"].length > 256 ||
      unchanged && response["runs"].length !== 0 ||
      unchanged && input.afterRevision === undefined
    ) {
      throw new Error("Remote managed durable store scan response failed its schema fence.");
    }
    const revision = exactDigest(response["revision"], "managed store revision");
    if (unchanged && revision !== input.afterRevision) {
      throw new Error("Remote managed durable store unchanged response crossed its revision fence.");
    }
    return {
      revision,
      unchanged,
      retryAfterMs,
      runs: response["runs"].map((value) => parseRemoteManagedRunSnapshot(value))
    };
  }

  async readTail(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly runnerInstanceId: string;
    readonly artifactRevision: string;
    readonly pathKind: "transcript" | "result";
    readonly offset: number;
    readonly maxBytes: number;
  }): Promise<{
    readonly artifactRevision: string;
    readonly offset: number;
    readonly nextOffset: number;
    readonly eof: boolean;
    readonly content: Uint8Array;
  }> {
    this.#assertSession(input.sessionId);
    const runId = exactUuid(input.runId, "managed run identity");
    const runnerInstanceId = exactUuid(input.runnerInstanceId, "managed runner identity");
    const artifactRevision = exactDigest(input.artifactRevision, "managed artifact revision");
    const offset = nonnegativeSafeInteger(input.offset, "managed tail offset");
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 256 * 1024) {
      throw new Error("Remote managed durable store tail limit is invalid.");
    }
    if (input.pathKind !== "transcript" && input.pathKind !== "result") {
      throw new Error("Remote managed durable store tail kind is invalid.");
    }
    const response = await this.#request({
      operation: "read-tail",
      sessionId: input.sessionId,
      runId,
      runnerInstanceId,
      artifactRevision,
      pathKind: input.pathKind,
      offset,
      maxBytes: input.maxBytes
    });
    assertExactKeys(response, [
      "ok", "authorityVerified", "artifactRevision", "offset", "nextOffset", "eof", "content"
    ]);
    const acceptedOffset = nonnegativeSafeInteger(response["offset"], "managed tail response offset");
    const nextOffset = nonnegativeSafeInteger(response["nextOffset"], "managed tail next offset");
    if (
      response["ok"] !== true || response["authorityVerified"] !== true ||
      response["eof"] !== true && response["eof"] !== false ||
      acceptedOffset !== offset || nextOffset < acceptedOffset || typeof response["content"] !== "string"
    ) throw new Error("Remote managed durable store tail response failed its schema fence.");
    const content = decodeExactBase64(response["content"], input.maxBytes);
    if (nextOffset !== acceptedOffset + content.byteLength) {
      throw new Error("Remote managed durable store tail response crossed its byte cursor fence.");
    }
    const returnedRevision = exactDigest(response["artifactRevision"], "managed tail artifact revision");
    if (returnedRevision !== artifactRevision) {
      throw new Error("Remote managed durable store tail crossed its artifact snapshot fence.");
    }
    return {
      artifactRevision: returnedRevision,
      offset: acceptedOffset,
      nextOffset,
      eof: response["eof"],
      content
    };
  }

  async writeControl(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly runnerInstanceId: string;
    readonly launchToken: string;
    readonly runnerScriptSha256: string;
    readonly expectedControlRevision: string;
    readonly kind: "control" | "approval";
    readonly value: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly controlRevision: string; readonly receipt: string }> {
    this.#assertSession(input.sessionId);
    if (!isPlainRecord(input.value) || Buffer.byteLength(JSON.stringify(input.value), "utf8") > 64 * 1024) {
      throw new Error("Remote managed durable store control value is invalid.");
    }
    if (input.kind !== "control" && input.kind !== "approval") {
      throw new Error("Remote managed durable store control kind is invalid.");
    }
    const response = await this.#request({
      operation: "write-control",
      sessionId: input.sessionId,
      runId: exactUuid(input.runId, "managed run identity"),
      runnerInstanceId: exactUuid(input.runnerInstanceId, "managed runner identity"),
      launchToken: exactUuid(input.launchToken, "managed launch token"),
      runnerScriptSha256: exactDigest(input.runnerScriptSha256, "managed runner script hash"),
      expectedControlRevision: exactDigest(input.expectedControlRevision, "managed control revision"),
      kind: input.kind,
      value: input.value
    });
    assertExactKeys(response, ["ok", "authorityVerified", "controlRevision", "receipt"]);
    if (response["ok"] !== true || response["authorityVerified"] !== true) {
      throw new Error("Remote managed durable store control was rejected.");
    }
    return {
      controlRevision: exactDigest(response["controlRevision"], "managed control revision"),
      receipt: exactDigest(response["receipt"], "managed control receipt")
    };
  }

  async stopAndRemoveSession(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly timeoutMs: number;
  }): Promise<
    | { readonly terminalRunIds: readonly string[]; readonly removed: false }
    | {
      readonly terminalRunIds: readonly string[];
      readonly removed: true;
      readonly deletionReceipt: string;
    }
  > {
    this.#assertSession(input.sessionId, input.sessionKey);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 10_000) {
      throw new Error("Remote managed durable store stop timeout is invalid.");
    }
    const retained = await this.#authorityStore.read(this.#scope.identity, this.#scope);
    if (retained?.deletion !== undefined) {
      return {
        terminalRunIds: [],
        removed: true,
        deletionReceipt: retained.deletion.receipt
      };
    }
    const response = await this.#request({
      operation: "stop-remove-session",
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      timeoutMs: input.timeoutMs
    });
    assertExactKeys(response, [
      "ok", "authorityVerified", "terminalRunIds", "removed",
      ...(response["deletionReceipt"] === undefined ? [] : ["deletionReceipt"])
    ]);
    if (
      response["ok"] !== true || response["authorityVerified"] !== true ||
      !Array.isArray(response["terminalRunIds"]) ||
      response["terminalRunIds"].length > 256 || typeof response["removed"] !== "boolean"
    ) throw new Error("Remote managed durable store stop response failed its schema fence.");
    const terminalRunIds = response["terminalRunIds"]
      .map((value) => exactUuid(value, "terminal managed run identity"));
    if (response["removed"] === false) {
      if (response["deletionReceipt"] !== undefined) {
        throw new Error("Remote managed durable store returned a premature deletion receipt.");
      }
      return { terminalRunIds, removed: false };
    }
    return {
      terminalRunIds,
      removed: true,
      deletionReceipt: exactDigest(response["deletionReceipt"], "managed deletion receipt")
    };
  }

  async finalizeDeletion(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly deletionReceipt: string;
  }): Promise<void> {
    this.#assertSession(input.sessionId, input.sessionKey);
    const deletionReceipt = exactDigest(input.deletionReceipt, "managed deletion receipt");
    const retained = await this.#authorityStore.read(this.#scope.identity, this.#scope);
    if (retained?.deletion !== undefined && retained.deletion.receipt !== deletionReceipt) {
      throw new Error("Remote managed durable store deletion receipt crossed its local fence.");
    }
    const response = await this.#request({
      operation: "finalize-deletion",
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      deletionReceipt
    });
    assertExactKeys(response, [
      "ok", "authorityVerified", "finalized", "deletionReceipt"
    ]);
    if (
      response["ok"] !== true || response["authorityVerified"] !== true ||
      response["finalized"] !== true ||
      exactDigest(response["deletionReceipt"], "managed finalized deletion receipt") !== deletionReceipt
    ) throw new Error("Remote managed durable store deletion finalization was rejected.");
    await this.#authorityStore.markDeletion(this.#scope.identity, deletionReceipt);
  }

  async dispose(): Promise<void> {
    // Each operation owns a short-lived SSH control request. No runner or
    // broker authority is attached to this service-side view.
  }

  #assertSession(sessionId: string, sessionKey?: string): void {
    if (sessionId !== this.#scope.sessionId) {
      throw new Error("Remote managed durable store crossed its Session identity fence.");
    }
    if (sessionKey !== undefined && sessionKey !== managedSessionKey(sessionId)) {
      throw new Error("Remote managed durable store Session key is invalid.");
    }
  }

  async #request(operation: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { lease } = await this.#registry.transports(this.#scope.targetId, this.#scope.hostId);
    const files = requireFiles(lease);
    const processes = requireProcesses(lease);
    const home = await files.realpath(".");
    const managedRoot = remotePath.join(home, ".joko", "pi-broker");
    await provisionRemoteBroker(files, managedRoot);
    const authority = await this.#authorityStore.read(this.#scope.identity, this.#scope);
    if (authority === undefined) {
      throw new Error("Remote managed durable store authority is unavailable.");
    }
    if (authority.deletion !== undefined && operation["operation"] !== "finalize-deletion") {
      throw new Error("Remote managed durable store is finalized for deletion.");
    }
    const sourcePath = remotePath.join(managedRoot, `broker-${REMOTE_PI_BROKER_SOURCE_SHA256}.mjs`);
    const request = await processes.open({
      executable: "node",
      args: [sourcePath, "store", managedRoot],
      cwd: home,
      env: { JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 }
    });
    const body = Buffer.from(`${JSON.stringify({
      action: "managed-store",
      version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
      format: 1,
      identity: this.#scope.identity,
      authority: authority.authority,
      ...operation
    })}\n`, "utf8");
    if (body.byteLength > MAXIMUM_BROKER_BOOTSTRAP_BYTES) {
      request.kill("SIGKILL");
      throw new Error("Remote managed durable store request exceeded its safety limit.");
    }
    const exitPromise = waitForRemoteProcessExit(request, BROKER_KILL_TIMEOUT_MS);
    const outputPromise = readBoundedRemoteControlOutput(request, BROKER_KILL_TIMEOUT_MS);
    request.stderr.resume();
    request.stdin.end(body);
    const [exit, output] = await Promise.all([exitPromise, outputPromise]);
    if (exit.code !== 0) throw new Error("Remote managed durable store control request was rejected.");
    let value: unknown;
    try {
      value = JSON.parse(output.toString("utf8")) as unknown;
    } catch {
      throw new Error("Remote managed durable store response is malformed.");
    }
    if (!isPlainRecord(value)) throw new Error("Remote managed durable store response failed its schema fence.");
    return value;
  }
}

interface RemoteBrokerBootstrap {
  readonly action: "ensure";
  readonly version: number;
  readonly identity: string;
  readonly launchHash: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly currentNativeAuthReservationToken?: string;
  readonly runtimeRoot: string;
  readonly outputCursor?: number;
  readonly authority?: RemoteAuthorityRequest;
  readonly relay?: {
    readonly port: number;
    readonly descriptorPath: string;
    readonly descriptor: Readonly<Record<string, unknown>>;
  };
}

interface RemoteBridgeAttachment {
  readonly process: RemoteProcessHandle;
  readonly processes: RemoteProcessTransportPort;
  readonly files: RemoteFileTransportPort;
  readonly watchers: readonly FSWatcher[];
  readonly reverseForward?: RemoteReverseForwardHandle;
  readonly brokerSourcePath: string;
  readonly brokerRoot: string;
  readonly identity: string;
  readonly terminalFence: string;
  readonly authority?: RemoteAuthorityEnvelope;
  readonly state?: RemoteAuthorityState;
  readonly persistOutputCursor?: (sequence: number) => Promise<void>;
}

interface OpenRemoteBrokerBridgeOptions {
  readonly lease: RemoteSshTransportLease;
  readonly files: RemoteFileTransportPort;
  readonly home: string;
  readonly managedRoot: string;
  readonly sourcePath: string;
  readonly identity: string;
  readonly launchHash: string;
  readonly candidateProcessLaunchHash: string;
  readonly trustedRunnerScriptSha256: string;
  readonly compatibilityHash: string;
  readonly targetId: string;
  readonly hostId: string;
  readonly recoveryIdentity: string;
  readonly spawnIdentity: string;
  readonly runtimeGeneration: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly remoteRuntime: string;
  readonly localDescriptor?: string;
  readonly localEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly pathMap: ReadonlyMap<string, string>;
  readonly authorityStore: RemotePiAuthorityStore;
  readonly currentNativeAuthReservationToken?: string;
  readonly previousAuthority?: RemoteAuthorityRecord;
}

async function openRemoteBrokerBridge(options: OpenRemoteBrokerBridgeOptions): Promise<RemoteBridgeAttachment> {
  const processes = requireProcesses(options.lease);
  let reverseForward: RemoteReverseForwardHandle | undefined;
  let remoteProcess: RemoteProcessHandle | undefined;
  let relay: RemoteBrokerBootstrap["relay"];
  try {
    if (options.localDescriptor !== undefined) {
      if (options.lease.forwarding === undefined || options.lease.capabilities.tcpForwarding !== true) {
        throw new Error("Remote Pi requires loopback TCP forwarding for its managed tool bridge.");
      }
      const descriptor = JSON.parse(await readFile(options.localDescriptor, "utf8")) as Record<string, unknown>;
      const endpoint = new URL(String(descriptor["endpoint"] ?? ""));
      if (!isLoopback(endpoint.hostname) || (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")) {
        throw new Error("Managed tool bridge must use a service-node loopback endpoint.");
      }
      const localPort = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
      reverseForward = await options.lease.forwarding.listen({
        localDestinationHost: normalizeLoopback(endpoint.hostname),
        localDestinationPort: localPort
      });
      endpoint.hostname = reverseForward.remoteHost === "::1" ? "[::1]" : reverseForward.remoteHost;
      endpoint.port = String(reverseForward.remotePort);
      descriptor["endpoint"] = endpoint.toString();
      const nativeAuthLease = descriptor["nativeAuthLease"];
      if (nativeAuthLease !== undefined) {
        if (nativeAuthLease === null || typeof nativeAuthLease !== "object" || Array.isArray(nativeAuthLease)) {
          throw new Error("Managed native auth lease descriptor is invalid.");
        }
        const nativeEndpoint = new URL(String((nativeAuthLease as Record<string, unknown>)["endpoint"] ?? ""));
        if (
          nativeEndpoint.protocol !== endpoint.protocol || !isLoopback(nativeEndpoint.hostname)
          || Number(nativeEndpoint.port || (nativeEndpoint.protocol === "https:" ? 443 : 80)) !== localPort
        ) throw new Error("Managed native auth lease must share the service-node loopback bridge.");
        nativeEndpoint.hostname = reverseForward.remoteHost === "::1" ? "[::1]" : reverseForward.remoteHost;
        nativeEndpoint.port = String(reverseForward.remotePort);
        (nativeAuthLease as Record<string, unknown>)["endpoint"] = nativeEndpoint.toString();
      }
      relay = {
        port: reverseForward.remotePort,
        descriptorPath: rewriteLocalPath(options.localDescriptor, options.pathMap),
        descriptor
      };
    }

    const terminalFence = randomUUID();
    remoteProcess = await processes.open({
      executable: "node",
      args: [
        options.sourcePath,
        "bridge",
        options.managedRoot,
        options.identity,
        options.launchHash,
        terminalFence
      ],
      cwd: options.home,
      env: { JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 }
    });
    const bootstrap: RemoteBrokerBootstrap = {
      action: "ensure",
      version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
      identity: options.identity,
      launchHash: options.launchHash,
      executable: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ...(options.currentNativeAuthReservationToken === undefined ? {} : {
        currentNativeAuthReservationToken: options.currentNativeAuthReservationToken
      }),
      runtimeRoot: options.remoteRuntime,
      outputCursor: options.previousAuthority?.outputCursor ?? 0,
      authority: {
        format: 1,
        targetId: options.targetId,
        hostId: options.hostId,
        recoveryIdentity: options.recoveryIdentity,
        spawnIdentity: options.spawnIdentity,
        runtimeGeneration: options.runtimeGeneration,
        compatibilityHash: options.compatibilityHash,
        candidateProcessLaunchHash: options.candidateProcessLaunchHash,
        trustedRunnerScriptSha256: options.trustedRunnerScriptSha256,
        ...(options.previousAuthority === undefined ? {} : {
          recovery: options.previousAuthority.authority
        })
      },
      ...(relay === undefined ? {} : { relay })
    };
    const bootstrapLine = Buffer.from(`${JSON.stringify(bootstrap)}\n`, "utf8");
    if (bootstrapLine.byteLength > MAXIMUM_BROKER_BOOTSTRAP_BYTES) {
      remoteProcess.kill("SIGKILL");
      throw new Error("Remote Pi launch configuration exceeded its bounded broker envelope.");
    }
    remoteProcess.stdin.write(bootstrapLine);
    const control = await readRemoteAuthorityControl(remoteProcess.stdout);
    if (!control.ok) {
      throw new RemoteAuthorityRejectedError(control.authorityVerified, control.reason);
    }
    const authority = control.authority;
    const state = control.state;
    assertAuthorityMatchesRequest(authority, options);
    const authorityDigest = createHash("sha256").update(JSON.stringify(authority)).digest("hex");
    if (state.authorityDigest !== authorityDigest) {
      throw new Error("Remote Pi authority control did not bind its returned envelope.");
    }
    await options.authorityStore.write(options.identity, {
      format: 1,
      authority,
      outputCursor: state.outputAcknowledged,
      updatedAt: Date.now()
    });
    if (state.authorityCommitRequired) {
      const commit = Buffer.from(JSON.stringify({
        format: 1,
        identity: authority.identity,
        epoch: authority.epoch,
        authorityDigest,
        attestation: authority.attestation
      }), "utf8");
      await writeStreamChunk(
        remoteProcess.stdin,
        encodeRemoteControlFrame(REMOTE_FRAME_AUTHORITY_COMMIT, commit)
      );
      const acknowledgement = parseRemoteAuthorityCommitAcknowledgement(
        await readRemoteControlFrame(remoteProcess.stdout, REMOTE_FRAME_AUTHORITY_COMMIT_ACK)
      );
      if (
        acknowledgement.epoch !== authority.epoch ||
        acknowledgement.authorityDigest !== authorityDigest
      ) throw new Error("Remote Pi authority commit acknowledgement crossed its envelope fence.");
    }
    return {
      process: remoteProcess,
      processes,
      files: options.files,
      watchers: watchRuntimeFiles(
        options.files,
        options.localEnvironment,
        options.pathMap,
        authority.runtimeGeneration
      ),
      ...(reverseForward === undefined ? {} : { reverseForward }),
      brokerSourcePath: options.sourcePath,
      brokerRoot: options.managedRoot,
      identity: options.identity,
      terminalFence,
      authority,
      state,
      persistOutputCursor: (sequence: number) => options.authorityStore.updateOutputCursor(
        options.identity,
        sequence
      )
    };
  } catch (error) {
    try {
      remoteProcess?.kill("SIGKILL");
    } catch {
      // The bridge may already have closed after returning a control rejection.
    }
    await reverseForward?.close().catch(() => undefined);
    throw error;
  }
}

class RemoteAuthorityRejectedError extends Error {
  constructor(
    readonly authorityVerified: boolean,
    readonly reason: string
  ) {
    super(`Remote Pi recovery authority was rejected (${reason}).`);
    this.name = "RemoteAuthorityRejectedError";
  }
}

async function readRemoteAuthorityControl(stream: Readable): Promise<RemoteAuthorityControl> {
  return parseRemoteAuthorityControl(await readRemoteControlFrame(stream, REMOTE_FRAME_AUTHORITY));
}

async function readRemoteControlFrame(stream: Readable, expectedType: number): Promise<Buffer> {
  return new Promise<Buffer>((resolveControl, rejectControl) => {
    let pending = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Remote Pi authority handshake timed out.")), AUTHORITY_CONTROL_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) rejectControl(error);
      else resolveControl(value!);
    };
    const onEnd = (): void => finish(new Error("Remote Pi authority handshake ended before its control frame."));
    const onError = (): void => finish(new Error("Remote Pi authority handshake stream failed."));
    const onData = (chunk: Buffer | string): void => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
      if (pending.byteLength > MAXIMUM_AUTHORITY_BYTES + MAXIMUM_REMOTE_FRAME_BYTES + 10) {
        finish(new Error("Remote Pi authority control exceeded its safety limit."));
        return;
      }
      if (pending.byteLength < 5) return;
      const type = pending.readUInt8(0);
      const length = pending.readUInt32BE(1);
      if (type !== expectedType || length > MAXIMUM_AUTHORITY_BYTES) {
        finish(new Error("Remote Pi authority control frame is invalid."));
        return;
      }
      if (pending.byteLength < length + 5) return;
      const body = pending.subarray(5, length + 5);
      const remainder = pending.subarray(length + 5);
      stream.pause();
      cleanup();
      if (remainder.byteLength > 0) stream.unshift(remainder);
      finish(undefined, body);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume();
  });
}

function parseRemoteAuthorityControl(body: Buffer): RemoteAuthorityControl {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("Remote Pi authority control is malformed.");
  }
  if (!isPlainRecord(value) || typeof value["ok"] !== "boolean") {
    throw new Error("Remote Pi authority control failed its schema fence.");
  }
  if (value["ok"] === false) {
    assertExactKeys(value, ["ok", "recoveryRejected", "authorityVerified", "reason"]);
    if (
      value["recoveryRejected"] !== true || typeof value["authorityVerified"] !== "boolean" ||
      typeof value["reason"] !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value["reason"])
    ) throw new Error("Remote Pi authority rejection failed its schema fence.");
    return {
      ok: false,
      recoveryRejected: true,
      authorityVerified: value["authorityVerified"],
      reason: value["reason"]
    };
  }
  assertExactKeys(value, ["ok", "authority", "state"]);
  return {
    ok: true,
    authority: parseRemoteAuthorityEnvelope(value["authority"]),
    state: parseRemoteAuthorityState(value["state"])
  };
}

function parseRemoteAuthorityState(value: unknown): RemoteAuthorityState {
  if (!isPlainRecord(value)) throw new Error("Remote Pi authority state failed its schema fence.");
  assertExactKeys(value, [
    "inputAcknowledged",
    "outputAcknowledged",
    "outputSequence",
    "authorityCommitRequired",
    "authorityDigest",
    ...(value["recoveryOutputHighWater"] === undefined ? [] : ["recoveryOutputHighWater"])
  ]);
  const inputAcknowledged = safeSequence(value["inputAcknowledged"]);
  const outputAcknowledged = safeSequence(value["outputAcknowledged"]);
  const outputSequence = safeSequence(value["outputSequence"]);
  if (typeof value["authorityCommitRequired"] !== "boolean") {
    throw new Error("Remote Pi authority commit requirement failed its schema fence.");
  }
  const authorityCommitRequired = value["authorityCommitRequired"];
  const authorityDigest = exactDigest(value["authorityDigest"], "control authority digest");
  const recoveryOutputHighWater = value["recoveryOutputHighWater"] === undefined
    ? undefined
    : safeSequence(value["recoveryOutputHighWater"]);
  if (
    outputAcknowledged > outputSequence ||
    (recoveryOutputHighWater !== undefined && (
      recoveryOutputHighWater < outputAcknowledged || recoveryOutputHighWater > outputSequence
    ))
  ) throw new Error("Remote Pi authority state crossed its output fence.");
  return {
    inputAcknowledged,
    outputAcknowledged,
    outputSequence,
    authorityCommitRequired,
    authorityDigest,
    ...(recoveryOutputHighWater === undefined ? {} : { recoveryOutputHighWater })
  };
}

function parseRemoteAuthorityCommitAcknowledgement(body: Buffer): RemoteAuthorityCommitAcknowledgement {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("Remote Pi authority commit acknowledgement is malformed.");
  }
  if (!isPlainRecord(value)) {
    throw new Error("Remote Pi authority commit acknowledgement failed its schema fence.");
  }
  assertExactKeys(value, ["ok", "epoch", "authorityDigest"]);
  if (value["ok"] !== true) {
    throw new Error("Remote Pi authority commit acknowledgement was rejected.");
  }
  return {
    ok: true,
    epoch: positiveSafeInteger(value["epoch"], "committed authority epoch"),
    authorityDigest: exactDigest(value["authorityDigest"], "committed authority digest")
  };
}

function parseRemoteAuthorityEnvelope(value: unknown): RemoteAuthorityEnvelope {
  if (!isPlainRecord(value)) throw new Error("Remote Pi authority envelope failed its schema fence.");
  assertExactKeys(value, [
    "format", "targetId", "hostId", "recoveryIdentity", "spawnIdentity", "runtimeGeneration",
    "compatibilityHash", "childProcessLaunchHash", "trustedRunnerScriptSha256", "identity", "launchHash", "pid",
    "processStartIdentity", "startedAt", "epoch", "issuedAt", "attestation"
  ]);
  if (value["format"] !== 1) throw new Error("Remote Pi authority envelope format is unsupported.");
  const issuedAt = positiveSafeInteger(value["issuedAt"], "issued time");
  const startedAt = positiveSafeInteger(value["startedAt"], "start time");
  const attestation = exactBoundedText(value["attestation"], 128, "attestation");
  if (!/^[a-f0-9]{64}$/u.test(attestation)) {
    throw new Error("Remote Pi authority attestation is invalid.");
  }
  return {
    format: 1,
    targetId: exactBoundedText(value["targetId"], 512, "target identity"),
    hostId: exactBoundedText(value["hostId"], 512, "host identity"),
    recoveryIdentity: exactDigest(value["recoveryIdentity"], "recovery identity"),
    spawnIdentity: exactDigest(value["spawnIdentity"], "spawn identity"),
    runtimeGeneration: nonnegativeSafeInteger(value["runtimeGeneration"], "runtime generation"),
    compatibilityHash: exactDigest(value["compatibilityHash"], "compatibility hash"),
    childProcessLaunchHash: exactDigest(value["childProcessLaunchHash"], "child process launch hash"),
    trustedRunnerScriptSha256: exactDigest(value["trustedRunnerScriptSha256"], "trusted runner script hash"),
    identity: exactShortIdentity(value["identity"]),
    launchHash: exactDigest(value["launchHash"], "launch hash"),
    pid: positiveSafeInteger(value["pid"], "process id"),
    processStartIdentity: exactDigest(value["processStartIdentity"], "process start identity"),
    startedAt,
    epoch: positiveSafeInteger(value["epoch"], "authority epoch"),
    issuedAt,
    attestation
  };
}

function assertAuthorityMatchesRequest(
  authority: RemoteAuthorityEnvelope,
  options: OpenRemoteBrokerBridgeOptions
): void {
  if (
    authority.targetId !== options.targetId || authority.hostId !== options.hostId ||
    authority.recoveryIdentity !== options.recoveryIdentity || authority.identity !== options.identity ||
    authority.spawnIdentity !== options.spawnIdentity || authority.runtimeGeneration !== options.runtimeGeneration ||
    authority.compatibilityHash !== options.compatibilityHash ||
    authority.trustedRunnerScriptSha256 !== options.trustedRunnerScriptSha256
  ) throw new Error("Remote Pi authority response crossed its requested identity scope.");
  const previous = options.previousAuthority?.authority;
  if (previous === undefined) {
    if (authority.childProcessLaunchHash !== options.candidateProcessLaunchHash) {
      throw new Error("Remote Pi authority response did not attest the spawned child launch.");
    }
    return;
  }
  if (
    authority.launchHash !== previous.launchHash || authority.pid !== previous.pid ||
    authority.processStartIdentity !== previous.processStartIdentity || authority.startedAt !== previous.startedAt ||
    authority.childProcessLaunchHash !== previous.childProcessLaunchHash ||
    authority.trustedRunnerScriptSha256 !== previous.trustedRunnerScriptSha256
  ) throw new Error("Remote Pi recovery changed the attested child identity.");
  if (options.runtimeGeneration === previous.runtimeGeneration) {
    if (authority.epoch !== previous.epoch) {
      throw new Error("Remote Pi idempotent attachment changed its authority epoch.");
    }
  } else if (
    options.runtimeGeneration !== previous.runtimeGeneration + 1 || authority.epoch !== previous.epoch + 1
  ) {
    throw new Error("Remote Pi recovery crossed its generation or authority epoch fence.");
  }
}

interface RemoteBrokerKillOptions {
  readonly processes: RemoteProcessTransportPort;
  readonly sourcePath: string;
  readonly managedRoot: string;
  readonly identity: string;
  readonly signal: "SIGKILL" | "SIGTERM";
  readonly authority: RemoteAuthorityEnvelope;
}

async function requestRemoteBrokerKill(options: RemoteBrokerKillOptions): Promise<void> {
  const request = await options.processes.open({
    executable: "node",
    args: [options.sourcePath, "kill", options.managedRoot],
    cwd: remotePath.dirname(options.managedRoot),
    env: { JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 }
  });
  const body = Buffer.from(`${JSON.stringify({
    action: "kill",
    version: REMOTE_PI_BROKER_PROTOCOL_VERSION,
    identity: options.identity,
    signal: options.signal,
    authority: options.authority
  })}\n`, "utf8");
  if (body.byteLength > MAXIMUM_AUTHORITY_BYTES) {
    request.kill("SIGKILL");
    throw new Error("Remote Pi broker kill authority exceeded its safety limit.");
  }
  request.stdin.end(body);
  request.stdout.resume();
  request.stderr.resume();
  const exit = await waitForRemoteProcessExit(request, BROKER_KILL_TIMEOUT_MS);
  if (exit.code !== 0) throw new Error("Remote Pi broker did not confirm the authority-fenced kill.");
}

async function waitForRemoteProcessExit(
  processHandle: RemoteProcessHandle,
  timeoutMs: number
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (processHandle.exitCode !== null) return { code: processHandle.exitCode, signal: processHandle.signalCode };
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup();
      try { processHandle.kill("SIGKILL"); } catch { /* The control process is already unavailable. */ }
      rejectExit(new Error("Remote Pi broker control request timed out."));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = (): void => {
      cleanup();
      rejectExit(new Error("Remote Pi broker control request failed."));
    };
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
  });
}

async function readBoundedRemoteControlOutput(
  processHandle: RemoteProcessHandle,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise<Buffer>((resolveOutput, rejectOutput) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      try { processHandle.kill("SIGKILL"); } catch { /* The request already closed. */ }
      finish(new Error("Remote managed durable store response timed out."));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      processHandle.stdout.off("data", onData);
      processHandle.stdout.off("end", onEnd);
      processHandle.stdout.off("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) rejectOutput(error);
      else resolveOutput(Buffer.concat(chunks, bytes));
    };
    const onData = (chunk: Buffer | string): void => {
      const accepted = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += accepted.byteLength;
      if (bytes > MAXIMUM_BROKER_BOOTSTRAP_BYTES) {
        try { processHandle.kill("SIGKILL"); } catch { /* The request already closed. */ }
        finish(new Error("Remote managed durable store response exceeded its safety limit."));
        return;
      }
      chunks.push(accepted);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new Error("Remote managed durable store response stream failed."));
    processHandle.stdout.on("data", onData);
    processHandle.stdout.once("end", onEnd);
    processHandle.stdout.once("error", onError);
  });
}

class RemotePiAuthorityStore {
  readonly #root: string;
  readonly #ready: Promise<void>;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(root: string) {
    const normalized = resolve(root);
    if (!isAbsolute(root) || normalized !== root) {
      throw new Error("Remote Pi authority root must be a normalized absolute path.");
    }
    this.#root = normalized;
    this.#ready = this.#initialize();
  }

  async read(identity: string, scope: RemoteAuthorityScope): Promise<RemoteAuthorityRecord | undefined> {
    return this.#exclusive(identity, async () => {
      const record = await this.#readUnlocked(identity);
      if (record === undefined) return undefined;
      if (
        record.deletion !== undefined && Date.now() >= record.deletion.finalizedAt &&
        Date.now() - record.deletion.finalizedAt > DELETION_TOMBSTONE_RETENTION_MS
      ) {
        await this.#removeUnlocked(identity);
        return undefined;
      }
      if (
        record.authority.targetId !== scope.targetId || record.authority.hostId !== scope.hostId ||
        record.authority.recoveryIdentity !== scope.recoveryIdentity || record.authority.identity !== identity
      ) throw new Error("Remote Pi authority metadata crossed its local identity scope.");
      return record;
    });
  }

  async write(identity: string, record: RemoteAuthorityRecord): Promise<void> {
    await this.#exclusive(identity, async () => this.#writeUnlocked(identity, record));
  }

  async updateOutputCursor(identity: string, outputCursor: number): Promise<void> {
    await this.#exclusive(identity, async () => {
      const current = await this.#readUnlocked(identity);
      if (current === undefined) throw new Error("Remote Pi authority metadata disappeared while acknowledging output.");
      if (current.deletion !== undefined) {
        throw new Error("Remote Pi authority output cursor cannot update a finalized deletion.");
      }
      if (outputCursor < current.outputCursor) {
        throw new Error("Remote Pi authority output cursor moved backwards.");
      }
      if (outputCursor === current.outputCursor) return;
      await this.#writeUnlocked(identity, { ...current, outputCursor, updatedAt: Date.now() });
    });
  }

  async markDeletion(identity: string, receipt: string): Promise<void> {
    const acceptedReceipt = exactDigest(receipt, "managed deletion receipt");
    await this.#exclusive(identity, async () => {
      const current = await this.#readUnlocked(identity);
      if (current === undefined) {
        throw new Error("Remote Pi authority metadata disappeared while finalizing deletion.");
      }
      if (current.deletion !== undefined && current.deletion.receipt !== acceptedReceipt) {
        throw new Error("Remote Pi authority deletion receipt crossed its local fence.");
      }
      if (current.deletion !== undefined) return;
      const finalizedAt = Date.now();
      await this.#writeUnlocked(identity, {
        ...current,
        updatedAt: finalizedAt,
        deletion: { format: 1, receipt: acceptedReceipt, finalizedAt }
      });
    });
  }

  async remove(identity: string): Promise<void> {
    await this.#exclusive(identity, async () => this.#removeUnlocked(identity));
  }

  async #removeUnlocked(identity: string): Promise<void> {
    await this.#ready;
    const path = this.#path(identity);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return;
    await this.#assertSafeFile(path, info);
    await rm(path, { force: false });
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Remote Pi authority root is not a regular private directory.");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Remote Pi authority root permissions are unsafe.");
    }
    const canonical = await realpath(this.#root);
    if (!sameLocalPath(canonical, this.#root)) {
      throw new Error("Remote Pi authority root contains a symbolic path component.");
    }
  }

  async #readUnlocked(identity: string): Promise<RemoteAuthorityRecord | undefined> {
    await this.#ready;
    const path = this.#path(identity);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return undefined;
    await this.#assertSafeFile(path, info);
    if (info.size > MAXIMUM_AUTHORITY_BYTES) {
      throw new Error("Remote Pi authority metadata exceeded its safety limit.");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAXIMUM_AUTHORITY_BYTES) {
        throw new Error("Remote Pi authority metadata is not a bounded regular file.");
      }
      if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
        throw new Error("Remote Pi authority metadata permissions are unsafe.");
      }
      assertStableLocalFile(info, opened);
      const pathAfterOpen = await lstat(path);
      await this.#assertSafeFile(path, pathAfterOpen);
      assertStableLocalFile(opened, pathAfterOpen);
      const content = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(content, "utf8") > MAXIMUM_AUTHORITY_BYTES) {
        throw new Error("Remote Pi authority metadata exceeded its safety limit.");
      }
      const afterRead = await handle.stat();
      if (!afterRead.isFile() || afterRead.nlink !== 1) {
        throw new Error("Remote Pi authority metadata changed during validation.");
      }
      assertStableLocalFile(opened, afterRead);
      const pathAfterRead = await lstat(path);
      await this.#assertSafeFile(path, pathAfterRead);
      assertStableLocalFile(afterRead, pathAfterRead);
      return parseRemoteAuthorityRecord(content, identity);
    } finally {
      await handle.close();
    }
  }

  async #writeUnlocked(identity: string, record: RemoteAuthorityRecord): Promise<void> {
    await this.#ready;
    const normalized = parseRemoteAuthorityRecord(JSON.stringify(record), identity);
    const path = this.#path(identity);
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) await this.#assertSafeFile(path, existing);
    const content = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAXIMUM_AUTHORITY_BYTES) {
      throw new Error("Remote Pi authority metadata exceeded its safety limit.");
    }
    const temporary = resolve(this.#root, `.${identity}.${randomUUID()}.tmp`);
    if (dirname(temporary) !== this.#root) throw new Error("Remote Pi authority temporary path escaped its root.");
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
      await this.#assertSafeFile(path, await lstat(path));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #assertSafeFile(path: string, info: Stats): Promise<void> {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("Remote Pi authority metadata is not a regular file.");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Remote Pi authority metadata permissions are unsafe.");
    }
    if (!sameLocalPath(await realpath(path), path)) {
      throw new Error("Remote Pi authority metadata is not canonical.");
    }
  }

  #path(identity: string): string {
    const accepted = exactShortIdentity(identity);
    const path = resolve(this.#root, `${accepted}.json`);
    if (dirname(path) !== this.#root) throw new Error("Remote Pi authority path escaped its root.");
    return path;
  }

  async #exclusive<T>(identity: string, action: () => Promise<T>): Promise<T> {
    exactShortIdentity(identity);
    const previous = this.#tails.get(identity) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(identity, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#tails.get(identity) === tail) this.#tails.delete(identity);
    }
  }
}

function parseRemoteAuthorityRecord(raw: string, identity: string): RemoteAuthorityRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Remote Pi authority metadata is malformed.");
  }
  if (!isPlainRecord(value)) throw new Error("Remote Pi authority metadata failed its schema fence.");
  assertExactKeys(value, [
    "format", "authority", "outputCursor", "updatedAt",
    ...(value["deletion"] === undefined ? [] : ["deletion"])
  ]);
  if (value["format"] !== 1) throw new Error("Remote Pi authority metadata format is unsupported.");
  const authority = parseRemoteAuthorityEnvelope(value["authority"]);
  const outputCursor = safeSequence(value["outputCursor"]);
  const updatedAt = positiveSafeInteger(value["updatedAt"], "metadata update time");
  let deletion: RemoteAuthorityRecord["deletion"];
  if (value["deletion"] !== undefined) {
    if (!isPlainRecord(value["deletion"])) {
      throw new Error("Remote Pi authority deletion metadata failed its schema fence.");
    }
    assertExactKeys(value["deletion"], ["format", "receipt", "finalizedAt"]);
    if (value["deletion"]["format"] !== 1) {
      throw new Error("Remote Pi authority deletion metadata format is unsupported.");
    }
    deletion = {
      format: 1,
      receipt: exactDigest(value["deletion"]["receipt"], "managed deletion receipt"),
      finalizedAt: positiveSafeInteger(value["deletion"]["finalizedAt"], "deletion finalization time")
    };
  }
  if (authority.identity !== identity) {
    throw new Error("Remote Pi authority metadata crossed its identity fence.");
  }
  return {
    format: 1,
    authority,
    outputCursor,
    updatedAt,
    ...(deletion === undefined ? {} : { deletion })
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((name) => !accepted.has(name)) || allowed.some((name) => !(name in value))) {
    throw new Error("Remote Pi authority value contains an unexpected field.");
  }
}

function exactBoundedText(value: unknown, maximumBytes: number, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) throw new Error(`Remote Pi authority ${label} is invalid.`);
  return value;
}

function exactDigest(value: unknown, label: string): string {
  const accepted = exactBoundedText(value, 64, label);
  if (!/^[a-f0-9]{64}$/u.test(accepted)) throw new Error(`Remote Pi authority ${label} is invalid.`);
  return accepted;
}

function exactShortIdentity(value: unknown): string {
  const accepted = exactBoundedText(value, 32, "identity");
  if (!/^[a-f0-9]{32}$/u.test(accepted)) throw new Error("Remote Pi authority identity is invalid.");
  return accepted;
}

function exactUuid(value: unknown, label: string): string {
  const accepted = exactBoundedText(value, 36, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(accepted)) {
    throw new Error(`Remote Pi authority ${label} is invalid.`);
  }
  return accepted.toLowerCase();
}

function parseRemoteManagedRunSnapshot(value: unknown): PiManagedDurableRunSnapshot {
  if (!isPlainRecord(value)) {
    throw new Error("Remote managed durable run snapshot failed its schema fence.");
  }
  assertExactKeys(value, [
    "runId", "runnerInstanceId", "launchToken", "runnerScriptSha256", "revision",
    "controlRevision", "transcriptRevision", "resultRevision",
    "config", "status", "owner", ...(value["claim"] === undefined ? [] : ["claim"]),
    "transcriptBytes", "resultBytes", "resumeSafe", "controlSafe"
  ]);
  const runId = exactUuid(value["runId"], "managed run identity");
  const runnerInstanceId = exactUuid(value["runnerInstanceId"], "managed runner identity");
  const launchToken = exactUuid(value["launchToken"], "managed launch token");
  const runnerScriptSha256 = exactDigest(value["runnerScriptSha256"], "managed runner script hash");
  const config = value["config"];
  const status = value["status"];
  const owner = value["owner"];
  const claim = value["claim"];
  if (
    !isPlainRecord(config) || !isPlainRecord(status) || !isPlainRecord(owner) ||
    claim !== undefined && !isPlainRecord(claim) ||
    config["runId"] !== runId || status["runId"] !== runId || owner["runId"] !== runId ||
    config["launchToken"] !== launchToken || status["launchToken"] !== launchToken ||
    owner["launchToken"] !== launchToken ||
    config["runnerInstanceId"] !== runnerInstanceId || status["runnerInstanceId"] !== runnerInstanceId ||
    owner["runnerInstanceId"] !== runnerInstanceId ||
    config["runnerScriptSha256"] !== runnerScriptSha256 ||
    status["runnerScriptSha256"] !== runnerScriptSha256 || owner["runnerScriptSha256"] !== runnerScriptSha256 ||
    typeof value["resumeSafe"] !== "boolean" || typeof value["controlSafe"] !== "boolean"
  ) throw new Error("Remote managed durable run snapshot crossed its identity fence.");
  return {
    runId,
    runnerInstanceId,
    launchToken,
    runnerScriptSha256,
    revision: exactDigest(value["revision"], "managed run revision"),
    controlRevision: exactDigest(value["controlRevision"], "managed control revision"),
    transcriptRevision: exactDigest(value["transcriptRevision"], "managed transcript revision"),
    resultRevision: exactDigest(value["resultRevision"], "managed result revision"),
    config,
    status,
    owner,
    ...(claim === undefined ? {} : { claim }),
    transcriptBytes: nonnegativeSafeInteger(value["transcriptBytes"], "managed transcript size"),
    resultBytes: nonnegativeSafeInteger(value["resultBytes"], "managed result size"),
    resumeSafe: value["resumeSafe"],
    controlSafe: value["controlSafe"]
  };
}

function decodeExactBase64(value: string, maximumBytes: number): Buffer {
  if (
    value.length > Math.ceil(maximumBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error("Remote managed durable store returned invalid base64 content.");
  const content = Buffer.from(value, "base64");
  if (content.byteLength > maximumBytes || content.toString("base64") !== value) {
    throw new Error("Remote managed durable store returned invalid base64 content.");
  }
  return content;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Remote Pi authority ${label} is invalid.`);
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Remote Pi authority ${label} is invalid.`);
  }
  return value as number;
}

function safeSequence(value: unknown): number {
  return nonnegativeSafeInteger(value, "sequence");
}

function sameLocalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function managedStoreKey(sessionId: string, targetId: string): string {
  return `${sessionId}\0${targetId}`;
}

function managedSessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 40);
}

function remoteRecoveryIdentity(sessionId: string, targetId: string, hostId: string): string {
  return createHash("sha256").update([sessionId, targetId, hostId].join("\0")).digest("hex");
}

function assertStableLocalFile(left: Stats, right: Stats): void {
  if (
    left.dev !== right.dev || left.ino !== right.ino || left.nlink !== right.nlink ||
    left.size !== right.size || left.mtimeMs !== right.mtimeMs || left.ctimeMs !== right.ctimeMs
  ) throw new Error("Remote Pi authority metadata changed during validation.");
}

interface MappedRemotePiProcessOptions {
  readonly initialAttachment: RemoteBridgeAttachment;
  readonly reattach: () => Promise<RemoteBridgeAttachment>;
  readonly localSessionRoot: string;
  readonly localRuntime: string;
  readonly remoteSessionRoot: string;
  readonly remoteRuntime: string;
  readonly pathMap: ReadonlyMap<string, string>;
}

class MappedRemotePiProcess extends EventEmitter implements PiProcessHandle {
  readonly stdin: Transform;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly serviceRecovery: { readonly required: true } | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly #options: MappedRemotePiProcessOptions;
  readonly #stdoutRewrite: LineRewriteTransform;
  readonly #inputFrames = new Map<number, Buffer>();
  #attachment: RemoteBridgeAttachment | undefined;
  #lastFiles: RemoteFileTransportPort;
  #attachmentGeneration = 0;
  #reconnecting = false;
  #inputSequence = 0;
  #inputAcknowledged = 0;
  #inputBytes = 0;
  #inputSendTail = Promise.resolve();
  #outputCursor = 0;
  #discardOutputThrough = 0;
  #settled = false;
  #killRequested = false;
  #killSignal: "SIGKILL" | "SIGTERM" = "SIGTERM";

  constructor(options: MappedRemotePiProcessOptions) {
    super();
    this.#options = options;
    this.#lastFiles = options.initialAttachment.files;
    const initialState = options.initialAttachment.state;
    this.serviceRecovery = initialState?.recoveryOutputHighWater === undefined
      ? undefined
      : { required: true };
    if (initialState !== undefined) {
      this.#inputSequence = initialState.inputAcknowledged;
      this.#inputAcknowledged = initialState.inputAcknowledged;
      this.#outputCursor = initialState.outputAcknowledged;
      this.#discardOutputThrough = initialState.recoveryOutputHighWater ?? 0;
    }
    this.stdin = new LineRewriteTransform((line) => rewriteProtocolLine(line, options.pathMap));
    const remoteToLocal = invertedPathMap(options.pathMap);
    this.#stdoutRewrite = new LineRewriteTransform(async (line) => {
      const files = this.#attachment?.files ?? this.#lastFiles;
      if (line.includes(options.remoteSessionRoot)) {
        await syncRemoteSessions(files, options.remoteSessionRoot, options.localSessionRoot);
      }
      const remoteArtifacts = remotePath.join(options.remoteRuntime, "artifacts");
      if (line.includes(remoteArtifacts)) {
        await syncRemoteArtifacts(files, remoteArtifacts, resolve(options.localRuntime, "artifacts"));
      }
      return rewriteProtocolLine(line, remoteToLocal);
    });
    this.#stdoutRewrite.pipe(this.stdout, { end: false });
    this.stdin.on("data", (chunk: Buffer | string) => this.#enqueueInput(Buffer.from(chunk)));
    this.#bind(options.initialAttachment);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.#settled) return false;
    this.#killRequested = true;
    const acceptedSignal = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
    this.#killSignal = acceptedSignal;
    const attachment = this.#attachment;
    if (attachment === undefined) return true;
    void this.#requestBrokerKill(attachment, acceptedSignal);
    try {
      attachment.process.kill(acceptedSignal);
    } catch {
      // The independent broker request remains authoritative.
    }
    return true;
  }

  #bind(attachment: RemoteBridgeAttachment): void {
    if (this.#settled) {
      void attachment.reverseForward?.close().catch(() => undefined);
      attachment.process.kill("SIGKILL");
      return;
    }
    this.#attachment = attachment;
    this.#lastFiles = attachment.files;
    if (attachment.state !== undefined) {
      if (
        attachment.state.outputAcknowledged !== this.#outputCursor ||
        attachment.state.outputSequence < this.#outputCursor ||
        attachment.state.inputAcknowledged < this.#inputAcknowledged ||
        attachment.state.inputAcknowledged > this.#inputSequence
      ) {
        attachment.process.kill("SIGKILL");
        void attachment.reverseForward?.close().catch(() => undefined);
        throw new Error("Remote Pi authority state crossed its reliable stream fence.");
      }
      this.#acknowledgeInput(attachment.state.inputAcknowledged);
      if (attachment.state.recoveryOutputHighWater !== undefined) {
        if (
          attachment.state.recoveryOutputHighWater < this.#outputCursor ||
          attachment.state.recoveryOutputHighWater > attachment.state.outputSequence
        ) throw new Error("Remote Pi recovery output barrier is invalid.");
        this.#discardOutputThrough = Math.max(
          this.#discardOutputThrough,
          attachment.state.recoveryOutputHighWater
        );
      }
    }
    const generation = ++this.#attachmentGeneration;
    let terminal: RemoteTerminalState | undefined;
    const outputDecoder = new RemoteBridgeOutputTransform(async (type, sequence, content) => {
      if (type === REMOTE_FRAME_INPUT_ACK) {
        this.#acknowledgeInput(sequence);
        return;
      }
      if (sequence <= this.#outputCursor) {
        await this.#sendOutputAcknowledgement(attachment, this.#outputCursor);
        return;
      }
      if (sequence !== this.#outputCursor + 1) {
        throw new Error("Remote Pi output replay has an unrecoverable sequence gap.");
      }
      if (sequence > this.#discardOutputThrough) {
        if (type === REMOTE_FRAME_STDOUT) await writeStreamChunk(this.#stdoutRewrite, content);
        else if (type === REMOTE_FRAME_STDERR) await writeStreamChunk(this.stderr, content);
        else if (type === REMOTE_FRAME_EXIT) terminal = parseRemoteTerminal(content);
        else throw new Error("Remote Pi broker emitted an invalid frame type.");
      } else if (
        type !== REMOTE_FRAME_STDOUT && type !== REMOTE_FRAME_STDERR &&
        type !== REMOTE_FRAME_EXIT
      ) {
        throw new Error("Remote Pi broker emitted an invalid recovery frame type.");
      }
      this.#outputCursor = sequence;
      await attachment.persistOutputCursor?.(sequence);
      await this.#sendOutputAcknowledgement(attachment, sequence);
    });
    outputDecoder.once("error", () => {
      try {
        attachment.process.kill("SIGKILL");
      } catch {
        // The reconnect fence below remains authoritative.
      }
      void this.#protocolFailure(attachment, generation);
    });
    attachment.process.stdout.pipe(outputDecoder);
    attachment.process.stderr.pipe(this.stderr, { end: false });
    this.#inputSendTail = Promise.resolve();
    this.#flushInput(attachment);
    let errorTimer: NodeJS.Timeout | undefined;
    attachment.process.once("error", () => {
      errorTimer = setTimeout(() => {
        void this.#attachmentEnded(attachment, generation, terminal);
      }, 100);
      errorTimer.unref?.();
    });
    attachment.process.once("exit", () => {
      if (errorTimer !== undefined) clearTimeout(errorTimer);
      void Promise.race([
        new Promise<void>((resolveOutput) => outputDecoder.once("finish", () => resolveOutput())),
        new Promise<void>((resolveOutput) => {
          const timer = setTimeout(resolveOutput, 100);
          timer.unref?.();
        })
      ]).then(() => this.#attachmentEnded(attachment, generation, terminal));
    });
    if (this.#killRequested) void this.#requestBrokerKill(attachment, this.#killSignal);
  }

  #enqueueInput(content: Uint8Array): void {
    if (this.#settled) return;
    const sequence = ++this.#inputSequence;
    const frame = encodeRemoteSequencedFrame(REMOTE_FRAME_STDIN, sequence, content);
    this.#inputFrames.set(sequence, frame);
    this.#inputBytes += frame.byteLength;
    if (this.#inputBytes > MAXIMUM_RELIABLE_INPUT_BYTES) {
      const error = new Error("Remote Pi reliable input queue exceeded its safety limit.");
      this.emit("error", error);
      this.kill("SIGKILL");
      return;
    }
    const attachment = this.#attachment;
    if (attachment !== undefined) this.#scheduleInputFrame(attachment, frame);
  }

  #flushInput(attachment: RemoteBridgeAttachment): void {
    for (const [sequence, frame] of this.#inputFrames) {
      if (sequence > this.#inputAcknowledged) this.#scheduleInputFrame(attachment, frame);
    }
  }

  #scheduleInputFrame(attachment: RemoteBridgeAttachment, frame: Buffer): void {
    this.#inputSendTail = this.#inputSendTail.catch(() => undefined).then(async () => {
      if (this.#settled || this.#attachment !== attachment) return;
      await writeStreamChunk(attachment.process.stdin, frame);
    });
  }

  #acknowledgeInput(sequence: number): void {
    if (sequence < this.#inputAcknowledged || sequence > this.#inputSequence) {
      throw new Error("Remote Pi broker acknowledged an invalid input sequence.");
    }
    this.#inputAcknowledged = sequence;
    for (const [candidate, frame] of this.#inputFrames) {
      if (candidate > sequence) break;
      this.#inputFrames.delete(candidate);
      this.#inputBytes -= frame.byteLength;
    }
  }

  async #sendOutputAcknowledgement(
    attachment: RemoteBridgeAttachment,
    sequence: number
  ): Promise<void> {
    if (this.#attachment !== attachment) return;
    await writeStreamChunk(
      attachment.process.stdin,
      encodeRemoteSequencedFrame(REMOTE_FRAME_OUTPUT_ACK, sequence)
    );
  }

  async #requestBrokerKill(
    attachment: RemoteBridgeAttachment,
    signal: "SIGKILL" | "SIGTERM"
  ): Promise<void> {
    try {
      if (attachment.authority !== undefined) {
        await requestRemoteBrokerKill({
          processes: attachment.processes,
          sourcePath: attachment.brokerSourcePath,
          managedRoot: attachment.brokerRoot,
          identity: attachment.identity,
          signal,
          authority: attachment.authority
        });
        return;
      }
      const request = await attachment.processes.open({
        executable: "node",
        args: [
          attachment.brokerSourcePath,
          "kill",
          attachment.brokerRoot,
          attachment.identity,
          signal
        ],
        cwd: remotePath.dirname(attachment.brokerRoot),
        env: { JOKO_REMOTE_BROKER_SOURCE_HASH: REMOTE_PI_BROKER_SOURCE_SHA256 }
      });
      request.stdin.end();
      request.stdout.resume();
      request.stderr.resume();
      request.once("error", () => undefined);
    } catch {
      // PiRpcTransport will report an unconfirmed kill if the broker cannot be reached.
    }
  }

  async #attachmentEnded(
    attachment: RemoteBridgeAttachment,
    generation: number,
    terminal: RemoteTerminalState | undefined
  ): Promise<void> {
    if (
      this.#settled || this.#attachment !== attachment ||
      this.#attachmentGeneration !== generation
    ) return;
    this.#attachment = undefined;
    for (const watcher of attachment.watchers) watcher.close();
    await attachment.reverseForward?.close().catch(() => undefined);
    if (terminal !== undefined) {
      await this.#finish(terminal.code, terminal.signal, attachment.files);
      return;
    }
    this.#startReconnect();
  }

  async #protocolFailure(attachment: RemoteBridgeAttachment, generation: number): Promise<void> {
    if (
      this.#settled || this.#attachment !== attachment ||
      this.#attachmentGeneration !== generation
    ) return;
    this.#attachment = undefined;
    for (const watcher of attachment.watchers) watcher.close();
    await attachment.reverseForward?.close().catch(() => undefined);
    await this.#requestBrokerKill(attachment, "SIGKILL");
    await this.#finish(1, null, attachment.files);
  }

  #startReconnect(): void {
    if (this.#settled || this.#reconnecting) return;
    this.#reconnecting = true;
    void (async () => {
      let attempt = 0;
      while (!this.#settled && this.#attachment === undefined) {
        if (attempt > 0) await reconnectDelay(Math.min(2_000, 100 * (2 ** Math.min(attempt - 1, 5))));
        if (this.#settled || this.#attachment !== undefined) break;
        try {
          const attachment = await this.#options.reattach();
          if (this.#settled || this.#attachment !== undefined) {
            for (const watcher of attachment.watchers) watcher.close();
            await attachment.reverseForward?.close().catch(() => undefined);
            attachment.process.kill("SIGKILL");
            break;
          }
          this.#bind(attachment);
          break;
        } catch {
          attempt += 1;
        }
      }
    })().finally(() => {
      this.#reconnecting = false;
      if (!this.#settled && this.#attachment === undefined) this.#startReconnect();
    });
  }

  async #finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    files: RemoteFileTransportPort
  ): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    await syncRemoteSessions(
      files,
      this.#options.remoteSessionRoot,
      this.#options.localSessionRoot
    ).catch(() => undefined);
    await endTransform(this.#stdoutRewrite).catch(() => undefined);
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }
}

interface RemoteTerminalState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

class RemoteBridgeOutputTransform extends Transform {
  readonly #onFrame: (type: number, sequence: number, content: Buffer) => Promise<void>;
  #pending = Buffer.alloc(0);

  constructor(onFrame: (type: number, sequence: number, content: Buffer) => Promise<void>) {
    super();
    this.#onFrame = onFrame;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#pending = Buffer.concat([
      this.#pending,
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    ]);
    void this.#drain().then(() => callback(), callback);
  }

  override _flush(callback: TransformCallback): void {
    void this.#drain().then(() => callback(), callback);
  }

  async #drain(): Promise<void> {
    while (this.#pending.byteLength >= 5) {
      const length = this.#pending.readUInt32BE(1);
      if (length > MAXIMUM_REMOTE_FRAME_BYTES) throw new Error("Remote Pi broker frame exceeded its safety limit.");
      if (this.#pending.byteLength < length + 5) return;
      const type = this.#pending.readUInt8(0);
      const payload = this.#pending.subarray(5, length + 5);
      this.#pending = this.#pending.subarray(length + 5);
      const decoded = decodeRemoteSequencedContent(payload);
      await this.#onFrame(type, decoded.sequence, decoded.content);
    }
    if (this.#pending.byteLength > MAXIMUM_REMOTE_FRAME_BYTES + 5) {
      throw new Error("Remote Pi broker frame exceeded its safety limit.");
    }
  }
}

function encodeRemoteSequencedFrame(type: number, sequence: number, content: Uint8Array = Buffer.alloc(0)): Buffer {
  const acceptedContent = Buffer.from(content);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || acceptedContent.byteLength + 8 > MAXIMUM_REMOTE_FRAME_BYTES) {
    throw new Error("Remote Pi broker frame is invalid.");
  }
  const frame = Buffer.allocUnsafe(13 + acceptedContent.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(acceptedContent.byteLength + 8, 1);
  frame.writeBigUInt64BE(BigInt(sequence), 5);
  acceptedContent.copy(frame, 13);
  return frame;
}

function encodeRemoteControlFrame(type: number, content: Uint8Array): Buffer {
  const acceptedContent = Buffer.from(content);
  if (
    !Number.isSafeInteger(type) || type < 0 || type > 255 ||
    acceptedContent.byteLength > MAXIMUM_AUTHORITY_BYTES
  ) throw new Error("Remote Pi broker control frame is invalid.");
  const frame = Buffer.allocUnsafe(5 + acceptedContent.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(acceptedContent.byteLength, 1);
  acceptedContent.copy(frame, 5);
  return frame;
}

function decodeRemoteSequencedContent(content: Buffer): { readonly sequence: number; readonly content: Buffer } {
  if (content.byteLength < 8) throw new Error("Remote Pi broker frame is invalid.");
  const sequence = content.readBigUInt64BE(0);
  if (sequence < 1n || sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Remote Pi broker frame is invalid.");
  }
  return { sequence: Number(sequence), content: content.subarray(8) };
}

function parseRemoteTerminal(content: Buffer): RemoteTerminalState {
  if (content.byteLength > 1024) throw new Error("Remote Pi terminal frame is invalid.");
  const parsed = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
  const code = parsed["code"];
  const signal = parsed["signal"];
  if (!(code === null || (Number.isSafeInteger(code) && (code as number) >= 0 && (code as number) <= 255))) {
    throw new Error("Remote Pi terminal frame is invalid.");
  }
  if (!(signal === null || (typeof signal === "string" && /^SIG[A-Z0-9]{1,24}$/u.test(signal)))) {
    throw new Error("Remote Pi terminal frame is invalid.");
  }
  return { code: code as number | null, signal: signal as NodeJS.Signals | null };
}

async function writeStreamChunk(stream: Writable, content: Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) throw new Error("Remote Pi bridge stream is closed.");
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(content, (error?: Error | null) => {
      if (error) rejectWrite(new Error("Remote Pi bridge stream failed."));
      else resolveWrite();
    });
  });
}

function endTransform(stream: Transform): Promise<void> {
  if (stream.writableEnded) return Promise.resolve();
  return new Promise((resolveEnd, rejectEnd) => stream.end((error?: Error | null) => {
    if (error) rejectEnd(error);
    else resolveEnd();
  }));
}

function reconnectDelay(delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, delayMs);
    timer.unref?.();
  });
}

async function provisionRemoteBroker(files: RemoteFileTransportPort, managedRoot: string): Promise<void> {
  await ensureRemotePrivateDirectory(files, managedRoot);
  const sourcePath = remotePath.join(managedRoot, `broker-${REMOTE_PI_BROKER_SOURCE_SHA256}.mjs`);
  try {
    const existing = await files.stat(sourcePath);
    if (existing.kind !== "file") throw new Error("Remote Pi broker source path is unsafe.");
    const content = await files.read({ path: sourcePath, maximumBytes: Buffer.byteLength(REMOTE_PI_BROKER_SOURCE) + 1 });
    if (
      (existing.mode & 0o077) === 0 &&
      createHash("sha256").update(content).digest("hex") === REMOTE_PI_BROKER_SOURCE_SHA256
    ) return;
  } catch (error) {
    if (error instanceof Error && error.message.includes("unsafe")) throw error;
  }
  await files.write({
    path: sourcePath,
    content: Buffer.from(REMOTE_PI_BROKER_SOURCE, "utf8"),
    mode: 0o600,
    createParents: false,
    atomic: true
  });
  const installed = await files.read({ path: sourcePath, maximumBytes: Buffer.byteLength(REMOTE_PI_BROKER_SOURCE) + 1 });
  if (createHash("sha256").update(installed).digest("hex") !== REMOTE_PI_BROKER_SOURCE_SHA256) {
    throw new Error("Remote Pi broker source integrity verification failed.");
  }
}

async function ensureRemotePrivateDirectory(files: RemoteFileTransportPort, path: string): Promise<void> {
  await files.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await files.stat(path);
  if (info.kind !== "directory" || (info.mode & 0o077) !== 0) {
    throw new Error("Remote Pi managed directory is not private.");
  }
  if (await files.realpath(path) !== path) throw new Error("Remote Pi managed directory is not canonical.");
}

async function refreshRuntimeFiles(
  files: RemoteFileTransportPort,
  environment: Readonly<NodeJS.ProcessEnv>,
  pathMap: ReadonlyMap<string, string>,
  childRuntimeGeneration?: number
): Promise<void> {
  for (const local of [
    environment["JOKO_PI_CONTROL_FILE"],
    environment["JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE"]
  ]) {
    if (local === undefined) continue;
    const content = await runtimeControlContent(local, childRuntimeGeneration);
    await files.write({
      path: rewriteLocalPath(local, pathMap),
      content,
      mode: 0o600,
      atomic: true
    });
  }
}

class LineRewriteTransform extends Transform {
  #pending = "";
  readonly #decoder = new StringDecoder("utf8");
  readonly #rewrite: (line: string) => string | Promise<string>;

  constructor(rewrite: (line: string) => string | Promise<string>) {
    super();
    this.#rewrite = rewrite;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#pending += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    void this.#drainLines().then(() => callback(), callback);
  }

  override _flush(callback: TransformCallback): void {
    const pending = this.#pending + this.#decoder.end();
    this.#pending = "";
    if (pending === "") {
      callback();
      return;
    }
    void Promise.resolve(this.#rewrite(pending)).then((value) => {
      this.push(value);
      callback();
    }, callback);
  }

  async #drainLines(): Promise<void> {
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline + 1);
      this.#pending = this.#pending.slice(newline + 1);
      this.push(await this.#rewrite(line));
      newline = this.#pending.indexOf("\n");
    }
  }
}

function requireFiles(lease: RemoteSshTransportLease): RemoteFileTransportPort {
  if (lease.capabilities.fileTransfer !== true || lease.files === undefined) {
    throw new Error("Remote file transport is unavailable.");
  }
  return lease.files;
}

function requireProcesses(lease: RemoteSshTransportLease): NonNullable<RemoteSshTransportLease["processes"]> {
  if (lease.capabilities.processStreaming !== true || lease.processes === undefined) {
    throw new Error("Remote process transport is unavailable.");
  }
  return lease.processes;
}

async function syncLocalTree(
  files: RemoteFileTransportPort,
  local: string,
  remote: string,
  budget: { files: number; bytes: number }
): Promise<void> {
  const info = await lstat(local);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("Remote runtime resources must be regular files or directories.");
  }
  if (info.isDirectory()) {
    await files.mkdir(remote, { recursive: true, mode: info.mode & 0o777 });
    const entries = await readdir(local, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await syncLocalTree(files, resolve(local, entry.name), remotePath.join(remote, entry.name), budget);
    }
    const after = await lstat(local);
    if (
      !after.isDirectory() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino ||
      info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs
    ) throw new Error("Remote runtime resource changed during synchronization.");
    return;
  }
  budget.files += 1;
  budget.bytes += info.size;
  if (
    budget.files > MAXIMUM_SYNC_FILES || budget.bytes > MAXIMUM_SYNC_BYTES ||
    info.size > MAXIMUM_SYNC_FILE_BYTES
  ) throw new Error("Remote runtime resource synchronization exceeded its safety limit.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(local, fsConstants.O_RDONLY | noFollow);
  let content: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("Remote runtime resource is not a single-link regular file.");
    }
    assertStableResourceFile(info, opened);
    content = await handle.readFile();
    assertStableResourceFile(opened, await handle.stat());
    const pathAfterRead = await lstat(local);
    if (pathAfterRead.isSymbolicLink() || !pathAfterRead.isFile()) {
      throw new Error("Remote runtime resource changed during synchronization.");
    }
    assertStableResourceFile(opened, pathAfterRead);
  } finally {
    await handle.close();
  }
  await files.write({
    path: remote,
    content,
    mode: info.mode & 0o777,
    createParents: true,
    atomic: true
  });
}

interface LocalAssetSnapshotEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly content?: Buffer;
}

interface LocalAssetSnapshot {
  readonly digest: string;
  readonly entries: readonly LocalAssetSnapshotEntry[];
}

interface RemoteStagingPlan {
  readonly local: string;
  readonly remote: string;
  readonly snapshot?: LocalAssetSnapshot;
  readonly replaceDirectory?: boolean;
}

async function stageRemoteRuntime(
  files: RemoteFileTransportPort,
  plans: readonly RemoteStagingPlan[]
): Promise<void> {
  const budget = { files: 0, bytes: 0 };
  for (const plan of plans) {
    if (plan.snapshot === undefined) await syncLocalTree(files, plan.local, plan.remote, budget);
    else {
      if (plan.replaceDirectory === true) await files.remove(plan.remote, { recursive: true });
      await stageLocalAssetSnapshot(files, plan.remote, plan.snapshot, budget);
    }
  }
}

async function stageLocalAssetSnapshot(
  files: RemoteFileTransportPort,
  remote: string,
  snapshot: LocalAssetSnapshot,
  budget: { files: number; bytes: number }
): Promise<void> {
  for (const entry of snapshot.entries) {
    const destination = entry.path === ""
      ? remote
      : remotePath.join(remote, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await files.mkdir(destination, { recursive: true, mode: entry.mode & 0o777 });
      continue;
    }
    const content = entry.content!;
    budget.files += 1;
    budget.bytes += content.byteLength;
    if (
      budget.files > MAXIMUM_SYNC_FILES || budget.bytes > MAXIMUM_SYNC_BYTES ||
      content.byteLength > MAXIMUM_SYNC_FILE_BYTES
    ) throw new Error("Remote runtime resource synchronization exceeded its safety limit.");
    await files.write({
      path: destination,
      content,
      mode: entry.mode & 0o777,
      createParents: true,
      atomic: true
    });
  }
  await verifyRemoteAssetSnapshot(files, remote, snapshot);
}

async function verifyRemoteAssetSnapshot(
  files: RemoteFileTransportPort,
  remote: string,
  snapshot: LocalAssetSnapshot
): Promise<void> {
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry] as const));
  for (const entry of snapshot.entries) {
    const destination = entry.path === ""
      ? remote
      : remotePath.join(remote, ...entry.path.split("/"));
    const info = await files.stat(destination);
    if (info.kind !== entry.kind) {
      throw new Error("Remote runtime resource failed its staged type fence.");
    }
    if (entry.kind === "file") {
      const expected = entry.content!;
      if (info.size !== expected.byteLength) {
        throw new Error("Remote runtime resource failed its staged size fence.");
      }
      const actual = Buffer.from(await files.read({
        path: destination,
        maximumBytes: Math.max(1, expected.byteLength)
      }));
      if (!actual.equals(expected)) {
        throw new Error("Remote runtime resource failed its staged content fence.");
      }
      continue;
    }
    const expectedChildren = new Map<string, LocalAssetSnapshotEntry["kind"]>();
    const prefix = entry.path === "" ? "" : `${entry.path}/`;
    for (const candidate of snapshot.entries) {
      if (!candidate.path.startsWith(prefix) || candidate.path === entry.path) continue;
      const remainder = candidate.path.slice(prefix.length);
      if (remainder.includes("/")) continue;
      expectedChildren.set(remainder, candidate.kind);
    }
    const actualChildren = await files.list(destination);
    if (actualChildren.length !== expectedChildren.size) {
      throw new Error("Remote runtime resource failed its staged directory fence.");
    }
    for (const child of actualChildren) {
      if (expectedChildren.get(child.name) !== child.kind) {
        throw new Error("Remote runtime resource failed its staged directory fence.");
      }
    }
  }
  if (entries.size !== snapshot.entries.length) {
    throw new Error("Remote runtime resource snapshot contains duplicate paths.");
  }
}

function watchRuntimeFiles(
  files: RemoteFileTransportPort,
  environment: Readonly<NodeJS.ProcessEnv>,
  pathMap: ReadonlyMap<string, string>,
  childRuntimeGeneration: number
): readonly FSWatcher[] {
  const paths = [
    environment["JOKO_PI_CONTROL_FILE"],
    environment["JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE"]
  ].filter((value): value is string => value !== undefined);
  return paths.map((local) => {
    const remote = rewriteLocalPath(local, pathMap);
    let tail = Promise.resolve();
    return watch(local, { persistent: false }, () => {
      tail = tail.then(async () => {
        const content = await runtimeControlContent(local, childRuntimeGeneration);
        await files.write({ path: remote, content, mode: 0o600, atomic: true });
      }).catch(() => undefined);
    });
  });
}

async function runtimeControlContent(local: string, childRuntimeGeneration?: number): Promise<Buffer> {
  let content = await readFile(local);
  if (content.byteLength > MAXIMUM_SYNC_FILE_BYTES) {
    throw new Error("Remote Pi runtime control exceeded its safety limit.");
  }
  if (childRuntimeGeneration === undefined) return content;
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    throw new Error("Remote Pi runtime control is malformed.");
  }
  if (!isPlainRecord(value) || !Number.isSafeInteger(value["generation"])) {
    throw new Error("Remote Pi runtime control failed its generation schema fence.");
  }
  content = Buffer.from(`${JSON.stringify({ ...value, generation: childRuntimeGeneration })}\n`, "utf8");
  if (content.byteLength > MAXIMUM_SYNC_FILE_BYTES) {
    throw new Error("Remote Pi runtime control exceeded its safety limit.");
  }
  return content;
}

async function syncRemoteSessions(
  files: RemoteFileTransportPort,
  remoteRoot: string,
  localRoot: string
): Promise<void> {
  await mkdir(localRoot, { recursive: true });
  const visit = async (remoteDirectory: string, localDirectory: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error("Remote session tree is too deep.");
    const entries = await files.list(remoteDirectory);
    for (const entry of entries) {
      if (!/^[^/\\\0]+$/u.test(entry.name)) throw new Error("Remote session entry name is invalid.");
      const remote = remotePath.join(remoteDirectory, entry.name);
      const local = resolve(localDirectory, entry.name);
      if (entry.kind === "directory") {
        await mkdir(local, { recursive: true });
        await visit(remote, local, depth + 1);
      } else if (entry.kind === "file" && entry.name.endsWith(".jsonl")) {
        const content = await files.read({ path: remote, maximumBytes: MAXIMUM_SYNC_FILE_BYTES });
        const temporary = `${local}.${randomUUID()}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, local);
        await chmod(local, 0o600);
      }
    }
  };
  await visit(remoteRoot, localRoot, 0);
}

async function syncRemoteArtifacts(
  files: RemoteFileTransportPort,
  remoteRoot: string,
  localRoot: string
): Promise<void> {
  await mkdir(localRoot, { recursive: true });
  let entries: Awaited<ReturnType<RemoteFileTransportPort["list"]>>;
  try {
    entries = await files.list(remoteRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.kind !== "file" || !/^[^/\\\0]+$/u.test(entry.name)) continue;
    const remote = remotePath.join(remoteRoot, entry.name);
    const local = resolve(localRoot, entry.name);
    const content = await files.read({ path: remote, maximumBytes: MAXIMUM_SYNC_FILE_BYTES });
    const temporary = `${local}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, local);
    await chmod(local, 0o600);
  }
}

function remoteCommand(
  localCommand: string,
  args: string[],
  remoteRuntime: string,
  pathMap: Map<string, string>,
  stagingPlans: RemoteStagingPlan[],
  snapshot?: LocalAssetSnapshot
): string {
  const executableName = basename(localCommand).replace(/\.exe$/iu, "");
  if (executableName.toLowerCase() === "electron") return "node";
  if (!isAbsolute(localCommand)) return localCommand;
  if (executableName.toLowerCase() === "node") return "node";
  const remote = remotePath.join(remoteRuntime, "bin", safeRemoteName(executableName));
  stagingPlans.push({
    local: resolve(localCommand),
    remote,
    ...(snapshot === undefined ? {} : { snapshot })
  });
  pathMap.set(resolve(localCommand), remote);
  if (args[0] !== undefined && isAbsolute(args[0])) args[0] = rewriteLocalPath(args[0], pathMap);
  return remote;
}

function rewriteRemoteEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  pathMap: ReadonlyMap<string, string>
): Readonly<Record<string, string>> {
  const excluded = new Set([
    "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "ProgramFiles", "ProgramFiles(x86)",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ELECTRON_RUN_AS_NODE"
  ]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || excluded.has(name)) continue;
    if (name === "PATH" && /^[A-Za-z]:[\\/]/u.test(value)) continue;
    if (name === MANAGED_SUBAGENT_NODE_ENV) {
      result[name] = MANAGED_NODE_EXECUTABLE_LAUNCH_MARKER;
      continue;
    }
    if (name === NATIVE_AUTH_RESERVATION_TOKEN_ENV) {
      optionalNativeAuthReservationToken(value);
      result[name] = NATIVE_AUTH_RESERVATION_LAUNCH_MARKER;
      continue;
    }
    result[name] = rewriteExactMappedPath(value, pathMap) ?? rewriteText(value, pathMap);
  }
  return result;
}

function rewriteLocalPath(value: string, pathMap: ReadonlyMap<string, string>): string {
  const absolute = resolve(value);
  for (const [local, remote] of sortedPathMap(pathMap)) {
    if (absolute === local) return remote;
    const child = relative(local, absolute);
    if (child !== "" && !child.startsWith("..") && !isAbsolute(child)) {
      return remotePath.join(remote, ...child.split(sep));
    }
  }
  return value;
}

function rewriteText(value: string, pathMap: ReadonlyMap<string, string>): string {
  let output = value;
  for (const [from, to] of sortedPathMap(pathMap)) {
    output = output.split(from).join(to);
    output = output.split(from.replace(/\\/gu, "/")).join(to);
  }
  return output;
}

function rewriteProtocolLine(value: string, pathMap: ReadonlyMap<string, string>): string {
  const newline = value.endsWith("\n") ? "\n" : "";
  const source = newline === "" ? value : value.slice(0, -1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return rewriteText(value, pathMap);
  }
  return `${JSON.stringify(rewriteJsonStrings(parsed, pathMap, 0))}${newline}`;
}

function rewriteJsonStrings(
  value: unknown,
  pathMap: ReadonlyMap<string, string>,
  depth: number
): unknown {
  if (depth > 64) throw new Error("Remote Pi protocol value is too deeply nested.");
  if (typeof value === "string") return rewriteExactMappedPath(value, pathMap) ?? rewriteText(value, pathMap);
  if (Array.isArray(value)) return value.map((entry) => rewriteJsonStrings(entry, pathMap, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
      name,
      rewriteJsonStrings(entry, pathMap, depth + 1)
    ]));
  }
  return value;
}

function sortedPathMap(pathMap: ReadonlyMap<string, string>): readonly (readonly [string, string])[] {
  return [...pathMap.entries()].sort((left, right) => right[0].length - left[0].length);
}

function rewriteExactMappedPath(value: string, pathMap: ReadonlyMap<string, string>): string | undefined {
  const comparable = value.replace(/\\/gu, "/");
  for (const [from, to] of sortedPathMap(pathMap)) {
    const comparableFrom = from.replace(/\\/gu, "/");
    if (comparable === comparableFrom) return to;
    if (!comparable.startsWith(`${comparableFrom}/`)) continue;
    const suffix = comparable.slice(comparableFrom.length + 1).split("/");
    return to.startsWith("/") ? remotePath.join(to, ...suffix) : resolve(to, ...suffix);
  }
  return undefined;
}

function invertedPathMap(pathMap: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  return new Map([...pathMap.entries()].map(([local, remote]) => [remote, local]));
}

function requiredEnvironment(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name];
  if (value === undefined || value === "") throw new Error("Remote Pi runtime metadata is incomplete.");
  return value;
}

function exactDigestEnvironment(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  return exactDigest(requiredEnvironment(environment, name), name);
}

function exactRuntimeGeneration(environment: Readonly<NodeJS.ProcessEnv>): number {
  const value = requiredEnvironment(environment, "JOKO_PI_GENERATION");
  if (!/^(?:0|[1-9][0-9]{0,14})$/u.test(value)) {
    throw new Error("Remote Pi runtime generation is invalid.");
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) throw new Error("Remote Pi runtime generation is invalid.");
  return generation;
}

function optionalNativeAuthReservationToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("Remote Pi native auth reservation token is invalid.");
  }
  return value;
}

function remotePiProcessLaunchHash(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): string {
  return remotePiLaunchHash({
    ...input,
    env: normalizedBrokerLaunchEnvironment(input.env)
  });
}

interface RemoteCompatibilityAsset {
  readonly role: string;
  readonly name: string;
  readonly digest: string;
}

function remotePiCompatibilityHash(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly remoteRuntime: string;
  readonly assets: readonly RemoteCompatibilityAsset[];
}): string {
  const args: string[] = [];
  for (let index = 0; index < input.args.length; index += 1) {
    const value = input.args[index]!;
    if (value === "--session" || value === "--session-id") {
      if (input.args[index + 1] === undefined) {
        throw new Error("Remote Pi session selector is incomplete.");
      }
      args.push("--session", "<joko-broker-session-selector>");
      index += 1;
      continue;
    }
    args.push(normalizeCompatibilityRuntimePath(value, input.remoteRuntime));
  }
  const environment = Object.entries(normalizedBrokerLaunchEnvironment(input.env))
    .map(([name, value]) => [name, normalizeCompatibilityRuntimePath(value, input.remoteRuntime)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const assets = [...input.assets].sort((left, right) =>
    left.role.localeCompare(right.role) || left.name.localeCompare(right.name) || left.digest.localeCompare(right.digest));
  return createHash("sha256").update(JSON.stringify({
    command: normalizeCompatibilityRuntimePath(input.command, input.remoteRuntime),
    args,
    cwd: input.cwd,
    environment,
    assets
  })).digest("hex");
}

function normalizeCompatibilityRuntimePath(value: string, runtimeRoot: string): string {
  const prefix = `${runtimeRoot}/assets/`;
  if (!value.startsWith(prefix)) return value;
  const suffix = value.slice(prefix.length);
  const slash = suffix.indexOf("/");
  const head = slash < 0 ? suffix : suffix.slice(0, slash);
  const tail = slash < 0 ? "" : suffix.slice(slash);
  const normalizedHead = head.replace(/^[a-f0-9]{64}-/u, "<content-role>-");
  return `<joko-broker-runtime>/assets/${normalizedHead}${tail}`;
}

function compatibilityAssetRole(
  command: string,
  args: readonly string[],
  index: number
): string | undefined {
  const previous = args[index - 1];
  if (previous === "--extension") return `extension:${index}`;
  if (previous === "--skill") return `skill:${index}`;
  if (previous === "--prompt-template") return `prompt-template:${index}`;
  if (index === 0 && /^(?:node|electron)(?:\.exe)?$/iu.test(basename(command))) return "entrypoint";
  return undefined;
}

async function snapshotLocalCompatibilityAsset(root: string): Promise<LocalAssetSnapshot> {
  const entries: LocalAssetSnapshotEntry[] = [];
  const budget = { files: 0, bytes: 0 };
  const visit = async (path: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Remote Pi compatibility asset tree is too deep.");
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error("Remote Pi compatibility assets must be regular files or directories.");
    }
    if (info.isDirectory()) {
      entries.push({ path: relativePath, kind: "directory", mode: info.mode });
      const directoryEntries = await readdir(path, { withFileTypes: true });
      directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of directoryEntries) {
        if (!/^[^/\\\0]+$/u.test(entry.name)) throw new Error("Remote Pi compatibility asset name is invalid.");
        await visit(resolve(path, entry.name), relativePath === "" ? entry.name : `${relativePath}/${entry.name}`, depth + 1);
      }
      const after = await lstat(path);
      if (
        !after.isDirectory() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino ||
        info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs
      ) throw new Error("Remote Pi compatibility asset changed while it was snapshotted.");
      return;
    }
    budget.files += 1;
    budget.bytes += info.size;
    if (
      budget.files > MAXIMUM_SYNC_FILES || budget.bytes > MAXIMUM_SYNC_BYTES ||
      info.size > MAXIMUM_SYNC_FILE_BYTES
    ) throw new Error("Remote Pi compatibility asset digest exceeded its safety limit.");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new Error("Remote Pi compatibility asset is not a single-link regular file.");
      }
      assertStableResourceFile(info, opened);
      const content = await handle.readFile();
      assertStableResourceFile(opened, await handle.stat());
      const pathAfterRead = await lstat(path);
      if (!pathAfterRead.isFile() || pathAfterRead.isSymbolicLink()) {
        throw new Error("Remote Pi compatibility asset changed while it was snapshotted.");
      }
      assertStableResourceFile(opened, pathAfterRead);
      entries.push({ path: relativePath, kind: "file", mode: opened.mode, content });
    } finally {
      await handle.close();
    }
  };
  await visit(root, "", 0);
  return createLocalAssetSnapshot(entries);
}

function localAssetSubsnapshot(snapshot: LocalAssetSnapshot, relativePath: string): LocalAssetSnapshot {
  const accepted = relativePath.replace(/\\/gu, "/");
  if (
    accepted === "" || accepted.startsWith("/") || accepted.endsWith("/") ||
    accepted.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("Remote Pi compatibility asset subpath is invalid.");
  const selected = snapshot.entries
    .filter((entry) => entry.path === accepted || entry.path.startsWith(`${accepted}/`))
    .map((entry): LocalAssetSnapshotEntry => ({
      ...entry,
      path: entry.path === accepted ? "" : entry.path.slice(accepted.length + 1)
    }));
  if (selected.length === 0 || selected[0]?.path !== "") {
    throw new Error("Remote Pi compatibility asset subpath is unavailable.");
  }
  return createLocalAssetSnapshot(selected);
}

function createLocalAssetSnapshot(entries: readonly LocalAssetSnapshotEntry[]): LocalAssetSnapshot {
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry.kind === "directory") {
      hash.update(`d\0${entry.path}\0`);
      continue;
    }
    const content = entry.content!;
    hash.update(`f\0${entry.path}\0${String(entry.mode & 0o111)}\0${String(content.byteLength)}\0`);
    hash.update(content);
  }
  return { digest: hash.digest("hex"), entries };
}

function localAssetSingleFileSha256(snapshot: LocalAssetSnapshot): string {
  const [entry] = snapshot.entries;
  if (snapshot.entries.length !== 1 || entry?.kind !== "file" || entry.path !== "") {
    throw new Error("Remote Pi trusted runner snapshot is not a single regular file.");
  }
  return createHash("sha256").update(entry.content!).digest("hex");
}

function assertStableResourceFile(left: Stats, right: Stats): void {
  if (
    left.dev !== right.dev || left.ino !== right.ino || left.nlink !== right.nlink ||
    left.size !== right.size || left.mtimeMs !== right.mtimeMs || left.ctimeMs !== right.ctimeMs
  ) throw new Error("Remote runtime resource changed while it was read.");
}

function normalizedBrokerLaunchEnvironment(
  environment: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return {
    ...environment,
    JOKO_PI_MCP_TOKEN: MANAGED_BEARER_LAUNCH_MARKER,
    JOKO_PI_GENERATION: MANAGED_GENERATION_LAUNCH_MARKER,
    JOKO_PI_SPAWN_IDENTITY: MANAGED_SPAWN_IDENTITY_LAUNCH_MARKER,
    ...(environment[MANAGED_SUBAGENT_NODE_ENV] === undefined ? {} : {
      [MANAGED_SUBAGENT_NODE_ENV]: MANAGED_NODE_EXECUTABLE_LAUNCH_MARKER
    }),
    ...(environment[NATIVE_AUTH_RESERVATION_TOKEN_ENV] === undefined ? {} : {
      [NATIVE_AUTH_RESERVATION_TOKEN_ENV]: NATIVE_AUTH_RESERVATION_LAUNCH_MARKER
    })
  };
}

function stableIdentity(...values: readonly string[]): string {
  return createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 32);
}

function safeRemoteName(value: string): string {
  const accepted = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
  return accepted === "" ? "resource" : accepted;
}

function isLoopback(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "[::1]" || value === "localhost";
}

function normalizeLoopback(value: string): "127.0.0.1" | "::1" | "localhost" {
  if (value === "::1" || value === "[::1]") return "::1";
  return value === "localhost" ? "localhost" : "127.0.0.1";
}
