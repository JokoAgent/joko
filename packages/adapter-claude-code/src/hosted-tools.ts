import { randomUUID } from "node:crypto";
import { assertHostedExecution, type HostedExecution } from "@joko/core";
import type { ClaudeSdkMcpTool } from "./sdk-runtime.js";

export const CLAUDE_HOSTED_EXECUTOR_SERVER = "joko_source_exec";
export const CLAUDE_HOSTED_FILE_TOOLS = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit"] as const;
export const CLAUDE_HOSTED_DISALLOWED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "LS", "PowerShell", "EnterWorktree", "ExitWorktree"
] as const;
export const CLAUDE_HOSTED_GUEST_TOOLS = [
  "Agent", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TodoWrite", "TaskCreate", "TaskGet", "TaskList",
  "TaskUpdate", "TaskStop", "TaskOutput", "ToolSearch", "Skill", "ReportFindings", "ScheduleWakeup", "CronCreate",
  "CronDelete", "CronList", "ListMcpResourcesTool", "ReadMcpResourceTool", "WebSearch"
] as const;
export type ClaudeHostedToolName = typeof CLAUDE_HOSTED_FILE_TOOLS[number] | "WebFetch";

/** Frozen native-style schemas: Claude's built-in filesystem tools remain disabled. */
export function claudeHostedToolDefinitions(webFetch: boolean): Omit<ClaudeSdkMcpTool, "serverId" | "call">[] {
  const object = (properties: Readonly<Record<string, unknown>>, required: readonly string[]) => ({ type: "object", properties, required, additionalProperties: false });
  const text = { type: "string" };
  return [
    { name: "Bash", description: "Run a shell command on the task's computer. The working directory persists between calls; environment variables do not. Timeout defaults to 120000 milliseconds, maximum 600000. Use run_in_background for long commands, BashOutput for output and KillShell to stop them.",
      inputSchema: object({ command: text, timeout: { type: "number", minimum: 1, maximum: 600000 }, description: text, run_in_background: { type: "boolean" } }, ["command"]) },
    { name: "BashOutput", description: "Read new output and status from a background command started in this task. An optional regular expression filters output lines.",
      inputSchema: object({ bash_id: text, filter: text }, ["bash_id"]) },
    { name: "KillShell", description: "Stop a background command started in this task.", inputSchema: object({ shell_id: text }, ["shell_id"]) },
    { name: "Read", description: "Read a file on the task's computer. Returns numbered text lines, image content, notebook cells, or PDF page text. PDF pages selects a 1-indexed page or range, at most 20 pages per call. Text defaults to 2000 lines; use offset and limit for files larger than 256 KiB. Long lines are truncated at 2000 characters. Read a file before overwriting or editing it.",
      inputSchema: object({ file_path: text, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 }, pages: text }, ["file_path"]) },
    { name: "Write", description: "Write a file on the task's computer, creating parent directories. Existing files must have been read in this task before overwriting.",
      inputSchema: object({ file_path: text, content: text }, ["file_path", "content"]) },
    { name: "Edit", description: "Replace exact text in a file on the task's computer. Read it first. old_string must be unique unless replace_all is true. Empty old_string creates a new file.",
      inputSchema: object({ file_path: text, old_string: text, new_string: text, replace_all: { type: "boolean", default: false } }, ["file_path", "old_string", "new_string"]) },
    { name: "NotebookEdit", description: "Replace, insert or delete one notebook cell on the task's computer. Read the notebook first to get cell IDs.",
      inputSchema: object({ notebook_path: text, cell_id: text, new_source: text, cell_type: { type: "string", enum: ["code", "markdown"] }, edit_mode: { type: "string", enum: ["replace", "insert", "delete"] } }, ["notebook_path", "new_source"]) },
    ...(webFetch ? [{ name: "WebFetch", description: "Fetch a text web page using the task computer's network. Cross-host redirects are returned for a new request. Use start_index for later parts of a long page. Private network addresses require confirmation on the task's computer.",
      inputSchema: object({ url: text, prompt: text, start_index: { type: "integer", minimum: 0 } }, ["url"]) }] : [])
  ];
}

export function createClaudeHostedTools(hosted: HostedExecution, fetcher: typeof fetch = fetch): readonly ClaudeSdkMcpTool[] {
  assertHostedExecution(hosted);
  const maximum = 64 * 1024 * 1024;
  return claudeHostedToolDefinitions(hosted.trust === "guest").map(definition => ({
    ...definition, serverId: CLAUDE_HOSTED_EXECUTOR_SERVER,
    async call(arguments_, options) {
      const callId = "claude-" + randomUUID(); let sequence = 0;
      const call = async (operation: string, payload: Readonly<Record<string, unknown>>) => {
        options.signal.throwIfAborted(); assertHostedExecution(hosted);
        const body = JSON.stringify({ format: 1, callId, requestId: `${callId}:${++sequence}`, operation, payload, origin: "agent" });
        if (Buffer.byteLength(body) > maximum) throw new Error("The task operation exceeds its limit.");
        const response = await fetcher(hosted.channel.endpoint.replace(/\/$/u, "") + "/execute", {
          method: "POST", redirect: "error", signal: options.signal,
          headers: { authorization: "Bearer " + hosted.channel.bearer, "content-type": "application/json" }, body
        });
        if (!response.body) throw new Error("The task executor returned no response.");
        const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
        try { for (;;) { const next = await reader.read(); options.signal.throwIfAborted(); if (next.done) break;
          bytes += next.value.byteLength; if (bytes > maximum) throw new Error("The task executor response exceeds its limit."); parts.push(next.value); }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        assertHostedExecution(hosted);
        const parsed = JSON.parse(Buffer.concat(parts).toString("utf8")) as { format?: unknown; ok?: unknown; value?: unknown } | null;
        if (!response.ok || !parsed || parsed.format !== 1 || parsed.ok !== true || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
          throw new Error("The task executor rejected the operation.");
        }
        return parsed.value as Record<string, unknown>;
      };
      await call("tool.begin", { name: "claude", input: { name: definition.name, arguments: arguments_ } });
      try {
        const result = await call("claude.call", {});
        if (!Array.isArray(result.content) || typeof result.isError !== "boolean") throw new Error("The task executor returned an invalid tool result.");
        return { content: result.content, isError: result.isError };
      } finally { await call("tool.end", {}).catch(() => undefined); }
    }
  }));
}
