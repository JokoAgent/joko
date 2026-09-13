import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppController } from "../controller.js";
import { recordVoiceInputSession } from "../voice-input-history.js";
import { supportsVoiceMediaCapture, VoiceInputMediaSession, type VoiceMediaSessionUpdate } from "../voice-input-media.js";
import { VoiceInputMicrophonePrewarmer } from "../voice-input-prewarm.js";
import { readVoiceInputPreferences, subscribeVoiceInputPreferences, voiceInputLocale } from "../voice-input-preferences.js";
import type { Translator } from "./types.js";

export type VoiceDraftCompletion<T> =
  | { readonly kind: "applied"; readonly value: T; readonly isCurrent: () => boolean }
  | { readonly kind: "failed" | "cancelled" };

interface DraftVoiceInputOptions<T> {
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly root: HTMLElement | undefined;
  readonly enabled: boolean;
  readonly capture: () => (transcript: string, rawTranscriptText?: string) => T | undefined;
  readonly focus: () => void;
  readonly t: Translator;
}

interface Capture<T> {
  readonly scope: object;
  readonly media: VoiceInputMediaSession;
  readonly apply: (transcript: string, rawTranscriptText?: string) => T | undefined;
  readonly completion: Promise<VoiceDraftCompletion<T>>;
  readonly settle: (value: VoiceDraftCompletion<T>) => void;
  readonly focus: () => void;
  applied: boolean;
  finishing: boolean;
  recorded: boolean;
}

/** Owns one draft capture and resolves completion only after terminal success was applied. */
export function useDraftVoiceInput<T>(options: DraftVoiceInputOptions<T>) {
  const latest = useRef(options);
  latest.current = options;
  const [supported, setSupported] = useState(false);
  const [preferences, setPreferences] = useState(readVoiceInputPreferences);
  const [update, setUpdate] = useState<VoiceMediaSessionUpdate>();
  const [draftError, setDraftError] = useState<string>();
  const [startedAt, setStartedAt] = useState<number>();
  const captureRef = useRef<Capture<T> | undefined>(undefined);
  const prewarmerRef = useRef<VoiceInputMicrophonePrewarmer | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const ownerDocument = options.root?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  const connected = options.controller.state.connectionState === "connected";
  const scope = useMemo(() => ({}), [options.ownerKey, options.root, ownerDocument, options.controller.getArtifactUrl, connected, options.controller.state.snapshot.generation]);
  const scopeRef = useRef<object | undefined>(undefined);
  const live = useCallback((): boolean => scopeRef.current === scope && latest.current.enabled && connected
    && options.root?.isConnected === true && options.root.ownerDocument === ownerDocument && ownerWindow != null && !ownerWindow.closed,
  [scope, connected, options.root, ownerDocument, ownerWindow]);
  const current = useCallback((capture: Capture<T>): boolean => live() && captureRef.current === capture && capture.scope === scope, [live, scope]);
  const retire = useCallback((): Capture<T> | undefined => {
    const capture = captureRef.current;
    captureRef.current = undefined;
    capture?.settle({ kind: "cancelled" });
    if (frameRef.current !== undefined) ownerWindow?.cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    return capture;
  }, [ownerWindow]);
  const focus = useCallback((capture: Capture<T>): void => {
    if (!current(capture) || ownerWindow == null) return;
    if (frameRef.current !== undefined) ownerWindow.cancelAnimationFrame(frameRef.current);
    frameRef.current = ownerWindow.requestAnimationFrame(() => {
      frameRef.current = undefined;
      if (current(capture)) capture.focus();
    });
  }, [current, ownerWindow]);
  useEffect(() => subscribeVoiceInputPreferences(setPreferences), []);
  useLayoutEffect(() => {
    scopeRef.current = scope;
    setUpdate(undefined); setDraftError(undefined); setStartedAt(undefined);
    const suspend = (): void => {
      if (scopeRef.current !== scope) return;
      scopeRef.current = undefined;
      void retire()?.media.cancel(); prewarmerRef.current?.release();
      setUpdate(undefined); setStartedAt(undefined);
    };
    const resume = (): void => {
      if (options.root?.isConnected && options.root.ownerDocument === ownerDocument) scopeRef.current = scope;
    };
    const visibility = (): void => { if (ownerDocument?.visibilityState === "hidden") suspend(); else resume(); };
    ownerWindow?.addEventListener("pagehide", suspend); ownerWindow?.addEventListener("pageshow", resume);
    ownerDocument?.addEventListener("visibilitychange", visibility);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = undefined;
      void retire()?.media.dispose();
      ownerWindow?.removeEventListener("pagehide", suspend); ownerWindow?.removeEventListener("pageshow", resume);
      ownerDocument?.removeEventListener("visibilitychange", visibility);
    };
  }, [scope, options.root, ownerDocument, ownerWindow, retire]);
  useEffect(() => {
    if (options.enabled) return;
    void retire()?.media.cancel(); setUpdate(undefined); setStartedAt(undefined);
  }, [options.enabled, retire]);
  useEffect(() => {
    setSupported(false);
    if (!connected || ownerWindow?.navigator.mediaDevices?.getUserMedia === undefined) return;
    const request = new AbortController();
    void latest.current.controller.getVoiceInputCapabilities(request.signal).then((capability) => {
      if (!request.signal.aborted) setSupported(supportsVoiceMediaCapture(capability, ownerWindow.MediaRecorder, typeof ownerWindow.AudioContext === "function"));
    }).catch(() => undefined);
    return () => request.abort();
  }, [scope, connected, ownerWindow]);
  useEffect(() => {
    if (!supported || !options.enabled || !preferences.fastActivationEnabled || ownerWindow == null) return;
    const prewarmer = new VoiceInputMicrophonePrewarmer(ownerWindow.navigator.mediaDevices);
    prewarmerRef.current = prewarmer;
    const warm = (): void => { if (live() && ownerDocument?.visibilityState !== "hidden") void prewarmer.warm(preferences.deviceId); };
    const visibility = (): void => { if (ownerDocument?.visibilityState === "visible") warm(); else prewarmer.release(); };
    // The host capability is separate from the Window that owns microphone capture.
    const release = window.jokoDesktop?.microphone?.onRelease(() => prewarmer.release());
    warm(); ownerWindow.addEventListener("focus", warm); ownerDocument?.addEventListener("visibilitychange", visibility);
    return () => {
      release?.(); ownerWindow.removeEventListener("focus", warm); ownerDocument?.removeEventListener("visibilitychange", visibility);
      prewarmer.release(); if (prewarmerRef.current === prewarmer) prewarmerRef.current = undefined;
    };
  }, [scope, options.enabled, preferences.deviceId, preferences.fastActivationEnabled, supported, live, ownerDocument, ownerWindow]);
  const apply = useCallback((capture: Capture<T>, transcript: string, rawTranscriptText?: string): VoiceDraftCompletion<T> => {
    if (capture.applied || !current(capture)) return { kind: "cancelled" };
    capture.applied = true;
    const value = capture.apply(transcript, rawTranscriptText);
    if (value === undefined) { setDraftError(latest.current.t("voice.errors.draftChanged")); return { kind: "failed" }; }
    focus(capture);
    return { kind: "applied", value, isCurrent: () => current(capture) };
  }, [current, focus]);
  const start = useCallback((): boolean => {
    if (!supported || !live() || ownerWindow == null) return false;
    const previous = captureRef.current;
    if (previous !== undefined && ["starting", "listening", "submitting"].includes(previous.media.currentState)) return false;
    void retire()?.media.cancel(); setDraftError(undefined); setStartedAt(undefined);
    const applyTranscript = latest.current.capture();
    let settle!: (value: VoiceDraftCompletion<T>) => void;
    const completion = new Promise<VoiceDraftCompletion<T>>((resolve) => { settle = resolve; });
    try {
      const locale = voiceInputLocale(preferences);
      const media = new VoiceInputMediaSession({
        api: latest.current.controller, ownerWindow, subscribeMicrophoneRelease: window.jokoDesktop?.microphone?.onRelease,
        preferences: {
          ...(locale === undefined ? {} : { locale }), ...(preferences.deviceId === undefined ? {} : { deviceId: preferences.deviceId }),
          ...(preferences.refinementInstructions === "" ? {} : { refinementInstructions: preferences.refinementInstructions }),
          dictionaryTerms: preferences.dictionaryTerms, playInteractionSound: preferences.playInteractionSound
        },
        prewarmedStream: prewarmerRef.current?.checkout(),
        onUpdate: (next) => {
          const capture = captureRef.current;
          if (capture?.media !== media || !current(capture)) return;
          setUpdate(next);
          if (next.state === "listening") setStartedAt((value) => value ?? ownerWindow.Date.now());
          if ((next.state === "done" || next.state === "error") && next.session?.outcome !== undefined && !capture.recorded) {
            capture.recorded = true; recordVoiceInputSession(next.session);
          }
          if (next.state === "done" && next.session?.outcome === "success" && next.session.result !== undefined && !capture.applied) {
            capture.settle(apply(capture, next.session.result.text, next.session.result.rawTranscriptText));
          } else if (next.state === "error" || next.state === "done") capture.settle({ kind: "failed" });
          else if (next.state === "cancelled") capture.settle({ kind: "cancelled" });
        }
      });
      const capture: Capture<T> = { scope, media, apply: applyTranscript, completion, settle, focus: latest.current.focus, applied: false, finishing: false, recorded: false };
      captureRef.current = capture;
      void media.start().catch(() => { if (current(capture)) capture.settle({ kind: "failed" }); });
      return true;
    } catch { settle({ kind: "failed" }); setUpdate({ state: "error" }); return false; }
  }, [supported, live, ownerWindow, retire, preferences, scope, current, apply]);
  const finish = useCallback((): Promise<VoiceDraftCompletion<T>> => {
    const capture = captureRef.current;
    if (capture === undefined || !current(capture)) return Promise.resolve({ kind: "cancelled" });
    if (!capture.finishing) {
      capture.finishing = true;
      void capture.media.stop().catch(() => { if (current(capture)) capture.settle({ kind: "failed" }); });
    }
    return capture.completion;
  }, [current]);
  const cancel = useCallback((): void => {
    const capture = captureRef.current;
    const restore = capture !== undefined && current(capture) ? capture.focus : undefined;
    void retire()?.media.cancel(); setUpdate(undefined); setDraftError(undefined); setStartedAt(undefined);
    if (restore !== undefined && ownerWindow != null) frameRef.current = ownerWindow.requestAnimationFrame(() => {
      frameRef.current = undefined; if (live() && captureRef.current === undefined) restore();
    });
  }, [current, retire, ownerWindow, live]);
  const useTranscript = useCallback((): void => {
    const capture = captureRef.current;
    const result = capture?.media.currentSession?.result ?? update?.session?.result;
    if (capture === undefined || result === undefined || !current(capture)) return;
    apply(capture, result.text, result.rawTranscriptText); setUpdate(undefined);
  }, [apply, current, update]);
  const active = update?.state === "starting" || update?.state === "listening" || update?.state === "submitting";
  const isActive = useCallback((): boolean => {
    const capture = captureRef.current;
    return capture !== undefined && current(capture) && ["starting", "listening", "submitting"].includes(capture.media.currentState);
  }, [current]);
  const getCaptureIdentity = useCallback((): object | undefined => {
    const capture = captureRef.current;
    return capture !== undefined && current(capture) ? capture : undefined;
  }, [current]);
  return { supported, active, isActive, getCaptureIdentity, update, draftError, start, finish, cancel, useTranscript, preferences, startedAt, ownerDocument, ownerWindow, scope,
    phase: update?.session?.state === "refining" ? "refining" as const : update?.state,
    error: update === undefined ? undefined : draftVoiceError(update, options.t) };
}

function draftVoiceError(update: VoiceMediaSessionUpdate, t: Translator): string | undefined {
  if (update.error?.code === "cancelled") return undefined;
  if (update.error !== undefined) return t(`voice.errors.${update.error.code}`);
  if (update.session?.outcome === "noSpeech" || update.session?.failure?.code === "emptyTranscript") return t("voice.errors.noSpeech");
  if (update.session?.failure?.code === "providerAuthentication") return t("voice.errors.providerAuthentication");
  if (update.session?.failure?.code === "providerQuota") return t("voice.errors.providerQuota");
  return update.state === "error" ? t("voice.errors.serviceUnavailable") : undefined;
}
