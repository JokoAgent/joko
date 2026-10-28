import { createHash } from "node:crypto";
import type { NativeSessionBinding, PermissionMode } from "@joko/core";
import { StoreError } from "./errors.js";
import type { OperationalStore } from "./operational-store.js";

export const SESSION_RUNTIME_HANDOFF_SCOPE = "session.runtime-handoffs";
const RUNTIME_CREATION_SCOPE = "session.runtime-creations";
export interface RuntimeCreationAdmission {
  readonly format: 1; readonly operationId: string; readonly operationBodyHash: string; readonly sessionId: string;
  readonly targetId: string; readonly targetRevision: string; readonly backendId: string; readonly backendInstanceGeneration: number;
  readonly workspaceRoot: string; readonly phase: "prepared" | "effect" | "closed" | "unknown";
}
export interface RuntimeHandoffProfile {
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
  readonly effort?: string; readonly fastMode: boolean | "ultrafast";
}
export interface ParkedRuntimeBinding {
  readonly backendId: string; readonly binding: NativeSessionBinding;
  readonly backendInstanceGeneration: number; readonly cursor: string;
}
export interface RuntimeHandoffSource extends ParkedRuntimeBinding {
  readonly targetId: string; readonly targetRevision: string; readonly workspaceRoot: string;
  readonly realWorkspaceRoot: string;
  readonly worktreeJson: string; readonly permissionMode: PermissionMode; readonly planMode: boolean;
  readonly promptDigest: string;
}
export interface PendingRuntimeHandoff {
  readonly generation: number; readonly source: "agent" | "fallback";
  readonly profile: RuntimeHandoffProfile;
  readonly phase: "pending" | "closed" | "effect" | "ready" | "unknown";
  readonly origin?: RuntimeHandoffSource;
  readonly effect?: "close" | "resume" | "create" | "configure";
  readonly backendInstanceGeneration?: number;
  readonly binding?: NativeSessionBinding; readonly resumed?: boolean; readonly handoff?: string;
  readonly fresh?: boolean;
}
export interface RuntimeHandoffRecord {
  readonly format: 1; readonly generation: number;
  readonly parked: readonly ParkedRuntimeBinding[];
  readonly pending?: PendingRuntimeHandoff;
  readonly injection?: { readonly generation: number; readonly binding: NativeSessionBinding; readonly text: string; readonly queueItemId?: string };
}
export interface RuntimeTargetAdmission {
  readonly sessionId: string; readonly targetId: string; readonly backendId: string;
  readonly generation: number; readonly backendInstanceGeneration: number; readonly workspaceRoot: string;
  readonly operationId?: string;
}

/** Private current-v1 intent, native-effect receipts and parked ownership. */
export class SessionRuntimeHandoffStore {
  constructor(readonly store: OperationalStore) {}
  admitsTarget(input: RuntimeTargetAdmission): boolean {
    const target = this.store.getTarget(input.targetId), backend = this.store.getBackend(input.backendId).descriptor;
    if (!target.descriptor.trusted || target.descriptor.remoteWorkspace !== undefined
      || backend.instanceGeneration !== input.backendInstanceGeneration) return false;
    let session;
    try { session = this.store.getSession(input.sessionId).descriptor; } catch { /* Creation is admitted by its durable Operation below. */ }
    if (session !== undefined) {
      if (session.targetId !== input.targetId || session.deletedAt !== undefined || session.archived || session.remoteWorkspace !== undefined
        || (session.worktree?.path ?? target.descriptor.workspaceRoot) !== input.workspaceRoot) return false;
      if (session.backendId === input.backendId) return input.generation === session.binding.generation || input.generation === session.binding.generation + 1;
      const pending = this.read(input.sessionId)?.pending, origin = pending?.origin;
      return pending !== undefined && ["closed", "effect", "ready"].includes(pending.phase) && origin !== undefined
        && pending.profile.backendId === input.backendId && origin.backendId === session.backendId
        && origin.targetRevision === target.revision.toString() && origin.binding.generation === session.binding.generation
        && origin.binding.opaqueRef === session.binding.opaqueRef && origin.binding.nativeSessionId === session.binding.nativeSessionId
        && input.generation === origin.binding.generation + 1;
    }
    const operation = input.operationId === undefined ? undefined : this.store.findOperation(input.operationId);
    const body = operation?.body;
    const creation = input.operationId === undefined ? undefined : this.creation(input.operationId);
    if (creation && operation?.status === "started" && object(body) && body["targetId"] === input.targetId
      && creation.phase === "effect" && creation.operationBodyHash === operation.bodyHash && creation.targetId === input.targetId
      && creation.targetRevision === target.revision.toString() && creation.backendId === input.backendId
      && creation.backendInstanceGeneration === input.backendInstanceGeneration && creation.workspaceRoot === input.workspaceRoot
      && creation.sessionId === input.sessionId && input.generation === 1) return true;
    return operation?.kind === "create_partner_session" && operation.status === "started" && object(body)
      && body["targetId"] === input.targetId && body["runtimeBackendId"] === input.backendId
      && input.generation === 1 && input.workspaceRoot === target.descriptor.workspaceRoot
      && input.sessionId === `session-${createHash("sha256").update(operation.id).digest("hex").slice(0, 24)}`;
  }
  creation(operationId: string): RuntimeCreationAdmission | undefined {
    const value = this.store.findSetting("service", RUNTIME_CREATION_SCOPE, operationId)?.value;
    if (value === undefined) return undefined;
    if (!object(value) || !keys(value, ["format", "operationId", "operationBodyHash", "sessionId", "targetId", "targetRevision", "backendId", "backendInstanceGeneration", "workspaceRoot", "phase"])
      || value["format"] !== 1 || !["operationId", "operationBodyHash", "sessionId", "targetId", "targetRevision", "backendId", "workspaceRoot"].every(key => boundedText(value[key], 16_384))
      || !integer(value["backendInstanceGeneration"]) || !["prepared", "effect", "closed", "unknown"].includes(String(value["phase"]))) throw new StoreError("The native runtime creation admission is invalid.");
    return value as unknown as RuntimeCreationAdmission;
  }
  stageCreation(input: Omit<RuntimeCreationAdmission, "format" | "phase">): void {
    const previous = this.creation(input.operationId); if (previous && previous.phase !== "closed" && previous.phase !== "prepared") throw new StoreError("The previous native creation effect must be reconciled before selecting another member.");
    const operation = this.store.getOperation(input.operationId), target = this.store.getTarget(input.targetId);
    if (operation.status !== "started" || operation.bodyHash !== input.operationBodyHash || target.revision.toString() !== input.targetRevision
      || !target.descriptor.trusted || target.descriptor.remoteWorkspace !== undefined) throw new StoreError("The runtime creation admission lost its original Operation or Target.");
    this.store.setSetting("service", RUNTIME_CREATION_SCOPE, input.operationId, { format: 1, ...input, phase: "prepared" });
  }
  creationPhase(operationId: string, phase: RuntimeCreationAdmission["phase"]): void {
    const current = this.creation(operationId); if (!current || current.phase === "unknown" && phase !== "unknown") throw new StoreError("The native creation effect is unknown.");
    this.store.setSetting("service", RUNTIME_CREATION_SCOPE, operationId, { ...current, phase });
  }
  finishCreation(operationId: string): void { this.store.deleteSetting("service", RUNTIME_CREATION_SCOPE, operationId); }
  read(sessionId: string): RuntimeHandoffRecord | undefined {
    const value = this.store.findSetting("service", SESSION_RUNTIME_HANDOFF_SCOPE, sessionId)?.value;
    return value === undefined ? undefined : readRuntimeHandoffRecord(value);
  }
  save(sessionId: string, record: RuntimeHandoffRecord): void {
    readRuntimeHandoffRecord(record);
    this.store.setSetting("service", SESSION_RUNTIME_HANDOFF_SCOPE, sessionId, record);
  }
  stage(sessionId: string, generation: number, profile: RuntimeHandoffProfile, source: "agent" | "fallback", fresh = false): void {
    this.store.transaction(() => {
      const current = this.read(sessionId);
      if (generation <= (current?.generation ?? -1)) throw new StoreError("Runtime selection generation did not advance.");
      if (current?.pending && current.pending.phase !== "pending" && current.pending.phase !== "closed") {
        throw new StoreError("The native handoff effect must be reconciled before another selection.");
      }
      this.save(sessionId, { format: 1, generation, parked: current?.parked ?? [],
        ...(current?.injection === undefined ? {} : { injection: current.injection }),
        pending: { generation, profile, source, phase: current?.pending?.phase === "closed" ? "closed" : "pending",
          ...(fresh ? { fresh: true } : {}),
          ...(current?.pending?.origin === undefined ? {} : { origin: current.pending.origin }) } });
    });
  }
  transition(sessionId: string, generation: number, pending: PendingRuntimeHandoff): RuntimeHandoffRecord {
    return this.store.transaction(() => {
      const current = this.read(sessionId);
      if (current?.pending?.generation !== generation || pending.generation !== generation) {
        throw new StoreError("Runtime handoff lost its exact durable intent.");
      }
      const next = { ...current, pending }; this.save(sessionId, next); return next;
    });
  }
  cancel(sessionId: string, generation: number): void {
    this.store.transaction(() => {
      const current = this.read(sessionId); if (!current?.pending) return;
      if (current.pending.phase !== "pending") throw new StoreError("An executing native handoff cannot be discarded.");
      const { pending: _pending, ...remaining } = current;
      this.save(sessionId, { ...remaining, generation });
    });
  }
  settle(sessionId: string, generation: number, binding: NativeSessionBinding): void {
    const current = this.read(sessionId), pending = current?.pending;
    if (!current || pending?.generation !== generation || pending.phase !== "ready" || !pending.origin || !pending.handoff) {
      throw new StoreError("Runtime adoption has no complete prepared receipt.");
    }
    const { pending: _pending, injection: _injection, ...remaining } = current;
    const { targetId: _target, targetRevision: _revision, workspaceRoot: _root, realWorkspaceRoot: _realRoot, worktreeJson: _worktree,
      permissionMode: _mode, planMode: _plan, promptDigest: _prompt, ...parked } = pending.origin;
    this.save(sessionId, { ...remaining,
      parked: [...current.parked.filter(row => row.backendId !== parked.backendId && row.backendId !== pending.profile.backendId),
        ...(parked.backendId === pending.profile.backendId ? [] : [parked])],
      injection: { generation, binding, text: pending.handoff } });
  }
  claimInjection(sessionId: string, queueItemId: string): string | undefined {
    return this.store.transaction(() => {
      const current = this.read(sessionId), injection = current?.injection;
      if (!current || !injection) return undefined;
      const session = this.store.getSession(sessionId).descriptor;
      if (session.binding.opaqueRef !== injection.binding.opaqueRef || session.binding.nativeSessionId !== injection.binding.nativeSessionId) {
        throw new StoreError("The pending handoff belongs to another native binding.");
      }
      if (injection.queueItemId !== undefined && injection.queueItemId !== queueItemId) {
        throw new StoreError("A prior input owns the unconfirmed handoff injection. Inspect its delivery before continuing.");
      }
      this.save(sessionId, { ...current, injection: { ...injection, queueItemId } }); return injection.text;
    });
  }
  consumeInjection(sessionId: string, queueItemId: string): void {
    const current = this.read(sessionId); if (current?.injection?.queueItemId !== queueItemId) return;
    const { injection: _injection, ...remaining } = current; this.save(sessionId, remaining);
  }
}

export function readRuntimeHandoffRecord(value: unknown): RuntimeHandoffRecord {
  if (!object(value) || !keys(value, ["format", "generation", "parked", "pending", "injection"])
    || value["format"] !== 1 || !integer(value["generation"]) || !Array.isArray(value["parked"])
    || !value["parked"].every(parked) || new Set(value["parked"].map(row => row.backendId)).size !== value["parked"].length) throw invalid();
  const pending = value["pending"];
  if (pending !== undefined && (!object(pending) || !keys(pending, ["generation", "source", "profile", "phase", "origin", "effect", "backendInstanceGeneration", "binding", "resumed", "handoff", "fresh"])
    || pending["generation"] !== value["generation"] || !["agent", "fallback"].includes(String(pending["source"]))
    || !profile(pending["profile"]) || !["pending", "closed", "effect", "ready", "unknown"].includes(String(pending["phase"]))
    || pending["origin"] !== undefined && !origin(pending["origin"])
    || pending["phase"] !== "pending" && !origin(pending["origin"])
    || pending["effect"] !== undefined && !["close", "resume", "create", "configure"].includes(String(pending["effect"]))
    || pending["phase"] === "effect" && pending["effect"] === undefined
    || pending["backendInstanceGeneration"] !== undefined && !integer(pending["backendInstanceGeneration"])
    || pending["binding"] !== undefined && !binding(pending["binding"])
    || pending["resumed"] !== undefined && typeof pending["resumed"] !== "boolean"
    || pending["fresh"] !== undefined && typeof pending["fresh"] !== "boolean"
    || pending["handoff"] !== undefined && !boundedText(pending["handoff"], 20_000)
    || pending["phase"] === "ready" && (!binding(pending["binding"]) || !integer(pending["backendInstanceGeneration"])
      || typeof pending["resumed"] !== "boolean" || !boundedText(pending["handoff"], 20_000)))) throw invalid();
  const injection = value["injection"];
  if (injection !== undefined && (!object(injection) || !keys(injection, ["generation", "binding", "text", "queueItemId"])
    || !integer(injection["generation"]) || !binding(injection["binding"]) || !boundedText(injection["text"], 20_000)
    || injection["queueItemId"] !== undefined && !boundedText(injection["queueItemId"], 512))) throw invalid();
  return value as unknown as RuntimeHandoffRecord;
}
function invalid() { return new StoreError("Stored native runtime handoff is not a valid current-v1 record."); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function boundedText(value: unknown, cap: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= cap && !value.includes("\0"); }
function binding(value: unknown): value is NativeSessionBinding {
  return object(value) && keys(value, ["opaqueRef", "nativeSessionId", "generation"]) && boundedText(value["opaqueRef"], 8192)
    && integer(value["generation"]) && (value["nativeSessionId"] === undefined || boundedText(value["nativeSessionId"], 8192));
}
function profile(value: unknown): value is RuntimeHandoffProfile {
  return object(value) && keys(value, ["backendId", "providerId", "modelId", "effort", "fastMode"])
    && ["backendId", "providerId", "modelId"].every(key => boundedText(value[key], 512))
    && (typeof value["fastMode"] === "boolean" || value["fastMode"] === "ultrafast") && (value["effort"] === undefined || boundedText(value["effort"], 64));
}
function parked(value: unknown): value is ParkedRuntimeBinding {
  return object(value) && keys(value, ["backendId", "binding", "backendInstanceGeneration", "cursor"])
    && boundedText(value["backendId"], 512) && binding(value["binding"]) && integer(value["backendInstanceGeneration"])
    && typeof value["cursor"] === "string" && /^(0|[1-9][0-9]*)$/u.test(value["cursor"]);
}
function origin(value: unknown): value is RuntimeHandoffSource {
  if (!object(value) || !keys(value, ["backendId", "binding", "backendInstanceGeneration", "cursor", "targetId", "targetRevision", "workspaceRoot", "realWorkspaceRoot", "worktreeJson", "permissionMode", "planMode", "promptDigest"])) return false;
  const { targetId, targetRevision, workspaceRoot, realWorkspaceRoot, worktreeJson, permissionMode, planMode, promptDigest, ...base } = value;
  return parked(base) && boundedText(targetId, 512) && typeof targetRevision === "string" && /^[1-9][0-9]*$/u.test(targetRevision)
    && boundedText(workspaceRoot, 8192) && boundedText(realWorkspaceRoot, 8192) && typeof worktreeJson === "string" && worktreeJson.length <= 16384
    && ["ask", "acceptEdits", "auto", "bypassPermissions"].includes(String(permissionMode)) && typeof planMode === "boolean"
    && typeof promptDigest === "string" && /^[a-f0-9]{64}$/u.test(promptDigest);
}
