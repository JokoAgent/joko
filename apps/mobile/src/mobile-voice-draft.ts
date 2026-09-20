import {
  normalizeMobileComposerDraft,
  replaceMobileComposerRange,
  type MobileComposerDraft,
  type MobileComposerMention,
  type MobileComposerSelection
} from "./mobile-composer-document";
import { isMobileVoiceInsertionIntact, type MobileVoiceDraftInsertion } from "./mobile-voice-input";

export interface MobileVoiceDraftInsertionContext {
  readonly insertion: MobileVoiceDraftInsertion;
  readonly draftOwnerKey: string;
  readonly rollbackText: string;
  readonly rollbackMentions: readonly (MobileComposerMention & {
    readonly relativeStart: number;
    readonly relativeEnd: number;
  })[];
  readonly persisted: boolean;
}

export interface MobileVoiceDraftMutation {
  readonly context?: MobileVoiceDraftInsertionContext;
  readonly draft?: MobileComposerDraft;
  readonly selection?: MobileComposerSelection;
}

export function applyMobileVoiceTranscript(
  current: MobileComposerDraft,
  selection: MobileComposerSelection,
  context: MobileVoiceDraftInsertionContext | undefined,
  transcript: string,
  persist: boolean,
  draftOwnerKey: string
): MobileVoiceDraftMutation {
  const text = transcript.trim();
  if (!text) return context === undefined ? {} : { context };
  if (context !== undefined) {
    if (context.draftOwnerKey !== draftOwnerKey || !isMobileVoiceInsertionIntact(current.text, context.insertion)) return {};
    const result = replaceMobileComposerRange(
      current,
      { start: context.insertion.start, end: context.insertion.end },
      text
    );
    return {
      context: {
        ...context,
        insertion: { start: context.insertion.start, end: context.insertion.start + text.length, text },
        persisted: context.persisted || persist
      },
      draft: result.draft,
      selection: result.selection
    };
  }

  const result = replaceMobileComposerRange(current, selection, text);
  const start = result.selection.start - text.length;
  const removedLength = text.length - (result.draft.text.length - current.text.length);
  const end = start + removedLength;
  const rollbackMentions = current.mentions.filter((mention) => mention.start < end && mention.end > start)
    .map((mention) => ({
      ...mention,
      relativeStart: mention.start - start,
      relativeEnd: mention.end - start
    }));
  return {
    context: {
      insertion: { start, end: start + text.length, text },
      draftOwnerKey,
      rollbackText: current.text.slice(start, end),
      rollbackMentions,
      persisted: persist
    },
    draft: result.draft,
    selection: result.selection
  };
}

export function rollbackMobileVoiceTranscript(
  current: MobileComposerDraft,
  context: MobileVoiceDraftInsertionContext
): { readonly draft: MobileComposerDraft; readonly selection: MobileComposerSelection } | undefined {
  if (!isMobileVoiceInsertionIntact(current.text, context.insertion)) return undefined;
  const restored = replaceMobileComposerRange(
    current,
    { start: context.insertion.start, end: context.insertion.end },
    context.rollbackText
  );
  const restoredMentions = context.rollbackMentions.map((mention) => {
    const { relativeStart, relativeEnd, ...value } = mention;
    return {
      ...value,
      start: context.insertion.start + relativeStart,
      end: context.insertion.start + relativeEnd
    } as MobileComposerMention;
  });
  return {
    draft: normalizeMobileComposerDraft({
      ...restored.draft,
      mentions: [...restored.draft.mentions, ...restoredMentions]
        .sort((left, right) => left.start - right.start || left.end - right.end)
    }),
    selection: restored.selection
  };
}
