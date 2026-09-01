import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import type { PromptInput, SessionDescriptor } from "@joko/core";
import {
  InvalidStateTransitionError,
  NotFoundError,
  OperationalStore,
  RevisionConflictError,
  StoreError,
  type PersistedEvent,
  type QueueItemRecord,
  type StoredSession
} from "@joko/store";

import type { MessageSearchEmbeddingCoordinator } from "./message-search-embedding.js";
import type {
  BridgeToolCallContext,
  BridgeToolPolicyDeclaration,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";
import type { SessionHost } from "./session-host.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";

export const SESSION_HELPER_TOOL_PROVIDER_ID = "joko_session_helper";
export const COLLABORATION_TOOL_POLICY_ID = "joko-collaboration-tools";
export const COLLABORATION_TOOL_POLICY: BridgeToolPolicyDeclaration = Object.freeze({
  id: COLLABORATION_TOOL_POLICY_ID,
  displayName: "Collaboration",
  description: "Delegate background work and coordinate with other tasks.",
  productDefaultEnabled: true,
  localizations: {
    "zh-CN": {
      displayName: "协同",
      description: "委派后台工作，并与其他任务协同。"
    }
  }
});

const LIST_TOOLS_NAME = "list_tools";
const CALL_TOOL_NAME = "call_tool";
const MAXIMUM_MESSAGE_LENGTH = 262_144;
const MAXIMUM_HISTORY_SESSION_IDS = 50;
const DEFAULT_WORKDIR_WINDOW_MS = 180 * 24 * 60 * 60_000;
const HISTORY_SCAN_PAGE_SIZE = 1_000;
const QUEUE_SCAN_PAGE_SIZE = 1_000;
const QUEUE_STATES = ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"] as const;
const HISTORY_ROLES = [
  "user",
  "assistant",
  "tool_use",
  "tool_result",
  "ask_user",
  "plan_review",
  "thinking"
] as const;
const DEFAULT_HISTORY_ROLES = ["user", "assistant", "ask_user", "plan_review"] as const;

type HelperCategory = "product" | "control" | "history" | "handoff";
type HistoryRole = typeof HISTORY_ROLES[number];

interface NestedToolDescriptor {
  readonly name: string;
  readonly category: HelperCategory;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
}

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: "A task identifier returned by list_sessions or send_to_session."
} as const;

const HISTORY_FILTER_PROPERTIES = {
  session_ids: {
    type: "array",
    items: ID_SCHEMA,
    maxItems: MAXIMUM_HISTORY_SESSION_IDS,
    uniqueItems: true
  },
  workdir: { type: "string", minLength: 1, maxLength: 4_096 },
  from: { type: "string", minLength: 1, maxLength: 128, description: "Inclusive ISO-8601 timestamp." },
  to: { type: "string", minLength: 1, maxLength: 128, description: "Exclusive ISO-8601 timestamp." },
  agent_kind: {
    type: "string",
    minLength: 1,
    maxLength: 256,
    description: "Optional Backend ID filter."
  },
  roles: {
    type: "array",
    items: { type: "string", enum: HISTORY_ROLES },
    uniqueItems: true,
    maxItems: HISTORY_ROLES.length
  }
} as const;

export const SESSION_HELPER_NESTED_TOOLS: readonly NestedToolDescriptor[] = Object.freeze([
  nestedTool(
    "get_capabilities",
    "product",
    "Inspect the live product, workspace, helper, search, and Backend capability surface. Omit key for a compact index.",
    objectSchema({ key: { type: "string", minLength: 1, maxLength: 128 } }),
    true
  ),
  nestedTool(
    "get_current_session_id",
    "product",
    "Return the authenticated current task ID, Backend ID, Target ID, and effective working directory.",
    objectSchema({}),
    true
  ),
  nestedTool(
    "set_current_session_title",
    "control",
    "Rename only the authenticated current task.",
    objectSchema({ title: { type: "string", minLength: 1, maxLength: 120 } }, ["title"]),
    false
  ),
  nestedTool(
    "rename_sessions",
    "control",
    "Preview or atomically rename up to 20 historical tasks. A matching confirmation token is required for writes.",
    objectSchema({
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: objectSchema({
          session_id: ID_SCHEMA,
          title: { type: "string", minLength: 1, maxLength: 120 },
          expected_current_title: { type: "string", maxLength: 120 },
          expected_updated_at: { type: "string", maxLength: 128 }
        }, ["session_id", "title"])
      },
      dry_run: { type: "boolean", default: true },
      confirmation_token: { type: "string", minLength: 1, maxLength: 32_768 }
    }, ["changes"]),
    false
  ),
  nestedTool(
    "archive_sessions",
    "control",
    "Atomically archive up to 50 tasks without deleting their history. The current task cannot archive itself.",
    objectSchema({ session_ids: idArraySchema(50) }, ["session_ids"]),
    false
  ),
  nestedTool(
    "unarchive_sessions",
    "control",
    "Atomically restore up to 50 archived tasks without reviving deleted tasks.",
    objectSchema({ session_ids: idArraySchema(50) }, ["session_ids"]),
    false
  ),
  nestedTool(
    "update_session_queued_message",
    "control",
    "Replace an unconsumed message previously sent by this calling task through send_to_session.",
    objectSchema({
      session_id: ID_SCHEMA,
      queued_message_id: ID_SCHEMA,
      message: { type: "string", minLength: 1, maxLength: MAXIMUM_MESSAGE_LENGTH }
    }, ["session_id", "queued_message_id", "message"]),
    false
  ),
  nestedTool(
    "cancel_session_queued_message",
    "control",
    "Cancel an unconsumed message previously sent by this calling task through send_to_session.",
    objectSchema({ session_id: ID_SCHEMA, queued_message_id: ID_SCHEMA }, ["session_id", "queued_message_id"]),
    false
  ),
  nestedTool(
    "steer_session",
    "control",
    "Inject a high-priority same-turn steer into another running task when its Backend advertises turn.steer.",
    objectSchema({
      session_id: ID_SCHEMA,
      message: { type: "string", minLength: 1, maxLength: MAXIMUM_MESSAGE_LENGTH }
    }, ["session_id", "message"]),
    false
  ),
  nestedTool(
    "stop_session_turn",
    "control",
    "Request interruption of another task's active turn without closing or deleting the task.",
    objectSchema({ session_id: ID_SCHEMA }, ["session_id"]),
    false
  ),
  nestedTool(
    "get_session_runtime",
    "control",
    "Read a content-free task lifecycle plus baseline, effective, pending, and generation-controlled runtime selection.",
    objectSchema({ session_id: ID_SCHEMA }),
    true
  ),
  nestedTool(
    "set_session_runtime",
    "control",
    "Atomically change a task's temporary same-Backend provider, model, effort, or Fast selection. Busy tasks defer to the next turn boundary.",
    objectSchema({
      session_id: ID_SCHEMA,
      provider_id: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] },
      model: { type: "string", minLength: 1, maxLength: 256 },
      effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
      fast: { type: "boolean" },
      expected_generation: { type: "integer", minimum: 0 }
    }, ["expected_generation"]),
    false
  ),
  nestedTool(
    "list_workdirs",
    "history",
    "List every known effective working directory with task counts and first/last activity, using bounded cursor pagination.",
    objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      cursor: { type: "string", maxLength: 4_096 },
      order: { type: "string", enum: ["asc", "desc"], default: "desc" }
    }),
    true
  ),
  nestedTool(
    "list_sessions",
    "history",
    "List task metadata and current queued counts. Use get_chat_history for message content.",
    objectSchema({
      workdir: { type: "string", minLength: 1, maxLength: 4_096 },
      from: { type: "string", minLength: 1, maxLength: 128 },
      to: { type: "string", minLength: 1, maxLength: 128 },
      agent_kind: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Optional Backend ID filter."
      },
      include_deleted: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: 1_000, default: 100 },
      cursor: { type: "string", maxLength: 4_096 },
      order: { type: "string", enum: ["asc", "desc"], default: "desc" }
    }),
    true
  ),
  nestedTool(
    "list_session_queue",
    "history",
    "Read one task's unconsumed input queue with source, position, timestamp, bounded text summary, and consuming state.",
    objectSchema({ session_id: ID_SCHEMA }, ["session_id"]),
    true
  ),
  nestedTool(
    "get_chat_history",
    "history",
    "Read durable raw chat history with exact task/workdir/time/role filters and cursor pagination. At least one main filter is required.",
    objectSchema({
      ...HISTORY_FILTER_PROPERTIES,
      include_rewound: { type: "boolean", default: false },
      include_full_history: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: 1_000, default: 200 },
      cursor: { type: "string", maxLength: 4_096 },
      order: { type: "string", enum: ["asc", "desc"], default: "desc" }
    }),
    true
  ),
  nestedTool(
    "search_chat_history",
    "history",
    "Search owner chat history with FTS and optional semantic augmentation, then return centered durable context windows.",
    objectSchema({
      query: { type: "string", minLength: 1, maxLength: 4_096 },
      ...HISTORY_FILTER_PROPERTIES,
      context_radius: { type: "integer", minimum: 0, maximum: 10, default: 2 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      cursor: { type: "string", maxLength: 32_768 }
    }, ["query"]),
    true
  ),
  nestedTool(
    "send_to_session",
    "handoff",
    "Send to an exact existing task or create a normal visible task. Existing tasks queue while busy; isolated workspace creation fails closed.",
    objectSchema({
      target_session_id: ID_SCHEMA,
      message: { type: "string", minLength: 1, maxLength: MAXIMUM_MESSAGE_LENGTH },
      title: { type: "string", minLength: 1, maxLength: 120 },
      use_worktree: { type: "boolean" },
      working_dir: { type: "string", minLength: 1, maxLength: 4_096 },
      agent_kind: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Optional destination Backend ID."
      },
      model: { type: "string", minLength: 1, maxLength: 256 },
      effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
      fast: { type: "boolean" }
    }, ["message"]),
    false
  )
]);

export const SESSION_HELPER_NESTED_TOOL_NAMES = Object.freeze(
  SESSION_HELPER_NESTED_TOOLS.map((tool) => tool.name)
);

const BRIDGE_TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  {
    serverId: SESSION_HELPER_TOOL_PROVIDER_ID,
    name: LIST_TOOLS_NAME,
    description: "Discover owner-scoped product, task control, history, and handoff tools by category.",
    inputSchema: objectSchema({
      category: { type: "string", enum: ["product", "control", "history", "handoff"] }
    }),
    requiresPermission: false
  },
  {
    serverId: SESSION_HELPER_TOOL_PROVIDER_ID,
    name: CALL_TOOL_NAME,
    description: "Invoke one nested task helper tool after discovering its exact schema with list_tools.",
    inputSchema: objectSchema({
      name: { type: "string", minLength: 1, maxLength: 128 },
      args: { type: "object", additionalProperties: {} }
    }, ["name", "args"]),
    requiresPermission: true
  }
]);

type HelperHost = Pick<
  SessionHost,
  "abort" | "createServiceSession" | "enqueueServiceInput" | "getSessionRuntimeControl" |
  "isSessionActive" | "resume" | "sessionRuntimeFallbackEnabled" | "setSessionRuntimeControl"
>;

export interface SessionHelperToolProviderOptions {
  readonly store: OperationalStore;
  readonly host: () => HelperHost | undefined;
  readonly messageSearch?: () => Pick<MessageSearchEmbeddingCoordinator, "embedQuery"> | undefined;
  readonly now?: () => number;
}

interface HistoryMessage {
  readonly event: PersistedEvent;
  readonly role: HistoryRole;
  readonly content: unknown;
  readonly toolUseId?: string;
  readonly agentMeta?: Readonly<Record<string, unknown>>;
}

interface RenameChange {
  readonly sessionId: string;
  readonly title: string;
  readonly expectedCurrentTitle?: string;
  readonly expectedUpdatedAt?: string;
}

interface RenameConfirmation {
  readonly v: 1;
  readonly changes: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly expectedCurrentTitle: string | null;
    readonly expectedUpdatedAt: string | null;
    readonly approvedCurrentTitle: string;
    readonly approvedRevision: string;
  }[];
}

/**
 * Owner-scoped helper exposed through a two-tool progressive-discovery
 * surface. Every call is authenticated from the immutable Pi bridge grant;
 * task, Target, and generation identity are never accepted from model input.
 */
export class SessionHelperToolBridgeProvider implements BridgeToolProvider {
  readonly id = SESSION_HELPER_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly configurablePolicy = COLLABORATION_TOOL_POLICY;
  readonly tools = BRIDGE_TOOLS;
  readonly #store: OperationalStore;
  readonly #host: () => HelperHost | undefined;
  readonly #messageSearch: () => Pick<MessageSearchEmbeddingCoordinator, "embedQuery"> | undefined;
  readonly #now: () => number;
  readonly #confirmationSecret = randomBytes(32);

  constructor(options: SessionHelperToolProviderOptions) {
    this.#store = options.store;
    this.#host = options.host;
    this.#messageSearch = options.messageSearch ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    if (SESSION_HELPER_NESTED_TOOLS.length !== 18) {
      throw new Error("The task helper catalog must expose exactly eighteen applicable nested tools.");
    }
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
      const caller = this.#requireCaller(context);
      if (name === LIST_TOOLS_NAME) return this.#listTools(arguments_);
      if (name !== CALL_TOOL_NAME) throw new Error("Task helper tool is not part of this runtime snapshot.");
      assertKeys(arguments_, ["name", "args"]);
      const selectedName = requiredText(arguments_, "name", 128);
      const selected = SESSION_HELPER_NESTED_TOOLS.find((tool) => tool.name === selectedName);
      if (selected === undefined) {
        return toolFailure(new SessionHelperError("UNKNOWN_TOOL", "The requested nested task helper is unavailable."), {
          requested: selectedName,
          available: SESSION_HELPER_NESTED_TOOL_NAMES
        });
      }
      const selectedArguments = coerceRecord(arguments_["args"]);
      if (selectedArguments === undefined) {
        return toolFailure(new SessionHelperError("INVALID_ARGS", "args must be a JSON object."), {
          tool: selected.name,
          schema: selected.inputSchema
        });
      }
      const data = await this.#dispatch(selected.name, selectedArguments, caller, context, signal);
      signal?.throwIfAborted();
      return toolResult(data);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      return toolFailure(error);
    }
  }

  #requireCaller(context: BridgeToolCallContext): SessionDescriptor {
    const session = this.#store.getSession(context.sessionId).descriptor;
    const target = this.#store.getTarget(context.targetId).descriptor;
    if (!target.trusted) throw new SessionHelperError("UNTRUSTED_TARGET", "Task helpers require a trusted workspace.");
    if (
      session.id !== context.sessionId ||
      session.targetId !== context.targetId ||
      session.backendId !== target.backendId ||
      session.binding.generation !== context.generation ||
      session.archived ||
      session.deletedAt !== undefined
    ) {
      throw new SessionHelperError("STALE_SCOPE", "Task helper scope is stale or unavailable.");
    }
    if (this.#store.findSessionRuntimePolicy(session.id)?.policy === "review_read_only") {
      throw new SessionHelperError("UNSUPPORTED_CAPABILITY", "Reviewer runtimes cannot use owner task controls.");
    }
    return session;
  }

  #listTools(arguments_: Readonly<Record<string, unknown>>): McpCallResult {
    assertKeys(arguments_, ["category"]);
    const categoryValue = arguments_["category"];
    if (categoryValue === undefined) {
      const categories = (["product", "control", "history", "handoff"] as const).map((category) => ({
        name: category,
        tool_count: SESSION_HELPER_NESTED_TOOLS.filter((tool) => tool.category === category).length
      }));
      return toolResult({
        categories,
        hint: "Call list_tools with one category to inspect exact nested tool schemas."
      });
    }
    if (!isHelperCategory(categoryValue)) {
      throw new SessionHelperError("INVALID_ARGS", "category must be product, control, history, or handoff.");
    }
    return toolResult({
      category: categoryValue,
      tools: SESSION_HELPER_NESTED_TOOLS
        .filter((tool) => tool.category === categoryValue)
        .map((tool) => ({
          name: tool.name,
          category: tool.category,
          description: tool.description,
          read_only: tool.readOnly,
          input_schema: tool.inputSchema
        }))
    });
  }

  async #dispatch(
    name: string,
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor,
    context: BridgeToolCallContext,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    switch (name) {
      case "get_capabilities": return this.#getCapabilities(input, caller);
      case "get_current_session_id": return this.#getCurrentSessionId(input, caller);
      case "set_current_session_title": return this.#setCurrentSessionTitle(input, caller);
      case "rename_sessions": return this.#renameSessions(input);
      case "archive_sessions": return this.#setArchived(input, caller, true);
      case "unarchive_sessions": return this.#setArchived(input, caller, false);
      case "update_session_queued_message": return this.#updateQueuedMessage(input, caller);
      case "cancel_session_queued_message": return this.#cancelQueuedMessage(input, caller);
      case "steer_session": return this.#steerSession(input, caller);
      case "stop_session_turn": return this.#stopSessionTurn(input);
      case "get_session_runtime": return this.#getSessionRuntime(input, caller);
      case "set_session_runtime": return this.#setSessionRuntime(input, caller);
      case "list_workdirs": return this.#listWorkdirs(input);
      case "list_sessions": return this.#listSessions(input);
      case "list_session_queue": return this.#listSessionQueue(input);
      case "get_chat_history": return this.#getChatHistory(input);
      case "search_chat_history": return this.#searchChatHistory(input, signal);
      case "send_to_session": return this.#sendToSession(input, caller, context);
      default: throw new SessionHelperError("UNKNOWN_TOOL", "The requested nested task helper is unavailable.");
    }
  }

  #getCapabilities(input: Readonly<Record<string, unknown>>, caller: SessionDescriptor): unknown {
    assertKeys(input, ["key"]);
    const index = [
      { key: "backend-capabilities", title: "Backend capabilities", oneLiner: "Live capability manifest and supported options." },
      { key: "session-helper", title: "Task helpers", oneLiner: "Owner history, task control, queue ownership, and handoff surface." },
      { key: "workspace", title: "Current workspace", oneLiner: "Authenticated Target and isolated-workspace binding." },
      { key: "history-search", title: "History search", oneLiner: "Durable keyword and optional semantic retrieval status." }
    ] as const;
    const key = optionalText(input["key"], "key", 128);
    if (key === undefined) return { capabilities: index, hint: "Pass one capability key for live detail." };
    const target = this.#store.getTarget(caller.targetId).descriptor;
    const backend = this.#store.getBackend(caller.backendId).descriptor;
    switch (key) {
      case "backend-capabilities":
        return {
          capability: {
            ...index[0],
            detail: [...backend.capabilities.values()]
              .map((capability) => ({
                key: capability.key,
                supported: capability.supported,
                ...(capability.reason === undefined ? {} : { reason: capability.reason }),
                ...(capability.detail === undefined ? {} : { detail: capability.detail }),
                ...(capability.options === undefined ? {} : { options: capability.options })
              }))
              .sort((left, right) => left.key.localeCompare(right.key))
          }
        };
      case "session-helper":
        return {
          capability: {
            ...index[1],
            detail: (["product", "control", "history", "handoff"] as const).map((category) => ({
              category,
              tools: SESSION_HELPER_NESTED_TOOLS.filter((tool) => tool.category === category).map((tool) => tool.name)
            }))
          }
        };
      case "workspace":
        return {
          capability: {
            ...index[2],
            detail: {
              target_id: target.id,
              display_name: target.displayName,
              trusted: target.trusted,
              managed: target.managed,
              working_dir: effectiveWorkdir(this.#store, caller),
              isolated_workspace: caller.worktree === undefined
                ? null
                : {
                    state: caller.worktree.state,
                    branch: caller.worktree.branch,
                    source_ref: caller.worktree.sourceRef
                  },
              remote: caller.remoteWorkspace !== undefined || target.remoteWorkspace !== undefined
            }
          }
        };
      case "history-search": {
        const status = this.#store.messageEmbeddingStatus();
        return {
          capability: {
            ...index[3],
            detail: {
              keyword_available: true,
              semantic_enabled: status.enabled,
              vector_available: status.vectorAvailable,
              pending_count: status.pendingCount,
              failed_count: status.failedCount
            }
          }
        };
      }
      default:
        throw new SessionHelperError("UNKNOWN_KEY", "The requested capability key is unavailable.", {
          requested: key,
          available: index.map((item) => item.key)
        });
    }
  }

  #getCurrentSessionId(input: Readonly<Record<string, unknown>>, caller: SessionDescriptor): unknown {
    assertKeys(input, []);
    return {
      session_id: caller.id,
      agent_kind: caller.backendId,
      target_id: caller.targetId,
      working_dir: effectiveWorkdir(this.#store, caller)
    };
  }

  #setCurrentSessionTitle(input: Readonly<Record<string, unknown>>, caller: SessionDescriptor): unknown {
    assertKeys(input, ["title"]);
    const title = normalizeTitle(requiredText(input, "title", 120));
    if (title === "") throw new SessionHelperError("INVALID_ARGS", "title cannot be blank.");
    const current = this.#store.getSession(caller.id);
    const updated = this.#store.updateSession(current.descriptor.id, { title }, current.revision, this.#now());
    return { session_id: updated.descriptor.id, title: updated.descriptor.title };
  }

  #renameSessions(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["changes", "dry_run", "confirmation_token"]);
    const changesValue = input["changes"];
    if (!Array.isArray(changesValue) || changesValue.length < 1 || changesValue.length > 20) {
      throw new SessionHelperError("INVALID_ARGS", "changes must contain between 1 and 20 items.");
    }
    const changes: RenameChange[] = changesValue.map((value, index) => {
      if (!isRecord(value)) throw new SessionHelperError("INVALID_ARGS", `changes[${index}] must be an object.`);
      assertKeys(value, ["session_id", "title", "expected_current_title", "expected_updated_at"]);
      const title = normalizeTitle(requiredText(value, "title", 120));
      if (title === "") throw new SessionHelperError("INVALID_ARGS", `changes[${index}].title cannot be blank.`);
      return {
        sessionId: requiredId(value, "session_id"),
        title,
        ...(optionalText(value["expected_current_title"], "expected_current_title", 120) === undefined
          ? {}
          : { expectedCurrentTitle: optionalText(value["expected_current_title"], "expected_current_title", 120) }),
        ...(optionalIso(value["expected_updated_at"], "expected_updated_at") === undefined
          ? {}
          : { expectedUpdatedAt: optionalIso(value["expected_updated_at"], "expected_updated_at") })
      };
    });
    assertUnique(changes.map((change) => change.sessionId), "session_id");
    const dryRun = optionalBoolean(input["dry_run"], "dry_run") ?? true;
    const previews = changes.map((change) => this.#renamePreview(change));

    if (dryRun) {
      const confirmation: RenameConfirmation = {
        v: 1,
        changes: changes.map((change, index) => ({
          sessionId: change.sessionId,
          title: change.title,
          expectedCurrentTitle: change.expectedCurrentTitle ?? null,
          expectedUpdatedAt: change.expectedUpdatedAt ?? null,
          approvedCurrentTitle: previews[index]!.currentTitle,
          approvedRevision: previews[index]!.revision
        }))
      };
      return {
        dry_run: true,
        confirmation_token: this.#encodeConfirmation(confirmation),
        changes: previews.map(publicRenamePreview)
      };
    }

    const token = optionalText(input["confirmation_token"], "confirmation_token", 32_768);
    const confirmation = token === undefined ? undefined : this.#decodeConfirmation(token);
    if (confirmation === undefined || !confirmationMatches(confirmation, changes)) {
      throw new SessionHelperError(
        "CONFIRMATION_REQUIRED",
        "Run the same rename batch with dry_run=true, then retry with its matching confirmation_token."
      );
    }
    const approvedById = new Map(confirmation.changes.map((change) => [change.sessionId, change] as const));
    const committed = this.#store.transaction((store) => changes.map((change) => {
      const current = store.getSession(change.sessionId);
      const approved = approvedById.get(change.sessionId)!;
      if (current.descriptor.deletedAt !== undefined) {
        throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} is deleted.`);
      }
      const expectedTitle = change.expectedCurrentTitle ?? approved.approvedCurrentTitle;
      if (current.descriptor.title !== expectedTitle) {
        throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} changed after preview.`);
      }
      if (change.expectedUpdatedAt !== undefined && iso(current.descriptor.updatedAt) !== change.expectedUpdatedAt) {
        throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} update time changed.`);
      }
      if (current.revision.toString(10) !== approved.approvedRevision) {
        throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} changed after preview.`);
      }
      return store.updateSession(change.sessionId, { title: change.title }, current.revision, this.#now());
    }));
    return {
      dry_run: false,
      changes: committed.map((session, index) => publicRenamePreview({
        sessionId: session.descriptor.id,
        currentTitle: previews[index]!.currentTitle,
        newTitle: session.descriptor.title,
        workingDir: effectiveWorkdir(this.#store, session.descriptor),
        updatedAt: iso(session.descriptor.updatedAt),
        revision: session.revision.toString(10)
      }))
    };
  }

  #renamePreview(change: RenameChange): RenamePreview {
    const session = this.#store.getSession(change.sessionId);
    if (session.descriptor.deletedAt !== undefined) {
      throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} is deleted.`);
    }
    this.#assertOwnerControlledTarget(change.sessionId);
    if (change.expectedCurrentTitle !== undefined && session.descriptor.title !== change.expectedCurrentTitle) {
      throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} title does not match the precondition.`);
    }
    if (change.expectedUpdatedAt !== undefined && iso(session.descriptor.updatedAt) !== change.expectedUpdatedAt) {
      throw new SessionHelperError("PRECONDITION_FAILED", `Task ${change.sessionId} update time does not match the precondition.`);
    }
    return {
      sessionId: session.descriptor.id,
      currentTitle: session.descriptor.title,
      newTitle: change.title,
      workingDir: effectiveWorkdir(this.#store, session.descriptor),
      updatedAt: iso(session.descriptor.updatedAt),
      revision: session.revision.toString(10)
    };
  }

  #encodeConfirmation(value: RenameConfirmation): string {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const digest = createHmac("sha256", this.#confirmationSecret).update(encoded).digest("base64url");
    return `v1.${encoded}.${digest}`;
  }

  #decodeConfirmation(token: string): RenameConfirmation | undefined {
    const [version, encoded, digest, extra] = token.split(".");
    if (version !== "v1" || encoded === undefined || digest === undefined || extra !== undefined) return undefined;
    const expected = createHmac("sha256", this.#confirmationSecret).update(encoded).digest("base64url");
    if (digest !== expected) return undefined;
    try {
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
      return validRenameConfirmation(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  #setArchived(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor,
    archived: boolean
  ): unknown {
    assertKeys(input, ["session_ids"]);
    const sessionIds = requiredIdArray(input["session_ids"], "session_ids", 50);
    if (archived && sessionIds.includes(caller.id)) {
      throw new SessionHelperError("INVALID_ARGS", "The authenticated current task cannot archive itself.");
    }
    const current = sessionIds.map((sessionId) => {
      const session = this.#store.getSession(sessionId);
      if (session.descriptor.deletedAt !== undefined) {
        throw new SessionHelperError("PRECONDITION_FAILED", `Task ${sessionId} is deleted.`);
      }
      this.#assertOwnerControlledTarget(sessionId);
      return session;
    });
    const changed = this.#store.transaction((store) => current.map((session) =>
      store.updateSession(
        session.descriptor.id,
        { archived },
        session.revision,
        this.#now()
      )
    ));
    return {
      status: archived ? "archived" : "active",
      count: changed.length,
      changed: changed.map((session) => ({
        session_id: session.descriptor.id,
        title: session.descriptor.title,
        working_dir: effectiveWorkdir(this.#store, session.descriptor),
        status: session.descriptor.archived ? "archived" : "active"
      }))
    };
  }

  #updateQueuedMessage(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor
  ): unknown {
    assertKeys(input, ["session_id", "queued_message_id", "message"]);
    const sessionId = requiredId(input, "session_id");
    const item = this.#ownedAcceptedQueueItem(
      caller.id,
      sessionId,
      requiredId(input, "queued_message_id")
    );
    const message = requiredText(input, "message", MAXIMUM_MESSAGE_LENGTH);
    const updated = this.#store.editQueueItem({
      queueItemId: item.id,
      body: { ...item.body, text: message },
      expectedRevision: item.revision,
      traceId: `session-helper:${caller.id}:queue-edit:${item.id}`,
      at: this.#now()
    });
    return { session_id: sessionId, queued_message_id: updated.id, updated: true };
  }

  #cancelQueuedMessage(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor
  ): unknown {
    assertKeys(input, ["session_id", "queued_message_id"]);
    const sessionId = requiredId(input, "session_id");
    const item = this.#ownedAcceptedQueueItem(
      caller.id,
      sessionId,
      requiredId(input, "queued_message_id")
    );
    const cancelled = this.#store.cancelQueueItem({
      queueItemId: item.id,
      expectedRevision: item.revision,
      traceId: `session-helper:${caller.id}:queue-cancel:${item.id}`,
      at: this.#now()
    });
    return { session_id: sessionId, queued_message_id: cancelled.id, cancelled: true };
  }

  #ownedAcceptedQueueItem(callerSessionId: string, targetSessionId: string, queueItemId: string): QueueItemRecord {
    this.#requireMutableTarget(targetSessionId);
    const item = this.#store.getQueueItem(queueItemId);
    if (item.sessionId !== targetSessionId) {
      throw new SessionHelperError("QUEUED_MESSAGE_NOT_FOUND", "The queued message does not belong to the target task.");
    }
    if (helperQueueOrigin(this.#store, item) !== callerSessionId) {
      throw new SessionHelperError("NOT_AUTHORIZED", "Only the task that sent this helper message may change it.");
    }
    if (item.state !== "accepted") {
      throw new SessionHelperError("MESSAGE_CONSUMING", "The queued message is already being consumed or is terminal.");
    }
    return item;
  }

  #steerSession(input: Readonly<Record<string, unknown>>, caller: SessionDescriptor): unknown {
    assertKeys(input, ["session_id", "message"]);
    const sessionId = requiredId(input, "session_id");
    const target = this.#requireMutableTarget(sessionId);
    const capability = this.#store.getBackend(target.descriptor.backendId).descriptor.capabilities.get("turn.steer");
    if (capability?.supported !== true) {
      throw new SessionHelperError("UNSUPPORTED_CAPABILITY", "The target Backend does not advertise turn.steer.");
    }
    if (activeTurn(this.#store, sessionId) === undefined) {
      throw new SessionHelperError("NO_ACTIVE_TURN", "The target task has no active turn to steer.");
    }
    const queued = this.#requireHost().enqueueServiceInput({
      operationId: randomUUID(),
      sessionId,
      source: "system",
      originSessionId: caller.id,
      prompt: prompt(requiredText(input, "message", MAXIMUM_MESSAGE_LENGTH), "steer")
    });
    return { session_id: sessionId, queued_message_id: queued.value.queueItemId, steered: true };
  }

  async #stopSessionTurn(input: Readonly<Record<string, unknown>>): Promise<unknown> {
    assertKeys(input, ["session_id"]);
    const sessionId = requiredId(input, "session_id");
    const target = this.#requireMutableTarget(sessionId);
    const capability = this.#store.getBackend(target.descriptor.backendId).descriptor.capabilities.get("turn.abort");
    if (capability?.supported !== true) {
      throw new SessionHelperError("UNSUPPORTED_CAPABILITY", "The target Backend does not advertise turn.abort.");
    }
    const run = activeTurn(this.#store, sessionId);
    if (run === undefined) return { session_id: sessionId, status: "no-active-turn" };
    await this.#requireHost().abort(sessionId, run.descriptor.id);
    return {
      session_id: sessionId,
      status: "requested",
      turn_generation: target.descriptor.binding.generation
    };
  }

  #getSessionRuntime(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor
  ): unknown {
    assertKeys(input, ["session_id"]);
    const sessionId = optionalId(input["session_id"], "session_id") ?? caller.id;
    const stored = this.#store.getSession(sessionId);
    const active = activeTurn(this.#store, sessionId);
    const latest = active ?? this.#store.listRuns({ sessionId, limit: 1 })[0];
    const phase = runtimePhase(stored.descriptor, active?.descriptor.state, latest?.descriptor.state);
    const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
    const lastEvent = this.#store.listEvents({ sessionId, order: "desc", limit: 1 })[0];
    const runtime = this.#requireHost().getSessionRuntimeControl(sessionId);
    return {
      session_id: sessionId,
      phase,
      active: active !== undefined,
      record_status: stored.descriptor.deletedAt !== undefined
        ? "deleted"
        : stored.descriptor.archived
          ? "archived"
          : "active",
      source: latest?.descriptor.source ?? "user",
      attention: stored.descriptor.attention?.kind ?? null,
      workflow: "task",
      turn_generation: stored.descriptor.binding.generation,
      started_at: latest?.descriptor.startedAt === undefined ? null : iso(latest.descriptor.startedAt),
      last_activity_at: lastEvent === undefined ? iso(stored.descriptor.updatedAt) : iso(lastEvent.emittedAt),
      current_action_summary: active === undefined ? null : active.descriptor.state,
      graceful_stop_state: active === undefined
        ? "idle"
        : backend.capabilities.get("turn.abort")?.supported === true
          ? "available"
          : "unsupported",
      generation: runtime.generation,
      baseline: runtime.baseline === undefined ? null : sessionRuntimeProfilePayload(runtime.baseline),
      effective: runtime.effective === undefined ? null : sessionRuntimeProfilePayload(runtime.effective),
      pending: runtime.pending === undefined ? null : {
        generation: runtime.pending.generation,
        source: runtime.pending.source,
        profile: sessionRuntimeProfilePayload(runtime.pending.profile)
      },
      fallback_enabled: this.#requireHost().sessionRuntimeFallbackEnabled()
    };
  }

  async #setSessionRuntime(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor
  ): Promise<unknown> {
    assertKeys(input, ["session_id", "provider_id", "model", "effort", "fast", "expected_generation"]);
    const sessionId = optionalId(input["session_id"], "session_id") ?? caller.id;
    this.#requireMutableTarget(sessionId);
    const expectedGeneration = optionalInteger(
      input["expected_generation"],
      "expected_generation",
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (expectedGeneration === undefined) {
      throw new SessionHelperError("INVALID_ARGS", "expected_generation is required; read get_session_runtime first.");
    }
    const providerValue = input["provider_id"];
    const providerId = providerValue === null
      ? null
      : optionalText(providerValue, "provider_id", 256)?.trim();
    const modelId = optionalText(input["model"], "model", 256)?.trim();
    const effort = optionalEffort(input["effort"]);
    const fastMode = optionalBoolean(input["fast"], "fast");
    if (providerId === undefined && modelId === undefined && effort === undefined && fastMode === undefined) {
      throw new SessionHelperError("INVALID_ARGS", "At least one runtime selection axis is required.");
    }
    const result = await this.#requireHost().setSessionRuntimeControl({
      sessionId,
      expectedGeneration,
      patch: {
        ...(providerId === undefined ? {} : { providerId }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(effort === undefined ? {} : { effort }),
        ...(fastMode === undefined ? {} : { fastMode })
      }
    });
    return {
      session_id: sessionId,
      status: result.status,
      generation: result.generation,
      effective: sessionRuntimeProfilePayload(result.effective),
      pending: result.pending === undefined ? null : {
        generation: result.pending.generation,
        source: result.pending.source,
        profile: sessionRuntimeProfilePayload(result.pending.profile)
      },
      effective_boundary: result.status === "deferred" ? "next_turn" : "immediate"
    };
  }

  #requireMutableTarget(sessionId: string): StoredSession {
    const session = this.#store.getSession(sessionId);
    if (session.descriptor.deletedAt !== undefined) throw new SessionHelperError("DELETED", "The target task is deleted.");
    if (session.descriptor.archived) throw new SessionHelperError("ARCHIVED", "The target task is archived.");
    this.#assertOwnerControlledTarget(sessionId);
    return session;
  }

  #assertOwnerControlledTarget(sessionId: string): void {
    if (this.#store.findSessionRuntimePolicy(sessionId)?.policy === "review_read_only") {
      throw new SessionHelperError("UNSUPPORTED_CAPABILITY", "Reviewer tasks reject cross-task controls.");
    }
  }

  #requireHost(): HelperHost {
    const host = this.#host();
    if (host === undefined) throw new SessionHelperError("HOST_NOT_READY", "Task runtime services are not ready.");
    return host;
  }

  #listWorkdirs(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["limit", "cursor", "order"]);
    const limit = optionalInteger(input["limit"], "limit", 1, 500) ?? 50;
    const order = historyOrder(input["order"]);
    const cursorText = optionalText(input["cursor"], "cursor", 4_096);
    const cursor = decodeOffsetCursor(cursorText, "workdirs");
    const groups = new Map<string, {
      workingDir: string;
      sessionCount: number;
      firstSessionAt: number;
      lastSessionAt: number;
      agentKinds: Set<string>;
    }>();
    for (const stored of this.#store.listSessions({ includeArchived: true })) {
      const session = stored.descriptor;
      const workingDir = effectiveWorkdir(this.#store, session);
      const current = groups.get(workingDir);
      if (current === undefined) {
        groups.set(workingDir, {
          workingDir,
          sessionCount: 1,
          firstSessionAt: session.createdAt,
          lastSessionAt: session.updatedAt,
          agentKinds: new Set([session.backendId])
        });
      } else {
        current.sessionCount += 1;
        current.firstSessionAt = Math.min(current.firstSessionAt, session.createdAt);
        current.lastSessionAt = Math.max(current.lastSessionAt, session.updatedAt);
        current.agentKinds.add(session.backendId);
      }
    }
    const sorted = [...groups.values()].sort((left, right) => compareNumberThenText(
      left.lastSessionAt,
      right.lastSessionAt,
      left.workingDir,
      right.workingDir,
      order
    ));
    const page = offsetPage(sorted, cursor?.offset ?? 0, limit, "workdirs");
    return {
      workdirs: page.items.map((item) => ({
        workingDir: item.workingDir,
        sessionCount: item.sessionCount,
        firstSessionAt: iso(item.firstSessionAt),
        lastSessionAt: iso(item.lastSessionAt),
        agentKinds: [...item.agentKinds].sort((left, right) => left.localeCompare(right))
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      ...(cursorText !== undefined && cursor === undefined ? { warning: "INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE" } : {})
    };
  }

  #listSessions(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, [
      "workdir",
      "from",
      "to",
      "agent_kind",
      "include_deleted",
      "limit",
      "cursor",
      "order"
    ]);
    const workdir = optionalText(input["workdir"], "workdir", 4_096);
    const from = optionalIsoMs(input["from"], "from");
    const to = optionalIsoMs(input["to"], "to");
    assertTimeRange(from, to);
    const agentKind = optionalAgentKind(input["agent_kind"]);
    const includeDeleted = optionalBoolean(input["include_deleted"], "include_deleted") ?? false;
    const limit = optionalInteger(input["limit"], "limit", 1, 1_000) ?? 100;
    const order = historyOrder(input["order"]);
    const cursorText = optionalText(input["cursor"], "cursor", 4_096);
    const cursor = decodeOffsetCursor(cursorText, "sessions");
    const sessions = this.#store.listSessions({ includeArchived: true, includeDeleted })
      .filter((stored) => workdir === undefined || effectiveWorkdir(this.#store, stored.descriptor) === workdir)
      .filter((stored) => from === undefined || stored.descriptor.createdAt >= from)
      .filter((stored) => to === undefined || stored.descriptor.createdAt < to)
      .filter((stored) => agentKind === undefined || stored.descriptor.backendId === agentKind)
      .sort((left, right) => compareNumberThenText(
        left.descriptor.createdAt,
        right.descriptor.createdAt,
        left.descriptor.id,
        right.descriptor.id,
        order
      ));
    const page = offsetPage(sessions, cursor?.offset ?? 0, limit, "sessions");
    return {
      sessions: page.items.map((stored) => {
        const session = stored.descriptor;
        const queuedCount = this.#store.countQueueItems({
          sessionId: session.id,
          states: QUEUE_STATES
        });
        return {
          id: session.id,
          title: session.title,
          workingDir: effectiveWorkdir(this.#store, session),
          agentKind: session.backendId,
          workspaceKind: session.worktree !== undefined
            ? "worktree"
            : session.remoteWorkspace !== undefined
              ? "remote"
              : "target",
          model: session.modelId ?? "",
          status: session.deletedAt !== undefined ? "deleted" : session.archived ? "archived" : "active",
          source: "task",
          createdAt: iso(session.createdAt),
          updatedAt: iso(session.updatedAt),
          messageCount: countConversationMessages(this.#store, session.id),
          queuedCount
        };
      }),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      query: {
        workdir: workdir ?? null,
        from: input["from"] ?? null,
        to: input["to"] ?? null,
        agent_kind: agentKind ?? null,
        include_deleted: includeDeleted,
        limit,
        order
      },
      ...(cursorText !== undefined && cursor === undefined ? { warning: "INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE" } : {})
    };
  }

  #listSessionQueue(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["session_id"]);
    const sessionId = requiredId(input, "session_id");
    this.#store.getSession(sessionId);
    const items = listSessionQueueItems(this.#store, sessionId);
    const sessionTitles = new Map(this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .map((session) => [session.descriptor.id, session.descriptor.title] as const));
    return {
      session_id: sessionId,
      queued_count: items.length,
      queue: items.map((item, index) => {
        const operation = this.#store.findOperation(item.operationId);
        const origin = helperQueueOrigin(this.#store, item);
        const source = operation?.kind === "schedule_dispatch" || this.#store.getRun(item.runId).descriptor.source === "schedule"
          ? "scheduler"
          : origin === undefined
            ? "user"
            : "session";
        const sourceLabel = origin === undefined ? undefined : sessionTitles.get(origin);
        const summary = summarizeText(item.body.text, 500);
        return {
          queued_message_id: item.id,
          position: index + 1,
          source,
          ...(sourceLabel === undefined ? {} : { source_label: sourceLabel }),
          enqueued_at: iso(item.createdAt),
          content_summary: summary.text,
          truncated: summary.truncated,
          consuming: item.state !== "accepted"
        };
      })
    };
  }

  #getChatHistory(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, [
      "session_ids",
      "workdir",
      "from",
      "to",
      "agent_kind",
      "roles",
      "include_rewound",
      "include_full_history",
      "limit",
      "cursor",
      "order"
    ]);
    const requestedSessionIds = optionalIdArray(input["session_ids"], "session_ids", MAXIMUM_HISTORY_SESSION_IDS);
    const workdir = optionalText(input["workdir"], "workdir", 4_096);
    let from = optionalIsoMs(input["from"], "from");
    const to = optionalIsoMs(input["to"], "to");
    assertTimeRange(from, to);
    const agentKind = optionalAgentKind(input["agent_kind"]);
    if ((requestedSessionIds?.length ?? 0) === 0 && workdir === undefined && from === undefined && to === undefined) {
      throw new SessionHelperError(
        "INVALID_FILTER",
        "At least one of session_ids, workdir, from, or to is required to read chat history."
      );
    }
    const includeFullHistory = optionalBoolean(input["include_full_history"], "include_full_history") ?? false;
    const autoWindowApplied = workdir !== undefined && (requestedSessionIds?.length ?? 0) === 0 && from === undefined && !includeFullHistory;
    if (autoWindowApplied) from = this.#now() - DEFAULT_WORKDIR_WINDOW_MS;
    const includeRewound = optionalBoolean(input["include_rewound"], "include_rewound") ?? false;
    const roles = historyRoles(input["roles"]);
    const limit = optionalInteger(input["limit"], "limit", 1, 1_000) ?? 200;
    const order = historyOrder(input["order"]);
    const cursorText = optionalText(input["cursor"], "cursor", 4_096);
    const cursor = decodeHistoryCursor(cursorText);
    const sessions = historySessionScope(this.#store, requestedSessionIds, workdir, agentKind);
    const page = this.#scanHistory({
      sessionIds: sessions.map((session) => session.descriptor.id),
      roles,
      from,
      to,
      includeTombstoned: includeRewound,
      limit,
      order,
      cursor: cursor?.cursor
    });
    const sessionsById = new Map(sessions.map((session) => [session.descriptor.id, session.descriptor] as const));
    const sessionMetadata: Record<string, unknown> = {};
    for (const item of page.items) {
      const session = sessionsById.get(item.event.sessionId);
      if (session !== undefined && sessionMetadata[session.id] === undefined) {
        sessionMetadata[session.id] = {
          workingDir: effectiveWorkdir(this.#store, session),
          agentKind: session.backendId,
          title: session.title
        };
      }
    }
    return {
      sessions: sessionMetadata,
      messages: page.items.map(publicHistoryMessage),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      query: {
        session_ids: requestedSessionIds ?? null,
        workdir: workdir ?? null,
        from: input["from"] ?? null,
        to: input["to"] ?? null,
        agent_kind: agentKind ?? null,
        roles,
        roles_defaulted: input["roles"] === undefined,
        include_rewound: includeRewound,
        include_full_history: includeFullHistory,
        auto_window_days: autoWindowApplied ? 180 : 0,
        effective_from: from === undefined ? null : iso(from),
        limit,
        order
      },
      ...(cursorText !== undefined && cursor === undefined ? { warning: "INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE" } : {})
    };
  }

  #scanHistory(input: {
    readonly sessionIds: readonly string[];
    readonly roles: readonly HistoryRole[];
    readonly from?: number;
    readonly to?: number;
    readonly includeTombstoned: boolean;
    readonly limit: number;
    readonly order: "asc" | "desc";
    readonly cursor?: bigint;
  }): { readonly items: readonly HistoryMessage[]; readonly nextCursor: string | null; readonly hasMore: boolean } {
    if (input.sessionIds.length === 0 || input.roles.length === 0) return { items: [], nextCursor: null, hasMore: false };
    const selected = new Set(input.sessionIds);
    const roleSet = new Set(input.roles);
    const databaseScope = input.sessionIds.length <= 500 ? input.sessionIds : undefined;
    let boundary = input.cursor;
    const matches: HistoryMessage[] = [];
    let exhausted = false;
    while (matches.length <= input.limit && !exhausted) {
      const page = this.#store.listEvents({
        ...(input.order === "asc"
          ? boundary === undefined ? {} : { afterCursor: boundary }
          : boundary === undefined ? {} : { beforeCursor: boundary }),
        ...(databaseScope === undefined ? {} : { sessionIds: databaseScope }),
        ...(input.from === undefined ? {} : { emittedFrom: input.from }),
        ...(input.to === undefined ? {} : { emittedBefore: input.to }),
        includeTombstoned: input.includeTombstoned,
        order: input.order,
        limit: HISTORY_SCAN_PAGE_SIZE
      });
      if (page.length === 0) break;
      for (const event of page) {
        boundary = event.globalCursor;
        if (!selected.has(event.sessionId)) continue;
        const message = historyMessageFromEvent(event);
        if (message === undefined || !roleSet.has(message.role)) continue;
        matches.push(message);
        if (matches.length > input.limit) break;
      }
      exhausted = page.length < HISTORY_SCAN_PAGE_SIZE;
    }
    const hasMore = matches.length > input.limit;
    const items = matches.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last !== undefined ? encodeHistoryCursor(last.event.globalCursor) : null,
      hasMore
    };
  }

  async #searchChatHistory(
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    assertKeys(input, [
      "query",
      "session_ids",
      "workdir",
      "from",
      "to",
      "agent_kind",
      "roles",
      "context_radius",
      "limit",
      "cursor"
    ]);
    const query = requiredText(input, "query", 4_096).trim();
    const requestedSessionIds = optionalIdArray(input["session_ids"], "session_ids", MAXIMUM_HISTORY_SESSION_IDS);
    const workdir = optionalText(input["workdir"], "workdir", 4_096);
    const from = optionalIsoMs(input["from"], "from");
    const to = optionalIsoMs(input["to"], "to");
    assertTimeRange(from, to);
    const agentKind = optionalAgentKind(input["agent_kind"]);
    const roles = historyRoles(input["roles"]);
    const contextRadius = optionalInteger(input["context_radius"], "context_radius", 0, 10) ?? 2;
    const limit = optionalInteger(input["limit"], "limit", 1, 50) ?? 10;
    const cursor = optionalText(input["cursor"], "cursor", 32_768);
    const scopedSessions = requestedSessionIds === undefined && workdir === undefined
      ? agentKind === undefined
        ? undefined
        : historySessionScope(this.#store, undefined, undefined, agentKind)
      : historySessionScope(this.#store, requestedSessionIds, workdir, agentKind);
    if (scopedSessions !== undefined && scopedSessions.length === 0) {
      return emptySearchHistoryResult(query, roles, contextRadius, limit);
    }
    if (!roles.some((role) => role === "user" || role === "assistant" || role === "ask_user" || role === "plan_review")) {
      return emptySearchHistoryResult(query, roles, contextRadius, limit);
    }

    const semanticCoordinator = this.#messageSearch();
    const semantic = semanticCoordinator === undefined
      ? { skipReason: "Semantic search is unavailable; keyword search was used." }
      : await semanticCoordinator.embedQuery(query, "hybrid")
        .catch(() => ({ skipReason: "Semantic query generation failed; keyword search was used." }));
    signal?.throwIfAborted();
    const semanticInput = semantic !== undefined && "semantic" in semantic ? semantic.semantic : undefined;
    const baseSearch = {
      scope: { owner: true as const },
      query,
      filters: {
        ...(scopedSessions === undefined ? {} : { sessionIds: scopedSessions.map((session) => session.descriptor.id) }),
        ...(agentKind === undefined ? {} : { backendIds: [agentKind] }),
        ...(from === undefined ? {} : { messageCreatedFrom: from }),
        ...(to === undefined ? {} : { messageCreatedBefore: to })
      },
      limit,
      ...(semanticInput === undefined ? {} : { semantic: semanticInput }),
      ...(semantic?.skipReason === undefined ? {} : { semanticSkipReason: semantic.skipReason })
    };
    let cursorWarning = false;
    let page;
    try {
      page = this.#store.searchSessionMessages({ ...baseSearch, ...(cursor === undefined ? {} : { pageToken: cursor }) });
    } catch (error) {
      if (cursor === undefined || !(error instanceof StoreError)) throw error;
      cursorWarning = true;
      page = this.#store.searchSessionMessages(baseSearch);
    }
    const roleSet = new Set(roles);
    const hits = page.matches.flatMap((match) => {
      const event = this.#store.findEvent(match.eventId);
      const hit = event === undefined ? undefined : historyMessageFromEvent(event);
      if (hit === undefined || !roleSet.has(hit.role)) return [];
      const context = this.#store.listEventsAround(match.sessionId, match.eventId, contextRadius * 2 + 1)
        .map(historyMessageFromEvent)
        .filter((message): message is HistoryMessage => message !== undefined && roleSet.has(message.role));
      return [{
        messageId: hit.event.id,
        sessionId: hit.event.sessionId,
        role: hit.role,
        createdAt: iso(hit.event.emittedAt),
        snippet: match.snippet,
        score: match.score,
        ...(match.ftsRank === undefined ? {} : { ftsRank: match.ftsRank }),
        ...(match.vectorRank === undefined ? {} : { vectorRank: match.vectorRank }),
        context: context.map((message) => ({
          id: message.event.id,
          sessionId: message.event.sessionId,
          role: message.role,
          content: message.content,
          createdAt: iso(message.event.emittedAt),
          isHit: message.event.id === hit.event.id,
          ...(message.toolUseId === undefined ? {} : { toolUseId: message.toolUseId }),
          ...(message.agentMeta === undefined ? {} : { agentMeta: message.agentMeta })
        }))
      }];
    });
    const sessionMetadata: Record<string, unknown> = {};
    for (const hit of hits) {
      const session = this.#store.getSession(hit.sessionId).descriptor;
      sessionMetadata[session.id] = {
        workingDir: effectiveWorkdir(this.#store, session),
        agentKind: session.backendId,
        title: session.title
      };
    }
    return {
      hits,
      sessions: sessionMetadata,
      vector_used: page.vectorUsed,
      ...(page.vectorSkipReason === undefined ? {} : { vector_skip_reason: page.vectorSkipReason }),
      pool_size: page.totalSize,
      pool_capped: page.poolCapped,
      nextCursor: page.nextPageToken ?? null,
      hasMore: page.nextPageToken !== undefined,
      query: {
        query,
        session_ids: requestedSessionIds ?? null,
        workdir: workdir ?? null,
        from: input["from"] ?? null,
        to: input["to"] ?? null,
        agent_kind: agentKind ?? null,
        roles,
        roles_defaulted: input["roles"] === undefined,
        context_radius: contextRadius,
        limit
      },
      ...(cursorWarning ? { warning: "INVALID_CURSOR_FALLBACK_TO_FIRST_PAGE" } : {})
    };
  }

  async #sendToSession(
    input: Readonly<Record<string, unknown>>,
    caller: SessionDescriptor,
    _context: BridgeToolCallContext
  ): Promise<unknown> {
    assertKeys(input, [
      "target_session_id",
      "message",
      "title",
      "use_worktree",
      "working_dir",
      "agent_kind",
      "model",
      "effort",
      "fast"
    ]);
    const message = requiredText(input, "message", MAXIMUM_MESSAGE_LENGTH);
    const targetSessionId = optionalId(input["target_session_id"], "target_session_id");
    const agentKind = optionalAgentKind(input["agent_kind"]);
    const host = this.#requireHost();
    if (targetSessionId !== undefined) {
      const target = this.#requireMutableTarget(targetSessionId);
      assertAgentKindMatches(agentKind, target.descriptor.backendId);
      const turn = activeTurn(this.#store, targetSessionId);
      const wasActive = host.isSessionActive(targetSessionId);
      const lastUserSendAt = latestUserMessageAt(this.#store, targetSessionId);
      const queued = host.enqueueServiceInput({
        operationId: randomUUID(),
        sessionId: targetSessionId,
        source: "system",
        originSessionId: caller.id,
        prompt: prompt(message, "prompt")
      });
      // The durable queue admission is authoritative. Only after it commits may
      // a cold native runtime be resumed and observe the handoff.
      if (!wasActive) await host.resume(targetSessionId);
      return {
        target_session_id: targetSessionId,
        agent_kind: target.descriptor.backendId,
        wake_kind: turn === undefined ? wasActive ? "already-active" : "resumed" : "queued",
        target_title: target.descriptor.title,
        target_last_user_send_at: lastUserSendAt === undefined ? null : iso(lastUserSendAt),
        queued_message_id: queued.value.queueItemId,
        worktree_path: target.descriptor.worktree?.path ?? null,
        ...(target.descriptor.modelId === undefined ? {} : { model: target.descriptor.modelId }),
        ...(target.descriptor.effort === undefined ? {} : { effort: target.descriptor.effort }),
        fast_mode: target.descriptor.fastMode,
        provider_id: target.descriptor.providerId ?? null
      };
    }

    const workingDir = optionalText(input["working_dir"], "working_dir", 4_096);
    const target = workingDir === undefined
      ? this.#store.getTarget(caller.targetId).descriptor
      : resolveTargetForWorkingDir(this.#store, caller, workingDir, agentKind);
    assertAgentKindMatches(agentKind, target.backendId);
    if (!target.trusted) throw new SessionHelperError("UNTRUSTED_TARGET", "The destination workspace is not trusted.");
    const title = normalizeTitle(optionalText(input["title"], "title", 120) ?? titleFromMessage(message));
    const sameBackend = target.backendId === caller.backendId;
    const modelId = optionalText(input["model"], "model", 256) ?? (sameBackend ? caller.modelId : undefined);
    const effort = optionalEffort(input["effort"]) ?? (sameBackend ? caller.effort : undefined);
    const fastMode = optionalBoolean(input["fast"], "fast") ?? (sameBackend ? caller.fastMode : false);
    const useWorktree = optionalBoolean(input["use_worktree"], "use_worktree") ?? false;
    const created = await host.createServiceSession({
      operationId: randomUUID(),
      serviceKind: "session_handoff",
      targetId: target.id,
      title,
      ...(sameBackend && caller.providerId !== undefined ? { providerId: caller.providerId } : {}),
      ...(modelId === undefined ? {} : { modelId }),
      ...(effort === undefined ? {} : { effort }),
      fastMode,
      permissionMode: sameBackend ? caller.permissionMode : "ask",
      planMode: sameBackend ? caller.planMode : false,
      ...(useWorktree ? { worktree: { refreshRemote: false } } : {})
    });
    const session = this.#store.getSession(created.value.sessionId).descriptor;
    const queued = host.enqueueServiceInput({
      operationId: randomUUID(),
      sessionId: session.id,
      source: "system",
      originSessionId: caller.id,
      prompt: prompt(message, "prompt")
    });
    return {
      target_session_id: session.id,
      agent_kind: session.backendId,
      wake_kind: "created",
      target_title: session.title,
      target_last_user_send_at: null,
      queued_message_id: queued.value.queueItemId,
      worktree_path: session.worktree?.path ?? null,
      ...(session.modelId === undefined ? {} : { model: session.modelId }),
      ...(session.effort === undefined ? {} : { effort: session.effort }),
      fast_mode: session.fastMode,
      provider_id: session.providerId ?? null
    };
  }
}

interface RenamePreview {
  readonly sessionId: string;
  readonly currentTitle: string;
  readonly newTitle: string;
  readonly workingDir: string;
  readonly updatedAt: string;
  readonly revision: string;
}

class SessionHelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "SessionHelperError";
  }
}

function nestedTool(
  name: string,
  category: HelperCategory,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  readOnly: boolean
): NestedToolDescriptor {
  return { name, category, description, inputSchema, readOnly };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  };
}

function idArraySchema(maxItems: number): Readonly<Record<string, unknown>> {
  return {
    type: "array",
    items: ID_SCHEMA,
    minItems: 1,
    maxItems,
    uniqueItems: true
  };
}

function toolResult(data: unknown): McpCallResult {
  const envelope = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: false
  };
}

function toolFailure(error: unknown, details?: Readonly<Record<string, unknown>>): McpCallResult {
  const classified = classifyError(error);
  const mergedDetails = { ...(classified.details ?? {}), ...(details ?? {}) };
  const envelope = {
    ok: false,
    errorCode: classified.code,
    message: classified.message,
    ...(Object.keys(mergedDetails).length === 0 ? {} : { data: mergedDetails })
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true
  };
}

function classifyError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
} {
  if (error instanceof SessionHelperError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error instanceof NotFoundError) return { code: "NOT_FOUND", message: "The referenced task or queue item does not exist." };
  if (error instanceof RevisionConflictError) return { code: "PRECONDITION_FAILED", message: "Durable task state changed concurrently; read it again and retry." };
  if (error instanceof InvalidStateTransitionError) return { code: "MESSAGE_CONSUMING", message: "The queued message is already being consumed or is terminal." };
  if (isRecord(error) && typeof error["code"] === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error["code"])) {
    return {
      code: error["code"],
      message: typeof error["message"] === "string" && error["message"].length <= 2_048
        ? error["message"]
        : "The task runtime rejected the operation."
    };
  }
  return { code: "INTERNAL", message: "The task helper operation failed." };
}

function assertKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) throw new SessionHelperError("INVALID_ARGS", `Unexpected argument: ${unexpected}.`);
}

function requiredText(input: Readonly<Record<string, unknown>>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new SessionHelperError("INVALID_ARGS", `${key} is required and must be at most ${maximum} characters.`);
  }
  return value;
}

function optionalText(value: unknown, key: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new SessionHelperError("INVALID_ARGS", `${key} is invalid.`);
  }
  return value;
}

function requiredId(input: Readonly<Record<string, unknown>>, key: string): string {
  return requiredText(input, key, 256).trim();
}

function optionalId(value: unknown, key: string): string | undefined {
  return value === undefined ? undefined : requiredId({ [key]: value }, key);
}

function requiredIdArray(value: unknown, key: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new SessionHelperError("INVALID_ARGS", `${key} must contain between 1 and ${maximum} task IDs.`);
  }
  const ids = value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "" || item.length > 256 || item.includes("\0")) {
      throw new SessionHelperError("INVALID_ARGS", `${key}[${index}] is invalid.`);
    }
    return item.trim();
  });
  assertUnique(ids, key);
  return ids;
}

function optionalIdArray(value: unknown, key: string, maximum: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new SessionHelperError("INVALID_ARGS", `${key} must be an array with at most ${maximum} task IDs.`);
  }
  if (value.length === 0) return [];
  return requiredIdArray(value, key, maximum);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new SessionHelperError("INVALID_ARGS", `${label} contains a duplicate: ${value}.`);
    seen.add(value);
  }
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SessionHelperError("INVALID_ARGS", `${key} must be a boolean.`);
  return value;
}

function optionalInteger(value: unknown, key: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SessionHelperError("INVALID_ARGS", `${key} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function optionalIso(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  const text = optionalText(value, key, 128)!;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new SessionHelperError("INVALID_ARGS", `${key} must be an ISO-8601 timestamp.`);
  return new Date(parsed).toISOString();
}

function optionalIsoMs(value: unknown, key: string): number | undefined {
  const normalized = optionalIso(value, key);
  return normalized === undefined ? undefined : Date.parse(normalized);
}

function assertTimeRange(from: number | undefined, to: number | undefined): void {
  if (from !== undefined && to !== undefined && from >= to) {
    throw new SessionHelperError("INVALID_ARGS", "from must be earlier than to.");
  }
}

function optionalAgentKind(value: unknown): string | undefined {
  return optionalText(value, "agent_kind", 256)?.trim();
}

function assertAgentKindMatches(requested: string | undefined, backendId: string): void {
  if (requested !== undefined && requested !== backendId) {
    throw new SessionHelperError("INVALID_ARGS", "agent_kind does not match the destination task Backend.");
  }
}

function optionalEffort(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(value))) {
    throw new SessionHelperError("INVALID_ARGS", "effort is invalid.");
  }
  return String(value);
}

function historyOrder(value: unknown): "asc" | "desc" {
  if (value === undefined || value === "desc") return "desc";
  if (value === "asc") return "asc";
  throw new SessionHelperError("INVALID_ARGS", "order must be asc or desc.");
}

function historyRoles(value: unknown): readonly HistoryRole[] {
  if (value === undefined) return DEFAULT_HISTORY_ROLES;
  if (!Array.isArray(value) || value.length > HISTORY_ROLES.length) {
    throw new SessionHelperError("INVALID_ARGS", "roles is invalid.");
  }
  const roles = value.map((role) => {
    if (typeof role !== "string" || !(HISTORY_ROLES as readonly string[]).includes(role)) {
      throw new SessionHelperError("INVALID_ARGS", "roles contains an unsupported value.");
    }
    return role as HistoryRole;
  });
  assertUnique(roles, "roles");
  return roles;
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function titleFromMessage(message: string): string {
  const first = message.split(/\r?\n/u).map((line) => normalizeTitle(line)).find((line) => line !== "") ?? "New task";
  return Array.from(first).slice(0, 120).join("");
}

function prompt(text: string, disposition: PromptInput["disposition"]): PromptInput {
  return { text, images: [], files: [], mentions: [], disposition };
}

function sessionRuntimeProfilePayload(profile: SessionRuntimeProfile): Readonly<Record<string, unknown>> {
  return {
    harness: profile.backendId,
    model: profile.modelId,
    provider_id: profile.providerId,
    effort: profile.effort ?? null,
    fast: profile.fastMode
  };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isHelperCategory(value: unknown): value is HelperCategory {
  return value === "product" || value === "control" || value === "history" || value === "handoff";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function effectiveWorkdir(store: OperationalStore, session: SessionDescriptor): string {
  if (session.worktree !== undefined) return session.worktree.path;
  if (session.remoteWorkspace !== undefined) return session.remoteWorkspace.workspaceRoot;
  const target = store.getTarget(session.targetId).descriptor;
  return target.remoteWorkspace?.workspaceRoot ?? target.workspaceRoot;
}

function resolveTargetForWorkingDir(
  store: OperationalStore,
  caller: SessionDescriptor,
  workingDir: string,
  backendId?: string
): ReturnType<OperationalStore["getTarget"]>["descriptor"] {
  const requested = workingDir.trim();
  if (pathMatches(requested, effectiveWorkdir(store, caller)) && (backendId === undefined || backendId === caller.backendId)) {
    return store.getTarget(caller.targetId).descriptor;
  }
  const matches = store.listTargets().filter((stored) => {
    const target = stored.descriptor;
    return (backendId === undefined || target.backendId === backendId) && (
      pathMatches(requested, target.workspaceRoot) ||
      (target.remoteWorkspace !== undefined && pathMatches(requested, target.remoteWorkspace.workspaceRoot))
    );
  });
  if (matches.length === 0) {
    throw new SessionHelperError(
      "INVALID_ARGS",
      "working_dir must exactly match a known owner Target; arbitrary service paths are not accepted."
    );
  }
  if (matches.length > 1) throw new SessionHelperError("INVALID_ARGS", "working_dir matches more than one Target.");
  return matches[0]!.descriptor;
}

function pathMatches(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const normalizedLeft = resolvePath(left).replace(/\\/gu, "/").replace(/\/$/u, "").toLocaleLowerCase("en-US");
    const normalizedRight = resolvePath(right).replace(/\\/gu, "/").replace(/\/$/u, "").toLocaleLowerCase("en-US");
    return normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}

function helperQueueOrigin(store: OperationalStore, item: QueueItemRecord): string | undefined {
  const operation = store.findOperation(item.operationId);
  if (operation?.kind !== "service_send_input" || !isRecord(operation.body)) return undefined;
  const origin = operation.body["originSessionId"];
  return typeof origin === "string" && origin.trim() !== "" ? origin : undefined;
}

function activeTurn(store: OperationalStore, sessionId: string): ReturnType<OperationalStore["listRuns"]>[number] | undefined {
  return store.listRuns({
    sessionId,
    states: ["running", "waiting", "retrying", "dispatch_unknown"],
    limit: 1
  })[0];
}

function listSessionQueueItems(store: OperationalStore, sessionId: string): QueueItemRecord[] {
  const items: QueueItemRecord[] = [];
  for (;;) {
    const page = store.listQueueItems({
      sessionId,
      states: QUEUE_STATES,
      limit: QUEUE_SCAN_PAGE_SIZE,
      offset: items.length
    });
    items.push(...page);
    if (page.length < QUEUE_SCAN_PAGE_SIZE) return items;
  }
}

function runtimePhase(
  session: SessionDescriptor,
  activeState: string | undefined,
  latestState: string | undefined
): string {
  if (session.deletedAt !== undefined) return "deleted";
  if (session.archived) return "archived";
  if (activeState === "waiting") return "needs-interaction";
  if (activeState !== undefined) return "running";
  if (latestState === "failed") return "failed";
  if (latestState === "completed" || latestState === "aborted") return "completed";
  if (latestState === "queued") return "queued";
  return "idle";
}

function latestUserMessageAt(store: OperationalStore, sessionId: string): number | undefined {
  let before: bigint | undefined;
  while (true) {
    const page = store.listEvents({
      sessionId,
      ...(before === undefined ? {} : { beforeCursor: before }),
      order: "desc",
      limit: HISTORY_SCAN_PAGE_SIZE
    });
    for (const event of page) {
      if (
        event.payload.type === "message_complete"
        && event.payload.role === "user"
        && event.payload.automaticContinuation === undefined
      ) return event.emittedAt;
    }
    if (page.length < HISTORY_SCAN_PAGE_SIZE) return undefined;
    before = page.at(-1)!.globalCursor;
  }
}

function countConversationMessages(store: OperationalStore, sessionId: string): number {
  let after: bigint | undefined;
  let count = 0;
  while (true) {
    const page = store.listEvents({
      sessionId,
      ...(after === undefined ? {} : { afterCursor: after }),
      order: "asc",
      limit: HISTORY_SCAN_PAGE_SIZE
    });
    count += page.reduce((total, event) => total + (historyMessageFromEvent(event) === undefined ? 0 : 1), 0);
    if (page.length < HISTORY_SCAN_PAGE_SIZE) return count;
    after = page.at(-1)!.globalCursor;
  }
}

function historyMessageFromEvent(event: PersistedEvent): HistoryMessage | undefined {
  const agentMeta = event.pi === undefined && event.metadata === undefined
    ? undefined
    : {
        ...(event.pi === undefined ? {} : { pi: event.pi }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata })
      };
  switch (event.payload.type) {
    case "message_complete":
      if (event.payload.automaticContinuation !== undefined) return undefined;
      return {
        event,
        role: event.payload.role,
        content: event.payload.blocks,
        ...(agentMeta === undefined ? {} : { agentMeta })
      };
    case "tool_start":
      return {
        event,
        role: "tool_use",
        content: { name: event.payload.name, input: event.payload.input },
        toolUseId: event.payload.callId,
        ...(agentMeta === undefined ? {} : { agentMeta })
      };
    case "tool_result":
      return {
        event,
        role: "tool_result",
        content: {
          output: event.payload.output,
          isError: event.payload.isError,
          ...(event.payload.parts === undefined ? {} : { parts: event.payload.parts }),
          ...(event.payload.artifact === undefined ? {} : { artifact: event.payload.artifact })
        },
        toolUseId: event.payload.callId,
        ...(agentMeta === undefined ? {} : { agentMeta })
      };
    case "thinking_delta":
      return {
        event,
        role: "thinking",
        content: { blockId: event.payload.blockId, text: event.payload.delta },
        ...(agentMeta === undefined ? {} : { agentMeta })
      };
    case "interaction_opened":
      if (event.payload.interaction.kind === "question") {
        return {
          event,
          role: "ask_user",
          content: event.payload.interaction,
          ...(agentMeta === undefined ? {} : { agentMeta })
        };
      }
      if (event.payload.interaction.kind === "plan_review") {
        return {
          event,
          role: "plan_review",
          content: event.payload.interaction,
          ...(agentMeta === undefined ? {} : { agentMeta })
        };
      }
      return undefined;
    default:
      return undefined;
  }
}

function publicHistoryMessage(message: HistoryMessage): Readonly<Record<string, unknown>> {
  return {
    id: message.event.id,
    sessionId: message.event.sessionId,
    role: message.role,
    content: message.content,
    createdAt: iso(message.event.emittedAt),
    ...(message.toolUseId === undefined ? {} : { toolUseId: message.toolUseId }),
    ...(message.agentMeta === undefined ? {} : { agentMeta: message.agentMeta })
  };
}

function historySessionScope(
  store: OperationalStore,
  requestedSessionIds: readonly string[] | undefined,
  workdir: string | undefined,
  backendId?: string
): readonly StoredSession[] {
  const sessions = requestedSessionIds === undefined
    ? store.listSessions({ includeArchived: true, includeDeleted: true })
    : requestedSessionIds.map((sessionId) => store.getSession(sessionId));
  return sessions.filter((session) =>
    (workdir === undefined || effectiveWorkdir(store, session.descriptor) === workdir) &&
    (backendId === undefined || session.descriptor.backendId === backendId)
  );
}

function encodeHistoryCursor(cursor: bigint): string {
  return Buffer.from(JSON.stringify({ v: 1, c: cursor.toString(10) }), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string | undefined): { readonly cursor: bigint } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed) || parsed["v"] !== 1 || typeof parsed["c"] !== "string" || !/^\d+$/u.test(parsed["c"])) {
      return undefined;
    }
    const cursor = BigInt(parsed["c"]);
    return cursor > 0n ? { cursor } : undefined;
  } catch {
    return undefined;
  }
}

function encodeOffsetCursor(kind: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, o: offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(
  value: string | undefined,
  kind: string
): { readonly offset: number } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed["v"] !== 1 ||
      parsed["k"] !== kind ||
      !Number.isSafeInteger(parsed["o"]) ||
      (parsed["o"] as number) < 0
    ) return undefined;
    return { offset: parsed["o"] as number };
  } catch {
    return undefined;
  }
}

function offsetPage<T>(
  values: readonly T[],
  offset: number,
  limit: number,
  kind: string
): { readonly items: readonly T[]; readonly nextCursor: string | null; readonly hasMore: boolean } {
  const items = values.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < values.length;
  return {
    items,
    nextCursor: hasMore ? encodeOffsetCursor(kind, nextOffset) : null,
    hasMore
  };
}

function compareNumberThenText(
  leftNumber: number,
  rightNumber: number,
  leftText: string,
  rightText: string,
  order: "asc" | "desc"
): number {
  const numberOrder = leftNumber - rightNumber;
  const stable = numberOrder === 0 ? leftText.localeCompare(rightText) : numberOrder;
  return order === "asc" ? stable : -stable;
}

function summarizeText(value: string, maximumCharacters: number): { readonly text: string; readonly truncated: boolean } {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maximumCharacters) return { text: normalized, truncated: false };
  return { text: `${characters.slice(0, maximumCharacters).join("")}…`, truncated: true };
}

function publicRenamePreview(preview: RenamePreview): Readonly<Record<string, unknown>> {
  return {
    session_id: preview.sessionId,
    current_title: preview.currentTitle,
    new_title: preview.newTitle,
    working_dir: preview.workingDir,
    updated_at: preview.updatedAt
  };
}

function validRenameConfirmation(value: unknown): value is RenameConfirmation {
  if (!isRecord(value) || value["v"] !== 1 || !Array.isArray(value["changes"])) return false;
  return value["changes"].every((change) => isRecord(change) &&
    typeof change["sessionId"] === "string" &&
    typeof change["title"] === "string" &&
    (change["expectedCurrentTitle"] === null || typeof change["expectedCurrentTitle"] === "string") &&
    (change["expectedUpdatedAt"] === null || typeof change["expectedUpdatedAt"] === "string") &&
    typeof change["approvedCurrentTitle"] === "string" &&
    typeof change["approvedRevision"] === "string");
}

function confirmationMatches(value: RenameConfirmation, changes: readonly RenameChange[]): boolean {
  return value.changes.length === changes.length && changes.every((change, index) => {
    const approved = value.changes[index];
    return approved !== undefined &&
      approved.sessionId === change.sessionId &&
      approved.title === change.title &&
      approved.expectedCurrentTitle === (change.expectedCurrentTitle ?? null) &&
      approved.expectedUpdatedAt === (change.expectedUpdatedAt ?? null);
  });
}

function emptySearchHistoryResult(
  query: string,
  roles: readonly HistoryRole[],
  contextRadius: number,
  limit: number
): Readonly<Record<string, unknown>> {
  return {
    hits: [],
    sessions: {},
    vector_used: false,
    vector_skip_reason: "No messages matched the requested task or role scope.",
    pool_size: 0,
    pool_capped: false,
    nextCursor: null,
    hasMore: false,
    query: {
      query,
      roles,
      context_radius: contextRadius,
      limit
    }
  };
}
