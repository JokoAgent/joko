import type { NetworkTrackedMention, PartnerNetworkAttachment } from "@joko/contracts";

export interface NetworkComposerDraft {
  readonly text: string; readonly mentions: readonly string[]; readonly mentionAll: boolean; readonly forcePlan: boolean;
  readonly quoteId: string; readonly attachments: readonly PartnerNetworkAttachment[]; readonly tracked: readonly NetworkTrackedMention[];
}
const drafts = new Map<string, NetworkComposerDraft>();
const key = (ownerRoom: string, thread: string) => JSON.stringify([ownerRoom, thread]);
export function readNetworkDraft(ownerRoom: string, thread: string): NetworkComposerDraft {
  return drafts.get(key(ownerRoom, thread)) ?? { text: "", mentions: [], mentionAll: false, forcePlan: false, quoteId: "", attachments: [], tracked: [] };
}
/** This run's drafts contain uploaded references only. Image bytes remain in the composer. */
export function writeNetworkDraft(ownerRoom: string, thread: string, draft: NetworkComposerDraft): void {
  const id = key(ownerRoom, thread); drafts.delete(id);
  if (draft.text || draft.quoteId || draft.attachments.length || draft.forcePlan || draft.mentions.length || draft.mentionAll) drafts.set(id, { ...draft, attachments: [...draft.attachments], mentions: [...draft.mentions], tracked: [...draft.tracked] });
  while (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
}
