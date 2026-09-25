import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { arch } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { JokoError, redactSecrets } from "@joko/core";
import { inspectSimulatorAppArtifact, SimulatorAppArtifactError,
  SimulatorProjectBuildError, SimulatorProjectBuilder,
  type SimulatorAppArtifactIdentity, type SimulatorProjectBuildResult } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_app_build";
const STORE_SCOPE = "service";
const STORE_ID = "orchestrator";
const STORE_KEY = "ios_simulator_app_artifacts.v1";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const MAX_ARTIFACTS = 64;
const MAX_DIAGNOSTICS = 32;
const DIAGNOSTICS_TTL_MS = 30 * 60_000;
const ORPHAN_STORAGE_TTL_MS = 24 * 60 * 60_000;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_install", "ios_simulator_app_control",
  "ios_simulator_url_control", "ios_simulator_screenshot", "ios_simulator_visual_capture", "ios_simulator_recording",
  "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"]);

export interface SimulatorBuildArtifact {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly bindingGeneration: number;
  readonly instanceId: string;
  readonly simulatorUdid: string;
  readonly worktreeRootHash: string;
  readonly appPath: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly projectKind: "xcode-workspace" | "xcode-project";
  readonly createdAt: string;
}

export interface SimulatorBuildDiagnosticsSummary {
  readonly diagnosticsId: string;
  readonly buildLogTail: string;
  readonly xcresultAvailable: boolean;
  readonly outputTruncated: boolean;
}

export interface SimulatorBuildReceipt {
  readonly artifact: { readonly artifactId: string; readonly bundleId: string;
    readonly projectKind: SimulatorBuildArtifact["projectKind"];
    readonly scheme: string; readonly createdAt: string };
  readonly diagnostics: SimulatorBuildDiagnosticsSummary;
}

interface StoredArtifacts { readonly format: 1; readonly artifacts: readonly SimulatorBuildArtifact[] }

interface Diagnostic {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly createdAt: number;
  readonly buildLogTail: string;
  readonly xcresultText: string | null;
  readonly outputTruncated: boolean;
}

export class SimulatorAppBuildError extends JokoError {
  constructor(readonly code: string, message: string,
    readonly diagnostics?: SimulatorBuildDiagnosticsSummary) {
    super({ code, message, phase: "simulator_app_build", retryable: false,
      stateMayHaveChanged: code === "BUILD_OUTCOME_UNKNOWN",
      recovery: code === "BUILD_OUTCOME_UNKNOWN"
        ? "Inspect the current Simulator and build diagnostics before a new build."
        : "Correct the project or inspect the current Simulator task." });
    this.name = "SimulatorAppBuildError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function validArtifacts(value: unknown): value is StoredArtifacts {
  if (!record(value) || value["format"] !== 1 || !Array.isArray(value["artifacts"]) ||
      value["artifacts"].length > MAX_ARTIFACTS) return false;
  const ids = new Set<string>();
  for (const raw of value["artifacts"]) {
    if (!record(raw) || Object.keys(raw).length !== 12 || typeof raw["artifactId"] !== "string" ||
        !UUID.test(raw["artifactId"]) || ids.has(raw["artifactId"]) ||
        !["sessionId", "targetId", "instanceId", "simulatorUdid", "worktreeRootHash",
          "appPath", "bundleId", "scheme", "projectKind", "createdAt"].every(key =>
          typeof raw[key] === "string" && String(raw[key]).length > 0) ||
        !Number.isSafeInteger(raw["bindingGeneration"]) || Number(raw["bindingGeneration"]) < 1 ||
        !DIGEST.test(String(raw["worktreeRootHash"])) || !isAbsolute(String(raw["appPath"])) ||
        !["xcode-workspace", "xcode-project"].includes(String(raw["projectKind"]))) return false;
    ids.add(raw["artifactId"]);
  }
  return true;
}

function publicBuildText(value: string, privateRoots: readonly string[]): string {
  let redacted = redactSecrets(value);
  for (const root of [...privateRoots, process.env.HOME, process.env.TMPDIR]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(root, "<redacted-path>");
  }
  return redacted.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "")
    .replace(/https?:\/\/[^\s)]+/giu, "<redacted-url>")
    .replace(/(?:\/Users\/|\/private\/var\/|\/tmp\/)[^\s"']+/gu, "<redacted-path>")
    .slice(-2 * 1024 * 1024);
}

function hashRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

/** Refuse broad, symlinked, or non-child recursive removal even inside private storage. */
async function discardManagedChild(parent: string, child: string): Promise<void> {
  if (dirname(child) !== parent) return;
  let resolvedParent: string;
  let resolvedChild: string;
  try {
    const entry = await lstat(child);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    resolvedParent = await realpath(parent);
    resolvedChild = await realpath(child);
  } catch { return; }
  if (resolvedChild === resolvedParent || !inside(resolvedParent, resolvedChild)) return;
  await rm(child, { recursive: true, force: true }).catch(() => undefined);
}

/** Durable build admission and private artifact/diagnostic ownership. */
export class SimulatorProjectBuildCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #builder: Pick<SimulatorProjectBuilder, "inspect" | "build" | "readXcresult">;
  readonly #artifactRoot: string;
  readonly #inspectArtifact: (input: { readonly appPath: string; readonly authorizedRoot: string;
    readonly expectedArch: "arm64" | "x86_64"; readonly signal?: AbortSignal }) => Promise<SimulatorAppArtifactIdentity>;
  readonly #diagnostics = new Map<string, Diagnostic>();
  readonly #now: () => number;
  readonly #architecture: "arm64" | "x86_64";

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry, options: {
    readonly artifactRoot: string;
    readonly builder?: Pick<SimulatorProjectBuilder, "inspect" | "build" | "readXcresult">;
    readonly inspectArtifact?: typeof inspectSimulatorAppArtifact;
    readonly architecture?: "arm64" | "x86_64";
    readonly now?: () => number;
  }) {
    if (!isAbsolute(options.artifactRoot)) throw new RangeError("Simulator build root must be absolute.");
    this.#store = store;
    this.#ownership = ownership;
    this.#builder = options.builder ?? new SimulatorProjectBuilder();
    this.#artifactRoot = options.artifactRoot;
    this.#inspectArtifact = options.inspectArtifact ?? inspectSimulatorAppArtifact;
    this.#architecture = options.architecture ?? (arch() === "x64" ? "x86_64" : "arm64");
    this.#now = options.now ?? Date.now;
    this.#loadArtifacts();
  }

  /** Reclaim only aged, owned temporary builds and unpublished copies from prior host exits. */
  async reconcileBuildStorage(): Promise<void> {
    const retained = new Set(this.#loadArtifacts().artifacts.map(item => item.artifactId));
    for (const family of ["builds", "artifacts"] as const) {
      const parent = join(this.#artifactRoot, family);
      let entries;
      try { entries = await readdir(parent, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new SimulatorAppBuildError("ARTIFACT_STORAGE_UNAVAILABLE",
          "Managed Simulator build storage could not be inspected.");
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID.test(entry.name) ||
            family === "artifacts" && retained.has(entry.name)) continue;
        const directory = join(parent, entry.name);
        const metadata = await lstat(directory).catch(() => null);
        if (metadata && this.#now() - metadata.mtimeMs > ORPHAN_STORAGE_TTL_MS) {
          await discardManagedChild(parent, directory);
        }
      }
    }
  }

  async getArtifact(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    artifactId: string): Promise<SimulatorBuildArtifact> {
    const instance = this.#ownership.requireRoute(scope, route);
    const artifact = this.#loadArtifacts().artifacts.find(value => value.artifactId === artifactId);
    if (!artifact || !UUID.test(artifactId)) throw new SimulatorAppBuildError(
      "APP_ARTIFACT_INVALID", "This task has no current app artifact with that identity.");
    let currentRoot: string;
    let currentApp: string;
    try {
      currentRoot = await realpath(this.#currentWorktree(scope));
      currentApp = await realpath(join(this.#artifactRoot, "artifacts", artifactId, "Application.app"));
    } catch { throw new SimulatorAppBuildError("APP_ARTIFACT_INVALID", "Managed app artifact is unavailable."); }
    if (!artifact || artifact.sessionId !== scope.sessionId || artifact.targetId !== scope.targetId ||
        artifact.bindingGeneration !== scope.generation || artifact.instanceId !== instance.instanceId ||
        artifact.simulatorUdid !== instance.simulatorUdid ||
        artifact.worktreeRootHash !== hashRoot(currentRoot) || artifact.appPath !== currentApp) {
      throw new SimulatorAppBuildError("APP_ARTIFACT_INVALID", "This task has no current app artifact with that identity.");
    }
    try {
      const inspected = await this.#inspectArtifact({ appPath: currentApp,
        authorizedRoot: join(this.#artifactRoot, "artifacts", artifactId),
        expectedArch: this.#architecture });
      this.#ownership.requireRoute(scope, route);
      if (inspected.appPath !== currentApp || inspected.bundleId !== artifact.bundleId) {
        throw new Error("App artifact identity changed.");
      }
    } catch { throw new SimulatorAppBuildError("APP_ARTIFACT_INVALID",
      "Managed app artifact changed after it was built."); }
    return artifact;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    input: { readonly containerPath?: string; readonly scheme?: string },
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal):
    Promise<{ readonly receipt: SimulatorBuildReceipt; readonly replayed: boolean }> {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1 ||
        input.containerPath !== undefined && (typeof input.containerPath !== "string" ||
          !input.containerPath.trim() || input.containerPath.length > 4_096) ||
        input.scheme !== undefined && (typeof input.scheme !== "string" ||
          !input.scheme.trim() || input.scheme.length > 256)) {
      throw new SimulatorAppBuildError("INVALID_ARGUMENT", "Simulator build arguments are invalid.");
    }
    if (signal?.aborted) throw new SimulatorAppBuildError("MUTATION_CANCELLED", "Simulator build was cancelled before admission.");
    const operationId = `ios-simulator-build:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let worktreeRoot: string | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorBuildReceipt>({ id: operationId,
        kind: KIND, body: { action: "build_app", sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId,
          requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration } }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready") throw new SimulatorAppBuildError(
          "SIMULATOR_NOT_READY", "Simulator must be booted before building an app.");
        const session = this.#store.getSession(scope.sessionId).descriptor;
        const target = this.#store.getTarget(scope.targetId).descriptor;
        worktreeRoot = session.worktree?.path ?? target.workspaceRoot;
        let offset = 0;
        for (;;) {
          const page = this.#store.listOperations({ sessionId: scope.sessionId,
            status: "started", limit: 500, offset });
          const conflict = page.find(operation => operation.id !== operationId &&
            CONFLICTING_KINDS.has(operation.kind));
          if (conflict) throw new OperationInProgressError(conflict.id);
          if (page.length < 500) break;
          offset += page.length;
        }
      });
    } catch (error) {
      if (error instanceof OperationPreviouslyFailedError) {
        const stored = error.storedError;
        const code = record(stored) && typeof stored["code"] === "string"
          ? stored["code"] : "BUILD_OUTCOME_UNKNOWN";
        throw new SimulatorAppBuildError(code, "This app build already failed and will not be dispatched again.");
      }
      if (error instanceof OperationConflictError) throw new SimulatorAppBuildError("MUTATION_CONFLICT",
        "Simulator build identity was already used with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorAppBuildError("MUTATION_IN_PROGRESS",
        "Another Simulator effect is in progress.");
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      return { receipt: claim.value, replayed: true };
    }
    if (!instance || !worktreeRoot) throw new Error("Simulator build admission did not resolve task ownership.");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted) return;
      try { this.#ownership.heartbeatRoute(scope, route); }
      catch (error) { heartbeatError = error; controller.abort(); }
    }, 20_000);
    let derivedPath: string | undefined;
    let copiedPath: string | undefined;
    let completed = false;
    let attempted = false;
    let evicted: SimulatorBuildArtifact[] = [];
    try {
      const project = await this.#builder.inspect(worktreeRoot, input.containerPath);
      if (controller.signal.aborted) throw new SimulatorAppBuildError("MUTATION_CANCELLED", "Simulator build was cancelled before dispatch.");
      this.#ownership.heartbeatRoute(scope, route);
      const currentRoot = this.#currentWorktree(scope);
      if (await realpath(currentRoot) !== project.worktreeRoot) throw new SimulatorOwnershipError(
        "STALE_SCOPE", "Simulator task worktree changed before build.");
      const projectId = randomUUID();
      const managed = join(this.#artifactRoot, "builds", projectId);
      derivedPath = join(managed, "derived");
      await mkdir(derivedPath, { recursive: true, mode: 0o700 });
      if (controller.signal.aborted) throw new SimulatorAppBuildError("MUTATION_CANCELLED", "Simulator build was cancelled before dispatch.");
      this.#ownership.heartbeatRoute(scope, route);
      attempted = true;
      let built: SimulatorProjectBuildResult;
      try {
        built = await this.#builder.build({ worktreeRoot: project.worktreeRoot,
          derivedDataPath: derivedPath, simulatorUdid: instance.simulatorUdid,
          containerPath: project.containerPath, scheme: input.scheme,
          expectedArch: this.#architecture, signal: controller.signal });
      } catch (error) {
        if (error instanceof SimulatorProjectBuildError &&
            (error.code === "APP_BUILD_FAILED" || error.code === "BUILD_OUTCOME_UNKNOWN")) {
          const diagnostics = await this.#rememberDiagnostics(scope, instance.instanceId,
            error.buildLogTail, controller.signal.aborted ? null : error.resultBundlePath,
            error.outputTruncated, [project.worktreeRoot, this.#artifactRoot]);
          throw new SimulatorAppBuildError(controller.signal.aborted || heartbeatError
            ? "BUILD_OUTCOME_UNKNOWN" : error.code,
          controller.signal.aborted || heartbeatError
            ? "Simulator build was interrupted after dispatch." : error.message, diagnostics);
        }
        if (controller.signal.aborted || heartbeatError) throw new SimulatorAppBuildError(
          "BUILD_OUTCOME_UNKNOWN", "Simulator build was interrupted after dispatch.");
        throw error;
      }
      if (controller.signal.aborted || heartbeatError) throw new SimulatorAppBuildError("BUILD_OUTCOME_UNKNOWN",
        "Simulator build ownership changed while Xcode was running.");
      this.#ownership.heartbeatRoute(scope, route);
      if (await realpath(this.#currentWorktree(scope)) !== project.worktreeRoot) throw new SimulatorOwnershipError(
        "STALE_SCOPE", "Simulator task worktree changed while Xcode was running.");
      const diagnostics = await this.#rememberDiagnostics(scope, instance.instanceId,
        built.buildLogTail, built.resultBundlePath, built.outputTruncated,
        [project.worktreeRoot, this.#artifactRoot]);
      const artifactId = randomUUID();
      const artifactDirectory = join(this.#artifactRoot, "artifacts", artifactId);
      copiedPath = join(artifactDirectory, "Application.app");
      let identity: SimulatorAppArtifactIdentity;
      try {
        await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        await cp(built.appPath, copiedPath, { recursive: true, verbatimSymlinks: true });
        identity = await this.#inspectArtifact({ appPath: copiedPath,
          authorizedRoot: artifactDirectory, expectedArch: this.#architecture, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted || heartbeatError) throw new SimulatorAppBuildError(
          "BUILD_OUTCOME_UNKNOWN", "Simulator build ownership changed before artifact inspection.", diagnostics);
        throw new SimulatorAppBuildError(error instanceof SimulatorAppArtifactError ? error.code
          : "APP_ARTIFACT_INVALID", "The built app could not be verified in managed storage.", diagnostics);
      }
      if (controller.signal.aborted || heartbeatError) throw new SimulatorAppBuildError("BUILD_OUTCOME_UNKNOWN",
        "Simulator build ownership changed before artifact registration.");
      this.#ownership.heartbeatRoute(scope, route);
      if (await realpath(this.#currentWorktree(scope)) !== project.worktreeRoot) throw new SimulatorOwnershipError(
        "STALE_SCOPE", "Simulator task worktree changed before artifact registration.");
      const artifact: SimulatorBuildArtifact = { artifactId, sessionId: scope.sessionId,
        targetId: scope.targetId, bindingGeneration: scope.generation,
        instanceId: instance.instanceId, simulatorUdid: instance.simulatorUdid,
        worktreeRootHash: hashRoot(project.worktreeRoot), appPath: identity.appPath,
        bundleId: identity.bundleId, scheme: built.scheme, projectKind: built.kind,
        createdAt: new Date(this.#now()).toISOString() };
      const receipt: SimulatorBuildReceipt = { artifact: { artifactId, bundleId: artifact.bundleId,
        scheme: artifact.scheme, projectKind: artifact.projectKind, createdAt: artifact.createdAt },
        diagnostics };
      this.#store.transaction(() => {
        this.#ownership.requireRoute(scope, route);
        const existing = this.#loadArtifacts();
        const sameInstance = existing.artifacts.filter(item => item.instanceId === instance!.instanceId);
        evicted = sameInstance.length >= 2 ? [sameInstance[0]!] : [];
        const retained = existing.artifacts.filter(item => !evicted.includes(item));
        if (retained.length >= MAX_ARTIFACTS) {
          const oldest = retained[0]!;
          evicted.push(oldest);
        }
        this.#store.setSetting(STORE_SCOPE, STORE_ID, STORE_KEY,
          { format: 1, artifacts: [...existing.artifacts.filter(item => !evicted.includes(item)),
            artifact] } satisfies StoredArtifacts);
        this.#store.completeDeferredEffectOperation(operationId, claim.operation.bodyHash, () => receipt);
      });
      completed = true;
      await Promise.all(evicted.map(item => this.#discardArtifact(item)));
      return { receipt, replayed: false };
    } catch (error) {
      const safe = this.#safeFailure(error, attempted, controller.signal);
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* Recovery tombstones a started effect after process loss. */ }
      throw safe;
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onAbort);
      if (!completed && copiedPath) await discardManagedChild(
        join(this.#artifactRoot, "artifacts"), dirname(copiedPath));
      if (derivedPath) await discardManagedChild(join(this.#artifactRoot, "builds"), dirname(derivedPath));
    }
  }

  async readDiagnostics(scope: SimulatorTaskScope, diagnosticsId: string,
    source: "build-log" | "xcresult", offset = 0, limit = 16 * 1024): Promise<{
      readonly diagnosticsId: string; readonly source: "build-log" | "xcresult";
      readonly offset: number; readonly limit: number; readonly text: string;
      readonly nextOffset: number; readonly eof: boolean; readonly available: boolean }> {
    if (!UUID.test(diagnosticsId) || source !== "build-log" && source !== "xcresult" ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 64 * 1024) throw new SimulatorAppBuildError("INVALID_ARGUMENT",
      "Simulator build diagnostics request is invalid.");
    this.#ownership.assertScope(scope);
    this.#pruneDiagnostics();
    const item = this.#diagnostics.get(diagnosticsId);
    if (!item || item.sessionId !== scope.sessionId ||
        !this.#ownership.listForTask(scope).some(instance => instance.instanceId === item.instanceId)) {
      throw new SimulatorAppBuildError("INVALID_ARGUMENT", "Build diagnostics are unavailable for this task.");
    }
    const available = source === "build-log" || item.xcresultText !== null;
    const text = available ? source === "build-log" ? item.buildLogTail : item.xcresultText! : "";
    const chunk = text.slice(offset, offset + limit);
    return { diagnosticsId, source, offset, limit, text: chunk,
      nextOffset: offset + chunk.length, eof: offset + chunk.length >= text.length, available };
  }

  #currentWorktree(scope: SimulatorTaskScope): string {
    const session = this.#store.getSession(scope.sessionId).descriptor;
    const target = this.#store.getTarget(scope.targetId).descriptor;
    if (session.targetId !== scope.targetId || session.binding.generation !== scope.generation ||
        session.deletedAt !== undefined || session.archived || !target.trusted ||
        target.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined ||
        session.worktree?.state !== undefined && session.worktree.state !== "active") {
      throw new SimulatorOwnershipError("STALE_SCOPE", "Simulator task worktree is no longer active.");
    }
    return session.worktree?.path ?? target.workspaceRoot;
  }

  async #rememberDiagnostics(scope: SimulatorTaskScope, instanceId: string,
    log: string, resultBundlePath: string | null, outputTruncated: boolean,
    privateRoots: readonly string[]):
    Promise<SimulatorBuildDiagnosticsSummary> {
    let xcresultText: string | null = null;
    if (resultBundlePath) {
      try { xcresultText = publicBuildText(await this.#builder.readXcresult(resultBundlePath), privateRoots); }
      catch { /* build log remains available */ }
    }
    this.#pruneDiagnostics();
    const diagnosticsId = randomUUID();
    const buildLogTail = publicBuildText(log, privateRoots);
    this.#diagnostics.set(diagnosticsId, { sessionId: scope.sessionId, instanceId,
      createdAt: this.#now(), buildLogTail, xcresultText, outputTruncated });
    while (this.#diagnostics.size > MAX_DIAGNOSTICS) this.#diagnostics.delete(this.#diagnostics.keys().next().value!);
    return { diagnosticsId, buildLogTail, xcresultAvailable: xcresultText !== null, outputTruncated };
  }

  #pruneDiagnostics(): void {
    const now = this.#now();
    for (const [id, item] of this.#diagnostics) {
      if (now - item.createdAt > DIAGNOSTICS_TTL_MS) this.#diagnostics.delete(id);
    }
  }

  #loadArtifacts(): StoredArtifacts {
    const value = this.#store.findSetting<unknown>(STORE_SCOPE, STORE_ID, STORE_KEY)?.value;
    if (value === undefined) return { format: 1, artifacts: [] };
    if (!validArtifacts(value)) throw new SimulatorAppBuildError("APP_ARTIFACT_INVALID",
      "Managed Simulator artifact registry is invalid.");
    return value;
  }

  async #discardArtifact(artifact: SimulatorBuildArtifact): Promise<void> {
    const directory = join(this.#artifactRoot, "artifacts", artifact.artifactId);
    if (artifact.appPath !== join(directory, "Application.app")) return;
    await discardManagedChild(join(this.#artifactRoot, "artifacts"), directory);
  }

  #safeFailure(error: unknown, attempted: boolean, signal: AbortSignal): Error {
    if (error instanceof SimulatorAppBuildError) return error;
    if (error instanceof SimulatorProjectBuildError && error.code === "BUILD_OUTCOME_UNKNOWN") {
      return new SimulatorAppBuildError("BUILD_OUTCOME_UNKNOWN", error.message);
    }
    if (error instanceof SimulatorProjectBuildError) return new SimulatorAppBuildError(error.code, error.message);
    if (error instanceof SimulatorAppArtifactError) return new SimulatorAppBuildError(error.code, error.message);
    if (!attempted && error instanceof SimulatorOwnershipError) return error;
    if (!attempted && signal.aborted) return new SimulatorAppBuildError("MUTATION_CANCELLED",
      "Simulator build was cancelled before dispatch.");
    return new SimulatorAppBuildError("BUILD_OUTCOME_UNKNOWN",
      "Simulator build outcome is unknown; inspect task and build state before retrying.");
  }
}
