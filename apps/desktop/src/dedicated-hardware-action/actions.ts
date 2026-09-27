/** Capability-neutral actions emitted by a dedicated hardware input adapter. */

export const DEDICATED_HARDWARE_COMMAND_IDS = [
  "activate",
  "back",
  "navigate-back",
  "navigate-forward",
  "new-task",
  "toggle-sidebar",
  "focus-composer",
  "previous-task",
  "next-task",
  "previous-panel",
  "next-panel",
  "scroll-up",
  "scroll-down",
  "approve",
  "reject",
  "submit",
  "stop",
  "toggle-plan",
  "toggle-fast",
  "effort-increase",
  "effort-decrease",
  "toggle-pin",
  "archive-task",
  "fork-task",
  "copy-task-link",
  "copy-conversation-markdown",
  "add-photos",
  "add-files",
  "open-commands",
  "open-settings",
  "open-skills",
  "open-schedules",
  "open-folder",
  "toggle-inspector",
  "toggle-fullscreen",
  "open-terminal",
  "open-browser-tab",
  "toggle-review-tab",
  "scroll-bottom",
  "feedback"
] as const;

export type DedicatedHardwareCommandId = (typeof DEDICATED_HARDWARE_COMMAND_IDS)[number];
export type DedicatedHardwareActionPhase = "press" | "release" | "cancel";
export type DedicatedHardwareScrollPhase = "press" | "move" | "release" | "cancel";
export type DedicatedHardwareFixedLinkId = "product-feedback" | "documentation";

export const MAX_DEDICATED_HARDWARE_ID_CHARACTERS = 512;
export const MAX_DEDICATED_HARDWARE_SERVER_ID_CHARACTERS = 256;
export const MAX_DEDICATED_HARDWARE_NAME_CHARACTERS = 256;
export const MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_CHARACTERS = 2_000;
export const MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_UTF8_BYTES = 8_000;

export type DedicatedHardwareAction =
  | { readonly kind: "command"; readonly command: DedicatedHardwareCommandId }
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
  | {
    readonly kind: "skill";
    readonly serverId: string;
    readonly resourceId: string;
    readonly name: string;
  }
  | { readonly kind: "voice" }
  | { readonly kind: "composer-text"; readonly text: string }
  | { readonly kind: "fixed-link"; readonly linkId: DedicatedHardwareFixedLinkId };

export type DedicatedHardwareActionEvent =
  | {
    readonly kind: "button";
    readonly phase: DedicatedHardwareActionPhase;
    readonly action: DedicatedHardwareAction;
  }
  | {
    readonly kind: "scroll";
    readonly phase: "press" | "move";
    readonly direction: "up" | "down";
    /** Raw stick distance after crossing the exclusive 0.5 activation threshold. */
    readonly distance: number;
  }
  | { readonly kind: "scroll"; readonly phase: "release" | "cancel" };

const COMMAND_IDS = new Set<string>(DEDICATED_HARDWARE_COMMAND_IDS);
const BUTTON_PHASES = new Set<string>(["press", "release", "cancel"]);
const FIXED_LINK_IDS = new Set<string>(["product-feedback", "documentation"]);
const FORBIDDEN_IDENTITY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const FORBIDDEN_COMPOSER_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function isDedicatedHardwareCommandId(value: unknown): value is DedicatedHardwareCommandId {
  return typeof value === "string" && COMMAND_IDS.has(value);
}

export function parseDedicatedHardwareAction(value: unknown): DedicatedHardwareAction {
  if (!isRecord(value) || typeof value.kind !== "string") throw invalidAction();
  switch (value.kind) {
    case "command": {
      if (!hasExactKeys(value, ["kind", "command"])
        || !isDedicatedHardwareCommandId(value.command)) throw invalidAction();
      return Object.freeze({ kind: "command", command: value.command });
    }
    case "task": {
      if (!hasExactKeys(value, [
        "kind", "profileId", "serverId", "connectionGeneration", "snapshotRevision",
        "sessionId", "sessionGeneration", "targetId", "focusWindow"
      ])
        || !isBoundedIdentity(value.profileId, MAX_DEDICATED_HARDWARE_SERVER_ID_CHARACTERS)
        || !isBoundedIdentity(value.serverId, MAX_DEDICATED_HARDWARE_SERVER_ID_CHARACTERS)
        || !isDecimalGeneration(value.connectionGeneration)
        || !isDecimalGeneration(value.snapshotRevision)
        || !isBoundedIdentity(value.sessionId, MAX_DEDICATED_HARDWARE_ID_CHARACTERS)
        || !isDecimalGeneration(value.sessionGeneration)
        || !isBoundedIdentity(value.targetId, MAX_DEDICATED_HARDWARE_ID_CHARACTERS)
        || typeof value.focusWindow !== "boolean") throw invalidAction();
      return Object.freeze({
        kind: "task",
        profileId: value.profileId,
        serverId: value.serverId,
        connectionGeneration: value.connectionGeneration,
        snapshotRevision: value.snapshotRevision,
        sessionId: value.sessionId,
        sessionGeneration: value.sessionGeneration,
        targetId: value.targetId,
        focusWindow: value.focusWindow
      });
    }
    case "skill": {
      if (!hasExactKeys(value, ["kind", "serverId", "resourceId", "name"])
        || !isBoundedIdentity(value.serverId, MAX_DEDICATED_HARDWARE_SERVER_ID_CHARACTERS)
        || !isBoundedIdentity(value.resourceId, MAX_DEDICATED_HARDWARE_ID_CHARACTERS)
        || !isBoundedIdentity(value.name, MAX_DEDICATED_HARDWARE_NAME_CHARACTERS)) throw invalidAction();
      return Object.freeze({
        kind: "skill",
        serverId: value.serverId,
        resourceId: value.resourceId,
        name: value.name
      });
    }
    case "voice": {
      if (!hasExactKeys(value, ["kind"])) throw invalidAction();
      return Object.freeze({ kind: "voice" });
    }
    case "composer-text": {
      if (!hasExactKeys(value, ["kind", "text"]) || !isBoundedComposerText(value.text)) throw invalidAction();
      return Object.freeze({ kind: "composer-text", text: value.text });
    }
    case "fixed-link": {
      if (!hasExactKeys(value, ["kind", "linkId"])
        || typeof value.linkId !== "string"
        || !FIXED_LINK_IDS.has(value.linkId)) throw invalidAction();
      return Object.freeze({ kind: "fixed-link", linkId: value.linkId as DedicatedHardwareFixedLinkId });
    }
    default:
      throw invalidAction();
  }
}

export function parseDedicatedHardwareActionEvent(value: unknown): DedicatedHardwareActionEvent {
  if (!isRecord(value) || typeof value.kind !== "string") throw invalidEvent();
  if (value.kind === "button") {
    if (!hasExactKeys(value, ["kind", "phase", "action"])
      || typeof value.phase !== "string"
      || !BUTTON_PHASES.has(value.phase)) throw invalidEvent();
    let action: DedicatedHardwareAction;
    try {
      action = parseDedicatedHardwareAction(value.action);
    } catch {
      throw invalidEvent();
    }
    return Object.freeze({
      kind: "button",
      phase: value.phase as DedicatedHardwareActionPhase,
      action
    });
  }
  if (value.kind !== "scroll" || typeof value.phase !== "string") throw invalidEvent();
  if (value.phase === "release" || value.phase === "cancel") {
    if (!hasExactKeys(value, ["kind", "phase"])) throw invalidEvent();
    return Object.freeze({ kind: "scroll", phase: value.phase });
  }
  if ((value.phase !== "press" && value.phase !== "move")
    || !hasExactKeys(value, ["kind", "phase", "direction", "distance"])
    || (value.direction !== "up" && value.direction !== "down")
    || typeof value.distance !== "number"
    || !Number.isFinite(value.distance)
    || value.distance <= 0.5
    || value.distance > 1) throw invalidEvent();
  return Object.freeze({
    kind: "scroll",
    phase: value.phase,
    direction: value.direction,
    distance: value.distance
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedIdentity(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value.length <= maxCharacters
    && !hasLoneSurrogate(value)
    && !FORBIDDEN_IDENTITY_CHARACTERS.test(value);
}

function isDecimalGeneration(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isBoundedComposerText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value.length <= MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_CHARACTERS
    && !hasLoneSurrogate(value)
    && !FORBIDDEN_COMPOSER_CHARACTERS.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_UTF8_BYTES;
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
