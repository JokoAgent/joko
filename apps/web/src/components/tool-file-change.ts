export type ToolFileChangeAction = "created" | "deleted" | "updated" | "moved" | "unknown";

export interface ToolFileChangeView {
  readonly id: string;
  readonly action: ToolFileChangeAction;
  readonly path: string;
  readonly movePath?: string;
  readonly diff: string;
}

export interface ToolFileChangeSetView {
  readonly changes: readonly ToolFileChangeView[];
}

const MAXIMUM_PAYLOAD_CHARS = 1_048_576;
const MAXIMUM_CHANGES = 256;
const MAXIMUM_PATH_CHARS = 4_096;

/** Strictly projects the capability-neutral file_change display payload. */
export function parseToolFileChangeSet(toolName: string, input: string): ToolFileChangeSetView | undefined {
  if (toolName !== "file_change" || input.length === 0 || input.length > MAXIMUM_PAYLOAD_CHARS) return undefined;
  let root: unknown;
  try {
    root = JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(root) || !Array.isArray(root["changes"]) || root["changes"].length === 0
    || root["changes"].length > MAXIMUM_CHANGES) return undefined;
  const changes: ToolFileChangeView[] = [];
  for (const [index, raw] of root["changes"].entries()) {
    if (!isRecord(raw)) return undefined;
    const path = identity(raw["path"]);
    const kindRecord = isRecord(raw["kind"]) ? raw["kind"] : undefined;
    const kindType = identity(kindRecord?.["type"]);
    const diff = raw["diff"];
    if (path === undefined || kindType === undefined || typeof diff !== "string") return undefined;
    const rawMovePath = kindRecord?.["movePath"] ?? kindRecord?.["move_path"] ?? raw["movePath"] ?? raw["move_path"];
    const movePath = rawMovePath === undefined ? undefined : identity(rawMovePath);
    if (rawMovePath !== undefined && movePath === undefined) return undefined;
    const action: ToolFileChangeAction = movePath !== undefined
      ? "moved"
      : kindType === "add"
        ? "created"
        : kindType === "delete"
          ? "deleted"
          : kindType === "update"
            ? "updated"
            : "unknown";
    changes.push({
      id: JSON.stringify([index, path, movePath ?? ""]),
      action,
      path,
      ...(movePath === undefined ? {} : { movePath }),
      diff
    });
  }
  return { changes };
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAXIMUM_PATH_CHARS
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
