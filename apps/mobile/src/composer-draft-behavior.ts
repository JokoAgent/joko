import {
  appendPlainTextToMobileComposer,
  plainTextMobileComposerDraft,
  reconcileMobileComposerText,
  type MobileComposerDraft
} from "./mobile-composer-document";

export interface MobileComposerTextChange {
  readonly visibleDraft: MobileComposerDraft;
  readonly normalDraftToPersist: MobileComposerDraft | null;
}

export function changeMobileComposerText(
  queueEditing: boolean,
  current: MobileComposerDraft,
  nextText: string
): MobileComposerTextChange {
  const visibleDraft = queueEditing
    ? plainTextMobileComposerDraft(nextText)
    : reconcileMobileComposerText(current, nextText).draft;
  return {
    visibleDraft,
    normalDraftToPersist: queueEditing ? null : visibleDraft
  };
}

export function addToMobileComposer(input: {
  readonly visibleDraft: MobileComposerDraft;
  readonly queueStashedDraft?: MobileComposerDraft;
  readonly addition: string;
}): {
  readonly visibleDraft: MobileComposerDraft;
  readonly normalDraft: MobileComposerDraft;
  readonly queueStashedDraft?: MobileComposerDraft;
} {
  const normalDraft = appendPlainTextToMobileComposer(input.queueStashedDraft ?? input.visibleDraft, input.addition);
  return input.queueStashedDraft === undefined
    ? { visibleDraft: normalDraft, normalDraft }
    : { visibleDraft: input.visibleDraft, normalDraft, queueStashedDraft: normalDraft };
}
