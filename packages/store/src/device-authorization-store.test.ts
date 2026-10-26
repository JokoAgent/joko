import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalStore } from './operational-store.js';
import { DeviceAuthorizationStore } from './device-authorization-store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const secret = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'joko-device-approval-')), file = join(directory, 'store.sqlite');
  let store = new OperationalStore(file), now = 1_000_000;
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = store.createConnection({ id: randomUUID(), name: 'Existing phone', authKeyDigest: digest(secret()) });
  const invitationId = randomUUID(), invitationSecret = secret(), requesterSecret = secret(), authKey = secret();
  const proof = { invitationId, requestId: randomUUID(), requesterSecret };
  const input = { ...proof, invitationSecret, authKeyDigest: digest(authKey), name: 'Office computer', kind: 'desktop' as const, platform: 'windows' };
  const sessions = () => new DeviceAuthorizationStore(store, () => now);
  sessions().create(invitationId, digest(invitationSecret), issuer);
  return { get store() { return store; }, issuer, invitationId, invitationSecret, authKey, input, proof, sessions,
    advance: (ms: number) => { now += ms; }, restart: () => { store.close(); store = new OperationalStore(file); } };
}
describe('request-bound device authorization', () => {
  it('admits a short code only on its node and still requires exact device approval', () => {
    const f = fixture(), id = randomUUID(), code = 'ABCD2345';
    f.sessions().create(id, digest(secret()), f.issuer, ['direct'], { codeDigest: digest(code) });
    expect(() => f.sessions().findInvitation('ABCD2346')).toThrow();
    expect(f.sessions().findInvitation(code).id).toBe(id);
    expect(() => f.sessions().request({ ...f.input, invitationId: id, invitationSecret: '', invitationCode: code, entryId: 'other' })).toThrow();
    const input = { ...f.input, invitationId: id, invitationSecret: '', invitationCode: code, entryId: 'direct' };
    const proof = { ...f.proof, invitationId: id };
    expect(f.sessions().request(input).state).toBe('pending');
    expect(f.sessions().claim(proof).state).toBe('pending'); expect(f.store.listConnections()).toHaveLength(1);
    expect(() => f.sessions().claim({ ...proof, requesterSecret: code })).toThrow();
    for (let i = 0; i < 31; i++) { try { f.sessions().findInvitation('ZZZZ9999'); } catch { /* Exhaust the shared lookup limit. */ } }
    expect(() => f.sessions().findInvitation(code)).toThrow(/attempts/u);
    // A legitimate saved request can still resume after unrelated guessing exhausts admission.
    expect(f.sessions().request(input).state).toBe('pending');
    f.sessions().resolve(id, proof.requestId, 'approved', f.issuer);
    const claimed = f.sessions().claim(proof); expect(claimed.state).toBe('claimed');
    expect(f.sessions().claim(proof).connectionId).toBe(claimed.connectionId);
    expect(JSON.stringify(f.store.listSettings().map(row => row.value))).not.toContain(code);
  });
  it('opens one bounded knock window explicitly and closes it on expiry or issuer revocation', () => {
    const f = fixture(); expect(() => f.sessions().findInvitation('')).toThrow();
    expect(() => f.sessions().request({ ...f.input, invitationSecret: '', knock: true })).toThrow();
    const id = randomUUID(); f.sessions().create(id, digest(secret()), f.issuer, undefined, { allowKnock: true });
    expect(f.sessions().findInvitation('').id).toBe(id);
    expect(() => f.sessions().create(randomUUID(), digest(secret()), f.issuer, undefined, { allowKnock: true })).toThrow(/existing/u);
    const proof = { ...f.proof, invitationId: id };
    expect(f.sessions().request({ ...f.input, invitationId: id, invitationSecret: '', knock: true }).state).toBe('pending');
    expect(f.sessions().claim(proof).state).toBe('pending'); expect(() => f.sessions().findInvitation('')).toThrow();
    f.advance(600_001); expect(f.sessions().claim(proof).state).toBe('expired');
    const next = randomUUID(); f.sessions().create(next, digest(secret()), f.issuer, undefined, { allowKnock: true });
    f.store.revokeConnection(f.issuer.id); expect(() => f.sessions().findInvitation('')).toThrow();
    expect(f.store.listConnections()).toHaveLength(1);
  });
  it('requires exact approval and creates only one independent connection across lost receipts and restart', () => {
    const f = fixture(), pending = f.sessions().request(f.input);
    expect(pending.state).toBe('pending'); expect(f.sessions().claim(f.proof).state).toBe('pending');
    expect(() => f.sessions().resolve(f.invitationId, randomUUID(), 'approved', f.issuer)).toThrow();
    f.sessions().resolve(f.invitationId, f.proof.requestId, 'approved', f.issuer);
    const first = f.sessions().claim(f.proof); f.restart();
    const replay = f.sessions().claim(f.proof);
    expect(replay.connectionId).toBe(first.connectionId); expect(f.store.listConnections()).toHaveLength(2);
    expect(f.store.authorizeConnection(first.connectionId!, digest(f.authKey)).deviceId).not.toBe(f.issuer.deviceId);
    expect(f.sessions().request(f.input).connectionId).toBe(first.connectionId);
    const durable = JSON.stringify(f.store.listSettings().map(row => row.value));
    for (const value of [f.authKey, f.input.requesterSecret, f.invitationSecret]) expect(durable).not.toContain(value);
  });
  it('does not let a short code, invitation or alternate requester consume or cancel the exact request', () => {
    const f = fixture(), pending = f.sessions().request(f.input);
    expect(() => f.sessions().read({ ...f.proof, requesterSecret: pending.request!.code })).toThrow();
    expect(() => f.sessions().cancel({ ...f.proof, requesterSecret: f.invitationSecret })).toThrow();
    expect(() => f.sessions().request({ ...f.input, requesterSecret: secret() })).toThrow();
    expect(() => f.sessions().request({ ...f.input, name: 'Different name' })).toThrow();
    expect(() => f.sessions().request({ ...f.input, authKeyDigest: digest(secret()) })).toThrow();
    expect(f.sessions().read(f.proof).state).toBe('pending');
  });
  it.each(['issuer', 'approver'] as const)('rechecks %s revocation before claim without revoking an already claimed child', role => {
    const f = fixture(); f.sessions().request(f.input);
    const approver = f.store.createConnection({ id: randomUUID(), name: 'Second trusted device', authKeyDigest: digest(secret()) });
    f.sessions().resolve(f.invitationId, f.proof.requestId, 'approved', approver);
    f.store.revokeConnection(role === 'issuer' ? f.issuer.id : approver.id);
    expect(f.sessions().claim(f.proof).state).toBe('cancelled'); expect(f.store.listConnections()).toHaveLength(2);
  });
  it('keeps cancellation/denial/expiry terminal and reports a completed claim accurately', () => {
    const f = fixture(); f.sessions().request(f.input);
    f.sessions().resolve(f.invitationId, f.proof.requestId, 'approved', f.issuer);
    expect(f.sessions().cancel(f.proof).state).toBe('cancelled');
    expect(f.sessions().claim(f.proof).state).toBe('cancelled');
    expect(f.sessions().resolve(f.invitationId, f.proof.requestId, 'approved', f.issuer).state).toBe('cancelled');
    const g = fixture(); g.sessions().request(g.input); g.sessions().resolve(g.invitationId, g.proof.requestId, 'approved', g.issuer);
    const claimed = g.sessions().claim(g.proof);
    expect(g.sessions().cancel(g.proof).state).toBe('claimed');
    g.store.revokeConnection(g.issuer.id);
    expect(g.sessions().claim(g.proof).connectionId).toBe(claimed.connectionId);
    g.store.revokeConnection(claimed.connectionId!);
    expect(() => g.sessions().claim(g.proof)).toThrow();
    const h = fixture(); h.sessions().request(h.input); h.advance(600_001); h.restart();
    expect(h.sessions().claim(h.proof).state).toBe('expired');
    expect(h.store.listConnections()).toHaveLength(1);
  });
  it('retains invitation limits through restart and does not extend a replayed invitation', () => {
    const f = fixture(); const original = f.sessions().create(f.invitationId, digest(f.invitationSecret), f.issuer);
    f.advance(20_000); f.restart();
    expect(f.sessions().create(f.invitationId, digest(f.invitationSecret), f.issuer).expiresAt).toBe(original.expiresAt);
    for (let index = 0; index < 5; index++) f.sessions().create(randomUUID(), digest(secret()), f.issuer);
    f.restart(); expect(() => f.sessions().create(randomUUID(), digest(secret()), f.issuer)).toThrow(/limited/u);
  });
});
