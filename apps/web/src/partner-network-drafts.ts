import type { NetworkTrackedMention, PartnerNetworkAttachment, SendPartnerNetworkRequest } from "@joko/contracts";
import type { AttachmentDraft } from "./model.js";

export interface NetworkComposerDraft {
  readonly text: string; readonly mentions: readonly string[]; readonly mentionAll: boolean; readonly forcePlan: boolean;
  readonly quoteId: string; readonly attachments: readonly PartnerNetworkAttachment[]; readonly tracked: readonly NetworkTrackedMention[];
  readonly localAttachments?: readonly AttachmentDraft[];
  readonly editing?: { readonly request: SendPartnerNetworkRequest; readonly useOriginalAudience: boolean };
}
const drafts = new Map<string, NetworkComposerDraft>();
const key = (ownerRoom: string, thread: string) => JSON.stringify([ownerRoom, thread]);
export function readNetworkDraft(ownerRoom: string, thread: string): NetworkComposerDraft {
  return drafts.get(key(ownerRoom, thread)) ?? { text: "", mentions: [], mentionAll: false, forcePlan: false, quoteId: "", attachments: [], tracked: [] };
}
/** This run retains each draft's original files and editable vectors beside its uploaded references. */
export function writeNetworkDraft(ownerRoom: string, thread: string, draft: NetworkComposerDraft): void {
  const id = key(ownerRoom, thread); drafts.delete(id);
  if (draft.text || draft.quoteId || draft.attachments.length || draft.forcePlan || draft.mentions.length || draft.mentionAll) drafts.set(id, { ...draft, attachments: [...draft.attachments], mentions: [...draft.mentions], tracked: [...draft.tracked], localAttachments: [...draft.localAttachments ?? []] });
  while (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
}
