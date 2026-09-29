export const DEDICATED_HARDWARE_MODEL_IDS = ["codex-micro", "creator-micro-2"] as const;

export type DedicatedHardwareModelId = (typeof DEDICATED_HARDWARE_MODEL_IDS)[number];

export interface DedicatedHardwareModelDescriptor {
  readonly id: DedicatedHardwareModelId;
  readonly displayName: string;
}

export const DEDICATED_HARDWARE_MODELS: Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareModelDescriptor>> =
  Object.freeze({
    "codex-micro": Object.freeze({ id: "codex-micro", displayName: "Codex Micro" }),
    "creator-micro-2": Object.freeze({ id: "creator-micro-2", displayName: "Creator Micro 2" })
  });

export const DEDICATED_HARDWARE_PHYSICAL_KEYS = [
  "AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
  "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"
] as const;

export type DedicatedHardwarePhysicalKey = (typeof DEDICATED_HARDWARE_PHYSICAL_KEYS)[number];

export const DEDICATED_HARDWARE_KEYCAP_IDS = [
  "fast", "approve", "reject", "fork", "microphone", "microphone-alt", "submit", "feedback",
  "terminal", "copy-conversation", "archive", "new-task", "browser", "pin", "review", "add-photos",
  "settings", "tasks", "effort-up", "effort-down", "folder", "add-files", "skills", "plan",
  "navigate-forward", "sidebar", "inspector", "navigate-back", "fullscreen", "composer", "scroll-up",
  "scroll-down", "scroll-bottom", "empty-1", "empty-2", "empty-3", "empty-4", "empty-5"
] as const;

export type DedicatedHardwareKeycapId = (typeof DEDICATED_HARDWARE_KEYCAP_IDS)[number];

export const DEDICATED_HARDWARE_COMMANDS = [
  "activate", "back", "navigate-back", "navigate-forward", "new-task", "toggle-sidebar",
  "focus-composer", "previous-task", "next-task", "previous-panel", "next-panel", "scroll-up",
  "scroll-down", "approve", "reject", "submit", "stop", "toggle-plan", "toggle-fast",
  "effort-increase", "effort-decrease", "toggle-pin", "archive-task", "fork-task",
  "copy-task-link", "copy-conversation-markdown", "add-photos", "add-files", "open-commands",
  "open-settings", "open-skills", "open-schedules", "open-folder", "toggle-inspector",
  "toggle-fullscreen", "open-terminal", "open-browser-tab", "toggle-review-tab", "scroll-bottom",
  "feedback"
] as const;

export type DedicatedHardwareCommand = (typeof DEDICATED_HARDWARE_COMMANDS)[number];

export const DEDICATED_HARDWARE_FIXED_LINK_IDS = ["product-feedback", "documentation"] as const;
export type DedicatedHardwareFixedLinkId = (typeof DEDICATED_HARDWARE_FIXED_LINK_IDS)[number];

export type DedicatedHardwareBinding =
  | { readonly kind: "none" }
  | { readonly kind: "command"; readonly command: DedicatedHardwareCommand }
  | { readonly kind: "voice" }
  | {
      readonly kind: "skill";
      readonly serverId: string;
      readonly resourceId: string;
      readonly name: string;
    }
  | { readonly kind: "composer-text"; readonly text: string }
  | { readonly kind: "fixed-link"; readonly linkId: DedicatedHardwareFixedLinkId };

export const DEDICATED_HARDWARE_AUTO_DIM_OPTIONS = [
  "off", "30-seconds", "1-minute", "3-minutes", "10-minutes", "30-minutes", "1-hour"
] as const;
export type DedicatedHardwareAutoDim = (typeof DEDICATED_HARDWARE_AUTO_DIM_OPTIONS)[number];

export const DEDICATED_HARDWARE_TASK_SOURCES = ["sidebar", "last-sent", "priority", "custom"] as const;
export type DedicatedHardwareTaskSource = (typeof DEDICATED_HARDWARE_TASK_SOURCES)[number];

export const DEDICATED_HARDWARE_DIRECTIONS = ["up", "right", "down", "left"] as const;
export type DedicatedHardwareDirection = (typeof DEDICATED_HARDWARE_DIRECTIONS)[number];

export const DEDICATED_HARDWARE_ENCODER_ACTIONS = ["left", "right", "click", "longPress"] as const;
export type DedicatedHardwareEncoderAction = (typeof DEDICATED_HARDWARE_ENCODER_ACTIONS)[number];

export const DEDICATED_HARDWARE_ENCODER_MODES = [
  "session-switch", "composer-navigation", "reasoning", "conversation-scroll", "custom"
] as const;
export type DedicatedHardwareEncoderMode = (typeof DEDICATED_HARDWARE_ENCODER_MODES)[number];

export interface DedicatedHardwareKeyAssignment {
  readonly keycapId: DedicatedHardwareKeycapId;
  readonly binding: DedicatedHardwareBinding;
}

export interface DedicatedHardwareKeyMerge {
  readonly origin: DedicatedHardwarePhysicalKey;
  readonly cover: DedicatedHardwarePhysicalKey;
}

export interface DedicatedHardwareLayout {
  readonly version: 1;
  readonly keys: Readonly<Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeyAssignment>>;
  readonly stick: Readonly<Record<DedicatedHardwareDirection, DedicatedHardwareBinding>>;
  readonly encoder: Readonly<Record<DedicatedHardwareEncoderAction, DedicatedHardwareBinding>>;
  readonly encoderMode: DedicatedHardwareEncoderMode;
  readonly merges: readonly DedicatedHardwareKeyMerge[];
  readonly taskKeys: readonly DedicatedHardwarePhysicalKey[];
}

export interface DedicatedHardwareLightingSettings {
  readonly brightnessPercent: number;
  readonly autoDim: DedicatedHardwareAutoDim;
}

export interface DedicatedHardwareSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly lighting: DedicatedHardwareLightingSettings;
  readonly taskSource: DedicatedHardwareTaskSource;
  readonly singleTapTaskKeys: boolean;
  readonly customTaskSlots: readonly [
    DedicatedHardwareBinding, DedicatedHardwareBinding, DedicatedHardwareBinding,
    DedicatedHardwareBinding, DedicatedHardwareBinding, DedicatedHardwareBinding
  ];
  readonly layout: DedicatedHardwareLayout;
}

export const DEDICATED_HARDWARE_TASK_SLOT_COUNT = 6;
export const DEDICATED_HARDWARE_SETTINGS_MAX_BYTES = 64 * 1024;
export const DEDICATED_HARDWARE_SERVER_ID_MAX_LENGTH = 256;
export const DEDICATED_HARDWARE_RESOURCE_ID_MAX_LENGTH = 512;
export const DEDICATED_HARDWARE_DISPLAY_NAME_MAX_LENGTH = 256;
export const DEDICATED_HARDWARE_COMPOSER_TEXT_MAX_LENGTH = 2_000;
export const DEDICATED_HARDWARE_COMPOSER_TEXT_MAX_UTF8_BYTES = 8_000;

const PHYSICAL_KEY_CELL: Readonly<Record<DedicatedHardwarePhysicalKey, Readonly<{ row: number; column: number }>>> =
  Object.freeze({
    AG00: Object.freeze({ row: 0, column: 1 }),
    AG01: Object.freeze({ row: 0, column: 2 }),
    AG02: Object.freeze({ row: 1, column: 0 }),
    AG03: Object.freeze({ row: 1, column: 1 }),
    AG04: Object.freeze({ row: 1, column: 2 }),
    AG05: Object.freeze({ row: 1, column: 3 }),
    ACT06: Object.freeze({ row: 2, column: 0 }),
    ACT07: Object.freeze({ row: 2, column: 1 }),
    ACT08: Object.freeze({ row: 2, column: 2 }),
    ACT09: Object.freeze({ row: 2, column: 3 }),
    ACT10: Object.freeze({ row: 3, column: 1 }),
    ACT11: Object.freeze({ row: 3, column: 2 }),
    ACT12: Object.freeze({ row: 3, column: 3 })
  });

const NONE: DedicatedHardwareBinding = Object.freeze({ kind: "none" });

function command(command: DedicatedHardwareCommand): DedicatedHardwareBinding {
  return Object.freeze({ kind: "command", command });
}

function assignment(keycapId: DedicatedHardwareKeycapId, binding: DedicatedHardwareBinding): DedicatedHardwareKeyAssignment {
  return Object.freeze({ keycapId, binding });
}

function defaultKeys(modelId: DedicatedHardwareModelId): Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeyAssignment> {
  const creator = modelId === "creator-micro-2";
  return {
    AG00: assignment("empty-1", NONE),
    AG01: assignment("empty-2", NONE),
    AG02: assignment("empty-3", NONE),
    AG03: assignment("empty-4", NONE),
    AG04: assignment("empty-4", NONE),
    AG05: assignment("empty-4", NONE),
    ACT06: assignment(creator ? "empty-1" : "fast", command("toggle-fast")),
    ACT07: assignment(creator ? "empty-2" : "approve", command("approve")),
    ACT08: assignment(creator ? "empty-3" : "reject", command("reject")),
    ACT09: assignment(creator ? "empty-4" : "fork", command("fork-task")),
    ACT10: assignment(creator ? "empty-1" : "microphone", Object.freeze({ kind: "voice" })),
    ACT11: assignment(creator ? "empty-2" : "empty-1", NONE),
    ACT12: assignment(creator ? "empty-3" : "submit", command("submit"))
  };
}

export function createDefaultDedicatedHardwareSettings(modelId: DedicatedHardwareModelId): DedicatedHardwareSettings {
  if (!isDedicatedHardwareModelId(modelId)) throw new TypeError("Unknown dedicated hardware model.");
  const keys = defaultKeys(modelId);
  return {
    version: 1,
    enabled: false,
    lighting: { brightnessPercent: 100, autoDim: "3-minutes" },
    taskSource: "last-sent",
    singleTapTaskKeys: true,
    customTaskSlots: [
      { kind: "none" }, { kind: "none" }, { kind: "none" },
      { kind: "none" }, { kind: "none" }, { kind: "none" }
    ],
    layout: {
      version: 1,
      keys,
      stick: {
        up: { kind: "command", command: "scroll-up" },
        right: { kind: "command", command: "toggle-inspector" },
        down: { kind: "command", command: "scroll-down" },
        left: { kind: "command", command: "toggle-sidebar" }
      },
      encoder: { left: { kind: "none" }, right: { kind: "none" }, click: { kind: "none" }, longPress: { kind: "none" } },
      encoderMode: "session-switch",
      merges: modelId === "codex-micro" ? [{ origin: "ACT10", cover: "ACT11" }] : [],
      taskKeys: ["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]
    }
  };
}

export function isDedicatedHardwareModelId(value: unknown): value is DedicatedHardwareModelId {
  return isOption(value, DEDICATED_HARDWARE_MODEL_IDS);
}

export function parseDedicatedHardwareBinding(value: unknown): DedicatedHardwareBinding | undefined {
  if (!isRecord(value)) return undefined;
  if (hasExactKeys(value, ["kind"]) && value.kind === "none") return { kind: "none" };
  if (hasExactKeys(value, ["kind", "command"]) && value.kind === "command" && isOption(value.command, DEDICATED_HARDWARE_COMMANDS)) {
    return { kind: "command", command: value.command };
  }
  if (hasExactKeys(value, ["kind"]) && value.kind === "voice") return { kind: "voice" };
  if (hasExactKeys(value, ["kind", "serverId", "resourceId", "name"]) && value.kind === "skill" &&
      isIdentityPart(value.serverId, DEDICATED_HARDWARE_SERVER_ID_MAX_LENGTH) &&
      isIdentityPart(value.resourceId, DEDICATED_HARDWARE_RESOURCE_ID_MAX_LENGTH) &&
      isIdentityPart(value.name, DEDICATED_HARDWARE_DISPLAY_NAME_MAX_LENGTH)) {
    return { kind: "skill", serverId: value.serverId, resourceId: value.resourceId, name: value.name };
  }
  if (hasExactKeys(value, ["kind", "text"]) && value.kind === "composer-text" && isComposerText(value.text)) {
    return { kind: "composer-text", text: value.text };
  }
  if (hasExactKeys(value, ["kind", "linkId"]) && value.kind === "fixed-link" && isOption(value.linkId, DEDICATED_HARDWARE_FIXED_LINK_IDS)) {
    return { kind: "fixed-link", linkId: value.linkId };
  }
  return undefined;
}

export function parseDedicatedHardwareSettings(value: unknown): DedicatedHardwareSettings | undefined {
  if (!hasExactKeys(value, [
    "version", "enabled", "lighting", "taskSource", "singleTapTaskKeys", "customTaskSlots", "layout"
  ]) || value.version !== 1 || typeof value.enabled !== "boolean" ||
      !hasExactKeys(value.lighting, ["brightnessPercent", "autoDim"]) ||
      typeof value.lighting.brightnessPercent !== "number" ||
      !Number.isInteger(value.lighting.brightnessPercent) || value.lighting.brightnessPercent < 0 ||
      value.lighting.brightnessPercent > 100 || !isOption(value.lighting.autoDim, DEDICATED_HARDWARE_AUTO_DIM_OPTIONS) ||
      !isOption(value.taskSource, DEDICATED_HARDWARE_TASK_SOURCES) || typeof value.singleTapTaskKeys !== "boolean" ||
      !Array.isArray(value.customTaskSlots) || value.customTaskSlots.length !== DEDICATED_HARDWARE_TASK_SLOT_COUNT) {
    return undefined;
  }
  const customTaskSlots = value.customTaskSlots.map(parseDedicatedHardwareBinding);
  if (customTaskSlots.some((binding) => binding === undefined)) return undefined;
  const layout = parseLayout(value.layout);
  if (layout === undefined) return undefined;
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
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > DEDICATED_HARDWARE_SETTINGS_MAX_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return parsed;
}

export function cloneDedicatedHardwareSettings(settings: DedicatedHardwareSettings): DedicatedHardwareSettings {
  const parsed = parseDedicatedHardwareSettings(settings);
  if (parsed === undefined) throw new TypeError("Invalid dedicated hardware settings.");
  return parsed;
}

export function dedicatedHardwareMergeNeighbor(
  origin: DedicatedHardwarePhysicalKey,
  direction: "right" | "down"
): DedicatedHardwarePhysicalKey | undefined {
  const cell = PHYSICAL_KEY_CELL[origin];
  const row = direction === "down" ? cell.row + 1 : cell.row;
  const column = direction === "right" ? cell.column + 1 : cell.column;
  return DEDICATED_HARDWARE_PHYSICAL_KEYS.find((key) => {
    const candidate = PHYSICAL_KEY_CELL[key];
    return candidate.row === row && candidate.column === column;
  });
}

function parseLayout(value: unknown): DedicatedHardwareLayout | undefined {
  if (!hasExactKeys(value, ["version", "keys", "stick", "encoder", "encoderMode", "merges", "taskKeys"]) ||
      value.version !== 1 || !hasExactKeys(value.keys, DEDICATED_HARDWARE_PHYSICAL_KEYS) ||
      !hasExactKeys(value.stick, DEDICATED_HARDWARE_DIRECTIONS) ||
      !hasExactKeys(value.encoder, DEDICATED_HARDWARE_ENCODER_ACTIONS) ||
      !isOption(value.encoderMode, DEDICATED_HARDWARE_ENCODER_MODES) ||
      !Array.isArray(value.merges) || value.merges.length > Math.floor(DEDICATED_HARDWARE_PHYSICAL_KEYS.length / 2) ||
      !Array.isArray(value.taskKeys) || value.taskKeys.length > DEDICATED_HARDWARE_PHYSICAL_KEYS.length) {
    return undefined;
  }

  const keys = {} as Record<DedicatedHardwarePhysicalKey, DedicatedHardwareKeyAssignment>;
  for (const key of DEDICATED_HARDWARE_PHYSICAL_KEYS) {
    const raw = value.keys[key];
    if (!hasExactKeys(raw, ["keycapId", "binding"]) || !isOption(raw.keycapId, DEDICATED_HARDWARE_KEYCAP_IDS)) return undefined;
    const binding = parseDedicatedHardwareBinding(raw.binding);
    if (binding === undefined) return undefined;
    keys[key] = { keycapId: raw.keycapId, binding };
  }

  const stick = {} as Record<DedicatedHardwareDirection, DedicatedHardwareBinding>;
  for (const direction of DEDICATED_HARDWARE_DIRECTIONS) {
    const binding = parseDedicatedHardwareBinding(value.stick[direction]);
    if (binding === undefined || binding.kind === "voice") return undefined;
    stick[direction] = binding;
  }
  const encoder = {} as Record<DedicatedHardwareEncoderAction, DedicatedHardwareBinding>;
  for (const action of DEDICATED_HARDWARE_ENCODER_ACTIONS) {
    const binding = parseDedicatedHardwareBinding(value.encoder[action]);
    if (binding === undefined || binding.kind === "voice") return undefined;
    encoder[action] = binding;
  }

  const merges: DedicatedHardwareKeyMerge[] = [];
  const mergedKeys = new Set<DedicatedHardwarePhysicalKey>();
  let priorMergeIndex = -1;
  for (const raw of value.merges) {
    if (!hasExactKeys(raw, ["origin", "cover"]) || !isOption(raw.origin, DEDICATED_HARDWARE_PHYSICAL_KEYS) ||
        !isOption(raw.cover, DEDICATED_HARDWARE_PHYSICAL_KEYS)) return undefined;
    const originIndex = DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(raw.origin);
    if (originIndex <= priorMergeIndex || mergedKeys.has(raw.origin) || mergedKeys.has(raw.cover)) return undefined;
    const right = dedicatedHardwareMergeNeighbor(raw.origin, "right");
    const down = dedicatedHardwareMergeNeighbor(raw.origin, "down");
    if (raw.cover !== right && raw.cover !== down) return undefined;
    priorMergeIndex = originIndex;
    mergedKeys.add(raw.origin);
    mergedKeys.add(raw.cover);
    merges.push({ origin: raw.origin, cover: raw.cover });
  }

  const taskKeys: DedicatedHardwarePhysicalKey[] = [];
  let priorTaskIndex = -1;
  for (const raw of value.taskKeys) {
    if (!isOption(raw, DEDICATED_HARDWARE_PHYSICAL_KEYS)) return undefined;
    const index = DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(raw);
    if (index <= priorTaskIndex || mergedKeys.has(raw)) return undefined;
    priorTaskIndex = index;
    taskKeys.push(raw);
  }

  return { version: 1, keys, stick, encoder, encoderMode: value.encoderMode, merges, taskKeys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOption<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isIdentityPart(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isComposerText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DEDICATED_HARDWARE_COMPOSER_TEXT_MAX_LENGTH &&
    value.trim() === value && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= DEDICATED_HARDWARE_COMPOSER_TEXT_MAX_UTF8_BYTES;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
