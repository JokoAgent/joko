import { MessageRole, parseToolDisplayInput, type CollaborationReportOrigin, type Event } from "@joko/contracts";
import type { MobileToolCallView } from "./mobile-tool-call";

export interface MobileCollaborationMessage {
  readonly variant: "dispatch" | "report";
  readonly action: "create" | "batch" | "send" | "report";
  readonly label: string;
  readonly body: string;
  readonly count?: number;
  readonly state?: MobileToolCallView["state"];
  readonly error?: string;
  readonly origin?: CollaborationReportOrigin;
}

const toolNames = new Set(["mcp__joko_collaboration__call_tool", "mcp__joko_032ff7b36750c3f6aec4706f__call_tool"]);
const identity = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const text = (value: unknown, maximum = 32_000): string => typeof value === "string" && value.length <= maximum && !value.includes("\0") ? value.trim() : "";

/** Adapt the current progressive tool input; display text never authorizes a worker action. */
export function mobileCollaborationDispatch(call: MobileToolCallView): MobileCollaborationMessage | undefined {
  // Codex keeps its frozen broker route name; Pi and Claude keep the SDK tool name.
  const knownTool = toolNames.has(call.name) || /^joko_joko_collaboration_[a-f0-9]{12}\/call_tool$/u.test(call.name);
  if (!knownTool || call.inputRedacted || call.inputTruncated) return undefined;
  const input = record(parseToolDisplayInput(call.input, 262_144)), args = record(input?.["args"]);
  if (!input || !args) return undefined;
  const state = call.state, error = call.error || (state === "failed" ? call.output : "");
  if (input["name"] === "create_workers") {
    const workers = args["workers"];
    if (!Array.isArray(workers) || workers.length < 2 || workers.length > 20) return undefined;
    const summaries: string[] = [];
    for (const value of workers) {
      const worker = record(value);
      if (!worker) return undefined;
      const label = text(worker["label"], 64) || text(worker["role"], 128);
      const assignment = text(worker["assignment"]);
      if (!label) return undefined;
      summaries.push(assignment ? `${label}: ${assignment}` : label);
    }
    return { variant: "dispatch", action: "batch", label: "", count: workers.length, body: summaries.join("\n"), state, error };
  }
  if (input["name"] === "create_worker") {
    const label = text(args["label"], 64) || text(args["role"], 128);
    if (!label) return undefined;
    return { variant: "dispatch", action: "create", label, body: text(args["assignment"]), state, error };
  }
  if (input["name"] === "send_to_worker") {
    const body = text(args["message"]);
    if (!body) return undefined;
    return { variant: "dispatch", action: "send", label: "", body, state, error };
  }
  return undefined;
}

/** Only Host-authored, canonical accepted input may become a report card or source link. */
export function mobileCollaborationReport(event: Event): MobileCollaborationMessage | undefined {
  const payload = event.payload?.kind;
  if (payload?.case !== "messageStarted" || payload.value.role !== MessageRole.USER || !payload.value.userInputAccepted) return undefined;
  const origin = payload.value.collaborationReportOrigin;
  if (!origin || ![origin.goalId, origin.workerId, origin.leadSessionId, origin.workerSessionId].every(identity)
    || origin.leadSessionId !== event.identity?.sessionId || origin.leadSessionId === origin.workerSessionId
    || !text(origin.workerLabel, 64) || !text(origin.body)) return undefined;
  return { variant: "report", action: "report", label: origin.workerLabel, body: origin.body, origin };
}
