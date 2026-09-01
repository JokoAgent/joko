import { createHash } from "node:crypto";

import { redactSecrets, type PermissionMode, type PromptInput, type SessionDescriptor } from "@joko/core";
import type { OperationalStore, ScheduleRecord } from "@joko/store";

import type {
  ScheduleScriptCapability,
  ScheduleScriptCapabilityBroker,
  ScheduleScriptCapabilityCall
} from "./schedule-script-runner.js";
import type { SessionHost } from "./session-host.js";

const METHOD_CATALOG = [
  {
    method: "host.capabilities",
    capability: null,
    params: "{}",
    description: "Describe the protocol, granted capabilities, and callable methods."
  },
  {
    method: "sessions.dispatch",
    capability: "sessions.dispatch" as const,
    params: "{message,title?,target_session_id?}",
    description: "Create or wake a task in this Schedule workspace and queue one message."
  }
] as const;

export class ScheduleScriptCapabilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(redactSecrets(message).slice(0, 2_048));
    this.name = "ScheduleScriptCapabilityError";
  }
}

/** Default-deny host broker for Scheduler scripts. Every side effect receives
 * a deterministic operation ID and is committed to the durable queue before
 * SessionHost starts adapter dispatch. */
export class HostScheduleScriptCapabilityBroker implements ScheduleScriptCapabilityBroker {
  constructor(
    private readonly store: OperationalStore,
    private readonly host: SessionHost
  ) {}

  async call(
    request: ScheduleScriptCapabilityCall,
    granted: ReadonlySet<ScheduleScriptCapability>,
    context: { readonly scheduleId: string; readonly runId: string }
  ): Promise<unknown> {
    if (request.method === "host.capabilities") {
      assertOnlyKeys(request.params, []);
      return {
        protocol: "joko-schedule-script/1",
        granted: [...granted].sort(),
        methods: METHOD_CATALOG.map((entry) => ({
          ...entry,
          available: entry.capability === null || granted.has(entry.capability)
        }))
      };
    }
    if (request.method !== "sessions.dispatch") {
      throw new ScheduleScriptCapabilityError(
        "METHOD_NOT_FOUND",
        `Script capability method is unavailable: ${request.method}`
      );
    }
    requireCapability(granted, "sessions.dispatch");
    assertOnlyKeys(request.params, ["message", "title", "target_session_id"]);

    const schedule = this.requireScriptSchedule(context.scheduleId);
    const message = requiredSafeText(request.params["message"], "message", 262_144);
    const title = request.params["title"] === undefined
      ? schedule.name
      : requiredSafeText(request.params["title"], "title", 256);
    const requestedSessionId = request.params["target_session_id"] === undefined
      ? undefined
      : requiredText(request.params["target_session_id"], "target_session_id", 256);
    const operationId = capabilityOperationId(context.runId, request.id);
    const sessionId = requestedSessionId === undefined
      ? await this.createSession(schedule, title, operationId, context.runId)
      : this.requireTargetSession(schedule, requestedSessionId);
    const sent = this.host.enqueueServiceInput({
      operationId: `${operationId}-send`,
      sessionId,
      prompt: promptInput(message),
      source: "schedule"
    });
    return {
      target_session_id: sessionId,
      run_id: sent.value.runId,
      wake_kind: requestedSessionId === undefined ? "created" : "resumed",
      target_title: this.store.getSession(sessionId).descriptor.title
    };
  }

  private requireScriptSchedule(scheduleId: string): ScheduleRecord {
    const schedule = this.store.findSchedule(scheduleId);
    if (schedule === undefined) {
      throw new ScheduleScriptCapabilityError("NOT_FOUND", "Schedule no longer exists.");
    }
    const target = this.store.getTarget(schedule.targetId).descriptor;
    if (!target.trusted) {
      throw new ScheduleScriptCapabilityError("UNTRUSTED_TARGET", "Schedule workspace is not trusted.");
    }
    return schedule;
  }

  private async createSession(
    schedule: ScheduleRecord,
    title: string,
    operationId: string,
    runId: string
  ): Promise<string> {
    const execution = scheduleCreationSnapshot(schedule.executionSnapshot);
    try {
      const created = await this.host.createScheduledSession({
        operationId: `${operationId}-session`,
        targetId: schedule.targetId,
        title,
        automationOrigin: { scheduleId: schedule.id, scheduleName: schedule.name, runId, scheduleRevision: schedule.revision },
        ...(execution.providerId === undefined ? {} : { providerId: execution.providerId }),
        ...(execution.modelId === undefined ? {} : { modelId: execution.modelId }),
        ...(execution.effort === undefined ? {} : { effort: execution.effort }),
        fastMode: execution.fastMode,
        permissionMode: execution.permissionMode,
        planMode: execution.planMode
      });
      return created.value.sessionId;
    } catch (error) {
      throw new ScheduleScriptCapabilityError(
        "DISPATCH_FAILED",
        error instanceof Error ? error.message : "Task creation failed."
      );
    }
  }

  private requireTargetSession(schedule: ScheduleRecord, sessionId: string): string {
    let session: SessionDescriptor | undefined;
    try {
      session = this.store.getSession(sessionId).descriptor;
    } catch {
      session = undefined;
    }
    if (
      session === undefined || session.deletedAt !== undefined || session.archived ||
      session.backendId !== schedule.backendId || session.targetId !== schedule.targetId
    ) {
      throw new ScheduleScriptCapabilityError(
        "INVALID_ARGS",
        "target_session_id is unavailable or outside the Schedule workspace."
      );
    }
    return session.id;
  }
}

function capabilityOperationId(runId: string, callId: string): string {
  const digest = createHash("sha256").update(`${runId}\0${callId}`).digest("hex").slice(0, 32);
  return `schedule-script-call-${digest}`;
}

function requireCapability(
  granted: ReadonlySet<ScheduleScriptCapability>,
  capability: ScheduleScriptCapability
): void {
  if (!granted.has(capability)) {
    throw new ScheduleScriptCapabilityError("CAPABILITY_DENIED", `Capability not granted: ${capability}`);
  }
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const rejected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (rejected !== undefined) {
    throw new ScheduleScriptCapabilityError("INVALID_ARGS", `Unsupported parameter: ${rejected}`);
  }
}

function requiredSafeText(value: unknown, field: string, maximum: number): string {
  const text = requiredText(value, field, maximum);
  if (redactSecrets(text) !== text) {
    throw new ScheduleScriptCapabilityError("INVALID_ARGS", `${field} cannot contain credential material.`);
  }
  return text;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new ScheduleScriptCapabilityError("INVALID_ARGS", `${field} is required and must be at most ${maximum} characters.`);
  }
  return value;
}

function promptInput(text: string): PromptInput {
  return { text, images: [], files: [], mentions: [], disposition: "prompt" };
}

function scheduleCreationSnapshot(value: unknown): {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
} {
  const record = isRecord(value) ? value : {};
  const providerId = nonBlankString(record["providerId"]);
  const modelId = nonBlankString(record["modelId"]);
  const effort = nonBlankString(record["effort"]);
  const permissionMode = record["permissionMode"] === "auto" || record["permissionMode"] === "bypassPermissions"
    ? record["permissionMode"]
    : "ask";
  return {
    ...((providerId === undefined || modelId === undefined) ? {} : { providerId, modelId }),
    ...(effort === undefined ? {} : { effort }),
    fastMode: record["fastMode"] === true,
    permissionMode,
    planMode: record["planMode"] === true
  };
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
