import { OperationalStore } from "@joko/store";
import {
  addManualEntry,
  DEFAULT_MATERIALIZE_LIMITS,
  createEmptySyncState,
  createHlcClock,
  formatHlc,
  materializeDictionary,
  recordLearningEvent
} from "@joko/voice-input";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { mkdtemp } from "./test-paths.js";
import {
  VOICE_DICTIONARY_SYNC_SETTING_KEY,
  VoiceDictionarySyncRepository,
  VoiceDictionarySyncRepositoryError
} from "./voice-dictionary-sync-repository.js";

async function fixture(now = 1_900_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), "joko-voice-dictionary-sync-"));
  const path = join(root, "orchestrator.db");
  const store = new OperationalStore(path, { now: () => now });
  return { path, store };
}

it("retires subscribers before its store closes and rejects every later projection or mutation", async () => {
  const { store } = await fixture();
  const repository = new VoiceDictionarySyncRepository({ store });
  const changed = vi.fn(() => { expect(() => repository.snapshot()).toThrow(VoiceDictionarySyncRepositoryError); });
  repository.subscribe(changed);
  repository.close();
  repository.close();
  expect(changed).toHaveBeenCalledOnce();
  store.close();
  expect(() => repository.snapshot()).toThrow(VoiceDictionarySyncRepositoryError);
  expect(() => repository.addManualTerms(1, ["Retired"])).toThrow(VoiceDictionarySyncRepositoryError);
  expect(() => repository.subscribe(changed)).toThrow(VoiceDictionarySyncRepositoryError);
});

it("persists disabled empty sharing projections and their causal baseline across restart and clock rollback", async () => {
  const { path, store } = await fixture();
  const repository = new VoiceDictionarySyncRepository({ store, createReplicaId: () => "dictionary-source", now: () => 1_900_000_000_000 });
  expect(repository.readOnlySnapshot()).toEqual({ revision: 1, enabled: false, entries: [], stateVector: {} });
  repository.addManualTerm(1, "Joko");
  repository.learn(2, { text: "Joko", aliases: ["jo ko"], stage: "entry" });
  repository.setEnabled(3, true);
  const shared = repository.readOnlySnapshot();
  expect(shared.entries).toMatchObject([{ text: "Joko", frequency: 2, aliases: [{ text: "jo ko", count: 1 }] }]);
  repository.setEnabled(4, false);
  const off = repository.readOnlySnapshot();
  expect(off).toEqual({ ...shared, revision: 5, enabled: false, entries: [] });
  repository.close(); store.close();
  const reopened = new OperationalStore(path);
  try {
    const restored = new VoiceDictionarySyncRepository({ store: reopened, now: () => 100,
      createReplicaId: () => { throw new Error("Must retain the durable replica."); } });
    expect(restored.readOnlySnapshot()).toEqual(off);
    expect(restored.snapshot().dictionary.entries).toMatchObject([{ text: "Joko" }]);
    restored.addManualTerm(5, "OfflineTerm");
    expect(restored.readOnlySnapshot()).toMatchObject({ revision: 6, enabled: false, entries: [] });
    expect(restored.readOnlySnapshot().stateVector["dictionary-source"]! > off.stateVector["dictionary-source"]!).toBe(true);
    restored.setEnabled(6, true);
    expect(restored.readOnlySnapshot().entries.map((entry) => entry.text).sort()).toEqual(["Joko", "OfflineTerm"]);
    restored.close();
  } finally { reopened.close(); }
});

function stored(store: OperationalStore): Record<string, unknown> {
  return store.getSetting<Record<string, unknown>>(
    "service",
    "orchestrator",
    VOICE_DICTIONARY_SYNC_SETTING_KEY
  ).value;
}

function storedPayload(store: OperationalStore): Record<string, unknown> {
  const payload = stored(store)["payload"];
  if (typeof payload !== "string") throw new Error("Missing persisted Voice dictionary payload.");
  return JSON.parse(Buffer.from(payload, "hex").toString("utf8")) as Record<string, unknown>;
}

function withStoredPayload(
  document: Record<string, unknown>,
  update: (payload: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  const payload = document["payload"];
  if (typeof payload !== "string") throw new Error("Missing persisted Voice dictionary payload.");
  const decoded = JSON.parse(Buffer.from(payload, "hex").toString("utf8")) as Record<string, unknown>;
  return {
    ...document,
    payload: Buffer.from(JSON.stringify(update(decoded)), "utf8").toString("hex")
  };
}

describe("VoiceDictionarySyncRepository", () => {
  it("persists one replica identity, clock and state before publishing, then restores them after close/reopen", async () => {
    const { path, store } = await fixture();
    let now = 1_900_000_000_000;
    const published: Array<{ revision: number; persistedRevision: number }> = [];
    const repository = new VoiceDictionarySyncRepository({
      store,
      now: () => now,
      createReplicaId: () => "voice-replica-a",
      onChanged: (snapshot) => published.push({
        revision: snapshot.revision,
        persistedRevision: stored(store)["revision"] as number
      })
    });

    expect(repository.snapshot()).toEqual({
      revision: 1,
      replicaId: "voice-replica-a",
      enabled: false,
      dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] },
      refinementTerms: []
    });
    expect(Object.keys(stored(store)).sort()).toEqual([
      "enabled", "format", "payload", "revision"
    ]);

    const enabled = repository.setEnabled(1, true);
    now += 1;
    const added = repository.addManualTerm(enabled.revision, "  Constructor  ");
    now += 1;
    const sensitiveFieldName = repository.addManualTerm(added.revision, "password");
    now += 1;
    const learned = repository.learn(sensitiveFieldName.revision, {
      text: "VoiceKit",
      aliases: ["voice kit"],
      stage: "candidate"
    });
    expect(learned.dictionary).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ text: "Constructor", source: "manual", frequency: 1 }),
        expect.objectContaining({ text: "password", source: "manual", frequency: 1 })
      ]),
      candidates: [{ text: "VoiceKit", evidenceCount: 1 }]
    });
    expect(published).toEqual([
      { revision: 2, persistedRevision: 2 },
      { revision: 3, persistedRevision: 3 },
      { revision: 4, persistedRevision: 4 },
      { revision: 5, persistedRevision: 5 }
    ]);
    const beforeClose = stored(store);
    const detached = repository.stateForSync();
    detached.records = Object.create(null) as typeof detached.records;
    expect(repository.snapshot().dictionary.entries).toHaveLength(2);
    store.close();

    const reopenedStore = new OperationalStore(path, { now: () => now });
    try {
      const reopened = new VoiceDictionarySyncRepository({
        store: reopenedStore,
        now: () => now,
        createReplicaId: () => "must-not-replace-existing-replica"
      });
      expect(reopened.snapshot()).toEqual(learned);
      expect(stored(reopenedStore)).toEqual(beforeClose);
      expect((storedPayload(reopenedStore)["clock"] as Record<string, unknown>)["nodeId"]).toBe("voice-replica-a");
    } finally {
      reopenedStore.close();
    }
  });

  it("keeps the previous durable revision when a write fails and rejects stale callers", async () => {
    const { store } = await fixture();
    const published = vi.fn();
    const repository = new VoiceDictionarySyncRepository({
      store,
      now: () => 1_900_000_000_000,
      createReplicaId: () => "voice-replica-write",
      onChanged: published
    });
    const before = repository.snapshot();
    const durableBefore = stored(store);
    const setSetting = store.setSetting.bind(store);
    const failure = vi.spyOn(store, "setSetting").mockImplementation((scopeType, scopeId, key, value, updatedAt) => {
      if (key === VOICE_DICTIONARY_SYNC_SETTING_KEY) throw new Error("injected SQLite write failure");
      return setSetting(scopeType, scopeId, key, value, updatedAt);
    });
    try {
      expect(() => repository.addManualTerm(before.revision, "VoiceKit"))
        .toThrow(expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "UNAVAILABLE" }));
    } finally {
      failure.mockRestore();
    }
    expect(repository.snapshot()).toEqual(before);
    expect(stored(store)).toEqual(durableBefore);
    expect(published).not.toHaveBeenCalled();

    const committed = repository.addManualTerm(before.revision, "VoiceKit");
    expect(committed.revision).toBe(before.revision + 1);
    expect(() => repository.addManualTerm(before.revision, "stale"))
      .toThrow(expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "CONFLICT" }));
    expect(repository.snapshot()).toEqual(committed);

    const uncertain = vi.spyOn(store, "setSetting").mockImplementation((scopeType, scopeId, key, value, updatedAt) => {
      if (key !== VOICE_DICTIONARY_SYNC_SETTING_KEY) return setSetting(scopeType, scopeId, key, value, updatedAt);
      const envelope = value as Record<string, unknown>;
      return setSetting(scopeType, scopeId, key, {
        ...envelope,
        revision: (envelope["revision"] as number) + 1
      }, updatedAt);
    });
    try {
      expect(() => repository.addManualTerm(committed.revision, "uncertain"))
        .toThrow(expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "UNAVAILABLE" }));
    } finally {
      uncertain.mockRestore();
    }
    expect(() => repository.snapshot())
      .toThrow(expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "UNAVAILABLE" }));
    expect(published).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("merges a valid peer state once, observes its clock, ignores duplicate delivery and stays silent while disabled", async () => {
    const { path, store } = await fixture();
    let now = 1_900_000_000_000;
    const published = vi.fn();
    const repository = new VoiceDictionarySyncRepository({
      store,
      now: () => now,
      createReplicaId: () => "voice-replica-local",
      onChanged: published
    });
    const enabled = repository.setEnabled(repository.snapshot().revision, true);

    const remoteClock = createHlcClock("voice-replica-remote", now + 10_000);
    const remote = addManualEntry(createEmptySyncState(), remoteClock, {
      text: "__proto__",
      nowMs: now + 10_000
    });
    now += 20_000;
    const merged = repository.mergeRemote(remote.state);
    expect(merged.revision).toBe(enabled.revision + 1);
    expect(merged.dictionary.entries).toMatchObject([{ text: "__proto__", source: "manual" }]);
    const persistedClock = storedPayload(store)["clock"] as { wallMs: number; counter: number; nodeId: string };
    expect(persistedClock.wallMs).toBeGreaterThanOrEqual(remote.clock.wallMs);
    expect(formatHlc(persistedClock)).toBeTruthy();
    expect(repository.mergeRemote(JSON.parse(JSON.stringify(remote.state)))).toEqual(merged);
    expect(repository.snapshot().revision).toBe(merged.revision);

    const disabled = repository.setEnabled(merged.revision, false);
    const another = recordLearningEvent(remote.state, remote.clock, {
      text: "late peer term",
      aliases: ["late alias"],
      stage: "entry",
      nowMs: now + 1
    });
    expect(repository.mergeRemote(another.state)).toEqual(disabled);
    expect(() => repository.mergeRemote({ version: 1 })).toThrow(
      expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "INVALID" })
    );
    expect(repository.snapshot().revision).toBe(disabled.revision);
    expect(published).toHaveBeenCalledTimes(3);
    store.close();

    const reopenedStore = new OperationalStore(path, { now: () => now });
    try {
      expect(new VoiceDictionarySyncRepository({ store: reopenedStore }).snapshot()).toEqual(disabled);
    } finally {
      reopenedStore.close();
    }
  });

  it("rejects unknown, extra-field and clock-behind persistence without replacing it", async () => {
    const variants: Array<(document: Record<string, unknown>) => Record<string, unknown>> = [
      (document) => ({ ...document, format: 2 }),
      (document) => ({ ...document, unexpected: true }),
      (document) => withStoredPayload(document, (payload) => ({
        ...payload,
        clock: { ...(payload["clock"] as object), wallMs: 0, counter: 0 }
      }))
    ];
    for (const [index, change] of variants.entries()) {
      const { store } = await fixture(1_900_000_000_000 + index);
      const repository = new VoiceDictionarySyncRepository({
        store,
        now: () => 1_900_000_000_000 + index,
        createReplicaId: () => `voice-replica-invalid-${index}`
      });
      const withState = repository.addManualTerm(repository.snapshot().revision, "VoiceKit");
      expect(withState.dictionary.entries).toHaveLength(1);
      const tampered = change(stored(store));
      store.setSetting("service", "orchestrator", VOICE_DICTIONARY_SYNC_SETTING_KEY, tampered);
      expect(() => new VoiceDictionarySyncRepository({ store })).toThrow(
        expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "UNAVAILABLE" })
      );
      expect(stored(store)).toEqual(tampered);
      store.close();
    }
  });

  it("commits rename, alias replacement and automatic suppression as one revision each", async () => {
    const { store } = await fixture();
    let now = 1_900_000_000_000;
    const repository = new VoiceDictionarySyncRepository({
      store,
      now: () => now,
      createReplicaId: () => "voice-replica-edit"
    });
    const automatic = repository.learn(repository.snapshot().revision, {
      text: "VoiceKit",
      aliases: ["voice kit"],
      stage: "entry"
    });
    now += 1;
    const entry = automatic.dictionary.entries[0]!;
    const edited = repository.editEntry(automatic.revision, {
      entryId: entry.id,
      text: "Voice Kit",
      aliases: ["VoiceKit", "spoken voice kit"]
    });
    expect(edited.revision).toBe(automatic.revision + 1);
    expect(edited.dictionary.entries).toMatchObject([{
      text: "Voice Kit",
      source: "manual"
    }]);
    expect(edited.dictionary.entries[0]!.aliases.map((alias) => alias.text).sort())
      .toEqual(["VoiceKit", "spoken voice kit"]);
    now += 1;
    const deleted = repository.deleteEntry(edited.revision, edited.dictionary.entries[0]!.id);
    expect(deleted.revision).toBe(edited.revision + 1);
    expect(deleted.dictionary.entries).toEqual([]);
    expect(deleted.dictionary.suppressedAutomaticTexts).toEqual([]);
    expect(repository.deleteEntry(deleted.revision, entry.id)).toEqual(deleted);
    store.close();
  });

  it("commits bounded manual imports and learning actions once and projects refinement terms", async () => {
    const { store } = await fixture();
    let now = 1_900_000_000_000;
    const published = vi.fn();
    const repository = new VoiceDictionarySyncRepository({
      store,
      now: () => now,
      createReplicaId: () => "voice-replica-batch",
      onChanged: published
    });
    const imported = repository.addManualTerms(repository.snapshot().revision, ["Joko", "Orchestrator", "joko"]);
    expect(imported.revision).toBe(2);
    expect(imported.dictionary.entries.map((entry) => entry.text).sort()).toEqual(["Joko", "Orchestrator"]);
    expect(imported.refinementTerms).toEqual(expect.arrayContaining(["Joko", "Orchestrator"]));

    now += 1;
    const learned = repository.applyLearning(imported.revision, [{
      text: "VoiceKit",
      aliases: ["voice kit"],
      stage: "candidate"
    }, {
      text: "Joko",
      aliases: ["jo ko"],
      stage: "entry"
    }]);
    expect(learned.revision).toBe(3);
    expect(learned.dictionary.candidates).toMatchObject([{ text: "VoiceKit", evidenceCount: 1 }]);
    expect(learned.dictionary.entries.find((entry) => entry.text === "Joko")).toMatchObject({ frequency: 2 });
    expect(published).toHaveBeenCalledTimes(2);
    expect(() => repository.applyLearning(learned.revision, Array.from({ length: 4 }, () => ({
      text: "overflow",
      aliases: ["over flow"],
      stage: "candidate" as const
    })))).toThrow(expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "INVALID" }));
    expect(repository.snapshot()).toEqual(learned);
    store.close();
  });
  it("edits source aliases before merging into a destination with independent alias evidence", async () => {
    const { store } = await fixture();
    try {
      const repository = new VoiceDictionarySyncRepository({ store });
      let current = repository.setEnabled(1, true);
      current = repository.addManualTerms(current.revision, ["Source", "Destination"]);
      current = repository.learn(current.revision, { text: "Source", aliases: ["source kept", "source removed"], stage: "entry" });
      current = repository.learn(current.revision, { text: "Destination", aliases: ["destination alias"], stage: "entry" });
      const source = current.dictionary.entries.find((entry) => entry.text === "Source")!;
      const stale = repository.stateForSync();
      const edited = repository.editEntry(current.revision, { entryId: source.id, text: "Destination", aliases: ["source kept"] });
      expect(edited.revision).toBe(current.revision + 1);
      expect(edited.dictionary.entries).toMatchObject([{ text: "Destination", frequency: 4 }]);
      expect(edited.dictionary.entries[0]!.aliases.map((alias) => alias.text).sort()).toEqual(["destination alias", "source kept"]);
      expect(repository.mergeRemote(stale).dictionary.entries[0]!.aliases.map((alias) => alias.text).sort()).toEqual(["destination alias", "source kept"]);
    } finally { store.close(); }
  });

  it("preserves unseen aliases on unchanged saves and renames, but honors an explicit replacement under stale replay", async () => {
    const { store } = await fixture();
    try {
      let now = 1_900_000_000_000;
      const repository = new VoiceDictionarySyncRepository({ store, now: () => now });
      let current = repository.setEnabled(1, true);
      current = repository.addManualTerm(current.revision, "Canonical");
      const allAliases = Array.from({ length: 9 }, (_value, index) => `alias ${index}`);
      current = repository.learn(current.revision, { text: "Canonical", aliases: allAliases.slice(0, 8), stage: "entry" });
      now += 1;
      current = repository.learn(current.revision, { text: "Canonical", aliases: allAliases.slice(8), stage: "entry" });
      const entry = current.dictionary.entries[0]!;
      expect(entry.aliases).toHaveLength(8);
      const visible = entry.aliases.map((alias) => alias.text);
      const fullAliases = () => materializeDictionary(repository.stateForSync(), {
        ...DEFAULT_MATERIALIZE_LIMITS, maxAliases: Number.MAX_SAFE_INTEGER
      }).entries[0]!.aliases.map((alias) => alias.text).sort();
      expect(fullAliases()).toEqual(allAliases);
      const saved = repository.editEntry(current.revision, { entryId: entry.id, text: entry.text, aliases: visible });
      expect(saved.revision).toBe(current.revision);
      expect(fullAliases()).toEqual(allAliases);
      const renamed = repository.editEntry(saved.revision, { entryId: entry.id, text: "Renamed", aliases: visible });
      expect(fullAliases()).toEqual(allAliases);
      const stale = repository.stateForSync();
      const replaced = repository.editEntry(renamed.revision, { entryId: renamed.dictionary.entries[0]!.id, text: "Renamed", aliases: ["new alias"] });
      expect(replaced.dictionary.entries[0]!.aliases.map((alias) => alias.text)).toEqual(["new alias"]);
      repository.mergeRemote(stale);
      expect(fullAliases()).toEqual(["new alias"]);
    } finally { store.close(); }
  });

  it("rejects a manual batch that would hide entries beyond the service projection limit", async () => {
    const { store } = await fixture();
    try {
      const repository = new VoiceDictionarySyncRepository({ store });
      const full = repository.addManualTerms(1, Array.from({ length: 1_000 }, (_value, index) => `Term ${index}`));
      expect(full.dictionary.entries).toHaveLength(1_000);
      expect(() => repository.addManualTerms(full.revision, ["Term 0", "Overflow"]))
        .toThrow(expect.objectContaining<Partial<VoiceDictionarySyncRepositoryError>>({ code: "INVALID" }));
      expect(repository.snapshot()).toEqual(full);
    } finally { store.close(); }
  });
});
