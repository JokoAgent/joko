import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import type { PiProcessFactory, PiProcessHandle, PiProcessSpec } from "@joko/adapter-pi/testing";

/**
 * A deterministic Pi JSONL process for the account-boundary product matrix.
 * It exercises the production Adapter and immutable generation files without
 * sending the test OAuth credential to an external inference endpoint.
 */
export class AuthenticationPiProcessFactory {
  readonly processes: AuthenticationPiProcess[] = [];
  readonly promptDispatches: string[] = [];

  readonly create: PiProcessFactory = (spec) => {
    const process = new AuthenticationPiProcess(spec, (message) => this.promptDispatches.push(message));
    this.processes.push(process);
    return process;
  };
}

class AuthenticationPiProcess extends EventEmitter implements PiProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 91_000;
  readonly commands: Record<string, unknown>[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly spec: PiProcessSpec;
  readonly #onPrompt: (message: string) => void;
  #pending = Buffer.alloc(0);
  #sessionId: string;
  #sessionFile: string;
  #model = model("local", "test-model");

  constructor(spec: PiProcessSpec, onPrompt: (message: string) => void) {
    super();
    this.spec = spec;
    this.#onPrompt = onPrompt;
    const sessionDirectory = argument(spec.args, "--session-dir");
    const resumed = optionalArgument(spec.args, "--session");
    this.#model = model(argument(spec.args, "--provider"), argument(spec.args, "--model"));
    this.#sessionId = optionalArgument(spec.args, "--session-id") ?? "resumed-auth-session";
    this.#sessionFile = resumed ?? join(sessionDirectory, `${this.#sessionId}.jsonl`);
    mkdirSync(sessionDirectory, { recursive: true });
    if (resumed === undefined) this.#writeSession();
    else {
      const header = JSON.parse(readFileSync(resumed, "utf8").split(/\r?\n/u)[0]!) as { readonly id?: unknown };
      if (typeof header.id === "string") this.#sessionId = header.id;
    }
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#pending = Buffer.concat([this.#pending, chunk]);
        let newline: number;
        while ((newline = this.#pending.indexOf(0x0a)) >= 0) {
          const command = JSON.parse(this.#pending.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
          this.#pending = this.#pending.subarray(newline + 1);
          this.#handle(command);
        }
        callback();
      }
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exitCode !== null) return false;
    this.signalCode = typeof signal === "string" ? signal : null;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("exit", 0, this.signalCode));
    return true;
  }

  #handle(command: Record<string, unknown>): void {
    this.commands.push(command);
    switch (command.type) {
      case "get_state":
        this.#success(command, {
          model: this.#model,
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile: this.#sessionFile,
          sessionId: this.#sessionId,
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        });
        return;
      case "get_session_stats":
        this.#success(command, {
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          cost: 0,
          contextUsage: { tokens: 2, contextWindow: this.#model.contextWindow, percent: 2 / this.#model.contextWindow * 100 }
        });
        return;
      case "get_available_models":
        this.#success(command, { models: [this.#model] });
        return;
      case "get_available_thinking_levels":
        this.#success(command, { levels: ["off", "low", "medium", "high"] });
        return;
      case "get_tree":
        this.#success(command, { tree: [], leafId: null });
        return;
      case "get_entries":
        this.#success(command, { entries: [], leafId: null });
        return;
      case "get_commands":
        this.#success(command, { commands: managedCommands(this.spec) });
        return;
      case "set_model":
        this.#model = model(String(command.provider), String(command.modelId));
        this.#success(command, this.#model);
        return;
      case "prompt":
      case "steer":
      case "follow_up": {
        const message = String(command.message ?? "");
        this.#onPrompt(message);
        this.#success(command);
        this.#send({ type: "agent_start" });
        this.#send({ type: "message_start", message: { role: "assistant", content: [] } });
        this.#send({
          type: "message_update",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "authenticated fixture response" }
        });
        this.#send({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "authenticated fixture response" }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
          }
        });
        this.#send({ type: "agent_end", messages: [], willRetry: false });
        this.#send({ type: "agent_settled" });
        return;
      }
      case "switch_session": {
        this.#sessionFile = String(command.sessionPath);
        const header = JSON.parse(readFileSync(this.#sessionFile, "utf8").split(/\r?\n/u)[0]!) as {
          readonly id?: unknown;
        };
        if (typeof header.id === "string") this.#sessionId = header.id;
        this.#success(command, { cancelled: false });
        return;
      }
      default:
        this.#success(command);
    }
  }

  #success(command: Record<string, unknown>, data?: unknown): void {
    this.#send({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data })
    });
  }

  #send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  #writeSession(): void {
    writeFileSync(this.#sessionFile, `${JSON.stringify({
      type: "session",
      version: 3,
      id: this.#sessionId,
      timestamp: new Date().toISOString(),
      cwd: this.spec.cwd
    })}\n`);
  }
}

function model(provider: string, id: string) {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    contextWindow: 32_768,
    maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function argument(args: readonly string[], name: string): string {
  const value = optionalArgument(args, name);
  if (value === undefined) throw new Error(`Authentication Pi process is missing ${name}.`);
  return value;
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function managedCommands(spec: PiProcessSpec): readonly Record<string, unknown>[] {
  const extensions = valuesForArgument(spec.args, "--extension");
  const bridgePath = extensions.findLast((candidate) =>
    candidate.replace(/\\/gu, "/").endsWith("/joko-managed-bridge.ts"));
  if (bridgePath === undefined) throw new Error("Authentication Pi process has no managed bridge extension.");
  const subagentPath = extensions.find((candidate) =>
    candidate.replace(/\\/gu, "/").endsWith("/joko-managed-subagent.ts"));
  const command = (name: string, path: string) => ({
    name,
    description: name,
    source: "extension",
    sourceInfo: { path, scope: "temporary" }
  });
  return [
    command("plan:1", bridgePath),
    command("joko-navigate-tree", bridgePath),
    command("joko-rebuild-context", bridgePath),
    command("joko-reset-context", bridgePath),
    ...(subagentPath === undefined ? [] : [command("joko-stop-background-task", subagentPath)])
  ];
}

function valuesForArgument(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === name) values.push(args[index + 1]!);
  }
  return values;
}
