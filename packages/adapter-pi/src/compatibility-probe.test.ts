import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { piError } from "./errors.js";
import {
  runTypedPiCompatibilityProbe,
  type PiCompatibilityTransport
} from "./compatibility-probe.js";
import type { PiRpcCommand, PiRpcEvent } from "./protocol.js";

interface ProbeFixtureOptions {
  readonly rejectTree?: boolean;
  readonly malformedState?: boolean;
  readonly omitLastAssistantText?: boolean;
  readonly omitSettled?: boolean;
  readonly omitBridgeCommand?: boolean;
  readonly omitBridgeStatus?: boolean;
}

class ProbeFixtureTransport implements PiCompatibilityTransport {
  readonly #listeners = new Set<(event: PiRpcEvent) => void>();
  readonly #bridgePath: string;
  readonly #options: ProbeFixtureOptions;
  #handshakeSent = false;

  constructor(bridgePath: string, options: ProbeFixtureOptions = {}) {
    this.#bridgePath = bridgePath;
    this.#options = options;
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request(command: PiRpcCommand): Promise<unknown> {
    if (!this.#handshakeSent && !this.#options.omitBridgeStatus) {
      this.#handshakeSent = true;
      this.#emit({
        type: "extension_ui_request",
        id: "compatibility-status",
        method: "setStatus",
        statusKey: "joko-compatibility/v1",
        statusText: JSON.stringify({ format: 1, terminalEvent: "agent_settled" })
      });
    }
    switch (command.type) {
      case "get_state":
        return this.#response(command, this.#options.malformedState
          ? { sessionId: 7, isStreaming: "no" }
          : compatibleState());
      case "get_commands":
        return this.#response(command, {
          commands: this.#options.omitBridgeCommand ? [] : [{
            name: "joko-compatibility",
            description: "probe",
            source: "extension",
            sourceInfo: { path: this.#bridgePath, scope: "temporary" }
          }]
        });
      case "get_tree":
        if (this.#options.rejectTree) throw piError("PI_RPC_REJECTED", "unknown command", "dispatch");
        return this.#response(command, { tree: [], leafId: null });
      case "get_entries":
        return this.#response(command, { entries: [], leafId: null });
      case "get_messages":
        return this.#response(command, { messages: [] });
      case "get_available_models":
        return this.#response(command, { models: [] });
      case "get_available_thinking_levels":
        return this.#response(command, { levels: ["off"] });
      case "get_session_stats":
        return this.#response(command, { tokens: {}, cost: 0 });
      case "get_fork_messages":
        return this.#response(command, { messages: [] });
      case "get_last_assistant_text":
        return this.#response(command, this.#options.omitLastAssistantText ? {} : { text: null });
      case "prompt":
        this.#emit({ type: "agent_start" });
        this.#emit({ type: "agent_end", messages: [], willRetry: false });
        if (!this.#options.omitSettled) this.#emit({ type: "agent_settled" });
        return this.#response(command);
      default:
        throw new Error(`Unexpected command '${command.type}'`);
    }
  }

  #response(command: PiRpcCommand, data?: unknown): unknown {
    return {
      type: "response",
      id: "fixture",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data })
    };
  }

  #emit(event: PiRpcEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

describe("Pi typed compatibility probe", () => {
  const bridgePath = resolve("compatibility-extension.mjs");

  it("downgrades a rejected optional get_tree without hiding the compatible lifecycle", async () => {
    const report = await runTypedPiCompatibilityProbe(
      new ProbeFixtureTransport(bridgePath, { rejectTree: true }),
      { executableIdentity: "fixture", extensionPath: bridgePath, timeoutMs: 250 }
    );

    expect(report.unsupportedCommands).toContain("get_tree");
    expect(report.observedEvents).toEqual(expect.arrayContaining(["agent_start", "agent_settled"]));
  });

  it("accepts the native empty-session shape for the last assistant text", async () => {
    const report = await runTypedPiCompatibilityProbe(
      new ProbeFixtureTransport(bridgePath, { omitLastAssistantText: true }),
      { executableIdentity: "fixture", extensionPath: bridgePath, timeoutMs: 250 }
    );

    expect(report.unsupportedCommands).not.toContain("get_last_assistant_text");
  });

  it("rejects a malformed critical get_state response", async () => {
    await expect(runTypedPiCompatibilityProbe(
      new ProbeFixtureTransport(bridgePath, { malformedState: true }),
      { executableIdentity: "fixture", extensionPath: bridgePath, timeoutMs: 250 }
    )).rejects.toMatchObject({ publicError: { code: "PI_COMPATIBILITY_STATE_INVALID" } });
  });

  it("rejects an executable that never publishes the critical settlement event", async () => {
    await expect(runTypedPiCompatibilityProbe(
      new ProbeFixtureTransport(bridgePath, { omitSettled: true }),
      { executableIdentity: "fixture", extensionPath: bridgePath, timeoutMs: 250 }
    )).rejects.toMatchObject({ publicError: { code: "PI_COMPATIBILITY_LIFECYCLE_TIMEOUT" } });
  });

  it("rejects a missing extension bridge handshake", async () => {
    await expect(runTypedPiCompatibilityProbe(
      new ProbeFixtureTransport(bridgePath, { omitBridgeCommand: true }),
      { executableIdentity: "fixture", extensionPath: bridgePath, timeoutMs: 250 }
    )).rejects.toMatchObject({ publicError: { code: "PI_COMPATIBILITY_BRIDGE_INCOMPLETE" } });
  });

  it("bounds a bridge command that never publishes its startup status", async () => {
    await expect(runTypedPiCompatibilityProbe(
      new ProbeFixtureTransport(bridgePath, { omitBridgeStatus: true }),
      { executableIdentity: "fixture", extensionPath: bridgePath, timeoutMs: 250 }
    )).rejects.toMatchObject({ publicError: { code: "PI_COMPATIBILITY_BRIDGE_TIMEOUT" } });
  });
});

function compatibleState(): Record<string, unknown> {
  return {
    model: {
      provider: "local",
      id: "model",
      name: "Model",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: 4_096,
      maxTokens: 64,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile: resolve("probe-session.jsonl"),
    sessionId: "probe-session",
    autoCompactionEnabled: false,
    messageCount: 0,
    pendingMessageCount: 0
  };
}
