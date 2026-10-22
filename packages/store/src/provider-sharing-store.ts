import { operationBodyHash } from "./serialization.js";
import { StoreError } from "./errors.js";
import type { OperationalStore } from "./operational-store.js";

const SCOPE = "provider-sharing.host.v1";
export const PROVIDER_SHARING_LINK_TTL = 5 * 60_000;
export const PROVIDER_SHARING_REQUEST_TTL = 24 * 60 * 60_000;
export interface ProviderSharingPerson { readonly name: string; readonly avatarUrl: string | null; }
export interface ProviderSharingMemberRecord {
  readonly id: string; readonly generation: number; readonly incarnation: number; readonly homeServerId: string;
  readonly person: ProviderSharingPerson; readonly status: "active" | "paused" | "removed" | "left";
  readonly credentialDigest: string; readonly devices: readonly string[]; readonly joinedAt: number;
}
export interface ProviderSharingShareRecord {
  readonly format: 1; readonly id: string; readonly generation: number; readonly backendId: string; readonly providerId: string;
  readonly providerName: string; readonly owner: ProviderSharingPerson; readonly createdAt: number; readonly revision: number;
  readonly members: readonly ProviderSharingMemberRecord[];
}
export interface ProviderSharingLinkRecord {
  readonly format: 1; readonly digest: string; readonly shareId: string; readonly createdAt: number; readonly expiresAt: number;
  readonly state: "unused" | "pending" | "consumed" | "rejected" | "withdrawn" | "expired"; readonly requestId?: string;
}
export interface ProviderSharingRequestRecord {
  readonly format: 1; readonly id: string; readonly shareId: string; readonly linkDigest: string; readonly homeServerId: string;
  readonly deviceId: string; readonly person: ProviderSharingPerson; readonly requestDigest: string; readonly credentialDigest: string;
  readonly pairingCode: string; readonly createdAt: number; readonly expiresAt: number;
  readonly status: "pending" | "approved" | "rejected" | "withdrawn" | "expired"; readonly memberId?: string;
}
export interface ProviderSharingProof {
  readonly shareId: string; readonly memberId: string; readonly generation: number; readonly credentialDigest: string;
}
export interface ProviderSharingReshareRecord {
  readonly format: 1;
  readonly id: string; readonly shareId: string; readonly memberId: string; readonly incarnation: number; readonly deviceId: string;
  readonly key: string; readonly person: ProviderSharingPerson; readonly state: "pending" | "approved" | "rejected";
  readonly requestedAt: number; readonly decidedAt?: number;
}
export class ProviderSharingStoreError extends StoreError {
  constructor(readonly code: "NOT_FOUND" | "LINK_USED" | "EXPIRED" | "SELF" | "ALREADY_MEMBER" | "STALE" | "DENIED" | "INVALID", message = "The Provider sharing request is unavailable.") { super(message); }
}

/** Independent current-v1 Provider grants. No record here is a Connection or a task guest. */
export class ProviderSharingStore {
  constructor(readonly store: OperationalStore, readonly now: () => number = Date.now) {}
  list(): readonly ProviderSharingShareRecord[] { return this.store.listSettingsByKeyPrefix("service", SCOPE, "share:").map(row => parseShare(row.value)); }
  get(shareId: string): ProviderSharingShareRecord {
    const found = this.store.findSetting("service", SCOPE, `share:${identity(shareId)}`); if (!found) throw new ProviderSharingStoreError("NOT_FOUND"); return parseShare(found.value);
  }
  requests(shareId?: string): readonly ProviderSharingRequestRecord[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, "request:").map(row => parseRequest(row.value)).filter(row => shareId === undefined || row.shareId === shareId);
  }
  request(id: string): ProviderSharingRequestRecord {
    const found = this.store.findSetting("service", SCOPE, `request:${identity(id)}`); if (!found) throw new ProviderSharingStoreError("NOT_FOUND"); return parseRequest(found.value);
  }
  link(digest: string): ProviderSharingLinkRecord {
    const found = this.store.findSetting<ProviderSharingLinkRecord>("service", SCOPE, `link:${hash(digest)}`);
    if (!found || found.value.format !== 1 || found.value.digest !== digest || !["unused", "pending", "consumed", "rejected", "withdrawn", "expired"].includes(found.value.state)) throw new ProviderSharingStoreError("NOT_FOUND");
    return found.value;
  }
  issue(input: { readonly shareId: string; readonly backendId: string; readonly providerId: string; readonly providerName: string;
    readonly owner: ProviderSharingPerson; readonly linkDigest: string }): { share: ProviderSharingShareRecord; link: ProviderSharingLinkRecord } {
    return this.store.transaction(() => {
      let share = this.list().find(row => row.backendId === input.backendId && row.providerId === input.providerId);
      if (!share) share = { format: 1, id: identity(input.shareId), generation: 1, backendId: identity(input.backendId), providerId: identity(input.providerId),
        providerName: text(input.providerName), owner: person(input.owner), createdAt: this.now(), revision: 0, members: [] };
      share = this.save({ ...share, providerName: text(input.providerName), owner: person(input.owner) });
      const link: ProviderSharingLinkRecord = { format: 1, digest: hash(input.linkDigest), shareId: share.id,
        createdAt: this.now(), expiresAt: this.now() + PROVIDER_SHARING_LINK_TTL, state: "unused" };
      if (this.store.findSetting("service", SCOPE, `link:${link.digest}`)) throw new ProviderSharingStoreError("INVALID");
      this.put(`link:${link.digest}`, link); return { share, link };
    });
  }
  apply(input: Omit<ProviderSharingRequestRecord, "format" | "shareId" | "createdAt" | "expiresAt" | "status">, hostServerId: string): ProviderSharingRequestRecord {
    return this.store.transaction(() => {
      this.expire(); const link = this.link(input.linkDigest), share = this.get(link.shareId);
      const previous = this.store.findSetting<ProviderSharingRequestRecord>("service", SCOPE, `request:${identity(input.id)}`)?.value;
      if (previous) {
        const { format: _format, shareId: _share, createdAt: _created, expiresAt: _expires, status: _status, memberId: _member, pairingCode: _code, ...original } = parseRequest(previous);
        const { pairingCode: _newCode, ...retry } = input;
        if (operationBodyHash(original) !== operationBodyHash(retry)) throw new ProviderSharingStoreError("DENIED"); return previous;
      }
      if (link.state === "expired") throw new ProviderSharingStoreError("EXPIRED");
      if (link.state !== "unused") throw new ProviderSharingStoreError("LINK_USED");
      if (input.homeServerId === hostServerId) throw new ProviderSharingStoreError("SELF");
      if (share.members.some(row => row.homeServerId === input.homeServerId && ["active", "paused"].includes(row.status))) throw new ProviderSharingStoreError("ALREADY_MEMBER");
      if (!/^\d{4}$/u.test(input.pairingCode)) throw new ProviderSharingStoreError("INVALID");
      const request: ProviderSharingRequestRecord = { ...input, id: identity(input.id), homeServerId: identity(input.homeServerId), deviceId: identity(input.deviceId),
        person: person(input.person), requestDigest: hash(input.requestDigest), credentialDigest: hash(input.credentialDigest), format: 1,
        shareId: share.id, createdAt: this.now(), expiresAt: this.now() + PROVIDER_SHARING_REQUEST_TTL, status: "pending" };
      this.put(`request:${request.id}`, request); this.put(`link:${link.digest}`, { ...link, state: "pending", requestId: request.id }); return request;
    });
  }
  decide(requestId: string, action: "approve" | "reject", memberId: string): ProviderSharingRequestRecord {
    return this.store.transaction(() => {
      this.expire(); const request = this.request(requestId), share = this.get(request.shareId);
      if (request.status !== "pending") throw new ProviderSharingStoreError(request.status === "expired" ? "EXPIRED" : "STALE");
      if (action === "reject") return this.setRequest(request, "rejected");
      const previous = share.members.findLast(row => row.homeServerId === request.homeServerId);
      if (share.members.some(row => row.homeServerId === request.homeServerId && ["active", "paused"].includes(row.status))) throw new ProviderSharingStoreError("ALREADY_MEMBER");
      // A new approval is a new membership. Its onward person key must never
      // adopt an original issuer's decision for a removed membership.
      const member: ProviderSharingMemberRecord = { id: identity(memberId), generation: 1,
        incarnation: (previous?.incarnation ?? 0) + 1, homeServerId: request.homeServerId, person: request.person, status: "active",
        credentialDigest: request.credentialDigest, devices: [request.deviceId], joinedAt: this.now() };
      this.pruneReshares(share.id, member.id);
      this.save({ ...share, members: [...share.members.filter(row => row.id !== member.id), member] });
      this.put(`member-index:${member.credentialDigest}`, { format: 1, shareId: share.id, memberId: member.id });
      return this.setRequest({ ...request, memberId: member.id }, "approved");
    });
  }
  withdraw(requestId: string, requestDigest: string): ProviderSharingRequestRecord {
    return this.store.transaction(() => { this.expire(); const request = this.request(requestId);
      if (request.requestDigest !== hash(requestDigest)) throw new ProviderSharingStoreError("DENIED");
      if (request.status === "withdrawn") return request;
      if (request.status !== "pending") throw new ProviderSharingStoreError("STALE"); return this.setRequest(request, "withdrawn"); });
  }
  lookupCredential(digest: string, allowPaused = false): { share: ProviderSharingShareRecord; member: ProviderSharingMemberRecord } {
    const ref = this.store.findSetting<{ format: 1; shareId: string; memberId: string }>("service", SCOPE, `member-index:${hash(digest)}`)?.value;
    if (!ref || ref.format !== 1) throw new ProviderSharingStoreError("DENIED");
    const share = this.get(ref.shareId), member = share.members.find(row => row.id === ref.memberId);
    if (!member || member.credentialDigest !== digest || member.status !== "active" && !(allowPaused && member.status === "paused")) throw new ProviderSharingStoreError("DENIED");
    return { share, member };
  }
  authorize(proof: ProviderSharingProof, allowPaused = false) {
    const current = this.lookupCredential(proof.credentialDigest, allowPaused);
    if (current.share.id !== proof.shareId || current.member.id !== proof.memberId || current.member.generation !== proof.generation) throw new ProviderSharingStoreError("STALE"); return current;
  }
  registerDevice(proof: ProviderSharingProof, deviceId: string): ProviderSharingMemberRecord {
    return this.store.transaction(() => {
      const { share, member } = this.authorize(proof); identity(deviceId);
      if (member.devices.includes(deviceId)) return member;
      if (member.devices.length >= 64) throw new ProviderSharingStoreError("DENIED");
      const next = { ...member, devices: [...member.devices, deviceId] }; this.save({ ...share, members: share.members.map(row => row.id === member.id ? next : row) }); return next;
    });
  }
  setMember(shareId: string, memberId: string, generation: number, status: ProviderSharingMemberRecord["status"]): ProviderSharingShareRecord {
    return this.store.transaction(() => {
      const share = this.get(shareId), member = share.members.find(row => row.id === memberId);
      if (!member || member.generation !== generation) throw new ProviderSharingStoreError("STALE");
      if (member.status === status) return share;
      if (["removed", "left"].includes(member.status)) throw new ProviderSharingStoreError("DENIED");
      if (["removed", "left"].includes(status)) this.pruneReshares(share.id, member.id);
      return this.save({ ...share, members: share.members.map(row => row.id === member.id ? { ...row, generation: row.generation + 1, status } : row) });
    });
  }
  reshares(): readonly ProviderSharingReshareRecord[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, "reshare:").map(row => parseReshare(row.value));
  }
  syncReshares(proof: ProviderSharingProof, deviceId: string, entries: readonly { readonly key: string; readonly person: ProviderSharingPerson }[]): readonly ProviderSharingReshareRecord[] {
    return this.store.transaction(() => {
      const { member } = this.authorize(proof), wanted = new Map(entries.map(entry => [opaque(entry.key), person(entry.person)])); identity(deviceId);
      if (wanted.size !== entries.length) throw new ProviderSharingStoreError("INVALID");
      const all = this.reshares(), previous = all.filter(row => row.shareId === proof.shareId && row.memberId === proof.memberId && row.deviceId === deviceId);
      for (const row of previous) {
        const nextPerson = wanted.get(row.key); wanted.delete(row.key);
        if (!nextPerson || row.incarnation !== member.incarnation) this.store.deleteSetting("service", SCOPE, `reshare:${row.id}`);
        else this.put(`reshare:${row.id}`, { ...row, person: nextPerson });
      }
      for (const [key, nextPerson] of wanted) { const id = `consent-${operationBodyHash([proof.shareId, proof.memberId, member.incarnation, deviceId, key])}`;
        this.put(`reshare:${id}`, { format: 1, id, shareId: proof.shareId, memberId: proof.memberId, incarnation: member.incarnation, deviceId,
          key, person: nextPerson, state: "pending", requestedAt: this.now() } satisfies ProviderSharingReshareRecord); }
      const result = this.reshares(); if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new ProviderSharingStoreError("INVALID");
      return result.filter(row => row.shareId === proof.shareId && row.memberId === proof.memberId && row.deviceId === deviceId);
    });
  }
  decideReshare(id: string, state: "approved" | "rejected"): ProviderSharingReshareRecord {
    return this.store.transaction(() => { const existing = this.reshares().find(row => row.id === id); if (!existing) throw new ProviderSharingStoreError("NOT_FOUND");
      const share = this.get(existing.shareId), member = share.members.find(row => row.id === existing.memberId);
      if (!member || !["active", "paused"].includes(member.status) || member.incarnation !== existing.incarnation) throw new ProviderSharingStoreError("DENIED");
      const next = { ...existing, state, decidedAt: this.now() }; this.put(`reshare:${identity(id)}`, next); return next; });
  }
  assertReshare(proof: ProviderSharingProof, deviceId: string, key: string): void {
    const { member } = this.authorize(proof);
    if (!this.reshares().some(row => row.shareId === proof.shareId && row.memberId === proof.memberId && row.incarnation === member.incarnation
      && row.deviceId === deviceId && row.key === opaque(key) && row.state === "approved")) throw new ProviderSharingStoreError("DENIED");
  }
  expire(): void {
    this.store.transaction(() => {
      const now = this.now();
      for (const request of this.requests()) if (request.status === "pending" && request.expiresAt <= now) this.setRequest(request, "expired");
      for (const row of this.store.listSettingsByKeyPrefix("service", SCOPE, "link:")) {
        const link = row.value as ProviderSharingLinkRecord;
        if (link.state === "unused" && link.expiresAt <= now) this.put(`link:${link.digest}`, { ...link, state: "expired" });
        if (!["unused", "pending"].includes(link.state) && link.expiresAt < now - 7 * 24 * 60 * 60_000) this.store.deleteSetting("service", SCOPE, row.key);
      }
      for (const request of this.requests()) if (request.status !== "pending" && request.expiresAt < now - 7 * 24 * 60 * 60_000) this.store.deleteSetting("service", SCOPE, `request:${request.id}`);
    });
  }
  private pruneReshares(shareId: string, memberId: string): void { for (const row of this.reshares()) if (row.shareId === shareId && row.memberId === memberId) this.store.deleteSetting("service", SCOPE, `reshare:${row.id}`); }
  private save(share: ProviderSharingShareRecord): ProviderSharingShareRecord { const next = { ...share, revision: share.revision + 1 }; this.put(`share:${share.id}`, next); return this.get(share.id); }
  private put(key: string, value: unknown): void { this.store.setSetting("service", SCOPE, key, value); }
  private setRequest(request: ProviderSharingRequestRecord, status: ProviderSharingRequestRecord["status"]): ProviderSharingRequestRecord {
    const next = { ...request, status }; this.put(`request:${request.id}`, next);
    const link = this.link(request.linkDigest); this.put(`link:${link.digest}`, { ...link, state: status === "approved" ? "consumed" : status }); return next;
  }
}
function identity(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) throw new ProviderSharingStoreError("INVALID"); return value; }
function opaque(value: string): string { if (!/^[A-Za-z0-9_-]{16,64}$/u.test(value)) throw new ProviderSharingStoreError("INVALID"); return value; }
function hash(value: string): string { if (!/^[a-f0-9]{64}$/u.test(value)) throw new ProviderSharingStoreError("INVALID"); return value; }
function text(value: string): string { if (!value || value !== value.trim() || value.length > 200 || /[\0-\x1f\x7f]/u.test(value)) throw new ProviderSharingStoreError("INVALID"); return value; }
function person(value: ProviderSharingPerson): ProviderSharingPerson {
  let avatarUrl: string | null = null;
  if (value.avatarUrl) { try { const url = new URL(value.avatarUrl); if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048) avatarUrl = url.href; } catch {} }
  return { name: text(value.name), avatarUrl };
}
function parseShare(value: unknown): ProviderSharingShareRecord {
  const row = value as ProviderSharingShareRecord;
  if (!row || row.format !== 1 || !Array.isArray(row.members) || !Number.isSafeInteger(row.generation) || row.generation < 1 || !Number.isSafeInteger(row.revision)) throw new ProviderSharingStoreError("INVALID");
  identity(row.id); identity(row.backendId); identity(row.providerId); text(row.providerName); person(row.owner);
  for (const member of row.members) { identity(member.id); identity(member.homeServerId); hash(member.credentialDigest); person(member.person);
    if (!Number.isSafeInteger(member.generation) || member.generation < 1 || !Number.isSafeInteger(member.incarnation) || member.incarnation < 1
      || !["active", "paused", "removed", "left"].includes(member.status) || !Array.isArray(member.devices) || member.devices.length > 64) throw new ProviderSharingStoreError("INVALID"); }
  return row;
}
function parseRequest(value: unknown): ProviderSharingRequestRecord {
  const row = value as ProviderSharingRequestRecord;
  if (!row || row.format !== 1 || !["pending", "approved", "rejected", "withdrawn", "expired"].includes(row.status)
    || !Number.isSafeInteger(row.expiresAt) || !/^\d{4}$/u.test(row.pairingCode)) throw new ProviderSharingStoreError("INVALID");
  identity(row.id); identity(row.shareId); identity(row.homeServerId); identity(row.deviceId); hash(row.linkDigest); hash(row.requestDigest); hash(row.credentialDigest); person(row.person); return row;
}
function parseReshare(value: unknown): ProviderSharingReshareRecord {
  const row = value as ProviderSharingReshareRecord;
  if (!row || row.format !== 1 || !Number.isSafeInteger(row.incarnation) || row.incarnation < 1 || !Number.isSafeInteger(row.requestedAt)
    || row.requestedAt < 0 || row.decidedAt !== undefined && (!Number.isSafeInteger(row.decidedAt) || row.decidedAt < 0)
    || !["pending", "approved", "rejected"].includes(row.state)
    || Object.keys(row).some(key => !["format", "id", "shareId", "memberId", "incarnation", "deviceId", "key", "person", "state", "requestedAt", "decidedAt"].includes(key))) throw new ProviderSharingStoreError("INVALID");
  identity(row.id); identity(row.shareId); identity(row.memberId); identity(row.deviceId); opaque(row.key); person(row.person); return row;
}
