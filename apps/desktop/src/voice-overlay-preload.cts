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
  if ((state === "idle" || state === "starting") && Object.keys(candidate).join(",") === "state") {
    return Object.freeze({ state });
  }
  if (state === "listening" || state === "submitting") {
    if (Object.keys(candidate).sort().join(",") !== "state,transcript"
      || typeof candidate["transcript"] !== "string"
      || candidate["transcript"].length > 4_096
      || /\u0000/u.test(candidate["transcript"])) {
      throw new TypeError("Global voice status is invalid.");
    }
    return Object.freeze({ state, transcript: candidate["transcript"] });
  }
  const errorKind = candidate["errorKind"];
  if (state === "error"
    && Object.keys(candidate).sort().join(",") === "errorKind,state"
    && (errorKind === "unsupported" || errorKind === "permission" || errorKind === "microphone"
      || errorKind === "service" || errorKind === "empty" || errorKind === "insertion")) {
    return Object.freeze({ state, errorKind });
  }
  throw new TypeError("Global voice status is invalid.");
}
