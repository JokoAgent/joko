import { create } from "@bufbuild/protobuf";
import {
  CapabilitySupport,
  InputContentSchema,
  InputPartSchema,
  QueueItemState,
  QueueTextEditSpliceSchema,
  capabilityNames,
  type BackendDescriptor,
  type InputContent,
  type QueueItem,
  type QueueTextEditSplice
} from "@joko/contracts";
import type { TimelineRow } from "./timeline";
import { insertMobileMessageReference, mobileVisibleSelectionQuoteText,
  type MobileComposerDraft, type MobileComposerEditResult, type MobileComposerSelection } from "./mobile-composer-document";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export type MobileMessageActionId = "add-to-composer" | "quote-selection" | "copy-text" | "copy-link" | "share-image" | "fork" | "rewind" | "delete";

export interface MobileMessageActionItem {
  readonly id: MobileMessageActionId;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
}

export function buildMobileMessageCopyText(row: TimelineRow, locale: MobileSupportedLocale): string {
  const source = row.copySource ?? { body: row.sourceText ?? row.text, attachmentNames: [] };
  const parts = [source.body, source.secondaryBody ?? ""];
  const names = source.attachmentNames.filter(Boolean);
  if (names.length) parts.push(mobileMessage(locale, "actions.messageAttachments", { names: names.join(", ") }));
  return parts.filter(part => part.trim().length > 0).join("\n\n");
}

export interface MobileMessageReferenceLease {
  readonly ownerKey: string;
  readonly draftOwnerKey: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly eventId: string;
  readonly text: string;
  readonly draft: MobileComposerDraft;
  readonly selection: MobileComposerSelection;
}

export function captureMobileMessageReference(input: { readonly ownerKey: string; readonly draftOwnerKey: string;
  readonly sessionId: string; readonly row: TimelineRow; readonly draft: MobileComposerDraft;
  readonly selection: MobileComposerSelection; readonly locale: MobileSupportedLocale }): MobileMessageReferenceLease | undefined {
  const row = input.row;
  if (!input.ownerKey || !input.draftOwnerKey || !input.sessionId || !row.completed || row.optimistic || row.internalInput
    || row.kind === "user" && row.partnerPrivateOrigin || row.kind !== "user" && row.kind !== "assistant") return undefined;
  return { ownerKey: input.ownerKey, draftOwnerKey: input.draftOwnerKey, sessionId: input.sessionId,
    messageId: row.id, eventId: row.eventId, text: buildMobileMessageCopyText(row, input.locale), draft: input.draft,
    selection: { ...input.selection } };
}

export function commitMobileMessageReference(input: { readonly lease: MobileMessageReferenceLease;
  readonly ownerKey: string | undefined; readonly draftOwnerKey: string | undefined; readonly sessionId: string | undefined;
  readonly row: TimelineRow; readonly draft: MobileComposerDraft; readonly locale: MobileSupportedLocale;
  readonly atomId: string }): MobileComposerEditResult {
  const { lease, row } = input;
  if (lease.ownerKey !== input.ownerKey || lease.draftOwnerKey !== input.draftOwnerKey || lease.sessionId !== input.sessionId
    || lease.draft !== input.draft || !row.completed || row.optimistic || row.internalInput || row.partnerPrivateOrigin
    || row.id !== lease.messageId || row.eventId !== lease.eventId || row.kind !== "user" && row.kind !== "assistant"
    || buildMobileMessageCopyText(row, input.locale) !== lease.text) {
    throw new Error("The source message or composer changed. Open the message actions again.");
  }
  return insertMobileMessageReference(input.draft, lease.selection,
    { sessionId: lease.sessionId, messageId: lease.messageId, eventId: lease.eventId, text: lease.text }, input.atomId);
}

export function buildMobileMessageActions(
  row: TimelineRow,
  input: { readonly canDelete: boolean; readonly canFork?: boolean; readonly canRewind?: boolean; readonly canAddToComposer?: boolean;
    readonly locale: MobileSupportedLocale; readonly copyDisabled?: boolean; readonly shareDisabled?: boolean }
): readonly MobileMessageActionItem[] {
  if (!row.completed || row.optimistic || row.internalInput || row.kind === "user" && row.partnerPrivateOrigin
    || (row.kind !== "user" && row.kind !== "assistant")) return [];
  const actions: MobileMessageActionItem[] = [];
  if (buildMobileMessageCopyText(row, input.locale).trim()) actions.push({ id: "copy-text",
    label: mobileMessage(input.locale, input.copyDisabled ? "actions.copyingMessage" : "actions.copyMessage"),
    ...(input.copyDisabled ? { disabled: true } : {}) });
  if (input.canAddToComposer !== false) actions.push({ id: "add-to-composer", label: mobileMessage(input.locale, "actions.addToComposer") });
  if (row.quoteSource !== undefined) actions.push({ id: "quote-selection", label: mobileMessage(input.locale, "actions.quoteSelection") });
  actions.push({
    id: "copy-link",
    label: mobileMessage(input.locale, input.copyDisabled ? "actions.copyingLink" : "actions.copyMessageLink"),
    ...(input.copyDisabled ? { disabled: true } : {})
  });
  actions.push({ id: "share-image", label: mobileMessage(input.locale, "share.shareImage"), ...(input.shareDisabled ? { disabled: true } : {}) });
  if (input.canFork) actions.push({ id: "fork", label: mobileMessage(input.locale, "fork.title") });
  if (input.canRewind && row.kind === "user") actions.push({ id: "rewind", label: mobileMessage(input.locale, "rewind.title") });
  if (input.canDelete) actions.push({
    id: "delete",
    label: mobileMessage(input.locale, "actions.deleteMessage"),
    destructive: true,
    separatorBefore: actions.length > 0
  });
  return actions;
}

export class DeferredSheetAction<T> {
  #generation = 0;
  #pending?: { readonly generation: number; readonly value: T };

  open(): void {
    this.#generation += 1;
    this.#pending = undefined;
  }

  select(value: T): number {
    this.#pending = { generation: this.#generation, value };
    return this.#generation;
  }

  cancel(): number {
    this.#pending = undefined;
    return this.#generation;
  }

  closed(generation: number): T | undefined {
    if (generation !== this.#generation || this.#pending?.generation !== generation) return undefined;
    const value = this.#pending.value;
    this.#pending = undefined;
    return value;
  }
}

export function backendSupports(backend: BackendDescriptor | undefined, capability: string): boolean {
  return backend?.capabilities?.capabilities.some(
    (item) => item.name === capability && item.support === CapabilitySupport.SUPPORTED
  ) === true;
}

export interface MobileQueueCapabilities {
  readonly cancel: boolean;
  readonly edit: boolean;
  readonly reorder: boolean;
}

export function mobileQueueCapabilities(backend: BackendDescriptor | undefined): MobileQueueCapabilities {
  return {
    cancel: backendSupports(backend, capabilityNames.queueCancel),
    edit: backendSupports(backend, capabilityNames.queueEdit),
    reorder: backendSupports(backend, capabilityNames.queueReorder)
  };
}

export function currentSessionQueueItems(
  items: readonly QueueItem[],
  sessionId: string | undefined
): readonly QueueItem[] {
  if (!sessionId) return [];
  return items.filter((item) => item.sessionId === sessionId).sort(compareQueueItems);
}

export function acceptedQueueItems(
  items: readonly QueueItem[],
  sessionId: string | undefined
): readonly QueueItem[] {
  return currentSessionQueueItems(items, sessionId).filter((item) => item.state === QueueItemState.ACCEPTED);
}

export function queueItemText(input: InputContent | undefined): string | undefined {
  const text = queueItemWireText(input);
  if (text === undefined || input === undefined || !input.quotesEncoded) return text;
  return mobileVisibleSelectionQuoteText(text, input.pastedTextRanges);
}

function queueItemWireText(input: InputContent | undefined): string | undefined {
  if (!input) return undefined;
  if (input.parts.some((part) => part.content.case === "image" || part.content.case === "file")) return undefined;
  const text = input.parts.filter((part) => part.content.case === "text");
  if (text.length !== 1) return undefined;
  return text[0]!.content.case === "text" ? text[0]!.content.value : undefined;
}

export function queueItemHasStructuredInput(input: InputContent | undefined): boolean {
  return input !== undefined && (input.quotesEncoded
    || input.pastedTextRanges.length > 0
    || input.mentionRanges.length > 0
    || input.parts.some((part) => part.content.case !== "text"));
}

export function editQueueItemText(
  input: InputContent | undefined,
  replacementText: string
): { readonly input: InputContent; readonly textSplices: readonly QueueTextEditSplice[] } | undefined {
  const originalText = queueItemWireText(input);
  const visibleText = queueItemText(input);
  if (input === undefined || originalText === undefined || visibleText === undefined || !replacementText.trim()) return undefined;
  if (replacementText === visibleText) return undefined;
  const parts = [create(InputPartSchema, { content: { case: "text", value: replacementText } })];
  return {
    input: create(InputContentSchema, { parts }),
    textSplices: [create(QueueTextEditSpliceSchema, {
      start: 0,
      end: originalText.length,
      replacementText
    })]
  };
}

export type MobileQueueMove =
  | { readonly placement: "before"; readonly anchorQueueItemId: string }
  | { readonly placement: "after"; readonly anchorQueueItemId: string };

export function queueMove(
  items: readonly QueueItem[],
  queueItemId: string,
  direction: "up" | "down"
): MobileQueueMove | undefined {
  const index = items.findIndex((item) => item.queueItemId === queueItemId);
  if (index < 0) return undefined;
  if (direction === "up") {
    const anchor = items[index - 1];
    return anchor ? { placement: "before", anchorQueueItemId: anchor.queueItemId } : undefined;
  }
  const anchor = items[index + 1];
  return anchor ? { placement: "after", anchorQueueItemId: anchor.queueItemId } : undefined;
}

function compareQueueItems(left: QueueItem, right: QueueItem): number {
  if (left.ordinal < right.ordinal) return -1;
  if (left.ordinal > right.ordinal) return 1;
  return left.queueItemId.localeCompare(right.queueItemId, "en");
}
