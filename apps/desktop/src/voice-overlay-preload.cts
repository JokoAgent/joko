import type { DesktopGlobalVoiceStatus } from "./channels.js";
import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const CHANNELS = Object.freeze({
  getStatus: "joko:global-voice:status:get",
  status: "joko:global-voice:status",
  action: "joko:global-voice:overlay-action"
});

contextBridge.exposeInMainWorld("jokoVoiceOverlay", Object.freeze({
  getStatus: (): Promise<DesktopGlobalVoiceStatus> =>
    ipcRenderer.invoke(CHANNELS.getStatus).then(parseStatus),
  onStatus: (listener: (status: DesktopGlobalVoiceStatus) => void): (() => void) => {
    if (typeof listener !== "function") throw new TypeError("Global voice status listener must be a function.");
    const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
      try {
        listener(parseStatus(value));
      } catch {
        // Ignore malformed host projections; getStatus remains authoritative.
      }
    };
    ipcRenderer.on(CHANNELS.status, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.status, wrapped);
  },
  cancel: (): Promise<void> => ipcRenderer.invoke(CHANNELS.action, "cancel").then(() => undefined),
  retry: (): Promise<void> => ipcRenderer.invoke(CHANNELS.action, "retry").then(() => undefined)
}));

function parseStatus(value: unknown): DesktopGlobalVoiceStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Global voice status is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const state = candidate["state"];
  const generation = candidate["generation"];
  if (!isGlobalVoiceGeneration(generation, true) || (generation === "0" && state !== "idle")) {
    throw new TypeError("Global voice status is invalid.");
  }
  if ((state === "idle" || state === "starting")
    && hasExactStatusKeys(candidate, ["state", "generation"])) {
    return Object.freeze({ state, generation });
  }
  if (state === "listening" || state === "submitting") {
    if (!hasExactStatusKeys(candidate, ["state", "generation", "transcript"])
      || typeof candidate["transcript"] !== "string"
      || candidate["transcript"].length > 4_096
      || /\u0000/u.test(candidate["transcript"])) {
      throw new TypeError("Global voice status is invalid.");
    }
    return Object.freeze({ state, generation, transcript: candidate["transcript"] });
  }
  const errorKind = candidate["errorKind"];
  if (state === "error"
    && hasExactStatusKeys(candidate, ["state", "generation", "errorKind"])
    && (errorKind === "unsupported" || errorKind === "permission" || errorKind === "microphone"
      || errorKind === "service" || errorKind === "empty" || errorKind === "insertion")) {
    return Object.freeze({ state, generation, errorKind });
  }
  throw new TypeError("Global voice status is invalid.");
}

function isGlobalVoiceGeneration(value: unknown, allowIdle = false): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  if (!allowIdle && value === "0") return false;
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function hasExactStatusKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(candidate);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key));
}
