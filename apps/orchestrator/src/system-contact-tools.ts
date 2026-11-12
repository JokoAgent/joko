import { create, toBinary } from "@bufbuild/protobuf";
import {
  ContactKind,
  NativeSystemContactWriteItemSchema,
  NativeSystemContactWriteOutcome as Outcome,
  NativeSystemContactsWriteRequestSchema,
  type NativeSystemContactWriteItem,
  type NativeSystemContactWriteReceipt
} from "@joko/contracts";
import { JokoError, type SessionDescriptor } from "@joko/core";
import {
  ContactStoreError, OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError, TaskShareStore,
  type ConnectionRecord, type ContactProfileRecord, type OperationalStore
} from "@joko/store";
import { ContactManagerError, type ContactManager, type ContactVCardImportDecision } from "./contact-manager.js";
import { SystemContactsPermissionError, type NativeSystemContactsPort } from "./input-handoff/native-host.js";
import type { BridgeToolCallContext } from "./mcp-router.js";
import {
  contactLine, readSystemContactImport, readSystemContactRecords, validSystemContactId,
  type SystemContactImportOptions, type SystemContactsAccess
} from "./system-contacts.js";

export interface SystemContactApprovalRequest {
  readonly action: "import" | "export";
  readonly queueId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly summary: string;
  readonly assertCurrent: () => void;
}

export interface SystemContactToolsOptions {
  readonly getPort: () => NativeSystemContactsPort | undefined;
  readonly approve: (request: SystemContactApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
}

interface SystemContactToolAccess extends SystemContactsAccess {
  readonly connection: ConnectionRecord;
  readonly scope: NonNullable<BridgeToolCallContext["inputQueueItem"]>;
  readonly context: BridgeToolCallContext;
  readonly assertWritable: () => void;
}

export class SystemContactToolError extends JokoError {
  constructor(code: string, message: string, readonly details?: Readonly<Record<string, unknown>>, stateMayHaveChanged = false) {
    super({ code, message, phase: "contacts", retryable: false, stateMayHaveChanged,
      recovery: stateMayHaveChanged ? "Check the original operation and its confirmed results before requesting another write." : "" });
  }
}

type SystemImportInput = SystemContactImportOptions & { readonly dryRun: boolean };
type SystemExportInput = { readonly dryRun: boolean } & (
  { readonly ids: readonly string[]; readonly group?: never } | { readonly group: string; readonly ids?: never }
);
interface SystemWritePlan {
  readonly items: readonly NativeSystemContactWriteItem[];
  readonly names: ReadonlyMap<string, string>;
  readonly skippedPending: readonly string[];
  readonly unresolved: readonly string[];
}
interface SystemWriteReport {
  created: number;
  updated: number;
  missing: number;
  failed: number;
  unknown: number;
  skipped: number;
  skippedPending: number;
  unresolved: number;
  readonly issues: Array<{ readonly contact_id: string; readonly outcome: "missing" | "failed" | "unknown" }>;
}

const MAX_WRITE_BATCH = 200;
const MAX_WRITE_BYTES = 65_536;
const MAX_REPORTED_CONTACTS = 200;
const EMPLOYMENT_RELATION = /^(?:works? at|employed by|任职|就职|在职|供职|入职)$/iu;

export function captureSystemContactToolAccess(
  store: OperationalStore,
  options: SystemContactToolsOptions,
  session: SessionDescriptor,
  context: BridgeToolCallContext,
  signal?: AbortSignal
): SystemContactToolAccess | undefined {
  const scope = context.inputQueueItem;
  const port = options.getPort();
  if (context.localProductScope !== true || scope === undefined || port === undefined
    || context.assertCurrent === undefined || context.effectIdentity === undefined
    || session.remoteWorkspace !== undefined || session.derivationOrigin?.sideChat) return undefined;
  try {
    const connection = store.getConnection(port.connectionId);
    const original = store.getQueueItem(scope.id);
    const owner = store.findOperation(original.operationId);
    if (owner?.connectionId !== connection.id || connection.deviceId !== port.deviceId || owner.status !== "completed"
      || (owner.kind !== "sendInput" && owner.kind !== "send_input")
      || original.disposition !== "prompt" || original.body.messagingOrigin !== undefined
      || original.body.automaticContinuation !== undefined || original.body.objectiveContinuation !== undefined
      || original.body.inputHandoffContinuation !== undefined
      || new TaskShareStore(store).getAuthorForOperation(original.operationId)?.sessionId === session.id) return undefined;
    const assertCurrent = (): void => {
      signal?.throwIfAborted();
      context.assertCurrent!();
      port.assertCurrent();
      store.authorizeConnection(connection.id, connection.authKeyDigest);
      const current = store.getSession(session.id).descriptor;
      const target = store.getTarget(context.targetId).descriptor;
      const queue = store.getQueueItem(scope.id);
      const run = store.getRun(scope.runId).descriptor;
      const attempt = store.getAttempt(scope.attemptId).descriptor;
      const backend = store.getBackend(current.backendId).descriptor;
      if (current.binding.generation !== context.generation || current.targetId !== target.id
        || current.remoteWorkspace !== undefined || current.archived || current.deletedAt !== undefined || current.derivationOrigin?.sideChat
        || !target.trusted || target.remoteWorkspace !== undefined
        || queue.sessionId !== current.id || queue.runId !== run.id || queue.attemptId !== attempt.id
        || queue.operationId !== original.operationId || queue.bodyHash !== original.bodyHash
        || queue.backendInstanceGeneration !== backend.instanceGeneration
        || (queue.state !== "dispatching" && queue.state !== "backend_accepted")
        || run.sessionId !== current.id || run.source !== "user" || run.parentRunId !== undefined
        || run.activeAttemptId !== attempt.id || !["queued", "running", "waiting", "retrying"].includes(run.state)
        || attempt.runId !== run.id || attempt.generation !== context.generation || attempt.endedAt !== undefined
        || attempt.backendInstanceGeneration !== backend.instanceGeneration) {
        throw new SystemContactToolError("STALE_SCOPE", "The task that opened macOS Contacts is no longer current.");
      }
    };
    assertCurrent();
    return {
      port, connection, scope, context, assertCurrent, ownerId: `tool:${context.effectIdentity}`,
      assertWritable: () => {
        assertCurrent();
        if (store.getSession(session.id).descriptor.planMode || original.executionOverrides?.planMode === true) {
          throw new SystemContactToolError("PERMISSION_DENIED", "Leave plan mode before changing Contacts.");
        }
      }
    };
  } catch {
    return undefined;
  }
}

export async function importSystemContacts(
  store: OperationalStore, contacts: ContactManager, tools: SystemContactToolsOptions, access: SystemContactToolAccess,
  input: SystemImportInput, signal?: AbortSignal
): Promise<unknown> {
  const read = async () => {
    const check = captureDirectory(contacts, access, !input.dryRun);
    const description = [
      input.dryRun ? "Read a count and a sample of names." : "Import contacts into Joko and leave ambiguous matches for review.",
      input.nameContains ? `Name contains: ${contactLine(input.nameContains, 50)}` : "",
      input.requireEmail ? "Only cards with email addresses." : "",
      input.group && !input.dryRun ? `Joko group: ${contactLine(input.group, 60)}` : ""
    ].filter(Boolean).join("\n");
    await approveSystemContacts(tools, access, "import", description, check, signal);
    if (input.dryRun) {
      try {
        const records = await readSystemContactRecords(contacts, { ...access, assertCurrent: check }, input, signal);
        check();
        const withEmail = records.filter(record => record.draft.identities?.some(identity => identity.platform === "email")).length;
        return { dryRun: true, total: records.length, withEmail,
          withOrg: records.filter(record => record.organizationName !== undefined || record.draft.kind === "organization").length,
          sample: records.slice(0, 10).map(record => contactLine(record.draft.displayName, 100)) };
      } catch (error) {
        if (error instanceof SystemContactsPermissionError) throw new SystemContactToolError("PERMISSION_DENIED", error.message);
        throw error;
      }
    }
    const preview = await readSystemContactImport(contacts, { ...access, assertCurrent: check }, input, signal);
    try {
      check();
      const skipped = new Set<string>();
      const review: string[] = [];
      const decisions: ContactVCardImportDecision[] = [];
      for (const entry of preview.entries) {
        if (entry.disposition === "needs_review" || (entry.existingEntryId !== undefined && skipped.has(entry.existingEntryId))) {
          skipped.add(entry.entryId);
          review.push(entry.contact.displayName);
          decisions.push({ entryId: entry.entryId, decision: "skip" });
        } else if (entry.organizationCandidates.length > 0) {
          review.push(entry.contact.displayName);
          if (entry.disposition === "create") {
            decisions.push({ entryId: entry.entryId, decision: "create", organizationDecision: "skip" });
          } else {
            const target = entry.existingContactId === undefined ? undefined : contacts.get(entry.existingContactId);
            decisions.push({ entryId: entry.entryId, decision: "merge", organizationDecision: "skip",
              ...(target === undefined ? { targetEntryId: entry.existingEntryId } : {
                targetContactId: target.id, expectedTargetRevision: target.revision
              }) });
          }
        }
      }
      const receipt = contacts.commitSystemContactImport({
        previewId: preview.previewId, expectedDirectoryRevision: preview.directoryRevision, decisions
      }, access.ownerId);
      return { dryRun: false, created: receipt.created, enriched: receipt.enriched, skipped: receipt.skipped,
        reviewCount: review.length, needsReview: review.slice(0, MAX_REPORTED_CONTACTS) };
    } finally {
      contacts.discardSystemContactImport(preview.previewId, access.ownerId);
    }
  };
  return input.dryRun ? read() : runSystemContactOperation(store, access, "mcp_contacts_import_system", read);
}

export async function exportSystemContacts(
  store: OperationalStore, contacts: ContactManager, tools: SystemContactToolsOptions, access: SystemContactToolAccess,
  input: SystemExportInput, signal?: AbortSignal
): Promise<unknown> {
  if (input.dryRun) {
    const check = captureDirectory(contacts, access, false);
    const plan = planSystemWrite(contacts, access.port.deviceId, input);
    check();
    const names = (ids: readonly string[]) => ids.slice(0, MAX_REPORTED_CONTACTS).map(id => plan.names.get(id)!);
    const createIds = plan.items.filter(item => item.nativeId === undefined).map(item => item.contactId);
    const updateIds = plan.items.filter(item => item.nativeId !== undefined).map(item => item.contactId);
    return { dryRun: true, createCount: createIds.length, updateCount: updateIds.length,
      skippedPendingCount: plan.skippedPending.length, unresolvedCount: plan.unresolved.length,
      toCreate: names(createIds), toUpdate: names(updateIds), skippedPending: names(plan.skippedPending), unresolved: names(plan.unresolved) };
  }
  return runSystemContactOperation(store, access, "mcp_contacts_export_system", async (operationId) => {
    const check = captureDirectory(contacts, access, true);
    const plan = planSystemWrite(contacts, access.port.deviceId, input);
    const report: SystemWriteReport = {
      created: 0, updated: 0, missing: 0, failed: 0, unknown: 0, skipped: 0,
      skippedPending: plan.skippedPending.length, unresolved: plan.unresolved.length, issues: []
    };
    if (plan.items.length === 0) return { ...report, dryRun: false };
    const names = plan.items.slice(0, 10).map(item => plan.names.get(item.contactId)).join(", ");
    await approveSystemContacts(tools, access, "export",
      `Write ${plan.items.length} selected contacts${input.group === undefined ? "" : ` from ${input.group}`}.\n${names}`, check, signal);
    let processed = 0;
    for (const batch of systemWriteBatches(plan.items)) {
      let admitted = false;
      const checkBatch = () => {
        check();
        for (const item of batch.items) {
          const current = contacts.store.systemContactAnchor(access.port.deviceId, item.contactId);
          if (current.nativeId !== item.nativeId || current.unresolved !== (admitted && item.nativeId === undefined)) {
            throw new SystemContactToolError("PRECONDITION_FAILED", "The system contact bindings changed. Review a new plan.");
          }
        }
      };
      const creates = batch.items.filter(item => item.nativeId === undefined);
      try {
        const response = await access.port.write(batch, checkBatch, () => {
          contacts.store.runInTransaction(() => {
            checkBatch();
            for (const item of creates) contacts.store.reserveSystemContactCreate(access.port.deviceId, item.contactId, operationId);
          });
          admitted = true;
        }, signal);
        checkBatch();
        if (!admitted || !matchesSystemWriteBatch(batch.items, response.receipts)) {
          throw new SystemContactToolError("EFFECT_OUTCOME_UNKNOWN", "macOS Contacts returned an invalid write receipt.");
        }
        const outcomes = contacts.store.runInTransaction(() => response.receipts.map(receipt => {
          if (receipt.outcome === Outcome.CREATED) {
            try {
              contacts.store.bindSystemContact(access.port.deviceId, receipt.contactId, receipt.nativeId!, operationId);
            } catch (error) {
              if (!(error instanceof ContactStoreError && error.code === "CONTACT_IDENTITY_CONFLICT")) throw error;
              return { ...receipt, outcome: Outcome.UNKNOWN };
            }
          } else if (receipt.outcome === Outcome.FAILED) {
            contacts.store.releaseSystemContactCreate(access.port.deviceId, receipt.contactId, operationId);
          }
          return receipt;
        }));
        for (const receipt of outcomes) addWriteOutcome(report, receipt);
        processed += batch.items.length;
        if (report.unknown !== 0) break;
      } catch (error) {
        if (error instanceof SystemContactsPermissionError) {
          if (admitted) contacts.store.runInTransaction(() => {
            for (const item of creates) contacts.store.releaseSystemContactCreate(access.port.deviceId, item.contactId, operationId);
          });
          report.skipped = plan.items.length - processed;
          throw systemWriteFailure("PERMISSION_DENIED", error.message, report);
        }
        if (admitted) {
          for (const item of batch.items) addWriteOutcome(report, { contactId: item.contactId, outcome: Outcome.UNKNOWN });
          processed += batch.items.length;
        }
        report.skipped = plan.items.length - processed;
        throw systemWriteFailure(admitted ? "EFFECT_OUTCOME_UNKNOWN" : "PRECONDITION_FAILED",
          admitted ? "The dispatched macOS Contacts write could not be confirmed." : "The next macOS Contacts write was not admitted.", report);
      }
    }
    report.skipped = plan.items.length - processed;
    if (report.unknown !== 0) throw systemWriteFailure("EFFECT_OUTCOME_UNKNOWN", "Some macOS Contacts writes could not be confirmed.", report);
    return { ...report, dryRun: false };
  });
}

function captureDirectory(contacts: ContactManager, access: SystemContactToolAccess, writable: boolean): () => void {
  const directory = contacts.directory();
  const assertCurrent = () => {
    if (writable) access.assertWritable();
    else access.assertCurrent();
    const current = contacts.directory();
    if (!current.enabled || current.revision !== directory.revision) {
      throw new SystemContactToolError("PRECONDITION_FAILED", "The Contacts directory changed. Review the selection again.");
    }
  };
  assertCurrent();
  return assertCurrent;
}

async function approveSystemContacts(
  tools: SystemContactToolsOptions, access: SystemContactToolAccess, action: "import" | "export",
  summary: string, assertCurrent: () => void, signal?: AbortSignal
): Promise<void> {
  assertCurrent();
  const approved = await tools.approve({ action, queueId: access.scope.id, connectionId: access.connection.id,
    generation: access.context.generation, summary, assertCurrent }, signal);
  assertCurrent();
  if (!approved) throw new SystemContactToolError("PERMISSION_DENIED", "The originating Desktop did not approve this macOS Contacts request.");
}

async function runSystemContactOperation(
  store: OperationalStore, access: SystemContactToolAccess, kind: "mcp_contacts_import_system" | "mcp_contacts_export_system",
  execute: (operationId: string) => Promise<Readonly<Record<string, unknown>>>
): Promise<unknown> {
  const { requestIdentity, requestBodyHash, sessionId, targetId, generation } = access.context;
  if (requestIdentity === undefined || requestBodyHash === undefined) {
    throw new SystemContactToolError("STALE_SCOPE", "The macOS Contacts request identity is unavailable.");
  }
  const operationId = `mcp-contacts:${requestIdentity}`;
  const { id, authKeyDigest } = access.connection;
  const operation = (() => {
    try {
      return store.claimAuthorizedDeferredEffectOperation<Readonly<Record<string, unknown>>>(id, authKeyDigest, {
        id: operationId, kind, body: { requestBodyHash, sessionId, targetId, generation, runId: access.scope.runId }
      }, access.assertWritable);
    } catch (error) {
      if (error instanceof OperationConflictError) throw new SystemContactToolError("OPERATION_CONFLICT",
        "This macOS Contacts operation ID already belongs to a different request.", { operation_id: operationId });
      if (error instanceof OperationInProgressError) throw new SystemContactToolError("EFFECT_OUTCOME_UNKNOWN",
        "The original macOS Contacts operation is still pending or its outcome is unknown.", { operation_id: operationId }, true);
      if (error instanceof OperationPreviouslyFailedError) {
        const stored = error.storedError as Partial<JokoError["publicError"]> | undefined;
        throw new SystemContactToolError(stored?.code ?? "CONTACTS_EFFECT_FAILED",
          stored?.message ?? "The original macOS Contacts operation failed.", { operation_id: operationId }, stored?.stateMayHaveChanged);
      }
      throw error;
    }
  })();
  if (!operation.claimed) return operation.value;
  const bodyHash = operation.operation.bodyHash;
  try {
    const result = await execute(operationId);
    return store.completeAuthorizedDeferredEffectOperation(id, authKeyDigest, operationId, bodyHash, () => {
      access.assertWritable();
      return { ...result, operation_id: operationId };
    }).value;
  } catch (error) {
    const details = { ...(error instanceof SystemContactToolError ? error.details : {}), operation_id: operationId };
    const failure = error instanceof SystemContactToolError
      ? new SystemContactToolError(error.publicError.code, error.message, details, error.publicError.stateMayHaveChanged)
      : error instanceof SystemContactsPermissionError
        ? new SystemContactToolError("PERMISSION_DENIED", error.message, details)
        : error instanceof ContactManagerError || error instanceof ContactStoreError
          ? new SystemContactToolError("PRECONDITION_FAILED", error.message, details)
          : new SystemContactToolError("CONTACTS_EFFECT_FAILED", "The macOS Contacts operation did not complete.", details, true);
    store.failEffectOperation(operationId, bodyHash, failure);
    throw failure;
  }
}

function planSystemWrite(contacts: ContactManager, deviceId: string, selection: SystemExportInput): SystemWritePlan {
  const ids = selection.ids ?? groupMemberIds(contacts, selection.group!);
  const names = new Map<string, string>();
  const skippedPending: string[] = [], unresolved: string[] = [];
  const items: NativeSystemContactWriteItem[] = [];
  for (const id of ids) {
    const profile = contacts.get(id);
    names.set(id, profile.displayName);
    if (profile.status !== "confirmed") {
      skippedPending.push(id);
      continue;
    }
    const anchor = contacts.store.systemContactAnchor(deviceId, id);
    if (anchor.unresolved) {
      unresolved.push(id);
      continue;
    }
    items.push(create(NativeSystemContactWriteItemSchema, {
      contactId: id, ...(anchor.nativeId === undefined ? {} : { nativeId: anchor.nativeId }), fields: systemWriteFields(profile)
    }));
  }
  return { items, names, skippedPending, unresolved };
}

function groupMemberIds(contacts: ContactManager, name: string): readonly string[] {
  const group = contacts.groups().find(candidate => candidate.name === name);
  if (group === undefined) throw new SystemContactToolError("NOT_FOUND", "The selected Contacts group does not exist.");
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const page = contacts.list({ groupId: group.id, limit: 200, offset });
    ids.push(...page.contacts.map(contact => contact.id));
    if (page.nextOffset === undefined) return ids;
    offset = page.nextOffset;
  }
}

function systemWriteFields(profile: ContactProfileRecord) {
  const employment = profile.kind === "person" ? profile.relations.filter(relation => relation.direction === "outgoing"
    && relation.relatedKind === "organization" && EMPLOYMENT_RELATION.test(relation.relation)).at(-1) : undefined;
  const addresses = (platform: string) => profile.identities.filter(identity => identity.platform === platform)
    .map(({ value, label }) => ({ value, label }));
  return {
    displayName: profile.displayName,
    kind: profile.kind === "organization" ? ContactKind.ORGANIZATION : ContactKind.PERSON,
    organizationName: employment?.relatedDisplayName ?? "", title: contactLine(employment?.note ?? "", 1_000),
    emails: addresses("email"), phones: addresses("phone")
  };
}

function* systemWriteBatches(items: readonly NativeSystemContactWriteItem[]) {
  let batch: NativeSystemContactWriteItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = toBinary(NativeSystemContactWriteItemSchema, item).byteLength + 4;
    if (batch.length === MAX_WRITE_BATCH || bytes + size > MAX_WRITE_BYTES) {
      yield create(NativeSystemContactsWriteRequestSchema, { items: batch });
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length > 0) yield create(NativeSystemContactsWriteRequestSchema, { items: batch });
}

function matchesSystemWriteBatch(items: readonly NativeSystemContactWriteItem[], receipts: readonly NativeSystemContactWriteReceipt[]): boolean {
  return receipts.length === items.length && receipts.every((receipt, index) => {
    const item = items[index]!;
    if (receipt.contactId !== item.contactId) return false;
    if (receipt.outcome === Outcome.CREATED) return item.nativeId === undefined && validSystemContactId(receipt.nativeId);
    if (receipt.outcome === Outcome.UPDATED) return item.nativeId !== undefined && receipt.nativeId === item.nativeId;
    return receipt.nativeId === undefined && (receipt.outcome === Outcome.FAILED || receipt.outcome === Outcome.UNKNOWN
      || (receipt.outcome === Outcome.MISSING && item.nativeId !== undefined));
  });
}

function addWriteOutcome(report: SystemWriteReport, receipt: Pick<NativeSystemContactWriteReceipt, "contactId" | "outcome">): void {
  if (receipt.outcome === Outcome.CREATED) { report.created += 1; return; }
  if (receipt.outcome === Outcome.UPDATED) { report.updated += 1; return; }
  const outcome = receipt.outcome === Outcome.MISSING ? "missing" : receipt.outcome === Outcome.FAILED ? "failed" : "unknown";
  report[outcome] += 1;
  if (report.issues.length < MAX_REPORTED_CONTACTS) report.issues.push({ contact_id: receipt.contactId, outcome });
}

function systemWriteFailure(code: string, message: string, report: SystemWriteReport): SystemContactToolError {
  return new SystemContactToolError(code,
    `${message} Confirmed created: ${report.created}. Confirmed updated: ${report.updated}. Missing: ${report.missing}. Failed: ${report.failed}. Unknown: ${report.unknown}. Skipped: ${report.skipped}.`,
    { ...report }, report.created + report.updated + report.unknown > 0);
}
