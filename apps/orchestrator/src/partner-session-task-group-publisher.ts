import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { redactSecrets, type BlobRef, type InteractionPayload, type MessageBlock } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { PartnerNetworkOwnerTaskScope } from "./partner-network-runtime.js";
import type { PartnerSessionTaskRecord } from "./partner-session-tasks.js";

const SCOPE = "partner.session-task-group-deliveries", MAX_FILE = 100 * 1024 * 1024, CHUNK = 256 * 1024;
export interface PartnerSessionTaskGroupOrigin {
  readonly version: 1; readonly roomId: string; readonly joinId: string; readonly hostServerId: string;
  readonly actorId: string; readonly ownerId: string; readonly sourceMessageId: string; readonly accessRevision: string;
  readonly fallbackSessionId: string;
}
export interface PartnerSessionTaskGroupPort {
  capture(sessionId: string): PartnerNetworkOwnerTaskScope | undefined;
  homeServerId(): string;
  locale?(): string;
  publish(origin: PartnerSessionTaskGroupOrigin, request: contract.PublishPartnerNetworkActorRequest, signal: AbortSignal): Promise<unknown>;
  media(origin: PartnerSessionTaskGroupOrigin, request: contract.MediaPartnerNetworkRequest, signal: AbortSignal): Promise<contract.MediaPartnerNetworkResponse>;
  readArtifact(blob: BlobRef): Promise<Uint8Array>;
}
interface SavedAttachment { readonly blob: BlobRef; readonly attachment?: { readonly id: string; readonly name: string; readonly mediaType: string; readonly sizeBytes: number }; readonly skipped?: string }
interface Delivery {
  readonly version: 1; readonly id: string; readonly taskId: string; readonly execution: number;
  readonly kind: "running" | "interaction" | "terminal"; readonly origin: PartnerSessionTaskGroupOrigin;
  readonly text: string; readonly fallback: string; readonly card: { readonly taskId: string; readonly homeServerId: string; readonly ownerId: string; readonly actorId: string;
    readonly title: string; readonly status: string; readonly revision: string; readonly sessionId: string; readonly execution: string; readonly interactionKind: string; readonly question: string };
  readonly files: readonly SavedAttachment[]; readonly publishedParts: number; readonly attempts: number; readonly nextAt: number;
  readonly state: "pending" | "delivered" | "fallback" | "private" | "failed" | "skipped";
  readonly failure?: string;
}
export type GroupTaskDeliveryResult = "delivered" | "retry" | "fallback";

/** Publication uses current room membership, independently of the execution that
 * admitted the task. Durable message identities never cause task input replay. */
export class PartnerSessionTaskGroupPublisher {
  readonly #lifetime = new AbortController();
  constructor(readonly store: OperationalStore, readonly port: PartnerSessionTaskGroupPort, readonly now = Date.now) {
    for (const row of store.listSettings("service", SCOPE)) readDelivery(row.value);
  }
  capture(sessionId: string) { return this.port.capture(sessionId); }
  close() { this.#lifetime.abort(); }
  nextAttempt(taskId: string): number | undefined {
    const pending = this.store.listSettings("service", SCOPE).map(row => readDelivery(row.value)).filter(row => row.taskId === taskId && (row.state === "pending" || row.kind === "terminal" && row.state === "fallback"));
    return pending.length ? Math.min(...pending.map(row => row.nextAt)) : undefined;
  }
  forget(taskId: string) { for (const row of this.store.listSettings("service", SCOPE)) if (readDelivery(row.value).taskId === taskId) this.store.deleteSetting("service", SCOPE, row.key); }
  async running(task: PartnerSessionTaskRecord): Promise<GroupTaskDeliveryResult> {
    return this.#deliver(this.#ensure(task, "running", `running:${task.execution}`, "running", ""));
  }
  async interaction(task: PartnerSessionTaskRecord, interaction: { readonly id: string; readonly generation: number; readonly payload: InteractionPayload }): Promise<GroupTaskDeliveryResult> {
    const payload = interaction.payload, kind = payload.kind === "question" ? "question" : payload.kind === "plan_review" ? "plan_review" : "permission";
    const question = payload.kind === "question" ? redactSecrets([payload.title, payload.prompt, ...payload.fields.flatMap(field => [field.label,
      ...(field.description ? [field.description] : []), ...("choices" in field ? field.choices.map(choice => `${choice.label}${choice.description ? `: ${choice.description}` : ""}`) : [])])].join("\n")) : "";
    return this.#deliver(this.#ensure(task, "interaction", `interaction:${hash(JSON.stringify([interaction.id, interaction.generation]))}`,
      "waiting", question, kind));
  }
  async terminal(task: PartnerSessionTaskRecord): Promise<GroupTaskDeliveryResult> {
    this.skipProgress(task.id);
    return this.#deliver(this.#ensure(task, "terminal", `result:${task.execution}`, task.status, redactSecrets(task.result ?? task.error ?? "")));
  }
  async retryEarlierResults(task: PartnerSessionTaskRecord) {
    const pending = this.store.listSettings("service", SCOPE).map(row => readDelivery(row.value));
    for (const job of pending) if (job.taskId === task.id && job.execution < task.execution && job.kind === "terminal" && job.state === "pending") await this.#deliver(job);
    return this.store.listSettings("service", SCOPE).map(row => readDelivery(row.value))
      .filter(job => job.taskId === task.id && job.execution < task.execution && job.kind === "terminal" && job.state === "fallback" && job.nextAt <= this.now())
      .map(deliverySnapshot);
  }
  privateResult(task: PartnerSessionTaskRecord) {
    this.skipProgress(task.id);
    const job = this.#ensure(task, "terminal", `result:${task.execution}`, task.status, redactSecrets(task.result ?? task.error ?? ""));
    if (job.state === "private") return { ...deliverySnapshot(job), delivered: true, ready: true, failed: false };
    if (job.state === "failed") return { ...deliverySnapshot(job), delivered: false, ready: false, failed: true };
    this.#save({ ...job, state: "fallback" }); return { ...deliverySnapshot(job), delivered: false, ready: job.nextAt <= this.now(), failed: false };
  }
  publishPrivate(id: string, sessionId: string, assertCurrent: () => void) {
    const job = readDelivery(this.store.getSetting("service", SCOPE, id).value);
    assertCurrent();
    if (job.origin.fallbackSessionId !== sessionId || job.card.homeServerId !== this.port.homeServerId()) throw new Error("The original private destination changed.");
    this.store.runOperation({ id: `${job.id}:private`, kind: "partner_group_task_private_result", body: { deliveryId: job.id, sessionId, text: job.text, files: job.files.map(file => file.blob) } }, store => {
      assertCurrent(); const session = store.getSession(sessionId).descriptor;
      if (session.archived || session.deletedAt !== undefined || !store.getTarget(session.targetId).descriptor.trusted) throw new Error("The original private destination is unavailable.");
      const files: MessageBlock[] = [];
      for (const file of job.files) {
        if (file.blob.byteLength < 1 || file.blob.byteLength > MAX_FILE) continue;
        const source = store.findArtifact(file.blob.id);
        if (!source || source.deletedAt !== undefined || source.sessionId !== job.card.sessionId || source.blob.id !== file.blob.id || source.blob.sha256 !== file.blob.sha256
          || source.blob.byteLength !== file.blob.byteLength || source.blob.mimeType !== file.blob.mimeType || source.blob.fileName !== file.blob.fileName) continue;
        const copied = store.putArtifact({ id: `partner-task-return:${hash(JSON.stringify([job.id, sessionId, source.blob.id]))}`, sha256: source.blob.sha256,
          byteLength: source.blob.byteLength, mimeType: source.blob.mimeType, ...(source.blob.fileName === undefined ? {} : { fileName: source.blob.fileName }),
          storageKey: source.storageKey, sessionId, metadata: {}, purpose: "partner_group_task_return", traceId: `${job.id}:private` });
        files.push({ kind: "artifact", blob: copied.blob, label: copied.blob.fileName ?? "Artifact" });
      }
      const text = splitText(job.text, 24_000), count = Math.max(text.length, Math.ceil(files.length / 20), 1);
      for (let part = 0; part < count; part++) store.appendEventIfAbsent({ id: `${job.id}:private:${part}`, backendId: session.backendId, targetId: session.targetId,
        sessionId, generation: session.binding.generation, traceId: `${job.id}:private`, payload: { type: "message_complete", role: "assistant",
          blocks: [...(text[part] ? [{ kind: "text" as const, text: text[part]! }] : []), ...files.slice(part * 20, (part + 1) * 20)] },
        metadata: { namespace: "joko.partner_task_result", fields: { taskId: job.taskId, execution: job.execution, sourceRoomId: job.origin.roomId,
          sourceHostServerId: job.origin.hostServerId, sourceActorId: job.origin.actorId } } });
      this.#save({ ...job, state: "private" }); return { delivered: true };
    });
  }
  failPrivate(id: string) { const job = readDelivery(this.store.getSetting("service", SCOPE, id).value);
    this.#save({ ...job, state: "failed", failure: "The original private destination is no longer available. Open the independent task to read its result." }); }
  deferPrivate(id: string) {
    const job = readDelivery(this.store.getSetting("service", SCOPE, id).value), attempts = job.attempts + 1;
    this.#save({ ...job, state: "fallback", attempts, nextAt: this.now() + Math.min(120_000, 1_000 * 2 ** Math.min(attempts - 1, 7)) });
  }
  skipProgress(taskId: string) {
    for (const row of this.store.listSettings("service", SCOPE)) {
      const job = readDelivery(row.value);
      if (job.taskId === taskId && job.kind !== "terminal" && (job.state === "pending" || job.state === "fallback")) this.#save({ ...job, state: "skipped" });
    }
  }
  synchronizeProgress(task: PartnerSessionTaskRecord, interactions: readonly { readonly id: string; readonly generation: number }[]) {
    const active = !task.groupFallback && ["preparing", "queued", "running", "waiting"].includes(task.status);
    const current = new Set(interactions.map(interaction => deliveryId(task.id, `interaction:${hash(JSON.stringify([interaction.id, interaction.generation]))}`)));
    for (const row of this.store.listSettings("service", SCOPE)) {
      const job = readDelivery(row.value);
      if (job.taskId === task.id && job.kind !== "terminal" && (job.state === "pending" || job.state === "fallback")
        && (!active || job.execution !== task.execution || job.kind === "interaction" && !current.has(job.id))) this.#save({ ...job, state: "skipped" });
    }
  }
  #ensure(task: PartnerSessionTaskRecord, kind: Delivery["kind"], suffix: string, status: string, text: string, interactionKind = ""): Delivery {
    if (!task.group) throw new Error("The task has no group origin.");
    const id = deliveryId(task.id, suffix), old = this.store.findSetting("service", SCOPE, id);
    if (old) return readDelivery(old.value);
    const files: SavedAttachment[] = [];
    if (kind === "terminal" && task.sessionId) {
      for (let offset = 0; ; offset += 100) {
        const page = this.store.listArtifacts({ sessionId: task.sessionId, limit: 100, offset });
        for (const artifact of page) if (artifact.deletedAt === undefined) files.push({ blob: artifact.blob,
          ...(artifact.blob.byteLength < 1 || artifact.blob.byteLength > MAX_FILE ? { skipped: "The file is empty or exceeds the room file limit." } : {}) });
        if (page.length < 100) break;
      }
    }
    const messages = contract.partnerNetworkMessages(this.port.locale?.() ?? "en");
    const label = status === "completed" ? messages.taskCompleted : status === "timed-out" ? messages.taskTimedOut : status === "cancelled" ? messages.taskCancelled
      : status === "failed" ? messages.taskFailed : status === "waiting" ? messages.taskWaiting : messages.taskRunning;
    const fallback = `${task.title} — ${label}`;
    const job: Delivery = { version: 1, id, taskId: task.id, execution: task.execution, kind, origin: task.group, text: text || fallback, fallback,
      card: { taskId: task.id, homeServerId: this.port.homeServerId(), ownerId: task.group.ownerId, actorId: task.group.actorId,
        title: task.title, status, revision: String(task.updatedAt), sessionId: task.sessionId ?? "", execution: String(task.execution), interactionKind,
        question: interactionKind === "question" ? text.slice(0, 16_000) : "" }, files, publishedParts: 0, attempts: 0, nextAt: this.now(), state: "pending" };
    this.#save(job); return job;
  }
  async #deliver(initial: Delivery): Promise<GroupTaskDeliveryResult> {
    if (initial.state === "delivered" || initial.state === "private" || initial.state === "skipped") return "delivered";
    if (initial.state === "failed") return "fallback";
    if (initial.state === "fallback") return "fallback";
    if (initial.nextAt > this.now()) return "retry";
    let job = initial; const signal = this.#lifetime.signal;
    try {
      signal.throwIfAborted();
      for (let index = 0; index < job.files.length; index++) {
        const file = job.files[index]!; if (file.skipped || file.attachment) continue;
        let saved: SavedAttachment;
        try { saved = { ...file, attachment: await this.#upload(job, file.blob, index, signal) }; }
        catch (error) {
          if (!definitive(error) && !localFileFailure(error)) throw error;
          // Persist the rejected file diagnostic; accepted files continue.
          saved = { ...file, skipped: localFileFailure(error) ? "The adopted file is unavailable." : "The room refused this file." };
        }
        job = { ...job, files: job.files.map((value, at) => at === index ? saved : value) }; this.#save(job);
      }
      const text = job.kind === "interaction" && job.card.question ? [job.fallback, ...splitText(job.text.slice(job.card.question.length), 24_000)]
        : job.text ? splitText(job.text, 24_000) : [""], attachments = job.files.flatMap(file => file.attachment ? [file.attachment] : []);
      const count = Math.max(text.length, Math.ceil(attachments.length / 20), 1);
      for (let part = job.publishedParts; part < count; part++) {
        signal.throwIfAborted();
        const card = part === 0 ? create(contract.PartnerNetworkTaskCardSchema, { ...job.card, revision: BigInt(job.card.revision), execution: BigInt(job.card.execution) }) : undefined;
        const request = create(contract.PublishPartnerNetworkActorRequestSchema, { roomId: job.origin.roomId, actorId: job.origin.actorId,
          operationId: `${job.id}:${part}`, text: text[part] ?? "", attachments: attachments.slice(part * 20, (part + 1) * 20).map(item => ({ ...item, sizeBytes: BigInt(item.sizeBytes) })),
          ...(card ? { task: card } : {}) });
        await this.port.publish(job.origin, request, signal); signal.throwIfAborted();
        job = { ...job, publishedParts: part + 1 }; this.#save(job);
      }
      this.#save({ ...job, state: "delivered" }); return "delivered";
    } catch (error) {
      if (signal.aborted) return "retry";
      if (definitive(error)) { this.#save({ ...job, state: "fallback" }); return "fallback"; }
      const attempts = job.attempts + 1;
      this.#save({ ...job, attempts, nextAt: this.now() + Math.min(120_000, 1_000 * 2 ** Math.min(attempts - 1, 7)) }); return "retry";
    }
  }
  async #upload(job: Delivery, blob: BlobRef, index: number, signal: AbortSignal): Promise<NonNullable<SavedAttachment["attachment"]>> {
    let data: Uint8Array;
    try { data = await this.port.readArtifact(blob); } catch { throw new LocalFileError(); }
    signal.throwIfAborted();
    if (data.byteLength !== blob.byteLength || hashBytes(data) !== blob.sha256) throw new LocalFileError();
    const base = { roomId: job.origin.roomId, joinId: job.origin.joinId, operationId: `${job.id}:file:${index}`,
      name: blob.fileName ?? "Artifact", mediaType: blob.mimeType, sizeBytes: BigInt(blob.byteLength) };
    let response = await this.port.media(job.origin, create(contract.MediaPartnerNetworkRequestSchema, { ...base, action: "begin" }), signal);
    while (!response.complete) {
      const offset = Number(response.offset);
      if (!response.attachment?.id || !Number.isSafeInteger(offset) || offset < 0 || offset >= data.length) throw new Error("The room returned an invalid upload offset.");
      const next = await this.port.media(job.origin, create(contract.MediaPartnerNetworkRequestSchema, { ...base, action: "write", mediaId: response.attachment.id,
        offset: BigInt(offset), data: data.slice(offset, offset + CHUNK) }), signal);
      if (next.offset <= response.offset) throw new Error("The upload did not advance."); response = next; signal.throwIfAborted();
    }
    const attachment = response.attachment;
    if (!attachment?.id || attachment.name !== base.name || attachment.mediaType !== base.mediaType || attachment.sizeBytes !== base.sizeBytes || response.offset !== base.sizeBytes) throw new Error("The adopted upload changed.");
    return { id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: Number(attachment.sizeBytes) };
  }
  #save(job: Delivery) { this.store.setSetting("service", SCOPE, job.id, job, this.now()); }
}
export function readPartnerSessionTaskGroupOrigin(value: unknown): PartnerSessionTaskGroupOrigin {
  if (!record(value) || value["version"] !== 1 || Object.keys(value).some(key => !["version", "roomId", "joinId", "hostServerId", "actorId", "ownerId", "sourceMessageId", "accessRevision", "fallbackSessionId"].includes(key))
    || ["roomId", "hostServerId", "actorId", "ownerId", "sourceMessageId", "accessRevision", "fallbackSessionId"].some(key => typeof value[key] !== "string" || !value[key]) || typeof value["joinId"] !== "string") throw new Error("Rebuild incompatible development task origin data.");
  return value as unknown as PartnerSessionTaskGroupOrigin;
}
function readDelivery(value: unknown): Delivery {
  if (!record(value) || value["version"] !== 1 || !["pending", "delivered", "fallback", "private", "failed", "skipped"].includes(String(value["state"]))
    || !["running", "interaction", "terminal"].includes(String(value["kind"])) || !record(value["card"]) || !Array.isArray(value["files"])
    || ["id", "taskId", "text", "fallback"].some(key => typeof value[key] !== "string") || ["execution", "publishedParts", "attempts", "nextAt"].some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new Error("Rebuild incompatible development task delivery data.");
  readPartnerSessionTaskGroupOrigin(value["origin"]); return value as unknown as Delivery;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function definitive(error: unknown) { return error instanceof ConnectError ? [Code.PermissionDenied, Code.Unauthenticated, Code.NotFound, Code.InvalidArgument, Code.FailedPrecondition, Code.ResourceExhausted].includes(error.code)
  : record(error) && ["denied", "not_found", "invalid", "expired"].includes(String(error["code"])); }
class LocalFileError extends Error {}
function localFileFailure(error: unknown) { return error instanceof LocalFileError || record(error) && ["ENOENT", "EACCES", "EPERM", "ARTIFACT_NOT_FOUND"].includes(String(error["code"])); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function deliveryId(taskId: string, suffix: string) { return `partner-task-group:${hash(JSON.stringify([taskId, suffix]))}`; }
function deliverySnapshot(job: Delivery) { return { id: job.id, execution: job.execution, title: job.card.title, status: job.card.status, sessionId: job.card.sessionId, result: job.text, fallbackSessionId: job.origin.fallbackSessionId,
  artifacts: job.files.map(file => ({ id: file.blob.id, name: file.blob.fileName ?? "Artifact", mimeType: file.blob.mimeType })) }; }
function hashBytes(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function splitText(value: string, maximum: number): string[] { const parts: string[] = []; for (let start = 0; start < value.length;) { let end = Math.min(start + maximum, value.length);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--; parts.push(value.slice(start, end)); start = end; } return parts; }
