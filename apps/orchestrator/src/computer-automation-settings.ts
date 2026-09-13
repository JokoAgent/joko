import { create } from "@bufbuild/protobuf";
import {
  AutomationPermissionState,
  CapabilitySupport,
  ComputerAutomationRuntimeState,
  ComputerAutomationUpdatePhase,
  ComputerAutomationSettingsSchema,
  type ComputerAutomationSettings
} from "@joko/contracts";
import type { OperationalStore, SettingRecord } from "@joko/store";

import { toProtoEntityVersion } from "./proto-mapper.js";

const SETTING_KEY = "settings.automation.computer";
const SCOPE_TYPE = "service" as const;
const SCOPE_ID = "orchestrator";

export type ComputerPermissionKind = "accessibility" | "screenRecording" | "all";
export type ComputerPermissionState = "granted" | "missing" | "unknown" | "notRequired";

export interface ComputerAutomationProbe {
  readonly support: "supported" | "upstreamMissing" | "platformLimited" | "temporarilyUnavailable";
  readonly supportReason?: string;
  readonly installed: boolean;
  readonly driverVersion?: string;
  readonly daemonRunning: boolean;
  readonly accessibilityPermission: ComputerPermissionState;
  readonly screenRecordingPermission: ComputerPermissionState;
  readonly screenRecordingCapturable: boolean;
  readonly ready: boolean;
  readonly failureReason?: string;
  readonly platform: string;
}

export interface ComputerAutomationRuntime {
  probe(options?: { readonly fresh?: boolean; readonly signal?: AbortSignal }): Promise<ComputerAutomationProbe>;
  install(options?: { readonly signal?: AbortSignal }): Promise<void>;
  requestPermission(
    permission: ComputerPermissionKind,
    options?: { readonly signal?: AbortSignal }
  ): Promise<void>;
  openPermissionSettings?(
    permission: Exclude<ComputerPermissionKind, "all">,
    options?: { readonly signal?: AbortSignal }
  ): Promise<void>;
  cancelPermissionRequest?(): void;
  checkForUpdate?(options?: { readonly signal?: AbortSignal; readonly fresh?: boolean }): Promise<ComputerAutomationUpdateCheck>;
  updateDriver?(options?: {
    readonly signal?: AbortSignal;
    readonly joinOnly?: boolean;
    readonly onProgress?: (progress: ComputerAutomationUpdateProgress) => void;
  }): Promise<void>;
}

export interface ComputerAutomationUpdateCheck {
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly updating: boolean;
}

export interface ComputerAutomationUpdateProgress {
  readonly phase: "downloading" | "installing" | "done";
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
}

export interface ComputerAutomationSettingsControllerOptions {
  readonly store: OperationalStore;
  readonly runtime?: ComputerAutomationRuntime;
  readonly refreshGeneration?: () => Promise<void>;
  readonly now?: () => number;
}

interface StoredComputerAutomationSettings {
  readonly format: 1;
  readonly enabled: boolean;
}

const unavailableProbe = (reason: string): ComputerAutomationProbe => ({
  support: "upstreamMissing",
  supportReason: reason,
  installed: false,
  daemonRunning: false,
  accessibilityPermission: "unknown",
  screenRecordingPermission: "unknown",
  screenRecordingCapturable: false,
  ready: false,
  platform: process.platform
});

/**
 * Owns the machine-global opt-in and a credential-free runtime projection.
 * Active Agent sessions retain their frozen Tool generation; the injected
 * refresh only publishes the changed policy to sessions created afterward.
 */
export class ComputerAutomationSettingsController {
  readonly #store: OperationalStore;
  readonly #runtime: ComputerAutomationRuntime | undefined;
  readonly #refreshGeneration: () => Promise<void>;
  readonly #now: () => number;
  #status: ComputerAutomationProbe;
  #checking = false;
  #update: ComputerAutomationUpdateCheck = { updateAvailable: false, updating: false };
  #updateProgress: ComputerAutomationUpdateProgress | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ComputerAutomationSettingsControllerOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#refreshGeneration = options.refreshGeneration ?? (() => Promise.resolve());
    this.#now = options.now ?? Date.now;
    const existing = this.#store.findSetting<unknown>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY);
    if (existing === undefined) {
      this.#store.setSetting<StoredComputerAutomationSettings>(
        SCOPE_TYPE,
        SCOPE_ID,
        SETTING_KEY,
        { format: 1, enabled: false },
        this.#now()
      );
    } else {
      decodeSetting(existing.value);
    }
    this.#status = options.runtime === undefined
      ? unavailableProbe("The local computer automation runtime is not configured on this Orchestrator node.")
      : {
          ...unavailableProbe("Computer automation has not been checked yet."),
          support: "temporarilyUnavailable"
        };
  }

  enabled(): boolean {
    return this.#setting().enabled;
  }

  availableForNewSessions(): boolean {
    return this.enabled() && this.#status.ready;
  }

  snapshot(): ComputerAutomationSettings {
    const record = this.#record();
    const status = this.#status;
    return create(ComputerAutomationSettingsSchema, {
      enabled: record.value.enabled,
      support: toProtoSupport(status.support),
      supportReason: boundedPublicReason(status.supportReason),
      installed: status.installed,
      driverVersion: boundedVersion(status.driverVersion),
      daemonRunning: status.daemonRunning,
      accessibilityPermission: toProtoPermission(status.accessibilityPermission),
      screenRecordingPermission: toProtoPermission(status.screenRecordingPermission),
      screenRecordingCapturable: status.screenRecordingCapturable,
      ready: status.ready,
      runtimeState: this.#checking
        ? ComputerAutomationRuntimeState.CHECKING
        : !record.value.enabled
          ? ComputerAutomationRuntimeState.DISABLED
          : status.ready
            ? ComputerAutomationRuntimeState.READY
            : status.support === "upstreamMissing" || status.support === "platformLimited"
              ? ComputerAutomationRuntimeState.UNAVAILABLE
              : ComputerAutomationRuntimeState.ERROR,
      failureReason: boundedPublicReason(status.failureReason),
      platform: boundedPlatform(status.platform),
      version: toProtoEntityVersion(record.revision, 0, record.updatedAt),
      updateCurrentVersion: boundedVersion(this.#update.currentVersion) || boundedVersion(status.driverVersion),
      updateLatestVersion: boundedVersion(this.#update.latestVersion),
      updateAvailable: this.#update.updateAvailable,
      updateInProgress: this.#update.updating,
      updatePhase: toProtoUpdatePhase(this.#updateProgress?.phase),
      ...(this.#updateProgress?.downloadedBytes === null || this.#updateProgress?.downloadedBytes === undefined
        ? {}
        : { updateDownloadedBytes: BigInt(this.#updateProgress.downloadedBytes) }),
      ...(this.#updateProgress?.totalBytes === null || this.#updateProgress?.totalBytes === undefined
        ? {}
        : { updateTotalBytes: BigInt(this.#updateProgress.totalBytes) })
    });
  }

  updateSnapshot(): ComputerAutomationUpdateCheck {
    return { ...this.#update };
  }

  checkForUpdate(fresh = false, signal?: AbortSignal): Promise<ComputerAutomationUpdateCheck> {
    return this.#enqueue(async () => {
      if (this.#runtime?.checkForUpdate === undefined || !this.#status.installed) {
        this.#update = { updateAvailable: false, updating: false };
        this.#updateProgress = undefined;
        return this.updateSnapshot();
      }
      try {
        this.#update = normalizeUpdateCheck(await this.#runtime.checkForUpdate({ fresh, signal }));
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        this.#update = { updateAvailable: false, updating: false };
        this.#updateProgress = undefined;
      }
      return this.updateSnapshot();
    });
  }

  updateDriver(
    options: {
      readonly signal?: AbortSignal;
      readonly joinOnly?: boolean;
      readonly onProgress?: (progress: ComputerAutomationUpdateProgress) => void;
    } = {}
  ): Promise<ComputerAutomationSettings> {
    return this.#enqueue(async () => {
      if (this.#runtime?.updateDriver === undefined) {
        throw new Error("Computer automation update is unavailable on this Orchestrator node.");
      }
      const wasAvailable = this.availableForNewSessions();
      this.#update = { ...this.#update, updating: true };
      this.#updateProgress = undefined;
      let completed = false;
      try {
        await this.#runtime.updateDriver({
          signal: options.signal,
          joinOnly: options.joinOnly,
          onProgress: (progress) => {
            const normalized = normalizeUpdateProgress(progress);
            this.#updateProgress = normalized;
            options.onProgress?.(normalized);
          }
        });
        await this.#probe(true, options.signal);
        this.#update = { updateAvailable: false, updating: false };
        this.#updateProgress = { phase: "done", downloadedBytes: null, totalBytes: null };
        completed = true;
        if (wasAvailable !== this.availableForNewSessions()) await this.#refreshGeneration();
        return this.snapshot();
      } finally {
        this.#update = { ...this.#update, updating: false };
        if (!completed) this.#updateProgress = undefined;
      }
    });
  }

  probe(fresh = false, signal?: AbortSignal): Promise<ComputerAutomationSettings> {
    return this.#enqueue(async () => {
      const wasAvailable = this.availableForNewSessions();
      await this.#probe(fresh, signal);
      if (wasAvailable !== this.availableForNewSessions()) await this.#refreshGeneration();
      return this.snapshot();
    });
  }

  install(signal?: AbortSignal): Promise<ComputerAutomationSettings> {
    return this.#enqueue(async () => {
      if (this.#runtime === undefined) throw new Error("Computer automation is unavailable on this Orchestrator node.");
      const wasAvailable = this.availableForNewSessions();
      this.#checking = true;
      try {
        signal?.throwIfAborted();
        await this.#runtime.install({ signal });
        await this.#probe(true, signal);
        if (wasAvailable !== this.availableForNewSessions()) await this.#refreshGeneration();
        return this.snapshot();
      } finally {
        this.#checking = false;
      }
    });
  }

  requestPermission(permission: ComputerPermissionKind, signal?: AbortSignal): Promise<ComputerAutomationSettings> {
    return this.#enqueue(async () => {
      if (this.#runtime === undefined) throw new Error("Computer automation is unavailable on this Orchestrator node.");
      const wasAvailable = this.availableForNewSessions();
      this.#checking = true;
      try {
        signal?.throwIfAborted();
        await this.#runtime.requestPermission(permission, { signal });
        await this.#probe(true, signal);
        if (wasAvailable !== this.availableForNewSessions()) await this.#refreshGeneration();
        return this.snapshot();
      } finally {
        this.#checking = false;
      }
    });
  }

  cancelPermissionRequest(): void {
    this.#runtime?.cancelPermissionRequest?.();
  }

  openPermissionSettings(
    permission: Exclude<ComputerPermissionKind, "all">,
    signal?: AbortSignal
  ): Promise<ComputerAutomationSettings> {
    return this.#enqueue(async () => {
      if (this.#runtime?.openPermissionSettings === undefined) {
        throw new Error("Computer system permission settings are unavailable on this Orchestrator node.");
      }
      signal?.throwIfAborted();
      await this.#runtime.openPermissionSettings(permission, { signal });
      return this.snapshot();
    });
  }

  setEnabled(enabled: boolean, signal?: AbortSignal): Promise<ComputerAutomationSettings> {
    if (!enabled) this.cancelPermissionRequest();
    return this.#enqueue(async () => {
      const current = this.#record();
      if (current.value.enabled === enabled) {
        if (enabled) await this.#probe(true, signal);
        return this.snapshot();
      }
      if (enabled) {
        if (this.#runtime === undefined) throw new Error("Computer automation is unavailable on this Orchestrator node.");
        await this.#probe(true, signal);
        if (!this.#status.installed) {
          this.#checking = true;
          try {
            await this.#runtime.install({ signal });
            await this.#probe(true, signal);
          } finally {
            this.#checking = false;
          }
        }
        if (!this.#status.ready && this.#status.installed && this.#status.platform === "darwin") {
          this.#checking = true;
          try {
            await this.#runtime.requestPermission("all", { signal });
            await this.#probe(true, signal);
          } finally {
            this.#checking = false;
          }
        }
        if (!this.#status.ready) {
          throw new Error(this.#status.failureReason || this.#status.supportReason || "Computer automation is not ready.");
        }
      }

      // The owner policy becomes durable before a fresh Pi generation is
      // published. Existing sessions keep the generation they already own.
      this.#store.setSetting<StoredComputerAutomationSettings>(
        SCOPE_TYPE,
        SCOPE_ID,
        SETTING_KEY,
        { format: 1, enabled },
        this.#now()
      );
      await this.#refreshGeneration();
      return this.snapshot();
    });
  }

  async #probe(fresh: boolean, signal?: AbortSignal): Promise<void> {
    if (this.#runtime === undefined) {
      this.#status = unavailableProbe("The local computer automation runtime is not configured on this Orchestrator node.");
      return;
    }
    this.#checking = true;
    try {
      signal?.throwIfAborted();
      this.#status = normalizeProbe(await this.#runtime.probe({ fresh, signal }));
    } catch (error) {
      this.#status = {
        ...unavailableProbe("The local computer automation runtime could not be checked."),
        support: "temporarilyUnavailable",
        failureReason: publicError(error)
      };
    } finally {
      this.#checking = false;
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work, work);
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  #record(): SettingRecord<StoredComputerAutomationSettings> {
    const record = this.#store.getSetting<unknown>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY);
    return { ...record, value: decodeSetting(record.value) };
  }

  #setting(): StoredComputerAutomationSettings {
    return this.#record().value;
  }
}

function decodeSetting(value: unknown): StoredComputerAutomationSettings {
  if (!isRecord(value) || value["format"] !== 1 || typeof value["enabled"] !== "boolean") {
    throw new Error("Stored computer automation settings are invalid.");
  }
  return { format: 1, enabled: value["enabled"] };
}

function normalizeProbe(value: ComputerAutomationProbe): ComputerAutomationProbe {
  if (!isRecord(value)) throw new Error("Computer automation status is invalid.");
  const platform = boundedPlatform(value.platform);
  const permissions = platform === "darwin"
    ? {
        accessibilityPermission: validPermission(value.accessibilityPermission),
        screenRecordingPermission: validPermission(value.screenRecordingPermission)
      }
    : {
        accessibilityPermission: "notRequired" as const,
        screenRecordingPermission: "notRequired" as const
      };
  return {
    support: validSupport(value.support),
    supportReason: boundedPublicReason(value.supportReason),
    installed: value.installed === true,
    driverVersion: boundedVersion(value.driverVersion),
    daemonRunning: value.daemonRunning === true,
    ...permissions,
    screenRecordingCapturable: value.screenRecordingCapturable === true,
    ready: value.ready === true,
    failureReason: boundedPublicReason(value.failureReason),
    platform
  };
}

function normalizeUpdateCheck(value: ComputerAutomationUpdateCheck): ComputerAutomationUpdateCheck {
  if (!isRecord(value)) throw new Error("Computer automation update status is invalid.");
  return {
    currentVersion: boundedVersion(value.currentVersion) || undefined,
    latestVersion: boundedVersion(value.latestVersion) || undefined,
    updateAvailable: value.updateAvailable === true,
    updating: value.updating === true
  };
}

function normalizeUpdateProgress(value: ComputerAutomationUpdateProgress): ComputerAutomationUpdateProgress {
  if (!isRecord(value) || (value.phase !== "downloading" && value.phase !== "installing" && value.phase !== "done")) {
    throw new Error("Computer automation update progress is invalid.");
  }
  return {
    phase: value.phase,
    downloadedBytes: boundedByteCount(value.downloadedBytes),
    totalBytes: boundedByteCount(value.totalBytes)
  };
}

function boundedByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toProtoSupport(value: ComputerAutomationProbe["support"]): CapabilitySupport {
  switch (value) {
    case "supported": return CapabilitySupport.SUPPORTED;
    case "upstreamMissing": return CapabilitySupport.UPSTREAM_MISSING;
    case "platformLimited": return CapabilitySupport.PLATFORM_LIMITED;
    case "temporarilyUnavailable": return CapabilitySupport.TEMPORARILY_UNAVAILABLE;
  }
}

function toProtoPermission(value: ComputerPermissionState): AutomationPermissionState {
  switch (value) {
    case "granted": return AutomationPermissionState.GRANTED;
    case "missing": return AutomationPermissionState.MISSING;
    case "notRequired": return AutomationPermissionState.NOT_REQUIRED;
    case "unknown": return AutomationPermissionState.UNKNOWN;
  }
}

function toProtoUpdatePhase(value: ComputerAutomationUpdateProgress["phase"] | undefined): ComputerAutomationUpdatePhase {
  switch (value) {
    case "downloading": return ComputerAutomationUpdatePhase.DOWNLOADING;
    case "installing": return ComputerAutomationUpdatePhase.INSTALLING;
    case "done": return ComputerAutomationUpdatePhase.DONE;
    case undefined: return ComputerAutomationUpdatePhase.UNSPECIFIED;
  }
}

function validSupport(value: unknown): ComputerAutomationProbe["support"] {
  if (value === "supported" || value === "upstreamMissing" || value === "platformLimited" || value === "temporarilyUnavailable") return value;
  throw new Error("Computer automation support state is invalid.");
}

function validPermission(value: unknown): ComputerPermissionState {
  if (value === "granted" || value === "missing" || value === "unknown" || value === "notRequired") return value;
  throw new Error("Computer automation permission state is invalid.");
}

function boundedVersion(value: unknown): string {
  return typeof value === "string" && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function boundedPlatform(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9._-]{1,32}$/iu.test(value) ? value : "unknown";
}

function boundedPublicReason(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 511)}…`;
}

function publicError(error: unknown): string {
  return boundedPublicReason(error instanceof Error ? error.message : "Computer automation failed.");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
