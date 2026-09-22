import type { PermissionMode, SessionDescriptor } from "@joko/core";
import {
  AuthorizationError,
  StoreError,
  type CollaborationDispatchRecord,
  type CollaborationWorkerRecord,
  type OperationalStore
} from "@joko/store";

import {
  CollaborationGoalManagerError,
  type CollaborationGoalManager,
  type CollaborationGoalTreeView
} from "./collaboration-goal-manager.js";
import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const COLLABORATION_GOAL_TOOL_PROVIDER_ID = "joko_collaboration";

const LIST_TOOLS = "list_tools";
const CALL_TOOL = "call_tool";
const ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
});
const REVISION_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 20,
  pattern: "^(0|[1-9][0-9]{0,19})$"
});
const GENERATION_SCHEMA = Object.freeze({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const MESSAGE_SCHEMA = Object.freeze({ type: "string", minLength: 1, maxLength: 32_000 });

type CollaborationToolRole = "any" | "lead" | "worker";

interface CollaborationNestedTool {
  readonly name: string;
  readonly description: string;
  readonly role: CollaborationToolRole;
  readonly readOnly: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const WORKER_ROUTE_PROPERTIES = Object.freeze({
  target_id: ID_SCHEMA,
  provider_id: ID_SCHEMA,
  model_id: ID_SCHEMA,
  effort: { type: "string", minLength: 1, maxLength: 64 },
  fast_mode: { type: "boolean" },
  permission_mode: { type: "string", enum: ["ask", "auto", "bypassPermissions"] },
  plan_mode: { type: "boolean" }
});

const WORKER_SPEC_PROPERTIES = Object.freeze({
  label: { type: "string", minLength: 1, maxLength: 64 },
  role: { type: "string", minLength: 1, maxLength: 128 },
  assignment: MESSAGE_SCHEMA,
  parent_worker_id: ID_SCHEMA,
  ...WORKER_ROUTE_PROPERTIES
});

export const COLLABORATION_GOAL_NESTED_TOOLS: readonly CollaborationNestedTool[] = Object.freeze([
  nestedTool(
    "get_goal",
    "Read the caller's active durable Goal. Leads receive the worker tree and owned pending Queue; workers receive only their own assignment and Goal summary.",
    "any",
    true,
    objectSchema({})
  ),
  nestedTool(
    "start_goal",
    "Start one durable collaboration Goal led by the current task. This creates no worker by itself.",
    "any",
    false,
    objectSchema({
      title: { type: "string", minLength: 1, maxLength: 256 },
      objective: MESSAGE_SCHEMA,
      maximum_workers: { type: "integer", minimum: 1, maximum: 128 }
    }, ["title", "objective"])
  ),
  nestedTool(
    "create_worker",
    "Create one visible, durable worker task and dispatch its initial assignment. Use only when the user explicitly asks for a new worker; this is not a disposable native subagent.",
    "lead",
    false,
    objectSchema(WORKER_SPEC_PROPERTIES, ["label", "role", "assignment"])
  ),
  nestedTool(
    "create_workers",
    "Create two or more visible durable worker tasks for an explicitly requested multi-role collaboration, returning every per-worker result or failure.",
    "lead",
    false,
    objectSchema({
      workers: {
        type: "array",
        minItems: 2,
        maxItems: 20,
        items: objectSchema(WORKER_SPEC_PROPERTIES, ["label", "role", "assignment"])
      }
    }, ["workers"])
  ),
  nestedTool(
    "update_worker",
    "Revision-fenced update of a worker label, role, or durable assignment metadata.",
    "lead",
    false,
    objectSchema({
      worker_id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      label: { type: "string", minLength: 1, maxLength: 64 },
      role: { type: "string", minLength: 1, maxLength: 128 },
      assignment: MESSAGE_SCHEMA
    }, ["worker_id", "expected_revision"])
  ),
  nestedTool(
    "focus_worker",
    "Select one visible worker in the Goal, or clear focus when worker_id is omitted.",
    "lead",
    false,
    objectSchema({ worker_id: ID_SCHEMA, expected_revision: REVISION_SCHEMA })
  ),
  nestedTool(
    "send_to_worker",
    "Durably enqueue additional work for an existing worker. Running workers accept it as later Queue work; do not create a substitute worker.",
    "lead",
    false,
    objectSchema({ worker_id: ID_SCHEMA, message: MESSAGE_SCHEMA }, ["worker_id", "message"])
  ),
  nestedTool(
    "interrupt_worker",
    "Persist a replacement as the worker's next collaboration message, cancel older pending collaboration messages, then request a graceful stop of the unfinished turn. Use only when the active task must be replaced.",
    "lead",
    false,
    objectSchema({ worker_id: ID_SCHEMA, message: MESSAGE_SCHEMA }, ["worker_id", "message"])
  ),
  nestedTool(
    "get_worker_queue",
    "Read lead-owned dispatches and exact Queue revisions for one worker.",
    "lead",
    true,
    objectSchema({ worker_id: ID_SCHEMA }, ["worker_id"])
  ),
  nestedTool(
    "update_queued_message",
    "Replace one unconsumed collaboration message using exact dispatch and Queue revisions.",
    "lead",
    false,
    objectSchema({
      dispatch_id: ID_SCHEMA,
      expected_dispatch_revision: REVISION_SCHEMA,
      expected_queue_revision: REVISION_SCHEMA,
      message: MESSAGE_SCHEMA
    }, ["dispatch_id", "expected_dispatch_revision", "expected_queue_revision", "message"])
  ),
  nestedTool(
    "cancel_queued_message",
    "Cancel one collaboration message using exact dispatch and Queue revisions.",
    "lead",
    false,
    objectSchema({
      dispatch_id: ID_SCHEMA,
      expected_dispatch_revision: REVISION_SCHEMA,
      expected_queue_revision: REVISION_SCHEMA
    }, ["dispatch_id", "expected_dispatch_revision", "expected_queue_revision"])
  ),
  nestedTool(
    "merge_queued_messages",
    "Atomically merge one explicitly ordered, contiguous pending Queue segment; the first dispatch keeps its identity.",
    "lead",
    false,
    objectSchema({
      worker_id: ID_SCHEMA,
      dispatches: {
        type: "array",
        minItems: 2,
        maxItems: 100,
        items: objectSchema({
          dispatch_id: ID_SCHEMA,
          expected_dispatch_revision: REVISION_SCHEMA,
          expected_queue_revision: REVISION_SCHEMA
        }, ["dispatch_id", "expected_dispatch_revision", "expected_queue_revision"])
      }
    }, ["worker_id", "dispatches"])
  ),
  nestedTool(
    "release_worker",
    "Release only a proven-idle worker runtime while retaining its durable worker identity and history.",
    "lead",
    false,
    objectSchema({
      worker_id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      expected_session_generation: GENERATION_SCHEMA
    }, ["worker_id", "expected_revision", "expected_session_generation"])
  ),
  nestedTool(
    "wake_worker",
    "Resume a released worker using exact worker revision and Session generation fences.",
    "lead",
    false,
    objectSchema({
      worker_id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      expected_session_generation: GENERATION_SCHEMA
    }, ["worker_id", "expected_revision", "expected_session_generation"])
  ),
  nestedTool(
    "stop_worker",
    "Stop a worker, cancel its pending collaboration Queue entries, and close its runtime without deleting history.",
    "lead",
    false,
    objectSchema({
      worker_id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      expected_session_generation: GENERATION_SCHEMA
    }, ["worker_id", "expected_revision"])
  ),
  nestedTool(
    "archive_worker",
    "Archive a stopped or released terminal worker and its visible task using its exact revision.",
    "lead",
    false,
    objectSchema({ worker_id: ID_SCHEMA, expected_revision: REVISION_SCHEMA }, ["worker_id", "expected_revision"])
  ),
  nestedTool(
    "end_goal",
    "Stop and archive every remaining worker, then stop the Goal. In-progress work is interrupted and history remains visible.",
    "lead",
    false,
    objectSchema({})
  ),
  nestedTool(
    "send_to_lead",
    "Worker-only reporting channel. Send one final result or blocking question to the exact lead task; do not use it for progress polling.",
    "worker",
    false,
    objectSchema({ message: MESSAGE_SCHEMA }, ["message"])
  )
]);

const BRIDGE_TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  tool(
    LIST_TOOLS,
    "List Joko collaboration Goal tools. Filter by caller role to inspect exact schemas.",
    objectSchema({ role: { type: "string", enum: ["lead", "worker", "any"] } }),
    false
  ),
  tool(
    CALL_TOOL,
    "Call one Joko collaboration Goal tool returned by list_tools.",
    objectSchema({
      name: { type: "string", minLength: 1, maxLength: 128 },
      args: { type: "object", additionalProperties: true }
    }, ["name", "args"]),
    true
  )
]);

type Caller =
  | { readonly kind: "lead"; readonly session: SessionDescriptor; readonly goalId: string }
  | { readonly kind: "worker"; readonly session: SessionDescriptor; readonly worker: CollaborationWorkerRecord };

/** Authenticated agent-facing controls for the same durable Goal authority used
 * by Connect and Web. Model arguments never select caller identity. */
export class CollaborationToolBridgeProvider implements BridgeToolProvider {
  readonly id = COLLABORATION_GOAL_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = BRIDGE_TOOLS;
  readonly #store: OperationalStore;
  readonly #manager: CollaborationGoalManager;

  constructor(options: { readonly store: OperationalStore; readonly manager: CollaborationGoalManager }) {
    this.#store = options.store;
    this.#manager = options.manager;
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
    try {
      if (context.providerGeneration !== undefined && context.providerGeneration !== this.generation) {
        throw new CollaborationToolError("STALE_SCOPE", "The collaboration Tool snapshot is stale.");
      }
      const session = this.#requireSession(context);
      if (name === LIST_TOOLS) return this.#listTools(arguments_, session);
      if (name !== CALL_TOOL) {
        throw new CollaborationToolError("UNKNOWN_TOOL", "The collaboration Tool is unavailable.");
      }
      assertKeys(arguments_, ["name", "args"]);
      const selectedName = requiredText(arguments_, "name", 128);
      const selected = COLLABORATION_GOAL_NESTED_TOOLS.find((candidate) => candidate.name === selectedName);
      if (selected === undefined) {
        throw new CollaborationToolError("UNKNOWN_TOOL", "The requested collaboration action is unavailable.");
      }
      const args = requiredRecord(arguments_, "args");
      const caller = selected.name === "start_goal"
        ? this.#callerForStart(session)
        : this.#requireCollaborationCaller(session);
      if (selected.role !== "any" && selected.role !== caller.kind) {
        throw new CollaborationToolError(
          "NOT_AUTHORIZED",
          `The ${selected.name} action requires a ${selected.role} task.`
        );
      }
      const result = await this.#dispatch(selected.name, args, caller, context, signal);
      signal?.throwIfAborted();
      return success(result);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      return failure(error);
    }
  }

  #listTools(input: Readonly<Record<string, unknown>>, session: SessionDescriptor): McpCallResult {
    assertKeys(input, ["role"]);
    const requested = optionalEnum(input["role"], "role", ["lead", "worker", "any"] as const);
    const observed = this.#callerKind(session);
    const role = requested ?? observed ?? "any";
    return success({
      role,
      active_role: observed ?? "none",
      tools: COLLABORATION_GOAL_NESTED_TOOLS
        .filter((item) => role === "any" || item.role === "any" || item.role === role)
        .map((item) => ({
          name: item.name,
          role: item.role,
          description: item.description,
          read_only: item.readOnly,
          input_schema: item.inputSchema
        }))
    });
  }

  async #dispatch(
    name: string,
    input: Readonly<Record<string, unknown>>,
    caller: Caller,
    context: BridgeToolCallContext,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    if (name === "get_goal") {
      assertKeys(input, []);
      const tree = this.#manager.getTree(caller.kind === "lead" ? caller.goalId : caller.worker.goalId);
      return caller.kind === "lead" ? publicTree(tree) : publicWorkerGoal(tree, caller.worker.id);
    }
    if (name === "start_goal") {
      if (caller.kind !== "lead") throw new CollaborationToolError("NOT_AUTHORIZED", "A worker cannot lead a nested Goal.");
      assertKeys(input, ["title", "objective", "maximum_workers"]);
      const existing = this.#store.findActiveCollaborationGoalByLeadSession(caller.session.id);
      if (existing !== undefined) {
        throw new CollaborationToolError("GOAL_ALREADY_ACTIVE", "The current task already leads an active Goal.");
      }
      const maximumWorkers = optionalInteger(input["maximum_workers"], "maximum_workers", 1, 128);
      return publicTree(this.#manager.createGoal({
        operationId: operationId(context, name),
        leadSessionId: caller.session.id,
        expectedSessionGeneration: caller.session.binding.generation,
        title: requiredText(input, "title", 256),
        objective: requiredText(input, "objective", 32_000, true),
        ...(maximumWorkers === undefined ? {} : { maximumWorkers })
      }));
    }
    if (name === "send_to_lead") {
      const workerCaller = requireWorker(caller);
      assertKeys(input, ["message"]);
      const current = this.#store.getCollaborationWorker(workerCaller.worker.id);
      const queued = this.#manager.sendWorkerReport({
        operationId: operationId(context, name),
        workerId: current.id,
        callerWorkerSessionId: workerCaller.session.id,
        expectedWorkerRevision: current.revision,
        expectedWorkerSessionGeneration: requiredWorkerGeneration(current),
        message: requiredText(input, "message", 32_000, true)
      });
      return { goal_id: current.goalId, worker_id: current.id, queued_message_id: queued.queueItemId };
    }
    const lead = requireLead(caller);
    if (name === "create_worker") {
      return publicWorkerResult(await this.#createWorker(input, lead, operationId(context, name)));
    }
    if (name === "create_workers") {
      assertKeys(input, ["workers"]);
      const values = input["workers"];
      if (!Array.isArray(values) || values.length < 2 || values.length > 20) {
        throw new CollaborationToolError("INVALID_ARGS", "workers must contain between 2 and 20 worker specifications.");
      }
      const specifications = values.map((value, index) => {
        if (!isRecord(value)) {
          throw new CollaborationToolError("INVALID_ARGS", `workers[${index}] must be an object.`);
        }
        validateWorkerSpecInput(value);
        return value;
      });
      const labels = specifications.map((value) => requiredText(value, "label", 64).toLocaleLowerCase("en-US"));
      if (new Set(labels).size !== labels.length) {
        throw new CollaborationToolError("INVALID_ARGS", "Worker labels must be unique within one batch.");
      }
      const results: unknown[] = [];
      const batchOperationId = operationId(context, name);
      for (let index = 0; index < specifications.length; index += 1) {
        signal?.throwIfAborted();
        const value = specifications[index]!;
        try {
          const result = await this.#createWorker(value, lead, `${batchOperationId}:${index}`);
          results.push({ index, ok: true, ...publicWorkerResult(result) });
        } catch (error) {
          const mapped = toolError(error);
          results.push({ index, ok: false, error_code: mapped.code, message: mapped.message });
          if (mapped.code === "WORKER_HARD_LIMIT_REACHED") {
            for (let skipped = index + 1; skipped < specifications.length; skipped += 1) {
              results.push({
                index: skipped,
                ok: false,
                skipped: true,
                error_code: mapped.code,
                message: "The batch stopped after reaching the machine worker hard limit."
              });
            }
            break;
          }
        }
      }
      return {
        request_count: specifications.length,
        attempted_count: results.filter((item) => isRecord(item) && item["skipped"] !== true).length,
        dispatched_count: results.filter((item) => isRecord(item) && item["ok"] === true).length,
        skipped_count: results.filter((item) => isRecord(item) && item["skipped"] === true).length,
        results
      };
    }
    if (name === "update_worker") {
      assertKeys(input, ["worker_id", "expected_revision", "label", "role", "assignment"]);
      const label = optionalText(input["label"], "label", 64);
      const role = optionalText(input["role"], "role", 128);
      const assignment = optionalText(input["assignment"], "assignment", 32_000, true);
      const result = this.#manager.updateWorker({
        operationId: operationId(context, name),
        workerId: requiredId(input, "worker_id"),
        callerLeadSessionId: lead.session.id,
        expectedRevision: requiredRevision(input, "expected_revision"),
        ...(label === undefined ? {} : { label }),
        ...(role === undefined ? {} : { role }),
        ...(assignment === undefined ? {} : { assignment })
      });
      return publicWorkerResult(result);
    }
    if (name === "focus_worker") {
      assertKeys(input, ["worker_id", "expected_revision"]);
      const workerId = optionalId(input["worker_id"], "worker_id");
      const revision = optionalRevision(input["expected_revision"], "expected_revision");
      if ((workerId === undefined) !== (revision === undefined)) {
        throw new CollaborationToolError("INVALID_ARGS", "worker_id and expected_revision must be supplied together.");
      }
      return publicTree(this.#manager.focusWorker({
        operationId: operationId(context, name),
        goalId: lead.goalId,
        callerLeadSessionId: lead.session.id,
        ...(workerId === undefined ? {} : { workerId, expectedWorkerRevision: revision })
      }));
    }
    if (name === "send_to_worker") {
      assertKeys(input, ["worker_id", "message"]);
      const worker = this.#ownedWorker(lead, requiredId(input, "worker_id"));
      const result = await this.#manager.sendMessage({
        operationId: operationId(context, name),
        goalId: lead.goalId,
        workerId: worker.id,
        callerLeadSessionId: lead.session.id,
        expectedWorkerRevision: worker.revision,
        expectedSessionGeneration: requiredWorkerGeneration(worker),
        message: requiredText(input, "message", 32_000, true)
      });
      return { tree: publicTree(result.tree), dispatch: publicDispatch(result.dispatch, result.tree) };
    }
    if (name === "interrupt_worker") {
      assertKeys(input, ["worker_id", "message"]);
      const worker = this.#ownedWorker(lead, requiredId(input, "worker_id"));
      const result = await this.#manager.interruptWorker({
        operationId: operationId(context, name),
        goalId: lead.goalId,
        workerId: worker.id,
        callerLeadSessionId: lead.session.id,
        expectedWorkerRevision: worker.revision,
        expectedSessionGeneration: requiredWorkerGeneration(worker),
        message: requiredText(input, "message", 32_000, true)
      });
      return {
        tree: publicTree(result.tree),
        dispatch: publicDispatch(result.dispatch, result.tree),
        stop_outcome: result.stopOutcome
      };
    }
    if (name === "get_worker_queue") {
      assertKeys(input, ["worker_id"]);
      const worker = this.#ownedWorker(lead, requiredId(input, "worker_id"));
      const tree = this.#manager.getTree(lead.goalId);
      return {
        worker: publicWorker(worker),
        queue: tree.queue.filter((entry) => entry.dispatch.workerId === worker.id)
          .map((entry) => publicDispatch(entry.dispatch, tree, entry.queueItem))
      };
    }
    if (name === "update_queued_message") {
      assertKeys(input, ["dispatch_id", "expected_dispatch_revision", "expected_queue_revision", "message"]);
      const result = this.#manager.editDispatch({
        operationId: operationId(context, name),
        dispatchId: requiredId(input, "dispatch_id"),
        callerLeadSessionId: lead.session.id,
        expectedDispatchRevision: requiredRevision(input, "expected_dispatch_revision"),
        expectedQueueRevision: requiredRevision(input, "expected_queue_revision"),
        message: requiredText(input, "message", 32_000, true)
      });
      return { tree: publicTree(result.tree), dispatch: publicDispatch(result.dispatch, result.tree) };
    }
    if (name === "cancel_queued_message") {
      assertKeys(input, ["dispatch_id", "expected_dispatch_revision", "expected_queue_revision"]);
      const result = this.#manager.cancelDispatch({
        operationId: operationId(context, name),
        dispatchId: requiredId(input, "dispatch_id"),
        callerLeadSessionId: lead.session.id,
        expectedDispatchRevision: requiredRevision(input, "expected_dispatch_revision"),
        expectedQueueRevision: requiredRevision(input, "expected_queue_revision")
      });
      return { tree: publicTree(result.tree), dispatch: publicDispatch(result.dispatch, result.tree) };
    }
    if (name === "merge_queued_messages") {
      assertKeys(input, ["worker_id", "dispatches"]);
      const worker = this.#ownedWorker(lead, requiredId(input, "worker_id"));
      const values = input["dispatches"];
      if (!Array.isArray(values) || values.length < 2 || values.length > 100) {
        throw new CollaborationToolError("INVALID_ARGS", "dispatches must contain between 2 and 100 entries.");
      }
      const dispatches = values.map((value, index) => {
        if (!isRecord(value)) {
          throw new CollaborationToolError("INVALID_ARGS", `dispatches[${index}] must be an object.`);
        }
        assertKeys(value, ["dispatch_id", "expected_dispatch_revision", "expected_queue_revision"]);
        return {
          dispatchId: requiredId(value, "dispatch_id"),
          expectedDispatchRevision: requiredRevision(value, "expected_dispatch_revision"),
          expectedQueueRevision: requiredRevision(value, "expected_queue_revision")
        };
      });
      const result = this.#manager.mergeDispatches({
        operationId: operationId(context, name),
        goalId: lead.goalId,
        workerId: worker.id,
        callerLeadSessionId: lead.session.id,
        dispatches
      });
      return { tree: publicTree(result.tree), dispatches: result.dispatches.map((item) => publicDispatch(item, result.tree)) };
    }
    if (name === "release_worker" || name === "wake_worker" || name === "stop_worker") {
      const keys = name === "stop_worker"
        ? ["worker_id", "expected_revision", "expected_session_generation"]
        : ["worker_id", "expected_revision", "expected_session_generation"];
      assertKeys(input, keys);
      const workerId = requiredId(input, "worker_id");
      this.#ownedWorker(lead, workerId);
      const base = {
        operationId: operationId(context, name),
        workerId,
        callerLeadSessionId: lead.session.id,
        expectedRevision: requiredRevision(input, "expected_revision")
      };
      const generation = optionalInteger(
        input["expected_session_generation"],
        "expected_session_generation",
        0,
        Number.MAX_SAFE_INTEGER
      );
      const result = name === "release_worker"
        ? await this.#manager.releaseWorker({ ...base, expectedSessionGeneration: requiredGeneration(generation) })
        : name === "wake_worker"
          ? await this.#manager.wakeWorker({ ...base, expectedSessionGeneration: requiredGeneration(generation) })
          : await this.#manager.stopWorker({
              ...base,
              ...(generation === undefined ? {} : { expectedSessionGeneration: generation })
            });
      return publicWorkerResult(result);
    }
    if (name === "archive_worker") {
      assertKeys(input, ["worker_id", "expected_revision"]);
      const workerId = requiredId(input, "worker_id");
      this.#ownedWorker(lead, workerId);
      return publicWorkerResult(this.#manager.archiveWorker({
        operationId: operationId(context, name),
        workerId,
        callerLeadSessionId: lead.session.id,
        expectedRevision: requiredRevision(input, "expected_revision")
      }));
    }
    if (name === "end_goal") {
      assertKeys(input, []);
      const tree = this.#manager.getTree(lead.goalId);
      return publicTree(await this.#manager.setGoalStatus({
        operationId: operationId(context, name),
        goalId: tree.goal.id,
        callerLeadSessionId: lead.session.id,
        expectedRevision: tree.goal.revision,
        status: "stopped",
        signal
      }));
    }
    throw new CollaborationToolError("UNKNOWN_TOOL", "The requested collaboration action is unavailable.");
  }

  async #createWorker(
    input: Readonly<Record<string, unknown>>,
    lead: Extract<Caller, { readonly kind: "lead" }>,
    operationIdValue: string
  ) {
    validateWorkerSpecInput(input);
    const currentGoal = this.#manager.getTree(lead.goalId).goal;
    const providerId = optionalId(input["provider_id"], "provider_id");
    const modelId = optionalId(input["model_id"], "model_id");
    if ((providerId === undefined) !== (modelId === undefined)) {
      throw new CollaborationToolError("INVALID_ARGS", "provider_id and model_id must be supplied together.");
    }
    const caller = this.#store.getSession(lead.session.id).descriptor;
    const inheritedProvider = providerId === undefined && caller.providerId !== undefined && caller.modelId !== undefined
      ? { providerId: caller.providerId, modelId: caller.modelId }
      : providerId === undefined ? {} : { providerId, modelId: modelId! };
    const permission = optionalEnum(
      input["permission_mode"],
      "permission_mode",
      ["ask", "auto", "bypassPermissions"] as const
    ) ?? caller.permissionMode;
    const parentWorkerId = optionalId(input["parent_worker_id"], "parent_worker_id");
    const effort = optionalText(input["effort"], "effort", 64) ?? caller.effort;
    return this.#manager.createWorker({
      operationId: operationIdValue,
      goalId: lead.goalId,
      callerLeadSessionId: lead.session.id,
      expectedGoalRevision: currentGoal.revision,
      ...(parentWorkerId === undefined ? {} : { parentWorkerId }),
      label: requiredText(input, "label", 64),
      role: requiredText(input, "role", 128),
      assignment: requiredText(input, "assignment", 32_000, true),
      route: {
        targetId: optionalId(input["target_id"], "target_id") ?? caller.targetId,
        ...inheritedProvider,
        ...(effort === undefined ? {} : { effort }),
        fastMode: optionalBoolean(input["fast_mode"], "fast_mode") ?? caller.fastMode,
        permissionMode: permission as PermissionMode,
        planMode: optionalBoolean(input["plan_mode"], "plan_mode") ?? caller.planMode
      }
    });
  }

  #requireSession(context: BridgeToolCallContext): SessionDescriptor {
    const session = this.#store.getSession(context.sessionId).descriptor;
    const target = this.#store.getTarget(context.targetId).descriptor;
    if (!target.trusted) throw new CollaborationToolError("UNTRUSTED_TARGET", "Collaboration tools require a trusted Target.");
    if (session.targetId !== target.id || session.backendId !== target.backendId ||
        session.binding.generation !== context.generation || session.archived || session.deletedAt !== undefined) {
      throw new CollaborationToolError("STALE_SCOPE", "The collaboration Tool scope is stale or unavailable.");
    }
    return session;
  }

  #callerForStart(session: SessionDescriptor): Caller {
    const worker = this.#store.findCollaborationWorkerBySession(session.id);
    if (worker !== undefined) return { kind: "worker", session, worker };
    const goal = this.#store.findActiveCollaborationGoalByLeadSession(session.id);
    return { kind: "lead", session, goalId: goal?.id ?? "" };
  }

  #requireCollaborationCaller(session: SessionDescriptor): Caller {
    const worker = this.#store.findCollaborationWorkerBySession(session.id);
    if (worker !== undefined) {
      if (worker.sessionGeneration !== session.binding.generation || worker.status === "archived") {
        throw new CollaborationToolError("STALE_SCOPE", "The worker collaboration identity is stale.");
      }
      return { kind: "worker", session, worker };
    }
    const goal = this.#store.findActiveCollaborationGoalByLeadSession(session.id);
    if (goal === undefined || goal.sessionGeneration !== session.binding.generation) {
      throw new CollaborationToolError("GOAL_NOT_ACTIVE", "The current task has no active collaboration Goal.");
    }
    return { kind: "lead", session, goalId: goal.id };
  }

  #callerKind(session: SessionDescriptor): "lead" | "worker" | undefined {
    if (this.#store.findCollaborationWorkerBySession(session.id) !== undefined) return "worker";
    if (this.#store.findActiveCollaborationGoalByLeadSession(session.id) !== undefined) return "lead";
    return undefined;
  }

  #ownedWorker(lead: Extract<Caller, { readonly kind: "lead" }>, workerId: string): CollaborationWorkerRecord {
    const worker = this.#store.getCollaborationWorker(workerId);
    if (worker.goalId !== lead.goalId) {
      throw new AuthorizationError("The collaboration worker belongs to another Goal.");
    }
    return worker;
  }
}

function publicWorkerResult(result: {
  readonly tree: CollaborationGoalTreeView;
  readonly worker: CollaborationWorkerRecord;
}): Readonly<Record<string, unknown>> {
  return { tree: publicTree(result.tree), worker: publicWorker(result.worker) };
}

function publicTree(tree: CollaborationGoalTreeView): Readonly<Record<string, unknown>> {
  return {
    goal: {
      id: tree.goal.id,
      revision: tree.goal.revision.toString(10),
      lead_id: tree.goal.leadId,
      lead_session_id: tree.goal.leadSessionId,
      title: tree.goal.title,
      objective: tree.goal.objective,
      status: tree.goal.status,
      maximum_workers: tree.goal.maximumWorkers ?? null,
      created_at: tree.goal.createdAt,
      updated_at: tree.goal.updatedAt
    },
    workers: tree.workers.map(publicWorker),
    focused_worker_id: tree.focusedWorkerId ?? null,
    queue: tree.queue.map((entry) => publicDispatch(entry.dispatch, tree, entry.queueItem))
  };
}

function publicWorkerGoal(tree: CollaborationGoalTreeView, workerId: string): Readonly<Record<string, unknown>> {
  const worker = tree.workers.find((candidate) => candidate.id === workerId);
  if (worker === undefined) throw new CollaborationToolError("STALE_SCOPE", "The worker is no longer part of its Goal.");
  return {
    goal: {
      id: tree.goal.id,
      title: tree.goal.title,
      objective: tree.goal.objective,
      status: tree.goal.status
    },
    worker: publicWorker(worker)
  };
}

function publicWorker(worker: CollaborationWorkerRecord): Readonly<Record<string, unknown>> {
  return {
    id: worker.id,
    revision: worker.revision.toString(10),
    goal_id: worker.goalId,
    parent_worker_id: worker.parentWorkerId ?? null,
    session_id: worker.sessionId ?? null,
    session_generation: worker.sessionGeneration ?? null,
    label: worker.label,
    role: worker.role,
    assignment: worker.assignment,
    status: worker.status,
    focused: worker.focused,
    runtime_released: worker.runtimeReleased,
    soft_limit_warning: worker.softLimitWarning,
    route: {
      backend_id: worker.backendId,
      target_id: worker.targetId,
      provider_id: worker.providerId ?? null,
      model_id: worker.modelId ?? null,
      effort: worker.effort ?? null,
      fast_mode: worker.fastMode,
      permission_mode: worker.permissionMode,
      plan_mode: worker.planMode
    }
  };
}

function publicDispatch(
  dispatch: CollaborationDispatchRecord,
  tree: CollaborationGoalTreeView,
  queueItem = tree.queue.find((entry) => entry.dispatch.id === dispatch.id)?.queueItem
): Readonly<Record<string, unknown>> {
  return {
    id: dispatch.id,
    revision: dispatch.revision.toString(10),
    worker_id: dispatch.workerId,
    operation_id: dispatch.operationId,
    queue_item_id: dispatch.queueItemId ?? null,
    message: dispatch.message,
    status: dispatch.status,
    merged_into_dispatch_id: dispatch.mergedIntoDispatchId ?? null,
    queue: queueItem === undefined ? null : {
      id: queueItem.id,
      revision: queueItem.revision.toString(10),
      state: queueItem.state,
      created_at: queueItem.createdAt,
      updated_at: queueItem.updatedAt
    }
  };
}

function nestedTool(
  name: string,
  description: string,
  role: CollaborationToolRole,
  readOnly: boolean,
  inputSchema: Readonly<Record<string, unknown>>
): CollaborationNestedTool {
  return Object.freeze({ name, description, role, readOnly, inputSchema });
}

function tool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return Object.freeze({
    serverId: COLLABORATION_GOAL_TOOL_PROVIDER_ID,
    name,
    description,
    inputSchema,
    requiresPermission
  });
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: "object", properties, required, additionalProperties: false });
}

function operationId(context: BridgeToolCallContext, action: string): string {
  if (context.effectIdentity === undefined || !/^[a-f0-9]{64}$/u.test(context.effectIdentity)) {
    throw new CollaborationToolError("STALE_SCOPE", "The collaboration effect identity is unavailable.");
  }
  return `collaboration-tool:${action}:${context.effectIdentity}`;
}

function requireLead(caller: Caller): Extract<Caller, { readonly kind: "lead" }> {
  if (caller.kind !== "lead" || caller.goalId === "") {
    throw new CollaborationToolError("NOT_AUTHORIZED", "This collaboration action requires the active lead task.");
  }
  return caller;
}

function requireWorker(caller: Caller): Extract<Caller, { readonly kind: "worker" }> {
  if (caller.kind !== "worker") {
    throw new CollaborationToolError("NOT_AUTHORIZED", "This collaboration action requires a worker task.");
  }
  return caller;
}

function requiredWorkerGeneration(worker: CollaborationWorkerRecord): number {
  if (worker.sessionGeneration === undefined) {
    throw new CollaborationToolError("PRECONDITION_FAILED", "The collaboration worker has no bound Session generation.");
  }
  return worker.sessionGeneration;
}

function requiredGeneration(value: number | undefined): number {
  if (value === undefined) {
    throw new CollaborationToolError("INVALID_ARGS", "expected_session_generation is required.");
  }
  return value;
}

function validateWorkerSpecInput(input: Readonly<Record<string, unknown>>): void {
  assertKeys(input, [
    "label", "role", "assignment", "parent_worker_id", "target_id", "provider_id", "model_id",
    "effort", "fast_mode", "permission_mode", "plan_mode"
  ]);
  requiredText(input, "label", 64);
  requiredText(input, "role", 128);
  requiredText(input, "assignment", 32_000, true);
  optionalId(input["parent_worker_id"], "parent_worker_id");
  optionalId(input["target_id"], "target_id");
  const providerId = optionalId(input["provider_id"], "provider_id");
  const modelId = optionalId(input["model_id"], "model_id");
  if ((providerId === undefined) !== (modelId === undefined)) {
    throw new CollaborationToolError("INVALID_ARGS", "provider_id and model_id must be supplied together.");
  }
  optionalText(input["effort"], "effort", 64);
  optionalBoolean(input["fast_mode"], "fast_mode");
  optionalEnum(input["permission_mode"], "permission_mode", ["ask", "auto", "bypassPermissions"] as const);
  optionalBoolean(input["plan_mode"], "plan_mode");
}

function assertKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new CollaborationToolError("INVALID_ARGS", `Unknown collaboration arguments: ${unknown.join(", ")}.`);
  }
}

function requiredRecord(input: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = input[key];
  if (!isRecord(value)) throw new CollaborationToolError("INVALID_ARGS", `${key} must be an object.`);
  return value;
}

function requiredId(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = requiredText(input, key, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new CollaborationToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredId({ [field]: value }, field);
}

function requiredRevision(input: Readonly<Record<string, unknown>>, key: string): bigint {
  const value = input[key];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw new CollaborationToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  const revision = BigInt(value);
  if (revision > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CollaborationToolError("INVALID_ARGS", `${key} is outside the supported range.`);
  }
  return revision;
}

function optionalRevision(value: unknown, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  return requiredRevision({ [field]: value }, field);
}

function requiredText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  multiline = false
): string {
  const value = input[key];
  if (typeof value !== "string") throw new CollaborationToolError("INVALID_ARGS", `${key} must be text.`);
  const normalized = multiline ? value.replace(/\r\n?/gu, "\n").trim() : value.trim();
  const forbidden = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
    : /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
  if (normalized === "" || normalized.length > maximum || forbidden.test(normalized)) {
    throw new CollaborationToolError("INVALID_ARGS", `${key} is invalid or exceeds its limit.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximum: number, multiline = false): string | undefined {
  if (value === undefined) return undefined;
  return requiredText({ [field]: value }, field, maximum, multiline);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CollaborationToolError("INVALID_ARGS", `${field} must be boolean.`);
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CollaborationToolError("INVALID_ARGS", `${field} is outside the supported range.`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new CollaborationToolError("INVALID_ARGS", `${field} is invalid.`);
  }
  return value as T[number];
}

function success(data: unknown): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: { data },
    isError: false
  };
}

function failure(error: unknown): McpCallResult {
  const mapped = toolError(error);
  return {
    content: [{ type: "text", text: mapped.message }],
    structuredContent: { errorCode: mapped.code, message: mapped.message },
    isError: true
  };
}

function toolError(error: unknown): CollaborationToolError {
  if (error instanceof CollaborationToolError) return error;
  if (error instanceof CollaborationGoalManagerError) {
    return new CollaborationToolError(error.code, error.message);
  }
  if (error instanceof StoreError) return new CollaborationToolError(error.name, error.message);
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return new CollaborationToolError(error.code, error.message);
  }
  return new CollaborationToolError("INTERNAL", "The collaboration action could not be completed.");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class CollaborationToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CollaborationToolError";
  }
}
