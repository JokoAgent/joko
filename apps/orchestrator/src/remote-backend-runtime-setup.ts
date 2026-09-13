import type { RemoteProcessTransportPort } from "@joko/remote-ssh";
import type { OperationalStore, RemoteHostRecord, StoredTarget } from "@joko/store";

import {
  REMOTE_CODEX_EXPECTED_VERSION,
  RemoteCodexInstallationError,
  installRemoteCodex,
  probeRemoteCodexInstallation,
  uninstallRemoteCodex,
  type RemoteCodexInstallPhase
} from "./remote-codex-installation.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

const MAXIMUM_TERMINAL_REQUESTS = 128;

export type RemoteBackendRuntimeState =
  | "probing"
  | "not_installed"
  | "installing"
  | "ready"
  | "failed"
  | "outcome_unknown";

export type RemoteBackendRuntimeFailureCode =
  | "aborted"
  | "authority_changed"
  | "host_not_ready"
  | "not_supported"
  | "probe_failed"
  | "install_failed"
  | "uninstall_failed"
  | "busy";

export type RemoteBackendRuntimeInstallPhase =
  | "probing"
  | "downloading"
  | "installing"
  | "validating"
  | "complete"
  | "failed"
  | "outcome_unknown";

export interface RemoteBackendRuntimeFailure {
  readonly code: RemoteBackendRuntimeFailureCode;
  readonly retryable: boolean;
}

export interface RemoteBackendRuntimeSnapshot {
  readonly targetId: string;
  readonly hostId: string;
  readonly displayName: string;
  readonly expectedVersion: string;
  readonly installedVersion?: string;
  readonly state: RemoteBackendRuntimeState;
  readonly canInstall: boolean;
  readonly canReinstall: boolean;
  readonly canUninstall: boolean;
  readonly failure?: RemoteBackendRuntimeFailure;
  readonly observedAt: number;
  readonly targetRevision: bigint;
  readonly hostRevision: bigint;
}

export interface RemoteBackendRuntimeInstallEvent {
  readonly requestId: string;
  readonly sequence: bigint;
  readonly phase: RemoteBackendRuntimeInstallPhase;
  readonly runtime: RemoteBackendRuntimeSnapshot;
  readonly observedAt: number;
}

export interface RemoteBackendRuntimeMutationInput {
  readonly requestId: string;
  readonly targetId: string;
  readonly hostId: string;
  readonly expectedTargetRevision: bigint;
  readonly expectedHostRevision: bigint;
}

export interface RemoteBackendRuntimeInstallInput extends RemoteBackendRuntimeMutationInput {
  readonly reinstall: boolean;
}

interface ProviderProbe {
  readonly state: "ready" | "not_installed";
  readonly installedVersion?: string;
}

interface ProviderContext {
  readonly processes: RemoteProcessTransportPort;
  readonly assertCurrent: () => void;
}

export interface RemoteBackendRuntimeSetupProvider {
  readonly backendId: string;
  readonly displayName: string;
  readonly expectedVersion: string;
  probe(context: ProviderContext, signal?: AbortSignal): Promise<ProviderProbe>;
  install(
    context: ProviderContext,
    reinstall: boolean,
    signal: AbortSignal,
    onPhase: (phase: Exclude<RemoteBackendRuntimeInstallPhase, "failed" | "outcome_unknown">) => void
  ): Promise<ProviderProbe>;
  uninstall(context: ProviderContext, signal: AbortSignal): Promise<ProviderProbe>;
}

export class RemoteBackendRuntimeSetupError extends Error {
  readonly code: RemoteBackendRuntimeFailureCode;

  constructor(code: RemoteBackendRuntimeFailureCode, message: string) {
    super(message);
    this.name = "RemoteBackendRuntimeSetupError";
    this.code = code;
  }
}

interface Admission {
  readonly target: StoredTarget;
  readonly host: RemoteHostRecord;
  readonly provider: RemoteBackendRuntimeSetupProvider;
  readonly resourceKey: string;
}

interface CapturedAdmission extends Admission {
  readonly context: ProviderContext;
}

interface InstallFlight {
  readonly input: RemoteBackendRuntimeInstallInput;
  readonly fingerprint: string;
  readonly admission: Admission;
  readonly controller: AbortController;
  readonly events: RemoteBackendRuntimeInstallEvent[];
  readonly listeners: Set<() => void>;
  readonly completion: Promise<void>;
  terminal: boolean;
}

interface UninstallRequest {
  readonly fingerprint: string;
  readonly resourceKey: string;
  readonly controller: AbortController;
  readonly result: Promise<RemoteBackendRuntimeSnapshot>;
  terminal: boolean;
}

export interface RemoteBackendRuntimeSetupManagerOptions {
  readonly store: Pick<OperationalStore, "getTarget">;
  readonly registry: Pick<RemoteHostRegistry, "get" | "captureProcessAuthority">;
  readonly providers: readonly RemoteBackendRuntimeSetupProvider[];
  readonly now?: () => number;
}

/**
 * Target-derived, capability-neutral owner for remote Backend runtime setup.
 * Mutations survive observer disconnects and are serialized by remote identity.
 */
export class RemoteBackendRuntimeSetupManager {
  readonly #store: Pick<OperationalStore, "getTarget">;
  readonly #registry: Pick<RemoteHostRegistry, "get" | "captureProcessAuthority">;
  readonly #providers: ReadonlyMap<string, RemoteBackendRuntimeSetupProvider>;
  readonly #now: () => number;
  readonly #activeInstalls = new Map<string, InstallFlight>();
  readonly #installRequests = new Map<string, InstallFlight>();
  readonly #activeUninstalls = new Map<string, UninstallRequest>();
  readonly #uninstallRequests = new Map<string, UninstallRequest>();
  #closed = false;

  constructor(options: RemoteBackendRuntimeSetupManagerOptions) {
    const providers = new Map<string, RemoteBackendRuntimeSetupProvider>();
    for (const provider of options.providers) {
      if (providers.has(provider.backendId)) throw new Error("A remote Backend runtime setup provider was registered twice.");
      providers.set(provider.backendId, provider);
    }
    this.#store = options.store;
    this.#registry = options.registry;
    this.#providers = providers;
    this.#now = options.now ?? Date.now;
  }

  supportsTarget(targetId: string): boolean {
    if (this.#closed) return false;
    try {
      return this.#providers.has(this.#store.getTarget(targetId).descriptor.backendId);
    } catch {
      return false;
    }
  }

  async probe(
    input: Omit<RemoteBackendRuntimeMutationInput, "requestId">,
    signal?: AbortSignal
  ): Promise<RemoteBackendRuntimeSnapshot> {
    this.#assertOpen();
    const admission = this.#admit(input);
    const active = this.#activeInstalls.get(admission.resourceKey);
    if (active !== undefined && sameScope(active.input, input)) {
      return active.events.at(-1)?.runtime ?? this.#snapshot(admission, "probing");
    }
    if (this.#activeUninstalls.has(admission.resourceKey)) {
      throw new RemoteBackendRuntimeSetupError("busy", "A remote Backend runtime mutation is already active.");
    }
    const captured = await this.#capture(admission, signal);
    try {
      const probe = await captured.provider.probe(captured.context, signal);
      captured.context.assertCurrent();
      return this.#fromProbe(captured, probe);
    } catch {
      if (signal?.aborted) throw new RemoteBackendRuntimeSetupError("aborted", "The remote Backend runtime probe was cancelled.");
      if (this.#authorityLost(captured)) throw authorityFault();
      return this.#snapshot(captured, "failed", undefined, "probe_failed");
    }
  }

  install(input: RemoteBackendRuntimeInstallInput, signal?: AbortSignal): AsyncIterable<RemoteBackendRuntimeInstallEvent> {
    this.#assertOpen();
    const fingerprint = installFingerprint(input);
    let flight = this.#installRequests.get(input.requestId);
    if (flight !== undefined) {
      if (flight.fingerprint !== fingerprint) throw requestReuseFault();
    } else {
      const admission = this.#admit(input);
      if (this.#activeInstalls.has(admission.resourceKey) || this.#activeUninstalls.has(admission.resourceKey)) {
        throw new RemoteBackendRuntimeSetupError("busy", "A remote Backend runtime mutation is already active.");
      }
      const controller = new AbortController();
      const mutable = {
        input: Object.freeze({ ...input }),
        fingerprint,
        admission,
        controller,
        events: [],
        listeners: new Set<() => void>(),
        terminal: false
      } as Omit<InstallFlight, "completion"> & { completion?: Promise<void> };
      flight = mutable as InstallFlight;
      mutable.completion = this.#runInstall(flight);
      flight = mutable as InstallFlight;
      this.#activeInstalls.set(admission.resourceKey, flight);
      this.#installRequests.set(input.requestId, flight);
    }
    return this.#observe(flight, signal);
  }

  async uninstall(input: RemoteBackendRuntimeMutationInput): Promise<RemoteBackendRuntimeSnapshot> {
    this.#assertOpen();
    const fingerprint = mutationFingerprint(input);
    let request = this.#uninstallRequests.get(input.requestId);
    if (request !== undefined) {
      if (request.fingerprint !== fingerprint) throw requestReuseFault();
      return request.result;
    }
    const admission = this.#admit(input);
    if (this.#activeInstalls.has(admission.resourceKey) || this.#activeUninstalls.has(admission.resourceKey)) {
      throw new RemoteBackendRuntimeSetupError("busy", "A remote Backend runtime mutation is already active.");
    }
    const controller = new AbortController();
    const mutable = {
      fingerprint,
      resourceKey: admission.resourceKey,
      controller,
      terminal: false
    } as Omit<UninstallRequest, "result"> & { result?: Promise<RemoteBackendRuntimeSnapshot> };
    mutable.result = this.#runUninstall(admission, controller.signal).finally(() => {
      mutable.terminal = true;
      if (this.#activeUninstalls.get(admission.resourceKey) === mutable) this.#activeUninstalls.delete(admission.resourceKey);
      this.#pruneRequests();
    });
    request = mutable as UninstallRequest;
    this.#activeUninstalls.set(admission.resourceKey, request);
    this.#uninstallRequests.set(input.requestId, request);
    return request.result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const installs = [...this.#activeInstalls.values()];
    const uninstalls = [...this.#activeUninstalls.values()];
    for (const flight of installs) flight.controller.abort();
    for (const request of uninstalls) request.controller.abort();
    await Promise.allSettled([
      ...installs.map((flight) => flight.completion),
      ...uninstalls.map((request) => request.result)
    ]);
  }

  async #runInstall(flight: InstallFlight): Promise<void> {
    let captured: CapturedAdmission | undefined;
    let effectStarted = false;
    try {
      this.#emit(flight, "probing", this.#snapshot(flight.admission, "probing"));
      captured = await this.#capture(flight.admission, flight.controller.signal);
      const probe = await captured.provider.probe(captured.context, flight.controller.signal);
      captured.context.assertCurrent();
      if (probe.state === "ready" && !flight.input.reinstall) {
        this.#emit(flight, "complete", this.#fromProbe(captured, probe));
        return;
      }
      effectStarted = true;
      const installed = await captured.provider.install(
        captured.context,
        flight.input.reinstall,
        flight.controller.signal,
        (phase) => {
          if (phase === "complete") return;
          const state = phase === "probing" ? "probing" : "installing";
          this.#emit(flight, phase, this.#snapshot(captured!, state, probe.installedVersion));
        }
      );
      captured.context.assertCurrent();
      if (installed.state !== "ready") {
        this.#emit(flight, "failed", this.#fromProbe(captured, installed, "install_failed"));
        return;
      }
      this.#emit(flight, "complete", this.#fromProbe(captured, installed));
    } catch (error) {
      if (effectStarted && this.#authorityLost(captured)) {
        this.#emit(flight, "outcome_unknown", this.#snapshot(flight.admission, "outcome_unknown", undefined, "authority_changed"));
        return;
      }
      const code = runtimeFailureCode(error, "install_failed", flight.controller.signal);
      let fallback: ProviderProbe | undefined;
      if (captured !== undefined && !this.#authorityLost(captured) && code !== "busy") {
        try { fallback = await captured.provider.probe(captured.context); } catch { /* The bounded failure projection below is authoritative. */ }
      }
      if (fallback === undefined && remoteEffectMayHaveChanged(error, effectStarted) && code !== "busy") {
        this.#emit(flight, "outcome_unknown", this.#snapshot(captured ?? flight.admission, "outcome_unknown", undefined, code));
      } else {
        const runtime = fallback === undefined
          ? this.#snapshot(captured ?? flight.admission, "failed", undefined, code)
          : this.#fromProbe(captured!, fallback, code);
        this.#emit(flight, "failed", runtime);
      }
    } finally {
      flight.terminal = true;
      if (this.#activeInstalls.get(flight.admission.resourceKey) === flight) this.#activeInstalls.delete(flight.admission.resourceKey);
      this.#wake(flight);
      this.#pruneRequests();
    }
  }

  async #runUninstall(admission: Admission, signal: AbortSignal): Promise<RemoteBackendRuntimeSnapshot> {
    let captured: CapturedAdmission | undefined;
    let effectStarted = false;
    try {
      captured = await this.#capture(admission, signal);
      effectStarted = true;
      const probe = await captured.provider.uninstall(captured.context, signal);
      captured.context.assertCurrent();
      return this.#fromProbe(captured, probe);
    } catch (error) {
      if (effectStarted && this.#authorityLost(captured)) {
        return this.#snapshot(admission, "outcome_unknown", undefined, "authority_changed");
      }
      const code = runtimeFailureCode(error, "uninstall_failed", signal);
      let fallback: ProviderProbe | undefined;
      if (captured !== undefined && !this.#authorityLost(captured) && code !== "busy") {
        try { fallback = await captured.provider.probe(captured.context); } catch { /* Return a closed failure below. */ }
      }
      if (fallback === undefined && remoteEffectMayHaveChanged(error, effectStarted) && code !== "busy") {
        return this.#snapshot(captured ?? admission, "outcome_unknown", undefined, code);
      }
      return fallback === undefined
        ? this.#snapshot(captured ?? admission, "failed", undefined, code)
        : this.#fromProbe(captured!, fallback, code);
    }
  }

  async *#observe(flight: InstallFlight, signal?: AbortSignal): AsyncGenerator<RemoteBackendRuntimeInstallEvent> {
    let offset = 0;
    while (true) {
      while (offset < flight.events.length && !signal?.aborted) yield flight.events[offset++]!;
      if (flight.terminal || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", wake);
          flight.listeners.delete(wake);
          resolve();
        };
        flight.listeners.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        if (flight.terminal || signal?.aborted) wake();
      });
    }
  }

  #emit(
    flight: InstallFlight,
    phase: RemoteBackendRuntimeInstallPhase,
    runtime: RemoteBackendRuntimeSnapshot
  ): void {
    if (flight.terminal) return;
    const observedAt = this.#now();
    flight.events.push(Object.freeze({
      requestId: flight.input.requestId,
      sequence: BigInt(flight.events.length + 1),
      phase,
      runtime: Object.freeze({ ...runtime, observedAt }),
      observedAt
    }));
    this.#wake(flight);
  }

  #wake(flight: InstallFlight): void {
    const listeners = [...flight.listeners];
    flight.listeners.clear();
    for (const listener of listeners) listener();
  }

  #admit(input: {
    readonly targetId: string;
    readonly hostId: string;
    readonly expectedTargetRevision: bigint;
    readonly expectedHostRevision: bigint;
  }): Admission {
    this.#assertOpen();
    const target = this.#store.getTarget(input.targetId);
    if (target.revision !== input.expectedTargetRevision) throw authorityFault();
    const provider = this.#providers.get(target.descriptor.backendId);
    if (provider === undefined) throw new RemoteBackendRuntimeSetupError("not_supported", "The Target Backend has no remote runtime setup provider.");
    if (!target.descriptor.trusted) throw new RemoteBackendRuntimeSetupError("host_not_ready", "The Target is not trusted for remote runtime setup.");
    const host = this.#registry.get(input.targetId, input.hostId);
    if (host.revision !== input.expectedHostRevision) throw authorityFault();
    if (host.status.state !== "ready" || host.trust === undefined) {
      throw new RemoteBackendRuntimeSetupError("host_not_ready", "The Remote Host must be ready and pinned.");
    }
    return Object.freeze({ target, host, provider, resourceKey: runtimeResourceKey(provider, host) });
  }

  async #capture(admission: Admission, signal?: AbortSignal): Promise<CapturedAdmission> {
    if (signal?.aborted) throw new RemoteBackendRuntimeSetupError("aborted", "The remote Backend runtime request was cancelled.");
    const authority = await this.#registry.captureProcessAuthority(
      admission.target.descriptor.id,
      admission.host.id,
      signal
    );
    const processes = authority.lease.processes;
    if (authority.hostRevision !== admission.host.revision || processes === undefined) throw authorityFault();
    const assertCurrent = (): void => {
      this.#assertOpen();
      const target = this.#store.getTarget(admission.target.descriptor.id);
      if (target.revision !== admission.target.revision
        || target.descriptor.backendId !== admission.provider.backendId
        || !target.descriptor.trusted) throw authorityFault();
      authority.assertCurrent();
    };
    assertCurrent();
    return Object.freeze({ ...admission, context: Object.freeze({ processes, assertCurrent }) });
  }

  #authorityLost(admission: CapturedAdmission | undefined): boolean {
    if (admission === undefined) return false;
    try {
      admission.context.assertCurrent();
      return false;
    } catch {
      return true;
    }
  }

  #fromProbe(
    admission: Admission,
    probe: ProviderProbe,
    failureCode?: RemoteBackendRuntimeFailureCode
  ): RemoteBackendRuntimeSnapshot {
    return this.#snapshot(
      admission,
      probe.state,
      probe.installedVersion,
      failureCode
    );
  }

  #snapshot(
    admission: Admission,
    state: RemoteBackendRuntimeState,
    installedVersion?: string,
    failureCode?: RemoteBackendRuntimeFailureCode
  ): RemoteBackendRuntimeSnapshot {
    return Object.freeze({
      targetId: admission.target.descriptor.id,
      hostId: admission.host.id,
      displayName: admission.provider.displayName,
      expectedVersion: admission.provider.expectedVersion,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      state,
      canInstall: state === "not_installed" || state === "failed" || state === "outcome_unknown",
      canReinstall: state === "ready",
      canUninstall: state === "ready",
      ...(failureCode === undefined ? {} : { failure: failure(failureCode) }),
      observedAt: this.#now(),
      targetRevision: admission.target.revision,
      hostRevision: admission.host.revision
    });
  }

  #pruneRequests(): void {
    pruneTerminal(this.#installRequests, MAXIMUM_TERMINAL_REQUESTS);
    pruneTerminal(this.#uninstallRequests, MAXIMUM_TERMINAL_REQUESTS);
  }

  #assertOpen(): void {
    if (this.#closed) throw new RemoteBackendRuntimeSetupError("aborted", "The remote Backend runtime setup owner is closed.");
  }
}

export function createRemoteCodexRuntimeSetupProvider(backendId: string): RemoteBackendRuntimeSetupProvider {
  const provider: RemoteBackendRuntimeSetupProvider = {
    backendId,
    displayName: "Codex",
    expectedVersion: REMOTE_CODEX_EXPECTED_VERSION,
    probe: async (context, signal) => setupProbe(await probeRemoteCodexInstallation(context.processes, "/", context.assertCurrent, signal)),
    install: async (context, reinstall, signal, onPhase) => setupProbe(await installRemoteCodex(context.processes, {
      reinstall,
      assertCurrent: context.assertCurrent,
      signal,
      onPhase: (phase: RemoteCodexInstallPhase) => onPhase(phase)
    })),
    uninstall: async (context, signal) => setupProbe(await uninstallRemoteCodex(context.processes, context.assertCurrent, signal))
  };
  return Object.freeze(provider);
}

function setupProbe(value: { readonly state: "ready" | "not_installed"; readonly installedVersion?: string }): ProviderProbe {
  return Object.freeze({ state: value.state, ...(value.installedVersion === undefined ? {} : { installedVersion: value.installedVersion }) });
}

function runtimeResourceKey(provider: RemoteBackendRuntimeSetupProvider, host: RemoteHostRecord): string {
  return JSON.stringify([
    provider.backendId,
    host.hostname,
    host.port,
    host.user,
    host.trust?.algorithm ?? "",
    host.trust?.fingerprint ?? ""
  ]);
}

function sameScope(
  left: Pick<RemoteBackendRuntimeInstallInput, "targetId" | "hostId" | "expectedTargetRevision" | "expectedHostRevision">,
  right: Pick<RemoteBackendRuntimeInstallInput, "targetId" | "hostId" | "expectedTargetRevision" | "expectedHostRevision">
): boolean {
  return left.targetId === right.targetId && left.hostId === right.hostId
    && left.expectedTargetRevision === right.expectedTargetRevision
    && left.expectedHostRevision === right.expectedHostRevision;
}

function installFingerprint(input: RemoteBackendRuntimeInstallInput): string {
  return `${mutationFingerprint(input)}\u0000${input.reinstall ? "1" : "0"}`;
}

function mutationFingerprint(input: RemoteBackendRuntimeMutationInput): string {
  return `${input.targetId}\u0000${input.hostId}\u0000${input.expectedTargetRevision}\u0000${input.expectedHostRevision}`;
}

function requestReuseFault(): RemoteBackendRuntimeSetupError {
  return new RemoteBackendRuntimeSetupError("authority_changed", "A remote Backend runtime request ID was reused with different authority.");
}

function authorityFault(): RemoteBackendRuntimeSetupError {
  return new RemoteBackendRuntimeSetupError("authority_changed", "Remote Backend runtime authority changed; refresh before retrying.");
}

function runtimeFailureCode(
  error: unknown,
  fallback: "install_failed" | "uninstall_failed",
  signal: AbortSignal
): RemoteBackendRuntimeFailureCode {
  if (error instanceof RemoteBackendRuntimeSetupError) return error.code;
  if (error instanceof RemoteCodexInstallationError && error.code === "busy") return "busy";
  return signal.aborted ? "aborted" : fallback;
}

function remoteEffectMayHaveChanged(error: unknown, effectStarted: boolean): boolean {
  if (!effectStarted) return false;
  return !(error instanceof RemoteCodexInstallationError) || error.stateMayHaveChanged;
}

function failure(code: RemoteBackendRuntimeFailureCode): RemoteBackendRuntimeFailure {
  return Object.freeze({ code, retryable: code !== "not_supported" });
}

function pruneTerminal<T extends { readonly terminal: boolean }>(requests: Map<string, T>, limit: number): void {
  if (requests.size <= limit) return;
  for (const [id, request] of requests) {
    if (!request.terminal) continue;
    requests.delete(id);
    if (requests.size <= limit) return;
  }
}
