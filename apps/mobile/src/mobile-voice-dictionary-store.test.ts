import { describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryStore, mobileVoiceDictionaryStoreTesting } from "./mobile-voice-dictionary-store";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; }),
    read: () => value
  };
}

function store(storage = memoryStorage()) {
  let now = 10;
  let id = 0;
  return {
    storage,
    value: new MobileVoiceDictionaryStore(storage, () => now++, () => `id-${++id}`)
  };
}

describe("MobileVoiceDictionaryStore", () => {
  it("hydrates only the strict current-v1 record and explicitly recovers damaged data", async () => {
    const damaged = store(memoryStorage(JSON.stringify({ version: 0, dictionaryTerms: ["legacy"] })));
    await damaged.value.hydrate();
    expect(damaged.value.snapshot).toMatchObject({ status: "error", saving: false });
    expect(damaged.value.snapshot.document.dictionary.entries).toEqual([]);
    await damaged.value.reset();
    expect(damaged.value.snapshot).toMatchObject({ status: "ready", saving: false });
    expect(JSON.parse(damaged.storage.read()!)).toMatchObject({
      version: 1,
      revision: 1,
      dictionaryRevision: 1,
      refinementInstructions: "",
      autoLearningEnabled: true
    });
  });

  it("retries a transient read failure without overwriting device-local data", async () => {
    let attempts = 0;
    const source = store({
      getItem: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporarily locked");
        return null;
      }),
      setItem: vi.fn(async () => undefined),
      read: () => null
    });
    await source.value.hydrate();
    expect(source.value.snapshot.status).toBe("error");
    await source.value.retryHydrate();
    expect(source.value.snapshot.status).toBe("ready");
    expect(source.storage.setItem).not.toHaveBeenCalled();
  });

  it("persists content before publishing it and serializes manual mutations", async () => {
    const current = store();
    await current.value.hydrate();
    const published: number[] = [];
    current.value.subscribe(() => {
      const snapshot = current.value.snapshot;
      if (!snapshot.saving && snapshot.document.revision > 0) {
        expect(JSON.parse(current.storage.read()!).revision).toBe(snapshot.document.revision);
        published.push(snapshot.document.revision);
      }
    });
    await Promise.all([
      current.value.setRefinementInstructions(" Keep commands verbatim. "),
      current.value.addManualTerm("VoiceKit")
    ]);
    expect(current.value.snapshot.document).toMatchObject({
      revision: 2,
      dictionaryRevision: 2,
      refinementInstructions: "Keep commands verbatim."
    });
    expect(current.value.snapshot.document.dictionary.entries).toMatchObject([{
      text: "VoiceKit", source: "manual", frequency: 1
    }]);
    expect(published).toEqual([1, 2]);
  });

  it("keeps automatic suppression until deliberate manual re-add", async () => {
    const current = store();
    await current.value.hydrate();
    const revision = current.value.snapshot.document.dictionaryRevision;
    await expect(current.value.applyAdvice([{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], revision, () => true)).resolves.toBe(true);
    const entry = current.value.snapshot.document.dictionary.entries[0]!;
    await current.value.deleteEntry(entry.id);
    expect(current.value.snapshot.document.dictionary.suppressedAutomaticTexts).toEqual(["VoiceKit"]);
    const suppressedRevision = current.value.snapshot.document.dictionaryRevision;
    await current.value.applyAdvice([{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], suppressedRevision, () => true);
    expect(current.value.snapshot.document.dictionary.entries).toEqual([]);
    await current.value.addManualTerm("VoiceKit");
    expect(current.value.snapshot.document.dictionary).toMatchObject({
      entries: [{ text: "VoiceKit", source: "manual" }],
      suppressedAutomaticTexts: []
    });
  });

  it("drops advice when its dictionary generation or owner guard is stale", async () => {
    const current = store();
    await current.value.hydrate();
    const staleRevision = current.value.snapshot.document.dictionaryRevision;
    await current.value.addManualTerm("Existing");
    await expect(current.value.applyAdvice([{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], staleRevision, () => true)).resolves.toBe(false);
    await expect(current.value.applyAdvice([{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], current.value.snapshot.document.dictionaryRevision, () => false)).resolves.toBe(false);
    expect(current.value.snapshot.document.dictionary.entries.map((entry) => entry.text)).toEqual(["Existing"]);
  });

  it("restores the durable prior revision when an advice guard changes during the write", async () => {
    let raw: string | null = null;
    let release!: () => void;
    const writes: string[] = [];
    const current = store({
      getItem: vi.fn(async () => raw),
      setItem: vi.fn(async (_key, value) => {
        writes.push(value);
        if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
        raw = value;
      }),
      read: () => raw
    });
    await current.value.hydrate();
    let currentOwner = true;
    const pending = current.value.applyAdvice([{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], 0, () => currentOwner);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    currentOwner = false;
    release();
    await expect(pending).resolves.toBe(false);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(raw!)).toMatchObject({ revision: 0, dictionaryRevision: 0 });
    expect(current.value.snapshot.document.dictionary.entries).toEqual([]);
  });

  it("rehydrates the exact current-v1 revision after process restart and rebuilds monotonically", async () => {
    const storage = memoryStorage();
    const first = store(storage);
    await first.value.hydrate();
    await first.value.addManualTerm("VoiceKit");
    const persisted = first.value.snapshot.document;
    const restarted = store(storage);
    await restarted.value.hydrate();
    expect(restarted.value.snapshot.document).toEqual(persisted);
    await restarted.value.reset();
    expect(restarted.value.snapshot.document).toMatchObject({ revision: 2, dictionaryRevision: 2 });
    expect(restarted.value.snapshot.document.dictionary.entries).toEqual([]);
  });

  it("treats a legal empty advisor result as no learning and writes no evidence", async () => {
    const current = store();
    await current.value.hydrate();
    const before = current.value.snapshot.document;
    await expect(current.value.applyAdvice([], before.dictionaryRevision, () => true)).resolves.toBe(true);
    expect(current.value.snapshot.document).toBe(before);
    expect(current.value.snapshot.document.usage.correctionObservations).toBe(0);
    expect(current.value.snapshot.document.history).toEqual([]);
    expect(current.storage.setItem).not.toHaveBeenCalled();
  });

  it("records only device-local bounded usage and history in the same v1 document", async () => {
    const current = store();
    await current.value.hydrate();
    await current.value.recordVoiceStart();
    await current.value.addManualTerm("VoiceKit");
    const raw = JSON.parse(current.storage.read()!);
    expect(raw.usage).toMatchObject({ voiceStarts: 1, correctionObservations: 0 });
    expect(raw.history).toMatchObject([{ kind: "manualAdd", terms: ["VoiceKit"] }]);
    expect(current.storage.setItem).toHaveBeenCalledWith(mobileVoiceDictionaryStoreTesting.storageKey, expect.any(String));
    expect(JSON.stringify(raw)).not.toContain("rawTranscript");
  });
});
