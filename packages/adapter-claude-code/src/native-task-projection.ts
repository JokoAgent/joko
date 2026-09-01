import { createHash } from "node:crypto";
import type {
  AdapterContext,
  EventPayload,
  PublicError,
  SubagentActivityEntry,
  SubagentRunDetail,
  SubagentRunState,
  SubagentTranscriptEntry,
  SubagentUsage
} from "@joko/core";
import { ProjectionLimitError, SafeProjection, finite, record, stringValue } from "./projection.js";

const MAX_TASKS = 2_048;
const MAX_PENDING_CHILD_FRAMES = 512;
const MAX_ACTIVITY_ENTRIES = 512;
const MAX_SEEN_FRAMES = 16_384;
const MAX_TOOL_SCOPES = 16_384;
const MAX_TASK_TOOL_ENTRIES = 4_096;
const MAX_RESULT_CHARACTERS = 64 * 1024;
const NATIVE_AGENT_TASK_TYPES = new Set(["local_agent", "remote_agent"]);
const NATIVE_NON_AGENT_TASK_TYPES = new Set(["local_bash", "local_workflow"]);
const NATIVE_WAKE_TASK_TYPES = new Set(["local_agent", "local_workflow"]);
const NATIVE_AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

type NativeTaskPayload = Extract<EventPayload, {
  type: "background_task" | "subagent_run" | "subagent_transcript";
}>;

export interface NativeTaskEmission {
  readonly context: AdapterContext;
  readonly payload: NativeTaskPayload;
}

type PendingChildFrame =
  | { readonly kind: "assistant"; readonly envelope: Readonly<Record<string, unknown>>; readonly occurredAt: number }
  | { readonly kind: "user"; readonly envelope: Readonly<Record<string, unknown>>; readonly occurredAt: number }
  | { readonly kind: "tool_progress"; readonly envelope: Readonly<Record<string, unknown>>; readonly occurredAt: number };

interface ToolScope {
  readonly context: AdapterContext;
  readonly parentTaskId?: string;
  readonly agentCandidate: boolean;
}

interface NativeTaskRecord {
  readonly rawId: string;
  readonly id: string;
  context: AdapterContext;
  readonly activity: SubagentActivityEntry[];
  readonly identityAliases: string[];
  readonly seenFrames: Set<string>;
  readonly toolNames: Map<string, string>;
  readonly lastToolProgressSecond: Map<string, number>;
  state: SubagentRunState;
  backgroundState: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted";
  activitySequence: number;
  transcriptSequence: number;
  taskType?: string;
  subagentType?: string;
  toolUseId?: string;
  parentTaskId?: string;
  title: string;
  assignment?: string;
  summary?: string;
  modelId?: string;
  usage?: SubagentUsage;
  lastToolName?: string;
  returnedResult?: string;
  returnedResultTruncated: boolean;
  wake: boolean;
  isSubagent: boolean;
  excludedFromSubagents: boolean;
  skipTranscript: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: PublicError;
}

export class ClaudeNativeTaskProjection {
  readonly #sessionId: string;
  readonly #projection: SafeProjection;
  readonly #now: () => number;
  readonly #tasks = new Map<string, NativeTaskRecord>();
  readonly #publicTaskIds = new Map<string, NativeTaskRecord>();
  readonly #taskByToolUseId = new Map<string, string>();
  readonly #toolScopes = new Map<string, ToolScope>();
  readonly #pendingChildren = new Map<string, PendingChildFrame[]>();
  readonly #seenSystemFrames = new Set<string>();
  #pendingChildFrameCount = 0;

  constructor(options: {
    readonly sessionId: string;
    readonly projection: SafeProjection;
    readonly now?: () => number;
  }) {
    this.#sessionId = options.sessionId;
    this.#projection = options.projection;
    this.#now = options.now ?? Date.now;
  }

  bindToolScope(
    context: AdapterContext,
    callId: string,
    name: string,
    parentTaskId?: string
  ): readonly NativeTaskEmission[] {
    const rawCallId = validNativeIdentity(callId);
    if (rawCallId === undefined) return [];
    const scope: ToolScope = {
      context,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      agentCandidate: NATIVE_AGENT_TOOL_NAMES.has(name)
    };
    if (!this.#toolScopes.has(rawCallId) && this.#toolScopes.size >= MAX_TOOL_SCOPES) {
      throw new ProjectionLimitError("The native tool-scope count exceeded its limit.");
    }
    this.#toolScopes.set(rawCallId, scope);
    const rawTaskId = this.#taskByToolUseId.get(rawCallId);
    if (rawTaskId === undefined) return [];
    const task = this.#tasks.get(rawTaskId);
    if (task === undefined) return [];
    task.context = context;
    if (parentTaskId !== undefined) task.parentTaskId = parentTaskId;
    if (scope.agentCandidate && !task.excludedFromSubagents) task.isSubagent = true;
    this.#toolScopes.delete(rawCallId);
    return this.#snapshot(task, this.#assignmentEntries(task));
  }

  completeToolScope(callId: string): void {
    const rawCallId = validNativeIdentity(callId);
    if (rawCallId === undefined) return;
    const scope = this.#toolScopes.get(rawCallId);
    if (scope?.agentCandidate === true && !this.#taskByToolUseId.has(rawCallId)) return;
    this.#toolScopes.delete(rawCallId);
  }

  observeSystem(
    envelope: Readonly<Record<string, unknown>>,
    fallbackContext: AdapterContext
  ): readonly NativeTaskEmission[] {
    const subtype = stringValue(envelope["subtype"]);
    if (!isNativeTaskSystemSubtype(subtype)) return [];
    if (this.#duplicateSystemFrame(envelope)) return [];
    if (subtype === "background_tasks_changed") {
      return this.#observeBackgroundSet(envelope, fallbackContext);
    }
    const rawTaskId = validNativeIdentity(envelope["task_id"]);
    if (rawTaskId === undefined) return [];
    const rawToolUseId = validNativeIdentity(envelope["tool_use_id"]);
    const scope = rawToolUseId === undefined ? undefined : this.#toolScopes.get(rawToolUseId);
    const task = this.#task(rawTaskId, scope?.context ?? fallbackContext, envelope);
    if (rawToolUseId !== undefined) {
      this.#bindTaskTool(task, rawToolUseId, scope);
      this.#toolScopes.delete(rawToolUseId);
    }
    if (subtype === "task_started") return this.#observeStarted(task, envelope);
    if (subtype === "task_progress") return this.#observeProgress(task, envelope);
    if (subtype === "task_notification") return this.#observeNotification(task, envelope);
    return this.#observeUpdated(task, envelope);
  }

  observeChildAssistant(envelope: Readonly<Record<string, unknown>>): readonly NativeTaskEmission[] {
    return this.#observeChild({ kind: "assistant", envelope, occurredAt: this.#now() });
  }

  observeChildUser(envelope: Readonly<Record<string, unknown>>): readonly NativeTaskEmission[] {
    return this.#observeChild({ kind: "user", envelope, occurredAt: this.#now() });
  }

  observeChildToolProgress(envelope: Readonly<Record<string, unknown>>): readonly NativeTaskEmission[] {
    return this.#observeChild({ kind: "tool_progress", envelope, occurredAt: this.#now() });
  }

  activeWakeTaskIds(): readonly string[] {
    return [...this.#tasks.values()]
      .filter((task) => task.wake && activeState(task.state))
      .map((task) => task.rawId);
  }

  taskState(rawTaskId: string): SubagentRunState | undefined {
    return this.#tasks.get(rawTaskId)?.state;
  }

  confirmStopped(rawTaskId: string): readonly NativeTaskEmission[] {
    const task = this.#tasks.get(rawTaskId);
    if (task === undefined || !activeState(task.state)) return [];
    const occurredAt = this.#now();
    task.state = "stopped";
    task.backgroundState = "aborted";
    task.updatedAt = occurredAt;
    task.endedAt = occurredAt;
    task.error = undefined;
    this.#activity(task, "stopped", "stopped", "Stopped by native task control.", occurredAt);
    const transcript = task.skipTranscript || !task.isSubagent || task.excludedFromSubagents
      ? []
      : [this.#transcript(task, {
          role: "system",
          content: "Task stopped.",
          occurredAt,
          systemEvent: { kind: "task_stopped" }
        })];
    return this.#snapshot(task, transcript);
  }

  stopTarget(publicTaskId: string, requireSubagent: boolean): { readonly rawTaskId: string; readonly terminal: boolean } {
    const task = this.#publicTaskIds.get(publicTaskId);
    if (task === undefined || (requireSubagent && (!task.isSubagent || task.excludedFromSubagents))) {
      throw new Error("Native task ownership could not be proven.");
    }
    return { rawTaskId: task.rawId, terminal: !activeState(task.state) };
  }

  childId(publicTaskId: string): string | undefined {
    return this.#publicTaskIds.has(publicTaskId) ? childIdFor(publicTaskId) : undefined;
  }

  terminateActive(
    state: "failed" | "stopped",
    error?: PublicError
  ): readonly NativeTaskEmission[] {
    const emissions: NativeTaskEmission[] = [];
    const occurredAt = this.#now();
    for (const task of this.#tasks.values()) {
      if (!activeState(task.state)) continue;
      task.state = state;
      task.backgroundState = state === "failed" ? "failed" : "aborted";
      task.updatedAt = occurredAt;
      task.endedAt = occurredAt;
      if (state === "failed") {
        task.error = error ?? nativeTaskError("The native task ended when its runtime was lost.");
      } else {
        task.error = undefined;
      }
      this.#activity(task, state, state, state === "failed" ? task.error?.message : "Stopped with the native runtime.", occurredAt);
      const transcript = task.skipTranscript || !task.isSubagent || task.excludedFromSubagents
        ? []
        : [this.#transcript(task, {
            role: "system",
            content: state === "failed" ? task.error?.message ?? "Task failed." : "Task stopped.",
            occurredAt,
            systemEvent: { kind: state === "failed" ? "task_failed" : "task_stopped" },
            isError: state === "failed"
          })];
      emissions.push(...this.#snapshot(task, transcript));
    }
    return emissions;
  }

  #observeStarted(
    task: NativeTaskRecord,
    envelope: Readonly<Record<string, unknown>>
  ): readonly NativeTaskEmission[] {
    if (!activeState(task.state)) return [];
    this.#mergeIdentity(task, envelope);
    task.state = "running";
    task.backgroundState = "running";
    task.updatedAt = this.#now();
    this.#activity(task, "started", "running", task.title, task.updatedAt);
    const emissions = [...this.#snapshot(task, this.#assignmentEntries(task))];
    emissions.push(...this.#drainPendingChildren(task));
    return emissions;
  }

  #observeProgress(
    task: NativeTaskRecord,
    envelope: Readonly<Record<string, unknown>>
  ): readonly NativeTaskEmission[] {
    if (!activeState(task.state)) return [];
    this.#mergeIdentity(task, envelope);
    task.state = "running";
    task.backgroundState = "running";
    task.updatedAt = this.#now();
    task.usage = taskUsage(envelope["usage"]);
    task.lastToolName = optionalProjected(this.#projection, envelope["last_tool_name"], 256) ?? task.lastToolName;
    task.summary = optionalProjected(this.#projection, envelope["summary"], 4_096) ?? task.summary;
    this.#activity(task, "progress", "running", task.summary, task.updatedAt, task.lastToolName);
    const emissions = [...this.#snapshot(task, this.#assignmentEntries(task))];
    emissions.push(...this.#drainPendingChildren(task));
    return emissions;
  }

  #observeNotification(
    task: NativeTaskRecord,
    envelope: Readonly<Record<string, unknown>>
  ): readonly NativeTaskEmission[] {
    if (!activeState(task.state)) return [];
    this.#mergeIdentity(task, envelope);
    const status = stringValue(envelope["status"]);
    if (status !== "completed" && status !== "failed" && status !== "stopped") return [];
    task.state = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "completed";
    task.backgroundState = task.state === "failed" ? "failed" : task.state === "stopped" ? "aborted" : "completed";
    task.updatedAt = this.#now();
    task.endedAt = task.updatedAt;
    task.usage = taskUsage(envelope["usage"]) ?? task.usage;
    task.summary = optionalProjected(this.#projection, envelope["summary"], 64 * 1024) ?? task.summary;
    if (task.returnedResult === undefined && task.summary !== undefined) task.returnedResult = task.summary;
    task.error = task.state === "failed"
      ? nativeTaskError(task.summary ?? "The native task failed.")
      : undefined;
    this.#activity(task, task.state, task.state, task.summary, task.updatedAt, task.lastToolName);
    const transcript = task.skipTranscript || !task.isSubagent || task.excludedFromSubagents
      ? []
      : [this.#transcript(task, {
          role: "system",
          content: task.summary ?? (task.state === "completed" ? "Task completed." : task.state === "failed" ? "Task failed." : "Task stopped."),
          occurredAt: task.updatedAt,
          systemEvent: { kind: `task_${task.state}` },
          isError: task.state === "failed"
        })];
    const emissions = [...this.#snapshot(task, transcript)];
    emissions.push(...this.#drainPendingChildren(task));
    return emissions;
  }

  #observeUpdated(
    task: NativeTaskRecord,
    envelope: Readonly<Record<string, unknown>>
  ): readonly NativeTaskEmission[] {
    const patch = record(envelope["patch"]);
    if (patch === undefined) return [];
    if (!activeState(task.state)) return [];
    const rawStatus = stringValue(patch["status"]);
    const next = updatedState(rawStatus, stringValue(patch["error"]));
    task.title = optionalProjected(this.#projection, patch["description"], 512) ?? task.title;
    task.updatedAt = this.#now();
    if (next !== undefined) {
      task.state = next.state;
      task.backgroundState = next.backgroundState;
      if (!activeState(task.state)) task.endedAt = task.updatedAt;
    }
    const failure = optionalProjected(this.#projection, patch["error"], 4_096);
    if (failure !== undefined) {
      task.state = "failed";
      task.backgroundState = "failed";
      task.endedAt = task.updatedAt;
      task.error = nativeTaskError(failure);
      task.summary = failure;
    } else if (task.state !== "failed") {
      task.error = undefined;
    }
    const kind = task.state === "queued" || task.state === "running" ? "progress" : task.state;
    this.#activity(task, kind, task.state, task.summary, task.updatedAt, task.lastToolName);
    return this.#snapshot(task, this.#assignmentEntries(task));
  }

  #observeBackgroundSet(
    envelope: Readonly<Record<string, unknown>>,
    fallbackContext: AdapterContext
  ): readonly NativeTaskEmission[] {
    const rawTasks = envelope["tasks"];
    if (!Array.isArray(rawTasks)) return [];
    if (rawTasks.length > MAX_TASKS) throw new ProjectionLimitError("The native background-task set exceeded its limit.");
    const emissions: NativeTaskEmission[] = [];
    for (const raw of rawTasks) {
      const item = record(raw);
      const rawTaskId = validNativeIdentity(item?.["task_id"]);
      if (item === undefined || rawTaskId === undefined) continue;
      const task = this.#task(rawTaskId, fallbackContext, {
        task_type: item["task_type"],
        description: item["description"]
      });
      if (!activeState(task.state)) continue;
      task.state = "running";
      task.backgroundState = "running";
      task.updatedAt = this.#now();
      emissions.push(...this.#snapshot(task, this.#assignmentEntries(task)));
      emissions.push(...this.#drainPendingChildren(task));
    }
    return emissions;
  }

  #observeChild(frame: PendingChildFrame): readonly NativeTaskEmission[] {
    const parentToolUseId = validNativeIdentity(frame.envelope["parent_tool_use_id"]);
    if (parentToolUseId === undefined) return [];
    const rawTaskId = this.#taskByToolUseId.get(parentToolUseId);
    const task = rawTaskId === undefined ? undefined : this.#tasks.get(rawTaskId);
    if (task === undefined) {
      this.#retainPendingChild(parentToolUseId, frame);
      return [];
    }
    return this.#projectChild(task, frame);
  }

  #projectChild(task: NativeTaskRecord, frame: PendingChildFrame): readonly NativeTaskEmission[] {
    if (!activeState(task.state)) return [];
    if (task.skipTranscript || task.excludedFromSubagents) return [];
    task.isSubagent = true;
    if (this.#duplicateTaskFrame(task, frame.envelope)) return [];
    if (frame.kind === "assistant") return this.#projectChildAssistant(task, frame);
    if (frame.kind === "user") return this.#projectChildUser(task, frame);
    return this.#projectChildToolProgress(task, frame);
  }

  #projectChildAssistant(
    task: NativeTaskRecord,
    frame: Extract<PendingChildFrame, { kind: "assistant" }>
  ): readonly NativeTaskEmission[] {
    const projected = this.#projection.assistant(frame.envelope);
    const nativeMessage = record(frame.envelope["message"]);
    const modelId = optionalProjected(this.#projection, nativeMessage?.["model"], 512);
    if (modelId !== undefined) task.modelId = modelId;
    const transcript: SubagentTranscriptEntry[] = [];
    const nestedEmissions: NativeTaskEmission[] = [];
    let observedMessage = false;
    let observedTool = false;
    for (const block of projected.blocks) {
      if (block.kind === "text") {
        if (block.text.length === 0) continue;
        observedMessage = true;
        this.#appendReturnedResult(task, block.text);
        transcript.push(this.#transcript(task, {
          role: "subagent",
          content: block.text,
          occurredAt: frame.occurredAt,
          childId: childIdFor(task.id),
          childTitle: task.title
        }));
      } else if (block.kind === "tool_call") {
        observedTool = true;
        if (!task.toolNames.has(block.callId) && task.toolNames.size >= MAX_TASK_TOOL_ENTRIES) {
          throw new ProjectionLimitError("The native child tool count exceeded its limit.");
        }
        task.toolNames.set(block.callId, block.name);
        transcript.push(this.#transcript(task, {
          role: "tool",
          content: `${block.name} started.`,
          occurredAt: frame.occurredAt,
          childId: childIdFor(task.id),
          childTitle: task.title,
          toolName: block.name,
          toolCallId: block.callId,
          toolPhase: "start",
          toolInputJson: block.input
        }));
        nestedEmissions.push(...this.bindToolScope(task.context, block.callId, block.name, task.rawId));
      }
    }
    task.updatedAt = frame.occurredAt;
    if (observedMessage) this.#activity(task, "message", task.state, undefined, frame.occurredAt);
    else if (observedTool) this.#activity(task, "progress", task.state, undefined, frame.occurredAt);
    return [...this.#snapshot(task, transcript), ...nestedEmissions];
  }

  #projectChildUser(
    task: NativeTaskRecord,
    frame: Extract<PendingChildFrame, { kind: "user" }>
  ): readonly NativeTaskEmission[] {
    const projected = this.#projection.user(frame.envelope);
    const transcript = projected.toolResults.map((result) => {
      this.completeToolScope(result.callId);
      const name = task.toolNames.get(result.callId) ?? "Tool";
      return this.#transcript(task, {
        role: "tool",
        content: result.output,
        occurredAt: frame.occurredAt,
        childId: childIdFor(task.id),
        childTitle: task.title,
        toolName: name,
        toolCallId: result.callId,
        toolPhase: "end",
        isError: result.isError
      });
    });
    if (transcript.length === 0) return [];
    task.updatedAt = frame.occurredAt;
    this.#activity(task, "progress", task.state, undefined, frame.occurredAt);
    return this.#snapshot(task, transcript);
  }

  #projectChildToolProgress(
    task: NativeTaskRecord,
    frame: Extract<PendingChildFrame, { kind: "tool_progress" }>
  ): readonly NativeTaskEmission[] {
    const seconds = finite(frame.envelope["elapsed_time_seconds"]);
    if (seconds === undefined) return [];
    const callId = this.#projection.identifier(frame.envelope["tool_use_id"], "unknown-tool");
    const name = this.#projection.identifier(frame.envelope["tool_name"], task.toolNames.get(callId) ?? "Tool");
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    const previous = task.lastToolProgressSecond.get(callId);
    if (previous !== undefined && wholeSeconds - previous < 5) return [];
    if (previous === undefined && task.lastToolProgressSecond.size >= MAX_TASK_TOOL_ENTRIES) {
      throw new ProjectionLimitError("The native child tool-progress count exceeded its limit.");
    }
    task.lastToolProgressSecond.set(callId, wholeSeconds);
    task.lastToolName = name;
    task.updatedAt = frame.occurredAt;
    this.#activity(task, "progress", task.state, undefined, frame.occurredAt, name);
    return this.#snapshot(task, [this.#transcript(task, {
      role: "tool",
      content: `Running for ${wholeSeconds} seconds.`,
      occurredAt: frame.occurredAt,
      childId: childIdFor(task.id),
      childTitle: task.title,
      toolName: name,
      toolCallId: callId,
      toolPhase: "update"
    })]);
  }

  #task(
    rawTaskId: string,
    context: AdapterContext,
    envelope: Readonly<Record<string, unknown>>
  ): NativeTaskRecord {
    const existing = this.#tasks.get(rawTaskId);
    if (existing !== undefined) {
      this.#mergeIdentity(existing, envelope);
      return existing;
    }
    if (this.#tasks.size >= MAX_TASKS) throw new ProjectionLimitError("The native task count exceeded its limit.");
    const occurredAt = this.#now();
    const publicId = publicTaskId(rawTaskId);
    const task: NativeTaskRecord = {
      rawId: rawTaskId,
      id: publicId,
      context,
      activity: [],
      identityAliases: [publicId],
      seenFrames: new Set(),
      toolNames: new Map(),
      lastToolProgressSecond: new Map(),
      state: "running",
      backgroundState: "running",
      activitySequence: 0,
      transcriptSequence: 0,
      title: "Native task",
      returnedResultTruncated: false,
      wake: false,
      isSubagent: false,
      excludedFromSubagents: false,
      skipTranscript: false,
      startedAt: occurredAt,
      updatedAt: occurredAt
    };
    this.#tasks.set(rawTaskId, task);
    this.#publicTaskIds.set(publicId, task);
    this.#mergeIdentity(task, envelope);
    return task;
  }

  #mergeIdentity(task: NativeTaskRecord, envelope: Readonly<Record<string, unknown>>): void {
    const taskType = optionalProjected(this.#projection, envelope["task_type"], 128);
    if (taskType !== undefined) task.taskType = taskType;
    const subagentType = optionalProjected(this.#projection, envelope["subagent_type"], 128);
    if (subagentType !== undefined) task.subagentType = subagentType;
    const title = optionalProjected(this.#projection, envelope["description"], 512);
    if (title !== undefined) task.title = title;
    const assignment = optionalProjected(this.#projection, envelope["prompt"], 64 * 1024);
    if (assignment !== undefined) task.assignment = assignment;
    if (envelope["skip_transcript"] === true) task.skipTranscript = true;
    const observedType = stringValue(envelope["task_type"]);
    if (observedType !== undefined && NATIVE_WAKE_TASK_TYPES.has(observedType)) task.wake = true;
    if (observedType !== undefined && NATIVE_AGENT_TASK_TYPES.has(observedType)) {
      task.isSubagent = true;
      task.excludedFromSubagents = false;
    } else if (observedType !== undefined && NATIVE_NON_AGENT_TASK_TYPES.has(observedType) && !task.isSubagent) {
      task.excludedFromSubagents = true;
    }
  }

  #bindTaskTool(task: NativeTaskRecord, rawToolUseId: string, scope: ToolScope | undefined): void {
    const existingOwner = this.#taskByToolUseId.get(rawToolUseId);
    if (existingOwner !== undefined && existingOwner !== task.rawId) {
      throw new ProjectionLimitError("A native tool scope was claimed by conflicting tasks.");
    }
    if (task.toolUseId !== undefined && task.toolUseId !== rawToolUseId) {
      this.#taskByToolUseId.delete(task.toolUseId);
    }
    if (existingOwner === undefined && this.#taskByToolUseId.size >= MAX_TASKS) {
      throw new ProjectionLimitError("The native task-to-tool index exceeded its limit.");
    }
    task.toolUseId = rawToolUseId;
    this.#taskByToolUseId.set(rawToolUseId, task.rawId);
    const publicToolId = this.#projection.identifier(rawToolUseId, "native-tool");
    if (!task.identityAliases.includes(publicToolId)) task.identityAliases.push(publicToolId);
    if (scope?.parentTaskId !== undefined) task.parentTaskId = scope.parentTaskId;
    if (scope !== undefined) task.context = scope.context;
    if (scope?.agentCandidate === true && !task.excludedFromSubagents) task.isSubagent = true;
  }

  #assignmentEntries(task: NativeTaskRecord): readonly SubagentTranscriptEntry[] {
    if (!task.isSubagent || task.excludedFromSubagents || task.skipTranscript || task.transcriptSequence > 0) return [];
    const content = task.assignment ?? task.title;
    return [this.#transcript(task, {
      role: "parent",
      content,
      occurredAt: task.startedAt,
      childId: childIdFor(task.id),
      childTitle: task.title
    })];
  }

  #snapshot(
    task: NativeTaskRecord,
    transcript: readonly SubagentTranscriptEntry[]
  ): readonly NativeTaskEmission[] {
    const emissions: NativeTaskEmission[] = [{
      context: task.context,
      payload: {
        type: "background_task",
        taskId: task.id,
        ...(task.parentTaskId === undefined ? {} : { parentTaskId: publicTaskId(task.parentTaskId) }),
        title: task.title,
        state: task.backgroundState,
        ...(task.summary === undefined ? {} : { detail: task.summary }),
        startedAt: task.startedAt,
        ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
        ...(task.error === undefined ? {} : { error: task.error })
      }
    }];
    if (!task.isSubagent || task.excludedFromSubagents || task.skipTranscript) return emissions;
    emissions.push({ context: task.context, payload: { type: "subagent_run", run: this.#run(task) } });
    for (const entry of transcript) {
      emissions.push({
        context: task.context,
        payload: { type: "subagent_transcript", subagentRunId: task.id, entry }
      });
    }
    return emissions;
  }

  #run(task: NativeTaskRecord): SubagentRunDetail {
    const childId = childIdFor(task.id);
    const role = task.subagentType ?? task.taskType ?? "agent";
    const parentTask = task.parentTaskId === undefined ? undefined : this.#tasks.get(task.parentTaskId);
    const route = {
      providerId: "claude-code",
      ...(task.modelId === undefined ? {} : { modelId: task.modelId })
    };
    return {
      id: task.id,
      sessionId: this.#sessionId,
      ...(parentTask === undefined ? {} : {
        parentSubagentRunId: parentTask.id,
        parentTaskId: parentTask.id
      }),
      ...(task.toolUseId === undefined ? {} : {
        parentToolCallId: this.#projection.identifier(task.toolUseId, "native-tool")
      }),
      logicalAgentId: task.id,
      identityAliases: [...task.identityAliases],
      providerRunIds: [`claude-native:${task.id}`],
      state: task.state,
      title: task.title,
      ...(task.assignment === undefined ? {} : { description: task.assignment, assignment: task.assignment }),
      ...(task.summary === undefined ? {} : { summary: task.summary }),
      route,
      ...(task.usage === undefined ? {} : { usage: task.usage }),
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: activeState(task.state),
        steer: false,
        followUp: false,
        resume: false,
        parentContext: "live"
      },
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.error === undefined ? {} : { error: task.error }),
      activity: [...task.activity],
      children: [{
        id: childId,
        identityAliases: [...task.identityAliases],
        role,
        title: task.title,
        ...(task.assignment === undefined ? {} : { assignment: task.assignment }),
        state: task.state,
        route,
        ...(task.usage === undefined ? {} : { usage: task.usage }),
        ...(task.returnedResult === undefined ? {} : {
          result: task.returnedResult,
          ...(task.returnedResultTruncated ? { resultTruncated: true } : {})
        }),
        ...(task.error === undefined ? {} : { error: task.error }),
        startedAt: task.startedAt,
        ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt })
      }],
      ...(task.returnedResult === undefined ? {} : {
        returnedResult: task.returnedResult,
        ...(task.returnedResultTruncated ? { returnedResultTruncated: true } : {})
      })
    };
  }

  #activity(
    task: NativeTaskRecord,
    kind: SubagentActivityEntry["kind"],
    state: SubagentRunState,
    summary: string | undefined,
    occurredAt: number,
    lastToolName?: string
  ): void {
    const entry: SubagentActivityEntry = {
      sequence: ++task.activitySequence,
      kind,
      state,
      ...(summary === undefined ? {} : { summary }),
      ...(lastToolName === undefined ? {} : { lastToolName }),
      occurredAt
    };
    task.activity.push(entry);
    if (task.activity.length > MAX_ACTIVITY_ENTRIES) task.activity.splice(0, task.activity.length - MAX_ACTIVITY_ENTRIES);
  }

  #transcript(
    task: NativeTaskRecord,
    value: Omit<SubagentTranscriptEntry, "id" | "sequence">
  ): SubagentTranscriptEntry {
    const sequence = ++task.transcriptSequence;
    return {
      id: `${task.id}:entry:${sequence}`,
      sequence,
      ...value
    };
  }

  #appendReturnedResult(task: NativeTaskRecord, fragment: string): void {
    if (task.returnedResultTruncated) return;
    const prefix = task.returnedResult === undefined || task.returnedResult.length === 0 ? "" : `${task.returnedResult}\n`;
    const combined = `${prefix}${fragment}`;
    if (combined.length <= MAX_RESULT_CHARACTERS) {
      task.returnedResult = combined;
      return;
    }
    task.returnedResult = combined.slice(0, MAX_RESULT_CHARACTERS);
    task.returnedResultTruncated = true;
  }

  #duplicateSystemFrame(envelope: Readonly<Record<string, unknown>>): boolean {
    const uuid = validNativeIdentity(envelope["uuid"]);
    if (uuid === undefined) return false;
    if (this.#seenSystemFrames.has(uuid)) return true;
    addBounded(this.#seenSystemFrames, uuid, MAX_SEEN_FRAMES);
    return false;
  }

  #duplicateTaskFrame(task: NativeTaskRecord, envelope: Readonly<Record<string, unknown>>): boolean {
    const uuid = validNativeIdentity(envelope["uuid"]);
    if (uuid === undefined) return false;
    if (task.seenFrames.has(uuid)) return true;
    addBounded(task.seenFrames, uuid, MAX_SEEN_FRAMES);
    return false;
  }

  #retainPendingChild(parentToolUseId: string, frame: PendingChildFrame): void {
    if (this.#pendingChildFrameCount >= MAX_PENDING_CHILD_FRAMES) {
      throw new ProjectionLimitError("The pending native child-message count exceeded its limit.");
    }
    const frames = this.#pendingChildren.get(parentToolUseId) ?? [];
    frames.push(frame);
    this.#pendingChildren.set(parentToolUseId, frames);
    this.#pendingChildFrameCount += 1;
  }

  #drainPendingChildren(task: NativeTaskRecord): readonly NativeTaskEmission[] {
    const toolUseId = task.toolUseId;
    if (toolUseId === undefined) return [];
    const frames = this.#pendingChildren.get(toolUseId);
    if (frames === undefined) return [];
    this.#pendingChildren.delete(toolUseId);
    this.#pendingChildFrameCount -= frames.length;
    return frames.flatMap((frame) => this.#projectChild(task, frame));
  }
}

export function isNativeTaskSystemSubtype(value: string | undefined): boolean {
  return value === "task_started"
    || value === "task_progress"
    || value === "task_notification"
    || value === "task_updated"
    || value === "background_tasks_changed";
}

function taskUsage(value: unknown): SubagentUsage | undefined {
  const usage = record(value);
  if (usage === undefined) return undefined;
  const totalTokens = nonNegativeNumber(usage["total_tokens"]);
  const toolUses = nonNegativeNumber(usage["tool_uses"]);
  const durationMs = nonNegativeNumber(usage["duration_ms"]);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) return undefined;
  return {
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs })
  };
}

function updatedState(
  value: string | undefined,
  error: string | undefined
): { readonly state: SubagentRunState; readonly backgroundState: NativeTaskRecord["backgroundState"] } | undefined {
  if (error !== undefined && error.length > 0) return { state: "failed", backgroundState: "failed" };
  if (value === "pending") return { state: "queued", backgroundState: "queued" };
  if (value === "paused") return { state: "running", backgroundState: "waiting" };
  if (value === "running") return { state: "running", backgroundState: "running" };
  if (value === "completed") return { state: "completed", backgroundState: "completed" };
  if (value === "failed") return { state: "failed", backgroundState: "failed" };
  if (value === "killed") return { state: "stopped", backgroundState: "aborted" };
  return undefined;
}

function optionalProjected(projection: SafeProjection, value: unknown, maximum: number): string | undefined {
  const projected = projection.text(value, maximum).trim();
  return projected.length === 0 ? undefined : projected;
}

function publicTaskId(rawTaskId: string): string {
  return `claude-task-${createHash("sha256").update(rawTaskId).digest("hex").slice(0, 32)}`;
}

function childIdFor(publicTaskIdValue: string): string {
  return `${publicTaskIdValue}:child`;
}

function validNativeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function activeState(state: SubagentRunState): boolean {
  return state === "queued" || state === "running";
}

function nativeTaskError(message: string): PublicError {
  return {
    code: "CLAUDE_CODE_NATIVE_TASK_FAILED",
    message,
    phase: "background_task",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Inspect the task transcript and start a new delegated task if needed."
  };
}

function addBounded(values: Set<string>, value: string, maximum: number): void {
  if (!values.has(value) && values.size >= maximum) {
    throw new ProjectionLimitError("The native task identity set exceeded its limit.");
  }
  values.add(value);
}
