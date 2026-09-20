import { useCallback, useEffect, useRef, useState } from "react";
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

export interface UseMobileVoiceInputOptions {
  readonly transport?: MobileVoiceTransport;
  readonly draftOwnerKey?: string;
  readonly enabled: boolean;
  readonly readDraft: () => MobileComposerDraft;
  readonly readSelection: () => MobileComposerSelection;
  readonly writeDraft: (draft: MobileComposerDraft, selection: MobileComposerSelection, persist: boolean) => void;
  readonly onError: (message: string) => void;
  readonly requestId: () => string;
  readonly capture?: MobileVoiceCaptureRuntime;
  readonly locale?: string;
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

export function useMobileVoiceInput(options: UseMobileVoiceInputOptions): MobileVoiceInputBinding {
  const capture = options.capture ?? mobileVoiceCaptureRuntime;
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
  const runRef = useRef<MobileVoiceInputRun | undefined>(undefined);
  const insertionRef = useRef<MobileVoiceDraftInsertionContext | undefined>(undefined);
  const baseDraftRef = useRef<MobileComposerDraft | undefined>(undefined);
  const baseSelectionRef = useRef<MobileComposerSelection | undefined>(undefined);
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
      }
      // A kept terminal transcript is ordinary composer content. Retire the
      // temporary rollback range so a later voice run cannot remove it.
      insertionRef.current = undefined;
      baseDraftRef.current = undefined;
      baseSelectionRef.current = undefined;
    }
    if (update.state === "cancelled" || (update.state === "error" && !terminal) || (terminal && !keepTranscript)) {
      rollbackInsertion(false);
    }
    if (update.error !== undefined) onErrorRef.current(update.error.message);
  }, [applyTranscript, rollbackInsertion]);

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
    if (run !== undefined) {
      // The actual owner comparison is enforced by the transport. Dispose on
      // every owner-key transition so no old recorder survives the new surface.
      runRef.current = undefined;
      void run.dispose();
    }
    rollbackInsertion(false);
    setState("idle");
    setError(undefined);
  }, [ownerKey, options.draftOwnerKey, options.enabled, rollbackInsertion]);

  useEffect(() => {
    if (state !== "listening") { setElapsedSeconds(0); return; }
    setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") return;
      const run = runRef.current;
      if (run?.currentState === "starting" || run?.currentState === "listening" || run?.currentState === "submitting") {
        void run.cancel();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    const run = runRef.current;
    runRef.current = undefined;
    void run?.dispose();
  }, []);

  const start = useCallback(async (): Promise<void> => {
    const transport = transportRef.current;
    const draftOwnerKey = draftOwnerKeyRef.current;
    if (!transport || !draftOwnerKey || !enabledRef.current || !available || runRef.current?.currentState === "starting"
      || runRef.current?.currentState === "listening" || runRef.current?.currentState === "submitting") return;
    rollbackInsertion(false);
    baseDraftRef.current = cloneMobileComposerDraft(readDraftRef.current());
    baseSelectionRef.current = { ...readSelectionRef.current() };
    setError(undefined);
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => requestIdRef.current(),
      locale: localeRef.current,
      onCaptureStopped: playMobileVoiceInputEndCue,
      onUpdate: (update) => handleUpdate(update, transport.surfaceOwnerKey, draftOwnerKey)
    });
    runRef.current = run;
    await run.start().catch(() => undefined);
  }, [available, capture, handleUpdate, rollbackInsertion]);

  const stop = useCallback(async (): Promise<void> => {
    await runRef.current?.stop().catch(() => undefined);
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const run = runRef.current;
    if (!run) return;
    await run.cancel();
    rollbackInsertion(false);
  }, [rollbackInsertion]);

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
