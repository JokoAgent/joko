import { createHash } from "node:crypto";
import type { BridgeToolCallContext, BridgeToolProvider, McpToolDescriptor } from "./mcp-router.js";
import { PartnerSessionTaskError, type PartnerSessionTaskManager, type StartPartnerSessionTask, type TaskModelSelection } from "./partner-session-tasks.js";
import type { InteractionDecisionSubmission } from "./session-host.js";
import { redactSecrets } from "@joko/core";

const providerId = "joko_partner_session_tasks";
const id = { type: "string", minLength: 1, maxLength: 256 };
const text = { type: "string", minLength: 1, maxLength: 4_000 };
const object = (properties: Record<string, unknown>, required: readonly string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name: string, description: string, properties: Record<string, unknown>, required: readonly string[] = [], requiresPermission = false): McpToolDescriptor =>
  ({ serverId: providerId, name, description, inputSchema: object(properties, required), requiresPermission });
export class PartnerSessionTaskTools implements BridgeToolProvider {
  readonly id = providerId; readonly generation = 1; readonly available = true;
  readonly tools = [
    tool("get_session_task_models", "Read available enabled Backend/Provider/model routes and supported effort/Fast axes for one independent task. Use a returned id for an explicit model_selection; omit it to use the Partner task preference or effective live model.", {}),
    tool("start_session_task", "Start one real independent task visible in the user's task list. Supply the objective, constraints, known facts, completed work and acceptance criteria; this chat is not inherited. For project work pass its actual absolute working_dir. use_worktree creates isolation before the runtime starts and fails without shared-directory fallback. Omit model_selection to use the Partner task preference or live route; an unavailable explicit choice fails. timeout_ms defaults to 30 minutes and is limited to 24 hours. The result returns automatically. Start once; review the same task instead of duplicating it. Use for coding and substantial work, respecting a request to work inline. Keep internal routing and task ids out of ordinary replies unless requested.", {
      instruction: { type: "string", minLength: 1, maxLength: 12_000 }, title: { type: "string", minLength: 1, maxLength: 120 },
      working_dir: { type: "string", minLength: 1, maxLength: 1_024 }, use_worktree: { type: "boolean" },
      context_refs: { type: "array", maxItems: 32, items: { type: "string", maxLength: 512 } }, timeout_ms: { type: "integer", minimum: 1_000, maximum: 86_400_000 },
      model_selection: object({ id: { type: "string", minLength: 1, maxLength: 2048 }, effort: { type: "string", maxLength: 64 }, fast_mode: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["ultrafast"] }] } }, ["id"])
    }, ["instruction"], true),
    tool("check_session_task", "Read your own independent task's state, working directory, pending interactions, owned queue, result, artifacts and stop confirmation. Optional queued_message_id reads its exact durable Queue receipt. Accepted/dispatched input does not prove the model acted on it. Read only for a concrete progress or recovery need.", { task_id: id, queued_message_id: id }, ["task_id"]),
    tool("message_session_task", "Follow up on the same task. queue uses a fresh execution with the original time budget after completion; steer requires a running capable Backend and never falls back to queue. edit/withdraw affect only your own unconsumed queued_message_id. resume releases a confirmed pause and preserves completed work. For an exact open interaction supply its id/generation and decision or typed answers. Resume before answering a paused task.", {
      task_id: id, message: text, mode: { type: "string", enum: ["queue", "steer", "resume", "edit", "withdraw"] }, queued_message_id: id,
      interaction_id: id, interaction_generation: { type: "integer", minimum: 1 }, decision: { type: "string" },
      answers: { type: "array", maxItems: 32, items: object({ field_id: id, value: object({ kind: { type: "string", enum: ["text", "choice", "other", "choices", "boolean"] },
        value: { anyOf: [{ type: "string", minLength: 1, maxLength: 4_000 }, { type: "boolean" }] },
        values: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_000 } }, other_text: { type: "string", maxLength: 4_000 } }, ["kind"]) }, ["field_id", "value"]) },
      idempotency_key: { type: "string", minLength: 1, maxLength: 128 }
    }, ["task_id"], true),
    tool("stop_session_task", "cancel terminates this execution and its pending input. request-stop requests an interrupt of the current turn only. pause holds input on the same task until a deliberate resume. pausing/cancelling is not proof the runtime stopped.", { task_id: id, mode: { type: "string", enum: ["cancel", "request-stop", "pause"] } }, ["task_id"], true),
    tool("inspect_session_task_route", "Read the current route and a safe next frozen configured route for a failed task. Suggestions require a failure another route can address and enough context headroom. An explicit or owner-selected route outside the chain has no backup. This does not retry work.", { task_id: id }, ["task_id"]),
    tool("advance_session_task_route", "Select the exact next route from the inspected generation/token for your own ended task. This does not change the Partner profile, authorize an interaction or replay work. Send a separate follow-up if needed.", { task_id: id, expected_generation: { type: "integer", minimum: 0 }, selection_token: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["task_id", "expected_generation", "selection_token"], true)
  ];
  constructor(readonly manager: PartnerSessionTaskManager) {}
  includeForTarget(targetId: string) { const profile = this.manager.partners.partnerForHomeTarget(targetId); return profile?.lifecycle === "active" && profile.initializationState === "ready"; }
  includeForSession(sessionId: string, targetId: string) {
    try { this.manager.caller(sessionId).assertCurrent(); return this.manager.store.getSession(sessionId).descriptor.targetId === targetId; }
    catch { return false; }
  }
  #caller(context: BridgeToolCallContext, signal: AbortSignal | undefined) {
    const caller = this.manager.caller(context.sessionId), { profile } = caller, store = this.manager.store;
    const backendId = store.getSession(context.sessionId).descriptor.backendId, backendGeneration = store.getBackend(backendId).descriptor.instanceGeneration;
    const assertCurrent = () => {
      signal?.throwIfAborted(); caller.assertCurrent(); const session = store.getSession(context.sessionId).descriptor, current = this.manager.caller(context.sessionId).profile;
      if (context.targetId !== session.targetId || !caller.group && context.targetId !== current.homeTargetId || context.generation !== session.binding.generation
        || profile.revision !== current.revision || profile.profileVersion !== current.profileVersion || !caller.group && session.remoteWorkspace !== undefined
        || !store.getTarget(session.targetId).descriptor.trusted || context.providerGeneration !== undefined && context.providerGeneration !== this.generation
        || backendId !== session.backendId || backendGeneration !== store.getBackend(backendId).descriptor.instanceGeneration) throw new PartnerSessionTaskError("TASK_CALLER_CHANGED", "The independent task caller changed.");
    }; assertCurrent(); return assertCurrent;
  }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    try {
      const assertCurrent = this.#caller(context, signal); let value: unknown;
      if (name === "get_session_task_models") { keys(input, []); value = this.manager.models(context.sessionId); }
      else if (name === "start_session_task") {
        keys(input, ["instruction", "title", "working_dir", "use_worktree", "context_refs", "timeout_ms", "model_selection"]);
        const raw = input["model_selection"]; let selection: TaskModelSelection | undefined;
        if (raw !== undefined) {
          if (!record(raw)) invalid(); keys(raw, ["id", "effort", "fast_mode"]);
          selection = { id: required(raw, "id", 2048), ...(raw["effort"] === undefined ? {} : { effort: required(raw, "effort", 64) }),
            ...(raw["fast_mode"] === undefined ? {} : { fastMode: raw["fast_mode"] === "ultrafast" ? "ultrafast" : boolean(raw["fast_mode"]) }) };
        }
        const start: StartPartnerSessionTask = { instruction: required(input, "instruction", 12_000),
          ...(input["title"] === undefined ? {} : { title: required(input, "title", 120) }),
          ...(input["working_dir"] === undefined ? {} : { workingDir: required(input, "working_dir", 1_024) }),
          ...(input["use_worktree"] === undefined ? {} : { useWorktree: boolean(input["use_worktree"]) }),
          ...(input["timeout_ms"] === undefined ? {} : { timeoutMs: integer(input["timeout_ms"], 1_000, 86_400_000) }),
          ...(input["context_refs"] === undefined ? {} : { contextRefs: strings(input["context_refs"], 32, 512) }), ...(selection ? { modelSelection: selection } : {}) };
        value = this.manager.view(await this.manager.start(context.sessionId, `partner-session-task:${effect(context)}`, start, assertCurrent));
      } else if (name === "check_session_task") {
        keys(input, ["task_id", "queued_message_id"]); const task = await this.manager.check(context.sessionId, required(input, "task_id", 256));
        value = { ...this.manager.view(task, context.sessionId), ...(input["queued_message_id"] === undefined ? {} : { message_receipt: this.manager.messageReceipt(context.sessionId, task, required(input, "queued_message_id", 256)) }) };
      } else if (name === "stop_session_task") {
        keys(input, ["task_id", "mode"]); const mode = input["mode"] ?? "cancel";
        if (mode !== "cancel" && mode !== "pause" && mode !== "request-stop") invalid();
        value = this.manager.view(await this.manager.stop(context.sessionId, required(input, "task_id", 256), `partner-task-control:${effect(context)}`, mode, assertCurrent));
      } else if (name === "inspect_session_task_route") {
        keys(input, ["task_id"]); value = this.manager.inspectRoute(context.sessionId, required(input, "task_id", 256));
      } else if (name === "advance_session_task_route") {
        keys(input, ["task_id", "expected_generation", "selection_token"]); effect(context);
        value = await this.manager.advanceRoute(context.sessionId, required(input, "task_id", 256), integer(input["expected_generation"], 0, Number.MAX_SAFE_INTEGER), required(input, "selection_token", 64), assertCurrent);
      } else if (name === "message_session_task") {
        keys(input, ["task_id", "message", "mode", "queued_message_id", "interaction_id", "interaction_generation", "decision", "answers", "idempotency_key"]);
        const taskId = required(input, "task_id", 256), mode = input["mode"] ?? "queue";
        if (mode !== "queue" && mode !== "steer" && mode !== "resume" && mode !== "edit" && mode !== "withdraw") invalid();
        const message = input["message"] === undefined ? undefined : required(input, "message", 4_000);
        const interactionId = input["interaction_id"] === undefined ? undefined : required(input, "interaction_id", 256);
        let decision: InteractionDecisionSubmission | undefined;
        if (interactionId) {
          if (mode !== "queue" || message !== undefined || input["queued_message_id"] !== undefined) invalid();
          const task = await this.manager.check(context.sessionId, taskId), interaction = this.manager.store.getInteraction(interactionId); assertCurrent();
          if (interaction.sessionId !== task.sessionId || interaction.status !== "open") invalid();
          if (interaction.payload.kind === "question") {
            if (input["decision"] !== undefined || !Array.isArray(input["answers"]) || input["answers"].length > 32) invalid();
            decision = { kind: "question", answers: input["answers"].map(answer => {
              if (!record(answer) || !record(answer["value"])) invalid(); keys(answer, ["field_id", "value"]);
              const raw = answer["value"]; keys(raw, ["kind", "value", "values", "other_text"]); const kind = raw["kind"];
              if (kind === "choices") return { fieldId: required(answer, "field_id", 256), value: { kind, values: strings(raw["values"], 64, 4_000), ...(raw["other_text"] === undefined ? {} : { otherText: required(raw, "other_text", 4_000) }) } };
              if (kind === "boolean") return { fieldId: required(answer, "field_id", 256), value: { kind, value: boolean(raw["value"]) } };
              if (kind !== "text" && kind !== "choice" && kind !== "other") invalid();
              return { fieldId: required(answer, "field_id", 256), value: { kind, value: required(raw, "value", 4_000) } };
            }) };
          } else {
            if (input["answers"] !== undefined || interaction.payload.kind !== "permission" && interaction.payload.kind !== "plan_review") invalid();
            decision = { kind: interaction.payload.kind, decision: required(input, "decision", 256) };
          }
        } else if (input["decision"] !== undefined || input["answers"] !== undefined || input["interaction_generation"] !== undefined) invalid();
        const queuedMessageId = input["queued_message_id"] === undefined ? undefined : required(input, "queued_message_id", 256);
        if ((mode === "edit" || mode === "withdraw") ? !queuedMessageId || (mode === "edit" ? !message : message !== undefined) : queuedMessageId !== undefined
          || !decision && mode !== "resume" && !message) invalid();
        const token = input["idempotency_key"] === undefined ? effect(context) : hashIdentity(context.sessionId, taskId, required(input, "idempotency_key", 128));
        const operationId = `partner-task-message:${token}`;
        const task = await this.manager.message(context.sessionId, taskId, operationId, { mode,
          ...(message === undefined ? {} : { message }), ...(queuedMessageId === undefined ? {} : { queuedMessageId }),
          ...(decision === undefined ? {} : { decision, interactionId: interactionId!, interactionGeneration: integer(input["interaction_generation"], 1, Number.MAX_SAFE_INTEGER) }) }, assertCurrent);
        const receipt = this.manager.store.findOperation<{ queueItemId?: string }>(mode === "resume" ? `${operationId}:resume-input` : operationId)?.response;
        value = { ...this.manager.view(task, context.sessionId), ...(receipt?.queueItemId ? { message_receipt: this.manager.messageReceipt(context.sessionId, task, receipt.queueItemId) } : {}) };
      } else invalid();
      assertCurrent(); return { isError: false, content: [{ type: "text" as const, text: JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item) }] };
    } catch (error) {
      signal?.throwIfAborted(); return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: error instanceof PartnerSessionTaskError ? error.code : "TASK_UNAVAILABLE",
        message: error instanceof PartnerSessionTaskError ? error.message : "The independent task action is unavailable. Read its current state before retrying." }) }] };
    }
  }
}
function hashIdentity(sessionId: string, taskId: string, idempotencyKey: string) { return createHash("sha256").update(JSON.stringify([sessionId, taskId, idempotencyKey])).digest("hex"); }
function invalid(): never { throw new PartnerSessionTaskError("TASK_INVALID", "Independent task arguments are invalid."); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) invalid(); }
function required(value: Readonly<Record<string, unknown>>, key: string, max: number): string { const item = value[key]; if (typeof item !== "string" || !item.trim() || item.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item) || redactSecrets(item) !== item) invalid(); return item.trim(); }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value; }
function strings(value: unknown, max: number, size: number): string[] { if (!Array.isArray(value) || value.length > max) invalid(); return value.map(item => required({ item }, "item", size)); }
function effect(context: BridgeToolCallContext) { if (!context.effectIdentity || !/^[a-f0-9]{64}$/u.test(context.effectIdentity)) throw new PartnerSessionTaskError("TASK_CALLER_CHANGED", "The task effect identity is unavailable."); return context.effectIdentity; }
