import { createHash } from "node:crypto";
import type { ExtensionTargetRef, ExtensionTargetKind, ExtensionTargetView, ExtensionTargetDelivery } from "@joko/contracts";
import type { OperationalStore, QueueItemRecord } from "@joko/store";
import type { SessionDescriptor } from "@joko/core";
import type { ArtifactStore } from "./artifact-store.js";
import type { ExtensionCatalogManager } from "./extension-catalog.js";
import type { ExtensionProjectPolicies } from "./extension-project-policy.js";
import type { ExtensionTasks, ExtensionTaskOwner } from "./extension-tasks.js";
import type { PartnerManager } from "./partner-manager.js";
import type { SessionHost } from "./session-host.js";
import { stageExtensionMessageImages, withExtensionMessageImages, type ExtensionMessageImage } from "./extension-message-attachments.js";

const RECEIPTS = "extension-target-receipts", INPUTS = "extension-target-inputs";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString()
  : item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const failure = (code: string, message = code): never => { throw Object.assign(new Error(message), { code }); };
interface Receipt {
  readonly version: 1; readonly operationId: string; readonly extensionId: string; readonly resourceId: string; readonly installation: string;
  readonly approval: string; readonly fingerprint: string | null; readonly status: "pending" | "accepted" | "cancelled";
  readonly target?: ExtensionTargetRef; readonly projectRevision?: string; readonly sessionId?: string; readonly generation?: number;
  readonly delivery?: ExtensionTargetDelivery; readonly runId?: string; readonly queueItemId?: string;
}
interface Options {
  readonly store: OperationalStore; readonly host: Pick<SessionHost, "enqueueServiceInput">;
  readonly tasks: Pick<ExtensionTasks, "assertOwner" | "createForTarget">;
  readonly catalog: Pick<ExtensionCatalogManager, "get">;
  readonly projects?: Pick<ExtensionProjectPolicies, "enabledForTarget" | "assertEnabledForSession">;
  readonly partners: Pick<PartnerManager, "listPartners" | "getPartner"> & Partial<Pick<PartnerManager, "listSessions">>;
  readonly artifacts: Pick<ArtifactStore, "ingestBytes">;
  readonly redact: (text: string) => string;
}
/** Metadata discovery and one-way input delivery are independent from the
 * plugin's own-task history capability. Every accepted input keeps its issuer. */
export class ExtensionTargets {
  readonly #flights = new Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>();
  constructor(readonly options: Options) {}
  #assert(owner: ExtensionTaskOwner, approval?: string): string {
    this.options.tasks.assertOwner(owner);
    const extension = this.options.catalog.get(owner.extensionId);
    if (extension.runtime?.targets !== true || !extension.permissions.some(permission => permission.id === "runtime-targets" && permission.granted)) {
      return failure("PERMISSION_DENIED", "Independent target delivery approval is required.");
    }
    const current = hash([owner.extensionId, owner.resourceId, owner.installation, extension.owner, extension.revision.toString(), extension.runtime.targets, extension.permissions]);
    if (approval !== undefined && approval !== current) failure("PERMISSION_DENIED", "The original target delivery approval changed.");
    return current;
  }
  #localSession(session: SessionDescriptor, extensionId: string): boolean {
    const target = this.options.store.getTarget(session.targetId), backend = this.options.store.getBackend(session.backendId).descriptor;
    return !session.archived && session.deletedAt === undefined && !session.hidden && !session.remoteWorkspace && !target.descriptor.remoteWorkspace
      && backend.adapterKind !== "hosted" && target.descriptor.trusted
      && !this.options.store.findCollaborationWorkerBySession(session.id)
      && !this.options.store.findSessionRuntimePolicy(session.id)
      && !this.options.store.findPendingSessionLifecycleCleanup(session.id)
      && this.options.projects?.enabledForTarget(extensionId, target.descriptor.id) !== false;
  }
  #candidates(kind: ExtensionTargetKind, extensionId: string): readonly ExtensionTargetView[] {
    if (kind === "project") return this.options.store.listTargets().flatMap(({ descriptor: target, metadata }) => {
      const state = metadata && typeof metadata === "object" && "state" in metadata ? metadata.state : undefined;
      return target.trusted && !target.remoteWorkspace && !target.managed && !["archived", "deleting", "error"].includes(String(state))
        && this.options.store.getBackend(target.backendId).descriptor.adapterKind !== "hosted"
        && this.options.projects?.enabledForTarget(extensionId, target.id) !== false
        ? [{ kind, id: target.id, label: target.displayName, detail: target.workspaceRoot }] : [];
    });
    const partners = this.options.partners.listPartners();
    if (kind === "partner") return partners.flatMap(partner => {
      const session = partner.canonicalSessionId ? this.options.store.findSession(partner.canonicalSessionId)?.descriptor : undefined;
      return partner.lifecycle === "active" && partner.initializationState === "ready" && session && this.#localSession(session, extensionId)
        ? [{ kind, id: partner.id, label: partner.displayName, detail: partner.description.slice(0, 2000) }] : [];
    });
    const partnerSessions = new Set(partners.flatMap(partner => [
      ...(partner.canonicalSessionId ? [partner.canonicalSessionId] : []),
      ...(this.options.partners.listSessions?.(partner.id, true).map(value => value.link.sessionId) ?? [])
    ]));
    return this.options.store.listSessions({ includeArchived: false, includeDeleted: false }).flatMap(({ descriptor: session }) =>
      !partnerSessions.has(session.id) && this.#localSession(session, extensionId)
        ? [{ kind, id: session.id, label: session.title, detail: this.options.store.getTarget(session.targetId).descriptor.workspaceRoot }] : []);
  }
  #resolve(target: ExtensionTargetRef, extensionId: string): { readonly view: ExtensionTargetView; readonly session?: SessionDescriptor; readonly projectRevision?: string } {
    const found = this.#candidates(target.kind, extensionId).find(candidate => candidate.id === target.id);
    if (!found) return failure("TARGET_UNAVAILABLE", "The selected local target is unavailable.");
    if (target.kind === "project") return { view: found, projectRevision: this.options.store.getTarget(target.id).revision.toString() };
    const id = target.kind === "task" ? target.id : this.options.partners.getPartner(target.id).canonicalSessionId;
    if (!id) return failure("TARGET_UNAVAILABLE");
    return { view: found, session: this.options.store.getSession(id).descriptor };
  }
  #receipt(operationId: string): Receipt | undefined { return this.options.store.findSetting<Receipt>("service", RECEIPTS, operationId)?.value; }
  #current(owner: ExtensionTaskOwner, operationId: string): Receipt {
    const receipt = this.#receipt(operationId);
    if (!receipt || receipt.version !== 1 || receipt.extensionId !== owner.extensionId || receipt.installation !== owner.installation
      || receipt.resourceId !== owner.resourceId) return failure("PERMISSION_DENIED");
    this.#assert(owner, receipt.approval);
    if (receipt.status === "cancelled") return failure("SUPERSEDED", "This input was cancelled.");
    if (!receipt.target) return failure("TARGET_UNAVAILABLE");
    const target = this.#resolve(receipt.target, owner.extensionId);
    if (receipt.projectRevision !== target.projectRevision || target.session && (target.session.id !== receipt.sessionId || target.session.binding.generation !== receipt.generation)) {
      return failure("TARGET_UNAVAILABLE", "The original delivery target changed.");
    }
    if (receipt.sessionId) {
      const session = this.options.store.getSession(receipt.sessionId).descriptor;
      if (!this.#localSession(session, owner.extensionId) || session.binding.generation !== receipt.generation) return failure("TARGET_UNAVAILABLE");
      this.options.projects?.assertEnabledForSession(owner.extensionId, session.id);
    }
    return receipt;
  }
  async request(owner: ExtensionTaskOwner, value: unknown): Promise<unknown> {
    const request = object(value), kind = text(request.kind, 16); this.#assert(owner);
    if (kind === "list") {
      exact(request, ["type", "kind", "callId", "targetKind", "after", "limit"]);
      const targetKind = targetKindValue(request.targetKind), after = request.after === undefined ? "" : text(request.after, 512);
      const limit = request.limit === undefined ? 100 : request.limit;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) failure("INVALID_PARAMS");
      const all = [...this.#candidates(targetKind, owner.extensionId)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const page = all.filter(candidate => candidate.id > after).slice(0, Number(limit)); this.#assert(owner);
      return { targets: page, nextCursor: page.length === Number(limit) ? page.at(-1)?.id : null };
    }
    if (kind === "resolve") {
      exact(request, ["type", "kind", "callId", "target"]); const target = targetRef(request.target);
      const result = this.#resolve(target, owner.extensionId).view; this.#assert(owner); return result;
    }
    const requestKey = text(request.requestKey, 200), operationId = `extension-target-${hash([owner.extensionId, owner.installation, requestKey])}`;
    if (kind === "cancel") {
      exact(request, ["type", "kind", "callId", "requestKey"]);
      return this.#cancel(owner, operationId);
    }
    if (kind !== "send") return failure("INVALID_PARAMS");
    exact(request, ["type", "kind", "callId", "requestKey", "target", "text", "title", "route", "delivery", "attachments"]);
    const target = targetRef(request.target), message = text(request.text, 64_000);
    if (this.options.redact(message) !== message) return failure("INVALID_PARAMS", "Protected credentials cannot be sent as target input.");
    const title = request.title === undefined ? undefined : text(request.title, 120), delivery = request.delivery ?? "queue";
    if (delivery !== "queue" && delivery !== "steer" || target.kind === "project" && delivery === "steer" || target.kind !== "project" && request.route !== undefined) return failure("INVALID_PARAMS");
    return withExtensionMessageImages(request.attachments, async images => {
      const fingerprint = hash([target, message, title ?? null, request.route ?? null, delivery, images.map(image => [image.sha256, image.name])]);
      const flight = this.#flights.get(operationId);
      if (flight) { if (flight.fingerprint !== fingerprint) failure("REQUEST_KEY_CONFLICT"); return flight.result; }
      const previous = this.#receipt(operationId);
      if (previous) return this.#replay(owner, previous, fingerprint);
      const selected = this.#resolve(target, owner.extensionId), approval = this.#assert(owner);
      const receipt: Receipt = { version: 1, operationId, extensionId: owner.extensionId, resourceId: owner.resourceId, installation: owner.installation,
        approval, fingerprint, status: "pending", target, ...(selected.projectRevision === undefined ? {} : { projectRevision: selected.projectRevision }),
        ...(selected.session === undefined ? {} : { sessionId: selected.session.id, generation: selected.session.binding.generation }) };
      const claimed = this.options.store.claimDeferredEffectOperation({ id: operationId, kind: "extension_target_send", body: { fingerprint, target, delivery } }, store => {
        this.#assert(owner, approval); store.setSetting("service", RECEIPTS, operationId, receipt);
      });
      if (!claimed.claimed) return this.#replay(owner, this.#receipt(operationId)!, fingerprint);
      const result = this.#send(owner, operationId, images, message, title ?? selected.view.label, request.route, delivery, claimed.operation.bodyHash)
        .finally(() => this.#flights.delete(operationId));
      this.#flights.set(operationId, { fingerprint, result }); return result;
    });
  }
  #replay(owner: ExtensionTaskOwner, receipt: Receipt, fingerprint: string): unknown {
    this.#assert(owner);
    if (receipt.status === "cancelled") return failure("SUPERSEDED");
    if (receipt.fingerprint !== fingerprint) return failure("REQUEST_KEY_CONFLICT");
    if (receipt.status !== "accepted") return failure("DELIVERY_UNCERTAIN", "Inspect the original target delivery before creating another request.");
    return this.#result(receipt);
  }
  #result(receipt: Receipt) { return { taskId: receipt.sessionId, runId: receipt.runId, queueItemId: receipt.queueItemId, accepted: true, delivery: receipt.delivery }; }
  async #send(owner: ExtensionTaskOwner, operationId: string, images: readonly ExtensionMessageImage[], message: string, title: string,
    route: unknown, delivery: ExtensionTargetDelivery, bodyHash: string): Promise<unknown> {
    const current = () => { this.#current(owner, operationId); };
    let receipt = this.#current(owner, operationId);
    if (receipt.target!.kind === "project") {
      const created = object(await this.options.tasks.createForTarget(owner, { requestKey: operationId, title, ...(route === undefined ? {} : { route }) },
        { targetId: receipt.target!.id, assertCurrent: current }));
      current(); const sessionId = text(created.taskId, 512), session = this.options.store.getSession(sessionId).descriptor;
      receipt = { ...receipt, sessionId, generation: session.binding.generation };
      this.options.store.setSetting("service", RECEIPTS, operationId, receipt);
    }
    current();
    const session = this.options.store.getSession(receipt.sessionId!).descriptor;
    const canSteer = this.options.store.getBackend(session.backendId).descriptor.capabilities.get("turn.steer")?.supported === true
      && this.options.store.listRuns({ sessionId: session.id, activeOnly: true, limit: 100 }).some(run => ["running", "waiting", "retrying"].includes(run.descriptor.state));
    const actual: ExtensionTargetDelivery = delivery === "steer" && canSteer ? "steer" : "queue";
    const staging = await stageExtensionMessageImages(images, this.options.artifacts, this.options.store, current);
    try {
      current();
      const accepted = this.options.host.enqueueServiceInput({ operationId: `${operationId}:input`, sessionId: session.id, source: "system",
        prompt: { text: `[Plugin input from ${owner.extensionId}: external application data]\n${message}`, images: staging.images, files: [], mentions: [], disposition: actual === "steer" ? "steer" : "prompt" },
        onAdmitted: (store, input) => {
          current(); staging.adopt(store, input);
          const completed = { ...this.#current(owner, operationId), status: "accepted" as const, delivery: actual, runId: input.runId, queueItemId: input.queueItemId };
          store.completeDeferredEffectOperation(operationId, bodyHash, transaction => {
            current(); transaction.setSetting("service", RECEIPTS, operationId, completed);
            transaction.setSetting("service", INPUTS, input.queueItemId, { version: 1, operationId });
            transaction.setSetting("service", INPUTS, `run:${input.runId}`, { version: 1, operationId });
            return this.#result(completed);
          });
        } });
      this.#assert(owner);
      const completed = this.#receipt(operationId)!;
      if (completed.queueItemId !== accepted.value.queueItemId) return failure("DELIVERY_UNCERTAIN");
      return this.#result(completed);
    } finally { staging.release(); }
  }
  #cancel(owner: ExtensionTaskOwner, operationId: string) {
    this.#assert(owner); const existing = this.#receipt(operationId);
    if (existing && (existing.extensionId !== owner.extensionId || existing.installation !== owner.installation)) return failure("PERMISSION_DENIED");
    let runningWorkMayHaveStarted = false;
    this.options.store.runOperation({ id: `${operationId}:cancel`, kind: "extension_target_cancel", body: { operationId } }, store => {
      this.#assert(owner); const receipt = this.#receipt(operationId);
      const cancelled: Receipt = receipt ? { ...receipt, status: "cancelled" } : { version: 1, operationId, extensionId: owner.extensionId, resourceId: owner.resourceId,
        installation: owner.installation, approval: this.#assert(owner), fingerprint: null, status: "cancelled" };
      store.setSetting("service", RECEIPTS, operationId, cancelled);
      if (receipt?.queueItemId) {
        const item = store.getQueueItem(receipt.queueItemId);
        if (item.state === "accepted") store.cancelQueueItem({ queueItemId: item.id, expectedRevision: item.revision, traceId: `extension-target-cancel:${operationId}` });
        else runningWorkMayHaveStarted = !["cancelled", "failed"].includes(item.state);
      }
      return { cancelled: true, runningWorkMayHaveStarted };
    });
    const current = this.#receipt(operationId), item = current?.queueItemId ? this.options.store.getQueueItem(current.queueItemId) : undefined;
    return { cancelled: true, runningWorkMayHaveStarted: item ? !["accepted", "cancelled", "failed"].includes(item.state) : false };
  }
  /** true means this target receipt owns admission; ordinary plugin-task
   * checks must not reinterpret it as a team-generated automatic input. */
  assertQueueCurrent(item: QueueItemRecord): boolean {
    const store = this.options.store;
    let link = store.findSetting<{ readonly version: 1; readonly operationId: string }>("service", INPUTS, item.id)?.value;
    let originRunId = item.runId;
    const seen = new Set<string>();
    while (!link && !seen.has(originRunId) && seen.size < 64) {
      seen.add(originRunId);
      link = store.findSetting<{ readonly version: 1; readonly operationId: string }>("service", INPUTS, `run:${originRunId}`)?.value;
      if (link) break;
      const parent = store.findRun(originRunId)?.descriptor.parentRunId;
      if (!parent) break; originRunId = parent;
    }
    if (!link) return false;
    const receipt = this.#receipt(link.operationId);
    if (link.version !== 1 || !receipt || receipt.runId !== originRunId || receipt.sessionId !== item.sessionId) return failure("PERMISSION_DENIED");
    this.#current({ extensionId: receipt.extensionId, resourceId: receipt.resourceId, installation: receipt.installation,
      signal: new AbortController().signal, assertCurrent: () => {} }, receipt.operationId);
    return true;
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.#flights.values()].map(flight => flight.result)); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("INVALID_PARAMS"); return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) return failure("INVALID_PARAMS"); return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).some(key => !keys.includes(key))) failure("INVALID_PARAMS"); }
function targetKindValue(value: unknown): ExtensionTargetKind {
  if (value !== "project" && value !== "task" && value !== "partner") return failure("INVALID_PARAMS"); return value;
}
function targetRef(value: unknown): ExtensionTargetRef {
  const target = object(value); exact(target, ["kind", "id"]); return { kind: targetKindValue(target.kind), id: text(target.id, 512) };
}
