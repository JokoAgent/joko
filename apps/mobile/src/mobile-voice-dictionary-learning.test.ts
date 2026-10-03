import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MobileVoiceDictionaryLearningController, createMobileVoiceInsertedEditTracker, inspectMobileVoiceInsertedEdit,
  type MobileVoiceDictionaryAdvisor
} from "./mobile-voice-dictionary-learning";
import { MobileVoicePreferencesStore } from "./mobile-voice-preferences-store";
import { EMPTY_MOBILE_VOICE_DICTIONARY, type MobileVoiceDictionaryLearningAction } from "./mobile-voice-dictionary";

const action: MobileVoiceDictionaryLearningAction = {
  action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
};
async function fixture() {
  let raw: string | null = null;
  const store = new MobileVoicePreferencesStore({
    getItem: async () => raw, setItem: async (_key, value) => { raw = value; }
  }, () => 100, () => "history");
  await store.hydrate();
  let draft = "Use voice kit today.";
  let owner = "owner";
  let locale = "en";
  let current = true;
  const snapshot = {
    revision: 7n, syncEnabled: true,
    dictionary: { ...EMPTY_MOBILE_VOICE_DICTIONARY, entries: [{
      id: "service-entry", text: "Existing", source: "manual" as const, frequency: 3, aliases: [], createdAt: 1, updatedAt: 1
    }] }, refinementTerms: ["Existing"]
  };
  const advisor: MobileVoiceDictionaryAdvisor = {
    isCurrent: () => current,
    getVoiceInputDictionary: vi.fn(async () => snapshot),
    adviseVoiceInputDictionaryEdit: vi.fn(async () => ({ actions: [action] })),
    applyVoiceInputDictionaryLearning: vi.fn(async () => ({ ...snapshot, revision: 8n }))
  };
  const controller = new MobileVoiceDictionaryLearningController({
    store, readAdvisor: () => advisor, readOwnerKey: () => owner, readLocale: () => locale, readDraftText: () => draft
  });
  controller.track(createMobileVoiceInsertedEditTracker({
    ownerKey: owner, locale, draft, start: 4, end: 13, insertedText: "voice kit", beforeText: "voice kit",
    rawTranscriptText: "voice kid", preferencesRevision: 0
  })!);
  const edit = (text: string) => { draft = text; controller.observe(text); };
  return { store, advisor, controller, snapshot, edit,
    changeOwner: () => { owner = "other"; }, changeLocale: () => { locale = "ja"; }, retire: () => { current = false; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("mobile voice dictionary learning", () => {
  it("extracts only an anchored correction and rejects punctuation-only or broad rewrites", () => {
    const tracker = createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", locale: "en", draft: "Use voice kit today.", start: 4, end: 13,
      insertedText: "voice kit", beforeText: "voice kit", rawTranscriptText: "voice kid", preferencesRevision: 0
    })!;
    expect(inspectMobileVoiceInsertedEdit(tracker, "Use VoiceKit today.")).toEqual({
      edited: true, beforeText: "voice kit", afterText: "VoiceKit", rawTranscriptText: "voice kid"
    });
    expect(inspectMobileVoiceInsertedEdit(tracker, "Use voice kit! today."))
      .toEqual({ edited: false, reason: "punctuationOnly" });
    expect(inspectMobileVoiceInsertedEdit(tracker, "Later use VoiceKit today."))
      .toEqual({ edited: false, reason: "surroundingChanged" });
    const repeated = createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", draft: "voice kit then voice kit", start: 15, end: 24,
      insertedText: "voice kit", beforeText: "voice kit", preferencesRevision: 0
    })!;
    expect(inspectMobileVoiceInsertedEdit(repeated, "voice kit then VoiceKit"))
      .toMatchObject({ edited: true, afterText: "VoiceKit" });
    const wholeText = "a fairly long dictated sentence with several ordinary words";
    const whole = createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", draft: wholeText, start: 0, end: wholeText.length,
      insertedText: wholeText,
      beforeText: wholeText, preferencesRevision: 0
    })!;
    expect(inspectMobileVoiceInsertedEdit(whole, "an entirely unrelated replacement paragraph containing different language"))
      .toMatchObject({ edited: false, reason: "broadRewrite" });
  });


  it("reads the service projection, advises against it and submits the same revision before private history", async () => {
    const f = await fixture();
    f.edit("Use VoiceKit today.");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(f.advisor.adviseVoiceInputDictionaryEdit).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: "voice kit", afterText: "VoiceKit", rawTranscriptText: "voice kid", locale: "en",
      existingEntries: [{ term: "Existing", source: "manual", frequency: 3, aliases: [] }]
    }), expect.any(AbortSignal));
    expect(f.advisor.applyVoiceInputDictionaryLearning).toHaveBeenCalledWith(7n, [action], expect.any(AbortSignal));
    expect(f.store.snapshot.document).toMatchObject({
      preferencesRevision: 0, history: [{ kind: "automaticLearning", terms: ["VoiceKit"] }], usage: { correctionObservations: 1 }
    });
    expect(f.store.snapshot.document).not.toHaveProperty("dictionary");
  });

  it.each(["undo", "deletion", "surrounding", "owner", "locale", "preferences", "authority", "dispose"] as const)(
    "does not let late advice submit after %s retires evidence", async (reason) => {
      const f = await fixture();
      let finish!: (value: { actions: readonly MobileVoiceDictionaryLearningAction[] }) => void;
      vi.mocked(f.advisor.adviseVoiceInputDictionaryEdit).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      f.edit("Use VoiceKit today.");
      await vi.advanceTimersByTimeAsync(1_200);
      expect(f.advisor.adviseVoiceInputDictionaryEdit).toHaveBeenCalledOnce();
      if (reason === "undo") f.edit("Use voice kit today.");
      if (reason === "deletion") { f.edit("Use  today."); f.edit("Use VoiceKit today."); }
      if (reason === "surrounding") f.edit("Later use VoiceKit today.");
      if (reason === "owner") f.changeOwner();
      if (reason === "locale") f.changeLocale();
      if (reason === "preferences") await f.store.setAutoLearningEnabled(false);
      if (reason === "authority") f.retire();
      if (reason === "dispose") f.controller.dispose();
      finish({ actions: [action] });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.advisor.applyVoiceInputDictionaryLearning).not.toHaveBeenCalled();
      expect(f.store.snapshot.document.history).toEqual([]);
    }
  );

  it("does not dispatch advice after a late snapshot loses its insertion evidence", async () => {
    const f = await fixture();
    let finish!: (value: typeof f.snapshot) => void;
    vi.mocked(f.advisor.getVoiceInputDictionary).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.edit("Use VoiceKit today.");
    await vi.advanceTimersByTimeAsync(1_200);
    f.edit("Use voice kit today.");
    finish(f.snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.advisor.adviseVoiceInputDictionaryEdit).not.toHaveBeenCalled();
  });

  it.each(["empty", "conflict"] as const)("records no learning for %s and does not retry a rejected CAS", async (result) => {
    const f = await fixture();
    if (result === "empty") vi.mocked(f.advisor.adviseVoiceInputDictionaryEdit).mockResolvedValueOnce({ actions: [] });
    else vi.mocked(f.advisor.applyVoiceInputDictionaryLearning).mockRejectedValueOnce(new Error("revision conflict"));
    f.edit("Use VoiceKit today.");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(f.advisor.applyVoiceInputDictionaryLearning).toHaveBeenCalledTimes(result === "empty" ? 0 : 1);
    expect(f.store.snapshot.document.history).toEqual([]);
    expect(f.store.snapshot.document.usage.correctionObservations).toBe(0);
  });
});
