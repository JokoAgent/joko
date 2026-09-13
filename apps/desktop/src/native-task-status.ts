import type {
  DesktopLocale,
  DesktopNativeTaskStatusDecision,
  DesktopNativeTaskStatusDisplay,
  DesktopNativeTaskStatusPermission,
  DesktopNativeTaskStatusSoundChoice,
  DesktopNativeTaskStatusSoundEvent,
  DesktopNativeTaskStatusSoundId,
  DesktopNativeTaskStatusSession,
  DesktopNativeTaskStatusSettings,
  DesktopNativeTaskStatusSnapshot
} from "./channels.js";
import { isDesktopLocale } from "./channels.js";

export const NATIVE_TASK_STATUS_MIN_DARWIN_MAJOR = 23;
export const MAXIMUM_NATIVE_TASK_STATUS_SESSIONS = 64;
export const MAXIMUM_NATIVE_TASK_STATUS_VISIBLE_SESSIONS = 8;
export const DESKTOP_NATIVE_TASK_STATUS_SOUND_EVENTS = Object.freeze([
  "start", "attention", "complete", "error", "select"
] as const satisfies readonly DesktopNativeTaskStatusSoundEvent[]);
export const DESKTOP_NATIVE_TASK_STATUS_SOUND_OPTIONS = Object.freeze([
  "none", "startup-chime", "ring-chime", "item-found", "gem-collect", "item-fanfare",
  "victory-fanfare", "error-buzz", "secret-chime"
] as const satisfies readonly DesktopNativeTaskStatusSoundId[]);

export interface DesktopNativeTaskStatusSurface {
  readonly mode: "closed" | "compact" | "expanded";
  readonly policy: "closed" | "peek" | "blocking" | "transient" | "manual";
  readonly current?: DesktopNativeTaskStatusSession;
  readonly sessions: readonly DesktopNativeTaskStatusSession[];
  readonly counts: {
    readonly total: number;
    readonly running: number;
    readonly interaction: number;
    readonly completed: number;
    readonly error: number;
  };
}

export function isNativeTaskStatusSupported(platform: string | undefined, osRelease: string | undefined): boolean {
  if (platform !== "darwin" || osRelease === undefined) return false;
  const major = Number.parseInt(osRelease.split(".")[0] ?? "", 10);
  return Number.isSafeInteger(major) && major >= NATIVE_TASK_STATUS_MIN_DARWIN_MAJOR;
}

export function isNativeTaskStatusAvailable(options: {
  readonly platform: string | undefined;
  readonly osRelease: string | undefined;
  readonly packaged: boolean;
  readonly developmentPreviewRequested: boolean;
}): boolean {
  return isNativeTaskStatusSupported(options.platform, options.osRelease) ||
    (!options.packaged && options.developmentPreviewRequested);
}

export function defaultDesktopNativeTaskStatusSettings(): DesktopNativeTaskStatusSettings {
  return Object.freeze({
    enabled: false,
    display: Object.freeze({ mode: "all" }),
    layout: "normal",
    sounds: defaultDesktopNativeTaskStatusSounds()
  });
}

export function defaultDesktopNativeTaskStatusSounds(): DesktopNativeTaskStatusSettings["sounds"] {
  return Object.freeze({
    enabled: true,
    sounds: Object.freeze({
      start: Object.freeze({ type: "builtin", id: "startup-chime" }),
      attention: Object.freeze({ type: "builtin", id: "secret-chime" }),
      complete: Object.freeze({ type: "builtin", id: "gem-collect" }),
      error: Object.freeze({ type: "builtin", id: "error-buzz" }),
      select: Object.freeze({ type: "builtin", id: "none" })
    })
  });
}

export function parseDesktopNativeTaskStatusSettings(value: unknown): DesktopNativeTaskStatusSettings {
  if (!isRecord(value) || !hasExactKeys(value, ["display", "enabled", "layout", "sounds"]) ||
    typeof value["enabled"] !== "boolean" ||
    (value["layout"] !== "compact" && value["layout"] !== "normal")) {
    throw new TypeError("Native task-status settings are invalid.");
  }
  const display = parseDisplayTarget(value["display"]);
  const sounds = parseSoundSettings(value["sounds"]);
  if (sounds === undefined) {
    throw new TypeError("Native task-status sound settings are invalid.");
  }
  return Object.freeze({
    enabled: value["enabled"],
    display,
    layout: value["layout"],
    sounds
  });
}

export function parseDesktopNativeTaskStatusSoundChoice(value: unknown): DesktopNativeTaskStatusSoundChoice {
  if (!isRecord(value)) throw new TypeError("Native task-status sound choice is invalid.");
  if (value["type"] === "builtin" && hasExactKeys(value, ["id", "type"]) && isSoundId(value["id"])) {
    return Object.freeze({ type: "builtin", id: value["id"] });
  }
  if (value["type"] === "custom" && hasExactKeys(value, ["name", "path", "type"]) &&
    isBoundedPath(value["path"]) && isDisplayText(value["name"], 256) && value["name"].trim().length > 0) {
    return Object.freeze({ type: "custom", path: value["path"], name: value["name"].trim() });
  }
  throw new TypeError("Native task-status sound choice is invalid.");
}

export function isSilentDesktopNativeTaskStatusSound(choice: DesktopNativeTaskStatusSoundChoice): boolean {
  return choice.type === "builtin" && choice.id === "none";
}

export function parseDesktopNativeTaskStatusSnapshot(value: unknown): DesktopNativeTaskStatusSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ["locale", "ownerId", "revision", "sessions"]) ||
    !isBoundedText(value["ownerId"], 256) || !isDecimalFence(value["revision"]) ||
    !isDesktopLocale(value["locale"]) || !Array.isArray(value["sessions"]) ||
    value["sessions"].length > MAXIMUM_NATIVE_TASK_STATUS_SESSIONS) {
    throw new TypeError("Native task-status snapshot is invalid.");
  }
  const seen = new Set<string>();
  const sessions = value["sessions"].map((raw) => {
    const session = parseSession(raw);
    if (seen.has(session.sessionId)) throw new TypeError("Native task-status task identities must be unique.");
    seen.add(session.sessionId);
    return session;
  });
  return Object.freeze({
    ownerId: value["ownerId"],
    revision: value["revision"],
    locale: value["locale"],
    sessions: Object.freeze(sessions)
  });
}

export function parseDesktopNativeTaskStatusVisibleSessionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_NATIVE_TASK_STATUS_VISIBLE_SESSIONS) {
    throw new TypeError("Native task-status visible task identities are invalid.");
  }
  const seen = new Set<string>();
  const sessionIds = value.map((sessionId) => {
    if (!isBoundedText(sessionId, 256) || seen.has(sessionId)) {
      throw new TypeError("Native task-status visible task identities are invalid.");
    }
    seen.add(sessionId);
    return sessionId;
  });
  return Object.freeze(sessionIds);
}

export function projectDesktopNativeTaskStatusSurface(
  snapshot: DesktopNativeTaskStatusSnapshot,
  options: { readonly manualExpanded?: boolean; readonly suppressTransient?: boolean } = {}
): DesktopNativeTaskStatusSurface {
  const sessions = Object.freeze([...snapshot.sessions].sort(compareSessions));
  const counts = Object.freeze({
    total: sessions.length,
    running: sessions.filter((session) => session.phase === "running").length,
    interaction: sessions.filter((session) => session.phase === "interaction").length,
    completed: sessions.filter((session) => session.phase === "completed").length,
    error: sessions.filter((session) => session.phase === "error").length
  });
  const current = sessions[0];
  if (current === undefined) return Object.freeze({ mode: "closed", policy: "closed", sessions, counts });
  if (options.manualExpanded === true) {
    return Object.freeze({ mode: "expanded", policy: "manual", current, sessions, counts });
  }
  const blocking = sessions.find((session) => session.phase === "interaction");
  if (blocking !== undefined) {
    return Object.freeze({ mode: "expanded", policy: "blocking", current: blocking, sessions, counts });
  }
  const transient = sessions.find((session) => session.phase === "error" || session.phase === "completed");
  if (transient !== undefined && options.suppressTransient !== true) {
    return Object.freeze({ mode: "expanded", policy: "transient", current: transient, sessions, counts });
  }
  return Object.freeze({ mode: "compact", policy: "peek", current, sessions, counts });
}

export function nativeTaskStatusPermissionDecisionAllowed(
  session: DesktopNativeTaskStatusSession,
  decision: DesktopNativeTaskStatusDecision
): boolean {
  const permission = session.permission;
  if (session.phase !== "interaction" || permission === undefined) return false;
  if (decision === "allow") return permission.allow;
  if (decision === "allowForSession") return permission.allowForSession;
  return permission.deny;
}

export function sameNativeTaskStatusSnapshotFence(
  left: Pick<DesktopNativeTaskStatusSnapshot, "ownerId" | "revision">,
  right: Pick<DesktopNativeTaskStatusSnapshot, "ownerId" | "revision">
): boolean {
  return left.ownerId === right.ownerId && left.revision === right.revision;
}

export function isNewerNativeTaskStatusSnapshot(
  current: Pick<DesktopNativeTaskStatusSnapshot, "ownerId" | "revision"> | undefined,
  incoming: Pick<DesktopNativeTaskStatusSnapshot, "ownerId" | "revision">
): boolean {
  if (current === undefined || current.ownerId !== incoming.ownerId) return true;
  return BigInt(incoming.revision) >= BigInt(current.revision);
}

function parseDisplayTarget(value: unknown): DesktopNativeTaskStatusSettings["display"] {
  if (!isRecord(value)) throw new TypeError("Native task-status display setting is invalid.");
  if (value["mode"] === "all" && hasExactKeys(value, ["mode"])) return Object.freeze({ mode: "all" });
  if (value["mode"] === "display" &&
    hasOnlyKeys(value, ["displayId", "mode"], ["displayBounds", "displayIndex", "displayName"]) &&
    Object.hasOwn(value, "displayId") && Object.hasOwn(value, "mode") &&
    typeof value["displayId"] === "number" && Number.isSafeInteger(value["displayId"]) &&
    (value["displayName"] === undefined || isDisplayText(value["displayName"], 160)) &&
    (value["displayIndex"] === undefined || typeof value["displayIndex"] === "number" &&
      Number.isSafeInteger(value["displayIndex"]) && value["displayIndex"] >= 0)) {
    const displayBounds = value["displayBounds"] === undefined ? undefined : parseDisplayBounds(value["displayBounds"]);
    return Object.freeze({
      mode: "display",
      displayId: value["displayId"],
      ...(value["displayName"] === undefined ? {} : { displayName: value["displayName"] }),
      ...(value["displayIndex"] === undefined ? {} : { displayIndex: value["displayIndex"] }),
      ...(displayBounds === undefined ? {} : { displayBounds })
    });
  }
  throw new TypeError("Native task-status display setting is invalid.");
}

function parseSoundSettings(value: unknown): DesktopNativeTaskStatusSettings["sounds"] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["enabled", "sounds"]) || typeof value["enabled"] !== "boolean" ||
    !isRecord(value["sounds"]) || !hasExactKeys(value["sounds"], DESKTOP_NATIVE_TASK_STATUS_SOUND_EVENTS)) {
    return undefined;
  }
  const rawSounds = value["sounds"];
  try {
    const parsed = Object.fromEntries(DESKTOP_NATIVE_TASK_STATUS_SOUND_EVENTS.map((event) => [
      event,
      parseDesktopNativeTaskStatusSoundChoice(rawSounds[event])
    ])) as Record<DesktopNativeTaskStatusSoundEvent, DesktopNativeTaskStatusSoundChoice>;
    return Object.freeze({ enabled: value["enabled"], sounds: Object.freeze(parsed) });
  } catch {
    return undefined;
  }
}

function parseSession(value: unknown): DesktopNativeTaskStatusSession {
  if (!isRecord(value)) throw new TypeError("Native task-status task is invalid.");
  const required = ["activityLines", "detail", "phase", "sessionId", "title", "updatedAt"];
  const optional = ["interactionKind", "permission", "startedAt"];
  if (!hasOnlyKeys(value, required, optional) || !required.every((key) => Object.hasOwn(value, key)) ||
    !isBoundedText(value["sessionId"], 256) || !isDisplayText(value["title"], 160) ||
    !isDisplayText(value["detail"], 600) || !isPhase(value["phase"]) || !isTimestamp(value["updatedAt"]) ||
    (value["startedAt"] !== undefined && !isTimestamp(value["startedAt"])) ||
    (value["interactionKind"] !== undefined && !isInteractionKind(value["interactionKind"])) ||
    !Array.isArray(value["activityLines"]) || value["activityLines"].length > 3) {
    throw new TypeError("Native task-status task is invalid.");
  }
  const activityLines = Object.freeze(value["activityLines"].map(parseActivityLine));
  const permission = value["permission"] === undefined ? undefined : parsePermission(value["permission"]);
  if (permission !== undefined && value["phase"] !== "interaction") {
    throw new TypeError("Native task-status permission must belong to an interaction task.");
  }
  return Object.freeze({
    sessionId: value["sessionId"],
    title: value["title"],
    detail: value["detail"],
    phase: value["phase"],
    ...(value["interactionKind"] === undefined ? {} : { interactionKind: value["interactionKind"] }),
    activityLines,
    ...(value["startedAt"] === undefined ? {} : { startedAt: value["startedAt"] }),
    updatedAt: value["updatedAt"],
    ...(permission === undefined ? {} : { permission })
  });
}

function parseActivityLine(value: unknown): DesktopNativeTaskStatusSession["activityLines"][number] {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "kind", "text"]) ||
    !isBoundedText(value["id"], 256) || !isDisplayText(value["text"], 300) ||
    (value["kind"] !== "user" && value["kind"] !== "assistant" && value["kind"] !== "status" && value["kind"] !== "tool")) {
    throw new TypeError("Native task-status activity line is invalid.");
  }
  return Object.freeze({ id: value["id"], kind: value["kind"], text: value["text"] });
}

function parseDisplayBounds(value: unknown): DesktopNativeTaskStatusDisplay["bounds"] {
  if (!isRecord(value) || !hasExactKeys(value, ["height", "width", "x", "y"]) ||
    ![value["x"], value["y"], value["width"], value["height"]].every((part) =>
      typeof part === "number" && Number.isSafeInteger(part)) ||
    (value["width"] as number) <= 0 || (value["height"] as number) <= 0) {
    throw new TypeError("Native task-status display bounds are invalid.");
  }
  return Object.freeze({
    x: value["x"] as number,
    y: value["y"] as number,
    width: value["width"] as number,
    height: value["height"] as number
  });
}

function parsePermission(value: unknown): DesktopNativeTaskStatusPermission {
  if (!isRecord(value) || !hasExactKeys(value, ["allow", "allowForSession", "deny", "generation", "interactionId"]) ||
    !isBoundedText(value["interactionId"], 256) || !isDecimalFence(value["generation"]) ||
    typeof value["allow"] !== "boolean" || typeof value["allowForSession"] !== "boolean" ||
    typeof value["deny"] !== "boolean") {
    throw new TypeError("Native task-status permission is invalid.");
  }
  return Object.freeze({
    interactionId: value["interactionId"],
    generation: value["generation"],
    allow: value["allow"],
    allowForSession: value["allowForSession"],
    deny: value["deny"]
  });
}

function compareSessions(left: DesktopNativeTaskStatusSession, right: DesktopNativeTaskStatusSession): number {
  const priority = phasePriority(left.phase) - phasePriority(right.phase);
  if (priority !== 0) return priority;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return left.sessionId.localeCompare(right.sessionId);
}

function phasePriority(phase: DesktopNativeTaskStatusSession["phase"]): number {
  if (phase === "interaction") return 0;
  if (phase === "error") return 1;
  if (phase === "completed") return 2;
  return 3;
}

function isPhase(value: unknown): value is DesktopNativeTaskStatusSession["phase"] {
  return value === "running" || value === "interaction" || value === "completed" || value === "error";
}

function isInteractionKind(value: unknown): value is NonNullable<DesktopNativeTaskStatusSession["interactionKind"]> {
  return value === "permission" || value === "question" || value === "plan" || value === "select" ||
    value === "confirm" || value === "input" || value === "editor";
}

function isSoundId(value: unknown): value is DesktopNativeTaskStatusSoundId {
  return typeof value === "string" && (DESKTOP_NATIVE_TASK_STATUS_SOUND_OPTIONS as readonly string[]).includes(value);
}

function isDecimalFence(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isDisplayText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isBoundedPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 2048 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key));
}
