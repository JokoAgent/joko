import { useCallback, useEffect, useRef } from "react";
import type { AppController } from "../controller.js";
import { applyVoiceDictionaryAdvice, voiceDictionaryAdviceDraft } from "../voice-input-dictionary.js";
import { readVoiceInputPreferences, subscribeVoiceInputPreferences, voiceInputLocale, writeVoiceInputPreferences } from "../voice-input-preferences.js";
import { inspectVoiceInsertedEdit, type VoiceInsertedEditTracker } from "./voice-inserted-edit.js";

interface VoiceDictionaryLearningOptions {
  readonly ownerKey: string;
  readonly enabled: boolean;
  readonly controller: AppController;
}

interface PendingVoiceDictionaryEdit {
  readonly tracker: VoiceInsertedEditTracker;
  readonly ownerKey: string;
  timer?: number;
  request?: AbortController;
  evidenceKey?: string;
}

/** Learns only corrections to an inserted transcript while its draft still owns the edit. */
export function useVoiceDictionaryLearning(options: VoiceDictionaryLearningOptions) {
  const latest = useRef(options);
  latest.current = options;
  const pendingRef = useRef<PendingVoiceDictionaryEdit | undefined>(undefined);
  const connected = options.controller.state.connectionState === "connected";
  const clear = useCallback((): void => {
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    if (pending?.timer !== undefined) window.clearTimeout(pending.timer);
    pending?.request?.abort();
  }, []);
  useEffect(() => clear, [clear, connected, options.enabled, options.ownerKey]);
  useEffect(() => subscribeVoiceInputPreferences((preferences) => {
    if (!preferences.autoDictionaryEnabled) clear();
  }), [clear]);

  const current = (pending: PendingVoiceDictionaryEdit): boolean => pendingRef.current === pending
    && pending.ownerKey === latest.current.ownerKey
    && latest.current.controller.state.connectionState === "connected"
    && latest.current.enabled
    && readVoiceInputPreferences().autoDictionaryEnabled;

  const track = (tracker: VoiceInsertedEditTracker, ownerKey: string): void => {
    if (ownerKey !== latest.current.ownerKey) return;
    clear();
    if (latest.current.controller.state.connectionState !== "connected"
      || !latest.current.enabled || !readVoiceInputPreferences().autoDictionaryEnabled) return;
    pendingRef.current = { tracker, ownerKey };
  };

  const observe = (nextText: string, isComposing: boolean): void => {
    const pending = pendingRef.current;
    if (pending === undefined) return;
    if (!current(pending)) { clear(); return; }
    const interrupt = (): void => {
      if (pending.timer !== undefined) window.clearTimeout(pending.timer);
      pending.timer = undefined;
      pending.evidenceKey = undefined;
      pending.request?.abort();
      pending.request = undefined;
    };
    if (isComposing) { interrupt(); return; }
    const inspection = inspectVoiceInsertedEdit(pending.tracker, nextText);
    if (!inspection.edited) {
      if (inspection.reason === "empty" || nextText.trim() === "") clear();
      else interrupt();
      return;
    }
    const evidenceKey = JSON.stringify(inspection);
    if (pending.evidenceKey === evidenceKey && (pending.timer !== undefined || pending.request !== undefined)) return;
    interrupt();
    pending.evidenceKey = evidenceKey;
    pending.timer = window.setTimeout(() => {
      if (!current(pending) || pending.evidenceKey !== evidenceKey) return;
      pending.timer = undefined;
      const preferences = readVoiceInputPreferences();
      const request = new AbortController();
      pending.request = request;
      const locale = voiceInputLocale(preferences);
      void latest.current.controller.adviseVoiceInputDictionaryEdit(voiceDictionaryAdviceDraft(preferences.dictionary, {
        beforeText: inspection.beforeText,
        afterText: inspection.afterText,
        ...(inspection.rawTranscriptText === undefined ? {} : { rawTranscriptText: inspection.rawTranscriptText }),
        ...(locale === undefined ? {} : { locale })
      }), request.signal).then((advice) => {
        if (request.signal.aborted || !current(pending) || pending.evidenceKey !== evidenceKey) return;
        const preferences = readVoiceInputPreferences();
        const dictionary = applyVoiceDictionaryAdvice(preferences.dictionary, advice.actions);
        if (dictionary !== preferences.dictionary) writeVoiceInputPreferences({ dictionary });
      }).catch(() => undefined).finally(() => {
        if (pendingRef.current === pending && pending.request === request) pendingRef.current = undefined;
      });
    }, 1_200);
  };

  return { track, observe, clear };
}
