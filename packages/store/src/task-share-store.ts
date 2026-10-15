import { operationBodyHash } from "./serialization.js";
import { StoreError } from "./errors.js";
import type { OperationalStore } from "./operational-store.js";

const SCOPE = "task-sharing.host.v1";
export function taskShareQueueLockOwner(proof: TaskShareGuestProof): string {
  return JSON.stringify([proof.shareId, proof.shareGeneration, proof.memberId, proof.memberGeneration]);
}
export interface TaskShareMemberRecord {
  readonly memberId: string; readonly memberGeneration: number; readonly displayName: string;
  readonly status: "active" | "removed" | "left"; readonly joinedAt: number;
  readonly homeServerId: string; readonly homeDeviceId: string; readonly joinIntentId: string;
  readonly credentialSha256Hex: string;
}
export interface TaskShareRecord {
  readonly format: 1; readonly shareId: string; readonly sessionId: string;
  readonly sessionCreatedAt: number; readonly shareGeneration: number; readonly revision: number;
  readonly status: "active" | "ended"; readonly invitationSha256Hex: string;
  readonly createdAt: number; readonly updatedAt: number; readonly members: readonly TaskShareMemberRecord[];
}
export interface TaskShareGuestProof {
  readonly shareId: string; readonly shareGeneration: number;
  readonly memberId: string; readonly memberGeneration: number; readonly credentialSha256Hex: string;
}
export interface SharedTaskAuthor {
  readonly shareId: string; readonly sessionId: string; readonly shareGeneration: number;
  readonly memberId: string; readonly memberGeneration: number; readonly displayName: string;
}
export interface TaskShareActionReceipt {
  readonly format: 1; readonly operationId: string; readonly author: SharedTaskAuthor;
  readonly requestHash: string; readonly status: "admitted" | "completed" | "failed" | "unknown";
  readonly responseHex?: string; readonly errorCode?: string;
}

/** Current-v1 sharing authority. Every mutation composes with the owning
 * OperationalStore transaction; no second database or credential registry. */
export class TaskShareStore {
  constructor(readonly store: OperationalStore, readonly now: () => number = Date.now) {}
  list(): readonly TaskShareRecord[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, "share:").map(row => parseShare(row.value));
  }
  get(shareId: string): TaskShareRecord {
    return parseShare(this.store.getSetting("service", SCOPE, `share:${id(shareId)}`).value);
  }
  active(shareId: string): TaskShareRecord {
    const share = this.get(shareId), session = this.store.getSession(share.sessionId).descriptor;
    if (share.status !== "active" || session.deletedAt !== undefined || session.archived
      || session.createdAt !== share.sessionCreatedAt) throw new StoreError("Task sharing is unavailable.");
    return share;
  }
  create(input: { readonly shareId: string; readonly sessionId: string; readonly invitationSha256Hex: string }): TaskShareRecord {
    return this.store.transaction(() => {
      id(input.shareId); digest(input.invitationSha256Hex);
      const session = this.store.getSession(input.sessionId).descriptor;
      if (session.deletedAt !== undefined || session.archived) throw new StoreError("Only an available task can be shared.");
      const existing = this.list().find(row => row.sessionId === input.sessionId && row.status === "active");
      if (existing !== undefined) return this.active(existing.shareId);
      if (this.store.findSetting("service", SCOPE, `share:${input.shareId}`)) throw new StoreError("The sharing identity is already used.");
      const at = this.now();
      return this.save({ format: 1, ...input, sessionCreatedAt: session.createdAt, shareGeneration: 1,
        revision: 1, status: "active", createdAt: at, updatedAt: at, members: [] });
    });
  }
  setInvitation(shareId: string, invitationSha256Hex: string): TaskShareRecord {
    return this.store.transaction(() => this.save({ ...this.active(shareId), invitationSha256Hex: digest(invitationSha256Hex) }));
  }
  join(input: { readonly shareId: string; readonly shareGeneration: number; readonly invitationSha256Hex: string;
    readonly memberId: string; readonly intentId: string; readonly credentialSha256Hex: string;
    readonly displayName: string; readonly homeServerId: string; readonly homeDeviceId: string }): { share: TaskShareRecord; member: TaskShareMemberRecord } {
    return this.store.transaction(() => {
      const share = this.active(input.shareId);
      if (share.shareGeneration !== input.shareGeneration || share.invitationSha256Hex !== digest(input.invitationSha256Hex)) throw new StoreError("The task invitation is no longer available.");
      const credential = digest(input.credentialSha256Hex);
      const previous = share.members.find(member => member.joinIntentId === input.intentId && member.homeServerId === input.homeServerId);
      if (previous !== undefined) {
        if (previous.credentialSha256Hex !== credential || previous.homeDeviceId !== input.homeDeviceId || previous.status !== "active") throw new StoreError("The original join is no longer authorized.");
        return { share, member: previous };
      }
      if (this.store.findSetting("service", SCOPE, `credential.${credential}.digest`)) throw new StoreError("The guest credential is already bound.");
      const member: TaskShareMemberRecord = { memberId: id(input.memberId), memberGeneration: 1,
        displayName: name(input.displayName), status: "active", joinedAt: this.now(),
        homeServerId: id(input.homeServerId), homeDeviceId: id(input.homeDeviceId), joinIntentId: id(input.intentId), credentialSha256Hex: credential };
      const next = this.save({ ...share, members: [...share.members, member] });
      this.store.setSetting("service", SCOPE, `credential.${credential}.digest`, { format: 1, shareId: share.shareId, memberId: member.memberId });
      return { share: next, member };
    });
  }
  byCredential(credentialSha256Hex: string): { share: TaskShareRecord; member: TaskShareMemberRecord } {
    const ref = this.store.getSetting<{ format: 1; shareId: string; memberId: string }>("service", SCOPE, `credential.${digest(credentialSha256Hex)}.digest`).value;
    if (ref.format !== 1) throw new StoreError("The guest credential record is invalid.");
    const share = this.active(ref.shareId), member = share.members.find(row => row.memberId === ref.memberId);
    if (!member || member.status !== "active" || member.credentialSha256Hex !== credentialSha256Hex) throw new StoreError("Task membership was revoked.");
    return { share, member };
  }
  authorize(proof: TaskShareGuestProof): { share: TaskShareRecord; member: TaskShareMemberRecord } {
    const current = this.byCredential(proof.credentialSha256Hex);
    if (current.share.shareId !== proof.shareId || current.share.shareGeneration !== proof.shareGeneration
      || current.member.memberId !== proof.memberId || current.member.memberGeneration !== proof.memberGeneration) throw new StoreError("Task membership changed.");
    return current;
  }
  remove(shareId: string, memberId: string, status: "removed" | "left" = "removed"): TaskShareRecord {
    return this.store.transaction(() => {
      const share = this.active(shareId), member = share.members.find(row => row.memberId === memberId);
      if (!member) throw new StoreError("The task participant does not exist.");
      if (member.status !== "active") return share;
      return this.save({ ...share, members: share.members.map(row => row === member ? { ...row, memberGeneration: row.memberGeneration + 1, status } : row) });
    });
  }
  end(shareId: string): TaskShareRecord {
    return this.store.transaction(() => {
      const share = this.get(shareId);
      return share.status === "ended" ? share : this.save({ ...share, status: "ended", shareGeneration: share.shareGeneration + 1 });
    });
  }
  author(proof: TaskShareGuestProof): SharedTaskAuthor {
    const { share, member } = this.authorize(proof);
    return { shareId: share.shareId, sessionId: share.sessionId, shareGeneration: share.shareGeneration,
      memberId: member.memberId, memberGeneration: member.memberGeneration, displayName: member.displayName };
  }
  recordAuthor(operationId: string, author: SharedTaskAuthor): void {
    const previous = this.getAuthorForOperation(operationId);
    if (previous && operationBodyHash(previous) !== operationBodyHash(author)) throw new StoreError("The input author is immutable.");
    if (!previous) this.store.setSetting("service", SCOPE, `author:${id(operationId)}`, { format: 1, ...author });
  }
  getAuthorForOperation(operationId: string): SharedTaskAuthor | undefined {
    const value = this.store.findSetting<{ format: 1 } & SharedTaskAuthor>("service", SCOPE, `author:${id(operationId)}`)?.value;
    if (value === undefined) return undefined;
    if (value.format !== 1) throw new StoreError("The shared input author record is invalid.");
    const { format: _format, ...author } = value;
    return author;
  }
  assertOwnPending(proof: TaskShareGuestProof, queueItemId: string): void {
    const author = this.author(proof), item = this.store.getQueueItem(queueItemId), original = this.getAuthorForOperation(item.operationId);
    if (item.sessionId !== author.sessionId || item.state !== "accepted" || original?.shareId !== author.shareId
      || original.memberId !== author.memberId || original.memberGeneration !== author.memberGeneration) throw new StoreError("Only your own pending input may be changed.");
  }
  receipt(proof: TaskShareGuestProof, operationId: string, request: unknown): TaskShareActionReceipt | undefined {
    const author = this.author(proof);
    const receipt = this.store.findSetting<TaskShareActionReceipt>("service", SCOPE, `operation:${id(operationId)}`)?.value;
    if (receipt && (receipt.format !== 1 || operationBodyHash(receipt.author) !== operationBodyHash(author)
      || receipt.requestHash !== operationBodyHash(request))) throw new StoreError("The shared operation identity does not match its original request.");
    return receipt;
  }
  admit(proof: TaskShareGuestProof, operationId: string, request: unknown): TaskShareActionReceipt {
    const previous = this.receipt(proof, operationId, request);
    if (previous) return previous;
    const receipt: TaskShareActionReceipt = { format: 1, operationId: id(operationId), author: this.author(proof), requestHash: operationBodyHash(request), status: "admitted" };
    this.store.setSetting("service", SCOPE, `operation:${operationId}`, receipt);
    return receipt;
  }
  settle(proof: TaskShareGuestProof, operationId: string, request: unknown, outcome: {
    readonly status: "completed" | "failed" | "unknown"; readonly responseHex?: string; readonly errorCode?: string;
  }): TaskShareActionReceipt {
    const receipt = this.receipt(proof, operationId, request);
    if (!receipt) throw new StoreError("The shared operation was not admitted.");
    const next = { ...receipt, ...outcome };
    this.store.setSetting("service", SCOPE, `operation:${operationId}`, next);
    return next;
  }
  private save(share: TaskShareRecord): TaskShareRecord {
    const previous = this.store.findSetting<TaskShareRecord>("service", SCOPE, `share:${share.shareId}`)?.value;
    const next = { ...share, revision: previous ? previous.revision + 1 : 1, updatedAt: this.now() };
    this.store.setSetting("service", SCOPE, `share:${share.shareId}`, next);
    return this.get(share.shareId);
  }
}
function id(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) throw new StoreError("A valid task sharing identity is required.");
  return value;
}
function digest(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new StoreError("A valid task sharing credential digest is required.");
  return value;
}
function name(value: string): string {
  if (value.trim() !== value || !value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new StoreError("A participant display name is required.");
  return value;
}
function parseShare(value: unknown): TaskShareRecord {
  const row = value as TaskShareRecord | undefined;
  if (!row || row.format !== 1 || !["active", "ended"].includes(row.status) || !Array.isArray(row.members)
    || !Number.isSafeInteger(row.shareGeneration) || row.shareGeneration < 1 || !Number.isSafeInteger(row.revision)
    || !Number.isSafeInteger(row.sessionCreatedAt)) throw new StoreError("The task sharing record is invalid; rebuild incompatible development data.");
  id(row.shareId); id(row.sessionId); digest(row.invitationSha256Hex);
  for (const member of row.members) {
    id(member.memberId); id(member.joinIntentId); id(member.homeServerId); id(member.homeDeviceId); digest(member.credentialSha256Hex); name(member.displayName);
    if (!["active", "removed", "left"].includes(member.status) || !Number.isSafeInteger(member.memberGeneration) || member.memberGeneration < 1) throw new StoreError("The task participant record is invalid.");
  }
  return row;
}
