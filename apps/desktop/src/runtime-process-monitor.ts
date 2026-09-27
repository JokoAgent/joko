export const RUNTIME_PROCESS_MONITOR_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_PROCESS_MONITOR_MAX_BACKENDS = 128;
export const RUNTIME_PROCESS_MONITOR_MAX_SESSIONS = 4_096;
export const RUNTIME_PROCESS_MONITOR_MAX_PROCESSES_PER_BACKEND = 512;
export const RUNTIME_PROCESS_MONITOR_MAX_PENDING_REQUESTS = 32;
export const RUNTIME_PROCESS_MONITOR_REQUEST_TIMEOUT_MS = 15_000;

const RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH = 512;
const RUNTIME_PROCESS_MONITOR_NAME_MAX_LENGTH = 512;
const RUNTIME_PROCESS_MONITOR_ERROR_MAX_LENGTH = 2_048;
const POSITIVE_SAFE_DECIMAL_PATTERN = /^[1-9][0-9]{0,15}$/u;
const POSITIVE_UINT64_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/u;
const MAXIMUM_UINT64 = 18_446_744_073_709_551_615n;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DesktopRuntimeProcessMonitorOwner {
  readonly version: 1;
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: string;
  readonly snapshotGeneration: string;
}

export interface DesktopRuntimeProcessMonitorProcess {
  readonly backendId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly pid: number;
  readonly cpuPercent: number;
  readonly memoryKb: number;
  readonly processCount: number;
  readonly terminable: boolean;
  readonly processInstanceId?: string;
}

export type DesktopRuntimeProcessMonitorAction =
  | { readonly kind: "refresh" }
  | {
      readonly kind: "terminate";
      readonly backendGeneration: string;
      readonly process: DesktopRuntimeProcessMonitorProcess;
    };

export interface DesktopRuntimeProcessMonitorRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly owner: DesktopRuntimeProcessMonitorOwner;
  readonly action: DesktopRuntimeProcessMonitorAction;
}

export interface DesktopRuntimeProcessMonitorReadyBackend {
  readonly backendId: string;
  readonly backendGeneration: string;
  readonly backendName: string;
  readonly usageSupported: boolean;
  readonly terminateSupported: boolean;
  readonly state: "ready";
  readonly capturedAt: number;
  readonly processes: readonly DesktopRuntimeProcessMonitorProcess[];
}

export interface DesktopRuntimeProcessMonitorErrorBackend {
  readonly backendId: string;
  readonly backendGeneration: string;
  readonly backendName: string;
  readonly usageSupported: boolean;
  readonly terminateSupported: boolean;
  readonly state: "error";
  readonly error: string;
}

export type DesktopRuntimeProcessMonitorBackend =
  | DesktopRuntimeProcessMonitorReadyBackend
  | DesktopRuntimeProcessMonitorErrorBackend;

export interface DesktopRuntimeProcessMonitorSession {
  readonly sessionId: string;
  readonly backendId: string;
  readonly sessionName: string;
  readonly generation: string;
}

export interface DesktopRuntimeProcessMonitorSnapshot {
  readonly kind: "snapshot";
  readonly locale: "en" | "zh-CN" | "en-XA";
  readonly backends: readonly DesktopRuntimeProcessMonitorBackend[];
  readonly sessions: readonly DesktopRuntimeProcessMonitorSession[];
}

export type DesktopRuntimeProcessMonitorResult =
  | DesktopRuntimeProcessMonitorSnapshot
  | { readonly kind: "terminated" }
  | { readonly kind: "error"; readonly message: string };

export interface DesktopRuntimeProcessMonitorResponse {
  readonly version: 1;
  readonly requestId: string;
  readonly owner: DesktopRuntimeProcessMonitorOwner;
  readonly result: DesktopRuntimeProcessMonitorResult;
}

export interface DesktopRuntimeProcessMonitorOpenResult {
  readonly version: 1;
  readonly focusedExisting: boolean;
}

export function parseDesktopRuntimeProcessMonitorOwner(value: unknown): DesktopRuntimeProcessMonitorOwner {
  if (!plainRecordWithKeys(value, ["version", "profileId", "serverId", "connectionGeneration", "snapshotGeneration"]) ||
    value.version !== RUNTIME_PROCESS_MONITOR_PROTOCOL_VERSION ||
    !boundedText(value.profileId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) ||
    !boundedText(value.serverId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) ||
    !positiveSafeDecimal(value.connectionGeneration) ||
    !positiveUint64Decimal(value.snapshotGeneration)) {
    throw new TypeError("Runtime process monitor owner is invalid.");
  }
  return Object.freeze({
    version: 1,
    profileId: value.profileId,
    serverId: value.serverId,
    connectionGeneration: value.connectionGeneration,
    snapshotGeneration: value.snapshotGeneration
  });
}

export function parseDesktopRuntimeProcessMonitorRequest(value: unknown): DesktopRuntimeProcessMonitorRequest {
  if (!plainRecordWithKeys(value, ["version", "requestId", "owner", "action"]) ||
    value.version !== RUNTIME_PROCESS_MONITOR_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" || !UUID_V4_PATTERN.test(value.requestId)) {
    throw new TypeError("Runtime process monitor request is invalid.");
  }
  const owner = parseDesktopRuntimeProcessMonitorOwner(value.owner);
  if (plainRecordWithKeys(value.action, ["kind"]) && value.action.kind === "refresh") {
    return Object.freeze({ version: 1, requestId: value.requestId as string, owner, action: Object.freeze({ kind: "refresh" }) });
  }
  if (plainRecordWithKeys(value.action, ["kind", "backendGeneration", "process"]) && value.action.kind === "terminate" &&
    positiveSafeDecimal(value.action.backendGeneration)) {
    return Object.freeze({
      version: 1,
      requestId: value.requestId as string,
      owner,
      action: Object.freeze({
        kind: "terminate",
        backendGeneration: value.action.backendGeneration,
        process: parseDesktopRuntimeProcessMonitorProcess(value.action.process)
      })
    });
  }
  throw new TypeError("Runtime process monitor request action is invalid.");
}

export function parseDesktopRuntimeProcessMonitorResponse(value: unknown): DesktopRuntimeProcessMonitorResponse {
  if (!plainRecordWithKeys(value, ["version", "requestId", "owner", "result"]) ||
    value.version !== RUNTIME_PROCESS_MONITOR_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" || !UUID_V4_PATTERN.test(value.requestId)) {
    throw new TypeError("Runtime process monitor response is invalid.");
  }
  const owner = parseDesktopRuntimeProcessMonitorOwner(value.owner);
  const result = parseDesktopRuntimeProcessMonitorResult(value.result);
  return Object.freeze({ version: 1, requestId: value.requestId as string, owner, result });
}

export function parseDesktopRuntimeProcessMonitorOpenResult(value: unknown): DesktopRuntimeProcessMonitorOpenResult {
  if (!plainRecordWithKeys(value, ["version", "focusedExisting"]) ||
    value.version !== RUNTIME_PROCESS_MONITOR_PROTOCOL_VERSION || typeof value.focusedExisting !== "boolean") {
    throw new TypeError("Runtime process monitor open result is invalid.");
  }
  return Object.freeze({ version: 1, focusedExisting: value.focusedExisting });
}

export function sameDesktopRuntimeProcessMonitorOwner(
  left: DesktopRuntimeProcessMonitorOwner,
  right: DesktopRuntimeProcessMonitorOwner
): boolean {
  return left.version === right.version && left.profileId === right.profileId && left.serverId === right.serverId &&
    left.connectionGeneration === right.connectionGeneration && left.snapshotGeneration === right.snapshotGeneration;
}

function parseDesktopRuntimeProcessMonitorResult(value: unknown): DesktopRuntimeProcessMonitorResult {
  if (plainRecordWithKeys(value, ["kind"]) && value.kind === "terminated") return Object.freeze({ kind: "terminated" });
  if (plainRecordWithKeys(value, ["kind", "message"]) && value.kind === "error" &&
    boundedText(value.message, RUNTIME_PROCESS_MONITOR_ERROR_MAX_LENGTH)) {
    return Object.freeze({ kind: "error", message: value.message });
  }
  if (!plainRecordWithKeys(value, ["kind", "locale", "backends", "sessions"]) || value.kind !== "snapshot" ||
    (value.locale !== "en" && value.locale !== "zh-CN" && value.locale !== "en-XA") ||
    !Array.isArray(value.backends) || value.backends.length > RUNTIME_PROCESS_MONITOR_MAX_BACKENDS ||
    !Array.isArray(value.sessions) || value.sessions.length > RUNTIME_PROCESS_MONITOR_MAX_SESSIONS) {
    throw new TypeError("Runtime process monitor result is invalid.");
  }
  const backends = value.backends.map(parseDesktopRuntimeProcessMonitorBackend);
  const sessions = value.sessions.map(parseDesktopRuntimeProcessMonitorSession);
  const backendIds = new Set<string>();
  for (const backend of backends) {
    if (backendIds.has(backend.backendId)) throw new TypeError("Runtime process monitor Backend identities must be unique.");
    backendIds.add(backend.backendId);
  }
  const sessionKeys = new Set<string>();
  for (const session of sessions) {
    const key = `${session.backendId}\u0000${session.sessionId}`;
    if (!backendIds.has(session.backendId) || sessionKeys.has(key)) {
      throw new TypeError("Runtime process monitor Session identities are invalid.");
    }
    sessionKeys.add(key);
  }
  for (const backend of backends) {
    if (backend.state !== "ready") continue;
    for (const process of backend.processes) {
      if (process.backendId !== backend.backendId || !sessionKeys.has(`${process.backendId}\u0000${process.sessionId}`)) {
        throw new TypeError("Runtime process monitor process ownership is invalid.");
      }
    }
  }
  return Object.freeze({
    kind: "snapshot",
    locale: value.locale,
    backends: Object.freeze(backends),
    sessions: Object.freeze(sessions)
  });
}

function parseDesktopRuntimeProcessMonitorBackend(value: unknown): DesktopRuntimeProcessMonitorBackend {
  if (plainRecordWithKeys(value, ["backendId", "backendGeneration", "backendName", "usageSupported", "terminateSupported", "state", "capturedAt", "processes"]) &&
    boundedText(value.backendId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) &&
    positiveSafeDecimal(value.backendGeneration) &&
    boundedDisplayText(value.backendName, RUNTIME_PROCESS_MONITOR_NAME_MAX_LENGTH) &&
    typeof value.usageSupported === "boolean" && typeof value.terminateSupported === "boolean" && value.state === "ready" &&
    Number.isSafeInteger(value.capturedAt) && (value.capturedAt as number) >= 0 && Array.isArray(value.processes) &&
    value.processes.length <= RUNTIME_PROCESS_MONITOR_MAX_PROCESSES_PER_BACKEND) {
    return Object.freeze({
      backendId: value.backendId,
      backendGeneration: value.backendGeneration,
      backendName: value.backendName,
      usageSupported: value.usageSupported,
      terminateSupported: value.terminateSupported,
      state: "ready",
      capturedAt: value.capturedAt as number,
      processes: Object.freeze(value.processes.map(parseDesktopRuntimeProcessMonitorProcess))
    });
  }
  if (plainRecordWithKeys(value, ["backendId", "backendGeneration", "backendName", "usageSupported", "terminateSupported", "state", "error"]) &&
    boundedText(value.backendId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) &&
    positiveSafeDecimal(value.backendGeneration) &&
    boundedDisplayText(value.backendName, RUNTIME_PROCESS_MONITOR_NAME_MAX_LENGTH) &&
    typeof value.usageSupported === "boolean" && typeof value.terminateSupported === "boolean" && value.state === "error" &&
    boundedText(value.error, RUNTIME_PROCESS_MONITOR_ERROR_MAX_LENGTH)) {
    return Object.freeze({
      backendId: value.backendId,
      backendGeneration: value.backendGeneration,
      backendName: value.backendName,
      usageSupported: value.usageSupported,
      terminateSupported: value.terminateSupported,
      state: "error",
      error: value.error
    });
  }
  throw new TypeError("Runtime process monitor Backend state is invalid.");
}

function parseDesktopRuntimeProcessMonitorSession(value: unknown): DesktopRuntimeProcessMonitorSession {
  if (!plainRecordWithKeys(value, ["sessionId", "backendId", "sessionName", "generation"]) ||
    !boundedText(value.sessionId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) ||
    !boundedText(value.backendId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) ||
    !boundedDisplayText(value.sessionName, RUNTIME_PROCESS_MONITOR_NAME_MAX_LENGTH) ||
    !positiveUint64Decimal(value.generation)) {
    throw new TypeError("Runtime process monitor Session is invalid.");
  }
  return Object.freeze({
    sessionId: value.sessionId,
    backendId: value.backendId,
    sessionName: value.sessionName,
    generation: value.generation
  });
}

function parseDesktopRuntimeProcessMonitorProcess(value: unknown): DesktopRuntimeProcessMonitorProcess {
  const required = ["backendId", "sessionId", "generation", "pid", "cpuPercent", "memoryKb", "processCount", "terminable"];
  const hasInstance = plainRecordWithKeys(value, [...required, "processInstanceId"]);
  if ((!hasInstance && !plainRecordWithKeys(value, required)) ||
    !boundedText(value.backendId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) ||
    !boundedText(value.sessionId, RUNTIME_PROCESS_MONITOR_ID_MAX_LENGTH) ||
    !positiveSafeInteger(value.generation) || !positiveSafeInteger(value.pid) ||
    typeof value.cpuPercent !== "number" || !Number.isFinite(value.cpuPercent) || value.cpuPercent < 0 ||
    !nonNegativeSafeInteger(value.memoryKb) || !positiveSafeInteger(value.processCount) ||
    typeof value.terminable !== "boolean" ||
    (value.terminable !== hasInstance) ||
    (hasInstance && (typeof value.processInstanceId !== "string" || !UUID_V4_PATTERN.test(value.processInstanceId)))) {
    throw new TypeError("Runtime process monitor process is invalid.");
  }
  return Object.freeze({
    backendId: value.backendId,
    sessionId: value.sessionId,
    generation: value.generation,
    pid: value.pid,
    cpuPercent: value.cpuPercent,
    memoryKb: value.memoryKb,
    processCount: value.processCount,
    terminable: value.terminable,
    ...(hasInstance ? { processInstanceId: value.processInstanceId as string } : {})
  });
}

function positiveSafeDecimal(value: unknown): value is string {
  return typeof value === "string" && POSITIVE_SAFE_DECIMAL_PATTERN.test(value) &&
    BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function positiveUint64Decimal(value: unknown): value is string {
  return typeof value === "string" && POSITIVE_UINT64_DECIMAL_PATTERN.test(value) && BigInt(value) <= MAXIMUM_UINT64;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedDisplayText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function plainRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export interface RuntimeProcessMonitorBinding<TEndpoint> {
  readonly owner: DesktopRuntimeProcessMonitorOwner;
  readonly ownerEndpoint: TEndpoint;
  readonly monitorEndpoint: TEndpoint;
}

export interface RuntimeProcessMonitorBrokerOptions<TEndpoint> {
  readonly setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onTimeout: (target: TEndpoint, response: DesktopRuntimeProcessMonitorResponse) => void;
}

interface PendingRuntimeProcessMonitorRequest {
  readonly action: DesktopRuntimeProcessMonitorAction["kind"];
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Process-local routing fence. Native window creation and sender trust remain owned by Main. */
export class RuntimeProcessMonitorBroker<TEndpoint> {
  readonly #setTimer: NonNullable<RuntimeProcessMonitorBrokerOptions<TEndpoint>["setTimer"]>;
  readonly #clearTimer: NonNullable<RuntimeProcessMonitorBrokerOptions<TEndpoint>["clearTimer"]>;
  readonly #onTimeout: RuntimeProcessMonitorBrokerOptions<TEndpoint>["onTimeout"];
  #binding: RuntimeProcessMonitorBinding<TEndpoint> | undefined;
  readonly #pending = new Map<string, PendingRuntimeProcessMonitorRequest>();

  constructor(options: RuntimeProcessMonitorBrokerOptions<TEndpoint>) {
    this.#setTimer = options.setTimer ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#onTimeout = options.onTimeout;
  }

  get binding(): RuntimeProcessMonitorBinding<TEndpoint> | undefined {
    return this.#binding;
  }

  matchesOwner(endpoint: TEndpoint, owner: DesktopRuntimeProcessMonitorOwner): boolean {
    return this.#binding?.ownerEndpoint === endpoint && sameDesktopRuntimeProcessMonitorOwner(this.#binding.owner, owner);
  }

  bind(binding: RuntimeProcessMonitorBinding<TEndpoint>): RuntimeProcessMonitorBinding<TEndpoint> | undefined {
    const retired = this.retire();
    this.#binding = binding;
    return retired;
  }

  ownerForMonitor(endpoint: TEndpoint): DesktopRuntimeProcessMonitorOwner {
    if (this.#binding?.monitorEndpoint !== endpoint) throw new Error("Runtime process monitor owner is unavailable.");
    return this.#binding.owner;
  }

  acceptRequest(endpoint: TEndpoint, request: DesktopRuntimeProcessMonitorRequest): TEndpoint {
    const binding = this.#binding;
    if (binding === undefined || binding.monitorEndpoint !== endpoint || !sameDesktopRuntimeProcessMonitorOwner(binding.owner, request.owner)) {
      throw new Error("Runtime process monitor request crossed its owner occurrence.");
    }
    if (this.#pending.has(request.requestId)) throw new Error("Runtime process monitor request identity is already pending.");
    if (this.#pending.size >= RUNTIME_PROCESS_MONITOR_MAX_PENDING_REQUESTS) {
      throw new Error("Runtime process monitor has too many pending requests.");
    }
    const timer = this.#setTimer(() => {
      const pending = this.#pending.get(request.requestId);
      const current = this.#binding;
      if (pending === undefined || current !== binding) return;
      this.#pending.delete(request.requestId);
      this.#onTimeout(binding.monitorEndpoint, Object.freeze({
        version: 1,
        requestId: request.requestId,
        owner: binding.owner,
        result: Object.freeze({ kind: "error", message: "Runtime process diagnostics did not respond in time." })
      }));
    }, RUNTIME_PROCESS_MONITOR_REQUEST_TIMEOUT_MS);
    this.#pending.set(request.requestId, { action: request.action.kind, timer });
    return binding.ownerEndpoint;
  }

  acceptResponse(endpoint: TEndpoint, response: DesktopRuntimeProcessMonitorResponse): TEndpoint {
    const binding = this.#binding;
    if (binding === undefined || binding.ownerEndpoint !== endpoint || !sameDesktopRuntimeProcessMonitorOwner(binding.owner, response.owner)) {
      throw new Error("Runtime process monitor response crossed its owner occurrence.");
    }
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined || !responseMatchesAction(pending.action, response.result.kind)) {
      throw new Error("Runtime process monitor response does not match a pending request.");
    }
    this.#clearTimer(pending.timer);
    this.#pending.delete(response.requestId);
    return binding.monitorEndpoint;
  }

  cancelRequest(endpoint: TEndpoint, requestId: string): void {
    if (this.#binding?.monitorEndpoint !== endpoint) return;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#clearTimer(pending.timer);
    this.#pending.delete(requestId);
  }

  clearMonitorDocument(endpoint: TEndpoint): void {
    if (this.#binding?.monitorEndpoint !== endpoint) return;
    this.#clearPending();
  }

  retireEndpoint(endpoint: TEndpoint): RuntimeProcessMonitorBinding<TEndpoint> | undefined {
    if (this.#binding?.ownerEndpoint !== endpoint && this.#binding?.monitorEndpoint !== endpoint) return undefined;
    return this.retire();
  }

  retire(): RuntimeProcessMonitorBinding<TEndpoint> | undefined {
    const retired = this.#binding;
    this.#binding = undefined;
    this.#clearPending();
    return retired;
  }

  #clearPending(): void {
    for (const pending of this.#pending.values()) this.#clearTimer(pending.timer);
    this.#pending.clear();
  }
}

function responseMatchesAction(
  action: DesktopRuntimeProcessMonitorAction["kind"],
  result: DesktopRuntimeProcessMonitorResult["kind"]
): boolean {
  return result === "error" || (action === "refresh" ? result === "snapshot" : result === "terminated");
}
