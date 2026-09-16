export type ToolPresentationAction =
  | "runCommand"
  | "readFile"
  | "editFile"
  | "createFile"
  | "listFiles"
  | "searchFiles"
  | "searchWeb"
  | "fetchWeb"
  | "delegateTask"
  | "manageTask"
  | "updatePlan"
  | "callTool";

export interface ToolPresentation {
  readonly action: ToolPresentationAction;
  readonly primary?: string;
}

const MAXIMUM_SUMMARY_INPUT_CHARS = 65_536;
const MAXIMUM_SELECTED_VALUE_CHARS = 16_384;
const MAXIMUM_PRIMARY_CHARS = 120;
const REDACTED_VALUE = /\[REDACTED\]|payload withheld/iu;
const KNOWN_TOOL_NAMES = new Set([
  "command", "Shell", "Bash", "bash",
  "Read", "read", "joko_read", "Edit", "MultiEdit", "edit", "Write", "write", "ls", "joko_ls",
  "Grep", "grep", "joko_grep", "Glob", "find", "joko_find",
  "WebSearch", "web_search", "WebFetch", "TodoWrite", "update_plan",
  "collaboration", "Task", "Agent", "subagent", "subagent_status", "mcp__joko_managed_subagent__delegate"
]);

/**
 * Decodes the two current ToolCall display shapes: durable message input is the
 * native value, while live ToolCall arguments carry the root-field `$:` label.
 * No JSON recovery or legacy-shape guessing is performed.
 */
export function parseToolDisplayInput(input: string, maximumChars = MAXIMUM_SUMMARY_INPUT_CHARS): unknown {
  const payload = toolDisplayPayload(input, maximumChars);
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function toolDisplayPayload(input: string, maximumChars = MAXIMUM_SUMMARY_INPUT_CHARS): string | undefined {
  if (input.length === 0 || input.length > maximumChars + 3) return undefined;
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const payload = trimmed.startsWith("$: ") ? trimmed.slice(3).trim() : trimmed;
  if (payload === "" || payload.length > maximumChars) return undefined;
  return payload;
}

/** Returns a bounded, capability-neutral heading for recognized current tools. */
export function describeToolPresentation(toolName: string, input: string): ToolPresentation | undefined {
  if (toolName.length === 0 || toolName.length > 512 || /[\u0000-\u001f\u007f]/u.test(toolName)) return undefined;
  const namespaced = namespacedToolIdentity(toolName);
  if (!KNOWN_TOOL_NAMES.has(toolName) && namespaced === undefined) return undefined;
  const payload = toolDisplayPayload(input);
  if (payload === undefined) return undefined;

  if (toolName === "command" || toolName === "Shell") {
    const command = selectedText(payload);
    return command === undefined ? undefined : { action: "runCommand", primary: command };
  }
  if (toolName === "collaboration") {
    const task = selectedText(payload);
    return task === undefined ? undefined : { action: "delegateTask", primary: task };
  }
  if (toolName === "web_search") {
    const target = selectedText(payload);
    return target === undefined ? undefined : { action: "searchWeb", primary: target };
  }

  const value = parseToolDisplayInput(input);
  const record = asRecord(value);

  if (toolName === "Bash" || toolName === "bash") {
    const command = selectedText(record?.["command"]);
    if (command === undefined) return undefined;
    return { action: "runCommand", primary: selectedText(record?.["description"]) ?? command };
  }

  if (["Read", "read", "joko_read"].includes(toolName)) {
    return filePresentation("readFile", record);
  }
  if (["Edit", "MultiEdit", "edit"].includes(toolName)) {
    return filePresentation("editFile", record);
  }
  if (["Write", "write"].includes(toolName)) {
    return filePresentation("createFile", record);
  }
  if (["ls", "joko_ls"].includes(toolName)) {
    return filePresentation("listFiles", record, true);
  }
  if (["Grep", "grep", "joko_grep", "Glob", "find", "joko_find"].includes(toolName)) {
    const pattern = firstSelected(record, ["pattern", "query", "glob"]);
    return pattern === undefined ? undefined : { action: "searchFiles", primary: pattern };
  }
  if (toolName === "WebSearch") {
    const target = selectedText(record?.["query"]);
    return target === undefined ? undefined : { action: "searchWeb", primary: target };
  }
  if (toolName === "WebFetch") {
    const target = selectedText(record?.["url"]);
    return target === undefined ? undefined : { action: "fetchWeb", primary: target };
  }
  if (toolName === "TodoWrite" || toolName === "update_plan") {
    return record === undefined ? undefined : { action: "updatePlan" };
  }

  if (toolName === "Task" || toolName === "Agent" || toolName === "subagent"
    || toolName === "mcp__joko_managed_subagent__delegate") {
    const operation = toolName === "subagent" ? selectedText(record?.["action"]) : undefined;
    if (operation !== undefined && operation !== "run") return { action: "manageTask", primary: operation };
    const task = delegatedTaskPrimary(record);
    return task === undefined ? undefined : { action: "delegateTask", primary: task };
  }
  if (toolName === "subagent_status") {
    const action = selectedText(record?.["action"]);
    const taskId = selectedText(record?.["taskId"]);
    if (action === undefined && taskId === undefined) return undefined;
    return { action: "manageTask", primary: [action, taskId].filter((part) => part !== undefined).join(" · ") };
  }

  if (namespaced === undefined || (record === undefined && value !== null)) return undefined;
  const detail = firstSelected(record, ["description", "query", "path", "file_path", "url", "title", "name", "prompt"]);
  return {
    action: "callTool",
    primary: boundedPrimary(detail === undefined ? namespaced : `${namespaced} — ${detail}`)
  };
}

function filePresentation(
  action: Extract<ToolPresentationAction, "readFile" | "editFile" | "createFile" | "listFiles">,
  record: Readonly<Record<string, unknown>> | undefined,
  allowDefault = false
): ToolPresentation | undefined {
  const path = firstSelected(record, ["file_path", "path"]);
  if (path === undefined) return allowDefault && record !== undefined ? { action } : undefined;
  return { action, primary: path };
}

function namespacedToolIdentity(toolName: string): string | undefined {
  if (toolName.startsWith("mcp__")) {
    const segments = toolName.slice(5).split("__");
    if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return undefined;
    const server = humanize(segments[0]!);
    const tool = humanize(segments.slice(1).join("__"));
    return server === "" || tool === "" ? undefined : boundedPrimary(`${server} · ${tool}`);
  }
  const separator = toolName.indexOf("/");
  if (separator <= 0 || separator === toolName.length - 1 || toolName.indexOf("/", separator + 1) >= 0) return undefined;
  const namespace = humanize(toolName.slice(0, separator));
  const tool = humanize(toolName.slice(separator + 1));
  return namespace === "" || tool === "" ? undefined : boundedPrimary(`${namespace} · ${tool}`);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function firstSelected(record: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
  return selectedText(firstValue(record, keys));
}

function delegatedTaskPrimary(record: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const direct = firstSelected(record, ["title", "description", "task", "prompt"]);
  if (direct !== undefined) return direct;
  const tasks = record?.["tasks"];
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 8) return undefined;
  const first = firstSelected(asRecord(tasks[0]), ["title", "description", "task", "prompt"]);
  if (first === undefined) return undefined;
  return tasks.length === 1 ? first : boundedPrimary(`${first} · +${tasks.length - 1}`);
}

function firstValue(record: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): unknown {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function selectedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_SELECTED_VALUE_CHARS
    || REDACTED_VALUE.test(value) || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized === "" ? undefined : boundedPrimary(normalized);
}

function boundedPrimary(value: string): string {
  const characters = [...value];
  if (characters.length <= MAXIMUM_PRIMARY_CHARS) return value;
  return `${characters.slice(0, MAXIMUM_PRIMARY_CHARS - 1).join("").trimEnd()}…`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
