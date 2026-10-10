import { commandIntentFromCommand } from "./command-intent.js";
import { normalizeDisplayCommand } from "./command-display.js";
import { describeToolPresentation, parseToolDisplayInput } from "./tool-presentation.js";

/** Public execution facts; targets, arguments, output and reasoning never become captions. */
export const WORKING_PHASES = [
  "thinking", "replying", "processing", "compacting", "reading-memory", "saving-memory",
  "deleting-memory", "organizing-memory", "reading-file", "saving-file", "searching", "reading-web",
  "searching-files", "testing", "checking", "reviewing-memory", "reviewing-files", "reviewing-sources", "reviewing-checks"
] as const;
export type WorkingPhase = typeof WORKING_PHASES[number];

export function publicToolWorkingPhase(toolName: string, input: string, withheld = false): WorkingPhase {
  if (!toolName || toolName.length > 512 || /[\u0000-\u001f\u007f]/u.test(toolName)) return "processing";
  const memory = toolName.startsWith("mcp__joko_memory__") ? toolName.slice("mcp__joko_memory__".length)
    : toolName.startsWith("joko_memory/") ? toolName.slice("joko_memory/".length) : undefined;
  const args = withheld ? undefined : parseToolDisplayInput(input);
  const record = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
  const action = memory === "call_tool" ? record?.["name"] : memory;
  switch (action) {
    case "memory_read": case "memory_search": case "memory_list": return "reading-memory";
    case "memory_write": return "saving-memory";
    case "memory_delete": return "deleting-memory";
    case "memory_review": return "reviewing-memory";
    case "memory_consolidate": return "organizing-memory";
  }
  if (withheld) return "processing";
  const rawCommand = toolName === "command" || toolName === "Shell" ? args
    : ["Bash", "bash"].includes(toolName) ? record?.["command"] : undefined;
  if (typeof rawCommand === "string") {
    const command = normalizeDisplayCommand(rawCommand) ?? rawCommand;
    // Free-form descriptions cannot override the whole-command shape checks.
    switch (commandIntentFromCommand(command)?.action) {
      case "read": return "reading-file";
      case "search": case "list": case "gitGrep": case "gitLsFiles": return "searching-files";
      case "fetch": return "reading-web";
      case "test": return "testing";
      case "verify": case "typecheck": case "lint": case "checkSyntax": case "checkFormatting": return "checking";
      default: return "processing";
    }
  }
  if (toolName === "file_change") return "saving-file";
  switch (describeToolPresentation(toolName, input)?.action) {
    case "readFile": return "reading-file";
    case "editFile": case "createFile": return "saving-file";
    case "listFiles": case "searchFiles": return "searching-files";
    case "searchWeb": return "searching";
    case "fetchWeb": return "reading-web";
    default: return "processing";
  }
}

/** A returned tool supplies a subject for review, never a claim of successful execution. */
export function publicToolResultWorkingPhase(phase: WorkingPhase): WorkingPhase {
  switch (phase) {
    case "reading-memory": case "saving-memory": case "deleting-memory":
    case "organizing-memory": case "reviewing-memory": return "reviewing-memory";
    case "reading-file": case "saving-file": case "searching-files": return "reviewing-files";
    case "reading-web": case "searching": return "reviewing-sources";
    case "testing": case "checking": return "reviewing-checks";
    default: return "processing";
  }
}
