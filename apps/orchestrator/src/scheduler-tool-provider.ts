import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { redactSecrets, type PermissionMode, type PromptInput, type SessionDescriptor } from "@joko/core";
import {
  NotFoundError,
  OperationalStore,
  RevisionConflictError,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type UpsertScheduleInput
} from "@joko/store";

import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";
import {
  defaultScheduleExtensionSnapshot,
  defaultScheduleWorktreeConfiguration,
  scheduleExtensionSnapshot,
  scheduleWorktreeConfiguration,
  withScheduleExtensionSnapshot,
  type ScheduleExtensionSnapshot,
  type SchedulePreRunHookConfiguration,
  type ScheduleScriptExecutionConfiguration
} from "./schedule-extensions.js";
import {
  ScheduleHookScriptInstaller,
  validateScheduleHookScriptBinding
} from "./schedule-hook-script-installer.js";
import { durableSchedulePreRunHookResult } from "./schedule-pre-run-hook.js";
import type { ScheduleRunNotificationController } from "./schedule-run-notifications.js";
import { nextOccurrence, type ScheduleTiming } from "./scheduler.js";

export const SCHEDULER_TOOL_PROVIDER_ID = "joko-scheduler";

export const SCHEDULER_TOOL_NAMES = [
  "schedule_list",
  "schedule_get",
  "schedule_create",
  "schedule_update",
  "schedule_delete",
  "schedule_pause",
  "schedule_resume",
  "schedule_run_now",
  "schedule_list_runs",
  "schedule_set_pre_run_hook",
  "schedule_notify_current_run",
  "schedule_silence_current_run"
] as const;

export interface SchedulerToolCoordinator {
  runNowWithResult(
    scheduleId: string,
    operationId?: string
  ): Promise<{
    readonly runId: string;
    readonly sessionId?: string;
    readonly status?: "queued" | "success" | "skipped" | "failed" | "aborted";
  }>;
  abortSchedule?(
    scheduleId: string,
    linkedOccurrences?: readonly { readonly runId: string; readonly sessionId?: string }[]
  ): Promise<void>;
}

export interface SchedulerToolProviderOptions {
  readonly store: OperationalStore;
  /** Late-bound because Pi bridge snapshots are frozen before SessionHost is constructed. */
  readonly coordinator: () => SchedulerToolCoordinator | undefined;
  readonly hookScripts: ScheduleHookScriptInstaller;
  readonly runNotifications: ScheduleRunNotificationController;
  readonly now?: () => number;
}

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
} as const;

const REVISION_SCHEMA = {
  anyOf: [
    { type: "string", pattern: "^[0-9]+$", maxLength: 32 },
    { type: "integer", minimum: 0 }
  ],
  description: "Optional optimistic-concurrency revision returned by schedule_get or schedule_list."
} as const;

const PRE_RUN_HOOK_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, maxLength: 32_768 },
    filePath: { type: "string", minLength: 1, maxLength: 4_096 },
    timeoutMs: { type: "integer", minimum: 1 }
  },
  required: ["command", "filePath"],
  additionalProperties: false
} as const;

const SCRIPT_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, maxLength: 32_768 },
    timeoutMs: { type: "integer", minimum: 1 },
    capabilities: {
      type: "array",
      items: { type: "string", enum: ["sessions.dispatch"] },
      uniqueItems: true,
      maxItems: 1
    }
  },
  required: ["command", "capabilities"],
  additionalProperties: false
} as const;

const CREATE_PROPERTIES = {
  name: { type: "string", minLength: 1, maxLength: 256, description: "Display name." },
  prompt: { type: "string", minLength: 1, maxLength: 262_144, description: "Prompt sent for each agent run." },
  kind: { type: "string", enum: ["cron", "interval", "one_shot", "manual"], description: "Recurrence kind." },
  cronExpr: { type: "string", minLength: 1, maxLength: 256, description: "Five-field cron expression." },
  intervalMs: { type: "integer", minimum: 1_000, description: "Anchored interval in milliseconds." },
  runAt: { type: "integer", minimum: 0, description: "One-shot Unix timestamp in milliseconds." },
  timezone: { type: "string", minLength: 1, maxLength: 128, description: "IANA timezone identifier." },
  recurring: { type: "boolean", description: "False turns the next cron occurrence into a one-shot task." },
  manual: { type: "boolean", description: "True disables automatic firing while keeping run-now available." },
  agentKind: {
    type: "string",
    minLength: 1,
    maxLength: 256,
    description: "Backend ID. When supplied, it must match the authenticated calling task."
  },
  providerId: { type: "string", minLength: 1, maxLength: 256 },
  model: { type: "string", minLength: 1, maxLength: 256 },
  effort: { type: "string", minLength: 1, maxLength: 64 },
  fastMode: { type: "boolean" },
  permissionMode: { type: "string", enum: ["ask", "auto", "bypassPermissions"] },
  planMode: { type: "boolean" },
  targetSessionId: { ...ID_SCHEMA, description: "Explicit existing task binding." },
  bindToCurrentSession: { type: "boolean", description: "Bind to the authenticated calling task." },
  persistentSession: { type: "boolean", description: "Reuse the first generated task on later runs." },
  enabled: { type: "boolean" },
  overlapPolicy: { type: "string", enum: ["queue", "skip"] },
  misfirePolicy: { type: "string", enum: ["run_once", "skip"] },
  silentWhenIdle: { type: "boolean", description: "Suppress successful-run attention unless the run opts back in." },
  notify: {
    type: "object",
    properties: { desktop: { type: "boolean" } },
    required: ["desktop"],
    additionalProperties: false
  },
  expireAt: { type: "integer", minimum: 0, description: "Optional Unix-millisecond expiration." },
  preRunHook: PRE_RUN_HOOK_SCHEMA,
  executionMode: { type: "string", enum: ["agent", "script"] },
  scriptConfig: SCRIPT_CONFIG_SCHEMA
} as const;

export const SCHEDULER_TOOLS: readonly McpToolDescriptor[] = [
  tool(
    "schedule_list",
    "List every schedule owned by this workspace. GUI and agent tools read the same durable records.",
    objectSchema({}),
    false
  ),
  tool(
    "schedule_get",
    "Read one schedule by ID. A missing or out-of-workspace schedule returns data:null.",
    objectSchema({ id: ID_SCHEMA }, ["id"]),
    false
  ),
  tool(
    "schedule_create",
    "Create a durable one-shot, cron, interval, or manual schedule. Agent mode requires prompt; script mode requires scriptConfig and executes without model tokens.",
    objectSchema(CREATE_PROPERTIES, ["name"]),
    true
  ),
  tool(
    "schedule_update",
    "Patch only the supplied schedule fields. Recurrence changes recompute the next occurrence.",
    objectSchema({
      id: ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      ...CREATE_PROPERTIES,
      expireAt: { anyOf: [CREATE_PROPERTIES.expireAt, { type: "null" }] },
      preRunHook: { anyOf: [PRE_RUN_HOOK_SCHEMA, { type: "null" }] },
      scriptConfig: { anyOf: [SCRIPT_CONFIG_SCHEMA, { type: "null" }] }
    }, ["id"]),
    true
  ),
  tool(
    "schedule_delete",
    "Delete one schedule owned by this workspace.",
    objectSchema({ id: ID_SCHEMA, expectedRevision: REVISION_SCHEMA }, ["id"]),
    true
  ),
  tool(
    "schedule_pause",
    "Pause automatic firing while retaining the schedule and its recurrence.",
    objectSchema({ id: ID_SCHEMA, expectedRevision: REVISION_SCHEMA }, ["id"]),
    true
  ),
  tool(
    "schedule_resume",
    "Resume a paused schedule and recompute its next occurrence from the durable recurrence.",
    objectSchema({ id: ID_SCHEMA, expectedRevision: REVISION_SCHEMA }, ["id"]),
    true
  ),
  tool(
    "schedule_run_now",
    "Queue a schedule immediately without changing its normal recurrence cadence.",
    objectSchema({ id: ID_SCHEMA }, ["id"]),
    true
  ),
  tool(
    "schedule_list_runs",
    "List recent durable run history for one schedule.",
    objectSchema({
      scheduleId: ID_SCHEMA,
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 }
    }, ["scheduleId"]),
    false
  ),
  tool(
    "schedule_set_pre_run_hook",
    "Install or modify a managed Node ESM pre-run gate, self-test its exit-code protocol, and optionally attach it to a schedule.",
    objectSchema({
      scheduleId: ID_SCHEMA,
      script: { type: "string", minLength: 1, maxLength: 262_144 },
      description: { type: "string", minLength: 1, maxLength: 16_384 },
      workingDir: { type: "string", minLength: 1, maxLength: 4_096 },
      scheduleName: { type: "string", minLength: 1, maxLength: 256 },
      timeoutMs: { type: "integer", minimum: 1 }
    }),
    true
  ),
  tool(
    "schedule_notify_current_run",
    "Opt the authenticated task's current schedule run back into successful-completion attention.",
    objectSchema({ runId: ID_SCHEMA }),
    true
  ),
  tool(
    "schedule_silence_current_run",
    "Silence successful-completion attention for the authenticated task's current schedule run; failures still alert.",
    objectSchema({ runId: ID_SCHEMA }),
    true
  )
];

/**
 * Workspace-scoped Scheduler tools exposed directly to managed Pi runtimes.
 * Routing is derived from the authenticated bridge context; Backend, Target,
 * and caller task identity are never accepted from tool arguments.
 */
export class SchedulerToolBridgeProvider implements BridgeToolProvider {
  readonly id = SCHEDULER_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = SCHEDULER_TOOLS;
  readonly #store: OperationalStore;
  readonly #coordinator: () => SchedulerToolCoordinator | undefined;
  readonly #hookScripts: ScheduleHookScriptInstaller;
  readonly #runNotifications: ScheduleRunNotificationController;
  readonly #now: () => number;

  constructor(options: SchedulerToolProviderOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#hookScripts = options.hookScripts;
    this.#runNotifications = options.runNotifications;
    this.#now = options.now ?? Date.now;
  }

  includeForTarget(targetId: string): boolean {
    try {
      return this.#store.getTarget(targetId).descriptor.trusted;
    } catch {
      return false;
    }
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    signal?.throwIfAborted();
    if (!SCHEDULER_TOOL_NAMES.some((candidate) => candidate === name)) {
      throw new Error("Scheduler tool is not part of this runtime snapshot.");
    }
    try {
      const caller = this.#requireCaller(context);
      switch (name) {
        case "schedule_list": {
          assertKeys(arguments_, []);
          return toolResult(this.#store.listSchedules({ targetId: context.targetId }).map(publicSchedule));
        }
        case "schedule_get": {
          assertKeys(arguments_, ["id"]);
          const schedule = this.#findOwnedSchedule(requiredId(arguments_, "id"), context.targetId);
          return toolResult(schedule === undefined ? null : publicSchedule(schedule));
        }
        case "schedule_create":
          return toolResult(publicSchedule(await this.#create(arguments_, caller)));
        case "schedule_update":
          return toolResult(publicSchedule(await this.#update(arguments_, caller)));
        case "schedule_delete": {
          assertKeys(arguments_, ["id", "expectedRevision"]);
          const schedule = this.#requireOwnedSchedule(requiredId(arguments_, "id"), context.targetId);
          const expectedRevision = optionalRevision(arguments_["expectedRevision"]) ?? schedule.revision;
          const linkedOccurrences = listAllScheduleRuns(this.#store, schedule.id);
          this.#store.deleteSchedule(schedule.id, expectedRevision);
          await this.#coordinator()?.abortSchedule?.(schedule.id, linkedOccurrences);
          return toolResult({ id: schedule.id, deleted: true });
        }
        case "schedule_pause": {
          assertKeys(arguments_, ["id", "expectedRevision"]);
          const schedule = this.#requireOwnedSchedule(requiredId(arguments_, "id"), context.targetId);
          const expectedRevision = optionalRevision(arguments_["expectedRevision"]) ?? schedule.revision;
          if (!schedule.enabled) return toolResult(publicSchedule(schedule));
          const paused = this.#store.upsertSchedule(copySchedule(schedule, {
            enabled: false,
            nextRunAt: schedule.nextRunAt,
            expectedRevision,
            now: this.#now()
          }));
          await this.#coordinator()?.abortSchedule?.(schedule.id);
          return toolResult(publicSchedule(paused));
        }
        case "schedule_resume": {
          assertKeys(arguments_, ["id", "expectedRevision"]);
          const schedule = this.#requireOwnedSchedule(requiredId(arguments_, "id"), context.targetId);
          const expectedRevision = optionalRevision(arguments_["expectedRevision"]) ?? schedule.revision;
          if (schedule.enabled) return toolResult(publicSchedule(schedule));
          const now = this.#now();
          const nextRunAt = resumedOccurrence(schedule, now);
          if (schedule.kind !== "manual" && nextRunAt === undefined) {
            throw new SchedulerToolError("INVALID_STATE", "This one-shot schedule has expired and cannot be resumed.");
          }
          const resumed = this.#store.upsertSchedule(copySchedule(schedule, {
            enabled: true,
            nextRunAt,
            expectedRevision,
            now
          }));
          return toolResult(publicSchedule(resumed));
        }
        case "schedule_run_now": {
          assertKeys(arguments_, ["id"]);
          const schedule = this.#requireOwnedSchedule(requiredId(arguments_, "id"), context.targetId);
          const coordinator = this.#coordinator();
          if (coordinator === undefined) {
            throw new SchedulerToolError("UNAVAILABLE", "Scheduler runtime is not ready.");
          }
          const dispatched = await coordinator.runNowWithResult(schedule.id, randomUUID());
          signal?.throwIfAborted();
          return toolResult({
            scheduleId: schedule.id,
            runId: dispatched.runId,
            ...(dispatched.sessionId === undefined ? {} : { sessionId: dispatched.sessionId }),
            ...(dispatched.status === undefined ? {} : { status: dispatched.status }),
            nextFireAt: schedule.nextRunAt
          });
        }
        case "schedule_list_runs": {
          assertKeys(arguments_, ["scheduleId", "limit"]);
          const scheduleId = requiredId(arguments_, "scheduleId");
          this.#requireOwnedSchedule(scheduleId, context.targetId);
          const limit = optionalInteger(arguments_["limit"], "limit", 1, 500) ?? 100;
          return toolResult(this.#store.listScheduleRuns(scheduleId, limit).map(publicScheduleRun));
        }
        case "schedule_set_pre_run_hook":
          return toolResult(await this.#setPreRunHook(arguments_, caller, signal));
        case "schedule_notify_current_run": {
          assertKeys(arguments_, ["runId"]);
          const runId = this.#setRunNotification("notify", caller, arguments_["runId"]);
          return toolResult({ notified: true, runId });
        }
        case "schedule_silence_current_run": {
          assertKeys(arguments_, ["runId"]);
          const runId = this.#setRunNotification("silent", caller, arguments_["runId"]);
          return toolResult({ silenced: true, runId });
        }
      }
      throw new Error("Scheduler tool is not part of this runtime snapshot.");
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      return toolFailure(error);
    }
  }

  #requireCaller(context: BridgeToolCallContext): SessionDescriptor {
    const session = this.#store.getSession(context.sessionId).descriptor;
    const target = this.#store.getTarget(context.targetId).descriptor;
    if (!target.trusted) throw new SchedulerToolError("UNTRUSTED_TARGET", "Scheduler tools require a trusted workspace.");
    if (
      session.targetId !== context.targetId ||
      session.backendId !== target.backendId ||
      session.binding.generation !== context.generation ||
      session.deletedAt !== undefined ||
      session.archived
    ) {
      throw new SchedulerToolError("STALE_SCOPE", "Scheduler tool scope is stale or unavailable.");
    }
    return session;
  }

  #findOwnedSchedule(id: string, targetId: string): ScheduleRecord | undefined {
    const schedule = this.#store.findSchedule(id);
    return schedule?.targetId === targetId ? schedule : undefined;
  }

  #requireOwnedSchedule(id: string, targetId: string): ScheduleRecord {
    const schedule = this.#findOwnedSchedule(id, targetId);
    if (schedule === undefined) throw new SchedulerToolError("NOT_FOUND", "Schedule does not exist.");
    return schedule;
  }

  async #create(input: Readonly<Record<string, unknown>>, caller: SessionDescriptor): Promise<ScheduleRecord> {
    assertKeys(input, Object.keys(CREATE_PROPERTIES));
    validateAgentKind(input["agentKind"], caller.backendId);
    const now = this.#now();
    const timing = createTiming(input, now);
    const enabled = optionalBoolean(input["enabled"], "enabled") ?? true;
    if (enabled && timing.kind !== "manual" && timing.nextRunAt === undefined) {
      throw new SchedulerToolError("INVALID_PARAMS", "Enabled schedule recurrence has no future occurrence.");
    }
    const binding = sessionBinding(input, caller, this.#store);
    const executionSnapshot = await scheduleExecutionInput(input, caller, this.#store);
    const extension = safeScheduleExtensions(executionSnapshot);
    const prompt = promptInput(input["prompt"] === undefined
      ? ""
      : requiredText(input, "prompt", 262_144));
    assertExecutionCompatibility(extension, scheduleWorktreeConfiguration(executionSnapshot), binding, prompt);
    return this.#store.upsertSchedule({
      id: randomUUID(),
      backendId: caller.backendId,
      targetId: caller.targetId,
      sessionMode: binding.mode,
      ...(binding.sessionId === undefined ? {} : { sessionId: binding.sessionId }),
      name: requiredText(input, "name", 256),
      kind: timing.kind,
      ...(timing.expression === undefined ? {} : { expression: timing.expression }),
      ...(timing.anchorAt === undefined ? {} : { anchorAt: timing.anchorAt }),
      timezone: timing.timezone,
      enabled,
      prompt,
      executionSnapshot,
      overlapPolicy: overlapPolicy(input["overlapPolicy"]),
      misfirePolicy: misfirePolicy(input["misfirePolicy"]),
      ...(timing.nextRunAt === undefined ? {} : { nextRunAt: timing.nextRunAt }),
      expectedRevision: 0n,
      now
    });
  }

  async #update(input: Readonly<Record<string, unknown>>, caller: SessionDescriptor): Promise<ScheduleRecord> {
    assertKeys(input, ["id", "expectedRevision", ...Object.keys(CREATE_PROPERTIES)]);
    validateAgentKind(input["agentKind"], caller.backendId);
    const id = requiredId(input, "id");
    const current = this.#requireOwnedSchedule(id, caller.targetId);
    const expectedRevision = optionalRevision(input["expectedRevision"]) ?? current.revision;
    const now = this.#now();
    const timing = updateTiming(input, current, now);
    const enabled = optionalBoolean(input["enabled"], "enabled") ?? current.enabled;
    if (enabled && timing.kind !== "manual" && timing.nextRunAt === undefined) {
      throw new SchedulerToolError("INVALID_PARAMS", "Enabled schedule recurrence has no future occurrence.");
    }
    const binding = hasOwn(input, "targetSessionId") || input["bindToCurrentSession"] === true || hasOwn(input, "persistentSession")
      ? sessionBinding(input, caller, this.#store, current)
      : { mode: current.sessionMode, sessionId: current.sessionId } as const;
    const executionSnapshot = hasAny(input, [
      "providerId", "model", "effort", "fastMode", "permissionMode", "planMode",
      "silentWhenIdle", "notify", "expireAt", "preRunHook", "executionMode", "scriptConfig"
    ])
      ? await scheduleExecutionInput(input, caller, this.#store, current.executionSnapshot)
      : current.executionSnapshot;
    const name = hasOwn(input, "name") ? requiredText(input, "name", 256) : current.name;
    const prompt = hasOwn(input, "prompt")
      ? promptInput(requiredText(input, "prompt", 262_144))
      : current.prompt;
    assertExecutionCompatibility(
      safeScheduleExtensions(executionSnapshot),
      scheduleWorktreeConfiguration(executionSnapshot),
      binding,
      prompt
    );
    return this.#store.upsertSchedule({
      id: current.id,
      backendId: current.backendId,
      targetId: current.targetId,
      sessionMode: binding.mode,
      ...(binding.sessionId === undefined ? {} : { sessionId: binding.sessionId }),
      name,
      kind: timing.kind,
      ...(timing.expression === undefined ? {} : { expression: timing.expression }),
      ...(timing.anchorAt === undefined ? {} : { anchorAt: timing.anchorAt }),
      timezone: timing.timezone,
      enabled,
      prompt,
      executionSnapshot,
      overlapPolicy: hasOwn(input, "overlapPolicy") ? overlapPolicy(input["overlapPolicy"]) : current.overlapPolicy,
      misfirePolicy: hasOwn(input, "misfirePolicy") ? misfirePolicy(input["misfirePolicy"]) : current.misfirePolicy,
      ...(timing.nextRunAt === undefined ? {} : { nextRunAt: timing.nextRunAt }),
      ...(current.lastRunAt === undefined ? {} : { lastRunAt: current.lastRunAt }),
      expectedRevision,
      now
    });
  }

  async #setPreRunHook(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor,
    signal: AbortSignal | undefined
  ): Promise<Readonly<Record<string, unknown>>> {
    assertKeys(input, ["scheduleId", "script", "description", "workingDir", "scheduleName", "timeoutMs"]);
    const schedule = input["scheduleId"] === undefined
      ? undefined
      : this.#requireOwnedSchedule(requiredId(input, "scheduleId"), caller.targetId);
    const target = this.#store.getTarget(caller.targetId).descriptor;
    if (input["workingDir"] !== undefined) {
      const requested = requiredText(input, "workingDir", 4_096);
      if (resolveComparablePath(requested) !== resolveComparablePath(target.workspaceRoot)) {
        throw new SchedulerToolError("PATH_NOT_ALLOWED", "workingDir must be the authenticated workspace root.");
      }
    }
    const extension = schedule === undefined
      ? undefined
      : safeScheduleExtensions(schedule.executionSnapshot);
    const execution = schedule === undefined || !isRecord(schedule.executionSnapshot)
      ? {}
      : schedule.executionSnapshot;
    const installed = await this.#hookScripts.install({
      workspaceRoot: target.workspaceRoot,
      ...(schedule === undefined ? {} : { scheduleId: schedule.id }),
      scheduleName: schedule?.name ?? optionalText(input["scheduleName"], "scheduleName", 256),
      ...(input["script"] === undefined ? {} : { script: requiredText(input, "script", 262_144) }),
      ...(input["description"] === undefined ? {} : { description: requiredText(input, "description", 16_384) }),
      ...(extension?.preRunHook?.filePath === undefined ? {} : { currentFilePath: extension.preRunHook.filePath }),
      ...(typeof execution["providerId"] !== "string" ? {} : { providerId: execution["providerId"] }),
      ...(typeof execution["modelId"] !== "string" ? {} : { modelId: execution["modelId"] }),
      ...(signal === undefined ? {} : { signal })
    });
    const timeoutMs = input["timeoutMs"] === undefined
      ? extension?.preRunHook?.timeoutMs
      : requiredInteger(input["timeoutMs"], "timeoutMs", 1, Number.MAX_SAFE_INTEGER);
    let attached = false;
    let attachedSchedule: ScheduleRecord | undefined;
    if (schedule !== undefined && extension !== undefined) {
      const nextExtension: ScheduleExtensionSnapshot = {
        ...extension,
        preRunHook: {
          command: installed.command,
          filePath: installed.filePath,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        }
      };
      attachedSchedule = this.#store.upsertSchedule(copyScheduleExecution(
        schedule,
        withScheduleExtensionSnapshot(schedule.executionSnapshot, nextExtension),
        schedule.revision,
        this.#now()
      ));
      attached = true;
    }
    return {
      command: installed.command,
      filePath: installed.filePath,
      attached,
      ...(attachedSchedule === undefined ? {} : { schedule: publicSchedule(attachedSchedule) }),
      test: durableSchedulePreRunHookResult(installed.test),
      content: installed.content.length > 4_000
        ? `${installed.content.slice(0, 4_000)}…[truncated]`
        : installed.content
    };
  }

  #setRunNotification(
    mode: "silent" | "notify",
    caller: SessionDescriptor,
    requestedRunId: unknown
  ): string {
    const runId = requestedRunId === undefined
      ? undefined
      : requiredId({ runId: requestedRunId }, "runId");
    try {
      const resolved = this.#runNotifications[mode === "silent" ? "silence" : "notify"]({
        sessionId: caller.id,
        targetId: caller.targetId,
        ...(runId === undefined ? {} : { runId })
      });
      return resolved.runId;
    } catch {
      throw new SchedulerToolError(
        "NOT_FOUND",
        "An in-flight schedule run was not found for the authenticated task."
      );
    }
  }
}

interface StoredTiming {
  readonly kind: ScheduleRecord["kind"];
  readonly expression?: string;
  readonly anchorAt?: number;
  readonly timezone: string;
  readonly nextRunAt?: number;
}

function createTiming(input: Readonly<Record<string, unknown>>, now: number): StoredTiming {
  const timezone = optionalText(input["timezone"], "timezone", 128) ?? "UTC";
  validateTimezone(timezone, now);
  const explicitKind = timingKind(input["kind"]);
  const manual = optionalBoolean(input["manual"], "manual");
  const recurring = optionalBoolean(input["recurring"], "recurring");
  if (manual === true || explicitKind === "manual") {
    rejectTimingFields(input, ["manual", "kind", "timezone"]);
    return { kind: "manual", timezone };
  }
  if (hasOwn(input, "intervalMs") || explicitKind === "interval") {
    const everyMs = requiredInteger(input["intervalMs"], "intervalMs", 1_000, Number.MAX_SAFE_INTEGER);
    const anchorAt = now;
    return {
      kind: "interval",
      expression: String(everyMs),
      anchorAt,
      timezone,
      nextRunAt: nextOccurrence({ kind: "interval", everyMs, anchorAt }, now)
    };
  }
  if (hasOwn(input, "runAt") || explicitKind === "one_shot") {
    const runAt = hasOwn(input, "runAt")
      ? requiredInteger(input["runAt"], "runAt", 0, Number.MAX_SAFE_INTEGER)
      : nextCron(input, timezone, now - 1);
    if (runAt <= now) throw new SchedulerToolError("INVALID_PARAMS", "runAt must be in the future.");
    return {
      kind: "one_shot",
      ...(hasOwn(input, "cronExpr") ? { expression: requiredText(input, "cronExpr", 256) } : {}),
      timezone,
      nextRunAt: runAt
    };
  }
  if (recurring === false) {
    const expression = requiredText(input, "cronExpr", 256);
    return {
      kind: "one_shot",
      expression,
      timezone,
      nextRunAt: nextCron(input, timezone, now - 1)
    };
  }
  const expression = requiredText(input, "cronExpr", 256);
  return {
    kind: "cron",
    expression,
    timezone,
    nextRunAt: nextCron(input, timezone, now - 1)
  };
}

function updateTiming(
  input: Readonly<Record<string, unknown>>,
  current: ScheduleRecord,
  now: number
): StoredTiming {
  const timingKeys = ["kind", "cronExpr", "intervalMs", "runAt", "timezone", "recurring", "manual"];
  if (!hasAny(input, timingKeys)) return storedTiming(current);
  const timezone = optionalText(input["timezone"], "timezone", 128) ?? current.timezone;
  validateTimezone(timezone, now);
  const explicitKind = timingKind(input["kind"]);
  const manual = optionalBoolean(input["manual"], "manual");
  const recurring = optionalBoolean(input["recurring"], "recurring");
  if (manual === true || explicitKind === "manual") return { kind: "manual", timezone };

  if (hasOwn(input, "intervalMs")) {
    if (input["intervalMs"] === null) {
      const expression = optionalText(input["cronExpr"], "cronExpr", 256)
        ?? (current.kind === "cron" || current.kind === "one_shot" ? current.expression : undefined);
      if (expression === undefined) {
        throw new SchedulerToolError("INVALID_PARAMS", "cronExpr is required when clearing intervalMs.");
      }
      if (recurring === false || explicitKind === "one_shot") {
        return { kind: "one_shot", expression, timezone, nextRunAt: cronOccurrence(expression, timezone, now - 1) };
      }
      return { kind: "cron", expression, timezone, nextRunAt: cronOccurrence(expression, timezone, now - 1) };
    }
    const everyMs = requiredInteger(input["intervalMs"], "intervalMs", 1_000, Number.MAX_SAFE_INTEGER);
    return {
      kind: "interval",
      expression: String(everyMs),
      anchorAt: now,
      timezone,
      nextRunAt: nextOccurrence({ kind: "interval", everyMs, anchorAt: now }, now)
    };
  }
  if (
    current.kind === "interval" &&
    (hasOwn(input, "cronExpr") || explicitKind === "cron" || explicitKind === "one_shot" || recurring !== undefined)
  ) {
    throw new SchedulerToolError(
      "INVALID_PARAMS",
      "Clear intervalMs with null when switching an interval schedule to cron or one-shot recurrence."
    );
  }
  if (explicitKind === "interval") {
    if (current.kind !== "interval") {
      throw new SchedulerToolError("INVALID_PARAMS", "intervalMs is required when switching to interval recurrence.");
    }
    return storedTiming(current, timezone);
  }

  if (hasOwn(input, "runAt") || explicitKind === "one_shot") {
    let runAt: number;
    if (hasOwn(input, "runAt")) {
      runAt = requiredInteger(input["runAt"], "runAt", 0, Number.MAX_SAFE_INTEGER);
    } else {
      const expression = optionalText(input["cronExpr"], "cronExpr", 256) ?? current.expression;
      if (expression === undefined) {
        throw new SchedulerToolError("INVALID_PARAMS", "runAt or cronExpr is required for one-shot recurrence.");
      }
      runAt = cronOccurrence(expression, timezone, now - 1);
    }
    if (runAt <= now) throw new SchedulerToolError("INVALID_PARAMS", "runAt must be in the future.");
    return {
      kind: "one_shot",
      ...(optionalText(input["cronExpr"], "cronExpr", 256) ?? current.expression) === undefined
        ? {}
        : { expression: optionalText(input["cronExpr"], "cronExpr", 256) ?? current.expression },
      timezone,
      nextRunAt: runAt
    };
  }

  const desiredCron = explicitKind === "cron" || recurring !== undefined || hasOwn(input, "cronExpr") || current.kind === "cron";
  if (desiredCron) {
    const expression = optionalText(input["cronExpr"], "cronExpr", 256)
      ?? (current.kind === "cron" || current.kind === "one_shot" ? current.expression : undefined);
    if (expression === undefined) {
      throw new SchedulerToolError("INVALID_PARAMS", "cronExpr is required for cron recurrence.");
    }
    const nextRunAt = cronOccurrence(expression, timezone, now - 1);
    return recurring === false
      ? { kind: "one_shot", expression, timezone, nextRunAt }
      : { kind: "cron", expression, timezone, nextRunAt };
  }
  if (manual === false && current.kind === "manual") {
    throw new SchedulerToolError("INVALID_PARAMS", "A recurrence is required when leaving manual mode.");
  }
  return storedTiming(current, timezone);
}

function storedTiming(schedule: ScheduleRecord, timezone = schedule.timezone): StoredTiming {
  return {
    kind: schedule.kind,
    ...(schedule.expression === undefined ? {} : { expression: schedule.expression }),
    ...(schedule.anchorAt === undefined ? {} : { anchorAt: schedule.anchorAt }),
    timezone,
    ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt })
  };
}

function resumedOccurrence(schedule: ScheduleRecord, now: number): number | undefined {
  switch (schedule.kind) {
    case "manual": return undefined;
    case "one_shot": {
      if (schedule.nextRunAt !== undefined && schedule.nextRunAt > now) return schedule.nextRunAt;
      return schedule.expression === undefined
        ? undefined
        : cronOccurrence(schedule.expression, schedule.timezone, now);
    }
    case "interval": {
      const everyMs = Number(schedule.expression);
      if (!Number.isSafeInteger(everyMs) || everyMs < 1_000 || schedule.anchorAt === undefined) {
        throw new SchedulerToolError("INVALID_STATE", "Stored interval recurrence is invalid.");
      }
      return nextOccurrence({ kind: "interval", everyMs, anchorAt: schedule.anchorAt }, now);
    }
    case "cron": {
      if (schedule.expression === undefined) {
        throw new SchedulerToolError("INVALID_STATE", "Stored cron recurrence is invalid.");
      }
      return cronOccurrence(schedule.expression, schedule.timezone, now);
    }
  }
}

function nextCron(input: Readonly<Record<string, unknown>>, timezone: string, after: number): number {
  return cronOccurrence(requiredText(input, "cronExpr", 256), timezone, after);
}

function cronOccurrence(expression: string, timezone: string, after: number): number {
  try {
    const next = nextOccurrence({ kind: "cron", expression, timezone }, after);
    if (next === undefined) throw new Error("No future occurrence.");
    return next;
  } catch {
    throw new SchedulerToolError("INVALID_PARAMS", "cronExpr or timezone is invalid.");
  }
}

function rejectTimingFields(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  for (const key of ["cronExpr", "intervalMs", "runAt", "recurring"]) {
    if (hasOwn(input, key) && !allowed.includes(key)) {
      throw new SchedulerToolError("INVALID_PARAMS", `Manual schedules cannot use ${key}.`);
    }
  }
}

function sessionBinding(
  input: Readonly<Record<string, unknown>>,
  caller: SessionDescriptor,
  store: OperationalStore,
  current?: ScheduleRecord
): { readonly mode: ScheduleRecord["sessionMode"]; readonly sessionId?: string } {
  const bindCurrent = optionalBoolean(input["bindToCurrentSession"], "bindToCurrentSession") ?? false;
  if (
    current !== undefined && !bindCurrent &&
    !hasOwn(input, "targetSessionId") && !hasOwn(input, "persistentSession")
  ) {
    return {
      mode: current.sessionMode,
      ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId })
    };
  }
  if (bindCurrent && hasOwn(input, "targetSessionId")) {
    throw new SchedulerToolError("INVALID_PARAMS", "bindToCurrentSession and targetSessionId cannot be combined.");
  }
  const explicitSession = hasOwn(input, "targetSessionId")
    ? nullableId(input["targetSessionId"], "targetSessionId")
    : undefined;
  const persistent = optionalBoolean(input["persistentSession"], "persistentSession")
    ?? (current?.sessionMode === "persistent");
  const sessionId = bindCurrent ? caller.id : explicitSession;
  if (sessionId !== undefined) {
    const bound = store.getSession(sessionId).descriptor;
    if (
      bound.targetId !== caller.targetId ||
      bound.backendId !== caller.backendId ||
      bound.deletedAt !== undefined ||
      bound.archived
    ) {
      throw new SchedulerToolError("INVALID_PARAMS", "Bound task is unavailable or outside this workspace.");
    }
    return { mode: "bound", sessionId };
  }
  return persistent ? { mode: "persistent" } : { mode: "fresh" };
}

function executionInput(
  input: Readonly<Record<string, unknown>>,
  caller: SessionDescriptor,
  previous?: unknown
): Readonly<Record<string, unknown>> {
  const prior = isRecord(previous) ? previous : {};
  const providerId = hasOwn(input, "providerId")
    ? optionalText(input["providerId"], "providerId", 256)
    : optionalRecordText(prior, "providerId") ?? caller.providerId;
  const modelId = hasOwn(input, "model")
    ? optionalText(input["model"], "model", 256)
    : optionalRecordText(prior, "modelId") ?? caller.modelId;
  if ((providerId === undefined) !== (modelId === undefined)) {
    throw new SchedulerToolError("INVALID_PARAMS", "providerId and model must be supplied together.");
  }
  const effort = hasOwn(input, "effort")
    ? optionalText(input["effort"], "effort", 64)
    : optionalRecordText(prior, "effort") ?? caller.effort;
  const fastMode = hasOwn(input, "fastMode")
    ? optionalBoolean(input["fastMode"], "fastMode") ?? false
    : typeof prior["fastMode"] === "boolean" ? prior["fastMode"] : caller.fastMode;
  const permissionMode = hasOwn(input, "permissionMode")
    ? permissionModeValue(input["permissionMode"])
    : permissionModeValue(prior["permissionMode"] ?? caller.permissionMode);
  const planMode = hasOwn(input, "planMode")
    ? optionalBoolean(input["planMode"], "planMode") ?? false
    : typeof prior["planMode"] === "boolean" ? prior["planMode"] : caller.planMode;
  const worktree = previous === undefined
    ? defaultScheduleWorktreeConfiguration()
    : scheduleWorktreeConfiguration(previous);
  return {
    ...(providerId === undefined ? {} : { providerId, modelId }),
    ...(effort === undefined ? {} : { effort }),
    fastMode,
    permissionMode,
    planMode,
    useWorktree: worktree.useWorktree,
    ...(worktree.sourceRef === undefined ? {} : { worktreeSourceRef: worktree.sourceRef }),
    refreshWorktreeRemote: worktree.refreshRemote
  };
}

async function scheduleExecutionInput(
  input: Readonly<Record<string, unknown>>,
  caller: SessionDescriptor,
  store: OperationalStore,
  previous?: unknown
): Promise<Readonly<Record<string, unknown>>> {
  const base = executionInput(input, caller, previous);
  const current = previous === undefined
    ? defaultScheduleExtensionSnapshot()
    : safeScheduleExtensions(previous);
  const silentWhenIdle = hasOwn(input, "silentWhenIdle")
    ? optionalBoolean(input["silentWhenIdle"], "silentWhenIdle") ?? false
    : current.silentWhenIdle;
  const notify = hasOwn(input, "notify")
    ? notificationInput(input["notify"])
    : current.notify;
  const expireAt = hasOwn(input, "expireAt")
    ? input["expireAt"] === null
      ? undefined
      : requiredInteger(input["expireAt"], "expireAt", 0, Number.MAX_SAFE_INTEGER)
    : current.expireAt;
  let preRunHook = current.preRunHook;
  if (hasOwn(input, "preRunHook")) {
    if (input["preRunHook"] === null) {
      preRunHook = undefined;
    } else {
      const requested = preRunHookInput(input["preRunHook"]);
      const target = store.getTarget(caller.targetId).descriptor;
      try {
        const filePath = await validateScheduleHookScriptBinding({
          workspaceRoot: target.workspaceRoot,
          filePath: requested.filePath,
          command: requested.command
        });
        preRunHook = { ...requested, filePath };
      } catch {
        throw new SchedulerToolError(
          "PATH_NOT_ALLOWED",
          "preRunHook must reference a managed script in the authenticated workspace."
        );
      }
    }
  }
  const executionMode = hasOwn(input, "executionMode")
    ? scheduleExecutionMode(input["executionMode"])
    : current.executionMode;
  let scriptConfig = current.scriptConfig;
  if (hasOwn(input, "scriptConfig")) {
    scriptConfig = input["scriptConfig"] === null
      ? undefined
      : scriptExecutionConfiguration(input["scriptConfig"]);
  } else if (hasOwn(input, "executionMode") && executionMode === "agent") {
    scriptConfig = undefined;
  }
  return withScheduleExtensionSnapshot(base, {
    format: 1,
    silentWhenIdle,
    notify,
    executionMode,
    ...(scriptConfig === undefined ? {} : { scriptConfig }),
    ...(expireAt === undefined ? {} : { expireAt }),
    ...(preRunHook === undefined ? {} : { preRunHook })
  });
}

function notificationInput(value: unknown): ScheduleExtensionSnapshot["notify"] {
  if (!isRecord(value)) throw new SchedulerToolError("INVALID_ARGS", "notify must be an object.");
  assertKeys(value, ["desktop"]);
  return { desktop: optionalBoolean(value["desktop"], "notify.desktop") ?? true };
}

function preRunHookInput(value: unknown): SchedulePreRunHookConfiguration {
  if (!isRecord(value)) throw new SchedulerToolError("INVALID_ARGS", "preRunHook must be an object or null.");
  assertKeys(value, ["command", "filePath", "timeoutMs"]);
  return {
    command: requiredText(value, "command", 32_768),
    filePath: requiredText(value, "filePath", 4_096),
    ...(value["timeoutMs"] === undefined
      ? {}
      : { timeoutMs: requiredInteger(value["timeoutMs"], "preRunHook.timeoutMs", 1, Number.MAX_SAFE_INTEGER) })
  };
}

function scheduleExecutionMode(value: unknown): ScheduleExtensionSnapshot["executionMode"] {
  if (value === "agent" || value === "script") return value;
  throw new SchedulerToolError("INVALID_ARGS", "executionMode must be agent or script.");
}

function scriptExecutionConfiguration(value: unknown): ScheduleScriptExecutionConfiguration {
  if (!isRecord(value)) throw new SchedulerToolError("INVALID_ARGS", "scriptConfig must be an object or null.");
  assertKeys(value, ["command", "timeoutMs", "capabilities"]);
  const command = requiredText(value, "command", 32_768);
  if (redactSecrets(command) !== command) {
    throw new SchedulerToolError("INVALID_ARGS", "scriptConfig.command cannot contain credential material.");
  }
  const capabilities = value["capabilities"];
  if (!Array.isArray(capabilities) || capabilities.some((item) => item !== "sessions.dispatch")) {
    throw new SchedulerToolError("INVALID_ARGS", "scriptConfig.capabilities contains an unsupported capability.");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new SchedulerToolError("INVALID_ARGS", "scriptConfig.capabilities cannot contain duplicates.");
  }
  return {
    command,
    capabilities: capabilities as readonly "sessions.dispatch"[],
    ...(value["timeoutMs"] === undefined
      ? {}
      : { timeoutMs: requiredInteger(value["timeoutMs"], "scriptConfig.timeoutMs", 1, Number.MAX_SAFE_INTEGER) })
  };
}

function assertExecutionCompatibility(
  extension: ScheduleExtensionSnapshot,
  worktree: ReturnType<typeof scheduleWorktreeConfiguration>,
  binding: { readonly mode: ScheduleRecord["sessionMode"]; readonly sessionId?: string },
  prompt: PromptInput
): void {
  if (worktree.useWorktree && (
    extension.executionMode !== "agent" || binding.mode !== "fresh" || binding.sessionId !== undefined
  )) {
    throw new SchedulerToolError(
      "INVALID_PARAMS",
      "Isolated workspace schedules require agent execution with a fresh task for every run."
    );
  }
  if (extension.executionMode === "agent") {
    if (prompt.text.trim() === "") {
      throw new SchedulerToolError("INVALID_PARAMS", "Agent schedules require a non-empty prompt.");
    }
    return;
  }
  if (binding.mode !== "fresh" || binding.sessionId !== undefined) {
    throw new SchedulerToolError("INVALID_PARAMS", "Script schedules cannot bind or persist a product task.");
  }
  if (extension.silentWhenIdle) {
    throw new SchedulerToolError("INVALID_PARAMS", "Script schedules cannot use silentWhenIdle.");
  }
}

function safeScheduleExtensions(value: unknown): ScheduleExtensionSnapshot {
  try {
    return scheduleExtensionSnapshot(value);
  } catch {
    throw new SchedulerToolError("INVALID_STATE", "Stored schedule extensions are invalid.");
  }
}

function resolveComparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en") : normalized;
}

function copySchedule(
  schedule: ScheduleRecord,
  patch: {
    readonly enabled: boolean;
    readonly nextRunAt?: number;
    readonly expectedRevision: bigint;
    readonly now: number;
  }
): UpsertScheduleInput {
  return {
    id: schedule.id,
    backendId: schedule.backendId,
    targetId: schedule.targetId,
    sessionMode: schedule.sessionMode,
    ...(schedule.sessionId === undefined ? {} : { sessionId: schedule.sessionId }),
    name: schedule.name,
    kind: schedule.kind,
    ...(schedule.expression === undefined ? {} : { expression: schedule.expression }),
    ...(schedule.anchorAt === undefined ? {} : { anchorAt: schedule.anchorAt }),
    timezone: schedule.timezone,
    enabled: patch.enabled,
    prompt: schedule.prompt,
    executionSnapshot: schedule.executionSnapshot,
    overlapPolicy: schedule.overlapPolicy,
    misfirePolicy: schedule.misfirePolicy,
    ...(patch.nextRunAt === undefined ? {} : { nextRunAt: patch.nextRunAt }),
    ...(schedule.lastRunAt === undefined ? {} : { lastRunAt: schedule.lastRunAt }),
    expectedRevision: patch.expectedRevision,
    now: patch.now
  };
}

function copyScheduleExecution(
  schedule: ScheduleRecord,
  executionSnapshot: unknown,
  expectedRevision: bigint,
  now: number
): UpsertScheduleInput {
  return {
    ...copySchedule(schedule, {
      enabled: schedule.enabled,
      ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt }),
      expectedRevision,
      now
    }),
    executionSnapshot
  };
}

function publicSchedule(schedule: ScheduleRecord): Readonly<Record<string, unknown>> {
  const execution = isRecord(schedule.executionSnapshot) ? schedule.executionSnapshot : {};
  const extension = safeScheduleExtensions(schedule.executionSnapshot);
  const worktree = scheduleWorktreeConfiguration(schedule.executionSnapshot);
  return {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt.text,
    kind: schedule.kind,
    status: schedule.enabled
      ? "active"
      : schedule.kind === "one_shot" && schedule.nextRunAt === undefined
        ? "expired"
        : "paused",
    ...(schedule.kind === "cron" || (schedule.kind === "one_shot" && schedule.expression !== undefined)
      ? { cronExpr: schedule.expression }
      : {}),
    ...(schedule.kind === "interval" ? { intervalMs: Number(schedule.expression) } : {}),
    ...(schedule.kind === "one_shot" ? { runAt: schedule.nextRunAt } : {}),
    timezone: schedule.timezone,
    recurring: schedule.kind === "cron" || schedule.kind === "interval",
    manual: schedule.kind === "manual",
    agentKind: schedule.backendId,
    ...(typeof execution["providerId"] === "string" ? { providerId: execution["providerId"] } : {}),
    ...(typeof execution["modelId"] === "string" ? { model: execution["modelId"] } : {}),
    ...(typeof execution["effort"] === "string" ? { effort: execution["effort"] } : {}),
    fastMode: execution["fastMode"] === true,
    permissionMode: publicPermissionMode(execution["permissionMode"]),
    planMode: execution["planMode"] === true,
    useWorktree: worktree.useWorktree,
    ...(worktree.sourceRef === undefined ? {} : { worktreeSourceRef: worktree.sourceRef }),
    refreshWorktreeRemote: worktree.refreshRemote,
    executionMode: extension.executionMode,
    ...(extension.scriptConfig === undefined ? {} : {
      scriptConfig: {
        command: extension.scriptConfig.command,
        capabilities: [...extension.scriptConfig.capabilities],
        ...(extension.scriptConfig.timeoutMs === undefined ? {} : { timeoutMs: extension.scriptConfig.timeoutMs })
      }
    }),
    ...(schedule.sessionId === undefined ? {} : { targetSessionId: schedule.sessionId }),
    persistentSession: schedule.sessionMode === "persistent",
    enabled: schedule.enabled,
    overlapPolicy: schedule.overlapPolicy,
    misfirePolicy: schedule.misfirePolicy,
    silentWhenIdle: extension.silentWhenIdle,
    notify: { desktop: extension.notify.desktop },
    ...(extension.expireAt === undefined ? {} : { expireAt: extension.expireAt }),
    ...(extension.preRunHook === undefined ? {} : {
      preRunHook: {
        command: extension.preRunHook.command,
        filePath: extension.preRunHook.filePath,
        ...(extension.preRunHook.timeoutMs === undefined ? {} : { timeoutMs: extension.preRunHook.timeoutMs })
      }
    }),
    ...(schedule.nextRunAt === undefined ? {} : { nextFireAt: schedule.nextRunAt }),
    ...(schedule.lastRunAt === undefined ? {} : { lastFiredAt: schedule.lastRunAt }),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    revision: schedule.revision.toString(10)
  };
}

function publicScheduleRun(run: ScheduleRunRecord): Readonly<Record<string, unknown>> {
  const detail = isRecord(run.detail) ? run.detail : {};
  return {
    id: run.id.toString(10),
    scheduleId: run.scheduleId,
    runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    firedAt: run.firedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    status: run.status,
    ...(isRecord(detail["preRunHook"]) ? { preRunHookResult: { ...detail["preRunHook"] } } : {}),
    ...(isRecord(detail["script"]) ? { scriptResult: { ...detail["script"] } } : {}),
    ...(typeof detail["costAttribution"] === "string" ? { costAttribution: detail["costAttribution"] } : {}),
    revision: run.revision.toString(10)
  };
}

function promptInput(text: string): PromptInput {
  return { text, images: [], files: [], mentions: [], disposition: "prompt" };
}

function overlapPolicy(value: unknown): ScheduleRecord["overlapPolicy"] {
  if (value === undefined || value === "queue") return "queue";
  if (value === "skip") return "skip";
  throw new SchedulerToolError("INVALID_ARGS", "overlapPolicy must be queue or skip.");
}

function misfirePolicy(value: unknown): ScheduleRecord["misfirePolicy"] {
  if (value === undefined || value === "run_once") return "run_once";
  if (value === "skip") return "skip";
  throw new SchedulerToolError("INVALID_ARGS", "misfirePolicy must be run_once or skip.");
}

function permissionModeValue(value: unknown): PermissionMode {
  if (value === "auto" || value === "bypassPermissions") return value;
  if (value === undefined || value === "ask") return "ask";
  throw new SchedulerToolError("INVALID_ARGS", "permissionMode is invalid.");
}

function publicPermissionMode(value: unknown): PermissionMode {
  return value === "auto" || value === "bypassPermissions" ? value : "ask";
}

function validateAgentKind(value: unknown, backendId: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "" || value.length > 256 || value.includes("\0")) {
    throw new SchedulerToolError("INVALID_ARGS", "agentKind is invalid.");
  }
  if (value !== backendId) {
    throw new SchedulerToolError("INVALID_ARGS", "agentKind must match the authenticated calling task Backend.");
  }
}

function timingKind(value: unknown): ScheduleRecord["kind"] | undefined {
  if (value === undefined) return undefined;
  if (value === "cron" || value === "interval" || value === "one_shot" || value === "manual") return value;
  throw new SchedulerToolError("INVALID_ARGS", "kind is invalid.");
}

function validateTimezone(value: string, at: number): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(at));
  } catch {
    throw new SchedulerToolError("INVALID_PARAMS", "timezone must be a valid IANA identifier.");
  }
}

function requiredId(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = requiredText(input, key, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new SchedulerToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  return value;
}

function nullableId(value: unknown, key: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredId({ [key]: value }, key);
}

function requiredText(input: Readonly<Record<string, unknown>>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new SchedulerToolError("INVALID_ARGS", `${key} is required and must be at most ${maximum} characters.`);
  }
  return value;
}

function optionalText(value: unknown, key: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new SchedulerToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  return value;
}

function optionalRecordText(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SchedulerToolError("INVALID_ARGS", `${key} must be a boolean.`);
  return value;
}

function requiredInteger(value: unknown, key: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SchedulerToolError("INVALID_ARGS", `${key} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function optionalInteger(value: unknown, key: string, minimum: number, maximum: number): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, key, minimum, maximum);
}

function optionalRevision(value: unknown): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,32}$/u.test(value)) return BigInt(value);
  throw new SchedulerToolError("INVALID_ARGS", "expectedRevision is invalid.");
}

function assertKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) throw new SchedulerToolError("INVALID_ARGS", `Unexpected argument: ${unexpected}.`);
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasAny(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.some((key) => hasOwn(value, key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function tool(
  name: typeof SCHEDULER_TOOL_NAMES[number],
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return {
    serverId: SCHEDULER_TOOL_PROVIDER_ID,
    name,
    runtimeName: name,
    description,
    inputSchema,
    requiresPermission
  };
}

function objectSchema(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

function toolResult(data: unknown): McpCallResult {
  const envelope = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: false
  };
}

function toolFailure(error: unknown): McpCallResult {
  const classified = classifyToolError(error);
  const envelope = { ok: false, errorCode: classified.code, message: classified.message };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true
  };
}

function classifyToolError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SchedulerToolError) return { code: error.code, message: error.message };
  if (error instanceof NotFoundError) return { code: "NOT_FOUND", message: "Referenced task or schedule does not exist." };
  if (error instanceof RevisionConflictError) return { code: "CONFLICT", message: "Schedule changed concurrently; read it again and retry." };
  return { code: "INTERNAL", message: "Scheduler operation failed." };
}

function listAllScheduleRuns(
  store: OperationalStore,
  scheduleId: string
): ReturnType<OperationalStore["listScheduleRuns"]> {
  const runs: ReturnType<OperationalStore["listScheduleRuns"]> = [];
  for (;;) {
    const page = store.listScheduleRuns(scheduleId, 10_000, runs.length);
    runs.push(...page);
    if (page.length < 10_000) return runs;
  }
}

class SchedulerToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SchedulerToolError";
  }
}
