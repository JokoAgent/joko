import type { NativeTaskStatusSession, NativeTaskStatusSnapshot, MenubarSettings, MenubarSettingsPatch,
  MenubarView, MenubarState, DesktopMenubarSnapshot, DesktopMenubarAction, MenubarHelperMessage } from "@joko/contracts";

// Main uses this pure typed module directly. The preload build converts and
// inlines the same module without loading an ESM dependency in the sandbox.
const SESSION_LIMIT = 500 satisfies typeof import("@joko/contracts").NATIVE_TASK_STATUS_SESSION_LIMIT;

export function parseSnapshot(value: unknown): NativeTaskStatusSnapshot {
  if (!record(value) || !keys(value, ["locale", "ownerId", "revision", "sessions"]) ||
    !identity(value["ownerId"], 256) || !decimal(value["revision"]) ||
    (value["locale"] !== "en" && value["locale"] !== "zh-CN" && value["locale"] !== "en-XA") ||
    !Array.isArray(value["sessions"]) || value["sessions"].length > SESSION_LIMIT) {
    throw new TypeError("Native task-status snapshot is invalid.");
  }
  const seen = new Set<string>();
  const sessions = value["sessions"].map((raw) => {
    const session = parseSession(raw);
    if (seen.has(session.sessionId)) throw new TypeError("Native task-status task identities must be unique.");
    seen.add(session.sessionId);
    return session;
  });
  return Object.freeze({ ownerId: value["ownerId"], revision: value["revision"], locale: value["locale"], sessions: Object.freeze(sessions) });
}

function parseSession(value: unknown): NativeTaskStatusSession {
  if (!record(value) || !keys(value, ["activityLines", "detail", "phase", "sessionId", "title", "updatedAt"],
    ["interactionKind", "inputHandoff", "permission", "startedAt", "remote"]) ||
    !identity(value["sessionId"], 1024) || !display(value["title"], 160) || !display(value["detail"], 600) ||
    !phase(value["phase"]) || !timestamp(value["updatedAt"]) ||
    (value["startedAt"] !== undefined && !timestamp(value["startedAt"])) ||
    (value["interactionKind"] !== undefined && !interactionKind(value["interactionKind"])) ||
    (value["inputHandoff"] !== undefined && value["inputHandoff"] !== true) ||
    !Array.isArray(value["activityLines"]) || value["activityLines"].length > 3) {
    throw new TypeError("Native task-status task is invalid.");
  }
  const permission = value["permission"] === undefined ? undefined : parsePermission(value["permission"]);
  const remote = value["remote"] === undefined ? undefined : parseRemote(value["remote"]);
  if (remote && permission) throw new TypeError("Remote tasks cannot carry local permission actions.");
  if (permission && value["phase"] !== "interaction") throw new TypeError("Native task-status permission must belong to an interaction task.");
  if (value["inputHandoff"] && (value["phase"] !== "interaction" || permission || value["interactionKind"] !== undefined)) {
    throw new TypeError("A private input handoff cannot carry ordinary interaction decisions.");
  }
  return Object.freeze({ sessionId: value["sessionId"], title: value["title"], detail: value["detail"], phase: value["phase"],
    ...(value["interactionKind"] === undefined ? {} : { interactionKind: value["interactionKind"] }),
    ...(value["inputHandoff"] ? { inputHandoff: true as const } : {}),
    activityLines: Object.freeze(value["activityLines"].map(parseActivityLine)),
    ...(value["startedAt"] === undefined ? {} : { startedAt: value["startedAt"] }), updatedAt: value["updatedAt"],
    ...(permission === undefined ? {} : { permission }), ...(remote === undefined ? {} : { remote }) });
}

function parseRemote(value: unknown): NonNullable<NativeTaskStatusSession["remote"]> {
  if (!record(value) || !keys(value, ["sourceId", "runId", "silent", "completionNotification"], ["companion", "observedCompletionOnly"]) ||
    !identity(value["sourceId"], 1024) || !display(value["runId"], 256) || typeof value["silent"] !== "boolean" ||
    (value["observedCompletionOnly"] !== undefined && typeof value["observedCompletionOnly"] !== "boolean") ||
    (value["completionNotification"] !== "none" && value["completionNotification"] !== "pending" && value["completionNotification"] !== "teammate")) {
    throw new TypeError("Invalid remote task activity.");
  }
  const companion = value["companion"];
  if (companion !== undefined && (!record(companion) || !keys(companion, ["name", "glyph", "tint"], ["artwork"]) ||
    !display(companion["name"], 160) || !display(companion["glyph"], 8) || typeof companion["tint"] !== "string" ||
    !/^#[a-f0-9]{6}$/iu.test(companion["tint"]) || companion["artwork"] !== undefined &&
    (typeof companion["artwork"] !== "string" || companion["artwork"].length > 80_000 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(companion["artwork"])))) {
    throw new TypeError("Invalid remote companion identity.");
  }
  return Object.freeze({ sourceId: value["sourceId"], runId: value["runId"], silent: value["silent"], completionNotification: value["completionNotification"],
    ...(value["observedCompletionOnly"] === undefined ? {} : { observedCompletionOnly: value["observedCompletionOnly"] as boolean }),
    ...(companion === undefined ? {} : { companion: Object.freeze({ ...companion }) as NonNullable<NativeTaskStatusSession["remote"]>["companion"] }) });
}

function parseActivityLine(value: unknown): NativeTaskStatusSession["activityLines"][number] {
  if (!record(value) || !keys(value, ["id", "kind", "text"]) || !identity(value["id"], 256) || !display(value["text"], 300) ||
    (value["kind"] !== "user" && value["kind"] !== "assistant" && value["kind"] !== "status" && value["kind"] !== "tool")) {
    throw new TypeError("Native task-status activity line is invalid.");
  }
  return Object.freeze({ id: value["id"], kind: value["kind"], text: value["text"] });
}

function parsePermission(value: unknown): NonNullable<NativeTaskStatusSession["permission"]> {
  if (!record(value) || !keys(value, ["allow", "allowForSession", "deny", "generation", "interactionId"]) ||
    !identity(value["interactionId"], 256) || !decimal(value["generation"]) || typeof value["allow"] !== "boolean" ||
    typeof value["allowForSession"] !== "boolean" || typeof value["deny"] !== "boolean") {
    throw new TypeError("Native task-status permission is invalid.");
  }
  return Object.freeze({ interactionId: value["interactionId"], generation: value["generation"], allow: value["allow"],
    allowForSession: value["allowForSession"], deny: value["deny"] });
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function identity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function display(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
function decimal(value: unknown): value is string { return typeof value === "string" && value.length <= 64 && /^(?:0|[1-9][0-9]*)$/u.test(value); }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export function parseMenubarSettingsPatch(value: unknown): MenubarSettingsPatch {
  if (!record(value) || !keys(value, [], ["enabled", "order", "hidden", "shown", "statusText", "lowAlert", "privacy", "scope"])) {
    throw new TypeError("Invalid menu bar settings.");
  }
  for (const key of ["enabled", "lowAlert", "privacy"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new TypeError("Invalid menu bar preference.");
  }
  for (const key of ["order", "hidden", "shown"]) {
    const ids = value[key];
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 ||
      ids.some(id => !identity(id, 1024)) || new Set(ids).size !== ids.length)) throw new TypeError("Invalid menu bar source identities.");
  }
  if (value["statusText"] !== undefined && (typeof value["statusText"] !== "string" || !["icon", "lowest", "today", "task"].includes(value["statusText"])) ||
    value["scope"] !== undefined && value["scope"] !== "local" && value["scope"] !== "all") throw new TypeError("Invalid menu bar display preference.");
  return structuredClone(value) as MenubarSettingsPatch;
}

export function parseMenubarSettings(value: unknown): MenubarSettings {
  if (!record(value) || !keys(value, ["enabled", "order", "hidden", "shown", "statusText", "lowAlert", "privacy", "scope"]) ||
    ["enabled", "lowAlert", "privacy"].some(key => typeof value[key] !== "boolean") ||
    ["order", "hidden", "shown"].some(key => !Array.isArray(value[key])) ||
    typeof value["statusText"] !== "string" || typeof value["scope"] !== "string") {
    throw new TypeError("Incomplete menu bar settings.");
  }
  return parseMenubarSettingsPatch(value) as MenubarSettings;
}

export function parseMenubarState(value: unknown): MenubarState {
  if (!record(value) || !keys(value, ["available", "enabled", "settings"], ["error"]) ||
    typeof value["available"] !== "boolean" || typeof value["enabled"] !== "boolean" ||
    value["error"] !== undefined && value["error"] !== "helper") throw new TypeError("Invalid menu bar state.");
  const settings = parseMenubarSettings(value["settings"]);
  if (value["enabled"] !== settings.enabled) throw new TypeError("Inconsistent menu bar state.");
  return { available: value["available"], enabled: value["enabled"], settings, ...(value["error"] === "helper" ? { error: "helper" as const } : {}) };
}

/** Only a bounded presentation tree crosses the sandbox. No paths, SVG or executable actions. */
export function parseMenubarSnapshot(value: unknown): DesktopMenubarSnapshot {
  if (!record(value) || !keys(value, ["ownerId", "revision", "view"]) ||
    !identity(value["ownerId"], 256) || !decimal(value["revision"])) throw new TypeError("Invalid menu bar owner.");
  let nodes = 0;
  const bounded = (entry: unknown, depth: number): boolean => {
    if (++nodes > 40_000 || depth > 12) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry) && Math.abs(entry) <= Number.MAX_SAFE_INTEGER;
    if (typeof entry === "string") return display(entry, 4096);
    if (Array.isArray(entry)) return entry.length <= 500 && entry.every(child => bounded(child, depth + 1));
    return record(entry) && Object.keys(entry).length <= 500 && Object.entries(entry).every(([key, child]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && identity(key, 1024) &&
      (key !== "logoSvg" || child === "joko:mark") && bounded(child, depth + 1));
  };
  const view = value["view"];
  if (!record(view) || !keys(view, ["locale", "moneySymbol", "strings", "statusTextByMode", "updatedAtMs", "headlinePrimary",
    "headlineSecondary", "headlineAlert", "sources", "details", "taskSummary", "tasks", "usage", "manage", "settings"], ["gate"]) ||
    !bounded(view, 0) || JSON.stringify(view).length > 512_000 ||
    (view["locale"] !== "en" && view["locale"] !== "zh-CN" && view["locale"] !== "en-XA") || !display(view["moneySymbol"], 32) ||
    (view["gate"] !== undefined && view["gate"] !== "connection") ||
    !Array.isArray(view["sources"]) || !Array.isArray(view["tasks"]) || !Array.isArray(view["manage"]) ||
    !record(view["details"]) || !record(view["strings"]) || !record(view["usage"]) || !menuViewShape(view)) throw new TypeError("Invalid menu bar view.");
  parseMenubarSettings(view["settings"]);
  for (const entries of [view["sources"], view["manage"]]) {
    const seen = new Set<string>();
    for (const entry of entries as Record<string, unknown>[]) {
      if (!identity(entry["id"], 1024) || seen.has(entry["id"])) throw new TypeError("Invalid or repeated menu bar source identity.");
      seen.add(entry["id"]);
    }
  }
  const taskIds = new Set<string>();
  for (const task of view["tasks"]) {
    if (!record(task) || !identity(task["sessionId"], 1024) || taskIds.has(task["sessionId"]) || !display(task["title"], 4096)) {
      throw new TypeError("Invalid menu bar task.");
    }
    taskIds.add(task["sessionId"]);
  }
  for (const [id, detail] of Object.entries(view["details"])) {
    if (!identity(id, 1024) || !record(detail) || detail["id"] !== id || !record(detail["action"])) throw new TypeError("Invalid menu bar detail.");
    const action = detail["action"];
    if (!["new-task", "open-settings", "open-app", "none"].includes(String(action["kind"])) ||
      action["kind"] === "new-task" && !identity(action["providerId"], 1024)) throw new TypeError("Invalid menu bar action.");
  }
  return structuredClone(value) as unknown as DesktopMenubarSnapshot;
}

export function parseMenubarAction(value: unknown): DesktopMenubarAction {
  if (!record(value)) throw new TypeError("Invalid menu bar intent.");
  if (value["type"] === "refresh" || value["type"] === "open-provider-settings" || value["type"] === "low-alert") {
    if (keys(value, ["type"])) return { type: value["type"] };
  } else if ((value["type"] === "open-session" || value["type"] === "new-task") && keys(value, ["type", "id"]) && identity(value["id"], 1024)) {
    return { type: value["type"], id: value["id"] };
  }
  throw new TypeError("Invalid menu bar intent.");
}

export function parseMenubarHelperMessage(value: unknown): MenubarHelperMessage {
  if (!record(value)) throw new TypeError("Invalid menu bar helper message.");
  const type = value["type"];
  if ((type === "ready" || type === "refresh" || type === "retry-settings" || type === "open-app" || type === "open-provider-settings") && keys(value, ["type"])) return { type };
  if (type === "panel" && keys(value, ["type", "open"]) && typeof value["open"] === "boolean") return { type, open: value["open"] };
  if (type === "error" && keys(value, ["type", "message"]) && display(value["message"], 4096)) return { type, message: value["message"] };
  if (type === "settings" && keys(value, ["type", "patch"])) return { type, patch: parseMenubarSettingsPatch(value["patch"]) };
  if (type === "open-session" && keys(value, ["type", "sessionId"]) && identity(value["sessionId"], 1024)) return { type, sessionId: value["sessionId"] };
  if (type === "detail-action" && keys(value, ["type", "sourceId"], ["actionId"]) && identity(value["sourceId"], 1024)
    && (value["actionId"] === undefined || identity(value["actionId"], 1024))) return { type, sourceId: value["sourceId"],
      ...(value["actionId"] === undefined ? {} : { actionId: value["actionId"] }) };
  throw new TypeError("Invalid menu bar helper message.");
}

type MenuField = (value: unknown) => boolean;
function menuObject(fields: Readonly<Record<string, MenuField>>): MenuField {
  return value => record(value) && keys(value, Object.keys(fields)) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
const menuString: MenuField = value => typeof value === "string";
const menuBoolean: MenuField = value => typeof value === "boolean";
const menuNumber: MenuField = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const menuArray = (field: MenuField): MenuField => value => Array.isArray(value) && value.every(field);
const menuNullable = (field: MenuField): MenuField => value => value === null || field(value);
const menuChoice = (...choices: string[]): MenuField => value => typeof value === "string" && choices.includes(value);
const menuRecord = (field: MenuField): MenuField => value => record(value) && Object.values(value).every(field);
const menuColor = menuChoice("ink", "ink2", "ink3", "fill", "warn", "error", "claude", "claude2", "claude3", "codex", "pi");
const menuLevel = menuChoice("normal", "warn", "error");
const menuHarness = menuChoice("first", "second", "other");
const menuFraction: MenuField = value => menuNumber(value) && (value as number) <= 1;
const menuAction: MenuField = value => record(value) && (value["kind"] === "new-task"
  ? keys(value, ["kind", "providerId"]) && identity(value["providerId"], 1024)
  : keys(value, ["kind"]) && menuChoice("none", "open-app", "open-settings")(value["kind"]));
const menuCell = menuObject({ id: menuString, kind: menuChoice("subscription", "balance", "payg"), logoSvg: menuString,
  name: menuString, value: menuNullable(menuString), valueUnit: menuNullable(menuString), valueLabel: menuNullable(menuString),
  level: menuLevel, fill: menuNullable(menuFraction), reserve: menuBoolean, emphasized: menuBoolean, active: menuBoolean,
  when: menuString, whenLevel: menuLevel, accessibilityLabel: menuString });
const menuDetail = menuObject({ id: menuString, logoSvg: menuString, title: menuString, plan: menuString,
  rings: menuArray(menuObject({ fraction: menuFraction, color: menuColor })), bigValue: menuString,
  bigUnit: menuNullable(menuString), bigColor: menuNullable(menuColor), bigCompact: menuBoolean, bigCaption: menuString,
  legend: menuArray(menuObject({ label: menuString, color: menuColor })), sayPrimary: menuString, saySecondary: menuNullable(menuString),
  facts: menuArray(menuObject({ label: menuString, value: menuString, sub: menuString })), actionLabel: menuString, action: menuAction });
const menuTask = menuObject({ sessionId: menuString, title: menuString, harness: menuHarness, logoSvg: menuString,
  value: menuNumber, tokens: menuNumber, running: menuBoolean, startedAtMs: menuNullable(timestamp), idleStatus: menuString, meta: menuString });
const menuModel = menuObject({ name: menuString, harness: menuHarness, money: menuNumber, tokens: menuNumber });
const menuTriple: MenuField = value => Array.isArray(value) && value.length === 3 && value.every(menuNumber);
const menuUsageScope = menuObject({ daily: menuArray(menuObject({ money: menuTriple, paid: menuNumber, tokens: menuTriple })),
  models: menuObject({ "7": menuArray(menuModel), "30": menuArray(menuModel), "90": menuArray(menuModel) }), note: menuString });
function menuViewShape(view: Record<string, unknown>): boolean {
  return menuString(view["headlinePrimary"]) && menuNullable(menuString)(view["headlineSecondary"]) &&
    menuBoolean(view["headlineAlert"]) && menuString(view["taskSummary"]) && menuNullable(timestamp)(view["updatedAtMs"]) &&
    menuRecord(menuString)(view["strings"]) && menuObject({ icon: menuNullable(menuString), lowest: menuNullable(menuString),
      today: menuNullable(menuString), task: menuNullable(menuString) })(view["statusTextByMode"]) &&
    menuArray(menuCell)(view["sources"]) && menuRecord(menuDetail)(view["details"]) && menuArray(menuTask)(view["tasks"]) &&
    menuArray(menuObject({ id: menuString, logoSvg: menuString, title: menuString, subtitle: menuString, value: menuString, hidden: menuBoolean }))(view["manage"]) &&
    menuObject({ days: menuArray(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)),
      scopes: menuObject({ local: menuUsageScope, all: menuUsageScope }) })(view["usage"]);
}
function phase(value: unknown): value is NativeTaskStatusSession["phase"] { return value === "running" || value === "interaction" || value === "completed" || value === "error"; }
function interactionKind(value: unknown): value is NonNullable<NativeTaskStatusSession["interactionKind"]> {
  return value === "permission" || value === "question" || value === "plan" || value === "select" || value === "confirm" || value === "input" || value === "editor";
}
