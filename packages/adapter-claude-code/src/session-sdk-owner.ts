import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { ClaudeSdkGetSessionMessagesOptions, ClaudeSdkListSessionsOptions } from "./sdk-runtime.js";
import {
  adoptClaudeSessionStoreChild,
  createClaudeSessionStoreAuthority,
  createClaudeSessionStoreSessionAccess,
  discardClaudeSessionStoreImport,
  prepareClaudeSessionStoreDerivation,
  prepareClaudeSessionStoreImport,
  readClaudeSessionStoreOperation,
  rebindClaudeSessionStoreGeneration,
  type ClaudeSessionStoreAuthority,
  type ClaudeSessionStoreOperationAccess,
  type ClaudeSessionStoreOperationSnapshot,
  type ClaudeSessionStoreSessionAccess
} from "./claude-session-store.js";

export const SESSION_SDK_MAXIMUM_RESULT_BYTES = 24 * 1024 * 1024;
const MAXIMUM_WORKERS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SessionSdkRequest =
  | { readonly kind: "getSessionInfo" | "deleteSession"; readonly sessionId: string; readonly options: { readonly dir: string } }
  | { readonly kind: "forkSession"; readonly sessionId: string; readonly options: { readonly dir: string; readonly upToMessageId?: string } }
  | { readonly kind: "getSessionMessages"; readonly sessionId: string; readonly options: Omit<ClaudeSdkGetSessionMessagesOptions, "signal"> }
  | { readonly kind: "listSessions"; readonly options: ClaudeSdkListSessionsOptions }
  | {
      readonly kind: "importSessionToStore";
      readonly sessionId: string;
      readonly options: { readonly dir: string };
      readonly access: ClaudeSessionStoreOperationAccess;
    }
  | {
      readonly kind: "forkStoredSession";
      readonly sessionId: string;
      readonly options: { readonly dir: string; readonly upToMessageId?: string };
      readonly access: ClaudeSessionStoreOperationAccess;
    }
  | {
      readonly kind: "getStoredSessionInfo" | "deleteStoredSession";
      readonly sessionId: string;
      readonly options: { readonly dir: string };
      readonly access: ClaudeSessionStoreSessionAccess | ClaudeSessionStoreOperationAccess;
    }
  | {
      readonly kind: "getStoredSessionMessages";
      readonly sessionId: string;
      readonly options: Omit<ClaudeSdkGetSessionMessagesOptions, "signal">;
      readonly access: ClaudeSessionStoreSessionAccess | ClaudeSessionStoreOperationAccess;
    };

export interface SessionSdkWorkerData {
  readonly request: SessionSdkRequest;
  readonly sessionStoreAuthority?: ClaudeSessionStoreAuthority;
}

export class SessionSdkFailure extends Error {
  constructor(readonly code: "CANCELLED" | "UNAVAILABLE" | "FAILED" | "TIMEOUT" | "CLEANUP_UNKNOWN" | "REGISTRATION_FAILED", readonly stateMayHaveChanged: boolean) {
    super(`Native Session SDK operation ${code.toLowerCase()}.`);
    this.name = "SessionSdkFailure";
  }
}

interface Flight {
  readonly worker: Worker;
  readonly request: SessionSdkRequest;
  readonly done: Promise<void>;
  readonly cancel: () => void;
  derivedId?: string;
  reservationAcknowledged?: boolean;
}

/** One short-lived SDK Worker environment per operation; no Query or provider traffic. */
export class SessionSdkOwner {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #workerFactory: (url: URL, options: WorkerOptions) => Worker;
  readonly #sessionStoreAuthority: ClaudeSessionStoreAuthority | undefined;
  readonly #flights = new Set<Flight>();
  #closed = false;

  constructor(options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
    readonly cleanupTimeoutMs: number;
    readonly sessionStoreAuthority?: ClaudeSessionStoreAuthority;
    readonly workerFactory?: (url: URL, options: WorkerOptions) => Worker;
  }) {
    const configured = options.environment["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
    if (!isAbsolute(configured)) throw new TypeError("The native Session configuration directory must be absolute.");
    const projectDirectoryName = options.environment["CLAUDE_CODE_PROJECT_DIR_NAME"];
    if (projectDirectoryName !== undefined && !/^[A-Za-z0-9_-]{1,64}$/u.test(projectDirectoryName)) {
      throw new TypeError("The native project storage name is invalid.");
    }
    this.#environment = Object.freeze({
      CLAUDE_CONFIG_DIR: resolve(configured).normalize("NFC"),
      ...(projectDirectoryName === undefined ? {} : { CLAUDE_CODE_PROJECT_DIR_NAME: projectDirectoryName })
    });
    this.#timeoutMs = options.timeoutMs;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs;
    this.#sessionStoreAuthority = options.sessionStoreAuthority === undefined
      ? undefined
      : createClaudeSessionStoreAuthority(options.sessionStoreAuthority);
    this.#workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  }

  get hasSessionStore(): boolean {
    return this.#sessionStoreAuthority !== undefined;
  }

  prepareSessionImport(input: {
    readonly operationId: string;
    readonly sourceWorkspaceAuthority: string;
    readonly sourceSessionId: string;
    readonly targetWorkspaceAuthority: string;
  }): ClaudeSessionStoreOperationAccess {
    return prepareClaudeSessionStoreImport(this.#requireSessionStoreAuthority(), input);
  }

  prepareStoredSessionDerivation(input: {
    readonly operationId: string;
    readonly sourceWorkspaceAuthority: string;
    readonly sourceSessionId: string;
    readonly targetWorkspaceAuthority: string;
  }): ClaudeSessionStoreOperationAccess {
    return prepareClaudeSessionStoreDerivation(this.#requireSessionStoreAuthority(), input);
  }

  readStoredSessionOperation(access: ClaudeSessionStoreOperationAccess): ClaudeSessionStoreOperationSnapshot {
    return readClaudeSessionStoreOperation(this.#requireSessionStoreAuthority(), access);
  }

  discardSessionImport(access: ClaudeSessionStoreOperationAccess): void {
    if (this.ownsStoreOperation(access.operationId)) {
      throw new SessionSdkFailure("CLEANUP_UNKNOWN", true);
    }
    discardClaudeSessionStoreImport(this.#requireSessionStoreAuthority(), access);
  }

  adoptStoredSession(access: ClaudeSessionStoreOperationAccess, sessionId: string): ClaudeSessionStoreSessionAccess {
    return adoptClaudeSessionStoreChild(this.#requireSessionStoreAuthority(), access, sessionId);
  }

  rebindStoredSession(input: {
    readonly workspaceAuthority: string;
    readonly sessionId: string;
    readonly expectedGeneration: number;
  }): ClaudeSessionStoreSessionAccess {
    return rebindClaudeSessionStoreGeneration(this.#requireSessionStoreAuthority(), input);
  }

  ownsSession(sessionId: string): boolean {
    return [...this.#flights].some((flight) => (flight.request.kind === "forkSession" || flight.request.kind === "forkStoredSession")
      && (flight.request.sessionId.toLowerCase() === sessionId.toLowerCase() || flight.derivedId?.toLowerCase() === sessionId.toLowerCase()));
  }

  ownsStoreOperation(operationId: string): boolean {
    return [...this.#flights].some((flight) => isStoredRequest(flight.request)
      && flight.request.access.kind === "operation"
      && flight.request.access.operationId === operationId);
  }

  async retire(): Promise<void> {
    const flights = [...this.#flights];
    for (const flight of flights) flight.cancel();
    await Promise.all(flights.map((flight) => flight.done));
    if (this.#flights.size > 0) throw new SessionSdkFailure("CLEANUP_UNKNOWN", true);
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.retire();
  }

  run(request: SessionSdkRequest, options: { readonly signal?: AbortSignal; readonly recordSessionId?: (sessionId: string) => void } = {}): Promise<unknown> {
    const signal = options.signal;
    let recordSessionId = options.recordSessionId;
    const mutation = request.kind === "forkSession" || request.kind === "deleteSession"
      || request.kind === "importSessionToStore" || request.kind === "forkStoredSession"
      || request.kind === "deleteStoredSession";
    if (this.#closed) return Promise.reject(new SessionSdkFailure("UNAVAILABLE", false));
    if (signal?.aborted) return Promise.reject(new SessionSdkFailure("CANCELLED", false));
    if (!isAbsolute(request.options.dir)
      || ((request.kind === "forkSession" || request.kind === "forkStoredSession")
        && request.options.upToMessageId !== undefined && !UUID.test(request.options.upToMessageId))
      || ((request.kind === "getSessionMessages" || request.kind === "getStoredSessionMessages")
        && (!Number.isSafeInteger(request.options.limit) || request.options.limit < 1 || request.options.limit > 10_001))
      || (request.kind === "listSessions" && (!Number.isSafeInteger(request.options.limit) || request.options.limit < 1 || request.options.limit > 1_000))) {
      return Promise.reject(new SessionSdkFailure("UNAVAILABLE", false));
    }
    if (!this.#validStoreRequest(request)) return Promise.reject(new SessionSdkFailure("UNAVAILABLE", false));
    if (this.#flights.size >= MAXIMUM_WORKERS) return Promise.reject(new SessionSdkFailure("UNAVAILABLE", false));
    let worker: Worker;
    try {
      worker = this.#workerFactory(new URL("./session-sdk-worker.mjs", import.meta.url), {
        workerData: {
          request,
          ...(isStoredRequest(request) ? { sessionStoreAuthority: this.#sessionStoreAuthority } : {})
        } satisfies SessionSdkWorkerData,
        env: { ...this.#environment }, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 192 }
      });
    } catch {
      return Promise.reject(new SessionSdkFailure("UNAVAILABLE", false));
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settle!: () => void;
    const done = new Promise<void>((resolveDone) => { settle = resolveDone; });
    return new Promise<unknown>((resolveResult, rejectResult) => {
      let finished = false;
      let exited = false;
      let received = false;
      let result: unknown;
      let failure: SessionSdkFailure | undefined;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        recordSessionId = undefined;
        clearTimeout(timer);
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        signal?.removeEventListener("abort", cancel);
        settle();
        if (failure !== undefined) rejectResult(failure);
        else resolveResult(result);
      };
      const stop = (reason: SessionSdkFailure) => {
        failure ??= reason;
        if (exited || cleanupTimer !== undefined) return;
        // Retain the flight after an unconfirmed exit. Its slot and identities
        // fence deletion until the actual Worker exit arrives.
        cleanupTimer = setTimeout(() => {
          failure = new SessionSdkFailure("CLEANUP_UNKNOWN", mutation);
          worker.unref();
          finish();
        }, this.#cleanupTimeoutMs);
        void worker.terminate().catch(() => undefined);
      };
      const cancel = () => stop(new SessionSdkFailure("CANCELLED", mutation));
      const flight: Flight = { worker, request, done, cancel };
      this.#flights.add(flight);
      const timer = setTimeout(() => stop(new SessionSdkFailure("TIMEOUT", mutation)), this.#timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      worker.on("message", (message: unknown) => {
        if (finished) return;
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          stop(new SessionSdkFailure("FAILED", mutation));
          return;
        }
        const envelope = message as Record<string, unknown>;
        if (envelope["type"] === "childReserved") {
          if (request.kind !== "forkStoredSession"
            || envelope["operationId"] !== request.access.operationId
            || envelope["generation"] !== request.access.generation
            || envelope["targetWorkspaceAuthority"] !== request.access.target.workspaceAuthority
            || typeof envelope["sessionId"] !== "string"
            || !UUID.test(envelope["sessionId"])
            || envelope["sessionId"].toLowerCase() === request.sessionId.toLowerCase()) {
            stop(new SessionSdkFailure("FAILED", true));
            return;
          }
          const sessionId = envelope["sessionId"];
          if (flight.derivedId !== undefined) {
            if (flight.derivedId !== sessionId || !flight.reservationAcknowledged) {
              stop(new SessionSdkFailure("FAILED", true));
              return;
            }
            worker.postMessage({
              type: "childReservationAck",
              operationId: request.access.operationId,
              generation: request.access.generation,
              sessionId,
              accepted: true
            });
            return;
          }
          flight.derivedId = sessionId;
          try {
            if (recordSessionId === undefined) throw new Error();
            recordSessionId(sessionId);
            flight.reservationAcknowledged = true;
            worker.postMessage({
              type: "childReservationAck",
              operationId: request.access.operationId,
              generation: request.access.generation,
              sessionId,
              accepted: true
            });
          } catch {
            try {
              worker.postMessage({
                type: "childReservationAck",
                operationId: request.access.operationId,
                generation: request.access.generation,
                sessionId,
                accepted: false
              });
            } catch { /* Worker retirement remains the exact cleanup boundary. */ }
            stop(new SessionSdkFailure("REGISTRATION_FAILED", true));
          }
          return;
        }
        if (received) {
          stop(new SessionSdkFailure("FAILED", mutation));
          return;
        }
        if (envelope["type"] !== "result" || typeof envelope["json"] !== "string"
          || Buffer.byteLength(envelope["json"], "utf8") > SESSION_SDK_MAXIMUM_RESULT_BYTES) {
          stop(new SessionSdkFailure("FAILED", mutation));
          return;
        }
        try {
          const decoded: unknown = JSON.parse(envelope["json"]);
          if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
          result = (decoded as Record<string, unknown>)["value"];
          if (request.kind === "forkSession" || request.kind === "forkStoredSession") {
            const id = result !== null && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>)["sessionId"] : undefined;
            if (typeof id !== "string" || !UUID.test(id) || id.toLowerCase() === request.sessionId.toLowerCase()) throw new Error();
            if (request.kind === "forkStoredSession") {
              if (flight.derivedId !== id || flight.reservationAcknowledged !== true) throw new Error();
            } else {
              if (recordSessionId === undefined) throw new Error();
              flight.derivedId = id;
              try { recordSessionId(id); }
              catch { stop(new SessionSdkFailure("REGISTRATION_FAILED", true)); }
            }
          }
          received = true;
        } catch {
          stop(new SessionSdkFailure("FAILED", mutation));
        }
      });
      worker.on("error", () => stop(new SessionSdkFailure("FAILED", mutation)));
      worker.once("exit", (code) => {
        exited = true;
        this.#flights.delete(flight);
        if (!received || code !== 0) failure ??= new SessionSdkFailure("FAILED", mutation);
        finish();
      });
      if (signal?.aborted) cancel();
    });
  }

  #requireSessionStoreAuthority(): ClaudeSessionStoreAuthority {
    if (this.#sessionStoreAuthority === undefined) throw new SessionSdkFailure("UNAVAILABLE", false);
    return this.#sessionStoreAuthority;
  }

  #validStoreRequest(request: SessionSdkRequest): boolean {
    if (!isStoredRequest(request)) return true;
    const authority = this.#sessionStoreAuthority;
    if (authority === undefined || !UUID.test(request.sessionId)) return false;
    try {
      if (request.kind === "importSessionToStore" || request.kind === "forkStoredSession") {
        if (request.sessionId !== request.access.source.sessionId) return false;
        const snapshot = readClaudeSessionStoreOperation(authority, request.access);
        return request.kind === "importSessionToStore"
          ? snapshot.sourceKind === "import" && snapshot.state === "importing"
            && !snapshot.sourceProjectKeyCaptured && snapshot.sourceEntryCount === 0
          : snapshot.state === "ready" && !snapshot.targetProjectKeyCaptured
            && snapshot.childSessionId === undefined;
      }
      if (request.access.kind === "operation") {
        const snapshot = readClaudeSessionStoreOperation(authority, request.access);
        return snapshot.childSessionId === request.sessionId;
      }
      const normalized = createClaudeSessionStoreSessionAccess(request.access);
      return normalized.sessionId === request.sessionId && normalized.generation === authority.generation;
    } catch {
      return false;
    }
  }
}

function isStoredRequest(request: SessionSdkRequest): request is Extract<SessionSdkRequest, { readonly access: unknown }> {
  return "access" in request;
}
