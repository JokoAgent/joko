// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainTextMobileComposerDraft, type MobileComposerDraft } from "./mobile-composer-document";
import type {
  MobileVoiceCaptureRuntime,
  MobileVoiceSession,
  MobileVoiceTransport
} from "./mobile-voice-input";
import { MobileVoiceDictionaryStore } from "./mobile-voice-dictionary-store";
import { useMobileVoiceInput, type MobileVoiceInputBinding } from "./use-mobile-voice-input";

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined })
  }
}));
vi.mock("./mobile-realtime-audio", () => ({
  mobileVoiceCaptureRuntime: { isAvailable: () => false },
  prewarmMobileRealtimeAudio: () => undefined
}));
vi.mock("./mobile-voice-cue", () => ({ playMobileVoiceInputEndCue: () => undefined }));
vi.mock("./storage", () => ({ mobileVoiceDictionary: undefined }));

function session(patch: Partial<MobileVoiceSession> = {}): MobileVoiceSession {
  return {
    id: "voice-one",
    state: "listening",
    nextChunkSequence: 1n,
    acceptedAudioBytes: 0,
    acceptedAudioDurationMs: 0,
    createdAt: 1,
    updatedAt: 1,
    recoveryAttempts: 0,
    stallWarning: false,
    ...patch
  };
}

function dictionaryStore() {
  let raw: string | null = null;
  let id = 0;
  return new MobileVoiceDictionaryStore({
    getItem: async () => raw,
    setItem: async (_key, value) => { raw = value; }
  }, () => 100 + id, () => `id-${++id}`);
}

let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMobileVoiceInput dictionary integration", () => {
  it("passes current local refinement and learns only from the kept insertion correction", async () => {
    const store = dictionaryStore();
    await store.hydrate();
    await store.setRefinementInstructions("Keep commands verbatim.");
    await store.addManualTerm("ExistingTerm");
    const advice = vi.fn(async () => ({ actions: [{
      action: "addEntry" as const,
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName" as const,
      confidence: "high" as const
    }] }));
    const transport: MobileVoiceTransport = {
      profileId: "profile",
      surfaceOwnerKey: "owner",
      isCurrent: () => true,
      getCapabilities: vi.fn(async () => ({
        support: "supported" as const,
        limits: {
          supportedMimeTypes: ["audio/pcm"], maximumAudioChunkBytes: 1024, maximumAudioBytes: 4096,
          maximumAudioChunkDurationMs: 1_000, maximumAudioDurationMs: 10_000,
          maximumLocaleCharacters: 35, stableWaitMs: 100, maximumConcurrentSessions: 1
        },
        supportsLocale: true,
        supportsLiveDrafts: true,
        supportsRefinement: true
      })),
      adviseVoiceInputDictionaryEdit: advice,
      start: vi.fn(async () => session()),
      append: vi.fn(async () => session()),
      stop: vi.fn(async () => session({
        state: "done",
        outcome: "success",
        updatedAt: 2,
        result: { text: "voice kit", source: "stable", salvaged: false, rawTranscriptText: "voice kid" }
      })),
      cancel: vi.fn(async () => session({ state: "done", outcome: "cancelled", updatedAt: 2 })),
      get: vi.fn(async () => session())
    };
    const capture: MobileVoiceCaptureRuntime = {
      isAvailable: () => true,
      ensurePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
      start: vi.fn(async () => async () => undefined),
      release: vi.fn(async () => undefined)
    };
    let binding: MobileVoiceInputBinding | undefined;
    let editDraft: ((text: string) => void) | undefined;
    let currentDraft = plainTextMobileComposerDraft("");
    function Harness() {
      const [draft, setDraft] = useState(currentDraft);
      const draftRef = useRef<MobileComposerDraft>(draft);
      draftRef.current = draft;
      editDraft = (text) => {
        const next = plainTextMobileComposerDraft(text);
        currentDraft = next;
        draftRef.current = next;
        setDraft(next);
      };
      binding = useMobileVoiceInput({
        transport,
        draftOwnerKey: "draft",
        enabled: true,
        readDraft: () => draftRef.current,
        readSelection: () => ({ start: draftRef.current.text.length, end: draftRef.current.text.length }),
        writeDraft: (next) => {
          currentDraft = next;
          draftRef.current = next;
          setDraft(next);
        },
        onError: () => undefined,
        requestId: () => "request-one",
        capture,
        locale: "en-US",
        dictionaryStore: store
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<Harness />));
    await vi.waitFor(() => expect(binding?.available).toBe(true));
    await act(async () => binding!.start());
    expect(transport.start).toHaveBeenCalledWith("request-one", "audio/pcm", "en-US", {
      instructions: "Keep commands verbatim.", dictionaryTerms: ["ExistingTerm"]
    }, expect.any(AbortSignal));
    await act(async () => binding!.stop());
    expect(currentDraft.text).toBe("voice kit");
    act(() => editDraft!("VoiceKit"));
    await act(async () => vi.advanceTimersByTimeAsync(1_200));
    await vi.waitFor(() => expect(store.snapshot.document.dictionary.entries.map((entry) => entry.text))
      .toEqual(["ExistingTerm", "VoiceKit"]));
    expect(advice).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: "voice kit", afterText: "VoiceKit", rawTranscriptText: "voice kid", locale: "en-US"
    }), expect.any(AbortSignal));
  });
});
