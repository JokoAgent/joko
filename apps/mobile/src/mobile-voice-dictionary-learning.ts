import {
  mobileVoiceDictionaryAdviceDraft,
  type MobileVoiceDictionaryAdviceDraft,
  type MobileVoiceDictionaryLearningAction
} from "./mobile-voice-dictionary";
import type { MobileVoicePreferencesStore } from "./mobile-voice-preferences-store";
import type { MobileVoiceDictionaryApi } from "./mobile-voice-dictionary-service";

export const MOBILE_VOICE_DICTIONARY_LEARNING_DELAY_MS = 1_200;

const MAXIMUM_DIRECT_REPLACEMENT_CHARACTERS = 160;
const LARGE_REWRITE_MINIMUM_CHARACTERS = 32;
const LARGE_REWRITE_RATIO = 0.65;

export interface MobileVoiceInsertedEditTracker {
  readonly ownerKey: string;
  readonly locale?: string;
  readonly insertedText: string;
  readonly beforeText: string;
  readonly rawTranscriptText?: string;
  readonly expectedText: string;
  readonly prefixText: string;
  readonly suffixText: string;
  readonly preferencesRevision: number;
}

export type MobileVoiceInsertedEditInspection =
  | {
    readonly edited: true;
    readonly beforeText: string;
    readonly afterText: string;
    readonly rawTranscriptText?: string;
  }
  | {
    readonly edited: false;
    readonly reason: "unchanged" | "insertedTextPresent" | "surroundingChanged" | "rangeUnavailable"
      | "empty" | "punctuationOnly" | "tooLong" | "broadRewrite";
  };

export interface MobileVoiceDictionaryAdvisor extends Pick<MobileVoiceDictionaryApi, "getVoiceInputDictionary" | "applyVoiceInputDictionaryLearning"> {
  isCurrent(): boolean;
  adviseVoiceInputDictionaryEdit(
    draft: MobileVoiceDictionaryAdviceDraft,
    signal?: AbortSignal
  ): Promise<{ readonly actions: readonly MobileVoiceDictionaryLearningAction[] }>;
}

interface PendingEdit {
  readonly tracker: MobileVoiceInsertedEditTracker;
  readonly advisor: MobileVoiceDictionaryAdvisor;
  timer?: ReturnType<typeof setTimeout>;
  request?: AbortController;
  evidenceKey?: string;
}

export function createMobileVoiceInsertedEditTracker(input: {
  readonly ownerKey: string;
  readonly locale?: string;
  readonly draft: string;
  readonly start: number;
  readonly end: number;
  readonly insertedText: string;
  readonly beforeText: string;
  readonly rawTranscriptText?: string;
  readonly preferencesRevision: number;
}): MobileVoiceInsertedEditTracker | undefined {
  if (input.start < 0 || input.end < input.start || input.end > input.draft.length
    || input.draft.slice(input.start, input.end) !== input.insertedText) return undefined;
  const beforeText = normalizeText(input.beforeText);
  if (!beforeText || !input.insertedText.trim()) return undefined;
  const prefix = input.draft.slice(0, input.start);
  const suffix = input.draft.slice(input.end);
  const rawTranscriptText = optionalText(input.rawTranscriptText);
  return Object.freeze({
    ownerKey: input.ownerKey,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    insertedText: input.insertedText,
    beforeText,
    ...(rawTranscriptText === undefined ? {} : { rawTranscriptText }),
    expectedText: input.draft,
    prefixText: prefix,
    suffixText: suffix,
    preferencesRevision: input.preferencesRevision
  });
}

/** Extracts only the corrected text still bracketed by the original insertion context. */
export function inspectMobileVoiceInsertedEdit(
  tracker: MobileVoiceInsertedEditTracker,
  currentText: string
): MobileVoiceInsertedEditInspection {
  if (currentText === tracker.expectedText) return { edited: false, reason: "unchanged" };
  if (!currentText.startsWith(tracker.prefixText)
    || tracker.suffixText !== "" && !currentText.endsWith(tracker.suffixText)) {
    return { edited: false, reason: "surroundingChanged" };
  }
  const start = tracker.prefixText.length;
  const end = tracker.suffixText === "" ? currentText.length : currentText.length - tracker.suffixText.length;
  if (end < start) return { edited: false, reason: "rangeUnavailable" };
  const currentInsertion = currentText.slice(start, end);
  if (currentInsertion === tracker.insertedText) return { edited: false, reason: "insertedTextPresent" };
  return editedResult(tracker, currentInsertion);
}

export class MobileVoiceDictionaryLearningController {
  #pending?: PendingEdit;

  constructor(private readonly options: {
    readonly store: Pick<MobileVoicePreferencesStore, "snapshot" | "recordDictionaryChange">;
    readonly readAdvisor: () => MobileVoiceDictionaryAdvisor | undefined;
    readonly readOwnerKey: () => string | undefined;
    readonly readLocale: () => string | undefined;
    readonly readDraftText: () => string;
    readonly delayMs?: number;
    readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  }) {}

  track(tracker: MobileVoiceInsertedEditTracker): void {
    this.clear();
    const state = this.options.store.snapshot;
    const advisor = this.options.readAdvisor();
    if (state.status !== "ready" || !state.document.autoLearningEnabled
      || !advisor?.isCurrent()
      || tracker.ownerKey !== this.options.readOwnerKey()
      || tracker.locale !== this.options.readLocale()
      || tracker.preferencesRevision !== state.document.preferencesRevision) return;
    this.#pending = { tracker, advisor };
  }

  observe(nextText: string, isComposing = false): void {
    const pending = this.#pending;
    if (!pending) return;
    if (!this.#current(pending)) { this.clear(); return; }
    if (isComposing) { this.#interrupt(pending); return; }
    const inspection = inspectMobileVoiceInsertedEdit(pending.tracker, nextText);
    if (!inspection.edited) {
      this.#interrupt(pending);
      if (inspection.reason === "empty" || inspection.reason === "surroundingChanged"
        || inspection.reason === "rangeUnavailable" || nextText.trim() === "") this.clear();
      return;
    }
    const evidenceKey = JSON.stringify(inspection);
    if (pending.evidenceKey === evidenceKey && (pending.timer || pending.request)) return;
    this.#interrupt(pending);
    pending.evidenceKey = evidenceKey;
    const setTimer = this.options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    pending.timer = setTimer(() => {
      if (!this.#evidenceCurrent(pending, evidenceKey)) return;
      pending.timer = undefined;
      const request = new AbortController();
      pending.request = request;
      const current = () => !request.signal.aborted && this.#evidenceCurrent(pending, evidenceKey);
      const advisor = pending.advisor;
      void advisor.getVoiceInputDictionary(request.signal).then(async (snapshot) => {
        if (!current()) return;
        const draft = mobileVoiceDictionaryAdviceDraft(snapshot.dictionary, {
          beforeText: inspection.beforeText,
          afterText: inspection.afterText,
          ...(inspection.rawTranscriptText === undefined ? {} : { rawTranscriptText: inspection.rawTranscriptText }),
          ...(pending.tracker.locale === undefined ? {} : { locale: pending.tracker.locale })
        });
        const advice = await advisor.adviseVoiceInputDictionaryEdit(draft, request.signal);
        if (!current() || advice.actions.length === 0) return;
        const committed = await advisor.applyVoiceInputDictionaryLearning(snapshot.revision, advice.actions, request.signal);
        if (!current() || committed.revision === snapshot.revision) return;
        await this.options.store.recordDictionaryChange("automaticLearning", advice.actions.map((action) => action.term), current)
          .catch(() => undefined);
      }).catch(() => undefined).finally(() => {
        if (this.#pending === pending && pending.request === request) this.#pending = undefined;
      });
    }, this.options.delayMs ?? MOBILE_VOICE_DICTIONARY_LEARNING_DELAY_MS);
  }

  clear(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    this.#interrupt(pending);
  }

  dispose(): void { this.clear(); }

  #current(pending: PendingEdit): boolean {
    const state = this.options.store.snapshot;
    return this.#pending === pending
      && pending.advisor.isCurrent()
      && pending.tracker.ownerKey === this.options.readOwnerKey()
      && pending.tracker.locale === this.options.readLocale()
      && state.status === "ready"
      && state.document.autoLearningEnabled
      && state.document.preferencesRevision === pending.tracker.preferencesRevision;
  }

  #evidenceCurrent(pending: PendingEdit, evidenceKey: string): boolean {
    if (!this.#current(pending) || pending.evidenceKey !== evidenceKey) return false;
    const inspection = inspectMobileVoiceInsertedEdit(pending.tracker, this.options.readDraftText());
    return inspection.edited && JSON.stringify(inspection) === evidenceKey;
  }

  #interrupt(pending: PendingEdit): void {
    if (pending.timer) (this.options.clearTimer ?? clearTimeout)(pending.timer);
    pending.timer = undefined;
    pending.evidenceKey = undefined;
    pending.request?.abort();
    pending.request = undefined;
  }
}

function editedResult(
  tracker: MobileVoiceInsertedEditTracker,
  value: string
): MobileVoiceInsertedEditInspection {
  const afterText = normalizeText(value);
  if (!afterText) return { edited: false, reason: "empty" };
  if (afterText === tracker.beforeText || afterText === tracker.insertedText.trim()) {
    return { edited: false, reason: "unchanged" };
  }
  if (withoutSentencePunctuation(afterText) === withoutSentencePunctuation(tracker.beforeText)) {
    return { edited: false, reason: "punctuationOnly" };
  }
  if (afterText.length > tracker.beforeText.length + 80) return { edited: false, reason: "tooLong" };
  const changed = changedSpan(tracker.beforeText, afterText);
  if (changed && isLargeRewrite(tracker.beforeText, afterText, changed)) {
    return { edited: false, reason: "broadRewrite" };
  }
  return Object.freeze({
    edited: true,
    beforeText: tracker.beforeText,
    afterText,
    ...(tracker.rawTranscriptText === undefined ? {} : { rawTranscriptText: tracker.rawTranscriptText })
  });
}

function changedSpan(before: string, after: string): { readonly before: string; readonly after: string } | undefined {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const beforeChanged = before.slice(start, beforeEnd);
  const afterChanged = after.slice(start, afterEnd);
  return beforeChanged === "" && afterChanged === "" ? undefined : { before: beforeChanged, after: afterChanged };
}

function isLargeRewrite(
  before: string,
  after: string,
  changed: { readonly before: string; readonly after: string }
): boolean {
  const maximum = Math.max(contentCharacterCount(before), contentCharacterCount(after));
  const changedCharacters = Math.max(contentCharacterCount(changed.before), contentCharacterCount(changed.after));
  return changedCharacters > MAXIMUM_DIRECT_REPLACEMENT_CHARACTERS
    || maximum >= LARGE_REWRITE_MINIMUM_CHARACTERS
      && changedCharacters / Math.max(1, maximum) > LARGE_REWRITE_RATIO;
}

function contentCharacterCount(value: string): number {
  return withoutSentencePunctuation(value).replace(/\s+/gu, "").length;
}

function withoutSentencePunctuation(value: string): string {
  return normalizeText(value).replace(/[，。！？、,.!?:：;；"'“”‘’`()\[\]{}<>《》【】]/gu, "");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t\f\v]+/gu, " ").trim();
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeText(value);
  return normalized || undefined;
}
