import { isJsonObject, type JsonValue } from "./protocol.js";

const MAXIMUM_FILE_CHANGES = 256;
const MAXIMUM_FILE_CHANGE_PATH_CHARS = 4_096;
const MAXIMUM_FILE_CHANGE_KIND_CHARS = 128;
const MAXIMUM_FILE_CHANGE_PAYLOAD_CHARS = 1_048_576;

export const CODEX_FILE_CHANGE_FALLBACK = "Workspace file change (structured payload unavailable).";

export interface CodexFileChangeProjection {
  readonly input: string;
  readonly summary: string;
}

interface NormalizedFileChange {
  readonly path: string;
  readonly kind: {
    readonly type: string;
    readonly movePath?: string;
  };
  readonly diff: string;
}

/**
 * Preserves one complete native fileChange item as deterministic, bounded JSON.
 * Any malformed or oversized member rejects the whole structured projection so
 * clients never mistake a partial list for the files the native runtime changed.
 */
export function projectCodexFileChanges(
  value: JsonValue | undefined,
  sanitizeText: (value: string, limit: number) => string
): CodexFileChangeProjection | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_FILE_CHANGES) return undefined;
  const changes: NormalizedFileChange[] = [];
  for (const raw of value) {
    if (!isJsonObject(raw)) return undefined;
    const path = boundedIdentity(raw["path"], MAXIMUM_FILE_CHANGE_PATH_CHARS, sanitizeText);
    const diff = typeof raw["diff"] === "string" ? raw["diff"] : undefined;
    const kind = nativeKind(raw["kind"]);
    if (path === undefined || path === null || diff === undefined || kind === undefined) return undefined;
    if (diff.length > MAXIMUM_FILE_CHANGE_PAYLOAD_CHARS) return undefined;
    const movePath = boundedIdentity(
      kind.record["move_path"]
        ?? kind.record["movePath"]
        ?? raw["move_path"]
        ?? raw["movePath"],
      MAXIMUM_FILE_CHANGE_PATH_CHARS,
      sanitizeText,
      true
    );
    if (movePath === null) return undefined;
    changes.push({
      path,
      kind: {
        type: sanitizeText(kind.type, MAXIMUM_FILE_CHANGE_KIND_CHARS),
        ...(movePath === undefined ? {} : { movePath })
      },
      diff: sanitizeText(diff, MAXIMUM_FILE_CHANGE_PAYLOAD_CHARS)
    });
  }
  const input = JSON.stringify({ changes });
  if (input.length > MAXIMUM_FILE_CHANGE_PAYLOAD_CHARS) return undefined;
  return {
    input,
    summary: changes.map((change) => {
      const action = change.kind.movePath === undefined ? change.kind.type : "move";
      return change.kind.movePath === undefined
        ? `${action}: ${change.path}`
        : `${action}: ${change.path} -> ${change.kind.movePath}`;
    }).join("\n")
  };
}

function nativeKind(value: JsonValue | undefined): {
  readonly type: string;
  readonly record: Readonly<Record<string, JsonValue>>;
} | undefined {
  if (!isJsonObject(value)) return undefined;
  const type = value["type"];
  return typeof type === "string" && validIdentity(type, MAXIMUM_FILE_CHANGE_KIND_CHARS)
    ? { type, record: value }
    : undefined;
}

function boundedIdentity(
  value: JsonValue | undefined,
  limit: number,
  sanitizeText: (value: string, limit: number) => string,
  optional = false
): string | undefined | null {
  if (value === undefined || value === null) return optional ? undefined : null;
  if (typeof value !== "string" || !validIdentity(value, limit)) return null;
  const sanitized = sanitizeText(value, limit);
  return validIdentity(sanitized, limit + 64) ? sanitized : null;
}

function validIdentity(value: string, limit: number): boolean {
  return value.trim() !== "" && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}
