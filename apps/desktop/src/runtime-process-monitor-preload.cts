import type {
  DesktopRuntimeProcessMonitorBackend,
  DesktopRuntimeProcessMonitorOwner,
  DesktopRuntimeProcessMonitorProcess,
  DesktopRuntimeProcessMonitorRequest,
  DesktopRuntimeProcessMonitorResponse,
  DesktopRuntimeProcessMonitorSession,
  DesktopRuntimeProcessSample
} from "./channels.js";
import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const CHANNELS = Object.freeze({
  windowMinimize: "joko:window:minimize",
  windowToggleMaximize: "joko:window:toggle-maximize",
  windowSetZoomFactor: "joko:window:set-zoom-factor",
  windowClose: "joko:window:close",
  getOwner: "joko:runtime-process-diagnostics:owner:get",
  request: "joko:runtime-process-diagnostics:request",
  response: "joko:runtime-process-diagnostics:response",
  retired: "joko:runtime-process-diagnostics:retired",
  sampleDesktop: "joko:runtime-process-monitor:sample-desktop"
});

const api = Object.freeze({
  version: 1 as const,
  platform: process.platform,
  window: Object.freeze({
    minimize: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowMinimize).then(() => undefined),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.windowToggleMaximize),
    setZoomFactor: (zoomFactor: number): Promise<void> => {
      if (!Number.isFinite(zoomFactor) || zoomFactor < 0.5 || zoomFactor > 3) {
        return Promise.reject(new TypeError("Runtime diagnostics zoom factor is invalid."));
      }
      return ipcRenderer.invoke(CHANNELS.windowSetZoomFactor, zoomFactor).then(() => undefined);
    },
    close: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowClose).then(() => undefined)
  }),
  getOwner: (): Promise<DesktopRuntimeProcessMonitorOwner> =>
    ipcRenderer.invoke(CHANNELS.getOwner).then(parseOwner),
  sampleDesktop: (): Promise<DesktopRuntimeProcessSample> =>
    ipcRenderer.invoke(CHANNELS.sampleDesktop).then(parseDesktopSample),
  request: (request: DesktopRuntimeProcessMonitorRequest): Promise<void> => {
    const parsed = parseRequest(request);
    return ipcRenderer.invoke(CHANNELS.request, parsed).then(() => undefined);
  },
  onResponse: (listener: (response: DesktopRuntimeProcessMonitorResponse) => void): (() => void) => {
    if (typeof listener !== "function") throw new TypeError("Runtime diagnostics response listener is invalid.");
    const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
      try { listener(parseResponse(value)); } catch { /* Ignore malformed projections from a retired document. */ }
    };
    ipcRenderer.on(CHANNELS.response, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.response, wrapped);
  },
  onRetired: (listener: () => void): (() => void) => {
    if (typeof listener !== "function") throw new TypeError("Runtime diagnostics retirement listener is invalid.");
    const wrapped = (): void => listener();
    ipcRenderer.on(CHANNELS.retired, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.retired, wrapped);
  }
});

contextBridge.exposeInMainWorld("jokoRuntimeProcessDiagnostics", api);

function parseOwner(value: unknown): DesktopRuntimeProcessMonitorOwner {
  if (!record(value, ["version", "profileId", "serverId", "connectionGeneration", "snapshotGeneration"]) ||
    value["version"] !== 1 || !identity(value["profileId"]) || !identity(value["serverId"]) ||
    !safeGeneration(value["connectionGeneration"]) || !uint64Generation(value["snapshotGeneration"])) {
    throw new TypeError("Runtime diagnostics owner is invalid.");
  }
  return Object.freeze({
    version: 1,
    profileId: value["profileId"],
    serverId: value["serverId"],
    connectionGeneration: value["connectionGeneration"],
    snapshotGeneration: value["snapshotGeneration"]
  });
}

function parseDesktopSample(value: unknown): DesktopRuntimeProcessSample {
  if (!record(value, ["version", "capturedAt", "processes"]) || value["version"] !== 1 ||
    !Number.isSafeInteger(value["capturedAt"]) || (value["capturedAt"] as number) < 0 ||
    !Array.isArray(value["processes"]) || value["processes"].length > 512) {
    throw new TypeError("Desktop runtime process sample is invalid.");
  }
  const processes = value["processes"].map((process) => {
    if (!record(process, ["role", "pid", "label", "cpuPercent", "memoryKb", "processCount"]) ||
      (process["role"] !== "main" && process["role"] !== "renderer" && process["role"] !== "gpu" && process["role"] !== "utility") ||
      !positiveInteger(process["pid"]) || !(process["label"] === null || boundedText(process["label"], 512)) ||
      typeof process["cpuPercent"] !== "number" || !Number.isFinite(process["cpuPercent"]) || process["cpuPercent"] < 0 ||
      !Number.isSafeInteger(process["memoryKb"]) || (process["memoryKb"] as number) < 0 || process["processCount"] !== 1) {
      throw new TypeError("Desktop runtime process metric is invalid.");
    }
    return Object.freeze({
      role: process["role"], pid: process["pid"], label: process["label"], cpuPercent: process["cpuPercent"],
      memoryKb: process["memoryKb"] as number, processCount: 1 as const
    });
  });
  if (new Set(processes.map((process) => process.pid)).size !== processes.length) {
    throw new TypeError("Desktop runtime process identities must be unique.");
  }
  return Object.freeze({ version: 1, capturedAt: value["capturedAt"] as number, processes: Object.freeze(processes) });
}

function parseRequest(value: unknown): DesktopRuntimeProcessMonitorRequest {
  if (!record(value, ["version", "requestId", "owner", "action"]) || value["version"] !== 1 || !uuid(value["requestId"])) {
    throw new TypeError("Runtime diagnostics request is invalid.");
  }
  const owner = parseOwner(value["owner"]);
  const action = value["action"];
  if (record(action, ["kind"]) && action["kind"] === "refresh") {
    return Object.freeze({ version: 1, requestId: value["requestId"], owner, action: Object.freeze({ kind: "refresh" }) });
  }
  if (record(action, ["kind", "backendGeneration", "process"]) && action["kind"] === "terminate" &&
    safeGeneration(action["backendGeneration"])) {
    const process = parseProcess(action["process"]);
    if (process.role !== "task-host" || !process.terminable || process.processInstanceId === undefined) {
      throw new TypeError("Runtime diagnostics termination fence is invalid.");
    }
    return Object.freeze({
      version: 1,
      requestId: value["requestId"],
      owner,
      action: Object.freeze({
        kind: "terminate",
        backendGeneration: action["backendGeneration"],
        process
      })
    });
  }
  throw new TypeError("Runtime diagnostics request action is invalid.");
}

function parseResponse(value: unknown): DesktopRuntimeProcessMonitorResponse {
  if (!record(value, ["version", "requestId", "owner", "result"]) || value["version"] !== 1 || !uuid(value["requestId"])) {
    throw new TypeError("Runtime diagnostics response is invalid.");
  }
  const owner = parseOwner(value["owner"]);
  const result = value["result"];
  if (record(result, ["kind"]) && result["kind"] === "terminated") {
    return Object.freeze({ version: 1, requestId: value["requestId"], owner, result: Object.freeze({ kind: "terminated" }) });
  }
  if (record(result, ["kind", "message"]) && result["kind"] === "error" && boundedText(result["message"], 2_048)) {
    return Object.freeze({
      version: 1,
      requestId: value["requestId"],
      owner,
      result: Object.freeze({ kind: "error", message: result["message"] })
    });
  }
  if (!record(result, ["kind", "locale", "backends", "sessions"]) || result["kind"] !== "snapshot" ||
    (result["locale"] !== "en" && result["locale"] !== "zh-CN" && result["locale"] !== "en-XA") ||
    !Array.isArray(result["backends"]) || result["backends"].length > 128 ||
    !Array.isArray(result["sessions"]) || result["sessions"].length > 4_096) {
    throw new TypeError("Runtime diagnostics snapshot is invalid.");
  }
  const backends = result["backends"].map(parseBackend);
  const sessions = result["sessions"].map(parseSession);
  const backendIds = new Set(backends.map((backend) => backend.backendId));
  if (backendIds.size !== backends.length || sessions.some((session) => !backendIds.has(session.backendId))) {
    throw new TypeError("Runtime diagnostics snapshot ownership is invalid.");
  }
  const sessionKeys = new Set(sessions.map((session) => `${session.backendId}\u0000${session.sessionId}`));
  if (sessionKeys.size !== sessions.length || backends.some((backend) => backend.state === "ready" &&
    backend.processes.some((process) => process.backendId !== backend.backendId ||
      (process.role === "task-host" && !sessionKeys.has(`${process.backendId}\u0000${process.sessionId}`))))) {
    throw new TypeError("Runtime diagnostics process ownership is invalid.");
  }
  return Object.freeze({
    version: 1,
    requestId: value["requestId"],
    owner,
    result: Object.freeze({
      kind: "snapshot",
      locale: result["locale"],
      backends: Object.freeze(backends),
      sessions: Object.freeze(sessions)
    })
  });
}

function parseBackend(value: unknown): DesktopRuntimeProcessMonitorBackend {
  if (record(value, ["backendId", "backendGeneration", "backendName", "usageSupported", "terminateSupported", "state", "capturedAt", "processes"]) &&
    identity(value["backendId"]) && safeGeneration(value["backendGeneration"]) && displayText(value["backendName"]) && typeof value["usageSupported"] === "boolean" &&
    typeof value["terminateSupported"] === "boolean" && value["state"] === "ready" &&
    Number.isSafeInteger(value["capturedAt"]) && (value["capturedAt"] as number) >= 0 &&
    Array.isArray(value["processes"]) && value["processes"].length <= 512) {
    return Object.freeze({
      backendId: value["backendId"], backendGeneration: value["backendGeneration"], backendName: value["backendName"], usageSupported: value["usageSupported"],
      terminateSupported: value["terminateSupported"], state: "ready", capturedAt: value["capturedAt"] as number,
      processes: Object.freeze(value["processes"].map(parseProcess))
    });
  }
  if (record(value, ["backendId", "backendGeneration", "backendName", "usageSupported", "terminateSupported", "state", "error"]) &&
    identity(value["backendId"]) && safeGeneration(value["backendGeneration"]) && displayText(value["backendName"]) && typeof value["usageSupported"] === "boolean" &&
    typeof value["terminateSupported"] === "boolean" && value["state"] === "error" && boundedText(value["error"], 2_048)) {
    return Object.freeze({
      backendId: value["backendId"], backendGeneration: value["backendGeneration"], backendName: value["backendName"], usageSupported: value["usageSupported"],
      terminateSupported: value["terminateSupported"], state: "error", error: value["error"]
    });
  }
  throw new TypeError("Runtime diagnostics Backend is invalid.");
}

function parseSession(value: unknown): DesktopRuntimeProcessMonitorSession {
  if (!record(value, ["sessionId", "backendId", "sessionName", "generation"]) || !identity(value["sessionId"]) ||
    !identity(value["backendId"]) || !displayText(value["sessionName"]) || !uint64Generation(value["generation"])) {
    throw new TypeError("Runtime diagnostics Session is invalid.");
  }
  return Object.freeze({
    sessionId: value["sessionId"], backendId: value["backendId"], sessionName: value["sessionName"], generation: value["generation"]
  });
}

function parseProcess(value: unknown): DesktopRuntimeProcessMonitorProcess {
  const base = ["backendId", "role", "pid", "cpuPercent", "memoryKb", "processCount", "terminable"];
  if (!record(value, base) || value["role"] !== "control-plane" || value["terminable"] !== false ||
    !identity(value["backendId"]) || !positiveInteger(value["pid"]) || typeof value["cpuPercent"] !== "number" ||
    !Number.isFinite(value["cpuPercent"]) || value["cpuPercent"] < 0 || !Number.isSafeInteger(value["memoryKb"]) ||
    (value["memoryKb"] as number) < 0 || !positiveInteger(value["processCount"])) {
    const task = [...base, "sessionId", "generation"];
    const hasInstance = record(value, [...task, "processInstanceId"]);
    if ((!hasInstance && !record(value, task)) || value["role"] !== "task-host" || !identity(value["backendId"]) ||
      !identity(value["sessionId"]) || !positiveInteger(value["generation"]) || !positiveInteger(value["pid"]) ||
      typeof value["cpuPercent"] !== "number" || !Number.isFinite(value["cpuPercent"]) || value["cpuPercent"] < 0 ||
      !Number.isSafeInteger(value["memoryKb"]) || (value["memoryKb"] as number) < 0 ||
      !positiveInteger(value["processCount"]) || typeof value["terminable"] !== "boolean" ||
      value["terminable"] !== hasInstance || (hasInstance && !uuid(value["processInstanceId"]))) {
      throw new TypeError("Runtime diagnostics process is invalid.");
    }
    return Object.freeze({
      backendId: value["backendId"], role: "task-host", sessionId: value["sessionId"], generation: value["generation"], pid: value["pid"],
      cpuPercent: value["cpuPercent"], memoryKb: value["memoryKb"] as number, processCount: value["processCount"],
      terminable: value["terminable"], ...(hasInstance ? { processInstanceId: value["processInstanceId"] as string } : {})
    });
  }
  return Object.freeze({
    backendId: value["backendId"], role: "control-plane", pid: value["pid"],
    cpuPercent: value["cpuPercent"], memoryKb: value["memoryKb"] as number, processCount: value["processCount"],
    terminable: false
  });
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function identity(value: unknown): value is string {
  return boundedText(value, 512);
}

function displayText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function uint64Generation(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
