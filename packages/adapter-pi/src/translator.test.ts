import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, AdapterEventMetadata, BlobRef, EventPayload, TargetDescriptor } from "@joko/core";
import { describe, expect, it, vi } from "vitest";
import type { PiRpcEvent } from "./protocol.js";
import { JOKO_SUBAGENT_ACTIVITY_MARKER } from "./subagent-progress.js";
import { projectPiNativeHistory } from "./native-history.js";
import { PiEventTranslator } from "./translator.js";
import { mkdtemp } from "./test-paths.js";

describe("PiEventTranslator", () => {
  it("consumes the explicit delta from the current Pi message-update wire", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-message-wire-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-message-wire-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wire delta" }
    } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", blockId: "assistant-1-0", delta: "wire delta", contentIndex: 0 }
    ]);
    // Streaming usage is cumulative billed-call data, not the authoritative
    // live context window. SessionHost syncs get_session_stats instead.
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
  });

  it("drops empty text/thinking deltas and preserves provider-redacted thinking at message completion", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-empty-delta-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-empty-delta-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "" }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "[Reasoning redacted]"
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }],
        stopReason: "stop",
        duration: 1_200,
        usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } }
      }
    } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "text_delta" || event.type === "thinking_delta")).toEqual([]);
    expect(events).toContainEqual({
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "thinking", text: "[redacted by provider]", redacted: true }],
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        totalTokens: 10,
        cost: 0.01
      },
      generationDurationMs: 1_200,
      generationReliable: true
    });
  });

  it("emits typed, bounded, redacted Pi metadata for supported and unknown native events", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-typed-metadata-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-typed-metadata-artifacts-"));
    const secret = "typed-metadata-secret";
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false,
      redactValues: [secret]
    });

    await translator.translate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "visible" }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "queue_update",
      steering: Array.from({ length: 257 }, (_, index) => index === 0 ? `inspect ${secret}` : `queued-${index}`),
      followUp: [],
      steeringMode: "one-at-a-time"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "extension_error", error: `failed ${secret}` } as unknown as PiRpcEvent);
    await translator.translate({ type: `unknown-${"x".repeat(256)}` } as PiRpcEvent);

    expect(metadata.map((item) => item.pi?.payload.case)).toEqual([
      "messageLifecycle",
      "toolLifecycle",
      "queueUpdate",
      "diagnostic",
      "diagnostic"
    ]);
    expect(metadata[0]?.pi).toMatchObject({
      rpcEventType: "message_update",
      contentIndex: 3,
      payload: { case: "messageLifecycle", value: { kind: "message_update", contentIndex: 3 } }
    });
    expect(metadata[1]?.pi).toMatchObject({
      nativeToolName: "read",
      payload: { case: "toolLifecycle", value: { nativeToolCallId: "tool-1", builtInKind: "read", phase: "start" } }
    });
    expect(metadata[2]?.pi).toMatchObject({
      payload: { case: "queueUpdate", value: { steeringMode: "unknown", followUpMode: "unknown" } }
    });
    const queueUpdate = metadata[2]?.pi?.payload.case === "queueUpdate" ? metadata[2].pi.payload.value : undefined;
    expect(queueUpdate?.steering).toHaveLength(257);
    expect(queueUpdate?.steering[0]?.textPreview).toBe("inspect [REDACTED]");
    expect(queueUpdate?.steering.at(-1)?.textPreview).toBe("queued-256");
    expect(metadata[3]?.pi).toMatchObject({
      payload: { case: "diagnostic", value: { nativeEventType: "extension_error", parseError: "failed [REDACTED]" } }
    });
    expect(metadata[4]?.pi?.rpcEventType).toHaveLength(128);
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(JSON.stringify(metadata)).not.toContain("runtimeIdentity");
  });

  it.each([
    { outcome: "aborted" as const, abortRequested: true, providerFailure: false },
    { outcome: "failed" as const, abortRequested: false, providerFailure: true }
  ])("fans one native settlement out to every unique $outcome lifecycle participant", async ({ outcome, abortRequested, providerFailure }) => {
    const workspace = await mkdtemp(join(tmpdir(), `joko-pi-${outcome}-participants-`));
    const artifacts = await mkdtemp(join(tmpdir(), `joko-pi-${outcome}-artifacts-`));
    const promptEvents: EventPayload[] = [];
    const steerEvents: EventPayload[] = [];
    const followUpEvents: EventPayload[] = [];
    const promptContext = context(workspace, promptEvents, []);
    const steerContext = context(workspace, steerEvents, []);
    const followUpContext = context(workspace, followUpEvents, []);
    const translator = new PiEventTranslator({
      context: promptContext,
      artifactDirectory: artifacts,
      wasAbortRequested: () => abortRequested
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    if (providerFailure) {
      await translator.translate({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" }
      } as unknown as PiRpcEvent);
    }
    await translator.translate(
      { type: "agent_settled" } as PiRpcEvent,
      [promptContext, promptContext, steerContext, followUpContext]
    );

    for (const events of [promptEvents, steerEvents, followUpEvents]) {
      expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome }]);
      expect(events.filter((event) => event.type === "run_state").at(-1)).toEqual({ type: "run_state", state: outcome });
    }
  });

  it("redacts configured secrets from every public event and stored tool artifact, then settles failures", async () => {
    const events: EventPayload[] = [];
    const storedArtifacts: string[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-translator-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-translator-artifacts-"));
    const secret = "nonstandard-managed-credential-value";
    const translator = new PiEventTranslator({
      context: context(workspace, events, storedArtifacts),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false,
      redactValues: [secret]
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_start",
      message: { role: "assistant", content: [] }
    } as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `visible ${secret}` }
    } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `visible ${secret}` }],
        stopReason: "error",
        errorMessage: `provider echoed ${secret}`,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
      }
    } as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    const fullOutputPath = join(artifacts, "full-tool-output.log");
    await writeFile(fullOutputPath, `tool output ${secret}\n`, "utf8");
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "tool-secret",
      toolName: "bash",
      isError: false,
      result: {
        content: [{ type: "text", text: `inline ${secret}` }],
        details: { fullOutputPath }
      }
    } as unknown as PiRpcEvent);

    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "visible [REDACTED]" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_complete",
        blocks: [{ kind: "text", text: "visible [REDACTED]" }]
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "PI_PROVIDER_RESPONSE_FAILED", message: "provider echoed [REDACTED]" })
      })
    );
    expect(events).toContainEqual({ type: "done", outcome: "failed" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", output: "inline [REDACTED]" }));
    expect(events.filter((event) => event.type === "artifact")).toEqual([]);
    // Per-message Pi usage is billed-call data, not the exact current context
    // window. SessionHost emits the authoritative get_session_stats result.
    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(storedArtifacts).toEqual(["tool output [REDACTED]\n"]);
  });

  it("keeps Pi's first retryable provider failure provisional across the real wire order", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-retry-success-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-retry-success-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary overload" }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "turn_end" } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: true } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([]);

    await translator.translate({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "temporary overload"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered answer" }],
        stopReason: "stop"
      }
    } as unknown as PiRpcEvent);
    // Pi emits successful auto_retry_end from message_end handling, before
    // the recovered low-level agent_end frame.
    await translator.translate({ type: "auto_retry_end", success: true, attempt: 1 } as unknown as PiRpcEvent);
    await translator.translate({ type: "turn_end" } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: false } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.filter((event) => event.type === "retry")).toEqual([
      { type: "retry", state: "waiting", attempt: 1, maxAttempts: 3, delayMs: 10 },
      { type: "retry", state: "succeeded", attempt: 1 }
    ]);
    expect(events.filter((event) => event.type === "retry").every((event) => event.error === undefined)).toBe(true);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
    expect(events.filter((event) => event.type === "run_state").at(-1)).toEqual({
      type: "run_state",
      state: "completed"
    });
  });

  it("inherits Pi summarization attempts and leaves finished neutral until the compaction terminal", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-summary-retry-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-summary-retry-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    // These native event shapes do not carry an attempt. Without a preceding
    // scheduled event, the translator must not manufacture attempt 1.
    await translator.translate({
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "manual"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "summarization_retry_finished" } as unknown as PiRpcEvent);

    await translator.translate({
      type: "summarization_retry_scheduled",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2_500,
      errorMessage: "temporary summary failure"
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "manual"
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "summarization_retry_scheduled",
      attempt: 3,
      maxAttempts: 3,
      delayMs: 5_000,
      errorMessage: "last temporary summary failure"
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "manual"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "summarization_retry_finished" } as unknown as PiRpcEvent);
    await translator.translate({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: "summary provider failed"
    } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "retry")).toEqual([
      {
        type: "retry",
        state: "waiting",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 2_500,
        error: expect.objectContaining({
          code: "PI_SUMMARIZATION_RETRY",
          message: "temporary summary failure",
          retryable: true
        })
      },
      { type: "retry", state: "started", attempt: 2 },
      {
        type: "retry",
        state: "waiting",
        attempt: 3,
        maxAttempts: 3,
        delayMs: 5_000,
        error: expect.objectContaining({
          code: "PI_SUMMARIZATION_RETRY",
          message: "last temporary summary failure",
          retryable: true
        })
      },
      { type: "retry", state: "started", attempt: 3 },
      { type: "retry", state: "unknown", attempt: 3 }
    ]);
    const retryUpdates = metadata.flatMap((item) => {
      const pi = item.pi;
      return pi?.payload.case === "retryUpdate" ? [pi.payload.value] : [];
    });
    expect(retryUpdates).toMatchObject([
      { state: "waiting", attemptNumber: 2 },
      { state: "started", attemptNumber: 2 },
      { state: "waiting", attemptNumber: 3 },
      { state: "started", attemptNumber: 3 },
      { state: "unknown", attemptNumber: 3 }
    ]);
    expect(events.filter((event) => event.type === "compaction")).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        state: "failed",
        error: expect.objectContaining({ message: "summary provider failed" })
      })
    );
    expect(events.filter((event) => event.type === "error")).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: "summary provider failed" })
      })
    );
    expect(JSON.stringify({ events, metadata })).not.toContain('"state":"succeeded"');
  });

  it("emits one terminal error when Pi exhausts retries, then does not duplicate it at settlement", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-retry-exhausted-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-retry-exhausted-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "first provider error" }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: true } as unknown as PiRpcEvent);
    await translator.translate({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 1,
      errorMessage: "first provider error"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "last assistant error" }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: false } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([]);

    await translator.translate({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "final provider error"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        error: expect.objectContaining({
          code: "PI_RETRY_EXHAUSTED",
          message: "final provider error",
          retryable: false
        }),
        terminal: true
      }
    ]);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
  });

  it("settles a non-retried provider failure exactly once at agent_settled", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-direct-failure-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-direct-failure-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "invalid api key" }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: false } as unknown as PiRpcEvent);
    expect(events.filter((event) => event.type === "error")).toEqual([]);

    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        error: expect.objectContaining({
          code: "PI_PROVIDER_RESPONSE_FAILED",
          message: "invalid api key",
          retryable: false
        }),
        terminal: true
      }
    ]);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
  });

  it("classifies a Responses in-stream interruption as a stable non-retryable terminal error", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-stream-interrupted-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-stream-interrupted-artifacts-"));
    const secret = "sk-stream-interrupted-secret-value";
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false,
      redactValues: [secret]
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: `OpenAI API error (500): LiteLLM Response API in-stream error ${secret}`
      }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "retry")).toEqual([]);
    expect(events.filter((event) => event.type === "error")).toEqual([{
      type: "error",
      error: expect.objectContaining({
        code: "UPSTREAM_STREAM_INTERRUPTED",
        message: "OpenAI API error (500): LiteLLM Response API in-stream error [REDACTED]",
        retryable: false,
        stateMayHaveChanged: true
      }),
      terminal: true
    }]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
  });

  it("keeps auto-retry lifecycle durable while exposing only later overload attempts", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-retry-notice-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-retry-notice-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    for (const retry of [
      { attempt: 1, errorMessage: "HTTP status 529: overloaded" },
      { attempt: 2, errorMessage: "HTTP status 529: overloaded" },
      { attempt: 2, errorMessage: "OpenAI API error (500): LiteLLM Response API in-stream error" },
      { attempt: 2, errorMessage: "provider 500 from upstream" }
    ]) {
      await translator.translate({
        type: "auto_retry_start",
        maxAttempts: 3,
        delayMs: 250,
        ...retry
      } as unknown as PiRpcEvent);
    }

    const retries = events.filter((event) => event.type === "retry");
    expect(retries.map((event) => event.error?.code)).toEqual([
      undefined,
      "UPSTREAM_OVERLOAD",
      undefined,
      undefined
    ]);
    expect(retries[1]).toMatchObject({
      type: "retry",
      state: "waiting",
      attempt: 2,
      maxAttempts: 3,
      error: { code: "UPSTREAM_OVERLOAD", retryable: true }
    });
    expect(events.filter((event) => event.type === "error")).toEqual([]);

    const metadataErrors = metadata.map((item) =>
      item.pi?.payload.case === "retryUpdate" ? item.pi.payload.value.error?.code : undefined
    );
    expect(metadataErrors).toEqual([undefined, "UPSTREAM_OVERLOAD", undefined, undefined]);
  });

  it("preserves stable overload codes through native auto-retry progress and exhaustion", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-upstream-overload-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-upstream-overload-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 250,
      errorMessage: "529 overloaded_error: Overloaded"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Selected model is at capacity. Please try a different model."
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "Selected model is at capacity. Please try a different model."
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "retry")).toEqual([
      {
        type: "retry",
        state: "waiting",
        attempt: 1,
        maxAttempts: 1,
        delayMs: 250
      },
      {
        type: "retry",
        state: "exhausted",
        attempt: 1,
        error: expect.objectContaining({ code: "UPSTREAM_OVERLOAD", retryable: false })
      }
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([{
      type: "error",
      error: expect.objectContaining({
        code: "UPSTREAM_OVERLOAD",
        message: "Selected model is at capacity. Please try a different model.",
        retryable: false
      }),
      terminal: true
    }]);
    const retryMetadataErrors = metadata.flatMap((item) =>
      item.pi?.payload.case === "retryUpdate" && item.pi.payload.value.error !== undefined
        ? [item.pi.payload.value.error]
        : []
    );
    expect(retryMetadataErrors).toHaveLength(2);
    expect(retryMetadataErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UPSTREAM_OVERLOAD", retryable: false })
    ]));
    expect(retryMetadataErrors.some((error) => error.retryable)).toBe(false);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
  });

  it.each([
    "OpenAI API error (500): ordinary upstream failure",
    "HTTP 503: upstream service unavailable",
    "buffer capacity exceeded locally",
    "worker overloaded while formatting a result",
    "request id 15294 rejected"
  ])("does not misclassify an ordinary provider failure: %s", async (message) => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-generic-provider-error-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-generic-provider-error-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: message }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error").at(-1)).toMatchObject({
      type: "error",
      error: { code: "PI_PROVIDER_RESPONSE_FAILED", message },
      terminal: true
    });
  });

  it("classifies only explicit provider context-window failures as a terminal overflow", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-context-window-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-context-window-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Your input exceeds the context window of this model."
      }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([{
      type: "error",
      error: expect.objectContaining({
        code: "CONTEXT_OVERFLOW",
        retryable: false,
        stateMayHaveChanged: true
      }),
      terminal: true
    }]);

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Too many tokens per minute for this account."
      }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);
    expect(events.filter((event) => event.type === "error").at(-1)).toMatchObject({
      type: "error",
      error: { code: "PI_PROVIDER_RESPONSE_FAILED" },
      terminal: true
    });
  });

  it("uses agent_settled as the final fallback when a promised retry never starts", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-missing-retry-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-missing-retry-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "retry preparation failed" }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: true } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        type: "error",
        terminal: true,
        error: expect.objectContaining({ message: "retry preparation failed", retryable: false })
      })
    ]);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
  });

  it("clears provisional retry failures when the run is aborted", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-retry-abort-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-retry-abort-artifacts-"));
    let abortRequested = false;
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => abortRequested
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary provider error" }
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_end", willRetry: true } as unknown as PiRpcEvent);
    await translator.translate({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "temporary provider error"
    } as unknown as PiRpcEvent);
    abortRequested = true;
    await translator.translate({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "Retry cancelled"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "aborted" }]);
  });

  it("does not carry a provisional provider failure into a newer product generation", async () => {
    const oldEvents: EventPayload[] = [];
    const nextEvents: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-retry-generation-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-retry-generation-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, oldEvents, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "agent_start" } as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "stale generation error" }
    } as unknown as PiRpcEvent);
    translator.setContext({ ...context(workspace, nextEvents, []), generation: 2 });
    await translator.translate({ type: "agent_settled" } as PiRpcEvent);

    expect(oldEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(nextEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(nextEvents.filter((event) => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
  });

  it("projects online and native tool images to one stable BlobRef without persisting base64 or duplicate artifacts", async () => {
    const events: EventPayload[] = [];
    const storedArtifacts: string[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-tool-image-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-tool-image-artifacts-"));
    const imageBytes = Buffer.from("realistic-png-fixture-bytes\0\u0001", "utf8");
    const inlineBase64 = imageBytes.toString("base64");
    const translator = new PiEventTranslator({
      context: context(workspace, events, storedArtifacts),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "read-image",
      toolName: "read",
      isError: false,
      result: {
        content: [
          { type: "text", text: "Image Size: 16x16." },
          { type: "image", data: inlineBase64, mimeType: "image/png" }
        ],
        details: {}
      }
    } as unknown as PiRpcEvent);

    const online = events.find((event) => event.type === "tool_result");
    expect(online).toMatchObject({
      type: "tool_result",
      callId: "read-image",
      output: "Image Size: 16x16.",
      parts: [
        { kind: "text", text: "Image Size: 16x16." },
        { kind: "image", blob: { id: "translator-artifact", mimeType: "image/png" } }
      ]
    });
    expect(events.filter((event) => event.type === "artifact")).toEqual([]);

    const nativeEntry = {
      id: "tool-result-entry",
      parentId: "assistant-entry",
      type: "message",
      timestamp: 1_000,
      data: {
        type: "message",
        id: "tool-result-entry",
        parentId: "assistant-entry",
        message: {
          role: "toolResult",
          toolCallId: "read-image",
          toolName: "read",
          content: [
            { type: "text", text: "Image Size: 16x16." },
            { type: "image", data: inlineBase64, mimeType: "image/png" }
          ],
          isError: false,
          timestamp: 1_000
        }
      }
    } as const;
    const firstNative = await translator.materializeNativeHistoryEntry(nativeEntry);
    const reconnectedNative = await translator.materializeNativeHistoryEntry(nativeEntry);
    const restartedTranslator = new PiEventTranslator({
      context: context(workspace, events, storedArtifacts),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const restartedNative = await restartedTranslator.materializeNativeHistoryEntry(nativeEntry);

    expect(firstNative).toEqual(reconnectedNative);
    expect(restartedNative).toEqual(firstNative);
    expect(firstNative.data).toMatchObject({
      message: {
        content: [
          { type: "text", text: "Image Size: 16x16." },
          { type: "image", blob: { id: "translator-artifact", mimeType: "image/png" } }
        ]
      }
    });
    // The in-process cache avoids the reconnect write; a fresh translator
    // calls the durable store again and receives the same content identity.
    expect(storedArtifacts).toEqual([imageBytes.toString("utf8"), imageBytes.toString("utf8")]);
    expect(JSON.stringify({ events, firstNative, reconnectedNative, restartedNative })).not.toContain(inlineBase64);
    expect(JSON.stringify(online)).not.toContain("data");
  });

  it("keeps one bounded preview when large tool output is stored as a complete artifact", async () => {
    const events: EventPayload[] = [];
    const storedArtifacts: string[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-large-tool-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-large-tool-artifacts-"));
    const tailCanary = "FULL_OUTPUT_TAIL_MUST_NOT_BE_INLINE";
    const fullOutput = `${"x".repeat(256 * 1024 + 32)}${tailCanary}`;
    const translator = new PiEventTranslator({
      context: context(workspace, events, storedArtifacts),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "large-output",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: fullOutput }], details: {} }
    } as unknown as PiRpcEvent);

    const result = events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({
      type: "tool_result",
      artifact: { id: "translator-artifact" },
      output: expect.stringContaining("[full output stored as artifact]"),
      parts: [{ kind: "text", text: expect.stringContaining("[full output stored as artifact]") }]
    });
    expect(JSON.stringify(result)).not.toContain(tailCanary);
    expect(storedArtifacts).toEqual([fullOutput]);
    expect(events.filter((event) => event.type === "artifact")).toEqual([]);
  });

  it("stores complete native Bash tool output above 64 MiB using the host Artifact capacity", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-large-tool-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-native-large-tool-artifacts-"));
    const secret = "managed-native-tool-secret";
    const sourceBytes = 64 * 1024 * 1024 + 1;
    const fullOutputPath = join(artifacts, "native-large-output.log");
    await writeFile(fullOutputPath, `${"x".repeat(sourceBytes)}${secret}`, "utf8");
    let stagedSize = 0;
    let stagedTail = "";
    const base = context(workspace, events, []);
    const translator = new PiEventTranslator({
      context: {
        ...base,
        artifactCapacityBytes: 256 * 1024 * 1024,
        storeArtifact: async (sourcePath, options) => {
          const bytes = await readFile(sourcePath);
          stagedSize = bytes.byteLength;
          stagedTail = bytes.subarray(Math.max(0, bytes.byteLength - 64)).toString("utf8");
          return {
            id: "native-large-tool-artifact",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.byteLength,
            mimeType: options?.mimeType ?? "text/plain",
            fileName: options?.fileName
          };
        }
      },
      artifactDirectory: artifacts,
      wasAbortRequested: () => false,
      redactValues: [secret]
    });

    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "native-large-output",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "bounded preview" }], details: { fullOutputPath } }
    } as unknown as PiRpcEvent);

    expect(stagedSize).toBe(sourceBytes + "[REDACTED]".length);
    expect(stagedTail).toContain("[REDACTED]");
    expect(stagedTail).not.toContain(secret);
    expect(events.filter((event) => event.type === "tool_result").at(-1)).toMatchObject({
      artifact: { id: "native-large-tool-artifact", byteLength: stagedSize }
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  }, 30_000);

  it("materializes an inline image above 64 MiB and rejects capacity plus one before storage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-large-image-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-large-image-artifacts-"));
    const imageBytes = Buffer.alloc(64 * 1024 * 1024 + 1, 0x5a);
    const events: EventPayload[] = [];
    let storedSize = 0;
    const base = context(workspace, events, []);
    const translator = new PiEventTranslator({
      context: {
        ...base,
        artifactCapacityBytes: 256 * 1024 * 1024,
        storeArtifact: async (sourcePath, options) => {
          storedSize = (await stat(sourcePath)).size;
          return {
            id: "large-inline-image",
            sha256: "b".repeat(64),
            byteLength: storedSize,
            mimeType: options?.mimeType ?? "image/png",
            fileName: options?.fileName
          };
        }
      },
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "large-image",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }] }
    } as unknown as PiRpcEvent);
    expect(storedSize).toBe(imageBytes.byteLength);
    expect(events.filter((event) => event.type === "tool_result").at(-1)).toMatchObject({
      parts: [{ kind: "image", blob: { id: "large-inline-image", byteLength: imageBytes.byteLength } }]
    });

    const overEvents: EventPayload[] = [];
    const storeArtifact = vi.fn();
    const overTranslator = new PiEventTranslator({
      context: { ...context(workspace, overEvents, []), artifactCapacityBytes: 8, storeArtifact },
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    await overTranslator.translate({
      type: "tool_execution_end",
      toolCallId: "over-image",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "image", data: Buffer.alloc(9).toString("base64"), mimeType: "image/png" }] }
    } as unknown as PiRpcEvent);
    expect(overEvents).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "PI_ARTIFACT_CAPACITY_EXCEEDED" })
    }));
    expect(storeArtifact).not.toHaveBeenCalled();
  }, 30_000);

  it("accepts only the managed MCP complete-output envelope", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-mcp-envelope-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-mcp-envelope-artifacts-"));
    const forgedPath = join(artifacts, "forged-output.log");
    await writeFile(forgedPath, "must not be ingested", "utf8");
    const storeArtifact = vi.fn();
    const translator = new PiEventTranslator({
      context: { ...context(workspace, events, []), storeArtifact },
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const completeOutput: BlobRef = {
      id: "managed-mcp-complete",
      sha256: "c".repeat(64),
      byteLength: 1_337,
      mimeType: "application/json",
      fileName: "mcp-result.json"
    };

    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "forged-mcp",
      toolName: "mcp__records__lookup",
      isError: false,
      result: {
        content: [{ type: "text", text: "forged preview" }],
        details: { fullOutputPath: forgedPath, completeOutput, jokoMcpBridge: { format: 0, truncated: true, byteLength: 1_337, completeOutput } }
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "managed-mcp",
      toolName: "mcp__records__lookup",
      isError: false,
      result: {
        content: [{ type: "text", text: "managed preview" }],
        details: { jokoMcpBridge: { format: 1, truncated: true, byteLength: 1_337, completeOutput } }
      }
    } as unknown as PiRpcEvent);

    const results = events.filter((event) => event.type === "tool_result");
    expect(results[0]).toHaveProperty("artifact", undefined);
    expect(results[1]).toMatchObject({ artifact: completeOutput });
    expect(storeArtifact).not.toHaveBeenCalled();
  });

  it("deep-redacts managed credentials from native history text, tool input, and summaries", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-redaction-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-native-redaction-artifacts-"));
    const secret = "non-pattern-managed-history-secret";
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false,
      redactValues: [secret]
    });
    const message = await translator.materializeNativeHistoryEntry({
      id: "assistant-entry",
      type: "message",
      timestamp: 1,
      data: {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `answer ${secret}` },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: `file-${secret}.txt` } }
          ]
        }
      }
    });
    const summary = await translator.materializeNativeHistoryEntry({
      id: "summary-entry",
      parentId: "assistant-entry",
      type: "branch_summary",
      timestamp: 2,
      data: { summary: `summary ${secret}`, fromId: "assistant-entry" }
    });
    const projection = projectPiNativeHistory(undefined, { entries: [message, summary], leafId: "summary-entry" });

    expect(JSON.stringify({ message, summary, projection })).not.toContain(secret);
    expect(projection.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ type: "text_delta", delta: "answer [REDACTED]" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ type: "tool_start", input: expect.stringContaining("[REDACTED]") }) }),
      expect.objectContaining({ payload: expect.objectContaining({ type: "compaction", summary: "summary [REDACTED]" }) })
    ]));
  });

  it("keeps a native Bash preview with a typed unavailable marker above Artifact capacity", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-native-bash-capacity-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-native-bash-capacity-artifacts-"));
    const fullOutputPath = join(artifacts, "over-capacity.log");
    await writeFile(fullOutputPath, "123456789", "utf8");
    const storeArtifact = vi.fn();
    const translator = new PiEventTranslator({
      context: { ...context(workspace, events, []), artifactCapacityBytes: 8, storeArtifact },
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const entry = await translator.materializeNativeHistoryEntry({
      id: "native-bash-over-capacity",
      type: "message",
      timestamp: 1,
      data: {
        message: {
          role: "bashExecution",
          command: "print-many",
          output: "preview",
          truncated: true,
          fullOutputPath,
          exitCode: 0,
          cancelled: false
        }
      }
    });
    const projected = projectPiNativeHistory(undefined, { entries: [entry], leafId: entry.id });

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "PI_ARTIFACT_CAPACITY_EXCEEDED" }),
      terminal: false
    }));
    const result = projected.events.find((event) => event.payload.type === "tool_result")?.payload;
    expect(result).toMatchObject({ output: "preview\n[full output artifact unavailable]" });
    expect(result).not.toHaveProperty("artifact");
    expect(storeArtifact).not.toHaveBeenCalled();
  });

  it("projects Pi's real tool wire sequence as one call with final arguments", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-tool-wire-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-tool-wire-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const finalArguments = { path: "README.md", line_start: 4, line_end: 12 };

    await translator.translate({
      type: "message_start",
      message: { role: "assistant", content: [] }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        id: "call-1",
        toolName: "read"
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{\"path\":\"README.md\""
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: ",\"line_start\":4,\"line_end\":12}"
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: finalArguments }
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: finalArguments }],
        stopReason: "toolUse"
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: finalArguments
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "file contents" }], details: {} }
    } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "tool_start")).toEqual([
      {
        type: "tool_start",
        callId: "call-1",
        name: "read",
        input: JSON.stringify(finalArguments)
      }
    ]);
    expect(events.filter((event) => event.type === "tool_update")).toEqual([]);
    expect(events.filter((event) => event.type === "tool_result")).toEqual([
      expect.objectContaining({ type: "tool_result", callId: "call-1", output: "file contents", isError: false })
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_complete",
        blocks: [
          {
            kind: "tool_call",
            callId: "call-1",
            name: "read",
            input: JSON.stringify(finalArguments)
          }
        ]
      })
    );
    expect(events.some((event) => "callId" in event && String(event.callId).startsWith("assistant-"))).toBe(false);
  });

  it("maps Pi's real compaction result field names into typed metadata", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-compaction-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-compaction-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "compaction_start", reason: "manual" } as unknown as PiRpcEvent);
    await translator.translate({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      result: {
        summary: "compacted summary",
        firstKeptEntryId: "kept-entry-7",
        tokensBefore: 12_345,
        estimatedTokensAfter: 2_345
      }
    } as unknown as PiRpcEvent);

    const compactions = events.filter((event) => event.type === "compaction");
    expect(compactions).toHaveLength(2);
    expect(compactions[0]).toMatchObject({
      type: "compaction",
      reason: "manual",
      state: "started",
      automatic: false
    });
    expect(compactions[1]).toMatchObject({
      type: "compaction",
      reason: "manual",
      summary: "compacted summary",
      state: "completed",
      boundaryEntryId: "kept-entry-7",
      tokensBefore: 12_345,
      tokensAfter: 2_345,
      automatic: false,
      willRetry: false
    });
    expect(compactions[0]?.compactionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(compactions[1]?.compactionId).toBe(compactions[0]?.compactionId);
    expect(metadata).toHaveLength(2);
    expect(metadata[1]?.pi).toMatchObject({
      rpcEventType: "compaction_update",
      parentEntryId: "kept-entry-7",
      payload: {
        case: "compactionUpdate",
        value: {
          compactionId: compactions[0]?.compactionId,
          reason: "manual",
          state: "completed",
          boundaryEntryId: "kept-entry-7",
          tokensBefore: 12_345,
          tokensAfter: 2_345,
          summaryPreview: "compacted summary",
          willRetry: false
        }
      }
    });
  });

  it("keeps distinct compaction lifetimes and exposes no-op, aborted, and failed terminals", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-compaction-terminals-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-compaction-terminals-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "compaction_start", reason: "manual" } as unknown as PiRpcEvent);
    await translator.translate({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed: Nothing to compact (session too small)"
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "compaction_start", reason: "overflow" } as unknown as PiRpcEvent);
    await translator.translate({
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: true,
      willRetry: false
    } as unknown as PiRpcEvent);
    await translator.translate({ type: "compaction_start", reason: "manual" } as unknown as PiRpcEvent);
    await translator.translate({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: true,
      errorMessage: "summary provider failed"
    } as unknown as PiRpcEvent);

    const compactions = events.filter((event) => event.type === "compaction");
    expect(compactions.map((event) => event.state)).toEqual([
      "started", "no_op", "started", "aborted", "started", "failed"
    ]);
    expect(compactions.map((event) => event.automatic)).toEqual([false, false, true, true, false, false]);
    expect(compactions.map((event) => event.willRetry)).toEqual([undefined, false, undefined, false, undefined, true]);
    expect(compactions[1]?.compactionId).toBe(compactions[0]?.compactionId);
    expect(compactions[3]?.compactionId).toBe(compactions[2]?.compactionId);
    expect(compactions[5]?.compactionId).toBe(compactions[4]?.compactionId);
    expect(new Set([compactions[0]?.compactionId, compactions[2]?.compactionId, compactions[4]?.compactionId]).size).toBe(3);
    expect(compactions[5]).toMatchObject({
      state: "failed",
      error: { code: "PI_COMPACTION_FAILED", message: "summary provider failed", phase: "compaction", retryable: true }
    });
    expect(compactions[1]).not.toHaveProperty("error");
    expect(events.filter((event) => event.type === "error" && event.error.code === "PI_COMPACTION_FAILED"))
      .toHaveLength(1);

    const compactionMetadata = metadata
      .map((item, index) => ({ event: events[index], pi: item.pi }))
      .filter((item) => item.event?.type === "compaction")
      .map((item) => item.pi?.payload.case === "compactionUpdate" ? item.pi.payload.value : undefined);
    expect(compactionMetadata.map((item) => item?.state)).toEqual([
      "started", "no_op", "started", "aborted", "started", "failed"
    ]);
    expect(compactionMetadata[1]).not.toHaveProperty("error");
  });

  it("fails closed when a compaction terminal has neither a result nor an exact no-op shape", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-malformed-compaction-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-malformed-compaction-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "compaction_start", reason: "manual" } as unknown as PiRpcEvent);
    await translator.translate({
      type: "compaction_end",
      reason: "manual",
      result: null,
      aborted: false,
      willRetry: false
    } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "compaction").at(-1)).toMatchObject({
      state: "failed",
      error: { code: "PI_COMPACTION_FAILED", message: "Pi compaction ended without an authoritative result" }
    });
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(metadata.at(-2)?.pi).toMatchObject({
      payload: {
        case: "compactionUpdate",
        value: {
          state: "failed",
          error: { code: "PI_COMPACTION_FAILED", message: "Pi compaction ended without an authoritative result" }
        }
      }
    });
  });

  it.each(["threshold", "overflow"])("maps Pi's %s compaction reason to the automatic trigger", async (reason) => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), `joko-pi-${reason}-compaction-workspace-`));
    const artifacts = await mkdtemp(join(tmpdir(), `joko-pi-${reason}-compaction-artifacts-`));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });

    await translator.translate({ type: "compaction_start", reason } as unknown as PiRpcEvent);

    expect(metadata[0]?.pi).toMatchObject({
      rpcEventType: "compaction_update",
      payload: {
        case: "compactionUpdate",
        value: { trigger: "automatic", state: "started" }
      }
    });
  });

  it("projects managed tool updates and hidden terminal custom messages into typed background activity", async () => {
    const events: EventPayload[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-subagent-translator-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-subagent-translator-artifacts-"));
    const secret = "subagent-secret-canary";
    const translator = new PiEventTranslator({
      context: context(workspace, events, []),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false,
      redactValues: [secret]
    });
    const activity = {
      [JOKO_SUBAGENT_ACTIVITY_MARKER]: 1,
      taskId: "batch:1",
      agentName: "scout",
      background: true,
      model: "local/model",
      effort: "high",
      timeoutMs: 30_000
    };

    await translator.translate({
      type: "tool_execution_update",
      toolCallId: "batch",
      toolName: "subagent",
      partialResult: {
        content: [{ type: "text", text: "running" }],
        details: { ...activity, status: "running", summary: `checking ${secret}`, startedAt: 100 }
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "batch",
      toolName: "subagent",
      isError: false,
      result: {
        content: [{ type: "text", text: "started" }],
        details: { ...activity, status: "queued", summary: "queued" }
      }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "custom",
        customType: "joko-subagent-activity",
        content: `hidden ${secret}`,
        display: false,
        details: { ...activity, status: "completed", summary: `finished ${secret}`, startedAt: 100, endedAt: 200, progressRatio: 1 }
      }
    } as unknown as PiRpcEvent);

    expect(events.filter((event) => event.type === "background_task")).toEqual([
      expect.objectContaining({ type: "background_task", taskId: "batch:1", state: "running", startedAt: 100, detail: expect.stringContaining("[REDACTED]") }),
      expect.objectContaining({ type: "background_task", taskId: "batch:1", state: "queued" }),
      expect.objectContaining({ type: "background_task", taskId: "batch:1", state: "completed", startedAt: 100, endedAt: 200, progressRatio: 1, detail: expect.stringContaining("[REDACTED]") })
    ]);
    expect(events.some((event) => event.type === "message_complete")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("withholds private Memory tool arguments and results from Events and metadata", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-private-memory-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-private-memory-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const argumentMarker = "PRIVATE-MEMORY-ARGUMENT-MARKER";
    const resultMarker = "PRIVATE-MEMORY-RESULT-MARKER";
    const toolName = "mcp__joko_memory__memory_write";

    await translator.translate({
      type: "tool_execution_start",
      toolCallId: "memory-call",
      toolName,
      args: { body: argumentMarker }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_update",
      toolCallId: "memory-call",
      toolName,
      partialResult: { content: [{ type: "text", text: resultMarker }] }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "memory-call",
      toolName,
      isError: false,
      result: { content: [{ type: "text", text: resultMarker }] }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "memory-call", name: toolName, arguments: { body: argumentMarker } }]
      }
    } as unknown as PiRpcEvent);

    const durableProjection = JSON.stringify({ events, metadata });
    expect(durableProjection).not.toContain(argumentMarker);
    expect(durableProjection).not.toContain(resultMarker);
    expect(durableProjection).toContain("private memory payload withheld");
    expect(durableProjection).toContain("private memory result withheld");
  });

  it("withholds Remote Host execution command and stdin from live and native-history Events", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-private-remote-execution-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-private-remote-execution-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const commandMarker = "REMOTE-EXECUTION-COMMAND-MARKER";
    const inputMarker = "REMOTE-EXECUTION-STDIN-MARKER";
    const toolName = "remote_host_execute";

    await translator.translate({
      type: "tool_execution_start",
      toolCallId: "remote-execution-call",
      toolName,
      args: { host: "fixture", command: commandMarker, input: inputMarker }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_update",
      toolCallId: "remote-execution-call",
      toolName,
      args: { command: commandMarker, input: inputMarker },
      partialResult: { content: [{ type: "text", text: "bounded output" }] }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "tool_execution_end",
      toolCallId: "remote-execution-call",
      toolName,
      args: { command: commandMarker, input: inputMarker },
      isError: false,
      result: { content: [{ type: "text", text: "bounded output" }] }
    } as unknown as PiRpcEvent);
    await translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "remote-execution-call",
          name: toolName,
          arguments: { host: "fixture", command: commandMarker, input: inputMarker }
        }]
      }
    } as unknown as PiRpcEvent);

    const durableProjection = JSON.stringify({ events, metadata });
    expect(durableProjection).not.toContain(commandMarker);
    expect(durableProjection).not.toContain(inputMarker);
    expect(durableProjection).toContain("remote execution command and input withheld");
    expect(events.filter((event) => event.type === "tool_update" || event.type === "tool_result"))
      .toHaveLength(2);
  });

  it("withholds Vision path and focus arguments from live Events while preserving descriptions", async () => {
    const events: EventPayload[] = [];
    const metadata: AdapterEventMetadata[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-private-vision-workspace-"));
    const artifacts = await mkdtemp(join(tmpdir(), "joko-pi-private-vision-artifacts-"));
    const translator = new PiEventTranslator({
      context: context(workspace, events, [], metadata),
      artifactDirectory: artifacts,
      wasAbortRequested: () => false
    });
    const privateArguments = [
      {
        callId: "vision-call",
        toolName: "vision",
        args: {
          path: "C:\\private\\VISION-PATH-MARKER.png",
          query: "VISION-QUERY-MARKER"
        },
        description: "A chart with three rising bars."
      },
      {
        callId: "vision-locate-call",
        toolName: "vision-locate",
        args: {
          path: "C:\\private\\VISION-LOCATE-PATH-MARKER.png",
          target: "VISION-TARGET-MARKER"
        },
        description: "The submit button is near the lower-right corner."
      }
    ] as const;

    for (const tool of privateArguments) {
      await translator.translate({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: tool.callId, name: tool.toolName, arguments: tool.args }]
        }
      } as unknown as PiRpcEvent);
      await translator.translate({
        type: "tool_execution_start",
        toolCallId: tool.callId,
        toolName: tool.toolName,
        args: tool.args
      } as unknown as PiRpcEvent);
      await translator.translate({
        type: "tool_execution_end",
        toolCallId: tool.callId,
        toolName: tool.toolName,
        isError: false,
        result: { content: [{ type: "text", text: tool.description }], details: {} }
      } as unknown as PiRpcEvent);
    }

    const durableProjection = JSON.stringify({ events, metadata });
    for (const marker of [
      "VISION-PATH-MARKER",
      "VISION-QUERY-MARKER",
      "VISION-LOCATE-PATH-MARKER",
      "VISION-TARGET-MARKER"
    ]) {
      expect(durableProjection).not.toContain(marker);
    }
    expect(events.filter((event) => event.type === "tool_start")).toEqual([
      {
        type: "tool_start",
        callId: "vision-call",
        name: "vision",
        input: "[vision image path and focus withheld]"
      },
      {
        type: "tool_start",
        callId: "vision-locate-call",
        name: "vision-locate",
        input: "[vision image path and focus withheld]"
      }
    ]);
    expect(events.filter((event) => event.type === "tool_result")).toEqual([
      expect.objectContaining({ output: "A chart with three rising bars." }),
      expect.objectContaining({ output: "The submit button is near the lower-right corner." })
    ]);
    expect(durableProjection).toContain("vision image path and focus withheld");
  });
});

function context(
  workspaceRoot: string,
  events: EventPayload[],
  storedArtifacts: string[],
  metadataEvents: AdapterEventMetadata[] = []
): AdapterContext {
  const target: TargetDescriptor = {
    id: "translator-target",
    backendId: "pi",
    displayName: "Translator",
    workspaceRoot,
    managed: true,
    trusted: false
  };
  return {
    sessionId: "translator-session",
    generation: 1,
    target,
    signal: new AbortController().signal,
    emit: async (payload, metadata) => {
      events.push(payload);
      if (metadata !== undefined) metadataEvents.push(metadata);
    },
    requestInteraction: async () => ({ kind: "cancelled" }),
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async (sourcePath, options) => {
      const bytes = await readFile(sourcePath);
      storedArtifacts.push(bytes.toString("utf8"));
      return {
        id: "translator-artifact",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
        mimeType: options?.mimeType ?? "application/octet-stream",
        fileName: options?.fileName
      };
    }
  };
}
