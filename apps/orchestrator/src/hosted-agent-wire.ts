import { z } from "zod";
import { validInputMentionRanges, type PromptInput } from "@joko/core";
import type { HostedAgentCall } from "./hosted-agent-run.js";
import type { HostedAgentOpen } from "./hosted-agent-host.js";
import type { HostedNativeInferenceRequest } from "@joko/adapter-hosted";

export const HOSTED_AGENT_WIRE_FORMAT = 1;
export const HOSTED_AGENT_WIRE_MAXIMUM_BYTES = 64 * 1024 * 1024;
/** Space for generated binary envelopes around the aggregate native payload. */
export const HOSTED_AGENT_WIRE_ENVELOPE_BYTES = HOSTED_AGENT_WIRE_MAXIMUM_BYTES + 2 * 1024 * 1024;
const id = z.string().min(1).max(512).refine(value => !/[\0\r\n]/u.test(value));
const text = z.string().max(16 * 1024 * 1024);
const permission = z.enum(["ask", "acceptEdits", "auto", "bypassPermissions"]);
const unsigned = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const blob = z.strictObject({ id, sha256: z.string().regex(/^[0-9a-f]{64}$/u), byteLength: unsigned,
  mimeType: z.string().min(1).max(256), fileName: z.string().max(1024).optional() });
const range = z.strictObject({ start: unsigned, end: unsigned, display: z.string().min(1).max(500) });
const lineRange = z.strictObject({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) });
const mentionBase = { label: text, reference: text };
const mention = z.discriminatedUnion("kind", [
  z.strictObject({ ...mentionBase, kind: z.literal("workspace_file"), workspaceId: id.optional(), lineRange: lineRange.optional() }),
  z.strictObject({ ...mentionBase, kind: z.literal("workspace_directory"), workspaceId: id.optional() }),
  z.strictObject({ ...mentionBase, kind: z.literal("resource"), discoveredRevision: id, resourceVersion: z.string().regex(/^[1-9][0-9]*$/u), runtimeGeneration: unsigned }),
  z.strictObject({ ...mentionBase, kind: z.literal("artifact"), sourceSessionId: id }),
  z.strictObject({ ...mentionBase, kind: z.literal("session") })
]);
const prompt = z.strictObject({ text, images: z.array(z.strictObject({ blob, alt: text.optional() })).max(128),
  files: z.array(z.strictObject({ blob, workspacePath: text.optional() })).max(1024), mentions: z.array(mention).max(4096),
  disposition: z.enum(["prompt", "steer", "follow_up"]), quotesEncoded: z.boolean().optional(), pastedTextRanges: z.array(range).max(4096).optional(),
  mentionRanges: z.array(z.strictObject({ start: unsigned, end: unsigned, mentionIndex: unsigned })).max(4096).optional(),
  automaticContinuation: z.strictObject({ recoveryId: id, sourceRunId: id, attempt: unsigned, maximumAttempts: unsigned, sessionTotal: unsigned }).optional(),
  objectiveContinuation: z.strictObject({ ownerGeneration: unsigned, turn: unsigned }).optional()
});
const noArgs = ["state", "abort", "delete", "abort_retry", "commands", "resources", "tools", "tree", "history", "abort_shell"] as const;
const callSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("derive"), derivationKind: z.enum(["fork", "clone"]), sessionId: id, targetId: id, nativeSessionId: id, entryId: id.optional(),
    completedSnapshot: z.strictObject({ kind: z.literal("completed_assistant"), nativeBoundaryId: id }).optional() }),
  z.strictObject({ kind: z.literal("derivation_lifecycle"), action: z.enum(["adopt", "cleanup"]), derivationKind: z.enum(["fork", "clone"]), operationId: id,
    backendId: id, providerId: id, sourceSessionId: id, sourceTargetId: id, sourceNativeSessionId: id, sessionId: id, targetId: id, nativeSessionId: id }),
  z.strictObject({ kind: z.literal("send"), input: prompt, durableFence: z.boolean(), newGroupRound: z.boolean().optional() }),
  ...noArgs.map(kind => z.strictObject({ kind: z.literal(kind) })),
  z.strictObject({ kind: z.literal("idle_release"), idleMinutes: z.number().int().min(1).max(120) }),
  z.strictObject({ kind: z.literal("idle_release_status"), releaseCallId: id }),
  z.strictObject({ kind: z.literal("set_model"), providerId: id, modelId: id }),
  z.strictObject({ kind: z.literal("set_effort"), effort: id }),
  z.strictObject({ kind: z.literal("set_fast"), enabled: z.union([z.boolean(), z.literal("ultrafast")]) }),
  z.strictObject({ kind: z.literal("set_permission"), mode: permission }),
  z.strictObject({ kind: z.literal("set_plan"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("set_name"), name: text }),
  z.strictObject({ kind: z.literal("set_auto_compaction"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("set_auto_retry"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("compact"), instructions: text.optional() }),
  z.strictObject({ kind: z.literal("navigate"), target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("native_entry"), entryId: id }), z.strictObject({ kind: z.literal("session_start") })
  ]), summarize: z.boolean(), instructions: text.optional() }),
  z.strictObject({ kind: z.literal("dispatch_during_compaction"), input: prompt }),
  z.strictObject({ kind: z.literal("cancel_background"), taskId: id }),
  z.strictObject({ kind: z.literal("background_output"), taskId: id, maximumBytes: z.number().int().min(1).max(1024 * 1024) }),
  z.strictObject({ kind: z.literal("shell"), input: z.strictObject({ command: text, excludeFromContext: z.boolean() }) }),
  z.strictObject({ kind: z.literal("control_subagent"), input: z.strictObject({ runId: id, childId: id.optional(),
    action: z.enum(["stop", "steer", "follow_up", "resume"]), message: text.optional() }) })
]);
const openSchema = z.strictObject({ runId: id, nativeSessionId: id, start: z.enum(["create", "resume"]), sessionId: id, targetId: id, generation: unsigned, backendId: id, providerId: id, modelId: id,
  name: z.string().max(16_384).refine(value => !value.includes("\0")).optional(), groupSwitch: z.string().regex(/^[a-f0-9]{64}$/u).optional(), groupMember: z.boolean().optional(),
  permissionMode: permission, fastMode: z.union([z.boolean(), z.literal("ultrafast")]), effort: id.optional(), workspace: z.strictObject({ platform: z.enum(["win32", "darwin", "linux"]),
    shell: z.string().max(16_384), isGitRepository: z.boolean(), personalInstructions: z.string().max(1024 * 1024).optional(),
    memoryInstructions: z.string().max(1024 * 1024).optional(), mcpEnabled: z.literal(true).optional(), subagentsEnabled: z.boolean().optional(),
    additionalDirectoryIds: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(128).refine(ids => new Set(ids).size === ids.length).optional(),
    contextFiles: z.array(z.strictObject({ path: z.string().min(1).max(16_384).refine(value => !value.includes("\0")), content: z.string().max(1024 * 1024) })).max(512).optional() }) });
const replySchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u) })]);
const inferenceSchema = z.strictObject({ requestId: id, backendId: id, backendInstanceGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  providerId: id, modelId: id, system: z.string().max(80_000), user: z.string().max(300_000),
  timeoutMs: z.number().int().min(1_000).max(90_000), maxTokens: z.number().int().min(1).max(65_536).optional(),
  images: z.array(z.strictObject({ mimeType: z.string().regex(/^image\/(?:png|jpeg|gif|webp)$/u),
    data: z.string().min(4).max(7_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) })).max(40).optional()
});
export class HostedAgentWireError extends Error { constructor() { super("The hosted Agent wire value is invalid."); } }
export function assertHostedAgentWireFormat(format: number): void { if (format !== HOSTED_AGENT_WIRE_FORMAT) throw new HostedAgentWireError(); }
export function encodeHostedAgentValue(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > HOSTED_AGENT_WIRE_MAXIMUM_BYTES) throw new HostedAgentWireError();
  return Buffer.from(json);
}
export function decodeHostedAgentValue(bytes: Uint8Array, maximum = HOSTED_AGENT_WIRE_MAXIMUM_BYTES): unknown {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maximum) throw new HostedAgentWireError();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new HostedAgentWireError(); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new HostedAgentWireError(); return result.data;
}
export function decodeHostedAgentOpen(bytes: Uint8Array): HostedAgentOpen { return parse(openSchema, decodeHostedAgentValue(bytes, 8 * 1024 * 1024)); }
export function decodeHostedAgentInference(value: unknown): HostedNativeInferenceRequest {
  const request = parse(inferenceSchema, value);
  let total = 0;
  for (const image of request.images ?? []) {
    const bytes = Buffer.from(image.data, "base64"); total += bytes.byteLength;
    if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024 || bytes.toString("base64") !== image.data) throw new HostedAgentWireError();
  }
  if (total > 20 * 1024 * 1024) throw new HostedAgentWireError();
  return request;
}
export function decodeHostedAgentInvocation(bytes: Uint8Array): HostedAgentCall | { readonly kind: "infer"; readonly request: HostedNativeInferenceRequest } {
  const value = decodeHostedAgentValue(bytes);
  if (value !== null && typeof value === "object" && "kind" in value && value.kind === "infer") {
    if (!("request" in value) || Object.keys(value).some(key => key !== "kind" && key !== "request")) throw new HostedAgentWireError();
    return { kind: "infer", request: decodeHostedAgentInference(value.request) };
  }
  return decodeHostedAgentCall(bytes);
}
export function decodeHostedAgentCall(bytes: Uint8Array): HostedAgentCall {
  const call = parse(callSchema, decodeHostedAgentValue(bytes)) as HostedAgentCall;
  if (call.kind === "send") {
    const input: PromptInput = call.input;
    if (!validInputMentionRanges(input.text, input.mentions, input.mentionRanges ?? [], input.pastedTextRanges ?? [])) throw new HostedAgentWireError();
  }
  return call;
}
export function decodeHostedAgentReply(bytes: Uint8Array): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string } {
  return parse(replySchema, decodeHostedAgentValue(bytes));
}
