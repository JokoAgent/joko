import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MobileVoiceDictionaryLearningController,
  createMobileVoiceInsertedEditTracker,
  inspectMobileVoiceInsertedEdit
} from "./mobile-voice-dictionary-learning";
import { MobileVoiceDictionaryStore } from "./mobile-voice-dictionary-store";
import type { MobileVoiceDictionaryLearningAction } from "./mobile-voice-dictionary";

function createStore() {
  let raw: string | null = null;
  let id = 0;
  const store = new MobileVoiceDictionaryStore({
    getItem: async () => raw,
    setItem: async (_key, value) => { raw = value; }
  }, () => 100 + id, () => `id-${++id}`);
  return store;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("mobile voice dictionary learning", () => {
  it("extracts only an anchored correction and rejects punctuation-only or broad rewrites", () => {
    const tracker = createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", locale: "en", draft: "Use voice kit today.", start: 4, end: 13,
      insertedText: "voice kit", beforeText: "voice kit", rawTranscriptText: "voice kid", dictionaryRevision: 0
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
      insertedText: "voice kit", beforeText: "voice kit", dictionaryRevision: 0
    })!;
    expect(inspectMobileVoiceInsertedEdit(repeated, "voice kit then VoiceKit"))
      .toMatchObject({ edited: true, afterText: "VoiceKit" });
    const wholeText = "a fairly long dictated sentence with several ordinary words";
    const whole = createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", draft: wholeText, start: 0, end: wholeText.length,
      insertedText: wholeText,
      beforeText: wholeText, dictionaryRevision: 0
    })!;
    expect(inspectMobileVoiceInsertedEdit(whole, "an entirely unrelated replacement paragraph containing different language"))
      .toMatchObject({ edited: false, reason: "broadRewrite" });
  });

  it("submits grounded evidence after the quiet window and persists accepted advice", async () => {
    const store = createStore();
    await store.hydrate();
    let draft = "Use voice kit today.";
    const advice = vi.fn(async () => ({ actions: [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    } satisfies MobileVoiceDictionaryLearningAction] }));
    const controller = new MobileVoiceDictionaryLearningController({
      store,
      readAdvisor: () => ({ adviseVoiceInputDictionaryEdit: advice }),
      readOwnerKey: () => "owner",
      readLocale: () => "en",
      readDraftText: () => draft
    });
    controller.track(createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", locale: "en", draft, start: 4, end: 13, insertedText: "voice kit",
      beforeText: "voice kit", rawTranscriptText: "voice kid", dictionaryRevision: 0
    })!);
    draft = "Use VoiceKit today.";
    controller.observe(draft);
    await vi.advanceTimersByTimeAsync(1_200);
    await vi.waitFor(() => expect(store.snapshot.document.dictionary.entries).toHaveLength(1));
    expect(advice).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: "voice kit",
      afterText: "VoiceKit",
      rawTranscriptText: "voice kid",
      locale: "en"
    }), expect.any(AbortSignal));
    expect(store.snapshot.document.usage.correctionObservations).toBe(1);
  });

  it("ends observation after whole deletion so later text cannot become evidence", async () => {
    const store = createStore();
    await store.hydrate();
    let draft = "voice kit";
    const advice = vi.fn(async () => ({ actions: [] }));
    const controller = new MobileVoiceDictionaryLearningController({
      store,
      readAdvisor: () => ({ adviseVoiceInputDictionaryEdit: advice }),
      readOwnerKey: () => "owner",
      readLocale: () => undefined,
      readDraftText: () => draft
    });
    controller.track(createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", draft, start: 0, end: draft.length, insertedText: draft,
      beforeText: draft, dictionaryRevision: 0
    })!);
    draft = "";
    controller.observe(draft);
    draft = "VoiceKit";
    controller.observe(draft);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advice).not.toHaveBeenCalled();
  });

  it("retires the observation when unrelated surrounding draft text changes", async () => {
    const store = createStore();
    await store.hydrate();
    let draft = "before voice kit after";
    const advice = vi.fn(async () => ({ actions: [] }));
    const controller = new MobileVoiceDictionaryLearningController({
      store,
      readAdvisor: () => ({ adviseVoiceInputDictionaryEdit: advice }),
      readOwnerKey: () => "owner",
      readLocale: () => undefined,
      readDraftText: () => draft
    });
    controller.track(createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", draft, start: 7, end: 16, insertedText: "voice kit",
      beforeText: "voice kit", dictionaryRevision: 0
    })!);
    draft = "changed before voice kit after";
    controller.observe(draft);
    draft = "changed before VoiceKit after";
    controller.observe(draft);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advice).not.toHaveBeenCalled();
  });

  it.each(["owner", "locale"] as const)("does not let late evidence cross a changed %s", async (change) => {
    const store = createStore();
    await store.hydrate();
    let draft = "voice kit";
    let owner = "owner";
    let locale = "en";
    const advice = vi.fn(async () => ({ actions: [] }));
    const controller = new MobileVoiceDictionaryLearningController({
      store,
      readAdvisor: () => ({ adviseVoiceInputDictionaryEdit: advice }),
      readOwnerKey: () => owner,
      readLocale: () => locale,
      readDraftText: () => draft
    });
    controller.track(createMobileVoiceInsertedEditTracker({
      ownerKey: owner, locale, draft, start: 0, end: draft.length, insertedText: draft,
      beforeText: draft, dictionaryRevision: 0
    })!);
    draft = "VoiceKit";
    controller.observe(draft);
    if (change === "owner") owner = "other";
    else locale = "ja";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(advice).not.toHaveBeenCalled();
  });

  it("aborts undone evidence and ignores a late advisor result", async () => {
    const store = createStore();
    await store.hydrate();
    let draft = "voice kit";
    let finish!: (value: { readonly actions: readonly MobileVoiceDictionaryLearningAction[] }) => void;
    const advice = vi.fn((_input: unknown, _signal?: AbortSignal) => new Promise<{
      readonly actions: readonly MobileVoiceDictionaryLearningAction[]
    }>((resolve) => { finish = resolve; }));
    const controller = new MobileVoiceDictionaryLearningController({
      store,
      readAdvisor: () => ({ adviseVoiceInputDictionaryEdit: advice }),
      readOwnerKey: () => "owner",
      readLocale: () => undefined,
      readDraftText: () => draft
    });
    controller.track(createMobileVoiceInsertedEditTracker({
      ownerKey: "owner", draft, start: 0, end: draft.length, insertedText: draft,
      beforeText: draft, dictionaryRevision: 0
    })!);
    draft = "VoiceKit";
    controller.observe(draft);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(advice).toHaveBeenCalledOnce();
    draft = "voice kit";
    controller.observe(draft);
    expect(advice.mock.calls[0]?.[1]?.aborted).toBe(true);
    finish({ actions: [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }] });
    await Promise.resolve();
    expect(store.snapshot.document.dictionary.entries).toEqual([]);
  });
});
