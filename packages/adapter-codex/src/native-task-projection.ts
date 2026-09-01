import { createHash } from "node:crypto";
import {
  type EventPayload,
  type PublicError,
  type SubagentActivityEntry,
  type SubagentChildRun,
  type SubagentRunDetail,
  type SubagentRunState,
  type SubagentTranscriptEntry,
  type SubagentUsage
} from "@joko/core";
import { isJsonObject, type JsonObject, type JsonValue, type NativeThread } from "./protocol.js";
import { safeText } from "./translator.js";

const MAXIMUM_RUNS = 2_048;
const MAXIMUM_CHILDREN = 4_096;
const MAXIMUM_ACTIVITY_ENTRIES = 512;
const MAXIMUM_TEXT_CHARACTERS = 64 * 1024;
const MAXIMUM_SUMMARY_CHARACTERS = 4 * 1024;
const MAXIMUM_IDENTIFIER_CHARACTERS = 512;
const MAXIMUM_PENDING_MESSAGES = 2_048;
const SUMMARY_EMIT_INTERVAL = 256;

type ProjectedTaskPayload = Extract<EventPayload, {
  readonly type: "background_task" | "subagent_run" | "subagent_transcript";
}>;

export interface CodexNativeTaskLineage {
  readonly childThreadId: string;
  readonly parentThreadId: string;
}

export interface CodexNativeTaskEffects {
  readonly emissions: readonly ProjectedTaskPayload[];
  readonly lineages: readonly CodexNativeTaskLineage[];
}

interface ChildRecord {
  readonly rawThreadId: string;
  readonly id: string;
  readonly identityAliases: string[];
  state: SubagentRunState;
  role: string;
  title: string;
  modelId?: string;
  thinkingLevel?: string;
  usage?: SubagentUsage;
  result?: string;
  resultTruncated: boolean;
  error?: PublicError;
  activeTurnId?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  lastToolName?: string;
  toolUses: number;
}

interface RunRecord {
  readonly rawCallId: string;
  readonly id: string;
  readonly parentThreadId: string;
  readonly children: Map<string, ChildRecord>;
  readonly activity: SubagentActivityEntry[];
  readonly identityAliases: string[];
  parentRunId?: string;
  parentTaskId?: string;
  parentToolCallId?: string;
  title: string;
  assignment?: string;
  summary?: string;
  modelId?: string;
  thinkingLevel?: string;
  state: SubagentRunState;
  activitySequence: number;
  transcriptSequence: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: PublicError;
  terminalLatch?: "failed" | "stopped";
  assignmentEmitted: boolean;
}

interface ChildLocation {
  readonly run: RunRecord;
  readonly child: ChildRecord;
}

interface PendingMessage {
  value: string;
  truncated: boolean;
  reportedLength: number;
}

export class CodexNativeTaskProjection {
  readonly #sessionId: string;
  readonly #rootThreadId: string;
  #providerId: string;
  #fallbackModelId: string | undefined;
  #fallbackThinkingLevel: string | undefined;
  readonly #now: () => number;
  readonly #runs = new Map<string, RunRecord>();
  readonly #children = new Map<string, ChildLocation>();
  readonly #pendingMessages = new Map<string, PendingMessage>();

  constructor(options: {
    readonly sessionId: string;
    readonly rootThreadId: string;
    readonly providerId?: string;
    readonly modelId?: string;
    readonly thinkingLevel?: string;
    readonly now?: () => number;
  }) {
    this.#sessionId = options.sessionId;
    this.#rootThreadId = options.rootThreadId;
    this.#providerId = options.providerId ?? "openai";
    this.#fallbackModelId = options.modelId;
    this.#fallbackThinkingLevel = options.thinkingLevel;
    this.#now = options.now ?? Date.now;
  }

  updateRoute(providerId: string | undefined, modelId: string | undefined, thinkingLevel: string | undefined): void {
    if (providerId !== undefined) this.#providerId = providerId;
    this.#fallbackModelId = modelId;
    this.#fallbackThinkingLevel = thinkingLevel;
  }

  seed(thread: NativeThread): readonly CodexNativeTaskLineage[] {
    const lineages: CodexNativeTaskLineage[] = [];
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        const effects = this.#observeItem(this.#rootThreadId, item, "completed", this.#now(), false);
        lineages.push(...effects.lineages);
      }
    }
    return uniqueLineages(lineages);
  }

  observeRootNotification(method: string, params: JsonValue): CodexNativeTaskEffects {
    return this.#observeNotification(this.#rootThreadId, method, params);
  }

  observeDescendantThreadStarted(params: JsonValue): CodexNativeTaskEffects {
    if (!isJsonObject(params) || !isJsonObject(params["thread"])) return emptyEffects();
    const thread = params["thread"];
    const rawThreadId = nativeIdentity(thread["id"]);
    const parentThreadId = nativeIdentity(thread["parentThreadId"]);
    if (rawThreadId === undefined || parentThreadId === undefined || rawThreadId === parentThreadId) {
      return emptyEffects();
    }
    const location = this.#children.get(rawThreadId) ?? this.#implicitRun(rawThreadId, parentThreadId, this.#now());
    if (location === undefined) return emptyEffects();
    const role = boundedText(thread["agentRole"], 128) ?? boundedText(thread["agentNickname"], 128);
    const nickname = boundedText(thread["agentNickname"], 256);
    if (role !== undefined) location.child.role = role;
    if (nickname !== undefined) location.child.title = nickname;
    location.child.updatedAt = this.#now();
    this.#refreshRun(location.run, location.child.updatedAt);
    return {
      emissions: this.#snapshot(location.run, this.#assignmentEntries(location.run)),
      lineages: [{ childThreadId: rawThreadId, parentThreadId }]
    };
  }

  observeDescendantNotification(
    childThreadId: string,
    method: string,
    params: JsonValue
  ): CodexNativeTaskEffects {
    if (!this.#children.has(childThreadId)) return emptyEffects();
    return this.#observeNotification(childThreadId, method, params);
  }

  ownsActiveTurn(threadId: string, turnId: string): boolean {
    const child = this.#children.get(threadId)?.child;
    return child !== undefined && child.activeTurnId === turnId && activeState(child.state);
  }

  terminateActive(
    state: "failed" | "stopped",
    error?: PublicError
  ): readonly ProjectedTaskPayload[] {
    const emissions: ProjectedTaskPayload[] = [];
    const occurredAt = this.#now();
    for (const run of this.#runs.values()) {
      if (!activeState(run.state)) continue;
      run.terminalLatch = state;
      for (const child of run.children.values()) {
        if (!activeState(child.state)) continue;
        child.state = state;
        child.activeTurnId = undefined;
        child.updatedAt = occurredAt;
        child.endedAt = occurredAt;
        child.error = state === "failed" ? error ?? runtimeLostError() : undefined;
      }
      run.state = state;
      run.updatedAt = occurredAt;
      run.endedAt = occurredAt;
      run.error = state === "failed" ? error ?? runtimeLostError() : undefined;
      this.#activity(run, state, state, state === "failed" ? run.error?.message : "Stopped with the native runtime.", occurredAt);
      const entry = this.#transcript(run, {
        role: "system",
        content: state === "failed" ? run.error?.message ?? "Delegated work failed." : "Delegated work stopped.",
        occurredAt,
        isError: state === "failed",
        systemEvent: { kind: state === "failed" ? "task_failed" : "task_stopped" }
      });
      emissions.push(...this.#snapshot(run, [entry]));
    }
    this.#pendingMessages.clear();
    return emissions;
  }

  #observeNotification(threadId: string, method: string, params: JsonValue): CodexNativeTaskEffects {
    if (!isJsonObject(params)) return emptyEffects();
    const occurredAt = protocolTime(params, this.#now());
    if (method === "turn/started") return this.#turnStarted(threadId, params, occurredAt);
    if (method === "turn/completed") return this.#turnCompleted(threadId, params, occurredAt);
    if (method === "thread/tokenUsage/updated") return this.#usageUpdated(threadId, params, occurredAt);
    if (method === "thread/status/changed") return this.#threadStatusChanged(threadId, params, occurredAt);
    if (method === "item/agentMessage/delta") return this.#messageDelta(threadId, params, occurredAt);
    if (method !== "item/started" && method !== "item/completed") return emptyEffects();
    const item = isJsonObject(params["item"]) ? params["item"] : undefined;
    if (item === undefined) return emptyEffects();
    return this.#observeItem(
      threadId,
      item,
      method === "item/started" ? "started" : "completed",
      occurredAt,
      true
    );
  }

  #turnStarted(threadId: string, params: JsonObject, occurredAt: number): CodexNativeTaskEffects {
    if (threadId === this.#rootThreadId) return emptyEffects();
    const location = this.#children.get(threadId);
    const turn = isJsonObject(params["turn"]) ? params["turn"] : undefined;
    const turnId = nativeIdentity(turn?.["id"]);
    if (location === undefined || turnId === undefined) return emptyEffects();
    if (location.run.terminalLatch !== undefined) return emptyEffects();
    const resumed = !activeState(location.child.state);
    location.child.state = "running";
    location.child.activeTurnId = turnId;
    location.child.updatedAt = occurredAt;
    location.child.endedAt = undefined;
    location.child.error = undefined;
    this.#refreshRun(location.run, occurredAt);
    this.#activity(location.run, resumed ? "resumed" : "progress", "running", resumed ? "Delegated work resumed." : "Delegated work is running.", occurredAt);
    return { emissions: this.#snapshot(location.run, this.#assignmentEntries(location.run)), lineages: [] };
  }

  #turnCompleted(threadId: string, params: JsonObject, occurredAt: number): CodexNativeTaskEffects {
    if (threadId === this.#rootThreadId) return emptyEffects();
    const location = this.#children.get(threadId);
    const turn = isJsonObject(params["turn"]) ? params["turn"] : undefined;
    const turnId = nativeIdentity(turn?.["id"]);
    if (location === undefined || turnId === undefined || location.child.activeTurnId !== turnId) return emptyEffects();
    const status = turn?.["status"];
    const next = status === "completed" ? "completed" : status === "interrupted" ? "stopped" : "failed";
    location.child.state = next;
    location.child.activeTurnId = undefined;
    location.child.updatedAt = occurredAt;
    location.child.endedAt = occurredAt;
    location.child.error = next === "failed" ? childFailure(turn?.["error"]) : undefined;
    this.#clearPendingMessagesForThread(threadId);
    this.#refreshRun(location.run, occurredAt);
    this.#activity(
      location.run,
      next,
      location.run.state,
      next === "failed" ? location.child.error?.message : next === "stopped" ? "Delegated work was interrupted." : location.child.result,
      occurredAt,
      location.child.lastToolName
    );
    return { emissions: this.#snapshot(location.run, []), lineages: [] };
  }

  #usageUpdated(threadId: string, params: JsonObject, occurredAt: number): CodexNativeTaskEffects {
    const location = this.#children.get(threadId);
    if (location === undefined) return emptyEffects();
    const tokenUsage = isJsonObject(params["tokenUsage"]) ? params["tokenUsage"] : undefined;
    const last = isJsonObject(tokenUsage?.["last"]) ? tokenUsage["last"] : undefined;
    if (last === undefined) return emptyEffects();
    const inputTokens = token(last["inputTokens"]);
    const outputTokens = token(last["outputTokens"]);
    const cacheReadTokens = token(last["cachedInputTokens"]);
    const cacheWriteTokens = token(last["cacheWriteInputTokens"]);
    const totalTokens = token(last["totalTokens"]);
    location.child.usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: totalTokens || inputTokens + outputTokens,
      toolUses: location.child.toolUses
    };
    location.child.updatedAt = occurredAt;
    this.#refreshRun(location.run, occurredAt);
    return { emissions: this.#snapshot(location.run, []), lineages: [] };
  }

  #threadStatusChanged(threadId: string, params: JsonObject, occurredAt: number): CodexNativeTaskEffects {
    const location = this.#children.get(threadId);
    const status = isJsonObject(params["status"]) ? params["status"] : undefined;
    if (location === undefined || status?.["type"] !== "systemError" || !activeState(location.child.state)) {
      return emptyEffects();
    }
    location.child.state = "failed";
    location.child.activeTurnId = undefined;
    location.child.updatedAt = occurredAt;
    location.child.endedAt = occurredAt;
    location.child.error = childFailure(undefined);
    this.#clearPendingMessagesForThread(threadId);
    this.#refreshRun(location.run, occurredAt);
    this.#activity(location.run, "failed", location.run.state, location.child.error.message, occurredAt);
    return { emissions: this.#snapshot(location.run, []), lineages: [] };
  }

  #messageDelta(threadId: string, params: JsonObject, occurredAt: number): CodexNativeTaskEffects {
    const location = this.#children.get(threadId);
    const itemId = nativeIdentity(params["itemId"]);
    const delta = boundedText(params["delta"], MAXIMUM_TEXT_CHARACTERS, true);
    if (location === undefined || itemId === undefined || delta === undefined) return emptyEffects();
    const key = pendingMessageKey(threadId, itemId);
    const pending = this.#pendingMessage(key);
    appendBounded(pending, delta);
    location.child.updatedAt = occurredAt;
    location.run.summary = boundedText(pending.value, MAXIMUM_SUMMARY_CHARACTERS, true);
    this.#refreshRun(location.run, occurredAt);
    if (pending.reportedLength !== 0 && pending.value.length - pending.reportedLength < SUMMARY_EMIT_INTERVAL) {
      return emptyEffects();
    }
    pending.reportedLength = pending.value.length;
    return { emissions: this.#snapshot(location.run, this.#assignmentEntries(location.run)), lineages: [] };
  }

  #observeItem(
    threadId: string,
    item: JsonObject,
    phase: "started" | "completed",
    occurredAt: number,
    emit: boolean
  ): CodexNativeTaskEffects {
    const type = item["type"];
    if (type === "collabAgentToolCall") return this.#observeCollaboration(threadId, item, phase, occurredAt, emit);
    if (type === "subAgentActivity") return this.#observeActivityItem(threadId, item, phase, occurredAt, emit);
    if (threadId === this.#rootThreadId) return emptyEffects();
    const location = this.#children.get(threadId);
    if (location === undefined) return emptyEffects();
    if (type === "agentMessage") return this.#observeAgentMessage(location, item, phase, occurredAt, emit);
    const tool = toolDescriptor(item);
    if (tool === undefined) return emptyEffects();
    location.child.lastToolName = tool.name;
    location.child.updatedAt = occurredAt;
    if (phase === "started") location.child.toolUses += 1;
    location.child.usage = mergeToolUses(location.child.usage, location.child.toolUses);
    this.#refreshRun(location.run, occurredAt);
    if (!emit) return emptyEffects();
    this.#activity(location.run, "progress", location.run.state, `${tool.name} ${phase}.`, occurredAt, tool.name);
    const entry = this.#transcript(location.run, {
      role: "tool",
      childId: location.child.id,
      childTitle: location.child.title,
      content: phase === "started" ? `${tool.name} started.` : `${tool.name} completed.`,
      occurredAt,
      toolName: tool.name,
      toolCallId: opaqueId("codex-tool", nativeIdentity(item["id"]) ?? `${threadId}:${occurredAt}`),
      toolPhase: phase === "started" ? "start" : "end",
      isError: phase === "completed" && tool.failed
    });
    return { emissions: this.#snapshot(location.run, [entry]), lineages: [] };
  }

  #observeCollaboration(
    sourceThreadId: string,
    item: JsonObject,
    phase: "started" | "completed",
    occurredAt: number,
    emit: boolean
  ): CodexNativeTaskEffects {
    const tool = item["tool"];
    const receivers = nativeIdentityArray(item["receiverThreadIds"]);
    const states = isJsonObject(item["agentsStates"]) ? item["agentsStates"] : {};
    const stateThreadIds = nativeIdentityKeys(states);
    const targetThreadIds = [...new Set([...receivers, ...stateThreadIds])];
    if (targetThreadIds.length > MAXIMUM_CHILDREN) {
      throw new Error("The Codex delegated-child set exceeded its safe limit.");
    }
    if (tool !== "spawnAgent") {
      const touched = new Set<RunRecord>();
      for (const rawThreadId of targetThreadIds) {
        const location = this.#children.get(rawThreadId);
        if (location === undefined) continue;
        this.#applyNativeState(location, states[rawThreadId], occurredAt);
        touched.add(location.run);
      }
      if (!emit || touched.size === 0) return emptyEffects();
      return {
        emissions: [...touched].flatMap((run) => this.#snapshot(run, [])),
        lineages: []
      };
    }
    const rawCallId = nativeIdentity(item["id"]);
    if (rawCallId === undefined) return emptyEffects();
    this.#assertLineageTargets(rawCallId, sourceThreadId, targetThreadIds);
    const run = this.#run(rawCallId, sourceThreadId, item, occurredAt);
    const lineages: CodexNativeTaskLineage[] = [];
    for (const rawThreadId of receivers) {
      const child = this.#child(run, rawThreadId, occurredAt);
      this.#applyNativeState({ run, child }, states[rawThreadId], occurredAt);
      lineages.push({ childThreadId: rawThreadId, parentThreadId: sourceThreadId });
    }
    for (const rawThreadId of stateThreadIds) {
      const child = this.#child(run, rawThreadId, occurredAt);
      this.#applyNativeState({ run, child }, states[rawThreadId], occurredAt);
      if (!receivers.includes(rawThreadId)) lineages.push({ childThreadId: rawThreadId, parentThreadId: sourceThreadId });
    }
    const spawnTerminal = phase === "completed" ? spawnTerminalState(item["status"]) : undefined;
    if (spawnTerminal !== undefined) {
      this.#latchRun(run, spawnTerminal, occurredAt);
    }
    this.#refreshRun(run, occurredAt);
    if (!emit) return { emissions: [], lineages: uniqueLineages(lineages) };
    const assignmentEntries = this.#assignmentEntries(run);
    return {
      emissions: this.#snapshot(run, assignmentEntries),
      lineages: uniqueLineages(lineages)
    };
  }

  #observeActivityItem(
    sourceThreadId: string,
    item: JsonObject,
    phase: "started" | "completed",
    occurredAt: number,
    emit: boolean
  ): CodexNativeTaskEffects {
    const rawThreadId = nativeIdentity(item["agentThreadId"]);
    if (rawThreadId === undefined) return emptyEffects();
    const location = this.#children.get(rawThreadId) ?? this.#implicitRun(rawThreadId, sourceThreadId, occurredAt);
    if (location === undefined) return emptyEffects();
    const role = boundedText(item["agentPath"], 128);
    if (role !== undefined) location.child.role = role;
    const kind = item["kind"];
    if (location.run.terminalLatch !== undefined) {
      location.child.state = location.run.terminalLatch;
      location.child.activeTurnId = undefined;
      location.child.endedAt = location.run.endedAt ?? occurredAt;
      location.child.error = location.run.terminalLatch === "failed"
        ? location.run.error ?? childFailure(undefined)
        : undefined;
    } else if (kind === "started" || kind === "interacted") {
      location.child.state = "running";
      location.child.endedAt = undefined;
      location.child.error = undefined;
    } else if (kind === "interrupted") {
      location.child.state = "stopped";
      location.child.endedAt = occurredAt;
    } else if (kind === "completed") {
      location.child.state = "completed";
      location.child.endedAt = occurredAt;
    }
    location.child.updatedAt = occurredAt;
    this.#refreshRun(location.run, occurredAt);
    if (!emit) return {
      emissions: [],
      lineages: [{ childThreadId: rawThreadId, parentThreadId: sourceThreadId }]
    };
    if (phase === "completed") {
      this.#activity(location.run, activityKind(kind), location.run.state, `Delegated activity ${String(kind)}.`, occurredAt);
    }
    return {
      emissions: this.#snapshot(location.run, this.#assignmentEntries(location.run)),
      lineages: [{ childThreadId: rawThreadId, parentThreadId: sourceThreadId }]
    };
  }

  #observeAgentMessage(
    location: ChildLocation,
    item: JsonObject,
    phase: "started" | "completed",
    occurredAt: number,
    emit: boolean
  ): CodexNativeTaskEffects {
    const itemId = nativeIdentity(item["id"]);
    if (itemId === undefined) return emptyEffects();
    const key = pendingMessageKey(location.child.rawThreadId, itemId);
    if (phase === "started") {
      this.#pendingMessage(key);
      return emptyEffects();
    }
    const pending = this.#pendingMessages.get(key);
    this.#pendingMessages.delete(key);
    const nativeText = boundedText(item["text"], MAXIMUM_TEXT_CHARACTERS, true);
    const text = nativeText ?? (pending === undefined ? undefined : boundedWithMarker(pending));
    if (text === undefined || text.length === 0) return emptyEffects();
    location.child.result = text;
    location.child.resultTruncated = nativeText === undefined && pending?.truncated === true;
    location.child.updatedAt = occurredAt;
    location.run.summary = boundedText(text, MAXIMUM_SUMMARY_CHARACTERS, true);
    this.#refreshRun(location.run, occurredAt);
    if (!emit) return emptyEffects();
    this.#activity(location.run, "message", location.run.state, location.run.summary, occurredAt);
    const entry = this.#transcript(location.run, {
      role: "subagent",
      childId: location.child.id,
      childTitle: location.child.title,
      content: text,
      occurredAt
    });
    return { emissions: this.#snapshot(location.run, [entry]), lineages: [] };
  }

  #run(rawCallId: string, parentThreadId: string, item: JsonObject, occurredAt: number): RunRecord {
    const existing = this.#runs.get(rawCallId);
    if (existing !== undefined) {
      if (existing.parentThreadId !== parentThreadId) {
        throw new Error("A Codex delegated run was claimed by conflicting parent threads.");
      }
      this.#mergeRun(existing, item, occurredAt);
      return existing;
    }
    if (this.#runs.size >= MAXIMUM_RUNS) throw new Error("The Codex delegated-run count exceeded its safe limit.");
    const id = opaqueId("codex-run", rawCallId);
    const parent = this.#children.get(parentThreadId);
    const run: RunRecord = {
      rawCallId,
      id,
      parentThreadId,
      children: new Map(),
      activity: [],
      identityAliases: [id],
      ...(parent === undefined ? {} : {
        parentRunId: parent.run.id,
        parentTaskId: parent.run.id
      }),
      parentToolCallId: opaqueId("codex-tool", rawCallId),
      title: "Delegated work",
      state: "queued",
      activitySequence: 0,
      transcriptSequence: 0,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      assignmentEmitted: false
    };
    this.#runs.set(rawCallId, run);
    this.#mergeRun(run, item, occurredAt);
    this.#activity(run, "started", "queued", run.assignment ?? run.title, occurredAt);
    return run;
  }

  #implicitRun(rawThreadId: string, parentThreadId: string, occurredAt: number): ChildLocation | undefined {
    if (rawThreadId === this.#rootThreadId || rawThreadId === parentThreadId) return undefined;
    const rawCallId = `thread:${rawThreadId}`;
    const run = this.#run(rawCallId, parentThreadId, {}, occurredAt);
    run.title = "Delegated agent";
    const child = this.#child(run, rawThreadId, occurredAt);
    this.#refreshRun(run, occurredAt);
    return { run, child };
  }

  #mergeRun(run: RunRecord, item: JsonObject, occurredAt: number): void {
    const assignment = boundedText(item["prompt"], MAXIMUM_TEXT_CHARACTERS, true);
    const modelId = boundedText(item["model"], 256);
    const thinkingLevel = boundedText(item["reasoningEffort"], 64);
    if (assignment !== undefined) {
      run.assignment = assignment;
      const oneLine = assignment.replace(/\s+/gu, " ").trim();
      if (oneLine.length > 0) run.title = oneLine.slice(0, 160);
    }
    if (modelId !== undefined) run.modelId = modelId;
    if (thinkingLevel !== undefined) run.thinkingLevel = thinkingLevel;
    run.updatedAt = Math.max(run.updatedAt, occurredAt);
  }

  #child(run: RunRecord, rawThreadId: string, occurredAt: number): ChildRecord {
    const existing = run.children.get(rawThreadId);
    if (existing !== undefined) return existing;
    const globallyOwned = this.#children.get(rawThreadId);
    if (globallyOwned !== undefined) {
      if (globallyOwned.run !== run) throw new Error("A Codex child thread was claimed by conflicting delegated runs.");
      return globallyOwned.child;
    }
    if (this.#children.size >= MAXIMUM_CHILDREN) throw new Error("The Codex delegated-child count exceeded its safe limit.");
    const id = opaqueId("codex-child", rawThreadId);
    const child: ChildRecord = {
      rawThreadId,
      id,
      identityAliases: [id],
      state: "running",
      role: "agent",
      title: run.title,
      ...(run.modelId === undefined && this.#fallbackModelId === undefined ? {} : { modelId: run.modelId ?? this.#fallbackModelId }),
      ...(run.thinkingLevel === undefined && this.#fallbackThinkingLevel === undefined
        ? {}
        : { thinkingLevel: run.thinkingLevel ?? this.#fallbackThinkingLevel }),
      resultTruncated: false,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      toolUses: 0
    };
    run.children.set(rawThreadId, child);
    if (!run.identityAliases.includes(id)) run.identityAliases.push(id);
    this.#children.set(rawThreadId, { run, child });
    return child;
  }

  #applyNativeState(location: ChildLocation, value: JsonValue | undefined, occurredAt: number): void {
    if (!isJsonObject(value)) return;
    const next = nativeState(value["status"]);
    const message = boundedText(value["message"], MAXIMUM_TEXT_CHARACTERS, true);
    if (location.run.terminalLatch !== undefined) {
      location.child.state = location.run.terminalLatch;
      location.child.activeTurnId = undefined;
      location.child.endedAt = location.run.endedAt ?? occurredAt;
      location.child.error = location.run.terminalLatch === "failed"
        ? location.run.error ?? childFailure(message)
        : undefined;
    } else if (next !== undefined) {
      location.child.state = next;
      if (activeState(next)) {
        location.child.endedAt = undefined;
        location.child.error = undefined;
      } else {
        location.child.activeTurnId = undefined;
        location.child.endedAt = occurredAt;
        location.child.error = next === "failed" ? childFailure(message) : undefined;
      }
    }
    if (message !== undefined) {
      location.child.result = message;
      location.child.resultTruncated = false;
      location.run.summary = boundedText(message, MAXIMUM_SUMMARY_CHARACTERS, true);
    }
    location.child.updatedAt = occurredAt;
  }

  #refreshRun(run: RunRecord, occurredAt: number): void {
    if (run.terminalLatch !== undefined) {
      const previous = run.state;
      run.state = run.terminalLatch;
      run.updatedAt = Math.max(run.updatedAt, occurredAt);
      run.endedAt ??= occurredAt;
      run.error = run.terminalLatch === "failed" ? run.error ?? childFailure(undefined) : undefined;
      for (const child of run.children.values()) {
        child.state = run.terminalLatch;
        child.activeTurnId = undefined;
        child.updatedAt = Math.max(child.updatedAt, occurredAt);
        child.endedAt ??= run.endedAt;
        child.error = run.terminalLatch === "failed" ? child.error ?? run.error : undefined;
      }
      if (previous !== run.state) {
        this.#activity(run, stateActivityKind(run.state), run.state, run.summary, occurredAt);
      }
      return;
    }
    const states = [...run.children.values()].map((child) => child.state);
    const previous = run.state;
    run.state = aggregateState(states, run.state);
    run.updatedAt = Math.max(run.updatedAt, occurredAt);
    if (activeState(run.state)) {
      run.endedAt = undefined;
      run.error = undefined;
    } else {
      run.endedAt = Math.max(...[...run.children.values()].map((child) => child.endedAt ?? child.updatedAt), occurredAt);
      run.error = run.state === "failed"
        ? [...run.children.values()].find((child) => child.error !== undefined)?.error ?? childFailure(undefined)
        : undefined;
    }
    if (previous !== run.state) {
      this.#activity(run, stateActivityKind(run.state), run.state, run.summary, occurredAt);
    }
  }

  #latchRun(run: RunRecord, state: "failed" | "stopped", occurredAt: number): void {
    if (run.terminalLatch !== undefined) return;
    run.terminalLatch = state;
    run.state = state;
    run.updatedAt = Math.max(run.updatedAt, occurredAt);
    run.endedAt = occurredAt;
    run.error = state === "failed" ? childFailure(undefined) : undefined;
    for (const child of run.children.values()) {
      child.state = state;
      child.activeTurnId = undefined;
      child.updatedAt = Math.max(child.updatedAt, occurredAt);
      child.endedAt = occurredAt;
      child.error = state === "failed" ? run.error : undefined;
      this.#clearPendingMessagesForThread(child.rawThreadId);
    }
  }

  #assertLineageTargets(rawCallId: string, parentThreadId: string, childThreadIds: readonly string[]): void {
    for (const childThreadId of childThreadIds) {
      if (childThreadId === this.#rootThreadId || childThreadId === parentThreadId) {
        throw new Error("A Codex delegated lineage targeted its root or parent thread.");
      }
      const owned = this.#children.get(childThreadId);
      if (owned !== undefined && owned.run.rawCallId !== rawCallId) {
        throw new Error("A Codex child thread was claimed by conflicting delegated runs.");
      }
    }
  }

  #assignmentEntries(run: RunRecord): readonly SubagentTranscriptEntry[] {
    if (run.assignmentEmitted) return [];
    run.assignmentEmitted = true;
    const firstChild = run.children.values().next().value as ChildRecord | undefined;
    return [this.#transcript(run, {
      role: "parent",
      content: run.assignment ?? run.title,
      occurredAt: run.startedAt,
      ...(firstChild === undefined ? {} : { childId: firstChild.id, childTitle: firstChild.title })
    })];
  }

  #snapshot(run: RunRecord, transcript: readonly SubagentTranscriptEntry[]): ProjectedTaskPayload[] {
    const backgroundState = run.state === "queued"
      ? "queued"
      : run.state === "running"
        ? "running"
        : run.state === "completed"
          ? "completed"
          : run.state === "failed"
            ? "failed"
            : "aborted";
    const emissions: ProjectedTaskPayload[] = [{
      type: "background_task",
      taskId: run.id,
      ...(run.parentTaskId === undefined ? {} : { parentTaskId: run.parentTaskId }),
      title: run.title,
      state: backgroundState,
      ...(run.summary === undefined ? {} : { detail: run.summary }),
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.error === undefined ? {} : { error: run.error })
    }, {
      type: "subagent_run",
      run: this.#publicRun(run)
    }];
    for (const entry of transcript) emissions.push({ type: "subagent_transcript", subagentRunId: run.id, entry });
    return emissions;
  }

  #publicRun(run: RunRecord): SubagentRunDetail {
    const children: SubagentChildRun[] = [...run.children.values()].map((child) => ({
      id: child.id,
      identityAliases: [...child.identityAliases],
      role: child.role,
      title: child.title,
      ...(run.assignment === undefined ? {} : { assignment: run.assignment }),
      state: child.state,
      route: {
        providerId: this.#providerId,
        ...(child.modelId === undefined ? {} : { modelId: child.modelId }),
        ...(child.thinkingLevel === undefined ? {} : { thinkingLevel: child.thinkingLevel })
      },
      ...(child.usage === undefined ? {} : { usage: child.usage }),
      ...(child.result === undefined ? {} : {
        result: child.result,
        ...(child.resultTruncated ? { resultTruncated: true } : {})
      }),
      ...(child.error === undefined ? {} : { error: child.error }),
      startedAt: child.startedAt,
      ...(child.endedAt === undefined ? {} : { endedAt: child.endedAt })
    }));
    const usage = aggregateUsage(children.map((child) => child.usage));
    const returned = returnedResult(children);
    return {
      id: run.id,
      sessionId: this.#sessionId,
      ...(run.parentRunId === undefined ? {} : { parentSubagentRunId: run.parentRunId }),
      ...(run.parentTaskId === undefined ? {} : { parentTaskId: run.parentTaskId }),
      ...(run.parentToolCallId === undefined ? {} : { parentToolCallId: run.parentToolCallId }),
      logicalAgentId: run.id,
      identityAliases: [...run.identityAliases],
      providerRunIds: children.map((child) => `codex-native:${child.id}`),
      state: run.state,
      title: run.title,
      ...(run.assignment === undefined ? {} : { description: run.assignment, assignment: run.assignment }),
      ...(run.summary === undefined ? {} : { summary: run.summary }),
      route: {
        providerId: this.#providerId,
        ...(run.modelId === undefined && this.#fallbackModelId === undefined ? {} : { modelId: run.modelId ?? this.#fallbackModelId }),
        ...(run.thinkingLevel === undefined && this.#fallbackThinkingLevel === undefined
          ? {}
          : { thinkingLevel: run.thinkingLevel ?? this.#fallbackThinkingLevel })
      },
      ...(usage === undefined ? {} : { usage }),
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: false,
        steer: false,
        followUp: false,
        resume: false,
        parentContext: "live"
      },
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.error === undefined ? {} : { error: run.error }),
      activity: [...run.activity],
      children,
      ...(returned === undefined ? {} : {
        returnedResult: returned.value,
        ...(returned.truncated ? { returnedResultTruncated: true } : {})
      })
    };
  }

  #activity(
    run: RunRecord,
    kind: SubagentActivityEntry["kind"],
    state: SubagentRunState,
    summary: string | undefined,
    occurredAt: number,
    lastToolName?: string
  ): void {
    run.activity.push({
      sequence: ++run.activitySequence,
      kind,
      state,
      ...(summary === undefined ? {} : { summary: boundedText(summary, MAXIMUM_SUMMARY_CHARACTERS, true) ?? summary }),
      ...(lastToolName === undefined ? {} : { lastToolName }),
      occurredAt
    });
    if (run.activity.length > MAXIMUM_ACTIVITY_ENTRIES) {
      run.activity.splice(0, run.activity.length - MAXIMUM_ACTIVITY_ENTRIES);
    }
  }

  #transcript(
    run: RunRecord,
    value: Omit<SubagentTranscriptEntry, "id" | "sequence">
  ): SubagentTranscriptEntry {
    const sequence = ++run.transcriptSequence;
    return { id: `${run.id}:entry:${sequence}`, sequence, ...value };
  }

  #pendingMessage(key: string): PendingMessage {
    const existing = this.#pendingMessages.get(key);
    if (existing !== undefined) return existing;
    if (this.#pendingMessages.size >= MAXIMUM_PENDING_MESSAGES) {
      throw new Error("The Codex pending delegated-message count exceeded its safe limit.");
    }
    const pending: PendingMessage = { value: "", truncated: false, reportedLength: 0 };
    this.#pendingMessages.set(key, pending);
    return pending;
  }

  #clearPendingMessagesForThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of this.#pendingMessages.keys()) {
      if (key.startsWith(prefix)) this.#pendingMessages.delete(key);
    }
  }
}

function emptyEffects(): CodexNativeTaskEffects {
  return { emissions: [], lineages: [] };
}

function nativeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAXIMUM_IDENTIFIER_CHARACTERS
    || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function nativeIdentityArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAXIMUM_CHILDREN) {
    throw new Error("The Codex delegated-child set exceeded its safe limit.");
  }
  const result: string[] = [];
  for (const item of value) {
    const identity = nativeIdentity(item);
    if (identity === undefined) throw new Error("A Codex delegated-child identity was invalid.");
    if (!result.includes(identity)) result.push(identity);
  }
  return result;
}

function nativeIdentityKeys(value: JsonObject): string[] {
  const keys = Object.keys(value);
  if (keys.length > MAXIMUM_CHILDREN) {
    throw new Error("The Codex delegated-child state set exceeded its safe limit.");
  }
  for (const key of keys) {
    if (nativeIdentity(key) === undefined) throw new Error("A Codex delegated-child identity was invalid.");
  }
  return keys;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = safeText(value, maximum).slice(0, maximum);
  if (!allowEmpty && bounded.trim().length === 0) return undefined;
  return bounded;
}

function opaqueId(namespace: string, value: string): string {
  return `${namespace}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function protocolTime(params: JsonObject, fallback: number): number {
  for (const key of ["completedAtMs", "startedAtMs", "updatedAtMs"] as const) {
    const value = params[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return fallback;
}

function pendingMessageKey(threadId: string, itemId: string): string {
  return `${threadId}\u0000${itemId}`;
}

function appendBounded(pending: PendingMessage, fragment: string): void {
  if (pending.truncated) return;
  const remaining = MAXIMUM_TEXT_CHARACTERS - pending.value.length;
  if (fragment.length <= remaining) {
    pending.value += fragment;
    return;
  }
  pending.value += fragment.slice(0, Math.max(0, remaining));
  pending.truncated = true;
}

function boundedWithMarker(pending: PendingMessage): string {
  if (!pending.truncated) return pending.value;
  return `${pending.value.slice(0, Math.max(0, MAXIMUM_TEXT_CHARACTERS - 12))}\n[Truncated]`;
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function mergeToolUses(usage: SubagentUsage | undefined, toolUses: number): SubagentUsage {
  return { ...(usage ?? {}), toolUses };
}

function toolDescriptor(item: JsonObject): { readonly name: string; readonly failed: boolean } | undefined {
  switch (item["type"]) {
    case "commandExecution":
      return { name: "command", failed: item["status"] === "failed" || numberValue(item["exitCode"]) > 0 };
    case "fileChange":
      return { name: "file_change", failed: item["status"] === "failed" };
    case "mcpToolCall": {
      const server = boundedText(item["server"], 96) ?? "mcp";
      const tool = boundedText(item["tool"], 96) ?? "tool";
      return { name: `${server}/${tool}`, failed: item["status"] === "failed" };
    }
    case "dynamicToolCall": {
      const tool = boundedText(item["tool"], 128) ?? "tool";
      return { name: tool, failed: item["success"] === false || item["status"] === "failed" };
    }
    case "webSearch":
      return { name: "web_search", failed: item["status"] === "failed" };
    case "imageView":
      return { name: "view_image", failed: item["status"] === "failed" };
    default:
      return undefined;
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nativeState(value: unknown): SubagentRunState | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "pendinginit" || normalized === "pending") return "queued";
  if (normalized === "running" || normalized === "inprogress" || normalized === "in_progress"
    || normalized === "in-progress" || normalized === "started" || normalized === "active") return "running";
  if (normalized === "completed" || normalized === "complete" || normalized === "succeeded"
    || normalized === "done") return "completed";
  if (normalized === "errored" || normalized === "notfound" || normalized === "failed"
    || normalized === "error") return "failed";
  if (normalized === "interrupted" || normalized === "shutdown" || normalized === "stopped"
    || normalized === "cancelled") return "stopped";
  return undefined;
}

function spawnTerminalState(value: unknown): "failed" | "stopped" | undefined {
  const state = nativeState(value);
  return state === "failed" || state === "stopped" ? state : undefined;
}

function aggregateState(states: readonly SubagentRunState[], fallback: SubagentRunState): SubagentRunState {
  if (states.length === 0) return fallback;
  if (states.some((state) => state === "running")) return "running";
  if (states.some((state) => state === "queued")) return "queued";
  if (states.some((state) => state === "failed")) return "failed";
  if (states.every((state) => state === "completed")) return "completed";
  if (states.some((state) => state === "stopped")) return "stopped";
  return fallback;
}

function activeState(state: SubagentRunState): boolean {
  return state === "queued" || state === "running";
}

function activityKind(value: unknown): SubagentActivityEntry["kind"] {
  if (value === "started") return "started";
  if (value === "completed") return "completed";
  if (value === "interrupted") return "stopped";
  return "progress";
}

function stateActivityKind(state: SubagentRunState): SubagentActivityEntry["kind"] {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "stopped") return "stopped";
  return "progress";
}

function childFailure(value: unknown): PublicError {
  const record = isJsonObject(value) ? value : undefined;
  const message = boundedText(record?.["message"] ?? value, 2_048, true);
  return {
    code: "CODEX_SUBAGENT_FAILED",
    message: message === undefined || message.trim().length === 0 ? "The native delegated run failed." : message,
    phase: "stream",
    retryable: true,
    stateMayHaveChanged: true,
    recovery: "Inspect the delegated transcript before starting a new run."
  };
}

function runtimeLostError(): PublicError {
  return {
    code: "CODEX_SUBAGENT_RUNTIME_LOST",
    message: "The native delegated run lost its owning runtime.",
    phase: "stream",
    retryable: true,
    stateMayHaveChanged: true,
    recovery: "Resume the parent native thread and inspect its delegated work."
  };
}

function aggregateUsage(values: readonly (SubagentUsage | undefined)[]): SubagentUsage | undefined {
  const present = values.filter((value): value is SubagentUsage => value !== undefined);
  if (present.length === 0) return undefined;
  return {
    inputTokens: sumOptional(present, "inputTokens"),
    outputTokens: sumOptional(present, "outputTokens"),
    cacheReadTokens: sumOptional(present, "cacheReadTokens"),
    cacheWriteTokens: sumOptional(present, "cacheWriteTokens"),
    totalTokens: sumOptional(present, "totalTokens"),
    toolUses: sumOptional(present, "toolUses"),
    durationMs: maximumOptional(present, "durationMs"),
    costUsd: sumOptional(present, "costUsd")
  };
}

function sumOptional(values: readonly SubagentUsage[], key: keyof SubagentUsage): number | undefined {
  const numbers = values.flatMap((value) => typeof value[key] === "number" ? [value[key] as number] : []);
  return numbers.length === 0 ? undefined : numbers.reduce((sum, value) => sum + value, 0);
}

function maximumOptional(values: readonly SubagentUsage[], key: keyof SubagentUsage): number | undefined {
  const numbers = values.flatMap((value) => typeof value[key] === "number" ? [value[key] as number] : []);
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

function returnedResult(children: readonly SubagentChildRun[]): { readonly value: string; readonly truncated: boolean } | undefined {
  const fragments = children.flatMap((child) => child.result === undefined
    ? []
    : [children.length === 1 ? child.result : `${child.title ?? child.role}:\n${child.result}`]);
  if (fragments.length === 0) return undefined;
  const combined = fragments.join("\n\n");
  const truncated = combined.length > MAXIMUM_TEXT_CHARACTERS || children.some((child) => child.resultTruncated === true);
  return {
    value: combined.length <= MAXIMUM_TEXT_CHARACTERS
      ? combined
      : `${combined.slice(0, MAXIMUM_TEXT_CHARACTERS - 12)}\n[Truncated]`,
    truncated
  };
}

function uniqueLineages(values: readonly CodexNativeTaskLineage[]): CodexNativeTaskLineage[] {
  const seen = new Set<string>();
  const result: CodexNativeTaskLineage[] = [];
  for (const value of values) {
    const key = `${value.parentThreadId}\u0000${value.childThreadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
