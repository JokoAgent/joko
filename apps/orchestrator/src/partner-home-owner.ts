import { createHash } from "node:crypto";
import { OperationPreviouslyFailedError, type PartnerCapabilitiesRecord, type OperationalStore } from "@joko/store";

export type PartnerHomeLocation = { readonly kind: "service"; readonly deviceId: string; readonly name: string }
  | { readonly kind: "device"; readonly deviceId: string; readonly controllerDeviceId: string; readonly name: string; readonly root: string };
export type PartnerHomeMovePhase = "waiting" | "stopping" | "preparing" | "activating" | "ready" | "needs-attention";
export type PartnerHomeMoveFailure = "busy" | "source-unavailable" | "target-unavailable" | "runtime-unavailable"
  | "state-changed" | "outcome-unknown" | "preparation-failed";

export interface PartnerHomeRecord {
  readonly version: 1;
  readonly partnerId: string;
  readonly generation: number;
  readonly location: PartnerHomeLocation;
}
export interface PartnerHomeMoveRecord {
  readonly version: 1;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly partnerId: string;
  readonly partnerRevision: string;
  readonly source: PartnerHomeRecord;
  readonly destination: PartnerHomeLocation;
  readonly capabilities: PartnerCapabilitiesRecord;
  readonly busyAction: "wait" | "stop";
  readonly continueWhenSourceOffline: boolean;
  readonly sourceSessionId: string;
  readonly sourceSessionIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly phase: PartnerHomeMovePhase;
  readonly resumePhase: Exclude<PartnerHomeMovePhase, "ready" | "needs-attention">;
  readonly committed: boolean;
  readonly sourceFenced: boolean;
  readonly canonicalSessionId?: string;
  readonly historyThroughCursor?: string;
  readonly failure?: PartnerHomeMoveFailure;
}

export class PartnerHomeError extends Error {
  constructor(readonly code: PartnerHomeMoveFailure, message: string) { super(message); this.name = "PartnerHomeError"; }
}

const SCOPE = "service", OWNER = "partner-homes";
const CURRENT = "current.", MOVES = "move.";
const identity = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new PartnerHomeError("state-changed", "Invalid Partner home identity.");
  return value;
};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : typeof value === "object" && value !== null ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);
const locationIdentity = (value: PartnerHomeLocation) => value.kind === "service" ? [value.kind, value.deviceId]
  : [value.kind, value.deviceId, value.controllerDeviceId, value.root];

/** Current v1 ownership and effect receipts. No credential or portable file bytes enter this store. */
export class PartnerHomeStorage {
  readonly #moves = new Map<string, PartnerHomeMoveRecord>();
  constructor(private readonly store: OperationalStore) {
    for (const row of store.listSettingsByKeyPrefix(SCOPE, OWNER, MOVES)) {
      const move = parseMove(row.value); this.#moves.set(move.requestId, move);
    }
  }
  current(partnerId: string, local: PartnerHomeLocation): PartnerHomeRecord {
    const value = this.store.findSetting<unknown>(SCOPE, OWNER, CURRENT + identity(partnerId))?.value;
    if (value !== undefined) return parseHome(value);
    const home: PartnerHomeRecord = { version: 1, partnerId, generation: 1, location: local };
    this.store.setSetting(SCOPE, OWNER, CURRENT + partnerId, home); return copy(home);
  }
  move(requestId: string): PartnerHomeMoveRecord | undefined { const value = this.#moves.get(identity(requestId)); return value && copy(value); }
  list(): readonly PartnerHomeMoveRecord[] { return [...this.#moves.values()].map(copy); }
  changing(partnerId: string): boolean { return [...this.#moves.values()].some(move => move.partnerId === partnerId && move.sourceFenced && move.phase !== "ready"); }
  freezesInput(sessionId: string): boolean { return [...this.#moves.values()].some(move => move.sourceSessionIds.includes(sessionId) && (move.sourceFenced || move.committed)); }
  blocksSession(sessionId: string): boolean { return [...this.#moves.values()].some(move => move.sourceSessionIds.includes(sessionId)
    && (move.committed || move.sourceFenced && move.resumePhase !== "waiting")); }
  save(move: PartnerHomeMoveRecord): void {
    const checked = parseMove(move);
    this.store.setSetting(SCOPE, OWNER, MOVES + digest(move.requestId), checked);
    this.#moves.set(move.requestId, checked);
  }
  commit(move: PartnerHomeMoveRecord): PartnerHomeMoveRecord {
    const updated = { ...move, phase: "activating" as const, resumePhase: "activating" as const, committed: true, sourceFenced: true };
    this.store.transaction(store => {
      const home = parseHome(store.findSetting<unknown>(SCOPE, OWNER, CURRENT + move.partnerId)?.value);
      if (home.generation !== move.source.generation || digest(home.location) !== digest(move.source.location)) {
        throw new PartnerHomeError("state-changed", "The Partner already has another execution home.");
      }
      store.setSetting(SCOPE, OWNER, CURRENT + move.partnerId, { version: 1, partnerId: move.partnerId,
        generation: home.generation + 1, location: move.destination } satisfies PartnerHomeRecord);
      store.setSetting(SCOPE, OWNER, MOVES + digest(move.requestId), updated);
    });
    this.#moves.set(move.requestId, updated); return copy(updated);
  }
}

/** Ports belong to the real profile, runtime, filesystem and history owners. */
export interface PartnerHomeRuntime {
  readonly authorityServerId: string;
  readonly local: PartnerHomeLocation & { readonly kind: "service" };
  profile(partnerId: string): { readonly revision: bigint; readonly lifecycle: string; readonly ready: boolean; readonly sessionId?: string };
  sessions(partnerId: string): readonly string[];
  management<T>(partnerId: string, action: () => Promise<T>): Promise<T>;
  assertDestination(destination: PartnerHomeLocation, capabilities: PartnerCapabilitiesRecord): Promise<void>;
  busy(partnerId: string): Promise<boolean>;
  sourceAvailable(home: PartnerHomeRecord): boolean;
  stop(move: PartnerHomeMoveRecord): Promise<void>;
  prepare(move: PartnerHomeMoveRecord, assertCurrent: () => void): Promise<string>;
  activate(move: PartnerHomeMoveRecord, assertCurrent: () => void): Promise<string>;
  settled?(move: PartnerHomeMoveRecord): Promise<void>;
  assertOwner(): void;
}

/**
 * Adapts the fixed reference's compare-home / wait-or-stop / materialize /
 * shadow-until-rebuilt ordering to one stable Orchestrator authority. The
 * accepted identity is persisted before any close, file write or activation.
 */
export class PartnerHomeOwner {
  readonly #flights = new Map<string, Promise<PartnerHomeMoveRecord>>();
  #closed = false;
  constructor(readonly storage: PartnerHomeStorage, private readonly runtime: PartnerHomeRuntime,
    private readonly options: { readonly now?: () => number; readonly wait?: (signal?: AbortSignal) => Promise<void>;
      readonly busyWaitMs?: number } = {}) {}
  current(partnerId: string): PartnerHomeRecord { this.#assert(); this.runtime.profile(partnerId); return this.storage.current(partnerId, this.runtime.local); }
  get(requestId: string): PartnerHomeMoveRecord | undefined { this.#assert(); return this.storage.move(requestId); }
  async move(input: { readonly requestId: string; readonly partnerId: string; readonly expectedGeneration: number;
    readonly expectedPartnerRevision: bigint; readonly destination: PartnerHomeLocation; readonly capabilities: PartnerCapabilitiesRecord;
    readonly busyAction: "wait" | "stop"; readonly continueWhenSourceOffline: boolean }): Promise<PartnerHomeMoveRecord> {
    this.#assert(); identity(input.requestId); identity(input.partnerId);
    const capabilities = { ...input.capabilities, inputHandoff: input.capabilities.inputHandoff !== false };
    const fingerprint = digest({ requestId: input.requestId, partnerId: input.partnerId, expectedGeneration: input.expectedGeneration,
      expectedPartnerRevision: input.expectedPartnerRevision.toString(), destination: locationIdentity(input.destination),
      capabilities, busyAction: input.busyAction, continueWhenSourceOffline: input.continueWhenSourceOffline });
    const previous = this.storage.move(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PartnerHomeError("state-changed", "This home-change request already names another action.");
      return previous;
    }
    return this.runtime.management(input.partnerId, async () => {
      this.#assert(); const home = this.current(input.partnerId), profile = this.runtime.profile(input.partnerId);
      if (profile.revision !== input.expectedPartnerRevision || home.generation !== input.expectedGeneration
        || profile.lifecycle !== "active" || !profile.ready || !profile.sessionId || this.storage.changing(input.partnerId)
        || digest(locationIdentity(home.location)) === digest(locationIdentity(input.destination))) throw new PartnerHomeError("state-changed", "Refresh the Partner home before moving it.");
      await this.runtime.assertDestination(input.destination, capabilities); this.#assert();
      const latest = this.runtime.profile(input.partnerId);
      if (latest.revision !== profile.revision || latest.sessionId !== profile.sessionId) throw new PartnerHomeError("state-changed", "The Partner changed during the target check.");
      const at = this.#now();
      const move: PartnerHomeMoveRecord = { version: 1, requestId: input.requestId, fingerprint, partnerId: input.partnerId,
        partnerRevision: profile.revision.toString(), source: home, destination: copy(input.destination), capabilities: copy(capabilities),
        busyAction: input.busyAction, continueWhenSourceOffline: input.continueWhenSourceOffline,
        sourceSessionId: profile.sessionId, sourceSessionIds: [...new Set([profile.sessionId, ...this.runtime.sessions(input.partnerId)])],
        createdAt: at, updatedAt: at, phase: "waiting", resumePhase: "waiting", committed: false, sourceFenced: true };
      this.storage.save(move);
      void this.#run(move.requestId).catch(() => undefined); return move;
    });
  }
  async retry(requestId: string): Promise<PartnerHomeMoveRecord> {
    this.#assert(); const move = this.storage.move(requestId);
    if (!move) throw new PartnerHomeError("state-changed", "This Partner home change no longer exists.");
    if (move.phase === "ready") return move;
    return this.#run(requestId);
  }
  async recover(): Promise<void> {
    this.#assert();
    for (const move of this.storage.list()) if (move.phase !== "ready" && move.phase !== "needs-attention") {
      await this.#run(move.requestId);
    }
  }
  async #run(requestId: string): Promise<PartnerHomeMoveRecord> {
    const prior = this.#flights.get(requestId); if (prior) return prior;
    const flight = this.#advance(requestId); this.#flights.set(requestId, flight);
    try { return await flight; } finally { if (this.#flights.get(requestId) === flight) this.#flights.delete(requestId); }
  }
  async #advance(requestId: string): Promise<PartnerHomeMoveRecord> {
    let move = this.storage.move(requestId)!;
    const assertCurrent = () => {
      this.#assert(); const latest = this.storage.move(requestId), home = this.current(move.partnerId);
      const profile = this.runtime.profile(move.partnerId);
      if (!latest || latest.phase === "ready" || latest.fingerprint !== move.fingerprint || profile.lifecycle !== "active"
        || home.generation !== move.source.generation + (latest.committed ? 1 : 0)
        || this.storage.list().some(other => other.partnerId === move.partnerId && other.requestId !== requestId && other.sourceFenced && other.phase !== "ready")) {
        throw new PartnerHomeError("state-changed", "The Partner home change lost its owner.");
      }
      if (!latest.committed && (profile.revision.toString() !== move.partnerRevision || profile.sessionId !== move.sourceSessionId)) {
        throw new PartnerHomeError("state-changed", "The original Partner profile changed.");
      }
    };
    const save = (phase: PartnerHomeMoveRecord["resumePhase"]) => {
      move = { ...move, phase, resumePhase: phase, sourceFenced: true, updatedAt: this.#now() };
      const { failure: _failure, ...clean } = move; move = clean; this.storage.save(move);
    };
    try {
      assertCurrent();
      if (move.phase === "needs-attention") save(move.resumePhase);
      if (!move.committed) {
        if (!this.runtime.sourceAvailable(move.source)) {
          if (!move.continueWhenSourceOffline) throw new PartnerHomeError("source-unavailable", "The current execution computer is offline.");
        } else {
          if (move.busyAction === "stop" && move.resumePhase !== "preparing") { save("stopping"); await this.runtime.stop(move); assertCurrent(); }
          const deadline = this.#now() + (this.options.busyWaitMs ?? 4 * 60_000);
          while (await this.runtime.busy(move.partnerId)) {
            assertCurrent(); if (this.#now() >= deadline) throw new PartnerHomeError("busy", "The Partner is still working. Retry after it settles.");
            await (this.options.wait?.() ?? new Promise<void>(resolve => setTimeout(resolve, 2_000)));
          }
        }
        assertCurrent(); save("preparing");
        await this.runtime.assertDestination(move.destination, move.capabilities); assertCurrent();
        const historyThroughCursor = await this.runtime.prepare(move, assertCurrent); assertCurrent();
        if (!/^(0|[1-9][0-9]{0,19})$/u.test(historyThroughCursor)) throw new PartnerHomeError("preparation-failed", "The prepared history cursor is invalid.");
        move = { ...move, historyThroughCursor }; this.storage.save(move);
        move = this.storage.commit(move);
      }
      assertCurrent(); save("activating");
      const sessionId = await this.runtime.activate(move, assertCurrent); assertCurrent(); identity(sessionId);
      move = { ...move, phase: "ready", canonicalSessionId: sessionId, sourceFenced: false, updatedAt: this.#now() };
      this.storage.save(move); await this.runtime.settled?.(move); return move;
    } catch (error) {
      this.#assert();
      const failure = error instanceof PartnerHomeError ? error.code
        : outcomeUnknown(error instanceof OperationPreviouslyFailedError ? error.storedError : error)
          ? "outcome-unknown" : "preparation-failed";
      move = { ...move, phase: "needs-attention", failure, sourceFenced: move.committed || failure === "outcome-unknown", updatedAt: this.#now() };
      this.storage.save(move); await this.runtime.settled?.(move); return move;
    }
  }
  async close(): Promise<void> { this.#closed = true; await Promise.allSettled([...this.#flights.values()]); }
  #assert(): void { this.runtime.assertOwner(); if (this.#closed) throw new PartnerHomeError("state-changed", "The Partner home owner is closed."); }
  #now(): number { return this.options.now?.() ?? Date.now(); }
}
function outcomeUnknown(error: unknown): boolean { return typeof error === "object" && error !== null && "stateMayHaveChanged" in error && error.stateMayHaveChanged === true; }

function parseHome(value: unknown): PartnerHomeRecord {
  const row = record(value); exact(row, ["version", "partnerId", "generation", "location"]);
  if (row.version !== 1 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1) invalid();
  identity(String(row.partnerId)); parseLocation(row.location); return copy(value as PartnerHomeRecord);
}
function parseLocation(value: unknown): PartnerHomeLocation {
  const row = record(value);
  exact(row, row.kind === "service" ? ["kind", "deviceId", "name"] : ["kind", "deviceId", "controllerDeviceId", "name", "root"]);
  if (row.kind !== "service" && row.kind !== "device" || typeof row.deviceId !== "string" || typeof row.name !== "string"
    || !row.name.trim() || row.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(row.name)) invalid();
  identity(row.deviceId);
  if (row.kind === "device") {
    if (typeof row.controllerDeviceId !== "string" || typeof row.root !== "string" || !row.root || row.root.length > 16_384
      || /[\u0000\r\n]/u.test(row.root)) invalid();
    identity(row.controllerDeviceId);
  }
  return copy(value as PartnerHomeLocation);
}
function parseMove(value: unknown): PartnerHomeMoveRecord {
  const row = record(value); exact(row, ["version", "requestId", "fingerprint", "partnerId", "partnerRevision", "source", "destination", "capabilities",
    "busyAction", "continueWhenSourceOffline", "sourceSessionId", "sourceSessionIds", "createdAt", "updatedAt", "phase", "resumePhase", "committed", "sourceFenced"], ["canonicalSessionId", "historyThroughCursor", "failure"]);
  if (row.version !== 1 || typeof row.requestId !== "string" || typeof row.partnerId !== "string" || typeof row.sourceSessionId !== "string"
    || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.fingerprint)
    || typeof row.partnerRevision !== "string" || !/^[1-9][0-9]{0,18}$/u.test(row.partnerRevision)
    || !["wait", "stop"].includes(String(row.busyAction)) || typeof row.continueWhenSourceOffline !== "boolean"
    || !["waiting", "stopping", "preparing", "activating", "ready", "needs-attention"].includes(String(row.phase))
    || !["waiting", "stopping", "preparing", "activating"].includes(String(row.resumePhase))
    || typeof row.committed !== "boolean" || typeof row.sourceFenced !== "boolean"
    || !Number.isSafeInteger(row.createdAt) || Number(row.createdAt) < 0 || !Number.isSafeInteger(row.updatedAt) || Number(row.updatedAt) < Number(row.createdAt)
    || row.canonicalSessionId !== undefined && typeof row.canonicalSessionId !== "string"
    || row.historyThroughCursor !== undefined && (typeof row.historyThroughCursor !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(row.historyThroughCursor))
    || row.committed === true && row.historyThroughCursor === undefined
    || row.failure !== undefined && !["busy", "source-unavailable", "target-unavailable", "runtime-unavailable", "state-changed", "outcome-unknown", "preparation-failed"].includes(String(row.failure))) invalid();
  identity(row.requestId); identity(row.partnerId); identity(row.sourceSessionId); if (row.canonicalSessionId !== undefined) identity(row.canonicalSessionId);
  if (!Array.isArray(row.sourceSessionIds) || row.sourceSessionIds.length > 10_000 || !row.sourceSessionIds.includes(row.sourceSessionId)
    || row.sourceSessionIds.some(value => typeof value !== "string")) invalid();
  for (const sessionId of row.sourceSessionIds) identity(sessionId as string);
  const home = parseHome(row.source); if (home.partnerId !== row.partnerId) invalid(); parseLocation(row.destination);
  const capabilities = record(row.capabilities); exact(capabilities, ["modelChain", "permissionMode", "planMode", "inputHandoff"]);
  if (!Array.isArray(capabilities.modelChain) || capabilities.modelChain.length < 1 || capabilities.modelChain.length > 5
    || !["ask", "acceptEdits", "auto", "bypassPermissions"].includes(String(capabilities.permissionMode)) || typeof capabilities.planMode !== "boolean" || typeof capabilities.inputHandoff !== "boolean") invalid();
  for (const route of capabilities.modelChain) {
    const item = record(route); exact(item, ["backendId", "providerId", "modelId", "fastMode"], ["effort"]);
    if (["backendId", "providerId", "modelId"].some(key => typeof item[key] !== "string") || typeof item.fastMode !== "boolean"
      || item.effort !== undefined && typeof item.effort !== "string") invalid();
    for (const key of ["backendId", "providerId", "modelId"]) {
      const value = String(item[key]); if (!value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
    }
  }
  return copy(value as PartnerHomeMoveRecord);
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function invalid(): never { throw new PartnerHomeError("state-changed", "The Partner home record is invalid."); }
