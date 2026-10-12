import { Code, ConnectError } from "@connectrpc/connect";
import type { Routine } from "@joko/core";
import type { BridgeToolCallContext, BridgeToolProvider, McpToolDescriptor } from "./mcp-router.js";
import { parseRoutineInput } from "./partner-routine-definition.js";
import type { PartnerRoutineManager } from "./partner-routine-manager.js";
import type { PartnerProfileTools } from "./partner-profile-tools.js";
import type { ScheduleHookScriptInstaller } from "./schedule-hook-script-installer.js";
import { durableSchedulePreRunHookResult } from "./schedule-pre-run-hook.js";
import type { ScheduleRunNotificationController } from "./schedule-run-notifications.js";

const providerId = "joko_partner_routines";
const id = { type: "string", minLength: 1, maxLength: 128 };
const revision = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const timestamp = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", additionalProperties: false, properties, required };
}
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], write = false): McpToolDescriptor {
  return { serverId: providerId, name, description, inputSchema: object(properties, required), requiresPermission: write };
}
const triggerSchema = { oneOf: [
  object({ id, kind: { const: "cron" }, expression: { type: "string", minLength: 1, maxLength: 128 },
    timezone: { type: "string", minLength: 1, maxLength: 128 } }, ["id", "kind", "expression", "timezone"]),
  object({ id, kind: { const: "interval" }, intervalMs: { type: "integer", minimum: 60_000, maximum: Number.MAX_SAFE_INTEGER },
    anchorMs: timestamp }, ["id", "kind", "intervalMs"]),
  object({ id, kind: { const: "once" }, at: timestamp }, ["id", "kind", "at"]),
  object({ id, kind: { const: "event" }, sourceId: { type: "string", minLength: 1, maxLength: 200 },
    eventType: { type: "string", minLength: 1, maxLength: 200 }, filters: { type: "array", maxItems: 16,
      items: object({ field: { type: "string", minLength: 1, maxLength: 128 },
        operator: { enum: ["equals", "contains", "not-equals"] }, value: { type: "string", minLength: 1, maxLength: 2000 } }, ["field", "operator", "value"]) }
  }, ["id", "kind", "sourceId", "eventType", "filters"])
] };

/** Direct routine tools use the same definitions, receipts and execution lane as the UI. */
export class PartnerRoutineTools implements BridgeToolProvider {
  readonly canonicalPartnerOnly = true;
  readonly id = providerId;
  readonly generation = 1;
  readonly available = true;
  readonly tools = [
    tool("routine_list", "List your own persistent routines, their revisions and current activity. Read before creating to avoid duplicates and after saving to confirm the stored definition.", {}),
    tool("routine_sources", "List local event sources, event types, filter fields and listening status. Read before saving event triggers; never guess source ids or publish events through these tools.", {}),
    tool("routine_save", "Create or fully update your own routine only when the user requests recurring work, reminders or event-triggered automation. Multiple triggers are OR. Read routine_list first; updates require its expectedRevision. Preserve trigger ids and interval anchors. Omitted silentWhenIdle and preRunHook preserve existing choices; null removes the hook. New checks may use silentWhenIdle=true and notify only when actionable. Confirm by reading routine_list; on an unknown result read before an explicit new intent.", {
      id, expectedRevision: revision, name: { type: "string", minLength: 1, maxLength: 200 },
      prompt: { type: "string", minLength: 1, maxLength: 100_000 }, enabled: { type: "boolean" }, silentWhenIdle: { type: "boolean" },
      preRunHook: { anyOf: [{ type: "null" }, object({ command: { type: "string", minLength: 1, maxLength: 32_000 },
        timeoutMs: revision }, ["command"])] }, triggers: { type: "array", minItems: 1, maxItems: 32, items: triggerSchema }
    }, ["name", "prompt", "enabled", "triggers"], true),
    tool("routine_history", "Read the unified trigger and execution history of one of your routines, including results and failures. Continue using nextOffset when present.", {
      id, offset: timestamp
    }, ["id"]),
    tool("routine_delete", "Delete one of your routines when requested, cancelling queued and active execution. Read its expectedRevision from routine_list. To pause instead, save the full definition with enabled=false.", {
      id, expectedRevision: revision
    }, ["id", "expectedRevision"], true),
    tool("routine_run_now", "Run one of your saved routines once when requested. Read expectedRevision from routine_list. The stable tool effect queues at most once; read routine_history before an explicit retry after an unknown result.", {
      id, expectedRevision: revision
    }, ["id", "expectedRevision"], true),
    tool("schedule_set_pre_run_hook", "Install and immediately test a Node ESM pre-run check in your canonical home only when authorized. Exit 0 wakes the model with stdout; exit 2 skips; errors and timeouts fail visibly. Attach the returned command with routine_save.preRunHook and verify with routine_list. This tool only installs the script.", {
      script: { type: "string", minLength: 1, maxLength: 262_144 }, description: { type: "string", minLength: 1, maxLength: 16_384 },
      scheduleName: { type: "string", minLength: 1, maxLength: 256 }
    }, [], true),
    tool("schedule_notify_current_run", "Request a final report from the current silent automation run when there is a new actionable result or an explicit reminder. The current task determines the run.", {}, [], false)
  ];

  constructor(readonly routines: PartnerRoutineManager, readonly profiles: PartnerProfileTools,
    readonly hookScripts: ScheduleHookScriptInstaller, readonly notifications: ScheduleRunNotificationController) {}
  includeForTarget(targetId: string) { return this.profiles.includeForTarget(targetId); }

  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    try {
      const caller = this.profiles.currentCaller(context, signal);
      const assertCaller = () => caller.assertCurrent();
      const partnerId = caller.profile.id, partnerRevision = caller.profile.revision;
      let result: unknown;
      switch (name) {
        case "routine_list":
          keys(input, []); result = this.routines.list(partnerId); break;
        case "routine_sources":
          keys(input, []); result = this.routines.sources(partnerId); break;
        case "routine_history":
          keys(input, ["id", "offset"]);
          result = this.routines.history(partnerId, identity(input["id"]), input["offset"] === undefined ? 0 : integer(input["offset"], 0)); break;
        case "routine_save": {
          keys(input, ["id", "expectedRevision", "name", "prompt", "enabled", "silentWhenIdle", "preRunHook", "triggers"]);
          const routineId = input["id"] === undefined ? undefined : identity(input["id"]);
          const previous = routineId === undefined ? undefined : this.routines.list(partnerId).find(routine => routine.id === routineId);
          if (routineId !== undefined && previous === undefined) throw new ConnectError("Routine is unavailable for this Partner.", Code.NotFound);
          if (routineId === undefined && input["expectedRevision"] !== undefined) invalid();
          result = await this.routines.save({ partnerId, partnerRevision, definition: definition(input, previous), assertCaller,
            ...(routineId === undefined ? { requestId: effect(context) } : { routineId, revision: integer(input["expectedRevision"], 1) }) });
          break;
        }
        case "routine_run_now": {
          keys(input, ["id", "expectedRevision"]); const routineId = identity(input["id"]), requestId = effect(context);
          await this.routines.run({ partnerId, partnerRevision, routineId, revision: integer(input["expectedRevision"], 1), requestId, assertCaller });
          result = { accepted: true, routineId, runId: this.routines.creationId(partnerId, requestId) }; break;
        }
        case "routine_delete": {
          keys(input, ["id", "expectedRevision"]); const routineId = identity(input["id"]);
          await this.routines.remove({ partnerId, partnerRevision, routineId, revision: integer(input["expectedRevision"], 1), assertCaller });
          result = { id: routineId, deleted: true }; break;
        }
        case "schedule_set_pre_run_hook": {
          keys(input, ["script", "description", "scheduleName"]);
          const installed = await this.hookScripts.install({ backendId: caller.session.backendId,
            workspaceRoot: caller.target.descriptor.workspaceRoot, assertCurrent: assertCaller,
            ...(input["script"] === undefined ? {} : { script: text(input["script"], 262_144) }),
            ...(input["description"] === undefined ? {} : { description: text(input["description"], 16_384) }),
            ...(input["scheduleName"] === undefined ? {} : { scheduleName: text(input["scheduleName"], 256) }),
            ...(caller.session.providerId === undefined ? {} : { providerId: caller.session.providerId }),
            ...(caller.session.modelId === undefined ? {} : { modelId: caller.session.modelId }),
            ...(signal === undefined ? {} : { signal }) });
          result = { command: installed.command, filePath: installed.filePath, attached: false,
            test: durableSchedulePreRunHookResult(installed.test), content: installed.content.length > 4000
              ? `${installed.content.slice(0, 4000)}…[truncated]` : installed.content }; break;
        }
        case "schedule_notify_current_run":
          keys(input, []); result = { notified: true, ...this.notifications.notify({ sessionId: caller.session.id, targetId: caller.session.targetId }) }; break;
        default: throw new ConnectError("Partner routine tool is unavailable.", Code.NotFound);
      }
      assertCaller();
      const value = { ok: true, result };
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (error) {
      signal?.throwIfAborted();
      return { content: [{ type: "text" as const, text: error instanceof ConnectError ? error.rawMessage
        : "The routine operation was not confirmed. Read routine_list and routine_history before explicitly retrying." }], isError: true };
    }
  }
}

function invalid(): never { throw new ConnectError("Routine arguments are invalid. Read current definitions and sources before changing a routine.", Code.InvalidArgument); }
function keys(value: object, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) invalid();
  return value;
}
function identity(value: unknown): string { return text(value, 128); }
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid();
  return Number(value);
}
function effect(context: BridgeToolCallContext): string {
  if (!/^[a-f0-9]{64}$/u.test(context.effectIdentity ?? "")) throw new ConnectError("The routine effect identity is unavailable.", Code.FailedPrecondition);
  return context.effectIdentity!;
}
function definition(input: Readonly<Record<string, unknown>>, previous: Routine | undefined) {
  if (input["silentWhenIdle"] !== undefined && typeof input["silentWhenIdle"] !== "boolean") invalid();
  if (!Array.isArray(input["triggers"]) || input["triggers"].length < 1 || input["triggers"].length > 32) invalid();
  for (const raw of input["triggers"]) {
    const trigger = record(raw);
    const fields = { cron: ["expression", "timezone"], interval: ["intervalMs", "anchorMs"], once: ["at"], event: ["sourceId", "eventType", "filters"] };
    const kind = trigger["kind"];
    if (typeof kind !== "string" || !Object.hasOwn(fields, kind)) invalid();
    keys(trigger, ["id", "kind", ...fields[kind as keyof typeof fields]]);
    if (kind === "event") {
      if (!Array.isArray(trigger["filters"])) invalid();
      for (const filter of trigger["filters"]) keys(record(filter), ["field", "operator", "value"]);
    }
  }
  const hook = input["preRunHook"] === undefined ? previous?.preRunHook : input["preRunHook"] === null ? undefined : record(input["preRunHook"]);
  if (hook !== undefined) keys(hook, ["command", "timeoutMs"]);
  try {
    return parseRoutineInput({ name: input["name"], prompt: input["prompt"], enabled: input["enabled"], triggers: input["triggers"],
      silentWhenIdle: input["silentWhenIdle"] ?? previous?.silentWhenIdle ?? false, ...(hook === undefined ? {} : { preRunHook: hook }) });
  } catch { return invalid(); }
}
