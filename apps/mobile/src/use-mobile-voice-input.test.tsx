// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainTextMobileComposerDraft, type MobileComposerDraft } from "./mobile-composer-document";
import type {
  MobileVoiceCapability,
  MobileVoiceCaptureRuntime,
  MobileVoicePermission,
  MobileVoiceSession,
  MobileVoiceTransport
} from "./mobile-voice-input";
import { MobileVoicePreferencesStore } from "./mobile-voice-preferences-store";
import { useMobileVoiceInput, type MobileVoiceInputBinding } from "./use-mobile-voice-input";
import { EMPTY_MOBILE_VOICE_DICTIONARY } from "./mobile-voice-dictionary";

const appState = vi.hoisted(() => {
  type State = "active" | "background";
  const listeners = new Set<(next: State) => void>();
  const state = {
    currentState: "active" as State,
    addEventListener: (_event: string, listener: (next: State) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    transition(next: State) {
      state.currentState = next;
      for (const listener of listeners) listener(next);
    }
  };
  return state;
});
vi.mock("react-native", () => ({ AppState: appState }));
vi.mock("./mobile-realtime-audio", () => ({
  mobileVoiceCaptureRuntime: { isAvailable: () => false },
  prewarmMobileRealtimeAudio: () => undefined
}));
vi.mock("./mobile-voice-cue", () => ({ playMobileVoiceInputEndCue: () => undefined }));
vi.mock("./storage", () => ({ mobileVoicePreferences: undefined }));

const voiceCapability: MobileVoiceCapability = {
  support: "supported",
  limits: {
    supportedMimeTypes: ["audio/pcm"], maximumAudioChunkBytes: 1024, maximumAudioBytes: 4096,
    maximumAudioChunkDurationMs: 1_000, maximumAudioDurationMs: 10_000,
    maximumLocaleCharacters: 35, stableWaitMs: 100, maximumConcurrentSessions: 1
  },
  supportsLocale: true, supportsLiveDrafts: true, supportsRefinement: true,
  supportsRecognitionContext: true, recognitionContextMaximumItems: 20,
  recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192, supportedLocales: []
};

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

function preferencesStore() {
  let raw: string | null = null;
  let id = 0;
  return new MobileVoicePreferencesStore({
    getItem: async () => raw,
    setItem: async (_key, value) => { raw = value; }
  }, () => 100 + id, () => `id-${++id}`);
}

let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appState.currentState = "active";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMobileVoiceInput dictionary integration", () => {
  it("keeps recognition context opt-in, passes local instructions and learns against the node revision from the kept insertion correction", async () => {
    const store = preferencesStore();
    await store.hydrate();
    await store.setRefinementInstructions("Keep commands verbatim.");
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
      getVoiceInputDictionary: vi.fn(async () => ({ revision: 5n, syncEnabled: true, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] })),
      applyVoiceInputDictionaryLearning: vi.fn(async () => ({ revision: 6n, syncEnabled: true, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] })),
      getCapabilities: vi.fn(async () => voiceCapability),
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
        preferencesStore: store
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<Harness />));
    await vi.waitFor(() => expect(binding?.available).toBe(true));
    await act(async () => binding!.start());
    expect(transport.start).toHaveBeenCalledWith("request-one", "audio/pcm", "en-US", {
      instructions: "Keep commands verbatim."
    }, expect.any(AbortSignal));
    await act(async () => binding!.stop());
    expect(currentDraft.text).toBe("voice kit");
    act(() => editDraft!("VoiceKit"));
    await act(async () => vi.advanceTimersByTimeAsync(1_200));
    await vi.waitFor(() => expect(store.snapshot.document.usage.correctionObservations).toBe(1));
    expect(transport.applyVoiceInputDictionaryLearning).toHaveBeenCalledWith(5n, expect.any(Array), expect.any(AbortSignal));
    expect(store.snapshot.document).not.toHaveProperty("dictionary");
    expect(advice).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: "voice kit", afterText: "VoiceKit", rawTranscriptText: "voice kid", locale: "en-US"
    }), expect.any(AbortSignal));
    await store.setRecognitionContext(true, [{ text: " authorized\r\ncontext " }]);
    await act(async () => binding!.start());
    expect(transport.start).toHaveBeenLastCalledWith("request-one", "audio/pcm", "en-US", {
      instructions: "Keep commands verbatim."
    }, expect.any(AbortSignal), { contextData: [{ text: "authorized\ncontext" }] });
    await act(async () => binding!.cancel());
  });
});

it.each(["same owner", "changed transport", "changed draft", "disabled composer"] as const)("resumes an Android permission prompt only for the usable original owner (%s)", async outcome => {
  const store = preferencesStore();
  await store.hydrate();
  let grant!: (permission: MobileVoicePermission) => void;
  const permission = new Promise<MobileVoicePermission>(resolve => { grant = resolve; });
  const capture: MobileVoiceCaptureRuntime = {
    isAvailable: () => true,
    ensurePermission: vi.fn((_signal: AbortSignal, onPrompt?: () => void) => { onPrompt?.(); return permission; }),
    start: vi.fn(async () => async () => undefined),
    release: vi.fn(async () => undefined)
  };
  let currentOwner: string | undefined = "owner";
  const transport: MobileVoiceTransport = {
    profileId: "profile", surfaceOwnerKey: "owner", isCurrent: () => currentOwner === "owner",
    getCapabilities: async () => voiceCapability,
    getVoiceInputDictionary: async () => ({ revision: 1n, syncEnabled: false, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] }),
    applyVoiceInputDictionaryLearning: async () => ({ revision: 1n, syncEnabled: false, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] }),
    adviseVoiceInputDictionaryEdit: async () => ({ actions: [] }),
    start: vi.fn(async () => session()), append: vi.fn(async () => session()), stop: vi.fn(async () => session()),
    cancel: vi.fn(async () => session({ state: "done", outcome: "cancelled" })), get: vi.fn(async () => session())
  };
  const draft = plainTextMobileComposerDraft("");
  let binding!: MobileVoiceInputBinding;
  function Harness({ ready, reconnecting, changed }: { ready: boolean; reconnecting?: boolean; changed?: boolean }) {
    const currentTransport = changed && outcome === "changed transport" ? { ...transport, surfaceOwnerKey: "other" } : transport;
    binding = useMobileVoiceInput({
      transport: ready ? currentTransport : undefined,
      draftOwnerKey: changed && outcome === "changed draft" ? "other-draft" : "draft",
      enabled: ready && !(changed && outcome === "disabled composer"),
      permissionPromptConnection: reconnecting ? "connecting" : "connected",
      readDraft: () => draft, readSelection: () => ({ start: 0, end: 0 }), writeDraft: vi.fn(), onError: vi.fn(),
      requestId: () => "original-request", capture, preferencesStore: store
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness ready />));
  await vi.waitFor(() => expect(binding.available).toBe(true));
  let starting!: Promise<void>;
  await act(async () => { starting = binding.start(); });
  expect(capture.ensurePermission).toHaveBeenCalledOnce();
  await act(async () => {
    appState.transition("background");
    currentOwner = undefined;
    root!.render(<Harness ready={false} />);
  });
  expect(binding.state).toBe("starting");
  await act(async () => {
    appState.transition("active");
    root!.render(<Harness ready={false} reconnecting />);
    grant({ granted: true, canAskAgain: true });
  });
  expect(transport.start).not.toHaveBeenCalled();
  expect(capture.start).not.toHaveBeenCalled();

  currentOwner = outcome === "changed transport" ? "other" : "owner";
  await act(async () => root!.render(<Harness ready changed />));
  await act(async () => starting);
  if (outcome === "same owner") {
    expect(binding.state).toBe("listening");
    expect(transport.start).toHaveBeenCalledOnce();
    expect(transport.start).toHaveBeenCalledWith("original-request", "audio/pcm", undefined, {}, expect.any(AbortSignal));
    expect(capture.start).toHaveBeenCalledOnce();
    await act(async () => appState.transition("background"));
    expect(transport.cancel).toHaveBeenCalledOnce();
    expect(capture.release).toHaveBeenCalledOnce();
  } else {
    expect(binding.state).toBe("idle");
    expect(transport.start).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
  }
});
