import { createHmac, randomUUID } from "node:crypto";
import { AgentImportError, type AgentImportPreview, type AgentImportSelection } from "@joko/agent-import";
import { redactSecrets, type SessionDescriptor } from "@joko/core";
import { TaskShareStore, type OperationalStore, type PartnerStore } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolCallResult, BridgeToolProvider, McpToolDescriptor } from "./mcp-router.js";
import type { PartnerImportController, PartnerImportManager, PartnerImportReview } from "./partner-import-manager.js";
import type { PartnerManager } from "./partner-manager.js";
import type { SessionHost } from "./session-host.js";

export const PARTNER_IMPORT_COMMAND_SERVER = "joko_partner_import";
export const PARTNER_IMPORT_COMMAND_TOOL = "import_agent";
const pageSize = 20;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const localBackends = new Set(["pi", "codex", "claude-agent-sdk-stdio"]);

interface ImportCommandScope extends PartnerImportController {
  readonly receiptPrefix: string;
  readonly queueId: string;
  readonly connectionId: string;
  readonly generation: number;
}

/** Exposes the same local import transaction to the original task's Owner. */
export class PartnerImportCommandTools implements BridgeToolProvider {
  readonly id = PARTNER_IMPORT_COMMAND_SERVER;
  readonly generation = 1;
  readonly available = true;
  readonly tools: readonly McpToolDescriptor[] = [{
    name: PARTNER_IMPORT_COMMAND_TOOL, serverId: PARTNER_IMPORT_COMMAND_SERVER,
    description: "Import a local Hermes or OpenClaw agent as a Partner. List sources, preview selectable entries and request approval from the Owner for the exact selection. Preview returns a requestId for start and status. After a lost reply, check the same requestId. Source credentials stay on the host.",
    // Start obtains the exact selection approval inside this tool on all Backends.
    requiresPermission: false,
    inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
      operation: { type: "string", enum: ["sources", "preview", "start", "status"] },
      sourceId: { type: "string", description: "Source ID for the first preview page." },
      previewId: { type: "string", description: "Original preview ID for additional pages." },
      offset: { type: "integer", minimum: 0 },
      requestId: { type: "string", description: "The original request ID for status." },
      selection: { type: "object", additionalProperties: false, required: ["previewId", "requestId", "name", "takeover"], properties: {
        previewId: { type: "string" }, requestId: { type: "string" }, name: { type: "string", maxLength: 200 },
        entryIds: { type: "array", items: { type: "string" } },
        entryRanges: { type: "array", description: "Zero-based inclusive ranges from the preview, instead of entryIds.",
          items: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 2, maxItems: 2 } },
        takeover: { type: "boolean", description: "Request explicit approval to take over selected source automations." },
        deferSetup: { type: "boolean", default: true }
      } }
    } }
  }];

  constructor(readonly options: {
    readonly store: OperationalStore;
    readonly profiles: PartnerStore;
    readonly partners: PartnerManager;
    readonly imports: PartnerImportManager;
    readonly host: Pick<SessionHost, "requestOwnerToolApproval">;
  }) {}

  includeForTarget(targetId: string): boolean {
    const { store } = this.options;
    try {
      const target = store.getTarget(targetId).descriptor;
      return target.trusted && target.remoteWorkspace === undefined
        && localBackends.has(store.getBackend(target.backendId).descriptor.adapterKind);
    } catch { return false; }
  }

  includeForSession(sessionId: string, targetId: string): boolean {
    if (!this.includeForTarget(targetId)) return false;
    const session = this.options.store.findSession(sessionId)?.descriptor;
    return session === undefined || this.#availableSession(session, targetId);
  }

  #availableSession(session: SessionDescriptor, targetId: string): boolean {
    const { store, partners, profiles } = this.options;
    if (session.targetId !== targetId || session.archived || session.deletedAt !== undefined || session.hidden
      || session.remoteWorkspace !== undefined || session.automationOrigin !== undefined || session.derivationOrigin?.sideChat
      || store.findSessionRuntimePolicy(session.id) || store.findCollaborationWorkerBySession(session.id)
      || new TaskShareStore(store).list().some(share => share.sessionId === session.id && share.status === "active")) return false;
    const partner = partners.partnerForHomeTarget(targetId);
    return partner === undefined
      ? profiles.getSessionLink(session.id) === undefined && store.sessionCreationServiceKind(session.id) === undefined
      : partner.canonicalSessionId === session.id && partner.lifecycle === "active" && partner.initializationState === "ready"
        && !partners.isHomeChanging(partner.id);
  }

  #scope(context: BridgeToolCallContext, writes: boolean, signal?: AbortSignal): ImportCommandScope {
    const { store } = this.options;
    const original = context.inputQueueItem;
    if (!context.localProductScope || !original) throw new AgentImportError("IMPORT_CALLER_UNAVAILABLE");
    const initial = store.getQueueItem(original.id);
    const operation = store.findOperation(initial.operationId);
    if (!operation?.connectionId || operation.status !== "completed" || (operation.kind !== "sendInput" && operation.kind !== "send_input")
      || new TaskShareStore(store).getAuthorForOperation(operation.id)) throw new AgentImportError("IMPORT_CALLER_UNAVAILABLE");
    const connection = store.getConnection(operation.connectionId);
    const assertCurrent = () => {
      signal?.throwIfAborted(); context.assertCurrent?.();
      store.authorizeConnection(connection.id, connection.authKeyDigest);
      const session = store.getSession(context.sessionId).descriptor;
      const queue = store.getQueueItem(original.id);
      const run = store.getRun(original.runId).descriptor;
      const attempt = store.getAttempt(original.attemptId).descriptor;
      const backend = store.getBackend(session.backendId).descriptor;
      if ((context.providerGeneration !== undefined && context.providerGeneration !== this.generation)
        || !this.includeForTarget(context.targetId) || !this.#availableSession(session, context.targetId)
        || session.binding.generation !== context.generation || !localBackends.has(backend.adapterKind)
        || queue.sessionId !== session.id || queue.operationId !== initial.operationId || queue.bodyHash !== initial.bodyHash
        || queue.runId !== run.id || queue.attemptId !== attempt.id || !["dispatching", "backend_accepted"].includes(queue.state)
        || queue.disposition !== "prompt" || queue.body.messagingOrigin || queue.body.automaticContinuation
        || queue.body.objectiveContinuation || queue.body.inputHandoffContinuation
        || run.source !== "user" || run.sessionId !== session.id || run.parentRunId !== undefined
        || !["queued", "running", "waiting", "retrying"].includes(run.state) || run.activeAttemptId !== attempt.id
        || attempt.runId !== run.id || attempt.generation !== context.generation || attempt.endedAt !== undefined
        || attempt.backendInstanceGeneration !== backend.instanceGeneration
        || (writes && (queue.executionOverrides?.planMode ?? session.planMode))) throw new AgentImportError("IMPORT_CALLER_UNAVAILABLE");
    };
    assertCurrent();
    // A receipt stays with the same Connection and task across transport loss. A preview also belongs to its binding.
    const key = createHmac("sha256", connection.authKeyDigest)
      .update(JSON.stringify([PARTNER_IMPORT_COMMAND_SERVER, connection.id, context.sessionId])).digest("hex").slice(0, 32);
    return { ownerKey: `${key}:${context.generation}`, receiptPrefix: `import_${key}_`, queueId: original.id, connectionId: connection.id,
      generation: context.generation, assertCurrent };
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<BridgeToolCallResult> {
    try {
      if (name !== PARTNER_IMPORT_COMMAND_TOOL) throw new AgentImportError("INVALID_SELECTION");
      const scope = this.#scope(context, input.operation === "start", signal);
      const { imports } = this.options;
      const success = (value: unknown) => {
        scope.assertCurrent();
        return { isError: false, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
      };
      switch (input.operation) {
        case "sources": return success(await imports.sources(scope));
        case "preview": {
          const offset = input.offset === undefined ? 0 : requireOffset(input.offset);
          const preview = input.previewId === undefined && offset === 0
            ? await imports.preview(requireUuid(input.sourceId), scope)
            : imports.readPreview(requireUuid(input.previewId), scope);
          return success(previewPage(preview, offset, scope.receiptPrefix + preview.id));
        }
        case "status": {
          const value = await imports.status(receiptId(input.requestId, scope.receiptPrefix), scope);
          return success(value ?? null);
        }
        case "start": {
          const selection = importSelection(input.selection, scope.receiptPrefix);
          return success(await imports.start(selection, scope, async review => {
            if (!await this.options.host.requestOwnerToolApproval({ ...scope, id: `partner-import-permission-${randomUUID()}`,
              tool: "Partner import", title: selection.takeover ? "Import the selected entries and take over source schedules?" : "Import the selected entries?",
              summary: reviewSummary(review, selection) }, signal)) throw new AgentImportError("IMPORT_SELECTION_DENIED");
          }));
        }
        default: throw new AgentImportError("INVALID_SELECTION");
      }
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof AgentImportError ? error.code : "IMPORT_TOOL_FAILED" }] };
    }
  }
}

function requireOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AgentImportError("INVALID_SELECTION");
  return value;
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new AgentImportError("INVALID_SELECTION");
  return value;
}

function receiptId(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new AgentImportError("IMPORT_RECEIPT_MISSING");
  return prefix + requireUuid(value.slice(prefix.length));
}

function importSelection(value: unknown, prefix: string): AgentImportSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentImportError("INVALID_SELECTION");
  const input = value as Record<string, unknown>;
  const previewId = requireUuid(input.previewId);
  const requestId = receiptId(input.requestId, prefix);
  if (requestId !== prefix + previewId || typeof input.name !== "string" || typeof input.takeover !== "boolean"
    || input.deferSetup !== undefined && typeof input.deferSetup !== "boolean") throw new AgentImportError("INVALID_SELECTION");
  const entryIds = input.entryIds ?? [];
  if (!Array.isArray(entryIds) || !entryIds.every((id): id is string => typeof id === "string")) throw new AgentImportError("INVALID_SELECTION");
  const ranges = input.entryRanges;
  if (ranges !== undefined && !Array.isArray(ranges)) throw new AgentImportError("INVALID_SELECTION");
  const entryRanges = ranges?.map((range): readonly [number, number] => {
    if (!Array.isArray(range) || range.length !== 2) throw new AgentImportError("INVALID_SELECTION");
    return [requireOffset(range[0]), requireOffset(range[1])];
  });
  if (entryIds.length === 0 && !entryRanges?.length) throw new AgentImportError("INVALID_SELECTION");
  return { previewId, requestId, name: input.name, entryIds, ...(entryRanges === undefined ? {} : { entryRanges }),
    takeover: input.takeover, deferSetup: input.deferSetup ?? true };
}

function previewPage(preview: AgentImportPreview, offset: number, requestId: string) {
  if (offset > preview.entries.length) throw new AgentImportError("INVALID_SELECTION");
  const total = preview.entries.length;
  return { id: preview.id, source: preview.source, name: preview.name, requestId, total,
    entries: preview.entries.slice(offset, offset + pageSize).map((entry, index) => ({ ...entry, index: offset + index })),
    ...(offset + pageSize < total ? { nextOffset: offset + pageSize } : {}) };
}

function reviewSummary(review: PartnerImportReview, selection: AgentImportSelection): string {
  const label = (value: string) => redactSecrets(value).replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
  const entries = review.entries.map(entry => `• ${label(entry.name)} (${label(entry.id)})`).join("\n");
  const setup = selection.deferSetup ? "Save first and configure later." : "Configure and verify after saving.";
  const summary = [`${label(review.name)} from ${label(review.sourceName)}`, setup, `Selected entries (${review.entries.length})`, entries].join("\n");
  if (summary.length > 32_000) throw new AgentImportError("IMPORT_SELECTION_REVIEW_TOO_LARGE");
  return summary;
}
