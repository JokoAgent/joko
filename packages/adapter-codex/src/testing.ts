import { RpcRemoteFault, TransportFault } from "./errors.js";
import type { JsonObject, JsonValue, RpcId } from "./protocol.js";
import type { RpcRequestOptions, RpcTransport, RpcTransportHandlers } from "./transport.js";

export interface RecordedRpcRequest {
  readonly method: string;
  readonly params: JsonValue | undefined;
  readonly options: RpcRequestOptions;
}

export class ScriptedRpcTransport implements RpcTransport {
  readonly requests: RecordedRpcRequest[] = [];
  readonly notifications: { readonly method: string; readonly params?: JsonValue }[] = [];
  readonly #handler: (method: string, params: JsonValue | undefined, options: RpcRequestOptions) => Promise<JsonValue>;
  #handlers: RpcTransportHandlers | undefined;
  #running = false;
  #nextServerRequestId = 10_000;
  lastServerRequestId: RpcId | undefined;
  #serverResponses = new Map<string, {
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (error: unknown) => void;
  }>();

  constructor(handler: (method: string, params: JsonValue | undefined, options: RpcRequestOptions) => Promise<JsonValue>) {
    this.#handler = handler;
  }

  get running(): boolean {
    return this.#running;
  }

  async start(handlers: RpcTransportHandlers): Promise<void> {
    if (this.#handlers !== undefined) throw new TransportFault("closed", "The scripted transport cannot start twice.");
    this.#handlers = handlers;
    this.#running = true;
  }

  async request(method: string, params: JsonValue | undefined, options: RpcRequestOptions = {}): Promise<JsonValue> {
    if (!this.#running) throw new TransportFault("not_started", "The scripted transport is not running.");
    this.requests.push({ method, params, options });
    return this.#handler(method, params, options);
  }

  async notify(method: string, params?: JsonValue): Promise<void> {
    if (!this.#running) throw new TransportFault("not_started", "The scripted transport is not running.");
    this.notifications.push({ method, ...(params === undefined ? {} : { params }) });
  }

  async respond(id: RpcId, result: JsonValue): Promise<void> {
    const pending = this.#serverResponses.get(String(id));
    if (pending === undefined) throw new TransportFault("protocol_violation", "The scripted response id is unknown.");
    this.#serverResponses.delete(String(id));
    pending.resolve(result);
  }

  async respondError(id: RpcId, code: number, _message: string): Promise<void> {
    const pending = this.#serverResponses.get(String(id));
    if (pending === undefined) throw new TransportFault("protocol_violation", "The scripted response id is unknown.");
    this.#serverResponses.delete(String(id));
    pending.reject(new RpcRemoteFault(code));
  }

  async close(): Promise<void> {
    this.#running = false;
    this.#serverResponses.clear();
  }

  async emitNotification(method: string, params: JsonValue): Promise<void> {
    if (!this.#running || this.#handlers === undefined) throw new TransportFault("not_started", "The scripted transport is not running.");
    await this.#handlers.onNotification({ method, params });
  }

  requestFromServer(method: string, params: JsonValue): Promise<JsonValue> {
    if (!this.#running || this.#handlers === undefined) {
      return Promise.reject(new TransportFault("not_started", "The scripted transport is not running."));
    }
    const id = this.#nextServerRequestId++;
    this.lastServerRequestId = id;
    const result = new Promise<JsonValue>((resolve, reject) => {
      this.#serverResponses.set(String(id), { resolve, reject });
    });
    void Promise.resolve(this.#handlers.onRequest({ method, id, params })).catch((error) => {
      const pending = this.#serverResponses.get(String(id));
      if (pending === undefined) return;
      this.#serverResponses.delete(String(id));
      pending.reject(error);
    });
    return result;
  }

  async exit(stateMayHaveChanged = true): Promise<void> {
    if (!this.#running || this.#handlers === undefined) return;
    this.#running = false;
    await this.#handlers.onExit(new TransportFault(
      "process_exited",
      "The scripted app-server exited.",
      { stateMayHaveChanged }
    ));
  }
}

interface FakeThread {
  readonly id: string;
  readonly cwd: string;
  readonly ephemeral?: boolean;
  name: string | null;
  readonly turns: JsonObject[];
  status: JsonObject;
  readonly createdAt: number;
  updatedAt: number;
}

export class FakeCodexAppServer {
  transport: ScriptedRpcTransport | undefined;
  readonly threads = new Map<string, FakeThread>();
  timeoutNextTurnStart = false;
  completeTurnBeforeStartResponse = false;
  emitNameBeforeStartResponse = false;
  malformedNextTurnStartResponse = false;
  dropNextTurnClientId = false;
  nextThreadReadOverride: JsonObject | undefined;
  modelNextCursor: JsonValue = null;
  threadNextCursor: JsonValue = null;
  threadListPages: readonly (readonly JsonObject[])[] | undefined;
  account: JsonObject | null = { type: "chatgpt", email: null, planType: "plus" };
  accountRateLimits: JsonObject = {
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 50, windowMinutes: 10_080 },
      credits: { hasCredits: true, unlimited: false, balance: "12.5" }
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null
  };
  failNextAccountRead = false;
  failNextModelList = false;
  failNextThreadResumeCode: number | undefined;
  userAgent = "codex/0.151.0-alpha.7.2";
  readonly reviewSkills: JsonObject[] = [];
  readonly reviewSkillErrors: JsonObject[] = [];
  reviewConfig: JsonObject = {};
  readonly reviewMcpStatuses: JsonObject[] = [];
  threadStartResponseOverrides: JsonObject | undefined;
  #nextThread = 1;
  #nextTurn = 1;

  createTransport(): ScriptedRpcTransport {
    let transport: ScriptedRpcTransport;
    transport = new ScriptedRpcTransport((method, params, options) => this.#handle(transport, method, params, options));
    this.transport = transport;
    return transport;
  }

  async completeTurn(threadId: string, text = "completed response"): Promise<void> {
    const transport = this.#requireTransport();
    const thread = this.#thread(threadId);
    const turn = thread.turns.at(-1);
    if (turn === undefined) throw new Error("No fake turn is active.");
    const turnId = String(turn["id"]);
    const item = { type: "agentMessage", id: `item-${turnId}`, text, phase: null, memoryCitation: null, delivery: null };
    await transport.emitNotification("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
    await transport.emitNotification("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text });
    await transport.emitNotification("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
    await transport.emitNotification("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        total: tokenUsage(7, 3),
        last: tokenUsage(7, 3),
        modelContextWindow: 128_000
      }
    });
    turn["status"] = "completed";
    turn["items"] = [...((turn["items"] as JsonValue[]) ?? []), item];
    thread.status = { type: "idle" };
    await transport.emitNotification("turn/completed", { threadId, turn });
  }

  requestCommandApproval(
    threadId: string,
    turnId: string,
    availableDecisions?: readonly JsonValue[]
  ): Promise<JsonValue> {
    return this.#requireTransport().requestFromServer("item/commandExecution/requestApproval", {
      kind: "command",
      threadId,
      turnId,
      itemId: `command-${turnId}`,
      startedAtMs: Date.now(),
      environmentId: "local",
      command: "echo safe",
      cwd: this.#thread(threadId).cwd,
      ...(availableDecisions === undefined ? {} : { availableDecisions: [...availableDecisions] })
    });
  }

  requestUserInput(
    threadId: string,
    turnId: string,
    questions: readonly JsonObject[]
  ): Promise<JsonValue> {
    return this.#requireTransport().requestFromServer("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: `question-${turnId}`,
      isBlocking: true,
      questions: [...questions]
    });
  }

  requestDynamicTool(
    threadId: string,
    turnId: string,
    tool: string,
    args: JsonObject
  ): Promise<JsonValue> {
    return this.#requireTransport().requestFromServer("item/tool/call", {
      threadId,
      turnId,
      callId: `call-${turnId}-${tool}`,
      namespace: null,
      tool,
      arguments: args
    });
  }

  async resolveServerRequest(threadId: string, requestId: RpcId): Promise<void> {
    await this.#requireTransport().emitNotification("serverRequest/resolved", { threadId, requestId });
  }

  async #handle(
    transport: ScriptedRpcTransport,
    method: string,
    params: JsonValue | undefined,
    _options: RpcRequestOptions
  ): Promise<JsonValue> {
    const record = isObject(params) ? params : {};
    switch (method) {
      case "initialize":
        return { userAgent: this.userAgent, codexHome: "/private", platformFamily: "unix", platformOs: "linux" };
      case "skills/list":
        return {
          data: [{
            cwd: Array.isArray(record["cwds"]) && typeof record["cwds"][0] === "string"
              ? record["cwds"][0]
              : "/workspace",
            skills: [...this.reviewSkills],
            errors: [...this.reviewSkillErrors]
          }]
        };
      case "config/read":
        return { config: structuredClone(this.reviewConfig), origins: {}, layers: null };
      case "mcpServerStatus/list":
        return { data: [...this.reviewMcpStatuses], nextCursor: null };
      case "account/read":
        if (this.failNextAccountRead) {
          this.failNextAccountRead = false;
          throw new RpcRemoteFault(-32001);
        }
        return { account: this.account, requiresOpenaiAuth: true };
      case "account/rateLimits/read":
        return this.accountRateLimits;
      case "account/login/start":
        return record["type"] === "chatgptDeviceCode"
          ? { type: "chatgptDeviceCode", loginId: "login-device", verificationUrl: "https://example.invalid/device", userCode: "ABCD" }
          : record["type"] === "chatgpt"
            ? { type: "chatgpt", loginId: "login-browser", authUrl: "https://example.invalid/auth" }
            : { type: "apiKey" };
      case "account/login/cancel":
        return { status: "canceled" };
      case "account/logout":
        this.account = null;
        return {};
      case "model/list":
        if (this.failNextModelList) {
          this.failNextModelList = false;
          throw new RpcRemoteFault(-32001);
        }
        return {
          data: [{
            id: "model-record",
            model: "gpt-test",
            displayName: "GPT Test",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "high", description: "" }
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            serviceTiers: [
              { id: "default", name: "Default", description: "" },
              { id: "fast", name: "Fast", description: "" }
            ],
            defaultServiceTier: "default",
            isDefault: true
          }],
          nextCursor: this.modelNextCursor
        };
      case "thread/start": {
        const thread = this.#newThread(String(record["cwd"] ?? "/workspace"), record["ephemeral"] === true);
        await transport.emitNotification("thread/started", { thread: nativeThread(thread) });
        if (this.emitNameBeforeStartResponse) {
          await transport.emitNotification("thread/name/updated", { threadId: thread.id, threadName: "buffered" });
        }
        return { ...sessionResponse(thread, record), ...this.threadStartResponseOverrides };
      }
      case "thread/resume": {
        if (this.failNextThreadResumeCode !== undefined) {
          const code = this.failNextThreadResumeCode;
          this.failNextThreadResumeCode = undefined;
          throw new RpcRemoteFault(code);
        }
        const thread = this.#thread(String(record["threadId"]));
        return sessionResponse(thread, record);
      }
      case "thread/read": {
        const override = this.nextThreadReadOverride;
        this.nextThreadReadOverride = undefined;
        return {
          thread: override ?? nativeThread(this.#thread(String(record["threadId"])), record["includeTurns"] === true)
        };
      }
      case "thread/list": {
        if (this.threadListPages !== undefined) {
          const rawCursor = typeof record["cursor"] === "string" ? record["cursor"] : "";
          const pageIndex = rawCursor === "" ? 0 : Number(rawCursor.slice("catalog-page-".length));
          const page = Number.isSafeInteger(pageIndex) && pageIndex >= 0
            ? this.threadListPages[pageIndex] ?? []
            : [];
          return {
            data: [...page],
            nextCursor: pageIndex + 1 < this.threadListPages.length ? `catalog-page-${pageIndex + 1}` : null,
            backwardsCursor: null
          };
        }
        return {
          data: [...this.threads.values()].map((thread) => nativeThread(thread)),
          nextCursor: this.threadNextCursor,
          backwardsCursor: null
        };
      }
      case "thread/turns/list": {
        const thread = this.#thread(String(record["threadId"]));
        return { data: thread.turns.slice(-1), nextCursor: null, backwardsCursor: null };
      }
      case "thread/unsubscribe":
      case "thread/settings/update":
      case "thread/name/set": {
        const thread = this.#thread(String(record["threadId"]));
        if (method === "thread/name/set") thread.name = String(record["name"]);
        return {};
      }
      case "thread/compact/start": {
        const thread = this.#thread(String(record["threadId"]));
        setTimeout(() => {
          void this.#completeCompaction(transport, thread).catch(() => undefined);
        }, 0);
        return {};
      }
      case "thread/delete":
        this.threads.delete(String(record["threadId"]));
        return {};
      case "thread/fork": {
        const source = this.#thread(String(record["threadId"]));
        const thread = this.#newThread(String(record["cwd"] ?? source.cwd));
        thread.turns.push(...source.turns.map((turn) => structuredClone(turn)));
        await transport.emitNotification("thread/started", { thread: nativeThread(thread) });
        return sessionResponse(thread, record);
      }
      case "turn/start": {
        const thread = this.#thread(String(record["threadId"]));
        const turn = this.#newTurn(record);
        if (this.dropNextTurnClientId) {
          this.dropNextTurnClientId = false;
          const item = (turn["items"] as JsonObject[])[0];
          if (item !== undefined) item["clientId"] = null;
        }
        thread.turns.push(turn);
        thread.status = { type: "active", activeFlags: [] };
        thread.updatedAt = Math.trunc(Date.now() / 1_000);
        await transport.emitNotification("turn/started", { threadId: thread.id, turn });
        if (this.completeTurnBeforeStartResponse) {
          this.completeTurnBeforeStartResponse = false;
          turn["status"] = "completed";
          thread.status = { type: "idle" };
          await transport.emitNotification("turn/completed", { threadId: thread.id, turn });
        }
        if (this.timeoutNextTurnStart) {
          this.timeoutNextTurnStart = false;
          throw new TransportFault("request_timeout", "The fake response was lost.", { stateMayHaveChanged: true });
        }
        if (this.malformedNextTurnStartResponse) {
          this.malformedNextTurnStartResponse = false;
          return { accepted: true };
        }
        return { turn };
      }
      case "turn/steer": {
        const thread = this.#thread(String(record["threadId"]));
        const turn = thread.turns.at(-1);
        if (turn === undefined) throw new RpcRemoteFault(-32602);
        const items = turn["items"] as JsonValue[];
        items.push({
          type: "userMessage",
          id: `user-steer-${items.length}`,
          clientId: record["clientUserMessageId"] ?? null,
          content: record["input"] ?? []
        });
        return { turnId: turn["id"] as JsonValue };
      }
      case "turn/interrupt": {
        const thread = this.#thread(String(record["threadId"]));
        const turn = thread.turns.at(-1);
        if (turn !== undefined) turn["status"] = "interrupted";
        return {};
      }
      default:
        throw new RpcRemoteFault(-32601);
    }
  }

  #newThread(cwd: string, ephemeral = false): FakeThread {
    const now = Math.trunc(Date.now() / 1_000);
    const thread: FakeThread = {
      id: `thread-${this.#nextThread++}`,
      cwd,
      ephemeral,
      name: null,
      turns: [],
      status: { type: "idle" },
      createdAt: now,
      updatedAt: now
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  #newTurn(params: JsonObject): JsonObject {
    const id = `turn-${this.#nextTurn++}`;
    return {
      id,
      status: "inProgress",
      items: [{
        type: "userMessage",
        id: `user-${id}`,
        clientId: params["clientUserMessageId"] ?? null,
        content: params["input"] ?? []
      }],
      error: null,
      startedAt: Math.trunc(Date.now() / 1_000),
      completedAt: null,
      durationMs: null
    };
  }

  async #completeCompaction(transport: ScriptedRpcTransport, thread: FakeThread): Promise<void> {
    const turnId = `turn-${this.#nextTurn++}`;
    const item = { type: "contextCompaction", id: `compaction-${turnId}` };
    const turn: JsonObject = {
      id: turnId,
      status: "inProgress",
      items: [item],
      error: null,
      startedAt: Math.trunc(Date.now() / 1_000),
      completedAt: null,
      durationMs: null
    };
    thread.turns.push(turn);
    thread.status = { type: "active", activeFlags: [] };
    await transport.emitNotification("turn/started", { threadId: thread.id, turn });
    await transport.emitNotification("item/started", { threadId: thread.id, turnId, item, startedAtMs: Date.now() });
    await transport.emitNotification("item/completed", { threadId: thread.id, turnId, item, completedAtMs: Date.now() });
    turn["status"] = "completed";
    turn["completedAt"] = Math.trunc(Date.now() / 1_000);
    thread.status = { type: "idle" };
    await transport.emitNotification("turn/completed", { threadId: thread.id, turn });
  }

  #thread(id: string): FakeThread {
    const thread = this.threads.get(id);
    if (thread === undefined) throw new RpcRemoteFault(-32602);
    return thread;
  }

  #requireTransport(): ScriptedRpcTransport {
    if (this.transport === undefined) throw new Error("Fake transport is unavailable.");
    return this.transport;
  }
}

function nativeThread(thread: FakeThread, includeTurns = false): JsonObject {
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: thread.ephemeral ?? false,
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    path: null,
    cwd: thread.cwd,
    cliVersion: "1.2.3",
    source: "appServer",
    name: thread.name,
    turns: includeTurns ? thread.turns : []
  };
}

function sessionResponse(thread: FakeThread, params: JsonObject): JsonObject {
  return {
    thread: nativeThread(thread),
    model: typeof params["model"] === "string" ? params["model"] : "gpt-test",
    modelProvider: typeof params["modelProvider"] === "string" ? params["modelProvider"] : "openai",
    cwd: thread.cwd,
    instructionSources: [],
    activePermissionProfile: typeof params["permissions"] === "string"
      ? { id: params["permissions"], extends: null }
      : null,
    runtimeWorkspaceRoots: Array.isArray(params["runtimeWorkspaceRoots"])
      ? params["runtimeWorkspaceRoots"]
      : [],
    approvalPolicy: params["approvalPolicy"] ?? "on-request",
    approvalsReviewer: "user",
    sandbox: params["sandbox"] ?? "workspace-write",
    reasoningEffort: typeof params["effort"] === "string" ? params["effort"] : "medium",
    serviceTier: params["serviceTier"] ?? null
  };
}

function tokenUsage(inputTokens: number, outputTokens: number): JsonObject {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0
  };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}
