import type {
  AdapterContext,
  EventPayload,
  NativeSessionBinding,
  TargetDescriptor
} from "@joko/core";
import { expect, test } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";

const enabled = process.env["JOKO_RUN_REAL_PROVIDER_SMOKE"] === "1"
  && process.env["JOKO_RUN_REAL_CLAUDE_CODE_SMOKE"] === "1";
const realProviderTest = enabled ? test : test.skip;

realProviderTest("streams one real Claude Code turn only after both explicit smoke opt-ins", async () => {
  const instanceGeneration = 9_001;
  const target: TargetDescriptor = {
    id: "real-claude-code-smoke",
    backendId: "claude-code",
    displayName: "Real provider smoke workspace",
    workspaceRoot: process.cwd(),
    managed: false,
    trusted: true
  };
  const adapter = new ClaudeCodeAdapter({ instanceGeneration });
  const abortController = new AbortController();
  const events: EventPayload[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  const baseContext: AdapterContext = {
    sessionId: `real-smoke-${Date.now()}`,
    generation: 1,
    backendInstanceGeneration: instanceGeneration,
    target,
    signal: abortController.signal,
    emit: async (payload) => {
      events.push(payload);
      if (payload.type === "done") resolveDone();
    },
    requestInteraction: async () => ({ kind: "cancelled" }),
    artifactCapacityBytes: 1_024,
    storeArtifact: async () => {
      throw new Error("The real provider smoke does not materialize artifacts.");
    }
  };
  let binding: NativeSessionBinding | undefined;
  try {
    binding = await adapter.createSession({
      target,
      fastMode: false,
      permissionMode: "ask",
      appendSystemPrompt: "For this smoke check, do not call tools and answer with only OK.",
      nativeStart: { kind: "new" }
    }, baseContext);
    await adapter.send({
      text: "Reply with exactly OK.",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    }, {
      ...baseContext,
      binding,
      operationId: `real-smoke-operation-${Date.now()}`
    });
    await Promise.race([
      done,
      new Promise<never>((_, rejectPromise) => {
        setTimeout(() => rejectPromise(new Error("Real Claude Code smoke timed out.")), 120_000);
      })
    ]);
    expect(events.some((event) => event.type === "message_complete" && event.role === "assistant")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
  } finally {
    if (binding !== undefined) {
      await adapter.closeSession(binding, { ...baseContext, binding }).catch(() => undefined);
    }
    await adapter.dispose();
  }
}, 150_000);
