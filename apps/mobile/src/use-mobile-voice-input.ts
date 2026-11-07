import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  cloneMobileComposerDraft,
  mobileComposerDraftsEqual,
  type MobileComposerDraft,
  type MobileComposerSelection
} from "./mobile-composer-document";
import {
  MobileVoiceInputRun,
  MobileVoiceRunError,
  isMobileVoiceInsertionIntact,
  supportsMobileVoiceCapture,
  type MobileVoiceCaptureRuntime,
  type MobileVoiceRunState,
  type MobileVoiceRunUpdate,
  type MobileVoiceTransport
} from "./mobile-voice-input";
import {
  applyMobileVoiceTranscript,
  rollbackMobileVoiceTranscript,
  type MobileVoiceDraftInsertionContext
} from "./mobile-voice-draft";
import {
  mobileVoiceCaptureRuntime,
  prewarmMobileRealtimeAudio
} from "./mobile-realtime-audio";
import { playMobileVoiceInputEndCue } from "./mobile-voice-cue";
import { mobileVoicePreferences } from "./storage";
import {
  MobileVoiceDictionaryLearningController,
  createMobileVoiceInsertedEditTracker
} from "./mobile-voice-dictionary-learning";
import type { MobileVoicePreferencesStore } from "./mobile-voice-preferences-store";

export interface UseMobileVoiceInputOptions {
  readonly transport?: MobileVoiceTransport;
  readonly draftOwnerKey?: string;
  readonly enabled: boolean;
  readonly permissionPromptConnection?: "connected" | "connecting";
  readonly readDraft: () => MobileComposerDraft;
  readonly readSelection: () => MobileComposerSelection;
  readonly writeDraft: (draft: MobileComposerDraft, selection: MobileComposerSelection, persist: boolean) => void;
  readonly onError: (message: string) => void;
  readonly requestId: () => string;
  readonly capture?: MobileVoiceCaptureRuntime;
  readonly locale?: string;
  readonly isComposing?: boolean;
  readonly preferencesStore?: MobileVoicePreferencesStore;
}

export interface MobileVoiceInputBinding {
  readonly available: boolean;
  readonly checking: boolean;
  readonly state: MobileVoiceRunState;
  readonly busy: boolean;
  readonly elapsedLabel?: string;
  readonly error?: MobileVoiceRunError;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  toggle(): Promise<void>;
  prewarm(): void;
}

interface PendingMicrophonePrompt {
  readonly ownerKey: string;
  readonly draftOwnerKey: string;
  readonly ready: Promise<boolean>;
  readonly finish: (ready: boolean) => void;
  backgrounded: boolean;
}

export function useMobileVoiceInput(options: UseMobileVoiceInputOptions): MobileVoiceInputBinding {
  const capture = options.capture ?? mobileVoiceCaptureRuntime;
  const preferencesStore = options.preferencesStore ?? mobileVoicePreferences;
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<MobileVoiceRunState>("idle");
  const [error, setError] = useState<MobileVoiceRunError | undefined>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const transportRef = useRef(options.transport);
  const enabledRef = useRef(options.enabled);
  const draftOwnerKeyRef = useRef(options.draftOwnerKey);
  const readDraftRef = useRef(options.readDraft);
  const readSelectionRef = useRef(options.readSelection);
  const writeDraftRef = useRef(options.writeDraft);
  const onErrorRef = useRef(options.onError);
  const requestIdRef = useRef(options.requestId);
  const localeRef = useRef(options.locale);
  const composingRef = useRef(options.isComposing ?? false);
  const runRef = useRef<MobileVoiceInputRun | undefined>(undefined);
  const permissionPromptRef = useRef<PendingMicrophonePrompt | undefined>(undefined);
  const insertionRef = useRef<MobileVoiceDraftInsertionContext | undefined>(undefined);
  const baseDraftRef = useRef<MobileComposerDraft | undefined>(undefined);
  const baseSelectionRef = useRef<MobileComposerSelection | undefined>(undefined);
  const usageSessionRef = useRef<string | undefined>(undefined);
  const refinementSupportedRef = useRef(false);
  const recognitionContextSupportedRef = useRef(false);
  const learning = useMemo(() => new MobileVoiceDictionaryLearningController({
    store: preferencesStore,
    readAdvisor: () => {
      const transport = transportRef.current;
      return transport?.isCurrent() ? transport : undefined;
    },
    readOwnerKey: () => {
      const transport = transportRef.current;
      return transport?.isCurrent() ? transport.surfaceOwnerKey : undefined;
    },
    readLocale: () => localeRef.current,
    readDraftText: () => readDraftRef.current().text
  }), [preferencesStore]);
  const ownerKey = options.transport?.surfaceOwnerKey;
  transportRef.current = options.transport;
  enabledRef.current = options.enabled;
  draftOwnerKeyRef.current = options.draftOwnerKey;
  readDraftRef.current = options.readDraft;
  readSelectionRef.current = options.readSelection;
  writeDraftRef.current = options.writeDraft;
  onErrorRef.current = options.onError;
  requestIdRef.current = options.requestId;
  localeRef.current = options.locale;
  composingRef.current = options.isComposing ?? false;

  const finishPermissionPrompt = useCallback((ready: boolean): void => {
    const prompt = permissionPromptRef.current;
    permissionPromptRef.current = undefined;
    prompt?.finish(ready);
  }, []);

  const rollbackInsertion = useCallback((persist = false): void => {
    const context = insertionRef.current;
    if (!context) return;
    insertionRef.current = undefined;
    if (draftOwnerKeyRef.current !== context.draftOwnerKey) return;
    const current = readDraftRef.current();
    const restored = rollbackMobileVoiceTranscript(current, context);
    if (restored === undefined) return;
    writeDraftRef.current(restored.draft, restored.selection, persist || context.persisted);
  }, []);

  const applyTranscript = useCallback((
    text: string,
    persist: boolean,
    expectedOwnerKey: string,
    expectedDraftOwnerKey: string
  ): void => {
    if (transportRef.current?.surfaceOwnerKey !== expectedOwnerKey
      || draftOwnerKeyRef.current !== expectedDraftOwnerKey) return;
    const current = readDraftRef.current();
    const base = baseDraftRef.current;
    const baseSelection = baseSelectionRef.current;
    const selection = base !== undefined && baseSelection !== undefined && mobileComposerDraftsEqual(base, current)
      ? baseSelection
      : { start: current.text.length, end: current.text.length };
    const result = applyMobileVoiceTranscript(
      current,
      selection,
      insertionRef.current,
      text,
      persist,
      expectedDraftOwnerKey
    );
    insertionRef.current = result.context;
    if (result.draft !== undefined && result.selection !== undefined) {
      writeDraftRef.current(result.draft, result.selection, persist);
    }
  }, []);

  const handleUpdate = useCallback((
    update: MobileVoiceRunUpdate,
    expectedOwnerKey: string,
    expectedDraftOwnerKey: string
  ): void => {
    if (transportRef.current?.surfaceOwnerKey !== expectedOwnerKey
      || draftOwnerKeyRef.current !== expectedDraftOwnerKey) return;
    setState(update.state);
    setError(update.error);
    const session = update.session;
    if (session !== undefined && usageSessionRef.current !== session.id) {
      usageSessionRef.current = session.id;
      void preferencesStore.recordVoiceStart().catch(() => undefined);
    }
    const terminal = session?.outcome !== undefined || session?.state === "done" || session?.state === "error";
    const keepTranscript = session?.outcome === "success" || session?.failure?.transcriptKept === true;
    const transcript = session?.result?.text ?? session?.draft?.text;
    if (transcript !== undefined && (!terminal || keepTranscript)) {
      applyTranscript(transcript, terminal && keepTranscript, expectedOwnerKey, expectedDraftOwnerKey);
    }
    if (terminal && keepTranscript) {
      const context = insertionRef.current;
      if (context !== undefined && context.draftOwnerKey === expectedDraftOwnerKey) {
        const current = readDraftRef.current();
        if (!context.persisted && isMobileVoiceInsertionIntact(current.text, context.insertion)) {
          const caret = context.insertion.end;
          writeDraftRef.current(current, { start: caret, end: caret }, true);
        }
        const finalDraft = readDraftRef.current();
        const dictionary = preferencesStore.snapshot;
        const tracker = refinementSupportedRef.current && dictionary.status === "ready"
          && isMobileVoiceInsertionIntact(finalDraft.text, context.insertion)
          ? createMobileVoiceInsertedEditTracker({
            ownerKey: expectedOwnerKey,
            ...(localeRef.current === undefined ? {} : { locale: localeRef.current }),
            draft: finalDraft.text,
            start: context.insertion.start,
            end: context.insertion.end,
            insertedText: context.insertion.text,
            beforeText: session?.result?.text ?? session?.draft?.text ?? context.insertion.text,
            ...(session?.result?.rawTranscriptText === undefined
              ? {} : { rawTranscriptText: session.result.rawTranscriptText }),
            preferencesRevision: dictionary.document.preferencesRevision
          }) : undefined;
        if (tracker) learning.track(tracker);
      }
      // A kept terminal transcript is ordinary composer content. Retire the
      // temporary rollback range so a later voice run cannot remove it.
      insertionRef.current = undefined;
      baseDraftRef.current = undefined;
      baseSelectionRef.current = undefined;
    }
    if (update.state === "cancelled" || (update.state === "error" && !terminal) || (terminal && !keepTranscript)) {
      learning.clear();
      rollbackInsertion(false);
    }
    if (update.error !== undefined) onErrorRef.current(update.error.message);
  }, [applyTranscript, preferencesStore, learning, rollbackInsertion]);

  useEffect(() => {
    learning.observe(readDraftRef.current().text, composingRef.current);
  });

  useEffect(() => () => learning.dispose(), [learning]);

  useEffect(() => {
    const transport = options.transport;
    const expectedOwnerKey = transport?.surfaceOwnerKey;
    const controller = new AbortController();
    setAvailable(false);
    setError(undefined);
    if (!transport || !options.enabled || !capture.isAvailable()) {
      setChecking(false);
      return () => controller.abort();
    }
    setChecking(true);
    void transport.getCapabilities(controller.signal).then((capability) => {
      if (!controller.signal.aborted && transportRef.current?.surfaceOwnerKey === expectedOwnerKey) {
        setAvailable(supportsMobileVoiceCapture(capability, capture.isAvailable()));
        recognitionContextSupportedRef.current = capability.supportsRecognitionContext;
      }
    }).catch(() => {
      if (!controller.signal.aborted && transportRef.current?.surfaceOwnerKey === expectedOwnerKey) setAvailable(false);
    }).finally(() => {
      if (!controller.signal.aborted && transportRef.current?.surfaceOwnerKey === expectedOwnerKey) setChecking(false);
    });
    return () => controller.abort();
  }, [capture, options.enabled, ownerKey]);

  useEffect(() => {
    const run = runRef.current;
    const prompt = permissionPromptRef.current;
    if (prompt && AppState.currentState === "background") prompt.backgrounded = true;
    if (prompt?.backgrounded && options.permissionPromptConnection !== undefined && options.draftOwnerKey === prompt.draftOwnerKey) {
      if (ownerKey === undefined && (AppState.currentState === "background" || options.permissionPromptConnection === "connecting")) return;
      if (AppState.currentState === "active" && ownerKey === prompt.ownerKey && options.enabled) {
        finishPermissionPrompt(true);
        return;
      }
    }
    finishPermissionPrompt(false);
    if (run !== undefined) {
      runRef.current = undefined;
      void run.dispose();
    }
    rollbackInsertion(false);
    learning.clear();
    usageSessionRef.current = undefined;
    refinementSupportedRef.current = false;
    recognitionContextSupportedRef.current = false;
    setState("idle");
    setError(undefined);
  }, [finishPermissionPrompt, learning, ownerKey, options.draftOwnerKey, options.enabled, options.permissionPromptConnection, rollbackInsertion]);

  useEffect(() => {
    if (state !== "listening") { setElapsedSeconds(0); return; }
    setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "background") return;
      learning.clear();
      const run = runRef.current;
      if (run?.shouldCancelForBackground) {
        void run.cancel();
      } else if (permissionPromptRef.current) {
        permissionPromptRef.current.backgrounded = true;
      }
    });
    return () => subscription.remove();
  }, [learning]);

  useEffect(() => () => {
    finishPermissionPrompt(false);
    const run = runRef.current;
    runRef.current = undefined;
    void run?.dispose();
  }, [finishPermissionPrompt]);

  const start = useCallback(async (): Promise<void> => {
    const transport = transportRef.current;
    const draftOwnerKey = draftOwnerKeyRef.current;
    if (!transport || !draftOwnerKey || !enabledRef.current || !available || runRef.current?.currentState === "starting"
      || runRef.current?.currentState === "listening" || runRef.current?.currentState === "submitting") return;
    rollbackInsertion(false);
    learning.clear();
    usageSessionRef.current = undefined;
    refinementSupportedRef.current = false;
    await preferencesStore.hydrate().catch(() => undefined);
    if (transportRef.current !== transport || !transport.isCurrent()
      || draftOwnerKeyRef.current !== draftOwnerKey || !enabledRef.current) return;
    baseDraftRef.current = cloneMobileComposerDraft(readDraftRef.current());
    baseSelectionRef.current = { ...readSelectionRef.current() };
    setError(undefined);
    const dictionary = preferencesStore.snapshot;
    if (dictionary.status === "ready" && dictionary.document.recognitionContextEnabled
      && dictionary.document.recognitionContextData.length > 0 && !recognitionContextSupportedRef.current) {
      onErrorRef.current("The configured voice routes do not support recognition context. Your local text was retained and was not submitted.");
    }
    const refinement = dictionary.status === "ready" ? {
      ...(dictionary.document.refinementInstructions === ""
        ? {} : { instructions: dictionary.document.refinementInstructions })
    } : undefined;
    const runCapture: MobileVoiceCaptureRuntime = options.permissionPromptConnection === "connected" ? {
      isAvailable: () => capture.isAvailable(),
      ensurePermission: async (signal) => {
        let prompt: PendingMicrophonePrompt | undefined;
        try {
          const permission = await capture.ensurePermission(signal, () => {
            let finish!: (ready: boolean) => void;
            const ready = new Promise<boolean>(resolve => { finish = resolve; });
            prompt = { ownerKey: transport.surfaceOwnerKey, draftOwnerKey, ready, finish, backgrounded: false };
            permissionPromptRef.current = prompt;
          });
          // The system sheet may resume before the original task's authenticated
          // transport and composer controls are usable again.
          if (permission.granted && prompt?.backgrounded && !await prompt.ready) throw new MobileVoiceRunError("ownerChanged");
          signal.throwIfAborted();
          return permission;
        } finally {
          if (prompt && permissionPromptRef.current === prompt) finishPermissionPrompt(false);
        }
      },
      start: (...args) => capture.start(...args),
      release: () => capture.release()
    } : capture;
    const run = new MobileVoiceInputRun({
      transport,
      capture: runCapture,
      requestId: () => requestIdRef.current(),
      locale: localeRef.current,
      ...(refinement === undefined ? {} : { refinement }),
      ...(dictionary.status === "ready" && dictionary.document.recognitionContextEnabled
        && dictionary.document.recognitionContextData.length > 0 && recognitionContextSupportedRef.current ? {
          recognitionContext: { contextData: dictionary.document.recognitionContextData }
        } : {}),
      onCapability: (capability) => { refinementSupportedRef.current = capability.supportsRefinement; },
      onCaptureStopped: playMobileVoiceInputEndCue,
      onUpdate: (update) => handleUpdate(update, transport.surfaceOwnerKey, draftOwnerKey)
    });
    runRef.current = run;
    await run.start().catch(() => undefined);
  }, [available, capture, finishPermissionPrompt, handleUpdate, learning, options.permissionPromptConnection, preferencesStore, rollbackInsertion]);

  const stop = useCallback(async (): Promise<void> => {
    await runRef.current?.stop().catch(() => undefined);
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const run = runRef.current;
    if (!run) return;
    finishPermissionPrompt(false);
    await run.cancel();
    learning.clear();
    rollbackInsertion(false);
  }, [finishPermissionPrompt, learning, rollbackInsertion]);

  const toggle = useCallback(async (): Promise<void> => {
    const current = runRef.current?.currentState;
    if (current === "starting" || current === "listening") await stop();
    else if (current !== "submitting") await start();
  }, [start, stop]);

  return {
    available,
    checking,
    state,
    busy: state === "starting" || state === "listening" || state === "submitting",
    ...(state === "listening" ? { elapsedLabel: formatVoiceElapsed(elapsedSeconds) } : {}),
    ...(error === undefined ? {} : { error }),
    start,
    stop,
    cancel,
    toggle,
    prewarm: prewarmMobileRealtimeAudio
  };
}

export function formatVoiceElapsed(seconds: number): string {
  const exact = Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 0;
  return `${Math.floor(exact / 60)}:${String(exact % 60).padStart(2, "0")}`;
}
