import { randomUUID } from "node:crypto";

import {
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeSdkForkOptions,
  type ClaudeSdkGetSessionMessagesOptions,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkListSessionsOptions,
  type ClaudeSdkProbeInput,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage,
  type ClaudeSdkUserMessage
} from "@joko/adapter-claude-code";

const initialization: ClaudeSdkInitializationResult = {
  models: [{
    value: "claude-remote-fixture",
    resolvedModel: "claude-remote-fixture-20260901",
    displayName: "Remote Claude fixture",
    description: "Controlled remote Claude runtime",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsFastMode: true
  }],
  account: { tokenSource: "managed-provider" }
};
export class ControlledClaudeRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly supportsWorkspaceDerivation = false;
  readonly queries: ControlledClaudeQuery[] = [];
  readonly sessions = new Map<string, ClaudeSdkSessionInfo>();
  readonly #failBeforeAdmission = new Set<string>();
  onInput?: (message: ClaudeSdkUserMessage) => void;

  failNextInputBeforeAdmission(sessionId: string): void {
    if (this.#failBeforeAdmission.has(sessionId)) {
      throw new Error(`A controlled Claude pre-admission stream failure is already armed for ${sessionId}.`);
    }
    this.#failBeforeAdmission.add(sessionId);
  }

  async probe(_input: ClaudeSdkProbeInput) {
    return {
      installed: true,
      packageVersion: this.packageVersion,
      cliVersion: "2.1.259",
      initialization
    };
  }

  async query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    const sessionId = params.options.resume ?? params.options.sessionId;
    if (sessionId === undefined) throw new Error("Controlled Query requires an exact native Session ID.");
    this.sessions.set(sessionId, {
      sessionId,
      summary: "Remote Claude product fixture",
      lastModified: Date.now(),
      cwd: params.options.cwd
    });
    const query = new ControlledClaudeQuery(
      params,
      sessionId,
      (message) => this.onInput?.(message),
      () => this.#failBeforeAdmission.delete(sessionId)
    );
    this.queries.push(query);
    return query;
  }

  async retireQuery(query: ClaudeSdkQuery): Promise<void> {
    query.close();
  }

  async getSessionInfo(sessionId: string): Promise<ClaudeSdkSessionInfo | undefined> {
    return this.sessions.get(sessionId);
  }

  async getSessionMessages(
    _sessionId: string,
    _options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    return [];
  }

  async listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    return [...this.sessions.values()].slice(options.offset, options.offset + options.limit);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async forkSession(_sessionId: string, _options: ClaudeSdkForkOptions): Promise<{ readonly sessionId: string }> {
    throw new Error("This controlled remote runtime does not support workspace derivation.");
  }

  ownsSessionFork(): boolean {
    return false;
  }

  async closeSessionOperations(): Promise<void> {}
}

export class ControlledClaudeQuery implements ClaudeSdkQuery {
  readonly receivedInputs: ClaudeSdkUserMessage[] = [];
  readonly #output = new AsyncOutput();
  readonly #sessionId: string;
  readonly #onInput: (message: ClaudeSdkUserMessage) => void;
  readonly #consumePreAdmissionFailure: () => boolean;
  readonly params: ClaudeSdkQueryParams;
  #closed = false;

  constructor(
    params: ClaudeSdkQueryParams,
    sessionId: string,
    onInput: (message: ClaudeSdkUserMessage) => void,
    consumePreAdmissionFailure: () => boolean
  ) {
    this.params = params;
    this.#sessionId = sessionId;
    this.#onInput = onInput;
    this.#consumePreAdmissionFailure = consumePreAdmissionFailure;
    void this.#consume();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#output;
  }

  async #consume(): Promise<void> {
    for await (const message of this.params.prompt) {
      this.receivedInputs.push(message);
      this.#onInput(message);
      if (this.#consumePreAdmissionFailure()) {
        this.#output.fail(new Error("Controlled Claude stream failed after consuming input before admission."));
        return;
      }
      this.#output.push({
        type: "system",
        subtype: "init",
        session_id: this.#sessionId,
        uuid: randomUUID(),
        claude_code_version: "2.1.259",
        apiKeySource: "managed-provider",
        cwd: this.params.options.cwd,
        model: "claude-remote-fixture",
        permissionMode: this.params.options.permissionMode,
        effort: this.params.options.effort ?? "high",
        tools: this.params.options.persistSession === false ? ["Read", "Glob", "Grep"] : ["Read", "Edit", "Bash"],
        mcp_servers: [],
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        capabilities: ["interrupt_receipt_v1"]
      });
      if (this.params.options.extraArgs?.["replay-user-messages"] === null) {
        this.#output.push({ ...message, isReplay: true, session_id: this.#sessionId });
      }
    }
  }

  complete(result: string): void {
    const userMessageUuid = this.receivedInputs.at(-1)?.uuid;
    this.#output.push({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: false,
      num_turns: 1,
      result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: "completed",
      uuid: randomUUID(),
      session_id: this.#sessionId,
      ...(userMessageUuid === undefined ? {} : { user_message_uuid: userMessageUuid }),
      origin: { kind: "human" }
    });
  }

  async interrupt() {
    return { still_queued: [] };
  }

  async stopTask(_taskId: string): Promise<void> {}

  async setPermissionMode(_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]): Promise<void> {}

  async setModel(_model?: string): Promise<void> {}

  async applyFlagSettings(_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]): Promise<void> {}

  async initializationResult(): Promise<ClaudeSdkInitializationResult> {
    return initialization;
  }

  async supportedModels() {
    return initialization.models;
  }

  async accountInfo() {
    return initialization.account;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.params.prompt[Symbol.asyncIterator]().return?.();
    this.#output.close();
  }
}

class AsyncOutput implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #values: unknown[] = [];
  readonly #readers: Array<{
    readonly resolve: (result: IteratorResult<unknown>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(value: unknown): void {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader === undefined) this.#values.push(value);
    else reader.resolve({ value, done: false });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    this.#values.splice(0);
    for (const reader of this.#readers.splice(0)) reader.reject(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader.resolve({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<unknown>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#readers.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}
