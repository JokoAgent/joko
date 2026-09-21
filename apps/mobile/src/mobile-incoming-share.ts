import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  appendMobileComposerAttachments,
  assertMobileAttachmentCandidate,
  normalizeMobileAttachmentFileName,
  type MobileAttachmentControls,
  type MobileAttachmentPolicy,
  type MobileComposerAttachment,
  type MobileLocalComposerAttachment,
  type MobilePickedAttachmentCandidate
} from "./mobile-attachments";
import type { MobileAttachmentFiles } from "./mobile-attachment-files";
import type {
  MobileNewTaskDraft,
  MobileNewTaskDraftIdentity,
  MobileNewTaskDraftSnapshot,
  MobileNewTaskDraftStore,
  MobileNewTaskEditableDraft
} from "./new-task-draft-store";

export interface MobileIncomingShareReadyItem {
  readonly state: "ready";
  readonly itemId: string;
  readonly ordinal: number;
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export interface MobileIncomingShareRejectedItem {
  readonly state: "rejected";
  readonly itemId: string;
  readonly ordinal: number;
  readonly fileName?: string;
  readonly reason: string;
}

export type MobileIncomingShareItem = MobileIncomingShareReadyItem | MobileIncomingShareRejectedItem;

interface MobileIncomingShareBatchBase {
  readonly batchId: string;
  readonly orderKey: string;
  readonly createdAtUnixMs: number;
  readonly boundProfileId?: string;
}

export interface MobileIncomingShareClaim {
  readonly claimId: string;
  readonly targetId: string;
  readonly surfaceOwnerKey: string;
  readonly policyKey: string;
  readonly acceptedItemIds: readonly string[];
}

export interface MobileIncomingShareReadyBatch extends MobileIncomingShareBatchBase {
  readonly status: "ready";
  readonly overflowCount: number;
  readonly items: readonly MobileIncomingShareItem[];
  readonly claim?: MobileIncomingShareClaim;
}

export interface MobileIncomingShareInvalidBatch extends MobileIncomingShareBatchBase {
  readonly status: "invalid";
  readonly invalidReason: string;
}

export type MobileIncomingShareBatch = MobileIncomingShareReadyBatch | MobileIncomingShareInvalidBatch;

export interface MobileIncomingShareSnapshot {
  readonly supported: boolean;
  readonly busy: boolean;
  readonly batch?: MobileIncomingShareBatch;
  readonly error?: string;
}

export interface MobileIncomingShareNativeDriver {
  readonly supported: boolean;
  getNextBatch(): Promise<unknown | null>;
  bindBatch(batchId: string, profileId: string): Promise<unknown>;
  claimBatch(
    batchId: string,
    profileId: string,
    targetId: string,
    surfaceOwnerKey: string,
    policyKey: string,
    acceptedItemIds: readonly string[]
  ): Promise<unknown>;
  acknowledgeBatch(batchId: string, profileId: string, claimId: string): Promise<void>;
  discardBatch(batchId: string): Promise<void>;
}

export interface MobileIncomingShareAcceptedItem extends MobilePickedAttachmentCandidate {
  readonly itemId: string;
  readonly ordinal: number;
  readonly sha256Hex: string;
  readonly storageId: string;
}

export interface MobileIncomingSharePlanRejection {
  readonly itemId?: string;
  readonly ordinal: number;
  readonly fileName?: string;
  readonly reason: string;
}

export interface MobileIncomingSharePlan {
  readonly accepted: readonly MobileIncomingShareAcceptedItem[];
  readonly rejected: readonly MobileIncomingSharePlanRejection[];
}

type MobileIncomingShareListener = () => void;

export class MobileIncomingShareInbox {
  private listeners = new Set<MobileIncomingShareListener>();
  private current: MobileIncomingShareSnapshot;
  private operation?: Promise<unknown>;

  constructor(private readonly driver: MobileIncomingShareNativeDriver = nativeIncomingShareDriver) {
    this.current = { supported: driver.supported, busy: false };
  }

  get snapshot(): MobileIncomingShareSnapshot { return this.current; }

  subscribe(listener: MobileIncomingShareListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<void> {
    if (!this.driver.supported) return Promise.resolve();
    if (this.operation) return this.operation.then(() => undefined);
    return this.run(async () => {
      const raw = await this.driver.getNextBatch();
      this.publish({ supported: true, busy: true, ...(raw === null ? {} : { batch: normalizeBatch(raw) }) });
    });
  }

  bind(batchId: string, profileId: string): Promise<void> {
    return this.run(async () => {
      const batch = this.requiredBatch(batchId);
      if (batch.status !== "ready") throw new Error("The malformed incoming share cannot be bound to a connection.");
      if (batch.boundProfileId !== undefined && batch.boundProfileId !== profileId) {
        throw new Error("This incoming share is already bound to another Joko connection profile.");
      }
      const next = normalizeBatch(await this.driver.bindBatch(batchId, profileId));
      if (next.status !== "ready" || next.batchId !== batchId || next.boundProfileId !== profileId) {
        throw new Error("The native incoming-share profile binding could not be confirmed.");
      }
      this.publish({ supported: true, busy: true, batch: next });
    });
  }

  claim(
    batchId: string,
    profileId: string,
    targetId: string,
    controls: MobileAttachmentControls,
    plan: MobileIncomingSharePlan
  ): Promise<MobileIncomingShareReadyBatch> {
    return this.run(async () => {
      const batch = this.requiredBatch(batchId);
      if (batch.status !== "ready" || batch.boundProfileId !== profileId
        || controls.profileId !== profileId) {
        throw new Error("The incoming share is not bound to this Joko connection profile.");
      }
      const policyKey = mobileIncomingSharePolicyKey(controls.policy);
      const acceptedItemIds = plan.accepted.map((item) => item.itemId);
      const next = normalizeBatch(await this.driver.claimBatch(
        batchId,
        profileId,
        targetId,
        controls.surfaceOwnerKey,
        policyKey,
        acceptedItemIds
      ));
      if (next.status !== "ready" || next.batchId !== batchId || next.boundProfileId !== profileId
        || !mobileIncomingShareClaimMatches(next, targetId, controls, plan)) {
        throw new Error("The native incoming-share target claim could not be confirmed.");
      }
      this.publish({ supported: true, busy: true, batch: next });
      return next;
    });
  }

  acknowledge(batchId: string, profileId: string, claimId: string): Promise<void> {
    return this.run(async () => {
      const batch = this.requiredBatch(batchId);
      if (batch.status !== "ready" || batch.boundProfileId !== profileId
        || batch.claim?.claimId !== claimId) {
        throw new Error("The incoming share claim is not owned by this Joko connection profile.");
      }
      await this.driver.acknowledgeBatch(batchId, profileId, claimId);
      await this.loadAfterRemoval();
    });
  }

  discard(batchId: string): Promise<void> {
    return this.run(async () => {
      this.requiredBatch(batchId);
      await this.driver.discardBatch(batchId);
      await this.loadAfterRemoval();
    });
  }

  private requiredBatch(batchId: string): MobileIncomingShareBatch {
    assertUuid(batchId, "incoming share");
    const batch = this.current.batch;
    if (!batch || batch.batchId !== batchId) throw new Error("The incoming share changed before the action completed.");
    return batch;
  }

  private async loadAfterRemoval(): Promise<void> {
    this.publish({ supported: true, busy: true });
    try {
      const raw = await this.driver.getNextBatch();
      this.publish({ supported: true, busy: true, ...(raw === null ? {} : { batch: normalizeBatch(raw) }) });
    } catch (failure) {
      this.publish({ supported: true, busy: true, error: errorText(failure) });
    }
  }

  private run<Result>(effect: () => Promise<Result>): Promise<Result> {
    if (!this.driver.supported) return Promise.reject(new Error("Incoming sharing is unavailable on this platform."));
    if (this.operation) return Promise.reject(new Error("Another incoming-share action is already in progress."));
    this.publish({ ...this.current, busy: true, error: undefined });
    const operation = effect().catch((failure) => {
      this.publish({ ...this.current, busy: true, error: errorText(failure) });
      throw failure;
    }).finally(() => {
      if (this.operation === operation) {
        this.operation = undefined;
        this.publish({ ...this.current, busy: false });
      }
    });
    this.operation = operation;
    return operation;
  }

  private publish(next: MobileIncomingShareSnapshot): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}

export function planMobileIncomingShare(
  batch: MobileIncomingShareReadyBatch,
  current: readonly MobileComposerAttachment[],
  policy: MobileAttachmentPolicy
): MobileIncomingSharePlan {
  const accepted: MobileIncomingShareAcceptedItem[] = [];
  const rejected: MobileIncomingSharePlanRejection[] = [];
  const batchStorageIds = new Set(batch.items.filter(
    (item): item is MobileIncomingShareReadyItem => item.state === "ready"
  ).map((item) => incomingShareStorageId(batch.batchId, item.itemId)));
  const occupiedByOtherInputs = current.filter((attachment) => !batchStorageIds.has(attachment.attachmentId)).length;
  let remaining = Math.max(0, policy.maximumItems - occupiedByOtherInputs);
  for (const item of batch.items) {
    if (item.state === "rejected") {
      rejected.push({
        itemId: item.itemId,
        ordinal: item.ordinal,
        ...(item.fileName === undefined ? {} : { fileName: item.fileName }),
        reason: item.reason
      });
      continue;
    }
    try {
      assertMobileAttachmentCandidate(item, policy);
      if (remaining <= 0) {
        rejected.push({
          itemId: item.itemId,
          ordinal: item.ordinal,
          fileName: item.fileName,
          reason: `The current project allows at most ${policy.maximumItems} attachments in this message.`
        });
        continue;
      }
      accepted.push({
        itemId: item.itemId,
        ordinal: item.ordinal,
        uri: item.uri,
        fileName: item.fileName,
        mediaType: item.mediaType,
        byteSize: item.byteSize,
        sha256Hex: item.sha256Hex,
        storageId: incomingShareStorageId(batch.batchId, item.itemId)
      });
      remaining -= 1;
    } catch (failure) {
      rejected.push({
        itemId: item.itemId,
        ordinal: item.ordinal,
        fileName: item.fileName,
        reason: errorText(failure)
      });
    }
  }
  if (batch.overflowCount > 0) {
    rejected.push({
      ordinal: Number.MAX_SAFE_INTEGER,
      reason: `${batch.overflowCount} additional shared ${batch.overflowCount === 1 ? "item was" : "items were"} rejected because one share can contain at most 20 items.`
    });
  }
  return { accepted, rejected };
}

export function mobileIncomingShareProfileRetired(
  batch: MobileIncomingShareBatch | undefined,
  activeProfileId: string | undefined,
  connectionStarting: boolean,
  savedProfileIds: readonly string[]
): boolean {
  if (connectionStarting || batch?.boundProfileId === undefined) return false;
  return activeProfileId === undefined
    ? !savedProfileIds.includes(batch.boundProfileId)
    : batch.boundProfileId !== activeProfileId;
}

export function mobileIncomingSharePolicyKey(policy: MobileAttachmentPolicy): string {
  const key = JSON.stringify({
    images: policy.images,
    files: policy.files,
    maximumItems: policy.maximumItems,
    maximumBytes: policy.maximumBytes,
    imageMediaTypes: [...policy.imageMediaTypes],
    fileMediaTypes: [...policy.fileMediaTypes]
  });
  if (key.length > 16_384) throw new Error("The project attachment policy is too large to freeze safely.");
  return key;
}

export function mobileIncomingShareClaimMatches(
  batch: MobileIncomingShareReadyBatch,
  targetId: string,
  controls: MobileAttachmentControls,
  plan: MobileIncomingSharePlan
): boolean {
  const claim = batch.claim;
  return claim !== undefined && claim.targetId === targetId
    && claim.surfaceOwnerKey === controls.surfaceOwnerKey
    && claim.policyKey === mobileIncomingSharePolicyKey(controls.policy)
    && equalStrings(claim.acceptedItemIds, plan.accepted.map((item) => item.itemId));
}

export interface MobileIncomingShareCommitRequest {
  readonly batch: MobileIncomingShareReadyBatch;
  readonly profileId: string;
  readonly targetId: string;
  readonly controls: MobileAttachmentControls;
  readonly draftStore: Pick<MobileNewTaskDraftStore, "readSnapshot" | "saveIfRevision" | "flush" | "readSync">;
  readonly attachmentFiles: Pick<MobileAttachmentFiles, "stageCandidates" | "removeOwnedBytes">;
  readonly validateAuthority: () => Promise<MobileAttachmentControls>;
  readonly acknowledge: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface MobileIncomingShareCommitResult {
  readonly draft: MobileNewTaskEditableDraft;
  readonly plan: MobileIncomingSharePlan;
  readonly replayed: boolean;
}

export async function commitMobileIncomingShare(
  request: MobileIncomingShareCommitRequest
): Promise<MobileIncomingShareCommitResult> {
  const { batch, profileId, targetId, controls, draftStore, attachmentFiles, signal } = request;
  assertProfileId(profileId);
  if (batch.boundProfileId !== profileId || controls.profileId !== profileId) {
    throw new Error("The incoming share is not bound to the active Joko connection profile.");
  }
  signal?.throwIfAborted();
  const identity = { profileId } satisfies MobileNewTaskDraftIdentity;
  const snapshot = await draftStore.readSnapshot(identity);
  signal?.throwIfAborted();
  const draft = requiredEditableDraft(snapshot, targetId);
  const plan = planMobileIncomingShare(batch, draft.input.attachments, controls.policy);
  if (!mobileIncomingShareClaimMatches(batch, targetId, controls, plan)) {
    throw new Error("The incoming share target, model, or attachment policy changed after it was claimed.");
  }
  const existing = expectedExistingAttachments(plan.accepted, draft.input.attachments);
  if (existing === "all") {
    await assertIncomingShareAuthority(request, controls);
    await draftStore.flush(identity);
    await assertIncomingShareAuthority(request, controls);
    await request.acknowledge();
    return { draft: requiredEditableDraft(await draftStore.readSnapshot(identity), targetId), plan, replayed: true };
  }
  if (existing === "partial-or-mismatch") {
    throw new Error("The retained new-task draft contains an inconsistent prior import of this share.");
  }
  if (plan.accepted.length === 0) {
    await assertIncomingShareAuthority(request, controls);
    await request.acknowledge();
    return { draft, plan, replayed: false };
  }

  for (const item of plan.accepted) await attachmentFiles.removeOwnedBytes(profileId, item.storageId);
  let staged: readonly MobileLocalComposerAttachment[] = [];
  let draftCommitted = false;
  try {
    let identityIndex = 0;
    staged = await attachmentFiles.stageCandidates(
      profileId,
      draft.input.attachments,
      controls.policy,
      plan.accepted,
      () => plan.accepted[identityIndex++]?.storageId ?? "invalid",
      signal
    );
    if (staged.length !== plan.accepted.length || staged.some((attachment, index) => {
      const expected = plan.accepted[index];
      return attachment.attachmentId !== expected?.storageId || attachment.fileName !== expected.fileName
        || attachment.mediaType !== expected.mediaType || attachment.byteSize !== expected.byteSize
        || attachment.sha256Hex !== expected.sha256Hex;
    })) {
      throw new Error("A shared file changed while it was copied into Joko.");
    }
    const latest = await assertIncomingShareAuthority(request, controls);
    const latestPlan = planMobileIncomingShare(batch, draft.input.attachments, latest.policy);
    if (!incomingSharePlansEqual(plan, latestPlan)) {
      throw new Error("The project attachment policy changed while the shared files were being copied.");
    }
    const next: MobileNewTaskEditableDraft = {
      ...draft,
      input: {
        ...draft.input,
        attachments: appendMobileComposerAttachments(draft.input.attachments, staged, latest.policy)
      }
    };
    if (!draftStore.saveIfRevision(identity, next, snapshot.revision)) {
      throw new Error("The new-task draft changed while the shared files were being added.");
    }
    draftCommitted = true;
    await draftStore.flush(identity);
    const durable = draftStore.readSync(identity);
    if (!durable || expectedExistingAttachments(plan.accepted, durable.input.attachments) !== "all") {
      throw new Error("The imported shared files could not be confirmed in the retained new-task draft.");
    }
    await assertIncomingShareAuthority(request, controls);
    await request.acknowledge();
    return { draft: editableDraft(durable), plan, replayed: false };
  } catch (failure) {
    if (!draftCommitted) {
      const cleanupFailures = await cleanupStagedAttachments(attachmentFiles, profileId, staged);
      if (cleanupFailures > 0) {
        throw new Error(`${errorText(failure)} ${cleanupFailures} app-owned shared-file ${cleanupFailures === 1 ? "copy could" : "copies could"} not be removed.`);
      }
    }
    throw failure;
  }
}

function requiredEditableDraft(snapshot: MobileNewTaskDraftSnapshot, targetId: string): MobileNewTaskEditableDraft {
  const draft = snapshot.draft;
  if (!draft || draft.submission !== undefined || draft.targetId !== targetId || !targetId) {
    throw new Error("The retained new-task project changed before the shared files could be added.");
  }
  return editableDraft(draft);
}

function editableDraft(draft: MobileNewTaskDraft): MobileNewTaskEditableDraft {
  return { targetId: draft.targetId, name: draft.name, input: draft.input };
}

async function assertIncomingShareAuthority(
  request: MobileIncomingShareCommitRequest,
  frozen: MobileAttachmentControls
): Promise<MobileAttachmentControls> {
  request.signal?.throwIfAborted();
  const latest = await request.validateAuthority();
  request.signal?.throwIfAborted();
  if (latest.profileId !== request.profileId || latest.surfaceOwnerKey !== frozen.surfaceOwnerKey
    || !mobileIncomingSharePoliciesEqual(latest.policy, frozen.policy)) {
    throw new Error("Attachment authority changed while the shared files were being added.");
  }
  return latest;
}

function expectedExistingAttachments(
  expected: readonly MobileIncomingShareAcceptedItem[],
  current: readonly MobileComposerAttachment[]
): "none" | "all" | "partial-or-mismatch" {
  let matches = 0;
  for (const item of expected) {
    const attachment = current.find((candidate) => candidate.attachmentId === item.storageId);
    if (!attachment) continue;
    if (attachment.state !== "local" || attachment.fileName !== item.fileName
      || attachment.mediaType !== item.mediaType || attachment.byteSize !== item.byteSize
      || attachment.sha256Hex !== item.sha256Hex) return "partial-or-mismatch";
    matches += 1;
  }
  if (matches === 0) return "none";
  return matches === expected.length ? "all" : "partial-or-mismatch";
}

async function cleanupStagedAttachments(
  files: Pick<MobileAttachmentFiles, "removeOwnedBytes">,
  profileId: string,
  staged: readonly MobileLocalComposerAttachment[]
): Promise<number> {
  const results = await Promise.allSettled(staged.map((attachment) =>
    files.removeOwnedBytes(profileId, attachment.attachmentId)));
  return results.filter((result) => result.status === "rejected").length;
}

export function mobileIncomingSharePoliciesEqual(
  left: MobileAttachmentPolicy,
  right: MobileAttachmentPolicy
): boolean {
  return left.images === right.images && left.files === right.files
    && left.maximumItems === right.maximumItems && left.maximumBytes === right.maximumBytes
    && equalStrings(left.imageMediaTypes, right.imageMediaTypes)
    && equalStrings(left.fileMediaTypes, right.fileMediaTypes);
}

function incomingSharePlansEqual(left: MobileIncomingSharePlan, right: MobileIncomingSharePlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeBatch(raw: unknown): MobileIncomingShareBatch {
  const value = record(raw, "native incoming share");
  const batchId = textField(value, "batchId", 36);
  assertUuid(batchId, "incoming share");
  const orderKey = textField(value, "orderKey", 80);
  if (!/^batch-[0-9]{20}-[0-9a-f-]{36}$/u.test(orderKey) || !orderKey.endsWith(batchId)) {
    throw new Error("The native incoming-share order identity is invalid.");
  }
  const createdAtUnixMs = integerField(value, "createdAtUnixMs", 0, Number.MAX_SAFE_INTEGER);
  const boundProfileId = optionalTextField(value, "boundProfileId", 128);
  if (boundProfileId !== undefined) assertProfileId(boundProfileId);
  if (value.status === "invalid") {
    return {
      status: "invalid",
      batchId,
      orderKey,
      createdAtUnixMs,
      ...(boundProfileId === undefined ? {} : { boundProfileId }),
      invalidReason: textField(value, "invalidReason", 512)
    };
  }
  if (value.status !== "ready" || createdAtUnixMs <= 0 || !Array.isArray(value.items)
    || value.items.length > 20) {
    throw new Error("The native incoming-share batch is invalid.");
  }
  const itemIds = new Set<string>();
  const ordinals = new Set<number>();
  const items = value.items.map((rawItem) => {
    const item = record(rawItem, "native incoming-share item");
    const itemId = textField(item, "itemId", 36);
    assertUuid(itemId, "incoming-share item");
    const ordinal = integerField(item, "ordinal", 0, 19);
    if (itemIds.has(itemId) || ordinals.has(ordinal)) {
      throw new Error("The native incoming-share item identity or order is duplicated.");
    }
    itemIds.add(itemId);
    ordinals.add(ordinal);
    if (item.state === "rejected") {
      const fileName = optionalTextField(item, "fileName", 512);
      return {
        state: "rejected" as const,
        itemId,
        ordinal,
        ...(fileName === undefined ? {} : { fileName: normalizeMobileAttachmentFileName(fileName) }),
        reason: textField(item, "reason", 512)
      };
    }
    if (item.state !== "ready") throw new Error("The native incoming-share item state is invalid.");
    const uri = textField(item, "uri", 4_096);
    if (!/^file:\/\/\//u.test(uri) || /[\u0000-\u001f\u007f]/u.test(uri)) {
      throw new Error("The native incoming-share file URI is invalid.");
    }
    const fileName = normalizeMobileAttachmentFileName(textField(item, "fileName", 512));
    const mediaType = textField(item, "mediaType", 255);
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)) {
      throw new Error("The native incoming-share MIME type is invalid.");
    }
    const sha256Hex = textField(item, "sha256Hex", 64);
    if (!/^[0-9a-f]{64}$/u.test(sha256Hex)) throw new Error("The native incoming-share SHA-256 is invalid.");
    return {
      state: "ready" as const,
      itemId,
      ordinal,
      uri,
      fileName,
      mediaType,
      byteSize: integerField(item, "byteSize", 1, 30 * 1024 * 1024),
      sha256Hex
    };
  }).sort((left, right) => left.ordinal - right.ordinal);
  const claim = value.claim === undefined ? undefined : normalizeClaim(value.claim, items);
  return {
    status: "ready",
    batchId,
    orderKey,
    createdAtUnixMs,
    ...(boundProfileId === undefined ? {} : { boundProfileId }),
    overflowCount: integerField(value, "overflowCount", 0, 1_000_000),
    items,
    ...(claim === undefined ? {} : { claim })
  };
}

function normalizeClaim(raw: unknown, items: readonly MobileIncomingShareItem[]): MobileIncomingShareClaim {
  const value = record(raw, "native incoming-share claim");
  const claimId = textField(value, "claimId", 36);
  assertUuid(claimId, "incoming-share claim");
  const targetId = textField(value, "targetId", 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(targetId)) {
    throw new Error("The native incoming-share target identity is invalid.");
  }
  const surfaceOwnerKey = opaqueTextField(value, "surfaceOwnerKey", 16_384, true);
  const policyKey = opaqueTextField(value, "policyKey", 16_384, false);
  if (!Array.isArray(value.acceptedItemIds) || value.acceptedItemIds.length > 20) {
    throw new Error("The native incoming-share accepted item identities are invalid.");
  }
  const readyIds = items.filter((item): item is MobileIncomingShareReadyItem => item.state === "ready")
    .map((item) => item.itemId);
  const acceptedItemIds = value.acceptedItemIds.map((itemId) => {
    if (typeof itemId !== "string") throw new Error("The native incoming-share accepted item identity is invalid.");
    assertUuid(itemId, "incoming-share accepted item");
    return itemId;
  });
  if (new Set(acceptedItemIds).size !== acceptedItemIds.length
    || acceptedItemIds.some((itemId) => !readyIds.includes(itemId))
    || !equalStrings(acceptedItemIds, readyIds.filter((itemId) => acceptedItemIds.includes(itemId)))) {
    throw new Error("The native incoming-share accepted item order is invalid.");
  }
  return { claimId, targetId, surfaceOwnerKey, policyKey, acceptedItemIds };
}

function incomingShareStorageId(batchId: string, itemId: string): string {
  assertUuid(batchId, "incoming share");
  assertUuid(itemId, "incoming-share item");
  return `share_${batchId.replaceAll("-", "")}_${itemId.replaceAll("-", "")}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The ${name} is invalid.`);
  return value as Record<string, unknown>;
}

function textField(value: Record<string, unknown>, field: string, maximum: number): string {
  const result = value[field];
  if (typeof result !== "string" || result.length < 1 || result.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`The native incoming-share ${field} is invalid.`);
  return result;
}

function optionalTextField(value: Record<string, unknown>, field: string, maximum: number): string | undefined {
  return value[field] === undefined ? undefined : textField(value, field, maximum);
}

function opaqueTextField(
  value: Record<string, unknown>,
  field: string,
  maximum: number,
  allowUnitSeparator: boolean
): string {
  const result = value[field];
  const invalid = allowUnitSeparator ? /[\u0000-\u001e\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (typeof result !== "string" || result.length < 1 || result.length > maximum
    || invalid.test(result)) {
    throw new Error(`The native incoming-share ${field} is invalid.`);
  }
  return result;
}

function integerField(
  value: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number
): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) {
    throw new Error(`The native incoming-share ${field} is invalid.`);
  }
  return result as number;
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`The ${name} identity is invalid.`);
  }
}

function assertProfileId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("The Joko connection profile identity is invalid.");
}

function errorText(value: unknown): string {
  return value instanceof Error && value.message ? value.message : String(value);
}

interface NativeIncomingShareModule {
  getNextBatch(): Promise<unknown | null>;
  bindBatch(batchId: string, profileId: string): Promise<unknown>;
  claimBatch(
    batchId: string,
    profileId: string,
    targetId: string,
    surfaceOwnerKey: string,
    policyKey: string,
    acceptedItemIds: readonly string[]
  ): Promise<unknown>;
  acknowledgeBatch(batchId: string, profileId: string, claimId: string): Promise<void>;
  discardBatch(batchId: string): Promise<void>;
}

function appleNativeModule(): NativeIncomingShareModule {
  const native = requireOptionalNativeModule<NativeIncomingShareModule>("JokoIncomingShare");
  if (native === null) throw new Error("Incoming sharing requires an installed Joko iOS build.");
  return native;
}

const nativeIncomingShareDriver: MobileIncomingShareNativeDriver = {
  supported: Platform.OS === "ios" || Platform.OS === "android",
  getNextBatch: () => appleNativeModule().getNextBatch(),
  bindBatch: (batchId, profileId) => appleNativeModule().bindBatch(batchId, profileId),
  claimBatch: (batchId, profileId, targetId, surfaceOwnerKey, policyKey, acceptedItemIds) =>
    appleNativeModule().claimBatch(batchId, profileId, targetId, surfaceOwnerKey, policyKey, acceptedItemIds),
  acknowledgeBatch: (batchId, profileId, claimId) =>
    appleNativeModule().acknowledgeBatch(batchId, profileId, claimId),
  discardBatch: (batchId) => appleNativeModule().discardBatch(batchId)
};

export const mobileIncomingShare = new MobileIncomingShareInbox();

export const mobileIncomingShareTesting = {
  incomingShareStorageId,
  normalizeBatch
};
