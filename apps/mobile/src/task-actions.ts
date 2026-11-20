import { create } from "@bufbuild/protobuf";
import {
  CapabilitySupport,
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  QueueItemState,
  QueueTextEditSpliceSchema,
  capabilityNames,
  richAnswerText,
  type BackendDescriptor,
  type InputContent,
  type QueueItem,
  type QueueTextEditSplice
} from "@joko/contracts";
import type { TimelineRow } from "./timeline";
import { appendMobileSelectionQuote, emptyMobileComposerDraft, insertMobileMessageReference,
  mobileSelectionQuoteMaximumCharacters, mobileVisibleSelectionQuoteText,
  type MobileComposerDraft, type MobileComposerEditResult, type MobileComposerSelection, type MobileComposerWorkspaceMention } from "./mobile-composer-document";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileSideChatCopy } from "./mobile-side-chat";

export type MobileMessageActionId = "add-to-composer" | "reply" | "quote-selection" | "side-chat" | "copy-text" | "copy-link" | "share-image" | "fork" | "rewind" | "delete";

export interface MobileMessageActionItem {
  readonly id: MobileMessageActionId;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
}

export function buildMobileMessageCopyText(row: TimelineRow, locale: MobileSupportedLocale): string {
  const source = row.copySource ?? { body: row.sourceText ?? row.text, attachmentNames: [] };
  const parts = [row.kind === "assistant" ? richAnswerText(source.body) : source.body, source.secondaryBody ?? ""];
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
  readonly includeBody: boolean;
  readonly draft: MobileComposerDraft;
  readonly selection: MobileComposerSelection;
}

export function captureMobileMessageReference(input: { readonly ownerKey: string; readonly draftOwnerKey: string;
  readonly sessionId: string; readonly row: TimelineRow; readonly draft: MobileComposerDraft;
  readonly selection: MobileComposerSelection; readonly locale: MobileSupportedLocale; readonly includeBody?: boolean }): MobileMessageReferenceLease | undefined {
  const row = input.row;
  if (!input.ownerKey || !input.draftOwnerKey || !input.sessionId || !row.completed || row.optimistic || row.internalInput
    || row.kind === "user" && row.partnerPrivateOrigin || row.kind !== "user" && row.kind !== "assistant") return undefined;
  return { ownerKey: input.ownerKey, draftOwnerKey: input.draftOwnerKey, sessionId: input.sessionId,
    messageId: row.id, eventId: row.eventId, text: buildMobileMessageCopyText(row, input.locale), draft: input.draft,
    includeBody: input.includeBody !== false && Boolean((row.copySource?.body ?? row.sourceText ?? row.text).trim()),
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
    { sessionId: lease.sessionId, messageId: lease.messageId, eventId: lease.eventId, text: lease.text, includeBody: lease.includeBody }, input.atomId);
}

function sideChatQuoteText(row: TimelineRow, locale: MobileSupportedLocale): string | undefined {
  if (!row.completed || row.optimistic || row.internalInput || row.partnerPrivateOrigin
    || row.kind !== "user" && row.kind !== "assistant") return undefined;
  const text = buildMobileMessageCopyText(row, locale);
  return text.trim() && text.length <= mobileSelectionQuoteMaximumCharacters ? text : undefined;
}

export function createMobileSideChatMessageDraft(sessionId: string, selected: TimelineRow, latest: TimelineRow,
  locale: MobileSupportedLocale, atomId: string): MobileComposerDraft {
  const text = sideChatQuoteText(latest, locale);
  if (!text || selected.id !== latest.id || selected.eventId !== latest.eventId || selected.kind !== latest.kind
    || (latest.kind !== "user" && latest.kind !== "assistant") || text !== sideChatQuoteText(selected, locale)) {
    throw new Error("The source message changed. Open its current message actions again.");
  }
  return appendMobileSelectionQuote(emptyMobileComposerDraft(), { sourceSessionId: sessionId,
    sourceMessageId: latest.id, sourceEventId: latest.eventId, sourceRole: latest.kind, text }, atomId).draft;
}

export function buildMobileMessageActions(
  row: TimelineRow,
  input: { readonly canDelete: boolean; readonly canFork?: boolean; readonly canRewind?: boolean; readonly canAddToComposer?: boolean; readonly canReplyQuote?: boolean;
    readonly canOpenSideChat?: boolean; readonly locale: MobileSupportedLocale; readonly copyDisabled?: boolean; readonly canCopyLink?: boolean; readonly shareDisabled?: boolean }
): readonly MobileMessageActionItem[] {
  if (!row.completed || row.optimistic || row.internalInput || row.kind === "user" && row.partnerPrivateOrigin
    || (row.kind !== "user" && row.kind !== "assistant")) return [];
  const actions: MobileMessageActionItem[] = [];
  if (buildMobileMessageCopyText(row, input.locale).trim()) actions.push({ id: "copy-text",
    label: mobileMessage(input.locale, input.copyDisabled ? "actions.copyingMessage" : "actions.copyMessage"),
    ...(input.copyDisabled ? { disabled: true } : {}) });
  if (input.canReplyQuote) actions.push({ id: 'reply', label: input.locale === 'zh-CN' ? '引用回复' : 'Reply' });
  else if (input.canAddToComposer !== false) actions.push({ id: "add-to-composer", label: mobileMessage(input.locale, "actions.addToComposer") });
  if (row.quoteSource !== undefined) actions.push({ id: "quote-selection", label: mobileMessage(input.locale, "actions.quoteSelection") });
  if (input.canOpenSideChat && sideChatQuoteText(row, input.locale)) actions.push({ id: "side-chat", label: mobileSideChatCopy(input.locale).create });
  if (input.canCopyLink !== false) actions.push({
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
    || input.messageReferences.length > 0
    || input.parts.some((part) => part.content.case !== "text"));
}

export const maximumMobileQueueTextEditSplices = 4_096;

/** Verify the native selection against both snapshots before retaining any range. */
export function mobileQueueTextSplice(previous: string, next: string, selection: MobileComposerSelection): QueueTextEditSplice | undefined {
  if (previous === next) return undefined;
  const verified = (start: number, end: number): QueueTextEditSplice | undefined => {
    const nextEnd = next.length - (previous.length - end);
    if (start < 0 || end < start || end > previous.length || nextEnd < start
      || !utf16Boundary(previous, start) || !utf16Boundary(previous, end)
      || !utf16Boundary(next, start) || !utf16Boundary(next, nextEnd)
      || previous.slice(0, start) !== next.slice(0, start) || previous.slice(end) !== next.slice(nextEnd)) return undefined;
    return create(QueueTextEditSpliceSchema, { start, end, replacementText: next.slice(start, nextEnd) });
  };
  const exact = verified(selection.start, selection.end);
  if (exact !== undefined) return exact;
  const removed = previous.length - next.length;
  if (removed > 0 && selection.start === selection.end) {
    const backward = verified(selection.start - removed, selection.end);
    const forward = verified(selection.start, selection.end + removed);
    if (backward && !forward) return backward;
    if (forward && !backward) return forward;
  }
  return create(QueueTextEditSpliceSchema, { start: 0, end: previous.length, replacementText: next });
}

export function editQueueItemText(
  input: InputContent | undefined,
  replacementText: string,
  directories: readonly MobileComposerWorkspaceMention[] = [],
  edits: readonly QueueTextEditSplice[] = []
): { readonly input: InputContent; readonly textSplices: readonly QueueTextEditSplice[] } | undefined {
  const originalText = queueItemWireText(input);
  const visibleText = queueItemText(input);
  if (input === undefined || originalText === undefined || visibleText === undefined || !replacementText.trim()) return undefined;
  if (replacementText === visibleText && directories.length === 0 && edits.length === 0) return undefined;
  const full = create(QueueTextEditSpliceSchema, { start: 0, end: originalText.length, replacementText });
  const textSplices = originalText === visibleText && edits.length > 0 && edits.length <= maximumMobileQueueTextEditSplices
    && replayQueueEdits(originalText, edits) === replacementText
    ? edits : [full];
  const mentionRanges = retainedQueueRanges(input.mentionRanges, textSplices);
  const originallyRanged = new Set(input.mentionRanges.map(range => range.mentionIndex));
  const surviving = new Set(mentionRanges.map(range => range.mentionIndex));
  const indexMap = new Map<number, number>();
  const originalMentions = input.parts.filter(part => part.content.case !== "text");
  const mentions = originalMentions.filter((_part, index) => {
    if (originallyRanged.has(index) && !surviving.has(index)) return false;
    indexMap.set(index, indexMap.size);
    return true;
  });
  const ordered = [...directories].sort((left, right) => left.start - right.start);
  const parts = [create(InputPartSchema, { content: { case: "text", value: replacementText } }), ...mentions,
    ...ordered.map(directory => create(InputPartSchema, { content: { case: "workspaceMention", value: {
      workspaceId: directory.workspaceId, relativePath: directory.relativePath, displayText: directory.displayText, directory: true
    } } }))];
  const ranges = [
    ...mentionRanges.map(range => create(InputMentionRangeSchema, { ...range, mentionIndex: indexMap.get(range.mentionIndex)! })),
    ...ordered.map(({ start, end }, index) => create(InputMentionRangeSchema, { start, end, mentionIndex: mentions.length + index }))
  ].sort((left, right) => left.start - right.start);
  return {
    input: create(InputContentSchema, { parts, mentionRanges: ranges,
      pastedTextRanges: retainedQueueRanges(input.pastedTextRanges, textSplices),
      messageReferences: retainedQueueRanges(input.messageReferences, textSplices),
      ...(input.replyQuote ? { replyQuote: input.replyQuote } : {}), ...(input.todoQuote ? { todoQuote: input.todoQuote } : {}) }),
    textSplices
  };
}

function replayQueueEdits(original: string, edits: readonly QueueTextEditSplice[]): string | undefined {
  let current = original, replayBytes = 0, replacementBytes = 0;
  const encoder = new TextEncoder();
  for (const { start, end, replacementText } of edits) {
    if (start < 0 || end < start || end > current.length || !utf16Boundary(current, start) || !utf16Boundary(current, end)
      || start === end && replacementText.length === 0) return undefined;
    replacementBytes += encoder.encode(replacementText).length;
    replayBytes += encoder.encode(current).length;
    if (replacementBytes > 4 * 1024 * 1024 || replayBytes + replacementBytes > 64 * 1024 * 1024) return undefined;
    current = current.slice(0, start) + replacementText + current.slice(end);
  }
  return current;
}

export function retainedQueueRanges<T extends { readonly start: number; readonly end: number }>(ranges: readonly T[], edits: readonly QueueTextEditSplice[]): T[] {
  return edits.reduce<T[]>((current, { start, end, replacementText }) => {
    const delta = replacementText.length - (end - start);
    return current.flatMap(range => {
      if (range.end <= start) return [range];
      return range.start >= end ? [{ ...range, start: range.start + delta, end: range.end + delta }] : [];
    });
  }, [...ranges]);
}

function utf16Boundary(text: string, offset: number): boolean {
  return Number.isSafeInteger(offset) && !(text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
    && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF);
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
