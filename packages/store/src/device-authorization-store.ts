import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthorizationError, StoreError } from './errors.js';
import type { OperationalStore } from './operational-store.js';
import type { ConnectionRecord, DeviceKind } from './types.js';

const scope = 'device-authorization.v1';
const ttl = 10 * 60_000;
const retention = 24 * 60 * 60_000;
const lookups = new WeakMap<OperationalStore, { at: number; count: number }>();
export class DeviceAuthorizationConflictError extends StoreError {}
export type AuthorizationState = 'invited' | 'pending' | 'approved' | 'claimed' | 'denied' | 'cancelled' | 'expired';
export interface DeviceAuthorizationRecord {
  readonly id: string;
  readonly invitationDigest: string;
  readonly issuerId: string;
  readonly issuerDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: AuthorizationState;
  readonly entryIds?: readonly string[];
  readonly invitationCodeDigest?: string;
  readonly allowKnock?: boolean;
  readonly request?: {
    readonly id: string; readonly digest: string; readonly authDigest: string;
    readonly name: string; readonly kind: DeviceKind; readonly platform: string; readonly code: string;
    readonly entryId?: string;
  };
  readonly approverId?: string;
  readonly approverDigest?: string;
  readonly connectionId?: string;
}
export interface DeviceAuthorizationProof {
  readonly invitationId: string; readonly requestId: string; readonly requesterSecret: string;
}

/** Short-lived authority and non-secret receipts in the original Operational Store. */
export class DeviceAuthorizationStore {
  constructor(readonly store: OperationalStore, readonly now: () => number = Date.now) {}

  create(id: string, invitationDigest: string, issuer: ConnectionRecord, entryIds?: readonly string[], admission?: { codeDigest?: string; allowKnock?: boolean }): DeviceAuthorizationRecord {
    requireId(id); requireDigest(invitationDigest);
    if (admission?.codeDigest) requireDigest(admission.codeDigest);
    return this.store.transaction(() => {
      this.store.authorizeConnection(issuer.id, issuer.authKeyDigest);
      const existing = this.find(id);
      if (existing) {
        if (existing.issuerId !== issuer.id || !equal(existing.issuerDigest, issuer.authKeyDigest)
          || !equal(existing.invitationDigest, invitationDigest) || JSON.stringify(existing.entryIds ?? []) !== JSON.stringify(entryIds ?? [])
          || (existing.invitationCodeDigest ?? '') !== (admission?.codeDigest ?? '') || !!existing.allowKnock !== !!admission?.allowKnock) throw conflict();
        return this.current(existing);
      }
      const now = this.now();
      for (const row of this.rows()) if (row.expiresAt < now - retention) this.store.deleteSetting('service', scope, row.id);
      const records = this.rows();
      if (records.some(row => row.expiresAt > now && ['invited', 'pending', 'approved'].includes(row.state)
        && (admission?.allowKnock && row.allowKnock || admission?.codeDigest && row.invitationCodeDigest === admission.codeDigest))) throw new DeviceAuthorizationConflictError('Close the existing short-lived invitation first.');
      if (records.filter(row => row.createdAt > now - 60_000).length >= 6
        || records.filter(row => row.expiresAt > now && ['invited', 'pending', 'approved'].includes(row.state)).length >= 16
        || records.length >= 512) throw new DeviceAuthorizationConflictError('Device invitations are temporarily limited. Try again later.');
      return this.save({ id, invitationDigest, issuerId: issuer.id, issuerDigest: issuer.authKeyDigest,
        createdAt: now, expiresAt: now + ttl, state: 'invited', ...(entryIds?.length ? { entryIds: [...entryIds] } : {}),
        ...(admission?.codeDigest ? { invitationCodeDigest: admission.codeDigest } : {}), ...(admission?.allowKnock ? { allowKnock: true } : {}) });
    });
  }

  request(input: DeviceAuthorizationProof & { readonly invitationSecret: string; readonly authKeyDigest: string;
    readonly name: string; readonly kind: DeviceKind; readonly platform: string; readonly entryId?: string; readonly invitationCode?: string; readonly knock?: boolean }): DeviceAuthorizationRecord {
    requireId(input.invitationId); requireId(input.requestId); requireSecret(input.requesterSecret);
    requireDigest(input.authKeyDigest);
    if (equal(digest(input.requesterSecret), input.authKeyDigest)) throw denied();
    if (!input.name.trim() || input.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.name)
      || input.platform.length > 64 || /[\u0000-\u001f\u007f]/u.test(input.platform)
      || !['web', 'desktop', 'mobile'].includes(input.kind)) throw new TypeError('Invalid device request.');
    return this.store.transaction(() => {
      const row = this.current(this.get(input.invitationId));
      this.admit(row, input, !row.request || row.request.id !== input.requestId || !equal(row.request.digest, digest(input.requesterSecret)));
      if (input.entryId && row.entryIds?.length && !row.entryIds.includes(input.entryId)) throw denied();
      if (row.request) {
        const request = row.request;
        if (request.id !== input.requestId || !equal(request.digest, digest(input.requesterSecret))
          || !equal(request.authDigest, input.authKeyDigest) || request.name !== input.name.trim()
          || request.kind !== input.kind || request.platform !== input.platform || (request.entryId ?? '') !== (input.entryId ?? '')) throw conflict();
        return row;
      }
      if (row.state !== 'invited') return row;
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code: string;
      do { code = [...randomBytes(8)].map(value => alphabet[value % 32]).join(''); }
      while (this.rows().some(value => value.request?.code === code));
      return this.save({ ...row, state: 'pending', request: { id: input.requestId, digest: digest(input.requesterSecret),
        authDigest: input.authKeyDigest, name: input.name.trim(), kind: input.kind, platform: input.platform, code, ...(input.entryId ? { entryId: input.entryId } : {}) } });
    });
  }

  read(proof: DeviceAuthorizationProof): DeviceAuthorizationRecord {
    requireId(proof.invitationId); requireId(proof.requestId); requireSecret(proof.requesterSecret);
    const row = this.get(proof.invitationId);
    if (row.request?.id !== proof.requestId || !equal(row.request.digest, digest(proof.requesterSecret))) throw denied();
    return this.current(row);
  }
  invitation(id: string, secret: string, admission?: { invitationCode?: string; knock?: boolean }): DeviceAuthorizationRecord {
    requireId(id);
    const row = this.current(this.get(id));
    this.admit(row, { invitationSecret: secret, ...admission });
    if (!['invited', 'pending', 'approved'].includes(row.state)) throw denied();
    return row;
  }
  findInvitation(code: string): DeviceAuthorizationRecord {
    this.limitLookup();
    if (code && !/^[A-HJ-NP-Z2-9]{8}$/u.test(code)) throw denied();
    const row = this.rows().map(row => this.current(row)).find(row => row.state === 'invited'
      && (code ? row.invitationCodeDigest && equal(row.invitationCodeDigest, digest(code)) : row.allowKnock));
    if (!row) throw denied(); return row;
  }
  private limitLookup(): void {
    const now = this.now(), previous = lookups.get(this.store);
    const window = previous && now - previous.at < 60_000 ? previous : { at: now, count: 0 };
    lookups.set(this.store, window);
    if (++window.count > 30) throw new DeviceAuthorizationConflictError('Too many invitation attempts. Wait a minute before trying again.');
  }
  private admit(row: DeviceAuthorizationRecord, input: { invitationSecret: string; invitationCode?: string; knock?: boolean }, charge = true): void {
    if (input.invitationSecret) { requireSecret(input.invitationSecret); if (equal(row.invitationDigest, digest(input.invitationSecret))) return; }
    else if (input.invitationCode) {
      if (charge) this.limitLookup();
      if (/^[A-HJ-NP-Z2-9]{8}$/u.test(input.invitationCode) && row.invitationCodeDigest && equal(row.invitationCodeDigest, digest(input.invitationCode))) return;
    } else if (input.knock) { if (charge) this.limitLookup(); if (row.allowKnock) return; }
    throw denied();
  }

  list(): readonly DeviceAuthorizationRecord[] {
    return this.rows().filter(row => row.expiresAt > this.now() - ttl).map(row => this.current(row));
  }

  resolve(id: string, requestId: string, decision: 'approved' | 'denied' | 'cancelled', approver: ConnectionRecord): DeviceAuthorizationRecord {
    requireId(id);
    return this.store.transaction(() => {
      this.store.authorizeConnection(approver.id, approver.authKeyDigest);
      const row = this.current(this.get(id));
      if (row.request ? row.request.id !== requestId : decision !== 'cancelled' || requestId !== '') throw conflict();
      if (row.state === decision || ['claimed', 'denied', 'cancelled', 'expired'].includes(row.state)) return row;
      if (decision !== 'cancelled' && row.state !== 'pending') throw conflict();
      return this.save({ ...row, state: decision, ...(decision === 'approved' ? { approverId: approver.id, approverDigest: approver.authKeyDigest } : {}) });
    });
  }

  cancel(proof: DeviceAuthorizationProof): DeviceAuthorizationRecord {
    return this.store.transaction(() => {
      const row = this.read(proof);
      if (!['pending', 'approved'].includes(row.state)) return row;
      return this.save({ ...row, state: 'cancelled' });
    });
  }

  claim(proof: DeviceAuthorizationProof): DeviceAuthorizationRecord {
    return this.store.transaction(() => {
      const row = this.read(proof);
      if (row.state === 'claimed') {
        this.store.authorizeConnection(row.connectionId!, row.request!.authDigest);
        return row;
      }
      if (row.state !== 'approved' || !row.request) return row;
      const request = row.request;
      const connection = this.store.createConnection({ id: randomUUID(), deviceId: randomUUID(), name: request.name,
        authKeyDigest: request.authDigest, pairedAt: this.now(),
        device: { defaultName: request.name, kind: request.kind, platform: request.platform, appVersion: '0.1.0' } });
      return this.save({ ...row, state: 'claimed', connectionId: connection.id });
    });
  }

  private current(row: DeviceAuthorizationRecord): DeviceAuthorizationRecord {
    if (['claimed', 'denied', 'cancelled', 'expired'].includes(row.state)) return row;
    if (row.expiresAt <= this.now()) return this.save({ ...row, state: 'expired' });
    try {
      this.store.authorizeConnection(row.issuerId, row.issuerDigest);
      if (row.state === 'approved') this.store.authorizeConnection(row.approverId!, row.approverDigest!);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      return this.save({ ...row, state: 'cancelled' });
    }
    return row;
  }
  private rows(): DeviceAuthorizationRecord[] {
    return this.store.listSettingsByKeyPrefix('service', scope, '').map(row => parse(row.value));
  }
  private find(id: string): DeviceAuthorizationRecord | undefined {
    const row = this.store.findSetting('service', scope, id);
    return row === undefined ? undefined : parse(row.value);
  }
  private get(id: string): DeviceAuthorizationRecord { const row = this.find(id); if (!row) throw denied(); return row; }
  private save(row: DeviceAuthorizationRecord): DeviceAuthorizationRecord {
    parse(row); this.store.setSetting('service', scope, row.id, row); return row;
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function equal(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function requireId(value: string): void { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) throw denied(); }
function requireDigest(value: string): void { if (!/^[a-f0-9]{64}$/u.test(value)) throw denied(); }
function requireSecret(value: string): void { if (!/^[a-f0-9]{64}$/u.test(value)) throw denied(); }
function denied(): AuthorizationError { return new AuthorizationError('Device authorization is unavailable.'); }
function conflict(): DeviceAuthorizationConflictError { return new DeviceAuthorizationConflictError('This device request changed. Refresh its original state.'); }
function parse(value: unknown): DeviceAuthorizationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw denied();
  const row = value as DeviceAuthorizationRecord;
  requireId(row.id); requireDigest(row.invitationDigest); requireDigest(row.issuerDigest);
  if (row.invitationCodeDigest !== undefined) requireDigest(row.invitationCodeDigest);
  if (row.allowKnock !== undefined && typeof row.allowKnock !== 'boolean') throw denied();
  if (row.entryIds !== undefined && (!Array.isArray(row.entryIds) || row.entryIds.length > 64 || new Set(row.entryIds).size !== row.entryIds.length
    || row.entryIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(id)))) throw denied();
  if (typeof row.issuerId !== 'string' || !row.issuerId || !Number.isSafeInteger(row.createdAt)
    || !Number.isSafeInteger(row.expiresAt) || row.expiresAt - row.createdAt !== ttl
    || !['invited', 'pending', 'approved', 'claimed', 'denied', 'cancelled', 'expired'].includes(row.state)) throw denied();
  if (row.request) {
    if (row.request.entryId !== undefined && !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(row.request.entryId)) throw denied();
    requireId(row.request.id); requireDigest(row.request.digest); requireDigest(row.request.authDigest);
    if (typeof row.request.name !== 'string' || !row.request.name || row.request.name.length > 128
      || !['web', 'desktop', 'mobile'].includes(row.request.kind) || typeof row.request.platform !== 'string'
      || row.request.platform.length > 64 || !/^[A-HJ-NP-Z2-9]{8}$/u.test(row.request.code)) throw denied();
  } else if (['pending', 'approved', 'claimed', 'denied'].includes(row.state)) throw denied();
  if (['approved', 'claimed'].includes(row.state)) {
    if (typeof row.approverId !== 'string' || !row.approverId) throw denied(); requireDigest(row.approverDigest!);
  }
  if (row.state === 'claimed') requireId(row.connectionId!);
  return row;
}
