import { isAbsolute, posix, win32 } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  AndroidAdbPathSource,
  AndroidAutomationIssue,
  AndroidAutomationRuntimeState,
  AndroidAutomationSettingsSchema,
  CapabilitySupport,
  type AndroidAutomationSettings
} from "@joko/contracts";
import type { OperationalStore, SettingRecord } from "@joko/store";

import { toProtoEntityVersion } from "./proto-mapper.js";

const SETTING_KEY = "settings.automation.android";
const SCOPE_TYPE = "service" as const;
const SCOPE_ID = "orchestrator";

export type AndroidAutomationSupport =
  | "supported"
  | "upstreamMissing"
  | "platformLimited"
  | "temporarilyUnavailable";

export type AndroidAutomationAdbPathSource =
  | "custom"
  | "environment"
  | "prepared"
  | "bundled"
  | "sdk"
  | "path"
  | "fallback"
  | "unspecified";

export type AndroidAutomationIssueKind =
  | "adbNotFound"
  | "noDevice"
  | "multipleDevices"
  | "deviceUnauthorized"
  | "deviceOffline"
  | "uiDumpFailed"
  | "screenshotFailed"
  | "invalidNode"
  | "driverError"
  | "unspecified";

export interface AndroidAutomationDevice {
  readonly deviceSerial: string;
  readonly state: string;
  readonly product?: string;
  readonly model?: string;
  readonly device?: string;
  readonly transportId?: string;
  readonly usb?: string;
}

export interface AndroidAutomationProbe {
  readonly support: AndroidAutomationSupport;
  readonly supportReason?: string;
  readonly adbAvailable: boolean;
  readonly adbPath?: string;
  readonly adbPathSource: AndroidAutomationAdbPathSource;
  readonly preparationSupported: boolean;
  readonly preparationReady: boolean;
  readonly preparationError?: string;
  readonly adbVersion?: string;
  readonly devices: readonly AndroidAutomationDevice[];
  readonly defaultDeviceSerial?: string;
  readonly issue?: AndroidAutomationIssueKind;
  readonly failureReason?: string;
  readonly platform: string;
}

export interface AndroidAutomationConfiguration {
  readonly defaultDeviceSerial?: string;
  readonly adbPathOverride?: string;
}

/** Runtime boundary kept separate so configuration changes can swap ADB safely. */
export interface AndroidAutomationRuntimeController {
  applyConfiguration(configuration: AndroidAutomationConfiguration, signal?: AbortSignal): Promise<void>;
  prepare(signal?: AbortSignal): Promise<void>;
  status(options?: {
    readonly fresh?: boolean;
    readonly allowPreparation?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<AndroidAutomationProbe>;
}

export interface AndroidAutomationSettingsControllerOptions {
  readonly store: OperationalStore;
  readonly runtime?: AndroidAutomationRuntimeController;
  readonly refreshGeneration?: () => Promise<void>;
  readonly now?: () => number;
}

interface StoredAndroidAutomationSettings {
  readonly format: 1;
  readonly enabled: boolean;
  readonly defaultDeviceSerial?: string;
  readonly adbPathOverride?: string;
}

const unavailableProbe = (reason: string): AndroidAutomationProbe => ({
  support: "upstreamMissing",
  supportReason: reason,
  adbAvailable: false,
  adbPathSource: "unspecified",
  preparationSupported: false,
  preparationReady: false,
  devices: [],
  issue: "adbNotFound",
  platform: process.platform
});

/**
 * Owns the durable machine-wide switch and the bounded ADB projection.
 * Constructing this controller never probes ADB; disabled settings therefore
 * cannot start a daemon as a side effect of opening Settings.
 */
export class AndroidAutomationSettingsController {
  readonly #store: OperationalStore;
  readonly #runtime: AndroidAutomationRuntimeController | undefined;
  readonly #refreshGeneration: () => Promise<void>;
  readonly #now: () => number;
  #status: AndroidAutomationProbe;
  #activity: "idle" | "checking" | "preparing" = "idle";
  #statusObserved = false;
  #projectionGeneration = 0;
  #appliedConfiguration = "";
  #tail: Promise<void> = Promise.resolve();

  constructor(options: AndroidAutomationSettingsControllerOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#refreshGeneration = options.refreshGeneration ?? (() => Promise.resolve());
    this.#now = options.now ?? Date.now;
    const existing = this.#store.findSetting<unknown>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY);
    if (existing === undefined) {
      this.#store.setSetting<StoredAndroidAutomationSettings>(
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
      ? unavailableProbe("Android automation is not configured on this Orchestrator node.")
      : {
          ...unavailableProbe("ADB has not been checked yet."),
          support: "supported",
          preparationSupported: true
        };
  }

  enabled(): boolean {
    return this.#setting().enabled;
  }

  availableForNewSessions(): boolean {
    return this.enabled() && this.#runtime !== undefined;
  }

  configuration(): AndroidAutomationConfiguration {
    const setting = this.#setting();
    return {
      ...(setting.defaultDeviceSerial === undefined ? {} : { defaultDeviceSerial: setting.defaultDeviceSerial }),
      ...(setting.adbPathOverride === undefined ? {} : { adbPathOverride: setting.adbPathOverride })
    };
  }

  snapshot(): AndroidAutomationSettings {
    const record = this.#record();
    const status = normalizeProbe(this.#status);
    const configuredDefaultDeviceSerial = record.value.defaultDeviceSerial ?? "";
    const adbPathOverride = record.value.adbPathOverride ?? "";
    return create(AndroidAutomationSettingsSchema, {
      enabled: record.value.enabled,
      support: toProtoSupport(status.support),
      supportReason: boundedPublicText(status.supportReason),
      adbAvailable: status.adbAvailable,
      adbPath: adbPathOverride || boundedServerPath(status.adbPath),
      adbPathSource: toProtoPathSource(adbPathOverride === "" ? status.adbPathSource : "custom"),
      preparationSupported: status.preparationSupported,
      preparationReady: status.preparationReady,
      preparationError: boundedPublicText(status.preparationError),
      adbVersion: boundedVersion(status.adbVersion),
      devices: status.devices.map((device) => ({
        deviceSerial: boundedDeviceField(device.deviceSerial, 255),
        state: boundedDeviceField(device.state, 64),
        product: boundedDeviceField(device.product, 256),
        model: boundedDeviceField(device.model, 256),
        device: boundedDeviceField(device.device, 256),
        transportId: boundedDeviceField(device.transportId, 64),
        usb: boundedDeviceField(device.usb, 128)
      })),
      defaultDeviceSerial: boundedDeviceField(status.defaultDeviceSerial, 255),
      configuredDefaultDeviceSerial,
      adbPathOverride,
      issue: toProtoIssue(status.issue),
      failureReason: boundedPublicText(status.failureReason),
      platform: boundedPlatform(status.platform),
      runtimeState: !record.value.enabled
        ? AndroidAutomationRuntimeState.DISABLED
        : this.#activity === "checking"
          ? AndroidAutomationRuntimeState.CHECKING
          : this.#activity === "preparing"
            ? AndroidAutomationRuntimeState.PREPARING
            : status.adbAvailable
              ? AndroidAutomationRuntimeState.READY
              : status.support === "platformLimited" || status.support === "upstreamMissing"
                ? AndroidAutomationRuntimeState.UNAVAILABLE
                : AndroidAutomationRuntimeState.ERROR,
      statusObserved: this.#statusObserved,
      version: toProtoEntityVersion(record.revision, this.#projectionGeneration, record.updatedAt)
    });
  }

  setEnabled(enabled: boolean, signal?: AbortSignal): Promise<AndroidAutomationSettings> {
    return this.#enqueue(async () => {
      const current = this.#record();
      if (current.value.enabled !== enabled) {
        if (enabled && this.#runtime === undefined) {
          throw new Error("Android automation is unavailable on this Orchestrator node.");
        }
        this.#persist({ ...current.value, enabled });
        // The durable owner choice is visible to future Pi generations before
        // any potentially slow ADB preparation is dispatched.
        await this.#refreshGeneration();
        if (!enabled) {
          this.#status = this.#runtime === undefined
            ? unavailableProbe("Android automation is not configured on this Orchestrator node.")
            : {
                ...unavailableProbe("ADB has not been checked yet."),
                support: "supported",
                preparationSupported: true
              };
          this.#statusObserved = false;
          this.#projectionGeneration += 1;
        }
      }
      if (enabled) await this.#prepareAndProbe(signal);
      return this.snapshot();
    });
  }

  prepare(signal?: AbortSignal): Promise<AndroidAutomationSettings> {
    return this.#enqueue(async () => {
      if (!this.enabled()) return this.snapshot();
      await this.#prepareAndProbe(signal);
      return this.snapshot();
    });
  }

  probe(fresh = true, signal?: AbortSignal): Promise<AndroidAutomationSettings> {
    return this.#enqueue(async () => {
      if (!this.enabled() && !fresh) return this.snapshot();
      await this.#ensureConfigured(signal);
      await this.#probe(fresh, signal);
      return this.snapshot();
    });
  }

  selectDevice(deviceSerial?: string, signal?: AbortSignal): Promise<AndroidAutomationSettings> {
    return this.#enqueue(async () => {
      const normalized = deviceSerial === undefined ? undefined : validateDeviceSerial(deviceSerial);
      const current = this.#record();
      this.#persist({
        ...current.value,
        ...(normalized === undefined
          ? { defaultDeviceSerial: undefined }
          : { defaultDeviceSerial: normalized })
      });
      this.#appliedConfiguration = "";
      await this.#ensureConfigured(signal);
      if (this.enabled()) await this.#probe(true, signal);
      return this.snapshot();
    });
  }

  setAdbPath(serverPath?: string, signal?: AbortSignal): Promise<AndroidAutomationSettings> {
    return this.#enqueue(async () => {
      const normalized = serverPath === undefined ? undefined : validateServerPath(serverPath);
      const current = this.#record();
      this.#persist({
        ...current.value,
        ...(normalized === undefined
          ? { adbPathOverride: undefined }
          : { adbPathOverride: normalized })
      });
      this.#appliedConfiguration = "";
      this.#statusObserved = false;
      try {
        await this.#ensureConfigured(signal);
        if (this.enabled()) await this.#prepareAndProbe(signal);
      } catch (error) {
        this.#recordFailure(error);
        throw error;
      }
      return this.snapshot();
    });
  }

  async #prepareAndProbe(signal?: AbortSignal): Promise<void> {
    if (this.#runtime === undefined) {
      this.#status = unavailableProbe("Android automation is not configured on this Orchestrator node.");
      this.#statusObserved = true;
      return;
    }
    await this.#ensureConfigured(signal);
    this.#activity = "preparing";
    try {
      signal?.throwIfAborted();
      await this.#runtime.prepare(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.#recordFailure(error);
      return;
    } finally {
      this.#activity = "idle";
    }
    // Preparation has already established the authoritative ADB candidate.
    // Preserve that resolution for the immediately following device status;
    // explicit user rechecks remain fresh probes.
    await this.#probe(false, signal);
  }

  async #probe(fresh: boolean, signal?: AbortSignal): Promise<void> {
    if (this.#runtime === undefined) {
      this.#status = unavailableProbe("Android automation is not configured on this Orchestrator node.");
      this.#statusObserved = true;
      return;
    }
    this.#activity = "checking";
    try {
      signal?.throwIfAborted();
      this.#status = normalizeProbe(await this.#runtime.status({
        fresh,
        allowPreparation: this.enabled(),
        signal
      }));
      this.#statusObserved = true;
      this.#projectionGeneration += 1;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.#recordFailure(error);
    } finally {
      this.#activity = "idle";
    }
  }

  async #ensureConfigured(signal?: AbortSignal): Promise<void> {
    if (this.#runtime === undefined) return;
    const configuration = this.configuration();
    const key = configurationKey(configuration);
    if (key === this.#appliedConfiguration) return;
    signal?.throwIfAborted();
    await this.#runtime.applyConfiguration(configuration, signal);
    this.#appliedConfiguration = key;
  }

  #recordFailure(error: unknown): void {
    this.#status = {
      ...this.#status,
      support: this.#status.support === "platformLimited" ? "platformLimited" : "temporarilyUnavailable",
      adbAvailable: false,
      preparationReady: false,
      preparationError: publicError(error),
      issue: "driverError",
      failureReason: publicError(error)
    };
    this.#statusObserved = true;
    this.#projectionGeneration += 1;
  }

  #persist(value: StoredAndroidAutomationSettings): void {
    this.#store.setSetting<StoredAndroidAutomationSettings>(
      SCOPE_TYPE,
      SCOPE_ID,
      SETTING_KEY,
      compactSetting(value),
      this.#now()
    );
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work, work);
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  #record(): SettingRecord<StoredAndroidAutomationSettings> {
    const record = this.#store.getSetting<unknown>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY);
    return { ...record, value: decodeSetting(record.value) };
  }

  #setting(): StoredAndroidAutomationSettings {
    return this.#record().value;
  }
}

function compactSetting(value: StoredAndroidAutomationSettings): StoredAndroidAutomationSettings {
  return {
    format: 1,
    enabled: value.enabled,
    ...(value.defaultDeviceSerial === undefined ? {} : { defaultDeviceSerial: value.defaultDeviceSerial }),
    ...(value.adbPathOverride === undefined ? {} : { adbPathOverride: value.adbPathOverride })
  };
}

function decodeSetting(value: unknown): StoredAndroidAutomationSettings {
  if (!isRecord(value) || value["format"] !== 1 || typeof value["enabled"] !== "boolean") {
    throw new Error("Stored Android automation settings are invalid.");
  }
  const defaultDeviceSerial = value["defaultDeviceSerial"] === undefined
    ? undefined
    : validateDeviceSerial(value["defaultDeviceSerial"]);
  const adbPathOverride = value["adbPathOverride"] === undefined
    ? undefined
    : validateServerPath(value["adbPathOverride"]);
  return compactSetting({ format: 1, enabled: value["enabled"], defaultDeviceSerial, adbPathOverride });
}

function normalizeProbe(value: AndroidAutomationProbe): AndroidAutomationProbe {
  if (!isRecord(value)) throw new Error("Android automation status is invalid.");
  return {
    support: validSupport(value.support),
    supportReason: boundedPublicText(value.supportReason),
    adbAvailable: value.adbAvailable === true,
    adbPath: boundedServerPath(value.adbPath),
    adbPathSource: validPathSource(value.adbPathSource),
    preparationSupported: value.preparationSupported === true,
    preparationReady: value.preparationReady === true,
    preparationError: boundedPublicText(value.preparationError),
    adbVersion: boundedVersion(value.adbVersion),
    devices: Array.isArray(value.devices) ? value.devices.map(normalizeDevice) : [],
    defaultDeviceSerial: value.defaultDeviceSerial === undefined || value.defaultDeviceSerial === ""
      ? undefined
      : validateDeviceSerial(value.defaultDeviceSerial),
    issue: validIssue(value.issue),
    failureReason: boundedPublicText(value.failureReason),
    platform: boundedPlatform(value.platform)
  };
}

function normalizeDevice(value: AndroidAutomationDevice): AndroidAutomationDevice {
  if (!isRecord(value)) throw new Error("Android device status is invalid.");
  return {
    deviceSerial: validateDeviceSerial(value.deviceSerial),
    state: boundedDeviceField(value.state, 64),
    product: boundedDeviceField(value.product, 256),
    model: boundedDeviceField(value.model, 256),
    device: boundedDeviceField(value.device, 256),
    transportId: boundedDeviceField(value.transportId, 64),
    usb: boundedDeviceField(value.usb, 128)
  };
}

function toProtoSupport(value: AndroidAutomationSupport): CapabilitySupport {
  switch (value) {
    case "supported": return CapabilitySupport.SUPPORTED;
    case "upstreamMissing": return CapabilitySupport.UPSTREAM_MISSING;
    case "platformLimited": return CapabilitySupport.PLATFORM_LIMITED;
    case "temporarilyUnavailable": return CapabilitySupport.TEMPORARILY_UNAVAILABLE;
  }
}

function toProtoPathSource(value: AndroidAutomationAdbPathSource): AndroidAdbPathSource {
  switch (value) {
    case "custom": return AndroidAdbPathSource.CUSTOM;
    case "environment": return AndroidAdbPathSource.ENVIRONMENT;
    case "prepared": return AndroidAdbPathSource.PREPARED;
    case "bundled": return AndroidAdbPathSource.BUNDLED;
    case "sdk": return AndroidAdbPathSource.SDK;
    case "path": return AndroidAdbPathSource.PATH;
    case "fallback": return AndroidAdbPathSource.FALLBACK;
    case "unspecified": return AndroidAdbPathSource.UNSPECIFIED;
  }
}

function toProtoIssue(value: AndroidAutomationIssueKind | undefined): AndroidAutomationIssue {
  switch (value) {
    case "adbNotFound": return AndroidAutomationIssue.ADB_NOT_FOUND;
    case "noDevice": return AndroidAutomationIssue.NO_DEVICE;
    case "multipleDevices": return AndroidAutomationIssue.MULTIPLE_DEVICES;
    case "deviceUnauthorized": return AndroidAutomationIssue.DEVICE_UNAUTHORIZED;
    case "deviceOffline": return AndroidAutomationIssue.DEVICE_OFFLINE;
    case "uiDumpFailed": return AndroidAutomationIssue.UI_DUMP_FAILED;
    case "screenshotFailed": return AndroidAutomationIssue.SCREENSHOT_FAILED;
    case "invalidNode": return AndroidAutomationIssue.INVALID_NODE;
    case "driverError": return AndroidAutomationIssue.DRIVER_ERROR;
    case "unspecified":
    case undefined: return AndroidAutomationIssue.UNSPECIFIED;
  }
}

function validSupport(value: unknown): AndroidAutomationSupport {
  if (value === "supported" || value === "upstreamMissing" || value === "platformLimited" || value === "temporarilyUnavailable") return value;
  throw new Error("Android automation support state is invalid.");
}

function validPathSource(value: unknown): AndroidAutomationAdbPathSource {
  if (value === "custom" || value === "environment" || value === "prepared" || value === "bundled" || value === "sdk" || value === "path" || value === "fallback" || value === "unspecified") return value;
  throw new Error("Android ADB path source is invalid.");
}

function validIssue(value: unknown): AndroidAutomationIssueKind {
  if (value === undefined || value === "unspecified") return "unspecified";
  if (value === "adbNotFound" || value === "noDevice" || value === "multipleDevices" || value === "deviceUnauthorized" || value === "deviceOffline" || value === "uiDumpFailed" || value === "screenshotFailed" || value === "invalidNode" || value === "driverError") return value;
  throw new Error("Android automation issue is invalid.");
}

function validateDeviceSerial(value: unknown): string {
  if (typeof value !== "string") throw new Error("Android device serial is invalid.");
  const serial = value.trim();
  if (serial === "" || serial.length > 255 || serial.startsWith("-") || !/^[A-Za-z0-9[\]._:%-]+$/u.test(serial)) {
    throw new Error("Android device serial is invalid.");
  }
  return serial;
}

function validateServerPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("ADB path is invalid.");
  const path = value.trim();
  if (
    path === ""
    || path.length > 32_768
    || /[\u0000-\u001f\u007f]/u.test(path)
    || (!isAbsolute(path) && !win32.isAbsolute(path) && !posix.isAbsolute(path))
  ) {
    throw new Error("ADB path must be an absolute service-node path.");
  }
  return path;
}

function boundedServerPath(value: unknown): string {
  return typeof value === "string" && value.length <= 32_768 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function boundedVersion(value: unknown): string {
  return typeof value === "string" && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function boundedPlatform(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9._-]{1,32}$/iu.test(value) ? value : "unknown";
}

function boundedDeviceField(value: unknown, maximumLength: number): string {
  return typeof value === "string" && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function boundedPublicText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 511)}…`;
}

function publicError(error: unknown): string {
  return boundedPublicText(error instanceof Error ? error.message : "Android automation failed.");
}

function configurationKey(value: AndroidAutomationConfiguration): string {
  return JSON.stringify([value.defaultDeviceSerial ?? null, value.adbPathOverride ?? null]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
