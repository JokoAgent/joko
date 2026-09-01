import { randomUUID } from "node:crypto";

import type { OperationalStore } from "@joko/store";
import type { ProviderModel } from "@joko/core";
import type { PiSupportedApi } from "@joko/adapter-pi";

import {
  ProviderAuthUnsupportedError,
  type NativePiAuthLoadResult,
  type NativePiAuthPersistResult,
  type NativeProviderAuthRegistration,
  type ProviderCatalogManager,
  type ProviderLoginFlow,
  type ProviderNativeAuthSupervisor
} from "./credential-manager.js";
import { clearProviderRateLimit } from "./provider-rate-limit.js";

export interface PiOAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export interface PiApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type PiCredential = PiOAuthCredential | PiApiKeyCredential;

export interface PiCredentialStore {
  read(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<PiCredential | undefined>;
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly { readonly providerId: string; readonly type: PiCredential["type"] }[]>;
  modify(
    providerId: string,
    callback: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    options?: { readonly signal?: AbortSignal }
  ): Promise<PiCredential | undefined>;
  delete(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export type PiAuthPrompt = {
  readonly signal?: AbortSignal;
} & ({
  readonly type: "text" | "secret" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
} | {
  readonly type: "select";
  readonly message: string;
  readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
});

export type PiAuthEvent = {
  readonly type: "auth_url";
  readonly url: string;
  readonly instructions?: string;
} | {
  readonly type: "device_code";
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds?: number;
} | {
  readonly type: "info" | "progress";
  readonly message: string;
};

export interface PiAuthInteraction {
  readonly signal?: AbortSignal;
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
}

export interface PiNativeOAuthProvider {
  readonly id: string;
  readonly name?: string;
  getModels(): readonly {
    readonly id: string;
    readonly name?: string;
    readonly api?: string;
    readonly provider?: string;
    readonly reasoning?: boolean;
    readonly input?: readonly string[];
    readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
    readonly cost?: {
      readonly input?: number;
      readonly output?: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
    };
    readonly contextWindow: number;
    readonly maxTokens: number;
  }[];
  readonly refreshModels?: unknown;
  readonly auth: {
    readonly apiKey?: {
      readonly name?: string;
    };
    readonly oauth?: {
      readonly isSubscription?: boolean;
      refresh(credential: PiOAuthCredential, signal: AbortSignal): Promise<PiOAuthCredential>;
    };
  };
}

/** Narrow structural surface used both by the installed ModelRuntime and offline fakes. */
export interface PiProviderAuthRuntime {
  getProviders(): readonly PiNativeOAuthProvider[];
  getProvider(providerId: string): PiNativeOAuthProvider | undefined;
  login(providerId: string, type: "api_key" | "oauth", interaction: PiAuthInteraction): Promise<PiCredential>;
  logout(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  refresh?(options?: {
    readonly allowNetwork?: boolean;
    readonly providers?: readonly string[];
    readonly force?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface ProviderModelCatalogRefreshResult {
  readonly refreshedProviderIds: readonly string[];
  readonly skippedProviderIds: readonly string[];
  readonly addedModelCount: number;
}

export type PiProviderAuthFlowState =
  | "starting"
  | "pending"
  | "completed"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown"
  | "error";

export class PiProviderAuthFlowCapacityError extends Error {
  readonly code = "PROVIDER_AUTH_FLOW_CAPACITY";

  constructor(readonly maximumActiveFlows: number) {
    super("The maximum number of concurrent Provider authentication flows is already active.");
    this.name = "PiProviderAuthFlowCapacityError";
  }
}

export type PiProviderAuthPromptKind = "text" | "secret" | "manual_code" | "select";

export interface PiProviderAuthPromptOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** Public, non-secret prompt metadata. The answer is never stored here. */
export interface PiProviderAuthPromptRecord {
  readonly promptId: string;
  readonly kind: PiProviderAuthPromptKind;
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly PiProviderAuthPromptOption[];
  readonly createdAt: number;
}

export type PiProviderAuthPromptAnswer =
  | { readonly case: "choice"; readonly optionId: string }
  | { readonly case: "text"; readonly text: string }
  | { readonly case: "credential_upload"; readonly credentialUploadTicketId: string };

export interface PiProviderAuthFlowRecord extends ProviderLoginFlow {
  readonly state: PiProviderAuthFlowState;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly pendingPrompt?: PiProviderAuthPromptRecord;
  /** Stable, pre-redacted status; never an upstream error string. */
  readonly error?: string;
}

export interface PiProviderAuthSupervisorOptions {
  readonly store: OperationalStore;
  readonly backendId: string;
  readonly providers: ProviderCatalogManager;
  readonly refreshPiGeneration: () => Promise<void>;
  readonly now?: () => number;
  readonly flowTimeoutMs?: number;
  readonly scopeId?: string;
  readonly runtimeFactory?: (credentials: PiCredentialStore) => Promise<PiProviderAuthRuntime>;
}

interface StoredFlowCatalog {
  readonly format: 1;
  readonly flows: readonly PiProviderAuthFlowRecord[];
  /** Interrupted flows remain protected until an explicit retry for the same
   * Provider acknowledges their outcome-unknown recovery state. */
  readonly recoveryRequiredFlowIds?: readonly string[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
  settled: boolean;
}

interface ActiveFlow {
  readonly id: string;
  readonly controller: AbortController;
  readonly announcement: Deferred<ProviderLoginFlow>;
  readonly providerActivationVersion?: bigint;
  timer: NodeJS.Timeout;
  pendingPrompt?: ActivePrompt;
  completion?: Promise<void>;
}

interface ActivePrompt {
  readonly record: PiProviderAuthPromptRecord;
  readonly response: Deferred<string>;
  readonly cleanup: () => void;
}

const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60_000;
const MAX_RETAINED_TERMINAL_FLOWS = 128;
const MAX_ACTIVE_FLOWS = 256;
const MAX_PERSISTED_FLOWS = MAX_ACTIVE_FLOWS + MAX_RETAINED_TERMINAL_FLOWS;
const MODEL_REFRESH_COOLDOWN_MS = 30 * 60_000;
const MODEL_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;
const MODEL_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Supervises Pi's native authentication implementations. It deliberately does
 * not know provider endpoints, OAuth clients, token exchange formats, API-key
 * resolution rules, or refresh rules: those remain owned by ModelRuntime.
 */
export class PiProviderAuthSupervisor implements ProviderNativeAuthSupervisor {
  readonly #store: OperationalStore;
  readonly #backendId: string;
  readonly #providers: ProviderCatalogManager;
  readonly #refreshPiGeneration: () => Promise<void>;
  readonly #now: () => number;
  readonly #flowTimeoutMs: number;
  readonly #scopeId: string;
  readonly #credentials: PiCredentialStore;
  readonly #flows = new Map<string, PiProviderAuthFlowRecord>();
  readonly #active = new Map<string, ActiveFlow>();
  readonly #recoveryRequired = new Set<string>();
  readonly #credentialTails = new Map<string, Promise<void>>();
  readonly #modelRefreshFlights = new Map<string, {
    readonly promise: Promise<{ readonly added: number; readonly activate: boolean }>;
    readonly forced: boolean;
  }>();
  readonly #modelRefreshAttempts = new Map<string, number>();
  readonly #modelRefreshFailures = new Map<string, number>();
  #runtime: PiProviderAuthRuntime | undefined;
  #nativeModels: readonly ProviderModel[] = [];
  #shuttingDown = false;
  #closed = false;

  private constructor(options: PiProviderAuthSupervisorOptions) {
    this.#store = options.store;
    this.#backendId = options.backendId;
    this.#providers = options.providers;
    this.#refreshPiGeneration = options.refreshPiGeneration;
    this.#now = options.now ?? Date.now;
    this.#flowTimeoutMs = options.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
    this.#scopeId = options.scopeId ?? "orchestrator";
    if (!Number.isSafeInteger(this.#flowTimeoutMs) || this.#flowTimeoutMs < 1_000) {
      throw new RangeError("Pi Provider auth flow timeout must be at least one second.");
    }
    this.#credentials = this.#createCredentialStore();
  }

  static async create(options: PiProviderAuthSupervisorOptions): Promise<PiProviderAuthSupervisor> {
    const supervisor = new PiProviderAuthSupervisor(options);
    const runtimeFactory = options.runtimeFactory ?? createNativePiRuntime;
    supervisor.#runtime = await runtimeFactory(supervisor.#credentials);
    supervisor.#nativeModels = nativeModelCatalog(supervisor.#runtime);
    await options.providers.registerNativeAuthProviders(nativeProviderRegistrations(supervisor.#runtime));
    supervisor.#loadAndFenceInterruptedFlows();
    options.providers.attachNativeAuth(supervisor);
    return supervisor;
  }

  canHandle(providerId: string): boolean {
    if (this.#closed || this.#runtime === undefined) return false;
    try {
      const managed = this.#providers.get(providerId);
      const provider = this.#runtime.getProvider(providerId);
      if (managed.kind === "api_key") return provider?.auth.apiKey !== undefined;
      if (managed.kind !== "oauth" && managed.kind !== "subscription") return false;
      return provider?.auth.oauth !== undefined;
    } catch {
      return false;
    }
  }

  /** Authoritative, network-free built-in model catalog from the installed Pi runtime. */
  listNativeModels(): readonly ProviderModel[] {
    return this.#nativeModels.map(cloneProviderModel);
  }

  supportsModelRefresh(providerId: string): boolean {
    if (this.#closed || this.#runtime === undefined) return false;
    if (this.#providers.canDiscoverProviderModels(providerId)) return true;
    return this.#supportsAutomaticModelRefresh(providerId);
  }

  async refreshModelCatalogs(input: {
    readonly providerId?: string;
    readonly automatic: boolean;
  }): Promise<ProviderModelCatalogRefreshResult> {
    this.#assertDataPlaneOpen();
    const selected = input.providerId === undefined
      ? this.#providers.list().filter((provider) => input.automatic
        ? this.#supportsAutomaticModelRefresh(provider.provider.id)
        : this.supportsModelRefresh(provider.provider.id))
      : [this.#providers.get(input.providerId)];
    if (input.providerId !== undefined && !this.supportsModelRefresh(input.providerId)) {
      throw new Error("This Provider does not expose model catalog refresh.");
    }
    const refreshedProviderIds: string[] = [];
    const skippedProviderIds: string[] = [];
    let addedModelCount = 0;
    let changed = false;
    for (const provider of selected) {
      const providerId = provider.provider.id;
      if (input.automatic && (
        !this.#supportsAutomaticModelRefresh(providerId)
        || (
          provider.authenticationState !== "authenticated"
          && provider.authenticationState !== "not_required"
        )
      )) {
        skippedProviderIds.push(providerId);
        continue;
      }
      try {
        const result = await this.#refreshModelSource(providerId, input.automatic);
        if (result === undefined) {
          skippedProviderIds.push(providerId);
          continue;
        }
        refreshedProviderIds.push(providerId);
        addedModelCount += result.added;
        changed ||= result.activate;
      } catch {
        if (!input.automatic) throw new Error("The Provider model catalog could not be refreshed.");
        skippedProviderIds.push(providerId);
      }
    }
    if (changed) {
      try {
        this.#nativeModels = nativeModelCatalog(this.#requireRuntime());
        await this.#providers.registerNativeAuthProviders(nativeProviderRegistrations(this.#requireRuntime()));
        await this.#refreshPiGeneration();
      } catch {
        if (!input.automatic) throw new Error("The refreshed model catalog could not be activated.");
      }
    }
    return { refreshedProviderIds, skippedProviderIds, addedModelCount };
  }

  async beginLogin(providerId: string, method: ProviderLoginFlow["method"]): Promise<ProviderLoginFlow> {
    this.#assertOpen();
    const runtime = this.#requireRuntime();
    const nativeProvider = runtime.getProvider(providerId);
    const oauth = nativeProvider?.auth.oauth;
    const apiKey = nativeProvider?.auth.apiKey;
    if (method === "api_key" && apiKey === undefined) {
      throw new ProviderAuthUnsupportedError("Pi does not expose native API-key authentication for this Provider.");
    }
    if (method !== "api_key" && oauth === undefined) {
      throw new ProviderAuthUnsupportedError("Pi does not expose native OAuth for this Provider.");
    }
    if (method === "subscription" && oauth?.isSubscription !== true) {
      throw new ProviderAuthUnsupportedError("This Pi Provider does not advertise subscription authentication.");
    }
    if ([...this.#active.values()].some((active) => this.#flows.get(active.id)?.providerId === providerId)) {
      throw new Error("A Provider login is already pending.");
    }
    // Retrying the same Provider explicitly acknowledges any prior interrupted
    // outcome while retaining that record as ordinary bounded history.
    for (const flowId of this.#recoveryRequired) {
      if (this.#flows.get(flowId)?.providerId === providerId) this.#recoveryRequired.delete(flowId);
    }
    const protectedFlowIds = new Set([
      ...this.#recoveryRequired,
      ...[...this.#flows.values()].filter(providerAuthFlowInFlight).map((flow) => flow.opaqueFlowId)
    ]);
    if (protectedFlowIds.size >= MAX_ACTIVE_FLOWS) {
      throw new PiProviderAuthFlowCapacityError(MAX_ACTIVE_FLOWS);
    }

    const now = this.#now();
    const id = `pflow_${randomUUID()}`;
    const record: PiProviderAuthFlowRecord = {
      providerId,
      method,
      opaqueFlowId: id,
      state: "starting",
      startedAt: now,
      updatedAt: now,
      expiresAt: now + this.#flowTimeoutMs
    };
    this.#flows.set(id, record);
    this.#persistFlows();
    this.#providers.setNativeAuthenticationState(providerId, "pending");

    const controller = new AbortController();
    const providerActivationVersion = this.#providers.captureAuthenticatedProviderActivation(providerId);
    const active: ActiveFlow = {
      id,
      controller,
      announcement: deferred<ProviderLoginFlow>(),
      ...(providerActivationVersion === undefined ? {} : { providerActivationVersion }),
      timer: setTimeout(() => controller.abort(new FlowTimedOutError()), this.#flowTimeoutMs)
    };
    this.#active.set(id, active);
    active.completion = this.#runLogin(active, runtime);
    void active.completion.catch(() => undefined);
    // Return the durable flow immediately. Provider discovery/device requests
    // may require network I/O; clients observe URL/code/prompt updates through
    // GetProviderLoginFlow instead of holding the Begin mutation open.
    if (!active.announcement.settled) active.announcement.resolve(toPublicFlow(this.#requireFlow(id)));
    return active.announcement.promise;
  }

  async refreshCredential(providerId: string): Promise<void> {
    this.#assertOpen();
    const runtime = this.#requireRuntime();
    const oauth = runtime.getProvider(providerId)?.auth.oauth;
    if (oauth === undefined) throw new ProviderAuthUnsupportedError("Pi does not expose native OAuth refresh for this Provider.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new FlowTimedOutError()), Math.min(this.#flowTimeoutMs, 60_000));
    try {
      const post = await this.#credentials.modify(providerId, async (current) => {
        if (current?.type !== "oauth") throw new Error("Provider has no native OAuth credential.");
        return validateCredential(await oauth.refresh(current, controller.signal));
      }, { signal: controller.signal });
      if (post === undefined) throw new Error("Provider refresh did not produce a credential.");
      await runtime.refresh?.({ allowNetwork: false, providers: [providerId], signal: controller.signal });
      clearProviderRateLimit(this.#store, this.#backendId, providerId);
      await this.#refreshGenerationSafely(providerId);
      this.#providers.setNativeAuthenticationState(providerId, "authenticated");
    } catch (error) {
      this.#providers.setNativeAuthenticationState(providerId, "error", "Provider credential refresh failed.");
      throw publicAuthError("Provider credential refresh failed.", error);
    } finally {
      clearTimeout(timer);
    }
  }

  async logout(providerId: string): Promise<void> {
    this.#assertOpen();
    const runtime = this.#requireRuntime();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new FlowTimedOutError()), Math.min(this.#flowTimeoutMs, 60_000));
    try {
      await runtime.logout(providerId, { signal: controller.signal });
    } catch (error) {
      // ModelRuntime can report synchronization failure after its authoritative
      // CredentialStore delete. In that case local logout is already complete.
      if (await this.#credentials.read(providerId) !== undefined) {
        throw publicAuthError("Provider logout failed.", error);
      }
    } finally {
      clearTimeout(timer);
    }
    clearProviderRateLimit(this.#store, this.#backendId, providerId);
    await this.#refreshGenerationSafely(providerId);
    this.#providers.setNativeAuthenticationState(providerId, "signed_out");
  }

  loadNativeAuth(input: {
    readonly providerIds: readonly string[];
    readonly expectedCatalogGeneration: number;
  }): NativePiAuthLoadResult {
    this.#assertDataPlaneOpen();
    return this.#providers.loadNativeAuth(input);
  }

  async persistNativeAuth(input: {
    readonly providerId: string;
    readonly credential: unknown;
    readonly expectedCatalogGeneration: number;
    readonly expectedAccountId?: string;
  }): Promise<NativePiAuthPersistResult> {
    this.#assertDataPlaneOpen();
    const result = await this.#providers.persistNativeAuth(input);
    clearProviderRateLimit(this.#store, this.#backendId, input.providerId);
    if (!this.#shuttingDown) await this.#refreshGenerationSafely(input.providerId);
    return result;
  }

  getFlow(flowId: string): PiProviderAuthFlowRecord | undefined {
    const flow = this.#flows.get(flowId);
    return flow === undefined ? undefined : cloneFlow(flow);
  }

  listFlows(providerId?: string): readonly PiProviderAuthFlowRecord[] {
    return [...this.#flows.values()]
      .filter((flow) => providerId === undefined || flow.providerId === providerId)
      .sort((left, right) => right.startedAt - left.startedAt || left.opaqueFlowId.localeCompare(right.opaqueFlowId, "en"))
      .map(cloneFlow);
  }

  beginInputUpload(input: {
    readonly flowId: string;
    readonly promptId: string;
    readonly connectionId: string;
  }): {
    readonly credentialUploadTicketId: string;
    readonly expiresAt: number;
    readonly maximumBytes: number;
  } {
    this.#assertOpen();
    const active = this.#requireActivePrompt(input.flowId, input.promptId);
    if (active.pendingPrompt?.record.kind !== "secret" && active.pendingPrompt?.record.kind !== "manual_code") {
      throw new Error("This Provider login prompt does not accept credential-channel input.");
    }
    return this.#providers.createNativeAuthInputTicket({
      flowId: input.flowId,
      promptId: input.promptId,
      connectionId: input.connectionId
    });
  }

  submitInput(input: {
    readonly flowId: string;
    readonly promptId: string;
    readonly connectionId: string;
    readonly answer: PiProviderAuthPromptAnswer;
  }): PiProviderAuthFlowRecord {
    this.#assertOpen();
    const active = this.#requireActivePrompt(input.flowId, input.promptId);
    const pending = active.pendingPrompt!;
    if (pending.response.settled) throw new Error("Provider login prompt has already been answered.");
    const answer = input.answer;
    let value: string;
    if (pending.record.kind === "select") {
      if (answer.case !== "choice") throw new Error("Provider login selection requires a typed choice.");
      const optionId = answer.optionId;
      const option = pending.record.options?.find((candidate) => candidate.id === optionId);
      if (option === undefined) throw new Error("Provider login selection is not an allowed option.");
      value = option.id;
    } else if (pending.record.kind === "text") {
      if (answer.case !== "text") throw new Error("Provider login text prompt requires a text answer.");
      value = validatePromptAnswer(answer.text, true);
    } else {
      if (answer.case !== "credential_upload") {
        throw new Error("Sensitive Provider login input must use the credential upload channel.");
      }
      value = validatePromptAnswer(this.#providers.consumeNativeAuthInput({
        credentialUploadTicketId: answer.credentialUploadTicketId,
        flowId: input.flowId,
        promptId: input.promptId,
        connectionId: input.connectionId
      }), false);
    }
    this.#clearPendingPrompt(active, pending);
    pending.response.resolve(value);
    return cloneFlow(this.#requireFlow(input.flowId));
  }

  cancel(flowId: string): PiProviderAuthFlowRecord {
    this.#assertOpen();
    const active = this.#active.get(flowId);
    if (active === undefined) throw new Error("Provider login flow is not active.");
    const current = this.#requireFlow(flowId);
    if (current.state !== "starting" && current.state !== "pending") {
      throw new Error("Provider login flow is not active.");
    }
    this.#updateFlow(flowId, {
      state: "cancelled",
      pendingPrompt: undefined,
      error: "Provider login was cancelled."
    });
    this.#providers.setNativeAuthenticationState(current.providerId, "error", "Provider login was cancelled.");
    active.controller.abort(new FlowCancelledError());
    return cloneFlow(this.#requireFlow(flowId));
  }

  /**
   * Fences user mutations while leaving native auth load/persist available for
   * Pi runtimes that are flushing credentials during SessionHost disposal.
   */
  beginShutdown(): void {
    if (this.#closed || this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const active of this.#active.values()) {
      this.#recoveryRequired.add(active.id);
      this.#updateFlow(active.id, {
        state: "outcome_unknown",
        pendingPrompt: undefined,
        error: "Provider login outcome is unknown after the Orchestrator runtime stopped."
      });
      active.controller.abort(new FlowInterruptedError());
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.beginShutdown();
    await Promise.allSettled([...this.#active.values()].map((active) => active.completion));
    this.#active.clear();
    this.#closed = true;
  }

  async #runLogin(active: ActiveFlow, runtime: PiProviderAuthRuntime): Promise<void> {
    const initial = this.#requireFlow(active.id);
    try {
      const returned = validateCredential(await runtime.login(initial.providerId, initial.method === "api_key" ? "api_key" : "oauth", {
        signal: active.controller.signal,
        prompt: (prompt) => this.#answerPrompt(active, prompt, active.controller.signal),
        notify: (event) => this.#handleAuthEvent(active, event)
      }));
      const stored = await this.#credentials.read(initial.providerId);
      if (stored === undefined) {
        const persisted = await this.#credentials.modify(
          initial.providerId,
          async () => returned,
          { signal: active.controller.signal }
        );
        if (persisted === undefined) throw new Error("Provider login did not persist its credential.");
      }
      await this.#providers.activateAuthenticatedProvider(initial.providerId, active.providerActivationVersion);
      clearProviderRateLimit(this.#store, this.#backendId, initial.providerId);
      await this.#refreshGenerationSafely(initial.providerId);
      this.#providers.setNativeAuthenticationState(initial.providerId, "authenticated");
      this.#updateFlow(active.id, { state: "completed", error: undefined });
      if (!active.announcement.settled) active.announcement.resolve(toPublicFlow(this.#requireFlow(active.id)));
    } catch (error) {
      const interrupted = error instanceof FlowInterruptedError || active.controller.signal.reason instanceof FlowInterruptedError;
      const cancelled = error instanceof FlowCancelledError || active.controller.signal.reason instanceof FlowCancelledError;
      const timedOut = error instanceof FlowTimedOutError || active.controller.signal.reason instanceof FlowTimedOutError;
      const stored = await this.#credentials.read(initial.providerId).catch(() => undefined);
      if (interrupted) {
        this.#updateFlow(active.id, {
          state: "outcome_unknown",
          error: "Provider login outcome is unknown after the Orchestrator runtime stopped."
        });
        this.#providers.setNativeAuthenticationState(initial.providerId, "error", "Provider login outcome is unknown after restart.");
      } else if (stored !== undefined) {
        this.#updateFlow(active.id, {
          state: "outcome_unknown",
          error: "Provider credential was saved, but login synchronization did not finish."
        });
        this.#providers.setNativeAuthenticationState(initial.providerId, "error", "Provider credential was saved, but activation outcome is unknown.");
        await this.#refreshGenerationSafely(initial.providerId).catch(() => undefined);
        if (!active.announcement.settled) active.announcement.resolve(toPublicFlow(this.#requireFlow(active.id)));
      } else {
        const state: PiProviderAuthFlowState = cancelled ? "cancelled" : timedOut ? "timed_out" : "error";
        const message = cancelled
          ? "Provider login was cancelled."
          : timedOut ? "Provider login timed out." : safeFlowError(error);
        this.#updateFlow(active.id, { state, error: message });
        this.#providers.setNativeAuthenticationState(initial.providerId, "error", message);
        if (!active.announcement.settled) {
          active.announcement.reject(error instanceof ProviderAuthUnsupportedError
            ? error
            : publicAuthError(message, error));
        }
      }
    } finally {
      clearTimeout(active.timer);
      this.#active.delete(active.id);
      this.#persistFlows();
    }
  }

  #answerPrompt(active: ActiveFlow, prompt: PiAuthPrompt, operationSignal: AbortSignal): Promise<string> {
    operationSignal.throwIfAborted();
    const flow = this.#requireFlow(active.id);
    const promptType = (prompt as { readonly type?: unknown }).type;
    if (promptType !== "text" && promptType !== "secret" && promptType !== "manual_code" && promptType !== "select") {
      throw new ProviderAuthUnsupportedError("The installed Pi runtime requested an unknown Provider login prompt kind.");
    }
    if (prompt.type === "select" && (flow.method === "device_code" || flow.method === "oauth_browser" || flow.method === "subscription")) {
      const wanted = flow.method === "device_code" ? /device/u : /browser/u;
      const selected = prompt.options.find((option) => wanted.test(`${option.id} ${option.label}`.toLocaleLowerCase()));
      if (selected !== undefined) return Promise.resolve(selected.id);
      if (prompt.options.length === 1 && prompt.options[0] !== undefined) return Promise.resolve(prompt.options[0].id);
    }
    return this.#waitForPromptInput(active, prompt, operationSignal);
  }

  #waitForPromptInput(active: ActiveFlow, prompt: PiAuthPrompt, operationSignal: AbortSignal): Promise<string> {
    if (active.pendingPrompt !== undefined) {
      throw new ProviderAuthUnsupportedError("The Provider requested overlapping login prompts.");
    }
    const record = toPromptRecord(prompt, this.#now());
    const response = deferred<string>();
    const signals = [...new Set([operationSignal, prompt.signal].filter((signal): signal is AbortSignal => signal !== undefined))];
    const abort = (): void => {
      const signal = signals.find((candidate) => candidate.aborted);
      response.reject(signal?.reason instanceof Error ? signal.reason : new FlowCancelledError());
    };
    const cleanup = (): void => signals.forEach((signal) => signal.removeEventListener("abort", abort));
    const pending: ActivePrompt = { record, response, cleanup };
    active.pendingPrompt = pending;
    this.#updateFlow(active.id, { state: "pending", pendingPrompt: record });
    if (!active.announcement.settled) active.announcement.resolve(toPublicFlow(this.#requireFlow(active.id)));
    for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
    if (signals.some((signal) => signal.aborted)) abort();
    return response.promise.finally(() => {
      cleanup();
      this.#clearPendingPrompt(active, pending);
    });
  }

  #requireActivePrompt(flowId: string, promptId: string): ActiveFlow {
    const active = this.#active.get(flowId);
    if (active === undefined) throw new Error("Provider login flow is not active.");
    if (active.pendingPrompt?.record.promptId !== promptId) {
      throw new Error("Provider login prompt is stale or does not exist.");
    }
    return active;
  }

  #clearPendingPrompt(active: ActiveFlow, pending: ActivePrompt): void {
    if (active.pendingPrompt !== pending) return;
    active.pendingPrompt = undefined;
    this.#updateFlow(active.id, { pendingPrompt: undefined });
  }

  #handleAuthEvent(active: ActiveFlow, event: PiAuthEvent): void {
    if (event.type === "info" || event.type === "progress") return;
    const current = this.#requireFlow(active.id);
    if (event.type === "auth_url") {
      if (current.method === "device_code") {
        throw new ProviderAuthUnsupportedError("Pi selected browser OAuth for a device-code-only request.");
      }
      const url = safeVerificationUri(event.url);
      this.#updateFlow(active.id, { state: "pending", verificationUri: url });
    } else if (event.type === "device_code") {
      if (current.method === "oauth_browser") {
        throw new ProviderAuthUnsupportedError("Pi selected device-code OAuth for a browser-only request.");
      }
      const userCode = event.userCode.trim();
      if (userCode.length === 0 || userCode.length > 256) throw new Error("Pi returned an invalid device code.");
      const verificationUri = safeVerificationUri(event.verificationUri);
      const providerExpiry = validPositiveNumber(event.expiresInSeconds)
        ? this.#now() + Math.round(event.expiresInSeconds * 1_000)
        : undefined;
      const expiresAt = providerExpiry === undefined
        ? current.expiresAt
        : Math.min(current.expiresAt ?? providerExpiry, providerExpiry);
      this.#updateFlow(active.id, {
        state: "pending",
        verificationUri,
        userCode,
        ...(expiresAt === undefined ? {} : { expiresAt })
      });
      if (expiresAt !== undefined) {
        clearTimeout(active.timer);
        active.timer = setTimeout(
          () => active.controller.abort(new FlowTimedOutError()),
          Math.max(1, expiresAt - this.#now())
        );
      }
    } else throw new ProviderAuthUnsupportedError("The installed Pi runtime emitted an unknown Provider login event kind.");
    if (!active.announcement.settled) active.announcement.resolve(toPublicFlow(this.#requireFlow(active.id)));
  }

  #createCredentialStore(): PiCredentialStore {
    return {
      read: async (providerId, options) => {
        options?.signal?.throwIfAborted();
        const stored = this.#providers.readNativeCredential(providerId);
        options?.signal?.throwIfAborted();
        return stored === undefined ? undefined : parseCredential(stored.serializedCredential);
      },
      list: async (options) => {
        options?.signal?.throwIfAborted();
        const result = this.#providers.list()
          .filter((provider) => provider.nativeCredentialReferenceId !== undefined)
          .map((provider) => {
            const stored = this.#providers.readNativeCredential(provider.provider.id);
            if (stored === undefined) return undefined;
            return { providerId: provider.provider.id, type: parseCredential(stored.serializedCredential).type };
          })
          .filter((item): item is { readonly providerId: string; readonly type: PiCredential["type"] } => item !== undefined);
        options?.signal?.throwIfAborted();
        return result;
      },
      modify: (providerId, callback, options) => this.#withCredentialLock(providerId, async () => {
        options?.signal?.throwIfAborted();
        const stored = this.#providers.readNativeCredential(providerId);
        const current = stored === undefined ? undefined : parseCredential(stored.serializedCredential);
        const next = await callback(current === undefined ? undefined : cloneCredential(current));
        options?.signal?.throwIfAborted();
        if (next === undefined) return current;
        const valid = validateCredential(next);
        const serializedCredential = serializeCredential(valid);
        await this.#providers.writeNativeCredential({
          providerId,
          serializedCredential,
          ...(valid.type === "oauth" ? { expiresAt: valid.expires } : {})
        });
        options?.signal?.throwIfAborted();
        return cloneCredential(valid);
      }),
      delete: (providerId, options) => this.#withCredentialLock(providerId, async () => {
        options?.signal?.throwIfAborted();
        await this.#providers.deleteNativeCredential(providerId);
        options?.signal?.throwIfAborted();
      })
    };
  }

  #withCredentialLock<T>(providerId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.#credentialTails.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(callback);
    const tail = operation.then(() => undefined, () => undefined);
    this.#credentialTails.set(providerId, tail);
    void tail.then(() => {
      if (this.#credentialTails.get(providerId) === tail) this.#credentialTails.delete(providerId);
    });
    return operation;
  }

  async #refreshGenerationSafely(providerId: string): Promise<void> {
    if (this.#shuttingDown) return;
    try {
      await this.#refreshPiGeneration();
    } catch (error) {
      this.#providers.setNativeAuthenticationState(providerId, "error", "Provider credential changed, but Pi generation refresh failed.");
      throw publicAuthError("Pi generation refresh failed after Provider credential change.", error);
    }
  }

  #loadAndFenceInterruptedFlows(): void {
    const stored = this.#store.findSetting<StoredFlowCatalog>("service", this.#scopeId, "pi_provider_auth_flows");
    if (stored === undefined) return;
    if (stored.value.format !== 1 || !Array.isArray(stored.value.flows)) {
      throw new Error("Pi Provider auth flow catalog has an unsupported format.");
    }
    if (stored.value.flows.length > MAX_PERSISTED_FLOWS) {
      throw new Error("Pi Provider auth flow catalog exceeds the supported durable limit.");
    }
    const storedRecoveryIds = new Set<string>();
    if (stored.value.recoveryRequiredFlowIds !== undefined) {
      if (!Array.isArray(stored.value.recoveryRequiredFlowIds)) {
        throw new Error("Pi Provider auth flow recovery catalog is malformed.");
      }
      for (const flowId of stored.value.recoveryRequiredFlowIds) {
        if (typeof flowId !== "string" || flowId.length === 0 || storedRecoveryIds.has(flowId)) {
          throw new Error("Pi Provider auth flow recovery catalog is malformed.");
        }
        storedRecoveryIds.add(flowId);
      }
    }
    if (storedRecoveryIds.size > MAX_ACTIVE_FLOWS) {
      throw new PiProviderAuthFlowCapacityError(MAX_ACTIVE_FLOWS);
    }
    for (const candidate of stored.value.flows) {
      const flow = validateFlow(candidate);
      if (this.#flows.has(flow.opaqueFlowId)) throw new Error("Pi Provider auth flow catalog contains a duplicate flow ID.");
      const interrupted = providerAuthFlowInFlight(flow);
      const recoveryRequired = interrupted || storedRecoveryIds.has(flow.opaqueFlowId);
      if (storedRecoveryIds.has(flow.opaqueFlowId) && flow.state !== "outcome_unknown") {
        throw new Error("Pi Provider auth flow recovery state is malformed.");
      }
      const recovered = interrupted
        ? {
          ...flow,
          state: "outcome_unknown" as const,
          updatedAt: this.#now(),
          pendingPrompt: undefined,
          error: "Provider login outcome is unknown after the Orchestrator runtime restarted."
        }
        : flow;
      this.#flows.set(recovered.opaqueFlowId, recovered);
      if (recoveryRequired) this.#recoveryRequired.add(recovered.opaqueFlowId);
      if (recovered.state === "outcome_unknown") {
        try {
          this.#providers.setNativeAuthenticationState(recovered.providerId, "error", "Provider login outcome is unknown after restart.");
        } catch {
          // A deleted Provider may legitimately outlive its historical flow.
        }
      }
    }
    if ([...storedRecoveryIds].some((flowId) => !this.#flows.has(flowId))) {
      throw new Error("Pi Provider auth flow recovery catalog references an unavailable flow.");
    }
    this.#persistFlows();
  }

  #persistFlows(): void {
    const protectedFlows = [...this.#flows.values()]
      .filter((flow) => providerAuthFlowInFlight(flow)
        || this.#active.has(flow.opaqueFlowId)
        || this.#recoveryRequired.has(flow.opaqueFlowId))
      .sort((left, right) => left.startedAt - right.startedAt || left.opaqueFlowId.localeCompare(right.opaqueFlowId, "en"));
    if (protectedFlows.length > MAX_ACTIVE_FLOWS) throw new PiProviderAuthFlowCapacityError(MAX_ACTIVE_FLOWS);
    const protectedIds = new Set(protectedFlows.map((flow) => flow.opaqueFlowId));
    const terminal = [...this.#flows.values()]
      .filter((flow) => !protectedIds.has(flow.opaqueFlowId))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.opaqueFlowId.localeCompare(right.opaqueFlowId, "en"))
      .slice(0, MAX_RETAINED_TERMINAL_FLOWS);
    const retained = [...protectedFlows, ...terminal];
    if (retained.length > MAX_PERSISTED_FLOWS) throw new Error("Pi Provider auth flow catalog exceeds the supported durable limit.");
    this.#flows.clear();
    for (const flow of retained) this.#flows.set(flow.opaqueFlowId, flow);
    this.#store.setSetting("service", this.#scopeId, "pi_provider_auth_flows", {
      format: 1,
      flows: retained,
      ...(this.#recoveryRequired.size === 0
        ? {}
        : { recoveryRequiredFlowIds: [...this.#recoveryRequired].sort((left, right) => left.localeCompare(right, "en")) })
    } satisfies StoredFlowCatalog);
  }

  #updateFlow(id: string, patch: Partial<Omit<PiProviderAuthFlowRecord, "opaqueFlowId" | "providerId" | "method" | "startedAt">>): void {
    const current = this.#requireFlow(id);
    const next = {
      ...current,
      ...patch,
      updatedAt: this.#now()
    };
    if ("error" in patch && patch.error === undefined) delete (next as { error?: string }).error;
    if ("pendingPrompt" in patch && patch.pendingPrompt === undefined) {
      delete (next as { pendingPrompt?: PiProviderAuthPromptRecord }).pendingPrompt;
    }
    this.#flows.set(id, next);
    this.#persistFlows();
  }

  #requireFlow(id: string): PiProviderAuthFlowRecord {
    const flow = this.#flows.get(id);
    if (flow === undefined) throw new Error("Pi Provider auth flow is unavailable.");
    return flow;
  }

  #requireRuntime(): PiProviderAuthRuntime {
    if (this.#runtime === undefined) throw new Error("Pi Provider auth runtime is not initialized.");
    return this.#runtime;
  }

  async #refreshModelSource(
    providerId: string,
    automatic: boolean
  ): Promise<{ readonly added: number; readonly activate: boolean } | undefined> {
    const existing = this.#modelRefreshFlights.get(providerId);
    if (existing !== undefined) {
      if (automatic || existing.forced) return existing.promise;
      await existing.promise.catch(() => undefined);
      return this.#refreshModelSource(providerId, false);
    }
    const now = this.#now();
    const failedAt = this.#modelRefreshFailures.get(providerId);
    const attemptedAt = this.#modelRefreshAttempts.get(providerId);
    const cooldownStart = failedAt ?? attemptedAt;
    const cooldown = failedAt === undefined ? MODEL_REFRESH_COOLDOWN_MS : MODEL_REFRESH_FAILURE_COOLDOWN_MS;
    if (automatic && cooldownStart !== undefined && now - cooldownStart < cooldown) return undefined;
    this.#modelRefreshAttempts.set(providerId, now);
    const operation = (async (): Promise<{ readonly added: number; readonly activate: boolean }> => {
      try {
        if (this.#providers.canDiscoverProviderModels(providerId)) {
          const result = await this.#providers.discoverProviderModels(providerId);
          this.#modelRefreshFailures.delete(providerId);
          return { added: result.addedModelIds.length, activate: result.addedModelIds.length > 0 };
        }
        const runtime = this.#requireRuntime();
        if (typeof runtime.getProvider(providerId)?.refreshModels !== "function" || runtime.refresh === undefined) {
          throw new Error("Provider model refresh is unavailable.");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MODEL_REFRESH_TIMEOUT_MS);
        try {
          const result = await runtime.refresh({
            allowNetwork: true,
            providers: [providerId],
            force: !automatic,
            signal: controller.signal
          });
          if (controller.signal.aborted || modelRefreshFailed(result, providerId)) {
            throw new Error("Provider model refresh failed.");
          }
        } finally {
          clearTimeout(timer);
        }
        this.#modelRefreshFailures.delete(providerId);
        return { added: 0, activate: true };
      } catch (error) {
        this.#modelRefreshFailures.set(providerId, this.#now());
        throw error;
      }
    })().finally(() => {
      if (this.#modelRefreshFlights.get(providerId)?.promise === operation) this.#modelRefreshFlights.delete(providerId);
    });
    this.#modelRefreshFlights.set(providerId, { promise: operation, forced: !automatic });
    return operation;
  }

  #supportsAutomaticModelRefresh(providerId: string): boolean {
    return typeof this.#runtime?.getProvider(providerId)?.refreshModels === "function";
  }

  #assertOpen(): void {
    if (this.#closed || this.#shuttingDown) throw new Error("Pi Provider auth supervisor is closing or closed.");
  }

  #assertDataPlaneOpen(): void {
    if (this.#closed) throw new Error("Pi Provider auth supervisor is closed.");
  }
}

async function createNativePiRuntime(credentials: PiCredentialStore): Promise<PiProviderAuthRuntime> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false
  }) as unknown as PiProviderAuthRuntime;
}

function nativeProviderRegistrations(runtime: PiProviderAuthRuntime): readonly NativeProviderAuthRegistration[] {
  return runtime.getProviders().map((provider) => {
    const oauth = provider.auth.oauth;
    const api = commonNativeProviderApi(provider.getModels());
    return {
      // This is descriptor metadata only. Built-in models are projected from
      // listNativeModels() and must never be copied into managed models.json.
      provider: {
        id: provider.id,
        ...(api === undefined ? {} : { api }),
        ...(oauth === undefined && provider.auth.apiKey === undefined ? { keyless: true } : {}),
        models: []
      },
      displayName: provider.name?.trim() || provider.id,
      kind: oauth !== undefined
        ? (oauth.isSubscription === true ? "subscription" as const : "oauth" as const)
        : (provider.auth.apiKey === undefined ? "local_keyless" as const : "api_key" as const),
      loginMethods: [
        ...(provider.auth.apiKey === undefined ? [] : ["api_key" as const]),
        ...(oauth === undefined
          ? []
          : oauth.isSubscription === true
            ? ["subscription" as const]
            : ["oauth_browser" as const, "device_code" as const])
      ],
      modelRefreshAvailable: typeof provider.refreshModels === "function",
      accountUsageAvailable: supportsProviderAccountUsage(provider)
    };
  });
}

export function supportsProviderAccountUsage(provider: PiNativeOAuthProvider): boolean {
  const models = provider.getModels();
  return provider.auth.oauth?.isSubscription === true
    && models.length > 0
    && models.every((model) => model.api === "openai-codex-responses");
}

function commonNativeProviderApi(models: ReturnType<PiNativeOAuthProvider["getModels"]>): PiSupportedApi | undefined {
  const supported = new Set<PiSupportedApi>();
  for (const model of models) {
    if (model.api === "anthropic-messages"
      || model.api === "openai-responses"
      || model.api === "openai-completions"
      || model.api === "google-generative-ai") {
      supported.add(model.api);
    } else {
      return undefined;
    }
  }
  return supported.size === 1 ? [...supported][0] : undefined;
}

function nativeModelCatalog(runtime: PiProviderAuthRuntime): readonly ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const provider of runtime.getProviders()) {
    const providerId = nativeCatalogId(provider.id, "Provider");
    for (const model of provider.getModels()) {
      if (model.provider !== undefined && model.provider !== providerId) {
        throw new Error("Pi native model registry contains a mismatched Provider identity.");
      }
      const modelId = nativeCatalogId(model.id, "model");
      const identity = `${providerId}\u0000${modelId}`;
      if (seen.has(identity)) throw new Error("Pi native model registry contains a duplicate model identity.");
      seen.add(identity);
      const api = nonBlankNativeModelText(model.api, "API");
      const contextWindow = positiveSafeNativeModelInteger(model.contextWindow, "context window");
      const maxOutputTokens = positiveSafeNativeModelInteger(model.maxTokens, "maximum output tokens");
      const input = model.input ?? ["text"];
      if (input.length === 0 || input.some((modality) => modality !== "text" && modality !== "image")) {
        throw new Error("Pi native model registry contains an unsupported input modality.");
      }
      const cost = {
        input: nonNegativeNativeModelNumber(model.cost?.input ?? 0, "input cost"),
        output: nonNegativeNativeModelNumber(model.cost?.output ?? 0, "output cost"),
        cacheRead: nonNegativeNativeModelNumber(model.cost?.cacheRead ?? 0, "cache-read cost"),
        cacheWrite: nonNegativeNativeModelNumber(model.cost?.cacheWrite ?? 0, "cache-write cost")
      };
      models.push({
        providerId,
        modelId,
        displayName: model.name?.trim() || modelId,
        api,
        contextWindow,
        maxOutputTokens,
        supportsImages: input.includes("image"),
        // This is authoritative installed Pi registry metadata, not an
        // endpoint heuristic. Pi's openai-codex-responses implementation
        // exposes serviceTier and maps it to the Provider request payload.
        supportsFastMode: api === "openai-codex-responses",
        thinkingLevels: nativeThinkingLevels(model.reasoning === true, model.thinkingLevelMap),
        cost
      });
    }
  }
  return models.sort((left, right) =>
    left.providerId.localeCompare(right.providerId, "en") || left.modelId.localeCompare(right.modelId, "en"));
}

function nativeCatalogId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || value.length > 256) {
    throw new Error(`Pi native model registry ${label} ID is invalid.`);
  }
  return value;
}

function nonBlankNativeModelText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || value.length > 256) {
    throw new Error(`Pi native model registry ${label} is invalid.`);
  }
  return value;
}

function positiveSafeNativeModelInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Pi native model registry ${label} is invalid.`);
  }
  return value as number;
}

function nonNegativeNativeModelNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Pi native model registry ${label} is invalid.`);
  }
  // Pi uses negative sentinels for dynamically routed/unknown pricing (for
  // example OpenRouter auto). The public catalog has no unknown-cost scalar,
  // so expose zero rather than treating a valid built-in model as malformed.
  return value < 0 ? 0 : value;
}

export function nativeThinkingLevels(
  reasoning: boolean,
  mapping: Readonly<Record<string, string | null>> | undefined
): readonly string[] {
  if (!reasoning) return [];
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
    const nativeLevel = mapping?.[level];
    if (nativeLevel === null) return false;
    // Pi's standard levels use Provider defaults when absent. Extended
    // levels are opt-in and require an explicit non-null mapping.
    if (level === "xhigh" || level === "max") return nativeLevel !== undefined;
    return true;
  });
}

function modelRefreshFailed(result: unknown, providerId: string): boolean {
  if (!isRecord(result)) return false;
  if (result["aborted"] === true) return true;
  const errors = result["errors"];
  return errors instanceof Map && errors.has(providerId);
}

function cloneProviderModel(model: ProviderModel): ProviderModel {
  return {
    ...model,
    thinkingLevels: [...model.thinkingLevels],
    cost: { ...model.cost }
  };
}

function parseCredential(value: string): PiCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored native Provider credential is malformed.");
  }
  return validateCredential(parsed);
}

function validateCredential(value: unknown): PiCredential {
  if (!isRecord(value)) throw new Error("Pi returned a malformed credential.");
  if (value["type"] === "oauth") {
    if (typeof value["access"] !== "string" || value["access"].length === 0) throw new Error("Pi returned a malformed OAuth credential.");
    if (typeof value["refresh"] !== "string" || value["refresh"].length === 0) throw new Error("Pi returned a malformed OAuth credential.");
    if (!Number.isSafeInteger(value["expires"]) || (value["expires"] as number) <= 0) throw new Error("Pi returned a malformed OAuth expiry.");
  } else if (value["type"] === "api_key") {
    if (value["key"] !== undefined && (typeof value["key"] !== "string" || value["key"].length === 0)) {
      throw new Error("Pi returned a malformed API-key credential.");
    }
    const env = value["env"];
    if (env !== undefined) {
      if (!isRecord(env) || Object.keys(env).length > 64) throw new Error("Pi returned a malformed credential environment.");
      for (const [name, environmentValue] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)
          || typeof environmentValue !== "string"
          || environmentValue.length === 0
          || Buffer.byteLength(environmentValue, "utf8") > 8 * 1024) {
          throw new Error("Pi returned a malformed credential environment.");
        }
      }
    }
  } else {
    throw new Error("Pi returned an unsupported credential type.");
  }
  const serialized = serializeJson(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("Pi returned an oversized credential.");
  return JSON.parse(serialized) as PiCredential;
}

function serializeCredential(value: PiCredential): string {
  return serializeJson(validateCredential(value));
}

function serializeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not serializable");
    return serialized;
  } catch {
    throw new Error("Pi returned a non-serializable credential.");
  }
}

function cloneCredential(value: PiCredential): PiCredential {
  return JSON.parse(JSON.stringify(value)) as PiCredential;
}

function providerAuthFlowInFlight(flow: PiProviderAuthFlowRecord): boolean {
  return flow.state === "starting" || flow.state === "pending";
}

function validateFlow(value: unknown): PiProviderAuthFlowRecord {
  if (!isRecord(value)) throw new Error("Pi Provider auth flow is malformed.");
  const method = value["method"];
  const state = value["state"];
  if (method !== "api_key" && method !== "oauth_browser" && method !== "device_code" && method !== "subscription") throw new Error("Pi Provider auth flow method is malformed.");
  if (!(["starting", "pending", "completed", "cancelled", "timed_out", "outcome_unknown", "error"] as const).includes(state as PiProviderAuthFlowState)) {
    throw new Error("Pi Provider auth flow state is malformed.");
  }
  const flow: PiProviderAuthFlowRecord = {
    opaqueFlowId: requiredString(value, "opaqueFlowId"),
    providerId: requiredString(value, "providerId"),
    method,
    state: state as PiProviderAuthFlowState,
    startedAt: requiredSafeInteger(value, "startedAt"),
    updatedAt: requiredSafeInteger(value, "updatedAt"),
    ...(optionalString(value, "verificationUri") === undefined ? {} : { verificationUri: optionalString(value, "verificationUri") }),
    ...(optionalString(value, "userCode") === undefined ? {} : { userCode: optionalString(value, "userCode") }),
    ...(optionalSafeInteger(value, "expiresAt") === undefined ? {} : { expiresAt: optionalSafeInteger(value, "expiresAt") }),
    ...(value["pendingPrompt"] === undefined ? {} : { pendingPrompt: validatePromptRecord(value["pendingPrompt"]) }),
    ...(optionalString(value, "error") === undefined ? {} : { error: optionalString(value, "error") })
  };
  return flow;
}

function cloneFlow(flow: PiProviderAuthFlowRecord): PiProviderAuthFlowRecord {
  return {
    ...flow,
    ...(flow.pendingPrompt === undefined ? {} : {
      pendingPrompt: {
        ...flow.pendingPrompt,
        ...(flow.pendingPrompt.options === undefined
          ? {}
          : { options: flow.pendingPrompt.options.map((option) => ({ ...option })) })
      }
    })
  };
}

function toPublicFlow(flow: PiProviderAuthFlowRecord): ProviderLoginFlow {
  return {
    providerId: flow.providerId,
    method: flow.method,
    opaqueFlowId: flow.opaqueFlowId,
    ...(flow.verificationUri === undefined ? {} : { verificationUri: flow.verificationUri }),
    ...(flow.userCode === undefined ? {} : { userCode: flow.userCode }),
    ...(flow.expiresAt === undefined ? {} : { expiresAt: flow.expiresAt })
  };
}

function toPromptRecord(prompt: PiAuthPrompt, createdAt: number): PiProviderAuthPromptRecord {
  const kind = prompt.type;
  const message = kind === "secret"
    ? "Enter the Provider login credential."
    : kind === "manual_code"
      ? "Paste the Provider authorization code or final redirect URL."
      : safePromptText(prompt.message, "message", 2_048, false);
  const placeholder = kind === "secret" || prompt.type === "select" ? undefined : prompt.placeholder;
  const options = kind === "select"
    ? validatePromptOptions(prompt.options)
    : undefined;
  return {
    promptId: `pprompt_${randomUUID()}`,
    kind,
    message,
    ...(placeholder === undefined ? {} : { placeholder: safePromptText(placeholder, "placeholder", 1_024, true) }),
    ...(options === undefined ? {} : { options }),
    createdAt
  };
}

function validatePromptRecord(value: unknown): PiProviderAuthPromptRecord {
  if (!isRecord(value)) throw new Error("Pi Provider auth prompt is malformed.");
  const kind = value["kind"];
  if (kind !== "text" && kind !== "secret" && kind !== "manual_code" && kind !== "select") {
    throw new Error("Pi Provider auth prompt kind is malformed.");
  }
  const optionsValue = value["options"];
  const options = optionsValue === undefined
    ? undefined
    : Array.isArray(optionsValue)
      ? validatePromptOptions(optionsValue.map((option) => {
        if (!isRecord(option)) throw new Error("Pi Provider auth prompt option is malformed.");
        return {
          id: requiredString(option, "id"),
          label: requiredString(option, "label"),
          ...(optionalString(option, "description") === undefined ? {} : { description: optionalString(option, "description") })
        };
      }))
      : (() => { throw new Error("Pi Provider auth prompt options are malformed."); })();
  if (kind === "select" && options === undefined) throw new Error("Pi Provider auth selection has no options.");
  if (kind !== "select" && options !== undefined) throw new Error("Pi Provider auth non-selection contains options.");
  const placeholder = optionalString(value, "placeholder");
  return {
    promptId: safePromptText(requiredString(value, "promptId"), "prompt ID", 256, false),
    kind,
    message: safePromptText(requiredString(value, "message"), "message", 2_048, false),
    ...(placeholder === undefined ? {} : { placeholder: safePromptText(placeholder, "placeholder", 1_024, true) }),
    ...(options === undefined ? {} : { options }),
    createdAt: requiredSafeInteger(value, "createdAt")
  };
}

function validatePromptOptions(options: readonly PiProviderAuthPromptOption[]): readonly PiProviderAuthPromptOption[] {
  if (options.length === 0 || options.length > 32) throw new Error("Pi Provider auth selection has an invalid option count.");
  const seen = new Set<string>();
  return options.map((option) => {
    const id = safePromptText(option.id, "option ID", 256, false);
    if (seen.has(id)) throw new Error("Pi Provider auth selection contains duplicate options.");
    seen.add(id);
    const description = option.description;
    return {
      id,
      label: safePromptText(option.label, "option label", 512, false),
      ...(description === undefined ? {} : { description: safePromptText(description, "option description", 2_048, true) })
    };
  });
}

function safePromptText(value: string, field: string, maximumLength: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > maximumLength || value.includes("\0") || (!allowEmpty && value.trim() === "")) {
    throw new Error(`Pi Provider auth prompt ${field} is invalid.`);
  }
  return value;
}

function validatePromptAnswer(value: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error("Provider login prompt answer is invalid.");
  }
  if (!allowEmpty && value.trim() === "") throw new Error("Provider login prompt answer is empty.");
  return value;
}

function safeVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Pi returned an invalid Provider verification URI.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Pi returned an unsafe Provider verification URI.");
  }
  for (const key of url.searchParams.keys()) {
    if (/^(?:access_token|refresh_token|id_token|client_secret|password|authorization)$/iu.test(key)) {
      throw new Error("Pi returned a Provider verification URI containing secret material.");
    }
  }
  return url.toString();
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: Error) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject: (reason) => {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(reason);
    },
    settled: false
  };
  return result;
}

function safeFlowError(error: unknown): string {
  return error instanceof ProviderAuthUnsupportedError
    ? error.message
    : "Provider login failed.";
}

function publicAuthError(message: string, error: unknown): Error {
  if (error instanceof ProviderAuthUnsupportedError) return error;
  return new Error(message, { cause: new Error(error instanceof Error ? error.name : "ProviderAuthError") });
}

function validPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("Pi Provider auth flow is malformed.");
  return candidate;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") throw new Error("Pi Provider auth flow is malformed.");
  return candidate;
}

function requiredSafeInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate)) throw new Error("Pi Provider auth flow is malformed.");
  return candidate as number;
}

function optionalSafeInteger(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate)) throw new Error("Pi Provider auth flow is malformed.");
  return candidate as number;
}

class FlowCancelledError extends Error {
  constructor() {
    super("Provider login was cancelled.");
    this.name = "FlowCancelledError";
  }
}

class FlowTimedOutError extends Error {
  constructor() {
    super("Provider login timed out.");
    this.name = "FlowTimedOutError";
  }
}

class FlowInterruptedError extends Error {
  constructor() {
    super("Provider login was interrupted by shutdown.");
    this.name = "FlowInterruptedError";
  }
}
