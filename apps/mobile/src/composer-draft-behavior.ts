export interface MobileComposerTextChange {
  readonly visibleText: string;
  readonly normalDraftToPersist: string | null;
}

export function changeMobileComposerText(queueEditing: boolean, nextText: string): MobileComposerTextChange {
  return {
    visibleText: nextText,
    normalDraftToPersist: queueEditing ? null : nextText
  };
}

export function appendMobileComposerDraft(current: string, addition: string): string {
  return current.length > 0 ? `${current}\n\n${addition}` : addition;
}

export function addToMobileComposer(input: {
  readonly visibleText: string;
  readonly queueStashedDraft?: string;
  readonly addition: string;
}): {
  readonly visibleText: string;
  readonly normalDraft: string;
  readonly queueStashedDraft?: string;
} {
  const normalDraft = appendMobileComposerDraft(input.queueStashedDraft ?? input.visibleText, input.addition);
  return input.queueStashedDraft === undefined
    ? { visibleText: normalDraft, normalDraft }
    : { visibleText: input.visibleText, normalDraft, queueStashedDraft: normalDraft };
}
