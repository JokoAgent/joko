import type { SessionDescriptor } from "@joko/core";
import {
  PartnerStoreError,
  type OperationalStore,
  type PartnerProfileRecord
} from "@joko/store";

import {
  PartnerManagerError,
  type PartnerDelegationView,
  type PartnerManager
} from "./partner-manager.js";
import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const PARTNER_TOOL_PROVIDER_ID = "joko_partners";

const ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
});

const TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  tool(
    "list_partners",
    "List active long-lived partners available to this canonical partner task. Identity prompts and private settings are never returned.",
    objectSchema({}),
    false
  ),
  tool(
    "send_private_message",
    "Send one bounded private message to another active partner's canonical task. Useful replies should return through the same tool; acknowledgement-only replies are discouraged.",
    objectSchema({
      target_partner_id: ID_SCHEMA,
      message: { type: "string", minLength: 1, maxLength: 16_000 }
    }, ["target_partner_id", "message"]),
    false
  ),
  tool(
    "start_delegation",
    "Start a durable, visible task owned by another active partner using that partner's exact profile snapshot.",
    objectSchema({
      target_partner_id: ID_SCHEMA,
      title: { type: "string", minLength: 1, maxLength: 200 },
      objective: { type: "string", minLength: 1, maxLength: 12_000 }
    }, ["target_partner_id", "title", "objective"]),
    false
  ),
  tool(
    "list_delegations",
    "List delegations started by this canonical partner task with current lifecycle and artifact counts.",
    objectSchema({}),
    false
  ),
  tool(
    "get_delegation",
    "Read one delegation owned by or addressed to this partner, including its visible child task and terminal result.",
    objectSchema({ delegation_id: ID_SCHEMA }, ["delegation_id"]),
    false
  ),
  tool(
    "cancel_delegation",
    "Stop one non-terminal delegation started by this partner. Cancellation is preserved as unknown when the Backend result cannot be confirmed.",
    objectSchema({
      delegation_id: ID_SCHEMA,
      expected_revision: { type: "string", pattern: "^[1-9][0-9]{0,15}$" }
    }, ["delegation_id", "expected_revision"]),
    true
  )
]);

/** Partner-only direct tools. Every call is fenced to one active canonical Session. */
export class PartnerToolBridgeProvider implements BridgeToolProvider {
  readonly id = PARTNER_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = TOOLS;
  readonly #store: OperationalStore;
  readonly #partners: PartnerManager;

  constructor(options: { readonly store: OperationalStore; readonly partners: PartnerManager }) {
    this.#store = options.store;
    this.#partners = options.partners;
  }

  includeForTarget(targetId: string): boolean {
    const partner = this.#partners.partnerForHomeTarget(targetId);
    return partner?.lifecycle === "active";
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
      if (name === "list_partners") {
        assertKeys(arguments_, []);
        return success({
          partners: this.#partners.listPartners("active")
            .filter((partner) => partner.id !== caller.id && partner.initializationState === "ready")
            .map(publicPartner)
        });
      }
      if (name === "send_private_message") {
        assertKeys(arguments_, ["target_partner_id", "message"]);
        const targetPartnerId = requiredId(arguments_, "target_partner_id");
        const result = await this.#partners.sendPrivateMessage({
          messageId: `partner-private-message:${requiredEffectIdentity(context)}`,
          callerSessionId: caller.canonicalSessionId!,
          targetPartnerId,
          content: requiredText(arguments_, "message", 16_000, true)
        });
        signal?.throwIfAborted();
        const target = this.#partners.getPartner(targetPartnerId);
        return success({
          thread_id: result.reservation.thread.id,
          message_id: result.message.id,
          target_partner: publicPartner(target),
          delivery_status: result.message.deliveryStatus,
          remaining_messages: result.reservation.remainingMessages,
          conversation_ended: result.reservation.conversationEnded
        });
      }
      if (name === "start_delegation") {
        assertKeys(arguments_, ["target_partner_id", "title", "objective"]);
        const result = await this.#partners.startDelegation({
          delegationId: `partner-delegation:${requiredEffectIdentity(context)}`,
          callerSessionId: caller.canonicalSessionId!,
          targetPartnerId: requiredId(arguments_, "target_partner_id"),
          title: requiredText(arguments_, "title", 200),
          objective: requiredText(arguments_, "objective", 12_000, true)
        });
        signal?.throwIfAborted();
        return success(publicDelegation(result, this.#partners.getPartner(result.delegation.targetPartnerId)));
      }
      if (name === "list_delegations") {
        assertKeys(arguments_, []);
        const delegations = await this.#partners.listDelegations(caller.id);
        signal?.throwIfAborted();
        return success({
          delegations: delegations.map((view) =>
            publicDelegation(view, this.#partners.getPartner(view.delegation.targetPartnerId)))
        });
      }
      if (name === "get_delegation") {
        assertKeys(arguments_, ["delegation_id"]);
        const result = await this.#partners.getDelegation(requiredId(arguments_, "delegation_id"), caller.id);
        signal?.throwIfAborted();
        return success(publicDelegation(result, this.#partners.getPartner(result.delegation.targetPartnerId)));
      }
      if (name === "cancel_delegation") {
        assertKeys(arguments_, ["delegation_id", "expected_revision"]);
        requiredEffectIdentity(context);
        const result = await this.#partners.cancelDelegation(
          requiredId(arguments_, "delegation_id"),
          caller.id,
          requiredRevision(arguments_, "expected_revision")
        );
        signal?.throwIfAborted();
        return success(publicDelegation(result, this.#partners.getPartner(result.delegation.targetPartnerId)));
      }
      throw new PartnerToolError("UNKNOWN_TOOL", "Partner tool is not part of this runtime snapshot.");
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      return failure(error);
    }
  }

  #requireCaller(context: BridgeToolCallContext): PartnerProfileRecord {
    if (context.providerGeneration !== undefined && context.providerGeneration !== this.generation) {
      throw new PartnerToolError("STALE_SCOPE", "The Partner tool snapshot is stale.");
    }
    let session: SessionDescriptor;
    try {
      session = this.#store.getSession(context.sessionId).descriptor;
    } catch {
      throw new PartnerToolError("STALE_SCOPE", "The Partner task is unavailable.");
    }
    if (session.targetId !== context.targetId || session.binding.generation !== context.generation
      || session.archived || session.deletedAt !== undefined) {
      throw new PartnerToolError("STALE_SCOPE", "The Partner tool scope is stale or read-only.");
    }
    const caller = this.#partners.canonicalCaller(context.sessionId);
    if (caller.homeTargetId !== context.targetId) {
      throw new PartnerToolError("STALE_SCOPE", "The Partner task no longer belongs to this home.");
    }
    return caller;
  }
}

function publicPartner(partner: PartnerProfileRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: partner.id,
    display_name: partner.displayName,
    avatar: partner.avatar,
    status: partner.lifecycle,
    ready: partner.initializationState === "ready"
  });
}

function publicDelegation(
  view: PartnerDelegationView,
  target: PartnerProfileRecord
): Readonly<Record<string, unknown>> {
  const delegation = view.delegation;
  return Object.freeze({
    id: delegation.id,
    revision: delegation.revision.toString(10),
    requester_partner_id: delegation.requesterPartnerId,
    target_partner_id: delegation.targetPartnerId,
    parent_session_id: delegation.parentSessionId,
    target_profile_version: delegation.targetProfileVersion.toString(10),
    target_partner: publicPartner(target),
    title: delegation.title,
    objective: delegation.objective,
    status: delegation.status,
    ...(delegation.childSessionId === undefined ? {} : { child_session_id: delegation.childSessionId }),
    ...(delegation.runId === undefined ? {} : { run_id: delegation.runId }),
    artifact_count: view.artifactCount,
    ...(delegation.resultSummary === undefined ? {} : { result_summary: delegation.resultSummary }),
    ...(delegation.errorText === undefined ? {} : { error: delegation.errorText }),
    created_at: delegation.createdAt,
    updated_at: delegation.updatedAt,
    ...(delegation.startedAt === undefined ? {} : { started_at: delegation.startedAt }),
    ...(delegation.completedAt === undefined ? {} : { completed_at: delegation.completedAt })
  });
}

function tool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return Object.freeze({
    serverId: PARTNER_TOOL_PROVIDER_ID,
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
  return Object.freeze({
    type: "object",
    properties,
    required,
    additionalProperties: false
  });
}

function assertKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new PartnerToolError("INVALID_ARGS", `Unknown Partner tool arguments: ${unknown.join(", ")}.`);
  }
}

function requiredId(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = requiredText(input, key, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new PartnerToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  return value;
}

function requiredRevision(input: Readonly<Record<string, unknown>>, key: string): bigint {
  const value = input[key];
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new PartnerToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  const revision = BigInt(value);
  if (revision > 9_007_199_254_740_991n) {
    throw new PartnerToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  return revision;
}

function requiredEffectIdentity(context: BridgeToolCallContext): string {
  if (context.effectIdentity === undefined || !/^[a-f0-9]{64}$/u.test(context.effectIdentity)) {
    throw new PartnerToolError("STALE_SCOPE", "The Partner tool effect identity is unavailable.");
  }
  return context.effectIdentity;
}

function requiredText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  multiline = false
): string {
  const value = input[key];
  if (typeof value !== "string") throw new PartnerToolError("INVALID_ARGS", `${key} must be text.`);
  const normalized = multiline ? value.replace(/\r\n?/gu, "\n").trim() : value.trim();
  const forbidden = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
    : /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
  if (normalized === "" || normalized.length > maximum || forbidden.test(normalized)) {
    throw new PartnerToolError("INVALID_ARGS", `${key} is invalid or exceeds its limit.`);
  }
  return normalized;
}

function success(data: unknown): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: { data },
    isError: false
  };
}

function failure(error: unknown): McpCallResult {
  const mapped = toolFailure(error);
  return {
    content: [{ type: "text", text: mapped.message }],
    structuredContent: { errorCode: mapped.code, message: mapped.message },
    isError: true
  };
}

function toolFailure(error: unknown): PartnerToolError {
  if (error instanceof PartnerToolError) return error;
  if (error instanceof PartnerManagerError) return new PartnerToolError(error.code, error.message);
  if (error instanceof PartnerStoreError) return new PartnerToolError(error.code, error.message);
  return new PartnerToolError("INTERNAL", "The Partner action could not be completed.");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class PartnerToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PartnerToolError";
  }
}
