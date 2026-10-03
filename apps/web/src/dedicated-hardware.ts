export const DEDICATED_HARDWARE_MODELS = ["codex-micro", "creator-micro-2"] as const;
export type DedicatedHardwareModel = (typeof DEDICATED_HARDWARE_MODELS)[number];

export const DEDICATED_HARDWARE_PHYSICAL_KEYS = [
  "AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
  "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"
] as const;
export type DedicatedHardwarePhysicalKey = (typeof DEDICATED_HARDWARE_PHYSICAL_KEYS)[number];

export const DEDICATED_HARDWARE_TASK_KEYS = ["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"] as const;
export const DEDICATED_HARDWARE_DIRECTIONS = ["up", "right", "down", "left"] as const;
export const DEDICATED_HARDWARE_ENCODER_INPUTS = ["left", "right", "click", "longPress"] as const;
export const DEDICATED_HARDWARE_AUTO_DIM_OPTIONS = [
  "off", "30-seconds", "1-minute", "3-minutes", "10-minutes", "30-minutes", "1-hour"
] as const;
export const DEDICATED_HARDWARE_TASK_SOURCES = ["sidebar", "last-sent", "priority", "custom"] as const;
export const DEDICATED_HARDWARE_ENCODER_MODES = [
  "session-switch", "composer-navigation", "reasoning", "conversation-scroll", "custom"
] as const;
export const DEDICATED_HARDWARE_SETTINGS_MAX_BYTES = 64 * 1024;
export const DEDICATED_HARDWARE_KEYCAP_IDS = [
  "fast", "approve", "reject", "fork", "microphone", "microphone-alt", "submit", "feedback", "terminal",
  "copy-conversation", "archive", "new-task", "browser", "pin", "review", "add-photos", "settings", "tasks",
  "effort-up", "effort-down", "folder", "add-files", "skills", "plan", "navigate-forward", "sidebar", "inspector",
  "navigate-back", "fullscreen", "composer", "scroll-up", "scroll-down", "scroll-bottom",
  "empty-1", "empty-2", "empty-3", "empty-4", "empty-5"
] as const;

export type DedicatedHardwareDirection = (typeof DEDICATED_HARDWARE_DIRECTIONS)[number];
export type DedicatedHardwareEncoderInput = (typeof DEDICATED_HARDWARE_ENCODER_INPUTS)[number];
export type DedicatedHardwareAutoDim = (typeof DEDICATED_HARDWARE_AUTO_DIM_OPTIONS)[number];
export type DedicatedHardwareTaskSource = (typeof DEDICATED_HARDWARE_TASK_SOURCES)[number];
export type DedicatedHardwareEncoderMode = (typeof DEDICATED_HARDWARE_ENCODER_MODES)[number];
export type DedicatedHardwareKeycapId = (typeof DEDICATED_HARDWARE_KEYCAP_IDS)[number];
export const DEDICATED_HARDWARE_COMMANDS = [
  "activate", "back", "navigate-back", "navigate-forward", "new-task", "toggle-sidebar", "focus-composer",
  "previous-task", "next-task", "previous-panel", "next-panel", "scroll-up", "scroll-down", "approve", "reject",
  "submit", "stop", "toggle-plan", "toggle-fast", "effort-increase", "effort-decrease", "toggle-pin", "archive-task",
  "fork-task", "copy-task-link", "copy-conversation-markdown", "add-photos", "add-files", "open-commands",
  "open-settings", "open-skills", "open-schedules", "open-folder", "toggle-inspector", "toggle-fullscreen",
  "open-terminal", "open-browser-tab", "toggle-review-tab", "scroll-bottom", "feedback"
] as const;
export type DedicatedHardwareCommand = (typeof DEDICATED_HARDWARE_COMMANDS)[number];

export type DedicatedHardwareBinding =
  | { readonly kind: "none" }
  | { readonly kind: "command"; readonly command: DedicatedHardwareCommand }
  | { readonly kind: "voice" }
  | { readonly kind: "skill"; readonly serverId: string; readonly resourceId: string; readonly name: string }
  | { readonly kind: "composer-text"; readonly text: string }
  | { readonly kind: "fixed-link"; readonly linkId: "product-feedback" | "documentation" };

export interface DedicatedHardwareKeySetting {
  readonly keycapId: DedicatedHardwareKeycapId;
  readonly binding: DedicatedHardwareBinding;
}

export interface DedicatedHardwareMerge {
  readonly origin: DedicatedHardwarePhysicalKey;
  readonly cover: DedicatedHardwarePhysicalKey;
}

export interface DedicatedHardwareLayout {
  readonly version: 1;
  readonly keys: Readonly<Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeySetting>>;
  readonly stick: Readonly<Record<DedicatedHardwareDirection, DedicatedHardwareBinding>>;
  readonly encoder: Readonly<Record<DedicatedHardwareEncoderInput, DedicatedHardwareBinding>>;
  readonly encoderMode: DedicatedHardwareEncoderMode;
  readonly merges: readonly DedicatedHardwareMerge[];
  readonly taskKeys: readonly DedicatedHardwarePhysicalKey[];
}

export interface DedicatedHardwareSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly lighting: {
    readonly brightnessPercent: number;
    readonly autoDim: DedicatedHardwareAutoDim;
  };
  readonly taskSource: DedicatedHardwareTaskSource;
  readonly singleTapTaskKeys: boolean;
  readonly customTaskSlots: readonly [
    DedicatedHardwareBinding, DedicatedHardwareBinding, DedicatedHardwareBinding,
    DedicatedHardwareBinding, DedicatedHardwareBinding, DedicatedHardwareBinding
  ];
  readonly layout: DedicatedHardwareLayout;
}

export type DedicatedHardwareConnectionStatus =
  | "connecting" | "connected" | "not-detected" | "disabled" | "error" | "unavailable";
export type DedicatedHardwareConnectionReason =
  | "sdk-unavailable" | "permission-required" | "device-in-use" | "connection-timeout"
  | "host-crash" | "device-disconnected" | null;
export type DedicatedHardwareTransport = "usb" | "bluetooth" | null;
export type DedicatedHardwareInputPermission = "granted" | "denied" | "unknown" | "not-required";
export type DedicatedHardwareKeymapFailure =
  | "read" | "backup" | "transform" | "apply" | "rollback" | "restore" | "backup-cleanup" | "recovery-required";
export type DedicatedHardwareKeymapState =
  | { readonly phase: "unavailable"; readonly backupAvailable: null; readonly failure: null }
  | {
    readonly phase: "idle" | "applying" | "occupied" | "restoring" | "error";
    readonly backupAvailable: boolean;
    readonly failure: DedicatedHardwareKeymapFailure | null;
  };

export interface DedicatedHardwareTaskSlotState {
  readonly slot: number;
  readonly sessionId: string | null;
  readonly title: string | null;
}

export interface DedicatedHardwareModelState {
  readonly model: DedicatedHardwareModel;
  readonly status: DedicatedHardwareConnectionStatus;
  readonly reason: DedicatedHardwareConnectionReason;
  readonly devicePresent: boolean | null;
  readonly transport: DedicatedHardwareTransport;
  readonly firmwareVersion: string | null;
  readonly batteryPercent: number | null;
  readonly charging: boolean | null;
  readonly inputPermission: DedicatedHardwareInputPermission;
  readonly keymap: DedicatedHardwareKeymapState | null;
  readonly settingsError: "invalid" | "unavailable" | null;
  readonly settings: DedicatedHardwareSettings;
  readonly taskSlots: readonly DedicatedHardwareTaskSlotState[];
}

export interface DedicatedHardwareSnapshot {
  readonly version: 1;
  readonly models: Readonly<Record<DedicatedHardwareModel, DedicatedHardwareModelState>>;
}

export type DedicatedHardwarePreviewInput =
  | { readonly version: 1; readonly model: DedicatedHardwareModel; readonly kind: "key"; readonly key: DedicatedHardwarePhysicalKey; readonly pressed: boolean }
  | { readonly version: 1; readonly model: DedicatedHardwareModel; readonly kind: "stick"; readonly x: number; readonly y: number; readonly pressed: boolean }
  | { readonly version: 1; readonly model: DedicatedHardwareModel; readonly kind: "encoder"; readonly delta: -1 | 0 | 1; readonly pressed: boolean };

export interface DedicatedHardwareSkillOption {
  readonly serverId: string;
  readonly resourceId: string;
  readonly name: string;
}

export interface DedicatedHardwareTaskActivity {
  readonly phase: "running" | "needs-interaction" | "completed" | "error" | null;
  readonly attention: boolean;
}

export interface DedicatedHardwarePublishedTask {
  readonly sessionId: string;
  readonly sessionGeneration: string;
  readonly targetId: string;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly userSendAt: number | null;
  readonly sidebarOrder: number | null;
  readonly catalogEligible: boolean;
  readonly priorityRank: number | null;
  readonly activity: DedicatedHardwareTaskActivity;
}

export interface DedicatedHardwareTaskCatalog {
  readonly version: 1;
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: string;
  readonly snapshotRevision: string;
  readonly tasks: readonly DedicatedHardwarePublishedTask[];
}

export type DedicatedHardwareAction =
  | { readonly kind: "command"; readonly command: DedicatedHardwareCommand }
  | { readonly kind: "composer-key"; readonly key: "ArrowUp" | "ArrowDown" | "Enter" }
  | {
    readonly kind: "task";
    readonly profileId: string;
    readonly serverId: string;
    readonly connectionGeneration: string;
    readonly snapshotRevision: string;
    readonly sessionId: string;
    readonly sessionGeneration: string;
    readonly targetId: string;
    readonly focusWindow: boolean;
  }
  | { readonly kind: "skill"; readonly serverId: string; readonly resourceId: string; readonly name: string }
  | { readonly kind: "voice" }
  | { readonly kind: "composer-text"; readonly text: string }
  | { readonly kind: "fixed-link"; readonly linkId: "product-feedback" | "documentation" };

export type DedicatedHardwareActionEvent =
  | { readonly kind: "button"; readonly phase: "press" | "release" | "cancel"; readonly action: DedicatedHardwareAction }
  | { readonly kind: "scroll"; readonly phase: "press" | "move"; readonly direction: "up" | "down"; readonly distance: number }
  | { readonly kind: "scroll"; readonly phase: "release" | "cancel" };

export type DedicatedHardwareVoiceActivationKind = "start" | "toggle-finish";
export type DedicatedHardwareVoiceReleaseKind = "tap" | "hold" | "cancel";
export type DedicatedHardwareVoiceRoutedEvent =
  | {
    readonly kind: "button";
    readonly phase: "press";
    readonly action: Readonly<{ readonly kind: "voice" }>;
    readonly activationId: string;
    readonly ownerActivationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly releaseKind: null;
  }
  | {
    readonly kind: "button";
    readonly phase: "release";
    readonly action: Readonly<{ readonly kind: "voice" }>;
    readonly activationId: string;
    readonly ownerActivationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly releaseKind: "tap" | "hold";
  }
  | {
    readonly kind: "button";
    readonly phase: "cancel";
    readonly action: Readonly<{ readonly kind: "voice" }>;
    readonly activationId: string;
    readonly ownerActivationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly releaseKind: "cancel";
  };

type DedicatedHardwareNonVoiceAction = Exclude<DedicatedHardwareAction, { readonly kind: "voice" }>;
export type DedicatedHardwareRoutedActionEvent =
  | {
    readonly kind: "button";
    readonly phase: "press" | "release" | "cancel";
    readonly action: DedicatedHardwareNonVoiceAction;
  }
  | Extract<DedicatedHardwareActionEvent, { readonly kind: "scroll" }>
  | DedicatedHardwareVoiceRoutedEvent;

export function isDedicatedHardwareVoiceRoutedEvent(
  event: DedicatedHardwareRoutedActionEvent
): event is DedicatedHardwareVoiceRoutedEvent {
  return event.kind === "button" && "activationId" in event;
}

export type DedicatedHardwareTaskAction = Extract<DedicatedHardwareAction, { readonly kind: "task" }>;

export interface DedicatedHardwareActionDelivery {
  readonly version: 1;
  readonly event: DedicatedHardwareRoutedActionEvent;
  readonly focusRequestId: string | null;
}

export interface DedicatedHardwareTaskFocusAcknowledgement {
  readonly version: 1;
  readonly focusRequestId: string;
  readonly task: DedicatedHardwareTaskAction;
}

export const DEDICATED_HARDWARE_ACTION_ID_MAX_CHARACTERS = 512;
export const DEDICATED_HARDWARE_ACTION_SERVER_ID_MAX_CHARACTERS = 256;
export const DEDICATED_HARDWARE_ACTION_NAME_MAX_CHARACTERS = 256;
export const DEDICATED_HARDWARE_ACTION_TEXT_MAX_CHARACTERS = 2_000;
export const DEDICATED_HARDWARE_ACTION_TEXT_MAX_UTF8_BYTES = 8_000;

/** Renderer-facing bridge. Desktop owns persistence, hardware IO, and action dispatch. */
export interface DedicatedHardwareBridge {
  readonly getDedicatedHardwareState: () => Promise<unknown>;
  readonly setDedicatedHardwareSettings: (model: DedicatedHardwareModel, settings: DedicatedHardwareSettings) => Promise<unknown>;
  readonly resetDedicatedHardwareSettings: (model: DedicatedHardwareModel, scope: "layout" | "all") => Promise<unknown>;
  readonly probeDedicatedHardware: (model: DedicatedHardwareModel) => Promise<unknown>;
  readonly recoverDedicatedHardwareKeymap: (model: "creator-micro-2") => Promise<unknown>;
  readonly setDedicatedHardwarePreview: (model: DedicatedHardwareModel, enabled: boolean) => Promise<void>;
  readonly publishDedicatedHardwareTasks: (catalog: DedicatedHardwareTaskCatalog) => Promise<void>;
  readonly acknowledgeDedicatedHardwareTaskFocus: (
    acknowledgement: DedicatedHardwareTaskFocusAcknowledgement
  ) => Promise<boolean>;
  readonly onDedicatedHardwareStateChanged?: (listener: (state: unknown) => void) => () => void;
  readonly onDedicatedHardwareAction?: (listener: (action: unknown) => void) => () => void;
  readonly onDedicatedHardwarePreviewInput?: (listener: (input: unknown) => void) => () => void;
  readonly openDedicatedHardwareInputSettings?: () => Promise<boolean>;
}

const BOARD_CELLS: Readonly<Record<DedicatedHardwarePhysicalKey, readonly [number, number]>> = {
  AG00: [0, 1], AG01: [0, 2], AG02: [1, 0], AG03: [1, 1], AG04: [1, 2], AG05: [1, 3],
  ACT06: [2, 0], ACT07: [2, 1], ACT08: [2, 2], ACT09: [2, 3],
  ACT10: [3, 1], ACT11: [3, 2], ACT12: [3, 3]
};

const NONE: DedicatedHardwareBinding = { kind: "none" };
const command = (value: DedicatedHardwareCommand): DedicatedHardwareBinding => ({ kind: "command", command: value });

function baseKeys(): Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeySetting> {
  return Object.fromEntries(DEDICATED_HARDWARE_PHYSICAL_KEYS.map((key, index) => [key, {
    keycapId: index < DEDICATED_HARDWARE_TASK_KEYS.length ? `empty-${Math.min(index + 1, 4)}` as DedicatedHardwareKeycapId : "empty-1",
    binding: NONE
  }])) as Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeySetting>;
}

export function createDefaultDedicatedHardwareSettings(model: DedicatedHardwareModel): DedicatedHardwareSettings {
  const keys = baseKeys();
  if (model === "codex-micro") {
    keys.ACT06 = { keycapId: "fast", binding: command("toggle-fast") };
    keys.ACT07 = { keycapId: "approve", binding: command("approve") };
    keys.ACT08 = { keycapId: "reject", binding: command("reject") };
    keys.ACT09 = { keycapId: "fork", binding: command("fork-task") };
    keys.ACT10 = { keycapId: "microphone", binding: { kind: "voice" } };
    keys.ACT11 = { keycapId: "empty-1", binding: NONE };
    keys.ACT12 = { keycapId: "submit", binding: command("submit") };
  } else {
    keys.ACT06 = { keycapId: "empty-1", binding: command("toggle-fast") };
    keys.ACT07 = { keycapId: "empty-2", binding: command("approve") };
    keys.ACT08 = { keycapId: "empty-3", binding: command("reject") };
    keys.ACT09 = { keycapId: "empty-4", binding: command("fork-task") };
    keys.ACT10 = { keycapId: "empty-1", binding: { kind: "voice" } };
    keys.ACT11 = { keycapId: "empty-2", binding: NONE };
    keys.ACT12 = { keycapId: "empty-3", binding: command("submit") };
  }
  return {
    version: 1,
    enabled: false,
    lighting: { brightnessPercent: 100, autoDim: "3-minutes" },
    taskSource: "last-sent",
    singleTapTaskKeys: true,
    customTaskSlots: [NONE, NONE, NONE, NONE, NONE, NONE],
    layout: {
      version: 1,
      keys,
      stick: {
        up: command("scroll-up"), right: command("toggle-inspector"),
        down: command("scroll-down"), left: command("toggle-sidebar")
      },
      encoder: { left: NONE, right: NONE, click: NONE, longPress: NONE },
      encoderMode: "session-switch",
      merges: model === "codex-micro" ? [{ origin: "ACT10", cover: "ACT11" }] : [],
      taskKeys: [...DEDICATED_HARDWARE_TASK_KEYS]
    }
  };
}

export function createUnavailableDedicatedHardwareSnapshot(): DedicatedHardwareSnapshot {
  const models = {} as Record<DedicatedHardwareModel, DedicatedHardwareModelState>;
  for (const model of DEDICATED_HARDWARE_MODELS) models[model] = {
    model,
    status: "unavailable",
    reason: "sdk-unavailable",
    devicePresent: null,
    transport: null,
    firmwareVersion: null,
    batteryPercent: null,
    charging: null,
    inputPermission: "unknown",
    keymap: model === "creator-micro-2"
      ? { phase: "unavailable", backupAvailable: null, failure: null }
      : null,
    settingsError: null,
    settings: createDefaultDedicatedHardwareSettings(model),
    taskSlots: Array.from({ length: 6 }, (_, slot) => ({ slot, sessionId: null, title: null }))
  };
  return {
    version: 1,
    models
  };
}

function isRecordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOption<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0)
    && value.trim() === value && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isDecimalGeneration(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isNullableIndex(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseDedicatedHardwareTaskCatalog(value: unknown): DedicatedHardwareTaskCatalog | undefined {
  if (!isRecordWithExactKeys(value, ["version", "profileId", "serverId", "connectionGeneration", "snapshotRevision", "tasks"])
    || value.version !== 1 || !isActionIdentity(value.profileId, 256) || !isActionIdentity(value.serverId, 256)
    || !isDecimalGeneration(value.connectionGeneration) || !isDecimalGeneration(value.snapshotRevision)
    || !Array.isArray(value.tasks) || value.tasks.length > 100) return undefined;
  const seen = new Set<string>();
  const tasks: DedicatedHardwarePublishedTask[] = [];
  for (const raw of value.tasks) {
    if (!isRecordWithExactKeys(raw, ["sessionId", "sessionGeneration", "targetId", "title", "pinned", "userSendAt", "sidebarOrder", "catalogEligible", "priorityRank", "activity"])
      || !isActionIdentity(raw.sessionId, 512) || seen.has(raw.sessionId)
      || !isDecimalGeneration(raw.sessionGeneration) || !isActionIdentity(raw.targetId, 512)
      || !(raw.title === null || isTaskCatalogTitle(raw.title)) || typeof raw.pinned !== "boolean"
      || !(raw.userSendAt === null || typeof raw.userSendAt === "number" && Number.isSafeInteger(raw.userSendAt) && raw.userSendAt >= 0)
      || !isNullableIndex(raw.sidebarOrder) || typeof raw.catalogEligible !== "boolean" || !isNullableIndex(raw.priorityRank)
      || !isRecordWithExactKeys(raw.activity, ["phase", "attention"])
      || !(raw.activity.phase === null || raw.activity.phase === "running" || raw.activity.phase === "needs-interaction"
        || raw.activity.phase === "completed" || raw.activity.phase === "error") || typeof raw.activity.attention !== "boolean") return undefined;
    seen.add(raw.sessionId);
    tasks.push({
      sessionId: raw.sessionId, sessionGeneration: raw.sessionGeneration, targetId: raw.targetId,
      title: raw.title, pinned: raw.pinned, userSendAt: raw.userSendAt, sidebarOrder: raw.sidebarOrder,
      catalogEligible: raw.catalogEligible, priorityRank: raw.priorityRank,
      activity: { phase: raw.activity.phase, attention: raw.activity.attention }
    });
  }
  return {
    version: 1, profileId: value.profileId, serverId: value.serverId,
    connectionGeneration: value.connectionGeneration, snapshotRevision: value.snapshotRevision, tasks
  };
}

export function parseDedicatedHardwareBinding(value: unknown): DedicatedHardwareBinding | undefined {
  if (!isRecordWithExactKeys(value, value !== null && typeof value === "object" && "kind" in value
    ? bindingKeys((value as { kind?: unknown }).kind) : [])) return undefined;
  switch (value.kind) {
    case "none": return { kind: "none" };
    case "voice": return { kind: "voice" };
    case "command":
      return isOption(value.command, DEDICATED_HARDWARE_COMMANDS)
        ? { kind: "command", command: value.command } : undefined;
    case "skill":
      return isActionIdentity(value.serverId, 256) && isActionIdentity(value.resourceId, 512) && isActionIdentity(value.name, 256)
        ? { kind: "skill", serverId: value.serverId, resourceId: value.resourceId, name: value.name } : undefined;
    case "composer-text":
      return isActionComposerText(value.text) ? { kind: "composer-text", text: value.text } : undefined;
    case "fixed-link":
      return value.linkId === "product-feedback" || value.linkId === "documentation"
        ? { kind: "fixed-link", linkId: value.linkId } : undefined;
    default: return undefined;
  }
}

function bindingKeys(kind: unknown): readonly string[] {
  switch (kind) {
    case "none": case "voice": return ["kind"];
    case "command": return ["kind", "command"];
    case "skill": return ["kind", "serverId", "resourceId", "name"];
    case "composer-text": return ["kind", "text"];
    case "fixed-link": return ["kind", "linkId"];
    default: return ["kind"];
  }
}

export function parseDedicatedHardwareAction(value: unknown): DedicatedHardwareAction {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) throw invalidAction();
  const action = value as Record<string, unknown>;
  switch (action.kind) {
    case "composer-key":
      if (!isRecordWithExactKeys(action, ["kind", "key"])
        || action.key !== "ArrowUp" && action.key !== "ArrowDown" && action.key !== "Enter") throw invalidAction();
      return Object.freeze({ kind: "composer-key", key: action.key });
    case "command":
      if (!isRecordWithExactKeys(action, ["kind", "command"]) || !isOption(action.command, DEDICATED_HARDWARE_COMMANDS)) throw invalidAction();
      return Object.freeze({ kind: "command", command: action.command });
    case "task":
      if (!isRecordWithExactKeys(action, [
        "kind", "profileId", "serverId", "connectionGeneration", "snapshotRevision",
        "sessionId", "sessionGeneration", "targetId", "focusWindow"
      ])
        || !isActionIdentity(action.profileId, DEDICATED_HARDWARE_ACTION_SERVER_ID_MAX_CHARACTERS)
        || !isActionIdentity(action.serverId, DEDICATED_HARDWARE_ACTION_SERVER_ID_MAX_CHARACTERS)
        || !isDecimalGeneration(action.connectionGeneration) || !isDecimalGeneration(action.snapshotRevision)
        || !isActionIdentity(action.sessionId, DEDICATED_HARDWARE_ACTION_ID_MAX_CHARACTERS)
        || !isDecimalGeneration(action.sessionGeneration)
        || !isActionIdentity(action.targetId, DEDICATED_HARDWARE_ACTION_ID_MAX_CHARACTERS)
        || typeof action.focusWindow !== "boolean") throw invalidAction();
      return Object.freeze({
        kind: "task",
        profileId: action.profileId,
        serverId: action.serverId,
        connectionGeneration: action.connectionGeneration,
        snapshotRevision: action.snapshotRevision,
        sessionId: action.sessionId,
        sessionGeneration: action.sessionGeneration,
        targetId: action.targetId,
        focusWindow: action.focusWindow
      });
    case "skill":
      if (!isRecordWithExactKeys(action, ["kind", "serverId", "resourceId", "name"])
        || !isActionIdentity(action.serverId, DEDICATED_HARDWARE_ACTION_SERVER_ID_MAX_CHARACTERS)
        || !isActionIdentity(action.resourceId, DEDICATED_HARDWARE_ACTION_ID_MAX_CHARACTERS)
        || !isActionIdentity(action.name, DEDICATED_HARDWARE_ACTION_NAME_MAX_CHARACTERS)) throw invalidAction();
      return Object.freeze({ kind: "skill", serverId: action.serverId, resourceId: action.resourceId, name: action.name });
    case "voice":
      if (!isRecordWithExactKeys(action, ["kind"])) throw invalidAction();
      return Object.freeze({ kind: "voice" });
    case "composer-text":
      if (!isRecordWithExactKeys(action, ["kind", "text"]) || !isActionComposerText(action.text)) throw invalidAction();
      return Object.freeze({ kind: "composer-text", text: action.text });
    case "fixed-link":
      if (!isRecordWithExactKeys(action, ["kind", "linkId"])
        || (action.linkId !== "product-feedback" && action.linkId !== "documentation")) throw invalidAction();
      return Object.freeze({ kind: "fixed-link", linkId: action.linkId });
    default:
      throw invalidAction();
  }
}

export function parseDedicatedHardwareActionEvent(value: unknown): DedicatedHardwareActionEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) throw invalidEvent();
  const event = value as Record<string, unknown>;
  if (event.kind === "button") {
    if (!isRecordWithExactKeys(event, ["kind", "phase", "action"])
      || (event.phase !== "press" && event.phase !== "release" && event.phase !== "cancel")) throw invalidEvent();
    let action: DedicatedHardwareAction;
    try { action = parseDedicatedHardwareAction(event.action); } catch { throw invalidEvent(); }
    return Object.freeze({ kind: "button", phase: event.phase, action });
  }
  if (event.kind !== "scroll") throw invalidEvent();
  if (event.phase === "release" || event.phase === "cancel") {
    if (!isRecordWithExactKeys(event, ["kind", "phase"])) throw invalidEvent();
    return Object.freeze({ kind: "scroll", phase: event.phase });
  }
  if ((event.phase !== "press" && event.phase !== "move")
    || !isRecordWithExactKeys(event, ["kind", "phase", "direction", "distance"])
    || (event.direction !== "up" && event.direction !== "down")
    || typeof event.distance !== "number" || !Number.isFinite(event.distance)
    || event.distance <= 0.5 || event.distance > 1) throw invalidEvent();
  return Object.freeze({ kind: "scroll", phase: event.phase, direction: event.direction, distance: event.distance });
}

export function parseDedicatedHardwareActionDelivery(value: unknown): DedicatedHardwareActionDelivery {
  if (!isRecordWithExactKeys(value, ["version", "event", "focusRequestId"]) || value.version !== 1) {
    throw new TypeError("Dedicated hardware action delivery is invalid.");
  }
  let event: DedicatedHardwareRoutedActionEvent;
  try { event = parseDedicatedHardwareRoutedActionEvent(value.event); } catch {
    throw new TypeError("Dedicated hardware action delivery is invalid.");
  }
  const focusTaskPress = event.kind === "button" && event.phase === "press"
    && event.action.kind === "task" && event.action.focusWindow;
  const focusRequestId = value.focusRequestId;
  if (focusTaskPress) {
    if (!isFocusRequestId(focusRequestId)) throw new TypeError("Dedicated hardware action delivery is invalid.");
    return Object.freeze({ version: 1, event, focusRequestId });
  }
  if (focusRequestId !== null) throw new TypeError("Dedicated hardware action delivery is invalid.");
  return Object.freeze({ version: 1, event, focusRequestId: null });
}

/** Parses only Main-routed events; raw utility voice phases are never renderer input. */
export function parseDedicatedHardwareRoutedActionEvent(
  value: unknown
): DedicatedHardwareRoutedActionEvent {
  if (isRecordWithExactKeys(value, [
    "kind", "phase", "action", "activationId", "ownerActivationId", "activationKind", "releaseKind"
  ]) && value.kind === "button"
    && isRecordWithExactKeys(value.action, ["kind"])
    && value.action.kind === "voice"
    && isVoiceActivationId(value.activationId)
    && isVoiceActivationId(value.ownerActivationId)
    && (value.activationKind === "start" || value.activationKind === "toggle-finish")) {
    const identityMatchesKind = value.activationKind === "start"
      ? value.activationId === value.ownerActivationId
      : BigInt(value.activationId) > BigInt(value.ownerActivationId);
    if (!identityMatchesKind) throw invalidEvent();
    const activationKind: DedicatedHardwareVoiceActivationKind = value.activationKind;
    const shared = {
      kind: "button" as const,
      action: Object.freeze({ kind: "voice" as const }),
      activationId: value.activationId,
      ownerActivationId: value.ownerActivationId,
      activationKind
    };
    if (value.phase === "press" && value.releaseKind === null) {
      return Object.freeze({ ...shared, phase: "press", releaseKind: null });
    }
    if (value.phase === "release" && (value.releaseKind === "tap" || value.releaseKind === "hold")) {
      return Object.freeze({ ...shared, phase: "release", releaseKind: value.releaseKind });
    }
    if (value.phase === "cancel" && value.releaseKind === "cancel") {
      return Object.freeze({ ...shared, phase: "cancel", releaseKind: "cancel" });
    }
    throw invalidEvent();
  }
  const event = parseDedicatedHardwareActionEvent(value);
  if (event.kind === "button" && event.action.kind === "voice") throw invalidEvent();
  return event as DedicatedHardwareRoutedActionEvent;
}

function isActionIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isActionComposerText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DEDICATED_HARDWARE_ACTION_TEXT_MAX_CHARACTERS
    && value === value.trim() && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= DEDICATED_HARDWARE_ACTION_TEXT_MAX_UTF8_BYTES;
}

function isFocusRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,63}$/u.test(value);
}

function isVoiceActivationId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,63}$/u.test(value);
}

function isTaskCatalogTitle(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && value === value.trim()
    && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 2_048;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function invalidAction(): TypeError {
  return new TypeError("Dedicated hardware action is invalid.");
}

function invalidEvent(): TypeError {
  return new TypeError("Dedicated hardware action event is invalid.");
}

function parseKeySetting(value: unknown): DedicatedHardwareKeySetting | undefined {
  if (!isRecordWithExactKeys(value, ["keycapId", "binding"]) || !isOption(value.keycapId, DEDICATED_HARDWARE_KEYCAP_IDS)) return undefined;
  const binding = parseDedicatedHardwareBinding(value.binding);
  return binding === undefined ? undefined : { keycapId: value.keycapId, binding };
}

export function dedicatedHardwareMergeNeighbor(
  origin: DedicatedHardwarePhysicalKey,
  direction: "right" | "down"
): DedicatedHardwarePhysicalKey | undefined {
  const [row, column] = BOARD_CELLS[origin];
  const wanted = direction === "right" ? [row, column + 1] : [row + 1, column];
  return DEDICATED_HARDWARE_PHYSICAL_KEYS.find((key) => {
    const cell = BOARD_CELLS[key];
    return cell[0] === wanted[0] && cell[1] === wanted[1];
  });
}

export function dedicatedHardwareMergeDirection(merge: DedicatedHardwareMerge): "right" | "down" | undefined {
  if (dedicatedHardwareMergeNeighbor(merge.origin, "right") === merge.cover) return "right";
  if (dedicatedHardwareMergeNeighbor(merge.origin, "down") === merge.cover) return "down";
  return undefined;
}

export function dedicatedHardwareMergeForKey(
  merges: readonly DedicatedHardwareMerge[], key: DedicatedHardwarePhysicalKey
): DedicatedHardwareMerge | undefined {
  return merges.find((merge) => merge.origin === key || merge.cover === key);
}

function parseLayout(value: unknown): DedicatedHardwareLayout | undefined {
  if (!isRecordWithExactKeys(value, ["version", "keys", "stick", "encoder", "encoderMode", "merges", "taskKeys"])
    || value.version !== 1 || !isRecordWithExactKeys(value.keys, DEDICATED_HARDWARE_PHYSICAL_KEYS)
    || !isRecordWithExactKeys(value.stick, DEDICATED_HARDWARE_DIRECTIONS)
    || !isRecordWithExactKeys(value.encoder, DEDICATED_HARDWARE_ENCODER_INPUTS)
    || !isOption(value.encoderMode, DEDICATED_HARDWARE_ENCODER_MODES)
    || !Array.isArray(value.merges) || !Array.isArray(value.taskKeys)) return undefined;
  const keys = {} as Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeySetting>;
  for (const key of DEDICATED_HARDWARE_PHYSICAL_KEYS) {
    const setting = parseKeySetting(value.keys[key]);
    if (setting === undefined) return undefined;
    keys[key] = setting;
  }
  const stick = {} as Record<DedicatedHardwareDirection, DedicatedHardwareBinding>;
  for (const direction of DEDICATED_HARDWARE_DIRECTIONS) {
    const binding = parseDedicatedHardwareBinding(value.stick[direction]);
    if (binding === undefined || binding.kind === "voice") return undefined;
    stick[direction] = binding;
  }
  const encoder = {} as Record<DedicatedHardwareEncoderInput, DedicatedHardwareBinding>;
  for (const input of DEDICATED_HARDWARE_ENCODER_INPUTS) {
    const binding = parseDedicatedHardwareBinding(value.encoder[input]);
    if (binding === undefined || binding.kind === "voice") return undefined;
    encoder[input] = binding;
  }
  const used = new Set<DedicatedHardwarePhysicalKey>();
  const merges: DedicatedHardwareMerge[] = [];
  let lastMergeIndex = -1;
  for (const raw of value.merges) {
    if (!isRecordWithExactKeys(raw, ["origin", "cover"])
      || !isOption(raw.origin, DEDICATED_HARDWARE_PHYSICAL_KEYS)
      || !isOption(raw.cover, DEDICATED_HARDWARE_PHYSICAL_KEYS)) return undefined;
    const merge = { origin: raw.origin, cover: raw.cover };
    const index = DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(merge.origin);
    if (dedicatedHardwareMergeDirection(merge) === undefined || used.has(merge.origin) || used.has(merge.cover) || index <= lastMergeIndex) return undefined;
    used.add(merge.origin); used.add(merge.cover); lastMergeIndex = index; merges.push(merge);
  }
  const taskKeys: DedicatedHardwarePhysicalKey[] = [];
  let lastTaskIndex = -1;
  for (const raw of value.taskKeys) {
    if (!isOption(raw, DEDICATED_HARDWARE_PHYSICAL_KEYS) || used.has(raw)) return undefined;
    const index = DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(raw);
    if (index <= lastTaskIndex) return undefined;
    lastTaskIndex = index; taskKeys.push(raw);
  }
  return { version: 1, keys, stick, encoder, encoderMode: value.encoderMode, merges, taskKeys };
}

export function parseDedicatedHardwareSettings(value: unknown): DedicatedHardwareSettings | undefined {
  if (!isRecordWithExactKeys(value, ["version", "enabled", "lighting", "taskSource", "singleTapTaskKeys", "customTaskSlots", "layout"])
    || value.version !== 1 || typeof value.enabled !== "boolean"
    || !isRecordWithExactKeys(value.lighting, ["brightnessPercent", "autoDim"])
    || typeof value.lighting.brightnessPercent !== "number" || !Number.isInteger(value.lighting.brightnessPercent)
    || value.lighting.brightnessPercent < 0 || value.lighting.brightnessPercent > 100
    || !isOption(value.lighting.autoDim, DEDICATED_HARDWARE_AUTO_DIM_OPTIONS)
    || !isOption(value.taskSource, DEDICATED_HARDWARE_TASK_SOURCES)
    || typeof value.singleTapTaskKeys !== "boolean"
    || !Array.isArray(value.customTaskSlots) || value.customTaskSlots.length !== 6) return undefined;
  const customTaskSlots = value.customTaskSlots.map(parseDedicatedHardwareBinding);
  const layout = parseLayout(value.layout);
  if (customTaskSlots.some((binding) => binding === undefined) || layout === undefined) return undefined;
  const parsed: DedicatedHardwareSettings = {
    version: 1,
    enabled: value.enabled,
    lighting: { brightnessPercent: value.lighting.brightnessPercent, autoDim: value.lighting.autoDim },
    taskSource: value.taskSource,
    singleTapTaskKeys: value.singleTapTaskKeys,
    customTaskSlots: customTaskSlots as unknown as DedicatedHardwareSettings["customTaskSlots"],
    layout
  };
  try {
    return new TextEncoder().encode(JSON.stringify(parsed)).byteLength <= DEDICATED_HARDWARE_SETTINGS_MAX_BYTES ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTaskSlot(value: unknown, expected: number): DedicatedHardwareTaskSlotState | undefined {
  if (!isRecordWithExactKeys(value, ["slot", "sessionId", "title"]) || value.slot !== expected
    || !(value.sessionId === null || isBoundedText(value.sessionId, 512))
    || !(value.title === null || isBoundedText(value.title, 512, true))) return undefined;
  return { slot: expected, sessionId: value.sessionId, title: value.title };
}

function parseDedicatedHardwareKeymapState(value: unknown): DedicatedHardwareKeymapState | undefined {
  if (!isRecordWithExactKeys(value, ["phase", "backupAvailable", "failure"])) return undefined;
  if (value.phase === "unavailable") {
    return value.backupAvailable === null && value.failure === null
      ? { phase: "unavailable", backupAvailable: null, failure: null }
      : undefined;
  }
  if (!isOption(value.phase, ["idle", "applying", "occupied", "restoring", "error"] as const)
    || typeof value.backupAvailable !== "boolean"
    || !(value.failure === null || isOption(value.failure, [
      "read", "backup", "transform", "apply", "rollback", "restore", "backup-cleanup", "recovery-required"
    ] as const))
    || value.failure === "recovery-required" && !value.backupAvailable) return undefined;
  return { phase: value.phase, backupAvailable: value.backupAvailable, failure: value.failure };
}

export function parseDedicatedHardwareModelState(value: unknown, expectedModel?: DedicatedHardwareModel): DedicatedHardwareModelState | undefined {
  if (!isRecordWithExactKeys(value, [
    "model", "status", "reason", "devicePresent", "transport", "firmwareVersion", "batteryPercent",
    "charging", "inputPermission", "keymap", "settingsError", "settings", "taskSlots"
  ]) || !isOption(value.model, DEDICATED_HARDWARE_MODELS) || (expectedModel !== undefined && value.model !== expectedModel)
    || !isOption(value.status, ["connecting", "connected", "not-detected", "disabled", "error", "unavailable"] as const)
    || !(value.reason === null || isOption(value.reason, ["sdk-unavailable", "permission-required", "device-in-use", "connection-timeout", "host-crash", "device-disconnected"] as const))
    || !(value.devicePresent === null || typeof value.devicePresent === "boolean")
    || !(value.transport === null || value.transport === "usb" || value.transport === "bluetooth")
    || !(value.firmwareVersion === null || isBoundedText(value.firmwareVersion, 128))
    || !(value.batteryPercent === null || typeof value.batteryPercent === "number"
      && Number.isInteger(value.batteryPercent) && value.batteryPercent >= 0 && value.batteryPercent <= 100)
    || !(value.charging === null || typeof value.charging === "boolean")
    || !isOption(value.inputPermission, ["granted", "denied", "unknown", "not-required"] as const)
    || !(value.settingsError === null || value.settingsError === "invalid" || value.settingsError === "unavailable")
    || !Array.isArray(value.taskSlots) || value.taskSlots.length !== 6) return undefined;
  const keymap = value.model === "creator-micro-2"
    ? parseDedicatedHardwareKeymapState(value.keymap)
    : value.keymap === null ? null : undefined;
  const settings = parseDedicatedHardwareSettings(value.settings);
  const taskSlots = value.taskSlots.map((slot, index) => parseTaskSlot(slot, index));
  if (keymap === undefined || settings === undefined || taskSlots.some((slot) => slot === undefined)) return undefined;
  return {
    model: value.model, status: value.status, reason: value.reason, devicePresent: value.devicePresent,
    transport: value.transport, firmwareVersion: value.firmwareVersion, batteryPercent: value.batteryPercent,
    charging: value.charging, inputPermission: value.inputPermission, keymap,
    settingsError: value.settingsError, settings,
    taskSlots: taskSlots as DedicatedHardwareTaskSlotState[]
  };
}

export function parseDedicatedHardwareSnapshot(value: unknown): DedicatedHardwareSnapshot | undefined {
  if (!isRecordWithExactKeys(value, ["version", "models"]) || value.version !== 1
    || !isRecordWithExactKeys(value.models, DEDICATED_HARDWARE_MODELS)) return undefined;
  const models = {} as Record<DedicatedHardwareModel, DedicatedHardwareModelState>;
  for (const model of DEDICATED_HARDWARE_MODELS) {
    const state = parseDedicatedHardwareModelState(value.models[model], model);
    if (state === undefined) return undefined;
    models[model] = state;
  }
  return { version: 1, models };
}

export function parseDedicatedHardwarePreviewInput(value: unknown): DedicatedHardwarePreviewInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.kind === "key") {
    return isRecordWithExactKeys(input, ["version", "model", "kind", "key", "pressed"]) && input.version === 1
      && isOption(input.model, DEDICATED_HARDWARE_MODELS) && isOption(input.key, DEDICATED_HARDWARE_PHYSICAL_KEYS)
      && typeof input.pressed === "boolean"
      ? { version: 1, model: input.model, kind: "key", key: input.key, pressed: input.pressed } : undefined;
  }
  if (input.kind === "stick") {
    return isRecordWithExactKeys(input, ["version", "model", "kind", "x", "y", "pressed"]) && input.version === 1
      && isOption(input.model, DEDICATED_HARDWARE_MODELS) && finiteUnit(input.x) && finiteUnit(input.y)
      && typeof input.pressed === "boolean"
      ? { version: 1, model: input.model, kind: "stick", x: input.x, y: input.y, pressed: input.pressed } : undefined;
  }
  if (input.kind === "encoder") {
    return isRecordWithExactKeys(input, ["version", "model", "kind", "delta", "pressed"]) && input.version === 1
      && isOption(input.model, DEDICATED_HARDWARE_MODELS) && (input.delta === -1 || input.delta === 0 || input.delta === 1)
      && typeof input.pressed === "boolean"
      ? { version: 1, model: input.model, kind: "encoder", delta: input.delta, pressed: input.pressed } : undefined;
  }
  return undefined;
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

export function cloneDedicatedHardwareSettings(settings: DedicatedHardwareSettings): DedicatedHardwareSettings {
  const parsed = parseDedicatedHardwareSettings(settings);
  if (parsed === undefined) throw new Error("Invalid dedicated hardware settings.");
  return parsed;
}

export function setDedicatedHardwareModelState(
  snapshot: DedicatedHardwareSnapshot, state: DedicatedHardwareModelState
): DedicatedHardwareSnapshot {
  return { version: 1, models: { ...snapshot.models, [state.model]: state } };
}

export function replaceDedicatedHardwareModelSettings(
  snapshot: DedicatedHardwareSnapshot, model: DedicatedHardwareModel, settings: DedicatedHardwareSettings
): DedicatedHardwareSnapshot {
  return setDedicatedHardwareModelState(snapshot, { ...snapshot.models[model], settings: cloneDedicatedHardwareSettings(settings) });
}

export function resetDedicatedHardwareSettingsValue(
  model: DedicatedHardwareModel, current: DedicatedHardwareSettings, scope: "layout" | "all"
): DedicatedHardwareSettings {
  const defaults = createDefaultDedicatedHardwareSettings(model);
  return scope === "layout"
    ? { ...cloneDedicatedHardwareSettings(current), layout: defaults.layout }
    : { ...defaults, enabled: current.enabled };
}

export function toggleDedicatedHardwareTaskKey(
  layout: DedicatedHardwareLayout, key: DedicatedHardwarePhysicalKey, selected: boolean
): DedicatedHardwareLayout {
  if (dedicatedHardwareMergeForKey(layout.merges, key) !== undefined) return layout;
  const selectedKeys = new Set(layout.taskKeys);
  if (selected) selectedKeys.add(key); else selectedKeys.delete(key);
  return { ...layout, taskKeys: DEDICATED_HARDWARE_PHYSICAL_KEYS.filter((candidate) => selectedKeys.has(candidate)) };
}

export function setDedicatedHardwareMerge(
  layout: DedicatedHardwareLayout, origin: DedicatedHardwarePhysicalKey, direction: "none" | "right" | "down"
): DedicatedHardwareLayout {
  const prior = dedicatedHardwareMergeForKey(layout.merges, origin);
  const withoutPrior = layout.merges.filter((merge) => merge !== prior);
  if (direction === "none") return { ...layout, merges: withoutPrior, taskKeys: [...layout.taskKeys] };
  const cover = dedicatedHardwareMergeNeighbor(origin, direction);
  if (cover === undefined || dedicatedHardwareMergeForKey(withoutPrior, origin) !== undefined || dedicatedHardwareMergeForKey(withoutPrior, cover) !== undefined) return layout;
  const blocked = new Set([origin, cover]);
  const merges = [...withoutPrior, { origin, cover }].sort((left, right) =>
    DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(left.origin) - DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(right.origin));
  return { ...layout, merges, taskKeys: layout.taskKeys.filter((key) => !blocked.has(key)) };
}
