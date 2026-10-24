import type { NativeTaskStatusSession, NativeTaskStatusSnapshot } from "@joko/contracts";

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
function phase(value: unknown): value is NativeTaskStatusSession["phase"] { return value === "running" || value === "interaction" || value === "completed" || value === "error"; }
function interactionKind(value: unknown): value is NonNullable<NativeTaskStatusSession["interactionKind"]> {
  return value === "permission" || value === "question" || value === "plan" || value === "select" || value === "confirm" || value === "input" || value === "editor";
}
