import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  redactSecrets,
  NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD,
  type AdapterContext,
  type AdapterEventMetadata,
  type BlobRef,
  type EventPayload,
  type MessageBlock,
  type PiEventMetadata,
  type PublicError,
  type ToolResultContentPart
} from "@joko/core";
import { PiAdapterError, piError, redactManagedSecrets, redactedDiagnostic } from "./errors.js";
import { isPiCompactionNoopEvent } from "./compaction.js";
import type { PiNativeHistoryEntry } from "./native-history.js";
import { isRecord, type PiRpcEvent } from "./protocol.js";
import { projectMessageGenerationTiming, projectMessageUsage } from "./message-usage.js";
import { projectPiSubagentActivity, type ProjectedPiSubagentActivity } from "./subagent-progress.js";

const INLINE_OUTPUT_LIMIT = 256 * 1024;

type ProviderFailureKind = "context_overflow" | "stream_interrupted" | "upstream_overload" | "generic";

export interface PiEventTranslatorOptions {
  readonly context: AdapterContext;
  readonly artifactDirectory: string;
  readonly wasAbortRequested: () => boolean;
  readonly redactValues?: readonly string[];
  /** Shared for one product session so online and native hydration reuse one BlobRef. */
  readonly artifactCache?: Map<string, BlobRef>;
}

export class PiEventTranslator {
  #context: AdapterContext;
  readonly #artifactDirectory: string;
  readonly #wasAbortRequested: () => boolean;
  readonly #redactValues: readonly string[];
  readonly #artifactCache: Map<string, BlobRef>;
  #assistantMessageOrdinal = 0;
  #activeMessageBlockPrefix = "assistant-0";
  #activeCompactionId: string | undefined;
  #latestSummarizationRetryAttempt: number | undefined;
  readonly #privateMemoryToolCalls = new Set<string>();
  #lastOutcome: "completed" | "aborted" | "failed" = "completed";
  #pendingAssistantError: {
    readonly message: string;
    readonly metadata: AdapterEventMetadata;
    readonly kind: ProviderFailureKind;
  } | undefined;

  constructor(options: PiEventTranslatorOptions) {
    this.#context = options.context;
    this.#artifactDirectory = options.artifactDirectory;
    this.#wasAbortRequested = options.wasAbortRequested;
    this.#redactValues = options.redactValues ?? [];
    this.#artifactCache = options.artifactCache ?? new Map();
  }

  setContext(context: AdapterContext): void {
    if (context.generation !== this.#context.generation) this.#resetRunOutcome();
    this.#context = context;
  }

  /**
   * Strip Pi's inline image bytes from a native JSONL entry and replace them
   * with durable BlobRefs before the value crosses the Adapter boundary.
   */
  async materializeNativeHistoryEntry(entry: PiNativeHistoryEntry): Promise<PiNativeHistoryEntry> {
    const data = { ...entry.data };
    const message = isRecord(data.message) ? data.message : undefined;
    if (message?.role === "bashExecution") {
      const { fullOutputPath, ...safeMessage } = message;
      const materialized = typeof fullOutputPath === "string"
        ? await this.#materializeNativeOutput(fullOutputPath, `user-shell-${entry.id}.log`, entry.id)
        : {};
      data.message = {
        ...safeMessage,
        command: redactManagedSecrets(typeof message.command === "string" ? message.command : "", this.#redactValues),
        output: redactManagedSecrets(typeof message.output === "string" ? message.output : "", this.#redactValues),
        ...(materialized.artifact === undefined ? {} : { fullOutputArtifact: materialized.artifact }),
        ...(materialized.unavailable === true ? { fullOutputUnavailable: true } : {})
      };
    } else if (message !== undefined) {
      const details = isRecord(message.details) ? message.details : undefined;
      const { fullOutputPath, ...safeDetails } = details ?? {};
      const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
      const isToolResult = message.role === "toolResult";
      const bridgedImages = isToolResult && isManagedMcpToolName(toolName)
        ? trustedMcpImageOutputs(details, this.#artifactCapacityBytes())
        : [];
      const bridgedArtifact = isToolResult && isManagedMcpToolName(toolName)
        ? trustedMcpCompleteOutput(details, this.#artifactCapacityBytes())
        : undefined;
      const materialized = bridgedArtifact === undefined &&
        isToolResult &&
        toolName.toLowerCase() === "bash" &&
        typeof fullOutputPath === "string"
          ? await this.#materializeNativeOutput(fullOutputPath, `${toolName}-${entry.id}.log`, entry.id)
          : {};
      const fullOutputArtifact = bridgedArtifact ?? materialized.artifact;
      const materializedContent = await this.#materializeNativeContent(message.content);
      data.message = {
        ...message,
        content: nativeContentWithImages(materializedContent, bridgedImages),
        ...(details === undefined ? {} : { details: safeDetails }),
        ...(fullOutputArtifact === undefined ? {} : { fullOutputArtifact }),
        ...(materialized.unavailable === true ? { fullOutputUnavailable: true } : {})
      };
    } else if (Object.hasOwn(data, "content")) {
      data.content = await this.#materializeNativeContent(data.content);
    }
    return {
      ...entry,
      data: this.#redactNativeValue(data) as Readonly<Record<string, unknown>>
    };
  }

  async translate(event: PiRpcEvent, terminalContexts?: readonly AdapterContext[]): Promise<void> {
    const record = event as unknown as Record<string, unknown>;
    const nativeSummarizationRetryAttempt = positiveRetryAttempt(record.attempt);
    const summarizationRetryAttempt = event.type === "summarization_retry_scheduled"
      ? nativeSummarizationRetryAttempt
      : event.type === "summarization_retry_attempt_start" || event.type === "summarization_retry_finished"
        ? nativeSummarizationRetryAttempt ?? this.#latestSummarizationRetryAttempt
        : undefined;
    const compactionId = event.type === "compaction_start" || event.type === "compaction_end"
      ? this.#compactionId(event.type)
      : undefined;
    const metadataRecord = compactionId === undefined ? record : { ...record, compactionId };
    const metadata = nativeMetadata(summarizationRetryAttempt === undefined
      ? metadataRecord
      : { ...metadataRecord, attempt: summarizationRetryAttempt });
    switch (event.type) {
      case "agent_start":
        this.#resetRunOutcome();
        await this.#emit({ type: "run_state", state: "running" }, metadata);
        return;
      case "agent_end":
        // This low-level boundary may be followed by a transparent provider
        // retry. The durable retry lifecycle below is the authoritative state;
        // surfacing this boundary would reveal otherwise-silent retries.
        return;
      case "agent_settled": {
        const abortRequested = this.#wasAbortRequested();
        const failures: unknown[] = [];
        if (abortRequested) {
          this.#pendingAssistantError = undefined;
          this.#lastOutcome = "aborted";
        } else {
          try {
            await this.#settlePendingAssistantError();
          } catch (error) {
            // A terminal error and terminal lifecycle are independent durable
            // facts. Attempt every participant's settlement even if the error
            // event itself is rejected.
            failures.push(error);
          }
        }
        const outcome = abortRequested ? "aborted" : this.#lastOutcome;
        const contexts = terminalContexts === undefined || terminalContexts.length === 0
          ? [this.#context]
          : uniqueContexts(terminalContexts);
        for (const context of contexts) {
          try {
            await this.#emitTo(context, { type: "run_state", state: outcome }, metadata);
          } catch (error) {
            failures.push(error);
          }
          try {
            await this.#emitTo(context, { type: "done", outcome }, metadata);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, "One or more Pi lifecycle participants rejected terminal events");
        return;
      }
      case "turn_start":
        await this.#emit({ type: "status", key: "pi.turn", text: "running" }, metadata);
        return;
      case "turn_end":
        await this.#emit({ type: "status", key: "pi.turn" }, metadata);
        return;
      case "message_start":
        if (isRecord(record.message) && record.message.role === "assistant") {
          this.#assistantMessageOrdinal += 1;
          this.#activeMessageBlockPrefix = `assistant-${this.#assistantMessageOrdinal}`;
        }
        return;
      case "message_update":
        await this.#translateMessageUpdate(record, metadata);
        return;
      case "message_end":
        await this.#translateMessageEnd(record, metadata);
        return;
      case "bash_execution_update":
        await this.#emit(
          {
            type: "tool_update",
            callId: typeof record.id === "string" ? record.id : "direct-bash",
            name: "Shell",
            outputMode: "append",
            output: contentText(record.delta)
          },
          metadata
        );
        return;
      case "tool_execution_start":
        if (isPrivateMemoryToolName(stringValue(record.toolName, "unknown"))) {
          this.#privateMemoryToolCalls.add(stringValue(record.toolCallId, "unknown-tool-call"));
        }
        const toolName = stringValue(record.toolName, "unknown");
        await this.#emit(
          {
            type: "tool_start",
            callId: stringValue(record.toolCallId, "unknown-tool-call"),
            name: toolName,
            input: isPrivateMemoryToolName(toolName)
              ? "[private memory payload withheld]"
              : isPrivateRemoteExecutionToolName(toolName)
                ? "[remote execution command and input withheld]"
              : isPrivateVisionToolName(toolName)
                ? "[vision image path and focus withheld]"
              : safeStringify(record.args)
          },
          metadata
        );
        return;
      case "tool_execution_update":
        await this.#translateSubagentActivity(record.partialResult, metadata);
        await this.#translateToolOutput(record, "partialResult", false, metadata);
        return;
      case "tool_execution_end":
        await this.#translateSubagentActivity(record.result, metadata);
        await this.#translateToolOutput(record, "result", record.isError === true, metadata);
        this.#privateMemoryToolCalls.delete(stringValue(record.toolCallId, "unknown-tool-call"));
        return;
      case "queue_update":
        await this.#emit(
          {
            type: "queue_update",
            steering: stringArray(record.steering),
            followUps: stringArray(record.followUp)
          },
          metadata
        );
        return;
      case "compaction_start": {
        if (compactionId === undefined) throw new Error("Pi compaction event is missing its normalized identity.");
        const reason = compactionReason(record.reason);
        await this.#emit({
          type: "compaction",
          reason,
          compactionId,
          state: "started",
          automatic: automaticCompactionReason(reason)
        }, metadata);
        return;
      }
      case "compaction_end": {
        if (compactionId === undefined) throw new Error("Pi compaction event is missing its normalized identity.");
        const result = isRecord(record.result) ? record.result : undefined;
        const reason = compactionReason(record.reason);
        const state = compactionState(record, "compaction_end");
        const boundaryEntryId = boundedMetadataText(result?.firstKeptEntryId, "", 512);
        const tokensBefore = optionalMetadataUnsigned(result?.tokensBefore);
        const tokensAfter = optionalMetadataUnsigned(result?.estimatedTokensAfter);
        const boundedErrorMessage = !isPiCompactionNoopEvent(record) && typeof record.errorMessage === "string"
          ? boundedMetadataText(record.errorMessage, "", 1_024)
          : undefined;
        const reportedErrorMessage = boundedErrorMessage === "" ? undefined : boundedErrorMessage;
        const errorMessage = reportedErrorMessage === undefined && state === "failed"
          ? "Pi compaction ended without an authoritative result"
          : reportedErrorMessage;
        const error = errorMessage === undefined
          ? undefined
          : publicError("PI_COMPACTION_FAILED", errorMessage, "compaction", record.willRetry === true);
        try {
          await this.#emit(
            {
              type: "compaction",
              reason,
              ...(result && typeof result.summary === "string" ? { summary: result.summary } : {}),
              compactionId,
              state,
              ...(boundaryEntryId === "" ? {} : { boundaryEntryId }),
              ...(tokensBefore === undefined ? {} : { tokensBefore }),
              ...(tokensAfter === undefined ? {} : { tokensAfter }),
              automatic: automaticCompactionReason(reason),
              ...(typeof record.willRetry === "boolean" ? { willRetry: record.willRetry } : {}),
              ...(error === undefined ? {} : { error })
            },
            metadata
          );
          if (errorMessage !== undefined) {
            this.#lastOutcome = "failed";
            await this.#emitError("PI_COMPACTION_FAILED", errorMessage, false, metadata);
          }
        } finally {
          if (this.#activeCompactionId === compactionId) this.#activeCompactionId = undefined;
        }
        return;
      }
      case "auto_retry_start":
        const retryAttempt = positiveRetryAttempt(record.attempt) ?? 1;
        const retryMessage = redactManagedSecrets(
          typeof record.errorMessage === "string"
            ? record.errorMessage
            : this.#pendingAssistantError?.message ?? "",
          this.#redactValues
        );
        const retryKind = classifyProviderFailure(retryMessage);
        const retryNotice = retryAttempt >= 2 && retryKind === "upstream_overload"
          ? classifiedProviderError(retryKind, retryMessage, "retry", true)
          : undefined;
        await this.#emit(
          {
            type: "retry",
            state: "waiting",
            attempt: retryAttempt,
            ...(typeof record.maxAttempts === "number" && Number.isFinite(record.maxAttempts)
              ? { maxAttempts: record.maxAttempts }
              : {}),
            delayMs: numberValue(record.delayMs, 0),
            ...(retryNotice === undefined ? {} : { error: retryNotice })
          },
          withRetryUpdateError(metadata, retryNotice)
        );
        return;
      case "auto_retry_end": {
        const abortRequested = this.#wasAbortRequested();
        const retryState = record.success === true
          ? "succeeded"
          : record.success === false ? (abortRequested ? "aborted" : "exhausted") : "unknown";
        let terminalFailure: { readonly message: string; readonly kind: ProviderFailureKind } | undefined;
        if (record.success === true) {
          this.#pendingAssistantError = undefined;
        } else if (record.success === false && abortRequested) {
          this.#pendingAssistantError = undefined;
          this.#lastOutcome = "aborted";
        } else if (record.success === false) {
          const pending = this.#pendingAssistantError;
          this.#pendingAssistantError = undefined;
          this.#lastOutcome = "failed";
          const finalMessage = redactManagedSecrets(
            typeof record.finalError === "string" && record.finalError.trim() !== ""
              ? record.finalError
              : pending?.message ?? "Pi retry attempts were exhausted",
            this.#redactValues
          );
          const finalKind = classifyProviderFailure(finalMessage);
          terminalFailure = {
            message: finalMessage,
            kind: finalKind === "generic" && pending !== undefined ? pending.kind : finalKind
          };
        }
        const exhaustedError = terminalFailure === undefined
          ? undefined
          : classifiedProviderError(terminalFailure.kind, terminalFailure.message, "retry", false, "PI_RETRY_EXHAUSTED");
        await this.#emit(
          {
            type: "retry",
            state: retryState,
            attempt: numberValue(record.attempt, 1),
            ...(exhaustedError === undefined ? {} : { error: exhaustedError })
          },
          metadata
        );
        if (terminalFailure !== undefined) {
          await this.#emitClassifiedProviderError(
            terminalFailure.kind,
            terminalFailure.message,
            true,
            metadata,
            "PI_RETRY_EXHAUSTED"
          );
        }
        return;
      }
      case "summarization_retry_scheduled": {
        if (summarizationRetryAttempt === undefined) return;
        this.#latestSummarizationRetryAttempt = summarizationRetryAttempt;
        await this.#emit(
          {
            type: "retry",
            state: "waiting",
            attempt: summarizationRetryAttempt,
            ...(typeof record.maxAttempts === "number" && Number.isFinite(record.maxAttempts)
              ? { maxAttempts: record.maxAttempts }
              : {}),
            delayMs: numberValue(record.delayMs, 0),
            error: publicError("PI_SUMMARIZATION_RETRY", stringValue(record.errorMessage, "Summarization retry scheduled"), "retry", true)
          },
          metadata
        );
        return;
      }
      case "summarization_retry_attempt_start":
        if (summarizationRetryAttempt === undefined) return;
        await this.#emit({
          type: "retry",
          state: "started",
          attempt: summarizationRetryAttempt
        }, metadata);
        return;
      case "summarization_retry_finished":
        if (summarizationRetryAttempt === undefined) return;
        await this.#emit({
          type: "retry",
          state: "unknown",
          attempt: summarizationRetryAttempt
        }, metadata);
        this.#latestSummarizationRetryAttempt = undefined;
        return;
      case "extension_error":
        await this.#emitError("PI_EXTENSION_ERROR", stringValue(record.error, "Pi extension failed"), false, metadata);
        return;
      case "entry_appended":
        await this.#emit(
          {
            type: "status",
            key: "pi.entry_appended",
            text: isRecord(record.entry) && typeof record.entry.id === "string" ? record.entry.id : undefined
          },
          metadata
        );
        return;
      case "session_info_changed":
        await this.#emit(
          { type: "status", key: "pi.session_name", text: typeof record.name === "string" ? record.name : undefined },
          metadata
        );
        return;
      case "thinking_level_changed":
        await this.#emit(
          { type: "status", key: "pi.thinking_level", text: typeof record.level === "string" ? record.level : undefined },
          metadata
        );
        return;
      default:
        await this.#emit(
          { type: "status", key: `pi.native.${event.type}`, text: "Native Pi event preserved through namespaced metadata" },
          metadata
        );
    }
  }

  async #translateMessageUpdate(record: Record<string, unknown>, metadata: AdapterEventMetadata): Promise<void> {
    if (!isRecord(record.assistantMessageEvent)) return;
    const delta = record.assistantMessageEvent;
    const index = numberValue(delta.contentIndex, 0);
    const blockId = `${this.#activeMessageBlockPrefix}-${index}`;
    // Current Pi message updates are delta-only. Empty deltas are protocol
    // no-ops and must not create durable empty blocks.
    if (delta.type === "text_delta" && typeof delta.delta === "string" && delta.delta.length > 0) {
      await this.#emit({ type: "text_delta", blockId, delta: delta.delta, contentIndex: index }, withContentIndex(metadata, index));
    } else if (
      delta.type === "thinking_delta"
      && typeof delta.delta === "string"
      && delta.delta.length > 0
      && !isRedactedThinkingUpdate(delta)
    ) {
      await this.#emit({ type: "thinking_delta", blockId, delta: delta.delta, contentIndex: index }, withContentIndex(metadata, index));
    }
    // Pi's toolcall_* message updates describe the model generating arguments;
    // they are not tool execution lifecycle events. In particular, JSON-mode
    // toolcall_delta events intentionally have no call id. Pi always follows
    // the completed assistant message with an authoritative
    // tool_execution_start carrying the stable id, name, and final arguments,
    // including validation-error and truncated-tool-call paths. Project only
    // that event as tool_start so one native call cannot create a synthetic
    // assistant-<message>-<content> tool card or leave the real card input empty.
  }

  async #translateMessageEnd(record: Record<string, unknown>, metadata: AdapterEventMetadata): Promise<void> {
    if (!isRecord(record.message)) return;
    const role = record.message.role;
    if (role === "custom") {
      await this.#translateSubagentActivity(record.message, metadata);
      return;
    }
    if (role !== "user" && role !== "assistant") return;
    if (role === "assistant") {
      if (record.message.stopReason === "aborted") {
        this.#pendingAssistantError = undefined;
        this.#lastOutcome = "aborted";
      } else if (record.message.stopReason === "error") {
        // Pi emits message_end(error) before agent_end reveals whether the
        // provider failure will be retried. Keep it provisional until either
        // auto_retry_end(false) or the one true lifecycle terminal,
        // agent_settled. A later successful assistant message proves recovery.
        const message = redactManagedSecrets(
            stringValue(record.message.errorMessage, "Pi provider response failed"),
            this.#redactValues
          );
        this.#pendingAssistantError = {
          message,
          metadata,
          kind: classifyProviderFailure(message)
        };
      } else {
        this.#pendingAssistantError = undefined;
        this.#lastOutcome = "completed";
      }
    }
    const blocks = await this.#messageBlocks(record.message);
    const usage = role === "assistant" ? projectMessageUsage(record.message.usage) : undefined;
    const generationTiming = usage === undefined
      ? undefined
      : projectMessageGenerationTiming(record.message.duration);
    await this.#emit({
      type: "message_complete",
      role,
      blocks,
      ...(usage === undefined ? {} : { usage, ...generationTiming })
    }, metadata);
  }

  async #messageBlocks(message: Record<string, unknown>): Promise<readonly MessageBlock[]> {
    if (typeof message.content === "string") return [{ kind: "text", text: message.content }];
    if (!Array.isArray(message.content)) return [];
    const blocks: MessageBlock[] = [];
    for (const value of message.content) {
      if (!isRecord(value) || typeof value.type !== "string") continue;
      if (value.type === "text" && typeof value.text === "string") {
        blocks.push({ kind: "text", text: value.text });
      } else if ((value.type === "thinking" || value.type === "reasoning") && typeof value.thinking === "string") {
        const redacted = value.redacted === true;
        blocks.push({
          kind: "thinking",
          text: redacted ? "[redacted by provider]" : value.thinking,
          redacted
        });
      } else if (value.type === "redacted_thinking") {
        blocks.push({ kind: "thinking", text: "[redacted by provider]", redacted: true });
      } else if (value.type === "toolCall") {
        const toolName = stringValue(value.name, "unknown");
        const privateMemory = isPrivateMemoryToolName(toolName);
        blocks.push({
          kind: "tool_call",
          callId: stringValue(value.id, randomUUID()),
          name: toolName,
          input: privateMemory
            ? "[private memory payload withheld]"
            : isPrivateRemoteExecutionToolName(toolName)
              ? "[remote execution command and input withheld]"
            : isPrivateVisionToolName(toolName)
              ? "[vision image path and focus withheld]"
              : safeStringify(value.arguments)
        });
      } else if (value.type === "image" && typeof value.data === "string") {
        const image = await this.#materializeImageBlock(value);
        blocks.push({ kind: "image", blob: image.blob, ...(image.alt === undefined ? {} : { alt: image.alt }) });
      }
    }
    return blocks;
  }

  async #translateToolOutput(
    record: Record<string, unknown>,
    field: "partialResult" | "result",
    isError: boolean,
    metadata: AdapterEventMetadata
  ): Promise<void> {
    const callId = stringValue(record.toolCallId, "unknown-tool-call");
    const name = stringValue(record.toolName, "tool");
    if (this.#privateMemoryToolCalls.has(callId) || isPrivateMemoryToolName(stringValue(record.toolName, ""))) {
      await this.#emit(
        field === "partialResult"
          ? { type: "tool_update", callId, name, output: "[private memory result withheld]", parts: [] }
          : { type: "tool_result", callId, name, output: "[private memory result withheld]", parts: [], isError },
        metadata
      );
      return;
    }
    const result = isRecord(record[field]) ? record[field] : undefined;
    const toolName = stringValue(record.toolName, "tool");
    const details = result && isRecord(result.details) ? result.details : undefined;
    let projection: { readonly output: string; readonly parts: readonly ToolResultContentPart[] };
    try {
      projection = await this.#projectToolContent(result);
      if (isManagedMcpToolName(toolName)) {
        const images = trustedMcpImageOutputs(details, this.#artifactCapacityBytes());
        if (images.length > 0) projection = { ...projection, parts: [...projection.parts, ...images] };
      }
    } catch (error) {
      await this.#emitError(
        error instanceof PiAdapterError ? error.publicError.code : "PI_ARTIFACT_STORE_FAILED",
        redactedDiagnostic(error),
        false,
        metadata
      );
      const safeOutput = redactManagedSecrets(extractToolText(result), this.#redactValues);
      projection = {
        output: safeOutput,
        parts: safeOutput === "" ? [] : [{ kind: "text", text: safeOutput }]
      };
    }
    const output = projection.output;
    let artifact: BlobRef | undefined;
    const fullOutputPath = toolName.toLowerCase() === "bash" && typeof details?.fullOutputPath === "string"
      ? details.fullOutputPath
      : undefined;
    try {
      artifact = isManagedMcpToolName(toolName)
        ? trustedMcpCompleteOutput(details, this.#artifactCapacityBytes())
        : undefined;
      if (artifact !== undefined) {
        // The service-owned bridge already persisted the complete, redacted
        // result. Do not re-materialize its bounded display preview.
      } else if (fullOutputPath) {
        artifact = await this.#storeRedactedToolOutput(
          fullOutputPath,
          `${toolName}-${callId}.log`
        );
      } else if (Buffer.byteLength(output, "utf8") > INLINE_OUTPUT_LIMIT) {
        artifact = await this.#storeText(output, ".log", "text/plain");
      }
    } catch (error) {
      await this.#emitError(
        error instanceof PiAdapterError ? error.publicError.code : "PI_ARTIFACT_STORE_FAILED",
        redactedDiagnostic(error),
        false,
        metadata
      );
    }
    const outputIsLarge = Buffer.byteLength(output, "utf8") > INLINE_OUTPUT_LIMIT;
    const inlineOutput = outputIsLarge
        ? `${Buffer.from(output, "utf8").subarray(0, INLINE_OUTPUT_LIMIT).toString("utf8")}\n${artifact === undefined
          ? "[full output artifact unavailable]"
          : "[full output stored as artifact]"}`
        : output;
    const eventParts = outputIsLarge
      ? [
          ...(inlineOutput === "" ? [] : [{ kind: "text" as const, text: inlineOutput }]),
          ...projection.parts.filter((part) => part.kind !== "text")
        ]
      : projection.parts;
    await this.#emit(
      field === "partialResult"
        ? { type: "tool_update", callId, name, output: inlineOutput, parts: eventParts, artifact }
        : { type: "tool_result", callId, name, output: inlineOutput, parts: eventParts, isError, artifact },
      metadata
    );
  }

  async #projectToolContent(
    result: Record<string, unknown> | undefined
  ): Promise<{ readonly output: string; readonly parts: readonly ToolResultContentPart[] }> {
    if (!result || !Array.isArray(result.content)) return { output: "", parts: [] };
    const parts: ToolResultContentPart[] = [];
    const text: string[] = [];
    for (const value of result.content) {
      if (!isRecord(value)) continue;
      if (value.type === "text" && typeof value.text === "string") {
        const redacted = redactManagedSecrets(value.text, this.#redactValues);
        text.push(redacted);
        parts.push({ kind: "text", text: redacted });
      } else if (value.type === "image" && typeof value.data === "string") {
        const image = await this.#materializeImageBlock(value);
        parts.push({ kind: "image", blob: image.blob, ...(image.alt === undefined ? {} : { alt: image.alt }) });
      }
    }
    return { output: text.join("\n"), parts };
  }

  async #materializeNativeContent(content: unknown): Promise<unknown> {
    if (!Array.isArray(content)) return content;
    const projected: unknown[] = [];
    for (const value of content) {
      if (!isRecord(value) || value.type !== "image") {
        projected.push(value);
        continue;
      }
      if (isBlobRef(value.blob)) {
        projected.push({
          type: "image",
          blob: value.blob,
          ...(typeof value.alt === "string" ? { alt: value.alt } : {})
        });
        continue;
      }
      const image = await this.#materializeImageBlock(value);
      projected.push({
        type: "image",
        blob: image.blob,
        ...(image.alt === undefined ? {} : { alt: image.alt })
      });
    }
    return projected;
  }

  async #materializeImageBlock(value: Readonly<Record<string, unknown>>): Promise<{ readonly blob: BlobRef; readonly alt?: string }> {
    const mimeType = imageMimeType(value.mimeType);
    const bytes = decodeImageBase64(value.data, this.#artifactCapacityBytes());
    const blob = await this.#storeBytes(bytes, extensionForMime(mimeType), mimeType);
    const alt = typeof value.alt === "string"
      ? redactManagedSecrets(value.alt, this.#redactValues)
      : undefined;
    return { blob, ...(alt === undefined ? {} : { alt }) };
  }

  async #translateSubagentActivity(value: unknown, metadata: AdapterEventMetadata): Promise<void> {
    const projected = projectPiSubagentActivity(value);
    if (projected === undefined) return;
    await this.#emit(projected.event, subagentMetadata(metadata, projected));
  }

  async #storeBytes(bytes: Uint8Array, extension: string, mimeType: string, fileName?: string): Promise<BlobRef> {
    if (bytes.byteLength > this.#artifactCapacityBytes()) {
      throw piError(
        "PI_ARTIFACT_CAPACITY_EXCEEDED",
        "Pi output exceeds the host Artifact capacity",
        "stream",
        { recovery: "Increase Artifact storage capacity or request a smaller result." }
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const cacheKey = `${mimeType}\0${digest}`;
    const cached = this.#artifactCache.get(cacheKey);
    if (cached !== undefined) return cached;
    await mkdir(this.#artifactDirectory, { recursive: true });
    const path = join(this.#artifactDirectory, `${randomUUID()}${extension}`);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const artifact = await this.#context.storeArtifact(path, {
      fileName: fileName ?? `pi-${digest.slice(0, 16)}${extension}`,
      mimeType
    });
    this.#artifactCache.set(cacheKey, artifact);
    return artifact;
  }

  async #storeText(value: string, extension: string, mimeType: string, fileName?: string): Promise<BlobRef> {
    if (Buffer.byteLength(value, "utf8") > this.#artifactCapacityBytes()) {
      throw piError(
        "PI_ARTIFACT_CAPACITY_EXCEEDED",
        "Pi output exceeds the host Artifact capacity",
        "stream",
        { recovery: "Increase Artifact storage capacity or request a smaller result." }
      );
    }
    return this.#storeBytes(Buffer.from(value, "utf8"), extension, mimeType, fileName);
  }

  async #storeRedactedToolOutput(sourcePath: string, fileName: string): Promise<BlobRef> {
    try {
      const [root, canonical, linkInfo, info] = await Promise.all([
        realpath(this.#artifactDirectory),
        realpath(sourcePath),
        lstat(sourcePath),
        stat(sourcePath)
      ]);
      const suffix = relative(root, canonical);
      const contained = suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
      if (!contained || linkInfo.isSymbolicLink() || !info.isFile()) {
        throw piError("PI_ARTIFACT_SOURCE_INVALID", "Pi tool output is not a regular runtime file", "stream");
      }
      if (info.size > this.#artifactCapacityBytes()) {
        throw piError(
          "PI_ARTIFACT_CAPACITY_EXCEEDED",
          "Pi tool output exceeds the host Artifact capacity",
          "stream",
          { recovery: "Increase Artifact storage capacity or request a smaller result." }
        );
      }
      const redacted = redactManagedSecrets(await readFile(canonical, "utf8"), this.#redactValues);
      return this.#storeText(redacted, ".log", "text/plain", fileName);
    } catch (error) {
      if (error instanceof PiAdapterError) throw error;
      throw piError(
        "PI_ARTIFACT_SOURCE_UNAVAILABLE",
        "Pi tool output source is unavailable",
        "stream",
        { retryable: true, cause: error }
      );
    }
  }

  async #materializeNativeOutput(
    sourcePath: string,
    fileName: string,
    entryId: string
  ): Promise<{ readonly artifact?: BlobRef; readonly unavailable?: true }> {
    try {
      return { artifact: await this.#storeRedactedToolOutput(sourcePath, fileName) };
    } catch (error) {
      const publicError: PublicError = error instanceof PiAdapterError
        ? error.publicError
        : {
            code: "PI_ARTIFACT_STORE_FAILED",
            message: "Pi native complete output could not be stored",
            phase: "stream",
            retryable: true,
            stateMayHaveChanged: false,
            recovery: "The native preview remains available; restore Artifact storage before requesting complete output."
          };
      await this.#context.emit(
        { type: "error", error: publicError, terminal: false },
        {
          namespace: "pi.native_history",
          fields: { nativeHydration: true, entryId, completeOutputUnavailable: true }
        }
      );
      return { unavailable: true };
    }
  }

  #artifactCapacityBytes(): number {
    if (!Number.isSafeInteger(this.#context.artifactCapacityBytes) || this.#context.artifactCapacityBytes < 1) {
      throw piError("PI_ARTIFACT_CAPABILITY_INVALID", "Host Artifact capacity is invalid", "resource");
    }
    return this.#context.artifactCapacityBytes;
  }

  #redactNativeValue(value: unknown): unknown {
    if (typeof value === "string") return redactManagedSecrets(value, this.#redactValues);
    if (Array.isArray(value)) return value.map((item) => this.#redactNativeValue(item));
    if (!isRecord(value)) return value;
    if (isBlobRef(value)) {
      const integrityValues = [value.id, value.sha256, value.mimeType];
      if (integrityValues.some((item) => redactManagedSecrets(item, this.#redactValues) !== item)) {
        throw piError("PI_NATIVE_HISTORY_BLOB_INVALID", "Native history Blob identity contains managed credential material", "stream");
      }
      return {
        ...value,
        ...(value.fileName === undefined
          ? {}
          : { fileName: redactManagedSecrets(value.fileName, this.#redactValues) })
      };
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [rawKey, item] of Object.entries(value)) {
      const baseKey = redactManagedSecrets(rawKey, this.#redactValues);
      const key = Object.hasOwn(result, baseKey)
        ? `${baseKey}#${createHash("sha256").update(rawKey).digest("hex").slice(0, 12)}`
        : baseKey;
      result[key] = this.#redactNativeValue(item);
    }
    return result;
  }

  #resetRunOutcome(): void {
    this.#pendingAssistantError = undefined;
    this.#activeCompactionId = undefined;
    this.#latestSummarizationRetryAttempt = undefined;
    this.#lastOutcome = "completed";
  }

  #compactionId(type: "compaction_start" | "compaction_end"): string {
    if (type === "compaction_end" && this.#activeCompactionId !== undefined) return this.#activeCompactionId;
    const id = randomUUID();
    if (type === "compaction_start") this.#activeCompactionId = id;
    return id;
  }

  async #settlePendingAssistantError(): Promise<void> {
    const pending = this.#pendingAssistantError;
    this.#pendingAssistantError = undefined;
    if (pending === undefined) return;
    this.#lastOutcome = "failed";
    if (pending.kind === "context_overflow") {
      await this.#emit(
        {
          type: "error",
          error: {
            code: "CONTEXT_OVERFLOW",
            message: pending.message,
            phase: "stream",
            retryable: false,
            stateMayHaveChanged: true,
            recovery: "The next safe input will replace the unhealthy native context before dispatch."
          },
          terminal: true
        },
        pending.metadata
      );
      return;
    }
    await this.#emitClassifiedProviderError(
      pending.kind,
      pending.message,
      true,
      pending.metadata,
      "PI_PROVIDER_RESPONSE_FAILED"
    );
  }

  async #emitClassifiedProviderError(
    kind: ProviderFailureKind,
    message: string,
    terminal: boolean,
    metadata: AdapterEventMetadata,
    genericCode: string
  ): Promise<void> {
    await this.#emit(
      {
        type: "error",
        error: classifiedProviderError(kind, message, "stream", !terminal, genericCode),
        terminal
      },
      metadata
    );
  }

  async #emitError(code: string, message: string, terminal: boolean, metadata: AdapterEventMetadata): Promise<void> {
    await this.#emit(
      { type: "error", error: publicError(code, redactManagedSecrets(message, this.#redactValues), "stream", !terminal), terminal },
      metadata
    );
  }

  async #emit(payload: EventPayload, metadata: AdapterEventMetadata): Promise<void> {
    await this.#emitTo(this.#context, payload, metadata);
  }

  async #emitTo(context: AdapterContext, payload: EventPayload, metadata: AdapterEventMetadata): Promise<void> {
    await context.emit(
      redactEventPayload(payload, this.#redactValues),
      redactAdapterMetadata(liveNativeHistoryMetadata(payload, metadata), this.#redactValues)
    );
  }
}

function uniqueContexts(contexts: readonly AdapterContext[]): readonly AdapterContext[] {
  return [...new Set(contexts)];
}

function subagentMetadata(
  metadata: AdapterEventMetadata,
  projected: ProjectedPiSubagentActivity
): AdapterEventMetadata {
  return {
    namespace: "pi.subagent",
    ...(metadata.pi === undefined ? {} : { pi: metadata.pi }),
    fields: {
      ...metadata.fields,
      taskId: projected.activity.taskId,
      agentName: projected.activity.agentName,
      state: projected.activity.state,
      background: projected.activity.background
    }
  };
}

function redactEventPayload(payload: EventPayload, secrets: readonly string[]): EventPayload {
  return redactUnknown(payload, secrets) as EventPayload;
}

function liveNativeHistoryMetadata(payload: EventPayload, metadata: AdapterEventMetadata): AdapterEventMetadata {
  switch (payload.type) {
    case "text_delta":
    case "thinking_delta":
    case "message_complete":
    case "status":
    case "tool_start":
    case "tool_update":
    case "tool_result":
    case "compaction":
      return {
        ...metadata,
        fields: { ...metadata.fields, [NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD]: true }
      };
    default:
      return metadata;
  }
}

function redactAdapterMetadata(metadata: AdapterEventMetadata, secrets: readonly string[]): AdapterEventMetadata {
  return {
    namespace: redactManagedSecrets(metadata.namespace, secrets),
    fields: redactUnknown(metadata.fields, secrets) as Readonly<Record<string, string | number | boolean>>,
    ...(metadata.pi === undefined ? {} : { pi: redactUnknown(metadata.pi, secrets) as PiEventMetadata })
  };
}

const CONTEXT_OVERFLOW_PROVIDER_ERROR_RE =
  /prompt is too long|maximum (?:context|prompt) length|context.{0,20}(?:length|window).{0,40}(?:exceed|too)|(?:input|request|message).{0,20}exceeds?.{0,40}context.{0,20}(?:length|window)|context_length_exceeded/iu;

/** Closed provider-error classifier. Generic token/rate-limit failures do not qualify. */
export function isContextOverflowProviderError(message: string): boolean {
  return CONTEXT_OVERFLOW_PROVIDER_ERROR_RE.test(message);
}

const RESPONSE_STREAM_INTERRUPTED_RE = /Response API in-stream error/iu;
const UPSTREAM_OVERLOAD_RE = /\bat capacity\b|\boverloaded_error\b|\b529\b/iu;

function classifyProviderFailure(message: string): ProviderFailureKind {
  if (isContextOverflowProviderError(message)) return "context_overflow";
  if (RESPONSE_STREAM_INTERRUPTED_RE.test(message)) return "stream_interrupted";
  if (UPSTREAM_OVERLOAD_RE.test(message)) return "upstream_overload";
  return "generic";
}

function redactUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactManagedSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item, secrets)]));
}

function nativeMetadata(event: Record<string, unknown>): AdapterEventMetadata {
  const rpcEventType = boundedMetadataText(event.type, "unknown", 128);
  const fields: Record<string, string | number | boolean> = {};
  for (const key of ["id", "toolCallId", "toolName", "reason", "attempt", "maxAttempts", "delayMs", "source", "event"] as const) {
    const value = event[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = typeof value === "string" ? boundedMetadataText(value, "", 512) : value;
    }
  }
  return {
    namespace: "pi",
    fields: { rpcEventType, ...fields },
    pi: typedPiMetadata(event, rpcEventType)
  };
}

function withContentIndex(metadata: AdapterEventMetadata, contentIndex: number): AdapterEventMetadata {
  return {
    namespace: metadata.namespace,
    fields: { ...metadata.fields, contentIndex },
    ...(metadata.pi === undefined ? {} : { pi: withPiContentIndex(metadata.pi, contentIndex) })
  };
}

function withRetryUpdateError(metadata: AdapterEventMetadata, error: PublicError | undefined): AdapterEventMetadata {
  const pi = metadata.pi;
  if (pi?.payload.case !== "retryUpdate") return metadata;
  const { error: _discardedError, ...value } = pi.payload.value;
  return {
    ...metadata,
    pi: {
      ...pi,
      payload: {
        case: "retryUpdate",
        value: { ...value, ...(error === undefined ? {} : { error }) }
      }
    }
  };
}

function typedPiMetadata(event: Record<string, unknown>, rpcEventType: string): PiEventMetadata {
  switch (rpcEventType) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "message_end":
    case "turn_end":
    case "agent_end":
      return messageLifecycleMetadata(event, rpcEventType);
    case "tool_execution_start":
      return toolLifecycleMetadata(event, rpcEventType, "start");
    case "tool_execution_update":
      return toolLifecycleMetadata(event, rpcEventType, "update");
    case "tool_execution_end":
      return toolLifecycleMetadata(event, rpcEventType, "end");
    case "bash_execution_update": {
      const delta = boundedMetadataText(event.delta, "", 8_192);
      return {
        rpcEventType,
        payload: {
          case: "bashUpdate",
          value: {
            nativeBashId: boundedMetadataText(event.id, "direct-bash", 512),
            commandDisplay: "",
            stdoutDelta: delta,
            stderrDelta: "",
            completed: false,
            exitCode: 0,
            excludedFromContext: false
          }
        }
      };
    }
    case "queue_update":
      return {
        rpcEventType,
        payload: {
          case: "queueUpdate",
          value: {
            steering: queuedMessageMetadata(event.steering, "steering"),
            followUp: queuedMessageMetadata(event.followUp, "follow-up"),
            steeringMode: "unknown",
            followUpMode: "unknown"
          }
        }
      };
    case "compaction_start":
    case "compaction_end": {
      const result = isRecord(event.result) ? event.result : undefined;
      const boundaryEntryId = boundedMetadataText(result?.firstKeptEntryId, "", 512);
      const boundedErrorMessage = typeof event.errorMessage === "string"
        ? boundedMetadataText(event.errorMessage, "", 1_024)
        : undefined;
      const reportedErrorMessage = boundedErrorMessage === "" ? undefined : boundedErrorMessage;
      const state = compactionState(event, rpcEventType);
      const errorMessage = state === "no_op" || state === "aborted"
        ? undefined
        : reportedErrorMessage === undefined && state === "failed"
          ? "Pi compaction ended without an authoritative result"
          : reportedErrorMessage;
      const reason = compactionReason(event.reason);
      return {
        rpcEventType: "compaction_update",
        ...(boundaryEntryId === "" ? {} : { parentEntryId: boundaryEntryId }),
        payload: {
          case: "compactionUpdate",
          value: {
            compactionId: boundedMetadataText(event.compactionId, "compaction", 512),
            trigger: compactionTriggerMetadata(reason),
            reason,
            state,
            boundaryEntryId,
            tokensBefore: metadataUnsigned(result?.tokensBefore),
            tokensAfter: metadataUnsigned(result?.estimatedTokensAfter),
            summaryPreview: boundedMetadataText(result?.summary, "", 2_048),
            ...(typeof event.willRetry === "boolean" ? { willRetry: event.willRetry } : {}),
            ...(errorMessage === undefined ? {} : {
              error: publicError("PI_COMPACTION_FAILED", errorMessage, "compaction", event.willRetry === true)
            })
          }
        }
      };
    }
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished": {
      const retryError = typeof event.errorMessage === "string"
        ? rpcEventType.startsWith("summarization_")
          ? publicError(
            "PI_SUMMARIZATION_RETRY",
            boundedMetadataText(event.errorMessage, "Transient provider error", 1_024),
            "retry",
            rpcEventType !== "summarization_retry_finished"
          )
          : classifiedProviderError(
            classifyProviderFailure(event.errorMessage),
            boundedMetadataText(event.errorMessage, "Transient provider error", 1_024),
            "retry",
            rpcEventType !== "auto_retry_end",
            "PI_TRANSIENT_PROVIDER_ERROR"
          )
        : typeof event.finalError === "string"
          ? classifiedProviderError(
            classifyProviderFailure(event.finalError),
            boundedMetadataText(event.finalError, "Retry exhausted", 1_024),
            "retry",
            false,
            "PI_RETRY_EXHAUSTED"
          )
          : undefined;
      return {
        rpcEventType: "retry_update",
        payload: {
          case: "retryUpdate",
          value: {
            state: retryStateMetadata(rpcEventType, event),
            attemptNumber: metadataUnsigned(event.attempt, 1, 0xffff_ffff),
            reason: boundedMetadataText(event.reason ?? event.errorMessage ?? event.finalError, "", 1_024),
            ...(retryError === undefined ? {} : { error: retryError })
          }
        }
      };
    }
    case "session_info_changed": {
      return {
        rpcEventType: "session_identity_update",
        payload: {
          case: "sessionIdentityUpdate",
          value: {
            previousNativeSessionId: "",
            nativeSessionId: "",
            nativeSessionName: boundedMetadataText(event.name, "", 512),
            nativeSessionFileDisplay: "",
            activeLeafId: "",
            change: "renamed"
          }
        }
      };
    }
    case "thinking_level_changed":
      return {
        rpcEventType: "model_update",
        payload: {
          case: "modelUpdate",
          value: {
            thinkingLevel: boundedMetadataText(event.level, "", 128),
            scopedModel: false,
            contextWindowTokens: 0
          }
        }
      };
    default:
      return diagnosticPiMetadata(event, rpcEventType);
  }
}

function messageLifecycleMetadata(event: Record<string, unknown>, kind: Extract<
  PiEventMetadata["payload"],
  { readonly case: "messageLifecycle" }
>["value"]["kind"]): PiEventMetadata {
  const message = isRecord(event.message) ? event.message : undefined;
  const delta = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
  const contentIndex = metadataUnsigned(delta?.contentIndex, 0, 0xffff_ffff);
  return {
    rpcEventType: kind,
    contentIndex,
    payload: {
      case: "messageLifecycle",
      value: {
        kind,
        nativeMessageId: "",
        nativeEntryId: "",
        parentEntryId: "",
        role: boundedMetadataText(message?.role, "", 64),
        contentIndex
      }
    }
  };
}

function toolLifecycleMetadata(
  event: Record<string, unknown>,
  rpcEventType: string,
  phase: "start" | "update" | "end"
): PiEventMetadata {
  const toolName = boundedMetadataText(event.toolName, "unknown", 256);
  return {
    rpcEventType,
    contentIndex: 0,
    nativeToolName: toolName,
    payload: {
      case: "toolLifecycle",
      value: {
        nativeToolCallId: boundedMetadataText(event.toolCallId, "unknown-tool-call", 512),
        toolName,
        builtInKind: builtInToolKindMetadata(toolName),
        phase,
        contentIndex: 0
      }
    }
  };
}

function diagnosticPiMetadata(event: Record<string, unknown>, nativeEventType: string): PiEventMetadata {
  const parseError = typeof event.error === "string"
    ? boundedMetadataText(event.error, "", 1_024)
    : typeof event.errorMessage === "string"
      ? boundedMetadataText(event.errorMessage, "", 1_024)
      : undefined;
  const exitCode = optionalMetadataInt32(event.exitCode);
  const lineNumber = optionalMetadataUnsigned(event.lineNumber);
  return {
    rpcEventType: nativeEventType,
    payload: {
      case: "diagnostic",
      value: {
        command: rpcCommandMetadata(event.command),
        nativeEventType,
        ...(exitCode === undefined ? {} : { processExitCode: exitCode }),
        ...(lineNumber === undefined ? {} : { jsonlLineNumber: lineNumber }),
        ...(parseError === undefined ? {} : { parseError })
      }
    }
  };
}

function withPiContentIndex(metadata: PiEventMetadata, contentIndex: number): PiEventMetadata {
  if (metadata.payload.case === "messageLifecycle" || metadata.payload.case === "toolLifecycle") {
    return {
      ...metadata,
      contentIndex,
      payload: {
        ...metadata.payload,
        value: { ...metadata.payload.value, contentIndex }
      } as PiEventMetadata["payload"]
    };
  }
  return metadata;
}

function queuedMessageMetadata(value: unknown, prefix: string): Extract<
  PiEventMetadata["payload"],
  { readonly case: "queueUpdate" }
>["value"]["steering"] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => ({
    nativeQueueId: `${prefix}-${index}`,
    textPreview: boundedMetadataText(item, "", 512),
    imageCount: 0
  }));
}

function compactionTriggerMetadata(value: unknown): "unknown" | "automatic" | "manual" | "branch" {
  const normalized = typeof value === "string" ? value.toLocaleLowerCase() : "";
  if (
    normalized.includes("automatic") ||
    normalized.includes("auto") ||
    normalized === "threshold" ||
    normalized === "overflow"
  ) return "automatic";
  if (normalized.includes("manual")) return "manual";
  if (normalized.includes("branch")) return "branch";
  return "unknown";
}

function compactionReason(value: unknown): string {
  return boundedMetadataText(value, "unknown", 128);
}

function automaticCompactionReason(reason: string): boolean {
  return reason === "threshold" || reason === "overflow" || reason === "automatic";
}

function compactionState(
  event: Record<string, unknown>,
  rpcEventType: string
): "started" | "completed" | "no_op" | "aborted" | "failed" {
  if (rpcEventType === "compaction_start") return "started";
  if (event.aborted === true) return "aborted";
  if (isPiCompactionNoopEvent(event)) return "no_op";
  if (typeof event.errorMessage === "string" && event.errorMessage !== "") return "failed";
  // A successful compaction carries a result. Missing/null result without the
  // exact no-op or abort shape is malformed, not a no-op.
  return isRecord(event.result) ? "completed" : "failed";
}

function retryStateMetadata(
  rpcEventType: string,
  event: Record<string, unknown>
): "unknown" | "waiting" | "started" | "succeeded" | "exhausted" {
  if (rpcEventType === "auto_retry_start" || rpcEventType === "summarization_retry_scheduled") return "waiting";
  if (rpcEventType === "summarization_retry_attempt_start") return "started";
  if (rpcEventType === "summarization_retry_finished") return "unknown";
  return event.success === false ? "exhausted" : event.success === true ? "succeeded" : "unknown";
}

function builtInToolKindMetadata(toolName: string): "unknown" | "read" | "write" | "edit" | "bash" | "custom" | "mcp_bridge" {
  const normalized = toolName.toLocaleLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "edit" || normalized === "bash") return normalized;
  if (normalized.includes("mcp")) return "mcp_bridge";
  return normalized === "unknown" || normalized === "" ? "unknown" : "custom";
}

function isPrivateMemoryToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__joko_memory__memory_");
}

function isPrivateRemoteExecutionToolName(toolName: string): boolean {
  return toolName === "remote_host_execute" ||
    toolName === "mcp__joko-remote-host-tools__remote_host_execute";
}

function isPrivateVisionToolName(toolName: string): boolean {
  return toolName === "vision" || toolName === "vision-locate" ||
    toolName === "mcp__joko-vision-bridge__vision" ||
    toolName === "mcp__joko-vision-bridge__vision-locate";
}

const PI_RPC_COMMANDS = new Set([
  "prompt", "steer", "follow_up", "abort", "new_session", "get_state", "set_model", "cycle_model",
  "get_available_models", "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels",
  "set_steering_mode", "set_follow_up_mode", "compact", "set_auto_compaction", "set_auto_retry", "abort_retry",
  "bash", "abort_bash", "get_session_stats", "export_html", "switch_session", "fork", "clone",
  "get_fork_messages", "get_entries", "get_tree", "get_last_assistant_text", "set_session_name", "get_messages",
  "get_commands"
]);

function rpcCommandMetadata(value: unknown): Extract<
  PiEventMetadata["payload"],
  { readonly case: "diagnostic" }
>["value"]["command"] {
  return typeof value === "string" && PI_RPC_COMMANDS.has(value) ? value as ReturnType<typeof rpcCommandMetadata> : "unknown";
}

function boundedMetadataText(value: unknown, fallback: string, maximumCharacters: number): string {
  const text = typeof value === "string" ? value : fallback;
  const sanitized = redactText(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  return [...sanitized].slice(0, maximumCharacters).join("");
}

function metadataUnsigned(value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function optionalMetadataUnsigned(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function metadataInt32(value: unknown): number {
  return optionalMetadataInt32(value) ?? 0;
}

function optionalMetadataInt32(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff
    ? value
    : undefined;
}

function publicError(code: string, message: string, phase: string, retryable: boolean): PublicError {
  return {
    code,
    message: redactText(message),
    phase,
    retryable,
    stateMayHaveChanged: phase === "stream",
    recovery: retryable ? "Wait for Pi's retry policy or restart and resume the native session." : "Inspect the failure before retrying."
  };
}

function classifiedProviderError(
  kind: ProviderFailureKind,
  message: string,
  phase: string,
  retryable: boolean,
  genericCode = "PI_PROVIDER_RESPONSE_FAILED"
): PublicError {
  const code = kind === "context_overflow"
    ? "CONTEXT_OVERFLOW"
    : kind === "stream_interrupted"
      ? "UPSTREAM_STREAM_INTERRUPTED"
      : kind === "upstream_overload"
        ? "UPSTREAM_OVERLOAD"
        : genericCode;
  const error = publicError(
    code,
    message,
    phase,
    kind === "context_overflow" || kind === "stream_interrupted" ? false : retryable
  );
  if (kind === "stream_interrupted") {
    return {
      ...error,
      recovery: "Inspect the interrupted partial response and switch models or providers before retrying."
    };
  }
  if (kind === "upstream_overload") {
    return {
      ...error,
      recovery: retryable
        ? "Wait for Pi's bounded upstream retry policy."
        : "Wait for upstream capacity or select another available model before retrying."
    };
  }
  return error;
}

function extractToolText(result: Record<string, unknown> | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function decodeImageBase64(value: unknown, artifactCapacityBytes: number): Uint8Array {
  if (typeof value !== "string") {
    throw new Error("Pi returned malformed inline image data.");
  }
  const byteLength = canonicalBase64ByteLength(value);
  if (byteLength === undefined) throw new Error("Pi returned malformed inline image data.");
  if (byteLength > artifactCapacityBytes) {
    throw piError(
      "PI_ARTIFACT_CAPACITY_EXCEEDED",
      "Pi inline image exceeds the host Artifact capacity",
      "stream",
      { recovery: "Increase Artifact storage capacity or submit a smaller image." }
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== byteLength) throw new Error("Pi returned malformed inline image data.");
  return bytes;
}

function canonicalBase64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (base64AlphabetValue(value.charCodeAt(index)) < 0) return undefined;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return undefined;
  }
  if (padding === 2 && (base64AlphabetValue(value.charCodeAt(contentLength - 1)) & 0x0f) !== 0) return undefined;
  if (padding === 1 && (base64AlphabetValue(value.charCodeAt(contentLength - 1)) & 0x03) !== 0) return undefined;
  const byteLength = value.length / 4 * 3 - padding;
  return byteLength > 0 ? byteLength : undefined;
}

function base64AlphabetValue(value: number): number {
  if (value >= 0x41 && value <= 0x5a) return value - 0x41;
  if (value >= 0x61 && value <= 0x7a) return value - 0x61 + 26;
  if (value >= 0x30 && value <= 0x39) return value - 0x30 + 52;
  if (value === 0x2b) return 62;
  if (value === 0x2f) return 63;
  return -1;
}

function imageMimeType(value: unknown): string {
  const mimeType = typeof value === "string" ? value.toLowerCase() : "image/png";
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(mimeType)) {
    throw new Error("Pi returned an invalid image MIME type.");
  }
  return mimeType;
}

function isBlobRef(value: unknown): value is BlobRef {
  return isRecord(value) &&
    typeof value.id === "string" && value.id !== "" &&
    typeof value.sha256 === "string" && value.sha256 !== "" &&
    typeof value.byteLength === "number" && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 &&
    typeof value.mimeType === "string" && value.mimeType !== "" &&
    (value.fileName === undefined || typeof value.fileName === "string");
}

function trustedMcpCompleteOutput(
  details: Record<string, unknown> | undefined,
  artifactCapacityBytes: number
): BlobRef | undefined {
  const envelope = details === undefined || !isRecord(details.jokoMcpBridge)
    ? undefined
    : details.jokoMcpBridge;
  if (envelope?.format !== 1) return undefined;
  if (envelope.completeOutput === undefined) return undefined;
  if (envelope.truncated !== true || !isBlobRef(envelope.completeOutput)) {
    throw piError("PI_MCP_COMPLETE_OUTPUT_INVALID", "Managed MCP complete-output envelope is invalid", "stream");
  }
  const blob = envelope.completeOutput;
  if (!/^[a-f0-9]{64}$/u.test(blob.sha256) || blob.byteLength > artifactCapacityBytes) {
    throw piError(
      blob.byteLength > artifactCapacityBytes ? "PI_ARTIFACT_CAPACITY_EXCEEDED" : "PI_MCP_COMPLETE_OUTPUT_INVALID",
      blob.byteLength > artifactCapacityBytes
        ? "Managed MCP complete output exceeds the host Artifact capacity"
        : "Managed MCP complete-output Blob identity is invalid",
      "stream"
    );
  }
  if (
    typeof envelope.byteLength !== "number" ||
    !Number.isSafeInteger(envelope.byteLength) ||
    envelope.byteLength < 0 ||
    envelope.byteLength !== blob.byteLength
  ) {
    throw piError("PI_MCP_COMPLETE_OUTPUT_INVALID", "Managed MCP complete-output byte length is invalid", "stream");
  }
  return blob;
}

function trustedMcpImageOutputs(
  details: Record<string, unknown> | undefined,
  artifactCapacityBytes: number
): readonly ToolResultContentPart[] {
  const envelope = details === undefined || !isRecord(details.jokoMcpBridge)
    ? undefined
    : details.jokoMcpBridge;
  if (envelope?.format !== 1 || envelope.imageOutputs === undefined) return [];
  if (!Array.isArray(envelope.imageOutputs) || envelope.imageOutputs.length > 8) {
    throw piError("PI_MCP_IMAGE_OUTPUT_INVALID", "Managed MCP image-output envelope is invalid", "stream");
  }
  return envelope.imageOutputs.map((value): ToolResultContentPart => {
    if (!isRecord(value) || !isBlobRef(value.blob)) {
      throw piError("PI_MCP_IMAGE_OUTPUT_INVALID", "Managed MCP image-output Blob identity is invalid", "stream");
    }
    const blob = value.blob;
    const alt = value.alt;
    if (Buffer.byteLength(blob.id, "utf8") > 512
      || /[\u0000-\u001f\u007f]/u.test(blob.id)
      || !/^[a-f0-9]{64}$/u.test(blob.sha256)
      || blob.byteLength < 1
      || blob.byteLength > artifactCapacityBytes
      || !/^image\/(?:png|jpeg|gif|webp)$/u.test(blob.mimeType)
      || (blob.fileName !== undefined && (
        blob.fileName.length === 0
        || Buffer.byteLength(blob.fileName, "utf8") > 512
        || /[\u0000-\u001f\u007f]/u.test(blob.fileName)
      ))
      || (alt !== undefined && (
        typeof alt !== "string"
        || Buffer.byteLength(alt, "utf8") > 4_096
      ))) {
      throw piError(
        blob.byteLength > artifactCapacityBytes
          ? "PI_ARTIFACT_CAPACITY_EXCEEDED"
          : "PI_MCP_IMAGE_OUTPUT_INVALID",
        blob.byteLength > artifactCapacityBytes
          ? "Managed MCP image output exceeds the host Artifact capacity"
          : "Managed MCP image-output Blob identity is invalid",
        "stream"
      );
    }
    const safeAlt = typeof alt === "string" ? alt : undefined;
    return {
      kind: "image",
      blob,
      ...(safeAlt === undefined ? {} : { alt: safeAlt })
    };
  });
}

function nativeContentWithImages(
  content: unknown,
  images: readonly ToolResultContentPart[]
): unknown {
  const imageParts = images.flatMap((part) => part.kind !== "image" ? [] : [{
    type: "image",
    blob: part.blob,
    ...(part.alt === undefined ? {} : { alt: part.alt })
  }]);
  if (imageParts.length === 0) return content;
  if (Array.isArray(content)) return [...content, ...imageParts];
  if (typeof content === "string") return [{ type: "text", text: content }, ...imageParts];
  return imageParts;
}

function isManagedMcpToolName(value: string): boolean {
  return value.startsWith("mcp__") || value === "image_generate";
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".png";
}

function redactText(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : String(value ?? ""));
}

function contentText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveRetryAttempt(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 0xffff_ffff
    ? value
    : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/** Suppress the provider placeholder; the terminal message emits a typed redacted block. */
function isRedactedThinkingUpdate(delta: Record<string, unknown>): boolean {
  return delta.delta === "[Reasoning redacted]";
}
