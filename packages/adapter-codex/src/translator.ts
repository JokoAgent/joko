import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  redactSecrets,
  type AdapterContext,
  type BlobRef,
  type EventPayload,
  type InteractionDecision,
  type InteractionPayload,
  type PromptInput,
  type UsageSnapshot
} from "@joko/core";
import { adapterError } from "./errors.js";
import {
  commandApprovalAvailability,
  isJsonObject,
  numberValue,
  objectValue,
  optionalString,
  parseThreadItem,
  parseTurn,
  ProtocolShapeError,
  stringValue,
  type JsonObject,
  type JsonValue,
  type NativeThreadItem,
  type NativeUserInput,
  type RpcId,
  type ScalarCommandApprovalDecision
} from "./protocol.js";

export interface ResolvedBlob {
  readonly data: Uint8Array;
  readonly mimeType?: string;
}

export interface CodexInputResolvers {
  readonly readBlob?: (blob: BlobRef) => Promise<ResolvedBlob>;
  readonly resolveFile?: (blob: BlobRef, context: AdapterContext) => Promise<string>;
  readonly maximumBlobBytes?: number;
  readonly maximumAggregateBlobBytes?: number;
  readonly maximumPromptTextBytes?: number;
  readonly maximumInputItems?: number;
}

const DEFAULT_MAXIMUM_BLOB_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAXIMUM_AGGREGATE_BLOB_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAXIMUM_PROMPT_TEXT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_INPUT_ITEMS = 256;
const MAXIMUM_INTERACTION_QUESTIONS = 3;
const MAXIMUM_INTERACTION_OPTIONS = 10;
const MAXIMUM_INTERACTION_ID_CHARS = 256;
const MAXIMUM_INTERACTION_TEXT_CHARS = 1_000;
const MAXIMUM_INTERACTION_ANSWER_CHARS = 2_000;
const MAXIMUM_TRACKED_TOOL_ITEMS = 2_048;

export interface TranslatorState {
  activeTurnId?: string;
  usage?: UsageSnapshot;
  readonly itemNames: Map<string, string>;
  readonly terminalTurnIds: Set<string>;
}

export function createTranslatorState(): TranslatorState {
  return {
    itemNames: new Map(),
    terminalTurnIds: new Set()
  };
}

export async function translatePromptInput(
  input: PromptInput,
  context: AdapterContext,
  resolvers: CodexInputResolvers
): Promise<readonly NativeUserInput[]> {
  const result: NativeUserInput[] = [];
  const maximumPromptTextBytes = positiveBound(
    resolvers.maximumPromptTextBytes,
    DEFAULT_MAXIMUM_PROMPT_TEXT_BYTES,
    "prompt text"
  );
  const maximumInputItems = positiveBound(
    resolvers.maximumInputItems,
    DEFAULT_MAXIMUM_INPUT_ITEMS,
    "input item"
  );
  const inputItemCount = (input.text.length === 0 ? 0 : 1)
    + input.images.length
    + input.files.length
    + input.mentions.length;
  if (inputItemCount > maximumInputItems) {
    throw adapterError({
      code: "CODEX_INPUT_ITEM_LIMIT",
      message: "The Codex prompt contains too many input items.",
      phase: "dispatch",
      recovery: "Reduce the number of attachments and mentions before retrying."
    });
  }
  if (Buffer.byteLength(input.text, "utf8") > maximumPromptTextBytes) {
    throw adapterError({
      code: "CODEX_PROMPT_TOO_LARGE",
      message: "The Codex prompt text exceeds the configured input limit.",
      phase: "dispatch",
      recovery: "Shorten the prompt or attach bounded workspace files instead."
    });
  }
  if (input.text.length > 0) result.push({ type: "text", text: input.text, text_elements: [] });
  const maximumBlobBytes = positiveBound(
    resolvers.maximumBlobBytes,
    DEFAULT_MAXIMUM_BLOB_BYTES,
    "image blob"
  );
  const maximumAggregateBlobBytes = positiveBound(
    resolvers.maximumAggregateBlobBytes,
    DEFAULT_MAXIMUM_AGGREGATE_BLOB_BYTES,
    "aggregate image blob"
  );
  let aggregateBlobBytes = 0;
  for (const image of input.images) {
    if (!Number.isSafeInteger(image.blob.byteLength) || image.blob.byteLength < 0) {
      throw adapterError({
        code: "CODEX_IMAGE_REFERENCE_INVALID",
        message: "An image attachment has an invalid immutable size reference.",
        phase: "dispatch",
        recovery: "Recreate the image attachment from immutable artifact storage."
      });
    }
    aggregateBlobBytes += image.blob.byteLength;
    if (image.blob.byteLength > maximumBlobBytes || aggregateBlobBytes > maximumAggregateBlobBytes) {
      throw adapterError({
        code: "CODEX_IMAGE_TOO_LARGE",
        message: "The image attachments exceed the configured Codex input limit.",
        phase: "dispatch",
        recovery: "Resize the image and retry the prompt."
      });
    }
    if (resolvers.readBlob === undefined) {
      throw adapterError({
        code: "CODEX_IMAGE_RESOLVER_MISSING",
        message: "Image input is unavailable because no immutable blob reader is configured.",
        phase: "dispatch",
        recovery: "Configure the artifact blob reader before sending images."
      });
    }
    const resolved = await resolvers.readBlob(image.blob).catch(() => {
      throw adapterError({
        code: "CODEX_IMAGE_UNAVAILABLE",
        message: "An image attachment could not be loaded from artifact storage.",
        phase: "dispatch",
        retryable: true,
        recovery: "Restore the immutable image artifact and retry."
      });
    });
    if (resolved.data.byteLength > maximumBlobBytes
      || resolved.data.byteLength > maximumAggregateBlobBytes) {
      throw adapterError({
        code: "CODEX_IMAGE_TOO_LARGE",
        message: "The resolved image data exceeds the configured Codex input limit.",
        phase: "dispatch",
        recovery: "Restore a bounded immutable image artifact before retrying."
      });
    }
    const digest = createHash("sha256").update(resolved.data).digest("hex");
    if (resolved.data.byteLength !== image.blob.byteLength || digest.toLowerCase() !== image.blob.sha256.toLowerCase()) {
      throw adapterError({
        code: "CODEX_IMAGE_INTEGRITY_FAILED",
        message: "An image attachment no longer matches its immutable artifact reference.",
        phase: "dispatch",
        recovery: "Restore the original image artifact before retrying."
      });
    }
    const mimeType = resolved.mimeType ?? image.blob.mimeType;
    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(mimeType)) {
      throw adapterError({
        code: "CODEX_IMAGE_TYPE_UNSUPPORTED",
        message: "The selected image format is not supported by this Codex adapter.",
        phase: "dispatch",
        recovery: "Use PNG, JPEG, WebP, or GIF."
      });
    }
    result.push({
      type: "image",
      url: `data:${mimeType};base64,${Buffer.from(resolved.data).toString("base64")}`
    });
  }
  for (const file of input.files) {
    const path = file.workspacePath === undefined
      ? await resolveManagedFile(file.blob, context, resolvers)
      : await resolveWorkspacePath(context.target.workspaceRoot, file.workspacePath);
    result.push({
      type: "mention",
      name: file.blob.fileName ?? basename(path),
      path
    });
  }
  for (const mention of input.mentions) {
    let path: string;
    if (mention.kind === "workspace_file") {
      path = await resolveWorkspacePath(context.target.workspaceRoot, mention.reference);
    } else if (isSafeMentionReference(mention.reference)) {
      path = mention.reference;
    } else {
      throw adapterError({
        code: "CODEX_MENTION_REFERENCE_UNSUPPORTED",
        message: "A mention does not resolve to a supported local or capability URI.",
        phase: "dispatch",
        recovery: "Select a workspace file, app, or plugin mention exposed by the current Target."
      });
    }
    result.push({ type: "mention", name: mention.label, path });
  }
  if (result.length === 0) {
    throw adapterError({
      code: "CODEX_PROMPT_EMPTY",
      message: "The Codex prompt contains no supported input.",
      phase: "dispatch",
      recovery: "Add text or a supported attachment."
    });
  }
  return result;
}

export class CodexEventTranslator {
  translate(method: string, params: JsonValue, state: TranslatorState): readonly EventPayload[] {
    switch (method) {
      case "turn/started": {
        const record = objectValue(params, "turn started");
        const turn = parseTurn(record["turn"]);
        if (state.terminalTurnIds.has(turn.id)) return [];
        if (state.activeTurnId !== undefined && state.activeTurnId !== turn.id) return [];
        state.activeTurnId = turn.id;
        return [];
      }
      case "turn/completed": {
        const record = objectValue(params, "turn completed");
        const turn = parseTurn(record["turn"]);
        if (state.terminalTurnIds.has(turn.id)) return [];
        if (state.activeTurnId !== undefined && state.activeTurnId !== turn.id) {
          rememberTerminal(state.terminalTurnIds, turn.id);
          return [];
        }
        if (state.activeTurnId === turn.id) state.activeTurnId = undefined;
        rememberTerminal(state.terminalTurnIds, turn.id);
        if (turn.status === "failed") {
          return [
            { type: "error", error: publicTurnError(turn.error), terminal: true },
            { type: "done", outcome: "failed" }
          ];
        }
        return [{ type: "done", outcome: turn.status === "interrupted" ? "aborted" : "completed" }];
      }
      case "item/agentMessage/delta":
        return [deltaEvent("text_delta", params)];
      case "item/plan/delta":
        return [deltaEvent("text_delta", params, "plan")];
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return [deltaEvent("thinking_delta", params)];
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const record = objectValue(params, "tool output delta");
        const itemId = stringValue(record["itemId"], "tool item id");
        return [{
          type: "tool_update",
          callId: itemId,
          name: state.itemNames.get(itemId) ?? "tool",
          outputMode: "append",
          output: safeText(typeof record["delta"] === "string" ? record["delta"] : "", 64 * 1024)
        }];
      }
      case "item/commandExecution/terminalInteraction": {
        const record = objectValue(params, "terminal interaction");
        const itemId = stringValue(record["itemId"], "terminal item id");
        return [{
          type: "tool_update",
          callId: itemId,
          name: state.itemNames.get(itemId) ?? "command",
          outputMode: "append",
          output: "[interactive terminal input delivered]"
        }];
      }
      case "item/mcpToolCall/progress": {
        const record = objectValue(params, "MCP progress");
        const itemId = stringValue(record["itemId"], "MCP item id");
        return [{
          type: "tool_update",
          callId: itemId,
          name: state.itemNames.get(itemId) ?? "mcp_tool",
          outputMode: "replace",
          output: safeText(typeof record["message"] === "string" ? record["message"] : "", 8_192)
        }];
      }
      case "item/started":
        return this.#itemStarted(params, state);
      case "item/completed":
        return this.#itemCompleted(params, state);
      case "thread/tokenUsage/updated": {
        const usage = usageFromNotification(params);
        state.usage = usage;
        return [{ type: "usage", usage }];
      }
      case "thread/name/updated":
        return [{ type: "session_changed" }];
      case "error": {
        const record = objectValue(params, "Codex error");
        return [{
          type: "error",
          error: publicTurnError(isJsonObject(record["error"]) ? record["error"] : undefined),
          terminal: false
        }];
      }
      case "warning":
      case "configWarning":
      case "deprecationNotice":
        return [{ type: "status", key: "backend_warning", text: "Codex reported a runtime warning." }];
      default:
        return [];
    }
  }

  #itemStarted(params: JsonValue, state: TranslatorState): readonly EventPayload[] {
    const item = itemFromNotification(params);
    if (item.type === "contextCompaction") {
      return [{
        type: "compaction",
        reason: "native",
        compactionId: item.id,
        state: "started"
      }];
    }
    const tool = toolIdentity(item);
    if (tool === undefined) return [];
    rememberItemName(state.itemNames, item.id, tool.name);
    return [{
      type: "tool_start",
      callId: item.id,
      name: tool.name,
      input: tool.input
    }];
  }

  #itemCompleted(params: JsonValue, state: TranslatorState): readonly EventPayload[] {
    const item = itemFromNotification(params);
    switch (item.type) {
      case "agentMessage": {
        const text = typeof item["text"] === "string" ? safeText(item["text"], 1024 * 1024) : "";
        return [{
          type: "message_complete",
          role: "assistant",
          blocks: [{ kind: "text", text }],
          nativeHistory: { identity: { entryId: item.id } },
          ...(state.usage === undefined ? {} : { usage: state.usage })
        }];
      }
      case "commandExecution": {
        const output = typeof item["aggregatedOutput"] === "string" ? safeText(item["aggregatedOutput"], 256 * 1024) : "";
        const status = typeof item["status"] === "string" ? item["status"] : "failed";
        return [toolResult(item, state, output, status !== "completed")];
      }
      case "fileChange": {
        const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
        const output = changes.flatMap((change) => {
          if (!isJsonObject(change) || typeof change["path"] !== "string") return [];
          const kind = typeof change["kind"] === "string" ? change["kind"] : "changed";
          return [`${kind}: ${safePath(change["path"])}`];
        }).join("\n");
        return [toolResult(item, state, output, item["status"] === "failed")];
      }
      case "mcpToolCall": {
        const output = item["result"] === null || item["result"] === undefined
          ? ""
          : safeJson(item["result"], 256 * 1024);
        return [toolResult(item, state, output, item["error"] !== null && item["error"] !== undefined)];
      }
      case "dynamicToolCall": {
        const output = item["contentItems"] === undefined ? "" : safeJson(item["contentItems"], 256 * 1024);
        return [toolResult(item, state, output, item["success"] !== true)];
      }
      case "collabAgentToolCall":
        return [toolResult(item, state, safeText(String(item["status"] ?? "completed"), 256), item["status"] === "failed")];
      case "contextCompaction":
        return [{
          type: "compaction",
          reason: "native",
          compactionId: item.id,
          state: "completed"
        }];
      default:
        return [];
    }
  }
}

export interface InteractionRequest {
  readonly payload: InteractionPayload;
  readonly toResponse: (decision: InteractionDecision) => JsonValue;
}

export function interactionFromServerRequest(
  requestId: RpcId,
  method: string,
  params: JsonValue,
  workspaceRoot: string
): InteractionRequest | undefined {
  const record = objectValue(params, "interaction request");
  const interactionId = interactionIdentity(requestId, method, record);
  if (method === "item/commandExecution/requestApproval") {
    // The stable network approval presentation has different target semantics.
    // Until that target can be projected exactly, leave it to the host's safe
    // native denial instead of presenting a generic command approval.
    if (record["networkApprovalContext"] !== undefined && record["networkApprovalContext"] !== null) return undefined;
    const available = commandApprovalAvailability(record["availableDecisions"], record);
    if (available.malformed) return undefined;
    const choices = commandApprovalChoices(available.decisions, available.explicit);
    if (choices.length === 0) return undefined;
    const command = typeof record["command"] === "string" ? safeText(record["command"], 4_096) : "Command execution";
    const reason = typeof record["reason"] === "string" ? safeText(record["reason"], 1_024) : undefined;
    return {
      payload: {
        id: interactionId,
        kind: "permission",
        title: "Approve command execution",
        toolName: "command",
        summary: reason === undefined ? command : `${command}\n${reason}`,
        risk: "high",
        choices
      },
      toResponse: (decision) => ({ decision: commandApprovalDecision(decision, available.decisions) })
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const reason = typeof record["reason"] === "string" ? safeText(record["reason"], 2_048) : "Apply the proposed workspace change.";
    return {
      payload: {
        id: interactionId,
        kind: "permission",
        title: "Approve file changes",
        toolName: "file_change",
        summary: reason,
        risk: "high",
        choices: ["approve_once", "approve_session", "decline"]
      },
      toResponse: (decision) => ({ decision: approvalDecision(decision) })
    };
  }
  if (method === "item/permissions/requestApproval") {
    const requested = isJsonObject(record["permissions"]) ? record["permissions"] : {};
    const summary = permissionSummary(requested, workspaceRoot);
    return {
      payload: {
        id: interactionId,
        kind: "permission",
        title: "Approve additional permissions",
        toolName: "permissions",
        summary,
        risk: "high",
        choices: ["approve_once", "approve_session", "decline"]
      },
      toResponse: (decision) => {
        const selected = selectedDecision(decision);
        return selected === "approve_once" || selected === "approve_session"
          ? { permissions: requested, scope: selected === "approve_session" ? "session" : "turn" }
          : { permissions: {}, scope: "turn" };
      }
    };
  }
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(record["questions"]) ? record["questions"] : [];
    // Secret answers must never cross the durable Interaction boundary. Returning
    // no Interaction delegates to the host's native empty-answer response.
    if (questions.some((value) => isJsonObject(value) && (
      value["isSecret"] === true
      || (value["isSecret"] !== undefined && typeof value["isSecret"] !== "boolean")
      || (value["isOther"] !== undefined && typeof value["isOther"] !== "boolean")
    ))) return undefined;
    const projected = projectInteractionQuestions(questions);
    if (projected === undefined || projected.length === 0) return undefined;
    const fields = projected.map((question) => question.field);
    return {
      payload: {
        id: interactionId,
        kind: "question",
        title: "Codex needs input",
        prompt: "Answer the requested fields to continue the turn.",
        fields
      },
      toResponse: (decision) => {
        const answers = Object.create(null) as JsonObject;
        for (const question of projected) {
          const value = decision.kind === "question" ? decision.answers[question.field.id] : undefined;
          const answer = normalizeInteractionAnswer(question, value);
          answers[question.nativeId] = { answers: answer === undefined ? [] : [answer] };
        }
        return { answers };
      }
    };
  }
  return undefined;
}

function deltaEvent(
  type: "text_delta" | "thinking_delta",
  params: JsonValue,
  prefix = ""
): Extract<EventPayload, { readonly type: "text_delta" | "thinking_delta" }> {
  const record = objectValue(params, "content delta");
  const itemId = stringValue(record["itemId"], "delta item id");
  return {
    type,
    blockId: prefix.length === 0 ? itemId : `${prefix}:${itemId}`,
    delta: safeText(typeof record["delta"] === "string" ? record["delta"] : "", 64 * 1024),
    ...(numberValue(record["contentIndex"]) === undefined ? {} : { contentIndex: numberValue(record["contentIndex"]) })
  };
}

function itemFromNotification(params: JsonValue): NativeThreadItem {
  return parseThreadItem(objectValue(params, "item notification")["item"]);
}

export function toolIdentity(item: NativeThreadItem): { readonly name: string; readonly input: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "command", input: safeText(typeof item["command"] === "string" ? item["command"] : "Command execution", 8_192) };
    case "fileChange": {
      const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
      const paths = changes.flatMap((change) => isJsonObject(change) && typeof change["path"] === "string" ? [safePath(change["path"])] : []);
      return { name: "file_change", input: paths.join("\n") || "Workspace file change" };
    }
    case "mcpToolCall": {
      const server = typeof item["server"] === "string" ? safeIdentifier(safeText(item["server"], 128)) : "mcp";
      const tool = typeof item["tool"] === "string" ? safeIdentifier(safeText(item["tool"], 128)) : "tool";
      return { name: `${server}/${tool}`, input: safeJson(item["arguments"] ?? null, 16 * 1024) };
    }
    case "dynamicToolCall": {
      const namespace = typeof item["namespace"] === "string" ? `${safeIdentifier(safeText(item["namespace"], 128))}/` : "";
      const tool = typeof item["tool"] === "string" ? safeIdentifier(safeText(item["tool"], 128)) : "tool";
      return { name: `${namespace}${tool}`, input: safeJson(item["arguments"] ?? null, 16 * 1024) };
    }
    case "collabAgentToolCall":
      return { name: "collaboration", input: safeText(typeof item["prompt"] === "string" ? item["prompt"] : "Agent collaboration", 8_192) };
    default:
      return undefined;
  }
}

function toolResult(item: NativeThreadItem, state: TranslatorState, output: string, isError: boolean): EventPayload {
  const name = state.itemNames.get(item.id) ?? toolIdentity(item)?.name ?? "tool";
  state.itemNames.delete(item.id);
  return {
    type: "tool_result",
    callId: item.id,
    name,
    output: safeText(output, 256 * 1024),
    isError
  };
}

function usageFromNotification(params: JsonValue): UsageSnapshot {
  const record = objectValue(params, "token usage");
  const tokenUsage = objectValue(record["tokenUsage"], "thread token usage");
  const last = objectValue(tokenUsage["last"], "last token usage");
  const inputTokens = finiteToken(last["inputTokens"]);
  const outputTokens = finiteToken(last["outputTokens"]);
  const cacheReadTokens = finiteToken(last["cachedInputTokens"]);
  const cacheWriteTokens = finiteToken(last["cacheWriteInputTokens"]);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: finiteToken(last["totalTokens"]) || inputTokens + outputTokens,
    ...(finiteToken(tokenUsage["modelContextWindow"]) === 0 ? {} : { contextWindow: finiteToken(tokenUsage["modelContextWindow"]) }),
    cost: 0
  };
}

function finiteToken(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function publicTurnError(error: JsonObject | undefined | null) {
  const category = error?.["codexErrorInfo"];
  const categoryText = typeof category === "string"
    ? category
    : isJsonObject(category)
      ? Object.keys(category)[0]
      : undefined;
  const unauthorized = categoryText?.toLowerCase().includes("unauthorized") === true;
  const rateLimited = categoryText?.toLowerCase().includes("ratelimit") === true || categoryText?.toLowerCase().includes("usage") === true;
  return {
    code: unauthorized ? "CODEX_AUTH_REQUIRED" : rateLimited ? "CODEX_RATE_LIMITED" : "CODEX_TURN_FAILED",
    message: unauthorized
      ? "Codex authentication is required."
      : rateLimited
        ? "Codex could not continue because the active account reached a provider limit."
        : "The Codex turn failed.",
    phase: "stream",
    retryable: !unauthorized,
    stateMayHaveChanged: true,
    recovery: unauthorized
      ? "Sign in to the Codex account and explicitly retry the queued input."
      : "Inspect the durable timeline and explicitly retry only if another native turn is safe."
  } as const;
}

type InteractionQuestionField = Extract<InteractionPayload, { readonly kind: "question" }>["fields"][number];

interface ProjectedInteractionQuestion {
  readonly nativeId: string;
  readonly field: InteractionQuestionField;
  readonly optionByChoiceId?: ReadonlyMap<string, string>;
  readonly allowsOther: boolean;
}

function projectInteractionQuestions(values: readonly JsonValue[]): readonly ProjectedInteractionQuestion[] | undefined {
  if (values.length === 0 || values.length > MAXIMUM_INTERACTION_QUESTIONS) return undefined;
  const nativeIds = new Set<string>();
  const durableIds = new Set<string>();
  const projected: ProjectedInteractionQuestion[] = [];
  for (const [questionIndex, value] of values.entries()) {
    if (!isJsonObject(value)) return undefined;
    const nativeId = value["id"];
    const question = value["question"];
    if (typeof nativeId !== "string"
      || nativeId.length === 0
      || nativeId.length > MAXIMUM_INTERACTION_ID_CHARS
      || /[\u0000-\u001f\u007f]/.test(nativeId)
      || nativeIds.has(nativeId)
      || typeof question !== "string"
      || question.trim().length === 0) return undefined;
    nativeIds.add(nativeId);
    const fieldId = durableInteractionId(nativeId, "field", questionIndex, durableIds);
    durableIds.add(fieldId);
    if (value["header"] !== undefined && typeof value["header"] !== "string") return undefined;
    const description = typeof value["header"] === "string" && value["header"].trim().length > 0
      ? safeText(value["header"], 256)
      : undefined;
    const rawOptions = value["options"];
    if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions)) return undefined;
    if (Array.isArray(rawOptions) && rawOptions.length > MAXIMUM_INTERACTION_OPTIONS) return undefined;
    const optionByChoiceId = new Map<string, string>();
    const choices: { readonly id: string; readonly label: string; readonly description?: string }[] = [];
    if (Array.isArray(rawOptions)) {
      const nativeLabels = new Set<string>();
      const choiceIds = new Set<string>();
      for (const [optionIndex, option] of rawOptions.entries()) {
        if (!isJsonObject(option)
          || typeof option["label"] !== "string"
          || option["label"].trim().length === 0
          || option["label"].length > MAXIMUM_INTERACTION_ANSWER_CHARS
          || (option["description"] !== undefined && typeof option["description"] !== "string")) return undefined;
        const nativeLabel = option["label"];
        if (nativeLabels.has(nativeLabel)) continue;
        nativeLabels.add(nativeLabel);
        const choiceId = durableInteractionId(nativeLabel, `choice-${questionIndex + 1}`, optionIndex, choiceIds);
        choiceIds.add(choiceId);
        optionByChoiceId.set(choiceId, nativeLabel);
        choices.push({
          id: choiceId,
          label: safeText(nativeLabel, 256),
          ...(typeof option["description"] === "string" && option["description"].length > 0
            ? { description: safeText(option["description"], MAXIMUM_INTERACTION_TEXT_CHARS) }
            : {})
        });
      }
    }
    const base = {
      id: fieldId,
      label: safeText(question, MAXIMUM_INTERACTION_TEXT_CHARS),
      ...(description === undefined ? {} : { description }),
      required: true
    };
    projected.push(choices.length === 0
      ? {
          nativeId,
          field: { ...base, kind: "text", multiline: false, sensitive: false },
          allowsOther: false
        }
      : {
          nativeId,
          field: { ...base, kind: "single", choices },
          optionByChoiceId,
          allowsOther: value["isOther"] === true
        });
  }
  return projected;
}

function durableInteractionId(
  value: string,
  prefix: string,
  index: number,
  occupied: ReadonlySet<string>
): string {
  const redacted = redactDiagnosticText(value);
  const directlySafe = redacted === value
    && value.length <= 128
    && /^[A-Za-z0-9._:@/-]+$/.test(value)
    && !occupied.has(value);
  if (directlySafe) return value;
  const digest = createHash("sha256").update(`${prefix}\0${index}\0${value}`).digest("hex").slice(0, 24);
  return `${prefix}-${index + 1}-${digest}`;
}

function normalizeInteractionAnswer(
  question: ProjectedInteractionQuestion,
  value: string | boolean | readonly string[] | undefined
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const answer = typeof raw === "boolean" ? String(raw) : raw;
  if (question.optionByChoiceId === undefined) return boundedAnswer(answer);
  const nativeOption = question.optionByChoiceId.get(answer);
  if (nativeOption !== undefined) return nativeOption;
  return question.allowsOther ? boundedAnswer(answer) : undefined;
}

function boundedAnswer(value: string): string | undefined {
  const normalized = redactDiagnosticText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, MAXIMUM_INTERACTION_ANSWER_CHARS);
}

function commandApprovalChoices(
  decisions: readonly ScalarCommandApprovalDecision[],
  explicit: boolean
): readonly string[] {
  return decisions.flatMap((decision) => {
    if (decision === "accept") return ["approve_once"];
    if (decision === "acceptForSession") return ["approve_session"];
    if (decision === "decline") return ["decline"];
    return explicit ? ["cancel"] : [];
  });
}

function commandApprovalDecision(
  decision: InteractionDecision,
  available: readonly ScalarCommandApprovalDecision[]
): ScalarCommandApprovalDecision {
  const selected = selectedDecision(decision);
  const candidate = selected === "approve_once"
    ? "accept"
    : selected === "approve_session"
      ? "acceptForSession"
      : selected === "cancel" || decision.kind === "cancelled"
        ? "cancel"
        : "decline";
  if (available.includes(candidate)) return candidate;
  if (available.includes("decline")) return "decline";
  if (available.includes("cancel")) return "cancel";
  throw new ProtocolShapeError("no fail-closed command decision is available");
}

function approvalDecision(decision: InteractionDecision): "accept" | "acceptForSession" | "decline" | "cancel" {
  const selected = selectedDecision(decision);
  if (selected === "approve_once") return "accept";
  if (selected === "approve_session") return "acceptForSession";
  return decision.kind === "cancelled" ? "cancel" : "decline";
}

function selectedDecision(decision: InteractionDecision): string | undefined {
  if (decision.kind === "selected") return decision.value;
  if (decision.kind === "confirmed") return decision.confirmed ? "approve_once" : "decline";
  return undefined;
}

function interactionIdentity(requestId: RpcId, method: string, params: JsonObject): string {
  const threadId = typeof params["threadId"] === "string" ? params["threadId"] : "thread";
  const turnId = typeof params["turnId"] === "string" ? params["turnId"] : "turn";
  const itemId = typeof params["approvalId"] === "string"
    ? params["approvalId"]
    : typeof params["itemId"] === "string"
      ? params["itemId"]
      : String(requestId);
  const digest = createHash("sha256").update(`${threadId}\0${turnId}\0${method}\0${itemId}`).digest("hex").slice(0, 32);
  return `codex-interaction-${digest}`;
}

function permissionSummary(requested: JsonObject, workspaceRoot: string): string {
  const parts: string[] = [];
  const network = isJsonObject(requested["network"]) ? requested["network"] : undefined;
  if (network !== undefined) parts.push("Additional network access");
  const fileSystem = isJsonObject(requested["fileSystem"]) ? requested["fileSystem"] : undefined;
  if (fileSystem !== undefined) {
    for (const key of ["read", "write"] as const) {
      const values = Array.isArray(fileSystem[key]) ? fileSystem[key] : [];
      for (const value of values) {
        if (typeof value !== "string") continue;
        parts.push(`${key}: ${displayPath(value, workspaceRoot)}`);
      }
    }
  }
  return parts.length === 0 ? "Additional runtime permissions" : parts.join("\n");
}

function displayPath(path: string, workspaceRoot: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  if (rel.length === 0) return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return safePath(rel);
  return basename(path);
}

async function resolveManagedFile(blob: BlobRef, context: AdapterContext, resolvers: CodexInputResolvers): Promise<string> {
  if (resolvers.resolveFile === undefined) {
    throw adapterError({
      code: "CODEX_FILE_RESOLVER_MISSING",
      message: "A file attachment has no workspace path or managed resolver.",
      phase: "dispatch",
      recovery: "Restore the file in the workspace or configure the managed file resolver."
    });
  }
  const path = await resolvers.resolveFile(blob, context).catch(() => {
    throw adapterError({
      code: "CODEX_FILE_UNAVAILABLE",
      message: "A file attachment could not be resolved.",
      phase: "dispatch",
      retryable: true,
      recovery: "Restore the immutable file artifact and retry."
    });
  });
  return validateRegularFile(path);
}

async function resolveWorkspacePath(workspaceRoot: string, value: string): Promise<string> {
  if (isAbsolute(value)) {
    throw adapterError({
      code: "CODEX_WORKSPACE_PATH_DENIED",
      message: "Workspace attachments must use a relative path.",
      phase: "dispatch",
      recovery: "Choose a file from the active Target workspace."
    });
  }
  const root = await realpath(workspaceRoot).catch(() => {
    throw adapterError({
      code: "CODEX_WORKSPACE_UNAVAILABLE",
      message: "The active Target workspace is unavailable.",
      phase: "dispatch",
      retryable: true,
      recovery: "Restore the Target workspace and retry."
    });
  });
  const path = await validateRegularFile(resolve(root, value));
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw adapterError({
      code: "CODEX_WORKSPACE_PATH_DENIED",
      message: "A workspace attachment resolves outside the active Target.",
      phase: "dispatch",
      recovery: "Choose a regular file contained by the active Target workspace."
    });
  }
  return path;
}

async function validateRegularFile(path: string): Promise<string> {
  const original = await lstat(path).catch(() => {
    throw adapterError({
      code: "CODEX_FILE_UNAVAILABLE",
      message: "A local attachment is unavailable.",
      phase: "dispatch",
      retryable: true,
      recovery: "Restore the local attachment and retry."
    });
  });
  if (!original.isFile() || original.isSymbolicLink()) {
    throw adapterError({
      code: "CODEX_FILE_UNSAFE",
      message: "A local attachment is not a regular non-symlink file.",
      phase: "dispatch",
      recovery: "Choose a regular file."
    });
  }
  const canonical = await realpath(path).catch(() => {
    throw adapterError({
      code: "CODEX_FILE_UNAVAILABLE",
      message: "A local attachment is unavailable.",
      phase: "dispatch",
      retryable: true,
      recovery: "Restore the local attachment and retry."
    });
  });
  const info = await lstat(canonical).catch(() => undefined);
  if (info?.isFile() !== true || info.isSymbolicLink()) {
    throw adapterError({
      code: "CODEX_FILE_UNSAFE",
      message: "A local attachment is not a regular file.",
      phase: "dispatch",
      recovery: "Choose a regular file."
    });
  }
  return canonical;
}

function isSafeMentionReference(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || /[?#]/.test(value)) return false;
  return /^(?:app|plugin):\/\/[A-Za-z0-9._@/-]+$/.test(value);
}

export function safeText(value: string, limit: number): string {
  const normalized = redactDiagnosticText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n[truncated]`;
}

function redactDiagnosticText(value: string): string {
  let redacted = redactSecrets(value);
  redacted = redacted.replace(
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|$)/g,
    "[REDACTED PRIVATE KEY]"
  );
  redacted = redacted.replace(
    /\b(?:(?:pk|rk)-[A-Za-z0-9][A-Za-z0-9._-]{6,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|LTAI[A-Za-z0-9]{16,}|A(?:KIA|SIA)[A-Z0-9]{16}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    "[REDACTED]"
  );
  redacted = redacted.replace(
    /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@\s/]+@/g,
    "$1[REDACTED]@"
  );
  redacted = redacted.replace(
    /((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi,
    "$1[REDACTED]"
  );
  redacted = redacted.replace(
    /((?:["']?)(?:x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|secret|password|passwd|token)(?:["']?)\s*(?:=|:)\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    "$1[REDACTED]"
  );
  redacted = redacted.replace(
    /((?:["']?)[A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?key|secret|password|passwd|token|credential|private[-_]?key)[A-Za-z0-9_.-]*(?:["']?)\s*(?:=|:)\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    "$1[REDACTED]"
  );
  return redacted;
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError(`Codex ${label} bound must be a positive integer.`);
  }
  return selected;
}

export function safeJson(value: JsonValue, limit: number): string {
  try {
    return safeText(JSON.stringify(value), limit);
  } catch {
    return "[unavailable structured output]";
  }
}

export function safePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return safeText(parts.slice(-4).join("/"), 1_024);
}

export function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "tool";
}

function rememberTerminal(values: Set<string>, turnId: string): void {
  values.add(turnId);
  while (values.size > 128) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

function rememberItemName(values: Map<string, string>, itemId: string, name: string): void {
  values.delete(itemId);
  while (values.size >= MAXIMUM_TRACKED_TOOL_ITEMS) {
    const oldest = values.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
  values.set(itemId, name);
}
