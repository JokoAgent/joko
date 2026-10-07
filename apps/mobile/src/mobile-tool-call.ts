import {
  CompositeArgumentKind, ToolCallOutputMode, ToolCallState, ToolFileAction,
  describeToolPresentation, type DisplayArgument, type Event, type ToolResult
} from "@joko/contracts";

export interface MobileToolCallView {
  readonly scopeKey: string;
  readonly name: string;
  readonly state: "requested" | "waiting" | "running" | "succeeded" | "failed" | "aborted" | "unknown";
  readonly input: string;
  readonly output: string;
  readonly error: string;
  readonly inputTruncated: boolean;
  readonly inputRedacted: boolean;
  readonly outputTruncated: boolean;
  readonly summary?: ReturnType<typeof describeToolPresentation>;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

const maximumPayloadCharacters = 262_144;
const maximumParts = 256;

/** Public display projection only. Tool, path and Blob identities grant no action. */
export function projectMobileToolCall(event: Event, previous?: MobileToolCallView): MobileToolCallView | undefined {
  const scopeKey = mobileToolCallScopeKey(event);
  if (scopeKey === undefined) return undefined;
  const payload = event.payload?.kind;
  if (payload?.case !== "toolCallStarted" && payload?.case !== "toolCallUpdated"
    && payload?.case !== "toolCallCompleted") return undefined;
  const call = payload.value.toolCall;
  if (!call) return undefined;
  if (previous?.scopeKey !== scopeKey) previous = undefined;
  if (previous && terminal(previous.state)) return previous;
  const input = call.arguments.length === 0 && previous
    ? { text: previous.input, truncated: previous.inputTruncated }
    : boundedText(call.arguments.slice(0, maximumParts).map(displayArgument), call.arguments.length > maximumParts);
  const result = payload.case === "toolCallUpdated" ? payload.value.incrementalResult : call.result;
  const output = result === undefined && previous
    ? { text: previous.output, truncated: previous.outputTruncated }
    : resultText(result);
  const append = payload.case === "toolCallUpdated" && payload.value.outputMode === ToolCallOutputMode.APPEND;
  const mergedOutput = append && previous
    ? boundedText([previous.output + output.text], previous.outputTruncated || output.truncated)
    : output;
  const inputRedacted = call.arguments.length === 0 && previous ? previous.inputRedacted : call.arguments.some((argument) => argument.redacted);
  const summary = inputRedacted || input.truncated ? undefined
    : call.arguments.length === 0 && previous ? previous.summary : describeToolPresentation(call.toolId, input.text);
  const startedAtMs = timeMs(call.startedAt) ?? previous?.startedAtMs;
  const endedAtMs = timeMs(call.endedAt);
  return {
    scopeKey, name: call.toolId, state: stateName(call.state), input: input.text, output: mergedOutput.text,
    error: boundedText([call.error?.message ?? ""]).text,
    inputTruncated: input.truncated, inputRedacted, outputTruncated: mergedOutput.truncated,
    ...(summary === undefined ? {} : { summary }),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(endedAtMs === undefined ? {} : { endedAtMs })
  };
}

export function mobileToolCallScopeKey(event: Event): string | undefined {
  const payload = event.payload?.kind;
  if (payload?.case !== "toolCallStarted" && payload?.case !== "toolCallUpdated"
    && payload?.case !== "toolCallCompleted") return undefined;
  const call = payload.value.toolCall;
  if (!call || !identity(call.toolCallId) || !identity(call.toolId) || !identity(call.sessionId)
    || call.sessionId !== event.identity?.sessionId
    || (event.identity.runId && event.identity.runId !== call.runId)
    || (event.identity.attemptId && event.identity.attemptId !== call.attemptId)) return undefined;
  return JSON.stringify([
    "tool", call.sessionId, call.runId, call.attemptId, call.toolCallId, call.toolId, call.toolProviderId,
    event.identity.generation.toString(10), event.cursor?.generation.toString(10) ?? ""
  ]);
}

export function mobileToolCallCompleted(call: MobileToolCallView): boolean {
  return terminal(call.state);
}

function terminal(state: MobileToolCallView["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "aborted";
}

function stateName(state: ToolCallState): MobileToolCallView["state"] {
  switch (state) {
    case ToolCallState.REQUESTED: return "requested";
    case ToolCallState.WAITING_PERMISSION: return "waiting";
    case ToolCallState.RUNNING: return "running";
    case ToolCallState.SUCCEEDED: return "succeeded";
    case ToolCallState.FAILED: return "failed";
    case ToolCallState.ABORTED: return "aborted";
    default: return "unknown";
  }
}

function displayArgument(argument: DisplayArgument): string {
  if (argument.redacted) return `${argument.fieldPath}: ${argument.redactedPlaceholder || "••••"}`;
  const value = argument.value;
  let text = "";
  switch (value.case) {
    case "text": text = value.value; break;
    case "number": case "integer": case "boolean": text = String(value.value); break;
    case "null": text = "null"; break;
    case "blob": text = `${value.value.fileName} (${value.value.mediaType}, ${value.value.byteSize} bytes)`; break;
    case "composite": text = `${value.value.kind === CompositeArgumentKind.ARRAY ? "array" : "object"} (${value.value.childCount})`; break;
  }
  return `${argument.fieldPath}: ${text}`;
}

function resultText(result: ToolResult | undefined): { readonly text: string; readonly truncated: boolean } {
  if (!result) return { text: "", truncated: false };
  const parts = result.parts.slice(0, maximumParts).map((part) => {
    const value = part.content;
    switch (value.case) {
      case "text": return value.value;
      case "command": return [value.value.commandDisplay, value.value.stdoutPreview, value.value.stderrPreview,
        ...(value.value.completed ? [`exit_code: ${value.value.exitCode}`] : [])].filter((text) => text !== "").join("\n");
      case "fileChange": return JSON.stringify({ workspace_id: value.value.workspaceId, path: value.value.relativePath,
        action: ToolFileAction[value.value.action] ?? "unknown", revision_before: value.value.revisionBefore,
        revision_after: value.value.revisionAfter });
      case "table": return [value.value.columns.join("\t"), ...value.value.rows.slice(0, maximumParts)
        .map((row) => row.cells.join("\t"))].join("\n");
      case "image": return `[${value.value.altText || value.value.blob?.fileName || "image"}]`;
      case "artifact": return `[${value.value.title || value.value.blob?.fileName || "artifact"}]`;
      default: return "";
    }
  });
  return boundedText(parts, result.truncated || result.parts.length > maximumParts
    || result.parts.some((part) => part.content.case === "table" && part.content.value.rows.length > maximumParts));
}

function boundedText(parts: readonly string[], truncated = false): { readonly text: string; readonly truncated: boolean } {
  let text = "";
  for (const part of parts) {
    const remaining = maximumPayloadCharacters - text.length;
    const next = (text === "" ? "" : "\n") + part;
    text += next.slice(0, remaining);
    if (next.length > remaining) { truncated = true; break; }
  }
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  return { text, truncated };
}

function identity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function timeMs(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number | undefined {
  if (!value || value.nanos < 0 || value.nanos > 999_999_999) return undefined;
  const result = Number(value.seconds) * 1_000 + value.nanos / 1_000_000;
  return Number.isSafeInteger(Math.trunc(result)) && result >= 0 ? result : undefined;
}
