import {
  DEFAULT_TOMBSTONE_TTL_MS,
  MAX_AUTOMATIC_CANDIDATE_RECORDS,
  addManualEntry,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  dictionaryTermKey,
  findMaxHlc,
  formatHlc,
  gcTombstones,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  normalizeDictionaryTermText,
  observeHlc,
  promoteEligibleDictionaryCandidates,
  pruneWeakAutomaticCandidates,
  recordLearningEvent,
  renameTerm,
  replaceTermAliases,
  termKeyFromMaterializedId,
  type HlcClock,
  type LearningEventInput,
  type MaterializedDictionary,
  type MutationResult,
  type VoiceDictionarySyncState
} from "@joko/voice-input";
import type { OperationalStore } from "@joko/store";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const VOICE_DICTIONARY_SYNC_SETTING_KEY = "voice_dictionary_sync.v1";

const SETTING_SCOPE_TYPE = "service" as const;
const SETTING_SCOPE_ID = "orchestrator";
const STORED_FORMAT = 1;
const MAXIMUM_EDIT_ALIASES = 8;
const MAXIMUM_STORED_PAYLOAD_CHARACTERS = 3_700_000;

interface StoredVoiceDictionarySyncEnvelope {
  readonly format: typeof STORED_FORMAT;
  readonly revision: number;
  readonly enabled: boolean;
  /** Hex current-v1 payload keeps arbitrary dictionary keys opaque to generic setting redaction. */
  readonly payload: string;
}

interface StoredVoiceDictionarySyncPayload {
  readonly replicaId: string;
  readonly clock: HlcClock;
  readonly state: VoiceDictionarySyncState;
}

interface VoiceDictionarySyncDocument extends StoredVoiceDictionarySyncPayload {
  readonly format: typeof STORED_FORMAT;
  readonly revision: number;
  readonly enabled: boolean;
}

export interface VoiceDictionarySyncSnapshot {
  readonly revision: number;
  readonly replicaId: string;
  readonly enabled: boolean;
  readonly dictionary: MaterializedDictionary;
}

export type VoiceDictionarySyncRepositoryErrorCode = "INVALID" | "CONFLICT" | "UNAVAILABLE";

export class VoiceDictionarySyncRepositoryError extends Error {
  constructor(
    readonly code: VoiceDictionarySyncRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VoiceDictionarySyncRepositoryError";
  }
}

export interface VoiceDictionarySyncRepositoryOptions {
  readonly store: OperationalStore;
  readonly now?: () => number;
  readonly createReplicaId?: () => string;
  readonly onChanged?: (snapshot: VoiceDictionarySyncSnapshot) => void;
}

/**
 * Owns the single durable current-v1 dictionary replica for this Joko node.
 * State and HLC clock are persisted in one SQLite setting before observers see
 * a new revision. Transport and UI projections consume this owner; they never
 * write the convergence state directly.
 */
export class VoiceDictionarySyncRepository {
  readonly #store: OperationalStore;
  readonly #now: () => number;
  readonly #onChanged: (snapshot: VoiceDictionarySyncSnapshot) => void;
  #document: VoiceDictionarySyncDocument;
  #mutating = false;
  #unavailable = false;

  constructor(options: VoiceDictionarySyncRepositoryOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#onChanged = options.onChanged ?? (() => undefined);
    const stored = this.#store.findSetting<unknown>(
      SETTING_SCOPE_TYPE,
      SETTING_SCOPE_ID,
      VOICE_DICTIONARY_SYNC_SETTING_KEY
    );
    if (stored === undefined) {
      const replicaId = (options.createReplicaId ?? randomUUID)();
      let clock: HlcClock;
      try {
        clock = createHlcClock(replicaId, this.#now());
      } catch (error) {
        throw unavailable("The Voice dictionary replica identity is invalid.", error);
      }
      const created: VoiceDictionarySyncDocument = {
        format: STORED_FORMAT,
        revision: 1,
        replicaId: clock.nodeId,
        enabled: false,
        clock,
        state: createEmptySyncState()
      };
      try {
        const persisted = this.#store.setSetting<StoredVoiceDictionarySyncEnvelope>(
          SETTING_SCOPE_TYPE,
          SETTING_SCOPE_ID,
          VOICE_DICTIONARY_SYNC_SETTING_KEY,
          encodeStoredDocument(created),
          this.#now()
        );
        this.#document = decodeStoredDocument(persisted.value);
      } catch (error) {
        throw unavailable("The Voice dictionary replica could not be created.", error);
      }
      return;
    }
    try {
      this.#document = decodeStoredDocument(stored.value);
    } catch (error) {
      throw unavailable("The saved Voice dictionary replica is unavailable.", error);
    }
  }

  snapshot(): VoiceDictionarySyncSnapshot {
    this.#assertAvailable();
    return snapshotOf(this.#document);
  }

  /** Returns a detached, revalidated state suitable for an authenticated peer frame. */
  stateForSync(): VoiceDictionarySyncState {
    this.#assertAvailable();
    let detached: unknown;
    try {
      detached = JSON.parse(JSON.stringify(this.#document.state)) as unknown;
    } catch (error) {
      throw unavailable("The Voice dictionary state could not be serialized.", error);
    }
    if (!isValidSyncState(detached)) {
      throw unavailable("The Voice dictionary state failed its persistence boundary validation.");
    }
    return detached;
  }

  setEnabled(expectedRevision: number, enabled: boolean): VoiceDictionarySyncSnapshot {
    if (typeof enabled !== "boolean") throw invalid("Voice dictionary sync enabled must be a boolean.");
    return this.#change(expectedRevision, (current) => current.enabled === enabled
      ? undefined
      : { ...current, enabled });
  }

  addManualTerm(expectedRevision: number, text: string): VoiceDictionarySyncSnapshot {
    const normalized = requireTerm(text);
    return this.#mutateState(expectedRevision, (state, clock, nowMs) =>
      addManualEntry(state, clock, { text: normalized, nowMs }));
  }

  learn(
    expectedRevision: number,
    input: Omit<LearningEventInput, "nowMs">
  ): VoiceDictionarySyncSnapshot {
    const text = requireTerm(input.text);
    const aliases = requireAliases(input.aliases ?? []);
    if (input.stage !== "candidate" && input.stage !== "entry") {
      throw invalid("Voice dictionary learning stage is invalid.");
    }
    return this.#mutateState(expectedRevision, (state, clock, nowMs) =>
      recordLearningEvent(state, clock, { text, aliases: [...aliases], stage: input.stage, nowMs }));
  }

  editEntry(
    expectedRevision: number,
    input: { readonly entryId: string; readonly text: string; readonly aliases: readonly string[] }
  ): VoiceDictionarySyncSnapshot {
    const normalizedId = input.entryId.trim();
    if (normalizedId === "") throw invalid("Voice dictionary entry identity is required.");
    if (input.text.trim() === "") return this.deleteEntry(expectedRevision, normalizedId);
    const text = requireTerm(input.text);
    const aliases = requireAliases(input.aliases);
    return this.#mutateState(expectedRevision, (state, clock, nowMs) => {
      const sourceKey = termKeyFromMaterializedId(state, normalizedId);
      if (sourceKey === null) return { state, clock, changed: false };
      const renamed = renameTerm(state, clock, { termKey: sourceKey, nextText: text, nowMs });
      const targetKey = dictionaryTermKey(text);
      const replaced = replaceTermAliases(renamed.state, renamed.clock, {
        termKey: targetKey,
        primaryText: text,
        aliases: [...aliases],
        nowMs
      });
      return {
        state: replaced.state,
        clock: replaced.clock,
        changed: renamed.changed || replaced.changed
      };
    });
  }

  deleteEntry(expectedRevision: number, entryId: string): VoiceDictionarySyncSnapshot {
    const normalizedId = entryId.trim();
    if (normalizedId === "") throw invalid("Voice dictionary entry identity is required.");
    return this.#mutateState(expectedRevision, (state, clock, nowMs) => {
      const key = termKeyFromMaterializedId(state, normalizedId);
      return key === null
        ? { state, clock, changed: false }
        : deleteTerms(state, clock, { termKeys: [key], nowMs });
    });
  }

  mergeRemote(raw: unknown): VoiceDictionarySyncSnapshot {
    if (!isValidSyncState(raw)) throw invalid("Voice dictionary peer state is invalid.");
    return this.#exclusive(() => {
      const current = this.#document;
      if (!current.enabled) return snapshotOf(current);
      const merged = mergeSyncStates(current.state, raw);
      if (sameSyncState(merged, current.state)) return snapshotOf(current);
      const maxRemote = findMaxHlc(raw);
      const clock = maxRemote === null
        ? current.clock
        : observeHlc(current.clock, maxRemote, this.#now());
      const maintained = maintainState({ state: merged, clock, changed: true }, this.#now());
      return this.#persist({
        ...current,
        revision: nextRevision(current.revision),
        clock: maintained.clock,
        state: maintained.state
      });
    });
  }

  #mutateState(
    expectedRevision: number,
    mutate: (state: VoiceDictionarySyncState, clock: HlcClock, nowMs: number) => MutationResult
  ): VoiceDictionarySyncSnapshot {
    return this.#change(expectedRevision, (current) => {
      const nowMs = this.#now();
      let result: MutationResult;
      try {
        result = mutate(current.state, current.clock, nowMs);
        if (!result.changed) return undefined;
        result = maintainState(result, nowMs);
      } catch (error) {
        if (error instanceof VoiceDictionarySyncRepositoryError) throw error;
        throw invalid("Voice dictionary mutation is invalid.", error);
      }
      return { ...current, clock: result.clock, state: result.state };
    });
  }

  #change(
    expectedRevision: number,
    update: (current: VoiceDictionarySyncDocument) => VoiceDictionarySyncDocument | undefined
  ): VoiceDictionarySyncSnapshot {
    assertExpectedRevision(expectedRevision);
    return this.#exclusive(() => {
      const current = this.#document;
      if (current.revision !== expectedRevision) {
        throw new VoiceDictionarySyncRepositoryError(
          "CONFLICT",
          "Voice dictionary state changed before this mutation was applied."
        );
      }
      const updated = update(current);
      if (updated === undefined) return snapshotOf(current);
      return this.#persist({ ...updated, revision: nextRevision(current.revision) });
    });
  }

  #persist(next: VoiceDictionarySyncDocument): VoiceDictionarySyncSnapshot {
    let readBack: VoiceDictionarySyncDocument;
    try {
      assertCurrentDocument(next);
      const persisted = this.#store.setSetting<StoredVoiceDictionarySyncEnvelope>(
        SETTING_SCOPE_TYPE,
        SETTING_SCOPE_ID,
        VOICE_DICTIONARY_SYNC_SETTING_KEY,
        encodeStoredDocument(next),
        this.#now()
      );
      try {
        readBack = decodeStoredDocument(persisted.value);
      } catch (error) {
        this.#unavailable = true;
        throw error;
      }
      if (!sameDocument(readBack, next)) {
        this.#unavailable = true;
        throw new Error("Voice dictionary persistence readback did not match the committed state.");
      }
    } catch (error) {
      if (error instanceof VoiceDictionarySyncRepositoryError) throw error;
      throw unavailable("The Voice dictionary state could not be persisted.", error);
    }
    this.#document = readBack;
    const snapshot = snapshotOf(readBack);
    try {
      this.#onChanged(snapshot);
    } catch {
      // Observers never own the durable commit and cannot roll it back.
    }
    return snapshot;
  }

  #exclusive<T>(run: () => T): T {
    this.#assertAvailable();
    if (this.#mutating) {
      throw unavailable("A Voice dictionary mutation is already being committed.");
    }
    this.#mutating = true;
    try {
      return run();
    } finally {
      this.#mutating = false;
    }
  }

  #assertAvailable(): void {
    if (this.#unavailable) {
      throw unavailable("The Voice dictionary persistence outcome is unavailable until the service restarts.");
    }
  }
}

function maintainState(result: MutationResult, nowMs: number): MutationResult {
  let maintained = promoteEligibleDictionaryCandidates(result.state, result.clock, nowMs);
  maintained = pruneWeakAutomaticCandidates(maintained.state, maintained.clock, {
    maxRecords: MAX_AUTOMATIC_CANDIDATE_RECORDS,
    nowMs
  });
  const state = gcTombstones(maintained.state, { nowMs, ttlMs: DEFAULT_TOMBSTONE_TTL_MS });
  const next = { state, clock: maintained.clock, changed: true };
  if (!isValidSyncState(next.state)) throw invalid("Voice dictionary state exceeds its current-v1 persistence boundary.");
  return next;
}

function snapshotOf(document: VoiceDictionarySyncDocument): VoiceDictionarySyncSnapshot {
  return Object.freeze({
    revision: document.revision,
    replicaId: document.replicaId,
    enabled: document.enabled,
    dictionary: materializeDictionary(document.state)
  });
}

function sameSyncState(left: VoiceDictionarySyncState, right: VoiceDictionarySyncState): boolean {
  // JSON persistence deliberately erases null-prototype dictionary maps. Their
  // prototypes are an implementation detail, not new convergence information.
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)) as unknown,
    JSON.parse(JSON.stringify(right)) as unknown
  );
}

function encodeStoredDocument(document: VoiceDictionarySyncDocument): StoredVoiceDictionarySyncEnvelope {
  assertCurrentDocument(document);
  const payload: StoredVoiceDictionarySyncPayload = {
    replicaId: document.replicaId,
    clock: document.clock,
    state: document.state
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
  if (encoded.length > MAXIMUM_STORED_PAYLOAD_CHARACTERS) {
    throw invalid("Voice dictionary persistence payload is too large.");
  }
  return {
    format: STORED_FORMAT,
    revision: document.revision,
    enabled: document.enabled,
    payload: encoded
  };
}

function decodeStoredDocument(raw: unknown): VoiceDictionarySyncDocument {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ["enabled", "format", "payload", "revision"])) {
    throw invalid("Voice dictionary persistence shape is invalid.");
  }
  if (raw["format"] !== STORED_FORMAT || typeof raw["enabled"] !== "boolean"
    || !isPositiveSafeInteger(raw["revision"]) || typeof raw["payload"] !== "string"
    || raw["payload"].length === 0 || raw["payload"].length > MAXIMUM_STORED_PAYLOAD_CHARACTERS
    || !/^(?:[0-9a-f]{2})+$/u.test(raw["payload"])) {
    throw invalid("Voice dictionary persistence metadata is invalid.");
  }
  let decoded: string;
  try {
    const bytes = Buffer.from(raw["payload"], "hex");
    if (bytes.toString("hex") !== raw["payload"]) throw new Error("Non-canonical hex payload.");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid("Voice dictionary persistence payload is invalid.", error);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decoded) as unknown;
  } catch (error) {
    throw invalid("Voice dictionary persistence payload is invalid.", error);
  }
  if (!isPlainRecord(payload) || !hasExactKeys(payload, ["clock", "replicaId", "state"])
    || typeof payload["replicaId"] !== "string") {
    throw invalid("Voice dictionary persistence payload shape is invalid.");
  }
  const document: VoiceDictionarySyncDocument = {
    format: STORED_FORMAT,
    revision: raw["revision"],
    enabled: raw["enabled"],
    replicaId: payload["replicaId"],
    clock: payload["clock"] as HlcClock,
    state: payload["state"] as VoiceDictionarySyncState
  };
  assertCurrentDocument(document);
  return document;
}

function assertCurrentDocument(raw: unknown): asserts raw is VoiceDictionarySyncDocument {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ["clock", "enabled", "format", "replicaId", "revision", "state"])) {
    throw invalid("Voice dictionary current document shape is invalid.");
  }
  if (raw["format"] !== STORED_FORMAT || typeof raw["enabled"] !== "boolean"
    || !isPositiveSafeInteger(raw["revision"]) || typeof raw["replicaId"] !== "string") {
    throw invalid("Voice dictionary current document metadata is invalid.");
  }
  const clock = raw["clock"];
  if (!isPlainRecord(clock) || !hasExactKeys(clock, ["counter", "nodeId", "wallMs"])
    || typeof clock["nodeId"] !== "string" || clock["nodeId"] !== raw["replicaId"]
    || typeof clock["wallMs"] !== "number" || typeof clock["counter"] !== "number") {
    throw invalid("Voice dictionary persisted clock is invalid.");
  }
  try {
    formatHlc(clock as unknown as HlcClock);
  } catch (error) {
    throw invalid("Voice dictionary persisted clock is invalid.", error);
  }
  const state = raw["state"];
  if (!isValidSyncState(state)) throw invalid("Voice dictionary persisted state is invalid.");
  const maximum = findMaxHlc(state);
  if (maximum !== null) {
    const observed = observeHlc(clock as unknown as HlcClock, maximum, clock["wallMs"]);
    if (observed.wallMs !== clock["wallMs"] || observed.counter !== clock["counter"]) {
      throw invalid("Voice dictionary persisted clock does not cover its state.");
    }
  }
}

function sameDocument(left: VoiceDictionarySyncDocument, right: VoiceDictionarySyncDocument): boolean {
  return left.format === right.format
    && left.revision === right.revision
    && left.enabled === right.enabled
    && left.replicaId === right.replicaId
    && left.clock.wallMs === right.clock.wallMs
    && left.clock.counter === right.clock.counter
    && left.clock.nodeId === right.clock.nodeId
    && sameSyncState(left.state, right.state);
}

function requireTerm(value: unknown): string {
  const normalized = normalizeDictionaryTermText(value);
  if (normalized === "") throw invalid("Voice dictionary term is invalid.");
  return normalized;
}

function requireAliases(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > MAXIMUM_EDIT_ALIASES) {
    throw invalid("Voice dictionary aliases are invalid.");
  }
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = requireTerm(value);
    const key = dictionaryTermKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(text);
  }
  return aliases;
}

function assertExpectedRevision(value: number): void {
  if (!isPositiveSafeInteger(value)) throw invalid("Voice dictionary revision is invalid.");
}

function nextRevision(value: number): number {
  if (!isPositiveSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw unavailable("Voice dictionary revision is exhausted.");
  }
  return value + 1;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function invalid(message: string, cause?: unknown): VoiceDictionarySyncRepositoryError {
  return new VoiceDictionarySyncRepositoryError("INVALID", message, cause === undefined ? undefined : { cause });
}

function unavailable(message: string, cause?: unknown): VoiceDictionarySyncRepositoryError {
  return new VoiceDictionarySyncRepositoryError("UNAVAILABLE", message, cause === undefined ? undefined : { cause });
}
