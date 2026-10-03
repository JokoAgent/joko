import { describe, expect, it, vi } from "vitest";
import { MobileVoicePreferencesStore, mobileVoicePreferencesStoreTesting } from "./mobile-voice-preferences-store";

function fixture(initial: string | null = null) {
  let raw = initial;
  let id = 0;
  const storage = {
    getItem: vi.fn(async () => raw),
    setItem: vi.fn(async (_key: string, value: string) => { raw = value; })
  };
  const store = new MobileVoicePreferencesStore(storage, () => 100, () => `history-${++id}`);
  return { store, storage, read: () => raw };
}

describe("MobileVoicePreferencesStore", () => {
  it("persists only explicitly authorized normalized recognition texts and rejects missing current fields", async () => {
    const f = fixture();
    await f.store.hydrate();
    expect(f.store.snapshot.document).toMatchObject({ recognitionContextEnabled: false, recognitionContextData: [] });
    await f.store.setRecognitionContext(true, [{ text: "  First\r\nsecond\tpart  " }]);
    expect(f.store.snapshot.document).toMatchObject({ recognitionContextEnabled: true,
      recognitionContextData: [{ text: "First\nsecond\tpart" }], refinementInstructions: "", preferencesRevision: 1 });
    const restarted = fixture(f.read()); await restarted.store.hydrate();
    expect(restarted.store.snapshot.document).toEqual(f.store.snapshot.document);
    await f.store.setRecognitionContext(false, f.store.snapshot.document.recognitionContextData);
    expect(f.store.snapshot.document.recognitionContextData).toHaveLength(1);
    await expect(f.store.setRecognitionContext(true, [{ text: "字".repeat(683) }])).rejects.toThrow();
    await expect(f.store.setRecognitionContext(true, [{ text: " \n " }])).rejects.toThrow();
    const missing = JSON.parse(f.read()!); delete missing.recognitionContextData;
    const incompatible = fixture(JSON.stringify(missing)); await incompatible.store.hydrate();
    expect(incompatible.store.snapshot.status).toBe("error"); expect(incompatible.storage.setItem).not.toHaveBeenCalled();
  });
  it("rejects incompatible development data without overwriting it and explicitly rebuilds private preferences", async () => {
    const old = JSON.stringify({ version: 1, dictionary: { entries: [] }, dictionaryRevision: 4 });
    const f = fixture(old);
    await f.store.hydrate();
    expect(f.store.snapshot.status).toBe("error");
    expect(f.read()).toBe(old);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    await f.store.reset();
    expect(f.store.snapshot.status).toBe("ready");
    expect(JSON.parse(f.read()!)).toEqual(f.store.snapshot.document);
    expect(f.store.snapshot.document).not.toHaveProperty("dictionary");
    expect(f.store.snapshot.document).toMatchObject({ revision: 1, preferencesRevision: 1 });
    expect(() => mobileVoicePreferencesStoreTesting.parseDocument(JSON.stringify({ ...f.store.snapshot.document, dictionary: {} }))).toThrow();
  });

  it("retries a transient read failure without writing", async () => {
    const f = fixture();
    f.storage.getItem.mockRejectedValueOnce(new Error("temporarily locked"));
    await f.store.hydrate();
    expect(f.store.snapshot.status).toBe("error");
    await f.store.retryHydrate();
    expect(f.store.snapshot.status).toBe("ready");
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it("serializes preferences and confirmed history durably before publishing, and restores them after restart", async () => {
    const f = fixture();
    await f.store.hydrate();
    const published: number[] = [];
    f.store.subscribe(() => {
      if (!f.store.snapshot.saving && f.store.snapshot.document.revision > 0) {
        expect(JSON.parse(f.read()!).revision).toBe(f.store.snapshot.document.revision);
        published.push(f.store.snapshot.document.revision);
      }
    });
    await Promise.all([
      f.store.setRefinementInstructions(" Keep commands verbatim. "),
      f.store.recordDictionaryChange("manualAdd", ["VoiceKit"])
    ]);
    await f.store.recordVoiceStart();
    await f.store.recordDictionaryChange("automaticLearning", ["VoiceKit"]);
    expect(published).toEqual([1, 2, 3, 4]);
    expect(f.store.snapshot.document).toMatchObject({
      revision: 4, preferencesRevision: 1, refinementInstructions: "Keep commands verbatim.",
      usage: { voiceStarts: 1, correctionObservations: 1 }
    });
    const reopened = new MobileVoicePreferencesStore(f.storage, () => 200, () => "new-history");
    await reopened.hydrate();
    expect(reopened.snapshot.document).toEqual(f.store.snapshot.document);
    expect(f.storage.setItem).toHaveBeenCalledWith(mobileVoicePreferencesStoreTesting.storageKey, expect.any(String));
    expect(JSON.parse(f.read()!)).not.toHaveProperty("dictionary");
  });

  it("does not publish a failed private write and allows a later retry", async () => {
    const f = fixture();
    await f.store.hydrate();
    const before = f.store.snapshot.document;
    f.storage.setItem.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.store.setAutoLearningEnabled(false)).rejects.toThrow();
    expect(f.store.snapshot.document).toBe(before);
    await f.store.setAutoLearningEnabled(false);
    expect(f.store.snapshot.document).toMatchObject({ autoLearningEnabled: false, preferencesRevision: 1 });
  });

  it("does not keep late history from a retired initiating owner", async () => {
    const f = fixture();
    await f.store.hydrate();
    let release!: () => void;
    f.storage.setItem.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    let current = true;
    const pending = f.store.recordDictionaryChange("automaticLearning", ["VoiceKit"], () => current);
    await vi.waitFor(() => expect(f.storage.setItem).toHaveBeenCalledOnce());
    current = false;
    release();
    await pending;
    expect(f.store.snapshot.document).toMatchObject({ revision: 0, history: [], usage: { correctionObservations: 0 } });
    expect(JSON.parse(f.read()!)).toEqual(f.store.snapshot.document);
  });

  it("bounds history and validates metadata without taking dictionary authority", async () => {
    const f = fixture();
    await f.store.hydrate();
    for (let index = 0; index < 105; index++) await f.store.recordDictionaryChange("manualEdit", [`Term ${index}`]);
    expect(f.store.snapshot.document.history).toHaveLength(100);
    expect(f.store.snapshot.document.preferencesRevision).toBe(0);
    await expect(f.store.recordDictionaryChange("manualEdit", [])).rejects.toThrow();
    await expect(f.store.setRefinementInstructions("x".repeat(1_001))).rejects.toThrow();
    await expect(f.store.recordDictionaryChange("manualEdit", ["one", "two", "three", "four"])).rejects.toThrow();
  });
});
