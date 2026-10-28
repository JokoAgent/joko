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
  /** Server-chosen native history/workspace lineage, never an inbound path. */
  readonly storageKey?: string;
  readonly derivation?: HostedNativeDerivationRecord;
}
export interface HostedNativeDerivationRecord {
  readonly operationId: string;
  readonly kind: "fork" | "clone";
  readonly sourceKey: string;
  readonly sourceBinding: NativeSessionBinding;
  readonly providerId: string;
  readonly modelId: string;
  readonly state: "running" | "settled" | "unknown" | "cleaned";
  readonly nativeAdopted: boolean;
  readonly adopted: boolean;
  readonly cleanupRequested: boolean;
  readonly completedSnapshot?: { readonly kind: "completed_assistant"; readonly nativeBoundaryId: string };
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
      if (start === "create" && (prior || this.list().some(row => row.storageKey === key && row.derivation?.state !== "cleaned"))
        || start === "resume" && (!prior?.binding || prior.state === "creating" || prior.state === "purging"
          || prior.derivation && (!prior.derivation.adopted || prior.derivation.cleanupRequested || prior.derivation.state !== "settled"))) {
        throw new StoreError("The hosted native identity cannot be created or resumed with this request.");
      }
      const value: HostedNativeSessionRecord = { format: 1, key, owner: { ...owner }, leaseId,
        state: prior?.binding ? "ready" : "creating", ...(prior?.binding ? { binding: prior.binding } : {}),
        ...(prior?.storageKey ? { storageKey: prior.storageKey } : {}), ...(prior?.derivation ? { derivation: prior.derivation } : {}) };
      this.store.setSetting("service", SCOPE, `session:${key}`, value); return value;
    });
  }
  find(key: string): HostedNativeSessionRecord | undefined {
    assertDigest(key); const row = this.store.findSetting<unknown>("service", SCOPE, `session:${key}`);
    if (!row) return undefined;
    const value = record(row.value);
    if (value.format !== 1 || value.key !== key || !["creating", "ready", "closed", "purging"].includes(value.state as string)) throw new StoreError("The hosted native record is invalid.");
    validateOwner(value.owner as HostedNativeSessionOwner); identity(value.leaseId);
    if (this.key(value.owner as HostedNativeSessionOwner) !== key) throw new StoreError("The hosted native owner conflicts.");
    if (value.binding !== undefined) validateBinding(value.binding as NativeSessionBinding);
    if (value.storageKey !== undefined) assertDigest(value.storageKey);
    if (value.derivation !== undefined) validateDerivation(value.derivation);
    if (value.state !== "creating" && value.state !== "purging" && value.binding === undefined) throw new StoreError("The hosted native binding is missing.");
    if (Object.keys(value).some(name => !["format", "key", "owner", "leaseId", "state", "binding", "storageKey", "derivation"].includes(name))) throw new StoreError("The hosted native record has unknown fields.");
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
  prepareDerivation(sourceKey: string, sourceLease: string, owner: HostedNativeSessionOwner,
    input: Pick<HostedNativeDerivationRecord, "operationId" | "kind" | "providerId" | "modelId" | "completedSnapshot">): HostedNativeSessionRecord {
    return this.store.transaction(() => {
      const source = this.assertLease(sourceKey, sourceLease), key = this.key(owner);
      if (!source.binding || source.state !== "ready" || this.find(key) || key === sourceKey
        || source.owner.authorityId !== owner.authorityId || source.owner.deviceId !== owner.deviceId || source.owner.trust !== owner.trust
        || source.owner.targetId !== owner.targetId || source.owner.backendId !== owner.backendId
        || JSON.stringify(source.owner.providerGrant) !== JSON.stringify(owner.providerGrant)) throw new StoreError("The native derivation source or child owner conflicts.");
      const derivation: HostedNativeDerivationRecord = { ...input, sourceKey, sourceBinding: source.binding, state: "running", nativeAdopted: false, adopted: false, cleanupRequested: false };
      validateDerivation(derivation);
      const value: HostedNativeSessionRecord = { format: 1, key, owner, leaseId: `derive:${input.operationId}`, state: "creating",
        storageKey: source.storageKey ?? source.key, derivation };
      this.store.setSetting("service", SCOPE, `session:${key}`, value); return value;
    });
  }
  updateDerivation(key: string, leaseId: string, update: Partial<Pick<HostedNativeDerivationRecord, "state" | "nativeAdopted" | "adopted" | "cleanupRequested">>,
    binding?: NativeSessionBinding): HostedNativeSessionRecord {
    return this.store.transaction(() => {
      const prior = this.assertLease(key, leaseId); if (!prior.derivation) throw new StoreError("The native child has no derivation owner.");
      if (binding) validateBinding(binding);
      if (binding && prior.binding && (binding.opaqueRef !== prior.binding.opaqueRef
        || binding.nativeSessionId !== prior.binding.nativeSessionId
        || binding.generation !== prior.binding.generation)) throw new StoreError("The native child binding conflicts.");
      const derivation = { ...prior.derivation, ...update }; validateDerivation(derivation);
      if (derivation.adopted && (!prior.binding && !binding || derivation.cleanupRequested || derivation.state !== "settled" || !derivation.nativeAdopted)) throw new StoreError("The native child cannot be adopted.");
      const value: HostedNativeSessionRecord = { ...prior, derivation, ...(binding ? { binding } : {}),
        state: derivation.state === "cleaned" ? "purging" : derivation.state === "settled" && (binding ?? prior.binding) ? "ready" : prior.state };
      this.store.setSetting("service", SCOPE, `session:${key}`, value); return value;
    });
  }
  cancelUnstartedDerivation(owner: HostedNativeSessionOwner, source: HostedNativeSessionRecord, operationId: string, kind: "fork" | "clone"): void {
    this.store.transaction(() => {
      const key = this.key(owner); if (this.find(key)) throw new StoreError("The native derivation cleanup owner changed.");
      if (!source.binding || source.owner.authorityId !== owner.authorityId || source.owner.deviceId !== owner.deviceId
        || source.owner.trust !== owner.trust || source.owner.targetId !== owner.targetId || source.owner.backendId !== owner.backendId) throw new StoreError("The native derivation source owner conflicts.");
      const derivation: HostedNativeDerivationRecord = { operationId, kind, sourceKey: source.key, sourceBinding: source.binding,
        providerId: "cleanup-only", modelId: "cleanup-only", state: "cleaned", nativeAdopted: false, adopted: false, cleanupRequested: true };
      validateDerivation(derivation);
      this.store.setSetting("service", SCOPE, `session:${key}`, { format: 1, key, owner, leaseId: `derive:${operationId}`, state: "purging",
        storageKey: source.storageKey ?? source.key, derivation });
    });
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
    identity(callId); assertDigest(bodyDigest);
    return this.store.transaction(() => {
      this.assertLease(key, leaseId);
      const prior = this.call(key, callId);
      if (prior) { if (prior.digest !== bodyDigest) throw new StoreError("The hosted native call identity conflicts."); return prior; }
      const value: HostedNativeCallReceipt = { format: 1, sessionKey: key, callId, digest: bodyDigest, state: "pending" };
      this.store.setSetting("service", SCOPE, this.#callKey(key, callId), value); return value;
    });
  }
  call(key: string, callId: string): HostedNativeCallReceipt | undefined {
    assertDigest(key); identity(callId);
    const row = this.store.findSetting<unknown>("service", SCOPE, this.#callKey(key, callId)); if (!row) return undefined;
    const value = record(row.value);
    if (value.format !== 1 || value.sessionKey !== key || value.callId !== callId || !["pending", "completed", "failed"].includes(value.state as string)
      || Object.keys(value).some(name => !["format", "sessionKey", "callId", "digest", "state", "resultJson"].includes(name))) throw new StoreError("The hosted native call receipt is invalid.");
    assertDigest(value.digest);
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
function assertDigest(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new StoreError("The hosted native digest is invalid."); }
function validateOwner(owner: HostedNativeSessionOwner): void {
  const value = record(owner);
  for (const field of ["authorityId", "deviceId", "sessionId", "targetId", "nativeSessionId", "backendId"]) identity(value[field]);
  if (!["owner", "guest"].includes(owner.trust) || Object.keys(value).some(name => !["authorityId", "deviceId", "sessionId", "targetId", "nativeSessionId", "backendId", "trust", "providerGrant"].includes(name))) throw new StoreError("The hosted native owner is invalid.");
  if (owner.providerGrant !== undefined) {
    const grant = record(owner.providerGrant); identity(grant.shareId); identity(grant.memberId); assertDigest(grant.cleanupKey);
    if (owner.trust !== "guest" || !Number.isSafeInteger(grant.incarnation) || (grant.incarnation as number) < 1
      || Object.keys(grant).some(name => !["shareId", "memberId", "incarnation", "cleanupKey"].includes(name))) throw new StoreError("The hosted Provider cleanup owner is invalid.");
  }
}
function validateBinding(binding: NativeSessionBinding): void {
  const value = record(binding); identity(value.opaqueRef);
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 0 || value.nativeSessionId !== undefined && typeof value.nativeSessionId !== "string"
    || Object.keys(value).some(name => !["opaqueRef", "nativeSessionId", "generation"].includes(name))) throw new StoreError("The hosted native binding is invalid.");
}
function validateDerivation(input: unknown): asserts input is HostedNativeDerivationRecord {
  const value = record(input);
  for (const key of ["operationId", "providerId", "modelId"]) identity(value[key]);
  assertDigest(value.sourceKey); validateBinding(value.sourceBinding as NativeSessionBinding);
  if (value.completedSnapshot !== undefined) {
    const snapshot = record(value.completedSnapshot); identity(snapshot.nativeBoundaryId);
    if (value.kind !== "fork" || snapshot.kind !== "completed_assistant" || Object.keys(snapshot).some(key => !["kind", "nativeBoundaryId"].includes(key))) throw new StoreError("The native completed snapshot is invalid.");
  }
  if (!["fork", "clone"].includes(value.kind as string) || !["running", "settled", "unknown", "cleaned"].includes(value.state as string)
    || ["nativeAdopted", "adopted", "cleanupRequested"].some(key => typeof value[key] !== "boolean")
    || Object.keys(value).some(key => !["operationId", "kind", "sourceKey", "sourceBinding", "providerId", "modelId", "state", "nativeAdopted", "adopted", "cleanupRequested", "completedSnapshot"].includes(key))) throw new StoreError("The native derivation receipt is invalid.");
}
