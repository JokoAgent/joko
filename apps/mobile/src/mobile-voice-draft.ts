import {
  expandedMobileComposerSelection,
  normalizeMobileComposerDraft,
  replaceMobileComposerRange,
  type MobileComposerAtom,
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
  readonly rollbackAtoms: readonly (MobileComposerAtom & {
    readonly relativeStart: number;
    readonly relativeEnd: number;
  })[];
  readonly transcriptPrefix: string;
  readonly transcriptSuffix: string;
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
    const replacement = `${context.transcriptPrefix}${text}${context.transcriptSuffix}`;
    const result = replaceMobileComposerRange(
      current,
      { start: context.insertion.start, end: context.insertion.end },
      replacement
    );
    return {
      context: {
        ...context,
        insertion: {
          start: context.insertion.start,
          end: context.insertion.start + replacement.length,
          text: replacement
        },
        persisted: context.persisted || persist
      },
      draft: result.draft,
      selection: result.selection
    };
  }

  const range = expandedMobileComposerSelection(current, selection);
  const quoteBefore = current.atoms.find((atom) => atom.kind === "quote" && atom.end === range.start);
  const quoteAfter = current.atoms.find((atom) => atom.kind === "quote" && atom.start === range.end);
  const transcriptPrefix = range.start === range.end && quoteBefore?.end === current.text.length ? "\n\n" : "";
  const transcriptSuffix = range.start === range.end && quoteAfter?.start === 0 ? "\n\n" : "";
  const replacement = `${transcriptPrefix}${text}${transcriptSuffix}`;
  const result = replaceMobileComposerRange(current, range, replacement);
  const start = range.start;
  const end = range.end;
  const rollbackMentions = current.mentions.filter((mention) => mention.start < end && mention.end > start)
    .map((mention) => ({
      ...mention,
      relativeStart: mention.start - start,
      relativeEnd: mention.end - start
    }));
  const rollbackAtoms = current.atoms.filter((atom) => atom.start < end && atom.end > start)
    .map((atom) => ({
      ...atom,
      relativeStart: atom.start - start,
      relativeEnd: atom.end - start
    }));
  return {
    context: {
      insertion: { start, end: start + replacement.length, text: replacement },
      draftOwnerKey,
      rollbackText: current.text.slice(start, end),
      rollbackMentions,
      rollbackAtoms,
      transcriptPrefix,
      transcriptSuffix,
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
  const restoredAtoms = context.rollbackAtoms.map((atom) => {
    const { relativeStart, relativeEnd, ...value } = atom;
    return {
      ...value,
      start: context.insertion.start + relativeStart,
      end: context.insertion.start + relativeEnd
    } as MobileComposerAtom;
  });
  return {
    draft: normalizeMobileComposerDraft({
      ...restored.draft,
      mentions: [...restored.draft.mentions, ...restoredMentions]
        .sort((left, right) => left.start - right.start || left.end - right.end),
      atoms: [...restored.draft.atoms, ...restoredAtoms]
        .sort((left, right) => left.start - right.start || left.end - right.end)
    }),
    selection: restored.selection
  };
}
