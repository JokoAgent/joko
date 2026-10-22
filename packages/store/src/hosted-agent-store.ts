import { createHash } from "node:crypto";
import type { NativeSessionBinding } from "@joko/core";
import { StoreError } from "./errors.js";
import type { OperationalStore } from "./operational-store.js";

const SCOPE = "native-hosted.v1";
export interface HostedNativeSessionOwner {
  readonly authorityId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly nativeSessionId: string;
  readonly backendId: string;
  readonly trust: "owner" | "guest";
  readonly providerGrant?: HostedNativeProviderGrantOwner;
}
export interface HostedNativeProviderGrantOwner {
  readonly shareId: string; readonly memberId: string; readonly incarnation: number; readonly cleanupKey: string;
}
export interface HostedNativeSessionRecord {
  readonly format: 1;
  readonly key: string;
  readonly owner: HostedNativeSessionOwner;
  readonly leaseId: string;
  readonly state: "creating" | "ready" | "closed" | "purging";
  readonly binding?: NativeSessionBinding;
}
export interface HostedNativeCallReceipt {
  readonly format: 1;
  readonly sessionKey: string;
  readonly callId: string;
  readonly digest: string;
  readonly state: "pending" | "completed" | "failed";
  readonly resultJson?: string;
}

/** Native Host metadata is separate from product Sessions and queues. The
 * original task remains their sole owner. Only opaque native references and
 * call receipts live here; no channel bearers or Provider credentials do. */
export class HostedAgentStore {
  constructor(readonly store: OperationalStore) {}
  key(owner: HostedNativeSessionOwner): string {
    validateOwner(owner); return createHash("sha256").update(JSON.stringify([owner.authorityId, owner.deviceId, owner.sessionId,
      owner.targetId, owner.nativeSessionId, owner.backendId, owner.trust])).digest("hex");
  }
  claim(owner: HostedNativeSessionOwner, leaseId: string, start: "create" | "resume"): HostedNativeSessionRecord {
    const key = this.key(owner); identity(leaseId);
    if (start !== "create" && start !== "resume") throw new StoreError("The hosted native start is invalid.");
    return this.store.transaction(() => {
      const prior = this.find(key);
      if (start === "create" && prior || start === "resume" && (!prior?.binding || prior.state === "creating" || prior.state === "purging")) {
        throw new StoreError("The hosted native identity cannot be created or resumed with this request.");
      }
      const value: HostedNativeSessionRecord = { format: 1, key, owner: { ...owner }, leaseId,
        state: prior?.binding ? "ready" : "creating", ...(prior?.binding ? { binding: prior.binding } : {}) };
      this.store.setSetting("service", SCOPE, `session:${key}`, value); return value;
    });
  }
  find(key: string): HostedNativeSessionRecord | undefined {
    digest(key); const row = this.store.findSetting<unknown>("service", SCOPE, `session:${key}`);
    if (!row) return undefined;
    const value = record(row.value);
    if (value.format !== 1 || value.key !== key || !["creating", "ready", "closed", "purging"].includes(value.state as string)) throw new StoreError("The hosted native record is invalid.");
    validateOwner(value.owner as HostedNativeSessionOwner); identity(value.leaseId);
    if (this.key(value.owner as HostedNativeSessionOwner) !== key) throw new StoreError("The hosted native owner conflicts.");
    if (value.binding !== undefined) validateBinding(value.binding as NativeSessionBinding);
    if (value.state !== "creating" && value.state !== "purging" && value.binding === undefined) throw new StoreError("The hosted native binding is missing.");
    if (Object.keys(value).some(name => !["format", "key", "owner", "leaseId", "state", "binding"].includes(name))) throw new StoreError("The hosted native record has unknown fields.");
    return value as unknown as HostedNativeSessionRecord;
  }
  assertLease(key: string, leaseId: string): HostedNativeSessionRecord {
    const value = this.find(key);
    if (!value || value.leaseId !== leaseId) throw new StoreError("The hosted native process owner has changed."); return value;
  }
  bind(key: string, leaseId: string, binding: NativeSessionBinding): void {
    validateBinding(binding);
    this.store.transaction(() => {
      const value = this.assertLease(key, leaseId);
      this.store.setSetting("service", SCOPE, `session:${key}`, { ...value, state: "ready", binding: { ...binding } });
    });
  }
  close(key: string, leaseId: string): void {
    this.store.transaction(() => {
      const value = this.assertLease(key, leaseId);
      // An uncertain creation remains uncertain. It must never become proof
      // that a fresh native context can be dispatched again.
      if (!value.binding) return;
      this.store.setSetting("service", SCOPE, `session:${key}`, { ...value, state: "closed" });
    });
  }
  list(): readonly HostedNativeSessionRecord[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, "session:").map(row => this.find(row.key.slice("session:".length))!);
  }
  /** A confirmed process owner fences resumption before deleting its files. */
  beginPurge(key: string, leaseId: string): void {
    this.store.transaction(() => { const value = this.assertLease(key, leaseId);
      this.store.setSetting("service", SCOPE, `session:${key}`, { ...value, state: "purging" }); });
  }
  finishPurge(key: string, leaseId: string): void {
    this.store.transaction(() => { const value = this.assertLease(key, leaseId);
      if (value.state !== "purging") throw new StoreError("The hosted native cleanup is not fenced.");
      for (const row of this.store.listSettingsByKeyPrefix("service", SCOPE, `call:${key}:`)) this.store.deleteSetting("service", SCOPE, row.key);
      this.store.deleteSetting("service", SCOPE, `session:${key}`); });
  }
  claimCall(key: string, leaseId: string, callId: string, bodyDigest: string): HostedNativeCallReceipt {
    identity(callId); digest(bodyDigest);
    return this.store.transaction(() => {
      this.assertLease(key, leaseId);
      const prior = this.call(key, callId);
      if (prior) { if (prior.digest !== bodyDigest) throw new StoreError("The hosted native call identity conflicts."); return prior; }
      const value: HostedNativeCallReceipt = { format: 1, sessionKey: key, callId, digest: bodyDigest, state: "pending" };
      this.store.setSetting("service", SCOPE, this.#callKey(key, callId), value); return value;
    });
  }
  call(key: string, callId: string): HostedNativeCallReceipt | undefined {
    digest(key); identity(callId);
    const row = this.store.findSetting<unknown>("service", SCOPE, this.#callKey(key, callId)); if (!row) return undefined;
    const value = record(row.value);
    if (value.format !== 1 || value.sessionKey !== key || value.callId !== callId || !["pending", "completed", "failed"].includes(value.state as string)
      || Object.keys(value).some(name => !["format", "sessionKey", "callId", "digest", "state", "resultJson"].includes(name))) throw new StoreError("The hosted native call receipt is invalid.");
    digest(value.digest);
    if (value.resultJson !== undefined && (typeof value.resultJson !== "string" || Buffer.byteLength(value.resultJson) > 64 * 1024 * 1024)) throw new StoreError("The hosted native result receipt is invalid.");
    if (value.state === "completed" && value.resultJson === undefined) throw new StoreError("The hosted native result is missing.");
    return value as unknown as HostedNativeCallReceipt;
  }
  finishCall(key: string, leaseId: string, callId: string, bodyDigest: string, result: { readonly ok: true; readonly value: unknown } | { readonly ok: false }): void {
    this.store.transaction(() => {
      this.assertLease(key, leaseId); const value = this.call(key, callId);
      if (!value || value.digest !== bodyDigest || value.state !== "pending") throw new StoreError("The hosted native call cannot be committed.");
      const resultJson = result.ok ? JSON.stringify(result.value ?? null) : undefined;
      if (resultJson !== undefined && Buffer.byteLength(resultJson) > 64 * 1024 * 1024) throw new StoreError("The hosted native result exceeds its receipt limit.");
      this.store.setSetting("service", SCOPE, this.#callKey(key, callId), { ...value, state: result.ok ? "completed" : "failed", ...(resultJson !== undefined ? { resultJson } : {}) });
    });
  }
  #callKey(key: string, callId: string): string { return `call:${key}:${createHash("sha256").update(callId).digest("hex")}`; }
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("The hosted native record is invalid."); return value as Record<string, unknown>; }
function identity(value: unknown): asserts value is string { if (typeof value !== "string" || !value || value.length > 2048 || /[\0\r\n]/u.test(value)) throw new StoreError("The hosted native identity is invalid."); }
function digest(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new StoreError("The hosted native digest is invalid."); }
function validateOwner(owner: HostedNativeSessionOwner): void {
  const value = record(owner);
  for (const field of ["authorityId", "deviceId", "sessionId", "targetId", "nativeSessionId", "backendId"]) identity(value[field]);
  if (!["owner", "guest"].includes(owner.trust) || Object.keys(value).some(name => !["authorityId", "deviceId", "sessionId", "targetId", "nativeSessionId", "backendId", "trust", "providerGrant"].includes(name))) throw new StoreError("The hosted native owner is invalid.");
  if (owner.providerGrant !== undefined) {
    const grant = record(owner.providerGrant); identity(grant.shareId); identity(grant.memberId); digest(grant.cleanupKey);
    if (owner.trust !== "guest" || !Number.isSafeInteger(grant.incarnation) || (grant.incarnation as number) < 1
      || Object.keys(grant).some(name => !["shareId", "memberId", "incarnation", "cleanupKey"].includes(name))) throw new StoreError("The hosted Provider cleanup owner is invalid.");
  }
}
function validateBinding(binding: NativeSessionBinding): void {
  const value = record(binding); identity(value.opaqueRef);
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 0 || value.nativeSessionId !== undefined && typeof value.nativeSessionId !== "string"
    || Object.keys(value).some(name => !["opaqueRef", "nativeSessionId", "generation"].includes(name))) throw new StoreError("The hosted native binding is invalid.");
}
