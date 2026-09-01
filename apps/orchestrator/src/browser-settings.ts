import { create } from "@bufbuild/protobuf";
import {
  BrowserAutomationTarget,
  BrowserBackendFailureReason,
  BrowserBackendHealthSchema,
  BrowserBackendStatus,
  BrowserSettingsSchema,
  BrowserTargetSettingsSchema,
  CapabilitySupport,
  type BrowserSettings,
  type BrowserSettingsPatch,
  type BrowserTargetSettings
} from "@joko/contracts";
import type { OperationalStore, SettingRecord, StoredTarget } from "@joko/store";

import { fromProtoDuration, toProtoDuration, toProtoEntityVersion } from "./proto-mapper.js";

const SERVICE_SCOPE_TYPE = "service" as const;
const TARGET_SCOPE_TYPE = "target" as const;
const DEFAULT_SCOPE_ID = "orchestrator";
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PROFILE_NAME_CODE_POINTS = 128;

export const MIN_BROWSER_TAKEOVER_TIMEOUT_MS = 1_000;
export const MAX_BROWSER_TAKEOVER_TIMEOUT_MS = 24 * 60 * 60_000;

export interface BrowserRuntimeSettings {
  readonly browserProviderId: string;
  /** Product default used only when a Target has no explicit activation row. */
  readonly enabled: boolean;
  readonly profileDisplayName: string;
  readonly takeoverTimeoutMs: number;
  readonly allowUploads: boolean;
  readonly allowDownloads: boolean;
  readonly automationTarget: "sidebar" | "external";
}

export interface BrowserSettingsTransition {
  readonly targetId?: string;
  readonly previous: BrowserRuntimeSettings;
  readonly next: BrowserRuntimeSettings;
}

export interface BrowserSettingsHooks {
  /** Ensure the Provider is available, then publish a new Target-scoped runtime policy. */
  start(transition: BrowserSettingsTransition): void | Promise<void>;
  /** Publish a disabled policy without stopping grants held by live Sessions. */
  stop(transition: BrowserSettingsTransition): void | Promise<void>;
  /** Reconfigure service-level Browser placement. */
  refresh(transition: BrowserSettingsTransition): void | Promise<void>;
}

export interface BrowserSettingsControllerOptions {
  readonly store: OperationalStore;
  readonly defaults: BrowserRuntimeSettings;
  readonly hooks: BrowserSettingsHooks;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly detectedBrowser?: string;
}

export interface BrowserBackendHealthState {
  readonly active: boolean;
  readonly status: "ready" | "recovering" | "disconnected" | "unavailable" | "error";
  readonly canRecover: boolean;
  readonly reason?: "disposing" | "hostUnavailable" | "startFailed" | "statusFailed" | "recoveryFailed";
}

interface StoredBrowserServiceSettings {
  readonly format: 1;
  readonly browserProviderId: string;
  readonly profileDisplayName: string;
  readonly takeoverTimeoutMs: number;
  readonly allowUploads: boolean;
  readonly allowDownloads: boolean;
  readonly automationTarget: "sidebar" | "external";
}

interface StoredBrowserTargetSettings {
  readonly format: 1;
  readonly browserProviderId: string;
  readonly enabled: boolean;
}

export type BrowserSettingsEffect = "start" | "stop" | "refresh";

export class BrowserSettingsValidationError extends Error {
  readonly code = "BROWSER_SETTINGS_INVALID";

  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "BrowserSettingsValidationError";
  }
}

export class BrowserSettingsEffectError extends Error {
  readonly code = "BROWSER_SETTINGS_EFFECT_FAILED";

  constructor(readonly effect: BrowserSettingsEffect, options: ErrorOptions) {
    super(`Browser ${effect} failed; settings were not changed.`, options);
    this.name = "BrowserSettingsEffectError";
  }
}

/**
 * Owns service Browser configuration and project-scoped activation separately.
 * A Target toggle publishes a new Pi generation before the target row commits;
 * existing runtimes retain their immutable bridge grant and keep working.
 */
export class BrowserSettingsController {
  readonly #store: OperationalStore;
  readonly #hooks: BrowserSettingsHooks;
  readonly #scopeId: string;
  readonly #serviceSettingKey: string;
  readonly #targetSettingKey: string;
  readonly #providerId: string;
  readonly #defaultEnabled: boolean;
  readonly #now: () => number;
  readonly #detectedBrowser: string;
  #backendHealth: BrowserBackendHealthState = { active: false, status: "disconnected", canRecover: true };
  #tail: Promise<void> = Promise.resolve();

  constructor(options: BrowserSettingsControllerOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
    this.#scopeId = nonBlankScopeId(options.scopeId ?? DEFAULT_SCOPE_ID);
    this.#now = options.now ?? Date.now;
    this.#detectedBrowser = options.detectedBrowser?.trim() ?? "";
    const defaults = validateRuntimeSettings(options.defaults);
    this.#providerId = defaults.browserProviderId;
    this.#defaultEnabled = defaults.enabled;
    this.#serviceSettingKey = `settings.browser.${this.#providerId}`;
    this.#targetSettingKey = `${this.#serviceSettingKey}.enabled`;

    const stored = this.#store.findSetting<unknown>(SERVICE_SCOPE_TYPE, this.#scopeId, this.#serviceSettingKey);
    if (stored === undefined) {
      this.#store.setSetting(SERVICE_SCOPE_TYPE, this.#scopeId, this.#serviceSettingKey, encodeServiceSettings(defaults), this.#now());
    } else {
      decodeServiceSettings(stored.value, this.#providerId);
    }

    for (const target of this.#store.listTargets()) {
      const activation = this.#store.findSetting<unknown>(TARGET_SCOPE_TYPE, target.descriptor.id, this.#targetSettingKey);
      if (activation !== undefined) decodeTargetSettings(activation.value, this.#providerId);
    }
  }

  snapshot(): BrowserSettings {
    const service = this.#serviceRecord();
    const value = decodeServiceSettings(service.value, this.#providerId);
    return create(BrowserSettingsSchema, {
      browserProviderId: value.browserProviderId,
      profileDisplayName: value.profileDisplayName,
      takeoverTimeout: toProtoDuration(value.takeoverTimeoutMs),
      allowUploads: value.allowUploads,
      allowDownloads: value.allowDownloads,
      automationTarget: toProtoAutomationTarget(value.automationTarget),
      support: CapabilitySupport.SUPPORTED,
      supportReason: "",
      detectedBrowser: this.#detectedBrowser,
      targetSettings: this.#store.listTargets().map((target) => this.#targetSnapshot(target)),
      backendHealth: create(BrowserBackendHealthSchema, {
        active: this.#backendHealth.active,
        status: toProtoBackendStatus(this.#backendHealth.status),
        canRecover: this.#backendHealth.canRecover,
        reason: toProtoBackendFailureReason(this.#backendHealth.reason)
      }),
      version: toProtoEntityVersion(service.revision, 0, service.updatedAt)
    });
  }

  apply(patch: BrowserSettingsPatch): Promise<BrowserSettings> {
    const task = this.#tail.then(() => this.#apply(patch));
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  enabled(targetId: string): boolean {
    return this.#targetValue(this.#requireTarget(targetId)).enabled;
  }

  anyTargetEnabled(): boolean {
    return this.#store.listTargets().some((target) => this.#targetValue(target).enabled);
  }

  backendHealth(): BrowserBackendHealthState { return { ...this.#backendHealth }; }

  setBackendHealth(health: BrowserBackendHealthState): void {
    this.#backendHealth = validateBackendHealth(health);
  }

  profileDisplayName(): string { return this.#serviceSettings().profileDisplayName; }
  automationTarget(): BrowserRuntimeSettings["automationTarget"] { return this.#serviceSettings().automationTarget; }
  takeoverTimeout(): number { return this.#serviceSettings().takeoverTimeoutMs; }
  uploadAllowed(): boolean { return this.#serviceSettings().allowUploads; }
  downloadAllowed(): boolean { return this.#serviceSettings().allowDownloads; }

  async #apply(patch: BrowserSettingsPatch): Promise<BrowserSettings> {
    if (patch === null || typeof patch !== "object") throw new BrowserSettingsValidationError("patch", "Browser settings patch is required.");
    const providerId = validateProviderId(patch.browserProviderId, "patch.browser_provider_id");
    if (providerId !== this.#providerId) {
      throw new BrowserSettingsValidationError("patch.browser_provider_id", "Browser settings target a different Provider.");
    }

    const serviceRecord = this.#serviceRecord();
    const previousService = decodeServiceSettings(serviceRecord.value, this.#providerId);
    const nextService = validateServiceSettings({
      ...previousService,
      ...(patch.profileDisplayName === undefined ? {} : { profileDisplayName: validateProfileDisplayName(patch.profileDisplayName, "patch.profile_display_name") }),
      ...(patch.takeoverTimeout === undefined ? {} : { takeoverTimeoutMs: validateTakeoverTimeout(patch.takeoverTimeout) }),
      ...(patch.allowUploads === undefined ? {} : { allowUploads: strictBoolean(patch.allowUploads, "patch.allow_uploads") }),
      ...(patch.allowDownloads === undefined ? {} : { allowDownloads: strictBoolean(patch.allowDownloads, "patch.allow_downloads") }),
      ...(patch.automationTarget === undefined ? {} : { automationTarget: fromProtoAutomationTarget(patch.automationTarget, "patch.automation_target") })
    });
    const target = patch.enabled === undefined ? undefined : this.#requireTarget(patch.targetId);
    const previousEnabled = target === undefined ? this.#defaultEnabled : this.#targetValue(target).enabled;
    const nextEnabled = patch.enabled === undefined ? previousEnabled : strictBoolean(patch.enabled, "patch.enabled");
    const serviceChanged = !sameServiceSettings(previousService, nextService);
    const targetChanged = target !== undefined && previousEnabled !== nextEnabled;
    if (!serviceChanged && !targetChanged) return this.snapshot();

    const previous = runtimeSettings(previousService, previousEnabled);
    const next = runtimeSettings(nextService, nextEnabled);
    const transition: BrowserSettingsTransition = { ...(target === undefined ? {} : { targetId: target.descriptor.id }), previous, next };
    const effect = lifecycleEffect(previous, next, targetChanged);
    if (effect !== undefined) {
      try { await this.#hooks[effect](transition); }
      catch (error) { throw new BrowserSettingsEffectError(effect, { cause: error }); }
    }

    const at = this.#now();
    this.#store.transaction((store) => {
      if (serviceChanged) store.setSetting(SERVICE_SCOPE_TYPE, this.#scopeId, this.#serviceSettingKey, encodeServiceSettings(nextService), at);
      if (targetChanged && target !== undefined) {
        store.setSetting<StoredBrowserTargetSettings>(TARGET_SCOPE_TYPE, target.descriptor.id, this.#targetSettingKey, {
          format: 1,
          browserProviderId: this.#providerId,
          enabled: nextEnabled
        }, at);
      }
    });
    return this.snapshot();
  }

  #serviceRecord(): SettingRecord<StoredBrowserServiceSettings> {
    const record = this.#store.getSetting<unknown>(SERVICE_SCOPE_TYPE, this.#scopeId, this.#serviceSettingKey);
    const value = decodeServiceSettings(record.value, this.#providerId);
    return { ...record, value: encodeServiceSettings(value) };
  }

  #serviceSettings(): StoredBrowserServiceSettings { return decodeServiceSettings(this.#serviceRecord().value, this.#providerId); }

  #targetValue(target: StoredTarget): StoredBrowserTargetSettings {
    const record = this.#store.findSetting<unknown>(TARGET_SCOPE_TYPE, target.descriptor.id, this.#targetSettingKey);
    return record === undefined
      ? { format: 1, browserProviderId: this.#providerId, enabled: this.#defaultEnabled }
      : decodeTargetSettings(record.value, this.#providerId);
  }

  #targetSnapshot(target: StoredTarget): BrowserTargetSettings {
    const record = this.#store.findSetting<unknown>(TARGET_SCOPE_TYPE, target.descriptor.id, this.#targetSettingKey);
    const value = record === undefined
      ? { format: 1 as const, browserProviderId: this.#providerId, enabled: this.#defaultEnabled }
      : decodeTargetSettings(record.value, this.#providerId);
    return create(BrowserTargetSettingsSchema, {
      targetId: target.descriptor.id,
      enabled: value.enabled,
      version: record === undefined
        ? toProtoEntityVersion(target.revision, 0, target.updatedAt)
        : toProtoEntityVersion(record.revision, 0, record.updatedAt)
    });
  }

  #requireTarget(value: string): StoredTarget {
    const targetId = nonBlankTargetId(value);
    try { return this.#store.getTarget(targetId); }
    catch { throw new BrowserSettingsValidationError("patch.target_id", "Browser settings Target was not found."); }
  }
}

function lifecycleEffect(previous: BrowserRuntimeSettings, next: BrowserRuntimeSettings, targetChanged: boolean): BrowserSettingsEffect | undefined {
  if (previous.automationTarget !== next.automationTarget) return "refresh";
  if (!targetChanged) return undefined;
  if (!previous.enabled && next.enabled) return "start";
  if (previous.enabled && !next.enabled) return "stop";
  return undefined;
}

function encodeServiceSettings(value: Omit<BrowserRuntimeSettings, "enabled">): StoredBrowserServiceSettings {
  return {
    format: 1,
    browserProviderId: value.browserProviderId,
    profileDisplayName: value.profileDisplayName,
    takeoverTimeoutMs: value.takeoverTimeoutMs,
    allowUploads: value.allowUploads,
    allowDownloads: value.allowDownloads,
    automationTarget: value.automationTarget
  };
}

function decodeServiceSettings(value: unknown, expectedProviderId: string): StoredBrowserServiceSettings {
  if (!isRecord(value) || value["format"] !== 1) throw new BrowserSettingsValidationError("stored.format", "Stored Browser service settings have an unsupported format.");
  const settings = validateServiceSettings({
    browserProviderId: value["browserProviderId"], profileDisplayName: value["profileDisplayName"], takeoverTimeoutMs: value["takeoverTimeoutMs"],
    allowUploads: value["allowUploads"], allowDownloads: value["allowDownloads"], automationTarget: value["automationTarget"]
  });
  if (settings.browserProviderId !== expectedProviderId) throw new BrowserSettingsValidationError("stored.browser_provider_id", "Stored Browser settings belong to a different Provider.");
  return { format: 1, ...settings };
}

function decodeTargetSettings(value: unknown, expectedProviderId: string): StoredBrowserTargetSettings {
  if (!isRecord(value) || value["format"] !== 1) throw new BrowserSettingsValidationError("stored.target.format", "Stored Browser Target settings have an unsupported format.");
  const providerId = validateProviderId(value["browserProviderId"], "stored.target.browser_provider_id");
  if (providerId !== expectedProviderId) throw new BrowserSettingsValidationError("stored.target.browser_provider_id", "Stored Browser Target settings belong to a different Provider.");
  return { format: 1, browserProviderId: providerId, enabled: strictBoolean(value["enabled"], "stored.target.enabled") };
}

function validateRuntimeSettings(value: {
  readonly browserProviderId: unknown; readonly enabled: unknown; readonly profileDisplayName: unknown; readonly takeoverTimeoutMs: unknown;
  readonly allowUploads: unknown; readonly allowDownloads: unknown; readonly automationTarget: unknown;
}): BrowserRuntimeSettings {
  return { ...validateServiceSettings(value), enabled: strictBoolean(value.enabled, "enabled") };
}

function validateServiceSettings(value: {
  readonly browserProviderId: unknown; readonly profileDisplayName: unknown; readonly takeoverTimeoutMs: unknown;
  readonly allowUploads: unknown; readonly allowDownloads: unknown; readonly automationTarget: unknown;
}): Omit<BrowserRuntimeSettings, "enabled"> {
  return {
    browserProviderId: validateProviderId(value.browserProviderId, "browser_provider_id"),
    profileDisplayName: validateProfileDisplayName(value.profileDisplayName, "profile_display_name"),
    takeoverTimeoutMs: validateTakeoverTimeoutMilliseconds(value.takeoverTimeoutMs),
    allowUploads: strictBoolean(value.allowUploads, "allow_uploads"),
    allowDownloads: strictBoolean(value.allowDownloads, "allow_downloads"),
    automationTarget: validateAutomationTarget(value.automationTarget, "automation_target")
  };
}

function runtimeSettings(value: Omit<BrowserRuntimeSettings, "enabled">, enabled: boolean): BrowserRuntimeSettings { return { ...value, enabled }; }

function validateProviderId(value: unknown, field: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) throw new BrowserSettingsValidationError(field, "Browser Provider ID is invalid.");
  return value;
}

function validateProfileDisplayName(value: unknown, field: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || [...value].length > MAX_PROFILE_NAME_CODE_POINTS || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BrowserSettingsValidationError(field, "Browser profile display name is invalid.");
  }
  return value;
}

function validateTakeoverTimeout(value: BrowserSettingsPatch["takeoverTimeout"]): number {
  try { return validateTakeoverTimeoutMilliseconds(fromProtoDuration(value, "patch.takeover_timeout")); }
  catch (error) {
    if (error instanceof BrowserSettingsValidationError) throw error;
    throw new BrowserSettingsValidationError("patch.takeover_timeout", "Browser takeover timeout must be millisecond-aligned and between 1 second and 24 hours.");
  }
}

function validateTakeoverTimeoutMilliseconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < MIN_BROWSER_TAKEOVER_TIMEOUT_MS || (value as number) > MAX_BROWSER_TAKEOVER_TIMEOUT_MS) {
    throw new BrowserSettingsValidationError("takeover_timeout", "Browser takeover timeout must be an integer between 1 second and 24 hours.");
  }
  return value as number;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new BrowserSettingsValidationError(field, `${field} must be boolean.`);
  return value;
}

function validateAutomationTarget(value: unknown, field: string): BrowserRuntimeSettings["automationTarget"] {
  if (value !== "sidebar" && value !== "external") throw new BrowserSettingsValidationError(field, "Browser automation target is invalid.");
  return value;
}

function fromProtoAutomationTarget(value: BrowserAutomationTarget, field: string): BrowserRuntimeSettings["automationTarget"] {
  switch (value) {
    case BrowserAutomationTarget.SIDEBAR: return "sidebar";
    case BrowserAutomationTarget.EXTERNAL: return "external";
    case BrowserAutomationTarget.UNSPECIFIED:
    default: throw new BrowserSettingsValidationError(field, "Browser automation target is required.");
  }
}

function toProtoAutomationTarget(value: BrowserRuntimeSettings["automationTarget"]): BrowserAutomationTarget {
  return value === "sidebar" ? BrowserAutomationTarget.SIDEBAR : BrowserAutomationTarget.EXTERNAL;
}

function nonBlankScopeId(value: string): string {
  if (value !== value.trim() || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) throw new BrowserSettingsValidationError("scope_id", "Browser settings scope ID is invalid.");
  return value;
}

function nonBlankTargetId(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BrowserSettingsValidationError("patch.target_id", "Browser settings Target ID is invalid.");
  }
  return value;
}

function sameServiceSettings(left: Omit<BrowserRuntimeSettings, "enabled">, right: Omit<BrowserRuntimeSettings, "enabled">): boolean {
  return left.browserProviderId === right.browserProviderId && left.profileDisplayName === right.profileDisplayName
    && left.takeoverTimeoutMs === right.takeoverTimeoutMs && left.allowUploads === right.allowUploads
    && left.allowDownloads === right.allowDownloads && left.automationTarget === right.automationTarget;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBackendHealth(value: BrowserBackendHealthState): BrowserBackendHealthState {
  if (typeof value.active !== "boolean" || typeof value.canRecover !== "boolean"
    || !["ready", "recovering", "disconnected", "unavailable", "error"].includes(value.status)
    || (value.reason !== undefined && !["disposing", "hostUnavailable", "startFailed", "statusFailed", "recoveryFailed"].includes(value.reason))) {
    throw new BrowserSettingsValidationError("backend_health", "Browser Backend health is invalid.");
  }
  return { ...value };
}

function toProtoBackendStatus(value: BrowserBackendHealthState["status"]): BrowserBackendStatus {
  switch (value) {
    case "ready": return BrowserBackendStatus.READY;
    case "recovering": return BrowserBackendStatus.RECOVERING;
    case "disconnected": return BrowserBackendStatus.DISCONNECTED;
    case "unavailable": return BrowserBackendStatus.UNAVAILABLE;
    case "error": return BrowserBackendStatus.ERROR;
  }
}

function toProtoBackendFailureReason(value: BrowserBackendHealthState["reason"]): BrowserBackendFailureReason {
  switch (value) {
    case "disposing": return BrowserBackendFailureReason.DISPOSING;
    case "hostUnavailable": return BrowserBackendFailureReason.HOST_UNAVAILABLE;
    case "startFailed": return BrowserBackendFailureReason.START_FAILED;
    case "statusFailed": return BrowserBackendFailureReason.STATUS_FAILED;
    case "recoveryFailed": return BrowserBackendFailureReason.RECOVERY_FAILED;
    case undefined: return BrowserBackendFailureReason.UNSPECIFIED;
  }
}
