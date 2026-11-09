import { posix, win32 } from "node:path";
import { z } from "zod";
import type { BackgroundTaskOutputResult } from "@joko/core";
import type { HostedWorkflowProgressResult } from "./hosted-agent-workflow-progress.js";

const unsigned = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), text = (maximum: number) => z.string().max(maximum);
const phase = z.strictObject({ index: unsigned.max(1_000_000), title: text(512).min(1), detail: text(200).optional() });
const agent = z.strictObject({ label: text(512).min(1), state: text(128).min(1), agentId: text(512).optional(), model: text(512).optional(),
  phaseTitle: text(512).optional(), phaseIndex: unsigned.max(1_000_000).optional(), attempt: unsigned.min(1).max(1_000_000).optional(),
  lastToolName: text(200).optional(), lastToolSummary: text(160).optional(), resultPreview: text(300).optional(), durationMs: unsigned.optional(), error: text(300).optional() });
const schema = z.strictObject({ virtualRoot: text(32_768).refine(value => !/[\0\r\n]/u.test(value)), output: z.strictObject({ status: z.enum(["available", "unavailable", "failed"]), text: z.literal(""),
  totalBytes: unsigned.max(1024 * 1024), truncated: z.boolean(), capturedAtMs: unsigned, modifiedAtMs: unsigned.optional(),
  workflow: z.strictObject({ runId: text(512).min(1), status: text(128).min(1), workflowName: text(512).optional(), agentCount: unsigned.optional(), totalTokens: unsigned.optional(),
    totalToolCalls: unsigned.optional(), durationMs: unsigned.optional(), phases: z.array(phase).max(512), agents: z.array(agent).max(512), logs: z.array(text(300)).max(50) }).optional() }) });

export function decodeHostedWorkflowProgress(value: unknown): HostedWorkflowProgressResult {
  const result = schema.parse(value);
  if (result.output.status === "available" && (!result.output.workflow || !posix.isAbsolute(result.virtualRoot) && !win32.isAbsolute(result.virtualRoot))
    || result.output.status !== "available" && result.output.workflow !== undefined) throw new Error("The native workflow observation is invalid.");
  return result;
}

/** Source path restoration may lengthen text. Apply the same display bounds
 * and byte budget after that restoration, before exposing the formal output. */
export function boundHostedWorkflowProgress(output: BackgroundTaskOutputResult, maximumBytes: number): BackgroundTaskOutputResult {
  if (!output.workflow) return output;
  let truncated = output.truncated;
  const clip = (value: string, maximum: number): string => { if (value.length > maximum) truncated = true; return value.slice(0, maximum); };
  const source = output.workflow, workflow = { ...source, runId: clip(source.runId, 512), status: clip(source.status, 128),
    ...(source.workflowName === undefined ? {} : { workflowName: clip(source.workflowName, 512) }),
    phases: source.phases.map(phase => ({ ...phase, title: clip(phase.title, 512), ...(phase.detail === undefined ? {} : { detail: clip(phase.detail, 200) }) })),
    agents: source.agents.map(agent => {
      const row = { ...agent };
      for (const [key, maximum] of [["label", 512], ["state", 128], ["agentId", 512], ["model", 512], ["phaseTitle", 512], ["lastToolName", 200], ["lastToolSummary", 160], ["resultPreview", 300], ["error", 300]] as const) {
        const value = row[key]; if (value !== undefined) row[key] = clip(value, maximum);
      }
      return row;
    }), logs: source.logs.map(line => clip(line, 300)) };
  const fits = () => Buffer.byteLength(JSON.stringify(workflow), "utf8") <= maximumBytes;
  while (!fits() && (workflow.logs.length || workflow.agents.length || workflow.phases.length)) {
    if (workflow.logs.length) workflow.logs.shift(); else if (workflow.agents.length) workflow.agents.pop(); else workflow.phases.pop(); truncated = true;
  }
  return fits() ? { ...output, workflow, truncated } : { status: "unavailable", text: "", totalBytes: 0, truncated: false, capturedAtMs: output.capturedAtMs };
}
